# Group values through the generic child seam (roadmap #1)

**Date:** 2026-07-18
**Goal:** delete the hand-rolled `tryLowerNestedMapGroup` mini-compiler and make group
**values** first-class — every group value lowers through the generic child seam
(`8044bc1` property-group playbook), so any valid inner traversal composes.

## The two throw walls being demolished

- `group.ts:373` — `group().by(traversal) value not supported by generic child lowering`
  (nested-group / rich value bodies the mini-compiler didn't recognize).
- `group.ts:478` — `select(Column)/unfold() over a group of element values not yet
  supported` (element-**valued** groups can't re-enter).

## Stage 1 — generic nested-group value engine (delete the mini-compiler)

The nested-map value `group().by(k).by(__.<childPrefix>.<group|groupCount>)` is a
**two-level aggregation**: `lvl1` groups the outer members' child-expansion by
`(outerKey, innerKey)` and applies the inner reducer; the outer `json_group_object`s each
outer key's `(innerKey → innerVal)` pairs into one Map (`GroupVal {kind:'nestedMap'}`,
unchanged). The mini-compiler already does exactly this — but hand-rolls the movement
JOINs (`dirsFor`, only `properties`/`outE`/`inE`/`bothE`) and inner key/reducer parsing.

**Move:** source all three generically.
- **movement** → `compileElementChildRows(parent, <childPrefix>, reuseFrame)` — the same
  `lowerElementSteps` the root uses, so ANY movement/filter chain works (multi-hop,
  `has()`, `hasLabel()`, …), not just the 4 bare moves.
- **inner key** → `buildGroupKey` over the inner element ctx (`elemCtx` on the rejoined
  nodes/edges) — scalar/`T.label`/`T.id` now; element inner keys via Stage 2's `v_rid`.
- **inner value** → the existing reducer builders (`numericReducerAggregate`, `COUNT(*)`).

New `GroupSource` field `valNestedMap` carries `{ innerKey, innerVal, innerReducer, from }`;
`lowerGroup` gets a branch emitting the two CTEs. Delete `tryLowerNestedMapGroup` +
`SCALAR_REDUCERS` + the hand-rolled `dirsFor`/adjacency code.

**Regression net (must stay green):** compiler.test.ts:492, :499; L3 lines 370, 435.
**Unlocks:** general `by(traversal-value)` nested groups — Group.feature 164/175/204/215 +
the `group().by(...).by(traversal)` telemetry ERRs.

## Stage 2 — element-valued group entry (close group.ts:478)

Element-valued groups (`group().by(label).by(__.out())`) lay values out as `groupBy=false`
framed `v_*` rows folded by the handler. To re-enter (`select(Column.values)`/`unfold()`),
add a `v_rid` internal-rowid column aggregated into `json_group_array(v_rid)` per key —
mirroring how element **keys** already carry `k_rid` (`stream.ts:227,236`). `deriveGroupEntries`
then exposes `mv` with `valOf = {kind:'list', of:{kind:'elem', elem}}`; unfold/materialize
rejoins nodes/edges per rid through the existing list-of-elem substrate. This is the
map-valued entry column shared with roadmap #5.

## Bar (same as the property-group commit)

Generic path is the semantic authority; recognition failure returns `null`/throws a clear
deferral, never mis-executes. Land each stage green (regression net + new unit tests + an
L4 addendum feature + corpus 100% + L3 ≥ baseline), committed separately on trunk.

## Fallback / context-clear point

Stage 1 and Stage 2 are independently committable. If Stage 2's element-entry substrate
proves larger than expected, Stage 1 ships alone (mini-compiler already deleted, nested
values generic) and Stage 2 folds into roadmap #5. Clear context between stages.
