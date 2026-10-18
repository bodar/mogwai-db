import { compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { deferralExpr, raiseInRow as raise } from '../../rel/raise.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Minter } from './build.ts';
import { numericSpec } from '../../gremlin/coerce.ts';
import type { ValueType } from '../../gremlin/types.ts';
import type { ScalarType } from '../../sql/kernel/render.ts';
import { GLOBAL_STRING_THROWS, isLocalScope, type IRStep } from '../ir/step.ts';

/**
 * THE RECEIVER-TYPE AUTHORITY — is the value a type-demanding step receives PROVABLY of the type the
 * reference demands, and if it cannot be proven at compile time, what the row must satisfy at run time.
 *
 * The reference RAISES, per traverser, where SQL would silently coerce:
 *
 * - the string family (`toUpper`/`toLower`/`trim`/`lTrim`/`rTrim`/`length`/`substring`/`replace`)
 *   throws `IllegalArgumentException` on a non-null non-String receiver
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ToUpperGlobalStep.java:45-49`,
 *   and its siblings), where SQLite's `upper(29)` answers `'29'`;
 * - `concat()` does the same (`.../step/map/ConcatStep.java:71-76`);
 * - `math()` throws `IllegalStateException` for a PRODUCTIVE variable that is not a Number, null included
 *   (`.../step/map/MathStep.java:69-90`, the message at :86-87), where `CAST('marko' AS REAL)` answers 0
 *   and a NULL was silently dropped as if unproductive;
 * - `asNumber(GType)` parses a String with commons-lang `NumberUtils.createNumber` and raises on any
 *   other non-Number (`.../step/map/AsNumberStep.java:56-75`), and narrows with an overflow exception
 *   (`.../util/NumberHelper.java:724-772`), where `CAST('marko' AS INT)` answers 0 and `CAST(300 AS INT)`
 *   answers a 300 no Byte holds.
 *
 * ONE predicate decides all of them, so the rule is the same at every host that lowers one of these
 * steps — the root scalar fold, a child body's value run (`local`/`map`/`by()`/`where`/branch arms all
 * reach it), and a `math()` variable at any host. Before this, each host either checked nothing or
 * carried its own copy (the list-member guards in `list.ts` are the shape-specific twin and stay there,
 * because a member's type rides in a JSON envelope rather than in a column).
 *
 * The answer is three-valued, and the third value is load-bearing:
 * - **proven** — a static tag of the demanded type: nothing to add;
 * - **refuted** — a static tag of ANOTHER type: the caller DECLINES (a static mismatch is a certain
 *   error, but the reference's message names the Java class, and a decline is the fail-closed half);
 * - **per row** — a stored `vtype` or a storage class: the value is wrapped so that an offending row
 *   RAISES the reference's message in-statement (`raiseExpr`, `src/rel/raise.ts`). A guard statement
 *   (`Binding.guard`) cannot be used here, because the receiver may live in a scope correlated to an
 *   outer row (a `by()` body, a `local()` arm), which only an expression can reach.
 *
 * Evidence comes in the three forms a scalar's type takes in this compiler (`ScalarType`): a STATIC
 * tag, a per-row TAG expression (a stored property's `vtype`, or the static tag as a literal on a host),
 * and the STORAGE CLASS — what an `UNKNOWN` framing infers from at the wire, so a check against it is a
 * check against the type the value will be framed as. A per-row tag that is NULL (no stored row says)
 * falls back to the storage class for the same reason.
 *
 * Extent caveat, stated rather than hidden: an in-statement raise fires wherever SQLite evaluates the
 * arm, which is every row it projects; a reference that stops pulling early (a `limit()` before any
 * offending row) would not raise. That is the fail-closed direction — an error where the reference
 * might answer — never a plausible wrong value.
 */

/** What is known about a receiver's Gremlin type. */
export type ValueEvidence =
  | { readonly kind: 'static'; readonly tag: ValueType }
  /** `nullOnlyForNull`: the tag is NULL exactly when the value is (a stored property row always carries
   *  its `vtype`), so the storage class need not be consulted as a fallback. */
  | { readonly kind: 'tag'; readonly tag: Expr; readonly nullOnlyForNull?: boolean }
  | { readonly kind: 'storage' };

/** The type a receiver must be: a String, or a Number (`java.lang.Number`). */
export type ReceiverKind = 'string' | 'number';

/** The Number family as `NumberHelper` knows it — every numeric `ValueType`. */
export const NUMBER_TAGS: ReadonlySet<ValueType> = new Set<ValueType>([
  'byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal',
]);

const STORAGE: ValueEvidence = { kind: 'storage' };

/** The evidence a value's FRAMING type plus an optional per-row type expression give. A per-row tag
 *  that is a compiler literal (a host that carries its static tag as text) IS a static tag. */
export function evidenceOf(type: ScalarType | undefined, vtype?: Expr): ValueEvidence {
  if (vtype) {
    if (vtype.kind === 'lit' && vtype.source === 'compiler-text') return { kind: 'static', tag: vtype.value as ValueType };
    return { kind: 'tag', tag: vtype };
  }
  if (type?.kind === 'static') return { kind: 'static', tag: type.type };
  return STORAGE;
}

/** Is a static tag of the demanded kind? */
const tagIs = (kind: ReceiverKind, tag: ValueType): boolean =>
  kind === 'string' ? tag === 'string' : NUMBER_TAGS.has(tag);

/**
 * THE PREDICATE: `true` — proven; `false` — refuted (decline); `'runtime'` — decided per row by
 * `receiverOffence`.
 */
export function receiverProvably(kind: ReceiverKind, evidence: ValueEvidence): boolean | 'runtime' {
  return evidence.kind === 'static' ? tagIs(kind, evidence.tag) : 'runtime';
}

const text = compilerText;
const isNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is', left: e, right: compilerNull() });
const and = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: 'and', left, right });
const or = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: 'or', left, right });
const inList = (expr: Expr, values: readonly string[]): Expr => ({ kind: 'in-list', expr, values: values.map(text) });
const notIn = (expr: Expr, values: readonly string[]): Expr => ({ kind: 'unary', op: 'not', arg: inList(expr, values) });

/** The storage classes an UNKNOWN-framed value of each kind is framed from (`inferredVtype`). */
const STORAGE_CLASSES: Readonly<Record<ReceiverKind, readonly string[]>> = {
  string: ['text'],
  number: ['integer', 'real'],
};

/** Every per-row type name that admits `kind`. A per-row carrier is a Gremlin tag (a stored `vtype`, or a
 *  numeric reducer's `vt`, `reducer.ts` `REDUCED_TYPE`), and a storage class answers where no tag does —
 *  the storage-class names share no spelling with a `ValueType`, so one list serves both. */
const admitting = (kind: ReceiverKind): readonly string[] =>
  [...(kind === 'string' ? ['string'] : [...NUMBER_TAGS]), ...STORAGE_CLASSES[kind]];

/** The value's per-row TYPE NAME over non-static evidence: its tag, else its storage class (`'null'` for a
 *  NULL). One expression so the value is spelled once in the test, which matters because a receiver is
 *  often a correlated property read and every repetition is another subquery in the statement text. */
const typeName = (value: Expr, evidence: ValueEvidence): Expr => {
  if (evidence.kind !== 'tag') return { kind: 'call', fn: 'typeof', args: [value] };
  // A tag that is NULL only for a NULL value needs no second spelling of the value to say so.
  const fallback: Expr = evidence.nullOnlyForNull ? text('null') : { kind: 'call', fn: 'typeof', args: [value] };
  return { kind: 'call', fn: 'COALESCE', args: [evidence.tag, fallback] };
};

/**
 * WHAT A RECEIVER OWES: `false` — refuted, decline; `null` — proven, nothing owed; else the per-row
 * predicate that is TRUE where the receiver offends. A consumer guards its RESULT with `raisingWhen`
 * rather than wrapping the receiver, because it usually spells the receiver several times (a `math()`
 * formula names a variable once per use, `substring` reads `length(v)` four times) and each spelling of
 * a correlated read is another subquery in the statement text.
 *
 * `nullRaises` says when a NULL value is itself an offender — `math()` raises on a productive null, the
 * string family passes one through. `true`/`false` are the two certain answers; an `Expr` is a per-row
 * PRODUCTIVITY predicate (a child body that reports one), so a NULL raises only where the body produced.
 */
export function receiverOffence(
  kind: ReceiverKind, value: Expr, evidence: ValueEvidence, nullRaises: boolean | Expr = false,
): Expr | null | false {
  const provable = receiverProvably(kind, evidence);
  if (provable === false) return false;
  // A per-row productivity predicate makes a NULL an offence only where the body produced.
  const nullOffends: Expr | null = nullRaises === false || nullRaises === true ? null : and(nullRaises, isNull(value));
  // A static tag of the right kind still owes the productive-null check where nulls raise: the tag
  // describes the stream, not whether this row holds a value.
  if (provable === true) return nullRaises === true ? isNull(value) : nullOffends;
  // `'null'` (a NULL's storage class) is admitted unless a null is certainly an offence.
  const typeOffends = notIn(typeName(value, evidence), [...admitting(kind), ...(nullRaises === true ? [] : ['null'])]);
  return nullOffends ? or(typeOffends, nullOffends) : typeOffends;
}

/** A guarded expression: the first offending test raises its message, else `value`. */
export const raisingWhen = (offences: readonly (readonly [Expr, string])[], value: Expr): Expr =>
  offences.length ? { kind: 'case', whens: offences.map(([test, message]) => [test, raise(message)] as const), else: value } : value;

/**
 * THE ONE RUNTIME VALUE RAISE OVER A STREAM — a `Filter` over `rel` that raises an offence's message on
 * an offending row and keeps every other row (and applies a raising `asNumber` fence where one is passed).
 *
 * A WHERE rather than part of the value, because a position that consumes only EXISTENCE (`count()`, a
 * `where`/`not` body, a `choose` condition, a `fold()`/`path()` that never reads a carried channel) never
 * reads the value, and SQLite PRUNES an unread select-list expression together with the raise inside it,
 * while the reference raises there all the same. IN-STATEMENT rather than a separate guard statement
 * (`Binding.guard`): the guard re-ran the whole upstream as a second statement — a second, independent
 * draw of any `coin()`/`sample()` above it. `Binding.guard` is kept for what only a statement can decide
 * (§6·5's graph-dependent refusals); every per-row VALUE error of a stream lands here — the scalar fold's
 * receiver offences (asString/asNumber/concat/dateDiff/the string family) and the sack's operator
 * offences (`sack.ts`) alike.
 */
export function raisingRows(rel: Rel, offences: readonly (readonly [Expr, string])[], fresh: Minter, fence?: Expr): Rel {
  if (!offences.length && !fence) return rel;
  return make.filter({ id: fresh('txf'), input: rel, channels: rel.channels, type: rel.type, pred: raisingWhen(offences, fence ?? compilerInt(1)) });
}

/** The reference's message for a string-family step over a non-String receiver — the corpus-checked
 *  prefix (`ToUpper.feature`/`Concat.feature`: "message containing text of"). The offending class is
 *  not interpolated: an in-statement raise carries a literal, and the class is per row. */
export const stringReceiverMessage = (step: string): string =>
  step === 'concat' ? 'String concat() can only take string as argument'
    : `The ${step}() step can only take string as argument`;

/**
 * WHAT A `concat(__.t)` TRAVERSAL OPERAND OWES. `ConcatStep.map` assigns `TraversalUtil.apply(traverser,
 * ct)` to a `String` local (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ConcatStep.java:87-92`),
 * so a non-null non-String result is a `ClassCastException` there, where `concat_ws` coerced
 * `concat(__.V().values('age'))` to `'a29'`. Null is skipped, not an offence. The same three answers as
 * `receiverOffence`: `false` declines, `null` owes nothing, else the per-row offence and its message —
 * a run-time DEFERRAL, because the reference's message is a JVM cast message naming per-row classes.
 */
export function concatOperandOffence(value: Expr, evidence: ValueEvidence): readonly [Expr, string] | null | false {
  const offends = receiverOffence('string', value, evidence);
  return offends ? [offends, deferral('concat(): a traversal argument that yields a non-String')] : offends;
}

/**
 * WHAT AN ARITHMETIC OPERATOR OWES ITS OPERANDS. `Operator.sum/minus/mult/div` cast both sides to
 * `Number` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java`),
 * so a non-null non-Number on either side is a `ClassCastException` there, while SQLite's arithmetic reads
 * a Boolean as 1 and a String as 0. A null passes (`NumberHelper.mathOperationWithPromote` returns the
 * other side). The same three answers as `receiverOffence`, collected: `false` declines (an operand is
 * proven non-Number), else the per-row offences — a run-time DEFERRAL, because the reference's message
 * is a JVM cast message naming per-row classes.
 */
export function numericOperandOffences(
  operands: readonly (readonly [Expr, ValueEvidence])[], what: string,
): readonly (readonly [Expr, string])[] | false {
  const offences: (readonly [Expr, string])[] = [];
  for (const [value, evidence] of operands) {
    const offends = receiverOffence('number', value, evidence);
    if (offends === false) return false;
    if (offends) offences.push([offends, deferral(`${what}: an operand that is not a Number`)]);
  }
  return offences;
}

/** The tags whose value `CAST(v AS TEXT)` already spells: a String is itself, an integral Number its
 *  digits, a UUID/char its text, a BigDecimal its carried decimal text. */
const CAST_TAGS: readonly ValueType[] = ['string', 'uuid', 'char', 'byte', 'short', 'int', 'long', 'bigint', 'bigdecimal'];

/**
 * `asString()`'s VALUE — the receiver as a String (`AsStringGlobalStep.java:46`), one CASE on its tag, shared
 * by every step that stringifies a value (`asString()` at any host, a `format()` token, a `conjoin()` member):
 *
 * - a Boolean is `true`/`false` — it is STORED as SQLite's 1/0, so a bare `CAST` would answer `'1'`;
 * - a Double/Float is SQLite's own text of the REAL (`CAST(CAST(v AS REAL) AS TEXT)`) — a whole value
 *   keeps its `.0` (`1.0`, not `1`, even where the store keeps it as an INTEGER), so the number class
 *   stays visible. Beyond that the spelling is SQLite's (15 significant digits, `1.0e+20`, `Inf`), not
 *   Java's `Double.toString` — a deliberate divergence (`docs/feature-support-matrix.md`);
 * - a String, an integral Number, a UUID, a BigDecimal (and a `T`/`Direction` token, whose text is its
 *   name) is `CAST(v AS TEXT)`.
 *
 * Anything else — a date or a duration (which ride as numbers), a collection (a JSON tree) — has no
 * spelling here: refuted statically it DECLINES (`null`), per row it defers. A NULL renders NULL; whether
 * a null RAISES is `transformOffences`' question.
 */
export function asStringOf(value: Expr, evidence: ValueEvidence): Expr | null {
  const cast: Expr = { kind: 'cast', arg: value, to: 'text' };
  // `NOT NULL` is NULL, so a NULL matches neither arm and renders NULL.
  const bool: Expr = { kind: 'case', whens: [[value, text('true')], [{ kind: 'unary', op: 'not', arg: value }, text('false')]] };
  const floating: Expr = { kind: 'cast', arg: { kind: 'cast', arg: value, to: 'real' }, to: 'text' };
  if (evidence.kind === 'static') {
    const tag = evidence.tag;
    if (tag === 'string') return value;
    if (CAST_TAGS.includes(tag)) return cast;
    if (tag === 'boolean') return bool;
    if (tag === 'double' || tag === 'float') return floating;
    return null;
  }
  // Over STORAGE evidence the name is a storage class, so no Gremlin tag (a Boolean) can occur.
  const type = typeName(value, evidence);
  return { kind: 'case', whens: [
    [inList(type, ['null', 'text', 'integer', ...CAST_TAGS, 'T', 'D']), cast],
    [inList(type, ['boolean']), bool],
    [inList(type, ['real', 'double', 'float']), floating],
  ], else: deferralExpr(deferral('rendering this value as a String'), { kind: 'call', fn: 'random', args: [] }) };
}

/** `MathStep`'s message for a variable that does not resolve to a Number (`MathStep.java:86-87`), up to
 *  the per-row type and value it goes on to name. */
export const mathVariableMessage = (variable: string): string =>
  `The variable ${variable} for math() step must resolve to a Number`;

/** The Java simple class name a static numeric tag is framed as — the `%s` of `NumberHelper`'s overflow
 *  message (`a.getClass().getSimpleName()`). */
const JAVA_NUMBER: Readonly<Partial<Record<ValueType, string>>> = {
  byte: 'Byte', short: 'Short', int: 'Integer', long: 'Long', bigint: 'BigInteger',
  float: 'Float', double: 'Double', bigdecimal: 'BigDecimal',
};

const int = (value: number): Expr => compilerInt(value);

/**
 * A run-time STRING `asNumber(GType)` can convert with a SQL `CAST` and land on the reference's number:
 * an optional `-` and 1–18 decimal digits without a leading zero. Everything else `NumberUtils.createNumber`
 * reads its own way — a leading zero is OCTAL, a `.` makes a `Float` whose widening to Double is not the
 * decimal written, `0x`/exponents/suffixes parse where SQLite truncates — so a string outside this shape
 * RAISES a deferral at run time rather than casting to a plausible number.
 */
function castableDigits(value: Expr): Expr {
  const glob = (pattern: string, of: Expr): Expr => ({ kind: 'call', fn: 'glob', args: [text(pattern), of] });
  // A first character of `1-9` or `-1-9`, then digits only (from the second character on, so the sign
  // is the one non-digit allowed), at most 18 of them; or exactly `0`.
  const leading = or(glob('[1-9]*', value), glob('-[1-9]*', value));
  const digitsAfter: Expr = { kind: 'unary', op: 'not', arg: glob('*[^0-9]*', { kind: 'call', fn: 'substr', args: [value, int(2)] }) };
  const short: Expr = { kind: 'binary', op: '<=', left: { kind: 'call', fn: 'length', args: [value] }, right: int(19) };
  return or({ kind: 'binary', op: '=', left: value, right: text('0') }, and(and(leading, digitsAfter), short));
}

/** A run-time deferral raised from inside a statement — the same convention `operator.ts` uses for an
 *  answer this compiler cannot reproduce (`… is not supported`), never a plausible value. */
export const deferral = (what: string): string => `${what} is not supported yet`;

/**
 * THE STEP-TO-REL DISPATCH'S ONE RECEIVER CHECK — what a scalar transform's receiver owes for that step:
 * `null` to decline, else the per-row OFFENCES (each a predicate and the message it raises), empty where
 * nothing is owed. Every host that lowers a scalar transform over a value asks this before it builds the
 * expression (`lower.ts`'s scalar fold, `reduction.ts`'s value run) and guards the transform's RESULT with
 * `raisingWhen` — the result rather than the receiver, because a transform spells its receiver several
 * times (`substring` reads `length(v)` four times) and a wrapped receiver would be copied into each.
 *
 * `productive` is what a NULL value means here (`receiverOffence`'s `nullRaises`): `true` a productive null, an
 * `Expr` a per-row productivity predicate, `false` never a value, `undefined` the host cannot say.
 */
export function transformOffences(
  step: IRStep, value: Expr, evidence: ValueEvidence, productive: boolean | Expr | undefined,
): (readonly [Expr, string])[] | null {
  if (GLOBAL_STRING_THROWS.has(step.name) || step.name === 'concat') {
    // `Scope.local` over a scalar is `StringLocalStep.applyStringOperation`, which raises the `(local)`
    // spelling of the same message (`.../step/util/StringLocalStep.java:54-58`).
    const message = isLocalScope(step)
      ? `The ${step.name}(local) step can only take string or list of strings`
      : stringReceiverMessage(step.name);
    const offends = receiverOffence('string', value, evidence);
    return offends === false ? null : offends ? [[offends, message]] : [];
  }
  // `asString()` stringifies anything and raises only on a null (`AsStringGlobalStep.java:44-45`). A
  // host that cannot say whether a NULL was produced declines rather than guess.
  if (step.name === 'asString') {
    if (productive === undefined) return null;
    if (productive === false) return [];
    return [[productive === true ? isNull(value) : and(productive, isNull(value)), `Can't parse null as String.`]];
  }
  if (step.name === 'asNumber' && step.args.length) return asNumberOffences(step, value, evidence);
  return [];
}

/** `asNumber(GType)` over a run-time receiver: a Number or a datetime converts, a NULL passes, a String
 *  converts only in the `castableDigits` shape, and anything else raises; a BOUNDED target (byte/short/
 *  int) also range-checks, raising `NumberHelper`'s overflow message (`NumberHelper.java:770-771`). */
function asNumberOffences(step: IRStep, value: Expr, evidence: ValueEvidence): (readonly [Expr, string])[] | null {
  let spec;
  try { spec = numericSpec(step.args[0]?.value); } catch { return null; }
  if (!spec) return null;
  const offences: (readonly [Expr, string])[] = [];
  if (evidence.kind === 'static') {
    // A static tag decides the receiver outright: a Number or a datetime converts, anything else
    // (a String included — its parse is per value) declines.
    if (!NUMBER_TAGS.has(evidence.tag) && evidence.tag !== 'datetime') return null;
  } else {
    const type = typeName(value, evidence);
    const admitted = or(inList(type, [...admitting('number'), 'datetime', 'null']),
      and(inList(type, admitting('string')), castableDigits(value)));
    offences.push([{ kind: 'unary', op: 'not', arg: admitted }, deferral('asNumber(): converting this value at run time')]);
  }
  if (spec.min === undefined) return offences;
  const whole: Expr = { kind: 'cast', arg: value, to: 'int' };
  const outOfRange = or({ kind: 'binary', op: '<', left: whole, right: int(spec.min) },
    { kind: 'binary', op: '>', left: whole, right: int(spec.max!) });
  const source = evidence.kind === 'static' ? JAVA_NUMBER[evidence.tag] : undefined;
  offences.push([outOfRange, source ? `Can't convert number of type ${source} to ${spec.disp} due to overflow.`
    : deferral('asNumber(): a run-time narrowing overflow')]);
  return offences;
}
