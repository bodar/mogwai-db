# Foldable carried columns — a substrate primitive, with `sack()` as first consumer

**Date:** 2026-07-24 · **Status:** design (approved shape: prototype `repeat()` first, split-only
fork semantics) · **Author:** Dan + Claude

This is a design lock for **one new substrate capability** — a *foldable* per-traverser carried
column — plus the removal of several conservative fork/loop guards that block on it. It is scoped
by two decisions already made: build the hardest boundary (`repeat()`) first as a proving spike,
and implement TinkerPop-correct **split-only** fork semantics (a fork clones the value into each
arm; forked traversers never recombine).

The motivating context is `docs/2026-07-17-agent-memory-vision.md` (§Retrieval): structural,
path-decayed ranking — association strength that falls with graph distance, reasoning-chain path
cost, multi-hop usage reinforcement — is the "beat neo4j's oversold hybrid" story, and it is the
part that needs a value **accumulated along a traversal**, which `math()` (a point computation)
structurally cannot express. `sack()` is that accumulator. `math()`-in-`by()` (the *static* fused
rank `order().by(math("w1·a + w2·b + w3·c"))`) already works (✅) and is out of scope here.

---

## The substrate framing — why this is a primitive, not a sack feature

`Carried` (`src/steps/context/context.ts`) already carries several per-traverser columns threaded
UNCHANGED through movement/filter CTEs: `aliases`, `path`, `origins`, `bulk`, `encounter`, `sack`.
Of these, **`sack` is the only one that is *mutated mid-chain by an operator applied to the current
row*** — `aliases`/`path` are append-only history, `bulk`/`encounter` are barrier-owned counters.

Today that mutation works only on the **linear** prefix (movement/filter): `sack(op).by(v)`
re-projects the id-relation, replacing the `sk` slot with `combine(prev.sk, byVal)` (see
`src/steps/prefix/sack.ts`). It fails closed at every **fork/loop/barrier** boundary because a
value that *changes per row* has no defined behaviour there until we design one:

- `repeat()` — the recursive CTE (`branch.ts:495`) carries only read-only walk state
  (`id, depth, path?, done?, emit?`); a term cannot fold an accumulator it re-seeds each iteration.
- branch (`union`/`choose`/`coalesce`/`optional`/`flatMap`) + `union()` source — `assertForkSafe`
  (`branch.ts:65`) and `mergeBranchCarried` (`branch.ts:136`) reject sack.
- `local()`/barrier — the child-body vocabulary (`SCALAR_CHILD_PREFIX`, `child-shape.ts`) never
  admits a mutate `sack(op)` step.

The insight that makes this a *primitive* rather than a one-off: **the recursive-CTE case needs a
column of the shape `combine(self.c.x, <current-row-value>) AS x` folded once per iteration** — and
that exact shape ("carry a value, fold the current position into it each step") is what THREE other
deferred features are independently blocked on (see Follow-ons below). So the deliverable is not
"sack in a loop"; it is **teaching the recursive walk to carry a foldable column**, with sack as
the first — and semantically strictest — consumer that exercises it end-to-end.

### Scope boundary (honest)

What generalizes (reusable substrate):
- The recursive CTE gains **foldable carried state** (vs today's read-only carried state). This is
  the reusable capability.
- Removing `assertForkSafe`'s sack guard is *split-only fork-clone* plumbing; the SAME removal path
  frees `fromV` (otherV context) through branch — one mechanism, two unblocked columns.

What does NOT generalize (stays sack-specific, by design):
- `combineSack` / the `Operator` vocabulary / sack's `by()` resolution — no other step reuses
  "apply Operator.sum/mult/min to a carried scalar". A follow-on picks its OWN fold (append, SUM).
- `local()`/barrier sack threading is sack-specific bookkeeping over the existing child scope, not
  a new seam.

So the accurate one-line claim: **one new substrate primitive (foldable walk state) + removal of
several conservative guards** — not a blanket "generic substrate" rewrite.

---

## Stage 1 (the prototype) — `sack()` through `repeat()`

All changes in `src/steps/prefix/branch.ts` (the `repeat` StepFn + its body helpers), reusing
`combineSack` from `src/steps/tail/scalar.ts` verbatim.

**Anchor scenarios (TinkerPop-canonical, already in the vendored features):**

```
# branch/Repeat.feature:664 — accumulate on the same vertex, sack-reading guard, no movement
g.withSack(0L).V().repeat(sack(sum).by("age").where(sack().is(lt(59)))).times(2)   → [marko, vadas]

# the memory shape — path-weight accumulation across a movement walk
g.withSack(0.0).V(x).repeat(out().sack(sum).by("weight")).times(n).sack()

# map/Math.feature:94 — fold a constant per iteration, read via math().by(sack())
g.withSack(1).inject(1).repeat(sack(sum).by(constant(1))).times(5).emit().math("sin _").by(sack())
```

**The five changes:**

1. **Body vocabulary.** Extend the body validator (`branch.ts:519-526`) to accept a mutate
   `sack(op).by(...)` step and a `where(__.sack()…)` guard, alongside `REPEAT_MOVES ∪ {has}`.
   Everything else still fails closed with the existing clear throw.

2. **Walk schema.** Add `sk` to `walkCols` (`branch.ts:565`) when the incoming stream carries a
   sack OR the body folds one. Seed `sk` in the base term from the outer row's `sk` (from
   `withSack()` or a prior linear `sack(op)`).

3. **Recursive-term fold.** In the body expansion (`expandRepeatBody`), a `sack(op).by(<v>)`
   contributes `combineSack(op, byVal, self.c.sk) AS sk`, where `byVal` is a **correlated scalar
   over the current walk row** — a property key (`by('weight')`), `by(T.label)`, or `by(constant)`.
   A fan-out `by(__.traversal)` cannot live in a single flat recursive SELECT (SQLite's
   one-self-reference rule) and stays deferred with a clear throw.

4. **Sack-reading guard.** `where(__.sack().is(P))` in the body becomes a WHERE condition over the
   *freshly folded* sack expression, so the guard sees the post-fold value (TinkerPop-correct — the
   `:664` scenario depends on this: marko 29+29=58<59 survives, but a 3rd fold would exit).

5. **Output.** The walk's final SELECT projects `sk`; `advance(...)` declares `sack: 'sk'` so a
   trailing bare `sack()` reads it.

**Split-only falls out for free.** A `both()` / multi-edge fork already emits N recursive rows via
`UNION ALL` of direction combos / matching edges; each inherits `self.c.sk` and folds
independently. No merge — exactly the split-only model. This is what the spike proves before we
touch branch/local.

**Deferred at this stage (clear throws, never mis-execution):** fan-out `by(__.traversal)` in a
repeat body; `until`/`emit` predicates reading the accumulated sack (own follow-on); the
branch/local/barrier boundaries (Stages 2–3).

**Tests (repo discipline — every step lands with them):**
- L2 SQL snapshot (`test/L2-sql/repeat-path.sql.test.ts`): the recursive CTE carries + folds `sk`.
- Compiler exec (`test/compiler/repeat-path.exec.test.ts`): the three anchor scenarios' values.
- L3: repeat + sack already in `tags.ts` scope; `Repeat.feature:664` should ratchet to newly
  passing (re-record `l3-state.json`). L1 corpus stays 100%.

---

## Stages 2–3 (after the spike proves the walk carry)

- **Stage 2 — branch fork-clone. ✅ DONE.** Removed the sack arm of `assertForkSafe` (`branch.ts`):
  the sack was ALREADY threaded correctly — it rides into every arm via `carryFrag`, passes through
  unchanged, and `armProjection`/`rigidCols` project it through the merge. The guard was purely
  conservative; split-only fork-clone is correct by construction (no reconciliation, each arm keeps
  its clone). `union`/`optional`/`coalesce`/`choose`/`flatMap` all covered. `fromV` stays gated
  (an edge's entering-vertex has no meaning after a fork moves off the edge). Still deferred (own
  follow-ons): a mutate `sack(op)` INSIDE an arm (the child-body vocabulary doesn't admit it — same
  root as the `local()` gap in Stage 3), and `withSack()` at a `union()` SOURCE (`engine.ts`
  `seedUnion` merges only `id,bulk`; seeding + threading a source sack is a small separate piece).
  L3 unchanged (1273) — no official corpus scenario is unblocked by fork-clone alone (they also need
  edge-step-in-repeat etc.) — but the capability is proven by committed exec tests. 0 regressions.
- **Stage 3 — `local()`/barrier. ✅ DONE.** A mutate `sack(op)` is an element-PRESERVING child
  step, so it belongs in the element-child prefix vocabulary (`isElementChildStep`), not as a
  scalar producer (only a bare read `sack()` is). With that classification fix, `local(__.sack(op)
  .by(...))` folds through the SAME `lowerElementSteps` engine per pushed parent — `pushChildScope`
  already threads the parent's sack into the child domain via `carriedCols`. Two conservative guards
  relaxed to enable it: (1) the sack StepFn blocked ALL `origins` (`sack.ts`) — but a pushed
  child-scope ordinal is safely copied through by the carriedCols re-projection, so only
  `aliases`/`path` stay gated; (2) `compileElementChildRows` blocked a parent sack (`child.ts`) —
  but the domain threads it correctly, so only `fromV` stays gated. `barrier()` is already an
  `identity` no-op on the SQL engine, so `V().in().barrier().local(...)` works. Anchor
  `branch/Local.feature:224` passes: `[29,29,29,32,32,35]`. **L3 1273 → 1274, 0 regressions.**

---

## Natural follow-on tasks — the compounding, made explicit

These are **independent features unblocked by Stage 1's foldable-walk-state primitive**. Recorded
here so they are designed-for now, not retrofitted. Each is a separate change with its own tests;
none is in scope for the prototype.

1. **Bulk reweight through `times(n)`** (`branch.ts:621-623`, `engine.ts:541`). Today the recursive
   walk re-seeds `bulk=1` per endpoint because bulk is a carried counter the walk can't fold; a
   convergent-walk collapse (`GROUP BY id, SUM(bulk)`) through an unrolled `times(n)` is explicitly
   deferred as "a recursive GROUP BY is rejected". `bulk` is a foldable carried column (fold =
   `SUM`), so the Stage-1 primitive is precisely its missing substrate. **Unlocks:** correct
   traverser multiplicity for `repeat().times(n).groupCount()`/`sum` (matrix §5 `…times(n).count()`
   ❌ row: "groupCount/by(count), sum ... across the walk").

2. **`aggregate('x')` / side-effect inside a `repeat()` body** (`branch.ts:443-444`). "Accumulate
   into a named collection along a walk" is the same fold shape as sack (fold = list append instead
   of a scalar op). Once the walk can carry+fold one column, a second foldable column (the aggregate
   list) is additive. **Unlocks:** collecting a walk's touched elements (the reasoning-trace
   `:TOUCHED` provenance the memory vision wants).

3. **`until`/`emit` predicates that read the accumulated sack. ✅ DONE** (Stage 5). `walkPredicate`
   now recognizes a pure `sack().is(P)` until/emit predicate (mirror of `sackWhereGuard`) and compares
   the walk row's accumulated sack against P; `doneCol`/`emitCol` thread the sack expression at the
   tested row (post-fold in the recursive term, the seed value on the seed). Gives "loop until this
   accumulated value crosses a threshold" — the direct memory-ranking primitive: `withSack(1.0)
   .repeat(out().sack(mult).by(constant(0.8))).until(sack().is(lt(0.1)))`, and the on-the-spot form
   `repeat(sack(sum).by('age')).until(sack().is(gte(50)))`. A MIXED sack+element until/emit predicate
   stays deferred (the element `ScalarCtx` can't carry the sack). **L3 unchanged (1275; not in the
   official corpus) — proven by exec tests. 0 regressions.**

4. **`sack(BiFunction)` lambda + T-token/inject-const gaps** (matrix §12 `sack()` row). Independent
   of the walk work — narrow completeness (a lambda has no `Operator` name to dispatch on;
   inject-const skips numeric-subtype coercion). Lower priority; not on the compounding path.

5. **Edge-step movements (`outE()`/`inV()`/`bothE()`…) in a `repeat()` body. ✅ DONE** (Stage 4,
   the naturally-discovered scope increase). `expandRepeatBody` now threads element *kind* as well
   as id: a vertex→edge step (`outE`/`inE`/`bothE`) joins a new edge and lands ON it (curElem=edge);
   an edge→vertex step (`outV`/`inV`/`bothV`) reads the current edge's endpoint (no new join). So
   `repeat(outE().sack(sum).by('weight').inV())` folds the traversed EDGE's `weight` while paused on
   it — **path-weight accumulation**, the most common sack-in-repeat memory query and the largest
   confirmed L3 cluster. `repeatSackByValue`/the body `has()` are now element-kind-aware
   (`aliasCtx(curId, curElem)`). A body left ON an edge (no closing `…V()`) is rejected (the walk id
   is a vertex rowid). `path()`/`simplePath()` OVER an edge-step body stays deferred (edge-aware path
   regime is a separate piece). **L3 1274 → 1275, 0 regressions.**

**Compounding order:** Stage 1 (walk carries+folds ONE column) → follow-on #1 (bulk is the SECOND
foldable column, proves multi-column fold) → #2 (aggregate is the THIRD, a non-scalar fold) → #3
(predicates read folded state). Each reuses the prior's substrate; #4 is orthogonal cleanup.

---

## Locked decisions for this work

1. **Split-only fork semantics** (TinkerPop-correct): a fork clones the sack into each arm; forked
   traversers never recombine. No fork-then-merge.
2. **`repeat()` first** as a proving spike; branch/local/barrier follow only after the recursive
   walk carry is demonstrated correct under multi-edge split.
3. **Compile-to-SQL is absolute** (project decision #3): the fold is one SQL expression in the
   recursive term (`combineSack`), never per-row JS. A `by()` shape SQL can't express in a single
   self-reference (fan-out traversal) fails closed.
4. **Reuse `combineSack` verbatim** — the operator semantics are already correct and boundary-
   agnostic; do not fork a second operator implementation for the walk.
