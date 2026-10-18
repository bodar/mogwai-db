// Step 6 in isolation: the property_fts FTS5 schema + write-path indexer. Verified BEFORE
// tinker.search / TextP consume it, so the index maintenance is proven correct on its own.
// Writes go through the normal traversal path (executeQuery); assertions query property_fts
// directly. Covers: schema creation, one toString row per property keyed by its signed id,
// single replace + set + list cardinalities, edge props, drop() cascade, and that LIKE/MATCH
// over the trigram index and the rowid deletes are index-served (EXPLAIN QUERY PLAN).
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from './support/executor.ts';

interface Row { rowid: number; owner_elem: string; pid: number; owner: number; pk: string; text: string; }

function freshStore(writes: string[] = []): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(store, w, {});
  return store;
}

const fts = (store: GraphStore, where = '', binds: any[] = []): Row[] =>
  store.query<Row>(`SELECT rowid, owner_elem, pid, owner, pk, text FROM property_fts ${where} ORDER BY rowid`, binds);

describe('property_fts schema', () => {
  test('the virtual table exists on a fresh store (part of initSchema)', () => {
    const store = freshStore();
    // Querying it must not throw "no such table".
    expect(fts(store)).toEqual([]);
  });

  test('re-running initSchema is idempotent (IF NOT EXISTS on the vtable)', () => {
    const store = freshStore(["g.addV('p').property('name', 'marko')"]);
    store.initSchema();
    expect(fts(store).map((r) => r.text)).toEqual(['marko']);
  });
});

describe('scalar property indexing', () => {
  test('a string property emits exactly one row (the toString), keyed by its property id', () => {
    const store = freshStore(["g.addV('person').property('name', 'marko')"]);
    const rows = fts(store);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ owner_elem: 'node', pk: 'name', text: 'marko' });
    expect(rows[0]!.rowid).toBe(rows[0]!.pid);
  });

  test('a numeric property stringifies its value', () => {
    const store = freshStore(["g.addV('person').property('age', 29)"]);
    expect(fts(store).map((r) => r.text)).toEqual(['29']);
  });

  test('an empty string indexes as no row', () => {
    const store = freshStore(["g.addV('person').property('name', '')"]);
    expect(fts(store)).toEqual([]);
  });
});

describe('collection property indexing (ValueNode-aware)', () => {
  test('a list property is ONE row: the [a, b] toString', () => {
    const store = freshStore(["g.addV('t').property('tags', ['abrave', 'coward'])"]);
    expect(fts(store).map((r) => r.text)).toEqual(['[abrave, coward]']);
    // A "brave" substring search hits the toString.
    const brave = store.query<{ n: number }>("SELECT count(*) AS n FROM property_fts WHERE text LIKE '%brave%'");
    expect(brave[0].n).toBe(1);
  });

  test('a map property is ONE row: the {k=v} toString', () => {
    const store = freshStore(["g.addV('t').property('addr', [city: 'london', zone: 'central'])"]);
    expect(fts(store).map((r) => r.text)).toEqual(['{city=london, zone=central}']);
  });
});

describe('cardinality maintenance', () => {
  // `single` is spelled out, like its list/set siblings below. It used to be implicit, which
  // stopped being the same test the moment the graph default became `list` (api.ts,
  // DEFAULT_VERTEX_CARDINALITY) — this asserts the replace, not the default.
  test('single cardinality replaces the FTS row (no stale text)', () => {
    const store = freshStore([
      "g.addV('person').property(single, 'name', 'marko')",
      "g.V().has('name', 'marko').property(single, 'name', 'MARKO2')",
    ]);
    expect(fts(store, "WHERE pk='name'").map((r) => r.text)).toEqual(['MARKO2']);
  });

  // The DEFAULT is list, so an undeclared repeat write indexes BOTH — the FTS-side face of the
  // multi-property default.
  test('an undeclared repeat write appends a second indexed row', () => {
    const store = freshStore([
      "g.addV('person').property('name', 'marko')",
      "g.V().has('name', 'marko').property('name', 'MARKO2')",
    ]);
    expect(fts(store, "WHERE pk='name'").map((r) => r.text).sort()).toEqual(['MARKO2', 'marko']);
  });

  // …and a `single` DECLARATION sticks to the (node, key) it was made on: the later write names
  // no cardinality and still replaces.
  test('a declared single is remembered by a later undeclared write', () => {
    const store = freshStore([
      "g.addV('person').property(single, 'name', 'marko')",
      "g.V().has('name', 'marko').property('name', 'MARKO2')",
    ]);
    expect(fts(store, "WHERE pk='name'").map((r) => r.text)).toEqual(['MARKO2']);
  });

  test('list cardinality appends a second indexed row', () => {
    const store = freshStore([
      "g.addV('person').property(list, 'nick', 'okram')",
      "g.V().property(list, 'nick', 'aurelius')",
    ]);
    expect(fts(store, "WHERE pk='nick'").map((r) => r.text).sort()).toEqual(['aurelius', 'okram']);
  });

  test('set cardinality does not duplicate an equal value', () => {
    const store = freshStore([
      "g.addV('person').property(set, 'tag', 'a')",
      "g.V().property(set, 'tag', 'a')",
    ]);
    expect(fts(store, "WHERE pk='tag'").length).toBe(1);
  });
});

describe('edge property indexing', () => {
  test('an edge property indexes with owner_elem=edge, keyed by its NEGATED property id', () => {
    const store = freshStore([
      "g.addV('person').as('a').addV('person').as('b').addE('knows').from('a').to('b').property('note', 'longtimefriend')",
    ]);
    const rows = fts(store, "WHERE owner_elem='edge'");
    expect(rows.map((r) => [r.pk, r.text])).toEqual([['note', 'longtimefriend']]);
    expect(rows[0]!.rowid).toBe(-rows[0]!.pid);
  });

  test('overwriting an edge property (UPSERT) replaces its FTS text', () => {
    const store = freshStore([
      "g.addV('person').as('a').addV('person').as('b').addE('knows').from('a').to('b').property('note', 'first')",
      "g.E().property('note', 'second')",
    ]);
    expect(fts(store, "WHERE owner_elem='edge' AND pk='note'").map((r) => r.text)).toEqual(['second']);
  });
});

describe('drop() cascade', () => {
  test('dropping a vertex removes its FTS rows', () => {
    const store = freshStore([
      "g.addV('person').property('name', 'marko')",
      "g.addV('person').property('name', 'josh')",
    ]);
    executeQuery(store, "g.V().has('name', 'marko').drop()", {});
    expect(fts(store).map((r) => r.text)).toEqual(['josh']);
  });

  test('dropping a vertex removes its incident edges FTS rows too', () => {
    const store = freshStore([
      "g.addV('person').as('a').addV('person').as('b').addE('knows').from('a').to('b').property('note', 'friendship')",
    ]);
    expect(fts(store, "WHERE owner_elem='edge'").length).toBe(1);
    executeQuery(store, 'g.V().drop()', {});
    expect(fts(store)).toEqual([]);
  });

  test('dropping an edge removes only the edge FTS rows', () => {
    const store = freshStore([
      "g.addV('person').property('name', 'marko').as('a').addV('person').property('name', 'josh').as('b').addE('knows').from('a').to('b').property('note', 'pals')",
    ]);
    executeQuery(store, 'g.E().drop()', {});
    expect(fts(store, "WHERE owner_elem='edge'")).toEqual([]);
    expect(fts(store, "WHERE owner_elem='node'").map((r) => r.text).sort()).toEqual(['josh', 'marko']);
  });
});

describe('index is trigram-served', () => {
  test('LIKE %sub% over property_fts.text uses the trigram index', () => {
    const store = freshStore(["g.addV('t').property('name', 'marko')"]);
    const plan = store.query<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM property_fts WHERE text LIKE '%ark%'")
      .map((r) => r.detail).join(' | ');
    // idxStr Ln = trigram LIKE served from the index (n = the text column's offset among
    // the UNINDEXED columns; not 0 here since text is preceded by owner_elem/pid/owner/pk).
    expect(plan).toMatch(/VIRTUAL TABLE INDEX 0:L\d/);
  });

  test('a delete through the property rows is a rowid seek, not a table scan', () => {
    const store = freshStore(["g.addV('t').property('name', 'marko')"]);
    const plan = store.query<{ detail: string }>(
      'EXPLAIN QUERY PLAN DELETE FROM property_fts WHERE rowid IN (SELECT id FROM vertex_properties WHERE node IN (SELECT value FROM json_each(?)))', ['[1]'])
      .map((r) => r.detail).join(' | ');
    // FTS5's idxStr for a rowid equality is `=`; a full scan has none.
    expect(plan).toMatch(/VIRTUAL TABLE INDEX 0:=/);
  });

  test('MATCH over property_fts.text uses the trigram index', () => {
    const store = freshStore(["g.addV('t').property('name', 'marko')"]);
    const plan = store.query<{ detail: string }>("EXPLAIN QUERY PLAN SELECT * FROM property_fts WHERE text MATCH '\"ark\"'")
      .map((r) => r.detail).join(' | ');
    expect(plan).toContain('VIRTUAL TABLE INDEX');
  });
});

// ---------- the persisted spelling is a DATA contract, not an internal name ----------

describe('property_fts.owner_elem stores the SQL spelling, permanently', () => {
  // `owner_elem` values live in a real table in a real Durable Object. The compiler's element
  // vocabulary is 'vertex'|'edge'; this column's is 'node'|'edge', and it must STAY that way,
  // because renaming it is a silent data-compatibility break rather than a test failure: new code
  // would write and query 'vertex' while every pre-existing row still said 'node', so
  // tinker.search and every TextP predicate would return [] against an existing graph with no
  // error anywhere. The census cannot catch this — it seeds a fresh graph every run, so both
  // sides of the mismatch would agree.
  //
  // Nothing here is about correctness of search; it is about the ONE seam where an internal
  // rename must stop. If you are here because you renamed something and this went red, the fix is
  // to route through `sqlElem()`, not to update the expectation.
  test('a vertex property indexes as owner_elem="node", an edge property as "edge"', () => {
    const store = freshStore([
      "g.addV('person').property(T.id, 1).property('name', 'marko')",
      "g.addV('person').property(T.id, 2).property('name', 'vadas')",
      "g.V(1).addE('knows').to(__.V(2)).property('how', 'college')",
    ]);
    expect([...new Set(fts(store).map((r) => r.owner_elem))].sort()).toEqual(['edge', 'node']);
  });

  test('rows written earlier stay readable — the spelling is stable across writes', () => {
    // The migration scenario in miniature: index a row, then index another, then read with the
    // same predicate the compiler emits. A spelling drift between write and read shows up as the
    // second query missing the first row.
    const store = freshStore(["g.addV('person').property(T.id, 1).property('name', 'marko')"]);
    const before = fts(store, "WHERE owner_elem='node'").length;
    executeQuery(store, "g.addV('person').property(T.id, 2).property('name', 'markus')", {});
    expect(fts(store, "WHERE owner_elem='node'").length).toBeGreaterThan(before);
    expect(fts(store, "WHERE owner_elem='vertex'")).toEqual([]);
  });
});

describe('an index written before the signed-rowid key is upgraded in place', () => {
  test('the old kind-column table is rebuilt from its value rows, keyed by signed property id', () => {
    const sql = new BunSqlite(':memory:');
    sql.exec(`CREATE VIRTUAL TABLE property_fts USING fts5(
      owner_elem UNINDEXED, pid UNINDEXED, owner UNINDEXED, pk UNINDEXED, kind UNINDEXED,
      text, tokenize="trigram case_sensitive 0")`);
    sql.exec(`INSERT INTO property_fts(owner_elem, pid, owner, pk, kind, text) VALUES
      ('node', 7, 1, 'tags', 'value', '[abrave, coward]'), ('node', 7, 1, 'tags', 'jsonleaf', 'abrave'),
      ('edge', 7, 3, 'note', 'value', 'pals')`);
    const store = new GraphStore(sql);
    expect(fts(store).map((r) => [r.rowid, r.owner_elem, r.pid, r.text])).toEqual([
      [-7, 'edge', 7, 'pals'], [7, 'node', 7, '[abrave, coward]'],
    ]);
  });
});
