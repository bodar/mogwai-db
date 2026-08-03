import { col, lit, type Expr } from '../../rel/expr.ts';
import { CF_MAX_BINDS } from '../../cf-limits.ts';
import type { RelId } from '../../rel/types.ts';

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
interface Pred { readonly op: string; readonly values: readonly unknown[]; }
const isPred = (value: unknown): value is Pred =>
  value !== null && typeof value === 'object' && 'op' in value && Array.isArray((value as Pred).values);

const binary = (op: Extract<Expr, { kind: 'binary' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const not = (arg: Expr): Expr => ({ kind: 'unary', op: 'not', arg });
/** SQLite has no boolean literal; a degenerate set folds to a constant comparison rather than to a
 *  bare `0`, so the expression still reads as a predicate wherever it is spliced. */
const CONSTANT = { true: binary('=', lit(1, 'int'), lit(1, 'int')), false: binary('=', lit(1, 'int'), lit(0, 'int')) };

const COMPARISON: Readonly<Record<string, Extract<Expr, { kind: 'binary' }>['op']>> =
  { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
/** The four whose SQL comparison must be vtype-aware — see the module header. */
const ORDERING = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * A literal operand this vocabulary can compare against.
 *
 * `string`/`number` only, deliberately. A `bigint`, a `Duration` or a `BigDecimal` needs the
 * matching `CAST` on the BOUND side to line up with `compareKey`'s cast on the column side
 * (`plan.ts` `compareBound`), and a nested traversal needs a correlated per-traverser value that
 * no pure predicate can build. All of them decline, and the legacy spine answers them exactly as
 * it does today.
 */
const operand = (value: unknown): Expr | null =>
  typeof value === 'string' ? lit(value, 'text') : typeof value === 'number' ? lit(value, 'real') : null;

/** Above this, a set stops being an IN-list and becomes one JSON bind — the DO 100-parameter wall.
 *  RelIR's remedy for that is `passes/land.ts`, which lowers a `Values`, not an `InList`; until an
 *  `InList` lowering exists a big set DECLINES rather than emitting binds it cannot afford. */
const SET_BIND_LIMIT = Math.floor(CF_MAX_BINDS / 4);

/** Storage classes `compareKey` casts to, as `plan.ts` measured them. A fixed compile-time
 *  vocabulary — never user input — so there is no injection surface in the names themselves. */
const CAST_TO_INT = ['byte', 'short', 'int', 'long', 'bigint', 'datetime', 'duration'];
const CAST_TO_REAL = ['float', 'double', 'bigdecimal'];

/**
 * The vtype-aware ordering key for a stored property value: `(value, vtype) -> a correctly-ordered
 * SQLite value`. Pass it as `compare` wherever a per-row `vtype` column is in scope; omit it where
 * the subject is already a native JS type (a computed scalar), which is what the legacy
 * `typeCtx.kind !== 'perRow'` branch means.
 *
 * The type lists cost 10 binds here where `plan.ts` splices them as SQL text, because in RelIR
 * every `Lit` is a bind by construction (§3.2) and the budget is a plan property (§3.6) rather
 * than a per-site judgement. That is the trade the rule was made for: a `check` that can PROVE the
 * DO cap, at the cost of some binds a hand-written emitter would have inlined.
 */
export const storedCompareOn = (vtype: Expr) => (subject: Expr): Expr => ({
  kind: 'case',
  whens: [
    [{ kind: 'in-list', expr: vtype, values: CAST_TO_INT.map((t) => lit(t, 'text')) }, { kind: 'cast', arg: subject, to: 'int' }],
    [{ kind: 'in-list', expr: vtype, values: CAST_TO_REAL.map((t) => lit(t, 'text')) }, { kind: 'cast', arg: subject, to: 'real' }],
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
  return pred.values.some(containsTextSearch);
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
 * A predicate over `subject`, or `null` to decline.
 *
 * `compare` is the ordering-key builder for the four range ops (`storedCompare` where a per-row
 * `vtype` is in scope, absent otherwise). It is a parameter rather than a flag because the caller
 * is the only one that knows WHERE the vtype column lives — the same reason `Col` names a relation.
 */
export function predicateExpr(subject: Expr, pred: unknown, compare: (e: Expr) => Expr = (e) => e): Expr | null {
  // `has(key)` with no value: presence, not comparison.
  if (pred === undefined) return binary('is not', subject, lit(null, 'any'));
  if (!isPred(pred)) {
    const value = operand(pred);
    return value && binary('=', subject, value);
  }

  const { op, values } = pred;
  const recurse = (p: unknown) => predicateExpr(subject, p, compare);
  const both = (build: (left: Expr, right: Expr) => Expr): Expr | null => {
    const [left, right] = [recurse(values[0]), recurse(values[1])];
    return left && right ? build(left, right) : null;
  };

  if (op === 'not') { const inner = recurse(values[0]); return inner && not(inner); }
  // Infix-composed predicates — `P.gt(20).and(P.lt(30))`. Both sides test the SAME subject, so it
  // is a boolean combination that nests to any depth because each side recurses through here.
  if (op === 'and') return both((l, r) => binary('and', l, r));
  if (op === 'or') return both((l, r) => binary('or', l, r));

  const comparison = COMPARISON[op];
  if (comparison) {
    const bound = operand(values[0]);
    if (!bound) return null;
    // Equality stays a RAW compare: canonical text is exact, and it keeps the value index usable
    // for the common case. Only ORDERING needs the cast, and only it pays for one.
    return ORDERING.has(op) ? binary(comparison, compare(subject), bound) : binary(comparison, subject, bound);
  }

  if (op === 'within' || op === 'without') {
    // SQLite rejects an empty `IN ()`, so the degenerate sets fold to their truth value: within
    // nothing is never, without nothing is always.
    if (!values.length) return op === 'within' ? CONSTANT.false : CONSTANT.true;
    if (values.length > SET_BIND_LIMIT) return null;
    const members = values.map(operand);
    if (members.some((m) => !m)) return null;
    const inList: Expr = { kind: 'in-list', expr: subject, values: members as Expr[] };
    return op === 'within' ? inList : not(inList);
  }

  // between = [lo, hi) — inclusive low; inside = (lo, hi) — exclusive low. Both bounds and the
  // subject go through the ordering key for the same reason a range comparison does.
  if (op === 'between' || op === 'inside') {
    const [low, high] = [operand(values[0]), operand(values[1])];
    if (!low || !high) return null;
    return binary('and',
      binary(op === 'inside' ? '>' : '>=', compare(subject), low),
      binary('<', compare(subject), high));
  }

  const like = likePattern(op, values[0]);
  if (like) {
    // SQLite's `like(pattern, subject, escape)` FUNCTION, not the infix operator, because the
    // operator's ESCAPE clause is not an expression the algebra has a node for — and adding one
    // for a single op would widen the closed node set (§7) to say something the function already
    // says. Nothing is lost: SQLite disables its LIKE index optimization whenever ESCAPE is
    // present, which the legacy operator form always is, so both spellings are a residual filter.
    const call: Expr = { kind: 'call', fn: 'like', args: [lit(like.pattern, 'text'), subject, lit('\\', 'text')] };
    return like.negated ? not(call) : call;
  }

  // `typeOf`, `regex`, `withinList`/`withoutList` (a list-valued traversal operand). Each needs
  // something this module does not have — a type vocabulary, a regex function, or a run-time
  // member list — so each declines rather than being half-answered.
  return null;
}
