# call() + the Service Registry — a first-class, extensible service layer

**Date:** 2026-07-20
**Status:** proposed
**L3 gap addressed:** deferral bucket #2 — `unsupported source step: call` (14) +
`step not implemented: call()` (5). Feature: `map/Call.feature` (20 scenarios). Also closes the
`TextP` string-predicate deferrals (`containing`/`startingWith`/`endingWith`, the "Binding
expected string…" bucket + `regex`).

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

Backed by a real **FTS5 trigram (`case_sensitive 1`)** index — case-sensitive substring matching
that reproduces TinkerPop's `.*(term).*` semantics exactly (verified: `ada`→`vadas` mid-string;
`MARKO`≠`marko`). `.element()` walks the matched `Property` to its owner (reuses the existing
`PropertyStream` `element()` tail). `type` ∈ {Vertex, Edge, VertexProperty} selects the row scope.

- **Index-only contract → fail closed when not index-expressible.** The `tinker.search` *service*
  is index-backed by design: anything the FTS index can't answer fails closed with a clear deferral
  rather than silently scanning — i.e. a `search` term < 3 chars (below the trigram floor) *and* a
  raw `regex` param (arbitrary regex isn't FTS-expressible). No O(n) fallback in the service.
- **This differs deliberately from the `TextP` predicate**, which is required-correct and therefore
  *does* get the fallbacks (case-sensitive scan for short terms; the JS-filter barrier for
  `regex`). So `has(k, regex(x))` is implemented, while `call("tinker.search", {regex})` fails
  closed — the service keeps a hard index-only guarantee, the filter keeps correctness. (Flag if
  you'd rather the service also fall back to the JS barrier; neither is needed by conformance.)

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
  owner UNINDEXED, owner_elem UNINDEXED, vpid UNINDEXED, pk UNINDEXED,
  kind UNINDEXED,          -- 'value' | 'jsonkey' | 'jsonleaf'
  text,                    -- the searchable text
  tokenize='trigram case_sensitive 1');
```

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
`endingWith` (and `not*`) already compile today — to `LIKE` (`plan.ts:271,281-283`). But SQLite
`LIKE` is **case-insensitive** for ASCII, whereas TinkerPop's `containing`/`startingWith`/
`endingWith` are **case-sensitive** (`String.contains`/`startsWith`/`endsWith`). So the current
impl is a **latent case bug** — `LIKE 'M%'` matches both `marko` and `MARKO` — masked only because
the reference graphs are single-case. Only `regex`/`typeOf` actually throw today.

So this phase is two things, correctness first:

1. **Fix case-sensitivity** of the substring predicates:
   - `|x| ≥ 3` → FTS trigram `MATCH` (`case_sensitive 1`) — exact *and* indexed;
     `startingWith`/`endingWith` add an anchor/boundary check on the candidate.
   - `|x| < 3` (below the trigram floor) → a **case-sensitive** SQL scan — `instr(x, needle) > 0`
     for `containing`, `substr(...)=needle` for `startingWith`/`endingWith`. **Not plain `LIKE`**
     (that is the bug). A predicate must be correct, so it falls back to a scan, never fail-closed —
     unlike the `tinker.search` *service*, which is index-only and fails closed on short terms.
2. **Implement `regex(x)` (no longer deferred)** via a **synchronous JS-filter barrier** — the
   Phase-1 machinery: materialize candidate rows, apply `new RegExp(pat)` in JS, re-source. This is
   the mechanism CLAUDE.md already names ("regex … filtered post-SQL in JS inside the DO"). FTS
   narrows candidates only when a ≥3-char literal is extractable from the pattern; otherwise it is a
   full scan + JS filter. (`typeOf` remains its own separate concern.)

## Conformance + L4

- **L3:** `map/Call.feature` (20) + the TextP string-predicate scenarios. `call` is already in L3
  scope (runs+fails, not skipped) — no `tags.ts` change.
- **L4 (our addendum — we author scenarios for everything we build):** FTS substring + case-
  sensitivity fidelity; nested-JSON key/value search; short-term **fail-closed** behavior; TextP
  short-term fallback correctness; the federated-call merge (`@gap:` tagged for the upstream
  give-back where the official corpus has no coverage).
- **L2 SQL snapshots** + **`compiler.test.ts`** execution semantics for each new emitted shape.
- **L1** stays 100% (no grammar change). Clean L3 run re-records `l3-state.json` + syncs the count.

## Phasing (federated is genuinely last, on shared seams)

| Phase | Deliverable | Notes |
|---|---|---|
| 1 | **Generic spine:** `CallSpec` + `ServiceRegistry` DI + `Service`/`Contribution` interface + segment-ready plan type + executor loop (degenerate single-segment) | the foundation everything reuses |
| 2 | `--list` reading the live registry (+ filter/verbose) | 7 scenarios |
| 3 | `tinker.degree.centrality` via the child-scope reducer seam + `project()`-over-scalar | 6 scenarios; exercises per-parent merge |
| 4 | `tinker.search` on FTS5 trigram + ValueNode-aware JSON write-path indexing + fail-closed + `element()` | 7 scenarios; builds the real search index |
| 5 | `TextP`: **fix case-sensitivity** of `containing`/`startingWith`/`endingWith` (LIKE→FTS/`instr`/`substr`) + **implement `regex`** via the JS-filter barrier | corrects a latent case bug + closes the `regex` throw |
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

- `tinker.search` service: term < 3 chars **or** a raw `regex` param → deferral (index-only
  contract). NB `has(k, regex(x))` is *not* here — the TextP predicate implements regex via the
  JS-filter barrier (Phase 5); only the *service* fails closed.
- Non-constant per-traverser call params → deferral until the barrier param-eval path lands.
- `type: VertexProperty` meta-property search → empty on the reference graphs (documented).
