// MOVEMENT — the physical graph algebra: a non-start V()/E() re-source (a cross join over an
// element scan) and the adjacency/endpoint hops (a join over `edges` with a re-projection). A pure
// SINK over the `GraphSource` + carried-channel vocabulary: nothing here re-enters the fold, so it is
// the cleanest slice of the old lower.ts. Extracted from lower.ts; see ./chain.ts for the vocabulary.
import * as make from '../../../rel/factory.ts';
import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, elementCols, eq, labelSetArgs, meta, or, renumber, typeOf, type Minter } from '../build.ts';
import { withChannel } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta } from '../../../rel/types.ts';
import type { Elem } from '../../elem.ts';
import type { IRStep } from '../../ir/strategies.ts';
import type { RelFraming } from '../framing.ts';
import type { GraphSource } from '../source.ts';
import { CONSTANT } from '../predicate.ts';
import { extendPath, pathCarried } from '../path.ts';
import { BULK, ENCOUNTER, encounterOf, FROM_V, fromVOf, type ChainCtx } from './chain.ts';
import { remintOrder } from '../lower.ts';
import { ensureBulk } from './branch.ts';
import { evidenceOf } from '../receiver.ts';
import { externalIdKeys } from '../source.ts';
import { perRowColumnOf } from '../../../sql/kernel/render.ts';
import { rereadsFreely } from '../../../rel/walk.ts';

export function reSource(
  step: IRStep, input: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter,
): { rel: Rel; elem: Elem } | null {
  if ((step.name !== 'V' && step.name !== 'E') || step.modulators?.length || step.optionArms) return null;
  if (framing.kind === 'path' || input.channels.some((channel) =>
    channel.role === 'path' || channel.role === 'sack' || channel.role === 'fromV')) return null;
  const elem: Elem = step.name === 'E' ? 'edge' : 'vertex';
  const seeded = ctx.source.elementScan(elem, step.args, fresh);
  if (!seeded) return null;
  const source = seeded.pred
    ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred: seeded.pred })
    : seeded.scan;
  // Only the new id crosses the join. Keeping the source row's physical columns would collide with
  // an element input's `id`/`uid` columns before the payload replacement (`crossCarried`).
  const ids = make.project({
    id: fresh('rs'), input: source, channels: [], type: typeOf(meta('sid', 'int')),
    exprs: [['sid', col(source.id, 'id')]],
  });
  // GraphStep's iterator visits the scanned elements in rowid order, so the source id is the ordinal;
  // every origin meets every element, so an arriving position is always re-minted (`several`).
  const parent = ensureBulk(input, fresh);
  const crossed = make.join({
    id: fresh('j'), left: parent, right: ids, join: 'cross', channels: parent.channels,
    type: typeOf(...parent.type.cols, ...ids.type.cols),
  });
  return { elem, rel: crossCarried(parent, crossed, 'sid', [[meta('id', 'int'), 'sid']], true, ctx, fresh) };
}

/**
 * GRAPHSTEP'S ID LOOKUP — the elements a `V(<traversal>)`/`E(<traversal>)` names, once the traversal's
 * results have arrived as this stream's values (one row per result, the head's carried channels riding).
 *
 * `GraphStep.resolveTraversalIds` turns each result into an id — an Element contributes its id, any other
 * value IS an id — and `lookupElements` hands them to `graph.vertices(ids)`/`edges(ids)`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:231-260`).
 * Relationally that is an inner JOIN of the result rows to the element relation on the external id, and
 * an element id names at most one element (the rowid is the key, the `uid` UNIQUE, and a value routes to
 * exactly one of the two), so the join is 1:≤1: a result naming no element drops, every other row keeps
 * its channels and its position unchanged, and nothing is re-minted. A repeated id is a repeated row, as
 * TinkerGraph's `vertices(ids)` maps every id it is handed.
 *
 * An element result of the TARGET kind is its own lookup (`V(__.out())` names the vertices `out()`
 * reached). Any other is matched by VALUE through the source's one routing (`elementById` →
 * `externalIdIs`): a Number is a rowid, a String a `uid`, every other type an id no element has. A
 * Collection result — list-framed, or a per-row list/set row of a scalar stream — is unpacked one level by
 * the caller before it reaches here (`traversalIdsTail`, `collectionMembersOrSelf`).
 *
 * The state `reSource` refuses (a path, a sack, an otherV entry) is refused here for the same reason.
 */
export function idLookup(
  input: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, elem: Elem, ctx: ChainCtx, fresh: Minter,
): Rel | null {
  if (input.channels.some((channel) => channel.role === 'path' || channel.role === 'sack' || channel.role === 'fromV')) return null;
  const parent = ensureBulk(input, fresh);
  if (framing.kind === 'elements' && framing.elem === elem) return parent;
  if (!ctx.source.elementById) return null;
  // An element's external id carries no tag: its storage class (INTEGER rowid, TEXT uid) IS its type.
  const vtype = framing.kind === 'scalar' ? perRowColumnOf(framing.type) : undefined;
  const keys = externalIdKeys(
    framing.kind === 'scalar' ? col(parent.id, 'v') : ctx.source.externalId(framing.elem, col(parent.id, 'id'), fresh),
    framing.kind === 'scalar' ? evidenceOf(framing.type, vtype ? col(parent.id, vtype) : undefined) : { kind: 'storage' },
  );
  // The routing KEYS as columns of one projection, so the value — often a correlated read — is computed
  // once per row (the emitter's one-subquery rule over a projection) and the join reads each key once.
  const keyCols = (['rowid', 'uid'] as const).filter((key) => keys[key] !== null);
  const keyed = make.project({
    id: fresh('xk'), input: parent, channels: parent.channels,
    type: typeOf(...keyCols.map((key) => meta(`k_${key}`, 'any', true)), ...carriedCols(parent.channels)),
    exprs: [...keyCols.map((key) => [`k_${key}`, keys[key]!] as const),
      ...parent.channels.map((channel) => [channel.col, col(parent.id, channel.col)] as const)],
  });
  const keyOf = (key: 'rowid' | 'uid'): Expr | null => keys[key] && col(keyed.id, `k_${key}`);
  const found = ctx.source.elementById(elem, { rowid: keyOf('rowid'), uid: keyOf('uid') }, fresh);
  const met = (name: string): string => `rl_${name}`;
  const joined = make.join({
    id: fresh('j'), left: keyed, right: found.scan, join: 'inner', ordered: true, channels: keyed.channels,
    type: typeOf(...keyed.type.cols, ...found.scan.type.cols.map((column) => ({ ...column, name: met(column.name) }))),
    on: found.pred,
  });
  return make.project({
    id: fresh('rl'), input: joined, channels: parent.channels, type: typeOf(...elementCols(parent.channels)),
    exprs: [['id', col(joined.id, met('id'))], ...parent.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
  });
}

/**
 * GRAPHSTEP'S CARRIED-CHANNEL CROSSING — the one contract every re-source keeps (`reSource`'s cross join,
 * `reSourcedOnce`'s per-origin draw) when an origin traverser splits into the elements it meets: its
 * CARRIED channels cross, its payload is replaced by the met row's, and its position is re-expressed.
 *
 * - `parent` is the origins with their bulk ALREADY promoted (`ensureBulk`). GraphStep splits one
 *   traverser into element traversers; a scalar parent represents one implicitly, whereas an element
 *   relation must carry it explicitly so a later movement can collapse correctly. The promotion sits on
 *   the parent BEFORE any join: inventing the channel on the join result is neither side's contract and
 *   leaves an Aggregate with no input bulk to sum. `parent` is read only for its channels.
 * - `met` is the meeting: every parent carried column, the `ordinal` (the met row's place in the
 *   iterator order GraphStep realizes) and each payload source column.
 * - `payload` maps each output payload column to its source column on `met`.
 * - `several`: can one parent row meet several rows? Then an ARRIVING position is re-minted origin-major,
 *   then by `ordinal` (`renumber`, one window). Otherwise every row keeps its parent's position and no
 *   window is paid for.
 *
 * With no arriving position, the ordinal IS the position where the chain needs one. It is minted AFTER the
 * join rather than pretending the parent carried it: the Join contract only preserves channels from its
 * left input, while Project is the sole node allowed to declare one. In a child scope it repeats per
 * parent, which is exactly what a later per-origin window reads.
 */
export function crossCarried(
  parent: Rel, met: Rel, ordinal: string, payload: readonly (readonly [ColMeta, string])[], several: boolean,
  ctx: ChainCtx, fresh: Minter,
): Rel {
  const arriving = encounterOf(parent.channels);
  const mint = !arriving && ctx.ordered;
  const channels = mint ? withChannel(parent.channels, ENCOUNTER) : parent.channels;
  const out = [...payload.map(([column]) => column), ...carriedCols(channels)];
  const source = (name: string): Expr => {
    const paid = payload.find(([column]) => column.name === name);
    return col(met.id, paid ? paid[1] : mint && name === ENCOUNTER.col ? ordinal : name);
  };
  if (!arriving || !several) return make.project({
    id: fresh('c'), input: met, channels, type: typeOf(...out),
    exprs: out.map((column) => [column.name, source(column.name)] as const),
  });
  // Parent outer iteration, then the ordinal: `renumber` consumes the two keys and leaves a single total
  // encounter column on the result.
  const kept = out.filter((column) => column.name !== arriving.col);
  const staged = make.project({
    id: fresh('c'), input: met, channels: [],
    type: typeOf(...kept, meta('parent_encounter', 'int'), meta('source_order', 'int')),
    exprs: [
      ...kept.map((column) => [column.name, source(column.name)] as const),
      ['parent_encounter', col(met.id, arriving.col)], ['source_order', col(met.id, ordinal)],
    ],
  });
  return renumber(staged, [
    { expr: col(staged.id, 'parent_encounter'), dir: 'asc' },
    { expr: col(staged.id, 'source_order'), dir: 'asc' },
  ], out, channels, fresh);
}

/**
 * MOVEMENT — the graph algebra proper, as a join over `edges` and a re-projection.
 *
 * Six adjacency steps plus the three endpoint reads, each one direction table entry: which edge
 * column matches the incoming id, and which column the outgoing id comes from. `both`/`bothE`/
 * `bothV` are two entries, and `hopJoin` reads their incoming frontier ONCE against a DIRECTION row —
 * one output row per (edge, direction) that matches, so a self-loop legitimately yields the vertex
 * twice (the multiset rule, carried by the direction row rather than by a UNION ALL).
 *
 * `otherV` is absent, and deliberately: it reads the entering vertex a preceding edge step
 * retained (`fromV`), which is carried state this route does not yet model. Declining is the whole
 * contract — a movement that quietly forgot which end it came from is a wrong answer.
 */
interface Hop { readonly from: 'src' | 'tgt' | 'id'; readonly to: 'src' | 'tgt' | 'id'; readonly elem: Elem; }
export const HOPS: Readonly<Record<string, readonly Hop[]>> = {
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

/** One joined edge relation and its two per-row edge-end reads: `to` (the reached id) and `from` (the end
 *  the incoming id matched — what a `fromV` channel retains). */
interface HopArm { readonly rel: Rel; readonly to: Expr; readonly from: Expr }

/**
 * THE HOP JOIN — a frontier against `edges` for every direction of a hop table entry, as the arms whose
 * UNION ALL is the hop (one arm unless the frontier is free to read twice).
 *
 * A rooted frontier is the LEFT, `ordered` side of the edge join; a correlated one compares the edge
 * column to the outer expression. `restrict` adds the per-edge condition (the label match).
 *
 * ⚠️ **A MULTI-DIRECTION HOP (`both`/`bothE`/`bothV`) READS ITS FRONTIER ONCE unless a second read is
 * free.** The per-direction UNION ALL names its frontier once per arm, and SQLite has no LATERAL and
 * expands every reference to a derived table or CTE into its own copy — so k chained `both()` hops were
 * 2^k copies of the first: `g.V().both()×16.count()` and `repeat(both()).times(16)` exceeded SQLite's
 * reference limits outright, `local(both()×8.count())` was 46 KB of statement text doubling per hop, and
 * `local(repeat(both()).times(16))` spent 4.7 s in prepare before refusing. So the frontier is crossed
 * with a constant `VALUES (0),(1)` direction relation and joined to `edges` on
 * `(dir = 0 AND e.<from₀> = in) OR (dir = 1 AND e.<from₁> = in)` — SQLite plans that as a MULTI-INDEX OR
 * (one seek of `e_out`, one of `e_in`, measured) — and `to`/`from` are `CASE dir` reads. A self-loop
 * matches under BOTH directions, so it is two rows: the multiset rule carried by the direction row, with
 * no dedup. Where every direction matches the same end (`bothV`: both from `id`) the ON collapses to the
 * one equality and only the reads differ per direction.
 *
 * **The one exemption is a frontier whose second read is free** (`rereadsFreely` — a base-table read, or
 * a correlated column): there the two per-direction joins stay, because the MULTI-INDEX OR pays a rowid
 * set per probe and measured ~45–60% slower per hop than two plain seeks (8 000 vertices:
 * `g.V().both().count()` 14 ms as two joins, 20 ms as one; `bothE().otherV().count()` 13 vs 22). A
 * base-table read holds no doubled reference beneath it, so its copy is a constant factor that cannot
 * compound. That is a fact of the INPUT, never a hop count: every later hop's frontier is the previous
 * hop's join, which is not free, so a chain pays the OR from its second hop on and stays linear.
 *
 * The direction relation names no table and binds nothing (compiler ints), so a recursive term may hold
 * it — and a walk's frontier is its `SelfRef`, never free, so a `both()` walk body is one recursive
 * reference with no compound to transpose (`walk.ts`).
 */
function hopJoin(
  hops: readonly Pick<Hop, 'from' | 'to'>[], from: Frontier, graph: GraphSource, fresh: Minter,
  restrict: (edges: Rel) => Expr | undefined = () => undefined,
): readonly HopArm[] {
  const left = frontierRel(from);
  const free = left ? rereadsFreely(left) : (from as { readonly correlated: Expr }).correlated.kind === 'col';
  return hops.length > 1 && free
    ? hops.map((hop) => directionsJoin([hop], from, graph, fresh, restrict))
    : [directionsJoin(hops, from, graph, fresh, restrict)];
}

/** ONE join of the frontier against `edges` covering every hop in `hops` — through a direction row when
 *  there is more than one (`hopJoin`). */
function directionsJoin(
  hops: readonly Pick<Hop, 'from' | 'to'>[], from: Frontier, graph: GraphSource, fresh: Minter,
  restrict: (edges: Rel) => Expr | undefined,
): HopArm {
  const e = graph.adjacencyEdges(fresh);
  const edgeCols = [meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];
  const dirs = hops.length === 1 ? undefined : make.values({
    id: fresh('dir'), channels: [], type: typeOf(meta('dir', 'int')), rows: hops.map((_, i) => [compilerInt(i)]),
  });
  const dirCols = dirs ? [meta('dir', 'int')] : [];
  const left = frontierRel(from);
  const leftCols = left ? [meta('pid', 'int'), ...carriedCols(left.channels)] : [];
  // **THE INCOMING FRONTIER IS THE LEFT SIDE, AND THE EDGE JOIN IS `ordered`** — a hop is "for each
  // traverser I have, find its edges", so the stream drives and `edges` is probed through
  // `e_out(src,label,tgt)` / `e_in(tgt,label,src)`. With the order free SQLite chose `e_in` and scanned
  // the whole edge table for a hop off ONE vertex, taking a 4 000-vertex `has(name).out(knows).values(name)`
  // to 1 492 ms; pinned, it seeks `e_out` and takes 0.3 ms. The direction row is crossed onto the frontier
  // BEFORE the edges, so each (traverser, direction) pair is one indexed probe.
  //
  // `driver` is what the ON reads the incoming id and the direction off: the frontier crossed with the
  // directions, the bare frontier, or — correlated — the direction row alone.
  const driver: Rel | undefined = left && dirs
    ? make.join({ id: fresh('j'), left, right: dirs, join: 'cross', channels: left.channels, type: typeOf(...leftCols, ...dirCols) })
    : left ?? dirs;
  const incoming = left ? col(driver!.id, dirs ? 'pid' : 'id') : (from as { readonly correlated: Expr }).correlated;
  const froms = hops.map((hop) => hop.from);
  const matched = !dirs || froms.every((name) => name === froms[0])
    ? eq(col(e.id, froms[0]!), incoming)
    : froms.reduce<Expr | undefined>((acc, name, i) =>
      or(acc, and(eq(col(driver!.id, 'dir'), compilerInt(i)), eq(col(e.id, name), incoming))), undefined)!;
  const on = and(matched, restrict(e));
  // A correlated single-direction hop FILTERS the edge table against the outer id; every other form JOINS.
  const source = driver
    ? make.join({
      id: fresh('j'), left: driver, right: e, join: 'inner', ordered: true, on, channels: driver.channels,
      type: typeOf(...leftCols, ...dirCols, ...edgeCols),
    })
    : make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: on });
  /** One read per direction, as `CASE dir` — or the plain column when every direction agrees. */
  const perDir = (end: (hop: Pick<Hop, 'from' | 'to'>) => string): Expr => {
    const ends = hops.map(end);
    if (!dirs || ends.every((name) => name === ends[0])) return col(source.id, ends[0]!);
    return {
      kind: 'case',
      whens: ends.slice(0, -1).map((name, i) => [eq(col(source.id, 'dir'), compilerInt(i)), col(source.id, name)] as const),
      else: col(source.id, ends[ends.length - 1]!),
    };
  };
  return { rel: source, to: perDir((hop) => hop.to), from: perDir((hop) => hop.from) };
}

export function movement(step: IRStep, from: Frontier, elem: Elem, graph: GraphSource, fresh: Minter, withLabels = false, mintFromV = false): { rel: Rel; elem: Elem } | null {
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
  // `otherV()` needs the entering vertex retained: an EDGE hop mints a `fromV` channel = the incoming
  // vertex id (the edge column this hop matched against, `hop.from`), which is exactly the nearest
  // previous vertex `EdgeOtherVertexStep` reads from the path. Only an edge-producing hop and only when
  // an `otherV` will consume it (`mintFromV`) — for a CORRELATED body too (`hop.from` is the matched
  // endpoint, i.e. the subject vertex the EXISTS is rooted at), so `where(outE().order().otherV())` works.
  const wantFromV = mintFromV && hops.every((hop) => hop.to === 'id');
  const outChannels = wantFromV ? withChannel(carried, FROM_V) : carried;
  const armCols = elementCols(outChannels);
  // A correlated hop FILTERS the edge table against the outer id; a rooted one JOINS the incoming
  // frontier. The projection is identical either way, which is what keeps the second hop from needing
  // a second implementation. A correlated body's `bulk` is synthetic: an EXISTS asks whether a row is
  // there, never how many traversers it is.
  //
  // An arm carries the INCOMING position through unchanged; re-minting happens once over the whole
  // fan-out below, not per arm — two arms each numbering from 1 would interleave. A `fromV` channel (edge
  // hops, under `mintFromV`) takes the edge end the row matched (`hop.from`, per direction) — the vertex
  // it entered from — so `bothE`'s two directions each carry their own entering vertex.
  const arms = hopJoin(hops, from, graph, fresh, (e) =>
    labelArgs.length ? graph.edgeLabelMatch(col(e.id, 'label'), labelArgs, fresh)
      // NAMED labels, none of which can match — `out(null)`. NEVER, not "every label".
      : asked.given ? CONSTANT.false : undefined,
  ).map((arm) => make.project({
    id: fresh('m'), input: arm.rel, channels: outChannels, type: typeOf(...armCols),
    exprs: [['id', arm.to],
      ...outChannels.map((channel) =>
        channel.role === 'fromV' ? [channel.col, arm.from] as const
        : !input && channel.role === 'bulk' ? [channel.col, compilerInt(1)] as const
        : [channel.col, col(arm.rel.id, channel.col)] as const)],
  }));
  // N-ary UNION ALL, minted once — and ALL, never distinct: traversers are a multiset, so a vertex
  // reachable both ways is two traversers.
  let fanned: Rel = arms.length > 1
    ? make.union({ id: fresh('u'), inputs: arms, all: true, channels: outChannels, type: typeOf(...armCols) })
    : arms[0]!;
  if (pathCarried(fanned))
    fanned = extendPath(fanned, { kind: 'element', elem: hops[0]!.elem, id: col(fanned.id, 'id') }, fresh, withLabels);
  const encounter = encounterOf(carried);
  return { rel: encounter ? remintOrder(fanned, encounter, fresh) : fanned, elem: hops[0]!.elem };
}

/**
 * `otherV()` — the edge's OTHER endpoint, given the vertex the traverser entered from.
 *
 * `EdgeOtherVertexStep` reads the nearest previous vertex out of the traverser's path and returns
 * whichever endpoint is not it (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java`),
 * throwing when the path holds no previous vertex. We carry that vertex as the `fromV` channel the
 * preceding edge hop minted; absent it — `E().otherV()`, or a stream that never retained one — this
 * DECLINES, which is the same fail-closed answer.
 *
 * The reached vertex is `tgt` when we entered from `src`, else `src` — read off the edge row rejoined
 * by id (a UNIQUE key, so the join is 1:1 and the emission order rides through unchanged). A self-loop
 * (`src == tgt == fromV`) yields the vertex itself, as it must. `fromV` is spent here and dropped;
 * every other channel passes through.
 */
export function otherVertex(rel: Rel, elem: Elem, graph: GraphSource, fresh: Minter, withLabels = false): { rel: Rel; elem: Elem } | null {
  if (elem !== 'edge') return null;
  const fromV = fromVOf(rel.channels);
  if (!fromV) return null;
  const e = graph.adjacencyEdges(fresh);
  // The right side's `id` is declared `eid` — a Join's output names are POSITIONAL and must be unique.
  const joined = make.join({
    id: fresh('j'), left: rel, right: e, join: 'inner', ordered: true, channels: rel.channels,
    type: typeOf(...elementCols(rel.channels), meta('eid', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    on: eq(col(e.id, 'id'), col(rel.id, 'id')),
  });
  const outChannels = rel.channels.filter((channel) => channel.role !== 'fromV');
  const reached: Expr = {
    kind: 'case',
    whens: [[eq(col(joined.id, 'src'), col(joined.id, fromV.col)), col(joined.id, 'tgt')]],
    else: col(joined.id, 'src'),
  };
  const projected = make.project({
    id: fresh('ov'), input: joined, channels: outChannels, type: typeOf(...elementCols(outChannels)),
    exprs: [['id', reached], ...outChannels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
  });
  // Under `path()` the reached vertex is the next path position — `[startV, edge, otherV]`. The entering
  // edge hop already appended the edge; `otherV` appends this vertex, exactly as a movement hop does.
  return { elem: 'vertex', rel: pathCarried(projected) ? extendPath(projected, { kind: 'element', elem: 'vertex', id: col(projected.id, 'id') }, fresh, withLabels) : projected };
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
