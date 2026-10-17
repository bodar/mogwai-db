import { col, compilerInt, compilerNull, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { letValues, meta, typeOf, type Minter } from './build.ts';
import { deferralExpr, raisedMessage, raiseInRow } from '../../rel/raise.ts';
import { EXACT_DECIMAL_MIN, INEXACT_DECIMAL } from '../../rel/exact-decimal.ts';
import type { Rel } from '../../rel/rel.ts';
import { forEachExpr, forEachRel, relExprs } from '../../rel/walk.ts';

/** The deferral `floatShortest` raises where `printf` and `Float.toString` break an exact tie apart. */
const FLOAT_TIE = 'printing a Float whose shortest decimal is an exact tie is not supported yet';

/**
 * THE FLOAT AUTHORITY, run-time half — a Java `Float` in SQL, where there is no single precision.
 *
 * A Float is carried as its EXACT value (the compile-time half, `src/gremlin/float.ts`, states why), so a
 * consumer that reads it as a number — a compare, `math()`, a `min`/`max` across classes — reads the
 * reference's own `floatValue()`/`doubleValue()` with nothing to convert. Two things are left to SQL, and
 * both live here so no producer or consumer spells its own:
 *
 * - **ROUNDING TO A FLOAT** (`floatValueOf`) — what a producer of a NEW Float states its value through: a
 *   `Float` sack fold (`FLOAT_NUMBER_HELPER.add` is `a.floatValue() + b.floatValue()`, a float result,
 *   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:225-229`),
 *   a run-time `asNumber(GType.FLOAT)`. SQLite has no single-precision type, so it is Veltkamp's split:
 *   `c = x·(2^29 + 1); c − (c − x)` keeps the top 53 − 29 = 24 significant bits of a double, rounded to
 *   nearest — exactly `Math.fround` over the float NORMAL range, ties included (measured against
 *   `Math.fround` over 2·10^6 random doubles and 4·10^6 float midpoints). Outside that range (a subnormal,
 *   an overflow) it is not, so a caller fences those (`floatSubnormal`, `FLOAT_OVERFLOW`).
 * - **PRINTING A FLOAT** (`floatShortest`) — `Float.toString`, the shortest decimal that reads back as the
 *   float, which the consumers that print or re-parse a Float read (`asString`; a cast to Double is
 *   `Double.parseDouble(a.toString())`, `NumberHelper.java:742-745`).
 */

/** `Float.MAX_VALUE`. */
export const FLOAT_MAX = 3.4028234663852886e38;
/** The least magnitude `Math.fround` carries to an infinity: `Float.MAX_VALUE` plus half its ulp (a tie
 *  rounds to even, which is the infinity). */
export const FLOAT_OVERFLOW = 3.4028235677973366e38;
/** `Float.MIN_NORMAL` — below it a float is subnormal and `floatValueOf` is not `Math.fround`. */
export const FLOAT_MIN_NORMAL = 1.1754943508222875e-38;
/** Veltkamp's splitting constant for 24 kept bits: 2^(53−24) + 1. */
const SPLIT = 536870913;

const bin = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const real = (x: Expr): Expr => ({ kind: 'cast', arg: x, to: 'real' });
const abs = (x: Expr): Expr => ({ kind: 'call', fn: 'abs', args: [x] });

/** `(float) x` for a REAL `x` in the float normal range or zero — `Math.fround`, by Veltkamp's split.
 *  `x` is spelled three times, so a caller hands it a column, never a correlated read. */
export function floatValueOf(x: Expr): Expr {
  const scaled = bin('*', x, compilerReal(SPLIT));
  return bin('-', scaled, bin('-', scaled, x));
}

/** `x` is a non-zero magnitude below the float normal range, where `floatValueOf` is not `Math.fround`. */
export const floatSubnormal = (x: Expr): Expr =>
  bin('and', bin('<', abs(x), compilerReal(FLOAT_MIN_NORMAL)), bin('!=', x, compilerReal(0)));

/** 2^149 — a float's least ulp is 2^-149, below `Float.MIN_NORMAL` and through the binade above it. */
const FLOAT_ULP_SCALE = 2 ** 149;

/**
 * `(float) x` for a REAL `x` ANYWHERE below the overflow — `floatValueOf` in the normal range, and below it
 * the float grid itself: every float under `Float.MIN_NORMAL` is a multiple of 2^-149, so `x·2^149` rounded
 * to an integer half-EVEN (`round` breaks a tie away from zero, so an exact `.5` halves first) and scaled
 * back is `Math.fround`, exactly — both scalings are exact powers of two. `x` is spelled several times,
 * so a caller hands it a column.
 */
export function floatRoundedOf(x: Expr): Expr {
  const scaled = bin('*', x, compilerReal(FLOAT_ULP_SCALE));
  const floor: Expr = { kind: 'call', fn: 'floor', args: [scaled] };
  const round = (e: Expr): Expr => ({ kind: 'call', fn: 'round', args: [e] });
  const halfEven: Expr = { kind: 'case',
    whens: [[bin('=', bin('-', scaled, floor), compilerReal(0.5)), bin('*', compilerReal(2), round(bin('/', scaled, compilerReal(2))))]],
    else: round(scaled) };
  return { kind: 'case', whens: [[bin('<', abs(x), compilerReal(FLOAT_MIN_NORMAL)), bin('/', halfEven, compilerReal(FLOAT_ULP_SCALE))]],
    else: floatValueOf(x) };
}

/** The deferral `floatShortest` raises where its input is not a float at all (an infinity, or a value that
 *  lost its exact bits) — never a NULL a caller would print as `0.0`. */
const NOT_A_FLOAT = 'printing a Float that is not carried as its exact value is not supported yet';

/**
 * `Float.toString(f)`'s VALUE — the shortest decimal that reads back as the float, as the REAL nearest it —
 * for a float carried exactly (`x`, a REAL). Tried at 2…9 significant digits — at least TWO, Java's
 * minimum (`floatText` states it: `Float.MIN_VALUE` is `1.4E-45`, not `1E-45`) — the fewest that reads
 * back wins (nine always does): ONE correlated read over the eight precisions, so `x` is spelled a fixed
 * few times rather than once per precision. A subnormal reads back through the float grid
 * (`floatRoundedOf`). NULL only for a NULL; an `x` no candidate reads back as RAISES.
 */
export function floatShortest(x: Expr, fresh: Minter): Expr {
  const precisions = make.explode({
    id: fresh('fsp'), channels: [], type: typeOf(meta('p', 'int')), as: { value: 'p' },
    expr: compilerText(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8])),
  });
  const p = col(precisions.id, 'p');
  const printed = (digits: Expr): Expr => ({ kind: 'call', fn: 'printf', args: [bin('||', bin('||', compilerText('%.'), digits), compilerText('e')), x] });
  const lastDigit = (text: Expr): Expr => ({ kind: 'call', fn: 'substr', args: [text, bin('-', { kind: 'call', fn: 'instr', args: [text, compilerText('e')] }, compilerInt(1)), compilerInt(1)] });
  // AN EXACT TIE — the float's exact value ends in a 5 one place past the candidate's — is broken toward
  // the EVEN digit by `Float.toString` and upward by `printf`; such a candidate with an odd last digit is
  // not Java's, so it is marked and the read defers (`floatText`, the compile-time half, breaks it exactly).
  const next = printed(bin('+', p, compilerInt(1)));
  const tie = bin('and', bin('=', real(next), x), bin('=', lastDigit(next), compilerText('5')));
  const odd: Expr = { kind: 'in-list', expr: lastDigit(printed(p)), values: ['1', '3', '5', '7', '9'].map(compilerText) };
  const candidates = make.project({
    id: fresh('fsc'), input: precisions, channels: [], type: typeOf(meta('p', 'int'), meta('c', 'real', true), meta('t', 'int', true)),
    exprs: [['p', p], ['c', real(printed(p))], ['t', bin('and', tie, odd)]],
  });
  const c = col(candidates.id, 'c');
  const readsBack = make.filter({ id: fresh('fsr'), input: candidates, channels: [], type: candidates.type, pred: bin('=', floatRoundedOf(c), x) });
  const fewest = make.sort({ id: fresh('fss'), input: readsBack, channels: [], type: readsBack.type, terms: [{ expr: col(readsBack.id, 'p'), dir: 'asc' }] });
  const first = make.limit({ id: fresh('fsl'), input: fewest, channels: [], type: fewest.type, count: compilerInt(1) });
  const chosen: Expr = { kind: 'case', whens: [[col(first.id, 't'), raiseInRow(FLOAT_TIE)]], else: col(first.id, 'c') };
  const shortest: Expr = { kind: 'scalar', plan: make.project({ id: fresh('fsv'), input: first, channels: [], type: typeOf(meta('c', 'real', true)), exprs: [['c', chosen]] }) };
  return { kind: 'case', whens: [[{ kind: 'binary', op: 'is', left: x, right: compilerNull('real') }, compilerNull('real')]],
    else: { kind: 'call', fn: 'coalesce', args: [shortest, raiseInRow(NOT_A_FLOAT)] } };
}

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
 * scale 1, `1.0E7` (10, −6)) — never a bare REAL a scalar framer would read as scale 0. A FLOAT winner is
 * `new BigDecimal(f.toString())`, whose printing (`floatShortest`) would more than double the statement of
 * every min/max that MIGHT meet one, so it DEFERS in-row rather than frame the Float's exact binary value.
 * `own` is the winner's own Gremlin class and `toDecimal` the test that the RESULT's class is BigDecimal
 * (`resultIsDecimal`); every other winner (an integral one is `valueOf(long)`, scale 0, which its INTEGER
 * already frames) is itself. `value` is spelled several times, so a caller hands it a column or a cheap read.
 */
export function promotedExtremum(value: Expr, own: Expr, toDecimal: Expr, fresh: Minter): Expr {
  const isText = (e: Expr, t: string): Expr => bin('=', e, compilerText(t));
  return { kind: 'case', whens: [
    [bin('and', toDecimal, isText(own, 'double')), doubleDecimalText(value, fresh)],
    [bin('and', toDecimal, isText(own, 'float')), raiseInRow(FLOAT_TO_DECIMAL)],
  ], else: value };
}

/** A named result class IS BigDecimal — `promotedExtremum`'s `toDecimal` where the class is a column. (A
 *  FLOATING winner's result is BigDecimal exactly where the stream's widest width is 128 — `determineNumberClass`
 *  of `f128` — so a caller holding the width alone tests that instead.) */
export const resultIsDecimal = (cls: Expr): Expr => bin('=', cls, compilerText('bigdecimal'));

/** The deferral `promotedExtremum` raises for a Float winner promoted to BigDecimal. */
export const FLOAT_TO_DECIMAL = 'min/max promoting a Float to BigDecimal is not supported yet';

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
export function doubleDecimalText(x: Expr, fresh: Minter, float: boolean | Expr = false): Expr {
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
      // `Double.toString(±0.0)` is `0.0`/`-0.0`, and `new BigDecimal("-0.0")` is the zero of scale 1.
      [bin('=', r, compilerReal(0)), compilerText('0.0')],
      [bin('<', magnitude, compilerReal(DOUBLE_MIN_NORMAL)), raiseInRow(SUBNORMAL_DECIMAL)],
      // Below the range SQLite's `printf` spells exactly (`exact-decimal.ts`) the digits above are not the
      // value's. (Past its top a value is whole and rides as the REAL, which every JSON entry and the scalar
      // framer guard themselves — `asExactReal`, `build.ts`.)
      [bin('<', magnitude, compilerReal(EXACT_DECIMAL_MIN)), deferralExpr(INEXACT_DECIMAL, call('random'))],
    ], else: plainText };
  };
  // A FLOAT widens through `Float.toString` (`new BigDecimal(f.toString())`) — its shortest decimal, printed
  // ONCE (a correlated read) into a one-row LET. That decimal has at most nine digits, so `%.15g` carries it
  // exactly (DBL_DIG); a Double row carries nothing there and reads `x` itself.
  const shortest = call('printf', compilerText('%.15g'), floatShortest(real(x), fresh));
  const decimal = float === false ? body(real(x))
    : letValues([float === true ? shortest : { kind: 'case', whens: [[float, shortest]], else: compilerNull('text') }],
      ([printedFloat]) => body(call('coalesce', real(printedFloat!), real(x))), fresh);
  return { kind: 'case', whens: [[{ kind: 'binary', op: 'is', left: x, right: compilerNull('real') }, compilerNull('text')]], else: decimal };
}
