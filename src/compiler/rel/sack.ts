import type { Channel } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerReal, compilerText, type BinaryOp, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { containsSelfRef, freeRelIds } from '../../rel/walk.ts';
import { MERGED_VTYPE, PER_ROW, UNKNOWN } from '../../sql/kernel/render.ts';
import type { MergePolicy } from '../../gremlin/frontend.ts';
import { SACK_OPS } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import { carriedCols, meta, payloadCols, typeOf, type Minter } from './build.ts';
import { inferredVtype } from './reducer.ts';
import { hostTag, type ChildHost, type ChildSeam } from './child.ts';
import { constLit, declaredScalarType } from './const.ts';
import type { FramedRel } from './framing.ts';
import { byProjection, byTyped, modulations, productivityFilter } from './modulator.ts';
import { deferral, evidenceOf, numericOperandOffences, raisingRows, type ValueEvidence } from './receiver.ts';
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
 * tag the wire's inference would have framed it as (`inferredVtype`). It is TOTAL (NULL only for a NULL
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

/** A partial tag completed from the value's storage class (`inferredVtype`, what the wire infers for an
 *  untagged value). A literal tag is already total; a per-row one — a reducer's `vt` included
 *  (`REDUCED_TYPE`) — is a Gremlin type name or NULL. */
const totalTag = (tag: Expr, value: Expr): Expr =>
  tag.kind === 'lit' && tag.value !== null ? tag
    : tag.kind === 'lit' ? inferredVtype(value)
      : { kind: 'call', fn: 'COALESCE', args: [tag, inferredVtype(value)] };

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
  // With one, an UNPRODUCTIVE `by()` FILTERS the traverser (`:78-80`), and a NULL value is no value —
  // the drop is the named value's non-nullness; a producer that cannot say declines.
  const drop = bys[0] ? productivityFilter(step, projected.present, value) : {};
  if (!drop) return null;

  // THREE NODES, and the middle one is why: the by() value has to be FILTERED on before it is folded
  // in, and a `Filter` between the fold and the relation the fold reads would put that relation one
  // level too far away (§3.3 — a `Col` names a relation in SCOPE, and scope is a node's direct
  // children). So the value is NAMED first, the drop reads the name, and the fold reads it again.
  // Spelling the by() expression once is the other half of the reason: it is routinely a correlated
  // subquery, and a filter that re-inlined it would spell the whole thing twice. The by()'s TYPE TAG is
  // named beside it for the same scope reason: a per-row tag reads the input relation, and the fold sits
  // two nodes above it — TOTAL, completed from the storage class where the by()'s evidence is partial —
  // and so is the two sides' class MEET (`classCode`), which every class-dependent test reads.
  const held = 'skv';
  const heldTag = 'skt';
  const heldMeet = 'skc';
  const operandTotal = evidence.kind === 'static' ? compilerText(evidence.tag)
    : evidence.kind === 'tag' && evidence.nullOnlyForNull ? evidence.tag : totalTag(tagOf(evidence), value);
  const meet = carried ? bin('+', classCode(col(rel.id, SACK_TYPE_COL)), classCode(operandTotal)) : compilerNull();
  const payload = payloadCols(rel);
  // A MINTING `assign` adds the channel here, in the same projection that names the value — so the
  // fold below reads a column that exists whether or not a `withSack()` seeded one.
  const channels = carried ? rel.channels : withSack(rel.channels);
  const named = make.project({
    id: fresh('skb'), input: rel, channels,
    type: typeOf(...payload, meta(held, 'any', true), meta(heldTag, 'text', true), meta(heldMeet, 'int', true), ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      [held, value],
      [heldTag, operandTotal],
      [heldMeet, meet],
      ...channels.map((channel) => [channel.col,
        sackColumn(channel.col) && !carried ? compilerNull() : col(rel.id, channel.col)] as const),
    ],
  });
  // A FENCE where the relation is self-contained: the assembler otherwise re-inlines every column read as
  // the expression that computes it, and a fold reads the meet (and so the previous fold's tag) several
  // times — the tag, each raise test, a `div`'s value — so a CHAIN of folds grows geometrically in statement
  // text (measured, four `div` folds inside `local()`: 12 KB fenced, 127 KB not). Behind the fence each is
  // a plain column. Not over a correlated or recursive input — a fence hoists to a CTE, where an outer
  // reference resolves to nothing (`freeRelIds`, as `record.ts` gates it) and a walk's own reference is
  // refused (`containsSelfRef`).
  const base = freeRelIds(named).size === 0 && !containsSelfRef(named)
    ? make.materialize({ id: fresh('skz'), input: named, channels: named.channels, type: named.type })
    : named;
  const kept = drop.keep
    ? make.filter({ id: fresh('skf'), input: base, channels: base.channels, type: base.type, pred: productivityFilter(step, 'value-nullness', col(base.id, held))!.keep! })
    : base;
  // The operand can still be NULL wherever no drop tested its nullness: a by()-less fold of a null
  // traverser, or a by() that always produces.
  const nullable = !drop.keep;
  const facts = (at: Rel): FoldFacts => ({
    sack: col(at.id, SACK_COL), operand: col(at.id, held),
    operandTag: evidence.kind === 'static' ? compilerText(evidence.tag) : col(at.id, heldTag),
    meet: col(at.id, heldMeet), nullable,
  });
  // THE RAISE IS A ROW PREDICATE (`raisingRows`), never a CASE inside the folded value: a sack nobody
  // reads afterwards (`count()`, `fold()`, `path()`, a bare element stream) is a select-list column
  // SQLite prunes, and the raise inside it went with it — `withSack(1).V().sack(sum).by('name')` answered
  // six vertices where `Operator.sum`'s `(Number)` cast raises on every one.
  const offences = foldOffences(operator, facts(kept), col(kept.id, SACK_TYPE_COL), evidence);
  if (!offences) return null;
  const guarded = raisingRows(kept, offences, fresh);
  const at = facts(guarded);
  const combined = combine(operator, at);
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

/** The columns one fold reads: the sack, the operand with its TOTAL tag, and the two sides' class MEET
 *  (`classCode`). `nullable` says whether the operand can be NULL at all — only where no productivity
 *  filter dropped the row (a by()-less fold of a null traverser). */
interface FoldFacts {
  readonly sack: Expr;
  readonly operand: Expr;
  readonly operandTag: Expr;
  readonly meet: Expr;
  readonly nullable: boolean;
}

const ARITHMETIC: ReadonlySet<string> = new Set(['sum', 'minus', 'mult', 'div']);
const sackColumn = (name: string): boolean => name === SACK_COL || name === SACK_TYPE_COL;

const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
const isNull = (e: Expr): Expr => bin('is', e, compilerNull());
const caseOf = (whens: readonly (readonly [Expr, Expr])[], otherwise: Expr): Expr => ({ kind: 'case', whens, else: otherwise });

/**
 * THE NUMBER CLASS OF A FOLD — a simple MEET, not `NumberHelper`'s width lattice: the result is floating
 * if either side is (a Double, or a Float meeting a Long, is a Double; a Float otherwise), else a Long if
 * either side is a Long or the value left 32 bits, else an Integer — so a Byte/Short result is an Integer,
 * an accepted divergence (`docs/feature-support-matrix.md`). A BigInteger/BigDecimal side defers; a
 * non-Number side has no code and makes the meet NULL; a NULL side (a NULL value) adds nothing.
 *
 * Each side is a CODE and the meet is their SUM, looked up — chosen so every pair's sum is distinct where
 * the classes differ — because each tag must be SPELLED ONCE: the assembler re-inlines the previous fold's
 * tag at every read, so a tag read k times makes a chain of n folds k^n long.
 */
const NUMBER_CODES = { int: 0, long: 1, float: 3, double: 9 } as const;
type NumberClass = keyof typeof NUMBER_CODES;
const CODES = { null: 0, byte: 0, short: 0, ...NUMBER_CODES, bigint: 32, bigdecimal: 32 };
const LONG = NUMBER_CODES.long;
const FLOATING = NUMBER_CODES.float;
const BIG = 32;
const meetOf = (a: NumberClass, b: NumberClass): NumberClass =>
  a === 'double' || b === 'double' || (a === 'float' || b === 'float') && (a === 'long' || b === 'long') ? 'double'
    : a === 'float' || b === 'float' ? 'float' : a === 'long' || b === 'long' ? 'long' : 'int';
const MEET_CLASS: (NumberClass | null)[] = Array(2 * NUMBER_CODES.double + 1).fill(null);
for (const a of Object.keys(NUMBER_CODES) as NumberClass[])
  for (const b of Object.keys(NUMBER_CODES) as NumberClass[]) MEET_CLASS[NUMBER_CODES[a] + NUMBER_CODES[b]] = meetOf(a, b);
/** A tag's class code — 0 for a NULL tag (a NULL value), NULL for a tag that is not a Number. */
const classCode = (tag: Expr): Expr =>
  call('json_extract', compilerText(JSON.stringify(CODES)), bin('||', compilerText('$.'), call('COALESCE', tag, compilerText('null'))));

/** The class a fold's `result` takes from the meet: an integral meet whose result left 32 bits is a Long
 *  (`max` with the Long code — the overflow test is NULL for a NULL result, and so is the class). */
const meetClass = (meet: Expr, result: Expr): Expr => {
  const past32 = bin('*', bin('>', call('abs', bin('+', bin('*', compilerInt(2), result), compilerInt(1))), compilerInt(4294967295)), compilerInt(LONG));
  return call('json_extract', compilerText(JSON.stringify(MEET_CLASS)), bin('||', bin('||', compilerText('$['), call('max', meet, past32)), compilerText(']')));
};

/**
 * WHAT A FOLD OWES, per row — the offences `raisingRows` raises. `null` declines (an operand proven, at
 * compile time, not to be a Number for an arithmetic operator).
 *
 * - **arithmetic** (`sum`/`minus`/`mult`/`div`): `Operator`'s `(Number)` cast
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Operator.java:40-80`)
 *   refuses a non-Number (`numericOperandOffences`); an integral `/ 0` is `/ by zero`; an integral result
 *   SQLite turned into a REAL overflowed 64 bits, which is `long overflow`. A floating `/ 0` (an Infinity)
 *   and a NaN result have no SQLite carrier (it answers NULL) and defer.
 * - **every operator**: a BigInteger/BigDecimal side defers — SQLite's arithmetic and comparison are not
 *   theirs.
 *
 * A NULL on either side owes nothing: `mathOperationWithPromote` returns the sack, and `min`/`max` the
 * other side (`NumberHelper.java:402,558-559`). Every test below is NULL-false over a NULL operand.
 */
function foldOffences(operator: string, facts: FoldFacts, sackTag: Expr, evidence: ValueEvidence): (readonly [Expr, string])[] | null {
  if (operator === 'assign') return [];
  const { sack, operand, meet } = facts;
  const what = `sack(${operator})`;
  const big: readonly [Expr, string] = [bin('>=', meet, compilerInt(BIG)), deferral(`${what}: a BigInteger or BigDecimal operand`)];
  if (operator === 'min' || operator === 'max') return [big];
  if (!ARITHMETIC.has(operator)) return null;
  const typed = numericOperandOffences([
    [sack, evidenceOf(UNKNOWN, sackTag)],
    [operand, evidence.kind === 'static' ? evidence : { kind: 'tag', tag: facts.operandTag }],
  ], what);
  if (typed === false) return null;
  const result = arithmetic(operator, facts);
  const integral = bin('<', meet, compilerInt(FLOATING));
  const zero = bin('=', operand, compilerInt(0));
  const divByZero: (readonly [Expr, string])[] = operator === 'div' ? [
    [bin('and', zero, integral), '/ by zero'],
    [bin('and', zero, bin('>=', meet, compilerInt(FLOATING))), deferral(`${what}: a floating-point division by zero`)],
  ] : [];
  return [
    ...typed,
    big,
    ...divByZero,
    [bin('and', integral, bin('=', call('typeof', result), compilerText('real'))), 'long overflow'],
    // A NULL result from two non-NULL operands is a NaN (`Infinity + -Infinity`, `Infinity * 0`), which the
    // reference carries as the Double NaN and SQLite cannot: it answered a `null` sack.
    [bin('and', bin('and', bin('is not', sack, compilerNull()), bin('is not', operand, compilerNull())), isNull(result)),
      deferral(`${what}: a NaN result`)],
  ];
}

/**
 * The folded value's TAG, total (see `SACK_TYPE_COL`): the meet's class (`meetClass`) — for a NULL operand
 * that is the sack's own class, since a NULL side adds nothing. `assign` takes the by()'s tag. A `min`/`max`
 * of two values that are not both Numbers (two Strings, two Booleans) answers the operand's tag, the winner's
 * class wherever the reference answers at all; where the winner's storage is not the operand's (a mixed
 * pair the reference refuses) its storage class.
 */
function foldedTag(operator: string, facts: FoldFacts, result: Expr): Expr {
  const { operand, operandTag, meet } = facts;
  if (operator === 'assign') return operandTag;
  const tag = meetClass(meet, result);
  if (operator !== 'min' && operator !== 'max') return tag;
  const sameStorage = bin('=', call('typeof', result), call('typeof', operand));
  return call('COALESCE', tag, caseOf([[sameStorage, operandTag]], inferredVtype(result)));
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
    // The sack is spelled ONCE (see `NUMBER_CODES` for why a spelling counts).
    case 'min':
    case 'max': return call(operator.toUpperCase(), call('COALESCE', sack, operand), nullable ? call('COALESCE', operand, sack) : operand);
    default: {
      if (!ARITHMETIC.has(operator)) return null;
      const folded = arithmetic(operator, facts);
      return nullable ? caseOf([[isNull(operand), sack]], folded) : folded;
    }
  }
}

/**
 * The arithmetic over two non-null Numbers — SQLite's own. `div` is REAL division where the meet is
 * floating and SQLite's integer division otherwise (`NumberHelper`'s integral helpers truncate too), so
 * `withSack(1).sack(div).by(constant(2))` is 0. The meet, not the storage class, decides, because a whole
 * Double can be STORED as an integer.
 */
function arithmetic(operator: string, facts: FoldFacts): Expr {
  const { sack, operand } = facts;
  switch (operator) {
    case 'sum': return bin('+', sack, operand);
    case 'minus': return bin('-', sack, operand);
    case 'mult': return bin('*', sack, operand);
    // `× 1.0` makes the division REAL without spelling the sack twice.
    default: return bin('/', bin('*', sack, caseOf([[bin('>=', facts.meet, compilerInt(FLOATING)), compilerReal(1)]], compilerInt(1))), operand);
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

