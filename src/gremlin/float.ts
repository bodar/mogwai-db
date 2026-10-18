import { BigDecimal } from './types.ts';
import { exactNumberOf, isExactNumber, parseExactJson, type ExactNumber } from '../json-exact.ts';
import { UnsupportedTraversal } from '../compiler/unsupported.ts';

/**
 * THE FLOAT AUTHORITY, compile-time half — what a Java `Float` IS, read from text or from a double.
 *
 * A Gremlin `Float` is carried as its EXACT value: the double `Math.fround` lands on, never the shorter
 * decimal it prints as (`0.1f` rides as 0.10000000149011612). That is the value `NumberHelper` computes
 * with — every compare, sum, `math()` and min/max widens a Float through `floatValue()`/`doubleValue()`,
 * both exact (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:225-275,670-681`)
 * — so a consumer that reads the carrier as a number reads the reference's number, at every depth, with
 * nothing to convert. Only the consumers that PRINT a Float (`Float.toString`: `asString`, a cast to
 * Double, a BigDecimal widening) need its shortest decimal, and they derive it (`floatText`). Carrying the
 * shortest decimal instead made `inject(0.1f).is(0.1d)` true where the reference widens 0.1f to
 * 0.10000000149011612 and answers false. The run-time half is `src/compiler/rel/float.ts`.
 */

/** `new BigDecimal(s)` over a decimal spelling (sign, digits, optional '.', optional exponent): its
 *  unscaled value and scale, exactly. `null` for anything else. */
export function decimalOf(s: string): BigDecimal | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const fraction = m[3] ?? '';
  const unscaled = BigInt(`${m[1] === '-' ? '-' : ''}${m[2]}${fraction}` || '0');
  return new BigDecimal(unscaled, fraction.length - Number(m[4] ?? 0));
}

/** `BigDecimal.compareTo` — by value, never by scale. */
export function decimalCompare(a: BigDecimal, b: BigDecimal): number {
  const scale = Math.max(a.scale, b.scale);
  const x = a.unscaled * 10n ** BigInt(scale - a.scale);
  const y = b.unscaled * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A finite double's EXACT binary value as a decimal — `new BigDecimal(double)`, not `BigDecimal.valueOf`. */
export function exactDecimalOf(d: number): BigDecimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  // d = mantissa · 2^exponent
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  const signed = negative ? -mantissa : mantissa;
  // 2^-k = 5^k / 10^k, so a negative exponent is an exact decimal of scale k.
  return exponent >= 0 ? new BigDecimal(signed << BigInt(exponent), 0) : new BigDecimal(signed * 5n ** BigInt(-exponent), -exponent);
}

/**
 * `Float.parseFloat(text)` — the decimal rounded ONCE to a float. `Math.fround(Number(text))` rounds it
 * twice, and the two differ exactly when the double lands on the MIDPOINT of two floats without being the
 * decimal itself; there the exact decimal decides which side it lies on. A decimal that IS the midpoint is
 * a true tie, which `Math.fround` already breaks half-even, as Java does.
 */
export function javaFloatOf(text: string): number {
  const d = Number(text);
  const f = Math.fround(d);
  if (f === d || !Number.isFinite(f) || !Number.isFinite(d)) return f;
  const other = 2 * d - f;
  if (Math.fround(other) !== other || (f + other) / 2 !== d) return f;
  const exact = decimalOf(text);
  const side = exact === null ? 0 : decimalCompare(exact, exactDecimalOf(d));
  return side === 0 ? f : side > 0 ? Math.max(f, other) : Math.min(f, other);
}

/**
 * `Float.toString`'s digits — the shortest decimal that reads back as the same float, and of those the
 * one CLOSEST to the float's exact value, an exact tie going to the EVEN last digit (`1.00390625f` is
 * `1.0039062`). So the exact value is rounded half-even at each precision; `toPrecision` cannot stand in,
 * because it breaks a tie upward.
 *
 * AT LEAST TWO DIGITS: where one digit already reads back, Java picks the closest decimal of length ONE OR
 * TWO (`Float.toString`/`Double.toString` javadoc, JDK 19+: "when m ≥ 2 let T be the decimals in R of
 * length m; otherwise let T be the decimals in R of length 1 or 2"). A normal float's rounding interval is
 * far narrower than a two-digit step, so this only changes a SUBNORMAL — `Float.MIN_VALUE` is `1.4E-45`,
 * not `1E-45`, and 2·MIN is `2.8E-45`, not `3E-45`. Starting the search at two digits IS that rule: the
 * closest two-digit decimal is at least as close as any one-digit one, and lies inside the interval.
 */
export function floatText(f: number): string {
  if (!Number.isFinite(f) || f === 0) return String(f);
  const exact = exactDecimalOf(f);
  const negative = exact.unscaled < 0n;
  const digits = (negative ? -exact.unscaled : exact.unscaled).toString();
  for (let p = 2; p <= 9; p++) {
    let keep = digits.slice(0, p);
    const rest = digits.slice(p);
    if (rest !== '') {
      const tail = rest.slice(1);
      const up = rest[0]! > '5' || (rest[0] === '5' && (/[1-9]/.test(tail) || Number(keep.at(-1)) % 2 === 1));
      if (up) keep = (BigInt(keep) + 1n).toString();
    }
    // `keep` stands for the first min(p, length) digits (a carry adds a digit, not a place).
    const candidate = Number(`${negative ? '-' : ''}${keep}e${digits.length - Math.min(p, digits.length) - exact.scale}`);
    if (Math.fround(candidate) === f) return String(candidate);
  }
  return String(f);
}

/** `Double.toString`'s digits as a JS number spelling — JS's own shortest-closest digits, under Java's
 *  two-digit minimum (`floatText` states the rule): only a SUBNORMAL double prints differently,
 *  `Double.MIN_VALUE` is `4.9E-324` where JS says `5e-324`. Returned as TEXT, because the two-digit
 *  spelling of such a double reads back as the SAME double and `String` would undo it. */
export function doubleText(d: number): string {
  const text = String(d);
  if (!Number.isFinite(d) || d === 0) return text;
  const significant = text.replace(/^-/, '').split(/e/i)[0]!.replace('.', '').replace(/^0+/, '');
  if (significant.length !== 1) return text;
  const two = d.toPrecision(2);
  return Number(two) === d ? two : text;
}

/**
 * `Float.toString(f)` (with `float`) or `Double.toString(d)` — the printing authority. The digits are
 * `floatText`/`doubleText`'s; the LAYOUT is Java's: PLAIN for a magnitude in [10^-3, 10^7), always with a
 * fractional digit (`1.0`), and computerized scientific notation outside it (`1.0E10`, `1.4E-45`).
 */
export function javaNumberText(d: number, float = false): string {
  if (Number.isNaN(d)) return 'NaN';
  const value = float ? Math.fround(d) : d;
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (value === 0) return '0.0';
  const decimal = decimalOf(float ? floatText(value) : doubleText(value))!;
  const negative = decimal.unscaled < 0n;
  let digits = (negative ? -decimal.unscaled : decimal.unscaled).toString();
  let scale = decimal.scale;
  while (digits.length > 1 && digits.endsWith('0')) { digits = digits.slice(0, -1); scale--; }
  // value = d.ddd × 10^exponent
  const exponent = digits.length - 1 - scale;
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
      body = `${whole}.${digits.slice(exponent + 1) || '0'}`;
    } else body = `0.${'0'.repeat(-exponent - 1)}${digits}`;
  } else body = `${digits[0]}.${digits.slice(1) || '0'}E${exponent}`;
  return negative ? `-${body}` : body;
}

/** `new BigDecimal(Float.toString(f))` / `BigDecimal.valueOf(d)` — a floating Number's BigDecimal
 *  widening (`NumberHelper.bigDecimalValue`,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-857`):
 *  the PRINTED decimal, never the exact binary value. `null` for a NaN or an infinity, which Java's
 *  `BigDecimal` cannot hold (`NumberFormatException`). */
export function floatingDecimal(d: number, float = false): BigDecimal | null {
  return Number.isFinite(d) ? decimalOf(javaNumberText(d, float)) : null;
}

/**
 * THE BIGDECIMAL CARRIER AUTHORITY — which `BigDecimal` a carried value IS, read once for every reader that
 * needs its SCALE (the wire framer at every depth, `asString()`'s printer). A BigDecimal rides in one of
 * three carriers, and each one fixes the scale on its own (`NumberHelper.bigDecimalValue`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-859`):
 *
 * - **decimal TEXT** (a JS string — a literal, a stored value, a floating widening of positive scale): the
 *   text IS `new BigDecimal(text)`, scale and all.
 * - **INTEGER** (a whole JS number, or an integral JSON spelling inside a list): an integral source's
 *   `BigDecimal.valueOf(long)`, scale 0.
 * - **REAL** (a whole Double the widening could not spell as plain text, `doubleDecimalText` — at or past
 *   10^7; inside a list, SQLite's JSON spells it with a point or exponent, `parseExactJson` keeps it raw):
 *   `BigDecimal.valueOf(double)`, i.e. `Double.toString`'s spelling, so `1.0E7` is (10, −6) and `1.0E21`
 *   (10, −20).
 *
 * A bare whole JS number below 10^21 is read as the INTEGER carrier. A scalar framer, where SQLite hands a
 * REAL back as that same JS number, receives a REAL BigDecimal as the one-member JSON array of its raw
 * spelling instead (`[10000000.0]`, `scalarFramedValue`), so the two cannot be confused there.
 */
export function bigDecimalOfCarrier(v: BigDecimal | string | bigint | number | ExactNumber): BigDecimal {
  if (v instanceof BigDecimal) return v;
  if (typeof v === 'bigint') return new BigDecimal(v, 0);
  // A REAL handed to a SCALAR framer crosses as the one-member JSON array of its raw spelling (`[1.0E7]`,
  // `scalarPayload`), since a bare REAL there is the same JS number an INTEGER is; decimal TEXT never opens
  // with a bracket.
  if (typeof v === 'string' && v.startsWith('[')) return bigDecimalOfCarrier((parseExactJson(v) as [number | ExactNumber])[0]);
  if (typeof v === 'string') return BigDecimal.fromText(v);
  if (isExactNumber(v)) {
    const { integral, text } = exactNumberOf(v);
    return integral ? new BigDecimal(BigInt(text), 0) : realDecimal(Number(text));
  }
  return Number.isInteger(v) && Math.abs(v) < 1e21 ? new BigDecimal(BigInt(v), 0) : realDecimal(v);
}

const realDecimal = (d: number): BigDecimal => {
  const decimal = floatingDecimal(d);
  // `BigDecimal.valueOf(±∞)` is the reference's NumberFormatException: a clear decline, never a bare Error.
  if (decimal === null) throw UnsupportedTraversal.because(`a non-finite number (${d}) cannot be framed as a BigDecimal`);
  return decimal;
};

/** The float (`bits` 32) or double (64) adjacent to a FINITE `x` on each side — `Math.nextDown`/`nextUp`. */
export function adjacent(x: number, bits: 32 | 64): readonly [number, number] {
  const step = (v: number, up: boolean): number => {
    if (v === 0) {
      const tiny = bits === 32 ? 1.401298464324817e-45 : Number.MIN_VALUE;
      return up ? tiny : -tiny;
    }
    if (bits === 32) {
      const view = new DataView(new ArrayBuffer(4));
      view.setFloat32(0, v);
      const raw = view.getInt32(0);
      view.setInt32(0, (v > 0) === up ? raw + 1 : raw - 1);
      return view.getFloat32(0);
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    const raw = view.getBigInt64(0);
    view.setBigInt64(0, (v > 0) === up ? raw + 1n : raw - 1n);
    return view.getFloat64(0);
  };
  return [step(x, false), step(x, true)];
}
