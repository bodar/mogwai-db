# Outstanding work

An index of what is LEFT, in priority order. Per-step support lives in the
[feature matrix](./feature-support-matrix.md); finished work lives in git history and `docs/archive/`.

**Instruments.** L3 floor: `test/L3-conformance/l3-state.json` (deferral buckets in
`l3-telemetry.summary.json`). RelIR coverage by family: `mise run rel-blockers`. Fail-closed check:
`test/L7-census/deferrals.tsv` must hold no `crashed` rows.

## 1. Wrong answers today

Each is a lost or duplicated row, a wrong number class, or a wrong value.

- **`barrier(Barrier.normSack)` mis-executes instead of declining** — `withSack(1.0).V().both()
  .barrier(normSack).sack()` gives twelve `1`s; the reference divides each sack by the total.
- **`g.V(1,1)` is one traverser** — the reference gives two (a repeated literal id is a lost row).
- **`dedup()` keeps `[a:1,b:2]` and `[b:2,a:1]` apart** — a map's identity should be its entries in
  any order, read by every dedup/group/set-op site.
- **Untagged whole REAL re-injected by a value barrier frames as an Int** (`lowerValueResume`).
- **Set-op literal operand loses member class** — `combine([1.0d])` reads a whole Double back as an Int.
- **Intermediate `sum` overflow not widened** — a running total that leaves the Long range and returns.
- **`mean()` of a BigInteger** answers a Double (reference: BigDecimal).

## 2. Needs a human call

- **GraphQL redesign.** The reflection-derived schema was a mistake
  ([plan, top section](./2026-08-07-graphql-front-end-plan.md)). Replace it with an explicit,
  human-defined schema/views registered via an API (Neo4j GraphQL type-defs / CouchDB design-doc views).
  🔴 Decide: SDL+directives vs views-as-traversals, storage, versioning. Follow-ons under it:
  - a `_gremlin(query:)` raw-Gremlin escape field;
  - mutations generated from the defined schema;
  - measure bind count / 100 KB SQL text for depth-4 selections.

## 3. Compounding substrate

- **RelIR completion.** `mise run rel-blockers` ranks the open families (branch arms, writes,
  scalar-transform composition, aliases, map/list shape, row ops, side effects).
  [RelIR build plan](./2026-08-01-relir-build-plan.md) §10 is the live-gap worklist.
- **Value carriage.** Keep exact scalar types through JSON-backed collections, member variants, maps,
  aliases, paths and format adapters. Concretely: carry the child reducer's type (`produced.vtype`) and
  productivity so `by(sum/mean/…)` works in `project`/`aggregate`/`store`/`where`, not only `group`.
- **Value barriers carry the traverser's channels.** `split()`/regex/`lowerValueResume` re-root the
  stream, so a label/path/sack bound before them declines. Then SPIKE exact big-number predicates
  (REAL-band prefilter + JS BigInt compare) — deferred by Dan.
- **Exact decimal arithmetic.** `values('p').sum()` over `1.5m` and `2` defers (decimal-TEXT values
  can't go through SQL `sum`); `fold(seed, Operator.x)` declines classes outside int/long/double.
- **Path as a value.** `path().order()`, `path().group()` (needs a `{t:'path'}` arm in
  `frameTypedNode`/`listNodeExpr`), `path().fold().unfold()`.
- **Per-origin slice in a batched `union`/`choose` arm or bounded-`repeat` body** under an outer
  per-origin scope — thread the arm-minted origin through `mintTraverserMajor` (`lower/branch.ts`).

## 4. Sensible queries we decline

- **Merge residue.** Explicit list/set cardinality on a runtime merge arm; map-driver merge holding
  `T.id`, a list-valued map (e.g. from `valueMap()`) or a multi-label map; map-driver `mergeE` with
  `option(Merge.outV/inV)` or an onCreate endpoint; `mergeE` over an incoming vertex stream
  (`elementMergeE`); edge runtime arm value `option(onMatch,[k:__.trav])`; the local-slice corpus form
  `mergeV(__.select("m").limit(local,1).unfold())` (could move L3). PartitionStrategy-aware upsert (×7 L3).
- **`match()` residue.** A binding `or` branch; `map(<mean>)` body; `fold()` end;
  ProductiveByStrategy null-keeping; `where('a',P)` over scalar aliases / non-eq ops; per-origin slice
  in a pattern body; `match` over a map stream (`g.V().valueMap().match(as('a').select('name').as('b'))`);
  `concat(constant(…), select('b').by('name'))` (likely a concat-with-select-child gap).
- **`where(without('x'))` after `aggregate('x')`** — lower as `NOT IN (SELECT … FROM <collection>)`.
- **`repeat(...).until(where(eq('a')))`.**
- **`choose()` with mixed list-shaped arms** — `choose(hasLabel('person'), out().fold(), values('name').fold())`.
- **`group().by(k).by(out().limit(1).fold())`** — a per-key `ROW_NUMBER` window.
- **Keyed-label seeded merge** — `withSideEffect("a", <map>).group("a")…` (per-key `GroupBiOperator`;
  `collection.ts` `registerGrouping`).
- **Bare-list `[1L]`/`[1.0f]` literal** declines at `listLiteralBlob`.
- **`filter(__.identity())`** — the one lattice gap L5 names.
- **`property(T.label)` on an existing element** (label append) — genuine future work; see debt for `T.id`.

## 5. Product capabilities

- **Strategies** (`src/compiler/ir/strategies.ts`) — the largest L3 clusters:
  `SubgraphStrategy(edges: __.or(…))`, `SubgraphStrategy(vertexProperties:)`, `includeMetaProperties`,
  ProductiveByStrategy on a non-standard host. No rule yet wraps a criterion around a mutation.
- **Step vocabulary (matrix-fill).** `tree`, `subgraph('sg')`, `withSack(seed, Operator)`,
  `mean/sum(Scope.local)` over a value list, string steps inside `repeat`, null carriage under `path()`,
  mutation-guard outcomes (`ReadOnlyStrategy` — reject as the reference does). Sizes in L3 telemetry.
- **Federate.** Run independent sibling RPCs concurrently (federate and `io()`); arms at mid-position or
  inside a nested prefix; Phase 2b cross-graph identity (`group().by(id)`, `has(T.id, <cross-graph>)`);
  Phase 3b post-merge reads (`hasLabel`/`has(key)`, live `out`/`in`, bound+base element-read mix);
  side-effect-boundary widening (low). Design: [pushdown](./archive/2026-08-26-federate-pushdown-design.md).
- **Replication.** Thread federate depth to a cross-server peer (a `federationDepth` request field);
  native whole-DB snapshot incl. tombstones (an `io()` round-trip can resurrect deletes); shared-target
  before-image journal (when shared-target replication is real); dissolve the composite `(graph,id)`
  into a global `gid` rejoin.
- **Graph algorithms (GDS).** Cheap params (`maxIterations`, `tolerance`, `consecutiveIds`,
  `useWassermanFaust`, `maxDegree`); `nodeSimilarity` `topK`/`similarityCutoff`/`degreeCutoff`;
  `sourceNodes`, `seedProperty`; weighted betweenness/LPA; `scaler`; then iterative ones
  (`labelPropagation`, `eigenvector`, `louvain`).
- **`io()`.** Measure a full-size round trip against the 5-min CPU budget; a `g.io(...).with(...)` option
  to select the replace policy; perf: skip endpoint lookups under `idPolicy:'preserve'`, parse each line once.
- **Operations.** Real Cloudflare deployment, authentication, transaction/session semantics, GraphSON
  responses, a `PRAGMA optimize` schedule (after bulk load / on alarm, never per request).
- **Browser.** Wire `navigator.storage.estimate()`; exactly-once writes (idempotency keys).

## 6. Internal debt

- **Identity-reprojection idiom ~43×** in `src/compiler/rel/**`, `src/rel/**` — add an override-aware
  `carriedExprs(channels, sourceId, overrides?)` and a `from` on `withPayload`; migrate.
- **`OwnerSeek` DISTINCT tail ×3** in `src/rel/passes/semijoin.ts` — extract `distinctOwners`.
- **Path-position `by()` dispatch built twice** (`src/compiler/rel/path.ts`) — extracting
  `pathPositionProjection` also fixes a mid-path value/list/map position read as a vertex.
- **Four copied blocks in `write.ts`** (carrier reproject, merged-create spread, alias-carry, nested-spec decline).
- **`writeInputChannels`** (`write.ts`) keeps only `encounter|alias`, dropping `sack`/`path` for writes after them.
- **`property(T.id)` on an existing element** raises a clearable `Deferral` (`write-args.ts`); make it a permanent `Error`.
- **`sequentialGuard`, `guardMergeInterleaving`/`mergeObservesOtherWrites`** — candidates for the
  snapshot-write simplification.
- **Two framing→`{t,v}` encoders** (`producedMemberNode`, `fieldNode`) — edit in lockstep; merging is architectural.
- **Stale comments**: `src/services/catalog/olap/shortest-path.ts` header (old recursive-CTE walk);
  `src/compiler/ir/strategies.ts` ~539 (stream/mutate/stats modes).
- Keep the `antlr4ng` patch until upstreamed; regenerate and diff `parser/` on a TinkerPop bump.

## 7. Low priority

- **Bulk journal clear in bounded chunks** — `clearBulkJournal` (`src/storage.ts`) is one DELETE.
- **Nested scalar `reverse()`/`split()`** inside a child body.
- **Content-demand 3-arg `has`** — `literalKeysOf` (`src/compiler/ir/content-demand.ts`) takes the label as the key.
- **Federated `order`/`dedup(local)` over landed-foreign elements** — re-source keys via `BoundGraph`.
- **Agent memory Phase-0 spike** — brute-force cosine over in-DO vectors at realistic sizes
  ([vision](./2026-07-17-agent-memory-vision.md)); the rest belongs in a sibling repo.

## Won't do (do not reopen)

- **Java-execution emulation** — merge order, raise extent, write interleave, signed zero, UTF-16,
  `java.util.regex`, Java number spelling, Float32, out-of-range Double carriers. Matrix §17.
- **Per-traverser write interleave** — writes see a snapshot of their input; don't rebuild the guards.
- **Recursion barrier-in-term / unbounded-`repeat` per-origin slice** — algebraically impossible.
- **Global `tail`/`sample` with no `encounter`** — the decline is correct.
- **Per-origin window inside a `union`/`choose` arm** — the window is global in the reference
  (`vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java`); current answer is right.
- **Moving `FromItem` construction into `src/rel/block.ts`** — would break the predict/construct split.
- **Map-literal `[k:__.trav]` as a merge argument.**
- **Heterogeneous-layout branch arms / per-traverser coalesce/optional arm slices** — decline
  (`test/L4-addendum/branch-arm-decline.feature`).
- **Writes past a slice the reference stops pulling at** — beyond `EarlyLimitStrategy`'s crossings these
  decline (`test/L4-addendum/early-limit-side-effect.feature`).
