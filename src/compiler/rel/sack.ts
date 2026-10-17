import type { Channel } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerReal, compilerText, type BinaryOp, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { exprMayRaise, INTEGER_OVERFLOW } from '../../rel/raise.ts';
import type { Rel } from '../../rel/rel.ts';
import { containsSelfRef, freeRelIds } from '../../rel/walk.ts';
import type { ValueType } from '../../gremlin/types.ts';
import { MERGED_VTYPE, PER_ROW, UNKNOWN } from '../../sql/kernel/render.ts';
import type { MergePolicy } from '../../gremlin/frontend.ts';
import { SACK_OPS } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import { carriedCols, meta, payloadCols, reducedVtype, typeOf, type Minter } from './build.ts';
import { hostTag, type ChildHost, type ChildSeam } from './child.ts';
import { constLit, declaredScalarType } from './const.ts';
import type { FramedRel } from './framing.ts';
import { byProjection, byTyped, keepOnNamed, modulations, productivityFilter, valueMayBeNull } from './modulator.ts';
import { deferral, evidenceOf, NUMBER_TAGS, numericOperandOffences, raisingRows, type ValueEvidence } from './receiver.ts';
import type { GraphSource } from './source.ts';

/**
 * THE SACK — a per-traverser accumulator, as an ordinary carried CHANNEL.
 *
 * `withSack(seed)` starts every traverser with a copy of the seed, `sack(Operator.x).by(v)` folds a
 * value into it, and a bare `sack()` makes it the current object. Three steps over one column.
 *
 * ## Why this module is small, and why that is the interesting part
 *
 * `src/channels.ts` already models `sack` completely: a `ChannelRole` with a merge policy
 * (`identical`), a barrier policy (`drop`), a slot in `ROLE_ORDER` before every other role, and a
 * group policy of `undefined` — so a movement collapse that would take one traverser's sack for
 * another's REFUSES by construction rather than by anyone remembering. `build.ts` declares the
 * column's type. None of that was written for this; it is what the channel core is.
 *
 * So nothing here re-projects a layout, and nothing here has to ask whether a sack may coexist with
 * an alias or a path. Deferring a sack through repeat, through a barrier, through `local`, and
 * splitting/merging it on a fork are all channel-obligation questions, which is the class §3.5's
 * checker answers for every channel at once. That is why this module is small: the problems a
 * hand-rolled sack layout would face are ones this layer does not have.
 *
 * ## What it does NOT do yet, and both are honest declines
 *
 * - **`withSack(seed, Operator.x)`** — the two-argument form names a MERGE operator, which decides
 *   how two traversers' sacks combine when bulking merges them. `CHANNEL_MERGE_POLICY` says
 *   `identical` today: two rows may merge only where their sacks already agree. A declared merge
 *   operator is a THIRD policy answer for the role, and adding one is a channels-core change rather
 *   than a step lowering, so the form declines here rather than silently ignoring the operator.
 * - **`barrier(Barrier.normSack)`** — normalizing the sack across a barrier is its own step.
 */

/** The sack's column. One name, because the seed, the mutation and the read must agree and the
 *  framing layer never sees it — a sack is spent by the time a payload is projected. */
export const SACK_COL = 'sack';
const SACK_CHANNEL: Channel = { col: SACK_COL, role: 'sack' };

/**
 * THE SACK'S TYPE TAG — a second column of the SAME role, so it is split, merged, dropped and refused
 * by exactly the policies the value is (`CHANNEL_GROUP_POLICY` and its siblings, `src/channels.ts`): the
 * tag is part of the sack and can never outlive or diverge from it.
 *
 * It holds the Gremlin `ValueType` the sack's value IS: the seed's declared type, an `assign`'s `by()`
 * evidence, and where neither says — an arithmetic fold, a `by()` known only by its storage class — the
 * tag the wire's inference would have framed it as (`storageTag`). It is TOTAL (NULL only for a NULL
 * sack), and that is load-bearing rather than tidy: a per-row type is AUTHORITATIVE to its consumers
 * (`predicateExpr`'s per-row arm has no storage fallback), so a NULL tag over a live value read as "no
 * class matches" — measured, `until(__.sack().is(P.gte(50)))` never fired and the walk ran forever.
 * Without the tag a
 * `withSack(true)` sack was SQLite's integer 1 to every reader: `sack()` framed Int 1, `asString()`
 * answered `'1'`, and `math('_+1')` answered 2.0 where `MathStep` raises
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:80-87`).
 * It reaches readers as a per-row `vtype` (`sackRead`, and the child read through `sackTagOf`), so
 * `hostTag`/`evidenceOf` carry it into every type-demanding consumer like any other host's tag.
 */
export const SACK_TYPE_COL = 'sackt';
const SACK_TYPE_CHANNEL: Channel = { col: SACK_TYPE_COL, role: 'sack' };

/** Both sack columns, minted together — the value first, so a lookup by ROLE finds the value. */
const withSack = (channels: Rel['channels']): Rel['channels'] =>
  withChannel(withChannel(channels, SACK_CHANNEL), SACK_TYPE_CHANNEL);

/** The sack's per-row TYPE TAG on a relation that carries it, else `undefined`. */
export const sackTagOf = (rel: Rel): Expr | undefined =>
  rel.channels.some((channel) => channel.col === SACK_TYPE_COL) ? col(rel.id, SACK_TYPE_COL) : undefined;

/** A value's evidence as a (partial) tag: a static tag as text, a per-row tag as itself, storage
 *  evidence as NULL. `totalTag` completes it. */
const tagOf = (evidence: ValueEvidence): Expr =>
  evidence.kind === 'static' ? compilerText(evidence.tag) : evidence.kind === 'tag' ? evidence.tag : compilerNull();

const call = (fn: string, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });

/**
 * The tag a value's STORAGE CLASS gives — what the wire's inference frames an untagged value as
 * (`ioc.anySerializer`: an integer in int32 range is an Int, a wider one a Long; a REAL a Double, which
 * also repairs an integral REAL that inference read as an Int), and a String for text. NULL for NULL.
 *
 * Spelled with the value TWICE, not once per arm: the value is routinely a fused arithmetic over a
 * correlated read, and a `CASE typeof(v) …` per class would repeat that subquery four times. `typeof` is
 * rewritten by `replace` (no class name contains another's), and the int32 test is the one-spelling
 * `abs(2v + 1) <= 2^32 - 1`.
 */
const storageTag = (value: Expr): Expr => {
  const int32: Expr = { kind: 'binary', op: '<=',
    left: call('abs', { kind: 'binary', op: '+', left: { kind: 'binary', op: '*', left: compilerInt(2), right: value }, right: compilerInt(1) }),
    right: compilerInt(4294967295) };
  const integral: Expr = { kind: 'case', whens: [[int32, compilerText('int')]], else: compilerText('long') };
  const renamed = [['integer', integral], ['real', compilerText('double')], ['text', compilerText('string')]] as const;
  const named = renamed.reduce<Expr>((inner, [cls, tag]) => call('replace', inner, compilerText(cls), tag), call('typeof', value));
  return call('nullif', call('nullif', named, compilerText('null')), compilerText('blob'));
};

/** A partial tag completed from the value's storage class. A literal tag is already total; a per-row one
 *  may be a reducer's raw storage-class name, which `reducedVtype` reads as a Gremlin tag or NULL. */
const totalTag = (tag: Expr, value: Expr): Expr =>
  tag.kind === 'lit' && tag.value !== null ? tag
    : tag.kind === 'lit' ? storageTag(value)
      : { kind: 'call', fn: 'COALESCE', args: [reducedVtype(tag), storageTag(value)] };

/** Does this relation carry a sack? Asked of the RELATION rather than of a flag, for `liveAliases`'
 *  reason: a barrier consumes the channel (`CHANNEL_BARRIER_POLICY`), and a reader that trusted a
 *  chain-level "there is a sack" would compile a reference to a column that is no longer there. */
export const sackCarried = (rel: Rel): boolean => rel.channels.some((channel) => channel.role === 'sack');

/**
 * `withSack(seed)` — the channel, seeded onto whatever the source produced. `null` declines.
 *
 * A separate node rather than an arm of each source's own seed projection, and deliberately: the
 * element scan and `inject()` build their rows differently and agree about nothing except that a
 * sack is carried state layered on top. The assembler fuses it back into one SELECT, so the extra
 * node costs nothing and the seeding rule has one home.
 */
export function seedSack(rel: Rel, spec: MergePolicy, fresh: Minter): Rel | null {
  // A merge operator is a channel-policy question, not a seed value — see the module header.
  if (spec.operator !== undefined) return null;
  // The seed travels as a whole `Arg`, so a PARAMETERIZED seed (`withSack($x)`) binds rather than
  // inlining — which the value/`initType` pair this replaced could not express, and therefore lost.
  const seed = constLit(spec.seed);
  if (!seed) return null;
  const tag = totalTag(hostTag(declaredScalarType(spec.seed), undefined) ?? compilerNull(), seed);
  const channels = withSack(rel.channels);
  const payload = payloadCols(rel);
  return make.project({
    id: fresh('sks'), input: rel, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      ...channels.map((channel) => [channel.col,
        channel.col === SACK_COL ? seed : channel.col === SACK_TYPE_COL ? tag : col(rel.id, channel.col)] as const),
    ],
  });
}

/**
 * `sack(Operator.x).by(v)` — fold a value into the sack. `null` declines.
 *
 * The `by()` comes through the ordinary modulator seam, so a property key, a `T` token, an alias read
 * and a correlated child body are all available here the day they are available anywhere.
 *
 * PRODUCTIVITY is the vocabulary's: a `by()` that yields nothing DROPS the traverser, exactly as it
 * does at `order()` and `dedup()`, so the rule is asked for rather than restated.
 */
export function sackMutate(
  step: IRStep, rel: Rel, host: ChildHost, child: ChildSeam, source: GraphSource, fresh: Minter,
  raiseAt: { readonly defer: boolean; readonly exact: boolean } = { defer: false, exact: true },
): Rel | null {
  const operator = sackOperator(step);
  if (!operator || !SACK_OPS.has(operator)) return null;
  // `assign` REPLACES, so it needs no prior value and MINTS the channel where the traversal declared
  // no `withSack()` — which is why `g.V().sack(assign).by('age').sack()` is a complete traversal.
  // Every other operator combines with what is there and declines without it — the rule
  // `sack(Operator.x) requires withSack() or a prior sack(assign)`.
  const carried = sackCarried(rel);
  if (!carried && operator !== 'assign') return null;
  // ONE `by()` — TinkerPop's own rule (`Sack step can only have one by modulator`), and a chain with
  // more is invalid Gremlin the Pass tier raises for, not a shape to pick a slot from.
  const bys = modulations(step, 1, child);
  if (!bys) return null;
  const by = bys[0] ?? { key: { kind: 'identity' } } as const;
  // The by() value WITH what is known of its type where the vocabulary can say (`byTyped`), else the
  // bare value known only by its storage class — what every fold did before the sack carried a tag.
  // Either way its PRESENCE rides with it: one lowering answers both.
  const typed = byTyped(by, host, source, fresh, child);
  const projected = typed ?? byProjection(by, host, source, fresh, false, child);
  if (!projected) return null;
  const value = projected.value;
  const evidence: ValueEvidence = typed?.evidence ?? { kind: 'storage' };
  // A sack step WITHOUT a by() folds the traverser itself, and `SackValueStep` drops nothing then — a null
  // traverser is folded as a null (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/SackValueStep.java:73-76`).
  // With one, an UNPRODUCTIVE `by()` FILTERS the traverser and a productive null is APPLIED (`:78-80`
  // tests `TraversalProduct.isProductive`, never the value), so the drop reads PRESENCE — and declines
  // where the producer cannot say.
  const drop = bys[0] ? productivityFilter(step, projected.present) : {};
  if (!drop) return null;

  // THREE NODES, and the middle one is why: the by() value has to be FILTERED on before it is folded
  // in, and a `Filter` between the fold and the relation the fold reads would put that relation one
  // level too far away (§3.3 — a `Col` names a relation in SCOPE, and scope is a node's direct
  // children). So the value is NAMED first, the drop reads the name, and the fold reads it again.
  // Spelling the by() expression once is the other half of the reason: it is routinely a correlated
  // subquery, and a filter that re-inlined it would spell the whole thing twice. The by()'s TYPE TAG is
  // named beside it for the same scope reason: a per-row tag reads the input relation, and the fold sits
  // two nodes above it — TOTAL, completed from the storage class where the by()'s evidence is partial —
  // and so is the operands' COMMON CLASS (`commonClass`), which every class-dependent test reads.
  const held = 'skv';
  const heldTag = 'skt';
  const heldClass = 'skc';
  const operandTotal = evidence.kind === 'static' ? compilerText(evidence.tag)
    : evidence.kind === 'tag' && evidence.nullOnlyForNull ? evidence.tag : totalTag(tagOf(evidence), value);
  const common = carried ? commonClass(col(rel.id, SACK_TYPE_COL), operandTotal) : compilerNull();
  // The presence rides as its own column only where it is NOT the value's non-nullness (a child's
  // EXISTS, an alias guard) — the stored-property case keeps reading the named value.
  const heldPresent = 'skp';
  const presentCol = drop.keep && !keepOnNamed(drop.keep, value, value) ? drop.keep : undefined;
  const payload = payloadCols(rel);
  // A MINTING `assign` adds the channel here, in the same projection that names the value — so the
  // fold below reads a column that exists whether or not a `withSack()` seeded one.
  const channels = carried ? rel.channels : withSack(rel.channels);
  const named = make.project({
    id: fresh('skb'), input: rel, channels,
    type: typeOf(...payload, meta(held, 'any', true), meta(heldTag, 'text', true), meta(heldClass, 'int', true),
      ...(presentCol ? [meta(heldPresent, 'int', true)] : []), ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      [held, value],
      [heldTag, operandTotal],
      [heldClass, common],
      ...(presentCol ? [[heldPresent, presentCol] as const] : []),
      ...channels.map((channel) => [channel.col,
        sackColumn(channel.col) && !carried ? compilerNull() : col(rel.id, channel.col)] as const),
    ],
  });
  // A FENCE where the relation is self-contained: the assembler otherwise re-inlines every column read as
  // the expression that computes it, and a fold spells its sack, its operand and both tags several times
  // (the value, the tag, the raise test), so a CHAIN of folds grew geometrically in statement text. Behind
  // the fence each is a plain column. Not over a correlated or recursive input — a fence hoists to a CTE,
  // where an outer reference resolves to nothing (`freeRelIds`, as `record.ts` gates it) and a walk's own
  // reference is refused (`containsSelfRef`).
  const base = freeRelIds(named).size === 0 && !containsSelfRef(named)
    ? make.materialize({ id: fresh('skz'), input: named, channels: named.channels, type: named.type })
    : named;
  const onValue = drop.keep && !presentCol ? keepOnNamed(drop.keep, value, col(base.id, held)) : undefined;
  const keep = presentCol ? col(base.id, heldPresent) : onValue;
  const kept = keep
    ? make.filter({ id: fresh('skf'), input: base, channels: base.channels, type: base.type, pred: keep })
    : base;
  // The operand can still be NULL wherever the drop did not test its nullness: a by()-less fold of a null
  // traverser, and a by() whose PRODUCTIVE null survived its presence drop (`valueMayBeNull`).
  const nullable = !bys[0] || (!onValue && valueMayBeNull(by, host));
  const facts = (at: Rel): FoldFacts => ({
    sack: col(at.id, SACK_COL), sackTag: col(at.id, SACK_TYPE_COL), operand: col(at.id, held),
    operandTag: evidence.kind === 'static' ? compilerText(evidence.tag) : col(at.id, heldTag),
    common: col(at.id, heldClass), nullable,
  });
  // THE RAISE IS A ROW PREDICATE (`raisingRows`), never a CASE inside the folded value: a sack nobody
  // reads afterwards (`count()`, `fold()`, `path()`, a bare element stream) is a select-list column
  // SQLite prunes, and the raise inside it went with it — `withSack(1).V().sack(sum).by('name')` answered
  // six vertices where `Operator.sum`'s `(Number)` cast raises on every one.
  const offences = foldOffences(operator, facts(kept), evidence);
  if (!offences) return null;
  // DEFERRED (`raiseAt.defer`, the fold's `raiseDefersTo`) where a head slice follows: `SackValueStep` folds
  // the traverser it is handed, so the raise belongs to the rows that slice keeps — the offending row rides
  // with its message rather than raising over every row before the slice decides
  // (`raise-channel.ts`). Only where the fold's own value raises nothing eagerly.
  const combinedOver = (over: Rel): Expr | null => combine(operator, facts(over));
  const eager = combinedOver(kept);
  const defer = raiseAt.defer && eager !== null && !exprMayRaise(eager) && !exprMayRaise(foldedTag(operator, facts(kept), eager));
  // Settled where it is born, the raise meets every row SQL scans — exact only where the reference pulls
  // every row too (`settlesExactly`); otherwise the fold declines rather than raise where it answers.
  if (offences.length && !defer && !raiseAt.exact) return null;
  const guarded = raisingRows(kept, offences, fresh, undefined, defer);
  const at = facts(guarded);
  const combined = combinedOver(guarded);
  if (!combined) return null;
  return make.project({
    id: fresh('skm'), input: guarded, channels: guarded.channels, type: typeOf(...payload, ...carriedCols(guarded.channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(guarded.id, column.name)] as const),
      ...guarded.channels.map((channel) => [channel.col,
        channel.col === SACK_COL ? combined : channel.col === SACK_TYPE_COL ? foldedTag(operator, at, combined) : col(guarded.id, channel.col)] as const),
    ],
  });
}

/** The columns one fold reads: the sack and the operand, each with its TOTAL tag, and their common class
 *  code. `nullable` says whether the operand can be NULL at all — only where no productivity filter dropped
 *  the row (a by()-less fold of a null traverser). */
interface FoldFacts {
  readonly sack: Expr;
  readonly sackTag: Expr;
  readonly operand: Expr;
  readonly operandTag: Expr;
  readonly common: Expr;
  readonly nullable: boolean;
}

const ARITHMETIC: ReadonlySet<string> = new Set(['sum', 'minus', 'mult', 'div']);
const sackColumn = (name: string): boolean => name === SACK_COL || name === SACK_TYPE_COL;

const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const isNull = (e: Expr): Expr => bin('is', e, compilerNull());
const not = (arg: Expr): Expr => ({ kind: 'unary', op: 'not', arg });
const caseOf = (whens: readonly (readonly [Expr, Expr])[], otherwise: Expr): Expr => ({ kind: 'case', whens, else: otherwise });
const path = (...parts: Expr[]): Expr => parts.reduce((left, right) => bin('||', left, right));

/**
 * `NumberHelper`'s CLASS LATTICE, one small integer per class — Byte, Short, Integer, Long, BigInteger,
 * Float, Double, BigDecimal as 0..7 — and the highest common class of every pair as a TABLE, built here
 * from `getHighestCommonNumberInfo`'s own rule (the wider bit count, floating if either side is:
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390`,
 * classes per `determineNumberClass`, `:861-873`), so Long with Float is Double and BigInteger with Float
 * BigDecimal, exactly as there.
 *
 * Lookups rather than arithmetic or a CASE, and that is load-bearing: each tag is SPELLED ONCE. Where the
 * fold cannot be fenced (a correlated or recursive input) the assembler re-inlines the previous fold's
 * tag at every read, so a tag read k times makes a chain of n folds k^n long — measured 110 KB for three
 * folds inside `local()` with a per-read formula.
 *
 * The integral classes are numbered BELOW every floating one and below BigInteger, which is what lets the
 * overflow widening be one `max(common, needed)`: a floating or BigInteger common class is never widened.
 */
const CLASSES = ['byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal'] as const;
const BITS = [8, 16, 32, 64, 128, 32, 64, 128];
const FLOATING = (code: number): boolean => code >= 5;
const classOf = (bits: number, fp: boolean): number =>
  fp ? (bits <= 32 ? 5 : bits <= 64 ? 6 : 7) : [8, 16, 32, 64, 128].indexOf(Math.max(bits, 8)) ;
const COMMON_TABLE = JSON.stringify(CLASSES.map((_, a) => CLASSES.map((_, b) =>
  classOf(Math.max(BITS[a]!, BITS[b]!), FLOATING(a) || FLOATING(b)))));
const LONG_CODE = 3;
const BIGINT_CODE = 4;
const BIGDECIMAL_CODE = 7;
const CLASS_CODES = JSON.stringify(Object.fromEntries(CLASSES.map((tag, code) => [tag, code])));
/** A tag's class code, NULL for a non-Number (or NULL) tag. */
const classCode = (tag: Expr): Expr => call('json_extract', compilerText(CLASS_CODES), path(compilerText('$.'), tag));
const classTag = (code: Expr): Expr => call('json_extract', compilerText(JSON.stringify(CLASSES)), path(compilerText('$['), code, compilerText(']')));
/** The two operands' highest common class code — NULL where either is not a Number. */
const commonClass = (sackTag: Expr, operandTag: Expr): Expr => call('json_extract', compilerText(COMMON_TABLE),
  path(compilerText('$['), classCode(sackTag), compilerText(']['), classCode(operandTag), compilerText(']')));

/**
 * The integral class an integer result NEEDS — the narrowest of Byte/Short/Integer/Long that holds it,
 * which is where `mathOperationWithPromote`'s overflow loop lands (`NumberHelper.java:401-428`: the
 * operation is retried one width up until it fits, so `127b + 1b` is the Short 128 and `-128b / -1b` the
 * Short 128). Read off the hex length of `|2r + 1|` (≤ 2 digits: r ∈ [-128, 127]; ≤ 4: a Short; ≤ 8: an
 * Integer) so the result is spelled once. A floating result's answer is never above Long, so `max` with a
 * floating common class leaves the common class.
 */
const neededClass = (result: Expr): Expr => {
  const span = call('abs', bin('+', bin('*', compilerInt(2), result), compilerInt(1)));
  const digits = call('min', call('length', call('printf', compilerText('%x'), span)), compilerInt(16));
  return call('json_extract', compilerText('[0,0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3]'), path(compilerText('$['), digits, compilerText(']')));
};

/** `Float.MAX_VALUE` — a Float result past it is infinite in 32 bits, and `mathOperationWithPromote`
 *  retries it as a Double (`NumberHelper.java:414-425`). */
const FLOAT_MAX = 3.4028234663852886e38;
const FLOAT_CODE = 5;

/**
 * WHAT A FOLD OWES, per row — the offences `raisingRows` raises, in the order the reference meets them.
 * `null` declines (an operand proven, at compile time, to be of a type the operator refuses).
 *
 * - **arithmetic** (`sum`/`minus`/`mult`/`div`): `Operator`'s `(Number)` cast
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java:40-80`)
 *   refuses a non-Number (`numericOperandOffences`); an integral `/ 0` is `ArithmeticException("/ by zero")`
 *   (BigInteger's own message for a BigInteger); a Long result past 64 bits is `Math.addExact`'s
 *   `long overflow`, which `mathOperationWithPromote` rethrows at 64 bits (`NumberHelper.java:420-421`) —
 *   SQLite instead turns the overflowing integer into a REAL, which is the per-row test. A floating `/ 0`
 *   is an Infinity or a NaN, which SQLite answers NULL; a Float past `Float.MAX_VALUE` is retried as a
 *   Double, whose value SQLite holds but whose class the tag would have to re-derive per row; BigDecimal
 *   arithmetic has no SQL spelling. All three are deferrals.
 * - **`min`/`max`**: `NumberHelper.min(Comparable, Comparable)` compares two Numbers through their common
 *   class and anything else with `a.compareTo(b)` (`NumberHelper.java:582-598`), which is a
 *   ClassCastException unless both are of one Comparable class — of the classes SQLite orders as Java
 *   does, a String or a Boolean.
 * - **every numeric operator**: a Number stored as TEXT (a BigInteger past 64 bits) would be compared or
 *   added as a string — a deferral, as is a BigDecimal operand.
 *
 * A NULL on either side owes nothing: `mathOperationWithPromote` returns the sack, and `min`/`max` the
 * other side (`NumberHelper.java:402,558-559`). Every test below is NULL-false over a NULL operand.
 */
function foldOffences(operator: string, facts: FoldFacts, evidence: ValueEvidence): (readonly [Expr, string])[] | null {
  if (operator === 'assign') return [];
  const { sack, operand, sackTag, operandTag, common } = facts;
  const what = `sack(${operator})`;
  const numericTail: (readonly [Expr, string])[] = [
    [bin('=', common, compilerInt(BIGDECIMAL_CODE)), deferral(`${what}: a BigDecimal operand`)],
    [bin('and', bin('>=', common, compilerInt(0)),
      call('max', bin('=', call('typeof', sack), compilerText('text')), bin('=', call('typeof', operand), compilerText('text')))),
    deferral(`${what}: a Number past 64 bits`)],
  ];
  if (operator === 'min' || operator === 'max') {
    // A static by() of a class no SQL comparison orders as Java does declines; per row it raises.
    if (evidence.kind === 'static' && !COMPARABLE_TAGS.has(evidence.tag) && !NUMBER_TAGS.has(evidence.tag)) return null;
    // Neither side NULL, not two Numbers, and not one Comparable class on both sides.
    const comparable = bin('or', bin('is not', common, compilerNull()),
      bin('and', bin('=', sackTag, operandTag), { kind: 'in-list', expr: sackTag, values: [...COMPARABLE_TAGS].map(compilerText) }));
    const offends = bin('and', bin('and', bin('is not', sack, compilerNull()), bin('is not', operand, compilerNull())), not(comparable));
    return [[offends, deferral(`${what}: operands that are not mutually Comparable`)], ...numericTail];
  }
  if (!ARITHMETIC.has(operator)) return null;
  const typed = numericOperandOffences([
    [sack, evidenceOf(UNKNOWN, sackTag)],
    [operand, evidence.kind === 'static' ? evidence : { kind: 'tag', tag: operandTag }],
  ], what);
  if (typed === false) return null;
  const result = arithmetic(operator, facts);
  // ONE per-row key for the class-dependent errors, so the common class is spelled once more rather than
  // once per test: the common class where the result left its range, else -1.
  const overflowed = caseOf([[bin('=', call('typeof', result), compilerText('real')), common]], compilerInt(-1));
  const zero = bin('=', operand, compilerInt(0));
  const divByZero: (readonly [Expr, string])[] = operator === 'div' ? [
    [bin('and', zero, bin('=', common, compilerInt(BIGINT_CODE))), 'BigInteger divide by zero'],
    [bin('and', zero, bin('<', common, compilerInt(BIGINT_CODE))), '/ by zero'],
    [bin('and', zero, bin('>', common, compilerInt(BIGINT_CODE))), deferral(`${what}: a floating-point division by zero`)],
  ] : [];
  return [
    ...typed,
    ...numericTail,
    ...divByZero,
    [bin('=', overflowed, compilerInt(BIGINT_CODE)), INTEGER_OVERFLOW],
    [bin('and', bin('>=', overflowed, compilerInt(0)), bin('<=', overflowed, compilerInt(LONG_CODE))), 'long overflow'],
    [bin('and', bin('=', common, compilerInt(FLOAT_CODE)), bin('>', call('abs', result), compilerReal(FLOAT_MAX))),
      deferral(`${what}: a Float result past Float.MAX_VALUE`)],
  ];
}

/** The non-Number classes `min`/`max` may compare: one class on both sides, ordered by SQLite as by
 *  `compareTo` (a String's code units, a Boolean's false < true). */
const COMPARABLE_TAGS: ReadonlySet<ValueType> = new Set<ValueType>(['string', 'boolean']);

/**
 * The folded value's TAG, total (see `SACK_TYPE_COL`) — the class `NumberHelper` gives the result
 * (`NumberHelper.java:401-428`): the operands' highest common class (`commonClass`), widened where an
 * integral result overflows it (`neededClass`). `assign` takes the by()'s tag; `min`/`max` the common class
 * of two Numbers and the shared tag of two Comparables. A NULL sack folds to NULL, and its tag is NULL with
 * it; a NULL operand leaves the sack, and its tag, as they were.
 */
function foldedTag(operator: string, facts: FoldFacts, result: Expr): Expr {
  const { sack, sackTag, operand, operandTag, nullable } = facts;
  if (operator === 'assign') return operandTag;
  const keepSack = (tag: Expr): Expr => nullable ? caseOf([[isNull(operand), sackTag]], tag) : tag;
  if (operator === 'min' || operator === 'max')
    return keepSack(call('COALESCE', classTag(facts.common), caseOf([[isNull(sack), operandTag]], sackTag)));
  return keepSack(classTag(call('max', facts.common, neededClass(result))));
}

/**
 * The fold, in the algebra — §6·4's split exactly: the operator SET is data (`SACK_OPS`,
 * `ir/step.ts`) and the SQL is emission, belonging to the layer that emits it.
 *
 * A NULL operand leaves the sack as it is (`mathOperationWithPromote` returns `a`), and `min`/`max` take
 * the non-null side (`NumberHelper.java:402,558-559`), where SQLite's arithmetic and two-argument
 * `MIN`/`MAX` would answer NULL.
 */
function combine(operator: string, facts: FoldFacts): Expr | null {
  const { sack, operand, nullable } = facts;
  switch (operator) {
    case 'assign': return operand;
    case 'min':
    // The sack is spelled ONCE where the operand cannot be NULL (see `CLASSES` for why a spelling counts).
    case 'max': return call(operator.toUpperCase(), call('COALESCE', sack, operand), nullable ? call('COALESCE', operand, sack) : operand);
    default:
      if (!ARITHMETIC.has(operator)) return null;
      return nullable ? caseOf([[isNull(operand), sack]], arithmetic(operator, facts)) : arithmetic(operator, facts);
  }
}

/**
 * The arithmetic over two non-null Numbers. `div` is REAL division exactly where the common class is
 * floating, and SQLite's integer division otherwise — `NumberHelper`'s integral helpers truncate
 * (`a.intValue() / b.intValue()`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:137-142`),
 * so `withSack(1).sack(div).by(constant(2))` is 0. The TAG, not the storage class, decides, because a
 * whole Double can be STORED as an integer.
 */
function arithmetic(operator: string, facts: FoldFacts): Expr {
  const { sack, operand } = facts;
  switch (operator) {
    case 'sum': return bin('+', sack, operand);
    case 'minus': return bin('-', sack, operand);
    case 'mult': return bin('*', sack, operand);
    // `× 1.0` makes the division REAL without spelling the sack twice.
    default: return bin('/', bin('*', sack, caseOf([[bin('>', facts.common, compilerInt(BIGINT_CODE)), compilerReal(1)]], compilerInt(1))), operand);
  }
}

/**
 * A bare `sack()` — the sack VALUE becomes the traverser, which is a retype like `values()` and
 * `count()` and lands in the scalar tail through the ordinary dispatcher.
 *
 * The channel rides THROUGH rather than being consumed: `sack()` reads the accumulator, it does not
 * spend it, so `sack().is(P.lt(59))` inside a `repeat()` body still has one afterwards.
 *
 * The TYPE is the sack's own tag channel, per row (`SACK_TYPE_COL`): a sack's type is the seed's until
 * an operator changes it, so a static claim could not survive the first mutation, but the per-row tag
 * is exactly as known as the fold left it, and total (a NULL only for a NULL sack).
 */
export function sackRead(rel: Rel, fresh: Minter): FramedRel | null {
  if (!sackCarried(rel)) return null;
  const tag = sackTagOf(rel);
  return {
    rel: make.project({
      id: fresh('skr'), input: rel, channels: rel.channels,
      type: typeOf(meta('v', 'any', true), ...(tag ? [meta(MERGED_VTYPE, 'text', true)] : []), ...carriedCols(rel.channels)),
      exprs: [['v', col(rel.id, SACK_COL)], ...(tag ? [[MERGED_VTYPE, tag] as const] : []),
        ...rel.channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
    }),
    // A NULL sack is a VALUE (`SackStep` maps to `traverser.sack()`, null included — a `withSack(null)`
    // seed or an `assign` of a productive null), never the framer's "no result".
    framing: { kind: 'scalar', type: tag ? PER_ROW(MERGED_VTYPE) : UNKNOWN, productiveNull: true },
  };
}

/** The `Operator` a `sack()` names, or `undefined` for the bare READ form. */
export const sackOperator = (step: IRStep): string | undefined =>
  (step.args ?? []).map((a) => a.value)
    .find((value): value is { readonly operator: string } =>
      typeof value === 'object' && value !== null && typeof (value as { operator?: unknown }).operator === 'string')
    ?.operator;

