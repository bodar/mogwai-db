# P3 — lift the terminal islands to re-enterable streams (2026-07-16)

**Status:** in progress. Anchors the multi-commit P3 from
`docs/2026-07-16-compiler-consolidation-plan.md` §3. **Baseline at start:** L3 1046.
**Now: L3 1066** (Stages A + B1 + B2 + C1 + C2 + C3, all CI-green on trunk — 8 commits).

- **Stage C2 LANDED** (1064, +0-but-correct): `count()`/`count(Scope.local)`/
  `is(typeOf(MAP))` re-enter a GroupStream (`COUNT(DISTINCT gk)` = entry count).
- **Stage C3 LANDED** (1064→1066): `group()/groupCount().unfold()` → per-entry Map.Entry
  stream (`MapStream.entries`); `select(Column.keys/values)` projects per row.

**P3 substantially complete.** Remaining is either the **P4 substrate** (element-VALUE
group maps + mixed branch arms — dynamic-tag VariantStream, the §2 "widest gate") or
scattered small bits (elementMap re-entry with heterogeneous followers, keys→SET typing,
`as()`/`order()` on a group, named `groupCount('a')`-over-scalar). Next major bet = P4.

**P4 LANDED (2026-07-16, substrate + branch arms) — and corrected a mislabel.** See
`docs/2026-07-16-p4-dynamic-variant-plan.md`. The dynamic-tag VariantStream (per-row
`vk`: null/scalar/node/edge/list) + its **mixed-shape branch-arm** consumers landed
(L3 1066, behaviour-neutral + fail-closed→works). Key finding: the "element-VALUE group
maps" defer above is **NOT** the variant row — the 11-scenario bucket is
`group().by(k).by(__.…groupCount()/group())`, i.e. **nested-MAP-valued groups** needing a
`GroupVal {kind:'map'}` + two-level aggregation (a separate feature). The truly
variant-shaped Map consumers (element-value group `select(Column.values)`/`unfold`, mixed
record `select(Column.values)`) cash ~0–1 scenarios today. Nested-map-valued groups are
the recommended next dedicated piece (see the P4 doc §"Recommended next").

- **Stage A LANDED** (1046→1047): `path()` re-enterable — `count()`/`is(typeOf(PATH))`.
- **Stage B1 LANDED** (1047→1050): `valueMap()` → per-element `MapStream`; origin-aware
  `compileFromMap` `select(Column.keys/values)`; `count`/`is(typeOf(MAP))`.
- **Stage B2 LANDED** (1050→1061): thread the origin ordinal through every per-row list
  op (was a crash on `select(Column.values).unfold().<setop>`); `select(unbound-label)`
  → empty.
- **Stage C1 LANDED** (1061→1064): scalar-stream `groupCount()` barrier
  (`values('name').groupCount()` → Map{value:count}); `GroupKey.as` frames typed keys.
- **Stage C remaining (next):** group-value re-entry (`unfold`→Map.Entry, `count`/`is`/
  `order`/`select(label)` on a group), keys→SET typing for
  `select(Column.keys).dedup().is(typeOf(SET))`, named `groupCount('a')` over a scalar,
  `elementMap()` re-entry. Element-VALUE group maps stay the **P4 wall** (dynamic-tag
  VariantStream).

**Process note:** `bun test` does NOT typecheck; `mise run ci` runs `tsc`. Run
`bunx tsc --noEmit` after EVERY edit incl. test files — a `.shape.key` union-narrowing
slip in a test passed `bun test` but broke CI (fixed in a follow-up commit).

## Root cause (one gap, three shapes)

`buildProjection` (`src/steps/projection.ts`) renders the **non-scalar element tail**
(`valueMap`/`elementMap`/`count`/element-`fold`/`path`/`__element`) into a **terminal
`ResultStream`** — deliberately not relational/re-enterable (`stream.ts` ResultStream
doc). So a step *after* one of these throws. `fold`→`ListStream` and
`group`→`GroupStream`→`compileFromMap` already prove the lift; P3 applies the same
pattern (`lowerStream` gains a `compileFrom*` arm per shape) to the rest.

Telemetry (post-P2, L3 1046) real terminal-island failures:
- `valueMap().select(Column.keys/values)` — 18 (Stage B)
- element-valued group value (`group().by().by(__.properties().groupCount()…)`) — 11 (Stage C)
- `path().select(Column.keys)` / steps-after-path — 5 (Stage A)
- `group().by().by(__.…fold()).unfold()` Map-unfold — 5 (Stage C)
- `path()` after a scalar (path history through a projection) — 6 (separate; defer)
- `group().count()` — 2 (Stage C)

## Stage A — path re-enterable

- `lowerStream` (`index.ts:291`): replace the `path` throw with `compileFromPath`.
- `compileFromPath` handles the steps-after-path:
  - `count()` — linear layout: `COUNT(*)` (one row per path); grouped (recursive
    repeat): `COUNT(DISTINCT pk)`. → ScalarStream (long/count).
  - `is(typeOf(GType.PATH))` — identity (a path IS a path); any other typeOf → empty.
  - `unfold()` — explode positions to an element/scalar stream. Grouped layout is
    already `(pk,ord,element…)` → an ElementStream (node). Linear homogeneous-element
    positions unpivot; mixed/value positions defer.
  - `select(Column.keys/values)` — keys = the as()-labels at each position (needs the
    path to carry label history — ties to labels-as-path-history); values = the
    elements. Defer the alias'd form until history is carried; support what is available.
- **Purpose:** de-risk the terminal-island→re-enterable *dispatch wiring* on the
  simplest shape. Payoff is small; the point is the clean pattern before B/C.

## Stage B — valueMap/elementMap re-enterable (the canonical map substrate)

**Not the narrow keys/values slice — build the canonical thing once so the whole family
falls out (SCOPE.md).** Lift `valueMap`/`elementMap` off the terminal ResultStream onto a
**per-element `MapStream`** (`(mk,mv,o0)` rows: `mk`=key string, `mv`=value list; one map
per input element via an origin ordinal, unlike group's one global map, when a follower
exists — terminal valueMap keeps the byte-identical ResultStream). Consumers, all on
existing rails:
- `select(Column.keys/values)` — generalize `compileFromMap` to aggregate **per origin**
  (`GROUP BY o0`); keys→Set. `select(Column.values).unfold().<setop>` composes via the
  list substrate.
- `select('a')` / `select(Pop.x,'a')` — the suite expects **empty** (select of an unbound
  label), NOT an error. Route the map through the label-select rail so unbound→empty
  falls out. (Was wrongly slated to defer.)
- `is(typeOf(MAP))` → identity; `count()` → count.
- `unfold()` → Map.Entry (the reserved `'entry'` ListOf).

**Genuine wall (defer to P4):** mixed element-VALUE maps
(`group().by().by(__.properties().groupCount()…)`) — heterogeneous element values need
the dynamic-tag VariantStream.

## Stage C — group value/unfold extensions (~18)

- Element-valued group values (`group().by().by(__.properties().groupCount()…)`) —
  extend `GroupStream.val` kinds + `compileFromGroup` consumers.
- `group()→unfold()` (Map → Map.Entry, the reserved `'entry'` ListOf).
- `group().count()` (count of map entries).

## Guardrails / discipline

Each stage: tsc → compiler snapshot tests → full `bun test` (L3 ratchet) → commit →
CI-green push. Mixed-shape arms that need P4 (dynamic-tag VariantStream) fail closed
with a clear throw — do NOT force P4 early. No new mini-compiler / private child parser
(CLAUDE.md extension law): every re-entry lands as a `compileFrom*` arm on the spine.
