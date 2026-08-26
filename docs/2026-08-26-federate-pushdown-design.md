# Federate pushdown — inferring what to fetch from the compiled tail (design notes)

**Status: DESIGN NOTES, not a plan. Records the 2026-08-26 discussion.** Nothing here is built. The
authority is the code (`src/services/catalog/federate.ts`, `src/compiler/rel/lower.ts`'s
`detachedTail`/`lowerForeignResume`, `src/compiler/rel/boundgraph.ts`,
`src/compiler/ir/analyze.ts`'s `ChainFacts`). This is the mental model for where federate is going
AFTER the endpoint-id transport fix (`ENDPOINT_IDS_KEY`, landed 2026-08-26).

## The observation that starts it

`federate` today does **manual, explicit pushdown**: the user writes the `traversal` argument, which
hand-draws the remote/local boundary — "run *this* on the sibling, return *that*, and I'll process the
result locally." That is good: the boundary is explicit and the pushed-down plan is exactly what the
user asked to run remotely.

But we know the WHOLE query at compile time — the `traversal` arg AND the local tail after the barrier
are both in hand when `compile()` runs. So "how much do we fetch" is an **optimization problem over a
statically-known plan**, not a runtime/laziness problem. Two wins hide in that:

1. **Projection / aggregation pushdown — fetch only what the local tail consumes.**
   `federate(subgraph).count()` should fetch a scalar, not a bag of vertices nobody reads.
   `…values('name')` should fetch names, not whole elements. This is the high-value, tractable win.
2. **Boundary inference — make the explicit `traversal` arg OPTIONAL.** For a large class of queries
   (single remote graph, bounded movement) the boundary is inferable from the compiled tail, so the
   user need not draw it. This is the harder, second-order win.

## The subgraph endpoint fetch is win 1 in miniature — and shows the shape

The eager two-hop subgraph fetch (`withEndpoints`, `federate.ts`) fetches endpoint vertices WITH data
on every `.with("subgraph", true)`, so that IF the tail walks to endpoints (`inV`/`outV`/`bothV`/`.V()`)
the data is local. It is **completeness, not necessity**: `federate(subgraph).count()` or an edges-only
read fetches those vertices, materializes them as a CTE, and never reads them. The endpoint fetch
matters only in the rejoin scenario, but is paid unconditionally.

So even the endpoint fetch is a projection-pushdown question: fetch endpoints only when the tail's
demand reaches them. That is the smallest instance of the general win.

## The load-bearing insight: the demand classification ALREADY EXISTS

`detachedTail` (`lower.ts:3251-3383`) already classifies every post-barrier step by what it needs from
the fetched result — it just consults that classification AFTER the fetch (to decide how to lower),
not BEFORE (to decide what to fetch):

| tail step class | what it needs from the sibling | `detachedTail` branch |
|---|---|---|
| `count()` (global, no arg) | cardinality only — NO elements, NO adjacency | `lower.ts:3326` |
| `dedup()` (channel-less) | element identity (id) only | `lower.ts:3335` |
| `id()` / `label()` | the element token — rejoin, no movement | `lower.ts:3341` |
| `values(k…)` | those property keys | `lower.ts:3349` |
| `has`/`hasLabel`/`is` (subgraph) | the element's data (filter) | `lower.ts:3318` |
| `out`/`in`/`both`/`inV`/`outV`/`bothV` | ADJACENCY (edges) + endpoint data | `lower.ts:3296` |
| `group`/`project`/`order`/`fold`/reducers | hand off to the fold over `BoundGraph` | `lower.ts:3383` |
| writes, `properties()`/`valueMap` bag reads | out of scope / unrouted → fail closed | `BOUND_HANDOFF_DENY` |

**Pushdown = hoist this classification ahead of the barrier.** Walk `steps.slice(from)`, accumulate a
**content demand**, and let that demand shape (a) what the sibling runs and (b) what it returns. Same
analysis SHAPE as `computeDemandsEncounter` (`analyze.ts`) — a static walk over the post-`from` steps
accumulating a fact. The knowledge exists; it is consulted one phase too late.

**ONE classifier, consumed twice — this is a plan requirement, not a side effect.** The end state is a
SINGLE demand analysis that BOTH the fetch decision AND `detachedTail` read. `detachedTail` today
re-decides "what does this step need" inline, branch by branch; after pushdown it must consume the
same `ContentDemand` the fetch was shaped by, so the tail's per-step handling is the generic reader of
one fact rather than a second, independent copy of the classification. Two copies would DRIFT, and a
drift here is the silent-wrong-answer class `src/compiler/CLAUDE.md` names: if the fetch analysis says
"no adjacency needed" but `detachedTail` independently admits a movement step, the tail lowers a hop
over a subgraph whose edges were never fetched. Convergence is what makes the fetch decision and the
tail PROVABLY agree — they are the same function of the same steps. So "make `detachedTail` the generic
reader of `ContentDemand`" is an explicit deliverable (phase 1 below), not an implied cleanup.

## The seam constraint — pushdown is a COMPILE-TIME fact, not a runtime one

`apply` fetches, but `apply` **cannot see the tail**: `CallSite` (`spi/types.ts:64`) hands the service
only `params` + `federationDepth`. The post-barrier steps live downstream in the lowering
(`lowerForeignResume`), which runs AFTER `apply` has fetched. So the content demand:

- must be computed at COMPILE time from the post-barrier steps (a `ChainFact`-shaped analysis), and
- must be threaded to what the barrier fetches — either by shaping the sibling `traversal` string that
  `apply` sends, or by a fetch-shape parameter the barrier reads.

It CANNOT be a runtime decision inside `apply` (no tail visibility there), and it must not become a
second lazy round-trip (that fights the "one barrier = one await" model — see below). This is the
central architectural fact any implementation has to respect.

## A new `ChainFact`: the content demand

The missing fact is a CONTENT demand — orthogonal to the existing traverser-mechanics demands
(`tracksPath`/`demandsEncounter`/`demandsSlice`/`demandsPathLabels`, which are all about channels, not
data). Rough shape:

```
interface ContentDemand {
  reachesElements: boolean;     // does any step read an element's data at all? (count/dedup: false)
  reachesAdjacency: boolean;    // does any movement step run? → needs edges
  keys: ReadonlySet<string> | 'all';  // property keys read (values/has/by/order/project); 'all' = valueMap/elementMap/leaf
  terminalReduction: boolean;   // ends in count/sum/…: push the reduction, fetch a scalar
}
```

Computed once over `steps.slice(from)`, exactly where `chainCtxOf`/`analyzeChain` already runs
(`lower.ts:2769`). Then:

- `terminalReduction && !reachesElements` → push the reduction to the sibling; fetch a scalar. No
  vertices, no edges. (`federate(subgraph).count()` becomes a remote `…count()`.)
- `reachesAdjacency` → fetch the subgraph (edges + endpoints) as today. This is the ONLY case that
  needs `withEndpoints`, so the eager endpoint fetch becomes conditional on this bit.
- `!reachesAdjacency && keys ≠ 'all'` → fetch only `keys`, not whole element payloads.

The bright line from `src/compiler/CLAUDE.md` applies: this fact is **consulted, never constructed** —
a Pass/analysis may READ it and DECLINE on it (fall back to fetching everything, which is always
correct if wasteful), but it is not a shape representation the lowering consumes. Fetching-everything
is the safe default the demand only NARROWS; a wrong demand analysis must degrade to over-fetching, never
to a wrong answer.

## Where it stays clean, and where it doesn't (the hard edges)

**Clean — single remote graph, bounded movement.** Because element identity is an id and every read is
a rejoin-by-id (`boundgraph.ts:26-33`, the id-carry model — the same act `BaseGraph` performs against
`nodes`/`edges`), the reachable set and the keys read are STATICALLY computable. This is the case
win-1 fully covers and win-2 (optional `traversal` arg) is achievable for.

**Hard edge (a) — unbounded movement (`repeat`/`until`).** The reachable set's size/shape is not known
at compile time, so "fetch exactly these N vertices" is not available; you fetch the whole reachable
subgraph or push the `repeat` itself remote. Bounded traversals are analyzable; unbounded ones force
whole-subgraph transport or full remote execution.

**Hard edge (b) — genuine local↔remote interleaving (the multi-graph case).** `federate(A).out().where(<needs
local/graph-B data>).out()` cannot be one clean cut: it is remote → local → remote. The mixing is always
DECIPHERABLE (which step reads which graph is static, in the step, not runtime-dependent) but not always
COLLAPSIBLE to one hop. Each remote↔local transition IS a barrier, and each barrier is a round-trip —
"if I hit another barrier, that forces a second call." So even with pushdown, `g.V(ids)`-into-a-remote-graph
stays a permanent primitive for these cases — which is exactly why the endpoint-id transport fix
(bound param → `json_each`, not inline text) had to land regardless of pushdown, and why it COMPOSES:
however the id set arises (today's `withEndpoints` or a future interleaving barrier), it crosses as one
`json_each` bind.

**Hard edge (c) — identity collisions across graphs.** Graph A's vertex id `5` and graph B's vertex id
`5` are different elements, same integer. `BoundGraph` sidesteps this today because there is exactly ONE
landed graph per federate result. Multi-graph mixing needs identity to become `(graph, id)` (namespaced),
or `dedup()`/`has(T.id, 5)` conflate elements. This is the strongest reason full general auto-federation
is a bigger project than win 1: it is gated on namespaced identity, which touches the id-carry model
everywhere.

## The explicit `traversal` arg COMPOSES with pushdown — it does not disable it

The `traversal` arg is REQUIRED today (`traversalOf`, `federate.ts:42` throws if absent). It is not
optional, and win 1 does not make it optional. The two operate on DIFFERENT halves and compose:

- The `traversal` arg is **what runs remotely** — the sub-traversal. The user always writes it.
- **Pushdown (win 1)** operates on the **local tail AFTER the barrier** — how much of the fetched
  result to materialize, and whether to push a terminal reduction back. It never touches the arg.

So `federate("crew", __.V().outE("develops")).count()`: the user's sub-traversal runs remotely exactly
as written; pushdown sees the local tail is `.count()` and pushes the reduction, so the sibling runs
`…outE("develops").count()` and returns a scalar rather than a bag of edges the local `count()` would
discard. **The remote result set the user asked for is unchanged** — pushdown only NARROWS what crosses
the wire, never what the sibling computes over. A correct pushdown is semantically invisible
(`federate(t).count()` returns the same number counted locally or remotely), so there is no user control
to override, and the explicit arg does NOT gate it. Pushdown is unconditional and always safe.

The control question belongs to a DIFFERENT, later win: **boundary inference (win 2) — making the arg
optional.** THERE, the explicit arg is the ESCAPE HATCH: "I drew the boundary myself, don't infer one",
and the hard-edge (a) case `federate(A, __.repeat(out()).times(10).values('x'))` is a user manually
pushing an unbounded traversal we could not infer cleanly. But win 2 is gated behind hard edge (c)
(namespaced identity) and is out of scope for the pushdown work. So: **win 1 never checks whether the
arg is present** (it always is); only win 2 would let an explicit arg opt out of inference.

## `T.value` / mid-traversal: pushdown must be INJECTION-AWARE

The mid-traversal form (`V().call(federate, …, __.V().has('sku', T.value))`) already does INPUT-side
pushdown — the good kind: it collects the DISTINCT injected values, sends ONE sibling hop binding them
under `INJECT_VALUES_KEY`, and the sibling filters remotely (`federate.ts:119-120`, a SPARQL bound-join).
So `T.value` is not a barrier to pushdown; it is an existing instance of it, on the input side.

But it constrains OUTPUT-side (result) pushdown, and getting this wrong is a WRONG ANSWER, not a missed
optimization. A mid-traversal result is SCATTERED BACK over the parents — each returned element re-matches
the parent whose injected value it satisfies (`federate.ts:113-118`), in `lowerForeignResume`'s resume
SQL. So a terminal reduction pushed in the mid-traversal case must be a **per-parent GROUPED reduction
keyed by the injected value**, never a single global one: `V().call(federate,…,has('sku',T.value)).count()`
means "for each parent, how many sibling matches", and a global `…count()` on the sibling would collapse
all parents into one number. Therefore:

- **Source-form pushdown** (no injection): a terminal reduction pushes as a plain global reduction; fetch
  a scalar.
- **Mid-traversal pushdown** (`T.value` present): a terminal reduction pushes as a GROUPED reduction over
  the injected-value key, matching the per-parent fan-out the resume already performs.

So the `ContentDemand` analysis (phase 1) must know **whether the barrier is a mid-traversal injection
barrier**, and gate terminal-reduction pushdown to the grouped form there. This is a demand-analysis
input, not a separate mechanism — the injection kind is already on the barrier (the resume reads it).

## Phasing (rough, unbuilt)

1. **`ContentDemand` `ChainFact` + `detachedTail` reads it.** The static walk over post-barrier steps
   (consulted-not-constructed, degrades to fetch-everything), AND `detachedTail` converges onto it as the
   single classifier: its per-step branches become the generic reader of the one fact rather than a second
   independent copy. No fetch-behaviour change yet — the demand is computed and `detachedTail` consumes it,
   so the accept/decline set is provably the same as today (the L4 `@Unsupported` refusals and the census
   deferrals are the differential that proves it). This convergence is the phase, not a preamble to it.
2. **Aggregation pushdown, terminal reduction** — `federate(subgraph).count()`/reducers push the
   reduction remote, fetch a scalar. Highest value, smallest blast radius, and it dissolves the
   "materialize endpoints nobody reads" waste for the reducing case.
3. **Conditional endpoint fetch** — gate `withEndpoints` on `reachesAdjacency`, so an edges-only or
   reducing subgraph tail skips the second hop entirely.
4. **Projection pushdown** — fetch only `keys` when `!reachesAdjacency`.
5. **(Deferred) boundary inference / optional `traversal` arg** — the clean single-graph case only.
   Gated behind (c) namespaced identity for anything multi-graph. Not in scope until 1–4 measure out.

## Non-goals / refuted directions

- **Lazy runtime endpoint fetch** (fetch endpoints only when the tail reaches them AT RUNTIME) — breaks
  "one barrier = one await": the tail would trigger a second federate hop mid-lowering. The compile-time
  demand achieves the same "don't fetch what you don't use" WITHOUT a second round-trip, because the tail
  is statically known. Do not reintroduce laziness as the mechanism.
- **Multi-graph auto-federation before namespaced identity** — hard edge (c) is a real wall, not an
  optimization. A `(graph, id)` identity is a prerequisite, and the burden on proposing it is a
  measurement per `src/compiler/CLAUDE.md`, not a design sketch.
