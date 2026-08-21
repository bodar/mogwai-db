# Barrier substrate — the two axes (rough design, records a discussion)

**Status: DESIGN NOTES, not a plan. Records the 2026-08-21 discussion that landed the regex barrier
and set the direction for the sync/async split, federate cleanup, and OLAP.** Nothing here beyond the
regex barrier is built. The authority is the code (`src/compiler/rel/segment.ts`,
`src/services/spi/types.ts`); this is the mental model for where barriers are going.

A "barrier" today (`SegmentPlan`) is `head (SQL) → transform → resume (SQL)` on the `driveSegments`
trampoline. Two consumers exist (`federate`, `io`) and three more are coming (`regex` — landed;
federate-subgraph; OLAP). They vary along **two orthogonal axes**, and conflating them is the source
of the current smells.

## Axis 1 — sync vs async: a CORRECTNESS/OCCUPANCY contract, not ergonomics

The presence of an `await` in the transform is load-bearing, for two reasons:

- **Isolation.** A synchronous transform (no `await`) is atomic by JS run-to-completion — head, filter
  and resume run as one stretch over ONE consistent store snapshot; nothing can interleave. An `await`
  is a suspension point where, on a Durable Object, another request can be delivered and MUTATE the
  store between the head read and the resume read. Federate already admits this in its own
  `describeParams`: *"not single-snapshot isolated across the segment boundary."*
- **Occupancy.** A sync transform busy-locks the single-threaded DO for its whole duration; fine for
  milliseconds (a regex batch filter), fatal for a long job (an OLAP iteration on a 10 GB / millions-of-
  vertices store pins the object, serving nothing else). A long barrier MUST be async — yield so the DO
  serves other requests in the gaps (a DO **alarm**/checkpoint), or run off the DO.

So a barrier should DECLARE which it is, and the drive loop should run a **sync** barrier with no
`await` (atomic, cannot interleave, cannot leave the DO) and an **async** one with a real suspension
(non-isolated by contract, may run under an alarm or Worker-driven).

| Barrier | sync/async | why |
|---|---|---|
| **regex**, **reverse**, **split** | **sync** | pure CPU over an in-DO batch; MUST be atomic (a value transform inside one grammar query) |
| `federate` (value-inject) | async | remote wait (sibling DO); non-isolated is documented + accepted |
| `io` | async | R2 object get/put |
| federate (subgraph) | async | remote wait |
| OLAP (pageRank, …) | async | 20–50 iterations; must yield or it pins the DO — non-isolation is expected for a batch job |

## Axis 2 — output shape: how the transform's product re-enters the chain

Orthogonal to Axis 1. Federate's detached-`ForeignRow[]` landing is federate-specific; other consumers
want different shapes.

- **(A) Lightweight value re-injection — EXISTS, two shapes.** A data-sized relation of VALUES crosses
  as ONE `json_each` bind (data never in the statement text) and re-enters the LIVE stream. No new
  identity, no storage. Two re-injection shapes have landed:
  - **filter** — `within(json_each)` re-runs the prefix and keeps survivors; the stream is unchanged.
    **regex** (`src/compiler/rel/regex.ts`). Federate's *value*-injection is morally this too (smell below).
  - **value-source** — the barrier's computed values ARE the resumed stream, sourced from
    `json_each` and continued by the ordinary tail (`lowerValueResume`/`lowerListResume`, the value twins
    of `lowerForeignResume`). **reverse** (scalar values, `src/compiler/rel/reverse.ts`) and **split**
    (a LIST per input, `src/compiler/rel/split.ts`) are both this shape — split just frames its rows as
    lists (`lowerListResume`, `{list, of: BARE_LIST}`) so they re-enter the list vocabulary rather than
    as scalar text. The rest of the string-op family is the same shape.
- **(B) Heavy materialized local relation — UNBUILT.** A data-sized RELATION with its own local
  identity/adjacency → a `TEMP` table or a retained materialized binding (RelIR §3.0 `Binding`/`Ref`).
  Needed by **federate-subgraph** (to traverse a fetched subgraph locally with live adjacency — the
  current detached result supports only `id`/`label`/`values`, matrix §1) and by **OLAP** (id→score
  relation, iteration state). This is the "temp table vs `Ref`" open question — settle it ONCE with
  those two concrete consumers and measurement (DO DDL is unmeasured; `test/cf-probe/` first), not
  speculatively. See `docs/2026-07-24-graph-algorithms-plan.md` open research §4.

|  | (A) value re-injection (exists) | (B) materialized relation (unbuilt) |
|---|---|---|
| **sync** | **regex** | (tiny OLAP, maybe) |
| **async** | federate value-inject | federate subgraph, OLAP |

## The festering smells this frames (federate)

- **Inline-literal re-injection.** Federate re-injects its distinct injected values as INLINE LITERALS
  in the statement text (`within(v1,…,vN)` via `substituteInjectionMarker`) — a data-sized set baked
  into the SQL string, spending the 100 KB statement-text budget and putting data in the plan. The 25-
  literal cap is GONE (`predicate.ts` — inline literals cost zero binds), but the inlining itself is the
  smell. Fix: route it through (A)'s `within(json_each)` — one bind, fixed text — the same path regex
  uses. Removes a caveat and de-duplicates the re-injection.
- **Detached returns.** A federate result has no live adjacency (matrix §1). The subgraph vision (bring
  a sibling subgraph into local storage and traverse it) is exactly substrate (B); whether federate
  *should* support a subgraph is the good indicator that (B) is worth building.

## What is decided vs deferred

- **LANDED (2026-08-21) — Axis 1 (sync/async).** `SegmentPlan` is a discriminated union on `mode`
  (`compiler/segment.ts`); a `SyncSegmentPlan` has no `apply`/`residency` and is driven with NO `await`
  (`driveSegmentsSync`, reachable from the sync `framed()` path), an `AsyncSegmentPlan` keeps the await
  trampoline. regex and reverse are sync; federate/io are async.
- **LANDED (2026-08-21) — substrate A's value-source arm + `reverse` migrated off its CTE.**
  `lowerValueResume` seeds the resumed stream from the barrier's computed values (`json_each`) and
  continues via `scalarTail`. `reverse()` was a per-row recursive CTE (string-only, ~882 B SQL, a
  recursive subquery PER ROW); as a barrier it is **424 B, ~2× faster, ~2× cheaper to compile, and
  reverses lists** (which the CTE could not). A/B measured on `values('name').reverse()`. The CTE is
  deleted.
- **LANDED (2026-08-21) — `split()` on the same value-source arm.** `split(sep)` over a scalar string
  stream is the second value-transform barrier: the JS `splitValue` (faithful to `SplitGlobalStep`/
  Commons `StringUtil.split`) computes ONE LIST per traverser, and `lowerListResume` re-injects them as a
  `LIST_COL`-carrying read framed `{list, of: BARE_LIST}` — the shape `inject([...])` produces — so a
  following list op composes through the ordinary list vocabulary. The one new piece over reverse is
  `lowerListResume` (a scalar `value` resume would frame each list as its JSON TEXT, a string on the
  wire). `split(Scope.local, …)` over a folded list (member-wise string→LIST) and a LIST-shaped head
  stay fail-closed deferrals.
- **KNOWN GAP the reverse work surfaced — NESTED value transforms.** A barrier segments the WHOLE query,
  so it can only lower a TOP-LEVEL value transform; a `reverse()`/`split()` inside a child body
  (`order().by(__.…reverse())`) cannot be a barrier and now DECLINES (fail-closed). Handling nested value
  transforms is its own future substrate problem — inline SQL there means the CTE/JSON hacks substrate A
  exists to avoid, so it waits for a real design rather than a per-op hack.
- **LATER (needs a second concrete consumer + measurement):** substrate (B); moving federate's
  re-injection onto (A); the OLAP occupancy model (alarm-checkpoint vs Worker-driven).
