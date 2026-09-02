// MOVEMENT — the physical graph algebra: a non-start V()/E() re-source (a cross join over an
// element scan) and the adjacency/endpoint hops (a join over `edges` with a re-projection). A pure
// SINK over the `GraphSource` + carried-channel vocabulary: nothing here re-enters the fold, so it is
// the cleanest slice of the old lower.ts. Extracted from lower.ts; see ./chain.ts for the vocabulary.
import * as make from '../../../rel/factory.ts';
import { col, compilerInt, type Expr } from '../../../rel/expr.ts';
import { and, carriedCols, elementCols, eq, labelSetArgs, meta, renumber, typeOf, type Minter } from '../build.ts';
import { withChannel } from '../../../channels.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { Elem } from '../../elem.ts';
import type { IRStep } from '../../ir/strategies.ts';
import type { RelFraming } from '../framing.ts';
import type { GraphSource } from '../source.ts';
import { CONSTANT } from '../predicate.ts';
import { extendPath, pathCarried } from '../path.ts';
import { BULK, ENCOUNTER, encounterOf, FROM_V, fromVOf, type ChainCtx } from './chain.ts';
import { remintOrder } from '../lower.ts';

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
  if (!arrivingEncounter) return { elem, rel: project() };
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
    elem,
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
  // an `otherV` will consume it (`mintFromV`); a vertex hop or a correlated body never carries it.
  const wantFromV = mintFromV && input != null && hops.every((hop) => hop.to === 'id');
  const outChannels = wantFromV ? withChannel(carried, FROM_V) : carried;
  const armCols = elementCols(outChannels);
  const arms = hops.map((hop) => {
    const e = graph.adjacencyEdges(fresh);
    const incoming = input ? col(input.id, 'id') : (from as { readonly correlated: Expr }).correlated;
    const on = and(eq(col(e.id, hop.from), incoming),
      labelArgs.length ? graph.edgeLabelMatch(col(e.id, 'label'), labelArgs, fresh)
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
    // whole fan-out below, not per arm — two arms each numbering from 1 would interleave. A `fromV`
    // channel (edge hops, under `mintFromV`) takes this hop's incoming end (`hop.from`) — the vertex
    // this arm entered from — so `bothE`'s two arms each carry their own entering vertex.
    return make.project({
      id: fresh('m'), input: source, channels: outChannels, type: typeOf(...armCols),
      exprs: [['id', col(source.id, hop.to)],
        ...outChannels.map((channel) =>
          channel.role === 'fromV' ? [channel.col, col(source.id, hop.from)] as const
          : !input && channel.role === 'bulk' ? [channel.col, compilerInt(1)] as const
          : [channel.col, col(source.id, channel.col)] as const)],
    });
  });
  const [first, ...rest] = arms;
  if (!first) return null;
  // N-ary UNION ALL, minted once — and ALL, never distinct: traversers are a multiset, so a vertex
  // reachable both ways is two traversers.
  let fanned: Rel = rest.length
    ? make.union({ id: fresh('u'), inputs: arms, all: true, channels: outChannels, type: typeOf(...armCols) })
    : first;
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
export function otherVertex(rel: Rel, elem: Elem, graph: GraphSource, fresh: Minter): { rel: Rel; elem: Elem } | null {
  if (elem !== 'edge') return null;
  const fromV = fromVOf(rel.channels);
  if (!fromV) return null;
  // A path position would need appending here; `otherV()` under `path()` is a separate combination.
  if (pathCarried(rel)) return null;
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
  return {
    elem: 'vertex',
    rel: make.project({
      id: fresh('ov'), input: joined, channels: outChannels, type: typeOf(...elementCols(outChannels)),
      exprs: [['id', reached], ...outChannels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
    }),
  };
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
