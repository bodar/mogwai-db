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
- **A VERTEX element's `{label}` is a LIST and carries EVERY label, unconditionally.** The client
  reads all of it (`VertexSerializer.deserializeValue` keeps `labels`, derives `.label` from
  `labels[0]`), so `with("multilabel")`/`with("singlelabel")` do NOT reach here — they govern how
  `elementMap()`/`valueMap(true)` render a `T.label` ENTRY (`labelTokenFor`), which is a different
  question. The producer side is `labelPayloadFor` + the one `elementPayload` builder
  (`compiler/plan/plan.ts`); the framer takes a `string[]`. Framing a list of one is the silent
  failure mode this replaced, and **no `.feature` can catch it** — Gherkin's `v[x]` compares by id,
  so the assertion lives in `test/multilabel-wire.test.ts` and decodes with the client's reader.
- **`iterate()` = trailing `.discard()`** — strip it, execute, return no values.
- **DO SQLite has no user-defined functions, and we do NOT filter in JS.** Anything SQL can't
  express fails closed with a deferral (root CLAUDE.md decision #3). Text SQL *can* express
  (`containing`/`startingWith`/`endingWith`) stays in SQL (`LIKE`). **`regex` is the only member of
  that class left** — and it is INTENDED work, not a permanent wall
  (`docs/2026-08-12-regex-as-a-barrier-research.md`: a batched barrier behind a trigram prefilter,
  gated on a semantics commitment, not on engineering). ⚠️ **`typeOf` is NOT in the class** — it
  lowers as a per-row `vtype` comparison with a storage-class fallback (`typeOfExpr`,
  `compiler/rel/predicate.ts`) and `is(typeOf(GType.LIST))` even retypes the stream.
- **A `Map.Entry` frames as a size-1 MAP** on GraphBinary v4 (no dedicated DataType) — every GLV
  decodes it as an ordinary size-1 `MAP` (`0x0a`), indistinguishable from a genuine single-key map,
  and this is by design: TINKERPOP-3104 ("make `unfold()` on Maps consistent") closed **Won't Do**
  because GLVs have no native `Map.Entry`, so a remote `unfold(Map)` returns a size-1 Map (reference
  docs, "A Note on Maps": *returned to the application as a Map with one entry*). Java's
  `MapEntrySerializer` is a `TransformSerializer` — direct read/write THROW; it turns the entry into a
  1-element `HashMap` before type dispatch. We frame each entry row as a size-1 MAP via
  `mapFromEntries`/`typedMapBuffer` (`execute.ts`); the `map` (whole map) vs `mapEntry` (one entry,
  key and value as their own columns) split is the two framing arms in `compiler/rel/framing.ts`, and
  the conversion to an entry happens at `unfold()`, never earlier.
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
