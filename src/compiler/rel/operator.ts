import { compilerNull, type Expr } from '../../rel/expr.ts';

/**
 * `Operator` — ONE FOLD STEP, in the algebra.
 *
 * A Gremlin `Operator.x` is a `BinaryOperator<Object>` and nothing more
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java`).
 * Every place a traversal declares one — `withSideEffect(k, seed, Operator.x)`, `withSack(seed,
 * Operator.x)`, `sack(Operator.x).by(v)` — folds it the same way, so the EXPRESSION belongs in one
 * module. This is §6·4's split applied a second time: the operator SET is data both spines agree on
 * (`SACK_OPS`, `ir/step.ts`), and the SQL is emission, owned by whichever layer emits it.
 *
 * ## The two categories, and why the distinction is not cosmetic
 *
 * `AggregateStep.processAllStarts` (`:131-151`) branches on it by name: `addAll` and `assign` are
 * **BULK** operators, folded once per site with the site's whole `BulkSet` as the value; every other
 * operator is folded **MEMBER BY MEMBER**. So a bulk operator's lowering is a question about the
 * collection's member RELATION and a member-by-member one's is this expression, iterated.
 *
 * ## Why a LEFT FOLD and not an SQL aggregate
 *
 * `SUM`/`MIN`/`MAX` would cover four operators and silently MIS-ANSWER two. `mult` has no SQL
 * aggregate at all, and rewriting `div` as `seed / PRODUCT(members)` is not equivalent under INTEGER
 * division — it happens to agree on the corpus fixture and would not in general. A seeded left fold
 * is exact by construction, which is the difference between a right answer and a lucky one.
 *
 * ## NULL is not an accident here — it is the reference's declared behaviour
 *
 * `NumberHelper.mathOperationWithPromote` opens with `if (null == a || null == b) return a;`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:401-402`),
 * so for the arithmetic four a NULL VALUE is the identity and a NULL ACCUMULATOR propagates. SQL's
 * arithmetic already propagates a NULL accumulator, so only the value side needs spelling. `min`/`max`
 * and `and`/`or` are symmetric instead — each returns whichever side is non-null
 * (`NumberHelper.min:556-559`, `Operator.and`/`Operator.or`) — and SQLite's scalar `MIN`/`MAX` return
 * NULL when any argument is, so those need both sides spelled. Getting this from the reference rather
 * than from the fixture matters: every corpus scenario drops its unproductive members before the fold,
 * so a `ProductiveByStrategy` traversal is the only place the difference shows and no scenario names it.
 */

/** The BULK pair — `sideEffects.add` receives a whole site's members, not one member
 *  (`AggregateStep.java:131-132`). A collection question, not an expression one. */
export const BULK_OPS: ReadonlySet<string> = new Set(['addAll', 'assign']);

/** The operators `mergeStep` spells — every `Operator` that folds MEMBER BY MEMBER. `sumLong` is
 *  absent: it is `add` narrowed to `long` by a cast the Gremlin string grammar cannot even produce a
 *  use for here, so admitting it would claim a promotion rule nothing has asked for. */
export const FOLD_OPS: ReadonlySet<string> = new Set(['sum', 'minus', 'mult', 'div', 'min', 'max', 'and', 'or']);

/** `a IS NULL` / `a IS NOT NULL`. */
const isNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is', left: e, right: compilerNull() });

/** The reference's symmetric null rule: whichever side is non-null, else the combination. Spelled for
 *  `min`/`max`/`and`/`or`, whose SQL spellings all answer NULL where the reference answers a value. */
const eitherOr = (acc: Expr, value: Expr, combined: Expr): Expr => ({
  kind: 'case',
  whens: [[isNull(acc), value], [isNull(value), acc]],
  else: combined,
});

/** The arithmetic null rule: a NULL VALUE is the identity; a NULL accumulator propagates, which SQL's
 *  own arithmetic already does. */
const identityOnNull = (acc: Expr, value: Expr, combined: Expr): Expr => ({
  kind: 'case', whens: [[isNull(value), acc]], else: combined,
});

/**
 * ONE FOLD STEP — the accumulator so far combined with the next value, or `null` for an operator this
 * does not spell (a caller declines on it).
 *
 * `div` is SQLite's plain `/`, deliberately: on two integers it is integer division and on a real
 * operand it is real, which is exactly `NumberHelper.div`'s "highest common number class" promotion.
 * Forcing REAL would answer `128.0` where the reference answers the integer `128`.
 */
export function mergeStep(operator: string, acc: Expr, value: Expr): Expr | null {
  const arith = (op: '+' | '-' | '*' | '/'): Expr =>
    identityOnNull(acc, value, { kind: 'binary', op, left: acc, right: value });
  const extremum = (fn: 'MIN' | 'MAX'): Expr =>
    eitherOr(acc, value, { kind: 'call', fn, args: [acc, value] });
  const logical = (op: 'and' | 'or'): Expr =>
    eitherOr(acc, value, { kind: 'binary', op, left: acc, right: value });
  switch (operator) {
    case 'sum': return arith('+');
    case 'minus': return arith('-');
    case 'mult': return arith('*');
    case 'div': return arith('/');
    case 'min': return extremum('MIN');
    case 'max': return extremum('MAX');
    case 'and': return logical('and');
    case 'or': return logical('or');
    default: return null;
  }
}

/** Does this operator produce a BOOLEAN rather than a value whose storage class the fold discovers?
 *  `and`/`or` do, and nothing else does — which is what decides whether the result's type is stated
 *  statically or read off `typeof(…)` at the wire (the `result: 'number'` framing arm). */
export const isLogicalOp = (operator: string): boolean => operator === 'and' || operator === 'or';
