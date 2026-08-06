import { col, compilerInt, compilerNull, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { meta, typeOf, type Minter } from './build.ts';
import { CF_MAX_BINDS } from '../../cf-limits.ts';
import type { RelId, SqlType } from '../../rel/types.ts';
import { gtypeName, arg, collectionMembers, type Arg } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, normalizeTypeName, STORAGE_CLASS, type TypeNode } from '../../gremlin/types.ts';
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
const CONSTANT = { true: binary('=', compilerInt(1), compilerInt(1)), false: binary('=', compilerInt(1), compilerInt(0)) };

const COMPARISON: Readonly<Record<string, Extract<Expr, { kind: 'binary' }>['op']>> =
  { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
/** The four whose SQL comparison must be vtype-aware — see the module header. */
const ORDERING = new Set(['gt', 'gte', 'lt', 'lte']);

/** STATIC subject types an ordering comparison DECLINES rather than mis-comparing — the temporals, whose
 *  ONLY static-subject source is a literal (`inject(datetime(…))`/`inject(Duration(…))`) that rides as a
 *  raw epoch/nanos the static arm cannot line up with the bound. `bigdecimal` is deliberately ABSENT: it
 *  ALSO arrives as a NATIVE REAL (`values(…).asNumber(GType.BIGDECIMAL)`, a reducer), which compares
 *  correctly here, and the static type alone cannot tell that apart from a TEXT inject literal — so
 *  declining it would break the native case (the `asNumber(BIGDECIMAL).is(P.gt(0))` census witness). A
 *  correctly-compared TEXT bigdecimal static subject is the deferred storage-class enrichment. See `ordered`. */
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
  if (typeof value === 'string' || typeof value === 'number') return constLit(arg(value, type, paramName));
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

/** Above this, a big set DECLINES rather than emitting binds it cannot afford — the DO 100-parameter
 *  wall. A big LITERAL set inlines (0 binds) and is unaffected; only a big PARAM/data set is capped.
 *  There is deliberately no >100-value blob conversion (removed 2026-08-06). */
const SET_BIND_LIMIT = Math.floor(CF_MAX_BINDS / 4);

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
): Expr | null => {
  const numericBound = typeof value === 'number' || isExactTail(value);
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
    // (docs/2026-08-05-parameters-are-the-only-binds.md C1).
    const subjectCast = canonical !== null ? STATIC_SUBJECT_CAST[canonical] : undefined;
    if (numericBound && type.text && subjectCast)
      return binary(op, { kind: 'cast', arg: subject, to: subjectCast }, castBound);
    // A NATIVE temporal (`datetime`, or a `duration` that did not arrive as a TEXT tail) cannot be ordered
    // by this arm: it rides as a raw epoch/nanos with no per-row `vtype` to drive `compareKey`'s cast, so
    // comparing it raw is not what TinkerPop's temporal ordering means. DECLINE (a coverage gap, never a
    // wrong answer) rather than fold to a wrong `CONSTANT.false`. A native-numeric static subject
    // (`count()`'s `long`, an `asNumber(BIGDECIMAL)` REAL) is unaffected and still folds/compares here.
    if (numericBound && canonical !== null && STATIC_ORDERING_DECLINE.has(canonical)) return null;
    const agrees = numericBound ? canonical !== null && NUMERIC_VTYPES.includes(canonical) : canonical === 'string';
    return agrees ? binary(op, subject, castBound) : CONSTANT.false;
  }
  const compilerFalse = binary('!=',
    { kind: 'call', fn: 'json_object', args: [] },
    { kind: 'call', fn: 'json_object', args: [] });
  if (type.kind === 'perRow') {
    return numericBound
      ? { kind: 'case', whens: [
        [{ kind: 'in-list', expr: type.vtype, values: NUMERIC_CAST_TO_INT.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'int' }, castBound)],
        [{ kind: 'in-list', expr: type.vtype, values: CAST_TO_REAL.map(compilerText) }, binary(op, { kind: 'cast', arg: subject, to: 'real' }, castBound)],
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

export const storedCompareOn = (vtype: Expr) => (subject: Expr): Expr => ({
  kind: 'case',
  whens: [
    [{ kind: 'in-list', expr: vtype, values: CAST_TO_INT.map(compilerText) }, { kind: 'cast', arg: subject, to: 'int' }],
    [{ kind: 'in-list', expr: vtype, values: CAST_TO_REAL.map(compilerText) }, { kind: 'cast', arg: subject, to: 'real' }],
  ],
  else: subject,
});

/** The common case: the `vtype` is a COLUMN of a relation in scope. Derived from the general form
 *  rather than a second copy of the type lists — `modulator.ts` builds the key inside a scalar
 *  subquery where the vtype is an arbitrary expression, and two spellings of the same cast policy is
 *  how one of them silently stops matching the other. */
export const storedCompare = (rel: RelId, vtype = 'vtype') => storedCompareOn(col(rel, vtype));

/**
 * Does this predicate contain a `TextP` SUBSTRING op — the shape `ftsSubstringPredicate` claims?
 *
 * A caller that has a `property_fts` route available must DECLINE such a predicate rather than
 * lower it here, and the rule it serves is general: **the RelIR route may not silently drop a fast
 * path.** Coverage measures whether the new spine can express a traversal, not whether it should
 * take it from a specialized lowering — silently swapping a trigram-index seek for a base-table
 * LIKE scan would be a performance regression the census cannot see and the coverage number would
 * report as progress. §4.7 is where the fast paths become plan rewrites; until then this predicate
 * is how a site says "that one is still the legacy spine's".
 *
 * Deliberately NOT conditional on the `ftsSubstringPredicate` flag: the lowering is a function of
 * the CHAIN alone, and making spine choice read the fast-path config would couple two decisions
 * that must stay independent.
 */
export function containsTextSearch(pred: unknown): boolean {
  if (!isPred(pred)) return false;
  if (likePattern(pred.op, '') !== null) return true;
  return pred.operands.some((o) => containsTextSearch(o.value));
}

/** `TextP` -> a LIKE pattern with the user's metacharacters escaped. `null` for an op that is not
 *  a supported `TextP` (`regex`, `typeOf`), which then declines with everything else. */
function likePattern(op: string, value: unknown): { pattern: string; negated: boolean } | null {
  // TOTAL over every op, not just the three plus their negations: `containsTextSearch` asks this of
  // an arbitrary predicate, and `P.not(…)` starts with `not` while having no fourth character.
  // `plan.ts`'s copy is reached only after every other op has been handled, so it never sees one.
  const negated = op.startsWith('not') && op.length > 3;
  const base = negated ? op[3].toLowerCase() + op.slice(4) : op;
  const escaped = String(value).replace(/[\\%_]/g, (c) => '\\' + c);
  if (base === 'startingWith') return { pattern: `${escaped}%`, negated };
  if (base === 'endingWith') return { pattern: `%${escaped}`, negated };
  if (base === 'containing') return { pattern: `%${escaped}%`, negated };
  return null;
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
/** A collection PARAMETER as an IN-set: `subject IN (SELECT wv FROM json_each(jsonb(?)))`. The whole
 *  array crosses as ONE `jsonb(?)` bind exploded by `json_each` (root `CLAUDE.md`'s data-sized-set rule),
 *  so the parameter stays a bind of any size and the statement text never becomes a function of its data.
 *  The bind is a PARAMETER (`param`, named), so it reuses the repeated-parameter dedup like any other. */
const jsonEachInSet = (subject: Expr, value: readonly unknown[], name: string, fresh: Minter, negated: boolean): Expr => ({
  kind: 'in-query', negated, expr: subject,
  plan: make.explode({
    id: fresh('wset'), channels: [], expr: { kind: 'call', fn: 'jsonb', args: [param(JSON.stringify(value), name)] },
    as: { value: 'wv' }, type: typeOf(meta('wv', 'any', true)),
  }),
});

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
    if (ORDERING.has(op)) return ordered(comparison, subject, bound, operands[0].value, type);
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
    if (memberArgs.length > SET_BIND_LIMIT) return null;   // a big LITERAL set still declines (unchanged)
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
      ordered(op === 'inside' ? '>' : '>=', subject, low, bounds[0].value, type),
      ordered('<', subject, high, bounds[1].value, type),
    ];
    return loCmp && hiCmp ? binary('and', loCmp, hiCmp) : null;
  }

  const like = likePattern(op, operands[0]?.value);
  if (like) {
    // SQLite's `like(pattern, subject, escape)` FUNCTION, not the infix operator, because the
    // operator's ESCAPE clause is not an expression the algebra has a node for — and adding one
    // for a single op would widen the closed node set (§7) to say something the function already
    // says. Nothing is lost: SQLite disables its LIKE index optimization whenever ESCAPE is
    // present, which the legacy operator form always is, so both spellings are a residual filter.
    const call: Expr = { kind: 'call', fn: 'like', args: [compilerText(like.pattern), subject, compilerText('\\')] };
    return like.negated ? negated(call) : call;
  }

  if (op === 'typeOf') return operands.length === 1 ? typeOfExpr(subject, operands[0].value, type) : null;

  // `regex` and `withinList`/`withoutList` (a list-valued traversal operand) remain. Each needs
  // something this module does not have — a regex function, or a run-time member list — so each
  // declines rather than being half-answered.
  return null;
}
