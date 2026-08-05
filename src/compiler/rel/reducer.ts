import { lit, type AggFn, type Expr } from '../../rel/expr.ts';
import { REDUCER_CLASSES } from '../../gremlin/types.ts';
import { comparableTypeSpaceOn, storedCompareOn } from './predicate.ts';

/**
 * THE REDUCER VOCABULARY — `sum`/`min`/`max`/`mean` as one `Aggregate`, and Phase 4.3's named
 * deliverable ("the ten handlers become one `Aggregate` reading row→traverser cardinality off the plan
 * instead of ten handlers knowing it privately").
 *
 * The fourth vocabulary module, and the one with the least surface: a reducer is an aggregate function
 * over an ELIGIBILITY-guarded value, plus the result's dynamic type. The row-level family shares its
 * Gremlin type-space guard, bulk-weighting rule and `vt` column here. Local list reducers retain their
 * prior correlated spelling below until their member frame can name the same keys within the DO budget.
 *
 * ## The three policies, none of which is negotiable
 *
 * 1. **ELIGIBILITY.** A row-level reducer decides from canonical Gremlin vtype: `sum`/`mean` admit the
 *    numeric space, while `min`/`max` admit numeric or string but reject a stream spanning both. The
 *    comparison value comes from `storedCompareOn`, so a decimal-TEXT long contributes as an exact int.
 * 2. **BULK WEIGHTING**, and only for `sum`/`mean`. A value present at bulk N is N traversers, so a
 *    collapsing aggregate must flatten by the multiplicity; `min`/`max` are bulk-INVARIANT (the
 *    smallest of N copies is the smallest). Read off the CHANNEL, exactly as `countExpr` does — which
 *    is why an `inject` source (no multiplicity by construction) gets the unweighted form and an
 *    element source the weighted one, with no step knowing which it is in.
 * 3. **THE RESULT'S TYPE IS DYNAMIC.** `sum` of integers is an integer and of reals a real, so the
 *    framing reads a second column — `typeof(<the aggregate>)` — rather than a compile-time tag. `mean`
 *    is the exception: it is forced REAL, because integer division would silently answer 2 for the mean
 *    of 1 and 4. It is forced with a `Cast` and not legacy's `* 1.0`, and that is a real limit of §3.2
 *    rather than a preference — see the note at the site.
 */

export type Reducer = 'sum' | 'min' | 'max' | 'mean';
export const REL_REDUCERS: ReadonlySet<string> = new Set(['sum', 'min', 'max', 'mean']);
export const isReducer = (name: string): name is Reducer => REL_REDUCERS.has(name);

/**
 * THE SQL→WIRE ERROR CHANNEL, and it exists because SQLite cannot RAISE from a SELECT.
 *
 * Two reducer refusals are properties of the ROWS, not of the plan — a stream mixing Gremlin type
 * spaces, and an integer sum that overflows — so neither can be decided at compile time and both must
 * fail closed at run time. The only path from an aggregate to the caller is a column, so the reducer
 * writes a marked message into the TYPE column and `frameValues` (execute.ts) turns it into a throw.
 *
 * The prefix is EXPORTED and used at both ends deliberately: two spellings of one sentinel is how the
 * producer silently stops matching the consumer and the guard is lost without any test noticing. It is
 * still a narrow contract rather than a general mechanism — a wire TYPE carrying control flow — so a
 * third use is a signal to build a real error channel out of the algebra instead of widening this one.
 * The alternative here was worse and was measured: dropping it makes an overflowing `sum()` return an
 * approximate REAL and a mixed `min()` return the storage-class extremum, both silently.
 */
export const REDUCER_ERROR_PREFIX = '__mogwai_reducer_error:';

const agg = (fn: AggFn, arg: Expr): Expr => ({ kind: 'agg', fn, args: [arg] });
const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
const binary = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr =>
  ({ kind: 'binary', op, left, right });

export interface ReducerSubject {
  readonly value: Expr;
  readonly vtype: Expr;
  readonly compare: Expr;
  readonly space: Expr;
}

export const reducerSubject = (value: Expr, vtype: Expr): ReducerSubject => ({
  value, vtype, compare: storedCompareOn(vtype)(value), space: comparableTypeSpaceOn(vtype),
});

/**
 * The eligibility guard — and the two reducer families need DIFFERENT questions, which is the whole
 * subtlety of this module.
 *
 * `sum`/`mean` are ARITHMETIC, so they must admit exactly the Gremlin NUMBERS. The storage class
 * cannot answer that: this project carries an int64 above 2^53 as decimal TEXT, so a legal `long` has
 * `typeof = 'text'` and the old `REDUCER_CLASSES.arithmetic` guard silently contributed NOTHING for
 * it. Hence the canonical type space, and the CAST comparison value — TEXT is a legal exact carrier.
 *
 * `min`/`max` are COMPARABLE, and asking the type-space question there is WRONG. A single traverser
 * is trivially its own extremum whatever its type, and the reference agrees by construction: with one
 * start `Operator.min` never invokes `NumberHelper` at all, so `values('nums').max()` over a
 * LIST-valued property yields the list. A type-space guard has no space for `list` and would filter
 * that only row out, answering NULL — measured, and it is what
 * `test/compiler/unified-lowering.exec.test.ts`'s root/child characterization caught. So eligibility
 * here stays the STORAGE-class `comparable` set exactly as before; what this increment changes for
 * min/max is the ORDERING (through `storedCompareOn`) and returning the winning ROW, never which
 * rows are admitted.
 */
const eligible = (subject: ReducerSubject, reducer: Reducer): Expr =>
  reducer === 'min' || reducer === 'max'
    ? {
        kind: 'case',
        whens: [[{
          kind: 'in-list', expr: call('typeof', subject.value),
          values: REDUCER_CLASSES.comparable.map((cls) => lit(cls, 'text')),
        }, subject.value]],
      }
    : { kind: 'case', whens: [[binary('=', subject.space, lit('number', 'text')), subject.compare]] };

const filteredAgg = (fn: AggFn, arg: Expr, filter: Expr, distinct = false): Expr =>
  ({ kind: 'agg', fn, args: [arg], filter, distinct });

/** min/max select the winning ROW, not SQLite's raw storage extremum. The ordered JSON arrays keep
 *  the original value and its own vtype aligned; extracting the first member therefore preserves a
 *  TEXT-carried long as a long at the wire instead of returning either a string or the cast key.
 *
 *  A MIXED type space is REFUSED, through `REDUCER_ERROR_PREFIX`. The refusal is a RUNTIME property of
 *  the rows — a property-backed stream's types are per-row data — so it cannot be decided at compile
 *  time, and SQLite cannot raise from a SELECT; see that constant for why the channel is shaped the way
 *  it is and why a third use should replace it rather than extend it. */
const extremum = (subject: ReducerSubject, reducer: 'min' | 'max'): { value: Expr; type: Expr } => {
  const { value, vtype, compare, space } = subject;
  // The SAME admission the storage-class guard has always applied (see `eligible`) — a `list` value is
  // comparable-with-itself and must survive, which a type-space test would filter out.
  const qualifies: Expr = {
    kind: 'in-list', expr: call('typeof', value),
    values: REDUCER_CLASSES.comparable.map((cls) => lit(cls, 'text')),
  };
  const direction = reducer === 'min' ? 'asc' as const : 'desc' as const;
  const orderBy = [{ expr: compare, dir: direction }];
  const first = (arg: Expr): Expr => call('json_extract', {
    kind: 'agg', fn: 'json_group_array', args: [arg], filter: qualifies, orderBy,
  }, lit('$[0]', 'text'));
  // A MIXED type space is refused, through the shared error channel above: the reference does refuse
  // it (`NumberHelper.min`/`max` end in `a.compareTo(b)`, so `Integer.compareTo(String)` throws, and
  // `GremlinValueComparator` is never consulted here), and the alternative is returning the
  // storage-class extremum — `min` of `[1,"a"]` answering 1 — silently.
  const spaces = filteredAgg('count', space, qualifies, true);
  return {
    value: first(value),
    type: {
      kind: 'case',
      whens: [[binary('>', spaces, lit(1, 'int')),
        lit(`${REDUCER_ERROR_PREFIX}${reducer}() cannot compare values from mixed Gremlin type spaces`, 'text')]],
      else: first(vtype),
    },
  };
};

/**
 * A reducer over `value`, weighted by `bulk` where one is carried: the result expression and the
 * expression naming its storage class, which the framing layer reads as the `vt` column.
 *
 * Never declines — every one of the four is expressible, and the caller has already checked membership.
 * A reducer over a stream whose SHAPE is not scalar is a different lowering and never reaches here.
 */
export function reducerAggregate(subject: ReducerSubject, reducer: Reducer, bulk?: Expr): { value: Expr; type: Expr } {
  const arg = eligible(subject, reducer);

  if (reducer === 'min' || reducer === 'max') return extremum(subject, reducer);

  if (reducer === 'mean') {
    // The weighted mean: Σ(v·bulk) / Σ(bulk over ELIGIBLE rows). The denominator counts bulk only where
    // the guard passed, so an ineligible value neither contributes to the total nor dilutes it.
    const numerator = bulk ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk }) : agg('sum', arg);
    if (!bulk) return { value: agg('avg', arg), type: lit('real', 'text') };
    const denominator = agg('sum', { kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: arg, right: lit(null, 'any') }, bulk]] });
    // A `Cast` and NOT legacy's `* 1.0`, and the reason is a real limit of §3.2: every `Lit` is a BIND,
    // and a JS `1.0` IS `1`, so the bind lands as an INTEGER and SQLite does integer division. Measured:
    // the mean of the reference graph's ages came back 30 instead of 30.75. Legacy can splice `1.0` as
    // SQL text; a bind cannot carry the distinction, so the honest way to force REAL is to say so.
    return {
      value: { kind: 'binary', op: '/', left: { kind: 'cast', arg: numerator, to: 'real' }, right: denominator },
      type: lit('real', 'text'),
    };
  }

  // The remaining arm is sum; min/max returned above and are bulk-INVARIANT.
  if (bulk) {
    const product = binary('*', arg, bulk);
    const reduced = agg('sum', product);
    // SQLite promotes an overflowing integer MULTIPLICATION to REAL before SUM sees it. SUM itself
    // therefore cannot raise its normal "integer overflow" error; carry an explicit deferral marker
    // instead of returning an approximate floating-point total. An overflow of the SUM of otherwise
    // integral products still raises directly in SQLite.
    const productOverflow = binary('and',
      binary('=', call('typeof', subject.compare), lit('integer', 'text')),
      binary('=', call('typeof', binary('*', subject.compare, bulk)), lit('real', 'text')));
    const overflowCount = filteredAgg('count', lit(1, 'int'), productOverflow);
    return {
      value: reduced,
      type: {
        kind: 'case',
        whens: [[binary('>', overflowCount, lit(0, 'int')),
          lit(`${REDUCER_ERROR_PREFIX}sum() integer overflow`, 'text')]],
        else: call('typeof', reduced),
      },
    };
  }
  const reduced = agg('sum', arg);
  return { value: reduced, type: call('typeof', reduced) };
}

/** The existing local-list spelling. A list member lives inside a correlated json_each subquery;
 *  the row-level reducer's vtype preparation needs a named relational boundary that cannot be a
 *  correlated CTE. Keep the established storage-class policy here until that member frame can carry
 *  the type-space key without duplicating its bind-heavy CASE past the DO ceiling. */
export function localReducerAggregate(value: Expr, reducer: Reducer): { value: Expr; type: Expr } {
  const classes = reducer === 'min' || reducer === 'max' ? REDUCER_CLASSES.comparable : REDUCER_CLASSES.arithmetic;
  const arg: Expr = {
    kind: 'case',
    whens: [[{ kind: 'in-list', expr: call('typeof', value), values: classes.map((cls) => lit(cls, 'text')) }, value]],
  };
  if (reducer === 'mean') return { value: agg('avg', arg), type: lit('real', 'text') };
  const reduced = agg(reducer, arg);
  return { value: reduced, type: call('typeof', reduced) };
}
