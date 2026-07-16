# P4 — dynamic-tag VariantStream (2026-07-16)

**Status:** substrate + branch consumers LANDED. Anchors P4 from
`docs/2026-07-16-compiler-consolidation-plan.md` §3. **Baseline:** L3 1066.
**Now: L3 1066** (P4 is behaviour-neutral spine + a fail-closed→works widening
that the current L3 corpus barely exercises; see §4).

## What landed

### Stage 1 — widen the row (substrate, commit 125ca2a)

`VariantStream` was a narrow 3-way row (`vk` 0=null / 1=scalar / 2=element, with
`scalarAs`/`elem` as *single* compile-time metadata — it could hold "null OR one
scalar-type OR one element-kind", never "node OR edge" nor "scalar OR element" per
row). P4 makes `vk` a genuine **per-row payload-shape tag**:

```
vk: 0=null · 1=scalar (v) · 2=node (rid) · 3=edge (rid) · 4=list (list)
```

- `VariantStream` gains `node?`/`edge?`/`listOf?` arm flags (replacing `elem`);
  `streamColumns` adds a `list` column iff a list arm exists. `VariantArms` +
  `toVariantStream(c, rel, arms, result?)`.
- **`materializeVariantRoot`** fans out to gated LEFT JOINs — the tag is in the
  join condition (`n.id=rid AND vk=2`, `e.id=rid AND vk=3`) so a node and an edge
  sharing a rowid never cross-match; `CASE vk` picks id/label/props, one `labels`
  join keys off whichever element table matched. A list arm expands its `list`
  column via the existing `listResult`.
- **Handler `case 'variant'`** dispatches each row by its own `vk`
  (null/scalar/`rowVertex`/`rowEdge`/`frameListOf`) — the same per-row-tag pattern
  `case 'value'` already uses for `vtype`→`frameValue`. `frameListOf` is shared
  with the list-VALUE shapes. `labelselect`'s `CASE vk` widens identically.
- Existing narrow producers (`tryLowerVariantOptional`, nullable record field,
  nullable `aggregate`, `cap`) migrate as a strict subset — +0, all green.

### Stage 2 — mixed-shape branch arms (commit bbc5671)

`union`/`choose`/`coalesce` whose arms are **not one shape class** (some scalar,
some element, some list) now merge into a widened `VariantStream` instead of
throwing the mixed-shape defer. `compileVariantArm` compiles each arm to its
natural shape from the shared seed; `variantArmSelect` projects the per-row `vk`;
coalesce gates arm k by the input ordinal, choose partitions via the predicate
gate; `lowerElementSteps` breaks the prefix for mixed-shape branches so the shape
dispatch (list→scalar→variant→legacy) runs. Homogeneous-class arms keep their
richer per-shape handlers (path/aliases). Verified end-to-end by a new execution
test (`mixed-shape branch arms merge as a dynamic-tag VariantStream`): scalar +
element + edge arms tag and frame correctly across all three families.

**Still deferred (fail closed, legacy defer):** mixed element KIND (node+edge,
*both* element-class) in a branch — the cheap shape-class probe can't tell node
from edge without compiling, and firing the variant for every homogeneous
element union would double-compile the common case. `path()` through a mixed
branch. NEW `as()` bound inside an arm.

## §4 — the scope finding on "P3 Map unlocks" (READ THIS before Stage 3)

The consolidation plan and the P3 doc list P4 as unblocking "element-value group
maps, Map-unfold, mixed `select(Column.values)`". **Fresh telemetry (L3 1066)
shows those defers need mechanisms P4's row-variant does *not* provide** — they
were conflated under one label. Precisely:

1. **`element group value not supported` — 11 scenarios, the biggest — is
   NESTED-MAP-VALUED groups, not the variant row.** Every one is
   `group().by(k).by(__.<move>.groupCount()/group()…)` — the group VALUE is itself
   a Map (a nested aggregation), e.g.
   `g.V().hasLabel('song').group().by('name').by(__.properties().groupCount().by(T.label))`.
   This needs a **`GroupVal {kind:'map'}`** + a two-level correlated aggregation
   compile (outer GROUP BY key, inner `json_group_object` per key) + Map-value
   framing in `groupBuffer`. Orthogonal to the dynamic-tag row. A proper dedicated
   feature (~the size of the original group work), NOT a P4 lift.

2. **Element-value group `select(Column.values)`/`unfold` — 1 scenario**
   (`deriveGroupEntries` throw, group.ts:411). Needs the element value rows
   aggregated to an internal-rowid JSONB list (retain `v_rid` via
   `elementSelect(…, true)`, mirroring how keys keep `k_rid`) so the list
   substrate can expand them. The `unfold`→per-entry path composes cleanly on
   `jsonbElementList`; the DIRECT `select(Column.values)` path additionally needs
   **nested element-list framing** (a list-of-element-lists — the handler's
   `jsonbList`/`{kind:'list'}` arm currently frames inner arrays via
   `listSerializer`, which does not expand element rowids to vertices). A real but
   low-yield (1 scenario) piece with broad SQL-snapshot churn.

3. **Mixed record `select(Column.values)` — ~0 scenarios in the current L3
   corpus** (select.ts:555, "needs a variant list stream"). This IS the genuine
   variant-substrate consumer: one heterogeneous list value per row with
   per-POSITION known shapes (a tuple), needing a `ListOf {kind:'tuple', items}` +
   per-position framing. Correct to build only when a scenario exercises it —
   building it now is gold-plating a case nobody runs (SCOPE.md).

**Conclusion.** P4-the-substrate (the dynamic-tag row) is the right structural
bet and is done; it correctly widened the branch family. But "the P3 Map defers"
are dominated by **nested-map-valued groups (#1)** — a separate nested-aggregation
feature — with the truly variant-shaped Map/record consumers (#2 element-value
group entries, #3 mixed record select) cashing ~0–1 scenarios today. Forcing #2/#3
now would be high-churn / fake-case work; #1 is the high-value next piece and
deserves its own plan.

## Recommended next (a dedicated feature, not "finishing P4")

**Nested-map-valued groups** (the 11-bucket): add `GroupVal {kind:'map', key, val}`,
recognise a nested `group`/`groupCount` value child in `lowerGroup`, compile it as
a correlated two-level aggregation (`json_group_object` per outer key over an inner
`GROUP BY key, innerKey`), and frame each group value as a Map in `groupBuffer`.
Inner shapes to cover incrementally: `groupCount().by(T.x)`, `group().by().by(sum)`.
Land staged behind the L3 ratchet like every prior grind.

## Guardrails

Each stage: tsc → compiler snapshot tests → full `bun test` (L3 ratchet) → commit →
CI-green push. `bun test` does NOT typecheck — run `bunx tsc --noEmit` after every
edit incl. tests. No new mini-compiler / private child parser (CLAUDE.md extension
law): every re-entry lands as a `compileFrom*`/`tryLower*` arm on the spine.
