# A branch arm's barrier observes the branch's whole input — doing it properly

**Status: T1, T2 and T3 LANDED 2026-07-31. T4 RECLASSIFIED and LANDED 2026-08-01, all four merge
families** — it is a wrong SUBSET under a downstream slice, not the ordering item it was filed as,
which also means it is pinned with multiset assertions rather than ordered ones (§T4, §6.5,
§T4-outcome). One declared corner is left; the plan is otherwise closed.
**The fail-closed gate has NOT been written** — nothing
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
**T2's outcome, and it corrected two things T1 got wrong.** The lowering half was the same
one-liner — the arm goes through the ordinary engine over the branch's ELEMENT input — but two gates
were wrong. (1) `armCollapses` must scan the WHOLE body, not the terminal step: `hasBarrier` comes from
`getStepsOfAssignableClassRecursively`, so `union(__.out().count().is(gt(0)), …)` batches, and gating on
the last step was a real 4-vs-2 row difference a committed test caught. (2) `collapsedArmProjection` is
GONE, subsumed into `layoutArmProjection`, which now resolves the merged schema per COLUMN — because
"is this arm collapsed?" has no answer for `union(__.out().count().as("x"), …)`, an arm that has lost
`bulk` and gained an alias. Asking once emitted a trailing comma where `a.bulk` resolved to nothing.
**A third piece was missing from the plan entirely:** an arm that received NO traversers must emit
nothing even though its barrier has a seed value (`count()` over empty is 0 as a main chain, but
`ChooseStep` never runs an unrouted option). `gateArmOnNonEmptyInput` (`tail/barrier.ts`) is that, and a
`V()` re-source arm is what makes it visible, since its rows do not come from the arm's input at all.
**T3's outcome.** The hand-derived pins the tranche demanded, all three confirmed and all three
changed: `union(__.out().limit(2))` 5 → 2, `union(__.out().dedup())` 6 → 4, `union(__.out().limit(1),
__.in())` 9 → 7. `dedup` is the sharpest — per-origin it was not a different window but a NO-OP, since
each vertex's own out-set is already distinct. The code was smaller than T1 or T2: for element arms
`tryCompileElementTraversal` already falls back to the root-scope fold, so a slice arm took the child
scope only because it was offered first, and asking `armBatches` before it reverses the order. The
merge needed nothing, because a root-scope arm carries the parent's layout exactly. `armBatchAdmissible`
is the gate and is NARROWER than the collapsing one — a slice arm preserves path/sack/fromV, so only
`origins` matters — and `collapsedArmAdmissible` now derives from it.
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
witness. **T3 needs an L4 pin derived from the reference by hand, before any code.** *(Done — five scenarios in
`test/L4-addendum/element-branch-child.feature`, written as COUNTS so they are order-insensitive, each
with its derivation spelled out. The child-scope guard has no pin: every spelling that would exercise
it defers today.)*

**T4 — the barrier-FREE case, and it is a WRONG SUBSET rather than a reorder.** Once an arm is
batched, arm-major over the whole stream is CORRECT, which is what we already emit — so T1–T3 fixed
the ordering for those cases for free. What remains is the barrier-free case, where the reference is
traverser-major and we are arm-major globally (filed as outstanding-work item 21). **Re-measured
2026-08-01, and the "emission order" framing this section shipped with is §6.1 happening a second
time:** put any positional consumer after the branch and the arm-major key selects a different
WINDOW, so the answer is a different multiset.

```
g.V(1,4).union(__.out(), __.in()).values('name').limit(4)
  ours      → [vadas, lop, lop, ripple]                                        (measured)
  reference → the first three results are v1's three arm outputs {vadas, josh, lop};
              the fourth is v4's first — hasBarrier false injects ONE start at a time (§1)
```

Ours omits `josh` and pulls v4's `lop` into the window. Nothing in that reading depends on
within-arm movement order, which the reference leaves implementation-defined — only on the GROUPING
by input traverser, which the class hierarchy fixes. Two consequences:

- **T4 does not need an ordered pin, correcting this section's own original claim and item 21's.** A
  multiset assertion witnesses the slice half, so an L4 pin can be written exactly as T3's five were
  (order-insensitive, derivation spelled out). An ordered pin is needed only for the residual PURE
  reorder — a barrier-free branch with no positional consumer after it — which the census still
  cannot see (`ms` is order-insensitive on the outer multiset, `ord` is telemetry) and which every
  corpus `union` scenario asserts `unordered`.
- **It is a silent wrong answer, which is the one thing the root CLAUDE.md's "correct by design, fail
  closed" rule says we do not ship.** That, not the ordering, is T4's justification.

**Exposure, measured over all 2,298 L1 traversals** (parse → `stepChain` → `armBatches` per arm +
`analyzeChain`): 96 contain `union`/`choose`; 16 have a batching arm (T1–T3 ground); 81 are entirely
barrier-free, 78 of those with multi-traverser input, and 10 of THOSE already demand an emission
encounter — **none of which is a slice after the branch** (they are `local(union(…).fold())`,
`groupCount`/`cap`, and source unions). So the corpus has ZERO witnesses, the census cannot ratchet
this, and L3 will not move. Do not read that silence as "the shape is rare": the shape is 78
traversals; it is the CONSUMER that is absent, and users write it.

**The dependency: the branch input's encounter, frozen, as its own carried role.** The key wants to
be `(input encounter, arm_idx, arm_encounter)` and the first term does not exist:

- `TraverserLayout.encounter` is ONE slot (`context/context.ts`), and each fan-out inside the arm
  re-mints it in place (`finishMove`, `prefix/movement.ts`). The result is monotone in the parent's
  value but is a RANK, and two arms rank independently over different row counts, so the parent key
  is unrecoverable from it.
- The child ordinal is `ROW_NUMBER() OVER ()` (`tail/child.ts`) — it identifies a traverser without
  ordering them, and `popChildScope` projects it away. A mid-traversal `union` does not even push a
  child scope: its arms compile over the current relation (`tryCompileElementTraversal`).

**This does not relitigate the one-encounter decision, and the discriminator has to be written down
next to the role or someone will smuggle the refused design back in.** What Stage C and
outstanding-work item 4 refused is two representations of the SAME question — a stream-level
encounter beside the layout's, both answering "what is *this* stream's emission order". A frozen copy
of an OUTER scope's order is a different question, and the layout already carries that kind of thing:
`origins` is a stack of outer-scope identity columns. The rule: **the new role is never consulted as
"this stream's order" — only as a partition/sort key at a merge or a pop.** Any consumer that would
read both it and `encounter` for the same purpose IS the refused reconciliation.

The decision T4 actually pushes on is Crux 1 of `2026-07-19-canonical-emission-order.md` ("single
running ROW_NUMBER vs composite tuple → single"). The answer is not to reopen it for a growing tuple:
it is a BOUNDED composite — one frozen copy per open branch, depth bounded by branch nesting, the
same shape `origins` already has.

**What it unlocks beyond itself — modest, and worth stating so it is not oversold.** Real: correct
slices after any barrier-free branch; §5's metamorphic law becomes assertable; `group()`'s `valOrder`
("parent encounter then child encounter", `tail/group.ts`) stops being bespoke and becomes an
instance of the composition. Partial: item 20's ordered-child-read residuals
(`aggregate('x').by(__.out().order().by('name'))`) are the same order-dies-at-`popChildScope` shape.
NOT unlocked, and deliberately not bundled: the take-first guards (`armFansOut`,
`positionArmFansOut`) need item 4's re-source encounter mint, a different primitive; a RECORD stream
carrying no encounter is a third; item 20's group-value-body bug is a SCOPE bug, not an order one.

**Scope the mint to `demandsEncounter`.** Mint the frozen role only where an encounter is already
live. Widening `computeDemandsEncounter` to every barrier-free branch would cost `movementCollapse`
and a ROW_NUMBER at every upstream movement to fix an order nothing observes — Crux 4 already decided
the final result stays unordered unless a consumer asks. Bounded cost, in one place each: the role +
its `LAYOUT_ROLE_POLICY`/barrier-policy entries, the key at `finishElementMerge` and
`mergeArmRelation` (two sites, deliberately — channel-preservation Phase 1 keeps them separate), the
`inject()` benign set, and L2 snapshot churn.

**Do NOT fail closed in the meantime.** §7 paid that price once for T1/T2 and it cost real
capability; here it would withdraw 78 corpus shapes of which nearly all are answered correctly,
because their results are unordered and nothing slices them. Pin, then fix — and note the sequencing
constraint L4 imposes: every scenario there must PASS, so the pins are written first but land in the
same commit as the fix, exactly as T3's did.

### T4's outcome (element family, 2026-08-01), and the one thing the plan above got wrong

**The substrate is `TraverserLayout.branchOrders`**, and it went in as designed: the emission order
frozen at branch entry, a STACK like `origins`, threaded through the arms as an ordinary carried
column, consumed by the merge as the leading sort key. `freezeBranchOrder` (`tail/barrier.ts`) is the
entry half and is shape-generic through `streamPayloadCols`; `enterBranch` (`prefix/branch.ts`) is the
ONE gate; `finishElementMerge` is the exit. Five L4 pins in
`test/L4-addendum/branch-traverser-major.feature`, all five red without the fix. L3 unchanged, census
unchanged except the one `ord` digest this is about — exactly the "zero corpus witnesses" the
exposure measurement predicted.

**What the plan got wrong: "only `union`/`choose` can disagree with a per-origin arm" (§1) is about
arm SCOPE, and it does not carry over to emission ORDER.** `coalesce`/`optional` are per-traverser by
class, so T1–T3 correctly left their scope alone — but our merge sorted their arms arm-major too, so
they diverged in exactly the same way, and one of the five pins is a `coalesce`. Measured before the
fix, with `order().by('name')` fixing the input sequence:
`g.V().hasLabel('person').order().by('name').coalesce(__.out('knows'), __.out('created')).values('name').limit(2)`
returned josh's arm-0 peers `[vadas, josh]` where the reference returns josh's own two rows
`[ripple, lop]`. **Reading §1 as "coalesce/optional are fine" is the trap**: it says their SCOPE is
fine. `optional`'s single-hop fast path was already correct, because a LEFT JOIN keeps the parent's
encounter rather than re-minting one.

Two smaller findings worth keeping:

- **The pop is free.** `finishElementMerge` already derives its output layout from `base` (the state
  the arms forked from) rather than from the merged arm layout, so a role the merge consumes
  disappears by construction — the only edit was to project the arms' rows through the popped schema.
- **Sequencing the gate matters more than the gate.** `enterBranch` declines on `armBatches`, which
  for `union`/`choose` is the reference's own `hasBarrier` rule (arm-major IS correct there) and for
  `coalesce`/`optional` is a conservative compiler gate: such an arm's tail can consume the column the
  merge would sort by, and a merge whose arms disagree on a rigid role fails closed. That corner keeps
  today's answer rather than a new deferral.

**The scalar/list/variant half, and the plumbing question it turned on.** Those three merges took the
same key the same day. The question was how to tell a merge that its arms carry a frozen order
without threading an argument through ~18 call sites, and the answer is `branchFork(base, armLayout)`
(`context/context.ts`): **derive it from the arms.** An arm carries exactly one more branch order than
the pre-branch state when this branch froze one, and never more than one, because a nested branch's
own merge pops its own before the arm ends. `mergeArmRelation` and `finishElementMerge` both read it
that way, and the explicit parameter the element tranche threaded is gone. The ONE family that cannot
derive it is the variant merge — a `VariantArm` is a bare `(rel, vk)` pair with no layout — so its
callers hand the fork in.

**Where the freeze goes is load-bearing: AFTER each lowerer's classify gate, never before.** The
freeze emits a projection CTE, and the shape cascade tries list → scalar → variant → element, so an
element-armed `union` reaches three lowerers that will decline before the one that answers. Freezing
at the top of those would leave a dangling CTE in every element branch. `tryLowerScalarUnion`
classifies every arm up front for exactly this reason (which also lifted a per-arm classify out of
its compile loop).

**What is left of T4.** (1) The declined `coalesce`/`optional` batching-arm corner above. (2) The
residual PURE reorder — a barrier-free branch with no positional consumer after it — which stays as
Crux 4 left it: unordered out, unordered on the wire.

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

## 6. Five things I got wrong writing this — check each before proposing a change

1. **"It's an ordering divergence."** It is a cardinality error; ordering is a symptom. Filed as an
   ordering item first, which understated it.
2. **"A one-clause change to a `ROW_NUMBER() OVER`."** Wrong by an order of magnitude — see T4.
3. **"All four branch kinds behave alike."** They do not (§1). Acting on this would have "corrected"
   a dozen tests that were already right, `coalesce` and `optional` included.
4. **"The choose predicate is an arm."** It is `branchTraversal`, not a global child, so `hasBarrier`
   never considers it. Including it cost five L3 scenarios in the first draft of the gate, every one a
   barrier in the SELECTOR (`choose(__.out().count()).option(…)`), where a barrier is an ordinary
   correlated sub-read that emits nothing.
5. **"T4 is emission order"** — added 2026-08-01, and it is #1 recurring one tranche later, in the
   section written to record #1. A wrong ORDER under a downstream slice is a wrong WINDOW, so the
   answer is a different multiset (§T4's witness). The tell that catches both: ask what a POSITIONAL
   CONSUMER downstream does with the key, not what the key looks like. It also flipped the plan for
   T4 — the pin it "needs an ordered L4 pin first" is a multiset assertion.

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
