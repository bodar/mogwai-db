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

## Bigger-than-scalar injection — a BIND of any shape, correlated by a minted `origin`

_The architecture for widening injection past a scalar (open item 1). Decided + built 2026-08-27. Memory:
`federate-injection-value-as-key`._

**SCOPE — where this sits in the two federate axes.** Federate pushdown has two ORTHOGONAL directions,
easy to conflate:
- **OUTPUT-side** (what the sibling returns OUT, how it frames locally) — the value-stream work: pushed
  `values`/`fold`/`cap`, the mid cross-scatter. **Landed** (see "Landed" below).
- **INPUT-side** (what the parent sends IN per parent) — THIS section. What the corrId work primarily did
  was a **correlation-mechanism REFACTOR**: it replaced "re-match the returned element's value" with
  "carry a minted corrId (`origin`) through the sibling and join on it". A scalar injection worked before
  and works now; the refactor made correlation CORRECT (distinct parents with equal values) and, crucially,
  **value-SHAPE-agnostic** — which is the prerequisite for injecting anything bigger than a matchable
  scalar. The old value-match rejoin fundamentally could not scale (you cannot re-match a list/map against a
  returned element); the corrId decouples correlation from the value's shape entirely.

Input-side injectable-shape status:

| shape | read | status |
|---|---|---|
| **scalar** | `values('k')` / `id()` / `label()` | ✅ (now via corrId) |
| **list** | `<scalar-read>.fold()` — set MEMBERSHIP | ✅ |
| **map** | `valueMap` / `project` | ❌ not built |
| **subgraph** | a projected neighbourhood | ❌ not built |

Map and subgraph now generalize CLEANLY (no correlation rework): a map/subgraph injects as a bind of that
shape; the corrId join is identical; only what the sibling DOES with the injected value (filter on a map's
keys, traverse an injected subgraph) is new per shape. Those remain under this same open item.

**Injection is a BIND spliced at the marker, of ANY explicit shape.** The marker read produces a per-parent
value — a scalar (`__.values('k')`/`__.id()`/`__.label()`), a LIST (`<read>.fold()`), eventually a map or
subgraph — and it flows across as a BIND (never inlined; the user chose to send it and it may be massive —
root `CLAUDE.md`'s "a bind serves a user parameter"), dropped where a literal-or-bind is legal Gremlin. The
sibling compiles ordinary Gremlin; an illegal shape blows up NATURALLY on the sibling — NO upfront
validation. **No implicit collapse:** Gremlin is an explicit API, so a bare multi-valued read with no
`.fold()` is ambiguous (stream vs list) and FAILS CLOSED — only explicitly-shaped reads flow across
(`injectionKindOf`, `call-params.ts`, peels a trailing `.fold()` and rejects anything else).

**Correlation is by a MINTED per-parent id — the existing `origin` CHANNEL, our Calcite `CorrelationId`.**
`channels.ts` already documents `origin` as exactly this: "a PROVENANCE/IDENTITY key that a rejoin groups
by", cross-checked against `vendor/calcite/core/.../rel/core/CorrelationId.java`. So the corrId needs NO new
substrate — it is an `origin` channel, minted per UNCOLLAPSED parent row at the mid head (the head terminal
is a per-traverser map, which structurally blocks `movementCollapse`, so one row per parent is guaranteed).

**The marker lowers as a correlated JOIN that PROJECTS the corrId, not a `within` FILTER.** This is the
crux and what deletes the special-cases. Instead of `substituteInjectionMarker` rewriting the operand to
`within(INJECT_VALUES_KEY)`, the marker becomes a join against the injected `(corrId, value)` pairs that
carries the `origin` corrId into the sibling's output — Calcite `Correlate` applied literally ("drive rows ×
sub-query, carry the LEFT identity into every output row"). The corrId then rides through the rest of the
sibling traversal via the ORDINARY channel machinery (`withChannel`/`carriedCols`/movement/merge), and the
sibling returns `(corrId, element)` tuples. The rejoin joins parent × result ON the corrId — never
re-matching by value, never reading a correlation column off the element.

**What this DELETES:** the `InjectionKind` values/id/label enumeration, `matchValue`'s per-facet column
mapping (`foreign.ts`), and the operand-position question — all dissolve, because the injected value's SHAPE
is irrelevant to a corrId join. A scalar, a list, a map, a subgraph all correlate identically; list/map/
subgraph generalize with NO per-shape rejoin arm.

**The one principled boundary:** `origin`'s barrier policy is `empty` (`CHANNEL_BARRIER_POLICY`), so the
corrId does NOT survive a sibling-side global BARRIER (a `fold`/`count`/`group` AFTER the marker). Such a
traversal fails closed — a pre-encoded limit, not a surprise. **The optimization it unlocks:** because
corrId and value are separate, equal values across parents can share ONE bind entry (dedup the value, map
several corrIds to it) — a later optimization, not a prerequisite.

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

A mid federate whose local tail is a bare reducer pushes the reduction as a per-corrId GROUPED
PARTIAL — `<sub>.group().by().by(<partial>())`, with RelIR replacing the unnameable Gremlin key by the
live `origin` channel — so only a `(corrId→partial)` map crosses instead of
every element; the resume COMBINES per parent (`lowerReduceCombine`) with the reducer's `combine`/`empty`.
Same answer as the element scatter + local reduce (the authority), fewer bytes. Gated by the
`federateReduce` switch with a differential (`test/federation.test.ts`: switch-ON ≡ switch-OFF). The split
law `combine(partial(A), partial(B)) ≡ reduce(A ∪ B)` is what makes it valid. The GROUP BY is the minted
per-parent corrId, so equal injected values remain distinct groups. In practice only
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
rename; **pushed-collection output framing** (a `values(k)`/`unfold()`/`fold()`/`cap()` terminal, and a
`fold()` of elements, frame end-to-end via the `kind:'values'` `FrameNode` stream +
`lowerTypedNodeStream`; the explicit `traversal` form frames values too); and **mid-form value-stream
cross-scatter** (a `V().call(federate, <constant sub>)` returning values re-emits the pool per parent, P×N).

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
