import { and, col, compilerInt, compilerNull, compilerReal, compilerText, param, signBit, type Expr } from '../../rel/expr.ts';
import { jsonEachSet, meta, typeOf, type Minter } from './build.ts';
import * as make from '../../rel/factory.ts';
import { deferralExpr, raiseExpr } from '../../rel/raise.ts';
import { inferredVtype, MIXED_COMPARABLES } from './reducer.ts';
import type { RelId, SortTerm, SqlType } from '../../rel/types.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ScalarType } from '../../sql/kernel/render.ts';
import { gtypeName, arg, collectionMembers, isNested, type Arg } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, normalizeTypeName, numberClassOf, STORAGE_CLASS, type TypeNode } from '../../gremlin/types.ts';
import { constLit } from './const.ts';
import { adjacent, decimalCompare, decimalOf, doubleText, floatingDecimal, floatText } from '../../gremlin/float.ts';
import { floatValueOf } from './float.ts';
import { containedText } from './text-units.ts';

/**
 * `P`/`TextP` AS RelIR EXPRESSIONS — the predicate vocabulary, re-expressed in the algebra.
 *
 * This module is the predicate vocabulary, expressed in the algebra. It exists as its own module
 * because a predicate is the most reused thing in the language — `has`, `where`, `is`, `filter`,
 * `not`, an edge criterion and a `by()`-modulated comparison are all the same question asked of
 * different subjects — so the RelIR spine grows all of them at once by growing this.
 *
 * TWO RULES, both load-bearing:
 *
 * - **It never throws.** An operand or an op it cannot express returns `null`, declining the whole
 *   traversal (a miss the caller raises as `UnsupportedTraversal`); a decline is the answer here,
 *   and a throw would turn "not learned yet" into a support regression.
 * - **It never answers a DIFFERENT question.** Every arm below either reproduces the semantics
 *   exactly or declines. The subtle one is ordering: a property value is stored in its
 *   natural SQLite storage class where it fits, and as TEXT where it does not (a long past 2^53, a
 *   bigint, a bigdecimal, a duration), so a plain `>` orders those rows LEXICALLY and after every
 *   numeric row. `compareKey` is the per-row fix and a range comparison MUST go through it — see
 *   `plan.ts` `compareKey` for the measurement behind the type lists.
 */

/** A parsed `P`/`TextP` as the front-end produces it. Structural, because `Step.args` is the
 *  wire boundary and a GLV may supply anything. */
interface Pred { readonly op: string; readonly operands: readonly Arg[]; }
const isPred = (value: unknown): value is Pred =>
  value !== null && typeof value === 'object' && 'op' in value && Array.isArray((value as Pred).operands);

const binary = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
/** A SQL expression that is always FALSE but does not constant-fold, so a CASE `else` (or a
 *  comparability mismatch) stays a real per-row branch a later pass will not drop. */
const compilerFalse: Expr = binary('!=', { kind: 'call', fn: 'json_object', args: [] }, { kind: 'call', fn: 'json_object', args: [] });
/** Gremlin predicates are two-valued: negating SQL NULL is TRUE, not NULL. */
const negated = (inner: Expr): Expr => binary('is not', inner, compilerInt(1));
/** SQLite has no boolean literal; a degenerate set folds to a constant comparison rather than to a
 *  bare `0`, so the expression still reads as a predicate wherever it is spliced. */
/** The two constant predicates, spelled once. A lowering that has PROVEN an outcome says so with
 *  these rather than inventing its own always-false expression at each site. */
export const CONSTANT = { true: binary('=', compilerInt(1), compilerInt(1)), false: binary('=', compilerInt(1), compilerInt(0)) };

const COMPARISON: Readonly<Record<string, Extract<Expr, { kind: 'binary' }>['op']>> =
  { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
/** The four whose SQL comparison must be vtype-aware — see the module header. */
const ORDERING = new Set(['gt', 'gte', 'lt', 'lte']);

/** STATIC subject types an ordering comparison DECLINES rather than mis-comparing — a NATIVE temporal
 *  (`datetime`; also a `duration` that did NOT arrive as a decimal-TEXT tail): it rides as a raw
 *  epoch/nanos with no per-row `vtype` to line the bound up against. A TEXT tail of the SAME tag is
 *  handled EARLIER in `ordered` by the `type.text` cast, so `inject(Duration(…))` now orders instead of
 *  declining. `bigdecimal`/`long`/`bigint` are absent for the same reason — cast when TEXT, native
 *  otherwise (`asNumber(BIGDECIMAL)`→REAL, `count()`→INTEGER) — the storage-class enrichment that
 *  disambiguates the two having LANDED (`type.text`; docs/archive/2026-08-05-parameters-are-the-only-binds.md C1). */
const STATIC_ORDERING_DECLINE = new Set(['datetime', 'duration']);

/**
 * An operand this vocabulary can compare against, routed through the one const/param seam.
 *
 * `string`/`number` only, deliberately. A `bigint`, a `Duration` or a `BigDecimal` needs the
 * matching `CAST` on the BOUND side to line up with `compareKey`'s cast on the column side
 * (`plan.ts` `compareBound`), and a nested traversal needs a correlated per-traverser value that
 * no pure predicate can build. All of them decline.
 *
 * A parsed literal INLINES (a constant — the value-operand budget win), a wire PARAMETER (`paramName`,
 * the operand's `Arg.name`) BINDS. Storage class does not matter for a comparison operand — SQLite
 * compares an INTEGER `2` and a REAL `2.0` numerically alike — so a nested operand with no declared
 * type inlines by its value's own shape without changing any answer.
 *
 * The EXACT NUMERIC TAIL — bigint / BigDecimal / Duration — is stored as canonical decimal TEXT
 * (`storedScalar`), so it inlines as that TEXT literal (equality is TEXT=TEXT) or binds
 * as a parameter; the ordering CAST that lines it up with `compareKey` is `ordered`'s job (`isExactTail`
 * → `castBound`). This is why the lowering COVERS these operands.
 */
const operand = (value: unknown, type: TypeNode | null = null, paramName: string | null = null): Expr | null => {
  // A BOOLEAN is 1/0, which is how it is STORED — `storedValue` writes the same encoding
  // (`gremlin/types.ts`, and `GraphStore` coerces at the bind seam because DO SQLite refuses a
  // boolean bind outright). So `has('active', true)` is an ordinary integer comparison and needs no
  // vocabulary of its own; excluding it here was the whole of the gap.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return constLit(arg(value, type, paramName));
  if (isExactTail(value)) return paramName != null ? param(value, paramName) : compilerText(String(value));
  return null;
};

/** The numeric tail stored as decimal TEXT — a bigint, a BigDecimal, or a Duration (total-nanos). Its
 *  ordering comparison casts to the column's numeric class (`compareBound`): BigDecimal → REAL, the two
 *  integrals → INTEGER. */
const isExactTail = (value: unknown): boolean =>
  typeof value === 'bigint' || value instanceof BigDecimal || value instanceof Duration;
const exactTailCast = (value: unknown): SqlType | null =>
  value instanceof BigDecimal ? 'real' : (typeof value === 'bigint' || value instanceof Duration) ? 'int' : null;

/** The numeric class a TEXT-stored static SUBJECT casts to in an ordering compare, keyed by canonical
 *  type (`normalizeTypeName` output). The cast is IDENTITY on the native form of the same tag (a native
 *  `long` is already INTEGER, an `asNumber(BIGDECIMAL)` REAL) and the conversion on the decimal/nanos-TEXT
 *  form (`inject(9.99m)` → REAL), so it is correct once `type.text` says which storage class is in hand. */
const STATIC_SUBJECT_CAST: Record<string, SqlType> = { bigdecimal: 'real', long: 'int', bigint: 'int', duration: 'int' };

/** Storage classes `compareKey` casts to, as `plan.ts` measured them. A fixed compile-time
 *  vocabulary — never user input — so there is no injection surface in the names themselves. */
const CAST_TO_INT = ['byte', 'short', 'int', 'long', 'bigint', 'datetime', 'duration'];
export const CAST_TO_REAL: readonly string[] = ['float', 'double', 'bigdecimal'];
export const NUMERIC_CAST_TO_INT: readonly string[] = CAST_TO_INT.filter((type) => type !== 'datetime' && type !== 'duration');
/** The vtypes that name a `Number` — a `datetime`/`duration` is numeric to SQLite and not to Gremlin. */
export const NUMERIC_VTYPES: readonly string[] = [...NUMERIC_CAST_TO_INT, ...CAST_TO_REAL];

/**
 * The vtype-aware ordering key for a stored property value: `(value, vtype) -> a correctly-ordered
 * SQLite value`. Pass it as `compare` wherever a per-row `vtype` column is in scope; omit it where
 * the subject is already a native JS type (a computed scalar).
 *
 * The type lists are compiler-authored vocabulary, not query data, so they render as escaped SQL
 * string literals. User operands still use `lit()` and remain bound; this preserves the plan's data
 * budget while not wasting it on a fixed type vocabulary.
 */
/**
 * WHAT IS KNOWN ABOUT THE SUBJECT'S GREMLIN TYPE — one total union, replacing what used to be an
 * optional `compare` callback.
 *
 * Two predicate arms need this and they need DIFFERENT halves of it, which is why it is a vocabulary
 * rather than a flag or a function: the four ordering comparisons need the vtype as an EXPRESSION (to
 * build the cast key), and `typeOf` needs either a compile-time type name (constant-fold), the vtype
 * expression (compare it), or neither (fall back to the storage class). An optional callback could
 * carry the first and not the second, so `typeOf` would have had to take a second parameter — two
 * optionals describing one fact, which is the shape `docs/2026-07-28-scalartype-refactoring-pattern.md`
 * exists to refuse. The coarse view (`compare`) is DERIVED below rather than passed alongside.
 *
 * It is deliberately NOT `plan.ts`'s `TypeCtx` imported: that one carries a kernel `Expression`, and
 * the RelIR side must speak `Expr` (§2, the clean-room boundary). Same three cases, different layer.
 */
export type SubjectType =
  /** A compile-time canonical Gremlin type name — `count()`'s `long`, a typed `inject`. `text` marks a
   *  decimal-TEXT-stored exact tail (`inject(9.99m)`, a bound big long/Duration) so an ordering compare
   *  casts the subject to its numeric class; unset means a native REAL/INT of the same tag. */
  | { readonly kind: 'static'; readonly type: string; readonly text?: boolean }
  /** The subject came from a stored property, so its type is the row's own `vtype` column. */
  | { readonly kind: 'perRow'; readonly vtype: Expr }
  /** Nothing is known about the subject's NUMBER class — an untyped computed scalar. `tag`, where present,
   *  is a per-row tag in a MIXED vocabulary (a Gremlin type or a reducer's storage class — a coalesce
   *  framed `result: 'number'`), which cannot key a cast but CAN say a row sits in another type space
   *  (`typeSpaced`). */
  | { readonly kind: 'unknown'; readonly tag?: Expr };

export const SUBJECT_UNKNOWN: SubjectType = { kind: 'unknown' };

/**
 * A PER-ROW subject: the row's own tag where it names a Gremlin type, and the value's own inference
 * (`inferredVtype`) where the tag is NULL. A NULL tag means "read the value" in EVERY per-row column —
 * a mixed `inject`'s undeclared argument (`inject(1.0, 2)` tags only the Double), a merged branch arm
 * that could not say (`withMergedVtype`) — and the framer already reads it that way; a predicate that
 * compared the bare NULL put an `int` in no number class, so `inject(1.0, 2).union(identity(),
 * identity()).is(gt(0))` dropped the 2s and `choose(is(gt(0)), …)` routed them to the false arm. The
 * inference is the framer's own (an INTEGER is an `int` inside int32, else a `long`), so
 * `is(typeOf(GType.INT))` agrees with the class the value is framed as. THE one constructor, so no
 * per-row subject can be built that reads a NULL tag differently.
 */
export const perRowSubject = (vtype: Expr, value: Expr): SubjectType =>
  ({ kind: 'perRow', vtype: { kind: 'call', fn: 'coalesce', args: [vtype, inferredVtype(value)] } });

/**
 * A Gremlin `Number` class as `NumberHelper.getHighestCommonNumberInfo` reads it — bit width and
 * floating-ness — collapsed to the distinctions a comparison can observe. `int32` is byte/short/int.
 */
type NumClass = 'int32' | 'long' | 'bigint' | 'float' | 'double' | 'bigdecimal';
const NUM_CLASS: Readonly<Record<string, NumClass>> = {
  byte: 'int32', short: 'int32', int: 'int32', long: 'long', bigint: 'bigint', float: 'float', double: 'double', bigdecimal: 'bigdecimal',
};
const TWO_53 = 2 ** 53;
const TWO_24 = 2 ** 24;

/** The bound's class: its declared type, else its value's own shape. */
function boundClass(value: unknown, boundType: TypeNode | null): NumClass | null {
  const declared = flatType(boundType);
  if (declared !== null && NUM_CLASS[declared]) return NUM_CLASS[declared]!;
  if (typeof value === 'bigint') return value >= -(2n ** 63n) && value < 2n ** 63n ? 'long' : 'bigint';
  if (value instanceof BigDecimal) return 'bigdecimal';
  if (typeof value === 'number') { const cls = numberClassOf(value); return cls === 'int' ? 'int32' : cls; }
  return null;
}
const magnitude = (value: unknown): number =>
  typeof value === 'bigint' ? Math.abs(Number(value)) : typeof value === 'number' ? Math.abs(value) : Math.abs(Number(String(value)));

/**
 * HOW A SUBJECT OF CLASS `subject` MEETS THIS BOUND so SQLite's comparison is the reference's.
 *
 * SQLite compares an INTEGER and a REAL EXACTLY. `NumberHelper.compare` does not: it converts both sides
 * to their highest common class first (`getHighestCommonNumberClass`), so a Long against a Double is
 * `Double.compare(a.doubleValue(), b.doubleValue())` and an Integer against a Float is a FLOAT compare
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-398,670-681`;
 * `Compare.java:66-69` routes every ordering and `eq` through it). The two agree except where the
 * conversion ROUNDS, and that happens in exactly two places:
 *
 * - a `long` past 2^53 against a `double`/`float` — the long rounds to a double. Only a bound at or past
 *   2^53 can tell (rounding is monotone, and every long below 2^53 converts exactly), so the subject is
 *   compared as `CAST(… AS REAL)` — which IS `Long.doubleValue()`, round-to-nearest — only then. The
 *   other direction, a `double`/`float` subject against a `long` bound past 2^53, rounds the BOUND, which
 *   the compiler holds, so it is converted here (`Number(bigint)` is round-to-nearest too).
 * - an `int` past 2^24 against a `float` — a FLOAT compare. A float bound that large against an `int`
 *   subject is exact only while the subject is within 2^24 (every such int is a float), and SQLite has no
 *   single precision to do the rest, so the comparison is `guarded`: it RAISES a deferral for a subject
 *   past 2^24 (`guardedCompare`). An int bound that large against a `float` subject rounds the bound
 *   here (`Math.fround`).
 *
 * A `BigInteger`/`BigDecimal` against anything widens to an EXACT class (`BigDecimal`), which is SQLite's
 * own compare.
 */
interface NumericPair {
  readonly real: boolean; readonly bound: Expr; readonly guarded?: true;
  /** A `guarded` pair whose subject is KNOWN to be an Integer: it rounds to its float (`floatValueOf`) and compares
   *  exactly, rather than raise — the raise stays for a subject only its storage class describes, which may be a Long. */
  readonly asFloat?: true;
  /** An INTEGRAL pair one side of which is a BigInteger: compared EXACTLY against this bound
   *  (`integralCompare`), because a `CAST(… AS INTEGER)` SATURATES at int64 on both sides. */
  readonly exact?: bigint;
  /** A BigInteger subject against a NON-FINITE floating bound — `BigDecimal.valueOf(Infinity)` throws — so a
   *  subject past int64 raises (inside int64 SQLite's compare with an infinity is the only answer). */
  readonly wideUndecided?: true;
  /**
   * THE CELLS where the reference's widening and SQLite's exact compare disagree, each with the reference's
   * own compare result there; every other row compares exactly against `bound`, as a REAL (`real`).
   *
   * A widening that ROUNDS (a Float to `Float.toString`'s decimal, a Double to `BigDecimal.valueOf`'s,
   * `NumberHelper.java:851-859`) moves a value only within its own rounding interval, so it can change an
   * order only for a subject whose interval holds the bound — a carrier the compiler names in advance (the
   * bound's nearest float or double, and each of its neighbours, so an interval-edge tie cannot slip past).
   * Each such carrier's answer is decided HERE, from the two exact decimals; no other row can differ.
   * A ZERO cell is `Double.compare`'s signed zero: `-0.0` orders below `0.0` (`NumberHelper.java:277`), which
   * SQLite's `=` cannot see, so its outcome reads the subject's sign (`atan2`).
   */
  readonly cells?: readonly Cell[];
}
type Cell = { readonly at: number; readonly cmp: number } | { readonly at: 0; readonly negative: number; readonly positive: number };
const INTEGRAL: ReadonlySet<NumClass> = new Set(['int32', 'long', 'bigint']);
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const LONG_RANGE = (n: bigint): boolean => n >= LONG_MIN && n <= LONG_MAX;
function numericPair(subject: NumClass, bound: NumClass, value: unknown, castBound: Expr): NumericPair {
  const pair = widenedPair(subject, bound, value, castBound);
  // `Double.compare`'s SIGNED ZERO, wherever the common class floats (a BigDecimal has no negative zero):
  // `inject(0.0d).is(-0.0d)` is false and `inject(-0.0d).is(P.lt(0.0d))` true. Only a REAL subject can be
  // a negative zero, so an integral subject needs the cell only against a `-0.0` bound.
  const floating = (cls: NumClass): boolean => cls === 'float' || cls === 'double';
  const zero = typeof value === 'number' && value === 0;
  const negativeBound = zero && Object.is(value, -0);
  if (zero && !pair.cells && (floating(subject) ? !BIG.has(bound) : floating(bound) && negativeBound))
    return { ...pair, cells: [{ at: 0, negative: negativeBound ? 0 : -1, positive: negativeBound ? 1 : 0 }] };
  return pair;
}
const BIG: ReadonlySet<NumClass> = new Set(['bigint', 'bigdecimal']);

/** A bound's exact decimal value, for a widening to `BigDecimal` to compare against. */
function boundDecimal(value: unknown): BigDecimal | null {
  if (typeof value === 'bigint') return new BigDecimal(value, 0);
  if (value instanceof BigDecimal) return value;
  return typeof value === 'number' && Number.isFinite(value) ? decimalOf(String(value)) : null;
}

/** `NumberHelper.bigDecimalValue` of a bound (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-859`):
 *  a BigDecimal as is, an integral class exactly, a Float through `Float.toString` and a Double through
 *  `BigDecimal.valueOf` (`Double.toString`) — the PRINTED decimal, never the binary value. `'nan'`/`'infinite'`
 *  for the two a `BigDecimal` cannot hold; `null` for a bound that is not a number. */
function bigDecimalWidening(value: unknown, boundCls: NumClass): BigDecimal | 'nan' | 'infinite' | null {
  if (value instanceof BigDecimal) return value;
  if (typeof value === 'bigint') return new BigDecimal(value, 0);
  if (typeof value !== 'number') return null;
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return 'infinite';
  if (boundCls === 'float' || boundCls === 'double' || !Number.isInteger(value)) return floatingDecimal(value, boundCls === 'float');
  return new BigDecimal(BigInt(value), 0);
}

/** A BigDecimal's VALUE as canonical plain text — trailing fractional zeros dropped, so two scales of one
 *  value spell alike (`BigDecimal.compareTo` ignores scale; `1.0` and `1` are one value). */
function canonicalDecimal(d: BigDecimal): string {
  let { unscaled, scale } = d;
  if (unscaled === 0n) return '0';
  while (scale > 0 && unscaled % 10n === 0n) { unscaled /= 10n; scale--; }
  return new BigDecimal(unscaled, scale).toString();
}
/**
 * Does a decimal-TEXT carrier (`storedScalar` writes `BigDecimal`'s PLAIN form — no exponent, a '.' only with
 * a fraction) hold one of these canonical values, whatever its scale? A FRACTIONAL canonical (it holds a '.'
 * and no trailing zero) is the carrier with its trailing zeros trimmed — only a fraction's zeros can trim
 * down to a text holding a '.'. An INTEGRAL one is the carrier itself, or the carrier trimmed to `c.` (`29.000`;
 * `290` trims to `29`, which never carries the '.').
 */
const decimalTextMatch = (text: Expr, canonicals: readonly string[]): Expr => {
  const trimmed: Expr = { kind: 'call', fn: 'rtrim', args: [text, compilerText('0')] };
  const among = (e: Expr, values: readonly string[]): Expr =>
    values.length === 1 ? binary('=', e, compilerText(values[0]!)) : { kind: 'in-list', expr: e, values: values.map(compilerText) };
  const integral = canonicals.filter((c) => !c.includes('.'));
  const trims = canonicals.map((c) => (c.includes('.') ? c : `${c}.`));
  return integral.length ? binary('or', among(text, integral), among(trimmed, trims)) : among(trimmed, trims);
};
const isText = (subject: Expr): Expr => binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('text'));

/** The deferral an equality raises where the reference throws: `BigDecimal.valueOf(±Infinity)`. */
const INFINITE_DECIMAL = 'comparing a BigDecimal with an infinity is not supported';

/** A number bound's BigDecimal widening, as the one thing the decimal forms below need: its canonical text
 *  and the double that alone can equal it (`null` where no double prints as it — `Double.toString(r)` reads
 *  back as `r`, so the one candidate is the bound's nearest double, and only if THAT prints as the bound). */
type DecimalBound = { readonly canonical: string; readonly double: number | null } | 'nan' | 'infinite';
function decimalBound(value: unknown, boundCls: NumClass): DecimalBound | null {
  const bound = bigDecimalWidening(value, boundCls);
  if (bound === null || bound === 'nan' || bound === 'infinite') return bound;
  const canonical = canonicalDecimal(bound);
  const nearest = Number(canonical);
  const prints = Number.isFinite(nearest) && decimalCompare(decimalOf(doubleText(nearest))!, bound) === 0;
  return { canonical, double: prints ? nearest : null };
}

/**
 * EQUALITY WHERE THE COMMON CLASS IS BIGDECIMAL — `NumberHelper.compare` widens both sides to `BigDecimal`
 * whenever either is one (`getHighestCommonNumberClass`, `NumberHelper.java:362-398`) and compares by
 * `compareTo`, which ignores SCALE (`NumberHelper.java:301`). A raw SQLite `=` sees neither rule: a BigDecimal
 * rides as decimal TEXT, which never equals a REAL or an INTEGER (`inject(1m).is(1)` was empty), and two
 * scales of one value are two texts (`inject(1.0m).is(1m)` was empty). So the row's STORAGE decides the exact
 * form, per row, at whatever depth the subject was produced:
 *
 * - a decimal-TEXT row (a BigDecimal, or an integral class past 2^53 against a BigDecimal bound) compares its
 *   canonical text with the bound's canonical widening;
 * - an INTEGER row is an integral value (`BigDecimal.valueOf(long)`), equal only to an integral bound;
 * - a REAL row is a Double's widening (`BigDecimal.valueOf`, `Double.toString`), equal only to the one double
 *   that prints as the bound (`DecimalBound.double`).
 *
 * Used for a subject whose class is STATIC and for any subject against a BigDecimal BOUND (both rare, and
 * one compile each); a stored row's BigDecimal against a plain number bound is the cheaper
 * `decimalTextArm`, beside the raw compare that already answers every other row. `null` where the common
 * class is not BigDecimal, or the subject class floats (`numericPair` already widens a Float/Double subject
 * against a BigDecimal bound exactly).
 */
function decimalEquality(subject: Expr, cls: NumClass, value: unknown, boundCls: NumClass): Expr | null {
  if (cls !== 'bigdecimal' && boundCls !== 'bigdecimal') return null;
  if (cls === 'float' || cls === 'double') return null;
  const bound = decimalBound(value, boundCls);
  if (bound === null) return null;
  // `NumberHelper.compare` settles a NaN before widening: never equal (`NumberHelper.java:676-677`).
  if (bound === 'nan') return CONSTANT.false;
  if (bound === 'infinite') return raiseExpr(INFINITE_DECIMAL, subject);
  const integral = bound.canonical.includes('.') ? null : BigInt(bound.canonical);
  const integerArm = integral !== null && LONG_RANGE(integral)
    ? binary('=', subject, { kind: 'cast', arg: compilerText(bound.canonical), to: 'int' }) : CONSTANT.false;
  const realArm = bound.double !== null ? binary('=', { kind: 'cast', arg: subject, to: 'real' }, compilerReal(bound.double)) : CONSTANT.false;
  return { kind: 'case', whens: [
    [isText(subject), decimalTextMatch(subject, [bound.canonical])],
    [binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('integer')), integerArm],
  ], else: realArm };
}

/**
 * THE ONE ROW A RAW COMPARE MISSES against a plain NUMBER bound: a BigDecimal riding as decimal TEXT under a
 * per-row type. Every other row — and a BigDecimal held natively as REAL/INTEGER — the raw `=` already
 * answers exactly (`BigDecimal.valueOf(r)` equals the bound's widening exactly where `r` equals the bound), so
 * this is OR-ed beside it rather than replacing it, which keeps the value index and the `IN`-list form usable.
 * `members` are the bounds of one `eq` or one `within`; `null` where none needs the arm.
 */
function decimalTextArm(subject: Expr, type: SubjectType, members: readonly { value: unknown; type: TypeNode | null }[]): Expr | null {
  if (type.kind !== 'perRow') return null;
  const canonicals: string[] = [];
  let infinite = false;
  for (const member of members) {
    const numeric = typeof member.value === 'number' || typeof member.value === 'bigint';
    const cls = numeric && !isTemporal(member.type) ? boundClass(member.value, member.type) : null;
    if (!cls || cls === 'bigdecimal') continue;
    const bound = decimalBound(member.value, cls);
    if (bound === 'infinite') infinite = true;
    else if (bound && bound !== 'nan') canonicals.push(bound.canonical);
  }
  if (!canonicals.length && !infinite) return null;
  const isDecimal = binary('=', type.vtype, compilerText('bigdecimal'));
  if (infinite) return { kind: 'case', whens: [[isDecimal, raiseExpr(INFINITE_DECIMAL, subject)]], else: CONSTANT.false };
  return and(and(isDecimal, isText(subject)), decimalTextMatch(subject, canonicals));
}
const isTemporal = (type: TypeNode | null): boolean => flatType(type) === 'datetime' || flatType(type) === 'duration';


/** The cells around `nearest` (`NumericPair.cells`): it and its float/double neighbours, each with the
 *  reference's compare of its `printed` decimal against the bound's. */
function cellsAround(nearest: number, bits: 32 | 64, bound: BigDecimal, printed: (carrier: number) => string): Cell[] {
  if (!Number.isFinite(nearest)) return [];
  const [below, above] = adjacent(nearest, bits);
  return [below, nearest, above].filter(Number.isFinite).map((at) => ({ at, cmp: decimalCompare(decimalOf(printed(at))!, bound) }));
}

function widenedPair(subject: NumClass, bound: NumClass, value: unknown, castBound: Expr): NumericPair {
  // A BIG subject against a FLOAT bound widens the bound to `BigDecimal(Float.toString(f))`
  // (`NumberHelper.java:855`) — its SHORTEST decimal, which is then the Double of that spelling.
  if (BIG.has(subject) && bound === 'float' && typeof value === 'number' && Number.isFinite(value)) {
    const printed = Number(floatText(Math.fround(value)));
    return widenedPair(subject, 'double', printed, compilerReal(printed));
  }
  // A BigInteger meets an INTEGRAL other side exactly — `NumberHelper.compare` widens both to BigInteger.
  // SQLite's `CAST(… AS INTEGER)` saturates past int64, so `'99999999999999999999' > Long.MAX` read 'no'.
  // The SATURATION is harmless wherever the bound lies strictly inside it: a subject past int64 casts to
  // ±(2^63 - 1) / -2^63, which still lies on the subject's side of every such bound — so only a bound AT
  // the edge (`P.gt(Long.MAX_VALUE)`) or past it needs the exact form.
  const integralValue = typeof value === 'bigint' ? value : typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : null;
  if ((subject === 'bigint' || bound === 'bigint') && INTEGRAL.has(subject) && INTEGRAL.has(bound) && integralValue !== null)
    return integralValue > LONG_MIN && integralValue < LONG_MAX ? { real: false, bound: castBound } : { real: false, bound: castBound, exact: integralValue };
  // A BigInteger subject against a DOUBLE bound widens it to `BigDecimal.valueOf(d)` — the decimal of
  // `Double.toString(d)`, NOT d's binary value (`NumberHelper.java:856-858`): `4611686018427387903` is
  // below `4.611686018427388E18d`, whose decimal is 4611686018427388000. An INTEGRAL double is that exact
  // integer (`integralCompare`, past int64 as well); a fractional one lies strictly between two integers,
  // where the binary value and the decimal order every integer subject alike, so SQLite's own INTEGER-vs-REAL
  // compare holds (a subject past int64 saturates within ±2^63, still on its side of the bound).
  if (subject === 'bigint' && typeof value === 'number') {
    if (!Number.isFinite(value)) return { real: false, bound: castBound, wideUndecided: true };
    // Below 2^53 an integral double's decimal IS its value, so SQLite's own compare is that one too.
    if (!Number.isInteger(value) || Math.abs(value) < TWO_53) return { real: false, bound: castBound };
    const exact = decimalOf(String(value))!;
    const integral = exact.scale >= 0 ? exact.unscaled / 10n ** BigInt(exact.scale) : exact.unscaled * 10n ** BigInt(-exact.scale);
    return { real: false, bound: { kind: 'cast', arg: compilerText(String(integral)), to: 'int' }, exact: integral };
  }
  // A FLOAT subject against a BIG bound widens to `BigDecimal(Float.toString(f))`; a DOUBLE one to
  // `BigDecimal.valueOf(d)` — each its shortest decimal, which disagrees with the exact carrier only in the
  // cells around the bound (`NumericPair.cells`). Everywhere else the REAL compare against the bound's
  // nearest double is exact: the subject lies outside the bound's rounding interval.
  const decimal = BIG.has(bound) && (subject === 'float' || subject === 'double') ? boundDecimal(value) : null;
  if (decimal) {
    const nearest = Number(decimal.toString());
    return {
      real: true, bound: compilerReal(nearest),
      cells: subject === 'float'
        ? cellsAround(Math.fround(nearest), 32, decimal, floatText)
        : cellsAround(nearest, 64, decimal, String),
    };
  }
  const big = subject === 'bigdecimal' || bound === 'bigint' || bound === 'bigdecimal';
  if (big) return { real: false, bound: castBound };
  const m = magnitude(value);
  const fpBound = bound === 'float' || bound === 'double';
  if (subject === 'long' && fpBound && m >= TWO_53) return { real: true, bound: castBound };
  // A KNOWN Integer against a Float compares as two floats (`floatValue()`): the split rounds it (`asFloat`).
  if (subject === 'int32' && bound === 'float' && m >= TWO_24) return { real: false, bound: castBound, guarded: true, asFloat: true };
  if ((subject === 'double' || subject === 'float') && bound === 'long' && m >= TWO_53)
    return { real: false, bound: compilerReal(Number(value as bigint | number)) };
  if (subject === 'float' && bound === 'int32' && m > TWO_24) return { real: false, bound: compilerReal(Math.fround(Number(value))) };
  return { real: false, bound: castBound };
}

/** The deferral a `guarded` comparison raises (`numericPair`). */
const FLOAT_ROUNDED = 'comparing an int past 2^24 with a float is not supported';

/** The deferral a BigInteger compare raises where no exact SQL form decides it (`numericPair`). */
const WIDE_UNDECIDED = 'comparing a number past int64 with a floating-point number past 2^63 is not supported';

/** An integral subject past int64 — carried as canonical decimal TEXT that a cast to INTEGER does not
 *  round-trip (it saturates). */
const wideInteger = (subject: Expr): Expr => and(
  binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('text')),
  binary('!=', { kind: 'cast', arg: { kind: 'cast', arg: subject, to: 'int' }, to: 'text' }, subject));

const negativeText = (text: Expr): Expr =>
  binary('=', { kind: 'call', fn: 'substr', args: [text, compilerInt(1), compilerInt(1)] }, compilerText('-'));
/** `op`'s answer for a subject known to lie strictly ABOVE (`above`) or below the bound. */
const outcome = (op: Extract<Expr, { kind: 'binary' }>['op'], above: boolean): Expr =>
  (above ? op === '>' || op === '>=' : op === '<' || op === '<=') ? CONSTANT.true : CONSTANT.false;
/** A wide subject against a bound inside int64: its SIGN places it. */
const bySign = (op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr): Expr =>
  ({ kind: 'case', whens: [[negativeText(subject), outcome(op, false)]], else: outcome(op, true) });
/** `a op b` over two canonical decimal integers of the SAME sign: the longer magnitude is larger, and equal
 *  lengths order as text. */
const lexicalCompare = (op: Extract<Expr, { kind: 'binary' }>['op'], a: Expr, b: Expr): Expr => {
  const length = (e: Expr): Expr => ({ kind: 'call', fn: 'length', args: [e] });
  return { kind: 'case', whens: [[binary('!=', length(a), length(b)), binary(op, length(a), length(b))]], else: binary(op, a, b) };
};

/**
 * `subject op bound` EXACTLY over integers — the subject an INTEGER or a canonical decimal TEXT past int64,
 * the bound the compiler's own value (`NumberHelper.compare` widens a BigInteger pair to BigInteger,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-398`).
 * Inside int64 both sides are SQLite integers; past it the sign and then the digits decide.
 */
function integralCompare(op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr, bound: bigint, castBound: Expr): Expr {
  const wide = wideInteger(subject);
  if (LONG_RANGE(bound))
    return { kind: 'case', whens: [[wide, bySign(op, subject)]], else: binary(op, { kind: 'cast', arg: subject, to: 'int' }, castBound) };
  const text = compilerText(String(bound));
  return bound > 0n
    ? { kind: 'case', whens: [[and(wide, { kind: 'unary', op: 'not', arg: negativeText(subject) }), lexicalCompare(op, subject, text)]], else: outcome(op, false) }
    // Both negative: the larger magnitude is the SMALLER number, so the operands swap.
    : { kind: 'case', whens: [[and(wide, negativeText(subject)), lexicalCompare(op, text, subject)]], else: outcome(op, true) };
}

/** `op` over the pair, keyed as it says (`real`), and raising past 2^24 where it is `guarded`. */
function guardedCompare(op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr, keyed: Expr, pair: NumericPair): Expr {
  if (pair.exact !== undefined) return integralCompare(op, subject, pair.exact, pair.bound);
  if (pair.wideUndecided) {
    const compared = binary(op, keyed, pair.bound);
    return { kind: 'case', whens: [[wideInteger(subject), raiseExpr(WIDE_UNDECIDED, subject)]], else: compared };
  }
  const key: Expr = pair.real ? { kind: 'cast', arg: subject, to: 'real' } : keyed;
  const compared = binary(op, key, pair.bound);
  // A signed-zero cell whose two outcomes are SQLite's own (`P.gt(0)`: neither zero is above zero) needs
  // no arm.
  const cells = pair.cells?.filter((cell) => 'cmp' in cell || cmpHolds(op, cell.negative) !== cmpHolds(op, 0) || cmpHolds(op, cell.positive) !== cmpHolds(op, 0));
  if (cells?.length) {
    const holds = (cmp: number): Expr => (cmpHolds(op, cmp) ? CONSTANT.true : CONSTANT.false);
    return { kind: 'case', whens: cells.map((cell): readonly [Expr, Expr] => [binary('=', key, compilerReal(cell.at)), 'cmp' in cell
      ? holds(cell.cmp)
      : { kind: 'case', whens: [[signBit({ kind: 'cast', arg: subject, to: 'real' }), holds(cell.negative)]], else: holds(cell.positive) }]),
    else: compared };
  }
  if (pair.guarded && pair.asFloat) return binary(op, floatValueOf({ kind: 'cast', arg: subject, to: 'real' }), pair.bound);
  return pair.guarded
    ? { kind: 'case', whens: [[binary('>', { kind: 'call', fn: 'abs', args: [subject] }, compilerInt(TWO_24)), raiseExpr(FLOAT_ROUNDED, subject)]], else: compared }
    : compared;
}

/** Does `op` hold for a three-way compare result `cmp` (negative, zero, positive)? */
function cmpHolds(op: Extract<Expr, { kind: 'binary' }>['op'], cmp: number): boolean {
  switch (op) {
    case '=': return cmp === 0;
    case '!=': return cmp !== 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    default: throw new Error(`RelIR: a numeric compare has no three-way reading for '${op}'`);
  }
}

/** The vtype names of each class, in the order the per-row CASE has always listed them. */
const CLASS_VTYPES: readonly (readonly [NumClass, string])[] =
  [['int32', 'byte'], ['int32', 'short'], ['int32', 'int'], ['long', 'long'], ['bigint', 'bigint'], ['float', 'float'], ['double', 'double'], ['bigdecimal', 'bigdecimal']];

/** A CASE's arms grouped by identical outcome, in first-seen order — so a comparison with no rounding
 *  hazard renders the two arms it always has, and a hazard splits off only the class it touches. */
function groupedArms(entries: readonly (readonly [string, Expr])[]): [string[], Expr][] {
  const arms: [string[], Expr, string][] = [];
  for (const [vtype, outcome] of entries) {
    const key = JSON.stringify(outcome);
    const arm = arms.find((a) => a[2] === key);
    if (arm) arm[0].push(vtype); else arms.push([[vtype], outcome, key]);
  }
  return arms.map(([vtypes, outcome]) => [vtypes, outcome]);
}

/** Does a STRING operand spell something a number may be carried as (decimal or total-nanos TEXT)? Only
 *  then can raw TEXT equality confuse a String with a Number. */
const numberSpelling = (value: string): boolean => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value);

/** Comparability is confined to one Gremlin type space. Each CASE combines the guard and comparison
 * so its type vocabulary is emitted once; a stored vtype outranks SQLite's storage class because an
 * exact numeric value may deliberately be stored as decimal TEXT. */
const ordered = (
  op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr, bound: Expr, value: unknown, type: SubjectType,
  boundType: TypeNode | null = null,
): Expr | null => {
  const numericBound = typeof value === 'number' || isExactTail(value);
  // WHICH STORED `vtype`s THIS BOUND IS COMPARABLE WITH — the OPERAND's own Gremlin type decides, and
  // reading it is what keeps three different type spaces apart once all of them ride as a number.
  // A `datetime` bound is epoch millis and a `duration` bound total nanos, so both are numeric to
  // SQLite and NEITHER is comparable with an `int` property — while both ARE comparable with a stored
  // value of their own tag. Dropping the operand's type (this took only its VALUE) made every temporal
  // bound fall to the `else` and answer FALSE for a comparison the reference performs:
  // `values('datetime').is(P.gt(datetime(…)))` was empty where it should hold. Numbers keep the whole
  // numeric vocabulary, which is `Compare`'s own "one number space" rule.
  const temporal = ((): 'datetime' | 'duration' | null => {
    const canonical = flatType(boundType);
    return canonical === 'datetime' || canonical === 'duration' ? canonical : null;
  })();
  const intVtypes = temporal ? [temporal] : NUMERIC_CAST_TO_INT;
  const realVtypes = temporal ? [] : CAST_TO_REAL;
  // The exact tail rides as decimal TEXT, so its ORDERING bound is cast to the column's numeric class
  // (`compareBound`) — otherwise `CAST(col AS REAL) > '9.99'` would compare a REAL against unconverted
  // TEXT. A plain number needs no cast (it already binds/inlines numeric).
  const tailCast = exactTailCast(value);
  const castBound: Expr = tailCast ? { kind: 'cast', arg: bound, to: tailCast } : bound;
  // BOOLEAN bucket (`GremlinValueComparator.Type.Boolean`): false < true via natural order, and a stored
  // boolean rides as 0/1 so SQLite's own compare IS that order. COMPARABILITY compares ONLY a
  // boolean-bucket subject, else the ordering op is false (`Compare.java:63-116`). The 2-way
  // numeric/string split below has NO boolean arm, so `is(P.gt(false))` over a boolean wrongly folded to
  // false — a silent wrong answer. `eq`/`neq` are value equality and never reach `ordered()`.
  if (typeof value === 'boolean') {
    if (type.kind === 'static')
      return normalizeTypeName(type.type) === 'boolean' ? binary(op, subject, bound) : CONSTANT.false;
    if (type.kind === 'perRow')
      return { kind: 'case', whens: [[binary('=', type.vtype, compilerText('boolean')), binary(op, subject, bound)]], else: compilerFalse };
    // A stored boolean is 0/1 (INTEGER storage), indistinguishable from an int subject without a type tag,
    // so an untyped subject cannot be placed in the boolean bucket — decline to false rather than admit an
    // int as if it were comparable.
    return compilerFalse;
  }
  const boundCls = numericBound && !temporal ? boundClass(value, boundType) : null;
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    // A NUMBER subject against a NUMBER bound: the common-class rule (`numericPair`).
    const subjectCls = canonical !== null ? NUM_CLASS[canonical] : undefined;
    if (boundCls && subjectCls) {
      const subjectCast = STATIC_SUBJECT_CAST[canonical!];
      const keyed: Expr = type.text && subjectCast ? { kind: 'cast', arg: subject, to: subjectCast } : subject;
      return guardedCompare(op, subject, keyed, numericPair(subjectCls, boundCls, value, castBound));
    }
    // A TEXT-stored exact-tail subject (`inject(9.99m)`, a bound big long/Duration — `type.text`) rides as
    // decimal/total-nanos TEXT, so ordering casts it to its numeric class. The SAME cast is identity on the
    // NATIVE form of the same tag (`count()`→INTEGER, `asNumber(BIGDECIMAL)`→REAL), which is why the flag —
    // set only where the value is stored as TEXT (`injectSource`) — is what disambiguates the two and lets
    // `inject(9.99m)`/`inject(9…L)`/`inject(Duration(…))` order instead of declining
    // (docs/archive/2026-08-05-parameters-are-the-only-binds.md C1).
    const subjectCast = canonical !== null ? STATIC_SUBJECT_CAST[canonical] : undefined;
    if (numericBound && type.text && subjectCast)
      return binary(op, { kind: 'cast', arg: subject, to: subjectCast }, castBound);
    // A NATIVE temporal (`datetime`, or a `duration` that did not arrive as a TEXT tail) cannot be ordered
    // by this arm: it rides as a raw epoch/nanos with no per-row `vtype` to drive `compareKey`'s cast, so
    // comparing it raw is not what TinkerPop's temporal ordering means. DECLINE (a coverage gap, never a
    // wrong answer) rather than fold to a wrong `CONSTANT.false`. A native-numeric static subject
    // (`count()`'s `long`, an `asNumber(BIGDECIMAL)` REAL) is unaffected and still folds/compares here.
    if (numericBound && canonical !== null && STATIC_ORDERING_DECLINE.has(canonical)) return null;
    const agrees = numericBound
      ? canonical !== null && (temporal ? canonical === temporal : NUMERIC_VTYPES.includes(canonical))
      : canonical === 'string';
    return agrees ? binary(op, subject, castBound) : CONSTANT.false;
  }
  if (type.kind === 'perRow') {
    if (boundCls) {
      // One arm per class whose comparison differs — normally the two (cast INTEGER, cast REAL) it has
      // always had; a rounding hazard (`numericPair`) splits off only the class it touches.
      const entries: [string, Expr][] = [];
      for (const [cls, vtype] of CLASS_VTYPES) {
        const to: SqlType = CAST_TO_REAL.includes(vtype) ? 'real' : 'int';
        entries.push([vtype, guardedCompare(op, subject, { kind: 'cast', arg: subject, to }, numericPair(cls, boundCls, value, castBound))]);
      }
      return { kind: 'case', whens: groupedArms(entries).map(([vtypes, outcome]) =>
        [{ kind: 'in-list', expr: type.vtype, values: vtypes.map(compilerText) }, outcome] as const), else: compilerFalse };
    }
    return numericBound
      ? { kind: 'case', whens: [
        [{ kind: 'in-list', expr: type.vtype, values: intVtypes.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'int' }, castBound)],
        ...(realVtypes.length
          ? [[{ kind: 'in-list', expr: type.vtype, values: realVtypes.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'real' }, castBound)] as const]
          : []),
      ], else: compilerFalse }
      : { kind: 'case', whens: [[binary('=', type.vtype, compilerText('string')), binary(op, subject, bound)]], else: compilerFalse };
  }
  const storage = { kind: 'call', fn: 'typeof', args: [subject] } as const;
  if (boundCls) {
    // No vtype: a REAL is a `double`, and an INTEGER a `long` (a native int64) or an `int` — which only a
    // float bound past 2^24 can tell apart, so there it takes the int's guard too (`numericPair`).
    const entries: [string, Expr][] = [];
    for (const [cls, storageClass] of [['long', 'integer'], ['double', 'real']] as const) {
      const pair = numericPair(cls, boundCls, value, castBound);
      const asInt = cls === 'long' && numericPair('int32', boundCls, value, castBound).guarded ? { ...pair, guarded: true as const } : pair;
      entries.push([storageClass, guardedCompare(op, subject, subject, asInt)]);
    }
    return { kind: 'case', whens: groupedArms(entries).map(([classes, outcome]) =>
      [{ kind: 'in-list', expr: storage, values: classes.map(compilerText) }, outcome] as const), else: compilerFalse };
  }
  return numericBound
    ? { kind: 'case', whens: [[
      { kind: 'in-list', expr: storage, values: [compilerText('integer'), compilerText('real')] }, binary(op, subject, castBound),
    ]], else: compilerFalse }
    : { kind: 'case', whens: [[binary('=', storage, compilerText('text')), binary(op, subject, bound)]], else: compilerFalse };
};

/**
 * VALUE EQUALITY — `eq`, and `neq` as its negation. A RAW compare where that is the reference's answer,
 * which is the common case and keeps the value index usable; widened only where raw SQLite equality and
 * `Compare.eq` (`NumberHelper.compare` for two numbers, `false` across type spaces — `Compare.java:66-69`,
 * `GremlinValueComparator.java:71-74`) disagree:
 *
 * - a NUMBER bound whose comparison ROUNDS for some class (`numericPair`): the raw compare stays (an exact
 *   match is also a rounded one) and the rounded form is OR-ed in for the class it touches;
 * - a STRING bound that spells a number, against a subject that may be a number carried as decimal TEXT:
 *   raw TEXT equality would call `'9007199254740994'` equal to the Long — restrict it to String rows;
 * - a NUMBER, BOOLEAN or DATE bound against a subject of ANOTHER type space (`typeSpaced`).
 */
const equality = (subject: Expr, bound: Expr, value: unknown, type: SubjectType, boundType: TypeNode | null): Expr | null => {
  const same = sameSpaceEquality(subject, bound, value, type, boundType);
  const arm = same && decimalTextArm(subject, type, [{ value, type: boundType }]);
  const equal = same && arm ? binary('or', same, arm) : same;
  return equal && typeSpaced(equal, value, type, boundType);
};

/** The Gremlin type space a NON-STRING bound belongs to — its declared temporal type, else its value's
 *  own shape — or `null` where the value alone says nothing a stored tag could contradict. */
function boundSpace(value: unknown, boundType: TypeNode | null): string | null {
  const declared = flatType(boundType);
  if (declared === 'datetime' || declared === 'duration') return declared;
  if (typeof value === 'boolean') return 'boolean';
  return typeof value === 'number' || isExactTail(value) ? 'number' : null;
}
const spaceOf = (tag: string | null): string | null =>
  tag === null ? null : NUM_CLASS[tag] ? 'number' : tag === 'boolean' || tag === 'datetime' || tag === 'duration' ? tag : null;
/** Every vtype of the four spaces a non-string bound can sit in. */
const SPACED_VTYPES: readonly string[] = [...NUMERIC_VTYPES, 'boolean', 'datetime', 'duration'];

/**
 * EQUALITY NEVER CROSSES A TYPE SPACE. `Compare.eq` is `GremlinValueComparator.COMPARABILITY.equals`,
 * which is FALSE unless both sides sit in one `Type` (`comparable()` — `ft == st`;
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:71-74,314-363`).
 * A Boolean rides as 0/1 and a Date as epoch millis, so a raw SQLite `=` cannot see that boundary:
 * `coalesce(values('age'), constant(true)).is(1)` matched the `true` rows. The ONE authority every
 * equality form reaches (`is(x)`, `has(k, x)`, `eq`/`neq`, `within`/`without` members), at whatever depth
 * the subject was produced — the subject's own type fact decides: a static tag in another space folds to
 * false; a per-row `vtype` naming another space excludes that row. A NULL vtype ("read the value") says
 * nothing, so it keeps the raw compare it always had.
 */
function typeSpaced(equal: Expr, value: unknown, type: SubjectType, boundType: TypeNode | null): Expr {
  const space = boundSpace(value, boundType);
  if (space === null) return equal;
  if (type.kind === 'static') {
    const own = spaceOf(normalizeTypeName(type.type));
    return own !== null && own !== space ? CONSTANT.false : equal;
  }
  const tag = type.kind === 'perRow' ? type.vtype : type.tag;
  // An UNKNOWN subject with no tag is framed by INFERENCE from its storage class — an INTEGER/REAL is a
  // Number, a TEXT a String — so no row of it is ever a Boolean, a Date or a Duration on the wire, and
  // matching one would pass a Number that "equals true" (`inject(1).is(true)`). Only a Number bound
  // keeps the raw compare.
  if (!tag && type.kind === 'unknown') return space === 'number' ? equal : CONSTANT.false;
  if (!tag) return equal;
  const others = SPACED_VTYPES.filter((vtype) => spaceOf(vtype) !== space);
  return binary('and', equal, { kind: 'unary', op: 'not', arg: {
    kind: 'in-list', expr: { kind: 'call', fn: 'coalesce', args: [tag, compilerText('')] }, values: others.map(compilerText),
  } });
}

/** The per-row vtypes whose value rides as TEXT, whose Gremlin `Type` is not String, and whose text `bound`
 *  could be: a `T` token's name, a `Direction`'s, a UUID's canonical form. */
const textCarriedOthers = (bound: string): readonly string[] => [
  ...(['id', 'label', 'key', 'value'].includes(bound) ? ['T'] : []),
  ...(['IN', 'OUT', 'BOTH'].includes(bound) ? ['D'] : []),
  ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bound) ? ['uuid'] : []),
];

const sameSpaceEquality = (subject: Expr, bound: Expr, value: unknown, type: SubjectType, boundType: TypeNode | null): Expr | null => {
  const raw = binary('=', subject, bound);
  if (typeof value === 'string') {
    if (type.kind === 'static') {
      const canonical = normalizeTypeName(type.type);
      return canonical !== null && (NUM_CLASS[canonical] || canonical === 'duration') ? CONSTANT.false : raw;
    }
    // A NULL vtype is "read the value", and a TEXT value read that way is a String.
    if (type.kind === 'perRow' && numberSpelling(value))
      return binary('and', raw, binary('=', { kind: 'call', fn: 'coalesce', args: [type.vtype, compilerText('string')] }, compilerText('string')));
    // A TEXT-carried value of another `Type` — a `T`/`Direction` token (an `elementMap()` key, whose text
    // is its name), a UUID — is never equal to a String (`GremlinValueComparator.equals`: `ft == st`,
    // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:239-275`),
    // so `elementMap().unfold().select(keys).is('label')` is empty, not `T.label`. Only a bound that IS some
    // such value's text can meet one, so only that bound pays for the guard.
    const others = textCarriedOthers(value);
    if (type.kind === 'perRow' && others.length)
      return binary('and', raw, { kind: 'unary', op: 'not', arg: {
        kind: 'in-list', expr: { kind: 'call', fn: 'coalesce', args: [type.vtype, compilerText('')] }, values: others.map(compilerText) } });
    return raw;
  }
  const temporal = flatType(boundType) === 'datetime' || flatType(boundType) === 'duration';
  const boundCls = typeof value === 'number' || isExactTail(value) ? temporal ? null : boundClass(value, boundType) : null;
  if (!boundCls) return raw;
  const tailCast = exactTailCast(value);
  const castBound: Expr = tailCast ? { kind: 'cast', arg: bound, to: tailCast } : bound;
  // A class whose compare WIDENS (`numericPair`) answers by the widened form INSTEAD of the raw `=` — not
  // beside it: a raw match is not always a reference match (`0.0 = -0.0`, a Float's exact carrier against
  // its BigDecimal decimal), and the widened form is exact wherever the raw one is.
  // The widened form compares the subject KEYED by its class (`ordered`'s rule): a decimal-TEXT carrier
  // reads as the number it is.
  const widened = (cls: NumClass, keyed: Expr, intToo = false): Expr | undefined => {
    const own = numericPair(cls, boundCls, value, castBound);
    // Without a vtype an INTEGER may be an `int` too, so it takes the int's guard as well (see `ordered`).
    const pair = intToo && numericPair('int32', boundCls, value, castBound).guarded ? { ...own, guarded: true as const } : own;
    return pair.real || pair.guarded || pair.cells || pair.exact !== undefined || pair.bound !== castBound ? guardedCompare('=', subject, keyed, pair) : undefined;
  };
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    const cls = canonical !== null ? NUM_CLASS[canonical] : undefined;
    const subjectCast = canonical !== null ? STATIC_SUBJECT_CAST[canonical] : undefined;
    return (cls && (decimalEquality(subject, cls, value, boundCls) ?? widened(cls, type.text && subjectCast ? { kind: 'cast', arg: subject, to: subjectCast } : subject))) ?? raw;
  }
  const classes: readonly (readonly [NumClass, string])[] = type.kind === 'perRow'
    ? CLASS_VTYPES : [['long', 'integer'], ['double', 'real']];
  const tag: Expr = type.kind === 'perRow' ? type.vtype : { kind: 'call', fn: 'typeof', args: [subject] };
  const entries: [string, Expr][] = [];
  for (const [cls, name] of classes) {
    const keyed: Expr = type.kind === 'perRow' ? { kind: 'cast', arg: subject, to: CAST_TO_REAL.includes(name) ? 'real' : 'int' } : subject;
    // A per-row BigDecimal against a plain number bound is `decimalTextArm`'s, beside the raw compare.
    const form = (type.kind !== 'perRow' || boundCls === 'bigdecimal' ? decimalEquality(subject, cls, value, boundCls) : null) ?? widened(cls, keyed, type.kind !== 'perRow' && name === 'integer');
    if (form) entries.push([name, form]);
  }
  return entries.length
    ? { kind: 'case', whens: groupedArms(entries).map(([names, outcome]) => [{ kind: 'in-list', expr: tag, values: names.map(compilerText) }, outcome] as const), else: raw }
    : raw;
};

/**
 * A COMPILE-TIME vtype picks the arm HERE, not in SQLite.
 *
 * The general form asks the engine `'bigint' IN ('byte','short','int','long',…)` — a comparison
 * between two values the compiler is holding, and the same rule that inlines a held constant as a
 * typed literal (root CLAUDE.md) says a type we KNOW must not travel to the engine as a question.
 * It is also not paid once: the exact-tail overflow guard spells its aggregate three times, so a
 * static `sum()` carried the coercion CASE three times over. Measured on
 * `g.V().values("int").asNumber(GType.BIGINT).is(P.typeOf(GType.BIGINT)).sum()` — 1,727 bytes of
 * statement text against a 1,233-byte family baseline, which is what caught it.
 *
 * Total and equivalence-preserving by construction: the folded arm is the one the CASE would have
 * selected, and a vtype in neither vocabulary folds to the CASE's own `else` (the bare subject).
 */
export const storedCompareOn = (vtype: Expr) => (subject: Expr): Expr => {
  const staticVtype = vtype.kind === 'lit' && vtype.source === 'compiler-text' ? vtype.value : undefined;
  if (staticVtype !== undefined) {
    if (CAST_TO_INT.includes(staticVtype)) return { kind: 'cast', arg: subject, to: 'int' };
    if (CAST_TO_REAL.includes(staticVtype)) return { kind: 'cast', arg: subject, to: 'real' };
    return subject;
  }
  return {
    kind: 'case',
    whens: [
      [{ kind: 'in-list', expr: vtype, values: CAST_TO_INT.map(compilerText) }, { kind: 'cast', arg: subject, to: 'int' }],
      [{ kind: 'in-list', expr: vtype, values: CAST_TO_REAL.map(compilerText) }, { kind: 'cast', arg: subject, to: 'real' }],
    ],
    else: subject,
  };
};


/**
 * WHICH NUMBER CLASS A COMPARE KEY'S ZERO IS — the carrier `Double.compare`'s signed zero needs, and the
 * fact a bare SQL value loses.
 *
 * ORDERABILITY and COMPARABILITY both reach `NumberHelper.compare` for two Numbers, which first PROMOTES
 * the pair to their highest common class (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-399,670-680,861-873`).
 * So `-0.0d` vs `0.0d`, vs `0i` or vs `0L` is `Double.compare` — `-0.0` is the SMALLER — but `-0.0d` vs a
 * `BigInteger`/`BigDecimal` zero is `BigDecimal.compareTo` over `BigDecimal.valueOf(-0.0)`, an UNSIGNED
 * zero: the two are EQUAL (`NumberHelper.java:278-310`). The answer for two zeros is therefore a function
 * of BOTH classes, never of the value alone, and every key below says how its class is known:
 *
 * - `integral` — no negative zero can occur and no big one either (a static `long`, a non-number):
 *   SQLite's own compare is the answer.
 * - `big` — every zero is a BigInteger/BigDecimal (a static big type): it ties every other zero.
 * - `natural` — every zero is a Float/Double/small integral, so the SIGN is the whole story: a value whose
 *   type its storage class infers (`inferredVtype` — INTEGER is `int`/`long`, REAL is `double`), or a
 *   static floating type.
 * - `encoded` — a per-row type was folded INTO the key by `orderingKey`: a BigInteger/BigDecimal zero is
 *   INTEGER `0`, every other zero a REAL `±0.0`.
 * - `unknown` — a per-row type the key does not carry: a non-negative zero may be either class.
 */
export type ZeroCarrier = 'integral' | 'big' | 'natural' | 'encoded' | 'unknown';

/** An ordering key with how its zero's class is known — what every key builder (`orderingKey`) hands back. */
export interface CarriedKey { readonly key: Expr; readonly carrier: ZeroCarrier }

/** The integral vtypes `NumberHelper` keeps below BigInteger — their zero promotes to `0.0` against a Double. */
const BIG_VTYPES = ['bigint', 'bigdecimal'];
const FLOATING_VTYPES = ['float', 'double'];

/** The `ZeroCarrier` of a key whose type is ONE static tag for every row. */
export const staticZeroCarrier = (type: string): ZeroCarrier =>
  BIG_VTYPES.includes(type) ? 'big' : FLOATING_VTYPES.includes(type) ? 'natural' : 'integral';

/**
 * The ordering key of a VALUE whose type is known as a `ScalarType` (a child body's result, an alias's)
 * rather than as a vtype expression — `orderingKey` over the tag where one rides (`vtype`, a TEXT-stored
 * static), else the value itself under the carrier its type states: one static tag names its class, a
 * per-row type the key does not carry is `unknown`, and an untyped value is its storage class's
 * (`natural`).
 */
export function typedOrderingKey(value: Expr, type: ScalarType | undefined, vtype?: Expr, fresh?: Minter): CarriedKey {
  if (vtype) return orderingKey(vtype, value, fresh);
  if (type?.kind === 'static') return type.text ? orderingKey(compilerText(type.type), value) : { key: value, carrier: staticZeroCarrier(type.type) };
  return { key: value, carrier: type?.kind === 'perRow' ? 'unknown' : 'natural' };
}

/**
 * THE ORDERING KEY of a value whose type rides beside it — `storedCompareOn`'s compare key, with the
 * zero's NUMBER CLASS folded into its storage class wherever the type is per-row (`ZeroCarrier`
 * `encoded`): a BigInteger/BigDecimal zero becomes INTEGER `0`, a small integral one REAL `0.0`, a
 * Float/Double one keeps its signed REAL. The key compares exactly as `storedCompareOn`'s (`0 = 0.0` in
 * SQLite), so every consumer that only compares is unaffected; only the signed-zero rule reads the
 * class back (`orderedBy`, `signedCompare`). A STATIC type folds to `storedCompareOn`'s cast and names
 * its carrier instead. Every `by()` ordering key and the scalar traverser's own key go through here, so
 * no key can drop the class it was read with.
 */
export function orderingKey(vtype: Expr | undefined, subject: Expr, fresh?: Minter): CarriedKey {
  if (!vtype) return { key: subject, carrier: 'natural' };
  const staticVtype = vtype.kind === 'lit' && vtype.source === 'compiler-text' ? String(vtype.value) : undefined;
  if (staticVtype !== undefined) return { key: storedCompareOn(vtype)(subject), carrier: staticZeroCarrier(staticVtype) };
  // The key spells `subject` and `vtype` once per arm, and either may be a correlated read (a child body's value
  // and tag): with a `fresh` minter such a pair is evaluated ONCE, as the one row of a `VALUES` the key is
  // projected over — `signedCompare`'s shape.
  const cheap = (e: Expr): boolean => e.kind === 'col' || e.kind === 'lit';
  if (fresh && !(cheap(subject) && cheap(vtype))) {
    const one = make.values({ id: fresh('oko'), channels: [], type: typeOf(meta('v', 'any', true), meta('t', 'text', true)), rows: [[subject, vtype]] });
    const inner = orderingKey(col(one.id, 't'), col(one.id, 'v'));
    return { key: { kind: 'scalar', plan: make.project({ id: fresh('okv'), input: one, channels: [], type: typeOf(meta('k', 'any', true)), exprs: [['k', inner.key]] }) }, carrier: inner.carrier };
  }
  // `storedCompareOn`'s key, its ZERO (of either sign — `nullif`) respelled by class: a BigInteger/BigDecimal
  // zero as INTEGER `0`, every other as `subject * 1.0` — REAL, and a REAL zero's sign kept. An UNTAGGED
  // value is its storage class's type (`inferredVtype`), so its INTEGER zero is a small integral's.
  const untagged = vtype.kind === 'lit' && vtype.value === null;
  const signed: Expr = { kind: 'binary', op: '*', left: subject, right: compilerReal(1) };
  const zero: Expr = untagged ? signed
    : { kind: 'call', fn: 'iif', args: [{ kind: 'in-list', expr: vtype, values: BIG_VTYPES.map(compilerText) }, compilerInt(0), signed] };
  const key = untagged ? subject : storedCompareOn(vtype)(subject);
  return { key: { kind: 'call', fn: 'coalesce', args: [{ kind: 'call', fn: 'nullif', args: [key, compilerInt(0)] }, zero] }, carrier: 'encoded' };
}

/** A sort key as `orderedBy` takes it — the key, its direction, and how its zero's class is known. */
export interface OrderKey {
  readonly expr: Expr;
  readonly dir: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
  readonly carrier: ZeroCarrier;
}

/** Does an ordering over this key owe a second, SIGN term at all? */
export const signTermOwed = (carrier: ZeroCarrier): boolean => carrier === 'natural' || carrier === 'encoded' || carrier === 'unknown';

/** Does it need the WHOLE SORT's zeros in view (`orderedBy`'s flags) — a key whose zeros are not all one kind? */
const zeroesMixed = (carrier: ZeroCarrier): boolean => carrier === 'encoded' || carrier === 'unknown';

const zeroOf = (k: Expr): Expr => binary('=', k, compilerInt(0));
const atan2 = (k: Expr): Expr => ({ kind: 'call', fn: 'atan2', args: [k, compilerReal(-1)] });
const isInteger = (k: Expr): Expr => binary('=', { kind: 'call', fn: 'typeof', args: [k] }, compilerText('integer'));

/** The deferral an ordering raises where `NumberHelper.compare` is not a total order over the sort's zeros. */
export const ZERO_CLASSES_UNORDERED = 'ordering a big-number zero among both signed Double zeros is not supported';
/** The deferral where the sort's zeros tie but the stream carries no arrival order to keep them in. */
const ZERO_TIE_UNSTABLE = 'ordering a big-number zero beside another zero of a value stream is not supported';
/** The deferral where a key's zero class is not carried and a negative zero meets it. */
const ZERO_CLASS_UNKNOWN = 'ordering -0.0 beside a zero of unknown number class is not supported';

/**
 * AN ORDERING over `keys` — THE ONE AUTHORITY for `order()`'s comparator over a value, at every position
 * (the row-level sort, a merged `TraverserSet` sort, `order(Scope.local)`), for the traverser ordered by
 * itself and for every `by()`-projected key alike. Returns the sort terms, and the relation they read
 * (`rel` itself, or `rel` widened by the columns the terms need — every `rel` column rides through under
 * its own name, so a payload or tie-break read addresses it exactly as it did `rel`).
 *
 * ORDERABILITY is `NumberHelper.compare` (`ZeroCarrier`): two zeros are ordered by SIGN when neither is a
 * BigInteger/BigDecimal, and tie when either is. Each key is followed by a sign term `atan2(key, -1)` —
 * −π for a negative zero, +π for every other value, so it reorders exactly the two zeros a key ties.
 * Where the key's zeros can be of BOTH kinds (`encoded`/`unknown`) the sort must see them all, because
 * the comparator is then NOT a total order: `-0.0d < 0.0d`, yet each equals `0m`. So the WHOLE sort's
 * zero classes are read as window flags first, and:
 *
 * - no big zero in the sort → the sign term, exactly as above;
 * - a big zero and NOT both signed Double zeros → every zero ties (the sign term is a constant), which
 *   is the one order `NumberHelper.compare` gives a set of pairwise-equal values: the stable arrival order.
 *   That needs a tie-break that IS arrival order (`stable` — a carried encounter, an element's or a
 *   property's rowid, a list member's position); a value stream ties on its value's BYTES, which orders
 *   `0m` and `-0.0d` by representation, so there the row DEFERS (`ZERO_TIE_UNSTABLE`);
 * - a big zero beside BOTH signed zeros → no order is the reference's (it depends on the sort algorithm
 *   meeting an intransitive comparator), so the row DEFERS (`ZERO_CLASSES_UNORDERED`);
 * - an `unknown` key whose negative zero meets a non-negative one → DEFERS: its class is not carried.
 *
 * A key that is not a bare column is projected as one first, and a block boundary is put above the
 * projection (`ROW_NUMBER() OVER ()`, a window, closes the SELECT — `src/rel/block.ts` `NEEDS_SUBQUERY`),
 * so the flags and the sign term read the column rather than re-spelling a correlated read per mention.
 * NaN never reaches a key — SQLite has no NaN (a NaN literal or parameter declines, a NaN-producing
 * `math()` raises), so `Double.compare`'s NaN-last arm has nothing to order here; the ranked path's JS
 * comparator (`orderability.ts`) carries it.
 */
export function orderedBy(
  rel: Rel, keys: readonly OrderKey[], fresh: Minter,
  { stable = true, open = false }: { readonly stable?: boolean; readonly open?: boolean } = {},
): { readonly rel: Rel; readonly terms: readonly SortTerm[] } {
  const cheap = (e: Expr): boolean => e.kind === 'col' || e.kind === 'lit';
  const flagged = keys.some((key) => zeroesMixed(key.carrier));
  const respelled = keys.some((key) => signTermOwed(key.carrier) && !cheap(key.expr));
  let input = rel;
  let exprs = keys.map((key) => key.expr);
  const name = (i: number): string => `sk${i}`;
  const project = respelled || (flagged && keys.some((key) => !cheap(key.expr)));
  if (project) {
    input = make.project({
      id: fresh('skp'), input: rel, channels: rel.channels,
      type: typeOf(...rel.type.cols, ...keys.map((_, i) => meta(name(i), 'any', true))),
      exprs: [...rel.type.cols.map((column) => [column.name, col(rel.id, column.name)] as const), ...keys.map((key, i) => [name(i), key.expr] as const)],
    });
  }
  // `open`: the caller's keys are columns of a projection it could not fence — the same re-spelling hazard.
  if (project || (open && keys.some((key) => signTermOwed(key.carrier)))) {
    const at = input;
    input = make.window({
      id: fresh('skb'), input: at, channels: at.channels, type: typeOf(...at.type.cols, meta('skb', 'int')),
      specs: [['skb', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [] } }]],
    });
    exprs = project ? keys.map((_, i) => col(input.id, name(i)))
      : exprs.map((e) => (e.kind === 'col' && e.rel === at.id ? col(input.id, e.name) : e));
  }
  if (flagged) {
    const at = input;
    const whole = { partitionBy: [], orderBy: [] };
    const flag = (i: number, which: string, test: Expr) =>
      [`sz${i}${which}`, { kind: 'window-expr', fn: 'max', args: [and(zeroOf(exprs[i]!), test)], spec: whole }] as const;
    const specs = keys.flatMap((key, i) => {
      const k = exprs[i]!;
      const negative = binary('<', atan2(k), compilerInt(0));
      if (key.carrier === 'encoded')
        return [flag(i, 'f', negative), flag(i, 'b', isInteger(k)),
          ...(stable ? [flag(i, 'p', and(binary('>', atan2(k), compilerInt(0)), { kind: 'unary', op: 'not', arg: isInteger(k) }))] : [])];
      if (key.carrier === 'unknown') return [flag(i, 'f', negative), flag(i, 'u', binary('>', atan2(k), compilerInt(0)))];
      return [];
    });
    input = make.window({
      id: fresh('szw'), input: at, channels: at.channels,
      type: typeOf(...at.type.cols, ...specs.map(([name]) => meta(name, 'int', true))), specs,
    });
    exprs = exprs.map((e) => (e.kind === 'col' && e.rel === at.id ? col(input.id, e.name) : e));
  }
  const flagOf = (i: number, which: string): Expr => col(input.id, `sz${i}${which}`);
  const terms = keys.flatMap((key, i): readonly SortTerm[] => {
    const k = exprs[i]!;
    const head: SortTerm = { expr: k, dir: key.dir, ...(key.nulls ? { nulls: key.nulls } : {}) };
    if (!signTermOwed(key.carrier)) return [head];
    // A deferral arm is wrapped in `abs()` so the term stays NUMERIC to the emitter, which otherwise keys a
    // possibly-text sort term for UTF-16 order (`utf16Key`, `src/rel/emit.ts`) — the arm never yields a value.
    const defer = (message: string): Expr => ({ kind: 'call', fn: 'abs', args: [deferralExpr(message, k)] });
    const iif = (test: Expr, then: Expr, otherwise: Expr): Expr => ({ kind: 'call', fn: 'iif', args: [test, then, otherwise] });
    const sign: Expr = key.carrier === 'encoded'
      ? iif(and(flagOf(i, 'b'), zeroOf(k)), stable
        ? iif(and(flagOf(i, 'f'), flagOf(i, 'p')), defer(ZERO_CLASSES_UNORDERED), compilerInt(0))
        : iif(flagOf(i, 'f'), defer(ZERO_TIE_UNSTABLE), compilerInt(0)), atan2(k))
      : key.carrier === 'unknown'
        ? iif(and(and(flagOf(i, 'f'), flagOf(i, 'u')), zeroOf(k)), defer(ZERO_CLASS_UNKNOWN), atan2(k))
        : atan2(k);
    return [head, { expr: sign, dir: key.dir }];
  });
  return { rel: input, terms };
}

/** How one side of a compare knows its zero's class — a `ZeroCarrier`, or a per-row test of the side's
 *  own type tag (`comparableTheta`, where the tag is in hand) for "this side is a BigInteger/BigDecimal". */
export type ZeroClassOf = ZeroCarrier | { readonly big: Expr };

/** `type IN ('bigint','bigdecimal')` — the `ZeroClassOf` of a side whose tag is in hand. */
export const bigTagged = (type: Expr): ZeroClassOf => ({ big: { kind: 'in-list', expr: type, values: BIG_VTYPES.map(compilerText) } });

/** The deferral a compare raises where one side's zero class is not carried and the other side is `-0.0`. */
const ZERO_COMPARE_UNKNOWN = 'comparing a negative zero with a zero of unknown number class is not supported';

/**
 * `left <op> right` over two per-row compare keys, under `NumberHelper.compare` — the comparison twin of
 * `orderedBy`. `Compare.lt/lte/gt/gte` and `eq`/`neq` all reach `NumberHelper.compare` for two Numbers
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Compare.java`
 * → `.../util/GremlinValueComparator.java:97-139` → `.../util/NumberHelper.java:670-680`), so where BOTH
 * keys are a zero the answer is their classes' (`ZeroCarrier`): if either is a BigInteger/BigDecimal they
 * are EQUAL (the plain compare — SQLite calls every zero equal), otherwise `Double.compare` orders them by
 * SIGN — `-0.0 < 0.0` holds and `-0.0 = 0.0` does not — which compares their SIGN BITS (`signBit`) with
 * the sides SWAPPED, a set sign bit being the smaller zero. A side whose class is `unknown` facing a
 * negative zero DEFERS. Every other pair is the plain compare.
 *
 * The rule reads each operand several times, and an operand is typically a correlated read (a `by()`
 * key's subquery). So with a `fresh` minter an operand that is not a bare column or literal is evaluated
 * ONCE, as the one row of a `VALUES` the compare is projected over — `typedNodeOnce`'s shape (`build.ts`)
 * — rather than re-spelling the read per mention (measured: a three-leaf `where(…).by(…)` ring went from
 * 55 KB to 88 KB of statement text inline, against DO's 100 KB cap).
 */
export function signedCompare(
  op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr, fresh?: Minter,
  classes: readonly [ZeroClassOf, ZeroClassOf] = ['natural', 'natural'],
): Expr {
  const plain: Expr = { kind: 'binary', op, left, right };
  const [lc, rc] = classes;
  // A side that is statically big ties every zero; two sides that cannot hold a negative zero compare plainly.
  if (lc === 'big' || rc === 'big' || (lc === 'integral' && rc === 'integral')) return plain;
  const cheap = (e: Expr): boolean => e.kind === 'col' || e.kind === 'lit';
  if (fresh && !(cheap(left) && cheap(right))) {
    const one = make.values({ id: fresh('sco'), channels: [], type: typeOf(meta('l', 'any', true), meta('r', 'any', true)), rows: [[left, right]] });
    return { kind: 'scalar', plan: make.project({
      id: fresh('scp'), input: one, channels: [], type: typeOf(meta('c', 'int', true)),
      exprs: [['c', signedCompare(op, col(one.id, 'l'), col(one.id, 'r'), undefined, classes)]],
    }) };
  }
  const big = (e: Expr, c: ZeroClassOf): Expr | null =>
    typeof c === 'object' ? c.big : c === 'encoded' ? isInteger(e) : null;
  const bigs = [big(left, lc), big(right, rc)].filter((e): e is Expr => e !== null);
  const unknown = [
    ...(lc === 'unknown' ? [and({ kind: 'unary', op: 'not', arg: signBit(left) }, signBit(right))] : []),
    ...(rc === 'unknown' ? [and({ kind: 'unary', op: 'not', arg: signBit(right) }, signBit(left))] : []),
  ];
  const either = (es: readonly Expr[]): Expr => es.reduce((a, b) => binary('or', a, b));
  const signed: Expr = { kind: 'binary', op, left: signBit(right), right: signBit(left) };
  const zeros: Expr = bigs.length || unknown.length
    ? { kind: 'case', whens: [
      ...(bigs.length ? [[either(bigs), plain] as const] : []),
      ...(unknown.length ? [[either(unknown), raiseExpr(ZERO_COMPARE_UNKNOWN, left)] as const] : []),
    ], else: signed }
    : signed;
  return { kind: 'case', whens: [[and(zeroOf(left), zeroOf(right)), zeros]], else: plain };
}

/** The common case: the `vtype` is a COLUMN of a relation in scope. Derived from the general form
 *  rather than a second copy of the type lists — `modulator.ts` builds the key inside a scalar
 *  subquery where the vtype is an arbitrary expression, and two spellings of the same cast policy is
 *  how one of them silently stops matching the other. */
export const storedCompare = (rel: RelId, vtype = 'vtype') => storedCompareOn(col(rel, vtype));

/**
 * COMPARABILITY over two PER-ROW stored scalars — the faithful lowering of an ordering theta
 * `where('a', P.gt('b'))` (and lt/gte/lte) between two VALUE aliases.
 *
 * `Compare.gt/gte/lt/lte` route through `GremlinValueComparator.COMPARABILITY`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Compare.java:63-116`
 * → `.../util/GremlinValueComparator.java:97-153`), NOT the cross-type total order ORDERABILITY that
 * `order(Scope.local)` uses: an ordering op is defined ONLY within one `Type` bucket (`comparable()` =
 * `ft == st`, `GremlinValueComparator.java:314-363`) and is simply FALSE across buckets (the guard
 * returns false before `compare` would throw). So this is a same-bucket-else-false CASE, not a sort
 * key — the shape `ordered()` already builds for the one-static-side case, one axis over (both per-row).
 *
 * The reachable scalar buckets for a value alias are Number / Date(datetime) / Duration / String /
 * Boolean / UUID; the tag→bucket mapping and the uuid-as-lexical compare mirror `orderability.ts`'s
 * `kindOf`/`cmpNatural` so the ordering and orderability comparators agree on every bucket. Within
 * Number (one bucket across int/real, `GremlinValueComparator.Type.Number`) each side is cast by its OWN
 * storage class (`storedCompareOn`) and SQLite's exact int/real comparison decides — NumberHelper's
 * numeric equivalence. Callers guarantee a runtime `t` tag on both sides (an `unknown`-typed alias
 * declines upstream), so the `else` fires only for a genuine cross-bucket pair.
 */
export const comparableTheta = (
  op: Extract<Expr, { kind: 'binary' }>['op'], valA: Expr, typeA: Expr, valB: Expr, typeB: Expr,
): Expr => {
  const inList = (t: Expr, names: readonly string[]): Expr => ({ kind: 'in-list', expr: t, values: names.map(compilerText) });
  const bothIn = (names: readonly string[]): Expr => and(inList(typeA, names), inList(typeB, names));
  const bothEq = (name: string): Expr => and(binary('=', typeA, compilerText(name)), binary('=', typeB, compilerText(name)));
  const asInt = (v: Expr): Expr => ({ kind: 'cast', arg: v, to: 'int' });
  return {
    kind: 'case',
    whens: [
      // Number: ONE bucket across int/real — cast each side by its own storage class, then compare under
      // `NumberHelper.compare` (`signedCompare`): two zeros by SIGN unless either side is a big class.
      [bothIn([...NUMERIC_CAST_TO_INT, ...CAST_TO_REAL]), signedCompare(op, storedCompareOn(typeA)(valA), storedCompareOn(typeB)(valB), undefined, [bigTagged(typeA), bigTagged(typeB)])],
      // Date (epoch) and Duration (total nanos) each ride as an integer → chronological order.
      [bothEq('datetime'), binary(op, asInt(valA), asInt(valB))],
      [bothEq('duration'), binary(op, asInt(valA), asInt(valB))],
      // String/char (lexical), Boolean (0/1) and UUID (lexical, per `orderability.ts`) compare the value.
      [bothIn(['string', 'char']), binary(op, valA, valB)],
      [bothEq('boolean'), binary(op, valA, valB)],
      [bothEq('uuid'), binary(op, valA, valB)],
    ],
    else: compilerFalse,
  };
};

/**
 * Gremlin `P.eq` equality between two TYPED stored-style values — each a `(value, vtype)` pair — as the
 * merge SEARCH compares a candidate's stored property against a driver's computed criterion
 * (`t.has(k, concreteValue)` → `Compare.eq` → `GremlinValueComparator.equals`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:123-139`).
 *
 * The reference rule, exactly: two NUMBERS compare numerically ACROSS int/real classes
 * (`NumberHelper.compare == 0`, so `30` (int) equals `30.0` (double)); any other pair is equal only when
 * the SAME Gremlin type holds equal values; a cross-type pair is never equal (`comparable(f,s)` is
 * false). So — both vtypes numeric → each cast to its numeric class (which bridges int↔real, and pulls
 * a decimal/bigint TEXT tail to a numeric) and compared; else the same vtype → a raw value compare
 * (string/boolean/uuid, and `datetime`/`duration` whose epoch/nanos form IS the value); else false.
 * It is `comparableTheta`'s `eq` sibling — the same same-bucket-else-false shape, collapsed to the two
 * arms an EQUALITY needs (numbers as one bucket; every other tag compared only within itself).
 *
 * The numeric guard is `NUMERIC_VTYPES`, NOT `CAST_TO_INT`: `datetime`/`duration` are numeric to SQLite
 * but are NOT `Number`s to Gremlin, so a `datetime` must not compare-equal to an `int` that happens to
 * share its epoch — they take the same-vtype arm and only compare within their own tag.
 */
export const typedValueEq = (aValue: Expr, aVtype: Expr, bValue: Expr, bVtype: Expr): Expr => {
  const numeric = (vtype: Expr): Expr => ({ kind: 'in-list', expr: vtype, values: NUMERIC_VTYPES.map(compilerText) });
  return {
    kind: 'case',
    whens: [
      [and(numeric(aVtype), numeric(bVtype)), binary('=', storedCompareOn(aVtype)(aValue), storedCompareOn(bVtype)(bValue))],
      [binary('=', aVtype, bVtype), binary('=', aValue, bValue)],
    ],
    else: compilerFalse,
  };
};

/** `TextP` -> a LIKE pattern with the user's metacharacters escaped. A wire parameter stays a
 * parameter through the pattern; interpolating its current value here would silently make it a
 * compiler constant. */
function likePattern(op: string, operand: Arg): { pattern: Expr; negated: boolean; nullOperand: boolean; cased: (subject: Expr) => Expr } | null {
  // TOTAL over every op, including `P.not(…)`, whose name starts with `not` but is not a TextP op.
  const negated = op.startsWith('not') && op.length > 3;
  const base = negated ? op[3].toLowerCase() + op.slice(4) : op;
  if (base !== 'startingWith' && base !== 'endingWith' && base !== 'containing') return null;
  // TextP is P<String>. Do not let SQLite stringify a number (`123` would otherwise satisfy
  // containing('2')); null is the separately-defined Text.isNull case.
  if (operand.value !== null && typeof operand.value !== 'string') return null;
  if (operand.value === null) return { pattern: compilerText(''), negated, nullOperand: true, cased: () => CONSTANT.false };
  const raw = operand.name == null ? compilerText(operand.value) : param(operand.value, operand.name);
  const escaped: Expr = { kind: 'call', fn: 'replace', args: [
    { kind: 'call', fn: 'replace', args: [
      { kind: 'call', fn: 'replace', args: [raw, compilerText('\\'), compilerText('\\\\')] },
      compilerText('%'), compilerText('\\%'),
    ] },
    compilerText('_'), compilerText('\\_'),
  ] };
  const join = (...parts: readonly Expr[]): Expr => parts.reduce((left, right) => binary('||', left, right));
  // SQLite's LIKE folds ASCII case (`'MARKO' LIKE '%ark%'` is true), where Java's `startsWith`/`endsWith`/
  // `contains` are exact (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Text.java:44,126`
  // and the `endingWith` arm between them). So the LIKE is only a case-blind SUPERSET — kept because it is
  // the atom the `property_fts` trigram seek reads (`rel/passes/semijoin.ts`) — and this `cased` test,
  // CONJOINED with it, is the exact answer. `instr` is the 1-based position of the FIRST occurrence (1 for
  // an empty term), so `= 1` is a prefix test; a suffix is a `substr` compare guarded by length, because a
  // non-positive `substr` start counts from the RIGHT. Both compare BINARY — no collation folds case.
  const instr = (subject: Expr): Expr => ({ kind: 'call', fn: 'instr', args: [subject, raw] });
  const length = (x: Expr): Expr => ({ kind: 'call', fn: 'length', args: [x] });
  const cased = (subject: Expr): Expr =>
    base === 'containing' ? binary('>', instr(subject), compilerInt(0))
    : base === 'startingWith' ? binary('=', instr(subject), compilerInt(1))
    : binary('or', binary('=', length(raw), compilerInt(0)), binary('and', binary('>=', length(subject), length(raw)),
        binary('=', { kind: 'call', fn: 'substr', args: [subject, binary('+', binary('-', length(subject), length(raw)), compilerInt(1))] }, raw)));
  if (base === 'startingWith') return { pattern: join(escaped, compilerText('%')), negated, nullOperand: false, cased };
  if (base === 'endingWith') return { pattern: join(compilerText('%'), escaped), negated, nullOperand: false, cased };
  if (base === 'containing') return { pattern: join(compilerText('%'), escaped, compilerText('%')), negated, nullOperand: false, cased };
  return null;
}

/** SQLite LIKE coerces non-text storage classes, while TextP accepts a String (or null) only. A
 * raw property without its vtype uses its storage class as the same fallback `typeOf` uses. */
function textSubject(subject: Expr, type: SubjectType): Expr {
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    return canonical === 'string' || type.type.toLowerCase() === 'null' ? CONSTANT.true : CONSTANT.false;
  }
  const storage = { kind: 'call', fn: 'typeof', args: [subject] } as const;
  const raw = binary('or', binary('=', storage, compilerText('text')), binary('is', subject, compilerNull()));
  if (type.kind === 'unknown') return raw;
  return binary('or',
    { kind: 'in-list', expr: type.vtype, values: [compilerText('string'), compilerText('null')] },
    binary('and', binary('is', type.vtype, compilerNull()), raw),
  );
}

/**
 * `P.typeOf(GType|"ClassName")` — a TYPE test over the subject, or `null` to decline.
 *
 * Three modes, and which one applies is entirely `SubjectType`'s answer (this arm is where a
 * plausible-looking shortcut would be silently wrong for a whole type family):
 *
 * 1. **compile-time type** → CONSTANT FOLD. `count().is(P.typeOf(GType.LONG))` is `1=1` and
 *    `…(GType.STRING)` is `1=0`; neither needs to touch a row.
 * 2. **per-row `vtype`** → compare it, with the storage class as the fallback for a row whose `vtype`
 *    is NULL (a raw insert). Both halves are needed: the column is the only thing that distinguishes
 *    a `datetime` from a `long`, and the fallback is the only thing that answers for a legacy row.
 * 3. **nothing known** → the storage-class test alone, which is FALSE for every type SQLite's classes
 *    cannot distinguish. False rather than declining, because that IS the answer TinkerPop's reference
 *    gives over an untyped value, and `STORAGE_CLASS`'s `null` entries are what say so.
 *
 * Declines rather than throwing on an unreadable argument: `typeOf() requires a GType argument` /
 * `unregistered type 'x'` are real errors, and a chain reaching one declines whole and raises
 * `UnsupportedTraversal`.
 */
function typeOfExpr(subject: Expr, arg: unknown, type: SubjectType): Expr | null {
  const raw = gtypeName(arg)?.toLowerCase();
  if (raw === undefined || raw === null) return null;
  if (raw === 'null') return binary('is', subject, compilerNull());
  const canonical = normalizeTypeName(raw);
  // A recognized element/token GType (vertex/edge/path/…) is valid Gremlin but a stored property
  // scalar is never one, so it folds to FALSE. An unrecognized NAME is a real error — which means
  // declining here, not folding, because folding would answer a question that should have thrown.
  if (!canonical) return KNOWN_NON_VALUE.has(raw) ? CONSTANT.false : null;

  if (type.kind === 'static') return normalizeTypeName(type.type) === canonical ? CONSTANT.true : CONSTANT.false;
  const storage = STORAGE_CLASS[canonical];
  const byStorage: Expr = storage ? binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText(storage)) : CONSTANT.false;
  if (type.kind === 'unknown') return byStorage;
  return {
    kind: 'case',
    whens: [[binary('is not', type.vtype, compilerNull()), binary('=', type.vtype, compilerText(canonical))]],
    else: byStorage,
  };
}

/** GTypes that name something a stored property value can never be. Valid syntax, so the answer is
 *  FALSE; an unrecognized name is an ERROR instead, and the two must not be confused. */
const KNOWN_NON_VALUE = new Set(['vertex', 'edge', 'vertexproperty', 'vproperty', 'property', 'tree', 'graph', 'path', 'binary']);

/**
 * A predicate over `subject`, or `null` to decline.
 *
 * `type` is what is known about the subject's Gremlin type, and it is ONE total union rather than the
 * optional `compare` callback it replaced: the range ops derive their ordering key from it and
 * `typeOf` reads it directly, so two arms share one fact instead of two parameters describing it.
 * The caller supplies it because the caller is the only one that knows where the `vtype` column lives
 * — the same reason `Col` names a relation.
 */
/** A collection PARAMETER as an IN-set: `subject IN (SELECT sv FROM json_each(jsonb(?)))`. The whole
 *  array crosses as ONE `jsonb(?)` bind exploded by `json_each` (root `CLAUDE.md`'s data-sized-set rule),
 *  so the parameter stays a bind of any size and the statement text never becomes a function of its data.
 *  The bind is a PARAMETER (`param`, named), so it reuses the repeated-parameter dedup like any other. */
const jsonEachInSet = (subject: Expr, value: readonly unknown[], name: string, fresh: Minter, negated: boolean): Expr => ({
  kind: 'in-query', negated, expr: subject, plan: jsonEachSet(name, value, fresh),
});

/**
 * A VARARG VALUE SET over `subject` — the `hasKey(a, b, …)` / `hasValue(a, b, …)` form, where a NULL
 * member is LEGAL. One argument is an `eq` and several a `within`, which is upstream's own reduction:
 * `HasContainer(T.key, labels.length == 1 ? P.eq(labels[0]) : P.within(labels))`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java:3107`,
 * and `:3179` for the value side).
 *
 * ⚠️ **IT IS NOT `predicateExpr(… {op:'within'})`, and the difference is a null.** A null operand there
 * DECLINES on purpose and must keep declining: `P.neq(null)` is TRUE for every non-null value while
 * `NOT (x = NULL)` is NULL, so admitting one generally would turn a decline into a wrong answer. Here the
 * only two ops are `eq` and `within`, and for exactly those SQL's null propagation IS the reference's
 * answer — `value.equals(null)` is false, so `g.V().properties().hasKey(null)` is the EMPTY result and
 * `hasKey(null, 'age')` keeps the `age` properties (`.../features/filter/HasKey.feature:71-101`).
 *
 * A single argument that is itself a `P` is that `P`, not a one-member set — `hasValue(P.gt(30))` is a
 * range and routes to `predicateExpr`.
 */
export function valueSet(
  subject: Expr, args: readonly Arg[], type: SubjectType, fresh?: Minter,
): Expr | null {
  if (!args.length) return null;
  const only = args.length === 1 ? args[0]! : null;
  if (only && (isPred(only.value) || only.value !== null))
    return predicateExpr(subject, only.value, type, only.type, only.name, fresh);
  // A P nested among varargs is not a form Gremlin has (`hasKey(P.eq('a'), 'b')` does not type), so
  // declining beats folding one into a member list.
  if (args.some((a) => isPred(a.value))) return null;
  const values = args.map((a) => (a.value === null ? compilerNull() : operand(a.value, a.type, a.name)));
  if (values.some((v) => !v)) return null;
  // ONE member that is null: `x = NULL` is never true, which is the answer, and spelling it as the
  // comparison rather than as `CONSTANT.false` keeps the reason readable in the emitted SQL.
  return values.length === 1
    ? binary('=', subject, values[0]!)
    : { kind: 'in-list', expr: subject, values: values as Expr[] };
}

export function predicateExpr(
  subject: Expr, pred: unknown, type: SubjectType = SUBJECT_UNKNOWN,
  opType: TypeNode | null = null, opParam: string | null = null, fresh?: Minter,
  /** Resolves a NESTED-traversal `within`/`without` operand (`within(__.…fold())`) to the SET relation it
   *  produces at run time, exploded by json_each — the caller owns it because it holds the child seam. */
  resolveListSet?: (nested: unknown) => Rel | null,
  /** Resolves a NESTED-traversal `within`/`without` operand that is NOT a fold to the CORRELATED FIRST
   *  VALUE it produces for the current traverser — the vararg-member form (`within(__.values(k),
   *  __.constant(v))`), each operand a scalar correlated to the subject element rather than one rooted
   *  fold. The caller owns it because it holds both the child seam and the element host. */
  resolveScalar?: (nested: unknown) => Expr | null,
): Expr | null {
  // `has(key)` with no value: presence, not comparison.
  if (pred === undefined) return binary('is not', subject, compilerNull());
  // A BARE NULL value is `eq(null)` — `has(k, null)`/`is(null)` desugar to `P.eq(null)`, whose null-space
  // rule is `subject IS NULL` (`comparable` is false unless both are null; SQLite `= NULL` is itself
  // NULL, never true, which is exactly wrong). Over a stored non-null property this is always false — the
  // EMPTY result `Has.feature`/`HasLabel.feature` pin — and it must NOT reach `operand()`, which declines
  // a null and made the whole `has(k, null)` decline. Distinct from `pred === undefined` (presence) above.
  if (pred === null) return binary('is', subject, compilerNull());
  if (!isPred(pred)) {
    // A BARE TRAVERSAL value is `is(P.eq(traversal))` (`GraphTraversal.is(Object)` wraps a non-`P` in
    // `P.eq`), so it takes the same FIRST-value resolution a `P.eq(traversal)` operand does below.
    if (isNested(pred)) {
      const nested = resolveScalar ? resolveScalar(pred) : null;
      return nested && binary('=', subject, nested);
    }
    // The BARE value — the one operand that can be a top-level parameter (`has(k, $x)`, `is($x)`), so it
    // alone carries the declared type and the param name; a `P.gt(x)` operand is nested and inlines.
    const value = operand(pred, opType, opParam);
    return value && equality(subject, value, pred, type, opType);
  }

  const { op, operands } = pred;
  // Each operand is an `Arg`, so its own value + type + parameter name travel together — a `P.gt($x)`
  // / `within($x, $y)` operand binds and a parsed literal inlines, wherever it sits, with no separate
  // parallel-name lookup.
  const recurse = (o: Arg) => predicateExpr(subject, o.value, type, null, null, fresh, resolveListSet, resolveScalar);
  const both = (build: (left: Expr, right: Expr) => Expr): Expr | null => {
    const [left, right] = [recurse(operands[0]), recurse(operands[1])];
    return left && right ? build(left, right) : null;
  };

  if (op === 'not') { const inner = recurse(operands[0]); return inner && negated(inner); }
  // Infix-composed predicates — `P.gt(20).and(P.lt(30))`. Both sides test the SAME subject, so it
  // is a boolean combination that nests to any depth because each side recurses through here.
  if (op === 'and') return both((l, r) => binary('and', l, r));
  if (op === 'or') return both((l, r) => binary('or', l, r));

  const comparison = COMPARISON[op];
  if (comparison) {
    // A NULL OPERAND is `Compare`'s null-space rule, not a value comparison: `comparable(f, s)` is FALSE
    // unless BOTH are null (`vendor/tinkerpop/gremlin-core/.../util/GremlinValueComparator.java:314-316`),
    // so every ordering test short-circuits and equality is null-vs-null. SQLite `= NULL` is itself NULL
    // (never true), which is exactly wrong here — so the operand never reaches `operand()` (which declines
    // it) and the predicate is spelled as an explicit IS [NOT] NULL:
    //   eq(null)  → subject IS NULL      neq(null) → subject IS NOT NULL
    //   gt/lt(null) → FALSE (a value is never > or < null; null-vs-null is compare=0, not >/<)
    //   gte/lte(null) → subject IS NULL  (true ONLY when both are null: compare=0 satisfies >=/<=)
    // Verified against `semantics/Comparability.feature` (the `InjectX1dX_*XnullX` and `InjectXnullX_*`
    // scenarios): over `1.0d` every arm but `neq` is empty; over a null subject `eq`/`gte`/`lte` hold.
    if (operands[0].value === null && !isPred(operands[0].value)) {
      switch (op) {
        case 'eq': case 'gte': case 'lte': return binary('is', subject, compilerNull());
        case 'neq': return binary('is not', subject, compilerNull());
        case 'gt': case 'lt': return CONSTANT.false;
        default: return null;
      }
    }
    // A NaN OPERAND compares as NO value does: `neq` holds for every subject and every other comparison
    // fails (`semantics/Comparability.feature`, the `InjectX1dX_*XNaNX` and `InjectXnullX_*XNaNX`
    // scenarios). SQLite has no NaN, so the operand never reaches `operand()` — `constLit` declines a NaN
    // VALUE — and the predicate is its constant truth value. A NaN SUBJECT cannot reach here: every seam a
    // NaN value would enter the stream through declines.
    if (typeof operands[0].value === 'number' && Number.isNaN(operands[0].value)) {
      return op === 'neq' ? CONSTANT.true : CONSTANT.false;
    }
    // A NESTED-traversal operand — the predicate compares against the operand's FIRST produced value
    // (`P.resolve`, `vendor/tinkerpop/gremlin-core/.../P.java:328-373`). Its runtime TYPE is unknown, so
    // this is a DIRECT compare (SQLite's storage-class order, which matches `GremlinValueComparator` for
    // the same-typed operands the corpus pairs — `age` vs `age`, `name` vs `name`) rather than
    // `ordered`'s vtype-driven cast, which has no compile-time type to read. An unproductive operand is a
    // NULL scalar and `subject <cmp> NULL` is NULL → not-true, which is the SCALAR predicate's
    // empty-operand SHORT-CIRCUIT (`resolvedEmpty` → `test` returns false) for every op EXCEPT `neq`,
    // whose `IS NOT 1` negation would read a NULL as true — so `neq` over a traversal declines (no corpus
    // pairs one, and mis-answering an empty operand is worse than a gap).
    if (isNested(operands[0].value)) {
      if (op === 'neq' || !resolveScalar) return null;
      const nested = resolveScalar(operands[0].value);
      return nested && binary(comparison, subject, nested);
    }
    // The operand inlines as a TYPED literal, storage class following its declared canonical type —
    // the thesis's "we know the type, stop throwing it away" (an integer-valued `P.gt(2.0)` renders
    // `2.0`, not `2`). Result-invariant: SQLite compares an INTEGER and a REAL numerically alike.
    const bound = operand(operands[0].value, operands[0].type, operands[0].name);
    if (!bound) return null;
    // Equality stays a RAW compare: canonical text is exact, and it keeps the value index usable
    // for the common case. Only ORDERING needs the cast, and only it pays for one.
    if (ORDERING.has(op)) {
      const order = ordered(comparison, subject, bound, operands[0].value, type, operands[0].type);
      // A `tag`-only subject orders by storage class, which a 0/1 Boolean or an epoch Date passes as a
      // Number; its tag still confines the comparison to one type space (`typeSpaced`).
      return order && (type.kind === 'unknown' ? typeSpaced(order, operands[0].value, type, operands[0].type) : order);
    }
    const equal = equality(subject, bound, operands[0].value, type, operands[0].type);
    return equal && (op === 'neq' ? negated(equal) : equal);
  }

  if (op === 'within' || op === 'without') {
    // MEMBERSHIP IS `eq` PER MEMBER, NULL INCLUDED. `Contains.within` tests each member with `Compare.eq`,
    // which is `GremlinValueComparator.COMPARABILITY.equals`, and `comparable(null, null)` is TRUE
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Contains.java`,
    // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:314-316`)
    // — so a null subject IS within a set holding null, exactly as `eq(null)` holds over it above, and
    // `without` is its complement (`Contains.without` = `!within`). Every arm below therefore builds the
    // POSITIVE membership and `settle` applies the op ONCE: a null member adds `subject IS NULL`, and
    // `without` is `negated` (`IS NOT 1`), which reads SQL's NULL — a null subject, or a NULL among the
    // `IN` members — as "not a member" rather than dropping the row as `NOT IN` did. Over a stored
    // property the subject is never null, so `IS NULL` is FALSE there and nothing changes.
    const settle = (positive: Expr, nullMember: boolean): Expr => {
      const member = nullMember ? binary('or', positive, binary('is', subject, compilerNull())) : positive;
      return op === 'within' ? member : negated(member);
    };
    // A single NESTED-traversal operand ending in `fold()` is a RUN-TIME member list
    // (`within(__.V(x).…values(k).fold())`): the folded traversal produces the set at query time,
    // exploded by json_each. The caller resolves it (it holds the child seam); a NON-fold single
    // operand, or a mix of traversals and literals, FALLS THROUGH to the vararg member path below.
    if (operands.length === 1 && isNested(operands[0].value) && resolveListSet) {
      const set = resolveListSet(operands[0].value);
      if (set) return settle({ kind: 'in-query', negated: false, expr: subject, plan: set }, false);
    }
    // A single collection operand — the faithful front-end leaves it whole. A bound list-PARAMETER
    // crosses as ONE `jsonb(?)` bind exploded by `json_each` (the parameter stays a bind of any size and
    // its data never enters the statement text); a LITERAL spreads to its members, each inlining or
    // binding by its own name. Varargs are already member operands.
    const coll = operands.length === 1 && Array.isArray(operands[0].value) ? operands[0] : null;
    if (coll && coll.name != null && !coll.members) {
      if (!fresh) return null;   // no relation minter reached this caller — decline (fail closed)
      const values = coll.value as readonly unknown[];
      return settle(jsonEachInSet(subject, values, coll.name, fresh, false), values.some((v) => v === null));
    }
    // A literal NULL member leaves the `IN` list (where it could only ever make the test NULL) and becomes
    // `settle`'s `subject IS NULL` arm. Reference: `within(27,null)` over age 27 matches and over 29 does
    // not, and `inject(null).is(within(0,null))` keeps the null.
    const allArgs = coll ? collectionMembers(coll) : operands;
    const nullMember = allArgs.some((o) => o.value === null);
    // A NaN member is inert: NaN equals nothing, itself included, so it can neither add a match to
    // `within` nor remove one from `without`.
    const memberArgs = allArgs.filter((o) => o.value !== null && !(typeof o.value === 'number' && Number.isNaN(o.value)));
    // SQLite rejects an empty `IN ()`, so the degenerate sets fold to their truth value: within
    // nothing is never, without nothing is always (an all-null set is `IS [NOT] NULL` through `settle`).
    if (!memberArgs.length) return nullMember ? settle(CONSTANT.false, true) : op === 'within' ? CONSTANT.false : CONSTANT.true;
    // NO SIZE LIMIT. A vararg set is bounded by the QUERY TEXT, and its members INLINE — 26 literals
    // cost zero bound parameters, so a cap derived from the 100-BIND wall was refusing queries that
    // spend none of it (measured: `within(<26 literals>)` declined while `within(<25>)` compiled, both
    // at 0 binds). The set whose size is a function of DATA is the named-collection branch above, which
    // crosses as ONE `json_each` bind unconditionally — that is where the rule lives, and it needs no
    // threshold to enforce it.
    // A member may be a NESTED TRAVERSAL — the vararg form (`within(__.values(k), __.constant(v))`).
    // `P.resolve` (`vendor/tinkerpop/gremlin-core/.../P.java:328-373`) runs each child traversal against
    // the current traverser and takes its FIRST result as ONE element, dropping an operand that produced
    // nothing; the caller's `resolveScalar` returns that correlated first value (NULL when the operand
    // produces nothing). A NULL member is inert in the `IN`/`NOT IN` idiom below exactly as a literal
    // null is (an unproductive operand can neither add a `within` match nor remove a `without` one), so
    // "drop the non-producing operand" and "leave its NULL in the list" are the same answer.
    const members = memberArgs.map((o) =>
      isNested(o.value) ? (resolveScalar ? resolveScalar(o.value) : null) : operand(o.value, o.type, o.name));
    if (members.some((m) => !m)) return null;
    // Membership is `eq` per member (`Contains.within`), so a literal member whose equality is not the
    // raw compare (`equality` — a rounding class, a String spelling a number) cannot ride an `IN` list.
    // Such a set is the disjunction of its members' equalities instead.
    // The type-space confinement (`typeSpaced`) is per member too, but a set whose members share ONE
    // space confines the whole `IN` list once, so the index-friendly list form survives it.
    const same = memberArgs.map((o, i) => isNested(o.value) ? binary('=', subject, members[i]!) : sameSpaceEquality(subject, members[i]!, o.value, type, o.type));
    if (same.some((e) => !e)) return null;
    // A stored BigDecimal riding as TEXT is the one row neither form sees (`decimalTextArm`): ONE arm for the set.
    const decimalArm = decimalTextArm(subject, type, memberArgs.filter((o) => !isNested(o.value)).map((o) => ({ value: o.value, type: o.type })));
    const withArm = (e: Expr): Expr => (decimalArm ? binary('or', e, decimalArm) : e);
    const spaces = new Set(memberArgs.map((o) => isNested(o.value) ? null : boundSpace(o.value, o.type)));
    if (spaces.size > 1 || same.some((e, i) => JSON.stringify(e) !== JSON.stringify(binary('=', subject, members[i]!)))) {
      const any = withArm(memberArgs.map((o, i) => isNested(o.value) ? same[i]! : typeSpaced(same[i]!, o.value, type, o.type))
        .reduce((acc, e) => binary('or', acc, e)));
      return settle(any, nullMember);
    }
    const inList = withArm(typeSpaced({ kind: 'in-list', expr: subject, values: members as Expr[] }, memberArgs[0]!.value, type, memberArgs[0]!.type));
    return settle(inList, nullMember);
  }

  // between = [lo, hi) — inclusive low; inside = (lo, hi) — exclusive both. outside = the OR-complement
  // of inside, (< lo OR > hi) (`P.outside` = `OrP(lt, gt)`, `P.java`). Both bounds and the subject go
  // through the ordering key for the same reason a range comparison does. A single collection bound
  // (`between([lo,hi])`) spreads to its two members first.
  if (op === 'between' || op === 'inside' || op === 'outside') {
    const bounds = operands.length === 1 && Array.isArray(operands[0].value) ? collectionMembers(operands[0]) : operands;
    if (bounds.length !== 2) return null;
    const [low, high] = [operand(bounds[0].value, bounds[0].type, bounds[0].name), operand(bounds[1].value, bounds[1].type, bounds[1].name)];
    if (!low || !high) return null;
    // outside is a DISJUNCTION either side of the range; between/inside are a conjunction inside it. The
    // low bound is exclusive for inside/outside (`>`/`<`) and inclusive for between (`>=`).
    const [loCmp, hiCmp] = op === 'outside'
      ? [ordered('<', subject, low, bounds[0].value, type, bounds[0].type),
         ordered('>', subject, high, bounds[1].value, type, bounds[1].type)]
      : [ordered(op === 'inside' ? '>' : '>=', subject, low, bounds[0].value, type, bounds[0].type),
         ordered('<', subject, high, bounds[1].value, type, bounds[1].type)];
    return loCmp && hiCmp ? binary(op === 'outside' ? 'or' : 'and', loCmp, hiCmp) : null;
  }

  const like = operands.length === 1 ? likePattern(op, operands[0]) : null;
  if (like) {
    // SQLite's `like(pattern, subject, escape)` FUNCTION, not the infix operator, because the
    // operator's ESCAPE clause is not an expression the algebra has a node for — and adding one
    // for a single op would widen the closed node set (§7) to say something the function already
    // says. Nothing is lost: SQLite disables its LIKE index optimization whenever ESCAPE is
    // present, which this LIKE-function form always is, so it is a residual filter either way.
    const call: Expr = like.nullOperand ? CONSTANT.false
      : binary('and', { kind: 'call', fn: 'like', args: [like.pattern, subject, compilerText('\\')] }, like.cased(subject));
    // The type gate stays outside the negative form: null is a legal String reference and the
    // negative TextP variants return true for it, but a non-String is not a TextP match at all.
    // `like` reads its text as a C string, so a NUL in either side defers (`containedText`, `text-units.ts`).
    const matched = like.negated ? negated(call) : call;
    return binary('and', textSubject(subject, type), like.nullOperand ? matched : containedText(subject, like.pattern, matched));
  }

  if (op === 'typeOf') return operands.length === 1 ? typeOfExpr(subject, operands[0].value, type) : null;

  // `regex` and `withinList`/`withoutList` (a list-valued traversal operand) remain. Each needs
  // something this module does not have — a regex function, or a run-time member list — so each
  // declines rather than being half-answered.
  return null;
}

/**
 * A min/max operand's COMPARABILITY class — `'number'` for every Number class, else the type's own name —
 * from its Gremlin type `tag` (a vtype, or SQLite's `typeof` where nothing better is known). The
 * reference compares two Numbers numerically and anything else with `compareTo`, which THROWS across
 * classes (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:582-597`):
 * `max()` over a name and an age is a `ClassCastException`, where SQLite orders every number before every
 * text and simply answered the text. A NULL is skipped by min/max, so it has no class. A storage-class
 * TEXT among numbers may be a wide `long`, but `'string'` differs from `'number'` either way, so that
 * stream refuses rather than guess.
 */
export function comparabilityClass(tag: Expr): Expr {
  // `tag` is spelled twice, not once per arm: `'null'` (a null, which min/max skip) has no class, and a
  // storage-class `'text'` is a String.
  const numberOrTag: Expr = {
    kind: 'case', whens: [[{ kind: 'in-list', expr: tag, values: [...NUMERIC_VTYPES, 'integer', 'real'].map(compilerText) }, compilerText('number')]],
    else: tag,
  };
  return { kind: 'call', fn: 'nullif', args: [{ kind: 'call', fn: 'replace', args: [numberOrTag, compilerText('text'), compilerText('string')] }, compilerText('null')] };
}

/** `value`, unless the classes `cls` takes over `members` differ — then a deferral. One aggregate over the
 *  members, read as a scalar subquery, for a min/max that picks its winner by sort rather than by window. */
export function mixedClassesRefused(value: Expr, members: Rel, cls: Expr, fresh: Minter): Expr {
  // The refusal is INSIDE the aggregate — it raises there or yields 0 — so neither it nor `value` is
  // spelled twice: `coalesce(nullif(<0 or raise>, 0), value)`.
  const count: Expr = { kind: 'agg', fn: 'count', args: [cls], distinct: true };
  const verdict = make.aggregate({
    id: fresh('mxc'), input: members, channels: [], type: typeOf(meta('n', 'int')),
    groupBy: [], aggs: [['n', { kind: 'case', whens: [[binary('>', count, compilerInt(1)), raiseExpr(MIXED_COMPARABLES, { kind: 'agg', fn: 'count', args: [] })]], else: compilerInt(0) }]],
  });
  return { kind: 'call', fn: 'coalesce', args: [{ kind: 'call', fn: 'nullif', args: [{ kind: 'scalar', plan: verdict }, compilerInt(0)] }, value] };
}
