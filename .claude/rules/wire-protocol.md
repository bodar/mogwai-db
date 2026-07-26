---
paths:
  - "src/wire.ts"
  - "src/execute.ts"
  - "src/io.ts"
  - "src/http.ts"
  - "src/serializers.ts"
---

# Wire-protocol facts (each cost debugging time)

- **Requests arrive as GraphBinary OR JSON.** Sniff the first byte (`0x84`), accept both — the
  client moved to JSON between beta.2 and master and we serve both. The param field is `bindings`
  in binary requests. Responses: always HTTP 200; errors ride the GraphBinary status trailer, not
  the HTTP status.
- **Deserialization is async and pull-based; SERIALIZATION is still sync.** The client's
  `deserialize(reader)` reads from a `StreamReader` and returns a Promise (no `{v,len}` — the
  reader owns the cursor), from the response-streaming rework apache/tinkerpop#3395. Only the
  inbound path (`wire.ts`, our three serializers in `serializers.ts`) is affected; the whole
  response-framing hot path in `execute.ts` is untouched. `StreamReader.fromBuffer(buf)` wraps a
  complete buffer, so those awaits never do I/O.
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
- `src/io.ts` reuses gremlin's serializers via the **bare** `gremlin/io` subpath export — landed
  upstream as apache/tinkerpop#3511, so the deep `node_modules/...` paths are gone. Only
  `StreamReader` is still a relative import (no `exports` entry for the internals subpath, and
  `exports` gates bare specifiers only) — the same shape `gremlin/io` had before #3511.
