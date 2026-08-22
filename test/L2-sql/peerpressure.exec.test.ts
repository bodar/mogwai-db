import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// peerPressure() (mogwai.peerPressure) — a DECORATE barrier. Peer-pressure label propagation: each
// vertex adopts the max-vote cluster among {itself} ∪ {in-neighbours} (default outE, strength 1.0),
// ties to the smallest id-string, to a fixpoint. Cluster id = a vertex id. Reuses the decorate
// substrate verbatim (barrier → global compute → decorate resume).

const KEY = 'gremlin.peerPressureVertexProgram.cluster';
const unmap = (v: any): any => v instanceof Map ? Object.fromEntries([...v]) : v;
const run = async (store: ReturnType<typeof seeded>, gremlin: string): Promise<unknown[]> =>
  Promise.all((await exec(store).framedAsync(gremlin, {})).map((f) => decode(f.buf)));

describe('peerPressure() — mogwai.peerPressure DECORATE barrier', () => {
  test('has(cluster) passes every vertex', async () => {
    const store = seeded(MODERN_SEED);
    // g_V_peerPressure_hasXclusterX
    expect(await run(store, `g.V().peerPressure().has("${KEY}").count()`)).toEqual([6]);
  });

  test('clusters propagate to the min id by peer pressure; an isolated creator keeps its own', async () => {
    const store = seeded(MODERN_SEED);
    const rows = (await run(store, `g.V().peerPressure().project("name","${KEY}").by("name").by("${KEY}")`)).map(unmap);
    const byName = Object.fromEntries(rows.map((r: any) => [r.name, r[KEY]]));
    // Everyone reachable from marko converges to cluster 1 (marko's id); peter (only creates lop, no
    // in-neighbours) keeps its own id 6.
    expect(byName).toEqual({ marko: 1, vadas: 1, lop: 1, josh: 1, ripple: 1, peter: 6 });
  });
});
