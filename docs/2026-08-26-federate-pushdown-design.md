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

## Injection — a `{parentId → parentValue}` map and a STANDARD `mapValues` on the sibling

_This section is the TARGET design (planned 2026-08-28). It SUPERSEDES the `parent`-marker + minted-`origin`
corrId substrate that shipped first — see "Where the marker substrate went" under Landed. The staged build
is at the end of this section._

A mid-traversal federate injects each parent traverser's value into the sibling, batches all parents into
ONE sibling hop, and scatters results back per parent. The load-bearing decision: **the batched injection
flows as STANDARD Gremlin + standard parameters, and the sibling compiles it with ZERO federate-awareness.**

The batched injection is a **`{parentId → parentValue}` map**, crossing as ONE ordinary bound parameter
(the parent set is DATA-scaled — one row per parent traverser, unbounded — so it MUST be one `json_each`
bind of any size, never N per-parent binds, which would breach the DO 100-bind wall; root `CLAUDE.md`'s
data-not-in-text rule). The sibling runs a STANDARD Gremlin `mapValues`:

    inject($map).unfold().group().by(Column.keys).by(<the user's per-parent sub-traversal over the entry value>)

transforming `{parentId → parentValue}` into `{parentId → result}`. **Correlation is the ordinary
`group().by(Column.keys)` KEY** — not a hidden channel — and it is correct for distinct parents that inject
EQUAL values, because two parents are two distinct KEYS whatever their values. The shape is legal,
GLV-portable Gremlin (`vendor/tinkerpop/gremlin-test/.../features/sideEffect/Group.feature:186-201`).

### User syntax — `as()` / `select()`, NOT a marker

The user marks the injection point with a standard **`as()` alias in the parent, `select()` in the
sibling** — a value bound before the barrier, read across it:

    g.V().hasLabel("person").values("email").as("e")
      .call("federate", ["graph":"amazon"])
      .V().has("email", select("e")).count()

Pure standard Gremlin with a federate call in the middle — instantly readable, nothing invented. It aligns
with machinery that ALREADY exists: `content-demand.ts:141`/`labelsBoundBefore` tracks exactly "a label
bound BEFORE the barrier, read across it" (`as('x') … call(federate) … where(eq('x'))`). The old
`__.call("parent", <read>)` marker was a bespoke reinvention of this, and is retired.

### Inbound — the returned map lands via the EXISTING BoundGraph; downstream stays polymorphic

`GraphSource`/`BoundGraph` (`src/compiler/rel/source.ts`, `boundgraph.ts`) exists so a foreign graph's
elements land as a temporary relation and downstream ops (`out()`/`values()`/`has()`) join across them
WITHOUT knowing they are foreign. The redesign preserves that — a hard requirement.

- The `t:'map'` FrameNode transport, framing `{t:'vertex'}`/`{t:'edge'}`/`{t:'list'}` values recursively at
  any depth, already exists (`src/execute.ts`'s `frameTypedNode`/`typedMapBuffer`, the `mapValue` arms in
  `runForeign`/`foreignValueNodes`). Reused unchanged.
- The returned map explodes DIRECTLY to `(parentId, element)` rows — ONE entry per parent already (no
  distinct-value dedup to undo), so FEWER hops than the corrId path: `foreignRelation` explode +
  `foreignRejoin` re-scatter (two hops) collapses to one map explode. `foreignRelation`
  (`src/compiler/rel/foreign.ts`, two callers) already carries a per-row correlation column via its `extra`
  param — parentId rides where corrId rode. Those rows feed a BoundGraph CTE as a source-form pool does.
- The inbound seam is the result-tag dispatch `resumed` (`src/compiler/rel/segment.ts`), NOT GraphSource —
  a new arm correlating each entry to its parent by the parentId KEY (an ordinary join replacing
  `foreignRejoin`'s hidden-corrId join).

**A subgraph is not a single value** (`subgraph()` is a top-level side-effect step, never a `by()`-value).
A neighbourhood-as-value is the idiomatic composite `project('vertices','edges').by(V-list.fold())
.by(E-list.fold())` — ordinary shapes, existing framing.

### The staged build — each stage CI-green and committed to trunk

The ordering is forced by the largest hidden dependency (Stage 1): the `mapValues` shape is grammatically
legal but does NOT lower in our engine today.

0. **Grammar enablement (`inject($map)`) + parser regen.** `inject()` takes `genericLiteralVarargs`
   (literals only; `Gremlin.g4:136,629`); loosen to `genericArgumentVarargs` (already includes `variable`)
   — a strict superset, standard clients unaffected, only OUR sibling query uses `inject($map)`. The parser
   is generated from `git show origin/master:Gremlin.g4` — a git blob, NOT the on-disk file
   (`scripts/generate-parser.sh:44`), so the `.g4` edit rides as a `patches/upstream/` patch `git apply`-ed
   to the exported temp `.g4` before antlr-ng (indexed + paired with an upstream PR). Front-end likely
   unchanged (`frontend.ts:581-590,642-646` already resolves a bound-Map `VariableContext`). Note the ONE
   carried grammar delta in root `CLAUDE.md` locked-decision #2.
1. **Make `group().by(Column.keys).by(<child over entry value>)` lower.** ⚠️ HIGHEST RISK — was a
   COMMITTED DEFERRAL (`map.ts`'s `groupRows` had no `Column`-token group key over an unfolded-map
   stream). **✅ MOSTLY LANDED (commit `0986f359`, 2026-08-28):** `Column.keys` is admitted as a `by()`
   projection resolving against an unfolded map entry, entry-value `by()` bodies route through the
   ordinary map-entry/list/scalar tail, and the entry host reaches `group()`/`groupCount()`. Verified:
   scalar (`by(select(Column.values).count(Scope.local))` → `{josh:2,marko:3,…}`), list-valued child,
   the re-group by `Column.keys`/`Column.values`. THE LOAD-BEARING SUBSTRATE THAT UNBLOCKED IT:
   **element-list map values now retain rowids** (`{kind:'list', of:{kind:'elem'}}`), so
   `select(Column.values).unfold()…out()` re-enters element traversal at ANY depth (see the top-level
   `map-value-element-reentry.feature` oracle), and `dedup()` in a group value-fold scopes per group key.
   **ONE remaining sub-case (a NEW increment, not a regression):** element re-entry NESTED inside the
   re-group's value-by — `…unfold().group().by(Column.keys).by(select(Column.values).unfold().unfold().values('name').fold())`
   still declines; the top-level element re-entry works but the entry-host child seam does not yet thread
   it. The other four result shapes (map/project, composite `project('vs','es')`) still need their
   isolation proof before Stage 3.
2. **Inbound per-parent-map reception (dormant behind the old path).** A `foreignRelation` variant
   consuming the `{parentId → [elements]}` map via two-level `json_each` → `(parentId, element)` rows, and a
   new `resumed` arm landing them into a BoundGraph CTE by the parentId KEY, reusing the existing
   landing/subgraph/id-carry.
3. **Outbound synthesis (first end-to-end).** `federate.ts` builds the `{parentId → parentValue}` map and
   synthesizes the `mapValues` query; `midSegment` still projects the parent's read (via the `as()` alias)
   to build the map, rewriting the parent's `as("e")` reference to `select("e")` in the synthesized `by()`.
4. **Reduction-pushdown subsumption.** A per-parent reduction becomes `group().by(Column.keys)
   .by(<sub>.count())` — but NOT fully (see "Reducer algebra"): the monoid `count`-over-empty→0 for a
   parent that matched nothing (no group key) still needs a per-parentId LEFT-JOIN completion. Keep a
   slimmed parentId-keyed empty-completion.
5. **Delete the old substrate** (only after 3–4 green): the reserved key, the marker + its recognizers, the
   `if(marker)` sibling block, `ctx.injectionCell` + the two resolver hooks, the `origin`→corrId
   projection, `foreignRejoin`'s injected arm, `groupBarrierByOrigin`, `InjectionKind`/`injectionTraversal`/
   the reduction-pushdown flags. `bash scripts/ci.sh` (orphans/refs/arch) is the correctness check.

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

Endpoint-id transport (`ENDPOINT_IDS_KEY`); the `ContentDemand` tail classifier and conditional endpoint
fetch (skip the endpoint hop unless the tail reaches an endpoint); the `ForeignResult` shape-tagged
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

The `parent`-marker + minted-`origin` corrId substrate above is the FIRST implementation of mid-traversal
injection and is still on trunk, but it is **being superseded** by the `{parentId → parentValue}` map +
standard-`mapValues` design (see "Injection" at the top). Two forces drove the redesign: it kept forcing
per-shape arms (scalar vs list vs map — a drift refuted repeatedly), and it made injection reach into
SHARED filter code (`nestedFirstValue`/`foldedListSet` via `ctx.injectionCell`) — which violates the rule
that injection must change no non-federate code. The mapValues design retires the marker, the reserved key,
the `origin` correlation channel, `injectionCell`, and `foreignRejoin`'s injected arm, replacing all of it
with correlation as an ordinary `group().by(Column.keys)` key. Do not extend the marker substrate; build
toward the redesign.

## Open, in rough priority

1. **The mapValues injection redesign** — replace the marker/corrId substrate with the
   `{parentId → parentValue}` map + standard-`mapValues` sibling query (the "Injection" section is the full
   design; its "staged build" is the worklist). Stage 1 (make `group().by(Column.keys).by(<child>)` lower —
   a committed deferral today) is the highest-risk prerequisite and comes first. This subsumes what the old
   backlog called "bigger-than-scalar injection (MAP/SUBGRAPH)": under the redesign a map/list/element/
   composite value is just an ordinary `by()` result shape the sibling produces, no per-shape correlation
   work.
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
