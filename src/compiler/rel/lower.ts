import { groupableChannels, mergeChannels, sameChannels, withChannel, type Channel, type ChannelRole, type Channels } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, param, type BinaryOp, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { BindBudgetExceeded, DO_BIND_CAP } from '../../rel/check.ts';
import { emit, emitRelational } from '../../rel/emit.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import { indexSeek, semijoin, trigramSeek } from '../../rel/passes/semijoin.ts';
import { render } from '../../sql/kernel/q.ts';
import { plan as program, type Binding, type Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import { exprChildren, forEachRel } from '../../rel/walk.ts';
import type { ColMeta, SortTerm } from '../../rel/types.ts';
import { armBatches, assertsGType, collectionAssert, isLocalScope, isStreamBarrier, PATH_LIST_OPS, type Slice, sliceOf, sliceParamNames, typeOfAssert } from '../ir/step.ts';
import { labelReads, labelsBoundBefore } from '../ir/labels.ts';
import { bulkObservedFrom } from '../ir/bulk.ts';
import { meetScalarTypes, memberTypeOf, MERGED_VTYPE, PER_ROW, perRowColumnOf, STATIC, staticTypeOf, UNKNOWN, type ListOf, type MapOf, type ScalarType, type Shape, type ValueType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { fieldNamed, type FramedRel, type RecordField, type RelFraming } from './framing.ts';
import { recordField, recordNode, recordOf, recordPayload, recordToMap, selectKeys } from './record.ts';
import { applyLeg, classifyWhereLeg, lowerMatch } from './match.ts';
import { propertyElement, propertyHasClause, propertyId, propertyIdentityKey, propertyKey, propertyOrderTerms, propertyPayload, propertyReadOf, propertyRelation, propertyRowId, propertyValue } from './property.ts';
import type { RelCallSite, Service } from '../../services/spi/types.ts';
import { parseCallSpec } from '../../services/params/call-params.ts';
import { isColumnArg, isNested, isPred, isTokenArg, stepChain, argValues, arg, type Arg, type MergePolicy } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, type TypeNode } from '../../gremlin/types.ts';
import { constLit, countLit, itemTypeAt, sliceBound } from './const.ts';
import { BY_HOSTS, isStreamIdentity, type IRStep } from '../ir/strategies.ts';
import { analyzeChain, type ChainFacts } from '../ir/analyze.ts';
import { childSteps, normalize } from '../ir/passes.ts';
import { alwaysProduces, MAPPING_TERMINAL } from '../ir/productivity.ts';
import { CONSTANT, predicateExpr, storedCompareOn, SUBJECT_UNKNOWN, type SubjectType } from './predicate.ts';
import { CoercionDeferral, foldConstantCoercions, injectValueTypes, ValueParseError } from '../../gremlin/coerce.ts';
import {
    and, byEncounter, carriedCols, EDGE_COLS, elementCols, eq, jsonEachSet, JSON_NUMERIC_TYPES, JSON_TEXT_TYPES,
    jsonMemberByTypeof, keyMembership, labelIds, labelSetArgs, meta, minter, NODE_COLS, notProduced, or, payloadCols, PROPERTIES, propertyKeyArgs, renumber, storedValue,
    typeOf, withMergedVtype, type Minter,
} from './build.ts';
import { aliasIdAt, aliasProjection, aliasValueAt, bindAliases, liveAliases, selectSpec } from './alias.ts';
import type { AliasMap } from '../plan/alias.ts';
import { byExpr, modulations, orderProductivity, productivityFilter, propertyExists, propertyVtype, type Modulation } from './modulator.ts';
import { ALWAYS_PRODUCTIVE, type ChainRead, type ChildHost, type ChildRows, type ChildSeam, type ChildValue, type HostRow, type RootedRead, type Subject } from './child.ts';
import { REL_TRANSFORMS, transformExpr } from './transform.ts';
import { projectorTail, projectorValue, REL_PROJECTORS } from './projector.ts';
import { isLongSumClass, isReducer, reducerAggregate, sumTower } from './reducer.ts';
import { elementAddE, elementAddLabel, elementAddV, elementDrop, elementDropLabel, elementMergeE, elementMergeV, elementProperty, propertyDrop, propertyWrites, type Effects } from './write.ts';
import { BARE_LIST, collectionRetype, correlatedListMembers, foldElements, foldMaps, foldScalars, LIST_COL, LIST_FUNCTIONS, listMemberOp, listPayload, listRetype, listSetOp, NODE_COL, nonIterableTraverser, unfoldList } from './list.ts';
import { ENTRY, elementHost, elementValueMap, entrySide, groupBarrier, groupMap, groupRows, mapEntryPayload, mapKey, mapLiteralBlob, mapPayload, MAP_COL, mapSelect, mapSide, mapSize, unfoldMap } from './map.ts';
import { edgeEndpoint, elementPayload } from './element.ts';
import { foreignLabelValue, foreignRejoin, foreignRelation, foreignValues } from './foreign.ts';
import type { ForeignRow } from '../../api.ts';
import type { InjectionKind } from '../../services/spi/types.ts';
import { extendPath, PATH_CHANNEL, pathCarried, pathPayload, pathPositions, seedPath } from './path.ts';
import { type LabelRegime } from '../../api.ts';
import { sackMutate, sackOperator, sackRead, seedSack } from './sack.ts';
import { variantArm, variantArmOf, variantHasList, variantPayload, type VariantArm } from './variant.ts';
import { collectionOf, groupedKeys, readCollection, readUnfolded, registerCollection, registerGrouping, type Collections } from './collection.ts';
import { repeatWalk } from './walk.ts';
import { optionArms, type OptionArm } from '../ir/option-map.ts';
import { MUTATING_STEPS } from '../ir/strategies.ts';

/**
 * THE LOWERING — `Step[] -> RelIR`.
 *
 * The lowering grows STEP BY STEP: a traversal whose every step is covered here lowers to a `Plan`
 * and takes the RelIR route end-to-end; a traversal it does not cover raises `UnsupportedTraversal`
 * rather than falling through to anything. **A traversal is lowered wholly or not at all** — that is
 * what keeps RelIR a real algebra rather than a wrapper, and it is why there is no opaque escape node
 * and never will be (not as a bridge, not temporarily, not behind a flag).
 *
 * `null` is therefore the ONLY decline this module makes, and it must stay cheap and total: a step it
 * has not learned yet is not an error, it is coverage that has not been written — the caller turns an
 * uncovered traversal into a clear `UnsupportedTraversal`. What it must never do is answer a DIFFERENT
 * question — a partial lowering that silently drops a filter would be a wrong answer, not a clean
 * failure.
 *
 * ## What this module does NOT do
 *
 * **BYTE FRAMING.** `(rows, Shape) → Buffer[]` is `execute.ts`'s, contains no SQL, and stays per-shape
 * forever. So this returns a RELATION plus the `RelFraming` that says what the relation holds.
 *
 * **The PAYLOAD PROJECTION is a different thing and is on its way IN, not permanently out.** Today
 * `spine.ts` hands the relation to the materializer, which composes the payload SELECT — so the
 * element payload, the list/map blob reads and their `Shape` choice are still built outside the algebra.
 * §6·3 of the build plan corrects that: `materialize.ts` produces SQL, so it is a query producer and
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
   * THE WHOLE FRAMING CONTRACT — §6·3 reached, and the reason this is a `Shape` and not a `RelFraming`.
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
type Tail = ChainRead & {
  /**
   * DOES A ROW OF THIS RESULT STAND FOR MORE THAN ONE TRAVERSER — the fold's `bulked`, carried out to
   * the payload projection because the leaf is the last consumer of a multiplicity and the only one
   * that can still lose it.
   *
   * REQUIRED rather than optional, and that is the whole point: only the `elements` framing arm
   * projects a `bulk` column (`framed`), so a site that produced an element result and forgot to say
   * whether it collapsed would answer N traversers as one row. A required field makes that a compile
   * error instead of a silent fail-open. It used to be read off the collapse SWITCH, which was correct
   * only while the switch also carried the chain-global collapse verdict — once the decision is
   * positional the switch can be on where nothing collapsed, and projecting a constant-1 column then
   * re-spells the SQL of every element leaf for no behaviour.
   */
  readonly bulked: boolean;
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

/**
 * THE FOLD RE-ENTERED OVER A BODY rather than over the root chain, and the one thing that changes is
 * that a collapse is OFF.
 *
 * A collapse is legal at a hop only if every consumer behind it reads the multiplicity, and
 * `bulkObservedFrom` answers that by walking the `steps` it was given to their END. For the root chain
 * that end is the wire, where an `elements` result RLEs `(v, bulk)` onto it. **For a BODY it is not:**
 * the arm of a `union`, an `option()` arm, a `where()` child or a recursive term all continue into an
 * enclosing context the body cannot see, and reaching the end of the body proves nothing about it. The
 * witness was `g.V().union(__.values("name"), __.out())` — the `out()` arm collapsed because the arm's
 * own suffix ended in an element leaf, then the enclosing VARIANT framing dropped the `bulk` column and
 * the traversers with it. A wrong answer at the wire, on a widening that had nothing to do with unions.
 *
 * So: one named narrowing at every body re-entry, rather than a per-site judgement. It costs collapse
 * opportunities inside bodies and costs nothing that was working — before the decision became
 * positional, no body ever collapsed, because a chain containing a `union`/`choose`/`repeat` was never
 * collapse-safe at all. Admitting them back is a later increment, and the thing it needs is the
 * enclosing suffix, not a relaxation here. `framed` carries the fail-closed backstop for anything this
 * misses.
 */
const inBody = (ctx: ChainCtx): ChainCtx => (ctx.collapse ? { ...ctx, collapse: false } : ctx);


/** No label bound yet. One shared value, because an empty Map is the seed at every entry point. */
const NO_ALIASES: AliasMap = new Map();

/**
 * THE PER-TRAVERSER STATE A CHILD BODY MAY READ, by the channel ROLE each step names.
 *
 * A table rather than two arms because the question is uniform: these steps do not compute anything,
 * they REFERENCE state the parent row already carries. TinkerPop's own vocabulary is the same shape —
 * `LoopsStep`/`SackStep` are both `ScalarMapStep`s whose `map` is one `traverser.x()` call, and each
 * declares what it needs through `getRequirements()` (`TraverserRequirement.SACK`/`SINGLE_LOOP`)
 * exactly as Calcite's `RelNode.getVariablesSet()` declares what a node sets.
 *
 * Roles absent here are absent on purpose: `path` and `encounter` are not scalars, and `bulk` is a
 * multiplicity the language gives no step to read.
 */
const CARRIED_READ: Readonly<Record<string, ChannelRole>> = { sack: 'sack', loops: 'loops' };

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

/**
 * THE ORIGIN CHANNEL — which HOST ROW a traverser descends from, carried through the ordinary fold.
 *
 * `src/channels.ts` has modelled the role since the channel core landed (merge `identical`, barrier
 * `empty`, a `ROLE_ORDER` slot) and nothing minted one, which is exactly where `sack` was one increment
 * earlier: the channel existed, the plumbing did not. It costs no per-step work to carry — a movement
 * preserves its input's channels by contract (§3.5) — so minting it on a relation and lowering a body
 * from there is the whole mechanism.
 *
 * It is what makes a GROUP-SCOPED reduction expressible: the child rows of every group member have to
 * pool before the reducer runs, so the value side is a JOIN the grouping aggregates over rather than a
 * scalar subquery per row — and a JOIN drops the parent's payload while keeping its channels. A
 * CORRELATED relation could not serve, because SQLite has no `LATERAL` and the correlation has to
 * become a join `ON`.
 */
const ORIGIN: Channel = { col: 'origin', role: 'origin' };
const originOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'origin');
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
/**
 * A source-scope FILTER as a predicate over the element scan — the whole of `hasLabel`/`has` that
 * needs no predicate vocabulary.
 *
 * Written against the SCAN rather than against a projected id-relation, and that is the point of the
 * exercise: the naive form gives every filter its own CTE that re-joins the element table to reach a
 * column its predecessor projected away (`… FROM nodes n JOIN c1 p ON n.id=p.id WHERE EXISTS(…)`), so
 * `has(a).has(b)` is three CTEs and two redundant self-joins. Here they conjoin into ONE `WHERE` over
 * one scan, because a filter neither changes the relation's cardinality contract nor consumes a
 * channel, and the plan is data so a later step can still see the columns.
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
  /** Does a POSITIONAL slice read the emission order downstream (`ChainFacts.demandsSlice`)? A
   *  branch merge mints one deterministic fan-out order for a COLLECT/write demand, but DECLINES
   *  when a slice reads its fan-out — a slice pins the reference's traverser-major/arm-major subset,
   *  which this spine does not mint yet. Threaded, not re-derived, for the reason `ordered` is. */
  readonly sliced: boolean;
  /** The GRAPH's declared vertex-label cardinality, which decides what a creation with no label of
   *  its own gets. Threaded for the reason `ordered` is: it is settled before a step is lowered, so a
   *  step that asked the store instead would be asking at the wrong time. */
  /** How a `T.label` ENTRY renders — a set of names or one name. Decided ONLY by an explicit
   *  `with("multilabel")`/`with("singlelabel")`, since storage no longer carries a regime to inherit
   *  from (every vertex holds a set — `src/api.ts`). Settled before a compile starts, so it travels
   *  as a value rather than being re-derived from a source-options map inside the lowering. */
  readonly labelRegime: LabelRegime;
  /** The `withSideEffect(name, constant)` registry the FRONT END extracted. See `Lowering`. */
  readonly sideEffects: Map<string, any>;
  /** The merge POLICY declared with the REDUCER form of `withSideEffect`, by label. See `Lowering`. */
  readonly sideEffectPolicies: ReadonlyMap<string, MergePolicy>;
  /** The services this chain names, resolved at the DI boundary. See `Lowering.services`. */
  readonly services: ReadonlyMap<string, Service>;
  /** `withSack(seed[, Operator.x])`'s policy, or `null`. See `Lowering.sack`. */
  readonly sack: MergePolicy | null;
  /**
   * THE NAMED COLLECTIONS this chain has filled so far — `aggregate("a")` writes one, `cap("a")`
   * reads it back.
   *
   * The one MUTABLE field here, and deliberately so: a side effect is chain-global state written at
   * one step and read at a LATER one, which is the single thing a fold's return value cannot carry.
   * `Tail` travels backwards out of the recursion; `cap` needs to see forwards from where
   * `aggregate` stood. Everything else on this interface is settled before the chain starts.
   */
  readonly collections: Collections;
  /**
   * Does this chain MUTATE the graph? Read once from the step list rather than discovered as the
   * fold proceeds, because the question it answers is about the WHOLE chain: a shared read node is
   * re-evaluated by every statement that names it, so a named collection in a program with effects
   * would see the graph AFTER the write. §3.0's answer to that is a `snapshot` binding, which is the
   * increment this one is a prerequisite for rather than a shortcut it may take.
   */
  readonly mutating: boolean;
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
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
): Expr | null {
  // A MOVEMENT NEEDS AN ELEMENT TO MOVE FROM. A scalar traverser has no adjacency, so this arm is not
  // "not yet taught" for one — it is the arm that does not apply, and `bodyPredicate` falls through to
  // the two that do.
  if (subject.kind !== 'element') return null;
  const elem = subject.elem;
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
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx,
): Expr | null {
  let clause: Expr | undefined;
  for (const step of body) {
    const filter = sourceFilter(step, subject, fresh, ctx);
    if (!filter) return correlatedExists(body, subject, fresh, ctx, false)
      ?? valuePredicate(body, subject, fresh, ctx, false)
      ?? projectionProductive(body, subject, fresh, ctx);
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
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx,
): Expr | null {
  const produced = scalarChild(body, childHostOf(subject), ctx, fresh);
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
function childPredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negated: boolean,
): Expr | null {
  const direct = childPredicateDirect(body, subject, fresh, ctx, negated);
  if (direct) return direct;
  // LAST RESORT — a trailing MAPPING terminal contributes nothing to the QUESTION, so ask the prefix.
  const prefix = withoutMappingTerminal(body);
  return prefix ? childPredicate(prefix, subject, fresh, ctx, negated) : null;
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
): Expr | null {
  if (!negated) return bodyPredicate(body, subject, fresh, ctx);
  // The two self-negating shapes FIRST, so every body they already answered keeps the SQL it has and
  // this is new coverage rather than a re-spelling — `valuePredicate`'s own ordering rule, one level up.
  const exact = correlatedExists(body, subject, fresh, ctx, true)
    ?? valuePredicate(body, subject, fresh, ctx, true);
  if (exact) return exact;
  const positive = bodyPredicate(body, subject, fresh, ctx);
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
function valuePredicate(
  body: readonly IRStep[], subject: Subject, fresh: Minter, ctx: ChainCtx, negate: boolean,
): Expr | null {
  const last = body.at(-1);
  if (body.length < 2 || last?.name !== 'is' || last.modulators?.length || last.optionArms) return null;
  const produced = scalarChild(body.slice(0, -1), childHostOf(subject), ctx, fresh);
  if (!produced) return null;
  const args = argValues(last);
  if (args.length !== 1) return null;
  // The value's own type is what a range comparison needs — a big long carried as decimal TEXT orders
  // lexically otherwise — and the seam now reports it, so the subject type is read rather than assumed.
  const type: SubjectType = produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static'
    ? { kind: 'static', type: produced.framing.type.type, text: produced.framing.type.text }
    : SUBJECT_UNKNOWN;
  const pred = predicateExpr(produced.expr, args[0], type, last.args[0]?.type ?? null, last.args[0]?.name ?? null, fresh);
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
const childHostOf = (subject: Subject, aliases: AliasMap = NO_ALIASES): ChildHost => {
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
function branchSubject(rel: Rel, framing: RelFraming): Subject | null {
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

/** The subject of a clause that reads an ELEMENT — a property row, a label row, an id. Named because
 *  three clause builders take it and each would otherwise re-state the narrowing in its signature. */
type ElementSubject = Extract<Subject, { kind: 'element' }>;

/** The ELEMENT subject, or `null` — the narrowing every element-only clause opens with, spelled once
 *  so an arm states "this question is about an element" rather than repeating a `kind` test. */
const elementSubject = (subject: Subject): ElementSubject | null =>
  subject.kind === 'element' ? subject : null;

function sourceFilter(step: IRStep, subject: Subject, fresh: Minter, ctx: ChainCtx): Expr | null {
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
    return element && hasLabelClause(step.args, element, fresh);
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
    return predicateExpr(subject.value, args[0], subject.type, step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh);
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
    return childPredicate(body, subject, fresh, ctx, step.name === 'not');
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
      const pred = childPredicate(body, subject, fresh, ctx, false);
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
    const present = hasPropertyClause(args[0], undefined, element, fresh);
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
      const labelled = hasLabelClause([step.args[0]!], element, fresh);
      const valued = hasPropertyClause(args[1], args[2], element, fresh, step.args[2]?.type ?? null, step.args[2]?.name ?? null);
      return labelled && valued ? and(labelled, valued) : null;
    }
    const [key, val, extra] = args;
    if (extra !== undefined) return null;
    const valType = step.args[1]?.type ?? null;
    const valParam = step.args[1]?.name ?? null;
    if (isTokenArg(key)) return hasTokenClause(key.token, val, element, fresh, valType, valParam);
    // A NULL PROPERTY KEY: no element carries a property under it, so the filter rejects everything.
    // `element.property(null)` is absent by construction, which is why `has(null, 'test-null-key')` is
    // the EMPTY result rather than a decline — and rather than the `has('test-null-key')` PRESENCE test
    // it silently became while the front end dropped the null (right answer on this fixture, by luck of
    // no vertex carrying that key).
    if (key === null) return CONSTANT.false;
    if (typeof key !== 'string') return null;
    return hasPropertyClause(key, val, element, fresh, valType, valParam);
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
function hasLabelClause(labelArgs: readonly Arg[], subject: ElementSubject, fresh: Minter): Expr | null {
  const elem = subject.elem;
  // A NULL LABEL IS INERT and an ALL-NULL SET MATCHES NOTHING — `labelSetArgs` owns both, and the second
  // is why this cannot be a `filter`: `hasLabel(null)` names a label, so it must reject every element
  // rather than fall through to "no labels named".
  const asked = labelSetArgs(labelArgs);
  if (!asked) return null;
  if (asked.given && !asked.labels.length) return CONSTANT.false;
  // An inline label inlines, a `$label` / `$labels` binds — all inside `labelIds`. An EMPTY argument list
  // reaches here only from a marker the Pass tier should have rewritten, so it declines.
  if (!asked.labels.length) return null;
  const ids = labelIds(asked.labels, fresh);
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
function hasPropertyClause(key: string, val: unknown, subject: ElementSubject, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null): Expr | null {
  const elem = subject.elem;
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
function hasTokenClause(token: string, val: unknown, subject: ElementSubject, fresh: Minter, valType: TypeNode | null = null, valParam: string | null = null): Expr | null {
  const elem = subject.elem;
  const name = token.toLowerCase();
  if (name !== 'label' && name !== 'id') return null;
  if (val === undefined) return null;

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
 * `V(...)` / `E(...)` — the element source: one row per element at bulk 1, narrowed by an id list
 * bounded by the QUERY TEXT (never by row count, so `InList` is right here and a JSON bind is not).
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

  // Ids span two provenances and two columns. PROVENANCE decides bind-vs-inline: a parsed LITERAL id
  // is a constant bounded by the QUERY TEXT and INLINES (a rowid `int`, a uid `text`); a wire
  // PARAMETER (`V($x)`) BINDS, so its value never enters the statement text — a scalar as one `?`, a
  // bound collection (`V($ids)`) as ONE `jsonb(?)` exploded by `json_each`, exactly the rule the
  // `within($list)` set already keeps. COLUMN follows the value's type: a number matches the rowid
  // `id`, a string the `uid` — for a literal decided here, for a bound member decided per row by
  // json_each's own type (so a heterogeneous bound id list is faithful without our reading its data).
  const idCol = col(scan.id, 'id');
  const uidCol = col(scan.id, 'uid');
  const inlineNums: number[] = [];
  const inlineStrs: string[] = [];
  const paramClauses: Expr[] = [];
  const inlineOne = (v: unknown): boolean => {
    if (typeof v === 'number') { inlineNums.push(v); return true; }
    if (typeof v === 'string') { inlineStrs.push(v); return true; }
    return false; // an id that is neither declines — a hard error, not a value this route can inline
  };
  for (const a of step.args) {
    if (a.name == null) {
      // A CONSTANT — a bare scalar id or a bracketed list literal (`V(1, [2,3])` ≡ `V(1,2,3)`); the
      // grammar forbids a param member, so every member is itself a literal that inlines.
      const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
      for (const v of members) if (!inlineOne(v)) return null;
    } else if (Array.isArray(a.value)) {
      // A bound COLLECTION of ids → ONE `jsonb(?)` bind, exploded and routed per member by its json
      // type. The two clauses share the parameter NAME, so the render dedups them to a single bind.
      paramClauses.push({ kind: 'in-query', expr: idCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_NUMERIC_TYPES), negated: false });
      paramClauses.push({ kind: 'in-query', expr: uidCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_TEXT_TYPES), negated: false });
    } else if (typeof a.value === 'number') {
      paramClauses.push(eq(idCol, param(a.value, a.name)));
    } else if (typeof a.value === 'string') {
      paramClauses.push(eq(uidCol, param(a.value, a.name, 'text')));
    } else return null; // a bound id of another shape declines, as its inline sibling does
  }

  // Inline lists first so a param-free `V(...)` renders byte-for-byte as before; `constLit` never
  // declines a number/string, so its assertion cannot fire.
  const clauses: Expr[] = [];
  if (inlineNums.length) clauses.push({ kind: 'in-list', expr: idCol, values: inlineNums.map((n) => constLit(arg(n, 'long'))!) });
  if (inlineStrs.length) clauses.push({ kind: 'in-list', expr: uidCol, values: inlineStrs.map((s) => compilerText(s)) });
  clauses.push(...paramClauses);
  const pred = clauses.reduce<Expr | undefined>((left, right) =>
    left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
  return { scan, pred, elem };
}

/**
 * A non-start `V()` / `E()` — GraphStep's re-source operation.
 *
 * `GraphStep.processNextStart()` takes one incoming traverser, opens the graph iterator, and emits
 * `head.split(element, this)` for every element
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:193-221`).
 * Thus this is a CROSS JOIN, not a replacement scan: the arriving traverser's carried columns
 * (notably aliases and bulk) survive, while its current object is replaced by the scanned element.
 *
 * A path/sack/fromV is state whose transition through that split has not yet been given a framing
 * contract. An already-live encounter is re-minted from the composite parent/child position, then
 * replaced by the ONE encounter slot; there are never two competing carried positions. Where no
 * position arrives but this chain needs one, it is seeded from the new element id like a source scan.
 */
function reSource(
  step: IRStep, input: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter,
): { rel: Rel; elem: Elem } | null {
  if ((step.name !== 'V' && step.name !== 'E') || step.modulators?.length || step.optionArms) return null;
  if (framing.kind === 'path' || input.channels.some((channel) =>
    channel.role === 'path' || channel.role === 'sack' || channel.role === 'fromV')) return null;
  const seeded = elementScan(step, fresh);
  if (!seeded) return null;
  const source = seeded.pred
    ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred: seeded.pred })
    : seeded.scan;
  // Only the new id crosses the join. Keeping the source row's physical columns would collide with
  // an element input's `id`/`uid` columns before the payload replacement below.
  const ids = make.project({
    id: fresh('rs'), input: source, channels: [], type: typeOf(meta('sid', 'int')),
    exprs: [['sid', col(source.id, 'id')]],
  });
  // GraphStep splits one incoming traverser into element traversers. A scalar parent represents
  // one implicitly, whereas an element relation must carry it explicitly so a later movement can
  // collapse correctly. Promote it *before* the join: inventing the channel on the join result is
  // neither side's contract and leaves an Aggregate with no input bulk to sum.
  const parent = input.channels.some((channel) => channel.role === 'bulk') ? input : (() => {
    const channels = withChannel(input.channels, BULK[0]!);
    const payload = input.type.cols.filter((column) => !input.channels.some((channel) => channel.col === column.name));
    return make.project({
      id: fresh('rp'), input, channels, type: typeOf(...payload, ...carriedCols(channels)),
      exprs: [
        ...payload.map((column) => [column.name, col(input.id, column.name)] as const),
        ...channels.map((channel) => [channel.col,
          channel.role === 'bulk' ? compilerInt(1) : col(input.id, channel.col),
        ] as const),
      ],
    });
  })();
  const arrivingEncounter = encounterOf(parent.channels);
  // A re-source with no arriving position is the one position-minting case: GraphStep's iterator
  // visits the scanned elements in rowid order, so its id is the deterministic base sequence.
  // Mint AFTER the cross join rather than pretending the parent carried it: the Join contract only
  // preserves channels from its left input, while Project is the sole node allowed to declare one.
  // In a child scope this repeats the source sequence per parent, which is exactly what the later
  // per-origin window reads; a root chain that needs order has already seeded its source position.
  const channels = !arrivingEncounter && ctx.ordered
    ? withChannel(parent.channels, ENCOUNTER)
    : parent.channels;
  const crossed = make.join({
    id: fresh('j'), left: parent, right: ids, join: 'cross', channels: parent.channels,
    type: typeOf(...parent.type.cols, ...ids.type.cols),
  });
  const project = (): Rel => make.project({
      id: fresh('c'), input: crossed, channels, type: typeOf(...elementCols(channels)),
      exprs: [
        ['id', col(crossed.id, 'sid')],
        ...channels.map((channel) => [channel.col,
          channel.role === 'encounter' ? col(crossed.id, 'sid') : col(crossed.id, channel.col),
        ] as const),
      ],
    });
  if (!arrivingEncounter) return { elem: seeded.elem, rel: project() };
  // Parent outer iteration then source rowid is the iterator order GraphStep realizes. `renumber`
  // consumes those temporary keys and leaves a single total encounter column on the result.
  const carried = channels.filter((channel) => channel.role !== 'encounter');
  const staged = make.project({
    id: fresh('c'), input: crossed, channels: [],
    type: typeOf(meta('id', 'int'), ...carriedCols(carried), meta('parent_encounter', 'int'), meta('source_id', 'int')),
    exprs: [
      ['id', col(crossed.id, 'sid')],
      ...carried.map((channel) => [channel.col, col(crossed.id, channel.col)] as const),
      ['parent_encounter', col(crossed.id, arrivingEncounter.col)], ['source_id', col(crossed.id, 'sid')],
    ],
  });
  return {
    elem: seeded.elem,
    rel: renumber(staged, [
      { expr: col(staged.id, 'parent_encounter'), dir: 'asc' },
      { expr: col(staged.id, 'source_id'), dir: 'asc' },
    ], elementCols(channels), channels, fresh),
  };
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
 *  is a hard error; here it is a decline rather than this route inventing a second message. */
const FROM_EDGE = new Set(['inV', 'outV', 'bothV']);

/**
 * Where a hop starts from: an incoming id-RELATION (the ordinary case, joined) or a single
 * correlated id EXPRESSION (a child body's first hop, compared).
 *
 * The correlated form is what lets a `where()` body be lowered with no seed node at all. A
 * `(SELECT n.id AS id) p` — a projection with no input — is a shape RelIR has no node for, and §7's
 * bar says a missing node needs proof the seam cannot EXPRESS the shape. It can: compare the edge
 * column to the outer expression directly, which is one derived table FEWER than the alternative.
 * Both arms produce the same `(id, bulk)` shape, so every hop after the first is the ordinary one and
 * there is no second movement implementation.
 */
type Frontier = { readonly rel: Rel } | { readonly correlated: Expr };
const frontierRel = (from: Frontier): Rel | undefined => ('rel' in from ? from.rel : undefined);

function movement(step: IRStep, from: Frontier, elem: Elem, fresh: Minter): { rel: Rel; elem: Elem } | null {
  const hops = HOPS[step.name];
  if (!hops || step.modulators?.length || step.optionArms) return null;
  if (FROM_EDGE.has(step.name) !== (elem === 'edge')) return null;

  // A movement's arguments are edge LABELS. An inline label inlines; a `$label` / `$labels` parameter
  // binds through `labelIds`, so its data never enters the statement text. A non-string label declines.
  // `labelSetArgs` also settles the NULL forms: `out(null,'knows')` is `out('knows')` because a null
  // label matches no edge, while `out(null)` NAMED a label and therefore matches none — which is a
  // different traversal from `out()`, whose empty set means every label.
  const asked = labelSetArgs(step.args);
  if (!asked) return null;
  const labelArgs = asked.labels;
  // A label restriction is meaningless on an endpoint read — the edge is already chosen — and
  // TinkerPop's inV()/outV() take no arguments at all.
  if (asked.given && FROM_EDGE.has(step.name)) return null;

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
    const on = and(eq(col(e.id, hop.from), incoming),
      labelArgs.length ? { kind: 'in-query', expr: col(e.id, 'label'), plan: labelIds(labelArgs, fresh), negated: false }
        // NAMED labels, none of which can match — `out(null)`. NEVER, not "every label".
        : asked.given ? CONSTANT.false : undefined);
    // A correlated hop FILTERS the edge table against the outer id; a rooted one JOINS the incoming
    // frontier. The projection is identical either way, which is what keeps the second hop from
    // needing a second implementation. A correlated body's `bulk` is synthetic: an EXISTS asks
    // whether a row is there, never how many traversers it is.
    //
    // **THE INCOMING FRONTIER IS THE LEFT SIDE, AND THE JOIN IS `ordered`** — a hop is "for each
    // traverser I have, find its edges", so the stream drives and `edges` is probed through
    // `e_out(src,label,tgt)` / `e_in(tgt,label,src)`. This USED to be `edges` on the left and free
    // to reorder, "so the access path stays the one the covering
    // indexes were built for" — measured, and it is the opposite: with the order free SQLite chose
    // `e_in` and scanned the whole edge table for a hop off ONE vertex, taking a 4 000-vertex
    // `has(name).out(knows).values(name)` to 1 492 ms. Pinned, it seeks `e_out` and takes 0.3 ms.
    // The covering indexes were never in question — which of them the planner reaches for was.
    const source = input
      ? make.join({
        id: fresh('j'), left: input, right: e, join: 'inner', ordered: true, on, channels: carried,
        type: typeOf(meta('pid', 'int'), ...carriedCols(carried),
          meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
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
 * row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question. It emits the bare `LIMIT` there,
 * because emitting a sort over a single row would be a difference in the plan for no difference in
 * the answer.
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
  // ABOUT emission order, so a relation carrying none has no last, and the traversal declines.
  if (step.name === 'tail') {
    if (!encounter) return null;
    const last = { offset: 0, limit: countArg(step) };
    if (bulked && bulk) return bulkSlice(input, last, encounter, bulk, 'desc', fresh);
    return slice(input, last, encounter, 'desc', fresh);
  }

  // `sliceOf` throws in two DIFFERENT senses (§6·5). An illegal range (`range(2,1)`) is a
  // `ValueParseError` — the traversal's ANSWER is that error, so it PROPAGATES rather than declining
  // (catching it would turn a required error into a generic `UnsupportedTraversal`, the wrong
  // classification). Any OTHER throw is the internal "not a slice step" routing signal, which this
  // module's `null`-only decline contract catches. Found by sweeping every prefix of every corpus
  // traversal under all four switch combinations, which is the only way a decline-contract violation
  // shows up at all.
  let window;
  try { window = sliceOf(step); } catch (e) { if (e instanceof ValueParseError) throw e; return null; }
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

/** THE STEPS `rowOp` SERVES — every one of them PRESERVES the shape, which is why a tail whose other
 *  arms are retypes must route them FIRST and then recurse. Declared rather than inferred so a new
 *  row-algebraic op reaches every shape at once instead of only the tail whose author remembered it. */
const ROW_OPS: ReadonlySet<string> = new Set(['identity', 'barrier', 'order', 'dedup', ...SLICE_STEPS]);

/** The three steps that apply a CHILD BODY once per traverser. One set rather than three names at the
 *  dispatch, because what separates them is a policy inside the lowering and not which loop owns
 *  them — `perTraverserChild` is where that policy is written down. */
const PER_TRAVERSER_HOSTS = new Set(['map', 'flatMap', 'local']);

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
  // FENCE THE FILTER FROM THE OFFSET WHEN SQLITE WOULD DROP IT. `offsetDropsOverExists` decides; when
  // it holds, a `MATERIALIZED` CTE between the correlated `EXISTS` and the `OFFSET` is the fence, and it
  // goes UNDER the `order()` sort so the emission order is re-established over the materialized rows.
  const hasOffset = window.offset > 0 || window.offsetParam != null;
  const base = hasOffset && offsetDropsOverExists(input)
    ? make.materialize({ id: fresh('om'), input, channels: input.channels, type: input.type, fenced: true })
    : input;
  const source = encounter
    ? make.sort({
      id: fresh('so'), input: base, channels: base.channels, type: base.type,
      terms: [{ expr: col(base.id, encounter.col), dir }],
    })
    : base;
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
 * SQLite (measured on bun:sqlite 3.51.x AND the DO runtime) SILENTLY DROPS an `OFFSET` when the
 * offset's own `SELECT` block has a SINGLE-TABLE `FROM` and a POSITIVE correlated `EXISTS` in its
 * `WHERE`:
 * ```
 * SELECT id FROM nodes n WHERE EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id) LIMIT -1 OFFSET 1
 * ```
 * returns EVERY surviving row — a wrong ANSWER, not a reorder. A `JOIN` in the `FROM` (any movement)
 * dodges it; `NOT EXISTS`, an uncorrelated `IN (SELECT …)` and a scalar `(SELECT …) > 0` do not
 * trigger it. That is why `propertySeek` — which lifts a `has()`'s `EXISTS` into a join — masked the
 * defect on the ONE traversal `known.ts` recorded, while the whole `where(…)`/`has(…)`-then-`skip`
 * family answered wrong in production under the DEFAULT config. A differential comparing two lowerings
 * could not have seen it — the bug would sit identically in both — which is the blind-spot class L5's
 * own header names. The fence is a `MATERIALIZED` CTE between the filter and the offset (`slice`).
 *
 * This decides when the fence is needed: does the offset's block FUSE a positive correlated `EXISTS`
 * onto a bare scan? It walks the block-fusing spine — `project`/`filter`/`sort`/`materialize` all fold
 * into one `SELECT`, and `sliceOf`'s own `order()` sort sits on top — down to the `FROM`-defining node.
 * A `scan` there IS the single-table `FROM` the bug needs; any block-closing node (`join`/`union`/
 * `distinct`/`aggregate`/`window`/…) means the offset does not sit over a bare scan, so it cannot bite.
 * A plain `materialize` is transparent here: an ordinary CTE is flattened, so an `EXISTS` beneath one
 * still fuses upward — the fence wraps the whole input, which the `MATERIALIZED` barrier then pins.
 */
function offsetDropsOverExists(input: Rel): boolean {
  let sawExists = false;
  for (let node: Rel = input; ; ) {
    switch (node.kind) {
      case 'scan': return sawExists;
      case 'filter': sawExists ||= hasPositiveExists(node.pred); node = node.input; break;
      case 'project': case 'sort': case 'materialize': node = node.input; break;
      default: return false;
    }
  }
}

/** Does this predicate place a POSITIVE `EXISTS` in the emitted `WHERE`? Parity-tracked, because a
 *  `hasNot(k)` (`NOT (EXISTS …)`) and a `not(__.out())` (a `negated` exists) both render as `NOT
 *  EXISTS`, which does not trigger the bug — so an exists under an ODD number of negations is not one
 *  the fence must cover. (A positive exists buried in `NOT (a AND …)` reads as negated and is left
 *  unfenced; that composition does not arise from ordinary Gremlin and a spurious fence would only cost
 *  a redundant barrier, never correctness.) */
function hasPositiveExists(pred: Expr): boolean {
  const walk = (e: Expr, negated: boolean): boolean =>
    e.kind === 'exists' ? e.negated === negated
    : e.kind === 'unary' && e.op === 'not' ? walk(e.arg, !negated)
    : exprChildren(e).some((child) => walk(child, negated));
  return walk(pred, false);
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
 * Done as a one-off, this shape can only live in the element FRAMING projection (a bulk-aware
 * limit/range), where it happens once and only at the end. Here it is four ordinary nodes over any
 * relation carrying a multiplicity and a position — which is why it serves the element fold and the
 * scalar tail from one place, and why `order().limit()` composes rather than being a shape the
 * framing layer has to recognise.
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

/**
 * WHAT A PER-ROW SHAPE OWES the shape-agnostic row-algebraic ops — the whole of what `rowOp` needs to
 * know about the payload it is slicing, ordering and deduping.
 *
 * There are exactly three questions, and every one of them is a fact TinkerPop states per TYPE rather
 * than per step: which traverser a `by()` reads (`host`), what breaks a tie deterministically when
 * `order()` has to MINT a position (`tie`), and what makes two traversers THE SAME ONE (`identity`).
 * `natural` is the fourth only because two shapes answer their own order with a term LIST — see
 * `naturalSort`.
 *
 * Growing this record is how a shape becomes a first-class row participant. It is deliberately NOT the
 * union of its callers' needs: a shape that cannot answer one of these declines the op, it does not get
 * a special case inside `rowOp` (§6·6 — the seam must not become the union of its consumers).
 */
type RowShape = {
  readonly host: ChildHost;
  readonly tie: (input: Rel) => Expr;
  readonly identity: (input: Rel) => readonly Expr[];
  /** True when `identity` NAMES THE WHOLE PAYLOAD, so a bare `dedup()` may use the cheap set forms
   *  (`Distinct` / a grouped aggregate) instead of a ranked window. An element relation's payload IS its
   *  id; a property relation's is six columns of which the identity is one or three. */
  readonly identifiedByPayload: boolean;
  readonly natural?: (input: Rel) => readonly Expr[];
};

/** The ELEMENT shape — `id` is at once the payload, the identity and the tie-break. */
const elementRowShape = (input: Rel, elem: Elem, aliases: AliasMap): RowShape => ({
  host: elementHost(input, elem, aliases),
  tie: (rel) => col(rel.id, 'id'),
  identity: (rel) => [col(rel.id, 'id')],
  identifiedByPayload: true,
});

/** The PROPERTY shape. Both its order and its identity split on the owner kind, and both citations live
 *  in `property.ts` — a `VertexProperty` IS an `Element` (compared and hashed by id) while an edge
 *  `Property` is compared and hashed by KEY and VALUE. */
const propertyRowShape = (input: Rel, elem: Elem, aliases: AliasMap): RowShape => ({
  host: { kind: 'property', id: propertyRowId(input), ownerElem: elem, row: { rel: input, aliases } },
  // The property row's own rowid: deterministic for both owner kinds, even where it is not the identity.
  tie: propertyRowId,
  identity: (rel) => propertyIdentityKey(rel, elem),
  identifiedByPayload: false,
  natural: (rel) => propertyOrderTerms(rel, elem),
});

function rowOp(step: IRStep, input: Rel, shape: RowShape, bulked: boolean, ctx: ChainCtx, fresh: Minter): Rel | null {
  if (step.optionArms) return null;
  if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;
  if (step.name === 'order') return orderRows(step, input, shape.host, ctx, fresh, shape);
  const sliced = sliceOp(step, input, bulked, fresh);
  if (sliced) return sliced;
  if (step.name === 'dedup' && pathCarried(input)) return null;

  if (step.name !== 'dedup' || (step.args ?? []).length || isLocalScope(step)) return null;
  // A BARE `dedup()` is a grouping by traverser IDENTITY, so the channel policy table decides whether
  // it may carry what the relation carries — and an ALIAS binding belongs to ONE of the merged rows.
  // Keeping it in the key would distinguish two traversers reaching the same element by the label they
  // bound on the way, which is a different multiset; taking an arbitrary one is the `undefined` the
  // table names. So this declines rather than taking an arbitrary alias into the key (path-distinct
  // semantics) — a clean deferral, not a wrong answer. The honest lowering is a ranked window over
  // the identity partition (`dedupBy`'s shape with the id as its key), which is a separate increment.
  if (!groupableChannels(input.channels)) return null;

  const ordered = !!encounterOf(input.channels);
  const bys = modulations(step, 1, childSeam(ctx, fresh));
  if (!bys) return null;
  if (bys[0]) return dedupBy(step, bys[0], input, shape, ctx, fresh);

  // A SHAPE WHOSE IDENTITY IS NOT ITS PAYLOAD takes the ranked window instead of the set forms below.
  // The two arms after this one both project the group key and discard everything else, which is exact
  // where the payload IS the key (an element `id`) and would erase five columns of a property row. The
  // window keeps ONE member's payload whole, which is what "the first occurrence survives" means when a
  // traverser is more than its identity — the honest lowering this comment block predicted.
  if (!shape.identifiedByPayload) return dedupOn(shape.identity(input), input, [shape.tie(input)], fresh);

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
  // THE AGGREGATES ARE DERIVED FROM THE CHANNELS THE INPUT ACTUALLY CARRIES, never named — §12's rule,
  // and this line broke it. The pair `['bulk', 'encounter']` was hardcoded while every ordered element
  // relation carried both, and the first one that did not was a `fold().unfold()`: a fold collapses the
  // stream to ONE traverser, so the list relation has no multiplicity to carry and the unfolded members
  // arrive with an emission order and no `bulk`. The declared type then said two columns while the node
  // emitted three, which the factory catches — a THROW out of a lowering whose contract is `null`, i.e.
  // a compile error where the traversal must answer.
  //
  // `groupableChannels` above has already refused every role without a defined N→1 answer, so the two
  // arms below are total over what can reach here; anything else declines rather than being averaged
  // into a plausible value. `bulk` is the constant 1 because a dedup survivor stands for ITSELF
  // (`DedupGlobalStep.filter`'s unconditional `setBulk(1L)`), and `encounter` is the FIRST occurrence's
  // position, which is what makes the survivor the one TinkerPop keeps.
  const reductions: (readonly [string, Expr])[] = [];
  for (const channel of input.channels) {
    if (channel.role === 'bulk') reductions.push([channel.col, compilerInt(1)]);
    else if (channel.role === 'encounter') reductions.push([channel.col, { kind: 'agg', fn: 'min', args: [col(input.id, channel.col)] }]);
    else return null;
  }
  return make.aggregate({
    id: fresh('dd'), input, channels: input.channels, type: typeOf(...elementCols(input.channels)),
    groupBy: shape.identity(input),
    aggs: reductions,
  });
}

/**
 * `dedup().by(<projection>)` — the projection read off the shape's own host, then handed to `dedupOn`.
 *
 * PRODUCTIVITY is the vocabulary's, not this host's: TinkerPop drops a traverser whose `by()` yielded
 * nothing (`DedupGlobalStep.filter` → `product.isProductive()`), and `ProductiveByStrategy` turns that
 * off. `productivityFilter` returns the predicate or `undefined`, so the rule cannot be forgotten here.
 */
function dedupBy(
  step: IRStep, modulation: Modulation, input: Rel, shape: RowShape, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  // A comparator on `dedup()` is not a form Gremlin has — `DedupGlobalStep` is not a comparator host —
  // so an `Order` in its `by()` is a chain `verifyByModulatorArity` never sees. Decline rather than
  // silently ignoring it.
  if (modulation.order !== undefined) return null;
  const key = byExpr(modulation, shape.host, fresh, false, childSeam(ctx, fresh));
  if (!key) return null;
  const productive = productivityFilter(step, key);
  const domain = productive
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: productive })
    : input;
  return dedupOn([key], domain, [shape.tie(domain)], fresh);
}

/**
 * A DEDUP ON AN ARBITRARY KEY — `Window` + `Filter`, not a grouped aggregate, and the difference is the
 * reason: the survivor is ONE traverser and every other column must be ITS values — an `Aggregate` can
 * produce `MIN(id)` but not "the encounter belonging to the row that had it". That is what a ranked
 * window says and an aggregate cannot, so this is the shape emitted.
 *
 * It serves both callers a `by()` and a shape whose IDENTITY is not its payload can have (`rowOp`), and
 * that is not a convenience: the two differ only in which expressions partition, so a second copy would
 * be a second chance to get the survivor rule wrong.
 *
 * WHICH traverser survives is the EMISSION-ORDER question, not an id question. TinkerPop keeps the
 * FIRST occurrence, so the rank orders by the carried position where there is one and falls back to the
 * shape's own tie-break where there is not — which is the only order a positionless relation has
 * (`ORDER BY <orderSql>, p.id`). Ranking by id alone was right only while
 * nothing could mint a position: `g.V().order().by('name',desc).dedup().by('age')` then kept the
 * lowest-id member of each age instead of the first in the sorted stream — the same rows, a different
 * member, which the census's multiset digest DID see (it is a different set) but no assertion in the
 * ladder named. The tie-break is always the LAST term, so the rank is DETERMINISTIC rather than merely
 * ordered — the property `mise run test:perturbed` checks.
 *
 * **`bulk` RESETS to 1 — the reference's rule.** TinkerPop's `DedupGlobalStep.filter` calls
 * `traverser.setBulk(1L)` unconditionally — before it even looks at the `by()` — so a survivor stands
 * for itself whether or not a projection was given
 * (`vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:75`). Carrying `p.bulk` through instead
 * would not be observably different: `analyzeChain`'s collapse-safety rule excludes a `dedup` that has
 * modulators, so `movementCollapse` never fires upstream of one and the multiplicity is provably 1
 * where it arrives. Checked, not assumed — `g.V().both().both().dedup().by('lang')` emits no
 * `GROUP BY`. So resetting is the form that stays correct if that safety rule is ever relaxed, at no
 * cost today.
 */
function dedupOn(
  keys: readonly Expr[], domain: Rel, tie: readonly Expr[], fresh: Minter,
): Rel | null {
  // The PAYLOAD survives whole, which is what makes this form serve a traverser that is more than its
  // identity: only `bulk` is rewritten.
  const cols = [...payloadCols(domain), ...carriedCols(domain.channels)];
  const position = encounterOf(domain.channels);
  const ranked = make.window({
    // A `Window` may only EXTEND its input (§3.5), so its declared type is the INPUT's columns IN THE
    // INPUT'S ORDER plus the rank — NOT `cols`. The two differ for a property relation, whose join
    // declares the element side's channels BETWEEN the two payload halves; the projection below is where
    // the canonical payload-then-channels layout (`build.ts`) is restored.
    id: fresh('dw'), input: domain, channels: domain.channels, type: typeOf(...domain.type.cols, meta('rn', 'int')),
    specs: [['rn', {
      kind: 'window-expr', fn: 'row_number', args: [],
      spec: {
        partitionBy: keys,
        orderBy: [...(position ? [{ expr: col(domain.id, position.col), dir: 'asc' as const }] : []),
          ...tie.map((expr) => ({ expr, dir: 'asc' as const }))],
      },
    }]],
  });
  const survivors = make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: eq(col(ranked.id, 'rn'), compilerInt(1)),
  });
  return make.project({
    id: fresh('dk'), input: survivors, channels: domain.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name,
      column.name === 'bulk' ? compilerInt(1) : col(survivors.id, column.name)] as const),
  });
}

/**
 * `dedup(k1, …, kn)[.by(proj)]` — a KEYED dedup on the tuple of ALREADY-BOUND alias values, TinkerPop's
 * `DedupGlobalStep` with `dedupLabels`: the survivor's key is the LIST of each label's `Pop.last` scope
 * value run through the shared `by()` projection (`DedupGlobalStep.filter`,
 * `vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:80-88`). With no `by()`, an element alias keys
 * by rowid and a scalar alias by stored value; with a `by()`, each label's element is the host the
 * projection reads (`dedup('a','b').by(label)` keys on `(label(a), label(b))`). Every named label must
 * be LIVE, or TinkerPop drops the whole path (a null scope value fails the
 * `objects.size() == dedupLabels.size()` check) — modelled as a DECLINE, fail closed — and a
 * non-productive `by()` drops the row (`productivityFilter`, the same rule `dedup().by()` obeys). The
 * survivor keeps its WHOLE payload (a following `select('a')` reads a field the dropped duplicates
 * could differ on), so this is `dedupOn`'s ranked window — a fully deterministic tie over every column,
 * since a keyed dedup carries no emission order of its own.
 */
function dedupByLabels(
  step: IRStep, rel: Rel, labels: AliasMap, keys: readonly string[],
  by: Modulation | undefined, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  const seam = childSeam(ctx, fresh);
  const keyExprs: Expr[] = [];
  const productive: Expr[] = [];
  for (const k of keys) {
    const proj = aliasProjection(rel, labels, k, 'last', fresh);
    if (!proj) return null;
    const column = col(rel.id, proj.entry.col);
    if (by) {
      // A `by()` projection reads each label's ELEMENT as its host; a scalar/list alias under a `by()`
      // is a later phase.
      if (proj.read.kind !== 'element') return null;
      const host: ChildHost = { kind: 'element', id: aliasIdAt(column, 'last'), elem: proj.read.elem, row: { rel, aliases: labels } };
      const key = byExpr(by, host, fresh, false, seam);
      if (!key) return null;
      keyExprs.push(key);
      const prod = productivityFilter(step, key);
      if (prod) productive.push(prod);
    } else if (proj.read.kind === 'element') keyExprs.push(aliasIdAt(column, 'last'));
    else if (proj.read.kind === 'value') keyExprs.push(aliasValueAt(column, 'last'));
    else return null; // a list-valued alias key with no `by()` is a later phase — decline.
  }
  const domain = productive.length
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: productive.reduce((a, b) => and(a, b)) })
    : rel;
  return dedupOn(keyExprs, domain, domain.type.cols.map((c) => col(domain.id, c.name)), fresh);
}

/** The fan-out re-mint: renumber by the incoming position, tie-broken on the element id so rows
 *  that shared one incoming traverser get a deterministic order rather than SQLite's. */
const remintOrder = (rel: Rel, encounter: Channel, fresh: Minter): Rel => renumber(
  rel,
  [{ expr: col(rel.id, encounter.col), dir: 'asc' }, { expr: col(rel.id, 'id'), dir: 'asc' }],
  elementCols(rel.channels), rel.channels, fresh,
);

/**
 * DROP a carried emission order — a `Project` that forgets the `encounter` column and its channel,
 * leaving every other column and the rows themselves untouched.
 *
 * A branch that produces a fresh UNORDERED stream (`union`, every scenario of which the corpus asserts
 * unordered) discards whatever position its input carried and whatever order an arm minted inside
 * itself: an arm's `order().by(k).limit(n)` has already CONSUMED its position to pick the members, so
 * the column past that limit is dead weight that only stops otherwise-identical arms from merging. A
 * downstream slice that needs a position mints its OWN (§10's fan-out order), which is why forgetting
 * it here is the honest model rather than a loss. A no-op where there is no encounter to drop.
 */
const dropEncounter = (rel: Rel, fresh: Minter): Rel => {
  const encounter = encounterOf(rel.channels);
  if (!encounter) return rel;
  const cols = rel.type.cols.filter((column) => column.name !== encounter.col);
  return make.project({
    id: fresh('ue'), input: rel, channels: rel.channels.filter((channel) => channel.role !== 'encounter'),
    type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
  });
};

/** The channel list a positionless merge declares — the input's, minus any emission order (`dropEncounter`). */
const withoutEncounter = (channels: Channels): Channels =>
  channels.filter((channel) => channel.role !== 'encounter');

/**
 * MINT ONE DETERMINISTIC WINDOW ORDER OVER A WHOLE FAN-OUT (§10) — the demanded-order half of the
 * branch merge for a COLLECTING/write demand, and the reason `union`/`choose`/`coalesce` no longer
 * decline outright under `ctx.ordered`.
 *
 * The positionless merge has already produced the right ROWS (`mergeArms`, over arms whose own
 * arm-local positions were dropped — a fresh unordered stream, `dropEncounter`). What a downstream
 * `fold`/`cap`/`group` demands on top is a COLUMN to collect by, and this mints it: a `ROW_NUMBER`
 * over the merged relation's OWN columns, taken as one deterministic total order.
 *
 * Ordering by every merged column — not by an arm ordinal + within-arm position — is deliberate. A
 * branch is UNORDERED at the source (every `Union`/`Choose`/`Coalesce.feature` scenario asserts it,
 * and `BranchStep`'s arm-drain order is impl-defined — no corpus scenario pins a branch FOLD's member
 * order, only membership), so for a collect ANY deterministic realization is legal; the census answer
 * digest moves and is re-recorded. Two rows equal in every column are INDISTINGUISHABLE traversers,
 * so a tie among them is unobservable — which is what makes the whole-row key deterministic under
 * `mise run test:perturbed` without a hand-supplied per-shape tie. It is also fully general: element,
 * scalar (post-meet, with its `vtype` column), list, map and VARIANT merges all present columns to
 * order by, so one helper serves all three mergers and every framing they produce.
 *
 * ⚠️ **This is NOT enough for a positional SLICE** (`limit`/`range`/`skip`/`tail`), which reads the
 * fan-out's order to pick a SUBSET: `BranchStep.standardAlgorithm` is traverser-major/arm-minor
 * (barrier-free) or arm-major (a batched-barrier arm), and a slice on a traverser boundary pins that
 * exact subset (`branch-traverser-major.feature`). A whole-row key picks a DIFFERENT subset — a wrong
 * ANSWER, not a reorder — so `branchResult` DECLINES a sliced fan-out (`ctx.sliced`) until the
 * traverser-major key is minted. The collect case has no such pin, which is why it ships first.
 *
 * A no-op check is unnecessary — `branchResult` only wraps a positionless merge, so `renumber` mints.
 */
const withFanoutOrder = (merged: FramedRel, fresh: Minter): FramedRel => {
  const rel = merged.rel;
  const cols = [...rel.type.cols, meta('encounter', 'int')];
  const channels = withChannel(rel.channels, ENCOUNTER);
  const terms = rel.type.cols.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const }));
  return { ...merged, rel: renumber(rel, terms, cols, channels, fresh) };
};

/**
 * The one place the three branch mergers turn a positionless merge into the value they return, so the
 * emission-order policy lives once. Positionless demand (`!ctx.ordered`) → the merge as-is. A
 * COLLECT/write demand → mint a deterministic fan-out order. A SLICE demand → decline (see
 * `withFanoutOrder`'s ⚠️). A failed merge stays `null`.
 */
const branchResult = (merged: FramedRel | null, ctx: ChainCtx, fresh: Minter): FramedRel | null =>
  !merged ? null : !ctx.ordered ? merged : ctx.sliced ? null : withFanoutOrder(merged, fresh);

/**
 * THE FAN-OUT SORT KEY, carried past the merge as two `branchOrder` channels (the role the channel core
 * declares for exactly this — `identical` merge so every arm agrees on it structurally, `empty` at a
 * barrier so a batched arm's per-parent key correctly vanishes, `undefined` group). `BORD_PARENT` is
 * the FROZEN parent position: minted from the branch input's `encounter` and riding each arm UNCHANGED
 * through its hops (a hop copies a carried channel to its children — `crossFanout`), so all of one
 * traverser's descendants sort together, which is what makes the merge TRAVERSER-major. `BORD_ARM` is
 * the arm ordinal. `renumber` reads `[BORD_PARENT, BORD_ARM, payload…]` into a fresh `encounter` and the
 * pair is dropped — the SLICE half of §10's fan-out mint (`branch-traverser-major.feature`).
 */
const BORD_PARENT: Channel = { col: 'bord_p', role: 'branchOrder' };
const BORD_ARM: Channel = { col: 'bord_a', role: 'branchOrder' };

/** Does a SLICE-demanded branch take the traverser-major lowering here? Only when the input carries no
 *  branchOrder key already: a branch NESTED inside another's sliced arm would freeze a SECOND parent
 *  position, and the reference's stacked order (`branch-traverser-major.feature`'s nested scenario)
 *  needs a KEY STACK this single-level mint does not build — so the inner branch declines cleanly
 *  rather than dup the channel (which throws) or mis-order. */
const sliceableBranch = (ctx: ChainCtx, input: Rel): boolean =>
  ctx.ordered && ctx.sliced
  // A branch whose input carries NO position has nothing to freeze as the traverser-major key — a
  // global barrier upstream (`g.V().count().as(x).union(…).limit(…)`) dropped the encounter — so the
  // slice declines rather than reference a `bord_p` that was never minted.
  && input.channels.some((channel) => channel.role === 'encounter')
  && !input.channels.some((channel) => channel.role === 'branchOrder');

/** Freeze the branch input's emission position into a `branchOrder` channel so it survives each arm's
 *  hops as the traverser-major major key. A no-op where the input carries no position (nothing to
 *  freeze — the caller only reaches this under `ctx.ordered`, so the input always has one). */
const augmentParent = (input: Rel, fresh: Minter): Rel => {
  const enc = encounterOf(input.channels);
  if (!enc) return input;
  const channels = withChannel(input.channels, BORD_PARENT);
  const payload = payloadCols(input);
  return make.project({
    id: fresh('bp'), input, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(input.id, column.name)] as const),
      ...channels.map((channel) => [channel.col,
        channel.col === BORD_PARENT.col ? col(input.id, enc.col) : col(input.id, channel.col)] as const),
    ],
  });
};

/** Tag one arm with its ordinal (a `BORD_ARM` channel = `k`) and drop its arm-local emission order —
 *  the within-(parent, arm) tie is taken from the payload at the re-mint, which every shape has and
 *  which the slices pinned in `branch-traverser-major.feature` never observe (they fall on traverser
 *  boundaries). */
const tagArm = (rel: Rel, k: number, fresh: Minter): Rel => {
  const dropped = dropEncounter(rel, fresh);
  const channels = withChannel(dropped.channels, BORD_ARM);
  const payload = payloadCols(dropped);
  return make.project({
    id: fresh('ba'), input: dropped, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(dropped.id, column.name)] as const),
      ...channels.map((channel) => [channel.col,
        channel.col === BORD_ARM.col ? compilerInt(k) : col(dropped.id, channel.col)] as const),
    ],
  });
};

/**
 * THE TRAVERSER-MAJOR MERGE — a branch whose fan-out is read by a downstream positional SLICE
 * (`ctx.sliced`). Each arm was lowered from `augmentParent(input)`, so it carries `BORD_PARENT` (its
 * traverser's frozen position). This tags each with its ordinal, merges through the ordinary
 * `mergeArms` (which reconciles shape, scalar-meet and variant exactly as the positionless path does —
 * the sort key is orthogonal, carried as rigid channels), then re-mints `encounter` as a `ROW_NUMBER`
 * over `[BORD_PARENT, BORD_ARM, payload…]` and drops the two key channels.
 *
 * This is `BranchStep.standardAlgorithm`'s barrier-free order — `applyCurrentTraverser` injects ONE
 * start, drains every arm for it, then the next start (traverser-major, arm-minor)
 * (`vendor/tinkerpop/gremlin-core/.../branch/BranchStep.java:120-152`) — and `coalesce`/`optional`'s,
 * which are `FlatMapStep`s that reset per traverser
 * (`vendor/tinkerpop/gremlin-core/.../branch/CoalesceStep.java:38`). The ARM-major order a `union`/
 * `choose` with a BATCHED-barrier arm (`hasBarrier`/`armBatches`) presents is a separate lowering: the
 * batched arm must run over the whole input, which this spine does not build, so the caller declines it
 * rather than reach here. (Calcite: a plain `Union` carries no collation — `RelMdCollation` — so the
 * order is IMPOSED as a window, `SqlStdOperatorTable.ROW_NUMBER`.)
 */
const mintTraverserMajor = (arms: readonly Tail[], source: Rel, labels: AliasMap, fresh: Minter): FramedRel | null => {
  const tagged = arms.map((arm, k) => ({ ...arm, rel: tagArm(arm.rel, k, fresh) }));
  const base = withChannel(withoutEncounter(source.channels), BORD_ARM);
  const merged = mergeArms(tagged, base, labels, fresh);
  if (!merged) return null;
  const rel = merged.rel;
  // FAIL CLOSED if an arm dropped the sort key: a BATCHED barrier inside an arm empties `branchOrder`
  // (`CHANNEL_BARRIER_POLICY`), so a `union`/`choose` with a batched arm (already gated by `armBatches`)
  // and a `coalesce`/`optional` arm whose scoped barrier still collapses the key both arrive here
  // without `bord_p`/`bord_a`. Re-minting over a column not in scope is a THROW, not a decline — so
  // this checks rather than assumes (`rel-sweep` caught `union(name.fold, …)` and a count-before-union).
  if (![BORD_PARENT.col, BORD_ARM.col].every((c) => rel.channels.some((channel) => channel.col === c))) return null;
  const kept = rel.channels.filter((channel) => channel.role !== 'branchOrder');
  const outChannels = withChannel(kept, ENCOUNTER);
  const payload = payloadCols(rel);
  const outCols = [...payload, ...carriedCols(outChannels)];
  const terms = [
    { expr: col(rel.id, BORD_PARENT.col), dir: 'asc' as const },
    { expr: col(rel.id, BORD_ARM.col), dir: 'asc' as const },
    ...payload.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const })),
  ];
  return { ...merged, rel: renumber(rel, terms, outCols, outChannels, fresh) };
};

/**
 * The convergent-walk COLLAPSE: `SELECT id, SUM(bulk) … GROUP BY id`, so the frontier stays bounded
 * by reachable |V| instead of by the (exponential) walk count.
 *
 * It is the `movementCollapse` fast path, expressed IN the algebra rather than beside it — which
 * is legitimate where the FTS one was not, and the difference is worth stating. Routing a substring
 * predicate through a base-table scan would have LOST an index seek; here the specialized form is a
 * plan rewrite RelIR can state exactly, so expressing it keeps the optimization AND keeps the switch
 * meaningful: `fastPaths.movementCollapse` still selects between two forms. Reading the flag here does
 * NOT change whether the traversal compiles — only the plan — so coverage is unchanged either way.
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
 * multiplicity: each row is one traverser by construction) it is `COUNT(*)`. Reading the CHANNEL
 * rather than the step name is what keeps the two forms in step.
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
 * `constant(c)` — the ONE genuinely SHAPE-INDEPENDENT retype: it IGNORES the traverser entirely and
 * emits a literal per input row, so it turns ANY stream — element, scalar, property, list, map — into a
 * scalar one. Every tail that reaches a `constant` routes here rather than re-deriving the projection
 * (the element and scalar tails once each carried a byte-identical copy, and the list/property/map tails
 * had none, so `g.V().fold().constant('x')` and `properties().coalesce(__.value(), __.constant('x'))`
 * declined for want of a caller, not an algebra). The channels ride through untouched — a constant
 * changes the VALUE, not the traverser.
 *
 * UNKNOWN for an untyped constant, never a tag inferred from the JS value: a compile-time tag would be a
 * claim the argument's declared type does not support. An EXACT TAIL (a long past 2^53, a bigdecimal) is
 * the exception — its declared type IS known, so it frames `STATIC(type, text)` and a following ordering
 * compare can cast it.
 */
function constantRetype(input: Rel, step: IRStep, fresh: Minter): FramedRel | null {
  if ((step.args ?? []).length !== 1 || step.modulators?.length || step.optionArms) return null;
  const literal = constLit(step.args[0]);
  const tail = literal ? null : exactTailConst(step.args[0]);
  if (!literal && !tail) return null;
  return {
    rel: make.project({
      id: fresh('ct'), input, channels: input.channels,
      type: typeOf(meta('v', 'any', true), ...carriedCols(input.channels)),
      exprs: [['v', literal ?? tail!.expr], ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
    }),
    framing: { kind: 'scalar', type: tail ? STATIC(tail.tag as never, true) : declaredScalarType(step.args[0]) },
  };
}

/**
 * A CONSTANT'S OWN TYPE, off the argument that declared it — `UNKNOWN` only where there is genuinely
 * nothing to say.
 *
 * `constant()` used to frame every plain literal `UNKNOWN`, i.e. "infer from the value at the wire", for
 * a value whose type the front end had already parsed and carried (`Arg.type`). Inference then re-derived
 * it from the SQL storage class, which cannot see the distinctions Gremlin spells LEXICALLY — and
 * `constLit` deliberately narrows that storage class further, inlining a boolean as INTEGER 1. Measured
 * before this, all three silently wrong on the wire: `constant(30L)` framed INT (not LONG),
 * `constant(30.5f)` DOUBLE (not FLOAT), and `constant(true)` **INT 1 rather than BOOLEAN true**.
 *
 * Dropping the INCOMING per-row `vtype` stays correct and is a different question — the stored type no
 * longer describes the value that is there now, which is what every transform does. What was missing is
 * the replacement.
 *
 * §6·7 in one line: the type is known at compile time, so a static tag is exactly the right carrier, and
 * the framer already renders a tagged value from a narrower column (a stored boolean is INTEGER + a
 * `boolean` tag → GraphBinary BOOLEAN). A COLLECTION type has no `ValueType` and no scalar literal form
 * — `constLit` has already declined it — so it cannot arrive here; `UNKNOWN` remains for a parameter
 * whose type the client did not send, where inference IS the honest answer.
 */
function declaredScalarType(arg: Arg | undefined): ScalarType {
  const declared = flatType(arg?.type ?? null);
  if (declared === null || declared === 'list' || declared === 'map' || declared === 'set') return UNKNOWN;
  return STATIC(declared);
}

/**
 * A TERMINAL that retypes the element relation into another shape — the SHAPE BOUNDARY, and the
 * substrate every scalar-valued step then rides on.
 *
 * `null` declines, as everywhere here. What makes this the boundary rather than one more step is
 * that both arms change the STREAM KIND: everything before produces elements and frames as the
 * element payload, and these produce one scalar per row and frame through the value projection.
 */
function terminal(
  step: IRStep, input: Rel, elem: Elem, fresh: Minter, ctx: ChainCtx, aliases: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);

  // A MID-TRAVERSAL `call()` IS A RETYPE, and this is exactly the right place for it: a `streaming`
  // service produces ONE VALUE per input traverser, so an element relation becomes a scalar one —
  // which is what every other arm of this function does. The service is handed the host row and the
  // ONE child seam (§6·6), so `tinker.degree.centrality` asks the identical question a
  // `by(__.in().count())` asks and needs no per-traverser substrate of its own.
  if (step.name === 'call') return midCall(step, input, elem, fresh, ctx, aliases);

  // A bare `sack()` makes the ACCUMULATOR the current object — an element relation becomes a scalar
  // one, which is exactly what this function is for. The channel rides through: reading a sack does
  // not spend it.
  if (step.name === 'sack' && !args.length) return sackRead(input, fresh);

  // count() is the RLE traverser TOTAL, not the row count: a collapse merges convergent walks into
  // (row, N) pairs, so the answer is SUM(bulk) — identical to COUNT(*) only while bulk is 1
  // everywhere. Reading it off the carried channel rather than off the step is what keeps the two
  // in step when movement lands.
  if (step.name === 'count') {
    if (args.length) return null;
    return countTail(input, fresh);
  }

  // `valueMap()` — the element's PROPERTIES as one map per traverser, which is a shape boundary of
  // exactly this function's kind: the element is gone and a map value stands where it was.
  //
  // The TOKEN forms arrive as a `true` argument, because `absorbValueMapWith` (a Pass) has already
  // desugared `with(WithOptions.tokens)` and `with(tokens, all)` onto the step — one recognizer for
  // both spellings, in a Pass ahead of the lowering. A SELECTIVE subset (`with(tokens, ids)`) is deliberately left
  // in place by that pass and therefore reaches this fold as a `with` step nothing lowers, so it
  // declines rather than being silently widened to all-tokens.
  //
  // A `by()` modulator on a `valueMap()` projects each VALUE (`applyTraversalRingToMap` computes over
  // the map's values and REMOVES the key when the projection is unproductive), which is a different
  // question from every other `by()` here — so the guard at the top of this function declines it.
  if (step.name === 'valueMap' || step.name === 'elementMap') {
    const tokens = args.includes(true);
    // The key set is `propertyKeyArgs`', shared with `properties()`/`values()`: a null key is IGNORED
    // rather than declined (the reference pins it rather than us inferring it — `element.properties(keys)`
    // filters by key membership, so a null never matches, and `ElementMap.feature`'s
    // `g_V_elementMapXname_age_nullX` answers exactly `elementMap("name","age")`), while an ALL-NULL set
    // is a map with NO entries rather than the whole map. Any OTHER argument — a nested traversal, a
    // token this fold does not know — is a form this does not serve, and answering the same map for it
    // would answer a different question.
    const asked = propertyKeyArgs(args.filter((a) => !(tokens && a === true)));
    if (!asked) return null;
    // `elementMap()` takes no token OPTION: `ElementMapStep.map` puts `T.id` and `T.label`
    // unconditionally, which is why a `true` argument is not even a form it has.
    if (step.name === 'elementMap' && tokens) return null;
    const mapped = elementValueMap(input, elem, asked.all ? null : asked.keys,
      step.name === 'elementMap' || tokens, ctx.labelRegime, fresh,
      step.name === 'elementMap' ? { flat: true, endpoints: true } : {});
    return { rel: mapped.rel, framing: { kind: 'map', keyOf: mapped.keyOf, valOf: mapped.valOf } };
  }

  // `constant(c)` REPLACES the traverser's value with a literal — a shape boundary like `values()` and
  // `count()`, the element gone and a value in its place. The projection is `constantRetype`'s, shared
  // with every other tail because a constant is shape-independent.
  if (step.name === 'constant') return constantRetype(input, step, fresh);

  if (step.name === 'properties') {
    // The PROPERTY twin of `values()` below — same join, stopped at the property row instead of
    // projected down to its value. `propertyKeyArgs` is the one authority on the key set (no keys means
    // EVERY key, a null key never matches, and an all-null set is NOT "every"); a non-string, non-null
    // key declines rather than being read as "every", which would answer a different question.
    const asked = propertyKeyArgs(args);
    if (!asked) return null;
    return {
      rel: propertyRelation(input, elem, asked.all ? null : asked.keys, fresh),
      framing: { kind: 'property', ownerElem: elem },
    };
  }

  // `label()` / `id()` — the element's TOKENS as a scalar stream.
  //
  // **Nothing had to be built: the projection already existed and this tail had never been handed
  // it.** `byExpr`'s token arm is the authority — `COALESCE(uid, id)` for the external id, one
  // indirection into `labels` for an edge and the side table's first-interned name for a vertex —
  // and it is what `by(T.label)`, `group().by(label)` and a `label()` child body have always used.
  // Reaching it from here is the whole change — the "cannot be HANDED" versus "cannot EXPRESS"
  // distinction applied to a step rather than to a substrate.
  //
  // A LABEL is always a string, so a STATIC tag is honest here.
  //
  // `id()` RIDES THE SAME ARM. Its order is unpinned — `g.E().id()` can answer `[7,9,11,12,8,10]` or
  // `[7,8,9,10,11,12]`, the same multiset in a different order, with nothing pinning either (no
  // `order()`, no slice), so neither is wrong and the census counts `ord` as telemetry. The question
  // is simply whether the order is DETERMINISTIC, which `test:perturbed` is the instrument for.
  //
  // A LABEL is always a string, so a STATIC tag is honest; an id is whatever it was STORED as (a `uid`
  // string or a rowid int), so it carries no tag and the framer infers per value.
  if (step.name === 'label' || step.name === 'id') {
    if (args.length) return null;
    const token = step.name === 'label' ? 'label' : 'id';
    const projected = byExpr({ key: { kind: 'token', token } }, elementHost(input, elem, aliases), fresh);
    if (!projected) return null;
    return {
      rel: make.project({
        id: fresh('tok'), input, channels: input.channels,
        type: typeOf(meta('v', step.name === 'label' ? 'text' : 'any'), ...carriedCols(input.channels)),
        exprs: [['v', projected], ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
      }),
      framing: { kind: 'scalar', type: step.name === 'label' ? STATIC('string') : UNKNOWN },
    };
  }

  // `labels()` — `label()`'s FLAT-MAP twin, and the only reader that may join `vertex_labels`.
  //
  // `LabelsStep` is a `FlatMapStep` over `element.labels()` and its javadoc states both arms:
  // *"For vertices with multiple labels, each label is emitted individually. For edges, the single
  // label is emitted"* (`vendor/tinkerpop/gremlin-core/.../step/map/LabelsStep.java`). So the EDGE
  // arm is `label()` exactly — one row, the same token projection — and sharing it is the point: an
  // edge's label cardinality is fixed at one by spec, so a second spelling here could only disagree.
  //
  // The VERTEX arm is `values()`' shape with the label side tables in place of the property one: one
  // traverser per label, the channels riding through, `ordered` so the stream drives and
  // `vertex_labels(node, label)` is probed rather than scanned. The join is INNER, and that is the
  // SPECIFIED answer rather than a default — under `LabelCardinality.ZERO_OR_MORE` a vertex may carry
  // no labels at all, and `g.addV().labels().count()` is then 0, which an outer join would answer 1.
  //
  // Emission order within one vertex is label ID, which is the same deterministic pick `label()`
  // makes for its scalar, so the first entry of `labels()` and `label()` name the same label.
  if (step.name === 'labels') {
    if (args.length) return null;
    if (elem === 'edge') {
      const projected = byExpr({ key: { kind: 'token', token: 'label' } }, elementHost(input, elem, aliases), fresh);
      if (!projected) return null;
      return {
        rel: make.project({
          id: fresh('tok'), input, channels: input.channels,
          type: typeOf(meta('v', 'text'), ...carriedCols(input.channels)),
          exprs: [['v', projected], ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
        }),
        framing: { kind: 'scalar', type: STATIC('string') },
      };
    }
    const vl = make.scan({
      id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [],
      type: typeOf(meta('node', 'int'), meta('label', 'int')),
    });
    const owned = make.join({
      id: fresh('j'), left: input, right: vl, join: 'inner', ordered: true, channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta('node', 'int'), meta('label', 'int')),
      on: eq(col(vl.id, 'node'), col(input.id, 'id')),
    });
    const names = make.scan({
      id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [],
      type: typeOf(meta('id', 'int'), meta('name', 'text')),
    });
    const named = make.join({
      id: fresh('j'), left: owned, right: names, join: 'inner', ordered: true, channels: owned.channels,
      // `lid` and not a second `id`: a Join's declared names are POSITIONAL and must be unique, and
      // the element's own `id` is already the first of them.
      type: typeOf(...elementCols(owned.channels), meta('node', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
      on: eq(col(names.id, 'id'), col(owned.id, 'label')),
    });
    // A vertex may carry SEVERAL labels, so `labels()` fans one traverser out into one row per label,
    // and their emission order is THIS step's to pin. Left unpinned, a downstream `fold()` collects
    // them in whatever order SQLite scanned `vertex_labels` — reversed under `reverse_unordered_selects`
    // — so a deterministic-looking result passes only by luck (`mise run test:perturbed`). Establish it
    // canonically, by the `label` dictionary id: the SAME order the element payload's
    // `json_group_array(name ORDER BY lid)` (element.ts) and `by(T.label)`'s first-label pick already
    // use, so a vertex's labels read identically wherever they are read. Across origins the order is the
    // arriving emission order where the stream has one, else the origin rowid — total either way, which
    // the `encounter` channel requires.
    const arriving = encounterOf(input.channels);
    const staged = make.project({
      id: fresh('lv'), input: named, channels: named.channels,
      type: typeOf(meta('v', 'text'), meta('id', 'int'), meta('label', 'int'), ...carriedCols(named.channels)),
      exprs: [['v', col(named.id, 'name')], ['id', col(named.id, 'id')], ['label', col(named.id, 'label')],
        ...named.channels.map((channel) => [channel.col, col(named.id, channel.col)] as const)],
    });
    const channels = arriving ? staged.channels : withChannel(staged.channels, ENCOUNTER);
    return {
      rel: renumber(
        staged,
        [{ expr: col(staged.id, arriving ? arriving.col : 'id'), dir: 'asc' }, { expr: col(staged.id, 'label'), dir: 'asc' }],
        [meta('v', 'text'), ...carriedCols(channels)],
        channels, fresh,
      ),
      framing: { kind: 'scalar', type: STATIC('string') },
    };
  }

  if (step.name === 'values') {
    // The key set is `propertyKeyArgs`', the same authority `properties()` and `valueMap()` read: no keys
    // means EVERY key, several mean membership, a null key never matches, and an ALL-NULL set is the
    // empty result rather than "every". A non-string, non-null key is a decline rather than a guess.
    const asked = propertyKeyArgs(args);
    if (!asked) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying
    // the row is the answer rather than the bug it would be in a filter. `ordered` for the same
    // reason the hop is: the stream drives and `vp_node_key(node,key)` is probed, rather than the
    // planner leading with `vp_key_value(key)` — every `name` row in the graph — and rediscovering
    // the traverser afterwards.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', ordered: true, channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      on: and(eq(col(props.id, owner), col(input.id, 'id')),
        keyMembership(col(props.id, 'key'), asked.all ? null : asked.keys)),
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

/**
 * `V().call(name, …)` — a `streaming` service's per-parent VALUE, projected beside the host row.
 *
 * The whole lowering, because there is nothing else to it: the service returns a `ChildValue`, and a
 * value per input traverser over an element relation is the same retype `values()` and `count()` are.
 * The CHANNELS ride through untouched — a service changes the traverser's VALUE, not its identity or
 * its multiplicity — which is what makes a following `is(3)`, `count()` or `project()` the ordinary
 * scalar tail with nothing to know about services.
 *
 * A `stream` service DECLINES here (the ordinary "not learned yet" `null`), and so does an
 * unregistered name (`unknown service`). A service's OWN throw is not caught, for the source arm's
 * reason (§6·5): a `streaming` service called at a position it cannot serve raises a message the user
 * must see, and swallowing it would replace that message with something else entirely.
 */
function midCall(
  step: IRStep, input: Rel, elem: Elem, fresh: Minter, ctx: ChainCtx, aliases: AliasMap,
): FramedRel | null {
  const produced = serviceValue(step, elementHost(input, elem, aliases), ctx, fresh);
  if (!produced) return null;
  const { expr, framing, vtype } = produced;
  const typeCol = vtype ? [meta('vtype', 'text', true)] : [];
  return {
    rel: make.project({
      id: fresh('cv'), input, channels: input.channels,
      type: typeOf(meta('v', 'any', true), ...typeCol, ...carriedCols(input.channels)),
      exprs: [['v', expr], ...(vtype ? [['vtype', vtype] as const] : []),
        ...input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
    }),
    framing,
  };
}

/**
 * A `streaming` SERVICE'S per-parent value over one host traverser, or `null` to decline.
 *
 * Split out of `midCall` because a `call()` is not only a chain step: it is a child body
 * (`where(__.call(dc).is(3))`, `group().by(__.call(dc))`), and there the answer wanted is the VALUE
 * rather than a relation carrying it. One function so the two positions cannot come apart — which is
 * the same reason the service is handed the child seam rather than a scope of its own.
 */
function serviceValue(step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (step.modulators?.length || step.optionArms) return null;
  const spec = parseCallSpec(step, ctx.params);
  // An INJECTION traversal is the federated per-parent value read (`fprops`/`fid`/`flabel` rejoin),
  // which belongs to a `barrier` contribution and not to this arm at all. Declining on its presence
  // keeps the two apart rather than silently ignoring the argument.
  if (spec.injectionTraversal !== undefined) return null;
  const service = ctx.services.get(spec.serviceName);
  if (!service) return null;
  const site: RelCallSite = {
    params: spec.params, boundParams: ctx.params, federationDepth: 0, fresh,
    host, child: childSeam(ctx, fresh),
  };
  const contribution = service.resolve(site);
  if (contribution.kind !== 'rel') return null;
  const contributed = contribution.buildRel(site);
  return contributed && contributed.kind === 'value' ? contributed.value : null;
}

/**
 * The filter steps a VALUE stream hosts — the ones whose question is about the traverser rather than
 * about an element it is not.
 *
 * `where` is here in its BODY form only (`where(__.…)`); the predicate form (`where(P.eq(__.const(29)))`)
 * needs a correlated operand `predicateExpr` has no arm for, and declines inside `sourceFilter` like
 * any other unlearned shape. `has`/`hasLabel`/`hasId` are deliberately absent: they read a property or
 * label row, which a scalar traverser does not have.
 */
const SCALAR_FILTER_HOSTS = new Set(['and', 'or', 'not', 'filter', 'where']);

/** Does any operand of this predicate (at any nesting depth — `P.not(P.eq('a'))`) name a LABEL that
 *  is live on this relation? That is what separates `where(P.neq('a'))`, TinkerPop's alias compare,
 *  from `where(P.neq('marko'))`, a value comparison — and the two must not be confused, because one
 *  reads the path and the other reads the traverser. Fails CLOSED: any live-label hit declines. */
const namesALiveLabel = (pred: unknown, labels: AliasMap): boolean =>
  isPred(pred) && pred.operands.some((operand) =>
    (typeof operand.value === 'string' && labels.has(operand.value)) || namesALiveLabel(operand.value, labels));

/** The tail steps that read the traverser's value from a clause SQL cannot alias into — a `WHERE`
 *  or an `ORDER BY`. What they have in common is the bind wall, and the remedy, both in `scalarTail`.
 *  The connectives are here for the same reason `is` is, and more so: each ARM re-inlines the value
 *  expression, so an unfenced `and(is(…), is(…))` pays the projection twice over. */
const CLAUSE_READERS = new Set(['is', 'order', ...SCALAR_FILTER_HOSTS]);

/**
 * The tail steps that HOST a `by()` — `BY_HOSTS` itself, imported rather than restated.
 *
 * It WAS a five-name subset, and the gap was not an intentional narrowing: `group`/`groupCount` read
 * both their slots through `groupRows`, and the blanket `step.modulators?.length` decline in front of
 * them refused every `group().by(…)` over a VALUE stream — an arm that had been able to answer since it
 * landed. The `by()`-hosting builders all either read their modulations or decline them explicitly
 * (`alias.ts`, `collection.ts`, `sack.ts`, `path.ts`, `projector.ts`, `record.ts`), so the honest
 * exemption is the whole set and each arm's own refusal is the real gate. Sharing the Pass tier's
 * constant is also what keeps the two from drifting — the comment used to claim they agreed.
 */
const BY_READERS = BY_HOSTS;

/**
 * An `order()`'s sort terms over any host, or `null` to decline.
 *
 * Scalar `order()` IS a relation operator, and that is what separates it from the element one: over
 * values it is a `Sort` in the algebra (`SELECT p.v FROM c0 p ORDER BY p.v ASC`), whereas over
 * elements it folds the order into the FRAMING projection, which is `TailAcc`'s and Phase 4.2's.
 * Same step name, two different layers, and only one of them is here today; the host parameter is
 * what will let the other one in without a second parse.
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
  // is the whole order or none of it. Mixed with a real key it declines, and a
  // lowering that dropped the shuffle would silently answer a deterministic order.
  if (parsed.some((modulation) => modulation.order === 'shuffle'))
    return parsed.length === 1 ? { terms: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }] } : null;

  const terms: SortTerm[] = [];
  // PRODUCTIVITY rides with the terms rather than being each host's to remember: a traverser whose
  // `by('age')` yielded nothing is DROPPED, so `g.V().order().by('age')` is four rows on the modern
  // graph and not six. A forgotten drop is a wrong answer with the right arity, and it sorts the
  // extra rows FIRST (SQLite orders NULL low), which the census's multiset digest cannot see. With
  // several terms each KEY term owes one, conjoined over its whole clause list.
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
 * `order()` OVER ROWS — the ONE engine every per-row tail routes through, element, scalar, record and
 * property alike. It was three near-identical copies (an element arm, a scalar arm, a record arm) whose
 * only real differences are the two parameters below; a fourth copy for the property stream is what
 * made consolidating it the cheaper move.
 *
 * The rule it holds is the one all three copies stated in their own words: **a sort SUPERSEDES the
 * arriving emission order, so the position must be RE-MINTED and not merely re-sorted.** A later slice
 * reads the channel, and taking its window from the stale seed returns the right multiset from the
 * wrong place. Where no position is carried this MINTS one — the case a chain-global boolean threaded
 * from the source structurally could not express — because an order that is not a column cannot survive
 * a relation boundary, and minting it is also what makes `order()` COMPOSE (a fold into the framing
 * `ORDER BY` can only happen once, at the end).
 *
 * Re-minting tie-breaks on the ARRIVING position, which is what makes the sort STABLE. Minting fresh
 * has nothing to be stable against, so `tie` is the
 * payload's own deterministic last resort — the element rowid, the property rowid — and `undefined`
 * where equal keys are genuinely interchangeable (a value stream). Determinism, not mere ordering, is
 * the property `mise run test:perturbed` exists to check.
 *
 * The rebuilt columns are `payloadCols` + the channels rather than any shape's own list, which is what
 * lets a property relation (six payload columns) through the same door as an element one (`id`).
 *
 * **NOT a `Sort` of the core relation with the framing on top:** a JOIN's output order is unspecified,
 * so the framing join may return sorted rows in any order — and on a six-vertex fixture it will reliably
 * return the flattering one, which no assertion in the ladder would catch. Minting the channel is what
 * makes the order survive the join. `analyzeChain` reports `demandsEncounter` FALSE for these chains, so
 * the source seeded nothing and this MINTS one — the case a chain-global boolean threaded from the
 * source structurally could not express.
 *
 * `natural` is the host's own answer for an identity `by()`, and it exists because for two shapes the
 * natural order is NOT one expression: an edge `Property` compares by key THEN value
 * (`GremlinValueComparator`, cited in `property.ts`), which no single `byExpr` can state.
 */
function orderRows(
  step: IRStep, rel: Rel, host: ChildHost, ctx: ChainCtx, fresh: Minter,
  opts: { readonly tie?: (input: Rel) => Expr; readonly natural?: (input: Rel) => readonly Expr[] } = {},
): Rel | null {
  const sort = naturalSort(step, rel, ctx, fresh, opts.natural) ?? sortTerms(step, host, ctx, fresh);
  if (!sort) return null;
  const domain = sort.drop
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: sort.drop })
    : rel;
  const carried = encounterOf(domain.channels);
  const channels = carried ? domain.channels : withChannel(domain.channels, ENCOUNTER);
  const tie = carried ? col(domain.id, carried.col) : opts.tie?.(domain);
  return renumber(
    domain,
    tie ? [...sort.terms, { expr: tie, dir: 'asc' }] : sort.terms,
    [...payloadCols(domain), ...carriedCols(channels)],
    channels, fresh,
  );
}

/**
 * THE TRAVERSER'S OWN ORDER, for a host that answers it as a TERM LIST — or `null` when this `order()`
 * is not asking for it, which sends the caller back to the single-expression `sortTerms`.
 *
 * Two spellings ask for it and no others: no `by()` at all, and a `by()` that names only a DIRECTION.
 * `by(desc)` reverses EVERY term, because it is one comparator over the whole traverser rather than a
 * per-column flag. `shuffle` is deliberately not answered here — `RANDOM()` is `sortTerms`' own arm and
 * has no subject at all.
 */
function naturalSort(
  step: IRStep, rel: Rel, ctx: ChainCtx, fresh: Minter, natural?: (input: Rel) => readonly Expr[],
): { readonly terms: readonly SortTerm[]; readonly drop?: Expr } | null {
  if (!natural || isLocalScope(step) || (step.args ?? []).length) return null;
  const bys = modulations(step, 1, childSeam(ctx, fresh));
  if (!bys) return null;
  const only = bys[0];
  if (only && (only.key.kind !== 'identity' || only.order === 'shuffle')) return null;
  const dir = only?.order === 'desc' ? 'desc' : 'asc';
  return { terms: natural(rel).map((expr) => ({ expr, dir })) };
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
  /** This stream's traverser as a filter SUBJECT — the value, the type column where there is one, and
   *  the row the clause is correlated to. Read off `rel` at the moment it is asked for, like every
   *  other fact here, so a step that reshaped the relation cannot leave it stale. */
  const scalarSubject = (): Subject => ({
    kind: 'scalar', value: col(rel.id, 'v'), rel, type: subjectType(),
    ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') } : {}),
  });

  // A BOUNDARY before a CLAUSE-POSITION READER, and it is not cosmetic. Fusing a `Filter` or a
  // `Sort` into its input's block means the input's outputs are spelled as the EXPRESSIONS that
  // compute them (§5) — SQL has no other option, since neither a `WHERE` nor an `ORDER BY` can name
  // a select alias. So each one re-inlines the whole projection, and with the vtype-aware ordering
  // CASE in play that is ~20 binds apiece: measured 25 / 45 / 65 for one, two and three range
  // predicates, and 24 for a single `order()` (whose key inlines the value expression three times
  // over — once per arm of the compare CASE). A fourth predicate would exceed the DO cap and fail
  // closed on a traversal that must answer — a support regression, not a wall worth shipping.
  // `Materialize` is the declared remedy (§3.3, "a boundary hint … where the planner needs a fence")
  // and lands a CTE-then-read shape.
  //
  // Only the FIRST tail step needs the hint, and that is structural rather than lucky: a reader
  // further along sits over a node the assembler already refuses to fuse into — a `Limit`, a
  // `Distinct`, an earlier `Sort`, or this very fence — so its subject is a column of a finished
  // block and there is nothing left to re-inline.
  if (CLAUSE_READERS.has(steps[from]?.name ?? '') && seed.kind !== 'values')
    rel = make.materialize({ id: fresh('m'), input: rel, channels: rel.channels, type: rel.type });

  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    if (step.name === 'V' || step.name === 'E') {
      const reSourced = reSource(step, rel, out, ctx, fresh);
      return reSourced && elementTail(reSourced.rel, reSourced.elem, steps, at + 1, bulked, ctx, fresh, labels);
    }
    const args = argValues(step);
    if (step.optionArms) return null;
    // The blanket modulator decline exempts the two steps that HOST a `by()` here; each reads it
    // through `modulator.ts` and declines the projections a value stream cannot serve.
    if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
    // A value's own `vtype` is in scope only where it came from a stored property, which is the same
    // distinction `compare()` above draws and the reason `ChildHost` carries it as an optional.
    // The ROW rides with the host so a `by(__.select(label))` can read the alias channel — which is
    // carried state on this relation, not a question a correlated subquery over the value could answer.
    // A STATIC type is the SAME FACT as a per-row `vtype` column, constant-folded — so it rides on the
    // host too, and saying so is what makes a `groupCount()` key over
    // `inject(777).asNumber(GType.BIGINT)` a BigInt on the wire instead of an inferred Int. Leaving it
    // off was not neutral: `byNode` tags an untagged value NULL, and NULL means "infer from the JS
    // value", which cannot tell a BigInt from an Int, a BigDecimal from an Int, or a datetime from a
    // long. §6·7's rule at one more carrier — what is KNOWN is carried, never re-guessed downstream.
    const staticTag = out.kind === 'scalar' && out.type.kind === 'static' ? out.type.type : undefined;
    const host: ChildHost = {
      kind: 'scalar', value: col(rel.id, 'v'), row: { rel, aliases: labels },
      ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') }
        : staticTag ? { vtype: compilerText(staticTag) } : {}),
    };

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
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), fresh, { framing: out, named: namedElsewhere(ctx) });
      if (!selected) return null;
      return continueAs(selected.rel, selected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }

    if (PER_TRAVERSER_HOSTS.has(step.name)) {
      if (out.kind !== 'scalar') return null;
      return perTraverserChild(step, rel, out, steps, at, bulked, ctx, fresh, labels);
    }

    // THE BRANCH FAMILY, over a VALUE stream — the same three builders the element fold calls, because
    // `branchSubject` derives the condition's subject from the FRAMING. Only `union` was here, and only
    // because it needs no subject at all; `choose` took an `elem` and so could not be reached from a
    // value stream at all, which read as a missing branch lowering rather than a missing caller (§6·6).
    if (BRANCH_HOSTS.has(step.name)) {
      const merged = branchArms(step, rel, out, bulked, ctx, fresh, labels);
      if (!merged) return null;
      return continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }

    // `group()`/`groupCount()` over a VALUE stream — the barrier at its second host, and it is the SAME
    // `groupBarrier` rather than a scalar-shaped copy. `groupBarrier`'s own comment had predicted this
    // ("over a SCALAR stream the traverser IS a value, so `by()`-less is exactly the identity
    // projection… it arrives with the scalar-host caller that does not exist yet"), and the caller is
    // all that was missing: `byNode`'s scalar arm already tags the value with its own `vtype`.
    if (step.name === 'group' || step.name === 'groupCount') {
      // ONE call for both forms: the barrier's map and the keyed form's member ROWS come out of the same
      // computation, split at `groupRows`/`groupMap` (`map.ts`). The keyed form registers the rows and
      // the reduction happens at the `cap`, which is where a label filled at N positions can be one
      // grouping over the UNION of them.
      const rows = groupRows(rel, host, step, bulked, childSeam(ctx, fresh), fresh);
      if (!rows) return null;
      // A LABELLED form is a SIDE EFFECT: it fills the named map and passes its traversers on, exactly
      // as it does over an element stream — so the loop CONTINUES and only the unkeyed form becomes the
      // traverser. One rule, two hosts (§6·6's "a child body works wherever it is LEGAL" applied to a
      // barrier rather than to a body).
      if (argValues(step).length) {
        // ⚠️ A KEYED `group("a")` IN A PROGRAM WITH EFFECTS STILL DECLINES, and the reason narrowed
        // rather than went away. The sites now hold `(key, contribution)` MEMBER rows, which is what
        // Phase 4 said would let them take the aggregate sites' `snapshot` binding — but the KEY column
        // holds a JSONB node, and a retained binding travels as JSON (`src/program.ts`), which fails
        // closed on exactly that. Projecting `json(gk)` at the binding is the remaining step.
        if (ctx.mutating) return null;
        if (!registerGrouping(step, rows, ctx.collections, ctx.sideEffectPolicies, fresh)) return null;
        continue;
      }
      const grouped = rows.done ?? groupMap(rows.rel, rows.recipe, fresh);
      return continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf },
        steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }

    // `project()` over a VALUE traverser — the identical record builder, with the host's own framing as
    // what a bare `by()` projects. One lowering at both hosts is the point (§6·6's rule one level up: a
    // shape works wherever it is legal, not wherever a host was taught it), and it is what
    // `call(…)`'s scalar result then reaches through.
    // `sack()` over a VALUE traverser — the same two forms, and the same two answers. The mutate arm
    // is shape-preserving and the read arm replaces the value, so neither needs a scalar-specific
    // lowering: `sackMutate` takes the host it is given and `sackRead` re-projects `v`.
    if (step.name === 'sack') {
      if (sackOperator(step) === undefined) {
        if (args.length) return null;
        const read = sackRead(rel, fresh);
        if (!read) return null;
        rel = read.rel;
        out = read.framing;
        continue;
      }
      const folded = sackMutate(step, rel, host, childSeam(ctx, fresh), fresh);
      if (!folded) return null;
      rel = folded;
      continue;
    }

    if (step.name === 'project') {
      const record = recordOf(rel, host, out, step, childSeam(ctx, fresh), fresh);
      if (!record) return null;
      return continueAs(record.rel, { kind: 'record', fields: record.fields }, steps, at + 1, bulked, ctx, fresh, labels);
    }

    // THE PROJECTORS over a VALUE traverser — `_` IS the value, and a named variable is a scope key.
    // One lowering at every host, for `project()`'s reason: a shape works wherever it is legal, not
    // wherever a host was taught it.
    if (REL_PROJECTORS.has(step.name)) {
      const projected = projectorTail(rel, step, host, childSeam(ctx, fresh), fresh);
      if (!projected) return null;
      rel = projected.rel;
      out = projected.framing;
      continue;
    }

    // `orderRows` owns the whole rule (re-mint, productivity drop, stability). No `tie`: equal keys over
    // a VALUE stream are interchangeable, so the sort terms are the whole order.
    if (step.name === 'order') {
      const ordered = orderRows(step, rel, host, ctx, fresh);
      if (!ordered) return null;
      rel = ordered;
      continue;
    }

    const sliced = sliceOp(step, rel, bulked, fresh);
    if (sliced) { rel = sliced; continue; }

    // THE SCALAR TRANSFORM FAMILY — one `Project` per transform, and the assembler fuses a run of them
    // into one SELECT (`upper(lower(p.v))`).
    // Membership is checked BEFORE the lowering is asked for, so an unlowerable member of the family
    // (`reverse`, `asBool`) DECLINES rather than falling through to be misread by a later arm.
    if (REL_TRANSFORMS.has(step.name)) {
      // `seed.kind === 'values'` IS "the value is a compile-time literal": an `inject()` source is the
      // only one, and it is the population that gets constant-folded. Read off the SEED rather than the
      // current relation, because a preceding transform does not stop a value being literal-derived.
      const tx = transformExpr(step, col(rel.id, 'v'), seed.kind === 'values', fresh);
      if (!tx) return null;
      // EVERY transform drops the per-row `vtype` column, not only the casts: `toUpper()` leaves a
      // value the stored row no longer describes and `length()` turns it into an integer outright, so
      // carrying the column would reframe the RESULT as the INPUT's type. The framing type becomes
      // whatever the transform knows, or `UNKNOWN` — which infers per value.
      // Dropping it also removes the vtype from `subjectType()`, so a following `is(P.gt(…))`
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
    // change — `constantRetype` DROPS the per-row `vtype` (it projects only `v` plus channels), for the
    // reason every transform does: the stored type no longer describes the value that is there now.
    if (step.name === 'constant') {
      const c = constantRetype(rel, step, fresh);
      if (!c) return null;
      rel = c.rel;
      out = c.framing;
      continue;
    }

    if (step.name === 'is') {
      if (args.length !== 1) return null;
      // `is(typeOf(GType.LIST|SET|MAP))` is a TYPE ASSERT, not a predicate: over a scalar stream
      // carrying a stored collection it RETYPES the stream to a list or a map, so lowering it as a
      // filter would return the right rows framed as the wrong shape — a different question, which is
      // the one thing this module may never answer. `collectionAssert` is the derived view of the
      // ONE `typeOfAssert` decode (`child-shape.ts`), reused rather than re-recognized: five arms had
      // already drifted apart decoding this inline, and a sixth copy here would be the same mistake.
      // A TYPE ASSERT is not a predicate: `is(typeOf(LIST|SET))` RETYPES the stream to a collection, so
      // lowering it as a filter would return the right ROWS framed as the wrong SHAPE — the one thing
      // this module may never do. `collectionAssert` is the derived view of the ONE `typeOfAssert`
      // decode, reused rather than re-recognized. A MAP retype needs the map shape, which this route
      // does not have; a stream with no per-row stored type has no stored collection at all, and
      // a generic `is()` static-folds that case.
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

    /**
     * THE FILTER FAMILY over a VALUE stream — `and`/`or`/`not`/`filter`/`where(<body>)`, built by the
     * SAME `sourceFilter` the element loop calls, with a scalar `Subject`.
     *
     * There is nothing scalar-specific to lower here, and that is the point: a connective is the
     * connective applied to its arms' answers whatever the traverser IS, so the whole family arrives
     * at once (and composes to any depth — `filter(or(and(is(…), not(is(…))), …))` recurses through
     * `childPredicate` exactly as it does over elements). What used to make it element-only was a
     * SIGNATURE — an `Elem` beside the subject — rather than anything in the algebra, which is why
     * `Subject` is now a union over the traverser shape (`child.ts`).
     */
    /**
     * `where(P)` / `filter(P)` WITH NO BODY — a predicate on the traverser's own value, which is
     * `is(P)` under another name: `WherePredicateStep` with no start key tests the traverser itself
     * (`gremlin-core/.../step/filter/WherePredicateStep.java`), and `FilterStep` over a bare `P` is
     * the same question.
     *
     * ⚠️ IT IS NOT `is(P)` WHEN AN OPERAND NAMES A LIVE LABEL. `where(P.neq('a'))` is TinkerPop's
     * ALIAS COMPARE — the string is a `selectKey` into the path, not a value — and answering it as a
     * string comparison would be a wrong answer rather than a decline. The alias map is the only
     * thing that can tell the two apart (`where(P.neq(__.constant('marko')))` constant-folds to the
     * same shape with a string that is NOT a label), which is why this arm lives HERE, where the
     * live labels are in scope, rather than in `sourceFilter`.
     */
    if ((step.name === 'where' || step.name === 'filter') && args.length === 1 && isPred(args[0])) {
      if (namesALiveLabel(args[0], labels)) return null;
      const pred = predicateExpr(col(rel.id, 'v'), args[0], subjectType(), null, null, fresh);
      if (!pred) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred });
      continue;
    }

    if (SCALAR_FILTER_HOSTS.has(step.name)) {
      const clause = sourceFilter(step, scalarSubject(), fresh, ctx);
      if (!clause) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
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
      //    `COUNT(*)`, which is what the traversers actually number.
      //
      // The emission order goes with it for the same reason — a survivor has no one position — so
      // the scalar dedup projects the payload alone.
      //
      // A `by()` here is IDENTITY or nothing, and that is not a gap: over a value stream the only
      // projection available IS the value, so `dedup().by()` and bare `dedup()` are the same question
      // (the identical `SELECT DISTINCT p.v` for both). `by(key)`/`by(token)` decline
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
      // A reducer REPLACES the framing, so every field the new one does not recompute has to be
      // carried explicitly — and `productiveNull` is the only one. It says a NULL result is a real
      // value (`ProductiveByStrategy` put explicit nulls in this stream), so dropping it here turns
      // the reference's one null traverser into an empty result. Written once, above all three arms,
      // because writing it three times is how two of them would come to disagree.
      const numeric = {
        kind: 'scalar', type: UNKNOWN, result: 'number',
        ...(out.kind === 'scalar' && out.productiveNull ? { productiveNull: true } : {}),
      } as const satisfies RelFraming;
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
        // min/max, §92·1) rather than the one NULL row a `MIN()` aggregate emits. The `vt` column
        // is the winner's own GREMLIN vtype (`int`/`long`/`string`, from the per-row column or the
        // source's static tag), which the `result:'number'` framer reads through `vtypeToValueType`
        // so a text-carried long frames as a `long` — the vocabulary `values()` frames on. Only the
        // UNKNOWN case (a heterogeneous stream, no vtype) falls back to `typeof`, whose storage-class
        // value the framer routes to `sumBuffer`; there the reference's cross-type error cannot be
        // raised, so this is the documented divergence (§6·7n).
        const rank = 'red_rank';
        // NULL is SKIPPED by min/max — `NumberHelper.max/min` return the non-null side — so it never
        // WINS. It must not be FILTERED, though, and that distinction cost four conformance
        // scenarios: `Operator.max` over an all-null input reduces to null, and
        // `ReducingBarrierStep` has seen starts, so the reference emits ONE null traverser
        // (`gremlin-core/.../step/map/MaxGlobalStep.java:43-46` + `.../util/NumberHelper.java`'s
        // `max`). Filtering answered EMPTY for exactly that case — reachable the moment a
        // `ProductiveByStrategy` collection put nulls in a stream. So nulls sort LAST instead, in
        // both directions: SQLite orders NULLs first ascending and last descending, which is why the
        // `IS NULL` term is explicit rather than left to the direction.
        const present = rel;
        const ranked = make.window({
          id: fresh('rw'), input: present, channels: present.channels,
          type: typeOf(...present.type.cols, meta(rank, 'int')),
          specs: [[rank, {
            kind: 'window-expr', fn: 'row_number', args: [],
            // The single-type-space order + a total raw-value tie-break, shared with the correlated
            // by()-reducer arm (`minMaxOrder`) so the two positions cannot drift.
            spec: { partitionBy: [], orderBy: minMaxOrder(present, out, step.name === 'min') },
          }]],
        });
        // The rank filter reads a windowed column, so fence it (a window may not sit inside another
        // SELECT's WHERE without re-inlining — the rule `sample` obeys and §11 records).
        const frame = make.materialize({ id: fresh('rm'), input: ranked, channels: ranked.channels, type: ranked.type });
        const winner = make.filter({
          id: fresh('rk'), input: frame, channels: frame.channels, type: frame.type,
          pred: { kind: 'binary', op: '=', left: col(frame.id, rank), right: compilerInt(1) },
        });
        rel = make.project({
          id: fresh('red'), input: winner, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
          exprs: [['v', col(winner.id, 'v')], ['vt', minMaxWinnerVt(winner, out)]],
        });
        out = numeric;
        continue;
      }
      const bulk = rel.channels.find((channel) => channel.role === 'bulk');
      const staticSumVt = out.kind === 'scalar' ? staticTypeOf(out.type) : undefined;
      if (step.name === 'sum' && staticSumVt && isLongSumClass(staticSumVt)) {
        // §6·7 rows 1–2. A `sum` over a known `long`/`bigint` class must INCLUDE a value carried as
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
        out = numeric;
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
      out = numeric;
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

    // `aggregate("a")`/`cap("a")` over a VALUE traverser — the identical pair, for `project()`'s
    // reason: a shape works wherever it is legal, not wherever a host was taught it. The members of a
    // scalar collection are the VALUES, keeping their per-row type.
    if (step.name === 'aggregate') {
      const snapshot = registerCollection(step, rel, host, out, ctx.collections, ctx.sideEffectPolicies,
        childSeam(ctx, fresh), fresh, ctx.mutating);
      if (!snapshot) return null;
      // The element tail's rule, at the value tail: a snapshot is an execution step and belongs in
      // the effect sequence at THIS position.
      if (snapshot.length) {
        const tail = scalarTail(rel, out, steps, at + 1, bulked, ctx, fresh, labels);
        return tail && { ...tail, effects: [...snapshot, ...(tail.effects ?? [])] };
      }
      continue;
    }
    if (step.name === 'cap') {
      // CONSUMER-DRIVEN FOLD: the reduction a `cap` performs is chosen by what CONSUMES it, not fixed at
      // the read. `cap("a").select(Column.keys)` over an element-keyed grouping wants the key SIDE, so
      // it projects the DISTINCT key rowids straight off the member rows — a set that MOVES natively —
      // instead of folding to a JSONB map that would expand each key to a public payload and lose the
      // rowid the graph is keyed by (`groupedKeys`, `collection.ts`; the map blob is framed in JS and
      // cannot expand a rowid back). Only the element-keyed case is intercepted; everything else takes
      // the ordinary `reduce`.
      const next = steps[at + 1];
      if (next && selectedColumn(next) === 'keys' && !next.modulators?.length) {
        const collection = collectionOf(step, ctx.collections);
        const keys = collection && groupedKeys(collection, fresh);
        if (keys) return continueAs(keys.rel, keys.framing, steps, at + 2, false, ctx, fresh, NO_ALIASES);
      }
      // CONSUMER-DRIVEN FOLD, the other half: `cap("a").unfold()` folds the members to a JSONB array and
      // immediately explodes it back, so the fold is the IDENTITY on the member rows — the collection
      // already holds one row per member. `readUnfolded` hands back the member relation directly and
      // `capUnfolded` mints an encounter from the SITE ORDER, so the stream is what fold+unfold produced
      // minus the JSON round trip. Only a plain multiset of list members cancels (see `readUnfolded`).
      if (next && next.name === 'unfold' && !(next.args ?? []).length && !next.modulators?.length) {
        const collection = collectionOf(step, ctx.collections);
        const members = collection && readUnfolded(collection, fresh);
        if (members) return capUnfolded(members, steps, at + 2, ctx, fresh);
      }
      const collected = readCollection(step, ctx.collections, fresh);
      if (!collected) return null;
      return continueAs(collected.rel, collected.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }

    // `fold()` — the SHAPE BOUNDARY out of the scalar tail and into the list vocabulary: every
    // traverser becomes one member of ONE list traverser. The member encoding is `list.ts`'s (it is
    // the decision every later member read depends on); what this side owns is the two facts it needs
    // — the per-row type column if the values carry one, and the emission order to fold IN.
    if (step.name === 'fold') {
      if (args.length || isLocalScope(step)) return null;
      const encounter = encounterOf(rel.channels);
      // The stream's OWN type channel crosses into the member channel; a `perRow` type whose column
      // the relation does not actually carry degrades to `unknown` rather than claiming a column that
      // is not there (`assertStreamColumns`' rule, stated at the one seam that can violate it).
      const streamType = out.kind === 'scalar' && !(perRowColumnOf(out.type) && !carries(perRowColumnOf(out.type)!))
        ? out.type : UNKNOWN;
      const folded = foldScalars(rel, {
        type: streamType,
        ...(encounter ? { order: [encounter.col] } : {}),
      }, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }

    // THE CREATION AND MERGE VOCABULARY OVER A SCALAR STREAM — §6·6's rule at the WRITE seam: a step
    // works wherever it is LEGAL, not wherever a tail was taught it.
    //
    // **What these four take from their input is its ROW COUNT**, and a scalar relation has one just
    // as an element relation does. `g.inject(0).mergeV([:])` is `g.V().mergeV([:])` with a different
    // multiplier; the reference draws no distinction at all, because `MergeVertexStep` never looks at
    // the traverser except to materialize a map from it. What actually declined was the snapshot,
    // which projected an `id` column a scalar relation does not have — `traverserCol` is the fix, and
    // it is one line in `write.ts` rather than a scalar-specific write path.
    //
    // **`elem` is `null` here and that is the whole of the safety**, not an omission: the two steps
    // that can read the incoming traverser as an ELEMENT — `addE` with an implicit endpoint, `mergeE`
    // with an omitted `Direction` — already test `elem !== 'vertex'` and refuse. A scalar stream
    // therefore reaches exactly the forms whose endpoints are named outright, which is the reference's
    // own rule (`AddEdgeStartStep` defaults both ends to `null` and raises).
    if (step.name === 'addV' || step.name === 'addE' || step.name === 'mergeV' || step.name === 'mergeE') {
      if (pathCarried(rel)) return null;
      const written = step.name === 'addV' ? addedVertices(rel, steps, at, ctx, fresh)
        : step.name === 'addE' ? addedEdges(rel, null, steps, at, labels, ctx, fresh)
          : mergedElements(rel, steps, at, labels, ctx, fresh);
      if (!written) return null;
      const tail = elementTail(
        written.effects.result, step.name === 'addE' || step.name === 'mergeE' ? 'edge' : 'vertex',
        steps, written.at, false, ctx, fresh, labels,
      );
      return tail && { ...tail, effects: [...written.effects.bindings, ...(tail.effects ?? [])] };
    }

    return null;
  }
  return { rel, framing: out, aliases: labels, bulked };
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
 * scalar column. `inject()` with no arguments is the EMPTY relation (`SELECT NULL AS v WHERE 0`),
 * which `Values` cannot express at all — §3.3 records why it refuses to
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

function injectSource(steps: readonly IRStep[], ordered: boolean, fresh: Minter): { rel: Rel; framing: RelFraming; at: number } | null {
  const step = steps[0]!;
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);
  if (!args.length) return null;
  // A COLLECTION argument here means a MIXED inject (`inject([1,2], 3)`): a list traverser and a
  // scalar traverser in one stream, which is the VARIANT shape rather than either of them. Flattening
  // it — the historical representation, held until a scalar stream gains a per-row shape discriminant —
  // is an approximation, and reproducing an approximation is not the same as reproducing an answer, so
  // this declines instead.
  if (args.some((arg) => Array.isArray(arg))) return null;

  // THE LEADING COERCION PREFIX IS FOLDED AT COMPILE TIME.
  // `asNumber`/`asBool`/`asDate` raise TinkerPop's exact parse and overflow messages, which SQL
  // cannot raise at all — that is why the fold happens over a literal rather than emitting a CAST,
  // and it is why a `CAST` here would answer `1` for `'1,000'` and epoch 0 for an invalid date (§11:
  // a required error became a plausible value). So the fold is REUSED, not re-expressed: it mutates
  // the value array in place and hands back the first ordinary step plus the framing tag it
  // established.
  //
  // ⚠️ **A PARSE FAILURE PROPAGATES — it is the ANSWER, not a decline** (§6·5's permanent `null`). The
  // throw used to be caught here because another route owned the message; with one spine, swallowing
  // it would turn *"Can't parse string '1,000' as number."* into a generic "not supported", which is a
  // required error becoming the wrong error. The module's `null` contract still means "not learned
  // yet"; this is not that.
  const vals = [...args];
  let folded: { at: number; as?: string };
  // A `CoercionDeferral` is vocabulary the fold has not learned, so it DECLINES like any other; a
  // `ValueParseError` is the traversal's answer and travels on.
  try { folded = foldConstantCoercions(steps as IRStep[], vals); }
  catch (error) { if (error instanceof CoercionDeferral) return null; throw error; }

  // The type each row inlines under: a coercion fold (`asNumber`/`asBool`/…) has already retyped the
  // whole stream, so its uniform `as` wins; absent a fold, the value keeps the arg's declared subtype.
  const rowType = (i: number): TypeNode | null =>
    (folded.as as TypeNode | undefined) ?? (folded.at === 1 ? (step.args[i]?.type ?? null) : null);
  // THE TYPE CHANNEL (§6·7). A coercion fold retypes the whole stream, so its `as` wins outright.
  // Absent one, each argument's DECLARED type is read on its own — `injectValueTypes`, the one
  // authority, so what a `char`, a `uuid`, a `datetime` or a long past 2^53 frames as is not
  // re-derived.
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
  // Values order is TinkerPop's inject traversal order. Carry it before a later GraphStep expands
  // each input traverser; minting a position only after the cross join would lose that nesting.
  const channels = ordered ? withChannel([], ENCOUNTER) : [];
  const positioned = ordered ? cells.map((row, i) => [...row, compilerInt(i + 1)]) : cells;
  return {
    rel: make.values({
      id: fresh('inj'), rows: positioned, channels,
      type: perRowType
        ? typeOf(meta('v', 'any', true), meta('vt', 'text', true), ...carriedCols(channels))
        : typeOf(meta('v', 'any', true), ...carriedCols(channels)),
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
 * `jsonb_array(…)` is the member encoding, and it is BARE — `jsonb(json_array(…))` spells the same
 * value the long way. The members are query-text-bounded literals, so a bind
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
    const items = values.map((value, mi) => {
      const item = constLit(members ? members[mi]! : arg(value, itemTypeAt(listArg.type ?? null, mi)));
      // A NON-WHOLE real literal needs the JSON channel's 17-digit form or it comes back a bit short
      // (`inject([0.3333333333333333])`); ints/strings/whole values write exactly, so only these carry
      // the repair. `jsonMemberByTypeof` because a bare decimal's declared type is UNKNOWN here.
      return item && typeof value === 'number' && !Number.isInteger(value) ? jsonMemberByTypeof(item) : item;
    });
    return items.some((item) => !item) ? null : [{ kind: 'json-array', items: items as Expr[], binary: true } as Expr];
  });
  if (rows.some((row) => !row)) return null;
  return {
    rel: make.values({ id: fresh('inl'), rows: rows as readonly (readonly Expr[])[], channels: [], type: typeOf(meta(LIST_COL, 'json')) }),
    framing: { kind: 'list', of: BARE_LIST },
  };
}

/**
 * `g.inject([k:v, …])` — a MAP literal, which seeds one MAP traverser per argument.
 *
 * The map twin of `injectList`, and the SOURCE the doc's §10 names as the map shape's largest
 * multiplier: the whole re-enterable map tail (`select(Column.*)`, `select(<key>)`, `unfold()`,
 * `count(Scope.local)`, a slice) was already built for `group()`/`valueMap()`, so a producer for a
 * literal unlocks all of it at once. `mapLiteralBlob` (`map.ts`) builds the pairs-array blob — the same
 * self-describing tree those producers aggregate, only compile-time here — and DECLINES a non-string
 * key or an unserializable value, which is why this hands back `null` on those rather than a corrupt map.
 *
 * MIXED arguments decline at the `every` gate: `inject([k:v], 3)` is a map traverser and a scalar
 * traverser in one stream, the VARIANT shape rather than either, exactly as `injectList` refuses.
 *
 * The values ORDER is the inject traverser order, carried on the `encounter` channel where the source is
 * ordered — `injectSource`'s rule, so a later barrier over several maps drains them in inject order.
 */
function injectMap(step: IRStep, ordered: boolean, fresh: Minter): { rel: Rel; framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms || !step.args.length) return null;
  if (!step.args.every((a) => a.value instanceof Map)) return null;
  const blobs = step.args.map((a) => mapLiteralBlob(a.value, a.type ?? null));
  if (blobs.some((blob) => !blob)) return null;
  const channels = ordered ? withChannel([], ENCOUNTER) : [];
  const rows = (blobs as Expr[]).map((blob, i) => (ordered ? [blob, compilerInt(i + 1)] : [blob]));
  return {
    rel: make.values({
      id: fresh('injm'), rows, channels,
      type: typeOf(meta(MAP_COL, 'json'), ...carriedCols(channels)),
    }),
    framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } },
  };
}

/**
 * THE LIST TAIL — the vocabulary above a collection-valued relation.
 *
 * Three exits, and they are the three things a list op can do: stay a list (`list.ts`'s member
 * frame), retype to a scalar (`conjoin`, a local reducer, `count(Scope.local)`), or `unfold` into one
 * traverser per member, which hands the rest of the chain to the SCALAR tail. A global row op —
 * `limit(2)` with no `Scope.local` — slices the stream's ROWS and is the ordinary `sliceOp`, which is
 * the distinction drawn by composing the shared row op in front of the local one.
 */
function listTail(
  seed: Rel, of: ListOf, steps: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
  aliases: AliasMap = NO_ALIASES, isSet = false,
): Tail | null {
  let rel = seed;
  let items = of;
  let labels = aliases;
  // A SET marker rides THROUGH the loop rather than being decided at its end, because the answer is a
  // fact about the value's history: `select(Column.keys)` produced a set, a slice or a member filter
  // leaves it one, and a member REWRITE does not (§3.3). It was previously only ever set by the last
  // step of a chain (`listSetOp`'s four deduping ops), so the state had nowhere to live.
  let set = isSet;
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

    // `constant(c)` DISCARDS the list and emits a literal — the shape-independent retype, shared with
    // every tail, so `g.V().fold().constant('x')` composes rather than declining for want of a caller.
    if (step.name === 'constant') {
      const c = constantRetype(rel, step, fresh);
      if (!c) return null;
      return continueAs(c.rel, c.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    // A `select()` over a LIST traverser is the same read as anywhere else — the label decides the
    // shape and `selectTail` decides the loop, so a label holding an element re-enters `elementTail`
    // from here exactly as it does from the scalar tail.
    if (step.name === 'select') {
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), fresh,
        { framing: { kind: 'list', of: items, ...(set ? { set } : {}) }, named: namedElsewhere(ctx) });
      if (!selected) return null;
      return continueAs(selected.rel, selected.framing, steps, at + 1, false, ctx, fresh, labels);
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
      const payloadCols: readonly ColMeta[] = unfolded.member ? [meta(LIST_COL, 'json')]
        : unfolded.mapVal ? [meta(MAP_COL, 'json')]
          : unfolded.nodes ? [meta(NODE_COL, 'json', true)]
            : unfolded.elem ? [meta('id', 'int')]
              : [meta('v', 'any', true), ...(unfolded.typed ? [meta('vtype', 'text', true)] : [])];
      const positioned = renumber(unfolded.rel, terms, [...payloadCols, ...carriedCols(channels)], channels, fresh);
      // A MIXED list's members are HETEROGENEOUS self-describing nodes, so the unfolded stream is a
      // per-row `typedNode` — terminal, exactly as a variant is (a stream that is a vertex on one row
      // and an edge on the next cannot uniformly continue), and `continueAs` declines any follower.
      if (unfolded.nodes) return continueAs(positioned, { kind: 'typedNode' }, steps, at + 1, false, ctx, fresh, labels);
      // A NESTED list's members are LISTS, so the unfolded stream stays in the list vocabulary rather
      // than entering the scalar one — the same explode, a different payload.
      if (unfolded.member) return listTail(positioned, unfolded.member, steps, at + 1, ctx, fresh, labels);
      // A MAP-membered list's members are MAPS, so each unfolds to a map traverser and re-enters
      // `mapTail`. The key side is self-describing (`{kind:'scalar'}` — a map key states its own type);
      // the value side is whatever the list member carried (`mapVal`). This closes the
      // `project().fold().unfold()` round trip and serves `select(Pop.all).by(__.…fold()).unfold()`.
      if (unfolded.mapVal) return mapTail(positioned, { kind: 'scalar' }, unfolded.mapVal, steps, at + 1, ctx, fresh, labels);
      // AN ELEMENT list's members are ELEMENTS, so the round trip closes: the relation carries an `id`
      // again and the rest of the chain is the ordinary element loop. `bulked` is false — a fold reset
      // the multiplicity when it collapsed the stream to one traverser, and each member now stands for
      // exactly one.
      if (unfolded.elem) return elementTail(positioned, unfolded.elem, steps, at + 1, false, ctx, fresh, labels);
      // THE MEMBER TYPE CROSSES BACK ONTO THE ROW CHANNEL, carrier and all: an envelope becomes the
      // `PER_ROW('vtype')` column the explode just projected — the same channel and column name
      // `values()` uses, so the scalar tail's `carries('vtype')` picks it up and an `is(P.gt(…))`
      // after it gets the vtype-aware compare key for free — while a `static` member type crosses
      // unchanged rather than being flattened to `UNKNOWN`, which is what used to happen and cost a
      // `fold().unfold()` its tag. `productiveNull` rides along for the same reason it rides through
      // every other retype: it says a NULL is a real value, and losing it means losing the value.
      return scalarTail(positioned, {
        kind: 'scalar',
        type: unfolded.typed ? PER_ROW('vtype') : memberTypeOf(items) ?? UNKNOWN,
        ...(items.kind === 'scalar' && items.productiveNull ? { productiveNull: true } : {}),
      }, steps, at + 1, false, ctx, fresh, labels);
    }

    // A GLOBAL row op slices the stream's rows, not one traverser's members.
    const sliced = sliceOp(step, rel, false, fresh);
    if (sliced) { rel = sliced; continue; }

    const member = listMemberOp(step, rel, items, fresh, seam);
    if (member) {
      rel = member.rel;
      items = member.of;
      if (member.rewrites) set = false;
      // `dedup(Scope.local)` MAKES a set where the input was a list — `DedupLocalStep` yields a
      // `LinkedHashSet` — and `reverse()` UNMAKES one (`ReverseStep` returns a `List`), so an arm that
      // decides the marker states it and the field is authoritative when present. A rewrite drops it for
      // its own reason: new member values are not the distinct results of anything.
      if (member.set !== undefined) set = member.set;
      // A member op may owe a RUNTIME guard (a local string transform over a non-string member raises,
      // §6·5). It is an execution step — a `Binding.guard` the executor runs before the read — so it
      // recurses the rest of the chain and rides on the tail's `effects`, exactly as a snapshot binding
      // does. This is the ONE list-loop return that carries a guard, so the merge is here rather than a
      // loop-wide accumulator.
      if (member.guard) {
        const tail = listTail(rel, items, steps, at + 1, ctx, fresh, labels, set);
        return tail && { ...tail, effects: [member.guard, ...(tail.effects ?? [])] };
      }
      continue;
    }

    // The SET-OP family, which needs to know whether it is TERMINAL: the four deduping ops frame as a
    // GraphBinary SET only at the end of a chain — with a follower TinkerPop treats the deduped
    // content as a plain List, which is what the suite asserts.
    const setOp = listSetOp(step, rel, items, at + 1 >= steps.length, seam, fresh);
    if (setOp) {
      rel = setOp.rel;
      items = setOp.of;
      if (setOp.set) return { rel, framing: { kind: 'list', of: items, set: true }, aliases: labels, bulked: false };
      continue;
    }

    const retyped = listRetype(step, rel, items, fresh);
    if (!retyped) return null;
    return scalarTail(
      retyped.rel,
      {
        kind: 'scalar', type: retyped.type,
        ...(retyped.result ? { result: retyped.result } : {}),
        ...(retyped.productiveNull ? { productiveNull: true } : {}),
      },
      steps, at + 1, false, ctx, fresh, labels,
    );
  }
  return { rel, framing: { kind: 'list', of: items, ...(set ? { set } : {}) }, aliases: labels, bulked: false };
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
 *   to express empty). A real predicate declines.
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
    // the scalar stream, which has no element arm, so this fails closed on exactly that boundary.
    // See `scalars` on `pathPositions`.
    if (PATH_LIST_OPS.has(step.name)) return scalars ? listTail(rel, of, steps, at, ctx, fresh, labels) : null;
    return null;
  }
  return { rel, framing: { kind: 'path', of, scalars }, aliases: labels, bulked: false };
}

/**
 * THE MAP LOOP — a map traverser is not terminal either.
 *
 * `group()`/`groupCount()`/`cap()` and (next) `valueMap()` all produce ONE map per traverser, and until
 * this existed every one of them was the end of the chain. The list tail's twin, and deliberately as
 * small: what belongs here is only what a Map answers ITSELF, and each of those answers is a retype
 * that hands the relation to whichever loop owns the shape it produced.
 *
 * - **`is(typeOf(GType.MAP))` is IDENTITY** — a map IS a Map. Any other `GType` matches nothing, which
 *   is the empty relation (§3.3's `Filter(false)`); a real predicate declines.
 * - **`count()` counts MAPS and `count(Scope.local)` counts ENTRIES** — the same global/local split the
 *   list vocabulary makes, sharing `countTail` so the two cannot disagree about `SUM(bulk)`.
 * - **`select(Column.keys | Column.values)`** collects one side into a list — a SET for the keys, per
 *   the reference's own two container types (see `mapSide`).
 * - **`unfold()`** makes each ENTRY a traverser.
 *
 * A global slice reads the emission order the map carried through, exactly as anywhere else. Anything
 * else DECLINES rather than being silently dropped — the standing contract at every tail here.
 */
function mapTail(
  seed: Rel, keyOf: MapOf, valOf: MapOf, steps: readonly IRStep[], from: number,
  ctx: ChainCtx, fresh: Minter, aliases: AliasMap,
): Tail | null {
  let rel = seed;
  const labels = aliases;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = argValues(step);
    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }
    if (step.modulators?.length || step.optionArms) return null;

    if (step.name === 'is') {
      if (assertsGType(step, 'MAP')) continue;
      if (typeOfAssert(step).kind !== 'gtype') return null;
      rel = make.filter({
        id: fresh('f'), input: rel, channels: rel.channels, type: rel.type,
        pred: eq(compilerInt(0), compilerInt(1)),
      });
      continue;
    }

    if (step.name === 'count') {
      // `count(Scope.local)` is the map's SIZE — one number per traverser, so the stream keeps its rows
      // and only the payload changes. The GLOBAL `count()` is the barrier that counts the maps.
      if (isLocalScope(step)) {
        if (args.some((arg) => typeof arg === 'number')) return null;
        return scalarTail(mapSize(rel, fresh), { kind: 'scalar', type: STATIC('long'), result: 'count' },
          steps, at + 1, false, ctx, fresh, labels);
      }
      if (args.length) return null;
      const counted = countTail(rel, fresh);
      return scalarTail(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    // `constant(c)` DISCARDS the map and emits a literal — the shape-independent retype, shared with
    // every tail, so `g.V().group().by(k).constant('x')` composes rather than declining.
    if (step.name === 'constant') {
      const c = constantRetype(rel, step, fresh);
      if (!c) return null;
      return continueAs(c.rel, c.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    // `fold()` — every map traverser becomes one member of ONE list: `valueMap().fold()`,
    // `group().by().by().fold()`. The map stream already carries its pairs array in `MAP_COL`, so this
    // is the same barrier the record fold reaches after collapsing — the value-side member shape is the
    // map's own `valOf`, carried through unchanged (a list member is a whole map, framed by the one
    // `{t:'map'}` rule).
    if (step.name === 'fold' && !args.length && !isLocalScope(step)) {
      const encounter = encounterOf(rel.channels);
      const folded = foldMaps(rel, MAP_COL, valOf, { ...(encounter ? { order: [encounter.col] } : {}) }, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }

    const column = selectedColumn(step);
    if (column) {
      const side = mapSide(rel, column, column === 'keys' ? keyOf : valOf, fresh);
      if (!side) return null;
      return listTail(side.rel, side.of, steps, at + 1, ctx, fresh, labels, side.set);
    }

    // `select(<key>)` reads the MAP first — see `mapKey`. A key that also names a LIVE alias declines:
    // the reference's fallthrough (map, then labels) is one COALESCE of two sources whose "absent"
    // tests differ, and answering only the map's half would be a wrong answer where the label is the
    // one that resolves. An alias the relation no longer carries is not live and does not block.
    if (step.name === 'select') {
      const key = selectedKey(step);
      if (key !== null) {
        if (liveAliases(labels, rel).has(key)) return null;
        const keyed = mapKey(rel, key, valOf, fresh);
        if (!keyed) return null;
        return scalarTail(keyed, { kind: 'scalar', type: PER_ROW('vtype') }, steps, at + 1, false, ctx, fresh, labels);
      }
      // MULTI-KEY `select(k1, k2, …)` is a SUB-MAP projection. A key that also names a LIVE alias
      // declines to the alias vocabulary for the single-key rule's reason (the map/label fallthrough is
      // one COALESCE of two sources); a `Column` read was `selectedColumn`'s above, and a modulated
      // select never reaches here (the loop head refuses one).
      const spec = selectSpec(step);
      if (!spec || spec.labels.length < 2) return null;
      if (spec.labels.some((k) => liveAliases(labels, rel).has(k))) return null;
      const selected = mapSelect(rel, spec.labels, valOf, fresh);
      return selected && continueAs(selected.rel, { kind: 'map', keyOf: selected.keyOf, valOf: selected.valOf }, steps, at + 1, false, ctx, fresh, labels);
    }

    if (step.name === 'unfold') {
      if (args.length) return null;
      const unfolded = unfoldMap(rel, fresh);
      // The ENTRY's position becomes the emission order, re-minted for `unfoldList`'s reason:
      // `json_each.key` indexes within ONE map, so a later slice taking its window from a per-row index
      // would return the right multiset from the wrong place. A carried position leads the sort, so
      // every entry of an earlier map precedes every entry of a later one.
      const carried = encounterOf(rel.channels);
      const channels = carried ? rel.channels : withChannel(rel.channels, ENCOUNTER);
      const positioned = renumber(unfolded.rel, [
        ...(carried ? [{ expr: col(unfolded.rel.id, carried.col), dir: 'asc' as const }] : []),
        { expr: col(unfolded.rel.id, unfolded.ord), dir: 'asc' as const },
      ], [...ENTRY_COLS, ...carriedCols(channels)], channels, fresh);
      return mapEntryTail(positioned, keyOf, valOf, steps, at + 1, ctx, fresh, labels);
    }

    const sliced = sliceOp(step, rel, false, fresh);
    if (!sliced) return null;
    rel = sliced;
  }
  return { rel, framing: { kind: 'map', keyOf, valOf }, aliases: labels, bulked: false };
}

/**
 * DOES THIS NAME RESOLVE IN A SCOPE `selectKeys` CANNOT SEE — a `withSideEffect` constant or a named
 * collection this chain has filled?
 *
 * `getScopeValue` tries the traverser's SIDE EFFECTS before the path labels
 * (`gremlin-core/.../step/Scoping.java:126-127`), so a name with no `as()` behind it may still be
 * perfectly resolvable — and treating it as EMPTY would be a wrong answer rather than a conservative
 * one. The record builder sees the alias map and nothing else, so the chain context answers this and
 * the two facts stay where they are owned.
 */
const namedElsewhere = (ctx: ChainCtx) => (label: string): boolean =>
  ctx.sideEffects.has(label) || ctx.sideEffectPolicies.has(label) || ctx.collections.has(label);

/** The two payload columns a Map.Entry relation carries — `framingCols` names the same pair, and
 *  `map.ts`'s `ENTRY` names them for the framer. Stated here as `ColMeta` because `renumber` rebuilds
 *  the relation's whole declared type and cannot ask the framing for it. */
const ENTRY_COLS: readonly ColMeta[] = [meta(ENTRY.key, 'json', true), meta(ENTRY.val, 'json', true)];

/**
 * The single LABEL a `select()` names, or `null` for any other form — the one question a MAP host asks.
 *
 * `selectSpec` IS the parse. The alias vocabulary owns which arguments of a `select()` are labels, and
 * re-deriving it here would be a second recognizer of one grammar — it already rejects a `Column`
 * token, an option map and any argument that is neither a label nor a `Pop`. A `Pop` is accepted and
 * IGNORED, which is the reference's own reading: `getScopeValue` consults the traverser's MAP without
 * it, and only the path-label fallthrough is `pop`-sensitive. A `by()` declines — it projects the
 * VALUE, which is a different question from reading the scope.
 */
function selectedKey(step: IRStep): string | null {
  if (step.modulators?.length) return null;
  const spec = selectSpec(step);
  return spec && spec.labels.length === 1 ? spec.labels[0]! : null;
}

/** `select(Column.keys)` / `select(Column.values)` — the column an entry-shaped host is asked for, or
 *  `null` for any other `select()`. ONE recognizer, because the map loop and the entry loop must agree
 *  about which argument forms are a column read and which are a label read. */
function selectedColumn(step: IRStep): 'keys' | 'values' | null {
  if (step.name !== 'select') return null;
  // `argValues`, NOT `step.args` — an `Arg` is `{value, type, name}` since a user PARAMETER became a
  // first-class IR fact, so a test against the wrapper is permanently false. That exact reading rot is
  // what made `rel-blockers` file every labelled `group("a")` under the unkeyed bucket.
  const args = argValues(step);
  if (args.length !== 1) return null;
  const arg = args[0];
  if (!isColumnArg(arg)) return null;
  return arg.column === 'keys' || arg.column === 'values' ? arg.column : null;
}

/**
 * THE MAP.ENTRY LOOP — what a single entry answers, which is almost entirely its two sides.
 *
 * `Column.keys` over a `Map.Entry` is the KEY ITSELF rather than a collection
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Column.java:26-29`),
 * so the same step name means "collect a side" over a map and "take the side" over an entry — one
 * `Column`, two hosts, which is exactly why the two loops are separate rather than one widened one.
 */
function mapEntryTail(
  seed: Rel, keyOf: MapOf, valOf: MapOf, steps: readonly IRStep[], from: number,
  ctx: ChainCtx, fresh: Minter, aliases: AliasMap,
): Tail | null {
  let rel = seed;
  const labels = aliases;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = argValues(step);
    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }
    if (step.modulators?.length || step.optionArms) return null;

    if (step.name === 'count' && !isLocalScope(step)) {
      if (args.length) return null;
      const counted = countTail(rel, fresh);
      return scalarTail(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    const column = selectedColumn(step);
    if (column) {
      // The side becomes an ordinary per-row-typed value stream, which is what makes
      // `groupCount().unfold().select(Column.values).sum()` the ordinary reducer rather than a
      // map-shaped special case. There is no other side: see `sideList`.
      const side = entrySide(rel, column, column === 'keys' ? keyOf : valOf, fresh);
      if (!side) return null;
      return scalarTail(side, { kind: 'scalar', type: PER_ROW('vtype') }, steps, at + 1, false, ctx, fresh, labels);
    }

    const sliced = sliceOp(step, rel, false, fresh);
    if (!sliced) return null;
    rel = sliced;
  }
  return { rel, framing: { kind: 'mapEntry', keyOf, valOf }, aliases: labels, bulked: false };
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
  /** May the driving property seek run (`src/rel/passes/semijoin.ts`, `indexSeek`)? A PHYSICAL
   *  rewrite over the finished algebra, so unlike every other flag here it changes no lowering
   *  decision — which is why it is read once, at the pass, rather than threaded into the fold. */
  readonly propertySeek?: boolean;
  /** May the physical TextP FTS rewrite drive a bare element scan (`semijoin.ts`, `trigramSeek`)? */
  readonly ftsSubstringPredicate?: boolean;
  /**
   * The GRAPH's declared vertex-label cardinality — a CAPABILITY, not a strategy, which is why it is
   * here rather than being read from a store at lowering time.
   *
   * `addV()` with no label used to decline on the grounds that "under `ZERO_OR_MORE` it creates a
   * vertex with no labels and under `ONE` it takes the graph default" is a property of the store. The
   * property is real; the conclusion was wrong by one step. The cardinality is request-scope DI
   * (`src/scopes.ts`), so it is settled BEFORE a compile starts — what was actually missing is that
   * this seam had not been handed it. Threading it is what makes the answer compile-time, and the
   * label COUNT rule (`min`/`max`) then declines exactly the chains the reference raises a message for.
   *
   * Defaults to `ONE`, which is `createAppScope`'s own default, so an instrument or a test that
   * lowers without an engine measures the default graph rather than a regime nothing runs.
   */
  /** How a `T.label` entry renders (`valueMap(true)`, `elementMap()`) — see `ChainCtx.labelRegime`.
   *  Defaults to `single`, which is `labelRegime`'s own answer when no `with()` asks otherwise. */
  readonly labelRegime?: LabelRegime;
  /**
   * The services this chain's `call()` steps name, RESOLVED — a settled environment, not the
   * registry. `servicesNamedBy` (`services/params/call-params.ts`) does the lookup at the DI
   * boundary, because a `ServiceRegistry` is an ambient capability and `compiler/CLAUDE.md` keeps
   * those out of a lowering. Same category as `sideEffects` below: a constant environment resolved
   * once and read here as data. An absent name simply is not in the map, and the call declines.
   */
  readonly services?: ReadonlyMap<string, Service>;
  /** `withSack(seed[, Operator.x])`'s policy, as the front end extracted it — a SOURCE-level
   *  declaration, settled before a step is lowered, so it is a settled value like `labelCardinality`
   *  rather than a step argument. `null`/absent means the traversal declares no sack and no channel is
   *  minted. */
  readonly sack?: MergePolicy | null;
  /**
   * The `withSideEffect(name, constant)` registry — the SECOND compile-scope constant environment a
   * nested argument resolves against, beside the wire `bindings` in `params`.
   *
   * `withSideEffect(k, v)` with a literal value is a COMPILE-TIME constant: the front-end
   * (`extractSideEffects`) reads it off the parse tree, and a later `__.select(k)` in a write's key,
   * value or merge map resolves to it with no read at all. The shared write parse
   * (`parseProperty`/`mergeMaps`) has always taken it; this route was passing `undefined`, so the
   * whole `mergeV(__.select(c))` family read as an uncovered gap (§6·6).
   *
   * Defaults to EMPTY, which is what a lowering with no source options has.
   */
  readonly sideEffects?: Map<string, any>;
  /**
   * The labels declared with the REDUCER form `withSideEffect(name, seed, Operator.x)` — a seeded,
   * operator-merged collection.
   *
   * Separate from `sideEffects` because it is a different KIND of fact: that map holds constants a
   * `select(name)` substitutes, and a reducer-form declaration has no constant to give. What it has
   * is a POLICY — a seed plus the operator each contribution folds into it with — which the collection
   * spends at the READ (`collection.ts`, `seededFold`). It travels because a fact the front end drops
   * is one no lowering can either fold or decline on: the form used to be skipped entirely, so an
   * `aggregate(name)` registered as though the label were fresh and silently dropped both the seed and
   * the operator. `withSack`'s policy travels the same way and for the same reason.
   */
  readonly sideEffectPolicies?: ReadonlyMap<string, MergePolicy>;
  /**
   * THE NAMED-COLLECTION REGISTRY a rooted sub-chain SHARES with the chain around it — see
   * `ChainCtx.collections`, which this becomes.
   *
   * The one option here that is not a settled constant, and it is a `Lowering` field for exactly one
   * caller: `rootedRead` re-enters `lowerChain` for a nested ROOTED traversal, and a side effect
   * lives on the ROOT traversal (`AggregateStep.java:57` resolves through
   * `this.getTraversal().getSideEffects()`), so `within(__.cap("a").unfold())` must see the outer
   * `aggregate("a")`. Absent, a fresh map — which is the right answer for an actual top-level compile
   * and the WRONG one for a sub-chain, which is what it silently was.
   */
  readonly collections?: Collections;
}

/**
 * The options with every default APPLIED — one authority, because two consumers now need the same
 * answer: the fold reads all four, and the wire projection reads `collapse` (a collapsed leaf carries its
 * multiplicity out as a `bulk` COLUMN, which is exactly the `movementCollapse` gate). A second
 * `?? true` beside this one would be a second default, i.e. the kind of thing that agrees until it does not.
 */
const settle = (opts: Lowering): Required<Lowering> => ({
  params: opts.params ?? {},
  collapse: opts.collapse ?? true,
  correlatedChildren: opts.correlatedChildren ?? true,
  propertySeek: opts.propertySeek ?? true,
  ftsSubstringPredicate: opts.ftsSubstringPredicate ?? true,
  labelRegime: opts.labelRegime ?? 'single',
  sideEffects: opts.sideEffects ?? NO_SIDE_EFFECTS,
  sideEffectPolicies: opts.sideEffectPolicies ?? NO_SIDE_EFFECT_POLICIES,
  services: opts.services ?? NO_SERVICES,
  sack: opts.sack ?? null,
  // A FRESH registry unless a caller hands one down. `rootedRead` is the caller that does, and it
  // must: side effects live on the ROOT traversal (`AggregateStep.java:57`), so a rooted sub-chain
  // shares the outer chain's collections rather than getting an empty map — the isolation that was
  // here before was not a scoping decision, it was wrong against the reference.
  collections: opts.collections ?? new Map(),
});

/** No `withSideEffect` declared. One shared value, for `NO_ALIASES`' reason. */
const NO_SIDE_EFFECTS: Map<string, any> = new Map();

/** No reducer-form `withSideEffect` declared. */
const NO_SIDE_EFFECT_POLICIES: ReadonlyMap<string, MergePolicy> = new Map();

/** No services resolved — an instrument or a test lowering without a registry. Every `call()` then
 *  declines, which is the same answer an unregistered name gets. */
const NO_SERVICES: ReadonlyMap<string, Service> = new Map();

/**
 * THE BIND BUDGET IS A COVERAGE QUESTION, not a crash.
 *
 * §3.6 makes the DO 100-parameter cap a property of the plan that fails closed rather than SQL that
 * only fails in production — and `check` enforces it by THROWING, which is right inside the algebra
 * and wrong at this seam: a traversal that can be answered must not become a compile error because
 * the route spells its predicate more expensively (§11 — the lowering throwing where a traversal must
 * answer is the failure mode a fail-closed compiler must avoid). So the budget is asked HERE, before
 * the plan is handed over, and an over-budget plan is a decline like any unlearned step.
 *
 * It bites at a knowable place: RelIR renders the vtype-aware compare key's class lists as binds, so
 * one element `order().by(key)` is ~27 binds — three in one chain would exceed the cap. Making that a
 * decline is what keeps the wall out of production; making the key cheaper is a separate increment.
 *
 * **The number asked must be the number the WALL measures — so there is no pre-count, only the
 * render.** Any cheap estimate diverges from what the assembler actually spells: it can count a `Lit`
 * the block fuses in twice as one (UNDER), or sum a parameter shared across CTEs once per binding
 * where the render dedups it to a single reused `?N` (OVER). Measured over every corpus prefix: 50
 * divergences, the widest 42 rendered against 31 counted. An under-estimate would admit a plan that
 * renders past 100 and refuse only at emission — after the point this seam could still decline
 * cleanly; an over-estimate would wrongly decline a valid plan. So RENDER once and ask the real list.
 * The render costs ~30µs against a compile and is the
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
 * THE PAYLOAD PROJECTION, APPLIED — the fold's last act, and the §6·3 boundary in one function.
 *
 * A `RelFraming` arm that this route projects for itself becomes a `wire` result whose relation IS the
 * rows `execute.ts` frames; an arm still built by the materializer passes through as `stream`. It runs
 * HERE, between the fold and `name`, and both halves of that placement matter: after the fold, because the
 * projection drops every carried channel and no later step could read one; before `name` and the budget,
 * because the projection's own correlated subplans are part of the plan whose CTEs are chosen and whose
 * binds are counted.
 */
/**
 * **`bulk` COMES FROM THE CHAIN'S OWN `bulked`, NOT FROM THE COLLAPSE SWITCH.** The switch says a
 * collapse was PERMITTED; `bulked` says one HAPPENED, and the two stop agreeing the moment the
 * decision is positional (`ir/bulk.ts`) rather than a chain verdict. Reading the switch would then
 * project a constant-1 `bulk` column onto every element leaf of every traversal — correct, since the
 * framer repeats such a row once, and pure noise in the SQL of every query that never collapsed.
 *
 * Every other arm passes `false` and it is INERT: only this arm projects a `bulk` column at all, and
 * `bulkObservedFrom` refuses a collapse in front of a chain that retypes to any of them, so a
 * multiplicity provably never reaches one. If a future increment admits a retyping consumer that
 * WEIGHTS by bulk (a `fold()` that replicates members, say), that arm owes this projection a column
 * and the `false` beside it becomes a real claim rather than a formality.
 */
/**
 * DOES THIS RESULT STILL HOLD A MULTIPLICITY — the fold's `bulked` AND a channel to read it from.
 *
 * Both halves are needed and neither implies the other. `bulked` is the fold's claim that a collapse
 * happened upstream; the CHANNEL is whether the relation still carries the column, and a global barrier
 * DROPS it (`CHANNEL_BARRIER_POLICY`, `src/channels.ts`) because the barrier has already consumed the
 * multiset — `count()` summed it, `fold()` collected it. So `bulked` goes STALE at every reducer, and
 * reading it alone declined `g.V().out().values('age').sum()`: the collapse was real, the reducer
 * weighted by it correctly, and the scalar result it produced stands for exactly one traverser. Asking
 * the relation is what keeps the flag from outliving the thing it describes.
 */
const carriesMultiplicity = (chain: Tail): boolean =>
  chain.bulked && chain.rel.channels.some((channel) => channel.role === 'bulk');

const framed = (chain: Tail, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } | null => {
  const framing = chain.framing;
  // THE FAIL-CLOSED BACKSTOP, and it should never fire. `bulkObservedFrom` refuses a collapse in front
  // of a chain that retypes away from `elements`, and `inBody` refuses one inside a body whose enclosing
  // framing it cannot see — so a multiplicity arriving at an arm that has no column to put it in means
  // one of those two answered wrongly. Declining is the safe response; projecting anyway would silently
  // drop N−1 traversers per row, which is the one failure class no
  // instrument here catches (a plausible row set, short). This is the guard that makes the completeness
  // of `inBody`'s call sites a tractability question rather than a correctness one.
  if (carriesMultiplicity(chain) && framing.kind !== 'elements' && framing.kind !== 'discard') return null;
  switch (framing.kind) {
    case 'elements': return {
      rel: elementPayload(chain.rel, framing.elem, { bulk: carriesMultiplicity(chain) }, fresh),
      shape: framing.elem === 'edge' ? { kind: 'edge' } : { kind: 'vertex' },
    };
    // A DETACHED element is already ITS OWN payload (`foreign.ts` lands the tuple), so the projection is
    // the identity and the `Shape` is the ordinary one — the byte framers cannot tell a federated vertex
    // from a local one and must not, since the wire has no such distinction. Building the payload the
    // `elements` way would join THIS graph's `nodes` on an id that belongs to another one.
    case 'detached': return {
      rel: chain.rel,
      shape: framing.elem === 'edge' ? { kind: 'edge' } : { kind: 'vertex' },
    };
    case 'scalar': return scalarPayload(chain.rel, framing, fresh);
    case 'list': return listPayload(chain.rel, framing.of, !!framing.set, fresh);
    case 'path': return pathPayload(chain.rel, framing.of, fresh);
    case 'map': return mapPayload(chain.rel, fresh);
    case 'mapEntry': return mapEntryPayload(chain.rel, framing.keyOf, framing.valOf, fresh);
    case 'record': return recordPayload(chain.rel, framing.fields, fresh);
    case 'property': return {
      rel: propertyPayload(chain.rel, framing.ownerElem, fresh),
      shape: { kind: 'property' },
    };
    // A DISCARD has nothing to project: the result relation is a statement with an empty `RETURNING`, so it
    // has no columns and `discard` is already the whole contract. The algebra owes the framing layer nothing
    // further, which is exactly what every other arm here now also means.
    case 'variant': return variantPayload(chain.rel, framing.arms, fresh);
    // A per-row TYPED NODE is already ONE self-describing envelope per row in `NODE_COL`; the wire
    // parses and frames each with `frameTypedNode`, so the payload is that column in emission order.
    case 'typedNode': {
      const ordered = byEncounter(chain.rel, fresh);
      return {
        rel: make.project({
          id: fresh('tn'), input: ordered, channels: [], type: typeOf(meta(NODE_COL, 'json', true)),
          exprs: [[NODE_COL, col(ordered.id, NODE_COL)]],
        }),
        shape: { kind: 'typedNode' },
      };
    }
    case 'discard': return { rel: chain.rel, shape: { kind: 'discard' } };
  }
};

/**
 * THE ARGMIN/ARGMAX ORDER of a scalar `rel` — ONE construction so the GLOBAL barrier (a `row_number`
 * window over the whole stream) and the per-host CORRELATED subquery (a `sort`+`limit(1)`) pick the
 * SAME element. Gremlin orders within a single TYPE SPACE via `storedCompareOn` (the `order().by()`
 * cast authority, so a `long` carried as decimal TEXT past 2^53 orders as a number, not lexically),
 * skips NULL — sorted LAST in both directions so an all-null input still surfaces its one null rather
 * than a real value — and breaks ties on the raw value so the survivor is deterministic under a
 * reversed scan (`test:perturbed`).
 */
function minMaxOrder(rel: Rel, framing: RelFraming, isMin: boolean): readonly SortTerm[] {
  const staticVt = framing.kind === 'scalar' ? staticTypeOf(framing.type) : undefined;
  const carries = rel.type.cols.some((column) => column.name === 'vtype');
  const vtypeExpr = carries ? col(rel.id, 'vtype') : staticVt ? compilerText(staticVt) : undefined;
  const key = vtypeExpr ? storedCompareOn(vtypeExpr)(col(rel.id, 'v')) : col(rel.id, 'v');
  const dir: 'asc' | 'desc' = isMin ? 'asc' : 'desc';
  const nullsLast: Expr = { kind: 'binary', op: 'is', left: col(rel.id, 'v'), right: compilerNull() };
  return [{ expr: nullsLast, dir: 'asc' }, { expr: key, dir }, { expr: col(rel.id, 'v'), dir }];
}

/** The winner row's own GREMLIN vtype — `int`/`long`/`string` from the stored `vtype` column or the
 *  source's static tag, else `typeof` (whose storage-class value the `result:'number'` framer routes to
 *  `sumBuffer`). The twin of `minMaxOrder`: the same authority, read off the SURVIVING row. */
function minMaxWinnerVt(rel: Rel, framing: RelFraming): Expr {
  const staticVt = framing.kind === 'scalar' ? staticTypeOf(framing.type) : undefined;
  return rel.type.cols.some((column) => column.name === 'vtype') ? col(rel.id, 'vtype')
    : staticVt ? compilerText(staticVt)
    : { kind: 'call', fn: 'typeof', args: [col(rel.id, 'v')] };
}

/**
 * THE SCALAR PAYLOAD — `SELECT v[, <the type column>]`, in emission order.
 *
 * The smallest arm, and the only one whose builder lives here rather than beside its vocabulary, because
 * the scalar vocabulary IS this module (`scalarTail`). What varies is the SECOND column and which `Shape`
 * reads it, and `result` is the total answer — a three-way split:
 *
 * - a NUMERIC REDUCER (`result: 'number'`) carries `vt`, the aggregate's own `typeof(…)`. Its storage class
 *   is DYNAMIC — a sum of integers is an integer, of reals a real — so there is no compile-time tag to
 *   give and the framing arm is `{kind: 'scalar'}`, which is the one that reads that column.
 * - a PER-ROW type names a stored `vtype` column so the framer frames each row by its own type rather
 *   than by one tag for the whole result. `perRowColumnOf` is the authority.
 * - anything else is one value and one static-or-unknown tag, so `v` alone.
 *
 * `productiveNull` is CARRIED, and where it comes from is the point: it is the `ProductiveByStrategy`
 * fact recorded on the LIST whose members a local reducer collapsed. It used to be absent here because
 * the RelIR route never set it — and it could not, because a list's `productiveNull` lived on a
 * descriptor that any re-tagging replaced wholesale. With the member type channel unified it simply
 * travels, which is what turns "a typed list of nulls emits nothing" from an open question into a
 * dropped field.
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
    shape: framing.result === 'number'
      ? { kind: 'scalar', productiveNull: !!framing.productiveNull }
      : { kind: 'value', type: framing.type },
  };
};

const lowered = (chain: Tail, propertySeek: boolean, ftsSubstringPredicate: boolean, fresh: Minter): RelLowering | null => {
  const wire = framed(chain, fresh);
  // A shape whose payload projection is not built yet is COVERAGE WE DO NOT HAVE, so it declines exactly as
  // an unlearned step does. It must not throw: declining is the clean deferral, and `rel-sweep` is the
  // gate that proves this seam never raises where it should decline.
  if (!wire) return null;
  // PHYSICAL PASSES RUN BEFORE NAMING, because naming decides CTE boundaries from the DAG's sharing
  // and a rewrite that changes the DAG after that decision would be naming a plan that no longer
  // exists. `semijoin` (`src/rel/passes/semijoin.ts`) is the physical tier: a `Rel → Rel` identity on
  // every shape no offered strategy recognises. The switches are read HERE and not inside the pass —
  // a pass is a total function of its input, so a config can only change which access-path STRATEGIES
  // are offered, never whether the plan exists. Order is load-bearing: `trigramSeek` before
  // `indexSeek` gives a substring predicate the trigram index rather than a base-table `LIKE`.
  const named = nameBindings(semijoin(wire.rel, [
    ...(ftsSubstringPredicate ? [trigramSeek] : []),
    ...(propertySeek ? [indexSeek] : []),
  ]));
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
  // binding, and wrongly declining a repeated-parameter plan that RelIR could actually fit would turn
  // a valid traversal into a failure. `emitRelational` renders
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
  return chain && lowered(chain, settled.propertySeek, settled.ftsSubstringPredicate, fresh);
}

/**
 * THE RESUMED CHAIN — everything after a barrier `call()`, lowered over the rows it awaited.
 *
 * A barrier service answers on a Promise, so the executor drives the plan in segments: run the head,
 * await `apply`, then come back HERE with the rows. This is `lowerToRel`'s twin for that second half —
 * the same fold, the same context, the same budget — differing in exactly one thing: the seed is a
 * LANDED relation (`foreign.ts`) rather than a source step, because the rows are data the compiler now
 * holds and no `Scan` can produce them.
 *
 * It is a separate entry point rather than a `call()` arm inside `lowerChain` because the two run at
 * different TIMES. `lowerChain` runs before anything executes and cannot know what a sibling graph will
 * return; this runs after the await, when the answer is a value. Threading that through the source
 * dispatch would mean a fold arm whose input is not the traversal.
 */
export function lowerForeignResume(
  rows: readonly ForeignRow[], elem: Elem, steps: readonly IRStep[], from: number, opts: Lowering = {},
  rejoin?: { readonly values: readonly unknown[]; readonly injection: InjectionKind | undefined },
): RelLowering | null {
  const fresh = minter();
  const settled = settle(opts);
  const { ctx, facts } = chainCtxOf(steps.slice(from), settled);
  // A landed relation carries no channels — the rows crossed a segment boundary as detached
  // references, so nothing survived to seed a bulk, an encounter or a path from. A resumed chain that
  // DEMANDS one therefore declines rather than compiling a plan with the column silently missing,
  // which is the same rule the fold applies to a source it cannot seed (§12, order and determinism).
  if (facts.demandsEncounter || facts.tracksPath) return null;
  const landed = foreignRelation(rows, elem, fresh);
  // A MID-traversal barrier's pool is per-CALL, not per-parent: the sibling ran once over the distinct
  // injected values, so the rows have to be scattered back over the parents that asked before anything
  // reads them. Doing it here rather than in the tail is what keeps the tail one vocabulary — after the
  // rejoin the relation is the same landed shape a source-form call produces.
  const seed = rejoin ? foreignRejoin(landed, elem, rejoin.values, rejoin.injection, fresh) : landed;
  const chain = detachedTail(seed, elem, steps, from, ctx, fresh);
  return chain && lowered(chain, settled.propertySeek, settled.ftsSubstringPredicate, fresh);
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
/**
 * THE CHAIN CONTEXT — the settled options plus the chain-global facts, in one place because two
 * entry points build one: the ordinary source fold below, and the RESUMED fold a barrier `call()`
 * continues into (`lowerForeignResume`). Deriving the facts twice is how the two would drift on the
 * one question that has no local answer.
 *
 * EMISSION ORDER is a chain-global fact, decided once and threaded — never re-derived per step. A
 * chain that demands one and reaches a step this route cannot thread it through declines WHOLE:
 * silently omitting the channel would not defer, it would pick a different window from the same
 * multiset — right arity, plausible rows, and a census that structurally cannot see it (`ord` is
 * telemetry, `ms` is the gate).
 */
function chainCtxOf(steps: readonly IRStep[], opts: Lowering): { ctx: ChainCtx; facts: ChainFacts } {
  const { params, collapse, correlatedChildren, labelRegime, sideEffects, sideEffectPolicies, services, sack, collections } = settle(opts);
  const facts = analyzeChain(steps as IRStep[]);
  return {
    facts,
    ctx: {
      params, correlatedChildren, collapse, ordered: facts.demandsEncounter, sliced: facts.demandsSlice, tracksPath: facts.tracksPath,
      labelRegime, sideEffects, sideEffectPolicies, services, sack, collections,
      mutating: steps.some((step) => MUTATING_STEPS.has(step.name)),
    },
  };
}

function lowerChain(steps: readonly IRStep[], opts: Lowering, fresh: Minter): Tail | null {
  const { ctx, facts } = chainCtxOf(steps, opts);
  const { params } = ctx;
  const ordered = facts.demandsEncounter;
  const tracksPath = facts.tracksPath;
  const orderedChannels = ordered ? withChannel(BULK, ENCOUNTER) : BULK;
  const seedChannels = tracksPath ? withChannel(orderedChannels, PATH_CHANNEL) : orderedChannels;
  const first = steps[0];
  if (!first) return null;

  /** `withSack(seed)`'s channel, layered onto whatever a source produced — one helper for every
   *  source, because seeding it is the same act wherever the traverser came from. A declared sack
   *  the seed vocabulary cannot express declines the WHOLE chain rather than compiling a traversal
   *  with no accumulator in it. */
  const sacked = (rel: Rel): Rel | null => (ctx.sack ? seedSack(rel, ctx.sack, fresh) : rel);

  // `g.union(a, b, …)` in SOURCE position — every arm is a ROOTED chain of its own, correlated to
  // nothing, so this is NOT the chain-position `union()` with a different input. `unionArms` lowers
  // each body against the CURRENT traverser; here there is none, and each arm re-enters `lowerChain`
  // whole. That distinction is why `sourceUnion` deliberately does not use the child-body arm triage,
  // and why this is a source arm rather than a widening of that one.
  //
  // What is SHARED is everything after the arms exist: `mergeArms` is parent-agnostic, which is what
  // taking a `Channels` rather than an input relation now makes explicit — a source union has no
  // input to take them from, so the first arm's are the base every arm must agree with.
  if (first.name === 'union') {
    const merged = sourceUnion(first, ctx, fresh);
    if (!merged) return null;
    return continueAs(merged.rel, merged.framing, steps, 1, false, ctx, fresh, NO_ALIASES);
  }

  if (first.name === 'inject') {
    // A MAP literal seeds a MAP traverser, a COLLECTION literal a LIST one, an ordinary value a SCALAR
    // one — three shapes, and the ARGUMENT decides which. A `Map` is neither an array nor a scalar, so
    // the arms are disjoint and their order is only which decline is spelled first.
    const mapped = injectMap(first, ordered, fresh);
    if (mapped) {
      const withSack = sacked(mapped.rel);
      return withSack && continueAs(withSack, mapped.framing, steps, 1, false, ctx, fresh, NO_ALIASES);
    }
    // A COLLECTION literal seeds a LIST traverser, an ordinary value a SCALAR one — two shapes, and
    // the argument decides which, so the list arm is asked first and declines a scalar inject.
    const listed = injectList(first, fresh);
    if (listed) {
      const withSack = sacked(listed.rel);
      return withSack && listTail(withSack, (listed.framing as { readonly of: ListOf }).of, steps, 1, ctx, fresh);
    }
    const injected = injectSource(steps, ordered, fresh);
    if (!injected) return null;
    const withSack = sacked(injected.rel);
    return withSack && scalarTail(withSack, injected.framing, steps, injected.at, false, ctx, fresh);
  }

  // `g.call(...)` AS A SOURCE. The service was resolved at the DI boundary (`servicesNamedBy`), so
  // what happens here is the part that genuinely needs the site: `resolve(site)` picks the
  // contribution for THIS call, and only a `rel` one lowers here. A `stream` service declines —
  // the ordinary "not learned yet" null. A `barrier` declines too, permanently and for a different
  // reason: its rows arrive from an awaited sibling, so there is nothing to lower at compile time at all.
  //
  // `resolve` may THROW (a service validates its params: `tinker.search` rejects a regex or a
  // sub-trigram term). That throw is the user's answer, and this module's contract is `null`, so it is
  // caught exactly as the coercion fold's is.
  if (first.name === 'call') {
    const spec = parseCallSpec(first, params);
    const service = ctx.services.get(spec.serviceName);
    if (!service) return null;
    const site: RelCallSite = {
      params: spec.params, boundParams: params, federationDepth: 0, fresh,
    };
    // A SERVICE'S OWN THROW IS NOT CAUGHT, and that is §6·5's distinction rather than an oversight.
    // Two facts wear a `null` in this module — "not learned yet" and "the answer is an ERROR" — and a
    // service rejecting its params is the second, permanently. `tinker.search` refuses a `regex` param
    // and a term below the trigram floor with messages the USER must see; swallowing them into a
    // decline would replace those messages with the wrong thing entirely (a generic "not supported"
    // for what is really "a term shorter than 3 characters cannot be served by the trigram index"), so
    // propagating them is what keeps the user's answer right.
    const contribution = service.resolve(site);
    if (contribution.kind !== 'rel') return null;
    const contributed = contribution.buildRel(site);
    if (!contributed) return null;
    // A SOURCE call contributes a RELATION. A `value` product here would be a `streaming` service
    // asked to produce rows from nothing — there is no host traverser at the head of a chain — and
    // the service itself raises for that (the "must be called mid-traversal" message), so reaching
    // here with one is a service ignoring its own declared type rather than a shape to interpret.
    if (contributed.kind !== 'relation') return null;
    // Through the ONE dispatcher, so a service's shape is not a special case here. It was scalar-only
    // while `--list` was the only `rel` service; `tinker.search` contributes a PROPERTY, and a source
    // arm that enumerated shapes would be a second place to teach every new one.
    return continueAs(contributed.rel, contributed.framing, steps, 1, false, ctx, fresh, NO_ALIASES);
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
    const merged = mergedElements(one, steps, 0, NO_ALIASES, ctx, fresh);
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
  // over one scan instead of a CTE-per-filter with its re-join.
  let pred = seeded.pred;
  let at = 1;
  let elem = seeded.elem;
  for (; at < steps.length; at++) {
    const clause = sourceFilter(steps[at], { kind: 'element', id: col(seeded.scan.id, 'id'), label: elem === 'edge' ? col(seeded.scan.id, 'label') : undefined, rel: seeded.scan, elem }, fresh, ctx);
    if (!clause) break;
    pred = and(pred, clause);
  }

  // The `Filter` this builds over a bare element scan is what `src/rel/passes/semijoin.ts` reads: a
  // selective property predicate here can only be CHECKED, and the pass is what turns it into the
  // relation the plan is driven from. Deliberately not decided here — recognising it on the ALGEBRA
  // means it cannot drift with which STEPS happen to fold into this run.
  const source = pred ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred }) : seeded.scan;
  // The seed of the emission order is the ROWID: a scan's
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

  const withSack = sacked(rel);
  return withSack && elementTail(withSack, elem, steps, at, false, ctx, fresh, NO_ALIASES);
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
 * movement/filter/row-op vocabulary — a second implementation of that loop, which one spine forbids.
 * Every host now re-enters ONE loop, so a step learned here is learned at every position it can occupy.
 *
 * `bulked` — does a row stand for more than ONE traverser? Only a collapse makes that true, and a
 * slice has to know because `LIMIT n` over (element, N) rows answers a different question
 * (`bulkSlice`). It is a fact about the relation the algebra cannot state — `bulk` is a channel
 * whether its value is 1 or not — so it rides beside `rel` exactly as `elem` does. Conservative on
 * purpose: a `dedup` resets the multiplicity to 1 and this does not learn that, which costs the
 * heavier slice form and never a wrong answer.
 */
/**
 * THE DETACHED TAIL — what a barrier's landed elements support, which is every read that the landed
 * columns already answer and nothing else.
 *
 * `id()`, `label()` and `values(k…)` read the tuple `foreign.ts` landed; each hands off to
 * `scalarTail`, so everything AFTER them composes exactly as it does over a local element's value — a
 * federated `values('name').order()` is the ordinary scalar fold, not a second vocabulary.
 *
 * Everything else DECLINES, and that is TinkerPop's rule rather than a coverage gap: a detached
 * element carries no live adjacency, so `out()`/`properties()`/`has()` have no table to reach. The
 * honest answer is to refuse — joining this graph's `nodes` on an id that belongs to another one
 * would return a plausible, wrong row set. The traversal that wants those steps pushes them INTO the
 * sub-traversal the barrier runs on the far side, where the elements are attached.
 */
function detachedTail(
  seed: Rel, elem: Elem, steps: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
): Tail | null {
  const step = steps[from];
  if (!step) return { rel: seed, framing: { kind: 'detached', elem }, bulked: false, aliases: NO_ALIASES };
  if (step.name === 'id' || step.name === 'label') {
    const value = step.name === 'id' ? col(seed.id, 'id') : foreignLabelValue(seed, elem);
    const rel = make.project({
      id: fresh('fgs'), input: seed, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', value]],
    });
    // An id frames as whatever it was STORED as (a `uid` string or a rowid int), so it carries no static
    // tag and infers per value; a label is always a string.
    return scalarTail(rel, { kind: 'scalar', type: step.name === 'label' ? STATIC('string') : UNKNOWN }, steps, from + 1, false, ctx, fresh);
  }
  if (step.name === 'values') {
    const keys = argValues(step).filter((key): key is string => typeof key === 'string');
    if (keys.length !== step.args.length) return null;
    return scalarTail(
      foreignValues(seed, elem, keys, fresh), { kind: 'scalar', type: PER_ROW('vtype') }, steps, from + 1, false, ctx, fresh,
    );
  }
  return null;
}

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
    if (step.name === 'V' || step.name === 'E') {
      const reSourced = reSource(step, rel, { kind: 'elements', elem }, ctx, fresh);
      return reSourced && elementTail(reSourced.rel, reSourced.elem, steps, at + 1, bulked, ctx, fresh, labels);
    }
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
      // non-combinable role), but as a THROW where the traversal must answer: `rel-sweep` found
      // exactly that on `V().as('a').both()`.
      // THE THIRD CONDITION IS THE SUFFIX, and it is the half a channel cannot state. The two above
      // ask whether these rows may MERGE here; a collapse is also only result-equivalent while every
      // consumer BEHIND it reads the multiplicity the merge created. `bulkObservedFrom` is that
      // question, asked of this position (`ir/bulk.ts`, which carries the TinkerPop/Calcite prior art
      // for why it is positional). Without it a widened collapse is not slower, it is WRONG: only the
      // `elements` framing arm carries `bulk` to the wire, so a chain that retypes to a scalar and
      // ends would answer N traversers as one row.
      const collapsing = ctx.collapse && !encounterOf(moved.rel.channels) && groupableChannels(moved.rel.channels)
        && bulkObservedFrom(steps, at + 1);
      rel = collapsing ? coalesce(moved.rel, fresh) : moved.rel;
      bulked = bulked || collapsing;
      elem = moved.elem;
      continue;
    }
    // An ALIAS-AWARE where/not — a two-variable theta or a body re-rooted at a bound `as()` label —
    // reads a PATH label rather than the current traverser, so it is a correlated test over the alias
    // element that `sourceFilter` (rooted at the current row) cannot express. Try it first; a `null`
    // means it is an ordinary current-traverser filter and falls through to `sourceFilter` unchanged.
    const aliased = aliasWhere(step, rel, labels, ctx, fresh);
    if (aliased === 'decline') return null;
    if (aliased) { rel = aliased; continue; }
    const clause = sourceFilter(step, { kind: 'element', id: col(rel.id, 'id'), rel, elem }, fresh, ctx);
    // `rel.channels`, NOT `BULK`: a `Filter` is channel-preserving by contract (§3.5), so naming a
    // list rather than passing the input's through is a chance to name a SHORTER one — and under
    // `demandsEncounter` the relation carries `bulk` AND `encounter`, so the hardcoded `BULK` dropped
    // the position its own input still declared. The factory catches it (`filter changed its carried
    // channels`), which made a fail-closed VIOLATION rather than a wrong answer: the lowering threw
    // where the traversal must answer. Found by L5 on a generated `E().limit(1).has(…).where(…)` — no
    // corpus traversal has that prefix, so the corpus sweep could not reach it.
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
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), fresh,
        { framing: { kind: 'elements', elem }, named: namedElsewhere(ctx) });
      if (!selected) return null;
      return continueAs(selected.rel, selected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }
    // `match()` — the conjunctive pattern step. It re-roots each pattern body at its start alias and
    // folds it through the CHILD SEAM (the same fold this chain is), rejoining by binding or
    // constraining each end. It produces a bindings-map/alias-carrying stream, so it hands back to the
    // ONE dispatcher exactly like `select`. See `match.ts` and `docs/2026-08-13-match-relir-lowering-plan.md`.
    if (step.name === 'match') {
      if (pathCarried(rel)) return null;
      const matched = lowerMatch(step, rel, elem, labels, ctx.params, childSeam(ctx, fresh), fresh);
      if (!matched) return null;
      return continueAs(matched.rel, matched.framing, steps, at + 1, false, ctx, fresh, matched.aliases);
    }
    // THE PER-TRAVERSER CHILD HOSTS — one lowering, three cardinality policies (`perTraverserChild`).
    if (PER_TRAVERSER_HOSTS.has(step.name))
      return perTraverserChild(step, rel, { kind: 'elements', elem }, steps, at, bulked, ctx, fresh, labels);
    if (BRANCH_HOSTS.has(step.name)) {
      const framing = { kind: 'elements', elem } as const;
      const merged = branchArms(step, rel, framing, bulked, ctx, fresh, labels);
      if (!merged) return null;
      // `bulked` after a merge is the value that ENTERED it, and it no longer needs the `|| ctx.collapse`
      // conservatism it used to carry. That existed because "an arm may have collapsed and the arm
      // lowering does not report it back" — true while an arm inherited the collapse switch, and false
      // now that `inBody` turns it off for every body: no arm can mint a multiplicity, so the merged
      // rows stand for exactly what the input rows stood for. Keeping the disjunction once the switch
      // stopped implying the chain verdict would make EVERY merge bulked, which is not merely the
      // heavier slice form — it trips `framed`'s backstop and declines the traversal.
      return continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }
    if (step.name === 'repeat') {
      const walked = repeatWalk(step, rel, elem, childSeam(ctx, fresh), fresh, labels);
      if (!walked) return null;
      return continueAs(walked.rel, walked.framing, steps, at + 1, bulked, ctx, fresh, walked.aliases);
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
      // ONE call for both forms: the barrier's map and the keyed form's member ROWS come out of the same
      // computation, split at `groupRows`/`groupMap` (`map.ts`). The keyed form registers the rows and
      // the reduction happens at the `cap`, which is where a label filled at N positions can be one
      // grouping over the UNION of them.
      const rows = groupRows(rel, elementHost(rel, elem, labels), step, bulked, childSeam(ctx, fresh), fresh);
      if (!rows) return null;
      // A LABELLED `group("a")`/`groupCount("a")` is a SIDE EFFECT, not a barrier result:
      // `GroupSideEffectStep` fills the named map and passes its incoming traversers ON, which is
      // `aggregate`'s contract exactly. So the map is registered and the loop CONTINUES from the
      // unchanged relation; only the unkeyed form becomes the traverser.
      if (argValues(step).length) {
        // ⚠️ A KEYED `group("a")` IN A PROGRAM WITH EFFECTS STILL DECLINES, and the reason narrowed
        // rather than went away. The sites now hold `(key, contribution)` MEMBER rows, which is what
        // Phase 4 said would let them take the aggregate sites' `snapshot` binding — but the KEY column
        // holds a JSONB node, and a retained binding travels as JSON (`src/program.ts`), which fails
        // closed on exactly that. Projecting `json(gk)` at the binding is the remaining step.
        if (ctx.mutating) return null;
        if (!registerGrouping(step, rows, ctx.collections, ctx.sideEffectPolicies, fresh)) return null;
        continue;
      }
      const grouped = rows.done ?? groupMap(rows.rel, rows.recipe, fresh);
      return continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf },
        steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }
    // `project()` — a per-row RECORD, and NOT a barrier: the channels ride through, so the alias map
    // carries and a following `select(label)` still finds its label. That is the whole difference from
    // the `group()` arm above, and it is the reference's (`ProjectStep extends ScalarMapStep`, while
    // `GroupStep extends ReducingBarrierStep`).
    // THE PROJECTORS — a RETYPE from an element traverser to a value, exactly as `values()`/`count()`
    // are, so they hand the relation to `continueAs` and the scalar tail takes the rest of the chain.
    // They are not in `terminal()` with them because they HOST a `by()`, which every arm there declines.
    if (REL_PROJECTORS.has(step.name)) {
      // A carried PATH declines for `terminal()`'s reason: the value is a new traverser object and
      // nothing here appends it as a path position.
      if (pathCarried(rel)) return null;
      const projected = projectorTail(rel, step, elementHost(rel, elem, labels), childSeam(ctx, fresh), fresh);
      if (!projected) return null;
      return continueAs(projected.rel, projected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }
    // `aggregate("a")` — fill a NAMED COLLECTION and pass the traversers through. Shape-preserving,
    // so it sits in the ordinary loop beside `as()`; what it changes is chain state, not the relation.
    if (step.name === 'aggregate') {
      if (pathCarried(rel)) return null;
      const snapshot = registerCollection(step, rel, elementHost(rel, elem, labels), { kind: 'elements', elem },
        ctx.collections, ctx.sideEffectPolicies, childSeam(ctx, fresh), fresh, ctx.mutating);
      if (!snapshot) return null;
      // A SNAPSHOT IS AN EXECUTION STEP, so it enters the effect sequence HERE — before whatever the
      // rest of the chain writes, which is the whole point of taking it. Same prepend a write step
      // makes, for the same reason: the recursion returns the tail from after this position.
      if (snapshot.length) {
        const tail = elementTail(rel, elem, steps, at + 1, bulked, ctx, fresh, labels);
        return tail && { ...tail, effects: [...snapshot, ...(tail.effects ?? [])] };
      }
      continue;
    }
    // `cap("a")` — the collection as ONE list traverser. A SHAPE BOUNDARY, and a total re-root: the
    // incoming stream is discarded (a cap emits one fresh traverser), so the alias channel goes with
    // it and the list tail takes the rest of the chain.
    if (step.name === 'cap') {
      // CONSUMER-DRIVEN FOLD: the reduction a `cap` performs is chosen by what CONSUMES it, not fixed at
      // the read. `cap("a").select(Column.keys)` over an element-keyed grouping wants the key SIDE, so
      // it projects the DISTINCT key rowids straight off the member rows — a set that MOVES natively —
      // instead of folding to a JSONB map that would expand each key to a public payload and lose the
      // rowid the graph is keyed by (`groupedKeys`, `collection.ts`; the map blob is framed in JS and
      // cannot expand a rowid back). Only the element-keyed case is intercepted; everything else takes
      // the ordinary `reduce`.
      const next = steps[at + 1];
      if (next && selectedColumn(next) === 'keys' && !next.modulators?.length) {
        const collection = collectionOf(step, ctx.collections);
        const keys = collection && groupedKeys(collection, fresh);
        if (keys) return continueAs(keys.rel, keys.framing, steps, at + 2, false, ctx, fresh, NO_ALIASES);
      }
      // CONSUMER-DRIVEN FOLD, the other half: `cap("a").unfold()` folds the members to a JSONB array and
      // immediately explodes it back, so the fold is the IDENTITY on the member rows — the collection
      // already holds one row per member. `readUnfolded` hands back the member relation directly and
      // `capUnfolded` mints an encounter from the SITE ORDER, so the stream is what fold+unfold produced
      // minus the JSON round trip. Only a plain multiset of list members cancels (see `readUnfolded`).
      if (next && next.name === 'unfold' && !(next.args ?? []).length && !next.modulators?.length) {
        const collection = collectionOf(step, ctx.collections);
        const members = collection && readUnfolded(collection, fresh);
        if (members) return capUnfolded(members, steps, at + 2, ctx, fresh);
      }
      const collected = readCollection(step, ctx.collections, fresh);
      if (!collected) return null;
      return continueAs(collected.rel, collected.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }
    // `fold()` — the SHAPE BOUNDARY out of the element loop, the twin of the scalar tail's own. Every
    // traverser becomes one MEMBER of one list traverser, and for elements the member is the rowid:
    // `listPayload` expands it at the root, so a following `range(local)`/`unfold().limit(1)` throws
    // rows away before anything computes a property bag for them.
    if (step.name === 'fold') {
      if (argValues(step).length || isLocalScope(step) || step.modulators?.length || pathCarried(rel)) return null;
      const encounter = encounterOf(rel.channels);
      const folded = foldElements(rel, elem, encounter ? { order: [encounter.col] } : {}, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }
    if (step.name === 'project') {
      // A carried PATH declines for `terminal()`'s reason: the record is a new traverser object and
      // nothing here appends it as a path position, so a later `path()` would report a history with a
      // step missing rather than fail.
      if (pathCarried(rel)) return null;
      const record = recordOf(rel, elementHost(rel, elem, labels), { kind: 'elements', elem }, step, childSeam(ctx, fresh), fresh);
      if (!record) return null;
      return continueAs(record.rel, { kind: 'record', fields: record.fields }, steps, at + 1, bulked, ctx, fresh, labels);
    }
    // `sack(Operator.x).by(v)` MUTATES the accumulator and leaves the traverser alone, so it is an
    // ordinary shape-preserving step of this loop. The bare READ form is a RETYPE and falls through
    // to `terminal()`, which is where every element→value boundary lives.
    if (step.name === 'sack' && sackOperator(step) !== undefined) {
      const folded = sackMutate(step, rel, elementHost(rel, elem, labels), childSeam(ctx, fresh), fresh);
      if (!folded) return null;
      rel = folded;
      continue;
    }
    if (step.name === 'mergeV' || step.name === 'mergeE') {
      if (pathCarried(rel)) return null;
      const merged = mergedElements(rel, steps, at, labels, ctx, fresh);
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
    if (step.name === 'addLabel' || step.name === 'dropLabel' || step.name === 'dropLabels') {
      if (pathCarried(rel)) return null;
      if (step.modulators?.length || step.optionArms) return null;
      // A sideEffect that mutates labels and passes the SAME vertices through, so the tail is the
      // ordinary fold after it. Both lowerings decline the refusal cases (edge/immutable/mixed
      // collection), which are errors rather than writes this route may make.
      const mutated = step.name === 'addLabel'
        ? elementAddLabel(rel, elem, step, ctx.sideEffects, ctx.params, fresh)
        : elementDropLabel(rel, elem, step, ctx.sideEffects, ctx.params, fresh);
      if (!mutated) return null;
      const tail = elementTail(mutated.result, elem, steps, at + 1, bulked, ctx, fresh, labels);
      if (!tail) return null;
      return { ...tail, effects: [...mutated.bindings, ...(tail.effects ?? [])] };
    }
    if (step.name === 'drop') {
      if (pathCarried(rel)) return null;
      // TERMINAL by the grammar, and asserted rather than assumed: a step after `drop()` would be a
      // read over a stream that no longer exists, and the honest answer to a chain the passes should
      // have rejected is to decline it, not to lower the prefix and forget the rest.
      if (at !== steps.length - 1 || step.modulators?.length || step.optionArms || (step.args ?? []).length) return null;
      const dropped = elementDrop(rel, elem, fresh);
      return { rel: dropped.result, framing: { kind: 'discard' }, aliases: NO_ALIASES, effects: dropped.bindings, bulked: false };
    }
    const row = rowOp(step, rel, elementRowShape(rel, elem, labels), bulked, ctx, fresh);
    if (!row) break;
    // A `dedup()` THAT LOWERED RESET THE MULTIPLICITY, and the fold learns it. Every arm `rowOp`
    // admits projects `bulk` as the literal 1 — the unordered `Distinct`, the ordered
    // `MIN(encounter)` aggregate and `dedupBy`'s ranked window alike — because a survivor stands for
    // itself (`DedupGlobalStep.filter`'s unconditional `setBulk(1L)`,
    // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/DedupGlobalStep.java:75`).
    // This used to be left conservative, which "costs the heavier slice form and never a wrong
    // answer" only while nothing collapsed in front of a dedup: once `bulkObservedFrom` admits a
    // collapse before one, a stale `bulked` sends the following slice to `bulkSlice`, which DECLINES
    // without an emission order — turning a widened optimization into lost coverage. `dedupBy`'s own
    // comment predicted this exact relaxation.
    if (step.name === 'dedup') bulked = false;
    rel = row;
  }

  if (at === steps.length) return { rel, framing: { kind: 'elements', elem }, aliases: labels, bulked };

  if (pathCarried(rel)) return null;
  const retyped = terminal(steps[at], rel, elem, fresh, ctx, labels);
  if (!retyped) return null;

  // Through the ONE dispatcher rather than straight to `scalarTail`. It was hardcoded while every
  // `terminal` arm produced a scalar; `properties()` produces a PROPERTY, and hardcoding is exactly
  // how a second copy of the fold starts. `continueAs` routes a scalar identically, so this is a
  // generalization with no behaviour change for the arms that were already here.
  return continueAs(retyped.rel, retyped.framing, steps, at + 1, bulked, ctx, fresh, labels);
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
  // A re-source changes the payload to an element but is legal from every ordinary traverser shape.
  // Keeping it at the ONE framing dispatcher is what makes a scalar child body (`__.V().count()`),
  // an element tail (`…as('a').V()`), and a branch arm share one GraphStep lowering instead of each
  // growing an almost-identical source loop.
  const next = steps[from];
  if (next?.name === 'V' || next?.name === 'E') {
    const reSourced = reSource(next, rel, framing, ctx, fresh);
    return reSourced && elementTail(reSourced.rel, reSourced.elem, steps, from + 1, bulked, ctx, fresh, labels);
  }
  // A LIST FUNCTION OVER A TRAVERSER THAT IS NOT A COLLECTION is the traversal's own ANSWER — an error —
  // and this is the one dispatcher that knows both the step and the shape, which is why the check is here
  // rather than in each tail. `ListFunction.convertTraverserToCollection` raises for anything
  // `asCollection` cannot convert, and every shape below can never be null, so the message is CERTAIN.
  //
  // ⚠️ A SCALAR self is deliberately absent: there the choice between "can't be null" and "can only take
  // an array or an Iterable" is a PER-ROW question, and answering one for a value that may be either
  // would raise the WRONG error. It keeps declining until the null-ness is a compile-time fact.
  if (next && LIST_FUNCTIONS.has(next.name) && NON_ITERABLE_SELF.has(framing.kind))
    nonIterableTraverser(next, gremlinSelfName(framing));
  switch (framing.kind) {
    case 'elements': return elementTail(rel, framing.elem, steps, from, bulked, ctx, fresh, labels);
    case 'detached': return detachedTail(rel, framing.elem, steps, from, ctx, fresh);
    // ⚠️ The SET marker crosses. It is a fact about the value's HISTORY (`listTail`'s `set`), not about
    // the step that reads it, so a dispatcher that dropped it turned every set arriving here back into
    // a list — a wrong wire CLASS, since GraphBinary spells the two differently. Reachable the moment
    // anything but the four deduping list ops produces one: `cap("a")` over a `Set`-seeded collection is
    // the first.
    case 'list': return listTail(rel, framing.of, steps, from, ctx, fresh, labels, !!framing.set);
    case 'path': return pathTail(rel, framing.of, framing.scalars, steps, from, ctx, fresh, labels);
    // A value's multiplicity is the traverser's, so `bulked` carries.
    case 'scalar': return scalarTail(rel, framing, steps, from, bulked, ctx, fresh, labels);
    case 'map': return mapTail(rel, framing.keyOf, framing.valOf, steps, from, ctx, fresh, labels);
    case 'mapEntry': return mapEntryTail(rel, framing.keyOf, framing.valOf, steps, from, ctx, fresh, labels);
    case 'record': return recordTail(rel, framing.fields, steps, from, bulked, ctx, fresh, labels);
    // A PROPERTY traverser re-enters through `element()`/`key()`/`value()`, and through the ordinary
    // filters and slices before them. Most of that is not lowered yet, so a step after `properties()`
    // DECLINES — the map arm's reasoning exactly, and for the same reason: a loop that silently
    // dropped the property would answer a different question rather than defer. `bulked` carries for
    // the reason a value's does: `properties()` joins through its parent's channels, so a collapsed
    // parent's properties stand for the parent's multiplicity.
    case 'property': return propertyTail(rel, framing.ownerElem, steps, from, bulked, ctx, fresh, labels);
    // Nothing survives a discard, so nothing can follow one. `drop()` is a terminal step in the
    // grammar and the passes reject a chain that continues past it, so this is unreachable rather
    // than a decline — and saying so keeps the switch total.
    // A VARIANT's tail is the SHAPE-AGNOSTIC steps only — a slice reads the fan-out encounter, a
    // `count()` reads bulk, and neither asks what the mixed rows ARE. A payload-reading step (`unfold`,
    // a member op) DECLINES: a variant has no uniform member shape. See `variantTail`.
    case 'variant': return variantTail(rel, framing, steps, from, bulked, ctx, fresh, labels);
    // A per-row TYPED NODE is terminal for the variant's reason: a stream whose rows are different
    // shapes has no uniform continuation. A `count`/`dedup` over one is expressible but unwritten, so a
    // follower DECLINES rather than being dropped.
    case 'typedNode': return from === steps.length ? { rel, framing, aliases: labels, bulked: false } : null;
    case 'discard': return null;
  }
}

/**
 * `cap("a").unfold()` WITHOUT the fold — the member relation `readUnfolded` handed back, minted into an
 * ordinary element/scalar/typed-node stream so the rest of the chain is the same loop `unfold()` over a
 * folded list would run.
 *
 * The encounter is minted from the SITE ORDER (`renumber`), which reproduces the fold's `ORDER BY` plus
 * `unfold`'s re-mint exactly — so the cancel is order-preserving, which is what `readUnfolded`'s doc
 * promises and what `mise run test:perturbed` checks. `bulked` is false: a cap collapsed the stream to
 * one traverser and each member now stands for exactly one, the reset `unfoldList`'s callers also make.
 */
function capUnfolded(
  members: NonNullable<ReturnType<typeof readUnfolded>>, steps: readonly IRStep[], from: number,
  ctx: ChainCtx, fresh: Minter,
): Tail | null {
  const channels = withChannel([], ENCOUNTER);
  const terms: readonly SortTerm[] = members.order.map((name) => ({ expr: col(members.rel.id, name), dir: 'asc' as const }));
  const payload: readonly ColMeta[] = members.kind === 'elements' ? [meta('id', 'int')]
    : members.kind === 'scalars'
      ? [meta('v', 'any', true), ...(perRowColumnOf(members.type!) ? [meta(perRowColumnOf(members.type!)!, 'text', true)] : [])]
      : [meta(NODE_COL, 'json', true)];
  const positioned = renumber(members.rel, terms, [...payload, ...carriedCols(channels)], channels, fresh);
  if (members.kind === 'elements') return elementTail(positioned, members.elem!, steps, from, false, ctx, fresh, NO_ALIASES);
  if (members.kind === 'scalars')
    return scalarTail(positioned, { kind: 'scalar', type: members.type!, ...(members.productiveNull ? { productiveNull: true } : {}) },
      steps, from, false, ctx, fresh, NO_ALIASES);
  return continueAs(positioned, { kind: 'typedNode' }, steps, from, false, ctx, fresh, NO_ALIASES);
}

/**
 * THE PROPERTY LOOP — a property traverser is not terminal.
 *
 * `properties()` feeds `key()`, `value()` and — for a VertexProperty, which IS an Element —
 * `element()`. Each is a RETYPE rather than a step of its own: same rows, different shape, so it
 * hands the relation plus its new framing straight back to `continueAs` and whichever loop owns that
 * shape takes the rest of the chain. That is why this loop is four lines and not a second fold.
 *
 * THE ROW-ALGEBRAIC OPS COME FIRST and are the SHARED ones: a property stream is a per-row traverser
 * like any other, so `order()`, `dedup()` and the slices route through `rowOp` with a property
 * `RowShape` rather than through property-specific arms. Both of that shape's answers split on the OWNER
 * KIND, which is upstream's own line — a `VertexProperty` IS an `Element` and an edge `Property` is not
 * — and both citations live in `property.ts`. They keep the shape, so they recurse rather than retyping.
 *
 * Anything else DECLINES.
 */
function propertyTail(
  rel: Rel, elem: Elem, steps: readonly IRStep[], from: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  if (from === steps.length) return { rel, framing: { kind: 'property', ownerElem: elem }, aliases: labels, bulked: false };
  const step = steps[from]!;

  // `hasKey()` / `hasValue()` — the property stream's OWN filters, and the only two steps whose subject
  // is a property rather than an element. They preserve the shape, so they recurse like a row op.
  if (step.name === 'hasKey' || step.name === 'hasValue') {
    if (step.modulators?.length || step.optionArms) return null;
    const clause = propertyHasClause(rel, step.name === 'hasKey' ? 'key' : 'value', step.args ?? [], fresh);
    if (!clause) return null;
    const kept = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
    return propertyTail(kept, elem, steps, from + 1, bulked, ctx, fresh, labels);
  }

  if (ROW_OPS.has(step.name)) {
    const row = rowOp(step, rel, propertyRowShape(rel, elem, labels), bulked, ctx, fresh);
    // A `dedup()` that lowered RESET the multiplicity — `dedupOn` projects `bulk` as the literal 1 — so
    // the fold learns it, for `elementTail`'s reason: a stale `bulked` sends a following slice to
    // `bulkSlice`, which declines without an emission order.
    return row && propertyTail(row, elem, steps, from + 1, step.name === 'dedup' ? false : bulked, ctx, fresh, labels);
  }

  // THE GROUP BARRIER, over a property stream. It needs nothing property-specific: `groupBarrier` asks
  // its host for a key and a member, and a property host answers both — the three projections a `by()`
  // body can name (`key()`, `value()`, `element()`) are the child seam's, and the traverser itself is
  // `propertyNode`. This is upstream's own graph-snapshot read
  // (`vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/world.js:176-190`), which is why it
  // is here before the retypes below rather than after the modulator guard they share.
  if (step.name === 'group' || step.name === 'groupCount') {
    const host: ChildHost = { kind: 'property', id: propertyRowId(rel), ownerElem: elem, row: { rel, aliases: labels } };
    const grouped = groupBarrier(rel, host, step, bulked, childSeam(ctx, fresh), fresh);
    return grouped && continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, from + 1, false, ctx, fresh, NO_ALIASES);
  }

  // A CORRELATED FILTER over a property traverser — `where`/`filter`/`not`/`and`/`or`, the SAME
  // `sourceFilter` vocabulary the element and scalar hosts use, reachable now that a property is a
  // `Subject`. It PRESERVES the shape (a filter drops property rows, never retypes them), so it recurses
  // like a row op. `is` is deliberately NOT in `SCALAR_FILTER_HOSTS` — a property has no single value to
  // compare, so a value predicate declines rather than answering off the wrong column.
  if (SCALAR_FILTER_HOSTS.has(step.name)) {
    const subject: Subject = { kind: 'property', id: propertyRowId(rel), ownerElem: elem, rel };
    const clause = sourceFilter(step, subject, fresh, ctx);
    return clause && propertyTail(
      make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause }),
      elem, steps, from + 1, bulked, ctx, fresh, labels);
  }

  // THE BRANCH FAMILY over a PROPERTY stream — the same `branchArms` the element and value tails call,
  // because an arm body over a property traverser is the ordinary fold re-entered at the property
  // framing (`key()`/`value()`/`element()` retype it, the row ops and filters preserve it). `union`
  // needs no condition; `choose` and `coalesce` fold their condition/arm bodies through a property
  // `branchSubject` (`branchSubject` now answers the property framing), so all three compose here.
  if (BRANCH_HOSTS.has(step.name)) {
    const merged = branchArms(step, rel, { kind: 'property', ownerElem: elem }, bulked, ctx, fresh, labels);
    return merged && continueAs(merged.rel, merged.framing, steps, from + 1, bulked, ctx, fresh, labels);
  }

  // `constant(c)` DISCARDS the property and emits a literal — the shape-independent retype, shared with
  // every tail. The common `coalesce(__.value(), __.constant('x'))` fallback needs it here.
  if (step.name === 'constant') {
    const c = constantRetype(rel, step, fresh);
    return c && continueAs(c.rel, c.framing, steps, from + 1, false, ctx, fresh, labels);
  }

  if (step.modulators?.length || step.optionArms || (step.args ?? []).length) return null;
  // `drop()` over a property stream removes the property ROWS and leaves the elements standing.
  // TERMINAL by the grammar, asserted for `elementDrop`'s reason: a step after it would read a stream
  // that no longer exists, and declining is the honest answer to a chain the passes should have refused.
  if (step.name === 'drop') {
    if (from !== steps.length - 1) return null;
    const dropped = propertyDrop(rel, elem, fresh);
    return { rel: dropped.result, framing: { kind: 'discard' }, aliases: NO_ALIASES, effects: dropped.bindings, bulked: false };
  }
  const retyped = step.name === 'key' ? propertyKey(rel, fresh)
    // `VertexProperty.label()` IS its key — `return this.key();`
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/VertexProperty.java:79-81`)
    // — so it is the same projection and not a second one. An edge `Property` is NOT an Element and has
    // neither a label nor an id, so both decline there rather than answering off the stored row: upstream
    // would raise a ClassCastException, and a plausible answer to an invalid traversal is worse.
    : step.name === 'label' && elem === 'vertex' ? propertyKey(rel, fresh)
      : step.name === 'id' && elem === 'vertex' ? propertyId(rel, fresh)
        : step.name === 'value' ? propertyValue(rel, fresh)
          : step.name === 'element' ? propertyElement(rel, elem, fresh)
        // `count()` is shape-agnostic and needs no property-specific arm: `countExpr` reads the BULK
        // CHANNEL, and `properties()` carries the parent's channels through its join — so a
        // bulk-collapsed parent's properties sum their multiplicity rather than counting rows, which
        // is the same answer for the same reason it is on an element relation.
            : step.name === 'count' ? countTail(rel, fresh)
              : null;
  if (!retyped) return null;
  return continueAs(retyped.rel, retyped.framing, steps, from + 1, false, ctx, fresh, labels);
}

/**
 * THE RECORD LOOP — a record traverser is not terminal either.
 *
 * `select(key)` re-enters ONE field as a stream of its own shape and hands it straight back to
 * `continueAs`, which is `propertyTail`'s structure and for the same reason: a field is a RETYPE, not a
 * step, so this loop is short by construction rather than by omission.
 *
 * **MAP SCOPE BEATS PATH SCOPE, and the fallback is not a convenience.** `Scoping.getScopeValue` tries
 * the traverser's own Map first, then side-effects, then the path labels
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:117-131`).
 * So `g.V().as('a').project('a','b')…select('a')` reads the FIELD, and a key that is not a field falls
 * through to the alias channel the record still carries — which is why the miss routes to `selectOne`
 * rather than declining.
 *
 * Everything else declines. A record is an ordinary per-row traverser, so filters, slices, `order()`
 * and `math()` over its fields are all expressible and simply not built yet; declining is the honest
 * answer rather than dropping the record's fields silently.
 */

/**
 * A `where(k1, P.eq/neq(k2))` THETA or a `where(<body>)`/`not(<body>)` LEG over a stream's BOUND
 * ALIASES — the alias-aware filters, shared by every tail that carries live labels: the record a
 * terminal `match`/`select` produced AND an ordinary ELEMENT stream still carrying `as()` channels
 * (`g.V().as('a').out().where(__.as('a').values('name').is('josh'))`). Both are TinkerPop's
 * `WherePredicateStep`/`WhereTraversalStep` reading a PATH label rather than the current traverser, so
 * the filter is a correlated test over the ALIAS element, not over the row's own payload — which is why
 * the ordinary `sourceFilter` (rooted at the current traverser) cannot express it.
 *
 * Three answers: the filtered relation (HANDLED), `'decline'` (an alias filter it cannot lower — fail
 * closed), or `null` (NOT an alias filter — the caller falls through to its ordinary where/not dispatch
 * over the current traverser). It only ever claims a step `sourceFilter` also declines: a two-variable
 * theta (`sourceFilter` sees `!isNested` and declines) and a body whose head is a `select(<alias>)` the
 * Pass re-rooted (`sourceFilter`'s `childPredicate` roots at the current traverser and cannot lower a
 * leading `select`), so routing these here first is pure gain.
 */
/** The `P` ops an alias-vs-alias compare admits, mapped to their SQL comparison — identity (`eq`/`neq`)
 *  and, under a `by(key)`, the orderings. `within`/`between`/text ops are not two-single-alias shapes. */
const ALIAS_CMP: Record<string, BinaryOp | undefined> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function aliasWhere(step: IRStep, rel: Rel, labels: AliasMap, ctx: ChainCtx, fresh: Minter): Rel | 'decline' | null {
  if ((step.name !== 'where' && step.name !== 'not') || step.optionArms) return null;
  // Two-variable theta: `where(k1, P.op(k2))[.by(key)]` between two bound ELEMENT aliases — TinkerPop's
  // `WherePredicateStep`. WITHOUT a `by()`, `eq`/`neq` compare the elements' IDENTITY (rowid); WITH a
  // `by(key)` the comparison is over each alias's PROJECTED value (`a.age` vs `b.age`), and any ordering
  // op is meaningful. A non-productive `by()` yields NULL, so the comparison drops the row (NULL is not
  // true) exactly as TinkerPop drops it.
  if (step.name === 'where') {
    const wargs = argValues(step);
    const pred = step.args?.[1]?.value;
    if (wargs.length === 2 && typeof wargs[0] === 'string' && isPred(pred)
      && pred.operands.length === 1 && typeof pred.operands[0]!.value === 'string' && ALIAS_CMP[pred.op]) {
      const projA = aliasProjection(rel, labels, wargs[0], 'last', fresh);
      const projB = aliasProjection(rel, labels, pred.operands[0]!.value as string, 'last', fresh);
      // A non-element theta (a scalar-alias compare) is an unbuilt shape; fall through (sourceFilter
      // declines it too) rather than over-claiming a fail-closed decline.
      if (projA && projB && projA.read.kind === 'element' && projB.read.kind === 'element') {
        const bys = modulations(step, 1, childSeam(ctx, fresh));
        if (!bys) return step.modulators?.length ? 'decline' : null;
        if (!bys.length) {
          // IDENTITY compare — only `eq`/`neq` are meaningful over two rowids.
          if (pred.op !== 'eq' && pred.op !== 'neq') return 'decline';
          const same = eq(aliasIdAt(col(rel.id, projA.entry.col), 'last'), aliasIdAt(col(rel.id, projB.entry.col), 'last'));
          return make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: pred.op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same } });
        }
        // VALUE compare under a `by(key)`: project the key off each alias's element host, compare.
        const hostOf = (proj: NonNullable<typeof projA>): ChildHost =>
          ({ kind: 'element', id: aliasIdAt(col(rel.id, proj.entry.col), 'last'), elem: (proj.read as { elem: Elem }).elem, row: { rel, aliases: labels } });
        const seam = childSeam(ctx, fresh);
        const [aVal, bVal] = [byExpr(bys[0]!, hostOf(projA), fresh, true, seam), byExpr(bys[0]!, hostOf(projB), fresh, true, seam)];
        if (!aVal || !bVal) return 'decline';
        // A non-productive `by()` DROPS the row (`productivityFilter` = each value `IS NOT NULL`), which
        // is also what the NULL-propagating compare does — conjoined for belt-and-braces. Under
        // `ProductiveByStrategy` the filter is undefined DESPITE a key: a non-productive `by()` then
        // KEEPS the row as a real NULL, a null-keeping compare this does not build, so DECLINE.
        const [prodA, prodB] = [productivityFilter(step, aVal), productivityFilter(step, bVal)];
        if (!prodA || !prodB) return 'decline';
        const cmp: Expr = { kind: 'binary', op: ALIAS_CMP[pred.op]!, left: aVal, right: bVal };
        return make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: and(and(prodA, prodB), cmp) });
      }
    }
  }
  if (step.modulators?.length) return null; // a modulated where/not that is not the theta above is not an alias filter.
  // A where/not whose body re-roots at a bound alias (`as(k)`→`select(k)`): a filter leg. Only claim it
  // when every alias it reads is LIVE here; otherwise it is not this stream's alias filter.
  const leg = classifyWhereLeg(step, ctx.params);
  if (!leg) return null;
  const live = liveAliases(labels, rel);
  if (!leg.reads.every((l) => live.has(l))) return null;
  return applyLeg(leg, rel, labels, childSeam(ctx, fresh), step, fresh) ?? 'decline';
}

function recordTail(
  seed: Rel, fields: readonly RecordField[], steps: readonly IRStep[], from: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, aliases: AliasMap,
): Tail | null {
  let rel = seed;
  let labels = aliases;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.optionArms) return null;
    if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
    // The record's own MAP SCOPE rides on the host, which is what makes `by(__.select('a'))` read the
    // FIELD rather than a same-named `as()` label (§ `scopeValue`).
    const host: ChildHost = { kind: 'record', fields, row: { rel, aliases: labels } };

    if (step.name === 'identity' || step.name === 'barrier') { if (argValues(step).length) return null; continue; }

    if (step.name === 'as') {
      // A record is not a `TraverserObject` this route can bind: the alias history encodes an element
      // rowid, a value or a list, and a MAP binding declines at `readOf` on the way back out anyway.
      return null;
    }

    if (step.name === 'select') {
      const args = argValues(step);
      // MAP SCOPE BEATS PATH SCOPE (`Scoping.getScopeValue`), so a key that names a FIELD re-enters
      // that field and only a miss falls through to the alias channel. A modulated or multi-key
      // select over a record is `selectKeys`' business either way.
      const field = args.length === 1 && typeof args[0] === 'string' && !step.modulators?.length
        ? fieldNamed(fields, args[0])
        : undefined;
      if (field) {
        const entered = recordField(rel, field, fresh);
        return entered && continueAs(entered.rel, entered.framing, steps, at + 1, bulked, ctx, fresh, labels);
      }
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), fresh,
        { framing: { kind: 'record', fields }, named: namedElsewhere(ctx) });
      return selected && continueAs(selected.rel, selected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }

    if (step.name === 'order') {
      const ordered = orderRows(step, rel, host, ctx, fresh);
      if (!ordered) return null;
      rel = ordered;
      continue;
    }

    // THE ROW-ALGEBRAIC OPS ARE SHAPE-AGNOSTIC, which is the whole reason a record needs no copy of
    // them: a slice reads the emission-order channel and a `count()` reads the bulk channel, and
    // neither asks what the payload IS. `sliceOp` and `countExpr` are the same functions every other
    // tail calls.
    const sliced = sliceOp(step, rel, bulked, fresh);
    if (sliced) { rel = sliced; continue; }

    if (step.name === 'count') {
      if (argValues(step).length) return null;
      const counted = countTail(rel, fresh);
      return continueAs(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }

    // `fold()` — the record BECOMES a map (its fields spent) and every map value collects into ONE list
    // traverser: `project(k…).by(…).fold()`, the GraphQL to-many object field. The collapse is
    // `recordToMap` — the same boundary `select`/wire cross — so the fold sees a `MAP_COL` whatever the
    // fields were, and the member shape is the map's self-describing pairs array (`MapOf.scalar`).
    if (step.name === 'fold' && !argValues(step).length && !isLocalScope(step)) {
      const mapped = recordToMap(rel, fields, fresh);
      if (!mapped) return null;
      const encounter = encounterOf(rel.channels);
      const folded = foldMaps(mapped, MAP_COL, { kind: 'scalar' }, { ...(encounter ? { order: [encounter.col] } : {}) }, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }

    // THE PROJECTORS OVER A RECORD'S FIELDS, and they need nothing record-specific: a variable NAMES A
    // SCOPE KEY, `Scoping.getScopeValue` tries the traverser's own Map first, and the record host is
    // what carries that Map — so `project('a','b')…math('a / b')` and `…format('%{a}/%{b}')` resolve
    // against the FIELDS by the same rule `by(__.select('a'))` already followed here. `_` is the whole
    // map, so it declines through the identity guard rather than projecting one.
    if (REL_PROJECTORS.has(step.name)) {
      const projected = projectorTail(rel, step, host, childSeam(ctx, fresh), fresh);
      if (!projected) return null;
      return continueAs(projected.rel, projected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }

    // `where(k1, P.eq/neq(k2))` THETA and `where(<body>)`/`not(<body>)` LEG over the record's bound
    // aliases — the alias-aware filters, shared with the element tail (`aliasWhere`). A repeat/count leg
    // body lowers through the fresh-walk join, an ordinary movement body through a correlated EXISTS.
    const aliased = aliasWhere(step, rel, labels, ctx, fresh);
    if (aliased === 'decline') return null;
    if (aliased) { rel = aliased; continue; }

    // `dedup(k1, …, kn)[.by(proj)]` — a KEYED dedup on the record's own alias channels. A bare `dedup()`
    // over a record (identity grouping) is a separate increment; a LABELLED dedup reads the bound
    // aliases the record already carries and collapses the tuple, optionally under a shared `by()`.
    if (step.name === 'dedup' && !isLocalScope(step)) {
      const keys = argValues(step);
      if (keys.length && keys.every((k) => typeof k === 'string')) {
        const bys = modulations(step, 1, childSeam(ctx, fresh));
        if (!bys) return null;
        const deduped = dedupByLabels(step, rel, labels, keys as string[], bys[0], ctx, fresh);
        if (!deduped) return null;
        rel = deduped;
        continue;
      }
    }

    // Everything else DECLINES. A record is an ordinary per-row traverser, so a bare `dedup()`, a
    // local-scope slice over its ENTRIES and `unfold()` to `Map.Entry` rows are all expressible and
    // simply not built yet — declining is the honest answer rather than dropping the record's fields
    // silently.
    return null;
  }
  return { rel, framing: { kind: 'record', fields }, aliases: labels, bulked: false };
}

/**
 * `union(a, b, …)` — the ARM MERGE, and the first production caller of the channel core's peer merge.
 *
 * Every arm is lowered from the SAME input relation, which is the whole reason the arms need no
 * machinery of their own: an arm body over the current traverser IS the ordinary fold started at that
 * relation, so `__.out('knows')` inside a `union` is the same movement it is outside one. The input
 * node is then referenced once per arm, and a node referenced more than once is a DAG share — so
 * `name` decides whether the parent becomes a CTE (§4) rather than each arm recomputing it.
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
 *   carrying a per-row `vtype` cannot merge with one that does not. NULL-padding to the widest arm is
 *   a framing decision about what the absent type MEANS, so it declines here rather than being guessed
 *   at.
 * - **an arm that BINDS a label.** Arms mint alias columns independently from the same seed, so their
 *   raw column names collide and the merge owes each arm a projection remapping onto a canonical
 *   column. That is the alias half of the merge contract and it is a further increment.
 */
/**
 * A `T` TOKEN as a `choose()` CHOICE — the `ChildValue` a token projection amounts to.
 *
 * `byExpr` already knows every host's tokens (an element's `id`/`label`, a property's `key`/`value`), so
 * this is carriage and not a second projection: the only things it adds are the two facts a `ChildValue`
 * carries beyond the expression. `yields: 'one'` because a token is single-valued by construction, and
 * `present: ALWAYS_PRODUCTIVE` because a token cannot be absent — which is the claim `chooseOptions`
 * reads to prove the `Pick.unproductive` arm dead rather than emitting a shape the traversal never has.
 */
function tokenChoice(token: string, subject: Subject, fresh: Minter): ChildValue | null {
  const modulation: Modulation = { key: { kind: 'token', token: token.toLowerCase() as 'id' | 'label' | 'key' | 'value' } };
  const expr = byExpr(modulation, childHostOf(subject), fresh);
  if (!expr) return null;
  // A LABEL and a property KEY are strings; an external id is whatever `COALESCE(uid, id)` yields, so it
  // stays UNKNOWN and the framer infers — the same split `byField` draws for the same tokens.
  const named = token.toLowerCase();
  return {
    expr, yields: 'one', present: ALWAYS_PRODUCTIVE,
    framing: { kind: 'scalar', type: named === 'label' || named === 'key' ? STATIC('string') : UNKNOWN },
  };
}

/** The traverser shapes that are NEVER a collection and NEVER null — so a list function over one raises
 *  with certainty. `list` and `path` ARE iterable (a path coerces to its element sequence); `scalar` is
 *  the per-row case above; `variant`/`discard` cannot say. */
const NON_ITERABLE_SELF: ReadonlySet<RelFraming['kind']> = new Set(['elements', 'detached', 'map', 'mapEntry', 'record', 'property']);

/** What the offending traverser IS, for the `encountered %s` tail. */
const gremlinSelfName = (framing: RelFraming): string =>
  framing.kind === 'elements' || framing.kind === 'detached' ? framing.elem
    : framing.kind === 'property' ? 'property' : 'map';

/** The three steps that MERGE arms over the same input. One set and one dispatcher, so a tail gains all
 *  three at once — the asymmetry this replaces was `union` in the scalar fold and `union`+`choose` in the
 *  element one, with `coalesce` in neither. */
const BRANCH_HOSTS: ReadonlySet<string> = new Set(['union', 'choose', 'coalesce', 'optional']);

/** Which arm-merging builder a step wants. Total over `BRANCH_HOSTS`, so a member added there without a
 *  builder is a compile error rather than a silent decline. */
function branchArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  return step.name === 'union' ? unionArms(step, input, framing, bulked, ctx, fresh, labels)
    : step.name === 'choose' ? chooseArms(step, input, framing, bulked, ctx, fresh, labels)
      : step.name === 'coalesce' ? coalesceArms(step, input, framing, bulked, ctx, fresh, labels)
        : step.name === 'optional' ? optionalArms(step, input, framing, bulked, ctx, fresh, labels)
          : null;
}

/**
 * THE ARM-MAJOR MERGE — a `union`/`choose` whose EVERY arm holds a batched barrier (`armBatches`), so
 * `BranchStep.standardAlgorithm` runs each option over the WHOLE input and drains them in ARM ORDER
 * (`vendor/tinkerpop/gremlin-core/.../branch/BranchStep.java:143`). Each arm was already lowered by
 * `continueAs` as a GLOBAL reduction over the branch source (a `count`/`fold`/`sum` over the whole input,
 * not per-traverser), so the only work is to UNION them arm-major: tag each with its ordinal, merge, and
 * re-mint `encounter` over `[arm_idx, payload]` — the mirror of `mintTraverserMajor` with no parent key.
 *
 * The arms COLLAPSED (a barrier drops the per-row channels), so the merge base is the arms' OWN channels,
 * not the input's — which is exactly what made the per-row `mergeArms` refuse them (base `[bulk]` vs arm
 * `[]`). They must agree; a disagreement (e.g. one arm kept `bulk`, i.e. it did NOT actually collapse)
 * declines.
 */
const mintArmMajor = (arms: readonly Tail[], base: Channels, labels: AliasMap, fresh: Minter): FramedRel | null => {
  if (arms.some((arm) => !sameChannels(base, arm.rel.channels))) return null;
  const tagged = arms.map((arm, k) => ({ ...arm, rel: tagArm(arm.rel, k, fresh) }));
  const merged = mergeArms(tagged, withChannel(base, BORD_ARM), labels, fresh);
  if (!merged) return null;
  const rel = merged.rel;
  if (!rel.channels.some((channel) => channel.col === BORD_ARM.col)) return null;
  const kept = rel.channels.filter((channel) => channel.role !== 'branchOrder');
  const outChannels = withChannel(kept, ENCOUNTER);
  const payload = payloadCols(rel);
  const outCols = [...payload, ...carriedCols(outChannels)];
  const terms = [
    { expr: col(rel.id, BORD_ARM.col), dir: 'asc' as const },
    ...payload.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const })),
  ];
  return { ...merged, rel: renumber(rel, terms, outCols, outChannels, fresh) };
};

/**
 * A `union`/`choose` all of whose arms BATCH — the arm-major lowering, gated on the source being
 * non-empty. `mintArmMajor` unions the arms' global reductions in arm order; the EMPTY-INPUT GATE is the
 * reference's "an option no start was routed to emits nothing" (`element-branch-child.feature` —
 * `hasLabel('none').union(count, …)` is EMPTY, not `[0, …]`). `input` is the SHARED branch source (every
 * arm's subplan roots at it), so a second reference from an `Exists` makes `name` CTE it — no replication.
 */
function batchedBranch(
  arms: readonly Tail[], input: Rel, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  const merged = mintArmMajor(arms, arms[0]!.rel.channels, labels, fresh);
  if (!merged) return null;
  const gated = make.filter({
    id: fresh('bg'), input: merged.rel, channels: merged.rel.channels, type: merged.rel.type,
    pred: { kind: 'exists', plan: input, negated: false },
  });
  // GUARANTEE the arm-major wire order with a real ORDER BY — the same mechanism `order()` uses. A
  // batched branch is often the WHOLE result (`union(count, out().count())` → an ordered `[6, 4]`), and a
  // top-level `ROW_NUMBER` window does not order the wire by itself; a downstream consumer (a `count`,
  // a `fold` collecting in encounter order) imposes its own, so the redundant sort is harmless there.
  const enc = encounterOf(gated.channels);
  const ordered = enc
    ? make.sort({ id: fresh('bs'), input: gated, channels: gated.channels, type: gated.type, terms: [{ expr: col(gated.id, enc.col), dir: 'asc' }] })
    : gated;
  return { ...merged, rel: ordered };
}

/** An arm whose body holds a COLLAPSING barrier (a reducer/count/fold — `selfCollapses`), so when a
 *  batching branch runs it over the whole input the arm is a global REDUCTION. Deliberately NARROWER
 *  than `armBatches` (any Barrier): a SLICE arm (`out().limit(1)`) batches too but does not collapse. */
const isReductionArm = (body: readonly IRStep[]): boolean => body.some((step) => selfCollapses(step.name));

/** Add a `bulk = 1` channel so a COLLAPSED arm can UNION with a STREAMING one that carries its own — a
 *  batched arm is ONE traverser, so its multiplicity is 1. A no-op where a `bulk` channel already exists. */
function ensureBulk(rel: Rel, fresh: Minter): Rel {
  if (rel.channels.some((channel) => channel.role === 'bulk')) return rel;
  const channels = withChannel(rel.channels, BULK[0]!);
  const payload = payloadCols(rel);
  return make.project({
    id: fresh('eb'), input: rel, channels, type: typeOf(...payload, ...carriedCols(channels)),
    exprs: [
      ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      ...channels.map((channel) => [channel.col, channel.role === 'bulk' ? compilerInt(1) : col(rel.id, channel.col)] as const),
    ],
  });
}

/** Normalize a SCALAR arm — a batched `result`-marked reduction OR a streaming per-input arm — to a
 *  common `[v, vtype, bulk]` scalar, so a MIXED arm-major union can put a collapsed arm and a per-input
 *  arm in one stream. The vtype is the arm's own: a `number` reduction's `vt` column, a `count`'s
 *  `long`, a plain scalar's declared type (`withMergedVtype`). `null` for a non-scalar arm (a
 *  mixed-SHAPE branch is the variant arm-major, a later increment) or a `value`-marked one. */
function toScalarArm(arm: Tail, fresh: Minter): Rel | null {
  if (arm.framing.kind !== 'scalar') return null;
  const result = arm.framing.result;
  const vtype: ScalarType | null =
    result === 'number' ? PER_ROW('vt')
      : result === 'count' ? STATIC('long')
        : result === undefined ? arm.framing.type
          : null;
  if (!vtype) return null;
  return ensureBulk(withMergedVtype(arm.rel, vtype, fresh), fresh);
}

/**
 * A `union` with SOME (not all) batched arms — a MIXED arm-major union: a collapsed reduction (`min`,
 * `count`, `fold` — one global row) beside a per-input arm (`constant`, `out()`), drained ARM-major.
 * Each arm is reconciled to a common CHANNEL set so the arm-major `Union` can carry it, then handed to
 * `batchedBranch` — the same mint + empty gate the all-batched case uses; the payload SHAPE differences
 * (`mergeArms`' scalar meet / variant merge) are the union's own.
 *
 * The reconciliation is per shape: a SCALAR arm normalizes to `[v, vtype, bulk]` (`toScalarArm` — which
 * also drops a `result` marker so a `count`/`number` reduction can meet a plain scalar OR join a
 * variant); an ELEMENT or LIST arm just gains `bulk = 1` if it collapsed (`ensureBulk`). So a same-shape
 * mix (`union(__.min(), __.constant(99))` → `[27,99,99,99,99]`) meets as scalars and a cross-shape one
 * (`union(__.count(), __.out())`, `union(__.fold(), __.out())`) becomes a VARIANT stream. A map/record/
 * path/property arm, or an arm carrying an alias the collapsed arm cannot (`union(min.as('x'),
 * …).select('x')`, the `mintArmMajor` channel check), declines.
 */
function mixedBranch(arms: readonly Tail[], input: Rel, fresh: Minter, labels: AliasMap): FramedRel | null {
  const normalized: Tail[] = [];
  for (const arm of arms) {
    const fr = arm.framing;
    if (fr.kind === 'scalar') {
      const rel = toScalarArm(arm, fresh);
      if (!rel) return null;
      normalized.push({ ...arm, rel, framing: { kind: 'scalar', type: PER_ROW(MERGED_VTYPE) } });
      continue;
    }
    // An ELEMENT or LIST arm joins the variant unchanged but for a `bulk = 1` if it collapsed;
    // `variantPayload` frames a list-of-elements member by the same `listPayloadExpr` expansion the
    // non-variant list uses. A map/record/path/property arm declines (no variant `vk`).
    if (fr.kind !== 'elements' && fr.kind !== 'list') return null;
    normalized.push({ ...arm, rel: ensureBulk(arm.rel, fresh) });
  }
  return batchedBranch(normalized, input, fresh, labels);
}

function unionArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  // A `union` is a fresh UNORDERED stream (`BranchStep` drains arm-by-arm and every scenario of
  // `Union.feature` asserts unordered), so a position the input carried OR an arm minted inside itself
  // does NOT survive the merge — dropping it is what lets an ordered/limited arm merge rather than
  // decline on a channel its sibling has not got. Where a downstream positional/collecting consumer
  // READS the fan-out's emission order (`ctx.ordered`, the chain-global demand), the merge MINTS one
  // deterministic order over the whole fan-out after the fact (`withFanoutOrder`, §10) rather than
  // declining — the positionless rows are the same either way.
  const args = argValues(step);
  if (args.length < 2 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((body) => !body?.length)) return null;

  const slice = sliceableBranch(ctx, input);
  // A `union` is a `BranchStep`: barrier-free it is TRAVERSER-major (`applyCurrentTraverser` injects
  // one start), but an arm holding a BATCHED barrier sets `hasBarrier` and makes it ARM-major over the
  // whole input (`BranchStep.java:120-152`). The arm-major lowering — the batched arm running over the
  // whole input — is not built, so a SLICE-demanded union with a batched arm declines rather than
  // present a traverser-major subset the reference does not. (`armBatches`, `ir/step.ts`.)
  if (slice && bodies.some((body) => armBatches(body!))) return null;
  const source = slice ? augmentParent(input, fresh) : input;
  const arms: Tail[] = [];
  for (const body of bodies) {
    const arm = continueAs(source, framing, body!, 0, bulked, inBody(ctx), fresh, labels);
    if (!arm) return null;
    arms.push(slice ? arm : { ...arm, rel: dropEncounter(arm.rel, fresh) });
  }
  // A REDUCTION arm holds a COLLAPSING barrier (a reducer/count/fold — `selfCollapses`), so when the
  // branch batches it, the arm is a global reduction over the whole input. This is NARROWER than
  // `armBatches` (any Barrier): a SLICE arm (`out().limit(1)`) batches too but does NOT collapse, so it
  // stays the ordinary merge rather than an arm-major reduction (else `union(out().limit(1), in())`
  // would wrongly decline). Only reachable when `!slice` (a batched arm under a downstream slice already
  // declined above).
  if (!slice && bodies.every((body) => isReductionArm(body!))) return batchedBranch(arms, input, fresh, labels);
  // SOME (not all) reduce → a MIXED arm-major union of a collapsed arm and a per-input one (`mixedBranch`).
  if (!slice && bodies.some((body) => isReductionArm(body!))) return mixedBranch(arms, input, fresh, labels);
  return slice
    ? mintTraverserMajor(arms, source, labels, fresh)
    : branchResult(mergeArms(arms, withoutEncounter(input.channels), labels, fresh), ctx, fresh);
}

/**
 * THE MERGE ITSELF — n arms into one `Union`, with every agreement the algebra needs asserted.
 *
 * Split from `unionArms` because `choose()` produces its arms differently (each is guarded by the
 * condition or its negation) and merges them identically. The arm-shape rules are the merge's, not
 * `union`'s, so there is one place they are stated.
 */
/**
 * TWO SCALAR ARMS WHOSE TYPES DIFFER MEET AT A PER-ROW ONE — §6·7's lattice, at the arm merge.
 *
 * `sameFraming` compares the whole `ScalarType`, so `union(__.values('name'), __.constant(1))` used
 * to DECLINE for no reason but a tag disagreement: both arms are one value per row, the relation
 * merges perfectly, and the only thing missing was somewhere to record that the two halves are
 * typed differently. That somewhere is a COLUMN — the same `vtype` a stored-property read already
 * carries — and the whole cost is one projection per arm.
 *
 * The lattice, and one deliberate refinement of the plan's version. `static ∧ static(same)` stays
 * static, because agreement costs no column. `static ∧ static(differ)` goes per-row, each side
 * projecting its tag as a literal. `perRow ∧ anything` goes per-row. The plan says
 * `unknown ∧ x → unknown`; here an UNKNOWN arm instead contributes a NULL tag to the per-row column,
 * which is not a different answer — a null `vtype` IS "infer this member from its value", which is
 * exactly what `unknown` means — and it is strictly more capable, because it lets an arm that CAN
 * say keep its tag instead of the whole merge losing it to the one that cannot. Collapsing to
 * `unknown` would discard a `datetime` because its sibling was untagged, which is the discard §6·7
 * exists to end.
 *
 * `null` where the meet is not this module's to take: an arm carrying a `result` marker
 * (`count`/`number`) reads its type off a `vt` column the reducer computed, so padding it with a
 * second type column would leave two disagreeing authorities on one row.
 */
/**
 * THE SHAPE-AGNOSTIC TAIL OVER A VARIANT STREAM — a mixed-shape branch merge (`union`/`choose`/
 * `coalesce` whose arms disagree on shape) composes with the steps that read only the carried channels,
 * never the payload. A SLICE (`sliceOp` — `limit`/`range`/`skip`) reads the fan-out `encounter` the branch
 * minted (`mintTraverserMajor`/`withFanoutOrder`) and KEEPS the variant; `count()` is `countTail`
 * (`SUM(bulk)`), the same barrier every other tail uses.
 *
 * Anything that reads the payload DECLINES rather than mis-executing: a variant has NO uniform member
 * shape, so `unfold()`, a member transform, and a value `dedup` (an identity that is per-shape) are the
 * variant-MEMBER vocabulary, a later increment — the map/property tails' reasoning exactly.
 */
function variantTail(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], from: number, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  let cur = rel;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at]!;
    const sliced = sliceOp(step, cur, bulked, fresh);
    if (sliced) { cur = sliced; continue; }
    if (step.name === 'count' && !argValues(step).length && !isLocalScope(step)) {
      const counted = countTail(cur, fresh);
      return continueAs(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }
    // A BARE `dedup()` over a variant is a whole-PAYLOAD `Distinct` — the tuple `(vk, v, rid, list)` IS
    // the identity across every arm: a same-kind element by `(vk, rid)`, a scalar by `(vk, v)`, and two
    // arms of different shape never collide because `vk` differs (`ElementHelper` hashes by id+class; a
    // scalar by value). `dedupOn` keeps the first occurrence (`MIN(encounter)`) and resets `bulk`; it
    // declines through `groupableChannels` where an alias/path sits in the row, exactly as the row-shape
    // dedup does — a grouping may carry only the roles `CHANNEL_GROUP_POLICY` gives an N→1 answer.
    if (step.name === 'dedup' && !argValues(step).length && !isLocalScope(step) && !step.modulators?.length) {
      if (pathCarried(cur) || !groupableChannels(cur.channels)) return null;
      const deduped = dedupOn(payloadCols(cur).map((column) => col(cur.id, column.name)), cur, [], fresh);
      if (!deduped) return null;
      cur = deduped;
      continue;
    }
    return null;
  }
  return { rel: cur, framing, aliases: labels, bulked: false };
}

function meetScalarArms(arms: readonly Tail[]): ScalarType | null {
  const types: ScalarType[] = [];
  for (const arm of arms) {
    if (arm.framing.kind !== 'scalar') return null;
    // A `result:'count'` arm carries a proper `STATIC('long')` type and NO `vt` column, so it meets like
    // any typed scalar — which is what lets `coalesce(__.out().count(), __.constant(0))` merge (count→long,
    // constant→int, a per-row tagged scalar). `result:'number'`/`'value'` are refused: their type rides on
    // a `vt` column the meet's own `vtype` column would then contradict — the two-authorities trap.
    if (arm.framing.result !== undefined && arm.framing.result !== 'count') return null;
    types.push(arm.framing.type);
  }
  // The MEET itself is `render.ts`'s — the same question a named collection asks of its sites. What
  // stays here is the framing-level decline above it, which is about `Tail`s and not about types.
  return meetScalarTypes(types);
}

/**
 * `g.union(a, b, …)` — a SOURCE union, or `null` to decline.
 *
 * Each argument is a whole traversal, so each one re-enters `lowerChain` through the seam's rooted
 * answer and the merge is the ordinary one. Three declines, each its own reason:
 *
 * - **fewer than two arms.** `union(t)` IS `t` — not a merge at all — and `union()` is the empty
 *   relation, which `Values` cannot express (§3.3). Both decline.
 * - **an arm with EFFECTS.** `union(__.addV(…), __.addV(…))` is plan composition (§3.0) and the
 *   arms' statements would have to be hoisted to bindings and ordered before the read that merges
 *   them. Expressible, unbuilt, and a write question rather than a branch one.
 * - anything `mergeArms` refuses — a shape disagreement, a label bound in one arm, an arm-local
 *   `order()` minting a second emission order.
 */
function sourceUnion(
  step: IRStep, ctx: ChainCtx, fresh: Minter,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);
  if (args.length < 2 || args.some((arg) => !isNested(arg))) return null;
  const arms: Tail[] = [];
  for (const arg of args) {
    const body = rootedSteps((arg as { readonly nested: unknown }).nested, ctx.params, ctx.sideEffects);
    if (!body?.length) return null;
    const read = rootedRead(body, ctx, fresh);
    if (!read || read.effects?.length) return null;
    arms.push({ rel: read.rel, framing: read.framing, aliases: NO_ALIASES, bulked: ctx.collapse });
  }
  return mergeArms(arms, arms[0]!.rel.channels, NO_ALIASES, fresh);
}

/**
 * ARMS OF DIFFERENT SHAPES, merged as a per-row tagged union — or `null` to decline.
 *
 * `mergeArms`' fallback, and structurally its twin: the scalar meet widens the schema by one column
 * so two tag-disagreeing arms become comparable, and this widens it by three so two SHAPE-disagreeing
 * arms do. Both then hand the arms to the same `Union`. Neither invents a node, and that is the test
 * §7 sets — the seam could already EXPRESS this; it had not been taught to.
 *
 * The declines are the arms' own: a shape with no `vk` (a map, a record, a path, a property, a
 * discard), a reducer-marked scalar (its type rides on a `vt` column the payload has no slot for),
 * and a SET, whose wire form differs from a list's while sharing its member substrate.
 *
 * The channel and label tests are NOT repeated here — the caller runs them for both routes, because
 * an arm that binds a label or mints its own order is refused for reasons that have nothing to do
 * with shape.
 */
function variantMerge(
  arms: readonly Tail[], base: Channels, labels: AliasMap, fresh: Minter,
): FramedRel | null {
  const shapes: VariantArm[] = [];
  for (const arm of arms) {
    const shape = variantArmOf(arm.framing);
    if (!shape) return null;
    shapes.push(shape);
  }
  if (arms.some((arm) => arm.aliases.size !== labels.size)) return null;
  if (arms.some((arm) => !sameChannels(base, arm.rel.channels))) return null;
  const hasList = variantHasList(shapes);
  const tagged = arms.map((arm, at) => variantArm(arm.rel, shapes[at]!, hasList, fresh));
  const channels = mergeChannels(base, tagged.map((rel) => rel.channels), { rigid: 'peer' });
  return {
    rel: make.union({ id: fresh('vu'), inputs: tagged, all: true, channels, type: tagged[0]!.type }),
    // The DECLARED vocabulary is de-duplicated by shape, never by position: two arms of the same
    // shape share one tag, so the framer's arm list stays a description of what a row can BE.
    framing: { kind: 'variant', arms: dedupeArms(shapes) },
  };
}

/** The declared arms, one per distinct SHAPE. Two `{kind:'scalar'}` arms whose types differ collapse
 *  to one here and the payload then frames `UNKNOWN` — the wire carries a single static tag per
 *  variant, which is the one place its vocabulary is short of the algebra's (§6·7's extension point). */
const dedupeArms = (arms: readonly VariantArm[]): readonly VariantArm[] => {
  const seen = new Map<string, VariantArm>();
  for (const arm of arms) {
    const key = arm.kind === 'elements' ? `e:${arm.elem}` : arm.kind;
    if (!seen.has(key)) seen.set(key, arm);
  }
  return [...seen.values()];
};

function mergeArms(
  arms: readonly Tail[], base: Channels, labels: AliasMap, fresh: Minter,
): FramedRel | null {
  let [first, ...rest] = arms as [Tail, ...Tail[]];
  // SCALAR ARMS MEET BEFORE THEY ARE COMPARED, because a tag disagreement is not a shape
  // disagreement — see `meetScalarArms`. The re-projection is what makes the arms comparable at all,
  // so it has to happen before both the framing and the column tests below.
  if (first.framing.kind === 'scalar') {
    const met = meetScalarArms(arms);
    if (met && met.kind === 'perRow') {
      const framing = { kind: 'scalar', type: met } as const;
      // `meetScalarArms` returned non-null, so EVERY arm is a scalar without a `result` marker.
      const retyped = arms.map((arm) => ({
        ...arm, framing,
        rel: withMergedVtype(arm.rel, arm.framing.kind === 'scalar' ? arm.framing.type : UNKNOWN, fresh),
      }));
      [first, ...rest] = retyped as [Tail, ...Tail[]];
      arms = retyped;
    }
  }
  // RECORD ARMS THAT DISAGREE DEMOTE TO MAP VALUES — the third rung of the same ladder the two moves
  // above climb (a tag disagreement widens by one column, a shape disagreement by three), and the one
  // that needs no widening at all: a record's fields collapse into the single `map` column the map
  // vocabulary already reads, so the divergence moves INSIDE the value and the arms' row types agree
  // trivially. See `mapDemotedArms`.
  const demoted = mapDemotedArms(arms, fresh);
  if (demoted) [first, ...rest] = (arms = demoted) as unknown as [Tail, ...Tail[]];
  // ARMS THAT DISAGREE ON SHAPE MERGE TO A VARIANT — a per-row tagged union, and the same move the
  // scalar meet above makes one level down: re-project the arms onto a shared payload, then let the
  // ordinary `Union` merge them. It is tried only AFTER the meet, so two scalar arms never reach it.
  if (rest.some((arm) => !sameFraming(first.framing, arm.framing)))
    return variantMerge(arms, base, labels, fresh);
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
  if (arms.some((arm) => !sameChannels(base, arm.rel.channels))) return null;

  // The merged list, from the core rather than assembled here. Today the arms are required to agree,
  // so the peer merge has nothing to reconcile and this is a derivation rather than a reconciliation
  // — it earns its keep when the alias half lands, since an alias is the one FORKABLE role and a
  // label bound in one arm is exactly what `union` merge policy exists for.
  const channels = mergeChannels(base, arms.map((arm) => arm.rel.channels), { rigid: 'peer' });
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
/**
 * `choose(<key>).option(k, body)…` — the OPTION-MAP form, or `null` to decline.
 *
 * A different question from the boolean `choose`: an N-way lookup on a projected CHOICE rather than a
 * predicate, so the arms are gated by a comparison against each key rather than by a condition and its
 * negation. Everything after the gating is shared — each arm is the ordinary fold over its gated
 * input, and `mergeArms` merges them, including as a VARIANT where their shapes differ, which is what
 * makes the common `option(Pick.none, __.identity())` shape expressible at all.
 *
 * TWO ARMS ARE IMPLICIT and neither is written down (`optionArms`' note): a map with no `Pick.none`
 * emits the TRAVERSER for an unmatched input, and a `__.discard()` body contributes no arm at all.
 * The pass-through is `ChooseStep`'s own default — its private constructor installs identity
 * traversals for both `Pick` tokens — so it is the reference's rule rather than an inference.
 *
 * PRODUCTIVITY IS CARRIED, NOT GUESSED, and this is the piece the form was waiting on. `Pick.none`
 * claims a productive choice that matched no key and `Pick.unproductive` claims one that produced
 * nothing; `TraversalProduct` calls a productive null a value, so `choice IS NULL` answers a different
 * question. `ChildValue.present` is the signal, and a choice whose body cannot report it DECLINES
 * rather than conflating the two — which is why this reads `present` and never tests the value.
 */
function chooseOptions(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length) return null;
  const subject = branchSubject(input, framing);
  if (!subject) return null;
  const seam = childSeam(ctx, fresh);
  const arms = optionArms(step, (nested) => seam.body(nested, 'child'));
  if (!arms) return null;
  const choiceArg = step.args?.[0]?.value;
  const host = childHostOf(subject, labels);
  // A `T` TOKEN CHOICE — `choose(T.label).option('person', …)`. It needs no child body at all: the token
  // is one projection off the host, which is `byExpr`'s own vocabulary, and a `T` token is ALWAYS present
  // (`orderProductivity` says the same thing for the same reason), so the `Pick.unproductive` arm is
  // provably dead and `canBeUnproductive` below reads that off the claim rather than being told.
  const produced = isTokenArg(choiceArg)
    ? tokenChoice(choiceArg.token, subject, fresh)
    : isNested(choiceArg)
      ? ((body) => (body?.length ? seam.scalar(body, host) : null))(seam.body(choiceArg.nested, 'child'))
      : null;
  // A choice that cannot report its own productivity cannot serve the two `Pick` arms, and cannot be
  // told apart from a productive NULL — decline rather than answer one of them for the other.
  if (!produced || !produced.present) return null;

  // THE CHOICE IS PROJECTED TO COLUMNS FIRST, and this is a plan-quality requirement rather than a
  // tidiness one — `groupBarrier` records the same rule for the same reason. The choice is a
  // CORRELATED SUBQUERY and every arm's gate mentions it: arm k tests its own key, negates every
  // earlier one, and the implicit pass-through negates them all. Inlined, that is O(n²) copies of the
  // subquery — measured at 1.5 KB of statement text before this projection and 18.7 KB after the
  // gating landed, for a three-option map. Naming it once makes every later reference a COLUMN.
  //
  // FENCED for the same reason the group key is: the emitter merges a plain `Project` back into the
  // block that reads it, so the naming would buy nothing without the boundary.
  const ARM = 'oarm';
  const CHOICE = 'ochoice';
  const PRESENT = 'opresent';
  const vtypeCol = produced.vtype ? [meta('ovtype', 'text', true)] : [];
  const projected = make.project({
    id: fresh('oc'), input, channels: input.channels,
    type: typeOf(...input.type.cols, meta(CHOICE, 'any', true), meta(PRESENT, 'int', true), ...vtypeCol),
    exprs: [
      ...input.type.cols.map((column) => [column.name, col(input.id, column.name)] as const),
      [CHOICE, produced.expr], [PRESENT, produced.present],
      ...(produced.vtype ? [['ovtype', produced.vtype] as const] : []),
    ],
  });
  const scoped = make.materialize({ id: fresh('om'), input: projected, channels: projected.channels, type: projected.type });
  const choice = { expr: col(scoped.id, CHOICE), present: col(scoped.id, PRESENT), vtype: produced.vtype && col(scoped.id, 'ovtype') };
  // THE CHOICE's own type, not the traverser's: the option KEYS are compared against the projected
  // choice, so this is the `SubjectType` of that column and is unrelated to `subject` above.
  const choiceType: SubjectType = choice.vtype ? { kind: 'perRow', vtype: choice.vtype }
    : produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static'
      ? { kind: 'static', type: produced.framing.type.type, text: produced.framing.type.text }
      : SUBJECT_UNKNOWN;

  // WHICH ARM A ROW TAKES IS ONE COLUMN, computed once — not a predicate per arm.
  //
  // The naive gating is O(n²) in the EXPENSIVE term: arm k tests its own key, negates every earlier
  // key, and the implicit pass-through negates them all — and a key test is a vtype-aware ordering
  // compare, which is the big expression in the plan (`predicateExpr`, the same one `is(P.gt(…))`
  // spends). Measured on a three-option map: 18.7 KB of statement text with the choice inlined, 7.5 KB
  // with the choice projected but the tests still repeated, 1.9 KB with the tests projected too. Same
  // rule as the group key, one level up — name the expensive thing once and let every later reference
  // be a column.
  //
  // The ordinal also carries FIRST-MATCH-WINS for free, because a `CASE` takes its first true `WHEN`:
  // `BranchStep.pickBranches` collects every matching option and `ChooseStep` overrides it with
  // `branches.subList(0, 1)` (`gremlin-core/.../branch/ChooseStep.java:139-142`), which is exactly a
  // `CASE`'s own rule. Reading only the super-method makes overlapping keys look like a fan-out, and
  // this emitted six rows where `Choose.feature:244-256` pins four until the override was read.
  const NONE = -1;
  const UNPRODUCTIVE = -2;
  const keyed = arms.filter((arm) => arm.pick === 'key');
  /**
   * CAN THIS CHOICE BE UNPRODUCTIVE AT ALL — read off the seam's own claim, not assumed.
   *
   * `Pick.unproductive` is the choice producing NOTHING and `Pick.none` a value no option claims;
   * TinkerPop routes them differently, which is why the presence signal exists. But a choice that
   * ALWAYS produces — `count()` seeds 0 — can never reach the first, so its `WHEN` is dead and, more
   * importantly, the implicit PASS-THROUGH for an unclaimed `Pick.unproductive` is an arm that cannot
   * fire. Emitting it anyway declares a shape the traversal never has: `choose(__.out().count())
   * .option(1, __.values('name')).option(Pick.none, __.discard())` became a VARIANT of scalar and
   * element where the reference gives a plain value stream. Right arity, wrong shape.
   */
  const canBeUnproductive = produced.present !== ALWAYS_PRODUCTIVE;
  const whens: (readonly [Expr, Expr])[] = canBeUnproductive
    ? [[{ kind: 'unary', op: 'not', arg: choice.present }, compilerInt(UNPRODUCTIVE)]]
    : [];
  for (const [at, arm] of keyed.entries()) {
    const pred = predicateExpr(choice.expr, arm.key, choiceType, null, null, fresh);
    if (!pred) return null;
    whens.push([pred, compilerInt(at)]);
  }
  const armOf = make.project({
    id: fresh('oa'), input: scoped, channels: scoped.channels,
    type: typeOf(...scoped.type.cols, meta(ARM, 'int')),
    exprs: [...scoped.type.cols.map((column) => [column.name, col(scoped.id, column.name)] as const),
      [ARM, { kind: 'case', whens, else: compilerInt(NONE) }]],
  });
  const takes = (ordinal: number): Expr => eq(col(armOf.id, ARM), compilerInt(ordinal));

  // The ordinal each written arm claims. A `Pick` arm claims its sentinel; a keyed arm claims its
  // position, which is the order `whens` above assigned.
  const claimed: number[] = [];
  const gated: { readonly arm: OptionArm; readonly ordinal: number }[] = [];
  let next = 0;
  for (const arm of arms) {
    const ordinal = arm.pick === 'unproductive' ? UNPRODUCTIVE : arm.pick === 'none' ? NONE : next++;
    claimed.push(ordinal);
    if (!arm.discard) gated.push({ arm, ordinal });
  }
  // AN ARM RUNS OVER THE INPUT'S OWN COLUMNS, not the widened ones. The choice columns exist to be
  // TESTED and nothing downstream may see them: an arm body is the ordinary fold, and a `values()`
  // after one joins the property table against a relation whose declared width it computes from the
  // CHANNELS. Leaving the extra payload columns on it made that join declare six and emit nine — a
  // factory throw, i.e. a compile error where the traversal must answer. So the gate filters on the wide relation
  // and projects straight back to the narrow one, and the widening never escapes this step.
  const gate = (pred: Expr): Rel => {
    const kept = make.filter({ id: fresh('og'), input: armOf, channels: armOf.channels, type: armOf.type, pred });
    // Addressed through `kept`, not `armOf`: a node addresses its own INPUT, and `armOf` is the
    // GRANDchild here. Naming it is the "no relation in scope" the checker catches — and it caught it.
    return make.project({
      id: fresh('on'), input: kept, channels: input.channels, type: input.type,
      exprs: input.type.cols.map((column) => [column.name, col(kept.id, column.name)] as const),
    });
  };

  const built: Tail[] = [];
  for (const { arm, ordinal } of gated) {
    const body = seam.body(arm.nested, 'child');
    if (!body?.length) return null;
    const lowered = continueAs(gate(takes(ordinal)), framing, body, 0, bulked, inBody(ctx), fresh, labels);
    if (!lowered) return null;
    built.push(lowered);
  }
  // THE IMPLICIT PASS-THROUGH is every ordinal no written arm claimed — which is at most the two
  // sentinels, since every keyed ordinal is claimed by construction. Deriving it from the claims
  // rather than from which tokens were written is what keeps it right when both are, and what makes a
  // `discard` arm's rows disappear rather than fall through: its ordinal IS claimed.
  const unclaimed = [NONE, ...(canBeUnproductive ? [UNPRODUCTIVE] : [])]
    .filter((ordinal) => !claimed.includes(ordinal));
  if (unclaimed.length) {
    built.push({
      rel: gate(unclaimed.map(takes).reduce((left, right) => ({ kind: 'binary', op: 'or', left, right }))),
      framing,
      aliases: labels,
      // The pass-through arm IS the branch's input, unchanged, so it stands for exactly what the input
      // did — nothing here collapses and nothing resets a multiplicity.
      bulked,
    });
  }
  if (built.length < 2) return null;
  return mergeArms(built, input.channels, labels, fresh);
}

/**
 * `coalesce(a1, …, an)` — UNION with PRIORITY, and expressible as one because "priority" is a per-input
 * PREDICATE the child seam already builds.
 *
 * `CoalesceStep.flatMap` walks its arms in order and returns the FIRST whose `hasNext()` is true, with
 * all of that arm's results. So arm k contributes exactly the input rows for which arms 1…k−1 produced
 * NOTHING — which is `childPredicate(body, subject, …, negated)` per earlier arm, conjoined, applied to
 * arm k's INPUT rather than to its output. Filtering the input rather than the arm is what makes it a
 * composition instead of new machinery: each arm is then the ordinary fold over its own gated input and
 * `mergeArms` merges them, variant shapes included, exactly as `union` and `choose` already do.
 *
 * ⚠️ The guards go on the INPUT because that is where the row is: an arm's output has been reprojected
 * to the arm's shape, so the incoming id a correlated `NOT EXISTS` needs is no longer there to name.
 *
 * Cost is n(n−1)/2 correlated existence subqueries, which is the shape of the question and not an
 * artifact — "did the earlier arm produce anything" has to be asked once per earlier arm.
 */
function coalesceArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);
  if (args.length < 2 || args.some((arg) => !isNested(arg))) return null;
  const bodies = args.map((arg) => bodyOf((arg as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((body) => !body?.length)) return null;
  return coalesceMerge(bodies as readonly (readonly IRStep[])[], input, framing, bulked, ctx, fresh, labels);
}

/**
 * `optional(t)` ≡ `coalesce(t, __.identity())` — `OptionalStep` emits t's results where t produces and
 * the ORIGINAL traverser otherwise (`vendor/tinkerpop/gremlin-core/.../branch/OptionalStep.java`), which
 * is the coalesce priority over two arms: the body, then an EMPTY-body fallback that `continueAs` lowers
 * as the input unchanged. `OptionalStep extends AbstractStep` takes one start at a time, so it inherits
 * the same per-traverser reduction arm and traverser-major slice key `coalesce` uses.
 */
function optionalArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  const [nested, extra] = argValues(step);
  if (extra !== undefined || !isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params);
  if (!body?.length) return null;
  return coalesceMerge([body, []], input, framing, bulked, ctx, fresh, labels);
}

/**
 * THE COALESCE MERGE over explicit arm bodies — shared by `coalesce` and `optional` (its identity
 * fallback is the one empty body this admits). `coalesce`/`optional` are `FlatMapStep`-family, so they
 * reset PER TRAVERSER and are always traverser-major, arm-minor — never batched. Under a SLICE demand
 * (`ctx.sliced`) that fixes the subset a downstream `limit`/`tail` takes (`branch-traverser-major.feature`),
 * so the arms lower from `augmentParent(input)` — freezing the parent position as the major sort key — and
 * merge through `mintTraverserMajor`. A COLLECT demand takes any deterministic order (`withFanoutOrder`); a
 * positionless one drops the order (`dropEncounter`). See `unionArms`.
 */
function coalesceMerge(
  bodies: readonly (readonly IRStep[])[], input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  const slice = sliceableBranch(ctx, input);
  const source = slice ? augmentParent(input, fresh) : input;
  const subject = branchSubject(source, framing);
  if (!subject) return null;

  const arms: Tail[] = [];
  let exhausted: Expr | undefined;
  for (const [at, body] of bodies.entries()) {
    const domain = exhausted
      ? make.filter({ id: fresh('coa'), input: source, channels: source.channels, type: source.type, pred: exhausted })
      : source;
    // A per-traverser REDUCTION arm (`__.out().count()`, `__.values(k).fold()`) is CORRECT for `coalesce`
    // (a `FlatMapStep`, per-traverser) — routed through the child seam, one row per host carrying every
    // channel; a movement/transform arm returns null and stays the ordinary `continueAs`. See `reductionArm`.
    const arm = reductionArm(domain, framing, body!, ctx, fresh, labels, bulked)
      ?? continueAs(domain, framing, body!, 0, bulked, inBody(ctx), fresh, labels);
    if (!arm) return null;
    // The slice path keeps each arm's within-arm order for `mintTraverserMajor` to consume; every
    // other path drops it, as a fresh unordered stream carries none.
    arms.push(slice ? arm : { ...arm, rel: dropEncounter(arm.rel, fresh) });
    // The LAST arm owes no guard for anyone, so it is not asked for one — a body whose non-production
    // this route cannot express still coalesces when it is last, which is the common `constant(x)`
    // fallback.
    if (at === bodies.length - 1) continue;
    // A BODY THAT ALWAYS PRODUCES exhausts the coalesce, and saying so is not an optimization: the
    // common `coalesce(__.values('name'), __.constant('x'))` shape has a `constant()` FALLBACK, and a
    // `constant()` in a non-final position means no later arm can ever fire. `childPredicate` cannot
    // answer "this body produces nothing" for a body that ignores its input, so `alwaysProduces`
    // (`ir/productivity.ts`, the same authority the filter-no-op Pass reads) supplies the constant.
    // A body of ONLY STREAM-IDENTITY steps (a side-effect arm — `aggregate("a")`, a labelled
    // `groupCount("a")`, `sideEffect(…)`, `identity()`) emits exactly its input, so it too always
    // fires; `alwaysProduces` cannot see it because it reads the LAST step alone (`out().aggregate("a")`
    // must NOT qualify — `out()` can produce nothing), so the whole-body check is separate.
    const alwaysFires = alwaysProduces(body!) || body!.every((inner) => isStreamIdentity(inner, ctx.params));
    const empty = alwaysFires ? CONSTANT.false : childPredicate(body!, subject, fresh, ctx, true);
    if (!empty) return null;
    exhausted = and(exhausted, empty);
  }
  return slice
    ? mintTraverserMajor(arms, source, labels, fresh)
    : branchResult(mergeArms(arms, withoutEncounter(input.channels), labels, fresh), ctx, fresh);
}

function chooseArms(
  step: IRStep, input: Rel, framing: RelFraming, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): FramedRel | null {
  if (step.modulators?.length) return null;
  if (step.optionArms) return chooseOptions(step, input, framing, bulked, ctx, fresh, labels);
  // A `choose` is a `BranchStep` like `union` — barrier-free it is TRAVERSER-major, a batched-barrier
  // arm makes it ARM-major (`BranchStep.java`). Only the ARM bodies decide `hasBarrier` (the condition
  // is a per-traverser predicate, not an option), so a SLICE with a batched then/else arm declines
  // (arm-major not built); otherwise the arms lower from `augmentParent(input)` and merge through
  // `mintTraverserMajor`, else the fan-out order is minted for a collect / dropped. See `unionArms`.
  const args = argValues(step);
  if (args.length < 2 || args.length > 3) return null;
  // THE CONDITION MAY BE A BARE PREDICATE, not only a body: `choose(P.eq(29), __.constant('matched'))`
  // is `ChooseStep(new IsStep(P), …)` — TinkerPop's own `choose(Predicate, …)` overload wraps it — so
  // spelling it as a one-step `is` body reuses `bodyPredicate` rather than adding a second predicate
  // path. Declining it made the whole `choose(P, …)` overload look like a missing branch lowering.
  const [choice, ...rest] = step.args ?? [];
  if (!choice || rest.some((arg) => !isNested(arg.value))) return null;
  const condition = isNested(choice.value)
    ? bodyOf(choice.value.nested, ctx.params)
    : isPred(choice.value) ? [{ name: 'is', args: [choice] } as IRStep] : null;
  const bodies = rest.map((arg) => bodyOf((arg.value as { readonly nested: unknown }).nested, ctx.params));
  const [then, otherwise] = bodies;
  if (!condition?.length || !then?.length) return null;

  const slice = sliceableBranch(ctx, input);
  if (slice && [then, otherwise ?? []].some((body) => armBatches(body!))) return null;
  const source = slice ? augmentParent(input, fresh) : input;
  const subject = branchSubject(source, framing);
  if (!subject) return null;

  const pred = bodyPredicate(condition, subject, fresh, ctx);
  if (!pred) return null;
  const guarded = (negated: boolean): Rel => make.filter({
    id: fresh('cg'), input: source, channels: source.channels, type: source.type,
    pred: negated ? { kind: 'unary', op: 'not', arg: pred } : pred,
  });

  const armThen = continueAs(guarded(false), framing, then, 0, bulked, inBody(ctx), fresh, labels);
  // The else arm over ZERO steps is `identity` on the complement — see above.
  const armElse = continueAs(guarded(true), framing, otherwise ?? [], 0, bulked, inBody(ctx), fresh, labels);
  if (!armThen || !armElse) return null;
  const arms = [armThen, armElse];
  if (slice) return mintTraverserMajor(arms, source, labels, fresh);
  // Drop the spent position from each arm (an arm-local `order()`/`limit()`), as `union` does — a
  // `choose` is unordered, so the merged stream carries none.
  const dropped = arms.map((arm) => ({ ...arm, rel: dropEncounter(arm.rel, fresh) }));
  return branchResult(mergeArms(dropped, withoutEncounter(input.channels), labels, fresh), ctx, fresh);
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
        // TWO MAP ARMS MERGE when the two SIDES agree, which is the list arm's rule with two member
        // encodings instead of one: each arm carries a single `map` column, so the union is positional
        // and needs nothing re-projected. It became reachable the moment a map stopped being terminal —
        // `choose(p, __.valueMap('name'), __.valueMap('age'))` is the shape, and an arm-local BARRIER
        // inside one (`__.groupCount()`) is the branch child's own scope exactly as a `fold()` arm is.
        : left.kind === 'map'
          ? right.kind === 'map' && JSON.stringify(left.keyOf) === JSON.stringify(right.keyOf)
            && JSON.stringify(left.valOf) === JSON.stringify(right.valOf)
        // A MAP.ENTRY arm is the same equality over the same two sides — two columns rather than one,
        // and the column test below is what checks that.
        : left.kind === 'mapEntry'
          ? right.kind === 'mapEntry' && JSON.stringify(left.keyOf) === JSON.stringify(right.keyOf)
            && JSON.stringify(left.valOf) === JSON.stringify(right.valOf)
          // Two PROPERTY arms could merge when they agree on the owner kind, but the columns differ
          // between vertex and edge (`vpid`/`meta`), so a blanket equality would union relations of
          // different widths. Nothing builds a property-valued branch yet; decline until one does.
          : left.kind === 'property' ? false
            // TWO RECORD ARMS MERGE when their fields agree in key, order AND shape — the map arm's
            // rule one level down, and the same move: a record's payload is its fields' PREFIXED
            // columns (`framingCols`), so once the fields agree the union is positional and needs
            // nothing re-projected. It is reachable because a branch arm may now END in a `project()`
            // — `union(__.hasLabel(A).project(k…), __.hasLabel(B).project(k…))`, the per-member type
            // dispatch a GraphQL interface/union field lowers to, and the same shape Neo4j's GraphQL
            // library emits as `CALL { … RETURN this0 {…} AS this UNION … }` (one branch per member,
            // each building its own row).
            : left.kind === 'record' ? right.kind === 'record' && sameRecordFields(left.fields, right.fields)
              // A VARIANT arm would be a branch nested inside a branch whose inner merge already went
              // mixed. `variantMerge` flattens no nesting today — an arm's tagged rows would have to
              // be re-tagged onto the outer payload, which is expressible and unbuilt — so declining
              // is the honest answer rather than double-tagging the rows.
              : left.kind === 'variant' ? false
                // A DETACHED arm would be a branch INSIDE a resumed chain, whose rows are a landed
                // constant relation rather than a stream this plan can re-read. Nothing produces one
                // (the detached tail admits three reads and no branch), so declining keeps the switch
                // total rather than merging two relations that are not the same width.
                : left.kind === 'detached' ? false
                  // A per-row TYPED NODE arm is a branch whose body is `cap(mixed).unfold()`. It is
                  // terminal (no uniform continuation), so a branch arm ending in one is not built;
                  // decline rather than union two heterogeneous node streams positionally.
                  : left.kind === 'typedNode' ? false
                    : right.kind === 'scalar' && JSON.stringify(left.type) === JSON.stringify(right.type);

/** A record collapsed to a map value carries SELF-DESCRIBING `{t,v}` pairs, which is the map
 *  vocabulary's one scalar encoding on both sides (`MapOf`, `render.ts`: "the scalar side of a map is
 *  ALWAYS a self-describing {t,v} ValueNode … heterogeneous maps round-trip"). Spelled once here
 *  because `scalarChild`'s record arm already claims exactly this framing for exactly this relation. */
const MAP_OF_NODES = { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } } as const;

/**
 * ARMS WHOSE RECORDS DISAGREE, RE-PROJECTED AS MAP VALUES — or `null` where this route does not apply.
 *
 * Two record arms merge as records only when their fields AGREE (`sameRecordFields`), because a record's
 * payload is its fields' prefixed COLUMNS and a `Union` is positional. That is the common case and the
 * capable one — the fields stay addressable, so `union(…).select('a')` keeps working. It is also exactly
 * what a GraphQL interface/union field does NOT satisfy: each member selects its OWN fields, so the arms
 * disagree by construction.
 *
 * The fix is not a wider row — it is a NARROWER one. `recordToMap` collapses a record's fields into the
 * single `map` column the map vocabulary already reads, whose entries are self-describing `{t,v}` nodes,
 * so two arms with entirely different key sets become two rows of one column and the positional `Union`
 * has nothing left to disagree about. This is precisely the shape the Neo4j GraphQL library emits for the
 * same query — each `CALL` branch does `WITH this0 { .id, __resolveType: "Child1" } AS this0 RETURN this0
 * AS this`, i.e. builds a MAP inside the branch so the branches union over one column — and it is why
 * they never hit the same-named-field clash a flattened projection would.
 *
 * Three declines, each deliberate:
 *
 * - **no record arm at all** — nothing to demote; the ordinary paths own it.
 * - **records that already AGREE** — demoting would spend the fields' addressability as COLUMNS for no
 *   gain. A record stays a record wherever it can, which keeps the one-directional rule honest
 *   (`framing.ts`: a record becomes a map at the boundary that needs a VALUE, and nothing turns a map
 *   back into a record).
 * - **an arm that is neither a record nor an already-`{t,v}` map** — an `elem`- or `list`-valued map's
 *   entries are a different physical form, so merging it with record-derived nodes would union two
 *   encodings under one framing. Fail closed.
 *
 * What the demotion costs is the field's COLUMN, not its reachability: `select(k)` over the merged
 * stream still answers, through the map vocabulary's JSON member read rather than a prefixed column, and
 * it answers CORRECTLY on rows where `k` is absent — `SelectOneStep` tries the traverser's own map and a
 * missing key is a `KeyNotFoundException` → `EmptyTraverser`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:65-90`),
 * so those rows DROP rather than reading a sibling arm's value. Measured on all three key-presence
 * arrangements (`record-branch-arms.exec.test.ts`).
 */
function mapDemotedArms(arms: readonly Tail[], fresh: Minter): readonly Tail[] | null {
  const fieldsOf = (arm: Tail): readonly RecordField[] | null => (arm.framing.kind === 'record' ? arm.framing.fields : null);
  const records = arms.map(fieldsOf);
  if (!records.some((fields) => fields)) return null;
  const first = records[0];
  if (first && records.every((fields) => fields && sameRecordFields(first, fields))) return null;
  const demotable = (arm: Tail): boolean => arm.framing.kind === 'record'
    || (arm.framing.kind === 'map' && arm.framing.keyOf.kind === 'scalar' && arm.framing.valOf.kind === 'scalar');
  if (!arms.every(demotable)) return null;
  const out: Tail[] = [];
  for (const [at, arm] of arms.entries()) {
    const fields = records[at];
    if (!fields) { out.push(arm); continue; }
    const mapped = recordToMap(arm.rel, fields, fresh);
    if (!mapped) return null;
    out.push({ ...arm, rel: mapped, framing: MAP_OF_NODES });
  }
  return out;
}

/**
 * Do two records describe the same row? Field for field, IN ORDER — `RecordField.prefix` is positional
 * (`prefixAt`, `record.ts`), so position IS the column name and two records that agree here occupy the
 * same columns by construction.
 *
 * `optional` is compared rather than merged, and that is the deliberate narrowing: `mergeArms` adopts
 * the FIRST arm's framing for the merged stream, so admitting a disagreement would silently impose one
 * arm's productivity rule on the other's rows — TinkerPop omits an unproductive key
 * (`ProjectStep.map`'s `ifProductive`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66`),
 * so getting that flag wrong is a key present where the reference has none. Merging it properly means
 * recomputing the merged framing, which is the caller's to do if a case ever needs it.
 */
const sameRecordFields = (left: readonly RecordField[], right: readonly RecordField[]): boolean =>
  left.length === right.length && left.every((field, i) => {
    const other = right[i]!;
    return field.key === other.key && field.prefix === other.prefix
      && field.optional === other.optional && sameFraming(field.framing, other.framing);
  });

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
/** `addE(…)` plus the `from`/`to`/`property` cluster that belongs to it — the cluster is one run and
 *  the members may come in any order. */
function addedEdges(
  input: Rel, elem: Elem | null, steps: readonly IRStep[], at: number, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
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
  predicate: (body, subject, negated) => (negated
    ? correlatedExists(body, subject, fresh, ctx, true) ?? valuePredicate(body, subject, fresh, ctx, true)
    : bodyPredicate(body, subject, fresh, ctx)),
  rooted: (steps) => rootedRead(steps, ctx, fresh),
  rows: (body, input, elem, aliases) => childRows(body, input, elem, aliases, ctx, fresh),
  // `bulked: false` is a fold RESET, and it is safe for a reason worth naming rather than trusting:
  // every step whose lowering READS `bulked` — the slice family and a grouping barrier — mints a
  // `limit`/`window`/`sort`/`aggregate` node, and each of those is refused outright inside a
  // recursive term (`BARRIER_IN_TERM`, src/rel/recursive.ts). So no caller of this seam can reach a
  // step that would answer differently for a bulked row. Admitting a per-iteration barrier here
  // would break that coincidence, and that is the increment that must pass `bulked` through.
  //
  // **`collapse: false` IS THE SAME FACT FROM THE OTHER SIDE, and it is now load-bearing.** This arm's
  // one caller is `walk.ts`'s recursive TERM, and a collapse mints exactly the node a term may not
  // hold: `coalesce` is a grouped `Aggregate`, which SQLite refuses as *"recursive aggregate queries
  // not supported"* — §1a of `docs/archive/2026-08-09-repeat-two-regimes-plan.md`, the measurement that split
  // the two regimes in the first place. It cost nothing while the chain verdict was the gate (a chain
  // containing `repeat` was never collapse-safe, so `ctx.collapse` was already false here); with the
  // decision positional the switch is on, and without this narrowing every unbounded `repeat()` would
  // lower a term the checker then refuses — i.e. the whole recursive-walk lowering declining, on a
  // widening that has nothing to do with it. A term's inability to collapse is not a limitation to route
  // around: it is the reason the BOUNDED regime unrolls into phases instead.
  chain: (input, framing, body, aliases) =>
    continueAs(input, framing, body, 0, false, inBody(ctx), fresh, aliases),
  body: (nested, scope) => (scope === 'child'
    ? bodyOf(nested, ctx.params, ctx.sideEffects)
    : rootedSteps(nested, ctx.params, ctx.sideEffects)),
});

/**
 * DOES THIS RELATION YIELD AT MOST ONE ROW — the question a correlated SCALAR subquery must be able to
 * answer YES to, asked of the plan rather than inferred from a framing marker.
 *
 * SQL's scalar subquery takes the first row of whatever it is given and says nothing about it, so a
 * plan that can emit several is a wrong ANSWER chosen by scan order. The collapsing node is a REDUCING
 * barrier — an `Aggregate` with no `groupBy`, which is one row by definition — or an explicit
 * one-row `Limit`. Above it, row-count-preserving or row-count-REDUCING nodes are transparent: a
 * `Project`/`Sort`/`Window` keeps the count, a `Filter`/`Distinct` can only lower it, and either way
 * "at most one" survives. Anything else (a `Join`, a `Union`, a `Scan`, a `JsonEach`) can multiply and
 * stops the walk.
 *
 * It is deliberately a SUFFICIENT test and not a complete one: answering "no" costs a decline, and
 * answering "yes" wrongly costs an arbitrary row.
 */
function collapsedToOneRow(rel: Rel): boolean {
  switch (rel.kind) {
    case 'aggregate': return rel.groupBy.length === 0;
    case 'limit': return rel.count?.kind === 'lit' && rel.count.value === 1;
    case 'project': case 'sort': case 'window': case 'filter': case 'distinct': case 'materialize':
      return collapsedToOneRow(rel.input);
    default: return false;
  }
}

/**
 * `map()` / `flatMap()` / `local()` — A CHILD BODY APPLIED PER TRAVERSER, or `null` to decline.
 *
 * TinkerPop's three per-traverser hosts differ in ONE thing, and naming that thing is what makes them
 * one lowering rather than three: the CARDINALITY POLICY.
 *
 * - `map(b)` takes the body's FIRST result and DROPS the traverser when there is none —
 *   `TraversalMapStep.processNextStart` is `iterator.hasNext() ? traverser.split(iterator.next()) :
 *   EmptyTraverser` (`gremlin-core/.../step/map/TraversalMapStep.java:49-53`).
 * - `flatMap(b)` emits every result.
 * - `local(b)` emits every result too, and additionally scopes the body's BARRIERS to one start.
 *
 * ## Why this arm is a correlated SCALAR and not a rejoined relation
 *
 * A correlated scalar answers "one value per host row", which is `map`'s policy EXACTLY and is also
 * what `local`/`flatMap` reduce to whenever the body provably yields one — a reducing barrier. So the
 * shapes that need no per-parent rejoin at all are served by the seam that already exists, and the
 * REJOIN (a body that fans out under `local`/`flatMap`, a per-parent slice, a per-parent `fold()`)
 * is the next increment rather than a prerequisite of this one. `child.rows` is what it will use.
 *
 * The decline that keeps this honest is the seam's own: `scalarChild` refuses a movement whose tail is
 * not reducing, precisely because SQLite would silently take the first row of a fan-out. So
 * `map(__.out().values('name'))` declines rather than answering an arbitrary member — a `map` DOES
 * take the first, but "first" is a question about emission order that a correlated subquery cannot
 * answer, and answering it by scan luck is the one thing the decline contract exists to prevent.
 *
 * PRODUCTIVITY is required, never assumed: `map` must drop an unproductive traverser, so a body whose
 * productivity the seam cannot state (`ChildValue.present` absent — a numeric reducer over an empty
 * child, which `correlatedExists` fails closed on for the same reason) declines here too.
 */
/** The child HOST for a per-traverser body over an element or scalar stream — the subject `scalarChild`
 *  reads. Extracted so the `map`/`local`/`flatMap` dispatch and a `coalesce`/`optional` reduction arm
 *  name ONE host shape rather than two copies of it. */
function reductionHost(
  rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, labels: AliasMap,
): ChildHost {
  return framing.kind === 'elements'
    ? elementHost(rel, framing.elem, labels)
    : {
      kind: 'scalar', value: col(rel.id, 'v'), row: { rel, aliases: labels },
      ...(rel.type.cols.some((column) => column.name === 'vtype') ? { vtype: col(rel.id, 'vtype') }
        : framing.type.kind === 'static' ? { vtype: compilerText(framing.type.type) } : {}),
    };
}

/**
 * A per-traverser reduction's one-value-per-host expression FRAMED as this stream's payload columns — the
 * projection `perTraverserChild` (map/local/flatMap) and a `coalesce`/`optional` reduction arm share.
 *
 * The body's ONE result becomes the payload: an element re-roots to its rowid, a fold's value lands in the
 * canonical `list` column, a scalar to `v` (plus a `vtype` column where the seam read a stored type). Every
 * carried channel PASSES THROUGH unchanged (it is one row per host, so a frozen fan-out position survives),
 * and an arm that can be UNPRODUCTIVE rides its presence out as a column, filters on it, then sheds it — so
 * the tail sees exactly the payload its framing declares. The assembler fuses the three nodes into one
 * SELECT. See `perTraverserChild`'s §3.3 note on why the filter is a sibling projection, not nested.
 */
function reductionTail(rel: Rel, produced: ChildValue, fresh: Minter, labels: AliasMap, bulked: boolean): Tail | null {
  const present = produced.present;
  if (!present) return null;
  const payload = ((): { readonly cols: readonly (readonly [ColMeta, Expr])[]; readonly framing: RelFraming } | null => {
    if (produced.framing.kind === 'elements')
      return { cols: [[meta('id', 'int', true), produced.expr]], framing: produced.framing };
    if (produced.framing.kind === 'list')
      return { cols: [[meta(LIST_COL, 'json'), produced.expr]], framing: produced.framing };
    if (produced.framing.kind !== 'scalar') return null;
    return produced.vtype
      ? {
        cols: [[meta('v', 'any', true), produced.expr], [meta('vtype', 'text', true), produced.vtype]],
        framing: { kind: 'scalar', type: PER_ROW('vtype') },
      }
      : { cols: [[meta('v', 'any', true), produced.expr]], framing: produced.framing };
  })();
  if (!payload) return null;
  const channels = rel.channels;
  const dropping = present !== ALWAYS_PRODUCTIVE;
  const PRESENT = 'mp';
  const cols = [...payload.cols.map(([column]) => column), ...carriedCols(channels)];
  const projected = make.project({
    id: fresh('mc'), input: rel, channels,
    type: typeOf(...cols, ...(dropping ? [meta(PRESENT, 'int', true)] : [])),
    exprs: [
      ...payload.cols.map(([column, expression]) => [column.name, expression] as const),
      ...channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const),
      ...(dropping ? [[PRESENT, present] as const] : []),
    ],
  });
  if (!dropping) return { rel: projected, framing: payload.framing, aliases: labels, bulked };
  const kept = make.filter({
    id: fresh('mf'), input: projected, channels, type: projected.type, pred: col(projected.id, PRESENT),
  });
  const shed = make.project({
    id: fresh('ms'), input: kept, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(kept.id, column.name)] as const),
  });
  return { rel: shed, framing: payload.framing, aliases: labels, bulked };
}

/**
 * A `coalesce`/`optional` arm that REDUCES per traverser — `coalesce(__.out().count(), __.constant(0))`,
 * `coalesce(__.out('knows').values('name').fold(), __.constant('none'))` — routed through the SAME child
 * seam a `local()`/`map()`/`by()` body already uses, so a per-origin fold/count is one caller not a second
 * fold.
 *
 * ⚠️ ONLY `coalesce`/`optional`, never `union`/`choose`: `CoalesceStep extends FlatMapStep` and
 * `OptionalStep extends AbstractStep` take ONE start at a time unconditionally
 * (`vendor/tinkerpop/gremlin-core/.../branch/CoalesceStep.java:38`), so a barrier arm genuinely reduces
 * over that traverser's sub-stream. `UnionStep`/`ChooseStep extends BranchStep`, whose `standardAlgorithm`
 * injects EVERY start at once when any option holds a `Barrier` (`BranchStep.java:87,143` — both
 * `CountGlobalStep` and `FoldStep extends ReducingBarrierStep`), so THEIR reducer arms reduce over the
 * whole input and are the batched/arm-major lowering, NOT this (element-branch-child.feature draws the
 * line, `[6,4]` not per-vertex).
 *
 * Gated to a body ENDING in a per-origin collapse (`selfCollapses`) that is ALWAYS PRODUCTIVE (`count`/
 * `fold` seed, so every host row yields one row and the coalesce exhaustion stays the existing
 * `alwaysProduces` path — a non-seeded reducer whose arm can be empty stays declined here). A movement or
 * transform arm returns `null` and keeps the ordinary `continueAs`, which already lowers a
 * transparent / fan-out arm correctly.
 */
function reductionArm(
  domain: Rel, framing: RelFraming, body: readonly IRStep[], ctx: ChainCtx, fresh: Minter, labels: AliasMap, bulked: boolean,
): Tail | null {
  const terminal = body.at(-1);
  if (body.length < 2 || !terminal || !selfCollapses(terminal.name)) return null;
  if (framing.kind !== 'elements' && framing.kind !== 'scalar') return null;
  const produced = scalarChild(body, reductionHost(domain, framing, labels), ctx, fresh);
  if (!produced || produced.yields !== 'one' || produced.present !== ALWAYS_PRODUCTIVE) return null;
  return reductionTail(domain, produced, fresh, labels, bulked);
}

function perTraverserChild(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, steps: readonly IRStep[], at: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  if (step.modulators?.length || step.optionArms) return null;
  const [nested, extra] = argValues(step);
  if (extra !== undefined || !isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params);
  if (!body?.length) return null;

  const produced = scalarChild(body, reductionHost(rel, framing, labels), ctx, fresh);
  if (!produced) return flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels);
  // THE POLICY, and it is the whole difference between the three steps: `local`/`flatMap` emit EVERY
  // result, so a correlated scalar is their answer only where the body had exactly ONE to give, while
  // `map` takes the first by definition. The seam states which (`ChildValue.yields`) rather than this
  // reading it off the framing — a reducing `result` marker implies one, but so does an endpoint
  // re-root that is not a reducer at all, and inferring it here made `local(__.outV())` decline.
  if (step.name !== 'map' && produced.yields !== 'one') return null;
  // An unproductive body DROPS the traverser at all three hosts (`map` by the citation above;
  // `local`/`flatMap` because a body with no results contributes none), so the signal is required
  // rather than assumed — `ChildValue.present`'s own contract.
  if (!produced.present) return null;

  // The body's ONE result framed as this stream's payload, presence filtered and shed — see
  // `reductionTail`, shared with the `coalesce`/`optional` reduction arm. The tail then continues.
  const tail = reductionTail(rel, produced, fresh, labels, bulked);
  return tail && continueAs(tail.rel, tail.framing, steps, at + 1, bulked, ctx, fresh, labels);
}

/**
 * A FAN-OUT `flatMap`/`local` body, spliced back as a REJOIN — the general child answer
 * `scalarChild`'s movement arm explicitly defers ("fan-out `flatMap(__.V()…)` needs the general child
 * rejoin"). `scalarChild` only produces a body that yields ONE value per traverser; a body that FANS
 * OUT (`__.out()`, `__.out().values('name')`) is not a correlated scalar, it REJOINS.
 *
 * A body with NO stream barrier is TRANSPARENT: `flatMap`/`local` run it per traverser, and with
 * nothing to scope per-origin the answer is the body inlined into the outer chain — `flatMap(__.out())`
 * is `out()`, `local(__.out())` is `out()`. So mint the `origin` channel (the seam's `rows` arm), lower
 * the body over it, then DROP origin: a later `dedup` is whole-row, so leaving origin as a column would
 * make it distinguish rows by WHICH host they descend from and keep convergent walks that must collapse.
 *
 * A barrier INSIDE the body (`local(__.out().order().by(k))`, `local(__.out().fold())`) needs the
 * order/slice/fold scoped PER ORIGIN — a window partitioned by `origin`, a later increment — so
 * `isStreamBarrier` declines it here rather than letting the ordinary fold answer the GLOBAL question
 * (a wrong answer `childRows` would not catch, since `order()`/`limit()` preserve the origin channel).
 *
 * `map` is excluded: it takes the FIRST body result, not all, so a fan-out under it is a per-origin
 * window, not this. A scalar host has no rowid for `origin` (`childRows`' own limit), so only an element
 * host reaches here.
 */
function flatMapRejoin(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>,
  body: readonly IRStep[], steps: readonly IRStep[], at: number, bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  if ((step.name !== 'flatMap' && step.name !== 'local') || framing.kind !== 'elements') return null;
  // PATH HIDING — "Objects from flatMap traversal should be hidden from path()"
  // (`vendor/tinkerpop/gremlin-test/.../map/FlatMap.feature:56`): `flatMap(out().out()).path()` is
  // `[v, end]`, NOT `[v, mid, end]`. The rejoin lowers the body through the ordinary fold, whose hops
  // each MINT a path position, so under a path demand the body's intermediate objects would leak into
  // the path. Hiding them (one input→output path step for the whole body) is a later increment; fail
  // closed while path is tracked.
  if (ctx.tracksPath) return null;
  // A LABEL BOUND INSIDE THE BODY THAT THE OUTER CHAIN READS must ESCAPE to the parent scope
  // (`g.V()…as('a').local(__.out('created').as('b')).select('a','b')` — b is bound in the body and
  // read after) — and that propagation is the child-body-label-escape feature the rejoin does NOT
  // wire, so the outer `select('b')` would find b unbound and answer `[]`. Fail closed: decline when a
  // body-bound label is read downstream, while keeping the cases where the label is consumed WITHIN
  // the body (`local(__.out().as('a').select('a'))`) or the body binds nothing at all.
  const bodyBound = labelsBoundBefore(body, body.length, ctx.params);
  if (bodyBound.size) {
    const outerReads = labelReads(steps.slice(at + 1), ctx.params);
    if (outerReads.all || [...bodyBound].some((label) => outerReads.labels.has(label))) return null;
  }
  // A TRAILING GLOBAL SLICE is scoped PER ORIGIN — `local(__.bothE('created').limit(1))` is one edge
  // per HOST vertex, not one edge total. The prefix must be barrier-free (the slice is the only
  // barrier), and only `limit`/`skip`/`range` (`sliceOf`) reach here — `tail` counts from the end (a
  // per-origin total this does not yet compute) and stays declined. Everything before it is the plain
  // rejoin. `map` is excluded above, so a slice under it (its per-origin WINDOW taking rn=1) is a
  // separate lowering.
  const last = body[body.length - 1]!;
  const perOriginSlice = body.length > 1 && (last.name === 'limit' || last.name === 'skip' || last.name === 'range') && !isLocalScope(last);
  const prefix = perOriginSlice ? body.slice(0, -1) : body;
  if (prefix.some(isStreamBarrier)) return null;
  const rows = childRows(prefix, rel, framing.elem, labels, ctx, fresh);
  if (!rows) return null;
  const window = perOriginSlice ? partitionedSlice(rows.rel, rows.origin, sliceOf(last), fresh) : rows.rel;
  // DROP origin — flatMap flattens, so the host a row descended from is internal and must not ride into
  // a downstream whole-row `dedup`/merge. Everything else (payload + carried channels) rides through.
  const channels = window.channels.filter((channel) => channel.role !== 'origin');
  const cols = window.type.cols.filter((column) => column.name !== rows.origin);
  const shed = make.project({
    id: fresh('fx'), input: window, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(window.id, column.name)] as const),
  });
  return continueAs(shed, rows.framing, steps, at + 1, bulked, ctx, fresh, labels);
}

/**
 * A PER-ORIGIN SLICE — `local(__.out().limit(n))`'s "n per HOST", a `row_number` window PARTITIONED by
 * the `origin` channel. `dedupOn`'s shape (window → filter the rank → reproject), which is Calcite's
 * per-partition top-N EXACTLY: `convertDistinctOn`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/SqlToRelConverter.java:1045-1113`)
 * projects `ROW_NUMBER() OVER (PARTITION BY keys ORDER BY collation)`, filters the rank, then projects
 * it away — with `ROW_NUMBER` (positional) NOT `rank`, so a `limit` never keeps ties as extra rows.
 * Calcite's DISTINCT ON filters `rn = 1`; this keeps the rank where `offset < rn ≤ offset+limit`
 * (`limit === null` is the open `skip`/`range(k,-1)` upper bound), the top-N + range generalization.
 * The corpus pins these as *"result should be OF … count N"* — the pick per origin is IMPL-DEFINED —
 * but the order is `encounter` then the whole payload so the choice is DETERMINISTIC and survives
 * `test:perturbed`, one valid member of the accepted set rather than a scan-luck row.
 */
function partitionedSlice(rows: Rel, originCol: string, window: Slice, fresh: Minter): Rel {
  const position = encounterOf(rows.channels);
  const cols = [...payloadCols(rows), ...carriedCols(rows.channels)];
  const RN = 'prn';
  const ranked = make.window({
    id: fresh('pw'), input: rows, channels: rows.channels, type: typeOf(...rows.type.cols, meta(RN, 'int')),
    specs: [[RN, {
      kind: 'window-expr', fn: 'row_number', args: [],
      spec: {
        partitionBy: [col(rows.id, originCol)],
        orderBy: [...(position ? [{ expr: col(rows.id, position.col), dir: 'asc' as const }] : []),
          ...payloadCols(rows).map((column) => ({ expr: col(rows.id, column.name), dir: 'asc' as const }))],
      },
    }]],
  });
  const lower: Expr = { kind: 'binary', op: '>', left: col(ranked.id, RN), right: compilerInt(window.offset) };
  const pred: Expr = window.limit === null ? lower
    : and(lower, { kind: 'binary', op: '<=', left: col(ranked.id, RN), right: compilerInt(window.offset + window.limit) });
  const kept = make.filter({ id: fresh('pf'), input: ranked, channels: ranked.channels, type: ranked.type, pred });
  return make.project({
    id: fresh('pk'), input: kept, channels: rows.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(kept.id, column.name)] as const),
  });
}

/**
 * A CHILD BODY'S ROWS over a host STREAM — the seam's FOURTH answer (`child.ts` states why).
 *
 * The whole mechanism is two lines, and that is the point: MINT the origin channel on the input, then
 * hand the relation to the ordinary fold. A movement carries its input's channels by contract (§3.5),
 * so the origin rides through every hop with no per-step change — which is what the channel core was
 * built for and what makes this a caller rather than a second fold.
 *
 * The origin is the host's ROWID, so an ELEMENT host is the only one served: a value stream has no
 * rowid to name its parent by, and `origin` is typed `int`. That is a real limit rather than a
 * deferral of taste — a scalar-hosted group-scoped reducer needs the role to carry a VALUE, which is a
 * channels-core change.
 */
function childRows(
  body: readonly IRStep[], input: Rel, elem: Elem, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
): ChildRows | null {
  if (!body.length || originOf(input.channels)) return null;
  const channels = withChannel(input.channels, ORIGIN);
  const seeded = make.project({
    id: fresh('og'), input, channels, type: typeOf(...elementCols(channels)),
    // Driven off the MINTED channel list, not the input's plus one: `withChannel` inserts in
    // `ROLE_ORDER` (origin sits before encounter), and an appended expression would declare the columns
    // in a different order from `elementCols` — which the factory catches, and which would otherwise be
    // a schema desync no test names.
    exprs: [['id', col(input.id, 'id')],
      ...channels.map((channel) => [channel.col, channel.role === 'origin' ? col(input.id, 'id') : col(input.id, channel.col)] as const)],
  });
  // THE HOST'S LABELS RIDE IN, and handing over `NO_ALIASES` was a WRONG ANSWER rather than a
  // narrowing: a body reading one (`by(__.select('p').values('age').sum())`) would find no live label,
  // and since an unresolvable `select()` is now the EMPTY RESULT it would pool ZERO rows and answer an
  // empty map. §6·6's rule with the sharpest witness yet — check what a seam HANDS OVER, because the
  // combination of two correct rules made one of them silently produce the other's answer.
  const tail = continueAs(seeded, { kind: 'elements', elem }, body, 0, false, inBody(ctx), fresh, aliases);
  // A body with EFFECTS is not a read, and one that lost the origin (a barrier inside it) has nothing
  // to group by — both are declines rather than answers that would silently pool the wrong rows.
  if (!tail || tail.effects?.length || !originOf(tail.rel.channels)) return null;
  return { rel: tail.rel, framing: tail.framing, origin: ORIGIN.col };
}

/**
 * A ROOTED chain, lowered — the seam's third answer, POLICY-FREE.
 *
 * The admission rules that used to live here (a vertex stream for an endpoint, a list framing for a
 * set-op operand, no effects for either) belong to the CONSUMERS, and moving them out is what makes
 * this one answer rather than the union of its callers' requirements. What stays is the one thing that
 * is the seam's own: an empty chain has nothing to lower.
 *
 * NO opaque escape node is involved and none is needed: the sub-read is lowered by the SAME fold into
 * the SAME algebra, spliced in as an ordinary relation. If the inner chain is not covered, this
 * declines and the whole traversal is unsupported — the decline contract, one level down.
 */
function rootedRead(steps: readonly IRStep[], ctx: ChainCtx, fresh: Minter): RootedRead | null {
  if (!steps.length) return null;
  const chain = lowerChain(steps, {
    params: ctx.params, collapse: ctx.collapse, correlatedChildren: ctx.correlatedChildren,
    labelRegime: ctx.labelRegime, sideEffects: ctx.sideEffects,
    // The SETTLED values ride into a rooted chain too, and their absence was a silent narrowing: a
    // rooted arm naming a service, a sack or a reducer-form side effect was being handed LESS than
    // the chain around it, so it declined for want of a fact the compile already held. §6·6's
    // lesson at a second seam — coverage must measure what the algebra can express, never what the
    // caller remembered to pass.
    services: ctx.services, sack: ctx.sack, sideEffectPolicies: ctx.sideEffectPolicies, collections: ctx.collections,
  }, fresh);
  if (!chain) return null;
  return chain.effects ? { rel: chain.rel, framing: chain.framing, effects: chain.effects } : { rel: chain.rel, framing: chain.framing };
}

/** A nested ROOTED traversal's steps, normalized — or `null` where normalizing RAISES (a deferral
 *  the compiler will raise for itself). A rooted body goes through `normalize(stepChain(…))` and not
 *  `childSteps`, which strips a source and answers the empty chain, i.e. an endpoint that silently
 *  matched nothing. */
function rootedSteps(nested: unknown, params: Record<string, any>, sideEffects?: Map<string, any>): readonly IRStep[] | null {
  try { return normalize(stepChain(nested, params), params, sideEffects).steps as IRStep[]; } catch { return null; }
}

/**
 * A HOST DESCRIBED AS ITS OWN TRAVERSER — the framing it would have as a relation, and where each of
 * that framing's payload columns lives on it. `null` for a host whose payload is not this convention.
 *
 * It is what a bare `by()` inside a correlated `project()` needs: `byField`'s identity arm answers
 * "the traverser unchanged" by reading the host framing's own columns, which is exactly why that arm
 * is total over every host at once. In a relation those columns are `col(rel, name)`; here the host
 * IS the columns, so this is the same lookup with the relation removed.
 *
 * A PROPERTY answers with its own framing and no readable columns, which is the honest pair: it HAS a
 * framing, and `framingCols` declines a property outright — the payload is a six-column tuple rather
 * than the one-or-two-column convention — so `byField`'s identity arm declines exactly there while
 * every other slot of the same `project()` still works. Only a RECORD with no row declines outright,
 * because its columns live on a row it does not have.
 */
function hostSelf(host: ChildHost): { readonly framing: RelFraming; readonly col: (name: string) => Expr } | null {
  if (host.kind === 'element')
    return { framing: { kind: 'elements', elem: host.elem }, col: (name) => (name === 'id' ? host.id : compilerNull()) };
  if (host.kind === 'scalar') {
    const vtype = host.vtype;
    return {
      framing: { kind: 'scalar', type: vtype ? PER_ROW('vtype') : UNKNOWN },
      col: (name) => (name === 'v' ? host.value : name === 'vtype' && vtype ? vtype : compilerNull()),
    };
  }
  // A RECORD host's own columns live on the row it rides, which is the one place a nested record's
  // prefixed payload can be read from. Without a row there is nothing to read and the identity arm
  // declines rather than projecting nulls.
  if (host.kind === 'record') {
    const row = host.row;
    return row ? { framing: { kind: 'record', fields: host.fields }, col: (name) => col(row.rel.id, name) } : null;
  }
  // A LIST host's identity `by()` is the whole collection — the `list` framing over the host's own list
  // value, so `project('ks').by()` where the traverser is a list projects it unchanged, exactly as the
  // element/scalar identity arms project theirs.
  if (host.kind === 'list')
    return { framing: { kind: 'list', of: host.of }, col: (name) => (name === LIST_COL ? host.list : compilerNull()) };
  return { framing: { kind: 'property', ownerElem: host.ownerElem }, col: () => compilerNull() };
}

/**
 * A step that turns the host traverser into EXACTLY ONE other traverser, as the new host — or `null`
 * where the step is not one of those.
 *
 * The membership rule is CARDINALITY and it is the schema's, not a taste: `edges.src`/`edges.tgt` are
 * non-null columns, so an edge has exactly one head and one tail; a property row's owner column is
 * non-null, so a property belongs to exactly one element. `bothV()` is deliberately absent — it yields
 * TWO traversers, which is a movement and belongs to the fan-out arm that reduces.
 *
 * The ROW rides through unchanged: re-rooting changes what the traverser IS, never which row of the
 * outer relation the body is correlated to, so a label bound on that row stays readable (`Scoping`
 * puts the path labels in the same slot either way).
 */
function rerootedHost(step: IRStep, host: ChildHost, fresh: Minter): Extract<ChildHost, { kind: 'element' }> | null {
  if (step.modulators?.length || step.optionArms || argValues(step).length) return null;
  const row = host.row ? { row: host.row } : {};
  if (host.kind === 'element' && host.elem === 'edge') {
    const end = step.name === 'outV' ? 'src' : step.name === 'inV' ? 'tgt' : null;
    return end && { kind: 'element', id: edgeEndpoint(host.id, end, fresh), elem: 'vertex', ...row };
  }
  if (host.kind === 'property' && step.name === 'element')
    return { kind: 'element', id: propertyReadOf(host.id, host.ownerElem, 'owner', fresh), elem: host.ownerElem, ...row };
  return null;
}

/**
 * A nested body as a VALUE expression PLUS what that value is — the seam's correlated-SCALAR answer.
 * Collection, selection and branching still decline for later arms.
 *
 * The FRAMING is tracked alongside the expression rather than derived afterwards, because only here is
 * it known: `countTail`'s own framing says `long`, `transformExpr` reports the cast subfamily's target
 * type, and a bare `label()` is a string. Recomputing any of that from the finished `Expr` is
 * impossible — which is exactly why the value used to reach the wire untagged (§6·7).
 */
/**
 * A REDUCER OVER A CORRELATED BODY, rooted at `root` — `by(__.inE('created').values('weight').sum())`
 * and `by(__.values('age').max())` are the SAME lowering rooted differently (a movement hop, or a
 * one-row SELF relation). The body from `from` is the ordinary fold against `root`; EVERY path returns
 * (a `ChildValue` or `null`), so a caller either takes it or declines.
 */
function correlatedReduce(
  root: Rel, rootElem: Elem, body: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
): ChildValue | null {
  // A TRAILING min/max is an ARGMAX, which the global reducer lowers as a window+materialize a
  // correlated subquery cannot host — a fence forces a named CTE that cannot reference the outer row,
  // so the numeric arm below declines it. The correlated pick is the SAME element as a `sort`+`limit(1)`
  // over the SAME single-type-space order (`minMaxOrder`, shared with the global barrier so the two
  // cannot drift), and the winner's own vtype is `minMaxWinnerVt`. Productivity for min/max is NOT the
  // value's nullness — ZERO rows emit NOTHING, an all-NULL input emits ONE null (`ReducingBarrierStep`)
  // — so a per-host EXISTS over the value rows is the `present` signal.
  const last = body.at(-1);
  if (last && (last.name === 'min' || last.name === 'max') && !argValues(last).length && !isLocalScope(last) && body.length >= 2) {
    const values = continueAs(root, { kind: 'elements', elem: rootElem }, body.slice(0, -1), from, false, inBody(ctx), fresh, NO_ALIASES);
    let fenced = false;
    if (values) forEachRel(values.rel, (rel) => { if (rel.kind === 'materialize') fenced = true; });
    const probeCol = values?.rel.type.cols[0];
    if (values && !fenced && probeCol && values.framing.kind === 'scalar' && values.framing.result === undefined) {
      const ordered = make.sort({ id: fresh('ms'), input: values.rel, channels: values.rel.channels, type: values.rel.type, terms: minMaxOrder(values.rel, values.framing, last.name === 'min') });
      const winner = make.limit({ id: fresh('ml'), input: ordered, channels: ordered.channels, type: ordered.type, count: compilerInt(1) });
      const vExpr = make.project({ id: fresh('mv'), input: winner, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', col(winner.id, 'v')]] });
      const vtExpr = make.project({ id: fresh('mt'), input: winner, channels: [], type: typeOf(meta('vt', 'text', true)), exprs: [['vt', minMaxWinnerVt(winner, values.framing)]] });
      const probe = make.project({ id: fresh('mp'), input: values.rel, channels: [], type: typeOf(meta('one', 'any', true)), exprs: [['one', col(values.rel.id, probeCol.name)]] });
      return {
        expr: { kind: 'scalar', plan: vExpr },
        framing: { kind: 'scalar', type: UNKNOWN, result: 'number' },
        vtype: { kind: 'scalar', plan: vtExpr },
        present: { kind: 'exists', plan: probe, negated: false },
        yields: 'one',
      };
    }
  }
  const tail = continueAs(root, { kind: 'elements', elem: rootElem }, body, from, false, inBody(ctx), fresh, NO_ALIASES);
  // …AND THE RELATION MUST ACTUALLY HAVE COLLAPSED, which the framing marker does NOT say. `result` is a
  // TYPE fact, not a CARDINALITY one: `__.out().local(__.in().count())` is one count PER OUT-VERTEX, so a
  // non-collapsed subquery has as many rows as the fan-out and SQLite silently takes the first
  // (measured: `[1,3,3,null,null,null]` where the reference gives `[1,1,1,3,3,3]`).
  if (!tail || !collapsedToOneRow(tail.rel)) return null;
  // A fence anywhere below is also a decline: this plan is correlated to the outer row, and a
  // Materialize forces a named CTE that cannot reference it.
  let materialized = false;
  forEachRel(tail.rel, (rel) => { if (rel.kind === 'materialize') materialized = true; });
  if (materialized) return null;
  // A PER-ORIGIN FOLD — the correlated body reduced to ONE list. `foldScalars`/`foldElements` COALESCE
  // an empty fold to `[]` (FoldStep's `ArrayListSupplier` seed), so a sink host emits `[]` with no
  // per-origin seed machinery; the fold IS the collapse `collapsedToOneRow` requires, and it is ALWAYS
  // productive (it seeds).
  if (tail.framing.kind === 'list') {
    const list = make.project({
      id: fresh('bl'), input: tail.rel, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      exprs: [[LIST_COL, col(tail.rel.id, LIST_COL)]],
    });
    return { expr: { kind: 'scalar', plan: list }, framing: tail.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
  }
  if (tail.framing.kind !== 'scalar' || (tail.framing.result !== 'count' && tail.framing.result !== 'number')) return null;
  // `count()` and the numeric reducers differ only in empty-input productivity: `CountGlobalStep` seeds
  // 0 (COALESCEd, ALWAYS productive), while `SumGlobalStep` leaves SQL's NULL alone and the by()
  // productivity filters drop it. A NUMERIC reducer carries its result's TYPE in `vt` — the winner's own
  // Gremlin vtype (min/max) or the SQLite storage class (sum/mean) — exposed as `vtype` so a consumer
  // that projects a second column (a record field, a collection member) lands it beside the value and
  // `by(sum())` composes exactly as `by(count())` does; a map side that carries one expression ignores
  // it.
  const scalarOf = (column: string): Rel => make.project({
    id: fresh('bc'), input: tail.rel, channels: [], type: typeOf(meta(column, 'any', true)),
    exprs: [[column, col(tail.rel.id, column)]],
  });
  const scalar = scalarOf('v');
  if (tail.framing.result === 'count')
    return { expr: { kind: 'scalar', plan: scalar }, framing: tail.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
  return {
    expr: { kind: 'scalar', plan: scalar },
    framing: tail.framing, vtype: { kind: 'scalar', plan: scalarOf('vt') }, yields: 'one',
  };
}

/**
 * Does a body ending in this step collapse to ONE value per host, so a `by()` arm may root it at the
 * host itself rather than take a first value?
 *
 * The numeric reducers and `count` were the original members. **`fold` belongs with them and its absence
 * was a reachability gap, not a decision**: `correlatedReduce` has had a per-origin FOLD arm all along
 * (`tail.framing.kind === 'list'` → one list per host, `COALESCE`d to `[]` for FoldStep's
 * `ArrayListSupplier` seed), and nothing could reach it from the self root because this gate named only
 * the reducers. So `by(__.out().fold())` worked (movement-rooted) while `by(__.values(k).fold())` — a
 * multi-valued property collected into a list, one of the most ordinary shapes in Gremlin — declined, as
 * did `by(__.labels().fold())` and `by(__.properties(k).fold())`.
 *
 * Deliberately LOCAL rather than a widening of `COLLAPSING_BARRIERS` (`ir/step.ts`), which is the same
 * question asked for a different purpose: that set also feeds `BATCHED_BARRIERS` and `repeat()`'s
 * body-barrier reasoning, where `fold`'s membership is a separate claim with its own blast radius. Two
 * consumers, two authorities, on purpose.
 */
const selfCollapses = (name: string): boolean => isReducer(name) || name === 'count' || name === 'fold';

/**
 * A body rooted at the HOST ITSELF — a one-row `Values` multiplier projected as the host id, handed to
 * `correlatedReduce` from step 0.
 *
 * The `Values`-then-`project` shape is `addV`/`mergeV`'s, so the host id rides in a NAMED column the join
 * reads by name rather than in a `Values` row whose columns are positional. Extracted because the branch
 * arm and the collapsing-barrier arm built it identically — two copies of a source shape is two chances
 * to disagree about what a self root IS.
 */
function selfRootedReduce(body: readonly IRStep[], host: Extract<ChildHost, { kind: 'element' }>, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const unit = make.values({ id: fresh('u'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  const selfRow = make.project({ id: fresh('slf'), input: unit, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', host.id]] });
  return correlatedReduce(selfRow, host.elem, body, 0, ctx, fresh);
}

function scalarChild(body: readonly IRStep[], host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (!body.length) return null;
  const first = body[0]!;

  // A GraphStep inside a per-traverser child still splits each host traverser, but a reducing tail
  // has one answer independent of which host triggered it. Lower that source chain once as an
  // ordinary rooted read and embed its one-row result as the correlated scalar value. This is the
  // `map(__.V().count())` half of re-sourcing; fan-out `flatMap(__.V()…)` needs the general child
  // rejoin and remains that substrate's responsibility rather than abusing a scalar subquery's
  // arbitrary-first-row behaviour.
  if (first.name === 'V' || first.name === 'E') {
    const rooted = rootedRead(body, ctx, fresh);
    if (!rooted || rooted.effects || rooted.framing.kind !== 'scalar' || rooted.framing.result !== 'count'
      || !collapsedToOneRow(rooted.rel)) return null;
    const scalar = make.project({
      id: fresh('rc'), input: rooted.rel, channels: [], type: typeOf(meta('v', 'any', true)),
      exprs: [['v', col(rooted.rel.id, 'v')]],
    });
    return { expr: { kind: 'scalar', plan: scalar }, framing: rooted.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
  }

  // THE RECORD ARM — `by(__.project('a','b')…)`, one traverser in and one MAP out.
  //
  // `project()` is a `ScalarMapStep`, so it is a correlated single value exactly as `values(k)` is; the
  // only difference is that the value is a map rather than a scalar, which the framing SAYS. It is the
  // whole body or nothing: a chain past it (`__.project('a').select('a')`) re-roots to a field's own
  // stream, which is the RECORD relation's business and not a correlated read's.
  if (first.name === 'project' && body.length === 1) {
    const self = hostSelf(host);
    const node = self && recordNode(first, host, self.framing, self.col, childSeam(ctx, fresh), fresh);
    // `project()` is a `ScalarMapStep` — one map per traverser, never several.
    return node && { expr: node, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } }, yields: 'one' };
  }

  // THE RE-ROOTING ARM — a step that turns this traverser into exactly ONE other traverser, so the
  // body CONTINUES against a different host rather than producing a relation.
  //
  // It is what makes `by(__.outV().values('name'))` and `by(__.element().values('name'))` correlated
  // values at all: the generic movement arm below must refuse a non-reducing tail, because a hop that
  // can fan out would leave SQLite silently taking a row. An endpoint read and a property's owner
  // cannot fan out — the schema says so — so they are not movements to be admitted more loosely, they
  // are a change of subject.
  const rerooted = rerootedHost(first, host, fresh);
  if (rerooted) {
    // The body ENDS at the re-rooting (`by(__.outV())`) — the value is the new traverser itself, which
    // is an ELEMENT and a shape `ChildValue` already carries. A `by()` consumer that can only use a
    // scalar narrows it; one that can frame a member (`byNode`) makes it an element node.
    // ONE by the schema — that is `rerootedHost`'s whole membership rule — so a consumer that emits
    // every result may take this expression, not only one that takes the first.
    if (body.length === 1) return { expr: rerooted.id, framing: { kind: 'elements', elem: rerooted.elem }, present: ALWAYS_PRODUCTIVE, yields: 'one' };
    return scalarChild(body.slice(1), rerooted, ctx, fresh);
  }

  // A PROPERTY host's three projections are STEPS, and two of them read the stored row. `element()` is
  // the third and re-roots above, which is why it is not here.
  if (host.kind === 'property') {
    // A property's KEY is always present and always a string; its VALUE carries the stored `vtype` per
    // row, which is `propertyValue`'s channel read through a rowid instead of through the join.
    if (first.name === 'key' && !argValues(first).length)
      return valueRun(body, 1, { value: propertyReadOf(host.id, host.ownerElem, 'key', fresh), type: STATIC('string'), vtype: undefined, present: ALWAYS_PRODUCTIVE, yields: 'one' }, host.row, childSeam(ctx, fresh), fresh);
    if (first.name === 'value' && !argValues(first).length)
      return valueRun(body, 1, {
        value: propertyReadOf(host.id, host.ownerElem, 'value', fresh), type: UNKNOWN,
        vtype: propertyReadOf(host.id, host.ownerElem, 'vtype', fresh), present: ALWAYS_PRODUCTIVE,
        // A property traverser IS one property, so its key and its value are each exactly one.
        yields: 'one',
      }, host.row, childSeam(ctx, fresh), fresh);
    return null;
  }

  // A SCALAR host names its own subject: the traverser IS the value, so a transform-only body
  // (`by(__.math('_ * 10'))`, `by(dateAdd(DT.day, 1))`) is well-formed rather than the nonsense it
  // would be over an element. That is the "A BODY MUST NAME ITS SUBJECT" guard below read the other
  // way round — the guard exists because an element is not a value, and here there is one.
  if (host.kind === 'scalar') return scalarHostChild(body, host, childSeam(ctx, fresh), fresh);
  if (host.kind === 'list') return listHostChild(body, host, ctx, fresh);
  if (host.kind !== 'element') return null;

  // A REDUCER OVER A CORRELATED BODY, rooted TWO ways through ONE engine (`correlatedReduce`): a
  // MOVEMENT hop (`by(__.inE('created').values('weight').sum())`) roots the fold at the adjacency, and a
  // value chain over the HOST ITSELF (`by(__.values('age').max())`) roots it at a one-row SELF relation.
  // A movement is not required — what is required is that the body END in a reducer; a bare
  // `__.count()`/`__.values(k)` with no reduction falls through to the expression arm below.
  const child = movement(body[0]!, { correlated: host.id }, host.elem, fresh);
  if (child) return correlatedReduce(child.rel, child.elem, body, 1, ctx, fresh);
  // A BRANCH-headed body (`by(__.union(a,b)….fold())`) — the union fans the host out over its arms, then
  // the tail reduces. `continueAs` already lowers a `union`/`choose`/`coalesce` over an INPUT relation
  // (the chain-position branch), so rooting it at the one-row SELF relation carrying the host id and
  // handing the WHOLE body (from 0) to `correlatedReduce` composes it with the per-origin fold that
  // arm already builds — no branch-in-by special case, just the self-root the numeric self-reducer above
  // uses one hop later. This is what lets an emit-unrolled recurse (`union` of level-prefixes) sit inside
  // a `project().by()`, the shape a GraphQL `@recurse` field lowers to.
  if (BRANCH_HOSTS.has(body[0]!.name)) {
    const reduced = selfRootedReduce(body, host, ctx, fresh);
    if (reduced) return reduced;
  }
  // The SELF root: no leading hop, so the barrier aggregates/argmaxes/COLLECTS the host's OWN rows
  // exactly as it does an adjacency's — a `values(k)`/`labels()` join against a one-row relation carrying
  // the host id. Only when the body actually ENDS in a collapsing barrier; a plain `by(__.values(k))`
  // stays the expression arm below, which takes the FIRST value (a different cardinality,
  // `yields: 'first'`), and that is the whole job of this gate.
  const terminal = body.at(-1);
  if (body.length >= 2 && terminal && selfCollapses(terminal.name)) {
    const reduced = selfRootedReduce(body, host, ctx, fresh);
    if (reduced) return reduced;
  }

  let value: Expr = host.id;
  // WHETHER THIS BODY PRODUCES anything for the host row, where the leading step can say precisely.
  // `undefined` is "cannot say", which is not the same as "always" — see `ChildValue.present`.
  let present: Expr | undefined;
  // The value's type as the body computes it, not as the wire guesses it. `UNKNOWN` is the honest seed:
  // until a step below NAMES the projection, nothing has been read yet.
  let type: ScalarType = UNKNOWN;
  // A STORED value's type rides per row, and only a consumer that can project a second column can use
  // it — so the expression travels beside the value and the framing says which.
  let vtype: Expr | undefined;
  // HOW MANY the body had to give — see `ChildValue.yields`. Every leading step below names exactly
  // one value except a property read, which picks the first of a possibly multi-valued key.
  let yields: ChildValue['yields'] = 'one';
  let at = 0;
  const leading = body[0];
  if (leading?.name === 'values') {
    const args = argValues(leading);
    if (args.length !== 1 || typeof args[0] !== 'string') return null;
    const projected = byExpr({ key: { kind: 'property', key: args[0] } }, host, fresh);
    if (!projected) return null;
    value = projected;
    vtype = propertyVtype(args[0], host, fresh);
    // A property read is the one leading step whose productivity is EXACTLY decidable and not the
    // same question as its value's nullness: the property row either exists or it does not.
    present = propertyExists(args[0], host, fresh);
    // …and the one that may have had MORE to give: a vertex key is multi-valued and `byExpr` takes
    // the insertion-order first, which is `map()`'s answer and not `local()`/`flatMap()`'s.
    yields = 'first';
    at = 1;
  } else if (leading?.name === 'call') {
    // A `streaming` SERVICE is a value projection like any other, so it leads a body exactly as
    // `values(k)` does — which is what makes `where(__.call(dc).is(3))` and `group().by(__.call(dc))`
    // fall out of the seam rather than needing a call-aware reader at each host. The service is
    // handed THIS host, so a call inside a by() inside a call composes by construction.
    const produced = serviceValue(leading, host, ctx, fresh);
    if (!produced) return null;
    value = produced.expr;
    if (produced.framing.kind === 'scalar') type = produced.framing.type;
    // THE SERVICE'S OWN CLAIM rides out — it built the expression, so only it knows whether the
    // contribution was one value or the first of several.
    yields = produced.yields;
    at = 1;
  } else if (leading?.name === 'label' || leading?.name === 'id') {
    if ((leading.args ?? []).length) return null;
    // A `T` token is ALWAYS present — every element has a label and an id — and saying so is a CLAIM
    // rather than the silence `undefined` means.
    present = ALWAYS_PRODUCTIVE;
    const projected = byExpr({ key: { kind: 'token', token: leading.name } }, host, fresh);
    if (!projected) return null;
    value = projected;
    // A LABEL is always a string; an external `id` is whatever `COALESCE(uid, id)` yields, so it stays
    // unknown and the framer infers — the same split `byNode`'s token arm makes.
    if (leading.name === 'label') type = STATIC('string');
    at = 1;
  } else if (REL_PROJECTORS.has(leading?.name ?? '')) {
    // `by(__.math('a + b').by('age'))`, `by(__.format('%{name}'))` — a projector body NAMES ITS
    // SUBJECT through its own variables, so it leads a body exactly as `values(k)` and `call(…)` do.
    // Its `_` is this host, which is why it needs no arm of its own here and why the whole
    // by()-child matrix gains both at once.
    const projected = projectorValue(leading!, host, childSeam(ctx, fresh), fresh);
    if (!projected) return null;
    value = projected.value;
    type = projected.framing.kind === 'scalar' ? projected.framing.type : UNKNOWN;
    at = 1;
  } else if (CARRIED_READ[leading?.name ?? ''] !== undefined && !(leading!.args ?? []).length) {
    // A PER-TRAVERSER STATE READ — `sack()`, `loops()` — and it is ONE arm over a channel ROLE rather
    // than a reader per step, because that is what the state IS: a column of the row the host rides
    // on. TinkerPop reaches it by splitting the whole traverser into the child
    // (`TraversalUtil.prepare`), so these are ordinary `ScalarMapStep`s over `traverser.sack()` /
    // `traverser.loops()`; Calcite reaches the same place through the correlating row
    // (`RexCorrelVariable`). Both say the child references the PARENT ROW, which `host.row` is.
    //
    // Zero-arg only. `sack(Operator.x)` is a MUTATION and not a read, and `loops("a")` names a loop
    // this route does not model — a named `repeat` declines in `walk.ts` before reaching here.
    const carried = host.row?.rel.channels.find((channel) => channel.role === CARRIED_READ[leading!.name]);
    // The state is not carried HERE — `sack()` with no `withSack()`, `loops()` outside a walk. The
    // reference raises for both; declining hands the whole traversal to a route that can say so.
    if (!carried) return null;
    value = col(host.row!.rel.id, carried.col);
    // Live on every row of a relation that carries the channel at all, which is what makes this a
    // CLAIM rather than the silence `undefined` means.
    present = ALWAYS_PRODUCTIVE;
    // `loops()` is an int by construction (`CHANNEL_COL`); a sack holds whatever its seed was.
    if (carried.role === 'loops') type = STATIC('int');
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
    present = ALWAYS_PRODUCTIVE;
    at = 1;
  }

  // A BODY MUST NAME ITS SUBJECT, and this guard is the difference between declining and answering
  // nonsense. Without it a transform-only body falls through with `value` still the element's ROWID, so
  // `order().by(__.toUpper())` lowers to `upper(<rowid>)` — a plausible-looking answer to a traversal
  // TinkerPop REJECTS (`The toUpper() step can only take string as argument`), which is the worst
  // direction the "never answer a different question" rule has. A transform needs a value in front of
  // it; an element is not one. Measured on this very increment, so it is a guard with a witness.
  if (at === 0) return null;

  return valueRun(body, at, { value, type, vtype, present, yields }, host.row, childSeam(ctx, fresh), fresh);
}

/**
 * THE VALUE RUN — a child body's tail once its SUBJECT is named: a sequence of steps that each turn
 * one value into another.
 *
 * Both child arms end here because past the leading step they ask an identical question, and the two
 * copies had already begun to differ in what they carried. It is also where a shape composes: a
 * PROJECTOR mid-run reads the value the run has reached, so `by(__.values('age').math('_ * 2'))` is
 * the same lowering as the chain form and needs no by()-specific arm.
 *
 * `type` and `vtype` follow the same rule for every member: a step that RETYPES says so
 * (`asNumber`/`asDate`/`dateAdd`/`dateDiff`, and the projectors, always a Double / a String); one that does not
 * CLEARS the tag rather than letting the incoming one ride through, since keeping a stale tag is worse
 * than claiming none (`asDate().asString()` would frame text as a Date). The STORED per-row carrier
 * stops at the first step whatever it claims for itself — it describes the value as READ, and every
 * member of this run produces a new one.
 */
function valueRun(
  body: readonly IRStep[], from: number,
  seed: { readonly value: Expr; readonly type: ScalarType; readonly vtype: Expr | undefined; readonly present?: Expr; readonly yields: ChildValue['yields'] },
  row: HostRow | undefined, child: ChildSeam, fresh: Minter,
): ChildValue | null {
  let value = seed.value;
  let type = seed.type;
  let vtype = seed.vtype;
  // A value TRANSFORM does not change WHETHER the body produced — `toUpper()` of nothing is still
  // nothing — so the leading step's answer rides through the whole run unchanged.
  const present = seed.present;
  for (let at = from; at < body.length; at++) {
    const step = body[at]!;
    if (REL_PROJECTORS.has(step.name)) {
      const host: ChildHost = { kind: 'scalar', value, ...(vtype ? { vtype } : {}), ...(row ? { row } : {}) };
      const projected = projectorValue(step, host, child, fresh);
      if (!projected) return null;
      value = projected.value;
      type = projected.framing.kind === 'scalar' ? projected.framing.type : UNKNOWN;
      vtype = undefined;
      continue;
    }
    if (!REL_TRANSFORMS.has(step.name)) return null;
    const transformed = transformExpr(step, value, false, fresh);
    if (!transformed) return null;
    value = transformed.expr;
    type = transformed.type ?? UNKNOWN;
    vtype = undefined;
  }
  const produced = present ? { present } : {};
  // A TRANSFORM RUN PRESERVES CARDINALITY — one value in, one value out at every member — so the
  // seed's claim rides to the end unchanged. What decided it is the LEADING step: `values(k)` picks
  // the first of a possibly multi-valued property, everything else names exactly one.
  return vtype
    ? { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, yields: seed.yields, ...produced }
    : { expr: value, framing: { kind: 'scalar', type }, yields: seed.yields, ...produced };
}

/**
 * A child body over a SCALAR host — the transform run applied to the traverser's own value.
 *
 * Split from the element arm because almost nothing is shared: there is no movement to correlate, no
 * property to read and no token to project, so what is left is the value plus whatever the body does
 * to it. `constant()` is the one leading step that REPLACES the value rather than transforming it,
 * and it is the same fold the element arm uses.
 */
function scalarHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }>, child: ChildSeam, fresh: Minter,
): ChildValue | null {
  let value: Expr = host.value;
  let type: ScalarType = UNKNOWN;
  let vtype = host.vtype;
  let at = 0;
  const leading = body[0];
  if (leading?.name === 'constant') {
    const args = argValues(leading);
    // Productivity is EMISSION, not NULLNESS — the element arm's own citation. A deliberate
    // `constant(null)` declines there and declines here for the identical reason.
    if (args.length !== 1 || args[0] === null) return null;
    const literal = constLit(leading.args[0]);
    if (!literal) return null;
    value = literal;
    vtype = undefined;
    at = 1;
  } else if (leading?.name === 'identity') {
    if (argValues(leading).length) return null;
    at = 1;
  }
  // THE TRAVERSER IS THE VALUE, so a scalar host's body has exactly one to give — `constant()`
  // replaces it and every transform maps it, neither of which can produce a second.
  return valueRun(body, at, { value, type, vtype, yields: 'one' }, host.row, child, fresh);
}

/**
 * A `by()` BODY over a LIST host — `select(Pop.all).by(__.unfold().values('name').fold())`.
 *
 * The traverser is a collection, so a body over it opens by CONSUMING the collection. `unfold()` is the
 * one such opener: it explodes the host's list value into a correlated member relation
 * (`correlatedListMembers`, `list.ts`), and the rest of the body is then the ordinary correlated body
 * over those members — an ELEMENT-membered list re-enters `correlatedReduce` (the exact engine
 * `by(__.out().values('name').fold())` already uses, rooted at the members instead of an adjacency), so
 * `values('name').fold()` / a trailing reducer compose for free and the empty-list seed rule
 * (`[]`/no-emit) is the one `correlatedReduce` already states.
 *
 * `count(Scope.local)` over the list is the map-size shape and belongs to `mapTail`/`listTail`, not
 * here; other openers and non-element members decline (fail closed) — their correlated re-entry is a
 * later increment.
 */
function listHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'list' }>, ctx: ChainCtx, fresh: Minter,
): ChildValue | null {
  const first = body[0];
  if (!first || first.name !== 'unfold' || argValues(first).length || body.length < 2) return null;
  const members = correlatedListMembers(host.list, host.of, fresh);
  if (!members || !('elem' in members)) return null; // element members only, for now
  // The body after `unfold()` is the ordinary correlated body over the exploded elements — the SAME
  // engine an adjacency-rooted `by()` reducer uses, so a trailing `values(k).fold()` / reducer is free.
  return correlatedReduce(members.rel, members.elem, body, 1, ctx, fresh);
}

function addedVertices(
  input: Rel, steps: readonly IRStep[], at: number, ctx: ChainCtx, fresh: Minter,
): { readonly effects: Effects; readonly at: number } | null {
  let end = at + 1;
  while (end < steps.length && steps[end]!.name === 'property') end++;
  const effects = elementAddV(input, steps[at]!, steps.slice(at + 1, end), ctx.ordered, childSeam(ctx, fresh), fresh);
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
  input: Rel, steps: readonly IRStep[], at: number, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
): { readonly effects: Effects; readonly at: number } | null {
  let options = at + 1;
  while (options < steps.length && steps[options]!.name === 'option') options++;
  let end = options;
  while (end < steps.length && steps[end]!.name === 'property') end++;
  const arms = steps.slice(at + 1, options);
  const tail = steps.slice(options, end);
  const child = childSeam(ctx, fresh);
  const effects = steps[at]!.name === 'mergeE'
    ? elementMergeE(input, steps[at]!, arms, tail, aliases, ctx.ordered, child, fresh)
    : elementMergeV(input, steps[at]!, arms, tail, ctx.ordered, child, fresh);
  return effects && { effects, at: end };
}
