# Outstanding work

The de-duplicated index of open work across the `docs/` corpus. **Each line sets the scene — what,
why, what it unblocks, where to start — not a spec.** The linked doc holds the rationale; the
picking agent does the detailed validation and design. Landed work is excluded (the corpus
over-reports `LANDED`; this keeps only what a code check confirms open). Live per-step capability:
`feature-support-matrix.md`.

**Refreshed** 2026-07-25 against L3 1275 unique / 2041 (`l3-state.json` shows 1277 — two names
recur legitimately, see `test/CLAUDE.md`). Path pointers assume the 2026-07-23 restructure
(`src/compiler/steps/{context,prefix,tail,write}/`, `src/compiler/{ir,plan,engine}/`).

**Ordering — floor vs ceiling.** L3 is the floor (scenarios that pass); the ceiling is generic
lowering that composes the full nested grammar at any depth/combination (see
`src/compiler/steps/CLAUDE.md`). P1 raises the ceiling — each item unblocks a *family*; one-off
step impls are matrix-fill, lower. Impact: **High** (correctness / whole-family unblock) ·
**Medium** (real feature bucket) · **Low** (narrow, fail-closed, or debt).

---

## P1 — ceiling-raising generic-substrate lifts

1. **Unify the branch-merge family onto the `VariantStream`/`variantArm*` substrate.** `union`/
   `choose`/`coalesce`/`optional` are hand-rolled ~7× (element vs scalar parent × scalar/list/
   variant arms) instead of routing through the parent-agnostic merge builders that already exist.
   The single largest duplication surface. **Unblocks:** item 4 (the arm-merge `encounter` mint
   lands once instead of per-copy), and thereby `path().by(__.union)` fan-out + mixed-shape
   take-first. Start: `steps/prefix/branch.ts`, `steps/tail/{scalar-arm,variant}.ts`,
   `engine/engine.ts` (arm-shape probes ~L258–312). **High.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

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

4. **Canonical-emission-order Stage C.** Branch merges don't mint the arm-merge `encounter`, so
   element-parent take-first and emission ordering across arms is unspecified. Becomes mostly free
   once item 1 unifies the merge. **Unblocks:** `path().by(__.union)`, mixed-shape take-first,
   `dedup(labels)` ordering. **Medium.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)

5. **Map/non-element re-entry.** `valueMap().select()` into a retyped `MapStream`, and `as()`/
   `select(label)` over group/map/path/property streams. **Medium.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md),
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5

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

13. **`with(...)` / `OptionsStrategy` sugar** — e.g. `valueMap().with(WithOptions.tokens)`; dies as
    "step not implemented". **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

14. **`format()` and `index()` steps** — both unimplemented. **Low-Medium.**
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
  over `json_each` (`steps/tail/path.ts` hard-throws). *Low-Med.*
  → [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element/property-valued inner keys+values, composite `project()`
  keys, `elementMap()` followers, `keys→SET`, `as()`/`order()` on a group. `steps/tail/group.ts` is
  where the child seam most often bottoms out — extend it (item 2), don't dedup. *Low.*
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./archive/2026-07-16-p3-reenterable-shapes-plan.md)
- **Mixed-shape branch corners** — node+edge in one branch, `path()` through it, `as()` inside an
  arm. Closed as a family by items 1+4. *Low.*
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
