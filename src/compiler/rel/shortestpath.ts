import type { Channel, Channels } from '../../channels.ts';
import { col, compilerInt, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ListOf } from '../../sql/kernel/render.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/step.ts';
import { SHAPE_K } from '../plan/alias.ts';
import type { Elem } from '../plan/plan.ts';
import { and, carriedCols, eq, meta, typeOf, type Minter } from './build.ts';
import type { ChildSeam } from './child.ts';
import { historyAppend, objectEntry, type TraverserObject } from './history.ts';
import { PATH_CHANNEL, PATH_COL, pathPositions, seedPath } from './path.ts';
import type { GraphSource } from './source.ts';

/**
 * `shortestPath()` — TinkerPop's OLAP shortest-path step, compiled to ONE recursive CTE (Template B,
 * `docs/2026-07-24-graph-algorithms-plan.md`). Unlike the three DECORATE algorithms
 * (pageRank/wcc/peerPressure), it is NOT a barrier: an unweighted all-pairs shortest path is expressible
 * as a single `Recursive` term (§1's P1/P2), so it lowers inline like `repeat()`'s unbounded regime does.
 *
 * ## The shape
 *
 * The incoming element stream is the set of SOURCE vertices (TinkerPop seeds the search from the halted
 * traversers, `ShortestPathVertexProgram.isStartVertex`). Each source fans out to every reachable target
 * along its SHORTEST path(s), landing the result in the PATH channel (`path.ts`) — the same list value
 * `path()` produces, so the wire framing is shared.
 *
 * A recursive walk enumerates every SIMPLE path (cycle-free — `!currentPath.objects().contains(otherV)`,
 * which is P2-legal as a `NOT EXISTS` membership over the carried path array). It carries three payload
 * columns beside the path: `id` (the current endpoint), `src` (the source it started from) and `dist`
 * (hop count). AFTER the walk, a `MIN(dist) OVER (PARTITION BY src, id)` window keeps only the shortest
 * distance per (source, target), ALL ties included — exactly the reference's `Set<Path>` per pair.
 *
 * Why the walk cannot be `repeatWalk` (`walk.ts`): that regime DECLINES a path channel ("path needs its
 * own append regime") because its per-arm counter bump distributes over the movement union, and
 * `extendPath` sits ABOVE that union. This builder distributes the append, the distance bump and the
 * simple-path filter INTO each arm, so each arm references the walk exactly once (P1) and a `both` scope
 * is two arms `UNION ALL`, exactly as a `both()` movement is.
 *
 * ## Scope this builder covers
 *
 * The UNWEIGHTED family: the default `bothE` scope and the `~tinkerpop.shortestPath.edges` direction
 * override (`Direction.IN`/`__.outE()`/`__.bothE()`), `~tinkerpop.shortestPath.includeEdges` (the path
 * interleaves the traversed edges), and the unweighted `~tinkerpop.shortestPath.maxDistance` (a hop cap
 * that prunes the walk). A weighted `distance` and a `target` filter fail closed in the service until
 * their increments land — never a mis-execution.
 */

/** The bulk channel this walk carries beside the path — one traverser per emitted path. */
const BULK_CHANNEL: Channel = { col: 'bulk', role: 'bulk' };

/** A scope direction as an edge-column pair: which edge column matches the current endpoint (`from`)
 *  and which yields the neighbour (`to`). `both` is the two halves — the multiset UNION ALL that makes a
 *  self-loop legitimately yield the vertex twice, exactly as `HOPS.both` does. */
const DIR_HOPS: Readonly<Record<'out' | 'in' | 'both', readonly { readonly from: 'src' | 'tgt'; readonly to: 'src' | 'tgt' }[]>> = {
  out: [{ from: 'src', to: 'tgt' }],
  in: [{ from: 'tgt', to: 'src' }],
  both: [{ from: 'src', to: 'tgt' }, { from: 'tgt', to: 'src' }],
};

export interface ShortestPathConfig {
  readonly direction: 'out' | 'in' | 'both';
  /** Edge labels the scope restricts to (`~tinkerpop.shortestPath.edges` = `__.bothE("uses")`); empty =
   *  every label. Inline string literals, so they inline into the join with no bind. */
  readonly labels: readonly string[];
  readonly includeEdges: boolean;
  /** An unweighted hop cap (`~tinkerpop.shortestPath.maxDistance`) — a path longer than this is never
   *  extended (`ShortestPathVertexProgram.exceedsMaxDistance`, which only prunes for hop distances). */
  readonly maxHops?: number;
  /** `~tinkerpop.shortestPath.distance` — a WEIGHT property key on the edge. When set, distance is the
   *  sum of edge weights (a REAL) rather than the hop count, so the shortest path is the least-weight
   *  one. The reference reads it as `__.values(key)` over each edge, orElse 0 (`getDistance`). */
  readonly distanceKey?: string;
  /** A WEIGHTED distance cap (`~tinkerpop.shortestPath.maxDistance` with a `distance` set). Unlike the
   *  hop cap it does NOT prune the walk (a custom distance may be negative); it filters the FINAL
   *  shortest distance per pair at collection (`pair.dist <= maxDistance`, `collectShortestPaths`). */
  readonly maxWeight?: number;
  /** `~tinkerpop.shortestPath.target` — a vertex predicate the ENDPOINT must pass for its path to be
   *  emitted (`ShortestPathVertexProgram.isEndVertex`, applied in `collectShortestPaths`). The shortest
   *  path to EVERY vertex is still computed; the target only filters what is collected — so it applies
   *  AFTER the shortest-per-pair selection. The trivial path (source == endpoint) is emitted iff the
   *  source passes it, which the same endpoint filter covers. Parsed to the predicate body IR. */
  readonly target?: readonly IRStep[];
}

const vertexEntry = (id: Expr): TraverserObject => ({ kind: 'element', elem: 'vertex', id });
const edgeEntry = (id: Expr): TraverserObject => ({ kind: 'element', elem: 'edge', id });

/** The distance sub-traversal the reference uses — `__.values(key)` over each edge (`getDistance`). */
const valuesStep = (key: string): readonly IRStep[] =>
  [{ name: 'values', args: [{ value: key, type: null, name: null }] }] as unknown as readonly IRStep[];

/** `NOT EXISTS (a vertex position already holding <neighbour>)` over the carried path — the simple-path
 *  guard, correlated to `rel`'s row. P2-legal (a `NOT EXISTS` over a `json_each` in a recursive term). */
function notInPath(rel: Rel, neighbour: Expr, fresh: Minter): Expr {
  const exploded = make.explode({
    id: fresh('spx'), channels: [], expr: { kind: 'call', fn: 'json', args: [col(rel.id, PATH_COL)] },
    as: { value: 'v' }, type: typeOf(meta('v', 'any', true)),
  });
  const probe = make.filter({
    id: fresh('spf'), input: exploded, channels: [], type: exploded.type,
    pred: and(
      eq({ kind: 'call', fn: 'json_extract', args: [col(exploded.id, 'v'), compilerText('$.k')] }, compilerInt(SHAPE_K.vertex)),
      eq({ kind: 'call', fn: 'json_extract', args: [col(exploded.id, 'v'), compilerText('$.v')] }, neighbour),
    ),
  });
  return { kind: 'exists', negated: true, plan: probe };
}

export function shortestPathWalk(
  input: Rel, elem: Elem, source: GraphSource, cfg: ShortestPathConfig, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly scalars: boolean } | null {
  // The sources are the incoming traversers, which must be vertices (shortestPath walks the vertex graph).
  if (elem !== 'vertex') return null;

  const channels: Channels = [BULK_CHANNEL, PATH_CHANNEL];  // ROLE_ORDER: bulk before path
  // Distance is a hop COUNT (int) by default, or a WEIGHT SUM (real) when a distance property is set.
  const weighted = cfg.distanceKey !== undefined;
  const zeroDist: Expr = weighted ? compilerReal(0) : compilerInt(0);
  // Payload = the endpoint id, the source it started from, and the distance; then the channels.
  const walkType = typeOf(meta('id', 'int'), meta('src', 'int'), meta('dist', weighted ? 'real' : 'int'), ...carriedCols(channels));
  const header = walkType.cols.map((c) => c.name);

  // SEED: one row per source vertex — path [source], src = itself, dist 0, one traverser. The trivial
  // path (source == target) is this row; it is emitted like any other once it passes the tail filters.
  const seed = make.project({
    id: fresh('sps'), input, channels, type: walkType,
    exprs: [
      ['id', col(input.id, 'id')],
      ['src', col(input.id, 'id')],
      ['dist', zeroDist],
      ['bulk', compilerInt(1)],
      [PATH_COL, seedPath(vertexEntry(col(input.id, 'id')))],
    ],
  });

  const hops = DIR_HOPS[cfg.direction];
  // Inline string-literal label Args (no bind — they came from a parsed anonymous edge traversal).
  const labelArgs: Arg[] = cfg.labels.map((label) => ({ value: label, type: null, name: null }));
  let termOk = true;
  const walkId = fresh('spw');
  const walk = make.recursive({
    id: walkId, name: `sp_${walkId}`, channels, type: walkType, cols: header, seed,
    step: (self) => {
      const arms = hops.map((hop) => {
        const e = source.adjacencyEdges(fresh);
        // JOIN self ⋈ edges on the endpoint. The output type is left cols ++ right cols positionally
        // (`movement`'s `pid` convention): self's `id`/`src` are renamed to avoid the edge's own
        // `id`/`src`, the channel columns keep their canonical names. A label-scoped edges traversal
        // restricts the hop, exactly as a `both("uses")` movement does — inline string labels, no bind.
        const labelMatch = labelArgs.length
          ? source.edgeLabelMatch(col(e.id, 'label'), labelArgs, fresh) : undefined;
        const joined = make.join({
          id: fresh('spj'), left: self, right: e, join: 'inner', ordered: true, channels,
          on: and(eq(col(e.id, hop.from), col(self.id, 'id')), labelMatch),
          type: typeOf(
            meta('pid', 'int'), meta('psrc', 'int'), meta('dist', 'int'), meta('bulk', 'int'), meta(PATH_COL, 'json', true),
            meta('eid', 'int'), meta('esrc', 'int'), meta('elabel', 'int'), meta('etgt', 'int'),
          ),
        });
        const neighbourCol = hop.to === 'tgt' ? 'etgt' : 'esrc';
        // Simple-path guard: the neighbour must not already be on the path (BEFORE it is appended).
        const guarded = make.filter({
          id: fresh('spg'), input: joined, channels, type: joined.type,
          pred: notInPath(joined, col(joined.id, neighbourCol), fresh),
        });
        const neighbour = col(guarded.id, neighbourCol);
        const appended = cfg.includeEdges
          ? historyAppend(historyAppend(col(guarded.id, PATH_COL), objectEntry(edgeEntry(col(guarded.id, 'eid')))), objectEntry(vertexEntry(neighbour)))
          : historyAppend(col(guarded.id, PATH_COL), objectEntry(vertexEntry(neighbour)));
        // The per-hop distance: 1 hop, or the edge's weight property (orElse 0) when a distance key is
        // set. The weight is a correlated `values(key)` read over the edge — a nested SELECT, P2-legal.
        let delta: Expr = weighted ? compilerReal(0) : compilerInt(1);
        if (weighted) {
          const w = child.scalar(valuesStep(cfg.distanceKey!), { kind: 'element', id: col(guarded.id, 'eid'), elem: 'edge' });
          if (w) delta = { kind: 'call', fn: 'COALESCE', args: [w.expr, compilerReal(0)] };
          else termOk = false;  // the weight read did not lower — decline the whole walk
        }
        const extended = make.project({
          id: fresh('spa'), input: guarded, channels, type: walkType,
          exprs: [
            ['id', neighbour],
            ['src', col(guarded.id, 'psrc')],
            ['dist', { kind: 'binary', op: '+', left: col(guarded.id, 'dist'), right: delta }],
            ['bulk', compilerInt(1)],
            [PATH_COL, appended],
          ],
        });
        // An unweighted maxDistance PRUNES the walk: a hop past the cap is never taken.
        return cfg.maxHops === undefined ? extended : make.filter({
          id: fresh('spm'), input: extended, channels, type: walkType,
          pred: { kind: 'binary', op: '<=', left: col(extended.id, 'dist'), right: compilerInt(cfg.maxHops) },
        });
      });
      return arms.length === 1 ? arms[0]! : make.union({
        id: fresh('spu'), inputs: arms, all: true, channels, type: walkType,
      });
    },
  });
  if (recursiveViolation(walk) || !termOk) return null;

  // SHORTEST per (source, target), ALL ties: keep the rows whose distance equals the partition minimum.
  const ranked = make.window({
    id: fresh('spr'), input: walk, channels, type: typeOf(...walk.type.cols, meta('md', 'int')),
    specs: [['md', {
      kind: 'window-expr', fn: 'min', args: [col(walk.id, 'dist')],
      spec: { partitionBy: [col(walk.id, 'src'), col(walk.id, 'id')], orderBy: [] },
    }]],
  });
  const shortest = make.filter({
    id: fresh('spmn'), input: ranked, channels, type: ranked.type,
    pred: eq(col(ranked.id, 'dist'), col(ranked.id, 'md')),
  });
  const dropped = make.project({
    id: fresh('spd'), input: shortest, channels, type: walkType,
    exprs: header.map((name) => [name, col(shortest.id, name)] as const),
  });
  // COLLECTION FILTERS — applied AFTER the shortest-per-pair selection (the reference computes the
  // shortest path to every vertex and filters only what it collects, `collectShortestPaths`).
  let selected: Rel = dropped;
  // A WEIGHTED maxDistance caps the final shortest distance per pair (it does NOT prune the walk, since a
  // custom distance may be negative — `exceedsMaxDistance` only prunes for hop distances).
  if (weighted && cfg.maxWeight !== undefined) {
    selected = make.filter({
      id: fresh('spw'), input: selected, channels, type: selected.type,
      pred: { kind: 'binary', op: '<=', left: col(selected.id, 'dist'), right: compilerReal(cfg.maxWeight) },
    });
  }
  // TARGET FILTER — the endpoint (the path's last vertex) must pass the target predicate. The trivial
  // path's endpoint IS its source, so the same filter gates it.
  if (cfg.target) {
    const pred = child.predicate(cfg.target, { kind: 'element', id: col(selected.id, 'id'), rel: selected, elem: 'vertex' }, false);
    if (!pred) return null;
    selected = make.filter({ id: fresh('spt'), input: selected, channels, type: selected.type, pred });
  }
  // The reference keeps a SET of shortest paths per pair — dedup identical paths (a JSONB path equals
  // another iff its bytes match, which two identical vertex sequences produce).
  const deduped = make.distinct({ id: fresh('spdd'), input: selected, channels, type: selected.type });

  // Consume the path channel exactly as `path()` does. shortestPath carries no `by()` modulation, so a
  // bare `path` step is the honest input — every position frames as its own element.
  const pathStep = { name: 'path', args: [] } as unknown as IRStep;
  return pathPositions(deduped, pathStep, child, source, fresh);
}
