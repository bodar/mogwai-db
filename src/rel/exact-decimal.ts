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
// carry a different number. Zero and ±Infinity are exact everywhere (`0.0`, the overflow literal `9e999`).

import { compilerReal, type BinaryOp, type Expr } from './expr.ts';

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
