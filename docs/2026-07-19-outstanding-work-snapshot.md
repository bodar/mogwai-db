# Outstanding-work snapshot

**Date:** 2026-07-19
**Status:** point-in-time roll-up — a de-duplicated index of every "future thing"
proposed across the `docs/` plan/research corpus, minus everything already shipped.
**How to read it:** each line is a pointer, not a spec — follow the linked source doc
for rationale and detail. Items already landed are deliberately excluded (the doc
corpus is heavily self-reported as `LANDED`; this snapshot only keeps what a codebase
check confirmed is still open). For live per-step capability, cross-check
`feature-support-matrix.md`.

Kept live as items land: a **✅** marks work completed *since this snapshot's first
draft*, with its residual follow-ons left listed at their real (usually lower) priority.

Impact tags: **High** (correctness gap, or unblocks a whole cluster/family) ·
**Medium** (a real feature/conformance bucket) · **Low** (narrow matrix-fill,
fail-closed today, or cosmetic/debt).

---

## P1 — highest leverage (correctness + cluster-unblockers)

1. **Element-key `group()`/`groupCount()` bulk-weighting** — ✅ *core landed 2026-07-19*
   (`b7d3c9c`, `c6fc71b`; CI green, L3 baseline held). Bulk is threaded through
   `GroupSource` (`bulk`/`valBulk`): `groupCount()` and `group().by(k).by(reducer)` now
   weight by `SUM(bulk)` like the scalar-key forms (behavior-identical while bulk≡1), and
   `movementCollapse` is enabled for non-fan-out-key `groupCount()` terminals so
   dense-fan-out groupCount is tractable+correct (equivalence + weighted tests committed).
   Weighting reaches every level — outer, child-scope value reducers (`by(__.out().sum())`),
   and the nested-map inner reducer (`by(__.<move>.groupCount())`). **Only narrower
   follow-ons remain (Low-Medium) — no longer P1:** collapse gating for
   `group().by(k).by(reducer)` terminals (weighting is correct-by-construction, only the
   `chainCollapseSafe` admission is deferred); `repeat().times(n).groupCount()` tractability
   (needs repeat-level frontier collapse feeding the group stream — `tryBulkRepeat` only
   feeds `count()`/element leaves).
   → [wire-bulking-rearchitecture](./2026-07-18-wire-bulking-rearchitecture.md) (2026-07-19 update),
   [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #2,
   [traverser-bulking](./2026-07-14-traverser-bulking.md)

2. **`MapStream` relational unfold — `is(typeOf(MAP))` → MapStream** — the single most
   depended-on gap: `MapStream` exists but has no SQL-side unfold, so the whole
   `valueMap()`/`group().unfold()` / Map.Entry-stream family is blocked, and it gates
   items 3, P2·9, and P2·10 below. **High.**
   → [list-value-substrate](./2026-07-13-list-value-substrate-plan.md),
   [typed-property-values](./2026-07-16-typed-property-values-plan.md),
   [full-fidelity-typed-collections](./2026-07-17-full-fidelity-typed-collections-plan.md)

3. **`valueMap().select()` — map-value re-entry** — valueMap-with-follower retypes to a
   per-element `MapStream`, but selecting into it is deferred. Gated on item 2. **Medium.**
   → [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

4. **Canonical-emission-order Stage C** — element-parent branch merges
   (`tryLowerScalarUnion/Choose/Coalesce`) and the variant merge builders don't yet mint
   the arm-merge `encounter`. Finishing it closes the recurring take-first non-goal for
   element parents and unblocks `path().by(__.union)` (fan-out), mixed-shape
   `VariantStream` take-first, and `dedup(labels)` first-in-emission ordering. **Medium.**
   → [canonical-emission-order](./2026-07-19-canonical-emission-order.md),
   [path-by-branch-bodies](./2026-07-18-path-by-branch-bodies.md)

5. **Path natural-order comparability (`order().by()` of paths)** — unlocks the
   Orderability conformance cluster; the one path piece with measurable multi-scenario
   yield. **Medium.**
   → [path-history-substrate](./2026-07-18-path-history-substrate.md)

6. **Map-valued carried alias entry → `as()` over group/map/path/property streams** — the
   shared substrate move (roadmap #5) that makes labels work on non-element shapes; also
   the blocker behind **`as()`/`select(label)` threaded through `repeat()`**
   (recursive-CTE term must carry alias columns). **Medium.**
   → [deep-seam-migration-roadmap](./2026-07-18-deep-seam-migration-roadmap.md) #5,
   [labels-as-path-history](./2026-07-16-labels-as-path-history.md) (follow-up #3),
   [path-history-substrate](./2026-07-18-path-history-substrate.md),
   [carried-schema-and-projection-reentry](./2026-07-14-carried-schema-and-projection-reentry-plan.md)

---

## P2 — solid features / conformance buckets

7. **Mid-chain side-effect readback predicates — `where(within('x'))` / `without('x')`** —
   the `aggregate().by().where(without('x'))` dedup idiom is a real corpus cluster; no
   aggregate-readback exists yet. **Medium.**
   → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

8. **`addV` mid-chain + read-tails-after-write** — gates a cluster of write-conformance
   scenarios currently deferred. **Medium.**
   → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §6

9. **Strategy completion tails** — `SubgraphStrategy(vertexProperties)` criterion,
   `PartitionStrategy` meta-properties + merge, and nested-body descent. (Edge criterion
   + adjacency expansion already landed since the plans were written.) **Medium/Low.**
   → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md),
   [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md)

10. **`with(...)` / `OptionsStrategy` sugar** — e.g. `valueMap().with(WithOptions.tokens)`;
    still dies as "step not implemented". Small but blocks a common valueMap idiom.
    **Low-Medium.**
    → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md) §0

11. **`sack()` through `repeat()`** (+ split/merge/BiFunction sack) — needs sack carried
    through the recursive walk term. **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

12. **`format()` step** — string interpolation step, still unimplemented. **Low-Medium.**
    → [seam-reuse-audit](./2026-07-13-seam-reuse-audit.md)

13. **Multi-key `cap('x','y')` + cap-of-group unfold** — gated on Map-unfold (item 2).
    **Low-Medium.**
    → [side-effect-state](./2026-07-13-side-effect-state-plan.md)

---

## P3 — narrow / fail-closed matrix-fill (each correct-by-design today)

These are all deferrals that currently fail *closed* (clear error, never mis-execute).
Worth doing only when a concrete scenario demands them.

- **Recursive-path tails** — `path().by()` on the walk, `cyclicPath` in-repeat,
  `until`/`emit(pred)` with path, edge-inclusive bodies, mixed linear+repeat paths;
  recursive-regime `from()`/`to()` and multi-bind from/to. *Low-Medium.*
  → [path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md),
  [path-history-substrate](./2026-07-18-path-history-substrate.md)
- **Group re-entry matrix-fill** — element-valued inner keys, property-element group
  values, single-element tail values, composite `project()` keys, `elementMap()`
  heterogeneous followers, `keys → SET` typing, `as()`/`order()` on a group, named
  `groupCount('a')`-over-scalar. *Low.*
  → [group-value-generic-seam](./2026-07-18-group-value-generic-seam-plan.md),
  [p3-reenterable-shapes](./2026-07-16-p3-reenterable-shapes-plan.md),
  [p4-dynamic-variant](./2026-07-16-p4-dynamic-variant-plan.md)
- **Mixed-shape branch corners** — mixed element-KIND (node+edge) in one branch,
  `path()` through a mixed branch, new `as()` bound inside a variant arm, mixed-record
  `select(Column.values)` tuple lists. *Low.*
  → [p4-dynamic-variant](./2026-07-16-p4-dynamic-variant-plan.md)
- **Write fail-closed walls** — `addE`/`mergeE` endpoint traversals past a movement/branch,
  map-valued merge drivers (`__.identity()`/incoming-as-map), nested property keys, nested
  merge label/id/direction values. *Low.*
  → [writes-through-read-spine](./2026-07-17-writes-through-read-spine-plan.md),
  [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md)
- **Typed-value tails** — `Scope.local` STRING transforms over typed list elements;
  `has(k, eq(collectionLiteral))` collection-equality; meta-property typing. *Low.*
  → [full-fidelity-typed-collections](./2026-07-17-full-fidelity-typed-collections-plan.md),
  [typed-merge-values](./2026-07-17-typed-merge-values-plan.md)
- **`sideEffect(__.…)` step + `withSideEffect(...)`** — a distinct side-mutation family,
  no consumer yet. *Low.*
  → [side-effect-state](./2026-07-13-side-effect-state-plan.md)
- **`shortestPath()`** — special-cased recursive CTE; niche, machinery already exists.
  *Low.* → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md)
- **`repeat`/`match` emission order** — recursive-CTE can't window across iterations; the
  one documented fan-out left without emission order. *Low.*
  → [canonical-emission-order](./2026-07-19-canonical-emission-order.md)
- **L3 ratchet hygiene** — descope OLAP/GraphComputer strategies in `tags.ts` so the
  ratchet stops counting permanently-out-of-scope scenarios as failures. *Low.*
  → [with-strategies-exploration](./2026-07-13-with-strategies-exploration.md)

---

## Product / operations track (not compiler features)

Independent of conformance; needed before a real multi-tenant deployment.

- **Real Cloudflare deploy** — only `wrangler deploy --dry-run` is wired today; code is
  CF-ready. *Medium.* → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md)
- **Bearer-token auth per graph** — no auth surface in `src/` yet. *Medium.*
  → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md)
- **Untyped GraphSON v4 response encoder** — content-negotiated JSON responses; the sole
  thing making the shipped `/docs` "Test Request" panel usable (JSON *requests* already
  work). Self-described as ~½–1 day / low risk. *Medium.*
  → [graphson-untyped-scope](./2026-07-13-graphson-untyped-scope.md)
- **Multi-request `g.tx()` session state** — deferred by design; needs DO session state.
  *Low-Medium.* → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md)
- **Per-request implicit transaction** — possibly moot (DO single-threading already gives
  de-facto serializability). *Low.* → [phased-roadmap](./2026-07-11-phased-roadmap-plan.md)
- **Typed GraphSON (`types=true`)** — additive, gated on a type-faithful JSON consumer
  appearing. *Low.* → [graphson-untyped-scope](./2026-07-13-graphson-untyped-scope.md)

---

## External give-backs / internal debt (Low)

- **Upstream the `q`-kernel surface to lazyrecords** — identifier-default template,
  `Relation`, typed-self recursive CTE. → [q-kernel-sql-builder](./2026-07-12-q-kernel-sql-builder.md)
- **Upstream JS-client GraphBinary PR** to preserve value types on the wire (infer-fallback
  covers it today). → [typed-merge-values](./2026-07-17-typed-merge-values-plan.md)
- **Non-conformant-client shim** — opt-in regex UUID restore for clients that drop type.
  → [typed-merge-values](./2026-07-17-typed-merge-values-plan.md)
- **Fold the third scalar-child projector residue** (`compileScalarChildRows`/`continueScalar`)
  onto the generic `PROJECTORS` — maintainability only.
  → [compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md) §1

---

## Superseded / won't-do (do NOT relitigate)

Kept here so nobody re-opens them from an old doc.

- **ansi SQL builders + CTE-recipe templates** → replaced by the `q` kernel.
  ([lazyrecords-cutover](./2026-07-11-lazyrecords-cutover-plan.md))
- **Self-tuning expression indexes on `nodes.props`** and the **flat `edges.props` JSONB
  blob** → replaced by normalized `vertex_properties`/`edge_properties` + static covering
  indexes. ([phased-roadmap](./2026-07-11-phased-roadmap-plan.md))
- **`tree()`** → parked: the JS GLV stubs `DataType.TREE`, so it yields 0 conformance
  value. ([path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md))
- **Two-`union` merge / `optional` fast-path cleanup** → explicit won't-do; keep the
  `optional` fast path. ([seam-reuse-audit](./2026-07-13-seam-reuse-audit.md))
- **"BulkSet is a wire dead-end"** → *corrected*: GraphBinary V4's `{bulked}` byte IS
  decoded; wire bulking landed and is a live direction, not foreclosed.
  ([traverser-bulking](./2026-07-14-traverser-bulking.md) →
  [wire-bulking-rearchitecture](./2026-07-18-wire-bulking-rearchitecture.md))
- **Cross-DO federation** (`call()`-boundary + `ATTACH` coordinator) → investigated, not
  adopted; "nothing built, nothing planned".
  ([cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md))
- **Client-side partition → DO routing** → out of scope; server-side soft filtering is the
  conformance-complete path. ([with-strategies-exploration](./2026-07-13-with-strategies-exploration.md))
- **Platform walls** — regex UDFs, `typeOf` over some stored props, bigdecimal, lambdas,
  OLAP/GraphComputer → architectural limits of DO SQLite / TinkerPop v4, correct-by-design
  fail-closed, not future work.
  ([compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md),
  [phased-roadmap](./2026-07-11-phased-roadmap-plan.md))
- **Child-scope split-seed + 4-consumer migration** → superseded by a smaller carried-cols
  fix that shipped instead. ([child-scope-path-split](./2026-07-18-child-scope-path-split.md))

---

## Research / vision docs (no build items — reference only)

- **[agent-memory-vision](./2026-07-17-agent-memory-vision.md)** — envisions a sibling
  `mogwai-memory` repo (agent-memory infra: one Gremlin endpoint + Cloudflare Code Mode
  sandbox, fused recency/salience/similarity ranking compiled to SQL, DO-per-agent,
  in-DO brute-force vector cosine). Explicitly exploratory; the memory layer is meant to
  live in a *separate* repo, leaving mogwai-db a clean TinkerPop-4 engine. The one
  primitive it flags as mogwai-db work — ranking/math in `by()` — remains unbuilt.
- **[cross-do-federation-prior-art](./2026-07-13-cross-do-federation-prior-art.md)** —
  prior-art scan on whether lazyrecords-style federation has a Gremlin analog; concluded
  not to build (see Superseded above).
- **[path-tracking-prior-art](./2026-07-12-path-tracking-prior-art.md)** — Sqlg / v4 /
  SQL-path-literature prior-art scan; its two-regime build plan was subsequently
  implemented (linear + recursive path both landed), so only the narrow tails in P3
  remain.
- **[compiler-consolidation](./2026-07-16-compiler-consolidation-plan.md)** — self-described
  "research + plan"; the strategic duplication map that drove the P1–P5 spine lifts. Its
  P1–P5 all landed; the residual items are folded into P2/P3 above.
