import type { Channel } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, compilerNull, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { UNKNOWN } from '../../sql/kernel/render.ts';
import { arg, type SackSpec } from '../../gremlin/frontend.ts';
import { SACK_OPS } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import { carriedCols, meta, payloadCols, typeOf, type Minter } from './build.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { constLit } from './const.ts';
import type { RelFraming } from './framing.ts';
import { byExpr, modulations, productivityFilter } from './modulator.ts';

/**
 * THE SACK — a per-traverser accumulator, as an ordinary carried CHANNEL.
 *
 * `withSack(seed)` starts every traverser with a copy of the seed, `sack(Operator.x).by(v)` folds a
 * value into it, and a bare `sack()` makes it the current object. Three steps over one column.
 *
 * ## Why this module is small, and why that is the interesting part
 *
 * `src/channels.ts` already models `sack` completely: a `ChannelRole` with a merge policy
 * (`identical`), a barrier policy (`drop`), a slot in `ROLE_ORDER` before every other role, and a
 * group policy of `undefined` — so a movement collapse that would take one traverser's sack for
 * another's REFUSES by construction rather than by anyone remembering. `build.ts` declares the
 * column's type. None of that was written for this; it is what the channel core is.
 *
 * So nothing here re-projects a layout, and nothing here has to ask whether a sack may coexist with
 * an alias or a path. Legacy's version does both — it hand-rolls the re-projection with a comment
 * warning that appending the column in the wrong slot silently desyncs the declared schema from the
 * physical one, and it THROWS outright on `aliases.size || path` — and its header defers sack
 * through repeat, through a barrier, through `local`, and split/merge on a fork. Every one of those
 * is a channel-obligation question, which is the class §3.5's checker answers for every channel at
 * once. That is the whole argument for this being a rewrite rather than a port: the 94 lines being
 * replaced solve problems this layer does not have.
 *
 * ## What it does NOT do yet, and both are honest declines
 *
 * - **`withSack(seed, Operator.x)`** — the two-argument form names a MERGE operator, which decides
 *   how two traversers' sacks combine when bulking merges them. `CHANNEL_MERGE_POLICY` says
 *   `identical` today: two rows may merge only where their sacks already agree. A declared merge
 *   operator is a THIRD policy answer for the role, and adding one is a channels-core change rather
 *   than a step lowering, so the form declines here rather than silently ignoring the operator.
 * - **`barrier(Barrier.normSack)`** — normalizing the sack across a barrier is its own step.
 */

/** The sack's column. One name, because the seed, the mutation and the read must agree and the
 *  framing layer never sees it — a sack is spent by the time a payload is projected. */
export const SACK_COL = 'sack';
const SACK_CHANNEL: Channel = { col: SACK_COL, role: 'sack' };

/** Does this relation carry a sack? Asked of the RELATION rather than of a flag, for `liveAliases`'
 *  reason: a barrier consumes the channel (`CHANNEL_BARRIER_POLICY`), and a reader that trusted a
 *  chain-level "there is a sack" would compile a reference to a column that is no longer there. */
export const sackCarried = (rel: Rel): boolean => rel.channels.some((channel) => channel.role === 'sack');

/**
 * `withSack(seed)` — the channel, seeded onto whatever the source produced. `null` declines.
 *
 * A separate node rather than an arm of each source's own seed projection, and deliberately: the
 * element scan and `inject()` build their rows differently and agree about nothing except that a
 * sack is carried state layered on top. The assembler fuses it back into one SELECT, so the extra
 * node costs nothing and the seeding rule has one home.
 */
export function seedSack(rel: Rel, spec: SackSpec, fresh: Minter): Rel | null {
  // A merge operator is a channel-policy question, not a seed value — see the module header.
  if (spec.mergeOp !== undefined) return null;
  const seed = constLit(arg(spec.init, spec.initType as never, null));
  if (!seed) return null;
  const channels = withChannel(rel.channels, SACK_CHANNEL);
  const payload = payloadCols(rel);
  return make.project({
    id: fresh('sks'), input: rel, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      ...channels.map((channel) => [channel.col,
        channel.col === SACK_COL ? seed : col(rel.id, channel.col)] as const),
    ],
  });
}

/**
 * `sack(Operator.x).by(v)` — fold a value into the sack. `null` declines.
 *
 * The `by()` comes through the ordinary modulator seam, so a property key, a `T` token, an alias read
 * and a correlated child body are all available here the day they are available anywhere — which is
 * the difference from legacy, whose `sackByValue` accepts a string key and a token and refuses a
 * nested traversal outright.
 *
 * PRODUCTIVITY is the vocabulary's: a `by()` that yields nothing DROPS the traverser, exactly as it
 * does at `order()` and `dedup()`, so the rule is asked for rather than restated.
 */
export function sackMutate(
  step: IRStep, rel: Rel, host: ChildHost, child: ChildSeam, fresh: Minter,
): Rel | null {
  const operator = sackOperator(step);
  if (!operator || !SACK_OPS.has(operator)) return null;
  // `assign` REPLACES, so it needs no prior value and MINTS the channel where the traversal declared
  // no `withSack()` — which is why `g.V().sack(assign).by('age').sack()` is a complete traversal.
  // Every other operator combines with what is there and declines without it, the same rule legacy
  // states as `sack(Operator.x) requires withSack() or a prior sack(assign)`.
  const carried = sackCarried(rel);
  if (!carried && operator !== 'assign') return null;
  // ONE `by()` — TinkerPop's own rule (`Sack step can only have one by modulator`), and a chain with
  // more is invalid Gremlin the Pass tier raises for, not a shape to pick a slot from.
  const bys = modulations(step, 1, child);
  if (!bys) return null;
  const value = byExpr(bys[0] ?? { key: { kind: 'identity' } }, host, fresh, false, child);
  if (!value) return null;

  // THREE NODES, and the middle one is why: the by() value has to be FILTERED on before it is folded
  // in, and a `Filter` between the fold and the relation the fold reads would put that relation one
  // level too far away (§3.3 — a `Col` names a relation in SCOPE, and scope is a node's direct
  // children). So the value is NAMED first, the drop reads the name, and the fold reads it again.
  // Spelling the by() expression once is the other half of the reason: it is routinely a correlated
  // subquery, and a filter that re-inlined it would spell the whole thing twice.
  const held = 'skv';
  const payload = payloadCols(rel);
  // A MINTING `assign` adds the channel here, in the same projection that names the value — so the
  // fold below reads a column that exists whether or not a `withSack()` seeded one.
  const channels = carried ? rel.channels : withChannel(rel.channels, SACK_CHANNEL);
  const named = make.project({
    id: fresh('skb'), input: rel, channels,
    type: typeOf(...payload, meta(held, 'any', true), ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      [held, value],
      ...channels.map((channel) => [channel.col,
        channel.col === SACK_COL && !carried ? compilerNull() : col(rel.id, channel.col)] as const),
    ],
  });
  const drop = productivityFilter(step, col(named.id, held));
  const kept = drop
    ? make.filter({ id: fresh('skf'), input: named, channels: named.channels, type: named.type, pred: drop })
    : named;
  const folded = combine(operator, col(kept.id, held), col(kept.id, SACK_COL));
  if (!folded) return null;
  return make.project({
    id: fresh('skm'), input: kept, channels: kept.channels, type: typeOf(...payload, ...carriedCols(kept.channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(kept.id, column.name)] as const),
      ...kept.channels.map((channel) => [channel.col,
        channel.col === SACK_COL ? folded : col(kept.id, channel.col)] as const),
    ],
  });
}

/**
 * A bare `sack()` — the sack VALUE becomes the traverser, which is a retype like `values()` and
 * `count()` and lands in the scalar tail through the ordinary dispatcher.
 *
 * The channel rides THROUGH rather than being consumed: `sack()` reads the accumulator, it does not
 * spend it, so `sack().is(P.lt(59))` inside a `repeat()` body still has one afterwards.
 *
 * `UNKNOWN` is the honest type, and it is legacy's answer too. A sack's type is the seed's until an
 * operator changes it — `div` forces a REAL, `assign` takes the by()'s — so a static tag would be a
 * claim the fold cannot support past the first mutation. Carrying it properly is the §6·7 shape and
 * a separate increment; claiming it now would be the guess that section exists to end.
 */
export function sackRead(rel: Rel, fresh: Minter): { readonly rel: Rel; readonly framing: RelFraming } | null {
  if (!sackCarried(rel)) return null;
  return {
    rel: make.project({
      id: fresh('skr'), input: rel, channels: rel.channels,
      type: typeOf(meta('v', 'any', true), ...carriedCols(rel.channels)),
      exprs: [['v', col(rel.id, SACK_COL)],
        ...rel.channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
    }),
    framing: { kind: 'scalar', type: UNKNOWN },
  };
}

/** The `Operator` a `sack()` names, or `undefined` for the bare READ form. */
export const sackOperator = (step: IRStep): string | undefined =>
  (step.args ?? []).map((a) => a.value)
    .find((value): value is { readonly operator: string } =>
      typeof value === 'object' && value !== null && typeof (value as { operator?: unknown }).operator === 'string')
    ?.operator;

/**
 * The fold, in the algebra — legacy's `combineSack` re-expressed rather than shared, which is §6·4's
 * split exactly: the operator SET is data both spines must agree on (`SACK_OPS`, `ir/step.ts`), the
 * SQL is emission and belongs to whichever layer emits it.
 *
 * `div` forces REAL division because SQLite's `/` is integer division on integer operands, which is
 * the one arm where the obvious spelling answers a different question.
 */
function combine(operator: string, value: Expr, sack: Expr): Expr | null {
  const binary = (op: '+' | '-' | '*'): Expr => ({ kind: 'binary', op, left: sack, right: value });
  switch (operator) {
    case 'assign': return value;
    case 'sum': return binary('+');
    case 'minus': return binary('-');
    case 'mult': return binary('*');
    case 'div': return { kind: 'binary', op: '/', left: { kind: 'cast', arg: sack, to: 'real' }, right: value };
    case 'min': return { kind: 'call', fn: 'MIN', args: [sack, value] };
    case 'max': return { kind: 'call', fn: 'MAX', args: [sack, value] };
    default: return null;
  }
}
