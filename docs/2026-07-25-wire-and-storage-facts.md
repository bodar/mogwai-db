# Wire & storage facts — Map.Entry framing + the MapStream blob model

Durable reference (not a plan): external-protocol + internal-model facts you'd otherwise re-derive from
the TinkerPop source + spec every time you touch map framing or the `MapStream` shape. Live per-step
capability is `feature-support-matrix.md`; the typed-collection substrate rationale is
`archive/2026-07-17-full-fidelity-typed-collections-plan.md`.

---

## A `Map.Entry` frames as a size-1 MAP on GraphBinary v4 (no dedicated DataType)

A `Map.Entry` (the result of `unfold()` on a Map) has **no dedicated GraphBinary v4 DataType** — it frames
as an ordinary `DataType.MAP` (`0x0a`) with `{length}=1`, and every GLV decodes it as a size-1 Map,
**indistinguishable from a genuine single-key Map**. This is by design, not a gap:

- **TINKERPOP-3104** ("Make `unfold()` on Maps consistent…") closed **Won't Do** — GLVs have no native
  `Map.Entry` concept, so remote `unfold(Map)` returns a size-1 Map.
- Reference docs, "A Note on Maps": *"an unfolded Map becomes `Map.Entry` on the server … but is returned
  to the application as a Map with one entry."*
- Java `MapEntrySerializer` is a `TransformSerializer` — direct read/write **throw**; it transforms the
  entry into a 1-element `HashMap` before type dispatch. JS mirrors this (`DataType.js` has `MAP:0x0a`, no
  entry code; the cucumber harness converts `Map.Entry` → size-1 `LinkedHashMap`).

**In mogwai-db:** frame each entry row as a size-1 MAP via `mapFromEntries` / `typedMapBuffer`
(`src/execute.ts`). **Trap:** a typed `long` count inside such an entry decodes to a JS **Number** (not
BigInt), so L4 notation uses `d[n].i` for map-entry counts — while a TERMINAL `group()` map frames via
`groupBuffer` → `anySerializer(BigInt)` and decodes to BigInt / `.l`.

---

## `MapStream` is a per-row JSONB map blob (not an entry relation)

A `MapStream` (`src/compiler/steps/context/stream.ts`) is a **per-row whole-map VALUE** — one JSONB `map`
column holding an ordered `[[keyNode, valNode], …]` array, mirroring `ListStream`'s single `list` blob. It
is **NOT** an entry relation.

- **The map stays a blob VALUE through the core.** Conversion to a per-entry `MapEntryStream` (a `(mk, mv)`
  row relation) + its size-1-MAP wire framing happens ONLY at `unfold()` / the root. **Do NOT add an
  `entries` flag to `MapStream`** — it converts to entry/wire-shape too soon; the conversion belongs at
  `unfold()`.
- **One encoding, always typed.** A map's SCALAR side is ALWAYS a self-describing `{t,v}` `ValueNode`
  (framed via `frameTypedNode`), never bare — so per-entry heterogeneous types round-trip through ONE
  decode path. `elem`/`list` sides stay as they are. Every producer
  (`group`/`groupCount`/`valueMap`/`is(typeOf(MAP))`) builds this one shape; `group`/`groupCount` SQL-wrap
  their scalar key/count/sum as `json_object('t',…,'v',…)`.
- **Always-typed has no real SQL cost:** the typing is map-VALUE construction at a BARRIER (one row per
  distinct key), O(distinct keys) `json_object` calls on an already-collapsed result — not per-traverser.
  Two encodings would save one wrap but cost permanent dual-mode branching in every blob reader plus an
  unchecked producer/reader invariant.

---

## Minor debt — the `value` Shape's `as?` xor `perRowType?` pair

The `value` Shape (`src/execute.ts`, `case 'value'`) is
`{ kind: 'value'; as?: ValueType; perRowType?: boolean }` — two **mutually exclusive** framing modes:

- `as: X` — one compile-time type for the whole column (homogeneous).
- `perRowType: true` — each row frames by its OWN stored `vtype` column (`frameStoredValue` /
  `frameTypedNode`).

Two optional flags where exactly one applies is a mild smell (a reader must know they're xor); a
discriminated union would be cleaner. **Low priority, no behavior change** — only worth it if the `value`
Shape is touched again. Also tracked in `outstanding-work.md`.
