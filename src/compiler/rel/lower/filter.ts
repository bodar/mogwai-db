import * as make from '../../../rel/factory.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../../rel/expr.ts';
import { and, labelSetArgs, meta, or, typeOf, type Minter } from '../build.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { RelFraming } from '../framing.ts';
import type { GraphSource, IdQuery } from '../source.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { collectionAssert, membershipOf } from '../../ir/step.ts';
import type { ChildHost, Subject } from '../child.ts';
import { CONSTANT, framingTypeOf, perRowSubject, predicateExpr, subjectOperand, SUBJECT_UNKNOWN, typedValueKey, type NestedScalar, type NestedSet, type TypedOperand } from '../predicate.ts';
import { inferredVtype } from '../tag.ts';
import { perRowColumnOf } from '../../../sql/kernel/render.ts';
import type { AliasMap } from '../../alias.ts';
import { arg, isNested, isPred, isTokenArg, type Arg } from '../../../gremlin/frontend.ts';
import type { TypeNode } from '../../../gremlin/types.ts';
import { metaPropertyRead, propertyMetaBag, propertyRowId } from '../property.ts';
import { readUnfolded } from '../collection.ts';
import { NO_ALIASES, bodyOf, elementSubject, noteUnrolled, type ChainCtx, type ElementSubject } from './chain.ts';
import { foldedListSet, nestedFirstValue } from './reduction.ts';
import { childPredicate } from './exists.ts';
import { connectorSite } from './scoped.ts';
import type { Elem } from '../../elem.ts';

// FILTER FAMILY — a filter STEP lowered to a boolean `Expr` over the current row: sourceFilter +
// hasLabel/has/hasToken clauses, and the child-subject helpers (childHostOf/branchSubject). A sub-traversal
// body as a boolean (correlatedExists, bodyPredicate/childPredicate/valuePredicate) is `lower/exists.ts`.
// Extracted from lower.ts; calls back into the fold core there.

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
  // A possibly-unbound label subject stays a possibly-absent host (`hostPresence`).
  const present = subject.kind !== 'property' && subject.present ? { present: subject.present } : {};
  switch (subject.kind) {
    case 'element': return { kind: 'element', id: subject.id, elem: subject.elem, ...row, ...present };
    case 'property': return { kind: 'property', id: subject.id, ownerElem: subject.ownerElem, ...row };
    case 'scalar': return { kind: 'scalar', value: subject.value, ...(subject.vtype ? { vtype: subject.vtype } : {}), ...row, ...present };
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
  // The row's own tag column — the stored `vtype`, else the framing's PER-ROW one (a min/max winner's `vt`,
  // a mixed inject's tag) — exactly as `subjectType` reads it. Reading `vtype` alone judged a reducer
  // result by its storage class: a BigDecimal winner carried as decimal TEXT failed `is(P.gt(0.9m))` here
  // while the same `where(is(…))` passed.
  const has = (name: string): boolean => rel.type.cols.some((column) => column.name === name);
  const tagCol = has('vtype') ? 'vtype' : perRowColumnOf(framing.type);
  const vtype = tagCol && has(tagCol) ? col(rel.id, tagCol) : undefined;
  return {
    kind: 'scalar', value: col(rel.id, 'v'), rel,
    type: vtype ? perRowSubject(vtype, col(rel.id, 'v'))
      : framing.type.kind === 'static' ? { kind: 'static', type: framing.type.type, text: framing.type.text }
        : SUBJECT_UNKNOWN,
    ...(vtype ? { vtype } : {}),
  };
}

/**
 * THE SOURCE'S FILTER FUSION — the ONE authority for which filters after a `V()`/`E()` conjoin into the scan's own
 * WHERE: the leading run from `steps[from]` of filters `sourceFilter` lowers over the physical row (an edge's
 * `label` is a column there, not a membership test), so a run of filters is ONE `WHERE` over one scan instead of a
 * CTE-per-filter with its re-join. A child filter at a connector site is the connector's (`lower/scoped.ts`) and
 * ends the run; so does any step `stop` names — the caller's own reason a filter must stay
 * above the scan. Returns the conjoined predicate and the index of the first step not fused.
 */
export function fuseSourceFilters(
  steps: readonly IRStep[], from: number, seeded: { readonly scan: Rel; readonly pred?: Expr }, elem: Elem, ctx: ChainCtx, fresh: Minter,
  stop: (step: IRStep) => boolean = () => false,
): { readonly pred: Expr | undefined; readonly at: number } {
  let pred = seeded.pred;
  let at = from;
  for (; at < steps.length; at++) {
    if (connectorSite(steps[at]) || stop(steps[at]!)) break;
    const clause = sourceFilter(steps[at]!, { kind: 'element', id: col(seeded.scan.id, 'id'), label: elem === 'edge' ? col(seeded.scan.id, 'label') : undefined, rel: seeded.scan, elem }, fresh, ctx);
    if (!clause) break;
    pred = and(pred, clause);
  }
  return { pred, at };
}

export function sourceFilter(step: IRStep, subject: Subject, fresh: Minter, ctx: ChainCtx, aliases: AliasMap = NO_ALIASES): Expr | null {
  // One filter form HOSTS a `by()` — the alias-compare `where('a', P.eq('b')).by('key')`, which
  // `isAliasCompareWhere` detects structurally rather than by name — and it is not covered at all
  // (it needs the alias channel). So this stays a blanket decline, and `modulator.ts` is what it will
  // read when that lands; the vocabulary is already there, which is the point of having built it as
  // one. Every other step reaching here (`hasLabel`, `has`, `filter`, `not`) is not a `BY_HOSTS`
  // member, so a modulator on one is a front-end impossibility and declining is belt-and-braces.
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args.map((a) => a.value);

  // THE TWO CONSTANT FILTERS, over any subject. `identity()` keeps every traverser, so as a filter it
  // is true — `not(__.identity())` is then `NOT true` through the ordinary negation. A non-terminal
  // `discard()` is a `FilterStep` whose `filter` returns false for every traverser
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/
  // filter/DiscardStep.java); a TERMINAL one never reaches here (`stripTerminal` makes it a flag).
  if (step.name === 'identity' && !args.length) return CONSTANT.true;
  if (step.name === 'discard' && !args.length) return CONSTANT.false;

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
    // An ELEMENT or PROPERTY traverser's GType is its framing's (`Elem`, the property's owner), so a type
    // test over one is `typeOfExpr`'s static fold — `V().is(typeOf(GType.VERTEX))`, an edge property's
    // `PROPERTY` — and anything else `is()` would compare has no value operand here, so it declines.
    // A subject that is ABSENT on some rows (a label bound on some, `present`) is not certainly of its
    // kind on those rows, so it declines too rather than fold a type onto a missing traverser.
    if (subject.kind === 'element' || subject.kind === 'property') {
      if (subject.kind === 'element' && subject.present) return null;
      const gtype = subject.kind === 'element' ? subject.elem : subject.ownerElem === 'vertex' ? 'vproperty' : 'property';
      return framingTypeOf(step, gtype) ?? null;
    }
    if (args.length !== 1 || collectionAssert(step)) return null;
    return predicateExpr(subject.value, args[0], subject.type, step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh,
      (nested, typed) => foldedListSet(nested, ctx, fresh, typed), (nested, typed) => nestedFirstValue(nested, elementSubject(subject), ctx, fresh, aliases, typed));
  }

  // `where(P.within('x'))` / `where(P.without('x'))` naming a SIDE EFFECT — membership in the collection.
  if (step.name === 'where' && args.length === 1 && isPred(args[0])) {
    const member = collectionMembership(args[0], subject, ctx, fresh);
    if (member !== undefined) return member;
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
    noteUnrolled(body, ctx, null);
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
      noteUnrolled(body, ctx, null);
      const pred = childPredicate(body, subject, fresh, ctx, false, aliases);
      // ONE ARM THIS ROUTE CANNOT ANSWER DECLINES THE WHOLE STEP. A connective is not decomposable
      // into the arms it happens to understand: dropping an arm of an `and` widens the result and
      // dropping one of an `or` narrows it, and either is a plausible answer to a different question.
      if (!pred) return null;
      clause = step.name === 'and' ? and(clause, pred) : or(clause, pred);
    }
    return clause ?? null;
  }

  // A VERTEXPROPERTY is an Element, so `has`/`hasNot` over one ask about ITS properties — the
  // meta-properties (`metaFilterClause`). An edge `Property` is not an Element and declines.
  if ((step.name === 'has' || step.name === 'hasNot') && subject.kind === 'property') {
    if (subject.ownerElem !== 'vertex') return null;
    return metaFilterClause(step, subject.id, subject.rel, ctx, fresh);
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
      const valued = hasPropertyClause(args[1], args[2], element, ctx.source, fresh, step.args[2]?.type ?? null, step.args[2]?.name ?? null, (nested, typed) => foldedListSet(nested, ctx, fresh, typed), (nested, typed) => nestedFirstValue(nested, element, ctx, fresh, aliases, typed));
      return labelled && valued ? and(labelled, valued) : null;
    }
    const [key, val, extra] = args;
    if (extra !== undefined) return null;
    const valType = step.args[1]?.type ?? null;
    const valParam = step.args[1]?.name ?? null;
    if (isTokenArg(key)) return hasTokenClause(key.token, val, element, ctx.source, fresh, valType, valParam, (nested, typed) => foldedListSet(nested, ctx, fresh, typed), (nested, typed) => nestedFirstValue(nested, element, ctx, fresh, aliases, typed));
    // A NULL PROPERTY KEY: no element carries a property under it, so the filter rejects everything.
    // `element.property(null)` is absent by construction, which is why `has(null, 'test-null-key')` is
    // the EMPTY result rather than a decline — and rather than the `has('test-null-key')` PRESENCE test
    // it silently became while the front end dropped the null (right answer on this fixture, by luck of
    // no vertex carrying that key).
    if (key === null) return CONSTANT.false;
    if (typeof key !== 'string') return null;
    return hasPropertyClause(key, val, element, ctx.source, fresh, valType, valParam, (nested, typed) => foldedListSet(nested, ctx, fresh, typed), (nested, typed) => nestedFirstValue(nested, element, ctx, fresh, aliases, typed));
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
      (nested, typed) => foldedListSet(nested, ctx, fresh, typed), (nested, typed) => nestedFirstValue(nested, element, ctx, fresh, aliases, typed));
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
  // the source scan is in scope, letting `BaseGraph` read the covering index directly; `subject.rel`
  // tells it whether the subject is its own source scan (drive from the label index) or a joined id
  // (probe the label per row).
  return source.hasLabelPredicate(subject.elem, subject.id, subject.label, asked.labels, fresh, subject.rel);
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
/** Does a `where(P)` predicate name a SIDE EFFECT (a collection registered in this chain) as an
 *  operand? `Scoping.getScopeValue` resolves a scope key against the side effects BEFORE the path labels
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java`),
 *  so where a name is both, the collection wins and the alias-compare route must not claim it. */
export const namesACollection = (pred: unknown, ctx: ChainCtx): boolean => {
  const names = (v: unknown): boolean => typeof v === 'string' && ctx.collections.has(v);
  // A list operand's members are select keys too (`getSelectKey` reads a collection's first member, and a GLV
  // sends `within("x")` as `within(["x"])`), so a list naming a collection is claimed here — and declines in
  // `collectionMembership` unless `membershipOf` reads it as one key.
  return isPred(pred) && pred.operands.some((operand) =>
    names(operand.value) || (Array.isArray(operand.value) && operand.value.some(names)) || namesACollection(operand.value, ctx));
};

/**
 * `where(P.within('x'))` / `where(P.without('x'))` where `x` is a SIDE EFFECT — "is the current traverser
 * a member of the collection". `WherePredicateStep` reads its select key through `getScopeValue`, which
 * returns the side effect (an `aggregate`'s BulkSet) before any path label, and sets it as the predicate's
 * value; `within`/`without` over a Collection value is membership (`getSelectKey`'s own "hack for
 * within("x")" —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java`).
 * Multiplicity is irrelevant to membership, so the member relation is read as a set via `EXISTS`. A `not`
 * over the predicate is its negation (`P.not(within('x'))` is `without('x')`) — `membershipOf` decodes both.
 *
 * `undefined` — the predicate names no collection (not this route); `null` — it does, in a form this
 * does not build (another op, several keys, a seeded/keyed collection, a member kind the subject cannot
 * equal), so it DECLINES rather than reading the name as a label or a string.
 */
function collectionMembership(pred: unknown, subject: Subject, ctx: ChainCtx, fresh: Minter): Expr | null | undefined {
  if (!namesACollection(pred, ctx)) return undefined;
  const membership = membershipOf(pred);
  if (!membership) return null;
  const collection = ctx.collections.get(membership.key);
  const members = collection && readUnfolded(collection, fresh);
  if (!members) return null;
  const { negated } = membership;
  // MEMBERSHIP IS AN UNCORRELATED `IN (SELECT …)` — SQLite evaluates the member set ONCE into an ephemeral
  // index and probes it per row, O(N log M) wherever the test lands. A correlated `EXISTS` leans on the
  // planner building an AUTOMATIC index on the member relation, which it does not do everywhere (under a
  // `GROUP BY … HAVING` — the movement collapse's — it re-scans the members per outer row, measured 15 → 915 ms
  // from 1k to 8k vertices), and a per-pair comparison (`valueTheta`'s CASE) has no index at all.
  if (subject.kind === 'element' && members.kind === 'elements') {
    // A vertex never equals an edge, so a member list of the other kind holds no match.
    if (members.elem !== subject.elem) return negated ? CONSTANT.true : CONSTANT.false;
    const ids = make.project({ id: fresh('cmi'), input: members.rel, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(members.rel.id, 'id')]] });
    // `within` stays the bare `IN` a predicate position reads (and `semijoin.ts` may lift into a seek); `without`
    // is the NEGATED 0/1 test, never `NOT IN` (`memberOf`).
    if (!negated) return { kind: 'in-query', expr: subject.id, plan: ids, negated: false };
    return { kind: 'unary', op: 'not', arg: memberOf(subject.id, ids) };
  }
  if (subject.kind === 'scalar' && members.kind === 'scalars' && members.type) {
    const tagCol = perRowColumnOf(members.type);
    const v = col(members.rel.id, 'v');
    // A per-row tag column is NULL where a member's type is its value's own (an `inject`'s natural int or string),
    // read off the value exactly as a per-row SUBJECT's is (`perRowSubject`) — else `1` is not `within` [1].
    const tag: Expr | null = tagCol ? { kind: 'call', fn: 'coalesce', args: [col(members.rel.id, tagCol), inferredVtype(v)] }
      : members.type.kind === 'static' ? compilerText(members.type.type) : null;
    const member = scalarMembership(subjectOperand(subject.value, subject.type), members.rel, { value: v, tag }, fresh);
    return negated ? { kind: 'unary', op: 'not', arg: member } : member;
  }
  return null;
}

/**
 * `x IN (SELECT …)` AS A 0/1 VALUE — `CASE WHEN x IN (…) THEN 1 ELSE 0 END`, never `NOT IN` or a `coalesce` over
 * the `IN`. Where SQLite must tell a NULL answer from a FALSE one (a value position, a `NOT IN`), a probe that
 * MISSES falls back to SCANNING the whole set for a NULL member unless it can prove the set's columns NOT NULL —
 * which it cannot for a computed column — so every non-member costs O(M) and the read is O(N·M) (measured on
 * the bytecode: `Found`, then `Rewind`/`Ne`/`Next` over the ephemeral table). A `CASE WHEN` condition treats NULL
 * as false, so SQLite emits the index probe alone.
 */
const memberOf = (expr: Expr, plan: Rel): Expr => ({
  kind: 'case', whens: [[{ kind: 'in-query', expr, plan, negated: false }, compilerInt(1)]], else: compilerInt(0),
});

/**
 * IS A TYPED VALUE ONE OF A RELATION'S MEMBERS — `valueTheta`'s `eq` (`GremlinValueComparator.equals`: `30` is
 * `30.0`, `true` is not `1`, null equals null alone) against ANY member row, as ONE indexed probe. Each side is
 * reduced to `typedValueKey`'s `(family, key)` pair — equal exactly where `typedValueEq` holds — so the test is the
 * row-value `(f, k) IN (SELECT f, k …)`, evaluated once. NULL is decided first, as `valueTheta` decides it: a
 * null subject is a member iff a member is null. A member whose key is NULL meets nothing (`memberOf`'s CASE reads
 * the unknown as a miss), so `NOT` over the answer is `without` exactly — the answer is 0/1, never SQL's unknown.
 *
 * A subject that is not a bare column or literal is evaluated ONCE, as the one row of a `VALUES` the test is
 * projected over (`valueTheta`'s own shape).
 */
function scalarMembership(subject: TypedOperand, members: Rel, member: TypedOperand, fresh: Minter): Expr {
  const isNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is', left: e, right: compilerNull() });
  // The member's tag is projected ONCE as a column under the key — `typedValueKey` reads its vtype in every
  // arm of both key columns, and a tag that is a `coalesce` over `inferredVtype` would be re-spelled at each.
  const tagged = make.project({
    id: fresh('cmt'), input: members, channels: [], type: typeOf(meta('v', 'any', true), meta('t', 'text', true)),
    exprs: [['v', member.value], ['t', member.tag ?? inferredVtype(member.value)]],
  });
  const [mf, mk] = typedValueKey(col(tagged.id, 'v'), col(tagged.id, 't'));
  const set = make.project({
    id: fresh('cmk'), input: tagged, channels: [], type: typeOf(meta('f', 'text', true), meta('k', 'any', true)), exprs: [['f', mf], ['k', mk]],
  });
  const nulls = make.project({
    id: fresh('cmn'), channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]],
    input: make.filter({ id: fresh('cmz'), input: members, channels: [], type: members.type, pred: isNull(member.value) }),
  });
  const test = (value: Expr, tag: Expr | null): Expr => {
    const [f, k] = typedValueKey(value, tag ?? inferredVtype(value));
    const hit = memberOf({ kind: 'row', items: [f, k] }, set);
    return { kind: 'case', whens: [[isNull(value), { kind: 'exists', plan: nulls, negated: false }]], else: hit };
  };
  const cheap = (e: Expr | null): boolean => !e || e.kind === 'col' || e.kind === 'lit';
  if (cheap(subject.value) && cheap(subject.tag)) return test(subject.value, subject.tag);
  const one = make.values({
    id: fresh('cmo'), channels: [], type: typeOf(meta('a', 'any', true), meta('at', 'text', true)),
    rows: [[subject.value, subject.tag ?? compilerNull('text')]],
  });
  const at: Expr | null = subject.tag ? col(one.id, 'at') : null;
  return { kind: 'scalar', plan: make.project({
    id: fresh('cmq'), input: one, channels: [], type: typeOf(meta('m', 'int')), exprs: [['m', test(col(one.id, 'a'), at)]],
  }) };
}

function metaFilterClause(step: IRStep, rowid: Expr, rel: Rel, ctx: ChainCtx, fresh: Minter): Expr | null {
  const args = step.args.map((a) => a.value);
  if (step.name === 'hasNot') {
    // `hasNot(null)` keeps everything (a null key is carried by nothing), as on an element.
    if (args.length === 1 && args[0] === null) return CONSTANT.true;
    if (args.length !== 1 || typeof args[0] !== 'string') return null;
    return { kind: 'binary', op: 'is', left: metaPropertyRead(propertyMetaBag(rowid, rel, fresh), args[0]).value, right: compilerNull() };
  }
  // `has(key[, value-or-predicate])` only: the three-argument label form and a `T`-token key ask about
  // the VertexProperty's label/id/key/value, which are not meta-properties — they decline here.
  const [key, val, extra] = args;
  if (extra !== undefined) return null;
  if (key === null) return CONSTANT.false;
  if (typeof key !== 'string') return null;
  const { value, vtype } = metaPropertyRead(propertyMetaBag(rowid, rel, fresh), key);
  return predicateExpr(value, val, perRowSubject(vtype, value), step.args[1]?.type ?? null, step.args[1]?.name ?? null, fresh,
    (nested, typed) => foldedListSet(nested, ctx, fresh, typed));
}

function hasPropertyClause(key: string, val: unknown, subject: ElementSubject, source: GraphSource, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null, resolveListSet?: NestedSet, resolveScalar?: NestedScalar): Expr | null {
  // The VALUE COMPARISON is the vocabulary's — Gremlin `P` semantics, vtype-aware compare, a bare
  // value's declared type/param name riding through so it inlines (a literal) or binds (a `$x`). The
  // source owns the physical property row and the EXISTS scaffold; it hands the comparison the graph's
  // own value + vtype expressions. `undefined` for a bare `has(key)` presence test.
  const valuePred = val === undefined ? undefined
    : (value: Expr, vtype: Expr, stored: boolean): Expr | null =>
      predicateExpr(value, val, stored ? { kind: 'perRow', vtype, stored } : { kind: 'perRow', vtype }, valType, valParam, fresh, resolveListSet, resolveScalar);
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
function hasTokenClause(token: string, val: unknown, subject: ElementSubject, source: GraphSource, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null, resolveListSet?: NestedSet, resolveScalar?: NestedScalar): Expr | null {
  const name = token.toLowerCase();
  if (name !== 'label' && name !== 'id') return null;
  if (val === undefined) return null;
  // The value comparison is the vocabulary's, handed the token EXPRESSION the source builds. The `id`
  // arm resolves nested list-set / scalar operands; the `label` name arm never does (a label predicate
  // takes no nested operand) — the two closures differ exactly there, preserving the prior byte shape.
  const valuePred = name === 'id'
    ? (external: Expr): Expr | null => predicateExpr(external, val, SUBJECT_UNKNOWN, valType, valParam, fresh, resolveListSet, resolveScalar)
    : (nameCol: Expr): Expr | null => predicateExpr(nameCol, val, SUBJECT_UNKNOWN, valType, valParam, fresh);
  const idQuery = name === 'id' ? idQueryOf(val, valType, valParam) : null;
  return source.hasTokenPredicate(subject.elem, subject.id, name, valuePred, fresh, idQuery ?? undefined, subject.rel);
}

const RANGE_OPS = { lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/**
 * The `T.id` predicate as a question a source can ROUTE (`IdQuery`, `source.ts`), or `null` where it is
 * not one and the general `COALESCE(uid, id)` comparison answers it.
 *
 * A MEMBERSHIP is `eq`/`within` (and their complements `neq`/`without`) over literal or parameter ids —
 * the very argument list `V(…)` takes, so it is answered by the same routing. A RANGE is
 * `lt`/`lte`/`gt`/`gte`/`between`/`inside`/`outside` over NUMERIC LITERALS (`P.java`'s `between` is
 * `[lo, hi)`, `inside` `(lo, hi)`, `outside` the complement of `inside`). Anything else — a nested
 * traversal operand, a NaN member, a string range, a `P.not`/`and`/`or` composition — stays on
 * the comparison, whose answer this must equal wherever it applies.
 */
function idQueryOf(val: unknown, valType: TypeNode | null, valParam: string | null): IdQuery | null {
  const routable = (a: Arg): boolean => {
    if (isNested(a.value) || isPred(a.value)) return false;
    const members: unknown[] = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
    // A bound collection is routed per json member type (`idMembership`); its other members can match
    // no element id, exactly as the comparison's `json_each` set does.
    if (a.name != null && Array.isArray(a.value) && !a.members) return true;
    // A `null` member is an id no element has, which `idMembership` drops (its complement keeps every row).
    return members.every((v) => v === null || typeof v === 'string' || (typeof v === 'number' && !Number.isNaN(v)));
  };
  // A list among SEVERAL operands is one literal id that matches nothing (`idMembership`), whatever it holds.
  const listAmongSeveral = (a: Arg, n: number): boolean => n > 1 && (a.members != null || Array.isArray(a.value));
  const members = (ids: readonly Arg[], negated: boolean): IdQuery | null =>
    ids.length && ids.every((a) => listAmongSeveral(a, ids.length) || routable(a)) && ids.some((a) => !Array.isArray(a.value) || a.name != null || (a.value as unknown[]).length)
      ? { kind: 'members', ids, negated } : null;
  // A BARE value is `eq(value)`; a bare LIST is equality with a list, never membership, so only a scalar.
  if (!isPred(val)) return val === null || typeof val === 'number' || typeof val === 'string' ? members([arg(val, valType, valParam)], false) : null;
  const { op, operands } = val;
  if (op === 'eq' || op === 'neq') return operands.length === 1 && !Array.isArray(operands[0]!.value) ? members(operands, op === 'neq') : null;
  if (op === 'within' || op === 'without') return members(operands, op === 'without');
  const numeric = (a: Arg | undefined): number | null =>
    a && a.name == null && typeof a.value === 'number' && !Number.isNaN(a.value) ? a.value : null;
  const single = op in RANGE_OPS && operands.length === 1 ? numeric(operands[0]) : null;
  if (single != null) return { kind: 'range', bounds: [[RANGE_OPS[op as keyof typeof RANGE_OPS], single]], join: 'and' };
  if (op === 'between' || op === 'inside' || op === 'outside') {
    const bounds = operands.length === 1 && operands[0]!.members ? operands[0]!.members : operands;
    const [lo, hi] = [numeric(bounds[0]), numeric(bounds[1])];
    if (bounds.length !== 2 || lo == null || hi == null) return null;
    if (op === 'outside') return { kind: 'range', bounds: [['<', lo], ['>', hi]], join: 'or' };
    return { kind: 'range', bounds: [[op === 'inside' ? '>' : '>=', lo], ['<', hi]], join: 'and' };
  }
  return null;
}
