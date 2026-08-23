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

// The OLAP vector is SQL-RESIDENT (`barrier_relation`, keyed by a per-query run token). Two invariants
// follow: the scratch is reclaimed once the tail is framed (precise post-frame GC), and concurrent
// queries in one store never collide because each holds its own run token across the apply→resume await.
describe('OLAP barrier scratch — SQL-resident vector', () => {
  const scratch = (s: ReturnType<typeof store>) => s.query<{ c: number }>('SELECT COUNT(*) AS c FROM barrier_relation')[0].c;

  test('scratch is empty after a decorate query is framed (precise GC)', async () => {
    const s = store();
    expect(scratch(s)).toBe(0);
    await decorated(s, 'pageRank()', 'gremlin.pageRankVertexProgram.pageRank');
    expect(scratch(s)).toBe(0);
    await decorated(s, 'connectedComponent()', 'gremlin.connectedComponentVertexProgram.component');
    expect(scratch(s)).toBe(0);
    // A seed-from-input prefix (non-bare) takes the other seed path — still reclaimed.
    await new Map((await Promise.all((await exec(s).framedAsync(
      'g.V().has("name","marko").out().pageRank().project("id","v").by(id).by("gremlin.pageRankVertexProgram.pageRank")', {}))
      .map((f) => decode(f.buf)))).map((m: any) => [Number(m.get('id')), m.get('v')]));
    expect(scratch(s)).toBe(0);
  });

  test('concurrent decorate queries stay isolated (per-run token)', async () => {
    const s = store();
    // Both computed against the SAME store, interleaving at the apply→resume await — each must see only
    // its own run's rows. Run in parallel and check both agree with their oracle.
    const prOracle = new Map(pageRankScores(nodesOf(s).map((n) => ({ id: n.id })), outE(s), 0.85).map((t) => [t.id, t.value as number]));
    const ccOracle = new Map(connectedComponents(nodesOf(s), bothE(s)).map((t) => [t.id, String(t.value)]));
    const [pr, cc] = await Promise.all([
      decorated(s, 'pageRank()', 'gremlin.pageRankVertexProgram.pageRank'),
      decorated(s, 'connectedComponent()', 'gremlin.connectedComponentVertexProgram.component'),
    ]);
    for (const [id, v] of pr) expect(Math.abs((v as number) - prOracle.get(id)!)).toBeLessThan(1e-9);
    expect(new Map([...cc].map(([k, v]) => [k, String(v)]))).toEqual(ccOracle);
    expect(scratch(s)).toBe(0);
  });
});
