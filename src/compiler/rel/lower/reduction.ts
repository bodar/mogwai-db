import type { ParamEnv } from '../../../gremlin/param-env.ts';
import { withChannel, type Channel } from '../../../channels.ts';
import { isColumnArg, isNested, isPopArg, isPred, stepChain, type Arg, type SideEffectConstants } from '../../../gremlin/frontend.ts';
import { col, compilerInt, compilerNull, compilerText, eq, isNot, type BinaryOp, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import { atMostOneRow, exactlyOneRow } from '../../../rel/bounds.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta, SortTerm } from '../../../rel/types.ts';
import { exprHasSubquery, forEachExpr, forEachRel, isSelfContained } from '../../../rel/walk.ts';
import { meetScalarTypes, PER_ROW, STATIC, staticTypeOf, UNKNOWN, type MapOf, type ScalarType } from '../../../sql/kernel/render.ts';
import type { AliasMap } from '../../alias.ts';
import type { Elem } from '../../elem.ts';
import { labelsBoundBefore, scopeKeyReads } from '../../ir/labels.ts';
import { optionArms, type OptionArm } from '../../ir/option-map.ts';
import { producesWithoutInput } from '../../ir/productivity.ts';
import { normalize } from '../../ir/passes.ts';
import { BATCHING_BRANCHES, collectsSideEffect, countOf, isLocalScope, isStreamBarrier, REDUCERS, splitTraversalIds, traversalIdArg, TRAVERSER_STATE_READS, type Slice } from '../../ir/step.ts';
import { writesAnywhere, type IRStep } from '../../ir/strategies.ts';
import { eachChildChain, rawBodies, someStepDeep, type BodyReader } from '../../ir/walk.ts';
import { aliasProjection, liveAliases, rerootPresence, selectSpec } from '../alias.ts';
import { and, carriedCols, DOMAIN_ENCOUNTER, elementCols, firstRootedColumn, firstRootedValue, jsonField, jsonOf, meta, payloadCols, presenceFenced, propertyKeyArgs, renumber, rowNumberWindow, storedValueOn, typeOf, type Minter } from '../build.ts';
import { ALWAYS_PRODUCTIVE, caseWhen, gatedByHost, hostPresence, hostTag, mayBeAbsent, meetPresence, presenceDischarged, presenceOf, presentOfHost, statedPresence, type ChildHost, type ChildRows, type HostPresence, type ChildSeam, type ChildValue, type HostRow, type Presence, type RootedRead, type Subject } from '../child.ts';
import { constLit, countLit, declaredScalarType } from '../const.ts';
import { edgeEndpoint } from '../element.ts';
import { fieldNamed, framingCols, mayHoldKey, recordKeyFacts, type RelFraming } from '../framing.ts';
import { correlatedListMembers, firstScalarMember, LIST_COL } from '../list.ts';
import { collectionReaderOf, comparableClass, continueAs, dropPath, lowerChain, mapKeyCollided, mapKeyCollision, minMaxOrder, namedBeyondMap, sideEffectConstant, minMaxWinnerVt, serviceValue, streamRowTag } from '../lower.ts';
import { constantNode, correlatedMapKey, elementHost, elementValueMap, MAP_COL } from '../map.ts';
import { byExpr, byNode, propertyFirstPassing, propertyVtype, scalarNode, scopedHost } from '../modulator.ts';
import { foldDeclared, PLAIN_FOLD } from '../operator.ts';
import { appendValuePosition, extendPath, PATH_CHANNEL, PATH_COL, pathCarried, subPathMembers } from '../path.ts';
import { mixedClassesRefused, perRowSubject, predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from '../predicate.ts';
import { projectorValue, REL_PROJECTORS } from '../projector.ts';
import { propertyReadOf } from '../property.ts';
import { evidenceOf, raisingWhen, transformOffences } from '../receiver.ts';
import { recordNode, recordToMap } from '../record.ts';
import { isReducer, REDUCED_TYPE } from '../reducer.ts';
import { sackTagOf } from '../sack.ts';
import { BaseGraph, type GraphSource } from '../source.ts';
import { REL_TRANSFORMS, transformExpr } from '../transform.ts';
import { BRANCH_HOSTS, ensureBulk } from './branch.ts';
import { PER_TRAVERSER_HOSTS, RANDOM_ORDER } from './slice.ts';
import { bodyOf, CARRIED_READ, encounterOf, inBody, inOrderFreeBody, NO_ALIASES, ORIGIN, originOf, settledOf, withEnclosing, type ChainCtx, type ElementSubject, type Tail } from './chain.ts';
import { anchoredSeed, bodyPredicate, childPredicate } from './filter.ts';
import { crossCarried, movement } from './movement.ts';
import { nondeterministic } from '../../ir/step.ts';

// CHILD / CORRELATED-REDUCTION — the child seam every host body folds through (childSeam), the
// per-traverser and per-origin child drivers (perTraverserChild/flatMapRejoin/perOriginWindow), the
// correlated reducers (correlatedReduce/scalarChild/reductionTail/childRows) and their rooting helpers
// (rootedRead/hostSelf/rerootedHost). The densest slice of the fold; it calls the fold core back.

/**
 * THE CHILD SEAM, IMPLEMENTED — `child.ts` declares the three answers, this builds them (§6·6).
 *
 * One object rather than the four it replaces, and the reason is not tidiness: every consumer now
 * reaches every answer, so a child body works wherever a child body is LEGAL rather than wherever a
 * host happened to be taught one. The recursive folds stay HERE while the declaration lives beside the
 * vocabularies that consume it, which is what keeps the module DAG one-way — the four spellings each
 * used that inversion separately and this is the same move made once.
 */
export const childSeam = (ctx: ChainCtx, fresh: Minter): ChildSeam => ({
  params: ctx.params,
  sideEffects: ctx.sideEffects,
  scopeNames: ctx.scopeNames,
  writes: ctx.writes,
  scalar: (body, host) => scalarChild(body, host, ctx, fresh),
  // THE ONE predicate entry `where()`/`filter()`/`not()` already use, so a body lowered through the seam
  // gets the same `select(<label>)` re-root over the row's aliases — not a second, scope-less ladder.
  predicate: (body, subject, negated, aliases) => childPredicate(body, subject, fresh, ctx, negated, aliases),
  rooted: (steps, host) => rootedRead(steps, ctx, fresh, rootedHosts(host)),
  anchored: (elem, id) => ({ rel: anchoredSeed(ctx.source, elem, id, fresh), framing: { kind: 'elements', elem } }),
  rows: (body, input, elem, aliases, originFrom) => childRows(body, input, elem, aliases, ctx, fresh, false, false, originFrom),
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
    continueAs(input, framing, body, 0, false, inOrderFreeBody(ctx), fresh, aliases),
  scopeRows: (rows) => mintRowOrigin(rows, fresh),
  unscopeRows: (rows) => dropOrigin(rows, fresh),
  body: (nested, scope) => (scope === 'child'
    ? bodyOf(nested, ctx.params, ctx.sideEffects)
    : rootedSteps(nested, ctx.params, ctx.sideEffects)),
  mapKeyCollided: (step, key, host) => {
    const facts = host.kind === 'map' ? host : host.kind === 'record' ? recordKeyFacts(host.fields) : null;
    const collision = facts && mapKeyCollision(key, facts, ctx, labelNamed(key, host, ctx));
    return collision ? mapKeyCollided(step, collision, ctx) : null;
  },
});

/**
 * A one-row child's presence: `'always'` only where the relation is EXACTLY one row (`exactlyOneRow`,
 * `src/rel/bounds.ts`). One that may be EMPTY (`count().is(0)`, `fold().limit(0)`, `count().skip(1)`)
 * leaves the scalar subquery reading NULL, and how that NULL is read depends on the VALUE:
 * - a value that is never NULL when present (a count, a seeded list) — the NULL IS the body's absence,
 *   so `'value-nullness'` reads it exactly and costs no second subquery;
 * - a value that may be a PRODUCTIVE NULL (`nullable` — a map entry's own value through `dedup()`,
 *   `is(null)`, `limit(1)`) — a NULL cannot tell "no row" from "a null row", so presence is STATED as
 *   `EXISTS` over the same relation. `DedupGlobalStep.filter` keeps the first null
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/DedupGlobalStep.java`)
 *   and `Grouping.doFinalReduction` drops a key only when its value traversal has NO next
 *   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java`),
 *   so reading that null as absence drops a group key.
 */
const oneRowPresence = (rel: Rel, nullable = false): Presence =>
  exactlyOneRow(rel) ? 'always'
    : nullable ? { when: { kind: 'exists', negated: false, plan: rel } }
      : 'value-nullness';

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
 * productivity the seam cannot state (`ChildValue.present` `'unknown'` — a numeric reducer over an empty
 * child, which `correlatedExists` fails closed on for the same reason) declines here too.
 */
/** The child HOST for a per-traverser body over an element or scalar stream — the subject `scalarChild`
 *  reads. Extracted so the `map`/`local`/`flatMap` dispatch and a `coalesce`/`optional` reduction arm
 *  name ONE host shape rather than two copies of it. */
export function reductionHost(
  rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, labels: AliasMap,
): ChildHost {
  if (framing.kind === 'elements') return elementHost(rel, framing.elem, labels);
  // The host's tag is the ONE reading of the row's own type (`streamRowTag`): the stored `vtype`, a per-row tag
  // column (a reducer's `vt`), else the static tag. Reading `vtype` alone re-framed a min/max winner by
  // inference inside `local()` — `max()` of [5, 2.5d] came back the Int 5 — and judged its predicates by
  // storage class.
  const vtype = streamRowTag(rel, framing) ?? undefined;
  return { kind: 'scalar', value: col(rel.id, 'v'), row: { rel, aliases: labels }, ...(vtype ? { vtype } : {}) };
}

/**
 * A per-traverser reduction's one-value-per-host expression FRAMED as this stream's payload columns — the
 * projection `perTraverserChild` (map/local/flatMap) and a `coalesce`/`optional` reduction arm share.
 *
 * The body's ONE result becomes the payload: an element re-roots to its rowid, a fold's value lands in the
 * canonical `list` column, a scalar to `v` (plus a `vtype` column where the seam read a stored type). Every
 * carried channel PASSES THROUGH unchanged (it is one row per host, so a frozen fan-out position survives),
 * and an arm that can be UNPRODUCTIVE is filtered on its projected payload's non-nullness (presence is value
 * nullness, `ChildValue.present`). The assembler fuses the two nodes into one SELECT. See `perTraverserChild`'s §3.3 note on why the filter is a sibling projection, not nested.
 */
export function reductionTail(rel: Rel, produced: ChildValue, fresh: Minter, labels: AliasMap, bulked: boolean): Tail | null {
  if (produced.present === 'unknown') return null;
  const payload = ((): { readonly cols: readonly (readonly [ColMeta, Expr])[]; readonly framing: RelFraming } | null => {
    if (produced.framing.kind === 'elements')
      return { cols: [[meta('id', 'int', true), produced.expr]], framing: produced.framing };
    if (produced.framing.kind === 'list')
      return { cols: [[meta(LIST_COL, 'json'), produced.expr]], framing: produced.framing };
    if (produced.framing.kind !== 'scalar') return null;
    // The body's type becomes a per-row `vtype` — a Gremlin type alone, which a NUMERIC REDUCER's `vt`
    // already is (`REDUCED_TYPE`): `local(__.values('age').mean())` is the Double `MeanGlobalStep` answers.
    const vtype = produced.vtype;
    return vtype
      ? {
        cols: [[meta('v', 'any', true), produced.expr], [meta('vtype', 'text', true), vtype]],
        framing: { kind: 'scalar', type: PER_ROW('vtype') },
      }
      : { cols: [[meta('v', 'any', true), produced.expr]], framing: produced.framing };
  })();
  if (!payload) return null;
  const channels = rel.channels;
  const cols = [...payload.cols.map(([column]) => column), ...carriedCols(channels)];
  // A PER-ROW value may be a STORED COLLECTION (`map(__.values('m'))` over a list-valued property), whose
  // `value` column is JSONB — and a scalar row carries a collection as JSON TEXT (`storedValueOn`, what
  // `values()` projects), so the framer read raw JSONB bytes as a list and crashed. Recovered over the
  // projected COLUMNS, once, so the correlated read is not spelled again in the CASE.
  const done = (out: Rel): Tail => {
    if (payload.framing.kind !== 'scalar' || payload.framing.type.kind !== 'perRow') return { rel: out, framing: payload.framing, aliases: labels, bulked };
    const recovered = make.project({
      id: fresh('mcv'), input: out, channels, type: out.type,
      exprs: out.type.cols.map((column) => [column.name, column.name === 'v' ? storedValueOn(col(out.id, 'v'), col(out.id, 'vtype')) : col(out.id, column.name)] as const),
    });
    return { rel: recovered, framing: payload.framing, aliases: labels, bulked };
  };
  const exprs = [
    ...payload.cols.map(([column, expression]) => [column.name, expression] as const),
    ...channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const),
  ];
  // A STATED presence is a predicate in the HOST's scope: projected beside the payload, filtered on, and
  // shed — a NULL value that survives it is a productive null, kept.
  if (typeof produced.present === 'object') {
    const PRESENT = 'mpw';
    const withPresence = make.project({
      id: fresh('mc'), input: rel, channels, type: typeOf(...cols, meta(PRESENT, 'int', true)),
      exprs: [...exprs, [PRESENT, produced.present.when]],
    });
    const kept = make.filter({
      id: fresh('mf'), input: withPresence, channels, type: withPresence.type,
      pred: statedPresence({ ...produced.present, when: col(withPresence.id, PRESENT) }, col(withPresence.id, payload.cols[0]![0].name)),
    });
    const shed = make.project({
      id: fresh('mc'), input: kept, channels, type: typeOf(...cols),
      exprs: cols.map((column) => [column.name, col(kept.id, column.name)] as const),
    });
    return done(shed);
  }
  const projected = make.project({ id: fresh('mc'), input: rel, channels, type: typeOf(...cols), exprs });
  if (produced.present === 'always') return done(projected);
  const named = presenceFenced(projected, produced.expr, fresh);
  const kept = make.filter({
    id: fresh('mf'), input: named, channels, type: named.type,
    pred: presenceOf('value-nullness', col(named.id, payload.cols[0]![0].name))!,
  });
  return done(kept);
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
export function reductionArm(
  domain: Rel, framing: RelFraming, body: readonly IRStep[], ctx: ChainCtx, fresh: Minter, labels: AliasMap, bulked: boolean,
): Tail | null {
  const terminal = body.at(-1);
  if (body.length < 2 || !terminal || !selfCollapses(terminal.name)) return null;
  if (framing.kind !== 'elements' && framing.kind !== 'scalar') return null;
  const produced = scalarChild(body, reductionHost(domain, framing, labels), ctx, fresh);
  if (!produced || produced.yields !== 'one' || produced.present !== 'always') return null;
  const tail = reductionTail(domain, produced, fresh, labels, bulked);
  // Shared by `coalesce` (a `FlatMapStep`) and `optional` (which forwards the child's traverser), so the
  // arm cannot say which entry its result opens — drop the path rather than guess (`childResultPath`).
  return tail && childResultPath(tail, false, fresh);
}

export function perTraverserChild(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, steps: readonly IRStep[], at: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  if (step.modulators?.length || step.optionArms) return null;
  const nested = step.args[0]?.value, extra = step.args[1]?.value;
  if (extra !== undefined || !isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params);
  if (!body?.length) return null;
  // The body BEGINS a child traversal handed one traverser at a time at bulk 1 — `map`/`flatMap` through
  // `TraversalUtil.apply`, and `local` because `LocalStep.nextStart` SPLITS a merged slot into unit
  // traversers and runs its body once per unit
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88`)
  // — so a bulk-sensitive consumer inside it may read its rows as the reference's traversers
  // (`ChainCtx.traversal`), and a merge before the host changes nothing a per-row body answers.
  const bodyCtx: ChainCtx = { ...ctx, traversal: { steps: body, rooted: false } };

  // A re-source that DRAWS (at any depth of the body) is one shared evaluation on the scalar route
  // (`rootedRead` refuses it), so `local`/`flatMap`, which emit every result, draw per row through the
  // rejoin first (`reSourcedOnce`, GraphStep's product).
  if (step.name !== 'map' && nondeterministic(body, ctx.params)
    && someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true)) {
    const perRow = flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
    if (perRow) return perRow;
  }
  const declinedBefore = ctx.declines.terminal();
  const produced = scalarChild(body, reductionHost(rel, framing, labels), bodyCtx, fresh);
  // A `map()`/`flatMap()` body's `SHARED_DRAW` names the per-row form ONLY where that form's route admits
  // the same body over the same input (`localDrawsPerRow`). Advice must not send the user to a `local(…)`
  // that declines too (`inject(1,2)`'s scalar host, a `coin` draw). Every other host's does not.
  if (!declinedBefore && (step.name === 'map' || step.name === 'flatMap') && localDrawsPerRow(body, rel, framing, bodyCtx))
    ctx.declines.hint('shared-draw', `local(…) draws per row, so use local(__.V()…sample(1)) in place of ${step.name}(…)`);
  if (!produced) return flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
  // THE POLICY, and it is the whole difference between the three steps: `local`/`flatMap` emit EVERY
  // result, so a correlated scalar is their answer only where the body had exactly ONE to give, while
  // `map` takes the first by definition. The seam states which (`ChildValue.yields`) rather than this
  // reading it off the framing — a reducing `result` marker implies one, but so does an endpoint
  // re-root that is not a reducer at all, and inferring it here made `local(__.outV())` decline.
  // A body with more to give falls to the row-producing rejoin, exactly as an unanswered scalar does.
  if (step.name !== 'map' && produced.yields !== 'one') return flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
  // An unproductive body DROPS the traverser at all three hosts (`map` by the citation above;
  // `local`/`flatMap` because a body with no results contributes none), so the signal is required
  // rather than assumed — `ChildValue.present`'s own contract.
  if (produced.present === 'unknown') return null;

  // The body's ONE result framed as this stream's payload, presence filtered and shed — see
  // `reductionTail`, shared with the `coalesce`/`optional` reduction arm. The tail then continues.
  const tail = reductionTail(rel, produced, fresh, labels, bulked);
  if (!tail) return null;
  const pathed = childResultPath(tail, step.name !== 'local', fresh);
  return continueAs(pathed.rel, pathed.framing, steps, at + 1, bulked, ctx, fresh, labels);
}

/**
 * THE PATH ENTRY a per-traverser child's ONE result leaves on the traverser — the one authority every
 * correlated-scalar host consults, so a carried path never rides past such a host unextended.
 *
 * `map`/`flatMap` (and `coalesce`, a `FlatMapStep`) emit `head.split(result)`: the PRE-child path extended
 * by exactly the emitted value (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52`,
 * `…/step/map/MapStep.java`, `…/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71`), so a scalar result is
 * APPENDED as a value position — `V(1).map(values('age')).path()` is `[v[1], 29]`, which answered `[v[1]]`.
 * `local`/`optional` forward the CHILD's own traverser (`…/step/branch/LocalStep.java:80-88`), whose path
 * depends on the body (a reducing barrier mints a fresh one, `ReducingBarrierStep`), and a non-scalar
 * result has no value position this can append — both DROP the path, so a later path read declines.
 */
function childResultPath(tail: Tail, opensEntry: boolean, fresh: Minter): Tail {
  if (!pathCarried(tail.rel)) return tail;
  if (opensEntry && tail.framing.kind === 'scalar' && tail.rel.type.cols.some((column) => column.name === 'v'))
    return { ...tail, rel: appendValuePosition(tail.rel, tail.framing.type, fresh) };
  return { ...tail, rel: dropPath(tail.rel, fresh) };
}

/** The stream barriers that SELF-SCOPE per origin when run inside a per-traverser body — `order()` (a
 *  global sort restricted to a partition IS that origin's order), `dedup()` (per-origin DISTINCT via
 *  `dedupOn`), the slice family including `sample` (`perOriginWindow` via `sliceOp`, a RANDOM collation
 *  for `sample` — or, after a re-source, `reSourcedOnce`'s per-origin draw), and the no-op `barrier`.
 *  Every OTHER `isStreamBarrier` step (`fold`,
 *  `group`/`groupCount`/`aggregate`, a reducer, a nested `local`) either changes the framing or has no
 *  per-origin form, so a body containing one DECLINES — the whitelist twin of `match`'s
 *  `PER_ORIGIN_UNSAFE` blacklist. */
export const PER_ORIGIN_SAFE_BARRIER: ReadonlySet<string> = new Set(['order', 'dedup', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier']);

/** The CARDINALITY-changing barriers that self-scope per origin by GROUPING rather than by a window — a
 *  `fold()` that CONTINUES mid-body (`local(__.out().fold().unfold())`) and a `group()`/`groupCount()`
 *  (`local(__.out().group().by(k))`). Distinct from `PER_ORIGIN_SAFE_BARRIER` on purpose (per its own
 *  comment that set stays a WINDOW-scoping whitelist): these reduce N rows to one PER ORIGIN via
 *  `GROUP BY origin` (`foldPerOrigin` in `list.ts`, `groupMap`'s per-origin path in `map.ts` — the key
 *  spliced not a passenger, the seed LEFT JOINed off the origin DOMAIN so an empty sub-stream still emits
 *  `[]`/`{}`). A TERMINAL `fold()` never reaches here — `scalarChild` answers it as a correlated list
 *  before `flatMapRejoin`. */
export const PER_ORIGIN_GROUPING_BARRIER: ReadonlySet<string> = new Set(['fold', 'group', 'groupCount']);

/**
 * Does every stream barrier of a per-traverser body SELF-SCOPE by the body's ONE origin? The admission
 * gate of the per-row rejoin (`flatMapRejoin`, both its forms) and of the per-row draw advice
 * (`localDrawsPerRow`) — one predicate, so the route and the advice cannot disagree about a body.
 *
 * A barrier self-scopes when it is a per-origin window or grouping (the two sets above), or when it is a
 * NESTED per-traverser host that scopes within the enclosing row (`nestedHostScopes`).
 */
export function bodyScopesPerOrigin(body: readonly IRStep[], params: ParamEnv): boolean {
  return body.filter(isStreamBarrier).every((s) =>
    PER_ORIGIN_SAFE_BARRIER.has(s.name) || PER_ORIGIN_GROUPING_BARRIER.has(s.name) || nestedHostScopes(s, params));
}

/** The stream barriers a body NESTED under an enclosing origin may hold: a per-origin WINDOW (scoped by a
 *  nested origin, `nestRowOrigin`) or a further nested host. A GROUPING barrier is not among them — its
 *  `GROUP BY` names one origin, and the enclosing one has no group policy to ride it as a passenger. */
const nestedBarrierScopes = (s: IRStep, params: ParamEnv): boolean =>
  PER_ORIGIN_SAFE_BARRIER.has(s.name) || nestedHostScopes(s, params);

/**
 * A NESTED `local`/`map`/`flatMap` whose body scopes WITHIN one row of the enclosing per-traverser body
 * — it runs once per entering traverser (`LocalStep.java:80-88`, `FlatMapStep.java:42-52` under
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/`), so
 * it composes over the ENCLOSING origin. Two body forms qualify:
 *
 * - a ONE-value body — one ending in a reducer or a `fold()`, which `scalarChild` answers as a correlated
 *   scalar over the row's element (`local(__.count())`, `local(__.out('knows').count())`): whatever
 *   barriers precede the reducer live inside that correlated read and never see an origin;
 * - a FAN-OUT body whose barriers are per-origin windows or further such hosts (`local(__.out())`,
 *   `local(__.out().limit(1))`): `flatMapRejoin` runs it under a NESTED origin (`nestRowOrigin`) where it
 *   holds a window or a branch at any depth, and inlined where it holds neither.
 */
function nestedHostScopes(step: IRStep, params: ParamEnv): boolean {
  if (!PER_TRAVERSER_HOSTS.has(step.name) || step.modulators?.length || step.optionArms || step.args.length !== 1) return false;
  const nested = step.args[0]!.value;
  const body = isNested(nested) ? bodyOf(nested.nested, params) : null;
  if (!body?.length) return false;
  const last = body.at(-1)!;
  if (isStreamBarrier(last) && (REDUCERS.has(last.name) || last.name === 'fold')) return true;
  return body.filter(isStreamBarrier).every((s) => nestedBarrierScopes(s, params));
}

/**
 * A FAN-OUT `flatMap`/`local` body, spliced back as a REJOIN — the general child answer
 * `scalarChild`'s movement arm explicitly defers ("fan-out `flatMap(__.V()…)` needs the general child
 * rejoin"). `scalarChild` only produces a body that yields ONE value per traverser; a body that FANS
 * OUT (`__.out()`, `__.out().values('name')`) is not a correlated scalar, it REJOINS.
 *
 * A body with NO stream barrier is TRANSPARENT: `flatMap`/`local` run it per traverser, and with
 * nothing to scope per-origin the answer is the body inlined into the outer chain — `flatMap(__.out())`
 * is `out()`, `local(__.out())` is `out()`. A per-origin-SAFE barrier inside it
 * (`local(__.out().order().by(k).limit(1))`, `local(__.both().dedup())`) is scoped to the ENTERING
 * traverser: the whole body runs through `childRows(perRow: true)` (a per-ROW origin), and `sliceOp`/
 * `dedupOn`/`order` self-scope by it. Then DROP origin: a later `dedup` is whole-row, so leaving origin
 * as a column would distinguish rows by WHICH host they descend from and keep convergent walks that must
 * collapse.
 *
 * `map` is excluded: it takes the FIRST body result, not all, so a fan-out under it is a per-origin
 * window, not this. A scalar host has no rowid for `origin` (`childRows`' own limit), so only an element
 * host reaches here.
 */
export function flatMapRejoin(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>,
  body: readonly IRStep[], steps: readonly IRStep[], at: number, bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  bodyCtx: ChainCtx = ctx,
): Tail | null {
  if ((step.name !== 'flatMap' && step.name !== 'local') || framing.kind !== 'elements') return null;
  // AN ENCLOSING ORIGIN — this host sits inside another per-traverser body (`local(__.out().local(…))`,
  // a `group().by()` reducer body, a `match` pattern), whose origin the input already carries and which
  // that enclosing host still needs back. A body holding a per-origin window or a branch ANYWHERE scopes
  // per INNER row, so it runs under a NESTED origin (`nestRowOrigin`), shed again below; a body holding
  // neither is the body inlined, and runs over the enclosing origin unchanged. A grouping barrier declines
  // (`nestedBarrierScopes`), and so does the path-hide below, whose origin → path join is one-to-one only
  // for an origin minted over THIS input.
  const enclosed = !!originOf(rel.channels);
  const barriers = body.filter(isStreamBarrier);
  if (enclosed && (!barriers.every((s) => nestedBarrierScopes(s, ctx.params)) || (ctx.tracksPath && step.name === 'flatMap' && pathCarried(rel)))) return null;
  // WHETHER to nest is a question about the WHOLE body, not its top level: a per-origin window inside a
  // `union`/`choose` arm (`local(__.union(__.out().limit(1), __.in().limit(1)))`) partitions by
  // `originOf` exactly as a top-level one does, and an arm merge orders by it — so under the ENCLOSING
  // origin either would scope per OUTER traverser where `LocalStep` scopes per entering one
  // (`.../step/branch/LocalStep.java:80-88`). Only a body with no barrier and no branch anywhere is the
  // body inlined.
  const nests = enclosed && someStepDeep(body, ctx.params, (s) => isStreamBarrier(s) || BRANCH_HOSTS.has(s.name), true);
  // PATH: `local` and plain `flatMap` DIVERGE (`vendor/tinkerpop/gremlin-core`). `LocalStep` forwards
  // the child's FULL `Traverser.Admin` (`.../step/branch/LocalStep.java:60-67` →
  // `.../Traversal.java:593-595`), so `local(out().out()).path()` is `[v, mid, end]` — the body's minted
  // positions ARE the answer, and since `inBody` does not clear `tracksPath` the ordinary fold already
  // appends them: nothing to hide, carry through. Plain `flatMap` unwraps to a value and re-derives from
  // the PRE-child head (`.../map/FlatMapStep.java:42-52` → `.../util/DefaultTraversal.java:220-230` →
  // `.../Traverser.java:185-195`), so `flatMap(out().out()).path()` is `[v, end]` — its intermediate
  // objects are HIDDEN (`.../gremlin-test/.../map/FlatMap.feature:56`). The reference is precise:
  // `LP_O_OB_P_S_SE_SL_Traverser.split` (`.../traverser/LP_O_OB_P_S_SE_SL_Traverser.java:65-69`) sets
  // `clone.path = head.path.clone().extend(r, labels)` — the PRE-child head's path extended by exactly ONE
  // position, the emitted value. So the body runs PATH-FREE (a path-hostile body step then composes, as it
  // does in TinkerPop where the body's own paths are invisible), the entering path P is recovered by a
  // per-row origin, and the one output element is appended: P ++ [emitted]. Only an ELEMENT-output body has
  // an id to append; a scalar/list output under `path()` stays its own increment.
  // Only where the INPUT carries a path: a probe of the body's productivity (`coalesce`/`optional`'s
  // exhaustion guard, `childPredicate`) runs it over a path-free subject, which has no P to recover.
  if (ctx.tracksPath && step.name === 'flatMap' && pathCarried(rel)) {
    if (!bodyScopesPerOrigin(body, ctx.params)) return null;
    const numbered = mintRowOrigin(rel, fresh); // a per-row origin BESIDE the entering path P
    const origin = originOf(numbered.channels)!;
    // origin -> P, one row per entering traverser (a fan-out is one-to-many, so recovering P is a real JOIN).
    const pathDomain = make.project({
      id: fresh('pd'), input: numbered, channels: [], type: typeOf(meta('porigin', 'int'), meta(PATH_COL, 'json', true)),
      exprs: [['porigin', col(numbered.id, origin.col)], [PATH_COL, col(numbered.id, PATH_COL)]],
    });
    // Run the body over the numbered input with PATH DROPPED — it appends nothing (`pathCarried` false).
    const rows = childRows(body, dropPath(numbered, fresh), framing.elem, labels, bodyCtx, fresh, true, ctx.needsFromV ?? false);
    if (!rows || rows.framing.kind !== 'elements') return null;
    const bodyChannels = rows.rel.channels; // element id + origin, no path
    const joined = make.join({
      id: fresh('fpj'), left: rows.rel, right: pathDomain, join: 'inner', ordered: true, channels: bodyChannels,
      type: typeOf(...elementCols(bodyChannels), meta('porigin', 'int'), meta(PATH_COL, 'json', true)),
      on: eq(col(pathDomain.id, 'porigin'), col(rows.rel.id, origin.col)),
    });
    // Re-attach the entering path P as the path channel, then extend it by the one emitted element.
    const outChannels = withChannel(bodyChannels, PATH_CHANNEL);
    const withEnteringPath = make.project({
      id: fresh('fp'), input: joined, channels: outChannels, type: typeOf(...elementCols(outChannels)),
      exprs: elementCols(outChannels).map((column) => [column.name, col(joined.id, column.name)] as const),
    });
    const extended = extendPath(withEnteringPath, { kind: 'element', elem: rows.framing.elem, id: col(withEnteringPath.id, 'id') }, fresh, ctx.demandsPathLabels);
    const rejoined = shedBodyAliases(dropOrigin(originMajor(extended, body, ctx.params, fresh), fresh), labels, fresh);
    return continueAs(rejoined, rows.framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  // A LABEL BOUND INSIDE THE BODY escapes to parent scope for `local` (the full-traverser forward above,
  // so `g.V()…as('a').local(__.out('created').as('b')).select('a','b')` sees `b`) but NOT for plain
  // `flatMap`: `head.split` re-derives from the pre-child head, so a body-bound label is DROPPED. `local`
  // threads the body's outbound `AliasMap` below; `flatMap` SHEDS the body-bound alias channels and keeps
  // the pre-body map, so a downstream `select('b')` is the correct EMPTY result (`Select.feature`), not a
  // decline and not a wrong binding — see the rejoin below.
  // Run the WHOLE body PER TRAVERSER: `local`/`flatMap` apply their body to each traverser
  // independently (TinkerPop's `LocalStep`/`FlatMapStep`), so a slice/`dedup`/`order` inside it scopes
  // to the ENTERING traverser, not globally — the SAME per-origin substrate `match` uses (a pattern body
  // is TinkerPop's flatMap-localized barrier, `MatchStep.java:156-166`). `childRows(perRow: true)` mints
  // a per-ROW origin (NOT the element id — `g.V().both().local(out().limit(1))` has three separate
  // traversers at `marko`, each owed its own `limit(1)`, which the element-id seed collapsed to one), the
  // body's slices/`dedup` self-scope by that origin (`sliceOp`/`dedupOn`) and its `order()` mints the
  // encounter they rank by, then origin is shed. Only per-origin-SAFE barriers compose this way:
  // `fold`/`group`/`aggregate`/a reducer that are not per-origin GROUPINGS (framing-changing, and a
  // reducer is `scalarChild`'s job, tried first in `perTraverserChild`) DECLINE — a wrong answer if run
  // across all origins at once.
  if (!bodyScopesPerOrigin(body, ctx.params)) return null;
  const rows = childRows(body, nests ? nestRowOrigin(rel, fresh) : rel, framing.elem, labels, bodyCtx, fresh, true, ctx.needsFromV ?? false);
  if (!rows) return null;
  // DROP origin — flatMap flattens, so the host a row descended from is internal and must not ride into
  // a downstream whole-row `dedup`/merge. Everything else (payload + carried channels) rides through.
  // An ENCLOSING origin is not this host's to shed (nor to re-rank by — the enclosing host does that); a
  // NESTED one is, which hands the stream back to the enclosing scope.
  const shed = enclosed && !nests ? rows.rel : dropOrigin(originMajor(rows.rel, body, ctx.params, fresh), fresh);
  // `local` carries the body's outbound labels to parent scope (the full-traverser forward); plain
  // `flatMap` sheds the body-bound alias CHANNELS (`shedBodyAliases`) and continues with the pre-body map
  // only — so the channel never rides into a downstream `dedup`/merge as a spurious distinguishing column,
  // and a downstream read of a body-bound label is the correct empty result.
  const out = step.name === 'local' ? rows.aliases : labels;
  const rejoined = step.name === 'local' ? shed : shedBodyAliases(shed, labels, fresh);
  return continueAs(rejoined, rows.framing, steps, at + 1, bulked, ctx, fresh, out);
}

/**
 * Would `local(body)` over this host draw per row? The rejoin's own entry conditions (an ELEMENT host, only
 * per-origin-safe barriers, `flatMapRejoin`) and the per-origin draw's admission gate
 * (`reSourcesOncePerOrigin`) at the body's first top-level re-source, asked under the body context the
 * rejoin lowers it with (`childRows`: `inBody`, unbulked). Sufficient, not necessary: GraphStep's product
 * may still answer a body this refuses, so it only ever withholds a suggestion, never a route.
 */
function localDrawsPerRow(body: readonly IRStep[], rel: Rel, framing: RelFraming, bodyCtx: ChainCtx): boolean {
  if (framing.kind !== 'elements') return false;
  if (!bodyScopesPerOrigin(body, bodyCtx.params)) return false;
  const at = body.findIndex((s) => s.name === 'V' || s.name === 'E');
  return at >= 0 && reSourcesOncePerOrigin(body, at, rel, false, inBody(bodyCtx));
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
/** The default per-origin collation when the body supplied no `order()`: encounter, then the whole
 *  payload. TinkerPop leaves an un-ordered per-origin slice IMPL-DEFINED (the corpus asserts "result
 *  should be OF … count N"), so a deterministic pick from the accepted set is correct and keeps
 *  `test:perturbed` stable. */
export function defaultCollation(rows: Rel): SortTerm[] {
  const position = encounterOf(rows.channels);
  return [...(position ? [{ expr: col(rows.id, position.col), dir: 'asc' as const }] : []),
    ...payloadCols(rows).map((column) => ({ expr: col(rows.id, column.name), dir: 'asc' as const }))];
}

/** The default collation REVERSED — a `tail(n)` is the last n, i.e. the first n under the flipped order.
 *  When a body `order()` precedes the tail, its order is baked into the `encounter` channel, so flipping
 *  the encounter-led default collation yields "last n of the ordered stream". The result multiset is the
 *  same rows either way (a flattened body is a multiset); only the pick is from the tail end. */
export function reverseCollation(rows: Rel): SortTerm[] {
  return defaultCollation(rows).map((term) => ({ ...term, dir: term.dir === 'asc' ? 'desc' as const : 'asc' as const }));
}

/**
 * THE PER-ORIGIN WINDOW — `ROW_NUMBER() OVER (PARTITION BY <partitionBy> ORDER BY <order>)` filtered to
 * the slice, then reprojected. The ONE primitive every fan-out body's per-origin slice lands on;
 * `partitionBy` is the origin-key seam that differs per consumer (an `origin` channel column for
 * `local`/`flatMap`, a bound alias's id for a `match` pattern, a `by`-host id, an arm's incoming
 * traverser). `order` empty ⇒ `defaultCollation`.
 *
 * `dedupOn`'s shape and Calcite's per-partition top-N EXACTLY: `convertDistinctOn`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/SqlToRelConverter.java:1045-1113`)
 * projects `ROW_NUMBER() OVER (PARTITION BY keys ORDER BY collation)`, filters the rank, then projects it
 * away — `ROW_NUMBER` (positional) NOT `rank`, so a `limit` never keeps ties as extra rows. Calcite's
 * DISTINCT ON keeps `rn = 1`; this keeps `offset < rn ≤ offset+limit` (`limit === null` is the open
 * `skip`/`range(k,-1)` upper bound), the top-N + range generalization.
 */
export function perOriginWindow(
  rows: Rel, partitionBy: Expr | null, order: readonly SortTerm[], slice: Slice, fresh: Minter, fenced = false,
): Rel {
  const cols = [...payloadCols(rows), ...carriedCols(rows.channels)];
  const RN = 'prn';
  const orderBy = order.length ? order : defaultCollation(rows);
  const window = rowNumberWindow(rows, RN, rows.channels, { partitionBy: partitionBy ? [partitionBy] : [], orderBy }, fresh);
  // FENCED for a RANDOM() collation (`sample`): the filter reads a column the window computed, and an
  // inlined window re-evaluates RANDOM() at the clause-reader boundary — the wrong cardinality.
  const ranked = fenced ? make.materialize({ id: fresh('sm'), input: window, channels: window.channels, type: window.type }) : window;
  // `ROW_NUMBER` starts at 1, so a zero offset states no lower bound.
  const upper = (n: number): Expr => ({ kind: 'binary', op: '<=', left: col(ranked.id, RN), right: countLit(n) });
  const lower: Expr = { kind: 'binary', op: '>', left: col(ranked.id, RN), right: compilerInt(slice.offset) };
  const pred: Expr = slice.limit === null ? lower
    : slice.offset === 0 ? upper(slice.limit) : and(lower, upper(slice.offset + slice.limit));
  const kept = make.filter({ id: fresh('pf'), input: ranked, channels: ranked.channels, type: ranked.type, pred });
  return make.project({
    id: fresh('pk'), input: kept, channels: rows.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(kept.id, column.name)] as const),
  });
}

/**
 * MINT a per-ROW `origin` on a stream — a `ROW_NUMBER() OVER ()` unique per row — so a per-origin
 * barrier in a body run over it (`sliceOp`/`dedupOn`, which consult the ambient `origin` channel)
 * self-scopes to the row it descended from. This is `childRows`' mechanism for a stream that is NOT a
 * host of distinct elements: `childRows` seeds `origin` from the host's ROWID (unique because the host
 * is `V()`/`E()`), but a MATCH BINDING ROW is not identified by any element it holds — two rows can
 * share every bound alias (`both()` on a self-loop, two `x` that both created one `a`) — so the origin
 * must be a fresh per-row number, not an alias id. That is the whole fix that makes `match` reuse the
 * `local`/`flatMap` per-origin substrate instead of a hand-rolled partition-by-start-alias (which
 * collapsed binding rows sharing that alias). The number need only be UNIQUE per row; it follows the
 * stream's arrival order where it carries one, and the body's own `order()` mints the `encounter` a later
 * slice ranks by.
 */
export function mintRowOrigin(rel: Rel, fresh: Minter): Rel {
  return originOf(rel.channels) ? rel : numberedOrigin(rel, ORIGIN, fresh);
}

/**
 * NEST a per-ROW origin INSIDE the one the stream already carries — the origin of a per-traverser host
 * sitting in another one's body (`local(__.out().local(__.out().limit(1)))`), whose own barriers scope
 * per INNER row while the enclosing host still needs its origin back afterwards. A second `origin`-role
 * channel under a fresh column: `withChannel` keeps peers in arrival order, so the nested one is last and
 * `originOf` (the INNERMOST) is what the body's barriers partition by. Partitioning by it alone is exact —
 * an inner row descends from one outer row, so the inner origin determines the outer, which rides through
 * every window as a carried passenger. `dropOrigin` sheds the innermost, restoring the enclosing scope.
 * A separate entry point because `mintRowOrigin`'s idempotence is what its callers rely on.
 */
export function nestRowOrigin(rel: Rel, fresh: Minter): Rel {
  return numberedOrigin(rel, { col: fresh('origin'), role: 'origin' }, fresh);
}

function numberedOrigin(rel: Rel, origin: Channel, fresh: Minter): Rel {
  const channels = withChannel(rel.channels, origin);
  // Numbered in ARRIVAL order where the stream carries one, so the origin is also the entering
  // traverser's position — what `originMajor` re-reads after a per-traverser body.
  const enc = encounterOf(rel.channels);
  const numbered = rowNumberWindow(rel, origin.col, rel.channels, {
    partitionBy: [], orderBy: enc ? [{ expr: col(rel.id, enc.col), dir: 'asc' }] : [],
  }, fresh);
  const cols = [...payloadCols(rel), ...carriedCols(channels)];
  return make.project({
    id: fresh('om'), input: numbered, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(numbered.id, column.name)] as const),
  });
}

/** Is `window` the numbering `mintRowOrigin`/`nestRowOrigin` mints the per-ROW origin `origin` from? */
export const isMintedRowOrigin = (window: Rel, origin: Channel): boolean =>
  window.kind === 'window' && window.specs.some(([name]) => name === origin.col);

/**
 * A PER-TRAVERSER BODY'S RESULTS IN THE HOST'S ORDER — start-major, then the body's own order within one
 * start. `FlatMapStep`/`LocalStep` take ONE start, emit every result of its body, then take the next
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52`,
 * `…/step/branch/LocalStep.java:80-88`), so a global `order()` in the body sorts ONE start's results. Inside
 * the body that order is minted over every origin at once — exact WITHIN an origin, but it interleaves the
 * starts, and `g.V().flatMap(out().order().by('name')).values('name').fold()` answered the six names sorted
 * where the reference keeps marko's three ahead of josh's two. The origin is numbered in arrival order
 * (`mintRowOrigin`), so re-ranking by `(origin, encounter)` restores the host's order. Only a body holding a
 * step that re-mints the position over the whole stream (a global `order()`, a branch merge) can interleave
 * starts; any other body keeps the origin-major position its movements already numbered.
 */
function originMajor(rel: Rel, body: readonly IRStep[], params: ParamEnv, fresh: Minter): Rel {
  const origin = originOf(rel.channels), enc = encounterOf(rel.channels);
  if (!origin || !enc) return rel;
  if (!someStepDeep(body, params, (s) => (s.name === 'order' && !isLocalScope(s as IRStep)) || BATCHING_BRANCHES.has(s.name), true)) return rel;
  const cols = [...payloadCols(rel), ...carriedCols(rel.channels)];
  return renumber(rel, [{ expr: col(rel.id, origin.col), dir: 'asc' }, { expr: col(rel.id, enc.col), dir: 'asc' }], cols, rel.channels, fresh);
}

/** DROP the `origin` channel and its column — the counterpart of `mintRowOrigin`/`childRows`' mint,
 *  run once a per-origin body is done so the host a row descended from does not ride into a downstream
 *  whole-row `dedup`/merge (`flatMapRejoin` and `match`'s per-origin body both shed it here). A no-op
 *  when no origin is carried. */
export function dropOrigin(rel: Rel, fresh: Minter): Rel {
  const origin = originOf(rel.channels);
  if (!origin) return rel;
  const channels = rel.channels.filter((channel) => channel.col !== origin.col);
  const cols = rel.type.cols.filter((column) => column.name !== origin.col);
  return make.project({
    id: fresh('dx'), input: rel, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
  });
}

/** SHED the alias CHANNELS a plain `flatMap` body bound — `flatMap` re-derives from the pre-child head
 *  (`Traverser.split`), so a label bound inside it never escapes; leaving its channel would ride into a
 *  downstream whole-row `dedup`/merge as a spurious distinguishing column (the alias twin of `dropOrigin`).
 *  Keeps every non-alias channel, the payload, and the pre-body alias channels named by `keep` (their
 *  columns are lower-numbered; a body mints fresh higher-numbered ones off the incoming map's size). A
 *  no-op when the body bound none. */
export function shedBodyAliases(rel: Rel, keep: AliasMap, fresh: Minter): Rel {
  const keepCols = new Set([...keep.values()].map((entry) => entry.col));
  const drop = new Set(rel.channels.filter((channel) => channel.role === 'alias' && !keepCols.has(channel.col)).map((channel) => channel.col));
  if (!drop.size) return rel;
  const channels = rel.channels.filter((channel) => !drop.has(channel.col));
  const cols = rel.type.cols.filter((column) => !drop.has(column.name));
  return make.project({
    id: fresh('fa'), input: rel, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
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
 * The origin is a host ROWID, so an ELEMENT host is the only one served: a value stream has no rowid to
 * name its parent by, and `origin` is typed `int`. That is a real limit rather than a deferral of taste
 * — a scalar-hosted group-scoped reducer needs the role to carry a VALUE, which is a channels-core
 * change.
 *
 * **`perRow` picks WHICH identity the origin names, and the two consumers genuinely differ.** A GROUP
 * reducer (`group().by(<reducer>)`, `perRow: false`) pools members by the ELEMENT they reached, so the
 * origin is the element's rowid — two traversers at one element pool together, which is the point. A
 * per-traverser body (`local`/`flatMap`, `perRow: true`) must NOT pool: `g.V().both().local(out().limit(1))`
 * has three separate traversers at `marko`, each owed its own `limit(1)`, so the origin is a fresh
 * per-ROW number (`mintRowOrigin`), never the element id (which would collapse the three into one — the
 * exact wrong answer the element-id seed gave, the twin of `match`'s per-binding-row fix).
 */
/** The DOMAIN of origins a per-origin body scopes over — `seeded` reduced to a single `dorigin` column,
 *  one row per entering traverser. A SEEDED barrier (`fold`/`group`) LEFT JOINs this to emit its seed for an
 *  origin whose sub-stream is empty. Named `dorigin` (not `origin`) so the seed join can carry it beside the
 *  barrier's own `origin` key without a duplicate column; the payload is dropped — the seed needs only the
 *  origin values, and a narrow relation keeps the join cheap. Carried on `ChainCtx.originDomain`. */
export function originDomainOf(seeded: Rel, fresh: Minter): Rel {
  const origin = originOf(seeded.channels)!;
  // The entering POSITION rides too where the host has one (`DOMAIN_ENCOUNTER`), so the seeded barrier's
  // one row per entering traverser keeps the host's order.
  const enc = encounterOf(seeded.channels);
  return make.project({
    id: fresh('od'), input: seeded, channels: [],
    type: typeOf(meta('dorigin', 'int'), ...(enc ? [meta(DOMAIN_ENCOUNTER, 'int')] : [])),
    exprs: [['dorigin', col(seeded.id, origin.col)], ...(enc ? [[DOMAIN_ENCOUNTER, col(seeded.id, enc.col)] as const] : [])],
  });
}

export function childRows(
  body: readonly IRStep[], input: Rel, elem: Elem, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
  perRow = false, needsFromV = false, originFrom = 'id',
): ChildRows | null {
  // A per-ROW body REUSES an origin already on the input (`mintRowOrigin` is idempotent), so a caller
  // that pre-numbered to capture a channel keyed by origin — `flatMapRejoin`'s path-hide numbers the
  // input to recover the entering path — is served rather than refused. A GROUP reducer (`!perRow`) seeds
  // origin from the HOST rowid, a different identity, so a pre-existing origin there is still a decline.
  if (!body.length || (!perRow && originOf(input.channels))) return null;
  const seeded = perRow ? mintRowOrigin(input, fresh) : (() => {
    const channels = withChannel(input.channels, ORIGIN);
    return make.project({
      id: fresh('og'), input, channels, type: typeOf(...elementCols(channels)),
      // Driven off the MINTED channel list, not the input's plus one: `withChannel` inserts in
      // `ROLE_ORDER` (origin sits before encounter), and an appended expression would declare the columns
      // in a different order from `elementCols` — which the factory catches, and which would otherwise be
      // a schema desync no test names.
      exprs: [['id', col(input.id, 'id')],
        ...channels.map((channel) => [channel.col, channel.col === ORIGIN.col ? col(input.id, originFrom) : col(input.id, channel.col)] as const)],
    });
  })();
  // THE HOST'S LABELS RIDE IN, and handing over `NO_ALIASES` was a WRONG ANSWER rather than a
  // narrowing: a body reading one (`by(__.select('p').values('age').sum())`) would find no live label,
  // and since an unresolvable `select()` is now the EMPTY RESULT it would pool ZERO rows and answer an
  // empty map. §6·6's rule with the sharpest witness yet — check what a seam HANDS OVER, because the
  // combination of two correct rules made one of them silently produce the other's answer.
  // `needsFromV` rides IN only for a `flatMap`/`local` fan-out whose result an outer `otherV()` reads:
  // `inBody` cleared the demand (a body does not inherit it), so re-inject it here — the body's tail
  // edge hop then mints its entering vertex, which the rejoin carries out to the outer `otherV`.
  // THE ORIGIN DOMAIN rides in on the ctx so a SEEDED barrier in the body (`fold`→[], `group`→{}) can emit
  // its seed for an origin whose sub-stream is EMPTY — a `GROUP BY origin` over the post-fan-out stream
  // cannot, because a movement that fans out to zero drops that origin before the barrier sees it.
  // A body seeded from a traverser POSITION (`originFrom` — a write's value traversal) runs once per
  // traverser at bulk 1 (`AddPropertyStep.handleTraversalValue` → `TraversalUtil.applyAll`), so it BEGINS a
  // traversal (`ChainCtx.traversal`); a per-row `local`/`flatMap` body says so through its own `ctx`.
  const scoped: ChainCtx = originFrom !== 'id' && ctx.traversal?.steps !== body ? { ...ctx, traversal: { steps: body, rooted: false } } : ctx;
  const baseCtx = needsFromV ? { ...inBody(scoped), needsFromV: true } : inBody(scoped);
  const bodyCtx = { ...baseCtx, originDomain: originDomainOf(seeded, fresh) };
  const tail = continueAs(seeded, { kind: 'elements', elem }, body, 0, false, bodyCtx, fresh, aliases);
  // A body with EFFECTS is not a read, and one that lost the origin (a barrier inside it) has nothing
  // to group by — both are declines rather than answers that would silently pool the wrong rows.
  if (!tail || tail.effects?.length || !originOf(tail.rel.channels)) return null;
  return { rel: tail.rel, framing: tail.framing, origin: originOf(tail.rel.channels)!.col, aliases: tail.aliases };
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
/**
 * A `within`/`without` operand that is a NESTED traversal ending in `fold()` — a RUN-TIME member list
 * (`P.within(__.V(x).out('knows').values('age').fold())`) — as the SET relation `predicateExpr` explodes
 * with json_each, or `null` to decline.
 *
 * The folded traversal is ROOTED (it re-sources, `__.V(x)…`, so it is one fixed set for every incoming
 * traverser, correlated to nothing): lower it as a rooted read, take its ONE list value as a scalar
 * subquery, and explode it sole-from. A member value compares raw against the subject exactly as an
 * inline `within` list does — `Contains.within` is `.equals`, and a scalar fold's members are bare
 * (`[27,32]`). A non-list framing (not a fold), an effectful body (a write operand), or a body that does
 * not lower all decline — the resolver is `null`-total like every seam.
 *
 * Calcite prior art, and it matches EXACTLY: a value `IN` a collection is `RexSubQuery.in(rel, …)` over
 * an `Uncollect` — the `UNNEST` of the collection into rows (`vendor/calcite/core/.../sql2rel/SqlToRelConverter.java:6370`,
 * `vendor/calcite/core/.../rel/core/Uncollect.java:60`). `json_each` IS SQLite's `UNNEST`, so
 * `subject IN (SELECT sv FROM json_each(<list>))` is that lowering spelled in SQLite's dialect.
 */
export function foldedListSet(operand: unknown, ctx: ChainCtx, fresh: Minter): Rel | null {
  const body = bodyOf(isNested(operand) ? operand.nested : operand, ctx.params, ctx.sideEffects);
  // `Column.values` returns the map entry's value unchanged
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Column.java`).
  // `within` applies `Contains` equality to each collection member, so the entry's list is a set
  // relation here rather than the scalar first-value read used by `has(k, select(Column.values))`
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/Contains.java`).
  if (ctx.entryValue && body?.length === 1 && body[0]!.name === 'select' && body[0]!.args.length === 1
    && isColumnArg(body[0]!.args[0]!.value) && body[0]!.args[0]!.value.column === 'values') {
    const members = make.explode({
      id: fresh('evs'), channels: [], expr: ctx.entryValue, as: { value: 'sv' },
      type: typeOf(meta('sv', 'any', true)),
    });
    const value = col(members.id, 'sv');
    return make.project({
      id: fresh('evp'), input: members, channels: [], type: typeOf(meta('sv', 'any', true)),
      exprs: [['sv', {
        kind: 'case',
        whens: [[
          { kind: 'binary', op: '=', left: { kind: 'call', fn: 'json_type', args: [value] }, right: compilerText('object') },
          { kind: 'call', fn: 'json_extract', args: [value, compilerText('$.v')] },
        ]],
        else: value,
      }]],
    });
  }
  // The operand is the tagged `{nested}` arg; `rootedSteps` takes the inner ANTLR/Step[] payload.
  const steps = rootedSteps(isNested(operand) ? operand.nested : operand, ctx.params, ctx.sideEffects);
  if (!steps) return null;
  const read = rootedRead(steps, ctx, fresh, 'many');
  if (!read || read.effects?.length || read.framing.kind !== 'list') return null;
  const listValue: Expr = { kind: 'scalar', plan: make.project({
    id: fresh('wls'), input: read.rel, channels: [], type: typeOf(meta(LIST_COL, 'json', true)),
    exprs: [[LIST_COL, col(read.rel.id, LIST_COL)]],
  }) };
  return make.explode({
    id: fresh('wle'), channels: [], expr: listValue, as: { value: 'sv' },
    type: typeOf(meta('sv', 'any', true)),
  });
}

/**
 * A NESTED-traversal PREDICATE OPERAND as the FIRST scalar VALUE it produces — the operand form of
 * `within`/`without` varargs (`within(__.values(k), __.constant(v))`) AND of a comparison against a
 * traversal (`is(P.gt(__.V(x).values(k)))`, `has(k, P.eq(__.V(9999).values(k)))`). Returns `null` to
 * decline.
 *
 * `P.resolve(traverser)` (`vendor/tinkerpop/gremlin-core/.../P.java:328-373`) runs each child traversal
 * against the current traverser and takes `tv.next()` — its FIRST result — dropping an operand that
 * produced nothing. Two shapes reach that first value, and the operand's OWN head decides which:
 *
 * - a ROOTED operand (`__.V(x)…`, `__.E()…`) re-sources, so it is the SAME for every incoming traverser
 *   (correlated to nothing) — `rootedRead` lowers it and a scalar SUBQUERY over it takes the first row
 *   (SQLite reads the first row of a scalar subquery, which is `tv.next()`'s impl-defined order). This
 *   needs NO host, which is why `is`/`where` over a value stream reach it while a correlated operand
 *   there cannot.
 * - a CORRELATED operand (`__.values(k)`, `__.constant(v)`) is applied to the current traverser, so it
 *   is a child body over the element `host` and the correlated scalar seam gives the first value.
 *
 * A fold framing is refused (that is `foldedListSet`'s sole-operand set); a WRITE operand (`__.addV`)
 * has no scalar arm and declines, which is the right answer for a mutation inside a read predicate. A
 * member produced by nothing is a NULL scalar, inert in the caller's `IN`/`=` idiom exactly as the
 * reference's dropped-unproductive-operand is.
 */
export function nestedFirstValue(operand: unknown, host: ElementSubject | null, ctx: ChainCtx, fresh: Minter, aliases: AliasMap = NO_ALIASES): Expr | null {
  const body = bodyOf(isNested(operand) ? operand.nested : operand, ctx.params, ctx.sideEffects);
  if (!body?.length) return null;
  // A map-entry value is the ordinary scope value of `select(Column.values)`: Column returns the
  // entry's value unchanged (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/
  // gremlin/structure/Column.java`). The entry-rooted V()/E() arm supplies that correlated value.
  if (ctx.entryValue && body.length === 1 && body[0]!.name === 'select' && body[0]!.args.length === 1
    && isColumnArg(body[0]!.args[0]!.value) && body[0]!.args[0]!.value.column === 'values') return ctx.entryValue;
  if (body[0]!.name === 'V' || body[0]!.name === 'E') {
    const read = rootedRead(body, ctx, fresh, rootedHosts(host?.rel));
    if (!read) return null;
    // `P.resolve(traverser)` takes the operand's FIRST result (ORDER BY encounter, LIMIT 1); the whole
    // rule — and the decline for an effectful or non-scalar body — is `firstRootedValue` (`build.ts`),
    // shared with `list.ts`'s member-predicate operand so the two cannot drift.
    return firstRootedValue(read, fresh)?.value ?? null;
  }
  if (!host) return null;
  // The alias scope rides on the host's `row` so a `select(<label>)`-led operand can RE-ROOT to the
  // aliased traverser (`scalarChild`'s select arm → `selectRerootHost`), the operand-seam twin of
  // `selectRerootHost` in a `by()`/`map()` body — `has(k, P.gt(__.select('a').values(k)))` reads
  // alias `a`'s value for the current traverser. A correlated `__.values(k)` operand still resolves
  // against the element host exactly as before (the `row` is inert for it).
  const value = scalarChild(body, { kind: 'element', elem: host.elem, id: host.id, row: { rel: host.rel, aliases } }, ctx, fresh);
  return value && value.framing.kind === 'scalar' ? value.expr : null;
}

/**
 * `simplePath()` / `cyclicPath()` as a FILTER over the carried path array — kept iff the path's
 * objects are all distinct (`simple`) or not (`cyclic`). Every position is one tagged history entry
 * (`{k,v[,t]}`) and equal objects produce the IDENTICAL entry (an element by rowid, a value by its
 * `{v,t}`), so "no two objects equal" is `COUNT(*) = COUNT(DISTINCT entry)` over `json_each(path)` —
 * a correlated scalar subquery per row. A one-position path is trivially simple (1 = 1), which the
 * source's seeded p0 guarantees is the shortest case.
 */
export function pathSimplePredicate(rel: Rel, cyclic: boolean, from: string | undefined, to: string | undefined, fresh: Minter): Expr {
  const json: Expr = { kind: 'call', fn: 'json', args: [col(rel.id, PATH_CHANNEL.col)] };
  const exploded = make.explode({
    id: fresh('spx'), channels: [], expr: json, as: { value: 'pv', ord: 'po' },
    type: typeOf(meta('pv', 'any', true), meta('po', 'int')),
  });
  // A `from`/`to` scopes the simplicity check to the SUB-path (`subPathMembers`).
  const members = from !== undefined || to !== undefined ? subPathMembers(exploded, from, to, fresh) : exploded;
  // Path simplicity compares OBJECTS, never labels — so the distinctness key STRIPS the gated `L` label
  // array (`json_remove`, a no-op where no `from`/`to` put one on), or the same vertex visited under two
  // `as()` labels would read as two distinct objects and a cycle would slip through simplePath.
  const identity: Expr = { kind: 'call', fn: 'json_remove', args: [col(members.id, 'pv'), compilerText('$.L')] };
  const counted = make.aggregate({
    id: fresh('spc'), input: members, channels: [], type: typeOf(meta('total', 'int'), meta('uniq', 'int')),
    groupBy: [], aggs: [
      ['total', { kind: 'agg', fn: 'count', args: [] }],
      ['uniq', { kind: 'agg', fn: 'count', args: [identity], distinct: true }],
    ],
  });
  const probe = make.project({
    id: fresh('spp'), input: counted, channels: [], type: typeOf(meta('one', 'int')),
    exprs: [['one', { kind: 'binary', op: cyclic ? '!=' : '=', left: col(counted.id, 'total'), right: col(counted.id, 'uniq') }]],
  });
  return { kind: 'scalar', plan: probe };
}

/**
 * Where a rooted chain's FIRST traverser comes from. `'source'`: it is a fresh start traverser (a
 * source `g.union(…)` arm), so it holds the `withSack` seed, no loop and an empty path. `'split'`: it
 * is a mid-traversal `V()`/`E()` re-sourcing under a host (`map(__.V()…)`, a `P` operand, a `where`
 * body, a write's endpoint), which emits `head.split(element, this)`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:196`)
 * — so its sack, loops and path are the HOST traverser's.
 */
export type RootedStart = 'source' | 'split';

/**
 * Does a split body read state its first traverser inherits from the host? Its sack, loop counter or
 * path (`TRAVERSER_STATE_READS`), or a path LABEL: `Scoping.getScopeValue` resolves a key against the
 * traverser's path
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`),
 * and the split's path is the host's. A scope-key read (`scopeKeyReads`) at top-level step `i` of a
 * label the PROGRAM binds is the host's unless the body itself bound it before `i` (`labelsBoundBefore`,
 * which also clears at a barrier). Under a `Pop.first`/`Pop.all`/`Pop.mixed` anywhere in the body, even a
 * label the body bound may read the host's earlier bind, so any such read declines. This over-declines
 * (a string argument that is not really a scope key counts); it never answers wrong. A side-effect key
 * is global, not inherited, so reading one is not host state.
 */
function readsHostState(steps: readonly IRStep[], ctx: ChainCtx): boolean {
  const { params } = ctx;
  // An opening `V(<traversal>)` resolves its ids by running its child over the HOST traverser, so it is a
  // host read through and through (`__.V(__.identity())` is the host itself), never one shared evaluation.
  if (steps[0] && traversalIdArg(steps[0])) return true;
  if (someStepDeep(steps, params, (s) => TRAVERSER_STATE_READS.has(s.name))) return true;
  const popped = someStepDeep(steps, params, (s) => (s.args ?? []).some((a) => isPopArg(a.value) && a.value.pop !== 'last'));
  return steps.some((step, i) => {
    const reads = scopeKeyReads([step], params);
    if (reads.all) return true;
    const named = [...reads.labels].filter((label) => ctx.scopeNames.labels.has(label));
    if (!named.length) return false;
    if (popped) return true;
    const bound = labelsBoundBefore(steps, i, params);
    return named.some((label) => !bound.has(label));
  });
}

/**
 * HOW MANY TRAVERSERS a rooted read is evaluated for. `'one'` only where the statement provably reads it
 * for at most ONE host — then the one uncorrelated evaluation IS the reference's per-host one. Anything
 * a caller cannot name is `'many'`.
 */
export type RootedHosts = 'one' | 'many';

/**
 * The hosts a rooted read under `host` serves — `rowBounds` (`src/rel/bounds.ts`) is the one authority:
 * `'one'` where the host relation holds at most one row (a source `addE`'s one-row `Values`, `g.V(1)`,
 * `g.inject(x)`). It must also be SELF-CONTAINED: a host that reads an enclosing row is itself evaluated
 * per enclosing traverser, while the uncorrelated rooted read under it is evaluated once per statement
 * (SQLite runs an uncorrelated subquery once), so a one-row host inside a per-row body is still many.
 */
export const rootedHosts = (host: Rel | undefined): RootedHosts =>
  host && atMostOneRow(host) && isSelfContained(host) ? 'one' : 'many';

const SHARED_DRAW = 'a random draw (sample/coin/shuffle) inside a V()/E() body is not supported where the body may run '
  + 'for more than one traverser — it would be drawn once and shared by every row';

/**
 * A rooted chain lowered as one relation, or `null` to decline.
 *
 * A `'split'` read is computed ONCE for every host (an uncorrelated relation), so it cannot hold the
 * host's own sack, loop counter or path. A split body that reads any of them declines
 * (`readsHostState`): lowering it would answer with the `withSack` seed and a one-element path.
 * `withSack(1).V().sack(sum).by(constant(2)).map(__.V().sack())` would answer 1 where the reference
 * answers 3, `out().map(__.V().simplePath().count())` 6 where it answers 4, and
 * `as('x').map(__.V().as('y').select('x').count())` 0 where it answers 6. Correlating that state per
 * host would re-read the graph per traverser, which is unbuilt.
 *
 * For the same reason it cannot hold a DRAW (`nondeterministic`: `sample`, `coin`, a `shuffle`, at any
 * depth): evaluated once, every host would share one random choice where the reference draws per host
 * (`project('x').by(__.V().sample(1))` gave every row one name) — UNLESS there is only one host
 * (`hosts`, the caller's `rootedHosts`), where one draw and a per-host draw are the same thing:
 * `g.addE('r').from(__.V().sample(1))`, `g.V(1).project('x').by(__.V().sample(1))`. Where there may be
 * several it declines from the query text (`SHARED_DRAW`); a per-row draw already answers through
 * `local(__.V()…sample(1))`.
 *
 * That decline is TERMINAL (recorded into the compile's `Declines` with `terminal: true`), so a caller
 * lowering it inside a speculative probe (one whose `null` would fall through to another route) cannot
 * answer around it — that is intended: every route over the same rooted body shares the one evaluation.
 */
export function rootedRead(
  steps: readonly IRStep[], ctx: ChainCtx, fresh: Minter, hosts: RootedHosts, start: RootedStart = 'split',
): RootedRead | null {
  if (!steps.length) return null;
  if (start === 'split' && readsHostState(steps, ctx)) return null;
  if (start === 'split' && hosts === 'many' && nondeterministic(steps, ctx.params)) {
    ctx.declines.note({ kind: 'shared-draw', message: SHARED_DRAW, terminal: true });
    return null;
  }
  // The SETTLED values ride into a rooted chain too (`settledOf`), and their absence was a silent
  // narrowing: a rooted arm handed LESS than the chain around it declined for want of a fact the compile
  // already held. §6·6's lesson at a second seam — coverage must measure what the algebra can express,
  // never what the caller remembered to pass.
  const chain = lowerChain(steps, settledOf(ctx), fresh);
  if (!chain) return null;
  const read = { rel: chain.rel, framing: chain.framing, bulked: chain.bulked };
  return chain.effects ? { ...read, effects: chain.effects } : read;
}

/** A nested ROOTED traversal's steps, normalized — or `null` where normalizing RAISES (a deferral
 *  the compiler will raise for itself). A rooted body goes through `normalize(stepChain(…))` and not
 *  `childSteps`, which strips a source and answers the empty chain, i.e. an endpoint that silently
 *  matched nothing. */
export function rootedSteps(nested: unknown, params: ParamEnv, sideEffects?: SideEffectConstants): readonly IRStep[] | null {
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
export function hostSelf(host: ChildHost): { readonly framing: RelFraming; readonly col: (name: string) => Expr } | null {
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
  // A MAP host's identity `by()` is the whole map — the `map` framing over the host's own map value, the
  // twin of the list arm above.
  if (host.kind === 'map')
    return { framing: { kind: 'map', keyOf: host.keyOf, valOf: host.valOf }, col: (name) => (name === MAP_COL ? host.map : compilerNull()) };
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
export function rerootedHost(step: IRStep, host: ChildHost, fresh: Minter): Extract<ChildHost, { kind: 'element' }> | null {
  if (step.modulators?.length || step.optionArms || step.args.length) return null;
  const row = host.row ? { row: host.row } : {};
  if (host.kind === 'element' && host.elem === 'edge') {
    const end = step.name === 'outV' ? 'src' : step.name === 'inV' ? 'tgt' : null;
    // An ABSENT edge's endpoint is absent too — the endpoint read of a NULL id is NULL — so the presence
    // rides through (`hostPresence`).
    return end && { kind: 'element', id: edgeEndpoint(host.id, end, fresh), elem: 'vertex', ...row, ...(host.present ? { present: host.present } : {}) };
  }
  if (host.kind === 'property' && step.name === 'element')
    return { kind: 'element', id: propertyReadOf(host.id, host.ownerElem, 'owner', fresh), elem: host.ownerElem, ...row };
  return null;
}

/**
 * A `select(<label>)` in a child body REROOTS to the aliased traverser — the alias analogue of
 * `rerootedHost`'s endpoint/owner reroots, so `by(__.select('a').values('name'))`,
 * `concat(__.select('a'))` and `is(__.select('a')…)` all continue the body against whatever the label
 * named, whatever the current host is.
 *
 * The mechanism is entirely `aliasProjection`'s: `Scoping.getScopeValue` resolves a label off the
 * traverser's scope, and for an element/scalar/property host that scope IS the `HostRow`'s alias map.
 * An element alias becomes an element host, a value alias a scalar host carrying the label's per-row
 * type where it had one; a list/Pop history is a later phase and declines with the same `null` an absent
 * or non-live label gives — fail closed, never a guess off the wrong row.
 *
 * A RECORD host's own MAP SCOPE beats the labels (`Scoping.getScopeValue` tries `traverser.get()` as a
 * `Map` first — `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-131`),
 * so `select("v","s").order().by(__.select("v").values("name"))` re-roots to the record's `v` FIELD. That
 * resolution order is `scopedHost`'s (`modulator.ts`) — the one authority the `math`/`format` scope reads
 * use too — so it is delegated, not restated. A field the record may LACK on some rows (`optional`, a
 * non-productive `project().by()`) is a per-row map-vs-label decision this static re-root cannot make, so
 * it declines; a Pop-qualified select names a path history a map key does not have, so it declines too.
 */
export function selectRerootHost(step: IRStep, host: ChildHost, fresh: Minter): ChildHost | null {
  if (!host.row || step.modulators?.length) return null;
  const spec = selectSpec(step);
  if (!spec || spec.labels.length !== 1) return null;
  if (host.kind === 'record') {
    const label = spec.labels[0]!;
    if (spec.pop !== 'last' || fieldNamed(host.fields, label)?.optional) return null;
    return scopedHost(label, host);
  }
  const proj = aliasProjection(host.row.rel, host.row.aliases, spec.labels[0]!, spec.pop, fresh);
  if (!proj) return null;
  // THE NEW HOST MAY BE ABSENT on this row, two ways: the label was first bound inside a branch arm /
  // `optional()` / repeat body (`aliasGuard` — its payload reads NULL where it is unbound), or the CURRENT
  // host already was (a `select('a').select('b')`: the second label reads the ROW, so `a`'s absence must
  // gate it). Either way the new host carries `present`, which every body arm reads through
  // `hostPresence` — a statically bound label under a present host carries none, and its SQL is unchanged.
  const rerooted = rerootPresence(host, host.row.rel, proj);
  if (!rerooted) return null;
  const { key, present } = rerooted;
  const row = { row: host.row } as const;
  if (proj.read.kind === 'element') return { kind: 'element', id: key, elem: proj.read.elem, ...row, ...present };
  if (proj.read.kind === 'value') {
    const vtype = hostTag(proj.read.type, proj.payload[1]?.[1]);
    return { kind: 'scalar', value: key, ...(vtype ? { vtype } : {}), ...row, ...present };
  }
  return null; // a list/Pop history alias in a child body is a later phase
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

/** Is the relation `id` defined inside `rel` — a column of it is in scope there, not the outer row's? */
const reaches = (rel: Rel, id: string): boolean => {
  let found = false;
  forEachRel(rel, (r) => { if (r.id === id) found = true; });
  return found;
};

/** Is `rel`'s `name` column DETACHED from the tables the relation scans — computed by a correlated
 *  SUBQUERY, or read off the OUTER row (a scalar host's own value seeding a self root, `hostSelfRow`)?
 *  Follows only the projection chain (project/window/sort/limit/filter/distinct/materialize are
 *  passthroughs for a column they do not compute, and a computed column is detached where any column it
 *  reads is); reaching any real relation source (scan/join/values/aggregate/…) means the column is
 *  table-backed and the answer is false. Used by the correlated min/max argmax, whose ORDER BY re-inlines
 *  the value: SQLite resolves neither a second correlation level nor an outer column there (`no such
 *  column` at run time) — see its call site. */
function valueColIsDetached(rel: Rel, name: string): boolean {
  let cur: Rel = rel;
  let column = name;
  for (;;) {
    switch (cur.kind) {
      case 'project': {
        const entry = cur.exprs.find(([n]) => n === column);
        if (!entry) return false;
        const input = cur.input;
        if (entry[1].kind === 'col' && entry[1].rel === input.id) { column = entry[1].name; cur = input; continue; }
        if (exprHasSubquery(entry[1])) return true;
        // A COMPUTED column (`math('_+1')` over the value): detached where it reads the outer row directly,
        // or reads an input column that is itself detached.
        let detached = false;
        forEachExpr(entry[1], (node) => {
          if (node.kind === 'col' && !detached) detached = node.rel === input.id ? valueColIsDetached(input, node.name) : !reaches(input, node.rel);
        });
        return detached;
      }
      case 'window':
        if (cur.specs.some(([n]) => n === column)) return false;
        cur = cur.input; continue;
      case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize':
        cur = cur.input; continue;
      default:
        return false;
    }
  }
}

/**
 * A REDUCER OVER A CORRELATED BODY, rooted at `root` — `by(__.inE('created').values('weight').sum())`
 * and `by(__.values('age').max())` are the SAME lowering rooted differently (a movement hop, or a
 * one-row SELF relation). The body from `from` is the ordinary fold against `root`; EVERY path returns
 * (a `ChildValue` or `null`), so a caller either takes it or declines.
 *
 * `rootAs` is the SHAPE the body continues over, not just an element: an adjacency/self root is
 * `{kind:'elements'}`, but a LIST HOST's `unfold()` re-enters its MEMBERS, which may be a scalar stream
 * (`by(__.unfold().count()|sum()|fold())` over a scalar-membered list). The root shape only feeds the
 * ONE `continueAs` dispatcher, so a scalar root reduces through exactly the same collapse arms — the
 * member re-entry is a reachability question, not a second engine.
 */
export function correlatedReduce(
  root: Rel, rootAs: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' } | { readonly kind: 'list' } | { readonly kind: 'map' }>,
  body: readonly IRStep[], from: number, ctx: ChainCtx, fresh: Minter,
): ChildValue | null {
  // A TRAILING min/max is an ARGMAX, which the global reducer lowers as a window+materialize a
  // correlated subquery cannot host — a fence forces a named CTE that cannot reference the outer row,
  // so the numeric arm below declines it. The correlated pick is the SAME element as a `sort`+`limit(1)`
  // over the SAME single-type-space order (`minMaxOrder`, shared with the global barrier so the two
  // cannot drift), and the winner's own vtype is `minMaxWinnerVt`. Productivity for min/max is NOT the
  // value's nullness — ZERO rows emit NOTHING, an all-NULL input emits ONE null (`ReducingBarrierStep`)
  // — so a per-host EXISTS over the value rows is the `present` signal.
  const last = body.at(-1);
  if (last && (last.name === 'min' || last.name === 'max') && !last.args.length && !isLocalScope(last) && body.length > from) {
    const values = continueAs(root, rootAs, body.slice(0, -1), from, false, inBody(ctx), fresh, NO_ALIASES);
    let fenced = false;
    if (values) forEachRel(values.rel, (rel) => { if (rel.kind === 'materialize') fenced = true; });
    const probeCol = values?.rel.type.cols[0];
    if (values && !fenced && probeCol && values.framing.kind === 'scalar' && values.framing.result === undefined) {
      // The argmax is `SELECT … FROM (VALUES (1)) … ORDER BY <value> LIMIT 1` inside a subquery already
      // correlated to the outer row. `ORDER BY` cannot name a select alias, so the emitter RE-INLINES the
      // value expression there — and when the VALUE is itself a correlated subquery (a `by(__.id().min())` /
      // `by(__.label().min())`, whose value is the DETACHED `(SELECT … FROM nodes WHERE id = <outer>)` read
      // rather than a column off a table the body scans), that read sits TWO subquery levels deep, in the
      // ORDER BY of a subquery, where SQLite cannot resolve the outer reference (`no such column: rn.id` at
      // run time). A JOINED value (`by(__.values(k).min())`/`by(__.inE().values(k).min())` read a
      // `vertex_properties` column) resolves to a local column and is safe. Decline the subquery-valued
      // case rather than emit SQL that fails only in execution — fail closed, the class `capability.test.ts`
      // guards.
      if (payloadCols(values.rel).some((column) => valueColIsDetached(values.rel, column.name))) return null;
      // The winner keeps its OWN class (`lower.ts`'s global min/max — a deliberate divergence from
      // NumberHelper's promotion).
      const ordered = make.sort({ id: fresh('ms'), input: values.rel, channels: values.rel.channels, type: values.rel.type, terms: minMaxOrder(values.rel, values.framing, last.name === 'min') });
      const winner = make.limit({ id: fresh('ml'), input: ordered, channels: ordered.channels, type: ordered.type, count: compilerInt(1) });
      // A stream that may mix comparability classes refuses rather than let SQLite's class order pick.
      const cls = comparableClass(values.rel, values.framing);
      const picked = cls ? mixedClassesRefused(col(winner.id, 'v'), values.rel, cls, fresh) : col(winner.id, 'v');
      const vExpr = make.project({ id: fresh('mv'), input: winner, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', picked]] });
      const vtExpr = make.project({ id: fresh('mt'), input: winner, channels: [], type: typeOf(meta('vt', 'text', true)), exprs: [['vt', minMaxWinnerVt(winner, values.framing)]] });
      return {
        expr: { kind: 'scalar', plan: vExpr },
        // The result's class rides per row in `vt` (`REDUCED_TYPE`), so a predicate, a fold member and a
        // record field re-read through `select` all read it — a wide `long` carried as TEXT orders as the
        // number it is (`valuePredicate`).
        framing: { kind: 'scalar', type: REDUCED_TYPE, result: 'number' },
        vtype: { kind: 'scalar', plan: vtExpr },
        // Over no rows the winner is NULL — no value, which is presence (`ChildValue.present`).
        present: 'value-nullness',
        yields: 'one',
      };
    }
  }
  // A correlated reduction is a PER-TRAVERSER child: TinkerPop runs the body as its own traversal, one
  // parent traverser at a time (`TraversalUtil.apply`), so the body's step list begins it — the fact a
  // consumer that depends on where the reference bulked needs (`ChainCtx.traversal`).
  const tail = continueAs(root, rootAs, body, from, false, { ...inBody(ctx), traversal: { steps: body, rooted: false } }, fresh, NO_ALIASES);
  // …AND THE RELATION MUST ACTUALLY HAVE COLLAPSED, which the framing marker does NOT say. `result` is a
  // TYPE fact, not a CARDINALITY one: `__.out().local(__.in().count())` is one count PER OUT-VERTEX, so a
  // non-collapsed subquery has as many rows as the fan-out and SQLite silently takes the first
  // (measured: `[1,3,3,null,null,null]` where the reference gives `[1,1,1,3,3,3]`).
  if (!tail || !atMostOneRow(tail.rel)) return null;
  // A fence anywhere below is also a decline: this plan is correlated to the outer row, and a
  // Materialize forces a named CTE that cannot reference it.
  let materialized = false;
  forEachRel(tail.rel, (rel) => { if (rel.kind === 'materialize') materialized = true; });
  if (materialized) return null;
  // A PER-ORIGIN FOLD — the correlated body reduced to ONE list. `foldScalars`/`foldElements` COALESCE
  // an empty fold to `[]` (FoldStep's `ArrayListSupplier` seed), so a sink host emits `[]` with no
  // per-origin seed machinery; the fold IS the collapse `atMostOneRow` requires, and it is productive
  // (it seeds) wherever nothing above it can drop the row (`oneRowPresence`).
  if (tail.framing.kind === 'list') {
    const list = make.project({
      id: fresh('bl'), input: tail.rel, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      exprs: [[LIST_COL, col(tail.rel.id, LIST_COL)]],
    });
    return { expr: { kind: 'scalar', plan: list }, framing: tail.framing, present: oneRowPresence(tail.rel), yields: 'one' };
  }
  const scalarOf = (column: string): Rel => make.project({
    id: fresh('bc'), input: tail.rel, channels: [], type: typeOf(meta(column, 'any', true)),
    exprs: [[column, col(tail.rel.id, column)]],
  });
  // A SEEDED `fold(seed, Operator.x)` — a scalar out of a fold, so neither the list arm above nor the
  // reducer arms below. It is `count()`'s productivity, not `sum()`'s: `FoldStep` supplies its seed
  // before it draws a start (`ReducingBarrierStep.processAllStarts`, `…/step/util/ReducingBarrierStep.java:99-111`),
  // so a host whose sub-stream is EMPTY still emits the seed — ALWAYS productive. That holds only where
  // the fold ENDS the body: a step after it (`.is(…)`) can drop the one row, and the reducer arm below
  // would then read productivity off the fold's own input, which a seeded walk always has. So a seeded
  // fold anywhere else in the body declines rather than inherit that probe.
  const seededFoldAt = body.findIndex((step) => step.name === 'fold' && foldDeclared(step) !== PLAIN_FOLD);
  if (seededFoldAt >= 0) {
    if (seededFoldAt !== body.length - 1 || tail.framing.kind !== 'scalar') return null;
    return {
      expr: { kind: 'scalar', plan: scalarOf('v') },
      framing: tail.framing,
      ...(tail.framing.result === 'number' ? { vtype: { kind: 'scalar', plan: scalarOf('vt') } as Expr } : {}),
      present: oneRowPresence(tail.rel),
      yields: 'one',
    };
  }
  if (tail.framing.kind !== 'scalar' || (tail.framing.result !== 'count' && tail.framing.result !== 'number')) return null;
  // `count()` and the numeric reducers differ only in empty-input productivity: `CountGlobalStep` seeds
  // 0 (COALESCEd, ALWAYS productive), while `SumGlobalStep` leaves SQL's NULL alone and the by()
  // productivity filters drop it. A NUMERIC reducer carries its result's TYPE in `vt` — the winner's own
  // Gremlin vtype (min/max) or the SQLite storage class (sum/mean) — exposed as `vtype` so a consumer
  // that projects a second column (a record field, a collection member) lands it beside the value and
  // `by(sum())` composes exactly as `by(count())` does; a map side that carries one expression ignores
  // it.
  const scalar = scalarOf('v');
  if (tail.framing.result === 'count')
    return { expr: { kind: 'scalar', plan: scalar }, framing: tail.framing, present: oneRowPresence(tail.rel), yields: 'one' };
  // A NON-SEEDED numeric reducer (`sum`/`mean`, and a non-argmax `min`/`max`) emits NOTHING over zero
  // starts (`SumGlobalStep`), and SQL's aggregate over no rows is NULL — so its presence is its value's
  // nullness, and `local(outE.values('weight').sum())` on an edgeless vertex drops the traverser.
  return {
    expr: { kind: 'scalar', plan: scalar },
    framing: tail.framing, vtype: { kind: 'scalar', plan: scalarOf('vt') }, present: 'value-nullness', yields: 'one',
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
export const selfCollapses = (name: string): boolean => isReducer(name) || name === 'count' || name === 'fold';

/**
 * A body rooted at the HOST ITSELF — a one-row `Values` multiplier projected as the host id, handed to
 * `correlatedReduce` from step 0.
 *
 * The `Values`-then-`project` shape is `addV`/`mergeV`'s, so the host id rides in a NAMED column the join
 * reads by name rather than in a `Values` row whose columns are positional. Extracted because the branch
 * arm and the collapsing-barrier arm built it identically — two copies of a source shape is two chances
 * to disagree about what a self root IS.
 */
export function selfRootedReduce(body: readonly IRStep[], host: SelfRootedHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const self = hostSelfRow(host, fresh);
  return self && correlatedReduce(self.rel, self.framing, body, 0, ctx, fresh);
}

/**
 * A body ENDING in a collapsing barrier (`selfCollapses`), reduced over the host's ONE-ROW SELF — whatever
 * its head. The child traversal begins from the host traverser itself (`hostSelfRow`), so a head that does
 * not move (`count()`, `fold()`, `sum()`, `identity()…`, a transform run) is simply the first step over
 * that one row, and a reducer over it follows its own seed rule: `count()` → 1, `fold()` → `[v]`, a numeric
 * reducer → the value (or nothing where the global reducer answers nothing). ONE route for every
 * non-moving head over an element or a scalar host — `identity().count()` answered while `count()`
 * declined only because this gate once asked for a second step. Only a body that actually ENDS in a
 * collapse: a plain `by(__.values(k))` stays the expression arm, which takes the FIRST value (a different
 * cardinality, `yields: 'first'`) — that is the whole job of the gate.
 */
function selfCollapsed(body: readonly IRStep[], host: SelfRootedHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const terminal = body.at(-1);
  return terminal && selfCollapses(terminal.name) ? selfRootedReduce(body, host, ctx, fresh) : null;
}

/** The hosts a body can be SELF-ROOTED at: ONE traverser that is its own one-row relation — an element
 *  (its rowid) or a scalar (its value, and its per-row tag where it carries one). */
type SelfRootedHost = Extract<ChildHost, { kind: 'element' } | { kind: 'scalar' }>;

/**
 * THE ONE-ROW SELF RELATION of a host — `Values(1)` projected as the host's OWN payload columns
 * (`hostSelf`: an element's `id`, a scalar's `v` plus its `vtype` where it has one), the root every
 * self-rooted body continues from (`selfRootedReduce`, the `valueMap()`/`elementMap()` arm). It is
 * `TraversalUtil.apply`'s seed — the child traversal begins from the ONE host traverser at bulk 1
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:185-192`)
 * — so a body that does not start by moving (`count()`, `identity().fold()`, `sum()` over a number)
 * reduces exactly that one row, over an element or a scalar alike.
 *
 * It is the ONE place a body's input is built from a host WITHOUT being keyed on the host id, so it is
 * where an ABSENT host (`hostPresence` — a label unbound on this row, an unproductive intermediate value)
 * empties the input: the root keeps its row only where its payload is present. Over the empty input
 * SQLite's own aggregates answer the seeded tails exactly — `count()` 0, `fold()` `[]`, as
 * `ReducingBarrierStep` emits its seed over no starts
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ReducingBarrierStep.java:143-148`)
 * — and every unseeded one answers nothing. A root keyed on the id (a movement) needs no such term: the
 * NULL id already matches nothing. A host that cannot be absent adds no term at all.
 */
function hostSelfRow(
  host: SelfRootedHost, fresh: Minter,
): { readonly rel: Rel; readonly framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }> } | null {
  const present = hostPresence(host);
  const self = hostSelf(host);
  const framing = self?.framing;
  if (!present || !self || (framing?.kind !== 'elements' && framing?.kind !== 'scalar')) return null;
  // An element's rowid is never NULL on a row the root keeps (an absent host's row is filtered below); a
  // scalar's value may be — a productive null is a value.
  const cols = framingCols(framing)?.map((column) => (framing.kind === 'elements' ? { ...column, nullable: false } : column));
  if (!cols?.length) return null;
  const unit = make.values({ id: fresh('u'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  const selfRow = make.project({
    id: fresh('slf'), input: unit, channels: [], type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, self.col(column.name)] as const),
  });
  const rel = present === ALWAYS_PRODUCTIVE ? selfRow
    : make.filter({ id: fresh('slp'), input: selfRow, channels: [], type: selfRow.type, pred: presenceOf(host.present!, col(selfRow.id, cols[0]!.name))! });
  return { rel, framing };
}

/** A ChildHost as a filter/branch `Subject` — the inverse of `childHostOf` (`filter.ts`), so a
 *  predicate-bearing child (a `choose`'s condition, a `where` body) can run over the SAME traverser a
 *  value body reads. Needs the host's ROW to name the relation the id/value lives on; a host built
 *  without one declines rather than inventing a scope. */
export function hostSubject(host: ChildHost): Subject | null {
  const rel = host.row?.rel;
  if (!rel) return null;
  // The host's `present` rides across — an unbound label is as absent as a subject as it is as a host.
  const present = (host.kind === 'element' || host.kind === 'scalar') && host.present ? { present: host.present } : {};
  if (host.kind === 'element') return { kind: 'element', id: host.id, elem: host.elem, rel, ...present };
  if (host.kind === 'property') return { kind: 'property', id: host.id, ownerElem: host.ownerElem, rel };
  if (host.kind === 'scalar')
    return { kind: 'scalar', value: host.value, ...(host.vtype ? { vtype: host.vtype } : {}), rel,
      type: host.vtype ? perRowSubject(host.vtype, host.value) : SUBJECT_UNKNOWN, ...present };
  return null;
}

/**
 * `by(__.choose(<cond>, <then>[, <else>]))` over SCALAR arms → one per-row SQL `CASE` — the SCALAR twin
 * of the relational `chooseArms`.
 *
 * A boolean `choose` routes on the condition's PRODUCTIVITY: `ChooseStep` takes the THEN arm iff the
 * condition traversal PRODUCED for this traverser, the ELSE arm otherwise
 * (`vendor/tinkerpop/gremlin-core/.../branch/ChooseStep.java`). `CASE WHEN <cond> THEN … ELSE …` is that
 * exactly — SQL sends a false OR NULL `WHEN` to the ELSE, which is the productivity split
 * `chooseArms` spells with `notProduced` (an unproductive condition is a NULL predicate). Both arms must
 * reduce to one scalar per traverser (`scalarChild`); a MISSING else is identity, a scalar only over a
 * scalar host (an element identity is not one value), so it declines otherwise.
 *
 * The OPTION-MAP form (`choose(<key>).option(…)`) is a different question — an N-way lookup on a
 * projected choice — and declines here (`step.optionArms`), exactly as `chooseArms`/`chooseOptions` split.
 */
/** The traverser ITSELF as a scalar `ChildValue` — a scalar host's identity value, `choose`'s implicit
 *  pass-through and its absent-else arm. Shared so the two choose forms spell "the traverser" one way. */
const scalarHostIdentity = (host: Extract<ChildHost, { kind: 'scalar' }>): ChildValue =>
  ({ expr: host.value, framing: { kind: 'scalar', type: host.vtype ? PER_ROW('vtype') : UNKNOWN },
    ...(host.vtype ? { vtype: host.vtype } : {}), present: 'always', yields: 'one' });

/**
 * One scalar ARM's per-row type tag, for a branch that tags each row by the arm it came from: its own
 * `vtype` where it has one, its static tag as a literal, else NULL. Every tag is a Gremlin type name — a
 * numeric reducer arm's `vt` included (`REDUCED_TYPE`), so `choose(…, __.values('age').mean(), …)` is the
 * Double `MeanGlobalStep` answers (`MeanGlobalStep.java:175-177`).
 */
const armTag = (cv: ChildValue): Expr => {
  if (cv.vtype) return cv.vtype;
  const tag = cv.framing.kind === 'scalar' ? staticTypeOf(cv.framing.type) : undefined;
  return tag ? compilerText(tag) : compilerNull('text');
};

/**
 * `by(__.choose(<key>).option(k, s)…)` over SCALAR arms → one per-row SQL `CASE` — the OPTION-MAP twin of
 * `scalarChooseChild`, exactly as `chooseOptions` is `chooseArms`' twin in the relational world.
 *
 * The choice value is projected once (`scalarChild`); each keyed option gates on its key MATCHING the
 * choice (`predicateExpr`, the same compare `chooseOptions` and `is(P.…)` spend), first match winning
 * because a `CASE` takes its first true `WHEN` (`ChooseStep` overrides `pickBranches` to the first —
 * `.../branch/ChooseStep.java`). A PRODUCTIVE choice matching no key is `Pick.none`, or the traverser
 * itself where none is unwritten (the implicit pass-through — a scalar only over a scalar host); an
 * UNPRODUCTIVE choice takes `Pick.unproductive` where written, else falls to that same else (a NULL
 * choice fails every key predicate on its own, so the guard is needed only to reach a DISTINCT arm).
 *
 * A `__.discard()` option DROPS its rows — a productivity effect a per-row `CASE` cannot carry — so a map
 * containing one declines rather than silently keeping them; a `T`-token choice stays `chooseOptions`'.
 */
function scalarChooseOptions(step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const arms = optionArms(step, (nested) => bodyOf(nested, ctx.params));
  if (!arms || arms.some((arm) => arm.discard)) return null;
  const choiceArg = step.args?.[0]?.value;
  if (!isNested(choiceArg)) return null;
  const choiceBody = bodyOf(choiceArg.nested, ctx.params);
  const choice = choiceBody?.length ? scalarChild(choiceBody, host, ctx, fresh) : null;
  if (!choice || choice.framing.kind !== 'scalar' || choice.framing.result === 'value') return null;
  const choicePresent = presenceOf(choice.present, choice.expr);
  if (!choicePresent) return null;
  const choiceType: SubjectType = choice.vtype ? perRowSubject(choice.vtype, choice.expr)
    : choice.framing.type.kind === 'static' ? { kind: 'static', type: choice.framing.type.type, text: choice.framing.type.text }
    : SUBJECT_UNKNOWN;

  const armValue = (arm: OptionArm): ChildValue | null => {
    const body = bodyOf(arm.nested, ctx.params);
    const cv = body?.length ? scalarChild(body, host, ctx, fresh) : null;
    return cv && cv.framing.kind === 'scalar' && cv.framing.result !== 'value' ? cv : null;
  };
  const keyed: { readonly when: Expr; readonly cv: ChildValue }[] = [];
  for (const arm of arms.filter((a) => a.pick === 'key')) {
    const when = predicateExpr(choice.expr, arm.key, choiceType, arm.keyType, null, fresh);
    const cv = armValue(arm);
    if (!when || !cv) return null;
    keyed.push({ when, cv });
  }
  const noneArm = arms.find((a) => a.pick === 'none');
  const unproductiveArm = arms.find((a) => a.pick === 'unproductive');
  // BOTH `Pick` arms default to IDENTITY when unwritten (`ChooseStep`'s constructor installs a pass-through
  // for `Pick.unproductive` AND `Pick.none`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java:71-79`),
  // and `BranchStep.applyCurrentTraverser` routes an unproductive choice to the FIRST, never to `Pick.none`
  // (`…/step/branch/BranchStep.java:161-163`). So a written `none` does not serve an unproductive choice: it
  // falls to the identity pass-through, which is one value only over a SCALAR host.
  const identity = (): ChildValue | null => (host.kind === 'scalar' ? scalarHostIdentity(host) : null);
  const noneCV = noneArm ? armValue(noneArm) : null;
  const unproductiveCV = unproductiveArm ? armValue(unproductiveArm)
    : choice.present !== 'always' ? identity() : null;
  if ((noneArm && !noneCV) || (unproductiveArm && !unproductiveCV)) return null;
  if (!unproductiveCV && choice.present !== 'always') return null;
  const elseCV: ChildValue | null = noneCV ?? identity();
  if (!elseCV) return null;

  const guard: { readonly when: Expr; readonly cv: ChildValue } | null =
    unproductiveCV && choice.present !== 'always'
      ? { when: { kind: 'unary', op: 'not', arg: choicePresent }, cv: unproductiveCV } : null;
  return scalarChoice([...(guard ? [guard] : []), ...keyed], elseCV);
}

/**
 * A per-row CHOICE over scalar arms → ONE `ChildValue`: the value `CASE`, the type (a shared STATIC type
 * stays static — one column; otherwise a per-row `vtype` `CASE` that follows the same branch, because the
 * type must track WHICH arm the value came from) and the presence (`meetPresence`, a compile-time meet) are all built HERE,
 * from ONE `branches` array, so the three cannot pick different arms. The `if`/`else` choose and the option
 * map both end here; `scalarCoalesceChild` is the `COALESCE` twin.
 *
 * Each guard is spelled once per CASE that needs it — at most two (value, and `vtype` where the type is per-row).
 */
function scalarChoice(branches: readonly { readonly when: Expr; readonly cv: ChildValue }[], elseCV: ChildValue): ChildValue {
  const value: Expr = { kind: 'case', whens: branches.map((b) => [b.when, b.cv.expr] as const), else: elseCV.expr };
  const all = [...branches.map((b) => b.cv), elseCV];
  const present = meetPresence(all.map((cv) => cv.present));
  // A `'first'` arm (an unordered re-sourced body) is the first of several — the choice is too.
  const yields = all.some((cv) => cv.yields === 'first') ? 'first' : 'one';

  const staticTypes = all.map((cv) => cv.framing.kind === 'scalar' && cv.framing.result === undefined && !cv.vtype ? cv.framing.type : null);
  if (staticTypes.every((t): t is ScalarType => t !== null)) {
    const met = meetScalarTypes(staticTypes);
    if (met.kind === 'static') return { expr: value, framing: { kind: 'scalar', type: met }, present, yields };
  }
  const vtype: Expr = { kind: 'case', whens: branches.map((b) => [b.when, armTag(b.cv)] as const), else: armTag(elseCV) };
  return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present, yields };
}

function scalarChooseChild(step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (step.modulators?.length) return null;
  if (step.optionArms) return scalarChooseOptions(step, host, ctx, fresh);
  const [choice, ...rest] = step.args ?? [];
  if (!choice || rest.length < 1 || rest.length > 2 || rest.some((arg) => !isNested(arg.value))) return null;
  // The condition may be a bare predicate (`choose(P.eq(29), …)` — `ChooseStep(new IsStep(P))`) or a
  // body; spell a bare `P` as a one-step `is` so `bodyPredicate` handles both, exactly as `chooseArms`.
  const condition = isNested(choice.value) ? bodyOf(choice.value.nested, ctx.params)
    : isPred(choice.value) ? [{ name: 'is', args: [choice] } as IRStep] : null;
  const thenBody = bodyOf((rest[0]!.value as { readonly nested: unknown }).nested, ctx.params);
  const elseBody = rest[1] ? bodyOf((rest[1].value as { readonly nested: unknown }).nested, ctx.params) : null;
  if (!condition?.length || !thenBody?.length) return null;

  const subject = hostSubject(host);
  if (!subject) return null;
  const pred = bodyPredicate(condition, subject, fresh, ctx, host.row?.aliases ?? NO_ALIASES);
  if (!pred) return null;

  const thenCV = scalarChild(thenBody, host, ctx, fresh);
  // An absent ELSE is identity — a scalar only over a scalar host; an element identity is not one value.
  const elseCV: ChildValue | null = elseBody ? scalarChild(elseBody, host, ctx, fresh)
    : host.kind === 'scalar' ? scalarHostIdentity(host) : null;
  if (!thenCV || thenCV.framing.kind !== 'scalar' || thenCV.framing.result === 'value') return null;
  if (!elseCV || elseCV.framing.kind !== 'scalar' || elseCV.framing.result === 'value') return null;

  return scalarChoice([{ when: pred, cv: thenCV }], elseCV);
}

/** `by(__.coalesce(A, …, Z))` over SCALAR arms → one SQL `COALESCE(...)`. The SCALAR twin of the
 *  relational `coalesceArms`, covering both the MONOID-COMPLETION case — a semigroup reducer (`sum`/`mean`,
 *  NULL over an empty child) gains an identity from a `constant` fallback, so
 *  `coalesce(outE().values('w').sum(), constant(0))` is a weighted degree that reads 0 (not null) at a
 *  sink — AND the broader VALUE-OR-DEFAULT idiom (`coalesce(values(k), constant(x))`: a stored value with
 *  a fallback). The relational path (`BRANCH_HOSTS` self-root, below) still runs whenever an arm is an
 *  element/list/mixed shape — this only claims the all-scalar-arms case it can collapse to one SQL
 *  COALESCE.
 *
 *  Correctness — SQL `COALESCE` takes the first NON-NULL arg; Gremlin coalesce the first arm that
 *  PRODUCES. They agree because presence IS value nullness (`ChildValue.present`): a NULL arm is an absent
 *  one, so `coalesce(x, constant(1))` over a null `x` answers 1 — null-coalescing, the reading a user
 *  expects (the reference's `hasNext()` keeps a literal null; a documented divergence). `scalarChild` is
 *  the gate for SHAPE (it yields a scalar only for a body it can reduce to one value per traverser, so a
 *  fan-out arm declines), and a non-final arm that cannot say whether it produced declines.
 *
 *  NOT a group implicit fold: `group().by(k).by(coalesce(…))` produces ONE scalar per traverser, which
 *  the barrier-less value traversal keeps LAST via TinkerPop's `Operator.assign` (`GroupStep.java:60-63`,
 *  a value traversal with no reducing barrier; `Grouping.convertValueTraversal` folds only the OPTIMIZED
 *  `by("name")`/`by(T.label)` forms, and `ByModulatorOptimizationStrategy` leaves a bare `by(__.values(k))`
 *  un-optimized — pinned by `sideEffect/Group.feature`'s `by(__.constant(1))` → scalar `d[1].i`, not
 *  `l[1]`). The LIST needs an explicit `.fold()`, exactly as `by(values(k))` does — this is `map.ts`'s
 *  `single` arm, and it is correct as it stands. */
function scalarCoalesceChild(step: IRStep, host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args.map((a) => a.value);
  if (args.length < 2 || args.some((a) => !isNested(a))) return null;
  const bodies = args.map((a) => bodyOf((a as { readonly nested: unknown }).nested, ctx.params));
  if (bodies.some((b) => !b?.length)) return null;
  const bodyList = bodies as (readonly IRStep[])[];
  const arms: ChildValue[] = [];
  for (const body of bodyList) {
    const cv = scalarChild(body, host, ctx, fresh);
    if (!cv || cv.framing.kind !== 'scalar' || cv.framing.result === 'value') return null;
    arms.push(cv);
  }
  // Every NON-FINAL arm must STATE its productivity — else we cannot know when to fall to the next arm.
  if (arms.slice(0, -1).some((arm) => arm.present === 'unknown')) return null;
  const value: Expr = { kind: 'call', fn: 'COALESCE', args: arms.map((arm) => arm.expr) };
  // The whole is NULL only where every arm is: a value-nullness answer, unless the FINAL arm always
  // produces (a `constant`/token/`count()` fallback), whose NULL is then kept as the answer.
  const final = arms.at(-1)!;
  // A final arm that STATES its presence (a re-sourced `__.V()…` fallback) states it for ITSELF; where an
  // earlier arm answered, that arm's non-null value is the presence — `orValue`, so a consumer that
  // projects the value tests its column rather than reading every arm a second time.
  const present: Presence = typeof final.present === 'object' ? { when: final.present.when, orValue: true } : final.present;
  // A single shared STATIC type stays static (one column); otherwise a per-row tag whose column is the
  // COALESCE of each arm's own vtype — a reducer's `vt` expr, else the arm's static-type literal (the
  // expression-level twin of `withMergedVtype`, `build.ts`).
  const staticTypes = arms.map((a) => a.framing.kind === 'scalar' && a.framing.result === undefined && !a.vtype ? a.framing.type : null);
  if (staticTypes.every((t): t is ScalarType => t !== null)) {
    const met = meetScalarTypes(staticTypes);
    if (met.kind === 'static') return { expr: value, framing: { kind: 'scalar', type: met }, present, yields: 'one' };
  }
  // THE TAG OF THE ARM THAT ANSWERED — the same non-null test the value's `COALESCE` makes, arm for arm. A
  // `COALESCE` of the tags instead picks the first arm that HAS a tag, which is not the arm that
  // produced: `coalesce(__.constant('x'), __.out().count())` paired `'x'` (an untagged constant, NULL)
  // with the count arm's `'long'`, and framing `'x'` as a long threw at serialization. The tag is a
  // Gremlin type alone (`armTag` — a reducer arm's `vt` is one, `REDUCED_TYPE`), framed
  // `PER_ROW('vtype')` exactly as `choose`'s arm merge is: ONE arm-tag rule for
  // every branch child. A `result: 'number'` framing here was read only by the top-level framer, so a
  // Boolean or Date arm re-read after a `project(…).select(…)` / `fold()` lost its tag and came back a
  // Number (`project('a').by(coalesce(values('age'), constant(true))).select('a').fold()` answered `1`).
  const vtype: Expr = { kind: 'case', whens: arms.slice(0, -1).map((arm) => [isNot(arm.expr, compilerNull('text')), armTag(arm)] as const), else: armTag(final) };
  return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present, yields: 'one' };
}

/** The leading steps of the element arm whose value is a correlated read KEYED ON the host id, so a NULL
 *  id (an absent host) already reads NULL and owes no `gatedByHost` term. */
const READS_THROUGH_ID: ReadonlySet<string> = new Set(['values', 'label', 'id']);

const RESOURCE_UNDER_ABSENT = 'V()/E() inside this body discards the value before it, and that value is missing on some rows '
  + '(an unbound label, an absent property or key), so the answer would depend on which rows matched — did you mean '
  + 'to traverse FROM that value (out()/in()) or to filter by it (V().has(…, …))?';

/**
 * A RE-SOURCING body (`__.V()…`, `__.E()…`) as ONE value per host row — or `null` to decline.
 *
 * A mid-traversal GraphStep emits the graph PER INCOMING TRAVERSER
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java`),
 * so its rows do not depend on the host's VALUE and the body lowers once as an ordinary rooted read whose
 * one-row result is an UNCORRELATED scalar SQLite evaluates once.
 *
 * A host that MAY BE ABSENT (`mayBeAbsent` — a label unbound on some rows, a missing property or map key)
 * DECLINES with an explanation, a property of the query text. The re-source discards the host's value, so
 * all the host still contributes is WHETHER it exists on a row: the reference answers the body over an
 * EMPTY input there (`select('a').V().count()` is `0` on an unbound row, the graph's count elsewhere).
 * That answer is faithful but baffling — the shape almost always means `select('a').out()` or
 * `V().has(…, select('a'))` — so it is explained rather than computed. An always-present host
 * (`map(__.V().count())`, a `select('a')` the row was already filtered by) answers.
 */
function reSourcedUnder(host: ChildHost, body: readonly IRStep[], ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (mayBeAbsent(host)) {
    ctx.declines.note({ kind: 'resource-under-absent', message: RESOURCE_UNDER_ABSENT, terminal: true });
    return null;
  }
  return reSourcedValue(body, ctx, fresh, rootedHosts(host.row?.rel));
}

/** A re-sourcing body's value over the graph, whoever the host — `reSourcedUnder`'s one lowering. */
function reSourcedValue(body: readonly IRStep[], ctx: ChainCtx, fresh: Minter, hosts: RootedHosts): ChildValue | null {
  const rooted = rootedRead(body, ctx, fresh, hosts);
  if (!rooted || rooted.effects) return null;
  // A MAP-valued re-source (`__.V().has('name','lop').elementMap()`, a `project()` record collapsed to its
  // map) is the same first-result read over its pairs column. A map is never null, so the value's nullness
  // IS its productivity.
  const mapped = rooted.framing.kind === 'record' ? recordToMap(rooted.rel, rooted.framing.fields, ctx.source, fresh) : null;
  if (rooted.framing.kind === 'map' || mapped) {
    const framing: RelFraming = mapped
      ? { kind: 'map', keyOf: { kind: 'scalar' }, valOf: mapped.valOf, ...recordKeyFacts((rooted.framing as Extract<RelFraming, { kind: 'record' }>).fields) }
      : rooted.framing;
    const first = firstRootedColumn(mapped ? { ...rooted, rel: mapped.rel } : rooted, MAP_COL, fresh);
    return { expr: jsonOf(first), framing, present: 'value-nullness', yields: 'first' };
  }
  if (rooted.framing.kind !== 'scalar') return null;
  // A reducing barrier (`__.V().count()`) collapses to EXACTLY one row and is always productive.
  const counted = rootedCount(rooted, fresh);
  if (counted) return counted;
  // THE GENERAL rooted operand — `TraversalUtil.apply` takes the operand's FIRST result (`P.resolve` /
  // a `ScalarMapStep`, `vendor/tinkerpop/gremlin-core/.../P.java` `tv.next()`), and where the body ends
  // in `order()` the first is the ORDERED first, which `firstRootedValue` reads off the encounter
  // channel (`build.ts` — the one authority the predicate/list operand seams share). An EMPTY re-source
  // (`__.V(99999)`) maps to NO value (`TraversalUtil.apply` throws "does not map to a value"): a scalar
  // subquery over no rows is NULL, so productivity is the value's nullness — the concat/dateDiff
  // empty-operand guard raises on it, never silently skipping. `yields:'first'` because several rows
  // collapse to their first. A first value that is a PRODUCTIVE null (`__.V().constant(null)`, a null arm
  // sorted first by `order()`) reads as nothing too: SQLite's one-column scalar subquery cannot tell the
  // two apart, and the reference's hasNext()/next() distinction (`step/map/TraversalMapStep.java`) is not
  // worth a second EXISTS per read — docs/feature-support-matrix.md §17.
  // A PER-ROW type is the first row's own tag, read beside its value from the same fenced row, and the
  // framing names the `ChildValue.vtype` slot every consumer projects (`reductionTail`, a coalesce arm)
  // — never the rooted relation's `vtype`/`vt` column, which is not in the host's scope.
  const first = firstRootedValue(rooted, fresh, true);
  if (!first) return null;
  const present = 'value-nullness';
  return first.vtype
    ? { expr: first.value, vtype: first.vtype, framing: { kind: 'scalar', type: PER_ROW('vtype') }, present, yields: 'first' }
    : { expr: first.value, framing: rooted.framing, present, yields: 'first' };
}

/**
 * A SAMPLED RE-SOURCE IN A PER-TRAVERSER BODY — `property('c', __.V().hasLabel('person').sample(1)…)`,
 * `local(__.V().sample(2))` — with the prefix before the draw evaluated ONCE and the draw made per origin.
 * GraphStep emits the graph per incoming traverser
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java`),
 * so origin `o`'s stream is R_o copies of the M candidates — R copies of ONE evaluation only for a top-level
 * WHITELIST (`evaluableOnce`: no stream barrier, each step childless or a filter host) holding no draw,
 * collector or host-state read at any depth. `sample(1)` is one fenced index in 1..P (P = R_o·M) per origin,
 * equi-joined back, O(origins + M log M); `sample(n > 1)` ranks the P pairs by RANDOM() (`perOriginWindow`),
 * linear in the traversers the reference streams. A FAST PATH: `undefined` falls through to GraphStep's
 * product (`reSource`), which answers whatever this leaves; it never declines. Only the picks'
 * distribution is the reservoir's, not their order — §17 "Unordered slices".
 */
export function reSourcedOnce(
  steps: readonly IRStep[], at: number, input: Rel, bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | undefined {
  const origin = originOf(input.channels);
  if (!origin || !reSourcesOncePerOrigin(steps, at, input, bulked, ctx)) return undefined;
  const drawAt = drawIndex(steps, at);
  const prefix = steps.slice(at, drawAt);
  const draw = steps[drawAt]!;
  const rooted = rootedRead(prefix, ctx, fresh, 'many');
  if (!rooted || rooted.effects || rooted.bulked !== false || (rooted.framing.kind !== 'elements' && rooted.framing.kind !== 'scalar')) return undefined;
  // Only the payload crosses: a rooted channel other than its position and its (provably unit) bulk —
  // an alias, a path — is a fact about the candidate that the origins' channels have no slot for.
  if (rooted.rel.channels.some((channel) => channel.role !== 'encounter' && channel.role !== 'bulk')) return undefined;

  const int = (name: string): ColMeta => meta(name, 'int');
  const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
  const count: Expr = { kind: 'agg', fn: 'count', args: [] };
  const project = (from: Rel, cols: readonly ColMeta[], value: (name: string) => Expr = (name) => col(from.id, name)): Rel =>
    make.project({ id: fresh('sp'), input: from, channels: [], type: typeOf(...cols), exprs: cols.map((column) => [column.name, value(column.name)] as const) });
  const fence = (rel: Rel): Rel => make.materialize({ id: fresh('sf'), fenced: true, input: rel, channels: [], type: rel.type });

  // THE CANDIDATES, numbered once in their own order, and their number M.
  const K = 'sample_k', M = 'sample_m';
  const position = encounterOf(rooted.rel.channels);
  const payload = payloadCols(rooted.rel);
  const numbered = rowNumberWindow(rooted.rel, K, rooted.rel.channels,
    { partitionBy: [], orderBy: position ? [{ expr: col(rooted.rel.id, position.col), dir: 'asc' }] : [] }, fresh);
  const candidates = fence(project(numbered, [...payload, int(K)]));

  // THE ORIGIN ROWS, numbered within their origin and fenced (the draw and the join back both read the
  // number), and each origin's row count R. Their bulk is promoted HERE, on the origins before any join,
  // as GraphStep's crossing requires (`crossCarried`).
  const R = 'sample_r', RN = 'sample_rows';
  const parent = ensureBulk(input, fresh);
  const carried = carriedCols(parent.channels);
  const arriving = encounterOf(parent.channels);
  const ranked = rowNumberWindow(parent, R, parent.channels, {
    partitionBy: [col(parent.id, origin.col)], orderBy: arriving ? [{ expr: col(parent.id, arriving.col), dir: 'asc' }] : [],
  }, fresh);
  const rows = fence(project(ranked, [...carried, int(R)]));
  const O = 'sample_o', RI = 'sample_ri', KI = 'sample_ki';

  /** `sample(1)`: ONE uniform index D in 1..P = R·M per origin that has rows to draw from, located as its
   *  (origin row, candidate) coordinates. Both the span and the draw are fenced: the draw reads P three
   *  times, and the join probes below must read the draw rather than redraw it. */
  const drawOne = (): Rel => {
    const P = 'sample_p', D = 'sample_d';
    const size = make.aggregate({ id: fresh('sn'), input: candidates, channels: [], type: typeOf(int(M)), groupBy: [], aggs: [[M, count]] });
    const perOrigin = make.aggregate({
      id: fresh('sa'), input: rows, channels: [], type: typeOf(int(origin.col), int(RN)),
      groupBy: [col(rows.id, origin.col)], aggs: [[RN, count]],
    });
    const sized = make.join({ id: fresh('sj'), left: perOrigin, right: size, join: 'cross', channels: [], type: typeOf(int(origin.col), int(RN), int(M)) });
    const spanned = project(sized, [int(O), int(M), int(P)], (name) => name === O ? col(sized.id, origin.col)
      : name === P ? bin('*', col(sized.id, RN), col(sized.id, M)) : col(sized.id, name));
    const drawing = fence(make.filter({ id: fresh('sq'), input: spanned, channels: [], type: spanned.type, pred: bin('>', col(spanned.id, P), compilerInt(0)) }));
    const random: Expr = { kind: 'call', fn: 'RANDOM', args: [] };
    const span = col(drawing.id, P);
    const picks = fence(project(drawing, [int(O), int(M), int(D)], (name) => name === D
      ? bin('+', bin('%', bin('+', bin('%', random, span), span), span), compilerInt(1)) : col(drawing.id, name)));
    const offset = bin('-', col(picks.id, D), compilerInt(1));
    return project(picks, [int(O), int(RI), int(KI)], (name) => name === RI ? bin('+', bin('/', offset, col(picks.id, M)), compilerInt(1))
      : name === KI ? bin('+', bin('%', offset, col(picks.id, M)), compilerInt(1)) : col(picks.id, name));
  };
  /** `sample(n > 1)`: each origin's R·M (row, candidate) pairs ranked by RANDOM(), keeping rn <= n — the FENCED
   *  `perOriginWindow` `sliceOp` draws a top-level `sample(n)` with, SQLite's natural uniform n-subset. */
  const rankPairs = (): Rel => {
    const pairs = make.join({
      id: fresh('sj'), left: rows, right: candidates, join: 'cross', channels: [], type: typeOf(...rows.type.cols, ...candidates.type.cols),
    });
    const keyed = project(pairs, [int(O), int(RI), int(KI)], (name) => col(pairs.id, name === O ? origin.col : name === RI ? R : K));
    return perOriginWindow(keyed, col(keyed.id, O), [RANDOM_ORDER], { scope: 'global', offset: 0, limit: n }, fresh, true);
  };
  const n = countOf(draw);
  const chosen = n === 1 ? drawOne() : rankPairs();
  const row = make.join({
    id: fresh('sx'), left: chosen, right: rows, join: 'inner', ordered: true, channels: [],
    type: typeOf(...chosen.type.cols, ...rows.type.cols),
    on: and(eq(col(rows.id, origin.col), col(chosen.id, O)), eq(col(rows.id, R), col(chosen.id, RI))),
  });
  const met = make.join({
    id: fresh('sx'), left: row, right: candidates, join: 'inner', ordered: true, channels: [],
    type: typeOf(...row.type.cols, ...candidates.type.cols), on: eq(col(candidates.id, K), col(row.id, KI)),
  });

  // GraphStep's crossing (`crossCarried`): the origins' carried channels cross, their payload is replaced by
  // the candidate's, and the candidate's number K is the ordinal. ONE pick per origin keeps its row's
  // position; several re-mint it origin-major, then candidate order.
  const rel = crossCarried(parent, met, K, payload.map((column) => [column, column.name] as const), n > 1, ctx, fresh);
  return continueAs(rel, rooted.framing, steps, drawAt + 1, bulked, ctx, fresh, labels) ?? undefined;
}

/** The top-level global `sample` after the re-source at `at`: the draw `reSourcedOnce` makes per origin. */
const drawIndex = (steps: readonly IRStep[], at: number): number =>
  steps.findIndex((step, i) => i > at && step.name === 'sample' && !isLocalScope(step));

/**
 * `reSourcedOnce`'s ADMISSION GATE, mint-free and side-effect-free: may the re-source at `steps[at]` over
 * `input` draw per origin over ONE evaluation of its prefix? The ONE spelling of that rule. The route asks
 * it before it builds anything, and a `map()`/`flatMap()` host's `SHARED_DRAW` decline asks it before
 * suggesting `local(…)` (`localDrawsPerRow`), so the advice cannot name a form the route refuses.
 * It checks no origin (the per-row rejoin mints one) and lowers nothing (`rootedRead` and the rooted
 * shape checks stay in `reSourcedOnce`): holding it is necessary for the fast path, and it is the most a
 * hint can ask without building.
 */
export function reSourcesOncePerOrigin(steps: readonly IRStep[], at: number, input: Rel, bulked: boolean, ctx: ChainCtx): boolean {
  const drawAt = drawIndex(steps, at);
  if (drawAt < 0) return false;
  const prefix = steps.slice(at, drawAt);
  const { params } = ctx;
  const draw = steps[drawAt]!;
  if (bulked || draw.modulators?.length || draw.optionArms
    || input.channels.some((channel) => channel.role === 'path' || channel.role === 'sack' || channel.role === 'fromV')) return false;
  const read = rawBodies(params);
  const evaluableOnce = (step: IRStep): boolean => !isStreamBarrier(step) && (ONCE_FILTER_HOSTS.has(step.name) || !hasChild(step, read));
  if (!prefix.every(evaluableOnce) || readsHostState(prefix, ctx)) return false;
  return !nondeterministic(prefix, params) && !someStepDeep(prefix, read, collectsSideEffect, true);
}

/** The filter steps whose child runs PER TRAVERSER (`TraversalUtil.test` on one traverser at a time), so a
 *  prefix holding one is still R copies of one evaluation. */
const ONCE_FILTER_HOSTS: ReadonlySet<string> = new Set(['has', 'where', 'not', 'filter', 'is', 'and', 'or']);

/** Does this step hold a child traversal? An unreadable body counts as one. */
const hasChild = (step: IRStep, read: BodyReader): boolean => {
  let found = false;
  eachChildChain(step, read, () => { found = true; }, () => { found = true; });
  return found;
};

/** A rooted read that ends in `count()` and collapses to at most one row, as its one value — or `null`
 *  where it is not that shape. Present `'always'` only where the relation is EXACTLY one row
 *  (`exactlyOneRow`): a `count().is(P)` that rejects leaves no row, the scalar subquery reads NULL, and
 *  that NULL is the body's absence. Shared by the scalar arm and the map-entry arm. */
function rootedCount(rooted: RootedRead, fresh: Minter): ChildValue | null {
  if (rooted.framing.kind !== 'scalar' || rooted.framing.result !== 'count' || !atMostOneRow(rooted.rel)) return null;
  const scalar = make.project({
    id: fresh('rc'), input: rooted.rel, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', col(rooted.rel.id, 'v')]],
  });
  return {
    expr: { kind: 'scalar', plan: scalar }, framing: rooted.framing,
    present: oneRowPresence(rooted.rel), yields: 'one',
  };
}

/** A child body's ONE value per host row. */
export function scalarChild(body: readonly IRStep[], host: ChildHost, outer: ChainCtx, fresh: Minter): ChildValue | null {
  return scalarChildValue(body, host, outer, fresh);
}

/**
 * A NESTED per-traverser host as a child VALUE — `local(b)`/`map(b)`/`flatMap(b)` leading a correlated
 * child body. Its body runs over ONE entering traverser (`LocalStep.java:80-88`, `FlatMapStep.java:42-52`,
 * `MapStep`, under `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/`),
 * and in a correlated child that traverser IS the host, so the host step's value is `b`'s value over the
 * SAME host. The three differ only in cardinality, as at the chain (`perTraverserChild`'s policy): `map`
 * takes the first result, so it yields ONE; `local`/`flatMap` emit every result, so they yield what `b`
 * does, and a consumer that sees every result refuses a `'first'`.
 *
 * A body CONTINUING past the host re-roots onto that value — an element or scalar host carrying its
 * presence — only where it IS one value: a continuation over the first of several would run once where
 * the reference runs per result. Any other framing (a list, a map) declines here.
 */
function nestedHostChild(body: readonly IRStep[], host: ChildHost, child: ChildSeam): ChildValue | null {
  const step = body[0]!;
  const nested = step.args[0]?.value;
  if (step.modulators?.length || step.optionArms || step.args.length !== 1 || !isNested(nested)) return null;
  const inner = bodyOf(nested.nested, child.params);
  // Each re-entry below is on a STRICTLY SMALLER body (the host's own, then the steps after it), which is
  // what makes calling this directly from `valueRun` terminate.
  const produced = inner?.length ? child.scalar(inner, host) : null;
  if (!produced) return null;
  const value: ChildValue = step.name === 'map' ? { ...produced, yields: 'one' } : produced;
  if (body.length === 1) return value;
  if (value.yields !== 'one' || typeof value.present === 'object' || value.present === 'unknown') return null;
  const rest = body.slice(1);
  const carried = { ...(host.row ? { row: host.row } : {}), ...(value.present === 'always' ? {} : { present: value.present }) };
  const framing = value.framing;
  if (framing.kind === 'elements')
    return producedOnlyWhere(child.scalar(rest, { kind: 'element', id: value.expr, elem: framing.elem, ...carried }), value.present, value.expr, rest);
  if (framing.kind !== 'scalar') return null;
  const vtype = hostTag(framing.type, value.vtype);
  return producedOnlyWhere(child.scalar(rest, { kind: 'scalar', value: value.expr, ...(vtype ? { vtype } : {}), ...carried }), value.present, value.expr, rest);
}

/**
 * A child body's value over a value it was HANDED, produced only where that value was: where the run that
 * reached it produced NOTHING, the rest never runs (`values('nope').local(__.fold())` is no `[]`). A body's
 * own presence speaks only for a value it was given, so the handed value's presence is ANDed in as a stated
 * one, and the value is NULL there too (a consumer may read either), rather than trusted to every body to
 * read off its host. A member node computed apart from the value declines.
 *
 * "The rest never runs" holds only for a STRICT `rest`. One that can yield from an EMPTY stream — a seeded
 * barrier (`fold()` → `[]`, `count()` → `0`: `FoldStep`/`CountGlobalStep` supply a seed, under
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/`),
 * or any step `producesWithoutInput` names — answers its seed where nothing reached it, which no gate on the
 * handed value can say. So over a value that may be absent it DECLINES (a leading host then falls through
 * to the seam's other arms, which reduce the whole body).
 */
function producedOnlyWhere(ran: ChildValue | null, present: HostPresence, value: Expr, rest: readonly IRStep[]): ChildValue | null {
  if (!ran || present === 'always') return ran;
  if (producesWithoutInput(rest)) return null;
  const restPresent = presenceOf(ran.present, ran.expr);
  const here = presenceOf(present, value);
  if (!restPresent || !here || ran.node) return null;
  return { ...ran, expr: caseWhen(here, ran.expr), present: { when: and(here, restPresent === ALWAYS_PRODUCTIVE ? undefined : restPresent) } };
}

function scalarChildValue(body: readonly IRStep[], host: ChildHost, given: ChainCtx, fresh: Minter): ChildValue | null {
  if (!body.length) return null;
  // Every consumer of this seam applies its child as `TraversalUtil.apply` does — one host traverser at
  // a time at bulk 1 (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:185-192`)
  // — so the body BEGINS a traversal (`ChainCtx.traversal`).
  const outer: ChainCtx = given.traversal?.steps === body ? given : { ...given, traversal: { steps: body, rooted: false } };
  // A child VALUE is a correlated per-row read; a write anywhere in it (an arm of a `choose`/`coalesce`,
  // a `by()` of a `by()`) is a statement it has nowhere to declare (`writesAnywhere`).
  if (writesAnywhere(body, outer.params)) return null;
  // The host's labels are on the child's path; the roots below re-enter the fold WITHOUT their alias
  // channels, so they ride in as `enclosingLabels` — a scope read of one declines instead of answering
  // the unbound key's empty result.
  const ctx = withEnclosing(outer, host.row?.aliases);
  const first = body[0]!;

  // An unfolded map entry is a real child host, not a special `select(Column.values)` pattern. Seed a
  // one-row entry relation with its two correlated sides and hand the WHOLE body to the normal framing
  // dispatcher. Thus every map-entry/list/scalar tail composes here at arbitrary depth.
  if (host.kind === 'scalar' && host.entry) return mapEntryChild(body, { ...host, entry: host.entry }, ctx, fresh);

  // A NESTED per-traverser host leading the body (`choose(__.local(__.out('knows').count()))`,
  // `by(__.map(__.values('name')).toUpper())`) — see `nestedHostChild`. Where it cannot answer, the arms
  // below still may (a self-rooted reduce lowers a fan-out `local(…)` through the fold).
  if (PER_TRAVERSER_HOSTS.has(first.name)) {
    const nestedValue = nestedHostChild(body, host, childSeam(ctx, fresh));
    if (nestedValue) return nestedValue;
  }

  // `__.inject(…)` AS A CHILD BODY IS DEGENERATE — the injected literal never surfaces and the operand
  // is the host's OWN value. This is a real, uniform TinkerPop bug rather than a per-scenario quirk:
  // `TraversalUtil.apply` re-applies the SAME child object per host traverser via `reset(); addStart(host)`
  // (`vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53`), but `StartStep` latches
  // `first=false` after its first application and `InjectStep.reset()` never restores it
  // (`.../step/sideEffect/StartStep.java:59-77`, `.../step/sideEffect/InjectStep.java:46-50`), so the only
  // traverser left on `starts` is the re-added host value. Hence `concat(__.inject("c"))` doubles the
  // host and never reads "c" (`Concat.feature:60-93`). Every consumer of this seam (a `by()`, a concat /
  // dateDiff operand, a choose/coalesce arm) applies its child the same way, so the fact lives HERE once:
  // a trailing body continues against the SAME host; a bare inject IS the host, framed as itself.
  //
  // THAT IS A FIRST-RESULT FACT ONLY. The latch is set by the FIRST application, and that application
  // does add the injections — behind the host (`StartStep.processNextStart` appends them to `starts` after
  // the `addStart(host)`), so a first-result consumer reads the host either way, but a consumer that sees
  // EVERY result (`local`/`flatMap`) or a barrier after the inject (`local(__.inject(1, 2).dedup()
  // .fold())`) sees the injections for the first host and not for the rest — an arrival-order answer
  // this per-row value cannot give. So an inject WITH injections answers only bare and only as
  // `yields: 'first'` (every all-results consumer refuses that), and declines with a body after it;
  // an empty `__.inject()` adds nothing and is the identity at every position.
  if (first.name === 'inject') {
    const injects = first.args.length > 0;
    if (body.length > 1) return injects ? null : scalarChild(body.slice(1), host, ctx, fresh);
    const self = hostSelf(host);
    const cols = self && framingCols(self.framing);
    const payload = cols?.[0];
    if (!self || !payload) return null;
    const typeCol = cols.find((column) => column.name !== payload.name);
    return {
      expr: self.col(payload.name), framing: self.framing,
      // The host ITSELF, so it is present exactly where the host is.
      ...(typeCol ? { vtype: self.col(typeCol.name) } : {}), present: presentOfHost(host), yields: injects ? 'first' : 'one',
    };
  }

  // A GraphStep inside a per-traverser child RE-SOURCES the graph: its answer is independent of WHICH
  // host triggered it, and a host that may be absent declines (`reSourcedUnder`). This is the `map(__.V().count())`
  // half of re-sourcing; fan-out `flatMap(__.V()…)` is the general child rejoin's (`flatMapRejoin`),
  // rather than abusing a scalar subquery's arbitrary-first-row behaviour.
  // `V(<traversal>)` is not that: its ids come from its child run over THIS host, so it is the
  // per-traverser results then their lookup (`splitTraversalIds`), lowered like any other body.
  if (traversalIdArg(first)) return scalarChild(splitTraversalIds(body, 0), host, given, fresh);
  if (first.name === 'V' || first.name === 'E') return reSourcedUnder(host, body, ctx, fresh);

  // THE RECORD ARM — `by(__.project('a','b')…)`, one traverser in and one MAP out.
  //
  // `project()` is a `ScalarMapStep`, so it is a correlated single value exactly as `values(k)` is; the
  // only difference is that the value is a map rather than a scalar, which the framing SAYS. It is the
  // whole body or nothing: a chain past it (`__.project('a').select('a')`) re-roots to a field's own
  // stream, which is the RECORD relation's business and not a correlated read's.
  if (first.name === 'project' && body.length === 1) {
    // `project()` is a `ScalarMapStep` — one map per traverser, never several — and NONE over an absent
    // host (`gatedByHost`): its map is built from the row's labels as much as from the host. The map is
    // built UNDER that gate, so its `by()`s see the host present (`presenceDischarged`) rather than each
    // re-spelling the same presence term.
    const inner = presenceDischarged(host);
    const self = hostSelf(inner);
    const node = self && recordNode(first, inner, self.framing, self.col, childSeam(ctx, fresh), ctx.source, fresh);
    const expr = node && gatedByHost(host, node.node);
    return expr && { expr, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: node.valOf }, present: presentOfHost(host), yields: 'one' };
  }

  // `valueMap()`/`elementMap()` are the other per-traverser map producers. Reuse the ordinary map
  // builder so its key filtering, tokens, flat elementMap values and true `MapOf` descriptor cannot
  // diverge from the top-level step. `PropertyMapStep` is a ScalarMapStep — one map per element
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/PropertyMapStep.java`).
  if ((first.name === 'valueMap' || first.name === 'elementMap') && body.length === 1 && host.kind === 'element') {
    const args = first.args.map((a) => a.value);
    const tokens = args.includes(true);
    const asked = propertyKeyArgs(args.filter((arg) => !(tokens && arg === true)));
    if (!asked || first.modulators?.length || first.optionArms || (first.name === 'elementMap' && tokens)) return null;
    // The ONE self root, so an absent host (an unbound label) maps NOTHING rather than `{}`.
    const self = hostSelfRow(host, fresh);
    if (!self) return null;
    const mapped = elementValueMap(self.rel, host.elem, asked.all ? null : asked.keys,
      first.name === 'elementMap' || tokens, ctx.labelRegime, ctx.source, fresh,
      first.name === 'elementMap' ? { flat: true, endpoints: true } : {});
    const scalar = make.project({
      id: fresh('vn'), input: mapped.rel, channels: [], type: typeOf(meta(MAP_COL, 'json', true)),
      exprs: [[MAP_COL, col(mapped.rel.id, MAP_COL)]],
    });
    return { expr: jsonOf({ kind: 'scalar', plan: scalar }), framing: { kind: 'map', keyOf: mapped.keyOf, valOf: mapped.valOf }, present: presentOfHost(host), yields: 'one' };
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
    if (body.length === 1) return { expr: rerooted.id, framing: { kind: 'elements', elem: rerooted.elem }, present: presentOfHost(rerooted), yields: 'one' };
    return scalarChild(body.slice(1), rerooted, ctx, fresh);
  }

  // A MAP host's `select(<key>)` reads the map's OWN entry (`Scoping` tries the traverser Map first), a
  // DIFFERENT question from the alias re-root below — so it is intercepted here, before the generic
  // `select` arm can mis-read it as an alias. Every other map-host child body declines (a map has no
  // value/token/property to project; a rooted `V()`/`E()` body was handled above).
  if (host.kind === 'map') return mapHostChild(body, host, ctx, fresh);

  // A `select(k)` of a `withSideEffect` CONSTANT is that constant over any element or scalar host
  // (`sideEffectSelectChild`) — the scope a non-Map traverser reads before the path.
  if (first.name === 'select') {
    const constant = sideEffectSelectChild(body, host, ctx, fresh);
    if (constant !== 'pass') return constant;
  }

  // A `select(<label>)` RE-ROOT — the alias analogue of the endpoint/owner reroots above, so a child
  // body may read a bound label and continue against it. A bare `select('a')` yields the aliased
  // traverser itself (an element or a value); a chain past it continues against the new host.
  // …and a PER-ROW SCALAR host may itself be a Map, whose own entry precedes a side effect or the empty
  // answer (`scalarMapFirstChild`); a label key passes to the alias re-root below unchanged.
  if (first.name === 'select' && host.kind === 'scalar') {
    const mapped = scalarMapFirstChild(body, host, ctx, fresh);
    if (mapped !== 'pass') return mapped;
  }
  if (first.name === 'select') {
    const reHost = selectRerootHost(first, host, fresh);
    if (!reHost) return null;
    // The label's traverser ITSELF, present exactly where the label is bound (`presentOfHost`).
    if (body.length === 1) {
      if (reHost.kind === 'element') return { expr: reHost.id, framing: { kind: 'elements', elem: reHost.elem }, present: presentOfHost(reHost), yields: 'one' };
      if (reHost.kind === 'scalar') return {
        expr: reHost.value, framing: { kind: 'scalar', type: reHost.vtype ? PER_ROW('vtype') : UNKNOWN },
        ...(reHost.vtype ? { vtype: reHost.vtype } : {}), present: presentOfHost(reHost), yields: 'one',
      };
    }
    return scalarChild(body.slice(1), reHost, ctx, fresh);
  }

  // A PROPERTY host's three projections are STEPS, and two of them read the stored row. `element()` is
  // the third and re-roots above, which is why it is not here.
  if (host.kind === 'property') {
    // A property's KEY is always present and always a string; its VALUE carries the stored `vtype` per
    // row, which is `propertyValue`'s channel read through a rowid instead of through the join.
    if (first.name === 'key' && !first.args.length)
      return valueRun(body, 1, { value: propertyReadOf(host.id, host.ownerElem, 'key', fresh), type: STATIC('string'), vtype: undefined, present: 'always', yields: 'one' }, host.row, childSeam(ctx, fresh), ctx.source, fresh);
    if (first.name === 'value' && !first.args.length)
      return valueRun(body, 1, {
        value: propertyReadOf(host.id, host.ownerElem, 'value', fresh), type: UNKNOWN,
        vtype: propertyReadOf(host.id, host.ownerElem, 'vtype', fresh), present: 'always',
        // A property traverser IS one property, so its key and its value are each exactly one.
        yields: 'one',
      }, host.row, childSeam(ctx, fresh), ctx.source, fresh);
    return null;
  }

  // A SCALAR host names its own subject: the traverser IS the value, so a transform-only body
  // (`by(__.math('_ * 10'))`, `by(dateAdd(DT.day, 1))`) is well-formed rather than the nonsense it
  // would be over an element. That is the "A BODY MUST NAME ITS SUBJECT" guard below read the other
  // way round — the guard exists because an element is not a value, and here there is one.
  if (host.kind === 'scalar' && host.vtype && collectionReaderOf(first)) return perRowCollectionChild(body, { ...host, vtype: host.vtype }, ctx, fresh);
  // A body ENDING in a collapse over a scalar host reduces the host's ONE value — the same self seed an
  // element host's reducer body takes (`selfCollapsed`), so `sum()`, `identity().fold()` and
  // `math('_+1').sum()` answer as `identity().count()` already did over an element.
  if (host.kind === 'scalar') return selfCollapsed(body, host, ctx, fresh) ?? scalarHostChild(body, host, childSeam(ctx, fresh), ctx.source, fresh);
  if (host.kind === 'list') return listHostChild(body, host, ctx, fresh);
  // A PROJECTOR body over a RECORD host reads the record's FIELDS as scope variables — `math("a / b")`
  // resolves `a`/`b` against the record's map (`Scoping.getScopeValue`, the same rule the direct chain
  // step `project(a,b).math("a / b")` follows). It is one `ScalarMapStep` producing one value per
  // traverser, so it is a correlated scalar exactly as a value body is — which is what lets
  // `order().by(__.math("a / b"))` / `by(__.format(...))` over a `project(...)` record become an order
  // key rather than declining. Only a SINGLE projector step (a tail past it would re-enter over the
  // projector's scalar result, not the record — a later increment).
  if (host.kind === 'record') {
    if (body.length !== 1 || !REL_PROJECTORS.has(first.name)) return null;
    const projected = projectorValue(first, host, childSeam(ctx, fresh), ctx.source, fresh);
    return projected && projected.framing.kind === 'scalar'
      ? { expr: projected.value, framing: projected.framing, present: 'always', yields: 'one' }
      : null;
  }
  if (host.kind !== 'element') return null;

  // A REDUCER OVER A CORRELATED BODY, rooted TWO ways through ONE engine (`correlatedReduce`): a
  // MOVEMENT hop (`by(__.inE('created').values('weight').sum())`) roots the fold at the adjacency, and a
  // value chain over the HOST ITSELF (`by(__.values('age').max())`) roots it at a one-row SELF relation.
  // A movement is not required — what is required is that the body END in a reducer; a bare
  // `__.count()`/`__.values(k)` with no reduction falls through to the expression arm below.
  const child = movement(body[0]!, { correlated: host.id }, host.elem, ctx.source, fresh);
  if (child) return correlatedReduce(child.rel, { kind: 'elements', elem: child.elem }, body, 1, ctx, fresh);
  // A BRANCH-headed body (`by(__.union(a,b)….fold())`) — the union fans the host out over its arms, then
  // the tail reduces. `continueAs` already lowers a `union`/`choose`/`coalesce` over an INPUT relation
  // (the chain-position branch), so rooting it at the one-row SELF relation carrying the host id and
  // handing the WHOLE body (from 0) to `correlatedReduce` composes it with the per-origin fold that
  // arm already builds — no branch-in-by special case, just the self-root the numeric self-reducer above
  // uses one hop later. This is what lets an emit-unrolled recurse (`union` of level-prefixes) sit inside
  // a `project().by()`, the shape a GraphQL `@recurse` field lowers to.
  // A scalar-armed `coalesce` is a per-row `COALESCE(...)` (monoid completion), not the relational
  // arm-major union the self-root below builds; try it first, fall through to that for element/list arms.
  if (body.length === 1 && first.name === 'coalesce') {
    const coalesced = scalarCoalesceChild(first, host, ctx, fresh);
    if (coalesced) return coalesced;
  }
  // A boolean `choose(<cond>, <then>[, <else>])` whose arms are scalars is a per-row `CASE`, not the
  // relational arm-major union the self-root below builds; try it first, fall through for element/list arms.
  if (body.length === 1 && first.name === 'choose') {
    const chosen = scalarChooseChild(first, host, ctx, fresh);
    if (chosen) return chosen;
  }
  if (BRANCH_HOSTS.has(body[0]!.name)) {
    const reduced = selfRootedReduce(body, host, ctx, fresh);
    if (reduced) return reduced;
  }
  // The SELF root: no leading hop, so the barrier aggregates/argmaxes/COLLECTS the host's OWN rows
  // exactly as it does an adjacency's — a `values(k)`/`labels()` join against a one-row relation carrying
  // the host id (`selfCollapsed`, the scalar host's seed too).
  const reduced = selfCollapsed(body, host, ctx, fresh);
  if (reduced) return reduced;

  let value: Expr = host.id;
  // WHETHER THIS BODY PRODUCES anything for the host row, where the leading step can say precisely.
  // `'unknown'` is "cannot say", which is not the same as "always" — see `ChildValue.present`.
  let present: Presence = 'unknown';
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
    const args = leading.args.map((a) => a.value);
    if (args.length !== 1 || typeof args[0] !== 'string') return null;
    const projected = byExpr({ key: { kind: 'property', key: args[0] } }, host, ctx.source, fresh);
    if (!projected) return null;
    value = projected;
    vtype = propertyVtype(args[0], host, fresh);
    // A property read's productivity is whether the property row exists — which IS its value's
    // non-nullness, because TinkerPop has no null-valued property. Read off the SAME value the source
    // answered (`byExpr` → `source.propertyScalar`), never a second raw-table scan: a decorated source
    // (`pageRank()`'s computed property) answers a value the base table does not hold, and an EXISTS over
    // the table then read that present value as absent.
    present = 'value-nullness';
    // …and the one that may have had MORE to give: a vertex key is multi-valued and `byExpr` takes
    // the insertion-order first, which is `map()`'s answer and not `local()`/`flatMap()`'s.
    yields = 'first';
    at = 1;
    // A FILTER right after the read tests EVERY value, and the first-result answer is the first SURVIVOR —
    // so the leading `is(P)`s are pushed INTO the property rows (`propertyFirstPassing`) rather than applied
    // to the first stored value, which over `loc = [a, b]` made `by(__.values('loc').is('b'))` unproductive
    // and `where(__.values('loc').is('b'))` drop the vertex. The filtered read names the base property
    // tables, so any other source declines rather than read rows it does not hold.
    // A TRANSFORM before the test (`values('name').toUpper().is('MARKO')`) is the same question one map
    // later: the transform-and-test run is applied to EACH property row, and the first survivor
    // contributes its transformed value. The run is `valueRun` over the stored row, so a failed `is()`
    // is a NULL there and a survivor is a non-NULL.
    let runEnd = 0;
    if (REL_TRANSFORMS.has(body[1]?.name ?? '')) {
      for (let j = 1; j < body.length && (REL_TRANSFORMS.has(body[j]!.name) || body[j]!.name === 'is'); j++)
        if (body[j]!.name === 'is') runEnd = j;
    }
    // Where the filtered read cannot be built (another source, a host it cannot name), the run falls
    // through to the general value run below, exactly as it did before this arm.
    if (runEnd && ctx.source === BaseGraph) {
      const testRun = body.slice(0, runEnd + 1);
      const runOver = (stored: Expr, storedType: Expr) => valueRun(testRun, 1,
        { value: stored, type: UNKNOWN, vtype: storedType, present: 'value-nullness', yields: 'one' },
        host.row, childSeam(ctx, fresh), ctx.source, fresh);
      let runType: ScalarType = UNKNOWN;
      const passing = propertyFirstPassing(args[0], host, (stored, storedType) => {
        const ran = runOver(stored, storedType);
        return ran && isNot(ran.expr, compilerNull());
      }, fresh, (stored, storedType) => {
        const ran = runOver(stored, storedType);
        if (ran?.framing.kind === 'scalar' && !ran.vtype) runType = ran.framing.type;
        return ran?.framing.kind === 'scalar' && !ran.vtype ? ran.expr : null;
      });
      if (passing) {
        value = passing.value;
        type = runType;
        vtype = undefined;
        at = runEnd + 1;
      }
    }
    const tests: { readonly pred: unknown; readonly arg: IRStep['args'][number] }[] = [];
    while (!runEnd && body[at]?.name === 'is' && !body[at]!.modulators?.length) {
      const pred = body[at]!.args[0]?.value;
      if (pred == null || body[at]!.args.length !== 1) return null;
      tests.push({ pred, arg: body[at]!.args[0]! });
      at++;
    }
    if (tests.length) {
      if (ctx.source !== BaseGraph) return null;
      // A traversal OPERAND (`is(select(Column.values))`, `is(__.V(x).values(k))`) resolves as the predicate
      // seam resolves it (`valueClause`, filter.ts): a folded list as a set, anything else as its first value.
      const subject = hostSubject(host);
      const operandHost = subject?.kind === 'element' ? subject : null;
      const passing = propertyFirstPassing(args[0], host, (stored, storedType) => {
        let all: Expr | undefined;
        for (const t of tests) {
          const one = predicateExpr(stored, t.pred, perRowSubject(storedType, stored), t.arg.type ?? null, t.arg.name ?? null, fresh,
            (nested) => foldedListSet(nested, ctx, fresh), (nested) => nestedFirstValue(nested, operandHost, ctx, fresh, host.row?.aliases ?? NO_ALIASES));
          if (!one) return null;
          all = and(all, one);
        }
        return all ?? null;
      }, fresh);
      if (!passing) return null;
      ({ value, vtype } = passing);
    }
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
    // contribution was one value or the first of several — and the same goes for WHETHER it produced.
    yields = produced.yields;
    present = produced.present;
    at = 1;
  } else if (leading?.name === 'label' || leading?.name === 'id') {
    if ((leading.args ?? []).length) return null;
    // A `T` token is ALWAYS present — every element has a label and an id — and saying so is a CLAIM
    // rather than the silence `undefined` means.
    present = 'always';
    const projected = byExpr({ key: { kind: 'token', token: leading.name } }, host, ctx.source, fresh);
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
    const projected = projectorValue(leading!, host, childSeam(ctx, fresh), ctx.source, fresh);
    if (!projected) return null;
    value = projected.value;
    type = projected.framing.kind === 'scalar' ? projected.framing.type : UNKNOWN;
    // A projector ALWAYS maps (a `MapStep`), except where its `drop` says a NULL is an unproductive
    // `by()` it FILTERS (`MathStep.java:75-78`) — so that is its presence, stated rather than withheld.
    present = projected.drop ? 'value-nullness' : 'always';
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
    // A FRESH traverser (`freshTraverserRow`) holds the INITIAL sack and no loop — not the row's channel.
    if (host.row?.fresh) return null;
    const carried = host.row?.rel.channels.find((channel) => channel.role === CARRIED_READ[leading!.name]);
    // The state is not carried HERE — `sack()` with no `withSack()`, `loops()` outside a walk. The
    // reference raises for both; declining hands the whole traversal to a route that can say so.
    if (!carried) return null;
    value = col(host.row!.rel.id, carried.col);
    // Live on every row of a relation that carries the channel at all, which is what makes this a
    // CLAIM rather than the silence `undefined` means.
    present = 'always';
    // `loops()` is an int by construction (`CHANNEL_COL`); a sack carries its own per-row tag
    // (`sackTagOf`), the same carrier a stored property's `vtype` is — so every receiver check
    // downstream reads a `withSack(true)` as the Boolean it is, not as SQLite's integer 1.
    if (carried.role === 'loops') type = STATIC('int');
    if (carried.role === 'sack') vtype = sackTagOf(host.row!.rel);
    at = 1;
  } else if (leading?.name === 'constant') {
    const args = leading.args.map((a) => a.value);
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
    // The constant's OWN declared type — the chain-level `constant()`'s authority (`declaredScalarType`),
    // so `constant(1L)` in a body is a Long there too. Left `UNKNOWN`, the framer inferred it from the
    // storage class, and a branch merge had no tag to keep: `flatMap(coalesce(constant(1L),
    // constant('x')))` answered Int 1.
    type = declaredScalarType(leading.args[0]);
    present = 'always';
    at = 1;
  }

  // A BODY MUST NAME ITS SUBJECT, and this guard is the difference between declining and answering
  // nonsense. Without it a transform-only body falls through with `value` still the element's ROWID, so
  // `order().by(__.toUpper())` lowers to `upper(<rowid>)` — a plausible-looking answer to a traversal
  // TinkerPop REJECTS (`The toUpper() step can only take string as argument`), which is the worst
  // direction the "never answer a different question" rule has. A transform needs a value in front of
  // it; an element is not one. Measured on this very increment, so it is a guard with a witness.
  if (at === 0) return null;

  // AN ABSENT HOST (a label unbound on this row — `hostPresence`) PRODUCES NOTHING, whatever the leading
  // step. A read THROUGH the id (`values(k)`, `label()`, `id()`) is already NULL for a NULL id, so it only
  // states that; one that reads the ROW or nothing (`constant()`, `sack()`, a projector, a service) is
  // gated, or an unbound label reads as one phantom value. A host that cannot be absent changes nothing.
  if (mayBeAbsent(host)) {
    if (!READS_THROUGH_ID.has(leading!.name)) {
      const gated = gatedByHost(host, value);
      if (!gated) return null;
      value = gated;
    }
    if (present !== 'unknown') present = 'value-nullness';
  }

  const run = valueRun(body, at, { value, type, vtype, present, yields }, host.row, childSeam(ctx, fresh), ctx.source, fresh);
  // A BARE stored read's member node is the `by(k)` node: value and tag off ONE row (`ChildValue.node`).
  const key = body.length === 1 && leading?.name === 'values' ? leading.args[0]?.value : undefined;
  const node = run && typeof key === 'string' ? byNode({ key: { kind: 'property', key } }, host, ctx.source, fresh) : null;
  return run && node ? { ...run, node } : run;
}

function mapEntryChild(body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }> & { readonly entry: NonNullable<Extract<ChildHost, { kind: 'scalar' }>['entry']> }, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const unit = make.values({ id: fresh('eu'), channels: [], type: typeOf(meta('one', 'int')), rows: [[compilerInt(1)]] });
  const seeded = make.project({
    id: fresh('es'), input: unit, channels: [], type: typeOf(meta('mk', 'json', true), meta('mv', 'json', true)),
    exprs: [['mk', host.entry.key], ['mv', host.entry.val]],
  });
  // This is structurally one row, so `atMostOneRow` can prove a non-barrier local collection is
  // still a valid correlated scalar result.
  const root = make.limit({ id: fresh('el'), input: seeded, channels: [], type: seeded.type, count: compilerInt(1) });

  // A GraphStep in a map-entry value body re-sources the graph, but the entry remains its correlated
  // scope: `inject(m).unfold().group().by(keys).by(__.V().has(k, select(values)))` runs one rooted
  // read per entry and GroupStep collects that fan-out into the key's List value. `Grouping` leaves a
  // step traversal intact rather than wrapping it as a scalar ValueTraversal
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/Grouping.java`;
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java`).
  // The list retains rowids here; the existing list-node framer expands them at the map boundary.
  const first = body[0]!;
  if (first.name === 'V' || first.name === 'E') {
    // A reducing rooted read has one value independently of the entry, exactly the ordinary
    // scalar-child V()/E() arm. Keep it scalar; only the unreduced fan-out below becomes the
    // group's List value.
    const rooted = rootedRead(body, ctx, fresh, 'many');
    const counted = rooted && rootedCount(rooted, fresh);
    if (counted) return counted;
    const elem = first.name === 'V' ? 'vertex' : 'edge';
    const scanned = ctx.source.elementScan(elem, first.args, fresh);
    if (!scanned) return null;
    const source = scanned.pred
      ? make.filter({ id: fresh('evf'), input: scanned.scan, channels: [], type: scanned.scan.type, pred: scanned.pred })
      : scanned.scan;
    const joined = make.join({
      id: fresh('evj'), left: root, right: source, join: 'inner', channels: [],
      type: typeOf(...root.type.cols, ...source.type.cols), on: compilerInt(1),
    });
    // `unfold()` keeps a map entry's stored typed node in `mv`; `Column.values` reads its payload.
    // A scalar becomes a direct equality operand; a list is exploded by `foldedListSet` for `within`.
    if (host.entry.valOf.kind !== 'scalar' && host.entry.valOf.kind !== 'list') return null;
    // Keep the entry value as a one-row scalar subquery, then drop the entry columns before the
    // ordinary element tail. Property/movement builders own the element scan's payload schema and
    // correctly reject a widened `(entry, element)` join as an element relation.
    const entryRow = make.project({
      id: fresh('evv'), input: root, channels: [], type: typeOf(meta('v', 'json', true)),
      exprs: [['v', { kind: 'call', fn: 'json_extract', args: [col(root.id, 'mv'), compilerText('$.v')] }]],
    });
    const entryValue: Expr = { kind: 'scalar', plan: entryRow };
    const scoped = make.project({
      id: fresh('evp'), input: joined, channels: [], type: typeOf(...elementCols([])),
      exprs: [['id', col(joined.id, 'id')]],
    });
    const entryCtx: ChainCtx = {
      ...inBody(ctx),
      entryValue,
    };
    // A terminal reducer belongs to this entry-correlated rooted read, not to the outer group
    // pool. Reuse the correlated reducer so count keeps its seed while numeric reducers retain
    // their productivity distinction over an empty sibling stream.
    const reduced = correlatedReduce(scoped, { kind: 'elements', elem }, body, 1, entryCtx, fresh);
    if (reduced) return reduced;
    const tail = continueAs(scoped, { kind: 'elements', elem }, body, 1, false, entryCtx, fresh, NO_ALIASES);
    if (!tail || tail.effects || tail.framing.kind !== 'elements') return null;
    const members = make.aggregate({
      id: fresh('evl'), input: tail.rel, channels: [], type: typeOf(meta(LIST_COL, 'json', true)), groupBy: [],
      aggs: [[LIST_COL, { kind: 'agg', fn: 'json_group_array', args: [col(tail.rel.id, 'id')] }]],
    });
    return {
      expr: { kind: 'scalar', plan: members },
      framing: { kind: 'list', of: { kind: 'elem', elem } },
      present: 'always',
      yields: 'one',
    };
  }
  const tail = continueAs(root, { kind: 'mapEntry', keyOf: host.entry.keyOf, valOf: host.entry.valOf }, body, 0, false, inBody(ctx), fresh, NO_ALIASES);
  return tail && oneRowValue(tail, fresh);
}

/**
 * A PER-ROW-TYPED scalar host whose body opens with a compound reader (`collectionReaderOf` —
 * `count(local)`, a local slice, `select(Column)`, a multi-key `select`): the host may be a Map,
 * a List or neither, decided by its tag. Seeded as a ONE-ROW relation `(v, vtype)` and handed to the ordinary
 * fold, whose scalar tail splits that one row by its tag (`perRowCollectionStep`) — so the chain and the child
 * answer the same question through one lowering. Each row enters exactly one arm, so the merged answer is
 * still at most one row; the `Limit` says so to `atMostOneRow`.
 */
function perRowCollectionChild(body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }> & { readonly vtype: Expr }, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const unit = make.values({ id: fresh('pu'), channels: [], type: typeOf(meta('one', 'int')), rows: [[compilerInt(1)]] });
  const seeded = make.project({
    id: fresh('ps'), input: unit, channels: [], type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true)),
    exprs: [['v', host.value], ['vtype', host.vtype]],
  });
  // A host whose NULL means "nothing" (`host.present`) seeds no row there.
  const present = host.present && host.present !== 'always' ? presenceOf(host.present, col(seeded.id, 'v')) : null;
  const root = present ? make.filter({ id: fresh('pp'), input: seeded, channels: [], type: seeded.type, pred: present }) : seeded;
  // The READER alone first, so the `Limit` states the one-row fact of the split and nothing after it: a
  // body that fans out past it (`select(keys).unfold()`) is still seen to, and declines.
  const bodyCtx = inBody(ctx);
  const split = continueAs(root, { kind: 'scalar', type: PER_ROW('vtype') }, body.slice(0, 1), 0, false, bodyCtx, fresh, NO_ALIASES);
  if (!split || split.effects?.length) return null;
  const one = make.limit({ id: fresh('pl'), input: split.rel, channels: split.rel.channels, type: split.rel.type, count: compilerInt(1) });
  const tail = continueAs(one, split.framing, body, 1, false, bodyCtx, fresh, NO_ALIASES);
  const value = tail && !tail.effects?.length ? oneRowValue(tail, fresh) : null;
  // A bare `count(local)`, local slice or `order(local)` is ONE-TO-ONE: every seeded row enters exactly one arm and leaves
  // it, so the body produces exactly where the host does — stated, rather than the `EXISTS` a union of
  // filtered arms otherwise needs, which would spell the whole split a second time per row.
  const reader = collectionReaderOf(body[0]);
  if (!value || body.length !== 1 || (reader !== 'count' && reader !== 'slice' && reader !== 'order')) return value;
  return {
    expr: value.expr, framing: value.framing, ...(value.vtype ? { vtype: value.vtype } : {}),
    present: present ? 'value-nullness' : 'always', yields: value.yields,
  };
}

/**
 * A body lowered over a ONE-ROW correlated root, as the child value it is — the shared exit of every child
 * that seeds its host as a relation and hands the WHOLE body to the ordinary framing dispatcher
 * (`mapEntryChild`, `perRowCollectionChild`). `null` unless the tail is still at most one row.
 */
function oneRowValue(tail: Tail, fresh: Minter): ChildValue | null {
  if (!atMostOneRow(tail.rel)) return null;
  const scalarOf = (column: string): Expr => ({ kind: 'scalar', plan: make.project({
    id: fresh('ev'), input: tail.rel, channels: [], type: typeOf(meta(column, 'any', true)), exprs: [[column, col(tail.rel.id, column)]],
  }) });
  // A collection-valued entry is collected by the grouping as it stands — its absence is not read — so
  // only an EXACTLY-one-row collection is admitted (`fold().limit(0)` is an unproductive `by()`, and
  // must drop the key, not land a NULL list).
  if (tail.framing.kind === 'list' || tail.framing.kind === 'map') {
    if (!exactlyOneRow(tail.rel)) return null;
    return { expr: scalarOf(tail.framing.kind === 'list' ? LIST_COL : 'map'), framing: tail.framing, present: 'always', yields: 'one' };
  }
  if (tail.framing.kind === 'scalar') {
    const carrier = tail.framing.type.kind === 'perRow' && tail.framing.type.carrier.kind === 'column' ? tail.framing.type.carrier.name : undefined;
    const present = oneRowPresence(tail.rel, true);
    // A body that may be EMPTY (`dedup()`, `is(null)`, `sum()` over the entry's one value) states its
    // presence as `EXISTS` — a map entry's value may be a productive NULL — and its member node is read
    // INSIDE the one relation (`ChildValue.node`): NULL exactly where there is no row, a `{t, v:null}`
    // node where the row's value is null, so a `group()`/`groupCount()` member costs one read, not
    // a value read, a tag read and an EXISTS.
    const node = present === 'always' ? undefined : { kind: 'scalar' as const, plan: make.project({
      id: fresh('en'), input: tail.rel, channels: [], type: typeOf(meta('n', 'json', true)),
      exprs: [['n', scalarNode(col(tail.rel.id, 'v'), carrier ? col(tail.rel.id, carrier) : undefined, tail.framing.type, fresh)]],
    }) };
    return {
      expr: scalarOf('v'), framing: tail.framing,
      ...(carrier ? { vtype: scalarOf(carrier) } : {}),
      ...(node ? { node } : {}),
      present, yields: 'one',
    };
  }
  return null;
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
export function valueRun(
  body: readonly IRStep[], from: number,
  seed: { readonly value: Expr; readonly type: ScalarType; readonly vtype: Expr | undefined; readonly present: Presence; readonly yields: ChildValue['yields'] },
  row: HostRow | undefined, child: ChildSeam, source: GraphSource, fresh: Minter,
): ChildValue | null {
  let value = seed.value;
  let type = seed.type;
  let vtype = seed.vtype;
  // A value TRANSFORM does not change WHETHER the body produced — `toUpper()` of nothing is still
  // nothing — so the leading step's answer rides through a transform unchanged. An `is(pred)` DOES
  // change it: it NULLs the value where the predicate fails, so the run's presence becomes its value's
  // nullness, and a NULL it made is UNPRODUCTIVE to every consumer — a later receiver check
  // (`receiver.ts`: `asString()`/`math()` raise on a null VALUE only), a `map()` host, a `coalesce()` arm.
  let present = seed.present;
  for (let at = from; at < body.length; at++) {
    const step = body[at]!;
    // A NESTED per-traverser host mid-run (`by(__.values('name').local(__.fold()))`) runs its body over the
    // ONE value the run has reached — the rest of the body is a child of that value, answered by
    // `nestedHostChild` with the value as a scalar host. DIRECTLY, never through `child.scalar`: where it
    // declines, the seam's scalar-host arm hands this same body straight back to `valueRun`, which reaches
    // this same step over the same host and never makes progress — so a decline here is final.
    if (PER_TRAVERSER_HOSTS.has(step.name)) {
      if (typeof present === 'object' || present === 'unknown') return null;
      const hostVtype = hostTag(type, vtype);
      const over = (presence: HostPresence): ChildValue | null => nestedHostChild(body.slice(at), {
        kind: 'scalar', value, ...(hostVtype ? { vtype: hostVtype } : {}), ...(row ? { row } : {}),
        ...(presence === 'always' ? {} : { present: presence }),
      }, child);
      const rest = producedOnlyWhere(over(present), present, value, body.slice(at + 1));
      if (!rest || seed.yields === 'one') return rest;
      // A run that reached only the FIRST of several values (`values(k)`) answers the reference's first
      // result only where the rest maps EACH value to exactly one — never drops one (an `is()` would make
      // a later value the first survivor, the reason `is` above refuses), never fans out. Asked of the
      // rest over a host that is always there, so the host's own absence does not read as a drop.
      const total = over('always');
      return total?.yields === 'one' && total.present === 'always' ? { ...rest, yields: 'first' } : null;
    }
    if (REL_PROJECTORS.has(step.name)) {
      // The run's productivity rides on the host: the value here can be an UNPRODUCTIVE NULL (an absent
      // property, a failed `is()`), which a `math()` over it must drop rather than raise on. A seed that
      // cannot say reads a NULL as unproductive rather than raise on every NULL.
      const hostVtype = hostTag(type, vtype);
      const host: ChildHost = {
        kind: 'scalar', value, ...(hostVtype ? { vtype: hostVtype } : {}), ...(row ? { row } : {}),
        ...(present === 'always' ? {} : { present: 'value-nullness' as const }),
      };
      const projected = projectorValue(step, host, child, source, fresh);
      if (!projected) return null;
      value = projected.value;
      type = projected.framing.kind === 'scalar' ? projected.framing.type : UNKNOWN;
      vtype = undefined;
      // A projector whose NULL is UNPRODUCTIVE (`drop`: `math()` over an unproductive `by()` FILTERS —
      // `MathStep.java:75-78`) narrows `present` exactly as an `is()` does, for the same consumers.
      if (projected.drop && present !== 'unknown') present = 'value-nullness';
      continue;
    }
    // A trailing `is(pred)` FILTERS the child value: `by(__.values('age').is(P.gt(29)))` contributes the
    // age only where it exceeds 29 (`FilterStep` drops the traverser otherwise). A filtered-out value
    // becomes UNPRODUCTIVE, which the `by()` vocabulary already carries as a NULL value dropped by the
    // host's productivity filter (or kept as a null under `ProductiveByStrategy`) — so the predicate
    // NULLs the value (`CASE WHEN pred THEN value END`) rather than needing a second productivity
    // channel `ByField` does not have. The type tag rides through unchanged (a filter narrows, never
    // retypes). Only a value-`P` `is`; a `typeOf`/gtype assert or a nested-traversal `is` declines.
    if (step.name === 'is' && !step.modulators?.length) {
      // …over ONE value. A value that is only the FIRST of several (`yields: 'first'`) is not the filter's
      // subject — `is()` tests every result and the first SURVIVOR is the answer — so it declines here; the
      // leading `values(k).is(P)` form is answered upstream by filtering the property rows
      // (`propertyFirstPassing`).
      if (seed.yields !== 'one') return null;
      const pred = step.args[0]?.value;
      if (pred == null || isNested(pred)) return null;
      const subjType: SubjectType = vtype ? perRowSubject(vtype, value)
        : type.kind === 'static' ? { kind: 'static', type: type.type, text: type.text } : SUBJECT_UNKNOWN;
      const test = predicateExpr(value, pred, subjType, step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh);
      if (!test) return null;
      value = { kind: 'case', whens: [[test, value]], else: compilerNull() };
      // A failed test is a NULL, so the run is now present exactly where its value is. A seed that cannot
      // say stays unable to (`'unknown'`), so its consumers keep declining.
      if (present !== 'unknown') present = 'value-nullness';
      continue;
    }
    if (!REL_TRANSFORMS.has(step.name)) return null;
    // THE RECEIVER first — the same authority the root scalar fold asks (`receiver.ts`), so a body at
    // any depth (`map`/`local`/`by()`/`where`/a branch arm) gets the reference's raise, not SQLite's
    // coercion. A NULL here is a productive null exactly where the seed says the body produced.
    const evidence = evidenceOf(type, vtype);
    const offences = transformOffences(step, value, evidence, present === 'unknown' ? undefined : present === 'always');
    if (!offences) return null;
    const transformed = transformExpr(step, value, false, step.name === 'asNumber' ? type : undefined, evidence);
    if (!transformed) return null;
    // A RAISING transform (a runtime `asNumber(GType.X)`, a receiver offence) raises when its VALUE is
    // evaluated — so a host that asks only WHETHER the run produced (`where`/`not`/`choose`) must read
    // the value: an `'always'` run becomes a value-nullness one.
    if ((transformed.fenced || offences.length) && present !== 'unknown') present = 'value-nullness';
    value = raisingWhen(offences, transformed.expr);
    type = transformed.type ?? UNKNOWN;
    vtype = undefined;
  }
  const produced = { present };
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
export function scalarHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }>, child: ChildSeam, source: GraphSource, fresh: Minter,
): ChildValue | null {
  let value: Expr = host.value;
  let type: ScalarType = UNKNOWN;
  let vtype = host.vtype;
  let at = 0;
  const leading = body[0];
  if (leading?.name === 'constant') {
    const args = leading.args.map((a) => a.value);
    // Productivity is EMISSION, not NULLNESS — the element arm's own citation. A deliberate
    // `constant(null)` declines there and declines here for the identical reason.
    if (args.length !== 1 || args[0] === null) return null;
    const literal = constLit(leading.args[0]);
    if (!literal) return null;
    // A host whose NULL means "nothing" (`host.present`) replaced by a constant still produced nothing there.
    const gated = gatedByHost(host, literal);
    if (!gated) return null;
    value = gated;
    vtype = undefined;
    // Its declared type, as at the element host above.
    type = declaredScalarType(leading.args[0]);
    at = 1;
  } else if (leading?.name === 'identity') {
    if (leading.args.length) return null;
    at = 1;
  }
  // THE TRAVERSER IS THE VALUE, so a scalar host's body has exactly one to give — `constant()`
  // replaces it and every transform maps it, neither of which can produce a second.
  // The value IS the traverser (or a constant replacing it), so the body produces exactly where the HOST
  // did: always for a traverser, `host.present` for an intermediate value that can be an unproductive
  // NULL. Stated as `present` — not withheld as `'unknown'` — because every `by()` consumer now decides
  // productivity on presence and DECLINES on `'unknown'`; `valueRun` narrows it at an `is()`/`drop`.
  const present = host.present ?? 'always';
  return valueRun(body, at, { value, type, vtype, present, yields: 'one' }, host.row, child, source, fresh);
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
 * here. Every member kind re-enters its own loop (`correlatedListMembers` frames each): an ELEMENT list
 * the element loop, a SCALAR/typed list the scalar loop, a MAP list `mapTail`, a nested-LIST list
 * `listTail` — so `by(__.unfold().count()|sum()|fold())` and a trailing member reducer reduce through
 * the same `correlatedReduce` collapse arms whatever the members are. Only a MIXED list declines.
 */
/**
 * A child body over a MAP host — `by(__.select(<key>)…)`, the child-seam twin of `mapTail`'s chain-level
 * `select(<key>)` (`Scoping.getScopeValue` tries the traverser Map first). The correlated key read
 * (`correlatedMapKey`) reroots the host to the value side's shape — the same `sideOf` split `mapTail`
 * makes — and the body CONTINUES against it (`scalarChild`), so `select(k).unfold()`, `select(k).values()`,
 * a nested `select(k1).select(k2)`, all compose. A missing key is a productive-absent (`present` false),
 * threaded onto the recursed value so the host (a `math`/`format` projector) drops the whole traverser.
 */
function mapHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'map' }>, ctx: ChainCtx, fresh: Minter,
): ChildValue | null {
  const first = body[0]!;
  if (first.name !== 'select' || first.modulators?.length) return null;
  const spec = selectSpec(first);
  if (!spec || spec.labels.length !== 1) return null;
  const key = spec.labels[0]!;
  const may = mayHoldKey(host, key);
  // A scope beyond the Map that names `key` answers a row lacking it (`Scoping.java:119-135`), and an
  // entry-or-scope read per row is not built — so the KEY FACT decides (`mapTail`'s rule): a key no row
  // holds is a `withSideEffect` constant's value (`constantSelectChild`) or, for a label the child seam has
  // no alias vocabulary for here, a decline; a key a row MAY hold beside a constant or a label declines
  // (the collision is in the query text), and beside a named collection keeps the entry (a row lacking it
  // drops, §17 "Map scope").
  const live = labelNamed(key, host, ctx);
  const collision = mapKeyCollision(key, host, ctx, live);
  if (collision && collision.scope !== 'collection') return mapKeyCollided(first, collision, ctx);
  if (!may && namedBeyondMap(key, ctx, live)) {
    const constant = sideEffectConstant(key, ctx);
    return constant ? constantSelectChild(body, host, constant, ctx, fresh) : null;
  }
  // A key NOT in the static key set cannot be a map key, and no scope names it: every row drops.
  if (!may) return null;
  const { node } = correlatedMapKey(host.map, key, fresh);
  return selectedNodeChild(body, node, host.valOf, host.row, ctx, fresh);
}

/**
 * `select(k)` of a `withSideEffect(k, c)` CONSTANT as a child body — the child-seam twin of the chain's
 * `selectSideEffectConstant`. Over an element or a scalar host the side effect is the scope a non-Map
 * traverser reads (`Scoping.java:126-127`); over a per-row scalar that may itself be a stored Map it WINS
 * over a same-named entry (§17 "Map scope"), so no row is probed. `'pass'` where `k` names no constant.
 */
function sideEffectSelectChild(
  body: readonly IRStep[], host: ChildHost, ctx: ChainCtx, fresh: Minter,
): ChildValue | null | 'pass' {
  const constant = constantSelected(body[0]!, host, ctx);
  return constant ? constantSelectChild(body, host, constant, ctx, fresh) : 'pass';
}

/** The constant a `select(k)` leading a body over an ELEMENT or SCALAR host reads — or `undefined`. Mint-free. */
const constantSelected = (step: IRStep, host: ChildHost, ctx: ChainCtx): Arg | undefined => {
  if (step.name !== 'select' || (host.kind !== 'element' && host.kind !== 'scalar') || step.modulators?.length || step.optionArms) return undefined;
  const spec = selectSpec(step);
  return spec && spec.labels.length === 1 ? sideEffectConstant(spec.labels[0]!, ctx) : undefined;
};

/** The body continuing from the constant `c` as ONE `{t,v}` node (`constantNode`, the stored encoding a
 *  selected map entry has), gated on the host so an ABSENT host (an unbound label's NULL) does not produce.
 *  A constant the encoder cannot spell declines, and so does a null one (`constantNode` answers `null`).
 *
 *  So the node is non-null EXACTLY where the host is present: its presence is `hostPresence(host)` — the
 *  authority `gatedByHost` consults — never a per-row `node IS NOT NULL`. Over a host that cannot be absent
 *  that is `ALWAYS_PRODUCTIVE`, so a `choose` arm reading the constant meets as `'always'` (`meetPresence`);
 *  over a may-be-absent host it is the host's own predicate. */
function constantSelectChild(body: readonly IRStep[], host: ChildHost, constant: Arg, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const value = constantNode(constant.value, constant.type ?? null, constant.name ?? null);
  const held = hostPresence(host);
  if (!value || !held) return null;
  return selectedNodeChild(body, caseWhen(held, value), { kind: 'scalar' }, host.row, ctx, fresh, held);
}

/**
 * `select(k)` as a child body over a PER-ROW SCALAR host — the child-seam twin of the chain's
 * `selectMapFirst`: the host value may be a MAP (a map-valued stored property), whose own entry is the
 * first scope (`Scoping.java:121-122`), read behind `CASE WHEN vtype = 'map'` so a non-Map row opens no
 * `json_each`; a row that is no Map holding `k` drops. Built only where no scope beyond the Map names `k`
 * (`namedBeyondMap`): `'pass'` hands a constant to `sideEffectSelectChild` and a path-label or collection
 * key to the alias re-root unchanged — the named scope wins over a same-named Map key (§17 "Map scope").
 */
function scalarMapFirstChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }>, ctx: ChainCtx, fresh: Minter,
): ChildValue | null | 'pass' {
  const key = mapFirstSelect(body[0]!, host);
  if (key === null || namedBeyondMap(key, ctx, labelNamed(key, host, ctx))) return 'pass';
  const isMap: Expr = { kind: 'binary', op: '=', left: host.vtype!, right: compilerText('map') };
  const entry: Expr = { kind: 'case', whens: [[isMap, correlatedMapKey(host.value, key, fresh).node]], else: compilerNull() };
  return selectedNodeChild(body, entry, { kind: 'scalar' }, host.row, ctx, fresh);
}

/** The single key of a `select(k)` a map-first reader can take over `host` — a per-row scalar that may be a
 *  Map (it carries a tag) — or `null`. Mint-free. */
function mapFirstSelect(step: IRStep, host: ChildHost): string | null {
  if (step.name !== 'select' || host.kind !== 'scalar' || !mayBeMapTag(host.vtype) || step.modulators?.length || step.optionArms) return null;
  const spec = selectSpec(step);
  return spec && spec.labels.length === 1 ? spec.labels[0]! : null;
}

/** Is `key` a PATH LABEL for a reader over `host` — live on the host's row, or, with no row to ask, bound
 *  anywhere in the program? (`namedBeyondMap`'s `liveLabel`.) */
const labelNamed = (key: string, host: ChildHost, ctx: ChainCtx): boolean =>
  host.row ? liveAliases(host.row.aliases, host.row.rel).has(key) : ctx.scopeNames.labels.has(key);

/** May a row with this tag be a Map? A per-row tag may; a LITERAL tag (a `constant()`'s static class) says
 *  which class every row is, so only the literal `'map'` may — the probe costs nothing to skip there. */
const mayBeMapTag = (vtype: Expr | undefined): vtype is Expr =>
  !!vtype && (vtype.kind !== 'lit' || vtype.value === 'map');

/**
 * WILL the VALUE seam answer a body leading with `step` over `host` — a `withSideEffect` constant
 * (`sideEffectSelectChild`) or the host's OWN Map read first (`scalarMapFirstChild`)? Asked by a reader with
 * its own route for the label case — the predicate seam's subject re-root — so the value seam takes the
 * body exactly where it would answer. Mint-free.
 */
export function readsScopeValue(step: IRStep, host: ChildHost, ctx: ChainCtx): boolean {
  if (constantSelected(step, host, ctx)) return true;
  const key = mapFirstSelect(step, host);
  // NO scope is proven only where no path label of that name exists anywhere: a caller that hands no alias
  // map (a branch's exhaustion probe) cannot show a label the row does carry, and "drop" would be wrong.
  return key !== null && !namedBeyondMap(key, ctx, labelNamed(key, host, ctx)) && !ctx.scopeNames.labels.has(key);
}

/**
 * The body CONTINUING from one selected `{t,v}` NODE (a NULL node is "no value" — the traverser drops):
 * rerooted to the value side's shape (`sideOf`'s decode) and the rest of the body run against it, with
 * the node's presence threaded onto the result. Shared by the MAP host, the per-row scalar host and a
 * side-effect constant (`constantSelectChild`).
 *
 * `held` is WHERE the node is non-null — the caller's to state, defaulting to the per-row
 * `node IS NOT NULL` a map entry needs. A caller that knows it passes it (a constant: its host's presence),
 * and `ALWAYS_PRODUCTIVE` reports `'always'` with no gate at all (`caseWhen` elides it).
 */
function selectedNodeChild(
  body: readonly IRStep[], node: Expr, valOf: MapOf, row: ChildHost['row'], ctx: ChainCtx, fresh: Minter,
  held: Expr = isNot(node, compilerNull()),
): ChildValue | null {
  // Reroot to the value side's shape (the `sideOf` decode: a `{t,v}` scalar, a list/map blob).
  let reHost: ChildHost;
  if (valOf.kind === 'scalar') {
    const value = jsonField(node, 'v');
    const vtype = jsonField(node, 't');
    // PRESENCE IS THE NODE, not its value: a Map holding `k` → null is a PRODUCTIVE null
    // (`SelectOneStep.java:62` splits a null traverser), and only a NULL node — no scope held `k` — drops.
    const keyPresent: Presence = held === ALWAYS_PRODUCTIVE ? 'always' : { when: held };
    if (body.length === 1)
      return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present: keyPresent, yields: 'one' };
    // A body CONTINUING past it runs over a host whose null IS a value (`'always'`), so a null entry
    // reaches `constant('x')`/`fold()` as the reference's null traverser does; the KEY's presence is then
    // gated onto the result — and since the gate is a CASE around the whole recursed value, a tail that
    // would raise over a null (`math('_+1')`) is never evaluated for a row with no scope holding `k`.
    const rerooted = scalarChild(body.slice(1), { kind: 'scalar', value, vtype, row }, ctx, fresh);
    if (!rerooted) return null;
    const gate = (e: Expr): Expr => caseWhen(held, e);
    const gated = { ...rerooted, expr: gate(rerooted.expr), ...(rerooted.vtype ? { vtype: gate(rerooted.vtype) } : {}), ...(rerooted.node ? { node: gate(rerooted.node) } : {}) };
    const present = rerooted.present;
    if (present === 'unknown') return null;
    if (present === 'value-nullness') return { ...gated, present };
    if (present === 'always') return { ...gated, present: keyPresent };
    return { ...gated, present: { ...present, when: caseWhen(held, present.when, compilerInt(0)) } };
  } else if (valOf.kind === 'list') {
    reHost = { kind: 'list', list: jsonOf(jsonField(node, 'v')), of: valOf.of, row };
  } else if (valOf.kind === 'map') {
    reHost = { kind: 'map', map: jsonOf(jsonField(node, 'v')), keyOf: { kind: 'scalar' }, valOf: valOf.of, row };
  } else return null; // an `elem` value side reroots to an element — a later increment
  // A bare `select(k)` of a list/map value is that collection traverser; a scalar consumer cannot use it,
  // so decline here and let a consumer that can (the caller narrows) handle a tail-less form later.
  if (body.length === 1) return null;
  const rerooted = scalarChild(body.slice(1), reHost, ctx, fresh);
  if (!rerooted) return null;
  // Thread the key's presence onto the recursed value: an absent key (a NULL node) means the whole child
  // produced nothing. A tail whose presence is its value's nullness is already NULL over an absent key;
  // one that ALWAYS produces (`count()` seeds 0) is gated on the key. A STATED presence already reads the
  // key through `reHost`'s own presence, so it rides out as it is.
  if (typeof rerooted.present === 'object') return rerooted;
  if (rerooted.present !== 'always') return { ...rerooted, present: 'value-nullness' };
  const gated: Expr = { kind: 'case', whens: [[isNot(node, compilerNull()), rerooted.expr]], else: compilerNull() };
  return { ...rerooted, expr: gated, present: 'value-nullness' };
}

export function listHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'list' }>, ctx: ChainCtx, fresh: Minter,
): ChildValue | null {
  const first = body[0];
  if (!first || first.name !== 'unfold' || first.args.length) return null;
  // A BARE trailing `unfold()` yields the FIRST member — `TraversalUtil.produce`'s `.next()`, the
  // `yields:'first'` twin of a multi-valued property read. Only a SCALAR member is a value a scalar
  // ChildValue can carry (`firstScalarMember`); an element/map/nested-list member declines. This is what
  // makes `by(__.select(k).unfold())` over a `valueMap()` map land (the per-key value is a list).
  if (body.length === 1) {
    const m = firstScalarMember(host.list, host.of, fresh);
    return m && {
      expr: m.value, framing: { kind: 'scalar', type: m.vtype ? PER_ROW('vtype') : UNKNOWN },
      ...(m.vtype ? { vtype: m.vtype } : {}), present: 'value-nullness', yields: 'first',
    };
  }
  const members = correlatedListMembers(host.list, host.of, fresh);
  if (!members) return null;
  // The body after `unfold()` is the ordinary correlated body over the exploded members — the SAME
  // engine an adjacency-rooted `by()` reducer uses, rooted at the member's OWN framing (element / scalar
  // / map / nested-list), so a trailing `values(k).fold()`, a member reducer, or a shape-agnostic
  // `count()` / `fold()` over any member kind is free.
  return correlatedReduce(members.rel, members.framing, body, 1, ctx, fresh);
}
