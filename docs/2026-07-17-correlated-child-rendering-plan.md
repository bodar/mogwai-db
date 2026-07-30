# Correlated-child rendering — make the predicate fast path fall out of the generic substrate

**Status: BUILT** (verified 2026-07-30). The predicate compiler moved to
`src/compiler/steps/prefix/predicate.ts`, `incidentExists` is deleted, and
`correlatedExists`/`correlatedReduce` are thin wrappers over `compileCorrelatedChild`
(`src/compiler/steps/tail/correlated.ts`) — the real StepFns in inline-correlated mode.
One residue remains: `correlatedReduce`'s E-form `values(k).<sum|min|max|mean>()` aggregate
still hand-writes an `edgeProperties` join. See `docs/outstanding-work.md` item 7e.

The text below is the original plan, kept for the spike (EXPLAIN + timings) and the layering
argument, both of which would be expensive to re-derive. Read its paths through the rename map
in `docs/2026-07-29-tinkerpop-core-engine-alignment.md` — they predate the 2026-07-23
restructure.

---

**Original status:** planned, not started. Spike done (feasibility proven). This is a focused
cross-layer refactor; everything it builds on is already committed + CI-green on trunk.

## Goal

Today the correlated predicate fast path is **bespoke hand-rolled SQL in `plan.ts`**
(`correlatedExists` / `incidentExists` / `correlatedReduce`) sitting beside the generic
child seam. The vision (Dan's "swap only the middle bit"): the fast path should be **the
generic child pipeline rendered in an inline-correlated mode** — same StepFns, same
plumbing, only the *rendering* differs (materialized CTE vs inline correlated subquery).

End state: `correlatedExists`, `incidentExists`, `correlatedReduce` are **deleted**. A
movement/filter predicate body is compiled once, by the real movement/filter StepFns, and
rendered as one nested correlated subquery. `where`/`filter`/`and`/`or`/`choose`/`until`
all use it. `predicateInlining` stays a disable-safe fast path with the materialized child
gate as the equivalent generic fallback.

## Why the hand-roll exists (the layering finding — the crux)

The correlated-movement compiler must reuse `lowerElementSteps` (the `steps/` layer). But
the predicate compiler (`compileInlinePredicate`/`tryInlinePredicate`/`combineBranchPreds`)
lives in `src/plan.ts`, the SQL-node layer *below* `steps/` (`steps/*` import from
`plan.ts`, never the reverse). `plan.ts` cannot reach `lowerElementSteps` without inverting
the layering — which is exactly why `correlatedExists` hand-rolls the `xe/xn` join chain.

So this refactor's core move is: **relocate the movement/EXISTS + count-compare branches of
the predicate compiler up into the `steps/` layer**, where they can call the child seam.
`plan.ts` keeps only the current-element leaf predicates (has/hasLabel/hasId/label/values,
`predicateSql`, `labelIn`, `nodeHasProp`, …) that don't need movement.

## Spike evidence (already run — do not redo unless changing approach)

Rendering the child as nested correlated `derived()` subqueries **stays index-only** and is
far cheaper than the materialized generic gate. On a ~4k-vertex `knows` graph, EXPLAIN +
200-run timing:

| shape | flat hand-rolled (`correlatedExists`) | nested correlated `derived` (proposed generic) | materialized generic gate |
|---|---|---|---|
| 1-hop `where(out('knows'))` | 0.44 ms, `SEARCH xe … e_out` | **0.61 ms**, `SEARCH e … e_out` (index-only; +`CO-ROUTINE p` seed) | ~3.5 ms (`MATERIALIZE` + window) |
| 2-hop `where(out().out())` | 1.75 ms | **1.11 ms** (faster — SQLite flattens it) | heavier |

Derived form for `where(out('knows'))`:
```sql
EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e
                      JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label=?) x1)
```
The innermost `(SELECT n.id AS id) p` seed references the OUTER `n` — legal because it's a
subquery (a CTE could not correlate; that limit is why materialization exists in the generic
gate). The `CO-ROUTINE p` seed adds ~40% at 1-hop (both sub-ms, index-only); optional later
refinement is to correlate the first hop directly (`WHERE e.src=<outerId>`) instead of via a
seed subquery, but it is NOT needed for viability.

## Design

1. **Inline-Query shim** (steps layer, e.g. `steps/child.ts` or a new `steps/correlated.ts`).
   A `Query`-shaped object whose `.cte(body, cols)` returns `derived(body, cols, freshAlias)`
   (alias prefix distinct from the outer's `c*`/`n`/`p`/`xe`, e.g. `x0,x1,…`) instead of
   registering a CTE; `.recursiveCte`/`.render` throw (an inline child has neither). The
   movement/filter StepFns interact with the Query only via `.cte` (through `advance` →
   `st.q.cte`), so swapping `st.q` for this shim makes the same fold emit nested `derived`
   relations with **no change to `advance` or `Carry`**.

2. **`compileCorrelatedChild(idExpr, nested, params, fastPaths?) → { rel, elem } | null`**.
   Seed an `ElementStream` whose `q` is the shim, `rel = derived(q\`SELECT ${idExpr} AS id\`,
   ['id'], 'x0')`, `elem: 'node'`, empty carried. Run `lowerElementSteps(childSteps(nested),
   seed)`. Return `{ rel: end.rel, elem: end.elem }` iff the whole body consumed as pure
   movement + terminal filter (has/hasLabel/values/label); return `null` otherwise (so the
   caller keeps its clear deferral / falls through). Depends ONLY on (idExpr, params) — NOT
   the outer `Query` — so it serves `until` (correlate on `walk.id`) identically.

3. **Relocate the predicate movement branches into steps.** Move the `MOVES.has(head)`
   (existence) and `term==='count'||'sum'` (reduce-compare) branches of
   `compileInlinePredicate` out of `plan.ts` into the steps layer where `compileCorrelatedChild`
   is reachable. Existence → `EXISTS(SELECT 1 FROM ${child.rel})`. Count →
   `(SELECT COUNT(*) FROM ${child.rel}) <op> P` via `predicateSql`. `plan.ts` retains the
   current-element leaves + boolean-combination scaffolding, OR the whole predicate compiler
   relocates to steps — decide during implementation (prefer the smallest move that removes the
   inversion; a full relocation of `compileInlinePredicate`→`steps/predicate.ts` may be cleanest
   since `filter.ts`/`branch.ts` already call it from steps).

4. **Reduce (count/sum).** `count().is`: `(SELECT COUNT(*) FROM ${child.rel})`. The E-form
   edge-property aggregate `outE().values(k).<sum|min|max|mean>().is` that `correlatedReduce`
   currently covers: either (a) extend the inline compile to fold `values(k)` + reducer
   (child gives edge rows; wrap `(SELECT SUM(ep.value) FROM edge_properties ep JOIN ${child.rel}
   c ON ep.edge=c.id WHERE ep.key=?)`), or (b) if unexercised by tests/conformance, let it fall
   through / fail closed. CHECK: `grep` tests + corpus for `values(...).sum()/min()/max()/mean()`
   inside `where`/`is` before deciding — do NOT silently regress a working shape.

5. **Delete** `correlatedExists`, `incidentExists`, `correlatedReduce` from `plan.ts`
   (added 2026-07-17 in the two prior commits). `MOVES`/`AGG_FN` move with the relocated branch
   if still needed; `dirsFor`/`edges`/`edgeProperties`/`labelIn` stay (shared).

6. **`until` reuse** (`steps/branch.ts:untilPredicate`, ~line 44). It correlates on a
   recursive-walk `walk.id` inside the recursive CTE — a materialized child is impossible
   there, but an inline correlated subquery is fine. Route it through `compileCorrelatedChild`
   with `idExpr = walk.id`. This is the ONE consumer with no materialized fallback; document it.

## Fallback / generic authority (fast-path law)

The materialized child gate (`childExistenceGate` / `tryCompileCountValueRows` with the
trailing-`is` HAVING, both already built this session) is the generic fallback: with
`predicateInlining: false`, `where`/`filter`/`choose`/`andOr` route through it and are
result-equivalent. The existing equivalence test cases (`test/compiler.test.ts`, "every
disable-safe fast path is result-equivalent to generic lowering") must keep passing; the
inline-correlated rendering is the *enabled* branch, the materialized gate the *disabled*
branch. `until` has no generic fallback (recursive correlation) — correlated-only, documented.

> **Superseded 2026-07-27 (that last sentence only):** `until()`/`emit()` DO have a generic fallback
> now — a row-local predicate compiles once over every vertex as a keyed relation
> (`steps/tail/keyed.ts`) and the recursive term reads `id IN <origin set>`. Inline stays first
> because it alone reads the walk's per-iteration state (`loops()`, the sack), which is why it is a
> capability rather than a disable-safe FastPath. The rest of this plan stands as written; see
> `2026-07-27-hand-rolled-sql-audit.md` #1.

## Test / verify

- Enabled==disabled equivalence for `where(out())`, `where(out().out())`,
  `where(out().count().is(P))`, `and(out(a), out(b))`, `choose(out().count().is(P), …)` —
  extend the existing fast-path equivalence test.
- EXPLAIN assertion that the inline form is index-only (`SEARCH … USING … e_out`), NOT
  `MATERIALIZE` — a snapshot/EXPLAIN test so a future regression to the heavy form fails.
- Re-run the `count().is` benchmark: inline generic should stay within ~1.5× of the old
  hand-rolled flat form and far below the materialized form.
- Full `bun test` (405 + L3 ratchet); L3 baseline must not drop (currently 1080).

## Landmarks (current code, post-1a/1b)

- Bespoke to delete: `src/plan.ts` — `correlatedExists`, `incidentExists`, `correlatedReduce`
  (+ `MOVES`/`AGG_FN`). Predicate compiler: `compileInlinePredicate`, `tryInlinePredicate`,
  `combineBranchPreds`, `splitInfixConnectors` in `plan.ts`.
- Generic seam: `src/steps/child.ts` — `childExistenceGate`, `tryFilterByChildExistence`,
  `tryCombineByChildExistence`, `tryCompileCountValueRows` (trailing-`is` HAVING),
  `pushChildScope`, `reuseCurrentFrame`.
- Pipeline: `advance`/`ElementStream`/`Carry` in `src/steps/context.ts`; `Query`/`derived`/
  `Relation` in `src/q.ts`; `lowerElementSteps` in `src/steps/index.ts`.
- Callers: `src/steps/filter.ts` (`where`, `andOr`), `src/steps/branch.ts` (`chooseGate`,
  `untilPredicate`). Switch: `src/fast-paths.ts` (`predicateInlining`).
- The property-group reader `tryPropertyGroupScalar` (plan.ts) is UNRELATED — leave it.

## Guardrails

- Correct by design / fail closed: an unsupported inline shape returns null → the caller
  either falls through to the materialized gate or throws a clear deferral. Never mis-execute.
- Keep the extension law: no new hand-rolled movement/alias scheme; the point is to STOP
  having two movement implementations.
- One `bun test`-green commit; commit + push to trunk (linear history) and watch CI, per the
  repo's commit-push-trunk flow.
