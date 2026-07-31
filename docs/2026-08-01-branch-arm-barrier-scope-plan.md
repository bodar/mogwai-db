# A branch arm's barrier observes the branch's whole input — doing it properly

**Status: T1 LANDED 2026-07-31. T2/T3/T4 open. The fail-closed gate has NOT been written** — nothing
named `verifyBranchArmBarrierScope` exists in `src/`, so anything T2/T3 have not reached still
mis-executes rather than deferring.
**T1's outcome, and it revises T1's own prediction.** "Probably nearly free" was right about the
LOWERING — the arm goes through the ordinary engine over the parent `ScalarStream`, no child scope,
no new substrate — and wrong about the MERGE. A barrier-dropped arm declares no carried columns, so
`unionScalarStreams` cannot project the merged schema off it; `collapsedArmProjection`
(`context/context.ts`) fills it instead, from the reference's own answer (`ReducingBarrierStep` emits
a GENERATED traverser: no labels, bulk 1), and `collapsedArmAdmissible` refuses a live
`path`/`sack`/`fromV`/origin at the branch INPUT, before a CTE is appended. **That is the piece T2
inherits** — §T2's "the merge must tolerate arms whose layouts differ in that specific way" now has a
name. `choose` also lands: the batched arm lowers over the GATED seed, because `hasBarrier` changes
how many starts are injected, not which option each start picks.
**Two tests asserted the old answer and both said so in a comment** ("matches the element-parent
branch convention"). They did; the convention was wrong. `test/compiler/scalar.exec.test.ts` and
`test/L4-addendum/scalar-reentry.feature` now carry the reference's answer plus a cardinality-MIXING
pin (`union(__.min(), __.constant(99))` is one row plus four), so batching is visible in the row
count and not only in the values.
Every claim below is cited to vendored reference source or to a measurement taken while writing it.
Read §1 and §6 before proposing anything here — §6 records four things I got wrong in one sitting,
each of which would have produced a confident, wrong change.

## 1. The fact, and it is a class-hierarchy fact rather than a judgement

`BranchStep.standardAlgorithm` (`vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java:123`)
runs in one of two modes, chosen by `hasBarrier` — set at `:87` by
`getStepsOfAssignableClassRecursively(Barrier.class, traversalOption)` and read at `:143`:

| `hasBarrier` | injection | consequence |
|---|---|---|
| false | `applyCurrentTraverser(this.starts.next())` — ONE start | arms are **per-traverser**; emission is traverser-major, arm-minor |
| true | `while (this.starts.hasNext()) applyCurrentTraverser(…)` — EVERY start | arms see the **whole input**; emission is arm-major over the stream |

One flag decides barrier scope **and** emission order together. We implement the first mode
unconditionally, for every arm of every branch kind.

**Which steps set it.** `Barrier` membership is by class, and it is wider than it looks:
`RangeGlobalStepContract extends FilteringBarrier extends Barrier` (so `limit`/`range`/`skip`),
`TailGlobalStepContract` likewise, `OrderGlobalStep`/`SampleGlobalStep extends CollectingBarrierStep`,
`CountGlobalStep`/`FoldStep`/`GroupStep extends ReducingBarrierStep`. Our `GLOBAL_BARRIER_STEPS`
(`ir/step.ts`) matches that set closely enough to use. `LocalStep` is **not** a Barrier itself, but the
scan is recursive, so `union(__.local(__.count()))` still sets the flag.

**Which branch kinds can batch — only two.** This is the single most important line in the document:

```
UnionStep    extends BranchStep      → has hasBarrier; batches
ChooseStep   extends BranchStep      → has hasBarrier; batches
CoalesceStep extends FlatMapStep     → flatMap(traverser) resets each arm PER TRAVERSER
OptionalStep extends AbstractStep    → processNextStart() takes this.starts.next(), one traverser
```

So a barrier in a `coalesce`/`optional` arm genuinely reduces over ONE traverser's sub-stream, and our
per-origin lowering of those two is **correct**. Only `union`/`choose` can disagree with a per-origin
arm. `BATCHING_BRANCHES` (`ir/step.ts`) is that pair, named separately from `BRANCH_KINDS` for exactly
this reason.

## 2. The corpus already pins it, and we answer the wrong one of its two halves

`branch/Union.feature` writes both readings on one graph:

```
g.V(vid1,vid2).union(outE().count(), inE().count(), outE().values("weight").sum())
  expects 3 results — d[3].l, d[1.9].d, d[1].l           we returned 5: [3,0,0,1,1.9]   ✗
g.V(vid1,vid2).local(union(outE().count(), inE().count(), outE().values("weight").sum()))
  expects 5 results — d[3].l, d[0].l, d[1.9].d, d[0].l, d[1].l   we returned 5           ✓
```

We answer the `local()` question when asked the bare one — and `local()` is precisely TinkerPop's
marker for the per-traverser form, which is why the two collapse into one for us. This is a wrong
ANSWER with the wrong CARDINALITY, not an ordering difference.

## 3. What is actually wrong, in one sentence

**Every branch arm is provisioned as a per-origin child body, and for `union`/`choose` with a barrier
arm the reference provisions it from the whole input instead.** The arms are compiled through
`pushChildScope` (`tail/child.ts`) — the first of the three provisioning routes in
`steps/CLAUDE.md` — and what a batching branch needs is a fourth thing that is not one of the three:
*the branch's own input relation as the arm's domain*, with no per-origin partition.

That framing matters because `steps/CLAUDE.md` says "do NOT add a fourth" provisioning route. This is
the case that tests the rule. The honest reading is that it is **not** a fourth route: it is the
EXISTING root-scope lowering applied to a relation that happens not to be the root — the arm body is
compiled exactly as a main-chain suffix is, over the branch's input CTE. If that turns out to be true,
the fix is a reachability fix (hand the existing lowering a different relation) rather than a new
substrate, which is the tell `steps/CLAUDE.md` asks for.

## 4. The tranches, in the order the evidence supports

**T1 — the scalar parent, and it is probably nearly free.** `values('age').union(__.min(), __.max())`
should be `[27, 35]`: each arm is a GLOBAL reducer over the scalar stream reaching the union, and
`lowerGlobalNumericReducer` / `lowerGlobalCount` (`tail/barrier.ts`) are already total over a
`ScalarStream` and already read `cardinalityOf`. So the arm does not need a child scope at all — it
needs the branch's input `ScalarStream` and one existing call. Check this first; if it holds, T1 is
"route a collapsing arm to the global reducer instead of the scalar child scope", and it converts the
largest block of currently-wrong answers.

**T2 — the element parent, collapsing arms.** The `Union.feature` case. An arm whose body is
`<element prefix>.<collapsing barrier>` compiles to ONE row over the branch's whole input. The merge
then unions a one-row arm with an N-row arm, which the variant merge already does (`mergeVariantParts`
takes pre-built parts). The open question is the CARRIED schema: a collapsed arm has no per-traverser
identity to carry, so `dropLayoutAtBarrier` applies to that arm only, and the merge must tolerate
arms whose layouts differ in that specific way. That is channel-preservation ground — read
`archive/2026-07-28-channel-preservation-refactoring-plan.md` §"Constitution for a vocabulary
migration" before starting, and expect the merge's rigid-role assertion to be the thing that fights.

**T3 — the slice/order arms.** `union(__.out().limit(1), …)` batches in the reference too
(`FilteringBarrier`), so a per-origin `limit(1)` is also wrong. Deliberately NOT gated by the
fail-closed step and NOT in `COLLAPSING_BARRIERS`, because unlike T1/T2 it is pinned the WRONG WAY by
our own tests and by no corpus scenario — so flipping it is a semantic change with no external
witness. **T3 needs an L4 pin derived from the reference by hand, before any code.**

**T4 — emission order.** Once an arm is batched, arm-major over the whole stream is CORRECT, which is
what we already emit — so T1–T3 fix the ordering for those cases for free. What remains is the
BARRIER-FREE case, where the reference is traverser-major and we are arm-major globally (filed as
outstanding-work item 21). That needs a lexicographic `(input traverser, arm_idx, arm_encounter)` key,
and the input traverser's identity is **not** available today: `arm_encounter` is the arm's own
encounter, which a fan-out arm re-mints per-origin, and the child ordinal is `ROW_NUMBER() OVER ()`
— it identifies a traverser without ordering them. So T4 needs the parent's encounter preserved as a
distinct carried role. Do T4 last, and only with an L4 pin first: **the census cannot see a pure
reorder** (`ms` is order-insensitive on the outer multiset, `ord` is telemetry) and every `union`
scenario in the corpus asserts `unordered`.

## 5. The duplication to remove while doing it

- **`GLOBAL_BARRIER_STEPS` disagrees with its own description.** It says "observes the WHOLE stream at
  once" and contains `local`, which does not — `local()` is the per-traverser SCOPING marker. It is in
  the set because the `repeat()`/`match()` gates want "not row-local", which is a second meaning. Per
  `ir/step.ts`'s own rule ("a base is a vocabulary with ONE meaning; if two consumers want different
  members, that is two bases"), this wants splitting. Not done yet because two working gates read it.
- **Three sites, three spellings of the same question.** `repeat()`'s body gate (`prefix/branch.ts`),
  `match()`'s pattern body (`prefix/match.ts`) and now the branch-arm Pass each ask "is there a
  whole-stream barrier in this body". The first two use a flat `.some(isGlobalBarrier)`; the Pass uses
  a scan that recurses through nested BRANCH arms only. Those are genuinely different questions today,
  but nothing says so — once T1/T2 land, check whether one recursion serves all three.
- **`branchValueArgs` vs `branchArmBodies`.** Two arm-extraction functions, and the difference is
  load-bearing (*which arms take part in a shape merge* vs *which bodies does this branch run* —
  TinkerPop's `getGlobalChildren`). Keep both, keep the comment that says why; do not merge them.
- **`local(...)` as the recovery route.** `local(union(…))` is correct today and is what the deferral
  message points users at. When T1/T2 land, that equivalence becomes a metamorphic law worth adding to
  `laws.ts`: `union(barrier-arm…)` over a single-traverser input ≡ `local(union(…))`.

## 6. Four things I got wrong writing this — check each before proposing a change

1. **"It's an ordering divergence."** It is a cardinality error; ordering is a symptom. Filed as an
   ordering item first, which understated it.
2. **"A one-clause change to a `ROW_NUMBER() OVER`."** Wrong by an order of magnitude — see T4.
3. **"All four branch kinds behave alike."** They do not (§1). Acting on this would have "corrected"
   a dozen tests that were already right, `coalesce` and `optional` included.
4. **"The choose predicate is an arm."** It is `branchTraversal`, not a global child, so `hasBarrier`
   never considers it. Including it cost five L3 scenarios in the first draft of the gate, every one a
   barrier in the SELECTOR (`choose(__.out().count()).option(…)`), where a barrier is an ordinary
   correlated sub-read that emits nothing.

## 7. What the fail-closed gate does and does not buy

The gate (`verifyBranchArmBarrierScope`, `ir/strategies.ts`, registered as a `verify` Pass) defers
`union`/`choose` with a COLLAPSING barrier arm. A Pass rather than an assertion at the branch lowering
sites because there are fifteen of those, and a gate placed among them is only as complete as the
enumeration.

**Two honest costs, both to be paid back by T1/T2:**

- It is **syntactic, so it cannot see input cardinality**, and it defers traversals whose answer is
  right today because the input happens to be one traverser
  (`g.V(1).values('age').union(__.constant('x'), __.V().count())`). Those are not wrong-intent tests
  and the capability is real; it is withdrawn because the compiler cannot tell that case from the
  broken one. That is fail-closed, not over-firing — but it IS a capability loss, and the tests that
  covered it are the acceptance criteria for T1.
- It withdraws the scalar-parent reducer-arm family, which `tail/scalar-arm.ts` was substantially
  built for. T1 is what restores it, correctly.

L3 is unchanged at 1623 and the census loses no executing traversal, so the conformance cost is zero;
the entire cost is in tests of traversals the corpus never asked about.
