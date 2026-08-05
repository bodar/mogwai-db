import { compilerNull, lit, type Expr } from '../../rel/expr.ts';
import { isNested } from '../../gremlin/frontend.ts';
import { JAVA_WHITESPACE } from '../plan/plan.ts';
import { dtFactor, numericSpec } from '../steps/tail/coerce.ts';
import { STATIC, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';

/**
 * THE SCALAR TRANSFORM VOCABULARY — `v -> v'`, as RelIR expressions.
 *
 * The third vocabulary module, after `predicate.ts` (`P`/`TextP`) and `modulator.ts` (`by()`), and
 * chosen the same way: the blocker table (`mise run rel-blockers`) ranked this family third at **153
 * traversals over EIGHTEEN step names**, largest member `asNumber` at 60. No per-step count could show
 * that, and no per-step increment would have paid for the parse — which is §10·8's whole argument.
 *
 * They are one lowering because they ask one question: an expression over the traverser's value, plus
 * (for the casts only) a change to the FRAMING type. Nothing else about the relation moves — no
 * channel, no cardinality, no shape — which is why the family lands as a table and not as a fold.
 *
 * The two rules are the other vocabularies', unchanged: it DECLINES rather than throwing, and it never
 * answers a different question.
 *
 * ## What is shared with legacy rather than re-derived
 *
 * `numericSpec`, `dtFactor` and `JAVA_WHITESPACE` are imported. They are DATA and pure computation —
 * a GType's numeric range, a DT unit's millisecond factor, Java's 24 whitespace code points — not SQL,
 * so there is nothing to re-express and a second copy would be a second thing to keep in step. Only
 * the EMISSION is re-expressed here, which is the boundary the whole migration draws (§2). The
 * whitespace list is the clearest case: `trim()` in Gremlin trims Java's whitespace set, not SQLite's
 * space, and a re-derived list that missed U+1680 would be wrong in a way no test would name.
 *
 * ## What declines, each for its own reason
 *
 * - **`reverse`** — SQLite has no `REVERSE`, so legacy emits a correlated RECURSIVE CTE inside an
 *   expression. RelIR has `Recursive` as a RELATION, not as a scalar subquery over the current row, so
 *   this is a genuine node-set question (§7) rather than unfinished work. Declining is the honest state.
 * - **`concat` with a traversal argument** — a per-traverser CHILD value, so the step is a row boundary
 *   rather than a value transform. It belongs to whichever seam grows the correlated child.
 * - **bare `asNumber()`** — the output subtype is the INPUT literal's declared type, which the front end
 *   has already flattened away; legacy throws, and only its constant-folding path can answer at all.
 * - **`asBool`** — TinkerPop's parse errors (`Can't parse 'x' as Boolean.`) cannot be raised from SQL,
 *   so legacy evaluates it at COMPILE time over an inject literal. That is a fold over a `Values` node,
 *   not an expression over a column, and it is a different increment.
 * - **`dateDiff`/`dateAdd` with anything but a literal operand** — the same correlated-child question.
 */

/**
 * A transform's result: the new value expression, and the framing type where the step KNOWS it.
 *
 * EVERY transform invalidates a per-row `vtype`, not only the casts — `toUpper()` over a property
 * recorded as `string` still leaves a value the stored row no longer describes, and `length()` turns it
 * into an integer outright. So the caller always drops the column; `type` says whether anything
 * definite replaces it. Absent means `UNKNOWN`, which frames by per-VALUE inference and is the honest
 * floor — and is exactly what legacy produces for the string family (verified against its shape, not
 * assumed: `g.V().values('name').toUpper()` frames `unknown` there too, `asString()` included).
 */
export interface Transformed {
  readonly expr: Expr;
  readonly type?: ScalarType;
}

const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
const text = (value: string): Expr => lit(value, 'text');
const int = (value: number): Expr => lit(value, 'int');

/**
 * The PURE value transforms — a SQLite scalar function over `v`, and nothing else.
 *
 * NULL propagates through every one of them (SQLite's own semantics), which is exactly Gremlin's
 * null-in/null-out, so none needs a guard. `concat` is the one exception and says why inline.
 */
const VALUE_TX: Readonly<Record<string, (v: Expr, args: readonly unknown[]) => Expr | null>> = {
  length: (v) => call('length', v),
  toUpper: (v) => call('upper', v),
  toLower: (v) => call('lower', v),
  asString: (v) => ({ kind: 'cast', arg: v, to: 'text' }),
  // Gremlin's `trim()` trims JAVA's whitespace set, not SQLite's default space — hence the explicit
  // second argument, and hence importing the list rather than restating it.
  trim: (v) => call('trim', v, text(JAVA_WHITESPACE)),
  lTrim: (v) => call('ltrim', v, text(JAVA_WHITESPACE)),
  rTrim: (v) => call('rtrim', v, text(JAVA_WHITESPACE)),
  replace: (v, args) => {
    const [from, to] = args.filter((a): a is string => typeof a === 'string');
    return from === undefined || to === undefined ? null : call('replace', v, text(from), text(to));
  },
  // TinkerPop resolves negative indices against the string length BEFORE slicing; passing them
  // straight to SQLite would instead invoke substr's from-the-right / backwards-length semantics.
  // Reference: vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/
  // traversal/step/map/SubstringGlobalStep.java (`processStringIndex`). Each index is a literal, so
  // specialize its sign branch rather than emitting a runtime CASE. One unavoidable edge remains:
  // Java throws for a negative index into an empty string (`% 0`), while SQLite yields NULL; SQL
  // cannot raise that per-value error.
  substring: (v, args) => {
    const nums = args.filter((a): a is number => typeof a === 'number');
    const [start, end] = nums;
    if (start === undefined) return null;
    const length = (): Expr => call('length', v);
    const index = (at: number): Expr => at >= 0
      ? call('MIN', int(at), length())
      : call('MAX', int(0), {
        kind: 'binary', op: '%',
        left: { kind: 'binary', op: '+', left: length(), right: int(at) },
        right: length(),
      });
    const newStart = index(start);
    const from = { kind: 'binary', op: '+', left: newStart, right: int(1) } as Expr;
    if (end === undefined) return call('substr', v, from);
    const newEnd = index(end);
    // AN EMPTY SLICE IS ARITHMETIC, NOT A BRANCH: `substr(x, from, 0)` is already `''`, so clamping the
    // length at zero answers exactly what the `CASE WHEN newEnd <= newStart THEN ''` guard did —
    // verified equal over NULL, `''`, inverted ranges, negative indices and out-of-range bounds.
    // The guard spelled both bounds a second time, and each bound embeds `length(v)`, so a subject that
    // is a correlated property subquery was emitted SIX times for one `substring(0,1)`; this is four.
    // Bind-budget correctness rather than tidiness — see `storedValueOn` for the measured case.
    return call('substr', v, from,
      call('MAX', int(0), { kind: 'binary', op: '-', left: newEnd, right: newStart }));
  },
  concat: (v, args) => {
    // A traversal argument is a per-traverser child value (`TraversalUtil.apply`), which makes the step
    // a row boundary rather than a value transform. Legacy's caller resolves it and substitutes the
    // Expression; there is no caller doing that here, so decline rather than drop the argument.
    if (args.some(isNested)) return null;
    if (!args.length) return v;
    const operands = args.map((a) => (typeof a === 'string' ? text(a) : typeof a === 'number' ? lit(a, 'real') : null));
    if (operands.some((o) => !o)) return null;
    const parts = [v, ...operands as Expr[]];
    const body = call('concat_ws', text(''), ...parts);
    // `concat_ws` SKIPS nulls, so an all-null concat must yield NULL and not `''`. A non-null literal
    // argument makes the result non-null regardless of `v`, so the guard is only owed without one —
    // and it tests that every operand IS NULL, never that the concatenation is empty, because an
    // operand of `''` is a non-null contribution that must yield `''`.
    if (args.some((a) => typeof a === 'string')) return body;
    return {
      kind: 'case',
      whens: [[parts.map((p) => ({ kind: 'binary', op: 'is', left: p, right: compilerNull() }) as Expr)
        .reduce((left, right) => ({ kind: 'binary', op: 'and', left, right })), compilerNull()]],
      else: body,
    };
  },
};

/** The transforms whose CONSTANT form raises a TinkerPop parse/overflow error SQL cannot express, so
 *  over a compile-time literal they are legacy's fold and not this module's cast. See `transformExpr`.
 *
 *  `dateAdd`/`dateDiff` are deliberately NOT here even though legacy folds them too, and the difference
 *  is the reason: their fold is an OPTIMIZATION (one bind instead of a literal plus an offset), not a
 *  semantic requirement — the arithmetic answers identically, verified row-for-row. Constant folding is
 *  a `Pass` over `Values` + `Lit` (§4), and declining because that pass is unwritten is exactly the
 *  reasoning that makes coverage stall. Measured: including them costs 7 corpus traversals. */
const CONSTANT_FOLDED = new Set(['asNumber', 'asDate', 'asBool']);

/** Every name in this family, whether or not it is covered — the set a fold checks membership in
 *  BEFORE asking for a lowering, so an unlowerable member ends the transform run rather than falling
 *  through to some other arm's interpretation of it. Mirrors legacy's `SCALAR_TRANSFORMS`. */
export const REL_TRANSFORMS: ReadonlySet<string> = new Set([
  ...Object.keys(VALUE_TX), 'asNumber', 'asDate', 'dateAdd', 'dateDiff', 'reverse', 'asBool',
]);

/**
 * A scalar transform over `v`, or `null` to decline.
 *
 * `Scope.local` is deliberately NOT checked: a scalar IS a one-element list, so per-element and
 * per-list are the same question and the token is a no-op — which is what legacy does too. That is a
 * semantic fact about this family, not a shortcut; a LIST stream's local transform is a different
 * lowering entirely and never reaches here.
 */
export function transformExpr(step: IRStep, v: Expr, literal: boolean): Transformed | null {
  const args = step.args ?? [];

  // OVER A COMPILE-TIME LITERAL, THE CAST SUBFAMILY IS NOT A SQL CAST AT ALL — it is a parse that must
  // RAISE, and SQL cannot raise. TinkerPop requires `Can't parse string '1,000' as number.` and
  // `Can't convert number of type Integer to Byte due to overflow.`; a SQLite `CAST` answers `1` and
  // `300` instead, so lowering it here turns a REQUIRED ERROR into a plausible value — the worst
  // direction the "never answer a different question" rule has. Legacy folds these at compile time for
  // exactly this reason (`asNumberConst`/`asDateConst`/`asBoolConst`), so declining hands it a
  // traversal it answers correctly.
  //
  // Found by L3, not by the differential: six official scenarios assert the ERROR, and comparing rows
  // against legacy cannot see a missing throw. The string transforms are unaffected — `toUpper()` of a
  // literal has no parse to fail — so the decline is the cast subfamily and not the family.
  if (literal && CONSTANT_FOLDED.has(step.name)) return null;

  const pure = VALUE_TX[step.name];
  if (pure) {
    const expr = pure(v, args);
    // No static type, `asString` included. That looks wrong for a `CAST(… AS TEXT)` and is not: the
    // framing `UNKNOWN` infers per VALUE, which for a text value is `string` anyway, so both spines
    // frame it identically — and CLAIMING a type here where legacy claims none would be a divergence
    // in the one direction the differential cannot forgive. Match the spine being replaced; a semantic
    // improvement to the tag is a separate change on both sides.
    return expr && { expr };
  }

  if (step.name === 'asNumber') {
    // `numericSpec` THROWS for a non-numeric token (`asNumber(GType.VERTEX)`), which is a real error
    // legacy owns — so it is caught into a decline and the legacy spine raises the identical message.
    let spec;
    try { spec = numericSpec(args[0]); } catch { return null; }
    // Bare `asNumber()` needs the INPUT literal's declared subtype, which the front end flattened
    // away; only legacy's constant-folding path can answer it.
    if (!spec) return null;
    // A `bigdecimal` target keeps its exact TEXT carrier — casting would be the lossy answer.
    const expr = spec.as === 'bigdecimal' ? v : { kind: 'cast', arg: v, to: spec.int ? 'int' : 'real' } as Expr;
    return { expr, type: STATIC(spec.as) };
  }

  if (step.name === 'asDate') {
    // Internal datetime IS epoch-millis: an integer/real value already is, a text value is ISO-8601
    // and `unixepoch` resolves any offset into the instant.
    return {
      expr: {
        kind: 'case',
        whens: [[{ kind: 'in-list', expr: call('typeof', v), values: [text('integer'), text('real')] },
          { kind: 'cast', arg: v, to: 'int' }]],
        else: { kind: 'binary', op: '*', left: call('unixepoch', v), right: int(1000) },
      },
      type: STATIC('datetime'),
    };
  }

  if (step.name === 'dateAdd') {
    // second/minute/hour/day are FIXED-WIDTH, so date arithmetic is pure integer millis — no SQLite
    // date functions, and no calendar to get wrong.
    if (typeof args[1] !== 'number') return null;
    let factor;
    try { factor = dtFactor(args[0]); } catch { return null; }
    return { expr: { kind: 'binary', op: '+', left: v, right: int(args[1] * factor) }, type: STATIC('datetime') };
  }

  if (step.name === 'dateDiff') {
    // Only a datetime LITERAL operand: the `constant(…)` nested form is legacy's to fold (it parses a
    // child chain, which a pure expression module has no business doing), and any other nested body is
    // the correlated-child seam's.
    if (typeof args[0] !== 'number') return null;
    return { expr: { kind: 'binary', op: '-', left: v, right: int(args[0]) }, type: STATIC('long') };
  }

  return null;
}
