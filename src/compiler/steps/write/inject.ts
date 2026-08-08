import { q, value, list } from '../../../sql/kernel/q.ts';
import { jsonbArrayOf } from '../../plan/plan.ts';
import { flattenListArgs, argValues, type SackSpec } from '../../../gremlin/frontend.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { patchLayout, type LoweringState } from '../context/context.ts';
import { toListStream, toScalarStream, type Stream } from '../context/stream.ts';
import { foldConstantCoercions, uniformInjectType } from '../../../gremlin/coerce.ts';
import { SCALAR_MEMBERS } from '../../../sql/kernel/render.ts';

/** Seed `inject(v1, v2, …)` as a shaped SOURCE on `carry`'s Query → the initial Stream plus the
 * index of the first step the generic lowering loop takes over at (a leading constant-coercion
 * prefix is folded into the literals here, so it may be > 1). List literals seed ListStream rows;
 * ordinary values seed ScalarStream rows.
 *
 * Takes a bare `LoweringState` rather than an Engine so the seed lands on whichever Query the caller is
 * building: the traversal's own at the top of a rooted chain (`Engine.seedRooted`), or the SHARED one
 * when inject() heads a `union()` SOURCE branch (`g.union(__.inject(1), __.inject(2))`) — where
 * the arm's relation has to sit in the same WITH as its siblings'.
 *
 * There is no `compileInject` any more, and its absence is the point: `inject()` is a READ, so it is
 * seeded by the ordinary rooted-source path like `V()`/`E()`/`union()` and lowered by the ordinary
 * loop. It used to have a whole-traversal entry point of its own purely because the WRITE dispatcher
 * routed it (plan §Phase 1). */
export function seedInject(carry: LoweringState, steps: IRStep[], sackInit?: SackSpec): { stream: Stream; at: number } {
  const Q = carry.q;

  // Each all-array argument is one list traverser, not scalar varargs.
  if (steps[0].args.length >= 1 && steps[0].args.every((a) => Array.isArray(a.value))) {
    if (sackInit) throw new Error('withSack() with a list-valued inject() not yet supported');
    const rows = steps[0].args.map((a) => q`(${jsonbArrayOf(a.value)})`);
    const rel = Q.cte(q`VALUES ${list(rows, ', ')}`, ['list']);
    return { stream: toListStream(carry, rel, SCALAR_MEMBERS), at: 1 };
  }

  // Mixed list/scalar inject remains the historical flattened representation until
  // ScalarStream gains a per-row shape/type discriminant.
  const vals = flattenListArgs(argValues(steps[0]));
  // A bare rich value can still be framed at the root (Duration/Set/Map each has
  // established support), but scalar SQL ordering needs a bindable, typed compare
  // key for EVERY row. Do not let the untyped scalar representation reach SQLite
  // with a raw container bind: Orderability needs the variant stream's per-row
  // payload *and scalar-type* discriminants, not SQLite's storage-class order.
  const hasRichValue = vals.some((v) => v !== null && typeof v === 'object' && !(v instanceof Uint8Array));
  if (hasRichValue && steps.slice(1).some((s) => s.name === 'order'))
    throw new Error('order() on heterogeneous injected values requires typed variant Orderability');
  const folded = foldConstantCoercions(steps, vals);
  // withSack(init) seeds every inject traverser's carried sack column (`sk`), exactly
  // as seedSource does for V()/E() — so withSack(x).inject(v).sack(...) carries state.
  const sackCarry: LoweringState = sackInit
    ? { ...carry, traverserLayout: patchLayout(carry.traverserLayout, { sack: 'sk' }) }
    : carry;
  const cols = sackInit ? ['v', 'sk'] : ['v'];
  const row = (v: any) => sackInit ? q`(${value(v)}, ${value(sackInit.init)})` : q`(${value(v)})`;
  const rel = vals.length
    ? Q.cte(q`VALUES ${list(vals.map(row), ', ')}`, cols)
    : Q.cte(sackInit ? q`SELECT NULL AS v, NULL AS sk WHERE 0` : q`SELECT NULL AS v WHERE 0`, cols);
  // A bare inject (no coercion consumed, folded.at===1) of a uniform TEXT-stored literal keeps
  // its declared type so it frames correctly (e.g. a long > 2^53 as a Long, not a string).
  const as = folded.as ?? (folded.at === 1 ? uniformInjectType(steps, vals.length) : undefined);
  // A bare inject(null) seeds a single compile-time-known null traverser. Flag it so a following
  // collection step raises TinkerPop's null-incoming message rather than the scalar-incoming one.
  const literalNull = vals.length === 1 && vals[0] === null;
  return { stream: toScalarStream(sackCarry, rel, as, { literalNull }), at: folded.at };
}

