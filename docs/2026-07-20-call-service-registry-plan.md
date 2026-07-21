# call() + the Service Registry — a first-class, extensible service layer

**Date:** 2026-07-20
**Status:** accepted — implementation in progress (design decisions ratified 2026-07-21; see
"Design decisions & findings (2026-07-21)" at the foot of this doc)
**L3 gap addressed:** deferral bucket #2 — `unsupported source step: call` (14) +
`step not implemented: call()` (5). Feature: `map/Call.feature` (20 scenarios). Also closes the
`TextP` substring predicates (`containing`/`startingWith`/`endingWith`) — index-backed by the same
FTS5 index. (`regex` stays deferred — no index-only implementation exists and we do not scan or drop
to JS.)

> This is **not** a toy layer. `call()` is the extensibility seam for mogwai-db: services register
> into a `ServiceRegistry` and range from *pure, SQL-expressible* (list, degree, search) to
> *async / effectful / federated* (a sub-query projected down to another Durable Object graph, or
> an outbound `fetch`). The architecture is built **generic-first** so async and federated services
> are additive — the earlier services exercise the exact seams the federated call later plugs into.

## The unifying execution model — segmented plans + a Service seam

Today a read traversal is *one CTE-chained SQL statement, run synchronously*. A service whose
result comes from outside SQLite (a remote graph, an HTTP call) cannot live inside a single SQL
statement — it arrives on a Promise. So the general model becomes a **plan of segments glued by
service boundaries**:

```
[ SQL segment ] → drain to a rowset → (service transforms it; may await) → materialize → [ SQL segment ] → …
```

- A **segment** is a complete, synchronous, compile-to-SQL traversal (the existing engine, unchanged).
- A **service boundary** materializes the prior segment's rowset, applies the service (sync *or*
  async), lands the output in a temp relation keyed by the originating parent ordinal, and
  re-sources the next segment from it.
- The async gap happens **only between segments** — never inside one. This is exactly what the DO
  runtime already forces: you can't hold a SQLite cursor across an `await`, nor span
  `transactionSync` across one. The segment-drain boundary satisfies both by construction.
- A pure single-segment traversal (everything today) is the **degenerate case** — zero async
  overhead. "Compile to SQL, never interpret" holds *within* every segment; a service is an opaque
  transform between SQL-compiled stages, not a row-at-a-time interpreter.

### The `Service` seam (the spine everything hangs off)

```
interface Service {
  name: string;
  type: 'start' | 'streaming' | 'barrier';   // TinkerPop Service.Type — load-bearing for batching
  describeParams(): Map;                       // for --list --verbose
  resolve(ctx): Contribution;                  // how this service contributes to the plan
}
type Contribution =
  | { kind: 'stream';  build(input, params): Stream }         // pure: inline SQL lowering, no barrier
  | { kind: 'barrier'; apply(rows, params, env): Promise<Rows> | Rows }  // materialize → (async?) → re-source
```

- **`ServiceRegistry`** — a per-runtime DI seam, sibling to `GraphManager` (wired in
  `application(deps)`). Holds the registered services; `--list` enumerates *it* (so a new service
  shows up in `--list` automatically — no hardcoded list).
- **`CallSpec { service, params, type }`** — produced once by the front-end from
  `call`/`with`/map/traversal args, shared by every service and by the future async path.
- **Executor** (`execute.ts`) — an async orchestrator over segments: run SQL → drain → apply the
  service `Contribution` → materialize into a temp relation → seed the next segment. The outer
  data-plane seam is already `query(id, gremlin, params) → Promise<Buffer[]>`, so nothing above the
  store tier moves.

### Service naming convention

TinkerPop namespaces services by **provider**: TinkerGraph registers `tinker.search` /
`tinker.degree.centrality` (`provider.domain.verb`, dotted), with the directory service as the
special `--list`. We follow the same rule:

- **Standard services we implement for conformance keep their canonical names** — `--list`,
  `tinker.search`, `tinker.degree.centrality` — verbatim, because `Call.feature` asserts those
  literal strings and `--list` must return them. Here we are *emulating the reference provider*.
- **Our own extension services are prefixed `mogwai.`** (we are the provider): the federated call is
  `mogwai.graph.federate`; a future outbound HTTP service would be `mogwai.http.get`, etc. This
  keeps our surface un-collidable with any `tinker.*` the corpus expects, and makes provenance
  obvious in `--list`.

**Why pure services still go through this seam (not a `normalize` desugar shortcut):** the seam is
what the federated call needs. A desugar-only path for list/degree/search would be a dead end the
federated case can't fit into. Instead, pure services implement `Contribution.kind:'stream'` (they
lower to SQL inline — same performance, same correctness), and the federated service implements
`Contribution.kind:'barrier'` with an async `apply`. Same interface, same registry, same executor;
only the contribution differs. `tinker.degree.centrality` (Streaming, per-parent) and
`tinker.search` (a source builder) between them exercise the per-parent-merge and source/re-source
machinery the federated call reuses — so the federated call is genuinely *additive*.

## Constraints honored

- **Runtime parity:** FTS5 (incl. `fts5vocab`) and the JSON extension are confirmed available on
  **both** Bun and Cloudflare DO — verified against CF docs and Bun empirically. No new dependency.
- **Compile to SQL** within each segment; SQLite does the traversal.
- **Cursor / transaction not held across `await`** → segment-drain boundaries (the async model
  *requires* the drain the runtime already mandates).
- **No triggers** (see FTS section): DO trigger support is unconfirmed *and* our value encoding
  needs application-level awareness — index maintenance lives in the write path we already own.

## The services

### `--list` — DirectoryService (pure, Start)

Enumerate the `ServiceRegistry`: emit each registered service name (default), filtered by the
`service` param; `verbose` → the JSON describe blob (`name` / supported types+requirements /
params). The DirectoryService itself is not listed. Because it reads the live registry, adding the
federated service later makes it appear in `--list` with no extra work.

### `tinker.degree.centrality` — per-vertex edge count (pure, Streaming)

Per input vertex, `count(v.edges(direction))`, `direction` default IN, bulk-aware. Lowers through
the **scoped-count child-scope seam** (`pushChildScope` + `lowerScopedScalarReducer`) — i.e. the
same per-parent-results-merged-by-ordinal substrate the federated barrier reuses. `where(call(…).is(n))`
falls out of the child seam. The `project("vertex","degree").by(select("v")).by()` scenarios need a
**`project()`-over-scalar** extension (`lowerScalarProject`, `select.ts`) so a `by(select(label))`
field emits a path-history *element* alongside the scalar degree — a self-contained addition.

### `tinker.search` — full-text search over property values (pure, Start, **FTS5-backed**)

Backed by a real **FTS5 trigram index, `case_sensitive 0`** (the default). Matching is done with the
`LIKE`/`MATCH` the trigram index accelerates (query plan verified: a `case_sensitive 0` trigram index
serves `LIKE '%term%'` from the index — `idxStr L0` — whereas `case_sensitive 1` only serves `GLOB`).
`.element()` walks the matched `Property` to its owner (reuses the existing `PropertyStream`
`element()` tail). `type` ∈ {Vertex, Edge, VertexProperty} selects the row scope.

- **Case-insensitive — a documented divergence.** TinkerPop's `.*(term).*` is case-sensitive; ours
  is case-insensitive, because that is what lets the trigram index serve `LIKE`. It still passes
  conformance (the reference graphs are single-case) and is consistent with our `TextP` behavior
  (below). We document the divergence rather than chase case-sensitivity into a `GLOB` rewrite.
  - *Why not GLOB / `case_sensitive 1`?* Its only gain is case-*sensitive* matching (TinkerPop
    fidelity) — the very thing we chose to drop. It costs more: one trigram index serves *either*
    `LIKE` *or* `GLOB` (case settings are mutually exclusive, so both would need two indexes); `GLOB`
    has **no `ESCAPE` clause**, so literal `*`/`?`/`[` must be escaped as char classes (`[*]`) vs the
    clean `LIKE … ESCAPE '\'` already in the code; and it doesn't help `regex` or the <3-char floor.
    Not worth it.
- **Index-only contract → fail closed when the index can't answer.** No scans, no JS. So a `search`
  term < 3 chars (below the trigram floor) and a raw `regex` param both **fail closed** with a clear
  deferral. There is no O(n) fallback anywhere in the service.

### Federated DO graph call — **built last, on the generic seams** (async, Barrier)

`g.V().call("mogwai.graph.federate", {graph, traversal}).…` projects a sub-traversal **down to a sibling
graph** and merges the results into the current tree. Implemented purely on the seams above:

- Registers as a `Contribution.kind:'barrier'` service with an **async `apply`**.
- **Projection = the existing data-plane seam:** `query(siblingId, subGremlin, params) →
  Promise<Buffer[]>` *is* "run a traversal on another graph." One graph = one DO, so cross-graph =
  cross-DO. Per-runtime env: DO → sibling DO stub (`env.NS.get(idFromName)`), Bun → sibling
  `GraphManager` entry. The `ServiceRegistry` DI hands `apply` this env.
- **Batching:** `type:'barrier'` + `ChunkSize` — collect inputs, project one (or a few, bounded-
  concurrency) sub-queries, not N serial calls.
- **Merge into the tree:** decode the returned GraphBinary → **foreign-element materialization**
  (land ids/props in a temp relation, exposed as an `ElementStream` of detached/reference elements,
  or opaque maps if no local movement is wanted) → JOIN back on the originating parent ordinal so
  path/`as()` linkage is preserved, exactly like a `flatMap`'s children.
- **Recursion:** the sibling DO runs the *same* engine on the projected sub-traversal — genuine
  federated query pushdown.

## FTS5 + proper JSON handling (write-path maintained)

The search index is a standalone FTS5 virtual table, maintained in the write path
(`applyVertexProperty` / `insertEdgeProperty` / `drop` in `write.ts`) — **not** via triggers (DO
trigger support unconfirmed, and our encoding needs application awareness). Proposed shape:

```
CREATE VIRTUAL TABLE property_fts USING fts5(
  owner_elem UNINDEXED,    -- 'node' | 'edge' — which normalized table `pid` keys into
  pid UNINDEXED,           -- vertex_properties.id OR edge_properties.id (the FK-shaped join key)
  owner UNINDEXED,         -- the owning nodes.id / edges.id
  pk UNINDEXED,            -- the property key (filter by key without a join)
  kind UNINDEXED,          -- 'value' | 'jsonkey' | 'jsonleaf'
  text,                    -- the ONLY indexed column (the searchable text)
  tokenize="trigram case_sensitive 0");   -- case_sensitive 0 = default (LIKE served, not just GLOB)
```

> **DDL correction (verified 2026-07-21):** the tokenizer options go INSIDE the `tokenize`
> string (`tokenize="trigram case_sensitive 0"`). Writing `case_sensitive 0` as a *separate*
> column option (as an earlier draft of this block did) errors with `unrecognized column option: 0`.
> `pid` is a plain data column, NOT the FTS `rowid`: a collection property produces one `value`
> row plus N `jsonkey`/`jsonleaf` rows that all share one `pid`, so they'd collide on rowid.
> Delete-by-column (`DELETE FROM property_fts WHERE owner_elem=? AND pid=?`) works fine on an
> FTS5 table (UNINDEXED columns are stored + filterable). Empirically confirmed on bun:sqlite:
> `text LIKE '%sub%'` and `text MATCH '"sub"'` are both index-served (`… VIRTUAL TABLE INDEX 0:L0`
> / `0:M…`), including inside a correlated `EXISTS(… WHERE f.owner=n.id AND f.text MATCH ?)`.

- **Values are the `{t,v}` ValueNode encoding.** A naive `json_tree` over the stored JSONB would
  index tag noise (`"t"`,`"v"`,`"map"`,`"str"`) and an indirected shape. So the write-path indexer
  is **ValueNode-aware** (same logic as `frameTypedNode`/`propNodeExpr`), emitting:
  - one `kind='value'` row = the value's *logical* `toString()` (faithful to
    `p.value().toString()`, so a collection like `["a","brave"]` matches `search "brave"` via its
    toString — matching TinkerPop, and covering `tinker.search` fully); plus
  - `kind='jsonkey'` / `kind='jsonleaf'` rows from walking the logical tree (`json_tree` over the
    *reconstructed* plain JSON) — so nested keys and typed leaves are individually searchable. This
    is the "handle JSON properly" capability, beyond `tinker.search`.
- **No backfill / migration:** mogwai-db has never been deployed, so there are no existing graphs.
  The `property_fts` table is part of `initSchema` from the start and every write maintains it from
  the first insert — no lazy rebuild or schema-upgrade path to carry.
- **CF cost note:** virtual-table writes count against the DO row-write quota — property writes get
  more expensive. Acceptable and intentional now that search is a first-class capability.
- **Verified:** `json_tree` recursively walks nested objects/arrays; feeding leaves+keys into an
  FTS5 trigram table matched nested content (`brav`→`brave` in `nested.tags[1]`; keys like `city`).

## TextP string predicates via the same FTS5 index

This phase stays in **this** plan on purpose: `tinker.search` and `TextP` are two independent
consumers of the *same* FTS5 index, so building both is what proves the index is a general
capability rather than something shaped to a single caller. If only `tinker.search` used it, the
index could quietly encode search-service assumptions; making `has(k, containing(x))` share it
forces the write-path maintenance, the ValueNode-aware indexing, and the trigram semantics to be
correct for a plain filter predicate too.

**Current reality (do not assume these are unimplemented):** `containing`/`startingWith`/
`endingWith` (and `not*`) already compile today — to `LIKE` (`plan.ts:271,281-283`), which is
**case-insensitive** (SQLite `LIKE` folds ASCII case; `LIKE 'M%'` matches both `marko` and `MARKO`).
That diverges from TinkerPop's case-sensitive `String.contains`/`startsWith`/`endsWith`, but it is
masked because the reference graphs are single-case. **We keep the case-insensitive behavior and
document it** — it is not a bug we chase, and it is exactly what makes the FTS index usable. Only
`regex`/`typeOf` actually throw today.

So this phase is a performance + coverage step, not a semantics change:

1. **Index-back the substring predicates.** Route `containing`/`startingWith`/`endingWith` at the
   same `LIKE` they already emit through the `case_sensitive 0` trigram index (rewrite the predicate
   to select against `property_fts`). For `|x| ≥ 3` this is served *from the index* — no scan. The
   emitted operator and its case-insensitive result are unchanged; it just stops being a base-table
   scan. This shares the exact index `tinker.search` uses, which is the point of keeping the phase
   here.
2. **The <3-char floor fails closed.** Trigram cannot index a pattern with < 3 non-wildcard chars —
   independent of case. Given "no table scans," a substring predicate whose term is < 3 chars has no
   index-only answer, so it **fails closed** (a clear deferral), the same rule as the search service.
   This is also the least code: a length guard that throws, no separate <3-char path to build.
3. **`regex(x)` stays deferred.** No index-only implementation exists, and we do not scan or drop to
   JS — so it remains a clear throw, documented. (`typeOf` is a separate concern, also unchanged.)

## Conformance + L4

- **L3:** `map/Call.feature` (20) + the TextP string-predicate scenarios. `call` is already in L3
  scope (runs+fails, not skipped) — no `tags.ts` change.
- **L4 (our addendum — we author scenarios for everything we build):** FTS substring matching and
  its **documented case-insensitivity**; nested-JSON key/value search; **<3-char fail-closed**
  behavior (service and predicate); index-backed `containing`/`startingWith`/`endingWith`; the
  federated-call merge (`@gap:` tagged for the upstream give-back where the official corpus has no
  coverage).
- **L2 SQL snapshots** + **`compiler.test.ts`** execution semantics for each new emitted shape.
- **L1** stays 100% (no grammar change). Clean L3 run re-records `l3-state.json` + syncs the count.

## Phasing (federated is genuinely last, on shared seams)

| Phase | Deliverable | Notes |
|---|---|---|
| 1 | **Generic spine:** `CallSpec` + `ServiceRegistry` DI + `Service`/`Contribution` interface + segment-ready plan type + executor loop (degenerate single-segment) | the foundation everything reuses |
| 2 | `--list` reading the live registry (+ filter/verbose) | 7 scenarios |
| 3 | `tinker.degree.centrality` via the child-scope reducer seam + `project()`-over-scalar | 6 scenarios; exercises per-parent merge |
| 4 | `tinker.search` on FTS5 trigram + ValueNode-aware JSON write-path indexing + fail-closed + `element()` | 7 scenarios; builds the real search index |
| 5 | `TextP`: **index-back** `containing`/`startingWith`/`endingWith` (same case-insensitive `LIKE`, now served by the trigram index) | shares the search index; <3-char fails closed; `regex` stays deferred |
| 6 | **Federated DO graph call** — async barrier service on the Phase-1 seams: projection via `query()`, foreign-element materialization, parent-ordinal merge, Barrier/ChunkSize batching | last; additive, no engine rewrite |

## Semantics & hard parts (honest)

- **No single-snapshot atomicity across a service await** — a segmented traversal reads the graph at
  multiple points in time; concurrent writes between segments are visible. You cannot hold a
  transaction across the fetch. Expected for a federated/effectful query; stated explicitly.
- **Failure / timeout / partial-result policy** for async services (errors already ride the
  GraphBinary status trailer; retries/timeouts are new policy).
- **Foreign elements** are detached references, not local rows — no unbounded local graph movement
  over them unless materialized.
- **Non-determinism** — effectful services can't be treated as pure for replan/caching.

## Fail-closed edges (correct-by-design, never mis-execute)

- ~~Any substring match with a term < 3 chars (below the trigram floor) → deferral.~~ **SUPERSEDED
  (2026-07-21) — see "Substring rule (final)" below.** A <3-char substring does NOT fail closed; it
  falls back to a LIKE table scan, consistently everywhere (predicate + `tinker.search`), because
  computed-scalar / injected-list substrings have no stored property to index and fail-closed would
  regress TinkerPop's own <3-char corpus scenarios.
- `regex` (service param or `has(k, regex(x))`) and `typeOf` → deferral. No index-only path; we do
  not scan or drop to JS. (CLAUDE.md's wire-protocol note has been corrected to this no-JS rule —
  it previously said the opposite.)
- Non-constant per-traverser call params → deferral until the barrier param-eval path lands.
- `type: VertexProperty` meta-property search → empty on the reference graphs (documented).

## Design decisions & findings (2026-07-21)

Ratified during the design phase, after a full codebase trace and empirical FTS5 verification on
bun:sqlite. These pin down the choices the proposal left open; nothing here relitigates the
proposal, it commits it.

### Scope

- **Build Phases 1–5. The async federated barrier (Phase 6) is deferred**, but the `Contribution`
  type carries the `'barrier'` variant *now* so the seam is provably additive; its executor path
  throws a clear Phase-6 deferral. This gets all 20 `Call.feature` scenarios + the TextP scenarios
  green with **zero async** in the compiler.
- **The whole compile → lower → materialize pipeline stays synchronous.** Every Phase-1–5 service
  is `Contribution.kind:'stream'` and lowers to SQL inline. The `await` Phase 6 needs lives one
  level up in `execute.ts` (`executeFramed` becoming a segment orchestrator) — `GraphManager.query`
  is already `Promise`-typed, so that seam's contract doesn't move; today's vestigial Promise just
  gains substance. **No async surface is added to `steps/*`, `plan.ts`, `q.ts`, or `render.ts`.**

### Architecture

- **New subsystem `src/services/`**, one file per service (mirrors `steps/*.ts`): `types.ts`,
  `registry.ts`, `call-params.ts`, `directory.ts`, `degree-centrality.ts`, `search.ts`.
- **`defaultRegistry` is baked into the `GraphManager` at construction — a store-tier concern, not
  HTTP-edge DI.** `router.ts`/`application.ts` stay unaware of services (strictly smaller diff,
  correctly scoped — services sit at the same tier as `Sql`). Phase 6's federated service is where a
  per-runtime `env` (sibling-DO stub vs Bun `GraphManager` entry) gets injected at that construction
  site. The registry rides on `Carry`/`CompileOptions` beside `fastPaths`, same threading precedent.
- **`call()` routing reuses existing seams — no new orchestrator:**
  - *Source* (`g.call(…)`): a peer branch to `buildPrefix` in `compileRead` (`seedCall`) returns a
    `Stream` of whatever shape the service yields (`ListStream` for `--list`, `PropertyStream` for
    `search`), fed straight into the existing `lowerSteps`/`materializeFinal`. `search`'s
    `.element()` reuses the already-registered `propertyElement` tail — no new tail code.
  - *Mid-traversal* (`V().call(…)`): `lowerCall` pushes a child scope; `degree.centrality` is
    `scopedElementCount` (`child.ts:534`) + `lowerScopedScalarReducer` verbatim. Adding `'call'` to
    `scalarRowParts`'s recognized set makes `where(call(…).is(n))` compose for free.
  - `.with()` is a modulator folded onto the preceding `call` in `strategies.ts` (mirrors
    `foldByModulators`). The 5 param-source forms (map literal / bound-param map /
    `__.project().by(__.constant())` / `.with(k,str)` / `.with(k,__.constant())`) unify into one
    `Record<string,unknown>` in `call-params.ts`. Non-constant per-traverser params fail closed.

### Substring rule (final — settled 2026-07-21 after two revisions)

**ONE consistent rule everywhere** — `has(k, substring)` on a stored property, `is(substring)` on a
computed scalar, `all()`/`any()` on an injected list, AND `tinker.search`:

- Substring matching (`containing`/`startingWith`/`endingWith` + `not*`) is **case-insensitive**.
- **≥3 chars over a stored property** → the `property_fts` trigram **index** (a fast path over LIKE;
  `ftsSubstringPredicate` toggle, equivalence-tested against the generic LIKE for the same result).
- **<3 chars, OR a substring over a computed scalar / injected list** (no stored property exists to
  index) → the generic **LIKE table scan** (same case-insensitive result, unindexed).
- **No fail-closed.** An unindexed scan under 3 chars is a documented, *consistent* characteristic
  — the same everywhere, so no surprise. This replaces the proposal's original "<3 → deferral":
  fail-closed was rejected because (1) computed/injected substrings have no property to index so
  LIKE is architecturally required there anyway, and (2) it would regress ~4–6 currently-green L3
  scenarios that use TinkerPop's own <3-char terms (`endingWith('as')`, `notStartingWith('z')`,
  `inject(...).all(startingWith('a'))`). The generic LIKE path therefore **stays** (it is both the
  <3/computed path and the `ftsSubstringPredicate:false` equivalence fallback) — it is NOT ripped out.
- `regex`/`typeOf` remain deferred (SQL-inexpressible, unchanged).

### FTS5 + TextP (empirically verified on bun:sqlite 1.3.11; CF DO per docs)

- Single `property_fts` trigram table (DDL above), maintained in the write path
  (`applyVertexProperty`/`insertEdgeProperty`/`compileDrop`) — **not** triggers. The indexer is
  ValueNode-aware and walks the **in-memory `{t,v}` tree** (not `json_tree` over stored JSONB) —
  which sidesteps the tag-noise concern entirely, since the tree is a JS object before serialization.
- TextP `containing`/`startingWith`/`endingWith` (+`not*`) route through the index via a gated fast
  path (`ftsSubstringPredicate`) inside the existing `nodeHasProp`/`edgeHasProp` choke point; generic
  `LIKE` stays the semantic authority + equivalence test. **Anchored ops = MATCH (index prefilter) +
  the existing `likePattern` `LIKE` (position confirm)** — verified index-served and correctly
  excluding mid-string false hits. The MATCH argument is FTS query syntax, so the user term is
  wrapped as a literal phrase (`"term"`, internal `"` doubled) — this still substring-matches on a
  trigram index even when the term is an operator word like `AND`; do **not** reuse `LIKE`'s
  `%`/`_`/`\` escaping for the MATCH arg (different grammar).
- `<3-char` floor: a 2-char `MATCH` returns **empty silently** — so the guard is an explicit throw
  at compile time, shared by the service and the predicate. `merge`-match conds (`write.ts`) are
  deliberately **not** rewritten (out of scope, no `fastPaths` in that closure). `regex`/`typeOf`
  unchanged.

### Capability gaps surfaced (extend the seam, never a bespoke one-off)

- **GAP 1 (extending now, as its own tested step):** the degree scenario
  `project("vertex","degree").by(select("v")).by()` runs `project()` over a **scalar** parent (the
  degree) while `by(select("v"))` must emit a path-history **element**. `lowerScalarProject`
  (`select.ts:277`) rejects alias/string-key fields today. Fix = add an element-alias field branch
  to the scalar-parent project path, **reusing `tryLowerTraversalRecord`'s existing element-alias
  framing** (`select.ts:77-79,104-121`: read `st.carried.aliases`, frame via `framedProps`). Lands
  with its own SQL snapshot + execution test.
- **GAP 2 (fail closed for now):** `tinker.search` with no `type` could mix vertex+edge properties,
  but `PropertyStream` carries a single static `ownerElem` tag. Decision: **default to
  `type=Vertex`** (matches TinkerGraph's reference impl and every `Call.feature` scenario); explicit
  `type=Edge` uses a static `ownerElem='edge'`; a genuine mixed request fails closed. No
  `PropertyStream` change — `property_fts.owner_elem` already carries what a future per-row-dynamic
  variant would need, so it's additive.

### Build order

1. Spine (`types.ts`/`registry.ts`) + no-op `registry` threading. 2. `call`/`with` fold +
`call-params` resolver. 3. `seedCall` routing + unknown-service throw. 4. `--list` (7 scenarios).
5. `degree.centrality` + `lowerCall` + child scope + the GAP-1 scalar-project-alias extension
(6 scenarios). 6. `property_fts` schema + write-path indexer (**tested in isolation first**).
7. `tinker.search` consumer (7 scenarios). 8. TextP index-backing (equivalence + EXPLAIN test).
9. L3 ratchet re-record + `SYNC_FILES`. Each step: L2 snapshot + `compiler.test.ts` execution +
L4 addendum where applicable; L1 stays 100%.
