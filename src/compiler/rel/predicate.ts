import { col, compilerInt, compilerNull, compilerText, param, type Expr } from '../../rel/expr.ts';
import { jsonEachSet, type Minter } from './build.ts';
import type { RelId, SqlType } from '../../rel/types.ts';
import { gtypeName, arg, collectionMembers, type Arg } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, normalizeTypeName, STORAGE_CLASS, type TypeNode } from '../../gremlin/types.ts';
import { constLit } from './const.ts';

/**
 * `P`/`TextP` AS RelIR EXPRESSIONS — the predicate vocabulary, re-expressed in the algebra.
 *
 * This is the RelIR counterpart of `plan.ts`'s `predicateSql`, and it is a MIGRATION rather than a
 * duplicate: the legacy one is deleted with the spine it serves. It exists as its own module
 * because a predicate is the most reused thing in the language — `has`, `where`, `is`, `filter`,
 * `not`, an edge criterion and a `by()`-modulated comparison are all the same question asked of
 * different subjects — so the RelIR spine grows all of them at once by growing this.
 *
 * TWO RULES, both load-bearing:
 *
 * - **It never throws.** An operand or an op it cannot express returns `null`, which routes the
 *   whole traversal to the legacy spine. `predicateSql` throws (`unsupported predicate: P.x`) and
 *   is right to, because it is the only answer available at that point; here a decline is the
 *   answer, and a throw would turn "not learned yet" into a support regression.
 * - **It never answers a DIFFERENT question.** Every arm below either reproduces the legacy
 *   semantics exactly or declines. The subtle one is ordering: a property value is stored in its
 *   natural SQLite storage class where it fits, and as TEXT where it does not (a long past 2^53, a
 *   bigint, a bigdecimal, a duration), so a plain `>` orders those rows LEXICALLY and after every
 *   numeric row. `compareKey` is the per-row fix and a range comparison MUST go through it — see
 *   `plan.ts` `compareKey` for the measurement behind the type lists.
 */

/** A parsed `P`/`TextP` as the front-end produces it. Structural, because `Step.args` is the
 *  wire boundary and a GLV may supply anything. */
interface Pred { readonly op: string; readonly operands: readonly Arg[]; }
const isPred = (value: unknown): value is Pred =>
  value !== null && typeof value === 'object' && 'op' in value && Array.isArray((value as Pred).operands);

const binary = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
/** Gremlin predicates are two-valued: negating SQL NULL is TRUE, not NULL. */
const negated = (inner: Expr): Expr => binary('is not', inner, compilerInt(1));
/** SQLite has no boolean literal; a degenerate set folds to a constant comparison rather than to a
 *  bare `0`, so the expression still reads as a predicate wherever it is spliced. */
/** The two constant predicates, spelled once. A lowering that has PROVEN an outcome says so with
 *  these rather than inventing its own always-false expression at each site. */
export const CONSTANT = { true: binary('=', compilerInt(1), compilerInt(1)), false: binary('=', compilerInt(1), compilerInt(0)) };

const COMPARISON: Readonly<Record<string, Extract<Expr, { kind: 'binary' }>['op']>> =
  { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
/** The four whose SQL comparison must be vtype-aware — see the module header. */
const ORDERING = new Set(['gt', 'gte', 'lt', 'lte']);

/** STATIC subject types an ordering comparison DECLINES rather than mis-comparing — a NATIVE temporal
 *  (`datetime`; also a `duration` that did NOT arrive as a decimal-TEXT tail): it rides as a raw
 *  epoch/nanos with no per-row `vtype` to line the bound up against. A TEXT tail of the SAME tag is
 *  handled EARLIER in `ordered` by the `type.text` cast, so `inject(Duration(…))` now orders instead of
 *  declining. `bigdecimal`/`long`/`bigint` are absent for the same reason — cast when TEXT, native
 *  otherwise (`asNumber(BIGDECIMAL)`→REAL, `count()`→INTEGER) — the storage-class enrichment that
 *  disambiguates the two having LANDED (`type.text`; docs/archive/2026-08-05-parameters-are-the-only-binds.md C1). */
const STATIC_ORDERING_DECLINE = new Set(['datetime', 'duration']);

/**
 * An operand this vocabulary can compare against, routed through the one const/param seam.
 *
 * `string`/`number` only, deliberately. A `bigint`, a `Duration` or a `BigDecimal` needs the
 * matching `CAST` on the BOUND side to line up with `compareKey`'s cast on the column side
 * (`plan.ts` `compareBound`), and a nested traversal needs a correlated per-traverser value that
 * no pure predicate can build. All of them decline, and the legacy spine answers them exactly as
 * it does today.
 *
 * A parsed literal INLINES (a constant — the value-operand budget win), a wire PARAMETER (`paramName`,
 * the operand's `Arg.name`) BINDS. Storage class does not matter for a comparison operand — SQLite
 * compares an INTEGER `2` and a REAL `2.0` numerically alike — so a nested operand with no declared
 * type inlines by its value's own shape without changing any answer.
 *
 * The EXACT NUMERIC TAIL — bigint / BigDecimal / Duration — is stored as canonical decimal TEXT
 * (`storedScalar`), so it inlines as that TEXT literal (equality is TEXT=TEXT, matching legacy) or binds
 * as a parameter; the ordering CAST that lines it up with `compareKey` is `ordered`'s job (`isExactTail`
 * → `castBound`). This is why RelIR now COVERS these operands rather than declining them to legacy.
 */
const operand = (value: unknown, type: TypeNode | null = null, paramName: string | null = null): Expr | null => {
  // A BOOLEAN is 1/0, which is how it is STORED — `storedValue` writes the same encoding
  // (`gremlin/types.ts`, and `GraphStore` coerces at the bind seam because DO SQLite refuses a
  // boolean bind outright). So `has('active', true)` is an ordinary integer comparison and needs no
  // vocabulary of its own; excluding it here was the whole of the gap.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return constLit(arg(value, type, paramName));
  if (isExactTail(value)) return paramName != null ? param(value, paramName) : compilerText(String(value));
  return null;
};

/** The numeric tail stored as decimal TEXT — a bigint, a BigDecimal, or a Duration (total-nanos). Its
 *  ordering comparison casts to the column's numeric class (`compareBound`): BigDecimal → REAL, the two
 *  integrals → INTEGER. */
const isExactTail = (value: unknown): boolean =>
  typeof value === 'bigint' || value instanceof BigDecimal || value instanceof Duration;
const exactTailCast = (value: unknown): SqlType | null =>
  value instanceof BigDecimal ? 'real' : (typeof value === 'bigint' || value instanceof Duration) ? 'int' : null;

/** The numeric class a TEXT-stored static SUBJECT casts to in an ordering compare, keyed by canonical
 *  type (`normalizeTypeName` output). The cast is IDENTITY on the native form of the same tag (a native
 *  `long` is already INTEGER, an `asNumber(BIGDECIMAL)` REAL) and the conversion on the decimal/nanos-TEXT
 *  form (`inject(9.99m)` → REAL), so it is correct once `type.text` says which storage class is in hand. */
const STATIC_SUBJECT_CAST: Record<string, SqlType> = { bigdecimal: 'real', long: 'int', bigint: 'int', duration: 'int' };

/** Storage classes `compareKey` casts to, as `plan.ts` measured them. A fixed compile-time
 *  vocabulary — never user input — so there is no injection surface in the names themselves. */
const CAST_TO_INT = ['byte', 'short', 'int', 'long', 'bigint', 'datetime', 'duration'];
const CAST_TO_REAL = ['float', 'double', 'bigdecimal'];
const NUMERIC_CAST_TO_INT = CAST_TO_INT.filter((type) => type !== 'datetime' && type !== 'duration');
const NUMERIC_VTYPES = [...NUMERIC_CAST_TO_INT, ...CAST_TO_REAL];

/**
 * The vtype-aware ordering key for a stored property value: `(value, vtype) -> a correctly-ordered
 * SQLite value`. Pass it as `compare` wherever a per-row `vtype` column is in scope; omit it where
 * the subject is already a native JS type (a computed scalar), which is what the legacy
 * `typeCtx.kind !== 'perRow'` branch means.
 *
 * The type lists are compiler-authored vocabulary, not query data, so they render as escaped SQL
 * string literals. User operands still use `lit()` and remain bound; this preserves the plan's data
 * budget while not wasting it on a fixed type vocabulary.
 */
/**
 * WHAT IS KNOWN ABOUT THE SUBJECT'S GREMLIN TYPE — one total union, replacing what used to be an
 * optional `compare` callback.
 *
 * Two predicate arms need this and they need DIFFERENT halves of it, which is why it is a vocabulary
 * rather than a flag or a function: the four ordering comparisons need the vtype as an EXPRESSION (to
 * build the cast key), and `typeOf` needs either a compile-time type name (constant-fold), the vtype
 * expression (compare it), or neither (fall back to the storage class). An optional callback could
 * carry the first and not the second, so `typeOf` would have had to take a second parameter — two
 * optionals describing one fact, which is the shape `docs/2026-07-28-scalartype-refactoring-pattern.md`
 * exists to refuse. The coarse view (`compare`) is DERIVED below rather than passed alongside.
 *
 * It is deliberately NOT `plan.ts`'s `TypeCtx` imported: that one carries a kernel `Expression`, and
 * the RelIR side must speak `Expr` (§2, the clean-room boundary). Same three cases, different layer.
 */
export type SubjectType =
  /** A compile-time canonical Gremlin type name — `count()`'s `long`, a typed `inject`. `text` marks a
   *  decimal-TEXT-stored exact tail (`inject(9.99m)`, a bound big long/Duration) so an ordering compare
   *  casts the subject to its numeric class; unset means a native REAL/INT of the same tag. */
  | { readonly kind: 'static'; readonly type: string; readonly text?: boolean }
  /** The subject came from a stored property, so its type is the row's own `vtype` column. */
  | { readonly kind: 'perRow'; readonly vtype: Expr }
  /** Nothing is known — an untyped computed scalar. */
  | { readonly kind: 'unknown' };

export const SUBJECT_UNKNOWN: SubjectType = { kind: 'unknown' };

/** Comparability is confined to one Gremlin type space. Each CASE combines the guard and comparison
 * so its type vocabulary is emitted once; a stored vtype outranks SQLite's storage class because an
 * exact numeric value may deliberately be stored as decimal TEXT. */
const ordered = (
  op: Extract<Expr, { kind: 'binary' }>['op'], subject: Expr, bound: Expr, value: unknown, type: SubjectType,
  boundType: TypeNode | null = null,
): Expr | null => {
  const numericBound = typeof value === 'number' || isExactTail(value);
  // WHICH STORED `vtype`s THIS BOUND IS COMPARABLE WITH — the OPERAND's own Gremlin type decides, and
  // reading it is what keeps three different type spaces apart once all of them ride as a number.
  // A `datetime` bound is epoch millis and a `duration` bound total nanos, so both are numeric to
  // SQLite and NEITHER is comparable with an `int` property — while both ARE comparable with a stored
  // value of their own tag. Dropping the operand's type (this took only its VALUE) made every temporal
  // bound fall to the `else` and answer FALSE for a comparison the reference performs:
  // `values('datetime').is(P.gt(datetime(…)))` was empty where it should hold. Numbers keep the whole
  // numeric vocabulary, which is `Compare`'s own "one number space" rule.
  const temporal = ((): 'datetime' | 'duration' | null => {
    const canonical = flatType(boundType);
    return canonical === 'datetime' || canonical === 'duration' ? canonical : null;
  })();
  const intVtypes = temporal ? [temporal] : NUMERIC_CAST_TO_INT;
  const realVtypes = temporal ? [] : CAST_TO_REAL;
  // The exact tail rides as decimal TEXT, so its ORDERING bound is cast to the column's numeric class
  // (`compareBound`) — otherwise `CAST(col AS REAL) > '9.99'` would compare a REAL against unconverted
  // TEXT. A plain number needs no cast (it already binds/inlines numeric).
  const tailCast = exactTailCast(value);
  const castBound: Expr = tailCast ? { kind: 'cast', arg: bound, to: tailCast } : bound;
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    // A TEXT-stored exact-tail subject (`inject(9.99m)`, a bound big long/Duration — `type.text`) rides as
    // decimal/total-nanos TEXT, so ordering casts it to its numeric class. The SAME cast is identity on the
    // NATIVE form of the same tag (`count()`→INTEGER, `asNumber(BIGDECIMAL)`→REAL), which is why the flag —
    // set only where the value is stored as TEXT (`injectSource`) — is what disambiguates the two and lets
    // `inject(9.99m)`/`inject(9…L)`/`inject(Duration(…))` order instead of declining
    // (docs/archive/2026-08-05-parameters-are-the-only-binds.md C1).
    const subjectCast = canonical !== null ? STATIC_SUBJECT_CAST[canonical] : undefined;
    if (numericBound && type.text && subjectCast)
      return binary(op, { kind: 'cast', arg: subject, to: subjectCast }, castBound);
    // A NATIVE temporal (`datetime`, or a `duration` that did not arrive as a TEXT tail) cannot be ordered
    // by this arm: it rides as a raw epoch/nanos with no per-row `vtype` to drive `compareKey`'s cast, so
    // comparing it raw is not what TinkerPop's temporal ordering means. DECLINE (a coverage gap, never a
    // wrong answer) rather than fold to a wrong `CONSTANT.false`. A native-numeric static subject
    // (`count()`'s `long`, an `asNumber(BIGDECIMAL)` REAL) is unaffected and still folds/compares here.
    if (numericBound && canonical !== null && STATIC_ORDERING_DECLINE.has(canonical)) return null;
    const agrees = numericBound
      ? canonical !== null && (temporal ? canonical === temporal : NUMERIC_VTYPES.includes(canonical))
      : canonical === 'string';
    return agrees ? binary(op, subject, castBound) : CONSTANT.false;
  }
  const compilerFalse = binary('!=',
    { kind: 'call', fn: 'json_object', args: [] },
    { kind: 'call', fn: 'json_object', args: [] });
  if (type.kind === 'perRow') {
    return numericBound
      ? { kind: 'case', whens: [
        [{ kind: 'in-list', expr: type.vtype, values: intVtypes.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'int' }, castBound)],
        ...(realVtypes.length
          ? [[{ kind: 'in-list', expr: type.vtype, values: realVtypes.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'real' }, castBound)] as const]
          : []),
      ], else: compilerFalse }
      : { kind: 'case', whens: [[binary('=', type.vtype, compilerText('string')), binary(op, subject, bound)]], else: compilerFalse };
  }
  const storage = { kind: 'call', fn: 'typeof', args: [subject] } as const;
  return numericBound
    ? { kind: 'case', whens: [[
      { kind: 'in-list', expr: storage, values: [compilerText('integer'), compilerText('real')] }, binary(op, subject, castBound),
    ]], else: compilerFalse }
    : { kind: 'case', whens: [[binary('=', storage, compilerText('text')), binary(op, subject, bound)]], else: compilerFalse };
};

/**
 * A COMPILE-TIME vtype picks the arm HERE, not in SQLite.
 *
 * The general form asks the engine `'bigint' IN ('byte','short','int','long',…)` — a comparison
 * between two values the compiler is holding, and the same rule that inlines a held constant as a
 * typed literal (root CLAUDE.md) says a type we KNOW must not travel to the engine as a question.
 * It is also not paid once: the exact-tail overflow guard spells its aggregate three times, so a
 * static `sum()` carried the coercion CASE three times over. Measured on
 * `g.V().values("int").asNumber(GType.BIGINT).is(P.typeOf(GType.BIGINT)).sum()` — 1,727 bytes of
 * statement text against a 1,233-byte family baseline, which is what caught it.
 *
 * Total and equivalence-preserving by construction: the folded arm is the one the CASE would have
 * selected, and a vtype in neither vocabulary folds to the CASE's own `else` (the bare subject).
 */
export const storedCompareOn = (vtype: Expr) => (subject: Expr): Expr => {
  const staticVtype = vtype.kind === 'lit' && vtype.source === 'compiler-text' ? vtype.value : undefined;
  if (staticVtype !== undefined) {
    if (CAST_TO_INT.includes(staticVtype)) return { kind: 'cast', arg: subject, to: 'int' };
    if (CAST_TO_REAL.includes(staticVtype)) return { kind: 'cast', arg: subject, to: 'real' };
    return subject;
  }
  return {
    kind: 'case',
    whens: [
      [{ kind: 'in-list', expr: vtype, values: CAST_TO_INT.map(compilerText) }, { kind: 'cast', arg: subject, to: 'int' }],
      [{ kind: 'in-list', expr: vtype, values: CAST_TO_REAL.map(compilerText) }, { kind: 'cast', arg: subject, to: 'real' }],
    ],
    else: subject,
  };
};

/** The common case: the `vtype` is a COLUMN of a relation in scope. Derived from the general form
 *  rather than a second copy of the type lists — `modulator.ts` builds the key inside a scalar
 *  subquery where the vtype is an arbitrary expression, and two spellings of the same cast policy is
 *  how one of them silently stops matching the other. */
export const storedCompare = (rel: RelId, vtype = 'vtype') => storedCompareOn(col(rel, vtype));

/** `TextP` -> a LIKE pattern with the user's metacharacters escaped. A wire parameter stays a
 * parameter through the pattern; interpolating its current value here would silently make it a
 * compiler constant. */
function likePattern(op: string, operand: Arg): { pattern: Expr; negated: boolean; nullOperand: boolean } | null {
  // TOTAL over every op, including `P.not(…)`, whose name starts with `not` but is not a TextP op.
  const negated = op.startsWith('not') && op.length > 3;
  const base = negated ? op[3].toLowerCase() + op.slice(4) : op;
  if (base !== 'startingWith' && base !== 'endingWith' && base !== 'containing') return null;
  // TextP is P<String>. Do not let SQLite stringify a number (`123` would otherwise satisfy
  // containing('2')); null is the separately-defined Text.isNull case.
  if (operand.value !== null && typeof operand.value !== 'string') return null;
  if (operand.value === null) return { pattern: compilerText(''), negated, nullOperand: true };
  const raw = operand.name == null ? compilerText(operand.value) : param(operand.value, operand.name);
  const escaped: Expr = { kind: 'call', fn: 'replace', args: [
    { kind: 'call', fn: 'replace', args: [
      { kind: 'call', fn: 'replace', args: [raw, compilerText('\\'), compilerText('\\\\')] },
      compilerText('%'), compilerText('\\%'),
    ] },
    compilerText('_'), compilerText('\\_'),
  ] };
  const join = (...parts: readonly Expr[]): Expr => parts.reduce((left, right) => binary('||', left, right));
  if (base === 'startingWith') return { pattern: join(escaped, compilerText('%')), negated, nullOperand: false };
  if (base === 'endingWith') return { pattern: join(compilerText('%'), escaped), negated, nullOperand: false };
  if (base === 'containing') return { pattern: join(compilerText('%'), escaped, compilerText('%')), negated, nullOperand: false };
  return null;
}

/** SQLite LIKE coerces non-text storage classes, while TextP accepts a String (or null) only. A
 * raw property without its vtype uses its storage class as the same fallback `typeOf` uses. */
function textSubject(subject: Expr, type: SubjectType): Expr {
  if (type.kind === 'static') {
    const canonical = normalizeTypeName(type.type);
    return canonical === 'string' || type.type.toLowerCase() === 'null' ? CONSTANT.true : CONSTANT.false;
  }
  const storage = { kind: 'call', fn: 'typeof', args: [subject] } as const;
  const raw = binary('or', binary('=', storage, compilerText('text')), binary('is', subject, compilerNull()));
  if (type.kind === 'unknown') return raw;
  return binary('or',
    { kind: 'in-list', expr: type.vtype, values: [compilerText('string'), compilerText('null')] },
    binary('and', binary('is', type.vtype, compilerNull()), raw),
  );
}

/**
 * `P.typeOf(GType|"ClassName")` — a TYPE test over the subject, or `null` to decline.
 *
 * Three modes, and which one applies is entirely `SubjectType`'s answer — the same three the legacy
 * `typeOfSql` resolves, reproduced rather than reinvented (that is the migration rule, and this arm is
 * where a plausible-looking shortcut would be silently wrong for a whole type family):
 *
 * 1. **compile-time type** → CONSTANT FOLD. `count().is(P.typeOf(GType.LONG))` is `1=1` and
 *    `…(GType.STRING)` is `1=0`; neither needs to touch a row.
 * 2. **per-row `vtype`** → compare it, with the storage class as the fallback for a row whose `vtype`
 *    is NULL (a raw insert). Both halves are needed: the column is the only thing that distinguishes
 *    a `datetime` from a `long`, and the fallback is the only thing that answers for a legacy row.
 * 3. **nothing known** → the storage-class test alone, which is FALSE for every type SQLite's classes
 *    cannot distinguish. False rather than declining, because that IS the answer TinkerPop's reference
 *    gives over an untyped value, and `STORAGE_CLASS`'s `null` entries are what say so.
 *
 * Declines rather than throwing on an unreadable argument, where legacy raises `typeOf() requires a
 * GType argument` / `unregistered type 'x'` — those are real errors and stay the legacy spine's to
 * raise, since a chain reaching them declines whole and gets the identical message.
 */
function typeOfExpr(subject: Expr, arg: unknown, type: SubjectType): Expr | null {
  const raw = gtypeName(arg)?.toLowerCase();
  if (raw === undefined || raw === null) return null;
  if (raw === 'null') return binary('is', subject, compilerNull());
  const canonical = normalizeTypeName(raw);
  // A recognized element/token GType (vertex/edge/path/…) is valid Gremlin but a stored property
  // scalar is never one, so it folds to FALSE. An unrecognized NAME is an error legacy raises — which
  // means declining here, not folding, because folding would answer a question that should have thrown.
  if (!canonical) return KNOWN_NON_VALUE.has(raw) ? CONSTANT.false : null;

  if (type.kind === 'static') return normalizeTypeName(type.type) === canonical ? CONSTANT.true : CONSTANT.false;
  const storage = STORAGE_CLASS[canonical];
  const byStorage: Expr = storage ? binary('=', { kind: 'call', fn: 'typeof', args: [subject] }, compilerText(storage)) : CONSTANT.false;
  if (type.kind === 'unknown') return byStorage;
  return {
    kind: 'case',
    whens: [[binary('is not', type.vtype, compilerNull()), binary('=', type.vtype, compilerText(canonical))]],
    else: byStorage,
  };
}

/** GTypes that name something a stored property value can never be. Valid syntax, so the answer is
 *  FALSE; an unrecognized name is an ERROR instead, and the two must not be confused. */
const KNOWN_NON_VALUE = new Set(['vertex', 'edge', 'vertexproperty', 'vproperty', 'property', 'tree', 'graph', 'path', 'binary']);

/**
 * A predicate over `subject`, or `null` to decline.
 *
 * `type` is what is known about the subject's Gremlin type, and it is ONE total union rather than the
 * optional `compare` callback it replaced: the range ops derive their ordering key from it and
 * `typeOf` reads it directly, so two arms share one fact instead of two parameters describing it.
 * The caller supplies it because the caller is the only one that knows where the `vtype` column lives
 * — the same reason `Col` names a relation.
 */
/** A collection PARAMETER as an IN-set: `subject IN (SELECT sv FROM json_each(jsonb(?)))`. The whole
 *  array crosses as ONE `jsonb(?)` bind exploded by `json_each` (root `CLAUDE.md`'s data-sized-set rule),
 *  so the parameter stays a bind of any size and the statement text never becomes a function of its data.
 *  The bind is a PARAMETER (`param`, named), so it reuses the repeated-parameter dedup like any other. */
const jsonEachInSet = (subject: Expr, value: readonly unknown[], name: string, fresh: Minter, negated: boolean): Expr => ({
  kind: 'in-query', negated, expr: subject, plan: jsonEachSet(name, value, fresh),
});

/**
 * A VARARG VALUE SET over `subject` — the `hasKey(a, b, …)` / `hasValue(a, b, …)` form, where a NULL
 * member is LEGAL. One argument is an `eq` and several a `within`, which is upstream's own reduction:
 * `HasContainer(T.key, labels.length == 1 ? P.eq(labels[0]) : P.within(labels))`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java:3107`,
 * and `:3179` for the value side).
 *
 * ⚠️ **IT IS NOT `predicateExpr(… {op:'within'})`, and the difference is a null.** A null operand there
 * DECLINES on purpose and must keep declining: `P.neq(null)` is TRUE for every non-null value while
 * `NOT (x = NULL)` is NULL, so admitting one generally would turn a decline into a wrong answer. Here the
 * only two ops are `eq` and `within`, and for exactly those SQL's null propagation IS the reference's
 * answer — `value.equals(null)` is false, so `g.V().properties().hasKey(null)` is the EMPTY result and
 * `hasKey(null, 'age')` keeps the `age` properties (`.../features/filter/HasKey.feature:71-101`).
 *
 * A single argument that is itself a `P` is that `P`, not a one-member set — `hasValue(P.gt(30))` is a
 * range and routes to `predicateExpr`.
 */
export function valueSet(
  subject: Expr, args: readonly Arg[], type: SubjectType, fresh?: Minter,
): Expr | null {
  if (!args.length) return null;
  const only = args.length === 1 ? args[0]! : null;
  if (only && (isPred(only.value) || only.value !== null))
    return predicateExpr(subject, only.value, type, only.type, only.name, fresh);
  // A P nested among varargs is not a form Gremlin has (`hasKey(P.eq('a'), 'b')` does not type), so
  // declining beats folding one into a member list.
  if (args.some((a) => isPred(a.value))) return null;
  const values = args.map((a) => (a.value === null ? compilerNull() : operand(a.value, a.type, a.name)));
  if (values.some((v) => !v)) return null;
  // ONE member that is null: `x = NULL` is never true, which is the answer, and spelling it as the
  // comparison rather than as `CONSTANT.false` keeps the reason readable in the emitted SQL.
  return values.length === 1
    ? binary('=', subject, values[0]!)
    : { kind: 'in-list', expr: subject, values: values as Expr[] };
}

export function predicateExpr(
  subject: Expr, pred: unknown, type: SubjectType = SUBJECT_UNKNOWN,
  opType: TypeNode | null = null, opParam: string | null = null, fresh?: Minter,
): Expr | null {
  // `has(key)` with no value: presence, not comparison.
  if (pred === undefined) return binary('is not', subject, compilerNull());
  if (!isPred(pred)) {
    // The BARE value — the one operand that can be a top-level parameter (`has(k, $x)`, `is($x)`), so it
    // alone carries the declared type and the param name; a `P.gt(x)` operand is nested and inlines.
    const value = operand(pred, opType, opParam);
    return value && binary('=', subject, value);
  }

  const { op, operands } = pred;
  // Each operand is an `Arg`, so its own value + type + parameter name travel together — a `P.gt($x)`
  // / `within($x, $y)` operand binds and a parsed literal inlines, wherever it sits, with no separate
  // parallel-name lookup.
  const recurse = (o: Arg) => predicateExpr(subject, o.value, type, null, null, fresh);
  const both = (build: (left: Expr, right: Expr) => Expr): Expr | null => {
    const [left, right] = [recurse(operands[0]), recurse(operands[1])];
    return left && right ? build(left, right) : null;
  };

  if (op === 'not') { const inner = recurse(operands[0]); return inner && negated(inner); }
  // Infix-composed predicates — `P.gt(20).and(P.lt(30))`. Both sides test the SAME subject, so it
  // is a boolean combination that nests to any depth because each side recurses through here.
  if (op === 'and') return both((l, r) => binary('and', l, r));
  if (op === 'or') return both((l, r) => binary('or', l, r));

  const comparison = COMPARISON[op];
  if (comparison) {
    // The operand inlines as a TYPED literal, storage class following its declared canonical type —
    // the thesis's "we know the type, stop throwing it away" (an integer-valued `P.gt(2.0)` renders
    // `2.0`, not `2`). Result-invariant: SQLite compares an INTEGER and a REAL numerically alike.
    const bound = operand(operands[0].value, operands[0].type, operands[0].name);
    if (!bound) return null;
    // Equality stays a RAW compare: canonical text is exact, and it keeps the value index usable
    // for the common case. Only ORDERING needs the cast, and only it pays for one.
    if (ORDERING.has(op)) return ordered(comparison, subject, bound, operands[0].value, type, operands[0].type);
    const inner = binary(comparison, subject, bound);
    return op === 'neq' ? negated(binary('=', subject, bound)) : inner;
  }

  if (op === 'within' || op === 'without') {
    // A single collection operand — the faithful front-end leaves it whole. A bound list-PARAMETER
    // crosses as ONE `jsonb(?)` bind exploded by `json_each` (the parameter stays a bind of any size and
    // its data never enters the statement text); a LITERAL spreads to its members, each inlining or
    // binding by its own name. Varargs are already member operands.
    const coll = operands.length === 1 && Array.isArray(operands[0].value) ? operands[0] : null;
    if (coll && coll.name != null && !coll.members) {
      if (!fresh) return null;   // no relation minter reached this caller — decline (fail closed)
      return jsonEachInSet(subject, coll.value as readonly unknown[], coll.name, fresh, op === 'without');
    }
    const memberArgs = coll ? collectionMembers(coll) : operands;
    // SQLite rejects an empty `IN ()`, so the degenerate sets fold to their truth value: within
    // nothing is never, without nothing is always.
    if (!memberArgs.length) return op === 'within' ? CONSTANT.false : CONSTANT.true;
    // NO SIZE LIMIT. A vararg set is bounded by the QUERY TEXT, and its members INLINE — 26 literals
    // cost zero bound parameters, so a cap derived from the 100-BIND wall was refusing queries that
    // spend none of it (measured: `within(<26 literals>)` declined while `within(<25>)` compiled, both
    // at 0 binds). The set whose size is a function of DATA is the named-collection branch above, which
    // crosses as ONE `json_each` bind unconditionally — that is where the rule lives, and it needs no
    // threshold to enforce it.
    const members = memberArgs.map((o) => operand(o.value, o.type, o.name));
    if (members.some((m) => !m)) return null;
    const inList: Expr = { kind: 'in-list', expr: subject, values: members as Expr[] };
    return op === 'within' ? inList : negated(inList);
  }

  // between = [lo, hi) — inclusive low; inside = (lo, hi) — exclusive low. Both bounds and the
  // subject go through the ordering key for the same reason a range comparison does. A single
  // collection bound (`between([lo,hi])`) spreads to its two members first.
  if (op === 'between' || op === 'inside') {
    const bounds = operands.length === 1 && Array.isArray(operands[0].value) ? collectionMembers(operands[0]) : operands;
    if (bounds.length !== 2) return null;
    const [low, high] = [operand(bounds[0].value, bounds[0].type, bounds[0].name), operand(bounds[1].value, bounds[1].type, bounds[1].name)];
    if (!low || !high) return null;
    const [loCmp, hiCmp] = [
      ordered(op === 'inside' ? '>' : '>=', subject, low, bounds[0].value, type, bounds[0].type),
      ordered('<', subject, high, bounds[1].value, type, bounds[1].type),
    ];
    return loCmp && hiCmp ? binary('and', loCmp, hiCmp) : null;
  }

  const like = operands.length === 1 ? likePattern(op, operands[0]) : null;
  if (like) {
    // SQLite's `like(pattern, subject, escape)` FUNCTION, not the infix operator, because the
    // operator's ESCAPE clause is not an expression the algebra has a node for — and adding one
    // for a single op would widen the closed node set (§7) to say something the function already
    // says. Nothing is lost: SQLite disables its LIKE index optimization whenever ESCAPE is
    // present, which the legacy operator form always is, so both spellings are a residual filter.
    const call: Expr = like.nullOperand ? CONSTANT.false
      : { kind: 'call', fn: 'like', args: [like.pattern, subject, compilerText('\\')] };
    // The type gate stays outside the negative form: null is a legal String reference and the
    // negative TextP variants return true for it, but a non-String is not a TextP match at all.
    return binary('and', textSubject(subject, type), like.negated ? negated(call) : call);
  }

  if (op === 'typeOf') return operands.length === 1 ? typeOfExpr(subject, operands[0].value, type) : null;

  // `regex` and `withinList`/`withoutList` (a list-valued traversal operand) remain. Each needs
  // something this module does not have — a regex function, or a run-time member list — so each
  // declines rather than being half-answered.
  return null;
}
