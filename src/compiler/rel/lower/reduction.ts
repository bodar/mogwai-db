import * as make from '../../../rel/factory.ts';
import { col, compilerInt, compilerNull, compilerText, eq, isNot, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, DOMAIN_ENCOUNTER, elementCols, firstRootedValue, presenceFenced, jsonField, jsonOf, meta, payloadCols, propertyKeyArgs, renumber, rowNumberWindow, typeOf, type Minter } from '../build.ts';
import { withChannel } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta, SortTerm } from '../../../rel/types.ts';
import { exprHasSubquery, forEachRel } from '../../../rel/walk.ts';
import type { Elem } from '../../elem.ts';
import { writesAnywhere, type IRStep } from '../../ir/strategies.ts';
import { BATCHING_BRANCHES, isLocalScope, isStreamBarrier, type Slice } from '../../ir/step.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { normalize } from '../../ir/passes.ts';
import { PER_ROW, STATIC, UNKNOWN, meetScalarTypes, staticTypeOf, type ScalarType } from '../../../sql/kernel/render.ts';
import { isColumnArg, isNested, isPred, stepChain } from '../../../gremlin/frontend.ts';
import { constLit, declaredScalarType } from '../const.ts';
import { byExpr, byNode, propertyFirstPassing, propertyVtype, scopedHost } from '../modulator.ts';
import { aliasProjection, selectSpec } from '../alias.ts';
import type { AliasMap } from '../../alias.ts';
import { hostTag, meetPresence, presenceOf, type Presence, type ChildHost, type ChildRows, type ChildSeam, type ChildValue, type HostRow, type RootedRead, type Subject } from '../child.ts';
import { fieldNamed, framingCols, type RelFraming } from '../framing.ts';
import { BaseGraph, type GraphSource } from '../source.ts';
import { recordNode } from '../record.ts';
import { REL_TRANSFORMS, transformExpr } from '../transform.ts';
import { REL_PROJECTORS, projectorValue } from '../projector.ts';
import { evidenceOf, raisingWhen, transformOffences } from '../receiver.ts';
import { isReducer, REDUCED_TYPE } from '../reducer.ts';
import { LIST_COL, correlatedListMembers, firstScalarMember } from '../list.ts';
import { correlatedMapKey, elementHost, elementValueMap, MAP_COL } from '../map.ts';
import { edgeEndpoint } from '../element.ts';
import { propertyReadOf } from '../property.ts';
import { PATH_CHANNEL, PATH_COL, appendValuePosition, extendPath, pathCarried, subPathMembers } from '../path.ts';
import { CARRIED_READ, NO_ALIASES, ORIGIN, bodyOf, encounterOf, inBody, inOrderFreeBody, originOf, withEnclosing, type ChainCtx, type ElementSubject, type Tail } from './chain.ts';
import { movement } from './movement.ts';
import { bodyPredicate, correlatedExists, valuePredicate } from './filter.ts';
import { mixedClassesRefused, perRowSubject, predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from '../predicate.ts';
import { foldDeclared, PLAIN_FOLD } from '../operator.ts';
import { sackTagOf } from '../sack.ts';
import { optionArms, type OptionArm } from '../../ir/option-map.ts';
import { comparableClass, continueAs, dropPath, lowerChain, minMaxOrder, minMaxWinnerVt, serviceValue, streamRowTag } from '../lower.ts';
import { BRANCH_HOSTS } from './branch.ts';

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
  predicate: (body, subject, negated) => (negated
    ? correlatedExists(body, subject, fresh, ctx, true) ?? valuePredicate(body, subject, fresh, ctx, true)
    : bodyPredicate(body, subject, fresh, ctx)),
  rooted: (steps) => rootedRead(steps, ctx, fresh),
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
export function collapsedToOneRow(rel: Rel): boolean {
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
  const projected = make.project({
    id: fresh('mc'), input: rel, channels, type: typeOf(...cols),
    exprs: [
      ...payload.cols.map(([column, expression]) => [column.name, expression] as const),
      ...channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const),
    ],
  });
  if (produced.present === 'always') return { rel: projected, framing: payload.framing, aliases: labels, bulked };
  const named = presenceFenced(projected, produced.expr, fresh);
  const kept = make.filter({
    id: fresh('mf'), input: named, channels, type: named.type,
    pred: presenceOf('value-nullness', col(named.id, payload.cols[0]![0].name))!,
  });
  return { rel: kept, framing: payload.framing, aliases: labels, bulked };
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

  const produced = scalarChild(body, reductionHost(rel, framing, labels), bodyCtx, fresh);
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
 *  `dedupOn`), the slice family (`perOriginWindow` via `sliceOp`), and the no-op `barrier`. Every OTHER
 *  `isStreamBarrier` step (`sample`, `fold`, `group`/`groupCount`/`aggregate`, a reducer, a nested
 *  `local`) either changes the framing or has no per-origin form, so a body containing one DECLINES —
 *  the whitelist twin of `match`'s `PER_ORIGIN_UNSAFE` blacklist. */
export const PER_ORIGIN_SAFE_BARRIER: ReadonlySet<string> = new Set(['order', 'dedup', 'limit', 'range', 'skip', 'tail', 'barrier']);

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
    if (!body.filter(isStreamBarrier).every((s) => PER_ORIGIN_SAFE_BARRIER.has(s.name) || PER_ORIGIN_GROUPING_BARRIER.has(s.name))) return null;
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
  // `sample` (a global reservoir with no per-origin form), `fold`/`group`/`aggregate`/a reducer
  // (framing-changing, and a reducer is `scalarChild`'s job, tried first in `perTraverserChild`) DECLINE
  // — a wrong answer if run across all origins at once.
  if (!body.filter(isStreamBarrier).every((s) => PER_ORIGIN_SAFE_BARRIER.has(s.name) || PER_ORIGIN_GROUPING_BARRIER.has(s.name))) return null;
  const rows = childRows(body, rel, framing.elem, labels, bodyCtx, fresh, true, ctx.needsFromV ?? false);
  if (!rows) return null;
  // DROP origin — flatMap flattens, so the host a row descended from is internal and must not ride into
  // a downstream whole-row `dedup`/merge. Everything else (payload + carried channels) rides through.
  const shed = dropOrigin(originMajor(rows.rel, body, ctx.params, fresh), fresh);
  // `local` carries the body's outbound labels to parent scope (the full-traverser forward); plain
  // `flatMap` sheds the body-bound alias CHANNELS (`shedBodyAliases`) and continues with the pre-body map
  // only — so the channel never rides into a downstream `dedup`/merge as a spurious distinguishing column,
  // and a downstream read of a body-bound label is the correct empty result.
  const out = step.name === 'local' ? rows.aliases : labels;
  const rejoined = step.name === 'local' ? shed : shedBodyAliases(shed, labels, fresh);
  return continueAs(rejoined, rows.framing, steps, at + 1, bulked, ctx, fresh, out);
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
export function perOriginWindow(rows: Rel, partitionBy: Expr, order: readonly SortTerm[], slice: Slice, fresh: Minter): Rel {
  const cols = [...payloadCols(rows), ...carriedCols(rows.channels)];
  const RN = 'prn';
  const orderBy = order.length ? order : defaultCollation(rows);
  const ranked = rowNumberWindow(rows, RN, rows.channels, { partitionBy: [partitionBy], orderBy }, fresh);
  const lower: Expr = { kind: 'binary', op: '>', left: col(ranked.id, RN), right: compilerInt(slice.offset) };
  const pred: Expr = slice.limit === null ? lower
    : and(lower, { kind: 'binary', op: '<=', left: col(ranked.id, RN), right: compilerInt(slice.offset + slice.limit) });
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
  if (originOf(rel.channels)) return rel;
  const channels = withChannel(rel.channels, ORIGIN);
  // Numbered in ARRIVAL order where the stream carries one, so the origin is also the entering
  // traverser's position — what `originMajor` re-reads after a per-traverser body.
  const enc = encounterOf(rel.channels);
  const numbered = rowNumberWindow(rel, ORIGIN.col, rel.channels, {
    partitionBy: [], orderBy: enc ? [{ expr: col(rel.id, enc.col), dir: 'asc' }] : [],
  }, fresh);
  const cols = [...payloadCols(rel), ...carriedCols(channels)];
  return make.project({
    id: fresh('om'), input: numbered, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(numbered.id, column.name)] as const),
  });
}

/** Is `window` the numbering `mintRowOrigin` mints a per-ROW origin from — one origin per row? */
export const isMintedRowOrigin = (window: Rel): boolean =>
  window.kind === 'window' && window.specs.some(([name]) => name === ORIGIN.col);

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
function originMajor(rel: Rel, body: readonly IRStep[], params: Record<string, any>, fresh: Minter): Rel {
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
function shedBodyAliases(rel: Rel, keep: AliasMap, fresh: Minter): Rel {
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
  return { rel: tail.rel, framing: tail.framing, origin: ORIGIN.col, aliases: tail.aliases };
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
  const read = rootedRead(steps, ctx, fresh);
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
    const read = rootedRead(body, ctx, fresh);
    if (!read) return null;
    // `P.resolve(traverser)` takes the operand's FIRST result (ORDER BY encounter, LIMIT 1); the whole
    // rule — and the decline for an effectful or non-scalar body — is `firstRootedValue` (`build.ts`),
    // shared with `list.ts`'s member-predicate operand so the two cannot drift.
    return firstRootedValue(read, fresh);
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

export function rootedRead(steps: readonly IRStep[], ctx: ChainCtx, fresh: Minter): RootedRead | null {
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
    writes: ctx.writes, scopeNames: ctx.scopeNames,
  }, fresh);
  if (!chain) return null;
  return chain.effects ? { rel: chain.rel, framing: chain.framing, effects: chain.effects } : { rel: chain.rel, framing: chain.framing };
}

/** A nested ROOTED traversal's steps, normalized — or `null` where normalizing RAISES (a deferral
 *  the compiler will raise for itself). A rooted body goes through `normalize(stepChain(…))` and not
 *  `childSteps`, which strips a source and answers the empty chain, i.e. an endpoint that silently
 *  matched nothing. */
export function rootedSteps(nested: unknown, params: Record<string, any>, sideEffects?: Map<string, any>): readonly IRStep[] | null {
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
    return end && { kind: 'element', id: edgeEndpoint(host.id, end, fresh), elem: 'vertex', ...row };
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
  const row = { row: host.row } as const;
  if (proj.read.kind === 'element') return { kind: 'element', id: proj.payload[0]![1]!, elem: proj.read.elem, ...row };
  if (proj.read.kind === 'value') {
    const vtype = hostTag(proj.read.type, proj.payload[1]?.[1]);
    return { kind: 'scalar', value: proj.payload[0]![1]!, ...(vtype ? { vtype } : {}), ...row };
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

/** Does `rel`'s `name` column bottom out in a correlated SUBQUERY rather than a column off a table the
 *  relation scans? Follows only the projection chain (project/window/sort/limit/filter/distinct/
 *  materialize are passthroughs for a column they do not compute); reaching any real relation source
 *  (scan/join/values/aggregate/…) means the column is table-backed and the answer is false. Used by the
 *  correlated min/max argmax, whose ORDER BY re-inlines the value and cannot host a second correlation
 *  level — see its call site. */
export function valueColIsSubquery(rel: Rel, name: string): boolean {
  let cur: Rel = rel;
  let column = name;
  for (;;) {
    switch (cur.kind) {
      case 'project': {
        const entry = cur.exprs.find(([n]) => n === column);
        if (!entry) return false;
        if (entry[1].kind === 'col') { column = entry[1].name; cur = cur.input; continue; }
        return exprHasSubquery(entry[1]);
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
  if (last && (last.name === 'min' || last.name === 'max') && !last.args.length && !isLocalScope(last) && body.length >= 2) {
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
      if (valueColIsSubquery(values.rel, 'v')) return null;
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
    return { expr: { kind: 'scalar', plan: list }, framing: tail.framing, present: 'always', yields: 'one' };
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
      present: 'always',
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
    return { expr: { kind: 'scalar', plan: scalar }, framing: tail.framing, present: 'always', yields: 'one' };
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
export function selfRootedReduce(body: readonly IRStep[], host: Extract<ChildHost, { kind: 'element' }>, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  const unit = make.values({ id: fresh('u'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  const selfRow = make.project({ id: fresh('slf'), input: unit, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', host.id]] });
  return correlatedReduce(selfRow, { kind: 'elements', elem: host.elem }, body, 0, ctx, fresh);
}

/** A ChildHost as a filter/branch `Subject` — the inverse of `childHostOf` (`filter.ts`), so a
 *  predicate-bearing child (a `choose`'s condition, a `where` body) can run over the SAME traverser a
 *  value body reads. Needs the host's ROW to name the relation the id/value lives on; a host built
 *  without one declines rather than inventing a scope. */
export function hostSubject(host: ChildHost): Subject | null {
  const rel = host.row?.rel;
  if (!rel) return null;
  if (host.kind === 'element') return { kind: 'element', id: host.id, elem: host.elem, rel };
  if (host.kind === 'property') return { kind: 'property', id: host.id, ownerElem: host.ownerElem, rel };
  if (host.kind === 'scalar')
    return { kind: 'scalar', value: host.value, ...(host.vtype ? { vtype: host.vtype } : {}), rel,
      type: host.vtype ? perRowSubject(host.vtype, host.value) : SUBJECT_UNKNOWN };
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
  const branches = [...(guard ? [guard] : []), ...keyed];

  const value: Expr = { kind: 'case', whens: branches.map((b) => [b.when, b.cv.expr] as const), else: elseCV.expr };
  const all = [...branches.map((b) => b.cv), elseCV];
  const present = meetPresence(all.map((cv) => cv.present));

  const staticTypes = all.map((cv) => cv.framing.kind === 'scalar' && cv.framing.result === undefined && !cv.vtype ? cv.framing.type : null);
  if (staticTypes.every((t): t is ScalarType => t !== null)) {
    const met = meetScalarTypes(staticTypes);
    if (met.kind === 'static') return { expr: value, framing: { kind: 'scalar', type: met }, present, yields: 'one' };
  }
  const vtype: Expr = { kind: 'case', whens: branches.map((b) => [b.when, armTag(b.cv)] as const), else: armTag(elseCV) };
  return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present, yields: 'one' };
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

  const value: Expr = { kind: 'case', whens: [[pred, thenCV.expr]], else: elseCV.expr };
  // The chosen arm's productivity is the whole's: both always-productive ⟹ always; else the value's nullness.
  const present = meetPresence([thenCV.present, elseCV.present]);

  // TYPE — a shared STATIC type stays static (one column); otherwise a per-row `vtype` whose value
  // follows the SAME branch as the value (a `CASE`, because the type must track WHICH arm the value came
  // from). Mirrors `scalarCoalesceChild`'s tail, with `CASE` in place of `COALESCE`.
  const arms = [thenCV, elseCV];
  const staticTypes = arms.map((a) => a.framing.kind === 'scalar' && a.framing.result === undefined && !a.vtype ? a.framing.type : null);
  if (staticTypes.every((t): t is ScalarType => t !== null)) {
    const met = meetScalarTypes(staticTypes);
    if (met.kind === 'static') return { expr: value, framing: { kind: 'scalar', type: met }, present, yields: 'one' };
  }
  const vtype: Expr = { kind: 'case', whens: [[pred, armTag(thenCV)]], else: armTag(elseCV) };
  return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present, yields: 'one' };
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
  const present: Presence = final.present === 'always' ? 'always' : final.present === 'unknown' ? 'unknown' : 'value-nullness';
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

/** A child body's ONE value per host row. */
export function scalarChild(body: readonly IRStep[], host: ChildHost, outer: ChainCtx, fresh: Minter): ChildValue | null {
  return scalarChildValue(body, host, outer, fresh);
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
      ...(typeCol ? { vtype: self.col(typeCol.name) } : {}), present: 'always', yields: injects ? 'first' : 'one',
    };
  }

  // A GraphStep inside a per-traverser child still splits each host traverser, but a reducing tail
  // has one answer independent of which host triggered it. Lower that source chain once as an
  // ordinary rooted read and embed its one-row result as the correlated scalar value. This is the
  // `map(__.V().count())` half of re-sourcing; fan-out `flatMap(__.V()…)` needs the general child
  // rejoin and remains that substrate's responsibility rather than abusing a scalar subquery's
  // arbitrary-first-row behaviour.
  if (first.name === 'V' || first.name === 'E') {
    const rooted = rootedRead(body, ctx, fresh);
    if (!rooted || rooted.effects || rooted.framing.kind !== 'scalar') return null;
    // A reducing barrier (`__.V().count()`) collapses to EXACTLY one row and is always productive — the
    // fast path is unchanged.
    if (rooted.framing.result === 'count' && collapsedToOneRow(rooted.rel)) {
      const scalar = make.project({
        id: fresh('rc'), input: rooted.rel, channels: [], type: typeOf(meta('v', 'any', true)),
        exprs: [['v', col(rooted.rel.id, 'v')]],
      });
      return { expr: { kind: 'scalar', plan: scalar }, framing: rooted.framing, present: 'always', yields: 'one' };
    }
    // THE GENERAL rooted operand — `TraversalUtil.apply` takes the operand's FIRST result (`P.resolve` /
    // a `ScalarMapStep`, `vendor/tinkerpop/gremlin-core/.../P.java` `tv.next()`), and where the body ends
    // in `order()` the first is the ORDERED first, which `firstRootedValue` reads off the encounter
    // channel (`build.ts` — the one authority the predicate/list operand seams share). An EMPTY re-source
    // (`__.V(99999)`) maps to NO value (`TraversalUtil.apply` throws "does not map to a value"), so
    // productivity is an EXISTS over the rooted rows — the concat/dateDiff empty-operand guard raises on
    // it, never silently skipping. `yields:'first'` because several rows collapse to their first.
    const value = firstRootedValue(rooted, fresh);
    return value && { expr: value, framing: rooted.framing, present: 'value-nullness', yields: 'first' };
  }

  // THE RECORD ARM — `by(__.project('a','b')…)`, one traverser in and one MAP out.
  //
  // `project()` is a `ScalarMapStep`, so it is a correlated single value exactly as `values(k)` is; the
  // only difference is that the value is a map rather than a scalar, which the framing SAYS. It is the
  // whole body or nothing: a chain past it (`__.project('a').select('a')`) re-roots to a field's own
  // stream, which is the RECORD relation's business and not a correlated read's.
  if (first.name === 'project' && body.length === 1) {
    const self = hostSelf(host);
    const node = self && recordNode(first, host, self.framing, self.col, childSeam(ctx, fresh), ctx.source, fresh);
    // `project()` is a `ScalarMapStep` — one map per traverser, never several.
    return node && { expr: node.node, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: node.valOf }, present: 'always', yields: 'one' };
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
    const unit = make.values({ id: fresh('vm'), channels: [], type: typeOf(meta('one', 'int')), rows: [[compilerInt(1)]] });
    const self = make.project({
      id: fresh('vs'), input: unit, channels: [], type: typeOf(meta('id', 'int')),
      exprs: [['id', host.id]],
    });
    const mapped = elementValueMap(self, host.elem, asked.all ? null : asked.keys,
      first.name === 'elementMap' || tokens, ctx.labelRegime, ctx.source, fresh,
      first.name === 'elementMap' ? { flat: true, endpoints: true } : {});
    const scalar = make.project({
      id: fresh('vn'), input: mapped.rel, channels: [], type: typeOf(meta(MAP_COL, 'json', true)),
      exprs: [[MAP_COL, col(mapped.rel.id, MAP_COL)]],
    });
    return { expr: jsonOf({ kind: 'scalar', plan: scalar }), framing: { kind: 'map', keyOf: mapped.keyOf, valOf: mapped.valOf }, present: 'always', yields: 'one' };
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
    if (body.length === 1) return { expr: rerooted.id, framing: { kind: 'elements', elem: rerooted.elem }, present: 'always', yields: 'one' };
    return scalarChild(body.slice(1), rerooted, ctx, fresh);
  }

  // A MAP host's `select(<key>)` reads the map's OWN entry (`Scoping` tries the traverser Map first), a
  // DIFFERENT question from the alias re-root below — so it is intercepted here, before the generic
  // `select` arm can mis-read it as an alias. Every other map-host child body declines (a map has no
  // value/token/property to project; a rooted `V()`/`E()` body was handled above).
  if (host.kind === 'map') return mapHostChild(body, host, ctx, fresh);

  // A `select(<label>)` RE-ROOT — the alias analogue of the endpoint/owner reroots above, so a child
  // body may read a bound label and continue against it. A bare `select('a')` yields the aliased
  // traverser itself (an element or a value); a chain past it continues against the new host.
  if (first.name === 'select') {
    const reHost = selectRerootHost(first, host, fresh);
    if (!reHost) return null;
    if (body.length === 1) {
      if (reHost.kind === 'element') return { expr: reHost.id, framing: { kind: 'elements', elem: reHost.elem }, present: 'always', yields: 'one' };
      if (reHost.kind === 'scalar') return {
        expr: reHost.value, framing: { kind: 'scalar', type: reHost.vtype ? PER_ROW('vtype') : UNKNOWN },
        ...(reHost.vtype ? { vtype: reHost.vtype } : {}), present: 'always', yields: 'one',
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
  if (host.kind === 'scalar') return scalarHostChild(body, host, childSeam(ctx, fresh), ctx.source, fresh);
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
  // This is structurally one row, so `collapsedToOneRow` can prove a non-barrier local collection is
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
    const rooted = rootedRead(body, ctx, fresh);
    if (rooted?.framing.kind === 'scalar' && rooted.framing.result === 'count' && collapsedToOneRow(rooted.rel)) {
      const scalar = make.project({
        id: fresh('evc'), input: rooted.rel, channels: [], type: typeOf(meta('v', 'any', true)),
        exprs: [['v', col(rooted.rel.id, 'v')]],
      });
      return { expr: { kind: 'scalar', plan: scalar }, framing: rooted.framing, present: 'always', yields: 'one' };
    }
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
  if (!tail || !collapsedToOneRow(tail.rel)) return null;
  const scalarOf = (column: string): Expr => ({ kind: 'scalar', plan: make.project({
    id: fresh('ev'), input: tail.rel, channels: [], type: typeOf(meta(column, 'any', true)), exprs: [[column, col(tail.rel.id, column)]],
  }) });
  if (tail.framing.kind === 'list') return { expr: scalarOf(LIST_COL), framing: tail.framing, present: 'always', yields: 'one' };
  if (tail.framing.kind === 'map') return { expr: scalarOf('map'), framing: tail.framing, present: 'always', yields: 'one' };
  if (tail.framing.kind === 'scalar') return {
    expr: scalarOf('v'), framing: tail.framing,
    ...(tail.framing.type.kind === 'perRow' && tail.framing.type.carrier.kind === 'column' ? { vtype: scalarOf(tail.framing.type.carrier.name) } : {}),
    present: 'always', yields: 'one',
  };
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
      if (projected.drop && present === 'always') present = 'value-nullness';
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
      if (present === 'always') present = 'value-nullness';
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
    if ((transformed.fenced || offences.length) && present === 'always') present = 'value-nullness';
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
    value = host.present && host.present !== 'always'
      ? { kind: 'case', whens: [[isNot(host.value, compilerNull()), literal]], else: compilerNull() } : literal;
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
  // Map-key-vs-alias precedence (`Scoping`): a key NOT in the static key set cannot be a map key. The
  // child seam has no alias vocabulary here, so it declines rather than guessing (fail-closed).
  if (host.keys && !host.keys.includes(key)) return null;
  const { node } = correlatedMapKey(host.map, key, fresh);
  const valOf = host.valOf;
  // Reroot to the value side's shape (the `sideOf` decode: a `{t,v}` scalar, a list/map blob).
  let reHost: ChildHost;
  if (valOf.kind === 'scalar') {
    const value = jsonField(node, 'v');
    const vtype = jsonField(node, 't');
    if (body.length === 1) return { expr: value, framing: { kind: 'scalar', type: PER_ROW('vtype') }, vtype, present: 'value-nullness', yields: 'one' };
    reHost = { kind: 'scalar', value, vtype, row: host.row, present: 'value-nullness' };
  } else if (valOf.kind === 'list') {
    reHost = { kind: 'list', list: jsonOf(jsonField(node, 'v')), of: valOf.of, row: host.row };
  } else if (valOf.kind === 'map') {
    reHost = { kind: 'map', map: jsonOf(jsonField(node, 'v')), keyOf: { kind: 'scalar' }, valOf: valOf.of, row: host.row };
  } else return null; // an `elem` value side reroots to an element — a later increment
  // A bare `select(k)` of a list/map value is that collection traverser; a scalar consumer cannot use it,
  // so decline here and let a consumer that can (the caller narrows) handle a tail-less form later.
  if (body.length === 1) return null;
  const rerooted = scalarChild(body.slice(1), reHost, ctx, fresh);
  if (!rerooted) return null;
  // Thread the key's presence onto the recursed value: an absent key (a NULL node) means the whole child
  // produced nothing. A tail whose presence is its value's nullness is already NULL over an absent key;
  // one that ALWAYS produces (`count()` seeds 0) is gated on the key.
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
