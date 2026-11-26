import { isNested, isPred } from '../../../gremlin/frontend.ts';
import { col, compilerInt, compilerNull, conjoin, conjuncts, disjoin, eq, isNot, or, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import { decorrelateAll, keyMatch, type Decorrelated, type KeyProjection } from '../../../rel/decorrelate.ts';
import { commitScope, dropRefusals, forkCollections, isScopedFork, pendingLabels, pendingSites, refusalMark, refusedSites, refuseSite, restoreCollections, type Collections, type PoolRecipe, type Site } from '../collection.ts';
import { positionKeys } from '../../../rel/position.ts';
import { atMostOneRow, exactlyOneRow } from '../../../rel/bounds.ts';
import { perHostWork } from '../../../rel/work.ts';
import { brandRel, type Rel } from '../../../rel/rel.ts';
import type { Binding } from '../../../rel/plan.ts';
import { freshCopy } from '../../../rel/mint.ts';
import { exprMayAbort, mayRaise } from '../../../rel/raise.ts';
import type { ColMeta, RelId, SortTerm } from '../../../rel/types.ts';
import { deepColsRead, exprHasSubquery, exprRels, forEachExpr, forEachRel, freeRelIds, isSelfContained, joinSide, mapColsDeep, mapExprChildren, mapRelExprs, rewriteExpr, rewriteRels, substRelId } from '../../../rel/walk.ts';
import { fromTree } from '../../../rel/block.ts';
import { columnIsRowKey, columnIsStored, columnLineage, columnReadsSubquery, exprDraws, nestsCorrelatedSubplans, spelledOuterColumns, threadingRowKey } from '../../../rel/copies.ts';
import { withChannel, type Channel, type ChannelRole } from '../../../channels.ts';
import type { AliasMap } from '../../alias.ts';
import { aliasElementHost, aliasIdAt, aliasProjection, isElementAlias, selectSpec } from '../alias.ts';
import { freshTraverserRow, type RootedRead } from '../child.ts';
import type { Elem } from '../../elem.ts';
import type { ChildHost, ChildValue, PresentWhen, Subject } from '../child.ts';
import { collectsSideEffect, FAN_OUT_HOSTS, FILTER_HOSTS, isLocalScope, isStreamBarrier, nondeterministic, PATH_READERS, traversalIdArg, type IRStep } from '../../ir/step.ts';
import { keepsPosition, splitPosition } from './movement.ts';
import type { ListOf, MapOf } from '../../../sql/kernel/render.ts';
import { countsTraversers, groupKeyTerms, groupRows, isValueBarrier, keyedValuesMap, mapHoldsRowids, mapNodePayload, poolingStep, POOLED_RECIPE, type GroupedMap, type GroupRows } from '../map.ts';
import { staticMemberTag } from '../list.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { asLabelsOf, matchLabelsOf } from '../../ir/labels.ts';
import { bulkObservedFrom } from '../../ir/bulk.ts';
import { CONNECTOR_HOSTS } from '../../ir/analyze.ts';
import { defaultCollation, firstArrival, firstRow, listNode, mapNode, meta, payloadCols, rowNumberWindow, typeOf, type Minter } from '../build.ts';
import { framingCols, perTraverserFraming, rowResident, type RecordField, type RelFraming } from '../framing.ts';
import { branchOrderOwed, continueAs, edgeFeedsOtherV, dropEncounter, dropPath, freezeParent, keyedGroupTail, mintBranchOrder, positioned, withBranchEffects } from '../lower.ts';
import { chooseArms, coalesceArms, ensureBulk, isReductionArm, mergeArms, optionalArms, reconcileCollapsed, unionArms, type RoutedCondition } from './branch.ts';

import { byNode, isProductiveBy, memberNodeOf, modulations, productivityFilter, type ByField, type Modulation } from '../modulator.ts';
import { appendValuePosition, extendPath, pathCarried } from '../path.ts';
import { recordOf, recordToMap } from '../record.ts';
import { drawInGroupValue, effectInChild, hubInWalkTerm, UnsupportedTraversal, type Declines } from '../../unsupported.ts';
import { BULK, bodyOf, ENCOUNTER, encounterOf, FROM_V, inBody, NO_ALIASES, noteUnrolled, type ChainCtx, type HostProgress, type Tail } from './chain.ts';
import { childSeam, drawnPerOrigin, isUniformPick, hostStateAt, readsHostState, reductionHost, rootedRead, SHARED_DRAW } from './reduction.ts';
import { prune } from '../../../rel/passes/prune.ts';

// SCOPED RELATIONS — a child-taking host as a CONNECTOR, not a route (`docs/2026-11-15-compositional-coverage-plan.md`
// §2, S1–S4). Every host here is the same three moves, and only the third differs:
//
//   1. SCOPE the input (S1): number its rows — `ROW_NUMBER()`, which needs no rowid, so EVERY framing has a
//      scope key (an element, a value, a list, a map, a record, a path);
//   2. lower the body through `continueAs` — the fold the ROOT uses — over ONE correlated row of the input
//      (the traverser TinkerPop hands the child, `TraversalUtil.apply`), then DECORRELATE it against the scoped
//      input (`src/rel/decorrelate.ts`): an ordinary relation keyed by the scope key. Every barrier in the body
//      is scoped by the key by construction (S2) — an `Aggregate` grouped by it, a `Window` partitioned by it —
//      and every enclosing scope's key rides as one more key column when THAT scope decorrelates the plan this
//      one is nested in, so the scope STACK is the set of key columns, never a route per depth. A seeded barrier
//      over an empty scope keeps its seed (S3) because a scalar aggregate LEFT JOINs the domain and takes its
//      value over zero rows — the correlated plan's own SQL answer, kept exactly;
//   3. RECONNECT on the key by the host's policy (S4) — one row per host in `CONNECTORS`, keyed by step name.
//      The rows are built from a few generic reconnect primitives: an existence join (semi/anti), the REJOIN
//      (`rejoin`: every result or the first per scope, under the `split` or `forward` traverser policy), a
//      PRIORITY over arms (each arm's host anti-joined on every earlier arm's key), by() VALUES landed as join
//      columns for the host's own lowering to read (`landValues`, S5), and a POOL whose scope is a group key
//      rather than a traverser (`pooledGroup`).
//
// THIS IS THE ONE MECHANISM FOR NESTING. The ladder of specialised correlated routes it replaced, and the
// `correlatedChild` switch that ordered the two, are deleted (`docs/archive/2026-11-16-ladder-retirement-plan.md` R7); where
// a row does not claim its site, the host's OWN lowering of the step is the fallback (`scopedHost`).

/** The channels a child body does NOT inherit from its host row. A child is handed ONE traverser at bulk 1
 *  (`TraversalUtil.apply`, `LocalStep.java:80-88`), so the host's multiplicity, its position in the host
 *  stream and its scope keys stay with the host — the connector puts them back from the scoped input. */
const HOST_ONLY: ReadonlySet<ChannelRole> = new Set<ChannelRole>(['bulk', 'encounter', 'origin', 'branchKey']);

interface Scope {
  /** The input with its scope key — computed ONCE (a fenced CTE where it is self-contained, else numbered
   *  deterministically), because the body's domain and the reconnect both read it. */
  readonly scoped: Rel;
  readonly key: string;
}

/**
 * S1 — THE SCOPE KEY, over any framing: `ROW_NUMBER()`. Two reads of the scoped input (the reconnect, and the
 * domain inside the decorrelated body) must agree on which row holds which key, so the numbering is computed
 * once: a FENCED materialization where the input is self-contained, and otherwise (a scope inside a correlated
 * body, which no CTE can hold) a numbering ORDERED BY EVERY COLUMN — rows that tie on every column are
 * interchangeable, so both reads pair each key with the same row content.
 */
function scope(rel: Rel, fresh: Minter, asChannel = false): Scope {
  const key = fresh('sk') as string;
  const selfContained = isSelfContained(rel);
  // At most ONE row (a correlated body's seed) has one numbering under any order — so it orders by nothing, rather
  // than by the host columns it copies, which a window two subqueries down cannot resolve (`correlatedBody`).
  const order = selfContained || atMostOneRow(rel) ? [] : rel.type.cols.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const }));
  const window = rowNumberWindow(rel, key, rel.channels, { partitionBy: [], orderBy: order }, fresh);
  // `asChannel`: the key rides as a CHANNEL (an enclosing scope key, `branchKey`) rather than a payload column,
  // for a host whose own lowering carries the scoped rows onward (`chooseRoute`) — every tail carries a channel.
  const keyChannel: Channel = { col: key, role: 'branchKey' };
  const channels = asChannel ? withChannel(rel.channels, keyChannel) : rel.channels;
  const cols = [...payloadCols(rel), ...channels.map((channel) => window.type.cols.find((column) => column.name === channel.col)!)];
  const numbered = asChannel
    ? make.project({ id: fresh('skc'), input: window, channels, type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(window.id, column.name)] as const) })
    : window;
  const scoped = selfContained
    ? make.materialize({ id: fresh('scm'), input: numbered, channels: numbered.channels, type: numbered.type, fenced: true })
    : numbered;
  return { scoped, key };
}

/** ONE correlated row of the scoped input — the traverser the child body starts from: its payload and every
 *  channel the body may read (labels, path, sack), minus the host-only ones. */
function seedRow(rel: Rel, scoped: Rel, fresh: Minter, positioned: boolean): Rel {
  // ONE traverser has a trivial emission order — position 0 — the one `positioned` gives any one-row input.
  // It is carried only where the body reads a POSITION from its start (`tail`, the last n, which has no
  // answer without one): a position the body does not need would order every collect in it by emission
  // (`fold`'s members) where the correlated lowering orders them by value, and the two routes of one
  // connector site must agree on a value they each pick deterministically.
  const own = rel.channels.filter((channel) => !HOST_ONLY.has(channel.role));
  const channels = positioned ? withChannel(own, ENCOUNTER) : own;
  const named = (name: string): ColMeta => rel.type.cols.find((column) => column.name === name)!;
  const cols = [...payloadCols(rel), ...channels.map((channel) => (channel === ENCOUNTER ? meta(ENCOUNTER.col, 'int') : named(channel.col)))];
  const unit = make.values({ id: fresh('su'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  return make.project({
    id: fresh('ss'), input: unit, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, column.name === ENCOUNTER.col ? compilerInt(0) : col(scoped.id, column.name)] as const),
  });
}

/** A body lowered over one host row and decorrelated against the scope: its rows keyed by `keyCol`. */
interface ScopedBody {
  readonly rel: Rel;
  readonly keyCol: string;
  readonly tail: Tail;
  /** How many side-effect sites the body collected and `keyedBody` committed. */
  readonly collected: number;
}

/**
 * The body lowered through `continueAs` — the fold the ROOT uses — over ONE row of the host (read off `from`:
 * the host itself, or its scoped copy). A child traversal BEGINS here, handed one traverser at a time
 * (`ChainCtx.traversal`); it is a body, so the movement collapse is off (`inBody`), and it has no per-origin
 * domain of its own — its barriers are scoped by the connector, not by an origin channel.
 *
 * An EXISTENCE gate reads no order from its body (`ChainCtx.bodyOrder` 'free'); a FIRST-row reconnect reads
 * the body's EMISSION order ('read'): `TraversalMapStep` keeps `mapTraversal.next()`, the child's first
 * traverser in its own iteration order
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53`,
 * `…/traversal/util/TraversalUtil.java` `apply`) — `map(union(a, b))` is `a`'s first, `map(values(k))` the
 * first-stored value. So a body that may yield SEVERAL rows and carries no position yet is lowered from a
 * POSITIONED seed: its hops then number their rows in storage order (the same `encounter` a root chain's
 * `fold` reads), and the pick is by that position, never by value. A body of at most one row (a reducer, a
 * record) has nothing to pick and keeps the unpositioned plan — whose collects order their members as the
 * correlated first-row read does. `positionedSeed` asks for the position outright (a merge that numbers its arms).
 */
function lowerBody(
  body: readonly IRStep[], rel: Rel, from: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false, contract: RejoinContract = 'forward', correlated = false, fromV = false,
): Tail | null {
  // `fromV`: an `otherV()` after a FORWARDING host reads the child traverser's own previous object — the vertex
  // the body's tail edge hop entered from — so that hop mints it (`needsFromV`, which `inBody` otherwise clears).
  const bodyCtx: ChainCtx = { ...inBody(ctx), ...(fromV ? { needsFromV: true } : {}), traversal: { steps: body, rooted: false }, originDomain: undefined, ...(order ? { bodyOrder: order } : {}) };
  const positioned = positionedSeed || someStepDeep(body, ctx.params, (s) => s.name === 'tail');
  const run = (at: boolean): Tail | null => {
    const seed = seedRow(rel, from, fresh, at);
    const reSourced = reSourcedBody(seed, body, framing, bodyCtx, fresh, labels, contract, correlated);
    return reSourced !== undefined ? reSourced : continueAs(seed, framing, body, 0, false, bodyCtx, fresh, labels);
  };
  // The retry lowers the body AGAIN, so the side-effect sites the first lowering registered are put back first —
  // each collector is one site, however many times its body is lowered.
  const saved = new Map(ctx.collections);
  const tail = run(positioned);
  if (order === 'read' && tail && !positioned && !encounterOf(tail.rel.channels) && !atMostOneRow(tail.rel)) {
    restoreCollections(ctx.collections, saved);
    return run(true);
  }
  return tail;
}

/**
 * WHICH TRAVERSER A HOST EMITS FOR ITS BODY'S RESULT — the body's REJOIN CONTRACT, read by `reSourcedBody`: `first`
 * (`map`, a `by()`, an existence test — one result, split from the host), `split` (`flatMap`, `coalesce` — every
 * result, each `head.split(result)`: the payload is the body's, every channel and the path the host's extended by
 * the result alone) or `forward` (`local`, `optional`, a pool's per-member part — the CHILD's own traverser:
 * its path and labels). The same vocabulary as `rejoin`'s policy plus the first-row pick; a site with no rejoin
 * policy of its own takes `forward`, the most demanding.
 */
type RejoinContract = 'first' | 'split' | 'forward';

/** The traverser state a re-source's split carries through unchanged (`reSourcedBody`). */
const CROSSES: ReadonlySet<ChannelRole> = new Set<ChannelRole>(['alias', 'sack', 'loops']);

/** Where a body RE-SOURCES at its top level — the first plain `V()`/`E()` (literal ids, not `V(<traversal>)`,
 *  whose ids come from the host) — or -1. */
/** The slices that BOUND how many rows reach them per stream — `limit`/`range`, where the reference's
 *  `RangeGlobalStep` stops pulling at its high bound (`skip` and `tail` read every row). */
const BOUNDING_SLICES: ReadonlySet<string> = new Set(['limit', 'range']);

const reSourceAt = (body: readonly IRStep[]): number =>
  body.findIndex((s) => (s.name === 'V' || s.name === 'E') && !s.idOfValue && !traversalIdArg(s));

/**
 * A body that RE-SOURCES (`map(__.V().count())`, `local(__.V().values('name'))`, `__.select('a').V()…`) — the
 * body from the re-source on, lowered ONCE as the uncorrelated read it is and crossed with the traverser before
 * it; `undefined` where this does not apply (the body is the fold's as any other), `null` to decline.
 *
 * A mid-traversal GraphStep emits the whole graph per incoming traverser, keeping that traverser's carried
 * state (`head.split(element, this)`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:193-221`),
 * so the rows after it do not depend on the host's VALUE. Where the part before it holds EXACTLY ONE row (the
 * seed itself, or a `select` of a label every row binds), every barrier after the re-source is a barrier over the
 * graph alone: `rest(prefix × G) = prefix × rest(G)`. So `rest(G)` is one ROOTED read (`rootedRead`), fenced and
 * computed once, and the body is the prefix crossed with it — an uncorrelated subtree the decorrelator leaves
 * untouched and crosses with the domain once (Neumann/Kemper's rule for a correlation-free side, Calcite
 * `TopDownGeneralDecorrelator`), never a graph scan per host row. A FIRST-row consumer (contract `first`: `map`, a
 * `by()`, an existence test) needs only the read's first row — picked once, by the collation a per-scope pick uses
 * (`defaultCollation`) — so a host row costs one row however large the graph.
 *
 * PRESENCE IS A ROW: a productive null (`__.V().constant(null)`) is a row whose value is NULL, so `map()` keeps
 * the traverser (`TraversalMapStep` emits whenever the child `hasNext()`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java`).
 *
 * Under an ALL-rows contract (`split`, `forward`) the shared read stops only where the rest first reads the host's
 * state (`sharedEnd`), and the fold continues over the cross from there — so the cross holds the traversers the
 * reference's split has reached at that step, never the whole graph per host ahead of a filter, order or slice
 * the shared part holds. A label the read binds reads nothing of the host: it rides out as an alias channel.
 * Under `split` (`flatMap`) the emitted traverser is the HOST's split by the result (`FlatMapStep`), so a tracked
 * path crosses unchanged as it does under `first` and `rejoin` extends it by the result alone — the read's own
 * GraphStep positions never leave the child.
 *
 * ONE POLICY prices a rest that reads the HOST traverser's state (its sack, path, loops or a host label —
 * `readsHostState`), which one shared evaluation cannot hold: an ALL-rows host pays the cross the query asks for
 * (split at `sharedEnd`), and a FIRST-row host returns `undefined` — GraphStep's own cross, in the fold — which its
 * host's correlated-first policy (`firstInnerOver`, `recordLeft`, `landValues`' `correlatedValue`, the existence
 * probe; over a host computed once where its label is a computed column, `fencedHost`) reads per host row and
 * stops at the first row: an `EXISTS`, or a first-row pick that finds its leading element first
 * (`src/rel/passes/leading.ts`) and slices by position keys (`slicesByKeys`) — what `TraversalMapStep`'s one `next()` and
 * `TraversalFilterStep`'s one `hasNext()` read. A body with no row reads the whole graph for that host, as the
 * reference's exhausted child does. Where the host cannot hold that read per host row (its decorrelated fallback,
 * `correlated` false), the cross would be every host × the graph ahead of the pick: declined, naming the shape.
 *
 * Under `forward` a tracked path (the child's own path, emitted, is the host's EXTENDED by the read's positions)
 * gains the ONE position the split met while the read keeps its position (`keepsPosition`), appended after the
 * cross; the shared read stops where the read first moves, and the fold extends the rest.
 *
 * What it refuses, from the query text: under `forward` with a tracked path, a stream barrier after the read
 * moves, or a bounding slice after it first reads the host (either would cut hosts × graph per host), under `split` a tracked path the rest READS (the
 * child's path inside the body is likewise extended), and a prefix of label reads that may LOSE its row — the re-source discards
 * the selected value, so the answer would depend only on which rows matched: `admitsReSource`, the one explained rule the scalar seam asks too. Any other prefix that may
 * lose or multiply its row (`out().V()`, `values('age').V()`) is GraphStep's own cross join, in the fold.
 */
function reSourcedBody(
  seed: Rel, body: readonly IRStep[], framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap, contract: RejoinContract,
  correlated: boolean,
): Tail | null | undefined {
  const first = contract === 'first';
  const at = reSourceAt(body);
  if (at < 0) return undefined;
  const prefix: Tail | null = at === 0 ? { rel: seed, framing, aliases: labels, bulked: false }
    : continueAs(seed, framing, body.slice(0, at), 0, false, ctx, fresh, labels);
  if (!prefix || prefix.effects?.length) return null;
  // A prefix that may lose or multiply its row is GraphStep's own cross join, in the fold — which also asks the
  // explained admission rule of a discarded label read (`reSourceTail`'s `admitsReSource`).
  if (!exactlyOneRow(prefix.rel)) return undefined;
  const rest = body.slice(at);
  // A tracked path that a `split` body reads inside itself is the host's EXTENDED by the read's positions, which
  // the shared read does not hold: declined.
  if (pathCarried(prefix.rel) && contract === 'split' && readsPath(rest, ctx)) {
    ctx.declines.note({ kind: 'resource-path', message: resourcePathMessage(rest, ctx), terminal: false });
    return null;
  }
  // A rest that reads the HOST traverser's state (an outer label, its sack, path or loops) cannot be one
  // shared read: it is GraphStep's own cross with the host, in the fold (`movement.ts` `reSource`). One policy
  // prices it by the host's contract: an ALL-rows host pays the cross the query asks for (below, split at
  // `sharedEnd`), and a FIRST-row host pays a correlated read that stops at its first row — the host tries
  // `correlatedBody` first (`firstInnerOver`'s correlated first-row pick, the existence probe's `EXISTS`), so
  // inside it the cross is ONE host row × the graph up to its first match (`src/rel/passes/leading.ts`).
  //
  // A first-row read that is NOT per host row (the decorrelated scope, the host's fallback where SQL cannot hold
  // the dependent join) would cross EVERY host with the graph ahead of its first-row pick: N × G where the
  // reference reads one host × the graph up to its first match. Declined, naming the query shape, rather than an
  // answer that is quadratic in the hosts.
  if (first && readsHostState(rest, ctx)) {
    if (correlated) return undefined;
    ctx.declines.note({ kind: 'resource-reads-host', message: hostStateMessage(rest, ctx), terminal: false });
    return null;
  }
  // Under an ALL-rows contract (`split`, `forward`) a host label the rest reads is the host's. The rest SPLITS only where it first reads the host (`sharedEnd`): the part before is one shared read
  // crossed with the prefix — `rest(prefix × G) = rest₂(prefix × rest₁(G))`, where `rest₁` reads nothing of the
  // host — and the fold continues over that cross. A label the read BINDS reads nothing of the host either, so it
  // stays inside `rest₁` and rides out of the cross as an alias channel beside the host's (`ownLabels`) — never a
  // cut, which would put the whole graph per host ahead of a reducer, filter or slice the shared read holds.
  const hostCut = first ? rest.length : sharedEnd(rest, prefix.aliases, ctx);
  if (hostCut < 1) return undefined;
  // A tracked path the CHILD's traverser carries out (`forward`: `local` emits the child's own traverser) is the
  // host's EXTENDED by the read's positions. While the read keeps its position — the re-source, then filters,
  // reorders and slices (`keepsPosition`) — that is ONE position, the element the split met, appended after the
  // cross (`splitPosition`) exactly as GraphStep's split appends it. So the shared read stops where the rest first
  // MOVES as well, and the fold extends the path through each later step over the cross — the hosts × read rows
  // the query asks for. A stream barrier there, ahead of the host cut, would cut a hosts × graph product down per
  // host where the shared form cuts once (`V().out().limit(1)`, `V().values('x').count()`): declined, naming the
  // shape, rather than an answer quadratic in the hosts. (The shared read cannot carry the moved positions — that
  // needs a path the read tracks from its own start, concatenated onto the host's after the cross.)
  const extended = contract === 'forward' && pathCarried(prefix.rel);
  // The reason is NOTED wherever the path is extended: it names the shape if neither this read nor the fold answers.
  if (extended) ctx.declines.note({ kind: 'resource-path', message: resourcePathMessage(rest, ctx), terminal: false });
  const moves = extended ? rest.findIndex((step, i) => i > 0 && i < hostCut && !keepsPosition([step])) : -1;
  // A body that DRAWS there cannot share the cut anyway — its draw is per host — so it is the fold's: GraphStep's
  // product extends each later position (`reSource`), the hosts × read traversers the reference streams.
  if (moves > 0 && rest.slice(moves, hostCut).some(isStreamBarrier)) return nondeterministic(rest.slice(moves), ctx.params) ? undefined : null;
  const shareable = moves > 0 ? moves : hostCut;
  // A DRAW (`sample`/`coin`/`shuffle`, at any depth) in the shared part would be ONE pick for every scope row — the
  // reference draws per incoming traverser (`TraversalUtil.apply` hands the child one at a time). So the shared read
  // ENDS at the first step that draws, and a uniform pick there (`sample(n)`; a shuffle cut to one is one,
  // `ir/shuffle-cut.ts`) is drawn over the shared read itself per scope row (`drawnPerOrigin`: the seed row is one
  // partition, which the decorrelator keys per scope row, `src/rel/decorrelate.ts`) — O(scope + read), where the
  // fold over the cross would rank scope × read. A global sample or shuffle that pick cannot make (a label the read
  // binds, a shuffle cut to several), and a draw inside a child whose own host draws per row, are the fold's over
  // that cross, keyed per scope row — the reference's own scope × read traversers. A `coin` or a `sample` that is
  // not a uniform pick (`sample().by()`, `sample(local, n)`) there is declined from the query text, naming it
  // (`declinedDraw`, `SHARED_DRAW`; the owner's call, R4.5 (A)).
  const drawAt = rest.slice(0, shareable).findIndex((step) => nondeterministic([step], ctx.params));
  if (drawAt >= 0 && (drawAt < 1 || declinedDraw(rest, drawAt))) return sharedDraw(ctx);
  const cut = drawAt >= 0 ? drawAt : shareable;
  if (cut < 1) return undefined;
  // A first-row host reads only the read's first row where the shared read is the whole rest; cut ahead of a draw,
  // the rest continues over every row of it.
  const firstOnly = first && cut === rest.length;
  // Past the HOST cut (a step that reads the host, `where(neq('h'))`) the rest is per host by meaning, so a reducer
  // or sort there reads the hosts × read rows the query streams. A bounding slice does not: the reference's child
  // stops pulling at its bound (`RangeGlobalStep`), so its cost is per host ROW, while the fold would cut a
  // hosts × graph product per host — declined, naming the shape (`where(neq('h')).limit(1)`, `…order().limit(1)`).
  if (extended && rest.slice(hostCut).some((step) => isStreamBarrier(step) && BOUNDING_SLICES.has(step.name))) return null;
  // The prefix's carried state crosses unchanged — `head.split(element)` keeps the traverser's labels, sack and
  // loop counter (the rest reads none of them: `readsHostState`), and a seed position is replaced by the read's
  // own. A PATH crosses unchanged under `first` and `split` too: `map`/`by()`/a filter and `flatMap` emit a
  // traverser split from the HOST (`TraversalMapStep`: `traverser.split(mapTraversal.next(), this)`, `FlatMapStep`
  // `head.split(r)`), so the positions the child's GraphStep appends never leave it (and the rest reads none of
  // them: `readsHostState`, `readsPath`). Under `forward` a tracked path crosses to be extended by the one
  // position the read met (above). An entering vertex (`fromV`) is a hop's: the fold's.
  const splits = contract !== 'forward';
  const crosses = (role: ChannelRole): boolean => CROSSES.has(role) || ((splits || extended) && role === 'path');
  if (!prefix.rel.channels.every((channel) => crosses(channel.role) || channel.role === 'encounter')) return undefined;
  const rooted = rootedRead(rest.slice(0, cut), ctx, fresh, 'many');
  if (!rooted || rooted.effects?.length) return null;
  if (cut === drawAt) {
    const drawn = drawnPerOrigin(rooted, rest, cut, prefix.rel, false, ctx, fresh, prefix.aliases);
    if (drawn) return drawn;
    // The reason names the draw if the fold over the cross declines too.
    ctx.declines.note({ kind: 'shared-draw', message: SHARED_DRAW, terminal: false });
  }
  // The read's own position and multiplicity ride; the sack and loop counter a FRESH start traverser holds are
  // superseded by the host's, which the split keeps. A label or path the read binds of its own is shed under
  // `first` and `split` — those traversers never leave the child (`rejoin`'s `split` keeps the host's channels).
  // Under `forward` the read's labels ride out (`local` emits the child's own traversers), each under a column the
  // prefix does not carry; under `split` they ride only as far as a rest the fold continues past the cut, which
  // may still select them inside the body.
  const labelled = firstOnly || (contract === 'split' && cut === rest.length) ? undefined : ownLabels(rooted, prefix);
  if (labelled === null) return undefined;
  const own = rooted.rel.channels.filter((channel) =>
    channel.role === 'encounter' || channel.role === 'bulk' || (labelled !== undefined && channel.role === 'alias'));
  // A path the read tracks of its own is shed: under `forward` its one position is re-added after the cross.
  const kept = (channel: Channel): boolean => own.includes(channel)
    || (channel.role === 'alias' ? splits : channel.role === 'path' ? splits || extended : CROSSES.has(channel.role));
  if (!rooted.rel.channels.every(kept)) return undefined;
  if (extended && rooted.framing.kind !== 'elements') return undefined;
  // ONE fenced relation is the read's value AND its presence: a first-row host reads both off `once`.
  const read = firstOnly ? firstRow(rooted.rel, defaultCollation(rooted.rel), fresh) : rooted.rel;
  const once = isSelfContained(read) ? make.materialize({ id: fresh('srm'), input: read, channels: read.channels, type: read.type, fenced: true }) : read;
  // The read's columns under fresh names beside the prefix's, then back under their own (a label under the column
  // `ownLabels` gave it).
  const renamed = new Map(once.type.cols.map((column) => [column.name, fresh('srv') as string]));
  const right = make.project({
    id: fresh('srp'), input: once, channels: [], type: typeOf(...once.type.cols.map((column) => ({ ...column, name: renamed.get(column.name)! }))),
    exprs: once.type.cols.map((column) => [renamed.get(column.name)!, col(once.id, column.name)] as const),
  });
  const crossed = make.join({
    id: fresh('srj'), left: prefix.rel, right, join: 'cross', channels: [], type: typeOf(...prefix.rel.type.cols, ...right.type.cols),
  });
  const outName = (name: string): string => labelled?.cols.get(name) ?? name;
  const carried = prefix.rel.channels.filter((channel) => crosses(channel.role));
  const channels = carried.reduce(withChannel, own.map((channel) => ({ ...channel, col: outName(channel.col) })));
  const fromPrefix = new Set(carried.map((channel) => channel.col));
  const source = new Map<string, string>();
  const readCol = (channelCol: string): ColMeta => {
    const original = [...(labelled?.cols ?? [])].find(([, to]) => to === channelCol)?.[0] ?? channelCol;
    source.set(channelCol, renamed.get(original)!);
    const column = once.type.cols.find((c) => c.name === original)!;
    return { ...column, name: channelCol };
  };
  const outCols = [
    ...payloadCols(once).map((column) => (source.set(column.name, renamed.get(column.name)!), column)),
    ...channels.map((channel) => (fromPrefix.has(channel.col) ? prefix.rel.type.cols.find((column) => column.name === channel.col)! : readCol(channel.col))),
  ];
  const projected = make.project({
    id: fresh('srx'), input: crossed, channels, type: typeOf(...outCols),
    exprs: outCols.map((column) => [column.name, col(crossed.id, fromPrefix.has(column.name) ? column.name : source.get(column.name)!)] as const),
  });
  const rel = extended && rooted.framing.kind === 'elements' ? splitPosition(projected, rooted.framing.elem, ctx, fresh) : projected;
  const aliases = labelled ? labelled.aliases : prefix.aliases;
  return cut < rest.length
    ? continueAs(rel, rooted.framing, rest, cut, !!rooted.bulked, ctx, fresh, aliases)
    : { rel, framing: rooted.framing, aliases, bulked: !!rooted.bulked };
}

/**
 * The labels an ALL-rows host's shared read binds, riding out beside the prefix's (`reSourcedBody`): each read
 * label's column renamed to one the prefix does not carry (`a<n>`, the name `bindAliases` would mint), and the
 * merged alias map. `null` where a read label is not a channel this cross can carry — the read binds a label the
 * prefix carries too (its history is the prefix's EXTENDED by the read's, which `sharedEnd` cuts ahead of, so only
 * a bind below the top level reaches here) — the fold's general cross.
 */
function ownLabels(rooted: RootedRead, prefix: Tail): { readonly cols: ReadonlyMap<string, string>; readonly aliases: AliasMap } | null {
  const reads = [...(rooted.aliases ?? [])].filter(([, entry]) => rooted.rel.channels.some((channel) => channel.role === 'alias' && channel.col === entry.col));
  const aliasCols = rooted.rel.channels.filter((channel) => channel.role === 'alias');
  // Every alias channel the read carries must be a label it names (a channel no entry names cannot be renamed).
  if (aliasCols.some((channel) => !reads.some(([, entry]) => entry.col === channel.col))) return null;
  if (reads.some(([label]) => prefix.aliases.has(label))) return null;
  const taken = new Set(prefix.rel.type.cols.map((column) => column.name));
  const aliases = new Map(prefix.aliases);
  const cols = new Map<string, string>();
  for (const [label, entry] of reads) {
    let n = aliases.size;
    while (taken.has(`a${n}`)) n++;
    const name = `a${n}`;
    taken.add(name);
    cols.set(entry.col, name);
    const { pathPos: _dropped, ...rest } = entry;
    aliases.set(label, { ...rest, col: name });
  }
  return { cols, aliases };
}

/** Where an all-rows host's re-sourced rest stops being one shared read (`reSourcedBody`): the first top-level
 *  step that reads host state (`hostStateAt`) or REBINDS a label the prefix carries (`as()`, a `match()`) — a
 *  rebind extends the host's history, which is the host's state — else its length. */
function sharedEnd(rest: readonly IRStep[], carried: AliasMap, ctx: ChainCtx): number {
  const rebinds = rest.findIndex((step) => [...asLabelsOf(step), ...matchLabelsOf(step, ctx.params)].some((label) => carried.has(label)));
  const reads = hostStateAt(rest, ctx);
  const ends = [rebinds, reads].filter((at) => at >= 0);
  return ends.length ? Math.min(...ends) : rest.length;
}

/** Does a re-sourced rest read the traverser's PATH (a path-family step or a `tree()`, at any depth)? */
const readsPath = (rest: readonly IRStep[], ctx: ChainCtx): boolean =>
  someStepDeep(rest, ctx.params, (s) => PATH_READERS.has(s.name));

/** Why a re-sourcing body declines on a traverser whose path is tracked (`reSourcedBody`) — under `local()` (the
 *  `forward` contract), or where the body itself reads the path — named by WHERE the path is asked for: in the
 *  re-sourced body itself, or around the host. */
function resourcePathMessage(rest: readonly IRStep[], ctx: ChainCtx): string {
  const host = `${ctx.host ?? 'local'}()`;
  return readsPath(rest, ctx)
    ? `a path(), simplePath() or cyclicPath() inside ${/^[aeiou]/.test(host) ? 'an' : 'a'} ${host} body that starts with V()/E() is not supported yet`
    : `a V()/E() inside ${host} on a traverser whose path is tracked (a path(), simplePath() or cyclicPath() `
      + 'around it) is not supported yet';
}

/**
 * Why a FIRST-row host's re-sourcing body declines when the steps after its `V()`/`E()` read the incoming
 * traverser and the host cannot read it per host row (`reSourcedBody`). Named in the user's terms; where the rest
 * is nothing but a `select` of an outer label the `V()` discards everything it read, so the likely intent is
 * suggested.
 */
function hostStateMessage(rest: readonly IRStep[], ctx: ChainCtx): string {
  const shape = 'this V()/E() inside map(), by() or a filter, whose later steps read the incoming traverser '
    + '(a select/where of an outer as() label, its sack, path or loops), is not supported yet';
  const spec = rest.length === 2 ? selectSpec(rest[1]!) : null;
  const label = spec?.labels.length === 1 && ctx.scopeNames.labels.has(spec.labels[0]!) ? spec.labels[0] : undefined;
  return label === undefined ? shape
    : `${shape} — here the V() is discarded by select('${label}'); did you mean select('${label}').out(), or V().has(…, select('${label}'))?`;
}

/** Is `steps[at]`, the first step after a re-source that draws, a draw the connector DECLINES rather than make over
 *  every scope row × the graph: a `coin`, or a `sample` that is not a uniform pick (a local one, a weighted one).
 *  A global `sample`/shuffle the counting pick cannot make, and a draw inside a child (whose own host draws per
 *  row), are the fold's over the shared read's cross, keyed per scope row. */
const declinedDraw = (steps: readonly IRStep[], at: number): boolean =>
  steps[at]!.name === 'coin' || (steps[at]!.name === 'sample' && !isUniformPick(steps, at));

/** A draw over a re-source the connector cannot make per scope row (`reSourcedBody`): declined from the query
 *  text, naming the draw. TERMINAL, as the rooted read's own shared-draw decline is: no other route lowers this
 *  body (`connectorOwns`), and the fold's GraphStep product would cross every scope row with the graph. */
const sharedDraw = (ctx: ChainCtx): null => {
  ctx.declines.note({ kind: 'shared-draw', message: SHARED_DRAW, terminal: true });
  return null;
};

/** A host whose child body RE-SOURCES at its top level is the connector's alone (`reSourcedBody`): the host's own
 *  tail's re-source is a scalar first-row read that cannot tell a productive null from no row, so offering it as a route
 *  would answer the same query two ways. A body that also DRAWS is the connector's too: the shared read ends at
 *  the draw, which is made per scope row (`reSourcedBody`, `drawnPerOrigin`). */
export const connectorOwns = (step: IRStep, ctx: ChainCtx): boolean => step.args.some((arg) => {
  if (!isNested(arg.value)) return false;
  const body = bodyOf(arg.value.nested, ctx.params, ctx.sideEffects);
  return !!body && reSourceAt(body) >= 0;
});

/**
 * WHICH RELATIONS A BODY BUILT — a minter that records what it mints, and the `owns` test the decorrelator reads
 * off it (`decorrelate`, `ownDraws` in `src/rel/copies.ts`). A body may READ a relation built before it — a side
 * effect collected upstream of the host (`g.V().sample(1).aggregate('x').V().local(cap('x').unfold())`) — and a
 * draw in that relation was made ONCE, for every scope, so the decorrelator must not key it; only a draw in a
 * relation the body built is one draw per scope row.
 */
function owning(fresh: Minter): { readonly fresh: Minter; readonly owns: (r: Rel) => boolean } {
  const minted = new Set<RelId>();
  return {
    fresh: (hint) => { const id = fresh(hint); minted.add(id); return id; },
    owns: (r) => minted.has(r.id),
  };
}

/**
 * A BODY KEYED BY ITS SCOPE — the one sequence every decorrelated connector body ends in, and the ONE place a body
 * with EFFECTS is refused (a write is not a read the connector may evaluate per scope; `stepHasEffect` is the
 * vocabulary): lower it with a minter that records what it built (`owning`), let the host re-express its value
 * BEFORE the key is added (`reframe`), and decorrelate it against `outer` — keying only the body's OWN draws.
 * `null` declines.
 */
function keyedBody(
  lower: (fresh: Minter, collections: Collections) => Tail | null, outer: Rel, key: string, ctx: ChainCtx, fresh: Minter,
  reframe?: (tail: Tail) => Tail | null, projection?: KeyProjection,
): { readonly keyed: Decorrelated; readonly tail: Tail; readonly collected: number } | null {
  const mine = owning(fresh);
  // THE BODY'S SIDE EFFECTS go into a FORK of the host's registry (`forkCollections`): each site it registers
  // is PENDING — correlated to the body's one host row — and the host's registry sees nothing unless the whole
  // body keys.
  const fork = forkCollections(ctx.collections);
  const out = keyedInFork(lower, outer, key, ctx, fresh, mine, fork, reframe, projection);
  // A body that COLLECTED and still declined says so, naming what it collected (R6.0) — rather than only "no
  // lowering covers". Advisory: a sibling route that answers is never shadowed by it. A collector the fork
  // REFUSED (`refuseSite` — a keyed `group()` whose value by() pools) is named here too, with the form that
  // refused it: this is the ONE raiser, whichever route of the collector's own site found the refusal.
  if (!out && ctx.host) {
    const refused = refusedSites(fork);
    const labels = [...new Set([...pendingLabels(fork), ...refused.map((r) => r.label)])];
    if (labels.length) ctx.declines.note(effectInChild(ctx.host, labels, refused[0]?.example));
  }
  return out;
}

/** `keyedBody`'s work over the body's fork. */
function keyedInFork(
  lower: (fresh: Minter, collections: Collections) => Tail | null, outer: Rel, key: string, ctx: ChainCtx, fresh: Minter,
  mine: ReturnType<typeof owning>, fork: Collections, reframe?: (tail: Tail) => Tail | null, projection?: KeyProjection,
): { readonly keyed: Decorrelated; readonly tail: Tail; readonly collected: number } | null {
  const lowered = lower(mine.fresh, fork);
  if (!lowered || lowered.effects?.length) return null;
  const tail = reframe ? reframe(lowered) : lowered;
  if (!tail) return null;
  const sites = pendingSites(fork);
  // A pending site's rows are the body's rows at the collector, so they are keyed by the SAME decorrelation as
  // the body's tail — one memo, so the prefix they share is one relation, computed once (`decorrelateAll`).
  // A pooled key projection names no single scope row a site could be ordered by, so a pool with a collector
  // declines; a snapshot with no connector site to place it at (`ChainCtx.siteEffects`) likewise.
  const snapshots = ctx.mutating && !isScopedFork(ctx.collections);
  if (sites.length && (projection || (snapshots && !ctx.siteEffects))) return null;
  // A site is ordered by its host row's position, which the domain CARRIES (`scopedSite`) — no rejoin to `outer`.
  const hostEnc = sites.length ? encounterOf(outer.channels) : undefined;
  const all = decorrelateAll([tail.rel, ...sites.map((site) => site.rel)], outer, key, fresh, projection, mine.owns, hostEnc ? [hostEnc.col] : []);
  if (!all) return null;
  const [keyed, ...keyedSites] = all;
  const committed = new Map<Site, Site>();
  for (const [i, site] of sites.entries()) {
    const done = scopedSite(site, keyedSites[i]!, outer, ctx.hostBulked ?? true, fresh);
    if (!done) return null;
    committed.set(site, done);
  }
  if (sites.length) {
    ctx.siteEffects?.push(...commitScope(fork, ctx.collections, committed, ctx.mutating, fresh));
  }
  return { keyed: keyed!, tail, collected: sites.length };
}

/**
 * A BODY'S SITE, KEYED — the member rows of every scope (the site's relation decorrelated with the body), each
 * ordered by its HOST row's position and then by the body's own order at the collector: `(host encounter, body
 * encounter)`, which is the reference's order — `TraversalSideEffectStep`/`LocalStep` drain the child for one
 * traverser before the next arrives. The unit of a per-traverser barrier is the host row (the scope key), which
 * an `Operator.assign` reads (`Site.unit`, `lastMember`).
 *
 * The MULTIPLICITY is the body's rows: the body was handed one traverser at bulk 1 (`TraversalUtil.apply`), so a
 * host row standing for several traversers would owe each of them its contribution. A host that carries a `bulk`
 * channel is therefore refused rather than counted once — the bulk scan (`ir/bulk.ts`) never collapses ahead of
 * a host whose body reads rows, so this is a fail-closed backstop, not a reachable decline.
 *
 * `null` where the keyed relation still names a relation outside the scope (a site registered under a nested
 * route that kept its own correlation): it cannot be read where the collection is.
 */
function scopedSite(site: Site, keyed: Decorrelated, outer: Rel, hostBulked: boolean, fresh: Minter): Site | null {
  if (hostBulked && outer.channels.some((channel) => channel.role === 'bulk')) return null;
  const outerFree = freeRelIds(outer);
  if ([...freeRelIds(keyed.rel)].some((id) => !outerFree.has(id))) return null;
  const k = keyed.key[0].col;
  const own = site.rel.type.cols;
  const hostEnc = encounterOf(outer.channels);
  const unitCol = fresh('shk') as string;
  const owned = own.map((column) => [column.name, col(keyed.rel.id, column.name)] as const);
  if (!hostEnc) {
    // No host position to read: the scope key (the host stream's own numbering) orders the units.
    const rel = make.project({
      id: fresh('shp'), input: keyed.rel, channels: [], type: typeOf(...own, meta(unitCol, 'int')),
      exprs: [...owned, [unitCol, col(keyed.rel.id, k)]],
    });
    return { rel, order: [unitCol, ...site.order], perTraverser: true, unit: unitCol };
  }
  // The host's position is a domain column (`keyedBody` asks the decorrelator to carry it): read in place.
  const carried = keyed.domain.get(hostEnc.col);
  if (!carried) return null;
  const hostCol = fresh('she') as string;
  const rel = make.project({
    id: fresh('shp'), input: keyed.rel, channels: [], type: typeOf(...own, meta(hostCol, 'int'), meta(unitCol, 'int')),
    exprs: [...owned, [hostCol, col(keyed.rel.id, carried)], [unitCol, col(keyed.rel.id, k)]],
  });
  return { rel, order: [hostCol, ...site.order], perTraverser: true, unit: unitCol };
}

/**
 * A LOWERING ATTEMPT a connector may abandon for another form of the same site — the dependent join before the
 * scoped plan, a fenced host before the plain one. A body's side-effect sites are committed as its body keys
 * (`keyedBody`), and an arm lowered over the whole stream registers its own, so an attempt that declines puts the
 * named collections back (and drops the snapshots it took): the form that answers is the one that collects.
 */
function attempt<T>(ctx: ChainCtx, run: () => T | null): T | null {
  const saved = new Map(ctx.collections);
  const taken = ctx.siteEffects?.length ?? 0;
  const out = run();
  if (out === null) {
    restoreCollections(ctx.collections, saved);
    ctx.siteEffects?.splice(taken);
  }
  return out;
}

/** Step 2: the body, lowered as the root lowers a chain, then keyed by the scope. `null` declines. */
function scopedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, sc: Scope, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false, reframe?: (tail: Tail) => Tail | null, contract: RejoinContract = 'forward',
  fromV = false,
): ScopedBody | null {
  // A RE-SOURCE is the connector's own (`reSourcedBody`), drawing or not.
  //
  // A random DRAW (`sample`/`coin`/`shuffle`, at any depth) is the connector's, and this is the form that
  // answers it: the reference hands the body ONE traverser at a time (`TraversalUtil.apply`,
  // vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
  // so it draws once PER SCOPE ROW. The decorrelator counts a draw as touching the scope (`decorrelate`), so
  // the domain is pushed beneath it and every `ORDER BY RANDOM()`/`ROW_NUMBER` it feeds is partitioned by the
  // scope key — one sort, linear in the rows drawn from, and no pick shared by two scopes. Only the body's OWN
  // draws (`owning`): a relation drawn upstream that the body only reads stays one shared pick.
  // `reframe` is the host's own re-expression of the body's value (`landValues`' record).
  const out = keyedBody(
    (mf, collections) => lowerBody(body, rel, sc.scoped, framing, { ...ctx, collections }, mf, labels, order, positionedSeed, contract, false, fromV),
    sc.scoped, sc.key, ctx, fresh, reframe,
  );
  return out && { rel: out.keyed.rel, keyCol: out.keyed.key[0].col, tail: out.tail, collected: out.collected };
}

/**
 * Step 2 for a body ROOTED elsewhere than the scoped row (`LandedRoot`): its domain is the scoped rows whose root
 * element is THERE — a label unbound on a row gives that row no domain row, so its value is absent and the host's
 * productivity rule drops it, as `aliasElementHost`'s presence does — each a FRESH traverser on that element (no
 * labels, no path), keyed by the scope key.
 */
function rootedBody(
  body: readonly IRStep[], root: LandedRoot, rel: Rel, sc: Scope, ctx: ChainCtx, fresh: Minter, reframe: (tail: Tail) => Tail | null,
): ScopedBody | null {
  const type = typeOf(meta('id', 'int'), meta(sc.key, 'int'));
  const located = make.project({
    id: fresh('sbr'), input: sc.scoped, channels: [], type,
    exprs: [['id', substRelId(root.id, rel.id, sc.scoped.id)], [sc.key, col(sc.scoped.id, sc.key)]],
  });
  const domain = make.filter({ id: fresh('sbd'), input: located, channels: [], type, pred: isNot(col(located.id, 'id'), compilerNull()) });
  const element = make.project({ id: fresh('sbe'), input: domain, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(domain.id, 'id')]] });
  // Only the body's OWN draws are per scope (`keyedBody`): the domain built above is the scope's, not the body's.
  const out = keyedBody(
    (mf, collections) => lowerBody(body, element, domain, { kind: 'elements', elem: root.elem }, { ...ctx, collections }, mf, NO_ALIASES, 'read', false, 'first'),
    domain, sc.key, ctx, fresh, reframe,
  );
  return out && { rel: out.keyed.rel, keyCol: out.keyed.key[0].col, tail: out.tail, collected: out.collected };
}

/**
 * Step 2, CORRELATED: the body lowered over one row of `rel` itself and left correlated to it — no scope key,
 * no decorrelation. Where the reconnect is an EXPRESSION of the host row (an existence test), SQLite runs it as
 * the nested-loop join it is built for: one index seek per host row. Unnesting a dependent join pays where the
 * engine has a set-oriented join to hand it; SQLite's join IS a nested loop, so a correlated body the planner
 * can seek is already the decorrelated plan's best physical form. The decorrelated body (`scopedBody`) is the
 * fallback where the correlated plan cannot sit in a subquery: a `Recursive` (a walk is a CTE; the decorrelator
 * keys it instead).
 */
function correlatedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', contract: RejoinContract = 'forward', from: Rel = rel,
): Tail | null {
  // A body that DRAWS never stays correlated: SQLite may evaluate a subquery (or a part of one) that does not
  // read the host ONCE for every host row, so a draw there would be one pick shared by every scope. It takes
  // the decorrelated form (`scopedBody`), which keys the draw per scope by construction.
  if (nondeterministic(body, ctx.params)) return null;
  // A body that COLLECTS a side effect never stays correlated either: its sites are per host row, and only the
  // decorrelated form keys them into one relation over every scope (`keyedBody`).
  if (someStepDeep(body, ctx.params, (s) => collectsSideEffect(s as IRStep))) return null;
  const tail = lowerBody(body, rel, from, framing, ctx, fresh, labels, order, false, contract, true);
  if (!tail || tail.effects?.length) return null;
  let walk = false;
  forEachRel(tail.rel, (r) => { if (r.kind === 'recursive') walk = true; });
  if (walk) return null;
  // A GROUP BY, ORDER BY or window term that reads the HOST row is one SQLite cannot resolve inside a nested
  // correlated subquery ("no such column", measured: `local(groupCount())` grouping a one-row body by the host's
  // id). Such a body stays decorrelated, where the key is a column of the scoped input.
  // A term reads the host directly, or through the seed row's copy of a host column (which the emitter fuses
  // into the host's own spelling).
  const byId = new Map<string, Rel>();
  forEachRel(tail.rel, (r) => byId.set(r.id, r));
  const outerTerm = (e: Expr): boolean => {
    let hit = false;
    forEachExpr(e, (node) => {
      if (node.kind !== 'col') return;
      const owner = byId.get(node.rel);
      // A LITERAL (a one-arm merge's `bka`, a one-row position) reads no host: only an outer column counts.
      if (!owner || constantOver(owner, node.name, (id) => !byId.has(id), false, false)) hit = true;
    });
    return hit;
  };
  let termReadsHost = false;
  forEachRel(tail.rel, (r) => {
    const terms = r.kind === 'aggregate' ? r.groupBy
      : r.kind === 'sort' ? r.terms.map((term) => term.expr)
        : r.kind === 'window' ? r.specs.flatMap(([, spec]) => [...spec.spec.partitionBy, ...spec.spec.orderBy.map((term) => term.expr)]) : [];
    if (terms.some(outerTerm)) termReadsHost = true;
  });
  return termReadsHost ? null : { ...tail, rel: slicesByKeys(tail.rel, fresh) };
}

/**
 * A SLICE INSIDE A CORRELATED BODY READS ITS POSITION'S KEYS, NOT ITS NUMBER. A `limit`/`range` sorts by the
 * emission-order column, and inside a body that column is a `ROW_NUMBER()` window (`renumber`, a re-source's
 * cross with the seed row) — which SQLite computes over the WHOLE input before the limit, once per host row:
 * `map(V().where(neq('a')).limit(1).values('name'))` numbered every vertex for every host (0.6 s at 1k, 2.5 s at
 * 2k). Sorted by the position's keys instead (`positionKeys`), the slice is a top-n read that stops at its n-th
 * row, and the position the rows carry onward is minted again over those n rows alone, in the same order. Same
 * rows (the number is monotone in its keys), at the reference's cost: `RangeGlobalStep` stops pulling at its
 * high bound. A slice with no count (`skip` alone) keeps every row and keeps its window.
 */
function slicesByKeys(rel: Rel, fresh: Minter): Rel {
  return rewriteRels(rel, (mapped) => {
    if (mapped.kind !== 'limit' || !mapped.count || mapped.input.kind !== 'sort') return mapped;
    const sorted = mapped.input;
    const term = sorted.terms[0];
    if (sorted.terms.length !== 1 || term?.expr.kind !== 'col' || term.expr.rel !== sorted.input.id) return mapped;
    const name = term.expr.name;
    const keyed = positionKeys(sorted.input, name, fresh);
    if (!keyed) return mapped;
    const flip = (key: SortTerm): SortTerm => (term.dir === 'desc' ? { ...key, dir: key.dir === 'asc' ? 'desc' : 'asc' } : key);
    const top = make.limit({
      id: fresh('kl'),
      input: make.sort({ id: fresh('ks'), input: keyed.rel, channels: keyed.rel.channels, type: keyed.rel.type, terms: keyed.keys.map(flip) }),
      channels: keyed.rel.channels, type: keyed.rel.type, count: mapped.count, ...(mapped.offset ? { offset: mapped.offset } : {}),
    });
    const minted = fresh('krn') as string;
    const numbered = rowNumberWindow(top, minted, top.channels, {
      partitionBy: [], orderBy: keyed.keys.map((key) => ({ ...key, expr: substRelId(key.expr, keyed.rel.id, top.id) })),
    }, fresh);
    return make.project({
      id: mapped.id, input: numbered, channels: mapped.channels, type: mapped.type,
      exprs: mapped.type.cols.map((column) => [column.name, col(numbered.id, column.name === name ? minted : column.name)] as const),
    });
  });
}

/**
 * Does a correlated plan, read as `outputs`, COMPUTE only with stored host columns? A correlated read spells
 * the host column it computes with INSIDE the subquery (`spelledOuterColumns`), so a COMPUTED one — a label's
 * `jsonb_array`, a path, a normalized value — would be computed again per inner row, where the decorrelated
 * form reads it once, by name, off the scoped input. Such a plan stays decorrelated (`columnIsStored`). A
 * column the body only CARRIES (a label it never reads) is not spelled, so it costs nothing.
 */
function spellsStored(plan: Rel, outputs: readonly string[], host: Rel): boolean {
  const spelled = spelledOuterColumns(plan, host.id, outputs);
  return !!spelled && [...spelled].every((name) => columnIsStored(host, name));
}

/** A correlated body as an `EXISTS` operand, projecting its FIRST column alone: an `EXISTS` reads no value, so
 *  the body's other columns (labels, path) are not spelled; a column rather than a literal keeps an aggregate
 *  block an aggregate query (the reason `correlatedExists`' probe gives, `exists.ts`). Nor does it read an order,
 *  so a position the body numbered is not computed for it (`positionKeys` drops the window). A body that
 *  re-sources is tested element by element by the physical tier (`src/rel/passes/leading.ts`), so a miss reads
 *  an index, not the graph. */
function existenceProbe(tail: Tail, fresh: Minter): Rel {
  const enc = encounterOf(tail.rel.channels);
  const rows = (enc && positionKeys(tail.rel, enc.col, fresh)?.rel) || tail.rel;
  return probeOver(rows, tail.rel.type.cols[0]!.name, fresh);
}

/** `existenceProbe` over rows already keyed — so a pick's value and its presence test read ONE relation
 *  (`correlatedFirst`), never two copies of it. */
function probeOver(rows: Rel, lead: string, fresh: Minter): Rel {
  return make.project({
    id: fresh('sp'), input: rows, channels: [], type: typeOf(meta('one', 'any', true)),
    exprs: [['one', col(rows.id, lead)]],
  });
}

/**
 * A CHILD BODY AS A CORRELATED `[NOT] EXISTS` over an element SUBJECT row — the existence connector's correlated
 * form (`existence`'s probes), offered to a position that needs the answer as an EXPRESSION rather than a
 * filtered relation: `childPredicate`'s last fallback (`exists.ts`), so any head the fold lowers — `coalesce`,
 * `local`, `union`, `choose` — is a predicate wherever a predicate is asked for. The one consumer that cannot
 * take the relation form is a WALK's `emit`/`until` condition (`walk.ts`): its subject is the recursive
 * self-reference, which a correlated subquery may read (`src/rel/recursive.ts` P2) but a decorrelated join
 * cannot, since a recursive term takes no join to a keyed domain. So this stays correlated, never keyed, and
 * `correlatedBody`'s own refusals (a draw, a nested walk, a host-reading GROUP BY/ORDER/window term) are its
 * refusals — a decline, never a different plan — as is a body whose per-row work is unbounded (below).
 *
 * Only a subject that IS its relation's row (payload `id`, no partial presence): the seed row copies the
 * relation's payload, so a rerooted subject (`select('a')…`) would seed the wrong element.
 */
export function correlatedExistence(
  body: readonly IRStep[], subject: Subject, ctx: ChainCtx, fresh: Minter, labels: AliasMap, negated: boolean,
): Expr | null {
  if (subject.kind !== 'element' || subject.present) return null;
  const { id, rel } = subject;
  const payload = payloadCols(rel);
  if (id.kind !== 'col' || id.rel !== rel.id || id.name !== 'id' || payload.length !== 1 || payload[0]!.name !== 'id') return null;
  const tail = correlatedBody(body, rel, { kind: 'elements', elem: subject.elem }, ctx, fresh, labels, 'free', 'first');
  if (!tail) return null;
  const plan = existenceProbe(tail, fresh);
  if (!spellsStored(plan, ['one'], rel)) return null;
  // BOUNDED WORK PER FRONTIER ROW — inside a WALK's recursive term only. There the subject is the frontier
  // (`self`), and a walk re-reaches a hub once per path to it, so a condition whose per-row work is a hub's
  // neighbourhood is quadratic in the walk (measured on a hub graph at 8× the walk: a failing
  // `until(union(in('created'),out('knows')).has('age',gt(45)))` 26×, `local(in().order().by(k).limit(1))` 52×).
  // Over a FINISHED walk a condition is asked once per distinct traverser state instead (`perState`, `walk.ts`),
  // and outside a walk the host's rows are the host's — the connector's ordinary correlated form. A recursive
  // SELECT holds neither a DISTINCT nor a keyed join (`src/rel/recursive.ts` `BARRIER_IN_TERM`), so in the term
  // the per-row work itself must be bounded: no barrier or rejection may read an unbounded input to its end
  // before the EXISTS can stop — the plan's per-host work fact (`perHostWork`'s `exhausts`, `src/rel/work.ts`),
  // read off the algebra rather than a list of node kinds here. A bounded input (`limit(n)`, the count bound a
  // walk condition's `count().is(P)` takes — `boundConditionCount`, `ir/strategies.ts`) costs O(n). So does an
  // exhausting read of the element's OWN rows (`elementMap()`, `properties()`, a `project()`/`group()` of its
  // values): it is bounded by the element, whatever the graph's shape, so a hub does not multiply it. The question
  // is therefore whether the exhausting work also reads a NEIGHBOURHOOD (some node scans `edges`) or RE-SOURCES
  // (the whole graph per row) — `perHostWork`'s `readsNeighbourhood`/`reSources`, the same per-element-vs-
  // neighbourhood authority `walk.ts` routes `emit` by. The linear form for that rest needs the condition
  // evaluated per distinct element INSIDE the recursion, a substrate SQLite's recursive term does not offer, so it
  // declines, saying why in the user's terms (`hubInWalkTerm`).
  // "Inside the term" is an algebra fact: the subject's row stands on the walk's self-reference in its own FROM
  // tree — the frontier itself, or the row the term PRODUCES from it (the `until` answer the walk lands as a
  // column, `walk.ts` `EXIT`).
  if (!fromTree(rel).some((source) => source.kind === 'self-ref')) return { kind: 'exists', plan, negated };
  const work = perHostWork(plan);
  if (work.exhausts && (work.readsNeighbourhood || work.reSources)) {
    ctx.declines.note(hubInWalkTerm(work.reSources));
    return null;
  }
  return { kind: 'exists', plan, negated };
}

/**
 * WHAT A PER-HOST PICK LANDS ON THE RELATION THAT READS IT: `input` (carrying the host's columns by name) with
 * the body's first row as COLUMNS — each payload column under a fresh name (`cols`) — and its presence over that
 * relation. Every reader of the pick (`map`'s rejoin, a `project().by` field, a landed `by()` value) reads these
 * columns, so the body is searched ONCE per host row however many columns, and its presence, it is read for.
 */
interface Attached {
  readonly rel: Rel;
  readonly cols: ReadonlyMap<string, string>;
  readonly present: 'always' | 'value-nullness' | PresentWhen;
}
/** A pick, attached over `input`; `from` is the host relation the pick was lowered against. */
type Pick = (input: Rel, from: RelId) => Attached;

/**
 * The FIRST row of a CORRELATED body, read per host row — `ORDER BY` the body's emission order then its payload,
 * `LIMIT 1`: the same deterministic pick `firstPerScope` makes per key (`defaultCollation`), made per host row by
 * SQLite's nested loop instead of by a window over every key. SQL has no row-valued scalar subquery and SQLite
 * no LATERAL, so the row comes back in one of two forms:
 *
 * - KEYED (`pickKey`) — wherever every payload column is a function of ONE stored row whose key the body carries
 *   (a vertex/edge rowid, a property row's id for `values(k)`, or the one stored column a lookup reads — an
 *   `id()` after a hop reads `edges.tgt`): ONE correlated scalar returns the winning key, and the payload is read
 *   off it — a rowid `LEFT JOIN` of the stored row, or the lookup over the key itself. One search per host row,
 *   at any width, and its presence is the key's (`k IS NOT NULL`): no `EXISTS`.
 * - SCALAR — anything else: one correlated scalar per payload column, so a COST rule on the body's columns: ONE
 *   column always, TWO — a value and its per-row type tag — only over a FLAT body (no subplan of its own), so the
 *   repeat is one more index seek and never compounds with nesting (`k` columns per level would be `k^depth`
 *   spellings). Anything wider is the decorrelated window's. Its presence, where the lead value may be a NULL, is
 *   the body's `EXISTS` (`probeOver`), asked only where `presence` says a reader needs it.
 */
function correlatedFirst(tail: Tail, names: readonly string[], host: Rel, fresh: Minter, presence = true): Pick | null {
  const payload = names.map((name) => tail.rel.type.cols.find((column) => column.name === name));
  if (!payload.length || payload.some((column) => !column)) return null;
  const lead = payload[0]!;
  const total = exactlyOneRow(tail.rel);
  // A body that reads NOTHING but its seed row (`math('_ + 1')`, `select('a')`, `identity()`, a test of the value)
  // is an expression of the host row: no subquery at all, at any width.
  const inline = seedExpressions(tail.rel, names, host);
  if (inline) {
    const probe = presence && !total && lead.nullable ? existenceProbe(tail, fresh) : null;
    if (probe && !spellsStored(probe, ['one'], host)) return null;
    return scalarPick(payload as ColMeta[], seedValues(inline), probe, total, fresh);
  }
  // The repetition must not COMPOUND: a SCALAR pick spells its body once per column, so a body whose own
  // subplans nest subplans would be `2^depth` spellings (`nestsCorrelatedSubplans`).
  const deep = nestsCorrelatedSubplans(tail.rel);
  // A body of at most one row (a reducer, a record over the one seed row) IS its first row: no sort.
  const single = atMostOneRow(tail.rel);
  // The FIRST row in EMISSION order (`lowerBody`): sorted by the position's own keys where the body numbered
  // it with a window (`positionKeys` — a top-1 sort, no window per host row), else by the position itself; the
  // payload breaks what ties remain, `defaultCollation`'s rule.
  const enc = encounterOf(tail.rel.channels);
  const keyed = !single && enc ? positionKeys(tail.rel, enc.col, fresh) : null;
  const base = keyed?.rel ?? tail.rel;
  const key = pickKey(base, names, keyed?.keys ?? [], fresh, single);
  // A payload that is a function of a key the position already orders by breaks no tie, so it is no term.
  const terms = keyed
    ? [...keyed.keys, ...(key?.ordered ? [] : payloadCols(tail.rel).map((column) => ({ expr: col(base.id, column.name), dir: 'asc' as const })))]
    : defaultCollation(tail.rel);
  // A sort term that is, or is defined by, a subquery may not sort a correlated body: SQLite resolves an ORDER
  // BY term's subquery without the scopes beyond its own query (measured, bun:sqlite 3.51: `SELECT (SELECT
  // (SELECT t.x) v FROM (VALUES (1)) ORDER BY (SELECT t.x) LIMIT 1) FROM t` is "no such column: t.x"), so such a
  // body stays decorrelated. A subquery that only FILTERS the body is not a term and costs nothing here. Only a
  // term that ORDERS anything is asked (`untilKey`): the payload after a row key breaks no tie, so a computed
  // payload (`id()`'s `COALESCE(uid, id)` lookup) behind the scanned element's rowid is never a term.
  const readsSubquery = (ts: readonly SortTerm[]): boolean => ts.some((term) => term.expr.kind !== 'col' ? exprHasSubquery(term.expr)
    : term.expr.rel !== base.id || columnReadsSubquery(base, term.expr.name));
  const sorted = untilKey(base, terms);
  if (!single && readsSubquery(sorted)) return null;
  // A body that is a MERGE of arms in a fixed priority (a `coalesce`, a `union`'s arm-major order): its first
  // row is the first arm's first row where that arm has one, else the next arm's — one seek per arm, never a
  // sort over the merge.
  const arms = single || readsSubquery(terms) ? null : priorityArms(base, terms, fresh);
  if (arms) {
    if (payload.length > 2 || (payload.length > 1 && deep)) return null;
    const firstOf = (arm: PriorityArm): Rel => (atMostOneRow(arm.rel) ? arm.rel : make.limit({
      id: fresh('cl'), input: make.sort({ id: fresh('cs'), input: arm.rel, channels: arm.rel.channels, type: arm.rel.type, terms: untilKey(arm.rel, arm.terms) }),
      channels: arm.rel.channels, type: arm.rel.type, count: compilerInt(1),
    }));
    const firsts = arms.map(firstOf);
    const exprs = new Map<string, Expr>();
    for (const column of payload as ColMeta[]) {
      const plans = firsts.map((first) => make.project({ id: fresh('cv'), input: first, channels: [], type: typeOf({ ...column, nullable: true }), exprs: [[column.name, col(first.id, column.name)]] }));
      if (!plans.every((plan) => spellsStored(plan, [column.name], host))) return null;
      const whens = plans.slice(0, -1).map((plan, i) => [{ kind: 'exists', plan: arms[i]!.rel, negated: false } as Expr, { kind: 'scalar', plan } as Expr] as const);
      const last: Expr = { kind: 'scalar', plan: plans[plans.length - 1]! };
      exprs.set(column.name, whens.length ? { kind: 'case', whens, else: last } : last);
    }
    const probe = presence && !total && lead.nullable ? probeOver(base, lead.name, fresh) : null;
    if (probe && !spellsStored(probe, ['one'], host)) return null;
    return scalarPick(payload as ColMeta[], exprs, probe, total, fresh);
  }
  // A re-source's first row stops at its first hit: the physical tier reads its leading element first
  // (`src/rel/passes/leading.ts`), for this pick and its presence test alike.
  const first = single ? tail.rel : make.limit({
    id: fresh('cl'), input: make.sort({ id: fresh('cs'), input: base, channels: base.channels, type: base.type, terms: sorted }),
    channels: base.channels, type: base.type, count: compilerInt(1),
  });
  // The keyed form where the scalar form would search twice — a second column, or a presence `EXISTS` beside the
  // value. One column read once stays one scalar: a key and a read of the payload off it would be one more step.
  if (key && (payload.length > 1 || (presence && !total && lead.nullable))) {
    const picked = keyedPick(key, key.rows ?? first, names, payload as ColMeta[], host, total, fresh);
    if (picked) return picked;
  }
  if (payload.length > 2 || (payload.length > 1 && deep)) return null;
  const plans = (payload as ColMeta[]).map((column) => [column.name,
    make.project({ id: fresh('cv'), input: first, channels: [], type: typeOf({ ...column, nullable: true }), exprs: [[column.name, col(first.id, column.name)]] })] as const);
  if (!plans.every(([name, plan]) => spellsStored(plan, [name], host))) return null;
  const probeRows = single ? (enc && positionKeys(tail.rel, enc.col, fresh)?.rel) || tail.rel : base;
  const probe = presence && !total && lead.nullable ? probeOver(probeRows, lead.name, fresh) : null;
  if (probe && !spellsStored(probe, ['one'], host)) return null;
  return scalarPick(payload as ColMeta[], new Map(plans.map(([name, plan]) => [name, { kind: 'scalar', plan } as Expr])), probe, total, fresh);
}

/**
 * The SCALAR pick: each payload column its own expression over the host, projected beside the host's columns.
 * The columns move to `input` as ONE substitution, so two columns reading one first-row relation still read ONE
 * relation, not two copies under one id. The presence test is a FRESH copy (`freshCopy`) — its own relation,
 * never a second spelling of the value's under the same ids.
 */
function scalarPick(payload: readonly ColMeta[], exprs: ReadonlyMap<string, Expr>, probe: Rel | null, total: boolean, fresh: Minter): Pick {
  return (input, from) => {
    const bundle: Expr = { kind: 'call', fn: 'pick', args: payload.map((column) => exprs.get(column.name)!) };
    const moved = from === input.id ? bundle : substRelId(bundle, from, input.id);
    const values = (moved as Extract<Expr, { kind: 'call' }>).args;
    const named = new Map(payload.map((column) => [column.name, fresh('smv') as string]));
    const rel = make.project({
      id: fresh('smp'), input, channels: input.channels,
      type: typeOf(...input.type.cols, ...payload.map((column) => ({ ...column, name: named.get(column.name)!, nullable: true }))),
      exprs: [...input.type.cols.map((column) => [column.name, col(input.id, column.name)] as const), ...payload.map((column, i) => [named.get(column.name)!, values[i]!] as const)],
    });
    if (total) return { rel, cols: named, present: 'always' };
    if (!probe) return { rel, cols: named, present: 'value-nullness' };
    const exists: Expr = substRelId({ kind: 'exists', plan: probe, negated: false }, from, rel.id);
    return { rel, cols: named, present: { when: freshCopy(exists, mintOf(fresh)) ?? exists, orValue: true } };
  };
}

/**
 * WHAT THE PAYLOAD IS A FUNCTION OF (`columnLineage`): a column of `rows` — the KEY — that determines every payload
 * column, so a pick may return the key alone and compute the payload over it:
 *
 * - BY ROWID (`stored`): every payload column reads only ONE stored row (a property row for `values(k)`, a vertex
 *   or an edge), and the key is that row's rowid — the payload is read back by a rowid join;
 * - BY VALUE: the payload, with every occurrence of the key's own lineage abstracted out, reads nothing else — an
 *   `id()` after a hop is a lookup over `edges.tgt`, after a `both()` over the direction's `CASE` of `tgt`/`src`,
 *   and the hop's position already orders by exactly that.
 *
 * Its payload is spelled over a placeholder relation (`at`): `col(at, 'k')` for the key, `col(at, c)` for a stored
 * column `c`'s fresh name. `ordered`: the key is one of the position's own sort terms, so the payload breaks no tie
 * after it. `null` where no key determines the payload (it reads two rows, or an outer column), where the payload
 * draws, or where the key may be NULL (its presence would be wrong).
 *
 * A body of at most ONE row (`threads`) whose payload reads one stored row but carries no key for it — a min/max
 * reducer's winner, an arg-extremum Aggregate over a property read (`reducer.ts` `argExtremum`) — is rebuilt to
 * carry that row's rowid (`threadingRowKey`, `src/rel/copies.ts`), and the pick searches the rebuilt body (`rows`):
 * the winner is ONE key per host, its value and tag read back off the stored row, where one correlated scalar per
 * column re-ran the aggregate.
 */
interface PickKey {
  readonly key: string;
  readonly keyMeta: ColMeta;
  readonly at: RelId;
  /** The stored row read back by rowid: the scan, and each stored column the payload reads → its fresh name. */
  readonly stored: { readonly leaf: Rel; readonly cols: ReadonlyMap<string, string> } | null;
  readonly payload: ReadonlyMap<string, Expr>;
  readonly ordered: boolean;
  /** The body rebuilt to carry the key (`threadingRowKey`), where the body did not: the search reads THIS. */
  readonly rows?: Rel;
}

function pickKey(rows: Rel, names: readonly string[], keys: readonly SortTerm[], fresh: Minter, threads = false): PickKey | null {
  const leaves = new Map<RelId, Rel>();
  const defined = new Map<string, Expr>();
  for (const name of names) {
    const lineage = columnLineage(rows, name, leaves, true);
    if (!lineage || exprDraws(lineage)) return null;
    // Only the body's own rows: an outer column (the host's) is not a function of the key.
    for (const id of freeIds(lineage)) if (!leaves.has(id)) return null;
    defined.set(name, lineage);
  }
  const readsLeaf = (e: Expr): boolean => [...leaves.keys()].some((id) => deepColsRead(e, id).size > 0);
  const sortCols = new Set(keys.flatMap((term) => (term.expr.kind === 'col' && term.expr.rel === rows.id ? [term.expr.name] : [])));
  const candidates = [...rows.type.cols].sort((a, b) => Number(sortCols.has(b.name)) - Number(sortCols.has(a.name)));
  const at = fresh('skh');
  for (const column of candidates) {
    const lineage = columnLineage(rows, column.name, leaves, true);
    if (!lineage || !readsLeaf(lineage) || [...freeIds(lineage)].some((id) => !leaves.has(id)) || !nonNull(lineage, leaves)) continue;
    const ordered = sortCols.has(column.name);
    // BY ROWID: the key is a stored row's rowid and the payload reads that row alone.
    const leaf = lineage.kind === 'col' ? leaves.get(lineage.rel) : undefined;
    if (leaf?.kind === 'scan' && lineage.kind === 'col' && lineage.name === 'id' && columnIsRowKey(leaf, 'id')) {
      const read = new Set<string>(['id']);
      let other = false;
      for (const e of defined.values()) for (const id of leaves.keys()) for (const name of deepColsRead(e, id)) {
        if (id === leaf.id) read.add(name);
        else other = true;
      }
      if (!other) {
        const cols = new Map([...read].map((name) => [name, fresh('skc') as string]));
        const payload = new Map([...defined].map(([name, e]) => [name, mapColsDeep(e, leaf.id, (c) => col(at, cols.get(c)!))] as const));
        return { key: column.name, keyMeta: { ...column, type: 'int' }, at, stored: { leaf, cols }, payload, ordered };
      }
    }
    // BY VALUE: the payload abstracted over the key's lineage reads no row of the body.
    const payload = new Map([...defined].map(([name, e]) => [name, abstractOver(e, lineage, col(at, 'k'))] as const));
    if ([...payload.values()].some(readsLeaf)) continue;
    return { key: column.name, keyMeta: column, at, stored: null, payload, ordered };
  }
  const [leaf, ...more] = leaves.values();
  const threaded = threads && leaf && !more.length ? threadingRowKey(rows, leaf, fresh('pkr') as string, fresh) : null;
  const key = threaded ? pickKey(threaded, names, keys, fresh) : null;
  return key && threaded ? { ...key, rows: threaded } : null;
}

/** `e` with every sub-expression structurally equal to `target` — in its correlated subplans too — replaced. */
function abstractOver(e: Expr, target: Expr, placeholder: Expr): Expr {
  const spelled = JSON.stringify(target);
  const memo = new Map<Rel, Rel>();
  const go = (x: Expr): Expr => (JSON.stringify(x) === spelled ? placeholder
    : mapExprChildren(x, go, (plan) => rewriteRels(plan, (mapped) => mapRelExprs(mapped, go), memo)));
  return go(e);
}

/** Is a lineage NEVER NULL: a leaf column declared not null, or an expression of such that cannot yield one. */
function nonNull(e: Expr, leaves: ReadonlyMap<RelId, Rel>): boolean {
  switch (e.kind) {
    case 'col': return leaves.get(e.rel)?.type.cols.find((column) => column.name === e.name)?.nullable === false;
    case 'lit': return e.value !== null;
    case 'case': return !!e.else && nonNull(e.else, leaves) && e.whens.every(([, then]) => nonNull(then, leaves));
    case 'call': return e.fn.toUpperCase() === 'COALESCE' && e.args.some((arg) => nonNull(arg, leaves));
    default: return false;
  }
}

/** The relation ids an expression reads that it does not define — its own column reads, and its subplans' free ids. */
function freeIds(e: Expr): Set<RelId> {
  const ids = new Set<RelId>();
  forEachExpr(e, (node) => {
    if (node.kind === 'col') ids.add(node.rel);
    for (const plan of exprRels(node)) for (const id of freeRelIds(plan)) ids.add(id as RelId);
  });
  return ids;
}

/**
 * The KEYED pick: `k = (SELECT key FROM <first row> LIMIT 1)` once per host row, then the payload over `k`. With
 * the row's rowid as the key, the stored row is read back by `LEFT JOIN <table> p ON p.id = (k's subquery)`: an
 * outer-only right-hand side SQLite evaluates once per outer row to drive the rowid seek, and a join whose row
 * nothing reads is dropped (`dropUnreadJoins`, `src/rel/passes/prune.ts`), so an unread value is never searched
 * for — the scalar form's pruning, kept. Otherwise the payload is computed over the key itself. Lossless where a
 * packed row is not (a JSON pack returns a REAL with 15 digits); the presence is the key's.
 */
function keyedPick(key: PickKey, first: Rel, names: readonly string[], payload: readonly ColMeta[], host: Rel, total: boolean, fresh: Minter): Pick | null {
  const searched = make.project({ id: fresh('ck'), input: first, channels: [], type: typeOf({ ...key.keyMeta, name: 'k', nullable: true }), exprs: [['k', col(first.id, key.key)]] });
  // A body rebuilt to carry its key (`key.rows`) searches for the key ALONE: the winner's other columns are read
  // back off the stored row, so the copies the rebuilt aggregate still holds are dropped from the search.
  const plan = key.rows ? prune(searched, ['k']) : searched;
  if (!spellsStored(plan, ['k'], host)) return null;
  // The payload's own subplans are fresh copies: the body's lookups are no longer read inside the pick, and two
  // relations never share an id.
  const exprs = new Map<string, Expr>();
  for (const name of names) {
    const copied = freshCopy(key.payload.get(name)!, mintOf(fresh));
    if (!copied) return null;
    exprs.set(name, copied);
  }
  // A payload that may ABORT (a `math()` over a non-number raises) is computed only over a picked row: the
  // body computed it only for the row it picked, and a host with none reads NULLs, which the value would
  // otherwise raise on — an error where the reference simply has no value.
  const guard = (value: Expr, picked: Expr): Expr => (exprMayAbort(value) ? { kind: 'case', whens: [[isNot(picked, compilerNull()), value]] } : value);
  const { stored } = key;
  return (input, from) => {
    const search: Expr = substRelId({ kind: 'scalar', plan }, from, input.id);
    let over: Rel;
    let picked: string;
    if (stored) {
      const row = brandRel({ ...stored.leaf, id: fresh('skr'), alias: fresh('rsk') as string } as Rel);
      const cols = make.project({
        id: fresh('skq'), input: row, channels: [],
        type: typeOf(...[...stored.cols].map(([column, name]) => ({ ...stored.leaf.type.cols.find((c) => c.name === column)!, name, nullable: true }))),
        exprs: [...stored.cols].map(([column, name]) => [name, col(row.id, column)] as const),
      });
      over = make.join({
        id: fresh('skj'), left: input, right: cols, join: 'left', channels: input.channels,
        type: typeOf(...input.type.cols, ...cols.type.cols), on: eq(col(cols.id, stored.cols.get('id')!), search),
      });
      picked = stored.cols.get('id')!;
    } else {
      picked = fresh('smk') as string;
      over = make.project({
        id: fresh('skp'), input, channels: input.channels, type: typeOf(...input.type.cols, { ...key.keyMeta, name: picked, nullable: true }),
        exprs: [...input.type.cols.map((column) => [column.name, col(input.id, column.name)] as const), [picked, search] as const],
      });
    }
    const named = new Map(names.map((name) => [name, fresh('smv') as string]));
    const rel = make.project({
      id: fresh('skv'), input: over, channels: over.channels,
      type: typeOf(...over.type.cols, ...payload.map((column) => ({ ...column, name: named.get(column.name)!, nullable: true }))),
      exprs: [...over.type.cols.map((column) => [column.name, col(over.id, column.name)] as const),
        ...names.map((name) => [named.get(name)!, guard(substRelId(exprs.get(name)!, key.at, over.id, (column) => (stored ? column : picked)), col(over.id, picked))] as const)],
    });
    return { rel, cols: named, present: total ? 'always' : { when: isNot(col(rel.id, picked), compilerNull()) } };
  };
}

/** A `fresh` minter as `freshCopy`'s pair: one sequence for ids and scan aliases. */
const mintOf = (fresh: Minter): { readonly id: (hint: string) => RelId; readonly alias: (hint: string) => string } =>
  ({ id: (hint) => fresh(hint), alias: (hint) => fresh(hint) as string });

/**
 * A correlated body that is a run of `Project`s and `Filter`s over its SEED ROW alone (`seedRow`: one constant
 * row whose columns read the host's) — each named column as an expression of the HOST row, and the body's
 * filters as one predicate over it (absent: the body always has its row); or `null` where the body reads
 * anything else (a table, a window, an aggregate, the seed's own constant). The dependent join over one row with
 * no source of its own is a projection (Neumann/Kemper 2015's base case: a dependent join whose right side is
 * free of tables is a map over the left).
 */
interface SeedExpressions { readonly values: ReadonlyMap<string, Expr>; readonly pred?: Expr }

/** `seedExpressions` as each column's value alone — `NULL` where the body's filters drop its row. A filter that
 *  only asks the column itself to be present (`x IS NOT NULL` over a value `x`) is that column already. */
function seedValues(inline: SeedExpressions): ReadonlyMap<string, Expr> {
  const same = (a: Expr, b: Expr): boolean => JSON.stringify(a) === JSON.stringify(b);
  return new Map([...inline.values].map(([name, e]) => {
    const kept = inline.pred ? conjuncts(inline.pred).filter((p) => !(p.kind === 'binary' && p.op === 'is not'
      && p.right.kind === 'lit' && p.right.value === null && same(p.left, e))) : [];
    const guard = conjoin(kept);
    return [name, guard ? { kind: 'case', whens: [[guard, e]] } as Expr : e] as const;
  }));
}

function seedExpressions(rel: Rel, names: readonly string[], host: Rel): SeedExpressions | null {
  const preds: Expr[] = [];
  let failed = false;
  // `name` of `r`, spelled over the host row.
  // Each (relation, column) resolved ONCE; a COMPUTED one asked for a second time — by a filter and the payload,
  // or by two filters — would be spelled twice, so the body is not inlined (see `over`).
  const resolved = new Map<string, Expr | null>();
  const resolve = (r: Rel, name: string): Expr | null => {
    if (r.kind === 'filter' || oneRowKeeps(r)) return resolve((r as Extract<Rel, { kind: 'filter' }>).input, name);
    if (r.kind !== 'project') return null;
    const key = `${r.id}\u0000${name}`;
    const done = resolved.get(key);
    if (done !== undefined) {
      if (done && done.kind !== 'col' && done.kind !== 'lit') failed = true;
      return done;
    }
    const e = r.exprs.find(([n]) => n === name)?.[1];
    const out = e ? over(r, e) : null;
    resolved.set(key, out);
    return out;
  };
  // An expression of project/filter `r`, its reads of `r.input` resolved down to the host.
  const over = (r: Extract<Rel, { kind: 'project' | 'filter' }>, e: Expr): Expr | null => {
    const input = r.input;
    // The SEED: a projection over one constant row whose expressions read the host (or are constants).
    if (r.kind === 'project' && input.kind === 'values') {
      let readsUnit = false;
      forEachExpr(e, (node) => { if (node.kind === 'col' && node.rel === input.id) readsUnit = true; });
      return readsUnit || input.rows.length !== 1 ? null : e;
    }
    if (input.kind !== 'project' && input.kind !== 'filter' && !oneRowKeeps(input)) return null;
    if (exprHasSubquery(e)) {
      // A correlated subplan reads the body's relations BY NAME, which no longer exist once they are inlined;
      // one that reads only the host (or an enclosing scope) stays as it is.
      let readsBody = false;
      forEachExpr(e, (node) => { for (const sub of exprRels(node)) if ([...freeRelIds(sub)].some((id) => !isOuterOf(id as RelId, rel))) readsBody = true; });
      if (readsBody) return null;
    }
    // INLINED ONCE, never re-spelled: a computed column read more than once here would be computed again at
    // each read (an expression referenced N times is computed once — root CLAUDE.md), and down a value run
    // (`toUpper().toLower()…`) that doubles per step. Such a body stays a subquery, which names the column.
    const reads = new Map<string, number>();
    forEachExpr(e, (node) => { if (node.kind === 'col' && node.rel === input.id) reads.set(node.name, (reads.get(node.name) ?? 0) + 1); });
    return rewriteExpr(e, (node) => {
      if (failed || node.kind !== 'col' || node.rel !== input.id) return node;
      const resolved = resolve(input, node.name);
      if (!resolved) { failed = true; return node; }
      if ((reads.get(node.name) ?? 0) > 1 && resolved.kind !== 'col' && resolved.kind !== 'lit') { failed = true; return node; }
      return resolved;
    });
  };
  // The filters on the way down, each over the host.
  for (let r: Rel = rel; ;) {
    if (r.kind === 'filter') {
      // A PRESENCE test of one column (`x IS NOT NULL`, a productive `by()`'s) is not a second use of it: it is
      // the value itself, which `seedValues` folds back into the value — so what it resolves is not remembered.
      const presence = r.pred.kind === 'binary' && r.pred.op === 'is not' && r.pred.left.kind === 'col'
        && r.pred.right.kind === 'lit' && r.pred.right.value === null;
      const before = presence ? new Map(resolved) : null;
      const p = over(r, r.pred);
      if (before) { resolved.clear(); for (const [k, v] of before) resolved.set(k, v); }
      if (!p || failed) return null;
      preds.push(p);
      r = r.input;
      continue;
    }
    if (r.kind === 'project') {
      if (r.input.kind === 'values') break;
      r = r.input;
      continue;
    }
    if (oneRowKeeps(r)) { r = (r as Extract<Rel, { kind: 'sort' }>).input; continue; }
    return null;
  }
  const out = new Map<string, Expr>();
  for (const name of names) {
    const e = resolve(rel, name);
    if (!e || failed) return null;
    let hostOnly = true;
    forEachExpr(e, (node) => { if (node.kind === 'col' && node.rel !== host.id && !exprRels(node).length && !isOuterOf(node.rel, rel)) hostOnly = false; });
    if (!hostOnly) return null;
    out.set(name, e);
  }
  const pred = conjoin(preds);
  return { values: out, ...(pred ? { pred } : {}) };
}

/** An operator that keeps a ONE-row input as it is: a sort, or a limit of at least one row from the start. */
const oneRowKeeps = (r: Rel): boolean =>
  r.kind === 'sort' || r.kind === 'distinct'
  || (r.kind === 'limit' && (!r.count || (r.count.kind === 'lit' && typeof r.count.value === 'number' && r.count.value >= 1))
    && (!r.offset || (r.offset.kind === 'lit' && r.offset.value === 0)));

/** Is `id` a relation NOT defined inside `rel` (so a column of it is an outer read the inlined form keeps)? */
const isOuterOf = (id: RelId, rel: Rel): boolean => {
  let inside = false;
  forEachRel(rel, (r) => { if (r.id === id) inside = true; });
  return !inside;
};

/** A collation as far as it ORDERS anything: a term repeated is dropped, and the terms after a row KEY of `rows`
 *  (`columnIsRowKey` — a scanned rowid) are dropped, since no two rows tie on it. */
function untilKey(rows: Rel, terms: readonly SortTerm[]): readonly SortTerm[] {
  const out: SortTerm[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (term.expr.kind === 'col') {
      const spelled = `${term.expr.rel}.${term.expr.name}`;
      if (seen.has(spelled)) continue;
      seen.add(spelled);
      // A term the same on every row (a constant, or the correlated host's own column) orders nothing — and an
      // outer column as an ORDER BY term of a nested scalar subquery is one SQLite cannot resolve ("no such
      // column", measured: `(SELECT rn.id FROM (VALUES (1)) ORDER BY rn.id LIMIT 1)` two levels down).
      if (term.expr.rel === rows.id && constantOver(rows, term.expr.name, undefined, true)) continue;
    }
    out.push(term);
    if (term.expr.kind === 'col' && term.expr.rel === rows.id && columnIsRowKey(rows, term.expr.name)) break;
  }
  return out;
}

/** Is column `name` of `rows` the SAME on every row — defined, through copying projections, filters, sorts and
 *  limits, by a literal or by a column of a relation outside `rows` (the correlated host)? `outer` answers that
 *  last question; a caller that already holds the relations of a tree passes it, so a term asked of every node of
 *  a long chain is not a walk of the chain per step (measured: quadratic in an unrolled body's length).
 *  `computed` also follows a COMPUTED definition and a join's sides — the question a sort term asks (`untilKey`);
 *  without it only a copied column or a literal counts, the narrower question of whether a term READS the host.
 *  `literal` false drops the literal case: then the answer is "is it a copy of an OUTER column" alone. */
function constantOver(rows: Rel, name: string, outer?: (id: RelId) => boolean, computed = false, literal = true): boolean {
  let inside: Set<string> | undefined;
  const isOuter = outer ?? ((id: RelId): boolean => {
    if (!inside) { const ids = new Set<string>(); forEachRel(rows, (x) => ids.add(x.id)); inside = ids; }
    return !inside.has(id);
  });
  let r: Rel = rows;
  let column = name;
  for (;;) {
    if (r.kind === 'filter' || r.kind === 'sort' || r.kind === 'limit' || r.kind === 'distinct' || r.kind === 'materialize') { r = r.input; continue; }
    if (r.kind === 'window' && !r.specs.some(([minted]) => minted === column)) { r = r.input; continue; }
    // Through a join, the side the column comes from (positionally, as the join's own type lists them) — the
    // body's seed row joined to the relation it starts carries the host's columns on its side.
    if (computed && r.kind === 'join' && r.join !== 'semi' && r.join !== 'anti') {
      // A LEFT join's right side is NULL on an unmatched row: not the same on every row.
      const from = joinSide(r, column);
      if (!from || from.nullable) return false;
      column = from.name;
      r = from.side;
      continue;
    }
    if (r.kind !== 'project') return false;
    const e = r.exprs.find(([n]) => n === column)?.[1];
    if (!e) return false;
    if (e.kind === 'lit') return literal;
    // A COMPUTED term of columns constant here (a selected path label's id, `CAST(json_extract(a0, …) AS INT)`
    // over the host's carried `a0`) is as constant per host row as they are — no subquery, aggregate, window or
    // draw in it. (Measured: such a term left in a correlated first-row pick's ORDER BY is "no such column".)
    if (e.kind !== 'col') {
      if (!computed) return false;
      const input = r.input;
      let constant = true;
      forEachExpr(e, (node) => {
        if (!constant) return;
        if (exprRels(node).length || node.kind === 'agg' || node.kind === 'window-expr'
          || (node.kind === 'call' && node.fn.toLowerCase().startsWith('random'))) constant = false;
        else if (node.kind === 'col' && !isOuter(node.rel) && !(node.rel === input.id && constantOver(input, node.name, isOuter, true))) constant = false;
      });
      return constant;
    }
    if (isOuter(e.rel)) return true;
    if (e.rel !== r.input.id) return false;
    column = e.name;
    r = r.input;
  }
}

/** One arm of a priority merge, re-expressed with the merge's own columns, and its order within the arm. */
interface PriorityArm { readonly rel: Rel; readonly terms: readonly SortTerm[] }

/**
 * A FIRST-ROW SORT OVER A MERGE OF ARMS IN A FIXED PRIORITY, split per arm — or `null`. `rows` is a run of
 * column-copying `Project`s over a `UNION ALL`, and `terms` LEAD with columns every arm holds as a constant (the
 * merge's arm index, `mergeArms`' `bka`, under its parent position), in strictly increasing order arm by arm:
 * then the sort orders every row of an earlier arm before every row of a later one, and the first row is the
 * first NON-EMPTY arm's first row under the remaining terms. Each arm is returned as `rows` rebuilt over that arm
 * alone, so the remaining terms read the same column names.
 */
function priorityArms(rows: Rel, terms: readonly SortTerm[], fresh: Minter): readonly PriorityArm[] | null {
  const chain: Extract<Rel, { kind: 'project' }>[] = [];
  let at: Rel = rows;
  for (; at.kind === 'project'; at = at.input) {
    const input: Rel = at.input;
    if (at.exprs.some(([, e]) => e.kind !== 'lit' && !(e.kind === 'col' && e.rel === input.id))) return null;
    chain.push(at);
  }
  if (at.kind !== 'union' || !at.all || at.inputs.length < 2 || at.inputs.length > 4) return null;
  const union = at;
  // The value of `rows`' column `name` in arm `i`, where it is a constant there: its lineage (`columnLineage`)
  // down the copying chain to a literal or the union column it copies, then that column's down arm `i`.
  const numberOf = (e: Expr | null): number | null => (e?.kind === 'lit' && typeof e.value === 'number' ? e.value : null);
  const constantIn = (named: string, i: number): number | null => {
    const above = columnLineage(rows, named, new Map());
    if (above?.kind !== 'col' || above.rel !== union.id) return numberOf(above);
    const pos = union.type.cols.findIndex((c) => c.name === above.name);
    const arm = union.inputs[i]!;
    return pos < 0 ? null : numberOf(columnLineage(arm, arm.type.cols[pos]!.name, new Map()));
  };
  // The leading terms constant in every arm, and the arms' order under them.
  let lead = 0;
  const tuples: number[][] = union.inputs.map(() => []);
  for (const term of terms) {
    if (term.expr.kind !== 'col' || term.expr.rel !== rows.id) break;
    const values = union.inputs.map((_, i) => constantIn((term.expr as Extract<Expr, { kind: 'col' }>).name, i));
    if (values.some((v) => v === null)) break;
    values.forEach((v, i) => tuples[i]!.push(term.dir === 'desc' ? -v! : v!));
    lead++;
  }
  if (!lead) return null;
  const before = (a: readonly number[], b: readonly number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
  };
  if (tuples.some((tuple, i) => i > 0 && !before(tuples[i - 1]!, tuple))) return null;
  // Each column `rows` needs (the payload, the remaining terms) resolved down the copying chain: a literal, or
  // the union column it copies.
  const source = (named: string): Expr | number => {
    let column = named;
    for (const p of chain) {
      const e = p.exprs.find(([n]) => n === column)?.[1];
      if (!e || e.kind === 'lit') return e ?? -1;
      column = (e as Extract<Expr, { kind: 'col' }>).name;
    }
    return union.type.cols.findIndex((c) => c.name === column);
  };
  const rest = terms.slice(lead);
  const needed = [...new Set([...payloadCols(rows).map((column) => column.name),
    ...rest.map((term) => (term.expr.kind === 'col' ? term.expr.name : ''))])];
  if (rest.some((term) => term.expr.kind !== 'col' || term.expr.rel !== rows.id)) return null;
  const sources = needed.map(source);
  if (sources.some((s) => s === -1)) return null;
  return union.inputs.map((arm) => {
    // ONE projection over the arm: only the needed columns, under `rows`' names.
    const rel = make.project({
      id: fresh('pa'), input: arm, channels: [],
      type: typeOf(...needed.map((name) => rows.type.cols.find((column) => column.name === name)!)),
      exprs: needed.map((name, i) => {
        const s = sources[i]!;
        return [name, typeof s === 'number' ? col(arm.id, arm.type.cols[s]!.name) : s] as const;
      }),
    });
    const own = rel.id;
    const armTerms = rest.map((term) => ({ ...term, expr: substRelId(term.expr, rows.id, own) }));
    // The arm's own position, where it leads what is left, sorted by ITS keys too (`positionKeys`): a number
    // the arm minted with a window is otherwise one window per host row.
    const next = armTerms[0];
    const keyed = next && next.dir === 'asc' && next.expr.kind === 'col' ? positionKeys(rel, next.expr.name, fresh) : null;
    return keyed
      ? { rel: keyed.rel, terms: [...keyed.keys, ...armTerms.slice(1).map((term) => ({ ...term, expr: substRelId(term.expr, own, keyed.rel.id) }))] }
      : { rel, terms: armTerms };
  });
}

/** The scoped input reprojected to the input's own columns (the key shed). */
function unscoped(rows: Rel, rel: Rel, fresh: Minter): Rel {
  return make.project({
    id: fresh('sx'), input: rows, channels: rel.channels, type: rel.type,
    exprs: rel.type.cols.map((column) => [column.name, col(rows.id, column.name)] as const),
  });
}

/** The FIRST row per scope of a keyed body, its payload renamed so it can sit beside the host's columns:
 *  `ROW_NUMBER() … = 1` partitioned by the key (`perOriginWindow`, Calcite's per-domain top-N), ordered by the
 *  body's own emission order, then its payload — one deterministic member of what the reference allows. */
function firstPerScope(
  body: ScopedBody, names: readonly string[], fresh: Minter,
): KeyedRows {
  return keyedRows(body, names, fresh, true);
}

/** A keyed body's rows (`first`: only the first per scope), their named columns renamed so they can sit
 *  beside the host's — the right side of every reconnect. `key` is the first of `keys`, the whole key of a
 *  body keyed by the scope's own row key. */
interface KeyedRows { readonly rel: Rel; readonly key: string; readonly keys: readonly string[]; readonly renamed: ReadonlyMap<string, string> }

function keyedRows(body: ScopedBody, names: readonly string[], fresh: Minter, firstOnly: boolean): KeyedRows {
  return rowsKeyedBy(body.rel, body.tail.rel, [body.keyCol], names, fresh, firstOnly);
}

/** `keyedRows` over a key of one or more columns of `rel` (the decorrelation of `correlated`). The first row
 *  of a body that yields AT MOST ONE row per scope (`atMostOneRow` — a reducer, a `limit(1)`) is the row
 *  itself: no window. */
function rowsKeyedBy(
  rel: Rel, correlated: Rel, keyCols: readonly string[], names: readonly string[], fresh: Minter, firstOnly: boolean,
): KeyedRows {
  const first = firstOnly
    ? firstRow(rel, defaultCollation(rel), fresh, { by: keyCols.map((name) => col(rel.id, name)), perScope: correlated })
    : rel;
  const renamed = new Map(names.map((name) => [name, fresh('sf') as string]));
  const keys = keyCols.map(() => fresh('sfk') as string);
  const typed = (name: string): ColMeta => ({ ...first.type.cols.find((column) => column.name === name)!, nullable: true });
  const projected = make.project({
    id: fresh('sfp'), input: first, channels: [],
    type: typeOf(...keyCols.map((name, i) => ({ ...typed(name), name: keys[i]! })), ...names.map((name) => ({ ...typed(name), name: renamed.get(name)! }))),
    exprs: [...keyCols.map((name, i) => [keys[i]!, col(first.id, name)] as const), ...names.map((name) => [renamed.get(name)!, col(first.id, name)] as const)],
  });
  return { rel: projected, key: keys[0]!, keys, renamed };
}

/** The ONE nested-traversal argument of a single-body host, or `null`. */
function singleBody(step: IRStep, ctx: ChainCtx): readonly IRStep[] | null {
  if (step.modulators?.length || step.optionArms || step.args.length !== 1) return null;
  const nested = step.args[0]!.value;
  if (!isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params, ctx.sideEffects);
  return body?.length ? body : null;
}

interface HostSite {
  readonly step: IRStep;
  readonly rel: Rel;
  readonly framing: RelFraming;
  readonly steps: readonly IRStep[];
  readonly at: number;
  readonly bulked: boolean;
  readonly ctx: ChainCtx;
  readonly fresh: Minter;
  readonly labels: AliasMap;
}

type Connector = (site: HostSite) => Tail | null;

/**
 * `where(b)` / `filter(b)` — a SEMI-join on the scope key; `not(b)` the ANTI-join. `TraversalFilterStep` keeps a
 * traverser iff its child has a next (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TraversalFilterStep.java`),
 * `NotStep` iff it has none (`…/step/filter/NotStep.java`). A `where()` whose body names scope variables is a
 * `WhereTraversalStep`, rewritten before lowering into the select/`where(P.eq)` forms this lowers like any
 * other body (`rewriteWhereVariables`, `ir/strategies.ts`). The traverser itself is untouched — its channels,
 * its path, its labels are the host's (a label bound in the body does not escape a filter).
 */
const existence = (negated: boolean): Connector => (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const connective = step.name === 'and' || step.name === 'or';
  const bodies = connective
    ? step.args.every((arg) => isNested(arg.value)) && !step.modulators?.length && !step.optionArms && step.args.length
      ? step.args.map((arg) => bodyOf((arg.value as { nested: unknown }).nested, ctx.params, ctx.sideEffects))
      : null
    : [singleBody(step, ctx)];
  if (!bodies || bodies.some((b) => !b?.length)) return null;
  // (A WRITE in a filter body never reaches here: the program's write summary declines it, naming the write
  // and the filter — `ProgramWrites.filterWrite`, read by `lowerChain`.)
  // Every body correlated: the semi/anti-join is an `EXISTS` over the body itself, read against the host row
  // (the dependent join kept as such — `correlatedBody`); `and`'s bodies are a conjunction of them.
  const correlated = (bodies as (readonly IRStep[])[]).map((body) => correlatedBody(body, rel, framing, ctx, fresh, labels, 'free', 'first'));
  const probes = correlated.map((tail) => tail && existenceProbe(tail, fresh));
  if (probes.every((probe) => probe && spellsStored(probe, ['one'], rel))) {
    // `and` a conjunction of the bodies' EXISTS, `or` a disjunction (`OrStep`: some child has a next).
    // Non-empty: `and()`/`or()` always carry at least one body.
    const pred = (step.name === 'or' ? disjoin : conjoin)((probes as Rel[]).map((plan): Expr => ({ kind: 'exists', plan, negated })))!;
    return continueAs(make.filter({ id: fresh('sj'), input: rel, channels: rel.channels, type: rel.type, pred }), framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  // The host's COMPUTED columns kept a correlated body out (`spellsStored`): the host computed once (`fencedHost`),
  // where every body is at least as correlated as here — the shared fallback of every first-row host.
  const fenced = correlated.every((tail) => tail) ? fencedHost(rel, fresh) : null;
  if (fenced) return existence(negated)({ ...site, rel: fenced });
  const sc = scope(rel, fresh);
  let kept = sc.scoped;
  // `and(b1, b2, …)` is every body's semi-join in turn (`AndStep`, a `ConnectiveStep` over its children);
  // `or(b1, b2, …)` ONE semi-join on the UNION of the bodies' keys — a traverser passes iff some child has a next
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/OrStep.java`).
  const keys: Rel[] = [];
  for (const body of bodies as (readonly IRStep[])[]) {
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'free', false, undefined, 'first');
    if (!keyed) return null;
    if (step.name === 'or') {
      keys.push(make.project({
        id: fresh('sok'), input: keyed.rel, channels: [], type: typeOf(meta('sok', 'int')),
        exprs: [['sok', col(keyed.rel.id, keyed.keyCol)]],
      }));
      continue;
    }
    kept = make.join({
      id: fresh('sj'), left: kept, right: keyed.rel, join: negated ? 'anti' : 'semi', channels: kept.channels, type: kept.type,
      on: eq(col(kept.id, sc.key), col(keyed.rel.id, keyed.keyCol)),
    });
  }
  if (keys.length) {
    const any = keys.length === 1 ? keys[0]! : make.union({ id: fresh('sou'), inputs: keys, all: true, channels: [], type: keys[0]!.type });
    kept = make.join({
      id: fresh('sj'), left: kept, right: any, join: 'semi', channels: kept.channels, type: kept.type,
      on: eq(col(kept.id, sc.key), col(any.id, 'sok')),
    });
  }
  return continueAs(unscoped(kept, rel, fresh), framing, steps, at + 1, bulked, ctx, fresh, labels);
};

/**
 * `map(b)` — the FIRST result per scope, INNER-joined back: `TraversalMapStep` emits `traverser.split(next)` when
 * the child has one and drops the traverser when it has none
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53`).
 * The payload is the body's; every channel is the host's — `split` keeps the pre-child traverser's labels, sack
 * and bulk, and EXTENDS its path by exactly the emitted value (`…/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71`).
 * Which result is "first" in an unordered body is the body's emission order, then its payload — the same
 * deterministic pick a per-origin `limit(1)` makes (`defaultCollation`).
 */
const firstInner: Connector = (site) => firstInnerOver(site);

/** `map`'s connector, given the body ALREADY lowered correlated over `site.rel` where the caller has it
 *  (`allRows`' at-most-one-row test) — so a body is lowered over the host row once, never once to ask and again
 *  to use (measured: that second lowering made an unrolled `local()` body's compile work super-linear). */
function firstInnerOver(site: HostSite, lowered?: Tail | null): Tail | null {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const body = singleBody(step, ctx);
  if (!body) return null;
  // An `otherV()` after the map reads the HOST as the entering vertex (`rejoin`'s `FROM_V`), which only the
  // decorrelated rejoin carries.
  const feedsOtherV = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
  const hostChannel = (channel: Channel): ColMeta => rel.type.cols.find((column) => column.name === channel.col)!;
  const tail = feedsOtherV ? null : lowered !== undefined ? lowered : correlatedBody(body, rel, framing, ctx, fresh, labels, 'read', 'first');
  // A body over its seed row alone (`seedExpressions`) is a projection of the host row, and its filters are the
  // host's: no subquery, no existence probe.
  const inline = tail && framingCols(tail.framing) ? seedExpressions(tail.rel, payloadCols(tail.rel).map((column) => column.name), rel) : null;
  if (tail && inline) {
    const kept = inline.pred ? make.filter({ id: fresh('smf'), input: rel, channels: rel.channels, type: rel.type, pred: inline.pred }) : rel;
    const bodyPayload = payloadCols(tail.rel);
    const mapped = make.project({
      id: fresh('smq'), input: kept, channels: rel.channels, type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, substRelId(inline.values.get(column.name)!, rel.id, kept.id)] as const),
        ...rel.channels.map((channel) => [channel.col, col(kept.id, channel.col)] as const)],
    });
    return continueAs(splitPath(mapped, tail.framing, ctx, fresh), perTraverserFraming(tail.framing), steps, at + 1, bulked, ctx, fresh, labels);
  }
  const pick = tail && framingCols(tail.framing) ? correlatedFirst(tail, payloadCols(tail.rel).map((column) => column.name), rel, fresh) : null;
  if (tail && pick) {
    // The dependent join kept: the body's first row read per host row, its payload landed beside the host's own
    // columns (`Attached`). A host row whose body is EMPTY is dropped (`TraversalMapStep`) by the pick's presence:
    // a keyed pick's key, else a present lead value proves a row, and only where the lead may be a NULL value is
    // the body's `EXISTS` asked — after the `OR`, so a row whose value is present never pays for it.
    const bodyPayload = payloadCols(tail.rel);
    const attached = pick(rel, rel.id);
    const projected = attached.rel;
    const leadPresent: Expr = isNot(col(projected.id, attached.cols.get(bodyPayload[0]!.name)!), compilerNull());
    // A body of EXACTLY one row (a seeded reducer — `fold()`, `count()`) is never empty, so no host row is
    // dropped and nothing reads its value to ask: a value no consumer reads is not computed (§17 error timing).
    const { present: presence } = attached;
    const present = presence === 'always' ? projected : make.filter({
      id: fresh('smf'), input: projected, channels: projected.channels, type: projected.type,
      pred: presence === 'value-nullness' ? leadPresent : presence.orValue ? or(leadPresent, presence.when) : presence.when,
    });
    const mapped = make.project({
      id: fresh('smq'), input: present, channels: rel.channels, type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, col(present.id, attached.cols.get(column.name)!)] as const),
        ...rel.channels.map((channel) => [channel.col, col(present.id, channel.col)] as const)],
    });
    return continueAs(splitPath(mapped, tail.framing, ctx, fresh), perTraverserFraming(tail.framing), steps, at + 1, bulked, ctx, fresh, labels);
  }
  // A host whose COMPUTED columns kept the dependent join out is computed once first (`fencedHost`).
  const fenced = tail && fencedHost(rel, fresh);
  if (fenced) {
    const over = attempt(ctx, () => firstInner({ ...site, rel: fenced }));
    if (over) return over;
  }
  // Not SQL-holdable as a dependent join: the decorrelated body, its FIRST row per scope through the rejoin.
  const sc = scope(rel, fresh);
  const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read', false, undefined, 'first');
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, rel, 'split', true, ctx, fresh, labels, false, feedsOtherV);
  return out && continueAs(out.rel, out.framing, steps, at + 1, bulked, ctx, fresh, out.aliases);
}

/**
 * A host whose COMPUTED columns keep a dependent join out (`spellsStored` — a correlated read would compute them
 * again per inner row: an `as()` label's `jsonb_array`, a path), computed ONCE: a fenced CTE whose columns the
 * correlated read then names, stored. `null` where there is nothing to gain (already stored, or not self-contained
 * — a CTE cannot hold a host that reads an enclosing scope). The first-row hosts' shared fallback (`firstInnerOver`, the existence probe,
 * `recordLeft`) before the decorrelated window: a chain of maps (`repeat(local(out().limit(1))).times(n)`) is one
 * CTE and one seek per phase rather than a scope, a window and a rejoin per phase, and a body that re-sources and
 * reads a host label (`project().by(V().where(neq('a')).values('name'))`) is one host row × its first match rather
 * than every host × the graph ahead of the pick.
 */
function fencedHost(rel: Rel, fresh: Minter): Rel | null {
  if (rel.kind === 'materialize' || !isSelfContained(rel) || rel.type.cols.every((column) => columnIsStored(rel, column.name))) return null;
  return make.materialize({ id: fresh('smh'), input: rel, channels: rel.channels, type: rel.type, fenced: true });
}

/**
 * THE REJOIN — a keyed body's rows (`firstOnly`: its first per scope) INNER-joined back to `host` (the scoped
 * input, or a subset of it) on the key: each host traverser once per body result. Which traverser state the
 * result carries is the host's policy, and there are exactly two in the reference:
 *
 * - `'split'` — `head.split(result)`: the payload is the body's, every channel the PRE-child traverser's, and
 *   the path is extended by exactly the emitted value (`FlatMapStep.java:42-52`, `MapStep`,
 *   `…/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71`); a label bound in the body does not escape. `map`,
 *   `flatMap`, `coalesce`.
 * - `'forward'` — the CHILD's own traverser is emitted (`OptionalStep.java:47-57`, `LocalStep.java:80-88`):
 *   payload, path, labels and sack are the body's; only what a child never inherits (`HOST_ONLY` — the bulk,
 *   the position in the host stream, the enclosing scope keys) comes back from the host row.
 */
function rejoin(
  sc: Scope, host: Rel, keyed: ScopedBody, rel: Rel, policy: 'split' | 'forward', firstOnly: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap, bodyPosition = false, feedsOtherV = false,
): ChainReadOut | null {
  // Each result is one host traverser's: a global reducer in the body is no longer global (`perTraverserFraming`).
  const outFraming = perTraverserFraming(keyed.tail.framing);
  if (!rowResident(outFraming)) return null;
  // A body row that stands for several traversers (a BULKED body, its own `bulk` column) is that many results
  // for EACH of the host row's traversers: the two multiplicities MULTIPLY. An unbulked body's `bulk` is one
  // per row, and the first of a scope is one traverser whatever it stood for.
  const bodyBulk = firstOnly || !keyed.tail.bulked ? undefined : keyed.tail.rel.channels.find((channel) => channel.role === 'bulk');
  if (!firstOnly && keyed.tail.bulked && !bodyBulk) return null;
  const hostBulk = rel.channels.find((channel) => channel.role === 'bulk');
  const bodyPayload = payloadCols(keyed.tail.rel);
  // `bodyPosition`: each result's position WITHIN its scope (the body's own `encounter`) replaces the host's,
  // which the caller has frozen into a parent key (`freezeParent`) for the emission order (`mintBranchOrder`).
  const bodyEnc = bodyPosition ? encounterOf(keyed.tail.rel.channels) : undefined;
  const bodyChannels = [
    ...(policy === 'forward' ? keyed.tail.rel.channels.filter((channel) => !HOST_ONLY.has(channel.role)) : []),
    ...(bodyEnc ? [bodyEnc] : []),
    ...(bodyBulk && !hostBulk ? [bodyBulk] : []),
  ];
  const bodyCol = (name: string): ColMeta => keyed.tail.rel.type.cols.find((column) => column.name === name)!;
  const carried = [...bodyPayload.map((column) => column.name), ...bodyChannels.map((channel) => channel.col), ...(bodyBulk && hostBulk ? [bodyBulk.col] : [])];
  const rows = keyedRows(keyed, carried, fresh, firstOnly);
  const joined = make.join({
    id: fresh('smj'), left: host, right: rows.rel, join: 'inner', channels: host.channels,
    type: typeOf(...host.type.cols, ...rows.rel.type.cols),
    on: eq(col(host.id, sc.key), col(rows.rel.id, rows.key)),
  });
  const hostChannels = (policy === 'forward' ? rel.channels.filter((channel) => HOST_ONLY.has(channel.role)) : rel.channels)
    .filter((channel) => !bodyPosition || channel.role !== 'encounter');
  // The channels in the canonical role order (`withChannel`), so two arms laid out from different sources
  // still agree column for column.
  // An `otherV()` after a `split` reads the PREVIOUS path object — the pre-child head itself, since the body's
  // own hops are hidden (`EdgeOtherVertexStep`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java:44-55`):
  // so the entering vertex of an edge result is the HOST element (`FROM_V`).
  const hostFromV = policy === 'split' && feedsOtherV && outFraming.kind === 'elements' && outFraming.elem === 'edge'
    && rel.type.cols.some((column) => column.name === 'id') && !hostChannels.some((channel) => channel.role === 'fromV');
  const channels = [...hostChannels, ...(hostFromV ? [FROM_V] : [])].reduce(withChannel, bodyChannels);
  const fromBody = new Set(bodyChannels.map((channel) => channel.col));
  const hostChannel = (channel: Channel): ColMeta => channel === FROM_V ? meta(FROM_V.col, 'int') : rel.type.cols.find((column) => column.name === channel.col)!;
  const read = (name: string): Expr => (hostFromV && name === FROM_V.col ? col(joined.id, 'id') : bodyBulk && hostBulk && name === hostBulk.col
    ? { kind: 'binary', op: '*', left: col(joined.id, name), right: col(joined.id, rows.renamed.get(bodyBulk.col)!) }
    : col(joined.id, fromBody.has(name) ? rows.renamed.get(name)! : name));
  const mapped = make.project({
    id: fresh('smp'), input: joined, channels,
    type: typeOf(...bodyPayload, ...channels.map((channel) => (fromBody.has(channel.col) ? bodyCol(channel.col) : hostChannel(channel)))),
    exprs: [
      ...bodyPayload.map((column) => [column.name, col(joined.id, rows.renamed.get(column.name)!)] as const),
      ...channels.map((channel) => [channel.col, read(channel.col)] as const),
    ],
  });
  if (policy === 'forward') return { rel: mapped, framing: outFraming, aliases: keyed.tail.aliases, bulked: !!bodyBulk };
  return { rel: splitPath(mapped, outFraming, ctx, fresh), framing: outFraming, aliases: labels, bulked: !!bodyBulk };
}

/** `split`'s path: the emitted value extends it — an element by its id, a value as a value position; any other
 *  object has no position this path can append, so the path is dropped and a later read declines. */
function splitPath(mapped: Rel, outFraming: RelFraming, ctx: ChainCtx, fresh: Minter): Rel {
  return !pathCarried(mapped) ? mapped
    : outFraming.kind === 'elements' ? extendPath(mapped, { kind: 'element', elem: outFraming.elem, id: col(mapped.id, 'id') }, fresh, ctx.demandsPathLabels)
      : outFraming.kind === 'scalar' && mapped.type.cols.some((column) => column.name === 'v') ? appendValuePosition(mapped, outFraming.type, fresh)
        : dropPath(mapped, fresh);
}

/** A rejoined relation; `bulked` where a body row's own multiplicity rode into the host's `bulk`. */
interface ChainReadOut { readonly rel: Rel; readonly framing: RelFraming; readonly aliases: AliasMap; readonly bulked: boolean }

/**
 * `union(b1, …, bn)` — every arm is a GLOBAL child: `UnionStep` is a `BranchStep` whose arms are each fed EVERY
 * start (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:87-88, 143-147`),
 * so the scope is the whole stream and there is no key to decorrelate on: the reconnect is the arm merge itself
 * (`unionArms` — emission order, reducing arms and their empty-input gate, the shape meet). A row here so a
 * union's arms are read like every other connector body — a path an arm reads is seeded (`CONNECTOR_HOSTS`).
 */
/** The ctx a branch host's ARMS lower under: an `otherV()` reading the merged edge stream
 *  (`coalesce(outE(), inE()).otherV()`) has every arm's tail edge mint its entering vertex, which the peer merge
 *  carries because every arm mints it alike (`mergeArms`) — the tails' branch dispatch's rule. */
const armsCtx = ({ steps, at, ctx }: HostSite): ChainCtx => {
  const feeds = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
  return feeds === (ctx.needsFromV ?? false) ? ctx : { ...ctx, needsFromV: feeds };
};

const globalArms: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const merged = unionArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at });
  // A write in the one arm (`union(__.addV(…))`) runs before the tail, as a top-level write does (`withBranchEffects`).
  return merged && withBranchEffects(merged, steps, at, ctx, fresh, () => continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, merged.aliases));
};

/**
 * `choose(c, t[, f])` — the condition is a LOCAL child, the options are GLOBAL ones: `ChooseStep` routes each
 * traverser by whether `c` produced for it, then each option traversal runs over every traverser routed to it
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java`,
 * `…/branch/BranchStep.java:123-153`). So only the CONDITION is scoped: it is decided per row as an EXISTS on the
 * scope key into the decorrelated condition body, and the routing, the option arms, their empty-input gate and
 * the merge are the host's own (`chooseArms`), handed that predicate (`RoutedCondition`). The key rides the
 * scoped rows as a channel and is shed once they are routed, so no arm carries it.
 */
const chooseRoute: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  // THE DEPENDENT JOIN FIRST: the host's own routing over the stream, its condition a correlated test per row
  // (`chooseArms` — an EXISTS, or the bare predicate of `choose(P, …)`; the option-map form is `chooseOptions`).
  // SQLite's join IS a nested loop, so a condition it can seek per row is the scoped plan's best physical form —
  // measured 1.9× faster at 8k than scoping the stream (`choose(out('created'), values('name'), constant('none'))`).
  // Only where it declines is the condition scoped and decorrelated below.
  const answered = attempt(ctx, () => {
    const direct = chooseArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at });
    return direct && withBranchEffects(direct, steps, at, ctx, fresh, () => continueAs(direct.rel, direct.framing, steps, at + 1, bulked, ctx, fresh, direct.aliases));
  });
  if (answered) return answered;
  if (step.optionArms || step.modulators?.length || step.args.length < 2) return null;
  const choice = step.args[0]!.value;
  if (!isNested(choice)) return null;
  const condition = bodyOf(choice.nested, ctx.params, ctx.sideEffects);
  if (!condition) return null;
  const sc = scope(rel, fresh, true);
  const keyed = scopedBody(condition, sc.scoped, framing, sc, ctx, fresh, labels, 'free', false, undefined, 'first');
  if (!keyed) return null;
  const routed: RoutedCondition = {
    pred: (source) => (source.type.cols.some((column) => column.name === sc.key) ? {
      kind: 'exists', negated: false,
      plan: make.filter({
        id: fresh('scx'), input: keyed.rel, channels: keyed.rel.channels, type: keyed.rel.type,
        pred: eq(col(keyed.rel.id, keyed.keyCol), col(source.id, sc.key)),
      }),
    } : null),
    shed: (routedRows) => {
      const channels = routedRows.channels.filter((channel) => channel.col !== sc.key);
      const cols = routedRows.type.cols.filter((column) => column.name !== sc.key);
      return make.project({
        id: fresh('scs'), input: routedRows, channels, type: typeOf(...cols),
        exprs: cols.map((column) => [column.name, col(routedRows.id, column.name)] as const),
      });
    },
  };
  // The routed rows read the scoped input under an alias of their OWN: the condition's EXISTS plan reads the
  // scoped input too (its domain), and a correlation to the same name from inside it would bind to its own row.
  const input = make.project({
    id: fresh('scr'), input: sc.scoped, channels: sc.scoped.channels, type: sc.scoped.type,
    exprs: sc.scoped.type.cols.map((column) => [column.name, col(sc.scoped.id, column.name)] as const),
  });
  const merged = chooseArms(step, input, framing, bulked, ctx, fresh, labels, { steps, at }, routed);
  if (!merged || merged.effects?.length) return null;
  return continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, merged.aliases);
};

/**
 * `flatMap(b)` / `local(b)` — EVERY result per scope, the rejoin: `FlatMapStep` emits `head.split(r)` for each of the
 * body's results (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52`),
 * `LocalStep` forwards each of the child's own traversers (`…/step/branch/LocalStep.java:80-88`) — the `split` and
 * `forward` policies. Where the stream's order is read, each result keeps its position within its scope behind
 * the host's (start-major, `originMajor`'s rule): the host position frozen as the parent, the body run from a
 * positioned seed, numbered by `mintBranchOrder` as a one-arm merge would be.
 */
const allRows = (policy: 'split' | 'forward'): Connector => (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const body = singleBody(step, ctx);
  if (!body) return null;
  // A body of AT MOST ONE row per traverser (a reducer, a property's value under `local`) has nothing to fan out:
  // every result is the first, so the host is `map`'s — its correlated first-row form, no scope or join. Under
  // `forward` that holds only where neither the host nor the child's traverser carries anything a traverser
  // owns (no path, no label): then forwarding the child's IS splitting the host on its value. (A reducing
  // child mints its traverser afresh — `local(out().count()).path()` is `[3]`, not the host's path plus 3.)
  const ownsNothing = (r: Rel): boolean => r.channels.every((channel) => HOST_ONLY.has(channel.role));
  const probe = correlatedBody(body, rel, framing, ctx, fresh, labels, 'read', policy);
  if (probe && atMostOneRow(probe.rel) && (policy === 'split' || (ownsNothing(rel) && ownsNothing(probe.rel)))) {
    const mapped = attempt(ctx, () => firstInnerOver(site, probe));
    if (mapped) return mapped;
  }
  // An order the BODY imposes (`local(out().order().by('name'))`) is meaningful past the host — through a
  // per-traverser body until the next fan-out (`test/compiler/meaningful-order.exec.test.ts`) — so the rejoin
  // keeps it, host-major then the body's own, whether or not the steps after read it.
  const owed = branchOrderOwed(ctx, { steps, at }, rel) || body.some((s) => s.name === 'order' && !isLocalScope(s));
  const frozen = owed ? freezeParent(positioned(rel, fresh), fresh) : null;
  const input = frozen ? frozen.rel : rel;
  const sc = scope(input, fresh);
  const feedsOtherV = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
  // `local` forwards the child's traverser, so an `otherV()` after it reads the body's own entering vertex (the
  // body mints it); `flatMap` splits the head, so it reads the host element (`rejoin`).
  const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body), undefined, policy,
    policy === 'forward' && feedsOtherV);
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, input, policy, false, ctx, fresh, labels, owed, feedsOtherV);
  if (!out) return null;
  const arm: Tail = { ...out, bulked: bulked || out.bulked };
  const merged = frozen ? mintBranchOrder([arm], frozen.parent, labels, ctx.source, fresh) : { ...out, rel: dropEncounter(out.rel, fresh) };
  return merged && continueAs(merged.rel, merged.framing, steps, at + 1, arm.bulked, ctx, fresh, merged.aliases);
};

/**
 * `coalesce(b1, …, bn)` / `optional(b)` — PRIORITY: per scope, every result of the lowest-index arm that has
 * one. `CoalesceStep.flatMap` resets each arm per traverser and returns the FIRST that `hasNext()`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CoalesceStep.java:52-62`),
 * so arm k answers exactly the scopes that are in none of arms 1…k−1's keyed relations: the host ANTI-joined
 * on each earlier arm's key, then the rejoin. `coalesce` is a `FlatMapStep` (`split`); `OptionalStep` forwards
 * its child's traverser, and the traverser ITSELF where the child has none
 * (`…/step/branch/OptionalStep.java:47-57`) — a final identity arm over the scopes left.
 * The arms merge as a branch's do (`mergeArms`: a scalar meet, a variant, rehomed labels).
 */
const priority: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.modulators?.length || step.optionArms || !step.args.length || step.args.some((arg) => !isNested(arg.value))) return null;
  const optional = step.name === 'optional';
  if (optional && step.args.length !== 1) return null;
  const bodies = step.args.map((arg) => bodyOf((arg.value as { nested: unknown }).nested, ctx.params, ctx.sideEffects));
  // An EMPTY body (one a Pass reduced to nothing, `where(count())`) is admitted: it lowers as the identity,
  // the traverser itself. Only an unreadable one declines.
  if (bodies.some((body) => !body)) return null;
  // An arm that ALWAYS answers (exactly one row per traverser — a seeded reducer: `fold()`, `count()`) ends the
  // priority: no later arm is ever asked (`CoalesceStep` returns the first arm that `hasNext()`). Where it is the
  // FIRST arm the host is that arm alone, a `flatMap` (`coalesce`) or a `local` (`optional`, whose own fallback is
  // dead too) — so the arm's value is computed only where something reads it.
  const policy = optional ? 'forward' : 'split';
  const leading = bodies[0]!.length ? correlatedBody(bodies[0]!, rel, framing, ctx, fresh, labels, 'read', policy) : null;
  if (leading && exactlyOneRow(leading.rel)) {
    const alone = attempt(ctx, () => allRows(policy)({ ...site, step: { ...step, args: [step.args[0]!] } }));
    if (alone) return alone;
  }
  // THE DEPENDENT JOIN FIRST, over one correlated row (a body inside another child, `project().by(coalesce(…))`)
  // or a whole stream alike: each arm over the row, gated by the earlier arms' NOT EXISTS (`coalesceMerge`, the
  // correlated form cc3b keeps for `map`/`where`). SQLite's join IS a nested loop, so an arm it can seek per row
  // is already the scoped plan's best physical form — measured 2.2× (`coalesce(values,constant)`) and 2.9×
  // (`optional(out('knows'))`) faster at 8k than scoping the stream. Only where that form declines is the stream
  // scoped and decorrelated below. A body that DRAWS never takes it, for `correlatedBody`'s reason: its existence
  // test and its value would be two draws (or one shared by every host), so it is decorrelated below.
  if (!bodies.some((body) => nondeterministic(body!, ctx.params))) {
    const direct = attempt(ctx, () => {
      const branch = optional ? optionalArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at })
        : coalesceArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at });
      return branch && withBranchEffects(branch, steps, at, ctx, fresh, () => continueAs(branch.rel, branch.framing, steps, at + 1, bulked, ctx, fresh, branch.aliases));
    });
    if (direct) return direct;
  }
  // A consumer that READS the merge's order (`branchOrderOwed`) gets the emission key — host position, then
  // arm, then the result's position within its scope (`mintBranchOrder`): the host is positioned and its
  // position frozen into a parent key, and each body runs from a positioned seed so it carries its own.
  const owed = branchOrderOwed(ctx, { steps, at }, rel);
  const frozen = owed ? freezeParent(positioned(rel, fresh), fresh) : null;
  const input = frozen ? frozen.rel : rel;
  const sc = scope(input, fresh);
  const arms: Tail[] = [];
  let remaining: Rel = sc.scoped;
  for (const body of bodies as (readonly IRStep[])[]) {
    // Where the merge's order is read, a STREAMING arm runs from a positioned seed, so its results are numbered
    // in its own emission order; a REDUCING arm (`isReductionArm`) has one result per scope and no position to
    // keep.
    const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body), undefined, policy);
    if (!keyed) return null;
    const out = rejoin(sc, remaining, keyed, input, policy, false, ctx, fresh, labels, owed,
      edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false));
    if (!out) return null;
    arms.push({ ...out, rel: owed ? out.rel : dropEncounter(out.rel, fresh), bulked: bulked || out.bulked });
    remaining = make.join({
      id: fresh('sa'), left: remaining, right: keyed.rel, join: 'anti', channels: remaining.channels, type: remaining.type,
      on: eq(col(remaining.id, sc.key), col(keyed.rel.id, keyed.keyCol)),
    });
  }
  if (optional) {
    const left = unscoped(remaining, input, fresh);
    arms.push({ rel: owed ? left : dropEncounter(left, fresh), framing, aliases: labels, bulked });
  }
  // A REDUCING arm's scalar rides its type on a `vt` column (`result: 'number'`/`'value'`), which the scalar
  // meet refuses beside a plain one; normalized onto the merged per-row vtype it meets like any other — the
  // one normalization every branch merge uses (`reconcileCollapsed`).
  const marked = arms.some((arm) => arm.framing.kind === 'scalar' && arm.framing.result !== undefined && arm.framing.result !== 'count');
  // An arm whose body carried its own multiplicity has a `bulk` the others may lack (a nested scope's host
  // row has none): each of theirs is ONE traverser (`ensureBulk`).
  const counted = arms.some((arm) => arm.rel.channels.some((channel) => channel.role === 'bulk'))
    ? arms.map((arm) => ({ ...arm, rel: ensureBulk(arm.rel, fresh) })) : arms;
  const met = marked ? reconcileCollapsed(counted, fresh) : counted;
  if (!met) return null;
  // ONE arm (`coalesce(b)`) has nothing to merge; where its order is read it is still numbered host-major.
  const merged = met.length === 1 ? met[0]!
    : frozen ? mintBranchOrder(met, frozen.parent, labels, ctx.source, fresh) : mergeArms(met, labels, ctx.source, fresh);
  return merged && continueAs(merged.rel, merged.framing, steps, at + 1, arms.some((arm) => arm.bulked), ctx, fresh, merged.aliases);
};

/**
 * `project(k…).by(b)…` — each child `by()` the FIRST result per scope, LEFT-joined back, one join per `by()`:
 * `ProjectStep.map` puts a key only where its `by()` is productive
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:64-67`),
 * so an unmatched scope leaves the field absent — the record's own `optional` field, read by value nullness as
 * every other optional field is. A `by()` that is not a child traversal (a key, a token, `select`) is the
 * record builder's own, over the joined row.
 *
 * `ProjectStep` is a MAP step, so the record is a new object on the traverser — one no value position of a
 * carried path can hold. The path is DROPPED after it, the idiom every child result with no position uses
 * (`childResultPath`): a body may read the host's path, and a later `path()` declines rather than answer a
 * history with a step missing.
 */
const recordLeft: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.optionArms) return null;
  const child = childSeam(ctx, fresh);
  const keys = step.args.length;
  const bys = modulations(step, keys, child);
  if (!bys) return null;
  const host = (from: Rel) => (framing.kind === 'elements' || framing.kind === 'scalar' || framing.kind === 'property' ? reductionHost(from, framing, labels) : null);
  // The scope is minted only once a slot needs it.
  let sc: Scope | undefined;
  // Which `by()` slots this connector answers: every CHILD body it can lower, correlated or keyed. Decided per
  // slot — a slot it cannot lower is the record builder's own field (`byField`, through the child seam) — so one
  // unanswerable `by()` does not cost the others. A slot's ring position is `index % bys.length` (`TraversalRing`).
  const owned = new Map<number, { readonly first: ReturnType<typeof firstPerScope>; readonly framing: RelFraming }>();
  // A slot whose body stays CORRELATED: its first row read per host row (`correlatedFirst`), no join at all.
  const correlated = new Map<number, { readonly pick: Pick; readonly framing: RelFraming; readonly total: boolean }>();
  let joined: Rel = rel;
  for (let slot = 0; slot < bys.length; slot++) {
    const by = bys[slot]!;
    if (by.key.kind !== 'child' || by.order !== undefined) continue;
    // A RECORD-valued by() (`by(__.project(…))`) is held as the MAP it is (`recordAsMap`): a record's own first
    // column is a SUB-field's, so presence read off it dropped an outer key whose inner map was empty.
    const lowered = correlatedBody(by.key.body, rel, framing, ctx, fresh, labels, 'read', 'first');
    const tail = lowered && recordAsMap(lowered, ctx, fresh);
    const fieldCols = tail && framingCols(tail.framing);
    // A field is present by its value's nullness (`ProjectStep`'s optional key), so no presence test is built.
    const pick = tail && fieldCols && correlatedFirst(tail, fieldCols.map((column) => column.name), rel, fresh, false);
    if (tail && pick) { correlated.set(slot, { pick, framing: tail.framing, total: exactlyOneRow(tail.rel) }); continue; }
    // The host's computed columns kept this slot's dependent join out: the whole record over the host computed
    // once (`fencedHost`), where every slot is at least as correlated as here.
    const fenced = tail && fencedHost(rel, fresh);
    if (fenced) return recordLeft({ ...site, rel: fenced });
    const scoped = sc ??= scope(rel, fresh);
    if (joined === rel) joined = scoped.scoped;
    const keyed = scopedBody(by.key.body, rel, framing, scoped, ctx, fresh, labels, 'read', false, (t) => recordAsMap(t, ctx, fresh), 'first');
    const cols = keyed && framingCols(keyed.tail.framing);
    if (!keyed || !cols || cols.some((column) => !keyed.tail.rel.type.cols.some((c) => c.name === column.name))) continue;
    const first = firstPerScope(keyed, cols.map((column) => column.name), fresh);
    joined = make.join({
      id: fresh('spj'), left: joined, right: first.rel, join: 'left', channels: joined.channels,
      type: typeOf(...joined.type.cols, ...first.rel.type.cols),
      on: eq(col(joined.id, scoped.key), col(first.rel.id, first.key)),
    });
    owned.set(slot, { first, framing: keyed.tail.framing });
  }
  // No slot a child this connector owns: the record is the builder's own over the host row, as the host's
  // own tail is — only the path rule below differs.
  // Each correlated slot's pick lands its columns on the joined input — it reads the host row, which every
  // relation the joins built still carries by name.
  const landed = new Map<number, Attached>();
  for (const [slot, kept] of correlated) {
    const attached = kept.pick(joined, rel.id);
    landed.set(slot, attached);
    joined = attached.rel;
  }
  const over = joined;
  const fieldFor = (slot: number): ByField | undefined => {
    const kept = correlated.get(slot);
    const attached = landed.get(slot);
    if (kept && attached) return {
      exprs: framingCols(kept.framing)!.map((column) => [column.name, col(over.id, attached.cols.get(column.name)!)] as const),
      framing: kept.framing,
      // A body of exactly one row always yields the field — it is never absent, so never optional.
      optional: !kept.total && !isProductiveBy(step),
    };
    const field = owned.get(slot);
    if (!field) return undefined;
    return {
      exprs: framingCols(field.framing)!.map((column) => [column.name, col(over.id, field.first.renamed.get(column.name)!)] as const),
      framing: field.framing,
      // `ProductiveByStrategy` keeps the key (as null) where the body has no result; otherwise it is absent.
      optional: !isProductiveBy(step),
    };
  };
  const record = recordOf(over, host(over), framing, step, child, ctx.source, fresh, fieldFor);
  if (!record) return null;
  return continueAs(dropPath(record.rel, fresh), { kind: 'record', fields: record.fields }, steps, at + 1, bulked, ctx, fresh, labels);
};

/** A child body's identity across `bodyOf` calls (each re-runs the passes, so the arrays are never the same
 *  object): its structure, spelled deterministically. A `bigint` literal spells as text, and an object met
 *  again (the IR shares and back-references nodes) as a marker, so the walk is finite. */
const bodyKey = (body: readonly IRStep[]): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(body, (_, value: unknown) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[seen]';
      seen.add(value);
    }
    return value;
  });
};

/** The relation a host's own expressions read, where it names one. */
function hostRelOf(host: ChildHost): RelId | undefined {
  const at = host.kind === 'element' || host.kind === 'property' ? host.id
    : host.kind === 'scalar' ? host.value : host.kind === 'list' ? host.list : host.kind === 'map' ? host.map : undefined;
  return at?.kind === 'col' ? at.rel : host.row?.rel.id;
}

/** The columns of `rel` an expression reads. */
function colsRead(e: Expr, rel: RelId): Set<string> {
  const names = new Set<string>();
  rewriteExpr(e, (node) => { if (node.kind === 'col' && node.rel === rel) names.add(node.name); return node; });
  return names;
}

/** The pre-joined value of `body` over `host` (`ChildStrategy.scopedValues`), or `undefined` — the seam then
 *  builds its own. Read only over the relation the values were joined into. */
export function scopedValue(ctx: ChainCtx, body: readonly IRStep[], host: ChildHost): ChildValue | undefined {
  const scoped = ctx.scopedValues;
  if (!scoped) return undefined;
  const at = hostRelOf(host);
  const value = scoped.values.get(landedKey(body, rootOfHost(host, at)));
  if (!value) return undefined;
  if (at === scoped.over) return value;
  // The host reads a PASS-THROUGH of the joined relation (a fence the tail put over it): the landed columns
  // ride it under their names, so the value is re-pointed at it — where every column it reads is there.
  const row = host.row?.rel;
  if (!row || row.id !== at) return undefined;
  const reads = [value.expr, value.vtype, value.node, value.labelEntry, typeof value.present === 'object' ? value.present.when : undefined]
    .flatMap((e) => (e ? [...colsRead(e, scoped.over)] : []));
  if (!reads.every((name) => row.type.cols.some((column) => column.name === name))) return undefined;
  return substChildValue(value, scoped.over, row.id);
}

/** WHERE A LANDED BODY STARTS — a FRESH traverser on an element (`freshTraverserRow`): a `where(k, P(k2)).by(b)`
 *  operand's label, or the current traverser of a bare `where(P(k)).by(b)` (`WherePredicateStep` projects each
 *  through `TraversalUtil.produce` on a split with no path). `id` is an expression of the host relation. */
interface LandedRoot { readonly id: Expr; readonly elem: Elem }

/** The columns a landed root's id reads — what tells two operands of one `by()` body apart. */
const rootTag = (id: Expr, rel: RelId | undefined): string => (rel ? [...colsRead(id, rel)].sort().join(',') : '');

/** A landed value's key: the body, and for a ROOTED body the root it starts from. */
const landedKey = (body: readonly IRStep[], root?: string): string => (root === undefined ? bodyKey(body) : `${bodyKey(body)}@${root}`);

/** The root a host's value was landed under, where the host is a FRESH element traverser. */
const rootOfHost = (host: ChildHost, at: RelId | undefined): string | undefined =>
  host.kind === 'element' && host.row?.fresh ? rootTag(host.id, at) : undefined;

/** The slots of a by()-modulated host whose child value is PER TRAVERSER — each traverser's first result
 *  (`TraversalUtil.produce`). `group()`'s VALUE `by()` is one exactly where its body has NO barrier
 *  (`isValueBarrier`, the step `Grouping.determineBarrierStep` stops at): with one, `Grouping` pools a key's
 *  traversers into it, so its scope is the KEY (`pooledGroupMap`); without one, each traverser's first value is
 *  ASSIGNED to its key (`Operator.assign`,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125`)
 *  — a per-traverser value, landed like the key and read by the host's own group lowering. */
const perTraverserSlot = (step: IRStep, slot: number, body: readonly IRStep[]): boolean =>
  step.name !== 'group' || slot === 0 || !body.some(isValueBarrier);

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (§2 S5). Each child `by()` is the first result per scope (`firstPerScope`), LEFT-joined onto the scoped
 * input; the host step is then the host's own lowering over that relation, reading each value as a column
 * where it would have built a correlated subquery (`scopedValue`). The by() semantics — an unproductive key
 * drops the traverser unless `ProductiveByStrategy` keeps it (`OrderGlobalStep`, `DedupGlobalStep.java:77-78`,
 * `GroupCountStep`'s `TraversalUtil.produce`), the comparator, the survivor, the map — stay the host's; only
 * where the value comes from changes. The joined columns are shed after the step.
 */
/**
 * THE by() VALUES AS JOIN COLUMNS (§2 S5): each body's first result per scope (`firstPerScope`), LEFT-joined
 * onto the scoped input. The answer is that relation and, per body (by `bodyKey`), the `ChildValue` reading
 * its columns — what `childSeam`'s `scalar` hands a host lowered over it (`scopedValue`). `null` declines.
 */
function landValues(
  rel: Rel, framing: RelFraming, bodies: ReadonlyMap<string, readonly IRStep[]>, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  roots: ReadonlyMap<string, LandedRoot> = new Map(),
): { readonly over: Rel; readonly values: ReadonlyMap<string, ChildValue> } | null {
  const sc = scope(rel, fresh);
  let joined = sc.scoped;
  const landed: { readonly key: string; readonly first: KeyedRows; readonly framing: RelFraming; readonly cols: readonly ColMeta[] }[] = [];
  const kept = new Map<string, NonNullable<ReturnType<typeof correlatedValue>>>();
  for (const [key, body] of bodies) {
    const root = roots.get(key);
    // A body whose correlated plan reads a WHOLE element relation per host row (`perHostWork`'s `reSources`,
    // `src/rel/work.ts` — a re-source, at any depth) would, decorrelated, cross every scope row with the graph
    // ahead of the first-row pick — N × G for one row per host. It takes the host's correlated-first policy, as
    // `map`'s and `project`'s: read per host row where SQL can hold the dependent join, its first row under
    // `LIMIT 1` (`correlatedValue`). Any other body's decorrelated read is bounded by the host's own
    // neighbourhood, and the landed window is its measured form (the order family's plans, `sql-hygiene`).
    // The trial's plan IS the correlated read (`reSourcingBody`): it is not lowered a second time.
    const trial = root ? null : reSourcingBody(body, rel, sc.scoped, framing, ctx, fresh, labels);
    const correlated = trial?.tail ? correlatedValue(body, rel, sc.scoped, framing, ctx, fresh, labels, trial.tail) : null;
    if (correlated) { kept.set(key, correlated); continue; }
    // A declined trial's reasons reach the compile only where the decorrelated form declines too, and ahead of its
    // own, as when the trial recorded straight into the compile's sink.
    const sink = trial?.declines ? ctx.declines.fork() : ctx.declines;
    const keyedCtx: ChainCtx = sink === ctx.declines ? ctx : { ...ctx, declines: sink };
    const reframe = (t: Tail) => recordAsMap(t, ctx, fresh, true);
    const keyed = root ? rootedBody(body, root, rel, sc, keyedCtx, fresh, reframe)
      : scopedBody(body, rel, framing, sc, keyedCtx, fresh, labels, 'read', false, reframe, 'first');
    if (trial?.declines) {
      if (!keyed) ctx.declines.adopt(trial.declines);
      ctx.declines.adopt(sink);
    }
    const cols = keyed && framingCols(keyed.tail.framing);
    // One value column (and a scalar's per-row type) is what a ChildValue carries.
    if (!keyed || !cols || cols.length > (keyed.tail.framing.kind === 'scalar' ? 2 : 1)) return null;
    if (cols.some((column) => !keyed.tail.rel.type.cols.some((c) => c.name === column.name))) return null;
    const first = firstPerScope(keyed, cols.map((column) => column.name), fresh);
    joined = make.join({
      id: fresh('sbj'), left: joined, right: first.rel, join: 'left', channels: joined.channels,
      type: typeOf(...joined.type.cols, ...first.rel.type.cols),
      on: eq(col(joined.id, sc.key), col(first.rel.id, first.key)),
    });
    landed.push({ key, first, framing: keyed.tail.framing, cols });
  }
  const over = joined;
  const values = new Map<string, ChildValue>(landed.map(({ key, first, framing: valueFraming, cols }) => [key, {
    expr: col(over.id, first.renamed.get(cols[0]!.name)!),
    ...(cols[1] ? { vtype: col(over.id, first.renamed.get(cols[1].name)!) } : {}),
    framing: valueFraming,
    // The body produced exactly where its scope has a first row — a NULL value under it is a productive null.
    present: { when: isNot(col(over.id, first.key), compilerNull()) },
    yields: 'first' as const,
    // A MAP value whose values hold element rowids is NESTED wherever a host puts it (a group key, a member):
    // its node carries them expanded (`mapNodePayload`), as a root map's are framed; a key that only compares
    // (`dedup`) reads `expr`.
    ...(valueFraming.kind === 'map' && mapHoldsRowids(valueFraming.valOf)
      ? { node: mapNode(mapNodePayload(col(over.id, first.renamed.get(cols[0]!.name)!), valueFraming.valOf, ctx.source, fresh)) } : {}),
  } satisfies ChildValue]));
  if (!kept.size) return { over, values };
  // The correlated values become COLUMNS of the joined input, as a landed value is (`Attached`): the host's own
  // lowering reads them by name (and may re-project its input, a path dropped), never re-spelling the subquery's
  // host reads. A presence stated as its own test is a column too.
  let valued: Rel = over;
  const named = [...kept].map(([key, { pick, framing: valueFraming, cols }]) => {
    const attached = pick(valued, sc.scoped.id);
    valued = attached.rel;
    return { key, attached, valueFraming, cols };
  });
  const presence: (readonly [string, Expr])[] = [];
  const at = valued;
  const stated = named.map(({ attached }) => {
    if (typeof attached.present !== 'object') return undefined;
    const name = fresh('sbp') as string;
    presence.push([name, substRelId(attached.present.when, attached.rel.id, at.id)]);
    return name;
  });
  const final = presence.length ? make.project({
    id: fresh('sbk'), input: at, channels: at.channels, type: typeOf(...at.type.cols, ...presence.map(([name]) => meta(name, 'int', true))),
    exprs: [...at.type.cols.map((c) => [c.name, col(at.id, c.name)] as const), ...presence],
  }) : at;
  const all = new Map([...values].map(([key, value]) => [key, substChildValue(value, over.id, final.id)]));
  named.forEach(({ key, attached, valueFraming, cols }, i) => {
    const { present } = attached;
    const p = stated[i];
    all.set(key, {
      expr: col(final.id, attached.cols.get(cols[0]!)!), ...(cols[1] ? { vtype: col(final.id, attached.cols.get(cols[1])!) } : {}),
      framing: valueFraming, yields: 'first',
      present: typeof present === 'object' && p ? { ...present, when: col(final.id, p) } : present,
    });
  });
  return { over: final, values: all };
}

/**
 * A `by()` body's value as a CORRELATED read of the host row (`landValues`' first try): the body lowered over one
 * host row (`correlatedBody`) and its first row read per host row (`correlatedFirst`), with its presence — the
 * pick's key, else a present lead value, and only where the lead may be a NULL value the body's `EXISTS`
 * (`firstInnerOver`'s presence rule). `null` where the dependent join is not SQL-holdable (or the value is not ONE
 * column, and a scalar's per-row type).
 */
function correlatedValue(
  body: readonly IRStep[], rel: Rel, from: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  lowered: Tail | null = correlatedBody(body, rel, framing, ctx, fresh, labels, 'read', 'first', from),
): { readonly pick: Pick; readonly framing: RelFraming; readonly cols: readonly string[] } | null {
  const tail = lowered && recordAsMap(lowered, ctx, fresh, true);
  const cols = tail && framingCols(tail.framing);
  if (!tail || !cols || !cols.length || cols.length > (tail.framing.kind === 'scalar' ? 2 : 1)) return null;
  if (tail.framing.kind === 'map' && mapHoldsRowids(tail.framing.valOf)) return null;
  const names = cols.map((column) => column.name);
  const pick = correlatedFirst(tail, names, from, fresh);
  return pick && { pick, framing: tail.framing, cols: names };
}

/**
 * A body's CORRELATED plan where it re-sources (`perHostWork`'s `reSources`, `src/rel/work.ts`), else `null` with
 * its `declines` sink — the reasons a declined trial recorded, for the caller to adopt only if its other route
 * declines too. A SPECULATIVE lowering, and the one `correlatedValue` then reads (never lowered twice): a body
 * nested N `by()`s deep would otherwise be lowered 2^N times, one trial plus one real lowering per level.
 *
 * Two things keep the cost to bodies that can answer "yes":
 *  - a NECESSARY condition first: a re-source cross is only ever built for a mid-traversal `V()`/`E()` (`reSource`,
 *    `movement.ts`, its one producer), so a body with no such step at any depth cannot re-source and pays no
 *    trial. The decision itself stays the ALGEBRA's (`perHostWork`); this only skips asking where the answer is
 *    known. A body that cannot be read is asked.
 *  - the trial mints with the compile's own `fresh`, so its plan is kept as is. A "no" discards its relations (an
 *    id gap, never a name collision) and puts back what it recorded: the named collections, the site effects, the
 *    budget's unroll note and its decline reasons (a fork, so a trial that declined while the decorrelated form
 *    answered never fails the compile).
 * A trial that declines is a "no": the body then takes its decorrelated form, which answers or declines for itself.
 */
function reSourcingBody(
  body: readonly IRStep[], rel: Rel, from: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): { readonly tail: Tail | null; readonly declines: Declines | null } {
  if (!someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true)) return { tail: null, declines: null };
  const saved = new Map(ctx.collections);
  const taken = ctx.siteEffects?.length ?? 0;
  const unroll = ctx.budget.unroll;
  const declines = ctx.declines.fork();
  let kept: Tail | null = null;
  try {
    const tail = correlatedBody(body, rel, framing, { ...ctx, declines }, fresh, labels, 'read', 'first', from);
    kept = tail && perHostWork(tail.rel).reSources ? tail : null;
  } catch (error) {
    if (!(error instanceof UnsupportedTraversal)) throw error;
  } finally {
    if (!kept) {
      restoreCollections(ctx.collections, saved);
      ctx.siteEffects?.splice(taken);
      ctx.budget.restoreUnroll(unroll);
    }
  }
  if (kept) ctx.declines.adopt(declines);
  return { tail: kept, declines: kept ? null : declines };
}

/** A correlated `ChildValue` re-pointed from the host relation to one that carries its columns by name. */
function substChildValue(value: ChildValue, from: RelId, to: RelId): ChildValue {
  const present = typeof value.present === 'object' ? { ...value.present, when: substRelId(value.present.when, from, to) } : value.present;
  return {
    ...value, expr: substRelId(value.expr, from, to), present,
    ...(value.vtype ? { vtype: substRelId(value.vtype, from, to) } : {}), ...(value.node ? { node: substRelId(value.node, from, to) } : {}),
    ...(value.labelEntry ? { labelEntry: substRelId(value.labelEntry, from, to) } : {}),
    ...(value.comparable ? { comparable: () => substRelId(value.comparable!(), from, to) } : {}),
  };
}

/** Can the tree framer (`listNodeExpr`) walk a list of these members, at every depth? A map member's element
 *  rowids are expanded there (`mapNodePayload`); a path member has no `{t:'path'}` node yet. */
const treeFramed = (of: ListOf): boolean =>
  of.kind === 'list' ? treeFramed(of.of) : of.kind === 'scalar' || of.kind === 'mixed' || of.kind === 'map' || of.kind === 'elem';

/**
 * A RECORD value (`by(__.project(…))`) as the MAP it is — `ProjectStep` emits a `Map` for every traverser it
 * maps, an empty one included: one `map` column (`recordToMap`), so the value is ONE column, present wherever the
 * body produced and equal by its entries. Read as a record, its presence was its FIRST SUB-field's, so an inner
 * map with that field absent read as no value at all (`project('x').by(project('a','b').by(has('lang'))…)`
 * dropped `x`). The child seam already hands a project body back collapsed the same way.
 */
function recordAsMap(tail: Tail, ctx: ChainCtx, fresh: Minter, always = false): Tail | null {
  // Only where the record's presence CANNOT be read off its first column: a first field that is itself always
  // there (a `count()`, a token) proves the record, and the record's columns stay as they are (no JSON built) —
  // `always` where the value must be ONE column regardless (a landed by() value, `landValues`).
  const readable = (fields: readonly RecordField[]): boolean => {
    const first = fields[0];
    return !!first && !first.optional && (first.framing.kind !== 'record' || readable(first.framing.fields));
  };
  if (tail.framing.kind !== 'record' || (!always && readable(tail.framing.fields))) return tail;
  const map = recordToMap(tail.rel, tail.framing.fields, ctx.source, fresh);
  return map && { ...tail, rel: map.rel, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: map.valOf } };
}

/** The child bodies of a step's per-traverser `by()` slots, by `bodyKey`. */
function perTraverserBodies(step: IRStep, bys: readonly (Modulation | undefined)[]): Map<string, readonly IRStep[]> {
  const bodies = new Map<string, readonly IRStep[]>();
  bys.forEach((by, slot) => {
    if (by?.key.kind === 'child' && perTraverserSlot(step, slot, by.key.body)) bodies.set(bodyKey(by.key.body), by.key.body);
  });
  return bodies;
}

/** A host's `by()` slot count: `group()` a key and a value, `groupCount()` a key, the others one per `by()`. */
const byArity = (step: IRStep): number =>
  step.name === 'group' ? 2 : step.name === 'groupCount' ? 1 : step.modulators?.length ?? 0;

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (`landValues`). The host step is then the host's own lowering over the joined relation, reading each value
 * as a column where it would have built a correlated subquery (`scopedValue`). The by() semantics — an
 * unproductive key drops the traverser unless `ProductiveByStrategy` keeps it (`OrderGlobalStep`,
 * `DedupGlobalStep.java:77-78`, `GroupCountStep`'s `TraversalUtil.produce`), the comparator, the survivor, the
 * map — stay the host's; only where the value comes from changes. The joined columns are shed after the step.
 * A `group()` whose VALUE `by()` POOLS (a barrier in its body, `perTraverserSlot`) is `pooledGroup`'s; one with no
 * barrier is ASSIGNED per traverser (`Operator.assign`), so its value body lands beside the key, keyed or not.
 */
const byValues: Connector = (site) => {
  const { step, rel, framing, ctx, fresh, labels } = site;
  // An ARGUMENT changes what the by() runs over: `dedup("a")` projects each scope LABEL's value on a NEW traverser
  // (`freshTraverserRow`), and a keyed `groupCount("m")` stays the host's own. A keyed `group("m")` is the barrier
  // form's per-traverser by() over this stream (`GroupSideEffectStep` differs only in where the map goes): its
  // value POOLS through `keyedPooledGroup`, and is otherwise ASSIGNED, landed below like the barrier form's.
  if (step.optionArms || !step.modulators?.length) return null;
  const bys = modulations(step, byArity(step), childSeam(ctx, fresh));
  // A group whose VALUE pools (a barrier in its body, `perTraverserSlot`) is `pooledGroup`'s, keyed or not.
  const pools = step.name === 'group' && bys?.[1]?.key.kind === 'child' && !perTraverserSlot(step, 1, bys[1].key.body);
  if (step.args.length && !(step.name === 'group' && bys && !pools)) {
    const keyed = keyedPooledGroup(site);
    if (!keyed) refuseKeyedPool(step, ctx);
    return keyed;
  }
  if (!bys) return null;
  if (pools) return pooledGroup(site, bys);
  const all = perTraverserBodies(step, bys);
  // A body the host's own seam answers as a CORRELATED value (`scalarChild` — one index seek per row) keeps the
  // dependent join, as cc3b's `map`/`project` rows do: only the bodies it cannot hold are landed as join columns.
  const seam = childSeam(ctx, fresh);
  const host = framing.kind === 'elements' || framing.kind === 'scalar' ? reductionHost(rel, framing, labels) : null;
  // Nor is a body over its seed row alone (`seedExpressions` — `select(values)` of an entry, `math(…)`) landed:
  // it is an expression of the host row, which the host's own by() spells in place.
  const seedOnly = (body: readonly IRStep[]): boolean => {
    const tail = correlatedBody(body, rel, framing, ctx, fresh, labels, 'read');
    const cols = tail && framingCols(tail.framing);
    return !!tail && !!cols && !!seedExpressions(tail.rel, cols.map((column) => column.name), rel);
  };
  const seamless = new Map([...all].filter(([, body]) => !host || !seam.scalar(body, host)));
  const inPlace = new Map([...seamless].filter(([, body]) => !seedOnly(body)));
  // Where the host's own by() cannot spell a seed-only body in place, it is landed like any other.
  const tail = (inPlace.size < seamless.size ? landedStep(site, inPlace) : null) ?? landedStep(site, seamless);
  return tail && afterLanded(site, tail);
};

/**
 * A KEYED `group("a")` IN A CONNECTOR BODY whose value `by()` POOLS (`poolingStep` — `by(count())`,
 * `by(values('age').sum())`, `by(out().fold())`) and that `keyedPooledGroup` could not register as pool MEMBERS —
 * in practice a reduction that can RAISE (`by(values('age').sum())`), whose drain is the finished map and so reduces
 * once per BODY: one map per body cannot key as one grouping per host row (`registerGrouping` refuses it,
 * `collection.ts`), whichever route reached it. Recorded ON THE FORK (`refuseSite`), so the one
 * raiser — `keyedBody`, which knows the host the body runs under — names it whichever route reached it.
 */
function refuseKeyedPool(step: IRStep, ctx: ChainCtx): void {
  const label = step.args[0]?.value;
  const value = step.modulators?.[1]?.[0];
  if (step.name !== 'group' || typeof label !== 'string' || !isNested(value)) return;
  const body = bodyOf(value.nested, ctx.params, ctx.sideEffects);
  const pool = body && poolingStep(body);
  if (pool) refuseSite(ctx.collections, { label, example: `a group() value by() that reduces or folds, here ${pool.name}()` });
}

/** THE HOST STEP ALONE over its landed by() values (`landValues`): the host's own lowering of `site.step` over
 *  the joined relation, reading each landed value as a column (`scopedValue`). No body to land (a
 *  `by(__.identity())` IS a bare `by()`): the host's own lowering over the input. */
function landedStep(site: HostSite, bodies: ReadonlyMap<string, readonly IRStep[]>, roots?: ReadonlyMap<string, LandedRoot>): Tail | null {
  const { step, rel, framing, bulked, ctx, fresh, labels } = site;
  const landed = bodies.size
    ? landValues(rel, framing, bodies, ctx, fresh, labels, roots)
    : { over: rel, values: new Map<string, ChildValue>() };
  if (!landed) return null;
  const { over, values } = landed;
  const only = [step];
  return continueAs(over, framing, only, 0, bulked,
    { ...ctx, scopedValues: { over: over.id, values }, hostTailAt: { steps: only, at: 0 } }, fresh, labels);
}

/** The chain after a `landedStep`, the joined columns shed: a framing-preserving step (order, dedup, a filter)
 *  carries them as payload. */
function afterLanded(site: HostSite, tail: Tail): Tail | null {
  const { rel, framing, steps, at, ctx, fresh } = site;
  const payload = payloadCols(rel);
  const preserved = tail.framing.kind === framing.kind;
  if (preserved && !payload.every((column) => tail.rel.type.cols.some((c) => c.name === column.name))) return null;
  const kept = preserved
    ? make.project({
      id: fresh('sbx'), input: tail.rel, channels: tail.rel.channels,
      type: typeOf(...payload, ...tail.rel.channels.map((channel) => tail.rel.type.cols.find((c) => c.name === channel.col)!)),
      exprs: [...payload.map((column) => column.name), ...tail.rel.channels.map((channel) => channel.col)]
        .map((name) => [name, col(tail.rel.id, name)] as const),
    })
    : tail.rel;
  return continueAs(kept, tail.framing, steps, at + 1, tail.bulked, ctx, fresh, tail.aliases);
}

/**
 * The OPERANDS of an alias-compare `where` in the order its `by()` ring serves them, or `null` where the step is
 * not one: `where(k, P(k2…))` starts at `k`, a bare `where(P(k…))` at the current traverser (`null`), then
 * each predicate leaf's label left to right through `and`/`or`/`not` — `WherePredicateStep` hands out the
 * ring's `by()`s in that order, cycling
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java`).
 */
function whereOperands(step: IRStep): (string | null)[] | null {
  if (step.name !== 'where' || step.optionArms || step.args.some((arg) => isNested(arg.value))) return null;
  const leaves = (pred: unknown): string[] | null => {
    if (!isPred(pred)) return null;
    if (pred.op === 'and' || pred.op === 'or' || pred.op === 'not') {
      const parts = pred.operands.map((operand) => leaves(operand.value));
      return parts.every((part): part is string[] => !!part) ? parts.flat() : null;
    }
    const only = pred.operands.length === 1 ? pred.operands[0]!.value : undefined;
    return typeof only === 'string' ? [only] : null;
  };
  const [start, pred] = step.args.map((arg) => arg.value);
  if (step.args.length === 2 && typeof start === 'string') { const rest = leaves(pred); return rest && [start, ...rest]; }
  if (step.args.length === 1) { const rest = leaves(start); return rest && [null, ...rest]; }
  return null;
}

/**
 * `where(k, P(k2…)).by(b…)` / `where(P(k…)).by(b…)` — the ALIAS COMPARE, its `by()` values as JOIN COLUMNS
 * (`byValues`' move): each operand's `by()` runs on a FRESH traverser on the element its label names (the current
 * traverser for a bare form), so each (operand, body) pair is landed ROOTED there (`LandedRoot`), and the compare
 * itself — the ring, the predicate tree, the productivity rule — is the host's own lowering over the joined
 * relation. As in `byValues`, a body the host's seam answers as a correlated value keeps the dependent join.
 */
const aliasCompare: Connector = (site) => {
  const { step, rel, framing, ctx, fresh, labels } = site;
  const operands = whereOperands(step);
  if (!operands || !step.modulators?.length) return null;
  const seam = childSeam(ctx, fresh);
  const ring = modulations(step, step.modulators.length, seam);
  if (!ring?.length) return null;
  const bodies = new Map<string, readonly IRStep[]>();
  const roots = new Map<string, LandedRoot>();
  operands.forEach((label, i) => {
    const by = ring[i % ring.length];
    if (by?.key.kind !== 'child') return;
    const proj = label === null ? null : aliasProjection(rel, labels, label, 'last', fresh);
    if (label !== null && !isElementAlias(proj)) return;
    if (label === null && framing.kind !== 'elements') return;
    const root: LandedRoot = isElementAlias(proj)
      ? { id: aliasIdAt(col(rel.id, proj.entry.col), 'last'), elem: proj.read.elem }
      : { id: col(rel.id, 'id'), elem: (framing as Extract<RelFraming, { kind: 'elements' }>).elem };
    const host: ChildHost = isElementAlias(proj)
      ? aliasElementHost(rel, proj, freshTraverserRow(rel))
      : { kind: 'element', id: root.id, elem: root.elem, row: freshTraverserRow(rel) };
    if (seam.scalar(by.key.body, host)) return;
    const key = landedKey(by.key.body, rootTag(root.id, rel.id));
    bodies.set(key, by.key.body);
    roots.set(key, root);
  });
  const tail = landedStep(site, bodies, roots);
  if (!tail) return null;
  // Nothing landed, nothing to shed: the host's own compare over its input, continued as it is.
  return bodies.size ? afterLanded(site, tail)
    : continueAs(tail.rel, tail.framing, site.steps, site.at + 1, tail.bulked, site.ctx, site.fresh, tail.aliases);
};

/** A pool as ONE traverser standing for all of them — no value, every member's state dropped, a bulk that is the
 *  pool's traverser count (its members' bulks summed, one each where it carries none). A scalar aggregate, so a
 *  pool decorrelated against its keys is one row per key. */
function poolWeight(pool: Rel, fresh: Minter): Rel {
  const bulk = pool.channels.find((channel) => channel.role === 'bulk');
  const weight: Expr = bulk ? { kind: 'agg', fn: 'sum', args: [col(pool.id, bulk.col)] } : { kind: 'agg', fn: 'count', args: [] };
  const total = make.aggregate({
    id: fresh('pgb'), input: pool, channels: [], type: typeOf(meta('n', 'int')), groupBy: [], aggs: [['n', weight]],
  });
  return make.project({
    id: fresh('pgw'), input: total, channels: BULK, type: typeOf(meta(BULK[0]!.col, 'int')), exprs: [[BULK[0]!.col, col(total.id, 'n')]],
  });
}

/**
 * `group().by(k).by(b)` — the VALUE body POOLED PER KEY. `Grouping` runs every traverser of a key up to the value
 * traversal's first barrier into ONE pool and reduces it there (`determineBarrierStep`, `doFinalReduction`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125`;
 * `GroupStep.projectTraverser`, `…/step/map/GroupStep.java:118-143`), so the value's SCOPE is the key, not the
 * traverser: the domain is the stream's distinct keys (`groupKeyTerms`, the equality `groupMap` keys by), the body
 * is lowered once over ONE key's members — the input filtered to that key, correlated to one domain row — and
 * decorrelated against the domain. Its barrier is then grouped by the key by construction (S2), and a seeded one
 * keeps its seed for a key whose pool reduced to nothing (S3: `fold()` → `[]`, `count()` → 0); an unseeded one
 * (`sum()`) emits nothing and the key is absent, `GroupStep`'s `hasNextBarrier` false. A body with NO barrier
 * takes each traverser's first value and keeps the last (`Operator.assign`), which is not a pool: it is landed per
 * traverser (`perTraverserSlot`, `byValues`) and the host's own group lowering assigns it.
 * The key `by()` is the host's own (a child key is landed as a join column first, `landValues`).
 *
 * Split at the MEMBERS: what is built here is each traverser beside its key (the site's), and the reduction
 * (`reduceFrom`) is a recipe over members alone, so a keyed `group("a")` registers the members and its reader
 * reduces every site's members once (`PoolRecipe`, `collection.ts`).
 */
function poolMembers(site: HostSite, bys: readonly (Modulation | undefined)[]): PoolMembers | null {
  const { step, framing, ctx, fresh, labels } = site;
  // A KEYED group's map is the ROOT's (a side effect resolves through the root traversal, `AggregateStep.java:57`),
  // so a branch merge's ordering key (`branchKey` — an arm's frozen input position, which a body must never
  // partition by) says nothing about which pool a member joins: its members shed it.
  const branchKeys = step.args.length ? site.rel.channels.filter((channel) => channel.role === 'branchKey') : [];
  const rel = branchKeys.length ? shedChannels(site.rel, branchKeys, fresh) : site.rel;
  if (framing.kind !== 'elements' && framing.kind !== 'scalar') return null;
  const valueBy = bys[1]!;
  if (valueBy.key.kind !== 'child' || valueBy.order !== undefined) return null;
  let body = valueBy.key.body;
  // The POOL exists only where the value traversal has a `Barrier` (`isValueBarrier`, the step `determineBarrierStep`
  // stops at); without one each traverser's first value is assigned, last wins — landed per traverser by `byValues`.
  if (!body.some(isValueBarrier)) return null;
  // A DRAW in the value body (`sample()`, `coin()`, `order().by(shuffle)`) is a pick per traverser the pool —
  // one evaluation per key — cannot reproduce. Declined, and named in the user's terms.
  if (nondeterministic(body, ctx.params)) {
    ctx.declines.note(drawInGroupValue);
    return null;
  }
  // Only what runs BEFORE the barrier is per traverser in the reference (`GroupStep` pushes each traverser
  // through the value traversal's pre-barrier part, `Grouping.determineBarrierStep`); the pool lowers the whole
  // body over the key's members at once, so a form that would differ stays the host's own arm:
  // - a barrier NESTED in the pre-barrier part (`union(out().order().limit(2))`) — it cuts per traverser there,
  //   across the whole pool here.
  // A `tail(n)` first is a `limit(n)` of the pool: as a group's barrier its per-key merge is a
  // `RangeBiOperator(n)` keeping the FIRST n arrivals
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TailGlobalStep.java:129-131),
  // which is what a cut of the pool by arrival is — `group().by(label).by(tail())` is the key's first member.
  const cut = body.findIndex(isValueBarrier);
  // Only where the tail reads the MEMBERS themselves (`by(tail(n))`, nothing before it): each member contributes
  // itself, so the merge is the first n members. After a fan-out (`constant([1,2,1,3]).unfold().tail(2)`) each
  // member contributes ITS OWN last n before the merge, which the pool's tail over all members answers for a
  // key of one member and no rewrite here states for several (residue, docs/2026-11-15-compositional-coverage-plan.md cc3c).
  if (body[cut]!.name === 'tail' && cut === 0) {
    const tail = body[cut]!;
    const limit: IRStep = { ...tail, name: 'limit', args: tail.args.length ? tail.args : [{ value: 1, type: 'int' } as IRStep['args'][number]] };
    body = [...body.slice(0, cut), limit, ...body.slice(cut + 1)];
  }
  // Only a branch's arms are GLOBAL children (`BranchStep`/`UnionStep` run every traverser through one arm
  // traversal); a per-traverser host's body (`project().by`, `map`, `where`) is applied to one traverser at a
  // time in the pool too.
  // A barrier inside such an arm cuts PER TRAVERSER in the reference, so the part before the group's barrier is
  // then applied to each member on its own (`perMember`, below) and only the rest runs over the key's pool. A lone
  // `order()` there changes only the members' order, which is §17's "sorted together" divergence; anything that
  // cuts or collapses (`limit`, `range`, `dedup`, a reducer) changes WHICH members there are.
  const GLOBAL_ARMS = new Set(['union', 'choose', 'branch']);
  const perMember = body.slice(0, cut).some((s) => GLOBAL_ARMS.has(s.name)
    && someStepDeep([s], ctx.params, (inner) => inner !== s && inner.name !== 'order' && isValueBarrier(inner), true));
  // An enclosing per-traverser scope's key would have to ride every pool as one more group key; it declines.
  if (rel.channels.some((channel) => channel.role === 'origin' || channel.role === 'branchKey')) return null;
  // THE KEY: the host's own by() vocabulary over the (possibly value-landed) relation.
  const keyBy = bys[0] && !(bys[0].key.kind === 'identity' && bys[0].order === undefined) ? bys[0] : undefined;
  const keyBodies = keyBy ? perTraverserBodies(step, [keyBy]) : new Map<string, readonly IRStep[]>();
  const landed = keyBodies.size ? landValues(rel, framing, keyBodies, ctx, fresh, labels) : { over: rel, values: new Map<string, ChildValue>() };
  if (!landed) return null;
  const over = landed.over;
  const keyCtx: ChainCtx = keyBodies.size ? { ...ctx, scopedValues: { over: over.id, values: landed.values } } : ctx;
  const host = reductionHost(over, framing, labels);
  const keyElem = !keyBy && framing.kind === 'elements' ? framing.elem : undefined;
  const keyExpr = keyElem ? col(over.id, 'id') : byNode(keyBy ?? { key: { kind: 'identity' } }, host, ctx.source, fresh, childSeam(keyCtx, fresh));
  if (!keyExpr) return null;
  // Every member beside its key, the key computed ONCE (fenced): the domain and the pools both read it.
  const own = rel.type.cols;
  // A KEYED form's member layout is named, not minted: a second site's members union onto the first by name.
  const KEY = (step.args.length ? 'pool_key' : fresh('pgk')) as string;
  const withKey = make.materialize({
    id: fresh('pgm'), channels: rel.channels, type: typeOf(...own, meta(KEY, keyElem ? 'int' : 'json', true)),
    input: make.project({
      id: fresh('pgp'), input: over, channels: rel.channels, type: typeOf(...own, meta(KEY, keyElem ? 'int' : 'json', true)),
      exprs: [...own.map((column) => [column.name, col(over.id, column.name)] as const), [KEY, keyExpr] as const],
    }),
  });
  // An unproductive key drops its traverser, unless `ProductiveByStrategy` keeps it under null.
  const keyKeep = productivityFilter(step, 'value-nullness', col(withKey.id, KEY));
  if (!keyKeep) return null;
  const kept = keyKeep.keep
    ? make.filter({ id: fresh('pgf'), input: withKey, channels: withKey.channels, type: withKey.type, pred: keyKeep.keep })
    : withKey;
  // Each member's EQUALITY TERMS (`groupKeyTerms`) computed ONCE, as stored columns: the domain groups by them
  // and the pool joins on them, so the pool is an equi-join SQLite can index rather than a recomputed
  // expression compared across every (key, member) pair — which was quadratic in the member count (measured:
  // `group().by('name').by(both().count())` ran for minutes at 8k vertices).
  const terms = groupKeyTerms(col(kept.id, KEY), !!keyElem);
  const memberCols = terms.map((_, i) => meta((step.args.length ? `pool_term${i}` : fresh('pgu')) as string, 'any', true));
  const termedType = typeOf(...kept.type.cols, ...memberCols);
  const members = make.materialize({
    id: fresh('pgw'), channels: kept.channels, type: termedType, fenced: true,
    input: make.project({
      id: fresh('pgv'), input: kept, channels: kept.channels, type: termedType,
      exprs: [...kept.type.cols.map((column) => [column.name, col(kept.id, column.name)] as const),
        ...memberCols.map((column, i) => [column.name, terms[i]!] as const)],
    }),
  });
  // THE REDUCTION — everything from here runs over the pool's MEMBERS, which the collection's reader may hand back
  // as several sites' members (`PoolRecipe`, `collection.ts`): it reads nothing of this site but their layout.
  const reduceFrom = (members: Rel, fresh: Minter): GroupedMap | null => {
    // THE DOMAIN: one row per key under the grouping's own equality, the first arrival's key node naming it.
    const termCols = memberCols.map(() => meta(fresh('pgt') as string, 'any', true));
    const enc = encounterOf(members.channels);
    const domain = make.aggregate({
      id: fresh('pgd'), input: members, channels: [], type: typeOf(...termCols, meta(KEY, keyElem ? 'int' : 'json', true)),
      groupBy: memberCols.map((column) => col(members.id, column.name)),
      aggs: [[KEY, firstArrival(col(members.id, KEY), enc ? [col(members.id, enc.col)] : [])]],
    });
    const sc = scope(domain, fresh);
    // THE POOL'S TRAVERSERS: the members themselves — or, where the pre-barrier part must run per member
    // (`perMember`), each member's own results of it: that part lowered as a `local()` body over the members (the
    // connector's `forward` rejoin, host-major then the body's order), each result keeping its member's key terms
    // as host-only channels, and the pool continuing from the barrier.
    let source: Rel = members;
    let sourceFraming: RelFraming = framing;
    let rest: readonly IRStep[] = body;
    let restBulked = site.bulked;
    if (perMember) {
      const prefix = body.slice(0, cut);
      const keyChannels = memberCols.map((column): Channel => ({ col: column.name, role: 'branchKey' }));
      // The member as the traverser it is (its own columns — the key node is not its payload) plus its key terms.
      const hostCols = [...own, ...memberCols];
      const asHost = make.project({
        id: fresh('pgh'), input: members, channels: keyChannels.reduce(withChannel, rel.channels), type: typeOf(...hostCols),
        exprs: hostCols.map((column) => [column.name, col(members.id, column.name)] as const),
      });
      const frozen = freezeParent(positioned(asHost, fresh), fresh);
      const msc = scope(frozen.rel, fresh);
      const keyedPrefix = scopedBody(prefix, frozen.rel, framing, msc, ctx, fresh, labels, 'read', !isReductionArm(prefix));
      const out = keyedPrefix && rejoin(msc, msc.scoped, keyedPrefix, frozen.rel, 'forward', false, ctx, fresh, labels, true);
      const merged = out && mintBranchOrder([{ ...out, bulked: site.bulked || out.bulked }], frozen.parent, labels, ctx.source, fresh);
      if (!out || !merged || !memberCols.every((column) => merged.rel.type.cols.some((c) => c.name === column.name))) return null;
      source = merged.rel;
      sourceFraming = merged.framing;
      rest = body.slice(cut);
      restBulked = site.bulked || out.bulked;
    }
    // ONE KEY'S POOL: the members whose key is the domain row's, as the traverser stream the body starts from.
    const pooled = make.filter({
      id: fresh('pgs'), input: source, channels: source.channels, type: source.type,
      // NULL-safe (`IS`): a term may be NULL for every member of a key (a string key has no family tag).
      // Non-empty: `groupKeyTerms` always yields at least one term.
      pred: conjoin(memberCols.map((column, i): Expr => ({ kind: 'binary', op: 'is', left: col(source.id, column.name), right: col(sc.scoped.id, termCols[i]!.name) })))!,
    });
    const termNames = new Set(memberCols.map((column) => column.name));
    const seedChannels = source === members ? rel.channels : source.channels.filter((channel) => !termNames.has(channel.col));
    const seedCols = source === members ? own : source.type.cols.filter((column) => !termNames.has(column.name));
    const seed = make.project({
      id: fresh('pgn'), input: pooled, channels: seedChannels, type: typeOf(...seedCols),
      exprs: seedCols.map((column) => [column.name, col(pooled.id, column.name)] as const),
    });
    const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: rest, rooted: false }, originDomain: undefined, bodyOrder: 'read' };
    // A pool that RE-SOURCES first (`group().by(label).by(__.V().count())`) discards every member's value: each
    // member splits into the whole graph (`GraphStep`), so where the rest reads none of a member's own state
    // (`readsHostState`) the pool is ONE traverser of bulk |pool| — the multiset is the same, and the graph is
    // crossed once per KEY rather than once per member. Only where everything after the re-source READS that
    // multiplicity (`bulkObservedFrom`, the one positional authority — a `count()`/`sum()` does, a `fold()` reads
    // rows); otherwise every member crosses the graph, as the reference does.
    const weighed = reSourceAt(rest) === 0 && !readsHostState(rest, bodyCtx) && bulkObservedFrom(rest, 1) ? poolWeight(seed, fresh) : null;
    // THE KEY PROJECTION: the domain is the members' DISTINCT key terms, so the body keys the pool by those terms
    // read off the pool's traversers themselves — no domain cross join. The members COVER the domain (every key
    // has one), so no LEFT JOIN either; a per-member prefix's results need not (a key whose members all produced
    // nothing), and keep it. `src/rel/decorrelate.ts` "The domain that IS its input's key projection".
    const projection: KeyProjection = {
      input: source.id, cols: new Map(termCols.map((column, i) => [column.name, memberCols[i]!.name])), covers: source === members,
    };
    // The pool and its seed are the HOST's (minted outside `keyedBody`); only what `rest` builds is the body's own.
    const pool = keyedBody(
      (mf, collections) => weighed
        ? continueAs(weighed, sourceFraming, rest, 0, true, { ...bodyCtx, collections }, mf, labels)
        : continueAs(seed, sourceFraming, rest, 0, restBulked, { ...bodyCtx, collections }, mf, labels),
      sc.scoped, sc.key, ctx, fresh, undefined, projection,
    );
    if (!pool) return null;
    const { keyed, tail } = pool;
    // THE VALUE NODE: the reduced value of the key's pool, one row per key (a FIRST, for a body whose last
    // barrier is not its last step and could still fan out — `doFinalReduction` reads `next()`).
    const valueCols = framingCols(tail.framing);
    if (!valueCols || valueCols.length > (tail.framing.kind === 'scalar' ? 2 : 1)) return null;
    const first = rowsKeyedBy(keyed.rel, tail.rel, keyed.key.map((k) => k.col), valueCols.map((column) => column.name), fresh, true);
    const joined = make.join({
      id: fresh('pgj'), left: sc.scoped, right: first.rel, join: 'inner', channels: [],
      type: typeOf(...sc.scoped.type.cols, ...first.rel.type.cols),
      on: keyMatch(keyed.key, (k) => col(sc.scoped.id, k.outer), (k) => col(first.rel.id, first.keys[keyed.key.indexOf(k)]!)),
    });
    const valueExpr = col(joined.id, first.renamed.get(valueCols[0]!.name)!);
    const produced: ChildValue = {
      expr: valueExpr, framing: tail.framing, yields: 'one', present: 'always',
      ...(valueCols[1] ? { vtype: col(joined.id, first.renamed.get(valueCols[1].name)!) } : {}),
    };
    const valueFraming = tail.framing;
    // A list value is NESTED in the map, so its static member type rides on its node (`staticMemberTag`) — and
    // be members the tree framer can walk (`listNodeExpr`): a path member has no `{t:'path'}` node yet.
    if (valueFraming.kind === 'list' && !treeFramed(valueFraming.of)) return null;
    // …and a MAP value keeps its element rowids for the root framer, which expands them through `singleOf`
    // (`mapNodePayload`, recursive over a nested map); any other value shape is not one this node builder states.
    if (valueFraming.kind !== 'list' && valueFraming.kind !== 'map' && valueFraming.kind !== 'scalar' && valueFraming.kind !== 'elements') return null;
    const node = valueFraming.kind === 'list' ? listNode(valueExpr, staticMemberTag(valueFraming.of)) : memberNodeOf(produced, ctx.source, fresh);
    if (!node) return null;
    const singleOf: MapOf = valueFraming.kind === 'list' ? { kind: 'list', of: valueFraming.of, ...(valueFraming.set ? { set: true } : {}) }
      : valueFraming.kind === 'map' ? { kind: 'map', of: valueFraming.valOf } : { kind: 'scalar' };
    return keyedValuesMap(joined, col(joined.id, KEY), keyElem, node, singleOf, step, ctx.source, fresh);
  };
  // THE RECIPE'S MEMBERS, as the reader hands them back: one site's own relation is the pool as it is; anything
  // else (several sites' `UNION ALL`, a body's site keyed per host row) is re-expressed in the members' layout —
  // their channels, their columns — with the ENCOUNTER re-minted from the order the reader states (site, then that
  // site's own position), which is what the first arrival naming a key and a collecting value read. Fenced once:
  // the domain and every pool read it.
  const encounter = encounterOf(members.channels);
  const restored = (input: Rel, order: readonly string[], fresh: Minter): Rel => {
    if (input === members) return members;
    const renumber = encounter && order.length ? `${encounter.col}_n` : undefined;
    const ordered = renumber
      ? rowNumberWindow(input, renumber, [], { partitionBy: [], orderBy: order.map((name) => ({ expr: col(input.id, name), dir: 'asc' as const })) }, fresh)
      : input;
    const read = (name: string): Expr => col(ordered.id, renumber && name === encounter!.col ? renumber : name);
    return make.materialize({
      id: fresh('pgr'), channels: members.channels, type: members.type, fenced: true,
      input: make.project({
        id: fresh('pgq'), input: ordered, channels: members.channels, type: members.type,
        exprs: members.type.cols.map((column) => [column.name, read(column.name)] as const),
      }),
    });
  };
  // What makes two sites one grouping, as data: the step's key and value by()s (`bodyKey`, the structural spelling
  // a landed body is matched by, without its parse context), the member layout, the bulk.
  const identity = poolIdentity(step, bys, members, framing, site.bulked);
  return {
    members,
    order: encounter ? [encounter.col] : [],
    recipe: {
      identity, cols: members.type.cols.map((column) => column.name),
      reduce: (input, order, fresh) => reduceFrom(restored(input, order, fresh), fresh),
    },
  };
}

/**
 * A pool's IDENTITY (`PoolRecipe.identity`) — two sites are one grouping only where this agrees: the step, its
 * resolved key and value `by()`s, the member layout and the bulk. Spelled as `bodyKey` spells a body, except that a
 * step's own parse context is not structure (it is where the step was written, so two arms writing the same
 * grouping would never agree) and a nested parse tree spells as its text.
 */
function poolIdentity(
  step: IRStep, bys: readonly (Modulation | undefined)[], members: Rel, framing: RelFraming, bulked: boolean,
): string {
  const seen = new WeakSet<object>();
  return JSON.stringify([step.name, step.args.map((arg) => arg.value), bys, members.type.cols, members.channels, framing, bulked],
    (key, value: unknown) => {
      if (key === 'ctx') return undefined;
      if (typeof value === 'bigint') return `${value}n`;
      if (value && typeof value === 'object') {
        const text = (value as { getText?: unknown }).getText;
        if (typeof text === 'function') return `«${String(text.call(value))}»`;
        if (seen.has(value)) return '[seen]';
        seen.add(value);
      }
      return value;
    });
}

/** `rel` without the carried `channels` — their columns and roles forgotten, every other column and the rows
 *  untouched (`dropEncounter`'s shape, for any channel). */
function shedChannels(rel: Rel, channels: readonly Channel[], fresh: Minter): Rel {
  const shed = new Set(channels.map((channel) => channel.col));
  const cols = rel.type.cols.filter((column) => !shed.has(column.name));
  return make.project({
    id: fresh('pgx'), input: rel, channels: rel.channels.filter((channel) => !shed.has(channel.col)),
    type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(rel.id, column.name)] as const),
  });
}

/** A pooled group's MEMBERS and the recipe that reduces them (`poolMembers`). */
interface PoolMembers {
  readonly members: Rel;
  readonly order: readonly string[];
  readonly recipe: PoolRecipe;
}

/** `group().by(k).by(b)`'s map over ONE site's pool — the members reduced where they are. */
function pooledGroupMap(site: HostSite, bys: readonly (Modulation | undefined)[]): GroupedMap | null {
  const pool = poolMembers(site, bys);
  return pool && pool.recipe.reduce(pool.members, pool.order, site.fresh);
}

/** The UNKEYED pooled `group().by(k).by(b)` — a reducing barrier: the map IS the traverser. */
function pooledGroup(site: HostSite, bys: readonly (Modulation | undefined)[]): Tail | null {
  const { steps, at, ctx, fresh } = site;
  const grouped = pooledGroupMap(site, bys);
  return grouped && continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, at + 1, false, ctx, fresh, NO_ALIASES);
}

/**
 * The KEYED pooled `group("a").by(k).by(b)` — a SIDE EFFECT: the same map `pooledGroupMap` builds for the
 * barrier form, registered under its label through the host's own keyed tail (`keyedGroupTail`, `lower.ts` —
 * one authority for registration, drain and re-entry, with its guards), and the stream continues as the
 * INCOMING traversers (`GroupSideEffectStep` passes them on). What is registered is the pool's MEMBERS
 * (`poolMembers`), so a second site on the label — another branch arm — unions its members onto them, and a site
 * in a connector body is keyed per host row like any collector's; the ONE reduction runs at the reader.
 *
 * A reduction that can RAISE must be evaluated whether or not a `cap` reads it (`drainRaisingSite`), and its drain
 * is the finished map itself (`takeFinishedMap`): such a site registers that map, one site, at the root.
 * A value that is exactly `count()` needs no pool at all (`keyedCount`): it registers groupCount's counting rows.
 */
function keyedPooledGroup(site: HostSite): Tail | null {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.name !== 'group' || step.args.length !== 1 || typeof step.args[0]!.value !== 'string') return null;
  const bys = modulations(step, byArity(step), childSeam(ctx, fresh));
  if (!bys || bys[1]?.key.kind !== 'child') return null;
  const rows = keyedCount(site, bys[1].key.body) ?? keyedPool(site, bys);
  if (!rows) return null;
  const onward = (from: number): Tail | null => continueAs(rel, framing, steps, from, bulked, ctx, fresh, labels);
  const out = keyedGroupTail(step, rel, rows, at, ctx, fresh, onward);
  return out === 'continue' ? onward(at + 1) : out.tail;
}

/**
 * A keyed value that is exactly `count()` (`countsTraversers`) is SPLITTABLE: each site contributes the counting
 * recipe's `(key, contribution)` rows — `groupCount("a")`'s own — and the reader sums them per key. Decided by the
 * value body, not by how many sites the label has, so a lone site and the Nth agree and nothing looks ahead.
 * No member spool, no first-arrival domain and no regroup: a count has no per-member state to keep.
 */
function keyedCount(site: HostSite, body: readonly IRStep[]): GroupRows | null {
  const { step, rel, framing, bulked, ctx, fresh, labels } = site;
  if (!countsTraversers(body) || (framing.kind !== 'elements' && framing.kind !== 'scalar')) return null;
  return groupRows(rel, reductionHost(rel, framing, labels), step, bulked, childSeam(ctx, fresh), ctx.source, fresh);
}

/** Any other pooled keyed value registers its MEMBERS and the recipe that reduces them (`poolMembers`) — or, for a
 *  reduction that can RAISE, the finished map (see `keyedPooledGroup`). */
function keyedPool(site: HostSite, bys: readonly (Modulation | undefined)[]): GroupRows | null {
  const { step, fresh } = site;
  const pool = poolMembers(site, bys);
  if (!pool) return null;
  const done = pool.recipe.reduce(pool.members, pool.order, fresh);
  if (!done) return null;
  return mayRaise(done.rel)
    ? { rel: done.rel, recipe: POOLED_RECIPE(step), done }
    : { rel: pool.members, recipe: POOLED_RECIPE(step), pool: { recipe: pool.recipe, order: pool.order } };
}

/**
 * `sideEffect(b)` — the host stream passes through UNCHANGED, and the body is lowered only for what it COLLECTS.
 * `TraversalSideEffectStep` drains its child over a split of each traverser and emits the traverser itself
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/TraversalSideEffectStep.java:46-49`),
 * so nothing the body does to its own traverser comes back; what does is its side effects. The body is keyed
 * like any connector body, and `keyedBody` commits its collectors' sites — one relation over every scope, at
 * the collector's position in the body, ordered host-major. A body with no effect never reaches here
 * (`dropEffectFreeSideEffect`); one whose effect is not a collected site (a write, a raise) declines in
 * `keyedBody`, and so does one that collected nothing — the effect it had would otherwise be silently dropped.
 */
const drained: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const body = singleBody(step, ctx);
  if (!body) return null;
  const sc = scope(rel, fresh);
  const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'free', false, undefined, 'forward');
  if (!keyed || !keyed.collected) return null;
  return continueAs(unscoped(sc.scoped, rel, fresh), framing, steps, at + 1, bulked, ctx, fresh, labels);
};

/** THE CONNECTOR TABLE — one row per host, keyed by step name (§2 S4). */
const CONNECTORS: ReadonlyMap<string, Connector> = new Map<string, Connector>([
  ['where', (site) => (whereOperands(site.step) ? aliasCompare(site) : existence(false)(site))],
  ['filter', existence(false)],
  ['and', existence(false)],
  ['or', existence(false)],
  ['flatMap', allRows('split')],
  ['choose', chooseRoute],
  ['union', globalArms],
  ['local', allRows('forward')],
  ['not', existence(true)],
  ['map', firstInner],
  ['coalesce', priority],
  ['optional', priority],
  ['project', recordLeft],
  ['order', byValues],
  ['dedup', byValues],
  ['groupCount', byValues],
  ['group', byValues],
  ['sideEffect', drained],
]);

// The chain facts seed a path for a connector body that reads one (`CONNECTOR_HOSTS`, `ir/analyze.ts`), so the
// two host sets are one fact — kept equal here, loudly, rather than by a reader's care.
if (CONNECTORS.size !== CONNECTOR_HOSTS.size || [...CONNECTORS.keys()].some((name) => !CONNECTOR_HOSTS.has(name)))
  throw new Error('RelIR lowering: CONNECTORS and CONNECTOR_HOSTS (ir/analyze.ts) name different hosts');

/** Is the HOST'S OWN TAIL lowering this connector site right now (`ChildStrategy.hostTailAt`)? Then a tail must
 *  not hand it back to `continueAs`. */
export const atHostTail = (ctx: ChainCtx, steps: readonly IRStep[], at: number): boolean =>
  ctx.hostTailAt?.steps === steps && ctx.hostTailAt.at === at;

/** Is `step` a site a connector may own? The cheap gate a tail loop asks before yielding to `continueAs`. */
export const connectorSite = (step: IRStep | undefined): boolean =>
  !!step && CONNECTORS.has(step.name) && (step.name === 'project' || step.args.some((arg) => isNested(arg.value))
    || (step.modulators ?? []).some((by) => by.some(isNested)));

/**
 * The hosts with a TAIL LOWERING OF THEIR OWN — the one a connector site falls back to where its row does not
 * claim the site. The row CLAIMS it over an element or scalar stream (and `project` over a PROPERTY row, which
 * `recordLeft` reads through `reductionHost`): there the row is the step's one lowering. (`order`/`dedup`/
 * `groupCount`/`group` still reach their tail there — `byValues` hands it the landed `by()` values, the
 * connector's own use of it — but the tail never answers the site ALONE, correlating its `by()` bodies itself.)
 * Over any other framing the host's own lowering is the fallback (a `group()` over a property stream, an
 * `order(local).by(…)` over a list), and so it is for a step FORM the row does not claim: an ARGUMENT changes
 * what a `by()` runs over (`dedup("a")`, a keyed `groupCount("m")` — `byValues` leaves both to the host).
 * `map`/`flatMap`/`local`/`sideEffect` have no tail of their own: the connector is their one lowering.
 */
const TAILED_HOSTS: ReadonlySet<string> = new Set(['project', 'order', 'dedup', 'groupCount', 'group', 'coalesce', 'optional', 'choose', 'union', ...FILTER_HOSTS]);
/** The hosts whose connector row (`byValues`) claims only the argument-free form. */
const BY_VALUE_HOSTS: ReadonlySet<string> = new Set(['order', 'dedup', 'groupCount']);
const claimed = (step: IRStep, framing: RelFraming): boolean =>
  (framing.kind === 'elements' || framing.kind === 'scalar' || (framing.kind === 'property' && step.name === 'project'))
  && (!BY_VALUE_HOSTS.has(step.name) || !step.args.length);
/** Does this site fall back to its host's own tail? Not where the row claims it, and not for a body that
 *  re-sources (`connectorOwns`). */
const hostTailed = (step: IRStep, framing: RelFraming, ctx: ChainCtx): boolean =>
  TAILED_HOSTS.has(step.name) && !claimed(step, framing) && !connectorOwns(step, ctx);

/**
 * The dispatch at a connector site: the connector, then — where the row does not claim the site — the host's own
 * tail lowering of the step (`hostTail`), which reads its `by()`/argument bodies through the child seam.
 * `undefined` where `steps[at]` is not a connector site. There is no ladder: the per-traverser route the old
 * `correlatedChild` switch ordered against the connector is deleted (`docs/archive/2026-11-16-ladder-retirement-plan.md` R7).
 */
export function scopedHost(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], at: number, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap, hostTail: (ctx: ChainCtx) => Tail | null,
): Tail | null | undefined {
  const step = steps[at];
  if (!connectorSite(step)) return undefined;
  const connector = CONNECTORS.get(step!.name)!;
  // The bodies' unroll provenance, as the hosts' own lowering records it, so a width or size decline names the
  // repeat() and the host it could move out of (`noteUnrolled`).
  for (const arg of step!.args) if (isNested(arg.value)) {
    noteUnrolled(bodyOf(arg.value.nested, ctx.params, ctx.sideEffects), ctx, FAN_OUT_HOSTS.has(step!.name) ? step!.name : null);
  }
  const scoped = (under: ChainCtx): Tail | null => connector({ step: step!, rel, framing, steps, at, bulked, ctx: { ...under, host: step!.name }, fresh, labels });
  const routes = hostTailed(step!, framing, ctx) ? [scoped, hostTail] : [scoped];
  // Each route records its decline reasons into its OWN sink (`Declines.fork`): the reasons of the route that
  // answered are kept, and a route that declined while the other answered leaves none.
  // Each route is also a TRANSACTION over the named collections: a body's side-effect sites are committed as its
  // body keys (`keyedBody`), so a route that then declines puts the registry back, and the snapshots a route's
  // bodies took (`siteEffects`) enter the effect sequence HERE, at the host's position, only for the route that
  // answered.
  // Whether any route got PAST the host (`continueAs` marks the site): where none did, the host declined itself,
  // and it records that here, into this site's sink, so it reaches the compile exactly as far as this site's own
  // reasons do (`fork`/`adopt`) — what names a write in its body as the reason (`lowerChain`).
  const hostProgress: HostProgress = { steps, at, continued: false };
  const tried: Declines[] = [];
  // …and so are the collectors a body's fork REFUSED (`refuseSite`): a route that answered means none of them is
  // why the body declines.
  const refusals = refusalMark(ctx.collections);
  for (const route of routes) {
    const sink = ctx.declines.fork();
    const saved = new Map(ctx.collections);
    const siteEffects: Binding[] = [];
    const tail = route({ ...ctx, declines: sink, siteEffects, hostBulked: bulked, hostProgress });
    if (tail) {
      ctx.declines.adopt(sink);
      dropRefusals(ctx.collections, refusals);
      return siteEffects.length ? { ...tail, effects: [...siteEffects, ...(tail.effects ?? [])] } : tail;
    }
    restoreCollections(ctx.collections, saved);
    tried.push(sink);
  }
  for (const sink of tried) ctx.declines.adopt(sink);
  if (!hostProgress.continued) ctx.declines.hostDeclined(step!);
  return null;
}

