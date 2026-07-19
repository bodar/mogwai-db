# Canonical emission order (traverser sequence) as an on-demand substrate

**Date:** 2026-07-19
**Status:** design — approved scope ("canonical emission order substrate"), staging + crux
decisions pending.
**Baseline:** L3 1227.

## Why

TinkerPop traversers are emitted in a deterministic **sequence** (a DFS-ish walk). We model
traversers as an **unordered multiset** (UNION ALL everywhere) and bolt on an order column
(`encounter`) only in a few places (`order()`, ordered `dedup()`, child-scope `first`/`fold`).
Two consequences keep biting:

1. **take-first-of-fan-out** (`map(__.trav)`, `by(__.trav)`, a fan-out arm at a `path()`
   position) needs "the first emitted result". It works for a single child path (the child
   `encounter`), but **dies at a branch** — `tryLowerScalarUnion/Choose/Coalesce` build their
   merged stream with `toScalarStream(…, /* no encounter */)`, dropping order. This is the
   real reason the "take-first" non-goal keeps recurring.
2. **`limit()`/`range()`/`skip()`/`tail()` are nondeterministic by design.** Element-prefix
   `limit` emits `… LIMIT n` with **no ORDER BY** (`passthrough.ts`); scalar-root `tail` uses
   `ROW_NUMBER() OVER ()` with an **empty** window; root `fold()` has no `ORDER BY`. They rely
   on incidental SQLite row order.

The "hard in SQL / sets have no order" objection is largely **obsolete**: `order()` already
emits the canonical form `encounter = ROW_NUMBER() OVER (ORDER BY …)`, carries it, and
`materialize` sorts by it. The substrate is a **generalization of an existing pattern**, not a
new invention.

## The model

**Emission order = a single monotonic `encounter` sequence, minted by ROW_NUMBER, refined at
each fan-out.** One representation (not a growing tuple):

- **Source** (`V()`/`E()`): `encounter = id` (rowid order) — the base sequence.
- **Fan-out step** refines: `encounter = ROW_NUMBER() OVER (ORDER BY prev_encounter, <local_key>)`.
  The local key is the natural emission key already present in the SQL:

  | Fan-out | local key |
  |---|---|
  | `out/in/both`, `…E`, `…V`, `otherV` | driving **edge id** (`e.id`) |
  | `values('k')` | **VertexProperty/EdgeProperty id** (already the tiebreak today) |
  | re-source `V()`/`E()` | new **element id** |
  | `union(a,b,…)` | **arm index** (0,1,2…) then the arm's own encounter |
  | `choose`/`coalesce` | firing arm's encounter (≤1 arm per input) |
  | `inject(x,y)` | **literal argument index** |
  | `repeat` | composite (depth, per-iteration edge id) — hardest, deferred |

- **Two scopes, one mint rule.** Root scope → a global sequence (`ORDER BY …`, no partition).
  Child scope → per-origin (`PARTITION BY <ordinal> ORDER BY …`). Same expression, different
  partition. `group()`'s `valOrder` ("parent encounter then child encounter") is the existing
  composite precedent to generalize.

**"First"/order semantics:** our sequence = rowid / edge-id / vp-id / arm-index order. It is
**deterministic** and a **legitimate** traversal emission order. For `union` it matches
TinkerPop exactly (arm a before arm b). For movement, TinkerPop's order is
**implementation-defined**, so edge-id order is as correct as any — and it's the same rule
`by(key)` already uses (`ORDER BY id LIMIT 1`). Correct-by-design, not corpus-chasing.

## Lazy / on-demand — NOT always-on

An always-present `encounter` column is rejected (see Risks): it would trip
`assertStreamColumns` at every CTE, force a re-mint after every barrier, permanently disable
`inject()` and `movementCollapse`, and churn snapshots for order most traversals never use.

Instead: **`encounter` stays tri-state (`undefined` = not tracked).** A **demand pre-pass**
(in `strategies.ts`, over the normalized `Step[]`) decides per compilation whether emission
order is needed and threads it only then:

- **Needed** iff the chain contains a positional/first consumer *downstream of a fan-out*:
  `limit`/`range`/`tail`/`skip` after a fan-out, a take-first `map`/`by(__.trav)` over a
  fan-out body, or a root `fold()` whose order is observable. (A source-only `limit`
  — `g.V().limit(10)` — orders cheaply by id, no window; the expensive frontier-sort only
  when a fan-out precedes.)
- **Not needed** → no encounter, hot path (index-only movement, `movementCollapse`) unchanged.
  Reducers (`count`/`sum`/…), existence gates, and bare `dedup()` are order-irrelevant and
  never trigger it.

This keeps the bold model correct-by-design where it matters and free where it doesn't.

## Consumers to wire (make them ORDER BY the encounter)

- `limit`/`range`/`skip` (element prefix, `passthrough.ts`) and scalar-root `limit`/`tail`
  (`scalar.ts` `rowPreserving`/`rootTail`) — currently no/empty ORDER BY.
- take-first: branch merges (`branch.ts`), `map` fan-out, `path()` fan-out arm
  (`select.ts positionArmFansOut` → lift once encounter is available).
- root `fold()` (`barrier.ts lowerGlobalFold`) — order the list.
- `dedup(labels)` (`filter.ts`) — "first per key" should be first-in-emission, not lowest-id.
- `materialize` — already consumes `carried.encounter`; drop the `if` where order is demanded.

## Staged rollout (each stage green on L1 corpus + L3 ratchet + L4)

**Stage A — branch-merge encounter (highest value, self-contained).** Synthesize the merged
encounter in the scalar/list/variant branch compilers: tag arm k with `arm_idx=k`, preserve
each arm's own encounter, emit `encounter = ROW_NUMBER() OVER (PARTITION BY <ordinal>? ORDER BY
arm_idx, arm_encounter)`, pass it as `toScalarStream(…, encounter)`. Unblocks **take-first
after a branch**: `map` over a branch fan-out, `path().by(fan-out branch arm)`, and the
**Layer-2 list-fold-nested** case (`__.choose(…).fold()`). No demand pass, no source/movement
change — arms already can carry an encounter. Validates the model.

**Stage B — positional determinism.** Add the demand pre-pass + source seed + movement refine;
wire `limit`/`range`/`tail`/`skip` (element + scalar root) and root `fold()` to `ORDER BY`
the encounter. This is the wide-blast-radius stage (movement, sources, `chainCollapseSafe`
reconciliation, snapshot churn). Land behind the demand gate so order-free traversals are
untouched.

**Stage C — polish + unify.** `dedup(labels)` first-in-emission; reconcile the two encounters
(`Carried.encounter` vs `ScalarStream.encounter`) — likely promote the stream-level one into
`Carried` so it threads structurally; lift the `path()`/`map` fan-out fail-closed guards to
take-first. Update the matrix + retire the take-first 🚫 notes.

**Repeat** stays deferred (recursive-CTE can't window across iterations cleanly) — documented
as the one remaining fan-out without emission order.

## Risks (from the consumer map)

1. **`carriedCols` ORDER RULE** (`context.ts:173-187`): a later-appended column must sort
   later. `encounter`'s slot (after origins/fromV, before path) is load-bearing —
   `pushChildScope`/movement path-append rely on `carriedCols(old)` being a prefix of the new.
   Keep the slot; keep it tri-state (never reorder).
2. **`withoutCarried`/barriers** drop encounter (a barrier output is a fresh traverser). A
   post-barrier positional consumer must re-mint from the barrier's own order.
3. **`movementCollapse` `isBulkOnly`** (`movement.ts:8`) doesn't check `!encounter` — add an
   explicit guard (collapse discards per-row identity, incompatible with a live encounter).
   Currently unreachable via `chainCollapseSafe`; make it explicit.
4. **`inject()` guard** (`scalar.ts`) refuses any live carried column but `bulk`; must special-
   case `encounter` (or it disables `inject` once encounter can be present).
5. **Snapshot churn**: new ROW_NUMBER/ORDER BY in many CTEs. Snapshots assert semantic
   equivalence (CLAUDE.md), so update-not-freeze — but budget the mechanical diff.
6. **Two encounters** (`Carried.encounter` vs `ScalarStream.encounter`) answer different
   questions (root/global vs per-origin child); Stage C decides unify-vs-keep.

## Crux decisions (need a call before Stage B)

1. **Representation**: single running ROW_NUMBER (recommended) vs composite tuple. → single.
2. **Demand granularity**: coarse chain-level flag (thread if any positional/first consumer
   exists) vs precise from-fan-out-to-last-consumer span. → start coarse, refine if perf shows.
3. **Movement "first"**: edge-id order (recommended, deterministic, matches `by(key)`) —
   accept it may differ from the reference impl's unspecified movement order.
4. **Final-result order**: leave as-is (only ordered when a consumer/`order()` demands) vs
   always emit results in emission order. → leave as-is (always-order = perf cost for no
   correctness gain under unordered comparison; revisit if a real ordered-result need appears).
