// ---------- the segment trampoline (edge-compilation Phase 0) ----------
//
// A read traversal is normally ONE compile-to-SQL statement (`{kind:'sql'}`, zero async overhead). A
// BARRIER service (federate, io, and the planned OLAP/regex barriers) suspends the compile into a
// PLAN of segments glued by service boundaries; the async gap happens ONLY between segments (a DO
// SQLite cursor cannot cross an await). This module owns the trampoline that drives that plan.
//
// It is a FREE FUNCTION over an injected host, not a method on Executor, so the identical loop runs
// in-process on Bun (host.readHead is a local sync query) and Worker-side on Cloudflare (host.readHead
// is an RPC to the DO). That injection is the whole point of §4·4: the loop's OWNERSHIP no longer
// belongs to the store tier, which is what lets the Worker drive federation in Phase 2 without a second
// copy of the loop. Phase 0 changes ONLY where the loop lives — behaviour is identical to the former
// `Executor.drive` — and today exactly one host exists (execute.ts's Executor builds it).
// See docs/archive/2026-08-07-edge-compilation-plan.md §4·2 and §4·4.

import type { Compiled, Executable } from './sql/kernel/render.ts';
import type { Plan } from './compiler/segment.ts';
import type { BarrierInput } from './services/spi/types.ts';
import type { TypeNode } from './gremlin/types.ts';

/** The two head readers a barrier segment needs, split by the SYNC/ASYNC contract (`compiler/segment.ts`).
 *
 *  - `readHead` — an ASYNC barrier's head: in-process a synchronous `store.query`, Worker-side an RPC to
 *    the DO. Promise-or-value so the Worker impl can be async without changing the loop.
 *  - `readHeadSync` — a SYNC barrier's head, read WITHOUT any await so the barrier stays atomic (nothing
 *    interleaves). Always a local `store.query`; a sync barrier is never Worker-driven, so the Worker
 *    edge supplies a throwing stub (routing a sync segment to the DO's own drive instead). */
export interface SegmentReaders {
  readHead(head: Compiled): BarrierInput[] | Promise<BarrierInput[]>;
  readHeadSync(head: Compiled): BarrierInput[];
}

/** The collaborators the trampoline needs, injected so the SAME loop runs in either runtime.
 *  `compile` turns a (sub-)traversal into a `Plan` at this federation hop depth. */
export interface SegmentHost extends SegmentReaders {
  compile(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>, federationDepth: number, detached: boolean): Plan;
}

/** Drive an ALREADY-COMPILED plan to its final `Executable`. A non-segmented plan returns immediately.
 *  A SYNC barrier is driven with NO await — head read synchronously, then `resume` — so it interleaves
 *  with nothing (`compiler/segment.ts`). An ASYNC barrier loops through the one await boundary: read the
 *  head → await `apply` → `resume`. Split from the initial compile so a caller that already holds the
 *  first Plan (the Worker edge) reuses this loop without recompiling. */
export async function driveSegmentsFrom(readers: SegmentReaders, first: Plan): Promise<Executable> {
  let p: Plan = first;
  while (p.kind === 'segment') {
    if (p.mode === 'sync') { p = p.resume(readers.readHeadSync(p.head)); continue; }
    const rows = p.head ? await readers.readHead(p.head) : [];
    const foreign = await p.apply(rows);
    p = p.resume(foreign, rows);
  }
  return p.compiled;
}

/** Drive a plan SYNCHRONOUSLY — the `framed()` path. Only SYNC barriers can be resolved here; an ASYNC
 *  barrier THROWS (there is no await to run its transform). This is what makes a sync barrier's "no async
 *  bit" a property of the CALL PATH, not just of the transform: regex runs to completion with zero
 *  suspension, so nothing can mutate the store mid-query. */
export function driveSegmentsSync(readHeadSync: SegmentReaders['readHeadSync'], first: Plan): Executable {
  let p: Plan = first;
  while (p.kind === 'segment') {
    if (p.mode !== 'sync')
      throw new Error('this traversal suspends at an async barrier (a federated call(), or io()) — use the async path (framedAsync / raw), not the sync framed()/buffers()');
    p = p.resume(readHeadSync(p.head));
  }
  return p.compiled;
}

/** Compile a traversal, then drive it — the ordinary entry point (in-process `Executor`). */
export function driveSegments(
  host: SegmentHost,
  gremlin: string,
  params: Record<string, any>,
  paramTypes: Record<string, TypeNode>,
  federationDepth: number,
  detached = false,
): Promise<Executable> {
  return driveSegmentsFrom(host, host.compile(gremlin, params, paramTypes, federationDepth, detached));
}
