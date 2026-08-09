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
node — seen from the COST side rather than the legality side. So the recursive regime cannot
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

### Status of the amendment — IN FLIGHT, not landed

The doc is amended ahead of the code deliberately: §1 is the decision, and it is now WRONG on trunk.
What implements it, currently uncommitted and red:

- `unrollFixedRepeat`'s "nothing to gain unless a barrier was blocking it" guard — **deleted**.
- `walk.ts` — the `Recursive` regime (§3.1), plus the interchangeable-frontier decline above.
- the `loops` CHANNEL role (`src/channels.ts`) and the seam's `chain` arm (§3.1's open question,
  settled below).

Consequences still to work through, each a genuine one rather than churn — the widened unroll runs
ABOVE the routing switch, so it moves both spines: seven `sql-hygiene` byte ratchets (n copies of a
body is n times the text — banked, reason here), the L2 SQL pins that assert legacy's `WITH
RECURSIVE` for traversals that no longer recurse on EITHER spine, two L5 ratchet entries that got
BETTER (`repeat(__.both()).times(3).range(5,11)` no longer diverges between the fast-path
positions), and one L5 GENERATOR bug the unroll exposed: it models a `repeat()` body as
shape-preserving, but `repeat(__.has(…).inE('knows')).times(1)` ends on an EDGE — TinkerPop's
`RepeatStep` is `<S,S>` in its Java signature and not at runtime.

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

### 3.2 ~~The differential over the overlap cell~~ — WITHDRAWN, §1a

The approval required it because bounded + barrier-free bodies were legal BOTH ways. §1a measures
that they are not: a bounded body must reach a regime that can collapse, and the walk cannot. With
no overlap population there is nothing for a differential to compare, so this is discharged rather
than deferred. What replaces it is the guard on each side — the unroll takes every bounded run it
can express, and `walk.ts` declines a bounded walk over an interchangeable frontier.

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
  (`recursiveViolation`). NOT YET BUILT: today a `both()` body declines, and so does any body whose
  loop-counter bump sits over a union, which is every multi-arm one. The rewrite it needs is the
  textbook distribution of `Project`/`Filter` through a `UNION ALL`.
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
