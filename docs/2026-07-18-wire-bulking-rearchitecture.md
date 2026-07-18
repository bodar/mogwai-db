# Traverser bulking, re-architected for the wire (roadmap #2, supersedes premise of 2026-07-14)

**Date:** 2026-07-18

## The premise correction

The `2026-07-14-traverser-bulking.md` investigation concluded *"BulkSet wire type is a
dead end… the pinned `gremlin@4.0.0-beta.2` client has zero bulk support… bulking's entire
payoff is internal; there is no wire feature to chase."* **That is wrong** (it appears to
have grepped the TinkerPop source tree, not the installed client).

Verified in the actual pinned client (`node_modules/gremlin@4.0.0-beta.2`) and corroborated
by the TinkerPop dev@ list + commit history:

- **GraphBinary V4 `ResponseMessage` carries a `{bulked}` Byte** right after the version
  (`0x00` unbulked / `0x01` bulked). When `0x01`, **every result value is followed by a
  fully-qualified `Long` bulk count** (RLE over the whole result stream). This is separate
  from (and bigger than) the List `value_flag=0x02` bulking.
- **The pinned client reads it**: `GraphBinaryReader.js:51-62` decodes the flag + per-value
  Long; `connection.js:200-201` maps a bulked response to `Traverser(v, bulk)` instances.
- **The client requests it by default**: `driver-remote-connection.js:75-76` sets
  `requestOptions.bulkResults = true` unless overridden.
- **Backwards-compatible by construction**: default flag is `0x00` = byte-identical to
  today; bulking is opt-in per request (only for `gremlin-lang` + GraphBinaryV4, which
  mogwai is). A client that doesn't ask gets exactly today's flat frame.
- **Direction**: designed on dev@ (Aug 2024), landed in beta.1 (Jan 2025), carried into
  beta.2 (Apr 2026, our pin), spec still refined mid-2026 — the deliberate TP4 replacement
  for TP3's `Traverser`/`Bytecode` bulking. Not deprecated. (dev@ msg27793/27947; PRs #2679,
  #2826; commits msg47216/47252/47941/48173.)

**Consequence:** bulk on the wire means materialization emits `(value, N)` pairs instead of
expanding, so a first-class internal `bulk` column buys **end-to-end tractability for
element-returning big-`repeat` queries**, not merely reducer-terminal ones. The
global-bulk-column re-architecture is therefore forward-looking AND backwards-compatible,
and aligns with CLAUDE.md decision #4 (reuse the client's GraphBinary code — the
`Traverser`/bulk-decode path already ships in the build we import from).

Two hard constraints still hold: SQLite rejects recursive `GROUP BY` (so in-`repeat`
frontier collapse stays `times(n)`-unroll only; unbounded `until`/`emit` can't collapse in
one statement), and `order`/`limit`/`sample` still need bulk-aware handling or a local
unbulk.

## Staged plan (each stage lands green on trunk)

**Stage A — wire bulking plumbing, `bulk ≡ 1` (behavior-identical).**
- `wire.ts`: decode the request's `bulkResults` field → `ParsedQuery.bulked`.
- `http.ts`/`router.ts`: when `bulked`, set the header's second byte to `0x01` and append a
  fully-qualified `Long(1)` after each value buffer; else unchanged (`0x00`, flat).
- Verified by the contract test + L3 (their client is DRC → `bulkResults=true` by default),
  so the real client's bulked round-trip (decode → `Traverser(v,1)` → expand to `v`) is
  exercised immediately. This de-risks the wire path independent of any internal bulking.

**Stage B — internal `bulk` carried column, `≡ 1` (behavior-identical).**
- Add `bulk?: string` to `Carried` (context.ts) following the `sack` template (declared,
  in `carriedCols` in a pre-path slot, spliced by `carryFrag`, seeded `=1` at
  `seedSource`/`inject`, tri-stated in `carriedWith`, dropped by `withoutCarried`).
- Reducers read `SUM(bulk)` instead of `COUNT(*)` (barrier.ts count/scoped-count, numeric
  reducers weight by bulk); group counts likewise. Materialize threads `bulk` to the root
  frame; the store seam returns per-value bulk so the edge emits the real count.
- Still behavior-identical (`SUM(1)=COUNT`, `SUM(v*1)=SUM(v)`), so the ~30 sites land green.

**Stage C — enable collapse, gated (the payoff, the only behavior change).**
- Movement collapses convergent walks: `SELECT id, SUM(bulk) … GROUP BY id`; `times(n)`
  unroll sets `bulk>1` (fold `bulk.ts` into the general engine).
- `dedup()` → `bulk=1` (reset, not sum). `order`/`limit`/`range` bulk-aware (cumulative-sum
  window) or local unbulk; `sample`/`coin` unbulk when built.
- **Disable bulk-collapse under path/as/sack** (the `LazyBarrierStrategy` guard —
  `chainTracksPath` already detects path): identity-carrying traversers must not merge.
- Overflow past i64 fails loud (SQLite native, matches TinkerPop's `long` bulk).

## Bar

Each stage: contract test + L3 ≥ baseline + corpus 100% + a committed equivalence/behavior
test. A/B are behavior-preserving substrate; only C flips behavior, behind the path-free
gate. Fallback: A and B are independently valuable (wire-compat + uniform reducer
substrate) even if C is deferred.
