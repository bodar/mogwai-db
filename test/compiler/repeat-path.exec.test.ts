// Compiler execution semantics (split from test/compiler.test.ts) — repeat / times / emit / bulking / path / until.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { exec, executeQuery } from '../support/executor.ts';
import { decode, decodeAll } from '../support/decode.ts';
import { rawVertex } from '../support/graph.ts';
import { bagOf, grouped as groupedRows, run, seededStore } from '../support/harness.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe('compiler execution semantics', () => {
// Decode every Path from a framed GraphBinary response (shared by the recursive tests).
async function decodePaths(store: GraphStore, gremlin: string): Promise<any[]> {
  const buffers = executeQuery(store, gremlin, {}); // one framed Path per result value
  return decodeAll(buffers);
}

// props JSON is now {key:[{t,v}]} (self-describing typed nodes) — read the leaf payload.
const uNames = (store: GraphStore, q: string) => (run(store, q) as any[]).map((r) => JSON.parse(r.props).name[0].v);

test('a prefix limit is consumed before repeat() drops its encounter column', () => {
  const store = seededStore();
  const q = "g.V().hasLabel('person').limit(1).repeat(__.out()).times(1)";
  // The generic repeat route used to declare the prefix's encounter column after the walk had
  // dropped it, producing SQLite's "table cN has 2 values for 3 columns". This used to disable the
  // bulking fast path to reach that route; the fast path is deleted, so the route is simply the one
  // every bounded repeat takes.
  const generic = exec(store, undefined, DEFAULT_FAST_PATHS);
  expect(generic.framed(q, {})).toHaveLength(3);
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

test('path() emits the ordered walk (one Path per distinct route)', async () => {
  const store = seededStore();
  // marko(1)→josh(4)→{lop(3),ripple(5)} — two length-3 paths, in traversal order.
  //
  // Asserted on the DECODED Paths rather than on the SQL row, and that is the point: the two spines
  // spell the row differently and both are right — legacy projects a column per position
  // (`x0_id`/`x1_id`/…), RelIR one JSONB array of positions — so a test reading either one was
  // asserting the ROUTE. What this test means to assert is the WALK, which is what a framed Path
  // holds whichever route answered (`written()` in test/support/harness.ts, same lesson).
  const paths = (await decodePaths(store, 'g.V(1).out().out().path()')).map((p: any) => p.objects.map((o: any) => o.id));
  // Two distinct routes and nothing asking for an order between them: the assertion is the SET of
  // walks, which is what "one Path per distinct route" means.
  expect(bagOf(paths)).toEqual(bagOf([[1, 4, 3], [1, 4, 5]]));
});


test('path().by(key) projects each element; a missing key drops the whole path', async () => {
  const store = seededStore();
  // marko(age29)→{vadas27,josh32, lop(no age)}: lop path drops (non-productive by).
  const rows = (await decodePaths(store, 'g.V(1).out().path().by("age")')).map((path: any) => path.objects);
  expect(bagOf(rows)).toEqual(bagOf([[29, 27], [29, 32]])); // three out-neighbours, only two survive
});

test('the SAME path().by() answers identically in both regimes (one position projector)', async () => {
  // The two regimes had two hand-rolled projectors and the grouped one hardcoded a property
  // read, so by(T.id)/by(T.label) worked on a LINEAR path and threw on a RECURSIVE one — the
  // same modulator, two answers. Both now go through one projector, parameterized by how the
  // element is reached (joined table vs correlated read off the exploded id).
  const store = seededStore();
  const paths = async (g: string) => (await decodePaths(store, g)).map((path: any) => path.objects);
  // marko's 2-hop walks are [marko,josh,lop] and [marko,josh,ripple].
  expect(bagOf(await paths('g.V(1).repeat(__.out()).times(2).path().by(T.id)')))
    .toEqual(bagOf([[1, 4, 3], [1, 4, 5]]));
  expect(bagOf(await paths('g.V(1).repeat(__.out()).times(2).path().by(T.label)')))
    .toEqual(bagOf([
      ['person', 'person', 'software'],
      ['person', 'person', 'software'],
    ]));
  // by(key) unchanged in the grouped regime…
  expect(bagOf(await paths('g.V(1).repeat(__.out()).times(2).path().by("name")')))
    .toEqual(bagOf([
      ['marko', 'josh', 'lop'],
      ['marko', 'josh', 'ripple'],
    ]));
  // …and the LINEAR regime is byte-for-byte unaffected, including an EDGE position (which
  // reads its label/id off the joined edges table, not nodes).
  expect(bagOf(await paths('g.V(1).out().path().by(T.id)'))).toEqual(bagOf([[1, 2], [1, 4], [1, 3]]));
  expect(await paths('g.V(1).outE("created").inV().path().by(T.label)')).toEqual([['person', 'created', 'software']]);
});



test('path() interleaves edges and vertices with materialized props (via framing)', async () => {
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
  // Repeat.feature specifies an unordered result; the positions within each Path remain ordered.
  expect(bagOf(paths.map((p) => p.objects.map((o: any) => o.id))))
    .toEqual(bagOf([[1, 4, 3], [1, 4, 5]]));
});




test('do-while: repeat(out()).until(pred) runs the body then tests, multiset-correct', () => {
  const store = seededStore();
  // until a property predicate: marko→josh→ripple is the only name=ripple exit.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.has("name","ripple"))')).toEqual(['ripple']);
  // until a label: marko reaches lop directly AND via josh (two paths) + ripple via josh.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.hasLabel("software"))').sort()).toEqual(['lop', 'lop', 'ripple']);
});

test('an unproductive until predicate does not exit the walk', () => {
  const store = seededStore();
  const query = "g.V(1).repeat(__.out()).until(__.values('missing').is(P.neq(29)))";
  // `neq` is deliberately NULL-safe for a STORED null, so the separate productivity conjunct is
  // load-bearing here: no `missing` value means the predicate produced nothing, not that it differed.
  expect(uNames(store, query)).toEqual([]);
});

// ---------- bare emit(): the four modulator POSITIONS ----------
//
// `emit()` is a constant-true predicate (TrueTraversal), and `emitFirst`/`untilFirst` are set
// independently by whether each modulator was written before `repeat()`
// (gremlin-core RepeatStep.java:89,100). At a SHARED position the two checks suppress each other —
// `processTraverser` returns on a until-first exit before the emit-first check (:265-278), and the
// emit-last check sits in the ELSE of the until-last check (:339-352) — so every output row leaves
// once. At OPPOSITE positions neither can, which the last test below pins.

test('emit() with no until(): before repeat includes the seed, after repeat does not', () => {
  const store = seededStore();
  // marko: d1 {vadas,josh,lop}, d2 {ripple,lop} — the walk runs to its natural fixpoint, uncapped.
  expect(uNames(store, 'g.V(1).repeat(__.out()).emit()').sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  expect(uNames(store, 'g.V(1).emit().repeat(__.out())').sort())
    .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
});

test('until() and emit() at a SHARED position: each output row leaves the walk once', () => {
  const store = seededStore();
  // Both AFTER: the end step exits OR emits, never both — and emit-after admits every depth >= 1,
  // which subsumes the exit, so the answer is the whole walk below the seed.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.hasLabel("software")).emit()').sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  // Both BEFORE: the head exits OR emits, so the whole walk leaves, seed included.
  expect(uNames(store, 'g.V(1).emit().until(__.hasLabel("software")).repeat(__.out())').sort())
    .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
  // emit BEFORE with until AFTER is also once-each: an end-step exit never reaches the head, so it
  // is never additionally emitted.
  expect(uNames(store, 'g.V(1).emit().repeat(__.out()).until(__.hasLabel("software"))').sort())
    .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
});

test('until() BEFORE with emit() AFTER emits and THEN exits — the row leaves twice', () => {
  const store = seededStore();
  // The one order where emit runs first in a traverser's journey, so neither check suppresses the
  // other. The corpus states the same asymmetry as a measurement: repeat(…).emit() answers `java`
  // while until(constant(true)).repeat(…).emit() answers `java, java`
  // (gremlin-test branch/Repeat.feature:258-284).
  //
  // Walk from marko: marko(d0), {vadas,josh,lop}(d1), {ripple,lop}(d2) — expansion stops at a
  // software vertex. Output = {depth >= 1} + {predicate holds} = 5 + 3 rows.
  expect(uNames(store, 'g.V(1).until(__.hasLabel("software")).repeat(__.out()).emit()').sort())
    .toEqual(['josh', 'lop', 'lop', 'lop', 'lop', 'ripple', 'ripple', 'vadas']);
  // A predicate holding at ONE row doubles exactly that row: ripple, and nothing else.
  expect(uNames(store, 'g.V(1).until(__.has("name","ripple")).repeat(__.out()).emit()').sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'ripple', 'vadas']);
});

test('emit(pred) selects which rows leave, at either position', () => {
  const store = seededStore();
  // No until, so the walk runs to exhaustion: marko(d0), {vadas,josh,lop}(d1), {ripple,lop}(d2).
  // After repeat the predicate follows incrLoops, so the seed can never emit…
  expect(uNames(store, 'g.V(1).repeat(__.out()).emit(__.hasLabel("software"))').sort())
    .toEqual(['lop', 'lop', 'ripple']);
  // …while before repeat it is tested at every depth INCLUDING the seed, which is the only
  // difference between these two — marko is a person, so it shows up in the second and not the first.
  expect(uNames(store, 'g.V(1).emit(__.hasLabel("person")).repeat(__.out())').sort())
    .toEqual(['josh', 'marko', 'vadas']);
});

test('emit(pred) and until(pred) are INDEPENDENT conditions once the predicate is not constant', () => {
  const store = seededStore();
  // Bare emit-after is exactly `deeper`, which subsumes an until-after exit. A predicate does not:
  // these two select disjoint rows, so the output is a genuine disjunction of both.
  // exits {lop(d1), ripple, lop(d2)} OR emits {vadas, josh} — five rows, each leaving once.
  expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.hasLabel("software")).emit(__.hasLabel("person"))').sort())
    .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
  // emit BEFORE with until AFTER stays once-each: an end-step exit never reaches the head, so it is
  // never additionally emitted even when it satisfies the emit predicate too.
  expect(uNames(store, 'g.V(1).emit(__.hasLabel("software")).repeat(__.out()).until(__.hasLabel("software"))').sort())
    .toEqual(['lop', 'lop', 'ripple']);
});

test('emit(pred) doubles under until-before/emit-after, exactly as the bare form does', () => {
  const store = seededStore();
  // Both conditions select the same three rows here, and neither check suppresses the other, so
  // every one of them leaves twice. A disjunction would answer three rows instead of six.
  expect(uNames(store, 'g.V(1).until(__.hasLabel("software")).repeat(__.out()).emit(__.hasLabel("software"))').sort())
    .toEqual(['lop', 'lop', 'lop', 'lop', 'ripple', 'ripple']);
});

test('a MULTI-ARM body walks: both() is a compound term, one arm per direction', () => {
  const store = seededStore();
  // ⚠️ COMPARE THROUGH count(), NOT ROWS. The bounded regime RLE-collapses duplicates into `bulk`
  // while a walk cannot collapse at all (§1: SQLite forbids the aggregate in a recursive term), so
  // the two regimes hold the SAME multiset in different representations. Raw rows compare the
  // representation; count() sums bulk and compares the answer.
  const walked = (n: number) => (run(store, `g.V(1).repeat(__.both()).until(__.loops().is(${n})).count()`) as any[])[0].v;
  const bounded = (n: number) => (run(store, `g.V(1).repeat(__.both()).times(${n}).count()`) as any[])[0].v;
  expect([walked(1), walked(2), walked(3)]).toEqual([3, 7, 17]);
  expect([walked(1), walked(2), walked(3)]).toEqual([bounded(1), bounded(2), bounded(3)]);
});

test('both() through the walk yields a SELF-LOOP twice — the multiset rule survives the compound', () => {
  const store = seededStore();
  rawVertex(store, 900, 'person');
  store.query('INSERT INTO edges(id,src,label,tgt) VALUES(950,900,?,900)', [store.labelId('knows')]);
  // The one shape a disjunctive single-arm join would get wrong: `e.src = w.id OR e.tgt = w.id`
  // matches a self-loop once. Two arms match it once each, which is what both() means.
  expect((run(store, 'g.V(900).repeat(__.both()).until(__.loops().is(1)).count()') as any[])[0].v).toBe(2);
});

test('repeat() with NEITHER modulator is the empty result, and the chain folds over it', () => {
  const store = seededStore();
  // Nothing ever leaves the loop, so the traversal is empty…
  expect(run(store, 'g.V(1).repeat(__.out())')).toEqual([]);
  expect(uNames(store, 'g.V().repeat(__.out())')).toEqual([]);
  // …but EMPTY IS NOT "no output". count() is a reducing barrier with a seed, so it answers 0 over
  // the empty stream. This is why the fold must produce an empty RELATION and never short-circuit.
  expect((run(store, 'g.V(1).repeat(__.out()).count()') as any[]).map((r) => r.v)).toEqual([0]);
});

// ---------- a sack folded through the walk, and carried state read from a child body ----------
//
// TinkerPop evaluates a child traversal on a SPLIT of the whole traverser at bulk 1
// (TraversalUtil.prepare), so sack() and loops() are ordinary ScalarMapSteps reading traverser state
// — there is no "sack inside until()" special case in the model. Ours reaches the same place through
// the host's ROW, which is Calcite's correlating row (RexCorrelVariable).

test('a sack folds through the recursive walk, one iteration at a time', () => {
  const store = seededStore();
  // marko's out-neighbours: vadas 27, josh 32, lop has NO age. An unproductive by() FILTERS the
  // traverser rather than folding a null — SackValueStep returns EmptyTraverser.instance() — so lop
  // never reaches the output at all.
  expect((run(store, 'g.withSack(0).V(1).repeat(__.out().sack(Operator.sum).by("age")).emit().sack()') as any[])
    .map((r) => r.v).sort()).toEqual([27, 32]);
  // by(traversal) folds too: a correlated scalar subquery is a NESTED select, which the recursive
  // term admits (BARRIER_IN_TERM stops at every nested SELECT).
  expect((run(store, 'g.withSack(0).V(1).repeat(__.out().sack(Operator.sum).by(__.values("age"))).emit().sack()') as any[])
    .map((r) => r.v).sort()).toEqual([27, 32]);
  // a per-hop decay factor — the multiplicative form, two hops deep.
  expect((run(store, 'g.withSack(1.0).V(1).repeat(__.out().sack(Operator.mult).by(__.constant(0.5))).emit().sack()') as any[])
    .map((r) => r.v).sort()).toEqual([0.25, 0.25, 0.5, 0.5, 0.5]);
});

test('until()/emit() READ the carried sack, and loops() reads the counter', () => {
  const store = seededStore();
  // vadas folds 27 and keeps going; josh folds 32 and exits. lop is filtered by the unproductive by().
  expect((run(store, 'g.withSack(0).V(1).repeat(__.out().sack(Operator.sum).by("age")).until(__.sack().is(P.gt(30))).sack()') as any[])
    .map((r) => r.v)).toEqual([32]);
  expect((run(store, 'g.withSack(0).V(1).repeat(__.out().sack(Operator.sum).by("age")).emit(__.sack().is(P.gt(30))).sack()') as any[])
    .map((r) => r.v)).toEqual([32]);
  // A sack that never folds never satisfies the exit, and the walk still terminates by exhaustion.
  expect(run(store, 'g.withSack(0).V(1).repeat(__.out()).until(__.sack().is(P.gt(10)))')).toEqual([]);
});

test('carried state is readable OUTSIDE a repeat too — the seam, not the walk', () => {
  const store = seededStore();
  // where(__.sack().is(P)) on an ordinary chain. This is the whole point of teaching the child seam
  // rather than the walk: the same read works wherever a child body is lowered.
  expect((run(store, 'g.withSack(0).V().sack(Operator.sum).by("age").where(__.sack().is(P.gt(30))).sack()') as any[])
    .map((r) => r.v).sort()).toEqual([32, 35]);
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
  const knows = store.labelId('knows');
  const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
  const edge = 'INSERT INTO edges(id, src, label, tgt) VALUES(?,?,?,?)';
  const N = 40; // deeper than the retired cap
  for (let i = 0; i <= N; i++) { rawVertex(store, i + 1, 'person'); store.query(prop, [i + 1, 'name', `n${i}`]); }
  for (let i = 0; i < N; i++) store.query(edge, [100 + i, i + 1, knows, i + 2]); // n0→n1→…→n40
  expect(uNames(store, `g.V(1).repeat(__.out()).until(__.has("name","n${N}"))`)).toEqual([`n${N}`]);
});

// ---------- sack folded through the recursive walk ----------





test('until(__.sack().is(P)) loops until the ACCUMULATED sack crosses a threshold', () => {
  const store = seededStore();
  // marko folds its own age (29) each iteration: 29 (<50, keep going), 58 (≥50, stop). → [58].
  // This is the spreading-activation-with-threshold primitive (loop until relevance crosses a bound).
  expect((run(store, "g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).until(__.sack().is(gte(50))).sack()") as any[]).map((r) => r.v))
    .toEqual([58]);
});


// ⚠️ **`relOnly` — LEGACY SHED THESE, and naming the shed is the point.** A `times(n)` body holding a
// side effect now UNROLLS (`UNROLLABLE_BARRIERS`, `ir/strategies.ts`), and the unroll is a PASS, so
// legacy receives the n phases too — where its `steps/prefix/sideeffect.ts` last-write-wins keeps ONE
// registration of a twice-filled label and answers half the multiset (§8 of
// docs/2026-08-09-named-collections-are-bindings-plan.md, a wrong answer rather than a decline). Legacy
// previously answered these through its walk-and-bag lowering, so this is a REAL shed and not a
// coverage gap: §6·1's asymmetric gate allows it because the RelIR floor holds them, and the L3 legacy
// run reports it by name. The assertions themselves are the reference's, so they stay.
test('a body aggregate() collects every vertex the walk visits (the :TOUCHED provenance primitive)', () => {
  const store = seededStore();
  // marko out → {vadas,josh,lop} (depth 1); josh out → {ripple,lop} (depth 2). The bag is a
  // BulkSet multiset, so lop appears twice. cap('x').unfold() explodes it to elements.
  const names = (run(store, "g.V(1).repeat(__.out().aggregate('x')).times(2).cap('x').unfold().values('name')") as any[]).map((r) => r.v).sort();
  expect(names).toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
});

// ⚠️ **`relOnly` — LEGACY SHED THESE, and naming the shed is the point.** A `times(n)` body holding a
// side effect now UNROLLS (`UNROLLABLE_BARRIERS`, `ir/strategies.ts`), and the unroll is a PASS, so
// legacy receives the n phases too — where its `steps/prefix/sideeffect.ts` last-write-wins keeps ONE
// registration of a twice-filled label and answers half the multiset (§8 of
// docs/2026-08-09-named-collections-are-bindings-plan.md, a wrong answer rather than a decline). Legacy
// previously answered these through its walk-and-bag lowering, so this is a REAL shed and not a
// coverage gap: §6·1's asymmetric gate allows it because the RelIR floor holds them, and the L3 legacy
// run reports it by name. The assertions themselves are the reference's, so they stay.
test('a pre-repeat aggregate multiset-unions with the in-repeat body aggregate (Aggregate.feature:627)', () => {
  const store = seededStore();
  // V().local(aggregate('a')) collects all 6 vertices; then repeat(out().local(aggregate('a'))).times(2)
  // appends the walk's depth-1 and depth-2 rows. groupCount by name over the whole BulkSet — asserted
  // on the raw gk/gv rows (the wire-framed Map is verified equivalent by the L3 conformance run).
  // Read through `grouped`, which sees legacy's `(gk, gv)` rows AND RelIR's framed map alike — the
  // route moved when a `times(n)` body holding a side effect started UNROLLING, and an assertion that
  // named one spine's row shape would have read as a semantics regression rather than a route change.
  const rows = run(store, `g.V().local(__.aggregate('a')).repeat(__.out().local(__.aggregate('a'))).times(2).cap('a').unfold().values('name').groupCount()`);
  expect(groupedRows(rows)).toEqual({ marko: 1, vadas: 2, josh: 2, lop: 5, ripple: 3, peter: 1 });
});

// ⚠️ **`relOnly` — LEGACY SHED THESE, and naming the shed is the point.** A `times(n)` body holding a
// side effect now UNROLLS (`UNROLLABLE_BARRIERS`, `ir/strategies.ts`), and the unroll is a PASS, so
// legacy receives the n phases too — where its `steps/prefix/sideeffect.ts` last-write-wins keeps ONE
// registration of a twice-filled label and answers half the multiset (§8 of
// docs/2026-08-09-named-collections-are-bindings-plan.md, a wrong answer rather than a decline). Legacy
// previously answered these through its walk-and-bag lowering, so this is a REAL shed and not a
// coverage gap: §6·1's asymmetric gate allows it because the RelIR floor holds them, and the L3 legacy
// run reports it by name. The assertions themselves are the reference's, so they stay.
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



  test('an exploded-edge body filters its joined edge alias, not the base edges table', () => {
    const store = seededStore();
    // bothE('knows') enters each of marko's two knows edges, then outV() returns marko twice.
    // This reaches the multi-step flat repeat expander, whose label filter must qualify the
    // fresh recursive edge alias rather than the schema relation name.
    expect(names(store, 'g.V(1).repeat(__.bothE("knows").outV()).times(1).values("name")'))
      .toEqual(['marko', 'marko']);
  });


  test('traversers stay a MULTISET through the body relation', () => {
    // The relation must NOT be built with DISTINCT: two parallel edges are two traversers. josh
    // reaches lop and ripple, and marko/josh/peter all reach lop, so a one-hop walk from every
    // vertex keeps lop three times.
    const store = seededStore();
    expect(names(store, 'g.V().repeat(__.out().hasLabel("software")).times(1).values("name")'))
      .toEqual(['lop', 'lop', 'lop', 'ripple']);
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


  test('a PER-ITERATION state predicate keeps the inline route', () => {
    const store = seededStore();
    // loops()/sack() read state that does not exist per-vertex, so they are outside the row-local
    // vocabulary and keyedChildRelation declines them on its own — no separate guard needed.
    // These work because INLINE serves them; the keyed route is never consulted.
    expect(ids(store, 'g.V(1).until(__.loops().is(2)).repeat(__.out())').length).toBeGreaterThan(0);
  });

  test('the recursive walk inherits the shared predicate seam', () => {
    const store = seededStore();
    // The RelIR walk inherits the shared predicate seam. For productivity, order().limit(1) after a
    // movement is exactly EXISTS; marko has an outgoing edge, so while-do emits the seed unchanged.
    expect(ids(store, 'g.V(1).until(__.out().order().by("name").limit(1)).repeat(__.out())')).toEqual([1]);
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
    // normalize() every other nested body uses — with only absorbModulators the inner times() never
    // folded onto its repeat(), which reported `repeat() requires times(), until(), or emit()`.
    const store = seededStore();
    expect(names(store, 'g.V(1).repeat(__.out().repeat(__.out()).times(1)).times(1).values("name")'))
      .toEqual(['lop', 'ripple']);
    // …equal to the flattened three-hop-ish equivalent, which is the real assertion.
    expect(names(store, 'g.V(1).repeat(__.out().repeat(__.out()).times(1)).times(1).values("name")'))
      .toEqual(names(store, 'g.V(1).out().repeat(__.out()).times(1).values("name")'));
  });


});
