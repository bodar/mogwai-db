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
import type { BarrierInput, BarrierRelation } from './services/spi/types.ts';
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
  /** Drop the scratch rows of barrier runs allocated by a drive that then THREW — the leak-on-throw
   *  belt. The happy path defers this to `frameResolved`'s `finally` (via `plan.cleanup`, populated only
   *  once the FULL chain has driven), so a chain that throws at a LATER resume — after an earlier
   *  `apply` already wrote its rows — never reaches that cleanup and would orphan those rows for the
   *  isolate's life. The drive calls this from its own catch instead. The Worker edge drives only
   *  `federate` (which returns detached rows, never a relation run), so its impl is a no-op. */
  dropRuns(runs: readonly number[]): void;
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
  // OLAP DECORATE barriers leave their `(id → value)` result in the `barrier_state` scratch table,
  // keyed by a per-query `run` token; the FINAL plan's SQL reads those rows. Collect every such token
  // across the (possibly compounding) chain and hand them to the framer, which drops them once it has
  // produced the rows — precise post-frame GC. A non-relation barrier (federate/io) contributes none.
  const barrierRuns: number[] = [];
  try {
    while (p.kind === 'segment') {
      if (p.mode === 'sync') { p = p.resume(readers.readHeadSync(p.head)); continue; }
      const rows = p.head ? await readers.readHead(p.head) : [];
      const foreign = await p.apply(rows);
      if (!Array.isArray(foreign)) barrierRuns.push((foreign as BarrierRelation).run);
      p = p.resume(foreign, rows);
    }
    return barrierRuns.length ? { ...p.compiled, cleanup: barrierRuns } : p.compiled;
  } catch (error) {
    // A resume that DECLINES (a chained barrier's tail the lowering cannot cover) throws here, AFTER
    // earlier `apply`s wrote their rows — reachable now that barriers chain (item 4/6). That throw
    // never reaches `frameResolved`'s cleanup, so drop the runs allocated so far right here. Harmless
    // on the success path: `return` exits before this catch, so committed runs are dropped by the
    // framer, never twice.
    readers.dropRuns(barrierRuns);
    throw error;
  }
}

/** Drive a plan SYNCHRONOUSLY — the `framed()` path. Only SYNC barriers can be resolved here; an ASYNC
 *  barrier THROWS (there is no await to run its transform). This is what makes a sync barrier's "no async
 *  bit" a property of the CALL PATH, not just of the transform: regex runs to completion with zero
 *  suspension, so nothing can mutate the store mid-query. */
export function driveSegmentsSync(readers: Pick<SegmentReaders, 'readHeadSync' | 'dropRuns'>, first: Plan): Executable {
  let p: Plan = first;
  // OLAP barriers land their result in `barrier_state` under a run token; collect them for post-frame GC
  // exactly as the async drive does.
  const barrierRuns: number[] = [];
  try {
    while (p.kind === 'segment') {
      if (p.mode === 'sync') { p = p.resume(readers.readHeadSync(p.head)); continue; }
      // An ASYNC barrier with a SYNCHRONOUS CORE (the OLAP algorithms — a pure in-SQL loop, no real await)
      // runs HERE with no suspension: busy-locking is fine on the sync/test `framed()` path. Production keeps
      // the async `apply` so it can yield. A barrier WITHOUT a sync core (federate/io — real remote/object
      // I/O) genuinely cannot be driven synchronously, so it still refuses this path.
      if (!p.applySync)
        throw new Error('this traversal suspends at an async barrier (a federated call(), or io()) — use the async path (framedAsync / raw), not the sync framed()/buffers()');
      const rows = p.head ? readers.readHeadSync(p.head) : [];
      const out = p.applySync(rows);
      if (!Array.isArray(out)) barrierRuns.push((out as BarrierRelation).run);
      p = p.resume(out, rows);
    }
    return barrierRuns.length ? { ...p.compiled, cleanup: barrierRuns } : p.compiled;
  } catch (error) {
    // Same leak-on-throw belt as the async drive: a resume that declines after an earlier `applySync`
    // wrote rows never reaches the framer's cleanup. Drop the runs allocated so far. (A no-sync-core
    // barrier throws BEFORE allocating, so `barrierRuns` is empty there — the drop is a no-op.)
    readers.dropRuns(barrierRuns);
    throw error;
  }
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
