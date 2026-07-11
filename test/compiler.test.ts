import { test, expect, describe } from 'bun:test';
import { compile } from '../src/compiler.js';
import { GraphStore } from '../src/storage.js';
import { BunSqlite } from '../src/bun/BunSqlite.js';
import { seedModern } from '../conformance/seed-modern.js';

// ---------- L2: SQL snapshots (canonical string -> SQL + binds + shape) ----------

const read = (q: string) => {
  const p = compile(q, {});
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

describe('compiler SQL snapshots', () => {
  test('valueMap variants set shape, reuse the vertex row source', () => {
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', keys: null, tokens: false });
    expect(read('g.V().valueMap(true)').shape).toEqual({ kind: 'valueMap', keys: null, tokens: true });
    expect(read('g.V().valueMap("name","age")').shape).toEqual({ kind: 'valueMap', keys: ['name', 'age'], tokens: false });
    expect(read('g.V().elementMap()').shape).toEqual({ kind: 'elementMap', keys: null });
  });

  test('order().by(key[, dir]) folds ORDER BY into the projection select', () => {
    const asc = read('g.V().hasLabel("person").order().by("age").values("name")');
    expect(asc.sql).toContain("ORDER BY json_extract(n.props, '$.age') ASC");
    expect(asc.binds).toEqual(['person']); // name/age spliced as literal paths

    const desc = read('g.V().hasLabel("person").order().by("age",desc).values("name")');
    expect(desc.sql).toContain("ORDER BY json_extract(n.props, '$.age') DESC");
  });

  test('values().order() sorts the projected scalar', () => {
    const p = read('g.V().values("age").order()');
    expect(p.sql).toContain('ORDER BY v ASC');
    expect(p.shape).toEqual({ kind: 'value' });
  });

  test('range/skip become LIMIT/OFFSET tail modifiers under order()', () => {
    expect(read('g.V().order().by("age").range(1,3).values("name")').sql).toContain('LIMIT 2 OFFSET 1');
    expect(read('g.V().order().by("age").skip(1)').sql).toContain('LIMIT -1 OFFSET 1');
  });

  test('range/skip/limit compose as CTEs when no order() is present', () => {
    expect(read('g.V().range(1,3)').sql).toContain('SELECT id FROM c0 LIMIT 2 OFFSET 1');
    expect(read('g.V().skip(2)').sql).toContain('SELECT id FROM c0 LIMIT -1 OFFSET 2');
  });

  test('illegal range is rejected', () => {
    expect(() => compile('g.V().range(2,1)', {})).toThrow('Not a legal range: [2, 1]');
  });

  test('limit before count wraps the counted id-relation', () => {
    expect(read('g.V().limit(2).count()').sql).toContain('SELECT COUNT(*) AS v FROM (SELECT id FROM c1)');
  });

  test('inject seeds a VALUES stream', () => {
    const p = read('g.inject(1,2,3)');
    expect(p.sql).toBe('WITH c0(v) AS (VALUES (?),(?),(?)) SELECT v FROM c0');
    expect(p.binds).toEqual([1, 2, 3]);
  });

  test('identifier keys splice as literal JSON paths (index-friendly); exotic keys are bound', () => {
    // Safe identifier: spliced literally so `CREATE INDEX ...(json_extract(props,'$.age'))`
    // can engage. See the property-index performance test below.
    const safe = read('g.V().has("age",30)');
    expect(safe.sql).toContain("json_extract(n.props, '$.age')");
    expect(safe.binds).toEqual([30]); // key not bound

    // Exotic key (space): falls back to the bound `'$.' || ?` form — correct,
    // just not index-eligible. The key value is never spliced into SQL.
    const exotic = read('g.V().has("first name","x")');
    expect(exotic.sql).toContain("json_extract(n.props, '$.' || ?)");
    expect(exotic.sql).not.toContain('first name');
    expect(exotic.binds).toEqual(['first name', 'x']);
  });
});

// ---------- L2: execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  seedModern(store);
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('compiler execution semantics', () => {
  test('order().by numeric ascending vs descending', () => {
    const store = seededStore();
    expect(run(store, 'g.V().hasLabel("person").order().by("age").values("name")').map((r) => r.v))
      .toEqual(['vadas', 'marko', 'josh', 'peter']); // 27,29,32,35
    expect(run(store, 'g.V().hasLabel("person").order().by("age",desc).values("name")').map((r) => r.v))
      .toEqual(['peter', 'josh', 'marko', 'vadas']);
  });

  test('order().by string is lexicographic', () => {
    const store = seededStore();
    expect(run(store, 'g.V().values("name").order()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('range is 0-based, low-inclusive high-exclusive', () => {
    const store = seededStore();
    expect(run(store, 'g.V().order().by("name").range(1,3).values("name")').map((r) => r.v))
      .toEqual(['lop', 'marko']);
  });

  test('traversers are a multiset — both() preserves duplicates', () => {
    // marko(1) knows vadas+josh and created lop; both() from lop reaches its 3 creators.
    const store = seededStore();
    const names = run(store, 'g.V(3).both("created").values("name")').map((r) => r.v).sort();
    expect(names).toEqual(['josh', 'marko', 'peter']); // lop created by all three
  });

  test('both() on a self-loop yields the vertex twice', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const person = store.labelId('person');
    const self = store.labelId('self');
    store.query('INSERT INTO nodes(id,label,props) VALUES(?,?,?)', [1, person, JSON.stringify({ name: 'ouro' })]);
    store.query('INSERT INTO edges(id,src,label,tgt,props) VALUES(?,?,?,?,?)', [2, 1, self, 1, '{}']);
    expect(run(store, 'g.V(1).both().count()').map((r) => r.v)).toEqual([2]);
  });

  test('has() on a missing property filters the traverser out', () => {
    const store = seededStore();
    // software vertices (lop, ripple) have no age -> excluded
    const names = run(store, 'g.V().has("age", 27).values("name")').map((r) => r.v);
    expect(names).toEqual(['vadas']);
    const some = run(store, 'g.V().values("lang")').map((r) => r.v).sort();
    expect(some).toEqual(['java', 'java']); // only software has lang; no nulls
  });

  test('order().by(key) then id() (n.props alias must be in scope)', () => {
    const store = seededStore();
    // regression: id projection needs the nodes n join so ORDER BY key resolves
    expect(run(store, 'g.V().hasLabel("person").order().by("age").id()').map((r) => r.v))
      .toEqual([2, 1, 4, 6]); // vadas,marko,josh,peter by age 27,29,32,35
  });

  test('drop() after an edge-reading traversal deletes the right vertices', () => {
    // regression: g.V(1).out().drop() must drop marko's out-neighbors, not just
    // their edges. Snapshotting target ids before mutating guards this.
    const store = seededStore();
    run(store, 'g.V(1).out().drop()'); // vadas(2), lop(3), josh(4)
    const remaining = run(store, 'g.V().values("name")').map((r) => r.v).sort();
    expect(remaining).toEqual(['marko', 'peter', 'ripple']);
  });

  test('drop() removes vertices and their incident edges', () => {
    const store = seededStore();
    run(store, 'g.V(1).drop()'); // marko + edges 7,8,9
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([5]);
    // marko was src of 3 edges; all gone
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3);
  });

  test('g.V().drop() empties the graph (cucumber reset idiom)', () => {
    const store = seededStore();
    run(store, 'g.V().drop()');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([0]);
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
  });
});
