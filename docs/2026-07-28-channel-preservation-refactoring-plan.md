# Channel-preservation refactoring plan

**Status: in progress, 2026-07-28.** This is a broad application of
the pattern distilled in [the `ScalarType` retrospective](./2026-07-28-scalartype-refactoring-pattern.md).
It is deliberately not a proposal for a universal shape algebra: the evidence in
[the shape vocabulary architecture](./2026-07-28-shape-vocabulary-architecture.md)
rules that out. The target is narrower and more consequential: make information
preservation explicit at every compiler boundary, then apply that discipline where
measurement says it prevents real defects.

## Execution log — resume here

The plan began from `82992c7`; every tranche below passed `mise run ci` before its
local checkpoint. The current branch also merged upstream `origin/trunk` at
`9483d75` (including `c75ff5d`, the scalar-child classify/emitter agreement fix)
and CI passed after that merge.

**The whole channel was RENAMED on 2026-07-29** (`Carry`/`Carried` → `LoweringState`/
`TraverserLayout`, and every `carry*` function with them). The completed-tranche log below keeps the
names those commits actually used — it is a record, not instructions — so read it against the rename
map in [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md). Everything
from Phase 1 onward is remaining work and uses the CURRENT names.

Completed preservation tranches:

- `2096c41` — adds `carryThrough`, routes scalar preserving rebuilds through it,
  and replaces routine raw carried patches with `carriedWith`/`withCarried`.
- `1a7430a` — makes `carryOf(stream, carried)` the named carry reconstruction
  route and adds checked `toElementStream` construction at shape boundaries.
- `8119142` — adds `rehomeCarried`; `optional` and `coalesce` now state the
  child-result → parent-origin re-home transition rather than spreading `origins`.
- `83f0745` — names the path-child drop (`withoutPath`) and the chain-level
  `otherV` requirement (`trackFromV`).
- `5079061` — routes branch merge, ordered element projection, and label
  element rehydration through `toElementStream`, so their carried schema is
  asserted at construction.

Completed ScalarType/planner tranche:

- `3161b04` — replaces planner `TypeCtx`'s `staticAs?`/`vtypeExpr?` pair plus
  implicit absence with its own total expression-level union:
  `static | perRow(expr) | unknown`.
- `5c1f759` — adds the named bridge `typeCtxOf(ScalarType, columnResolver)`.
  This is intentionally NOT a unification of the two vocabularies: stream
  `ScalarType.perRow` names a relation column; planner `TypeCtx.perRow` owns the
  SQL expression for that column in its current scope.
- `63efc68` — `MapEntry { sub: 'value' }` now owns a required
  `ScalarType`; record projection carries prefixed per-row type columns, scalar
  field re-entry restores them, and Map framing uses the declared channel.
- `4eaddbc` — deletes the deprecated `ScalarOpts.vtype` construction adapter and
  the `scalarType(as, vtype)` bridge; every compiler scalar-stream constructor now
  declares `STATIC`, `PER_ROW`, or `UNKNOWN` explicitly.

The current baseline is CI-green and pushed to `origin/trunk` at `4eaddbc`.
Phase 2 scope item 4 is complete: prefixed per-row type columns travel with record
fields, static/unknown fields are explicit, and `execute.ts` frames from that
channel. The UUID-equivalence and physical-layout assertions pass. The census
delta is six known answers: projected stored count values now frame as GraphBinary
Long rather than an inferred Int; the corpus's execution, deferral, and crash
counts are unchanged.

The next measured ScalarType seam is scalar label history: `as()` must retain a
per-row stored type through the JSON history entry so a later `select()` can frame
UUID/date/long values exactly. List-member shape/type preservation remains part of
that alias tranche; do not treat a scalar-label fix as a complete alias migration.

Completed alias checkpoint:

- Scalar `as()` entries now carry either their static tag or their stored per-row
  type in JSON history; `select()` reconstructs the channel for scalar output and
  record fields. List aliases retain their member descriptor, including typed
  scalar members. The focused UUID/datetime/Long, record, and folded-list tests
  pass.
- The census delta is two deliberate answers: a Long label surviving a `union()`
  or a scalar-ending `match()` is now framed as GraphBinary Long rather than
  inferred Int. Execution, deferral, and crash counts are unchanged.

Completed local-shape/cardinality checkpoints:

- `1af3424` — closes the front-end tagged-argument union, explicit frame/write
  contracts, and the lowering-local `RelationalCardinality` vocabulary. Global
  count now has one authority that distinguishes per-row, whole-result, and
  grouped-path relations; record/variant positional operations honour encounter
  order when it is live.
- `653b8c7` — makes `Shape.jsonbList.items: ListOf` total. The prior competing
  `as`/`typed`/`of` optional channels are gone; materialization and framing carry
  the same member descriptor without reconstruction.
- `5686ee2` — makes `Shape.variant` a declared list of scalar/vertex/edge/list
  arms. The scalar arm has an explicit `ScalarType` (`unknown` rather than an
  absent tag), and the framer validates a row tag against the declared arms.

Completed capability-ratchet checkpoint:

- `523173d` — the L5 capability gate now generates one deterministic witness
  for each independently-authored `(input shape, transition)` edge (112 at the
  current table), in addition to 240 random nested compositions. It permits
  executions and declared deferrals, while rejecting new raw failures against
  the committed generated-witness baseline. The focused run reported 266
  executions and 86 declared deferrals; full CI stayed green with the census at
  `ran: 1426, deferred: 474, unbound: 381, crashed: 17`.

Completed IR-annotation experiment (negative result):

- A test-only, conservative root-chain probe was run over all 2,298 L1 inputs
  plus 600 independently generated L5 chains. It had zero disagreement with the
  generated terminal shapes, but 1,645/2,898 inputs (56.8%) were `unknown`, far
  above the pre-committed 10% adoption ceiling. The existing pure child
  classifiers are therefore not evidence for adding a production root-shape
  annotation; lowering remains the sole owner of shape interpretation. The probe
  also corrected the L5 walker's member-shape bookkeeping: list-preserving local
  transforms no longer overwrite the shape remembered by a preceding `fold()`.

Phase 1 tranches (current names throughout):

- `66cb779` — **`mergeLayouts` becomes THE merge authority, with the rigid check as a POLICY.** It
  had one caller while three sibling merges called `mergeAliasMaps` directly, taking the alias half
  of the contract and skipping the rest. The fix is the missing concept, not a weaker assertion: one
  REQUIRED `RigidRolePolicy` — `'peer'` (same-scope arms; rigid roles must agree, fails closed) or
  `'rehomed'` (child-scoped arms already re-homed onto the parent; label sets only). `mergeAliasMaps`
  is now module-local, so the route is structural; the `.size !== .size` grew-a-column comparison
  each copy spelled inline is `layoutGrewAliases`. No SQL moves — the L2 snapshots are unchanged.
  **A measurement correction landed with it:** the index's "113 hand-written layout spreads" counted
  `...layoutCols(...)` expansions, which are the single-source-of-truth column list and precisely
  what a preservation route is supposed to look like. The real count of `TraverserLayout`-valued
  object spreads is ~13, and each one is a construction site.

## North star

Every compiler boundary must make one of three outcomes explicit:

1. it preserves a channel;
2. it intentionally retypes, re-homes, or degrades that channel; or
3. it declines the operation.

Here, a *channel* is information that rides with a relation but is not necessarily
the current Gremlin value: scalar type, aliases, origins, bulk, encounter order,
or the relation's row-to-traverser cardinality. The recurring failure mode is an
anonymous object spread or hand-written projection that loses one of those facts
while still returning rows. That is worse than a crash and violates the project's
fail-closed rule.

The end state is not one all-purpose type. It is a small set of total,
purpose-specific vocabularies, each with:

- one question it answers;
- a designated merge authority;
- a named preserving rebuild;
- runtime assertions at the relational boundary; and
- an oracle that can detect a silent behaviour change.

## Constitution for a vocabulary migration

Every candidate must pass this sequence before implementation begins.

1. **Name one question.** Do not merge vocabularies merely because both contain a
   `kind` field. In particular, `Stream`, `Shape`, `Elem`, and `ElemShape` remain
   separate: capability partition, framing, storage selection, and wire selection
   are different questions.
2. **Measure the defect and duplication surface.** Count diagnosed bugs, optional
   fields, hand-written spreads, duplicate narrowing, and duplicate physical-column
   derivations. An architecture sketch alone is not evidence.
3. **Make the logical state total.** Replace N optionals answering one question
   with a discriminated N+1-case union. The unknown/implicit case is a named member,
   never absence.
4. **Retain member information in the finest case.** A list-like case records what
   it contains; a per-row type case records its type column; a cardinality case
   records its partition/run key where needed. Coarse views are derived from this
   representation.
5. **Expose named coarse accessors.** Consumers use accessors such as
   `staticTypeOf`, `perRowColumnOf`, or a channel-specific equivalent, rather than
   repeating inline discriminant checks.
6. **Add a preserving rebuild and a merge authority.** A relation-preserving
   operation has one named rebuild helper. A join, union, branch, or recursive
   boundary has one named merge helper. Sites that cannot preserve a channel say
   exactly how it is transformed or dropped.
7. **Make coupled hand-offs unseparable.** If a classifier or planner produces a
   shape-determining prefix plus residual work, a value plus its type channel, or
   any other pair that must travel together, represent it as one typed carrier.
   Do not add a second optional parameter with a default: that lets a caller hand
   off the first half and silently drop the second. `ChildPlan`/`ChildBody` is the
   model: a child emitter receives one argument containing both classified body and
   suffix, so the generic suffix cannot be forgotten at one of many call sites.
8. **Assert the physical contract.** Validate that every column declared by the
   logical vocabulary is present in the relation. A claimed per-row type column or
   carried alias column that does not exist must throw a declared deferral.
9. **Migrate under a bridge, then delete it.** Initially derive the new vocabulary
   from the old fields in one place. Once callers are migrated, delete the bridge so
   TypeScript reveals the complete remaining worklist.
10. **Prove the result by measurement.** Require focused regression tests, census
   stability or a deliberate pinned delta, and no crash-count increase. L5
   differential agreement alone is insufficient because both configurations can
   share the same wrong answer.

## Phase 1 — Measure, then make `TraverserLayout` a preservation contract

**Why first.** The historical defect census found dropped carried/optional roles in
12 of 36 written diagnoses (33%). That is evidence for this direction, not a claim
about the remaining work: `mergeLayouts` and subsequent fixes have already reduced
the surface. Before changing code, re-measure the current diagnosed defects,
`patchLayout` call sites, hand-written `...traverserLayout` spreads, and the locations of
each layout role. Record the commit and measurement in the phase design note.

This phase applies the `rebuildScalar` half of the ScalarType pattern; `TraverserLayout` is
intentionally a collection of distinct roles, not a candidate for one monolithic
shape union.

### Current trunk anchor

`mergeLayouts` now exists, but its deployment is intentionally narrow: the
same-scope element-arm merge calls it after supplying that merge's path policy. It
unions aliases and asserts that rigid physical roles agree. This is a useful first
authority, not evidence that every apparent merge can call it unchanged.

In particular, list/scalar child arms are first re-homed onto their parent
cardinality. Their child scope has minted an ordinal the parent does not have, so
calling the current rigid-role assertion there would reject valid `coalesce` and
related forms. Those sites deliberately merge aliases only after re-homing. The
generalisation must preserve that distinction: normalize/re-home a child result at
the child boundary, then merge only the roles that remain meaningful in the parent
scope. Do not weaken `mergeLayouts`'s assertion merely to make such a call type
check.

### Design

- Make `mergeLayouts` the sole authority for **same-scope peer-arm merges**. Map
  every candidate boundary first: a child rejoin, keyed relation, or recursive term
  may instead be a preservation/re-home boundary, not a peer merge.
- Where a merge combines child-scoped arms, establish the explicit sequence
  `child result → re-home to parent schema → merge`. Generalise the authority only
  after this normalization makes its rigid-role policy true; otherwise preserve the
  existing narrow alias merge and state why.
- Classify each role's merge policy explicitly:
  - unionable (for example aliases);
  - preserving/identical (for example a compatible origin or encounter role);
  - incompatible, producing a declared deferral rather than an invented value.
- **`withRelation` (was `carryThrough`) already exists** — landed in `2096c41`, so this is a
  DEPLOYMENT task, not a construction one. Any operation that changes only its relation calls it;
  an operation that changes layout state uses an explicit `retype`, `rehome`, `drop`, or `degrade`
  operation instead.
- Extend `assertStreamColumns` to verify declared layout-role columns as well as
  payload and per-row type columns.
- Replace hand-written `...traverserLayout` spreads. The migration is complete only when
  the remaining spreads are documented intentional construction sites, not routine
  preservation paths.
- Introduce the preserving/transformation verbs with the helpers themselves. In
  particular, routine paths must not use `{ ...stream }` or `{ ...traverserLayout }` to
  mean “preserve semantics”; they call `withRelation`, `mergeLayouts`, or a named
  `retype`, `rehome`, `drop`, or `degrade` helper.

### Proof and exit gate

- Add regression coverage for preservation through barriers, child rejoin, arm
  merges, keyed relations, and recursive terms. Include paired tests proving that
  a label bound *after* a barrier survives an arm merge while a label consumed *by*
  that barrier is not silently resurrected.
- For every newly migrated merge, test both a same-scope arm and a child-scoped
  arm. The latter must either re-home before merging or fail with a declared
  deferral; it must never inherit a child-only ordinal or silently omit it.
- Run the census before and after each mechanical tranche; investigate every status
  transition, especially deferred-to-rows and rows-to-empty.
- The exit criterion is structural: new carried roles have one merge policy, one
  preservation route, and one physical assertion point.

## Phase 2 — Complete `ScalarType` end to end

**Why second.** ScalarType is the demonstrated cross-file vocabulary win, but it
still coexists with raw `as?: ValueType`, `typed` flags, per-row-type conventions,
and no type channel for some map/record value paths.

### Scope and order

1. Migrate `TypeCtx` and planning expressions, which already describe the three
   modes in comments.
2. Migrate `VariantStream` and the scalar-bearing list/map/record shape arms.
3. Migrate aliases, including list members.
4. Migrate `MapEntry{sub:'value'}` and record-field projection so every scalar
   framing path has an explicit type source.
5. Migrate framing and write-plan result rows; remove legacy adapters and raw
   optional fields once callers have moved.

### Invariants

- Logical type is total; physical encoding stays local. A typed JSON node, a bare
  value with a sibling vtype column, and a compile-time type are representations of
  one logical question, not reasons to force a uniform `{t,v}` envelope.
- `unknown` is reachable only at the client-value seam unless an explicitly
  documented new seam introduces it.
- A map or record value cannot silently fall back to JavaScript inference merely
  because it crossed a projection boundary.

### Proof and exit gate

Add end-to-end framing tests for identical logical values arriving through
`values()`, `project()`, aliases, list members, map entries, and records. UUID-like
values are the key regression: all equivalent routes must frame equivalently.

## Phase 3 — Finish only the weak local shape vocabularies

**Why this is not a shape-algebra project.** Cross-layer unification targets little
of the measured defect surface and would erase load-bearing boundaries. This phase
instead repairs the specific local records that omit information or encode a union
as optional fields.

### Targets

- Replace `Shape.variant`'s all-optional representation with a discriminated union
  of its actual framing cases.
- Replace `Shape.jsonbList`'s competing `as`/`typed`/`of` channels with one item
  description union.
- Make `AliasShape` record member shape, enabling element and path lists to frame
  their contents correctly.
- Declare a front-end union for tagged argument tokens and centralise their guards
  and unwrapping accessors.
- Close undeclared wire/write unions that are currently represented by key
  presence or undocumented accepted object forms.

### Non-targets

- Do not merge `Stream` into `Shape`.
- Do not merge `Elem` and `ElemShape`.
- Do not widen `ChildShape` to map merely to make a dispatch table look uniform.
- Do not impose a uniform typed JSON representation on relational operations.

### Proof and exit gate

For each target, record the exact reconstructed or repeated narrowing it replaces.
The migration is complete when consumers use named projections of the new union and
the former reconstruction cannot be reintroduced without a type error.

## Phase 4 — Name row-to-traverser cardinality

**Problem.** A relation can have one row per traverser, one whole-result traverser,
or multiple rows forming runs for one traverser. That distinction is currently
encoded indirectly in separate shapes and ad hoc SQL, making some apparent drift
real and some necessary.

### Design

Introduce a narrow relational-cardinality vocabulary, owned at the lowering/framing
boundary rather than the IR. Its initial cases should express at least:

- `perRow`;
- `wholeResult`; and
- `runsByKey`, including the key that identifies a traverser run.

Use it to divide helpers into three categories:

| Class | Consequence |
| --- | --- |
| Row-algebraic | One shared implementation is safe. |
| Current-object | A named authority may generalise only where it can name the value expression. |
| Shape-interpreting | Per-shape lowering remains correct. |

This is the prerequisite for safely sharing count, slice, and related row operations.
It also supplies the right place to make variant/record slicing deterministic when
an encounter order is available. That is a user-visible semantic deliverable, not
an incidental cleanup: today equivalent limits can select a deterministic window on
a scalar stream and an arbitrary window on a variant/record stream. Decide the
ordering rule explicitly, update the affected L2 expectations, and pin the new
behaviour in L4 features.

### Proof and exit gate

Pin semantic changes such as deterministic slicing in L4 features. For every
shared operation, test a per-row stream, a whole-result stream, and a grouped/path
run stream so that `COUNT(*)` cannot accidentally replace `COUNT(DISTINCT key)`.

## Phase 5 — Make capability and fail-closed behaviour executable

Build the matrix ratchet described by the shape architecture:

1. Generate a witness for each `(input shape, transition)` pair.
2. Classify it as compiled, declared deferral, or unexpected failure.
3. Fail the gate on crashes, raw SQLite errors, null dereferences, malformed SQL,
   and any other non-declared failure.
4. Generate the relevant per-step support strip in
   `docs/feature-support-matrix.md`, while keeping the L5 generator independent of
   dispatch maps.

Seed the ratchet with an explicit, committed baseline for known failures, including
the existing raw-crash inventory. It must distinguish a newly introduced unexpected
failure from a known one that is still awaiting repair; otherwise the initial gate
is red by construction. This is the safety net for all mechanical migrations. It
detects the distinction between “the result stayed the same” and “both versions
silently answer the same wrong question.”

## Phase 6 — Test, do not assume, IR shape annotations

The refined boundary is: a Pass may consult shape information and decline, but it
may never construct a shape claim or provide shape-dependent lowering. Test whether
an annotation is useful before changing production IR.

- Build a test-only propagation oracle using existing classifiers over L1 and
  generated L5 traversals.
- Commit the kill criterion before the run: unsoundness must be zero, and the
  unknown/top rate must be at most **10%**.
- If it passes, hoist only the annotation and enforce the anchor rule at the type
  level. Lowering remains the owner of shape interpretation.
- If it fails, record the rate and kill the idea. That is useful negative evidence,
  not an unfinished migration.

## Delivery discipline

The execution order is:

1. Re-measure and scope `TraverserLayout`, including focused preservation regressions.
2. Build the matrix ratchet, seeded with its known-failure baseline.
3. Complete the `TraverserLayout` preservation contract.
4. Complete ScalarType; its named transformation vocabulary is introduced as part
   of this and the preceding phase, not as a later rename pass.
5. Repair weak local shape vocabularies.
6. Name cardinality, decide deterministic slicing, and then share only proven-safe
   row operations. This is the prerequisite for parent-shape row-operation work.
7. Run the test-only IR annotation experiment.

No phase is authorized merely because the prior phase is aesthetically complete.
Each must begin with a fresh code measurement and a short design note that records:

- the defect mechanism or duplication it targets;
- the current baseline and oracle coverage;
- the preservation/merge/contract authorities it will introduce; and
- the precise exit condition, including any expected census delta.

At each sensible implementation seam—after a compatibility bridge, a coherent
migration tranche, a bridge deletion, or a completed phase—run `mise run ci`.
When it is green, create a local commit containing that coherent checkpoint. These
commits are deliberately local: this plan authorizes no push, PR, or other remote
publication. A failed CI run stops the tranche for diagnosis; do not commit a known
red checkpoint merely to preserve progress.

That discipline is the point of applying the ScalarType lesson broadly: be bold
about eliminating silent information loss, and conservative about inventing
structure that has not earned its keep.
