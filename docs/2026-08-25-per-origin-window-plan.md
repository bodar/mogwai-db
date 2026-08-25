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

1. ✅ **LANDED (`dccf126`, L3 1757→1759) — the primitive + `local`/`flatMap`.** Extracted
   `perOriginWindow(rows, partitionBy, order, slice)` (a `window` arm on the `ChildSeam`); rewired the
   old `partitionedSlice` into it. `flatMapRejoin` admits a trailing `order().by()` before the slice
   (lowered inside `childRows`, so the fold's `order` mints the `encounter` the window ranks by) and
   `tail` (reversed collation). Reaps `local(__.out().order().by('name').limit(1))`, `tail`, the
   `properties().order().range()` shape.
2. ✅ **LANDED (`1dc63b2`, L3 1759→1760) — `match` pattern body.** `splitWindow` finds the mid-body
   slice; `windowedBody` re-roots the prefix (incl. its `order()`), applies `child.window` PARTITION BY
   the start-alias id, then continues the suffix (`inV`). Reaps the `outE.order.by.limit.inV` target. The
   partition-key seam (origin channel → alias id) proved out exactly as designed — one primitive, two
   consumers, differing only in `partitionBy`.

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
