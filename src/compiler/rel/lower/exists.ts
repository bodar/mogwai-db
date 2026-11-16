import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { AliasMap } from '../../alias.ts';
import type { Elem } from '../../elem.ts';
import { scopeKeyReads } from '../../ir/labels.ts';
import { existencePrefix, producesWithoutInput } from '../../ir/productivity.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { writesAnywhere } from '../../ir/strategies.ts';
import { aliasProjection, liveAliases, rerootPresence, seedOuterAliases, selectSpec } from '../alias.ts';
import { and, meta, notProduced, typeOf, type Minter } from '../build.ts';
import { ALWAYS_PRODUCTIVE, hostPresence, presenceOf, type Subject } from '../child.ts';
import { continueAs, edgeFeedsOtherV } from '../lower.ts';
import { CONSTANT, SUBJECT_UNKNOWN, perRowSubject, predicateExpr, type SubjectType } from '../predicate.ts';
import type { GraphSource } from '../source.ts';
import { BULK, NO_ALIASES, elementSubject, inOrderFreeBody, withEnclosing, type ChainCtx } from './chain.ts';
import { childHostOf, sourceFilter } from './filter.ts';
import { movement } from './movement.ts';
import { foldedListSet, nestedFirstValue, readsScopeValue, scalarChild } from './reduction.ts';

// A CHILD BODY AS A BOOLEAN — the correlated existence and its predicate forms: correlatedExists (a body as a
// correlated `[NOT] EXISTS`, the index-seeking form), anchoredSeed/matchPredicate (a body rooted AT the subject),
// and bodyPredicate/childPredicate/valuePredicate (the shapes a where()/and()/or()/not() body, a choose()
// condition, a coalesce arm's emptiness and a repeat() until/emit take). SHARED substrate, owned by neither the
// ladder nor the scoped-relation connector (`docs/2026-11-16-ladder-retirement-plan.md` R1): it is the child
// seam's `predicate` answer (`childSeam`, `lower/reduction.ts` — read by match legs, repeat conditions,
// shortestPath targets) and the step filters' (`sourceFilter`, `lower/filter.ts`), and both run it with the
// ladder off (measured: line coverage of the L1+L6 pools, connector alone vs ladder first). Calls back into the
// fold core.

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
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean, aliases: AliasMap = NO_ALIASES,
): Expr | null {
  // A WRITE in the body is a statement this correlated EXISTS has nowhere to declare — the one
  // `writesAnywhere` authority `scalarChild` and `lowerRankHead` consult (`where(out().mergeE(…))` reached the
  // checker's internal "Ref 'pwN' is not a Plan binding").
  if (writesAnywhere(body, ctx.params)) return null;
  // A MOVEMENT NEEDS AN ELEMENT TO MOVE FROM. A scalar traverser has no adjacency, so this arm is not
  // "not yet taught" for one — it is the arm that does not apply, and `bodyPredicate` falls through to
  // the two that do.
  if (subject.kind !== 'element') return null;
  const elem = subject.elem;
  // An `otherV()` later in the body needs the entering vertex retained even here, where the child is a
  // correlated EXISTS: the subject vertex IS the entering one (`where(outE().order().otherV())`).
  const child = movement(body[0]!, { correlated: subject.id }, elem, ctx.source, fresh, false, edgeFeedsOtherV(body, 0, false));
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
  // The hop starts a fresh relation with NO alias channel, but the labels the subject's traverser holds are
  // still on its path (`TraversalUtil.prepare` splits the WHOLE traverser into the child): they ride in as
  // ENCLOSING (`withEnclosing`), so a `select('a')` past the hop DECLINES rather than reading an absent
  // label as the empty answer — `V().as('a').where(out().select('a'))` answered `[]` for every vertex.
  // The labels the body READS ride further: seeded onto the hop as alias channels (`seedOuterAliases`, the
  // multi-correlation leg's own seeding), so `where(__.in().where(P.eq('a')))` reads the outer `a` at its
  // own position exactly as its `select('b')`-spelled twin does. A body reading the whole path seeds none.
  const reads = scopeKeyReads(body, ctx.params);
  const outer = reads.all ? [] : [...liveAliases(aliases, subject.rel)].filter(([label]) => reads.labels.has(label));
  const seeded = seedOuterAliases(child.rel, subject.rel, outer, fresh);
  const tail = continueAs(seeded.rel, { kind: 'elements', elem: child.elem }, body, 1, false, withEnclosing(inOrderFreeBody(ctx), aliases), fresh, seeded.aliases);
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
 * THE ONE ELEMENT AN OUTER ID NAMES, as a fold-ready element source — the correlated ROOT a body walks
 * from when it must start AT a bound element rather than one hop past it. `source.elementRow(id)` is the
 * single row that id names (a rowid seek on `nodes`/`edges`), promoted exactly as the `V()`/`E()` seed is
 * (a projected `id` + a `bulk` channel), so movements and reducers in the body have what they read.
 *
 * Correlated, so it lives only inside an `exists`/scalar subplan of the outer row — which is the point:
 * a walk seeded here costs the start's own fan-out per outer row, where an unanchored `V()` walk joined
 * back on the start's id costs the whole graph's walk per outer row (~N²). An absent (NULL) id names no
 * row, so the walk is empty — the unbound-label answer.
 */
export function anchoredSeed(source: GraphSource, elem: Elem, id: Expr, fresh: Minter): Rel {
  const scan = source.elementRow(elem, id, fresh);
  return make.project({
    id: fresh('ms'), input: scan, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    exprs: [['id', col(scan.id, 'id')], ['bulk', compilerInt(1)]],
  });
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
  const seed = anchoredSeed(ctx.source, subject.elem, subject.id, fresh);
  const ran = continueAs(seed, { kind: 'elements', elem: subject.elem }, body, 0, false, inOrderFreeBody(ctx), fresh, NO_ALIASES);
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
 * A body that LEADS with filters and then moves or projects, which the whole-body shapes decline, is
 * the filters' conjunction AND the suffix's answer when the suffix is strict (the loop below); filters AFTER a hop are folded by `correlatedExists` itself.
 * Anything else — a body that PROJECTS
 * (`__.values('age').is(P.gt(30))`, `__.out().count().is(P.gt(0))`) — declines: its condition is a
 * value comparison over a correlated sub-read, which is a further arm rather than this one.
 */
export function bodyPredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES,
): Expr | null {
  // A write anywhere in a predicate body declines (`writesAnywhere`, see `correlatedExists`).
  if (writesAnywhere(body, ctx.params)) return null;
  // The three shapes a moving/projecting body can take, spelled in their one order.
  const shapes = (b: readonly IRStep[]): Expr | null =>
    correlatedExists(b, subject, fresh, ctx, false, aliases)
    ?? valuePredicate(b, subject, fresh, ctx, false, aliases)
    ?? projectionProductive(b, subject, fresh, ctx, aliases);
  // A LEADING RUN OF FILTERS TESTS THE SUBJECT ITSELF, so over a STRICT rest it is a conjunct beside
  // whatever the rest asks. A child body is run on a split of the traverser (`TraversalUtil.test`,
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java`),
  // and a filter step never moves it, so `rest` runs on this one traverser when `F` holds of it and on NO
  // traverser when it does not. `where(F.rest)` is therefore `F(subject) ∧ productive(rest)` exactly when
  // `rest` yields nothing from no input. A seeded barrier breaks that — `count()` is 0 and `fold()` is `[]`
  // over an empty stream (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ReducingBarrierStep.java`)
  // — so `where(hasLabel('person').out().count().is(0))` KEEPS a software vertex, and conjoining would
  // drop it. `producesWithoutInput` (`ir/productivity.ts`) is that authority.
  //
  // The WHOLE body is asked first, so every body answered before keeps its SQL and its answer; the split
  // is reached only where the whole body declines, and a non-strict rest declines as the whole body did.
  let clause: Expr | undefined;
  for (let i = 0; i < body.length; i++) {
    const filter = sourceFilter(body[i]!, subject, fresh, ctx, aliases);
    if (!filter) {
      const whole = shapes(body);
      if (whole || i === 0) return whole;
      const rest = body.slice(i);
      if (producesWithoutInput(rest)) return null;
      const suffix = shapes(rest);
      return suffix && and(clause, suffix);
    }
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
 * Declines where the seam CANNOT SAY (`present` is `'unknown'`) rather than guessing — a projection whose
 * absence is not cheaply expressible (a numeric reducer's NULL, which is also its all-null answer) must
 * not be read as unproductive. A FALLBACK, so every body the two above answer keeps the SQL it has.
 */
function projectionProductive(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES,
): Expr | null {
  const produced = scalarChild(body, childHostOf(subject, aliases), ctx, fresh);
  const present = produced && presenceOf(produced.present, produced.expr);
  if (!present) return null;
  return present === ALWAYS_PRODUCTIVE ? CONSTANT.true : present;
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
  // A write anywhere in a predicate body declines (`writesAnywhere`, see `correlatedExists`).
  if (writesAnywhere(body, ctx.params)) return null;
  // A body that leads with `select(<label>)` REROOTS the subject to the aliased traverser and continues
  // — `Scoping.getScopeValue` resolves a label off the traverser's scope for a filter body exactly as it
  // does for a projection, so `where(__.select('n').hasLabel('person'))` is a filter on the element `n`
  // named. A bare `select('n')` is productive iff the label is bound on THIS row — `hostPresence`, the
  // constant truth for a statically bound label and `id IS NOT NULL` for one bound in a branch arm.
  // A continuation is NOT conjoined with that presence: it already sees an empty subject where the label
  // is unbound, and a conjunct would veto a seeded body (`select('a').count().is(0)`) that keeps it.
  if (body[0]?.name === 'select') {
    // …except where the key is a `withSideEffect` constant, or the subject a per-row scalar that MAY BE A
    // MAP whose own entry is the only scope (`readsScopeValue`; a path label keeps this re-root) — one
    // `{t,v}` node the value seam reads, so the body's productivity is that seam's presence
    // (`projectionProductive`).
    if (readsScopeValue(body[0]!, childHostOf(subject, aliases), ctx)) {
      const present = projectionProductive(body, subject, fresh, ctx, aliases);
      return present && (negated ? notProduced(present) : present);
    }
    const re = selectRerootSubject(body[0]!, subject, aliases, fresh);
    if (!re) return null;
    if (body.length === 1) {
      const present = hostPresence(re);
      if (!present) return null;
      if (present === ALWAYS_PRODUCTIVE) return negated ? CONSTANT.false : CONSTANT.true;
      return negated ? notProduced(present) : present;
    }
    return childPredicate(body.slice(1), re, fresh, ctx, negated, aliases);
  }
  const direct = childPredicateDirect(body, subject, fresh, ctx, negated, aliases);
  if (direct) return direct;
  // LAST RESORT — what follows the body's last row-dropping step contributes nothing to the QUESTION, so ask
  // the EXISTENCE PREFIX (`ir/productivity.ts`, the authority the `trimExistenceSuffix` Pass rewrites a true
  // existence position with). This is the consumer that cannot rewrite: a `coalesce` arm's emptiness, whose
  // VALUE is still used — `coalesce(__.hasLabel('person').project(…), __.hasLabel('software').project(…))`,
  // per-member type dispatch, the shape a GraphQL union field takes. An empty prefix produces wherever reached.
  const prefix = existencePrefix(body, ctx.params);
  if (prefix && !prefix.length) return negated ? CONSTANT.false : CONSTANT.true;
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
  // As `selectRerootHost`: a label that may be unbound here, or a subject that may itself be absent
  // (`rerootPresence`).
  const rerooted = rerootPresence(subject, subject.rel, proj);
  if (!rerooted) return null;
  const { key, present } = rerooted;
  if (proj.read.kind === 'element') return { kind: 'element', id: key, elem: proj.read.elem, rel: subject.rel, ...present };
  if (proj.read.kind === 'value') {
    const vtype = proj.payload[1]?.[1];
    return {
      kind: 'scalar', value: key, rel: subject.rel,
      type: vtype ? perRowSubject(vtype, key)
        : proj.read.type.kind === 'static' ? { kind: 'static', type: proj.read.type.type, text: proj.read.type.text }
          : SUBJECT_UNKNOWN,
      ...(vtype ? { vtype } : {}), ...present,
    };
  }
  return null; // a list/Pop history alias in a filter body is a later phase
}

/** The three shapes tried in order, unchanged — split out so the existence-prefix fallback above can
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
  const exact = correlatedExists(body, subject, fresh, ctx, true, aliases)
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
  // ONE value is the comparison's subject only where the prefix had ONE to give: `is()` tests EVERY result
  // of a multi-valued read (`values('loc')` over `loc = [a, b]`), and the filter passes when ANY survives —
  // the first SURVIVOR, which `scalarChild` builds for the whole body (`propertyFirstPassing`) and
  // `projectionProductive` reads. Comparing the first stored value answered `where(values('loc').is('b'))`
  // with a dropped vertex.
  if (produced.yields !== 'one') return null;
  const args = last.args.map((a) => a.value);
  if (args.length !== 1) return null;
  // The value's own type is what a range comparison needs — a big long carried as decimal TEXT orders
  // lexically otherwise — and the seam reports it TWO ways, both of which must be read or the compare
  // silently falls back to `SUBJECT_UNKNOWN`'s storage-class heuristic. A TRANSFORMED value
  // (`asNumber`/`asDate`) carries a STATIC tag; a raw stored read (`values(k)`) carries a PER-ROW
  // `vtype` column (`produced.vtype`, framing `PER_ROW('vtype')` — `reduction.ts`), which
  // `predicateExpr`'s `perRow` arm casts by. Dropping the second was the bug this seam already fixed
  // for `project`/`aggregate`/`store`: `where(__.values('age').is(P.gt(30)))` over a big long compared
  // lexically. A numeric REDUCER (`result:'number'`) needs neither — its value is a native SQL number —
  // so it stays `SUBJECT_UNKNOWN`, which is also where the unknown-presence guard below expects it.
  const type: SubjectType = produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static'
    ? { kind: 'static', type: produced.framing.type.type, text: produced.framing.type.text }
    : produced.framing.kind === 'scalar' && produced.framing.type.kind === 'perRow' && produced.vtype
      ? perRowSubject(produced.vtype, produced.expr)
      // A `result: 'number'` branch (a scalar coalesce) keeps its per-row arm tag in a mixed vocabulary:
      // not a cast key, but still what says a `constant(true)` arm is a Boolean, not the Number 1.
      : produced.vtype ? { kind: 'unknown', tag: produced.vtype } : SUBJECT_UNKNOWN;
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
  const present = presenceOf(produced.present, produced.expr);
  if (!present) {
    // The seam CANNOT SAY, and `ChildValue.present` is explicit that this is not "always productive".
    // It is safe to proceed only where the value cannot be absent-but-non-null: a numeric REDUCER over
    // an empty child is exactly that shape, and `correlatedExists` fails closed on the identical fact
    // one arm along. Everything else reaching here compares directly and is NULL-false either way.
    if (produced.framing.kind === 'scalar' && produced.framing.result === 'number') return null;
    return negate ? notProduced(pred) : pred;
  }
  // A body that says it is ALWAYS productive contributes no clause — the conjunct would be a literal
  // `1 = 1` in every emitted statement, which is bytes in the hottest filter position there is.
  const tested = present === ALWAYS_PRODUCTIVE ? pred : and(present, pred);
  // NEGATION IS NULL-SAFE AND `NOT` IS NOT — see `notProduced` (`build.ts`), which carries the second
  // measured wrong answer this line produced. `NOT NULL` is NULL, so a traverser whose body produced
  // nothing was dropped from BOTH sides of the negation.
  return negate ? notProduced(tested) : tested;
}
