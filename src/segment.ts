// ---------- the segmented-plan seam (Phase 6 barrier services) ----------
//
// A read traversal is normally ONE compile-to-SQL statement run synchronously (the
// degenerate case here, `{kind:'sql'}` — zero async overhead, unchanged behavior). A
// BARRIER service (call() whose result comes from outside SQLite — a sibling graph, an
// outbound fetch) cannot live inside one statement: its rows arrive on a Promise. So the
// general model is a PLAN of segments glued by service boundaries:
//
//   [ SQL segment ] -> drain to rows -> (barrier: await apply) -> land + re-source -> [ SQL segment ] -> ...
//
// The async gap happens ONLY between segments (never inside one) — exactly what the DO
// runtime forces (a SQLite cursor / transactionSync can't cross an await). "Compile to SQL,
// never interpret" holds WITHIN every segment; a barrier is an opaque async transform
// BETWEEN SQL-compiled stages, not a row-at-a-time interpreter.
//
// The plan is a LAZY CONTINUATION, not a pre-flattened Segment[]: the number of segments and
// each one's shape depend on the PRIOR barrier's runtime output (how many rows, which
// ordinals survived), so the compiler cannot know the segment count without running one.
// `resume` is a pure function from a barrier's output rows back into the NEXT Plan (itself
// possibly another segment, if a second call() follows). Gluing is function composition,
// driven by the async trampoline below — never a data structure the compiler flattens.
//
// This file is the cycle-free MECHANISM (mirrors services/registry.ts's discipline): it
// imports only the compile-output + service leaf types, never GraphStore / framing / the
// step engine. execute.ts supplies the concrete row-reader + env at run time.

import type { Compiled, WritePlan } from './render.ts';
import type { ForeignRow, ServiceEnv, CallParams } from './services/types.ts';

/** A compile suspended at a barrier call(). `head` is a COMPLETE, ordinary Compiled — the
 *  barrier's INPUT rows (each parent traverser's id + ordinal for a mid-traversal call), run
 *  and drained exactly like any read — or `null` for a source-form g.call(...) that has no
 *  local input (the orchestrator then applies the barrier over an empty input). `apply` is the
 *  service's `apply` pre-bound to this call's params + env slot; `resume` turns the barrier's
 *  awaited output back into the next Plan (synchronously — the only await is `apply`). Nothing
 *  here is federate-specific: any future barrier service returns this same shape. */
export interface SegmentPlan {
  readonly kind: 'segment';
  readonly head: Compiled | null;
  readonly apply: (rows: readonly ForeignRow[], env: ServiceEnv) => Promise<ForeignRow[]>;
  readonly params: CallParams;
  readonly resume: (foreign: ForeignRow[]) => Plan;
}

/** A fully-planned traversal: either a single synchronous SQL/write compile (everything in
 *  Phases 1-5 — the zero-segment degenerate case) or a barrier segment awaiting resumption. */
export type Plan =
  | { readonly kind: 'sql'; readonly compiled: Compiled | WritePlan }
  | SegmentPlan;

/** Drive a Plan to a final synchronous Compiled/WritePlan. The ONLY async loop in the
 *  codebase outside a runtime entry point. Each barrier iteration: read+drain `head` (an
 *  ordinary sync store read supplied by the caller), await the barrier's `apply`, resume into
 *  the next Plan. A `'sql'` Plan returns immediately — no async overhead, no behavior change
 *  from a pre-Phase-6 compile. `readHead` reads a segment's head into ForeignRow input rows
 *  (a mid-traversal parent projection); a null head means "no input" (source form). */
export async function runPlan(
  plan: Plan,
  env: ServiceEnv,
  readHead: (head: Compiled) => readonly ForeignRow[],
): Promise<Compiled | WritePlan> {
  let p = plan;
  while (p.kind === 'segment') {
    const rows = p.head ? readHead(p.head) : [];
    const foreign = await p.apply(rows, env);
    p = p.resume(foreign);
  }
  return p.compiled;
}
