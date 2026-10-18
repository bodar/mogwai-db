import { and, col, compilerInt, compilerNull, compilerReal, compilerText, param, type Expr } from '../../rel/expr.ts';
import { jsonEachSet, meta, typeOf, type Minter } from './build.ts';
import * as make from '../../rel/factory.ts';
import { raiseExpr } from '../../rel/raise.ts';
import { inferredVtype, MIXED_COMPARABLES } from './reducer.ts';
import type { RelId, SqlType } from '../../rel/types.ts';
import type { Rel } from '../../rel/rel.ts';
import { gtypeName, arg, collectionMembers, isNested, type Arg } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, normalizeTypeName, STORAGE_CLASS, type TypeNode } from '../../gremlin/types.ts';
import { constLit } from './const.ts';

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
 *  comparison casts it to a numeric class (`compareBound`): the two integrals, and a BigDecimal holding a whole
 *  value inside int64 (`9007199254740993.0m` equals its Long), → INTEGER; any other BigDecimal → REAL. */
const isExactTail = (value: unknown): boolean =>
  typeof value === 'bigint' || value instanceof BigDecimal || value instanceof Duration;
const wholeInt64 = (d: BigDecimal): boolean => {
  if (d.scale > 0 && d.unscaled % 10n ** BigInt(d.scale) !== 0n) return false;
  const whole = d.scale > 0 ? d.unscaled / 10n ** BigInt(d.scale) : d.unscaled * 10n ** BigInt(-d.scale);
  return whole >= -(2n ** 63n) && whole < 2n ** 63n;
};
const exactTailCast = (value: unknown): SqlType | null =>
  value instanceof BigDecimal ? (wholeInt64(value) ? 'int' : 'real') : (typeof value === 'bigint' || value instanceof Duration) ? 'int' : null;

/** The numeric class a TEXT-stored static SUBJECT casts to in an ordering compare, keyed by canonical
 *  type (`normalizeTypeName` output). The cast is IDENTITY on the native form of the same tag (a native
 *  `long` is already INTEGER, an `asNumber(BIGDECIMAL)` REAL) and the conversion on the decimal/nanos-TEXT
 *  form (`inject(9.99m)` → REAL), so it is correct once `type.text` says which storage class is in hand. */
const STATIC_SUBJECT_CAST: Record<string, SqlType> = { bigdecimal: 'real', long: 'int', bigint: 'int', duration: 'int' };
/** A static subject keyed to its numeric class where it may ride as TEXT — flagged `text`, or a BigDecimal (whose
 *  carrier is decimal TEXT however it was produced); `null` where the subject compares as it is. */
const staticKey = (subject: Expr, canonical: string, text: boolean | undefined, edge: boolean): Expr | null => {
  const to = text || canonical === 'bigdecimal' ? STATIC_SUBJECT_CAST[canonical] : undefined;
  return to === 'int' ? intKey(subject, edge) : to ? { kind: 'cast', arg: subject, to } : null;
};

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
 * NUMBERS COMPARE BY VALUE — SQLite's own INTEGER/REAL comparison, which is exact, with each side keyed to
 * its numeric class (`compareKey`'s cast: a decimal-TEXT BigDecimal reads as its REAL, a TEXT long or
 * BigInteger as its INTEGER). `NumberHelper`'s widening (a long past 2^53 rounded to a double, a Double
 * widened through `BigDecimal.valueOf`'s printed decimal) is deliberately NOT reproduced: the two differ only
 * in the last ulp (`docs/feature-support-matrix.md`, Deliberate divergences).
 *
 * The one place SQLite's comparison is not the value's: `CAST(… AS INTEGER)` SATURATES at int64, so a
 * BigInteger past it reads as ±(2^63 - 1). That is harmless against a bound strictly inside int64 (the
 * saturated subject stays on its side of it), so only a bound PAST int64 orders both sides as REAL —
 * `wideBound`, that bound as a REAL, or `null` where the exact INTEGER comparison stands. A bound of EXACTLY
 * `Long.MAX_VALUE`/`MIN_VALUE` (a common sentinel) fits int64 and keeps the exact INTEGER compare — as a REAL
 * it would tie every Long within an ulp of it — and only a subject whose cast saturated is keyed strictly
 * beyond the edge on its own side (`intKey`). (Equality uses `wideBound` for a floating
 * bound only: a BigInteger past int64 equals its own canonical text, `sameSpaceEquality`.)
 */
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const TWO_63 = 2 ** 63;
const pastInt64 = (value: unknown): boolean => typeof value === 'bigint' && (value > LONG_MAX || value < LONG_MIN);
/** A bound of exactly int64's edge — the one INTEGER bound a saturated subject can tie. */
const atInt64Edge = (value: unknown): boolean => value === LONG_MAX || value === LONG_MIN;
/** A subject's INTEGER key. Against an `atInt64Edge` bound, a TEXT subject whose cast does not round-trip
 *  (a BigInteger past int64, which the cast saturates onto the edge) lies strictly OUTSIDE int64, so its sign
 *  alone orders it against the edge: it keys as its REAL doubled, which keeps the sign and clears ±2^63 (its
 *  bare REAL rounds `-9223372036854775809` onto `Long.MIN_VALUE` and would tie it). */
function intKey(subject: Expr, edge: boolean): Expr {
  const cast: Expr = { kind: 'cast', arg: subject, to: 'int' };
  if (!edge) return cast;
  const saturated = and(binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('text')),
    binary('!=', { kind: 'cast', arg: cast, to: 'text' }, subject));
  return { kind: 'case', whens: [[saturated, binary('*', { kind: 'cast', arg: subject, to: 'real' }, compilerReal(2))]], else: cast };
}
/** A subject's key against a `wideBound`. Against a BigInteger bound PAST int64, a subject whose INTEGER cast
 *  round-trips (a native INTEGER, or a TEXT Long/BigInteger inside int64) lies strictly inside the bound, so
 *  the bound's sign alone orders it: it keys as 0. Its REAL would round a Long within an ulp of the edge onto
 *  ±2^63 and tie the bound (`inject(Long.MAX_VALUE).is(lt(2^63))` lost its row). Only a subject outside
 *  int64 — a saturated TEXT BigInteger, a REAL — keys as its REAL. A floating bound keeps REAL throughout. */
function wideKey(subject: Expr, value: unknown): Expr {
  const real: Expr = { kind: 'cast', arg: subject, to: 'real' };
  if (!pastInt64(value)) return real;
  const inRange = binary('=', { kind: 'cast', arg: { kind: 'cast', arg: subject, to: 'int' }, to: 'text' }, { kind: 'cast', arg: subject, to: 'text' });
  return { kind: 'case', whens: [[inRange, compilerInt(0)]], else: real };
}
function wideBound(value: unknown): Expr | null {
  if (typeof value === 'bigint') return pastInt64(value) ? compilerReal(Number(value)) : null;
  const n = typeof value === 'number' ? value : value instanceof BigDecimal ? Number(String(value)) : NaN;
  return n >= TWO_63 || n <= -TWO_63 ? compilerReal(n) : null;
}

/** `subject op against` over a per-row or untyped subject: each number row keyed to its class (REAL
 *  throughout against a `wideBound`, saturation-aware against an `atInt64Edge` one), and `otherwise` for a
 *  row outside the vocabulary. */
function byValue(
  op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr, type: Exclude<SubjectType, { kind: 'static' }>,
  against: Expr, value: unknown, wide: boolean, edge: boolean, otherwise: Expr,
  intVtypes: readonly string[] = NUMERIC_CAST_TO_INT, realVtypes: readonly string[] = CAST_TO_REAL,
): Expr {
  const cast = (to: SqlType): Expr => wide ? wideKey(subject, value) : to !== 'int' ? { kind: 'cast', arg: subject, to } : intKey(subject, edge);
  if (type.kind === 'perRow') {
    const among = (names: readonly string[]): Expr => ({ kind: 'in-list', expr: type.vtype, values: names.map(compilerText) });
    return { kind: 'case', whens: [
      [among(intVtypes), binary(op, cast('int'), against)],
      ...(realVtypes.length ? [[among(realVtypes), binary(op, cast('real'), against)] as const] : []),
    ], else: otherwise };
  }
  const storage: Expr = { kind: 'call', fn: 'typeof', args: [subject] };
  return { kind: 'case', whens: [[
    { kind: 'in-list', expr: storage, values: [compilerText('integer'), compilerText('real')] }, binary(op, wide ? cast('real') : subject, against),
  ]], else: otherwise };
}

/**
 * THE ONE ROW A RAW `=` MISSES against a plain NUMBER bound: a BigDecimal riding as decimal TEXT under a
 * per-row type (`inject(1m).is(1)`). It reads as its REAL — OR-ed beside the raw compare rather than
 * replacing it, which keeps the value index and the `IN`-list form usable. `bounds` are the plain-number
 * bounds of one `eq` or one `within`; `null` where none needs the arm.
 */
function decimalTextArm(subject: Expr, type: SubjectType, bounds: readonly Expr[]): Expr | null {
  if (type.kind !== 'perRow' || !bounds.length) return null;
  const real: Expr = { kind: 'cast', arg: subject, to: 'real' };
  return and(binary('=', type.vtype, compilerText('bigdecimal')),
    bounds.length === 1 ? binary('=', real, bounds[0]!) : { kind: 'in-list', expr: real, values: bounds });
}
/** A bound `decimalTextArm` serves: a plain (non-temporal) JS number. */
const plainNumber = (value: unknown, type: TypeNode | null): boolean =>
  typeof value === 'number' && flatType(type) !== 'datetime' && flatType(type) !== 'duration';

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
  const wide = numericBound && !temporal ? wideBound(value) : null;
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    if (wide && canonical !== null && NUMERIC_VTYPES.includes(canonical))
      return binary(op, wideKey(subject, value), wide);
    // A TEXT-stored exact-tail subject (`inject(9.99m)`, a bound big long/Duration — `type.text`) rides as
    // decimal/total-nanos TEXT, so ordering casts it to its numeric class. The SAME cast is identity on the
    // NATIVE form of the same tag (`count()`→INTEGER, `asNumber(BIGDECIMAL)`→REAL), which is why the flag —
    // set only where the value is stored as TEXT (`injectSource`) — is what disambiguates the two and lets
    // `inject(9.99m)`/`inject(9…L)`/`inject(Duration(…))` order instead of declining
    // (docs/archive/2026-08-05-parameters-are-the-only-binds.md C1).
    const keyed = canonical !== null ? staticKey(subject, canonical, type.text, atInt64Edge(value)) : null;
    if (numericBound && keyed) return binary(op, keyed, castBound);
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
  if (numericBound) return byValue(op, subject, type, wide ?? castBound, value, wide !== null, atInt64Edge(value), compilerFalse, intVtypes, realVtypes);
  return type.kind === 'perRow'
    ? { kind: 'case', whens: [[binary('=', type.vtype, compilerText('string')), binary(op, subject, bound)]], else: compilerFalse }
    : { kind: 'case', whens: [[binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('text')), binary(op, subject, bound)]], else: compilerFalse };
};

/**
 * VALUE EQUALITY — `eq`, and `neq` as its negation. A RAW compare where that is the reference's answer,
 * which is the common case and keeps the value index usable; widened only where raw SQLite equality and
 * `Compare.eq` (`NumberHelper.compare` for two numbers, `false` across type spaces — `Compare.java:66-69`,
 * `GremlinValueComparator.java:71-74`) disagree:
 *
 * - a NUMBER bound carried as TEXT (a BigInteger/BigDecimal literal) or outside int64: compared by value,
 *   the subject keyed by its class (`byValue`); a per-row BigDecimal TEXT row against a plain number reads as
 *   its REAL beside the raw compare (`decimalTextArm`);
 * - a STRING bound that spells a number, against a subject that may be a number carried as decimal TEXT:
 *   raw TEXT equality would call `'9007199254740994'` equal to the Long — restrict it to String rows;
 * - a NUMBER, BOOLEAN or DATE bound against a subject of ANOTHER type space (`typeSpaced`).
 */
const equality = (subject: Expr, bound: Expr, value: unknown, type: SubjectType, boundType: TypeNode | null): Expr | null => {
  const same = sameSpaceEquality(subject, bound, value, type, boundType);
  const arm = same && decimalTextArm(subject, type, plainNumber(value, boundType) ? [bound] : []);
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
  tag === null ? null : NUMERIC_VTYPES.includes(tag) ? 'number' : tag === 'boolean' || tag === 'datetime' || tag === 'duration' ? tag : null;
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
      return canonical !== null && (NUMERIC_VTYPES.includes(canonical) || canonical === 'duration') ? CONSTANT.false : raw;
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
  if (temporal || !(typeof value === 'number' || typeof value === 'bigint' || value instanceof BigDecimal)) return raw;
  // A String never equals a Number, however it is spelled (`inject('1.0').is(1.0m)`).
  if (type.kind === 'static' && normalizeTypeName(type.type) === 'string') return CONSTANT.false;
  // A row of no number class — a per-row String, an untagged TEXT (framed as a String by its storage class) —
  // never equals a Number bound, even where its text spells the bound's.
  const nonNumber: Expr = type.kind === 'unknown' && type.tag ? raw : compilerFalse;
  // A NUMBER bound compares BY VALUE: the raw `=` already is that answer for a plain number against a natively
  // stored row; a TEXT bound (a BigInteger/BigDecimal literal) is cast to its numeric class and met by the
  // subject keyed by its own (`byValue`), so a decimal-TEXT carrier reads as the number it is. A floating
  // bound outside int64 is met as a REAL (`wideBound`) — a saturating INTEGER cast never equals it.
  const wideAt = typeof value === 'bigint' ? null : wideBound(value);
  // A BigInteger past int64: a TEXT-carried NUMBER equals it exactly by its digits — a BigInteger's text IS
  // them, a BigDecimal's (plain decimal, never an exponent) once its zero fraction is trimmed, so
  // `100000000000000000000.0m` meets `100000000000000000000n` (a text with no '.' never trims to the match).
  // A native INTEGER/REAL row meets it by `wideKey`. A String spelled with the same digits is TEXT too, so a
  // subject must name a number class for the text arm to hold.
  if (pastInt64(value)) {
    const canonical = type.kind === 'static' ? normalizeTypeName(type.type) : null;
    const trimmed: Expr = { kind: 'call', fn: 'rtrim', args: [subject, compilerText('0')] };
    const digits = binary('or', raw, binary('=', trimmed, compilerText(`${String(value)}.`)));
    const text = type.kind === 'perRow' ? and({ kind: 'in-list', expr: type.vtype, values: NUMERIC_VTYPES.map(compilerText) }, digits)
      : type.kind === 'unknown' && !type.tag ? compilerFalse
      : canonical !== null && !NUMERIC_VTYPES.includes(canonical) ? CONSTANT.false : digits;
    return { kind: 'case', whens: [[binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText('text')), text]],
      else: binary('=', wideKey(subject, value), compilerReal(Number(value))) };
  }
  const tailCast = exactTailCast(value);
  if (!tailCast && !wideAt && type.kind !== 'static') return raw;
  const against: Expr = wideAt ?? (tailCast ? { kind: 'cast', arg: bound, to: tailCast } : bound);
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    if (canonical === null || !NUMERIC_VTYPES.includes(canonical)) return raw;
    return binary('=', wideAt ? { kind: 'cast', arg: subject, to: 'real' } : staticKey(subject, canonical, type.text, atInt64Edge(value)) ?? subject, against);
  }
  return byValue('=', subject, type, against, value, wideAt !== null, atInt64Edge(value), nonNumber);
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
 * `storedCompareOn` for a value or tag that is EXPENSIVE to spell — a correlated read (a child body's
 * value and tag), which the key's per-tag `CASE` would repeat once per arm. Each is evaluated ONCE, as the
 * one row of a `VALUES` the key is projected over (`typedNodeOnce`'s shape).
 */
export const storedCompareOnce = (vtype: Expr, subject: Expr, fresh: Minter): Expr => {
  const cheap = (e: Expr): boolean => e.kind === 'col' || e.kind === 'lit';
  if (cheap(vtype) && cheap(subject)) return storedCompareOn(vtype)(subject);
  const one = make.values({ id: fresh('sco'), channels: [], type: typeOf(meta('v', 'any', true), meta('t', 'text', true)), rows: [[subject, vtype]] });
  return { kind: 'scalar', plan: make.project({
    id: fresh('scp'), input: one, channels: [], type: typeOf(meta('k', 'any', true)),
    exprs: [['k', storedCompareOn(col(one.id, 't'))(col(one.id, 'v'))]],
  }) };
};

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
      // Number: ONE bucket across int/real — cast each side by its own storage class, then compare.
      [bothIn([...NUMERIC_CAST_TO_INT, ...CAST_TO_REAL]), binary(op, storedCompareOn(typeA)(valA), storedCompareOn(typeB)(valB))],
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
    // raw compare (`equality` — a TEXT-carried number, a String spelling a number) cannot ride an `IN` list.
    // Such a set is the disjunction of its members' equalities instead.
    // The type-space confinement (`typeSpaced`) is per member too, but a set whose members share ONE
    // space confines the whole `IN` list once, so the index-friendly list form survives it.
    const same = memberArgs.map((o, i) => isNested(o.value) ? binary('=', subject, members[i]!) : sameSpaceEquality(subject, members[i]!, o.value, type, o.type));
    if (same.some((e) => !e)) return null;
    // A stored BigDecimal riding as TEXT is the one row neither form sees (`decimalTextArm`): ONE arm for the set.
    const decimalArm = decimalTextArm(subject, type, members.filter((_, i) => plainNumber(memberArgs[i]!.value, memberArgs[i]!.type)) as Expr[]);
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
    return binary('and', textSubject(subject, type), like.negated ? negated(call) : call);
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
