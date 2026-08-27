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

## Injection — the `parent` marker

A mid-traversal federate injects each parent's scalar into the sibling sub-traversal. The user marks the
site with a self-delimiting marker CALL in a predicate operand:

    V().call("federate", [graph:"crew", traversal:
      __.V().has("name", __.call("parent", __.values("name")))])

`call("parent", <read>)` carries BOTH the site (its operand position) and the read
(`__.values('k')`/`__.id()`/`__.label()`, classified by `injectionKindOf`). It is expressible by every
unmodified GLV (a `call()` nested in the operand — grammar form `has_String_Traversal`), self-delimiting
(nobody writes `call("parent")` for any other reason, so it needs no boundary to disambiguate — which is
what makes the arg-less form work), and identical across the explicit and arg-less forms.

Mechanics: `PARENT_MARKER`/`isParentMarkerBody` (`ir/injection.ts`, leaf); `parentMarkerReadIn`/
`parentMarkerStepIndex` (`call-params.ts`) walk the sub-traversal for the marker; `substituteInjectionMarker`
(`strategies.ts`, a Pass) rewrites the marker operand → `within(INJECT_VALUES_KEY)` on the SIBLING compile.
A bare `call("parent")` with no read fails closed at parse. `call("parent")` never reaches a registry —
there is no `parent` service. (Memory: `federate-parent-marker`.)

The sibling runs ONE batched hop over the DISTINCT injected values (a SPARQL bound-join), and results
SCATTER back over the parents (`foreignRejoin`, `src/compiler/rel/foreign.ts`): each returned element
re-matches the injected value it satisfies, in the resume SQL.

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
  cardinality up — so an empty stream is no traversers and an empty `fold()` is one empty list. This is
  LANDED (open item 1 below).

**The compounding rule: output-side pushdown of shape X = `runForeign` recognizes the sibling's terminal
shape X and encodes it as a `{t,v}`/`FrameNode` tree; the resume needs no per-shape change.** No new
substrate per shape — the envelope, the element arm and the `typedNode`/`scalar` resumes already exist.
`ForeignValueNodes` (`execute.ts`) is the PRODUCER twin of the framer's per-row arms: where `frameValues`
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

## Mid-traversal reduction — a monoid transport optimization

A mid federate whose local tail is a bare reducer pushes the reduction as a per-injected-value GROUPED
PARTIAL — `<sub>.group().by(<groupBy>).by(<partial>())` — so only a `(key→partial)` map crosses instead of
every element; the resume COMBINES per parent (`lowerReduceCombine`) with the reducer's `combine`/`empty`.
Same answer as the element scatter + local reduce (the authority), fewer bytes. Gated by the
`federateReduce` switch with a differential (`test/federation.test.ts`: switch-ON ≡ switch-OFF). The split
law `combine(partial(A), partial(B)) ≡ reduce(A ∪ B)` is what makes it valid. `groupBy` is the injection
read applied element-side, so the group key equals what the element scatter matches on. In practice only
`count` reaches this gate (sum/min/max/mean need a preceding `values(k)`, a 2-step tail the single-reducer
gate rejects — they push via the arg-less prefix instead); the table's other rows are exercised by that
path. The reducer partials from Calcite's `SqlSplittableAggFunction` (count/sum → SUM0, min/max
self-split, mean reduce-firsts to `(sum, count)`).

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

Endpoint-id transport (`ENDPOINT_IDS_KEY`); the `ContentDemand` tail classifier and conditional endpoint
fetch (skip the endpoint hop unless the tail reaches an endpoint); the `ForeignResult` shape-tagged
transport (elements | scalar | keyed map | value STREAM); arg-less pushdown (source + reducers);
mid-traversal `count` reduction pushdown with its differential; empty-reduction semantics; the `parent`
marker (replacing `T.value`); the mogwai.* namespace drop; the sub-traversal-as-steps refactor (string
only at the RPC edge); arg-less MID injection (the marker in the pushed prefix); the cross-boundary
collection-read guard (a `cap` reading a pre-barrier collection stays local); the `raw()` → `runForeign()`
rename; and **pushed-collection output framing** (open item 1 — a `values(k)`/`unfold()`/`fold()`/`cap()`
terminal, and a `fold()` of elements, frame end-to-end via the `kind:'values'` `FrameNode` stream +
`lowerTypedNodeStream`; the explicit `traversal` form frames values too).

## Open, in rough priority

1. **Bigger-than-scalar INJECTION (input side)** — the parent injects a LIST/MAP (eventually a SUBGRAPH),
   not just a scalar `values`/`id`/`label`, so it can hand real context to the sibling. Orthogonal to the
   landed output framing — that is what the sibling returns OUT, this is what the parent sends IN — but
   shares the `{t,v}` envelope. The strategic slice; larger; best done in a clear context.
2. **Multi-graph mixing** — the `origin`-in-row work from the identity hard edge above, gating
   `union`-of-two-siblings + identity comparisons.
3. **Widen the side-effect boundary further** — a pre-barrier side-effect that a later local read needs
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
