import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
// The OLAP computes execute as SQL-resident relaxations (one INSERT..SELECT per round over
// `barrier_state`; docs/archive/2026-08-23-barrier-substrate-reshape-plan.md). The pure-JS functions BELOW are
// the differential ORACLES: this asserts the SQL rounds agree with them over the WHOLE vertex vector
// (not just the conformance-asserted subset), so the SQL rewrite cannot silently drift from the
// algorithm. They are TEST-ONLY (independent re-derivations of the reference), so they live here with
// their only consumer rather than in `src/` — the execution path in `src/services/catalog/olap/` is the
// SQL, and a JS reference in production source would read as a second, unused implementation.

type IdValue = { readonly id: number; readonly value: unknown };

/** Weakly-connected components by union-find over the (undirected) edge list, labelling each component
 *  with the lexicographically-smallest external-id string among its members (the reference's exact
 *  `id().toString()`/string-`compareTo` rule) — the oracle for wcc's SQL rounds. */
function connectedComponents(
  nodes: readonly { readonly id: number; readonly ext: string | number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
): readonly IdValue[] {
  const parent = new Map<number, number>();
  for (const n of nodes) parent.set(n.id, n.id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.src) || !parent.has(e.tgt)) continue;
    parent.set(find(e.src), find(e.tgt));
  }
  const label = new Map<number, string>();
  for (const n of nodes) {
    const root = find(n.id);
    const s = String(n.ext);
    const cur = label.get(root);
    if (cur === undefined || s < cur) label.set(root, s);
  }
  return nodes.map((n) => ({ id: n.id, value: label.get(find(n.id))! }));
}

/** PageRank (α damping, teleport redistribution of dangling rank) — the oracle for pageRank. A
 *  faithful re-derivation of PageRankVertexProgram, so a modern-graph sink ranks correctly. */
function pageRankScores(
  nodes: readonly { readonly id: number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
  alpha: number,
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return [];
  const out = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.src)?.push(e.tgt);
  const outdeg = new Map<number, number>(ids.map((id) => [id, out.get(id)!.length]));
  const pr = new Map<number, number>(ids.map((id) => [id, 0]));
  let messages = new Map<number, number>(ids.map((id) => [id, 0]));
  let teleport = 1.0;
  const EPSILON = 0.00001;
  for (let k = 1; k <= 20; k++) {
    const teleportK = teleport;
    const localTerminal = teleportK > 0 ? teleportK / N : 0;
    const nextMessages = new Map<number, number>(ids.map((id) => [id, 0]));
    let nextTeleport = 0;
    let convergence = 0;
    for (const id of ids) {
      const rank = (k === 1 ? 0 : messages.get(id)!) + (teleportK > 0 ? localTerminal : 0);
      convergence += Math.abs(rank - pr.get(id)!);
      pr.set(id, rank);
      nextTeleport += (1 - alpha) * rank;
      const send = alpha * rank;
      const od = outdeg.get(id)!;
      if (od > 0) { const share = send / od; for (const t of out.get(id)!) nextMessages.set(t, nextMessages.get(t)! + share); }
      else nextTeleport += send;
    }
    teleport = nextTeleport;
    messages = nextMessages;
    if (convergence < EPSILON) break;
  }
  return ids.map((id) => ({ id, value: pr.get(id)! }));
}

/** Weighted PageRank (GDS `relationshipWeightProperty`) — the oracle for the weighted SQL. Each edge
 *  u→v carries a weight; u sends α·pr[u]·w(u,v) / Σ_x w(u,x). A vertex whose total out-weight is 0 (no
 *  out-edges, or all-zero weights) is dangling (its α·rank teleports) — matching the SQL's
 *  `HAVING SUM(w) > 0`. */
function weightedPageRankScores(
  nodes: readonly { readonly id: number }[],
  edges: readonly { readonly src: number; readonly tgt: number; readonly w: number }[],
  alpha: number,
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return [];
  const out = new Map<number, { tgt: number; w: number }[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.src)?.push({ tgt: e.tgt, w: e.w });
  const wod = new Map<number, number>(ids.map((id) => [id, out.get(id)!.reduce((s, e) => s + e.w, 0)]));
  const pr = new Map<number, number>(ids.map((id) => [id, 0]));
  let messages = new Map<number, number>(ids.map((id) => [id, 0]));
  let teleport = 1.0;
  const EPSILON = 0.00001;
  for (let k = 1; k <= 20; k++) {
    const localTerminal = teleport > 0 ? teleport / N : 0;
    const nextMessages = new Map<number, number>(ids.map((id) => [id, 0]));
    let nextTeleport = 0;
    let convergence = 0;
    for (const id of ids) {
      const rank = (k === 1 ? 0 : messages.get(id)!) + localTerminal;
      convergence += Math.abs(rank - pr.get(id)!);
      pr.set(id, rank);
      nextTeleport += (1 - alpha) * rank;
      const send = alpha * rank;
      const total = wod.get(id)!;
      if (total > 0) for (const e of out.get(id)!) nextMessages.set(e.tgt, nextMessages.get(e.tgt)! + send * e.w / total);
      else nextTeleport += send;
    }
    teleport = nextTeleport;
    messages = nextMessages;
    if (convergence < EPSILON) break;
  }
  return ids.map((id) => ({ id, value: pr.get(id)! }));
}

/** Weighted ArticleRank (GDS delta-accumulation) — the oracle for the weighted SQL. init rank = delta =
 *  α (=1−damping); each round delta[v] = damping·Σ_{u→v, prevDelta[u]>tol, Σw[u]>0} prevDelta[u]·w(u,v) /
 *  (Σw[u] + avgWeightedDegree), rank[v] += delta[v]; avgWeightedDegree = Σw_all/N. Fixed maxIterations−1
 *  rounds (`ArticleRankComputation.java` + weighted `DegreeFunctions`/`applyRelationshipWeight`). */
function weightedArticleRankScores(
  nodes: readonly { readonly id: number }[],
  edges: readonly { readonly src: number; readonly tgt: number; readonly w: number }[],
  damping: number,
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  if (N === 0) return [];
  const alpha = 1 - damping;
  const TOL = 1e-7;
  const MAX_ITER = 20;
  const out = new Map<number, { tgt: number; w: number }[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.src)?.push({ tgt: e.tgt, w: e.w });
  const wdeg = new Map<number, number>(ids.map((id) => [id, out.get(id)!.reduce((s, e) => s + e.w, 0)]));
  const avgDeg = edges.reduce((s, e) => s + e.w, 0) / N;
  const rank = new Map<number, number>(ids.map((id) => [id, alpha]));
  let delta = new Map<number, number>(ids.map((id) => [id, alpha]));
  for (let r = 1; r < MAX_ITER; r++) {
    const acc = new Map<number, number>(ids.map((id) => [id, 0]));
    for (const id of ids) {
      const d = delta.get(id)!;
      const deg = wdeg.get(id)!;
      if (d > TOL && deg > 0) for (const e of out.get(id)!) acc.set(e.tgt, acc.get(e.tgt)! + d * e.w / (deg + avgDeg));
    }
    const next = new Map<number, number>();
    for (const id of ids) { const nd = damping * acc.get(id)!; next.set(id, nd); rank.set(id, rank.get(id)! + nd); }
    delta = next;
  }
  return ids.map((id) => ({ id, value: rank.get(id)! }));
}

/** Peer-pressure clustering: each vertex adopts the max-vote cluster among {itself} ∪ {voters}, ties to
 *  the smallest id string, to a fixpoint — the oracle for peerPressure. */
function peerPressureClusters(
  nodes: readonly { readonly id: number; readonly ext: string | number }[],
  edges: readonly { readonly src: number; readonly tgt: number }[],
): readonly IdValue[] {
  const ids = nodes.map((n) => n.id);
  const ext = new Map<number, string | number>(nodes.map((n) => [n.id, n.ext]));
  const voters = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of edges) voters.get(e.tgt)?.push(e.src);
  let cluster = new Map<number, string | number>(ids.map((id) => [id, ext.get(id)!]));
  for (let round = 0; round < 30; round++) {
    const next = new Map<number, string | number>();
    let changed = false;
    for (const id of ids) {
      const votes = new Map<string | number, number>();
      votes.set(cluster.get(id)!, 1);
      for (const u of voters.get(id)!) {
        const c = cluster.get(u)!;
        votes.set(c, (votes.get(c) ?? 0) + 1);
      }
      let best: string | number = cluster.get(id)!;
      let bestVote = -1;
      for (const [c, v] of votes) {
        if (v > bestVote || (v === bestVote && String(c) < String(best))) { best = c; bestVote = v; }
      }
      next.set(id, best);
      if (best !== cluster.get(id)) changed = true;
    }
    cluster = next;
    if (!changed) break;
  }
  return ids.map((id) => ({ id, value: cluster.get(id)! }));
}

const store = () => seeded(MODERN_SEED);
const nodesOf = (s: ReturnType<typeof store>) => s.query<{ id: number; ext: string | number }>('SELECT id, COALESCE(uid, id) AS ext FROM nodes');
const outE = (s: ReturnType<typeof store>) => s.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges');
const weightedOutE = (s: ReturnType<typeof store>) => s.query<{ src: number; tgt: number; w: number }>(
  "SELECT src, tgt, COALESCE((SELECT value FROM edge_properties WHERE edge = edges.id AND key = 'weight'), 0) AS w FROM edges");
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

  test('connectedComponent weighted threshold — union only above the cutoff (≡ oracle)', async () => {
    const s = store();
    // threshold 0.5 keeps only the two weight-1.0 edges (marko→josh, josh→ripple), splitting the graph:
    // {marko,josh,ripple} vs isolated vadas / lop / peter. Oracle = the same union-find over the filtered
    // (undirected) edge set, labelled by the min external-id string.
    const kept = weightedOutE(s).filter((e) => e.w > 0.5).flatMap((e) => [{ src: e.src, tgt: e.tgt }, { src: e.tgt, tgt: e.src }]);
    const oracle = new Map(connectedComponents(nodesOf(s), kept).map((t) => [t.id, String(t.value)]));
    const sql = await decorated(s, 'connectedComponent().with("relationshipWeightProperty","weight").with("threshold",0.5)', 'gremlin.connectedComponentVertexProgram.component');
    expect(new Map([...sql].map(([k, v]) => [k, String(v)]))).toEqual(oracle);
    expect(new Set(oracle.values()).size).toBeGreaterThan(1); // genuinely split (guards against a no-op filter)
  });

  test('pageRank (scores agree to 1e-9)', async () => {
    const s = store();
    const oracle = new Map(pageRankScores(nodesOf(s).map((n) => ({ id: n.id })), outE(s), 0.85).map((t) => [t.id, t.value as number]));
    const sql = await decorated(s, 'pageRank()', 'gremlin.pageRankVertexProgram.pageRank');
    for (const [id, v] of sql) expect(Math.abs((v as number) - oracle.get(id)!)).toBeLessThan(1e-9);
    expect(sql.size).toBe(oracle.size);
  });

  test('pageRank weighted (relationshipWeightProperty) — scores agree to 1e-9', async () => {
    const s = store();
    const oracle = new Map(weightedPageRankScores(nodesOf(s).map((n) => ({ id: n.id })), weightedOutE(s), 0.85).map((t) => [t.id, t.value as number]));
    const sql = await decorated(s, 'pageRank().with("relationshipWeightProperty","weight")', 'gremlin.pageRankVertexProgram.pageRank');
    for (const [id, v] of sql) expect(Math.abs((v as number) - oracle.get(id)!)).toBeLessThan(1e-9);
    expect(sql.size).toBe(oracle.size);
  });

  test('articleRank weighted (relationshipWeightProperty) — scores agree to 1e-9', async () => {
    const s = store();
    const oracle = new Map(weightedArticleRankScores(nodesOf(s).map((n) => ({ id: n.id })), weightedOutE(s), 0.85).map((t) => [t.id, t.value as number]));
    const sql = await decorated(s, 'call("articleRank").with("relationshipWeightProperty","weight")', 'articleRank');
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

// The OLAP vector is SQL-RESIDENT (`barrier_state`, keyed by a per-query run token). Two invariants
// follow: the scratch is reclaimed once the tail is framed (precise post-frame GC), and concurrent
// queries in one store never collide because each holds its own run token across the apply→resume await.
describe('OLAP barrier scratch — SQL-resident vector', () => {
  const scratch = (s: ReturnType<typeof store>) => s.query<{ c: number }>('SELECT COUNT(*) AS c FROM barrier_state')[0].c;

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
