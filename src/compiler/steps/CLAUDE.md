# src/compiler/steps — the lowering surface

_Scope: `src/compiler/steps/**`. The engine/passes/DI that dispatch here are in `src/compiler/CLAUDE.md`
(this seam reaches the engine via `engineOf(stream)`). SQL kernel: `src/sql/CLAUDE.md`._

The read prefix is a functional fold of `StepFn`s over an immutable typed **`Stream`** union
(element/scalar/variant/list/property/record/group/path). `lowerSteps` is the one shape
orchestrator; retypes flow it back through itself (`V().fold().unfold().out()` = elements→list→
elements). Emission-order and child-scope rationale: the dated design docs in `docs/`.

## Extend the generic seam, don't special-case the scenario

The goal is *generic lowering that composes the full nested Gremlin grammar at any valid depth or
combination* — every child body admitted at every position, every branch/loop/scope carrying every
shape (the "ceiling" — see `test/CLAUDE.md` for the L3-floor-vs-ceiling framing). So when a gap can
be closed two ways — a one-off "implement step X for exactly the scenario that's failing" or
extending the **generic seam** so a whole family of nested compositions lowers at once — close it
generically, even when the narrower fix would pass the failing scenario sooner. A `throw` that
fails closed is better than a special-case that entrenches the non-generic path.

## Guardrails

- **`lowerSteps` is the single semantic authority for read traversals**, at root and child scope.
  To add a step: write a `StepFn`, register it in the right Map (never grow a switch); for a child,
  push a `ChildScope` and run the same engine; materialize only at the root.
- **Never build a second implementation.** No private child-traversal parser, no `compileNested*`
  mini-compiler, no sibling/index scanning inside a step compiler, no second movement/filter/
  projection path, no materializing from a read leaf. If a step needs one of these, the design is
  wrong — reuse the generic seam instead.
- **The child seam is RESULT-shape generic too: there is ONE cardinality rejoin.**
  `applyChildCardinality` (`tail/child.ts`) restores parent cardinality for EVERY shape — it derives
  the payload from `streamPayloadCols` (`context/stream.ts`, already the single authority on a kind's
  own columns) and re-homes the stream by spread, so `type`/`result`, `keyOf`/`valOf`, `elem`, `of`,
  `fields` and `layout` ride along untouched. **Adding a shape to the child seam must add nothing
  here.** A shape-specific rejoin is how the scalar path grew its own copy (retired); if a new shape
  seems to need one, the payload authority is what's missing, not the rejoin.
  It takes the **frame**, not the whole `pushChildScope` triple — a POST-BARRIER caller (a child
  `fold()`, a bare-branch child) holds only the frame a row compiler handed back, and demanding the
  triple is what made those sites hand-roll the projection (the same "cannot be HANDED this"
  argument-type tell as below). A child body's tail barrier still cannot come from the engine's own
  step: `fold()`/reducers there are GLOBAL, and the per-parent form needs the frame's domain
  relation for its empty-child `[]`, which is child-seam state and not reachable from a `Stream`.
  Likewise `classifyProjectionChildRows` (`tail/child-shape.ts`) is the ONE classifier for
  `<element prefix>.<terminal projection>`, parameterized by which projection it accepts — map and
  record are two predicates over it, not two classifiers.
- **The child seam is parent-shape-polymorphic** (element/property/scalar parents share one
  dispatcher) and lives in three cohesive files — `tail/child-shape.ts` (pure classify leaf) ◂
  `tail/child.ts` (compilers) ◂ `tail/scalar-arm.ts` (scalar-parent arms). Extend by adding to the
  classifier + the compiler — never by reaching for a per-concern object (evaluated and rejected).
- **Classifiers take a `ChildCtx`, not bare params: bound params + the LABELS visible here.**
  A body's shape is syntax-only with one exception — `select("a")` re-types the stream to
  whatever the label holds — so the classifiers carry a `LabelEnv` (label → element/scalar/list;
  `null` = bound but un-re-typable, ABSENT = never bound, which is TinkerPop's drop-every-
  traverser case and must stay distinguishable from it). The env is seeded from the parent's
  carried aliases and EXTENDED as a body is scanned, so a bind types the selects after it and a
  nested arm classifies against the labels visible where it sits — one rule that holds at any
  depth, rather than a per-position vocabulary patch. A ctx-free caller conservatively rejects.
- **`as()` is element-preserving; a label re-root rides the same fold.** `as()` sits in
  `ELEMENT_CHILD_STEPS` because it preserves every shape; `select(label)` is a tail step, so the
  element-body fold applies the ONE existing `selectOneFromAlias` and keeps folding — never a
  second select in the prefix table. That fold is **`Engine.tryLowerElementSteps`**, the single
  whole-body fold for every child position, materialized and correlated alike. Don't grow a second.
  **Whether a MID-BODY bind escapes the child is the consumer's boundary, not a rule to write
  down:** a mapping consumer pops the child stream (the label rides out), a filter/`by()` consumer
  re-projects the parent domain (confined). Both are TinkerPop's, so leave that asymmetry alone.
- **There are THREE ways to provision a child body, and provisioning is not rendering.** Where the
  child's INPUT comes from: a PARENT STREAM (`pushChildScope` + `applyChildCardinality`, rejoined by
  ordinal), an OUTER ROW (`tail/correlated.ts`, rejoined by correlation), or its WHOLE DOMAIN
  compiled once and rejoined by a JOIN on a key (`tail/keyed.ts` — `keyedChildRelation`). The third
  exists because a fan-out body inside a recursive term cannot be correlated at all (SQLite has no
  `LATERAL`), and it is what makes `repeat()`'s body and `until()`/`emit()`'s predicate generic. It
  costs |V|×fanout, so a caller with a lazy fast path keeps it and uses this as the fallback. Do NOT
  add a fourth, and do not confuse any of them with a *rendering* mode — there are exactly two of
  those and both live in the kernel (`src/sql/CLAUDE.md`).
- **Before adding a substrate, separate "the seam cannot EXPRESS this" from "the seam cannot be
  HANDED this."** Four times running, a site that looked like it needed new machinery needed only to
  be able to reach what already existed, and predicting otherwise was wrong every time (see the
  STATUS block in `docs/2026-07-27-hand-rolled-sql-audit.md`). The two tells, both cheap:
  a SCHEMA mismatch — `path()`'s `json_each` explode is `(id, pk, ord)` but an element stream is
  `['id', ...carriedCols]`, fixed by carrying `pk`/`ord` as `origins`, which is what that slot
  already means; and an ARGUMENT-TYPE mismatch — the scalar-child entry points demanded a `nested`
  parse tree, so `match()`, whose pattern body is a `Step[]` slice with no tree, could not call them
  even though they already accepted a pre-parsed body. Both were one-line unlocks that let an
  UNCHANGED compiler serve a second caller. A genuinely new substrate is justified only when the
  existing seam would answer a DIFFERENT QUESTION — which is what a global barrier over a
  per-binding/per-origin domain does, and why that one really does route elsewhere.
- **Carry the labels or decline the body — never answer without them.** An absent alias column is
  indistinguishable from a never-bound label, so a renderer that reads one it does not physically
  have returns a silent `[]`. The inline correlated child is handed a `LabelScope` and seeds those
  columns (`tail/correlated.ts`); a site with no relation to read them from (`until()`/`emit()`, on
  a recursive walk row) declines the body to the materialized gate instead. **The keyed relation is
  the same rule from the other side:** its domain is every vertex, not the caller's rows, so it
  declines any body that MENTIONS a label. Classifying with the caller's labels while seeding an
  empty alias map is how this produced a silent `[]` for a whole body shape — see the audit doc.
- **In a where() body a label's POSITION decides its meaning** — TinkerPop routes `where(traversal)`
  by variable location (`getVariableLocations`), and ONLY where(): first step = a re-root
  (`WhereStartStep`), last step = an equality CONSTRAINT (`WhereEndStep`), middle = an ordinary
  bind. So `where(__.as("a").out("knows").as("b"))` means "a knows b", while the same body under
  `filter()`/`choose()` is three binds. Both variables are canonicalized by ONE Pass
  (`rewriteWhereEndLabels`) into `select(label)` and `where(P.eq(label))` — forms both lowerings
  already implement — so no lowering knows the rule and the two cannot answer differently. Teaching
  it to a lowering instead is how this produced two wrong answers at once: an end label read as an
  inert bind ("a knows somebody"), and a start label re-rooted inside `filter()`, where it does not
  belong, on the fast path only.
- **The branch family (`union`/`choose`/`coalesce`/`optional`) has ONE arm triage and FOUR merge
  builders. Never add a fifth of either.** `classifyArmShape` (one arm) and `classifyBranchArms` +
  `BRANCH_SHAPE_ORDER` (a whole branch) in `tail/child-shape.ts` are the shape decision — the
  prefix fold's `break` (`engine/engine.ts`), the tail cascades (`tail/projection.ts`
  `BRANCH_LOWERERS`) and the mixed-shape lowerers' `armShape` all route through them; computing
  shape with a fresh element/scalar/list if-chain is how those sites drifted before.
  The ONE deliberate exception is `scalar-arm.ts`'s `scalarArmShape`: over a scalar parent an
  "element arm" is a `V()`/`E()` **re-source**, not a movement body, and list must be probed before
  scalar — different predicates and different priority, so it stays separate. It shares the
  `BranchArmShape` return type to keep the parallel visible.
  The merges are `finishElementMerge`/`mergeElementArms` (`prefix/branch.ts`), `unionScalarStreams`
  (`tail/scalar.ts`), `mergeVariantArms`/`mergeVariantParts` and `finishListMerge`
  (`tail/variant.ts`) — all parent-agnostic (a bare `Carry`), so an element parent, a scalar parent
  and a SOURCE (which has no parent at all) share them verbatim.
  **`union()` in SOURCE position is not a second branch implementation** (it was, and consolidating
  it is what made `finishElementMerge` Carry-typed). `sourceUnion` (`prefix/branch.ts`) lowers each
  branch — a fully ROOTED traversal — through `Engine.lowerRootedArm`, then dispatches on the
  resulting Streams' KINDS to those same merges. It deliberately does NOT use `classifyBranchArms`:
  that triage describes a child body under a parent traverser, which a rooted branch is not. Every
  source form (`V`/`E`/`union`/`inject`/`call`) is recognized in ONE place, `Engine.seedRooted`.
  **Every one mints the arm-merge `encounter`** when `carried.encounter` is live; hand-rolling a
  UNION ALL instead is precisely the bug that silently dropped arm ordering from the scalar-parent
  mixed-shape merges. A merge whose arms are heterogeneous (an `optional` hit/miss pair) takes
  `mergeVariantParts`/`finishElementMerge`'s pre-built-`parts` form — it does not get its own copy.
- **Fail closed, never mis-execute.** An unsupported shape throws a clear deferral or falls through
  to the generic path; it never silently answers a different question.
