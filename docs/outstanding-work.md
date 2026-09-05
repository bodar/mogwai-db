# Outstanding work

This is an index, not a backlog or a conformance report. The feature matrix records
per-step support; closed work belongs in git history or `docs/archive/`.

**State (refreshed 2026-09-05).** L3 floor 1808/2286 (1806 unique). RelIR covers 1565/2395 corpus
prefixes (`mise run rel-blockers`); the decline contract holds — `lowerToRel` returns plan-or-null,
never throws (`mise run rel-sweep`) — and the census has **0 `crashed` rows** (no fail-closed
violations). All five test baselines are clean of parked defects: `known.ts`,
`capability-baseline.ts`, and `laws.ts` `knownBroken` are EMPTY, and the L5 deep sweep is green across
seeds — the generator is saturated at the committed depth, so a green L5 now measures coverage, not
correctness (the one lattice gap it names: `filter(__.identity())` is not lowered).

## Compounding substrate

- **RelIR completion — the ranked worklist.** Finish the algebra passes and generic lowering for
  nested child bodies, row operations, recursion, paths, and branch arms — shared mechanisms, not
  step-by-step projects. `mise run rel-blockers` ranks the open families by L3 upside:
  **scalar-transform composition** (18 — `asNumber`/`asString`/`reverse`/`concat`/`asDate`… are ✅ at
  global scope but don't compose in every shape/position, so this is value carriage, below),
  **branch arms** (14 — `union`/`choose`/`coalesce`), **aliases** (13 — `select`/`as`), **writes** (10),
  **row ops** (10 — `order`/`dedup`/`range`), **map shape** (9 — `group*`), **list shape** (9 —
  `fold`/`unfold`), **side effects** (8 — `group`/`aggregate`/`cap`). Start with
  [the RelIR build plan](./2026-08-01-relir-build-plan.md) (§10 is the live-gap home).
- **Emit/block walk unification — a correctness substrate.** `src/rel/emit.ts` and `src/rel/block.ts`
  independently re-derive direct-source classification, FROM-alias assignment, and join-splice
  eligibility; only a subset is shared. When the two copies drift, a plan `check.ts` admits (a
  recursive-term P1 law) gets wrapped by the emitter into a `circular reference` / wrong rows — a named
  silent-wrong-answer class. Lift the decision predicates (direct-source-ness, `aliasOf`,
  `mayFuse ∧ spliceable ∧ free`) into shared helpers both consume — mechanical; full walk-unification
  is unnecessary. Flagship of the correctness lifts.
- **Value carriage and framing.** Preserve exact scalar types through JSON-backed collections, member
  variants, maps, aliases, paths, and format adapters (also meta-property value typing) — the root of
  the 18-scenario scalar-transform composition gap above. One concrete unifier: thread the child-seam's
  reducer **type** (`produced.vtype`) and **productivity** (empty-child NULL-ness) as two carried facts,
  so `by(sum/mean/…)` lands uniformly across `project`/`aggregate`/`store`/`where` (`group().by(k).by(__.…sum())`
  already works; the sibling hosts drop the fact). Rules RelIR §6·7; live gaps §10.
  See [the RelIR build plan](./2026-08-01-relir-build-plan.md).
- **Encounter and order — the fan-out rejoin authority.** One root cause — a per-traverser-spliced body
  doesn't thread channels/labels out to parent scope — produces the path-transparency decline for
  `flatMap`/`local` under `path()`, child-body-label-escape, and the per-origin-unsafe barrier in a
  fan-out body (`src/compiler/rel/lower/reduction.ts`). The same channel-seeding gap recurs at every
  boundary (value/list resume, foreign/bound-graph rejoin — the federate path+encounter combo, the
  barrier-resume transplant in `segment.ts`) and at new-position consumers (`otherV()` outside a
  retained `fromV`, `where('a',eq('b')).by('key')`, list-valued alias dedup key). One substrate clears
  a large read-side family; the barrier-in-body slice 2 and per-origin-in-arm items are its consumers.
- **Correlated per-incoming-row write-argument resolver.** A write arg that is a nested traversal not
  foldable to a constant declines (`src/compiler/rel/write.ts`: property value/key, merge
  match/onCreate/onMatch entries, whole-arg / no-arg merge). The write lowering has a per-*graph* rooted
  surface but no per-*traverser* correlated one (the `resolveMergeSpec` seam is named but unwired).
  Building it unblocks the whole dynamic-write family: `property(k,__.trav)`, computed merge
  labels/keys/values, `mergeV(__.select(sideEffectMap))`, no-arg `mergeV/mergeE`. Architectural; the
  biggest write-side family (rel-blockers "writes" 10).
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

- **Cheap mechanical wins — highest value / lowest cost.** Each routes through machinery already
  present nearby:
  - **Supplied `T.id` on `mergeV`/`mergeE`** — create arms decline on `spec.id != null` though the
    `elementIdGuard` + id-column machinery is used by `addV`/`addE`; only create-insert routing is
    missing (`src/compiler/rel/write.ts`). Unblocks upsert-by-id + CSV/GraphSON id round-trips.
  - **OLAP decorated-property reads** — `has(key,value)` over an OLAP score and mixed decorated+stored
    `values()` decline, but `existsOf(rowById())`+`cval` and the base-UNION-decorate pattern are in the
    same file (`src/compiler/rel/decorate.ts`). Unblocks post-`pageRank`/`connectedComponent` reads.
- **Graph capabilities:** `tree`, graph algorithms, and the remaining strategy/options forms.
  - **`match()` — mostly landed, residual gaps** (was indexed as unbuilt). Binding/filter patterns,
    `and`/`or` filter regime, nested match, modulated bodies, keyed `dedup`, and top-level
    `not/where(match)` are on the RelIR spine (drove L3 1480→1755). Residuals, each needing new
    plumbing: a truly BINDING `or` branch (disjunctive-UNION + alias reconciliation), `local(match)`, a
    `map(<mean>)` body, a `fold()` end, a filter-after-reduce / `count()` end, `ProductiveByStrategy`
    null-keeping, `where('a',P)` over scalar aliases / non-eq ops, and a per-origin windowed slice in a
    pattern body (a consumer of Encounter-and-order).
    → [match plan](./2026-08-13-match-relir-lowering-plan.md).
  - **Strategies** (`src/compiler/ir/strategies.ts`) — the largest L3 clusters:
    `SubgraphStrategy(edges:/vertexProperties:)` criteria, `PartitionStrategy` with `mergeV`/`mergeE`
    (partition-aware upsert — ties to the correlated write-arg + `T.id` items), and small config gaps
    (`includeMetaProperties`, `ProductiveByStrategy` on a non-standard host). No injection rule yet
    wraps a criterion around a mutation.
  - **`subgraph('sg')`** side-effect collection into a named graph (matrix ❌, a sizeable L3 cluster)
    and **`withSack(seed, Operator)`** accumulator (bare `sack()` works) — matrix-fill.
  - *Graph algorithms* — barrier substrate + GDS library DONE
    ([archived](./archive/2026-08-23-barrier-substrate-reshape-plan.md); execution plan
    [here](./2026-07-24-graph-algorithms-plan.md)). Two pieces remain: **barrier-in-body slice 2**
    (per-parent nesting for `local`/`union`-arm/`by`-child/unbounded-`repeat` bodies — a consumer of
    Encounter-and-order; unbounded-`repeat` stays P3 fail-closed forever) and the **order-dependent GDS
    algorithms** (`labelPropagation`/`louvain`/`eigenvector` — not clean set-based reuse).
  - *Per-origin windowed slice — one increment left.* The substrate is DONE
    ([archived](./archive/2026-08-25-per-origin-window-plan.md)) for `local`/`flatMap` and `match`
    bodies. The remaining consumer is a per-origin slice inside a **`union`/`choose` arm or a
    bounded-`repeat` body** — the branch substrate's traverser-major/arm-major question: the decline is
    `slice && bodies.some(armBatches)` (`src/compiler/rel/lower/branch.ts`); the lift threads the
    arm-minted origin through `mintTraverserMajor`.
- **Services and graph movement.** `GraphSource` and mid-traversal federate INJECTION are DONE
  ([graph-source](./archive/2026-08-21-graph-source-abstraction-plan.md),
  [injection-mapvalues](./archive/2026-08-28-federate-injection-mapvalues.md)). Remaining federate items
  ([pushdown design](./2026-08-26-federate-pushdown-design.md) Open): **multi-graph mixing** (`union` of
  two siblings + cross-graph identity) and a low-value **side-effect-boundary** widening. Three
  by-design deferrals stay fail-closed (bound WRITES, FTS over a bound graph, the path+encounter combo —
  a consumer of Encounter-and-order). **Lead:** the replication `gid` (below) could dissolve the ~375
  LOC `graph`-channel machinery these phases extend, replacing composite `(graph,id)` with a
  globally-unique rejoin — unrealized; `src/channels.ts` / `src/compiler/rel/boundgraph.ts` are still
  gid-free.
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
  idempotency keys).
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
  - **Identity-reprojection idiom repeated ~27×** across `src/compiler/rel/**` — the largest boilerplate
    class; a partial helper exists (`src/compiler/rel/property.ts` `carryThrough`). Mechanical.
  - **`OwnerSeek` strategies duplicate the safety-critical "owner → `sid` → DISTINCT" tail**
    (`src/rel/passes/semijoin.ts`) — the trailing DISTINCT is load-bearing; extract
    `distinctOwners`/`seekScan`. Mechanical, real safety win, cheapens adding an access-path strategy.
  - **Path-position `by()` dispatch built twice** (`src/compiler/rel/path.ts`) — extracting
    `pathPositionProjection` also closes a latent bug: a mid-path value/list/map position under a
    non-identity `by()` is silently treated as a vertex.
  - **Four copied blocks in `write.ts`** (alias-carry-to-created, passthrough reproject, merged-create
    spread, nested-spec decline loop).
  - **Two parallel framing→`{t,v}` member encoders** (`producedMemberNode`, `fieldNode`) — a radar item:
    a new framing arm must be added in lockstep or they drift.
  - **Miscategorized deferral** (`src/compiler/ir/write-args.ts`): `property(T.id)` on an existing
    element raises a clearable `Deferral` but id is immutable — it should be a permanent `Error` (else
    never-clearable telemetry debt); `T.label`-append is genuine future work.
  - **Non-JSON-transportable channels through the write snapshot** — an identical guard fires 4× on
    `sack`/`path` channels or a JSONB-blob alias history through a write; extend `src/program.ts`'s
    transportable set + `writeInputChannels`. Narrow (writes after `sack()`/`path()`).
- Keep the `antlr4ng` patch live until upstreamed; regenerate and compare `parser/` when updating
  TinkerPop.
- Keep the architecture, bind-budget, type-check, conformance, and RelIR-decline gates green. Do not add
  a second build or test tool. Keep the feature-support matrix accurate as capabilities land.

## Superseded / won't-do (do not re-open)

- **`order`/`dedup(Scope.local)` over an ELEMENT-membered nested list** — declines fail-closed; needs
  federate-grade detached-element re-entry, rare and non-corpus. (The scalar-list case landed.)
- **Recursion barrier-in-term** (an aggregate/window inside a recursive `repeat` term) — a SQLite
  algebraic law; the refusal is the only correct answer, not a gap.
- **Global `tail`/`sample` with no `encounter`** — a question about emission order a channel-less
  relation cannot answer; decline is correct.
- **Unbounded-`repeat` body per-origin slice / barrier** — recursive-term collapse is algebraically
  impossible; P3 fail-closed forever.
