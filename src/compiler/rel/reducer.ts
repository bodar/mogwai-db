import { col, compilerInt, compilerNull, compilerReal, compilerText, type AggFn, type BinaryOp, type Expr } from '../../rel/expr.ts';
import type { RelId } from '../../rel/types.ts';
import { INTEGER_OVERFLOW, raiseExpr, raiseInRow } from '../../rel/raise.ts';
import { NUMBER_STORED_NON_NUMBERS, REDUCER_CLASSES } from '../../gremlin/types.ts';
import { NUMERIC_VTYPES } from './predicate.ts';
import { PER_ROW, type ScalarType } from '../../sql/kernel/render.ts';
import { FLOAT_MIN_NORMAL, FLOAT_OVERFLOW, floatValueOf } from './float.ts';

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
 * 3. **THE RESULT'S CLASS RIDES PER ROW, IN ONE VOCABULARY.** A reducer states its result's class in the
 *    `vt` column as a GREMLIN type name — never a SQLite storage class — and frames it `REDUCED_TYPE`
 *    (`PER_ROW('vt')`), so every consumer that reads a per-row type (a fold member, a map value, a group
 *    key, a record field re-read by `select`, `asString`, a predicate) reads the class the producer
 *    stated, at every depth. Where the rows carry their own Gremlin type the class is the number-class
 *    authority's (`commonNumberClass`); where they carry none it is what the wire infers from the value
 *    (`inferredVtype`). `mean` is forced REAL (a `Cast`, not a `* 1.0`) and is always a Double.
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

/**
 * ONE SUMMAND of a known `long`/`bigint` stream, as the exact int64 `sumTower` adds — the value cast by
 * its class, so a Long carried as decimal TEXT past 2^53 is admitted exactly.
 *
 * A `BigInteger` can lie PAST int64 (`inject('99999999999999999999').asNumber()`, createNumber's
 * BigInteger), and SQLite's `CAST(… AS INT)` SATURATES there rather than fail: the sum answered
 * 9223372036854775807 where `NumberHelper.add` gives the exact BigInteger
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:452-454`).
 * A cast that does not round-trip to the same decimal text is that saturation, and it DEFERS with the
 * message SQLite's own int64 overflow in `sum()` already defers with (`INTEGER_OVERFLOW`) — one deferral
 * for "the answer is past 64 bits", wherever it is detected. A Long cannot lie past int64, so its cast
 * needs no test.
 */
export function towerOperand(value: Expr, inputClass: 'long' | 'bigint'): Expr {
  const cast: Expr = { kind: 'cast', arg: value, to: 'int' };
  if (inputClass === 'long') return cast;
  const saturated = bin('and', bin('=', call('typeof', value), compilerText('text')),
    bin('!=', { kind: 'cast', arg: cast, to: 'text' }, value));
  return { kind: 'case', whens: [[saturated, raiseExpr(INTEGER_OVERFLOW, value)]], else: cast };
}

/**
 * THE ROWS' OWN GREMLIN TYPE, as a reducer reads it — a per-row tag expression (either vocabulary: a
 * Gremlin type name or a reducer's storage class), or `null` where the rows carry none and their storage
 * class IS their type. REQUIRED at every reducer site (`reducerAggregate`), because the defect it closes
 * is a site that forgot: a Boolean (INTEGER 0/1) or a Date (epoch millis) is a Number to SQLite, so a
 * reducer that does not read the tag adds or orders it as one.
 */
export type ReducerRowTag = Expr | null | typeof SCREENED;

/**
 * The row tag of a value ALREADY SCREENED by `screenedByTag` — a caller that projects its rows before
 * the aggregate (a group value's pooled rows) screens each row ONCE there, rather than have the screen
 * spelled inside an aggregate expression the statement repeats.
 */
export const SCREENED = 'screened' as const;

/**
 * The per-row half of `reducerAggregate`'s row-tag reading, for a caller that projects its rows: the
 * value, with a row whose TAG makes it unreducible raising in-statement — a Boolean, Date or Duration
 * (`nonNumberTag`), and for an ORDERING reducer a Number held as decimal TEXT (`exactTail`). `null` where
 * a STATIC tag already decides that every row is unreducible (decline). The aggregate over it then takes
 * `SCREENED` as its tag.
 */
export function screenedByTag(value: Expr, reducer: Reducer, tag: Expr | null): Expr | null {
  const nonNumber = nonNumberTag(tag);
  if (nonNumber === true) return null;
  const ordering = reducer === 'min' || reducer === 'max';
  const whens: Arm[] = [
    ...armWhen(nonNumber === null || nonNumber === false ? nonNumber : bin('and', bin('is not', value, compilerNull()), nonNumber),
      raiseInRow(ordering ? NON_NUMBER_ORDER : TEXT_OPERAND)),
    ...armWhen(scaledDecimal(value, tag, reducer), raiseInRow(DECIMAL_SCALE)),
    ...(ordering ? armWhen(exactTail(value, tag), raiseInRow(EXACT_TAIL)) : []),
  ];
  return whens.length ? { kind: 'case', whens, else: value } : value;
}

/** `tag` names a type SQLite stores as a number that is not one (`NUMBER_STORED_NON_NUMBERS`). A STATIC
 *  tag is decided here (`true`/`false`), a per-row one is the SQL test; `null` for no tag at all. */
function nonNumberTag(tag: ReducerRowTag): Expr | boolean | null {
  if (tag === null || tag === SCREENED) return null;
  if (tag.kind === 'lit' && tag.source === 'compiler-text') return NUMBER_STORED_NON_NUMBERS.includes(String(tag.value));
  return { kind: 'in-list', expr: tag, values: NUMBER_STORED_NON_NUMBERS.map(compilerText) };
}

/** `tag` names a NUMBER class — the reading under which a TEXT value is an exact-tail number (a Long past
 *  2^53, a BigInteger, a BigDecimal) rather than a String. Static where it can be. */
function numberTag(tag: ReducerRowTag): Expr | boolean {
  if (tag === null || tag === SCREENED) return false;
  if (tag.kind === 'lit' && tag.source === 'compiler-text') return NUMERIC_VTYPES.includes(String(tag.value));
  return { kind: 'in-list', expr: tag, values: NUMERIC_VTYPES.map(compilerText) };
}

/** A guard arm: the test as a CASE `when`, dropped where the test is decided false at compile time. A
 *  `true` test keeps its arm — the raise still reads the row (`raiseExpr`'s operand). */
type Arm = readonly [Expr, Expr];
const CONSTANT_TRUE: Expr = { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(1) };
const armWhen = (test: Expr | boolean | null, then: Expr): Arm[] =>
  test === null || test === false ? [] : [[test === true ? CONSTANT_TRUE : test, then]];

/**
 * The eligibility guard for an ORDERING reducer: the value where its storage class qualifies, NULL
 * otherwise — after the two refusals a row's TAG decides:
 * - a Boolean, Date or Duration (`nonNumberTag`) — SQLite orders it as the number it is stored as, which
 *   compares a `true` with an Integer where `NumberHelper.max` throws across classes
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:639-655`)
 *   and frames the winner as a Number (`group().by(label).by(coalesce(values('age'), constant(true)).max())`
 *   answered `software:1`);
 * - a NUMBER held as decimal TEXT (a Long past 2^53, a BigInteger, a BigDecimal) — ordered as TEXT it
 *   compares lexicographically and frames as a String (`by(values('x').max())` over `9007199254740993L`
 *   answered the String "9007199254740993").
 * Both DEFER; neither is SQLite's answer.
 */
const eligible = (value: Expr, tag: ReducerRowTag): Expr => ({
  kind: 'case',
  whens: [
    // `raiseInRow`, not `raiseExpr(…, value)`: the arm is already guarded by a test of the row, and a
    // second spelling of the value (often a correlated read) is statement text the raise does not need.
    ...armWhen(nonNumberTag(tag), raiseInRow(NON_NUMBER_ORDER)),
    ...armWhen(scaledDecimal(value, tag, 'max'), raiseInRow(DECIMAL_SCALE)),
    ...armWhen(exactTail(value, tag), raiseInRow(EXACT_TAIL)),
    [{ kind: 'in-list', expr: call('typeof', value), values: REDUCER_CLASSES.comparable.map(compilerText) }, value],
  ],
});

/**
 * A BigDecimal row whose arithmetic is SCALE arithmetic — every carrier but the INTEGER (an integral
 * source's `BigDecimal.valueOf(long)`, scale 0, which adds and orders as the integer it is). A decimal-TEXT
 * BigDecimal sums to the larger scale of its addends (`BigDecimal.add`) and compares by `compareTo`, neither
 * of which SQLite's REAL arithmetic over the text keeps; a REAL one (`BigDecimal.valueOf(double)`,
 * `gremlin/float.ts` `bigDecimalOfCarrier`) orders exactly, but its sum's scale is the addends' larger
 * scale, not the `valueOf` of the total a REAL result would frame as. So a sum/mean meets both, an
 * ordering only the TEXT. A STATIC tag is decided here; a per-row one is the SQL test.
 */
function scaledDecimal(value: Expr, tag: ReducerRowTag, reducer: Reducer): Expr | boolean {
  if (tag === null || tag === SCREENED) return false;
  // A MEAN over a BigDecimal or a BigInteger is a BigDecimal DIVISION whatever the carrier
  // (`MeanNumber.getFinal` is `div(sum, count, true)`, and a 128-bit floating common class is a BigDecimal:
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:175-177`,
  // `NumberHelper.java:362-390`) — its scale is the quotient's, never the Double a REAL mean frames as.
  const mean = reducer === 'mean';
  const classes = mean ? ['bigdecimal', 'bigint'] : ['bigdecimal'];
  const staticTag = tag.kind === 'lit' && tag.source === 'compiler-text' ? String(tag.value) : undefined;
  if (staticTag !== undefined && !classes.includes(staticTag)) return false;
  const carried: Expr = mean ? bin('is not', value, compilerNull())
    : { kind: 'in-list', expr: call('typeof', value), values: (reducer === 'sum' ? ['text', 'real'] : ['text']).map(compilerText) };
  return staticTag !== undefined ? carried : bin('and', { kind: 'in-list', expr: tag, values: classes.map(compilerText) }, carried);
}

/** A TEXT value whose tag names a Number class — an exact-tail number, not a String. */
function exactTail(value: Expr, tag: ReducerRowTag): Expr | boolean {
  const numeric = numberTag(tag);
  if (numeric === false) return false;
  const isText = bin('=', call('typeof', value), compilerText('text'));
  return numeric === true ? isText : bin('and', isText, numeric);
}

/** The deferrals a reducer raises mid-statement (`raiseExpr`) — an answer the storage class cannot
 *  decide. Short, because each is inlined in the statement; no quote, which `raiseExpr` cannot carry. */
export const TEXT_OPERAND = 'sum/mean over a text or non-number value is not supported';
export const MIXED_COMPARABLES = 'min/max over values of different types is not supported';
export const NON_NUMBER_ORDER = 'min/max over a Boolean, Date or Duration value is not supported';
export const EXACT_TAIL = 'sum/mean/min/max over a number past 2^53 is not supported';
export const DECIMAL_SCALE = 'sum/mean/min/max in BigDecimal scale arithmetic is not supported';

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
const arithmeticArg = (value: Expr, tag: ReducerRowTag, reducer: 'sum' | 'mean'): Expr => {
  // A NULL value is no summand whatever its tag, so a per-row non-number test is gated on presence.
  const nonNumber = nonNumberTag(tag);
  const offends = nonNumber === null || typeof nonNumber === 'boolean' ? nonNumber
    : bin('and', bin('is not', value, compilerNull()), nonNumber);
  // A TEXT value is a String (the reference throws) or an exact-tail Number (it adds exactly) — two
  // deferrals, the message named by a STATIC number tag where one says which. The raises are
  // `raiseInRow`: each arm is already a test of the row, so the value need not be spelled again.
  const textMessage = numberTag(tag) === true ? EXACT_TAIL : TEXT_OPERAND;
  return {
    kind: 'case',
    whens: [
      ...armWhen(offends, raiseInRow(TEXT_OPERAND)),
      ...armWhen(scaledDecimal(value, tag, reducer), raiseInRow(DECIMAL_SCALE)),
      [{ kind: 'in-list', expr: call('typeof', value), values: REDUCER_CLASSES.arithmetic.map(compilerText) }, value],
      [{ kind: 'binary', op: '=', left: call('typeof', value), right: compilerText('text') }, raiseInRow(textMessage)],
    ],
  };
};

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
 * A reducer over `value`, weighted by `bulk` where one is carried: the result expression. Its CLASS is the
 * caller's to name over the reduced COLUMN (`reducedClass`), so the aggregate is spelled once.
 *
 * `tag` is the rows' own Gremlin type (`ReducerRowTag`), REQUIRED so no site can forget it: it is what
 * tells a Boolean, a Date or an exact-tail Number from the SQLite number or text it is stored as. A STATIC
 * tag naming a non-Number DECLINES here (`null`) — the reference's ClassCastException is certain, but its
 * message names the Java class. Otherwise it DEFERS at run time where the storage class cannot decide
 * (`arithmeticArg`, `eligible`, `mixedRefused`).
 * A reducer over a stream whose SHAPE is not scalar is a different lowering and never reaches here.
 */
export function reducerAggregate(value: Expr, reducer: Reducer, tag: ReducerRowTag, bulk?: Expr, screenedTag?: Expr): { value: Expr } | null {
  if (nonNumberTag(tag) === true) return null;
  const arg = reducer === 'min' || reducer === 'max' ? eligible(value, tag) : arithmeticArg(value, tag, reducer);
  // A Float row makes the running total FLOAT arithmetic (`floatInexact`); a `SCREENED` caller states the
  // rows' tag apart, since the screen has already been applied.
  const inexact = reducer === 'sum' || reducer === 'mean' ? floatInexact(value, tag === SCREENED ? screenedTag ?? null : tag, reducer, bulk) : null;
  const widened = reducer === 'sum' ? decimalWidened(value, tag === SCREENED ? screenedTag ?? null : tag) : null;
  const guarded = (reduced: Expr): Expr => {
    const exact = widened ? refusedWhen(widened, DECIMAL_SCALE, reduced) : reduced;
    if (!inexact) return exact;
    const total: Expr = inexact.rounds ? { kind: 'case', whens: [[inexact.rounds, floatValueOf(exact)]], else: exact } : exact;
    return refusedWhen(inexact.refuse, FLOAT_SUM_INEXACT, total);
  };

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
    if (!bulk) return { value: negativeZeroTotal(value, tag, guarded(agg('avg', arg))) };
    const denominator = agg('sum', { kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: arg, right: compilerNull() }, bulk]] });
    // A `Cast` and NOT a `* 1.0`: it declares the required REAL arithmetic rather than relying
    // on a spelling-level token. Measured: the mean of the reference graph's ages was 30 rather than
    // 30.75 without it.
    return { value: negativeZeroTotal(value, tag, guarded({ kind: 'binary', op: '/', left: { kind: 'cast', arg: numerator, to: 'real' }, right: denominator })) };
  }

  // `min`/`max` are bulk-INVARIANT — the smallest of N identical copies is the smallest — so the
  // weighting applies to `sum` alone.
  const reduced = reducer === 'sum' && bulk
    ? agg('sum', { kind: 'binary', op: '*', left: arg, right: bulk })
    : agg(reducer, arg);
  return { value: reducer === 'sum' ? negativeZeroTotal(value, tag, guarded(reduced)) : mixedRefused(reduced, value) };
}

/**
 * A `sum` whose common class is BigDecimal BECAUSE a Double or Float meets a 128-bit row (a BigInteger, or
 * a BigDecimal the per-row screen admitted — an integral source's scale-0 INTEGER carrier) is BigDecimal
 * SCALE arithmetic: `NumberHelper.add` widens every addend through `bigDecimalValue` (`BigDecimal.valueOf`
 * of a Double, `new BigDecimal(f.toString())` of a Float) and adds at the larger scale, in traverser order
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390,850-859`).
 * SQLite's REAL `SUM` keeps neither the scale (`1.0d + 5n` is `6.0`, scale 1, not `6`) nor the order a
 * running Double total is widened at (`0.1d + 0.2d + 5n` is `5.30000000000000004`). So it DEFERS — an
 * aggregate over the rows; `null` where the rows' class is statically one (no second class to meet).
 * The twin of `scaledDecimal`, which defers a BigDecimal row that is itself scale arithmetic.
 */
function decimalWidened(value: Expr, tag: ReducerRowTag): Expr | null {
  if (tag === null || tag === SCREENED || (tag.kind === 'lit' && tag.source === 'compiler-text')) return null;
  const present = (test: Expr): Expr => bin('=', agg('max', bin('and', bin('is not', value, compilerNull()), test)), compilerInt(1));
  const floating: Expr = { kind: 'in-list', expr: { kind: 'call', fn: 'coalesce', args: [tag, call('typeof', value)] }, values: ['double', 'float', 'real'].map(compilerText) };
  return bin('and', present({ kind: 'in-list', expr: tag, values: ['bigint', 'bigdecimal'].map(compilerText) }), present(floating));
}

/**
 * A `sum`/`mean` total of NEGATIVE ZEROS is a negative zero. `SumGlobalStep` and `MeanGlobalStep` SEED the
 * total from the first traverser (`mul(value, bulk)` — `-0.0 × n` is `-0.0`) and add the rest
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SumGlobalStep.java:71-78`,
 * `MeanGlobalStep.java:117-125`), and an IEEE sum is `-0.0` exactly when every addend is; a SQL `SUM`/`AVG`
 * starts from `+0.0` and answers `0.0`. So where every counted value is a negative zero, the total is one of
 * them (their `MIN`). A stream statically integral cannot hold one, and is left as it was.
 */
function negativeZeroTotal(value: Expr, tag: ReducerRowTag, total: Expr): Expr {
  if (tag !== null && tag !== SCREENED && tag.kind === 'lit' && tag.source === 'compiler-text'
    && typeof tag.value === 'string' && !['float', 'double', 'bigdecimal', 'real'].includes(tag.value)) return total;
  // ONE aggregate, the value spelled twice inside it: `atan2(v, -1)` is −π for a negative zero and +π for a
  // positive one, and every other row votes 4 — so the MAX is negative exactly where every counted row is
  // a negative zero (a NULL votes 4 too; an all-NULL stream keeps its own total).
  const vote: Expr = { kind: 'case', whens: [[bin('=', value, compilerInt(0)), { kind: 'call', fn: 'atan2', args: [value, compilerReal(-1)] }]], else: compilerInt(4) };
  return { kind: 'case', whens: [[bin('<', agg('max', vote), compilerInt(0)), compilerReal(-0)]], else: total };
}

/**
 * THE TIE AUTHORITY of a `min`/`max` — which of two members that COMPARE EQUAL is the answer, and that is
 * observable only where the two differ in REPRESENTATION: a negative and a positive zero (`-0.0` is not
 * `0.0`, though `Double.compare`-free `x >= y` calls them equal), or two BigDecimals of one value and two
 * scales (`1.0` and `1.00`; `compareTo` ignores the scale). The reference's NumberHelper helpers break a
 * tie by ARGUMENT POSITION — `max` is `x >= y ? x : y`, `min` `x <= y ? x : y`, for every number helper
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:252-277,279-310`)
 * — and the two step families pass the arguments in OPPOSITE orders:
 *
 * - a LOCAL reducer folds `result = max(next, result)`
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MaxLocalStep.java:52`,
 *   `MinLocalStep.java:52`), so the LATER member wins a tie — exact over a list, whose member order is a
 *   column (`TIE_LATER_MEMBER`, `list.ts`);
 * - a GLOBAL reducer folds `seed = apply(seed, next)` (`ReducingBarrierStep.java:110`), so the FIRST
 *   traverser wins — and a traverser stream carries no arrival order a reducer may read (none is threaded
 *   unless a slice demands it, `analyze.ts` `demandsEncounter`), so where a tie at the winner is observable
 *   the global and correlated reducers DEFER (`TIED_REPRESENTATIONS`) rather than pick one.
 *
 * This is the per-row REPRESENTATION a tie is observable through: equal across two members of one compare
 * key exactly where their promoted values cannot be told apart. A Number that is not a BigDecimal states
 * only its zero's sign (an Int `0` and a Double `-0.0` promote to two different Doubles; an Int `1` and a
 * Double `1.0` to one), a BigDecimal its carrier verbatim (conservative: an Int `1` beside a BigDecimal `1`
 * of scale 0 reads as a tie it is not, and defers). `null` where the rows' class is statically one that has
 * no second representation of a value — an integral class or a String — so no site pays for the test.
 */
export function tieRepresentation(value: Expr, tag: Expr | null): Expr | null {
  const staticTag = tag !== null && tag.kind === 'lit' && tag.source === 'compiler-text' ? String(tag.value) : undefined;
  if (staticTag !== undefined && !FLOATING_TAGS.includes(staticTag)) return null;
  // `atan2(v, −1)` is the sign-reading form (`signBit`): within one compare key it is one value for every
  // peer but a zero, where it is −π for a negative one and +π otherwise (a String's is its numeric
  // reading's, equal across equal strings). A BigDecimal is its `quote()` — storage class and digits.
  const signed: Expr = { kind: 'call', fn: 'atan2', args: [value, compilerReal(-1)] };
  const verbatim: Expr = call('quote', value);
  if (staticTag === 'bigdecimal') return verbatim;
  if (tag === null || staticTag !== undefined) return signed;
  return { kind: 'case', whens: [[bin('=', tag, compilerText('bigdecimal')), verbatim]], else: signed };
}

/**
 * NumberHelper's two-argument `max(first, second)`/`min(first, second)` as SQL — the TIE goes to `first`
 * (`tieRepresentation`), for the folds that apply the operator to an accumulator and a value
 * (`SackValueStep`'s `apply(sack, value)`, `FoldStep`'s `apply(seed, value)`: the ACCUMULATOR is first).
 * SQLite's scalar `MAX` keeps its FIRST tied argument and `MIN` its LAST (`minmaxFunc`: an argument
 * replaces the best when `compare(best, it) ^ mask >= 0`, the mask inverting the compare for `MAX`), so
 * `first` leads a `MAX` and closes a `MIN`. Pinned both ways for `-0.0`/`0.0` in
 * `number-class-authority.exec.test.ts`.
 */
export const extremumKeepingFirst = (fn: 'min' | 'max', first: Expr, second: Expr): Expr =>
  ({ kind: 'call', fn: fn.toUpperCase(), args: fn === 'max' ? [first, second] : [second, first] });

/** The deferral a global/correlated `min`/`max` raises where its winner ties a member of another
 *  representation (`tieRepresentation`). */
export const TIED_REPRESENTATIONS = 'min/max whose winner ties an equal value of another representation (a signed zero or a BigDecimal scale) is not supported';

/** The deferral a FLOAT running total raises where its per-step rounding is not decidable here. */
export const FLOAT_SUM_INEXACT = 'sum/mean over Float values that float arithmetic would round is not supported';
/** The grid a Float running total is exact on: multiples of 2^-10 … */
const FLOAT_GRID = 1024;
/** … whose magnitudes total below 2^14, so every partial sum holds in a float's 24 bits. */
const FLOAT_GRID_LIMIT = 16384;

/**
 * A `sum`/`mean` whose rows hold a FLOAT runs a FLOAT total: `SumGlobalStep`/`MeanGlobalStep` add through
 * `NumberHelper.add`, and while the running class is a Float every step is `FLOAT_NUMBER_HELPER.add` —
 * rounded to a float at EACH step, and promoted to a Double only on overflow
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:225-229,400-425`).
 * A SQL `SUM` adds in double and rounds once, which is that answer exactly where no partial sum rounds: every
 * row on a 2^-10 grid with their magnitudes totalling below 2^14 (each partial sum then needs at most 24
 * bits, and no step overflows). Elsewhere — `ten × 0.1f` is 1.0000001f in float steps, two `3.4e38f` overflow
 * into a Double — the total DEFERS rather than answer the once-rounded double. An aggregate over the rows:
 * a Float row present and the grid bound exceeded; `null` where no row can be a Float.
 *
 * A `sum` of exactly TWO Float traversers is ONE IEEE operation and so exact anywhere below the overflow: it
 * adds as `a.floatValue() + b.floatValue()` — the exact sum rounded once to a float, which is the double sum
 * (exact for two floats within 2^29 of each other's exponent, and otherwise too far below the larger's
 * half-ulp to move its float) rounded to a float (`rounds`, `floatValueOf`). One traverser of bulk 2 is
 * `mul(value, 2f)`, exact the same way. Only a STATIC Float tag takes it. A pair that would overflow a float promotes to a Double
 * (`mathOperationWithPromote`, `NumberHelper.java:400-425`), so it still defers. A `mean` divides the
 * float-rounded total, which this does not spell, so it keeps the grid rule.
 */
function floatInexact(value: Expr, tag: ReducerRowTag, reducer: Reducer, bulk?: Expr): { refuse: Expr; rounds?: Expr } | null {
  if (tag === null || tag === SCREENED) return null;
  const isFloat: Expr | boolean = tag.kind === 'lit' && tag.source === 'compiler-text' ? tag.value === 'float' : bin('=', tag, compilerText('float'));
  if (isFloat === false) return null;
  // Each row spends its magnitude, plus 1e300 off the grid; a NULL spends nothing (`SUM` skips it).
  const scaled = bin('*', value, compilerInt(FLOAT_GRID));
  const offGridCost: Expr = { kind: 'case', whens: [[bin('=', scaled, { kind: 'cast', arg: scaled, to: 'int' }), compilerInt(0)]], else: compilerReal(1e300) };
  const magnitude = bulk ? bin('*', call('abs', value), bulk) : call('abs', value);
  const spent = agg('sum', bin('+', magnitude, offGridCost));
  // ONE traverser is never rounded: its total is `mul(value, coerceTo(1, Float))`, the value itself
  // (`SumGlobalStep.projectTraverser`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SumGlobalStep.java:71-78`),
  // and a mean divides that by one — so a lone stored `0.1f` sums to itself.
  const traversers = agg('sum', { kind: 'case', whens: [[bin('is not', value, compilerNull()), bulk ?? compilerInt(1)]], else: compilerInt(0) });
  const offGrid = bin('and', bin('>=', spent, compilerInt(FLOAT_GRID_LIMIT)), bin('>', traversers, compilerInt(1)));
  const refuse = isFloat === true ? offGrid : bin('and', bin('=', agg('max', isFloat), compilerInt(1)), offGrid);
  if (reducer !== 'sum' || isFloat !== true) return { refuse };
  // The pair rule above, for a stream KNOWN to hold Floats only (a per-row tag would spell a class test into
  // every reducer over a mixed stream, which defers as before): two traversers, the total inside the float
  // range, rounded once to a float — below the float normal range the sum of two floats already is one
  // (a multiple of 2^-149 in at most 24 bits).
  const total = agg('sum', bulk ? bin('*', value, bulk) : value);
  const pair = bin('and', bin('=', traversers, compilerInt(2)), bin('<', call('abs', total), compilerReal(FLOAT_OVERFLOW)));
  return {
    refuse: bin('and', refuse, { kind: 'unary', op: 'not', arg: pair }),
    rounds: bin('and', pair, bin('>=', call('abs', total), compilerReal(FLOAT_MIN_NORMAL))),
  };
}

const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const storageIs = (value: Expr, storage: string): Expr => bin('=', call('typeof', value), compilerText(storage));

/** THE COLUMN a numeric reducer states its result's class in — a Gremlin type name, never a storage class —
 *  and the framing type that says so. ONE pair, because the producer that writes the column and every
 *  consumer that reads it (`framingCols`, a fold member, a group key, a record field re-read through
 *  `select`) must agree on where the class rides; a reducer framed `UNKNOWN` beside a `vt` column was a
 *  class every consumer but the top-level framer dropped. */
export const REDUCED_CLASS_COL = 'vt';
export const REDUCED_TYPE: ScalarType = PER_ROW(REDUCED_CLASS_COL);

/**
 * An UNTAGGED value's canonical Gremlin type, inferred from its SQLite storage class — the same inference
 * the wire applies to an untagged value (an INTEGER is an Int inside 32 bits and a Long past them, a REAL a
 * Double, TEXT a String), so naming it here is not a second policy. A MIXED list hands every bare member a
 * type through it, and the number-class authority below reads an untagged row's class through it.
 */
export const inferredVtype = (value: Expr): Expr => {
  // Spelled with the value TWICE, not once per arm: the value is routinely a fused arithmetic over a
  // correlated read, and a `CASE typeof(v) …` per class would repeat that subquery four times. `typeof` is
  // rewritten by `replace` (no class name contains another's), and the int32 test is the one-spelling
  // `abs(2v + 1) <= 2^32 - 1`. NULL for a NULL (and a BLOB, which nothing frames as a number).
  const int32 = bin('<=', call('abs', bin('+', bin('*', compilerInt(2), value), compilerInt(1))), compilerInt(4294967295));
  const integral: Expr = { kind: 'case', whens: [[int32, compilerText('int')]], else: compilerText('long') };
  const renamed = [['integer', integral], ['real', compilerText('double')], ['text', compilerText('string')]] as const;
  const named = renamed.reduce<Expr>((inner, [cls, tag]) => ({ kind: 'call', fn: 'replace', args: [inner, compilerText(cls), tag] }), call('typeof', value));
  return { kind: 'call', fn: 'nullif', args: [{ kind: 'call', fn: 'nullif', args: [named, compilerText('null')] }, compilerText('blob')] };
};

// ---------- THE NUMBER-CLASS AUTHORITY (build plan §6·7: the class is EXACT) ----------
//
// `NumberHelper.getHighestCommonNumberInfo` reads each number as a WIDTH (Byte 8, Short 16, Integer and
// Float 32, Long and Double 64, BigInteger and BigDecimal 128) and a FLOATING flag, keeps the widest width
// and whether ANY number floats, and `determineNumberClass` names the class of that pair
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390,861-874`).
// Every promoting result is that class: `sum` and arithmetic (`mathOperationWithPromote`, `:400-430`), and
// `min`/`max` (`NumberHelper.max(Comparable, Comparable)` promotes both sides, `:639-655`, so
// `inject(5, 2.0d).max()` is the Double 5.0); `mean` alone is always a Double (`MeanGlobalStep`). So the
// pair is read in ONE place per row (`numberWidth`/`numberFloating`), carried through a reduction as two
// `MAX` aggregates (`numberClassAggs` — a plain `MAX`, so a window or a scalar `max(a, b)` keeps it the
// same way), and named in ONE place (`commonNumberClass`). Every reducer site, the sack's folds and the
// winner of a `min`/`max` read it there; none re-derives a class from a storage class.

/** Each number class's `getHighestCommonNumberInfo` width, by tag — and an untagged REAL's (a Double). An
 *  untagged INTEGER is read by its magnitude (`numberWidth`), as the wire infers it. */
const CLASS_WIDTH = JSON.stringify({ byte: 8, short: 16, int: 32, long: 64, bigint: 128, float: 32, double: 64, bigdecimal: 128, real: 64 });
/** The width a value that is not a Number reads as — past every number's, so `MAX` keeps it. */
const NOT_A_NUMBER_WIDTH = 1024;
const FLOATING_TAGS = ['float', 'double', 'bigdecimal', 'real'];
/** `determineNumberClass`, keyed `i<bits>` / `f<bits>`. */
const CLASS_OF = JSON.stringify({ i8: 'byte', i16: 'short', i32: 'int', i64: 'long', i128: 'bigint', f32: 'float', f64: 'double', f128: 'bigdecimal' });

/** The narrowest integral width holding an integer `n` — `abs(n + 0.5)` against each bound, so each bound
 *  is one comparison (`-128`…`127` is `|n + 0.5| < 128`). */
const integralWidth = (n: Expr): Expr => {
  const magnitude: Expr = call('abs', bin('+', n, compilerReal(0.5)));
  return {
    kind: 'case',
    whens: [[bin('<', magnitude, compilerInt(128)), compilerInt(8)], [bin('<', magnitude, compilerInt(32768)), compilerInt(16)],
      [bin('<', magnitude, compilerInt(2147483648)), compilerInt(32)]],
    else: compilerInt(64),
  };
};

/** How a value carried as TEXT under a number tag counts: as that number (an ORDERING reducer, which
 *  admits it), or as no number at all (an arithmetic one, which leaves it out of the total — naming the
 *  total's class after a value it did not add would frame a wrong total as an exact one). */
export type TextHeld = 'number' | 'not-a-number';

/** A row's `getHighestCommonNumberInfo` WIDTH — NULL for a null value (`MAX` skips it, as `isNumber`
 *  does), `NOT_A_NUMBER_WIDTH` for a value that is not a Number. `tag` is the row's Gremlin type (NULL for
 *  an untagged row, which its storage class then decides: an INTEGER by its magnitude, a REAL a Double). */
export function numberWidth(value: Expr, tag: Expr | null, textHeld: TextHeld = 'number'): Expr {
  const key: Expr = tag ? { kind: 'call', fn: 'coalesce', args: [tag, call('typeof', value)] } : call('typeof', value);
  const untaggedInteger: Expr = tag
    ? bin('and', bin('is', tag, compilerNull()), storageIs(value, 'integer'))
    : storageIs(value, 'integer');
  return {
    kind: 'case',
    whens: [
      [bin('is', value, compilerNull()), compilerNull()],
      ...(textHeld === 'not-a-number' ? [[storageIs(value, 'text'), compilerInt(NOT_A_NUMBER_WIDTH)] as const] : []),
      // An untagged INTEGER is an Int inside 32 bits and a Long past them — never a Byte or a Short.
      [untaggedInteger, { kind: 'case', whens: [[bin('<', call('abs', bin('+', value, compilerReal(0.5))), compilerInt(2147483648)), compilerInt(32)]], else: compilerInt(64) }],
    ],
    else: { kind: 'call', fn: 'coalesce', args: [{ kind: 'call', fn: 'json_extract', args: [compilerText(CLASS_WIDTH), bin('||', compilerText('$.'), key)] }, compilerInt(NOT_A_NUMBER_WIDTH)] },
  };
}

/** A row's FLOATING flag — 1 for a Float/Double/BigDecimal (an untagged REAL included), else 0; NULL for a
 *  null value. */
export function numberFloating(value: Expr, tag: Expr | null): Expr {
  const key: Expr = tag ? { kind: 'call', fn: 'coalesce', args: [tag, call('typeof', value)] } : call('typeof', value);
  return {
    kind: 'case',
    whens: [[bin('is', value, compilerNull()), compilerNull()], [{ kind: 'in-list', expr: key, values: FLOATING_TAGS.map(compilerText) }, compilerInt(1)]],
    else: compilerInt(0),
  };
}

/** The two columns a reduction carries its result's class in (`numberClassAggs`). */
export const CLASS_WIDTH_COL = 'clw';
export const CLASS_FLOATING_COL = 'clf';

/** THE STREAM'S CLASS PAIR, as two aggregates over its rows — for a reducer to carry beside its value. */
export const numberClassAggs = (value: Expr, tag: Expr | null, textHeld: TextHeld): readonly (readonly [string, Expr])[] => [
  [CLASS_WIDTH_COL, agg('max', numberWidth(value, tag, textHeld))],
  [CLASS_FLOATING_COL, agg('max', numberFloating(value, tag))],
];

/**
 * `determineNumberClass` over a stream's widest `width` and its `floating` flag (each the `MAX` of the
 * rows' `numberWidth`/`numberFloating`), or `fallback` where the stream holds no Number at all (every
 * value null — the result is null — or a value that is not a Number, a String's `min`).
 *
 * An integral class is widened by the RESULT's own magnitude, because `mathOperationWithPromote` retries an
 * overflowing operation at the next width rather than wrap (`NumberHelper.java:401-430`), so a sum of
 * Integers past 2^31 is a Long and `withSack(127b).inject(1b).sack(sum)` the Short 128; for `min`/`max`
 * the result is one of the values and the widening never fires. A residue of an UNTAGGED stream: the
 * reference promotes on an INTERMEDIATE overflow too, so a sum whose running total passed a width and came
 * back is wider there.
 */
export function commonNumberClass(width: Expr, floating: Expr, result: Expr, fallback: Expr): Expr {
  // `f<width>` or `i<max(width, the result's own width)>` — spelled so `width`, routinely the longest
  // operand, appears once.
  const floats = bin('=', floating, compilerInt(1));
  // A floating result past `Float.MAX_VALUE` is the Float operation's overflow retried at Double
  // (`:413-425`), so it widens a Float to a Double exactly as an integral overflow widens an Integer.
  const key: Expr = bin('||',
    { kind: 'case', whens: [[floats, compilerText('f')]], else: compilerText('i') },
    { kind: 'call', fn: 'max', args: [width, { kind: 'case', whens: [[floats, {
      kind: 'case', whens: [[bin('>=', call('abs', result), compilerReal(FLOAT_OVERFLOW)), compilerInt(64)]], else: compilerInt(0) }]],
    else: integralWidth(result) }] });
  return { kind: 'call', fn: 'coalesce', args: [{ kind: 'call', fn: 'json_extract', args: [compilerText(CLASS_OF), bin('||', compilerText('$.'), key)] }, fallback] };
}

/** The class pair as ONE aggregate value — `[width, floating]` — for a reduction that is itself one
 *  correlated read (a list's `sum(local)`/`max(local)`), where two columns would be two subqueries. */
export const numberClassPair = (value: Expr, tag: Expr | null, textHeld: TextHeld): Expr =>
  ({ kind: 'call', fn: 'json_array', args: numberClassAggs(value, tag, textHeld).map(([, aggregate]) => aggregate) });

/** `commonNumberClass` over a `numberClassPair`. */
export const pairedNumberClass = (pair: Expr, result: Expr, fallback: Expr): Expr => {
  const part = (path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [pair, compilerText(path)] });
  return commonNumberClass(part('$[0]'), part('$[1]'), result, fallback);
};

/** `commonNumberClass` over a reduction's two class columns (`numberClassAggs`). */
export const reducedNumberClass = (rel: RelId, result: Expr, fallback: Expr): Expr =>
  commonNumberClass(col(rel, CLASS_WIDTH_COL), col(rel, CLASS_FLOATING_COL), result, fallback);
