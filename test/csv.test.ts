import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { loadGraphson } from '../src/formats/graphson.ts';
import { csvLine, csvPaths, csvRecords, loadCsv, writeCsv } from '../src/formats/csv.ts';
import { executeQuery } from './support/executor.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { ZOO_SEED } from './fixtures/seed-zoo.ts';

// Neptune/Neo4j CSV (src/formats/csv.ts) — phase 6 of
// docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md, and INTEROP ONLY.
//
// The gate the plan asks for is "round-trip through CSV for the types CSV *can* carry, with the
// lossy cases documented and asserted as LOSSY rather than silently wrong", so this file is
// deliberately in three parts:
//
//   1. the format itself (RFC 4180 + the two header dialects), where the interop actually lives;
//   2. the LOSSLESS round trip, which is the strong gate — over the types CSV has a column for, the
//      canonical projection must be identical, `vtype` and SQLite storage class included;
//   3. the LOSSY cases, each asserted for the specific thing it loses (a widened scalar comes back as
//      a string) or for the refusal it produces (a collection or a meta-property stops the export).
//      An assertion that a loss is exactly this much is what stops it quietly becoming more.

const GRAPHSON = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';
const fixture = (name: string) => readFileSync(new URL(`../${GRAPHSON}/${name}`, import.meta.url).pathname, 'utf8');

/** Every store here is CF-parity checked, so a bind list that scales with row count fails on Bun. */
const fresh = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
const seeded = (seed: readonly string[]) => {
  const store = fresh();
  for (const q of seed) executeQuery(store, q, {});
  return store;
};

/**
 * The projection a CSV round trip is compared on — everything CSV carries, and nothing it does not.
 *
 * Narrower than the GraphSON one in two places, and both are the format rather than the writer:
 *
 *   `vertex_properties.id` — no CSV dialect has a column for a VertexProperty id (they are cells in a
 *     row, not objects with identity), so a reload mints 1..N. The property's key, value, type and
 *     multiplicity are all compared; only the instance id is not.
 *   `property_fts` — derived from the property rows by the shared `propertyFtsRows` walk, so it is
 *     already pinned by test/bulk.test.ts; including it here would assert VertexProperty ids by proxy.
 */
const CANONICAL: Array<[string, string]> = [
  ['nodes', 'SELECT id, uid FROM nodes ORDER BY id'],
  ['vertex_labels',
    `SELECT vl.node AS node, l.name AS label FROM vertex_labels vl JOIN labels l ON l.id = vl.label
     ORDER BY node, label`],
  ['vertex_properties',
    `SELECT node, key, value, typeof(value) AS storage, vtype FROM vertex_properties
     ORDER BY node, key, value`],
  ['edges',
    `SELECT e.id AS id, e.uid AS uid, e.src AS src, l.name AS label, e.tgt AS tgt
     FROM edges e JOIN labels l ON l.id = e.label ORDER BY e.id`],
  ['edge_properties', 'SELECT edge, key, value, typeof(value) AS storage, vtype FROM edge_properties ORDER BY edge, key'],
];

const canonical = (store: GraphStore) =>
  Object.fromEntries(CANONICAL.map(([name, sql]) => [name, store.query(sql)]));

/** Write `store` out as the two documents and read them back into a fresh graph. The vertex file
 *  first: the edge file's endpoints then resolve against vertices already in the graph, which is what
 *  a two-file format requires of any loader (and is why an edge file needs no shared state). */
function roundTrip(store: GraphStore) {
  const dump = writeCsv(store);
  const reloaded = fresh();
  loadCsv(reloaded, dump.vertices);
  loadCsv(reloaded, dump.edges);
  return { dump, reloaded };
}

// ---------- 1. the format ----------

describe('RFC 4180', () => {
  const records = (text: string) => [...csvRecords(text)];

  test('quoted fields carry delimiters, newlines and doubled quotes', () => {
    // A quoted field containing a newline is why records cannot be found by split('\n').
    expect(records('a,"b,c","d\ne","f""g"')).toEqual([['a', 'b,c', 'd\ne', 'f"g']]);
    expect(records('a\r\nb\r\n')).toEqual([['a'], ['b']]);
  });

  test('a QUOTED empty field is an empty string; a BARE empty field is absent', () => {
    // The distinction every CSV graph format loses (a blank cell means "no value"), kept here so
    // property('x','') survives a round trip. RFC 4180 permits both spellings.
    expect(records('a,"",,b')).toEqual([['a', '', null, 'b']]);
    expect(csvLine(['a', '', null, 'b'])).toBe('a,"",,b');
  });

  test('csvLine quotes exactly what has to be quoted', () => {
    expect(csvLine(['plain', 'has,comma', 'has"quote', 'has\nnewline', ' padded '])).toBe(
      'plain,"has,comma","has""quote","has\nnewline"," padded "');
  });

  test('a trailing newline does not produce an empty record', () => {
    expect(records('~id\n1\n')).toEqual([['~id'], ['1']]);
  });
});

describe('the header vocabulary, both dialects', () => {
  const NEPTUNE_V = '~id,~label,name:String,age:Int\n1,person,marko,29';
  const NEO4J_V = 'personId:ID,:LABEL,name:string,age:int\n1,person,marko,29';

  test('Neptune and Neo4j vertex headers load identically', () => {
    const a = fresh(); loadCsv(a, NEPTUNE_V);
    const b = fresh(); loadCsv(b, NEO4J_V);
    expect(canonical(b)).toEqual(canonical(a));
    expect(a.query('SELECT key, value, vtype FROM vertex_properties ORDER BY key'))
      .toEqual([{ key: 'age', value: 29, vtype: 'int' }, { key: 'name', value: 'marko', vtype: 'string' }]);
  });

  test('Neo4j edge headers (:START_ID/:END_ID/:TYPE) load like Neptune (~from/~to/~label)', () => {
    const load = (vertices: string, edges: string) => {
      const store = fresh();
      loadCsv(store, vertices);
      loadCsv(store, edges);
      return store;
    };
    const a = load(NEPTUNE_V + '\n2,person,vadas,27', '~id,~from,~to,~label,weight:Double\n7,1,2,knows,0.5');
    const b = load(NEO4J_V + '\n2,person,vadas,27', ':START_ID,:END_ID,:TYPE,weight:double\n1,2,knows,0.5');
    // Only the edge id differs (the Neo4j file declares none, so it is minted) — everything else,
    // endpoints and typed property included, is the same edge.
    expect(b.query('SELECT src, tgt, key, value, vtype FROM edges JOIN edge_properties ON edge = edges.id'))
      .toEqual(a.query('SELECT src, tgt, key, value, vtype FROM edges JOIN edge_properties ON edge = edges.id'));
  });

  test('an array column becomes one property INSTANCE per value — a multi-property', () => {
    const store = fresh();
    loadCsv(store, '~id,~label,nick:String[]\n1,person,"m;marko;\\;odd"');
    expect(store.query('SELECT key, value FROM vertex_properties ORDER BY id'))
      .toEqual([{ key: 'nick', value: 'm' }, { key: 'nick', value: 'marko' }, { key: 'nick', value: ';odd' }]);
  });

  test("Neptune's cardinality suffix and Neo4j's id group are read for their TYPE and otherwise ignored", () => {
    // single/list/set cardinality is not something the schema records (a multi-property IS several
    // rows), so honoring the suffix would claim a fidelity we do not have.
    const store = fresh();
    loadCsv(store, '~id,~label,age:Int(single),city:String(set)\n1,person,29,berlin');
    expect(store.query('SELECT key, vtype FROM vertex_properties ORDER BY key'))
      .toEqual([{ key: 'age', vtype: 'int' }, { key: 'city', vtype: 'string' }]);
    loadCsv(fresh(), 'x:ID(People),:LABEL\n1,person');
  });

  test('a bare column with no type is String, which is both loaders default', () => {
    const store = fresh();
    loadCsv(store, '~id,~label,name\n1,person,marko');
    expect(store.query('SELECT vtype FROM vertex_properties')).toEqual([{ vtype: 'string' }]);
  });

  test('a header that cannot be honored fails closed rather than guessing', () => {
    // Neo4j's spatial/partial-time types have no canonical type at all; landing one with an inferred
    // type is the wrong answer this reader exists to avoid.
    expect(() => loadCsv(fresh(), '~id,home:point\n1,x')).toThrow(/unknown column type "point"/);
    expect(() => loadCsv(fresh(), '~id,:string\n1,x')).toThrow(/declares a type with no property name/);
    expect(() => loadCsv(fresh(), '~id,~label,age:Int\n1,person,notanumber')).toThrow(/"notanumber" is not a int/);
    expect(() => loadCsv(fresh(), '~label\nperson')).toThrow(/no id column/);
    expect(() => loadCsv(fresh(), '~id,~from\n1,2')).toThrow(/one endpoint column but not the other/);
    expect(() => loadCsv(fresh(), '')).toThrow(/empty document/);
  });

  test('a malformed record names its record number', () => {
    expect(() => loadCsv(fresh(), '~id,~label,age:Int\n1,person,29\n2,person,oops'))
      .toThrow(/CSV record 3:/);
  });
});

// ---------- 2. the lossless round trip ----------

describe('the round trip is exact for the types CSV has a column for', () => {
  test('modern: every one of its types is native, so the projection is identical', () => {
    // The strong gate. modern is String/Int/Double only, so nothing here is widened and the
    // comparison includes vtype AND typeof(value) — an int re-read as a real fails it.
    const store = seeded(MODERN_SEED);
    const { reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));
    for (const q of [
      'g.V().count()', 'g.E().count()',
      "g.V().has('name','marko').out('knows').values('name').order().fold()",
      "g.V().hasLabel('software').in('created').values('name').order().fold()",
      "g.E().has('weight',P.gt(0.4)).count()",
      "g.V().values('age').order().fold()",
    ])
      expect([q, executeQuery(reloaded, q, {})]).toEqual([q, executeQuery(store, q, {})]);
  });

  test('the two files are Neptune-shaped, and the edge file names its endpoints by ~id', () => {
    const dump = writeCsv(seeded(MODERN_SEED));
    const [vHeader, ...vRows] = dump.vertices.split('\n');
    expect(vHeader).toBe('~id,~label,age:Int,lang:String,name:String');
    expect(vRows.length).toBe(6);
    // marko: labelled, an age, no lang — the absent cell is BARE empty (absent), not `""`.
    expect(vRows[0]).toBe('1,person,29,,marko');
    const [eHeader, ...eRows] = dump.edges.split('\n');
    expect(eHeader).toBe('~id,~from,~to,~label,weight:Double');
    expect(eRows[0]).toBe('7,1,2,knows,0.5');
  });

  test('multi-properties become an array column and come back as several instances', () => {
    const store = seeded(['g.addV("p").property(T.id,1)'
      + '.property(Cardinality.list,"nick","m").property(Cardinality.list,"nick","marko")'
      + '.property("name","marko")']);
    const { dump, reloaded } = roundTrip(store);
    // `[]` is emitted only for the keys that actually repeat, so a single-valued column stays plain —
    // an array column for every property would change single into set cardinality for no reason.
    expect(dump.vertices.split('\n')[0]).toBe('~id,~label,name:String,nick:String[]');
    expect(dump.vertices.split('\n')[1]).toBe('1,p,marko,m;marko');
    expect(canonical(reloaded)).toEqual(canonical(store));
  });

  test('an EMPTY-STRING property survives, which is what the quoted-empty cell is for', () => {
    const store = seeded(['g.addV("p").property(T.id,1).property("name","").property("other","x")']);
    const { dump, reloaded } = roundTrip(store);
    expect(dump.vertices.split('\n')[1]).toBe('1,p,"",x');
    expect(canonical(reloaded)).toEqual(canonical(store));
  });

  test('multi-label vertices survive: ~label is a ;-separated set in both dialects', () => {
    const store = seeded(ZOO_SEED);
    const { dump, reloaded } = roundTrip(store);
    expect(dump.vertices.split('\n')[1]).toContain('animal;bird;aquatic;endangered');
    expect(canonical(reloaded)).toEqual(canonical(store));
    expect(executeQuery(reloaded, "g.V().hasLabel('endangered').count()", {}))
      .toEqual(executeQuery(store, "g.V().hasLabel('endangered').count()", {}));
  });

  test('a user-supplied string id round-trips, on the vertex and on both endpoints', () => {
    const store = fresh();
    loadCsv(store, '~id,~label\nv:a,person\nv:b,person');
    loadCsv(store, '~id,~from,~to,~label\ne:ab,v:a,v:b,knows');
    const { dump, reloaded } = roundTrip(store);
    expect(dump.edges.split('\n')[1]).toBe('e:ab,v:a,v:b,knows');
    expect(canonical(reloaded)).toEqual(canonical(store));
  });

  test('a value containing the delimiters survives quoting and array escaping', () => {
    const store = seeded(['g.addV("p").property(T.id,1)'
      + '.property(Cardinality.list,"note","a,b").property(Cardinality.list,"note","c;d")'
      + '.property("quote","say \\"hi\\"")']);
    const { reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));
  });

  test('a heterogeneous key gets ONE COLUMN PER TYPE, so no row loses its type', () => {
    // Both vendors key a property by name alone, so this is where an export stops being portable —
    // but widening the column to String would lose the type for the rows that HAD one, which is
    // worse than a file only we can read back.
    const store = seeded([
      'g.addV("p").property(T.id,1).property("v",1)',
      'g.addV("p").property(T.id,2).property("v","one")',
    ]);
    const { dump, reloaded } = roundTrip(store);
    expect(dump.vertices.split('\n')[0]).toBe('~id,~label,v:Int,v:String');
    expect(canonical(reloaded)).toEqual(canonical(store));
  });

  test('grateful-dead: 808 vertices and 8,049 edges through a whole-graph dump, DO-legal', () => {
    // The scale case: it says the drain pages (keysetPages) and chunks every per-page read, under the
    // CF-parity store that fails any statement past 100 binds.
    const store = fresh();
    loadGraphson(store, fixture('grateful-dead-v3.json'));
    const { dump, reloaded } = roundTrip(store);
    expect(dump.vertices.split('\n').length).toBe(809);   // header + 808
    expect(dump.edges.split('\n').length).toBe(8050);
    expect(canonical(reloaded)).toEqual(canonical(store));
  });
});

// ---------- 3. the lossy cases, asserted as exactly this lossy ----------

describe('the five widened scalars lose their TYPE TAG and nothing else', () => {
  const TYPED = 'g.addV("typed").property(T.id,1)'
    + '.property("bi", 9007199254740993N)'
    + '.property("bd", 3.141592653589793238462643383279M)'
    + '.property("du", Duration(90, 500000000))'
    + '.property("u", UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c"))'
    + '.property("dt", datetime("2024-01-01T00:00:00Z"))';

  test('bigint / bigdecimal / duration / uuid declare String and read back as string', () => {
    const store = seeded([TYPED]);
    const { dump, reloaded } = roundTrip(store);
    // Declared in the header, so a reader is TOLD what it is getting — that is the difference between
    // a documented widening and a wrong answer.
    expect(dump.vertices.split('\n')[0]).toBe('~id,~label,bd:String,bi:String,dt:DateTime,du:String,u:String');
    // The TEXT is exact in every case; only `vtype` moved to 'string'.
    expect(reloaded.query('SELECT key, value, vtype FROM vertex_properties ORDER BY key')).toEqual([
      { key: 'bd', value: '3.141592653589793238462643383279', vtype: 'string' },
      { key: 'bi', value: '9007199254740993', vtype: 'string' },
      // datetime is the one time type CSV DOES have, so it keeps its type and its epoch-millis storage.
      { key: 'dt', value: Date.parse('2024-01-01T00:00:00Z'), vtype: 'datetime' },
      { key: 'du', value: 'PT1M30.5S', vtype: 'string' },
      { key: 'u', value: '0263f28b-eff9-4c17-8e33-0b41c74b6d4c', vtype: 'string' },
    ]);
  });

  test("a Neo4j file's char and duration columns keep their types — its vocabulary is wider than ours out", () => {
    // The asymmetry is the dialects', not ours: Neo4j has `char` and `duration` column types, so an
    // INBOUND file carries what our own Neptune-shaped output has to widen.
    const store = fresh();
    loadCsv(store, ':ID,:LABEL,initial:char,elapsed:duration\n1,p,x,PT1M30.5S');
    expect(store.query('SELECT key, value, vtype FROM vertex_properties ORDER BY key')).toEqual([
      { key: 'elapsed', value: '90500000000', vtype: 'duration' },
      { key: 'initial', value: 'x', vtype: 'char' },
    ]);
  });
});

describe('what CSV cannot represent at all fails closed, naming GraphSON', () => {
  test('a collection-valued property stops the export at header time', () => {
    // A `list` VALUE and a multi-property are different graphs, so an `[]` column would read back as
    // something else — the one thing worse than refusing.
    const store = seeded(['g.addV("c").property(T.id,1).property("tags", ["a","b"])']);
    expect(() => writeCsv(store)).toThrow(/property "tags" holds a list, which no CSV column type can carry/);
    expect(() => writeCsv(store)).toThrow(/typed GraphSON/);
  });

  test('a meta-property stops the export — this is why gcrew cannot go through CSV', () => {
    const store = fresh();
    loadGraphson(store, fixture('tinkerpop-crew-v3.json'));
    expect(() => writeCsv(store)).toThrow(/carries meta-properties, which no CSV format represents/);
  });

  test('loading the same edge file twice names the policy rather than SQLite', () => {
    // An edge FILE is the first thing to reach the loader with no vertices beside it, so its ids sit
    // in the pending-endpoint queue at collision-check time. Before that queue was checked, this
    // reported `UNIQUE constraint failed: edges.id`, which is true and useless.
    const store = fresh();
    loadCsv(store, '~id,~label\n1,person\n2,person');
    loadCsv(store, '~id,~from,~to,~label\n7,1,2,knows');
    expect(() => loadCsv(store, '~id,~from,~to,~label\n7,1,2,knows'))
      .toThrow(/edges id 7 already exists in this graph — load with \{ idPolicy: 'remap' \}/);
  });

  test('an edge naming a vertex that is in neither the file nor the graph fails closed', () => {
    const store = fresh();
    loadCsv(store, '~id,~label\n1,person');
    expect(() => loadCsv(store, '~id,~from,~to,~label\n7,1,404,knows'))
      .toThrow(/references unknown vertex 404/);
  });
});

describe('csvPaths — the two keys a write() emits', () => {
  test('derives a vertex and an edge key from one path', () => {
    expect(csvPaths('out/graph.csv')).toEqual({ vertices: 'out/graph-vertices.csv', edges: 'out/graph-edges.csv' });
  });

  test('is idempotent: writing to a key it produced derives the same pair', () => {
    expect(csvPaths('out/graph-vertices.csv')).toEqual(csvPaths('out/graph.csv'));
    expect(csvPaths('out/graph-edges.csv')).toEqual(csvPaths('out/graph.csv'));
  });

  test('a dot in a DIRECTORY is not an extension', () => {
    expect(csvPaths('v1.2/graph')).toEqual({ vertices: 'v1.2/graph-vertices', edges: 'v1.2/graph-edges' });
  });
});
