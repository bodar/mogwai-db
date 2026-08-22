import type { BarrierRelation, CallParams, Service } from '../spi/types.ts';
import {
  PAGERANK_SERVICE_NAME, WCC_SERVICE_NAME, PEER_PRESSURE_SERVICE_NAME, SHORTEST_PATH_SERVICE_NAME,
} from '../spi/types.ts';
import type { GraphStore } from '../../storage.ts';
import { isTraversalParam } from '../params/call-params.ts';
import { parseGremlin, stepChain } from '../../gremlin/frontend.ts';

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

// ---------- substrate-A-iterated: an OLAP relaxation as ONE SQL statement per round ----------
//
// The compute stays in SQLite (locked decision #3): each round crosses the current `(id → v)` vector as
// ONE `json_each` bind into a relaxation that JOINS the real `nodes`/`edges` tables, reads the new
// vector, and repeats to a fixpoint. Only the O(V) vector crosses per round — the graph never enters JS
// (`docs/2026-08-21-barrier-substrate-design.md` §Axis 2, "OLAP iteration → substrate (A) ITERATED").
//
// The pure-JS `connectedComponents`/`pageRankScores`/`peerPressureClusters` below are kept as
// differential ORACLES (a test asserts the SQL rounds agree with them), not the execution path.

type Vec = ReadonlyMap<number, string | number>;

/** The current vector as the ONE json bind a round reads (`[{id, v}]`). */
const vecJson = (vec: Vec): string => JSON.stringify([...vec].map(([id, v]) => ({ id, v })));

/** A directed-adjacency CTE `e(src, tgt)` for a scope — "v's contribution flows src→tgt". `out` reads
 *  edges as-is, `in` swaps, `both` unions both directions. The label filter (if any) is ONE json_each
 *  bind; the returned `labelBinds` are prepended to the round's binds (before the vector bind). */
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

/** Drive a relaxation to a fixpoint. `round(prev)` runs ONE SQL statement (crossing `prev` as a json
 *  bind) and returns the new vector; iteration stops when `converged(prev, next)` holds or at `maxIter`.
 *  Default convergence is exact equality (label algorithms stabilise exactly); pageRank passes an
 *  ε-threshold (floats never settle to bit-equality). */
function iterateToFixpoint(
  seed: Vec, round: (prev: Vec) => Map<number, string | number>, maxIter: number,
  converged: (prev: Vec, next: Vec) => boolean = exactlyEqual,
): Map<number, string | number> {
  let cur: Map<number, string | number> = new Map(seed);
  for (let i = 0; i < maxIter; i++) {
    const next = round(cur);
    if (converged(cur, next)) return next;
    cur = next;
  }
  return cur;
}

const exactlyEqual = (prev: Vec, next: Vec): boolean => {
  if (prev.size !== next.size) return false;
  for (const [k, v] of next) if (prev.get(k) !== v) return false;
  return true;
};

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

/** A not-yet-implemented OLAP service: resolvable by name, desugared into by its native step, but
 *  fails closed with a clear deferral until its compute lands. NOT a silent decline (`null`) — that
 *  would hand the traversal on as merely uncovered; this states that the service exists and its
 *  execution is pending. `type` declares the eventual contribution shape. */
function pendingAlgoService(name: string, type: Service['type']): Service {
  return {
    name,
    type,
    internal: true,
    describeParams: () => ({}),
    resolve: () => {
      throw new Error(`${name}: graph algorithm execution is not implemented yet`);
    },
  };
}

export const shortestPathService: Service = pendingAlgoService(SHORTEST_PATH_SERVICE_NAME, 'streaming');

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
): BarrierRelation['tuples'] {
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
        apply: async (): Promise<BarrierRelation> => {
          if (!store)
            throw new Error(`${WCC_SERVICE_NAME}: no graph store is available to compute connected components`);
          const nodes = store.query<{ id: number; ext: string | number }>('SELECT id, COALESCE(uid, id) AS ext FROM nodes');
          // Seed each component to the vertex's external-id STRING; each round takes the lexicographic
          // MIN over {self} ∪ {neighbours} (the `e` CTE carries both directions for bothE). Fixpoint in
          // ≤ diameter rounds; |V| is the safe backstop.
          const seed: Vec = new Map(nodes.map((n) => [n.id, String(n.ext)]));
          const { cte, labelBinds } = adjacencyCte(scope);
          const sql = `WITH ${cte},
            vec AS (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.v') AS v FROM json_each(?)),
            adj AS (SELECT e.tgt AS id, vec.v AS v FROM e JOIN vec ON vec.id = e.src
                    UNION ALL SELECT id, v FROM vec)
            SELECT n.id AS id, MIN(adj.v) AS v FROM nodes n JOIN adj ON adj.id = n.id GROUP BY n.id`;
          const final = iterateToFixpoint(seed, (prev) =>
            new Map(store.query<{ id: number; v: string }>(sql, [...labelBinds, vecJson(prev)]).map((r) => [r.id, r.v])),
            nodes.length + 1);
          return { kind: 'relation-tuples', tuples: [...final].map(([id, value]) => ({ id, value })) };
        },
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
): BarrierRelation['tuples'] {
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
      if (site.params[PR_TIMES] !== undefined)
        throw new Error(`${PAGERANK_SERVICE_NAME}: a fixed iteration count (.with("${PR_TIMES}", …)) is not supported yet — pageRank runs to convergence (α=${PR_ALPHA_DEFAULT}, ε=${PR_EPSILON}, ≤${PR_MAX_ITERATIONS} iterations)`);
      // Default message scope is outE (rank flows along out-edges); a custom scope is honoured.
      const scope = edgeScopeOf(site.params[PR_EDGES], 'out', PAGERANK_SERVICE_NAME);
      const alpha = typeof site.params.dampingFactor === 'number' ? site.params.dampingFactor : PR_ALPHA_DEFAULT;
      const nameOverride = site.params[PR_PROPERTY_NAME];
      const key = typeof nameOverride === 'string' && nameOverride.length > 0 ? nameOverride : PR_PAGERANK_KEY;
      return {
        kind: 'barrier',
        residency: 'do',
        decorate: { key, vtype: 'double' }, // a PageRank score is a double
        apply: async (): Promise<BarrierRelation> => {
          if (!store)
            throw new Error(`${PAGERANK_SERVICE_NAME}: no graph store is available to compute PageRank`);
          const ids = store.query<{ id: number }>('SELECT id FROM nodes').map((r) => r.id);
          const N = ids.length;
          if (N === 0) return { kind: 'relation-tuples', tuples: [] };
          const { cte, labelBinds } = adjacencyCte(scope);
          // Out-degree per vertex over the scope (rank flows src→tgt); computed ONCE in SQL, read as an
          // O(V) map. Sinks (no out-edge) redistribute their rank through the global teleport.
          const outdeg = new Map<number, number>(
            store.query<{ id: number; c: number }>(`WITH ${cte} SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src`, labelBinds).map((r) => [r.id, r.c]));
          // The reported rank after the reference's first real iteration is 1/N for every vertex; the
          // teleport for the NEXT round is derived from the current vector (PageRankVertexProgram:189-203).
          const seed: Vec = new Map(ids.map((id) => [id, 1 / N]));
          // Each round: messages[v] = Σ_{u→v} α·pr[u]/outdeg[u] (in SQL, joining the real edges), plus a
          // teleport share localTerminal = teleport_k/N (teleport_k an O(V) scalar off the prev vector).
          const sql = `WITH ${cte},
            vec AS (SELECT json_extract(value,'$.id') AS id, CAST(json_extract(value,'$.v') AS REAL) AS v FROM json_each(?)),
            od AS (SELECT src AS id, COUNT(*) AS c FROM e GROUP BY src),
            msg AS (SELECT e.tgt AS id, SUM(? * vec.v / od.c) AS m FROM e JOIN vec ON vec.id = e.src JOIN od ON od.id = e.src GROUP BY e.tgt)
            SELECT n.id AS id, COALESCE(msg.m, 0) + ? AS v FROM nodes n LEFT JOIN msg ON msg.id = n.id`;
          const teleportOf = (prev: Vec): number => {
            let t = 0;
            for (const [id, v] of prev) t += (1 - alpha) * (v as number) + ((outdeg.get(id) ?? 0) === 0 ? alpha * (v as number) : 0);
            return t;
          };
          const converged = (prev: Vec, next: Vec): boolean => {
            let delta = 0;
            for (const [id, v] of next) delta += Math.abs((v as number) - (prev.get(id) as number));
            return delta < PR_EPSILON;
          };
          const final = iterateToFixpoint(seed, (prev) =>
            new Map(store.query<{ id: number; v: number }>(sql, [...labelBinds, vecJson(prev), alpha, teleportOf(prev) / N]).map((r) => [r.id, r.v])),
            PR_MAX_ITERATIONS, converged);
          return { kind: 'relation-tuples', tuples: [...final].map(([id, value]) => ({ id, value })) };
        },
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
): BarrierRelation['tuples'] {
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
        apply: async (): Promise<BarrierRelation> => {
          if (!store)
            throw new Error(`${PEER_PRESSURE_SERVICE_NAME}: no graph store is available to compute clusters`);
          const nodes = store.query<{ id: number; ext: string | number }>('SELECT id, COALESCE(uid, id) AS ext FROM nodes');
          // Seed each cluster to the vertex's external id. Each round: every vertex tallies the votes of
          // {itself} ∪ {its voters} (strength 1 each; `e` is voter→receiver) and adopts the max-total
          // cluster, ties to the smallest cluster-id STRING (CAST … AS TEXT, matching the reference's
          // .toString().compareTo). ROW_NUMBER picks the winner per vertex.
          const seed: Vec = new Map(nodes.map((n) => [n.id, n.ext]));
          const { cte, labelBinds } = adjacencyCte(scope);
          const sql = `WITH ${cte},
            vec AS (SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.v') AS v FROM json_each(?)),
            votes AS (SELECT id, v AS c FROM vec
                      UNION ALL SELECT e.tgt AS id, voter.v AS c FROM e JOIN vec voter ON voter.id = e.src),
            tally AS (SELECT id, c, COUNT(*) AS total FROM votes GROUP BY id, c),
            ranked AS (SELECT id, c, ROW_NUMBER() OVER (PARTITION BY id ORDER BY total DESC, CAST(c AS TEXT) ASC) AS rn FROM tally)
            SELECT id, c AS v FROM ranked WHERE rn = 1`;
          const final = iterateToFixpoint(seed, (prev) =>
            new Map(store.query<{ id: number; v: string | number }>(sql, [...labelBinds, vecJson(prev)]).map((r) => [r.id, r.v])),
            PP_MAX_ITERATIONS);
          return { kind: 'relation-tuples', tuples: [...final].map(([id, value]) => ({ id, value })) };
        },
      };
    },
  };
}

/** The OLAP services with NO store dependency (pending stubs). `mogwai.wcc`, `mogwai.pageRank` and
 *  `mogwai.peerPressure` are store-backed, so they are built with their `create*Service(app.store)`
 *  factories at the registry composition root (standard.ts). */
export const pendingGraphAlgorithmServices: readonly Service[] =
  [shortestPathService];
