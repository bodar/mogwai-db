// ---------- the segmented-plan seam (Phase 6 barrier services) — TYPES ----------
//
// A read traversal is normally ONE compile-to-SQL statement run synchronously (the degenerate
// case, `{kind:'sql'}` — zero async overhead, unchanged behavior). A BARRIER service (call()
// whose result comes from outside SQLite — a sibling graph, an outbound fetch) cannot live
// inside one statement: its rows arrive on a Promise. So the general model is a PLAN of segments
// glued by service boundaries:
//
//   [ SQL segment ] -> drain to rows -> (barrier: await apply) -> land + re-source -> [ SQL segment ] -> ...
//
// The async gap happens ONLY between segments (never inside one) — exactly what the DO runtime
// forces (a SQLite cursor / transactionSync can't cross an await). "Compile to SQL, never
// interpret" holds WITHIN every segment; a barrier is an opaque async transform BETWEEN
// SQL-compiled stages, not a row-at-a-time interpreter.
//
// The plan is a LAZY CONTINUATION, not a pre-flattened Segment[]: the segment count + each one's
// shape depend on the PRIOR barrier's runtime output, so the compiler cannot know the count
// without running one. `resume` is a pure function from a barrier's output rows back into the
// NEXT Plan (itself possibly another segment). Gluing is function composition, driven by the
// async trampoline `driveSegments` (src/drive.ts) — a FREE FUNCTION over an injected host (compile +
// readHead), so the same loop runs in-process on Bun and Worker-side on Cloudflare; the Executor is
// only the in-process host (edge-compilation §4·4). This module is TYPES ONLY: the cycle-free
// description of a plan, importing only leaf types, never the store / framing / engine.

import type { Compiled, Executable } from '../sql/kernel/render.ts';
import type { ForeignResult } from '../api.ts';
import type { BarrierInput, BarrierOutput, BarrierResidency, CallParams } from '../services/spi/types.ts';

/** The capability a barrier's `apply` needs to reach OTHER graphs: get an executor for a graph
 *  id and run a raw (detached-row) traversal on it at a given federation depth. A minimal view of
 *  the API's Executor/GraphManager — the GraphManager structurally satisfies it (it IS the
 *  executor factory). Kept here (not imported from api.ts) so segment.ts stays a leaf. */
export interface FederationSource {
  // `terminal` ('reduce' — kept as a bare literal so this leaf need not import `ForeignTerminal` from
  // api.ts) disambiguates a pushed reducer from a pushed value stream (a `count()` and a `values(k)`
  // both compile to `value`); absent → the sibling shape is authoritative (elements vs a value stream).
  executor(id: string): { runForeign(gremlin: string, params: Record<string, unknown>, depth: number, paramTypes?: Record<string, unknown>, terminal?: 'reduce'): Promise<ForeignResult> };
}

// ---------- a barrier is SYNC or ASYNC, and the distinction is a CORRECTNESS contract ----------
//
// `mode` is not ergonomics. An `await` in a barrier's transform is a SUSPENSION POINT: on a Durable
// Object another request can be delivered and MUTATE the store across it, and the transform pins the
// single-threaded DO for its whole duration. So the two modes carry two different guarantees, and the
// drive path honours them (`src/drive.ts`):
//
//   - **SYNC** (`regex`): the transform is a plain function with NO await. Head, transform and resume
//     run as ONE synchronous stretch over ONE consistent snapshot — nothing interleaves, and it cannot
//     leave the DO. It is drivable from the SYNCHRONOUS `framed()` path (`driveSegmentsSync`), which is
//     what makes "no async bit" true by construction rather than by reasoning about microtasks. A sync
//     barrier has no `apply` and no `residency` — it is always local and always atomic.
//   - **ASYNC** (`federate`, `io`, the planned OLAP barriers): the transform awaits real I/O (a sibling
//     DO, an object store) or is a long batch that MUST yield so the DO serves other requests. It is
//     NOT single-snapshot isolated across the boundary (federate says so in its own `describeParams`),
//     and it needs the async trampoline. `residency` decides whether the Worker may drive it off the DO.
//
// Rationale + the two orthogonal axes (this one, and the barrier's OUTPUT shape):
// `docs/2026-08-21-barrier-substrate-design.md`.

/** An ASYNC barrier. `head` is a COMPLETE, ordinary Compiled — the barrier's INPUT rows, run and
 *  drained like any read — or `null` for a source-form g.call(...) with no local input. For a
 *  mid-traversal call the head projects the injected VALUE (`BarrierInput` is `{injectedValue?}`).
 *  `apply` runs the async transform (the one await); `resume` turns its awaited OUTPUT into the next
 *  Plan. `headRows` is the drained head input — a mid-traversal rejoin needs the value each parent
 *  asked with, to scatter the returned pool back by a real SQL JOIN. */
export interface AsyncSegmentPlan {
  readonly kind: 'segment';
  readonly mode: 'async';
  readonly head: Compiled | null;
  readonly apply: (rows: readonly BarrierInput[]) => Promise<BarrierOutput>;
  /** The SYNCHRONOUS CORE of `apply`, present iff the compute has no real await (the OLAP barriers). It
   *  lets the SYNC drive run this async barrier with no suspension — the `framed()`/census path, where
   *  busy-locking is acceptable — while production keeps `apply` so it can yield. Absent for federate/io
   *  (real I/O), which therefore still refuse the sync path. */
  readonly applySync?: (rows: readonly BarrierInput[]) => BarrierOutput;
  readonly params: CallParams;
  /** WHERE this barrier's `apply` runs (§4·3): `'worker'` — the Worker may drive the loop off the DO
   *  (federate); `'do'` — must run beside the store, so the edge falls back to the DO's own drive (io).
   *  Threaded from the resolved `Contribution.residency`; the drive decision (`EdgeExecutor`) reads it. */
  readonly residency: BarrierResidency;
  readonly resume: (out: BarrierOutput, headRows: readonly BarrierInput[]) => Plan;
}

/** A SYNC barrier. No `apply` (there is no async transform) and no `residency` (always local, always
 *  atomic). The head is read synchronously, its rows handed straight to `resume`, which does the
 *  synchronous transform AND builds the next Plan. `head` is never null — a sync barrier reads a head
 *  to transform (regex's candidate `values(key)`). */
export interface SyncSegmentPlan {
  readonly kind: 'segment';
  readonly mode: 'sync';
  readonly head: Compiled;
  readonly resume: (headRows: readonly BarrierInput[]) => Plan;
}

export type SegmentPlan = AsyncSegmentPlan | SyncSegmentPlan;

/** A fully-planned traversal: either a single synchronous SQL/write compile (the zero-segment
 *  degenerate case) or a barrier segment awaiting resumption. */
export type Plan =
  | { readonly kind: 'sql'; readonly compiled: Executable }
  | SegmentPlan;
