import { compilerInt, compilerNull, compilerText, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { isNested, argValues } from '../../gremlin/frontend.ts';
import { JAVA_WHITESPACE } from '../plan/plan.ts';
import { dtFactor, numericSpec } from '../../gremlin/coerce.ts';
import { STATIC, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { meta, typeOf, type Minter } from './build.ts';
import { recursiveViolation } from '../../rel/recursive.ts';

/**
 * THE SCALAR TRANSFORM VOCABULARY — `v -> v'`, as RelIR expressions.
 *
 * The third vocabulary module, after `predicate.ts` (`P`/`TextP`) and `modulator.ts` (`by()`), and
 * chosen the same way: the blocker table (`mise run rel-blockers`) ranked this family third at **153
 * traversals over EIGHTEEN step names**, largest member `asNumber` at 60. No per-step count could show
 * that, and no per-step increment would have paid for the parse — which is §6·6's whole argument.
 *
 * They are one lowering because they ask one question: an expression over the traverser's value, plus
 * (for the casts only) a change to the FRAMING type. Nothing else about the relation moves — no
 * channel, no cardinality, no shape — which is why the family lands as a table and not as a fold.
 *
 * The two rules are the other vocabularies', unchanged: it DECLINES rather than throwing, and it never
 * answers a different question.
 *
 * ## What is shared rather than re-derived
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
 * - **`reverse`** is a correlated recursive relation rather than a scalar function (SQLite has no
 *   `REVERSE`). The scalar-expression form embeds that relation, so it remains one value in / one
 *   value out at this seam; the list form is a separate list-order operation.
 * - **`concat` with a traversal argument** — a per-traverser CHILD value, so the step is a row boundary
 *   rather than a value transform. It belongs to whichever seam grows the correlated child.
 * - **bare `asNumber()`** — the output subtype is the INPUT literal's declared type, which the front end
 *   has already flattened away; only a constant-folding path can answer it at all, so this declines.
 * - **`asBool`** — TinkerPop's parse errors (`Can't parse 'x' as Boolean.`) cannot be raised from SQL,
 *   so it must be evaluated at COMPILE time over an inject literal. That is a fold over a `Values` node,
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
 * floor — and is the right answer for the string family: `g.V().values('name').toUpper()` frames
 * `unknown`, `asString()` included.
 */
export interface Transformed {
  readonly expr: Expr;
  readonly type?: ScalarType;
}

const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
/** A value the USER wrote, which may be a wire parameter: `argValues` flattened the `Arg` away, so
 *  the name is not reachable here and it binds. Threading the name is
 *  `docs/archive/2026-08-05-parameters-are-the-only-binds.md`'s remaining work, not this module's. */
const text = (value: string): Expr => lit(value, 'text');
const int = (value: number): Expr => lit(value, 'int');
/** A value the COMPILER authored — a whitespace set, an epoch factor, an off-by-one — which is a
 *  CONSTANT and inlines at zero cost to the 100-parameter budget. `mise run sql-hygiene`'s `bound`
 *  ratchet is what catches one of these leaking back into a bind, and it caught `dateAdd`'s. */
const held = (value: string): Expr => compilerText(value);
const heldInt = (value: number): Expr => compilerInt(value);

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
  trim: (v) => call('trim', v, held(JAVA_WHITESPACE)),
  lTrim: (v) => call('ltrim', v, held(JAVA_WHITESPACE)),
  rTrim: (v) => call('rtrim', v, held(JAVA_WHITESPACE)),
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
      ? call('MIN', heldInt(at), length())
      : call('MAX', heldInt(0), {
        kind: 'binary', op: '%',
        left: { kind: 'binary', op: '+', left: length(), right: heldInt(at) },
        right: length(),
      });
    const newStart = index(start);
    const from = { kind: 'binary', op: '+', left: newStart, right: heldInt(1) } as Expr;
    if (end === undefined) return call('substr', v, from);
    const newEnd = index(end);
    // AN EMPTY SLICE IS ARITHMETIC, NOT A BRANCH: `substr(x, from, 0)` is already `''`, so clamping the
    // length at zero answers exactly what the `CASE WHEN newEnd <= newStart THEN ''` guard did —
    // verified equal over NULL, `''`, inverted ranges, negative indices and out-of-range bounds.
    // The guard spelled both bounds a second time, and each bound embeds `length(v)`, so a subject that
    // is a correlated property subquery was emitted SIX times for one `substring(0,1)`; this is four.
    // Bind-budget correctness rather than tidiness — see `storedValueOn` for the measured case.
    return call('substr', v, from,
      call('MAX', heldInt(0), { kind: 'binary', op: '-', left: newEnd, right: newStart }));
  },
  concat: (v, args) => {
    // A traversal argument is a per-traverser child value (`TraversalUtil.apply`), which makes the step
    // a row boundary rather than a value transform. There is no caller resolving it to an Expression
    // here, so decline rather than drop the argument.
    if (args.some(isNested)) return null;
    // A NULL ARGUMENT IS SKIPPED, and the reference says so in its own comment: "all null values are
    // skipped during appending, as StringBuilder will otherwise append 'null' as a string"
    // (`vendor/tinkerpop/gremlin-core/.../step/map/ConcatStep.java`, `map`). So `concat(null)` is the
    // traverser's own value, which is what dropping the argument gives — and the all-null guard below
    // still yields NULL for a null traverser, because it is computed over the remaining parts.
    args = args.filter((a) => a !== null);
    if (!args.length) return v;
    const operands = args.map((a) => (typeof a === 'string' ? text(a) : typeof a === 'number' ? lit(a, 'real') : null));
    if (operands.some((o) => !o)) return null;
    const parts = [v, ...operands as Expr[]];
    const body = call('concat_ws', held(''), ...parts);
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
 *  over a compile-time literal they are a fold and not this module's cast. See `transformExpr`.
 *
 *  `dateAdd`/`dateDiff` are deliberately NOT here, and the difference
 *  is the reason: their fold is an OPTIMIZATION (one bind instead of a literal plus an offset), not a
 *  semantic requirement — the arithmetic answers identically, verified row-for-row. Constant folding is
 *  a `Pass` over `Values` + `Lit` (§4), and declining because that pass is unwritten is exactly the
 *  reasoning that makes coverage stall. Measured: including them costs 7 corpus traversals. */
const CONSTANT_FOLDED = new Set(['asNumber', 'asDate', 'asBool']);

/** Every name in this family, whether or not it is covered — the set a fold checks membership in
 *  BEFORE asking for a lowering, so an unlowerable member ends the transform run rather than falling
 *  through to some other arm's interpretation of it. */
export const REL_TRANSFORMS: ReadonlySet<string> = new Set([
  ...Object.keys(VALUE_TX), 'asNumber', 'asDate', 'dateAdd', 'dateDiff', 'reverse', 'asBool',
]);

/**
 * A scalar transform over `v`, or `null` to decline.
 *
 * `Scope.local` is deliberately NOT checked: a scalar IS a one-element list, so per-element and
 * per-list are the same question and the token is a no-op. That is a
 * semantic fact about this family, not a shortcut; a LIST stream's local transform is a different
 * lowering entirely and never reaches here.
 */
export function transformExpr(step: IRStep, v: Expr, literal: boolean, fresh: Minter): Transformed | null {
  const args = argValues(step);

  // OVER A COMPILE-TIME LITERAL, THE CAST SUBFAMILY IS NOT A SQL CAST AT ALL — it is a parse that must
  // RAISE, and SQL cannot raise. TinkerPop requires `Can't parse string '1,000' as number.` and
  // `Can't convert number of type Integer to Byte due to overflow.`; a SQLite `CAST` answers `1` and
  // `300` instead, so lowering it here turns a REQUIRED ERROR into a plausible value — the worst
  // direction the "never answer a different question" rule has. The correct handling is a compile-time
  // fold (`asNumberConst`/`asDateConst`/`asBoolConst`), so this declines rather than lower a cast.
  //
  // Found by L3: six official scenarios assert the ERROR, and comparing result rows cannot see a missing
  // throw. The string transforms are unaffected — `toUpper()` of a
  // literal has no parse to fail — so the decline is the cast subfamily and not the family.
  if (literal && CONSTANT_FOLDED.has(step.name)) return null;

  const pure = VALUE_TX[step.name];
  if (pure) {
    const expr = pure(v, args);
    // No static type, `asString` included. That looks wrong for a `CAST(… AS TEXT)` and is not: the
    // framing `UNKNOWN` infers per VALUE, which for a text value is `string` anyway, so it frames
    // correctly — and CLAIMING a type here where none is warranted would be the worse error. A
    // semantic improvement to the tag is a separate change.
    return expr && { expr };
  }

  if (step.name === 'reverse') {
    // `ReverseStep` is identity for non-strings and null, and reverses a string character-by-
    // character (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/
    // traversal/step/map/ReverseStep.java:49-65`). SQLite has no reverse scalar function, but its
    // recursive CTE is exactly the loop the reference spells: peel the first character and prepend it
    // to the accumulator. The seed is CORRELATED to `v`, which `Expr.scalar` renders in the outer row's
    // scope; a RelIR recursive node is therefore an ordinary scalar `WITH RECURSIVE`,
    // not a graph walk or a new cross-row operation.
    const cols = typeOf(meta('s', 'any', true), meta('r', 'text', true));
    const id = fresh('rev');
    const reversed = make.recursive({
      id, name: `rv_${id}`, channels: [], type: cols, cols: cols.cols.map((column) => column.name),
      seed: make.values({ id: fresh('rvs'), channels: [], type: cols, rows: [[v, compilerText('')]] }),
      step: (self) => {
        const pending = make.filter({
          id: fresh('rvf'), input: self, channels: [], type: cols,
          pred: { kind: 'binary', op: '!=', left: { kind: 'col', rel: self.id, name: 's' }, right: compilerText('') },
        });
        return make.project({
          id: fresh('rvp'), input: pending, channels: [], type: cols,
          exprs: [
            ['s', { kind: 'call', fn: 'substr', args: [{ kind: 'col', rel: pending.id, name: 's' }, compilerInt(2)] }],
            ['r', { kind: 'binary', op: '||', left: { kind: 'call', fn: 'substr', args: [{ kind: 'col', rel: pending.id, name: 's' }, compilerInt(1), compilerInt(1)] }, right: { kind: 'col', rel: pending.id, name: 'r' } }],
          ],
        });
      },
    });
    if (recursiveViolation(reversed)) return null;
    const done = make.filter({
      id: fresh('rvd'), input: reversed, channels: [], type: cols,
      pred: { kind: 'binary', op: '=', left: { kind: 'col', rel: reversed.id, name: 's' }, right: compilerText('') },
    });
    const result = make.project({
      id: fresh('rvr'), input: done, channels: [], type: typeOf(meta('v', 'any', true)),
      exprs: [['v', { kind: 'col', rel: done.id, name: 'r' }]],
    });
    return {
      expr: {
        kind: 'case',
        whens: [[{ kind: 'binary', op: '=', left: { kind: 'call', fn: 'typeof', args: [v] }, right: compilerText('text') }, { kind: 'scalar', plan: result }]],
        else: v,
      },
    };
  }

  if (step.name === 'asNumber') {
    // `numericSpec` THROWS for a non-numeric token (`asNumber(GType.VERTEX)`), which is a real error —
    // so it is caught into a decline (a miss raised as `UnsupportedTraversal`) rather than thrown here.
    let spec;
    try { spec = numericSpec(args[0]); } catch { return null; }
    // Bare `asNumber()` needs the INPUT literal's declared subtype, which the front end flattened
    // away; only a constant-folding path can answer it.
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
        whens: [[{ kind: 'in-list', expr: call('typeof', v), values: [held('integer'), held('real')] },
          { kind: 'cast', arg: v, to: 'int' }]],
        else: { kind: 'binary', op: '*', left: call('unixepoch', v), right: heldInt(1000) },
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
    return { expr: { kind: 'binary', op: '+', left: v, right: heldInt(args[1] * factor) }, type: STATIC('datetime') };
  }

  if (step.name === 'dateDiff') {
    // Only a datetime LITERAL operand: the `constant(…)` nested form is a constant-folding pass's to
    // handle (it parses a child chain, which a pure expression module has no business doing), and any
    // other nested body is the correlated-child seam's.
    if (typeof args[0] !== 'number') return null;
    return { expr: { kind: 'binary', op: '-', left: v, right: int(args[0]) }, type: STATIC('long') };
  }

  return null;
}
