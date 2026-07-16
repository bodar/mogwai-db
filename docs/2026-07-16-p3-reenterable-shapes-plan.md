# P3 — lift the terminal islands to re-enterable streams (2026-07-16)

**Status:** in progress. Anchors the multi-commit P3 from
`docs/2026-07-16-compiler-consolidation-plan.md` §3. **Baseline:** L3 1046, corpus
2298/2298.

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
