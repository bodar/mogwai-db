import { derived } from '../../sql/kernel/q.ts';
import type { Compiled } from '../../sql/kernel/render.ts';
import { emitRelational } from '../../rel/emit.ts';
import type { TraverserLayout } from '../steps/context/context.ts';
import type { Stream } from '../steps/context/stream.ts';
import { materializeRootStream } from '../steps/tail/materialize.ts';
import type { Engine } from '../engine/deps.ts';
import type { IRStep } from '../ir/strategies.ts';
import { lowerToRel } from './lower.ts';

/**
 * THE ROUTING SEAM — Gremlin in, `Compiled` out, or `null` for "the legacy spine owns this".
 *
 * `lower.ts` answers whether the chain is covered; this module is what makes a covered chain a
 * finished read, and the split matters because the two halves have different rules. Lowering is
 * pure and must never throw for uncovered vocabulary; this side crosses into the framing layer,
 * which is legacy on purpose and stays that way (§2 — shape is resolved above RelIR).
 *
 * ## The RelIR plan is ONE RELATION to the framing layer
 *
 * `emitRelational` hands back the whole program as a kernel `Expression`, `WITH` list and all, and
 * `derived()` makes it a `Relation` the existing element projection selects from exactly as it
 * selects from the legacy `c0`. Three things fall out of that, all of them wanted:
 *
 * - **binds stay in one `render`.** Composing an `Expression` rather than splicing a rendered
 *   string is what stops a second bind-ordering authority existing.
 * - **CTE-versus-inline stays RelIR's decision** (§4.6, the `name` pass), instead of leaking into
 *   the framing `Query`'s `c0…cN` namespace where the two naming schemes would have to agree.
 * - **no framing code is duplicated.** The element payload projection, its label and property
 *   joins and its `Shape` are reached through the ordinary lowering loop with zero steps left, so
 *   this route frames identically to the legacy one BY CONSTRUCTION rather than by comparison.
 *
 * What it is NOT is an opaque escape node: nothing legacy enters a `Rel`. The traffic is one-way —
 * a finished RelIR relation is consumed by framing — which is the direction §10·4 permits.
 */
export function compileViaRel(engine: Engine, steps: IRStep[], params: Record<string, any>): Compiled | null {
  // TWO fast-path switches reach the lowering, and for the same reason: each selects between two
  // lowering STRATEGIES that the algebra can state, rather than between two physical access paths
  // (which is the FTS case, where RelIR declines instead). `movementCollapse` picks the grouped
  // `SUM(bulk)`; `predicateInlining` picks the correlated `EXISTS` over the materialized
  // child-existence gate, and RelIR implements only the first of that pair — so with the switch off
  // a `where()` body declines exactly as an unlearned step would. Both positions therefore stay
  // live and L5's differential still has two forms to compare.
  const lowered = lowerToRel(steps, {
    params,
    collapse: engine.fastPaths.movementCollapse,
    correlatedChildren: engine.fastPaths.predicateInlining,
  });
  if (!lowered) return null;

  // `rir` deliberately does not collide with the framing aliases (`n`/`e`/`p`/`s`/`v`/`g`/`j`/`l`)
  // or with the `Query`'s minted `c0…cN`: the RelIR relation sits beside them, not among them.
  const rel = derived(emitRelational(lowered.plan), lowered.cols, 'rir');
  // The framing layer's own carried-state vocabulary. RelIR proved which columns are channels and
  // what role each plays (`lowered.channels`); translating that into the struct the framing layer
  // reads is this seam's job and no RelIR node's — §2's vocabulary boundary, in one place. The
  // roles a lowering can currently produce are `bulk` or nothing, so the translation is that
  // narrow; it widens with the roles, and a role RelIR carries that this cannot express must fail
  // here rather than be dropped.
  const carried = lowered.channels.map((channel) => channel.role);
  if (carried.some((role) => role !== 'bulk')) throw new Error(`RelIR spine: no framing translation for channel role(s) ${[...new Set(carried)].join(', ')}`);
  const traverserLayout: TraverserLayout = {
    aliases: new Map(), origins: [], branchOrders: [], ...(carried.includes('bulk') ? { bulk: 'bulk' } : {}),
  };
  // TOTAL over the framing union: a stream kind the lowering learns to produce is a compile error
  // here until this seam knows how to frame it, which is the same discipline §3.5's obligation
  // table applies inside the algebra.
  const state = { q: engine.q, params, rel, traverserLayout };
  const stream: Stream = lowered.framing.kind === 'elements'
    ? { kind: 'elements', ...state, elem: lowered.framing.elem }
    : { kind: 'scalar', ...state, type: lowered.framing.type, ...(lowered.framing.result ? { result: lowered.framing.result } : {}) };
  // Zero steps remain, so the loop runs the root element projection and nothing else. Going
  // through `lowerSteps` rather than calling the projection directly is the point: a step this
  // route grows tomorrow lands in the SAME loop, and there is no second orchestrator.
  const compiled = materializeRootStream(engine.lowerStepsStrict(stream, steps, steps.length));
  return { ...compiled, spine: 'rel' };
}
