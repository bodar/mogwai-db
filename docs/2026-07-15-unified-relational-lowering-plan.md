# Unified relational traversal lowering — root and child traversals through one compiler

**Date:** 2026-07-15  
**Status:** complete; Stages 0–8 landed
**Baseline:** full suite 373/373, L1 2298/2298, L3 933/2041; 247 compiler tests

## Restart handoff — read this first after a context reset

**Final checkpoint:** branch `refactor/unified-relational-lowering`; the published series
is on `trunk` through `cf56f75`, followed by local Stage 8 optimization checkpoints
`f8ee4e9` and `a9fb895`. The final seam-closing commit follows those locally. Run full
`bun test` before every commit; do not infer that local commits have been pushed.

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
7. Inline element `group()`/`groupCount()` scalar traversal keys now lower child-first,
   retain one productive key per parent, and join it back to the source element by a
   multiset-safe origin before the existing GroupStream barrier. Empty children drop the
   member; count produces zero; duplicate parents remain distinct. Stashed `cap()` and
   property groups keep their mature correlated paths. L3 remains 876.
8. Non-reducing scalar traversal values for inline element `group()` now lower through
   the same outer domain with `all` cardinality: every productive child row becomes a
   scalar-list member, missing children contribute nothing, productive NULL survives,
   and duplicate parents retain duplicate child rows. A generic key and value share one
   origin. Fold/tail stay on their existing barrier paths. L3 remains 876.
9. Inline group-scoped `count`/`sum`/`min`/`max`/`mean` now expose the raw productive
   generic child rows and reduce them once at the final group-key boundary. This removes
   the semantically wrong temptation to reduce per parent then combine those results.
   Count LEFT JOINs the shared parent domain so empty child domains contribute zero;
   numeric/comparable reducers use productive inner domains, and equal parent ids remain
   distinct traversers. Property groups retain the correlated compatibility path; named
   side-effect groups migrate in the next slice. L3 remains 876.
10. Scalar `…fold()` group values now expose raw generic child rows and fold once per
    final key, ordered by parent then child encounter. Empty groups produce `[]`, NULL
    remains a real member, duplicate parents contribute duplicate rows, and scalar keys
    are no longer rejected. Named `group('a')` specs retain their live source stream, so
    `cap('a')` uses the same path. The last `compileNestedList` consumer and the function
    itself are deleted. Moving `tail()` into the generic origin-partitioned scalar row
    pipeline restored the last legacy pre-fold form and raised L3 876→877.
11. `project` and aliased `select` now accept shaped traversal fields: scalar, first
    element, scalar-list, and node/edge-list fields share one outer-origin join and retain
    enough metadata for later field selection to re-enter ordinary lowering. Record root
    materialization expands element-list rowids only at the wire boundary; `unfold()` now
    preserves the list row's carried schema instead of assuming every list was global.
    Group-scoped whole-element `…fold()` uses the same raw child domain, retaining empty
    keys without framing phantom elements. L3 ratcheted 877→878.
12. ProductiveByStrategy is now an explicit policy on the consumers that can represent
    its result honestly: `group`, `groupCount`, `project`, and `select`. Those consumers
    preserve a productive SQL NULL while the ordinary path still drops an unproductive
    `by()` result; shaped records anchor on the parent domain and LEFT JOIN their fields.
    Unsupported `aggregate`/`order`/`path` consumers and nullable element fields still
    fail closed. Five official scenarios landed, raising L3 878→883.
13. The bold Stage 6 consumer tranche made productivity a typed stream property across
    aggregate/list/reducer boundaries. `aggregate().by(key|scalar traversal)` and
    `local(aggregate(...))` share one side-effect compiler; ProductiveBy NULL survives
    `cap`, local reducers, unfold, and global reducers. `order`, linear `path`, and
    alias-compare `where().by()` gained explicit productive policies. Generic child-row
    existence is now the fallback for `where`/`filter`/`not`, while the correlated SQL
    forms remain fast paths. Total fold/count children retype through `optional`, and
    sack traversal modulators consume retained first-child rows. L3 jumped 883→911.
14. A deliberately narrow `VariantStream` is now a relational sum type (`null | scalar |
    node/edge`) with one root GraphBinary materializer. Non-total scalar `optional()` emits
    every productive child value and restores the original element only for misses;
    `count()` is its first re-entry consumer. Nullable element-valued ProductiveBy record
    fields use the same contract and selecting such a field re-enters VariantStream.
    Element-valued `aggregate().by(__.…order().by(key))` uses an explicit child-first
    policy (partitioned property order, never incidental CTE order) and ProductiveBy
    restores misses as tagged nulls. This exposed and corrected the older `cap()` cardinality
    bug: cap emits ONE collection value; only explicit `unfold()` emits members. L3 911→922.
15. Modulated element `dedup().by()` is now a windowed consumer policy rather than a
    DISTINCT special case. Direct property/T.id/T.label keys and generic scalar child
    keys share first/productivity semantics; ProductiveBy retains one NULL-key member.
    `order().barrier().dedup()` records encounter as an opt-in carried role, so the first
    representative and downstream ordering are explicit rather than accidental CTE order.
    The direct key/order resolver is shared with child-first modulation, and `as()` now
    rebuilds every carried role through `carriedCols` instead of a hand-picked subset.
    L3 ratcheted 922→931.
16. Multi-input scalar consumers now share `tryCompileScalarModulations`: one outer
    multiset-safe ordinal, independently compiled child streams, optional/required joins,
    and explicit presence columns distinguish an unproductive child from productive NULL.
    `math` supports alias-rooted traversal variables, `format` traversal placeholders and
    option-map `choose` choice/bodies all use it. Only the selected option body's
    productivity is observed; an empty choice still reaches `Pick.none`. `mapscalar.ts`
    no longer imports `compileNestedScalar`, including for map/scalar-local. The official
    alias-rooted math scenario landed and L3 ratcheted 931→932.
17. Stage 7 began by deleting the `compileNestedScalar` symbol entirely. Sack traversal
    modulation now has only its retained child-row policy; composite `group().by(project)`
    keys compile every field as an independent first-child stream joined on one outer
    ordinal. Element-backed groups are forbidden from falling back to correlated scalar
    parsing. The surviving property-group/predicate optimization is named
    `tryInlineScalar` and returns null on an unsupported shape, so it cannot define
    language support or throw semantic policy. L3 remains 932.
18. The predicate optimization is now `tryInlinePredicate`: unsupported correlated
    forms return null and `where`/`filter`/`not` fall through to generic child-existence
    lowering. Element branch arms preflight through the shared child compiler before the
    compatibility fold, giving `limit` true per-parent semantics and letting `dedup`
    preserve nested branch ordinals. Duplicate equal parents are covered explicitly.
    The legacy branch fold remains only for bodies outside the current child vocabulary
    (nested branches/repeat and general all-row order). L3 remains 932.
19. `branchArm` and its private origin-safety vocabulary are deleted. The root,
    re-entry, generic child, and branch paths now share `lowerElementSteps`; its
    complete/non-materializing form is `tryLowerElementSteps`, and
    `tryCompileElementTraversal` composes child-frame row policies with full StepFn
    lowering. Nested `choose()` now retains optional/coalesce parent ordinals, and
    schema-preserving alias rebinds work inside correlated element children. Recursive
    `repeat()` remains an explicit physical boundary because its SQLite recursive term
    cannot carry arbitrary parent columns. Compiler suite remains 246/246, L3 ratcheted
    932→933, and the full suite is 370/370.
20. Recursive `dispatchNext` orchestration is deleted. Shape compilers now return
    either a terminal `Compiled` or a typed `LoweringContinuation {stream,at}`;
    `lowerSteps` is the single iterative owner of stream re-entry and consumes those
    continuations until root materialization. Element/scalar/list/map/record/group/
    property/variant/path transitions all cross this one loop, including inject roots.
    TypeScript, compiler 246/246, L3 933/2041, and full 370/370 are green.
21. Every fully typed terminal stream now exits through one exhaustive
    `materializeStream` dispatch owned by `lowerSteps`: scalar, variant, list,
    property, record, group, and path leaf modules no longer materialize themselves.
    MapStream is explicitly internal/non-terminal. The remaining materialization
    compatibility island is confined to the legacy element/scalar tail accumulator
    (plus shaped set/meta leaves that still need first-class stream kinds). TypeScript,
    compiler 246/246, L3 933/2041, and full 370/370 are green.
22. Stage 7 is complete. A terminal `ResultStream` now carries the legacy tail SQL and
    GraphBinary shape through the same continuation loop instead of returning `Compiled`.
    Projection/scalar compatibility tails, terminal set barriers, select/project records,
    and property meta results all yield streams; `materializeStream` is the single ordinary
    read exit. The root-only bulk-repeat count specialization deliberately materializes
    directly because it replaces the entire lowering pipeline. TypeScript, compiler
    246/246, L3 933/2041, full 370/370, and corpus 2298/2298 are green.
23. Stage 8 began with scalar relational fusion. A maximal adjacent transform/predicate
    segment now emits one CTE while predicates retain the expression visible at their
    exact chain position; root `order().limit/skip/range()` likewise emits one ordered,
    sliced CTE. Child-partitioned order/slice, dedup, reducers, and every cardinality
    boundary remain explicit nodes. Representative SQL shrank from five CTEs to three
    for `values().toLower().is().toUpper()`, and four to three for
    `values().order().range()`. TypeScript, compiler 246/246, L3 933/2041, full
    370/370, and corpus 2298/2298 are green.
24. The lowering/materialization boundary is now literal in the types. `lowerSteps`
    returns a final `Stream`, `LoweringResult` is only a continuation token, and neither
    imports nor returns `Compiled`. `compileRead` and the inject source explicitly call
    `materializeFinal` after semantic lowering; bulk-repeat remains the root-plan bypass.
    This makes the iterative core directly reusable by future child consumers instead of
    exposing a root-framed result. TypeScript, compiler 246/246, L3 933/2041, full
    370/370, and corpus 2298/2298 are green.
25. Multi-modulator consumers now reuse their already-pushed parent frame one child at
    a time. `project`/traversal `select`, generic group keys/values/reducers/folds, and
    math/format/option modulation no longer assign a redundant nested `ROW_NUMBER` for
    a seed that is provably one row per existing parent ordinal. The reuse marker is
    explicit and consumed by the next push, so genuinely nested or cardinality-expanded
    children still mint a fresh frame. Representative two-field `project` SQL fell from
    11 CTEs/1059 characters to 9 CTEs/861 characters and carries only `o0`, not `o0,o1`.
    TypeScript, compiler 246/246, L3 933/2041, full 370/370, and corpus 2298/2298
    are green.
26. Window rank/filter pairs now use the `q` kernel's typed `derived()` relation instead
    of allocating a named rank CTE followed by a named filter CTE. Scalar correlated
    slice/tail/dedup, element-child slice/first, modulated element dedup, element fold,
    aggregate traversal modulation, and sack traversal modulation keep the required SQL
    subquery boundary but expose only the semantic output relation to the Query graph.
    Together with frame reuse, the representative two-field project fell 11→8 CTEs;
    ordered local slice fell 8→7, and root modulated dedup fell 3→2. TypeScript,
    compiler 247/247, L3 933/2041, full 371/371, and corpus 2298/2298 are green.
27. Typed streams may now retain a derived relation directly instead of immediately
    wrapping it in another named CTE. Scalar correlated slice/tail/dedup and child
    first/all cardinality outputs use that contract; downstream stream lowering sees
    the same exact physical columns. The representative project fell again 8→7 CTEs
    (11→7 across Stage 8), and ordered local slice 7→5 (8→5 overall). New EXPLAIN guards
    assert these derived ranks remain SQLite co-routines rather than forced
    materializations and retain vertex-property/edge index probes. TypeScript, compiler
    247/247, focused performance 9/9, L3 933/2041, full 373/373, and corpus 2298/2298
    are green.
28. The last architectural seams are closed. Ordinary scalar child traversals now call
    the same iterative `lowerSteps` engine as roots; child projections carry an explicit
    per-origin encounter key so `map(first)`, `flatMap(all)`, local order/range, and
    reducers keep their cardinality policies outside the traversal compiler. Scoped
    folds/reducers accept `ChildScope` and derive their current domain/ordinal internally
    instead of receiving loose coordination arguments. Finally, a second projection is
    a typed stream boundary: the first scalar projection is rendered and re-enters the
    dispatcher, while an incompatible follower gets a shape-specific error. The global
    `only one projection step is supported per traversal` ceiling is deleted and guarded
    structurally. TypeScript, compiler 247/247, focused performance 9/9, L3 933/2041,
    full 373/373 (including the shared Bun/workerd contract), and corpus 2298/2298
    are green.

**Current Stage 6 state:** scalar traversal modulators for `project`, aliased `select`,
and inline element `group` all use the generic child-domain compiler. Group keys consume
`first`, non-reducing values consume `all`, and group reducers consume raw rows at the
final key barrier. These consumers share multiset-safe origin joins rather than private
correlated traversal parsers. ProductiveBy is explicit at group/groupCount/project/select,
aggregate, order, dedup, linear-path, and alias-compare boundaries, including nullable
element records and aggregate members. Multi-input math/format/option-choose modulation
also uses one generic child domain. L3 is 933.

**Completion state:** representative project/local/scalar-child plans are guarded by
EXPLAIN tests; single-use streams and window ranks retain typed derived relations; roots
and ordinary scalar children share iterative lowering; scoped barriers consume scope.
The single-hop optional, correlated count/EXISTS, and bulk-repeat fast paths remain as
measured semantic/performance policies behind the same Stream/scope contract.

**Deliberate compatibility boundaries after Stage 6:** broader VariantStream followers,
property groups without a live element parent, element-kind-changing optional fallback,
and general all-row ordered element streams remain unsupported. The new opt-in encounter
role makes map-style first and ordered dedup explicit; it does not invent semantics for
those broader cases.

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
- iterative `lowerSteps` now proves that every shape can re-enter compilation through
  typed continuation tokens.
- `Carried` now makes physical traverser columns explicit and preserves aliases/path
  through branch merges.
- `Carried.origins` is a nested ordinal stack, proven by nested
  `optional`/`coalesce`.
- `lowerElementSteps` proves ordinary element steps can compile from an already-seeded relation.
- `local` proves a window partitioned by an input ordinal gives correct per-traverser
  barriers.

What remains is mostly the negative space between them. Read leaf compilers still call
`readCompiled` themselves, so they stop being composable. `lowerElementSteps` stops at the first
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

The refactor began with six overlapping semantic compilers:

1. `lowerElementSteps`: non-materializing element `StepFn` lowering, shared by roots,
   re-entry, generic children, and branch arms.
2. `foldTailAcc` + `renderProjection`: scalar projection/modifier/reducer lowering,
   usually straight to `Compiled`.
3. `dispatchNext`: partial recursive shape re-entry for scalar/list/map streams
   (deleted by item 20 in favour of iterative `lowerSteps`).
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
6. [x] Add explicit `exists`/`notExists` policies as the generic where/filter fallback.
7. [x] Extend nested-frame proofs through scalar/list `optional`; non-total scalar output
   uses a tagged scalar-or-original-element VariantStream.

This stage is the architectural milestone. A child traversal no longer has its own step
vocabulary.

### Stage 6 — migrate consumers and harvest unlocks

Migrate in increasing semantic complexity:

1. ~~`flatMap`: all child rows (element + scalar projection tails).~~
2. ~~element-body `map`: first child row per origin.~~
3. ~~homogeneous scalar/list arms for `union` and three-argument predicate `choose`.~~
4. ~~scalar/list arms for `coalesce`, preserving first-productive-arm semantics.~~
   Total scalar/list and non-total scalar `optional` are done; element-kind-changing
   fallback remains.
5. ~~`local`: delete its movement-only parser and use child-scoped barriers.~~
6. ~~`by(traversal)`: project/select/group/aggregate/sack/math/format and option-choose
   use child cardinality and shared modulation domains.~~
7. ProductiveByStrategy: group/groupCount/project/select/aggregate/order/dedup/path/where
   now have explicit policies, including nullable element fields.
8. ~~`where`/`filter`/`not`: inline fast paths plus generic child-existence fallback.~~

Ratchet after each consumer, not only at the end.

### Stage 7 — demote and delete the mini-compilers (complete)

1. ~~The surviving optimized pieces are `tryInlineScalar` and
   `tryInlinePredicate`; unsupported means null/fallback.~~
2. ~~Delete `compileNestedList`; generic child + fold owns its semantics.~~
3. ~~Scalar and predicate inline misses return null; semantic support lives in generic lowering.~~
4. ~~`branchArm` and its compatibility fold are deleted; nested element branches use
   the shared non-materializing element-step lowerer.~~ Recursive repeat and general
   all-row order remain explicit physical-policy boundaries.
5. ~~Delete `isScalarLocal`, the local-body movement whitelist, and local's private
   origin window implementation.~~ (`61d028d`)
6. ~~Remove recursive `dispatchNext`; shape compilers yield typed continuations to the
   iterative `lowerSteps` owner.~~
7. ~~Remove the `St` alias; source uses `ElementStream` directly.~~
8. ~~Route every ordinary read leaf through `Stream`; a terminal `ResultStream` contains
   compatibility SQL/shape until the one `materializeStream` boundary.~~

### Stage 8 — optimize the unified model (complete)

Only after semantic migration is green:

- ~~fuse adjacent scalar transform/filter nodes and root order+slice where it reduces SQL;~~
- ~~extend fusion to safe projection/filter/order/limit boundaries where measurement
  showed a planner or prepare-time win;~~
- ~~retain the single-hop optional fast path behind equivalence tests;~~
- ~~preserve index-only correlated EXISTS/count fast paths;~~
- ~~gate origin and encounter-order columns by child scope so top-level hot traversals
  pay no extra columns;~~
- ~~reuse a consumer's existing one-row-per-parent frame instead of assigning a second
  ordinal independently inside every sibling modulation;~~
- ~~inspect CTE count and SQLite query plans for representative deep child traversals;~~
- ~~replace mechanical rank-CTE/filter-CTE pairs with one typed derived-table relation;~~
- ~~run the shared Bun and workerd/DO contract, including window, JSONB aggregate, and
  binding paths.~~

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

Compatible shapes merge in this project. A deliberately scoped VariantStream now covers
null/scalar/one element-kind rows at optional, nullable-record, and aggregate boundaries;
incompatible element kinds and heterogeneous lists still fail closed. This is orthogonal
to unified child lowering.

### Recursive repeat

The normal child compiler cannot be pasted into a SQLite recursive term: recursive
aggregates and multiple self references are restricted. Keep repeat's specialized term
builder and bulking engine, but make its input/output conform to the same Stream contract.

## Deletion and success checklist

The refactor is complete when all of the following are true:

- [x] `compileRead` is literally `seed → lowerSteps(Stream) → materializeFinal`.
- [x] Every ordinary read leaf yields `Stream`, never `Compiled`.
- [x] Only `materializeRoot` calls `readCompiled` for reads.
- [x] Root and ordinary scalar child traversals share `lowerSteps`; recursive SQLite
      terms and scoped aggregate physical policies remain explicit by design.
- [x] All stream-carried columns physically exist on their relations.
- [x] Scoped barriers derive their domain and ordinal from `CompileScope`.
- [x] `only one projection step is supported per traversal` no longer exists.
- [x] `branchArm` is deleted; element branch arms use shared stream lowering.
- [x] `local.ts` is deleted; local has no private traversal parser/barrier engine.
- [x] `compileNestedList` is deleted.
- [x] Scalar/predicate specializations are optional `tryInline*` fast paths with
      generic fallbacks.
- [x] ProductiveByStrategy has explicit policies for every supported consumer rather
      than a global rejection.
- [x] L1 is 2298/2298 and L3 has never regressed below 833 during migration.
- [x] Existing hot-path EXPLAIN/performance guards remain green.

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
