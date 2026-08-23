import type { BarrierInput, BarrierRelation, CallParams, PathSpec, Service } from '../spi/types.ts';
import {
    PAGERANK_SERVICE_NAME, WCC_SERVICE_NAME, PEER_PRESSURE_SERVICE_NAME, SHORTEST_PATH_SERVICE_NAME,
} from '../spi/types.ts';
import type { GraphStore } from '../../storage.ts';
import { isTraversalParam } from '../params/call-params.ts';
import { parseGremlin, stepChain } from '../../gremlin/frontend.ts';
import type { IRStep } from '../../compiler/ir/step.ts';

// ---------- the OLAP edge scope (~tinkerpop.<algo>.edges) ----------
//
// An algorithm's message scope: which edges relate two vertices, and in which direction rank/labels
// flow. The reference default is `outE` for pageRank (rank flows along out-edges) and `bothE` for
// connectedComponent (undirected). A custom scope arrives as an ANONYMOUS edge sub-traversal
// (`__.outE("knows")`, `__.inE("created")`, `__.bothE()`) carried as a TraversalParam (the serializer
// no longer refuses anonymous — see services/params/traversal-param.ts). We read it to a
// `{direction, labels}` descriptor and build the adjacency with ONE store query.

/** `out`: rank/label flows src→tgt. `in`: tgt→src. `both`: both. */
type EdgeScope = { readonly direction: 'out' | 'in' | 'both'; readonly labels: readonly string[] };

/** Parse an edges-scope param into `{direction, labels}`. `undefined` → the algorithm's default
 *  direction, all labels. A `Direction` enum token (`{direction:'in'}`) is accepted too. Anything
 *  richer than a single `outE`/`inE`/`bothE(labels?)` fails closed — never a silent wrong scope. */
function edgeScopeOf(value: unknown, defaultDir: EdgeScope['direction'], algo: string): EdgeScope {
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
// bind, which crossed the whole vector both per round and again into the decorate binding.
//
// The pure-JS `connectedComponents`/`pageRankScores`/`peerPressureClusters` below are kept as
// differential ORACLES (a test asserts the SQL rounds agree with them), not the execution path.

/** One `(id → value)` tuple — the shape the JS oracles return (the SQL path keeps the vector in the
 *  `barrier_state` table and never builds this array). */
export type IdValue = { readonly id: number; readonly value: unknown };

/** A directed-adjacency CTE `e(src, tgt)` for a scope — "v's contribution flows src→tgt". `out` reads
 *  edges as-is, `in` swaps, `both` unions both directions. The label filter (if any) is ONE json_each
 *  bind; the returned `labelBinds` are prepended to a statement's binds (before the run/round binds).
 *  A statement embedding `${cte}` once takes one copy of `labelBinds`. */
function adjacencyCte(scope: EdgeScope): { cte: string; labelBinds: string[] } {
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
const STATE_INSERT = 'INSERT INTO barrier_state(run, round, scope, id, channel, cval)';
/** The prior-slot vector, node-keyed single channel — the read half all three algorithms share. Binds:
 *  `run, round`. Pins `scope = 0 AND channel = 0` so it stays correct once a run holds other channels. */
const VEC = 'vec AS (SELECT id, cval AS v FROM barrier_state WHERE run = ? AND round = ? AND scope = 0 AND channel = 0)';

/** A round `slot` in `barrier_state` — the vector alternates between two slots so a run holds at
 *  most two vectors, cur and next. */
type Slot = 0 | 1;

/** Wrap an OLAP barrier's SYNCHRONOUS core into the `{apply, applySync}` a barrier contribution declares.
 *  `apply` (async) is the PRODUCTION path — it can yield so a large compute does not busy-lock the DO;
 *  `applySync` is the SAME core for the sync/test drive (`framed()`/census), where busy-locking is fine.
 *  Exact because the OLAP computes are pure in-SQL loops with no real await (`src/services/spi/types.ts`). */
function syncBarrier(core: (rows: readonly BarrierInput[]) => BarrierRelation): {
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
function iterateInSql(
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
const sumAbsDelta = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
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
const changedOrNew = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
  store.query<{ d: number }>(
    `SELECT COUNT(*) AS d FROM barrier_state nx
       LEFT JOIN barrier_state pv ON pv.run = ? AND pv.round = ? AND pv.scope = nx.scope AND pv.id = nx.id AND pv.channel = nx.channel
      WHERE nx.run = ? AND nx.round = ? AND nx.channel = 0 AND (pv.cval IS NULL OR pv.cval IS NOT nx.cval)`,
    [run, prev, run, next])[0].d;

/** Count of ids whose value changed between the slots — the label algorithms' "no change" fixpoint
 *  test (`IS NOT` is null-safe distinctness). One scalar. */
const changedCount = (store: GraphStore, run: number, prev: Slot, next: Slot): number =>
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
function shortestPathAdjacencyCte(scope: EdgeScope, distanceKey: string | undefined): { cte: string; labelBinds: string[] } {
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

// ---------- mogwai.pageRank / .wcc / .peerPressure / .shortestPath — the OLAP algorithm layer ----------
//
// The four canonical TinkerPop OLAP steps (pageRank/connectedComponent/peerPressure/shortestPath)
// desugar to a call() on one of these services (ir/strategies.ts `desugarGraphAlgos`); a GDS-style
// `g.call("mogwai.pageRank", …)` reaches the same service directly. One implementation, two
// front-ends (`docs/2026-07-24-graph-algorithms-plan.md`, principle #2).
//
// All four are INTERNAL (`internal: true`): they back native TinkerPop steps, so a reference-exact
// conformance host must serve them, yet they are not part of the reference provider surface the
// official `--list`/`g_call` scenarios assert — so they are registered in BOTH registries and
// enumerated by neither, exactly as `mogwai.io` is (services/catalog/io.ts, standard.ts).

// ---------- mogwai.shortestPath — shortestPath(), a recursive-CTE path walk (Template B) ----------
//
// `g.V().shortestPath()` emits, from each incoming source vertex, its shortest path(s) to every
// reachable target. Unlike the three DECORATE algorithms it is NOT a barrier: an unweighted all-pairs
// shortest path is one recursive `Recursive` term (P1/P2), so it is a PURE `rel` contribution lowered
// inline (`src/compiler/rel/shortestpath.ts`, `docs/2026-07-24-graph-algorithms-plan.md` Template B).
// This service parses the `~tinkerpop.shortestPath.*` config and hands the compiler builder the incoming
// element relation via `site.stream`; the builder produces the PATH-framed result.
//
// This tranche implements the UNWEIGHTED family: the default `bothE` scope and the `.edges` direction
// override (`Direction.IN`/`__.outE()`/`__.bothE()`), `.includeEdges`, and the unweighted `.maxDistance`
// hop cap. A label-scoped `.edges`, a `.target` filter and a weighted `.distance` fail CLOSED with a
// clear deferral until their increments land — never a mis-execution.

const SP_EDGES = '~tinkerpop.shortestPath.edges';
const SP_INCLUDE_EDGES = '~tinkerpop.shortestPath.includeEdges';
const SP_TARGET = '~tinkerpop.shortestPath.target';
const SP_DISTANCE = '~tinkerpop.shortestPath.distance';
const SP_MAX_DISTANCE = '~tinkerpop.shortestPath.maxDistance';

/** Parse a `~tinkerpop.shortestPath.target` value — an anonymous vertex traversal used as an ENDPOINT
 *  predicate — to its body IR (the steps after the source root), or `undefined` when no target is set.
 *  Same read as `edgeScopeOf`: a `TraversalParam` carries the serialized gremlin; our parser roots at a
 *  source, so an anonymous body is prepended one and the source step dropped. */
function targetBody(value: unknown): readonly IRStep[] | undefined {
  if (value === undefined) return undefined;
  const gremlin = isTraversalParam(value) ? value.gremlin : typeof value === 'string' ? value : null;
  if (gremlin === null)
    throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: target must be an anonymous vertex traversal, got ${String(value)}`);
  const rooted = gremlin.startsWith('__.') ? 'g.V().' + gremlin.slice(3) : gremlin;
  try { return stepChain(parseGremlin(rooted), {}).filter((s) => s.name !== 'V' && s.name !== 'E'); }
  catch { throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: could not read the target "${gremlin}"`); }
}

/** shortestPath() — ONE substrate: a BSP relaxation BARRIER for BOTH weighted and unweighted searches.
 *  `apply` relaxes the shortest distance from the incoming source vertices into `barrier_state`
 *  (`relaxShortestPath`, scope = source, channel 0 — weighted sums edge weights, unweighted sums hops) and
 *  returns the `(run, round)` handle; the resume (`lowerPathResume`) reconstructs the shortest paths from
 *  that relation, walking only shortest-path edges (`dist[s][v] = dist[s][u] + w`). This REPLACES the
 *  recursive-CTE walk, whose enumerate-then-MIN is exponential and hangs on a dense graph even unweighted
 *  (a min-distance relaxation is an aggregate a recursive term forbids — P3 / repeat-two-regimes §1a). The
 *  compute is a synchronous in-SQL core (`syncBarrier`): `apply` yields in production, `applySync` drives
 *  the sync/census path. */
export function createShortestPathService(store: GraphStore | undefined): Service {
  return {
    name: SHORTEST_PATH_SERVICE_NAME,
    type: 'streaming',
    internal: true,
    describeParams: () => ({
      edges: 'the message scope — a Direction or an anonymous edge traversal (default bothE)',
      includeEdges: 'interleave the traversed edges in the path',
      distance: 'a weight property key — makes the search weighted (least edge-weight sum)',
      maxDistance: 'a hop cap (unweighted) or a final weight cap (weighted)',
    }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'path')
        throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: only the native shortestPath() (path mode) is implemented yet, not "${String(mode)}"`);
      const scope = edgeScopeOf(site.params[SP_EDGES], 'both', SHORTEST_PATH_SERVICE_NAME);
      const includeEdges = SP_INCLUDE_EDGES in site.params;
      const target = targetBody(site.params[SP_TARGET]);
      const distanceKey = site.params[SP_DISTANCE];
      if (distanceKey !== undefined && typeof distanceKey !== 'string')
        throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: distance must be a weight property name, got ${String(distanceKey)}`);
      // maxDistance caps the FINAL shortest distance per pair — a hop cap (integer) unweighted, a weight
      // cap (any number) weighted. Applied at reconstruction, not as a walk prune (a weight may be negative).
      let maxWeight: number | undefined;
      if (SP_MAX_DISTANCE in site.params) {
        const md = site.params[SP_MAX_DISTANCE];
        if (typeof md !== 'number')
          throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: maxDistance must be a number, got ${String(md)}`);
        if (distanceKey === undefined && !Number.isInteger(md))
          throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: an unweighted maxDistance must be an integer hop count, got ${md}`);
        maxWeight = md;
      }
      const path: PathSpec = { direction: scope.direction, labels: scope.labels, includeEdges, distanceKey, maxWeight, target };
      return {
        kind: 'barrier', residency: 'do', path,
        ...syncBarrier((rows): BarrierRelation => {
          if (!store)
            throw new Error(`${SHORTEST_PATH_SERVICE_NAME}: no graph store is available to compute shortest paths`);
          // The sources are the incoming traverser vertices (the head projected their ids), deduped.
          const sourceIds = [...new Set(rows.map((r) => Number(r.injectedValue)))];
          const run = store.allocBarrierRun();
          const round = relaxShortestPath(store, run, sourceIds, scope, distanceKey);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}

// ---------- mogwai.wcc — connectedComponent(), a DECORATE barrier ----------
//
// `g.V().connectedComponent()` decorates each vertex with its connected-component id under
// `gremlin.connectedComponentVertexProgram.component` and passes it through. The component id is the
// LEXICOGRAPHICALLY-smallest external id STRING in the vertex's component, over the UNDIRECTED graph
// (the reference's default message scope `__.bothE()`) — see
// `vendor/tinkerpop/gremlin-core/.../clustering/connected/ConnectedComponentVertexProgram.java:122,142`
// (`vertex.id().toString()` seed; `candidateComponent.compareTo(currentComponent) < 0` propagation).
//
// It is an ASYNC DECORATE barrier: the compute is GLOBAL (reads the whole graph inside `apply`,
// residency `'do'` — it must run beside the store), and its product is an `(id → component)` relation,
// not detached rows. The segment's decorate resume (compiler/rel/segment.ts, `lowerDecorateResume`)
// keeps the element stream LIVE and reads the component as a synthetic property under the key, so
// `has(key)`/`order().by(key)`/`project().by(key)` compose. `apply` reading the edge list and computing
// components with union-find is NOT row-at-a-time traversal interpretation — it is one bulk SQL read of
// the data plus a bounded in-JS graph computation, the barrier model (`docs/2026-08-21-barrier-substrate-design.md`).

const CC_COMPONENT_KEY = 'gremlin.connectedComponentVertexProgram.component';
const CC_PROPERTY_NAME = '~tinkerpop.connectedComponent.propertyName';
const CC_EDGES = '~tinkerpop.connectedComponent.edges';

/** The decorated key: the `~tinkerpop.connectedComponent.propertyName` override, else the canonical
 *  reference key. */
function componentKey(params: CallParams): string {
  const name = params[CC_PROPERTY_NAME];
  return typeof name === 'string' && name.length > 0 ? name : CC_COMPONENT_KEY;
}

/** Weakly-connected components by union-find over the (undirected) edge list, labelling each component
 *  with the lexicographically-smallest external-id string among its members — the reference's exact
 *  `id().toString()`/string-`compareTo` rule. Returns one `(rowid → component)` tuple per vertex. */
export function connectedComponents(
  nodes: readonly { readonly id: number; readonly ext: string | number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
): readonly IdValue[] {
  const parent = new Map<number, number>();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression, so a large component's repeated finds stay near-constant.
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  for (const e of edges) {
    // An edge to a vertex not in `nodes` cannot arise (FK), but guard so a bad row cannot NaN the map.
    if (!parent.has(e.src) || !parent.has(e.tgt)) continue;
    parent.set(find(e.src), find(e.tgt));
  }
  // Component label = the lexicographically-smallest external-id STRING among the component's members.
  const label = new Map<number, string>();
  for (const n of nodes) {
    const root = find(n.id);
    const s = String(n.ext);
    const cur = label.get(root);
    if (cur === undefined || s < cur) label.set(root, s);
  }
  return nodes.map((n) => ({ id: n.id, value: label.get(find(n.id))! }));
}

/** connectedComponent() over a store: an async DECORATE barrier computing WCC globally. The store is
 *  captured at construction (app-scope DI, like federate/io); a compile-only scope has none, but a
 *  DECORATE barrier is `'do'` residency and its `apply` runs only where the store exists. */
export function createWccService(store: GraphStore | undefined): Service {
  return {
    name: WCC_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the component id under (default ${CC_COMPONENT_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${WCC_SERVICE_NAME}: only decorate mode (the native connectedComponent() step) is implemented yet, not "${String(mode)}"`);
      // connectedComponent is UNDIRECTED (default bothE); union-find is symmetric, so a `both` scope is
      // exactly right and a directional (out/in) scope is a different, directional min-propagation we do
      // not model yet — fail closed rather than answer the undirected question for a directed scope.
      const scope = edgeScopeOf(site.params[CC_EDGES], 'both', WCC_SERVICE_NAME);
      if (scope.direction !== 'both')
        throw new Error(`${WCC_SERVICE_NAME}: only an undirected (bothE) edge scope is supported yet, not ${scope.direction}E`);
      const key = componentKey(site.params);
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key, vtype: 'string' }, // a component id is the min external-id STRING
        ...syncBarrier((): BarrierRelation => {
          if (!store)
            throw new Error(`${WCC_SERVICE_NAME}: no graph store is available to compute connected components`);
          const run = store.allocBarrierRun();
          const { cte, labelBinds } = adjacencyCte(scope);
          // Seed each component to the vertex's external-id STRING (stored in `cval`, in SQL). Each
          // round takes the lexicographic MIN over {self} ∪ {neighbours} (the `e` CTE carries both
          // directions for bothE), writing the next slot. Fixpoint in ≤ diameter rounds; |V|+1 is the
          // safe backstop — one scalar COUNT, not the vertex vector.
          const backstop = store.query<{ c: number }>('SELECT COUNT(*) AS c FROM nodes')[0].c + 1;
          const seed = () => store.query(
            `${STATE_INSERT} SELECT ?, 0, 0, id, 0, CAST(COALESCE(uid, id) AS TEXT) FROM nodes`,
            [run]);
          const step = (prev: Slot, next: Slot) => store.query(
            `WITH ${cte},
               ${VEC},
               adj AS (SELECT e.tgt AS id, vec.v AS v FROM e JOIN vec ON vec.id = e.src
                       UNION ALL SELECT id, v FROM vec)
             ${STATE_INSERT}
               SELECT ?, ?, 0, n.id, 0, MIN(adj.v) FROM nodes n JOIN adj ON adj.id = n.id GROUP BY n.id`,
            [...labelBinds, run, prev, run, next]);
          const round = iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), backstop, (d) => d === 0);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}

// ---------- mogwai.pageRank — pageRank(), a DECORATE barrier ----------
//
// `g.V().pageRank()` decorates each vertex with its PageRank under
// `gremlin.pageRankVertexProgram.pageRank` and passes it through. It is a faithful replay of the
// reference BSP (`vendor/tinkerpop/gremlin-core/.../ranking/pagerank/PageRankVertexProgram.java:162-212`),
// including dangling-node redistribution via the global teleportation energy — a host-driven iteration
// inside `apply` (the barrier model), not row-at-a-time interpretation. Default message scope is `outE`
// (rank flows along out-edges; a sink's rank redistributes through teleport), α=0.85, ε=1e-5, ≤20 iters.
//
// This tranche implements the DEFAULT scope only. A custom edge scope
// (`~tinkerpop.pageRank.edges`), an explicit iteration count (`~tinkerpop.pageRank.times`), and reading
// the score through values()/valueMap()/math() land with the edge-config + numeric-read substrate;
// order().by(propertyName)/has(propertyName)/project().by(propertyName-as-string) compose today.

const PR_PAGERANK_KEY = 'gremlin.pageRankVertexProgram.pageRank';
const PR_PROPERTY_NAME = '~tinkerpop.pageRank.propertyName';
const PR_EDGES = '~tinkerpop.pageRank.edges';
const PR_TIMES = '~tinkerpop.pageRank.times';
const PR_ALPHA_DEFAULT = 0.85;
const PR_EPSILON = 0.00001;
const PR_MAX_ITERATIONS = 20;

/** PageRank over the default `outE` scope, a faithful replay of the reference BSP. `alpha` is the
 *  damping factor (`pageRank(α)`); dangling vertices (out-degree 0) redistribute their rank through the
 *  global teleportation energy, exactly as `PageRankVertexProgram` does — which is what makes the modern
 *  graph's sinks (vadas/lop/ripple) rank correctly. Returns one `(rowid → score)` tuple per vertex. */
export function pageRankScores(
  nodes: readonly { readonly id: number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
  alpha: number,
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return [];
  const out = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.src)?.push(e.tgt);
  const outdeg = new Map<number, number>(ids.map((id) => [id, out.get(id)!.length]));
  const pr = new Map<number, number>(ids.map((id) => [id, 0])); // the reported property (orElse 0)
  let messages = new Map<number, number>(ids.map((id) => [id, 0]));
  let teleport = 1.0; // TELEPORTATION_ENERGY seed (no initialRankTraversal)
  for (let k = 1; k <= PR_MAX_ITERATIONS; k++) {
    const teleportK = teleport;
    const localTerminal = teleportK > 0 ? teleportK / N : 0;
    const nextMessages = new Map<number, number>(ids.map((id) => [id, 0]));
    let nextTeleport = 0; // net of the reference's -localTerminal (×N = -teleportK) + (1-α)pr + dangling
    let convergence = 0;
    for (const id of ids) {
      // iter 1 seeds from teleport only (initial rank 0); later iters sum incoming messages.
      let rank = (k === 1 ? 0 : messages.get(id)!) + (teleportK > 0 ? localTerminal : 0);
      convergence += Math.abs(rank - pr.get(id)!);
      pr.set(id, rank);
      nextTeleport += (1 - alpha) * rank;
      const send = alpha * rank;
      const od = outdeg.get(id)!;
      if (od > 0) { const share = send / od; for (const t of out.get(id)!) nextMessages.set(t, nextMessages.get(t)! + share); }
      else nextTeleport += send; // a sink redistributes its rank through teleport (dangling nodes)
    }
    teleport = nextTeleport;
    messages = nextMessages;
    if (convergence < PR_EPSILON) break;
  }
  return ids.map((id) => ({ id, value: pr.get(id)! }));
}

/** pageRank() over a store: an async DECORATE barrier. The store is captured at construction (app-scope
 *  DI); `apply` reads the graph and replays the reference BSP. */
export function createPageRankService(store: GraphStore | undefined): Service {
  return {
    name: PAGERANK_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the rank under (default ${PR_PAGERANK_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${PAGERANK_SERVICE_NAME}: only decorate mode (the native pageRank() step) is implemented yet, not "${String(mode)}"`);
      // Default message scope is outE (rank flows along out-edges); a custom scope is honoured.
      const scope = edgeScopeOf(site.params[PR_EDGES], 'out', PAGERANK_SERVICE_NAME);
      const alpha = typeof site.params.dampingFactor === 'number' ? site.params.dampingFactor : PR_ALPHA_DEFAULT;
      // `~tinkerpop.pageRank.times` caps the PROPAGATION rounds (VertexProgramStep sets maxIterations =
      // times + 1; the reference's iteration 1 is the seed, so `times` is the number of propagation
      // rounds after it). Absent → run to ε-convergence, ≤ PR_MAX_ITERATIONS.
      const timesParam = site.params[PR_TIMES];
      const times = typeof timesParam === 'number' && Number.isInteger(timesParam) ? timesParam : undefined;
      const nameOverride = site.params[PR_PROPERTY_NAME];
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : PR_PAGERANK_KEY;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key, vtype: 'double', seedFromInput: true }, // a PageRank score is a double; initial rank = incoming count
        ...syncBarrier((rows): BarrierRelation => {
          if (!store)
            throw new Error(`${PAGERANK_SERVICE_NAME}: no graph store is available to compute PageRank`);
          const run = store.allocBarrierRun();
          const N = store.query<{ c: number }>('SELECT COUNT(*) AS c FROM nodes')[0].c; // one scalar, not the vertex set
          if (N === 0) return { kind: 'relation-ref', run, round: 0 }; // nothing seeded → empty relation
          const { cte, labelBinds } = adjacencyCte(scope);
          // SEED slot 0, in SQL. A bare source → the uniform 1/N rank. A non-bare prefix hands us its
          // incoming per-vertex traverser count (`rows`, one per traverser carrying the EXTERNAL id) —
          // TinkerPop's HaltedTraversersCount — which cross as ONE json bind (O(input traversers), the
          // input that already crossed the boundary), matched to internal ids and counted per vertex.
          // Both then iterate the SAME relaxation; only the seed differs (PageRankVertexProgram:164,181-183).
          const seed = rows.length > 0
            ? () => store.query(
                `${STATE_INSERT}
                   SELECT ?, 0, 0, n.id, 0, COUNT(j.value) FROM nodes n
                     LEFT JOIN json_each(?) j ON CAST(COALESCE(n.uid, n.id) AS TEXT) = CAST(j.value AS TEXT)
                   GROUP BY n.id`,
                [run, JSON.stringify(rows.map((r) => r.injectedValue))])
            : () => store.query(
                `${STATE_INSERT} SELECT ?, 0, 0, id, 0, 1.0 / ? FROM nodes`,
                [run, N]);
          // TELEPORTATION ENERGY off the prev slot — one scalar: Σ (1−α)·rank over all vertices, plus
          // α·rank for the DANGLING ones (out-degree 0 sinks redistribute their whole rank). Then each
          // round: messages[v] = Σ_{u→v} α·pr[u]/outdeg[u] (in SQL, joining the real edges) plus the
          // teleport share localTerminal = teleport/N, written to the next slot.
          const teleportOf = (prev: Slot): number => store.query<{ t: number }>(
            `WITH ${cte}, od AS (SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src),
               ${VEC}
             SELECT COALESCE(SUM((1 - ?) * vec.v + CASE WHEN od.c IS NULL THEN ? * vec.v ELSE 0 END), 0) AS t
               FROM vec LEFT JOIN od ON od.id = vec.id`,
            [...labelBinds, run, prev, alpha, alpha])[0].t;
          const step = (prev: Slot, next: Slot) => {
            const localTerminal = teleportOf(prev) / N;
            store.query(
              `WITH ${cte}, od AS (SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src),
                 ${VEC},
                 msg AS (SELECT e.tgt AS id, SUM(? * vec.v / od.c) AS m
                           FROM e JOIN vec ON vec.id = e.src JOIN od ON od.id = e.src GROUP BY e.tgt)
               ${STATE_INSERT}
                 SELECT ?, ?, 0, n.id, 0, COALESCE(msg.m, 0) + ? FROM nodes n LEFT JOIN msg ON msg.id = n.id`,
              [...labelBinds, run, prev, alpha, run, next, localTerminal]);
          };
          // `times` caps propagation rounds exactly (no ε short-circuit — times=0 means output the seed
          // as-is; times=1 means one round); default runs to ε-convergence within PR_MAX_ITERATIONS.
          const maxRounds = times ?? PR_MAX_ITERATIONS;
          const stop = times !== undefined ? () => false : (d: number) => d < PR_EPSILON;
          const round = iterateInSql(store, run, seed, step,
            (p, n) => sumAbsDelta(store, run, p, n), maxRounds, stop);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}

// ---------- mogwai.peerPressure — peerPressure(), a DECORATE barrier ----------
//
// `g.V().peerPressure()` decorates each vertex with its cluster id under
// `gremlin.peerPressureVertexProgram.cluster` and passes it through. The cluster is a vertex id,
// assigned by peer-pressure label propagation: each vertex adopts the cluster held by the greatest
// total vote among itself + its in-neighbours (default `outE` scope, vote strength 1.0), ties broken by
// the lexicographically-smallest cluster-id STRING, iterated to a fixpoint (≤30 rounds). See
// `vendor/tinkerpop/gremlin-core/.../clustering/peerpressure/PeerPressureVertexProgram.java:150-172`
// (`vertex.id()` seed; `largestCount` majority with a `.toString().compareTo` tie-break).

const PP_CLUSTER_KEY = 'gremlin.peerPressureVertexProgram.cluster';
const PP_PROPERTY_NAME = '~tinkerpop.peerPressure.propertyName';
const PP_EDGES = '~tinkerpop.peerPressure.edges';
const PP_MAX_ITERATIONS = 30;

/** Peer-pressure clustering: each vertex adopts the max-vote cluster among {itself} ∪ {voters}, ties to
 *  the smallest id string, to a fixpoint. `edges` are directed voter→receiver pairs (the scope); a
 *  vertex's voters are the sources that point AT it. Returns one `(rowid → cluster)` tuple per vertex;
 *  the cluster VALUE is the vertex's external id. */
export function peerPressureClusters(
  nodes: readonly { readonly id: number; readonly ext: string | number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const ext = new Map<number, string | number>(nodes.map((n) => [n.id, n.ext]));
  const voters = new Map<number, number[]>(ids.map((id) => [id, []])); // receiver -> [voter…]
  for (const e of edges) voters.get(e.tgt)?.push(e.src);
  let cluster = new Map<number, string | number>(ids.map((id) => [id, ext.get(id)!])); // seed: own external id
  for (let round = 0; round < PP_MAX_ITERATIONS; round++) {
    const next = new Map<number, string | number>();
    let changed = false;
    for (const id of ids) {
      const votes = new Map<string | number, number>();
      votes.set(cluster.get(id)!, 1); // the vertex's own vote (strength 1.0)
      for (const u of voters.get(id)!) {
        const c = cluster.get(u)!;
        votes.set(c, (votes.get(c) ?? 0) + 1);
      }
      // largestCount: max total vote; on a TIE, the lexicographically-smallest cluster-id string.
      let best: string | number = cluster.get(id)!;
      let bestVote = -1;
      for (const [c, v] of votes) {
        if (v > bestVote || (v === bestVote && String(c) < String(best))) { best = c; bestVote = v; }
      }
      next.set(id, best);
      if (best !== cluster.get(id)) changed = true;
    }
    cluster = next;
    if (!changed) break;
  }
  return ids.map((id) => ({ id, value: cluster.get(id)! }));
}

/** peerPressure() over a store: an async DECORATE barrier. */
export function createPeerPressureService(store: GraphStore | undefined): Service {
  return {
    name: PEER_PRESSURE_SERVICE_NAME,
    type: 'barrier',
    internal: true,
    describeParams: () => ({ propertyName: `the vertex property key to write the cluster id under (default ${PP_CLUSTER_KEY})` }),
    resolve: (site) => {
      const mode = site.params.mode;
      if (mode !== undefined && mode !== 'decorate')
        throw new Error(`${PEER_PRESSURE_SERVICE_NAME}: only decorate mode (the native peerPressure() step) is implemented yet, not "${String(mode)}"`);
      const scope = edgeScopeOf(site.params[PP_EDGES], 'out', PEER_PRESSURE_SERVICE_NAME);
      const nameOverride = site.params[PP_PROPERTY_NAME];
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : PP_CLUSTER_KEY;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key, vtype: 'int' }, // a cluster id is a vertex id (integer rowid, modern graph)
        ...syncBarrier((): BarrierRelation => {
          if (!store)
            throw new Error(`${PEER_PRESSURE_SERVICE_NAME}: no graph store is available to compute clusters`);
          const run = store.allocBarrierRun();
          const { cte, labelBinds } = adjacencyCte(scope);
          // Seed each cluster to the vertex's external id (in `cval`, in SQL). Each round: every vertex
          // tallies the votes of {itself} ∪ {its voters} (strength 1 each; `e` is voter→receiver) and
          // adopts the max-total cluster, ties to the smallest cluster-id STRING (CAST … AS TEXT,
          // matching the reference's .toString().compareTo). ROW_NUMBER picks the winner per vertex,
          // written to the next slot.
          const seed = () => store.query(
            `${STATE_INSERT} SELECT ?, 0, 0, id, 0, COALESCE(uid, id) FROM nodes`,
            [run]);
          const step = (prev: Slot, next: Slot) => store.query(
            `WITH ${cte},
               ${VEC},
               votes AS (SELECT id, v AS c FROM vec
                         UNION ALL SELECT e.tgt AS id, voter.v AS c FROM e JOIN vec voter ON voter.id = e.src),
               tally AS (SELECT id, c, COUNT(*) AS total FROM votes GROUP BY id, c),
               ranked AS (SELECT id, c, ROW_NUMBER() OVER (PARTITION BY id ORDER BY total DESC, CAST(c AS TEXT) ASC) AS rn FROM tally)
             ${STATE_INSERT}
               SELECT ?, ?, 0, id, 0, c FROM ranked WHERE rn = 1`,
            [...labelBinds, run, prev, run, next]);
          const round = iterateInSql(store, run, seed, step,
            (p, n) => changedCount(store, run, p, n), PP_MAX_ITERATIONS, (d) => d === 0);
          return { kind: 'relation-ref', run, round };
        }),
      };
    },
  };
}

