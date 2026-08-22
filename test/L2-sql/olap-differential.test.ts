import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { connectedComponents, pageRankScores, peerPressureClusters } from '../../src/services/catalog/graph-algorithms.ts';

// The OLAP computes execute as substrate-A-iterated SQL (one relaxation per round, the vector crossing
// as a json_each bind — docs/2026-08-21-barrier-substrate-design.md). The pure-JS functions here are the
// differential ORACLES: this asserts the SQL rounds agree with them over the WHOLE vertex vector (not
// just the conformance-asserted subset), so the SQL rewrite cannot silently drift from the algorithm.

const store = () => seeded(MODERN_SEED);
const nodesOf = (s: ReturnType<typeof store>) => s.query<{ id: number; ext: string | number }>('SELECT id, COALESCE(uid, id) AS ext FROM nodes');
const outE = (s: ReturnType<typeof store>) => s.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges');
const bothE = (s: ReturnType<typeof store>) => outE(s).flatMap((e) => [{ src: e.src, tgt: e.tgt }, { src: e.tgt, tgt: e.src }]);

/** id → decorated value, via the SQL execution path (project id + the algorithm's key). */
async function decorated(s: ReturnType<typeof store>, step: string, key: string): Promise<Map<number, unknown>> {
  const rows = await Promise.all((await exec(s).framedAsync(`g.V().${step}.project("id","v").by(id).by("${key}")`, {})).map((f) => decode(f.buf)));
  return new Map(rows.map((m: any) => [Number(m.get('id')), m.get('v')]));
}

describe('OLAP SQL-per-round ≡ JS oracle (whole-vector differential)', () => {
  test('connectedComponent', async () => {
    const s = store();
    const oracle = new Map(connectedComponents(nodesOf(s), bothE(s)).map((t) => [t.id, String(t.value)]));
    const sql = await decorated(s, 'connectedComponent()', 'gremlin.connectedComponentVertexProgram.component');
    expect(new Map([...sql].map(([k, v]) => [k, String(v)]))).toEqual(oracle);
  });

  test('pageRank (scores agree to 1e-9)', async () => {
    const s = store();
    const oracle = new Map(pageRankScores(nodesOf(s).map((n) => ({ id: n.id })), outE(s), 0.85).map((t) => [t.id, t.value as number]));
    const sql = await decorated(s, 'pageRank()', 'gremlin.pageRankVertexProgram.pageRank');
    for (const [id, v] of sql) expect(Math.abs((v as number) - oracle.get(id)!)).toBeLessThan(1e-9);
    expect(sql.size).toBe(oracle.size);
  });

  test('peerPressure', async () => {
    const s = store();
    const oracle = new Map(peerPressureClusters(nodesOf(s), outE(s)).map((t) => [t.id, t.value]));
    const sql = await decorated(s, 'peerPressure()', 'gremlin.peerPressureVertexProgram.cluster');
    expect(sql).toEqual(oracle);
  });
});
