// ---------- where SQLite's decimal <-> binary64 conversion is exact ----------
//
// SQLite converts between decimal text and binary64 with its OWN code (`sqlite3AtoF` reading, `sqlite3FpDecode`
// writing — `printf`, `CAST`, `quote()`, a SQL literal and the JSON reader and writer all go through them), and
// that code is NOT correctly rounded far from 1. Measured on Bun's SQLite 3.51.2 (20 000 random 15/16/17-digit
// doubles per decade, against JS's correctly rounded `Number`/`String`): every conversion is exact in
// [1e-82, 1e118), and from the decade either side of it onward 10-45% of values come back off by a few ulps —
// `printf('%!.17g', 3.7430242338180544E203)` spells 3.7430242338180546E203, a SQL literal `1.5e-300` reads as
// 1.4999999999999998E-300, and even SQLite's own "do 15 digits round-trip" test (`CAST(printf('%.15g', x) AS
// REAL) = x`) answers wrongly both ways, so no SQL-side test can tell which values survive. The bounds below
// leave a two-decade margin inside the measured range.
//
// So a binary64 crosses decimal TEXT inside SQLite only within this range. The two crossings the compiler
// controls ask here: a compiler-held REAL literal (`emit.ts`) is spelled as an exact product of in-range
// factors instead, and a run-time REAL entering a JSON text (`asExactReal`, `compiler/rel/build.ts`) or spelled
// as a BigDecimal's digits (`doubleDecimalText`, `compiler/rel/float.ts`) DEFERS in-row outside it rather than
// carry a different number — unless the JSON text is one only the wire reads, which carries it exactly
// (`binary64Carrier`, `compiler/rel/build.ts`). Zero and ±Infinity are exact everywhere (`0.0`, the overflow
// literal `9e999`).

import { compilerInt, compilerReal, type BinaryOp, type Expr } from './expr.ts';

/** The smallest magnitude whose decimal conversion inside SQLite this compiler relies on. */
export const EXACT_DECIMAL_MIN = 1e-80;
/** The largest magnitude whose decimal conversion inside SQLite this compiler relies on. */
export const EXACT_DECIMAL_MAX = 1e116;

/** Does SQLite convert this binary64 to and from decimal text exactly? */
export const hasExactDecimal = (x: number): boolean => {
  const m = Math.abs(x);
  return m === 0 || !Number.isFinite(m) || (m >= EXACT_DECIMAL_MIN && m <= EXACT_DECIMAL_MAX);
};

/** The deferral a run-time REAL raises where it would have to cross decimal text outside the exact range. */
export const INEXACT_DECIMAL = "a Double outside [1e-80, 1e116] through SQLite's decimal text is not supported yet";

/**
 * The SQL test that a REAL `x` (a column or a cheap read — it is spelled several times) is OUTSIDE the exact
 * range: a non-zero finite magnitude outside [`EXACT_DECIMAL_MIN`, `EXACT_DECIMAL_MAX`]. A NULL makes it NULL,
 * which a CASE reads as "no arm".
 */
export const outsideExactDecimal = (x: Expr): Expr => {
  const magnitude: Expr = { kind: 'call', fn: 'abs', args: [x] };
  const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
  const inRange = bin('and', bin('>=', magnitude, compilerReal(EXACT_DECIMAL_MIN)), bin('<=', magnitude, compilerReal(EXACT_DECIMAL_MAX)));
  return bin('and', bin('and', bin('>', magnitude, compilerReal(0)), bin('<', magnitude, compilerReal(Infinity))),
    { kind: 'unary', op: 'not', arg: inRange });
};

/** `2^STEP` and `2^-STEP` both sit deep inside the exact range (1.6E60, 6.2E-61), so their shortest spellings
 *  read back exactly. */
const STEP = 200;

/**
 * A finite binary64 OUTSIDE the exact range as SQL text SQLite evaluates to exactly that value: an in-range
 * multiple times powers of two, `(w*1.6069380442589903e+60*…)`. Scaling by a power of two is exact in binary64
 * (the product only moves the exponent; a subnormal result is exact too, because the value it ends at is
 * representable and every intermediate is a coarser multiple of the same power of two), and each factor is a
 * decimal SQLite reads exactly. `null` for a value inside the range, which its shortest spelling already reads
 * back as.
 */
export function exactRealSpelling(x: number): string | null {
  if (hasExactDecimal(x)) return null;
  const up = Math.abs(x) < 1; // scale the value UP into the range, and spell the way back DOWN
  let w = x;
  let steps = 0;
  while (!hasExactDecimal(w) || Math.abs(w) > 1e60 || Math.abs(w) < 1e-60) {
    w = up ? w * 2 ** STEP : w * 2 ** -STEP;
    steps++;
  }
  const factor = String(up ? 2 ** -STEP : 2 ** STEP);
  const head = String(w);
  return `(${/[.eE]/.test(head) ? head : `${head}.0`}${`*${factor}`.repeat(steps)})`;
}

// ---------- a binary64 OUTSIDE the range, carried exactly to the wire ----------
//
// Outside the range no decimal TEXT crosses SQLite exactly in EITHER direction (measured on 3.51.2, 5 000
// random doubles per band: `printf('%!.17g', x)` is read back as x by JS for only 55-90% of them, SQLite's
// own `CAST`/JSON reader reads JS's correctly rounded `String(x)` back as x for only 63-91%), so no JSON
// NUMBER can carry such a value into a JSON text SQLite will read again. But a JSON text only the WIRE reads
// (an element's property bag — `compiler/rel/element.ts`) needs no SQL reader: it needs a spelling SQL can
// WRITE exactly and JS can READ exactly. Multiplying by a power of two is exact in binary64 whenever the
// product is representable (it moves only the exponent), so the value rides as `<w>p<n>` — `x = w × 2^n`,
// with `w` brought INSIDE the range by one such multiplication, where SQLite's `printf('%!.17g')` is exact —
// as a JSON STRING under a binary64 `{t,v}` tag, which no decimal text (a BigDecimal's `12.50`) can be
// mistaken for: it holds a `p`. `binary64OfCarrier` is the reading half, applied by both JSON readers of
// SQLite's text (`json-exact.ts`).

/**
 * The three powers of two the carrier scales by — each band's `w = x × 2^-n` lands inside [1e-80, 1e116]:
 * - `large`, every |x| > 1e116: w ∈ (1e116·2^-640, 2^1024·2^-640) = (2.2E-77, 3.9E115);
 * - `small`, |x| ∈ [~1e-190, 1e-80): w = x·2^500 ∈ [3.3E-40, 3.3E70);
 * - `tiny`, the rest down to `Double.MIN_VALUE` (2^-1074): w = x·2^1000 ∈ [2^-74, 1.1E111).
 * `small` fits anywhere from 3E-231 up and `tiny` anywhere up to 9E-186, so the boundary between them
 * need not be exact (`binary64Carrier`, `compiler/rel/build.ts`).
 */
export const CARRIER_BANDS = { large: 640, small: -500, tiny: -1000 } as const;
const CARRIER_EXPONENTS: ReadonlySet<number> = new Set(Object.values(CARRIER_BANDS));
/** `<w>p<n>`: a 17-significant-digit `printf` spelling, then the power of two. */
const CARRIER = /^(-?\d+(?:\.\d+)?(?:e[+-]\d+)?)p(-?\d+)$/;

/** The binary64 a wire carrier spells (`binary64Carrier`, `compiler/rel/build.ts`), or `null` for any other
 *  value. `w × 2^n` is one exact multiplication: the product IS the value the writer started from. */
export function binary64OfCarrier(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = CARRIER.exec(v);
  if (!m || !CARRIER_EXPONENTS.has(Number(m[2]))) return null;
  return Number(m[1]) * 2 ** Number(m[2]);
}

/** The JS writing half of the wire carrier: `x` spelled `<w>p<n>` as `binary64Carrier` (`compiler/rel/build.ts`)
 *  spells it in SQL, over the SAME bands (`binary64Pair`), so `binary64OfCarrier` reads it back bit for bit
 *  (`w` is `String`'s round-trip spelling, and `w × 2^n` is one exact multiplication). `null` for a value
 *  SQLite's decimal text already carries exactly. The writer for a JSON text built in JS that only the wire
 *  reads — a landed federated element's payload (`stringifyExact`'s `wireCarrier`). */
export function binary64CarrierText(x: number): string | null {
  const pair = binary64Pair(x);
  return pair && `${String(pair[0])}p${pair[1]}`;
}

/** Can this JSON text hold a wire carrier? The cheap pre-test a reader skips its reviver on. */
export const mayHoldCarrier = (text: string): boolean => /\dp-?\d/.test(text);

// ---------- a binary64 OUTSIDE the range, carried exactly INTO a stored column ----------
//
// The set-based writer (`src/setwrite.ts`) lands its rows as ONE JSON text SQLite reads (`json_each`), so a
// scalar Double outside the range would be read back as another number (the bulk loader's `io()` read, a
// backup restore). It rides there as the pair `[w, n]` instead — `x = w × 2^n`, the same bands as the wire
// carrier, so `w` is inside the range and SQLite's JSON reader takes it exactly — and the insert multiplies
// it back by the exact `2^n` (`binary64Store`, `setwrite.ts`). The product is one exact multiplication.

/** `x` as the in-range pair `[w, n]` a stored REAL column decodes (`binary64Store`), or `null` for a value
 *  SQLite's decimal reader already takes exactly. */
export function binary64Pair(x: number): readonly [number, number] | null {
  if (hasExactDecimal(x)) return null;
  const m = Math.abs(x);
  const n = m > 1 ? CARRIER_BANDS.large : m * 1e110 >= EXACT_DECIMAL_MIN ? CARRIER_BANDS.small : CARRIER_BANDS.tiny;
  return [x * 2 ** -n, n];
}

/** The decode of a stored cell that may hold a `binary64Pair`: `pair0 × 2^pair1`, the power of two a compiler
 *  REAL (`emit.ts` spells one outside the range as an exact product of in-range factors). `isPair` says the cell
 *  is one; otherwise the plain cell. */
export function binary64OfPair(isPair: Expr, w: Expr, n: Expr, plain: Expr): Expr {
  const power: Expr = {
    kind: 'case',
    whens: Object.values(CARRIER_BANDS).map((band) =>
      [{ kind: 'binary', op: '=', left: n, right: compilerInt(band) }, compilerReal(2 ** band)] as const),
  };
  return { kind: 'case', whens: [[isPair, { kind: 'binary', op: '*', left: w, right: power }]], else: plain };
}
