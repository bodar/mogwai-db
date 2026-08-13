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
// async trampoline — which is a PRIVATE method on Executor (execute.ts), because it needs the
// executor's collaborators (store + the federation source). This module is TYPES ONLY: the
// cycle-free description of a plan, importing only leaf types, never the store / framing / engine.

import type { Compiled, Executable } from '../sql/kernel/render.ts';
import type { ForeignRow } from '../api.ts';
import type { BarrierInput, CallParams } from '../services/spi/types.ts';

/** The capability a barrier's `apply` needs to reach OTHER graphs: get an executor for a graph
 *  id and run a raw (detached-row) traversal on it at a given federation depth. A minimal view of
 *  the API's Executor/GraphManager — the GraphManager structurally satisfies it (it IS the
 *  executor factory). Kept here (not imported from api.ts) so segment.ts stays a leaf. */
export interface FederationSource {
  executor(id: string): { raw(gremlin: string, params: Record<string, unknown>, depth: number, paramTypes?: Record<string, unknown>): Promise<ForeignRow[]> };
}

/** A compile suspended at a barrier call(). `head` is a COMPLETE, ordinary Compiled — the
 *  barrier's INPUT rows, run and drained like any read — or `null` for a source-form g.call(...) that
 *  has no local input (apply then runs over an empty input). For a mid-traversal call the head is the
 *  prefix ENDING IN THE INJECTION READ, so it projects the injected VALUE and not the parent element:
 *  a barrier reads exactly one field of its input (`BarrierInput` is `{injectedValue?}`), and
 *  materializing each parent's id, label set and property bag to reach it was work whose only consumer
 *  threw it away. `apply` is the service's apply, already closed over this call's
 *  params, its hop depth, and the service's own app-scope dependencies (the FederationSource among
 *  them) — so it takes only the rows. `resume` turns the barrier's
 *  awaited output into the next Plan (synchronously — the only await is `apply`). Nothing here is
 *  federate-specific: any future barrier service returns this shape. */
export interface SegmentPlan {
  readonly kind: 'segment';
  readonly head: Compiled | null;
  readonly apply: (rows: readonly BarrierInput[]) => Promise<ForeignRow[]>;
  readonly params: CallParams;
  /** Turn the barrier's awaited OUTPUT (`foreign`) into the next Plan. `headRows` is the drained
   *  head INPUT (empty for a source-form call) — a mid-traversal rejoin needs the VALUE each parent
   *  asked with, to scatter the returned pool back over the parents by a real SQL JOIN on that value
   *  (so N parents sharing a value each get the whole matching set, and a parent matching nothing
   *  yields no row); a source-form resume ignores it. Nothing else about a parent survives the
   *  boundary: `path()`/`as()` across a barrier is unsupported, not carried. */
  readonly resume: (foreign: ForeignRow[], headRows: readonly BarrierInput[]) => Plan;
}

/** A fully-planned traversal: either a single synchronous SQL/write compile (everything in
 *  Phases 1-5 — the zero-segment degenerate case) or a barrier segment awaiting resumption. */
export type Plan =
  | { readonly kind: 'sql'; readonly compiled: Executable }
  | SegmentPlan;
