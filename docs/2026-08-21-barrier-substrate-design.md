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
| **regex** | **sync** | pure CPU over an in-DO batch; MUST be atomic (a filter inside one grammar query) |
| `federate` (value-inject) | async | remote wait (sibling DO); non-isolated is documented + accepted |
| `io` | async | R2 object get/put |
| federate (subgraph) | async | remote wait |
| OLAP (pageRank, …) | async | 20–50 iterations; must yield or it pins the DO — non-isolation is expected for a batch job |

## Axis 2 — output shape: how the transform's product re-enters the chain

Orthogonal to Axis 1. Federate's detached-`ForeignRow[]` landing is federate-specific; other consumers
want different shapes.

- **(A) Lightweight value/set re-injection — EXISTS.** A data-sized set of VALUES re-injected as
  `within(json_each)` (one bind, data never in the statement text) and re-filtering LIVE local tables.
  No new identity, no storage. **regex** is this (`src/compiler/rel/regex.ts`). Federate's *value*-
  injection is morally this too — see the smell below.
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

- **NOW:** make Axis 1 explicit — a barrier declares sync/async; the drive loop runs a sync barrier
  with no `await`; **regex is sync**. This is a correctness property regex needs, and it names the OLAP
  distinction for free. (This is the sync/async work following the regex-barrier landing.)
- **LATER (needs a second concrete consumer + measurement):** substrate (B); moving federate's
  re-injection onto (A); the OLAP occupancy model (alarm-checkpoint vs Worker-driven).
