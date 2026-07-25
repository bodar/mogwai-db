---
paths:
  - "src/wire.ts"
  - "src/execute.ts"
  - "src/io.ts"
  - "src/http.ts"
  - "src/serializers.ts"
---

# Wire-protocol facts (each cost debugging time)

- **beta.2 requests are GraphBinary; master moved to JSON.** Sniff the first byte (`0x84`), accept
  both. The param field is `bindings` in binary requests. Responses: always HTTP 200; errors ride
  the GraphBinary status trailer, not the HTTP status.
- **The client's vertex/edge/VP serializers hardcode empty properties** — so we hand-roll that
  framing in `execute.ts`. Don't route elements through the stock serializers expecting props.
- **`iterate()` = trailing `.discard()`** — strip it, execute, return no values.
- **DO SQLite has no user-defined functions, and we do NOT filter in JS.** Anything SQL can't
  express (`regex`/`typeOf`) fails closed with a deferral (root CLAUDE.md decision #3). Text SQL
  *can* express (`containing`/`startingWith`/`endingWith`) stays in SQL (`LIKE`).
- **A `Map.Entry` frames as a size-1 MAP** on GraphBinary v4 (no dedicated DataType) — citations in
  `docs/2026-07-25-wire-and-storage-facts.md`.
- **`count()`/`groupCount()` are Java Longs → frame as Int64 (`longSerializer`), NOT via
  `anySerializer.serialize(BigInt(v))`.** A JS `bigint` handed to `anySerializer` selects GraphBinary
  **BigInteger** (0x23), which the client decodes to a JS BigInt — but a Long (Int64, 0x02) decodes
  to a **Number** for safe-range values, which is what TinkerPop emits and the conformance harness's
  `parseFloat` expects (`d[n].l`). Use `countBuffer` (`execute.ts`). Passing a plain JS **Number**
  to `anySerializer` is fine (it picks Int/Long by magnitude — that is how `sumBuffer` works); only a
  `bigint` argument mis-selects BigInteger.
- `src/io.ts` reuses gremlin's serializers via a relative import (bypasses the `exports` map);
  upstream fix pending (apache/tinkerpop#3511).
