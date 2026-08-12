import { compilerInt, compilerNull, compilerText, type AggFn, type Expr } from '../../rel/expr.ts';
import { REDUCER_CLASSES } from '../../gremlin/types.ts';

/**
 * THE REDUCER VOCABULARY — `sum`/`min`/`max`/`mean` as one `Aggregate`, and Phase 4.3's named
 * deliverable ("the ten handlers become one `Aggregate` reading row→traverser cardinality off the plan
 * instead of ten handlers knowing it privately").
 *
 * The fourth vocabulary module, and the one with the least surface: a reducer is an aggregate function
 * over an ELIGIBILITY-guarded value, plus the result's dynamic storage class. What makes it a family
 * rather than four steps is that all four share the guard, the bulk-weighting rule and the `vt` column —
 * so getting any of those wrong once gets it wrong four times, which is the argument for one authority.
 *
 * ## The three policies, none of which is negotiable
 *
 * 1. **ELIGIBILITY.** A reducer takes its value only from a storage class it can act on: `sum`/`mean`
 *    do arithmetic and admit numbers, `min`/`max` do ORDERING and admit strings too because Gremlin's
 *    `Comparable` does. The guard yields NULL for anything else, so an ineligible value contributes
 *    NOTHING rather than coercing to 0 or ''. The class lists are `REDUCER_CLASSES` in
 *    `gremlin/types.ts` — read, not restated, because the arithmetic/comparable asymmetry is precisely
 *    what a second copy gets wrong.
 * 2. **BULK WEIGHTING**, and only for `sum`/`mean`. A value present at bulk N is N traversers, so a
 *    collapsing aggregate must flatten by the multiplicity; `min`/`max` are bulk-INVARIANT (the
 *    smallest of N copies is the smallest). Read off the CHANNEL, exactly as `countExpr` does — which
 *    is why an `inject` source (no multiplicity by construction) gets the unweighted form and an
 *    element source the weighted one, with no step knowing which it is in.
 * 3. **THE RESULT'S TYPE IS DYNAMIC.** `sum` of integers is an integer and of reals a real, so the
 *    framing reads a second column — `typeof(<the aggregate>)` — rather than a compile-time tag. `mean`
 *    is the exception: it is forced REAL, because integer division would silently answer 2 for the mean
 *    of 1 and 4. It is forced with a `Cast` and not legacy's `* 1.0`; the cast states the required
 *    storage class directly rather than relying on a spelling-level numeric token.
 */

export type Reducer = 'sum' | 'min' | 'max' | 'mean';
export const REL_REDUCERS: ReadonlySet<string> = new Set(['sum', 'min', 'max', 'mean']);
export const isReducer = (name: string): name is Reducer => REL_REDUCERS.has(name);

const agg = (fn: AggFn, arg: Expr): Expr => ({ kind: 'agg', fn, args: [arg] });
const call = (fn: string, arg: Expr): Expr => ({ kind: 'call', fn, args: [arg] });

/** 2^53 - 1: the widest a JS number (thus a plain SQLite read) holds exactly. EXPORTED because the
 *  legacy spine's list reducer needs the same boundary and a second copy of the constant is a second
 *  chance for the two to disagree about where the exact tail begins. */
export const SAFE_INT = 9007199254740991;
const LONG_SUM_CLASSES: ReadonlySet<string> = new Set(['long', 'bigint']);
export const isLongSumClass = (vt: string): vt is 'long' | 'bigint' => LONG_SUM_CLASSES.has(vt);

/**
 * The `sum` result's VALUE and its Gremlin-class `vt`, for a `long`/`bigint` input — the classes whose
 * sum the eligibility guard used to get WRONG: a value carried as decimal TEXT past 2^53 has
 * `typeof = 'text'` ∉ arithmetic, so it was EXCLUDED (`inject(9007199254740993L, 1L).sum()` answered
 * `1`). Casting through `storedCompareOn` at the call site admits it exactly; here the result stays its
 * own class (SQLite's int64 caps it — a genuine >2^63 overflow is a `NumberHelper` RAISE not built yet)
 * and rides as decimal TEXT once past 2^53 so the exact int64 survives the JS-number read. `frameValue`'s
 * `long`/`bigint` arm reads a number OR a decimal string through `BigInt`, so the two forms frame the same.
 *
 * The narrower/wider INTEGER classes (`byte`+`1` → `short` promotion, `Sum.feature`'s `d[128].s`) are a
 * separate increment: they are not tagged at the `inject` source today, and tagging them is a both-spine
 * framing-vocabulary change with its own census reap (see §6·7·4 in the build plan).
 */
export function sumTower(sum: Expr, inputClass: 'long' | 'bigint'): { value: Expr; type: Expr } {
  const value: Expr = {
    kind: 'case',
    whens: [[{ kind: 'binary', op: '>', left: call('abs', sum), right: compilerInt(SAFE_INT) }, { kind: 'cast', arg: sum, to: 'text' }]],
    else: sum,
  };
  return { value, type: compilerText(inputClass) };
}

/** The eligibility guard: the value where its storage class qualifies, NULL otherwise. */
const eligible = (value: Expr, reducer: Reducer): Expr => ({
  kind: 'case',
  whens: [[{
    kind: 'in-list',
    expr: call('typeof', value),
    values: (reducer === 'min' || reducer === 'max' ? REDUCER_CLASSES.comparable : REDUCER_CLASSES.arithmetic)
      .map(compilerText),
  }, value]],
});

/**
 * A reducer over `value`, weighted by `bulk` where one is carried: the result expression and the
 * expression naming its storage class, which the framing layer reads as the `vt` column.
 *
 * Never declines — every one of the four is expressible, and the caller has already checked membership.
 * A reducer over a stream whose SHAPE is not scalar is a different lowering and never reaches here.
 */
export function reducerAggregate(value: Expr, reducer: Reducer, bulk?: Expr): { value: Expr; type: Expr } {
  const arg = eligible(value, reducer);

  if (reducer === 'mean') {
    // The weighted mean: Σ(v·bulk) / Σ(bulk over ELIGIBLE rows). The denominator counts bulk only where
    // the guard passed, so an ineligible value neither contributes to the total nor dilutes it.
    const numerator = bulk ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk }) : agg('sum', arg);
    if (!bulk) return { value: agg('avg', arg), type: compilerText('real') };
    const denominator = agg('sum', { kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: arg, right: compilerNull() }, bulk]] });
    // A `Cast` and NOT legacy's `* 1.0`: it declares the required REAL arithmetic rather than relying
    // on a spelling-level token. Measured: the mean of the reference graph's ages was 30 rather than
    // 30.75 without it.
    return {
      value: { kind: 'binary', op: '/', left: { kind: 'cast', arg: numerator, to: 'real' }, right: denominator },
      type: compilerText('real'),
    };
  }

  // `min`/`max` are bulk-INVARIANT — the smallest of N identical copies is the smallest — so the
  // weighting applies to `sum` alone.
  const reduced = reducer === 'sum' && bulk
    ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk })
    : agg(reducer, arg);
  return { value: reduced, type: call('typeof', reduced) };
}
