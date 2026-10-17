import { compilerInt, compilerNull, compilerText, type AggFn, type BinaryOp, type Expr } from '../../rel/expr.ts';
import { raiseExpr } from '../../rel/raise.ts';
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
 *    of 1 and 4. It is forced with a `Cast` rather than a `* 1.0`; the cast states the required
 *    storage class directly rather than relying on a spelling-level numeric token.
 */

export type Reducer = 'sum' | 'min' | 'max' | 'mean';
export const REL_REDUCERS: ReadonlySet<string> = new Set(['sum', 'min', 'max', 'mean']);
export const isReducer = (name: string): name is Reducer => REL_REDUCERS.has(name);

const agg = (fn: AggFn, arg: Expr): Expr => ({ kind: 'agg', fn, args: [arg] });
const call = (fn: string, arg: Expr): Expr => ({ kind: 'call', fn, args: [arg] });

/** 2^53 - 1: the widest a JS number (thus a plain SQLite read) holds exactly. EXPORTED so any other
 *  reducer that needs the same boundary shares this one constant — a second copy is a second chance
 *  for the two to disagree about where the exact tail begins. */
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
 * separate increment: they are not tagged at the `inject` source today, and tagging them is a
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

/** The eligibility guard: the value where its storage class qualifies, NULL otherwise. A TEXT value an
 *  ARITHMETIC reducer meets is not quietly ineligible, though — `arithmeticArg` raises over it. */
const eligible = (value: Expr, reducer: Reducer): Expr => ({
  kind: 'case',
  whens: [[{
    kind: 'in-list',
    expr: call('typeof', value),
    values: (reducer === 'min' || reducer === 'max' ? REDUCER_CLASSES.comparable : REDUCER_CLASSES.arithmetic)
      .map(compilerText),
  }, value]],
});

/** The deferrals a reducer raises mid-statement (`raiseExpr`) — an answer the storage class cannot
 *  decide. Short, because each is inlined in the statement; no quote, which `raiseExpr` cannot carry. */
export const TEXT_OPERAND = 'sum/mean over a text or non-number value is not supported';
export const MIXED_COMPARABLES = 'min/max over values of different types is not supported';

/** `reduced`, unless `refuse` holds over the group — then a deferral. Each test is an AGGREGATE over the
 *  rows (so it spells the value once, not once per arm of the guard), and the raise reads `count(*)`
 *  only so it is not a constant expression (`raiseExpr`). */
const refusedWhen = (refuse: Expr, message: string, reduced: Expr): Expr =>
  ({ kind: 'case', whens: [[refuse, raiseExpr(message, { kind: 'agg', fn: 'count', args: [] })]], else: reduced });

/**
 * A `sum`/`mean` over a group holding TEXT declines. Dropping the text (the eligibility guard's NULL)
 * answered the sum of the OTHER values, and the TEXT a reducer meets is not only a `String`: an int64
 * past 2^53 rides as decimal TEXT (`storedScalar`, a `long` literal, `sumTower`), and so does a
 * `BigInteger`/`BigDecimal`. The reference ADDS those exactly and throws on a `String` (`NumberHelper.add`
 * takes `Number`s —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:452`),
 * so neither is "contributes nothing": `inject(1).union(__.constant(9007199254740992L), __.constant(2)).sum()`
 * answered `2`. The storage class cannot tell the cases apart, so this declines rather than pick one. So
 * does a value TYPED as something other than a Number (`nonNumber`, a per-row tag test the caller can
 * spell — a Boolean or a Date is INTEGER storage, so only its tag says it is not a Number).
 *
 * The raise is an arm of the aggregate's own ARGUMENT, so it fires on the offending row and the aggregate
 * is spelled exactly as before — a caller that re-reads the total (a class test per width) pays nothing.
 * Every reducer site shares it — the global and correlated reducer, a group value, `sum(local)` — so one
 * guard covers every depth. A sum over a KNOWN `long`/`bigint` class never reaches it: `sumTower`'s
 * callers cast through the class first.
 */
const arithmeticArg = (value: Expr, nonNumber?: Expr): Expr => ({
  kind: 'case',
  whens: [
    ...(nonNumber ? [[nonNumber, raiseExpr(TEXT_OPERAND, value)] as const] : []),
    [{ kind: 'in-list', expr: call('typeof', value), values: REDUCER_CLASSES.arithmetic.map(compilerText) }, value],
    [{ kind: 'binary', op: '=', left: call('typeof', value), right: compilerText('text') }, raiseExpr(TEXT_OPERAND, value)],
  ],
});

/**
 * A `min`/`max` whose group holds both TEXT and a number declines. SQLite orders every number before every
 * text, so the text simply won (or lost) — but the reference either compares the two NUMERICALLY (the
 * text was a wide `long` or a `BigDecimal`) or throws (`"a".compareTo(1)` across classes,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:582-597`).
 * Neither is SQLite's answer, and the storage class cannot say which applies. A row's class is its storage
 * class with REAL folded onto INTEGER (one number space) and NULL/BLOB dropped, so "more than one class"
 * is exactly "text among numbers".
 */
const mixedRefused = (reduced: Expr, value: Expr): Expr => {
  const cls = ['null', 'blob'].reduce<Expr>((inner, drop) => ({ kind: 'call', fn: 'nullif', args: [inner, compilerText(drop)] }),
    { kind: 'call', fn: 'replace', args: [call('typeof', value), compilerText('real'), compilerText('integer')] });
  return refusedWhen(
    { kind: 'binary', op: '>', left: { kind: 'agg', fn: 'count', args: [cls], distinct: true }, right: compilerInt(1) },
    MIXED_COMPARABLES, reduced);
};

/**
 * A reducer over `value`, weighted by `bulk` where one is carried: the result expression and the
 * expression naming its storage class, which the framing layer reads as the `vt` column.
 *
 * Never declines at compile time — every one of the four is expressible, and the caller has already
 * checked membership. It DEFERS at run time where the storage class cannot decide (`arithmeticArg`,
 * `mixedRefused`).
 * A reducer over a stream whose SHAPE is not scalar is a different lowering and never reaches here.
 */
export function reducerAggregate(value: Expr, reducer: Reducer, bulk?: Expr, nonNumber?: Expr): { value: Expr; type: Expr } {
  const arg = reducer === 'min' || reducer === 'max' ? eligible(value, reducer) : arithmeticArg(value, nonNumber);

  if (reducer === 'mean') {
    // The weighted mean: Σ(v·bulk) / Σ(bulk over ELIGIBLE rows). The denominator counts bulk only where
    // the guard passed, so an ineligible value neither contributes to the total nor dilutes it.
    //
    // THE TAG FOLLOWS THE RESULT, as `sum`/`min`/`max`'s does below: `typeof` of the mean, which is
    // 'real' for every number and 'null' where every value was null. `MeanGlobalStep` skips a null and
    // answers null for an all-null stream
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:50-58,80-84`).
    // A constant 'real' tag on that NULL told every `vt` reader it held a number: `math()`'s number
    // check passed it and `CAST(NULL) + 1` dropped the row where `MathStep` raises.
    const numerator = bulk ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk }) : agg('sum', arg);
    if (!bulk) {
      const mean = agg('avg', arg);
      return { value: mean, type: call('typeof', mean) };
    }
    const denominator = agg('sum', { kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: arg, right: compilerNull() }, bulk]] });
    // A `Cast` and NOT a `* 1.0`: it declares the required REAL arithmetic rather than relying
    // on a spelling-level token. Measured: the mean of the reference graph's ages was 30 rather than
    // 30.75 without it.
    const mean: Expr = { kind: 'binary', op: '/', left: { kind: 'cast', arg: numerator, to: 'real' }, right: denominator };
    return { value: mean, type: call('typeof', mean) };
  }

  // `min`/`max` are bulk-INVARIANT — the smallest of N identical copies is the smallest — so the
  // weighting applies to `sum` alone.
  const reduced = reducer === 'sum' && bulk
    ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk })
    : agg(reducer, arg);
  // The guard either raises or IS the aggregate, so the class is read off the aggregate itself.
  const guarded = reducer === 'sum' ? reduced : mixedRefused(reduced, value);
  return { value: guarded, type: call('typeof', reduced) };
}

const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const outside = (e: Expr, lo: number, hi: number): Expr => bin('or', bin('<', e, compilerInt(lo)), bin('>', e, compilerInt(hi)));

/**
 * Each Gremlin number class as ONE BIT, in `NumberHelper`'s width order — integral `byte`…`bigint` in
 * bits 0–4, floating `float`/`double`/`bigdecimal` in bits 5–7 — and anything that is not a number in
 * bit 8. A storage-class name (`integer`/`real`: an untagged value, or a reducer's own `typeof` tag)
 * reads as the class `inferredVtype` gives it (an Int, a Double). Spelled as one JSON object so a row's
 * bit is ONE lookup on its tag, rather than a `CASE` that would spell the tag once per class.
 */
const CLASS_BITS = JSON.stringify({ byte: 1, short: 2, int: 4, long: 8, bigint: 16, float: 32, double: 64, bigdecimal: 128, integer: 4, real: 64 });
const NOT_A_NUMBER = 256;

/** The column a reduction carries its result's class mask in (`numberClassMask`). */
export const CLASS_MASK = 'cls';

/**
 * THE STREAM'S NUMBER CLASSES, AS ONE AGGREGATE — the set of classes its non-null values carry, as a bit
 * mask (`CLASS_BITS`): `SUM(DISTINCT <one-hot bit>)` is the bitwise OR of the rows' bits, which SQLite has
 * no aggregate for. `tag` is the row's own Gremlin type, NULL for an untagged value, which is then read by
 * its storage class (`typeof`). `numberClass` names the class the mask stands for. A value held as TEXT
 * votes NO number class, whatever its tag: the reducer's eligibility test admits only an `integer`/`real`
 * storage class, so an exact-tail value stored as decimal TEXT (a BigDecimal `'1.5'`, a BigInteger or a
 * Long past 2^53) is LEFT OUT of the total (an open wrong answer, `docs/outstanding-work.md`), and naming
 * the total's class after it would frame that wrong total as an exact one. It reads as `NOT_A_NUMBER`, so
 * the class falls back to the caller's own storage-class answer.
 */
export function numberClassMask(value: Expr, tag: Expr): Expr {
  const key: Expr = { kind: 'call', fn: 'coalesce', args: [tag, call('typeof', value)] };
  const bit: Expr = {
    kind: 'case',
    whens: [[bin('=', call('typeof', value), compilerText('text')), compilerInt(NOT_A_NUMBER)], [bin('is not', value, compilerNull()), {
      kind: 'call', fn: 'coalesce',
      args: [{ kind: 'call', fn: 'json_extract', args: [compilerText(CLASS_BITS), bin('||', compilerText('$.'), key)] }, compilerInt(NOT_A_NUMBER)],
    }]],
  };
  return { kind: 'agg', fn: 'sum', args: [bit], distinct: true };
}

/**
 * THE CLASS OF A NUMERIC REDUCER'S RESULT — `NumberHelper`'s HIGHEST COMMON class of the stream
 * (`getHighestCommonNumberInfo`: the widest width, floating point if any value is, so a `long` and a
 * `float` make a `double`; `determineNumberClass`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390,861-874`),
 * from its class `mask` (`numberClassMask`) — widened by OVERFLOW for an integral class, because
 * `mathOperationWithPromote` retries an overflowing sum at the next width rather than wrap
 * (`NumberHelper.java:401-430`; `add` is it, `:452-454`), so a sum of Integers past 2^31 is a Long. Its
 * readers: every `sum` (scalar, `sum(local)`, a grouped `by()`), and the grouped `by()` `min`/`max`, where
 * the widening never fires (the result is one of the values) and the class is the common one. The
 * top-level and `local` `min`/`max` do NOT read it yet — they frame the winner's own class, so
 * `inject(5i, 2.0d).max()` is the Int 5 where `NumberHelper.max` gives the Double 5.0, and
 * `inject(1b, 2s).max()` an Int (recorded in `docs/outstanding-work.md`).
 *
 * `fallback` where the stream has no number class — no value at all (the result is null), or a value that
 * is not a number (a string under `min`/`max`, a tag no number class names) — the caller's answer before.
 *
 * Why a storage class is not enough: a Double stored integral (the modern graph's `weight` 1.0 is INTEGER
 * 1 under a `double` tag) sums to an INTEGER, so `g.V(5).inE().values('weight').sum()` framed as the Int 1
 * where the reference answers the Double 1.0 (`Sum.feature`
 * `g_V_hasLabelXsoftwareX_group_byXnameX_byXbothE_weight_sumX`, `d[1.0].d`), and a `property()` write of
 * that sum stored it untyped. Two residues, both of an UNTAGGED stream: an untagged integer is an Int
 * whatever its magnitude (only the result's own magnitude widens it), and the reference promotes on an
 * INTERMEDIATE overflow, so a sum whose running total passed a width and came back is wider there.
 */
export function numberClass(mask: Expr, result: Expr, fallback: Expr): Expr {
  const atLeast = (bit: number): Expr => bin('>=', mask, compilerInt(bit));
  const has = (bit: number): Expr => bin('=', bin('%', bin('/', mask, compilerInt(bit)), compilerInt(2)), compilerInt(1));
  return {
    kind: 'case',
    whens: [
      [bin('or', bin('is', mask, compilerNull()), atLeast(NOT_A_NUMBER)), fallback],
      // Some floating class (bits 5–7, and nothing at or past bit 8): its width is the widest of all.
      [atLeast(32), {
        kind: 'case',
        whens: [[bin('or', atLeast(128), has(16)), compilerText('bigdecimal')], [bin('or', atLeast(64), has(8)), compilerText('double')]],
        else: compilerText('float'),
      }],
      [atLeast(16), compilerText('bigint')],
      [bin('or', atLeast(8), outside(result, -2147483648, 2147483647)), compilerText('long')],
      [bin('or', atLeast(4), outside(result, -32768, 32767)), compilerText('int')],
      [bin('or', atLeast(2), outside(result, -128, 127)), compilerText('short')],
    ],
    else: compilerText('byte'),
  };
}
