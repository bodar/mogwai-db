# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, what it unblocks, where to start — not a spec.** The linked doc holds the rationale; the
picking agent does the detailed validation and design. Landed work is excluded (the corpus
over-reports `LANDED`; this keeps only what a code check confirms open). Live per-step capability:
`feature-support-matrix.md`.

**Refreshed** 2026-07-25 against L3 1275 unique / 2041 (`l3-state.json` shows 1277 — two names
recur legitimately, see `test/CLAUDE.md`). Path pointers assume the 2026-07-23 restructure
(`src/compiler/steps/{context,prefix,tail,write}/`, `src/compiler/{ir,plan,engine}/`).

> **Before picking an item, verify its premise against the code — this index has been stale in BOTH
> directions.** The corpus over-reports `LANDED`, but item 1 also over-reported *open*: it named a
> duplication that had already been consolidated and an `encounter` mint that already existed, which
> cost a full re-investigation. The cheapest check is usually a 10-line probe that compiles the
> traversals the item claims are broken and greps the emitted SQL — do that before designing.
> When an item turns out to be partly landed, rewrite the line rather than closing it silently.

**Ordering — floor vs ceiling.** L3 is the floor (scenarios that pass); the ceiling is generic
lowering that composes the full nested grammar at any depth/combination (see
`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item unblocks a *family*; one-off
step impls are matrix-fill, lower. Impact: **High** (correctness / whole-family unblock) ·
**Medium** (real feature bucket) · **Low** (narrow, fail-closed, or debt).

---

## P1 — ceiling-raising generic-substrate lifts

1. ~~**Unify the branch-merge family onto the `VariantStream`/`variantArm*` substrate.**~~
   ✅ **LANDED 2026-07-25.** The premise was already half-stale when written: the three merge
   *builders* (`finishElementMerge`, `unionScalarStreams`, `mergeVariantArms`) were consolidated
   AND each already minted the arm-merge `encounter` — i.e. **Stage A of canonical-emission-order
   had landed**, so this item's "unblocks item 4" was already discharged. What was genuinely
   duplicated was the dispatch **head**, now fixed:
   - `classifyBranchArms` + `BRANCH_SHAPE_ORDER` (`steps/tail/child-shape.ts`) is the ONE arm
     triage. It replaced ten ad-hoc booleans in `engine/engine.ts`'s prefix fold, three hardcoded
     `list→scalar→variant→element` cascades in `steps/tail/projection.ts`, and a third
     re-classification inside each `tryLower*`. Pinned by `test/compiler/branch-triage.exec.test.ts`,
     which keeps the old ten-boolean predicate as an oracle and asserts equivalence over 44 branch
     steps — that test caught a real bug during the change (an unclassifiable `optional()` body
     routed to the tail reports `step not implemented: optional()`, so unclassifiable splits by
     kind: `optional`→element, multi-arm→variant).
   - `finishListMerge` replaced 3 verbatim list-merge copies; `mergeVariantParts` was split out of
     `mergeVariantArms` for the heterogeneous hit/miss `optional` merges.
   - **A real wrong answer was fixed**: the four scalar-parent mixed-shape merges hand-inlined
     `mergeVariantArms`' no-encounter branch, so with a live encounter (any positional consumer
     downstream of a fan-out — `values('age').union(constant('x'),V()).limit(2)`) arm ordering was
     silently dropped and the slice picked rows in incidental SQLite order.
   - `lowerLegacy*` → `lowerElement*`: those are the authoritative element-homogeneous compilers
     and the fail-closed backstop, not legacy. The name drove much of this item's apparent size.

   **Residual — ✅ also LANDED 2026-07-25**, and it turned out to be the visible tip of a much
   wider alias/barrier defect (widening the investigation was the right call — it produced the
   only L3 gain of the whole effort):
   - `as()` inside a **scalar arm** now survives the merge. `mergeAliasMaps` moved from
     `branch.ts` to `context.ts` (+ a new `aliasArmProjection`) so the scalar/variant merges share
     the element merge's remap/NULL-pad logic; `unionScalarStreams` unions the arms' label sets;
     only then was `as` admitted to `SCALAR_ARM_ROW`. Semantics match the element-arm reference:
     a label bound in one arm only drops the other arm's rows, both-bound keeps both.
   - **A single LIST-shaped label read back as its JSON TEXT**, not as a list — so
     `fold().as('b').select('b').unfold()` emitted one text blob instead of its members. Fixed;
     this gained **L3 1277 → 1278** (`g_V_hasLabelXpersonX_aggregateXxX_byXageX_capXxX_asXyX_selectXyX`).
   - **A LINEAR `path()` is row-preserving**, so it now threads the alias history instead of wiping
     it (Piece C of [path-history-substrate](./2026-07-18-path-history-substrate.md)):
     `path().as('a')` and `select('a')` after a path work. The recursive/grouped layout is one row
     per position, not per path, so it still drops them and declines explicitly.
   - **`Carried.consumedAliases`** (metadata, never a column) records the labels a REDUCING barrier
     ate, so `select(label)` after `fold`/`count`/`sum` can PROVE the empty result is correct rather
     than arriving there by accident. TinkerPop pins empty here (`Select.feature g_V_selectXaX`), and
     `count().as('a')…select('a')` reads back fine because the label binds on the barrier's OUTPUT.
     **7 of 10 barrier+select combinations previously returned `[]` indistinguishably from a typo.**

   **Still open (smaller, now precisely scoped):** list members frame as bare values, not elements —
   `AliasEntry` does not record the member shape, so a path/element-list label cannot frame its
   members as vertices. Blocks
   `g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold` (which also
   needs `union()` over a path value). *Low-Med.*

2. **Universal child-seam acceptance.** The generic child seam still throws for whole child-body
   families — `local`, `where(__.trav)`, `choose().option`, `map(__.trav)`, `by(__.trav)`,
   `group().by(__.trav)`. These are the top L3 deferral buckets by frequency; the fix is extending
   the classifier+compiler so every body is admitted at every position, not one shape at a time.
   Start: `steps/tail/{child-shape,child,scalar-arm}.ts`. **High.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

3. **Alias columns through `repeat()`.** Teach the recursive-CTE term to carry `as()`/`select(label)`
   columns. (The sibling capability — *foldable* carried state via `sack()` — ✅ landed 2026-07-24;
   its residuals are Low fail-closed tails in P3.) **Unblocks:** labels surviving a recursive walk.
   Start: `steps/prefix/branch.ts` (recursive term). **Medium.**
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

4. **Canonical-emission-order Stage C — residual only.** The headline premise ("branch merges don't
   mint the arm-merge `encounter`") is **false and has been for some time**: every merge family mints
   it (Stage A landed), and as of 2026-07-25 that includes the four scalar-parent mixed-shape merges
   (item 1). `dedup(labels)` first-in-emission also landed (`filter.ts`). Stage B landed for movement,
   source seed, element-prefix `limit`/`range`/`skip`, root `fold`, child `first`, and `values()`.
   What actually remains:
   - **`union()` as a SOURCE form** — `engine/engine.ts` `seedUnion` throws outright
     (`emission-order encounter over a union() source not yet supported`).
   - **A bare re-source `V()`/`E()` arm carries no encounter**, so the take-first guards that depend
     on one still fail closed: `armFansOut` (`steps/tail/scalar-arm.ts`) and `positionArmFansOut`
     (`steps/tail/path.ts`). `map()` over a `union`/`choose` fan-out arm ALREADY works (those carry
     an encounter); only the re-source arm is left. Minting `encounter = new element id` at a
     re-source is the one missing primitive.
   - **`repeat()`/`match()`** stay deliberately outside (a recursive CTE can't window across
     iterations) — `analyze.ts` returns `demandsEncounter: false` for them by design.
   Do NOT re-derive the "two encounters" reconciliation: there is one slot, `Carried.encounter`;
   `ScalarStream` has no separate field. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

5. **Map/non-element re-entry.** `valueMap().select()` into a retyped `MapStream`, and `as()`/
   `select(label)` over group/map/path/property streams. **Medium.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5

5b. ~~**Re-enter the PREFIX after a value-tail barrier — `…order().by(k).out()`.**~~
   ✅ **LANDED 2026-07-25** (the prescribed retype boundary; the `WITH #5` coupling turned out not
   to bind — a keyed/bare order re-enters as an ordered *element* stream, which never needs #5's
   non-element re-typing). A plain `order()` whose FOLLOWER is a step outside the value-tail
   vocabulary (`VALUE_TAIL_STEPS` = every projection + modifier `foldTailAcc` folds) is no longer a
   terminal accumulator: `tailOrder` (`steps/tail/projection.ts`) mints a fresh emission `encounter`
   (ROW_NUMBER over the composite order key, `lowerElementOrderReenter`) that SUPERSEDES any
   demand-pass encounter in its declared slot, and re-enters generic lowering. The order then
   survives the follower through the *existing* substrate — `finishMove` re-mints the encounter
   across each hop, the branch merges mint the arm-merge encounter — so `order().by(k)` followed by
   movement (`out`/`in`/`both`/…), a branch (`union`/`choose`/`coalesce`/`optional`), `as()`, or a
   post-movement `limit` all order correctly. Direct-key order-expr building was factored to
   `directOrderExpr`, shared with `lowerElementOrderByTraversal` (no second copy). Pinned by
   `test/compiler/movement-filter.exec.test.ts`; **L3 1278 → 1281** (incl. the Coalesce scenario
   `g_V_outXcreatedX_order_byXnameX_coalesceXname_constantXxXX` and an `order().by().as().outV()`
   chain).
   **Residual (deferred, fail-closed):** `order()` before a movement/branch while a **path** is live
   throws `order() before a movement/branch while tracking a path not yet supported` (a fresh
   encounter would collide with the path's positional ordering) — that IS #6/path-history territory.

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** Largest single named L3 cluster; the compiler rejects patterns
   not starting with `as(...)`. **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

8. **Graph-algorithms layer (new cluster).** Algorithms as `call()` services + OLAP step names
   (`pageRank`/`connectedComponent`/`peerPressure`/`shortestPath`) as desugar Passes. Nothing built.
   Build-first: PageRank as the proof-of-concept. Absorbs the old P3 `shortestPath()` line. Carries
   6 open research questions. **Medium.**
   → [graph-algorithms](./2026-07-24-graph-algorithms-plan.md)

9. **Side-effect readback predicates — `where(within/without('x'))`.** The
   `aggregate().where(without('x'))` dedup idiom; no aggregate-readback exists yet. **Medium.**
   → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

10. **`addV` mid-chain + read-tails-after-write.** Gates a write-conformance cluster (e.g.
    `property()` after `addV()`). **Medium.**
    → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6,
    [write-args-through-read-spine](./archive/2026-07-16-write-args-through-read-spine.md)

11. **Federation tail** (call() Phases 1–6b landed): CF-parity test on the DO harness (Low-Med);
    map-valued injection for mid-traversal federation (Med); import-a-graph (Med/Large);
    federated *traversal* via local scratch (Large); async failure/timeout/retry policy (Low-Med).
    → [call-service-registry](./archive/2026-07-20-call-service-registry-plan.md)

12. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)`, `PartitionStrategy`
    meta-properties + partition-aware upsert (`mergeV`/`mergeE`), nested-body descent. **Medium/Low.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

13. **`with(...)` / `OptionsStrategy` sugar.** ✅ **The `valueMap().with(WithOptions.tokens)` form
    LANDED 2026-07-25**: `foldValueMapWith` (`ir/strategies.ts`, a fold Pass) desugars the all-tokens
    form — `with('~tinkerpop.valueMap.tokens')` (the wire string the JS GLV resolves the enum to),
    optionally `+ 15`/`all`, or the raw `{withOption}` enum the frontend now captures
    (`WithOptionsConstants_*`) — to the existing `valueMap(true)` tokens flag. **L3 1281 → 1284.**
    **Still open:** the SELECTIVE token subsets `with(tokens, ids|labels)` (a proper subset paired
    with `by(unfold)` that also flattens the value lists — no `valueMap(true)` equivalent; fails
    closed today), `index().with(WithOptions.indexer, WithOptions.map)` (needs item 14), and any
    other `with()`/OptionsStrategy host. **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`index()` step** — unimplemented (`index() on a list value not yet supported`). Default (list)
    indexer turns a collection `[e0,e1,…]` into `[[e0,0],[e1,1],…]`; a `with(WithOptions.indexer,
    map)` variant produces a Map (needs item 13's `with` selector). `format()` is **already landed**
    (8 L3 scenarios pass; the doc's "both unimplemented" was stale) — only `index()` remains here.
    **Low-Medium.** → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

15. **Multi-key `cap('x','y')` + cap-of-group unfold.** **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

16. **W4 — multi/meta-property schema rework → `Cardinality.list/set` writes.** Only meta-property
    *typing* is touched today (P3), not the list/set write cluster. **Medium.**
    → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md) (W4)

---

## P3 — narrow / fail-closed matrix-fill (correct-by-design today)

Each fails closed (clear error, never mis-executes). Do only when a concrete scenario demands it.

- **Recursive-path tails** — `path().by()` on the walk, `cyclicPath`/`until`/`emit(pred)` with path,
  edge-inclusive bodies, mixed linear+repeat, recursive-regime `from()`/`to()`. Includes
  `path().by(__.trav)`/`by(T.token)` in the array regime — needs a new *positional-child* substrate
  over `json_each` (`steps/tail/path.ts` hard-throws). *Low-Med.*
  → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()`
  keys, `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. `steps/tail/group.ts` is
  where the child seam most often bottoms out — extend it (item 2), don't dedup. *Low.*
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./archive/2026-07-16-p3-reenterable-shapes-plan.md)
- **Mixed-shape branch corners** — node+edge in one branch, `path()` through it, `as()` inside an
  arm. Items 1+4 did NOT close these as a family (that claim was aspirational); they are each an
  independent wall, and all four now fail closed with an error naming the branch:
  · node+edge in one branch → the element lowerer's mixed-element-kind defer.
  · `path()` through a mixed-shape branch → all four mixed-shape lowerers now throw, including
    `optional` (that one silently rode `path` through `carryFrag` unpadded until 2026-07-25 —
    a hit arm is a scalar row with no path position, a miss arm keeps the element's).
  · `as()` inside a non-element arm → see item 1's residual (needs alias-aware merges FIRST; the
    naive vocabulary change returns `[]` from `select()`). *Low.*
  → [p4-dynamic-variant](./archive/2026-07-16-p4-dynamic-variant-plan.md)
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch (need the
  bare rowid, not the framed external id), map-valued merge drivers, nested keys/values. *Low.*
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **Typed-value tails** — `Scope.local` STRING transforms over typed list elements,
  `has(k, eq(collectionLiteral))`, meta-property typing. *Low.*
  → [full-fidelity-typed-collections](./archive/2026-07-17-full-fidelity-typed-collections-plan.md),
  [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)
- **`sideEffect(__.…)` + `withSideEffect(...)`** and **`branch()`** — distinct families, no consumer
  yet. *Low.*
  → [side-effect-state](./2026-07-13-side-effect-state-plan.md),
  [per-traverser-branching](./archive/2026-07-13-per-traverser-branching.md)
- **Foldable-sack residuals** — fan-out `by(__.trav)` in a repeat sack body, mutate `sack(op)` in a
  branch arm, `withSack()` at a `union()` source, mixed sack+element `until`/`emit`, sack over an
  edge-step repeat body, `sack(BiFunction)`/T-token/inject-const gaps. *Low.*
  → [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)
- **`repeat`/`match` emission order** — recursive-CTE can't window across iterations. *Low.*
  → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)
- **L3 ratchet hygiene** — descope OLAP/GraphComputer + `io` source in `tags.ts`. *Low.*
  → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

---

## Product / operations (not compiler features)

- **Real Cloudflare deploy** (only `--dry-run` wired; code is CF-ready). *Medium.*
- **Bearer-token auth per graph** (no auth surface yet). *Medium.*
- **Untyped GraphSON v4 response encoder** — makes the shipped `/docs` panel usable; ~½–1 day.
  *Medium.* → [graphson-untyped-scope](./2026-07-13-graphson-untyped-scope.md)
- **Multi-request `g.tx()` session state** (needs DO session state). *Low-Med.*
- **Per-request implicit transaction** (likely moot — DO single-threading). *Low.*
- **Typed GraphSON (`types=true`)** — gated on a type-faithful JSON consumer. *Low.*

All → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md) unless noted.

---

## Internal debt / give-backs (Low)

- **Finish deleting `correlatedExists`/`correlatedReduce`** (`steps/prefix/predicate.ts`) — the
  correlated-child refactor largely landed; these inline fast-paths remain (the "no second movement
  impl" law). → [correlated-child-rendering](./2026-07-17-correlated-child-rendering-plan.md)
- **Fold the third scalar-child projector residue** (`compileScalarChildRows`, `steps/tail/child.ts`)
  onto generic `PROJECTORS`. → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §1
- **Node/edge property-SQL duplication** (`plan/plan.ts` `nodeProp*`/`edgeProp*` pairs) — one
  `propSource(elem)` descriptor would halve it. Do opportunistically.
- **`write.ts` row-at-a-time nested read** (`steps/write/write.ts`) — imperative surface; could
  materialize once via the child seam + a batch form.
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **Review-fix duplication residue (C1/C2/C3 + D)** — property-list framing / tie-break / `PARTITION
  BY ordinal` dups; the `execute.ts` pre-parsed-`pmeta` divergence is latent-correctness. Status
  unconfirmed — treat as open. → [review-fix-plan](./2026-07-22-review-fix-plan.md)
- **`value` Shape `as?` xor `perRowType?`** — discriminated union would read cleaner; touch only if
  that Shape changes. → [wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)
- **Upstream `q`-kernel surface to lazyrecords** and **JS-client GraphBinary type-preservation PR**
  (+ non-conformant-client UUID shim). → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md),
  [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)

---

## Superseded / won't-do (do NOT relitigate)

- **ansi SQL builders / CTE-recipe templates** → replaced by the `q` kernel.
- **Self-tuning `nodes.props` indexes / flat `edges.props` blob** → replaced by normalized
  `*_properties` tables + static covering indexes.
- **"L3 count has duplicate names → miscount"** → *not a bug*; distinct scenarios normalize to the
  same name across feature files. See `test/CLAUDE.md`.
- **`tree()`** → parked (JS GLV stubs `DataType.TREE`, zero conformance value).
- **Two-`union` merge / `optional` fast-path cleanup** → keep the fast path.
- **BulkSet "wire dead-end"** → corrected; wire bulking landed and is live.
- **Cross-DO federation via `ATTACH` coordinator** → rejected; per-request `call(federate)` landed
  instead (open tail in P2·11).
- **Client-side partition → DO routing** → out of scope; server-side soft filtering is the path.
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas,
  OLAP/GraphComputer → architectural limits, fail-closed by design.
- **Child-scope split-seed + 4-consumer migration** → superseded by the smaller carried-cols fix.

Sources: [lazyrecords-cutover](./archive/2026-07-11-lazyrecords-cutover-plan.md),
[phased-roadmap](./2026-07-11-phased-roadmap-plan.md),
[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md),
[seam-reuse-audit](./2026-07-13-seam-reuse-audit.md),
[traverser-bulking](./archive/2026-07-14-traverser-bulking.md),
[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md),
[child-scope-path-split](./archive/2026-07-18-child-scope-path-split.md).

---

## Research / vision (reference — no build items)

- **[agent-memory-vision](./2026-07-17-agent-memory-vision.md)** — sibling `mogwai-memory` repo;
  path-decayed ranking (partly enabled now `sack()` landed). Separate-repo, exploratory.
- **[graph-algorithms](./2026-07-24-graph-algorithms-plan.md)** — build spec for P2·8.
- **[conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)** — the strategic
  unlock map; bets largely landed, tails folded into P1–P3.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** — federation
  prior-art (ATTACH rejected; `call(federate)` landed).
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — path prior-art; two-regime
  plan implemented, only P3 tails remain.
- **[wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)** — Map.Entry framing + MapStream
  model. Durable reference, not a plan.
