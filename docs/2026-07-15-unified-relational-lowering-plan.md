# Unified relational traversal lowering — root and child traversals through one compiler

**Date:** 2026-07-15  
**Status:** in progress; Stages 0–5 complete, Stage 6 active
**Baseline:** L1 2298/2298, L3 876/2041; latest focused checkpoint: 236 compiler tests

## Restart handoff — read this first after a context reset

**Last committed checkpoint:** branch `refactor/unified-relational-lowering`, commit
`8bc5b60` (`unify heterogeneous project by fields`). The next local commit contains the
labelled select slice described below. Work is local-only: do not push or merge to trunk.
Run the full `bun test` suite before every local commit.

**Recent completed slices:**

1. `fe361a9` — scoped element `fold()` now produces a typed ListStream per parent;
   homogeneous element-list union/choose/coalesce arms share `unifyLists`; terminal
   materialization expands rowids to property-bearing vertex/edge objects in the same
   SQL query. L3 ratcheted 872→873.
2. `61d028d` — `local()` now uses generic child `all` cardinality for bare movement and
   origin-partitioned element `limit`/`skip`/`range`/`dedup` (including before `fold`).
   `src/steps/local.ts` and its private movement/window compiler were deleted. L3 stayed
   873. Full suite: 357/357; corpus: 2298/2298.
3. `d671257` — all-traversal scalar `project().by()` fields lower through child streams,
   joined by one outer origin with first/productive semantics. Full suite: 359/359; L3
   stayed 873.
4. Current slice — mixed property-key and `T.id`/`T.label` scalar fields now share the
   same project origin join, and `tryCompileScalarValueChild` hides count-vs-row lowering
   from consumers. L3 ratcheted 873→874.
5. Bare vertex/edge `project().by()` fields now share that heterogeneous origin join with
   traversal scalar fields. They retain the full public element payload plus the internal
   rowid, so selecting the field re-enters ordinary movement. Node and edge execution,
   scalar productivity, and movement re-entry are covered. L3 remains 874.
6. Single- and multi-label `select(...).by(__.<scalar child>)` re-root ordinary element
   streams on the selected alias, then use the same generic child-first compiler. Mixed
   property/bare fields join on one outer origin, so duplicate parents stay distinct and
   element fields retain movement re-entry. The two PathProcessorStrategy select scenarios
   now pass; L3 ratcheted 874→876.

**Current Stage 6 slice:** traversal-valued `project().by()` is now the first generic
by-consumer. An outer origin identifies each parent; every scalar child modulator lowers
with `first` cardinality; productive fields inner-join by origin. Missing child rows drop
the record, productive NULL survives, and duplicate parents remain distinct. Property
keys, `T.id`/`T.label`, and complete bare vertex/edge fields can mix with traversal fields
in the same relation. Element fields retain their internal rowid for downstream movement.
L3 is 874.

**Immediate next slice:** migrate group key/value consumers onto the generic child-stream
and explicit productivity seam. Scalar traversal select is complete; list/element-valued
select modulators remain a later shaped-child extension.
Do not add more recognized syntax to `compileNestedScalar`: treat its current correlated
SQL cases as optional fast paths and add generic child-stream fallbacks with explicit
first/productive cardinality. Other consumers to inventory afterward are sack, math,
format, and option-choose. Preserve correlated count/EXISTS fast paths until Stage 8
proves whether they should remain. This work is the prerequisite for ProductiveByStrategy.

**Still pending in Stage 6:** scalar/list `optional`, traversal-valued `by`, an explicit
ProductiveByStrategy productivity policy, and generic child-existence fallback for
`where`/`filter`/`not`. Element-valued child `order()` is also deferred: it needs
encounter-order metadata that survives later lowering and root materialization, not a
CTE-local `ORDER BY` assumption.

**Non-negotiable invariants:** productive SQL NULL is a traverser; no child row is
different from a NULL row. Child barriers group by multiset-safe origin ordinals and use
the preserved parent domain for total empty results. Mixed stream/list item shapes fail
closed. SQL generation stays in the `q` kernel; no JS traversal interpretation and no
new dependency.

**Implementation history (earlier 2026-07-15 checkpoint):** physical stream schemas and the single
root materialization boundary are landed. Global count and numeric reducers now lower
to ScalarStreams (numeric payload `v,vt`), scalar row operators and transforms/casts lower left-to-right,
scalar `fold` lowers to a typed ListStream, and list-local reducers re-enter ScalarStream,
`inject` is now only a shaped source feeding that same dispatcher, and shared child-domain
scope construction backs branches plus `local`. Typed scalar
folding and the unified inject source recovered seven official scenarios across the
two checkpoints; L3 has ratcheted to 848/2041. The original 833 remains the migration's
comparison floor. Stage 4's first slice has converted every scalar-producing element
leaf (`map`/scalar `local`, `math`, `format`, option-choose, and sack read) from a
terminal mini-compiler into a typed ScalarStream producer that re-enters common lowering.
The null regression caught during the full ratchet is now explicit: productive
`map(constant(null))` is a row containing NULL; child productivity must never be inferred
from value nullability.

## Decision

Replace the read compiler's semantic `prefix → terminal tail` split with one
shape-directed relational lowering loop:

```text
Step[] + Stream + CompileScope
              │
              ▼
        lowerSteps(...)
              │
              ▼
            Stream
              │ root only
              ▼
       materializeRoot(...)
              │
              ▼
           Compiled
```

Every read step lowers one shaped relational stream to another shaped relational
stream. Root traversals and child traversals use the same `lowerSteps` engine. A child
scope adds an input-domain relation and a correlation ordinal; it does not select a
different compiler. GraphBinary/result `Shape` construction happens once, at the root
materialization boundary.

This is deliberately a bold refactor. It is not a second compiler layered over the
first, and it is not a new row-at-a-time interpreter. It keeps the locked model: one
Gremlin traversal compiles to one set-at-a-time SQLite statement.

The immediate feature payoff is broader `local`/`map`/`flatMap`/branch/`by()` child
traversals, general projection re-entry, and ProductiveBy semantics. The architectural
payoff is larger: future read steps get one composition model instead of choosing among
the prefix fold, the tail accumulator, `compileNestedScalar`, `compileNestedList`,
`compileProperties`, or a branch-specific body compiler.

## Why now

The compiler's successful structural work has converged on the pieces this change
needs:

- `Stream` already distinguishes element, scalar, list, and map relations.
- `dispatchNext` already proves that a stream can re-enter compilation after a shape
  change.
- `Carried` now makes physical traverser columns explicit and preserves aliases/path
  through branch merges.
- `Carried.origins` is a nested ordinal stack, proven by nested
  `optional`/`coalesce`.
- `foldBody` proves ordinary element steps can compile from an already-seeded relation.
- `local` proves a window partitioned by an input ordinal gives correct per-traverser
  barriers.

What remains is mostly the negative space between them. Read leaf compilers still call
`readCompiled` themselves, so they stop being composable. `foldBody` stops at the first
non-element step. `compileNestedScalar` and `compileNestedList` manually recognize small
subsets of the language. `local` and branch bodies each seed/carry correlation in their
own way. The one-projection ceiling is a symptom of this early materialization.

The current L3 run makes the clustering visible. Exact first-error counts include 40
`only one projection step`, 28 ProductiveByStrategy rejections, 23
`local(aggregate...)` variants, plus many scalar/projection branch bodies and restricted
nested `by()` traversals. Those are not one feature, but they share one missing compiler
capability: lower an arbitrary child traversal to a shaped relation while preserving
which input traverser produced each output.

## The current architectural fault line

There are currently six overlapping semantic compilers:

1. `foldBody`: element-only `StepFn` prefix lowering.
2. `foldTailAcc` + `renderProjection`: scalar projection/modifier/reducer lowering,
   usually straight to `Compiled`.
3. `dispatchNext`: partial shape re-entry for scalar/list/map streams.
4. `compileNestedScalar`: hand-recognized correlated scalar traversals.
5. `compileNestedList`: hand-recognized movement/projection/fold traversals.
6. Branch/local implementations: seeded relation folds and ordinal-window barriers.

Each is locally reasonable. Together they make composition depend on where a traversal
appears. `out().values()` works at the root but may not work in a branch; a reducer works
terminally but not after another projection; a barrier is global unless local has a
bespoke window case; a nested traversal works only if `compileNestedScalar` happens to
recognize its exact syntax.

The target is one semantic compiler with optional optimized lowerings.

## Target model

### 1. All read lowering returns a `Stream`

No read-step leaf calls `readCompiled`. A step lowerer consumes a stream and returns a
stream:

```ts
type Lowerer<S extends Stream = Stream> =
  (step: PStep, input: S, scope: CompileScope) => Stream;

function lowerSteps(
  steps: readonly PStep[],
  input: Stream,
  scope: CompileScope,
  from?: number,
): Stream;
```

Input-shape validation lives at dispatch: movement requires an element stream; scalar
transforms require a scalar stream; list algebra requires a list stream. A step can
change shape and the next step is dispatched immediately against the new stream.

The old prefix `StepFn`s can migrate with a narrow adapter first. They already have the
right functional form for element streams. The important change is that projections,
reducers, properties, groups, maps, and paths stop terminating compilation.

### 2. A stream describes its physical SQL relation honestly

Today the value streams extend `Carry`, but several generated relations contain only
`v` or `list` even when `Carry.carried` says aliases/origins/path exist. That is safe only
because those paths terminate quickly. It is not safe for general child composition.

The new invariant is strict:

> Every physical column named by a stream's payload or `Carried` schema exists on that
> stream's `Relation`, in the declared stable order.

Sketch:

```ts
interface RelStreamBase extends Carry {
  readonly rel: Relation;
}

interface ElementStream extends RelStreamBase {
  readonly kind: 'elements';
  readonly elem: 'node' | 'edge' | 'property';
  readonly payload: ElementLayout;
}

interface ScalarStream extends RelStreamBase {
  readonly kind: 'scalar';
  readonly col: 'v';
  readonly as?: ValueType;
  readonly storageTypeCol?: 'vt';
}

interface ListStream extends RelStreamBase {
  readonly kind: 'list';
  readonly col: 'list';
  readonly of: ListOf;
}

interface MapStream extends RelStreamBase {
  readonly kind: 'map';
  readonly keyCol: 'mk';
  readonly valueCol: 'mv';
  readonly keyOf: MapOf;
  readonly valOf: MapOf;
}
```

`St` becomes a temporary alias for `ElementStream`, then disappears. Property elements
join the stream model instead of living in a terminal `compileProperties` island.

Do not homogenize payload and carried roles into an untyped `Column[]`. Element identity,
scalar type, list item shape, aliases, path, sack, and origins have different semantics.
The stream is a typed physical schema, not a bag of column names.

Add development assertions at every CTE boundary:

```ts
assertStreamColumns(stream);
```

`Relation.cols` makes this cheap and catches the class of path/sack/origin column-order
bugs that previously survived TypeScript.

### 3. Scope owns correlation; `Carried` owns physical per-row state

Correlation is not merely a column. Empty child results matter: `local(out().count())`
must emit zero for a parent with no outgoing edges, whereas `map(out().values('x'))` may
be unproductive. Once a child produces no rows, its origin column alone cannot recreate
the missing parent.

Use an explicit scope stack:

```ts
interface RootScope {
  readonly kind: 'root';
}

interface ChildFrame {
  readonly ordinal: string;       // physical column carried on child rows
  readonly domain: Relation;      // exactly one row per parent traverser
  readonly parent: Stream;
}

interface ChildScope {
  readonly kind: 'child';
  readonly frames: readonly ChildFrame[];
}

type CompileScope = RootScope | ChildScope;
```

`pushChildScope(parent)` creates one domain CTE with a fresh ordinal and all parent
payload/carried columns. It returns the child seed plus the frame. Nested children push
another frame; the full origin stack continues to ride physically through `Carried`.

The domain relation is the semantic difference between:

- no child result;
- one productive child result whose value is SQL `NULL`;
- a total reducer such as `count()` that must synthesize a result for an empty child;
- an unproductive `by()` that should filter or preserve the parent depending on
  ProductiveByStrategy.

Never use `v IS NULL` as a productivity test. Row existence and scalar nullness are
different facts.

### 4. Barriers are scope-aware relational operators

A barrier does not have separate global and local implementations. It groups or windows
over the active partition keys:

```ts
const partitionKeys = scope.kind === 'root'
  ? []
  : scope.frames.map((f) => f.ordinal);
```

- Root `count()` aggregates the whole stream.
- Child `count()` groups by active origins and left-joins the current frame's domain so
  empty children yield zero.
- Child `order().limit(n)` uses `ROW_NUMBER() OVER (PARTITION BY origins ORDER BY ...)`.
- Child `dedup()` partitions by origins and payload identity.
- Child `fold()` produces one list row per origin, including an empty list where Gremlin
  requires a total fold.
- `group()`/`groupCount()` produce one map per active origin; `MapStream` therefore carries
  the origin columns on every entry row.

Put these operators in the shared child/barrier layer. `local` should be a thin
cardinality policy over `compileChild`, not an alternate barrier engine.

### 5. Materialization is a single root-only boundary

`materializeRoot(stream): Compiled` is the only ordinary read path allowed to call
`readCompiled`. It turns the final relational payload into the existing handler-facing
`Shape` and selects the framing columns.

This keeps GraphBinary concerns out of semantic lowering. Terminal and non-terminal
`group()` use the same MapStream lowering; terminal/non-terminal `fold()` use the same
ListStream lowering; `count()` is always a ScalarStream tagged Long. Root materialization
chooses the efficient output projection and existing wire shape.

Special output layouts such as grouped recursive paths may remain explicit stream kinds
or materialization strategies. They still reach `Compiled` through this one boundary.

Writes remain separate `WritePlan`s. This project does not force mutation steps through a
read-stream abstraction.

### 6. Child cardinality is a consumer policy

The child compiler produces all relational results. Its consumer selects cardinality:

```ts
type ChildUse =
  | { kind: 'flatMap' }             // zero-to-many
  | { kind: 'map' }                 // first result per origin
  | { kind: 'local' }               // zero-to-many, barriers scoped inside child
  | { kind: 'predicate' }           // existence/truth
  | { kind: 'scalar'; total: boolean }
  | { kind: 'branch-arm' };
```

- `flatMap` and `local` keep all rows.
- element-body `map` selects the first row per origin.
- `where`/`filter` retain parents with a qualifying child row.
- `not` retains parents without one.
- `by()` requests at most one productive value per parent.
- `coalesce` chooses the first arm with any row for each origin.

This prevents `map`, `local`, and `by` from each growing another traversal parser.

### 7. Encounter order is metadata, not an accidental row order

`map(child)` and local range/order need a meaningful first row. SQLite relation order is
not a contract. Add optional encounter-order metadata to streams:

```ts
interface OrderState {
  readonly cols: readonly { col: string; dir: 'asc' | 'desc' }[];
  readonly explicit: boolean;
}
```

An explicit `order()` replaces it. Movement may append a stable incident-edge id as a
provider encounter key when a downstream operation observes first/range semantics. As
with `trackFromV`, gate this physical column on a chain requirement so ordinary hot-path
hops stay unchanged. If no order is semantically observable, do not carry it.

The first implementation may preserve the current provider choice (`id`/edge insertion
order), but it must encode that choice explicitly before deleting `local`'s existing
deterministic behaviour.

### 8. Specialized correlated SQL becomes an optimization, not a language boundary

Do not immediately delete the very efficient correlated predicate/scalar builders. A
simple `where(outE())` should remain an index-only `EXISTS`, and `by(outE().count())` need
not construct a general seeded child relation.

Reframe them as optional fast paths:

```ts
tryInlinePredicate(...): Expression | null
tryInlineScalar(...): ScalarExpr | null
```

They return `null` when they do not recognize a traversal. The caller then uses the
generic origin-indexed child compiler. They must never throw “not yet supported” merely
because the optimized vocabulary is exhausted.

Add equivalence tests that compile representative traversals through both paths and
compare results. This makes the generic child engine the semantic authority and the
inline forms safe optimizations.

## Shape compatibility and deliberate boundaries

The first version still requires branch arms to have compatible payload layouts. Node
versus edge versus scalar mixed arms require a row-level discriminant and dynamic framing;
that is a real separate feature, not a reason to weaken this refactor.

Define `unifyStreams(arms)` centrally. It may:

- accept identical scalar/list/map layouts;
- promote compatible numeric scalar type tags where TinkerPop defines promotion;
- pad compatible path layouts using the existing rules;
- reject incompatible element kinds or element/scalar mixtures clearly.

Do not add a wide nullable “anything row” to every traversal. If mixed-shape demand later
justifies it, add a gated `VariantStream` only at the branch seam and teach root
materialization to frame by a row tag.

The following remain outside the first migration:

- arbitrary barrier/side-effect bodies inside recursive `repeat()`; SQLite recursive
  terms have separate hard restrictions;
- sack split/merge semantics across forks;
- writes or traversal-valued merge/property arguments;
- dynamic mixed-shape branch framing;
- regex and stored-property runtime type tags.

The new architecture should make some of these easier later, but the refactor must not
claim them accidentally.

## Migration plan

Every numbered stage is a green commit or small green commit series. L1 and L3 may rise;
they must never fall. Do not keep a long-lived flag selecting old versus new whole
compilers—the migration is by step family, with narrow adapters at the boundary.

### Stage 0 — characterization and guardrails

Before structural edits:

1. Record the authoritative L3 baseline (833) in this plan and sync stale docs in the
   first behaviour-changing commit.
2. Add table-driven execution tests for the semantic distinctions the new scope must
   preserve:
   - duplicate parent traversers remain distinct;
   - empty child count = zero per parent;
   - empty child fold = empty list where required;
   - productive SQL-null value is not “no result”;
   - nested child scopes do not collide ordinals;
   - explicit order controls `map` first-result/local range;
   - aliases/path survive a child when semantically allowed.
3. Add `assertStreamColumns` and run it in tests/development.
4. Capture EXPLAIN assertions for simple `V().out().has()` and correlated `where`/`by`
   fast paths, not only property indexes.

### Stage 1 — make the physical stream contract true

1. Rename `St` to `ElementStream` and keep `type St = ElementStream` temporarily.
2. Standardize `rel` (remove the `last` versus `rel` naming split).
3. Require scalar/list/map CTEs to project carried columns they claim to own.
4. Introduce payload-column helpers alongside `carriedCols`/`carryFrag`.
5. Add property-element layout to `ElementStream`; initially bridge existing
   `compileProperties` output.

This is primarily structural. Terminal SQL should remain byte-identical where practical.

### Stage 2 — establish the one materialization boundary

1. Extract `materializeRoot(Stream)` into a new `steps/materialize.ts`.
2. Move the existing `Shape`/final-select decisions from projection/group/select/list
   leaves behind it.
3. Add temporary stream adapters for leaf compilers that still internally build their
   historical terminal relation.
4. Enforce with a source test or lint-like assertion: outside `render.ts`, write plans,
   and `materialize.ts`, no read-step module calls `readCompiled`.

At the end of this stage `compileRead` is visibly `seed → lower → materialize`, even if
some lowerers still use compatibility helpers.

### Stage 3 — replace the tail accumulator with stepwise value lowering

Convert scalar/list value steps to real `Stream → Stream` lowerers:

- `values`, `id`, `label` → ScalarStream;
- scalar transforms/casts → ScalarStream with preserved/replaced type metadata;
- `is`, `dedup`, `order`, `limit`, `range`, `skip` → relational stream operators;
- `count`, `sum`, `min`, `max`, `mean` → ScalarStream;
- `fold` → ListStream;
- `unfold` → shaped stream;
- list-local and set operations stay on ListStream.

Delete the `SCALAR_PROJ ... terminal count()` special case and the one-projection guard.
`foldTailAcc` may survive briefly only as a SQL-fusion optimization; it must no longer
define which chains are legal. Prefer deleting it and reintroducing local fusion after
correctness is stable.

Expected immediate result: general chained projections/reducers compose naturally, and
type tags survive reducers through explicit reducer result metadata rather than being
rejected in `renderProjection`.

### Stage 4 — convert structured element/value families

**Active checkpoint:** the scalar-producing leaf subset is complete: `map`/scalar
`local`, `math`, `format`, option-choose, and sack read now return ScalarStream and own
no trailing-step logic. `properties()` now returns a distinct PropertyStream (rather
than weakening the node/edge-only ElementStream invariant): its explicit
`vpid,owner,ownerLabel,pk,pv,pmeta + carry` schema supports relational filters, scalar
projection re-entry, and owner vertex/edge re-entry. That owner retype recovered the
three official `properties().element()` scenarios (vertex, filtered edge, all edges),
moving L3 848→851. The other structured streams remain.

The structured select slice is now complete at its first composable boundary. Single-label `select()` returns the selected
vertex/edge ElementStream, or a ScalarStream under `by(key)`, so it no longer owns a
terminal renderer. Multi-label `select`/`project` now lower to a heterogeneous wide-row
RecordStream rather than being forced into group()'s entry-per-row MapStream. Each
element field retains both its externally framed id and an internal rowid, so selecting
a vertex/edge field can re-enter movement even for string ids; scalar fields re-enter
ScalarStream, scalar-only `Column.keys/values` re-enter ListStream, and local
limit/range/skip/tail slice the record's static field layout. Record-local slicing
recovered nine official scenarios, moving L3 857→866 (after the earlier single-select
re-entry moved 851→857). The newly reachable grateful traversal with 24.3bn labeled
records exposed a tractability edge: the bulk optimizer now erases post-repeat labels
and final record construction only when `count()` is the sole consumer, propagating
bulk through each extra movement instead of enumerating rows.

`group()`/`groupCount()` now also lower once to a rich GroupStream regardless of
terminal position. Its physical layout truthfully represents scalar, element,
composite, reducer, and list-valued key/value columns; root materialization folds that
relation into GraphBinary, while `select(Column.*)` derives the narrow `(mk,mv)`
MapStream only for compatible layouts. The former duplicate `groupToMapStream`
semantic compiler is deleted. Inline groups, property-stream groups, and group
side-effects read through `cap()` all share `lowerGroup`. This checkpoint is
architectural (L3 stays 866) and preserves the 354-test suite.

`path()` now returns an explicit PathStream as well. Linear paths use a typed wide-row
layout described by their `PathPos[]`; recursive repeat paths use the existing grouped
`(pk,ord,element...)` layout. Both reach GraphBinary only through
`materializePathRoot`. Path consumers remain deliberately deferred—the architectural
change removes early materialization without pretending Path is already a ListStream.

Move the remaining terminal islands to streams:

- ~~`properties()` → PropertyStream~~ (kept distinct from node/edge ElementStream);
- ~~`select`/`project` → RecordStream~~ (record order/dedup/fold/where remain consumers);
- ~~`group`/`groupCount` → GroupStream at root and non-root alike~~;
- ~~`path` → PathStream/materialization strategy~~ (path-to-list consumers remain);
- ~~`map`, `math`, `format`, option-choose, sack read~~ return ScalarStream;
  ~~`cap` re-emits its stored ListStream/GroupStream through common dispatch~~.

Terminal fast framing remains in `materializeRoot`; semantic lowering no longer branches
on whether another step follows.

### Stage 5 — build `CompileScope` and generic `compileChild`

**Active checkpoint:** `tryCompileElementChild` is the first real shared child
compiler: it pushes the existing multiset-safe parent domain, runs movement/filter
bodies through the ordinary root `StepFn` fold, and applies a consumer cardinality
policy. `map()` uses `first` (`ROW_NUMBER() PARTITION BY origin`, empty children remain
unproductive); origin-safe `flatMap()` uses `all`. This recovered the official
`map(__.in().hasId(1)).limit(2)` scenario, moving L3 866→867. The first shared child
barrier is now `count()`: both `map()` and scalar `local()` lower it by LEFT JOINing
productive child rows onto the preserved parent domain and grouping by origin. Empty
children therefore emit an explicit Long zero, while duplicate equal parents remain
distinct. Scalar `values`/`id`/`label`/`constant` tails now use the same child domain:
their productive values are physical rows (including productive NULL), and `map()`
selects the first row per origin after the ordinary movement/filter fold. This fixes
the old correlated-scalar ambiguity where a missing property could masquerade as a
NULL traverser. Remaining scalar specializations retain the correlated fast path;
further barriers and structured tails are the next expansion. `flatMap()` has moved
from the element-only PREFIX registry to shape-aware dispatch and applies the same
child compiler with `all`, so scalar projection rows and element rows flatten through
one cardinality policy. L3 remains 867; these migrations replace semantic islands and
fix productivity without claiming a conformance increase. Homogeneous scalar `union`
arms now concatenate child ScalarStreams with `UNION ALL`; a syntax-only child-shape
preflight leaves ordinary/nested element union on its mature prefix compiler and keeps
mixed shapes fail-closed. This recovered the official three-`constant()` union scenario,
moving L3 867→868. Three-argument predicate `choose` now applies its existing true/
false gates to homogeneous scalar child arms and merges their rows. Constant/value/
count combinations recovered four more official scenarios, moving L3 868→872; the
two-argument identity-else form and element arms retain the established compiler.
Homogeneous scalar `coalesce` now compiles every arm from one child domain and applies
the same first-non-empty-by-origin rule as element coalesce before dropping the internal
ordinal. L3 remains 872; notably, a zero from child `count()` is a productive result and
does not fall through to a later arm.
Scalar child rows now continue through the ordinary `lowerScalarRows` pipeline before
the consumer's `first`/`all` policy. `ScalarStream.encounter` is explicit physical
metadata: child transforms plus `is`/`order`/`limit`/`skip`/`range`/`dedup` use shared
window operations partitioned by the carried origin stack, and consumers then drop the
private origin/encounter columns. Nested chains run through `normalize()` just like
roots, so `order().by()` has one IR shape. This composes through map/flatMap/union/
choose/coalesce without a nested row-operator switch or accidental CTE ordering.
`lowerScopedScalarReducer` in `barrier.ts` then extends that same stream to
`count/sum/min/max/mean`: the parent domain makes the barrier total per origin, count
uses the non-null encounter marker so productive NULL is counted, and numeric `v,vt`
survives cardinality plus homogeneous scalar branch merges. `lowerScopedScalarFold`
uses that domain and encounter marker to emit exactly one ListStream per parent: empty
children become `[]`, while productive NULL remains `[null]`. Map/flatMap/local now
compose those list results through ordinary ListStream dispatch. Homogeneous scalar-
list union, three-argument choose, and coalesce arms share `unifyLists`; mixed
shapes still fail closed, and empty-list productivity makes coalesce stop correctly.
L3 stays 872.
Element-valued child `fold()` now uses the same domain/barrier architecture:
`lowerScopedElementFold` aggregates rowids per origin and carries a node/edge `ListOf`
tag, so map/flatMap/local followers use ordinary ListStream dispatch and `unfold()`
rejoins the correct table. Root materialization expands those rowids to ordered,
property-bearing element objects inside the compiled SQL before GraphBinary framing;
it never falls back to JS traversal interpretation or additional store queries.
`unifyLists` also merges homogeneous element-list union/choose/coalesce arms and rejects
incompatible item kinds. This recovered one official scenario, moving L3 872→873.
`local(child)` now routes through that compiler with `all` cardinality. Scalar
projection/transforms/reducers and element `limit`/`skip`/`range`/`dedup` all partition
by the child origin; aliases, path columns, and `otherV` context survive scope exit.
The movement-only parser and private window engine (`local.ts`) are deleted, and bare
movement local bodies are no longer rejected. The same element-row helper feeds scoped
`fold()`, so slicing/deduplication before an element fold is not a second compiler path.
L3 remains 873.

1. [x] Extract the existing `originSeed` into `steps/child.ts` as `pushChildScope`.
2. [x] Preserve the domain relation in `ChildFrame`.
3. [x] Compile element/scalar/list children through shared root lowerers.
4. [x] Implement `all` and `first` cardinality plus scalar/list barrier policies.
5. [x] Make scalar/element reducers and folds partition by active origins and use the
   domain for total empty results.
6. [ ] Add explicit `exists`/`notExists` policies as the generic where/filter fallback.
7. [ ] Extend nested-frame proofs through scalar/list `optional`.

This stage is the architectural milestone. A child traversal no longer has its own step
vocabulary.

### Stage 6 — migrate consumers and harvest unlocks

Migrate in increasing semantic complexity:

1. ~~`flatMap`: all child rows (element + scalar projection tails).~~
2. ~~element-body `map`: first child row per origin.~~
3. ~~homogeneous scalar/list arms for `union` and three-argument predicate `choose`.~~
4. ~~scalar/list arms for `coalesce`, preserving first-productive-arm semantics.~~
   Scalar/list `optional` remains.
5. ~~`local`: delete its movement-only parser and use child-scoped barriers.~~
6. `by(traversal)`: use child scalar cardinality plus productivity. Project scalar
   traversal/string/token modulators are done; bare-element project, select, group,
   sack/math/format/choose consumers remain.
7. ProductiveByStrategy: make productive/unproductive handling an explicit consumer
   policy rather than a strategy-wide rejection.
8. `where`/`filter`/`not`: keep inline fast paths; generic fallback uses child
   existence.

Ratchet after each consumer, not only at the end.

### Stage 7 — demote and delete the mini-compilers

1. Rename the surviving optimized pieces to `tryInlineScalar` and
   `tryInlinePredicate`.
2. Delete `compileNestedList`; generic child + fold owns its semantics.
3. Remove semantic throws from inline fast paths; unrecognized means fallback.
4. Delete `branchArm`'s prefix-only stop check.
5. ~~Delete `isScalarLocal`, the local-body movement whitelist, and local's private
   origin window implementation.~~ (`61d028d`)
6. Remove `dispatchNext` once `lowerSteps` fully supersedes it.
7. Remove the `St` alias.

### Stage 8 — optimize the unified model

Only after semantic migration is green:

- fuse adjacent scalar projection/filter/order/limit nodes where it reduces SQL;
- retain the single-hop optional fast path if equivalence tests justify it;
- preserve index-only correlated EXISTS/count fast paths;
- gate origin and encounter-order columns through a static requirement analysis so
  top-level hot traversals pay no extra columns;
- inspect CTE count and SQLite query plans for representative deep child traversals;
- run Bun and workerd/DO contract probes for window, JSONB aggregate, and binding parity.

Optimizations must consume the same stream/scope contracts. They are not allowed to
recreate a second supported-step vocabulary.

## Required test matrix

### Per-stage gates

- `bun test` fully green.
- L1 corpus remains 2298/2298.
- L3 remains at least the committed baseline and auto-ratchets upward.
- Worker dry-run/build remains green.
- Existing Bun/Cloudflare shared contract remains green.

### New structural tests

- Every stream's declared physical columns equal its relation columns.
- Only root materialization produces `Compiled`.
- Every step family has input-shape rejection tests.
- Root and child forms of the same linear traversal return equivalent payloads.
- Inline fast paths and generic child fallbacks are result-equivalent.
- Nested origin stacks use distinct columns and preserve outer correlation.

### Semantic child matrix

For each of `map`, `flatMap`, `local`, `union`, `choose`, `coalesce`, `optional`, and
`by`, cover child outputs of:

- zero, one, and many rows;
- node, edge, scalar, list, and map where compatible;
- duplicate inputs and duplicate child results;
- missing properties and explicit null values;
- movement + filter + projection;
- order/range/dedup/fold/reducer barriers;
- one nested child level, then two;
- incoming alias and path state.

### Performance guards

- Plain `V/out/in/both/has` SQL and plan do not gain origin/order columns when no child
  observes them.
- Property index searches remain index-backed.
- Simple `where(outE())` remains an index-only EXISTS fast path.
- Deep child lowering remains one SQL statement and does not emit one correlated query
  per parent row from JavaScript.
- Grateful repeat-count continues using the bulking specialization.

## Main risks and how the design contains them

### Empty-child semantics

The most dangerous correctness bug is treating absence as SQL NULL. The child-domain
relation and explicit productivity-by-row-existence rule are mandatory before migrating
reducers or ProductiveBy.

### Column drift

Origins, aliases, sack, fromV, path, encounter order, and payload columns can easily be
declared in one order and selected in another. Typed layouts plus
`assertStreamColumns` make disagreement immediate.

### CTE and SQL growth

Stepwise lowering may initially emit more CTEs than the fused tail. Correctness lands
first; Stage 8 restores fusion behind the unified contract. Measure generated SQL length,
prepare time, and EXPLAIN plans before and after.

### Hot-path regression

Origin and encounter order are requirements, not universal columns. A static chain scan
gates them just as `trackFromV` gates `otherV` state and path tracking gates path columns.

### Ordering claims

Do not rely on an accidental SQLite row order for `map(first)` or child range. Encode an
encounter key where the operation observes order and document the provider choice when
Gremlin leaves it unspecified.

### Static GraphBinary shape

Compatible shapes merge in this project. Mixed element/scalar arms stay fail-closed until
a deliberately scoped VariantStream exists. This is orthogonal to unified child lowering.

### Recursive repeat

The normal child compiler cannot be pasted into a SQLite recursive term: recursive
aggregates and multiple self references are restricted. Keep repeat's specialized term
builder and bulking engine, but make its input/output conform to the same Stream contract.

## Deletion and success checklist

The refactor is complete when all of the following are true:

- [ ] `compileRead` is `seed → lowerSteps → materializeRoot`.
- [ ] Every ordinary read leaf returns `Stream`, never `Compiled`.
- [ ] Only `materializeRoot` calls `readCompiled` for reads.
- [ ] Root and child traversals share `lowerSteps`.
- [ ] All stream-carried columns physically exist on their relations.
- [ ] Barriers derive global/per-origin behaviour from `CompileScope`.
- [ ] `only one projection step is supported per traversal` no longer exists.
- [ ] `branchArm` is not prefix-only.
- [x] `local.ts` is deleted; local has no private traversal parser/barrier engine.
- [ ] `compileNestedList` is deleted.
- [ ] `compileNestedScalar`/predicate specializations are optional `tryInline*` fast
      paths with generic fallbacks.
- [ ] ProductiveByStrategy has an explicit productivity policy rather than a global
      rejection.
- [ ] L1 is 2298/2298 and L3 has never regressed below 833 during migration.
- [ ] Existing hot-path EXPLAIN/performance guards remain green.

## Recommended first implementation series

Start with Stages 0–2 as the first PR/commit series: characterization, truthful physical
streams, and the single materialization boundary. Do not advertise a conformance gain for
that series. Its review criterion is architectural: the next series must be able to turn
`values()` into a ScalarStream and continue lowering without adding another special case.

Then take Stage 3 as one focused value-pipeline migration. It should delete the
one-projection ceiling and provide the first visible L3 gain while proving the new
root-lowering model. Once that is stable, the child scope work is considerably safer:
there will be one composable lowering engine worth reusing, rather than a child wrapper
around the old terminal tail.

That ordering is ambitious but disciplined: first make the internal result model true,
then remove early materialization, then reuse the resulting compiler recursively.
