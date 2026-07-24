// Compiler execution semantics (split from test/compiler.test.ts) — repeat / times / emit / bulking / path / until.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { parseRequest } from '../../src/wire.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns } from '../../src/steps/context/stream.ts';
import { pushChildScope } from '../../src/steps/tail/child.ts';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// ---------- execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.
const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('compiler execution semantics', () => {
// Decode every Path from a framed GraphBinary response (shared by the recursive tests).
async function decodePaths(store: GraphStore, gremlin: string): Promise<any[]> {
  const { ioc } = await import('../../src/io.ts');
  const buffers = executeQuery(store, gremlin, {}); // one framed Path per result value
  return buffers.map((b) => ioc.anySerializer.deserialize(b).v);
}


// props JSON is now {key:[{t,v}]} (self-describing typed nodes) — read the leaf payload.
const uNames = (store: GraphStore, q: string) => (run(store, q) as any[]).map((r) => JSON.parse(r.props).name[0].v);
test('repeat/times/emit execute (multiset + emit bands)', () => {
  const store = seededStore();
  // exactly 2 out-hops from all V → ripple, lop
  expect(run(store, 'g.V().repeat(__.out()).times(2).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
  // times before repeat is the same
  expect(run(store, 'g.V(1).times(2).repeat(__.out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
  // emit-after from marko: depth1 {vadas,josh,lop} + depth2 {ripple,lop} — lop twice (multiset)
  expect(run(store, 'g.V(1).repeat(__.out()).times(2).emit().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  // emit-before adds the seed (marko)
  expect(run(store, 'g.V(1).emit().repeat(__.out()).times(2).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
  // both() one hop from marko = 3 incident
  expect(run(store, 'g.V(1).repeat(__.both()).times(1).count()').map((r) => r.v)).toEqual([3]);
});

test('traverser bulking: repeat(...).times(n).count() == naive walk count (unroll path)', () => {
  const store = seededStore();
  // The bulked count (unrolled GROUP-BY-SUM(bulk) CTEs) must equal the exact walk
  // count the enumerate-every-walk recursion would produce. Cross-check against a
  // naive WITH RECURSIVE COUNT(*) for each depth on the modern graph.
  const naive = (t: number) =>
    store.query(
      `WITH RECURSIVE walk(id,depth) AS (SELECT id,0 FROM nodes UNION ALL ` +
      `SELECT e.tgt,walk.depth+1 FROM walk JOIN edges e ON e.src=walk.id WHERE walk.depth<${t}) ` +
      `SELECT COUNT(*) v FROM walk WHERE depth=${t}`,
    )[0].v;
  for (const t of [0, 1, 2, 3]) {
    const bulk = run(store, `g.V().repeat(__.out()).times(${t}).count()`)[0].v;
    expect(Number(bulk)).toBe(Number(naive(t)));
  }
  // times(2) out() over modern = 2 walks (marko->josh->{ripple,lop}); matches the
  // values("name") form's [lop, ripple] above.
  expect(run(store, 'g.V().repeat(__.out()).times(2).count()')[0].v).toBe(2);
  // both() bulks too (two legs merged per hop); V(1).both().times(1) = 3 incident.
  expect(run(store, 'g.V(1).repeat(__.both()).times(1).count()')[0].v).toBe(3);
  // A leading filter restricts the seed frontier (reuses buildPrefix for the source).
  expect(Number(run(store, 'g.V().hasLabel("person").repeat(__.out()).times(1).count()')[0].v))
    .toBe(Number(run(store, 'g.V().hasLabel("person").out().count()')[0].v));
});

test('unbounded emit() terminates at the fixpoint (no depth cap) — == times(2) here', () => {
  const store = seededStore();
  // out() from marko bottoms out at depth 2, so emit-only (no times) must terminate
  // there on its own. The test COMPLETING is the proof it terminates; the result must
  // match the depth-bounded form. emit-after → all iterations, not the seed.
  expect(run(store, 'g.V(1).repeat(__.out()).emit().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  // emit-before adds the seed (marko)
  expect(run(store, 'g.V(1).emit().repeat(__.out()).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
});

test('path() emits the ordered walk (one Path per distinct route)', () => {
  const store = seededStore();
  // marko(1)→josh(4)→{lop(3),ripple(5)} — two length-3 paths, in traversal order.
  const paths = run(store, 'g.V(1).out().out().path()').map((r) => [r.x0_id, r.x1_id, r.x2_id]);
  expect(paths).toEqual([[1, 4, 3], [1, 4, 5]]);
});

test('simplePath() drops repeated-vertex walks; cyclicPath() keeps only them', () => {
  const store = seededStore();
  // marko→created→lop→created→{marko,josh,peter}: the marko→lop→marko walk cycles.
  expect(run(store, 'g.V(1).out("created").in("created").simplePath().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'peter']); // marko excluded (revisits marko)
  expect(run(store, 'g.V(1).out("created").in("created").cyclicPath().values("name")').map((r) => r.v))
    .toEqual(['marko']); // only the returns-to-marko walk
});

test('path().by(key) projects each element; a missing key drops the whole path', () => {
  const store = seededStore();
  // marko(age29)→{vadas27,josh32, lop(no age)}: lop path drops (non-productive by).
  const rows = run(store, 'g.V(1).out().path().by("age")').map((r) => [r.x0_v, r.x1_v]);
  expect(rows).toEqual([[29, 27], [29, 32]]); // three out-neighbours, only two survive
});

test('path() interleaves edges and vertices with materialized props (via framing)', async () => {
  const { ioc } = await import('../../src/io.ts');
  const buffers = executeQuery(seededStore(), 'g.V(1).outE("created").inV().path()', {});
  const { v: path } = ioc.anySerializer.deserialize(Buffer.concat(buffers)); // one framed Path value
  expect(path.constructor.name).toBe('Path');
  expect(path.objects.map((o: any) => o.constructor.name)).toEqual(['Vertex', 'Edge', 'Vertex']);
  expect(path.labels).toEqual([new Set(), new Set(), new Set()]); // labels-on-path deferred
  // The reason for hand-framing: vertex props survive (client's serializer drops them).
  expect(path.objects[0].properties.map((p: any) => ({ [p.label]: p.value }))).toEqual([{ name: 'marko' }, { age: 29 }]);
});

test('repeat().times(n).path() emits the ordered walk, one Path per route', async () => {
  const paths = await decodePaths(seededStore(), 'g.V(1).repeat(__.out()).times(2).path()');
  // marko(1)→josh(4)→{lop(3),ripple(5)} — cycles allowed (no simplePath), depth-bounded.
  expect(paths.map((p) => p.objects.map((o: any) => o.id))).toEqual([[1, 4, 3], [1, 4, 5]]);
});

test('repeat(simplePath).times(3).path() = all acyclic length-4 walks (SimplePath.feature:34)', async () => {
  const paths = await decodePaths(seededStore(), 'g.V().repeat(__.both().simplePath()).times(3).path()');
  expect(paths.length).toBe(18); // the canonical count
  // every path is simple: no vertex repeats within it (the cycle guard held).
  for (const p of paths) {
    const ids = p.objects.map((o: any) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4); // seed + 3 hops
  }
});

test('simplePath() inside repeat() prunes cycles even without path() output', () => {
  const store = seededStore();
  // both() would revisit endlessly; simplePath keeps each 3-hop walk acyclic. The
  // walk carries the path array internally for the guard, then outputs plain vertices.
  const rows = run(store, 'g.V(1).repeat(__.both().simplePath()).times(2)') as any[];
  expect(rows.length).toBeGreaterThan(0);
});

test('dedup() after a recursive path() collapses equal paths (multigraph parallel edges)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const person = store.labelId('person'), knows = store.labelId('knows');
  store.query('INSERT INTO nodes(id,label) VALUES(1,?),(2,?)', [person, person]);
  store.query('INSERT INTO edges(id,src,label,tgt) VALUES(10,1,?,2),(11,1,?,2)', [knows, knows]);
  const npaths = (q: string) => new Set((run(store, q) as any[]).map((r) => r.pk)).size;
  // two parallel 1→2 edges → out() reaches 2 twice → two identical [1,2] paths.
  expect(npaths('g.V(1).repeat(__.out()).times(1).path()')).toBe(2);
  expect(npaths('g.V(1).repeat(__.out()).times(1).path().dedup()')).toBe(1); // collapsed
});

test('do-while: repeat(out()).until(pred) runs the body then tests, multiset-correct', () => {
  const store = seededStore();
  // until a property predicate: marko→josh→ripple is the only name=ripple exit.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.has("name","ripple"))')).toEqual(['ripple']);
  // until a label: marko reaches lop directly AND via josh (two paths) + ripple via josh.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.hasLabel("software"))').sort()).toEqual(['lop', 'lop', 'ripple']);
});

test('until(loops().is(n)) is equivalent to times(n)', () => {
  const store = seededStore();
  const byUntil = uNames(store, 'g.V(1).repeat(__.out()).until(__.loops().is(2))').sort();
  const byTimes = uNames(store, 'g.V(1).repeat(__.out()).times(2)').sort();
  expect(byUntil).toEqual(byTimes);
  expect(byUntil).toEqual(['lop', 'ripple']);
});

test('while-do: until(pred).repeat(t) tests the seed first (emits it un-iterated if it holds)', () => {
  const store = seededStore();
  // lop already satisfies name=lop → emitted without running the body.
  expect(uNames(store, 'g.V(3).until(__.has("name","lop")).repeat(__.out())')).toEqual(['lop']);
  // marko doesn't satisfy hasLabel(software) → iterate until it does.
  expect(uNames(store, 'g.V(1).until(__.hasLabel("software")).repeat(__.out())').sort()).toEqual(['lop', 'lop', 'ripple']);
});

test('until().path() emits the route to each satisfied traverser', async () => {
  const paths = await decodePaths(seededStore(), 'g.V(1).repeat(__.out()).until(__.has("name","ripple")).path()');
  expect(paths.map((p) => p.objects.map((o: any) => o.id))).toEqual([[1, 4, 5]]); // marko→josh→ripple
});

test('until(__.out()) stops at the first vertex having an out-edge (EXISTS correlates correctly)', () => {
  const store = seededStore();
  // marko→{vadas,josh,lop}; only josh has an out-edge → done. vadas/lop have none →
  // not done and can't expand → dropped. (Bug would self-correlate → wrong set.)
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.out())')).toEqual(['josh']);
});

test('until() has NO depth cap: reaches a target deeper than the retired 32-hop limit', () => {
  // Regression for removing the 32-hop cap: build a 40-hop linear chain and let
  // until() walk the whole way. Under the old cap this silently returned [] (the
  // target sat beyond depth 32) — a wrong answer masquerading as "no match".
  const store = new GraphStore(new BunSqlite(':memory:'));
  const person = store.labelId('person');
  const knows = store.labelId('knows');
  const node = 'INSERT INTO nodes(id, label) VALUES(?,?)';
  const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
  const edge = 'INSERT INTO edges(id, src, label, tgt) VALUES(?,?,?,?)';
  const N = 40; // deeper than the retired cap
  for (let i = 0; i <= N; i++) { store.query(node, [i + 1, person]); store.query(prop, [i + 1, 'name', `n${i}`]); }
  for (let i = 0; i < N; i++) store.query(edge, [100 + i, i + 1, knows, i + 2]); // n0→n1→…→n40
  expect(uNames(store, `g.V(1).repeat(__.out()).until(__.has("name","n${N}"))`)).toEqual([`n${N}`]);
});

// ---------- sack folded through the recursive walk ----------

test('sack(sum).by(age).where(sack.lt(59)) accumulates on the spot, guard exits (Repeat.feature:664)', () => {
  // withSack(0) then fold age twice; the guard drops a traverser once its running total
  // reaches ≥59. marko 29→58<59 survives, josh 32→64 exits after iter 1. Software vertices
  // have no age → NULL fold → dropped. TinkerPop's canonical answer: [marko, vadas].
  const store = seededStore();
  expect(uNames(store, 'g.withSack(0L).V().repeat(__.sack(sum).by("age").where(__.sack().is(lt(59)))).times(2)').sort())
    .toEqual(['marko', 'vadas']);
});

test('sack(mult).by(constant(0.5)) decays relevance per hop across a movement walk', () => {
  // spreading-activation: each hop multiplies the carried score by 0.5. 2 hops → 0.25 at
  // every reachable 2-hop endpoint. The agent-memory path-decayed-relevance primitive.
  const store = seededStore();
  const sacks = (run(store, 'g.withSack(1.0d).V(1).repeat(__.out().sack(mult).by(__.constant(0.5d))).times(2).sack()') as any[]).map((r) => r.v);
  expect(sacks.length).toBeGreaterThan(0);
  expect(sacks.every((v) => v === 0.25)).toBe(true);
});

test('sack folds independently per fork (split-only): out() fan-out keeps each walk separate', () => {
  // marko out() fans to vadas(27)/josh(32)/lop(no age). A fork clones the sack into each
  // arm; the arms never recombine (TinkerPop split-only), so each endpoint's sack is its
  // OWN age folded onto the seed, never a sum across siblings. lop has no age → NULL fold.
  const store = seededStore();
  const sacks = (run(store, 'g.withSack(0L).V(1).repeat(__.out().sack(sum).by("age")).times(1).sack()') as any[]).map((r) => r.v).sort((a, b) => (a ?? -1) - (b ?? -1));
  expect(sacks).toEqual([null, 27, 32]);
});

test('edge-step body accumulates EDGE weights along a walk (path-weight, the agent-memory primitive)', () => {
  const store = seededStore();
  // marko's out-edge weights: →vadas 0.5, →josh 1.0, →lop 0.4. 1 hop = each edge's own weight.
  expect((run(store, "g.withSack(0.0d).V(1).repeat(__.outE().sack(sum).by('weight').inV()).times(1).sack()") as any[]).map((r) => r.v).sort())
    .toEqual([0.4, 0.5, 1.0]);
  // 2 hops from marko: →josh(1.0)→ripple(1.0)=2.0 and →josh(1.0)→lop(0.4)=1.4 (only josh has out-edges).
  expect((run(store, "g.withSack(0.0d).V(1).repeat(__.outE().sack(sum).by('weight').inV()).times(2).sack()") as any[]).map((r) => r.v).sort((a, b) => a - b))
    .toEqual([1.4, 2.0]);
});

test('until(__.sack().is(P)) loops until the ACCUMULATED sack crosses a threshold', () => {
  const store = seededStore();
  // marko folds its own age (29) each iteration: 29 (<50, keep going), 58 (≥50, stop). → [58].
  // This is the spreading-activation-with-threshold primitive (loop until relevance crosses a bound).
  expect((run(store, "g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).until(__.sack().is(gte(50))).sack()") as any[]).map((r) => r.v))
    .toEqual([58]);
});

test('emit(__.sack().is(P)) emits the iterations whose accumulated sack matches', () => {
  const store = seededStore();
  // fold age 29 up to 3× → 29, 58, 87; emit those ≥40 → [58, 87].
  expect((run(store, "g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).times(3).emit(__.sack().is(gte(40))).sack()") as any[]).map((r) => r.v).sort((a, b) => a - b))
    .toEqual([58, 87]);
});

test('a body aggregate() collects every vertex the walk visits (the :TOUCHED provenance primitive)', () => {
  const store = seededStore();
  // marko out → {vadas,josh,lop} (depth 1); josh out → {ripple,lop} (depth 2). The bag is a
  // BulkSet multiset, so lop appears twice. cap('x').unfold() explodes it to elements.
  const names = (run(store, "g.V(1).repeat(__.out().aggregate('x')).times(2).cap('x').unfold().values('name')") as any[]).map((r) => r.v).sort();
  expect(names).toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
});

test('a pre-repeat aggregate multiset-unions with the in-repeat body aggregate (Aggregate.feature:627)', () => {
  const store = seededStore();
  // V().local(aggregate('a')) collects all 6 vertices; then repeat(out().local(aggregate('a'))).times(2)
  // appends the walk's depth-1 and depth-2 rows. groupCount by name over the whole BulkSet.
  // (Asserted on the raw gk/gv rows — a separate pre-existing groupCount scalar-FRAMING bug
  // returns {} at the wire for values(k).groupCount(); the DATA the aggregate produces is correct.)
  const rows = run(store, `g.V().local(__.aggregate('a')).repeat(__.out().local(__.aggregate('a'))).times(2).cap('a').unfold().values('name').groupCount()`);
  const counts = Object.fromEntries(rows.map((r: any) => [r.gk, Number(r.gv)]));
  expect(counts).toEqual({ marko: 1, vadas: 2, josh: 2, lop: 5, ripple: 3, peter: 1 });
});

test('a movement-free repeat(aggregate(a)) revisits the seed each iteration', () => {
  const store = seededStore();
  // no movement → each of the 6 vertices stays put and is collected once per iteration; times(2) → 12.
  const names = (run(store, "g.V().repeat(__.aggregate('a')).times(2).cap('a').unfold().values('name')") as any[]).map((r) => r.v).sort();
  expect(names.length).toBe(12);
  expect(names.filter((n) => n === 'marko')).toEqual(['marko', 'marko']);
});
});
