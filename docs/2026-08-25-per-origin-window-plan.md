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

- **`partitionBy`** — an arbitrary Expr, the ORIGIN KEY. This is the ONLY seam that differs per
  consumer: an `origin`-channel column (`local`/`flatMap`), a bound alias's id column (`match` start),
  a `by`-host id, an arm's incoming-traverser id, an unrolled iteration's entering-traverser id.
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

1. **The primitive + `local`/`flatMap` generalization.** Extract `perOriginWindow`; rewire
   `partitionedSlice`. Admit `order().by(k)` before the slice (thread the sort key into the window's
   ORDER BY) and `tail` (fromEnd). Reaps `local(__.out().order().by('name').limit(1))`,
   `local(__.properties(k).order().by(T.value).range(0,2))`, `local(__.bothE.limit(1))`, etc. Foundation
   for all below.
2. **`match` pattern body.** Partition by the start-alias id column; order by the body's `order().by()`.
   Split the body at the per-origin barrier inside the match lowering. Reaps the `outE.order.by.limit.inV`
   target.
3. **`by(<body>)` child.** Per-element window — partition by the by-host id.
4. **`union`/`choose` arm.** Per-arm window — partition by the incoming traverser.
5. **Bounded `repeat` body.** Per-iteration window at each unrolled position; unbounded stays declined.

Each phase: L2 SQL snapshots, keep L1 100%, L3/L5 re-recorded, census read for deferral→wrong-answer.
Reference every claim at the pin (`vendor/calcite` `convertDistinctOn` for the window; TinkerPop feature
files as witnesses only).
