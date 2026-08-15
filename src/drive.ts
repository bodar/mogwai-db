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
// See docs/2026-08-07-edge-compilation-plan.md §4·2 and §4·4.

import type { Compiled, Executable } from './sql/kernel/render.ts';
import type { Plan } from './compiler/segment.ts';
import type { BarrierInput } from './services/spi/types.ts';
import type { TypeNode } from './gremlin/types.ts';

/** The collaborators the trampoline needs, injected so the SAME loop runs in either runtime.
 *
 *  - `compile` — a (sub-)traversal to a `Plan` at this federation hop depth. In-process this is
 *    `compilePlan` bound to the app scope; the depth threads so a nested federate hops at depth+1.
 *  - `readHead` — drain a barrier segment's HEAD (an ordinary `Compiled`) into the barrier's input
 *    rows. In-process a synchronous `store.query`; Worker-side (Phase 2) an RPC to the DO. Returns a
 *    Promise-or-value so the Worker impl can be async without changing this loop. */
export interface SegmentHost {
  compile(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>, federationDepth: number): Plan;
  readHead(head: Compiled): BarrierInput[] | Promise<BarrierInput[]>;
}

/** Drive an ALREADY-COMPILED plan to its final synchronous `Executable`, given only a `readHead`. A
 *  non-segmented plan returns immediately; a barrier loops: read+drain the head → await `apply` → land
 *  the foreign rows + `resume` into the next Plan. This is the ONE await boundary of the read/federation
 *  path. Split from the initial compile so a caller that already holds the first Plan (the Worker edge,
 *  which compiles to PEEK residency before deciding to drive) reuses this loop without recompiling. */
export async function driveSegmentsFrom(readHead: SegmentHost['readHead'], first: Plan): Promise<Executable> {
  let p: Plan = first;
  while (p.kind === 'segment') {
    const rows = p.head ? await readHead(p.head) : [];
    const foreign = await p.apply(rows);
    p = p.resume(foreign, rows);
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
): Promise<Executable> {
  return driveSegmentsFrom(host.readHead, host.compile(gremlin, params, paramTypes, federationDepth));
}
