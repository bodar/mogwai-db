# Write args through the read spine (2026-07-16)

**Goal.** Let write-step arguments that are nested traversals — `property(k, __.trav)`,
merge match/`option` maps from a traversal, `addE` endpoint traversals — compile through
the ordinary read compiler instead of failing closed. This is consolidation §2 gap #3
("route write arguments through `lowerSteps`").

## The principle — reuse, don't shoehorn

A compiled read is already `(raw SQL relation, shape)`. GraphBinary framing
(`framedResults` in `execute.ts`) is the LAST, separable stage: for every shape the SQL
selects raw columns (`r.id`, `r.v`, `r.list`, …) and the `switch(shape.kind)` just picks a
buffer fn. So a write arg does not need new lowering — it runs the SAME `compileRead` and
reads the raw column via a **second consumer**, `extractNestedValue(shape, rows)` (the
inverse of the framing switch, returning JS values). No read-lowering files change; the
work is `write.ts` + one small helper. The same extractor is the substrate the deferred
untyped-GraphSON response encoder needs (a second framer over the same relation).

**Correlated args** (the value/map depends on the current element) seed the nested chain
at the driver element by prepending a `V(<rowid>)`/`E(<rowid>)` source (numeric arg →
`id IN` rowid match; confirmed in `steps/index.ts`), then compile+run+extract per driver
row — consistent with the imperative write seam (`mergeDrivers` already loops per driver).

## Impedance note (drives staging)

The framed element shapes (`vertex`/`edge`) project the EXTERNAL id (`COALESCE(uid,id)`),
not the internal rowid an edge FK needs. So **scalar** and **map** results extract cleanly
(`r.v` / a JS Map), while **element-rowid** results (addE endpoints) want the bare
element relation's `id` — a different path. Hence:

- **Stage 1 (this):** correlated `property(k, __.trav)` scalar value. Seed at the target
  element, `compileRead`, extract `r.v` from `value`/`scalar`/`count` shapes. Empty result
  → property not written. Runtime `vtype` inferred from the produced value.
- **Stage 2:** merge match map + `option(Merge.onCreate/onMatch, __.trav)` from a
  traversal → extract a JS Map (`valueMap`/`elementMap`/`map` shapes) → `normalizeMergeMap`.
  Biggest telemetry cluster (~26 + ~14).
- **Stage 3:** `addE`/`mergeE` endpoint traversals past a movement/branch — resolve to the
  bare element relation's rowid (buildPrefix/element-relation path, not the framed shape).

Fail closed with a clear message on any shape the extractor does not yet consume.

## Cost / follow-up

Correlated args compile+query once per driver row (N sub-queries) — correct and matches
the seam's existing per-driver model; fine for OLTP small graphs. A batch form (one
correlated child via `child.ts` producing all `(driverId, value)` pairs) is a later
optimization, not needed for correctness.
