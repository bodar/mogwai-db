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

7. **One type channel — collapse `as` + `vtype` into a single scalar `type`.** Investigated and
   partly landed 2026-07-25; the design is settled and the dead end is recorded, so this is
   scoped, not exploratory. → [type-channel-unification](./2026-07-25-type-channel-unification.md)

   **The defect.** A scalar's Gremlin type rides on TWO channels: `ScalarStream.as` (one
   compile-time tag, from a cast) and `ScalarStream.vtype` (the NAME of a per-row column holding
   the type the write channel recorded — the only channel that can describe a heterogeneous
   stream). Every container barrier propagates `as` and drops `vtype`, so a stored
   datetime/uuid/long collapses to its storage class on entering one: `values('when').fold()`
   frames `LIST[LONG]` (epoch millis), uuid→`STRING`, bigint→`INT`. Same for
   `aggregate().cap()` and a `groupCount()` KEY. Drop sites: `steps/tail/barrier.ts:37,56`,
   `steps/prefix/sideeffect.ts:~111`, `steps/tail/group.ts:~519`. Pinned as `test.todo` in
   `test/typed-collections-e2e.test.ts`.

   **Corrects the previous entry, which was wrong in a way that cost a session.** It claimed the
   root cause was "`ListOf`/`AliasEntry` carry no per-element vtype slot" and called it
   cross-cutting. The slot EXISTS and is faithfully propagated —
   `values('age').asNumber(BIGINT).fold()` compiles to `{"kind":"jsonbList","as":"bigint"}`.
   Only the per-row channel is lost. It also listed `project().by(count(local))`, which is not
   affected (a count has no member type to lose), and missed `dedup()`, which was.

   **Do NOT re-try the barrier-local fix.** Wrapping folded members as `{t,v}` + `ListOf.typed`
   (the encoding a STORED typed collection uses) was implemented and reverted: the list
   rebuild/transform ops (`order`/`dedup`/`limit` under `Scope.local`, the set-op family) read
   members as BARE SQL values and fail closed on a `typed` list (`assertUntypedList`,
   `steps/tail/list.ts`), so always-wrapping turned working traversals into deferrals (15 tests).
   Wrapping only the rows that need it mixes encodings within one list, which the typed readers
   don't handle — `compileUnfold` does `je.value ->> '$.v'` unconditionally. A uniform per-list
   encoding needs a runtime, per-list decision, which is this item.

   **The direction** (agreed with the user, 2026-07-25): one field, a discriminated union —
   `{static: CanonicalType} | {perRow: column} | {unknown}` — so the compiler FORCES every step
   to handle all three instead of silently forgetting one of two optional fields. `unknown` is
   reachable only from the JS-client seam (a JS client cannot distinguish UUID from string, so
   the type is genuinely unknown, not absent); if the upstream client is fixed it becomes
   unreachable and deletable. Physical encoding stays a per-site choice derived from the type —
   bare when the SQLite storage class already determines it (string/int/long/double, exactly what
   `inferVtypeSql` recovers), a sibling column for row-preserving ops, `{t,v}` only inside a JSON
   blob where there is no room for a sibling column. **Absorbs** the `Scope.local` typed-element
   transforms (a transform retypes its output — not a special case once the type is uniform) and
   `assertUntypedList`, which exists only to guard the two-encoding split. **Unblocks** ~8–14 L3
   scenarios plus the whole class of "a new barrier forgot a channel" bugs. **Medium-High.**

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
- **`has(k, eq(collectionLiteral))` + meta-property typing** — two remaining typed-value tails.
  (`Scope.local` STRING transforms over typed list elements moved into the unification item
  below — it is the same root cause, not an independent gap.) *Low.*
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
- **`value` Shape `as?` xor `perRowType?`** — the render-boundary twin of P1·7's two channels; fold
  it into that discriminated union rather than doing it alone.
  → [type-channel-unification](./2026-07-25-type-channel-unification.md),
  [wire-and-storage-facts](./2026-07-25-wire-and-storage-facts.md)
- **Upstream `q`-kernel surface to lazyrecords**.
  → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Fork TinkerPop as our vendor submodule + upstream the harness fixes.** Agreed 2026-07-25;
  the submodule now tracks `origin/master` directly (2026-07-26) and the fork exists at
  `danielbodart/tinkerpop` — what remains is landing the payloads. Four found so far, each
  verified against source, in descending confidence:
  1. **`toNumeric` cannot produce a BigInteger** — branch `fix-cucumber-bigint-numeric-parsing`
     is written, self-verified and pushed; it captures the `d[…].<suffix>` type tag and
     dispatches on it (mirroring gremlin-dotnet's `NumericParsers`), with `l` → Number inside the
     safe-integer range and BigInt outside it, matching `LongSerializer.deserializeValue`.
     **Not yet opened as a PR.** See the won't-do entry below for why our framing is already right.
  2. **The generated cucumber `gremlin.js` references an undefined `uuid`** — the JS translator
     documents "Assumes use of the `uuid` npm library" (`JavascriptTranslateVisitor.ts:29`) and
     emits `uuid.v4()`/`uuid.parse(…)`, but `test/cucumber/gremlin.js` never imports it and
     `uuid` is not a devDependency, so every UUID scenario dies with `uuid is not defined`.
     Costs us `g_injectXUUIDXXX` (dropped from the ratchet). NOTE the file is GENERATED during
     the Maven build (`build/generate.groovy` is not in-tree for JS), so the fix is an import in
     the generator template + a devDependency, not an edit to the output.
  3. **The cucumber port is hard-coded** (`test/helper.js:33` → `http://localhost:45940/gremlin`,
     no env override; docker-compose pins 45940/45941 too). This is the intermittent CI conflict
     — it collides with our own conformance host, which must own that port because the client
     offers no way to configure it. Fix: honour an env var, default 45940.
  4. **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a BUN bug, not TinkerPop's
     (`close` is non-optional on undici's `Dispatcher`, and the real Agent inherits it via
     `DispatcherBase`). Worked around in `test/support/undici-shim.ts`; worth reporting to Bun.
     Do NOT "fix" this by making the client call `close?.()` — that would silently skip real
     connection-pool teardown wherever a dispatcher genuinely lacked it.

  The fork is also the intended home for the **non-conformant-client UUID/ISO-date shim** (a JS
  client cannot send a UUID's type, so sniff the obvious string shapes — **opt-in**, never
  default: a string that merely looks like a uuid is not one, and silently retyping user data is
  worse than not typing it). → [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)

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
- **"`asNumber(GType.BIGINT)` of a small value should downcast to Int/Long on the wire"** → **our
  framing is already correct; the blocker is a vendored-harness defect.** Verified 2026-07-25
  against source, correcting a P3 entry that had the causality backwards:
  · TinkerPop's `NumberSerializationStrategy` does magnitude-dispatch ONLY for
    `typeof item === 'number'`; for `bigint` it is unconditional
    (`return this.ioc.bigIntegerSerializer.serialize(item, …)`). There is no BigInteger downcast
    to replicate — `execute.ts`'s `case 'bigint'` already does exactly what TinkerPop does.
  · `data/BigInt.feature` expects `d[456].n` — BigInteger — for the value 456, i.e. the suite
    requires the declared type to be PRESERVED, not narrowed. Emitting Int would contradict it.
  · The real cause is `gremlin-js`'s cucumber `feature-steps.js`:
    `function toNumeric(s) { try { return parseFloat(s) } catch { return BigInt(s) } }` —
    `parseFloat` never throws, so the `BigInt` branch is unreachable and `d[456].n` becomes the
    JS Number 456, which our correct `456n` can never deep-equal.
  · 5 sibling scenarios in that file PASS today (`math(mul)`/`sum`/`min`/`max`/`project`) because
    `math()`/`sum()` coerce away from BigInteger — a blanket downcast would REGRESS them.
  Route: fix it in our TinkerPop fork's harness and offer it upstream (debt item above), not by
  changing our serializer. ~3 scenarios, net L3 gain likely ≤0 if "fixed" our side.

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
