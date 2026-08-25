import type { Service } from '../../spi/types.ts';
import { HITS_SERVICE_NAME } from '../../spi/types.ts';
import type { GraphStore } from '../../../storage.ts';
import { STATE_INSERT, decorateBarrier, stringParam } from './kernel.ts';

// ---------- mogwai.hits — HITS (Kleinberg hubs & authorities), a MULTI-CHANNEL DECORATE barrier ----------
//
// `g.call("mogwai.hits")` decorates each vertex with TWO scores — a hub and an authority — the first
// consumer of the multi-channel decorate substrate (barrier_state channel 0 = hub, channel 1 = auth;
// docs/archive/2026-08-23-barrier-substrate-reshape-plan.md item 2). HITS has no native TinkerPop step, so it is
// call-only, GDS-style. A faithful replay of the Wikipedia iteration GDS itself asserts against
// (`vendor/gds/algo/src/test/java/org/neo4j/gds/hits/HitsTest.java` `PseudoCodeHits`, GPLv3 — re-expressed
// in SQL, never transcribed): init hub=auth=1, then k iterations of
//   auth[v] = Σ hub[u] for u→v (in-neighbours), L2-normalise;  hub[v] = Σ auth[w] for v→w (out-neighbours), L2-normalise.
// DIRECTED by definition (the in/out split IS the algorithm). The L2 norm is the one scalar that leaves
// SQL each half-step — computed as √(Σ cval²) in JS so no `sqrt` SQL function is assumed on either runtime.
// Rounds are KEPT (round r holds iteration r's two channels); the decorate resume reads the final round.

const HITS_HUB_KEY = 'hub';
const HITS_AUTH_KEY = 'auth';
const HITS_DEFAULT_ITERATIONS = 20;
const HITS_HUB_CHANNEL = 0;
const HITS_AUTH_CHANNEL = 1;

/** L2-normalise one channel of a HITS round IN PLACE: read Σ cval², take √ in JS, divide. A zero norm
 *  (an all-zero channel) leaves the zeros untouched — the reference divides only a positive norm. */
function hitsNormalize(store: GraphStore, run: number, round: number, channel: number): void {
  const s = store.query<{ s: number }>(
    'SELECT COALESCE(SUM(cval * cval), 0) AS s FROM barrier_state WHERE run = ? AND round = ? AND channel = ?',
    [run, round, channel])[0].s;
  const norm = Math.sqrt(s);
  if (norm > 0) store.query(
    'UPDATE barrier_state SET cval = cval / ? WHERE run = ? AND round = ? AND channel = ?',
    [norm, run, round, channel]);
}

/** HITS over a store: a multi-channel DECORATE barrier. `apply` replays the reference iteration in SQL
 *  and returns the `(run, round)` handle into `barrier_state`; the decorate resume stacks a hub layer and
 *  an auth layer over it (`decorate.channels`). Directed edges only — no scope config (HITS is defined by
 *  the edge direction). `iterations` overrides k. */
export function createHitsService(store: GraphStore | undefined): Service {
  return decorateBarrier({
    name: HITS_SERVICE_NAME,
    store,
    describeParams: () => ({
      iterations: `HITS iterations (default ${HITS_DEFAULT_ITERATIONS})`,
      hubProperty: `the vertex property key for the hub score (default ${HITS_HUB_KEY})`,
      authProperty: `the vertex property key for the authority score (default ${HITS_AUTH_KEY})`,
    }),
    plan: (params) => {
      const itersParam = params.iterations;
      const iterations = typeof itersParam === 'number' && Number.isInteger(itersParam) && itersParam >= 0
        ? itersParam : HITS_DEFAULT_ITERATIONS;
      const hubKey = stringParam(params, 'hubProperty', HITS_HUB_KEY);
      const authKey = stringParam(params, 'authProperty', HITS_AUTH_KEY);
      return {
        channels: [
          { key: hubKey, channel: HITS_HUB_CHANNEL, vtype: 'double' },
          { key: authKey, channel: HITS_AUTH_CHANNEL, vtype: 'double' },
        ],
        core: (store, run): number => {
          // SEED round 0: hub = auth = 1 for every vertex (the reference init). The first auth half-step
          // overwrites auth from these hubs, so only hub=1 is load-bearing, but seeding both keeps round 0
          // a complete two-channel snapshot.
          store.query(`${STATE_INSERT} SELECT ?, 0, 0, id, ?, 1.0 FROM nodes`, [run, HITS_HUB_CHANNEL]);
          store.query(`${STATE_INSERT} SELECT ?, 0, 0, id, ?, 1.0 FROM nodes`, [run, HITS_AUTH_CHANNEL]);
          for (let r = 1; r <= iterations; r++) {
            // auth[r][v] = Σ hub[r-1][u] for u→v (in-neighbours). Every vertex gets a row (LEFT JOIN),
            // so an authority-less vertex is 0 rather than absent.
            store.query(
              `${STATE_INSERT}
                 SELECT ?, ?, 0, n.id, ?, COALESCE(SUM(ph.cval), 0)
                   FROM nodes n
                   LEFT JOIN edges e ON e.tgt = n.id
                   LEFT JOIN barrier_state ph ON ph.run = ? AND ph.round = ? AND ph.channel = ? AND ph.id = e.src
                  GROUP BY n.id`,
              [run, r, HITS_AUTH_CHANNEL, run, r - 1, HITS_HUB_CHANNEL]);
            hitsNormalize(store, run, r, HITS_AUTH_CHANNEL);
            // hub[r][v] = Σ auth[r][w] for v→w (out-neighbours), reading the JUST-normalised auth.
            store.query(
              `${STATE_INSERT}
                 SELECT ?, ?, 0, n.id, ?, COALESCE(SUM(ca.cval), 0)
                   FROM nodes n
                   LEFT JOIN edges e ON e.src = n.id
                   LEFT JOIN barrier_state ca ON ca.run = ? AND ca.round = ? AND ca.channel = ? AND ca.id = e.tgt
                  GROUP BY n.id`,
              [run, r, HITS_HUB_CHANNEL, run, r, HITS_AUTH_CHANNEL]);
            hitsNormalize(store, run, r, HITS_HUB_CHANNEL);
          }
          return iterations;
        },
      };
    },
  });
}

