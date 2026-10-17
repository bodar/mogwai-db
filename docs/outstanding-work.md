# Outstanding work

This is an index, not a backlog or a conformance report. The feature matrix records
per-step support; closed work belongs in git history or `docs/archive/`.

**State (refreshed 2026-09-06).** L3 floor 1835/2286 (1833 unique). RelIR covers 1576/2395 corpus
prefixes (`mise run rel-blockers`); the decline contract holds — `lowerToRel` returns plan-or-null,
never throws (`mise run rel-sweep`) — and the census has **0 `crashed` rows** (no fail-closed
violations). All five test baselines are clean of parked defects: `known.ts`, `capability-baseline.ts`,
and `laws.ts` `knownBroken` are EMPTY, and the L5 deep sweep is green across five fixed seeds (only
`order` telemetry, which never gates) — the generator is saturated at the committed depth, so a green L5
now measures coverage, not correctness. The one lattice gap it names: `filter(__.identity())` is not
lowered.

## Compounding substrate

- **RelIR completion — the ranked worklist.** Finish the algebra passes and generic lowering for
  nested child bodies, row operations, recursion, paths, and branch arms — shared mechanisms, not
  step-by-step projects. `mise run rel-blockers` ranks the open families by L3 upside:
  **branch arms** (13 — `union`/`choose`/`coalesce`), **writes** (11 — `addE`/`property`/`addV`/`mergeV`/`mergeE`),
  **scalar-transform composition** (11 — `asNumber`/`reverse`/`concat`/`asDate`… are ✅ at global scope but
  don't compose in every shape/position, so this is value carriage, below), **aliases** (11 — `select`/`as`),
  **map shape** (9 — `group*`), **list shape** (9 — `fold`/`unfold`), **row ops** (9 — `order`/`dedup`/`range`),
  **side effects** (8 — `group`/`aggregate`/`cap`). Start with
  [the RelIR build plan](./2026-08-01-relir-build-plan.md) (§10 is the live-gap home).
- **Value carriage and framing.** Preserve exact scalar types through JSON-backed collections, member
  variants, maps, aliases, paths, and format adapters (also meta-property value typing) — the root of
  the 11-scenario scalar-transform composition gap above. One concrete unifier: thread the child-seam's
  reducer **type** (`produced.vtype`) and **productivity** (empty-child NULL-ness) as two carried facts,
  so `by(sum/mean/…)` lands uniformly across `project`/`aggregate`/`store`/`where` (`group().by(k).by(__.…sum())`
  already works; the sibling hosts drop the fact). Rules RelIR §6·7; live gaps §10.
  **Numeric reducer RESULT CLASS** (read side, and so every `property(k, __.…max())` that stores it): the
  reference answers the HIGHEST COMMON class over all inputs (`NumberHelper.getHighestCommonNumberInfo`,
  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390`;
  `max`/`min` at :613 widen too), we answer the winner's own type (`max`/`min`) or the aggregate's storage
  class (`mean`). `sum` now takes the rows' common class wherever they carry a tag (`reducer.ts`
  `numberClassMask`/`numberClass` — the scalar `sum`, `sum(local)`, and grouped `sum`/`min`/`max`), so a
  whole-number Double sum stays a Double and byte/short/float sums keep their class. Wrong today:
  `inject(2, 1.0d).max()` Int (ref Double), `inject(2, 1L).max()` Int (ref Long), `inject(5i, 2.0d).max()`
  Int 5 (ref Double 5.0), `inject(1b, 2s).max()` Int (ref Short) — the top-level and `local` argmax
  `min`/`max` arms still frame the WINNER's tag (only a grouped `by()` `min`/`max` reads `numberClass`);
  `inject([1b, 2s]).sum(local)` Int (ref Short — a bare list literal carries no member tags); `mean()` of
  BigInteger Double (ref BigDecimal); an UNTAGGED stored integer counts as an Int whatever its size; and an
  intermediate overflow the final total cannot show is not widened.
  An EXACT-TAIL value held as decimal TEXT (a BigDecimal — `1.5m` is stored `'1.5'` — a BigInteger, or a
  Long past 2^53) cannot be added by a SQL `sum`. Every `sum`/`mean` over such a row now DEFERS in-statement
  (`reducer.ts` `arithmeticArg`, a raising arm of the aggregate inside the read, so a nested body carries it). The answer it
  owes is exact decimal arithmetic, which remains open: `values('p').sum()` over `1.5m` and `2` is a
  deferral, where the reference gives BigDecimal 3.5. A sum over a KNOWN `long`/`bigint` stream is exact
  (`sumTower`). See [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Encounter and order — the fan-out rejoin authority DONE; a path-consumer tail remains.** The
  substrate that threads a per-traverser-spliced body's channels/labels out to parent scope LANDED in full
  ([archived](./archive/2026-09-05-fan-out-rejoin-authority-plan.md)). Remaining are PATH-as-a-VALUE
  consumers, each its own increment: **`path().order()`** whole-stream orderability (a JS barrier;
  `orderStreamValue` already does element members — `src/compiler/rel/lower/order-dedup-local.ts`),
  **`path().group()`** / a Path in a group VALUE (needs a `{t:'path'}` arm in `frameTypedNode`/`listNodeExpr`,
  fail-closed today), and **`path().fold().unfold()`** member re-entry. The barrier-in-body slice-2
  (union-arm/bounded-`repeat` variants) and per-origin-in-arm stay owned by the branch/arm-major substrate
  (Graph capabilities, below).
- **TraverserSet merge — residue of the bulking-position authority (Cluster A, RelIR plan §10).** The merge
  itself is lowered (`bulkingPositions`, `src/compiler/ir/bulk.ts`; `regroupFirstOccurrence`,
  `src/compiler/rel/build.ts`). What remains: (1) **positions the exact scan cannot place** — a labelled path
  (`as()`, or a label `retractUnreadAlias` dropped), a `repeat` the unroll widened past `RepeatUnrollStrategy`
  (the reference's `RepeatStep` re-entry merges as evaluation interleaves), a merge step/service before the
  position, a sack anywhere. There the order is left unmerged unless the superset places a merge under an
  order reader, which declines (`mayMergeAt`). (2) **lists `mergedAt` cannot place**: a child traversal is
  placed (`ChainCtx.traversal`, a sliced prefix of it, a nested rooted read's `mergeScope`) and merges at its
  own positions; a body the seam hands over unplaced (a `group()` value body, a non-distinct `union` arm)
  declines only where a reader IN it observes a possible merge — a reader in its host is the host's to judge;
  and a REWRITTEN list (a barrier service's resume, a federated arm — `ChainCtx.rewritten`) is not scanned at
  all. A per-traverser child with no emission order folds in a canonical VALUE order (merge-invariant) and
  only a slice in it declines (`slicedAfter`).
  (3) **writes after a merge**: `AddVertexStep` creates ONE element for a merged slot of k
  (`g.V().both().addV('x')` makes 6 vertices in the reference, 12 here) — the write lowering has no bulk notion.
  (4) the 2500-slot drain is reproduced only for ONE drain; a merging stream past it raises a deferral.
  (5) **a merge over a BRANCH's emission order** refuses (`readsBranchOrder`, `lower.ts`) until the branch
  emission key (cluster B) lands; the reads that bypass a merge stay B's residue on trunk: an order() over a
  pairwise-DISTINCT branch stream (`g.V().union(out(),in()).dedup().order().by(constant(0))` answers id order,
  not the arms' order) and a keyed `dedup().by(label)` after a branch (keeps the first by id, not by arm).
  (6) **typed equality OUTSIDE the merge** — the merge keys on `typedEquality` (build.ts) and a top-level map
  on its entries in no order (`mapIdentity`, map.ts; a NESTED map raises at a merge). Siblings that read their
  own key and still equate what `equals` keeps apart: `dedup()` collapses `-0.0` into `0.0`
  (`inject(-0.0,0.0).dedup()` = `[-0.0]`, ref both) and keeps `[a:1,b:2]`/`[b:2,a:1]` apart (ref one);
  `dedup(local)` over a bare list merges `1` and `1.0` (`inject([1,2,1.0]).dedup(local)` = `{1,2}`, ref
  `{1,2,1.0}`); a `groupCount()` key of a whole Double frames as an Int (`inject(1,1.0).groupCount()` =
  `{1:1,1:1}`). One authority would be `typedEquality` + `mapIdentity` behind every identity a step groups on
  (`RowShape.identity`, the member ops), not only `mergeEqual`. A bare-list `[1L]`/`[1.0f]` member still
  declines at `listLiteralBlob` (its encoding infers the class back from the storage class).
- **Correlated write-argument resolver — merge SEARCH map-driver + map-valued `mergeV`/`mergeE` LANDED; the
  general driver remains.** The per-traverser correlated write surface (`property(k, __.trav)` values, the
  property MAP form, `addV`/`mergeV` tails, `mergeV` onMatch/onCreate arms, the correlated `mergeV`/`mergeE`
  SEARCH, and the whole map AS the merge driver — `inject(map).mergeE()`/`select("m").mergeE()`, endpoints
  from the map's `Direction` keys) is on trunk (`src/compiler/rel/write.ts`, `mergeVFromMap`/`mergeEFromMap`).
  Remaining, all designed in [correlated merge search](./2026-09-05-correlated-merge-search-plan.md): the
  general **non-`project` map-producing traversal** driver (`out().project(…)`, `select(dynMap)`), the
  whole-map **0-result RAISE**, and an **edge runtime property value** (`option(onMatch,[k:__.trav])` on a
  mergeE, which declines the whole merge today). The map-LITERAL `[k:__.trav]` stays permanently declined
  (Superseded). Ties to PartitionStrategy partition-aware upsert (Strategies, below).
- **`property(k, __.trav)` sequential-read refusals — hoist the guard to the PROGRAM's first statement.**
  `sequentialGuard` (`src/compiler/rel/write.ts`) refuses at RUN time a body that could read what another
  traverser writes (the reference runs one traverser through every mutating step before the next,
  `AddPropertyStep.java:93-121` + `LazyBarrierStrategy.java:93-125`). It runs ahead of its own
  `property()` run, but not ahead of an EARLIER write step, so
  `g.V(1,2).addV('x').property(single,'n', __.V().hasLabel('x').count())` raises the "not supported yet"
  error AFTER the `addV` has created its vertices. Not a wrong answer, but a refusal that mutates. The fix is
  to compute every guard's host from the pre-write snapshot (an `addV` host is one row per INPUT
  traverser, so its count is the input's) and emit all guards before the plan's first statement. The real
  feature behind the refusals is a per-traverser write driver, which is the general driver above.
  **A barrier between an UPSTREAM write and the site over-refuses.** `afterWrite` keeps every mutating
  step on `ProgramWrites.upstream` for its whole tail, so a body observing it refuses when >1 traverser
  ran through the write — even where a full barrier in between (`fold().unfold()`, `barrier()`,
  `order()`, `count()`) has drained the write before the site runs and one statement IS the reference:
  `g.V(1,2).addLabel('z').fold().unfold().has('name','marko').property('n', __.V().hasLabel('z').count())`
  (ref 2), and the single-arm source union `g.union(__.addV('x')).property('n', __.V().hasLabel('x').count())`
  (ref 1). Both answered correctly before the upstream guard landed; the fix is a barrier lowering that
  pops (resets) the upstream entries it drains.
- **Set-based writes — LANDED; one wire tail.** The runtime write path is one relational
  `Insert`/`Delete` over `json_each` (`src/setwrite.ts`); the bulk loader, IO drains, and the dependent
  UPSERT (`onCollision:'replace'`, `src/bulk.ts`) ride it. Remaining: a `g.io(...).with(...)` STEP
  modulator to select the replace policy from a traversal — front-end work (a new `io()` option), not
  substrate.
- **Retained relations — DONE; one feature left.** The named-collection substrate is complete
  ([archived](./archive/2026-08-09-named-collections-are-bindings-plan.md)). The one remaining feature
  is a **KEYED-label seeded merge** (`withSideEffect("a", <map seed>).group("a")…`): a map-level
  `GroupBiOperator` per-key merge + a mixed group-VALUE list, fail-closed today
  (`src/compiler/rel/collection.ts` `registerGrouping`). Its downstream gaps
  (path/`simplePath`/`sample`/`within` operand) are owned by their respective substrates.

## Product capabilities

- **Graph capabilities:** `tree`, graph algorithms, and the remaining strategy/options forms.
  - **`match()` — mostly landed, residual gaps.** Residuals, each needing new plumbing: a truly BINDING
    `or` branch (disjunctive-UNION + alias reconciliation), `local(match)`, a `map(<mean>)` body, a
    `fold()` end, a filter-after-reduce / `count()` end, `ProductiveByStrategy` null-keeping,
    `where('a',P)` over scalar aliases / non-eq ops, and a per-origin windowed slice in a pattern body
    (a consumer of the arm-major slice). → [match plan](./2026-08-13-match-relir-lowering-plan.md).
  - **Strategies** (`src/compiler/ir/strategies.ts`) — the largest L3 clusters:
    `SubgraphStrategy(edges: __.or(…))` criteria (top L3 bucket, ×10) and `SubgraphStrategy(vertexProperties:)`
    (×6), `PartitionStrategy` with `mergeV`/`mergeE` (×7 — partition-aware upsert, ties to the correlated
    write-arg resolver; supplied `T.id` on merge now lands), and small config gaps (`includeMetaProperties`,
    `ProductiveByStrategy` on a non-standard host). No injection rule yet wraps a criterion around a mutation.
  - **`subgraph('sg')`** side-effect collection into a named graph (matrix ❌, a sizeable L3 cluster ×16)
    and **`withSack(seed, Operator)`** accumulator (bare `sack()` works) — matrix-fill.
  - **Step-vocabulary L3 clusters** (matrix-fill, not ceiling): `format('%{k} …')` string interpolation
    (×12), local reductions `mean(Scope.local)`/`sum(Scope.local)` over a value list (×10), string steps
    inside `repeat` (`split`/`conjoin`, ×11), `inject(…,null,…).path()` null carriage under `path()` (×9),
    and the read-only/mutation-guard family (`ReadOnlyStrategy.addV`, a mutating step in a value-argument
    child — ×15; verify we reject with the reference's outcome, not merely an `UnsupportedTraversal`).
  - *Graph algorithms* — barrier substrate + GDS library DONE
    ([archived](./archive/2026-08-23-barrier-substrate-reshape-plan.md); execution plan
    [here](./2026-07-24-graph-algorithms-plan.md)); the native OLAP steps + the `relationshipWeightProperty`
    monoid-completion substrate are on trunk. Open, in the plan's priority order: **the GDS parameter
    superset** — cheap-win params with no substrate (`maxIterations`, `tolerance`, `consecutiveIds`,
    `useWassermanFaust`, `maxDegree`),
    `nodeSimilarity` `topK`/`similarityCutoff`/`degreeCutoff` (a scalability wall — `WHERE`/`ROW_NUMBER`
    tweaks), `sourceNodes` (personalized pageRank/articleRank) and `seedProperty` (wcc) reading a
    node-set/property into the seed, remaining weighted consumers (streaming degree, weighted betweenness/LPA),
    `scaler`; and the **iterative/order-dependent algorithms** (`labelPropagation`≈`peerPressure`+`maxIterations`,
    `eigenvector` a clean per-iter join+GROUP BY, `louvain` the hard one — a harder substrate on the existing
    barrier seam, all desired).
  - *Per-origin windowed slice — one increment left.* The substrate is DONE
    ([archived](./archive/2026-08-25-per-origin-window-plan.md)) for `local`/`flatMap` and `match` bodies.
    The remaining consumer is a per-origin slice of a **BATCHED `union`/`choose` arm or bounded-`repeat` body
    under an outer per-origin scope** — per-INCOMING-traverser, the branch substrate's traverser-major/arm-major
    question: the decline is `slice && bodies.some(armBatches)` (`src/compiler/rel/lower/branch.ts`); the lift
    threads the arm-minted origin through `mintTraverserMajor` (witness `repeat(union(out.order.by.limit(2),…))`).
    A window INSIDE an arm is a different thing and is already correct — see Superseded.
- **Services and graph movement — federate Phases 1–3 LANDED; residual tails.** `GraphSource`,
  mid-traversal INJECTION ([graph-source](./archive/2026-08-21-graph-source-abstraction-plan.md),
  [injection-mapvalues](./archive/2026-08-28-federate-injection-mapvalues.md)), and pushdown Phases 1–3
  (`union` of two siblings, cross-graph `dedup` identity via the `graph` channel role, post-merge
  `values`/bare-element reads) are on trunk. Remaining
  ([pushdown design](./2026-08-26-federate-pushdown-design.md) Open):
  - **Phase 2b** — cross-graph identity for `group().by(id)` (rowid + `.by(id)` composite) and
    `has(T.id, <nested cross-graph scalar>)`.
  - **Phase 3b** — post-merge reads still fail-closed: correlated id-only reads (`hasLabel`/`has(key)`),
    live cross-graph movement (`out`/`in`), and the bound+BASE element-read mix
    (`union(federate(A).V(), __.V()).values(...)` — base graph not yet an arm of the unified relation).
  - **Side-effect-boundary** widening (low value — `cap` over a pre-barrier collection stays local).
  - Three by-design deferrals stay fail-closed (bound WRITES, FTS over a bound graph, the path+encounter
    combo). **Lead:** the `graph` `ChannelRole` (the composite `(graph,id)` discriminator) is now landed and
    load-bearing across Phases 2/3, so the replication `gid` refactor (below) that would replace composite
    `(graph,id)` with a globally-unique rejoin now has real ~375 LOC of `graph`-channel machinery to dissolve.
- **Replication & HTTP interop — LANDED; residual tails.** The peer protocol, `gid`/`rev`/`seq`,
  tombstones, conflict preservation, filtered replication (F1–F3), and the worker-residency scheduler
  are on trunk across Bun/CF/browser
  ([replication+interop](./archive/2026-09-02-replication-and-http-interop-plan.md),
  [filtered replication](./archive/2026-09-04-filtered-replication-plan.md)). Open:
  - **Cross-server federate depth** not threaded to the peer (the peer compiles fresh at depth 0, so a
    cyclic cross-server federate is bounded per-server, not globally) — needs a `federationDepth`
    request field the peer honours.
  - **`mergeE` over an incoming vertex stream** (§10·4) — the idempotent-placement idiom raises
    `UnsupportedTraversal` (`elementMergeE` declines per-traverser endpoint resolution); a consumer of
    the correlated write-arg resolver above.
  - **Shared-target before-image journal** — undo for a placement mutating pre-existing target elements
    needs a bounded write journal; deferred until shared-target replication is real.
  - **Native whole-DB snapshot format** (§10·2) — an `io()` GraphSON/CSV round-trip loses tombstones, so
    restore-and-re-replicate could resurrect deletes; needs a mogwai-owned native snapshot (all tables
    incl. tombstones/conflicts, `barrier_state` excluded), not meta stuffed into interop formats.
- **Browser runtime — LANDED; two fail-safe residues.** The full browser port (WasmSqlite/OpfsIoStore/
  SW-edge, capnweb RPC, cross-tab failover) is a CI bracket
  ([archived](./archive/2026-08-30-browser-port-feasibility.md)). Low-priority, non-blocking: wire
  `navigator.storage.estimate()` (the DO-ceiling analog, no consumer yet), and a write **exactly-once**
  tail (a committed-but-unacked write lost to a hard kill is retried at-least-once; needs write
  idempotency keys). The OPFS teardown flake (destroy racing a live owner's access handles) is FIXED
  (`edef10be`): one bounded teardown authority (`destroyGraphWorker`), one handle-release retry
  (`src/browser/opfs-release.ts`).
- **GraphQL front end — Phases 0–3 live; additive tail open.** A deployable, conformance-tested
  GraphQL-over-HTTP surface exists (`src/graphql/`, [plan](./2026-08-07-graphql-front-end-plan.md)).
  Open, none blocked: **interfaces/unions** (engine substrate landed; needs union minting in reflection
  + SDL + `conditionApplies` grown to implements/member-of — also a correctness fix: a multi-target
  edge's second endpoint label is clobbered in reflection), a **`_gremlin(query)`** escape field,
  **mutations** (Phase 5), **aggregation fields**, and a CAS schema cache (optimization).
- **`io()` streams — MEMORY bounded; confirm TIME under load.** `IoStore` is `readStream`/`writeStream`
  (R2 multipart on the DO), GraphSON/CSV drain through `BatchingLoader`, GraphSON read is a two-pass byte
  stream — a graph up to the 10 GB DO ceiling moves without materializing (covered by
  `test/io-streaming.test.ts`). Open: MEASURE a full-size round trip against the 5-minute CPU budget.
  Escape hatch if ever needed: a RESUMABLE `io()` (keyset cursor per (path, direction);
  `resumeMultipartUpload` exists). Two perf follow-ons (not correctness): the two-pass read looks up
  every edge endpoint even under `idPolicy:'preserve'` with numeric ids, and `JSON.parse`s each line twice.
- **Operations:** a real Cloudflare deployment, graph authentication, transaction/session semantics,
  and GraphSON response encoding.
- **Query-plan performance.** The join-order fence + source seek made filtered lookups plan-stable
  without stats (RelIR §1 P4, guarded by `test/plan-stability.test.ts`). One optimization follow-on: a
  `PRAGMA optimize` schedule (after a bulk load / `io().read()`, on the DO alarm or after N writes;
  never per request).

## Maintenance and internal debt

- **Duplication consolidation is DONE** ([archived](./archive/2026-08-25-duplication-and-smells-plan.md))
  — kept for its "deliberately NOT flagged" list (the map of intentional parallels a future sweep must
  re-read before "fixing" anything). Fresh debt the substrate audit surfaced, highest-leverage first:
  - **Identity-reprojection idiom repeated ~43×** across `src/compiler/rel/**` and `src/rel/**` (the pure
    form `X.channels.map(ch => [ch.col, col(Y.id, ch.col)])`; ~6 more with a per-channel override —
    bulk→`1`, encounter→`sid`, origin→`col(input.id,'id')`, alias-override). The target helper already
    exists (`withPayload`, `src/compiler/rel/build.ts:87`; local `carryThrough`,
    `src/compiler/rel/property.ts:255`) but hard-wires "channel-source == reprojection-id", so ~50 sites
    reading channels off a *different* relation can't adopt it. **Mechanical:** export an override-aware
    `carriedExprs(channels, sourceId, overrides?)` + give `withPayload` an optional `from`; migrate.
    Drift-safety win (a channel role handled inconsistently is a silent-wrong-answer risk).
  - **`OwnerSeek` DISTINCT tail duplicated 3× in `src/rel/passes/semijoin.ts`** (`:218`, `:265`, `:300`) —
    the `owner → 'sid' → DISTINCT` tail, DISTINCT load-bearing (`:65`). Extract `distinctOwners`. Mechanical,
    real safety win, cheapens adding an access-path strategy.
  - **Path-position `by()` dispatch built twice** (`src/compiler/rel/path.ts:261-296`, parallel to the
    linear reader) — extracting `pathPositionProjection` also closes a live bug: the `else` at `path.ts:270`
    treats a mid-path value/list/map position under a non-identity `by()` as a vertex. Architectural-ish.
  - **Four copied blocks in `write.ts`** (carrier reproject-without-channels `:2539`, merged-create map
    spread `:2761`, alias-carry-to-created `:1903`/`:2810`, nested-spec decline). Maintainability-only.
  - **Two parallel framing→`{t,v}` member encoders** (`producedMemberNode`, `src/compiler/rel/modulator.ts:420`;
    `fieldNode`, `src/compiler/rel/record.ts:237`) — a radar item: they consume different framing vocabularies
    (4 vs 11 cases) and value-access models, so a merge is ARCHITECTURAL; keep as a must-edit-in-lockstep entry.
  - **Miscategorized deferral** (`src/compiler/ir/write-args.ts:197`): `property(T.id)` on an existing
    element raises a clearable `Deferral` but id is immutable — split into a permanent `Error` for `T.id`
    (else never-clearable telemetry debt) from the kept `Deferral` for `T.label`-append (genuine future work).
  - **Non-JSON-transportable channels through the write snapshot** — `writeInputChannels`
    (`src/compiler/rel/write.ts:1530`) filters channels to `encounter|alias`, silently dropping `sack`/`path`
    at 8 call sites; extend `src/program.ts:112`'s transportable set + this filter. Narrow (writes after
    `sack()`/`path()`).
- Keep the `antlr4ng` patch live until upstreamed; regenerate and compare `parser/` when updating
  TinkerPop.
- Keep the architecture, bind-budget, type-check, conformance, and RelIR-decline gates green. Do not add
  a second build or test tool. Keep the feature-support matrix accurate as capabilities land.

## Superseded / won't-do (do not re-open)

- **FEDERATED `order`/`dedup(Scope.local)`/global-`order()` over an ELEMENT-membered list** — the
  BASE-graph case LANDED (D2, `order-dedup-local.ts`: carry rowids through the barrier, re-source at the
  edge; nested + stream + global forms all covered). A LANDED-FOREIGN element re-sources its key via
  `BoundGraph`, not the resume's `BaseGraph` default, so the federated case still declines fail-closed
  until the resume threads the bound source — rare and non-corpus.
- **Recursion barrier-in-term** (an aggregate/window inside a recursive `repeat` term) — a SQLite
  algebraic law; the refusal is the only correct answer, not a gap.
- **Global `tail`/`sample` with no `encounter`** — a question about emission order a channel-less
  relation cannot answer; decline is correct.
- **Unbounded-`repeat` body per-origin slice / barrier** — recursive-term collapse is algebraically
  impossible; P3 fail-closed forever.
- **A per-origin window INSIDE a `union`/`choose` arm** (`union(out().limit(2), …)`) — `BranchStep` drains
  every start into an arm before applying its barrier, so the window is GLOBAL and the current answer is
  already correct; a per-origin window there would be WRONG (`BranchStep.standardAlgorithm` drains all starts
  before the barrier — `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:143-148`;
  per-origin-window plan §"semantics corrections"). Distinct from the batched-arm traverser-major slice
  (Product capabilities), which IS a real increment.
- **Emit/block "walk unification"** — CLOSED (`1b87885e`). All three decisions (direct-source
  classification, FROM-alias via exported `aliasOf`, splice eligibility) are lifted into `src/rel/block.ts`
  as the single source and the anti-drift gate pins the full alias set. There is no residual: `emit.ts`'s
  `directSource` GATES on the shared `isDirectSource` (throws on drift) and BUILDS the `FromItem` — which is
  emit's job by design (block predicts structure, emit constructs SQL). Moving construction into `block.ts`
  would collapse the predict/construct separation the gate depends on — it would be wrong, not deferred.
- **map-LITERAL `[k:__.trav]` as a merge argument** — a candidate-rooted `P.eq` on a per-driver value;
  permanent decline (correlated merge search), distinct from the map-VALUED driver that landed.
- **Per-traverser `fold(seed, Operator)` with a list/set/map seed** — declines (`38160293`,
  `src/compiler/ir/fold-seed.ts`): TinkerPop wraps the one seed in a `ConstantSupplier`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java:1300`)
  and `Operator.addAll` mutates it in place, so every parent folds into ONE aliased collection; only a
  root-chain fold is admitted. Exact aliasing semantics are not worth a lowering.
- **Heterogeneous-layout branch arms + per-traverser arm slices** — decline (`56fcc8b4`): a union arm
  set failing the ONE column law `unionColumnsViolation` (`src/rel/structure.ts`, shared by check.ts and
  `mergeArms`/`variantMerge`) declines instead of an internal error, and a non-reducing coalesce/optional
  arm holding a slice declines because TinkerPop resets the arm per start
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CoalesceStep.java:52-60`,
  `.../step/branch/OptionalStep.java:47-57`); pinned in `test/L4-addendum/branch-arm-decline.feature`.
- **`property(k, <traversal>)` over an UNCOUNTABLE upstream write stream** — decline (`4899a9d6`,
  `047df68b`): a body observing an upstream write that >1 traverser ran through (or a branch's arm
  writes) refuses rather than answering from one statement's snapshot, since the reference re-evaluates
  the child per traverser after each write (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java`);
  a numeric reducer's `vt` now crosses into a per-row `vtype` through `reducedVtype` (`fb3b4703`, exact —
  `mean()` is a Double, `.../step/map/MeanGlobalStep.java:175-177`). Pinned in `test/property-traversal-sequencing.test.ts`.
- **A merge over several traversers beside ANOTHER write its search could observe** — decline
  (`guardMergeInterleaving` rule (0) via `mergeObservesOtherWrites`, plus the onMatch/tail per-traverser
  rules): `g.inject(1,2,3).mergeV([name:'zz']).properties('name').drop()`, an earlier/later `addV`/`addE`,
  a union-arm drop all answered from one snapshot; the reference runs the lazy pipeline one traverser at a
  time (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java`,
  `.../step/map/MergeVertexStep.java`). Pinned in `test/L4-addendum/merge-one-traverser-at-a-time.feature`
  and `test/merge-other-writes.test.ts`.
- **A slice the reference stops pulling at, behind a side effect** — `EarlyLimitStrategy` is PERFORMED where
  a slice crosses a `SideEffectStep`/always-bound map (`src/compiler/ir/early-limit.ts`;
  `vendor/tinkerpop/gremlin-core/.../strategy/optimization/EarlyLimitStrategy.java`), so
  `g.V().property('x',1).limit(1)` writes one vertex; the keyed `groupCount('a')`/`group('a')`/`tree('a')`/
  `subgraph('a')` are `SideEffectBarrierStep`s at the pin and are NOT crossed, and a keyed collector run per
  traverser in a spliced `local`/`map`/`flatMap` body ahead of a slice declines (`ffca8f77`). What it cannot move — a
  movement between (`property().out().limit(1)`), `withoutStrategies(EarlyLimitStrategy)`, a slice that would
  split a creation from its `property()`, a branch's lazily emitted arm writes, a write in a body read for
  its first result (`where(__.out().property(…))`, formerly an internal "Ref 'pwN'" error) — DECLINES
  (`ProgramWrites.truncated`, `src/compiler/rel/write.ts`). The real feature behind those is the
  per-traverser write driver. An `addE` endpoint traversal now runs the same race guard as a
  `property(k, <traversal>)` body; a literal-id source is not blind to a creation of its own kind (ids are sequential
  rowids, so `V(8)` may be another traverser's new vertex) unless every id it names existed at the program's
  start, which a program-start binding answers (`ProgramWrites.preChecks`). Two declines narrower than
  the reference: `g.V().property('x',1).select('a').limit(1)` (an unbound `select` filters every
  traverser, so the reference pulls all six), and `g.V(1,2).addE('e').to(__.out().limit(1))` (the endpoint's
  movement could reach a new edge). A refusal raised at a `property()` run still comes after an EARLIER
  creation step has written (`g.inject(1,2).addV('x').identity().property('n', __.V(8).count())` declines
  with both vertices made). Pinned in `test/L4-addendum/early-limit-side-effect.feature`,
  `test/compiler/writes.exec.test.ts`.
