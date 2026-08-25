# Per-origin windowed slice — one substrate for every fan-out body

> **Status: design + phased build. Correctness is the bar; the corpus is a witness, not the goal.**
> Each increment is one `mise run ci`-green commit pushed to trunk (the container is ephemeral —
> unpushed work is lost, so durability per increment is not optional).

## What this is (and what it is NOT)

A **per-origin windowed slice** is a barrier scoped to the traverser that ENTERED a body: an
`order().by(k)`, `limit(n)`, `range(a,b)`, `tail(n)`, `skip(n)`, or `dedup()` inside `local`/`flatMap`,
a `match` pattern body, a `by(<body>)` child, a `union`/`choose` arm, or a **bounded** `repeat` body.
`local(__.out().order().by('name').limit(1))` is ONE edge per HOST, not one globally; the match target
`match(__.as('a').outE('created').order().by('weight',desc).limit(1).inV().as('b'), …)` is the top edge
per `a`.

It is a **pure SQL window** — `ROW_NUMBER()/RANK() OVER (PARTITION BY <origin> ORDER BY <key>)` filtered
to the slice — computed entirely in the lowering. It is emphatically **NOT** the
`docs/archive/2026-08-23-barrier-substrate-reshape-plan.md` "slice 2 / per-parent nesting by promotion":
that machinery (`barrier_state` rounds, `scope` key, tree `Plan`, drive-as-stack) exists for **OLAP /
service barriers** (`pageRank`, `call()`, reducing GDS algorithms) that run in rounds over a state
table. Those stay deferred. A window function needs none of it — the "origin" is already a carried
column in the fanned-out rows, so the window partitions by it synchronously. This is why "maximal" here
is a *light* substrate, not the heavy deferred one.

**Unbounded `repeat()` body stays fail-closed forever** — a per-iteration collapse in a recursive SQL
term is algebraically impossible (the archived plan §6). Bounded `repeat` unrolls to N sequential
positions, each a per-origin window at that position; that IS reachable.

## The one primitive

Today `partitionedSlice(rows, originCol, slice, fresh)` (`lower.ts`) does exactly the window — but
hardwired: it partitions by an `origin` CHANNEL, orders by `encounter`+payload only, and its sole caller
(`flatMapRejoin`) admits only a **trailing** `limit`/`skip`/`range` over a **barrier-free** prefix (so
`order().by(k)` before the slice, and `tail`, both decline today). `childRows` mints the `origin`
channel (host rowid) and lowers the body through the ordinary fold.

Generalize to **`perOriginWindow(rows, partitionBy: Expr, order: SortTerm[], slice: Window, fresh)`**:

- **`partitionBy`** — always the `origin` CHANNEL column now. The origin-key seam differs per consumer
  only in how the `origin` is MINTED, never in what the window reads: a host rowid (`local`/`flatMap`,
  `childRows`) or a per-BINDING-ROW number (`match`, `mintRowOrigin`). The earlier design partitioned a
  match window by the bound alias's id directly; item 4 refuted that — a binding row is not identified by
  any element it holds (two rows can share the start alias), so the partition must be a per-row origin,
  and match now reaches the identical `origin`-channel path `local`/`flatMap` do. A `by`-host id, an
  arm's incoming traverser and an unrolled iteration's entering traverser remain unbuilt consumers.
- **`order`** — the `SortTerm[]` from the body's own `order().by()` (reuse `sortTerms`/`orderRows`),
  falling back to `encounter`+payload when the body gave no order (an IMPL-DEFINED pick TinkerPop
  allows — the corpus asserts "result should be OF … count N"; a deterministic order keeps
  `test:perturbed` stable).
- **`slice`** — `{offset, limit|null, fromEnd}`; `fromEnd` (a `tail`) reverses the collation and keeps
  the first `n`, then restores order. Everything else is `partitionedSlice`'s existing rank filter.

`partitionedSlice` becomes a thin caller of `perOriginWindow` (partitionBy = the origin channel column),
so `local`/`flatMap` keep byte-identical SQL where they already worked and gain `order().by()`/`tail`.

## The fail-closed boundary (correctness first)

A per-origin window is correct ONLY when every row carries a stable origin key and the barrier is a
window op. Decline (never mis-execute) when:

- the origin key is not identifiable (a scalar host with no rowid — `childRows`' existing limit);
- the body barrier is a REDUCE (`count`/`sum`/`mean`/`min`/`max`) — that is `child.scalar`'s job
  (per-origin reduction with a 0/empty default), NOT a slice; or a `fold`/`group`/`aggregate`
  (collection barriers, a different substrate);
- an OLAP/service barrier (`call`, an algorithm) — the deferred heavy path;
- an unbounded `repeat` body — permanent.
- **bulk fidelity**: a `limit` counts TRAVERSERS; if a collapse merged convergent walks into `(row,
  bulk)` pairs the window must count bulk-aware or decline. (Verify how `bulk` flows through the window
  before trusting it; a silently miscounted limit is the exact wrong-answer this boundary exists for.)

## Phased build (green trunk per increment)

1. ✅ **LANDED (`dccf126`, L3 1757→1759) — the primitive + `local`/`flatMap`.** Extracted
   `perOriginWindow(rows, partitionBy, order, slice)` (a `window` arm on the `ChildSeam`); rewired the
   old `partitionedSlice` into it. `flatMapRejoin` admits a trailing `order().by()` before the slice
   (lowered inside `childRows`, so the fold's `order` mints the `encounter` the window ranks by) and
   `tail` (reversed collation). Reaps `local(__.out().order().by('name').limit(1))`, `tail`, the
   `properties().order().range()` shape.
2. ✅ **LANDED (`1dc63b2`, L3 1759→1760) — `match` pattern body — then SUPERSEDED by item 4.** The first
   cut (`splitWindow` + `windowedBody`) re-rooted the prefix, applied `child.window` PARTITION BY the
   START-ALIAS id, then continued the suffix. It reaped the `outE.order.by.limit.inV` target but carried
   a latent wrong answer (a partition by alias id collapses binding rows that share it), and item 4
   replaced it with the per-binding-row `origin` channel. Both `splitWindow` and `windowedBody` are
   deleted; the lesson kept is that the partition-key seam is a per-consumer MINT, not a per-consumer read.

3. ✅ **LANDED (`d8b6fc4`) — per-origin `dedup()` for `local`/`flatMap`.** `dedupOn` prepends the ambient
   `origin` to its window `PARTITION BY`; the bare-dedup guard exempts `origin` from `groupableChannels`
   (it is the partition key, not a grouped value); a payload-identified dedup with a live `origin` routes
   through the ranked window (which keeps `origin`) instead of the Distinct/Aggregate arms (which cannot).
   `flatMapRejoin` admits `order()`/`dedup()` barriers in the body prefix. Reaps `local(out().dedup())`,
   `local(both().dedup())`, and dropped an `@Unsupported` L4 tag (`local(out().in().order().by(name).dedup())`,
   ordered + perturbation-stable). This is the fold-mode rule in place for the row-preserving barriers.

4. ✅ **LANDED (`cf7a504`) — `match` UNIFIED onto the per-origin substrate (the principled version).**
   A per-origin barrier in a pattern body now scopes PER BINDING ROW through the SAME mechanism
   `local`/`flatMap` use, not a hand-rolled window. `child.scopeRows`/`unscopeRows` (`mintRowOrigin`/
   `dropOrigin`) mint a per-ROW `origin` (`ROW_NUMBER() OVER ()`, unique per binding row) on the binding
   table and shed it after the body; the whole body runs through `child.chain`, and `sliceOp`/`dedupOn`
   consult that ambient `origin` and self-scope. **`windowedBody`/`splitWindow` are DELETED** — match
   "stops being a special-case hand-rolled version" (TinkerPop grounds this: `MatchStep` localizes a
   barrier pattern body into a `TraversalFlatMapStep`, `MatchStep.java:156-166`, so each pattern runs
   per-traverser). This FIXED a latent wrong answer the old start-alias partition carried: two `x`
   reaching one `a` collapsed to one edge (partition by alias id) instead of one each (partition by
   binding row) — `match(as(x).out('created').as(a), as(a).inE.order.by(weight).limit(1).outV.as(b))`
   now answers 4 rows, not 2. Reaps match per-origin `dedup()` too. Enablers: `sliceOp` gains the origin
   path (`sample` deliberately falls through to its global RANDOM window — intercepting it regressed a
   `by(__.…order().sample(n).fold())` reducer); `dedup`'s guard reordered so the window arms (which carry
   alias channels + `origin`) precede the `groupableChannels` guard, which now gates only the collapsing
   Distinct/Aggregate arms. 7 corpus traversals moved deferred→golden (all verified vs the reference).

5. ✅ **LANDED (`227f428`) — per-TRAVERSER origin for `local`/`flatMap`, and `flatMapRejoin` unified
   onto the match substrate.** The origin for a `local`/`flatMap` body was the ELEMENT rowid, which
   REPEATS when two traversers land on one element — `g.V().both().local(__.out().limit(1)).count()`
   collapsed the three traversers at `marko` into one and answered 3 instead of 7 (the twin of item 4's
   binding-row bug, found by probing the unification at depth). `childRows` gains a `perRow` mode:
   `group()`'s reducer keeps the element-id origin (it pools members BY the element — correct), while
   `local`/`flatMap` mint a per-ROW origin (`mintRowOrigin`). `flatMapRejoin` now runs the WHOLE body
   through `childRows(perRow)` and lets `sliceOp`/`dedupOn`/`order` self-scope — the SAME code path
   match uses — deleting its hand-rolled trailing-slice pop and reaping interior slices
   (`local(__.out().order().by(name).limit(2).out())`). `PER_ORIGIN_SAFE_BARRIER` keeps
   `sample`/`fold`/`group`/reducers failing closed. The `ROW_NUMBER` origin costs a little SQL
   (banked in the hygiene baseline — correctness over bytes); census is answer-preserving on the corpus;
   an L4 regression (`per-traverser-fanout-slice.feature`) pins both the `local` and `match` cases.

### Two semantics corrections found by reading the reference (not reasoning)

- **`union`/`choose` arm barriers are ARM-MAJOR, not per-origin.** `BranchStep.standardAlgorithm`
  (`BranchStep.java:140-150`) drains EVERY start into an arm before applying its barrier — so
  `union(out().limit(2), …)` limits over the whole input, globally. The current answers are already
  correct; a per-origin window there would be WRONG. **Union arms are not a per-origin consumer.**
- **In-body-branch origin threading already works.** `movement` (`bothE`) and the `union`/`choose` steps
  carry the input's `origin` channel through their merge (`mergeChannels` keeps the `identical` origin;
  only `encounter` is dropped), so `local(bothE.limit(1))`, `local(union(out,in).limit(1))`,
  `local(choose(…).limit(1))` all already scope per-origin. The earlier "decline" was the separate
  `otherV()` deferral. So there was no threading gap — the real gap was `dedup` (item 3).

### Refined scope for the rest (found while building)

- **`by(<body>)` — NOT a per-origin-window consumer.** The corpus `by(...)` bodies are `by(__.out()…fold())`
  / `dedup().fold()` — list COLLECTION per group (`child.scalar` / the collection substrate), not a
  stream slice that reattaches. A per-origin window does not apply; these stay on their own path (or
  fail closed). No witness for a `by(__.out().limit(1))` stream-slice-as-value.
- **`union`/`choose` arm + bounded-`repeat` body — the HARDER, distinct piece.** A per-origin slice
  here is per-INCOMING-traverser, which is the branch substrate's **traverser-major/arm-major** question
  (`unionArms`, `armBatches`, `mintTraverserMajor` — it already *declines* a slice-demanded batched arm
  as "not built"). The window primitive is ready, but the origin key must be the incoming traverser
  minted INSIDE the arm/iteration (like `childRows` does for `local`), threaded through the
  traverser-major merge. Corpus witnesses are grateful-graph `repeat(union(out.order.by.limit(2), …))`
  (unbound params). This is its own increment against the branch machinery — not a partition-key swap.
- **Unbounded `repeat` body — permanent decline** (recursive-term, §"What this is").

Each phase: L2 SQL snapshots, keep L1 100%, L3/L5 re-recorded, census read for deferral→wrong-answer.
Reference every claim at the pin (`vendor/calcite` `convertDistinctOn` for the window; TinkerPop feature
files as witnesses only).
