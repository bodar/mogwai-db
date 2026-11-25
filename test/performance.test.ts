import { test, expect, describe, beforeAll } from 'bun:test';
import { compile, type Compiled } from '../src/compiler/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { rawVertex } from './support/graph.ts';
import { runSteps } from '../src/program.ts';
import { idAlreadyExists } from './support/harness.ts';

// Performance regression guard for property access (W4).
//
// Vertex properties are normalized into `vertex_properties` with STATIC covering
// indexes built once at schema time: vp_key_value(key,value) and vp_node_key(node,key).
// has()/order().by()/values() must ride one of these — an index SEARCH, never a full
// SCAN of vertex_properties. This replaces the old self-tuning json_extract expression
// index (and its literal-splice requirement); a bound key still seeks a plain B-tree
// column, so there is nothing to auto-build and no per-key indexKeys reporting anymore.

describe('property indexes: static vp indexes engage (no full scan)', () => {
  let store: GraphStore, raw: BunSqlite;

  beforeAll(() => {
    raw = new BunSqlite(':memory:');
    store = new GraphStore(raw);
    raw.exec('BEGIN');
    const prop = 'INSERT INTO vertex_properties(node,key,value) VALUES(?,?,?)';
    for (let i = 1; i <= 5000; i++) {
      rawVertex(store, i, 'person');
      store.query(prop, [i, 'name', 'n' + i]);
      store.query(prop, [i, 'age', 18 + (i % 60)]);
    }
    raw.exec('COMMIT');
  });

  const plan = (q: string): Compiled => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected read plan');
    return p;
  };
  const explain = (p: Compiled) => store.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds).map((r: any) => r.detail);
  // EXPLAIN names the table by its alias (vp) or full name, and may insert EXISTS —
  // key on the vp_ index name instead.
  const usesVpIndex = (d: string[]) => d.some((s) => /USING (COVERING )?INDEX vp_/.test(s));
  const scansVp = (d: string[]) => d.some((s) => /\bSCAN (vertex_properties|vp)\b/.test(s) && !/USING/.test(s));
  // A src-only seek may take `e_pair(src, tgt)` (`src/storage.ts`): the narrower covering index with e_out's prefix.
  const usesEdgeIndex = (d: string[], name: 'e_out' | 'e_in') =>
    d.some((s) => s.includes(`USING COVERING INDEX ${name}`) || (name === 'e_out' && s.includes('USING COVERING INDEX e_pair (src=?)')));

  test('the static vp indexes exist at schema time (no self-tuning build)', () => {
    const idx = store.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
    expect(idx).toContain('vp_key_value');
    expect(idx).toContain('vp_node_key');
  });

  test('has(key, P) rides a vp index (no full scan of vertex_properties)', () => {
    const p = plan('g.V().has("age", gt(70)).count()');
    const d = explain(p);
    expect(usesVpIndex(d)).toBe(true);
    expect(scansVp(d)).toBe(false);
  });

  test('has(key, value) point lookup rides a vp index', () => {
    const d = explain(plan('g.V().has("name", "n42")'));
    expect(usesVpIndex(d)).toBe(true);
    expect(scansVp(d)).toBe(false);
  });

  test('order().by(key) resolves the sort value via a vp index', () => {
    const d = explain(plan('g.V().order().by("age").limit(10).id()'));
    expect(usesVpIndex(d)).toBe(true);
  });

  test('values(key) flatMap join rides a vp index', () => {
    const d = explain(plan('g.V().values("name")'));
    expect(usesVpIndex(d)).toBe(true);
  });

  test('correlated where(outE()) stays an index-only existence probe', () => {
    const d = explain(plan('g.V().where(__.outE())'));
    expect(usesEdgeIndex(d, 'e_out')).toBe(true);
  });

  test('correlated map(outE().count()) stays an index-only scalar fast path', () => {
    const d = explain(plan('g.V().map(__.outE().count())'));
    expect(usesEdgeIndex(d, 'e_out')).toBe(true);
  });


});

// User-id uniqueness is a PARTIAL unique index (`nodes_uid`/`edges_uid`, `WHERE uid IS NOT NULL`), not a
// column UNIQUE: an element with no uid has no index entry. These pin that every uid lookup still seeks it.
describe('uid indexes: partial, unique, and every uid lookup seeks them', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const run = (q: string) => {
    const p = compile(q, {});
    if (p.kind === 'program') return [...runSteps(store, p)];
    return store.query(p.sql, p.binds);
  };
  const explain = (q: string) => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected read plan');
    return store.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds).map((r) => r.detail);
  };
  beforeAll(() => {
    run("g.addV('p').property(T.id,'a')");
    run("g.addV('p').property(T.id,'b')");
    run("g.addV('p').addV('p')");
    run("g.addE('x').from(__.V('a')).to(__.V('b')).property(T.id,'e1')");
  });

  test('no column autoindex on uid; the partial indexes exist and hold only uid rows', () => {
    const idx = store.query<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type='index'");
    const names = idx.map((r) => r.name);
    expect(names).not.toContain('sqlite_autoindex_nodes_1');
    expect(names).not.toContain('sqlite_autoindex_edges_1');
    for (const name of ['nodes_uid', 'edges_uid'])
      expect(idx.find((r) => r.name === name)?.sql).toContain('WHERE uid IS NOT NULL');
    // 4 vertices, 2 with a uid: the partial index holds 2 entries.
    expect(store.query('SELECT COUNT(*) AS n FROM nodes INDEXED BY nodes_uid WHERE uid IS NOT NULL')).toEqual([{ n: 2 }]);
  });

  test.each([
    ["g.V('a')", 'nodes_uid'],
    ["g.V('a','b').out()", 'nodes_uid'],
    ["g.V().hasId(within('a','b'))", 'nodes_uid'],
    ["g.V(__.constant('b')).id()", 'nodes_uid'],
    ["g.V('a').where(__.out().hasId('b'))", 'nodes_uid'],
    ["g.E('e1')", 'edges_uid'],
    ["g.E(__.constant('e1')).id()", 'edges_uid'],
  ])('%s seeks %s', (q, index) => {
    expect(explain(q).some((d) => d.startsWith('SEARCH') && d.includes(`INDEX ${index} (uid=?`))).toBe(true);
  });

  test('a second element with a taken uid is still refused; many uid-less elements are not', () => {
    expect(() => run("g.addV().property(T.id,'a')")).toThrow(idAlreadyExists('Vertex', 'a'));
    expect(() => run("g.addE('x').from(__.V('a')).to(__.V('b')).property(T.id,'e1')")).toThrow(idAlreadyExists('Edge', 'e1'));
    run("g.addV().addV().addV()");
    expect(store.query('SELECT COUNT(*) AS n FROM nodes WHERE uid IS NULL')).toEqual([{ n: 5 }]);
  });
});

/**
 * COMPILE COST IS LINEAR IN THE LENGTH OF THE CHAIN — the one regression this file asserts in WALL
 * CLOCK, and the exception is the point.
 *
 * Everything above pins a PLAN SHAPE, deliberately: wall clock is flaky and a plan is not. This one
 * has to be time, because the defect WAS time and nothing else. `both()` is a `Union` of two arms
 * and both arms read the SAME input relation, so a k-hop chain is a DAG with 2^k paths through it —
 * and a walk over it with no visited-guard takes 2^k steps. The emitted SQL stayed LINEAR
 * throughout (~310 bytes per hop), which is exactly why no other instrument could see it: the plan
 * was always right, only the walk that built it was exponential.
 *
 * Measured on `g.V().both()×k.count()`, before → after the guard in `freeRelIds` (`src/rel/walk.ts`):
 * k=12 14 ms → 4 ms · k=16 169 ms → 4 ms · k=20 2 660 ms → 7 ms · k=80 unreachable → 36 ms.
 *
 * The bound is ~100× the measured time, so it guards against the exponential COMING BACK rather than
 * setting a performance target. Any un-memoised DAG walk added to the compile path fails it.
 */
describe('compile cost is linear in the length of the chain', () => {
  test('a 24-hop both() chain compiles in milliseconds, not minutes', () => {
    const started = performance.now();
    const compiled = compile(`g.V()${'.both()'.repeat(24)}.count()`, {});
    const elapsed = performance.now() - started;
    expect(compiled.kind).toBe('read');
    expect(elapsed).toBeLessThan(2000);
  });

  test('doubling the hops roughly doubles the SQL, and never more', () => {
    const sqlOf = (k: number) => {
      const compiled = compile(`g.V()${'.both()'.repeat(k)}.count()`, {});
      if (compiled.kind !== 'read') throw new Error('expected read plan');
      return compiled.sql.length;
    };
    // The OUTPUT was linear even while the walk was exponential, so this is the other half of the
    // property rather than a proxy for it: the plan has to stay linear too.
    expect(sqlOf(40)).toBeLessThan(sqlOf(20) * 2.2);
  });
});
