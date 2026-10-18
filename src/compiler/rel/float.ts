import { compilerInt, compilerNull, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import { letValues, type Minter } from './build.ts';
import { deferralExpr, raisedMessage, raiseInRow } from '../../rel/raise.ts';
import { EXACT_DECIMAL_MIN, INEXACT_DECIMAL } from '../../rel/exact-decimal.ts';
import type { Rel } from '../../rel/rel.ts';
import { forEachExpr, forEachRel, relExprs } from '../../rel/walk.ts';

/**
 * Floating-number widening at run time. A Gremlin `Float` rides as the Double of its decimal (`0.1f` is the
 * REAL 0.1, `src/gremlin/float.ts`) and is rounded to float32 only by the wire framer, so nothing here
 * spells single precision.
 */

/** `Float.MAX_VALUE`. */
export const FLOAT_MAX = 3.4028234663852886e38;
/** The least magnitude `Math.fround` carries to an infinity: `Float.MAX_VALUE` plus half its ulp. A Float
 *  result at or past it frames as a Double (`commonNumberClass`), never as an infinity. */
export const FLOAT_OVERFLOW = 3.4028235677973366e38;

const bin = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const real = (x: Expr): Expr => ({ kind: 'cast', arg: x, to: 'real' });
const abs = (x: Expr): Expr => ({ kind: 'call', fn: 'abs', args: [x] });

/**
 * Does this plan WIDEN a Double to a BigDecimal at run time (`doubleDecimalText`) — the one producer of a
 * BigDecimal riding as a whole REAL of NEGATIVE scale (`1.0E7` is (10, −6)), which a scalar framer reads as
 * an integral source's scale-0 INTEGER unless the frame says otherwise (`scalarFramedValue`, `build.ts`)?
 * Every widening carries this module's subnormal deferral, so its presence anywhere in the plan — a
 * correlated subquery included — is the answer; a plan without one holds no such carrier, and its frame
 * pays nothing.
 */
export function widensDoubleToDecimal(plan: Rel): boolean {
  let found = false;
  forEachRel(plan, (rel) => {
    if (!found) relExprs(rel).forEach((e) => forEachExpr(e, (node) => {
      if (node.kind === 'lit' && typeof node.value === 'string' && raisedMessage(node.value) === SUBNORMAL_DECIMAL) found = true;
    }));
  });
  return found;
}

/**
 * THE IMPLICIT WIDENING — a `min`/`max` winner promoted to its stream's common class. `NumberHelper.max/min`
 * promote BOTH sides to `getHighestCommonNumberClass` before comparing and return the promoted value
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:639-655`),
 * so a Double winner of a stream whose class is BigDecimal IS `bigDecimalValue(winner)` = `BigDecimal.valueOf(d)`
 * (`:850-859`) — the SAME widening `asNumber(GType.BIGDECIMAL)` states (`doubleDecimalText`), so it goes
 * through it: the winner rides the scaled carrier every BigDecimal consumer reads, at every depth (`1.0` is
 * scale 1, `1.0E7` (10, −6)) — never a bare REAL a scalar framer would read as scale 0. A FLOAT winner rides
 * as the Double of its value, so it widens the same way. `own` is the winner's own Gremlin class and
 * `toDecimal` the test that the RESULT's class is BigDecimal (`resultIsDecimal`); every other winner (an
 * integral one is `valueOf(long)`, scale 0, which its INTEGER already frames) is itself. `value` is spelled
 * several times, so a caller hands it a column or a cheap read.
 */
export function promotedExtremum(value: Expr, own: Expr, toDecimal: Expr, fresh: Minter): Expr {
  const floating: Expr = { kind: 'in-list', expr: own, values: [compilerText('double'), compilerText('float')] };
  return { kind: 'case', whens: [[bin('and', toDecimal, floating), doubleDecimalText(value, fresh)]], else: value };
}

/** A named result class IS BigDecimal — `promotedExtremum`'s `toDecimal` where the class is a column. (A
 *  FLOATING winner's result is BigDecimal exactly where the stream's widest width is 128 — `determineNumberClass`
 *  of `f128` — so a caller holding the width alone tests that instead.) */
export const resultIsDecimal = (cls: Expr): Expr => bin('=', cls, compilerText('bigdecimal'));

/** `Double.MIN_NORMAL` — below it a double is subnormal, where 15 digits no longer always round-trip. */
const DOUBLE_MIN_NORMAL = 2.2250738585072014e-308;
/** The deferral `doubleDecimalText` raises for a subnormal, whose shortest digits it does not derive. */
const SUBNORMAL_DECIMAL = 'a BigDecimal widening of a subnormal Double is not supported';

/**
 * `BigDecimal.valueOf(d)` — `new BigDecimal(Double.toString(d))` — as the decimal-TEXT carrier a BigDecimal
 * rides as (`BigDecimal.toString`, `src/gremlin/types.ts`), for a REAL `x`: the run-time half of
 * `floatingDecimal` (`src/gremlin/float.ts`), so a run-time widening lands on the SCALE the compile-time
 * one does (`NumberHelper.bigDecimalValue`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:850-859`):
 * `100.0` is `100.0` (scale 1), `1.234E-5` is `0.00001234` (scale 8) — where the bare REAL framed `100`.
 *
 * - **The digits** are `Double.toString`'s shortest: the fewest of 15/16/17 significant digits that read
 *   back as `x` (`printf('%!.<p>e')` — the `!` flag is SQLite's full-precision conversion). Fifteen is enough whenever any shorter spelling is (DBL_DIG: a decimal
 *   of at most 15 digits survives the round trip, so its nearest double prints back as it), and the
 *   correctly rounded 16- or 17-digit spelling is the closest of its length. A SUBNORMAL is outside that
 *   argument and defers.
 * - **The scale** is the spelling's: `Double.toString` writes a magnitude in [10^-3, 10^7) PLAIN and else as
 *   `d.dddE±n`, both with at least one fractional digit (`javaNumberText`), so a `k`-digit value with decimal
 *   exponent `e` has scale `max(1, k−1−e)` plain and `max(1, k−1) − e` in E-notation.
 * - **The carrier** is PLAIN decimal text (`BigDecimal.toString` — the form every BigDecimal consumer reads,
 *   `predicate.ts` `decimalTextMatch`), which holds a POSITIVE scale exactly. A scale of at most zero is
 *   exactly an INTEGRAL Double at or past 10^7 (its shortest decimal then has no fractional digit, and the
 *   E-notation's one is the scale's only source), which plain text cannot spell either. At or past 10^21
 *   that value stays the REAL itself, which the ONE carrier authority reads as `BigDecimal.valueOf`
 *   (`bigDecimalOfCarrier`, `src/gremlin/float.ts`: `2.9E22` is (29, −21) as Java's). Below 10^21 a REAL
 *   whole number would be read as scale 0 by a scalar framer, where SQLite hands a REAL back as the same JS
 *   number an integral source's INTEGER is — so a whole magnitude in [10^7, 10^21) stays the REAL too: the
 *   REAL carrier IS `BigDecimal.valueOf`, whatever its scale (`1.2345678E7` scale 0, `1.0E7` (10, −6)), which
 *   a member re-read through JSON, a compare, a cast and `math()` all read exactly, and which the scalar
 *   framer receives spelled as the raw JSON REAL it is (`scalarPayload`, `lower.ts`). A widening defers
 *   nothing a later step might never observe.
 */
export function doubleDecimalText(x: Expr, fresh: Minter): Expr {
  const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
  // `x` is a COLUMN (a caller materializes a computed one), so it is read as often as the text needs; each
  // DERIVED spelling below rides a one-row LET rather than being re-inlined at every read.
  const body = (r: Expr): Expr => {
    const magnitude = abs(r);
    const printed = (p: number): Expr => call('printf', compilerText(`%!.${p}e`), magnitude);
    const spelled: Expr = { kind: 'case', whens: [
      [bin('=', real(printed(14)), magnitude), printed(14)],
      [bin('=', real(printed(15)), magnitude), printed(15)],
    ], else: printed(16) };
    // `n` zeros (`printf` pads with spaces; zero of them is the empty string).
    const zeros = (n: Expr): Expr => call('replace', call('printf', compilerText('%*s'), n, compilerText('')), compilerText(' '), compilerText('0'));
    const plainText = letValues([spelled], ([s]) => {
      const at = call('instr', s!, compilerText('e'));
      // `d.ddd…e±n` → its significant digits D with trailing zeros dropped, and n.
      const digitsOf = call('rtrim', bin('||', call('substr', s!, compilerInt(1), compilerInt(1)), call('substr', s!, compilerInt(3), bin('-', at, compilerInt(3)))), compilerText('0'));
      const exponentOf: Expr = { kind: 'cast', arg: call('substr', s!, bin('+', at, compilerInt(1))), to: 'int' };
      return letValues([digitsOf, exponentOf], ([digits, e]) => {
        const k = call('length', digits!);
        const plain = bin('and', bin('>=', e!, compilerInt(-3)), bin('<', e!, compilerInt(7)));
        // A POSITIVE scale is spelled `<integer part>.<fraction padded to the scale>`. A whole magnitude in
        // [10^7, 10^21) (E-notation, so scale `max(1, k−1) − e` ≤ 0) has no plain spelling of its scale: scale 0
        // stays the REAL itself, which the carrier authority reads as scale 0 (`bigDecimalOfCarrier`), and a
        // NEGATIVE scale (`1.0E7` is (10, −6)) — which no carrier keeps apart from an integral source's
        // scale-0 INTEGER — defers.
        const scale: Expr = { kind: 'case', whens: [[plain, call('max', compilerInt(1), bin('-', bin('-', k, compilerInt(1)), e!))]],
          else: bin('-', call('max', compilerInt(1), bin('-', k, compilerInt(1))), e!) };
        const whole = bin('>=', e!, compilerInt(0));
        const integer: Expr = { kind: 'case', whens: [[whole, call('substr', bin('||', digits!, zeros(e!)), compilerInt(1), bin('+', e!, compilerInt(1)))]], else: compilerText('0') };
        const fraction: Expr = { kind: 'case', whens: [[whole, call('substr', digits!, bin('+', e!, compilerInt(2)))]],
          else: bin('||', zeros(bin('-', compilerInt(-1), e!)), digits!) };
        const sign: Expr = { kind: 'case', whens: [[bin('<', r, compilerReal(0)), compilerText('-')]], else: compilerText('') };
        const text = bin('||', bin('||', bin('||', sign, integer), compilerText('.')),
          call('replace', call('printf', compilerText('%-*s'), scale, fraction), compilerText(' '), compilerText('0')));
        // In E-notation (`e` ≥ 7) the scale is `k − 1 − e` ≤ 0, and the value rides as the REAL itself.
        const eNotation = bin('>=', e!, compilerInt(7));
        return { kind: 'case', whens: [[eNotation, r]], else: text };
      }, fresh);
    }, fresh);
    return { kind: 'case', whens: [
      [bin('and', bin('>=', magnitude, compilerReal(1e21)), bin('=', r, call('floor', r))), r],
      // A zero is `0.0` (sign and all), the zero of scale 1.
      [bin('=', r, compilerReal(0)), compilerText('0.0')],
      [bin('<', magnitude, compilerReal(DOUBLE_MIN_NORMAL)), raiseInRow(SUBNORMAL_DECIMAL)],
      // Below the range SQLite's `printf` spells exactly (`exact-decimal.ts`) the digits above are not the
      // value's. (Past its top a value is whole and rides as the REAL, which every JSON entry and the scalar
      // framer guard themselves — `asExactReal`, `build.ts`.)
      [bin('<', magnitude, compilerReal(EXACT_DECIMAL_MIN)), deferralExpr(INEXACT_DECIMAL, call('random'))],
    ], else: plainText };
  };
  return { kind: 'case', whens: [[{ kind: 'binary', op: 'is', left: x, right: compilerNull('real') }, compilerNull('text')]], else: body(real(x)) };
}
