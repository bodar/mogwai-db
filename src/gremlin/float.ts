import { BigDecimal, type TypeNode } from './types.ts';
import { exactNumberOf, isExactNumber, type ExactNumber } from '../json-exact.ts';
import { UnsupportedTraversal } from '../compiler/unsupported.ts';

/**
 * Floating-number spelling, compile-time. A Gremlin `Float` rides as a Double (`floatCanonical`) and is
 * rounded to float32 only by the wire framer, so every reader here treats it as a Double — a deliberate
 * divergence from Java's float arithmetic (`docs/feature-support-matrix.md`).
 */

/**
 * THE FLOAT CARRIER — the one value every Float PRODUCER lands on (a literal, a wire parameter, CSV,
 * GraphSON, a federated sibling, `asNumber(GType.FLOAT)` at compile time), so a Float equals itself
 * whichever way it arrived: the Double of its SHORTEST float32 decimal (`Float.toString`'s digits). `0.1f`,
 * a GLV's float32 `0.10000000149011612` and a CSV `0.1` are all the REAL 0.1; `0.123456789f` is 0.12345679
 * — the value the wire framer's `Math.fround` frames each of them as. A value past Float's range (or not
 * finite) is left as it is.
 */
export function floatCanonical(x: number): number {
  const f = Math.fround(x);
  if (f === 0) return 0;
  if (!Number.isFinite(f)) return x;
  // Under `Float.toString`'s two-digit minimum, as `doubleText`'s: `Float.MIN_VALUE` is 1.4e-45, not 1e-45.
  for (let k = 2; k < 9; k++) {
    const c = Number(f.toPrecision(k));
    if (Math.fround(c) === f) return c;
  }
  return Number(f.toPrecision(9));
}

/** A request's parameters with every value the wire TYPED as a Float — at any depth of a collection —
 *  landed on its carrier (`floatCanonical`). Every other value is returned as it came. */
export function canonicalFloatParams(params: Record<string, any>, paramTypes: Record<string, TypeNode>): Record<string, any> {
  const land = (v: any, t: TypeNode | null | undefined): any => {
    if (v == null || t == null) return v;
    if (t === 'float') return typeof v === 'number' ? floatCanonical(v) : v;
    if (typeof t !== 'object') return v;
    if (t.t === 'map') return v instanceof Map
      ? new Map([...v].map(([k, x]) => [land(k, t.entries[String(k)]?.key), land(x, t.entries[String(k)]?.value)]))
      : v;
    if (Array.isArray(v)) return v.map((x, i) => land(x, t.items[i]));
    if (v instanceof Set) return new Set([...v].map((x, i) => land(x, t.items[i])));
    return v;
  };
  const typed = Object.keys(paramTypes).filter((k) => k in params);
  if (typed.length === 0) return params;
  const out = { ...params };
  for (const k of typed) out[k] = land(params[k], paramTypes[k]);
  return out;
}

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

/** `Double.toString`'s digits as a JS number spelling — JS's own shortest-closest digits, under Java's
 *  two-digit minimum (`Double.toString` javadoc, JDK 19+): only a SUBNORMAL double prints differently,
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
 * `Double.toString(d)` — the printing authority (a Float prints as the Double it rides as). The digits are
 * `doubleText`'s; the LAYOUT is Java's: PLAIN for a magnitude in [10^-3, 10^7), always with a
 * fractional digit (`1.0`), and computerized scientific notation outside it (`1.0E10`, `4.9E-324`).
 */
export function javaNumberText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (value === 0) return '0.0';
  const decimal = decimalOf(doubleText(value))!;
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

/** `BigDecimal.valueOf(d)` — a floating Number's BigDecimal widening (`NumberHelper.bigDecimalValue`,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-857`):
 *  the PRINTED decimal, never the exact binary value. `null` for a NaN or an infinity, which Java's
 *  `BigDecimal` cannot hold (`NumberFormatException`). */
export function floatingDecimal(d: number): BigDecimal | null {
  return Number.isFinite(d) ? decimalOf(javaNumberText(d)) : null;
}

/**
 * THE BIGDECIMAL CARRIER AUTHORITY — which `BigDecimal` a carried value IS, read once for every reader that
 * needs its SCALE (the wire framer at every depth, `asString()`'s printer). A BigDecimal rides in one of
 * three carriers, and each one fixes the scale on its own (`NumberHelper.bigDecimalValue`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-859`):
 *
 * - **decimal TEXT** (a JS string — a literal, a stored value, a compile-time floating widening of positive
 *   scale): the text IS `new BigDecimal(text)`, scale and all.
 * - **INTEGER** (a whole JS number, or an integral JSON spelling inside a list): an integral source's
 *   `BigDecimal.valueOf(long)`, scale 0.
 * - **REAL** (a Double widened at run time — `asNumber(GType.BIGDECIMAL)`, a sum's class meet; inside a list,
 *   SQLite's JSON spells it with a point or exponent, `parseExactJson` keeps it raw): `BigDecimal.valueOf(double)`
 *   from the shortest JS spelling.
 *
 * A bare whole JS number below 10^21 is read as the INTEGER carrier, so a whole REAL that SQLite hands a
 * scalar framer frames at scale 0 (`1.0E7` and `100.0` as `10000000` and `100`) — a deliberate
 * divergence from `Double.toString`'s scale (`docs/feature-support-matrix.md`).
 */
export function bigDecimalOfCarrier(v: BigDecimal | string | bigint | number | ExactNumber): BigDecimal {
  if (v instanceof BigDecimal) return v;
  if (typeof v === 'bigint') return new BigDecimal(v, 0);
  if (typeof v === 'string') return BigDecimal.fromText(v);
  if (isExactNumber(v)) {
    const { integral, text } = exactNumberOf(v);
    return integral ? new BigDecimal(BigInt(text), 0) : realDecimal(Number(text));
  }
  // A whole number past 2^53 is a Double (an exact wide integer rides as decimal TEXT): its shortest digits.
  return Number.isSafeInteger(v) ? new BigDecimal(BigInt(v), 0) : realDecimal(v);
}

const realDecimal = (d: number): BigDecimal => {
  const decimal = floatingDecimal(d);
  // `BigDecimal.valueOf(±∞)` is the reference's NumberFormatException: a clear decline, never a bare Error.
  if (decimal === null) throw UnsupportedTraversal.because(`a non-finite number (${d}) cannot be framed as a BigDecimal`);
  return decimal;
};

/** The double adjacent to a FINITE `x` on each side — `Math.nextDown`/`nextUp`. */
export function adjacent(x: number): readonly [number, number] {
  const step = (v: number, up: boolean): number => {
    if (v === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, v);
    const raw = view.getBigInt64(0);
    view.setBigInt64(0, (v > 0) === up ? raw + 1n : raw - 1n);
    return view.getFloat64(0);
  };
  return [step(x, false), step(x, true)];
}
