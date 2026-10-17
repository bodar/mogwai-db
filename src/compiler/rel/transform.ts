import { compilerInt, compilerNull, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import { isNested } from '../../gremlin/frontend.ts';
import { constLit } from './const.ts';
import { raiseExpr } from '../../rel/raise.ts';
import { SAFE_INT } from './reducer.ts';
import type { Minter } from './build.ts';
import { doubleDecimalText, FLOAT_MAX, floatRoundedOf, floatShortest } from './float.ts';
import { dateDiffOtherMs, dtFactor, isDateDiffConstant, numericSpec } from '../../gremlin/coerce.ts';
import { STATIC, staticIsText, staticTypeOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { ValueType } from '../../gremlin/types.ts';
import type { IRStep } from '../ir/step.ts';
import { asStringOf, type ValueEvidence } from './receiver.ts';

// The Number family, as `GremlinValueComparator` treats it — one ordered type (§6·7). Bare
// `asNumber()` over a value ALREADY in this family is TinkerPop's IDENTITY (`AsNumberStep.map`:
// `object instanceof Number` returns it unchanged), so over a stream framed with one of these tags
// it needs no cast and cannot raise — the value is the same, the tag is the same.
const NUMBER_FAMILY: ReadonlySet<ValueType> = new Set<ValueType>([
  'byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal',
]);

// Java's whitespace set — the exact code points `String.trim()`/`strip()`/the Gremlin `trim` family
// remove. Excludes the non-breaking spaces (U+00A0 NBSP, U+2007 figure, U+202F narrow NBSP), which
// Java also excludes; includes U+3000 ideographic space (the suite's fullwidth-space case). SQLite
// trim(x, set) removes any char in `set`. Built from explicit code points so the source carries no
// literal control/space chars. Lives here because `VALUE_TX`'s trim family is its only consumer.
const JAVA_WHITESPACE = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000,
].map((c) => String.fromCharCode(c)).join("");

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
 * `numericSpec` and `dtFactor` are imported (a GType's numeric range, a DT unit's millisecond factor);
 * `JAVA_WHITESPACE` is defined just below. They are DATA and pure computation — not SQL — so there is
 * nothing to re-express and a second copy would be a second thing to keep in step. Only the EMISSION is
 * re-expressed here, which is the boundary the whole migration draws (§2). The whitespace list is the
 * clearest case: `trim()` in Gremlin trims Java's whitespace set, not SQLite's space, and a re-derived
 * list that missed U+1680 would be wrong in a way no test would name.
 *
 * ## What declines, each for its own reason
 *
 * - **`reverse`** is a value-transform BARRIER over a scalar stream (`compiler/rel/reverse.ts`,
 *   substrate A — a JS map re-injected as a `json_each` value source), not a scalar expression here;
 *   the list form is a separate list-order operation (`list.ts`).
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
  /** Where `expr` carries an inline raising fence (`asNumberCast`): the unfenced value and the fence as a
   *  filter predicate, for a host that can apply it as a WHERE (`asNumberFilter`). */
  readonly fenced?: { readonly value: Expr; readonly filter: Expr };
}

const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
/** A value the COMPILER authored — a whitespace set, an epoch factor, an off-by-one — which is a
 *  CONSTANT and inlines at zero cost to the 100-parameter budget. `mise run sql-hygiene`'s `bound`
 *  ratchet is what catches one of these leaking back into a bind, and it caught `dateAdd`'s. */
const held = (value: string): Expr => compilerText(value);
const heldInt = (value: number): Expr => compilerInt(value);

/** The deferral a RUNTIME `asNumber(GType.X)` raises mid-statement (`raiseExpr`) where a SQLite `CAST`
 *  would answer a value the reference does not. No quote — `raiseExpr` cannot carry one, which is one
 *  reason this is a deferral and not `NumberHelper`'s own message. */
export const AS_NUMBER_INEXACT = 'asNumber of a value it cannot convert exactly is not supported';

type NumericSpec = NonNullable<ReturnType<typeof numericSpec>>;
const bin = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
/** 2^63 as a double — the first magnitude `CAST(… AS INTEGER)` CLAMPS rather than converts. */
const LONG_EDGE = 9223372036854775808;
/** `Double.MAX_VALUE` (`Float.MAX_VALUE` is the float authority's, `float.ts`). */
const DOUBLE_MAX = Number.MAX_VALUE;

/**
 * `asNumber(GType.X)` over a RUNTIME value — the `CAST`, fenced where a SQLite `CAST` and
 * `NumberHelper.performConversion` disagree
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:724-800`).
 * Inside the fence the cast IS the reference: an integral target truncates toward zero exactly as
 * `longValue`/`intValue` do, and a floating target is the same double.
 *
 * - **OUT OF RANGE.** The reference THROWS (`Can't convert number of type … due to overflow.`, `:766`; an
 *   infinity's `:775`), where the framer crashed on the unencodable value
 *   (`math('_*100000000').asNumber(GType.INT)` reached the user as a Node `RangeError`), `CAST` CLAMPED a
 *   double past 2^63 to `Long.MAX_VALUE`, or a double past `Float.MAX_VALUE` became `Infinity`. A
 *   bounded target (byte/short/int, each `[-(m+1), m]`) is out of range once the TRUNCATED value `t` is,
 *   i.e. `|2t + 1| > 2m + 1` — one spelling of the value, and exact because SQLite moves an overflowing
 *   `2t` to REAL rather than wrapping it. An unbounded integral target is out of range only for a
 *   NON-integer storage class at or past 2^63 (an INTEGER is an int64 by construction). A float target
 *   past `Float.MAX_VALUE` and finite throws; an infinity passes through, as `:740` lets it.
 * - **TEXT.** The reference PARSES a string, and throws when it cannot (`Can't parse string … as number.`);
 *   `CAST('marko' AS INTEGER)` is `0`. A text that round-trips through `CAST AS INTEGER` is exactly an
 *   integer spelling (a stored wide `long`, `"42"`), on which the two agree; any other non-number declines.
 *
 * The fence RAISES a deferral (`raiseExpr`) rather than the reference's message: that message names the
 * value's Java class, which a storage class does not always know. Inline, so it covers every depth
 * `transformExpr` reaches — the scalar tail, a `by()` body, a list member. `integersGuarded` is the one
 * caller (a reducer result, `lower.ts`) that already raises the reference's exact message for an
 * INTEGER out of a bounded range, so the fence leaves those rows to it. `nativeNumber` says the value is
 * KNOWN to be a native INTEGER/REAL (a numeric static type not carried as text, a reducer result), which
 * makes the TEXT arm unreachable, so it is not spelled.
 */
/** The framing type of a run-time `asNumber(GType.X)` result: a `long`/`bigint` rides as decimal TEXT past
 *  2^53 and a `bigdecimal` always (its carrier, `asNumberParts`), so both are TEXT-carried. One spelling for
 *  the transform and the reducer-result arm (`lower.ts`). */
export const asNumberType = (spec: NumericSpec): ScalarType =>
  STATIC(spec.as, spec.as === 'long' || spec.as === 'bigint' || spec.as === 'bigdecimal');

/** What a run-time BigDecimal widening needs beyond the value: whether its CLASS is floating — a Double or
 *  a Float by its tag (statically, or per row), which a whole Double STORED as an INTEGER is and its storage
 *  class alone would not say — and the minter its carrier (`doubleDecimalText`) is built with. */
export type DecimalSource = { readonly fresh: Minter; readonly floating: boolean | Expr };

/** A static or per-row class tag naming a Double or a Float. */
export const floatingTag = (tag: Expr): Expr => ({ kind: 'in-list', expr: tag, values: [held('double'), held('float')] });

const requiredDecimal = (decimal: DecimalSource | undefined): DecimalSource => {
  if (!decimal) throw new Error('asNumber(GType.BIGDECIMAL) at run time needs its source class for its decimal carrier');
  return decimal;
};

export function asNumberCast(v: Expr, spec: NumericSpec, integersGuarded = false, nativeNumber = false, sourceFloat: FloatSource = false, decimal?: DecimalSource): Expr {
  const { value, refuse } = asNumberParts(v, spec, integersGuarded, nativeNumber, sourceFloat, decimal);
  return refuse ? { kind: 'case', whens: [[refuse, raiseExpr(AS_NUMBER_INEXACT, v)]], else: value } : value;
}

/** The same fence as a FILTER predicate: true where the row converts exactly, a raise where it does not.
 *  A position that consumes only a value's EXISTENCE — an `EXISTS` body (`where`/`not`/`filter`, a
 *  `choose` condition) or a `count()` — never reads the value, so SQLite never evaluates an inline fence
 *  there; a WHERE is evaluated for every row it admits, so the fence holds at every depth. */
export const asNumberFilter = (v: Expr, refuse: Expr): Expr =>
  ({ kind: 'case', whens: [[refuse, raiseExpr(AS_NUMBER_INEXACT, v)]], else: compilerInt(1) });

/** The two halves of `asNumberCast`: the converted `value`, and the `refuse` condition (or null). */
/** WHETHER a value is a Float — never (`false`), statically, or per row by its tag — with the minter its
 *  printing (`floatShortest`, a correlated read) is built with. */
export type FloatSource = false | { readonly isFloat: true | Expr; readonly fresh: Minter };

/** A value read as a Float PRINTS it — `Float.toString`'s value (`floatShortest`) — where it is one, and is
 *  itself otherwise. */
export function floatPrinted(v: Expr, source: FloatSource): Expr {
  if (source === false) return v;
  const shortest = floatShortest({ kind: 'cast', arg: v, to: 'real' }, source.fresh);
  return source.isFloat === true ? shortest : { kind: 'case', whens: [[source.isFloat, shortest]], else: v };
}

export function asNumberParts(v: Expr, spec: NumericSpec, integersGuarded = false, nativeNumber = false, sourceFloat: FloatSource = false, decimal?: DecimalSource): { readonly value: Expr; readonly refuse: Expr | null } {
  // A FLOAT source widens to a Double or a BigDecimal through `Float.toString` — its SHORTEST decimal,
  // not its exact value (`NumberHelper.java:742-745,851-859`); every other target reads the exact value.
  const read: Expr = sourceFloat !== false && (spec.as === 'double' || spec.as === 'bigdecimal')
    ? floatPrinted(v, sourceFloat) : v;
  const asReal: Expr = { kind: 'cast', arg: read, to: 'real' };
  const notInteger = bin('!=', call('typeof', v), held('integer'));
  const notFloating = bin('!=', call('typeof', v), held('real'));
  const abs = call('abs', { kind: 'cast', arg: v, to: 'real' });
  // A Float target is the value ROUNDED to a float (`floatRoundedOf`) — the exact carrier every Float rides
  // as; an infinity passes through as itself (`:736-738`).
  // A BigDecimal target lands on the reference's SCALE (`NumberHelper.java:850-859`): a floating source — by
  // its class tag, or a REAL — is `BigDecimal.valueOf(Double.toString(d))` (a Float's `Float.toString`), its
  // decimal-TEXT carrier (`doubleDecimalText` — a bare REAL frames `100.0` as scale 0); an integral source
  // is `BigDecimal.valueOf(long)`, scale 0, which the INTEGER itself already frames; a text carrier is one.
  // The source `v` is read, not `read`: the Float's printing happens once inside the carrier.
  const cast: Expr = spec.as === 'bigdecimal'
    ? ((): Expr => {
      const { fresh, floating } = requiredDecimal(decimal);
      const float = sourceFloat === false ? false : sourceFloat.isFloat;
      const carrier = doubleDecimalText(v, fresh, float);
      if (floating === true || float === true) return carrier;
      const isReal = bin('=', call('typeof', v), held('real'));
      const when = [floating, float].reduce<Expr>((acc, c) => (c === false ? acc : bin('or', c as Expr, acc)), isReal);
      return { kind: 'case', whens: [[when, carrier]], else: v };
    })()
    : spec.as === 'float' ? { kind: 'case', whens: [[bin('>', abs, compilerReal(DOUBLE_MAX)), asReal]], else: floatRoundedOf(asReal) }
      : { kind: 'cast', arg: read, to: spec.int ? 'int' : 'real' };
  const notANumber = bin('and',
    { kind: 'unary', op: 'not', arg: { kind: 'in-list', expr: call('typeof', v), values: [held('integer'), held('real'), held('null')] } },
    bin('is not', { kind: 'cast', arg: { kind: 'cast', arg: v, to: 'int' }, to: 'text' }, v));
  const range: Expr | null = spec.int && spec.min !== undefined
    ? ((): Expr => {
      const twice = bin('+', bin('*', compilerInt(2), { kind: 'cast', arg: v, to: 'int' }), compilerInt(1));
      const out = bin('>', call('abs', twice), compilerInt(2 * spec.max! + 1));
      return integersGuarded ? bin('and', notInteger, out) : out;
    })()
    : spec.int ? bin('and', notInteger, bin('>=', abs, compilerReal(LONG_EDGE)))
      // A float target past `Float.MAX_VALUE` and finite throws (`:736-741`); an integer past 2^53, which
      // `CAST … AS REAL` would round once already before the float rounding, defers. A subnormal rounds on
      // the float grid exactly (`floatRoundedOf`).
      : spec.as === 'float' ? bin('or', bin('and', bin('>', abs, compilerReal(FLOAT_MAX)), bin('<=', abs, compilerReal(DOUBLE_MAX))),
        bin('and', notFloating, bin('>=', abs, compilerReal(2 ** 53))))
        : null;
  const refuse = nativeNumber ? range : range ? bin('or', notANumber, range) : notANumber;
  // A `long`/`bigint` target past 2^53 rides as decimal TEXT, the carrier every wide long has: a native
  // int64 that wide is read back through a JS number and loses its low bits, where `performConversion`
  // returns a Long source unchanged (`NumberHelper.java:725-727`).
  const value: Expr = spec.as === 'long' || spec.as === 'bigint'
    ? { kind: 'case', whens: [[
      { kind: 'unary', op: 'not', arg: bin('and', bin('>=', cast, compilerInt(-SAFE_INT)), bin('<=', cast, compilerInt(SAFE_INT))) },
      { kind: 'cast', arg: cast, to: 'text' }]], else: cast }
    : cast;
  return { value, refuse };
}

/**
 * The PURE value transforms — a SQLite scalar function over `v`, and nothing else.
 *
 * NULL propagates through every one of them (SQLite's own semantics), which is exactly Gremlin's
 * null-in/null-out, so none needs a guard. `concat` is the one exception and says why inline.
 *
 * LITERAL-ONLY TODAY — every argument in this family is a LITERAL, never a user `$param`, so args
 * inline as typed SQL literals and none spends a bind. This is literal-only in TinkerPop *end to end*
 * at our pin: the grammar uses the `*Literal` productions (`stringNullableLiteral`/`integerLiteral`/
 * `dateLiteral` — no `variable` alternative), AND `GraphTraversal` exposes no `GValue` overload for
 * `concat`/`replace`/`split`/`substring`/`format`/`dateAdd`/`dateDiff` (only raw `String`/`int`/`Date`),
 * so `concat($x)`/`replace($x,$y)` do not PARSE. Consequence: a "a param is being wrongly inlined here,
 * route it through `constLit`'s name-branch" fix in this family is a PHANTOM against what the front-end
 * can hand us today — the parameter branch is unreachable (a 2026-08-30 session nearly shipped exactly
 * that). NOT a permanent wall: unlike `inject` — a grammar-only gap we widened to reach an existing
 * `inject(Object...)` capability (`patches/upstream/tinkerpop-06-…`) — parameterizing this family needs
 * NEW upstream `GValue` overloads on `GraphTraversal` + the step constructors, not just a grammar widen.
 * It reads as incomplete GValue rollout, not a principled exclusion (an upstream enhancement candidate).
 * If those overloads ever land, THIS is where the `$param` branch would light up.
 */
const VALUE_TX: Readonly<Record<string, (v: Expr, args: readonly unknown[], step: IRStep) => Expr | null>> = {
  length: (v) => call('length', v),
  toUpper: (v) => call('upper', v),
  toLower: (v) => call('lower', v),
  // Gremlin's `trim()` trims JAVA's whitespace set, not SQLite's default space — hence the explicit
  // second argument, and hence importing the list rather than restating it.
  trim: (v) => call('trim', v, held(JAVA_WHITESPACE)),
  lTrim: (v) => call('ltrim', v, held(JAVA_WHITESPACE)),
  rTrim: (v) => call('rtrim', v, held(JAVA_WHITESPACE)),
  replace: (v, _args, step) => {
    // The `from`/`to` STRINGS the user wrote route through `constLit`: a `$param` binds (a real
    // parameter, named and cache-shared), a literal INLINES — the Golden Rule, matching the write path.
    // `transformExpr` holds the `step`, so the Arg name was never actually lost; the old `text = lit()`
    // that bound every literal is gone.
    // The from/to are the only string-or-null args; a leading `Scope.local` token (a scalar is a
    // one-element list, so per-element replace over a scalar is the global one — see the header note)
    // rides in `step.args` and is skipped here, exactly as the old string-only filter did.
    const [fromArg, toArg] = step.args.filter((a) => typeof a.value === 'string' || a.value === null);
    if (!fromArg || !toArg) return null;
    // A NULL search or replacement is a NO-OP — the original value is returned unchanged
    // (`vendor/tinkerpop/gremlin-core/.../step/map/ReplaceGlobalStep.java:31-32,60`: "Any null arguments
    // will be a no-op … StringUtils.replace" returns the text unchanged for a null searchString/
    // replacement). Identity, not a decline: `replace(null,"g")` leaves "lop"/"ripple" as they are. A
    // null traverser VALUE also stays null (`replace(NULL,…)` is NULL in SQLite), so `v` is right for both.
    if (fromArg.value === null || toArg.value === null) return v;
    if (typeof fromArg.value !== 'string' || typeof toArg.value !== 'string') return null;
    const from = constLit(fromArg), to = constLit(toArg);
    return from && to ? call('replace', v, from, to) : null;
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
    // A concat argument is a PARSED LITERAL from the Gremlin string, so it INLINES as a typed SQL
    // literal — it is a constant the compiler holds, never a user parameter, so it must not spend a bind
    // (the root `CLAUDE.md` bind rule). Left as a `'bound'` `lit()` it did, and a `select(Pop.all)` that
    // re-projects the concatenation then paid for each copy — 6 binds for two literals.
    const operands = args.map((a) => (typeof a === 'string' ? compilerText(a) : typeof a === 'number' ? compilerReal(a) : null));
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

/** The cast subfamily — `ScalarMapStep`s whose parse/overflow errors SQL cannot raise, so over a
 *  compile-time literal they are a fold and not this module's cast (`transformExpr`). Each also raises
 *  over a NON-SCALAR traverser (a list/map can be parsed as neither number, bool nor date —
 *  `AsNumberStep.map` throws *"Can't parse type ArrayList as number."*), so a collection-literal inject
 *  fed straight to one routes through the same fold rather than the collection-shape source (`lower.ts`
 *  inject dispatch).
 *
 *  `dateAdd`/`dateDiff` are deliberately NOT here, and the difference
 *  is the reason: their fold is an OPTIMIZATION (one bind instead of a literal plus an offset), not a
 *  semantic requirement — the arithmetic answers identically, verified row-for-row. Constant folding is
 *  a `Pass` over `Values` + `Lit` (§4), and declining because that pass is unwritten is exactly the
 *  reasoning that makes coverage stall. Measured: including them costs 7 corpus traversals. */
export const CONSTANT_FOLDED: ReadonlySet<string> = new Set(['asNumber', 'asDate', 'asBool']);

/** Every name in this family, whether or not it is covered — the set a fold checks membership in
 *  BEFORE asking for a lowering, so an unlowerable member ends the transform run rather than falling
 *  through to some other arm's interpretation of it. */
export const REL_TRANSFORMS: ReadonlySet<string> = new Set([
  ...Object.keys(VALUE_TX), 'asString', 'asNumber', 'asDate', 'dateAdd', 'dateDiff', 'asBool',
]);

/**
 * A scalar transform over `v`, or `null` to decline.
 *
 * `Scope.local` is deliberately NOT checked: a scalar IS a one-element list, so per-element and
 * per-list are the same question and the token is a no-op. That is a
 * semantic fact about this family, not a shortcut; a LIST stream's local transform is a different
 * lowering entirely and never reaches here.
 */
export function transformExpr(
  step: IRStep, v: Expr, literal: boolean, fresh: Minter, incoming?: ScalarType, evidence?: ValueEvidence,
): Transformed | null {
  const args = step.args.map((a) => a.value);

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

  // `asString()` is `String.valueOf`, a function of the receiver's TYPE rather than its storage class —
  // rendered by the receiver authority from the caller's evidence (`asStringOf`), declined without any.
  // No static type on the result: the framing `UNKNOWN` infers per VALUE, which for text is `string`.
  if (step.name === 'asString') {
    const expr = evidence ? asStringOf(v, evidence, fresh) : null;
    return expr && { expr };
  }

  const pure = VALUE_TX[step.name];
  if (pure) {
    const expr = pure(v, args, step);
    // No static type: the framing `UNKNOWN` infers per VALUE, which for a text value is `string`
    // anyway, so it frames correctly — and CLAIMING a type here where none is warranted would be the
    // worse error.
    return expr && { expr };
  }

  // `reverse()` over a SCALAR value stream is a value-transform BARRIER now (`compiler/rel/reverse.ts`,
  // substrate A) — the JS map is smaller SQL, ~2× faster, and reverses lists the string-only recursive
  // CTE that stood here could not. So the CTE is gone; this seam no longer handles reverse. A NESTED
  // scalar reverse (in a child body, where a barrier cannot segment) is a fail-closed deferral, and the
  // LIST form stays its own list-order operation (`list.ts`).

  if (step.name === 'asNumber') {
    // `numericSpec` THROWS for a non-numeric token (`asNumber(GType.VERTEX)`), which is a real error —
    // so it is caught into a decline (a miss raised as `UnsupportedTraversal`) rather than thrown here.
    let spec;
    try { spec = numericSpec(args[0]); } catch { return null; }
    // Bare `asNumber()` over a compile-time LITERAL needs the input's declared subtype, which the
    // front end flattened away — the const-fold path (`foldConstantCoercions`) answers that. But over
    // a RUNTIME stream already framed with a numeric or datetime tag, the answer is the reference's
    // own identity: `AsNumberStep.map` returns a `Number` unchanged (numeric family → same value, same
    // type) and a `Date`/`OffsetDateTime` as its epoch-milli Long — and our datetime IS epoch-millis
    // already, so both are the value UNCHANGED, differing only in the framing tag (datetime → long,
    // `coerce.ts foldConstantCoercions`' same retype). A non-numeric known type (string/boolean/uuid/…)
    // could RAISE per value and SQL cannot, so it still declines to the guard's future increment.
    if (!spec) {
      const known = staticTypeOf(incoming);
      if (known && NUMBER_FAMILY.has(known)) return { expr: v, type: STATIC(known, staticIsText(incoming)) };
      if (known === 'datetime') return { expr: v, type: STATIC('long') };
      return null;
    }
    // A `bigdecimal` target keeps its exact TEXT carrier — casting would be the lossy answer. Every
    // target is fenced where the cast and the reference disagree (`asNumberCast`).
    const known = staticTypeOf(incoming);
    const native = !!known && NUMBER_FAMILY.has(known) && !staticIsText(incoming);
    // A Float source PRINTS into a Double or BigDecimal target (`floatPrinted`): statically, or per row by
    // its tag (the receiver evidence — `evidenceOf`).
    const floatTag = evidence?.kind === 'static' ? evidence.tag === 'float' : known !== undefined ? known === 'float'
      : evidence?.kind === 'tag' ? bin('=', evidence.tag, held('float')) : false;
    const sourceFloat: FloatSource = floatTag === false ? false : { isFloat: floatTag, fresh };
    const floating = evidence?.kind === 'static' ? evidence.tag === 'double' || evidence.tag === 'float'
      : known !== undefined ? known === 'double' || known === 'float'
      : evidence?.kind === 'tag' ? floatingTag(evidence.tag) : false;
    const decimal: DecimalSource = { fresh, floating };
    const { value, refuse } = asNumberParts(v, spec, false, native, sourceFloat, decimal);
    // A wide `long`/`bigint` result is decimal TEXT (`asNumberParts`), so its class is TEXT-carried.
    const type = asNumberType(spec);
    return refuse
      ? { expr: asNumberCast(v, spec, false, native, sourceFloat, decimal), type, fenced: { value, filter: asNumberFilter(v, refuse) } }
      : { expr: value, type };
  }

  if (step.name === 'asBool') {
    // `AsBoolStep.map` (`vendor/tinkerpop/.../map/AsBoolStep.java:38-54`) is TOTAL only over the shapes
    // SQL can decide without raising: a Boolean is itself, and a Number is `NaN → false else != 0`. A
    // String parses `true`/`false` (case-insensitive, trimmed) and RAISES on anything else; a null and a
    // list/map RAISE too — none of which SQL can do, so those decline to the runtime-guard increment. Over
    // a RUNTIME stream already framed numeric or boolean, only the total arms are reachable:
    const known = staticTypeOf(incoming);
    // A `NaN != 0` is not-true in SQLite, so the `!= 0` CASE gives `NaN → false` for free — the exact
    // reference rule. A boolean input is stored as INTEGER 0/1, so `!= 0` is also its identity.
    if (known === 'boolean') return { expr: v, type: STATIC('boolean') };
    if (known && NUMBER_FAMILY.has(known)) return {
      expr: { kind: 'case', whens: [[{ kind: 'binary', op: '!=', left: v, right: heldInt(0) }, heldInt(1)]], else: heldInt(0) },
      type: STATIC('boolean'),
    };
    return null;
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
    // The other operand resolves to a millis CONSTANT: a datetime LITERAL, or a `constant(datetime)`/
    // `constant(null)` nested traversal — `dateDiffOtherMs` is the coercion authority for both (it owns
    // `constant(null)` → epoch 0, `= new Date(null)`), so this module reuses it rather than re-parsing a
    // child chain (the §2 boundary — the same reason `dtFactor`/`numericSpec` are imported, not inlined).
    // Any OTHER nested body (`inject(datetime(…))`, a movement) is the correlated-child seam's and stays
    // declined here. `dateDiffOtherMs` THROWS a `ValueParseError` for an unsupported nested form, which
    // is not this arm's decline — so it is asked only for the literal or the recognised constant.
    const isNum = typeof args[0] === 'number';
    if (!isNum && !isDateDiffConstant(args[0], {})) return null;
    // A datetime literal is a PARSED constant (inlines as a typed literal); a folded `constant(null)`→0
    // is COMPILER-AUTHORED — both are constants, neither spends a bind (`heldInt`, the root bind rule).
    return { expr: { kind: 'binary', op: '-', left: v, right: heldInt(dateDiffOtherMs(args[0], {})) }, type: STATIC('long') };
  }

  return null;
}
