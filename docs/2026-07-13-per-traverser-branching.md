# Per-traverser branching — choose / coalesce / union / optional / map / flatMap

The engine for TinkerPop's *branch family* — steps that run a child sub-traversal
per current traverser and fold the result back. This is "bet #2" from
`2026-07-12-conformance-structural-bets.md` (the top-ranked next structural
investment after the path family landed). It stays true to locked decision #3:
**compile to one SQL statement, never interpret**.

Status: **Phases A–C landed (2026-07-13, live L3 455 → 459).** `choose` (predicate
form), `coalesce`, multi-hop `union`/`optional`, `flatMap` — all in one SQL statement.
Deferred with clear errors: option-map `choose`, scalar/projection branch bodies,
mixed-shape branches, branch-inside-branch (nested origin), `map` (first-result).

## The prior-art scan settled the approach (do not relitigate)

Sqlg (`~/Projects/sqlg`) is the reference impl for Gremlin-on-relational-SQL. Its
verdict on this family is decisive and *validates going more SQL-native than it did*:

- **Sqlg branches in Java, not SQL.** Every branch step is a `*StepBarrier`:
  drain the incoming traversers, push them as a batch into each child traversal
  (each child independently compiles *its own* linear V/out/has chunk to SQL),
  collect the results in Java, merge/sort, stream out. There is no branch-level
  `CASE`/`UNION`/correlated-subquery in one statement — the branching is *around*
  SQL, not *in* it. (`SqlgUnionStepBarrier`, `SqlgBranchStepBarrier` = the choose
  engine, `SqlgOptionalStepBarrier`, `SqlgLocalStepBarrier`.)
- **Sqlg gives up entirely on `coalesce`, `map`, `flatMap`** — no Sqlg step, no
  strategy, pure default row-at-a-time TinkerPop. A signal these have poor SQL
  leverage *in a row-at-a-time-per-branch model*. mogwai's **set-at-a-time /
  one-statement** model is a different game: we can push `choose`/`coalesce` into
  one statement via gated `UNION ALL`, which Sqlg's architecture couldn't.
- **`choose`: we beat Sqlg's design.** Sqlg's predicate re-association is a fragile
  "backward-path-walk" (`SqlgBranchStepBarrier` — walk each result's path back to
  find which cached start produced it) *because its predicate hits the DB and loses
  1:1 start correspondence*. mogwai keeps the predicate a **correlated boolean**
  (`compileFilterPredicate`) and dispatches via **gated seeds** — no re-association
  needed at all.

**The one technique worth banking (for Phase B `coalesce`):** Sqlg's synthetic
input-ordinal column (`sqlg_index`, emitted as a `(VALUES (id,idx),…)` join or a
literal for the single-start fast path, then re-sorted on in the merge). It's the
general answer to "which input produced this row" *and* multiset order-preservation
across a batch boundary. We need it for `coalesce`'s first-non-empty precedence —
see Phase B.

## The one primitive: `foldBody` (Phase A, landed)

`seedUnion` (`steps/index.ts`) already compiles a nested traversal into the *shared*
`Query` via a recursive prefix fold. Phase A extracted that fold into the reusable
seam every branch step builds on:

```ts
// steps/index.ts
export function foldBody(steps: PStep[], seedSt: St, from: number): { st: St; stop: number }
```

Fold the `PREFIX` dispatch over `steps` from index `from`, threading `St`, starting
from an already-**seeded** relation (not a V/E source). Stops at the first step
absent from `PREFIX` (a projection/scalar tail) and reports where. `buildPrefix` is
now `foldBody(steps, seededSource, 1)`. A branch body carries no `strategies`
normalization (matching `seedUnion`'s existing behaviour), so a `repeat`/`by`
cluster *inside* an arm defers via its own compiler's guards — acceptable, fail-closed.

Because arm bodies fold through the *same* `PREFIX` machinery as the main chain,
**multi-hop arms work for free** (`out().out().has(…)`), unlike the single-JOIN
shortcut that still restricts `union`/`optional` (Phase C fixes those).

## `choose` — predicate form (Phase A, landed)

`choose(pred, then[, else])`. `steps/branch.ts`:

1. Compile `pred` to a correlated boolean via `compileFilterPredicate` on the current
   element ctx (the shared `has`/`where`/`filter` engine — `and`/`or`, `has(k[,v])`,
   `hasLabel`, `values(k)[.is]`, `out().count().is(P)`, bare `out()`→EXISTS).
2. **Gate** the current relation into two one-column seeds: `WHERE pred` and
   `WHERE NOT COALESCE((pred),0)` (a NULL/missing-prop → false, so else gets exactly
   what then didn't).
3. Fold each arm from its gated seed via `foldBody`. else absent → the NOT-pred seed
   *is* the identity passthrough.
4. Merge the two element id-relations `UNION ALL`, advance with the arms' `elem`.

Same-shape arms only (both node or both edge). The result is a plain node/edge
id-relation, so the tail (`values`/`count`/…) and GraphBinary framing need **zero**
changes — it frames exactly like `out()`.

Correctness note: each input row evaluates the predicate independently in its gated
CTE, so multiset semantics and per-row dispatch are automatic — no ordinal column
needed here (contrast `coalesce`).

**Deferred, fail-closed (clear errors):**
- Option-map form `choose(choiceFn).option(k, t)…` — needs a `foldChooseOptions`
  normalization pass in `strategies.ts` (gather the trailing `option()` siblings onto
  the `choose` step, à la `foldByModulators`). Phase D.
- Scalar/projection arm bodies (`__.values('name')`, `__.constant(x).fold()`) — the
  id-relation can't carry a scalar (the `St`-vs-`ScalarCtx` fork). Would need the
  scalar-body engine (a later bet).
- Mixed-shape arms (one node, one edge/scalar) — no per-row discriminant in the
  framing layer (`handler.ts` frames one static `Shape`). Explicitly out of scope.
- `choose()` after `as()` / with path tracking (alias/path carry through a branch —
  same limitation `union`/`optional`/`repeat` all have today).
- `choose(__.has(T.label,'person'), …)` predicate — a real *predicate-engine* gap:
  `compileFilterPredicate` handles `has(stringKey[,v])` but not the `has(T.label,…)` /
  `has(T.id,…)` token form. Widening it there (mirroring `filter.ts` `has`'s token
  branch) is an independent small win.

## Phase B (landed) — `coalesce` + the ordinal column

`coalesce(t1, t2, …)` = for each traverser, emit the results of the **first branch
that produces ≥1 result**. This is the one branch step with a genuine cross-branch
dependency, so it needs the **origin ordinal** Sqlg uses:

- Thread a per-input-traverser ordinal column (`seed`/`o`) through each branch body
  (the `carryFrag` mechanism already threads carried columns through movement — add an
  ordinal position seeded at the branch entry, `ROW_NUMBER()` over the current
  relation). An *ordinal*, not the element id, because traversers are a multiset —
  two identical vertex ids must stay distinct.
- Compile each branch via `foldBody` carrying `(o, id)`; then:
  ```sql
  SELECT id FROM b1
  UNION ALL SELECT id FROM b2 WHERE o NOT IN (SELECT o FROM b1)
  UNION ALL SELECT id FROM b3 WHERE o NOT IN (SELECT o FROM b1 UNION SELECT o FROM b2)
  …
  ```
- Same-shape branches only; scalar branches (`__.constant('x')`) deferred with the
  same fork rationale as `choose`.

The ordinal is a first-class `St.origin` column (`context.ts`), threaded by the same
`carriedCols`/`carryFrag`/`advance` machinery as `as()` aliases and path positions —
so it rides through arbitrary multi-hop bodies for free. `optional(t)` reuses it as
`coalesce(t, identity)`. Nested branch-inside-branch (an outer ordinal already set)
fails closed (`if (st.origin) throw`). Building this carry **also unblocks
`as()`-through-branches** later (same machinery `union`/`repeat` still refuse).

## Phase C (landed) — widen `union`/`optional`, add `flatMap`

- Replace `union`/`optional`'s single-JOIN shortcut (`branchMovementSelect`, the
  `LEFT JOIN` in `branch.ts`) with `foldBody`, so multi-hop bodies work
  (`union(__.out().out(), __.in())`, `optional(__.out().has(…))`). Keep the existing
  single-hop `LEFT JOIN` for `optional` where the body *is* a single hop — it's more
  SQL-native than a leftover-set anti-join; only fall to the general shape for
  multi-hop.
- `flatMap(t)` = `foldBody` + advance (a fan-out `UNION ALL`); trivial once the seam
  exists.
- `map(t)` deferred beyond C: `map` takes the **first** result per input (vs
  `flatMap`'s all), which needs `ROW_NUMBER() OVER (PARTITION BY <ordinal>) = 1` —
  the Phase B ordinal again. Low real-world value; fold in opportunistically.

## Test discipline

Each phase lands with: SQL-snapshot tests + fail-closed deferral assertions in
`test/compiler.test.ts`, execution-semantics tests running real SQL against the
seeded modern graph, corpus (L1) still 100%, and the L3 baseline (`baseline.json`)
auto-ratcheted and committed. Phase A: `choose` snapshot + deferral + execution
tests, L3 455 → 456.
