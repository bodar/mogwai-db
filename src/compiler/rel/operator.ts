import { col, compilerInt, compilerNull, compilerReal, compilerText, type BinaryOp, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import { raiseExpr } from '../../rel/raise.ts';
import type { Rel } from '../../rel/rel.ts';
import { isOperatorArg, type Arg, type MergePolicy } from '../../gremlin/frontend.ts';
import { flatType, numberClassOf } from '../../gremlin/types.ts';
import { perRowColumnOf, STATIC, staticTypeOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { eq, meta, rowNumberWindow, typeOf, type Minter } from './build.ts';
import { constLit } from './const.ts';
import type { FramedRel } from './framing.ts';
import { extremumKeepingFirst, REDUCED_TYPE, SAFE_INT } from './reducer.ts';

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
 * so for the arithmetic four a NULL VALUE is the identity and a NULL ACCUMULATOR propagates. `min`/`max`
 * and `and`/`or` are symmetric instead — each returns whichever side is non-null
 * (`NumberHelper.min:556-559`, `Operator.and`/`Operator.or`) — and SQLite's scalar `MIN`/`MAX` return
 * NULL when any argument is, so those need both sides spelled. Getting this from the reference rather
 * than from the fixture matters: every corpus scenario drops its unproductive members before the fold,
 * so a `ProductiveByStrategy` traversal is the only place the difference shows and no scenario names it.
 *
 * ## The ANSWER can be an error, and SQLite's operators are not Java's at the edges
 *
 * SQLite's INTEGER is a Java `long` and its REAL a `double`, and between them its `+ - * /` are
 * `NumberHelper`'s — except that SQLite PROMOTES a 64-bit overflow to REAL and answers NULL for `x / 0`,
 * where the reference throws `long overflow` and `/ by zero`. So the step (`foldStep`) checks exactly
 * those edges and RAISES mid-walk (`raiseExpr`, `src/rel/raise.ts`); a class it does not reproduce
 * (`byte`/`short`/`float`/`BigInteger`/`BigDecimal`) or a non-finite double raises a deferral; and the
 * result's CLASS (`int`/`long`/`double`) is carried as flags beside the accumulator rather than guessed
 * from its magnitude.
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

/** The operators `foldStep` spells — every `Operator` that folds MEMBER BY MEMBER. `sumLong` is
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

/**
 * The operators for which folding a value TWICE is folding it ONCE — `min`/`max`/`and`/`or` are
 * idempotent, so a fold over them answers the same whether or not the reference bulked equal
 * traversers before it (`FoldStep.projectTraverser` applies the operator once per traverser, whatever its
 * bulk). Every other operator is bulk-SENSITIVE, and a caller must prove the reference bulked nothing
 * (`referenceUnbulkedAt`, `ir/bulk.ts`) before folding rows that may repeat.
 */
export const BULK_INVARIANT_OPS: ReadonlySet<string> = new Set(['min', 'max', 'and', 'or']);

/** Does this operator produce a BOOLEAN rather than a value whose class the fold discovers? */
const isLogicalOp = (operator: string): boolean => operator === 'and' || operator === 'or';
const isExtremum = (operator: string): boolean => operator === 'min' || operator === 'max';

/**
 * A member's CLASS, as the walk reads it — a small code rather than the vtype string, because the walk
 * consults it in several arms and a code is short where every arm is paid for in statement text.
 *
 * `int`/`long`/`double` are the three `Number` classes this fold reproduces EXACTLY: SQLite's INTEGER is
 * a Java `long` and its REAL a `double`, and `NumberHelper`'s promotion between them is spelled below.
 * `UNSUPPORTED` is every other `Number` — a `byte`/`short` keeps its own class through the reference's
 * arithmetic, a `float` is folded in 32-bit precision, a `BigInteger` never overflows and a `BigDecimal`
 * is exact; none of those is a SQLite storage class, so a fold over one RAISES a deferral rather than
 * answer a nearby number. `OTHER` is everything that is not a `Number`, a `String` or a `Boolean`.
 */
const KIND = { none: 0, int: 1, long: 2, double: 3, string: 4, boolean: 5, unsupported: 8, other: 9 } as const;
const UNSUPPORTED_NUMBERS: readonly string[] = ['byte', 'short', 'float', 'bigint', 'bigdecimal'];
const kindOfTag = (tag: string): number =>
  tag === 'int' ? KIND.int : tag === 'long' ? KIND.long : tag === 'double' ? KIND.double
    : tag === 'string' ? KIND.string : tag === 'boolean' ? KIND.boolean
      : UNSUPPORTED_NUMBERS.includes(tag) ? KIND.unsupported : KIND.other;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

// ---- small Expr spellings, named so the arms below read as the reference's rules ----
const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const isNull = (e: Expr): Expr => bin('is', e, compilerNull());
const eqInt = (e: Expr, n: number): Expr => bin('=', e, compilerInt(n));
const inInts = (e: Expr, ns: readonly number[]): Expr => ({ kind: 'in-list', expr: e, values: ns.map(compilerInt) });
const typeOfIs = (e: Expr, storage: 'integer' | 'real' | 'text'): Expr => bin('=', { kind: 'call', fn: 'typeof', args: [e] }, compilerText(storage));
const outsideInt32 = (e: Expr): Expr => bin('or', bin('>', e, compilerInt(INT32_MAX)), bin('<', e, compilerInt(INT32_MIN)));
const outsideInt32Integer = (e: Expr): Expr => bin('and', typeOfIs(e, 'integer'), outsideInt32(e));
/** A REAL within the finite range — SQLite carries `±Infinity` as a REAL and a NaN as NULL, and both
 *  fail this. Only for a REAL: `abs` of the INTEGER -2^63 is itself an overflow error. */
const finiteReal = (e: Expr): Expr => bin('<=', { kind: 'call', fn: 'abs', args: [e] }, compilerReal(Number.MAX_VALUE));
const when = (pred: Expr, then: Expr, otherwise?: Expr): Expr => ({ kind: 'case', whens: [[pred, then]], ...(otherwise ? { else: otherwise } : {}) });

/**
 * A member's class CODE (`KIND`), read off the type channel wherever the stream has one — the operand
 * side of the reducer vocabulary's eligibility, decided per member. A NULL value is `none` whatever its
 * tag: `NumberHelper` treats a null operand as the identity (`mathOperationWithPromote:401-402`,
 * `min:556-559`), so it is not a class question at all.
 *
 * - **a STATIC class** is one code for every member;
 * - **a PER-ROW tag** is decided per member, and a NULL tag ("infer this one from the value") falls back
 *   to the storage class;
 * - **NO tag** leaves only the storage class: an INTEGER is an `int` unless it is outside the 32-bit
 *   range (a `long`, which is how a GraphSON reader would type it), a REAL a `double`, TEXT a `String`.
 */
function memberKind(value: Expr, tag: string | undefined, rowTag: Expr | null): Expr {
  if (tag !== undefined) return when(isNull(value), compilerInt(KIND.none), compilerInt(kindOfTag(tag)));
  const byStorage: Expr = {
    kind: 'case',
    whens: [
      [isNull(value), compilerInt(KIND.none)],
      [typeOfIs(value, 'integer'), when(outsideInt32(value), compilerInt(KIND.long), compilerInt(KIND.int))],
      [typeOfIs(value, 'real'), compilerInt(KIND.double)],
      [typeOfIs(value, 'text'), compilerInt(KIND.string)],
    ],
    else: compilerInt(KIND.other),
  };
  if (!rowTag) return byStorage;
  const tagIn = (tags: readonly string[]): Expr => ({ kind: 'in-list', expr: rowTag, values: tags.map(compilerText) });
  return {
    kind: 'case',
    whens: [
      [isNull(rowTag), byStorage],
      [isNull(value), compilerInt(KIND.none)],
      ...(['int', 'long', 'double', 'string', 'boolean'] as const).map((t) => [tagIn([t]), compilerInt(kindOfTag(t))] as const),
      [tagIn(UNSUPPORTED_NUMBERS), compilerInt(KIND.unsupported)],
    ],
    else: compilerInt(KIND.other),
  };
}

/**
 * A member's VALUE in the storage class its code names. A `long` past 2^53 rides as decimal TEXT
 * (`types.ts`, `SAFE_INT`) and must be read back as the INTEGER it is — the §6·7 bug `sum()` already
 * fixed (`inject(9007199254740993L, 1L).fold(0L, Operator.sum)` answered `1` when a `typeof` guard
 * excluded it). Only a tagged member needs the cast: an untagged one already has its own storage class.
 */
function memberValue(value: Expr, tag: string | undefined, rowTag: Expr | null): Expr {
  const asInt: Expr = { kind: 'cast', arg: value, to: 'int' };
  const asReal: Expr = { kind: 'cast', arg: value, to: 'real' };
  if (tag !== undefined) return tag === 'int' || tag === 'long' ? asInt : tag === 'double' ? asReal : value;
  if (!rowTag) return value;
  return {
    kind: 'case',
    whens: [
      [{ kind: 'in-list', expr: rowTag, values: [compilerText('int'), compilerText('long')] }, asInt],
      [bin('=', rowTag, compilerText('double')), asReal],
    ],
    else: value,
  };
}

/**
 * The SEED's class, or `null` for a seed this fold does not take (a decline: the traversal's answer is
 * the reference's own exception, or a class the walk does not reproduce). The seed is a compile-time
 * literal or a user parameter, so this is a static question.
 *
 * `Operator.sum`/`minus`/`mult`/`div` cast both sides to `Number` (`Operator.java:40-86`) — and the cast
 * happens BEFORE `mathOperationWithPromote`'s null check, so a NULL seed is legal and propagates. `min`/
 * `max` take a `Comparable`. `and`/`or` take a boolean, and a NULL seed there is DECLINED: `and(null, b)`
 * answers `b` UNCAST (`Operator.java:131-168`), so the accumulator would become whatever the first member
 * is, and the result would no longer be the boolean this fold frames.
 */
function seedClass(operator: string, seed: Arg): 'int' | 'long' | 'double' | 'string' | 'boolean' | 'null' | null {
  const value = seed.value;
  const cls = value === null ? 'null'
    : typeof value === 'boolean' ? 'boolean'
      : typeof value === 'string' ? 'string'
        : typeof value === 'number' && Number.isFinite(value) ? numberClass(value, flatType(seed.type))
          : null;
  if (cls === null) return null;
  if (isLogicalOp(operator)) return cls === 'boolean' ? cls : null;
  if (cls === 'null' || cls === 'int' || cls === 'long' || cls === 'double') return cls;
  return isExtremum(operator) && cls === 'string' ? cls : null;
}

/** A finite number's class: its declared one where the channel said, else what a GraphSON reader infers. */
const numberClass = (value: number, declared: string | null): 'int' | 'long' | 'double' | null => {
  if (declared === 'int' || declared === 'long' || declared === 'double') return declared;
  if (declared !== null) return null;
  return numberClassOf(value);
};

/** The member classes an operator can fold — a STATIC class outside it is every member's exception (or
 *  a class this walk does not reproduce), so the traversal declines rather than raise on every row. */
const staticKindFolds = (operator: string, seed: string, kind: number): boolean => {
  if (isLogicalOp(operator)) return kind === KIND.boolean;
  const numeric = kind === KIND.int || kind === KIND.long || kind === KIND.double;
  if (!isExtremum(operator)) return numeric;
  // `min`/`max` compare two numbers numerically and two strings by `compareTo`; a string against a
  // number is `"z".compareTo(27)`, the reference's exception
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:582-597`).
  return seed === 'string' ? kind === KIND.string : seed === 'null' ? numeric || kind === KIND.string : numeric;
};

/**
 * The messages a fold RAISES mid-walk. Two are the reference's own, verbatim: `Math.addExact`/
 * `subtractExact`/`multiplyExact` and `LONG_NUMBER_HELPER.div` throw `long overflow` at the 64th bit,
 * and `mathOperationWithPromote` RETHROWS it there rather than promote further
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:167-177,400-425`);
 * integer division by zero is Java's `/ by zero`, rethrown the same way. The other three are named
 * rather than imitated: two DEFERRALS — answers the reference gives that this walk does not reproduce
 * (a non-finite double, a class outside `int`/`long`/`double`/`String`) — and the reference's own
 * `ClassCastException` (a member the operator cannot act on), whose Java text names JVM modules. Every
 * message is inlined in the statement, which is why they are short.
 */
const raises = (operator: string) => ({
  overflow: 'long overflow',
  divByZero: '/ by zero',
  nonFinite: `Operator.${operator}: a non-finite double result is not supported`,
  unsupported: `Operator.${operator}: byte, short, float, BigInteger, BigDecimal and non-scalar values are not supported`,
  cannotAct: `ClassCastException: Operator.${operator} cannot act on this value`,
});

/** The walk's columns: the member ordinal reached so far, the accumulator, and the two class flags —
 *  "a `long` has been seen" and "a `double` has been seen", which together are the result's class
 *  (`NumberHelper.getHighestCommonNumberClass` over every operand so far). Named apart from the member
 *  relation's own columns so the recursive term's join declares no duplicate. */
const FOLD_POS = 'fo';
const FOLD_ACC = 'fa';
const FOLD_LONG = 'fl';
const FOLD_REAL = 'fr';
/** The member relation's columns as the term reads them — its value (raw, then classified), its type
 *  tag where the stream carries one per row, its class code, and its position. */
const MEMBER_RAW = 'mr';
const MEMBER_TAG = 'mt';
const MEMBER_VAL = 'mv';
const MEMBER_KIND = 'mk';
const MEMBER_ORD = 'mo';

/**
 * ONE FOLD STEP — the accumulator `acc` combined with the member `value` of class code `kind`, as the
 * reference computes it, RAISING exactly where it raises. `null` for an operator this does not spell.
 *
 * - **arithmetic** (`sum`/`minus`/`mult`/`div`): a NULL member is the identity and a NULL accumulator
 *   propagates (`mathOperationWithPromote:401-402`). On two INTEGERs SQLite's operators are a Java
 *   `long`'s — `/` truncates toward zero exactly as Java does — except at the two edges SQLite does NOT
 *   share: it promotes an overflow to REAL where the reference raises `long overflow`, and answers NULL
 *   for `x / 0` where it raises `/ by zero`. On a REAL operand it is `double` arithmetic, whose one
 *   unrepresentable answer is a non-finite double (SQLite answers NULL; the reference answers
 *   `Infinity`/`NaN`), which raises a deferral.
 * - **`min`/`max`**: either side NULL answers the other (`NumberHelper.min:556-559`); two numbers
 *   compare numerically and two strings by `compareTo`, and a mixed pair is the reference's exception.
 * - **`and`/`or`**: the seed is a boolean (`seedClass`), so the accumulator never is NULL and only a
 *   NULL member is the identity; a non-boolean member is `(boolean)`'s exception.
 */
function foldStep(operator: string, acc: Expr, value: Expr, kind: Expr): Expr | null {
  const say = raises(operator);
  const raise = (message: string): Expr => raiseExpr(message, value);
  const numeric = inInts(kind, [KIND.int, KIND.long, KIND.double]);
  const integral = inInts(kind, [KIND.int, KIND.long]);
  const not = (e: Expr): Expr => ({ kind: 'unary', op: 'not', arg: e });
  const arith = (op: '+' | '-' | '*' | '/'): Expr => {
    const result = bin(op, acc, value);
    const intByInt = bin('and', typeOfIs(acc, 'integer'), integral);
    return {
      kind: 'case',
      whens: [
        [eqInt(kind, KIND.none), acc],
        [eqInt(kind, KIND.unsupported), raise(say.unsupported)],
        // `(Number) b` — a String, a Boolean, a collection or an element is the reference's exception.
        [not(numeric), raise(say.cannotAct)],
        [isNull(acc), compilerNull()],
        ...(op === '/' ? [[bin('and', intByInt, eqInt(value, 0)), raise(say.divByZero)] as const] : []),
        // `long` arithmetic: SQLite answers a REAL exactly where `Math.*Exact` would throw.
        [intByInt, when(typeOfIs(result, 'integer'), result, raise(say.overflow))],
        // `double` arithmetic (an operand is REAL, so the result is): a NULL is a NaN and anything past
        // the finite range an infinity — both comparisons are then false.
        [finiteReal(result), result],
      ],
      else: raise(say.nonFinite),
    };
  };
  // The ACCUMULATOR keeps a tie — `FoldStep` applies `operator.apply(seed, value)` — observable for a
  // `-0.0` against a `0.0` (`reducer.ts` `extremumKeepingFirst`).
  const extremum = (fn: 'min' | 'max'): Expr => ({
    kind: 'case',
    whens: [
      [eqInt(kind, KIND.none), acc],
      // A `Boolean`, a `UUID`, a `Date` are `Comparable` and the reference answers over them; this walk
      // does not reproduce their order or class, so they DEFER. A collection is the reference's exception.
      [inInts(kind, [KIND.unsupported, KIND.boolean, KIND.other]), raise(say.unsupported)],
      [isNull(acc), value],
      [bin('!=', typeOfIs(acc, 'text'), eqInt(kind, KIND.string)), raise(say.cannotAct)],
    ],
    else: extremumKeepingFirst(fn, acc, value),
  });
  const logical = (op: 'and' | 'or'): Expr => ({
    kind: 'case',
    whens: [
      [eqInt(kind, KIND.none), acc],
      [not(eqInt(kind, KIND.boolean)), raise(say.cannotAct)],
    ],
    else: bin(op, acc, value),
  });
  switch (operator) {
    case 'sum': return arith('+');
    case 'minus': return arith('-');
    case 'mult': return arith('*');
    case 'div': return arith('/');
    case 'min': return extremum('min');
    case 'max': return extremum('max');
    case 'and': return logical('and');
    case 'or': return logical('or');
    default: return null;
  }
}

/**
 * THE SEEDED LEFT FOLD — a member relation folded into ONE value by a member-by-member `Operator`, as a
 * `Recursive` walk over the ordered members. `null` declines.
 *
 * Two places declare one, and both are the same left fold:
 *
 * - `withSideEffect(k, seed, Operator.x)` + `cap(k)`: `sideEffects.add(k, v)` is
 *   `set(k, getReducer(k).apply(get(k), v))`
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/DefaultTraversalSideEffects.java:88-91`),
 *   once per member WITH its multiplicity (`AggregateStep.processAllStarts` iterates the `BulkSet`), so
 *   every member row folds;
 * - `fold(seed, Operator.x)`: `ReducingBarrierStep.processAllStarts` is
 *   `seed = reducingBiOperator.apply(seed, projectTraverser(start))` for every start, the seed supplied
 *   once up front (`…/step/util/ReducingBarrierStep.java:99-111`), and `FoldBiOperator` applies the
 *   declared function and nothing else (`…/step/map/FoldStep.java:84-101`) — once per TRAVERSER, which
 *   is why the caller, not this walk, answers whether a row may stand for a bulked one.
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
 * **The walk RAISES where the reference raises** (`foldStep`, through `raiseExpr`): a member is folded
 * in order, so the first member the reference would throw on is the first this walk throws on.
 *
 * **ZERO members still answer the SEED**, and it falls out rather than needing an arm: the walk's seed
 * row is `(0, seed)` and no member joins to it, so the last row IS the seed — `get(k)` over a side
 * effect nothing added to, and `FoldStep`'s seed over an empty stream (`hasNextBarrier` is true once
 * `processAllStarts` has drawn the supplier), exactly. Nothing here is materialized, so the same plan
 * serves a CORRELATED child (`by(__.values(k).fold(0, Operator.sum))`), whose member relation reads the
 * outer row and which a fence would cut off from it.
 *
 * The answer is ONE row with `v` and `vt` and NO channels: it is a fresh traverser, which is what a
 * reducing barrier emits.
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
  const seedCls = seedClass(operator, policy.seed);
  if (seedCls === null) return null;
  const literal = constLit(policy.seed);
  if (!literal) return null;
  // A numeric seed is CAST to its class's storage class: a user PARAMETER binds as INTEGER on Bun and
  // REAL on DO (root CLAUDE.md), and the walk reads the accumulator's storage class as its class.
  const seed: Expr = seedCls === 'int' || seedCls === 'long' ? { kind: 'cast', arg: literal, to: 'int' }
    : seedCls === 'double' ? { kind: 'cast', arg: literal, to: 'real' } : literal;
  const staticTag = staticTypeOf(type);
  if (staticTag !== undefined && !staticKindFolds(operator, seedCls, kindOfTag(staticTag))) return null;

  const keys = order.map((_, i) => `k${i}`);
  const keyCols = keys.map((key) => meta(key, 'any', true));
  const typeCol = perRowColumnOf(type);
  // The members, narrowed to what the fold reads — the raw value, its per-row tag, its order keys.
  // Narrowing is also what keeps the walk's join from declaring a column name twice.
  const narrowed = make.project({
    id: fresh('sn'), input: members, channels: [],
    type: typeOf(meta(MEMBER_RAW, 'any', true), ...(typeCol ? [meta(MEMBER_TAG, 'text', true)] : []), ...keyCols),
    exprs: [[MEMBER_RAW, col(members.id, value)],
      ...(typeCol ? [[MEMBER_TAG, col(members.id, typeCol)] as const] : []),
      ...order.map((name, i) => [keys[i]!, col(members.id, name)] as const)],
  });
  const ordinals = rowNumberWindow(narrowed, MEMBER_ORD, [],
    { partitionBy: [], orderBy: keys.map((key) => ({ expr: col(narrowed.id, key), dir: 'asc' as const })) }, fresh);
  // Each member CLASSIFIED — its value in its class's storage class, and its class code — AFTER the
  // window, whose nested SELECT makes the raw value a plain column: classified before it, the stream's
  // own value expression (often a `CASE` over the stored vtype) was inlined at each of a dozen uses.
  const raw = col(ordinals.id, MEMBER_RAW);
  const rowTag = typeCol ? col(ordinals.id, MEMBER_TAG) : null;
  const numbered = make.project({
    id: fresh('sc'), input: ordinals, channels: [],
    type: typeOf(meta(MEMBER_VAL, 'any', true), meta(MEMBER_KIND, 'int'), meta(MEMBER_ORD, 'int')),
    exprs: [[MEMBER_VAL, memberValue(raw, staticTag, rowTag)], [MEMBER_KIND, memberKind(raw, staticTag, rowTag)],
      [MEMBER_ORD, col(ordinals.id, MEMBER_ORD)]],
  });

  const walkType = typeOf(meta(FOLD_POS, 'int'), meta(FOLD_ACC, 'any', true), meta(FOLD_LONG, 'int'), meta(FOLD_REAL, 'int'));
  const walkId = fresh('sr');
  let foldable = true;
  const walk = make.recursive({
    id: walkId, name: `fd_${walkId}`, channels: [], type: walkType, cols: [FOLD_POS, FOLD_ACC, FOLD_LONG, FOLD_REAL],
    seed: make.values({
      id: fresh('ss'), channels: [], type: walkType,
      rows: [[compilerInt(0), seed, compilerInt(seedCls === 'long' ? 1 : 0), compilerInt(seedCls === 'double' ? 1 : 0)]],
    }),
    step: (self) => {
      const joined = make.join({
        id: fresh('sj'), left: self, right: numbered, join: 'inner', channels: [],
        type: typeOf(...walkType.cols, meta(MEMBER_VAL, 'any', true), meta(MEMBER_KIND, 'int'), meta(MEMBER_ORD, 'int')),
        on: eq(col(numbered.id, MEMBER_ORD), bin('+', col(self.id, FOLD_POS), compilerInt(1))),
      });
      const acc = col(joined.id, FOLD_ACC);
      const kind = col(joined.id, MEMBER_KIND);
      const folded = foldStep(operator, acc, col(joined.id, MEMBER_VAL), kind);
      if (!folded) { foldable = false; return self; }
      // THE CLASS FLAGS. A `long` member makes the class `long` and a `double` one `double`
      // (`getHighestCommonNumberClass`); so does an `int` result outside 32 bits, because
      // `INTEGER_NUMBER_HELPER` overflows there and `mathOperationWithPromote` retries the operation as
      // a `long` (`NumberHelper.java:400-425`) — after which every later operand meets a `long`. That
      // last fact is read off the INCOMING accumulator, one step late, rather than off `folded`: the
      // emitter inlines `folded` at every use, and three copies of the whole step tripled the statement.
      // The final accumulator is checked once more where the class is stated (below), so no
      // intermediate result escapes the check.
      const flag = (column: string, set: Expr): Expr => when(set, compilerInt(1), col(joined.id, column));
      const promoted = bin('or', eqInt(kind, KIND.long), outsideInt32Integer(acc));
      return make.project({
        id: fresh('sp'), input: joined, channels: [], type: walkType,
        exprs: [[FOLD_POS, col(joined.id, MEMBER_ORD)], [FOLD_ACC, folded],
          [FOLD_LONG, flag(FOLD_LONG, promoted)], [FOLD_REAL, flag(FOLD_REAL, eqInt(kind, KIND.double))]],
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
  const acc = col(deepest.id, FOLD_ACC);
  if (isLogicalOp(operator)) {
    return {
      rel: make.project({ id: fresh('sv'), input: deepest, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', acc]] }),
      framing: { kind: 'scalar', type: STATIC('boolean'), productiveNull },
    };
  }
  // THE RESULT'S CLASS IS THE FLAGS', stated as a Gremlin vtype the framer resolves exactly (`int`/
  // `long`/`double`/`string`) rather than a storage class it would guess a width for: a `long` seed or
  // member makes a `long` even where the value fits 32 bits, and a `double` makes `min(1, 2.5)` the
  // `Double` `1.0`, where SQLite's `MIN` answers the INTEGER `1`. An integer past 2^53 leaves as exact
  // decimal TEXT under `long` — `sumTower`'s rule (`reducer.ts`), because a JS number cannot carry it.
  const isLong = bin('or', eqInt(col(deepest.id, FOLD_LONG), 1), outsideInt32Integer(acc));
  const isReal = bin('or', eqInt(col(deepest.id, FOLD_REAL), 1), typeOfIs(acc, 'real'));
  const pastSafe = bin('or', bin('>', acc, compilerInt(SAFE_INT)), bin('<', acc, compilerInt(-SAFE_INT)));
  return {
    rel: make.project({
      id: fresh('sv'), input: deepest, channels: [],
      type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
      exprs: [
        ['v', {
          kind: 'case',
          whens: [[typeOfIs(acc, 'text'), acc], [isReal, { kind: 'cast', arg: acc, to: 'real' }],
            [pastSafe, { kind: 'cast', arg: acc, to: 'text' }]],
          else: acc,
        }],
        ['vt', {
          kind: 'case',
          whens: [[isNull(acc), compilerNull()], [typeOfIs(acc, 'text'), compilerText('string')],
            [isReal, compilerText('double')], [isLong, compilerText('long')]],
          else: compilerText('int'),
        }],
      ],
    }),
    framing: { kind: 'scalar', type: REDUCED_TYPE, result: 'number', productiveNull },
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
 *
 * ⚠️ **The identity holds only where the fold runs ONCE.** The two differ in their SUPPLIER: the no-arg
 * form's `ArrayListSupplier` makes a fresh list per `get()`, while `fold(seed, f)` wraps the one parsed
 * literal in a `ConstantSupplier` (`…/dsl/graph/GraphTraversal.java:1300`) — so in a per-traverser child,
 * re-seeded after each reset, every parent `addAll`s into the SAME list. Every list/map seed is subject to
 * that, and the compile declines such a fold before lowering wherever it may run per parent
 * (`perTraverserMutableFold`, `ir/fold-seed.ts`); this identity is therefore only ever read at the root.
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
