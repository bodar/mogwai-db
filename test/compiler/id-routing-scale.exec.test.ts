// AN ID FILTER AFTER A RE-SOURCE IS LINEAR IN THE TRAVERSERS — `g.V().values(k).as('e').V().hasId(within(1,2,3))
// .has(k, select('e'))`, and its `has(T.id, lt(n))` twin.
//
// `hasId`/`has(T.id, …)` used to compare `COALESCE(uid, id)` inside a per-row EXISTS. No index can serve that
// expression, so a mid-chain `V()` meeting it was a full graph scan PER INCOMING TRAVERSER: measured on trunk
// 66 ms at 1k vertices and 3.8 s at 8k (57×), the cost of every outer row times the whole graph. The id
// question now goes through the one routing `V(ids)` uses (`idMembership`, `src/compiler/rel/source.ts`): over a
// bare id it is an UNCORRELATED membership — `id IN (SELECT id FROM nodes WHERE id IN (1,2,3) AND uid IS NULL)` —
// evaluated once and driven as a rowid seek, so each traverser meets three rows, not the graph.
//
// Asserts the ANSWER (a closed-form count) and a WALL budget generous for a loaded CI runner yet far below the
// quadratic cost.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { bare, run } from '../support/harness.ts';

const N = 6000;
/** Quadratic was ~2 s at this size on trunk; linear is ~25 ms. */
const BUDGET_MS = 1000;

/** `n` vertices, vertex v carrying `kind = v % 7`. */
function graph(n: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  for (let v = 1; v <= n; v++) {
    rawVertex(store, v, 'v');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [v, 'kind', v % 7, 'int']);
  }
  raw.exec('COMMIT');
  return store;
}

const store = graph(N);
/** Outer vertices whose kind is one of vertices 1, 2, 3's kinds (1, 2, 3) — each meets exactly one of them. */
const expected = Array.from({ length: N }, (_, i) => (i + 1) % 7).filter((k) => k >= 1 && k <= 3).length;

const timed = (q: string): { count: number; ms: number } => {
  run(store, q); // warm the statement cache; compile is constant in the graph size
  const t0 = performance.now();
  const count = bare(run(store, q))[0].v;
  return { count, ms: performance.now() - t0 };
};

describe('an id filter after a re-source scales linearly', () => {
  for (const q of [
    "g.V().values('kind').as('e').V().hasId(within(1,2,3)).has('kind', select('e')).count()",
    "g.V().values('kind').as('e').V().has(T.id, lt(4)).has('kind', select('e')).count()",
  ]) {
    test(q, () => {
      const { count, ms } = timed(q);
      expect(count).toBe(expected);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});
