import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import { isOperatorArg, type MergePolicy } from '../../gremlin/frontend.ts';
import { flatType, REDUCER_CLASSES } from '../../gremlin/types.ts';
import { perRowColumnOf, STATIC, staticTypeOf, UNKNOWN, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { eq, meta, rowNumberWindow, typeOf, type Minter } from './build.ts';
import { constLit } from './const.ts';
import type { FramedRel } from './framing.ts';
import { CAST_TO_REAL, NUMERIC_CAST_TO_INT, NUMERIC_VTYPES, storedCompareOn } from './predicate.ts';
import { isLongSumClass, SAFE_INT } from './reducer.ts';

/**
 * `Operator` — ONE FOLD STEP, in the algebra, and the SEEDED LEFT FOLD that iterates it.
 *
 * A Gremlin `Operator.x` is a `BinaryOperator<Object>` and nothing more
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java`).
 * Every place a traversal declares one — `withSideEffect(k, seed, Operator.x)`, `withSack(seed,
 * Operator.x)`, `sack(Operator.x).by(v)`, `fold(seed, Operator.x)` — folds it the same way, so the
 * EXPRESSION and the WALK belong in one module. This is §6·4's split applied a second time: the
 * operator SET is data (`SACK_OPS`, `ir/step.ts`) and the SQL is emission, owned by the layer that
 * emits it.
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

/**
 * `Operator.addAll`, AS THE FRONT END SPELLS IT — lowercased, because `enumSuffix` lowercases every enum
 * suffix it reads (`Merge.onCreate` → `oncreate`) and one convention across the whole tagged-arg
 * vocabulary is worth more than matching Java's camelCase in one set. Named rather than inlined so the
 * three places that test for it cannot disagree about the casing — which they silently did once.
 */
export const ADD_ALL = 'addall';

/** `Operator.assign`, as the front end spells it — see `ADD_ALL` for why these are named. */
export const ASSIGN = 'assign';

/** The BULK pair — `sideEffects.add` receives a whole site's members, not one member
 *  (`AggregateStep.java:131-132`). A collection question, not an expression one. */
export const BULK_OPS: ReadonlySet<string> = new Set([ADD_ALL, ASSIGN]);

/** The operators `mergeStep` spells — every `Operator` that folds MEMBER BY MEMBER. `sumLong` is
 *  absent: it is `add` narrowed to `long` by a cast the Gremlin string grammar cannot even produce a
 *  use for here, so admitting it would claim a promotion rule nothing has asked for. */
export const FOLD_OPS: ReadonlySet<string> = new Set(['sum', 'minus', 'mult', 'div', 'min', 'max', 'and', 'or']);

/**
 * The operators a NAMED COLLECTION's read can spend — every `Operator` the Gremlin string grammar can
 * name, now that the two BULK ones are member-relation answers rather than expressions
 * (`collection.ts`: `seedAsSite` for `addAll`, `lastMember` for a per-traverser `assign`).
 *
 * `sumLong` is the one absent, and it is absent from `FOLD_OPS` for the same reason: it is `add`
 * narrowed to `long` by a cast nothing has asked for.
 */
export const COLLECTION_OPS: ReadonlySet<string> = new Set([...FOLD_OPS, ...BULK_OPS]);

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

/**
 * WHAT AN OPERATOR CAN ACT ON — the operand side of the reducer vocabulary's ELIGIBILITY policy
 * (`reducer.ts`), stated for the `Operator` set rather than restated per site, and READ OFF THE TYPE
 * CHANNEL wherever the stream has one. `null` declines.
 *
 * `Operator.sum`/`minus`/`mult`/`div` cast both sides to `Number` (`Operator.java:40-86`), `min`/`max`
 * take a `Comparable` (`NumberHelper.min:582`, `max:639`: two `Number`s compare numerically, anything
 * else by `compareTo`) and `and`/`or` a `boolean` (`Operator.java:131-168`). The reference raises a
 * `ClassCastException` on anything else. So the answer has three arms, by how much the channel says:
 *
 * - **a STATIC class** is a fact about every member. A `Number` class is CAST to its storage class
 *   (`storedCompareOn`, the one authority `order().by()` and `sum()` also use): a `long` past 2^53 rides
 *   as decimal TEXT (`types.ts`, `SAFE_INT`), and a `typeof` guard would EXCLUDE it — the §6·7 bug
 *   `sum()` already fixed (`lower.ts`, `isLongSumClass`), which answered `1` for
 *   `inject(9007199254740993L, 1L).fold(0L, Operator.sum)`. A class the operator cannot act on at all
 *   (a `string` into `sum`, a `boolean` into `max`) makes EVERY member the reference's exception, so it
 *   DECLINES rather than fold nothing into the seed.
 * - **a PER-ROW tag** decides the same question per member, through the same cast. A member whose tag
 *   the operator cannot act on reads as NULL — the identity for every operator here — which is the
 *   reducer's own policy (`reducer.ts`, "ELIGIBILITY"): a row-level answer cannot raise, and a
 *   heterogeneous stream is that policy's documented divergence (§6·7n). A NULL tag ("infer this one
 *   from the value") falls back to the storage class.
 * - **NO tag** leaves only the storage class, so it is the reducer's `typeof` guard exactly.
 *
 * **A BOOLEAN is the one class a storage class cannot see**: it is an INTEGER on this substrate
 * (`constLit` spells `true` as `1`), so the logical pair needs a channel that says `boolean` and
 * DECLINES without one — `typeof` would let an age into `Operator.and`.
 */
function eligibleOperand(operator: string, seed: unknown, value: Expr, type: ScalarType, members: Rel): Expr | null {
  const tag = staticTypeOf(type);
  const typeCol = perRowColumnOf(type);
  const rowTag = typeCol ? col(members.id, typeCol) : null;
  const when = (pred: Expr, then: Expr): Expr => ({ kind: 'case', whens: [[pred, then]] });
  const tagIn = (tagExpr: Expr, tags: readonly string[]): Expr => ({ kind: 'in-list', expr: tagExpr, values: tags.map(compilerText) });
  if (isLogicalOp(operator)) {
    if (tag !== undefined) return tag === 'boolean' ? value : null;
    return rowTag ? when(tagIn(rowTag, ['boolean']), value) : null;
  }
  // The tags (and, untagged, the storage classes) a member may carry: a `Number` — and for `min`/`max`
  // whatever is `Comparable` WITH THE SEED. Two numbers compare numerically and two strings by
  // `compareTo`, but a string against a number is the reference's exception
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:582-597`,
  // `"z".compareTo(27)`), so a string seed admits only strings and a number seed only numbers. Only a
  // NULL seed — which takes the first member as-is — leaves both, the reducer's own `comparable` set.
  // Over a STATIC class a mismatch is every member's exception, so it declines (the arm just below).
  const comparable = operator === 'min' || operator === 'max';
  const numbers = !comparable || typeof seed !== 'string';
  const strings = comparable && typeof seed !== 'number';
  if (tag !== undefined) {
    if (NUMERIC_VTYPES.includes(tag)) return numbers ? storedCompareOn(compilerText(tag))(value) : null;
    return tag === 'string' && strings ? value : null;
  }
  const byStorage = tagIn({ kind: 'call', fn: 'typeof', args: [value] },
    numbers && strings ? REDUCER_CLASSES.comparable : numbers ? REDUCER_CLASSES.arithmetic : ['text']);
  if (!rowTag) return when(byStorage, value);
  // `storedCompareOn`'s two casts, spelled as arms of the ONE eligibility `CASE` rather than nested
  // inside a second one: the member value is often an expression the emitter inlines at every use, so
  // each arm that names it is paid for in statement text (the `sql-hygiene` ratchet measured it).
  const cast = (to: 'int' | 'real'): Expr => ({ kind: 'cast', arg: value, to });
  return {
    kind: 'case',
    whens: [
      ...(numbers ? [[tagIn(rowTag, NUMERIC_CAST_TO_INT), cast('int')], [tagIn(rowTag, CAST_TO_REAL), cast('real')]] as const : []),
      ...(strings ? [[tagIn(rowTag, ['string']), value]] as const : []),
      [{ kind: 'binary', op: 'and', left: { kind: 'binary', op: 'is', left: rowTag, right: compilerNull() }, right: byStorage }, value],
    ],
  };
}

/**
 * Is this SEED a value `operator` can fold into without the reference's own `ClassCastException`? The
 * seed is a compile-time literal, so this is a static question and a refusal is a DECLINE: the
 * traversal's answer is an exception we do not spell, and computing `'a' + 1` would be a wrong one.
 * Whether the seed is comparable with the MEMBERS is `eligibleOperand`'s question, asked against the
 * stream's type channel.
 */
const seedAdmitted = (operator: string, seed: unknown): boolean =>
  seed === null
  || (isLogicalOp(operator) ? typeof seed === 'boolean'
    : operator === 'min' || operator === 'max' ? typeof seed === 'number' || typeof seed === 'string'
      : typeof seed === 'number');

/** The walk's two columns: the member ordinal reached so far, and the accumulator. Named apart from
 *  the member relation's own `v`/order columns so the recursive term's join declares no duplicate. */
const FOLD_POS = 'fo';
const FOLD_ACC = 'fa';
/** The member relation's columns as the term reads them — its value, and its position in the order. */
const MEMBER_VAL = 'mv';
const MEMBER_ORD = 'mo';

/**
 * THE SEEDED LEFT FOLD — a member relation folded into ONE value by a member-by-member `Operator`, as a
 * `Recursive` walk over the ordered members. `null` declines.
 *
 * Two places declare one, and both are the same left fold:
 *
 * - `withSideEffect(k, seed, Operator.x)` + `cap(k)`: `sideEffects.add(k, v)` is
 *   `set(k, getReducer(k).apply(get(k), v))`
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/DefaultTraversalSideEffects.java:88-91`).
 * - `fold(seed, Operator.x)`: `ReducingBarrierStep.processAllStarts` is
 *   `seed = reducingBiOperator.apply(seed, projectTraverser(start))` for every start, the seed supplied
 *   once up front (`…/step/util/ReducingBarrierStep.java:99-111`), and `FoldBiOperator` applies the
 *   declared function and nothing else (`…/step/map/FoldStep.java:84-101`).
 *
 * That is a walk, not an aggregate: see the header for why picking SQL aggregates instead would answer
 * two operators wrongly. `order` names the columns that order the members (the caller's encounter, or a
 * named collection's site ordinal then encounter); with none, `ROW_NUMBER` over no terms is well-defined
 * and arbitrary, the licence `foldScalars` takes over a stream with no encounter.
 *
 * **Only ONE node here is the walk, and the ordinal comes from OUTSIDE it.** A recursive term may hold
 * no window function (`recursive.ts`, `BARRIER_IN_TERM`), so the `ROW_NUMBER` that turns "the members
 * in order" into "the member at position n" is computed on the member relation and JOINED in — which
 * is legal precisely because the join opens a nested SELECT for it (`block.ts`: the barrier laws stop
 * at every nested SELECT, measured).
 *
 * **ZERO members still answer the SEED**, and it falls out rather than needing an arm: the walk's seed
 * row is `(0, seed)` and no member joins to it, so the last row IS the seed — `get(k)` over a side
 * effect nothing added to, and `FoldStep`'s seed over an empty stream (`hasNextBarrier` is true once
 * `processAllStarts` has drawn the supplier), exactly. Nothing here is materialized, so the same plan
 * serves a CORRELATED child (`by(__.values(k).fold(0, Operator.sum))`), whose member relation reads the
 * outer row and which a fence would cut off from it.
 *
 * The answer is ONE row with `v` (and, for a numeric fold, `vt`) and NO channels: it is a fresh
 * traverser, which is what a reducing barrier emits.
 */
export function seededLeftFold(
  members: Rel, value: string, type: ScalarType, order: readonly string[], policy: MergePolicy,
  productiveNull: boolean, fresh: Minter,
): FramedRel | null {
  const operator = policy.operator;
  // The BULK pair is named rather than falling into the generic decline, because the two refusals are
  // different facts: `addAll`/`assign` are a member-relation question this walk does not answer, and
  // anything else is not an `Operator` this fold spells at all.
  if (operator === undefined || BULK_OPS.has(operator) || !FOLD_OPS.has(operator)) return null;
  if (!seedAdmitted(operator, policy.seed.value)) return null;
  const seed = constLit(policy.seed);
  // A COLLECTION seed has no scalar literal form, which is `constLit`'s own answer — and it is only
  // ever legal for the BULK pair, already refused above.
  if (!seed) return null;
  const operand = eligibleOperand(operator, policy.seed.value, col(members.id, value), type, members);
  if (!operand) return null;

  const keys = order.map((_, i) => `k${i}`);
  const keyCols = keys.map((key) => meta(key, 'any', true));
  // The members, narrowed to what the fold reads — and to what the operator can ACT on, so the
  // eligibility rule is applied once, here, rather than inside every iteration. Narrowing is also what
  // keeps the walk's join from declaring a column name twice.
  const narrowed = make.project({
    id: fresh('sn'), input: members, channels: [], type: typeOf(meta(MEMBER_VAL, 'any', true), ...keyCols),
    exprs: [[MEMBER_VAL, operand],
      ...order.map((name, i) => [keys[i]!, col(members.id, name)] as const)],
  });
  const numbered = rowNumberWindow(narrowed, MEMBER_ORD, [],
    { partitionBy: [], orderBy: keys.map((key) => ({ expr: col(narrowed.id, key), dir: 'asc' as const })) }, fresh);

  const walkType = typeOf(meta(FOLD_POS, 'int'), meta(FOLD_ACC, 'any', true));
  const walkId = fresh('sr');
  let foldable = true;
  const walk = make.recursive({
    id: walkId, name: `fd_${walkId}`, channels: [], type: walkType, cols: [FOLD_POS, FOLD_ACC],
    seed: make.values({ id: fresh('ss'), channels: [], type: walkType, rows: [[compilerInt(0), seed]] }),
    step: (self) => {
      const joined = make.join({
        id: fresh('sj'), left: self, right: numbered, join: 'inner', channels: [],
        type: typeOf(meta(FOLD_POS, 'int'), meta(FOLD_ACC, 'any', true),
          meta(MEMBER_VAL, 'any', true), ...keyCols, meta(MEMBER_ORD, 'int')),
        on: eq(col(numbered.id, MEMBER_ORD),
          { kind: 'binary', op: '+', left: col(self.id, FOLD_POS), right: compilerInt(1) }),
      });
      const folded = mergeStep(operator, col(joined.id, FOLD_ACC), col(joined.id, MEMBER_VAL));
      if (!folded) { foldable = false; return self; }
      return make.project({
        id: fresh('sp'), input: joined, channels: [], type: walkType,
        exprs: [[FOLD_POS, col(joined.id, MEMBER_ORD)], [FOLD_ACC, folded]],
      });
    },
  });
  // One authority for SQLite's recursive-term laws, asked as a DECLINE here exactly as `repeatWalk`
  // asks it — and asking constructs the memoised step, so `foldable` reports the inner decline too.
  if (recursiveViolation(walk) || !foldable) return null;

  // THE LAST ROW IS THE ANSWER — the fold is linear, so the greatest ordinal is the completed
  // accumulator. Both nodes sit OUTSIDE the walk, where an `ORDER BY … LIMIT` means what it says.
  const deepest = make.limit({
    id: fresh('sl'), channels: [], type: walkType, count: compilerInt(1),
    input: make.sort({
      id: fresh('so'), input: walk, channels: [], type: walkType,
      terms: [{ expr: col(walk.id, FOLD_POS), dir: 'desc' }],
    }),
  });
  // **THE RESULT'S STORAGE CLASS IS DYNAMIC, exactly as a numeric reducer's is** — `NumberHelper`
  // returns the highest common class of the operands, so a fold of integers is an integer and one
  // touching a real is a real, and there is no compile-time tag to give. That is the `result: 'number'`
  // framing arm and its `vt` column (`reducer.ts`, `framing.ts`). `and`/`or` are the exception: they
  // answer a BOOLEAN, which `typeof` would report as `integer`, so they state their type.
  //
  // **AN INTEGER PAST 2^53 LEAVES AS EXACT TEXT**, which is `sumTower`'s rule (`reducer.ts`) for the
  // same reason: a JS number cannot carry it, so the wire would round the low bits away. Only a `long`
  // (or a `bigint`, when the members are) reaches that magnitude — a Java `int` cannot — so that is the
  // `vt` it frames under, and the framer's `long`/`bigint` arm reads the decimal string through `BigInt`.
  const logical = isLogicalOp(operator);
  const acc = col(deepest.id, FOLD_ACC);
  const storage: Expr = { kind: 'call', fn: 'typeof', args: [acc] };
  const pastSafe: Expr = {
    kind: 'binary', op: 'and',
    left: { kind: 'binary', op: '=', left: storage, right: compilerText('integer') },
    right: { kind: 'binary', op: '>', left: { kind: 'call', fn: 'abs', args: [acc] }, right: compilerInt(SAFE_INT) },
  };
  const memberClass = staticTypeOf(type);
  const wide = compilerText(memberClass !== undefined && isLongSumClass(memberClass) ? memberClass : 'long');
  return {
    rel: make.project({
      id: fresh('sv'), input: deepest, channels: [],
      type: typeOf(meta('v', 'any', true), ...(logical ? [] : [meta('vt', 'text', true)])),
      exprs: logical ? [['v', acc]] : [
        ['v', { kind: 'case', whens: [[pastSafe, { kind: 'cast', arg: acc, to: 'text' }]], else: acc }],
        ['vt', { kind: 'case', whens: [[pastSafe, wide]], else: storage }],
      ],
    }),
    framing: logical
      ? { kind: 'scalar', type: STATIC('boolean'), productiveNull }
      : { kind: 'scalar', type: UNKNOWN, result: 'number', productiveNull },
  };
}

/** `fold()` with no arguments — the ordinary LIST fold, which every fold site already lowers. */
export const PLAIN_FOLD = 'plain';

/**
 * WHAT A `fold` STEP DECLARES — the plain list fold, a seeded `(seed, Operator.x)` policy, or `null` for
 * a form this does not read (a decline).
 *
 * `fold(seed, foldFunction)` is the only other overload (`GraphTraversal.fold(E2, BiFunction)`), and in
 * the Gremlin string grammar its function is an `Operator`. **`fold([], Operator.addAll)` IS the plain
 * fold**, by the reference's own construction: the no-argument `FoldStep` constructor is
 * `this(traversal, ArrayListSupplier.instance(), Operator.addAll)` (`…/step/map/FoldStep.java:46-48`) —
 * an empty `ArrayList` seed, `addAll`, and `listFold` because that seed is a `Collection`. A `Set` seed is
 * NOT that (its `addAll` dedups), so only an empty LIST literal takes the identity.
 */
export function foldDeclared(step: IRStep): typeof PLAIN_FOLD | MergePolicy | null {
  const args = step.args ?? [];
  if (!args.length) return PLAIN_FOLD;
  const [seed, fn, extra] = args;
  if (!seed || !fn || extra || !isOperatorArg(fn.value)) return null;
  const operator = fn.value.operator;
  if (operator === ADD_ALL && seed.name == null && Array.isArray(seed.value) && !seed.value.length && flatType(seed.type) === 'list')
    return PLAIN_FOLD;
  return { seed, operator };
}
