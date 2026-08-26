# Federate pushdown — inferring what to fetch from the compiled tail (design notes)

**Status: PART-BUILT.** Landed (2026-08-26): the endpoint-id transport fix (`ENDPOINT_IDS_KEY`); the
`ContentDemand` tail classifier (phase 1); conditional endpoint fetch (phase 3); the `ForeignResult`
shape-tagged transport (elements | scalar, a `{t,v}` `ValueNode`); and **win 2a — arg-less pushdown**
(`pushableTailPrefix` + sibling synthesis from step source text). Still open: mid-traversal reduction
(split-aggregate), widening the side-effect boundary, and the `call("mogwai.inject")` marker. The
authority is the code (`src/services/catalog/federate.ts`, `src/compiler/ir/content-demand.ts`,
`src/compiler/rel/segment.ts`/`lower.ts`).

## Why this matters — federate is the escape hatch from the DO ceiling

A Durable Object is capped at **10 GB of storage** and is **single-threaded**. `federate` is not a
nice-to-have: it is how mogwai **exceeds those limits** — a graph too big for one DO, or work that would
pin one object, spreads across SIBLING graphs (one graph = one DO) and composes at query time. So the
seam has to be GENERIC and have a good developer experience: multi-agent graphs joined together, a graph
partitioned across DOs, a query that fans out and combines. That is why we push back on shoehorning and
reuse principled constructs (the OLAP keyed relation, the `{t,v}` typed envelope, the map/group shapes) —
and IMPROVE them where they are not opinionated enough — rather than bolt on per-case arms.

**Future direction (not yet designed):** injection is scalar-only today (`values(k)`/`id()`/`label()`).
The parent scope should be able to inject BIGGER things — a list, a map, eventually a whole SUBGRAPH — so
a parent can hand real context to the sibling. This is the same "data crosses as one typed value" question
the transport already answers for scalars; generalizing it is a named future slice.

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

**Hard edge (c) — identity across graphs is ALREADY namespaced STRUCTURALLY; the gap is narrow.**
Reconsidered 2026-08-26. Each `BoundGraph` is bound to a SPECIFIC CTE (`vertexBinding`/`edgeBinding`,
`boundgraph.ts:65`), and every rejoin resolves against THAT graph's relation (`cteOf` → `rowById`). So
an element from graph A is effectively `(bgv_A, id)` — **the CTE binding IS the graph qualifier**, and an
id is only ever interpreted relative to one bound relation, never globally. The substrate already
namespaces identity for the SINGLE-SOURCE case, structurally.

The gap is precise: the qualifier is STRUCTURAL (which CTE the read targets), not a VALUE carried in the
row — `externalId(_kind, id)` returns the BARE id (`boundgraph.ts:222`) and the stream carries `id` as one
column. That is correct as long as ONE stream flows through ONE `BoundGraph` (today's case). It breaks
ONLY when two bound graphs' elements share ONE stream — e.g. `federate(A).union(V(), federate(B).V())` then
`dedup()`/`has(T.id,5)`/`group().by(id)`: rows from two CTEs each carry a bare `id`, so A's `5` and B's `5`
collapse (the structural qualifier was in `ctx.source`, and a merged stream has no single source).

So (c) is NOT a wall gating all multi-graph work — it is a BOUNDED feature: **promote the structural
qualifier into the traverser at merge points.** Add an `origin` discriminator column to the bound stream,
thread it through `externalId` and the identity comparisons (`dedup`/`has(T.id)`/`group().by(id)` compare
the PAIR), and tag each side where two bound sources `union`. Per-graph CTEs already exist; what is
missing is carrying origin in the row when streams merge — a localized, measurable change to the id-carry
model, not a pervasive rewrite. It gates only the MULTI-graph mixing form (win 2b), not the single-graph
ergonomic API (win 2a) or win 1.

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
pushing an unbounded traversal we could not infer cleanly. Win 2 SPLITS (see next section): **2a**
(single-graph inferred boundary — the ergonomic API) is reachable without the identity work; **2b**
(multi-graph mixing) needs hard-edge (c)'s origin-in-row. Both are out of scope for the pushdown work
(win 1). So: **win 1 never checks whether the arg is present** (it always is); only win 2 would let an
explicit arg opt out of inference.

## Win 2a — the ergonomic arg-less API, and the `T.value` ambiguity it forces

The motivation is ergonomics: a federate call is ALWAYS followed by operations on the sibling, so
`g.call(federate, "crew").V().hasLabel("person").out().values("name")` — federate returns "the sibling
graph", keep traversing — reads far better than a serialized `traversal` string arg. This ergonomic API
IS win 2's single-graph surface: with no `traversal` arg, the compiler must INFER which steps run remote
vs local (the boundary the arg used to carry). Single-graph (no local/second-sibling mixing) does NOT hit
hard edge (c), so **2a is reachable independently of the identity work.**

**The GLV constraint shapes the whole design.** We do not modify the `gremlin` client / any GLV, so we
CANNOT introduce a new step function — that is why injection reused `T.value` (a token every GLV
serializes verbatim). But `call()` IS the extension point that needs no GLV change: `g.call("some.name",
{...})` is expressible by every unmodified client.

**The `T.value` ambiguity 2a exposes, and its clean fix.** `T.value` is legitimately a PROPERTY token
(`by(T.value)`/`order(T.value)` reading a property element's value). Injection REUSES it in a predicate-
operand position where it is otherwise meaningless (`has('sku', T.value)`) — collision-free ONLY because
the `traversal` arg draws the boundary that says "this region is the remote sub-traversal, injection
markers live here" (`injection.ts:6-8`). Remove the arg (2a) and the boundary that disambiguated is gone:
in `g.V().call(federate,"crew").has("sku", T.value)` you cannot tell whether `has` runs remotely (so
`T.value` = the parent's injected value) or locally (so `T.value` = the property token) — the SAME token
means two things depending on a boundary that no longer exists. This is a real hazard, not a nuisance.

**Fix: a self-delimiting marker via `call()`, not `T.value` reuse.** A dedicated marker CALL —
`call("mogwai.inject", {read: "name"})` (or `"mogwai.parent"`) — needs no GLV change (it is a `call()`)
AND carries its own meaning regardless of position or boundary: nobody writes that call for any other
reason, so it is unambiguous with no `traversal` arg to delimit it. `T.value` then keeps meaning ONLY the
property token, everywhere, always. This KEEPS the injection feature in the ergonomic form (rather than
"injection unsupported arg-less", which would be a real loss) and arguably reads clearer: the call NAMES
what to inject (`{read: "name"}` / id / label) in one place, instead of a positional `__.values('name')`
arg to the outer federate paired with a bare `T.value` marker elsewhere. Cost: one reserved service name
(honest — it shows in `--list`), vs `T.value`'s zero-new-registry cleverness. Worth it for 2a; the
`T.value` form stays supported for the explicit-arg (win-1) path where the boundary already disambiguates.

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

## Phase 2 — terminal-reduction pushdown, and the transport/framing generalization

**The measured facts (2026-08-26, real runs over the modern fixture):**
- `count()` → `Shape.value`, `ScalarType = static long` (type known at COMPILE time).
- `sum()/max()/min()/mean()` → `Shape.scalar`, type carried PER-ROW in a `vt` column (min/max = the
  winning row's Gremlin vtype; sum/mean = a SQLite storage class). Neither is `vertex`/`edge`, so the
  sibling `raw()` THROWS today (`execute.ts:805`, "must yield vertices or edges").
- Every reducer DECODES to a plain JS `number` (6, 123, 30.75) — no bigint at the decoded layer, so
  JSON survives mechanically.
- **The loss is SILENT TYPE ERASURE, not a throw.** A `count()` is a Gremlin **Long**; a bare JSON
  `number` cannot say Long-vs-Integer (GraphBinary keeps Int64 `0x02` vs Int32 `0x01`; JSON has one
  number type). Crossing as a raw number re-frames with the wrong Gremlin type. `program.ts`'s
  `transportable` guard would ACCEPT the number and erase the Long — the wrong outcome, confirming a
  scalar must carry its type.

**The correction already exists — reuse, no new format.** The `{t,v}` `ValueNode` envelope
(`src/gremlin/types.ts:393`) is ALREADY how federated element props cross `raw()` type-faithfully
(`propsOf` → `ForeignRow.props`), already JSON-safe (`t` a string tag, `v` a plain value), already
re-framed by ONE rule (`frameTypedNode`, `execute.ts`). A pushed-down `count()` crosses as
`{t:'long', v:6}`, not `6`. The scalar's type is known where the ValueNode is built (sibling-side in
`raw()`, where BOTH `shape` and the row `vt` are in hand — exactly where `propsOf` builds `{t,v}` today):
`long` for count (static), the `vt` column for sum/max/min/mean.

**This is federate adopting the transport/framing split OLAP already embodies — NOT a new abstraction,
and specifically NOT "everything becomes a `json_each` bind."** The barrier landscape (measured
2026-08-26) is: federate carries HOST JSON (it crossed RPC), OLAP carries a `barrier_state` HANDLE (the
vector never leaves SQL — this REPLACED an older per-round `json_each` vector bind precisely to stop
re-serializing O(V) each round, `types.ts:147`/`kernel.ts:74`), value barriers carry a `json_each` bind.
Reverting federate scalars to a universal `json_each`/JSON-number path would RE-INTRODUCE both costs OLAP
escaped (per-round serialization AND this type-erasure). The right generalization is the one OLAP shows:
**a barrier returns a typed RESULT + a SHAPE; the shape is the EXISTING `RelFraming` vocabulary
(`lowerPairResume` already emits `{kind:'map'}`, `lowerPathResume` `{kind:'path'}`), not a bespoke spec.**

**`Shape` vs `RelFraming` — settled, keep both (measured split, not duplication).** `Shape` (byte
framing, `render.ts`) answers the framer's ONE question "what bytes"; `RelFraming` (fold-internal,
`framing.ts`) answers the bigger "what does the relation HOLD, so a step can compose." They are two
PROJECTIONS of "what is this stream", neither a subset: `Shape` MERGES `elements`/`detached` (byte-
identical) which `RelFraming` SPLITS (routes `elementTail` vs `detachedTail`); `RelFraming` merges the
`jsonbList`/`jsonbSet`/`jsonbElementList` framers into one `list`. A unified crossing-vocabulary was TRIED
(`layoutOf`/`TraverserLayout`) and produced a real bug (blocked the path channel — `framing.ts:19-22`).
The actual duplication is the BESPOKE barrier specs (`DecorateSpec`/`PathSpec`/`PairSpec` — a fourth
shape vocabulary); expressing barrier output in `RelFraming` terms is the longer-horizon cleanup, not a
Phase-2 blocker.

### Phase 2 is a PREFIX/BOUNDARY split, not per-reducer special-casing (corrected 2026-08-26 vs Calcite)

The first cut special-cased a terminal reducer ("if the tail ends in `count()`, push it"). That was
WRONG — it broke `federate(t).out().dedup().count()` (pushed only `count()`, reducing the sibling's
un-walked rows → 5 not 2) and UNDER-pushed `federate(t).has('x',1).count()` (should push both). The
lesson, validated against Calcite (`vendor/calcite`, studied 2026-08-26): **pushdown is a BOUNDARY
between a remote-executable region and a local one, and the region grows UPWARD from the source.** Calcite
finds the maximal cut with a cost-based planner (a `Convention` trait per operator + a costed
boundary-crossing converter — `plan/Convention.java`, `rel/convert/ConverterRule.java`); we do NOT need
that machinery, because our cost model is degenerate: **the sibling runs the SAME engine, so pushing is
always cheaper and almost every step is pushable.** The maximal cut is therefore a simple PREFIX WALK.

**`pushableTailPrefix(tail)` — split the post-barrier tail into `[remote prefix] [local suffix]` at the
first LOCAL-DEPENDENT step** (blocklist, optimistic: push unless a step is proven local). A step is
LOCAL-DEPENDENT iff it:
1. **references a label / path position bound BEFORE the barrier** — a backtrack that reaches ACROSS the
   boundary (`g.V().as('x').call(federate,…).where(eq('x'))`). A backtrack CONTAINED in the prefix
   (`federate(…).as('a').out().where(eq('a')).count()`) is fully pushable — the sibling runs it whole.
   So the walk tracks labels BOUND within the prefix so far; a step referencing a label NOT in that set
   ends the prefix. (This is Calcite's "a converter fires only if its input is already in the remote
   convention", specialized to label scope.)
2. **is the mid-traversal INJECTION SCATTER** — the per-parent `T.value` fan-out needs the local parent
   rows. A pushed aggregate here is the SPLIT-AGGREGATE case (below), not a global one.
3. **mixes ANOTHER graph** — a nested `call(federate,…)` to a different sibling, or a local-graph read.
4. **is a WRITE / local side-effect** feeding a later local read (`aggregate('x')`/`store('x')`/`cap`,
   `MUTATING_STEPS`).

Everything else pushes: `has`/`hasLabel`, `out`/`in`/`both`, `dedup`, `order`, `limit`/`range`, the
reducers, and a SELF-CONTAINED `where`/`union`/`match`. This SUBSUMES every case and INCREASES scope:
`federate(t).out().dedup().count()` pushes the WHOLE prefix (correct AND cheaper — the sibling has the
adjacency), and `federate(t).values('name')` pushes `[values]` (Phase 4 projection falls out for free).

**Result shape follows the pushed prefix's ROOT — no scalar-vs-elements special-casing** (Calcite's
`RelToSqlConverter` rule: the pushed subtree's root type IS the RPC return type). If the prefix ends in a
reducer → `ForeignResult.scalar`; else → `ForeignResult.elements`. This is EXACTLY what the `ForeignResult`
tagged union already models — the transport work is right and general; only the DECISION (special-case →
prefix walk) changes.

**Build:**
1. `raw()` returns a shape-tagged `ForeignResult` (elements OR scalar) — DONE. A scalar crosses as a
   `{t,v}` `ValueNode` (measured facts above), re-framed by `frameTypedNode`.
2. `pushableTailPrefix(tail)` computes `{prefix, suffix}` at the boundary. The barrier appends the whole
   `prefix` to the sibling gremlin; the resume lowers only the `suffix` (`barrier.at + 1 + prefix.length`).
3. The resume frames the result by its `ForeignResult` tag: `lowerScalarResume` for a scalar (a 1-row
   `typedNode`), the element resume for elements.
4. SOURCE-form first. MID-traversal is the SPLIT-AGGREGATE slice — Calcite's `SqlSplittableAggFunction`
   (`CountSplitter`: partial `COUNT` remote + local `SUM0` combine; `AVG → SUM/COUNT` reduce-first;
   MIN/MAX self-split). A named relational pattern, not an ad-hoc worry — its own follow-up.

## Mid-traversal reduction — a MONOID transport optimization (registry landed 2026-08-26)

**Mid-traversal `.count()` ALREADY produces the right answer** (measured): the sibling runs once over the
distinct injected values, the flat element pool scatters back per parent (`foreignRejoin`, `foreign.ts`),
and the local `count()` reduces the resumed stream. So split-aggregate is NOT new capability — it is a
TRANSPORT OPTIMIZATION: cross a `(key→partial)` map instead of every element, combine locally, SAME
answer. The correctness obligation is the MONOID LAW `combine(partial(A), partial(B)) ≡ reduce(A ∪ B)`,
which is what makes "partial remote, combine local" valid — so it is gated with an L5-style differential
(optimized ≡ the element path, which is the semantic authority that already works).

**The monoid registry** (`src/compiler/ir/reducer-monoid.ts`, landed): each reducer is
`(partial, combine, identity)`, from Calcite's `SqlSplittableAggFunction` — count/sum are SUM0
(`CountSplitter`, empty→0), min/max self-split (`SelfSplitter`, absorbing identity → empty drops), mean
reduce-firsts to `(sum, count)` (`AggregateReduceFunctionsRule`). The registry is the authority; the
lowering picks the monoid by reducer name.

**Reuse decided (investigation 2026-08-26), sympathetic to existing arms:**
- **NOT `barrier_state`/`BarrierRelation`** — local-SQL-scratch by construction; federate is store-free
  `'worker'` residency. (Its correlation JOIN is a good *model* for the combine, but its source is a local
  table `Ref`, not landed JSON.)
- **NOT the `groupMap` builders** — those are the SIBLING's own lowering; the sibling already produces the
  map via `group().by(<key>).by(<partial>())`.
- **REUSE the `ValueNode` `t:'map'` arm** (`gremlin/types.ts`) — a `(key→partial)` map is a map-valued
  scalar, type-faithful both sides, and rides the EXISTING `ForeignResult.scalar` arm; `lowerScalarResume`
  already frames any `ValueNode`. **No new `ForeignResult` arm.**

**The one genuinely NEW piece — the per-parent COMBINE** (sits beside `foreignRejoin`, does not replace
it): explode the landed `(key→partial)` map, LEFT JOIN each parent to its key
(`parent.injectedValue = partial.key`), and apply the monoid — `COALESCE(partial, 0)` for SUM0
(count/sum), `WHERE partial IS NOT NULL` (drop) for the absorbing min/max, `sum/count` for mean. The
group key on the sibling is the injection read applied ELEMENT-side (`values('name')`→`by('name')`,
id→`by(id)`, label→`by(label)`), which equals what `matchValue` compares against — so the join key is the
same value the element scatter already matches on, no marker-subject extraction needed.

**Build order (each verifiable against the already-correct element path):**
1. Registry + drift guard — LANDED.
2. Gate: mid-traversal barrier + injection + tail is a bare reducer with a monoid → thread a `reduce`
   directive (the reducer + its monoid) on `CallSite.pushdown`, like 2a's synthesized gremlin.
3. `apply`: synthesize `<sub>.group().by(<elementKey>).by(<partial>())`; the sibling returns a
   `(key→partial)` map; return it as a `barrier-scalar` `t:'map'` ValueNode.
4. Resume combine: the new join-then-monoid lowering, per parent, with the identity behaviour.
5. L5 differential: the combined result ≡ the element-scatter+local-reduce result over generated
   mid-traversal reductions. The element path is the authority.

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
5. **(Win 2a — deferred, but reachable) ergonomic arg-less API** — single-graph boundary inference +
   the self-delimiting `call("mogwai.inject", …)` marker. Independent of the identity work. Not in scope
   until 1–4 measure out, but NOT gated on (c).
6. **(Win 2b — deferred) multi-graph mixing** — hard edge (c)'s origin-in-row: an `origin` discriminator
   carried in the bound stream so `dedup`/`has(T.id)`/`group().by(id)` compare `(graph, id)`. A bounded,
   measurable change (per-graph CTEs already exist), gating only multi-graph.

## Non-goals / refuted directions

- **Lazy runtime endpoint fetch** (fetch endpoints only when the tail reaches them AT RUNTIME) — breaks
  "one barrier = one await": the tail would trigger a second federate hop mid-lowering. The compile-time
  demand achieves the same "don't fetch what you don't use" WITHOUT a second round-trip, because the tail
  is statically known. Do not reintroduce laziness as the mechanism.
- **A new STEP function for injection or the ergonomic API** — forbidden by the GLV constraint (we do not
  modify any GLV). `call()` is the sanctioned extension point; a marker CALL is expressible by every
  unmodified client. This is why injection reused `T.value` and why 2a's fix is a marker call, not a step.
- **Treating cross-graph identity as an unsolved wall** — CORRECTED 2026-08-26 (hard edge (c)): identity
  is ALREADY namespaced structurally by the per-graph CTE binding; only the MERGED-stream case needs origin
  promoted into the row. Do not re-describe (c) as gating all multi-graph work — it gates only 2b's merged
  streams, and the substrate is mostly there.
