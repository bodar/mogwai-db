import { isNested, isPred } from '../../../gremlin/frontend.ts';
import { and, col, compilerInt, compilerNull, eq, isNot, or, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import { decorrelate, keyMatch, type KeyProjection } from '../../../rel/decorrelate.ts';
import { positionKeys } from '../../../rel/position.ts';
import { atMostOneRow, exactlyOneRow } from '../../../rel/bounds.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta, RelId, SortTerm } from '../../../rel/types.ts';
import { exprHasSubquery, exprRels, forEachExpr, forEachRel, freeRelIds, isSelfContained, relExprs, rewriteExpr, substRelId } from '../../../rel/walk.ts';
import { columnIsRowKey, columnIsStored, columnReadsSubquery, spelledOuterColumns } from '../../../rel/copies.ts';
import { withChannel, type Channel, type ChannelRole } from '../../../channels.ts';
import type { AliasMap } from '../../alias.ts';
import { aliasElementHost, aliasIdAt, aliasProjection, isElementAlias } from '../alias.ts';
import { freshTraverserRow } from '../child.ts';
import type { Elem } from '../../elem.ts';
import type { ChildHost, ChildValue } from '../child.ts';
import { isLocalScope, nondeterministic, traversalIdArg, type IRStep } from '../../ir/step.ts';
import type { ListOf, MapOf } from '../../../sql/kernel/render.ts';
import { groupKeyTerms, isValueBarrier, keyedValuesMap, mapHoldsRowids, mapNodePayload } from '../map.ts';
import { selfDescribingList } from '../list.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { bulkObservedFrom } from '../../ir/bulk.ts';
import { CONNECTOR_HOSTS } from '../../ir/analyze.ts';
import { firstArrival, listNode, mapNode, meta, payloadCols, rowNumberWindow, typeOf, type Minter } from '../build.ts';
import { framingCols, perTraverserFraming, type RecordField, type RelFraming } from '../framing.ts';
import { branchOrderOwed, continueAs, edgeFeedsOtherV, dropEncounter, dropPath, freezeParent, mintBranchOrder, positioned, withBranchEffects } from '../lower.ts';
import { chooseArms, coalesceArms, ensureBulk, isReductionArm, mergeArms, optionalArms, reconcileCollapsed, unionArms, type RoutedCondition } from './branch.ts';

import { byNode, isProductiveBy, memberNodeOf, modulations, productivityFilter, type ByField, type Modulation } from '../modulator.ts';
import { appendValuePosition, extendPath, pathCarried } from '../path.ts';
import { recordOf, recordToMap } from '../record.ts';
import type { Declines } from '../../unsupported.ts';
import { BULK, bodyOf, ENCOUNTER, encounterOf, FROM_V, inBody, NO_ALIASES, noteUnrolled, type ChainCtx, type Tail } from './chain.ts';
import { childSeam, defaultCollation, perOriginWindow, readsHostState, reductionHost, rootedRead } from './reduction.ts';

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
// THIS IS THE DEFAULT AND THE AUTHORITY (the Phase 3 inversion). What is left of the ladder of specialised
// correlated routes is the opt-in `correlatedChild` switch: off (the default) the connector is tried first and
// the ladder is its fallback where it declines; on, the ladder is tried first. Either way the SUPPORTED set is
// the union of the two, so L5's per-switch differential compares the two lowerings wherever both answer.

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
  const order = selfContained ? [] : rel.type.cols.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const }));
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
 * correlated ladder does. `positionedSeed` asks for the position outright (a merge that numbers its arms).
 */
function lowerBody(
  body: readonly IRStep[], rel: Rel, from: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false, first = false,
): Tail | null {
  const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: body, rooted: false }, originDomain: undefined, ...(order ? { bodyOrder: order } : {}) };
  const positioned = positionedSeed || someStepDeep(body, ctx.params, (s) => s.name === 'tail');
  const run = (at: boolean): Tail | null => {
    const seed = seedRow(rel, from, fresh, at);
    const reSourced = reSourcedBody(seed, body, framing, bodyCtx, fresh, labels, first);
    return reSourced !== undefined ? reSourced : continueAs(seed, framing, body, 0, false, bodyCtx, fresh, labels);
  };
  const tail = run(positioned);
  if (order === 'read' && tail && !positioned && !encounterOf(tail.rel.channels) && !atMostOneRow(tail.rel)) return run(true);
  return tail;
}

/** The traverser state a re-source's split carries through unchanged (`reSourcedBody`). */
const CROSSES: ReadonlySet<ChannelRole> = new Set<ChannelRole>(['alias', 'sack', 'loops']);

/** Where a body RE-SOURCES at its top level — the first plain `V()`/`E()` (literal ids, not `V(<traversal>)`,
 *  whose ids come from the host) — or -1. */
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
 * `TopDownGeneralDecorrelator`), never a graph scan per host row. A FIRST-row consumer (`first`: `map`, a `by()`,
 * an existence test) needs only the read's first row — picked once, by the collation a per-scope pick uses
 * (`defaultCollation`) — so a host row costs one row however large the graph.
 *
 * PRESENCE IS A ROW: a productive null (`__.V().constant(null)`) is a row whose value is NULL, so `map()` keeps
 * the traverser (`TraversalMapStep` emits whenever the child `hasNext()`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java`).
 *
 * What it refuses, from the query text: a rest that reads the HOST traverser's state (its sack, path, loops or a
 * host label — `rootedRead`'s `readsHostState`: one shared evaluation cannot hold them), and a prefix of label
 * reads that may LOSE its row — the re-source discards the selected value, so the answer would depend only on
 * which rows matched: `admitsReSource`, the one explained rule the scalar seam asks too. Any other prefix that may
 * lose or multiply its row (`out().V()`, `values('age').V()`) is GraphStep's own cross join, in the fold.
 */
function reSourcedBody(
  seed: Rel, body: readonly IRStep[], framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap, first: boolean,
): Tail | null | undefined {
  const at = reSourceAt(body);
  if (at < 0) return undefined;
  const prefix: Tail | null = at === 0 ? { rel: seed, framing, aliases: labels, bulked: false }
    : continueAs(seed, framing, body.slice(0, at), 0, false, ctx, fresh, labels);
  if (!prefix || prefix.effects?.length) return null;
  // A prefix that may lose or multiply its row is GraphStep's own cross join, in the fold — which also asks the
  // explained admission rule of a discarded label read (`reSourceTail`'s `admitsReSource`).
  if (!exactlyOneRow(prefix.rel)) return undefined;
  // The prefix's carried state crosses unchanged — `head.split(element)` keeps the traverser's labels, sack and
  // loop counter (the rest reads none of them: `readsHostState`), and a seed position is replaced by the read's
  // own. A path is extended by the split and an entering vertex is a hop's: neither is a contract this cross
  // states (`reSource`, `lower/movement.ts`).
  if (!prefix.rel.channels.every((channel) => CROSSES.has(channel.role) || channel.role === 'encounter')) return null;
  const rooted = rootedRead(body.slice(at), ctx, fresh, 'many');
  if (!rooted || rooted.effects?.length) return null;
  // The read's own position and multiplicity ride; the sack and loop counter a FRESH start traverser holds are
  // superseded by the host's, which the split keeps. Any other state (a label, a path) is not this cross's.
  const own = rooted.rel.channels.filter((channel) => channel.role === 'encounter' || channel.role === 'bulk');
  if (!rooted.rel.channels.every((channel) => own.includes(channel) || (channel.role !== 'alias' && CROSSES.has(channel.role)))) return null;
  const read = first && !atMostOneRow(rooted.rel)
    ? make.limit({
      id: fresh('srl'), count: compilerInt(1), channels: rooted.rel.channels, type: rooted.rel.type,
      input: make.sort({ id: fresh('srs'), input: rooted.rel, channels: rooted.rel.channels, type: rooted.rel.type, terms: defaultCollation(rooted.rel) }),
    })
    : rooted.rel;
  const once = isSelfContained(read) ? make.materialize({ id: fresh('srm'), input: read, channels: read.channels, type: read.type, fenced: true }) : read;
  // The read's columns under fresh names beside the prefix's, then back under their own.
  const renamed = new Map(once.type.cols.map((column) => [column.name, fresh('srv') as string]));
  const right = make.project({
    id: fresh('srp'), input: once, channels: [], type: typeOf(...once.type.cols.map((column) => ({ ...column, name: renamed.get(column.name)! }))),
    exprs: once.type.cols.map((column) => [renamed.get(column.name)!, col(once.id, column.name)] as const),
  });
  const crossed = make.join({
    id: fresh('srj'), left: prefix.rel, right, join: 'cross', channels: [], type: typeOf(...prefix.rel.type.cols, ...right.type.cols),
  });
  const carried = prefix.rel.channels.filter((channel) => CROSSES.has(channel.role));
  const channels = carried.reduce(withChannel, own);
  const fromPrefix = new Set(carried.map((channel) => channel.col));
  const outCols = [...payloadCols(once), ...channels.map((channel) => (fromPrefix.has(channel.col) ? prefix.rel : once).type.cols.find((column) => column.name === channel.col)!)];
  const rel = make.project({
    id: fresh('srx'), input: crossed, channels, type: typeOf(...outCols),
    exprs: outCols.map((column) => [column.name, col(crossed.id, fromPrefix.has(column.name) ? column.name : renamed.get(column.name)!)] as const),
  });
  return { rel, framing: rooted.framing, aliases: prefix.aliases, bulked: !!rooted.bulked };
}

/** A host whose child body RE-SOURCES at its top level (and does not draw: `ladderOwns`) is the connector's alone
 *  (`reSourcedBody`): the ladder's re-source is a scalar first-row read that cannot tell a productive null from
 *  no row, so offering it as a route would answer the same query two ways. */
export const connectorOwns = (step: IRStep, ctx: ChainCtx): boolean => step.args.some((arg) => {
  if (!isNested(arg.value)) return false;
  const body = bodyOf(arg.value.nested, ctx.params, ctx.sideEffects);
  return !!body && reSourceAt(body) >= 0 && !ladderOwns(body, ctx);
});

/**
 * A body that both DRAWS and RE-SOURCES (`V()`/`E()`, at any depth) stays the ladder's, for a reason about the
 * QUERY TEXT: the read after a re-source is one relation shared by every host (`reSourcedBody`), so a draw over
 * it is one pick for all of them, and keying it per scope instead crosses every host with the whole graph — a
 * draw the ladder's `shared-draw` decline names. Any other drawing body is the connector's (`scopedBody`).
 */
const ladderOwns = (body: readonly IRStep[], ctx: ChainCtx): boolean =>
  nondeterministic(body, ctx.params) && someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true);

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

/** Step 2: the body, lowered as the root lowers a chain, then keyed by the scope. `null` declines. */
function scopedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, sc: Scope, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false, reframe?: (tail: Tail) => Tail | null, first = false,
): ScopedBody | null {
  // A RE-SOURCE is the connector's own (`reSourcedBody`) — unless the body also draws (`ladderOwns`).
  //
  // A random DRAW (`sample`/`coin`/`shuffle`, at any depth) is the connector's, and this is the form that
  // answers it: the reference hands the body ONE traverser at a time (`TraversalUtil.apply`,
  // vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
  // so it draws once PER SCOPE ROW. The decorrelator counts a draw as touching the scope (`decorrelate`), so
  // the domain is pushed beneath it and every `ORDER BY RANDOM()`/`ROW_NUMBER` it feeds is partitioned by the
  // scope key — one sort, linear in the rows drawn from, and no pick shared by two scopes. Only the body's OWN
  // draws (`owning`): a relation drawn upstream that the body only reads stays one shared pick.
  if (ladderOwns(body, ctx)) return null;
  const mine = owning(fresh);
  const lowered = lowerBody(body, rel, sc.scoped, framing, ctx, mine.fresh, labels, order, positionedSeed, first);
  // A body with EFFECTS is not a read the connector may evaluate per scope.
  if (!lowered || lowered.effects?.length) return null;
  // The host's own re-expression of the body's value, BEFORE the key is added (`landValues`' record).
  const tail = reframe ? reframe(lowered) : lowered;
  if (!tail) return null;
  const keyed = decorrelate(tail.rel, sc.scoped, sc.key, fresh, undefined, mine.owns);
  return keyed && { rel: keyed.rel, keyCol: keyed.key[0].col, tail };
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
  if (ladderOwns(body, ctx)) return null;
  const type = typeOf(meta('id', 'int'), meta(sc.key, 'int'));
  const located = make.project({
    id: fresh('sbr'), input: sc.scoped, channels: [], type,
    exprs: [['id', substRelId(root.id, rel.id, sc.scoped.id)], [sc.key, col(sc.scoped.id, sc.key)]],
  });
  const domain = make.filter({ id: fresh('sbd'), input: located, channels: [], type, pred: isNot(col(located.id, 'id'), compilerNull()) });
  const element = make.project({ id: fresh('sbe'), input: domain, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(domain.id, 'id')]] });
  // Only the body's OWN draws are per scope (`owning`, as `scopedBody`).
  const mine = owning(fresh);
  const lowered = lowerBody(body, element, domain, { kind: 'elements', elem: root.elem }, ctx, mine.fresh, NO_ALIASES, 'read', false, true);
  if (!lowered || lowered.effects?.length) return null;
  const tail = reframe(lowered);
  if (!tail) return null;
  const keyed = decorrelate(tail.rel, domain, sc.key, fresh, undefined, mine.owns);
  return keyed && { rel: keyed.rel, keyCol: keyed.key[0].col, tail };
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
  order?: 'free' | 'read', first = false,
): Tail | null {
  // A body that DRAWS never stays correlated: SQLite may evaluate a subquery (or a part of one) that does not
  // read the host ONCE for every host row, so a draw there would be one pick shared by every scope. It takes
  // the decorrelated form (`scopedBody`), which keys the draw per scope by construction.
  if (nondeterministic(body, ctx.params)) return null;
  const tail = lowerBody(body, rel, rel, framing, ctx, fresh, labels, order, false, first);
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
      if (!owner || constantOver(owner, node.name, (id) => !byId.has(id))) hit = true;
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
  return termReadsHost ? null : tail;
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
 *  so a position the body numbered is not computed for it (`positionKeys` drops the window). */
function existenceProbe(tail: Tail, fresh: Minter): Rel {
  const enc = encounterOf(tail.rel.channels);
  const rows = (enc && positionKeys(tail.rel, enc.col, fresh)?.rel) || tail.rel;
  return make.project({
    id: fresh('sp'), input: rows, channels: [], type: typeOf(meta('one', 'any', true)),
    exprs: [['one', col(rows.id, tail.rel.type.cols[0]!.name)]],
  });
}

/**
 * The FIRST row of a CORRELATED body, as one correlated scalar subquery per payload column — `ORDER BY` the
 * body's emission order then its payload, `LIMIT 1`: the same deterministic pick `firstPerScope` makes per
 * key (`defaultCollation`), made per host row by SQLite's nested loop instead of by a window over every key.
 *
 * Each column's subquery evaluates the body again (SQL has no row-valued scalar subquery), so this is a COST
 * rule on the body's columns: ONE column always (no repetition), TWO — a value and its per-row type tag — only
 * over a FLAT body (no subplan of its own), so the repeat is one more index seek and never compounds with
 * nesting (`k` columns per level would be `k^depth` spellings). Anything wider is the decorrelated window's.
 */
function correlatedFirst(tail: Tail, names: readonly string[], host: Rel, fresh: Minter): ReadonlyMap<string, Expr> | null {
  const payload = names.map((name) => tail.rel.type.cols.find((column) => column.name === name));
  if (!payload.length || payload.some((column) => !column)) return null;
  // A body that reads NOTHING but its seed row (`math('_ + 1')`, `select('a')`, `identity()`, a test of the value)
  // is an expression of the host row: no subquery at all, at any width.
  const inline = seedExpressions(tail.rel, names, host);
  if (inline) return seedValues(inline);
  if (payload.length > 2) return null;
  // The repetition must not COMPOUND: two columns spell the body twice, so a body whose own subplans hold
  // subplans (a nested first-row pick, two per level) would be `2^depth` spellings. A subplan that is itself
  // flat — an arm's priority guard, one seek — is repeated once per column and no further.
  let deep = false;
  forEachRel(tail.rel, (r) => {
    for (const e of relExprs(r)) forEachExpr(e, (node) => {
      for (const sub of exprRels(node)) forEachRel(sub, (s) => { if (relExprs(s).some(exprHasSubquery)) deep = true; });
    });
  });
  if (payload.length > 1 && deep) return null;
  // A body of at most one row (a reducer, a record over the one seed row) IS its first row: no sort.
  const single = atMostOneRow(tail.rel);
  // The FIRST row in EMISSION order (`lowerBody`): sorted by the position's own keys where the body numbered
  // it with a window (`positionKeys` — a top-1 sort, no window per host row), else by the position itself; the
  // payload breaks what ties remain, `defaultCollation`'s rule.
  const enc = encounterOf(tail.rel.channels);
  const keyed = !single && enc ? positionKeys(tail.rel, enc.col, fresh) : null;
  const base = keyed?.rel ?? tail.rel;
  const terms = keyed
    ? [...keyed.keys, ...payloadCols(tail.rel).map((column) => ({ expr: col(base.id, column.name), dir: 'asc' as const }))]
    : defaultCollation(tail.rel);
  // A sort term that is, or is defined by, a subquery may not sort a correlated body: SQLite resolves an ORDER
  // BY term's subquery without the scopes beyond its own query (measured, bun:sqlite 3.51: `SELECT (SELECT
  // (SELECT t.x) v FROM (VALUES (1)) ORDER BY (SELECT t.x) LIMIT 1) FROM t` is "no such column: t.x"), so such a
  // body stays decorrelated. A subquery that only FILTERS the body is not a term and costs nothing here.
  if (!single && terms.some((term) => term.expr.kind !== 'col' ? exprHasSubquery(term.expr)
    : term.expr.rel !== base.id || columnReadsSubquery(base, term.expr.name))) return null;
  // A body that is a MERGE of arms in a fixed priority (a `coalesce`, a `union`'s arm-major order): its first
  // row is the first arm's first row where that arm has one, else the next arm's — one seek per arm, never a
  // sort over the merge.
  const arms = single ? null : priorityArms(base, terms, fresh);
  if (arms) {
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
    return exprs;
  }
  const first = single ? tail.rel : make.limit({
    id: fresh('cl'), input: make.sort({ id: fresh('cs'), input: base, channels: base.channels, type: base.type, terms: untilKey(base, terms) }),
    channels: base.channels, type: base.type, count: compilerInt(1),
  });
  const plans = (payload as ColMeta[]).map((column) => [column.name,
    make.project({ id: fresh('cv'), input: first, channels: [], type: typeOf({ ...column, nullable: true }), exprs: [[column.name, col(first.id, column.name)]] })] as const);
  if (!plans.every(([name, plan]) => spellsStored(plan, [name], host))) return null;
  return new Map(plans.map(([name, plan]) => [name, { kind: 'scalar', plan } as Expr]));
}

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
  const conjuncts = (e: Expr): Expr[] => (e.kind === 'binary' && e.op === 'and' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e]);
  const same = (a: Expr, b: Expr): boolean => JSON.stringify(a) === JSON.stringify(b);
  return new Map([...inline.values].map(([name, e]) => {
    const kept = inline.pred ? conjuncts(inline.pred).filter((p) => !(p.kind === 'binary' && p.op === 'is not'
      && p.right.kind === 'lit' && p.right.value === null && same(p.left, e))) : [];
    return [name, kept.length ? { kind: 'case', whens: [[kept.reduce((a, b) => and(a, b)), e]] } as Expr : e] as const;
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
  return { values: out, ...(preds.length ? { pred: preds.reduce((a, b) => and(a, b)) } : {}) };
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
 *  without it only a copied column or a literal counts, the narrower question of whether a term READS the host. */
function constantOver(rows: Rel, name: string, outer?: (id: RelId) => boolean, computed = false): boolean {
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
      const at = r.type.cols.findIndex((c) => c.name === column);
      if (at < 0) return false;
      const leftN = r.left.type.cols.length;
      const side: Rel = at < leftN ? r.left : r.right;
      column = side.type.cols[at < leftN ? at : at - leftN]!.name;
      r = side;
      continue;
    }
    if (r.kind !== 'project') return false;
    const e = r.exprs.find(([n]) => n === column)?.[1];
    if (!e) return false;
    if (e.kind === 'lit') return true;
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
  // The value of `rows`' column `name` in arm `i`, where it is a constant there.
  const constantIn = (named: string, i: number): number | null => {
    let column = named;
    for (const p of chain) {
      const e = p.exprs.find(([n]) => n === column)?.[1];
      if (!e) return null;
      if (e.kind === 'lit') return typeof e.value === 'number' ? e.value : null;
      column = (e as Extract<Expr, { kind: 'col' }>).name;
    }
    const pos = union.type.cols.findIndex((c) => c.name === column);
    if (pos < 0) return null;
    // Down the arm through what carries the column unchanged, to the literal that defines it.
    let r: Rel = union.inputs[i]!;
    let name = r.type.cols[pos]!.name;
    for (;;) {
      if (r.kind === 'filter' || r.kind === 'sort' || r.kind === 'limit') { r = r.input; continue; }
      if (r.kind === 'window' && !r.specs.some(([minted]) => minted === name)) { r = r.input; continue; }
      if (r.kind === 'join') {
        const at = r.type.cols.findIndex((column) => column.name === name);
        const leftN = r.left.type.cols.length;
        if (at < 0) return null;
        [r, name] = at < leftN ? [r.left, r.left.type.cols[at]!.name] : [r.right, r.right.type.cols[at - leftN]!.name];
        continue;
      }
      if (r.kind !== 'project') return null;
      const e: Expr | undefined = r.exprs.find(([n]) => n === name)?.[1];
      if (e?.kind === 'lit') return typeof e.value === 'number' ? e.value : null;
      if (e?.kind !== 'col' || e.rel !== r.input.id) return null;
      name = e.name;
      r = r.input;
    }
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
  const first = firstOnly && !atMostOneRow(correlated)
    ? perOriginWindow(rel, keyCols.map((name) => col(rel.id, name)), [], { scope: 'global', offset: 0, limit: 1 }, fresh)
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
  // Every body correlated: the semi/anti-join is an `EXISTS` over the body itself, read against the host row
  // (the dependent join kept as such — `correlatedBody`); `and`'s bodies are a conjunction of them.
  const correlated = (bodies as (readonly IRStep[])[]).map((body) => correlatedBody(body, rel, framing, ctx, fresh, labels, 'free', true));
  const probes = correlated.map((tail) => tail && existenceProbe(tail, fresh));
  if (probes.every((probe) => probe && spellsStored(probe, ['one'], rel))) {
    const pred = (probes as Rel[]).map((plan): Expr => ({ kind: 'exists', plan, negated }))
      // `and` a conjunction of the bodies' EXISTS, `or` a disjunction (`OrStep`: some child has a next).
      .reduce((all, one) => (step.name === 'or' ? or(all, one) : and(all, one)));
    return continueAs(make.filter({ id: fresh('sj'), input: rel, channels: rel.channels, type: rel.type, pred }), framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  const sc = scope(rel, fresh);
  let kept = sc.scoped;
  // `and(b1, b2, …)` is every body's semi-join in turn (`AndStep`, a `ConnectiveStep` over its children);
  // `or(b1, b2, …)` ONE semi-join on the UNION of the bodies' keys — a traverser passes iff some child has a next
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/OrStep.java`).
  const keys: Rel[] = [];
  for (const body of bodies as (readonly IRStep[])[]) {
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'free', false, undefined, true);
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
  const tail = feedsOtherV ? null : lowered !== undefined ? lowered : correlatedBody(body, rel, framing, ctx, fresh, labels, 'read', true);
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
  const first = tail && framingCols(tail.framing) ? correlatedFirst(tail, payloadCols(tail.rel).map((column) => column.name), rel, fresh) : null;
  const lead = tail && payloadCols(tail.rel)[0];
  const probe = tail && lead?.nullable ? existenceProbe(tail, fresh) : null;
  if (tail && first && (!probe || spellsStored(probe, ['one'], rel))) {
    // The dependent join kept: each payload column the body's first row, read per host row (beside the host's
    // own columns, under fresh names). A host row whose body is EMPTY is dropped (`TraversalMapStep`): a
    // present lead value proves a row, and only where the lead may be a NULL value is the body's `EXISTS` asked
    // — after the `OR`, so a row whose value is present never pays for it.
    const bodyPayload = payloadCols(tail.rel);
    const named = new Map(bodyPayload.map((column) => [column.name, fresh('smv') as string]));
    const projected = make.project({
      id: fresh('smp'), input: rel, channels: rel.channels,
      type: typeOf(...rel.type.cols, ...bodyPayload.map((column) => ({ ...column, name: named.get(column.name)!, nullable: true }))),
      exprs: [...rel.type.cols.map((column) => [column.name, col(rel.id, column.name)] as const),
        ...bodyPayload.map((column) => [named.get(column.name)!, first.get(column.name)!] as const)],
    });
    const leadPresent: Expr = { kind: 'binary', op: 'is not', left: col(projected.id, named.get(lead!.name)!), right: compilerNull() };
    // A body of EXACTLY one row (a seeded reducer — `fold()`, `count()`) is never empty, so no host row is
    // dropped and nothing reads its value to ask: a value no consumer reads is not computed (§17 error timing).
    const present = exactlyOneRow(tail.rel) ? projected : make.filter({
      id: fresh('smf'), input: projected, channels: projected.channels, type: projected.type,
      pred: probe ? or(leadPresent, substRelId({ kind: 'exists', plan: probe, negated: false }, rel.id, projected.id)) : leadPresent,
    });
    const mapped = make.project({
      id: fresh('smq'), input: present, channels: rel.channels, type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, col(present.id, named.get(column.name)!)] as const),
        ...rel.channels.map((channel) => [channel.col, col(present.id, channel.col)] as const)],
    });
    return continueAs(splitPath(mapped, tail.framing, ctx, fresh), perTraverserFraming(tail.framing), steps, at + 1, bulked, ctx, fresh, labels);
  }
  // A host whose COMPUTED columns kept the dependent join out (`spellsStored` — a correlated read would compute
  // them again per inner row) is computed ONCE first: a fenced CTE, whose columns are then read by name, and the
  // dependent join is tried over that. A chain of maps (`repeat(local(out().limit(1))).times(n)`) is then one
  // CTE and one seek per phase rather than a scope, a window and a rejoin per phase.
  if (tail && rel.kind !== 'materialize' && isSelfContained(rel) && rel.type.cols.some((column) => !columnIsStored(rel, column.name))) {
    const fencedHost = make.materialize({ id: fresh('smh'), input: rel, channels: rel.channels, type: rel.type, fenced: true });
    const over = firstInner({ ...site, rel: fencedHost });
    if (over) return over;
  }
  // Not SQL-holdable as a dependent join: the decorrelated body, its FIRST row per scope through the rejoin.
  const sc = scope(rel, fresh);
  const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read', false, undefined, true);
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, rel, 'split', true, ctx, fresh, labels, false, feedsOtherV);
  return out && continueAs(out.rel, out.framing, steps, at + 1, bulked, ctx, fresh, out.aliases);
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
  if (!framingCols(outFraming)) return null;
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
  const direct = chooseArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at });
  if (direct) return withBranchEffects(direct, steps, at, ctx, fresh, () => continueAs(direct.rel, direct.framing, steps, at + 1, bulked, ctx, fresh, direct.aliases));
  if (step.optionArms || step.modulators?.length || step.args.length < 2) return null;
  const choice = step.args[0]!.value;
  if (!isNested(choice)) return null;
  const condition = bodyOf(choice.nested, ctx.params, ctx.sideEffects);
  if (!condition) return null;
  const sc = scope(rel, fresh, true);
  const keyed = scopedBody(condition, sc.scoped, framing, sc, ctx, fresh, labels, 'free', false, undefined, true);
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
  const probe = correlatedBody(body, rel, framing, ctx, fresh, labels, 'read');
  if (probe && atMostOneRow(probe.rel) && (policy === 'split' || (ownsNothing(rel) && ownsNothing(probe.rel)))) {
    const mapped = firstInnerOver(site, probe);
    if (mapped) return mapped;
  }
  // An order the BODY imposes (`local(out().order().by('name'))`) is meaningful past the host — through a
  // per-traverser body until the next fan-out (`test/compiler/meaningful-order.exec.test.ts`) — so the rejoin
  // keeps it, host-major then the body's own, whether or not the steps after read it.
  const owed = branchOrderOwed(ctx, { steps, at }, rel) || body.some((s) => s.name === 'order' && !isLocalScope(s));
  const frozen = owed ? freezeParent(positioned(rel, fresh), fresh) : null;
  const input = frozen ? frozen.rel : rel;
  const sc = scope(input, fresh);
  const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body));
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, input, policy, false, ctx, fresh, labels, owed, edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false));
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
  const leading = bodies[0]!.length ? correlatedBody(bodies[0]!, rel, framing, ctx, fresh, labels, 'read') : null;
  if (leading && exactlyOneRow(leading.rel)) {
    const alone = allRows(optional ? 'forward' : 'split')({ ...site, step: { ...step, args: [step.args[0]!] } });
    if (alone) return alone;
  }
  // THE DEPENDENT JOIN FIRST, over one correlated row (a body inside another child, `project().by(coalesce(…))`)
  // or a whole stream alike: each arm over the row, gated by the earlier arms' NOT EXISTS (`coalesceMerge`, the
  // correlated form cc3b keeps for `map`/`where`). SQLite's join IS a nested loop, so an arm it can seek per row
  // is already the scoped plan's best physical form — measured 2.2× (`coalesce(values,constant)`) and 2.9×
  // (`optional(out('knows'))`) faster at 8k than scoping the stream. Only where that form declines is the stream
  // scoped and decorrelated below.
  {
    const branch = optional ? optionalArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at })
      : coalesceArms(step, rel, framing, bulked, armsCtx(site), fresh, labels, { steps, at });
    if (branch) return withBranchEffects(branch, steps, at, ctx, fresh, () => continueAs(branch.rel, branch.framing, steps, at + 1, bulked, ctx, fresh, branch.aliases));
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
    // keep — the ladder's own split between its positioned arms and its per-traverser reduction arm.
    const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body));
    if (!keyed) return null;
    const out = rejoin(sc, remaining, keyed, input, optional ? 'forward' : 'split', false, ctx, fresh, labels, owed,
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
  const host = (from: Rel) => (framing.kind === 'elements' || framing.kind === 'scalar' ? reductionHost(from, framing, labels) : null);
  // The scope is minted only once a slot needs it.
  let sc: Scope | undefined;
  // Which `by()` slots this connector answers: every CHILD body it can lower, correlated or keyed. Decided per
  // slot — a slot it cannot lower is the record builder's own field (`byField`, through the child seam) — so one
  // unanswerable `by()` does not cost the others. A slot's ring position is `index % bys.length` (`TraversalRing`).
  const owned = new Map<number, { readonly first: ReturnType<typeof firstPerScope>; readonly framing: RelFraming }>();
  // A slot whose body stays CORRELATED: its first row read per host row (`correlatedFirst`), no join at all.
  const correlated = new Map<number, { readonly exprs: ReadonlyMap<string, Expr>; readonly framing: RelFraming; readonly total: boolean }>();
  let joined: Rel = rel;
  for (let slot = 0; slot < bys.length; slot++) {
    const by = bys[slot]!;
    if (by.key.kind !== 'child' || by.order !== undefined) continue;
    // A RECORD-valued by() (`by(__.project(…))`) is held as the MAP it is (`recordAsMap`): a record's own first
    // column is a SUB-field's, so presence read off it dropped an outer key whose inner map was empty.
    const lowered = correlatedBody(by.key.body, rel, framing, ctx, fresh, labels, 'read', true);
    const tail = lowered && recordAsMap(lowered, ctx, fresh);
    const fieldCols = tail && framingCols(tail.framing);
    const exprs = tail && fieldCols && correlatedFirst(tail, fieldCols.map((column) => column.name), rel, fresh);
    if (tail && exprs) { correlated.set(slot, { exprs, framing: tail.framing, total: exactlyOneRow(tail.rel) }); continue; }
    const scoped = sc ??= scope(rel, fresh);
    if (joined === rel) joined = scoped.scoped;
    const keyed = scopedBody(by.key.body, rel, framing, scoped, ctx, fresh, labels, 'read', false, (t) => recordAsMap(t, ctx, fresh), true);
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
  // No slot a child this connector owns: the record is the builder's own over the host row, as the ladder's
  // is — only the path rule below differs.
  const over = joined;
  const fieldFor = (slot: number): ByField | undefined => {
    const kept = correlated.get(slot);
    // A correlated field reads the host row, which every relation the joins built still carries by name.
    if (kept) return {
      exprs: framingCols(kept.framing)!.map((column) => [column.name, over === rel ? kept.exprs.get(column.name)! : substRelId(kept.exprs.get(column.name)!, rel.id, over.id)] as const),
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

/** A ChildValue's expressions, each rewritten. */
const mapValue = (v: ChildValue, f: (e: Expr) => Expr): ChildValue => ({
  ...v, expr: f(v.expr), ...(v.vtype ? { vtype: f(v.vtype) } : {}), ...(v.node ? { node: f(v.node) } : {}),
  present: typeof v.present === 'object' ? { ...v.present, when: f(v.present.when) } : v.present,
});

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
  const reads = [value.expr, value.vtype, value.node, typeof value.present === 'object' ? value.present.when : undefined]
    .flatMap((e) => (e ? [...colsRead(e, scoped.over)] : []));
  if (!reads.every((name) => row.type.cols.some((column) => column.name === name))) return undefined;
  return mapValue(value, (e) => substRelId(e, scoped.over, row.id));
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
 *  (`TraversalUtil.produce`). `group()`'s VALUE `by()` is not one: `Grouping` pools a key's traversers into
 *  its first barrier, so its scope is the KEY. */
const perTraverserSlot = (step: IRStep, slot: number): boolean => step.name !== 'group' || slot === 0;

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (§2 S5). Each child `by()` is the first result per scope (`firstPerScope`), LEFT-joined onto the scoped
 * input; the host step is then the ladder's own lowering over that relation, reading each value as a column
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
  for (const [key, body] of bodies) {
    const root = roots.get(key);
    const reframe = (t: Tail) => recordAsMap(t, ctx, fresh, true);
    const keyed = root ? rootedBody(body, root, rel, sc, ctx, fresh, reframe)
      : scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read', false, reframe, true);
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
  const values = new Map(landed.map(({ key, first, framing: valueFraming, cols }) => [key, {
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
  return { over, values };
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
 * dropped `x`). The ladder's seam already hands a project body back collapsed the same way.
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
    if (by?.key.kind === 'child' && perTraverserSlot(step, slot)) bodies.set(bodyKey(by.key.body), by.key.body);
  });
  return bodies;
}

/** A host's `by()` slot count: `group()` a key and a value, `groupCount()` a key, the others one per `by()`. */
const byArity = (step: IRStep): number =>
  step.name === 'group' ? 2 : step.name === 'groupCount' ? 1 : step.modulators?.length ?? 0;

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (`landValues`). The host step is then the ladder's own lowering over the joined relation, reading each value
 * as a column where it would have built a correlated subquery (`scopedValue`). The by() semantics — an
 * unproductive key drops the traverser unless `ProductiveByStrategy` keeps it (`OrderGlobalStep`,
 * `DedupGlobalStep.java:77-78`, `GroupCountStep`'s `TraversalUtil.produce`), the comparator, the survivor, the
 * map — stay the host's; only where the value comes from changes. The joined columns are shed after the step.
 * A `group()` whose VALUE `by()` is a child is `pooledGroup`'s.
 */
const byValues: Connector = (site) => {
  const { step, rel, framing, ctx, fresh, labels } = site;
  // An ARGUMENT changes what the by() runs over: `dedup("a")` projects each scope LABEL's value on a NEW traverser
  // (`freshTraverserRow`), and `group("m")`/`groupCount("m")` is a keyed SIDE EFFECT — neither is a per-traverser
  // by() over this stream, so both stay the host's own.
  if (step.optionArms || !step.modulators?.length || step.args.length) return null;
  const bys = modulations(step, byArity(step), childSeam(ctx, fresh));
  if (!bys) return null;
  if (step.name === 'group' && bys[1]?.key.kind === 'child') return pooledGroup(site, bys);
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
    { ...ctx, scopedValues: { over: over.id, values }, ladderAt: { steps: only, at: 0 } }, fresh, labels);
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
 * takes each traverser's first value and keeps the last (`Operator.assign`), which is not a pool: the ladder's.
 * The key `by()` is the host's own (a child key is landed as a join column first, `landValues`).
 */
function pooledGroup(site: HostSite, bys: readonly (Modulation | undefined)[]): Tail | null {
  const { step, rel, framing, steps, at, ctx, fresh, labels } = site;
  if (step.args.length || (framing.kind !== 'elements' && framing.kind !== 'scalar')) return null;
  const valueBy = bys[1]!;
  if (valueBy.key.kind !== 'child' || valueBy.order !== undefined) return null;
  let body = valueBy.key.body;
  // The POOL exists only where the value traversal has a `Barrier` (`isValueBarrier`, the step `determineBarrierStep`
  // stops at); without one each traverser's first value is assigned, last wins — the host's own arm.
  if (!body.some(isValueBarrier)) return null;
  // Only what runs BEFORE the barrier is per traverser in the reference (`GroupStep` pushes each traverser
  // through the value traversal's pre-barrier part, `Grouping.determineBarrierStep`); the pool lowers the whole
  // body over the key's members at once, so two forms would differ and stay the host's own arm:
  // - `sample()` first — a draw per key the pool cannot reproduce;
  // - a barrier NESTED in the pre-barrier part (`union(out().order().limit(2))`) — it cuts per traverser there,
  //   across the whole pool here.
  // A `tail(n)` first is a `limit(n)` of the pool: as a group's barrier its per-key merge is a
  // `RangeBiOperator(n)` keeping the FIRST n arrivals
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TailGlobalStep.java:129-131),
  // which is what a cut of the pool by arrival is — `group().by(label).by(tail())` is the key's first member.
  const cut = body.findIndex(isValueBarrier);
  if (body[cut]!.name === 'sample') return null;
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
  // An enclosing per-traverser scope's key would have to ride every pool as one more group key; the ladder's.
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
  const KEY = fresh('pgk') as string;
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
  const memberCols = terms.map(() => meta(fresh('pgu') as string, 'any', true));
  const termedType = typeOf(...kept.type.cols, ...memberCols);
  const members = make.materialize({
    id: fresh('pgw'), channels: kept.channels, type: termedType, fenced: true,
    input: make.project({
      id: fresh('pgv'), input: kept, channels: kept.channels, type: termedType,
      exprs: [...kept.type.cols.map((column) => [column.name, col(kept.id, column.name)] as const),
        ...memberCols.map((column, i) => [column.name, terms[i]!] as const)],
    }),
  });
  // THE DOMAIN: one row per key under the grouping's own equality, the first arrival's key node naming it.
  const termCols = terms.map(() => meta(fresh('pgt') as string, 'any', true));
  const enc = encounterOf(members.channels);
  const domain = make.aggregate({
    id: fresh('pgd'), input: members, channels: [], type: typeOf(...termCols, meta(KEY, keyElem ? 'int' : 'json', true)),
    groupBy: memberCols.map((column) => col(members.id, column.name)),
    aggs: [[KEY, firstArrival(col(members.id, KEY), enc ? [col(members.id, enc.col)] : [])]],
  });
  const sc = scope(domain, fresh);
  if (nondeterministic(body, ctx.params)) return null;
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
    pred: memberCols.map((column, i): Expr => ({ kind: 'binary', op: 'is', left: col(source.id, column.name), right: col(sc.scoped.id, termCols[i]!.name) }))
      .reduce((a, b) => and(a, b)),
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
  const mine = owning(fresh);
  const tail = weighed
    ? continueAs(weighed, sourceFraming, rest, 0, true, bodyCtx, mine.fresh, labels)
    : continueAs(seed, sourceFraming, rest, 0, restBulked, bodyCtx, mine.fresh, labels);
  if (!tail || tail.effects?.length) return null;
  // THE KEY PROJECTION: the domain is the members' DISTINCT key terms, so the body keys the pool by those terms
  // read off the pool's traversers themselves — no domain cross join. The members COVER the domain (every key
  // has one), so no LEFT JOIN either; a per-member prefix's results need not (a key whose members all produced
  // nothing), and keep it. `src/rel/decorrelate.ts` "The domain that IS its input's key projection".
  const projection: KeyProjection = {
    input: source.id, cols: new Map(termCols.map((column, i) => [column.name, memberCols[i]!.name])), covers: source === members,
  };
  const keyed = decorrelate(tail.rel, sc.scoped, sc.key, fresh, projection, mine.owns);
  if (!keyed) return null;
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
  // A list value is NESTED in the map, so its members must describe themselves (`selfDescribingList`) — and
  // be members the tree framer can walk (`listNodeExpr`): a path member has no `{t:'path'}` node yet.
  if (valueFraming.kind === 'list' && !treeFramed(valueFraming.of)) return null;
  // …and a MAP value keeps its element rowids for the root framer, which expands them through `singleOf`
  // (`mapNodePayload`, recursive over a nested map); any other value shape is not one this node builder states.
  if (valueFraming.kind !== 'list' && valueFraming.kind !== 'map' && valueFraming.kind !== 'scalar' && valueFraming.kind !== 'elements') return null;
  const listed = valueFraming.kind === 'list' ? selfDescribingList(valueExpr, valueFraming.of, fresh) : null;
  const node = listed ? listNode(listed.list) : memberNodeOf(produced, ctx.source, fresh);
  if (!node) return null;
  const singleOf: MapOf = valueFraming.kind === 'list' ? { kind: 'list', of: listed!.of, ...(valueFraming.set ? { set: true } : {}) }
    : valueFraming.kind === 'map' ? { kind: 'map', of: valueFraming.valOf } : { kind: 'scalar' };
  const grouped = keyedValuesMap(joined, col(joined.id, KEY), keyElem, node, singleOf, step, ctx.source, fresh);
  return continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, at + 1, false, ctx, fresh, NO_ALIASES);
}

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
]);

// The chain facts seed a path for a connector body that reads one (`CONNECTOR_HOSTS`, `ir/analyze.ts`), so the
// two host sets are one fact — kept equal here, loudly, rather than by a reader's care.
if (CONNECTORS.size !== CONNECTOR_HOSTS.size || [...CONNECTORS.keys()].some((name) => !CONNECTOR_HOSTS.has(name)))
  throw new Error('RelIR lowering: CONNECTORS and CONNECTOR_HOSTS (ir/analyze.ts) name different hosts');

/** Is the ladder lowering THIS connector site right now (`ChildStrategy.ladderAt`)? Then a tail must not hand
 *  it back to `continueAs`. */
export const atLadder = (ctx: ChainCtx, steps: readonly IRStep[], at: number): boolean =>
  ctx.ladderAt?.steps === steps && ctx.ladderAt.at === at;

/** Is `step` a site a connector may own? The cheap gate a tail loop asks before yielding to `continueAs`. */
export const connectorSite = (step: IRStep | undefined): boolean =>
  !!step && CONNECTORS.has(step.name) && (step.name === 'project' || step.args.some((arg) => isNested(arg.value))
    || (step.modulators ?? []).some((by) => by.some(isNested)));

/**
 * The hosts whose ladder route is DELETED (Phase 3 (d); the kept ones are catalogued in
 * `docs/2026-11-15-compositional-coverage-plan.md`, "Kept routes"): the connector row is their one lowering, so the
 * dispatch offers no ladder to fall back to. (`order`/`dedup`/`groupCount` keep their tail lowering — `byValues`
 * hands it the landed `by()` values, the connector's own use of it — but the tail no longer answers the site
 * ALONE, correlating its `by()` bodies itself.) A host leaves the ladder by joining
 * this set in the commit that deletes its route. Keyed by the FRAMINGS the deleted route served: over any other
 * framing the tail that lowers the step is the host's own lowering, not a ladder (`project` over a property row is
 * `propertyTail`'s record — `recordLeft` reads a `by()` through an element or scalar host only), and so is a step
 * FORM the connector row does not claim: an ARGUMENT changes what a `by()` runs over (`dedup("a")`, a keyed
 * `groupCount("m")` — `byValues` leaves both to the host).
 */
const LADDERLESS: ReadonlySet<string> = new Set(['project', 'order', 'dedup', 'groupCount', 'coalesce', 'optional', 'choose', 'union', 'where', 'filter', 'not', 'and', 'or']);
/** The hosts whose connector row (`byValues`) claims only the argument-free form. */
const BY_VALUE_HOSTS: ReadonlySet<string> = new Set(['order', 'dedup', 'groupCount']);
/** The EXISTENCE hosts, LADDERLESS except over a body the connector leaves to the ladder by design (`ladderOwns`:
 *  a draw over a re-source, `docs/2026-11-16-ladder-retirement-plan.md` R2b/R4.3/R4.4) — the one form of their
 *  route still standing. */
const EXISTENCE_HOSTS: ReadonlySet<string> = new Set(['where', 'filter', 'not', 'and', 'or']);
const ladderless = (step: IRStep, framing: RelFraming, ctx: ChainCtx): boolean =>
  LADDERLESS.has(step.name) && (framing.kind === 'elements' || framing.kind === 'scalar')
  && (!BY_VALUE_HOSTS.has(step.name) || !step.args.length)
  && (!EXISTENCE_HOSTS.has(step.name) || ![...step.args.map((arg) => arg.value), ...(step.modulators ?? []).flat()].some((value) => {
    if (!isNested(value)) return false;
    const body = bodyOf(value.nested, ctx.params, ctx.sideEffects);
    return !body || ladderOwns(body, ctx);
  }));

/**
 * The dispatch at a connector site: the ladder (the `correlatedChild` fast path) and the connector, in the order
 * the switch names, each the other's fallback. `undefined` where `steps[at]` is not a connector site.
 */
export function scopedHost(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], at: number, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap, ladder: (ctx: ChainCtx) => Tail | null,
): Tail | null | undefined {
  const step = steps[at];
  if (!connectorSite(step)) return undefined;
  const connector = CONNECTORS.get(step!.name)!;
  // The bodies' unroll provenance, as the hosts' own lowering records it, so a width or size decline names the
  // repeat() and the host it could move out of (`noteUnrolled`).
  for (const arg of step!.args) if (isNested(arg.value)) {
    noteUnrolled(bodyOf(arg.value.nested, ctx.params, ctx.sideEffects), ctx, ['local', 'map', 'flatMap'].includes(step!.name) ? step!.name : null);
  }
  const scoped = (under: ChainCtx): Tail | null => connector({ step: step!, rel, framing, steps, at, bulked, ctx: under, fresh, labels });
  const routes = ctx.connectorOnly || ladderless(step!, framing, ctx) || connectorOwns(step!, ctx) ? [scoped]
    : ctx.correlatedChild ? [ladder, scoped] : [scoped, ladder];
  // Each route records its decline reasons into its OWN sink (`Declines.fork`): the reasons of the route that
  // answered are kept, and a route that declined while the other answered leaves none — so which route is
  // tried first (the switch) changes the plan, never whether the traversal compiles.
  const tried: Declines[] = [];
  for (const route of routes) {
    const sink = ctx.declines.fork();
    const tail = route({ ...ctx, declines: sink });
    if (tail) { ctx.declines.adopt(sink); return tail; }
    tried.push(sink);
  }
  for (const sink of tried) ctx.declines.adopt(sink);
  return null;
}

