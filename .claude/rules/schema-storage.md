---
paths:
  - "src/storage.ts"
  - "src/compiler/steps/write/**"
  - "src/compiler/plan/**"
---

# Schema + the property read/write seam

Integer rowid PKs, interned labels, covering edge indexes `(src,label,tgt)`/`(tgt,label,src)` so
out()/in() are index-only. `nodes`/`edges` carry a nullable `uid TEXT UNIQUE` (user ids); rowid is
the internal PK. Properties are **normalized** into `vertex_properties`/`edge_properties` (the old
flat `edges.props` JSONB blob is retired).

## Guardrails

- **`value` has no declared type (BLOB affinity)** — this is deliberate: it preserves the bound
  value's SQLite storage class so numeric order/range predicates work. Don't add a type to it.
- **`vtype` = the canonical Gremlin type from the write channel** (`src/gremlin/types.ts` is the one
  vocabulary). Collections store as a self-describing typed `{t,v}` tree so every nested leaf
  round-trips its exact type. Design: the typed-collections plan family in `docs/`.
- **Property reads stay index-only in the hot path.** `framedProps`/`valueMapProps` read only at
  leaf materialization, never inside movement/filter CTEs.
- **Known debt:** `write.ts` reads row-at-a-time (`runNested`/`nestedScalar`) — an acknowledged
  imperative surface, tracked in `docs/outstanding-work.md`.
