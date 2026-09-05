import { groupableChannels, withChannel, type Channel, type Channels } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, param, type BinaryOp, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { BindBudgetExceeded, DO_BIND_CAP } from '../../rel/check.ts';
import { emit, emitRelational } from '../../rel/emit.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import { indexSeek, semijoin, trigramSeek } from '../../rel/passes/semijoin.ts';
import { render } from '../../sql/kernel/q.ts';
import { plan as program, type Binding, type Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta, SortTerm } from '../../rel/types.ts';
import { assertsGType, collectionAssert, EDGE_MOVES, isLocalScope, PATH_LIST_OPS, typeOfAssert } from '../ir/step.ts';
import { bulkObservedFrom } from '../ir/bulk.ts';
import { memberTypeOf, PER_ROW, perRowColumnOf, STATIC, staticTypeOf, UNKNOWN, type ListOf, type MapOf, type ScalarType, type Shape, type ValueType } from '../../sql/kernel/render.ts';
import type { Elem } from '../elem.ts';
import { fieldNamed, type FramedRel, type RecordField, type RelFraming } from './framing.ts';
import { recordField, recordOf, recordPayload, recordToMap, selectKeys } from './record.ts';
import { applyLeg, classifyWhereLeg, lowerMatch } from './match.ts';
import { propertyAsString, propertyElement, propertyHasClause, propertyId, propertyKey, propertyPayload, propertyRowId, propertyValue } from './property.ts';
import { edgeEndpoint } from './element.ts';
import type { RelCallSite, Service } from '../../services/spi/types.ts';
import { parseCallSpec } from '../../services/params/call-params.ts';
import { isColumnArg, isNested, isPred, arg, type Arg, type ArgValue, type MergePolicy } from '../../gremlin/frontend.ts';
import { BigDecimal, Duration, flatType, type FrameNode, type TypeNode, type ValueNode } from '../../gremlin/types.ts';
import { constLit, itemTypeAt } from './const.ts';
import { BY_HOSTS, type IRStep } from '../ir/strategies.ts';
import { analyzeChain, type ChainFacts } from '../ir/analyze.ts';
import { contentDemand } from '../ir/content-demand.ts';
import { CONSTANT, predicateExpr, storedCompareOn, SUBJECT_UNKNOWN, type SubjectType } from './predicate.ts';
import { CoercionDeferral, foldConstantCoercions, injectValueTypes } from '../../gremlin/coerce.ts';
import {
    and, byEncounter, carriedCols, elementCols, eq, jsonEachSet, jsonOf,
    jsonMemberByTypeof, labelSetArgs, meta, minter,
    payloadCols, propertyKeyArgs, renumber, rowNumberWindow,
    typedNode, typeOf, withPayload,
    type Minter
} from './build.ts';
import { aliasIdAt, aliasProjection, aliasValueAt, bindAliases, liveAliases, selectSpec } from './alias.ts';
import type { AliasMap } from '../alias.ts';
import { byExpr, modulations, orderProductivity, productivityFilter, type Modulation } from './modulator.ts';
import { ALWAYS_PRODUCTIVE, type ChildHost, type ChildValue, type Subject } from './child.ts';
import { CONSTANT_FOLDED, REL_TRANSFORMS, transformExpr } from './transform.ts';
import { projectorTail, REL_PROJECTORS } from './projector.ts';
import { isLongSumClass, isReducer, reducerAggregate, sumTower } from './reducer.ts';
import { elementAddE, elementAddLabel, elementAddV, elementDrop, elementDropLabel, elementMergeE, elementMergeV, elementProperty, propertyDrop, propertyWrites, type Effects } from './write.ts';
import { BARE_LIST, collectionRetype, foldElements, foldLists, foldMaps, foldScalars, LIST_COL, LIST_FUNCTIONS, listMemberOp, listPayload, listRetype, listSetOp, NODE_COL, nonIterableTraverser, unfoldList } from './list.ts';
import { ENTRY, elementHost, elementValueMap, entryHost, entrySide, groupBarrier, groupMap, groupRows, mapEntryPayload, mapKey, mapLiteralBlob, mapPayload, MAP_COL, mapRange, mapSelect, mapSide, mapSize, unfoldMap } from './map.ts';
import { FOREIGN_ORD, foreignMapRejoin, foreignMapRelation, foreignRejoin, landForeignRows, landedCols } from './foreign.ts';
import { BaseGraph, type GraphSource } from './source.ts';
import { boundGraph, type MergedGraph } from './boundgraph.ts';
import type { ForeignRow } from '../../api.ts';
import type { PairSpec } from '../../services/spi/types.ts';
import { appendPathLabel, appendValuePosition, PATH_CHANNEL, pathCarried, pathPayload, pathPositions, pathSimpleByPredicate, seedPath } from './path.ts';
import { type LabelRegime } from '../../api.ts';
import { sackMutate, sackOperator, sackRead, seedSack } from './sack.ts';
import { variantPayload } from './variant.ts';
import { collectionOf, groupedKeys, readCollection, readUnfolded, registerCollection, registerGrouping, type Collections } from './collection.ts';
import { repeatWalk } from './walk.ts';
import { shortestPathReconstruct, type ReconstructConfig } from './shortestpath.ts';
import { MUTATING_STEPS } from '../ir/strategies.ts';
import { BULK, ENCOUNTER, GRAPH, NO_ALIASES, encounterOf, type ChainCtx, type Tail } from './lower/chain.ts';
import { HOPS, movement, otherVertex, reSource } from './lower/movement.ts';
import { dedupByLabels, elementRowShape, propertyRowShape, payloadRowShape, rowOp, scalarRowShape, sliceOp, PER_TRAVERSER_HOSTS, ROW_OPS } from './lower/slice.ts';
import { childHostOf, sourceFilter } from './lower/filter.ts';
import { childSeam, foldedListSet, nestedFirstValue, pathSimplePredicate, perTraverserChild, scalarChild } from './lower/reduction.ts';
import { BRANCH_HOSTS, branchArms, mergeArms, sourceUnion, variantTail } from './lower/branch.ts';

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
   * `origin`/`path` and threw), and `RelLowering.aliases` (the alias map had exactly one reader, that bridge).
   */
  readonly shape: Shape;
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

/** The fan-out re-mint: renumber by the incoming position, tie-broken on the element id so rows
 *  that shared one incoming traverser get a deterministic order rather than SQLite's. */
export const remintOrder = (rel: Rel, encounter: Channel, fresh: Minter): Rel => renumber(
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
export const dropEncounter = (rel: Rel, fresh: Minter): Rel => {
  const encounter = encounterOf(rel.channels);
  if (!encounter) return rel;
  const cols = rel.type.cols.filter((column) => column.name !== encounter.col);
  return make.project({
    id: fresh('ue'), input: rel, channels: rel.channels.filter((channel) => channel.role !== 'encounter'),
    type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
  });
};

/** The channel list a positionless merge declares — the input's, minus any emission order (`dropEncounter`). */
export const withoutEncounter = (channels: Channels): Channels =>
  channels.filter((channel) => channel.role !== 'encounter');

/**
 * DROP a carried PATH — a `Project` that forgets the path column and its channel, every other column
 * and the rows untouched.
 *
 * A REDUCING BARRIER (`count`/`fold`/`sum`/`group`/…) consumes its input traversers into ONE new
 * traverser, so no per-traverser path survives it — `CHANNEL_BARRIER_POLICY.path` is `drop`. The path
 * has already done its work by the time a barrier reaches it (a `simplePath()` filtered the stream, a
 * `path()` framed it into a list value); what a barrier must NOT do is DECLINE, which the §6·3 rule did
 * blanketly. This is the barrier half of that rule stated positively: append at a movement, carry at a
 * position-preserving step, DROP at a barrier. A no-op where there is no path to drop.
 */
export const dropPath = (rel: Rel, fresh: Minter): Rel => {
  if (!pathCarried(rel)) return rel;
  const cols = rel.type.cols.filter((column) => column.name !== PATH_CHANNEL.col);
  return make.project({
    id: fresh('dp'), input: rel, channels: rel.channels.filter((channel) => channel.role !== 'path'),
    type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
  });
};

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
export const branchResult = (merged: FramedRel | null, ctx: ChainCtx, fresh: Minter): FramedRel | null =>
  !merged ? null : !ctx.ordered ? merged : ctx.sliced ? null : withFanoutOrder(merged, fresh);

/**
 * THE FAN-OUT SORT KEY, carried past the merge as two `origin` channels (the role the channel core
 * declares for exactly this — `identical` merge so every arm agrees on it structurally, `empty` at a
 * barrier so a batched arm's per-parent key correctly vanishes, `undefined` group). `BORD_PARENT` is
 * the FROZEN parent position: minted from the branch input's `encounter` and riding each arm UNCHANGED
 * through its hops (a hop copies a carried channel to its children — `crossFanout`), so all of one
 * traverser's descendants sort together, which is what makes the merge TRAVERSER-major. `BORD_ARM` is
 * the arm ordinal. `renumber` reads `[BORD_PARENT, BORD_ARM, payload…]` into a fresh `encounter` and the
 * pair is dropped — the SLICE half of §10's fan-out mint (`branch-traverser-major.feature`).
 */
export const BORD_PARENT: Channel = { col: 'bord_p', role: 'origin' };
export const BORD_ARM: Channel = { col: 'bord_a', role: 'origin' };

/** Does a SLICE-demanded branch take the traverser-major lowering here? Only when the input carries no
 *  positional (`origin`) key already: a branch NESTED inside another's sliced arm would freeze a SECOND parent
 *  position, and the reference's stacked order (`branch-traverser-major.feature`'s nested scenario)
 *  needs a KEY STACK this single-level mint does not build — so the inner branch declines cleanly
 *  rather than dup the channel (which throws) or mis-order. */
export const sliceableBranch = (ctx: ChainCtx, input: Rel): boolean =>
  ctx.ordered && ctx.sliced
  // A branch whose input carries NO position has nothing to freeze as the traverser-major key — a
  // global barrier upstream (`g.V().count().as(x).union(…).limit(…)`) dropped the encounter — so the
  // slice declines rather than reference a `bord_p` that was never minted.
  && input.channels.some((channel) => channel.role === 'encounter')
  // No branch parent-position already frozen — a branch NESTED inside another's sliced arm carries the
  // outer `bord_p`, whose stacked order needs a KEY STACK this single-level mint does not build, so it
  // declines cleanly rather than dup the channel (a throw) or mis-order. Checked by COLUMN, not by the
  // (now unified) `origin` role: a fan-out `origin` on the input is a different carrier of the same role
  // and does not block the branch's own freeze.
  && !input.channels.some((channel) => channel.col === BORD_PARENT.col);

/** Freeze the branch input's emission position into an `origin` channel so it survives each arm's
 *  hops as the traverser-major major key. A no-op where the input carries no position (nothing to
 *  freeze — the caller only reaches this under `ctx.ordered`, so the input always has one). */
export const augmentParent = (input: Rel, fresh: Minter): Rel => {
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
export const tagArm = (rel: Rel, k: number, fresh: Minter): Rel => {
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
export const mintTraverserMajor = (arms: readonly Tail[], source: Rel, labels: AliasMap, graph: GraphSource, fresh: Minter): FramedRel | null => {
  const tagged = arms.map((arm, k) => ({ ...arm, rel: tagArm(arm.rel, k, fresh) }));
  const base = withChannel(withoutEncounter(source.channels), BORD_ARM);
  const merged = mergeArms(tagged, base, labels, graph, fresh);
  if (!merged) return null;
  const rel = merged.rel;
  // FAIL CLOSED if an arm dropped the sort key: a BATCHED barrier inside an arm empties `origin`
  // (`CHANNEL_BARRIER_POLICY`), so a `union`/`choose` with a batched arm (already gated by `armBatches`)
  // and a `coalesce`/`optional` arm whose scoped barrier still collapses the key both arrive here
  // without `bord_p`/`bord_a`. Re-minting over a column not in scope is a THROW, not a decline — so
  // this checks rather than assumes (`rel-sweep` caught `union(name.fold, …)` and a count-before-union).
  if (![BORD_PARENT.col, BORD_ARM.col].every((c) => rel.channels.some((channel) => channel.col === c))) return null;
  const kept = rel.channels.filter((channel) => channel.col !== BORD_PARENT.col && channel.col !== BORD_ARM.col);
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

/**
 * A GLOBAL `sum`/`mean` reducer, guarded so it emits over ANY non-empty input and NOTHING over an
 * empty one. `SumGlobalStep`/`MeanGlobalStep` override `processAllStarts` with `if (starts.hasNext())`
 * and their `generateSeedFromStarts` reduces an all-null stream to null
 * (`vendor/tinkerpop/gremlin-core/.../step/map/SumGlobalStep.java` — *"an all null stream will result
 * in null"*), so a non-empty all-null input yields ONE null traverser and only a truly EMPTY input
 * yields nothing. SQL aggregation collapses to one row regardless — a NULL for BOTH cases — so a
 * `count(*)` HAVING guard is what tells them apart: keep the aggregate row iff the stream had a start
 * (`red_n > 0`), and the framing's `productiveNull` carries the surviving null to the wire. `count(*)`
 * (rows, not bulk) is the `starts.hasNext()` test — a bulk-N traverser is still one start.
 *
 * min/max need no guard: their argmax window (above) already yields zero rows for an empty input by
 * construction and one for a non-empty one.
 */
function nonEmptyReducer(input: Rel, aggs: readonly (readonly [string, Expr])[], fresh: Minter): Rel {
  const N = 'red_n';
  const aggregated = make.aggregate({
    id: fresh('red'), input, channels: [],
    type: typeOf(meta('v', 'any', true), meta('vt', 'text', true), meta(N, 'int')),
    groupBy: [], aggs: [...aggs, [N, { kind: 'agg', fn: 'count', args: [] }]],
  });
  return make.filter({
    id: fresh('rn'), input: aggregated, channels: [], type: aggregated.type,
    pred: { kind: 'binary', op: '>', left: col(aggregated.id, N), right: compilerInt(0) },
  });
}

/** `count()` as a RETYPE, shared by every host that has one — the element tail's terminal and the path tail's
 *  own arm, so the two cannot disagree about whether the answer is `SUM(bulk)` or `COUNT(*)` (that question is
 *  `countExpr`'s, and it reads the CHANNEL). A reducing aggregate is a BARRIER: no channel survives it (§3.5),
 *  which is why `channels` is empty rather than trimmed by hand. */
export const countTail = (input: Rel, fresh: Minter): { rel: Rel; framing: RelFraming } => ({
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
/** Project a per-traverser SCALAR — one or more payload columns replacing the value, every channel
 *  riding through untouched — and wrap it in its framing. The row shape every per-row retype into the
 *  scalar vocabulary ends with (`constant`, `label`/`id`, an edge's `labels`, a `call()` value): the
 *  channel carry is `withPayload`'s (so a projection cannot forget one), and this adds the `FramedRel`
 *  wrapper the tail returns. The common case is one `['v', expr]` / `meta('v', …)`; a `vtype`-carrying
 *  value passes both columns. */
function projectScalar(
  input: Rel, exprs: readonly (readonly [string, Expr])[], cols: readonly ColMeta[], framing: RelFraming, fresh: Minter,
): FramedRel {
  return { rel: withPayload(input, exprs, cols, fresh), framing };
}

function constantRetype(input: Rel, step: IRStep, fresh: Minter): FramedRel | null {
  if ((step.args ?? []).length !== 1 || step.modulators?.length || step.optionArms) return null;
  const arg = step.args[0]!;
  // `constant([k:v, …])` — a MAP LITERAL, the per-row twin of `injectMap`. It REPLACES each traverser's
  // value with the same compile-time map (`mapLiteralBlob`, the self-describing pairs blob every map
  // producer shares), so the whole re-enterable map tail (`select(Column.*)`, `select(<key>)`, `unfold`,
  // a slice, `as()`) composes over it. The literal's string keys are the map's STATIC key set (framing
  // `keys`), so a `constant([…]).as(m).select(m).select(k)` resolves like every other aliased map (G4).
  if (arg.value instanceof Map) {
    const blob = mapLiteralBlob(arg.value, arg.type ?? null, arg.name);
    if (!blob) return null;
    const keys = [...(arg.value as Map<unknown, unknown>).keys()];
    if (!keys.every((k): k is string => typeof k === 'string')) return null;
    const rel = make.project({
      id: fresh('cm'), input, channels: input.channels,
      type: typeOf(meta(MAP_COL, 'json', true), ...carriedCols(input.channels)),
      exprs: [[MAP_COL, blob], ...input.channels.map((ch) => [ch.col, col(input.id, ch.col)] as const)],
    });
    return { rel, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' }, keys } };
  }
  // `constant([a, b, …])` — a LIST LITERAL, the per-row twin of `injectList` (the SAME `listLiteralBlob`).
  // It replaces each traverser's value with the compile-time list, so the whole re-enterable list tail
  // (`unfold()`, `count(Scope.local)`, a local slice/reducer, a member predicate, `as()`/`select()`)
  // composes over it — the list analogue of the map arm above, framed `{kind:'list', of: BARE_LIST}`.
  if (Array.isArray(arg.value)) {
    const blob = listLiteralBlob(arg, arg.value);
    if (!blob) return null;
    const rel = make.project({
      id: fresh('cl'), input, channels: input.channels,
      type: typeOf(meta(LIST_COL, 'json', true), ...carriedCols(input.channels)),
      exprs: [[LIST_COL, blob], ...input.channels.map((ch) => [ch.col, col(input.id, ch.col)] as const)],
    });
    return { rel, framing: { kind: 'list', of: BARE_LIST } };
  }
  const literal = constLit(arg);
  const tail = literal ? null : exactTailConst(arg);
  if (!literal && !tail) return null;
  return projectScalar(input, [['v', literal ?? tail!.expr]], [meta('v', 'any', true)],
    { kind: 'scalar', type: tail ? STATIC(tail.tag as never, true) : declaredScalarType(arg) }, fresh);
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
  const args = step.args.map((a) => a.value);

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
    // The property values AND the id/label/endpoint TOKENS both route through `GraphSource` now
    // (`tokenRow`/`endpointRow` read `externalId`/`labelScalar`/`labelArray`/`elementRow`), so
    // `valueMap(true)`/`elementMap()` compose over a bound graph exactly as `valueMap(keys…)` does.
    const needsTokens = step.name === 'elementMap' || tokens;
    const mapped = elementValueMap(input, elem, asked.all ? null : asked.keys,
      needsTokens, ctx.labelRegime, ctx.source, fresh,
      step.name === 'elementMap' ? { flat: true, endpoints: true } : {});
    // The STATIC key set, for `select(k)`'s map-key-vs-alias precedence (framing.ts `keys`). Known only
    // for the explicit-key form: `valueMap()`/`valueMap(true)` (`asked.all`) reads every property, so
    // the set is data-dependent and stays undefined (the ambiguity holds). Token keys (`T.id`/`T.label`)
    // are never string-equal to an alias name, so the string key set is a sound answer to "can this map
    // contain string key k" even when tokens are also present.
    const keys = asked.all ? undefined : (asked.keys as readonly string[]);
    return { rel: mapped.rel, framing: { kind: 'map', keyOf: mapped.keyOf, valOf: mapped.valOf, ...(keys ? { keys } : {}) } };
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
      rel: ctx.source.propertyStream(input, elem, asked.all ? null : asked.keys, fresh),
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
    const projected = byExpr({ key: { kind: 'token', token } }, elementHost(input, elem, aliases), ctx.source, fresh);
    if (!projected) return null;
    return projectScalar(input, [['v', projected]], [meta('v', step.name === 'label' ? 'text' : 'any')],
      { kind: 'scalar', type: step.name === 'label' ? STATIC('string') : UNKNOWN }, fresh);
  }

  // `asString()` over an ELEMENT — the traverser's String rendering, `AsStringGlobalStep`'s
  // `String.valueOf` over a non-scalar object. A vertex renders `v[<id>]` and an edge
  // `e[<id>][<src>-<label>-><tgt>]`, TinkerPop's `StringFactory.vertexString`/`edgeString`
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/StringFactory.java`).
  // Every id is the OUTWARD id (`COALESCE(uid, id)`, `byExpr`'s token arm and `source.externalId` — the
  // same reads `id()`/`by(T.id)`/`outV()` use), so it composes over a bound graph and agrees with the
  // write path. `asString` over a runtime object is where JS/Java renderings may legitimately differ;
  // these are exact. SCALAR asString is `VALUE_TX`'s (`scalarTail`); PROPERTY is `propertyAsString`, and
  // the MAP and LIST renderings are their own arms. Bare `asString()` only — a `Scope` token over a
  // single element is a no-op but declines here until the scoped forms are built.
  if (step.name === 'asString' && (elem === 'vertex' || elem === 'edge') && !args.length) {
    const host = elementHost(input, elem, aliases);
    const id = byExpr({ key: { kind: 'token', token: 'id' } }, host, ctx.source, fresh);
    if (!id) return null;
    const cat = (...parts: Expr[]): Expr => parts.reduce((l, r) => ({ kind: 'binary', op: '||', left: l, right: r }));
    let rendered: Expr;
    if (elem === 'vertex') {
      rendered = cat(compilerText('v['), id, compilerText(']'));
    } else {
      const label = byExpr({ key: { kind: 'token', token: 'label' } }, host, ctx.source, fresh);
      if (!label) return null;
      const endpoint = (end: 'src' | 'tgt'): Expr =>
        ctx.source.externalId('vertex', edgeEndpoint(col(input.id, 'id'), end, fresh), fresh);
      rendered = cat(compilerText('e['), id, compilerText(']['), endpoint('src'),
        compilerText('-'), label, compilerText('->'), endpoint('tgt'), compilerText(']'));
    }
    return projectScalar(input, [['v', rendered]], [meta('v', 'text')], { kind: 'scalar', type: STATIC('string') }, fresh);
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
      const projected = byExpr({ key: { kind: 'token', token: 'label' } }, elementHost(input, elem, aliases), ctx.source, fresh);
      if (!projected) return null;
      return projectScalar(input, [['v', projected]], [meta('v', 'text')], { kind: 'scalar', type: STATIC('string') }, fresh);
    }
    // The physical FAN-OUT (one name row per label, plus its per-element order key `lord`) is the graph
    // SOURCE's; the emission ORDER is this step's to MINT, because it is a STREAM fact. A vertex may carry
    // SEVERAL labels; left unpinned a downstream `fold()` collects them in whatever order the scan chose
    // (reversed under `reverse_unordered_selects` — `mise run test:perturbed`). Pin it canonically by
    // `lord` (the label-dictionary id, base; the JSON-array index, bound) — the SAME order the element
    // payload's `json_group_array(name ORDER BY lid)` and `by(T.label)`'s first-label pick use. Across
    // origins the order is the arriving emission order where the stream has one, else `lord` — total
    // either way, which the `encounter` channel requires.
    const named = ctx.source.labelNames(input, elem, fresh);
    const arriving = encounterOf(input.channels);
    const channels = arriving ? named.channels : withChannel(named.channels, ENCOUNTER);
    return {
      rel: renumber(
        named,
        [{ expr: col(named.id, arriving ? arriving.col : 'lord'), dir: 'asc' }, { expr: col(named.id, 'lord'), dir: 'asc' }],
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

    return {
      rel: ctx.source.propertyValues(input, elem, asked.all ? null : asked.keys, fresh),
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
  // A RESHAPING service (shortestPath → paths) rebuilds the WHOLE stream, not a per-parent value — its
  // `rel` contribution is a `relation` arm handed the incoming element relation via `site.stream`. This
  // is resolved before the per-parent `value` arm because the two are distinct `Service.Type`s and the
  // relation arm consumes an input the value arm never sees. A service's own `buildRel` THROW propagates
  // (§6·5 — fail-closed config the user must see); only a compile-time spec-parse failure declines.
  const reshaped = serviceRelation(step, input, elem, ctx, fresh, aliases);
  if (reshaped) return reshaped;

  const produced = serviceValue(step, elementHost(input, elem, aliases), ctx, fresh);
  if (!produced) return null;
  const { expr, framing, vtype } = produced;
  return projectScalar(input,
    [['v', expr], ...(vtype ? [['vtype', vtype] as const] : [])],
    [meta('v', 'any', true), ...(vtype ? [meta('vtype', 'text', true)] : [])],
    framing, fresh);
}

/**
 * A `rel` service's RELATION contribution at a mid position — a service reshaping the whole element
 * stream (shortestPath). It is handed `site.stream` (the incoming relation, its element kind and the
 * `GraphSource`) plus the child seam, and returns a `FramedRel`.
 *
 * Declines (→ the per-parent `value` arm) when the spec does not parse, the step carries an injection
 * traversal (a federate barrier form), or the contribution is not a `relation`. The service's own
 * `buildRel` throw is NOT caught — that is the user's fail-closed answer.
 */
function serviceRelation(
  step: IRStep, input: Rel, elem: Elem, ctx: ChainCtx, fresh: Minter, aliases: AliasMap,
): FramedRel | null {
  if (step.modulators?.length || step.optionArms) return null;
  let spec: ReturnType<typeof parseCallSpec>;
  try { spec = parseCallSpec(step, ctx.params); } catch { return null; }
  const service = ctx.services.get(spec.serviceName);
  if (!service) return null;
  const site: RelCallSite = {
    params: spec.params, boundParams: ctx.params, federationDepth: 0, fresh,
    host: elementHost(input, elem, aliases), child: childSeam(ctx, fresh),
    stream: { input, elem, source: ctx.source },
  };
  const contribution = service.resolve(site);
  if (contribution.kind !== 'rel') return null;
  const contributed = contribution.buildRel(site);
  return contributed && contributed.kind === 'relation' ? { rel: contributed.rel, framing: contributed.framing } : null;
}

/**
 * A `streaming` SERVICE'S per-parent value over one host traverser, or `null` to decline.
 *
 * Split out of `midCall` because a `call()` is not only a chain step: it is a child body
 * (`where(__.call(dc).is(3))`, `group().by(__.call(dc))`), and there the answer wanted is the VALUE
 * rather than a relation carrying it. One function so the two positions cannot come apart — which is
 * the same reason the service is handed the child seam rather than a scope of its own.
 */
export function serviceValue(step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (step.modulators?.length || step.optionArms) return null;
  // A BARRIER call() in a child body (`where(__.call(federate…))`, `group().by(__.call(federate…))`) is
  // not a child VALUE — a barrier is a segment-level async op, driven at the top level, never inside a
  // correlated child. Its spec cannot even resolve here (a federate's nested `traversal` param is not a
  // translatable tree in this position), so `parseCallSpec` THROWS. That is a "not lowerable as a child
  // value" signal, not an incident: catch it and DECLINE (→ a clean `UnsupportedTraversal`) rather than
  // letting a raw `TypeError` escape. The service's OWN throw (`buildRel`, below) is still not caught —
  // §6·5 — because that one the user must see; this catch is only around the compile-time spec parse.
  let spec: ReturnType<typeof parseCallSpec>;
  try { spec = parseCallSpec(step, ctx.params); } catch { return null; }
  // An INJECTION traversal is the federated per-parent value read (`fprops`/`fid`/`flabel` rejoin),
  // which belongs to a `barrier` contribution and not to this arm at all. Declining on its presence
  // keeps the two apart rather than silently ignoring the argument.
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
/** The Scope.local POSITION slices over a MAP entry order — the subset of `LIST_LOCAL_TX` that keeps the
 *  entries in place (a window), NOT `order`/`dedup`, which re-key the map and are a different question. */
const MAP_LOCAL_SLICE = new Set(['limit', 'range', 'skip', 'tail']);

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
    const key = byExpr(modulation, host, ctx.source, fresh, true, childSeam(ctx, fresh));
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
export function orderRows(
  step: IRStep, rel: Rel, host: ChildHost, ctx: ChainCtx, fresh: Minter,
  opts: { readonly tie?: (input: Rel) => readonly Expr[]; readonly natural?: (input: Rel) => readonly Expr[] } = {},
): Rel | null {
  const sort = naturalSort(step, rel, ctx, fresh, opts.natural) ?? sortTerms(step, host, ctx, fresh);
  if (!sort) return null;
  const domain = sort.drop
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: sort.drop })
    : rel;
  const carried = encounterOf(domain.channels);
  const channels = carried ? domain.channels : withChannel(domain.channels, ENCOUNTER);
  // The deterministic tie-break: the carried emission position where there is one (a STABLE re-mint), else
  // the shape's own last resort — an element's id, a scalar's value, a record's whole field tuple. A shape
  // that mints fresh has nothing to be stable against, so a MULTI-column tie is spelled here in full.
  const tie: readonly Expr[] = carried ? [col(domain.id, carried.col)] : (opts.tie?.(domain) ?? []);
  return renumber(
    domain,
    tie.length ? [...sort.terms, ...tie.map((expr) => ({ expr, dir: 'asc' as const }))] : sort.terms,
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
/**
 * The `concat(__.<t>…)` EMPTY-OPERAND guard (§6·5): a binding whose relation holds a row iff some
 * surviving traverser had an operand that produced nothing, so the executor raises `TraversalUtil.apply`'s
 * message rather than let `concat_ws` silently skip the NULL a correlated scalar leaves for an empty read.
 * `presents` are the operands' "did it produce" predicates over `rel`'s columns, so the guard filters
 * `rel` directly (a member's `present` references `rel.id`); `NOT (all produced)` is "some was empty".
 */
function concatEmptyGuard(rel: Rel, presents: readonly Expr[], fresh: Minter): Binding {
  const anyEmpty = presents.map((p) => ({ kind: 'unary', op: 'not', arg: p } as Expr))
    .reduce((left, right) => ({ kind: 'binary', op: 'or', left, right }));
  const offenders = make.filter({ id: fresh('cgf'), input: rel, channels: rel.channels, type: rel.type, pred: anyEmpty });
  const one = make.project({ id: fresh('cgp'), input: offenders, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
  const node = make.limit({ id: fresh('cgl'), input: one, channels: [], type: one.type, count: compilerInt(1) });
  return { name: `${fresh('cg')}`, node, guard: { message: 'The provided traverser does not map to a value', raiseWhen: 'rows' } };
}

/** The outcome of `collectionArm`: `'pass'` — not one of its step names, the caller keeps looking;
 *  `'continue'` — a side-effect step handled, the caller's loop continues with its relation unchanged;
 *  `{tail}` — the step re-rooted the stream, return this. */
type ArmOutcome = { readonly tail: Tail | null } | 'continue' | 'pass';

/**
 * THE COLLECTION-VOCABULARY ARMS BOTH TAILS SHARE — `select`, `group`/`groupCount`, `aggregate`, `cap`,
 * `project` — one lowering at both hosts (§6·6: a shape works wherever it is legal). Each differs
 * between the scalar and element folds ONLY by the `host` it reads a `by()` through and the `framing` it
 * hands the reducer/record, so the caller supplies those two; the element-side path preambles
 * (`dropPath`/decline-on-path) are kept here because they are no-ops over a scalar stream (the scalar
 * loop drops any carried path before these arms). `reenter` is the caller's own fold, for the one arm
 * (`aggregate`'s snapshot) that prepends an effect and continues the SAME tail from `at + 1`.
 */
function collectionArm(
  step: IRStep, rel: Rel, host: ChildHost, framing: RelFraming, bulked: boolean,
  steps: readonly IRStep[], at: number, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  reenter: (at: number) => Tail | null,
): ArmOutcome {
  if (step.name === 'select') {
    // `select` RE-ROOTS to an aliased object — a retype, so a carried path is DROPPED (its work is
    // done: a `simplePath()` filtered the stream) rather than declined. No-op over a scalar stream.
    rel = dropPath(rel, fresh);
    // A `select(name)` whose name is a NAMED COLLECTION resolves to that side effect, NOT a path label:
    // `Scoping.getScopeValue` consults `traverser.getSideEffects()` BEFORE the path
    // (`vendor/tinkerpop/.../step/Scoping.java:119-131`), so the finished collection wins even over an
    // `as(name)`. `SelectStep` then emits the WHOLE collection once per surviving traverser, which is a
    // CROSS join of the stream onto the reduced value — the same shape `foreign.ts` uses for a
    // constant sub-traversal. `count(Scope.local)` over it then counts the map's entries.
    const collectSelect = selectCollection(step, rel, ctx, fresh);
    if (collectSelect !== 'pass')
      return { tail: collectSelect && continueAs(collectSelect.rel, collectSelect.framing, steps, at + 1, false, ctx, fresh, labels) };
    const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), ctx.source, fresh, { framing, named: namedElsewhere(ctx) });
    if (!selected) return { tail: null };
    return { tail: continueAs(selected.rel, selected.framing, steps, at + 1, bulked, ctx, fresh, labels) };
  }

  if (step.name === 'group' || step.name === 'groupCount') {
    // The UNKEYED form is a reducing BARRIER (one map) — drop any carried path. The KEYED form
    // (`group("a")`) is a SIDE EFFECT that passes its traversers on, so a path would have to carry
    // through the member rows — not built, so it declines with a path (fail closed). Both no-ops over a
    // scalar stream, which never carries a path here.
    if (step.args.length) { if (pathCarried(rel)) return { tail: null }; }
    else rel = dropPath(rel, fresh);
    // ONE call for both forms: the barrier's map and the keyed form's member ROWS come out of the same
    // computation, split at `groupRows`/`groupMap` (`map.ts`). The keyed form registers the rows and the
    // reduction happens at the `cap`, which is where a label filled at N positions can be one grouping
    // over the UNION of them.
    const rows = groupRows(rel, host, step, bulked, childSeam(ctx, fresh), ctx.source, fresh);
    if (!rows) return { tail: null };
    // A LABELLED form is a SIDE EFFECT: it fills the named map and passes its traversers on, so the loop
    // CONTINUES and only the unkeyed form becomes the traverser. One rule, two hosts (§6·6).
    if (step.args.length) {
      // ⚠️ A KEYED `group("a")` IN A PROGRAM WITH EFFECTS STILL DECLINES, and the reason narrowed rather
      // than went away. The sites now hold `(key, contribution)` MEMBER rows, which is what Phase 4 said
      // would let them take the aggregate sites' `snapshot` binding — but the KEY column holds a JSONB
      // node, and a retained binding travels as JSON (`src/program.ts`), which fails closed on exactly
      // that. Projecting `json(gk)` at the binding is the remaining step.
      if (ctx.mutating) return { tail: null };
      if (!registerGrouping(step, rows, ctx.collections, ctx.sideEffectPolicies, ctx.source, fresh)) return { tail: null };
      return 'continue';
    }
    const grouped = rows.done ?? groupMap(rows.rel, rows.recipe, ctx.source, fresh);
    return { tail: continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, at + 1, false, ctx, fresh, NO_ALIASES) };
  }

  if (step.name === 'aggregate') {
    // `aggregate("a")` — fill a NAMED COLLECTION and pass the traversers through. Shape-preserving.
    // A carried path declines (the member rows would have to carry it — not built); no-op over a scalar.
    if (pathCarried(rel)) return { tail: null };
    const snapshot = registerCollection(step, rel, host, framing,
      ctx.collections, ctx.sideEffectPolicies, childSeam(ctx, fresh), ctx.source, fresh, ctx.mutating);
    if (!snapshot) return { tail: null };
    // A SNAPSHOT IS AN EXECUTION STEP, so it enters the effect sequence HERE — before whatever the rest
    // of the chain writes, which is the whole point of taking it. The recursion returns the tail from
    // after this position, in the caller's OWN fold.
    if (snapshot.length) {
      const tail = reenter(at + 1);
      return { tail: tail && { ...tail, effects: [...snapshot, ...(tail.effects ?? [])] } };
    }
    return 'continue';
  }

  if (step.name === 'cap') {
    // CONSUMER-DRIVEN FOLD: the reduction a `cap` performs is chosen by what CONSUMES it, not fixed at
    // the read. `cap("a").select(Column.keys)` over an element-keyed grouping wants the key SIDE, so it
    // projects the DISTINCT key rowids straight off the member rows — a set that MOVES natively — instead
    // of folding to a JSONB map that would expand each key to a public payload and lose the rowid the
    // graph is keyed by (`groupedKeys`, `collection.ts`; the map blob is framed in JS and cannot expand a
    // rowid back). Only the element-keyed case is intercepted; everything else takes the ordinary `reduce`.
    const next = steps[at + 1];
    if (next && selectedColumn(next) === 'keys' && !next.modulators?.length) {
      const collection = collectionOf(step, ctx.collections);
      const keys = collection && groupedKeys(collection, fresh);
      if (keys) return { tail: continueAs(keys.rel, keys.framing, steps, at + 2, false, ctx, fresh, NO_ALIASES) };
    }
    // CONSUMER-DRIVEN FOLD, the other half: `cap("a").unfold()` folds the members to a JSONB array and
    // immediately explodes it back, so the fold is the IDENTITY on the member rows — the collection
    // already holds one row per member. `readUnfolded` hands back the member relation directly and
    // `capUnfolded` mints an encounter from the SITE ORDER, so the stream is what fold+unfold produced
    // minus the JSON round trip. Only a plain multiset of list members cancels (see `readUnfolded`).
    if (next && next.name === 'unfold' && !(next.args ?? []).length && !next.modulators?.length) {
      const collection = collectionOf(step, ctx.collections);
      const members = collection && readUnfolded(collection, fresh);
      if (members) return { tail: capUnfolded(members, steps, at + 2, ctx, fresh) };
    }
    const collected = readCollection(step, ctx.collections, ctx.source, fresh);
    if (!collected) return { tail: null };
    return { tail: continueAs(collected.rel, collected.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES) };
  }

  if (step.name === 'project') {
    // A carried PATH declines: the record is a new traverser object and nothing here appends it as a
    // path position, so a later `path()` would report a history with a step missing. No-op over a scalar.
    if (pathCarried(rel)) return { tail: null };
    const record = recordOf(rel, host, framing, step, childSeam(ctx, fresh), ctx.source, fresh);
    if (!record) return { tail: null };
    return { tail: continueAs(record.rel, { kind: 'record', fields: record.fields }, steps, at + 1, bulked, ctx, fresh, labels) };
  }

  return 'pass';
}

/**
 * `select(name)` where `name` is a NAMED COLLECTION (a `group`/`groupCount`/`aggregate` side effect) —
 * `'pass'` when it is not (the caller keeps looking, falling through to `selectKeys`), `null` to decline,
 * else the reduced collection value CROSS-joined onto the surviving traverser stream.
 *
 * `Scoping.getScopeValue` consults the side effects before the path labels, so a single-key `select`
 * naming a collection resolves to the FINISHED collection whatever an `as()` bound. `SelectStep` emits it
 * once per surviving traverser — N rows, each the same value — which is exactly a CROSS join of the
 * stream's channels (its rows and their encounter) with the one-row reduced value (`readCollection`, the
 * same relation `cap(name)` reads). The value's payload columns ride through unchanged, so its framing is
 * carried verbatim and the map/list tail takes the rest of the chain (`count(Scope.local)` → the map
 * size).
 *
 * A `by()` modulator over a collection select is a different projection (over the members) and is not
 * built — it declines. A MULTI-key select mixing a collection name with labels is likewise left to
 * `selectKeys`' record path (no scenario needs the collection there).
 */
function selectCollection(step: IRStep, rel: Rel, ctx: ChainCtx, fresh: Minter): FramedRel | null | 'pass' {
  if (step.modulators?.length || step.optionArms) return 'pass';
  const spec = selectSpec(step);
  if (!spec || spec.labels.length !== 1) return 'pass';
  const name = spec.labels[0]!;
  if (!collectionOf(step, ctx.collections) && !ctx.collections.has(name)) return 'pass';
  const value = readCollection(step, ctx.collections, ctx.source, fresh);
  if (!value) return null;
  // CROSS the stream's CHANNELS (rows + encounter) with the one-row value. The channels ride on the
  // LEFT and the value's payload on the RIGHT, projected back to the value's own columns plus the
  // carried channels — the `foreignRejoin` shape, minus the injection ON.
  const channels = rel.channels;
  const stream = make.project({
    id: fresh('scc'), input: rel, channels, type: typeOf(...carriedCols(channels)),
    exprs: channels.map((ch) => [ch.col, col(rel.id, ch.col)] as const),
  });
  // Positional: LEFT (the stream's channels) then RIGHT (the value's payload).
  const joined = make.join({
    id: fresh('scj'), left: stream, right: value.rel, join: 'cross', channels,
    type: typeOf(...carriedCols(channels), ...value.rel.type.cols),
  });
  // A Join emits its sides' columns POSITIONALLY under the JOIN's own id, so the project above it reads
  // `joined`, never the join's inputs (referencing an input from above the join is the "not in scope"
  // error — the input is buried inside the join).
  return {
    rel: make.project({
      id: fresh('scp'), input: joined, channels,
      type: typeOf(...value.rel.type.cols, ...carriedCols(channels)),
      exprs: [...value.rel.type.cols.map((c) => [c.name, col(joined.id, c.name)] as const),
        ...channels.map((ch) => [ch.col, col(joined.id, ch.col)] as const)],
    }),
    framing: value.framing,
  };
}

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
    const args = step.args.map((a) => a.value);
    if (step.optionArms) return null;
    // A PATH carried into the scalar stream (a `values()` appended a value position). It composes with
    // exactly the path-family steps — `path()` frames it, `simplePath()`/`cyclicPath()` filter it —
    // handled BEFORE the blanket modulator decline so `path().by()`/`simplePath().by()` reach their own
    // parsers. Any OTHER step DROPS the path here: a value producer records a value position, but the
    // general scalar tail does not thread a path through every retype, so a non-path-family step consumes
    // it (fail-safe — a later `path()` then declines with no channel rather than framing a gap).
    if (pathCarried(rel)) {
      if (step.name === 'path' && (step.args ?? []).length === 0) {
        const positions = pathPositions(rel, step, childSeam(ctx, fresh), ctx.source, fresh);
        if (!positions) return null;
        return continueAs(positions.rel, { kind: 'path', of: positions.of, scalars: positions.scalars }, steps, at + 1, false, ctx, fresh, labels);
      }
      if (step.name === 'simplePath' || step.name === 'cyclicPath') {
        if ((step.args ?? []).length) return null;
        const cyclic = step.name === 'cyclicPath';
        const pred = step.modulators?.length
          ? pathSimpleByPredicate(rel, cyclic, step, childSeam(ctx, fresh), ctx.source, fresh)
          : pathSimplePredicate(rel, cyclic, step.from, step.to, fresh);
        if (!pred) return null;
        rel = make.filter({ id: fresh('spf'), input: rel, channels: rel.channels, type: rel.type, pred });
        continue;
      }
      rel = dropPath(rel, fresh);
    }
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

    // THE SHARED COLLECTION VOCABULARY — `select` (which may re-root to an ELEMENT, the whole reason
    // `elementTail` is a function), `group`/`groupCount`, `aggregate`, `cap`, `project` — all lowered by
    // the one helper both tails share, reading `by()` through this fold's scalar `host` and framing `out`.
    const armed = collectionArm(step, rel, host, out, bulked, steps, at, ctx, fresh, labels,
      (nextAt) => scalarTail(rel, out, steps, nextAt, bulked, ctx, fresh, labels));
    if (armed === 'continue') continue;
    if (armed !== 'pass') return armed.tail;

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
      const folded = sackMutate(step, rel, host, childSeam(ctx, fresh), ctx.source, fresh);
      if (!folded) return null;
      rel = folded;
      continue;
    }

    // THE PROJECTORS over a VALUE traverser — `_` IS the value, and a named variable is a scope key.
    // One lowering at every host, for `project()`'s reason: a shape works wherever it is legal, not
    // wherever a host was taught it.
    if (REL_PROJECTORS.has(step.name)) {
      const projected = projectorTail(rel, step, host, childSeam(ctx, fresh), ctx.source, fresh);
      if (!projected) return null;
      rel = projected.rel;
      out = projected.framing;
      continue;
    }

    // ORDER / DEDUP / SLICE go through the ONE shape-parameterised row-op engine (`rowOp`), the same
    // door the element and property tails use — a scalar is just another shape (`scalarRowShape`): its
    // identity is the value, its tie the value, its order the value's `sortTerms`. This is what gives a
    // value stream the same row-op vocabulary every other shape has (per-origin dedup, the ordered
    // first-occurrence, the deterministic tie) instead of a hand-rolled subset. A `dedup` reset the
    // multiplicity, so the fold learns `bulked = false` exactly as the element tail does.
    const row = rowOp(step, rel, scalarRowShape(host), bulked, ctx, fresh);
    if (row) { rel = row; if (step.name === 'dedup') bulked = false; continue; }

    // `concat(__.<t>…)` — a TRAVERSAL operand is a per-traverser CHILD value (`TraversalUtil.apply`),
    // which makes concat a row boundary the pure `VALUE_TX.concat` declines. Each operand resolves as a
    // correlated scalar over the traverser (`scalarChild`, the same seam a `by()` body uses), and the
    // FIRST result is appended — a `ScalarMapStep`, one traverser in and one out.
    // ⚠️ `TraversalUtil.apply` THROWS on an EMPTY operand ("does not map to a value"), where a correlated
    // scalar subquery yields NULL — which `concat_ws` SKIPS, a DIFFERENT answer. So an operand that is not
    // provably productive rides a runtime GUARD (§6·5): the concat is computed, and a guard binding raises
    // the reference's message iff any surviving traverser's operand actually produced nothing. A live-alias
    // read (`concat(__.select('a'))`) is always productive and needs none; `concat(__.select('a').values(k))`
    // over a filtered stream where the key is present succeeds, and raises only where it is genuinely empty.
    if (step.name === 'concat' && args.some(isNested)) {
      const seam = childSeam(ctx, fresh);
      const host: ChildHost = {
        kind: 'scalar', value: col(rel.id, 'v'),
        ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') } : {}), row: { rel, aliases: labels },
      };
      const parts: Expr[] = [];
      const mayBeEmpty: Expr[] = []; // productivity predicates for operands not provably productive
      for (const a of args) {
        if (a === null) continue;         // a null operand is skipped (`ConcatStep`)
        if (!isNested(a)) return null;     // the Java API cannot MIX string and traversal operands
        const body = seam.body(a.nested, 'child');
        if (!body) return null;
        const cv = scalarChild(body, host, ctx, fresh);
        if (!cv || cv.framing.kind !== 'scalar') return null;
        parts.push(cv.expr);
        // Where the seam cannot say productivity at all (`present` undefined) there is nothing to guard on
        // — decline rather than risk a silent skip; otherwise collect a concrete "did it produce" predicate.
        if (cv.present !== ALWAYS_PRODUCTIVE) {
          if (!cv.present) return null;
          mayBeEmpty.push(cv.present);
        }
      }
      // `concat_ws('', v, part…)` SKIPS nulls exactly as the string form does; with no non-null string
      // literal to force it, an all-null concatenation must be NULL rather than `''`, so the guard tests
      // every part (the traverser's own value included) IS NULL. Mirrors `VALUE_TX.concat`.
      const all = [col(rel.id, 'v'), ...parts];
      const value: Expr = {
        kind: 'case',
        whens: [[all.map((p) => ({ kind: 'binary', op: 'is', left: p, right: compilerNull() }) as Expr)
          .reduce((left, right) => ({ kind: 'binary', op: 'and', left, right })), compilerNull()]],
        else: { kind: 'call', fn: 'concat_ws', args: [compilerText(''), ...all] },
      };
      const carried = rel.channels;
      const projected = make.project({
        id: fresh('cc'), input: rel, channels: carried,
        type: typeOf(meta('v', 'any', true), ...carriedCols(carried)),
        exprs: [['v', value], ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
      });
      // A provably-productive concat continues the fold; a guarded one is an EXECUTION step, so it recurses
      // the rest of the chain and the guard rides on the tail's `effects` (the `localStringMemberGuard`
      // pattern). The guard reads `rel`'s columns, so it fences and filters `rel`, not `projected`.
      if (!mayBeEmpty.length) { rel = projected; out = { kind: 'scalar', type: UNKNOWN }; continue; }
      const guard = concatEmptyGuard(rel, mayBeEmpty, fresh);
      const tail = scalarTail(projected, { kind: 'scalar', type: UNKNOWN }, steps, at + 1, bulked, ctx, fresh, labels);
      return tail && { ...tail, effects: [guard, ...(tail.effects ?? [])] };
    }

    // THE SCALAR TRANSFORM FAMILY — one `Project` per transform, and the assembler fuses a run of them
    // into one SELECT (`upper(lower(p.v))`).
    // Membership is checked BEFORE the lowering is asked for, so an unlowerable member of the family
    // (`reverse`, `asBool`) DECLINES rather than falling through to be misread by a later arm.
    if (REL_TRANSFORMS.has(step.name)) {
      // `seed.kind === 'values'` IS "the value is a compile-time literal": an `inject()` source is the
      // only one, and it is the population that gets constant-folded. Read off the SEED rather than the
      // current relation, because a preceding transform does not stop a value being literal-derived.
      // `out.type` is the framing type of the stream AS IT ENTERS this transform — a preceding
      // `asDate()`/`count()`/cast leaves a known static tag there, which is what lets a bare
      // `asNumber()` answer identity over a numeric/datetime stream (§6·7; `transformExpr`).
      const tx = transformExpr(step, col(rel.id, 'v'), seed.kind === 'values',
        out.kind === 'scalar' ? out.type : undefined);
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
    // A scalar constant stays in THIS loop; a MAP-literal constant (`constant([k:v])`) retypes to a map,
    // which the scalar tail cannot continue — hand the rest of the chain to `continueAs` so it re-enters
    // `mapTail` (`select`/`unfold`/`count(local)`/`as` over the constant map compose).
    if (step.name === 'constant') {
      const c = constantRetype(rel, step, fresh);
      if (!c) return null;
      if (c.framing.kind !== 'scalar')
        return continueAs(c.rel, c.framing, steps, at + 1, false, ctx, fresh, labels);
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
      const pred = predicateExpr(col(rel.id, 'v'), args[0], subjectType(), step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh, (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, null, ctx, fresh));
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
      const pred = predicateExpr(col(rel.id, 'v'), args[0], subjectType(), null, null, fresh, (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, null, ctx, fresh));
      if (!pred) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred });
      continue;
    }

    if (SCALAR_FILTER_HOSTS.has(step.name)) {
      const clause = sourceFilter(step, scalarSubject(), fresh, ctx, labels);
      if (!clause) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
      continue;
    }

    if (step.name === 'all' || step.name === 'any' || step.name === 'none') {
      // Over a SCALAR traverser, `all`/`any`/`none` produce NOTHING: their `filter` returns FALSE for a
      // non-Iterable item (`vendor/tinkerpop/gremlin-core/.../filter/{All,Any,None}Step.java` — the
      // `return false` after the `instanceof Iterable` block), so a value stream drops whole. The LIST
      // form (`listMemberOp`) tests each member; here the traverser is one value, not a collection.
      // The predicate is irrelevant to the outcome — TinkerPop resolves it for side effects then returns
      // false regardless — so a single-arg quantifier drops without evaluating it.
      if (args.length !== 1 || isLocalScope(step) || step.modulators?.length) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: CONSTANT.false });
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
        // The single-type-space order + a total raw-value tie-break, shared with the correlated
        // by()-reducer arm (`minMaxOrder`) so the two positions cannot drift.
        const ranked = rowNumberWindow(present, rank, present.channels,
          { partitionBy: [], orderBy: minMaxOrder(present, out, step.name === 'min') }, fresh);
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
        // A min/max NULL result is ALWAYS productive — unconditionally, not only when the INPUT stream
        // already was (`ProductiveByStrategy`). `ReducingBarrierStep.processAllStarts` emits whenever it
        // has seen ANY start (`MaxGlobalStep.java:43-46`), and the argmax window above yields exactly one
        // row for a non-empty input and zero for an empty one — so the single row it produces is always
        // the genuine reduced value, null (all inputs null) or not. Inheriting `out.productiveNull` caught
        // only the `aggregate().by(foo).cap().unfold().max()` path and dropped `g.inject(null,null).max()`
        // to an empty result. (sum/mean stay inherited below: SQL aggregation emits one NULL row even over
        // an EMPTY input, which those must SKIP — `SumGlobalStep` yields nothing over zero starts.)
        out = { ...numeric, productiveNull: true };
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
        rel = nonEmptyReducer(rel, [['v', tower.value], ['vt', tower.type]], fresh);
        out = { ...numeric, productiveNull: true };
        continue;
      }
      const reduced = reducerAggregate(col(rel.id, 'v'), step.name, bulk && col(rel.id, bulk.col));
      rel = nonEmptyReducer(rel, [['v', reduced.value], ['vt', reduced.type]], fresh);
      // `result: 'number'` is the framing arm that reads the `vt` column — the result's storage class is
      // DYNAMIC (a sum of integers is an integer, of reals a real), so there is no compile-time tag to
      // give and `UNKNOWN` would throw the second column away. `productiveNull` because a non-empty
      // all-null sum/mean reduces to null and MUST emit it (the empty case is dropped by the guard).
      out = { ...numeric, productiveNull: true };
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
  const args = step.args.map((a) => a.value);
  if (!args.length) return null;

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

  // A COLLECTION argument here means a MIXED inject (`inject([1,2], 3)`): a list traverser and a
  // scalar traverser in one stream, which is the VARIANT shape rather than either of them. Flattening
  // it — the historical representation, held until a scalar stream gains a per-row shape discriminant —
  // is an approximation, and reproducing an approximation is not the same as reproducing an answer, so
  // this declines. (A single-list inject took the `injectList` arm before reaching here; a mixed inject
  // is what survives to this point.) The check is POST-fold so a leading cast that RAISES on a list
  // member — the traversal's ANSWER — reaches its throw first (`foldConstantCoercions` above).
  if (vals.some((v) => Array.isArray(v))) return null;

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
  const rowExpr = (value: ArgValue, i: number): Expr | null => {
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
/** One `[…]` literal argument as the `LIST_COL` pairs blob a list-valued relation carries, or `null` to
 *  decline (a member that is not a scalar literal). The SHARED builder for `inject([…])` (a SOURCE row) and
 *  `constant([…])` (a per-row retype) — the two are one literal, produced at different positions. */
function listLiteralBlob(listArg: Arg, values: readonly ArgValue[]): Expr | null {
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
  return items.some((item) => !item) ? null : { kind: 'json-array', items: items as Expr[], binary: true };
}

function injectList(step: IRStep, ordered: boolean, fresh: Minter): { rel: Rel; framing: RelFraming } | null {
  const args = step.args.map((a) => a.value);
  if (step.modulators?.length || step.optionArms || !args.length) return null;
  if (!args.every((arg) => Array.isArray(arg))) return null;
  const blobs = args.map((values, ai) => listLiteralBlob(step.args[ai]!, values));
  if (blobs.some((blob) => !blob)) return null;
  // The ENCOUNTER ordinal — `injectMap`'s rule, and the fix for a real order bug: `inject([…],[…]).fold()`
  // folds SEVERAL list traversers into a list-of-lists, and `foldLists` orders the members by this channel;
  // WITHOUT it the fallback ordered by the list VALUE and returned them SORTED rather than in inject order.
  // Gated on MULTIPLE arguments: a single `inject([…])` is ONE traverser whose members' order is intrinsic
  // to the list (no encounter needed), and adding one there broke the member ops that do not thread it
  // (`inject([…]).toLower(Scope.local)` — the explode dropped the extra channel).
  const wantOrder = ordered && blobs.length > 1;
  const channels = wantOrder ? withChannel([], ENCOUNTER) : [];
  const rows = (blobs as Expr[]).map((blob, i) => (wantOrder ? [blob, compilerInt(i + 1)] : [blob]));
  return {
    rel: make.values({ id: fresh('inl'), rows, channels, type: typeOf(meta(LIST_COL, 'json'), ...carriedCols(channels)) }),
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
  const blobs = step.args.map((a) => mapLiteralBlob(a.value, a.type ?? null, a.name));
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
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), ctx.source, fresh,
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

    // GLOBAL `count()` counts the LIST TRAVERSERS — a list is ONE traverser, so this is the ordinary
    // `countTail` (the same barrier the element/map streams use), the complement of the `count(Scope.local)`
    // that counts a list's MEMBERS (`listRetype`). Without it `fold().count()` — and the `fold().fold()
    // .count(Scope.local)` that `collapseFoldCountLocal` rewrites INTO `fold().count()` — declined.
    if (step.name === 'count' && !isLocalScope(step)) {
      if ((step.args ?? []).length) return null;
      const counted = countTail(rel, fresh);
      return scalarTail(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    // `fold()` over a LIST stream — fold every list traverser into ONE list-of-lists (`fold().fold()`,
    // `map(__.out().fold()).fold()`, `local(__.out().fold()).fold()`). The member IS the traverser's own
    // list, so `foldLists` collects each `LIST_COL` value whole and the result `of` is
    // `{kind:'list', of: items}` — the nested shape the already-recursive framer expands. A GLOBAL fold
    // only (a `fold(Scope.local)` is not a step); the encounter orders the members.
    if (step.name === 'fold' && !(step.args ?? []).length && !isLocalScope(step)) {
      const encounter = encounterOf(rel.channels);
      const folded = foldLists(rel, items, { ...(encounter ? { order: [encounter.col] } : {}) }, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }

    // A GLOBAL row op works on the STREAM of list traversers — not one list's members, which is
    // `listMemberOp`'s Scope.local below. order/dedup/slice route through the shape-parameterised
    // `rowOp`: a list is another shape (`payloadRowShape`), its identity and tie the whole `LIST_COL`
    // JSON — two lists are equal iff their ordered members are, so byte-identity IS list equality and a
    // global `dedup()` keeps the first occurrence's list. A LOCAL-scope op declines out of `rowOp` and
    // falls to `listMemberOp`.
    const listHost: ChildHost = { kind: 'list', list: col(rel.id, LIST_COL), of: items };
    const row = rowOp(step, rel, payloadRowShape(listHost), false, ctx, fresh);
    if (row) { rel = row; continue; }

    const member = listMemberOp(step, rel, items, ctx.source, fresh, seam);
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
    const args = step.args.map((a) => a.value);
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
  ctx: ChainCtx, fresh: Minter, aliases: AliasMap, keys?: readonly string[],
): Tail | null {
  let rel = seed;
  let labels = aliases;
  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = step.args.map((a) => a.value);
    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }

    // `as(label…)` binds the WHOLE map to each label — its pairs array stored in history, its
    // `keyOf`/`valOf` recorded on the entry so `select(label)` re-enters `mapTail` with the same
    // vocabulary. Shape-preserving, exactly like `as()` over an element/list/scalar (`bindAliases`).
    if (step.name === 'as') {
      const bound = bindAliases(step, rel, labels, { kind: 'map', map: col(rel.id, MAP_COL), keyOf, valOf, ...(keys ? { keys } : {}) }, fresh);
      if (!bound) return null;
      rel = bound.rel;
      labels = bound.aliases;
      continue;
    }

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

    // A LOCAL POSITION SLICE over a map is an ORDER-PRESERVING ENTRY slice (`RangeLocalStep.applyRangeMap`
    // / `TailLocalStep`) — `limit`/`range`/`skip`/`tail`(Scope.local) keep a window of the ENTRIES in
    // insertion order, the map's own `MAP_COL` pairs array sliced like the list-local slice. The map
    // shape is preserved, so the tail continues under the SAME framing. `order`/`dedup`(Scope.local) over
    // a map (by key/value) is a different question and is NOT this arm — it declines below.
    if (MAP_LOCAL_SLICE.has(step.name) && isLocalScope(step)) {
      const sliced = mapRange(rel, step, fresh);
      if (!sliced) return null;
      rel = sliced;
      continue;
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
        // TinkerPop's precedence (`Scoping.getScopeValue`): the map is consulted FIRST, the label only
        // if the map has no such key. A key that also names a LIVE alias is therefore ambiguous ONLY
        // when it could be a map key — and `keys` is the compile-time answer to that. If we KNOW the
        // static key set and `key` isn't in it, the map cannot resolve it, so the alias wins
        // unambiguously and re-enters via `selectKeys` (the ordinary alias read). Where the keys are not
        // known (a stored map property), the ambiguity stands and we keep the fail-closed decline.
        if (liveAliases(labels, rel).has(key)) {
          if (keys && !keys.includes(key)) {
            const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), ctx.source, fresh,
              { framing: { kind: 'map', keyOf, valOf, ...(keys ? { keys } : {}) }, named: namedElsewhere(ctx) });
            return selected && continueAs(selected.rel, selected.framing, steps, at + 1, false, ctx, fresh, labels);
          }
          return null;
        }
        const keyed = mapKey(rel, key, valOf, fresh);
        if (!keyed) return null;
        // A LIST value continues as a LIST stream (its members have shape `valOf.of`), so
        // `select('k').unfold()`, `select('k').order(Scope.local)` and every member op compose; a MAP
        // value re-enters `mapTail` (a nested group's inner map, keys self-describing so scalar-keyed);
        // a scalar value is the ordinary per-row-typed value stream.
        if (valOf.kind === 'list') return listTail(keyed, valOf.of, steps, at + 1, ctx, fresh, labels);
        if (valOf.kind === 'map') return mapTail(keyed, { kind: 'scalar' }, valOf.of, steps, at + 1, ctx, fresh, labels);
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

    // GLOBAL order/dedup/slice over the STREAM of map traversers route through the shape-parameterised
    // `rowOp`: a map is another shape (`payloadRowShape`), its dedup identity the whole `MAP_COL` JSON (a
    // canonical-key-order `LinkedHashMap` compares by entries). `order()` with no comparator DECLINES —
    // a Java `Map` is not `Comparable`, so the map host's `by()` arms return null and no total order is
    // invented, exactly as the reference refuses one. A LOCAL-scope op was handled above.
    const mapHost: ChildHost = { kind: 'map', map: col(rel.id, MAP_COL), keyOf, valOf, row: { rel, aliases: labels } };
    const row = rowOp(step, rel, payloadRowShape(mapHost), false, ctx, fresh);
    if (!row) return null;
    rel = row;
  }
  return { rel, framing: { kind: 'map', keyOf, valOf, ...(keys ? { keys } : {}) }, aliases: labels, bulked: false };
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
  // Read `a.value`, never the bare `Arg` — an `Arg` is `{value, type, name}` since a user PARAMETER became a
  // first-class IR fact, so a test against the wrapper is permanently false. That exact reading rot is
  // what made `rel-blockers` file every labelled `group("a")` under the unkeyed bucket.
  const args = step.args.map((a) => a.value);
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
    const args = step.args.map((a) => a.value);
    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }
    if ((step.modulators?.length && !BY_READERS.has(step.name)) || step.optionArms) return null;

    if (step.name === 'count' && !isLocalScope(step)) {
      if (args.length) return null;
      const counted = countTail(rel, fresh);
      return scalarTail(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, labels);
    }

    if (step.name === 'group' || step.name === 'groupCount') {
      const grouped = groupBarrier(rel, entryHost(rel, keyOf, valOf, labels), step, false, childSeam(ctx, fresh), ctx.source, fresh);
      if (!grouped) return null;
      return mapTail(grouped.rel, grouped.keyOf, grouped.valOf, steps, at + 1, ctx, fresh, labels);
    }

    const column = selectedColumn(step);
    if (column) {
      // The side becomes an ordinary per-row-typed value stream, which is what makes
      // `groupCount().unfold().select(Column.values).sum()` the ordinary reducer rather than a
      // map-shaped special case. There is no other side: see `sideList`.
      const sideShape = column === 'keys' ? keyOf : valOf;
      const side = entrySide(rel, column, sideShape, fresh);
      if (!side) return null;
      // A LIST value side continues as a LIST stream (`entrySide`'s value from a `Map<K,List>` entry); a
      // MAP value side re-enters `mapTail`; every other side is the ordinary per-row-typed value stream.
      if (sideShape.kind === 'list') return listTail(side, sideShape.of, steps, at + 1, ctx, fresh, labels);
      if (sideShape.kind === 'map') return mapTail(side, { kind: 'scalar' }, sideShape.of, steps, at + 1, ctx, fresh, labels);
      return scalarTail(side, { kind: 'scalar', type: PER_ROW('vtype') }, steps, at + 1, false, ctx, fresh, labels);
    }

    // GLOBAL order/dedup/slice over the STREAM of Map.Entry traversers route through `rowOp`. An entry is
    // a scalar-shaped host (`entryHost`), so `scalarRowShape` carries it; `order().by(Column.values)` reads
    // the value side off the entry (`byExpr`'s `column` arm), `order().by(Column.keys)` the key. A bare
    // `order()` declines (no comparator), a local-scope op declines back to the slice below.
    const row = rowOp(step, rel, scalarRowShape(entryHost(rel, keyOf, valOf, labels)), false, ctx, fresh);
    if (row) { rel = row; continue; }
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
  /** DETACHED-transfer compile (set only by `runForeign()`): the element leaf emits a fuller property node
   *  `{t, v, vpid, meta?}`. Off for ordinary framing, so base props stay `{t, v}`. */
  readonly detached?: boolean;
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
  /** The GRAPH the chain reads through — `BaseGraph` (the SQLite physical schema) by default. A
   *  DECORATE resume overrides it with a `decorateGraph` wrapper that answers ONE synthetic property
   *  key (an OLAP score) off the barrier's landed `(id → value)` relation and delegates all else to the
   *  base, so the algorithm's result composes as an ordinary property over the live element stream. A
   *  bound-graph resume sets its own source directly (`lowerForeignResume`), not through this. */
  readonly source?: GraphSource;
  /** The landed graphs a multi-graph merge has accumulated so far (`nestedBranchSegment`), each with its
   *  graph identity and CTE bindings. It is what `unifiedBoundGraph` (`source`, above) rejoins by the
   *  composite `(graph, id)` for a POST-MERGE element read; carried here so a later segment can extend
   *  it. Absent for every non-merge compile. */
  readonly mergedGraphs?: readonly MergedGraph[];
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
  detached: opts.detached ?? false,
  labelRegime: opts.labelRegime ?? 'single',
  sideEffects: opts.sideEffects ?? NO_SIDE_EFFECTS,
  sideEffectPolicies: opts.sideEffectPolicies ?? NO_SIDE_EFFECT_POLICIES,
  services: opts.services ?? NO_SERVICES,
  sack: opts.sack ?? null,
  source: opts.source ?? BaseGraph,
  mergedGraphs: opts.mergedGraphs ?? [],
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

const framed = (chain: Tail, source: GraphSource, detached: boolean, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } | null => {
  const framing = chain.framing;
  // THE FAIL-CLOSED BACKSTOP, and it should never fire. `bulkObservedFrom` refuses a collapse in front
  // of a chain that retypes away from `elements`, and `inBody` refuses one inside a body whose enclosing
  // framing it cannot see — so a multiplicity arriving at an arm that has no column to put it in means
  // one of those two answered wrongly. Declining is the safe response; projecting anyway would silently
  // drop N−1 traversers per row, which is the one failure class no
  // instrument here catches (a plausible row set, short). This is the guard that makes the completeness
  // of `inBody`'s call sites a tractability question rather than a correctness one.
  // `detached` joins `elements`/`discard` as a framing that CAN carry a multiplicity: a collapsed bound
  // element re-expands on the wire through `source.leafPayload`'s `bulk` column, exactly as `elements`
  // does over the base graph.
  if (carriesMultiplicity(chain) && framing.kind !== 'elements' && framing.kind !== 'discard' && framing.kind !== 'detached') return null;
  switch (framing.kind) {
    // `elements` (a base element stream) and `detached` (a BOUND element stream) frame IDENTICALLY at the
    // leaf: both are id-carrying, and `source.leafPayload` reads the base tables for `BaseGraph` or REJOINS
    // the landed relation for `BoundGraph` (Mechanism B) — reconstituting the (id, label, props[, src, tgt])
    // tuple `foreign.ts` used to carry. The `Shape` is the ordinary one: the byte framers cannot tell a
    // federated vertex from a local one and must not. The two arms differ only UPSTREAM, in the step
    // vocabulary each may reach (`continueAs` → `elementTail` vs `detachedTail`), never in the wire payload.
    case 'elements':
    case 'detached': return {
      rel: source.leafPayload(chain.rel, framing.elem, {
        bulk: carriesMultiplicity(chain), detached,
      }, fresh),
      shape: framing.elem === 'edge' ? { kind: 'edge' } : { kind: 'vertex' },
    };
    case 'scalar': return scalarPayload(chain.rel, framing, fresh);
    case 'list': return listPayload(chain.rel, framing.of, !!framing.set, source, fresh);
    case 'path': return pathPayload(chain.rel, framing.of, fresh);
    case 'map': return mapPayload(chain.rel, framing.valOf, source, fresh);
    case 'mapEntry': return mapEntryPayload(chain.rel, framing.keyOf, framing.valOf, fresh);
    case 'record': return recordPayload(chain.rel, framing.fields, source, fresh);
    case 'property': return {
      rel: propertyPayload(chain.rel, framing.ownerElem, fresh),
      shape: { kind: 'property' },
    };
    // A DISCARD has nothing to project: the result relation is a statement with an empty `RETURNING`, so it
    // has no columns and `discard` is already the whole contract. The algebra owes the framing layer nothing
    // further, which is exactly what every other arm here now also means.
    case 'variant': return variantPayload(chain.rel, framing.arms, source, fresh);
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
export function minMaxOrder(rel: Rel, framing: RelFraming, isMin: boolean): readonly SortTerm[] {
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
export function minMaxWinnerVt(rel: Rel, framing: RelFraming): Expr {
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

const lowered = (chain: Tail, source: GraphSource, propertySeek: boolean, ftsSubstringPredicate: boolean, detached: boolean, fresh: Minter): RelLowering | null => {
  const wire = framed(chain, source, detached, fresh);
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
  // A stateful SOURCE (a `decorateGraph` stack) declares its landed `(id → value)` CTEs HERE — the one
  // collection point — so every entry that reads through it (a resume's final SQL, a downstream
  // barrier's head) gets them without threading a binding by hand. `BaseGraph`/`BoundGraph` carry none.
  const sourceBindings = source.bindings?.(fresh) ?? [];
  const effects = chain.effects ? [...sourceBindings, ...chain.effects] : sourceBindings;
  // EFFECTS FIRST, then whatever CTEs the result still needs — `checkPlan` proves a `Ref` resolves
  // only backwards, so the order the executor runs IS the order the checker walked. `name` is called
  // on the result alone because a write step has already named its own target's shared nodes; the
  // day a write RESULT needs naming across that boundary, this is where the pass grows to walk a
  // program rather than a tree.
  const built = effects.length ? program({ bindings: [...effects, ...named.bindings], result: named.result }) : named;
  // A held LITERAL — of any size — inlines as a typed SQL literal (`constLit`), so a big `inject(v1…vN)`
  // is 0 binds and DO-legal with nothing to convert. The 100-bind cap is a PARAMETER budget, and the only
  // way past it is 100+ distinct PARAMETERS in one statement, which fails closed at the gate below rather
  // than being blobbed into one bind — a scenario not in the corpus and deliberately unsupported.
  const plan = built;
  // A PROGRAM's budget is PER STATEMENT — each binding is its own query — so the sum a read plan is
  // measured by (its bindings are CTEs of ONE statement) would refuse a nine-statement cascade on a
  // number no database ever asks. `emit` renders every step and raises `BindBudgetExceeded` on the
  // one that is over, which is the same rendered-list authority the read path renders for.
  if (effects.length) {
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
  return chain && lowered(chain, settled.source, settled.propertySeek, settled.ftsSubstringPredicate, settled.detached, fresh);
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
  rejoin?: { readonly parentCount: number } | { readonly parentCount: number; readonly mapValues: Extract<ValueNode, { readonly t: 'map' }> },
): RelLowering | null {
  const fresh = minter();
  const settled = settle(opts);
  const { ctx, facts } = chainCtxOf(steps.slice(from), settled);
  // A SUBGRAPH result is MIXED — edges (the graph, carrying `src`/`tgt` adjacency) plus their incident
  // vertices, WITH data (`federate` `.with("subgraph", true)`). A normal federated result
  // is homogeneous (one element kind), so the mix IS the signal. When it is a subgraph the edges are the
  // stream and the vertices become a bound lookup relation the tail's `inV`/`outV`/`bothV` join for the
  // endpoint's data — movement over a bound edge `Ref` (`docs/2026-08-21-barrier-substrate-design.md`).
  // The BoundGraph payload binding (`bgv`/`bge`) is a per-ELEMENT lookup, so it must hold each landed
  // element ONCE. A mapValues result can contain one sibling element under several parent keys; the
  // payload binding stays distinct while the keyed pool below preserves that multiplicity for its join.
  const mapValues = rejoin && 'mapValues' in rejoin ? rejoin.mapValues : null;
  // Land the awaited rows as the `fenced` CTE bindings a `BoundGraph` reads through (`landForeignRows`) —
  // split by kind (a subgraph's edges + its incident vertices), each declared once as a `Ref` target.
  const { vertexBinding, edgeBinding, streamElem, isSubgraph, bindings } = landForeignRows(rows, elem, fresh, mapValues);
  // A landed relation carries no channels by default — the rows crossed a segment boundary as detached
  // references. But a SUBGRAPH source-form seed CAN carry an `encounter` minted from the landed array
  // order (the sibling's emission order — see the seed below), so a chain that DEMANDS an encounter
  // composes there. Elsewhere the demand declines unless an `order()` mints the encounter mid-chain
  // (exactly as an element `order()` does over the base graph). A bare homogeneous `…fold()` — which
  // would demand the SOURCE's order the landed stream does not seed — still declines.
  const seedsEncounter = isSubgraph && !rejoin;
  const ordersMidChain = steps.slice(from).some((s) => s.name === 'order');
  // `tracksPath` DOES have a source seed over a bound graph: the PATH channel is seeded at position 0
  // off the landed id (`seedPath` below, exactly as the base source seeds it), each hop EXTENDS it
  // through the shared `movement`, and `path()` rejoins each position through `source.elementNode`. What
  // is NOT built yet is a path chain that ALSO demands an encounter (the seed would have to carry both
  // the path append and the order renumber), so that combination declines rather than seed a path
  // without its order.
  if (facts.tracksPath && facts.demandsEncounter) return null;
  if (facts.demandsEncounter && !seedsEncounter && !ordersMidChain) return null;
  const boundSource = boundGraph(vertexBinding, edgeBinding);
  const boundCtx: ChainCtx = { ...ctx, source: boundSource };
  // The initial stream references the landed relation (the edges for a subgraph, else the one matching
  // `elem`) by name, exactly as every downstream read does.
  const streamBinding = isSubgraph || streamElem === 'edge' ? edgeBinding! : vertexBinding!;
  const landed: Rel = make.ref({ id: fresh('bref'), name: streamBinding, channels: [], type: typeOf(...landedCols(streamElem)) });
  // A MID-traversal barrier's pool is per-CALL, not per-parent: the sibling ran once over the distinct
  // injected values, so the rows have to be scattered back over the parents that asked before anything
  // reads them. Doing it here rather than in the tail is what keeps the tail one vocabulary — after the
  // rejoin the relation is the same landed shape a source-form call produces.
  const pool = mapValues
    ? foreignMapRelation(mapValues, streamElem, fresh, [meta('parentId', 'text')])
    : landed;
  const rejoined = mapValues
    ? foreignMapRejoin(pool, streamElem, rejoin!.parentCount, fresh)
    : rejoin ? foreignRejoin(pool, streamElem, rejoin.parentCount, fresh) : landed;
  // ID-CARRY: the stream carries the element ID (+ channels) — the payload is REJOINED at each read
  // through the `BoundGraph`. The landed payload columns are projected AWAY; the shared movement/leaf
  // builders assume an id-carrying stream, and a stream still holding the landed payload would widen
  // every downstream join past its declared type.
  //
  // CHANNELS OVER A BOUND GRAPH: a source-form subgraph seed carries the traverser channels a base
  // source does, seeded off the landed relation. `bulk` (=1) is carried ALWAYS, so a convergent bound
  // walk can collapse (`SUM(bulk)`); `encounter` is minted from the landed array order
  // (`foreignRelation(withOrder)` — the order the sibling EMITTED the rows) only when the chain DEMANDS
  // one, because a collapse and an emission order are mutually exclusive (the base source seeds channels
  // by the same rule). A rejoin's per-parent pool / a homogeneous list stays id-only.
  const seed = facts.tracksPath
    ? (() => {
      // The PATH channel seeded at position 0 (the source element), beside an inert `bulk` (=1) — a
      // path-tracking traverser never collapses (`pathCarried` blocks every collapse), so bulk is
      // carried only to match the shape the shared movement/leaf builders assume. Each hop appends to
      // the path (`extendPath` in `movement`); `path()` frames it (`pathPositions`).
      const channels = withChannel(BULK, PATH_CHANNEL);
      return make.project({
        id: fresh('bsp'), input: rejoined, channels,
        type: typeOf(meta('id', 'any', true), ...carriedCols(channels)),
        exprs: [['id', col(rejoined.id, 'id')],
          ...channels.map((channel) => [channel.col,
            channel.role === 'bulk' ? compilerInt(1)
              : seedPath({ kind: 'element', elem: streamElem, id: col(rejoined.id, 'id') }, facts.demandsPathLabels)] as const)],
      });
    })()
    : seedsEncounter
    ? (() => {
      const withBulk = make.project({
        id: fresh('bsb'), input: rejoined, channels: BULK,
        type: typeOf(meta('id', 'any', true), meta(FOREIGN_ORD, 'int'), meta('bulk', 'int')),
        exprs: [['id', col(rejoined.id, 'id')], [FOREIGN_ORD, col(rejoined.id, FOREIGN_ORD)], ['bulk', compilerInt(1)]],
      });
      if (!facts.demandsEncounter) return make.project({
        id: fresh('bsd'), input: withBulk, channels: BULK, type: typeOf(meta('id', 'any', true), meta('bulk', 'int')),
        exprs: [['id', col(withBulk.id, 'id')], ['bulk', col(withBulk.id, 'bulk')]],
      });
      const channels = withChannel(BULK, ENCOUNTER);
      return renumber(withBulk, [{ expr: col(withBulk.id, FOREIGN_ORD), dir: 'asc' }],
        [meta('id', 'any', true), ...carriedCols(channels)], channels, fresh);
    })()
    : make.project({
      id: fresh('bsd'), input: rejoined, channels: [], type: typeOf(meta('id', 'any', true)),
      exprs: [['id', col(rejoined.id, 'id')]],
    });
  const chain = detachedTail(seed, streamElem, steps, from, boundCtx, fresh, isSubgraph);
  return chain && lowered({ ...chain, effects: [...bindings, ...(chain.effects ?? [])] }, boundSource, settled.propertySeek, settled.ftsSubstringPredicate, settled.detached, fresh);
}

/**
 * THE SCALAR RESUME — a pushed-down federate reducer's tail. The reducer (`count`/`sum`/…) already ran
 * on the SIBLING and its one typed `{t,v}` value crossed back (`BarrierScalar`); the reduction was the
 * TERMINAL step, so there is nothing left to compose — this is a pure framing of one value. The `{t,v}`
 * node is emitted as a single `Values` row in the `NODE_COL`, framed by the `typedNode` shape's ONE rule
 * (`frameTypedNode`), so the scalar's Gremlin type (a `long` for count, the reducer's own for sum/max)
 * survives EXACTLY — a bare number would erase Long-vs-Integer. A null value (SUM over an empty stream)
 * frames as no result, matching TinkerPop's empty aggregation. No chain, no `lowered()`: a terminal
 * 1-row plan, `nameBindings` to a `Plan`. */
export function lowerScalarResume(value: ValueNode): RelLowering {
  const fresh = minter();
  // A NULL scalar frames as NO RESULT (an empty relation), matching TinkerPop's empty aggregation:
  // `sum`/`min`/`max`/`mean` over an empty stream yield NOTHING (`SumGlobalStep.processAllStarts` emits
  // no traverser). `count` over empty is a real 0 (`v` is 0, not null), so it still emits its row. Keying
  // on `v == null` is exactly that distinction — a leaf `{t,v}` with a null value is the empty aggregate.
  // A NULL scalar frames as NO RESULT (an empty relation). This is a REAL semantics decision, not a
  // framing shortcut, and it is faithful to TinkerPop by design: a `ReducingBarrierStep` is a SEMIGROUP
  // fold seeded from the first traverser (`generateSeedFromStarts`), so over an EMPTY stream `sum`/`min`/
  // `max`/`mean` emit NOTHING — they each override `processAllStarts` with an `if (starts.hasNext())`
  // guard (`vendor/tinkerpop/gremlin-core/.../step/map/SumGlobalStep.java`). This was TINKERPOP-1777, a
  // deliberate `breaking` change in 3.4.0 (the prior behaviour returned `Integer.MIN_VALUE`/`NaN`); the
  // sanctioned "I want 0" idiom is a user `coalesce(…, constant(0))`, NOT an engine-supplied identity.
  // `count` is the ONE monoid — it installs an explicit `ConstantSupplier(0L)`, so empty count is `0`
  // (arriving here as `v:0`, emitted), while an empty semigroup fold arrives as `v:null` and is dropped.
  const empty = value != null && typeof value === 'object' && 't' in value && (value as { v?: unknown }).v == null;
  const node: Expr = compilerText(JSON.stringify(value));
  const one = make.values({
    id: fresh('scv'), channels: [], type: typeOf(meta(NODE_COL, 'json', true)),
    rows: [[jsonOf(node)]],
  });
  // `Values` refuses the empty relation, so the empty aggregate is the honest `Filter(false)` over the one
  // row (§3.3) — no traverser.
  const rel = empty ? make.filter({ id: fresh('scf'), input: one, channels: [], type: one.type, pred: CONSTANT.false }) : one;
  return { plan: nameBindings(rel), shape: { kind: 'typedNode' } };
}

/**
 * THE VALUE-STREAM RESUME — a pushed-down federate terminal that produced a STREAM of values
 * (`values(k)`, `unfold()`, a `cap('a')`/`fold()` list), not a single reduced scalar. The whole tail ran
 * on the SIBLING (the pushable prefix is MAXIMAL, so a value terminal pushes its own downstream too), so
 * this is a pure framing of the N values that crossed back — the exact `lowerScalarResume` mechanism one
 * cardinality up: each `{t,v}` node is one `Values` row in `NODE_COL`, framed by the ONE `typedNode` rule
 * (`frameTypedNode`), so every member keeps its own Gremlin type — a scalar leaf, a detached vertex/edge
 * (a pushed `fold()` of elements), a nested list/map, each by its own tag. It is the value-stream twin of
 * `lowerForeignResume` (which lands ELEMENT rows) sharing `lowerScalarResume`'s framing rather than the
 * `valueResume`/`scalarTail` substrate, because there is NO local suffix to continue: a maximal prefix
 * leaves the sibling's values AS the result. An EMPTY stream frames as no traversers (`Values` refuses the
 * empty relation, so a `Filter(false)` stands in — the same spelling `lowerScalarResume` uses for the
 * empty aggregate).
 */
export function lowerTypedNodeStream(nodes: readonly FrameNode[], parents?: number): RelLowering {
  const fresh = minter();
  const type = typeOf(meta(NODE_COL, 'json', true));
  // `Values` REFUSES an empty relation (`checkValuesShape`), so an empty stream is a one-row `Values`
  // FILTERED to nothing — the same honest `Filter(false)` `lowerScalarResume` uses for the empty aggregate
  // (§3.3). A non-empty stream is one `Values` row per node.
  const rowsOf = (ns: readonly FrameNode[]): (readonly Expr[])[] => ns.map((node) => [jsonOf(compilerText(JSON.stringify(node)))]);
  const one = make.values({ id: fresh('tnv'), channels: [], type, rows: nodes.length > 0 ? rowsOf(nodes) : [[jsonOf(compilerText('null'))]] });
  // MID-TRAVERSAL CONSTANT SCATTER: a `V().call(federate, <constant sub>)` runs the sibling ONCE and each
  // of the P parents re-emits the WHOLE pool — the value-stream analogue of the element rejoin's CROSS join
  // (`foreignRejoin`, no injection). `parents` is the parent count; the pool CROSS-joins a P-row relation so
  // the result is P×N traversers, exactly `call()`'s flatMap shape. `undefined` = the source form (one
  // emission, no parents). P=0 (no parents) or an empty pool both yield no traversers.
  const scattered = parents === undefined ? one
    : parents === 0 ? make.filter({ id: fresh('tnp'), input: one, channels: [], type, pred: CONSTANT.false })
    : (() => {
      // A P-row parent relation (index 0..P-1), crossed with the pool. The indices are a compile-time set
      // (P is known), so they inline as a `Values` relation rather than a data bind.
      const parentRows = make.values({ id: fresh('tnpr'), channels: [], type: typeOf(meta('p', 'int')), rows: Array.from({ length: parents }, (_, i) => [compilerInt(i)] as const) });
      return make.join({ id: fresh('tnj'), left: one, right: parentRows, channels: [], join: 'cross', type: typeOf(meta(NODE_COL, 'json', true), meta('p', 'int')) });
    })();
  const rel = nodes.length > 0 ? scattered : make.filter({ id: fresh('tnf'), input: one, channels: [], type, pred: CONSTANT.false });
  return { plan: nameBindings(rel), shape: { kind: 'typedNode' } };
}

/** What a mid-traversal reduction emits when a parent has no partial (see `reducers.ts`): `zero` = the
 *  monoid `count`'s identity 0 (contribute 0); `nothing` = a semigroup (`sum`/`min`/`max`) — contribute
 *  nothing (an empty min/max emits no traverser). */
type EmptyResult = 'zero' | 'nothing';

/**
 * THE MID-TRAVERSAL REDUCTION COMBINE — the reducer applied over a `(key→partial)` map the sibling
 * returned (`docs/2026-08-26-federate-pushdown-design.md`). A mid `V().call(federate,…,inj).count()` is a
 * GLOBAL reduction over the whole resumed stream (the element path returns ONE number), so the combine
 * folds ALL the per-parent partials into one value with `combine`/`empty`.
 *
 * Both the map (`out.value`, a `t:'map'` ValueNode) and the parent-id range are KNOWN at resume time,
 * so the fold is pure data: for each parent, look up its partial by parent id
 * (a match contributes the partial; a miss contributes `empty` — the monoid `count` adds 0, a semigroup
 * contributes nothing). Then `combine` folds the contributions: `sum` (count/sum → SUM0), `min`/`max`
 * (extremal, empty ⇒ NO value → no traverser, matching TinkerPop's semigroup empty). One scalar out (or
 * none), the SAME answer as scattering the elements and reducing locally — the semantic authority. Framed
 * as a `typedNode` so the partial's Gremlin type (a `long` count, a numeric sum/min/max) survives.
 *
 * Each parent maps to one key, so `combine` folds over the per-parent partials exactly once each.
 * The sibling groups by those map keys before returning the map.
 */
export function lowerReduceCombine(
  map: ValueNode, parentCount: number,
  reduce: { readonly empty: EmptyResult; readonly partial: string; readonly combine: 'sum' | 'min' | 'max' },
  _steps: readonly IRStep[], _from: number, _opts: Lowering,
): RelLowering {
  const fresh = minter();
  const pairs: readonly (readonly [ValueNode, ValueNode])[] = map.t === 'map' ? map.v : [];
  const byKey = new Map(pairs.map(([k, v]) => [JSON.stringify((k as { v: unknown }).v), (v as { v: unknown }).v as number]));
  // The partial's Gremlin type is uniform across groups — read it off any pair, else count → long.
  const partialT = (pairs[0]?.[1] as { t?: string } | undefined)?.t ?? (reduce.partial === 'count' ? 'long' : null);
  // Contributions: a matched parent gives its partial; a miss gives `empty` (0 for the monoid `count`,
  // skipped for a semigroup). Fold with the reducer's combine.
  const contribs: number[] = [];
  for (let parentId = 0; parentId < parentCount; parentId++) {
    const hit = byKey.get(JSON.stringify(String(parentId)));
    if (hit !== undefined) contribs.push(hit);
    else if (reduce.empty === 'zero') contribs.push(0);
    // 'nothing' (semigroup): an unmatched parent contributes nothing.
  }
  const folded: number | null = contribs.length === 0
    ? (reduce.empty === 'zero' ? 0 : null)                          // empty: monoid count → 0; semigroup → nothing
    : reduce.combine === 'sum' ? contribs.reduce((a, b) => a + b, 0)
    : reduce.combine === 'min' ? Math.min(...contribs)
    : Math.max(...contribs);
  const node: Expr = compilerText(JSON.stringify({ t: partialT, v: folded } as ValueNode));
  const one = make.values({ id: fresh('rcv'), channels: [], type: typeOf(meta(NODE_COL, 'json', true)), rows: [[jsonOf(node)]] });
  // A null fold (an all-empty semigroup) frames as NO traverser — `Values` refuses the empty relation, so
  // it is the honest `Filter(false)` (§3.3), matching `lowerScalarResume`'s empty-aggregate spelling.
  const rel = folded === null ? make.filter({ id: fresh('rcf'), input: one, channels: [], type: one.type, pred: CONSTANT.false }) : one;
  return { plan: nameBindings(rel), shape: { kind: 'typedNode' } };
}

/**
 * THE PATH RESUME — weighted shortestPath's tail. Unlike the decorate resume (element-preserving) this
 * REPLACES the stream with reconstructed paths: the barrier's `apply` relaxed the weighted shortest
 * distance into `barrier_state` (scope = source, channel 0), and this rebuilds the shortest PATHS from
 * that relation (`shortestPathReconstruct`) then continues the tail after the shortestPath call over the
 * path-framed stream — exactly the `FramedRel` the unweighted rel walk hands the fold, but produced in
 * the resume because the relaxation is a runtime barrier. `run`/`round` inline as literals (O(1) plan).
 */
export function lowerPathResume(
  run: number, round: number, cfg: ReconstructConfig, steps: readonly IRStep[], barrierAt: number, opts: Lowering = {},
): RelLowering | null {
  const fresh = minter();
  const settled = settle(opts);
  const { ctx } = chainCtxOf(steps, opts);
  const built = shortestPathReconstruct(run, round, cfg, ctx.source, childSeam(ctx, fresh), fresh);
  if (!built) return null;
  const tail = continueAs(built.rel, { kind: 'path', of: built.of, scalars: built.scalars }, steps, barrierAt + 1, false, ctx, fresh, NO_ALIASES);
  return tail && lowered(tail, settled.source, settled.propertySeek, settled.ftsSubstringPredicate, settled.detached, fresh);
}

/**
 * THE PAIR RESUME — node-similarity's tail, and a NEW output shape: a stream of `{key1, key2, valueKey}`
 * MAPS. `apply` computed scored vertex PAIRS into `barrier_state` (scope = node1, id = node2, channel 0 =
 * score); this frames each pair row as one map, reusing the `mapValue` wire form — build the self-describing
 * `[[key, {t,v}], …]` blob per row (`typedNode`), carry it in `MAP_COL`, and let `framed`'s `map` arm
 * (`mapPayload`) turn each blob into one GraphBinary map. node1/node2 frame as their EXTERNAL ids
 * (`source.externalId`); the score by the spec's vtype. `run`/`round` inline as literals (O(1) plan).
 */
export function lowerPairResume(
  run: number, round: number, spec: PairSpec, steps: readonly IRStep[], barrierAt: number, opts: Lowering = {},
): RelLowering | null {
  const fresh = minter();
  const settled = settle(opts);
  const { ctx } = chainCtxOf(steps, opts);
  const scan = make.scan({
    id: fresh('pss'), table: 'barrier_state', alias: fresh('rps'), channels: [],
    type: typeOf(meta('run', 'int'), meta('round', 'int'), meta('scope', 'int'), meta('id', 'int'), meta('channel', 'int'), meta('cval', 'any', true)),
  });
  const rows = make.filter({
    id: fresh('psf'), input: scan, channels: [], type: scan.type,
    pred: and(and(eq(col(scan.id, 'run'), compilerInt(run)), eq(col(scan.id, 'round'), compilerInt(round))), eq(col(scan.id, 'channel'), compilerInt(0))),
  });
  // node1/node2 as EXTERNAL ids, correlated off the pair's scope/id rowids (no join → no column clash).
  const ext1 = ctx.source.externalId('vertex', col(rows.id, 'scope'), fresh);
  const ext2 = ctx.source.externalId('vertex', col(rows.id, 'id'), fresh);
  const pair = (key: string, node: Expr): Expr => ({ kind: 'json-array', items: [compilerText(key), node], binary: false });
  const blob: Expr = { kind: 'json-array', binary: false, items: [
    pair(spec.key1, typedNode(ext1, compilerText('int'))),
    pair(spec.key2, typedNode(ext2, compilerText('int'))),
    pair(spec.valueKey, typedNode(col(rows.id, 'cval'), compilerText(spec.valueVtype))),
  ] };
  const rel = make.project({
    id: fresh('psm'), input: rows, channels: [], type: typeOf(meta(MAP_COL, 'json', true)),
    exprs: [[MAP_COL, { kind: 'call', fn: 'jsonb', args: [blob] }]],
  });
  const tail = continueAs(rel, { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } }, steps, barrierAt + 1, false, ctx, fresh, NO_ALIASES);
  return tail && lowered(tail, settled.source, settled.propertySeek, settled.ftsSubstringPredicate, settled.detached, fresh);
}

/** The reserved bind a value-transform barrier's re-injected values cross under — one `json_each` bind
 *  of a data-sized set, underscore-namespaced so it cannot collide with a user parameter. */
const VALUE_RESUME_PARAM = '_mogwai_value_resume';

/**
 * THE VALUE-SOURCE RESUME — substrate A's value arm, the value-stream twin of `lowerForeignResume`.
 *
 * A value-transform barrier (reverse, split, …) computed a NEW value per traverser in JS; its output IS
 * the resumed stream, so — unlike regex's `within` FILTER, which re-runs the prefix — the barrier's
 * values seed the stream directly. They are DATA, so they cross as ONE `json_each` bind (`jsonEachSet`),
 * in array order (a 1:1 map preserves stream order), and `scalarTail` continues the chain over them just
 * as `detachedTail` continues over a landed element relation. The values frame UNKNOWN (inferred from
 * the JS value) — the same tag the transform's own output carried, so nothing is re-guessed.
 */
/**
 * The shell BOTH value-source resumes share (`lowerValueResume`, `lowerListResume`) — the prologue that
 * mints, settles, derives the chain facts and declines a channel-demanding tail, the ONE `json_each` bind
 * of the DATA, and the `lowered()` epilogue. Only the SEED shape differs: a scalar `v` column vs a
 * `LIST_COL`, and the tail that continues over it. The seed is built by `seed(exploded, fresh)` and
 * threaded into `tail(seed, ctx, fresh)`, so each producer names its own column and re-entry vocabulary.
 */
function valueResume(
  data: readonly unknown[], steps: readonly IRStep[], from: number, opts: Lowering,
  seed: (exploded: Rel, fresh: Minter) => Rel,
  tail: (seed: Rel, ctx: ChainCtx, fresh: Minter) => Tail | null,
): RelLowering | null {
  const fresh = minter();
  const settled = settle(opts);
  const { ctx, facts } = chainCtxOf(steps.slice(from), settled);
  // A tail that tracks a PATH cannot be seeded from a bare value list (no path history crossed the
  // barrier), so it declines rather than compile a plan with the column silently missing. An
  // ENCOUNTER demand IS satisfiable: every seed below threads the array index (stream order) as the
  // encounter channel, so a terminal-emission-order tail is seeded rather than declined.
  if (facts.tracksPath) return null;
  // Bind the array index (`json_each.key`) as `RESUME_ORD`: it IS each value's STREAM POSITION, which
  // EVERY seed threads as an encounter channel — the list/map seeds so a later re-explode (`unfold()`)
  // emits an earlier traverser's members before a later one's, the scalar seed so a terminal-emission-order
  // retype tail keeps input order rather than declining.
  const exploded = jsonEachSet(VALUE_RESUME_PARAM, data, fresh, undefined, RESUME_ORD);
  const chain = tail(seed(exploded, fresh), ctx, fresh);
  return chain && lowered(chain, BaseGraph, settled.propertySeek, settled.ftsSubstringPredicate, settled.detached, fresh);
}

/** The column `valueResume` binds each value's array index (stream position) to — the list seed carries
 *  it as an encounter channel so re-injected stream order survives a later re-explode. */
const RESUME_ORD = 'so';

export function lowerValueResume(values: readonly unknown[], steps: readonly IRStep[], from: number, opts: Lowering = {}): RelLowering | null {
  return valueResume(values, steps, from, opts,
    // Carry the array index as an ENCOUNTER channel exactly as the list/map seeds do: the re-injected
    // values are in stream order (the array order), so a tail that demands a terminal emission order
    // (`asNumber().asDate().asNumber()` — a length->1 retype chain, `computeDemandsEncounter`) is seeded
    // from it rather than declined. A tail that owes no encounter simply never reads the column.
    (exploded, fresh) => make.project({
      id: fresh('vrp'), input: exploded, channels: [ENCOUNTER],
      type: typeOf(meta('v', 'any', true), meta(ENCOUNTER.col, 'int')),
      exprs: [['v', col(exploded.id, 'sv')], [ENCOUNTER.col, col(exploded.id, RESUME_ORD)]],
    }),
    (seed, ctx, fresh) => scalarTail(seed, { kind: 'scalar', type: UNKNOWN }, steps, from, false, ctx, fresh));
}

/**
 * THE LIST-SOURCE RESUME — substrate A's value arm for a barrier whose per-traverser output is a LIST
 * (`split()`), the list-shaped twin of `lowerValueResume`.
 *
 * The transform computed one list per traverser (a null passing straight through); the lists are DATA, so
 * they cross as ONE `json_each` bind and re-enter as a `LIST_COL`-carrying read framed `{list, of: BARE_
 * LIST}` — the same shape `inject([...])` produces, so a following list op (`unfold()`, a local reducer)
 * composes through `continueAs`'s list loop exactly as it would over an injected list. A scalar `value`
 * resume would frame each list as its JSON TEXT (a string on the wire), which is why the list producer
 * needs its own seed rather than reusing `lowerValueResume`.
 */
export function lowerListResume(lists: readonly unknown[], steps: readonly IRStep[], from: number, opts: Lowering = {}): RelLowering | null {
  return lowerListResumeOf(BARE_LIST, lists, steps, from, opts);
}

/**
 * `lowerListResume` with the MEMBER shape stated — `split()` re-injects a bare list (`BARE_LIST`), but a
 * value-transform whose output preserves the INPUT list's members (a bare `order`/`dedup(Scope.local)` over
 * a NESTED list) must re-frame them by that shape or a following `unfold()` mis-reads them. A nested `list`/
 * `map` member is itself a JSON collection, so a scalar `value` re-inject would frame it as its JSON TEXT
 * (a string on the wire) — hence the shape-carrying twin. `of` is DATA the caller carries from the pre-
 * barrier stream, never re-derived. (The order/dedup barrier declines an element-membered nested list, so
 * `of` here reaches only scalar/list/map members.)
 */
export function lowerListResumeOf(of: ListOf, lists: readonly unknown[], steps: readonly IRStep[], from: number, opts: Lowering = {}): RelLowering | null {
  // A NESTED member (a `list`/`map`) is itself a JSON collection, so the seed value carries `json(sv)` —
  // `json_each` hands back a nested element as its TEXT, and without the `json()` the framer would read a
  // string where an array belongs (`items.map is not a function`). A flat member (`BARE_LIST`, split's
  // case) needs no wrap: `sv` is already the scalar. `of` IS the member descriptor.
  const nested = of.kind === 'list' || of.kind === 'map';
  return valueResume(lists, steps, from, opts,
    // Carry the array index as an ENCOUNTER channel: each row is one traverser's list, and its stream
    // position is the emission order a later `unfold()` must lead its member sort with (`unfoldList`'s
    // `carried` reason). `renumber` in the framing/reduction path reads it identically.
    (exploded, fresh) => make.project({
      id: fresh('lrp'), input: exploded, channels: [ENCOUNTER],
      type: typeOf(meta(LIST_COL, 'json', true), meta(ENCOUNTER.col, 'int')),
      exprs: [[LIST_COL, nested ? jsonOf(col(exploded.id, 'sv')) : col(exploded.id, 'sv')],
        [ENCOUNTER.col, col(exploded.id, RESUME_ORD)]],
    }),
    (seed, ctx, fresh) => continueAs(seed, { kind: 'list', of }, steps, from, false, ctx, fresh, NO_ALIASES));
}

/**
 * THE MAP-SOURCE RESUME — substrate A's value arm for a barrier whose per-traverser output is a MAP (a
 * global `order()` over a map stream), the map-shaped twin of `lowerListResumeOf`. Each datum is a map's
 * PAIRS array `[[keyNode,valNode],…]` (self-describing `{t,v}` sides); the maps cross as ONE `json_each`
 * bind and re-enter as a `MAP_COL`-carrying read framed `{kind:'map', keyOf/valOf: scalar}` — the same
 * shape `inject($map)` produces, so a following map op (`unfold()`, `select`, `count(local)`) composes.
 * `json(sv)` turns each member back into the JSONB pairs blob the map framer reads (json_each hands it
 * back as TEXT). The array index rides as an ENCOUNTER channel for the `unfold()` stream-order reason.
 */
export function lowerMapResumeOf(maps: readonly unknown[], steps: readonly IRStep[], from: number, opts: Lowering = {}): RelLowering | null {
  return valueResume(maps, steps, from, opts,
    (exploded, fresh) => make.project({
      id: fresh('mrp'), input: exploded, channels: [ENCOUNTER],
      type: typeOf(meta(MAP_COL, 'json', true), meta(ENCOUNTER.col, 'int')),
      exprs: [[MAP_COL, jsonOf(col(exploded.id, 'sv'))], [ENCOUNTER.col, col(exploded.id, RESUME_ORD)]],
    }),
    (seed, ctx, fresh) => continueAs(seed, { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } }, steps, from, false, ctx, fresh, NO_ALIASES));
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
  const { params, collapse, correlatedChildren, labelRegime, sideEffects, sideEffectPolicies, services, sack, collections, source } = settle(opts);
  const facts = analyzeChain(steps as IRStep[]);
  return {
    facts,
    ctx: {
      params, correlatedChildren, collapse, ordered: facts.demandsEncounter, sliced: facts.demandsSlice, tracksPath: facts.tracksPath,
      demandsPathLabels: facts.demandsPathLabels,
      labelRegime, source, sideEffects, sideEffectPolicies, services, sack, collections,
      mutating: steps.some((step) => MUTATING_STEPS.has(step.name)),
    },
  };
}

export function lowerChain(steps: readonly IRStep[], opts: Lowering, fresh: Minter): Tail | null {
  const { ctx, facts } = chainCtxOf(steps, opts);
  const { params } = ctx;
  const ordered = facts.demandsEncounter;
  const tracksPath = facts.tracksPath;
  const orderedChannels = ordered ? withChannel(BULK, ENCOUNTER) : BULK;
  const pathChannels = tracksPath ? withChannel(orderedChannels, PATH_CHANNEL) : orderedChannels;
  const first = steps[0];
  if (!first) return null;
  // A `graphTag` on the source step (a multi-graph merge arm, nested-branch federate) seeds a `graph`
  // channel carrying that graph's identity, so `dedup` over the merged stream keeps per-graph identity.
  const seedChannels = first.graphTag != null ? withChannel(pathChannels, GRAPH) : pathChannels;

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
    // A scalar CAST directly on a COLLECTION traverser RAISES, and that answer beats the collection
    // shape. `asNumber`/`asBool`/`asDate` are `ScalarMapStep`s over the whole traverser, and a list or
    // map is parseable as none of number/bool/date — `AsNumberStep.map` throws *"Can't parse type
    // ArrayList as number."*. So `inject([…]).asBool()` is not a list to slice; it is a compile-time
    // fold that raises (SQL cannot). Skipping the map/list arms routes it to `injectSource`, whose fold
    // is the one authority for that message. Gated on the cast at POSITION 1: an `unfold()`/`local`
    // between has already decomposed the collection, so those keep the collection-shape lowering.
    const castsCollection = steps[1] != null && CONSTANT_FOLDED.has(steps[1]!.name)
      && first.args.some((a) => Array.isArray(a.value) || a.value instanceof Map);
    // A MAP literal seeds a MAP traverser, a COLLECTION literal a LIST one, an ordinary value a SCALAR
    // one — three shapes, and the ARGUMENT decides which. A `Map` is neither an array nor a scalar, so
    // the arms are disjoint and their order is only which decline is spelled first.
    const mapped = castsCollection ? null : injectMap(first, ordered, fresh);
    if (mapped) {
      const withSack = sacked(mapped.rel);
      return withSack && continueAs(withSack, mapped.framing, steps, 1, false, ctx, fresh, NO_ALIASES);
    }
    // A COLLECTION literal seeds a LIST traverser, an ordinary value a SCALAR one — two shapes, and
    // the argument decides which, so the list arm is asked first and declines a scalar inject.
    const listed = castsCollection ? null : injectList(first, ordered, fresh);
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
  const elem0: Elem = first.name === 'E' ? 'edge' : 'vertex';
  // A `landedSource` marker (the nested-branch federate segment's arm rewrite) re-roots this read at a
  // LANDED graph — a `boundGraph` over its named CTE bindings — instead of `ctx.source`. The arm's whole
  // continuation (the source filters below and the leaf) reads through that bound source too, so every
  // downstream call in this block goes through `readCtx`, not `ctx`.
  const readCtx: ChainCtx = first.landedSource
    ? { ...ctx, source: boundGraph(first.landedSource.vertexBinding, first.landedSource.edgeBinding) }
    : ctx;
  const seeded = readCtx.source.elementScan(elem0, first.args, fresh);
  if (!seeded) return null;

  // PHASE 1 — the source scan and the filters that fuse into its own WHERE. Kept separate from the
  // general fold below because only here is the physical row in scope: an edge's `label` is a
  // column to read rather than a membership test, and a run of filters conjoins into ONE `WHERE`
  // over one scan instead of a CTE-per-filter with its re-join.
  let pred = seeded.pred;
  let at = 1;
  let elem = elem0;
  for (; at < steps.length; at++) {
    const clause = sourceFilter(steps[at], { kind: 'element', id: col(seeded.scan.id, 'id'), label: elem === 'edge' ? col(seeded.scan.id, 'label') : undefined, rel: seeded.scan, elem }, fresh, readCtx);
    if (!clause) break;
    pred = and(pred, clause);
  }

  const source = pred ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred }) : seeded.scan;
  // The `Filter` this builds over a bare element scan is what `src/rel/passes/semijoin.ts` reads: a
  // selective property predicate here can only be CHECKED, and the pass is what turns it into the
  // relation the plan is driven from. Deliberately not decided here — recognising it on the ALGEBRA
  // means it cannot drift with which STEPS happen to fold into this run.
  // The seed of the emission order is the ROWID: a scan's
  // natural order is the only order a bare source has, and naming it makes every later slice ask
  // the same question of the same column instead of of whatever SQLite happened to produce.
  const rel = make.project({
    id: fresh('c'), input: source, channels: seedChannels, type: typeOf(...elementCols(seedChannels)),
    exprs: [['id', col(source.id, 'id')], ...seedChannels.map((channel) => [channel.col,
      channel.role === 'bulk' ? compilerInt(1)
        : channel.role === 'encounter' ? col(source.id, 'id')
          : channel.role === 'graph' ? compilerText(first.graphTag!)
            : seedPath({ kind: 'element', elem, id: col(source.id, 'id') }, facts.demandsPathLabels),
    ] as const)],
  });

  const withSack = sacked(rel);
  return withSack && elementTail(withSack, elem, steps, at, false, readCtx, fresh, NO_ALIASES);
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
  subgraph = false, bulked = false,
): Tail | null {
  const step = steps[from];
  // `bulked` rides forward from a movement collapse: at the terminal the leaf reads it to RE-EXPAND the
  // collapsed rows on the wire, and a reducer reads `SUM(bulk)` — the same flag the base fold threads.
  if (!step) return { rel: seed, framing: { kind: 'detached', elem }, bulked, aliases: NO_ALIASES };
  const source = ctx.source;

  if (subgraph) {
    // `.V()`/`.E()` RE-ROOT at the landed relation, discarding the stream (`sg.traversal().V()`).
    // `V(ids)`/`E(ids)` narrow by an inline id list (a bound id parameter is not modelled).
    if (step.name === 'V' || step.name === 'E') {
      const kind: Elem = step.name === 'V' ? 'vertex' : 'edge';
      const seeded = source.elementScan(kind, step.args, fresh);
      if (!seeded) return null;
      const filtered = seeded.pred ? make.filter({ id: fresh('bvf'), input: seeded.scan, channels: [], type: seeded.scan.type, pred: seeded.pred }) : seeded.scan;
      // ID-CARRY + channels: the re-rooted stream carries the id and the traverser channels a base source
      // does — `bulk` (=1) ALWAYS so a convergent walk can collapse, `encounter` minted from the landed
      // order (`FOREIGN_ORD`) only when the chain DEMANDS one (collapse and an order are mutually
      // exclusive). The landed payload is rejoined at each read.
      const withBulk = make.project({
        id: fresh('bvb'), input: filtered, channels: BULK,
        type: typeOf(meta('id', 'any', true), meta(FOREIGN_ORD, 'int'), meta('bulk', 'int')),
        exprs: [['id', col(filtered.id, 'id')], [FOREIGN_ORD, col(filtered.id, FOREIGN_ORD)], ['bulk', compilerInt(1)]],
      });
      // A re-root starts a FRESH path (`sg.traversal().V()` — TinkerPop's re-source discards the prior
      // stream), so when the chain tracks a path the re-rooted element is position 0, seeded exactly as
      // the bound source seed does. `tracksPath && demandsEncounter` declined at the resume, so an ordered
      // encounter and a path never coexist on this stream — the branches stay disjoint.
      const rel = ctx.tracksPath
        ? (() => {
          const channels = withChannel(BULK, PATH_CHANNEL);
          return make.project({
            id: fresh('bvp'), input: withBulk, channels,
            type: typeOf(meta('id', 'any', true), ...carriedCols(channels)),
            exprs: [['id', col(withBulk.id, 'id')],
              ...channels.map((channel) => [channel.col,
                channel.role === 'bulk' ? col(withBulk.id, 'bulk')
                  : seedPath({ kind: 'element', elem: kind, id: col(withBulk.id, 'id') }, ctx.demandsPathLabels)] as const)],
          });
        })()
        : ctx.ordered
        ? renumber(withBulk, [{ expr: col(withBulk.id, FOREIGN_ORD), dir: 'asc' }],
          [meta('id', 'any', true), ...carriedCols(withChannel(BULK, ENCOUNTER))], withChannel(BULK, ENCOUNTER), fresh)
        : make.project({
          id: fresh('bvi'), input: withBulk, channels: BULK, type: typeOf(meta('id', 'any', true), meta('bulk', 'int')),
          exprs: [['id', col(withBulk.id, 'id')], ['bulk', col(withBulk.id, 'bulk')]],
        });
      return detachedTail(rel, kind, steps, from + 1, ctx, fresh, subgraph);
    }
    // MOVEMENT (out/in/both AND the endpoint reads inV/outV/bothV) through the SHARED `movement` builder,
    // sourced from the landed edges. Only INLINE string labels are modelled (the landed edge label is a
    // TEXT column filtered by IN); a bound label PARAMETER and the out(null) form both decline.
    if (HOPS[step.name]) {
      const asked = labelSetArgs(step.args);
      if (!asked || (asked.given && !asked.labels.length)) return null;
      if (!asked.labels.every((a) => a.name == null && typeof a.value === 'string')) return null;
      const moved = movement(step, { rel: seed }, elem, source, fresh);
      if (!moved) return null;
      // COLLAPSE a convergent bound walk exactly as `elementTail` does over the base graph — the SAME
      // four conditions: the fast path is on, no emission order is live, every carried channel has a
      // group policy, AND the SUFFIX observes the multiplicity (`bulkObservedFrom` — a reducer consumes
      // the `SUM(bulk)`, or the `elements` framing carries it to the wire). Without the last, a chain
      // that retypes to a scalar (`…out().values()`) would answer N traversers as one row. The bound
      // movement already carries `bulk` (the seed mints it), so `coalesce` is the same
      // `SUM(bulk) GROUP BY id` RLE the base uses.
      const collapsing = ctx.collapse && !encounterOf(moved.rel.channels) && groupableChannels(moved.rel.channels)
        && bulkObservedFrom(steps, from + 1);
      return detachedTail(collapsing ? coalesce(moved.rel, fresh) : moved.rel, moved.elem, steps, from + 1, ctx, fresh, subgraph, collapsing || bulked);
    }
    // FILTERS (hasLabel / has(...) / hasId / is) through the SHARED `sourceFilter`, whose physical reads
    // route through `ctx.source`. Strictly MORE than the deleted twin covered (every predicate form
    // composes, plus the 3-arg has(label,key,value) desugaring) at no extra cost: one clause over the
    // id-carrying stream.
    const subject: Subject = { kind: 'element', id: col(seed.id, 'id'), elem, rel: seed };
    const clause = sourceFilter(step, subject, fresh, ctx);
    if (clause) {
      const filtered = make.filter({ id: fresh('bff'), input: seed, channels: seed.channels, type: seed.type, pred: clause });
      return detachedTail(filtered, elem, steps, from + 1, ctx, fresh, subgraph, bulked);
    }
  }
  // SHAPE-AGNOSTIC row ops over ANY landed element stream — `count()` reads cardinality (a landed row IS
  // one traverser) and `dedup()` collapses by element identity (`id` functionally determines the tuple).
  if (step.name === 'count' && step.args.length === 0 && !isLocalScope(step)) {
    const counted = countTail(seed, fresh);
    return continueAs(counted.rel, counted.framing, steps, from + 1, false, ctx, fresh, NO_ALIASES);
  }
  // `dedup()` collapses by element identity (`id` functionally determines the tuple). A whole-row
  // `Distinct` IS dedup-by-id only when the row carries NO channel: an `encounter` makes every row unique
  // (Distinct collapses nothing) and a `bulk` must be RESET to 1 by the survivor (a Distinct would keep
  // the collapsed multiplicity). Both are what the MAIN FOLD's dedup does, so the shortcut is taken only
  // for a channel-less stream (a homogeneous list); otherwise dedup falls through to the handoff.
  if (step.name === 'dedup' && step.args.length === 0 && !isLocalScope(step) && !step.modulators?.length && !step.optionArms
    && seed.channels.length === 0) {
    const deduped = make.distinct({ id: fresh('dtd'), input: seed, channels: seed.channels, type: seed.type });
    return detachedTail(deduped, elem, steps, from + 1, ctx, fresh, subgraph);
  }
  // id() / label() — the element's tokens, REJOINED from the landed relation by id via `ctx.source`.
  if (step.name === 'id' || step.name === 'label') {
    if (step.args.length) return null;
    const value = step.name === 'id' ? source.externalId(elem, col(seed.id, 'id'), fresh) : source.labelScalar(elem, col(seed.id, 'id'), fresh);
    const rel = make.project({ id: fresh('fgs'), input: seed, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', value]] });
    // An id frames as whatever it was STORED as (uid string or rowid int) — no static tag; a label is a string.
    return scalarTail(rel, { kind: 'scalar', type: step.name === 'label' ? STATIC('string') : UNKNOWN }, steps, from + 1, bulked, ctx, fresh);
  }
  // values(k…) — one scalar per matching property VALUE, rejoined from the landed `{t,v}` tree.
  if (step.name === 'values') {
    const keys = step.args.map((a) => a.value).filter((key): key is string => typeof key === 'string');
    if (keys.length !== step.args.length) return null;
    return scalarTail(source.propertyValues(seed, elem, keys, fresh), { kind: 'scalar', type: PER_ROW('vtype') }, steps, from + 1, bulked, ctx, fresh);
  }
  // labels() — the label FAN-OUT, rejoined from the landed relation and order-minted exactly as the base
  // `labels()` is: `source.labelNames` supplies (name, `lord`) rows, this mints the emission order. Where
  // the bound stream ARRIVES with an encounter (a subgraph seed now seeds one), that is the cross-origin
  // order and `lord` is the within-vertex tiebreak; with none, `lord` alone (label-dictionary order,
  // base; JSON-array order, bound) — the same two-key rule the base `labels()` uses.
  if (step.name === 'labels' && !step.args.length && !step.modulators?.length && !step.optionArms) {
    const named = source.labelNames(seed, elem, fresh);
    const arriving = encounterOf(named.channels);
    const channels = arriving ? named.channels : withChannel(named.channels, ENCOUNTER);
    const ranked = renumber(named,
      [{ expr: col(named.id, arriving ? arriving.col : 'lord'), dir: 'asc' }, { expr: col(named.id, 'lord'), dir: 'asc' }],
      [meta('v', 'text'), ...carriedCols(channels)], channels, fresh);
    return scalarTail(ranked, { kind: 'scalar', type: STATIC('string') }, steps, from + 1, bulked, ctx, fresh);
  }
  // HAND OFF TO THE MAIN FOLD for everything else — `group()`/`groupCount()`/`order()`/`project()`/
  // `fold()`/the reducers/… — so a bound element composes the FULL aggregation vocabulary through the
  // ONE fold with `ctx.source = BoundGraph`. Every physical read those steps make (movement, `by()`
  // keys via `byExpr` → `source.externalId`/`labelScalar`/`propertyScalar`, the terminal leaf via
  // `source.leafPayload`) is source-routed, so the answer is the bound graph's.
  //
  // FAIL CLOSED on the reads that are NOT yet source-routed: a WRITE, or a `properties()`/`valueMap()`
  // element-bag read, would run against THIS graph's tables keyed by a FOREIGN id — a plausible WRONG
  // answer (an id collision returns another graph's row). Those decline until routed. `properties()`
  // additionally has no landed identity to give (a detached VertexProperty has no rowid), so it is a
  // genuine wall, not merely unrouted.
  // Only a SUBGRAPH (adjacency + vertices landed) hands off — a homogeneous detached list has no live
  // graph to aggregate a `group().by(__.out()…)` over, and its movement must keep failing closed with
  // the barrier message rather than reaching a half-present `BoundGraph`. The decline set
  // (`BOUND_HANDOFF_DENY`: writes — a detached snapshot is immutable — and element-bag reads that scan
  // base tables by a foreign id) is owned by the ONE tail classifier (`contentDemand`, ir/content-demand.ts):
  // the same fact a future fetch decision reads, so the two provably agree.
  if (!subgraph || contentDemand(steps, from).handoffDenied) return null;
  return continueAs(seed, { kind: 'elements', elem }, steps, from, bulked, ctx, fresh, NO_ALIASES);
}

/** The steps between an edge hop and an `otherV()` that leave the EDGE and its `fromV` channel intact —
 *  the filter family, `as`, `identity`, and the order/slice family (a sort or window carries every
 *  channel through). A `fromV` channel is minted at the edge hop only if scanning forward through these
 *  reaches an `otherV`, so a non-transparent step in between stops the scan and the edge stays plain.
 *  `dedup` is DELIBERATELY absent: it GROUPS by id (group policy `undefined` for `fromV`), so a live
 *  `fromV` would either mis-collapse or decline — `bothE().dedup().otherV()` fails closed instead, its
 *  entering vertex genuinely ambiguous once convergent edges merge. */
const FROM_V_TRANSPARENT: ReadonlySet<string> = new Set([
  'hasLabel', 'has', 'hasId', 'hasKey', 'hasValue', 'where', 'not', 'filter', 'and', 'or',
  'simplePath', 'cyclicPath', 'identity', 'as', 'order', 'limit', 'range', 'skip', 'tail',
]);

/** Does the edge stream produced at `at` flow into an `otherV()` — through `FROM_V_TRANSPARENT` steps
 *  only — so the edge hop must retain its entering vertex? `atEnd` is what a body's LAST edge answers
 *  when the scan runs off the end (the enclosing chain will apply `otherV` to the body's result). */
export function edgeFeedsOtherV(steps: readonly IRStep[], at: number, atEnd: boolean): boolean {
  for (let i = at + 1; i < steps.length; i++) {
    if (steps[i]!.name === 'otherV') return true;
    if (!FROM_V_TRANSPARENT.has(steps[i]!.name)) return false;
  }
  return atEnd;
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
    // `UnfoldStep` yields a non-container object itself (`IteratorUtils.of(s)`), so the second
    // `unfold()` after an entry value's element-list expansion is an identity, not a deferral.
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/UnfoldStep.java:42-53`.)
    if (step.name === 'unfold') {
      if (step.args.length) return null;
      continue;
    }
    // `otherV()` — the edge's OTHER endpoint, off the `fromV` the entering edge hop retained. Not a HOP
    // (it reads a carried channel, not the adjacency table by direction), so it is dispatched here.
    if (step.name === 'otherV') {
      if (step.args.length || step.modulators?.length || step.optionArms) return null;
      const other = otherVertex(rel, elem, ctx.source, fresh, ctx.demandsPathLabels);
      if (!other) return null;
      rel = other.rel;
      elem = other.elem;
      continue;
    }
    // An EDGE hop retains its entering vertex (`fromV`) only when an `otherV()` will consume it — after
    // this edge in the current slice, or (a `local`/`flatMap` body's tail edge) an `otherV()` the
    // enclosing chain applies to the body's result (`ctx.needsFromV`).
    const mintFromV = EDGE_MOVES.has(step.name) && edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
    const moved: { rel: Rel; elem: Elem } | null = movement(step, { rel }, elem, ctx.source, fresh, ctx.demandsPathLabels, mintFromV);
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
    const clause = sourceFilter(step, { kind: 'element', id: col(rel.id, 'id'), rel, elem }, fresh, ctx, labels);
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
      // Labels-on-path (gated): `as('x')` also records 'x' at the CURRENT path position (its last entry),
      // so a later `from`/`to` can slice by label. One append per label; a no-op unless a `from`/`to` is
      // in the chain, so an ordinary `as()` in a path query is untouched.
      if (ctx.demandsPathLabels && pathCarried(rel))
        for (const { value: name } of step.args) if (typeof name === 'string') rel = appendPathLabel(rel, name, fresh);
      continue;
    }
    // THE SHARED COLLECTION VOCABULARY — `select` (a re-root to an aliased object), `group`/`groupCount`,
    // `aggregate`, `cap`, `project` — the one helper both tails share, reading `by()` through this fold's
    // `elementHost` and framing the elements. Same lowering the scalar tail reaches (§6·6).
    const armed = collectionArm(step, rel, elementHost(rel, elem, labels), { kind: 'elements', elem }, bulked, steps, at, ctx, fresh, labels,
      (nextAt) => elementTail(rel, elem, steps, nextAt, bulked, ctx, fresh, labels));
    if (armed === 'continue') continue;
    if (armed !== 'pass') return armed.tail;
    // `match()` — the conjunctive pattern step. It re-roots each pattern body at its start alias and
    // folds it through the CHILD SEAM (the same fold this chain is), rejoining by binding or
    // constraining each end. It produces a bindings-map/alias-carrying stream, so it hands back to the
    // ONE dispatcher exactly like `select`. See `match.ts` and `docs/2026-08-13-match-relir-lowering-plan.md`.
    if (step.name === 'match') {
      if (pathCarried(rel)) return null;
      const matched = lowerMatch(step, rel, elem, labels, ctx.params, childSeam(ctx, fresh), ctx.source, fresh);
      if (!matched) return null;
      return continueAs(matched.rel, matched.framing, steps, at + 1, false, ctx, fresh, matched.aliases);
    }
    // THE PER-TRAVERSER CHILD HOSTS — one lowering, three cardinality policies (`perTraverserChild`).
    // When an `otherV()` reads what this host produces (`local(bothE()).otherV()`), the body's tail edge
    // must retain its entering vertex — signalled by `needsFromV`, honoured only on the `flatMap`/`local`
    // rejoin (no peer merge). A vertex/scalar host result declines `otherV` at the consumer, harmlessly.
    if (PER_TRAVERSER_HOSTS.has(step.name)) {
      const feeds = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
      const hostCtx = feeds === (ctx.needsFromV ?? false) ? ctx : { ...ctx, needsFromV: feeds };
      return perTraverserChild(step, rel, { kind: 'elements', elem }, steps, at, bulked, hostCtx, fresh, labels);
    }
    if (BRANCH_HOSTS.has(step.name)) {
      const framing = { kind: 'elements', elem } as const;
      // An `otherV()` reading the merged edge stream (`coalesce(outE,outE).otherV()`): every arm's tail
      // edge mints `fromV`, and the peer merge carries it because all arms mint it uniformly (`mergeArms`).
      const feeds = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
      const hostCtx = feeds === (ctx.needsFromV ?? false) ? ctx : { ...ctx, needsFromV: feeds };
      const merged = branchArms(step, rel, framing, bulked, hostCtx, fresh, labels);
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
      // `from`/`to` scope to a SUB-path (`subPathMembers`, via the labels-on-path recorded when
      // `ChainFacts.demandsPathLabels` gated them on).
      if (!pathCarried(rel) || step.optionArms || (step.args ?? []).length) return null;
      const positions = pathPositions(rel, step, childSeam(ctx, fresh), ctx.source, fresh);
      if (!positions) return null;
      return continueAs(positions.rel, { kind: 'path', of: positions.of, scalars: positions.scalars }, steps, at + 1, false, ctx, fresh, labels);
    }
    if (step.name === 'simplePath' || step.name === 'cyclicPath') {
      // `Path.isSimple()` is "no two path objects are equal" (`PathIsSimpleStep`); `cyclicPath` its
      // complement. Every position is a tagged history entry (`{k,v[,t]}`), and equal objects — an
      // element by rowid, a value by (value,type) — produce the IDENTICAL entry, so uniqueness is a
      // COUNT(DISTINCT) over the path array against its length. `from`/`to` scope the check to a
      // SUB-path (`Path.subPath` — the labels-on-path slice).
      if (!pathCarried(rel) || step.optionArms || (step.args ?? []).length) return null;
      // A `by(<proj>)` modulator compares each position by its PROJECTION rather than by the object
      // (`pathSimpleByPredicate`); the bare form compares the raw objects (`pathSimplePredicate`).
      const cyclic = step.name === 'cyclicPath';
      const pred = step.modulators?.length
        ? pathSimpleByPredicate(rel, cyclic, step, childSeam(ctx, fresh), ctx.source, fresh)
        : pathSimplePredicate(rel, cyclic, step.from, step.to, fresh);
      if (!pred) return null;
      rel = make.filter({ id: fresh('spf'), input: rel, channels: rel.channels, type: rel.type, pred });
      continue;
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
    // THE PROJECTORS — a RETYPE from an element traverser to a value, exactly as `values()`/`count()`
    // are, so they hand the relation to `continueAs` and the scalar tail takes the rest of the chain.
    // They are not in `terminal()` with them because they HOST a `by()`, which every arm there declines.
    if (REL_PROJECTORS.has(step.name)) {
      // A carried PATH declines for `terminal()`'s reason: the value is a new traverser object and
      // nothing here appends it as a path position.
      if (pathCarried(rel)) return null;
      const projected = projectorTail(rel, step, elementHost(rel, elem, labels), childSeam(ctx, fresh), ctx.source, fresh);
      if (!projected) return null;
      return continueAs(projected.rel, projected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }
    // `fold()` — the SHAPE BOUNDARY out of the element loop, the twin of the scalar tail's own. Every
    // traverser becomes one MEMBER of one list traverser, and for elements the member is the rowid:
    // `listPayload` expands it at the root, so a following `range(local)`/`unfold().limit(1)` throws
    // rows away before anything computes a property bag for them.
    if (step.name === 'fold') {
      if (step.args.length || isLocalScope(step) || step.modulators?.length) return null;
      // `fold()` is a COLLECTING BARRIER: it gathers the surviving element traversers into one list and
      // emits a single new traverser, so any carried path is consumed with them (`dropPath`). A
      // `simplePath().fold()` collects the elements that survived the filter — the path did its work.
      rel = dropPath(rel, fresh);
      const encounter = encounterOf(rel.channels);
      const folded = foldElements(rel, elem, encounter ? { order: [encounter.col] } : {}, fresh);
      return listTail(folded.rel, folded.of, steps, at + 1, ctx, fresh, labels);
    }
    // `sack(Operator.x).by(v)` MUTATES the accumulator and leaves the traverser alone, so it is an
    // ordinary shape-preserving step of this loop. The bare READ form is a RETYPE and falls through
    // to `terminal()`, which is where every element→value boundary lives.
    if (step.name === 'sack' && sackOperator(step) !== undefined) {
      const folded = sackMutate(step, rel, elementHost(rel, elem, labels), childSeam(ctx, fresh), ctx.source, fresh);
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
    // `dedup(k1, …, kn)[.by(proj)]` — a KEYED dedup on the bound alias tuple, on the ELEMENT stream
    // BEFORE any `select`. The traverser stays the current element; only the first per-tuple survives.
    // `dedupByLabels` reads each label's `Pop.last` off the live alias map and ranks the survivor's
    // whole payload, so a following `select('a','b')`/`path()` reads a field the dropped duplicates
    // could differ on. The RECORD tail wires the SAME helper for the post-`select` form; this is the
    // pre-`select` one, and the only missing caller (the algebra was already built).
    if (step.name === 'dedup' && !isLocalScope(step) && (step.args ?? []).length && !step.optionArms) {
      const keys = step.args.map((a) => a.value);
      if (keys.every((k) => typeof k === 'string')) {
        const bys = modulations(step, 1, childSeam(ctx, fresh));
        if (!bys) return null;
        const deduped = dedupByLabels(step, rel, labels, keys as string[], bys[0], ctx, fresh);
        if (!deduped) break;
        rel = deduped;
        bulked = false;
        continue;
      }
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

  // A carried path meets a RETYPE (`count`/`values`/`id`/`label`/`valueMap`/`constant`/…). Every terminal
  // here produces a NEW traverser — a reducing barrier consumes the stream, a value producer replaces it.
  // `values()` is a MapStep that records its produced value as the next path OBJECT, and it preserves the
  // carried channels through `propertyValues`, so the path rides into the scalar and a value position is
  // APPENDED (`appendValuePosition`); the path then frames at a later `path()` or drops at a barrier
  // (the scalar tail's own path discipline). Every OTHER terminal drops the path here (`dropPath`): a
  // reducing barrier consumes it (`simplePath().count()` counts what the filter kept), and `id`/`label`/
  // `valueMap` do not yet carry channels through, so appending is not expressible for them — fail closed
  // rather than framing a history with a step silently missing.
  if (pathCarried(rel) && steps[at].name !== 'values') rel = dropPath(rel, fresh);
  const retyped = terminal(steps[at], rel, elem, fresh, ctx, labels);
  if (!retyped) return null;
  if (steps[at].name === 'values' && retyped.framing.kind === 'scalar' && pathCarried(retyped.rel))
    return continueAs(appendValuePosition(retyped.rel, retyped.framing.type, fresh), retyped.framing, steps, at + 1, bulked, ctx, fresh, labels);

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
export function continueAs(
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
    case 'map': return mapTail(rel, framing.keyOf, framing.valOf, steps, from, ctx, fresh, labels, framing.keys);
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
    const grouped = groupBarrier(rel, host, step, bulked, childSeam(ctx, fresh), ctx.source, fresh);
    return grouped && continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, from + 1, false, ctx, fresh, NO_ALIASES);
  }

  // A CORRELATED FILTER over a property traverser — `where`/`filter`/`not`/`and`/`or`, the SAME
  // `sourceFilter` vocabulary the element and scalar hosts use, reachable now that a property is a
  // `Subject`. It PRESERVES the shape (a filter drops property rows, never retypes them), so it recurses
  // like a row op. `is` is deliberately NOT in `SCALAR_FILTER_HOSTS` — a property has no single value to
  // compare, so a value predicate declines rather than answering off the wrong column.
  if (SCALAR_FILTER_HOSTS.has(step.name)) {
    const subject: Subject = { kind: 'property', id: propertyRowId(rel), ownerElem: elem, rel };
    const clause = sourceFilter(step, subject, fresh, ctx, labels);
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
  // A bound VertexProperty NOW carries its landed identity: the detached compile lands `vpid`, which
  // `boundPropertyRelation` reads into `p_id`, so `properties().id()` over a bound vertex frames the
  // real property id through `propertyId` below (a lossy landing without `vpid` frames null, the
  // pre-detached behaviour). An edge `Property` still has no id and declines via the vertex-only arm.
  const retyped = step.name === 'key' ? propertyKey(rel, fresh)
    // `VertexProperty.label()` IS its key — `return this.key();`
    // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/VertexProperty.java:79-81`)
    // — so it is the same projection and not a second one. An edge `Property` is NOT an Element and has
    // neither a label nor an id, so both decline there rather than answering off the stored row: upstream
    // would raise a ClassCastException, and a plausible answer to an invalid traversal is worse.
    : step.name === 'label' && elem === 'vertex' ? propertyKey(rel, fresh)
      : step.name === 'id' && elem === 'vertex' ? propertyId(rel, fresh)
        : step.name === 'value' ? propertyValue(rel, fresh)
          : step.name === 'asString' ? propertyAsString(rel, elem, fresh)
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

/**
 * A COMPOUND alias-compare predicate over IDENTITIES — `where(k, P.not(P.eq('a').or(P.eq('d'))))` — as a
 * boolean expression, or `null` to decline.
 *
 * `WherePredicateStep` composes `eq`/`neq`/`and`/`or`/`not` over `selectKey` operands; without a `by()`
 * the comparison is over the elements' rowids (TinkerPop compares by IDENTITY there). The recursion
 * mirrors `predicateExpr`'s connective handling, except a leaf operand is a LABEL resolved to
 * `aliasIdAt` rather than a literal — and only `eq`/`neq` have identity meaning, so an ordering leaf
 * declines (that is the `by()`-value form, a further phase). Every referenced label must be a LIVE
 * element alias or the whole predicate declines, fail closed.
 */
function aliasIdentityPred(pred: unknown, startId: Expr, rel: Rel, labels: AliasMap, fresh: Minter): Expr | null {
  if (!isPred(pred)) return null;
  const { op, operands } = pred;
  if (op === 'not') { const inner = aliasIdentityPred(operands[0]!.value, startId, rel, labels, fresh); return inner && { kind: 'unary', op: 'not', arg: inner }; }
  if (op === 'and' || op === 'or') {
    const parts = operands.map((o) => aliasIdentityPred(o.value, startId, rel, labels, fresh));
    return parts.every((p): p is Expr => !!p) ? parts.reduce((a, b) => ({ kind: 'binary', op, left: a, right: b })) : null;
  }
  if ((op === 'eq' || op === 'neq') && operands.length === 1 && typeof operands[0]!.value === 'string') {
    const proj = aliasProjection(rel, labels, operands[0]!.value, 'last', fresh);
    if (!proj || proj.read.kind !== 'element') return null;
    const same = eq(startId, aliasIdAt(col(rel.id, proj.entry.col), 'last'));
    return op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same };
  }
  return null; // an ordering leaf has no identity meaning — it is the by()-value form, a later phase
}

/**
 * A COMPOUND alias-compare under a `by()`-RING — `where('a', P.lt('b').or(P.gt('c'))).by('age').by('weight')`
 * — as a filter clause, or `null`/`'decline'`.
 *
 * `WherePredicateStep` (`filter`/`setPredicateValues`) resolves EACH selectKey through the NEXT `by()` in
 * a cycling `TraversalRing`, in encounter order: the startKey takes `by[0]`, then each predicate LEAF's
 * operand label takes `by[1]`, `by[2]`, … cycling, walking the `ConnectiveP` tree left-to-right. The LHS
 * (the startKey's value) is computed ONCE and every leaf compares against it. Any non-productive
 * projection drops the row (`isProductive()` → `false`), which the conjoined `IS NOT NULL` productivity
 * terms reproduce (a `ProductiveByStrategy` keep-null is not built, so that declines, matching the
 * single-binary path).
 */
function aliasValueWhere(
  step: IRStep, startKey: string, pred: unknown, rel: Rel, labels: AliasMap, ctx: ChainCtx, fresh: Minter,
): Rel | 'decline' | null {
  const startProj = aliasProjection(rel, labels, startKey, 'last', fresh);
  if (!startProj || startProj.read.kind !== 'element') return null; // a scalar-alias theta is unbuilt
  const ring = modulations(step, step.modulators?.length ?? 0, childSeam(ctx, fresh));
  if (!ring || !ring.length) return null;
  const seam = childSeam(ctx, fresh);
  const hostOf = (proj: NonNullable<ReturnType<typeof aliasProjection>>): ChildHost =>
    ({ kind: 'element', id: aliasIdAt(col(rel.id, proj.entry.col), 'last'), elem: (proj.read as { elem: Elem }).elem, row: { rel, aliases: labels } });
  const lhs = byExpr(ring[0]!, hostOf(startProj), ctx.source, fresh, true, seam);
  if (!lhs) return 'decline';
  const lhsProd = productivityFilter(step, lhs);
  if (!lhsProd) return 'decline'; // keep-null (ProductiveByStrategy) not built
  const prod: Expr[] = [lhsProd];
  let ringIdx = 1; // startKey took ring[0]; leaves cycle from ring[1] in tree-walk order
  const build = (p: unknown): Expr | null => {
    if (!isPred(p)) return null;
    if (p.op === 'not') { const inner = build(p.operands[0]!.value); return inner && { kind: 'unary', op: 'not', arg: inner }; }
    if (p.op === 'and' || p.op === 'or') {
      const parts = p.operands.map((o) => build(o.value));
      return parts.every((x): x is Expr => !!x) ? parts.reduce((a, b) => ({ kind: 'binary', op: p.op as 'and' | 'or', left: a, right: b })) : null;
    }
    if (!ALIAS_CMP[p.op] || p.operands.length !== 1 || typeof p.operands[0]!.value !== 'string') return null;
    const proj = aliasProjection(rel, labels, p.operands[0]!.value, 'last', fresh);
    if (!proj || proj.read.kind !== 'element') return null;
    const by = ring[ringIdx % ring.length]!; ringIdx++;
    const val = byExpr(by, hostOf(proj), ctx.source, fresh, true, seam);
    if (!val) return null;
    const p2 = productivityFilter(step, val);
    if (!p2) return null; // keep-null not built
    prod.push(p2);
    return { kind: 'binary', op: ALIAS_CMP[p.op]!, left: lhs, right: val };
  };
  const clause = build(pred);
  if (!clause) return 'decline';
  return make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: and(prod.reduce((a, b) => and(a, b)), clause) });
}

function aliasWhere(step: IRStep, rel: Rel, labels: AliasMap, ctx: ChainCtx, fresh: Minter): Rel | 'decline' | null {
  if ((step.name !== 'where' && step.name !== 'not') || step.optionArms) return null;
  // Two-variable theta: `where(k1, P.op(k2))[.by(key)]` between two bound ELEMENT aliases — TinkerPop's
  // `WherePredicateStep`. WITHOUT a `by()`, `eq`/`neq` compare the elements' IDENTITY (rowid); WITH a
  // `by(key)` the comparison is over each alias's PROJECTED value (`a.age` vs `b.age`), and any ordering
  // op is meaningful. A non-productive `by()` yields NULL, so the comparison drops the row (NULL is not
  // true) exactly as TinkerPop drops it.
  if (step.name === 'where') {
    const wargs = step.args.map((a) => a.value);
    const pred = step.args?.[1]?.value;
    const pred1 = step.args?.[0]?.value; // the bare `where(P)` predicate (no startKey)
    // A BARE `where(P)` with NO startKey — the subject is the CURRENT traverser, compared against the
    // label operand(s) (`where(P.neq('a'))`, `where(P.eq('a').or(P.eq('b')))`). `WherePredicateStep`
    // with a null startKey uses `traverser.get()` as the LHS. Only when the predicate NAMES A LIVE LABEL
    // (else it is an ordinary value predicate `sourceFilter`/`is` build), only over an ELEMENT stream
    // (the current row carries an `id` — a scalar-subject or by()-value form is a later phase), and
    // no `by()` (identity rowid compare).
    if (wargs.length === 1 && isPred(pred1) && !step.modulators?.length
      && namesALiveLabel(pred1, labels) && rel.type.cols.some((c) => c.name === 'id')) {
      const clause = aliasIdentityPred(pred1, col(rel.id, 'id'), rel, labels, fresh);
      // It named a live label, so this IS the alias-compare route: a build miss DECLINES rather than
      // falling through to a value comparison that would read the label as a string.
      return clause ? make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: clause }) : 'decline';
    }
    // A COMPOUND connective (`and`/`or`/`not`) over selectKey operands. WITH a `by()` it is a value
    // compare through the ring (`aliasValueWhere`); WITHOUT one the leaves compare rowids
    // (`where('c', P.not(P.eq('a').or(P.eq('d'))))`, `aliasIdentityPred`). The single-binary path below
    // is the one-operand `by()`-value and bare `eq`/`neq` identity case.
    if (wargs.length === 2 && typeof wargs[0] === 'string' && isPred(pred)
      && (pred.op === 'and' || pred.op === 'or' || pred.op === 'not')) {
      if (step.modulators?.length) {
        const built = aliasValueWhere(step, wargs[0], pred, rel, labels, ctx, fresh);
        if (built) return built;
      } else {
        const startProj = aliasProjection(rel, labels, wargs[0], 'last', fresh);
        if (startProj && startProj.read.kind === 'element') {
          const clause = aliasIdentityPred(pred, aliasIdAt(col(rel.id, startProj.entry.col), 'last'), rel, labels, fresh);
          if (clause) return make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
        }
      }
    }
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
        const [aVal, bVal] = [byExpr(bys[0]!, hostOf(projA), ctx.source, fresh, true, seam), byExpr(bys[0]!, hostOf(projB), ctx.source, fresh, true, seam)];
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
      // A SCALAR-alias theta (`where('b', P.eq('c'))` over two VALUE aliases, no `by()`) — compare the
      // STORED values directly. `eq`/`neq` only (identity): TinkerPop's `P.eq` is value+type equality,
      // which SQLite's `=` over two stored scalars matches (an int 29 and a text "marko" are unequal, as
      // are two different types that print alike). Ordering over two arbitrary stored scalars — where the
      // type space is not known to be one — stays a later phase.
      if (projA && projB && projA.read.kind === 'value' && projB.read.kind === 'value' && !step.modulators?.length) {
        if (pred.op !== 'eq' && pred.op !== 'neq') return 'decline';
        const same = eq(aliasValueAt(col(rel.id, projA.entry.col), 'last'), aliasValueAt(col(rel.id, projB.entry.col), 'last'));
        return make.filter({ id: fresh('rw'), input: rel, channels: rel.channels, type: rel.type, pred: pred.op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same } });
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

    if (step.name === 'identity' || step.name === 'barrier') { if (step.args.length) return null; continue; }

    if (step.name === 'as') {
      // `as(label…)` binds the record AS THE MAP it is — collapse it (recordToMap, the same boundary
      // fold()/unfold()/local-slice cross) and re-enter `mapTail` at THIS step, where the map's own `as`
      // handler binds the blob to each label. The record's field names ARE the map's static key set, so
      // a later `select(label).select(k)` resolves `k` against them (the map-key-vs-alias precedence).
      const mapped = recordToMap(rel, fields, ctx.source, fresh);
      if (!mapped) return null;
      return mapTail(mapped, { kind: 'scalar' }, { kind: 'scalar' }, steps, at, ctx, fresh, labels,
        fields.map((f) => f.key));
    }

    if (step.name === 'select') {
      const args = step.args.map((a) => a.value);
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
      const selected = selectKeys(step, rel, labels, childSeam(ctx, fresh), ctx.source, fresh,
        { framing: { kind: 'record', fields }, named: namedElsewhere(ctx) });
      return selected && continueAs(selected.rel, selected.framing, steps, at + 1, bulked, ctx, fresh, labels);
    }

    // ORDER / bare DEDUP / global SLICE go through the shape-parameterised `rowOp` — a record is just
    // another shape (`payloadRowShape`): identity and tie are the whole field tuple, order is a `by()` of
    // its fields. A LABELLED `dedup(k…)` (it carries args) and every LOCAL-scope op decline out of
    // `rowOp` and fall to their own handlers below; a bare `dedup()` — long expressible, previously
    // declined as "a separate increment" — now lowers here, keeping the first occurrence's whole record.
    const row = rowOp(step, rel, payloadRowShape(host), bulked, ctx, fresh);
    if (row) { rel = row; if (step.name === 'dedup') bulked = false; continue; }

    // A LOCAL op reads the record AS A MAP — `count(Scope.local)` is its entry count and a
    // `limit`/`range`/`tail`(Scope.local) is an order-preserving entry slice, both the same question
    // over the map the record's fields form (`Scoping`/`SelectStep` yield a `LinkedHashMap`). So the
    // record COLLAPSES to a map (`recordToMap` — the same boundary `fold()`/`select` cross) and re-enters
    // `mapTail`, which owns that vocabulary. This is why a multi-key `select(k…).by(…)` reaches the map
    // ops that a single-key select's map value already had. A GLOBAL count/slice stays the row op below.
    if ((step.name === 'count' && isLocalScope(step)) || (MAP_LOCAL_SLICE.has(step.name) && isLocalScope(step))) {
      const mapped = recordToMap(rel, fields, ctx.source, fresh);
      if (!mapped) return null;
      return mapTail(mapped, { kind: 'scalar' }, { kind: 'scalar' }, steps, at, ctx, fresh, labels);
    }

    if (step.name === 'count') {
      if (step.args.length) return null;
      const counted = countTail(rel, fresh);
      return continueAs(counted.rel, counted.framing, steps, at + 1, false, ctx, fresh, NO_ALIASES);
    }

    // `fold()` — the record BECOMES a map (its fields spent) and every map value collects into ONE list
    // traverser: `project(k…).by(…).fold()`, the GraphQL to-many object field. The collapse is
    // `recordToMap` — the same boundary `select`/wire cross — so the fold sees a `MAP_COL` whatever the
    // fields were, and the member shape is the map's self-describing pairs array (`MapOf.scalar`).
    if (step.name === 'fold' && !step.args.length && !isLocalScope(step)) {
      const mapped = recordToMap(rel, fields, ctx.source, fresh);
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
      const projected = projectorTail(rel, step, host, childSeam(ctx, fresh), ctx.source, fresh);
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
      const keys = step.args.map((a) => a.value);
      if (keys.length && keys.every((k) => typeof k === 'string')) {
        const bys = modulations(step, 1, childSeam(ctx, fresh));
        if (!bys) return null;
        const deduped = dedupByLabels(step, rel, labels, keys as string[], bys[0], ctx, fresh);
        if (!deduped) return null;
        rel = deduped;
        continue;
      }
    }

    // `unfold()` — the record BECOMES a map and emits one `Map.Entry` traverser per field, exactly the
    // symmetry `valueMap().unfold()` already has. The collapse is `recordToMap` (the same boundary
    // `fold()`/local-slice cross above), and `mapTail` owns the `unfold` vocabulary (`unfoldMap` →
    // `mapEntryTail`), so re-entering it at THIS step reaches its own `unfold` handler with the map's
    // self-describing pairs — no record-specific entry machinery needed. `SelectStep`/`Scoping` yield a
    // `LinkedHashMap`, so the entry order is the field declaration order the record already carries.
    if (step.name === 'unfold' && !step.args.length) {
      const mapped = recordToMap(rel, fields, ctx.source, fresh);
      if (!mapped) return null;
      return mapTail(mapped, { kind: 'scalar' }, { kind: 'scalar' }, steps, at, ctx, fresh, labels);
    }

    // Everything else DECLINES. A record is an ordinary per-row traverser, so a bare `dedup()` and a
    // local-scope slice over its ENTRIES are expressible and simply not built yet — declining is the
    // honest answer rather than dropping the record's fields silently.
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
 *   (§11). Recovering it needs the `origin` (parent-position) channels, which this route does not carry
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
export function tokenChoice(token: string, subject: Subject, source: GraphSource, fresh: Minter): ChildValue | null {
  const modulation: Modulation = { key: { kind: 'token', token: token.toLowerCase() as 'id' | 'label' | 'key' | 'value' } };
  const expr = byExpr(modulation, childHostOf(subject), source, fresh);
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
