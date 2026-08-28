import * as make from '../../../rel/factory.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, elementCols, jsonOf, meta, payloadCols, propertyKeyArgs, typeOf, type Minter } from '../build.ts';
import { withChannel } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta, SortTerm } from '../../../rel/types.ts';
import { exprChildren, forEachRel } from '../../../rel/walk.ts';
import type { Elem } from '../../elem.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { isLocalScope, isStreamBarrier, type Slice } from '../../ir/step.ts';
import { normalize } from '../../ir/passes.ts';
import { labelReads, labelsBoundBefore } from '../../ir/labels.ts';
import { PER_ROW, STATIC, UNKNOWN, type ScalarType } from '../../../sql/kernel/render.ts';
import { argValues, isColumnArg, isNested, stepChain } from '../../../gremlin/frontend.ts';
import { isInjectedAliasBody, isParentMarkerBody } from '../../ir/injection.ts';
import { constLit } from '../const.ts';
import { byExpr, propertyExists, propertyVtype } from '../modulator.ts';
import { aliasProjection, selectSpec } from '../alias.ts';
import type { AliasMap } from '../../alias.ts';
import { ALWAYS_PRODUCTIVE, type ChildHost, type ChildRows, type ChildSeam, type ChildValue, type HostRow, type RootedRead } from '../child.ts';
import type { RelFraming } from '../framing.ts';
import type { GraphSource } from '../source.ts';
import { recordNode } from '../record.ts';
import { REL_TRANSFORMS, transformExpr } from '../transform.ts';
import { REL_PROJECTORS, projectorValue } from '../projector.ts';
import { isReducer } from '../reducer.ts';
import { LIST_COL, correlatedListMembers } from '../list.ts';
import { elementHost, elementValueMap, MAP_COL } from '../map.ts';
import { edgeEndpoint } from '../element.ts';
import { propertyReadOf } from '../property.ts';
import { PATH_CHANNEL, subPathMembers } from '../path.ts';
import { CARRIED_READ, NO_ALIASES, ORIGIN, bodyOf, encounterOf, inBody, originOf, type ChainCtx, type ElementSubject, type Tail } from './chain.ts';
import { movement } from './movement.ts';
import { bodyPredicate, correlatedExists, valuePredicate } from './filter.ts';
import { predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from '../predicate.ts';
import { continueAs, lowerChain, minMaxOrder, minMaxWinnerVt, serviceValue } from '../lower.ts';
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
 * productivity the seam cannot state (`ChildValue.present` absent — a numeric reducer over an empty
 * child, which `correlatedExists` fails closed on for the same reason) declines here too.
 */
/** The child HOST for a per-traverser body over an element or scalar stream — the subject `scalarChild`
 *  reads. Extracted so the `map`/`local`/`flatMap` dispatch and a `coalesce`/`optional` reduction arm
 *  name ONE host shape rather than two copies of it. */
export function reductionHost(
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
export function reductionTail(rel: Rel, produced: ChildValue, fresh: Minter, labels: AliasMap, bulked: boolean): Tail | null {
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
export function reductionArm(
  domain: Rel, framing: RelFraming, body: readonly IRStep[], ctx: ChainCtx, fresh: Minter, labels: AliasMap, bulked: boolean,
): Tail | null {
  const terminal = body.at(-1);
  if (body.length < 2 || !terminal || !selfCollapses(terminal.name)) return null;
  if (framing.kind !== 'elements' && framing.kind !== 'scalar') return null;
  const produced = scalarChild(body, reductionHost(domain, framing, labels), ctx, fresh);
  if (!produced || produced.yields !== 'one' || produced.present !== ALWAYS_PRODUCTIVE) return null;
  return reductionTail(domain, produced, fresh, labels, bulked);
}

export function perTraverserChild(
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

/** The stream barriers that SELF-SCOPE per origin when run inside a per-traverser body — `order()` (a
 *  global sort restricted to a partition IS that origin's order), `dedup()` (per-origin DISTINCT via
 *  `dedupOn`), the slice family (`perOriginWindow` via `sliceOp`), and the no-op `barrier`. Every OTHER
 *  `isStreamBarrier` step (`sample`, `fold`, `group`/`groupCount`/`aggregate`, a reducer, a nested
 *  `local`) either changes the framing or has no per-origin form, so a body containing one DECLINES —
 *  the whitelist twin of `match`'s `PER_ORIGIN_UNSAFE` blacklist. */
export const PER_ORIGIN_SAFE_BARRIER: ReadonlySet<string> = new Set(['order', 'dedup', 'limit', 'range', 'skip', 'tail', 'barrier']);

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
  if (!body.filter(isStreamBarrier).every((s) => PER_ORIGIN_SAFE_BARRIER.has(s.name))) return null;
  const rows = childRows(body, rel, framing.elem, labels, ctx, fresh, true);
  if (!rows) return null;
  // DROP origin — flatMap flattens, so the host a row descended from is internal and must not ride into
  // a downstream whole-row `dedup`/merge. Everything else (payload + carried channels) rides through.
  const shed = dropOrigin(rows.rel, fresh);
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
  const ranked = make.window({
    id: fresh('pw'), input: rows, channels: rows.channels, type: typeOf(...rows.type.cols, meta(RN, 'int')),
    specs: [[RN, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [partitionBy], orderBy } }]],
  });
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
 * collapsed binding rows sharing that alias). No `ORDER BY`: the number need only be UNIQUE per row,
 * not ordered — the body's own `order()` mints the `encounter` a later slice ranks by.
 */
export function mintRowOrigin(rel: Rel, fresh: Minter): Rel {
  if (originOf(rel.channels)) return rel;
  const channels = withChannel(rel.channels, ORIGIN);
  const numbered = make.window({
    id: fresh('ow'), input: rel, channels: rel.channels, type: typeOf(...rel.type.cols, meta(ORIGIN.col, 'int')),
    specs: [[ORIGIN.col, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [] } }]],
  });
  const cols = [...payloadCols(rel), ...carriedCols(channels)];
  return make.project({
    id: fresh('om'), input: numbered, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(numbered.id, column.name)] as const),
  });
}

/** DROP the `origin` channel and its column — the counterpart of `mintRowOrigin`/`childRows`' mint,
 *  run once a per-origin body is done so the host a row descended from does not ride into a downstream
 *  whole-row `dedup`/merge (`flatMapRejoin` and `match`'s per-origin body both shed it here). A no-op
 *  when no origin is carried. */
export function dropOrigin(rel: Rel, fresh: Minter): Rel {
  const origin = originOf(rel.channels);
  if (!origin) return rel;
  const channels = rel.channels.filter((channel) => channel.role !== 'origin');
  const cols = rel.type.cols.filter((column) => column.name !== origin.col);
  return make.project({
    id: fresh('dx'), input: rel, channels, type: typeOf(...cols),
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
export function childRows(
  body: readonly IRStep[], input: Rel, elem: Elem, aliases: AliasMap, ctx: ChainCtx, fresh: Minter,
  perRow = false,
): ChildRows | null {
  if (!body.length || originOf(input.channels)) return null;
  const channels = withChannel(input.channels, ORIGIN);
  const seeded = perRow ? mintRowOrigin(input, fresh) : make.project({
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
  // A federated `within(__.call('parent', read.fold()))` — the EXPLICIT membership form of injection.
  // The marker operand resolves to the injected list's MEMBERSHIP SET (the pair value exploded by
  // json_each), so the sibling's own `within` drives membership — no compiler `.fold()`-implies-
  // membership inference. Checked on the RAW (un-normalized) body: `normalize` runs `parseCallSpec` on
  // the `call('parent', …)` and throws (it is not a registered service), so this must fire BEFORE
  // `rootedSteps` normalizes. Present only on a federated sibling chain (`ctx.injectionCell`).
  if (ctx.injectionCell && isNested(operand) && isParentMarkerBody(stepChain(operand.nested, ctx.params)))
    return ctx.injectionCell.listSet();
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
  // A federated `parent` MARKER operand resolves to the per-parent injected VALUE cell — the whole
  // lift-and-shift: the sibling's own `has(k, marker)` then compares the stored value to this cell as
  // ORDINARY equality (or whatever operator the user wrote), no compiler shape sniff. Present only on a
  // federated sibling chain (`ctx.injectionCell`), so a non-federated operand falls through unchanged.
  if (ctx.injectionCell && (isParentMarkerBody(body)
    || isInjectedAliasBody(body, ctx.injectionCell.label)
    // A map-entry value is the ordinary scope value of `select(Column.values)`: Column returns
    // the entry's value unchanged (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/
    // tinkerpop/gremlin/structure/Column.java`).  The entry-rooted V()/E() arm below supplies that
    // value through the same correlated cell the federated injection path already uses.
    || (body.length === 1 && body[0]!.name === 'select' && body[0]!.args.length === 1
      && isColumnArg(body[0]!.args[0]!.value) && body[0]!.args[0]!.value.column === 'values'))) return ctx.injectionCell.value;
  if (body[0]!.name === 'V' || body[0]!.name === 'E') {
    const read = rootedRead(body, ctx, fresh);
    if (!read || read.effects?.length || read.framing.kind !== 'scalar') return null;
    // `P.resolve(traverser)` takes the operand's FIRST result (`vendor/tinkerpop/.../P.java:328-373`,
    // `tv.next()`), so where the operand ends in `order()` the first is the ORDERED first. The read
    // carries the operand's own emission order on its `encounter` channel — but projecting only `v` here
    // let `prune` drop the channel and with it the order, so a bare scalar subquery took a SCAN-order
    // value (`has("name", __.V(x).out().values("name").order())` picked an arbitrary neighbour, not the
    // sorted first — non-deterministic, and the defect that read as a flaky L3 regression). So ORDER BY
    // the encounter and LIMIT 1: the pick is the operand's true first. Unordered operand → no encounter
    // channel, one arbitrary-but-single row exactly as before.
    const enc = encounterOf(read.rel.channels);
    const ordered = enc
      ? make.limit({
        id: fresh('nfl'),
        input: make.sort({ id: fresh('nfs'), input: read.rel, channels: read.rel.channels, type: read.rel.type,
          terms: [{ expr: col(read.rel.id, enc.col), dir: 'asc' }] }),
        channels: read.rel.channels, type: read.rel.type, count: compilerInt(1),
      })
      : read.rel;
    return { kind: 'scalar', plan: make.project({
      id: fresh('nfv'), input: ordered, channels: [], type: typeOf(meta('v', 'any', true)),
      exprs: [['v', col(ordered.id, 'v')]],
    }) };
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
 * A `select(<label>)` in a child body REROOTS to the aliased traverser — the alias analogue of
 * `rerootedHost`'s endpoint/owner reroots, so `by(__.select('a').values('name'))`,
 * `concat(__.select('a'))` and `is(__.select('a')…)` all continue the body against whatever the label
 * named, whatever the current host is.
 *
 * The mechanism is entirely `aliasProjection`'s: `Scoping.getScopeValue` resolves a label off the
 * traverser's scope, and for an element/scalar/property host that scope IS the `HostRow`'s alias map
 * (a record host's own MAP SCOPE beats the labels, so `recordTail` answers select there and this arm
 * declines it). An element alias becomes an element host, a value alias a scalar host carrying the
 * label's per-row type where it had one; a list/Pop history is a later phase and declines with the
 * same `null` an absent or non-live label gives — fail closed, never a guess off the wrong row.
 */
export function selectRerootHost(step: IRStep, host: ChildHost, fresh: Minter): ChildHost | null {
  if (host.kind === 'record' || !host.row || step.modulators?.length) return null;
  const spec = selectSpec(step);
  if (!spec || spec.labels.length !== 1) return null;
  const proj = aliasProjection(host.row.rel, host.row.aliases, spec.labels[0]!, spec.pop, fresh);
  if (!proj) return null;
  const row = { row: host.row } as const;
  if (proj.read.kind === 'element') return { kind: 'element', id: proj.payload[0]![1]!, elem: proj.read.elem, ...row };
  if (proj.read.kind === 'value') {
    const vtype = proj.payload[1]?.[1];
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
/** Does an expression tree contain a SUBQUERY node (a correlated `scalar`/`exists`/`in-query`)? */
export function exprHasSubquery(e: Expr): boolean {
  if (e.kind === 'scalar' || e.kind === 'exists' || e.kind === 'in-query') return true;
  return exprChildren(e).some(exprHasSubquery);
}

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
 */
export function correlatedReduce(
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
  return correlatedReduce(selfRow, host.elem, body, 0, ctx, fresh);
}

export function scalarChild(body: readonly IRStep[], host: ChildHost, ctx: ChainCtx, fresh: Minter): ChildValue | null {
  if (!body.length) return null;
  const first = body[0]!;

  // An unfolded map entry is a real child host, not a special `select(Column.values)` pattern. Seed a
  // one-row entry relation with its two correlated sides and hand the WHOLE body to the normal framing
  // dispatcher. Thus every map-entry/list/scalar tail composes here at arbitrary depth.
  if (host.kind === 'scalar' && host.entry) return mapEntryChild(body, { ...host, entry: host.entry }, ctx, fresh);

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
    const node = self && recordNode(first, host, self.framing, self.col, childSeam(ctx, fresh), ctx.source, fresh);
    // `project()` is a `ScalarMapStep` — one map per traverser, never several.
    return node && { expr: node, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } }, yields: 'one' };
  }

  // `valueMap()`/`elementMap()` are the other per-traverser map producers. Reuse the ordinary map
  // builder so its key filtering, tokens, flat elementMap values and true `MapOf` descriptor cannot
  // diverge from the top-level step. `PropertyMapStep` is a ScalarMapStep — one map per element
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/PropertyMapStep.java`).
  if ((first.name === 'valueMap' || first.name === 'elementMap') && body.length === 1 && host.kind === 'element') {
    const args = argValues(first);
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
    return { expr: jsonOf({ kind: 'scalar', plan: scalar }), framing: { kind: 'map', keyOf: mapped.keyOf, valOf: mapped.valOf }, yields: 'one' };
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

  // A `select(<label>)` RE-ROOT — the alias analogue of the endpoint/owner reroots above, so a child
  // body may read a bound label and continue against it. A bare `select('a')` yields the aliased
  // traverser itself (an element or a value); a chain past it continues against the new host.
  if (first.name === 'select') {
    const reHost = selectRerootHost(first, host, fresh);
    if (!reHost) return null;
    if (body.length === 1) {
      if (reHost.kind === 'element') return { expr: reHost.id, framing: { kind: 'elements', elem: reHost.elem }, present: ALWAYS_PRODUCTIVE, yields: 'one' };
      if (reHost.kind === 'scalar') return {
        expr: reHost.value, framing: { kind: 'scalar', type: reHost.vtype ? PER_ROW('vtype') : UNKNOWN },
        ...(reHost.vtype ? { vtype: reHost.vtype } : {}), present: ALWAYS_PRODUCTIVE, yields: 'one',
      };
    }
    return scalarChild(body.slice(1), reHost, ctx, fresh);
  }

  // A PROPERTY host's three projections are STEPS, and two of them read the stored row. `element()` is
  // the third and re-roots above, which is why it is not here.
  if (host.kind === 'property') {
    // A property's KEY is always present and always a string; its VALUE carries the stored `vtype` per
    // row, which is `propertyValue`'s channel read through a rowid instead of through the join.
    if (first.name === 'key' && !argValues(first).length)
      return valueRun(body, 1, { value: propertyReadOf(host.id, host.ownerElem, 'key', fresh), type: STATIC('string'), vtype: undefined, present: ALWAYS_PRODUCTIVE, yields: 'one' }, host.row, childSeam(ctx, fresh), ctx.source, fresh);
    if (first.name === 'value' && !argValues(first).length)
      return valueRun(body, 1, {
        value: propertyReadOf(host.id, host.ownerElem, 'value', fresh), type: UNKNOWN,
        vtype: propertyReadOf(host.id, host.ownerElem, 'vtype', fresh), present: ALWAYS_PRODUCTIVE,
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
      ? { expr: projected.value, framing: projected.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' }
      : null;
  }
  if (host.kind !== 'element') return null;

  // A REDUCER OVER A CORRELATED BODY, rooted TWO ways through ONE engine (`correlatedReduce`): a
  // MOVEMENT hop (`by(__.inE('created').values('weight').sum())`) roots the fold at the adjacency, and a
  // value chain over the HOST ITSELF (`by(__.values('age').max())`) roots it at a one-row SELF relation.
  // A movement is not required — what is required is that the body END in a reducer; a bare
  // `__.count()`/`__.values(k)` with no reduction falls through to the expression arm below.
  const child = movement(body[0]!, { correlated: host.id }, host.elem, ctx.source, fresh);
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
    const projected = byExpr({ key: { kind: 'property', key: args[0] } }, host, ctx.source, fresh);
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

  return valueRun(body, at, { value, type, vtype, present, yields }, host.row, childSeam(ctx, fresh), ctx.source, fresh);
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
      return { expr: { kind: 'scalar', plan: scalar }, framing: rooted.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
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
    // `unfold()` keeps a map entry's stored typed node in `mv`; a scalar `Column.values`
    // read is its payload, exactly as `entrySide` restores it for the ordinary entry loop.
    // The mapValues transport supplies scalar parent values, so another value shape remains an
    // honest decline until its corresponding entry-side decoder is needed here.
    if (host.entry.valOf.kind !== 'scalar') return null;
    const entryValue: Expr = { kind: 'call', fn: 'json_extract', args: [col(joined.id, 'mv'), compilerText('$.v')] };
    const entryCtx: ChainCtx = {
      ...inBody(ctx),
      injectionCell: {
        value: entryValue,
        listSet: () => make.explode({
          id: fresh('evx'), channels: [], expr: entryValue, as: { value: 'value' },
          type: typeOf(meta('value', 'any', true)),
        }),
      },
    };
    const tail = continueAs(joined, { kind: 'elements', elem }, body, 1, false, entryCtx, fresh, NO_ALIASES);
    if (!tail || tail.effects || tail.framing.kind !== 'elements') return null;
    const members = make.aggregate({
      id: fresh('evl'), input: tail.rel, channels: [], type: typeOf(meta(LIST_COL, 'json', true)), groupBy: [],
      aggs: [[LIST_COL, { kind: 'agg', fn: 'json_group_array', args: [col(tail.rel.id, 'id')] }]],
    });
    return {
      expr: { kind: 'scalar', plan: members },
      framing: { kind: 'list', of: { kind: 'elem', elem } },
      present: ALWAYS_PRODUCTIVE,
      yields: 'one',
    };
  }
  const tail = continueAs(root, { kind: 'mapEntry', keyOf: host.entry.keyOf, valOf: host.entry.valOf }, body, 0, false, inBody(ctx), fresh, NO_ALIASES);
  if (!tail || !collapsedToOneRow(tail.rel)) return null;
  const scalarOf = (column: string): Expr => ({ kind: 'scalar', plan: make.project({
    id: fresh('ev'), input: tail.rel, channels: [], type: typeOf(meta(column, 'any', true)), exprs: [[column, col(tail.rel.id, column)]],
  }) });
  if (tail.framing.kind === 'list') return { expr: scalarOf(LIST_COL), framing: tail.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
  if (tail.framing.kind === 'map') return { expr: scalarOf('map'), framing: tail.framing, present: ALWAYS_PRODUCTIVE, yields: 'one' };
  if (tail.framing.kind === 'scalar') return {
    expr: scalarOf('v'), framing: tail.framing,
    ...(tail.framing.type.kind === 'perRow' && tail.framing.type.carrier.kind === 'column' ? { vtype: scalarOf(tail.framing.type.carrier.name) } : {}),
    present: ALWAYS_PRODUCTIVE, yields: 'one',
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
  seed: { readonly value: Expr; readonly type: ScalarType; readonly vtype: Expr | undefined; readonly present?: Expr; readonly yields: ChildValue['yields'] },
  row: HostRow | undefined, child: ChildSeam, source: GraphSource, fresh: Minter,
): ChildValue | null {
  let value = seed.value;
  let type = seed.type;
  let vtype = seed.vtype;
  // A value TRANSFORM does not change WHETHER the body produced — `toUpper()` of nothing is still
  // nothing — so the leading step's answer rides through the whole run unchanged. A trailing `is(pred)`
  // NULLs the value where the predicate fails, which the host's own productivity filter then drops.
  const present = seed.present;
  for (let at = from; at < body.length; at++) {
    const step = body[at]!;
    if (REL_PROJECTORS.has(step.name)) {
      const host: ChildHost = { kind: 'scalar', value, ...(vtype ? { vtype } : {}), ...(row ? { row } : {}) };
      const projected = projectorValue(step, host, child, source, fresh);
      if (!projected) return null;
      value = projected.value;
      type = projected.framing.kind === 'scalar' ? projected.framing.type : UNKNOWN;
      vtype = undefined;
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
      const pred = step.args[0]?.value;
      if (pred == null || isNested(pred)) return null;
      const subjType: SubjectType = vtype ? { kind: 'perRow', vtype }
        : type.kind === 'static' ? { kind: 'static', type: type.type, text: type.text } : SUBJECT_UNKNOWN;
      const test = predicateExpr(value, pred, subjType, step.args[0]?.type ?? null, step.args[0]?.name ?? null, fresh);
      if (!test) return null;
      value = { kind: 'case', whens: [[test, value]], else: compilerNull() };
      continue;
    }
    if (!REL_TRANSFORMS.has(step.name)) return null;
    const transformed = transformExpr(step, value, false);
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
export function scalarHostChild(
  body: readonly IRStep[], host: Extract<ChildHost, { kind: 'scalar' }>, child: ChildSeam, source: GraphSource, fresh: Minter,
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
  return valueRun(body, at, { value, type, vtype, yields: 'one' }, host.row, child, source, fresh);
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
export function listHostChild(
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
