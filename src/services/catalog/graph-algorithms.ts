import type { Service } from '../spi/types.ts';
import {
  PAGERANK_SERVICE_NAME, WCC_SERVICE_NAME, PEER_PRESSURE_SERVICE_NAME, SHORTEST_PATH_SERVICE_NAME,
} from '../spi/types.ts';

// ---------- mogwai.pageRank / .wcc / .peerPressure / .shortestPath — the OLAP algorithm layer ----------
//
// The four canonical TinkerPop OLAP steps (pageRank/connectedComponent/peerPressure/shortestPath)
// desugar to a call() on one of these services (ir/strategies.ts `desugarGraphAlgos`); a GDS-style
// `g.call("mogwai.pageRank", …)` reaches the same service directly. One implementation, two
// front-ends (`docs/2026-07-24-graph-algorithms-plan.md`, principle #2).
//
// All four are INTERNAL (`internal: true`): they back native TinkerPop steps, so a reference-exact
// conformance host must serve them, yet they are not part of the reference provider surface the
// official `--list`/`g_call` scenarios assert — so they are registered in BOTH registries and
// enumerated by neither, exactly as `mogwai.io` is (services/catalog/io.ts, standard.ts).
//
// EXECUTION IS NOT BUILT YET. Each resolves to a clear fail-closed deferral rather than
// mis-executing — the correct-by-design contract for a step whose lowering does not exist. The
// front-end (desugar) and the service registration ARE in place, so the seam is proven additive; the
// compute (a host-driven iteration barrier + a retained-binding decorate tail for the Template-A
// three; a recursive-CTE path relation for shortestPath) lands per the plan doc's build order.

/** A not-yet-implemented OLAP service: resolvable by name, desugared into by its native step, but
 *  fails closed with a clear deferral until its compute lands. NOT a silent decline (`null`) — that
 *  would hand the traversal on as merely uncovered; this states that the service exists and its
 *  execution is pending. `type` declares the eventual contribution shape (barrier for the three
 *  iterative decorate algorithms; streaming for the per-parent path relation). */
function pendingAlgoService(name: string, type: Service['type']): Service {
  return {
    name,
    type,
    internal: true,
    describeParams: () => ({}),
    resolve: () => {
      throw new Error(`${name}: graph algorithm execution is not implemented yet`);
    },
  };
}

export const pageRankService: Service = pendingAlgoService(PAGERANK_SERVICE_NAME, 'barrier');
export const wccService: Service = pendingAlgoService(WCC_SERVICE_NAME, 'barrier');
export const peerPressureService: Service = pendingAlgoService(PEER_PRESSURE_SERVICE_NAME, 'barrier');
export const shortestPathService: Service = pendingAlgoService(SHORTEST_PATH_SERVICE_NAME, 'streaming');

/** The four OLAP services, for registration in both the standard and extended registries. */
export const graphAlgorithmServices: readonly Service[] =
  [pageRankService, wccService, peerPressureService, shortestPathService];
