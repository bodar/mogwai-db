import { groupableChannels, mergeChannels, sameChannels, withChannel, type Channel, type Channels } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { BindBudgetExceeded, DO_BIND_CAP } from '../../rel/check.ts';
import { emit, emitRelational } from '../../rel/emit.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import { render } from '../../sql/kernel/q.ts';
import { plan as program, type Binding, type Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import { forEachRel } from '../../rel/walk.ts';
import type { ColMeta, SortTerm } from '../../rel/types.ts';
import { assertsGType, collectionAssert, isLocalScope, PATH_LIST_OPS, sliceOf, sliceParamNames, typeOfAssert } from '../ir/step.ts';
import { PER_ROW, perRowColumnOf, STATIC, staticTypeOf, UNKNOWN, type ListOf, type Shape, type ValueType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import type { RelFraming } from './framing.ts';
import { flattenListArgs, isNested, isTokenArg, stepChain, argValues, arg, type Arg } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, type TypeNode } from '../../gremlin/types.ts';
import { constLit, countLit, itemTypeAt, sliceBound } from './const.ts';
import type { IRStep } from '../ir/strategies.ts';
import { analyzeChain } from '../ir/analyze.ts';
import { childSteps, normalize } from '../ir/passes.ts';
import { containsTextSearch, predicateExpr, storedCompareOn, SUBJECT_UNKNOWN, type SubjectType } from './predicate.ts';
import { foldConstantCoercions, injectValueTypes } from '../../gremlin/coerce.ts';
import {
  and, byEncounter, carriedCols, EDGE_COLS, eq, labelIds, meta, minter, NODE_COLS, PROPERTIES, renumber, storedValue,
  typeOf, type Minter,
} from './build.ts';
import { bindAliases, selectOne, type AliasRead } from './alias.ts';
import type { AliasMap } from '../plan/alias.ts';
import { byExpr, modulations, orderProductivity, productivityFilter, type Modulation } from './modulator.ts';
import type { ChildHost, ChildSeam, RootedRead, Subject } from './child.ts';
import { REL_TRANSFORMS, transformExpr } from './transform.ts';
import { isLongSumClass, isReducer, reducerAggregate, sumTower } from './reducer.ts';
import { elementAddE, elementAddV, elementDrop, elementMergeE, elementMergeV, elementProperty, propertyWrites, type Effects } from './write.ts';
import { BARE_LIST, collectionRetype, foldScalars, LIST_COL, listMemberOp, listPayload, listRetype, listSetOp, unfoldList } from './list.ts';
import { elementHost, groupBarrier, mapPayload } from './map.ts';
import { elementPayload } from './element.ts';
import { extendPath, PATH_CHANNEL, pathCarried, pathPayload, pathPositions, seedPath } from './path.ts';
import { LabelCardinality } from '../../api.ts';

/**
 * THE SECOND LOWERING — `Step[] -> RelIR` (§10·4 of `docs/2026-08-01-relir-build-plan.md`).
 *
 * The legacy spine (`LoweringEngine`) builds SQL into an append-only `Query`, so the query never
 * exists as data and every optimization has to happen before or during lowering. This module is the
 * replacement route, and it grows STEP BY STEP: a traversal whose every step is covered here lowers
 * to a `Plan` and takes the RelIR route end-to-end; anything else returns `null` and the legacy
 * spine handles it whole. **Never mixed inside one traversal** — that is what keeps RelIR a real
 * algebra rather than a wrapper, and it is why there is no opaque escape node and never will be
 * (§10·4: "not as a bridge, not temporarily, not behind a flag").
 *
 * `null` is therefore the ONLY decline, and it must stay cheap and total: a step this module has
 * not learned yet is not an error, it is coverage that has not been written. What it must never do
 * is answer a DIFFERENT question — a partial lowering that silently drops a filter would be
 * invisible to the differential, since both spines would be asked and only one asked correctly.
 *
 * ## What this module does NOT do
 *
 * **BYTE FRAMING.** `(rows, Shape) → Buffer[]` is `execute.ts`'s, contains no SQL, and stays per-shape
 * forever. So this returns a RELATION plus the `RelFraming` that says what the relation holds.
 *
 * **The PAYLOAD PROJECTION is a different thing and is on its way IN, not permanently out.** Today
 * `spine.ts` hands the relation to legacy's materializer, which composes the payload SELECT — so the
 * element payload, the list/map blob reads and their `Shape` choice are still built outside the algebra.
 * §10·10 of the build plan corrects that: `materialize.ts` produces SQL, so it is a query producer and
 * therefore this layer's work, and `Shape` is the boundary. `list.ts` and `map.ts` already do it the
 * intended way for their two shapes; the element payload is the keystone that is left.
 */

/**
 * A covered chain, lowered: the program, and what to frame over it.
 *
 * The output COLUMNS and the CHANNELS are deliberately absent: both are properties of
 * `plan.result`, and carrying them beside it was two bookkeeping variables threaded through every
 * arm of the fold with nothing but discipline keeping them in step with the relation they described.
 * `spine.ts` reads them off the result (§9's declare-vs-derive finding, applied where the desync was
 * actually reachable — a channel list shorter than the relation's is the 33% defect category).
 */
export interface RelLowering {
  readonly plan: Plan;
  /**
   * THE WHOLE FRAMING CONTRACT — §10·10 reached, and the reason this is a `Shape` and not a `RelFraming`.
   *
   * The plan's result relation IS the rows `execute.ts` frames: its columns are the wire columns, its row
   * order is the wire's, and there is nothing left to compose over it. So what the spine hands on is the
   * one thing the byte framers need, which is also the only Gremlin-level fact that survives the boundary.
   *
   * `RelFraming` stays INTERNAL to the fold, and the difference is not cosmetic: an arm merge and a retype
   * need to know what a relation HOLDS (member encodings, key/value sides, the scalar type channel), which
   * is a larger question than which `Shape` frames it. Two vocabularies because there are two questions.
   *
   * What went with the transition: `LAYOUT_FIELD`/`layoutOf` (the `Channels`→`TraverserLayout` bridge,
   * which is what blocked the path channel — it could declare no translation for `path`, `origin` or
   * `branchOrder` and threw), and `RelLowering.aliases` (the alias map had exactly one reader, that bridge).
   */
  readonly shape: Shape;
}

/** A lowered chain BEFORE naming and the budget — the relation, plus the two facts about it that are
 *  not properties of the relation itself. Every tail function returns this shape. */
type Tail = {
  readonly rel: Rel; readonly framing: RelFraming; readonly aliases: AliasMap;
  /**
   * THE STATEMENTS THIS CHAIN RUNS BEFORE ITS RESULT IS READ — a write's effects, in execution order
   * (§3.0: effects are legal only at a `Plan` binding).
   *
   * Absent for every read, which is why it is optional rather than an empty list threaded through
   * forty returns. A step that writes appends here and hands back a `Ref` to whichever binding its
   * result is, so the fold's shape does not change and a write remains one step of the same loop
   * rather than a second orchestrator.
   */
  readonly effects?: readonly Binding[];
};

/** No label bound yet. One shared value, because an empty Map is the seed at every entry point. */
const NO_ALIASES: AliasMap = new Map();

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];

/**
 * The EMISSION-ORDER channel, and the second carried role this route models.
 *
 * A chain that slices has an answer depending on which rows come first; `analyzeChain` marks it
 * `demandsEncounter` and the SOURCE seeds a monotone column — but that flag is only ever the seed's
 * question, never the plan's. **The channel set is a property of each RELATION**, so an `order()`
 * MINTS this channel where none arrived and every reader downstream keys on its presence rather than
 * on a chain-global boolean threaded from the source. That is why `withChannel` exists in the core:
 * `ROLE_ORDER` is an invariant of a `Channels` list, and the framing layer's `layoutCols` sorts the
 * same way — bulk before encounter — so a mint that appended out of order would desync the declared
 * schema from the physical one.
 */
const ENCOUNTER: Channel = { col: 'encounter', role: 'encounter' };
const encounterOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'encounter');

/**
 * An element relation's DECLARED COLUMNS: the traverser's id, then one column per carried channel,
 * in the channel list's own order.
 *
 * Derived from the channels rather than from a boolean, which is the whole of the model change: a
 * chain no longer has one element shape decided at its source, so every producer here asks its
 * INPUT what it carries. A role this route grows tomorrow gets its column with no edit at all.
 */
const elementCols = (channels: Channels): readonly ColMeta[] => [meta('id', 'int'), ...carriedCols(channels)];



/**
 * A source-scope FILTER as a predicate over the element scan — the whole of `hasLabel`/`has` that
 * needs no predicate vocabulary.
 *
 * Written against the SCAN rather than against a projected id-relation, which is the structural
 * difference from the legacy spine and the point of the exercise: legacy gives every filter its own
 * CTE that re-joins the element table to reach a column its predecessor projected away
 * (`… FROM nodes n JOIN c1 p ON n.id=p.id WHERE EXISTS(…)`), so `has(a).has(b)` is three CTEs and
 * two redundant self-joins. Here they conjoin into ONE `WHERE` over one scan, because a filter
 * neither changes the relation's cardinality contract nor consumes a channel, and the plan is data
 * so a later step can still see the columns.
 */
/** What a filter needs beyond the step and its subject: the bound parameters a nested body parses
 *  against, and whether the correlated-child form is this compile's to emit (see `Lowering`). */
interface FilterCtx { readonly params: Record<string, any>; readonly correlatedChildren: boolean; }

/** What the ELEMENT loop needs on top of a filter's context: whether this compile asked for the
 *  movement collapse. One record rather than three positional arguments, because `elementTail` is now
 *  re-entered from three places and a re-entry that dropped one of them would silently pick a
 *  different lowering strategy. */
interface ChainCtx extends FilterCtx {
  readonly collapse: boolean;
  readonly tracksPath: boolean;
  /** Does this chain have an EMISSION ORDER at all — `analyzeChain`'s chain-global answer, threaded
   *  rather than re-derived. A step that MINTS a fresh traverser (`addV`) has to know: it seeds the
   *  position channel exactly where the source would have, and a step-local re-derivation would be a
   *  second authority on a fact the source already decided. */
  readonly ordered: boolean;
  /** The GRAPH's declared vertex-label cardinality, which decides what a creation with no label of
   *  its own gets. Threaded for the reason `ordered` is: it is settled before a step is lowered, so a
   *  step that asked the store instead would be asking at the wrong time. */
  readonly labelCardinality: LabelCardinality;
  /** The `withSideEffect(name, constant)` registry the FRONT END extracted. See `Lowering`. */
  readonly sideEffects: Map<string, any>;
}

/** A nested body, normalized — or `null` where normalizing it RAISES. See the call site for why a
 *  throw there is a deferral rather than a bug. */
const bodyOf = (nested: unknown, params: Record<string, any>, sideEffects?: Map<string, any>): readonly IRStep[] | null => {
  try { return childSteps(nested, params, sideEffects); } catch { return null; }
};

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
function correlatedExists(
  body: readonly IRStep[], subject: Subject, elem: Elem, fresh: Minter, ctx: ChainCtx, negated: boolean,
): Expr | null {
  const child = movement(body[0]!, { correlated: subject.id }, elem, fresh);
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
  const tail = continueAs(child.rel, { kind: 'elements', elem: child.elem }, body, 1, false, ctx, fresh, NO_ALIASES);
  if (!tail) return null;
  // A NUMERIC REDUCER OVER AN EMPTY CHILD IS THE ONE PLACE SQL AND GREMLIN DISAGREE ABOUT EXISTENCE,
  // so it fails closed. `sum`/`min`/`max`/`mean` over zero rows return ONE row holding NULL in SQL,
  // while TinkerPop emits NO traverser — so a bare EXISTS answers "true" for a parent the reference
  // REJECTS. Right arity, plausible rows, and the differential cannot see it because both spines are
  // asked and only one is asked correctly, which is precisely the shape the decline contract exists
  // to keep out. `count()` and `fold()` are NOT this: both emit a traverser for an empty child (0 and
  // the empty list), so their EXISTS is honest. Expressing the reducer case needs the aggregate's
  // own NULL-ness as the test rather than row existence; that is a further arm.
  if (tail.framing.kind === 'scalar' && tail.framing.result === 'number') return null;
  // THE PROBE PROJECTS THE TAIL'S OWN FIRST COLUMN, not a literal — an EXISTS does not care what the
  // value is, but the BLOCK does. A body ending in a reducer is an `Aggregate`, and the assembler
  // fuses the whole run into one SELECT; projecting `1` there left a block with a `HAVING` and no
  // aggregate in its select list, which SQLite refuses outright (`HAVING clause on a non-aggregate
  // query`) — a THROW from the position where legacy answers. Projecting the column keeps whatever
  // the block computes visible, so the aggregate query stays an aggregate query.
  //
  // A `Materialize` fence is the WRONG remedy here even though it is the right one elsewhere (§11):
  // this subplan is CORRELATED to the outer row, and a fence forces a named CTE, which cannot
  // reference it. That is the same fact behind `name` not walking expression subplans.
  const probeCol = tail.rel.type.cols[0];
  if (!probeCol) return null;
  const probe = make.project({ id: fresh('p'), input: tail.rel, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(tail.rel.id, probeCol.name)]] });
  // `NOT EXISTS`, not legacy's `NOT COALESCE(EXISTS(…), 0)`: EXISTS is never NULL, so the COALESCE
  // guards nothing here.
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
function bodyPredicate(
  body: readonly IRStep[], subject: Subject, elem: Elem, fresh: Minter, ctx: ChainCtx,
): Expr | null {
  let clause: Expr | undefined;
  for (const step of body) {
    const filter = sourceFilter(step, subject, elem, fresh, ctx);
    if (!filter) return correlatedExists(body, subject, elem, fresh, ctx, false);
    clause = and(clause, filter);
  }
  return clause ?? null;
}

function sourceFilter(step: IRStep, subject: Subject, elem: Elem, fresh: Minter, ctx: ChainCtx): Expr | null {
  // One filter form HOSTS a `by()` — the alias-compare `where('a', P.eq('b')).by('key')`, which
  // `isAliasCompareWhere` detects structurally rather than by name — and it is not covered at all
  // (it needs the alias channel). So this stays a blanket decline, and `modulator.ts` is what it will
  // read when that lands; the vocabulary is already there, which is the point of having built it as
  // one. Every other step reaching here (`hasLabel`, `has`, `filter`, `not`) is not a `BY_HOSTS`
  // member, so a modulator on one is a front-end impossibility and declining is belt-and-braces.
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);

  if (step.name === 'hasLabel') {
    const names = flattenListArgs(args);
    if (!names.length || names.some((n) => typeof n !== 'string')) return null;
    return hasLabelClause(names as string[], subject, elem, fresh);
  }

  // `where`/`filter`/`not` over a TRAVERSAL body: a correlated existence test, which is the same
  // question `has` asks of a property row asked of a whole sub-traversal. The body folds through
  // the SAME movement and filter vocabulary as the outer chain — that reuse is the point, and it
  // is why growing movement grew this for free.
  if (step.name === 'where' || step.name === 'filter' || step.name === 'not') {
    const [nested, extra] = args;
    if (extra !== undefined || !isNested(nested)) return null;
    // The correlated EXISTS is `predicateInlining`'s form. With the switch OFF the legacy spine
    // lowers a MATERIALIZED child-existence gate instead — a pushed ordinal, a LEFT JOIN and a
    // rejoin — which is a lowering STRATEGY this route has not learned, so it declines exactly as
    // it declines an unlearned step. That is not spine choice reading the fast-path config to dodge
    // an optimization (the FTS rule): the flag selects between two strategies and RelIR implements
    // one of them, so both positions stay live and L5's differential still compares two forms.
    if (!ctx.correlatedChildren) return null;
    // NORMALIZING A CHILD BODY CAN RAISE, and a module whose contract is `null` must not let a throw
    // escape (§11, the rule `sliceOf` already instances). `childSteps` re-runs the Pass pipeline over
    // the body, and `rewriteWhereVariables` legitimately hard-errors on a `where(__.as(l))` start
    // variable the body's OWN scope never bound — TinkerPop errors there too. Whether that error is
    // this traversal's answer is the spine that owns the message's business, not ours: catch, decline,
    // and let it raise. Found by `rel-sweep` the moment `as()` made these prefixes reachable at all,
    // which is the same instrument-shaped finding as the four before it.
    const body = bodyOf(nested.nested, ctx.params);
    if (!body?.length) return null;
    return correlatedExists(body, subject, elem, fresh, ctx, step.name === 'not');
  }

  // `hasNot(key)` is a bare `has(key)` NEGATED, and it reuses that clause rather than spelling a second
  // absence test — the two must agree about what "carries a property" means, and one builder is how.
  if (step.name === 'hasNot') {
    if (args.length !== 1 || typeof args[0] !== 'string') return null;
    const present = hasPropertyClause(args[0], undefined, subject, elem, fresh);
    return present && { kind: 'unary', op: 'not', arg: present };
  }

  if (step.name === 'has') {
    // THE THREE ARGUMENT SHAPES, all of one step: `has(key[, value-or-predicate])`,
    // `has(label, key, value-or-predicate)` — which is the label constraint AND the property one,
    // exactly as `HasStep` composes them — and a `T`-TOKEN key, which asks about the element's own
    // id or label rather than about a property row. Each was a separate decline; each is a
    // composition of clauses this module already builds, which is why they arrive together (§10·8).
    if (args.length === 3) {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return null;
      const labelled = hasLabelClause([args[0]], subject, elem, fresh);
      const valued = hasPropertyClause(args[1], args[2], subject, elem, fresh, step.args[2]?.type ?? null, step.args[2]?.name ?? null);
      return labelled && valued ? and(labelled, valued) : null;
    }
    const [key, val, extra] = args;
    if (extra !== undefined) return null;
    const valType = step.args[1]?.type ?? null;
    const valParam = step.args[1]?.name ?? null;
    if (isTokenArg(key)) return hasTokenClause(key.token, val, subject, elem, fresh, valType, valParam);
    if (typeof key !== 'string') return null;
    return hasPropertyClause(key, val, subject, elem, fresh, valType, valParam);
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
function hasLabelClause(names: readonly string[], subject: Subject, elem: Elem, fresh: Minter): Expr {
  const ids = labelIds(names, fresh);
  if (elem === 'edge') {
    // Direct where the column is physically present (the source scan), and a membership test on
    // the edge id where it is not (after a movement, the relation is `id` + channels). Same
    // question, and the first form keeps the covering-index read the source position deserves.
    if (subject.label) return { kind: 'in-query', expr: subject.label, plan: ids, negated: false };
    const e = make.scan({ id: fresh('el'), table: 'edges', alias: fresh('rel'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
    const matching = make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: { kind: 'in-query', expr: col(e.id, 'label'), plan: ids, negated: false } });
    const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
    return { kind: 'in-query', expr: subject.id, plan: owners, negated: false };
  }
  const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
  const matching = make.filter({ id: fresh('f'), input: vl, channels: [], type: vl.type, pred: { kind: 'in-query', expr: col(vl.id, 'label'), plan: ids, negated: false } });
  const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('node', 'int')), exprs: [['node', col(matching.id, 'node')]] });
  return { kind: 'in-query', expr: subject.id, plan: owners, negated: false };
}

/** `has(key[, value-or-predicate])` over a stored property, as a clause — an `EXISTS`, correlated on
 *  the outer element, because a property FILTER asks whether a row is there and joining instead would
 *  multiply the traverser once per matching property. */
function hasPropertyClause(key: string, val: unknown, subject: Subject, elem: Elem, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null): Expr | null {
  // A substring `TextP` over a STORED property is `ftsSubstringPredicate`'s, and taking it here
  // would swap a trigram-index seek for a base-table LIKE scan — a regression the census cannot
  // see, reported by the coverage number as progress. §4.7 lifts this.
  if (containsTextSearch(val)) return null;

  const { table, owner } = PROPERTIES[elem];
  const props = make.scan({
    id: fresh('vp'), table, alias: fresh('rp'), channels: [],
    type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  // The property row's own `vtype` is in scope here, so an ordering comparison gets the
  // vtype-aware key — the whole reason `predicateExpr` takes `compare` as a parameter. A bare value's
  // declared type and param name ride through so it inlines (a literal) or binds (a `$x`).
  const matches = val === undefined ? undefined
    : predicateExpr(col(props.id, 'value'), val, { kind: 'perRow', vtype: col(props.id, 'vtype') }, valType, valParam, fresh);
  if (val !== undefined && !matches) return null;

  const matching = make.filter({
    id: fresh('f'), input: props, channels: [], type: props.type,
    pred: matches
      ? and(and(eq(col(props.id, owner), subject.id), eq(col(props.id, 'key'), compilerText(key))), matches)
      : and(eq(col(props.id, owner), subject.id), eq(col(props.id, 'key'), compilerText(key))),
  });
  const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
  return { kind: 'exists', plan: probe, negated: false };
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
function hasTokenClause(token: string, val: unknown, subject: Subject, elem: Elem, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null): Expr | null {
  const name = token.toLowerCase();
  if (name !== 'label' && name !== 'id') return null;
  if (val === undefined || containsTextSearch(val)) return null;

  if (name === 'id') {
    const cols = elem === 'edge' ? EDGE_COLS : NODE_COLS;
    const scan = make.scan({ id: fresh('ti'), table: elem === 'edge' ? 'edges' : 'nodes', alias: fresh('rti'), channels: [], type: typeOf(...cols) });
    const external: Expr = { kind: 'call', fn: 'COALESCE', args: [col(scan.id, 'uid'), col(scan.id, 'id')] };
    const matches = predicateExpr(external, val, SUBJECT_UNKNOWN, valType, valParam, fresh);
    if (!matches) return null;
    const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: and(eq(col(scan.id, 'id'), subject.id), matches) });
    const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return { kind: 'exists', plan: probe, negated: false };
  }

  const labels = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const matches = predicateExpr(col(labels.id, 'name'), val, SUBJECT_UNKNOWN, valType, valParam, fresh);
  if (!matches) return null;
  if (elem === 'edge') {
    // An edge's label is a COLUMN, so the join is against whichever expression carries it — the scan's
    // own where there is one, a correlated read of the edge row otherwise.
    const edges = make.scan({ id: fresh('eg'), table: 'edges', alias: fresh('re'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
    const joined = make.join({
      id: fresh('j'), left: edges, right: labels, join: 'inner', channels: [],
      type: typeOf(meta('id', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
      on: and(and(eq(col(edges.id, 'label'), col(labels.id, 'id')), eq(col(edges.id, 'id'), subject.id)), matches),
    });
    const probe = make.project({ id: fresh('p'), input: joined, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return { kind: 'exists', plan: probe, negated: false };
  }
  const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
  const joined = make.join({
    id: fresh('j'), left: vl, right: labels, join: 'inner', channels: [],
    type: typeOf(meta('node', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
    on: and(and(eq(col(vl.id, 'label'), col(labels.id, 'id')), eq(col(vl.id, 'node'), subject.id)), matches),
  });
  const probe = make.project({ id: fresh('p'), input: joined, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
  return { kind: 'exists', plan: probe, negated: false };
}

/**
 * `V(...)` / `E(...)` — the element source, and the same relation the legacy `seedSource` builds for
 * the same arguments: one row per element at bulk 1, narrowed by an id list bounded by the QUERY
 * TEXT (never by row count, so `InList` is right here and a JSON bind is not).
 *
 * Numeric args match the rowid and string args the user id, because the id-relation carries rowids
 * throughout and a `uid` match still projects the rowid. That asymmetry is the storage schema's,
 * which is why it lives at the one node that names a table.
 */
function elementScan(step: IRStep, fresh: Minter): { scan: Rel; pred?: Expr; elem: Elem } | null {
  const elem: Elem = step.name === 'E' ? 'edge' : 'vertex';
  // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
  // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal
  // SQL and silently resolve an outer correlation to the inner table.
  const scan = make.scan({
    id: fresh('src'), table: elem === 'edge' ? 'edges' : 'nodes', alias: elem === 'edge' ? 're' : 'rn', channels: [],
    type: typeOf(...(elem === 'edge' ? EDGE_COLS : NODE_COLS)),
  });

  const ids = flattenListArgs(argValues(step));
  const nums = ids.filter((a): a is number => typeof a === 'number');
  const strs = ids.filter((a): a is string => typeof a === 'string');
  // An id argument that is neither is a hard error in the legacy spine too, but this route must
  // not THROW on a shape it merely has not learned — declining routes it to the spine that owns
  // the message.
  if (ids.length !== nums.length + strs.length) return null;

  const clauses: Expr[] = [];
  // Ids are parsed integer/string literals bounded by the QUERY TEXT — inline them (a rowid `int`, a
  // uid `text`); `constLit` never declines a number/string, so the assertion cannot fire.
  if (nums.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'id'), values: nums.map((n) => constLit(arg(n, 'long'))!) });
  if (strs.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'uid'), values: strs.map((s) => compilerText(s)) });
  const pred = clauses.reduce<Expr | undefined>((left, right) =>
    left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
  return { scan, pred, elem };
}

/**
 * MOVEMENT — the graph algebra proper, as a join over `edges` and a re-projection.
 *
 * Six adjacency steps plus the three endpoint reads, each one direction table entry: which edge
 * column matches the incoming id, and which column the outgoing id comes from. `both`/`bothE`/
 * `bothV` are the UNION of their two halves and get no special case beyond being two entries — the
 * multiset rule means UNION ALL, so a self-loop legitimately yields the vertex twice.
 *
 * `otherV` is absent, and deliberately: it reads the entering vertex a preceding edge step
 * retained (`fromV`), which is carried state this route does not yet model. Declining is the whole
 * contract — a movement that quietly forgot which end it came from is a wrong answer.
 */
interface Hop { readonly from: 'src' | 'tgt' | 'id'; readonly to: 'src' | 'tgt' | 'id'; readonly elem: Elem; }
const HOPS: Readonly<Record<string, readonly Hop[]>> = {
  out: [{ from: 'src', to: 'tgt', elem: 'vertex' }],
  in: [{ from: 'tgt', to: 'src', elem: 'vertex' }],
  both: [{ from: 'src', to: 'tgt', elem: 'vertex' }, { from: 'tgt', to: 'src', elem: 'vertex' }],
  outE: [{ from: 'src', to: 'id', elem: 'edge' }],
  inE: [{ from: 'tgt', to: 'id', elem: 'edge' }],
  bothE: [{ from: 'src', to: 'id', elem: 'edge' }, { from: 'tgt', to: 'id', elem: 'edge' }],
  inV: [{ from: 'id', to: 'tgt', elem: 'vertex' }],
  outV: [{ from: 'id', to: 'src', elem: 'vertex' }],
  bothV: [{ from: 'id', to: 'src', elem: 'vertex' }, { from: 'id', to: 'tgt', elem: 'vertex' }],
};

/** Steps whose input must already be an edge (`inV`/`outV`/`bothV`) vs a vertex. Mis-applying one
 *  is a hard error in the legacy spine; here it is a decline, so that spine keeps owning the
 *  message rather than this route inventing a second one. */
const FROM_EDGE = new Set(['inV', 'outV', 'bothV']);

/**
 * Where a hop starts from: an incoming id-RELATION (the ordinary case, joined) or a single
 * correlated id EXPRESSION (a child body's first hop, compared).
 *
 * The correlated form is what lets a `where()` body be lowered with no seed node at all. The legacy
 * spine writes `(SELECT n.id AS id) p` — a projection with no input, which RelIR has no node for —
 * and §7's bar says a missing node needs proof the seam cannot EXPRESS the shape. It can: compare
 * the edge column to the outer expression directly, which is one derived table FEWER than the form
 * it replaces. Both arms produce the same `(id, bulk)` shape, so every hop after the first is the
 * ordinary one and there is no second movement implementation.
 */
type Frontier = { readonly rel: Rel } | { readonly correlated: Expr };
const frontierRel = (from: Frontier): Rel | undefined => ('rel' in from ? from.rel : undefined);

function movement(step: IRStep, from: Frontier, elem: Elem, fresh: Minter): { rel: Rel; elem: Elem } | null {
  const hops = HOPS[step.name];
  if (!hops || step.modulators?.length || step.optionArms) return null;
  if (FROM_EDGE.has(step.name) !== (elem === 'edge')) return null;

  const labels = flattenListArgs(argValues(step));
  if (labels.some((l) => typeof l !== 'string')) return null;
  // A label restriction is meaningless on an endpoint read — the edge is already chosen — and
  // TinkerPop's inV()/outV() take no arguments at all.
  if (labels.length && FROM_EDGE.has(step.name)) return null;

  const input = frontierRel(from);
  // WHAT THE HOP CARRIES is its input's channels, read off the frontier rather than off a
  // chain-global flag. Only a ROOTED hop carries anything at all: a correlated one lives inside an
  // `EXISTS`, which asks whether a row is there and never in what order — so its `bulk` is synthetic
  // and it carries no position.
  const carried = input ? input.channels : BULK;
  const armCols = elementCols(carried);
  const arms = hops.map((hop) => {
    const e = make.scan({
      id: fresh('mv'), table: 'edges', alias: fresh('rme'), channels: [],
      type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    });
    const incoming = input ? col(input.id, 'id') : (from as { readonly correlated: Expr }).correlated;
    const on = labels.length
      ? and(eq(col(e.id, hop.from), incoming),
        { kind: 'in-query', expr: col(e.id, 'label'), plan: labelIds(labels as string[], fresh), negated: false })
      : eq(col(e.id, hop.from), incoming);
    // A correlated hop FILTERS the edge table against the outer id; a rooted one JOINS the incoming
    // frontier, `edges` on the LEFT — the join order the legacy spine emits, so the access path
    // stays the one the covering indexes were built for. The projection is identical either way,
    // which is what keeps the second hop from needing a second implementation. A correlated body's
    // `bulk` is synthetic: an EXISTS asks whether a row is there, never how many traversers it is.
    const source = input
      ? make.join({
        id: fresh('j'), left: e, right: input, join: 'inner', on, channels: carried,
        type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int'), meta('pid', 'int'),
          ...carriedCols(carried)),
      })
      : make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: on });
    // The arm carries the INCOMING position through unchanged; re-minting happens once over the
    // whole fan-out below, not per arm — two arms each numbering from 1 would interleave.
    return make.project({
      id: fresh('m'), input: source, channels: carried, type: typeOf(...armCols),
      exprs: [['id', col(source.id, hop.to)],
        ...(input
          ? carried.map((channel) => [channel.col, col(source.id, channel.col)] as const)
          : [['bulk', compilerInt(1)] as const])],
    });
  });
  const [first, ...rest] = arms;
  if (!first) return null;
  // N-ary UNION ALL, minted once — and ALL, never distinct: traversers are a multiset, so a vertex
  // reachable both ways is two traversers.
  let fanned: Rel = rest.length
    ? make.union({ id: fresh('u'), inputs: arms, all: true, channels: carried, type: typeOf(...armCols) })
    : first;
  if (pathCarried(fanned))
    fanned = extendPath(fanned, { kind: 'element', elem: hops[0]!.elem, id: col(fanned.id, 'id') }, fresh);
  const encounter = encounterOf(carried);
  return { rel: encounter ? remintOrder(fanned, encounter, fresh) : fanned, elem: hops[0]!.elem };
}

/**
 * THE ROW-ALGEBRAIC CLASS over an element relation — Phase 4.1, and only the part of it that is a
 * relation operator rather than a framing one.
 *
 * `dedup()` is `Distinct` over a projection that RESETS the multiplicity: collapsing duplicates
 * means the survivor is one traverser, not the sum of the ones it stood for. `identity()` is the
 * universal no-op and is here rather than nowhere because it composes — a chain is not less covered
 * for containing one.
 *
 * `order()` IS here, and as a MINT of the emission-order channel rather than as anything new (see
 * `elementOrder`). `tail`/`sample` are still absent: `tail` reads the order BACKWARDS and `sample`
 * has no stable position at all, so each is its own increment rather than one blanket "not yet".
 */
/**
 * `limit`/`skip`/`range` over ANY relation that carries an emission order — element or scalar, which
 * is why it is its own function rather than an arm of the element fold. What it needs is not a
 * SHAPE but a channel: a window is only a window if there is an order to take it from.
 *
 * A relation with no order still slices where the order cannot matter — after `count()`, whose one
 * row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question. Legacy emits the bare `LIMIT`
 * there and this matches it, because emitting a sort over a single row would be a difference in
 * the plan for no difference in the answer.
 */
function sliceOp(step: IRStep, input: Rel, bulked: boolean, fresh: Minter): Rel | null {
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return null;
  if (!SLICE_STEPS.has(step.name)) return null;
  const encounter = encounterOf(input.channels);
  const bulk = input.channels.find((channel) => channel.role === 'bulk');

  // `sample(n)` is n traversers chosen UNIFORMLY — `SampleGlobalStep` is a weighted reservoir sample
  // whose weights come from a `by()`, and with no modulator every weight is 1. Rank once in a window
  // over RANDOM(), then FILTER the chosen ranks: a Sort(RANDOM()) -> Limit(n) can be fused so SQLite
  // re-evaluates RANDOM() for each outer candidate and returns the wrong cardinality. Filtering also
  // preserves the INPUT order of the survivors, matching CollectingBarrierStep's insertion-order
  // drain; the old claim that the root restored a carried position was false because `sample` is not
  // a positional consumer. A `by()` declines through the blanket modulator gate above.
  //
  // Over a COLLAPSED relation it declines rather than sampling: a uniform sample of ROWS is not a
  // uniform sample of traversers when a row stands for N of them, and there is no trimming to do —
  // sample has no band, so `bulkSlice` has nothing to say about it.
  if (step.name === 'sample') {
    if (bulked) return null;
    const rank = 'sample_rank';
    const ranked = make.window({
      id: fresh('sw'), input, channels: input.channels,
      type: typeOf(...input.type.cols, meta(rank, 'int')),
      specs: [[rank, {
        kind: 'window-expr', fn: 'row_number', args: [],
        spec: {
          partitionBy: [],
          orderBy: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }],
        },
      }]],
    });
    // The filter reads a column computed by the window's block, so fence it rather than letting the
    // assembler inline and re-evaluate the RANDOM() expression at the clause-reader boundary.
    const frame = make.materialize({
      id: fresh('sm'), input: ranked, channels: ranked.channels, type: ranked.type,
    });
    const sampled = make.filter({
      id: fresh('sf'), input: frame, channels: frame.channels, type: frame.type,
      pred: { kind: 'binary', op: '<=', left: col(frame.id, rank), right: countLit(countArg(step)) },
    });
    return make.project({
      id: fresh('sp'), input: sampled, channels: input.channels, type: input.type,
      exprs: input.type.cols.map((column) => [column.name, col(sampled.id, column.name)] as const),
    });
  }

  // `tail(n)` is `limit(n)` read from the FAR END, so it is the direction flag on the shared slice
  // rather than a fourth builder — and it is the one window `sliceOf` will not decode, because "the
  // last n" is an offset only once something supplies the member count. Nothing has to: read the
  // relation backwards and the count never appears.
  //
  // It NEEDS a carried position, and that is not a limitation to work around — "last" is a question
  // ABOUT emission order, so a relation carrying none has no last. Declining hands it to the spine
  // that owns the message.
  if (step.name === 'tail') {
    if (!encounter) return null;
    const last = { offset: 0, limit: countArg(step) };
    if (bulked && bulk) return bulkSlice(input, last, encounter, bulk, 'desc', fresh);
    return slice(input, last, encounter, 'desc', fresh);
  }

  // `sliceOf` REJECTS an illegal range (`range(2,1)`) by throwing, which is right where it is the
  // only answer available — but this module's contract is that `null` is its only decline, and a
  // throw from here would mean the RelIR route raising an error the legacy spine has not reached
  // yet. Declining hands the traversal to the spine that owns the message, which raises the
  // identical one. Found by sweeping every prefix of every corpus traversal under all four switch
  // combinations, which is the only way a decline-contract violation shows up at all.
  let window;
  try { window = sliceOf(step); } catch { return null; }
  // A COLLAPSED relation's row stands for `bulk` traversers, so `LIMIT n` would take n ROWS and
  // answer a different question. `bulked` says the multiplicity is not provably 1, and then the
  // slice must count traversers — which needs a position to accumulate along, so a bulked relation
  // with no emission order declines rather than guessing one. The band arithmetic there computes on
  // the count, so a parameter REDUCES (bulkSlice reads the numbers, not `paramOf`), the same last
  // responsible moment `range` reduces at.
  if (bulked && bulk) return encounter ? bulkSlice(input, window, encounter, bulk, 'asc', fresh) : null;
  return slice(input, { ...window, ...paramOf(step) }, encounter, 'asc', fresh);
}

/** Which slice bound, if any, carries a user PARAMETER that binds untouched. Only `limit` (its count)
 *  and `skip` (its offset) qualify — a single value SQL takes as a plain `?`. `range` reduces (its
 *  count is `hi−lo` and its `lo>hi` throws), so it maps to nothing here and inlines via `sliceOf`. */
const paramOf = (step: IRStep): { limitParam?: string | null; offsetParam?: string | null } =>
  step.name === 'limit' ? { limitParam: sliceParamNames(step)[0] ?? null }
  : step.name === 'skip' ? { offsetParam: sliceParamNames(step)[0] ?? null }
  : {};

/** The row slice steps this fold serves. `tail` and `sample` are here as DIRECTIONS and a shuffle on
 *  the same op rather than as separate arms, which is what `globalRowOps` says with its own three
 *  handlers over one `reprojectRows`. */
const SLICE_STEPS = new Set(['limit', 'skip', 'range', 'tail', 'sample']);

/** `tail(n)`/`sample(n)`'s count. Both default to 1, and neither takes a range, so the numeric
 *  argument is the whole decode — `sliceOf` deliberately refuses `tail` (see `sliceOp`). */
const countArg = (step: IRStep): number =>
  Number(argValues(step).find((v) => typeof v === 'number') ?? 1);

/** `ORDER BY <position> [DESC] LIMIT/OFFSET` — the plain slice, where a row IS one traverser. An
 *  unordered relation stays unordered rather than inventing a SQLite scan order: a slice with no
 *  position to take a window from only reaches here where the order cannot matter (after `count()`,
 *  whose one row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question). */
function slice(
  input: Rel,
  window: { readonly offset: number; readonly limit: number | null; readonly offsetParam?: string | null; readonly limitParam?: string | null },
  encounter: Channel | undefined, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  const source = encounter
    ? make.sort({
      id: fresh('so'), input, channels: input.channels, type: input.type,
      terms: [{ expr: col(input.id, encounter.col), dir }],
    })
    : input;
  // A `limit($x)`/`skip($x)` count is a user PARAMETER and binds untouched; a parsed literal inlines
  // (`sliceBound`). The offset is emitted for a nonzero literal OR any parameter (a `skip($x)` where
  // `$x` happens to resolve to 0 still binds, so the plan is one cached statement over every offset).
  return make.limit({
    id: fresh('li'), input: source, channels: input.channels, type: input.type,
    ...(window.limit === null ? {} : { count: sliceBound(window.limit, window.limitParam ?? null) }),
    ...(window.offset || window.offsetParam != null ? { offset: sliceBound(window.offset, window.offsetParam ?? null) } : {}),
  });
}

/**
 * A SLICE THAT COUNTS TRAVERSERS — the cumulative-bulk window, and the composition that makes
 * element `order()` safe to cover at all.
 *
 * Under `movementCollapse` a row is an (element, N) pair, so the traverser a slice's boundary falls
 * inside is a row whose multiplicity must be TRIMMED rather than taken or dropped whole. A running
 * `SUM(bulk)` over the emission order gives each row the index one past its last traverser (`cum`),
 * so the row covers the half-open band `[cum - bulk, cum)`; the slice keeps the rows whose band
 * intersects `[offset, offset + limit)` and re-projects `bulk` as the width of the intersection.
 *
 * Legacy hand-rolls exactly this shape in the element FRAMING projection (`buildProjection`'s
 * bulk-aware limit/range), where it can only happen once and only at the end. Here it is four
 * ordinary nodes over any relation carrying a multiplicity and a position — which is why it serves
 * the element fold and the scalar tail from one place, and why `order().limit()` composes rather
 * than being a shape the framing layer has to recognise.
 *
 * The frame is explicit (`ROWS UNBOUNDED PRECEDING … CURRENT ROW`) rather than left to SQLite's
 * default: over a total order the default `RANGE` form agrees, but the emission order is only total
 * because the mint tie-broke it, and a window whose correctness depends on a caller's tie-break
 * argument is the kind of thing that goes wrong silently when the caller changes.
 */
function bulkSlice(
  input: Rel, window: { readonly offset: number; readonly limit: number | null },
  encounter: Channel, bulk: Channel, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  const lo = window.offset;
  const hi = window.limit === null ? null : lo + window.limit;
  const running = make.window({
    id: fresh('bw'), input, channels: input.channels,
    type: typeOf(...input.type.cols, meta('cum', 'int')),
    specs: [['cum', {
      kind: 'window-expr', fn: 'sum', args: [col(input.id, bulk.col)],
      spec: {
        // The direction is the whole of `tail(n)`: accumulate BACKWARDS and the band `[0, n)` is the
        // last n traversers instead of the first. The rows keep their positions either way, so the
        // root's `ORDER BY <position>` still reports them in emission order.
        partitionBy: [], orderBy: [{ expr: col(input.id, encounter.col), dir }],
        frame: { mode: 'rows', start: { kind: 'unbounded-preceding' }, end: { kind: 'current-row' } },
      },
    }]],
  });
  // Each node addresses its own INPUT's columns, so the band is spelled twice against two relations
  // rather than once against a relation that is out of scope where it is read.
  const band = (rel: Rel): { readonly first: Expr; readonly past: Expr } =>
    ({ first: { kind: 'binary', op: '-', left: col(rel.id, 'cum'), right: col(rel.id, bulk.col) }, past: col(rel.id, 'cum') });
  const inner = band(running);
  const kept = make.filter({
    id: fresh('bf'), input: running, channels: running.channels, type: running.type,
    pred: and(
      { kind: 'binary', op: '>', left: inner.past, right: countLit(lo) },
      hi === null ? undefined : { kind: 'binary', op: '<', left: inner.first, right: countLit(hi) },
    ),
  });
  const outer = band(kept);
  const from: Expr = lo ? { kind: 'call', fn: 'MAX', args: [outer.first, countLit(lo)] } : outer.first;
  const to: Expr = hi === null ? outer.past : { kind: 'call', fn: 'MIN', args: [outer.past, countLit(hi)] };
  return make.project({
    id: fresh('bs'), input: kept, channels: input.channels, type: input.type,
    exprs: input.type.cols.map((column) => [column.name, column.name === bulk.col
      ? { kind: 'binary', op: '-', left: to, right: from } as Expr
      : col(kept.id, column.name)] as const),
  });
}

function rowOp(step: IRStep, input: Rel, elem: Elem, bulked: boolean, ctx: ChainCtx, fresh: Minter): Rel | null {
  if (step.optionArms) return null;
  if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;
  if (step.name === 'order') return elementOrder(step, input, elem, ctx, fresh);
  const sliced = sliceOp(step, input, bulked, fresh);
  if (sliced) return sliced;
  if (step.name === 'dedup' && pathCarried(input)) return null;

  if (step.name !== 'dedup' || (step.args ?? []).length || isLocalScope(step)) return null;
  // A BARE `dedup()` is a grouping by traverser IDENTITY, so the channel policy table decides whether
  // it may carry what the relation carries — and an ALIAS binding belongs to ONE of the merged rows.
  // Keeping it in the key would distinguish two traversers reaching the same element by the label they
  // bound on the way, which is a different multiset; taking an arbitrary one is the `undefined` the
  // table names. Legacy refuses the same shape for the same reason (`dedup() after as() not yet
  // supported (path-distinct semantics)`), so declining keeps the two spines agreeing rather than
  // giving RelIR a capability the differential would then be red against. The honest lowering is a
  // ranked window over the identity partition (`dedupBy`'s shape with the id as its key), which is a
  // separate increment landing in BOTH spines.
  if (!groupableChannels(input.channels)) return null;

  const ordered = !!encounterOf(input.channels);
  const bys = modulations(step, 1, childSeam(ctx, fresh));
  if (!bys) return null;
  if (bys[0]) return dedupBy(step, bys[0], input, elem, ctx, fresh);

  // `dedup()` RESETS the multiplicity: the survivor stands for itself, not for the sum of the
  // duplicates it replaced.
  //
  // Under an emission order it stops being a `Distinct` at all, and the reason is semantic rather
  // than mechanical: the survivor must keep the FIRST occurrence's position, so the step is a
  // GROUPING by traverser identity that takes `MIN(encounter)`. That is the per-traverser reduction
  // the channel core's third policy table (`CHANNEL_GROUP_POLICY`) exists to permit — a grouping
  // may carry a role only where N-rows-into-one has a defined answer, which `bulk` and `encounter`
  // have and an alias, a path or a sack do not.
  if (!ordered) {
    const projected = make.project({
      id: fresh('dd'), input, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
      exprs: [['id', col(input.id, 'id')], ['bulk', compilerInt(1)]],
    });
    return make.distinct({ id: fresh('d'), input: projected, channels: BULK, type: projected.type });
  }
  return make.aggregate({
    id: fresh('dd'), input, channels: input.channels, type: typeOf(...elementCols(input.channels)),
    groupBy: [col(input.id, 'id')],
    aggs: [['bulk', compilerInt(1)], ['encounter', { kind: 'agg', fn: 'min', args: [col(input.id, 'encounter')] }]],
  });
}

/**
 * `dedup().by(<projection>)` over an ELEMENT relation — the first host to take a real `by()`.
 *
 * It is a `Window` + `Filter`, not a grouped aggregate, and the difference is the reason: the survivor
 * is the one traverser with the LOWEST id per key, and every other column must be ITS values — an
 * `Aggregate` can produce `MIN(id)` but not "the encounter belonging to the row that had it". That is
 * what a ranked window says and an aggregate cannot, so this is the shape legacy emits too.
 *
 * PRODUCTIVITY is the vocabulary's, not this host's: TinkerPop drops a traverser whose `by()` yielded
 * nothing (`DedupGlobalStep.filter` → `product.isProductive()`), and `ProductiveByStrategy` turns that
 * off. `productivityFilter` returns the predicate or `undefined`, so the rule cannot be forgotten here.
 *
 * **`bulk` RESETS to 1, which is the reference's rule and NOT the spelling legacy uses.** TinkerPop's
 * `DedupGlobalStep.filter` calls `traverser.setBulk(1L)` unconditionally — before it even looks at the
 * `by()` — so a survivor stands for itself whether or not a projection was given
 * (`vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:75`). Legacy carries `p.bulk` through
 * instead, and the two are NOT observably different: `analyzeChain`'s collapse-safety rule excludes a
 * `dedup` that has modulators, so `movementCollapse` never fires upstream of one and the multiplicity
 * is provably 1 where it arrives. Checked, not assumed — `g.V().both().both().dedup().by('lang')`
 * emits no `GROUP BY` on either spine. So this is not a divergence to reconcile; it is the form that
 * stays correct if that safety rule is ever relaxed, at no cost today.
 */
function dedupBy(
  step: IRStep, modulation: Modulation, input: Rel, elem: Elem, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  // A comparator on `dedup()` is not a form Gremlin has — `DedupGlobalStep` is not a comparator host —
  // so an `Order` in its `by()` is a chain `verifyByModulatorArity` never sees. Decline rather than
  // silently ignoring it.
  if (modulation.order !== undefined) return null;
  const key = byExpr(modulation, { kind: 'element', id: col(input.id, 'id'), elem }, fresh, false, childSeam(ctx, fresh));
  if (!key) return null;

  const productive = productivityFilter(step, key);
  const domain = productive
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: productive })
    : input;
  const cols = elementCols(input.channels);
  // WHICH traverser survives is the EMISSION-ORDER question, not an id question. TinkerPop keeps the
  // FIRST occurrence, so the rank orders by the carried position where there is one and falls back to
  // the element id where there is not — which is the only order a positionless relation has, and the
  // one legacy uses there too (`ORDER BY <orderSql>, p.id`). Ranking by id alone was right only while
  // nothing could mint a position: `g.V().order().by('name',desc).dedup().by('age')` then kept the
  // lowest-id member of each age instead of the first in the sorted stream — the same rows, a
  // different member, which the census's multiset digest DID see (it is a different set) but no
  // assertion in the ladder named.
  const position = encounterOf(domain.channels);
  const ranked = make.window({
    id: fresh('dw'), input: domain, channels: domain.channels, type: typeOf(...cols, meta('rn', 'int')),
    specs: [['rn', {
      kind: 'window-expr', fn: 'row_number', args: [],
      // The element id is always the last term, so the rank is DETERMINISTIC rather than merely
      // ordered — the property `mise run test:perturbed` checks.
      spec: {
        partitionBy: [key],
        orderBy: [...(position ? [{ expr: col(domain.id, position.col), dir: 'asc' as const }] : []),
          { expr: col(domain.id, 'id'), dir: 'asc' as const }],
      },
    }]],
  });
  const survivors = make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: eq(col(ranked.id, 'rn'), compilerInt(1)),
  });
  return make.project({
    id: fresh('dk'), input: survivors, channels: input.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name,
      column.name === 'bulk' ? compilerInt(1) : col(survivors.id, column.name)] as const),
  });
}

/** The fan-out re-mint: renumber by the incoming position, tie-broken on the element id so rows
 *  that shared one incoming traverser get a deterministic order rather than SQLite's. */
const remintOrder = (rel: Rel, encounter: Channel, fresh: Minter): Rel => renumber(
  rel,
  [{ expr: col(rel.id, encounter.col), dir: 'asc' }, { expr: col(rel.id, 'id'), dir: 'asc' }],
  elementCols(rel.channels), rel.channels, fresh,
);

/**
 * ELEMENT `order()` — a MINT of the emission-order channel, and the step the model change was for.
 *
 * There is no new machinery, which is the point: an element relation's order IS the `encounter`
 * channel, and the element materialization already emits `ORDER BY p.encounter` whenever that
 * channel is live — so the whole of `order()` is "renumber by the sort key", the same `renumber` the
 * fan-out re-mint and scalar `order()` already share. `analyzeChain` reports `demandsEncounter`
 * FALSE for these chains (legacy folds the order into the framing clause and needs no channel at
 * all), so the source seeded nothing and this MINTS one — the case a chain-global boolean threaded
 * from the source structurally could not express.
 *
 * Two tie-breaks, and which applies is semantic rather than incidental. Re-minting over a carried
 * position tie-breaks on THAT position, which is what makes the sort STABLE (legacy's
 * `partitionedOrder` says the same). Minting from nothing has no arriving position to be stable
 * against, so it tie-breaks on the element id — deterministic rather than "whichever row SQLite
 * produced first", which is the defect `mise run test:perturbed` exists to find.
 *
 * **NOT a `Sort` of the core relation with the framing on top:** a JOIN's output order is
 * unspecified, so the framing join may return sorted rows in any order — and on a six-vertex
 * fixture it will reliably return the flattering one, which no assertion in the ladder would catch.
 * Minting the channel is what makes the order survive the join, and it is also what makes `order()`
 * COMPOSE: a fold into the framing `ORDER BY` can only happen once, at the end.
 */
function elementOrder(step: IRStep, input: Rel, elem: Elem, ctx: ChainCtx, fresh: Minter): Rel | null {
  const sort = sortTerms(step, { kind: 'element', id: col(input.id, 'id'), elem }, ctx, fresh);
  if (!sort) return null;
  const domain = sort.drop
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: sort.drop })
    : input;
  const carried = encounterOf(domain.channels);
  const channels = carried ? domain.channels : withChannel(domain.channels, ENCOUNTER);
  const tie = col(domain.id, carried ? carried.col : 'id');
  return renumber(domain, [...sort.terms, { expr: tie, dir: 'asc' }], elementCols(channels), channels, fresh);
}

/**
 * The convergent-walk COLLAPSE: `SELECT id, SUM(bulk) … GROUP BY id`, so the frontier stays bounded
 * by reachable |V| instead of by the (exponential) walk count.
 *
 * It is the `movementCollapse` fast path, expressed IN the algebra rather than beside it — which
 * is legitimate where the FTS one was not, and the difference is worth stating. Routing a substring
 * predicate through a base-table scan would have LOST an index seek the legacy spine performs;
 * here the specialized form is a plan rewrite RelIR can state exactly, so expressing it keeps the
 * optimization AND keeps the switch meaningful: `fastPaths.movementCollapse` still selects between
 * two forms, so L5's differential still has two positions to compare on a RelIR-routed traversal.
 * Reading the flag here does NOT make spine choice depend on it — coverage is unchanged either way.
 *
 * `isReEncoding` (src/rel/obligations.ts) is what lets the result keep carrying `bulk`: this is a
 * re-encoding of the same traverser multiset, not a barrier.
 *
 * **COLLAPSE AND AN EMISSION ORDER ARE MUTUALLY EXCLUSIVE**, and the caller asks the RELATION rather
 * than a chain-global flag: a collapse merges convergent walks by discarding which one arrived, which
 * is exactly the per-row identity a position IS. `analyzeChain` folds the seeded case in
 * (`collapseSafe && !demandsEncounter`), but an element `order()` MINTS a position mid-chain on a
 * chain analyze reports as demanding none — so the law has to be stated where the position is
 * visible, not where the chain is.
 */
const coalesce = (rel: Rel, fresh: Minter): Rel =>
  make.aggregate({
    id: fresh('cl'), input: rel, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    groupBy: [col(rel.id, 'id')],
    aggs: [['bulk', { kind: 'agg', fn: 'sum', args: [col(rel.id, 'bulk')] }]],
  });

/**
 * `count()` is the RLE TRAVERSER total, and which expression that is depends on whether the relation
 * carries a multiplicity at all.
 *
 * With a `bulk` channel it is `SUM(bulk)` — a collapse merged convergent walks into (row, N) pairs,
 * so counting rows would count the collapse away. Without one (an `inject()` source has no
 * multiplicity: each row is one traverser by construction) it is `COUNT(*)`, which is what legacy
 * emits there. Reading the CHANNEL rather than the step name is what keeps the two in step.
 */
function countExpr(input: Rel): Expr {
  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  return bulk
    ? { kind: 'call', fn: 'COALESCE', args: [{ kind: 'agg', fn: 'sum', args: [col(input.id, bulk.col)] }, compilerInt(0)] }
    : { kind: 'agg', fn: 'count', args: [] };
}

/** `count()` as a RETYPE, shared by every host that has one — the element tail's terminal and the path tail's
 *  own arm, so the two cannot disagree about whether the answer is `SUM(bulk)` or `COUNT(*)` (that question is
 *  `countExpr`'s, and it reads the CHANNEL). A reducing aggregate is a BARRIER: no channel survives it (§3.5),
 *  which is why `channels` is empty rather than trimmed by hand. */
const countTail = (input: Rel, fresh: Minter): { rel: Rel; framing: RelFraming } => ({
  rel: make.aggregate({
    id: fresh('agg'), input, channels: [], type: typeOf(meta('v', 'int')),
    groupBy: [], aggs: [['v', countExpr(input)]],
  }),
  framing: { kind: 'scalar', type: STATIC('long'), result: 'count' },
});

/**
 * A TERMINAL that retypes the element relation into another shape — the SHAPE BOUNDARY, and the
 * substrate every scalar-valued step then rides on.
 *
 * `null` declines, as everywhere here. What makes this the boundary rather than one more step is
 * that both arms change the STREAM KIND: everything before produces elements and frames as the
 * element payload, and these produce one scalar per row and frame through the value projection.
 */
function terminal(step: IRStep, input: Rel, elem: Elem, fresh: Minter): { readonly rel: Rel; readonly framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);

  // count() is the RLE traverser TOTAL, not the row count: a collapse merges convergent walks into
  // (row, N) pairs, so the answer is SUM(bulk) — identical to COUNT(*) only while bulk is 1
  // everywhere. Reading it off the carried channel rather than off the step is what keeps the two
  // in step when movement lands.
  if (step.name === 'count') {
    if (args.length) return null;
    return countTail(input, fresh);
  }

  // `constant(c)` REPLACES the traverser's value with a literal, which over an element stream is a
  // shape boundary like `values()` and `count()` — the element is gone and a value is in its place.
  // The channels ride through untouched: a constant changes the VALUE, not the traverser.
  if (step.name === 'constant') {
    const [, extra] = args;
    if (extra !== undefined) return null;
    const literal = constLit(step.args[0]);
    const tail = literal ? null : exactTailConst(step.args[0]);
    if (!literal && !tail) return null;
    return {
      rel: make.project({
        id: fresh('ct'), input, channels: input.channels,
        type: typeOf(meta('v', 'any', true), ...carriedCols(input.channels)),
        exprs: [['v', literal ?? tail!.expr], ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
      }),
      // UNKNOWN for an untyped constant, not a tag inferred from the JS value: that is what legacy frames
      // here, and a compile-time tag would be a claim the argument's declared type does not support. An
      // EXACT TAIL is the exception — its declared type IS known, so it frames STATIC(type, text) so a
      // following ordering compare can cast it (C1).
      framing: { kind: 'scalar', type: tail ? STATIC(tail.tag as never, true) : UNKNOWN },
    };
  }

  if (step.name === 'values') {
    // TinkerPop's `PropertiesStep` is `element.properties(keys)`: no keys means EVERY key, several
    // mean membership in the set. A non-string key is a decline rather than a guess — answering
    // "every key" for one would be answering a different question.
    const keys = args.filter((a): a is string => typeof a === 'string');
    if (keys.length !== args.length) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying
    // the row is the answer rather than the bug it would be in a filter.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      // The key set is bounded by the QUERY TEXT, never by row count, so an `InList` is right here
      // and a JSON bind is not (root CLAUDE.md's rule is about data-sized sets).
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keys.length
        ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map((k) => compilerText(k)) }
        : undefined),
    });
    return {
      rel: make.project({
        id: fresh('sv'), input: joined, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)),
        exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')],
          ...input.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
      }),
      // The value's Gremlin type is PER ROW, off the stored `vtype` column — one compile-time tag
      // would be a lie for an untyped property key.
      framing: { kind: 'scalar', type: PER_ROW('vtype') },
    };
  }

  return null;
}

/** The tail steps that read the traverser's value from a clause SQL cannot alias into — a `WHERE`
 *  or an `ORDER BY`. What they have in common is the bind wall, and the remedy, both in `scalarTail`. */
const CLAUSE_READERS = new Set(['is', 'order']);

/** The tail steps that HOST a `by()` (`BY_HOSTS` ∩ this fold's vocabulary). Named rather than checked
 *  inline because the blanket `step.modulators?.length` decline must exempt exactly these — a host
 *  added to the fold without being added here silently loses its modulator, which is the failure mode
 *  the modulator seam exists to end. */
const BY_READERS = new Set(['order', 'dedup']);

/**
 * An `order()`'s sort terms over any host, or `null` to decline.
 *
 * Scalar `order()` IS a relation operator, and that is what separates it from the element one: over
 * values legacy emits `SELECT p.v FROM c0 p ORDER BY p.v ASC` — a `Sort` in the algebra, exactly —
 * whereas over elements it folds the order into the FRAMING projection, which is `TailAcc`'s and
 * Phase 4.2's. Same step name, two different layers, and only one of them is here today; the host
 * parameter is what will let the other one in without a second parse.
 *
 * `by()` is READ, not declined, and the whole of it lives in `modulator.ts`: which value to sort on
 * and which direction, with the ordering flag asking for the vtype-aware compare key — the same
 * authority the range predicates use, because comparing and sorting are the same question. `shuffle`
 * is the one term with no subject at all: `RANDOM()` re-evaluates per row and that IS the semantics,
 * so it is a `Call` rather than a projection, and the census sees it through the multiset digest only.
 */
function sortTerms(
  step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter,
): { readonly terms: readonly SortTerm[]; readonly drop?: Expr } | null {
  if (isLocalScope(step) || (step.args ?? []).length) return null;
  // EVERY slot: TinkerPop's `order()` takes a comparator per key, so `by('performances',desc).by('name')`
  // is a two-term sort and the number of slots is whatever the chain wrote. `SortTerm[]` was always a
  // LIST, so a multi-key order is the same lowering — taking only the first would have sorted by the
  // wrong thing where the first key ties, which is a wrong ORDER with the right multiset.
  const bys = modulations(step, (step.modulators ?? []).length, childSeam(ctx, fresh));
  if (!bys) return null;
  const parsed: readonly Modulation[] = bys.length ? bys : [{ key: { kind: 'identity' } }];
  // `shuffle` has no subject at all — `RANDOM()` re-evaluates per row and that IS the semantics — so it
  // is the whole order or none of it. Mixed with a real key it is a form legacy refuses too, and a
  // lowering that dropped the shuffle would silently answer a deterministic order.
  if (parsed.some((modulation) => modulation.order === 'shuffle'))
    return parsed.length === 1 ? { terms: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }] } : null;

  const terms: SortTerm[] = [];
  // PRODUCTIVITY rides with the terms rather than being each host's to remember: a traverser whose
  // `by('age')` yielded nothing is DROPPED, so `g.V().order().by('age')` is four rows on the modern
  // graph and not six. A forgotten drop is a wrong answer with the right arity, and it sorts the
  // extra rows FIRST (SQLite orders NULL low), which the census's multiset digest cannot see. With
  // several terms each KEY term owes one, conjoined — the same thing legacy's `orderProductivityFilter`
  // does over its whole clause list.
  const drops: Expr[] = [];
  for (const modulation of parsed) {
    const key = byExpr(modulation, host, fresh, true, childSeam(ctx, fresh));
    if (!key) return null;
    terms.push({ expr: key, dir: modulation.order === 'desc' ? 'desc' : 'asc' });
    const drop = orderProductivity(step, modulation, key);
    if (drop) drops.push(drop);
  }
  const drop = drops.reduce<Expr | undefined>((left, right) => (left ? and(left, right) : right), undefined);
  return drop ? { terms, drop } : { terms };
}

/**
 * THE SCALAR TAIL — the vocabulary above a one-value-per-row relation, wherever that relation came
 * from. `values()`/`count()` retyping an element stream and `inject()` seeding one both land here,
 * which is why it is a function and not two inline folds.
 *
 * `is(P)` uses the SAME predicate module the source filters use, over the scalar's own `v`. A slice
 * uses the same `sliceOp` as the element fold. `dedup()` is `Distinct` over the whole row — which
 * for a scalar IS the value. `count()` reduces to a long, reading the multiplicity off the CHANNEL
 * rather than assuming one exists.
 *
 * Every fact about the current relation — its columns, its channels, whether a per-row `vtype` is in
 * scope — is READ OFF `rel` rather than tracked beside it. Two accumulator variables used to shadow
 * them, and a step that reshaped the relation without updating both was a desync no type could see.
 */
function scalarTail(
  seed: Rel, framing: RelFraming, steps: readonly IRStep[], from: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, aliases: AliasMap = NO_ALIASES,
): Tail | null {
  let rel = seed;
  let out: RelFraming = framing;
  let labels = aliases;
  const carries = (name: string): boolean => rel.type.cols.some((column) => column.name === name);
  // WHAT IS KNOWN about the value's Gremlin type, read off the framing rather than guessed — the ONE
  // fact both `is`'s ordering comparisons and its `typeOf` test need, so it is computed once as a
  // total union rather than twice as two optionals. A per-row `vtype` column is in scope only where
  // the value came from a stored property; a `count()` is a compile-time `long`, which is what lets
  // `count().is(P.typeOf(GType.LONG))` constant-fold without touching a row; an injected value with a
  // heterogeneous or untagged type is honestly `unknown`. Same three cases `predicateSql` calls
  // `TypeCtx`, in the algebra's own expression vocabulary.
  const subjectType = (): SubjectType =>
    carries('vtype') ? { kind: 'perRow', vtype: col(rel.id, 'vtype') }
      : out.kind === 'scalar' && out.type.kind === 'static' ? { kind: 'static', type: out.type.type, text: out.type.text }
        : SUBJECT_UNKNOWN;

  // A BOUNDARY before a CLAUSE-POSITION READER, and it is not cosmetic. Fusing a `Filter` or a
  // `Sort` into its input's block means the input's outputs are spelled as the EXPRESSIONS that
  // compute them (§5) — SQL has no other option, since neither a `WHERE` nor an `ORDER BY` can name
  // a select alias. So each one re-inlines the whole projection, and with the vtype-aware ordering
  // CASE in play that is ~20 binds apiece: measured 25 / 45 / 65 for one, two and three range
  // predicates against legacy's 2 / 3 / 4, and 24 against legacy's 1 for a single `order()` (whose
  // key inlines the value expression three times over — once per arm of the compare CASE). A fourth
  // predicate would exceed the DO cap and fail closed where legacy answers — a support regression,
  // not a wall worth shipping. `Materialize` is the declared remedy (§3.3, "a boundary hint … where
  // the planner needs a fence") and lands the same CTE-then-read shape legacy emits.
  //
  // Only the FIRST tail step needs the hint, and that is structural rather than lucky: a reader
  // further along sits over a node the assembler already refuses to fuse into — a `Limit`, a
  // `Distinct`, an earlier `Sort`, or this very fence — so its subject is a column of a finished
  // block and there is nothing left to re-inline.
  if (CLAUSE_READERS.has(steps[from]?.name ?? '') && seed.kind !== 'values')
    rel = make.materialize({ id: fresh('m'), input: rel, channels: rel.channels, type: rel.type });

  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = argValues(step);
    if (step.optionArms) return null;
    // The blanket modulator decline exempts the two steps that HOST a `by()` here; each reads it
    // through `modulator.ts` and declines the projections a value stream cannot serve.
    if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
    // A value's own `vtype` is in scope only where it came from a stored property, which is the same
    // distinction `compare()` above draws and the reason `ChildHost` carries it as an optional.
    const host: ChildHost = { kind: 'scalar', value: col(rel.id, 'v'), ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') } : {}) };

    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }

    // `as()` over a VALUE traverser records the value AND its type: the entry's own `t` field is the
    // only place a per-row `vtype` COLUMN can survive becoming JSON, which is what makes
    // `values('age').as('a').select('a').is(P.gt(30))` compare as a number rather than as text.
    if (step.name === 'as') {
      const bound = bindAliases(step, rel, labels, {
        kind: 'value', value: col(rel.id, 'v'),
        type: out.kind === 'scalar' ? out.type : UNKNOWN,
        ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') } : {}),
      }, fresh);
      if (!bound) return null;
      rel = bound.rel;
      labels = bound.aliases;
      continue;
    }

    // A `select()` here may re-root to an ELEMENT, which is the whole reason `elementTail` is a
    // function: the shape boundary runs both ways and `selectTail` is the one place that decides which
    // loop the label's shape belongs to.
    if (step.name === 'select') {
      const selected = selectOne(step, rel, labels, fresh);
      if (!selected) return null;
      return continueAs(selected.rel, readFraming(selected.read), steps, at + 1, bulked, ctx, fresh, labels);
    }

    if (step.name === 'union') {
      const merged = unionArms(step, rel, out, bulked, ctx, fresh, labels);
      if (!merged) return null;
      return continueAs(merged.rel, merged.framing, steps, at + 1, bulked || ctx.collapse, ctx, fresh, labels);
    }

    if (step.name === 'order') {
      const sort = sortTerms(step, host, ctx, fresh);
      if (!sort) return null;
      const { terms } = sort;
      // A value's `by()` is identity-only (a value has no properties), so `drop` is never owed here —
      // applying it anyway keeps the rule in ONE place rather than in each host's head.
      if (sort.drop) rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: sort.drop });
      // A sort SUPERSEDES the arriving emission order, so where one is carried the positions must be
      // re-minted and not merely re-sorted: a later slice reads the channel, and taking its window
      // from the stale seed would return the right multiset from the wrong place. Legacy says the
      // same thing with its own window projection (`partitionedOrder`), tie-broken on the old
      // encounter — which is what makes the sort STABLE, so that is the second term here too.
      // A sort MINTS the emission order where none is carried and RE-MINTS where one is, which is the
      // same rule the element host follows and for the same reason: an order that is not a column
      // cannot survive a relation boundary. Legacy's answer without one is `ROW_NUMBER() OVER ()` plus
      // `COUNT(*) OVER ()` reading a CTE's incidental scan order — which is what `tail()` after a
      // scalar `order()` needs, and which is only right while SQLite happens to preserve it. A column
      // is the honest form, and it is what makes the position COMPOSE: a following `tail` reads the
      // order backwards, a slice takes its window from it, and the root reports it.
      //
      // Re-minting tie-breaks on the ARRIVING position (which is what makes the sort STABLE, legacy's
      // `partitionedOrder`); minting fresh has nothing to be stable against, and equal keys over a
      // value stream are interchangeable, so the terms are the whole order.
      const encounter = encounterOf(rel.channels);
      const channels = encounter ? rel.channels : withChannel(rel.channels, ENCOUNTER);
      rel = renumber(
        rel,
        encounter ? [...terms, { expr: col(rel.id, encounter.col), dir: 'asc' }] : terms,
        encounter ? rel.type.cols : [...rel.type.cols, meta(ENCOUNTER.col, 'int')],
        channels, fresh,
      );
      continue;
    }

    const sliced = sliceOp(step, rel, bulked, fresh);
    if (sliced) { rel = sliced; continue; }

    // THE SCALAR TRANSFORM FAMILY — one `Project` per transform, and the assembler fuses a run of them
    // into one SELECT (`upper(lower(p.v))`), which is what legacy's `fuseScalarSegment` hand-rolls.
    // Membership is checked BEFORE the lowering is asked for, so an unlowerable member of the family
    // (`reverse`, `asBool`) DECLINES rather than falling through to be misread by a later arm.
    if (REL_TRANSFORMS.has(step.name)) {
      // `seed.kind === 'values'` IS "the value is a compile-time literal": an `inject()` source is the
      // only one, and it is the population legacy constant-folds. Read off the SEED rather than the
      // current relation, because a preceding transform does not stop a value being literal-derived.
      const tx = transformExpr(step, col(rel.id, 'v'), seed.kind === 'values');
      if (!tx) return null;
      // EVERY transform drops the per-row `vtype` column, not only the casts: `toUpper()` leaves a
      // value the stored row no longer describes and `length()` turns it into an integer outright, so
      // carrying the column would reframe the RESULT as the INPUT's type. The framing type becomes
      // whatever the transform knows, or `UNKNOWN` — which infers per value and is what legacy frames
      // here. Dropping it also removes the vtype from `subjectType()`, so a following `is(P.gt(…))`
      // stops asking for an ordering key the value no longer has one for, which is correct: the
      // transformed value is a native SQLite value and compares directly.
      const carried = rel.channels;
      rel = make.project({
        id: fresh('tx'), input: rel, channels: carried,
        type: typeOf(meta('v', 'any', true), ...carriedCols(carried)),
        exprs: [['v', tx.expr], ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
      });
      out = { kind: 'scalar', type: tx.type ?? UNKNOWN };
      continue;
    }

    // `constant(c)` over a value stream is the same replacement as over an element one, minus the shape
    // change — and it DROPS the per-row `vtype`, for the reason every transform does: the stored type
    // no longer describes the value that is there now.
    if (step.name === 'constant') {
      const [, extra] = args;
      if (extra !== undefined) return null;
      const literal = constLit(step.args[0]);
      const tail = literal ? null : exactTailConst(step.args[0]);
      if (!literal && !tail) return null;
      const carried = rel.channels;
      rel = make.project({
        id: fresh('ct'), input: rel, channels: carried,
        type: typeOf(meta('v', 'any', true), ...carriedCols(carried)),
        exprs: [['v', literal ?? tail!.expr], ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
      });
      out = { kind: 'scalar', type: tail ? STATIC(tail.tag as never, true) : UNKNOWN };
      continue;
    }

    if (step.name === 'is') {
      if (args.length !== 1) return null;
      // `is(typeOf(GType.LIST|SET|MAP))` is a TYPE ASSERT, not a predicate: over a scalar stream
      // carrying a stored collection it RETYPES the stream to a list or a map, so lowering it as a
      // filter would return the right rows framed as the wrong shape — a different question, which is
      // the one thing this module may never answer. `collectionAssert` is the derived view of legacy's
      // ONE `typeOfAssert` decode (`child-shape.ts`), reused rather than re-recognized: five arms had
      // already drifted apart decoding this inline, and a sixth copy here would be the same mistake.
      // A TYPE ASSERT is not a predicate: `is(typeOf(LIST|SET))` RETYPES the stream to a collection, so
      // lowering it as a filter would return the right ROWS framed as the wrong SHAPE — the one thing
      // this module may never do. `collectionAssert` is the derived view of legacy's ONE `typeOfAssert`
      // decode, reused rather than re-recognized. A MAP retype needs the map shape, which this route
      // does not have; a stream with no per-row stored type has no stored collection at all, and
      // legacy's generic `is()` static-folds that case.
      const asserted = collectionAssert(step);
      if (asserted) {
        if (asserted === 'map' || !carries('vtype')) return null;
        const retyped = collectionRetype(rel, 'vtype', asserted, fresh);
        const tail = listTail(retyped.rel, retyped.of, steps, at + 1, ctx, fresh, labels);
        if (!tail) return null;
        // The SET marker rides on the framing, not the relation — a set and a list share every member
        // op and differ only at the wire. So it is applied to whatever the list tail finished as, and
        // only where that is still a collection.
        return tail.framing.kind === 'list' && retyped.set
          ? { ...tail, framing: { ...tail.framing, set: true } }
          : tail;
      }
      const pred = predicateExpr(col(rel.id, 'v'), args[0], subjectType(), step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh);
      if (!pred) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred });
      continue;
    }

    if (step.name === 'dedup') {
      // `Distinct` is WHOLE-ROW and only whole row (§3.3), so what the row IS decides the answer —
      // and a channel must not be in it. Two reasons, both load-bearing:
      //
      //  - a dedup must not DISTINGUISH rows by their multiplicity. Keeping `bulk` in the key means
      //    the same value at bulk 1 and bulk 3 survives twice, which is a wrong answer the moment a
      //    collapse upstream makes bulk anything but 1 — invisible on a fixture where it never is.
      //  - the survivor STANDS FOR ITSELF, not for the sum of the duplicates it replaced, so the
      //    multiplicity is dropped rather than carried: a following `count()` then reads
      //    `COUNT(*)`, which is what legacy emits and what the traversers actually number.
      //
      // The emission order goes with it for the same reason — a survivor has no one position — and
      // that matches legacy, whose scalar dedup projects the payload alone.
      //
      // A `by()` here is IDENTITY or nothing, and that is not a gap: over a value stream the only
      // projection available IS the value, so `dedup().by()` and bare `dedup()` are the same question
      // (legacy emits the identical `SELECT DISTINCT p.v` for both). `by(key)`/`by(token)` decline
      // through the vocabulary, which is where the "a value has no properties" rule lives.
      if (args.length || isLocalScope(step)) return null;
      const deduped = modulations(step, 1, childSeam(ctx, fresh));
      if (!deduped || (deduped[0] && !byExpr(deduped[0], host, fresh, false, childSeam(ctx, fresh)))) return null;
      if (deduped[0]?.order !== undefined) return null;
      const payload = rel.type.cols.filter((column) => !rel.channels.some((channel) => channel.col === column.name));
      if (!payload.length) return null;
      const projected = make.project({
        id: fresh('dp'), input: rel, channels: [], type: typeOf(...payload),
        exprs: payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      });
      rel = make.distinct({ id: fresh('d'), input: projected, channels: [], type: projected.type });
      continue;
    }

    // THE REDUCER FAMILY — one `Aggregate`, four step names, and the barrier that ENDS the tail's
    // channels: a reducing aggregate collapses the whole multiset into one row, so nothing survives it
    // (§3.5's `barrierChannels`), which is why the channels list is empty rather than trimmed by hand.
    if (isReducer(step.name)) {
      if (args.length || isLocalScope(step)) return null;
      if (step.name === 'min' || step.name === 'max') {
        // min/max ORDER rather than reduce, and Gremlin orders within a single TYPE SPACE — not by
        // SQLite storage class. A `long` carried as decimal TEXT (a value past 2^53) has
        // `typeof = 'text'`, so a raw `MIN()`/`MAX()` picks by storage-class order (INTEGER before
        // TEXT) and answers the wrong element AND hands it back framed as text. The compare key is
        // `storedCompareOn` — the SAME cast authority `order().by()` uses (`modulator.ts`) — so the
        // two positions cannot drift.
        //
        // The winner is the ORIGINAL row, projected whole (an argmin/argmax: rank, take rank 1), not
        // a `MIN()`/`MAX()` over a cast key: returning the raw storage extremum would round a >2^53
        // long through a JS number and lose the low bits, where the stored decimal TEXT is exact.
        // Ranking also makes zero rows emit NOTHING (`ReducingBarrierStep` supplies no seed for
        // min/max, §10·12·1) rather than the one NULL row a `MIN()` aggregate emits. The `vt` column
        // is the winner's own GREMLIN vtype (`int`/`long`/`string`, from the per-row column or the
        // source's static tag), which the `result:'number'` framer reads through `vtypeToValueType`
        // so a text-carried long frames as a `long` — the vocabulary `values()` frames on. Only the
        // UNKNOWN case (a heterogeneous stream, no vtype) falls back to `typeof`, whose storage-class
        // value the framer routes to `sumBuffer`; there neither spine can raise the reference's
        // cross-type error, so this matches legacy — the documented divergence (§13n).
        const staticVt = out.kind === 'scalar' ? staticTypeOf(out.type) : undefined;
        const vtypeExpr = carries('vtype') ? col(rel.id, 'vtype')
          : staticVt ? compilerText(staticVt) : undefined;
        const key = vtypeExpr ? storedCompareOn(vtypeExpr)(col(rel.id, 'v')) : col(rel.id, 'v');
        const dir: 'asc' | 'desc' = step.name === 'min' ? 'asc' : 'desc';
        const rank = 'red_rank';
        // NULL is SKIPPED by min/max (`NumberHelper` returns the non-null side), so it never wins.
        const present = make.filter({
          id: fresh('rf'), input: rel, channels: rel.channels, type: rel.type,
          pred: { kind: 'binary', op: 'is not', left: col(rel.id, 'v'), right: compilerNull() },
        });
        const ranked = make.window({
          id: fresh('rw'), input: present, channels: present.channels,
          type: typeOf(...present.type.cols, meta(rank, 'int')),
          specs: [[rank, {
            kind: 'window-expr', fn: 'row_number', args: [],
            // A total tie-break on the raw value keeps the survivor deterministic under a reversed scan.
            spec: { partitionBy: [], orderBy: [{ expr: key, dir }, { expr: col(present.id, 'v'), dir }] },
          }]],
        });
        // The rank filter reads a windowed column, so fence it (a window may not sit inside another
        // SELECT's WHERE without re-inlining — the rule `sample` obeys and §11 records).
        const frame = make.materialize({ id: fresh('rm'), input: ranked, channels: ranked.channels, type: ranked.type });
        const winner = make.filter({
          id: fresh('rk'), input: frame, channels: frame.channels, type: frame.type,
          pred: { kind: 'binary', op: '=', left: col(frame.id, rank), right: compilerInt(1) },
        });
        const vt: Expr = carries('vtype') ? col(winner.id, 'vtype')
          : staticVt ? compilerText(staticVt)
          : { kind: 'call', fn: 'typeof', args: [col(winner.id, 'v')] };
        rel = make.project({
          id: fresh('red'), input: winner, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
          exprs: [['v', col(winner.id, 'v')], ['vt', vt]],
        });
        out = { kind: 'scalar', type: UNKNOWN, result: 'number' };
        continue;
      }
      const bulk = rel.channels.find((channel) => channel.role === 'bulk');
      const staticSumVt = out.kind === 'scalar' ? staticTypeOf(out.type) : undefined;
      if (step.name === 'sum' && staticSumVt && isLongSumClass(staticSumVt)) {
        // §13g·5 rows 1–2. A `sum` over a known `long`/`bigint` class must INCLUDE a value carried as
        // decimal TEXT past 2^53, which the storage-class eligibility guard silently EXCLUDED
        // (`typeof = 'text'` ∉ arithmetic) — answering `1` for `inject(9007199254740993L, 1L).sum()`.
        // Casting every value through `storedCompareOn` for the KNOWN class admits the text-carried one
        // exactly, and `sumTower` keeps the class and rides the >2^53 result as exact TEXT. Only a STATIC
        // `long`/`bigint` takes this path; every other stream keeps the storage-class form below, which is
        // correct for the corpus's `values().sum()`/bare-int cases. (The byte/short/int PROMOTION tower —
        // `Sum.feature`'s `d[128].s` — needs those classes tagged at the source, a separate increment.)
        const casted = storedCompareOn(compilerText(staticSumVt))(col(rel.id, 'v'));
        const weighted = bulk ? { kind: 'binary', op: '*', left: casted, right: col(rel.id, bulk.col) } as Expr : casted;
        const tower = sumTower({ kind: 'agg', fn: 'sum', args: [weighted] }, staticSumVt);
        rel = make.aggregate({
          id: fresh('red'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
          groupBy: [], aggs: [['v', tower.value], ['vt', tower.type]],
        });
        out = { kind: 'scalar', type: UNKNOWN, result: 'number' };
        continue;
      }
      const reduced = reducerAggregate(col(rel.id, 'v'), step.name, bulk && col(rel.id, bulk.col));
      rel = make.aggregate({
        id: fresh('red'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
        groupBy: [], aggs: [['v', reduced.value], ['vt', reduced.type]],
      });
      // `result: 'number'` is the framing arm that reads the `vt` column — the result's storage class is
      // DYNAMIC (a sum of integers is an integer, of reals a real), so there is no compile-time tag to
      // give and `UNKNOWN` would throw the second column away.
      out = { kind: 'scalar', type: UNKNOWN, result: 'number' };
      continue;
    }

    if (step.name === 'count') {
      if (args.length) return null;
      rel = make.aggregate({
        id: fresh('agg'), input: rel, channels: [], type: typeOf(meta('v', 'int')),
        groupBy: [], aggs: [['v', countExpr(rel)]],
      });
      out = { kind: 'scalar', type: STATIC('long'), result: 'count' };
      continue;
    }

    // `fold()` — the SHAPE BOUNDARY out of the scalar tail and into the list vocabulary: every
    // traverser becomes one member of ONE list traverser. The member encoding is `list.ts`'s (it is
    // the decision every later member read depends on); what this side owns is the two facts it needs
    // — the per-row type column if the values carry one, and the emission order to fold IN.
    if (step.name === 'fold') {
      if (args.length || isLocalScope(step)) return null;
      const encounter = encounterOf(rel.channels);
      const folded = foldScalars(rel, {
        ...(carries('vtype') ? { vtype: 'vtype' } : {}),
        ...(out.kind === 'scalar' && staticTypeOf(out.type) ? { staticTag: staticTypeOf(out.type)! } : {}),
        ...(encounter ? { encounter: encounter.col } : {}),
      }, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }

    return null;
  }
  return { rel, framing: out, aliases: labels };
}

/**
 * `g.inject(v…)` — a SCALAR source, and the largest single blocker measured over the corpus: 387 of
 * the 2,298 traversals begin with one, 17% of the whole set.
 *
 * `Values` is the node, and it is the one construct measured emitting SQL's `VALUES` (§3.3). The
 * relation is one column and NO channels — an injected row is one traverser by construction, so
 * there is no multiplicity to carry and nothing has established an emission order.
 *
 * A UNIFORM DECLARED TYPE is not derivable from the values and must not be re-derived: a `char`, a
 * `uuid`, a `datetime` and a long past 2^53 all arrive as ordinary JS strings or numbers, so framing
 * by inference reframes them as the wrong wire type. `bareInjectTag` is the one authority for that
 * and this calls it rather than reimplementing it. Measured: before it did, the census caught four
 * corpus traversals (`inject("a"c)`, `inject(UUID(…))` and friends) changing their answer — right
 * arity, plausible rows, wrong GraphBinary type.
 *
 * Two forms decline, each for a reason rather than a blanket. A COLLECTION argument
 * (`inject([1,2])`) is a LIST traverser, a different framing arm and a JSONB payload rather than a
 * scalar column. `inject()` with no arguments is the EMPTY relation, which legacy spells
 * `SELECT NULL AS v WHERE 0` and `Values` cannot express at all — §3.3 records why it refuses to
 * (`Values([])` rendered as invalid SQL that only failed at the database), and the algebra's answer
 * is a `Filter(false)` over something, which there is nothing here to be over.
 */
/** An EXACT-TAIL constant argument — a Duration, a BigDecimal, or a big BigInt (>2^53) — for the
 *  `constant(c)` sites. It has no scalar-literal form, so `constLit` declines it; but its declared type
 *  is known, so it inlines as its canonical decimal/total-nanos TEXT (exact, framed back as its own
 *  type) and frames `STATIC(type, text=true)` — the `text` flag telling a following ordering compare to
 *  cast it to its numeric class (C1). A `$x` binds (TEXT too). `null` for a non-tail (`constLit` handled
 *  it) or an untyped tail (no declared type to frame). */
const exactTailConst = (a: Arg | undefined): { expr: Expr; tag: string } | null => {
  const v = a?.value;
  const tag = flatType(a?.type ?? null);
  if (tag == null || !(v instanceof Duration || v instanceof BigDecimal || typeof v === 'bigint')) return null;
  return { expr: a!.name != null ? param(v, a!.name) : compilerText(String(v)), tag };
};

function injectSource(steps: readonly IRStep[], fresh: Minter): { rel: Rel; framing: RelFraming; at: number } | null {
  const step = steps[0]!;
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);
  if (!args.length) return null;
  // A COLLECTION argument here means a MIXED inject (`inject([1,2], 3)`): a list traverser and a
  // scalar traverser in one stream, which is the VARIANT shape rather than either of them. Legacy
  // FLATTENS it — its own comment calls that the historical representation, held until a scalar
  // stream gains a per-row shape discriminant — and reproducing an approximation is not the same as
  // reproducing an answer, so this declines instead.
  if (args.some((arg) => Array.isArray(arg))) return null;

  // THE LEADING COERCION PREFIX IS FOLDED AT COMPILE TIME, on both spines and by the same function.
  // `asNumber`/`asBool`/`asDate` raise TinkerPop's exact parse and overflow messages, which SQL
  // cannot raise at all — that is why legacy folds them over a literal rather than emitting a CAST,
  // and it is why a `CAST` here would answer `1` for `'1,000'` and epoch 0 for an invalid date (§11:
  // a required error became a plausible value). So the fold is REUSED, not re-expressed: it mutates
  // the value array in place and hands back the first ordinary step plus the framing tag it
  // established. A value that does not parse THROWS from in there, and this module's contract is
  // `null` — so it is caught, and the legacy spine raises the message it owns.
  const vals = [...args];
  let folded: { at: number; as?: string };
  try { folded = foldConstantCoercions(steps as IRStep[], vals); } catch { return null; }

  // The type each row inlines under: a coercion fold (`asNumber`/`asBool`/…) has already retyped the
  // whole stream, so its uniform `as` wins; absent a fold, the value keeps the arg's declared subtype.
  const rowType = (i: number): TypeNode | null =>
    (folded.as as TypeNode | undefined) ?? (folded.at === 1 ? (step.args[i]?.type ?? null) : null);
  // THE TYPE CHANNEL (§6·7). A coercion fold retypes the whole stream, so its `as` wins outright.
  // Absent one, each argument's DECLARED type is read on its own — `injectValueTypes`, the same
  // authority legacy reads through its uniform view, so neither spine re-derives what a `char`, a
  // `uuid`, a `datetime` or a long past 2^53 frames as.
  //
  // Where the declared tags AGREE the stream is STATIC and costs no column, which is the common
  // case and why `static` survives as the degenerate arm. Where they DISAGREE the type rides PER
  // ROW in a `vt` column, exactly as a stored-vtype read does — same vocabulary, so `frameScalar`
  // needs nothing new and an unrecognized name degrades to inference rather than misframing.
  //
  // That second arm is the point. It used to be `UNKNOWN`, and `UNKNOWN` here was a LIE told twice:
  // it means "the JS client genuinely cannot say", and this was "our source cannot carry two". A
  // mixed `inject(UUID(…), datetime(…))` discarded BOTH declared types and framed both by guessing
  // at a JS string and a JS number — a wrong wire CLASS, not a wrong tag.
  const declared: readonly (ValueType | null)[] = folded.at === 1 ? injectValueTypes(steps, vals.length) : [];
  const uniform = declared.length > 0 && declared.every((t) => t !== null && t === declared[0]);
  const perRowType = declared.some((t) => t !== null) && !uniform;
  // Computed before the rows because a tail member's inline is only sound when the stream frames
  // STATIC (see below) — a per-row or unknown stream reads a bare TEXT literal back as a string.
  const tag = folded.as ?? (uniform ? declared[0]! : undefined);
  // A scalar arg inlines as a typed literal / binds as a parameter (`constLit`). An EXACT TAIL — a
  // Duration, a BigDecimal, or a big BigInt — has no scalar-literal form, so `constLit` declines it; but
  // it rides as its canonical decimal/total-nanos TEXT (exact, reads back as its own type) and stores as
  // TEXT, so it inlines here. Sound ONLY when `tag` is set: a MIXED inject frames UNKNOWN, where a bare
  // TEXT literal would read back as a string, so a tail member there still declines
  // (C1, docs/archive/2026-08-05-parameters-are-the-only-binds.md). A `$x` binds — a bound tail is TEXT too.
  //
  // The subject frames `STATIC(tag, text=true)`: a bigint (`inject(9…L)`) shares the tag `long` with a
  // native `count()`, and a BigDecimal shares `bigdecimal` with a native `asNumber(GType.BIGDECIMAL)`
  // REAL — the storage classes differ (TEXT here, native there) and only the `text` flag distinguishes
  // them, so `ordered` casts THIS subject to its numeric class while leaving the native one alone. That
  // is what lets `inject(9.99m)`/`inject(9…L)`/`inject(Duration(…))` order correctly instead of declining.
  let textTail = false;
  const rowExpr = (value: unknown, i: number): Expr | null => {
    const paramName = step.args[i]?.name ?? null;
    const literal = constLit(arg(value, rowType(i), paramName));
    if (literal) return literal;
    if (tag !== undefined && (value instanceof Duration || value instanceof BigDecimal || typeof value === 'bigint')) {
      textTail = true;
      return paramName != null ? param(value, paramName) : compilerText(String(value));
    }
    return null;
  };
  const rows = vals.map(rowExpr);
  if (rows.some((row) => !row)) return null;
  // The per-row arm widens each VALUES row to `(v, vt)`. A row whose argument declared nothing gets
  // a NULL tag, which is the honest per-row spelling of "infer this one from the value" — the
  // framer already reads an absent/unrecognized vtype that way, so a partially-typed mixed inject
  // needs no third state.
  const cells: Expr[][] = perRowType
    ? (rows as Expr[]).map((row, i) => [row, declared[i] ? compilerText(declared[i]!) : compilerNull()])
    : (rows as Expr[]).map((row) => [row]);
  return {
    rel: make.values({
      id: fresh('inj'), rows: cells, channels: [],
      type: perRowType ? typeOf(meta('v', 'any', true), meta('vt', 'text', true)) : typeOf(meta('v', 'any', true)),
    }),
    framing: {
      kind: 'scalar',
      type: tag ? STATIC(tag as never, textTail) : perRowType ? PER_ROW('vt') : UNKNOWN,
    },
    at: folded.at,
  };
}

/**
 * `g.inject([…])` — a COLLECTION literal, which seeds one LIST traverser per argument rather than one
 * scalar per member. The largest half of the largest blocked family: 45 of the 194 list traversals
 * begin here (the other 27 begin at a `fold()`), and both halves frame identically, which is why one
 * arm serves both.
 *
 * `jsonb_array(…)` is the member encoding, and it is BARE — legacy's `jsonbArrayOf` spells it
 * `jsonb(json_array(…))`, the same value. The members are query-text-bounded literals, so a bind
 * each is right here and a JSON bind is not (the root rule is about sets sized by DATA); an
 * over-budget list declines at the rendered-bind gate like anything else.
 *
 * MIXED arguments decline: `inject([1,2], 3)` is a list traverser and a scalar traverser in one
 * stream, which is the VARIANT shape rather than either of them.
 */
function injectList(step: IRStep, fresh: Minter): { rel: Rel; framing: RelFraming } | null {
  const args = argValues(step);
  if (step.modulators?.length || step.optionArms || !args.length) return null;
  if (!args.every((arg) => Array.isArray(arg))) return null;
  const rows = (args as readonly unknown[][]).map((values, ai) => {
    const listArg = step.args[ai]!;
    // A LITERAL `[…]` carries member `Arg`s (`.members`) — each with its captured type AND its
    // wire-parameter name, so a `$x` member BINDS. A bound list-PARAM (no members) inlines each member
    // as a TYPED, nameless literal from the container's `type.items[i]` (the documented oversized rule).
    const members = listArg.members;
    const items = values.map((value, mi) =>
      constLit(members ? members[mi]! : arg(value, itemTypeAt(listArg.type ?? null, mi))));
    return items.some((item) => !item) ? null : [{ kind: 'json-array', items: items as Expr[], binary: true } as Expr];
  });
  if (rows.some((row) => !row)) return null;
  return {
    rel: make.values({ id: fresh('inl'), rows: rows as readonly (readonly Expr[])[], channels: [], type: typeOf(meta(LIST_COL, 'json')) }),
    framing: { kind: 'list', of: BARE_LIST },
  };
}

/**
 * THE LIST TAIL — the vocabulary above a collection-valued relation.
 *
 * Three exits, and they are the three things a list op can do: stay a list (`list.ts`'s member
 * frame), retype to a scalar (`conjoin`, a local reducer, `count(Scope.local)`), or `unfold` into one
 * traverser per member, which hands the rest of the chain to the SCALAR tail. A global row op —
 * `limit(2)` with no `Scope.local` — slices the stream's ROWS and is the ordinary `sliceOp`, which is
 * the distinction legacy draws by composing the shared row op in front of the local one.
 */
function listTail(
  seed: Rel, of: ListOf, steps: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
  aliases: AliasMap = NO_ALIASES,
): Tail | null {
  let rel = seed;
  let items = of;
  let labels = aliases;
  // The sub-read lowerer is INJECTED rather than imported, which is what keeps the module DAG a DAG
  // (`build ◂ {predicate, modulator, transform, reducer, list} ◂ lower ◂ spine`): a list op that needs
  // a nested chain lowered would otherwise import the fold that imports it.
  const seam = childSeam(ctx, fresh);
  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    if (step.name === 'identity' || step.name === 'barrier') { if ((step.args ?? []).length) return null; continue; }

    // `as()` over a LIST traverser binds the whole collection as ONE history entry, tagged `list` — a
    // list is one traverser, so binding it per member would be a different question. `listOf` rides on
    // the entry, which is what lets `fold().as('a').select('a').unfold()` re-enter the member frame
    // with the encoding the fold actually produced rather than a guess at it.
    if (step.name === 'as') {
      const bound = bindAliases(step, rel, labels, { kind: 'list', list: col(rel.id, LIST_COL), of: items }, fresh);
      if (!bound) return null;
      rel = bound.rel;
      labels = bound.aliases;
      continue;
    }

    // A `select()` over a LIST traverser is the same read as anywhere else — the label decides the
    // shape and `selectTail` decides the loop, so a label holding an element re-enters `elementTail`
    // from here exactly as it does from the scalar tail.
    if (step.name === 'select') {
      const selected = selectOne(step, rel, labels, fresh);
      if (!selected) return null;
      return continueAs(selected.rel, readFraming(selected.read), steps, at + 1, false, ctx, fresh, labels);
    }

    if (step.name === 'unfold') {
      if ((step.args ?? []).length) return null;
      const unfolded = unfoldList(rel, items, fresh);
      if (!unfolded) return null;
      // The member's POSITION becomes the emission order, minted rather than declared: `json_each.key`
      // is an index within ONE list, so it is a total order only where the relation has one row, and
      // taking a later slice's window from a per-row index would return the right multiset from the
      // wrong place. Where a position was already carried it leads the sort, so the members of an
      // earlier list all precede the members of a later one.
      const carried = encounterOf(rel.channels);
      const channels = carried ? rel.channels : withChannel(rel.channels, ENCOUNTER);
      const terms: readonly SortTerm[] = [
        ...(carried ? [{ expr: col(unfolded.rel.id, carried.col), dir: 'asc' as const }] : []),
        { expr: col(unfolded.rel.id, unfolded.ord), dir: 'asc' as const },
      ];
      const positioned = renumber(
        unfolded.rel, terms,
        [...(unfolded.member ? [meta(LIST_COL, 'json')] : [meta('v', 'any', true), ...(unfolded.typed ? [meta('vtype', 'text', true)] : [])]),
          ...carriedCols(channels)],
        channels, fresh,
      );
      // A NESTED list's members are LISTS, so the unfolded stream stays in the list vocabulary rather
      // than entering the scalar one — the same explode, a different payload.
      if (unfolded.member) return listTail(positioned, unfolded.member, steps, at + 1, ctx, fresh, labels);
      // A TYPED list's members frame by their OWN type, exactly as `values()` over a stored property
      // does — `PER_ROW('vtype')`, the same channel and the same column name, so the scalar tail's
      // `carries('vtype')` picks it up and an `is(P.gt(…))` after it gets the vtype-aware compare key
      // for free. A bare list's members are honestly `UNKNOWN` (inferred per value at the wire).
      return scalarTail(positioned, { kind: 'scalar', type: unfolded.typed ? PER_ROW('vtype') : UNKNOWN }, steps, at + 1, false, ctx, fresh, labels);
    }

    // A GLOBAL row op slices the stream's rows, not one traverser's members.
    const sliced = sliceOp(step, rel, false, fresh);
    if (sliced) { rel = sliced; continue; }

    const member = listMemberOp(step, rel, items, fresh);
    if (member) { rel = member.rel; items = member.of; continue; }

    // The SET-OP family, which needs to know whether it is TERMINAL: the four deduping ops frame as a
    // GraphBinary SET only at the end of a chain — with a follower TinkerPop treats the deduped
    // content as a plain List, which is what the suite asserts.
    const setOp = listSetOp(step, rel, items, at + 1 >= steps.length, seam, fresh);
    if (setOp) {
      rel = setOp.rel;
      items = setOp.of;
      if (setOp.set) return { rel, framing: { kind: 'list', of: items, set: true }, aliases: labels };
      continue;
    }

    const retyped = listRetype(step, rel, items, fresh);
    if (!retyped) return null;
    return scalarTail(
      retyped.rel,
      { kind: 'scalar', type: retyped.type, ...(retyped.result ? { result: retyped.result } : {}) },
      steps, at + 1, false, ctx, fresh, labels,
    );
  }
  return { rel, framing: { kind: 'list', of: items }, aliases: labels };
}

/**
 * THE PATH TAIL — the steps a Path answers ITSELF, and the retype into the list loop for the rest.
 *
 * A path is the list shape wearing a different framer (`compiler/rel/path.ts`), so this loop is deliberately
 * tiny: what belongs here is only what a Path answers differently from a List, and everything else is handed
 * to `listTail` over the SAME relation — the retype costs no node at all, because the relation already is a
 * list relation and only the framing arm changes.
 *
 * Three things are a Path's own:
 *
 * - **`is(typeOf(GType.PATH))` is IDENTITY** — a path IS a Path. Any other `typeOf` matches nothing, which is
 *   the empty relation, and §3.3 records the honest spelling of that as a `Filter(false)` (`Values` refuses
 *   to express empty). A real predicate declines: legacy owns the message.
 * - **`count()` counts PATHS**, not positions — the same `countTail` an element relation uses, shared rather
 *   than re-derived so the two cannot disagree about whether the answer is `SUM(bulk)` or `COUNT(*)`.
 * - **the slices** read the emission order the path carried through, exactly as anywhere else.
 *
 * **The delegation is a WHITELIST (`PATH_LIST_OPS`) and must never become a fall-through**, for a reason
 * that is a wrong ANSWER rather than a missing one: `as()` in `listTail` binds the collection as a history
 * entry tagged `list`, so `path().as('a').select('a')` would re-enter as a List and frame as one. `dedup()`
 * is absent for a smaller reason — nothing produces a path a `dedup()` can reach yet (the `inject()` sources
 * are the corpus's only ones), so building it would be building for no caller.
 */
function pathTail(
  seed: Rel, of: ListOf, scalars: boolean, steps: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
  aliases: AliasMap,
): Tail | null {
  let rel = seed;
  const labels = aliases;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = argValues(step);
    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }

    if (step.name === 'is') {
      if (assertsGType(step, 'PATH')) continue;
      if (typeOfAssert(step).kind !== 'gtype') return null;
      rel = make.filter({
        id: fresh('f'), input: rel, channels: rel.channels, type: rel.type,
        pred: eq(compilerInt(0), compilerInt(1)),
      });
      continue;
    }

    if (step.name === 'count') {
      if (args.length || step.modulators?.length || step.optionArms) return null;
      const counted = countTail(rel, fresh);
      return scalarTail(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    const sliced = sliceOp(step, rel, false, fresh);
    if (sliced) { rel = sliced; continue; }

    // The relation is ALREADY a list relation, so the retype is the framing arm and nothing else — but only
    // where every position is a projected SCALAR. An element position would decode through a member op into
    // the scalar stream, which has no element arm, and legacy fails closed on exactly this boundary
    // (`linearScalarList`). See `scalars` on `pathPositions`.
    if (PATH_LIST_OPS.has(step.name)) return scalars ? listTail(rel, of, steps, at, ctx, fresh, labels) : null;
    return null;
  }
  return { rel, framing: { kind: 'path', of, scalars }, aliases: labels };
}


/**
 * Lower a whole rooted chain, or decline.
 *
 * Coverage today is the element SOURCE plus a run of source-scope filters. The declines are the
 * growth list, and the measured order of what each is worth over the 2,298-traversal corpus is
 * recorded in the build plan — `has(key, P…)` is the next single largest, then the reducers.
 */
/** The compile-scoped facts a lowering reads beyond the chain itself: the bound parameters, and
 *  which lowering STRATEGIES this compile has asked for. `collapse` and `correlatedChildren` are
 *  the two fast-path switches RelIR implements a side of; a switch it cannot implement is never
 *  read here, because coverage must not become a function of configuration. */
export interface Lowering {
  readonly params?: Record<string, any>;
  readonly collapse?: boolean;
  readonly correlatedChildren?: boolean;
  /**
   * The GRAPH's declared vertex-label cardinality — a CAPABILITY, not a strategy, which is why it is
   * here rather than being read from a store at lowering time.
   *
   * `addV()` with no label used to decline on the grounds that "under `ZERO_OR_MORE` it creates a
   * vertex with no labels and under `ONE` it takes the graph default" is a property of the store. The
   * property is real; the conclusion was wrong by one step. The cardinality is request-scope DI
   * (`src/scopes.ts`), so it is settled BEFORE a compile starts — what was actually missing is that
   * this seam had not been handed it. Threading it is what makes the answer compile-time, and the
   * label COUNT rule (`min`/`max`) then declines exactly the chains legacy raises a message for.
   *
   * Defaults to `ONE`, which is `createAppScope`'s own default, so an instrument or a test that
   * lowers without an engine measures the default graph rather than a regime nothing runs.
   */
  readonly labelCardinality?: LabelCardinality;
  /**
   * The `withSideEffect(name, constant)` registry — the SECOND compile-scope constant environment a
   * nested argument resolves against, beside the wire `bindings` in `params`.
   *
   * `withSideEffect(k, v)` with a literal value is a COMPILE-TIME constant: the front-end
   * (`extractSideEffects`) reads it off the parse tree, and a later `__.select(k)` in a write's key,
   * value or merge map resolves to it with no read at all. The shared write parse
   * (`parseProperty`/`mergeMaps`) has always taken it; this route was passing `undefined` and
   * `compiler.ts` did not even OFFER the RelIR spine to a traversal that declared one, so the
   * whole `mergeV(__.select(c))` family read as an uncovered gap (§6·6).
   *
   * Defaults to EMPTY, which is what a lowering with no source options has.
   */
  readonly sideEffects?: Map<string, any>;
}

/**
 * The options with every default APPLIED — one authority, because two consumers now need the same
 * answer: the fold reads all four, and the wire projection reads `collapse` (a collapsed leaf carries its
 * multiplicity out as a `bulk` COLUMN, which is exactly legacy's `movementCollapse` gate). A second
 * `?? true` beside this one would be a second default, i.e. the kind of thing that agrees until it does not.
 */
const settle = (opts: Lowering): Required<Lowering> => ({
  params: opts.params ?? {},
  collapse: opts.collapse ?? true,
  correlatedChildren: opts.correlatedChildren ?? true,
  labelCardinality: opts.labelCardinality ?? LabelCardinality.ONE,
  sideEffects: opts.sideEffects ?? NO_SIDE_EFFECTS,
});

/** No `withSideEffect` declared. One shared value, for `NO_ALIASES`' reason. */
const NO_SIDE_EFFECTS: Map<string, any> = new Map();

/**
 * THE BIND BUDGET IS A COVERAGE QUESTION, not a crash.
 *
 * §3.6 makes the DO 100-parameter cap a property of the plan that fails closed rather than SQL that
 * only fails in production — and `check` enforces it by THROWING, which is right inside the algebra
 * and wrong at this seam: a traversal legacy answers must not become a compile error because the new
 * route spells its predicate more expensively (§11 — RelIR throwing where legacy answers is the one
 * failure mode the routing switch cannot absorb). So the budget is asked HERE, before the plan is
 * handed over, and an over-budget plan is a decline like any unlearned step.
 *
 * It bites at a knowable place: RelIR renders the vtype-aware compare key's class lists as binds
 * where legacy inlines them as literals, so one element `order().by(key)` is ~27 binds against
 * legacy's 2 — three in one chain would exceed the cap. Making that a decline is what keeps the wall
 * out of production; making the key cheaper is a separate increment.
 *
 * **The number asked must be the number the WALL measures — so there is no pre-count, only the
 * render.** Any cheap estimate diverges from what the assembler actually spells: it can count a `Lit`
 * the block fuses in twice as one (UNDER), or sum a parameter shared across CTEs once per binding
 * where the render dedups it to a single reused `?N` (OVER). Measured over every corpus prefix: 50
 * divergences, the widest 42 rendered against 31 counted. An under-estimate would admit a plan that
 * renders past 100 and refuse only at emission — past the point this seam could still choose the other
 * route; an over-estimate would decline a valid plan to legacy, which does not dedup and renders it
 * FATTER. So RENDER once and ask the real list. The render costs ~30µs against a compile and is the
 * only count worth checking.
 *
 * It goes through `emitRelational` + the kernel's own `render` rather than `emitQuery` (which refuses
 * an over-budget plan by throwing a bare number). The decline is a TYPED catch — `BindBudgetExceeded`
 * only, the same discrimination the effects branch makes: `checkPlan` (inside `emitRelational`) raises
 * that class for a per-binding over-budget, a real cap decision, while a structural checker violation
 * is a different class that still escapes — so the one failure `rel-sweep` exists to see is never
 * swallowed.
 */
/**
 * THE PAYLOAD PROJECTION, APPLIED — the fold's last act, and the §10·10 boundary in one function.
 *
 * A `RelFraming` arm that this route projects for itself becomes a `wire` result whose relation IS the
 * rows `execute.ts` frames; an arm still built by legacy's materializer passes through as `stream`. It runs
 * HERE, between the fold and `name`, and both halves of that placement matter: after the fold, because the
 * projection drops every carried channel and no later step could read one; before `name` and the budget,
 * because the projection's own correlated subplans are part of the plan whose CTEs are chosen and whose
 * binds are counted.
 */
const framed = (chain: Tail, collapse: boolean, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } | null => {
  const framing = chain.framing;
  switch (framing.kind) {
    case 'elements': return {
      rel: elementPayload(chain.rel, framing.elem, { bulk: collapse }, fresh),
      shape: framing.elem === 'edge' ? { kind: 'edge' } : { kind: 'vertex' },
    };
    case 'scalar': return scalarPayload(chain.rel, framing, fresh);
    case 'list': return listPayload(chain.rel, framing.of, !!framing.set, fresh);
    case 'path': return pathPayload(chain.rel, framing.of, fresh);
    case 'map': return mapPayload(chain.rel, framing.keyOf, framing.valOf, fresh);
    // A DISCARD has nothing to project: the result relation is a statement with an empty `RETURNING`, so it
    // has no columns and `discard` is already the whole contract. The algebra owes the framing layer nothing
    // further, which is exactly what every other arm here now also means.
    case 'discard': return { rel: chain.rel, shape: { kind: 'discard' } };
  }
};

/**
 * THE SCALAR PAYLOAD — `SELECT v[, <the type column>]`, in emission order.
 *
 * The smallest arm, and the only one whose builder lives here rather than beside its vocabulary, because
 * the scalar vocabulary IS this module (`scalarTail`). What varies is the SECOND column and which `Shape`
 * reads it, and `result` is the total answer — the same three-way legacy's `materializeScalarRoot` takes:
 *
 * - a NUMERIC REDUCER (`result: 'number'`) carries `vt`, the aggregate's own `typeof(…)`. Its storage class
 *   is DYNAMIC — a sum of integers is an integer, of reals a real — so there is no compile-time tag to
 *   give and the framing arm is `{kind: 'scalar'}`, which is the one that reads that column.
 * - a PER-ROW type names a stored `vtype` column so the framer frames each row by its own type rather
 *   than by one tag for the whole result. `perRowColumnOf` is the authority, shared with legacy.
 * - anything else is one value and one static-or-unknown tag, so `v` alone.
 *
 * `productiveNull` is deliberately absent, exactly as it was when this arm went through legacy: it is
 * `ScalarStream` state the RelIR route never set, so claiming it here would be inventing a channel rather
 * than carrying one. A productive NULL result is its own increment.
 */
const scalarPayload = (
  rel: Rel, framing: Extract<RelFraming, { readonly kind: 'scalar' }>, fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } | null => {
  const ordered = byEncounter(rel, fresh);
  const typeCol = framing.result === 'number' ? 'vt' : perRowColumnOf(framing.type);
  const cols: readonly ColMeta[] = [meta('v', 'any', true), ...(typeCol ? [meta(typeCol, 'text', true)] : [])];
  return {
    rel: make.project({
      id: fresh('vw'), input: ordered, channels: [], type: typeOf(...cols),
      exprs: cols.map((column) => [column.name, col(ordered.id, column.name)] as const),
    }),
    shape: framing.result === 'number' ? { kind: 'scalar' } : { kind: 'value', type: framing.type },
  };
};

const lowered = (chain: Tail, collapse: boolean, fresh: Minter): RelLowering | null => {
  const wire = framed(chain, collapse, fresh);
  // A shape whose payload projection is not built yet is COVERAGE WE DO NOT HAVE, so it declines exactly as
  // an unlearned step does. It must not throw: legacy answers these, and `rel-sweep` is the gate that
  // proves this seam never raises where the other spine has an answer.
  if (!wire) return null;
  const named = nameBindings(wire.rel);
  // EFFECTS FIRST, then whatever CTEs the result still needs — `checkPlan` proves a `Ref` resolves
  // only backwards, so the order the executor runs IS the order the checker walked. `name` is called
  // on the result alone because a write step has already named its own target's shared nodes; the
  // day a write RESULT needs naming across that boundary, this is where the pass grows to walk a
  // program rather than a tree.
  const built = chain.effects ? program({ bindings: [...chain.effects, ...named.bindings], result: named.result }) : named;
  // A held LITERAL — of any size — inlines as a typed SQL literal (`constLit`), so a big `inject(v1…vN)`
  // is 0 binds and DO-legal with nothing to convert. The 100-bind cap is a PARAMETER budget, and the only
  // way past it is 100+ distinct PARAMETERS in one statement, which fails closed at the gate below rather
  // than being blobbed into one bind — a scenario not in the corpus and deliberately unsupported.
  const plan = built;
  // A PROGRAM's budget is PER STATEMENT — each binding is its own query — so the sum a read plan is
  // measured by (its bindings are CTEs of ONE statement) would refuse a nine-statement cascade on a
  // number no database ever asks. `emit` renders every step and raises `BindBudgetExceeded` on the
  // one that is over, which is the same rendered-list authority the read path renders for.
  if (chain.effects) {
    try { emit(plan); } catch (error) {
      if (!(error instanceof BindBudgetExceeded)) throw error;
      return null;
    }
    return { plan, shape: wire.shape };
  }
  // A read is ONE statement, so the number the DO measures is exactly its rendered bind list — ask
  // that, nothing coarser. A pre-count summed per binding could only DECLINE a valid plan on an
  // over-estimate: a parameter shared across CTEs is one bind after dedup but was summed once per
  // binding, and declining a repeated-parameter plan hands it to legacy — which does NOT dedup and
  // renders it FATTER, failing on the DO the very plan RelIR could fit. `emitRelational` renders
  // through `checkPlan`, whose per-binding budget guard throws `BindBudgetExceeded`; catch THAT as a
  // decline (a genuine over-budget binding is a genuine over-budget statement) exactly as the effects
  // branch does, while a real checker violation is a different class and still escapes.
  try {
    return render(emitRelational(plan)).binds.length > DO_BIND_CAP ? null : { plan, shape: wire.shape };
  } catch (error) {
    if (!(error instanceof BindBudgetExceeded)) throw error;
    return null;
  }
};

export function lowerToRel(steps: readonly IRStep[], opts: Lowering = {}): RelLowering | null {
  // ONE minter for the chain AND its wire projection: the projection's relation ids come from the same
  // id space the fold used, exactly as a sub-read's do (§11 — a second `minter()` would restart at 0 and
  // the emitter's scope would see one id naming two relations).
  const fresh = minter();
  const settled = settle(opts);
  const chain = lowerChain(steps, settled, fresh);
  return chain && lowered(chain, settled.collapse, fresh);
}

/**
 * THE CHAIN, lowered to a bare RELATION — the same fold, minus the naming and the budget.
 *
 * The split exists so a chain can be lowered INSIDE another one. A rooted sub-read used as a VALUE
 * (`merge(__.V().values('name').fold())`, `within(__.…fold())`, and eventually a `match` pattern) is a
 * relation the outer plan reads through a `Scalar` expression, and two things make that work:
 *
 * - **the MINTER is injected**, so the sub-read's relation ids come from the OUTER id space. §11's
 *   "relation ids are minted PER LOWERING" is about not sharing a module-global counter between
 *   COMPILES; within one compile the opposite is required, because two `minter()`s would both start at
 *   0 and the emitter's scope would see one id naming two relations.
 * - **naming happens ONCE, at the top.** The sub-read is spliced in unnamed, so the outer `name` pass
 *   sees the whole DAG. (A sub-read whose OWN graph shares a node internally is not bound today, since
 *   `name` does not walk expression subplans — it renders correctly, just inlined twice. Making the
 *   pass walk them is the general fix if a case ever needs it.)
 */
function lowerChain(steps: readonly IRStep[], opts: Lowering, fresh: Minter): Tail | null {
  const { params, collapse, correlatedChildren, labelCardinality, sideEffects } = settle(opts);
  // EMISSION ORDER is a chain-global fact, decided once and threaded — never re-derived per step.
  // `analyzeChain` is the same authority the legacy source seeds from, so the two cannot disagree
  // about which chains have an order to take a window from. A chain that demands one and reaches a
  // step this route cannot thread it through declines WHOLE: silently omitting the channel would
  // not defer, it would pick a different window from the same multiset — right arity, plausible
  // rows, and a census that structurally cannot see it (`ord` is telemetry, `ms` is the gate).
  const facts = analyzeChain(steps as IRStep[]);
  const ordered = facts.demandsEncounter;
  const tracksPath = facts.tracksPath;
  const ctx: ChainCtx = { params, correlatedChildren, collapse, ordered, tracksPath, labelCardinality, sideEffects };
  const orderedChannels = ordered ? withChannel(BULK, ENCOUNTER) : BULK;
  const seedChannels = tracksPath ? withChannel(orderedChannels, PATH_CHANNEL) : orderedChannels;
  const first = steps[0];
  if (!first) return null;

  if (first.name === 'inject') {
    // A COLLECTION literal seeds a LIST traverser, an ordinary value a SCALAR one — two shapes, and
    // the argument decides which, so the list arm is asked first and declines a scalar inject.
    const listed = injectList(first, fresh);
    if (listed) return listTail(listed.rel, (listed.framing as { readonly of: ListOf }).of, steps, 1, ctx, fresh);
    const injected = injectSource(steps, fresh);
    if (!injected) return null;
    return scalarTail(injected.rel, injected.framing, steps, injected.at, false, ctx, fresh);
  }

  // `addV` AT THE SOURCE is one vertex, and that is the only thing that differs from the mid-chain
  // form: the input relation is a single `Values` row instead of the traverser stream, and the same
  // lowering runs. A one-row source is what "how many" means here, so there is no second arm.
  // `addE` at the SOURCE is one edge with both ends named — the input is a one-row `Values` and the
  // endpoints carry the whole answer, so the mid-chain lowering runs unchanged.
  if (first.name === 'addE') {
    const one = make.values({ id: fresh('one'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
    const added = addedEdges(one, 'vertex', steps, 0, NO_ALIASES, ctx, fresh);
    if (!added) return null;
    const tail = elementTail(added.effects.result, 'edge', steps, added.at, false, ctx, fresh, NO_ALIASES);
    return tail && { ...tail, effects: [...added.effects.bindings, ...(tail.effects ?? [])] };
  }

  if (first.name === 'addV') {
    const one = make.values({ id: fresh('one'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
    const added = addedVertices(one, steps, 0, ctx, fresh);
    if (!added) return null;
    const tail = elementTail(added.effects.result, 'vertex', steps, added.at, false, ctx, fresh, NO_ALIASES);
    return tail && { ...tail, effects: [...added.effects.bindings, ...(tail.effects ?? [])] };
  }

  // `mergeV` AT THE SOURCE takes the same one-row input the two creations do, and for the same reason:
  // the input is a MULTIPLIER, so one row means the search's answer is emitted once.
  if (first.name === 'mergeV' || first.name === 'mergeE') {
    const one = make.values({ id: fresh('one'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
    const merged = mergedElements(one, 'vertex', steps, 0, NO_ALIASES, ctx, fresh);
    if (!merged) return null;
    const tail = elementTail(merged.effects.result, first.name === 'mergeE' ? 'edge' : 'vertex', steps, merged.at, false, ctx, fresh, NO_ALIASES);
    return tail && { ...tail, effects: [...merged.effects.bindings, ...(tail.effects ?? [])] };
  }

  if (first.name !== 'V' && first.name !== 'E') return null;
  // A modulator or an option arm on the source is not a source argument; decline rather than
  // silently ignore it.
  if (first.modulators?.length || first.optionArms) return null;
  const seeded = elementScan(first, fresh);
  if (!seeded) return null;

  // PHASE 1 — the source scan and the filters that fuse into its own WHERE. Kept separate from the
  // general fold below because only here is the physical row in scope: an edge's `label` is a
  // column to read rather than a membership test, and a run of filters conjoins into ONE `WHERE`
  // over one scan instead of the legacy CTE-per-filter with its re-join.
  let pred = seeded.pred;
  let at = 1;
  let elem = seeded.elem;
  for (; at < steps.length; at++) {
    const clause = sourceFilter(steps[at], { id: col(seeded.scan.id, 'id'), label: elem === 'edge' ? col(seeded.scan.id, 'label') : undefined, rel: seeded.scan }, elem, fresh, ctx);
    if (!clause) break;
    pred = and(pred, clause);
  }

  const source = pred ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred }) : seeded.scan;
  // The seed of the emission order is the ROWID, exactly as the legacy source seeds it: a scan's
  // natural order is the only order a bare source has, and naming it makes every later slice ask
  // the same question of the same column instead of of whatever SQLite happened to produce.
  let rel: Rel = make.project({
    id: fresh('c'), input: source, channels: seedChannels, type: typeOf(...elementCols(seedChannels)),
    exprs: [['id', col(source.id, 'id')], ...seedChannels.map((channel) => [channel.col,
      channel.role === 'bulk' ? compilerInt(1)
        : channel.role === 'encounter' ? col(source.id, 'id')
          : seedPath({ kind: 'element', elem, id: col(source.id, 'id') }),
    ] as const)],
  });

  return elementTail(rel, elem, steps, at, false, ctx, fresh, NO_ALIASES);
}

/**
 * THE ELEMENT TAIL — movement, post-movement filtering, the row-algebraic ops, `as()`, and the retype
 * out of the element shape. A filter here reads only the traverser's id, which is why `Subject`
 * carries no `label`: after a hop the relation is `(id, …channels)` and an edge-label test becomes the
 * membership form.
 *
 * **It is a FUNCTION, not the second half of `lowerChain`, and that is what makes the shape boundary
 * two-way.** `terminal()` already took an element stream to a value one; `select(label)` on a label
 * holding a vertex goes the other way, and so will a mid-chain `V()`. With the loop inline there was
 * nowhere for either to land, and a step that re-roots to an element would have had to grow its own
 * movement/filter/row-op vocabulary — the second implementation `steps/CLAUDE.md` forbids. Every host
 * now re-enters ONE loop, so a step learned here is learned at every position it can occupy.
 *
 * `bulked` — does a row stand for more than ONE traverser? Only a collapse makes that true, and a
 * slice has to know because `LIMIT n` over (element, N) rows answers a different question
 * (`bulkSlice`). It is a fact about the relation the algebra cannot state — `bulk` is a channel
 * whether its value is 1 or not — so it rides beside `rel` exactly as `elem` does. Conservative on
 * purpose: a `dedup` resets the multiplicity to 1 and this does not learn that, which costs the
 * heavier slice form and never a wrong answer.
 */
function elementTail(
  seed: Rel, elem0: Elem, steps: readonly IRStep[], from: number, bulked0: boolean,
  ctx: ChainCtx, fresh: Minter, aliases: AliasMap,
): Tail | null {
  let rel = seed;
  let elem = elem0;
  let bulked = bulked0;
  let labels = aliases;
  let at = from;
  for (; at < steps.length; at++) {
    const step = steps[at];
    const moved: { rel: Rel; elem: Elem } | null = movement(step, { rel }, elem, fresh);
    if (moved) {
      // The mutual exclusion is read off the RELATION (see `coalesce`): a movement under a live
      // emission order must not collapse, whether that order was seeded at the source or minted by
      // an `order()` further up. Getting this from `demandsEncounter` alone built a collapse that
      // dropped the encounter column its own declared type still promised — caught by the factory as
      // a join-width mismatch three nodes later, found by a sweep calling `lowerToRel` directly.
      // `groupableChannels` is the SECOND condition and it is read off the channel policy table, not
      // off a list of roles: a collapse GROUPS convergent walks, so every channel it carries must have
      // a defined answer when N rows become one. `bulk` adds and `encounter` takes the earliest; an
      // ALIAS binding belongs to ONE of the merged walks and a grouping would take whichever row
      // SQLite reached first. Naming `alias` here instead would be the widen-a-check-per-case mistake
      // `CHANNEL_GROUP_POLICY` replaced — the encounter half already reads the relation for the same
      // reason. `check` catches it either way (the obligation refuses a grouped Aggregate carrying a
      // non-combinable role), but as a THROW where legacy answers, which is the one failure the
      // routing switch cannot absorb: `rel-sweep` found exactly that on `V().as('a').both()`.
      const collapsing = ctx.collapse && !encounterOf(moved.rel.channels) && groupableChannels(moved.rel.channels);
      rel = collapsing ? coalesce(moved.rel, fresh) : moved.rel;
      bulked = bulked || collapsing;
      elem = moved.elem;
      continue;
    }
    const clause = sourceFilter(step, { id: col(rel.id, 'id'), rel }, elem, fresh, ctx);
    // `rel.channels`, NOT `BULK`: a `Filter` is channel-preserving by contract (§3.5), so naming a
    // list rather than passing the input's through is a chance to name a SHORTER one — and under
    // `demandsEncounter` the relation carries `bulk` AND `encounter`, so the hardcoded `BULK` dropped
    // the position its own input still declared. The factory catches it (`filter changed its carried
    // channels`), which made a fail-closed VIOLATION rather than a wrong answer: RelIR threw where
    // legacy answers. Found by L5 on a generated `E().limit(1).has(…).where(…)` — no corpus traversal
    // has that prefix, so the corpus sweep could not reach it.
    if (clause) { rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause }); continue; }
    // `as()` is SHAPE-PRESERVING at every position, which is why it sits in the ordinary loop rather
    // than at a boundary: the payload passes through and only the alias channels change.
    if (step.name === 'as') {
      const bound = bindAliases(step, rel, labels, { kind: 'element', elem, id: col(rel.id, 'id') }, fresh);
      if (!bound) return null;
      rel = bound.rel;
      labels = bound.aliases;
      continue;
    }
    if (step.name === 'select') {
      if (pathCarried(rel)) return null;
      const selected = selectOne(step, rel, labels, fresh);
      if (!selected) return null;
      return continueAs(selected.rel, readFraming(selected.read), steps, at + 1, bulked, ctx, fresh, labels);
    }
    if (step.name === 'union' || step.name === 'choose') {
      const framing = { kind: 'elements', elem } as const;
      const merged = step.name === 'union'
        ? unionArms(step, rel, framing, bulked, ctx, fresh, labels)
        : chooseArms(step, rel, elem, framing, bulked, ctx, fresh, labels);
      if (!merged) return null;
      // `bulked` after a merge is deliberately CONSERVATIVE: an arm may have collapsed and the arm
      // lowering does not report it back, so a following slice takes the cumulative-`SUM(bulk)` form.
      // At bulk 1 that is the same answer as the plain slice, so the cost is SQL shape and never
      // correctness — the same trade the movement loop already makes.
      return continueAs(merged.rel, merged.framing, steps, at + 1, bulked || ctx.collapse, ctx, fresh, labels);
    }
    if (step.name === 'path') {
      if (!pathCarried(rel) || step.optionArms || (step.args ?? []).length
        || step.from !== undefined || step.to !== undefined) return null;
      const positions = pathPositions(rel, step, childSeam(ctx, fresh), fresh);
      if (!positions) return null;
      return continueAs(positions.rel, { kind: 'path', of: positions.of, scalars: positions.scalars }, steps, at + 1, false, ctx, fresh, labels);
    }
    if (step.name === 'addE') {
      if (pathCarried(rel)) return null;
      const added = addedEdges(rel, elem, steps, at, labels, ctx, fresh);
      if (!added) return null;
      // The LABELS carry, for `addV`'s reason and by its mechanism — the created edges correlate back
      // to the incoming row that made them. Re-entering with `NO_ALIASES` is what made a SECOND `addE`
      // decline: the relation still carried the alias columns, so the next `from("a")` was looking for
      // a label the fold had just forgotten it had.
      const tail = elementTail(added.effects.result, 'edge', steps, added.at, false, ctx, fresh, labels);
      if (!tail) return null;
      return { ...tail, effects: [...added.effects.bindings, ...(tail.effects ?? [])] };
    }
    // `groupCount()` with no side-effect label — a BARRIER whose result is one map. It is terminal by
    // construction here: `continueAs`'s map arm declines a step after one until the map re-entry
    // vocabulary (unfold to entries, select(Column.*)) exists, so this cannot silently drop a tail.
    if (step.name === 'groupCount' || step.name === 'group') {
      if (pathCarried(rel)) return null;
      const grouped = groupBarrier(rel, elementHost(rel, elem), step, bulked, childSeam(ctx, fresh), fresh);
      if (!grouped) return null;
      return continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }
    if (step.name === 'mergeV' || step.name === 'mergeE') {
      if (pathCarried(rel)) return null;
      const merged = mergedElements(rel, elem, steps, at, labels, ctx, fresh);
      if (!merged) return null;
      // The LABELS carry for `addV`'s reason and by `addV`'s mechanism, but the correlation is a cross
      // join rather than a positional one: a merge emits the elements its SEARCH found, and no incoming
      // row produced any of them.
      const tail = elementTail(merged.effects.result, step.name === 'mergeE' ? 'edge' : 'vertex', steps, merged.at, false, ctx, fresh, labels);
      if (!tail) return null;
      return { ...tail, effects: [...merged.effects.bindings, ...(tail.effects ?? [])] };
    }
    if (step.name === 'addV') {
      if (pathCarried(rel)) return null;
      const added = addedVertices(rel, steps, at, ctx, fresh);
      if (!added) return null;
      // The LABELS carry, because the relation carries their columns: `addV` correlates its new rows
      // back to the input row that made them, so a label bound before the creation is still bound
      // after it. Re-entering with `NO_ALIASES` here made the next `as()` mint a column the relation
      // already carried — a THROW from the lowering, which `rel-sweep`'s contract forbids.
      const tail = elementTail(added.effects.result, 'vertex', steps, added.at, false, ctx, fresh, labels);
      if (!tail) return null;
      return { ...tail, effects: [...added.effects.bindings, ...(tail.effects ?? [])] };
    }
    if (step.name === 'property') {
      if (pathCarried(rel)) return null;
      // The whole RUN of property() steps, because they share one target: taking them one at a time
      // would snapshot the same elements once per step and, worse, let a later step read a graph an
      // earlier one had already written. `elementProperty` re-enters this loop at `at`, so a read
      // tail after the run is the ordinary fold and nothing here knows it happened.
      let end = at;
      while (end < steps.length && steps[end]!.name === 'property') end++;
      const writes = propertyWrites(steps.slice(at, end), elem, childSeam(ctx, fresh));
      if (!writes) return null;
      const written = elementProperty(rel, elem, writes, fresh);
      if (!written) return null;
      const tail = elementTail(written.result, elem, steps, end, bulked, ctx, fresh, labels);
      if (!tail) return null;
      // Effects run BEFORE anything the tail computes, and a tail of its own (a nested write) lands
      // after them — one flat list, in the order the fold produced it.
      return { ...tail, effects: [...written.bindings, ...(tail.effects ?? [])] };
    }
    if (step.name === 'drop') {
      if (pathCarried(rel)) return null;
      // TERMINAL by the grammar, and asserted rather than assumed: a step after `drop()` would be a
      // read over a stream that no longer exists, and the honest answer to a chain the passes should
      // have rejected is to decline it, not to lower the prefix and forget the rest.
      if (at !== steps.length - 1 || step.modulators?.length || step.optionArms || (step.args ?? []).length) return null;
      const dropped = elementDrop(rel, elem, fresh);
      return { rel: dropped.result, framing: { kind: 'discard' }, aliases: NO_ALIASES, effects: dropped.bindings };
    }
    const row = rowOp(step, rel, elem, bulked, ctx, fresh);
    if (!row) break;
    rel = row;
  }

  if (at === steps.length) return { rel, framing: { kind: 'elements', elem }, aliases: labels };

  if (pathCarried(rel)) return null;
  const retyped = terminal(steps[at], rel, elem, fresh);
  if (!retyped) return null;

  return scalarTail(retyped.rel, retyped.framing, steps, at + 1, bulked, ctx, fresh, labels);
}

/**
 * GIVEN A RELATION AND ITS SHAPE, WHICH LOOP OWNS THE REST OF THE CHAIN.
 *
 * The ONE dispatcher, and it is what stops every step that produces a new shape mid-chain from
 * growing its own copy of the fold. Two already need it — a `select(label)` re-root and a branch
 * ARM MERGE — and they need the identical thing: hand a relation plus its framing to whichever loop
 * owns that shape and let the rest of the chain proceed as if it had arrived there naturally.
 *
 * TOTAL over `RelFraming`, so a shape the lowering learns to produce is a compile error here until
 * this says which loop owns it — the same discipline `spine.ts` applies at the framing seam.
 */
function continueAs(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], from: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  switch (framing.kind) {
    case 'elements': return elementTail(rel, framing.elem, steps, from, bulked, ctx, fresh, labels);
    case 'list': return listTail(rel, framing.of, steps, from, ctx, fresh, labels);
    case 'path': return pathTail(rel, framing.of, framing.scalars, steps, from, ctx, fresh, labels);
    // A value's multiplicity is the traverser's, so `bulked` carries.
    case 'scalar': return scalarTail(rel, framing, steps, from, bulked, ctx, fresh, labels);
    // A MAP is a barrier's RESULT, so a step after one re-enters a map traverser — `unfold()` to
    // entries, `select(Column.keys/values)`, a local reducer. None of that is lowered yet, so the
    // honest answer is a DECLINE and not a loop that silently drops the map.
    case 'map': return from === steps.length ? { rel, framing, aliases: labels } : null;
    // Nothing survives a discard, so nothing can follow one. `drop()` is a terminal step in the
    // grammar and the passes reject a chain that continues past it, so this is unreachable rather
    // than a decline — and saying so keeps the switch total.
    case 'discard': return null;
  }
}

/** An alias READ, as a framing. The label decides the shape; `continueAs` decides the loop. */
const readFraming = (read: AliasRead): RelFraming =>
  read.kind === 'element' ? { kind: 'elements', elem: read.elem }
    : read.kind === 'list' ? { kind: 'list', of: read.of }
      // The label's own recorded type, restored by `selectOne` (a per-row type lands back in `vtype`).
      : { kind: 'scalar', type: read.type };

/**
 * `union(a, b, …)` — the ARM MERGE, and the first production caller of the channel core's peer merge.
 *
 * Every arm is lowered from the SAME input relation, which is the whole reason the arms need no
 * machinery of their own: an arm body over the current traverser IS the ordinary fold started at that
 * relation, so `__.out('knows')` inside a `union` is the same movement it is outside one. The input
 * node is then referenced once per arm, and a node referenced more than once is a DAG share — so
 * `name` decides whether the parent becomes a CTE (§4.6) rather than each arm recomputing it.
 *
 * Traversers are a multiset, so the merge is `UNION ALL` and only `dedup()` collapses.
 *
 * Three declines, each a CHAIN FACT rather than a step name:
 *
 * - **a live EMISSION ORDER.** A branch merge's canonical key is (input traverser, arm, arm position)
 *   and the first term is unrecoverable here: `encounter` is ONE slot which every fan-out inside an
 *   arm re-mints in place, so two arms rank independently and merging them interleaves the streams
 *   (§11). Recovering it needs the `origin`/`branchOrder` channels, which this route does not carry
 *   and `spine.ts` has no framing translation for. Measured: 5 of the 70 branch-blocked corpus
 *   traversals demand an order, and every one of them contains other uncovered steps as well.
 * - **arms that disagree on their PAYLOAD.** A `Union` emits its arms positionally, so a scalar arm
 *   carrying a per-row `vtype` cannot merge with one that does not. Legacy NULL-pads to the widest
 *   arm; padding is a framing decision about what the absent type MEANS, so it declines here rather
 *   than being guessed at.
 * - **an arm that BINDS a label.** Arms mint alias columns independently from the same seed, so their
 *   raw column names collide and the merge owes each arm a projection remapping onto a canonical
 *   column. That is the alias half of the merge contract and it is a further increment.
 */
function unionArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): { readonly rel: Rel; readonly framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms) return null;
  // Read off the RELATION, not off `demandsEncounter`: what matters is whether a position is
  // physically carried here, which an `order()` upstream can make true where the chain-global flag
  // does not, and vice versa.
  if (encounterOf(input.channels)) return null;

  const args = argValues(step);
  if (args.length < 2 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((body) => !body?.length)) return null;

  const arms: Tail[] = [];
  for (const body of bodies) {
    const arm = continueAs(input, framing, body!, 0, bulked, ctx, fresh, labels);
    if (!arm) return null;
    arms.push(arm);
  }
  return mergeArms(arms, input, labels, fresh);
}

/**
 * THE MERGE ITSELF — n arms into one `Union`, with every agreement the algebra needs asserted.
 *
 * Split from `unionArms` because `choose()` produces its arms differently (each is guarded by the
 * condition or its negation) and merges them identically. The arm-shape rules are the merge's, not
 * `union`'s, so there is one place they are stated.
 */
function mergeArms(arms: readonly Tail[], input: Rel, labels: AliasMap, fresh: Minter): { readonly rel: Rel; readonly framing: RelFraming } | null {
  const [first, ...rest] = arms as [Tail, ...Tail[]];
  // The arms must agree on SHAPE, and `sameFraming` is the whole test: an element arm and a scalar
  // arm merge to legacy's VARIANT stream, which is a shape this route does not produce.
  if (rest.some((arm) => !sameFraming(first.framing, arm.framing))) return null;
  // …and on their declared COLUMNS, name for name, because a Union is positional.
  if (rest.some((arm) => !sameColumns(first.rel.type.cols, arm.rel.type.cols))) return null;
  // An arm that bound a label would have to be remapped onto a canonical column (see above).
  if (arms.some((arm) => arm.aliases.size !== labels.size)) return null;
  // AN ARM THAT MINTS RIGID STATE DECLINES, and this is the check the channel core would otherwise
  // make by THROWING — which is right inside the core and wrong here, where the contract is `null`.
  // The reachable case is an arm-local `order()`: it mints an emission order INSIDE the arm, so two
  // arms arrive independently numbered from 1 and the merged stream has two positions claiming to be
  // one. `rigidChannels` is why the peer merge refuses it rather than picking a winner, and asking
  // here is what turns that refusal into a deferral (found by `rel-sweep` on
  // `union(out(…).order().by(k).limit(2), …)`).
  if (arms.some((arm) => !sameChannels(input.channels, arm.rel.channels))) return null;

  // The merged list, from the core rather than assembled here. Today the arms are required to agree,
  // so the peer merge has nothing to reconcile and this is a derivation rather than a reconciliation
  // — it earns its keep when the alias half lands, since an alias is the one FORKABLE role and a
  // label bound in one arm is exactly what `union` merge policy exists for.
  const channels = mergeChannels(input.channels, arms.map((arm) => arm.rel.channels), { rigid: 'peer' });
  return {
    rel: make.union({
      id: fresh('un'), inputs: arms.map((arm) => arm.rel), all: true,
      channels, type: first.rel.type,
    }),
    framing: first.framing,
  };
}

/**
 * `choose(<condition>, <then>[, <else>])` — a branch whose arms are GUARDED rather than unconditional.
 *
 * TinkerPop's `ChooseStep`: exactly one arm fires per traverser, decided by whether the condition
 * traversal produces output. So it is the SAME merge as `union` over arms filtered by the condition and
 * its negation — which is why this is twenty lines rather than a second branch implementation, and why
 * it inherits every one of the merge's agreement rules for free.
 *
 * **An absent `else` arm is `identity`, not "drop the traverser"** — `choose(pred, then)` passes a
 * non-matching traverser through unchanged. An empty body expresses that exactly: `continueAs` over
 * zero steps returns the relation it was handed, so the false arm is the filtered input and no special
 * case is needed for the two-argument form.
 *
 * The OPTION form (`choose(<key>).option(v, arm)…`) is a different question — a CASE over a projected
 * key rather than a boolean — and declines here; it is the family's next arm.
 */
function chooseArms(
  step: IRStep, input: Rel, elem: Elem, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): { readonly rel: Rel; readonly framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms) return null;
  if (encounterOf(input.channels)) return null;
  const args = argValues(step);
  if (args.length < 2 || args.length > 3 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  const [condition, then, otherwise] = bodies;
  if (!condition?.length || !then?.length) return null;

  const pred = bodyPredicate(condition, { id: col(input.id, 'id'), rel: input }, elem, fresh, ctx);
  if (!pred) return null;
  const guarded = (negated: boolean): Rel => make.filter({
    id: fresh('cg'), input, channels: input.channels, type: input.type,
    pred: negated ? { kind: 'unary', op: 'not', arg: pred } : pred,
  });

  const armThen = continueAs(guarded(false), framing, then, 0, bulked, ctx, fresh, labels);
  // The else arm over ZERO steps is `identity` on the complement — see above.
  const armElse = continueAs(guarded(true), framing, otherwise ?? [], 0, bulked, ctx, fresh, labels);
  if (!armThen || !armElse) return null;
  return mergeArms([armThen, armElse], input, labels, fresh);
}

/** Do two framings describe the same stream? A shape mismatch between arms is a variant stream, which
 *  is why this is an equality rather than a merge. */
const sameFraming = (left: RelFraming, right: RelFraming): boolean =>
  left.kind === 'elements' ? right.kind === 'elements' && left.elem === right.elem
    : left.kind === 'list' ? right.kind === 'list' && JSON.stringify(left.of) === JSON.stringify(right.of)
      // A path arm compares `scalars` as well as the member encoding, and it has to: two arms whose positions
      // are elements in one and projected values in the other agree on `of` (both are typed trees) and
      // disagree about whether the merged path may re-enter the list vocabulary.
      : left.kind === 'path'
        ? right.kind === 'path' && left.scalars === right.scalars && JSON.stringify(left.of) === JSON.stringify(right.of)
      // A DISCARD is not a stream, so no arm can be one: `drop()` is terminal, and an arm body ending
      // in it would be a branch whose arms disagree about whether a traverser exists at all.
      : left.kind === 'discard' ? false
        // A MAP arm would be a branch whose arms each produce a whole map — expressible in principle,
        // and nothing builds one yet, so an equality that guessed would be untested code.
        : left.kind === 'map' ? false
          : right.kind === 'scalar' && JSON.stringify(left.type) === JSON.stringify(right.type);

const sameColumns = (left: readonly ColMeta[], right: readonly ColMeta[]): boolean =>
  left.length === right.length && left.every((column, i) => column.name === right[i]!.name);

/**
 * `addV(…)` plus the `property()` run that belongs to it — the creation and its initializers as ONE
 * step of the fold.
 *
 * The run is taken whole for the reason `property()`'s is: they share the elements they write, so
 * lowering them one at a time would re-snapshot the same rows and let a later write read a graph an
 * earlier one had already changed. `addLabel` after an `addV` is deliberately NOT absorbed here — it
 * is more labels on the same vertex, which is a different statement and a further increment; the fold
 * simply does not know the step and declines.
 */
/** `addE(…)` plus the `from`/`to`/`property` cluster that belongs to it — legacy's `parseEdgeCluster`
 *  scans the same run, and the members may come in any order. */
function addedEdges(
  input: Rel, elem: Elem, steps: readonly IRStep[], at: number, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
): { readonly effects: Effects; readonly at: number } | null {
  const CLUSTER = new Set(['from', 'to', 'property']);
  let end = at + 1;
  while (end < steps.length && CLUSTER.has(steps[end]!.name)) end++;
  const effects = elementAddE(
    input, elem, steps[at]!, steps.slice(at + 1, end), aliases, ctx.ordered, childSeam(ctx, fresh), fresh,
  );
  return effects && { effects, at: end };
}

/**
 * THE CHILD SEAM, IMPLEMENTED — `child.ts` declares the three answers, this builds them (§6·6).
 *
 * One object rather than the four it replaces, and the reason is not tidiness: every consumer now
 * reaches every answer, so a child body works wherever a child body is LEGAL rather than wherever a
 * host happened to be taught one. The recursive folds stay HERE while the declaration lives beside the
 * vocabularies that consume it, which is what keeps the module DAG one-way — the four spellings each
 * used that inversion separately and this is the same move made once.
 */
const childSeam = (ctx: ChainCtx, fresh: Minter): ChildSeam => ({
  params: ctx.params,
  sideEffects: ctx.sideEffects,
  scalar: (body, host) => scalarChild(body, host, ctx, fresh),
  predicate: (body, subject, elem, negated) => (negated
    ? correlatedExists(body, subject, elem, fresh, ctx, true)
    : bodyPredicate(body, subject, elem, fresh, ctx)),
  rooted: (steps) => rootedRead(steps, ctx, fresh),
  body: (nested, scope) => (scope === 'child'
    ? bodyOf(nested, ctx.params, ctx.sideEffects)
    : rootedSteps(nested, ctx.params, ctx.sideEffects)),
});

/**
 * A ROOTED chain, lowered — the seam's third answer, POLICY-FREE.
 *
 * The admission rules that used to live here (a vertex stream for an endpoint, a list framing for a
 * set-op operand, no effects for either) belong to the CONSUMERS, and moving them out is what makes
 * this one answer rather than the union of its callers' requirements. What stays is the one thing that
 * is the seam's own: an empty chain has nothing to lower.
 *
 * NO opaque escape node is involved and none is needed (§6·1): the sub-read is lowered by the SAME
 * fold into the SAME algebra, spliced in as an ordinary relation. If the inner chain is not covered,
 * this declines and the whole traversal goes to legacy — the decline contract, one level down.
 */
function rootedRead(steps: readonly IRStep[], ctx: ChainCtx, fresh: Minter): RootedRead | null {
  if (!steps.length) return null;
  const chain = lowerChain(steps, {
    params: ctx.params, collapse: ctx.collapse, correlatedChildren: ctx.correlatedChildren,
    labelCardinality: ctx.labelCardinality, sideEffects: ctx.sideEffects,
  }, fresh);
  if (!chain) return null;
  return chain.effects ? { rel: chain.rel, framing: chain.framing, effects: chain.effects } : { rel: chain.rel, framing: chain.framing };
}

/** A nested ROOTED traversal's steps, normalized — or `null` where normalizing RAISES (a deferral
 *  the spine that owns the message will raise for itself). A rooted body goes through
 *  `normalize(stepChain(…))` and not `childSteps`, which strips a source and answers the empty chain,
 *  i.e. an endpoint that silently matched nothing. Legacy's `resolveEndpoint` reaches the same two
 *  functions, so the two routes normalize a nested endpoint identically. */
function rootedSteps(nested: unknown, params: Record<string, any>, sideEffects?: Map<string, any>): readonly IRStep[] | null {
  try { return normalize(stepChain(nested, params), params, sideEffects).steps as IRStep[]; } catch { return null; }
}

/** A nested body as a VALUE expression — the seam's correlated-SCALAR answer. Collection, selection
 * and branching still decline for later arms. */
function scalarChild(body: readonly IRStep[], host: ChildHost, ctx: ChainCtx, fresh: Minter): Expr | null {
  if (!body.length) return null;
  if (host.kind !== 'element') return null;

  // THE MOVEMENT-THEN-REDUCER ARM is `correlatedExists` minus EXISTS: root the first hop directly at
  // the outer row, then hand the rest to the ordinary fold. A movement is required in this increment,
  // so bare `__.count()` and `__.label().count()` fall through to the expression arm and decline.
  const child = movement(body[0]!, { correlated: host.id }, host.elem, fresh);
  if (child) {
    const tail = continueAs(child.rel, { kind: 'elements', elem: child.elem }, body, 1, false, ctx, fresh, NO_ALIASES);
    if (!tail || tail.framing.kind !== 'scalar'
      || (tail.framing.result !== 'count' && tail.framing.result !== 'number')) return null;

    // A per-row scalar tail could emit MANY rows and SQLite would silently take its first; only the
    // reducing framings above have collapsed the child to one row. A fence anywhere below is also a
    // decline: this plan is correlated to the outer row, and a Materialize forces a named CTE that
    // cannot reference it.
    let materialized = false;
    forEachRel(tail.rel, (rel) => { if (rel.kind === 'materialize') materialized = true; });
    if (materialized) return null;

    // `count()` and the numeric reducers deliberately differ only in empty-input productivity.
    // CountGlobalStep seeds 0, while SumGlobalStep leaves NON_EMITTING_SEED in place and
    // ReducingBarrierStep then emits no traverser (vendor/tinkerpop/gremlin-core/src/main/java/org/
    // apache/tinkerpop/gremlin/process/traversal/step/map/{CountGlobalStep,SumGlobalStep}.java and
    // step/util/ReducingBarrierStep.java). `countExpr` therefore COALESCEs to 0; `reducerAggregate`
    // leaves SQL's NULL alone, and the existing traversal-`by()` productivity filters drop it.
    const scalar = make.project({
      id: fresh('bc'), input: tail.rel, channels: [], type: typeOf(meta('v', 'any', true)),
      exprs: [['v', col(tail.rel.id, 'v')]],
    });
    return { kind: 'scalar', plan: scalar };
  }

  let value: Expr = host.id;
  let at = 0;
  const leading = body[0];
  if (leading?.name === 'values') {
    const args = argValues(leading);
    if (args.length !== 1 || typeof args[0] !== 'string') return null;
    const projected = byExpr({ key: { kind: 'property', key: args[0] } }, host, fresh);
    if (!projected) return null;
    value = projected;
    at = 1;
  } else if (leading?.name === 'label' || leading?.name === 'id') {
    if ((leading.args ?? []).length) return null;
    const projected = byExpr({ key: { kind: 'token', token: leading.name } }, host, fresh);
    if (!projected) return null;
    value = projected;
    at = 1;
  } else if (leading?.name === 'constant') {
    const args = argValues(leading);
    if (args.length !== 1) return null;
    // Productivity is EMISSION, not NULLNESS: TraversalProduct.java explicitly says null is a valid
    // productive value (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/
    // process/traversal/util/TraversalProduct.java`). This route currently expresses productivity
    // through NULLNESS, which coincides for every buildable body except one that deliberately emits
    // null. Decline until the queued ByChild signature refinement reports emission separately.
    if (args[0] === null) return null;
    const projected = constLit(leading.args[0]);
    if (!projected) return null;
    value = projected;
    at = 1;
  }

  // A BODY MUST NAME ITS SUBJECT, and this guard is the difference between declining and answering
  // nonsense. Without it a transform-only body falls through with `value` still the element's ROWID, so
  // `order().by(__.toUpper())` lowers to `upper(<rowid>)` — a plausible-looking answer to a traversal
  // TinkerPop REJECTS (`The toUpper() step can only take string as argument`), which is the worst
  // direction the "never answer a different question" rule has. A transform needs a value in front of
  // it; an element is not one. Measured on this very increment, so it is a guard with a witness.
  if (at === 0) return null;

  for (; at < body.length; at++) {
    const step = body[at]!;
    if (!REL_TRANSFORMS.has(step.name)) return null;
    const transformed = transformExpr(step, value, false);
    if (!transformed) return null;
    value = transformed.expr;
  }
  return value;
}

function addedVertices(
  input: Rel, steps: readonly IRStep[], at: number, ctx: ChainCtx, fresh: Minter,
): { readonly effects: Effects; readonly at: number } | null {
  let end = at + 1;
  while (end < steps.length && steps[end]!.name === 'property') end++;
  const effects = elementAddV(input, steps[at]!, steps.slice(at + 1, end), ctx.ordered, ctx.labelCardinality, childSeam(ctx, fresh), fresh);
  return effects && { effects, at: end };
}

/** `mergeV(map)`/`mergeE(map)` plus its cluster — the `option()` arms that MODULATE it, then the
 *  `property()` run that acts on its OUTPUT. The order is upstream's and it is load-bearing (an
 *  `option()` after a property tail is not a merge arm), so the two runs are taken in sequence rather
 *  than as one set.
 *
 *  ONE cluster scanner for both merges, because the cluster is the same: what differs is only the
 *  element the map describes, which is the lowering's business and not the scan's. `elem` is the
 *  INCOMING stream's kind and `aliases` the labels bound before it — both only `mergeE` reads, for
 *  its endpoints: `option(Merge.outV, __.select("x"))` is an alias read, and an omitted endpoint is
 *  the incoming traverser, which a non-vertex stream cannot supply. */
function mergedElements(
  input: Rel, elem: Elem, steps: readonly IRStep[], at: number, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
): { readonly effects: Effects; readonly at: number } | null {
  let options = at + 1;
  while (options < steps.length && steps[options]!.name === 'option') options++;
  let end = options;
  while (end < steps.length && steps[end]!.name === 'property') end++;
  const arms = steps.slice(at + 1, options);
  const tail = steps.slice(options, end);
  const child = childSeam(ctx, fresh);
  const effects = steps[at]!.name === 'mergeE'
    ? elementMergeE(input, elem, steps[at]!, arms, tail, aliases, ctx.ordered, child, fresh)
    : elementMergeV(input, steps[at]!, arms, tail, ctx.ordered, ctx.labelCardinality, child, fresh);
  return effects && { effects, at: end };
}
