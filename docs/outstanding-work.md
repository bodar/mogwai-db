# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, where to start — not a spec.** The linked doc holds the rationale; the picking agent does the
detailed validation and design. Live per-step capability: `feature-support-matrix.md`.

**Refreshed** 2026-07-27 against L3 1473 / 2297. Item numbers are stable IDs — landed items are
deleted and their numbers are not reused, because code comments and other docs cite them.

> **Verify an item's premise against the code before picking it — this index has been stale in BOTH
> directions.** The cheapest check is usually a 10-line probe that compiles the traversals the item
> claims are broken and greps the emitted SQL. When an item turns out to be partly landed, rewrite
> the line rather than closing it silently.

**Ordering — floor vs ceiling.** L3 is the floor (scenarios that pass); the ceiling is generic
lowering that composes the full nested grammar at any depth/combination (see
`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item unblocks a *family*; one-off step
impls are matrix-fill, lower. Impact: **High** (correctness / whole-family unblock) · **Medium**
(real feature bucket) · **Low** (narrow, fail-closed, or debt).

---

## P1 — ceiling-raising generic-substrate lifts

1. **List members frame as bare values, not elements.** `AliasEntry` does not record the member
   shape, so a path/element-list label cannot frame its members as vertices. Blocks
   `g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold` (which also
   needs `union()` over a path value). *Low-Med.*

2. **Universal child-seam acceptance.** Element, scalar, list, count, branch, `repeat`,
   `as()`/`select(label)` and option-map bodies now compose at every position. Still throwing or
   wrong:
   - child bodies producing **map/group/record** shapes → item 5.
   - `group().by(project(...))` composite keys; non-scalar/non-count nested-group inner keys.
   - **a child-in-child body whose inner child is not element-shaped** —
     `local(__.local(__.out().values('n')))`, `map(__.out().map(…))`. `local` sits in the element-row
     suffix vocabulary but emit recurses into an *element* child for it, so classify must ask the
     same question. Defers rather than crashing today. Orthogonal to labels (reproduces with none).
   - **a label REBOUND inside a `filter()` body** over an outer label of the same name drops rows
     TinkerPop keeps: `g.V().as("a").out().as("b").filter(__.as("a").out("knows")).count()` is 0 for
     us, 1 for TinkerPop. Consistent across both lowerings, so it is a child-seam rebind question,
     not a variable-location one. Pinned as an ON≡OFF equivalence in `branch.exec.test.ts`. *Low-Med.*
   - **`choose().option()` with only `Pick.none` written AND an unproductive choice — a real wrong
     answer.** The CASE's single ELSE claims the unproductive inputs; TinkerPop emits the ELEMENT
     (`Choose.feature g_V_chooseXageX_optionXbetweenX26_30X_nameX_optionXnone_nameX`). Making the
     CASE decline is correct and the arm merge answers it properly — measured **+1/−1**, the loss
     being a `groupCount` over the resulting `VariantStream`. **So it is gated on group/groupCount
     over a VariantStream, not on the option map.** `Pick.any` needs `branch()` (unimplemented).

   Start: `steps/tail/{child-shape,child,scalar-arm}.ts`. Two invariants to preserve: the ONE arm
   triage is `classifyBranchArms` (`child-shape.ts`) with exactly two documented exceptions
   (`scalarArmShape`, the option-map triage); a renderer that cannot carry alias columns must
   DECLINE, not answer. **High.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md)

3. **`repeat()` residuals.** A walk carries loop-invariant alias + origin columns, and its body
   compiles once through the ordinary StepFns into a `(from_id, to_id)` relation the recursive term
   joins (`repeatBodyRelation`); `expandRepeatBody` is now a fast path, not the vocabulary.
   **The trap, pinned by a test:** the gate is NOT "whatever `lowerElementSteps` accepts". A
   per-iteration GLOBAL barrier (`dedup`/`order`/`limit`/`range`/`sample`/`tail`/`group`/`aggregate`/
   `local`) observes the whole frontier at one iteration; the generic StepFns would lower it
   per-origin and silently answer a different question. The gate is the row-local vocabulary
   (`isElementChildStep`).
   - **A barrier body under a fixed `times(n)`** could be UNROLLED into n generic phases (that route
     hosts barriers; `bulk.ts` already unrolls a specialized version for the count case). The natural
     next slice. *Medium.*
   - **`walkPredicate` (`until()`/`emit()`) has no generic fallback.** Same trick as the body:
     compile an element-only predicate once as a `matching(id)` relation and read `id IN matching`
     in the recursive term. This is the only thing keeping the inline predicate compiler's leaf
     vocabulary load-bearing; a sack/`loops()`-dependent predicate still needs the inline form.
     *Low-Med.*
   - **The named-loop form `repeat("a", …)`/`loops("a")` CRASHES** rather than failing closed
     (`undefined is not an object (evaluating 'node.constructor')`, 4 corpus cases). Cheap, isolated.
   - A label bound INSIDE the body (`repeat(__.out().as("b"))`) genuinely rebinds per iteration, so
     it is a fold, not a projection — `as` stays out of the body vocabulary (fails closed). *Low-Med.*
   - `path()`/`simplePath()` + `sack()` bodies stay with the flat expansion (both are per-iteration
     state) — P3 recursive-path tails.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #1,
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [foldable-carried-column](./2026-07-24-foldable-carried-column-plan.md)

4. **Canonical-emission-order Stage C — residual only.** A bare re-source `V()`/`E()` arm carries no
   `encounter`, so the take-first guards that depend on one still fail closed: `armFansOut`
   (`steps/tail/scalar-arm.ts`) and `positionArmFansOut` (`steps/tail/path.ts`). Minting
   `encounter = new element id` at a re-source is the one missing primitive. `repeat()`/`match()`
   stay deliberately outside (a recursive CTE can't window across iterations — `analyze.ts` returns
   `demandsEncounter: false` by design). There is ONE slot, `Carried.encounter`; do not re-derive a
   "two encounters" reconciliation. **Low-Med.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

4d. **`within()`/`without()` over a folded traversal — LIST membership.** The scalar-substitution
   reading landed as `withinList`/`withoutList` (a `json_each` scan over the folded sub-read, sharing
   `foldedListSubquery` with the set-op operands). Open:
   - a UNION-rooted operand (`within(__.union(__.V(1)…, __.V(4)…).fold())`, ~4 queries). Widening the
     rooted test to admit a union whose arms are all rooted was tried and **REVERTED**: it compiles
     but returns unfiltered rows, so something in the source-union fold's shape does not reach the
     list operand intact — diagnose that before re-widening. A `constant()` arm is additionally not
     seedable as a source-union arm (`unsupported source step: constant`). *Low-Med.*
   - a CORRELATED list operand (members varying per traverser), which the standalone sub-read cannot
     express by construction.
   - **Scoping trap worth keeping:** `json_each` exposes a column named `value` and `hasProp` passes
     the UNQUALIFIED `value` of `vertex_properties` — rendered as `EXISTS (… WHERE je.value = value)`
     both sides bind to json_each, so `within` silently returns everything. Keeping the operand on
     the LEFT of `IN (SELECT …)` evaluates it in the outer scope.

5. **Non-element child bodies.** The seam is shape-agnostic (`applyChildCardinality` +
   `classifyProjectionChildRows`); map and record bodies compile. **Two premises that were FALSE — do
   not rebuild on them:** the element terminal does not need a relational form (`local(__.out())`
   already worked), and `project`/`group`/`path` already HAVE relational forms — they were blocked
   only on having no child PROVIDER, so no tail-boundary rewrite is needed. Still open:
   - **A GROUP child body.** Design is settled: the wire frames `group` as ONE Map from all rows, so
     a scoped group must emit one map PER PARENT — a `MapStream`, which the seam now supports.
     Threading an ORIGIN dimension through `lowerGroup`/`GroupSource` means a per-origin analogue for
     each of its 6+ value modes (`valFold`, `valElement`, `valNestedMap`, `valReducer`, composite
     keys). Demand is near-zero (2 corpus traversals, both group-at-root with a group-shaped KEY), so
     build it when a scenario asks and start with the cheap half: a bare `groupCount()` child body has
     exactly ONE value mode. Only the SCALAR-key half is framable — `frameTypedNode` has no element
     case, so an element-keyed map blob cannot be framed (the standing `materializeMapRoot`
     deferral). *Low-Med.*
   - **A PATH child body** (`local(__.path())`) — needs path tracking INSIDE a child scope, which is
     path-history-substrate territory, not this seam's. *Low-Med.*
   - **`valueMap(true)`/`elementMap` as a child body** — fails closed; zero corpus traversals use
     either as a child body. If one appears, carry the terminal path's `{kind:'valueMap', keys,
     tokens}` flag on `MapStream` — mechanical. Token-ness is SHAPE metadata; a T token is not a
     property value, so do NOT put it in the `{t,v}` tree (`gremlin/types.ts` excludes element/token
     codes deliberately). *Low.*
   - **`ChildShape` is deliberately NOT widened to 'map'.** It is `BranchArmShape` minus null, so
     admitting 'map' would tell the branch triage a map ARM is mergeable when no merge covers a map
     shape — converting a clean deferral into a wrong answer. A map ARM stays unclassifiable.

   **Group failure taxonomy, measured 2026-07-27** (128 corpus traversals mention group; 88 compile).
   Recorded because the label "group" hides unrelated causes — most are NOT group-seam work: 4 =
   `group()`/`groupCount()` over a SCALAR parent (item 5c); 3 = a side-effecting `groupCount("a")` in
   a child scope (P3's `sideEffect`); 3 = a barrier `groupCount` inside a `repeat()` body (item 3's
   unroll); 2 = `group().by(traversal)` needing `fold()`/`sideEffect()` in the key body (item 2);
   ~2 = a bare `groupCount()` child body (above); remainder = a nested group inside a value body,
   `sample()`, one-offs.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
   [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

5c. **PARENT-SHAPE uniformity — the same step works over an element stream but not over a
   scalar/list/path/map one.** The largest remaining ceiling gap by breadth: **67 corpus traversals
   across ~35 steps** (measured 2026-07-27), in five families — `X after a scalar stream` (22, 13
   steps), `X on a list value` (18, 13 steps), `X cannot consume the <MAP> result shape` (14),
   `X on a path value` (7), `Scope.local needs a list producer` (6).

   **It is NOT one substrate fix** — verified by probe, some steps already compose over a scalar
   parent (`groupCount`, `choose`, `coalesce`, `math`) while others do not (`group`, `none`,
   `repeat`, `order().by(traversal)`), so it is per-step dispatch, ~2-3 scenarios each. **Do NOT
   treat the 67 as one item to "fix" — that is floor-chasing.** The honest unit of work is one parent
   shape at a time; the scalar parent is biggest and has the most machinery (`SCALAR_TAIL`,
   `lowerScalarRows`, `scalar-arm.ts`). Where a step needs a genuinely different builder over a
   scalar parent (`group()` has no element to project and its default `elementList` value mode does
   not apply) that is real work, not a gate.
   → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md)

6. **`order().by()` of paths (path natural-order comparability).** Unlocks the Orderability
   conformance cluster. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

---

## P2 — feature / conformance buckets

7. **`match()` generic patterns.** 14 of the 35 `Match.feature` traversals compile today; the
   remainder splits into nameable gaps rather than one wall — a pattern not starting with `as()` (6),
   0-root-variable patterns (3), pattern steps `count`/`values`/`order`/`map` (6). **Medium.**
   → [conformance-structural-bets](./2026-07-12-conformance-structural-bets.md)

7b. **`g.match("MATCH (a:person)-[:knows]->(b:person)")` — the GQL pattern-STRING form. NEEDS A
   DECISION, not just implementation.** 23 scenarios (all of `MatchString.feature`), the single
   largest remaining L3 bucket, every one failing `unsupported source step: match`. This is a second
   query LANGUAGE embedded in a string argument, so it needs a pattern parser and a pattern → IR
   lowering — which collides with locked decision #2 (*the parser is generated, never hand-edited*)
   unless upstream ships a grammar we can generate from. **Large.**

7c. **Predicate operands that are TRAVERSALS — narrow tails only.** The four shapes (constant,
   re-sourced, mutating-rejected, correlated) lower. Left:
   - **`within`/`without` over a MULTI-VALUE operand** — not the cheap wiring it looks like:
     `predicateSql` renders each operand as ONE element of a comma list, so a SET-valued operand
     cannot be substituted as an Expression. It needs `expr IN (SELECT …)` /
     `IN (SELECT value FROM json_each(<list>))`, i.e. a scalar-vs-set distinction in the pure SQL
     layer — a new concept there, not a new caller.
   - widening `isReSourced` (`steps/tail/operand.ts`), a narrow proxy for "traverser-independent"
     that tests for a `V`/`E` head and so misses a union of independent branches.
   - the `none()` host; an operand with no scalar to read (a filter body such as
     `__.not(__.identity())`); a scalar-parent `is()` (correlation needs an element ScalarCtx).
   *Low.*

7d. **`match()`: lower each pattern through the FULL loop, not `lowerElementSteps`.** The pattern
   BODY is already generic (`union` inside a pattern works); what is hand-rolled is the binding table
   around it, which holds node rowids only — so a scalar (`values`), reduced (`count`) or edge-typed
   end var defers. The machinery exists (`lowerRootedArm` + kind-dispatch): lower to a Stream of any
   shape and bind on its `kind`. The one difference is that a pattern is SEEDED from a bound var, so
   it wants `lowerStepsStrict` over `applyPattern`'s existing seed rather than a fresh source. Note
   23 of match's 49 corpus failures are the MATCH-STRING form (7b); the real residual here ≈ 26.
   **Medium.** → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #3

8. **Graph-algorithms layer (new cluster).** Algorithms as `call()` services + OLAP step names
   (`pageRank`/`connectedComponent`/`peerPressure`/`shortestPath`) as desugar Passes. Nothing built;
   PageRank is the proof-of-concept. Carries 6 open research questions. **Medium.**
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

13. **`with(...)` / `OptionsStrategy` sugar — remaining hosts.** The all-tokens
    `valueMap().with(WithOptions.tokens)` form landed. Open: the SELECTIVE token subsets
    `with(tokens, ids|labels)` (a proper subset paired with `by(unfold)` that also flattens the value
    lists — no `valueMap(true)` equivalent; fails closed today), `index().with(WithOptions.indexer,
    WithOptions.map)` (needs item 14), and any other `with()`/OptionsStrategy host. **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`index()` step** — unimplemented (`index() on a list value not yet supported`). The default
    (list) indexer turns `[e0,e1,…]` into `[[e0,0],[e1,1],…]`; the `with(WithOptions.indexer, map)`
    variant produces a Map (needs item 13's `with` selector). **Low-Medium.**
    → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

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
  over `json_each` (`steps/tail/path.ts` hard-throws). Also `order()` before a movement/branch while
  a path is live (a fresh emission encounter would collide with the path's positional ordering).
  *Low-Med.* → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()`
  keys, `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. `steps/tail/group.ts` is
  where the child seam most often bottoms out — extend it (item 2), don't dedup. *Low.*
  · **Productivity is not the aggregate.** An unreduced value traversal that yields nothing FILTERS
    the traverser (the key vanishes); `fold()` always yields, so its key survives with `[]`.
    TinkerPop pins both halves on one graph (`Group.feature`
    `g_V_hasXperson_name_withinXvadas_peterXX_group_by_byXout_foldX` vs its `…_byXout_orderX` twin).
    So "implicit-collect ≡ fold" is TRUE for the aggregate and FALSE for productivity.
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./archive/2026-07-16-p3-reenterable-shapes-plan.md)
- **Mixed-shape branch corners** — each is an independent wall, not a family: node+edge in one branch
  (the element lowerer's mixed-element-kind defer); `path()` through a mixed-shape branch (all four
  mixed-shape lowerers throw). *Low.*
  → [p4-dynamic-variant](./archive/2026-07-16-p4-dynamic-variant-plan.md)
- **Branch forms no merge covers** — a WRITE branch (`g.union(__.addV('person')…)`; the merges are
  read merges), and a branch whose shape is map/group/record/path. Throws naming the shape. *Low.*
- **A re-source `V()`/`E()` after `path()`/`sack()`/`otherV()`** — the carried fork through the CROSS
  JOIN is undefined. *Low.*
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch (need the
  bare rowid, not the framed external id), map-valued merge drivers, nested keys/values. *Low.*
  → [writes-through-read-spine](./archive/2026-07-17-writes-through-read-spine-plan.md)
- **`has(k, eq(collectionLiteral))` + meta-property typing** — two remaining typed-value tails. *Low.*
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

- **Duplicate property→owner projection in `services/catalog/search.ts:73`** — `searchProperties`
  hand-builds the payload join its own comment says is "mirroring `lowerProperties`"
  (`tail/group.ts:648`). Zero deferrals; a schema change lands twice. The contrast worth keeping:
  `degree-centrality.ts` calls `scopedMovementCount` and gets `where(call(…).is(n))` at arbitrary
  depth for free. → [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md) #8
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
- **Upstream `q`-kernel surface to lazyrecords**.
  → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Land the TinkerPop fork's upstream payloads.** The submodule tracks `origin/master` and the fork
  exists at `danielbodart/tinkerpop`; what remains is landing four fixes, each verified against
  source:
  1. **`toNumeric` cannot produce a BigInteger** — branch `fix-cucumber-bigint-numeric-parsing` is
     written, self-verified and pushed; captures the `d[…].<suffix>` type tag and dispatches on it
     (mirroring gremlin-dotnet's `NumericParsers`). **Not yet opened as a PR.** See the won't-do
     entry below for why our own framing is already right.
  2. **The generated cucumber `gremlin.js` references an undefined `uuid`** (16 uses, no import, not
     in deps) — every UUID scenario dies, costing us `g_injectXUUIDXXX`. The generator IS in-tree
     (`gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy`) and the output is TRACKED, so
     the fix touches the template's import block, the `uuid` devDependency, and the regenerated file.
     **Patch ready**: `docs/upstream-patches/01-cucumber-uuid-import.patch`.
  3. **The cucumber port is hard-coded** (`test/helper.js`, docker-compose) — the intermittent CI
     conflict with our own conformance host, which must own that port because the client offers no
     way to configure it. **Patch ready**:
     `docs/upstream-patches/02-cucumber-port-env-override.patch` (`GREMLIN_SERVER_PORT` /
     `GREMLIN_SERVER_AUTH_PORT`, byte-identical when unset).
  4. **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a BUN bug, not TinkerPop's. Worked
     around in `test/support/undici-shim.ts`; worth reporting to Bun. Do NOT "fix" it by making the
     client call `close?.()` — that would silently skip real connection-pool teardown.

  The fork is also the intended home for the **non-conformant-client UUID/ISO-date shim** (a JS
  client cannot send a UUID's type, so sniff the obvious string shapes — **opt-in**, never default:
  a string that merely looks like a uuid is not one).
  → [typed-merge-values](./archive/2026-07-17-typed-merge-values-plan.md)

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
- **"`asNumber(GType.BIGINT)` of a small value should downcast on the wire"** → **our framing is
  already correct; the blocker is a vendored-harness defect.** TinkerPop's
  `NumberSerializationStrategy` magnitude-dispatches only for `typeof item === 'number'`; for
  `bigint` it is unconditional, and `data/BigInt.feature` expects `d[456].n` — the declared type
  PRESERVED, not narrowed. The real cause is gremlin-js's `feature-steps.js`
  `toNumeric` (`parseFloat` never throws, so its `BigInt` branch is unreachable). A blanket downcast
  would REGRESS the 5 sibling scenarios that pass today. Fix it in the fork's harness (debt item
  above), not in our serializer; net L3 gain likely ≤0 if "fixed" our side.

Sources: [hand-rolled-sql-audit](./2026-07-27-hand-rolled-sql-audit.md),
[lazyrecords-cutover](./archive/2026-07-11-lazyrecords-cutover-plan.md),
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
