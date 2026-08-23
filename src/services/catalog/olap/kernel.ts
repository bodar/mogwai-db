import type { BarrierInput, BarrierRelation } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { isTraversalParam } from '../../params/call-params.ts';
import { parseGremlin, stepChain } from '../../../gremlin/frontend.ts';

// The shared OLAP BARRIER KERNEL — the substrate every graph algorithm in `olap/` builds on: the edge
// message scope, the `barrier_state` scratch fragments + the in-SQL fixpoint driver (`iterateInSql`),
// and the scope-keyed shortest-distance relaxation (`relaxShortestPath`). One home so an algorithm file
// extends ONE kernel, not three copies. Reference + rationale: docs/2026-08-23-barrier-substrate-reshape-plan.md,
// docs/2026-07-24-graph-algorithms-plan.md.

// ---------- the OLAP edge scope (~tinkerpop.<algo>.edges) ----------
//
// An algorithm's message scope: which edges relate two vertices, and in which direction rank/labels
// flow. The reference default is `outE` for pageRank (rank flows along out-edges) and `bothE` for
// connectedComponent (undirected). A custom scope arrives as an ANONYMOUS edge sub-traversal
// (`__.outE("knows")`, `__.inE("created")`, `__.bothE()`) carried as a TraversalParam (the serializer
// no longer refuses anonymous — see services/params/traversal-param.ts). We read it to a
// `{direction, labels}` descriptor and build the adjacency with ONE store query.

/** `out`: rank/label flows src→tgt. `in`: tgt→src. `both`: both. */
export type EdgeScope = { readonly direction: 'out' | 'in' | 'both'; readonly labels: readonly string[] };

/** Parse an edges-scope param into `{direction, labels}`. `undefined` → the algorithm's default
 *  direction, all labels. A `Direction` enum token (`{direction:'in'}`) is accepted too. Anything
 *  richer than a single `outE`/`inE`/`bothE(labels?)` fails closed — never a silent wrong scope. */
export function edgeScopeOf(value: unknown, defaultDir: EdgeScope['direction'], algo: string): EdgeScope {
  if (value === undefined) return { direction: defaultDir, labels: [] };
  if (value && typeof value === 'object' && 'direction' in value) {
    const d = String((value as { direction: unknown }).direction).toLowerCase();
    if (d === 'out' || d === 'in' || d === 'both') return { direction: d, labels: [] };
  }
  const gremlin = isTraversalParam(value) ? value.gremlin : typeof value === 'string' ? value : null;
  if (gremlin === null)
    throw new Error(`${algo}: unsupported edges scope ${String(value)}`);
  // Our parser roots at a source; an anonymous edge body prepends one so the ONE edge step is readable.
  const rooted = gremlin.startsWith('__.') ? 'g.V().' + gremlin.slice(3) : gremlin;
  let steps;
  try { steps = stepChain(parseGremlin(rooted), {}).filter((s) => s.name !== 'V' && s.name !== 'E'); }
  catch { throw new Error(`${algo}: could not read the edges scope "${gremlin}"`); }
  const dir = steps.length === 1
    ? ({ outE: 'out', inE: 'in', bothE: 'both' } as const)[steps[0].name as 'outE' | 'inE' | 'bothE']
    : undefined;
  if (!dir)
    throw new Error(`${algo}: only a single outE/inE/bothE(labels?) edges scope is supported yet, got "${gremlin}"`);
  return { direction: dir, labels: steps[0].args.map((a) => a.value).filter((v): v is string => typeof v === 'string') };
}

// ---------- substrate-A-iterated: an OLAP relaxation as ONE SQL statement per round, SQL-RESIDENT ----------
//
// The compute stays in SQLite (locked decision #3), AND so does its state. The `(id → value)` vector
// lives in `barrier_state` (`src/storage.ts`) — a scratch table keyed by a per-query `run` token —
// never in a JS Map. Each round is one INSERT..SELECT that reads the prior round's slot and writes the
// next, joining the real `nodes`/`edges` tables; the ONLY things that cross to the host per round are
// O(1) SCALARS (pageRank's teleport energy, the convergence delta). So a graph of millions of vertices
// never materializes its O(V) vector in JS — not per iteration, and not at the segment handoff, where
// the DECORATE resume reads the final slot straight off the table by run token
// (`docs/2026-08-21-barrier-substrate-design.md` §Axis 2). This replaced the former json_each vector
// bind, which crossed the whole vector both per round and again into the decorate binding. The pure-JS
// reference implementations that once lived here are TEST-ONLY differential oracles and now live with
// the test that uses them (`test/L2-sql/olap-differential.test.ts`), so `src/` holds only the SQL path.

/** A directed-adjacency CTE `e(src, tgt)` for a scope — "v's contribution flows src→tgt". `out` reads
 *  edges as-is, `in` swaps, `both` unions both directions. The label filter (if any) is ONE json_each
 *  bind; the returned `labelBinds` are prepended to a statement's binds (before the run/round binds).
 *  A statement embedding `${cte}` once takes one copy of `labelBinds`. */
export function adjacencyCte(scope: EdgeScope): { cte: string; labelBinds: string[] } {
  const labelBinds = scope.labels.length ? [JSON.stringify(scope.labels)] : [];
  const filter = scope.labels.length
    ? ' WHERE label IN (SELECT id FROM labels WHERE name IN (SELECT value FROM json_each(?)))' : '';
  const base = `SELECT src, tgt FROM edges${filter}`;
  const body = scope.direction === 'out' ? base
    : scope.direction === 'in' ? `SELECT tgt AS src, src AS tgt FROM edges${filter}`
    : `${base} UNION ALL SELECT tgt AS src, src AS tgt FROM edges${filter}`;
  // `both`/directional forms repeat the filter, so its bind repeats too (positional `?`).
  const binds = scope.direction === 'both' ? [...labelBinds, ...labelBinds] : labelBinds;
  return { cte: `e(src, tgt) AS (${body})`, labelBinds: binds };
}

// The barrier scratch is the general `barrier_state(run, round, scope, id, channel, cval)` — one row per
// (run, round, scope, id, channel) (`src/storage.ts`, `docs/2026-08-23-barrier-substrate-reshape-plan.md`).
// A NODE-KEYED, SINGLE-CHANNEL fixpoint (wcc/pageRank/peerPressure) uses `scope` 0 and `channel` 0; the
// two extra key dims stay literal 0 here and become live for the pair-keyed (Brandes/similarity) and
// multi-channel (shortest-path dist + predecessor) consumers. Centralised so those consumers extend ONE
// pair of fragments, not three copies of the SQL.

/** The INSERT column list for the scratch. A single-channel writer supplies `scope`/`channel` as the
 *  literal `0`s in its SELECT (`?, <round>, 0, <id>, 0, <cval>`). */
export const STATE_INSERT = 'INSERT INTO barrier_state(run, round, scope, id, channel, cval)';
/** The prior-slot vector, node-keyed single channel — the read half all three algorithms share. Binds:
 *  `run, round`. Pins `scope = 0 AND channel = 0` so it stays correct once a run holds other channels. */
export const VEC = 'vec AS (SELECT id, cval AS v FROM barrier_state WHERE run = ? AND round = ? AND scope = 0 AND channel = 0)';

/** A round `slot` in `barrier_state` — the vector alternates between two slots so a run holds at
 *  most two vectors, cur and next. */
export type Slot = 0 | 1;

/** Wrap an OLAP barrier's SYNCHRONOUS core into the `{apply, applySync}` a barrier contribution declares.
 *  `apply` (async) is the PRODUCTION path — it can yield so a large compute does not busy-lock the DO;
 *  `applySync` is the SAME core for the sync/test drive (`framed()`/census), where busy-locking is fine.
 *  Exact because the OLAP computes are pure in-SQL loops with no real await (`src/services/spi/types.ts`). */
export function syncBarrier(core: (rows: readonly BarrierInput[]) => BarrierRelation): {
  readonly apply: (rows: readonly BarrierInput[]) => Promise<BarrierRelation>;
  readonly applySync: (rows: readonly BarrierInput[]) => BarrierRelation;
} {
  return { apply: async (rows) => core(rows), applySync: core };
}

/** Drive an OLAP relaxation to a fixpoint ENTIRELY in SQL. The vector lives in `barrier_state`
 *  under `run`, in alternating slots (0/1) — it never enters JS. `seed()` writes slot 0; `step(prev,
 *  next)` runs ONE INSERT..SELECT reading slot `prev` and writing slot `next`; `delta(prev, next)`
 *  returns ONE scalar measuring change between the slots (the ONLY thing that crosses per round).
 *  Iteration stops when `stop(delta)` holds or after `maxRounds`. Returns the slot holding the final
 *  vector — `maxRounds === 0` (pageRank `times(0)`) returns the seed unchanged. */
export function iterateInSql(
  store: GraphStore, run: number,
  seed: () => void, step: (prev: Slot, next: Slot) => void,
  delta: (prev: Slot, next: Slot) => number, maxRounds: number, stop: (d: number) => boolean,
): Slot {
  seed();
  let cur: Slot = 0;
  for (let i = 0; i < maxRounds; i++) {
    const next: Slot = cur === 0 ? 1 : 0;
    // Overwrite the slot we are about to fill (a prior iteration left the old cur there).
    store.query('DELETE FROM barrier_state WHERE run = ? AND round = ?', [run, next]);
    step(cur, next);
    const d = delta(cur, next);
    cur = next;
    if (stop(d)) break;
  }
  return cur;
}

/** Σ|next − prev| over the two slots — pageRank's ε-convergence measure (floats never settle to
 *  bit-equality). One scalar. */
export const sumAbsDelta = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
  store.query<{ d: number }>(
    `SELECT COALESCE(SUM(ABS(a.cval - b.cval)), 0) AS d
       FROM barrier_state a JOIN barrier_state b ON a.id = b.id AND a.scope = b.scope AND a.channel = b.channel
      WHERE a.run = ? AND a.round = ? AND b.run = ? AND b.round = ?`,
    [run, next, run, prev])[0].d;

/** Count of rows in the NEXT slot that are new (absent in prev) OR changed — the fixpoint test for a
 *  SPARSE frontier (shortest path reaches nodes incrementally, so `changedCount`'s INNER JOIN would miss
 *  a newly-reached node and stop early). Bellman-Ford is monotone (the reached set only grows, dist only
 *  falls, rows are never removed), so `next ⊇ prev` always and this being 0 means `next ≡ prev`. One
 *  scalar; a LEFT JOIN from the next slot. */
export const changedOrNew = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
  store.query<{ d: number }>(
    `SELECT COUNT(*) AS d FROM barrier_state nx
       LEFT JOIN barrier_state pv ON pv.run = ? AND pv.round = ? AND pv.scope = nx.scope AND pv.id = nx.id AND pv.channel = nx.channel
      WHERE nx.run = ? AND nx.round = ? AND nx.channel = 0 AND (pv.cval IS NULL OR pv.cval IS NOT nx.cval)`,
    [run, prev, run, next])[0].d;

/** Count of ids whose value changed between the slots — the label algorithms' "no change" fixpoint
 *  test (`IS NOT` is null-safe distinctness). One scalar. */
export const changedCount = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
  store.query<{ d: number }>(
    `SELECT COUNT(*) AS d FROM barrier_state a JOIN barrier_state b ON a.id = b.id AND a.scope = b.scope AND a.channel = b.channel
      WHERE a.run = ? AND a.round = ? AND b.run = ? AND b.round = ? AND a.cval IS NOT b.cval`,
    [run, next, run, prev])[0].d;

// ---------- weighted shortest DISTANCE — Bellman-Ford relaxation, PAIR-KEYED by source ----------
//
// The BSP half of weighted shortestPath (docs/2026-08-23-barrier-substrate-reshape-plan.md §5). Unlike
// the three node-keyed fixpoints above, shortest path runs from EACH source traverser, so its state is
// per (source, node) — `scope` = the source vertex, `channel` 0 = the tentative distance (a REAL). This
// is the first consumer of the general `barrier_state`'s scope + channel dims. Reconstruction is NOT
// here: an edge (u,v) is on a shortest path iff dist[s][v] = dist[s][u] + w(u,v), so the path-resume
// derives the paths from this dist relation with a recursive CTE gated by that equality — no predecessor
// channel needed. Negative/custom weights are legal (the reference's `distanceEqualsNumberOfHops` split;
// GDS `BellmanFord`), so the bound is |V|-1 rounds with no Dijkstra prune.

/** A shortest-path adjacency CTE `e(src, tgt, w)` — like `adjacencyCte` but carrying each edge's WEIGHT:
 *  the `distanceKey` property (COALESCE 0) when weighted, else the constant `1` (hop distance). A
 *  `distanceKey` is a parsed literal (the user's Gremlin), so it inlines as a SQL literal — no bind (the
 *  bind rule, root CLAUDE.md). The label filter stays a `json_each` bind, prepended like `adjacencyCte`'s. */
export function shortestPathAdjacencyCte(scope: EdgeScope, distanceKey: string | undefined): { cte: string; labelBinds: string[] } {
  const w = distanceKey === undefined ? '1'
    : `COALESCE((SELECT value FROM edge_properties WHERE edge = edges.id AND key = '${distanceKey.replace(/'/g, "''")}'), 0)`;
  const labelBinds = scope.labels.length ? [JSON.stringify(scope.labels)] : [];
  const filter = scope.labels.length
    ? ' WHERE label IN (SELECT id FROM labels WHERE name IN (SELECT value FROM json_each(?)))' : '';
  const fwd = `SELECT src, tgt, ${w} AS w FROM edges${filter}`;
  const rev = `SELECT tgt AS src, src AS tgt, ${w} AS w FROM edges${filter}`;
  const body = scope.direction === 'out' ? fwd : scope.direction === 'in' ? rev : `${fwd} UNION ALL ${rev}`;
  const binds = scope.direction === 'both' ? [...labelBinds, ...labelBinds] : labelBinds;
  return { cte: `e(src, tgt, w) AS (${body})`, labelBinds: binds };
}

/** Relax shortest DISTANCE from a set of source vertices into `barrier_state` (scope = source, channel 0
 *  = dist), Bellman-Ford, entirely in SQL — reusing the two-slot `iterateInSql` driver and the sparse
 *  `changedOrNew` fixpoint. Weighted (a `distanceKey`) sums edge weights (REAL); unweighted (no key) sums
 *  hops (w=1). Seeds dist 0 at each source; each round writes the next slot with dist[s][v] = MIN(current,
 *  MIN over u→v of dist[s][u] + w(u,v)). Only REACHABLE (source, node) pairs get rows (an absent row is
 *  +∞). Returns the final slot; the dist relation stays SQL-resident for the path-reconstruction resume.
 *  Backstop |V| rounds (Bellman-Ford). */
export function relaxShortestPath(
  store: GraphStore, run: number, sourceIds: readonly number[], scope: EdgeScope, distanceKey: string | undefined,
): Slot {
  const { cte, labelBinds } = shortestPathAdjacencyCte(scope, distanceKey);
  const backstop = store.query<{ c: number }>('SELECT COUNT(*) AS c FROM nodes')[0].c;
  const seed = () => store.query(
    `${STATE_INSERT} SELECT ?, 0, s.value, s.value, 0, 0.0 FROM json_each(?) s`,
    [run, JSON.stringify(sourceIds)]);
  const step = (prev: Slot, next: Slot) => store.query(
    `WITH ${cte},
       prev AS (SELECT scope, id, cval AS d FROM barrier_state WHERE run = ? AND round = ? AND channel = 0),
       relaxed AS (SELECT scope, id, d FROM prev
                   UNION ALL SELECT prev.scope, e.tgt AS id, prev.d + e.w AS d FROM prev JOIN e ON e.src = prev.id)
     ${STATE_INSERT}
       SELECT ?, ?, scope, id, 0, MIN(d) FROM relaxed GROUP BY scope, id`,
    [...labelBinds, run, prev, run, next]);
  return iterateInSql(store, run, seed, step,
    (p, n) => changedOrNew(store, run, p, n), backstop, (d) => d === 0);
}
