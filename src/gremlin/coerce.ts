import { q, type Expression } from '../sql/kernel/q.ts';
import { type ValueType } from '../sql/kernel/render.ts';
import { isDtArg, isGTypeArg, isNested, parseIsoMs, stepChain, type Step } from './frontend.ts';
import { BigDecimal, flatType, numberClassOf, type CanonicalType } from './types.ts';
import { decimalCompare, decimalOf, doubleText, floatCanonical, floatingDecimal, javaNumberText } from './float.ts';
import { UnsupportedTraversal } from '../compiler/unsupported.ts';

/**
 * NOT LEARNED YET, raised from inside the fold — the front-end twin of the compiler's `Deferral`.
 *
 * Its own class rather than a bare `Error` for the reason `ValueParseError` is: the fold raises TWO
 * facts through one channel, and only the class tells them apart (§6·5). A caller whose contract is
 * `null` catches THIS and declines; a `ValueParseError` is the answer and travels on.
 */
/**
 * A COERCION'S OWN REFUSAL — the traversal's ANSWER is an error, not a lowering that gave up.
 *
 * `asNumber('1,000')` must RAISE (TinkerPop's exact wording), and SQL cannot raise at all, so the
 * parse happens here at compile time and the throw travels out through the lowering. That makes it
 * indistinguishable, to an INSTRUMENT, from the one thing a lowering may never do — throw for
 * vocabulary it has not learned (`rel-sweep`'s whole subject). The class is the discriminator: a
 * sweep skips it, a user still sees the message unchanged.
 */
export class CoercionDeferral extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoercionDeferral';
  }
}

export class ValueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueParseError';
  }
}

/**
 * A VERIFICATION STRATEGY'S REFUSAL — the reference's `VerificationException`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/verification/VerificationException.java`),
 * thrown by `StandardVerificationStrategy` and the opt-in verification strategies. Like a
 * `ValueParseError` it is the traversal's ANSWER, which is why it is one: every caller that tells an
 * answer from a decline keeps doing so, and the class names the reference's exception.
 */
export class VerificationException extends ValueParseError {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationException';
  }
}

// ---------- scalar value coercion (asBool / asNumber / asDate + date arithmetic) ----------
//
// The compile-time const-fold helpers (over inject() literals) and the runtime SQL
// emitters for the value-cast step family. Const-fold raises TinkerPop's exact
// "Can't parse …" / overflow messages (SQL can't raise them, and every reachable
// const input is an inject() literal); the SQL emitters wrap a runtime scalar in a
// CAST. Shared by renderProjection (runtime path, projection.ts) and compileInject
// (const path, inject.ts).

/** asBool() over a compile-time constant — TinkerPop's parse semantics. Its
 *  per-value errors (null / non-bool string / list → "Can't parse …") can't be
 *  raised from SQL, and every reachable input is an inject() literal, so evaluate
 *  here. Number: NaN/0/-0 → false, else true. String: "true"/"false"
 *  (case-insensitive); anything else throws. */
export function asBoolConst(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !Number.isNaN(v) && v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase(); // AsBoolStep trims before the case-insensitive match
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  // AsBoolStep renders a failing STRING's value (the corpus pins `Can't parse hello as Boolean.`) but a
  // non-scalar's class name (`AsBoolStep.java:53` — `getClass().getName()`); paraphrased to the simple
  // name, so a list reads `ArrayList` rather than its JS `toString()`.
  throw new ValueParseError(`Can't parse ${v === null || v === undefined ? 'null' : typeof v === 'object' ? javaTypeName(v) : v} as Boolean.`);
}

// asNumber(GType.X): GType token → framing tag + integer range (for overflow) / real
// flag. The subtype is a COMPILE-TIME property (the explicit arg) — SQLite carries the
// numeric value, frameValue picks the serializer from the tag. (bigdecimal has no
// GraphBinary serializer in the client → intentionally absent, defers.)
// `disp` is the boxed Java type name TinkerPop uses in its overflow message (e.g.
// GType.INT → "Integer", GType.BIGINT → "BigInteger") — NOT derivable from `as`.
const NUMERIC_GTYPES: Record<string, { as: ValueType; disp: string; int: boolean; min?: number; max?: number }> = {
  byte: { as: 'byte', disp: 'Byte', int: true, min: -128, max: 127 },
  short: { as: 'short', disp: 'Short', int: true, min: -32768, max: 32767 },
  int: { as: 'int', disp: 'Integer', int: true, min: -2147483648, max: 2147483647 },
  integer: { as: 'int', disp: 'Integer', int: true, min: -2147483648, max: 2147483647 },
  long: { as: 'long', disp: 'Long', int: true },
  bigint: { as: 'bigint', disp: 'BigInteger', int: true },
  biginteger: { as: 'bigint', disp: 'BigInteger', int: true },
  float: { as: 'float', disp: 'Float', int: false },
  double: { as: 'double', disp: 'Double', int: false },
  // bigdecimal completes the numeric asNumber family. Now that we ship a BigDecimal
  // serializer + exact TEXT storage, a cast to BigDecimal is representable (framed via
  // the value's canonical text; `int:false` skips the integer truncation/overflow path).
  bigdecimal: { as: 'bigdecimal', disp: 'BigDecimal', int: false },
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The Java class simple-name a `Can't parse type X …` message reports —
 *  `object.getClass().getSimpleName()` (`AsNumberStep.java:71`). A Gremlin list literal is a Java
 *  `ArrayList` and a map a `LinkedHashMap`; a boxed scalar's simple name already matches its
 *  capitalized JS `typeof` (`Boolean`). Not derivable from the JS value's `typeof` (an array and a
 *  map are both `object`), so named here rather than re-guessed. */
const javaTypeName = (v: unknown): string =>
  Array.isArray(v) ? 'ArrayList'
  : v instanceof Map || (v !== null && typeof v === 'object') ? 'LinkedHashMap'
  : cap(typeof v);

/** asNumber's GType arg → its numeric spec. `null` = bare asNumber() (no arg — needs
 *  the input subtype, which the frontend flattens away, so it defers). A non-numeric
 *  token (e.g. GType.VERTEX) raises TinkerPop's error. */
export function numericSpec(arg: any): (typeof NUMERIC_GTYPES[string] & { name: string }) | null {
  const name = isGTypeArg(arg) ? arg.gtype : null;
  if (name === null) return null;
  const spec = NUMERIC_GTYPES[name];
  if (!spec) throw new ValueParseError(`asNumber() requires a numeric type token, got ${name.toUpperCase()}`);
  return { ...spec, name };
}

/** asNumber(GType.X) over a compile-time constant: parse/convert + overflow-check,
 *  raising TinkerPop's exact messages (SQL can't raise these; inject inputs are
 *  literals). Integer targets truncate toward zero. */
export function asNumberConst(v: any, spec: NonNullable<ReturnType<typeof numericSpec>>, sourceType: string | null = null): number | bigint | BigDecimal | null {
  // A null object returns null — no parse, no throw (`AsNumberStep.map`, line 55:
  // `if (object == null) return null;`, before the token branch). `g.inject(null).asNumber(GType.INT)`
  // is the empty result `null`, not the parse error a non-null unparseable value raises.
  if (v === null || v === undefined) return null;
  return performConversion(javaNumber(v, sourceType), spec);
}

/** A compile-time number as the reference holds it: its Java class, and its value — EXACT (`int`) for
 *  an integral class or a BigDecimal's integer part, a double (`real`) otherwise. */
interface JavaNumber { readonly cls: 'Byte' | 'Short' | 'Integer' | 'Long' | 'BigInteger' | 'Float' | 'Double' | 'BigDecimal'; readonly real: number; readonly int?: bigint; readonly decimal?: string }
const CLASS_NAME: Readonly<Record<string, JavaNumber['cls']>> = {
  byte: 'Byte', short: 'Short', int: 'Integer', long: 'Long', bigint: 'BigInteger', float: 'Float', double: 'Double', bigdecimal: 'BigDecimal',
};
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const FLOAT_MAX = 3.4028234663852886e38;
const FLOAT_MIN_NORMAL = 1.1754943508222875e-38;
const integralClass = (n: bigint): JavaNumber['cls'] =>
  n >= -2147483648n && n <= 2147483647n ? 'Integer' : n >= LONG_MIN && n <= LONG_MAX ? 'Long' : 'BigInteger';
/** The integer part of a plain decimal string, exactly (`BigDecimal.setScale(0, DOWN)`). */
const truncatedDecimal = (text: string): bigint => BigInt(text.split('.')[0]!.replace(/^([-+]?)$/, '$10'));

/** `v` as the reference's `Number`: a literal's declared class, else its value's own shape; a String is
 *  PARSED as `NumberUtils.createNumber` does for the forms a number spells (an integer → the narrowest of
 *  Integer/Long/BigInteger; a decimal → a Float when the Float prints as the Double does, else a Double),
 *  and an unparseable one raises (`AsNumberStep.parseNumber`). */
function javaNumber(v: any, sourceType: string | null): JavaNumber {
  if (v instanceof BigDecimal) {
    const decimal = v.toString();
    return { cls: 'BigDecimal', real: Number(decimal), int: truncatedDecimal(decimal), decimal };
  }
  if (typeof v === 'bigint') return { cls: CLASS_NAME[sourceType ?? ''] ?? integralClass(v), real: Number(v), int: v };
  if (typeof v === 'number') {
    // An UNDECLARED JS number is classed by the ONE untyped-number authority (`numberClassOf`), exactly as
    // the reference GLV serializes it
    // (`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/NumberSerializationStrategy.js:77-95`):
    // a whole number past 2^53 and a negative zero are a Double — never a Long/BigInteger/Integer — so a
    // Double source returns as is and an overflow names `Double`
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:770,782`).
    const cls = CLASS_NAME[sourceType ?? ''] ?? CLASS_NAME[numberClassOf(v)]!;
    return cls === 'Float' || cls === 'Double' ? { cls, real: v } : { cls, real: v, int: BigInt(Math.trunc(v)) };
  }
  if (typeof v === 'string') return createNumber(v);
  throw new ValueParseError(`Can't parse type ${javaTypeName(v)} as number.`);
}

// ---------- `AsNumberStep.parseNumber`: `isCreatable` then `createNumber` ----------
//
// `parseNumber` is `NumberUtils.isCreatable(s.trim())` → `NumberUtils.createNumber(s.trim())`, else
// `Can't parse string '…' as number.`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/AsNumberStep.java:103-107`;
// commons-lang3 at the version `vendor/tinkerpop/pom.xml` pins, `commons.lang3.version` 3.20.0). JS's
// `Number()` is NOT that parse: it reads '0b101'/'0o17'/'Infinity' and '0123e2' (all refused by
// `isCreatable`), reads '010' as ten (octal eight), and cannot say WHICH class a hex spelling is. So the
// grammar is ported, and only a decimal's VALUE is read through `Number()` (the forms that reach it are
// exactly `Double.valueOf`'s).

const isSign = (c: string | undefined): boolean => c === '-' || c === '+';
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** `NumberUtils.isCreatable`, ported line for line. */
function isCreatable(str: string): boolean {
  if (str === '') return false;
  const chars = str;
  let sz = chars.length;
  let hasExp = false, hasDecPoint = false, allowSigns = false, foundDigit = false;
  const start = isSign(chars[0]) ? 1 : 0;
  if (sz > start + 1 && chars[start] === '0' && !str.includes('.')) {
    if (chars[start + 1] === 'x' || chars[start + 1] === 'X') {
      if (start + 2 === sz) return false;
      return /^[0-9a-fA-F]+$/.test(chars.slice(start + 2));
    }
    if (isDigit(chars[start + 1])) return /^[0-7]+$/.test(chars.slice(start + 1));
  }
  sz--;
  let i = start;
  while (i < sz || (i < sz + 1 && allowSigns && !foundDigit)) {
    const c = chars[i]!;
    if (isDigit(c)) { foundDigit = true; allowSigns = false; }
    else if (c === '.') { if (hasDecPoint || hasExp) return false; hasDecPoint = true; }
    else if (c === 'e' || c === 'E') { if (hasExp || !foundDigit) return false; hasExp = true; allowSigns = true; }
    else if (isSign(c)) { if (!allowSigns) return false; allowSigns = false; foundDigit = false; }
    else return false;
    i++;
  }
  if (i < chars.length) {
    const c = chars[i]!;
    if (isDigit(c)) return true;
    if (c === 'e' || c === 'E') return false;
    if (c === '.') return hasDecPoint || hasExp ? false : foundDigit;
    if (!allowSigns && (c === 'd' || c === 'D' || c === 'f' || c === 'F')) return foundDigit;
    if (c === 'l' || c === 'L') return foundDigit && !hasExp && !hasDecPoint;
    return false;
  }
  return !allowSigns && foundDigit;
}

/** `Integer.decode` → `Long.decode` → `createBigInteger`: an integral spelling's value, by its radix
 *  prefix (`0x`/`0X` hex, a leading `0` octal), and the narrowest class that holds it. */
function decodeIntegral(t: string): bigint {
  const neg = t[0] === '-';
  const body = isSign(t[0]) ? t.slice(1) : t;
  const magnitude = /^0[xX]/.test(body) ? BigInt(`0x${body.slice(2)}`)
    : body.length > 1 && body[0] === '0' ? BigInt(`0o${body.slice(1)}`)
    : BigInt(body);
  return neg ? -magnitude : magnitude;
}

/** `NumberUtils.createNumber` over a string `isCreatable` admitted (`AsNumberStep.parseNumber`). */
function createNumber(v: string): JavaNumber {
  const t = v.trim();
  if (!isCreatable(t)) throw new ValueParseError(`Can't parse string '${v}' as number.`);
  const offset = isSign(t[0]) ? 1 : 0;
  // HEX: the class is decided by the count of SIGNIFICANT hex digits, not by the value — `-0x80000000`
  // is a Long although an Integer holds it (`createNumber`'s hex branch). (`#` cannot pass `isCreatable`.)
  if (t.startsWith('0x', offset) || t.startsWith('0X', offset)) {
    const significant = t.slice(offset + 2).replace(/^0+/, '');
    const first = significant[0] ?? '0';
    const n = decodeIntegral(t);
    const cls: JavaNumber['cls'] = significant.length > 16 || (significant.length === 16 && first > '7') ? 'BigInteger'
      : significant.length > 8 || (significant.length === 8 && first > '7') ? 'Long' : 'Integer';
    return { cls, real: Number(n), int: n };
  }
  // A trailing type qualifier (`5L`, `1.5f`, `2d`) REQUESTS a class — a Long, or a Float/Double/BigDecimal
  // chosen by precision. Not learned yet: decline rather than answer a class the qualifier did not ask for.
  const last = t[t.length - 1]!;
  if (!isDigit(last) && last !== '.') throw new CoercionDeferral(`asNumber() of a type-qualified numeric string ('${t}')`);
  // No '.' and no exponent: `createInteger` → `createLong` → `createBigInteger`, each `decode`-ing the
  // radix prefix — so the class is the narrowest that holds the VALUE.
  if (!/[.eE]/.test(t)) { const n = decodeIntegral(t); return { cls: integralClass(n), real: Number(n), int: n }; }
  // `createNumber`'s DECIMAL ladder, rung for rung — Float, then Double, then BigDecimal:
  //   f = createFloat(s); d = createDouble(s)
  //   if (!f.isInfinite() && !(f == 0 && !isZero) && f.toString().equals(d.toString())) return f;
  //   if (!d.isInfinite() && !(d == 0 && !isZero)) { b = createBigDecimal(s); return b.compareTo(BigDecimal.valueOf(d)) == 0 ? d : b; }
  //   return createBigDecimal(s);
  // So '1.5'/'0.1'/'5.' are FLOATS (each prints the same as a float and as a double), '0.123456789' a
  // Double, and a decimal a double cannot hold exactly ('9007199254740993.0') the exact BigDecimal.
  const d = Number(t);
  // A Double that underflows to zero from a non-zero mantissa: whether `createNumber` lands on its
  // BigDecimal hangs on its `isZero` reading of the mantissa — decline rather than answer 0.0 for '1e-400'.
  if (d === 0 && /[1-9]/.test(t.split(/[eE]/)[0]!)) throw new CoercionDeferral(`asNumber() of a decimal string past Double's precision ('${t}')`);
  // `f.toString().equals(d.toString())`: a normal float (or zero) whose shortest digits are the double's —
  // i.e. `d` already IS its Float carrier (`floatCanonical`).
  const normal = d === 0 || (Number.isFinite(Math.fround(d)) && Math.abs(d) >= FLOAT_MIN_NORMAL);
  if (normal && floatCanonical(d) === d) return { cls: 'Float', real: d };
  const exact = decimalOf(t);
  if (Number.isFinite(d) && exact !== null && decimalCompare(exact, decimalOf(doubleText(d))!) === 0) return { cls: 'Double', real: d };
  // The exact BigDecimal: carried as its canonical plain TEXT (`BigDecimal.toString` for a non-negative
  // scale). A negative scale ('1e400' is unscaled 1, scale -400) has no plain spelling that keeps it.
  if (exact === null || exact.scale < 0) throw new CoercionDeferral(`asNumber() of a decimal string whose BigDecimal has no plain form ('${t}')`);
  const decimal = exact.toString();
  return { cls: 'BigDecimal', real: d, int: truncatedDecimal(decimal), decimal };
}

/**
 * `Double.toString(d)` — the SHORTEST digits that read back as the value (JS's own number spelling), laid
 * out as Java lays them out — PLAIN for a magnitude in [10^-3, 10^7), always with a fractional digit
 * (`1.0`), and computerized scientific notation outside it (`1.0E10`, `1.0E-5`). A Float prints as the
 * Double it rides as.
 */
export const javaFloatingString = (d: number): string => javaNumberText(d);

const exactInteger = (n: bigint): number | bigint => (n >= -(2n ** 53n) + 1n && n <= 2n ** 53n - 1n ? Number(n) : n);

/** `Number.longValue` the way `NumberHelper.longValue` guards it
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:771-805`). */
function longValue(a: JavaNumber, target: string): bigint {
  const overflow = `Can't convert number of type ${a.cls} to ${target} due to overflow.`;
  if (a.int === undefined) {
    if (Number.isNaN(a.real)) throw new ValueParseError(`Can't convert NaN to ${target}.`);
    if (!Number.isFinite(a.real)) throw new ValueParseError(`Can't convert floating point infinity to ${target}.`);
    if (a.real > 2 ** 63) throw new ValueParseError(overflow);
    if (a.real < -(2 ** 63)) throw new ValueParseError(`Can't convert number of type ${a.cls} to ${target} due to underflow.`);
    // `num.longValue()` SATURATES, so exactly 2^63 (which passes the `>` test) is Long.MAX_VALUE.
    const t = BigInt(Math.trunc(a.real));
    return t > LONG_MAX ? LONG_MAX : t;
  }
  if (a.int < LONG_MIN || a.int > LONG_MAX) throw new ValueParseError(overflow);
  return a.int;
}

/** `NumberHelper.performConversion`, over a compile-time number
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:724-770`). */
function performConversion(a: JavaNumber, spec: NonNullable<ReturnType<typeof numericSpec>>): number | bigint | BigDecimal {
  const overflow = (): never => { throw new ValueParseError(`Can't convert number of type ${a.cls} to ${spec.disp} due to overflow.`); };
  // A source already of the target class is returned AS IS.
  if (a.cls === spec.disp) {
    if (a.cls === 'BigDecimal') return a.decimal !== undefined ? BigDecimal.fromText(a.decimal) : a.real;
    return a.int !== undefined && a.cls !== 'Float' && a.cls !== 'Double' ? exactInteger(a.int) : a.real;
  }
  if (spec.as === 'bigdecimal') {
    // `bigDecimalValue` of a non-finite Double/Float is `BigDecimal.valueOf`/`new BigDecimal(toString)`,
    // a NumberFormatException (`NumberHelper.java` bigDecimalValue); its text is not ours to reproduce.
    if (!Number.isFinite(a.real) && a.decimal === undefined && a.int === undefined) throw new CoercionDeferral('asNumber(BIGDECIMAL) of a non-finite number');
    // The exact decimal carrier for a wide integral source is a different encoding; decline it.
    if (a.int !== undefined && a.decimal === undefined && exactInteger(a.int) !== Number(a.int)) throw new CoercionDeferral('asNumber(BIGDECIMAL) of a wide integer');
    // `bigDecimalValue` widens a Float or Double through `BigDecimal.valueOf` (`Double.toString`) — the
    // PRINTED decimal, not the exact value — held as an exact BigDecimal carrier.
    // A widening of scale ≤ 0 (an integral magnitude at or past 10^7, which `Double.toString` writes in
    // E-notation) has no plain decimal TEXT to ride as, so it rides as the number itself — the run-time
    // widening's carrier for the same value (`doubleDecimalText`, `src/compiler/rel/float.ts`) — which the
    // ONE carrier authority reads back (`bigDecimalOfCarrier`): a whole number below 10^21 is scale 0, a
    // REAL past it `BigDecimal.valueOf`'s own. A NEGATIVE scale below 10^21 (`1.0E7` is (10, −6)) has no
    // carrier the framer can tell from an integral source's scale-0 INTEGER, so it declines.
    if (a.cls === 'Float' || a.cls === 'Double') {
      const decimal = floatingDecimal(a.real);
      if (decimal === null) throw new CoercionDeferral('asNumber(BIGDECIMAL) of a NaN or an infinity');
      if (decimal.scale > 0) return decimal;
      if (decimal.scale < 0 && Math.abs(a.real) < 1e21) throw new CoercionDeferral('asNumber(BIGDECIMAL) of a whole Double whose BigDecimal has a negative scale');
      return a.real;
    }
    // An integral source is `BigDecimal.valueOf(long)`, scale 0 — the INTEGER carrier (`constLit`).
    return a.real;
  }
  if (spec.as === 'long') return exactInteger(longValue(a, spec.disp));
  if (spec.int && spec.min !== undefined) {
    const n = longValue(a, spec.disp);
    if (n < BigInt(spec.min) || n > BigInt(spec.max!)) overflow();
    return Number(n);
  }
  if (spec.as === 'bigint') {
    // `bigIntegerValue`: a floating value (a Float rides as a Double) through its `toString` digits.
    if (a.int !== undefined) return exactInteger(a.int);
    if (!Number.isFinite(a.real)) throw new CoercionDeferral('asNumber(BIGINT) of a non-finite number');
    // `BigDecimal.valueOf(d)` reads `Double.toString(d)`: the shortest digits, not the exact binary value.
    const [mantissa, exponent] = a.real.toExponential().split('e') as [string, string];
    const digits = mantissa.replace('.', '');
    const scale = Number(exponent) - (digits.replace('-', '').length - 1);
    return exactInteger(scale >= 0 ? BigInt(digits) * 10n ** BigInt(scale) : truncatedDecimal(
      `${digits.startsWith('-') ? '-' : ''}${digits.replace('-', '').padStart(-scale + 1, '0').slice(0, scale)}`));
  }
  if (spec.as === 'float') {
    if (Number.isFinite(a.real) && Math.abs(a.real) > FLOAT_MAX) overflow();
    // A Float lands on its carrier (`floatCanonical`); the wire framer rounds it to float32.
    return floatCanonical(a.real);
  }
  // double
  if (a.int === undefined && !Number.isFinite(a.real)) return a.real;
  if (!Number.isFinite(a.real)) overflow();
  return a.real;
}

/** asNumber(GType.X) over a runtime scalar: a SQL CAST to the target's storage class
 *  (integer targets truncate; float/double stay real). BigDecimal keeps the value
 *  unchanged — it is framed from its canonical TEXT by the BigDecimal serializer, so a
 *  REAL cast would only risk formatting artifacts; the `as:'bigdecimal'` tag drives
 *  framing. Overflow isn't range-checked (unreachable for the runtime inputs the suite
 *  exercises). */
export const asNumberSql = (spec: { int: boolean; as: ValueType }, e: Expression): Expression =>
  spec.as === 'bigdecimal' ? e : spec.int ? q`CAST(${e} AS INTEGER)` : q`CAST(${e} AS REAL)`;

/** Bare asNumber() over a constant: the output subtype is the INPUT literal's declared
 *  type (`subtype`, from the arg's `Arg.type`) — 5b→byte, 5l→long, 5.0→double, 5.75f→float.
 *  A numeric string parses to int/double by value; a non-numeric string / non-number
 *  throws. Returns the numeric value + its framing tag. */
export function asNumberBare(v: any, subtype: string | null): { val: any; as: ValueType } {
  // A bigdecimal input keeps its exact carrier (a BigDecimal instance / decimal text) —
  // framed via the BigDecimal serializer's canonical text, no lossy numeric coercion.
  if (subtype === 'bigdecimal') return { val: v, as: 'bigdecimal' };
  // A Number is returned UNCHANGED (`AsNumberStep.map`), so a wide integral keeps every digit.
  if (typeof v === 'bigint') return { val: exactInteger(v), as: (subtype ?? (v >= LONG_MIN && v <= LONG_MAX ? 'long' : 'bigint')) as ValueType };
  // An untagged JS number is the class `numberClassOf` (the ONE untyped-number authority) gives it: a whole
  // number past 2^53 or a negative zero is a Double — never a Long that cannot hold it (past 2^63 the Long
  // framer raised an internal RangeError) nor an Integer that drops the sign.
  if (typeof v === 'number') return { val: v, as: (subtype ?? numberClassOf(v)) as ValueType };
  if (typeof v === 'string') {
    // `javaNumber` is the ONE parse (`createNumber`, above — the typed `asNumber(GType)` fold reads the
    // same), so the two cannot disagree on a class. An integral spelling — decimal, octal or HEX — is
    // the Integer → Long → BigInteger ladder, held EXACTLY: read through a double, '9007199254740993'
    // lost its last digit, and '2147483648' / '0x80000000' were tagged an Integer the GraphBinary Int
    // writer cannot frame — an internal RangeError at the user.
    const n = javaNumber(v, null);
    if (n.int !== undefined && n.decimal === undefined) return { val: exactInteger(n.int), as: n.cls === 'Integer' ? 'int' : n.cls === 'Long' ? 'long' : 'bigint' };
    // A decimal is `createNumber`'s class EXACTLY (§6·7: the class is exact) — a Float, a Double, or the
    // BigDecimal carried as its canonical TEXT.
    if (n.cls === 'BigDecimal') return { val: BigDecimal.fromText(n.decimal!), as: 'bigdecimal' };
    return { val: n.real, as: n.cls === 'Float' ? 'float' : 'double' };
  }
  throw new ValueParseError(`Can't parse type ${v === null || v === undefined ? 'null' : javaTypeName(v)} as number.`);
}

/** The Java simple class name of each Gremlin type a STORED value carries that `AsNumberStep.map` neither
 *  parses (a String) nor returns as-is (a Number) nor converts (a Date) — so it raises `Can't parse type
 *  <name> as number.` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/AsNumberStep.java:55-71`). */
export const UNPARSEABLE_TAGS: Readonly<Record<string, string>> = { boolean: 'Boolean', duration: 'Duration', uuid: 'UUID', char: 'Character' };

/**
 * Bare `asNumber()` over a RUN-TIME value whose Gremlin TYPE rides beside it (a stored `vtype`, a branch's
 * arm tag). The value arrives in its STORAGE class — a Boolean as 0/1, a Date as epoch millis, a UUID as
 * text — so `asNumberBare` alone would answer `1` for `true` and parse a UUID as a string. The tag decides
 * first: a Boolean/Duration/UUID/Character raises the reference's message, a Date is its epoch millis
 * (`toInstant().toEpochMilli()`, which IS the stored value), and everything else is `asNumberBare`.
 */
export function asNumberTagged(v: unknown, tag: string | null | undefined): { val: any; as: ValueType } {
  if (v === null || v === undefined || !tag) return asNumberBare(v, null);
  const javaName = UNPARSEABLE_TAGS[tag];
  if (javaName) throw new ValueParseError(`Can't parse type ${javaName} as number.`);
  // A Date is `getTime()` — its epoch-millis LONG (`AsNumberStep.java:62-65`), at the root as at any depth.
  if (tag === 'datetime') return { val: v instanceof Date ? v.getTime() : Number(v), as: 'long' };
  // A Number keeps its OWN class (`AsNumberStep.map` returns it as is), so a numeric tag IS the subtype:
  // a Double stored whole (the INTEGER 1) stays the Double 1.0.
  return asNumberBare(v, NUMBER_TAGS.has(tag) ? tag : null);
}

/** The Gremlin number classes, by tag. */
const NUMBER_TAGS: ReadonlySet<string> = new Set(['byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal']);

// ---------- date casts (asDate / dateAdd / dateDiff) ----------
//
// Internal datetime = epoch-millis (INTEGER); the 'date' shape tag frames it back to a
// JS Date (execute.ts frameValue). second/minute/hour/day are fixed-width, so date
// arithmetic is pure integer — no SQLite date functions needed for datetime literals;
// only a runtime ISO-string asDate() calls unixepoch(). All GraphBinary offsets fold
// into the instant, so only the instant is carried (matching the client's UTC wire).
const DT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

/** dateAdd's DT unit token → its millisecond factor. */
export function dtFactor(arg: any): number {
  const u = isDtArg(arg) ? arg.dt : null;
  const f = u ? DT_MS[u] : undefined;
  if (!f) throw new ValueParseError(`dateAdd() requires a DT unit (second/minute/hour/day), got ${u ?? arg}`);
  return f;
}

/**
 * THE decode of `dateAdd(DT, n)`'s millisecond delta — every dateAdd lowering (the constant fold and the
 * per-row transform) reads it, so neither re-derives it with a lossy `Number()`. The reference's count is
 * a Java `int` (`DateAddStep(…, final DT dateToken, final int value)`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/DateAddStep.java:45`):
 * a literal past it is narrowed with a wrap-around this engine does not model, so it DECLINES. So does a
 * delta past 2^53 ms (`Integer.MAX_VALUE` days is ~1.9e17): JS arithmetic is no longer exact there, and
 * every instant it could reach is outside what a date frames anyway (`dateOfMillis`).
 */
export function dateAddDeltaMs(unit: unknown, count: unknown): number {
  const factor = dtFactor(unit);
  const n = typeof count === 'bigint' ? count : typeof count === 'number' && Number.isInteger(count) ? BigInt(count) : null;
  if (n === null || n < -(2n ** 31n) || n >= 2n ** 31n) throw new UnsupportedTraversal('dateAdd() with a count past a 32-bit int');
  const delta = n * BigInt(factor);
  if (delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsupportedTraversal('dateAdd() past the instants a date carries');
  }
  return Number(delta);
}

/**
 * An epoch-millisecond instant as the JS `Date` every date serializer takes — THE one decode, so no
 * framer meets an `Invalid Date` (whose serialization leaked a raw `RangeError: Not an integer`). A JS
 * `Date` spans ±8.64e15 ms (~±275,000 years); a Java `OffsetDateTime` spans ±999,999,999 years, so an
 * instant between the two is one the reference answers and this engine cannot frame — a DECLINE, not an
 * error the reference would raise.
 */
export function dateOfMillis(ms: unknown): Date {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) throw UnsupportedTraversal.because('a date outside ±8.64e15 ms of the epoch cannot be framed');
  return d;
}

/** asDate() over a compile-time constant → epoch-millis. An ISO-8601 string (offset
 *  folds into the instant) or an integer/long epoch; a float epoch, non-ISO string,
 *  list, or null raises TinkerPop's "Can't parse" (SQL can't raise it, and every
 *  reachable inject input is a literal). */
export function asDateConst(v: any, subtype: string | null): number {
  if (typeof v === 'number') {
    if (subtype === 'float' || subtype === 'double' || subtype === 'bigdecimal' || !Number.isInteger(v))
      throw new ValueParseError(`Can't parse ${v} as a Date: a floating-point epoch is not allowed.`);
    return v;
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const ms = parseIsoMs(v); // UTC-normalized so Bun and the DO agree on the instant
    if (Number.isNaN(ms)) throw new ValueParseError(`Can't parse '${v}' as an ISO-8601 Date.`);
    return ms;
  }
  // AsDateStep renders a non-scalar's class name (`AsDateStep.java:75` — `getClass().getName()`);
  // paraphrased to the simple name so a list reads `ArrayList` rather than `Object`.
  throw new ValueParseError(`Can't parse ${v === null || v === undefined ? 'null' : javaTypeName(v)} as a Date.`);
}

/** dateDiff's other operand in millis (result = self − other). A datetime literal
 *  (epoch-ms number) or a `constant(datetime|null)` nested traversal (null → epoch 0,
 *  = new Date(null)). A nested inject()/movement defers. */
export function dateDiffOtherMs(arg: any, params: Record<string, any>): number {
  if (typeof arg === 'number') return arg;
  if (isNested(arg)) {
    const inner = stepChain(arg.nested, params);
    if (inner.length === 1 && inner[0].name === 'constant') {
      const c = inner[0].args[0]?.value;
      return c === null || c === undefined ? 0 : Number(c);
    }
    throw new ValueParseError('dateDiff(): only a datetime literal or constant(datetime) argument is supported');
  }
  throw new ValueParseError('dateDiff() requires a datetime literal or constant(datetime) argument');
}

/** Whether dateDiff's nested operand is the constant form the fused transform can fold
 * without a child scope. Every other nested body belongs to the apply-contract seam. */
export const isDateDiffConstant = (arg: any, params: Record<string, any>): boolean =>
  isNested(arg) && (() => {
    const inner = stepChain(arg.nested, params);
    return inner.length === 1 && inner[0].name === 'constant';
  })();

/** asDate() over a runtime scalar → epoch-millis. An integer/real value is already
 *  millis; a text value is an ISO-8601 string (unixepoch resolves any offset into the
 *  instant; ×1000 → millis). */
export const asDateSql = (e: Expression): Expression =>
  q`(CASE WHEN typeof(${e}) IN ('integer', 'real') THEN CAST(${e} AS INTEGER) ELSE unixepoch(${e}) * 1000 END)`;

// ---------- what an inject() literal's DECLARED type says, per argument ----------
//
// A bare `inject(v1, v2, …)` (no leading coercion to retype the stream) carries only what the
// front-end captured on each argument. That fact is NOT derivable from the values: a `char`, a
// `uuid`, a `datetime` and a long past 2^53 all arrive as ordinary JS strings or numbers, so
// framing by inference reframes them as the wrong wire CLASS. Measured — before the RelIR seed
// used this, the census caught four corpus traversals (`inject("a"c)`, `inject(UUID(…))` and
// friends) with right arity, plausible rows, and the wrong GraphBinary type.
//
// PER ARGUMENT is the shape, and it is the whole of build plan §6·7's carrier: what arrives on the
// wire is CARRIED until something changes it, never re-guessed and never DISCARDED because
// modelling its carriage looked like work. The uniform reading is DERIVED below rather than
// computed separately — one authority, a coarse view over it, which is the `ScalarType` pattern
// (`docs/2026-07-28-scalartype-refactoring-pattern.md`).

/** Canonical types whose STORED form does not determine their Gremlin type, so JS-value inference
 *  would get them wrong. Two reasons, both needing the declared type: it rides as decimal/char
 *  TEXT (a long > 2^53 would frame as a string; bigdecimal/char/duration likewise), or it is
 *  storage-ambiguous with another type (a datetime is epoch-millis → Long, a uuid is TEXT →
 *  String, a boolean is the INTEGER `1`/`0` → Int — measured: an undeclared `inject(true)` framed as
 *  an Int on the wire, and `fold(true, Operator.and)` could not tell its members from integers). A
 *  `byte`/`short`/`float` is the same second case — an INTEGER or a REAL that inference reads as an
 *  `int`/`double` — and the difference is an ANSWER, not a label: `NumberHelper` folds a `float` in
 *  32-bit precision, so `fold(0, Operator.sum)` over an undeclared `0.1f, 0.2f` would add doubles.
 *  Everything else is recoverable from the value, so declaring it buys nothing. */
const DECLARED_TYPE_REQUIRED = new Set<CanonicalType>([
  'long', 'bigint', 'bigdecimal', 'char', 'duration', 'datetime', 'uuid', 'boolean', 'byte', 'short', 'float', 'double',
]);

/** The declared framing tag of EACH of a bare inject's first `count` arguments — `null` where the
 *  argument declared nothing, or declared a type inference already recovers, or declared a
 *  COLLECTION (a list/map/set is reached through the list substrate, never framed by a scalar tag,
 *  which is what `ValueType` excludes). */
export function injectValueTypes(steps: readonly Step[], count: number): (ValueType | null)[] {
  const args = steps[0].args;
  return Array.from({ length: count }, (_, i) => {
    const name = flatType(args[i]?.type);
    if (name && DECLARED_TYPE_REQUIRED.has(name)) return name as ValueType;
    // A WHOLE Double (`1.0`, `1.0d`) reads back from SQLite as a JS integer, which inference frames
    // as an Int — `Integer(1)` is not `Double(1.0)` (`AbstractTraverser.java:185-188`). Only a fractional
    // Double is recoverable from its value.
    return name === 'double' && Number.isInteger(args[i]?.value) ? 'double' : null;
  });
}

/** The UNIFORM reading of the above: one tag for the whole stream, or `undefined` where the
 *  arguments disagree (or none needed declaring). A coarse view, derived — a caller that can carry
 *  a heterogeneous stream should read `injectValueTypes` and project the tags PER ROW instead,
 *  which is strictly more information and the reason this is the derived half rather than the
 *  authority. */
export function uniformInjectType(steps: readonly Step[], count: number): ValueType | undefined {
  if (!count) return undefined;
  const tags = injectValueTypes(steps, count);
  return tags.every((t) => t !== null && t === tags[0]) ? tags[0]! : undefined;
}

// ---------- the LEADING coercion prefix: the fold that IS the parse ----------

/** The coercion steps that fold at COMPILE TIME when their input is still a JS constant. */
const CONST_COERCIONS = new Set(['asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);
/** Does `steps[at]` sit in an `inject()`'s LEADING coercion prefix — the run `foldConstantCoercions` folds
 *  at compile time while the values are still constants? */
export const inLeadingCoercionPrefix = (steps: readonly Step[], at: number): boolean =>
  steps[0]?.name === 'inject' && at >= 1 && steps.slice(1, at + 1).every((step) => CONST_COERCIONS.has(step.name));

/**
 * Apply the leading coercion prefix while the values are still JS constants, returning the index of
 * the first ordinary step (which enters the relational dispatcher) and the framing tag the fold
 * settled on. Later coercions remain normal scalar transforms, or fail closed there.
 *
 * **The fold IS the parse, and the parse RAISES TinkerPop's exact messages** (`Can't parse string
 * '1,000' as number.`, the per-type overflow wording). SQL cannot raise either, which is why this
 * happens at compile time and why it is one function: a second implementation is a second chance to
 * get an overflow boundary or a date format wrong.
 *
 * It MUTATES `vals`, and a caller whose contract is `null` must catch — a value that does not parse
 * throws from here, and that throw belongs to the caller that owns the message.
 *
 * Typed on `Step`, not the compiler's `IRStep`: the fold reads `name` and `args` only, so it stays
 * on the front-end side of the boundary with the coercion semantics it is made of.
 */
export function foldConstantCoercions(steps: readonly Step[], vals: any[]): { at: number; as?: ValueType; perRow?: (ValueType | null)[] } {
  let at = 1;
  let as: ValueType | undefined;
  // §6·7 — when a bare `asNumber()` coerces a stream of MIXED numeric subtypes, the whole stream cannot
  // share one static tag, so each value keeps its own (the per-row spelling). Set only by that arm; a
  // later uniform coercion (`asBool`/`asDate`/…) re-coerces every value and clears it.
  let perRow: (ValueType | null)[] | undefined;
  for (; at < steps.length && CONST_COERCIONS.has(steps[at].name); at++) {
    const step = steps[at];
    // Cleared each iteration: `perRow` is meaningful only when the asNumber-mixed arm is the LAST
    // coercion in the prefix — any following uniform coercion re-coerces every value and supersedes it.
    const previousRow = perRow;
    perRow = undefined;
    // A traversal date is an apply-style child value, not a constant coercion. Leave it
    // for the scalar dispatcher, which provisions the correlated child scope.
    if (step.name === 'dateDiff' && isNested(step.args[0]?.value) && !isDateDiffConstant(step.args[0]?.value, {})) break;
    if (step.name === 'asBool') {
      for (let i = 0; i < vals.length; i++) vals[i] = asBoolConst(vals[i]);
      as = 'boolean';
      continue;
    }
    if (step.name === 'asNumber') {
      const spec = numericSpec(step.args[0]?.value);
      if (spec) {
        // Each value's Java class is what the conversion and its message read: the literal's declared
        // type at the source, else the class the previous coercion left (a Date's epoch is a Long).
        const sourceType = (i: number): string | null =>
          at === 1 ? flatType(steps[0].args[i]?.type) : previousRow?.[i] ?? (as === 'datetime' ? 'long' : as ?? null);
        for (let i = 0; i < vals.length; i++) vals[i] = asNumberConst(vals[i], spec, sourceType(i));
        as = spec.as;
      } else {
        if (as === 'datetime') {
          as = 'long';
          continue;
        }
        const argTypes = at === 1 ? steps[0].args.map((a) => a.type) : [];
        const subtypes: (ValueType | null)[] = [];
        for (let i = 0; i < vals.length; i++) {
          // A null object stays null (`AsNumberStep.map` returns null before parsing), and contributes
          // no subtype to the uniform decision — it frames as null whatever tag the stream settles on.
          if (vals[i] === null || vals[i] === undefined) { subtypes.push(null); continue; }
          const out = asNumberTagged(vals[i], flatType(argTypes[i]));
          vals[i] = out.val;
          subtypes.push(out.as);
        }
        const nonNull = subtypes.filter((t): t is ValueType => t != null);
        // §6·7 — a UNIFORM subtype is one static tag; MIXED subtypes ride PER ROW, each value keeping
        // its own tag, rather than declining. A widening inside the Number family changes no answer
        // Gremlin can be asked (`GremlinValueComparator` treats every `Number` subclass as one type),
        // so carrying the per-row tag is exact and costs one column — never a discard, never a guess.
        if (nonNull.every((t) => t === (nonNull[0] ?? t))) { as = nonNull[0]; perRow = undefined; }
        else { as = undefined; perRow = subtypes; }
      }
      continue;
    }
    if (step.name === 'asDate') {
      const argTypes = at === 1 ? steps[0].args.map((a) => a.type) : [];
      for (let i = 0; i < vals.length; i++) vals[i] = asDateConst(vals[i], flatType(argTypes[i]));
      as = 'datetime';
      continue;
    }
    // `dateAdd`/`dateDiff` require an OffsetDateTime/Date SUBJECT and RAISE on anything else — a null,
    // an int, a string all throw (`DateAddStep.map`: *"dateAdd() accept only OffsetDateTime or Date
    // (deprecated)."*; `DateDiffStep` likewise on a non-date LEFT operand). SQL cannot raise, so the fold
    // must — computing `Number(v) ± delta` unconditionally treated a bare int as epoch millis and a null
    // as epoch 0, a required error becoming a plausible value. The subject is a datetime iff a prior
    // coercion produced one (`as === 'datetime'` — a leading `asDate`, or a preceding `dateAdd`) or the
    // SOURCE is a datetime literal (the first coercion over an `inject(datetime(…))`, whose args carry
    // `type: 'datetime'`). `dateDiff`'s result is a `long`, so a `dateAdd` chained after one correctly
    // falls to the raise.
    // PER VALUE: each traverser is a datetime or raises on its own (`inject(datetime(…), 'x')` raises on the
    // second, not the first), so the message names the value that offends.
    const datetimeSubject = (i: number): boolean => as === 'datetime' || (at === 1 && steps[0].args[i]?.type === 'datetime');
    if (step.name === 'dateAdd') {
      const delta = dateAddDeltaMs(step.args[0].value, step.args[1].value);
      for (let i = 0; i < vals.length; i++) {
        if (!datetimeSubject(i)) throw new ValueParseError('dateAdd() accept only OffsetDateTime or Date (deprecated).');
        vals[i] = Number(vals[i]) + delta;
      }
      as = 'datetime';
      continue;
    }
    const other = dateDiffOtherMs(step.args[0]?.value, {});
    for (let i = 0; i < vals.length; i++) {
      if (!datetimeSubject(i)) {
        const v = vals[i];
        throw new ValueParseError(`DateDiff can only take OffsetDateTime or Date (deprecated) as argument, encountered ${v === null || v === undefined ? 'null' : javaTypeName(v)}`);
      }
      vals[i] = Number(vals[i]) - other;
    }
    as = 'long';
  }
  return perRow ? { at, as, perRow } : { at, as };
}
