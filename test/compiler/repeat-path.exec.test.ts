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
import { assertStreamColumns } from '../../src/compiler/steps/context/stream.ts';
import { pushChildScope } from '../../src/compiler/steps/tail/child.ts';
import { decode, decodeAll } from '../support/decode.ts';

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
  return decodeAll(buffers);
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

test('a label bound before repeat() rides the walk (loop-invariant carried column)', () => {
  const store = seededStore();
  const names = (q: string) => (run(store, q) as any[]).map((r) => r.v).sort();
  // The walk MOVES the traverser; it never rebinds an existing label, so an incoming alias column
  // is loop-invariant — seeded from the outer row, passed through each iteration untouched. Any
  // as() before repeat() used to defer the whole traversal, read or not.
  expect(names('g.V(1).as("a").repeat(__.out()).times(2).select("a").values("name")'))
    .toEqual(['marko', 'marko']); // two 2-hop walks from marko, each re-rooted back to marko

  // times(n) over a single-movement body IS the linear n-hop chain, so the carried label must
  // come out elementwise identical to the linear form — the sharpest available oracle.
  for (const [walk, linear] of [
    ['g.V().as("a").repeat(__.both()).times(1).select("a").values("name")', 'g.V().as("a").both().select("a").values("name")'],
    ['g.V().as("a").repeat(__.out()).times(1).select("a").values("name")', 'g.V().as("a").out().select("a").values("name")'],
    ['g.V().as("a").repeat(__.out()).times(2).select("a").values("name")', 'g.V().as("a").out().out().select("a").values("name")'],
    ['g.V().as("a").repeat(__.out()).times(2).values("name")', 'g.V().as("a").out().out().values("name")'],
  ]) expect(names(walk)).toEqual(names(linear));

  // The label must not disturb what the walk itself produces, at any exit modulator…
  expect(names('g.V(1).as("a").repeat(__.out()).times(2).values("name")')).toEqual(['lop', 'ripple']);
  expect(run(store, 'g.V(1).as("a").repeat(__.out()).emit().times(2).count()').map((r: any) => r.v)).toEqual([5]);
  // …nor the OTHER carried columns it rides beside — path (a separate array column, ordered
  // after the aliases in layoutCols) and simplePath's cycle guard both still work.
  expect(names('g.V(1).as("a").repeat(__.out()).times(2).path().by("name")').flat().length).toBe(6);
  expect(run(store, 'g.V(1).as("a").repeat(__.out().simplePath()).times(2).count()').map((r: any) => r.v)).toEqual([2]);

  // A label bound INSIDE the body is the genuinely recursive question (it rebinds per iteration),
  // not this one — as() is absent from the repeat body vocabulary, so it still fails closed.
  expect(() => run(store, 'g.V(1).repeat(__.out().as("b")).times(2).select("b")'))
    .toThrow(/not yet supported/);
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

test('the SAME path().by() answers identically in both regimes (one position projector)', () => {
  // The two regimes had two hand-rolled projectors and the grouped one hardcoded a property
  // read, so by(T.id)/by(T.label) worked on a LINEAR path and threw on a RECURSIVE one — the
  // same modulator, two answers. Both now go through one projector, parameterized by how the
  // element is reached (joined table vs correlated read off the exploded id).
  const store = seededStore();
  const linear = (g: string) => run(store, g).map((r) => [r.x0_v, r.x1_v, r.x2_v]);
  const grouped = (g: string) => run(store, g).map((r) => r.v);
  // marko's 2-hop walks are [marko,josh,lop] and [marko,josh,ripple].
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(T.id)')).toEqual([1, 4, 3, 1, 4, 5]);
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(T.label)'))
    .toEqual(['person', 'person', 'software', 'person', 'person', 'software']);
  // by(key) unchanged in the grouped regime…
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by("name")'))
    .toEqual(['marko', 'josh', 'lop', 'marko', 'josh', 'ripple']);
  // …and the LINEAR regime is byte-for-byte unaffected, including an EDGE position (which
  // reads its label/id off the joined edges table, not nodes).
  expect(linear('g.V(1).out().path().by(T.id)')).toEqual([[1, 2, undefined], [1, 4, undefined], [1, 3, undefined]]);
  expect(linear('g.V(1).outE("created").inV().path().by(T.label)')).toEqual([['person', 'created', 'software']]);
});

test('path().by(traversal) works on a RECURSIVE path, via the SAME positional child', () => {
  // The explode is (id, pk, ord) but an ElementStream's schema is ['id', ...layoutCols], so
  // pk/ord ride as `origins` — which is what that slot means, and for a path element the answer
  // literally is "path pk, position ord". That makes the exploded rows an ordinary element
  // stream, so `lowerPathPositionChild` (fan-out guards, branch route, `first` collapse) is
  // reused UNCHANGED rather than reimplemented for this regime.
  const store = seededStore();
  const grouped = (g: string) => run(store, g).map((r) => r.v);
  // marko's 2-hop walks: [marko,josh,lop] and [marko,josh,ripple].
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.values("name"))'))
    .toEqual(['marko', 'josh', 'lop', 'marko', 'josh', 'ripple']);
  // by(key) and by(traversal) must agree — same modulator meaning, two routes.
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.values("name"))'))
    .toEqual(grouped('g.V(1).repeat(__.out()).times(2).path().by("name")'));
  // A REAL child traversal per position, not just a property read. Out-degrees along the walk:
  // marko 3, josh 2, lop/ripple 0. In-degrees: marko 0, josh 1, lop 3, ripple 1.
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.out().count())')).toEqual([3, 2, 0, 3, 2, 0]);
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.in().count())')).toEqual([0, 1, 3, 0, 1, 1]);
  // …and the LINEAR regime gives the same answer for the same walk, which is the cross-regime
  // equivalence the two hand-rolled projectors could not offer.
  expect(run(store, 'g.V(1).out().out().path().by(__.out().count())').map((r: any) => [r.x0_v, r.x1_v, r.x2_v]))
    .toEqual([[3, 2, 0], [3, 2, 0]]);
});

test('a recursive path().by(traversal) honours productive-by and the shared fan-out guard', () => {
  const store = seededStore();
  const grouped = (g: string) => run(store, g).map((r) => r.v);
  // NON-PRODUCTIVE: lop and ripple have no age, so BOTH whole paths drop. The by(key) form
  // applies that rule with a pre-numbering NOT EXISTS and by(traversal) group-wise after the
  // child join — different pipeline points, same answer, which is the thing worth pinning.
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.values("age"))')).toEqual([]);
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by("age")')).toEqual([]);
  // A walk where every element HAS the property drops nothing, both forms.
  expect(grouped('g.V(1).repeat(__.out("knows")).times(1).path().by(__.values("age"))')).toEqual([29, 27, 29, 32]);
  expect(grouped('g.V(1).repeat(__.out("knows")).times(1).path().by("age")')).toEqual([29, 27, 29, 32]);
  // ProductiveBy keeps the path with an explicit NULL position instead.
  expect(grouped('g.withStrategies(ProductiveByStrategy).V(1).repeat(__.out()).times(2).path().by(__.values("age"))'))
    .toEqual([29, 32, null, 29, 32, null]);
  // The BRANCH route through the shared child compiler (no first-collapse, so non-fan-out arms).
  expect(grouped('g.V(1).repeat(__.out()).times(2).path().by(__.coalesce(__.values("age"),__.constant(-1)))'))
    .toEqual([29, 32, -1, 29, 32, -1]);
  // The shared fan-out guard still fires — a position holds ONE value, so union() is rejected
  // rather than silently multiplying whole path rows through the ordinal join.
  expect(() => run(store, 'g.V(1).repeat(__.out()).times(2).path().by(__.union(__.values("name"),__.values("name")))'))
    .toThrow(/fans out/);
  // Multiple by()s over a DYNAMIC length remains a real wall (round-robin needs a known length).
  expect(() => run(store, 'g.V(1).repeat(__.out()).times(2).path().by("name").by("age")'))
    .toThrow(/multiple modulators/);
});

test('path() interleaves edges and vertices with materialized props (via framing)', async () => {
  const { ioc } = await import('../../src/io.ts');
  const buffers = executeQuery(seededStore(), 'g.V(1).outE("created").inV().path()', {});
  const path = await decode(Buffer.concat(buffers)); // one framed Path value
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
  // appends the walk's depth-1 and depth-2 rows. groupCount by name over the whole BulkSet — asserted
  // on the raw gk/gv rows (the wire-framed Map is verified equivalent by the L3 conformance run).
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

// ---------- the GENERIC repeat body relation (branch.ts repeatBodyRelation) ----------
//
// `expandRepeatBody` is a private movement/filter mini-compiler and therefore a vocabulary wall.
// The generic route compiles the body ONCE through the ordinary StepFns as a (from_id, to_id)
// relation the recursive term joins — legal because a recursive term may reference a NON-recursive
// CTE, which is the way around SQLite having no LATERAL (a derived table in the recursive term's
// FROM cannot reference the walk row, so the correlated-child rendering cannot fan out there).
describe('repeat() body: the generic body relation', () => {
  const names = (store: GraphStore, g: string) => (run(store, g) as any[]).map((r) => r.v).sort();

  test('bodies the FLAT expansion accepts are unchanged (it stays the fast path)', () => {
    const store = seededStore();
    expect(names(store, 'g.V(1).repeat(__.out()).times(2).values("name")')).toEqual(['lop', 'ripple']);
    expect(names(store, 'g.V(1).repeat(__.out("knows")).times(1).values("name")')).toEqual(['josh', 'vadas']);
    expect(names(store, 'g.V().repeat(__.out().has("name","lop")).times(1).values("name")')).toEqual(['lop', 'lop', 'lop']);
    expect((run(store, 'g.V(1).repeat(__.both()).times(2).count()') as any[])[0].v).toBe(7);
  });

  test('the whole row-local filter vocabulary now composes in a body', () => {
    // Each of these was a `repeat(__.…) not yet supported` vocabulary throw: the flat expander
    // knows only movement + has(). None of them needed new SQL — they are the ordinary StepFns.
    const store = seededStore();
    expect(names(store, 'g.V(1).repeat(__.out().hasLabel("person")).times(1).values("name")')).toEqual(['josh', 'vadas']);
    expect(names(store, 'g.V(1).repeat(__.out().hasId(3)).times(1).values("name")')).toEqual(['lop']);
    expect(names(store, 'g.V(1).repeat(__.out().where(__.has("name","lop"))).times(1).values("name")')).toEqual(['lop']);
    expect(names(store, 'g.V(1).repeat(__.out().not(__.has("name","lop"))).times(1).values("name")')).toEqual(['josh', 'vadas']);
    expect(names(store, 'g.V(1).repeat(__.out().and(__.has("name","lop"),__.in())).times(1).values("name")')).toEqual(['lop']);
    // A uniform-element BRANCH body — union/coalesce arms are element-shaped, so the branch folds
    // through the element prefix exactly as a movement does.
    expect(names(store, 'g.V(1).repeat(__.coalesce(__.out("knows"),__.out("created"))).times(1).values("name")')).toEqual(['josh', 'vadas']);
    expect((run(store, 'g.V(1).repeat(__.union(__.out(),__.in())).times(1).count()') as any[])[0].v).toBe(3);
  });

  test('an exploded-edge body composes: bothE().otherV() ≡ both()', () => {
    // otherV() was the one movement missing from ELEMENT_CHILD_STEPS (the row-local vocabulary),
    // which gated it in EVERY child position, not just repeat — the emit side was already ready.
    const store = seededStore();
    expect(names(store, 'g.V(1).repeat(__.bothE().otherV()).times(1).values("name")'))
      .toEqual(names(store, 'g.V(1).both().values("name")'));
    expect(names(store, 'g.V(1).local(__.bothE().otherV()).values("name")')).toEqual(['josh', 'lop', 'vadas']);
    expect((run(store, 'g.V(1).map(__.bothE().otherV().count())') as any[])[0].v).toBe(3);
    expect(names(store, 'g.V(1).repeat(__.bothE().otherV().has("age",P.lt(30))).times(1).values("name")')).toEqual(['vadas']);
  });

  test('traversers stay a MULTISET through the body relation', () => {
    // The relation must NOT be built with DISTINCT: two parallel edges are two traversers. josh
    // reaches lop and ripple, and marko/josh/peter all reach lop, so a one-hop walk from every
    // vertex keeps lop three times.
    const store = seededStore();
    expect(names(store, 'g.V().repeat(__.out().hasLabel("software")).times(1).values("name")'))
      .toEqual(['lop', 'lop', 'lop', 'ripple']);
  });

  test('a PER-ITERATION GLOBAL barrier still fails closed, naming why', () => {
    // Not a missing feature — a semantic wall. A global dedup()/limit() observes the whole frontier
    // at one iteration; precomputing it per-origin answers a different question. The generic
    // StepFns would happily lower it (bare dedup emits SELECT DISTINCT id, <carried>, and with an
    // origin column in the tuple that silently becomes PER-ORIGIN), so the gate is the row-local
    // vocabulary, not "whatever lowerElementSteps accepts". This test is that guard.
    const store = seededStore();
    for (const [g, step] of [
      ['g.V(1).repeat(__.out().dedup()).times(2).count()', 'dedup'],
      ['g.V(1).repeat(__.out().limit(1)).times(2).count()', 'limit'],
      ['g.V(1).repeat(__.out().order().by("name")).times(2).count()', 'order'],
      ['g.V(1).repeat(__.out().aggregate("x").out()).times(2).count()', 'aggregate'],
    ] as [string, string][]) {
      expect(() => run(store, g)).toThrow(new RegExp(`${step}\\(\\) is a per-iteration GLOBAL barrier`));
    }
  });

  test('a body MENTIONING a label fails closed instead of silently answering []', () => {
    // The keyed relation's domain is every vertex, not the caller's rows, so there is no outer row
    // to read an alias column FROM. An absent alias column is indistinguishable from a never-bound
    // label, which select() answers as "drop every traverser" — so without this guard the body
    // compiled and returned NOTHING. Measured before the fix: 0 rows here vs 6 for the same body
    // outside repeat(). That asymmetry is the bug; declining is the fix.
    const store = seededStore();
    expect((run(store, 'g.V().as("a").out().where(__.select("a"))') as any[]).length).toBe(6);
    expect(() => run(store, 'g.V().as("a").repeat(__.out().where(__.select("a"))).times(1)'))
      .toThrow(/not yet supported/);
    expect(() => run(store, 'g.V().as("a").repeat(__.select("a").out()).times(2)'))
      .toThrow(/not yet supported/);
  });

  test('sack and path bodies stay with the flat expansion', () => {
    const store = seededStore();
    // A sack fold is per-iteration (the accumulator depends on the running value), so it keeps the
    // flat route and keeps working; the generic relation is never consulted for it.
    // marko's out() is vadas + josh (knows) + lop (created) = 3 traversers.
    expect((run(store, 'g.withSack(0).V(1).repeat(__.out().sack(Operator.sum).by("age")).times(1).sack()') as any[]).length).toBe(3);
    // simplePath() in the body needs the walk's accumulated path array, so likewise.
    expect(names(store, 'g.V(1).repeat(__.both().simplePath()).times(2).values("name")').length).toBeGreaterThan(0);
  });
});

// ---------- until()/emit(): the SECOND consumer of the keyed child relation ----------
//
// walkPredicate used to have no generic fallback: a predicate the inline compiler declined THREW,
// which made the inline leaf vocabulary a hard ceiling here and nowhere else. The keyed relation
// discharges it — an element-only predicate compiles ONCE over every vertex and the recursive term
// reads `id IN <origins that produced a row>`, which is until()/emit()'s existence semantics.
// Inline is still tried FIRST: it alone reaches the walk's per-iteration state (loops(), the sack).
describe('until()/emit(): the keyed-relation fallback', () => {
  const ids = (store: GraphStore, g: string) => (run(store, g) as any[]).map((r) => r.id).sort();

  test('a predicate beyond inline lowering now compiles, and AGREES with the inline form', () => {
    // Each pair is one predicate written two ways: the left routes through the inline compiler,
    // the right declines it and takes the keyed relation. Same predicate ⇒ same answer, so this
    // pins the fallback against the route that was already correct rather than against a constant.
    const store = seededStore();
    for (const [inline, keyed] of [
      ['g.V().until(__.both()).repeat(__.out())',
       'g.V().until(__.union(__.out(),__.in())).repeat(__.out())'],
      ['g.V().until(__.both("created")).repeat(__.out())',
       'g.V().until(__.union(__.out("created"),__.in("created"))).repeat(__.out())'],
      // emit() shares walkPredicate — the only difference is which column the boolean drives.
      // This pair also pins the MULTISET (a vertex emitted twice stays twice).
      ['g.V().emit(__.both("knows")).repeat(__.out()).times(2)',
       'g.V().emit(__.union(__.out("knows"),__.in("knows"))).repeat(__.out()).times(2)'],
    ] as [string, string][]) {
      expect(ids(store, keyed)).toEqual(ids(store, inline));
    }
  });

  test('a PER-ITERATION predicate keeps the inline route and still fails closed beyond it', () => {
    const store = seededStore();
    // loops()/sack() read state that does not exist per-vertex, so they are outside the row-local
    // vocabulary and keyedChildRelation declines them on its own — no separate guard needed.
    // These work because INLINE serves them; the keyed route is never consulted.
    expect(ids(store, 'g.V(1).until(__.loops().is(2)).repeat(__.out())').length).toBeGreaterThan(0);
    // Beyond BOTH routes: a per-iteration body the inline compiler also declines. The deferral must
    // name why rather than reciting a vocabulary.
    expect(() => run(store, 'g.V(1).until(__.out().order().by("name").limit(1)).repeat(__.out())'))
      .toThrow(/not yet supported/);
  });
});

// ---------- repeat() AT DEPTH: origin columns through the walk ----------
//
// The other half of repeat()'s wall. The walk was excluded from ELEMENT_CHILD_STEPS because it
// dropped the parent ordinal its consumer joins on; threading `origins` through the recursive term
// (they just ride, a walk being row-local) admits it at every child position AND inside another
// repeat's body — the same capability seen from two sides.
describe('repeat() as a child body', () => {
  const names = (store: GraphStore, g: string) => (run(store, g) as any[]).map((r) => r.v).sort();
  const one = (store: GraphStore, g: string) => (run(store, g) as any[])[0].v;

  test('a walk composes at EVERY child position', () => {
    // Before: only a union arm worked; local/map/where/group/order all reported a classify deferral.
    const store = seededStore();
    expect(names(store, 'g.V(1).local(__.repeat(__.out()).times(2)).values("name")')).toEqual(['lop', 'ripple']);
    expect(one(store, 'g.V(1).map(__.repeat(__.out()).times(2).count())')).toBe(2);
    expect(names(store, 'g.V(1).where(__.repeat(__.out()).times(2)).values("name")')).toEqual(['marko']);
    // …and each parent gets its OWN walk — the point of carrying the ordinal. josh reaches
    // {lop,ripple} in one hop and nothing in two; marko reaches 2 vertices in two hops.
    expect(one(store, 'g.V(4).map(__.repeat(__.out()).times(1).count())')).toBe(2);
    expect(one(store, 'g.V(4).map(__.repeat(__.out()).times(2).count())')).toBe(0);
    // The sharpest form: one group per person, each value that person's OWN walk count. A walk
    // that lost its origin column could not produce four different numbers here.
    expect((run(store, 'g.V().hasLabel("person").group().by("name").by(__.repeat(__.out()).times(1).count())') as any[])
      .map((r) => [r.gk, Number(r.gv)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([['josh', 2], ['marko', 3], ['peter', 1], ['vadas', 0]]);
  });

  test('an ORDER by a walk count ranks parents by their own walks', () => {
    const store = seededStore();
    // marko reaches 3 in one hop, josh 2, peter 1, vadas 0 — so descending by that count is a
    // total order over the persons, which is only correct if each walk is per-parent.
    expect((run(store, 'g.V().hasLabel("person").order().by(__.repeat(__.out()).times(1).count(), desc).values("name")') as any[]).map((r) => r.v))
      .toEqual(['marko', 'josh', 'peter', 'vadas']);
  });

  test('a repeat NESTS inside another repeat body', () => {
    // Needs both halves: the body relation admits the inner walk as a row-local body, and the inner
    // walk carries the outer body-relation's origin. Also needed normalizing the body with the same
    // normalize() every other nested body uses — with only foldByModulators the inner times() never
    // folded onto its repeat(), which reported `repeat() requires times(), until(), or emit()`.
    const store = seededStore();
    expect(names(store, 'g.V(1).repeat(__.out().repeat(__.out()).times(1)).times(1).values("name")'))
      .toEqual(['lop', 'ripple']);
    // …equal to the flattened three-hop-ish equivalent, which is the real assertion.
    expect(names(store, 'g.V(1).repeat(__.out().repeat(__.out()).times(1)).times(1).values("name")'))
      .toEqual(names(store, 'g.V(1).out().repeat(__.out()).times(1).values("name")'));
  });

  test('a repeat ARM in a branch composes (it is a classifiable element child now)', () => {
    const store = seededStore();
    expect(names(store, 'g.V(1).optional(__.repeat(__.out()).times(2)).values("name")')).toEqual(['lop', 'ripple']);
    expect(names(store, 'g.V(1).coalesce(__.repeat(__.out()).times(2), __.in()).values("name")')).toEqual(['lop', 'ripple']);
    expect(one(store, 'g.V(1).union(__.repeat(__.out()).times(2), __.in()).count()')).toBe(2);
  });

  test('an INCOMING alias and an origin ride the walk TOGETHER', () => {
    // These landed as two separate pieces of work and are the same mechanism: loop-invariant
    // carried columns the walk neither reads nor rewrites (one `ride()` helper serves both). This
    // is the composition test — a walk inside a child scope, carrying BOTH an outer label and the
    // parent ordinal, which neither piece exercised alone.
    const store = seededStore();
    const names = (g: string) => (run(store, g) as any[]).map((r) => r.v).sort();
    expect(names('g.V(1).as("a").local(__.repeat(__.out()).times(2)).select("a").values("name")'))
      .toEqual(['marko', 'marko']); // two 2-hop walks, each re-rooted back to the outer label
    // …and per-parent walk counts still hold with a label live beside the ordinal.
    expect((run(store, 'g.V().hasLabel("person").as("a").group().by(__.select("a").values("name")).by(__.repeat(__.out()).times(1).count())') as any[])
      .map((r) => [r.gk, Number(r.gv)]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))))
      .toEqual([['josh', 2], ['marko', 3], ['peter', 1], ['vadas', 0]]);
    // A label bound INSIDE the body is the genuinely recursive question (it rebinds per iteration),
    // so it is a fold rather than a projection and still fails closed.
    expect(() => run(store, 'g.V(1).repeat(__.out().as("b")).times(2).select("b")'))
      .toThrow(/not yet supported/);
  });
});
