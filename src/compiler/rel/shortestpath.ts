import type { Channel, Channels } from '../../channels.ts';
import { col, compilerInt, compilerReal, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ListOf } from '../../sql/kernel/render.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/step.ts';
import { SHAPE_K } from '../alias.ts';
import { and, carriedCols, eq, meta, typeOf, type Minter } from './build.ts';
import type { ChildSeam } from './child.ts';
import { historyAppend, objectEntry, type TraverserObject } from './history.ts';
import { PATH_CHANNEL, PATH_COL, pathPositions, seedPath } from './path.ts';
import type { GraphSource } from './source.ts';

/**
 * `shortestPath()` — path RECONSTRUCTION for the BSP barrier (`docs/2026-08-23-barrier-substrate-reshape-plan.md`
 * §5). TinkerPop's OLAP shortest-path step runs on ONE substrate for BOTH weighted and unweighted searches:
 * the service's barrier `apply` relaxes the shortest DISTANCE from each source vertex into `barrier_state`
 * (scope = source, channel 0 — `relaxShortestPath`), and this file rebuilds the shortest PATHS from it.
 *
 * Reconstruction is a `Recursive` term (P1/P2) framed by `pathPositions` (the same wire form `path()`
 * produces), seeded from the source vertices, walking ONLY shortest-path edges: an edge (u,v) is on a
 * shortest path from s iff `dist[s][v] = dist[s][u] + w(u,v)` (w = the edge weight, or 1 unweighted). Both
 * distances are read from `barrier_state`, so the equality is FLOAT-EXACT; a simple-path backstop guards
 * zero/negative weights. Because only shortest-path edges are walked there is no MIN window and no
 * exponential blowup — which is exactly why the old enumerate-every-simple-path walk (deleted) hung on a
 * dense graph even unweighted, and why the min-distance relaxation lives in the barrier (an aggregate a
 * recursive term forbids — P3 / repeat-two-regimes §1a). The helpers below (`DIR_HOPS`, `notInPath`, the
 * path-entry builders) were the walk's and are reused verbatim.
 */

/** The bulk channel carried beside the path — one traverser per emitted path. */
const BULK_CHANNEL: Channel = { col: 'bulk', role: 'bulk' };

/** A scope direction as an edge-column pair: which edge column matches the current endpoint (`from`)
 *  and which yields the neighbour (`to`). `both` is the two halves — the multiset UNION ALL that makes a
 *  self-loop legitimately yield the vertex twice, exactly as `HOPS.both` does. */
const DIR_HOPS: Readonly<Record<'out' | 'in' | 'both', readonly { readonly from: 'src' | 'tgt'; readonly to: 'src' | 'tgt' }[]>> = {
  out: [{ from: 'src', to: 'tgt' }],
  in: [{ from: 'tgt', to: 'src' }],
  both: [{ from: 'src', to: 'tgt' }, { from: 'tgt', to: 'src' }],
};


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


// ---------- reconstruction from the precomputed dist relation (the BSP resume) ----------
//
// See the file header: the barrier's `apply` (`relaxShortestPath`) landed the shortest DISTANCE in
// `barrier_state`, and this rebuilds the shortest PATHS from it — weighted or unweighted — gated on the
// float-exact `dv = du + w`.

export interface ReconstructConfig {
  readonly direction: 'out' | 'in' | 'both';
  readonly labels: readonly string[];
  readonly includeEdges: boolean;
  /** The edge WEIGHT property key (weighted), or `undefined` for unweighted (hop distance, w=1). */
  readonly distanceKey?: string;
  /** A distance cap — filters the FINAL shortest distance per pair (dist[s][endpoint] <= cap): a hop cap
   *  when unweighted, a weight cap when weighted. Not a walk prune (a custom weight may be negative). */
  readonly maxWeight?: number;
  readonly target?: readonly IRStep[];
}

/** A correlated scalar reading dist[scope][id] off `barrier_state` (this run's final slot, channel 0).
 *  `run`/`round` inline as literals (compiler-held, O(1) plan — like `decorateBinding`); `scope`/`id` are
 *  the correlation. A `WITHOUT ROWID` PK on (run,round,scope,id,channel) makes it a single row. */
function distAt(run: number, round: number, scopeExpr: Expr, idExpr: Expr, fresh: Minter): Expr {
  const scan = make.scan({
    id: fresh('rds'), table: 'barrier_state', alias: fresh('rdb'), channels: [],
    type: typeOf(meta('run', 'int'), meta('round', 'int'), meta('scope', 'int'), meta('id', 'int'), meta('channel', 'int'), meta('cval', 'real', true)),
  });
  const filtered = make.filter({
    id: fresh('rdf'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, 'run'), compilerInt(run)),
          and(eq(col(scan.id, 'round'), compilerInt(round)),
          and(eq(col(scan.id, 'channel'), compilerInt(0)),
          and(eq(col(scan.id, 'scope'), scopeExpr), eq(col(scan.id, 'id'), idExpr))))),
  });
  const proj = make.project({
    id: fresh('rdp'), input: filtered, channels: [], type: typeOf(meta('cval', 'real', true)),
    exprs: [['cval', col(filtered.id, 'cval')]],
  });
  return { kind: 'scalar', plan: proj };
}

/** DISTINCT source vertices — the scopes the relaxation seeded — as the reconstruction's seed rows. */
function reconstructSources(run: number, round: number, walkType: ReturnType<typeof typeOf>, channels: Channels, fresh: Minter): Rel {
  const scan = make.scan({
    id: fresh('sss'), table: 'barrier_state', alias: fresh('ssb'), channels: [],
    type: typeOf(meta('run', 'int'), meta('round', 'int'), meta('scope', 'int'), meta('id', 'int'), meta('channel', 'int'), meta('cval', 'real', true)),
  });
  const filtered = make.filter({
    id: fresh('ssf'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, 'run'), compilerInt(run)), and(eq(col(scan.id, 'round'), compilerInt(round)), eq(col(scan.id, 'channel'), compilerInt(0)))),
  });
  const scopes = make.distinct({
    id: fresh('ssd'), channels: [], type: typeOf(meta('scope', 'int')),
    input: make.project({ id: fresh('ssp'), input: filtered, channels: [], type: typeOf(meta('scope', 'int')), exprs: [['scope', col(filtered.id, 'scope')]] }),
  });
  return make.project({
    id: fresh('ssseed'), input: scopes, channels, type: walkType,
    exprs: [
      ['id', col(scopes.id, 'scope')], ['src', col(scopes.id, 'scope')], ['bulk', compilerInt(1)],
      [PATH_COL, seedPath(vertexEntry(col(scopes.id, 'scope')))],
    ],
  });
}

export function shortestPathReconstruct(
  run: number, round: number, cfg: ReconstructConfig, source: GraphSource, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly scalars: boolean } | null {
  const channels: Channels = [BULK_CHANNEL, PATH_CHANNEL];  // ROLE_ORDER: bulk before path
  // No `dist` payload — the gate reads both endpoints' distance off `barrier_state` (float-exact).
  const walkType = typeOf(meta('id', 'int'), meta('src', 'int'), ...carriedCols(channels));
  const header = walkType.cols.map((c) => c.name);
  const hops = DIR_HOPS[cfg.direction];
  const labelArgs: Arg[] = cfg.labels.map((label) => ({ value: label, type: null, name: null }));
  let termOk = true;
  const walkId = fresh('spr');
  const walk = make.recursive({
    id: walkId, name: `spr_${walkId}`, channels, type: walkType, cols: header,
    seed: reconstructSources(run, round, walkType, channels, fresh),
    step: (self) => {
      const arms = hops.map((hop) => {
        const e = source.adjacencyEdges(fresh);
        const labelMatch = labelArgs.length ? source.edgeLabelMatch(col(e.id, 'label'), labelArgs, fresh) : undefined;
        const joined = make.join({
          id: fresh('spj'), left: self, right: e, join: 'inner', ordered: true, channels,
          on: and(eq(col(e.id, hop.from), col(self.id, 'id')), labelMatch),
          type: typeOf(
            meta('pid', 'int'), meta('psrc', 'int'), meta('bulk', 'int'), meta(PATH_COL, 'json', true),
            meta('eid', 'int'), meta('esrc', 'int'), meta('elabel', 'int'), meta('etgt', 'int'),
          ),
        });
        const neighbourCol = hop.to === 'tgt' ? 'etgt' : 'esrc';
        const neighbour = col(joined.id, neighbourCol);
        // The per-edge weight — the SAME the relaxation used, so `du + w` reproduces the stored `dv`
        // exactly: the `values(key)` read over the edge (COALESCE 0) when weighted, else the constant 1.
        let weight: Expr;
        if (cfg.distanceKey !== undefined) {
          const w = child.scalar(valuesStep(cfg.distanceKey), { kind: 'element', id: col(joined.id, 'eid'), elem: 'edge' });
          if (!w) { termOk = false; return joined; }
          weight = { kind: 'call', fn: 'COALESCE', args: [w.expr, compilerReal(0)] };
        } else {
          weight = compilerInt(1);
        }
        const du = distAt(run, round, col(joined.id, 'psrc'), col(joined.id, 'pid'), fresh);
        const dv = distAt(run, round, col(joined.id, 'psrc'), neighbour, fresh);
        // Keep only shortest-path edges (dist-gate), and never revisit a vertex (backstop for zero/negative
        // weights, where the dist-gate alone would not strictly increase).
        const guarded = make.filter({
          id: fresh('spg'), input: joined, channels, type: joined.type,
          pred: and(notInPath(joined, neighbour, fresh), eq(dv, { kind: 'binary', op: '+', left: du, right: weight })),
        });
        const appended = cfg.includeEdges
          ? historyAppend(historyAppend(col(guarded.id, PATH_COL), objectEntry(edgeEntry(col(guarded.id, 'eid')))), objectEntry(vertexEntry(col(guarded.id, neighbourCol))))
          : historyAppend(col(guarded.id, PATH_COL), objectEntry(vertexEntry(col(guarded.id, neighbourCol))));
        return make.project({
          id: fresh('spa'), input: guarded, channels, type: walkType,
          exprs: [['id', col(guarded.id, neighbourCol)], ['src', col(guarded.id, 'psrc')], ['bulk', compilerInt(1)], [PATH_COL, appended]],
        });
      });
      return arms.length === 1 ? arms[0]! : make.union({ id: fresh('spu'), inputs: arms, all: true, channels, type: walkType });
    },
  });
  if (recursiveViolation(walk) || !termOk) return null;

  // Every emitted path IS a shortest path (the gate), so no MIN window — the reconstruction is the result.
  let selected: Rel = walk;
  // A weighted maxDistance caps the FINAL shortest distance per (source, endpoint): dist[src][id] <= cap.
  if (cfg.maxWeight !== undefined) {
    selected = make.filter({
      id: fresh('sprw'), input: selected, channels, type: selected.type,
      pred: { kind: 'binary', op: '<=', left: distAt(run, round, col(selected.id, 'src'), col(selected.id, 'id'), fresh), right: compilerReal(cfg.maxWeight) },
    });
  }
  if (cfg.target) {
    const pred = child.predicate(cfg.target, { kind: 'element', id: col(selected.id, 'id'), rel: selected, elem: 'vertex' }, false);
    if (!pred) return null;
    selected = make.filter({ id: fresh('sprt'), input: selected, channels, type: selected.type, pred });
  }
  const deduped = make.distinct({ id: fresh('sprd'), input: selected, channels, type: selected.type });
  const pathStep = { name: 'path', args: [] } as unknown as IRStep;
  return pathPositions(deduped, pathStep, child, source, fresh);
}
