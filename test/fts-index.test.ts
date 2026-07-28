// Step 6 in isolation: the property_fts FTS5 schema + write-path indexer. Verified BEFORE
// tinker.search / TextP consume it, so the index maintenance is proven correct on its own.
// Writes go through the normal traversal path (executeQuery); assertions query property_fts
// directly. Covers: schema creation, kind='value' toString, nested jsonkey/jsonleaf, single
// replace + set + list cardinalities, edge props, drop() cascade, and that LIKE/MATCH over
// the trigram index are index-served (EXPLAIN QUERY PLAN).
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from './support/executor.ts';

interface Row { owner_elem: string; pid: number; owner: number; pk: string; kind: string; text: string; }

function freshStore(writes: string[] = []): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(store, w, {});
  return store;
}

const fts = (store: GraphStore, where = '', binds: any[] = []): Row[] =>
  store.query<Row>(`SELECT owner_elem, pid, owner, pk, kind, text FROM property_fts ${where} ORDER BY rowid`, binds);

describe('property_fts schema', () => {
  test('the virtual table exists on a fresh store (part of initSchema)', () => {
    const store = freshStore();
    // Querying it must not throw "no such table".
    expect(fts(store)).toEqual([]);
  });

  test('re-running initSchema is idempotent (IF NOT EXISTS on the vtable)', () => {
    const store = freshStore(["g.addV('p').property('name', 'marko')"]);
    store.initSchema();
    expect(fts(store, "WHERE kind='value'").map((r) => r.text)).toEqual(['marko']);
  });
});

describe('scalar property indexing', () => {
  test('a string property emits exactly one kind=value row (the toString)', () => {
    const store = freshStore(["g.addV('person').property('name', 'marko')"]);
    const rows = fts(store);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ owner_elem: 'node', pk: 'name', kind: 'value', text: 'marko' });
  });

  test('a numeric property stringifies its value; no jsonleaf for a top-level scalar', () => {
    const store = freshStore(["g.addV('person').property('age', 29)"]);
    const rows = fts(store);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([['value', '29']]);
  });
});

describe('collection property indexing (ValueNode-aware)', () => {
  test('a list property: kind=value is the [a, b] toString; each element is a jsonleaf', () => {
    const store = freshStore(["g.addV('t').property('tags', ['abrave', 'coward'])"]);
    const byKind = (k: string) => fts(store, 'WHERE kind=?', [k]).map((r) => r.text);
    expect(byKind('value')).toEqual(['[abrave, coward]']);
    expect(byKind('jsonleaf').sort()).toEqual(['abrave', 'coward']);
    // A "brave" substring search hits the value toString ("[abrave, coward]") AND the leaf.
    const brave = store.query<{ n: number }>("SELECT count(*) AS n FROM property_fts WHERE text LIKE '%brave%'");
    expect(brave[0].n).toBeGreaterThan(0);
  });

  test('a map property: kind=value is {k=v}; keys→jsonkey, values→jsonleaf', () => {
    const store = freshStore(["g.addV('t').property('addr', [city: 'london', zone: 'central'])"]);
    const byKind = (k: string) => fts(store, 'WHERE kind=?', [k]).map((r) => r.text).sort();
    expect(byKind('jsonkey')).toEqual(['city', 'zone']);
    expect(byKind('jsonleaf')).toEqual(['central', 'london']);
    expect(byKind('value')[0]).toContain('city=london');
  });
});

describe('cardinality maintenance', () => {
  test('single cardinality replaces the FTS row (no stale text)', () => {
    const store = freshStore([
      "g.addV('person').property('name', 'marko')",
      "g.V().has('name', 'marko').property('name', 'MARKO2')",
    ]);
    expect(fts(store, "WHERE pk='name'").map((r) => r.text)).toEqual(['MARKO2']);
  });

  test('list cardinality appends a second indexed row', () => {
    const store = freshStore([
      "g.addV('person').property(list, 'nick', 'okram')",
      "g.V().property(list, 'nick', 'aurelius')",
    ]);
    expect(fts(store, "WHERE pk='nick' AND kind='value'").map((r) => r.text).sort()).toEqual(['aurelius', 'okram']);
  });

  test('set cardinality does not duplicate an equal value', () => {
    const store = freshStore([
      "g.addV('person').property(set, 'tag', 'a')",
      "g.V().property(set, 'tag', 'a')",
    ]);
    expect(fts(store, "WHERE pk='tag' AND kind='value'").length).toBe(1);
  });
});

describe('edge property indexing', () => {
  test('an edge property indexes with owner_elem=edge', () => {
    const store = freshStore([
      "g.addV('person').as('a').addV('person').as('b').addE('knows').from('a').to('b').property('note', 'longtimefriend')",
    ]);
    const rows = fts(store, "WHERE owner_elem='edge'");
    expect(rows.map((r) => [r.pk, r.text])).toEqual([['note', 'longtimefriend']]);
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
    // the UNINDEXED columns; not 0 here since text is preceded by owner_elem/pid/owner/pk/kind).
    expect(plan).toMatch(/VIRTUAL TABLE INDEX 0:L\d/);
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
