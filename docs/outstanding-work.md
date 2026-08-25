# Outstanding work

This is an index, not a backlog or a conformance report. The feature matrix records
per-step support; closed work belongs in git history or `docs/archive/`.

## Compounding substrate

- **RelIR completion.** Finish the algebra passes and generic lowering needed for nested
  child bodies, row operations, recursion, paths, and branch arms. These are shared
  mechanisms, not step-by-step projects. Start with
  [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Value carriage and framing.** Preserve exact scalar types through JSON-backed
  collections, member variants, maps, aliases, paths, and format adapters. This also
  covers meta-property value typing. The rules are the RelIR plan §6·7; the live gaps
  are its §10. See [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Set-based writes.** The row-at-a-time write driver is GONE — the runtime write path is now
  one relational `Insert`/`Delete` over `json_each` (`src/setwrite.ts`), the bulk loader and IO
  drains ride it, and format reads cross a page's owners as one `json_each(?)` membership
  (`src/formats/drain.ts`). The dependent UPSERT write form has LANDED as the loader's
  `onCollision: 'replace'` mode (`src/bulk.ts` `resolveReplace`): a whole-batch, snapshot-domain,
  last-write-wins match on natural id — a vertex keeps its rowid + edges and replaces its property
  subtree, an edge is delete-and-reinserted. It is reachable programmatically (`loadBulk`,
  `loadGraphson`, `loadCsv`); the remaining wire is a `g.io(...).with(...)` STEP modulator to select
  the policy from a traversal, which is front-end work (a new `io()` option), not substrate.
  See [the RelIR plan](./2026-08-01-relir-build-plan.md).
- **Retained relations.** The named-collection substrate is DONE and its plan is archived
  ([named collections](./archive/2026-08-09-named-collections-are-bindings-plan.md)) — multi-site
  accumulation, snapshot bindings, declared merge policies, keyed `group`/`groupCount` merge, mixed
  member shapes, and safe `cap().unfold()` re-entry all landed. One feature remains, a **KEYED-label
  seeded merge** (`withSideEffect("a", <map seed>).group("a")…`): a separate multi-mechanism feature
  (a map-level `GroupBiOperator` per-key merge + a mixed group-VALUE list), not a leaf of the
  collection doc. It fails closed today (`collection.ts` `registerGrouping`); building it is its own
  future plan. Its downstream gaps (path/`simplePath`/`sample`/`within` operand) are owned by their
  respective substrates.
- **Encounter and order.** Establish the missing encounter/rejoin authority for fan-out
  child bodies and the consumers that need deterministic order.

## Product capabilities

- **Graph capabilities:** `tree`, `match`, graph algorithms, and the remaining
  strategy/options forms. Pick a family only after identifying the substrate it needs.
  - *Graph algorithms* — the barrier substrate and the GDS-style library are DONE and archived
    ([barrier substrate reshape](./archive/2026-08-23-barrier-substrate-reshape-plan.md); 14
    algorithms + the four native OLAP steps, all reference-faithful). Two pieces remain, both
    deferred with cause there: **barrier-in-body slice 2** (per-parent nesting by promotion for
    `local`/`union`-arm/`by`-child/unbounded-`repeat` bodies — needs a tree `Plan` + drive-as-stack +
    the `scope=parent` key, and its clean OLAP consumer is blocked on the unresolved graph-filter
    question; unbounded-`repeat` stays P3 fail-closed forever), and the **order-dependent GDS
    algorithms** (`labelPropagation`, `louvain`, `eigenvector` — not clean set-based reuse; each
    would need new substrate or a variant that diverges from GDS's exact oracle).
- **Services and graph movement:** federation tails, bulk materialization, and IO formats. The
  `GraphSource` abstraction (one traversal vocabulary over base + injected/federated subgraphs) is DONE
  and its plan is archived
  ([graph-source](./archive/2026-08-21-graph-source-abstraction-plan.md)). Three by-design deferrals
  remain, all fail closed today, none an engine wall: **bound WRITES** (a fetched subgraph is an
  immutable snapshot), **FTS/`trigramSeek` over a bound graph** (no landed FTS index — build when a use
  case reaches it), and one **path+encounter combo** (a bound path chain that also demands an emission
  encounter — the seed cannot carry both the path append and the order renumber).
- **`io()` is MEMORY-bounded, not yet TIME-bounded.** The whole `io()` path streams end to end —
  `IoStore` is `readStream`/`writeStream` (R2 multipart on the DO), GraphSON/CSV drain through
  `BatchingLoader`, and the GraphSON read is a two-pass byte stream — so a graph up to a DO's 10 GB
  ceiling moves in/out without materializing (peak memory is one page / one part; the R2 sink and the
  two-pass reader are covered by `test/io-streaming.test.ts`). What is NOT yet solved is a single
  request's WALL-CLOCK / CPU budget: a 10 GB load or dump will not finish in one DO invocation, so the
  next step is a RESUMABLE `io()` — a keyset cursor persisted per (path, direction) so a read resumes
  at the next vertex line / edge line and a write resumes at the next R2 part (R2 `resumeMultipartUpload`
  exists for exactly this). Two perf follow-ons, both optimizations not correctness: the two-pass read
  looks up every edge endpoint against the store even under `idPolicy:'preserve'` with numeric ids
  (where the source id IS the rowid — a short-circuit would skip it, at the cost of the dangling-ref
  existence check), and it `JSON.parse`s each line twice (once per pass). Neither moves the memory bound.
- **Operations:** a real Cloudflare deployment, graph authentication, transaction/session
  semantics, and GraphSON response encoding.
- **Query-plan performance.** The join-order fence and source seek made filtered lookups
  plan-stable without stats (RelIR plan §1 P4), and `test/plan-stability.test.ts` guards it
  (graph-sized access paths identical with and without stats over a 4000-vertex fixture). One
  follow-on remains, an optimization now rather than a correctness fix: a `PRAGMA optimize`
  schedule to gather the stats DO allows but cannot bound — after a bulk load / `io().read()`,
  on the DO alarm or after N writes; never per request.

## Maintenance

- Keep the `antlr4ng` patch live until upstreamed; regenerate and compare `parser/` when
  updating TinkerPop.
- Keep the existing architecture, bind-budget, type-check, and conformance gates green.
  Do not add a second build or test tool.
- Keep the feature-support matrix accurate as capabilities land.
- **Duplication / smell consolidation** — a whole-`src/` audit with a risk-sequenced menu of
  behaviour-preserving extractions (most finish a factoring the code already began). Not a
  commitment; pick items when a file is open anyway. See
  [the duplication & smells plan](./2026-08-25-duplication-and-smells-plan.md).
