import type { Channel, Channels } from '../../channels.ts';
import { col, compilerInt, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ListOf } from '../../sql/kernel/render.ts';
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
  readonly includeEdges: boolean;
  /** An unweighted hop cap (`~tinkerpop.shortestPath.maxDistance`) — a path longer than this is never
   *  extended (`ShortestPathVertexProgram.exceedsMaxDistance`, which only prunes for hop distances). */
  readonly maxHops?: number;
}

const vertexEntry = (id: Expr): TraverserObject => ({ kind: 'element', elem: 'vertex', id });
const edgeEntry = (id: Expr): TraverserObject => ({ kind: 'element', elem: 'edge', id });

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
  // Payload = the endpoint id, the source it started from, and the hop distance; then the channels.
  const walkType = typeOf(meta('id', 'int'), meta('src', 'int'), meta('dist', 'int'), ...carriedCols(channels));
  const header = walkType.cols.map((c) => c.name);

  // SEED: one row per source vertex — path [source], src = itself, dist 0, one traverser. The trivial
  // path (source == target) is this row; it is emitted like any other once it passes the tail filters.
  const seed = make.project({
    id: fresh('sps'), input, channels, type: walkType,
    exprs: [
      ['id', col(input.id, 'id')],
      ['src', col(input.id, 'id')],
      ['dist', compilerInt(0)],
      ['bulk', compilerInt(1)],
      [PATH_COL, seedPath(vertexEntry(col(input.id, 'id')))],
    ],
  });

  const hops = DIR_HOPS[cfg.direction];
  let termOk = true;
  const walkId = fresh('spw');
  const walk = make.recursive({
    id: walkId, name: `sp_${walkId}`, channels, type: walkType, cols: header, seed,
    step: (self) => {
      const arms = hops.map((hop) => {
        const e = source.adjacencyEdges(fresh);
        // JOIN self ⋈ edges on the endpoint. The output type is left cols ++ right cols positionally
        // (`movement`'s `pid` convention): self's `id`/`src` are renamed to avoid the edge's own
        // `id`/`src`, the channel columns keep their canonical names.
        const joined = make.join({
          id: fresh('spj'), left: self, right: e, join: 'inner', ordered: true, channels,
          on: eq(col(e.id, hop.from), col(self.id, 'id')),
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
        const extended = make.project({
          id: fresh('spa'), input: guarded, channels, type: walkType,
          exprs: [
            ['id', neighbour],
            ['src', col(guarded.id, 'psrc')],
            ['dist', { kind: 'binary', op: '+', left: col(guarded.id, 'dist'), right: compilerInt(1) }],
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
  // The reference keeps a SET of shortest paths per pair — dedup identical paths (a JSONB path equals
  // another iff its bytes match, which two identical vertex sequences produce).
  const deduped = make.distinct({ id: fresh('spdd'), input: dropped, channels, type: dropped.type });

  // Consume the path channel exactly as `path()` does. shortestPath carries no `by()` modulation, so a
  // bare `path` step is the honest input — every position frames as its own element.
  const pathStep = { name: 'path', args: [] } as unknown as IRStep;
  return pathPositions(deduped, pathStep, child, source, fresh);
}
