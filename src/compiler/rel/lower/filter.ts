import * as make from '../../../rel/factory.ts';
import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import { and, labelSetArgs, meta, notProduced, or, typeOf, type Minter } from '../build.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { RelFraming } from '../framing.ts';
import type { GraphSource } from '../source.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { collectionAssert } from '../../ir/step.ts';
import { ALWAYS_PRODUCTIVE, type ChildHost, type Subject } from '../child.ts';
import { CONSTANT, predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from '../predicate.ts';
import { MAPPING_TERMINAL } from '../../ir/productivity.ts';
import { aliasProjection, selectSpec } from '../alias.ts';
import type { AliasMap } from '../../alias.ts';
import { argValues, isNested, isPred, isTokenArg, type Arg } from '../../../gremlin/frontend.ts';
import type { TypeNode } from '../../../gremlin/types.ts';
import { propertyRowId } from '../property.ts';
import { movement } from './movement.ts';
import { BULK, NO_ALIASES, bodyOf, elementSubject, inBody, type ChainCtx, type ElementSubject } from './chain.ts';
import { continueAs } from '../lower.ts';
import { foldedListSet, nestedFirstValue, scalarChild } from './reduction.ts';

// FILTER / PREDICATE FAMILY — a step or a sub-traversal body lowered to a boolean `Expr`:
// correlatedExists (a body as EXISTS), bodyPredicate/childPredicate/valuePredicate (the three shapes a
// where()/and()/or() body takes), sourceFilter + hasLabel/has/hasToken clauses, and the child-subject
// helpers (childHostOf/branchSubject). Extracted from lower.ts; calls back into the fold core there.

/**
 * A SUB-TRAVERSAL AS A BOOLEAN — `EXISTS (<the body, rooted at the current row>)`.
 *
 * The body's FIRST step must be a movement: it is what makes the child a RELATION to test for rows at
 * all. A filter-only body is a predicate on the SAME traverser, not a sub-traversal, so it has nothing
 * to gain from an EXISTS wrapper and `bodyPredicate` below takes it instead.
 *
 * Extracted because `choose(<body>, …)` asks the identical question `where(<body>)` does — "does this
 * body produce anything for this traverser" — and a second copy of the walk would be a second chance
 * to get the child's own filter recursion wrong.
 */
export function correlatedExists(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
): Expr | null {
  // A MOVEMENT NEEDS AN ELEMENT TO MOVE FROM. A scalar traverser has no adjacency, so this arm is not
  // "not yet taught" for one — it is the arm that does not apply, and `bodyPredicate` falls through to
  // the two that do.
  if (subject.kind !== 'element') return null;
  const elem = subject.elem;
  const child = movement(body[0]!, { correlated: subject.id }, elem, ctx.source, fresh);
  if (!child) return null;
  // THE REST OF THE BODY IS THE ORDINARY FOLD, started at the correlated child — the same insight the
  // arm merge rests on, one position further in. This used to be a hand-rolled movement|filter walk,
  // which is the third copy of the fold this module has grown and then deleted: it could express a
  // multi-hop path and a filter and nothing else, so `where(__.out().count().is(P.gt(0)))` declined on
  // a body whose every step was already covered somewhere else in this file.
  //
  // A correlated hop threads NO carried state — an EXISTS asks whether a row is there, never in what
  // order or how many times — so the child starts from the bulk channel `movement` gave it and any
  // order the body mints is the body's own.
  const tail = continueAs(child.rel, { kind: 'elements', elem: child.elem }, body, 1, false, inBody(ctx), fresh, NO_ALIASES);
  if (!tail) return null;
  // A NUMERIC REDUCER OVER AN EMPTY CHILD IS THE ONE PLACE SQL AND GREMLIN DISAGREE ABOUT EXISTENCE,
  // so it fails closed. `sum`/`min`/`max`/`mean` over zero rows return ONE row holding NULL in SQL,
  // while TinkerPop emits NO traverser — so a bare EXISTS answers "true" for a parent the reference
  // REJECTS. Right arity, plausible rows, and a wrong answer that would pass unnoticed — precisely the
  // shape the decline contract exists to keep out. `count()` and `fold()` are NOT this: both emit a
  // traverser for an empty child (0 and
  // the empty list), so their EXISTS is honest. Expressing the reducer case needs the aggregate's
  // own NULL-ness as the test rather than row existence; that is a further arm.
  if (tail.framing.kind === 'scalar' && tail.framing.result === 'number') return null;
  // THE PROBE PROJECTS THE TAIL'S OWN FIRST COLUMN, not a literal — an EXISTS does not care what the
  // value is, but the BLOCK does. A body ending in a reducer is an `Aggregate`, and the assembler
  // fuses the whole run into one SELECT; projecting `1` there left a block with a `HAVING` and no
  // aggregate in its select list, which SQLite refuses outright (`HAVING clause on a non-aggregate
  // query`) — a THROW from a position that must answer. Projecting the column keeps whatever
  // the block computes visible, so the aggregate query stays an aggregate query.
  //
  // A `Materialize` fence is the WRONG remedy here even though it is the right one elsewhere (§11):
  // this subplan is CORRELATED to the outer row, and a fence forces a named CTE, which cannot
  // reference it. That is the same fact behind `name` not walking expression subplans.
  const probeCol = tail.rel.type.cols[0];
  if (!probeCol) return null;
  const probe = make.project({ id: fresh('p'), input: tail.rel, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(tail.rel.id, probeCol.name)]] });
  // `NOT EXISTS`, not `NOT COALESCE(EXISTS(…), 0)`: EXISTS is never NULL, so the COALESCE
  // guards nothing here.
  return { kind: 'exists', plan: probe, negated };
}

/**
 * A `match(…)`-HEADED body as a correlated `[NOT] EXISTS` over the subject — the fourth predicate arm,
 * the one that makes `not(__.match(…).where(…).select(…))` / `where(__.match(…))` a filter at any
 * position (top level, inside `where`, under another `not`). TinkerPop's `NotStep`/`WhereTraversalStep`
 * asks "does this sub-traversal produce output for this traverser"; when the sub-traversal is a match,
 * that is the match run ROOTED AT THE SUBJECT, existence-tested.
 *
 * `correlatedExists` cannot express it — its `movement(body[0], …)` needs an adjacency head, and a match
 * is not a movement. So instead of correlating through a first hop, this seeds the body at the SUBJECT
 * ITSELF: `source.elementRow(id)` is the one correlated row that id names (a `nodes`/`edges` scan
 * filtered to `id = subject.id`), promoted to a fold-ready element source (an `id` column + the `bulk`
 * channel every element source seeds). The WHOLE body — match, then whatever follows (`where`, `select`)
 * — then runs through the ordinary fold, and the result is EXISTS-probed: a produced row means the body
 * matched for this subject. Calcite's anti/semi-join over a correlated subquery
 * (`SubQueryRemoveRule`), rendered `[NOT] EXISTS (SELECT 1 …)` by `emit.ts`.
 *
 * Only an ELEMENT subject roots a match (a scalar has no element to bind the root to), and only a
 * `match`-headed body reaches here — every other head is answered by the three arms above, so this is
 * new coverage, never a re-spelling.
 */
function matchPredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
): Expr | null {
  if (subject.kind !== 'element' || body[0]?.name !== 'match') return null;
  const scan = ctx.source.elementRow(subject.elem, subject.id, fresh);
  // Promote the bare correlated row to a fold-ready element source, exactly as the `V()`/`E()` seed does
  // (a projected `id` + a `bulk` channel), so movements/reducers inside the match have what they read.
  const seed = make.project({
    id: fresh('ms'), input: scan, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    exprs: [['id', col(scan.id, 'id')], ['bulk', compilerInt(1)]],
  });
  const ran = continueAs(seed, { kind: 'elements', elem: subject.elem }, body, 0, false, inBody(ctx), fresh, NO_ALIASES);
  if (!ran) return null;
  const probeCol = ran.rel.type.cols[0];
  if (!probeCol) return null;
  const probe = make.project({ id: fresh('mp'), input: ran.rel, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(ran.rel.id, probeCol.name)]] });
  return { kind: 'exists', plan: probe, negated };
}

/**
 * A BODY AS A PREDICATE on the current traverser — the two shapes a `choose()` condition can take,
 * and the distinction is TinkerPop's rather than ours.
 *
 * `ChooseStep`'s condition is "does the predicate traversal produce output for this traverser", and
 * that is answered two ways depending on what the body IS:
 *
 * - a FILTER-ONLY body (`__.hasLabel('person')`, `__.has('name','x').has('age',29)`) never leaves the
 *   traverser, so it is a conjunction of ordinary clauses over the same row. Wrapping it in an EXISTS
 *   would ask the same question through an extra subquery.
 * - a body that MOVES (`__.out('created')`) is a sub-traversal, so it is the correlated EXISTS above.
 *
 * A body that mixes a movement with a leading filter is handled by the second arm, since
 * `correlatedExists` folds the filters after the hop itself. Anything else — a body that PROJECTS
 * (`__.values('age').is(P.gt(30))`, `__.out().count().is(P.gt(0))`) — declines: its condition is a
 * value comparison over a correlated sub-read, which is a further arm rather than this one.
 */
export function bodyPredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES,
): Expr | null {
  let clause: Expr | undefined;
  for (const step of body) {
    const filter = sourceFilter(step, subject, fresh, ctx, aliases);
    if (!filter) return correlatedExists(body, subject, fresh, ctx, false)
      ?? valuePredicate(body, subject, fresh, ctx, false, aliases)
      ?? projectionProductive(body, subject, fresh, ctx, aliases);
    clause = and(clause, filter);
  }
  return clause ?? null;
}

/**
 * A body that PROJECTS a scalar and is asked only whether it PRODUCED one — `where(__.values('name'))`,
 * and the non-final arm of `coalesce(__.values('name'), __.constant('x'))`.
 *
 * The seam already computes exactly this: `scalarChild(...).present` is "did this projection yield a
 * value for the host row" — a property EXISTS, a token's ALWAYS — so productivity is that column and
 * needs no second machinery. It is the productivity question `correlatedExists` (a movement head) and
 * `valuePredicate` (a projection THEN `.is()`) both LEAVE: a bare projection produces iff its value is
 * present, which is a different question from its value's nullness only for a property (a stored value
 * is never null) and identical for a token (always).
 *
 * Declines where the seam CANNOT SAY (`present` undefined) rather than guessing — a projection whose
 * absence is not cheaply expressible (a numeric reducer's NULL, which is also its all-null answer) must
 * not be read as unproductive. A FALLBACK, so every body the two above answer keeps the SQL it has.
 */
function projectionProductive(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES,
): Expr | null {
  const produced = scalarChild(body, childHostOf(subject, aliases), ctx, fresh);
  if (!produced?.present) return null;
  return produced.present === ALWAYS_PRODUCTIVE ? CONSTANT.true : produced.present;
}

/**
 * A CHILD BODY AS A BOOLEAN over the subject row, NEGATED or not — the seam's `predicate` answer, and
 * the ONE place the three shapes are tried in order.
 *
 * It exists because the order used to be spelled twice and the two spellings had DIFFERENT CONTENT:
 * the seam offered `bodyPredicate` (all three shapes) while `sourceFilter`'s own `where`/`filter`/`not`
 * arm offered only the last two — so `where(__.has('age', P.gt(27)))`, a filter-only body whose every
 * clause this module already builds, declined at the position it is most often written in. §6·6's rule
 * exactly: the algebra could express it and no route was handing it over.
 *
 * ## Why a negation is not `NOT` of the positive answer, except when it is
 *
 * `correlatedExists` and `valuePredicate` take a `negate` flag because each can negate itself
 * EXACTLY — a `NOT EXISTS` is total, and `valuePredicate` now wraps its comparison null-safely. A
 * filter-only conjunction has no such flag, so it negates through `notProduced` (`build.ts`), which is
 * where the two-valued-versus-three-valued difference is stated once.
 */
export function childPredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
  aliases: AliasMap = NO_ALIASES,
): Expr | null {
  // A body that leads with `select(<label>)` REROOTS the subject to the aliased traverser and continues
  // — `Scoping.getScopeValue` resolves a label off the traverser's scope for a filter body exactly as it
  // does for a projection, so `where(__.select('n').hasLabel('person'))` is a filter on the element `n`
  // named. A bare `select('n')` is productive iff the label is live (`aliasProjection` answers that), so
  // it is the constant truth value under either polarity.
  if (body[0]?.name === 'select') {
    const re = selectRerootSubject(body[0]!, subject, aliases, fresh);
    if (!re) return null;
    if (body.length === 1) return negated ? CONSTANT.false : CONSTANT.true;
    return childPredicate(body.slice(1), re, fresh, ctx, negated, aliases);
  }
  const direct = childPredicateDirect(body, subject, fresh, ctx, negated, aliases);
  if (direct) return direct;
  // LAST RESORT — a trailing MAPPING terminal contributes nothing to the QUESTION, so ask the prefix.
  const prefix = withoutMappingTerminal(body);
  return prefix ? childPredicate(prefix, subject, fresh, ctx, negated, aliases) : null;
}

/**
 * A `select(<label>)` at the head of a FILTER body, rerooting the SUBJECT — the predicate-seam twin of
 * `selectRerootHost` (a value body's reroot). The alias scope is the traverser's, so the label reads
 * off `subject.rel` via `aliasProjection`; an element alias becomes an element subject, a value alias a
 * scalar subject carrying the label's per-row type. A list/Pop history alias declines (a later phase),
 * as does an absent/non-live label (fail closed — never a filter over the wrong row).
 */
function selectRerootSubject(step: IRStep, subject: Subject, aliases: AliasMap, fresh: Minter): Subject | null {
  if (step.modulators?.length) return null;
  const spec = selectSpec(step);
  if (!spec || spec.labels.length !== 1) return null;
  const proj = aliasProjection(subject.rel, aliases, spec.labels[0]!, spec.pop, fresh);
  if (!proj) return null;
  if (proj.read.kind === 'element') return { kind: 'element', id: proj.payload[0]![1]!, elem: proj.read.elem, rel: subject.rel };
  if (proj.read.kind === 'value') {
    const vtype = proj.payload[1]?.[1];
    return {
      kind: 'scalar', value: proj.payload[0]![1]!, rel: subject.rel,
      type: vtype ? { kind: 'perRow', vtype }
        : proj.read.type.kind === 'static' ? { kind: 'static', type: proj.read.type.type, text: proj.read.type.text }
          : SUBJECT_UNKNOWN,
      ...(vtype ? { vtype } : {}),
    };
  }
  return null; // a list/Pop history alias in a filter body is a later phase
}

/**
 * A body's PRODUCTIVITY question with a trailing mapping terminal removed, or `null` where there is none
 * to remove.
 *
 * `<prefix>.project(k…)` produces exactly when `<prefix>` produces, and the same holds for `valueMap`,
 * `elementMap` and `constant`: each is a `ScalarMapStep` that emits one traverser per INCOMING traverser
 * and never drops one — `project()` omits an unproductive KEY (`ProjectStep.map`'s `ifProductive`) and
 * still emits the map, and `constant()` replaces the value without touching the stream. So for the
 * question "did this body produce anything", the terminal is transparent and the prefix carries the whole
 * answer.
 *
 * This is what turns `coalesce(__.hasLabel('person').project(…), __.hasLabel('software').project(…))` —
 * per-member type dispatch, the shape a GraphQL union field takes — from a DECLINE into the right answer:
 * arm 1's emptiness is `NOT hasLabel('person')`, which the filter route can already build. Without it the
 * arm is unanswerable, because `scalarChild`'s record arm takes a `project()` only as a WHOLE body, so
 * `projectionProductive` has no `present` to offer.
 *
 * A FALLBACK and not a first move, which is this module's standing rule for a new route: every body the
 * direct shapes already answered keeps the SQL it has.
 */
const withoutMappingTerminal = (body: readonly IRStep[]): readonly IRStep[] | null => {
  const last = body.at(-1);
  return last && body.length > 1 && MAPPING_TERMINAL.has(last.name) ? body.slice(0, -1) : null;
};

/** The three shapes tried in order, unchanged — split out so the mapping-terminal fallback above can
 *  retry the whole ladder against a prefix rather than duplicating it. */
function childPredicateDirect(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
  aliases: AliasMap = NO_ALIASES,
): Expr | null {
  // A `match`-headed body is a correlated EXISTS rooted at the subject — self-negating, so it answers
  // both polarities and only fires for a match head (every other head falls through to the arms below).
  const asMatch = matchPredicate(body, subject, fresh, ctx, negated);
  if (asMatch) return asMatch;
  if (!negated) return bodyPredicate(body, subject, fresh, ctx, aliases);
  // The two self-negating shapes FIRST, so every body they already answered keeps the SQL it has and
  // this is new coverage rather than a re-spelling — `valuePredicate`'s own ordering rule, one level up.
  const exact = correlatedExists(body, subject, fresh, ctx, true)
    ?? valuePredicate(body, subject, fresh, ctx, true, aliases);
  if (exact) return exact;
  const positive = bodyPredicate(body, subject, fresh, ctx, aliases);
  return positive && notProduced(positive);
}

/**
 * A body that PROJECTS a value and then TESTS it — `where(__.values('age').is(P.gt(30)))`,
 * `where(__.call(dc).is(3))` — as a comparison rather than an existence question.
 *
 * The third answer to "does this body produce output for this traverser", and the one the other two
 * could not give: a filter-only body is a conjunction over the same row, a body that MOVES is a
 * correlated `EXISTS`, and a body that projects a correlated VALUE is that value compared. Asking it
 * through an EXISTS would need the projection as a relation first, which is why `correlatedExists`
 * declines every body whose head is not a movement.
 *
 * PRODUCTIVITY falls out of SQL's own null semantics and needs no clause: an unproductive projection
 * is NULL, every comparison against NULL is NULL, and NULL is not true — which is TinkerPop's answer
 * (the traverser is dropped) reached without a second test to keep in step.
 *
 * A FALLBACK rather than the first thing tried, deliberately: every shape `correlatedExists` already
 * answers keeps the lowering it has, so this is new coverage and not a re-spelling of existing SQL.
 */
export function valuePredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negate: boolean,
  aliases: AliasMap = NO_ALIASES,
): Expr | null {
  const last = body.at(-1);
  if (body.length < 2 || last?.name !== 'is' || last.modulators?.length || last.optionArms) return null;
  const produced = scalarChild(body.slice(0, -1), childHostOf(subject, aliases), ctx, fresh);
  if (!produced) return null;
  const args = argValues(last);
  if (args.length !== 1) return null;
  // The value's own type is what a range comparison needs — a big long carried as decimal TEXT orders
  // lexically otherwise — and the seam now reports it, so the subject type is read rather than assumed.
  const type: SubjectType = produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static'
    ? { kind: 'static', type: produced.framing.type.type, text: produced.framing.type.text }
    : SUBJECT_UNKNOWN;
  const pred = predicateExpr(produced.expr, args[0], type, last.args[0]?.type ?? null, last.args[0]?.name ?? null, fresh,
    (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, elementSubject(subject), ctx, fresh, aliases));
  if (!pred) return null;
  /**
   * PRODUCTIVITY IS ITS OWN CONJUNCT, not a property of the comparison — and the paragraph above,
   * which said otherwise, was WRONG in a way that cost two answers.
   *
   * "An unproductive projection is NULL, every comparison against NULL is NULL, and NULL is not true"
   * holds only for the predicates that compare DIRECTLY. `predicateExpr` spells `neq` NULL-SAFELY —
   * `(v = x) IS NOT 1` — because that is right for a property ROW, where a stored null genuinely does
   * differ from 29. Over a projection that may not EXIST it answers TRUE for a traverser TinkerPop
   * drops, and the negation then drops one it keeps.
   *
   * ⚠️ MEASURED on the modern graph, both directions at once:
   * `g.V().where(__.values('age').is(P.neq(29)))` KEPT `lop`/`ripple` (no `age` at all), and
   * `g.V().not(__.values('age').is(P.neq(29)))` dropped them. So the fix is not another null-safe
   * predicate — it is asking the question the seam already answers.
   */
  if (!produced.present) {
    // The seam CANNOT SAY, and `ChildValue.present` is explicit that this is not "always productive".
    // It is safe to proceed only where the value cannot be absent-but-non-null: a numeric REDUCER over
    // an empty child is exactly that shape, and `correlatedExists` fails closed on the identical fact
    // one arm along. Everything else reaching here compares directly and is NULL-false either way.
    if (produced.framing.kind === 'scalar' && produced.framing.result === 'number') return null;
    return negate ? notProduced(pred) : pred;
  }
  // A body that says it is ALWAYS productive contributes no clause — the conjunct would be a literal
  // `1 = 1` in every emitted statement, which is bytes in the hottest filter position there is.
  const tested = produced.present === ALWAYS_PRODUCTIVE ? pred : and(produced.present, pred);
  // NEGATION IS NULL-SAFE AND `NOT` IS NOT — see `notProduced` (`build.ts`), which carries the second
  // measured wrong answer this line produced. `NOT NULL` is NULL, so a traverser whose body produced
  // nothing was dropped from BOTH sides of the negation.
  return negate ? notProduced(tested) : tested;
}

/**
 * The traverser a child body is rooted at, as the CHILD SEAM's host — one derivation, so the
 * predicate arm and the projection arm cannot disagree about what the subject IS.
 *
 * ⚠️ **The ROW rides along, and dropping it was the reason no child body could read per-traverser
 * state.** TinkerPop evaluates a child traversal on a SPLIT OF THE WHOLE TRAVERSER
 * (`TraversalUtil.prepare`: `traverser.split()`, then `setBulk(1L)`), so `sack()` and `loops()` are
 * ordinary `ScalarMapStep`s reading `traverser.sack()`/`traverser.loops()` — there is no
 * "sack inside until()" special case in the model. Handing over `subject.id` alone is handing over
 * `traverser.get()` instead of the traverser. Calcite frames the same thing as the correlating row
 * being bound and the inner plan referencing its fields (`RexCorrelVariable`).
 *
 * `NO_ALIASES` because the predicate seam genuinely has no alias SCOPE to give — `Subject` carries
 * the relation, not the labels live on it — and the alias reader declines rather than guessing when
 * it finds none, which is what it already did with no row at all.
 */
export const childHostOf = (subject: Subject, aliases: AliasMap = NO_ALIASES): ChildHost => {
  const row = { row: { rel: subject.rel, aliases } };
  switch (subject.kind) {
    case 'element': return { kind: 'element', id: subject.id, elem: subject.elem, ...row };
    case 'property': return { kind: 'property', id: subject.id, ownerElem: subject.ownerElem, ...row };
    case 'scalar': return { kind: 'scalar', value: subject.value, ...(subject.vtype ? { vtype: subject.vtype } : {}), ...row };
  }
};

/**
 * THE TRAVERSER AS A BRANCH SUBJECT, derived from the FRAMING rather than from the caller's shape.
 *
 * It exists because `chooseArms` took an `elem` and therefore could only ever be called from the element
 * fold — so `g.V().values('age').choose(__.is(P.gt(29)), …)` read as a missing lowering when the only
 * thing missing was a way to say "the traverser here is a value". A condition body reads the traverser's
 * own value, which is exactly a `Subject`, and the two shapes that have one are ELEMENT and SCALAR;
 * everything else declines honestly (a condition over a map or a list is a question about its members,
 * not about it).
 *
 * The scalar arm reproduces `scalarTail`'s `subjectType` and must keep agreeing with it: a per-row
 * `vtype` column outranks the compile-time tag, because it is the only thing that separates a `datetime`
 * from a `long`.
 */
export function branchSubject(rel: Rel, framing: RelFraming): Subject | null {
  if (framing.kind === 'elements') return { kind: 'element', id: col(rel.id, 'id'), rel, elem: framing.elem };
  // A PROPERTY traverser is a branch/filter subject too — correlated by the stored row's own rowid, the
  // same address the property `RowShape` and `ChildHost` use. This is what lets `choose`/`coalesce`/
  // `where` over `properties()` fold their condition/arm bodies through the property host, exactly as
  // `union` already does (a `union` needs no subject; these do). A value predicate (`is`) still declines
  // — a property is not a scalar — which `sourceFilter` handles by narrowing.
  if (framing.kind === 'property') return { kind: 'property', id: propertyRowId(rel), ownerElem: framing.ownerElem, rel };
  if (framing.kind !== 'scalar') return null;
  const vtype = rel.type.cols.some((column) => column.name === 'vtype') ? col(rel.id, 'vtype') : undefined;
  return {
    kind: 'scalar', value: col(rel.id, 'v'), rel,
    type: vtype ? { kind: 'perRow', vtype }
      : framing.type.kind === 'static' ? { kind: 'static', type: framing.type.type, text: framing.type.text }
        : SUBJECT_UNKNOWN,
    ...(vtype ? { vtype } : {}),
  };
}


export function sourceFilter(step: IRStep, subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES): Expr | null {
  // One filter form HOSTS a `by()` — the alias-compare `where('a', P.eq('b')).by('key')`, which
  // `isAliasCompareWhere` detects structurally rather than by name — and it is not covered at all
  // (it needs the alias channel). So this stays a blanket decline, and `modulator.ts` is what it will
  // read when that lands; the vocabulary is already there, which is the point of having built it as
  // one. Every other step reaching here (`hasLabel`, `has`, `filter`, `not`) is not a `BY_HOSTS`
  // member, so a modulator on one is a front-end impossibility and declining is belt-and-braces.
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);

  if (step.name === 'hasLabel') {
    // `hasLabelClause` validates and lowers each label `Arg` — an inline name inlines, a `$label`
    // scalar / `$labels` collection binds — so a wire parameter's data never enters the statement text.
    const element = elementSubject(subject);
    return element && hasLabelClause(step.args, element, ctx.source, fresh);
  }

  /**
   * `is(P.x(v))` — the traverser's own VALUE compared, and the clause that makes the connectives
   * usable over a scalar stream at all.
   *
   * It sits here, beside `and`/`or`/`not`, rather than only in the scalar tail, because `and(is(…),
   * is(…))` loops THIS builder over each arm's body: a step the loop cannot build a clause for
   * declines the whole connective, so an `is` that existed only as a tail arm made every scalar
   * connective decline on a body every part of which the algebra already expressed (§6·6 again).
   *
   * The RETYPING form (`is(typeOf(GType.LIST))`) is deliberately NOT here: it re-frames the stream to
   * a collection rather than filtering it, so it is the scalar tail's business and a filter position
   * must decline it rather than answer the rows-right/shape-wrong question.
   */
  if (step.name === 'is') {
    if (subject.kind !== 'scalar' || args.length !== 1 || collectionAssert(step)) return null;
    return predicateExpr(subject.value, args[0], subject.type, step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh,
      (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, elementSubject(subject), ctx, fresh, aliases));
  }

  // `where`/`filter`/`not` over a TRAVERSAL body: a correlated existence test, which is the same
  // question `has` asks of a property row asked of a whole sub-traversal. The body folds through
  // the SAME movement and filter vocabulary as the outer chain — that reuse is the point, and it
  // is why growing movement grew this for free.
  if (step.name === 'where' || step.name === 'filter' || step.name === 'not') {
    const [nested, extra] = args;
    if (extra !== undefined || !isNested(nested)) return null;
    // The correlated EXISTS is `predicateInlining`'s form. With the switch OFF the alternative is a
    // MATERIALIZED child-existence gate — a pushed ordinal, a LEFT JOIN and a rejoin — a lowering
    // STRATEGY this route has not learned, so it declines exactly as it declines an unlearned step:
    // the flag selects between two strategies and only one of them is implemented here.
    if (!ctx.correlatedChildren) return null;
    // NORMALIZING A CHILD BODY CAN RAISE, and a module whose contract is `null` must not let a throw
    // escape (§11, the rule `sliceOf` already instances). `childSteps` re-runs the Pass pipeline over
    // the body, and `rewriteWhereVariables` legitimately hard-errors on a `where(__.as(l))` start
    // variable the body's OWN scope never bound — TinkerPop errors there too. Whether that error is
    // this traversal's answer is not this module's business: catch, decline, and let it surface.
    // Found by `rel-sweep` the moment `as()` made these prefixes reachable at all,
    // which is the same instrument-shaped finding as the four before it.
    const body = bodyOf(nested.nested, ctx.params);
    if (!body?.length) return null;
    // ALL THREE SHAPES, through the one answer: a FILTER-ONLY body is a conjunction over this row, a
    // body that MOVES is a correlated `EXISTS`, and a body that PROJECTS a value is that value
    // compared. This used to offer only the last two, so `where(__.has('age', P.gt(27)))` declined —
    // a body every clause of which this very function builds.
    return childPredicate(body, subject, fresh, ctx, step.name === 'not', aliases);
  }

  /**
   * `and(a, b, …)` / `or(a, b, …)` — THE CONNECTIVE STEPS, which are the connective applied to the
   * answers their arms already have. `ConnectiveStep` is a `FilterStep` whose `filter` runs
   * `TraversalUtil.test` over each arm (`AndStep` returns false on the first failure, `OrStep` true on
   * the first success — `gremlin-core/.../step/filter/{And,Or}Step.java`), so there is no new question
   * here and nothing to lower but the fold.
   *
   * It lands in `sourceFilter` rather than in a tail, and that placement is the whole value: this is
   * the ONE clause builder `bodyPredicate` loops over, so a connective becomes available at EVERY
   * filter position at once — at the source, mid-chain, nested inside a `where()`, inside another
   * connective, as a `choose()` condition, and under a `not()`. A tail-local arm would have served one.
   *
   * The INFIX form (`has(k,v).and().has(k,v)`) never reaches here: a Pass already canonicalizes
   * TinkerPop's `ConnectiveStrategy` into this nested form, which is why the lowering knows only one.
   *
   * NULLs need no care in EITHER connective, and it is worth stating because the negation next door
   * does: SQL's `AND` yields NULL-or-false exactly where an arm failed to produce, and its `OR` yields
   * true as soon as one arm did — both of which are the reference's answer. Only `NOT` inverts the
   * unknown, which is `notProduced`'s subject.
   */
  if (step.name === 'and' || step.name === 'or') {
    // ZERO ARMS is vacuously true for `and` and false for `or` by the reference's own loop, and it
    // DECLINES here rather than being answered: the only way an empty connective reaches a lowering is
    // if the infix canonicalization left a marker behind, and answering a marker as a filter would be
    // mis-executing a chain the Pass tier should have rewritten.
    if (!args.length) return null;
    if (!ctx.correlatedChildren) return null;
    let clause: Expr | undefined;
    for (const arm of args) {
      if (!isNested(arm)) return null;
      const body = bodyOf(arm.nested, ctx.params);
      if (!body?.length) return null;
      const pred = childPredicate(body, subject, fresh, ctx, false, aliases);
      // ONE ARM THIS ROUTE CANNOT ANSWER DECLINES THE WHOLE STEP. A connective is not decomposable
      // into the arms it happens to understand: dropping an arm of an `and` widens the result and
      // dropping one of an `or` narrows it, and either is a plausible answer to a different question.
      if (!pred) return null;
      clause = step.name === 'and' ? and(clause, pred) : or(clause, pred);
    }
    return clause ?? null;
  }

  // `hasNot(key)` is a bare `has(key)` NEGATED, and it reuses that clause rather than spelling a second
  // absence test — the two must agree about what "carries a property" means, and one builder is how.
  if (step.name === 'hasNot') {
    const element = elementSubject(subject);
    // `hasNot(null)` is the negation of a `has(null)` that rejects everything, so it keeps everything.
    if (element && args.length === 1 && args[0] === null) return CONSTANT.true;
    if (!element || args.length !== 1 || typeof args[0] !== 'string') return null;
    const present = hasPropertyClause(args[0], undefined, element, ctx.source, fresh);
    return present && { kind: 'unary', op: 'not', arg: present };
  }

  // EVERY REMAINING CLAUSE READS AN ELEMENT — a property row, a label row, an id. A scalar traverser
  // has none of them, so the narrowing is the honest answer rather than a guard: `values('age').has(…)`
  // is not a filter this route declined to learn, it is a question about something that is not there.
  const element = elementSubject(subject);
  if (!element) return null;

  if (step.name === 'has') {
    // THE THREE ARGUMENT SHAPES, all of one step: `has(key[, value-or-predicate])`,
    // `has(label, key, value-or-predicate)` — which is the label constraint AND the property one,
    // exactly as `HasStep` composes them — and a `T`-TOKEN key, which asks about the element's own
    // id or label rather than about a property row. Each was a separate decline; each is a
    // composition of clauses this module already builds, which is why they arrive together (§6·6).
    if (args.length === 3) {
      // The KEY must be a parsed string; the LABEL may be a string parameter (`hasLabelClause` binds
      // it), so only the key is guarded here.
      if (typeof args[1] !== 'string') return null;
      const labelled = hasLabelClause([step.args[0]!], element, ctx.source, fresh);
      const valued = hasPropertyClause(args[1], args[2], element, ctx.source, fresh, step.args[2]?.type ?? null, step.args[2]?.name ?? null, (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, element, ctx, fresh, aliases));
      return labelled && valued ? and(labelled, valued) : null;
    }
    const [key, val, extra] = args;
    if (extra !== undefined) return null;
    const valType = step.args[1]?.type ?? null;
    const valParam = step.args[1]?.name ?? null;
    if (isTokenArg(key)) return hasTokenClause(key.token, val, element, ctx.source, fresh, valType, valParam, (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, element, ctx, fresh, aliases));
    // A NULL PROPERTY KEY: no element carries a property under it, so the filter rejects everything.
    // `element.property(null)` is absent by construction, which is why `has(null, 'test-null-key')` is
    // the EMPTY result rather than a decline — and rather than the `has('test-null-key')` PRESENCE test
    // it silently became while the front end dropped the null (right answer on this fixture, by luck of
    // no vertex carrying that key).
    if (key === null) return CONSTANT.false;
    if (typeof key !== 'string') return null;
    return hasPropertyClause(key, val, element, ctx.source, fresh, valType, valParam, (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, element, ctx, fresh, aliases));
  }

  // `hasId(...)` reads the element's EXTERNAL id (`COALESCE(uid, id)`), the same row `has(T.id, …)`
  // does — so it is that clause with the id token supplied, and every predicate form composes for
  // free: `hasId(1)`/`hasId([2,6])`/`hasId(1,2)` are an id-membership set (`HasIdStep` treats several
  // ids and a collection alike as a `P.within`, the single-`P` form aside), `hasId(P.gt(2))` a range,
  // `hasId(P.eq(__.V(x).id()))` the nested-operand compare, and `hasId(P.within([]))`/`hasId(null)` the
  // degenerate sets that fold to their truth value. The front end keeps a collection arg WHOLE (with
  // `.members`), which is exactly the single-collection operand `predicateExpr`'s `within` spreads.
  if (step.name === 'hasId') {
    const idArgs = step.args ?? [];
    if (!idArgs.length) return null;
    const single = idArgs.length === 1 ? idArgs[0]! : null;
    const val: unknown = single && isPred(single.value) ? single.value
      : { op: 'within', operands: idArgs };
    return hasTokenClause('id', val, element, ctx.source, fresh, single?.type ?? null, single?.name ?? null,
      (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, element, ctx, fresh, aliases));
  }

  return null;
}

/**
 * `hasLabel(names…)`, as a clause — shared with the three-argument `has(label, key, value)`, whose
 * label half asks the identical question.
 *
 * An EDGE carries its label inline; a VERTEX may hold several, in a side table. Two different
 * physical questions, which is exactly why `Scan` is the only node that names a table.
 */
function hasLabelClause(labelArgs: readonly Arg[], subject: ElementSubject, source: GraphSource, fresh: Minter): Expr | null {
  // A NULL LABEL IS INERT and an ALL-NULL SET MATCHES NOTHING — `labelSetArgs` owns both, and the second
  // is why this cannot be a `filter`: `hasLabel(null)` names a label, so it must reject every element
  // rather than fall through to "no labels named".
  const asked = labelSetArgs(labelArgs);
  if (!asked) return null;
  if (asked.given && !asked.labels.length) return CONSTANT.false;
  // An inline label inlines, a `$label` / `$labels` binds — all inside `labelIds`. An EMPTY argument list
  // reaches here only from a marker the Pass tier should have rewritten, so it declines.
  if (!asked.labels.length) return null;
  // The physical name→id resolution and side-table test are the graph SOURCE's; only the arg
  // normalisation above is the vocabulary's. `subject.label` is the edge's inline label column when
  // the source scan is in scope, letting `BaseGraph` read the covering index directly.
  return source.hasLabelPredicate(subject.elem, subject.id, subject.label, asked.labels, fresh);
}

/**
 * `has(key[, value-or-predicate])` over a stored property, as a clause — an `EXISTS`, correlated on
 * the outer element, because a property FILTER asks whether a row is there and joining instead would
 * multiply the traverser once per matching property.
 *
 * **This shape is what `src/rel/passes/semijoin.ts` recognises** (`indexSeek`), and the recognition
 * is by shape rather than by anything this function announces: a correlated `EXISTS` over a property
 * scan can be CHECKED but never DRIVEN FROM, so on a bare source the pass lifts it in front of the
 * scan as an index seek. Nothing here needs to change for that, which is the point of putting it in a pass.
 */
function hasPropertyClause(key: string, val: unknown, subject: ElementSubject, source: GraphSource, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null, resolveListSet?: (nested: unknown) => Rel | null, resolveScalar?: (nested: unknown) => Expr | null): Expr | null {
  // The VALUE COMPARISON is the vocabulary's — Gremlin `P` semantics, vtype-aware compare, a bare
  // value's declared type/param name riding through so it inlines (a literal) or binds (a `$x`). The
  // source owns the physical property row and the EXISTS scaffold; it hands the comparison the graph's
  // own value + vtype expressions. `undefined` for a bare `has(key)` presence test.
  const valuePred = val === undefined ? undefined
    : (value: Expr, vtype: Expr): Expr | null =>
      predicateExpr(value, val, { kind: 'perRow', vtype }, valType, valParam, fresh, resolveListSet, resolveScalar);
  return source.hasPropertyPredicate(subject.elem, subject.id, key, valuePred, fresh);
}

/**
 * `has(T.label, …)` / `has(T.id, …)` — a token key, which reads the ELEMENT rather than a property
 * row, and is therefore a different question from every other `has`.
 *
 * **`T.label` is ANY label, not the first one.** A vertex may carry several, so the test is an
 * `EXISTS` over its label rows with the predicate on the NAME — which is why this cannot reuse
 * `modulator.ts`'s token projection: a `by(T.label)` takes the FIRST label (insertion order names
 * it), and a `has` that did the same would drop a multi-label vertex whose match is not first.
 *
 * **`T.id` is the EXTERNAL id** — `COALESCE(uid, id)`, the id a client sees — read through a
 * correlated scan so the clause is the same in the source position and after a movement (where the
 * relation carries the rowid alone).
 */
function hasTokenClause(token: string, val: unknown, subject: ElementSubject, source: GraphSource, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null, resolveListSet?: (nested: unknown) => Rel | null, resolveScalar?: (nested: unknown) => Expr | null): Expr | null {
  const name = token.toLowerCase();
  if (name !== 'label' && name !== 'id') return null;
  if (val === undefined) return null;
  // The value comparison is the vocabulary's, handed the token EXPRESSION the source builds. The `id`
  // arm resolves nested list-set / scalar operands; the `label` name arm never does (a label predicate
  // takes no nested operand) — the two closures differ exactly there, preserving the prior byte shape.
  const valuePred = name === 'id'
    ? (external: Expr): Expr | null => predicateExpr(external, val, SUBJECT_UNKNOWN, valType, valParam, fresh, resolveListSet, resolveScalar)
    : (nameCol: Expr): Expr | null => predicateExpr(nameCol, val, SUBJECT_UNKNOWN, valType, valParam, fresh);
  return source.hasTokenPredicate(subject.elem, subject.id, name, valuePred, fresh);
}
