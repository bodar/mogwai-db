# Wire & storage facts — Map.Entry framing + the MapStream blob model

**Date:** 2026-07-25 (consolidated from investigation notes originally captured 2026-07-20)
**Status:** durable reference — hard-won external-protocol + internal-model facts that took
investigation to establish. Not a plan; nothing here is in-flight.

These are the facts you'd otherwise have to re-derive from the TinkerPop source + spec every
time you touch map framing or the `MapStream` shape. For live per-step capability, cross-check
`feature-support-matrix.md`; for the typed-collection substrate rationale, see
`2026-07-17-full-fidelity-typed-collections-plan.md`.

---

## A `Map.Entry` frames as a size-1 MAP on GraphBinary v4 (no dedicated DataType)

A `Map.Entry` (the result of `unfold()` on a Map) has **no dedicated GraphBinary v4 DataType**.
It frames as an ordinary `DataType.MAP` (`0x0a`) with `{length}=1`. Every GLV decodes it as a
size-1 Map, **indistinguishable from a genuine single-key Map**.

Authoritative sources (verified against the pinned `gremlin@4.0.0-beta.2`):

- **TINKERPOP-3104** — "Make `unfold()` on Maps consistent…" — filed against 4.0.0, closed
  **Won't Do** (Mar 2025). GLVs have no native `Map.Entry` concept, so remote `unfold(Map)`
  returns a size-1 Map *by design*.
- Official reference docs, "A Note on Maps": *"an unfolded Map becomes `Map.Entry` on the server
  … but is returned to the application as a Map with one entry."*
- Java `MapEntrySerializer` is a `TransformSerializer` — its direct read/write **throw**; it
  transforms the entry into a 1-element `HashMap` before type dispatch.
- Local JS: `DataType.js` has `MAP:0x0a`, no entry code; `MapSerializer` builds `new Map()`;
  the cucumber harness `StepDefinition.java` converts `Map.Entry` → size-1 `LinkedHashMap`
  *"coz that how we assert those for GLVs."*

**In mogwai-db:** frame each entry row as a size-1 MAP via the existing `mapFromEntries` /
`typedMapBuffer` helpers (`src/execute.ts`). A typed `long` count inside such an entry decodes
to a JS **Number** (not BigInt) — so L4 notation uses `d[n].i` for map-entry counts. (A TERMINAL
`group()` map still frames via `groupBuffer` → `anySerializer(BigInt)` → decodes to BigInt /
`.l`.)

---

## `MapStream` is a per-row JSONB map blob (not an entry relation)

A `MapStream` (`src/compiler/steps/context/stream.ts`) is a **per-row whole-map VALUE** — one JSONB `map`
column holding an ordered `[[keyNode, valNode], …]` pairs array, mirroring `ListStream`'s single
`list` blob. It is **NOT** an entry relation.

**The map stays a blob VALUE through the core.** Conversion to a per-entry `MapEntryStream` (a
`(mk, mv)` row relation) + its size-1-MAP wire framing (above) happens ONLY at `unfold()` / the
root — never baked into the stream. (An earlier `entries` flag on `MapStream` was rejected: it
converts to entry/wire-shape too soon. The conversion is pushed to `unfold()`.)

**One encoding, always typed.** A map's SCALAR side is ALWAYS a self-describing `{t,v}`
`ValueNode` (framed via `frameTypedNode`), never bare — so per-entry heterogeneous types
round-trip and there is ONE decode path. `elem` / `list` sides stay as they are (an element
frames from a rowid via `vertexBuffer`; a list is a JSON array — neither fits a scalar envelope).
Every producer (`group` / `groupCount` / `valueMap` / `is(typeOf(MAP))`) builds this one shape;
`group` / `groupCount` SQL-wrap their scalar key/count/sum as `json_object('t',…,'v',…)`.

**Why always-typed has no real SQL cost (the settled trade-off):** the typing is map-VALUE
construction at a BARRIER (one row per distinct key), not per-traverser in the movement/filter
spine — O(distinct keys) `json_object` calls on an already-collapsed result. Keeping two
encodings (typed vs bare) would save one group `json_object` wrap but cost permanent dual-mode
branching in every blob reader + an unchecked producer/reader invariant.

---

## Minor debt — the `value` Shape's `as?` xor `perRowType?` pair

The `value` Shape (`src/execute.ts`, the framing switch — `case 'value'`) is
`{ kind: 'value'; as?: ValueType; perRowType?: boolean }`. The two optional fields are
**mutually exclusive** framing modes:

- `as: X` — one compile-time type for the whole column (statically known, homogeneous).
- `perRowType: true` — each row frames by its OWN stored type via a carried `vtype` column
  (heterogeneous; `frameStoredValue` / `frameTypedNode`). From the typed-property-values work.

Two optional flags where exactly one applies is a mild smell (a reader must know they're xor). A
cleaner encoding would be a discriminated union, e.g.
`frame: { mode: 'static'; as?: ValueType } | { mode: 'perRow' }`. **Low priority, purely a
maintainability/clarity refactor with no behavior change** — only worth doing if the `value`
Shape gets touched again for other reasons. (Also tracked in the P3/debt section of
`2026-07-19-outstanding-work-snapshot.md`.) Not debt from the MapStream consolidation — it
pre-dates it.
