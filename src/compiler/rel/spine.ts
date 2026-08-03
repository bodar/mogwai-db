import { derived } from '../../sql/kernel/q.ts';
import type { Compiled } from '../../sql/kernel/render.ts';
import { emitRelational } from '../../rel/emit.ts';
import { cfLimitViolation } from '../../cf-limits.ts';
import type { AliasMap, TraverserLayout } from '../steps/context/context.ts';
import { channelCols, type Channels, type ChannelRole } from '../../channels.ts';
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
/**
 * §2's VOCABULARY BOUNDARY, in one place: the neutral channel core a RelIR node speaks, translated
 * into the `TraverserLayout` struct the framing layer reads.
 *
 * A `Record<ChannelRole, …>` rather than a chain of `if`s, and for the reason the two policy tables
 * in `src/channels.ts` are: **a role added to the core fails the build here until its framing
 * translation is declared.** The alternative — widening an ad-hoc check each time — is how a
 * carried field gets dropped at a seam, which is 33% of this repo's diagnosed defects. A role whose
 * entry is `null` is one RelIR may carry and this seam cannot yet express; it THROWS rather than
 * silently omitting the column, and that throw is a bug in whichever lowering produced it, not a
 * deferral, so it must not be caught.
 */
const LAYOUT_FIELD: Readonly<Record<ChannelRole, keyof TraverserLayout | 'named' | null>> = {
  bulk: 'bulk',
  encounter: 'encounter',
  sack: 'sack',
  fromV: 'fromV',
  // An ALIAS is the one role whose framing form is a NAME→column MAP rather than a column, and it
  // cannot be otherwise: a Gremlin label name is not something a `Channel` may know (§2), so the
  // mapping is compiler-side state the lowering hands over beside the plan and `named` is what says
  // so. The check below is what keeps that from being a claim — the map's columns must be exactly the
  // relation's alias channels.
  alias: 'named',
  // Still not a single column and still not translated: a path is a position list and an
  // origin/branch-order is a stack. Each needs a shape this translation does not have, so each is
  // declared absent rather than left to be forgotten.
  path: null,
  origin: null,
  branchOrder: null,
};

function layoutOf(channels: Channels, aliases: AliasMap): TraverserLayout {
  const layout: TraverserLayout = { aliases, origins: [], branchOrders: [] };
  for (const channel of channels) {
    const field = LAYOUT_FIELD[channel.role];
    if (!field) throw new Error(`RelIR spine: no framing translation for the '${channel.role}' channel role`);
    if (field !== 'named') Object.assign(layout, { [field]: channel.col });
  }
  // THE NAME MAP AND THE RELATION MUST AGREE, and this is where that is provable rather than assumed.
  // A layout claiming an alias column the relation does not emit makes `rel.c[entry.col]` `undefined`,
  // and an `undefined` spliced into a `q` template is a type error at no layer — the framing layer
  // then reads a column that is not there and returns a silent empty result. A THROW, not a decline:
  // the two are built by one fold, so a disagreement is a bug in this route, never a deferral.
  const claimed = [...aliases.values()].map((entry) => entry.col).sort();
  const carried = channelCols(channels.filter((channel) => channel.role === 'alias')).slice().sort();
  if (claimed.length !== carried.length || claimed.some((column, i) => column !== carried[i]))
    throw new Error(`RelIR spine: the alias map names [${claimed}] but the result relation carries [${carried}]`);
  return layout;
}

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
  // The header and the carried layout are the RESULT RELATION's own, read off the plan rather than
  // handed over beside it: `plan.result` declares both, and a lowering that passed them separately
  // was two chances for the framing layer to be told a shape the relation did not have. (A `name`
  // pass binding is never the root, so the result is the relation the fold finished on.)
  const result = lowered.plan.result;
  const rel = derived(emitRelational(lowered.plan), result.type.cols.map((column) => column.name), 'rir');
  const traverserLayout = layoutOf(result.channels, lowered.aliases);
  // TOTAL over the framing union: a stream kind the lowering learns to produce is a compile error
  // here until this seam knows how to frame it, which is the same discipline §3.5's obligation
  // table applies inside the algebra.
  const state = { q: engine.q, params, rel, traverserLayout };
  const framing = lowered.framing;
  const stream: Stream = framing.kind === 'elements'
    ? { kind: 'elements', ...state, elem: framing.elem }
    : framing.kind === 'list'
      ? { kind: 'list', ...state, of: framing.of, ...(framing.set ? { set: framing.set } : {}) }
      : { kind: 'scalar', ...state, type: framing.type, ...(framing.result ? { result: framing.result } : {}) };
  // Zero steps remain, so the loop runs the root element projection and nothing else. Going
  // through `lowerSteps` rather than calling the projection directly is the point: a step this
  // route grows tomorrow lands in the SAME loop, and there is no second orchestrator.
  const compiled = materializeRootStream(engine.lowerStepsStrict(stream, steps, steps.length));
  // THE LAST BUDGET CHECK IS THE PLATFORM'S OWN, MEASURED ON WHAT A DURABLE OBJECT ACTUALLY GETS.
  //
  // `lowerToRel` owns the BIND decision and now renders to take it, so this is a backstop for the
  // two things that decision cannot see: whatever binds the FRAMING layer adds on top of the RelIR
  // relation (zero for every shape measured today, but it is framing's number and not ours), and
  // the 100 KB statement-TEXT cap, which §3.6 gives the plan and nothing else enforced. Both come
  // from `cfLimitViolation` — the one authority for what the platform refuses — because a second
  // constant here would be a second chance to disagree with it.
  //
  // A DECLINE and not a throw: legacy answers these today, and a plan we cannot ship is coverage we
  // do not have. If it ever fires, the census's per-query spine ratchet is what reports it.
  if (cfLimitViolation(compiled.sql, compiled.binds)) return null;
  return { ...compiled, spine: 'rel' };
}
