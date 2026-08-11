# `repeat()` — the two-regime plan

**Status: APPROVED 2026-08-09.** This supersedes the RelIR build plan's Phase 3 step 4
(`docs/2026-08-01-relir-build-plan.md`), whose §4.3 Rel-level `unroll` is WITHDRAWN. Read this doc
first for anything `repeat()`-shaped; read the build plan for everything else.

**This doc is the index for the work.** Findings go HERE, not into `docs/outstanding-work.md`.

---

## 1. THE DECISION — a total function on ONE axis

> **AMENDED 2026-08-09 by measurement. The original table had a two-axis split with an OVERLAP
> cell, and preferred `Recursive` inside it. That preference is refuted — see §1a. The overlap cell
> does not exist, so the decision is simpler than the approval assumed and §3.2's differential is
> discharged by construction rather than by a test.**

`repeat()` has TWO lowerings, and which one applies is decided from the traversal, never guessed:

| | which regime | why it is the only one |
|---|---|---|
| **bounded** — a compile-time `times(n)` | **UNROLL** (IR level) | only PHASES can carry a per-iteration barrier **and** the RLE collapse |
| **unbounded** — `until()` / bare `emit()` | **`Recursive`** (the walk) | no finite n exists |
| **unbounded + a per-iteration barrier** | **refuse, clearly** | the honest wall |

**Neither regime alone is sufficient, and neither insufficiency shrinks with effort.**

- **Unroll cannot express an unbounded walk.** No finite n exists for `until(pred)` or a bare
  `emit()`. That removes reachability, transitive closure and shortest path — the things a graph
  database is for.
- **`Recursive` cannot express a per-iteration barrier, and cannot COLLAPSE.** SQLite's recursive
  term is a restricted sub-language: no aggregate, no window, and `DISTINCT`/`LIMIT`/`ORDER BY` are
  ACCEPTED while meaning something else (P3). SQLite decides this; no amount of lowering work moves
  it. The second half of that sentence is §1a and is the amendment.

### Why each row is what it is

- **bounded → unroll.** Phase k's relation IS the frontier at iteration k, which is what makes a
  phase-local barrier equal a per-iteration one — and what makes the frontier an ordinary relation a
  `GROUP BY id, SUM(bulk)` may collapse. `times($x)` is the one exception the root `CLAUDE.md`
  names: the unroll reduces the parameter to a compile-time constant at the last responsible moment.
- **unbounded → `Recursive`.** The only regime that can express it.
- **unbounded + barrier → refuse.** State the wall in the message; do not approximate.

## 1a. THE MEASUREMENT THAT AMENDED §1 — a walk cannot carry a multiset

The original §1 preferred `Recursive` for a bounded barrier-free body, on two grounds: statement
text O(1) in depth rather than O(n), and `times($x)` staying a bind. **Both are true and both are
outweighed, by a number the corpus itself states.**

`map/Count.feature`:

```
g.V().repeat(__.out()).times(8).count()      # the grateful graph, 808 vertices
  → 2 505 037 961 767 380
```

Two and a half QUADRILLION traversers over 808 vertices. That number exists only because the
frontier at iteration k is a MULTISET the reducer SUMS — a plan emitting one row per traverser
cannot produce it in any amount of time, at any level of query-planner cleverness. What produces it
is `GROUP BY id, SUM(bulk)` per hop, i.e. the RLE collapse the `bulk` channel exists for.

**That collapse is an AGGREGATE, and SQLite forbids an aggregate in a recursive term.** It is the
same wall as a per-iteration barrier — `src/rel/recursive.ts`'s `BARRIER_IN_TERM` refuses the exact
node — seen from the COST side rather than the legality side.

> **TinkerPop refuses the same family, for an unrelated reason — independent corroboration of the
> split, found while closing §8.6.** `StandardVerificationStrategy` throws on a `ReducingBarrierStep`
> or `SupplyingBarrierStep` sitting directly in a `repeat()`'s global child:
> *"The parent of a reducing/supplying barrier can not be repeat()-step"*
> (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/verification/StandardVerificationStrategy.java:78-81`).
> So upstream rules out `repeat(__.out().count())` on SEMANTIC grounds, having nothing to do with
> SQLite, while we rule out the same shape because a recursive term cannot hold the node. Two
> independent derivations reaching one boundary is the strongest evidence this plan has that the
> boundary is real rather than an artefact of our substrate.
>
> ⚠️ **The sets are not identical, and the difference is exactly why the BOUNDED regime exists.**
> Upstream's check names only REDUCING/SUPPLYING barriers, so a FILTERING barrier — `limit()`,
> `order()`, `dedup()` — stays legal in a body, and `g.V().repeat(__.both().limit(1)).times(2)` is a
> corpus scenario expecting an answer. `BARRIER_IN_TERM` refuses those too (SQLite accepts them and
> applies them to the WHOLE walk, which is silently not what the author wrote), which is precisely the
> population the IR unroll takes. So the recursive regime cannot
collapse, at any depth, ever; and an unrolled phase is an ordinary relation that collapses like any
other movement, which `ir/analyze.ts`'s `collapseSafe` already decides for a flat chain (it returns
`false` on sight of a `repeat`, and after the unroll there is no `repeat` to see).

Three consequences, all of them simplifications:

1. **The overlap cell is gone.** Bounded goes to phases because only phases collapse; unbounded goes
   to the walk because only a walk has no finite n. Nothing is legal both ways.
2. **§3.2's differential is discharged by construction.** It existed to stop two regimes disagreeing
   over a population that both could serve. There is no such population.
3. **`unrollFixedRepeat`'s "nothing to gain" guard was wrong** and is deleted. It required the body
   to contain a barrier, reasoning that a barrier-free body "already lowers through the flat
   expansion, so unrolling it buys no capability". It buys the largest one available.

> ⚠️ **THE UNROLL CANNOT SHIP UNTIL §7's PRECONDITION LANDS.** Unrolling deletes the ROUTE by which
> legacy reached its own, more permissive collapse analysis, and the general one could not admit what
> that route did. The consequence is not a slowdown: L3 hangs.
>
> **That precondition is now ON TRUNK** — §7.4 items 2 and 3, as the two label retractions (`c75469c`).
> A dead `as()` is deleted before the analysis sees it, and a `select(labels)` feeding a `count()` is
> deleted because `count()` observes no value, so the chain reaching `collapseSafe` has no identity to
> refuse — no rule was relaxed. **The widening is now ON TRUNK too**, as §8 item 4 — every bounded
> body takes the phase regime and L3 moved 1783→1787 RelIR / 1693→1697 legacy. §8 is the live status.

The walk keeps a matching guard from the other side (`walk.ts`): a BOUNDED walk carrying nothing but
`bulk` declines, because its traversers are interchangeable and enumerating them is a choice — and
the wrong one. A walk carrying per-traverser IDENTITY (an alias bound before it, a sack, an
`origin`) has traversers no collapse may merge, so every route enumerates and this one is not worse
than the one it replaces.

**How it was found, because the method matters more than the finding.** The walk was built first and
admitted the bounded cell as §1 said it should. `mise run ci` then went from a passing L3 to a
600 s TIMEOUT — not a wrong answer, not a throw, and nothing any static gate could see. The
diagnosis came from reading what the corpus EXPECTS rather than from profiling: a scenario whose
expected result is 2.5×10¹⁵ is telling you what representation it requires. **A cost wall of this
shape reads exactly like a hang, so treat an L3 duration regression as a semantics signal.**

### Status of the amendment — the BRANCH is archived; §8 says what is on trunk

**§1 is the decision, and it is now largely implemented on trunk — §8 is the authority on which
cells, and this section is only about the abandoned BRANCH.** Both regimes are live: the bounded
unroll (§8 item 4) and the `Recursive` walk with `until` and bare `emit()` at every modulator
position (§8 item 6). What remains is `emit(pred)`, the sack fold, `bulk.ts`'s deletion and the
per-position collapse answer.

The code that FIRST implemented §1 was written as one large branch, went 12 tests red, and was
abandoned in that state; it is preserved on **`origin/repeat-two-regimes`** and nothing in the list
below reached trunk from it by merge — each piece was rebuilt, as §8 records.

> ⚠️ **THAT BRANCH IS A REFERENCE, NEVER A BASE.** Do not rebase onto it, do not cherry-pick it
> wholesale. It is 4 `wip:` commits against a `src/compiler/rel/` that has since moved (the
> named-collections work landed on top of it), and it was red on its own terms. Read it for the
> already-solved shape of a piece you are about to build, then build that piece on trunk. §8 is the
> order to do that in.
>
> The reason this warning is here rather than in a commit message: a later session inherited that
> branch as its HEAD and spent most of a day establishing which of its 14 failures were its own. The
> failure mode is not the code, it is treating an unfinished branch as ground truth.

What that branch contains, and what has since reached trunk:

- `walk.ts` — the `Recursive` regime (§3.1), plus the interchangeable-frontier decline above. It
  covers the UNBOUNDED forms (`until`, `emit`, `emit(pred)`, a sack folded through the walk) and is
  independent of the unroll widening. **Rebuilt on trunk through §8 item 6 as far as bare `emit()`;
  read the branch only for `emit(pred)` and the sack fold, the two cells still outstanding.**
- the `loops` CHANNEL role (`src/channels.ts`) and the seam's `chain` arm (§3.1's open question,
  settled below).
- **two real bugs found by the widening, both independent of it:**
  - `tryUnroll` refused a named `repeat("a", …)` by testing the ARGUMENT COUNT, but the front end
    splits the name off into `loopName` — so a named repeat arrived with one argument like any other
    and was being unrolled, silently dropping the loop identity `loops("a")` reads.
  - `withoutStrategies(RepeatUnrollStrategy)` did not suppress the pass. It was classified as an
    inert no-op, which was true only while our unroll and TinkerPop's strategy did not overlap.
- the `group()` collapse fix (§7.4 item 3's neighbour): `COLLECTING_CONSUMERS` treated EVERY
  `group()` as an ordered member collection; TinkerPop splits on
  `Grouping.hasBarrierInValueTraversal()`, so `by(__.count())` is a reduction and needs no emission
  order. Closes a deferral `analyze.ts` had recorded in prose.

- **`unrollFixedRepeat`'s "nothing to gain unless a barrier was blocking it" guard, deleted** — the
  widening itself, and on that branch the thing that hung L3. Its blocker is now discharged on trunk
  (the retractions), so this is §8's first real increment rather than a blocked item.

**Already extracted to trunk from that branch** (`e46234e..1fb96e8`), each verified green on BOTH
spines before push:

- the two label retractions + `ir/labels.ts` (§7.4 items 2-3). **They change ZERO answers**, measured
  rather than argued: the census changed-set is the same 92 traversals with the digest fix alone as
  with the retractions on top.
- the census answer digest, which was **miscalibrated and is why §7.2's number cannot be trusted** —
  see the warning in §7.2.

Consequences already worked through, each genuine rather than churn — the widened unroll runs ABOVE
the routing switch, so it moves both spines: seven `sql-hygiene` byte ratchets (n copies of a body is
n times the text — banked), the L2 SQL pins that assert legacy's `WITH RECURSIVE` for traversals that
no longer recurse on EITHER spine (repointed to `emit`/`simplePath()` bodies, which still walk), two
L5 ratchet entries that got BETTER (`repeat(__.both()).times(3).range(5,11)` no longer diverges
between the fast-path positions; a capability witness now executes), and one L5 GENERATOR bug the
unroll exposed: it models a `repeat()` body as shape-preserving, but
`repeat(__.has(…).inE('knows')).times(1)` ends on an EDGE — `RepeatStep` is `<S,S>` in its Java
signature and not at runtime. Fixed with a `bodyEnds` constraint on the shape lattice.

### Why unroll lives at the IR level and not in RelIR

`unrollFixedRepeat` (`src/compiler/ir/strategies.ts`) splices the body into the FLAT step chain, so
every later pass and the whole lowering see ordinary chain steps. That gives combinatorial
completeness **by construction**: every step that works anywhere works inside a repeat body, at any
depth, with no per-step work. A Rel-level replicator would be a second place that has to reproduce
the body's lowering, and would only ever cover what it had been taught.

Corollary that makes the split compound in the right direction: **the recursive regime's obligation
SHRINKS over time.** Every future step family is inherited free by the unrolled route, so
`Recursive` only ever has to grow for the movement/filter vocabulary a walk actually needs.

---

## 2. ✅ What has LANDED (trunk, 2026-08-09)

Ordered as committed. All green on `mise run ci` + pushed.

1. **`3fc0443` — P1 legality is a structural analysis.** `src/rel/block.ts` states the emitter's
   fusion rules ONCE (`Slots`, `NEEDS_SUBQUERY` total over `RelKind`, `spliceable`) plus
   `shapeOf`/`fromTree`. `emit.ts`'s `Block` IS a `Slots` and its arms read the shared table, so the
   checker cannot admit a plan the emitter then wraps. **A join TREE is top level**, so
   `project(join(self, edges))` — the canonical one-hop body — is admitted where it used to say "run
   flatten first". Two defects fell out: a `Materialize` over the walk reference is refused by name,
   and `name` may no longer hoist ANY subtree holding a `SelfRef` (`freeRelIds` does not forbid it —
   a `SelfRef` names its walk positionally, so such a subtree looked bindable).
2. **`b6dfe13` — the barrier laws follow the SELECT, not the node children.** `fusedInto` (same
   walk, one more field on the shape). Measured on bun:sqlite 3.53.0: an aggregate, a window
   function, a `DISTINCT` and an `ORDER BY … LIMIT` are each LEGAL inside a derived table joined into
   a recursive term, while the same two fused into the term are `recursive aggregate queries not
   supported` / `cannot use window functions in recursive queries`. A node-children walk refused all
   four — i.e. any repeat body joining against a deduped, ranked or capped relation.
3. **`84b281c` — the anti-drift gate.** 22 shapes; `fromTree`'s answer must equal the aliases the
   emitted SQL actually puts in its top-level FROM. Verified to bite (dropping `mayFuse` from
   `sideShape` fails it) — and it took a LEFT/INNER pair over a filtered right side to make the rule
   observable at all.
4. **`6e0668a` — the Rel-level `unroll` withdrawn.** Restore point for the deleted code: **`9e0e307`**
   (`src/rel/passes/unroll.ts` + `refresh` + the `RelOverride` identity widening + `selfRef`).
   `minter` stays in `src/rel/mint.ts` — `seek` uses it.
5. **`2b4fd3c` — `freeRelIds` visits each node once.** `g.V().both()×20.count()` compiled in
   2 660 ms and `×24` in 50 s, while the emitted SQL stayed LINEAR (~310 bytes per hop). `both()` is a
   `Union` of two arms reading the SAME input, so a k-hop chain is a DAG with 2^k paths and the walk
   had no visited-guard; `name` calls it once per candidate node. After: k=20 7 ms, k=80 36 ms.
   Guarded in `test/performance.test.ts` — the one wall-clock assertion in a file that otherwise
   pins plan SHAPES, because the defect was time and nothing else.
6. **`91beb5d` — the IR unroll widened.** Body NORMALIZED before splicing (`childSteps`, injected),
   which retires the pass-order coupling that excluded every modulator host. `UNROLLABLE_BARRIERS`
   gains the slice family (`limit`, `range`) and `order`, each with its own argument and its own
   identity pin in `test/compiler/repeat-unroll-boundary.exec.test.ts`. `MAX_UNROLLED_STEPS = 100`,
   from the TEXT measurement (~1 KB/step worst case, ~300 b/step typical, 100 KB DO cap).
   **L3 1763 → 1775 (RelIR) and 1681 → 1692 (legacy)** — this pass is above the routing switch, so
   both floors move; neither shed a name. Census re-recorded, +6 (1063 → 1069).
7. **`f5b1951` — the recursive-term laws became ONE answer for TWO callers.** The four closures
   inside `check` (`BARRIER_IN_TERM`, `recursiveTerm`, `topLevelSelf`, `fencedSelf`) are
   `recursiveViolation` in `src/rel/recursive.ts`, returning the message or `undefined`. `check`
   throws it; the LOWERING declines on it. A second copy in the lowering would drift silently in the
   dangerous direction — the lowering admits, `check` throws, and the failure reads as a
   `rel-sweep` violation whose cause is a rule spelled twice. Messages byte-identical.

---

## 3. 🚧 WHAT IS LEFT — in order

### 3.1 The `Recursive` regime — routing `repeat()`'s body through RelIR lowering

**This is the gate.** `repeat` is 40 of the 485 corpus traversals the route ANSWERS but RelIR
declines, and it is the only family whose absence disqualifies the server.

Shape of the work — a NEW module in `src/compiler/rel/` plus a minimal dispatch hook, agreed with the
other lane (see §5):

- A `repeat` arm in `elementTail` (`src/compiler/rel/lower.ts`), beside the existing `union`/`choose`
  arms. The body-lowering primitive already exists: `continueAs(input, framing, body, 0, …)` lowers a
  chain against a given input relation — for a walk, that input is the `SelfRef`.
- An element relation's row shape is `elementCols(channels)` = `id` + carried channel columns, and a
  `Recursive`'s seed and step types must be IDENTICAL, so the walk's header is that shape plus
  whatever the depth predicate needs.
- **`until()`/`emit()` predicates MUST route through `childPredicate`** (lower.ts, the other lane's
  new single predicate answer — filter-only conjunction / correlated EXISTS / value-compare,
  negation included). Do not grow a copy.
- **Negation must be NULL-safe**: `notProduced(pred)` (`build.ts`), never `{unary:'not'}`. `NOT NULL`
  is NULL, and TinkerPop KEEPS a traverser whose body produced nothing.
- **Productivity is its own conjunct**: a value-compare body needs `ChildValue.present` ANDed in.

**SETTLED — the depth is a `loops` CHANNEL, and the cheap answer does not work.** The open question
was channel-vs-plain-column. A plain extra column in the walk header is not merely less general, it
is unbuildable: the body's own projections declare `elementCols`, so anything not carried as a
channel is projected away at the FIRST hop, and the `loops + 1` bump then has nothing to read —
`col(self, 'loops')` is out of scope by the time the term closes. Carrying it as a channel makes the
ordinary §3.5 preservation contract do the work, and it is the same fact `Traverser.loops()` names,
so `loops()`, `until(__.loops().is(n))` and a `by(__.loops())` fall out of one mechanism.

Cost to the channel core was one role and five total-table entries, all additive: merge `identical`
(a fork inside a body cannot rebind the counter), barrier `drop` (`RepeatEndStep` calls
`resetLoops()` on everything it emits), group `undefined` (a grouping across depths would take the
counter from an arbitrary member — which is also what switches the movement collapse off inside a
body, correctly), row-unique `false`, and a `ROLE_ORDER` slot. `obligations.ts` needed NOTHING: every
obligation is already driven off the role tables.

The seam grew one arm, `chain(input, framing, body, aliases)` — the fold's own re-entry. It is not a
FOURTH way to consume a child body; it is the mechanism `rows` is already built from (`rows` = this
plus an origin mint plus a survival check), and the walk cannot go through `rows` because its input
is the walk's own `SelfRef` and there is no host row to name an origin from.

### 3.2 ~~The differential over the overlap cell~~ — WITHDRAWN, §1a (conditional on §7)

The approval required it because bounded + barrier-free bodies were legal BOTH ways. §1a measures
that they are not: a bounded body must reach a regime that can collapse, and the walk cannot. With
no overlap population there is nothing for a differential to compare, so this is discharged rather
than deferred. What replaces it is the guard on each side — the unroll takes every bounded run it
can express, and `walk.ts` declines a bounded walk over an interchangeable frontier.

**This withdrawal inherits §7's precondition.** It holds only while the bounded cell actually reaches
the phase-wise regime. If §7 does not land and bounded repeats stay with legacy, both regimes serve
that population again and this differential is owed again with it.

### 3.3 Widen the unrolled body set further

The trigger gate is right (`unroll only when it BUYS something` — a barrier-free body stays on the
recursive path, so legacy churn stays zero). What is left is the ADMITTED set, one name at a time
with its own argument and its own identity pin:

- **`groupCount`/`group`/`aggregate`** — the 29-scenario cluster
  (`repeat(__.out().group('a').by('name').by(__.count())).times(2).cap('a')`). Side-effect labelled
  forms need an argument about accumulation ACROSS phases, which is not the stateless argument the
  landed names use.
- **`tail`, `sample`, `skip`** — each still refused; `sample` has no stable position, `tail` reads the
  order backwards. Both are expressible once unrolled; neither has been argued.
- **The non-barrier half of the allow-list** (`values`, `where`, `select`, `local`, …). Today a body
  containing one declines even though the spliced chain would compile. The allow-list is the
  accidental model — the transformation's validity is a property of `repeat`, not of the body's step
  names — so the end state is a DENY-list of exactly `loops()` (recursively), a named
  `repeat('a', …)`, `emit()` and `until()`. Moving to it needs the differential in §3.2 first.

### 3.4 Refusals that must stay refusals

`loops()` anywhere inside the body (recursively, including nested bodies), a named
`repeat('a', …)`, `emit()`, `until()` — the unrolled chain has no loop identity to attach them to.
Approximating any of them is the failure mode `RepeatUnrollStrategy`'s own comment warns about.

### 3.5 The `times($x)` parameter exception

Unrolling forces a parameter to a compile-time value — the ONE early-reduction exception the root
`CLAUDE.md` names. It is now reachable by more traversals. Two consequences to handle when §3.1
lands: a parameterised `times` should PREFER the `Recursive` regime (where it stays a bind), and the
unroll should only claim it when no other regime can.

---

## 4. The instruments this work answers to

- `mise run ci` — contains L1–L5, the census and every static gate. Do not re-run its parts beside it.
- **`mise run test:legacy-spine` EVERY time this pass changes.** `unrollFixedRepeat` runs ABOVE the
  routing switch, so it moves legacy's answers too — `ci` does not contain that differential.
- `mise run census-record` when coverage moves, with the reason in the commit message.
- `mise run L3:rel-only` — the cut measurement. Read it per increment, not as a proxy.

---

## 5. Lane split (concurrent session, agreed)

- **This lane:** `src/rel/**`, plus Phase 3 step 3 in `src/compiler/rel/` — a NEW walk module and a
  minimal dispatch hook. Rebase before every push.
- **Other lane:** `src/compiler/rel/**` — currently the Phase 2 filter family, next `local`/`map`/
  `flatMap` (the per-parent child host). **We meet at `local(...)` inside a `repeat()` body** — shout
  before going near it.
- Their landed helpers to reuse rather than copy: `childPredicate`, `notProduced`,
  `ChildValue.present`, `child.rows(...)` (the `origin` channel), `groupReduced` as the worked
  per-parent aggregation example.

---

## 6. Facts that cost a measurement — do not re-derive

- **A join tree is top level.** `FROM w INNER JOIN edges e`, the same with sides swapped, EITHER side
  of a `LEFT JOIN`, a cross join, nested joins, and a `w`-correlated `EXISTS` all return `1,2,3,4`
  over a 3-edge chain. `circular reference: w` for exactly two shapes: the walk behind a derived
  table, and the walk referenced ONLY from a correlated scalar.
- **A barrier inside a joined DERIVED TABLE is legal in a recursive term.** Aggregate, window,
  `DISTINCT` and `ORDER BY … LIMIT` all measured legal; the same aggregate/window FUSED into the term
  are refused by name.
- **SQL text per spliced step:** ~300 bytes for a movement or `dedup` body, ~1 KB for an
  `order().by(k)` body. DO caps a statement at 100 KB.
- **Compile cost is LINEAR in chain length** — since `2b4fd3c`. It was not; if it looks superlinear
  again, look for an un-memoised DAG walk before anything else.
- **A `Recursive` TERM IS A COMPOUND, and `both()` is expressible only that way.** Measured,
  bun:sqlite 3.53.0: `seed UNION ALL <arm1> UNION ALL <arm2>`, each arm referencing the walk exactly
  once, returns the right rows; the SAME two arms behind a derived table are `circular reference: w`.
  The emitter already renders a `Union` as unparenthesised select-CORES, so it needs no change — what
  needs changing is that "exactly once" and "at the top level of FROM" become questions about an ARM
  (`recursiveViolation`). ✅ **BUILT** — `recursiveViolation` asks per arm and `walk.ts` distributes the
  loop-counter bump over the arms (Calcite's `ProjectSetOpTransposeRule`), which was the exact trigger
  named here. Verified bulk-independently, since the two regimes hold the same multiset in different
  representations: `repeat(both()).until(loops().is(n)).count()` equals `times(n).count()` at depths
  1/2/3 (3, 7, 17) and a SELF-LOOP counts 2. Still declining: a body where the union is not the top
  node, e.g. `bothE().inV()`, which needs the same distribution through a JOIN.
  **Two further arm laws, measured while building it:**
  - **Every arm must itself be recursive.** `SELECT 1 UNION ALL SELECT x FROM w UNION ALL SELECT 9` is
    `circular reference: w` — a non-recursive arm in the recursive position is refused, so "exactly
    once" is per arm in both directions, not merely an upper bound.
  - **Only `UNION ALL` splits.** A compound `UNION` dedups across the WHOLE walk rather than within an
    iteration — P3's category, accepted by SQLite and silently answering a set where the semantics are
    a multiset — so `recursiveViolation` refuses it by name.
- **A body that registers a NAMED SIDE EFFECT must decline, and the test is the registration.**
  `repeat(__.out().group('a').by('name')).times(2).cap('a')` puts a relation from inside the term
  into chain-global state, and `cap()` reads it from OUTSIDE the walk — `circular reference` to
  SQLite, "SelfRef is legal only in its Recursive step" to `check`, i.e. a THROW from where legacy
  answers. Declining on `ctx.collections` having grown refuses every side-effect form at once,
  including ones not yet invented; a list of step names would not.
- **`unrollFixedRepeat` is TinkerPop's `RepeatUnrollStrategy`, widened deliberately.** Upstream's
  `ALLOWED_STEP_CLASSES` admits movement + `has()` and NO barrier, because its concern is laziness
  under arbitrary providers. Ours is set-at-a-time by construction, so "the whole frontier at
  iteration k" is what phase k's relation IS — the very property `RepeatStep.standardAlgorithm` has
  to special-case to get. That is the licence, and it is per-barrier.

---

## 7. THE COLLAPSE AUTHORITY — one, not two (the big change)

**Status: items 2 and 3 LANDED on trunk (`c75469c`); items 1 and 4 not started.** That is enough to
discharge the bounded cell's precondition — the identity the general analysis refused is now deleted
before it sees it — so §8's increments can proceed while the per-position rewrite (item 1) and
`bulk.ts`'s deletion (item 4) remain open. The original framing follows, still accurate about the
finding. Scope of what is LEFT is large and the
direction is not in doubt — both references model it the way this section proposes, and neither
models it the way we do today.**

### 7.1 The finding

There are TWO collapse analyses in this compiler, and they disagree:

| | where | shape | admits |
|---|---|---|---|
| `collapseSafe` | `src/compiler/ir/analyze.ts` | ONE boolean for the WHOLE chain | movement/filter prefix + a reducer/`groupCount` terminal |
| `suffixBulkSafe` / `bulkPlan` | `src/compiler/steps/tail/bulk.ts` | legacy's `repeat()`-specific suffix rule | the above **plus** `as(labels)`/`select(labels)` under a `count()` terminal |

Legacy's repeat bulk path routes AROUND the general analysis: it collapses the walk's own hops
itself, then hands a `(id, bulk)` frontier to the generic tail with `movementCollapse` FORCED ON.
That is why `g.V().repeat(__.out()).times(5).as("a").out("writtenBy").as("b").select("a","b").count()`
— 24 309 134 024 traversers over the grateful graph — answers today at all.

Unrolling the repeat deletes that route. The general analysis then refuses the collapse, and the
plan enumerates. **Measured: L3 goes from passing to a hang** (bun pinned at ~100% CPU, no output;
`ci-7`/`ci-9` this session).

### 7.2 Why the obvious fix is WRONG — measured, not predicted

Relaxing `collapseSafe` to admit `as`/`select` under a `count()` terminal was tried and REFUTED. The
ARGUMENT below is sound and is what settles it; one of the two numbers originally cited is not.

- `test/compiler/analyze.exec.test.ts` pinned `g.V().as("a").out().count()` → `collapseSafe: false`,
  with the reason in the test name: *"as() carries identity"*. **That pin has since MOVED, and not by
  relaxation:** the label is never read, so `retractUnreadAlias` deletes it and the chain reaching this
  analysis is `V().out().count()`, which is `true`. What the assertion was protecting is now pinned by
  the two shapes where an `as()` genuinely IS read — a later `select` of it, and a predicate operand
  naming it — both still `false`.
- ⚠️ **"52 executing traversals changed their answer" IS NOT TRUSTWORTHY, and the reason matters more
  than the number.** It came from the census answer digest, which folded `bulk` in PER ROW under a
  comment claiming it denoted the traverser multiset. It did not: the same multiset emitted as four
  `bulk`-1 rows and as `(a,1),(b,3)` hashed differently, so **every traversal that merely started
  collapsing reported a changed answer** — by the one instrument §7.5 names as THE gate for this work.
  Fixed on trunk (`040212d`, `test/support/multiset.ts`, now shared with L5's oracle, which had it
  right all along). Anyone re-deriving this decision must re-measure.

The refutation stands on its own without that number, because the reason is structural and §7.3 states
it: the safety is POSITIONAL, and a chain-global boolean cannot say "safe here, unsafe there".

The reason is POSITIONAL and a chain-global boolean cannot express it. In legacy's bulk path the
labels are bound **after** the collapse, on a frontier of DISTINCT ids, where a label is well-defined
per row. In the general prefix an `as()` may be bound **before** a collapse that then merges rows
carrying different label values. Same steps, same terminal, opposite safety — decided by WHERE the
collapse sits relative to the binding.

### 7.3 The structural answer, and it is what both references already do

**Collapse-safety is a property of a POSITION and the state carried there — not of a chain.**

**TinkerPop decides it per traverser, by `equals`.** Bulking merges two traversers exactly when they
are equal, and which state participates in equality is a property of the traverser CLASS, chosen from
the traversal's requirements. The class names are the carried-state list:

- `B_O_Traverser.equals` — object and future only, so two traversers on the same element MERGE
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/B_O_Traverser.java:70`).
- `B_LP_O_S_SE_SL_Traverser.equals` — `super.equals(other) && other.path.equals(this.path)`, and the
  path holds the `as()` bindings, so two traversers with different labels DO NOT merge
  (`.../B_LP_O_S_SE_SL_Traverser.java:117`).
- and the fail-closed case is already ours: `hashCode` returns
  `carriesUnmergeableSack() ? System.identityHashCode(this) : …` (`ibid.:114`) — an unmergeable sack
  can never merge with anything, which is exactly `CHANNEL_GROUP_POLICY`'s `'undefined'`.

**Calcite decides it per RelNode, as METADATA.** Collation, uniqueness and row count are computed for
a node through `RelMetadataQuery` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMetadataQuery.java`,
with `RelMdCollation.java` / `RelMdColumnUniqueness.java`), never as a query-global flag. And whether
an aggregate may be computed in PARTS and combined — precisely "may I collapse and then re-sum" — is
declared per function by `SqlSplittableAggFunction`, whose own javadoc is the statement of our
problem: *"Aggregate function that can be split into partial aggregates. For example, COUNT(x) can be
split into COUNT(x) on subsets followed by SUM to combine those counts"*
(`vendor/calcite/core/src/main/java/org/apache/calcite/sql/SqlSplittableAggFunction.java:42-48`).

**We already model it correctly on ONE side.** RelIR's movement arm asks the question per node, of
the channels carried AT that node — `ctx.collapse && !encounterOf(rel.channels) && groupableChannels(rel.channels)`
(`src/compiler/rel/lower.ts`) — and `channels.ts`'s `CHANNEL_GROUP_POLICY` is the per-role table that
answers it. The chain-global boolean is the LEGACY shape, and `collapseSafe` is the last place a
whole-chain answer stands in for a per-position one.

### 7.4 What lands

1. **Make the per-position answer the only one.** A collapse is legal at a node when every channel
   carried there has a defined answer under grouping — which `groupableChannels` already decides.
   `collapseSafe` stops being a chain verdict and becomes, at most, a seeding hint.
2. ✅ **LANDED (`c75469c`) — an alias that nothing reads is not carried.** `retractUnreadAlias`, a
   `simplify` Pass. This is `PathRetractionStrategy`, which we listed as a no-op while performing none
   of it; it now genuinely fires and `withoutStrategies` genuinely suppresses it.
3. ✅ **LANDED (`c75469c`) — a `count()` terminal makes the traverser's VALUE unobservable.** Stated as
   a REWRITE rather than as a suffix pattern: `retractUnobservedSelect` deletes the `select(labels)`,
   which is what "unobservable" means operationally. `ir/labels.ts` is the one authority for who binds
   a label and who reads one.
   Four rules each cost a measurement — see that module and `test/compiler/passes.exec.test.ts`:
   removal is ROOT-only (liveness is a whole-traversal property); a BARRIER between bind and read
   un-binds it; a label can be spelled INSIDE a string (`math('b + a')`); a `match()` pattern's
   variables are READS of the enclosing scope.
4. **Delete `suffixBulkSafe`/`bulkPlan`'s copy.** One authority. The `edges` ratchet should fall.
   ⚠️ **Measured, and it changes when this is safe:** `bulk.ts` is ALREADY unreachable for every shape
   its own tests exercise once the unroll is widened — `unrollFixedRepeat` splices the `repeat` away in
   canonicalize, so `bulkPlan`'s `findIndex(s => s.name === 'repeat' && s.repeatRegion)` finds nothing.
   Its one remaining exclusive route is `times(n)` beyond what `MAX_UNROLLED_STEPS` admits (n > 100 for
   a one-step body), where `bulkPlan` has no cap at all.
   ⚠️ **This bullet used to say "delete it together with a per-body-step BYTE budget, or the deletion
   is a silent narrowing at depth". Both halves were wrong.** Nothing about it is silent: past the cap
   `tryUnroll` declines at COMPILE time, and a statement over the DO's 100 KB cap is a loud error
   there — while `test:cf-limits` already asserts that wall on Bun, which is the only genuinely silent
   direction (dev/prod divergence). And the budget is not missing: `MAX_UNROLLED_STEPS = 100` IS the
   byte budget, derived as 100 KB ÷ the ~1 KB worst-case per-step cost.
   So the deletion does NOT depend on the budget. It narrows `times(n > 100)` to a clear deferral,
   and that is the whole cost. **The budget is a separate improvement, and the measurement says it is
   worth more than the cap suggests:** the 1 KB figure is an `order().by(k)` body, while a MOVEMENT
   body unrolls at ~140 bytes/step (measured: `times(99)` is 13,824 bytes of SQL, `times(50)` 7,307).
   Charging a body its own per-step cost instead of the worst case would take a movement body from
   100 steps to roughly 700 before the same 100 KB is spent — shrinking the narrowing rather than
   being what makes the deletion safe.

### 7.5 The instruments that must stay green

The census answer-change gate is the one that already caught this once, so it is the gate, not a
formality: **no executing traversal may change its answer on either spine.** Plus `test:perturbed`
(order-fragility), the L3 floor, and — because a cost wall here reads as a hang rather than a failure
— **an L3 wall-clock that stays in its normal band.**

⚠️ **The gate itself was wrong until `040212d`, and that is the cautionary half of this section.** Its
digest was not a multiset (see §7.2), so it fired on any collapse widening and its verdicts were not
evidence. Two consequences for anyone using it here:

- **`n` (the row count) legitimately moves under a collapse and is deliberately NOT gated**; `ms` is
  what the answer gate reads. A collapse turning 4 rows into `(a,1),(b,3)` is the same answer.
- **`mise run test:legacy-spine` is not optional for this work and `ci` does not contain it.** Every
  pass in §8 runs ABOVE the routing switch, so it moves legacy's answers too. On the extraction it
  caught two pins `ci` structurally could not: a `relirAhead` subject whose label had gone dead, and an
  assertion naming one spine's spelling of the collapse.

---

## 8. HOW THIS SHIPS — one pushable increment at a time

**This section overrides the ordering implied by §3.** §3 is still the right decomposition of the
PROBLEM; it is the wrong decomposition of the WORK, because it describes a destination rather than a
sequence of green trunks. The first attempt at this built the whole of §1 on a branch, went 12 tests
red, and was abandoned — and the cost was not the code, it was that no intermediate state was ever
provably good, so nothing could be salvaged without re-measuring everything.

### The rule

**Every increment is: smallest change that compiles → `mise run ci` → `mise run test:legacy-spine` →
commit → push to trunk. Before starting the next one.** If an increment cannot be made green on its
own, it is not an increment — split it again, or put a decline in front of it so the new code is
unreachable until the piece that needs it lands.

Two techniques make pieces smaller than they look, and both are already used here:

- **Land the mechanism DECLINING everything, then admit shapes one at a time.** A new module that
  always returns `null` is green by construction and reviewable on its own; each admitted shape after
  it is a small diff with its own argument and its own pin. This is how the unroll's
  `UNROLLABLE_BARRIERS` grew (`dedup`, then the slice family, then `order`).
- **Land a rewrite that makes the hard case disappear before landing the hard case.** The retractions
  are exactly this: they were not "part of the unroll", they were the thing that made the unroll's
  blocker not exist. Look for that shape first — it is usually smaller than the feature.

### The order, with what makes each one independently green

Items 1–3 are on trunk. Each remaining item is a reference-read from `origin/repeat-two-regimes`
followed by a build ON TRUNK — never a cherry-pick of that branch's commits, which are against a
moved `src/compiler/rel/`.

1. ✅ **LANDED — `tryUnroll` reads `loopName`, not the argument count.** A named `repeat("a", …)` arrives
   with ONE argument because the front end splits the name onto `loopName`, so the arity test never
   fired once and a named repeat WAS being unrolled — silently dropping the loop identity `loops("a")`
   reads. Measured before the fix: `g.V().repeat("a", __.out().dedup()).times(2)` normalized to
   `V.out.dedup.out.dedup`, byte-identical to the unnamed form.
   The test that should have caught it was named *"emit, until and a named loop all decline"* and its
   list contained only `emit` and `until` — **a pin whose name over-claimed its own body**, which is
   worth more than the fix: when a refusal is asserted through a downstream throw, also pin the
   PROPERTY (here, that the `repeat` step survives normalization), because a throw can come from
   anywhere.
2. ✅ **LANDED — `withoutStrategies(RepeatUnrollStrategy)` suppresses the STRATEGY, not the widening.**
   This increment's wording above was "must suppress the pass", and that is **too strong** — the
   reference says so, and the corpus would have gone red on it. `ALLOWED_STEP_CLASSES` is movement +
   `HasStep` + a nested `RepeatStep`, with NO barrier
   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/RepeatUnrollStrategy.java:71-77`).
   So our pass does two things and only ONE of them is that strategy: a **barrier-free** body is the
   transformation upstream performs (suppressible, and free — such a body already lowers through the
   flat expansion), while a **barrier** body is our widening, which upstream refuses and which for us
   is the only route that EXPRESSES the body. Suppressing it there converts a traversal we answer into
   a throw: `g.withoutStrategies(RepeatUnrollStrategy).V().repeat(both().limit(1)).times(2)` is a
   corpus scenario expecting a count of 1, and `RepeatUnrollStrategy.feature` states the principle in
   its own words — *"this traversal is not expected to be unrolled by the strategy but should have
   consistent semantics compared to traversal without the strategy applied"*. Declining an input we can
   serve, to honour a request about a strategy that never touched the body, is the fail-closed rule read
   backwards. The admitted set is spelled as the DIFFERENCE (`unrollableBodyStep` minus
   `UNROLLABLE_BARRIERS`), so it cannot drift from upstream's as either grows.
   **Two facts that cost more than the fix:**
   - **The suppression is a mark on the STEP (`IRStep.unrollSuppressed`), not a flag read where the
     pass runs.** Forced, not stylistic: a nested body is normalized LATER and in ISOLATION —
     `normalize` passes `EMPTY_STRATEGY_USE` by construction — so a root-only consult honours the
     request at the top level and silently ignores it inside `union(__.repeat(__.out()).times(2))`.
     `withoutStrategies` configures the traversal SOURCE, so it holds at every depth or it is a lie.
     The marking recursion is identity-preserving for `canonicalizeConnectives`' measured reason: an
     arg holding no `repeat` keeps its raw PARSE TREE, which `traversal-param` needs for `tree.accept`.
   - **It is behaviour-neutral TODAY by construction**, which is what made it green on its own: the set
     it suppresses is exactly the set `tryUnroll` already declines for its separate "nothing to gain"
     reason. It becomes load-bearing at increment 4, which deletes that guard — so this is the guard
     that must exist FIRST, or the widening makes `withoutStrategies` a lie for movement bodies. With
     no behavioural difference to assert, the pins are PROPERTIES (the mark at depth, the parse-tree
     preservation, and a barrier body still unrolling under suppression) — the lesson increment 1 paid
     for. Measured green: L3 1783 RelIR / 1693 legacy and the census 1208, all unchanged.
3. ✅ **LANDED — the `group()` collapse fix.** `COLLECTING_CONSUMERS` treated every `group()` as an
   ordered member collection, while TinkerPop first splits on
   `Grouping.hasBarrierInValueTraversal()`. The archived implementation's “any barrier means
   order-free” was too broad: `FoldStep` is itself a barrier and its `addAll` observes member order.
   Calcite supplied the missing second question — `SqlAggFunction.requiresGroupOrder()` is per
   aggregate — so only a global numeric reducer/count at the observable tail drops the encounter.
   Collapse is narrower again: only `count()` is admitted, matching
   `SqlSplittableAggFunction.CountSplitter`'s COUNT-over-partitions then SUM contract.

   The archived branch's broken test (`branch.exec.test.ts`, "a uniform-element branch composes as a
   child-body value at every position", bisected to `eab7822`) was a test-boundary defect: removing
   the unnecessary encounter let RelIR claim the query and return its canonical framed Map, while the
   assertion read legacy's internal `gk`/`gv` rows. It now asserts the public framed Map on either
   spine. `test:perturbed` kept the exact same ten failure names as the pre-increment SHA; L3 stayed
   1783/1693 and the census stayed 1208.
4. ✅ **LANDED — widen the unroll by deleting the "nothing to gain unless a barrier was blocking it"
   guard.** Every bounded body now takes the phase regime; `withoutStrategies(RepeatUnrollStrategy)`
   still suppresses exactly upstream's barrier-free subset. The generic per-phase collapse replaced
   the repeat-specific SQL spelling without changing legacy production code, so the affected L2 pins
   now assert shared structure rather than a spine's private spelling. Measured: L3 moved
   1783→1787 RelIR and 1693→1697 legacy, with no regressions; the census gained four executing
   traversals and RelIR coverage moved 1208→1232. One existing unordered `range()` scenario changed
   digest on BOTH spines; TinkerPop specifies only membership for it, so this is not a semantic change.
   The dedicated L3 wall-clock was 35.9 s (49 pass), the full gate stayed in its normal multi-minute
   band rather than the former 600 s hang, and reverse-scan perturbation retained exactly its prior ten
   failure names. Seven SQL byte ceilings were re-recorded for the deliberately expanded phase SQL.
5. ✅ **LANDED — the `loops` channel role:** one `ChannelRole`, five policy/order entries in
   `src/channels.ts`, and the `INT NOT NULL` entry required by RelIR's newer total column-descriptor
   table. It is rigid across arms, dropped at a barrier, ordered beside the other carried state,
   undefined under grouping, and not row-unique. TinkerPop's `RepeatEndStep` increments the
   per-traverser counter and resets it on every exit; Calcite's `RelNode.getVariablesSet()` likewise
   declares carried state at the relational position where it is live. This increment remains
   behaviour-free because nothing mints the channel yet, and `obligations.ts` needs nothing because
   every obligation already reads the total role tables.
6. ✅ **LANDED — `walk.ts`, the `Recursive` regime (§3.1)**, split hardest. Every cell below is on
   trunk. The two gaps recorded at the end are NOT part of this item: they are what the walk needs to
   let the LEGACY ROUTE be deleted (the RelIR build plan's goal), not to close this plan, whose
   remaining work is items 7 and 8.
   - ✅ **LANDED — the module and `elementTail` dispatch hook, declining every shape.** The scaffold
     declares the eventual element-walk contract but mints no relation and changes no route: `null`
     still hands the whole traversal to legacy. The child fold seam and recursive machinery wait for
     the first admitted form rather than landing as unreachable speculative code.
   - ✅ **LANDED — predicate `until`, before or after `repeat`.** The walk re-enters the ordinary fold
     over its `SelfRef`, and both the expansion guard and exit filter use the shared child predicate.
     `notProduced` makes an unproductive predicate continue rather than becoming SQL's `NOT NULL`,
     and the predicate arm's `ChildValue.present` remains its own conjunct (pinned with a missing-value
     `neq`, the case that otherwise exits wrongly). Body effects, shape/channel changes, `times`,
     `emit`, named loops and path/encounter state still decline.
   - ✅ **LANDED — bare `emit()`, at all four modulator POSITIONS.** `emit()` is a constant-true
     predicate (`TrueTraversal`, `GraphTraversal.java:4460`) and `emitFirst`/`untilFirst` are
     INDEPENDENT flags, each set iff its modulator was written before `repeat`
     (`RepeatStep.java:89,100`); `doUntil`/`doEmit` fire only at the matching position (`:125-131`).
     Three positions are one filter and the fourth is not, which is a semantics fact rather than a
     lowering convenience: at a SHARED position the checks suppress each other — the head RETURNS on
     a until-first exit before the emit-first check (`:265-278`), and the emit-last check sits in the
     ELSE of the until-last check (`:339-352`) — so each output row leaves once. **`until` BEFORE with
     `emit` AFTER is the one order where emit runs first in a traverser's journey**, so the row is
     emitted at `RepeatEndStep` and then exits at the head: it leaves TWICE, and that is a multiset
     sum (`UNION ALL`, Calcite's `RepeatUnion.all`), never a disjunction. The corpus states the same
     asymmetry as a measurement — `repeat(…).emit()` answers `java` while
     `until(constant(true)).repeat(…).emit()` answers `java, java`
     (`gremlin-test .../branch/Repeat.feature:258-284`).
     **This is new capability on BOTH spines, not a migration:** legacy throws
     *"until() together with emit() not yet supported"* for every one of the four.
   - ✅ **LANDED — a SHARED walk is one CTE (`name.ts`/`emit.ts`).** Found by the cell above and fixed
     rather than carried: `binds` asked `containsSelfRef`, but a `Recursive` node BINDS its own name,
     so every walk looked unbindable and a shared one was spelled — and computed — once per
     reference. The question is FREE reference (`hasFreeSelfRef`), which is `freeRelIds`' rule for the
     reference kind a `Col` cannot express. The emitter then hoists a bound walk's DEFINITION into
     the shared `WITH` list, the same merge a recursive ROOT already got, which is what makes the
     walk's own name load-bearing. Measured on the `UNION ALL` position above: two `WITH RECURSIVE`
     blocks became one, 1,928 → 1,482 bytes, same answer. Generic — it pays for any multiply-read
     walk, not just this one.
   - ✅ **LANDED — `emit(pred)`, at all four positions.** The position algebra above is unchanged; what
     a predicate removes is the bare form's one SIMPLIFICATION. Bare `emit`-after IS `deeper`, so it
     subsumes an `until`-after exit (literally `and(deeper, …)`) and no disjunction is spelled; with a
     predicate the two conditions are independent and `or(exit, emit)` is emitted, while the
     until-before/emit-after position stays a `UNION ALL` of the two arms. Unproductivity needs no new
     machinery: an emit predicate that produces nothing is NULL, and NULL neither passes the output
     filter nor survives the `OR`, which is `TraversalUtil.test`'s answer for an unproductive
     traversal. `emit(P)` — the raw-predicate overload, wrapped upstream in `__.filter(P)` — declines
     exactly as `until(P)` does, and `loops()` inside either modulator declines too, since the child
     seam does not lower per-traverser state. Cut 1305 → 1306.
   - ✅ **LANDED — a sack folded through the walk, and CARRIED STATE readable from any child body.**
     The fold itself needed no rule of its own: its update law is the recursive term's — read the
     previous row's column, write the folded value — which is what `loops` already does, and
     `sackMutate` builds only `Project`/`Filter`, neither refused by `BARRIER_IN_TERM`. A body that
     MINTS the channel (`sack(assign)` with no `withSack`) lengthens the channel list and the
     `sameChannels` round-trip already rejected it. Fan-out needs no split operator: TinkerPop applies
     one only where `withSack` declares it (`O_OB_S_SE_SL_Traverser.split`), and our Gremlin-string
     surface can only supply an `Operator.*`, which is a MERGE — so the reachable behaviour is the
     default copy-to-every-fan-out, which the term's projection does by construction.
     `sack(op).by(<traversal>)` is admitted, which legacy refuses: a correlated scalar subquery is a
     NESTED select, and the measured barrier table stops at every one of those.
   - ✅ **LANDED — the substrate that made the above worth doing: `childHostOf` passes the host ROW.**
     `until(__.sack().is(P))` and `until(__.loops().is(n))` were unreadable not because a walk is
     special but because the predicate seam handed a child body the traverser's VALUE and dropped its
     carried STATE — `Subject` has `rel`, and `childHostOf` built a host with no `row`. TinkerPop
     evaluates a child on a SPLIT OF THE WHOLE TRAVERSER at bulk 1 (`TraversalUtil.prepare`), which is
     why `LoopsStep`/`SackStep` are ordinary `ScalarMapStep`s over `traverser.loops()`/`sack()` and why
     the model has no "sack inside until()" case at all — legacy's `sackPred`/`sackWhereGuard`
     shape-matches are an artifact of legacy, not the semantics. Calcite frames the identical thing as
     the correlating row being bound and the inner plan referencing its fields (`RexCorrelVariable`).
     So: one arm over a channel ROLE (`CARRIED_READ`), not a reader per step. It applies wherever a
     child body is lowered, not only in a walk — `where(__.sack().is(P))` on an ordinary chain works
     by the same code. Census 1232 → 1233 (one traversal changed SPINE with its result digest
     unchanged), cut 1306 → 1307.
     ⚠️ **Also measured, and NOT fixed here because legacy is the disposable route:** legacy folds a
     null where an unproductive `by()` must FILTER the traverser — `SackValueStep.processNextStart`
     returns `EmptyTraverser.instance()` when `!product.isProductive()`. RelIR's productivity conjunct
     already matches the reference, so the two spines answer differently and these pins are `relOnly`
     by necessity rather than convention. Legacy also captures `withSack`'s second operator
     (`frontend.ts:362`) and never reads it, so a declared merge operator is silently ignored there;
     RelIR declines it (`sack.ts:69`).
   - ✅ **LANDED — `repeat()` with NEITHER modulator is the EMPTY result, not an error.** Nothing can
     leave such a walk: `RepeatEndStep` increments the counter, finds no `until`, re-adds the
     traverser, finds no `emit` and returns nothing, while `processTraverser` answers `EmptyTraverser`
     at the head. It is a LEGAL traversal — upstream verifies `repeat()` only for a missing BODY
     (*"prevents silly stuff like `g.V().emit()`"*, `StandardVerificationStrategy.java:83-85`) and
     imposes no modulator requirement — so both spines' *"repeat() requires times(), until(), or
     emit()"* was a refusal of something specified.
     **EMPTY IS NOT "no output":** `repeat(__.out()).count()` is `0`, because `count()` is a reducing
     barrier with a seed, so this yields an empty ELEMENT relation the rest of the chain folds over
     rather than a short circuit. The walk is still BUILT and then DISCARDED — building it is what
     proves the body lowers, carries no effects and changes no shape, and the emptiness argument holds
     only for a body with nothing observable in it. Replacing a provably empty relation rather than
     evaluating it is Calcite's `PruneEmptyRules`; it is NOT the depth cap the root `CLAUDE.md`
     forbids, because a cap truncates a PRODUCTIVE traversal and changes its answer while this changes
     no answer at all — only whether a query that provably returns nothing spins to prove it.
   - **Confirmed here as the largest remaining gap: an unbounded `both()` body declines on SHAPE, at
     every modulator** — §6 already owns the measurement and the plan (a term is a COMPOUND; the
     emitter needs no change; "exactly once" and "top level of FROM" become questions about an ARM;
     the rewrite is the textbook distribution of `Project`/`Filter` through a `UNION ALL`). What this
     cell adds is only the confirmation that the trigger is the LOOP-COUNTER bump §6 predicted: the
     walk's term is `project(union(arm₁, arm₂))`, and a projection over a compound takes a derived
     table, which is the shape §6 measured as `circular reference`.
     ⚠️ **A disjunctive single-arm join is NOT a shortcut past it, and an earlier revision of this
     bullet said it was — wrong, and recorded so it is not retried.** `ON (e.src = w.id OR e.tgt =
     w.id)` matches a SELF-LOOP once, where `both()` must yield the vertex TWICE: the multiset rule
     `HOPS`' own comment states, pinned by `unified-lowering.exec.test.ts` ("both() on a self-loop
     yields the vertex twice") and by L5's `laws.ts` ("the multiset SUM of the two directions, not
     their set union"). It is worth naming because of WHICH failure mode it has — a derived table
     fails LOUDLY (`circular reference`), while a disjunctive join returns a plausible row set that is
     silently short by one row per self-loop, which is P3's category and the one no instrument here
     catches.
   - Next: §8 items 7 and 8.
   - Not a cell but noted where it was found: **`repeat()` with NEITHER modulator is specified as
     the EMPTY result**, not an error — `RepeatEndStep` re-loops to exhaustion and `processTraverser`
     answers `EmptyTraverser` throughout. Both spines currently raise *"repeat() requires times(),
     until(), or emit()"*, which is a fail-closed deferral rather than the specified behaviour.
7. **§7.4 item 4 — delete `bulk.ts`.** After 4 lands this file is already unreachable for everything
   its tests cover, which is what makes the deletion small. It does NOT have to wait for the byte
   budget — see item 4, whose claim that it did was wrong in both halves. Deleting it narrows
   `times(n > 100)` to a compile-time deferral; the budget is a separate refinement that would shrink
   that narrowing to roughly `n > 700` for a movement body.
8. **§7.4 item 1 — the per-position collapse answer.** Last, because it is the largest and because
   everything above narrows it: with `bulk.ts` gone there is one authority already, and what remains is
   turning `collapseSafe` from a chain verdict into a positional query. Its residual content is smaller
   than §7.1 implies — three of its five refusal families (`otherV`'s `fromV`, `sack`, `path`) are
   already answered per-position by `CHANNEL_GROUP_POLICY`, leaving only *bulk-unaware row readers*
   (a slice or `sample()` that reads rows where it must read traversers).

### What to do when an increment goes red

**Baseline it before blaming it.** Check out the SHA and run the affected files — do NOT use
`git checkout <sha> -- src/`, which leaves files the later commit ADDED in place and gives you a hybrid
that lies. Compare failure NAME SETS, not counts, because a swap hides in a count. And `.logs/<task>.log`
is the LAST RUN in a reused directory, never a baseline.
