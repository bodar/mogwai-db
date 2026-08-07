import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { BulkLoader, loadBulk, type BulkEdge, type BulkVertex } from '../src/bulk.ts';
import { exec, executeQuery } from './support/executor.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { Duration } from '../src/gremlin/types.ts';

// The bulk loader's gate: **a graph landed in batches is byte-for-byte the graph the write
// traversals produce.** (docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md phase 1.)
//
// Why this test and not a behavioural one. Today's seed is self-validating: it goes through the same
// parse → compile → execute path a client uses, so a broken write path cannot produce a correct
// fixture. A bulk loader bypasses all of that, and a divergence would be silent — a missing FTS row
// is invisible until a substring search quietly returns less, and a differently-encoded value is
// invisible until an order predicate sorts wrong. So the reference stays MODERN_SEED-through-the-
// query-path and this compares the two stores table by table, which is what makes the loader's
// "reuse, never reimplement" invariant enforced rather than aspirational.
//
// The measured trap it guards: a probe's simplified FTS re-derivation produced 9,023 rows for
// grateful-dead where the real walk produces 8,936 — it skipped empty-text rows and the nested
// collection walk. Both paths now call `propertyFtsRows`, and this is what says so.

/** Every table's contents, in a comparable form. Regular tables are ordered by their integer id, so
 *  the comparison covers the MINTED IDS too — the loader must assign what the write path assigns.
 *  `property_fts` is ordered by its content instead: its rowid is not referenced by anything (the
 *  logical key is (owner_elem, pid, kind, text)), so insertion order is not part of the contract and
 *  sorting is the honest form of "identical contents". */
const DUMP: Array<[string, string]> = [
  ['labels', 'SELECT id, name FROM labels ORDER BY id'],
  ['nodes', 'SELECT id, uid FROM nodes ORDER BY id'],
  ['vertex_labels', 'SELECT node, label FROM vertex_labels ORDER BY node, label'],
  ['vertex_properties',
    `SELECT id, node, key, value, typeof(value) AS storage, vtype,
            CASE WHEN meta IS NULL THEN NULL ELSE json(meta) END AS meta
     FROM vertex_properties ORDER BY id`],
  ['edges', 'SELECT id, uid, src, label, tgt FROM edges ORDER BY id'],
  ['edge_properties', 'SELECT id, edge, key, value, typeof(value) AS storage, vtype FROM edge_properties ORDER BY id'],
  ['property_fts',
    `SELECT owner_elem, pid, owner, pk, kind, text FROM property_fts
     ORDER BY owner_elem, owner, pid, kind, text`],
];

/** A collection value is a JSONB blob; compare its json() TEXT so a mismatch reads as a diff rather
 *  than as two opaque Buffers. */
const dump = (store: GraphStore) =>
  Object.fromEntries(DUMP.map(([name, sql]) => [name, store.query(sql).map((r: any) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `blob:${Buffer.from(v).toString('hex')}` : v])))]));

const fresh = () => new GraphStore(new BunSqlite(':memory:'));
/** Under the CF-parity store, so a batch that breached the DO bind cap fails here (src/cf-limits.ts). */
const freshLimited = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));

const seededByTraversals = (seed: readonly string[]) => {
  const store = fresh();
  for (const q of seed) executeQuery(store, q, {});
  return store;
};

// The modern graph as bulk input — the same elements MODERN_SEED writes, in the same order, with the
// same explicit ids. `vtype` is stated rather than inferred wherever the reference graph's type is
// not what JS infers: `weight` 1.0 is a double in TinkerPop and an int to `gremlinTypeOf`.
const MODERN_VERTICES: BulkVertex[] = [
  { id: 1, labels: ['person'], properties: [{ key: 'name', value: 'marko' }, { key: 'age', value: 29 }] },
  { id: 2, labels: ['person'], properties: [{ key: 'name', value: 'vadas' }, { key: 'age', value: 27 }] },
  { id: 3, labels: ['software'], properties: [{ key: 'name', value: 'lop' }, { key: 'lang', value: 'java' }] },
  { id: 4, labels: ['person'], properties: [{ key: 'name', value: 'josh' }, { key: 'age', value: 32 }] },
  { id: 5, labels: ['software'], properties: [{ key: 'name', value: 'ripple' }, { key: 'lang', value: 'java' }] },
  { id: 6, labels: ['person'], properties: [{ key: 'name', value: 'peter' }, { key: 'age', value: 35 }] },
];
const w = (v: number) => [{ key: 'weight', value: v, vtype: 'double' as const }];
const MODERN_EDGES: BulkEdge[] = [
  { id: 7, label: 'knows', src: 1, tgt: 2, properties: w(0.5) },
  { id: 8, label: 'knows', src: 1, tgt: 4, properties: w(1.0) },
  { id: 9, label: 'created', src: 1, tgt: 3, properties: w(0.4) },
  { id: 10, label: 'created', src: 4, tgt: 5, properties: w(1.0) },
  { id: 11, label: 'created', src: 4, tgt: 3, properties: w(0.4) },
  { id: 12, label: 'created', src: 6, tgt: 3, properties: w(0.2) },
];

describe('the bulk loader lands what the write path lands', () => {
  test('modern graph: every table byte-identical, including property_fts', () => {
    const viaTraversals = seededByTraversals(MODERN_SEED);
    const viaBulk = freshLimited();
    const stats = loadBulk(viaBulk, MODERN_VERTICES, MODERN_EDGES);

    expect(dump(viaBulk)).toEqual(dump(viaTraversals));
    expect(stats.vertices).toBe(6);
    expect(stats.edges).toBe(6);
    expect(stats.properties).toBe(18);
    // 12 addV/addE traversals issue 137 statements; the loader lands the same graph in 15.
    expect(stats.statements).toBeLessThan(20);
  });

  test('the loaded graph answers traversals identically', () => {
    const viaBulk = fresh();
    loadBulk(viaBulk, MODERN_VERTICES, MODERN_EDGES);
    const viaTraversals = seededByTraversals(MODERN_SEED);
    // THE SPINE IS PINNED, because the subject here is the LOADER and not the compiler: the assertion
    // is store-vs-store, so both sides must answer through the same route and every query must be
    // answerable. `tinker.search` is a `rel`-only service now, so the ambient switch's OFF position
    // would refuse it — and refusing says nothing about whether the loader landed the same graph.
    // The legacy position's answers for these shapes are the census's and L1's business.
    const answer = (store: GraphStore, q: string) => exec(store, undefined, undefined, 'rel').framed(q, {});
    for (const q of [
      'g.V().count()',
      "g.V().has('name','marko').out('knows').values('name').fold()",
      "g.V().hasLabel('software').in('created').values('name').order().fold()",
      "g.E().has('weight',P.gt(0.4)).count()",
      "g.V().has('name',TextP.containing('ark')).values('name').fold()",
      "g.call('tinker.search', [search: 'ripp']).count()",
    ])
      expect([q, answer(viaBulk, q)]).toEqual([q, answer(viaTraversals, q)]);
  });

  test('typed values, collections, meta-properties and multi-properties survive a batch', () => {
    // One vertex per storage shape the type channel has to carry — the cases a CSV export cannot
    // express and a homegrown dump would have had to (plan doc §4b).
    const rich: BulkVertex[] = [
      { id: 1, labels: ['person'], properties: [
        { key: 'name', value: 'marko', id: 1 },
        { key: 'location', value: 'san diego', id: 2, meta: { startTime: 1997, endTime: 2001 } },
        { key: 'location', value: 'santa cruz', id: 3, meta: { startTime: 2001, endTime: 2004 } },
        { key: 'big', value: 9007199254740993n, vtype: 'long' },
        { key: 'when', value: new Duration(90n, 500_000_000), vtype: 'duration' },
        { key: 'tags', value: ['a', 'brave'], vtype: 'list' },
        // A STRING key here, matching what the Gremlin map literal below parses to; the typed-key
        // case is asserted directly against the stored tree in the next test, because the grammar has
        // no spelling that reaches it.
        { key: 'scores', value: new Map<unknown, unknown>([['1', 'one'], ['k', 2]]), vtype: 'map' },
      ] },
    ];
    const viaBulk = freshLimited();
    loadBulk(viaBulk, rich);

    // Compare against the per-element path for the SAME elements, which is the only authority on how
    // each of these encodes.
    const viaWrites = fresh();
    executeQuery(viaWrites, "g.addV('person').property(T.id,1).property('name','marko')", {});
    executeQuery(viaWrites, "g.V(1).property(Cardinality.list,'location','san diego','startTime',1997,'endTime',2001)", {});
    executeQuery(viaWrites, "g.V(1).property(Cardinality.list,'location','santa cruz','startTime',2001,'endTime',2004)", {});
    executeQuery(viaWrites, 'g.V(1).property(Cardinality.list,"big", 9007199254740993)', {});
    executeQuery(viaWrites, 'g.V(1).property(Cardinality.list,"when", Duration(90, 500000000))', {});
    executeQuery(viaWrites, 'g.V(1).property(Cardinality.list,"tags", ["a","brave"])', {});
    executeQuery(viaWrites, 'g.V(1).property(Cardinality.list,"scores", [1:"one","k":2])', {});

    const [bulk, writes] = [dump(viaBulk), dump(viaWrites)];
    expect(bulk.vertex_properties).toEqual(writes.vertex_properties);
    expect(bulk.property_fts).toEqual(writes.property_fts);
  });

  test('a TYPED map key lands as a typed tree — the fidelity no Gremlin literal can spell', () => {
    // g:Map is a flat alternating [k,v,…] array precisely so keys can be typed (plan doc §4b), and
    // our stored ValueNode tree mirrors that. The grammar's map literal stringifies its keys, so this
    // fidelity is only reachable through a reader — i.e. through this loader — and is asserted against
    // the stored tree rather than against a traversal.
    const store = freshLimited();
    loadBulk(store, [{ id: 1, labels: ['person'], properties: [
      { key: 'scores', value: new Map<unknown, unknown>([[1, 'one'], [2n, 'two']]), vtype: 'map',
        typeNode: { t: 'map', entries: { 1: { key: 'int', value: 'string' }, 2: { key: 'long', value: 'string' } } } },
    ] }]);
    const stored = store.query<{ v: string }>("SELECT json(value) AS v FROM vertex_properties WHERE key='scores'")[0];
    expect(JSON.parse(stored.v)).toEqual([
      [{ t: 'int', v: 1 }, { t: 'string', v: 'one' }],
      [{ t: 'long', v: 2 }, { t: 'string', v: 'two' }],
    ]);
    // And the FTS walk indexed both keys, so a search over a typed key still matches.
    expect(store.query<{ text: string }>("SELECT text FROM property_fts WHERE kind='jsonkey' ORDER BY text").map((r) => r.text))
      .toEqual(['1', '2']);
  });
});

describe('the loader mints ids and resolves endpoints', () => {
  test('appending to a non-empty graph continues every id sequence', () => {
    const store = fresh();
    loadBulk(store, MODERN_VERTICES, MODERN_EDGES);
    loadBulk(store,
      [{ labels: ['person'], properties: [{ key: 'name', value: 'seven' }] }],
      [{ label: 'knows', src: 7, tgt: 1 }]);
    expect(store.query<{ id: number }>('SELECT id FROM nodes ORDER BY id').map((r) => r.id))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(store.query<{ id: number; src: number; tgt: number }>('SELECT id, src, tgt FROM edges WHERE id > 12')[0])
      .toEqual({ id: 13, src: 7, tgt: 1 });
    // The new property row continues vertex_properties.id rather than colliding with it.
    expect(store.query<{ id: number; key: string }>('SELECT id, key FROM vertex_properties ORDER BY id DESC LIMIT 1')[0])
      .toEqual({ id: 13, key: 'name' });
  });

  test('a string id lands as uid with a minted rowid, and an edge resolves against it', () => {
    const store = fresh();
    loadBulk(store,
      [{ id: 'v:a', labels: ['person'] }, { id: 'v:b', labels: ['person'] }],
      [{ id: 'e:ab', label: 'knows', src: 'v:a', tgt: 'v:b' }]);
    expect(store.query('SELECT id, uid FROM nodes ORDER BY id')).toEqual([{ id: 1, uid: 'v:a' }, { id: 2, uid: 'v:b' }]);
    expect(store.query('SELECT id, uid, src, tgt FROM edges')).toEqual([{ id: 1, uid: 'e:ab', src: 1, tgt: 2 }]);
    // COALESCE(uid, id) is the faced id, so the traversal sees the source's own ids.
    expect(executeQuery(store, "g.V('v:a').out('knows').id().fold()", {}).length).toBe(1);
  });

  test('an edge added BEFORE its endpoints still resolves (adjacency files are not ordered)', () => {
    const store = fresh();
    const loader = new BulkLoader(store);
    loader.edge({ label: 'knows', src: 'v:a', tgt: 'v:b' });
    loader.vertex({ id: 'v:a', labels: ['person'] });
    loader.vertex({ id: 'v:b', labels: ['person'] });
    loader.flush();
    expect(store.query('SELECT src, tgt FROM edges')).toEqual([{ src: 1, tgt: 2 }]);
  });

  test('an unknown endpoint fails closed, naming the vertex', () => {
    const store = fresh();
    const loader = new BulkLoader(store);
    loader.edge({ id: 'e:1', label: 'knows', src: 'v:a', tgt: 'v:missing' });
    loader.vertex({ id: 'v:a', labels: ['person'] });
    expect(() => loader.flush()).toThrow(/edge e:1 references unknown vertex v:missing/);
  });

  test('flush is idempotent, so a streaming reader can flush per chunk', () => {
    const store = fresh();
    const loader = new BulkLoader(store);
    loader.vertex({ id: 1, labels: ['person'], properties: [{ key: 'name', value: 'a' }] });
    loader.flush();
    loader.flush(); // nothing buffered: no rows, no duplicate
    loader.vertex({ id: 2, labels: ['person'], properties: [{ key: 'name', value: 'b' }] });
    loader.edge({ id: 7, label: 'knows', src: 1, tgt: 2 });
    loader.flush();
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(2);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM vertex_properties')[0].n).toBe(2);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0].n).toBe(1);
  });
});

describe('the loader is DO-legal and batched at scale', () => {
  test('2,000 vertices and 2,000 edges land under the 100-bind cap', () => {
    const store = freshLimited();
    const vertices: BulkVertex[] = Array.from({ length: 2000 }, (_, i) => ({
      id: i + 1, labels: ['person'], properties: [{ key: 'name', value: `p${i}` }, { key: 'n', value: i }],
    }));
    const edges: BulkEdge[] = Array.from({ length: 2000 }, (_, i) => ({
      label: 'knows', src: (i % 2000) + 1, tgt: ((i + 1) % 2000) + 1,
    }));
    const stats = loadBulk(store, vertices, edges);
    expect(stats.properties).toBe(4000);
    // 14,000 rows land (2,000 nodes + 2,000 vertex_labels + 4,000 vertex_properties + 2,000 edges +
    // 4,000 property_fts). Per-element writes cost ~11 statements PER ELEMENT (plan doc §1a); the
    // batched form is ceil(rows / floor(100 / columns)) per table, so the ratio — not the absolute
    // number — is the property worth asserting.
    expect(stats.statements).toBeLessThan(700);
    expect(14_000 / stats.statements).toBeGreaterThan(15);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0].n).toBe(2000);
    expect(executeQuery(store, 'g.V().count()', {})).toEqual(executeQuery(store, 'g.V().count()', {}));
  });
});

describe("idPolicy: 'remap' — loading into a graph that already has these ids", () => {
  // Plan doc §7: a cross-graph load does NOT need a wider primary key. `labels.id` and
  // `nodes.id`/`edges.id` are local rowids with no cross-graph meaning, so two graphs' ids collide
  // for no reason — one remap pass fixes it with no schema change, and the measurements that refuted
  // widening the key (1.9-7.2x storage, 2.8-5x on the traversal hot path) stay unspent.

  /** Two graphs with the SAME ids — the situation a cross-graph load is always in. */
  const collidingSource: BulkVertex[] = [
    { id: 1, labels: ['person'], properties: [{ key: 'name', value: 'other-marko' }] },
    { id: 2, labels: ['robot'], properties: [{ key: 'name', value: 'bender' }] },
  ];
  const collidingEdges: BulkEdge[] = [{ id: 7, label: 'knows', src: 1, tgt: 2 }];

  test("the default 'preserve' fails closed, naming the option that fixes it", () => {
    const store = fresh();
    loadBulk(store, MODERN_VERTICES, MODERN_EDGES);
    // Not a raw `UNIQUE constraint failed: nodes.id` — that is true but says nothing about what to do.
    expect(() => loadBulk(store, collidingSource, collidingEdges))
      .toThrow(/nodes id 1 already exists in this graph — load with \{ idPolicy: 'remap' \}/);
    // And it failed BEFORE writing anything: the pre-check runs ahead of the first insert.
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(6);
  });

  test("'remap' mints fresh ids, keeps the source ids as uid, and rewires the edges", () => {
    const store = fresh();
    loadBulk(store, MODERN_VERTICES, MODERN_EDGES);
    const stats = loadBulk(store, collidingSource, collidingEdges, { idPolicy: 'remap' });
    expect([stats.vertices, stats.edges]).toEqual([2, 1]);

    expect(store.query('SELECT id, uid FROM nodes WHERE uid IS NOT NULL ORDER BY id'))
      .toEqual([{ id: 7, uid: '1' }, { id: 8, uid: '2' }]);
    // The edge points at the REMAPPED endpoints, not at the source's 1 and 2 (which are marko and
    // vadas here). Endpoint resolution goes through the same source→rowid map either way.
    expect(store.query('SELECT id, uid, src, tgt FROM edges WHERE uid IS NOT NULL'))
      .toEqual([{ id: 13, uid: '7', src: 7, tgt: 8 }]);
    // Nothing of the original graph moved.
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(8);
    expect(executeQuery(store, "g.V().has('name','marko').out('knows').count()", {}))
      .toEqual(executeQuery(seededByTraversals(MODERN_SEED), "g.V().has('name','marko').out('knows').count()", {}));
  });

  test("'remap' re-interns labels rather than trusting the source's label ids", () => {
    const store = fresh();
    loadBulk(store, MODERN_VERTICES, MODERN_EDGES);
    loadBulk(store, collidingSource, collidingEdges, { idPolicy: 'remap' });
    // `person` and `knows` were already interned and are REUSED; `robot` is new. A loader that
    // carried a source label id across would have pointed `robot` at whatever that id means here.
    const labels = store.query<{ id: number; name: string }>('SELECT id, name FROM labels ORDER BY id');
    expect(labels.map((l) => l.name)).toEqual(['person', 'software', 'knows', 'created', 'robot']);
    expect(executeQuery(store, "g.V().hasLabel('robot').values('name').fold()", {}).length).toBe(1);
    // modern's four persons plus the source's one, under ONE interned `person` — which is the point:
    // the label is matched by NAME across the boundary, not by the source's local label id.
    expect(store.query<{ n: number }>(
      `SELECT count(*) AS n FROM vertex_labels vl JOIN labels l ON l.id=vl.label WHERE l.name='person'`)[0].n)
      .toBe(5);
  });

  test("the SAME graph loads twice under 'renumber' — what uid's UNIQUE cannot do", () => {
    // The §7 gate: load-into-non-empty. Twice over, because that is the case 'remap' structurally
    // cannot serve — `nodes.uid` is UNIQUE, so a source id can be preserved in a target only once.
    const store = freshLimited();
    for (const pass of [1, 2]) {
      void pass;
      const l = new BulkLoader(store, { idPolicy: 'renumber' });
      for (const v of MODERN_VERTICES) l.vertex(v);
      for (const e of MODERN_EDGES) l.edge(e);
      l.flush();
    }
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM nodes')[0].n).toBe(12);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0].n).toBe(12);
    // Two disjoint copies: marko's out-degree is unchanged in each, so the two loads did not
    // cross-wire (which is exactly what a shared id space would have done).
    expect(store.query<{ n: number }>(
      `SELECT count(*) AS n FROM edges e JOIN vertex_properties p ON p.node = e.src
       WHERE p.key='name' AND p.value='marko'`)[0].n).toBe(6);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM property_fts')[0].n).toBe(36);
  });

  test("'remap' twice over the same source fails closed, naming 'renumber'", () => {
    const store = fresh();
    loadBulk(store, MODERN_VERTICES, MODERN_EDGES, { idPolicy: 'remap' });
    expect(() => loadBulk(store, MODERN_VERTICES, MODERN_EDGES, { idPolicy: 'remap' }))
      .toThrow(/nodes uid "1" already exists in this graph — load with \{ idPolicy: 'renumber' \}/);
  });

  test('an empty target pays nothing for the collision check', () => {
    // The check is skipped when the graph was empty at construction, which is every seeding load.
    const store = fresh();
    const statements = loadBulk(store, MODERN_VERTICES, MODERN_EDGES).statements;
    const second = fresh();
    loadBulk(second, [{ id: 99, labels: ['x'] }]);
    const withCheck = loadBulk(second, MODERN_VERTICES, MODERN_EDGES).statements;
    expect(statements).toBeLessThan(withCheck);
  });
});
