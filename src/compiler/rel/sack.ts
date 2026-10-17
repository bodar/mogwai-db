import type { Channel } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { MERGED_VTYPE, PER_ROW, UNKNOWN } from '../../sql/kernel/render.ts';
import type { MergePolicy } from '../../gremlin/frontend.ts';
import { SACK_OPS } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import { carriedCols, meta, payloadCols, reducedVtype, typeOf, type Minter } from './build.ts';
import { hostTag, type ChildHost, type ChildSeam } from './child.ts';
import { constLit, declaredScalarType } from './const.ts';
import type { FramedRel } from './framing.ts';
import { byExpr, byTyped, modulations, productivityFilter } from './modulator.ts';
import { evidenceOf, numericOperandOffences, raisingWhen, type ValueEvidence } from './receiver.ts';
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
  const by = bys[0] ?? { key: { kind: 'identity' } };
  // The by() value WITH what is known of its type where the vocabulary can say (`byTyped`), else the
  // bare value known only by its storage class — what every fold did before the sack carried a tag.
  const typed = byTyped(by, host, source, fresh, child);
  const value = typed?.value ?? byExpr(by, host, source, fresh, false, child);
  if (!value) return null;
  const evidence: ValueEvidence = typed?.evidence ?? { kind: 'storage' };

  // THREE NODES, and the middle one is why: the by() value has to be FILTERED on before it is folded
  // in, and a `Filter` between the fold and the relation the fold reads would put that relation one
  // level too far away (§3.3 — a `Col` names a relation in SCOPE, and scope is a node's direct
  // children). So the value is NAMED first, the drop reads the name, and the fold reads it again.
  // Spelling the by() expression once is the other half of the reason: it is routinely a correlated
  // subquery, and a filter that re-inlined it would spell the whole thing twice. The by()'s TYPE TAG is
  // named beside it for the same scope reason: a per-row tag reads the input relation, and the fold sits
  // two nodes above it.
  const held = 'skv';
  const heldTag = 'skt';
  const payload = payloadCols(rel);
  // A MINTING `assign` adds the channel here, in the same projection that names the value — so the
  // fold below reads a column that exists whether or not a `withSack()` seeded one.
  const channels = carried ? rel.channels : withSack(rel.channels);
  const named = make.project({
    id: fresh('skb'), input: rel, channels,
    type: typeOf(...payload, meta(held, 'any', true), meta(heldTag, 'text', true), ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      [held, value],
      [heldTag, tagOf(evidence)],
      ...channels.map((channel) => [channel.col,
        sackColumn(channel.col) && !carried ? compilerNull() : col(rel.id, channel.col)] as const),
    ],
  });
  const drop = productivityFilter(step, col(named.id, held));
  const kept = drop
    ? make.filter({ id: fresh('skf'), input: named, channels: named.channels, type: named.type, pred: drop })
    : named;
  const sack = col(kept.id, SACK_COL);
  const sackTag = col(kept.id, SACK_TYPE_COL);
  const operand = col(kept.id, held);
  const operandTag = col(kept.id, heldTag);
  // The operand's TOTAL tag. A static tag is the literal itself, and a stored property's tag is already
  // total (NULL only for an absent value), so neither needs completing.
  const operandTotal = evidence.kind === 'static' ? compilerText(evidence.tag)
    : evidence.kind === 'tag' && evidence.nullOnlyForNull ? operandTag : totalTag(operandTag, operand);
  const floating: Expr = { kind: 'binary', op: 'or', left: inFloating(sackTag), right: inFloating(operandTotal) };
  const combined = combine(operator, operand, sack, floating);
  if (!combined) return null;
  // An ARITHMETIC operator casts both operands to `Number` (`Operator.sum/minus/mult/div`,
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java`),
  // so a non-Number on either side raises there, where SQLite would add a Boolean's 1 or a String's 0.
  // A by() value proven non-Number at compile time declines (`numericOperandOffences` answers false).
  const offences = ARITHMETIC.has(operator)
    ? numericOperandOffences([
      [sack, evidenceOf(UNKNOWN, sackTag)],
      [operand, evidence.kind === 'tag' ? { ...evidence, tag: operandTag } : evidence],
    ], `sack(${operator})`)
    : [];
  if (offences === false) return null;
  const folded = raisingWhen(offences, combined);
  // The folded value's tag, TOTAL (see `SACK_TYPE_COL`): `assign` takes the by()'s; `min`/`max` keep a
  // tag both operands agree on (the winner is one of them); otherwise — an arithmetic result, whose class
  // `NumberHelper` promotes on overflow, or a mixed min/max — the result's storage class, except that a
  // floating result over a Float and no wider class stays a Float (`NumberHelper.getHighestCommonNumberInfo`
  // keeps 32 bits: `Sack.feature` `withSack(127b).inject(0.5f).sack(div)` is `d[254].f`).
  const wide = (tag: Expr): Expr => ({ kind: 'in-list', expr: tag, values: ['long', 'bigint', 'double', 'bigdecimal'].map(compilerText) });
  const isFloat = (tag: Expr): Expr => ({ kind: 'binary', op: '=', left: tag, right: compilerText('float') });
  const floatResult: Expr = { kind: 'binary', op: 'and',
    left: { kind: 'binary', op: 'or', left: isFloat(sackTag), right: isFloat(operandTotal) },
    right: { kind: 'unary', op: 'not', arg: { kind: 'binary', op: 'or', left: wide(sackTag), right: wide(operandTotal) } } };
  const foldedTag: Expr = operator === 'assign' ? operandTotal
    : operator === 'min' || operator === 'max'
      ? { kind: 'case', whens: [[{ kind: 'binary', op: 'is', left: sackTag, right: operandTotal }, sackTag]], else: storageTag(combined) }
      : { kind: 'case', whens: [[floatResult, compilerText('float')]], else: storageTag(combined) };
  return make.project({
    id: fresh('skm'), input: kept, channels: kept.channels, type: typeOf(...payload, ...carriedCols(kept.channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(kept.id, column.name)] as const),
      ...kept.channels.map((channel) => [channel.col,
        channel.col === SACK_COL ? folded : channel.col === SACK_TYPE_COL ? foldedTag : col(kept.id, channel.col)] as const),
    ],
  });
}

const ARITHMETIC: ReadonlySet<string> = new Set(['sum', 'minus', 'mult', 'div']);
const sackColumn = (name: string): boolean => name === SACK_COL || name === SACK_TYPE_COL;

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
    framing: { kind: 'scalar', type: tag ? PER_ROW(MERGED_VTYPE) : UNKNOWN },
  };
}

/** The `Operator` a `sack()` names, or `undefined` for the bare READ form. */
export const sackOperator = (step: IRStep): string | undefined =>
  (step.args ?? []).map((a) => a.value)
    .find((value): value is { readonly operator: string } =>
      typeof value === 'object' && value !== null && typeof (value as { operator?: unknown }).operator === 'string')
    ?.operator;

/**
 * The fold, in the algebra — §6·4's split exactly: the operator SET is data (`SACK_OPS`,
 * `ir/step.ts`) and the SQL is emission, belonging to the layer that emits it.
 *
 * `div` is REAL division exactly where an operand is a floating class by its TAG (`floating`), and
 * SQLite's integer division otherwise — `NumberHelper`'s integral helpers truncate (`a.intValue() /
 * b.intValue()`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:137-142`),
 * so the REAL cast this used for every operand answered `withSack(1).sack(div).by(constant(2))` 0.5
 * where the reference answers 0. The tag, not the storage class, decides, because a whole Double can be
 * STORED as an integer.
 */
const inFloating = (tag: Expr): Expr => ({ kind: 'in-list', expr: tag, values: ['float', 'double', 'bigdecimal'].map(compilerText) });

function combine(operator: string, value: Expr, sack: Expr, floating: Expr): Expr | null {
  const binary = (op: '+' | '-' | '*'): Expr => ({ kind: 'binary', op, left: sack, right: value });
  switch (operator) {
    case 'assign': return value;
    case 'sum': return binary('+');
    case 'minus': return binary('-');
    case 'mult': return binary('*');
    case 'div': return { kind: 'case', whens: [[floating,
      { kind: 'binary', op: '/', left: { kind: 'cast', arg: sack, to: 'real' }, right: value }]],
    else: { kind: 'binary', op: '/', left: sack, right: value } };
    case 'min': return { kind: 'call', fn: 'MIN', args: [sack, value] };
    case 'max': return { kind: 'call', fn: 'MAX', args: [sack, value] };
    default: return null;
  }
}
