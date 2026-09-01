# Federate — cross-graph query, and pushing the boundary onto the compiled tail

_Current-state design notes. This is not a changelog — it records what federate IS and what is left to
build. The authority is the code (`src/services/catalog/federate.ts`, `src/compiler/rel/segment.ts`,
`src/compiler/ir/content-demand.ts`, `src/compiler/ir/reducers.ts`, `src/execute.ts`'s `runForeign`)._

## Why federate matters — the escape hatch from the DO ceiling

A Durable Object is capped at **10 GB of storage** and is **single-threaded**. `federate` is how mogwai
EXCEEDS those limits: a graph too big for one DO, or work that would pin one object, spreads across
SIBLING graphs (one graph = one DO) and composes at query time — multi-agent graphs joined together, a
graph partitioned across DOs, a query that fans out and combines. So it goes right to the heart of the
computation loop, and it is worth touching the core engine for. The seam has to be GENERIC and have a
good developer experience; we reuse principled constructs (the OLAP keyed relation, the `{t,v}` typed
envelope, the map/group shapes) and improve them where they are not opinionated enough, rather than bolt
on per-case arms.

## The two forms, and the one boundary decision

A federate call has a chain after it. The compiler decides, in ONE place (`barrierIn`,
`src/compiler/rel/segment.ts`), what runs on the sibling (the SUB-TRAVERSAL) and what runs locally
(the SUFFIX). Two forms feed that decision and are handled identically downstream:

- **Explicit** — the user writes the boundary: `call("federate", [graph, traversal: __.V()…])`. The
  `traversal` param carries the sub-traversal.
- **Arg-less** — `call("federate", [graph]).V()…`, no `traversal` arg. Pushdown INFERS the boundary:
  `pushableTailPrefix` finds the longest remote-safe prefix of the tail, and THAT prefix is the
  sub-traversal.

Both hand `barrierIn` a sub-traversal as **`IRStep[]`** (never a string — see "Representation" below).
The injection read, the mid-vs-source routing, the head projection and the scatter all read those steps,
so the arg-less form is not a parallel branch: `inferredPushdown` returns the pushed prefix's marker read,
and `barrierIn` folds it onto an EFFECTIVE `CallSpec`'s `injectionTraversal`, after which every reader
sees the same fact whichever form produced it.

## Representation — a sub-traversal is `IRStep[]`, a string ONLY at the RPC edge

A `call()` sub-traversal (federate's `traversal`, an OLAP `edges` scope, shortestPath's `target`) is
carried as parsed `IRStep[]` on the `CallSpec`. The grammar always delivers a nested traversal; a raw
string never genuinely arrives. The ONE place it becomes a string is federate's RPC edge (`runForeign`
crosses to another DO), synthesized verbatim from the steps' own source text
(`subTraversalToGremlin(steps)` = `'g.'+steps.map(s=>s.ctx.getText()).join('.')`). This is a debuggable
contract boundary and the only string conversion; everything else keeps the steps. (Memory:
`federate-subtraversal-as-steps`.)

## Injection — a `{parentId → parentValue}` map and a STANDARD `mapValues` (✅ LANDED, archived)

The mapValues injection redesign is COMPLETE and its design is archived at
`docs/archive/2026-08-28-federate-injection-mapvalues.md` (as()/select() syntax, the `{parentId→parentValue}`
map + synthesized `inject($map).unfold().group().by(Column.keys).by(<sub>)`, inbound relational landing,
reduction subsumption; the marker/corrId substrate is deleted). The AUTHORITY is now the code; that doc is
the rationale. The reducer algebra, output transport, and hard edges below stay here as durable reference.

## Pushdown is a boundary walk, not per-step special-casing (Calcite prefix model)

`pushableTailPrefix` (`ir/content-demand.ts`) splits the post-barrier tail into `[remote prefix] [local
suffix]` at the first LOCAL-DEPENDENT step. Validated against Calcite's convention/boundary model
(`vendor/calcite`): because the sibling runs the SAME engine, pushing is always cheaper and almost every
step pushes, so the maximal cut is a simple PREFIX WALK — no cost-based planner. Optimistic blocklist —
push unless a step is proven local. A step ENDS the prefix when it:

1. **reads a label bound BEFORE the barrier** — a backtrack across the boundary. A backtrack CONTAINED in
   the prefix pushes fine (the sibling binds and reads its own `as('a')`), which falls out because
   `labelsBoundBefore` clears at the barrier.
2. **is a WRITE** (`MUTATING_STEPS`) — a detached snapshot is immutable.
3. **is a nested/second barrier `call()`** — its own boundary.
4. **observes EVERY label** (`labelReads(...).all` — a `path()`-family or unparseable body).
5. **reads a NAMED COLLECTION bound before the barrier** — `cap('x')` over an `aggregate('x')` the PARENT
   accumulated, which the sibling never saw. Tracked in the collection namespace (`aggregate`/`group`/
   `groupCount` write a key, `cap` reads one), which `labels.ts` does not cover — so it is guarded
   directly, growing a "written within the prefix" set exactly like (1). A self-contained
   `aggregate('a')…cap('a')` inside the prefix pushes fine.

An arg-less INJECTION prefix additionally ENDS AT the marker step: the marker is a per-parent filter on
the sibling, so anything after it (a reducer, a `values`) is LOCAL processing of the scattered result —
the same split the explicit form has.

## Output transport — `ForeignResult` and the `{t,v}` ValueNode arm

`runForeign(gremlin, params, depth, paramTypes?, terminal?)` (`src/execute.ts`, the federation RPC
primitive — runs a sub-traversal on a sibling DO and returns a typed `ForeignResult`) maps the sibling
traversal's TERMINAL SHAPE to a transport arm — **AUTHORITATIVELY, from the sibling's own `plan.shape`,
never predicted by the caller.** This is Calcite's `SqlImplementor.Result.rowType`
(`vendor/calcite/core/.../rel/rel2sql/SqlImplementor.java:509` — the pushed subtree's result type is
`rel.getRowType()`, read off the node, not guessed by whoever pushed it). Our schemaless analogue carries
the type IN each value (the `{t,v}` node) rather than in a separate rowType, but the principle is the
same: the shape follows the pushed subtree's root.

- **elements** (`kind:'elements'`) — vertex/edge detached references (`ForeignRow[]`, framed by
  `lowerForeignResume`).
- **a `{t,v}` `ValueNode`** (`kind:'scalar'`) — a single COLLAPSED value: a pushed reducer
  (`count`→`{t:'long'}`, `sum`/`min`/`max`/`mean`→ the per-row `vt`) or a mid-traversal reduction
  `(key→partial)` map (`t:'map'`). Framed by `lowerScalarResume`, one value (a monoid `count` keeps `0`;
  a semigroup over empty frames nothing).
- **a `FrameNode` STREAM** (`kind:'values'`) — N values from a value-producing terminal: `values(k)`,
  `unfold()`, `fold()`/`cap('a')`, or a `fold()` OF ELEMENTS. Rides the WIDER `FrameNode` (the stored
  `ValueNode` plus the detached element arm `{t:'vertex'|'edge', v: payload}`), so a scalar leaf, a
  detached vertex/edge, and a nested list/map each cross by their own tag. The resume
  (`lowerTypedNodeStream`) re-emits each member as its OWN traverser — `lowerScalarResume` one
  cardinality up — so an empty stream is no traversers and an empty `fold()` is one empty list. LANDED,
  both the source form AND the MID form: a `V().call(federate, <constant sub>)` returning a value stream
  CROSS-scatters the pool over the P parents (`lowerTypedNodeStream`'s `parents` count → a P×N join, the
  value analogue of the element rejoin's no-injection cross). A mid value terminal only reaches here
  CONSTANT — an injection marker caps the pushable prefix before any value terminal, so an injected value
  terminal stays local and comes back through the element rejoin.

**The compounding rule: output-side pushdown of shape X = `runForeign` recognizes the sibling's terminal
shape X and encodes it as a `{t,v}`/`FrameNode` tree; the resume needs no per-shape change.** No new
substrate per shape — the envelope, the element arm and the `typedNode`/`scalar` resumes already exist.
`foreignValueNodes` (`execute.ts`) is the PRODUCER twin of the framer's per-row arms: where `frameValues`
turns a row into a Buffer, it turns the SAME row into the node the Buffer would encode, so a federated
value and a local one are one encoding and cannot diverge. This is what keeps `ForeignResult` from
growing an ad-hoc arm per pushed feature.

**The one thing shape cannot express — reducer vs value STREAM.** A `count()` and a `values(k)` both
compile to sibling shape `value`, differing only in SEMANTICS (count over empty → `0`, one row; values
over empty → `[]`, N rows). `plan.shape` alone cannot separate them, so the ONE prediction that survives
is `terminal:'reduce'` (`ForeignTerminal`, from `pushableTailPrefix.reduces`) — an intent hint, not a
shape guess. Everything else (elements vs a value stream) is read off the returned tag. The explicit
`traversal` form gains the same value framing for free (a `federate(traversal: __.V().count())` now
frames the count).

## Reducer algebra — most are SEMIGROUPS, not monoids

A `ReducingBarrierStep` is a SEMIGROUP fold by default (seeds from the FIRST traverser,
`generateSeedFromStarts`); a subclass becomes a MONOID only by installing an explicit identity. So `count`
is the LONE monoid (`ConstantSupplier(0L)` → empty count is **0**); `sum`/`min`/`max`/`mean` are SEMIGROUPS
(each guards `processAllStarts` with `if (starts.hasNext())` → empty emits **NOTHING**, matching direct
execution). TinkerPop by design — TINKERPOP-1777, a deliberate breaking change in 3.4.0; the sanctioned
"I want 0 over empty" idiom is a user `coalesce(…, constant(0))`, not an engine identity. `reducers.ts`
models the family as `(partial, combine, empty)` with `empty ∈ {'zero' (monoid count), 'nothing'
(semigroup)}` — the authority the lowering picks by reducer name. Cite `vendor/tinkerpop/gremlin-core`
`SumGlobalStep`/`CountGlobalStep` for the guard-vs-seed split.

## Mid-traversal reduction — folding into the standard `by(<sub>.count())`

_SHIPPED FIRST as a per-corrId grouped partial (`<sub>.group().by().by(<partial>())` keyed by the `origin`
channel, resume `lowerReduceCombine`), gated by the `federateReduce` switch with a differential. Under the
mapValues redesign (see "Injection", Stage 4) a per-parent reduction is just the ordinary
`group().by(Column.keys).by(<sub>.count())` — the reducer rides inside the standard `by()` value, no
`origin` channel and no `groupBarrierByOrigin`._

The subsumption is NOT total, and the reason is the reducer algebra below: `group().by(Column.keys)
.by(count())` gives the counts for the parents whose KEY survives into the group, but a parent that matched
NOTHING has no group key. A **monoid** `count` must still emit `0` for that absent parent — a per-parentId
LEFT-JOIN completion (`empty:'zero'`, the surviving core of `lowerReduceCombine`) — while a **semigroup**
(sum/min/max/mean) correctly emits nothing. So Stage 4 keeps a slimmed parentId-keyed empty-completion; it
does not delete the empty semantics. The split law `combine(partial(A), partial(B)) ≡ reduce(A ∪ B)` and
Calcite's `SqlSplittableAggFunction` partials still describe why a pushed partial is valid.

## The hard edges

- **Unbounded movement (`repeat`/`until`)** — the reachable set's size is not known at compile time, so
  "fetch exactly these N vertices" is unavailable; you fetch the whole reachable subgraph or push the
  `repeat` itself remote.
- **Genuine local↔remote interleaving (multi-graph)** — `federate(A).out().where(<needs graph-B data>)`
  is remote→local→remote. The mixing is always DECIPHERABLE (which step reads which graph is static) but
  not always COLLAPSIBLE to one hop; each transition is a barrier, and each barrier is a round-trip. So
  `g.V(ids)`-into-a-remote-graph stays a permanent primitive — which is why the endpoint-id transport
  (bound param → `json_each`, not inline text) had to land regardless, and why it COMPOSES: however an id
  set arises, it crosses as one `json_each` bind.
- **Identity across graphs** — each `BoundGraph` is bound to a SPECIFIC CTE (`vertexBinding`/`edgeBinding`),
  and every rejoin resolves against THAT graph's relation, so an element from graph A is effectively
  `(bgv_A, id)` — the CTE binding IS the graph qualifier, structurally. The gap is narrow: the qualifier is
  STRUCTURAL (which CTE), not a VALUE carried in the row, so it breaks ONLY when two bound graphs' elements
  share ONE stream (`federate(A).union(V(), federate(B).V())` then `dedup`/`has(T.id)`/`group().by(id)` —
  A's `5` and B's `5` collapse). The fix is bounded: promote the structural qualifier into the traverser at
  merge points — an `origin` discriminator carried in the bound stream, threaded through `externalId` and
  the identity comparisons. Per-graph CTEs already exist; what is missing is carrying origin in the row
  when streams merge.

## Landed

Endpoint-id transport (`ENDPOINT_IDS_KEY`); the traversable-subgraph result (`.with("subgraph", true)`
over an edge-producing sub-traversal returns the edges PLUS their distinct incident vertices WITH data —
a heterogeneous element array the local tail walks; `withEndpoints`/`wantsSubgraph` in `federate.ts`);
the `ContentDemand` tail classifier and conditional endpoint fetch (skip the second sibling endpoint hop
unless the local tail reaches an endpoint — `reachesAdjacency`, the safe over-fetch when demand is
unknown); the `ForeignResult` shape-tagged
transport (elements | scalar | keyed map | value STREAM); arg-less pushdown (source + reducers);
mid-traversal `count` reduction pushdown with its differential; empty-reduction semantics; the `parent`
marker (replacing `T.value`); the mogwai.* namespace drop; the sub-traversal-as-steps refactor (string
only at the RPC edge); arg-less MID injection (the marker in the pushed prefix); the cross-boundary
collection-read guard (a `cap` reading a pre-barrier collection stays local); the `raw()` → `runForeign()`
rename; **pushed-collection output framing** (a `values(k)`/`unfold()`/`fold()`/`cap()` terminal, and a
`fold()` of elements, frame end-to-end via the `kind:'values'` `FrameNode` stream +
`lowerTypedNodeStream`; the explicit `traversal` form frames values too); **mid-form value-stream
cross-scatter** (a `V().call(federate, <constant sub>)` returning values re-emits the pool per parent, P×N);
and the **corrId injection refactor** (input side — the marker correlates by a minted `origin` corrId, not
by value re-matching; `matchValue` deleted; the reduction groups by corrId per Calcite decorrelate;
`substituteInjectionMarker`/`injectedValues` removed as dead) **with SCALAR and LIST (`.fold()`, set
membership) injection**.

### Where the marker substrate went

The `parent`-marker + minted-`origin` corrId substrate above was the FIRST implementation of mid-traversal
injection. It was deleted when the `{parentId → parentValue}` map + standard-`mapValues` design landed.
The redesign removed its per-shape arms and its reach into shared filter code, replacing hidden correlation
with the ordinary `group().by(Column.keys)` key.

## Multi-graph merge — federate NESTED in a branch arm (Phase 1 ✅ LANDED)

`union(federate(A).V(), federate(B).V())` now compiles and runs. The blocker was structural, not the
identity discriminator the "Open" item once named: a barrier could only sit on the TOP-LEVEL spine
(`barrierIn` scanned the flat step array), so a `call(federate)` inside a `union` arm compiled to one SQL
statement that cannot cross the async RPC boundary → `UnsupportedTraversal`. The fix makes federate a
CHAINING barrier the way the OLAP decorate/path/pair barriers already are (`src/compiler/rel/segment.ts`):

- **Discovery** — `nestedBarrierIn` reuses `barrierIn` VERBATIM on each branch arm's own body (the finder
  was always position-agnostic). Fired ONLY when no top-level barrier does, so single-spine cases are
  untouched; pre-gated on the arm actually holding a `call()`.
- **Land + rewrite + re-plan** — `nestedBranchSegment` runs the arm's sibling RPC, lands its rows
  (`landForeignRows`), rewrites the arm to a marker `V()`/`E()` carrying `IRStep.landedSource` (a
  `boundGraph` over the named CTEs), and RE-PLANS via `planOf`. The re-plan finds the NEXT un-landed arm as
  its own segment, so N arms land N bound graphs before the SQL merge — the linear trampoline driving each
  sibling RPC in turn. This is the compounding reuse: it opens federate at ANY depth (union/choose/…), not
  a union special-case.
- **Bindings via the source, not the arm** — the landed CTEs accumulate on `request.lowering.source`
  through `withExtraBindings` (mirroring `decorateGraph`'s stack), so the arm compiles as an ordinary
  effects-free read and the union/merge machinery (`mergeArms`) needs NO change — it never sees provenance.
  A per-arm salt keeps two arms' fresh-minter binding names (`bgv0`/`bge0`) from colliding.

**The merge point is where the two open pillars remain, and Phase 1 fails CLOSED on both** (never
misjoins against one graph — the `safePostMergeTail` gate admits only a cardinality tail ending in
`count()`):

1. **Post-merge element reads** (`values`/`hasLabel`/a bare element return/movement) — a merged row's `id`
   comes from one of several disjoint landed id-spaces with no per-row tag, so a single `ctx.source`
   rejoin would silently read the wrong graph. **Phase 3:** land the arms into a graph-TAGGED unified
   relation (`SELECT 'A' AS graph,* FROM bgv_A UNION ALL …`) and rejoin by the composite `(graph, id)`.
2. **Cross-graph identity** (`dedup`/`has(T.id)`/`group().by(id)`) — A's id `5` and B's id `5` must not
   collapse. **Phase 2:** a new `graph` `ChannelRole` (its own name — `origin` is taken) carried in the
   row, threaded through `externalId` and the dedup/group keys; provably inert for single-graph queries.
   The Phase-3 unified relation is the SAME `graph` discriminator promoted into a relation, so the two
   pillars share one substrate.

Deferred (tracked, genuinely separate): the parallel I/O barrier batch (run independent sibling RPCs
concurrently — beneficial for the async-I/O barrier class, federate + `io()`, a no-op for the
compute-bound OLAP barriers); `coalesce`'s priority/short-circuit interaction with firing a remote call;
mid-position / nested-prefix federate arms; the `where(eq)` element-identity compare.

## Open, in rough priority

1. **Multi-graph identity + post-merge reads** — Phase 2 (the `graph` discriminator channel role, for
   cross-graph `dedup`/`group`/`has(id)`) and Phase 3 (the graph-tagged unified relation, for post-merge
   `values`/`hasLabel`/element materialization). Both above; Phase 1's structural merge has landed.
2. **Widen the side-effect boundary further** — a pre-barrier side-effect that a later local read needs
   could be threaded through the resume (today `cap` over a pre-barrier collection fails closed locally).
   Lower value.

## Considered and NOT unified — the value-stream resumes

`lowerTypedNodeStream` (federate's value stream) and `lowerValueResume`/`lowerListResume`
(`reverse()`/`split()`'s value-transform barrier, `src/compiler/rel/barrier-value.ts`) both seed a
resumed chain from a data-sized value set, and it is tempting to make split/regex TAG their output with a
type and route both through ONE typed resume. They stay SEPARATE for a load-bearing reason, not laziness:
`lowerValueResume` CONTINUES a local tail (`scalarTail`, scalar-only) while `lowerTypedNodeStream` is
TERMINAL and HETEROGENEOUS (a member may be a detached vertex/edge — a `fold()` of elements — which
`scalarTail` cannot frame; it needs the `typedNode` framing). A merge would force federate's element case
back out. If a future federate value stream ever needs a LOCAL SUFFIX (today the pushable prefix is
maximal, so it never does), the shared shell is `valueResume` with a `PER_ROW_ENVELOPE`-typed seed — that
is the seam to reuse, not `lowerTypedNodeStream`.
