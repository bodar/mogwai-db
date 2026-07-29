// ---------- the lowering-engine interface (a dependency-object leaf) ----------
//
// The compiler's lowering CORE is a dependency-injected OBJECT (the Engine, engine.ts) rather
// than a bag of free functions that read their dependencies (fastPaths/registry/federationDepth)
// off the per-query STATE object (LoweringState, context.ts). This module is the cycle-free LEAF that
// declares the Engine's shape: the recursive-lowering surface every step family calls back into,
// plus the ambient dependencies it exposes.
//
// Why a leaf interface: the family compilers (child/projection/scalar/branch/match/correlated/
// bulk/write/list/inject/call) recurse into lowering, and the Engine dispatches back out to those
// same families — a literal import cycle when both are concrete. The families import ONLY this
// interface (a leaf type, erased at runtime); the concrete Engine (engine.ts) is built once per
// compile in the compile-scope container and reached through `stream.q.engine`. So the source
// graph is a DAG: deps.ts (interface) ◂ family impls ◂ engine.ts (concrete) ◂ compiler.ts.
//
// The Engine RIDES THE QUERY (`Query.engine`, q.ts): the per-compile `Query` (the CTE
// accumulator) is exactly co-lifecycle with the ambient dependencies, and it already threads
// through every Stream as `st.q`. Attaching the Engine there — NOT as a field on LoweringState — is what
// lets the families reach lowering + deps without any parameter threading, while LoweringState stays PURE
// per-query state (q/params/carried/sideEffects).

import type { Query } from '../../sql/kernel/q.ts';
import { fastPathContext, type FastPathConfig, type FastPathContext } from '../options/fast-paths.ts';
import type { ServiceRegistry } from '../../services/spi/types.ts';
import type { SackSpec } from '../../gremlin/frontend.ts';
import type { PStep } from '../ir/strategies.ts';
import type { ChainFacts } from '../ir/analyze.ts';
import type { Compiled } from '../../sql/kernel/render.ts';
import type { SegmentPlan } from '../segment.ts';
import type { LoweringState, ElementStream } from '../steps/context/context.ts';
import type { Stream, LoweringSuspension } from '../steps/context/stream.ts';

/** The lowering engine: the recursive-traversal authority (dispatcher + prefix fold + shaped
 *  lowering loop) plus the ambient compile dependencies. Built per-compile from a CompilerScope
 *  and attached to that compile's Query, so every family reaches it via `stream.q.engine`. */
export interface Engine {
  // ---- ambient dependencies (were LoweringState fields; now held by the object) ----
  readonly fastPaths: FastPathConfig;
  readonly registry: ServiceRegistry;
  readonly federationDepth: number;

  // ---- the recursive-lowering surface the step families call back into ----

  /** Fold the PREFIX dispatch (movement/filter/branch) over `steps` from `from`, threading the
   *  ElementStream; stops at the first non-prefix step and reports where. */
  lowerElementSteps(steps: PStep[], seedSt: ElementStream, from?: number): { stream: ElementStream; next: number };

  /** lowerElementSteps that must consume the WHOLE sequence — returns the stream or null. THE one
   *  element-body fold for every child position (materialized and correlated alike): it crosses a
   *  `select(label)` re-root by applying the root's own selectOneFromAlias and folding on. */
  tryLowerElementSteps(steps: PStep[], seed: ElementStream): ElementStream | null;

  /** Seed an ELEMENT source (V/E, or a union whose arms merge to elements) + fold its prefix;
   *  returns the stream and where the prefix ends. Uses THIS engine's Query — one prefix per
   *  engine. `facts` supplies tracksPath + demandsEncounter for the seed; omitted → the impl
   *  computes analyzeChain(steps) itself. */
  buildPrefix(steps: PStep[], params?: Record<string, any>, sackInit?: SackSpec, facts?: ChainFacts): { st: ElementStream; stop: number };

  /** Lower a fully ROOTED chain to its relational Stream, of whatever shape it produces — the
   *  `union()` SOURCE arm compiler. compileRead's spine minus the root materialization (a branch
   *  merge consumes a relation, not a framed leaf). `facts` imposes the OUTER chain's
   *  path/encounter demands, which a branch's own text cannot show. */
  lowerRootedArm(steps: PStep[], params: Record<string, any>, sackInit?: SackSpec, facts?: ChainFacts): Stream;

  /** buildPrefix on a FRESH child engine (fresh Query, same app scope) — for the write path, which
   *  materializes several independent target-id relations in one traversal (each needs its own WITH,
   *  and its own engine on the stream so movement/filter reach deps). */
  buildPrefixFresh(steps: PStep[], params?: Record<string, any>): { st: ElementStream; stop: number };

  /** A FRESH child engine (fresh Query, same app scope). For a source constructor (inject()) that
   *  builds its own seed relation on the fresh Query and then lowers the chain through it.
   *  `fastPaths` overrides the inherited config for this sub-compile — the bulk-repeat handoff
   *  forces movementCollapse on, since its unrolled frontier is a collapsed (id, bulk) stream. */
  subEngine(params?: Record<string, any>, fastPaths?: FastPathConfig): Engine;

  /** A variant engine sharing THIS engine's dependencies but bound to `q` — for the correlated
   *  inline child, which lowers movement/filter over the kernel's `DerivedQuery` (nested derived
   *  subqueries, not shared CTEs). The returned engine attaches itself to `q`. */
  withQuery(q: Query): Engine;

  /** THIS engine's fresh CTE-accumulator Query (the one attached to every stream it lowers). */
  readonly q: Query;

  /** The iterative shaped-lowering orchestrator (root + child scope). May SUSPEND at a barrier. */
  lowerSteps(initial: Stream, steps: PStep[], from: number): Stream | LoweringSuspension;

  /** lowerSteps for a scope that structurally cannot host a barrier (child / nested sub-compile). */
  lowerStepsStrict(initial: Stream, steps: PStep[], from: number): Stream;

  /** A read traversal: prefix fold + shaped lowering loop. A source barrier call() suspends. */
  compileRead(steps: PStep[], params?: Record<string, any>, sackInit?: SackSpec): Compiled | SegmentPlan;

  /** compileRead narrowed to a synchronous Compiled, minting a FRESH compile scope (fresh Query,
   *  same app scope) for the nested sub-traversal — a within()/all() operand, a merge body. */
  compileReadCompiled(steps: PStep[], params?: Record<string, any>, sackInit?: SackSpec): Compiled;
}

/** The lowering Engine riding a stream's Query. Every stream reached during a compile carries the
 *  Engine (attached at construction); reaching it here (rather than off LoweringState) is what keeps the
 *  ambient dependencies OFF the per-query state. A missing engine is a wiring bug (a stream built
 *  outside a compile scope) — fail loud, never silently default. */
export function engineOf(c: LoweringState): Engine {
  const e = c.q.engine;
  if (!e) throw new Error('no lowering engine on this Query — a stream was built outside a compile scope');
  return e;
}

/** The FastPathContext for a stream/LoweringState — the two-hop `fastPathContext(engineOf(c).fastPaths)`
 *  named once, since every family fast-path site needs exactly this. (facts stays out: the only
 *  chain-fact a FastPath reads, movementCollapse's collapseSafe, is already folded into the flag.) */
export const fastPathContextOf = (c: LoweringState): FastPathContext => fastPathContext(engineOf(c).fastPaths);
