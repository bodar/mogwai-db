// `V(<traversal>)`/`E(<traversal>)` IS LINEAR IN THE TRAVERSERS — the lookup of each produced id is an index
// seek, never a scan of the graph per id.
//
// The produced ids meet the element table through ONE routing (`externalIdIs`, `src/compiler/rel/source.ts`):
// `(id = <rowid key> AND uid IS NULL) OR uid = <uid key>`. SQLite serves that disjunction as a MULTI-INDEX
// OR — a rowid seek and a `uid` UNIQUE seek — only because each disjunct is a plain equality on an indexed
// column; a guard or a `COALESCE(uid, id)` comparison in either would turn every produced id into a full
// scan (quadratic). The plan is asserted here, and the WALL with an answer: a closed-form count and a budget
// generous for a loaded CI runner yet far below the quadratic cost.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { bare, read, run } from '../support/harness.ts';

const N = 6000;
/** Linear is ~15 ms at this size; a scan per produced id would be seconds. */
const BUDGET_MS = 1000;

/** `n` numbered vertices in a `knows` ring, each with a String-id twin its `ref` property names. */
function graph(n: number): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const vertices = [];
  for (let i = 1; i <= n; i++) vertices.push({ id: i, labels: ['p'], properties: [{ key: 'ref', value: `s${i}` }] });
  for (let i = 1; i <= n; i++) vertices.push({ id: `s${i}`, labels: ['q'] });
  const edges = [];
  for (let i = 1; i <= n; i++) edges.push({ label: 'knows', src: i, tgt: (i % n) + 1 });
  loadBulk(store, vertices, edges);
  return store;
}

const store = graph(N);

const timed = (q: string): { count: number; ms: number } => {
  run(store, q); // warm the statement cache; compile is constant in the graph size
  const t0 = performance.now();
  const count = bare(run(store, q))[0].v;
  return { count, ms: performance.now() - t0 };
};

describe('V(<traversal>)/E(<traversal>) scale linearly', () => {
  for (const [q, expected] of [
    ["g.V().V(__.out().id()).count()", N], // a Number id: the rowid seek
    ["g.V().V(__.values('ref')).count()", N], // a String id: the uid seek
    ["g.V().id().V(__.identity()).count()", 2 * N], // both, by each value's own type
    ["g.V().E(__.outE().id()).count()", N],
    ["g.V().outE().V(__.identity()).count()", N], // edge rowid k is id k, which names vertex k
    ["g.V().project('n').by(__.V(__.out().id()).count()).select('n').sum()", N],
  ] as const) {
    test(q, () => {
      const { count, ms } = timed(q);
      expect(count).toBe(expected);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  test('the lookup is a MULTI-INDEX OR of a rowid seek and a uid seek, never a scan', () => {
    const plan = read("g.V().id().V(__.identity()).count()");
    const detail = store.query(`EXPLAIN QUERY PLAN ${plan.sql}`, plan.binds).map((row: { detail: string }) => row.detail);
    expect(detail).toContain('MULTI-INDEX OR');
    expect(detail.some((d: string) => /SEARCH \S+ USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(d))).toBe(true);
    expect(detail.some((d: string) => /SEARCH \S+ USING COVERING INDEX \S+ \(uid=\?\)/.test(d))).toBe(true);
  });
});
