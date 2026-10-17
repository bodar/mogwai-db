// What `repeat()` with a fixed `times(n)` may and may not be rewritten into — the boundary
// `docs/outstanding-work.md` item 3 proposes crossing, pinned against the reference before anyone
// crosses it.
//
// TWO reference facts, both read from the vendored source rather than inferred, and they pull in
// OPPOSITE directions. Our deferral messages assert the first; the item's plan assumes the second is
// available and it is not.
//
// 1. A barrier in a repeat body DOES observe the whole frontier.
//    `RepeatStep.standardAlgorithm`
//    (vendor/tinkerpop/gremlin-core/.../step/branch/RepeatStep.java:217) tests
//    `hasStepOfAssignableClassRecursively(Barrier.class, repeatTraversal)` and, when it holds, drains
//    EVERY start into the body before iterating it — its own comment: "make sure that all starts are
//    added to the repeatTraversal before it is iterated so that RepeatStep always has 'global'
//    children." Without a barrier it pulls ONE start at a time. So the per-iteration-frontier reading
//    our deferrals state is the reference's, not an assumption of ours.
//
// 2. TinkerPop will NOT unroll such a body. `RepeatUnrollStrategy`'s `ALLOWED_STEP_CLASSES` is
//    `VertexStepContract`, `EdgeVertexStep`, `EdgeOtherVertexStep`, `HasStep`, `RepeatStep`,
//    `RepeatStep.RepeatEndStep` — movement and `has()`, no barriers — and the class comment says why:
//    "intentionally conservative as there have been unintentional traversal semantics changes in the
//    past when allowing a large variety of steps (especially barriers)."
//
// So item 3's "unroll a barrier body into n generic phases" is NOT reference-sanctioned. It may still
// be right FOR US, and for a reason that does not apply to an interpreter: our phases are
// set-at-a-time by construction, so "the whole frontier at iteration k" is exactly what phase k's
// relation IS — which is the very property fact 1 shows the interpreter had to special-case to get.
// But the equivalence has to be argued per barrier and pinned, not assumed from the corpus count.
//
// What this file pins is the BOUNDARY, which has since MOVED twice. `dedup` was unrolled
// (`UNROLLABLE_BARRIERS`, ir/strategies.ts) on the argument that a bare `dedup()` is a stateless
// collapse of the set it is handed — and the corpus REFUTES that for n ≥ 2: the reference's dedup is
// one step instance whose seen-set spans every iteration (`DedupGlobalStep.duplicateSet`), so
// `g.V().repeat(__.dedup()).times(2).count()` is 0 (Dedup.feature g_V_repeatXdedupX_timesX2X_count),
// not the 6 that `V.dedup.dedup` gives. So a dedup body unrolls only at n = 1 and declines beyond it —
// unless every body step is a value-preserving filter, whose levels ≥ 2 are then provably empty.
// The file's job is to keep the line visible rather than to bless a direction.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { normalize, runPasses } from '../../src/compiler/ir/passes.ts';
import { extractStrategies, parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { bagOf, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const vals = (q: string) => (run(store, q) as any[]).map((r) => r.v ?? r.id);

describe('the repeat() unroll boundary', () => {
  test("the bodies RepeatUnrollStrategy admits — movement and has() — unroll into phases", () => {
    // ALLOWED_STEP_CLASSES exactly: a vertex step, an edge-vertex step, and has().
    // repeat() is deliberately outside the emission-order substrate (analyze.ts returns false for
    // it), so these are multisets.
    expect(bagOf(vals('g.V(1).repeat(__.out()).times(2)'))).toEqual([3, 5]);
    expect(bagOf(vals('g.V(1).repeat(__.outE().inV()).times(2)'))).toEqual([3, 5]);
    expect(bagOf(vals("g.V(1).repeat(__.out().has('name')).times(2)"))).toEqual([3, 5]);
    // They already compiled through the recursive expansion, but bounded phases are the only regime
    // that can collapse a multiset frontier. Pin the transformation itself: answer equality alone
    // would not distinguish the old enumerate-every-walk plan from the phase-wise one.
    const names = (g: string) =>
      normalize(stepChain(parseGremlin(g), {}), {}, undefined, false).steps.map((s) => s.name);
    for (const q of [
      'g.V(1).repeat(__.out()).times(2)',
      'g.V(1).repeat(__.outE().inV()).times(2)',
      "g.V(1).repeat(__.out().has('name')).times(2)",
    ]) expect(names(q)).not.toContain('repeat');
  });

  test('the one barrier we DO unroll agrees with the hand-written phases', () => {
    // The equivalence is the whole licence for going past `RepeatUnrollStrategy`, so it is asserted
    // as an identity rather than as an expected value: `repeat(B).times(n)` must equal B written out
    // n times. If a future name joins `UNROLLABLE_BARRIERS`, add its pair here — that is the pin the
    // set's comment demands.
    const pairs: readonly [string, string][] = [
      // DEDUP only at n = 1 — a single iteration has no earlier iteration's seen-set to inherit.
      ["g.V().repeat(__.both().dedup()).times(1).values('name')", "g.V().both().dedup().values('name')"],
      ['g.V().repeat(__.dedup().both()).times(1).count()', 'g.V().dedup().both().count()'],
      // THE SLICE FAMILY. Asserted as an identity precisely because an unpinned slice is arbitrary:
      // both spellings must take the same arbitrary rows, which is what "phase k's relation IS the
      // frontier at iteration k" claims and what a value-expectation could not distinguish.
      ['g.V().repeat(__.out().limit(2)).times(2).count()', 'g.V().out().limit(2).out().limit(2).count()'],
      ["g.V(5).repeat(__.limit(1).in()).times(2).values('name')", "g.V(5).limit(1).in().limit(1).in().values('name')"],
      ['g.V().repeat(__.out().range(0,2)).times(2).count()', 'g.V().out().range(0,2).out().range(0,2).count()'],
      ['g.V().repeat(__.both().limit(3)).times(3).count()', 'g.V().both().limit(3).both().limit(3).both().limit(3).count()'],
      // ORDER, including the modulator host the pass could not admit until the body was normalized
      // before splicing — `order().by(k)` arrives as ONE step now, not two loose ones.
      ['g.V().repeat(__.order()).times(2).count()', 'g.V().order().order().count()'],
      ["g.V().repeat(__.out().order().by('name')).times(2).count()", "g.V().out().order().by('name').out().order().by('name').count()"],
      ["g.V().repeat(__.out().order().by('name').limit(1)).times(2).values('name')",
        "g.V().out().order().by('name').limit(1).out().order().by('name').limit(1).values('name')"],
    ];
    for (const [rolled, written] of pairs) expect(vals(rolled)).toEqual(vals(written));
  });

  test('a dedup body past one iteration DECLINES — the seen-set spans iterations, a phase cannot carry it', () => {
    // `DedupGlobalStep.duplicateSet` (vendor/tinkerpop/gremlin-core/.../step/filter/DedupGlobalStep.java:59)
    // is never reset between iterations, unlike `RangeGlobalStep`'s per-loop counters — so iteration
    // k's dedup also drops what iterations 1..k-1 let through. The corpus answers are 0
    // (Dedup.feature g_V_repeatXdedupX_timesX2X_count) and empty (Repeat.feature
    // g_V_repeatXdedup_bothX_timesX2X); n phase-local dedups gave 6 and 6. Fail closed at every
    // regime and depth the unroll serves.
    for (const q of [
      'g.V().repeat(__.dedup().both()).times(2)',
      'g.V().repeat(__.both().dedup()).times(3).count()',
      'g.V().emit().repeat(__.out().dedup()).times(2)',
      'g.V().repeat(__.both().dedup()).emit().times(2)',
      'g.V().local(__.emit().repeat(__.both().dedup()).times(2)).count()',
      'g.V().union(__.repeat(__.dedup().both()).times(2), __.out()).count()',
      // A NESTED repeat is unrolled into the outer body first, so its dedup is the outer body's too —
      // one instance across every OUTER iteration.
      'g.V().repeat(__.repeat(__.dedup()).times(1).out()).times(2)',
      // A `Scope.local` slice/reorder is the same NAME as a value-preserving global step and a value
      // TRANSFORM: `[1,2,3]` → `[2,3]` → `[3]`, and `[3]` is a value the dedup has NOT seen, so level 2
      // is not empty. The reference answers are [[3]], [[2,3],[3]] and [[2,3],[3],[3]]; declaring level 2
      // empty gave [], [[2,3]], [[2,3]]. The admission is by ARGUMENT, so these decline.
      'g.inject([1,2,3]).repeat(__.range(Scope.local,1,3).dedup()).times(2)',
      'g.inject([1,2,3]).repeat(__.range(Scope.local,1,3).dedup()).emit().times(2)',
      'g.inject([1,2,3]).times(2).repeat(__.range(Scope.local,1,3).dedup()).emit()',
      "g.V().values('name').fold().repeat(__.range(Scope.local,1,5).dedup()).times(2)",
      'g.inject([1,2,3,4]).repeat(__.limit(Scope.local,3).range(Scope.local,1,3).dedup()).times(2)',
      'g.inject([3,1,2]).repeat(__.order(Scope.local).dedup()).times(2)',
      'g.inject([1,2,3]).local(__.repeat(__.limit(Scope.local,2).dedup()).times(2))',
    ]) expect(() => compile(q, {})).toThrow(/not supported/);
    // …EXCEPT a body of value-preserving filters only: iteration 2's input is iteration 1's output, all
    // of it already seen, so every level ≥ 2 is EMPTY — exact by construction, not by phase-local dedup.
    const count = (q: string) => vals(`${q}.count()`)[0];
    expect(count('g.V().repeat(__.dedup()).times(2)')).toBe(0);                        // Dedup.feature
    expect(count("g.V().repeat(__.hasLabel('person').dedup()).times(3)")).toBe(0);
    expect(count('g.V().emit().repeat(__.dedup()).times(2)')).toBe(12);               // Repeat.feature
    expect(count('g.V().emit().repeat(__.dedup()).times(3)')).toBe(12);
    expect(count('g.V().repeat(__.dedup()).emit().times(3)')).toBe(6);                // level 1 only
    expect(count('g.V().times(3).repeat(__.dedup()).emit()')).toBe(6);                // no level-n double: empty
    expect(count('g.V().times(1).repeat(__.dedup()).emit()')).toBe(12);               // level 1, doubled
    expect(count('g.V().local(__.emit().repeat(__.dedup()).times(2))')).toBe(12);
    // GLOBAL slices/reorders keep the value, so they stay inside the exception.
    expect(count('g.V().repeat(__.dedup().limit(3)).times(2)')).toBe(0);
    expect(count('g.V().emit().repeat(__.range(Scope.global,0,3).dedup()).times(2)')).toBe(9);
    // …and a LOCAL slice at n = 1 has no earlier iteration to inherit from, so it still unrolls.
    expect(() => compile('g.inject([1,2,3]).repeat(__.range(Scope.local,1,3).dedup()).times(1)', {})).not.toThrow();
  });

  /**
   * THE STEP CEILING IS GONE, AND `times(51)` IS THE WITNESS.
   *
   * The pass used to refuse past 100 spliced steps — a step count standing in for the DO's 100 KB of
   * statement text, charging every body the worst measured per-step cost. A two-step barrier body
   * (then `both().dedup()`, now `both().limit(5)` since dedup unrolls only at n = 1) is two steps, so `times(51)` was 102 and fell to a route that cannot express a per-iteration barrier
   * at all, which is the one thing the unroll exists for (§1). Both sides of that old boundary now
   * unroll, and so does a body far past it.
   *
   * Nothing replaces it in the compiler: a platform constant does not belong in a routing decision,
   * because the platform enforces its own limits and a raised cap should not need a release. The caps
   * are asserted in the BUILD instead — `CfLimitedSql` makes Bun refuse what a DO refuses, and
   * `rel-sweep`/`sql-hygiene` ask `cfLimitViolation` of every corpus plan.
   */
  test('the unroll has no step ceiling — the platform owns its own limits', () => {
    for (const n of [49, 51, 200]) {
      expect(() => compile(`g.V().repeat(__.both().limit(5)).times(${n}).count()`, {})).not.toThrow();
    }
    // …and the multiplication is still LINEAR in n, so the text a body costs stays predictable.
    const bytes = (n: number): number => {
      const plan = compile(`g.V().repeat(__.both().limit(5)).times(${n}).count()`, {});
      if (!('sql' in plan)) throw new Error('expected a read plan');
      return plan.sql.length;
    };
    const small = bytes(50);
    const large = bytes(200);
    expect(large).toBeGreaterThan(small * 3);
    expect(large).toBeLessThan(small * 5);
  });

  test('a barrier call() body unrolls to sequential top-level calls — the SEGMENT machinery chains them', () => {
    // A repeat body whose barrier is an OLAP `call()` (native `connectedComponent()`/`pageRank()` desugar
    // to `call`) unrolls like any admitted barrier: phase k IS the frontier at iteration k, so n phases
    // are n sequential service boundaries, which `segmentPlan`'s resume re-entry chains (item 4). Pinned
    // structurally here (no `repeat` survives; n `call` steps appear); the EXEC identity — that it equals
    // the barrier written out n times — is in `test/L2-sql/olap-chain.exec.test.ts` because a barrier
    // needs the async drive this sync helper does not run.
    const names = (g: string) =>
      normalize(stepChain(parseGremlin(g), {}), {}, undefined, false).steps.map((s) => s.name);
    const cc = names('g.V().repeat(__.connectedComponent()).times(2).count()');
    expect(cc).not.toContain('repeat');
    expect(cc.filter((n) => n === 'call').length).toBe(2);
    // EMIT + a barrier call() declines — an emitted level is a UNION arm, and a barrier in a union arm is
    // the tree-Plan promotion target (§6), not sequential chaining. Fail closed: the repeat survives, so
    // the traversal reaches the ordinary (declining) route rather than splicing a call into an arm.
    expect(names('g.V().repeat(__.connectedComponent()).emit().times(2).count()')).toContain('repeat');
  });

  test('until and a named loop decline — a predicate bound and a live counter, not a fixed n', () => {
    // until() is a predicate rather than a count (the unbounded regime → the walk), and a named
    // repeat("a", …) carries a counter loops("a") can read from arbitrarily deep, which the phases have
    // nowhere to attach. bare emit() is NOT here any more — it unrolls (see the next test).
    for (const q of [
      "g.V().repeat(__.dedup().both()).until(__.has('name','lop'))",
      // The NAMED loop, which this test's own name has always claimed and its list did not contain —
      // and that gap is exactly how the defect below survived.
      'g.V().repeat("a", __.dedup().both()).times(2)',
    ]) expect(() => compile(q, {})).toThrow();
  });

  test('bare emit() unrolls — repeat(b).emit().times(n) is a UNION ALL of levels 1..n', () => {
    // emit at every level is the union of the frontier after each emitted level, which the BOUNDED unroll
    // now produces for ANY unrollable body — a barrier in the body applies per-arm (per-iteration), which
    // is what the semantics ask. Corpus-validated: `repeat(__.out()).times(2).emit()` → count 8
    // (Repeat.feature:76), and `emit().repeat(__.dedup()).times(2)` → each vertex twice
    // (Repeat.feature:974). emit(pred) still declines (fail closed) — bare emit only.
    for (const q of [
      'g.V().repeat(__.out()).times(2).emit()',
      'g.V().emit().repeat(__.out()).times(2)',
      "g.V().hasLabel('person').repeat(__.out('knows')).emit().times(2)",
      // n = 1: a dedup seen-set spans iterations, so n ≥ 2 declines (see the decline test above).
      'g.V().emit().repeat(__.dedup()).times(1)',
    ]) expect(() => compile(q, {})).not.toThrow();
    // emit(pred) — a predicate emit — is NOT a union of prefixes; it declines to the walk / a refusal.
    expect(() => compile('g.V().repeat(__.out()).emit(__.has("name","x")).times(2)', {})).toThrow();
  });

  test('bare emit() emits EXACTLY the reference levels — level n always, doubled when until is first', () => {
    // Read off RepeatStep.java (vendor/tinkerpop/gremlin-core/.../step/branch/RepeatStep.java:265-278
    // `processTraverser`, :334-353 `RepeatEndStep`): the traverser satisfying `times(n)` at level n
    // LEAVES the loop and is output whatever the emit says; with until FIRST and emit LAST the end step
    // also emits a split of it, so level n appears twice. From marko (modern): level 0 = 1 vertex,
    // level 1 = 3, level 2 = 2. Trunk gave 4 for the first (level 2 dropped) and 5 for the third.
    const count = (q: string) => vals(`${q}.count()`)[0];
    expect(count('g.V(1).emit().repeat(__.out()).times(2)')).toBe(6);       // levels 0,1,2
    expect(count('g.V(1).emit().repeat(__.out()).times(1)')).toBe(4);       // levels 0,1
    expect(count('g.V(1).emit().times(2).repeat(__.out())')).toBe(6);       // emit first, until first
    expect(count('g.V(1).times(2).emit().repeat(__.out())')).toBe(6);
    expect(count('g.V(1).repeat(__.out()).times(2).emit()')).toBe(5);       // levels 1,2
    expect(count('g.V(1).repeat(__.out()).emit().times(2)')).toBe(5);
    expect(count('g.V(1).times(2).repeat(__.out()).emit()')).toBe(7);       // levels 1,2,2
    // Every depth the unroll serves — the corpus's own 14-path answer
    // (Repeat.feature g_V_emit_repeatXoutX_timesX2X_path / g_V_emit_timesX2X_repeatXoutX_path).
    expect(count('g.V().emit().repeat(__.out()).times(2).path()')).toBe(14);
    expect(count('g.V().emit().times(2).repeat(__.out()).path()')).toBe(14);
    expect(count('g.V().local(__.emit().repeat(__.out()).times(2))')).toBe(14);
    expect(count('g.V(1).union(__.emit().repeat(__.out()).times(2), __.identity())')).toBe(7);
    // n = 1 with a dedup body: each vertex twice (Repeat.feature g_V_emit_repeatXdedupX_timesX1X).
    expect(count('g.V().emit().repeat(__.dedup()).times(1)')).toBe(12);
  });

  test('a body SIDE EFFECT is written once per traverser — never re-run by an emit arm or the level-n double', () => {
    // The level-n double is the ORIGINAL traverser handed back to RepeatStep and output by its
    // `doUntil(true)` WITHOUT another body pass (RepeatStep.java:265-278), so `aggregate` sees each
    // level-1 vertex once while the stream carries it twice. A second union arm that re-spliced the body
    // wrote the side effect twice (cap = 6, groupCount values 2).
    const count = (q: string) => vals(`${q}.count()`)[0];
    expect(count("g.V(1).times(1).repeat(__.out().aggregate('x')).emit().cap('x').unfold()")).toBe(3);
    expect(count("g.V(1).times(1).repeat(__.out().aggregate('x')).emit()")).toBe(6);
    expect(vals("g.V(1).times(1).repeat(__.out().groupCount('x')).emit().cap('x').select(values).unfold().sum()")).toEqual([3]);
    expect(count("g.V(1).repeat(__.out().aggregate('x')).emit().times(1).cap('x').unfold()")).toBe(3);
    // Every other emit form is ≥ 2 INDEPENDENT arms, each re-running the body prefix for traversers the
    // reference ran through it once (the reference aggregates 5 members from marko; the arms gave 8 and
    // 13). DECLINED, at every depth — and so is the recursive walk, whose term cannot hold an aggregate
    // (it used to leak an internal `SelfRef` error instead of a refusal).
    for (const q of [
      "g.V(1).emit().repeat(__.out().aggregate('x')).times(2).cap('x')",
      "g.V(1).emit().repeat(__.out().aggregate('x')).times(1).cap('x')",
      "g.V(1).repeat(__.out().aggregate('x')).emit().times(2).cap('x')",
      "g.V(1).times(2).repeat(__.out().aggregate('x')).emit().cap('x')",
      "g.V(1).emit().repeat(__.out().group('x')).times(1).cap('x')",
      "g.V(1).union(__.emit().repeat(__.out().groupCount('x')).times(2), __.identity()).cap('x')",
      "g.V(1).local(__.times(1).repeat(__.out().aggregate('x')).emit()).cap('x')",
      "g.V(1).repeat(__.out().aggregate('x')).emit().cap('x')",
      "g.V(1).emit().repeat(__.out().aggregate('x')).cap('x')",
      "g.V(1).repeat(__.out().groupCount('x')).until(__.outE().count().is(0)).cap('x')",
    ]) expect(() => compile(q, {}), q).toThrow(/not supported yet/);
  });

  test('a NAMED repeat is not unrolled — the identity has nowhere to go', () => {
    // The refusal above is asserted through a downstream throw, which is necessary but not sufficient:
    // it would still pass if the unroll fired and something later happened to refuse. So pin the
    // property itself — the `repeat` step SURVIVES normalization.
    //
    // MEASURED as a live defect on trunk before this fix: `tryUnroll` rejected a named repeat by
    // testing the ARGUMENT COUNT, but `frontend.ts` splits the name onto `loopName`, so a named repeat
    // arrives with exactly one argument like any other. `g.V().repeat("a", __.out().dedup()).times(2)`
    // unrolled to `V.out.dedup.out.dedup` — byte-identical to the unnamed form, with `loops("a")`'s
    // counter silently gone. The arity test never fired once.
    // `nested: false` — these are ROOT traversals, and `normalize` defaults the other way (see its own
    // comment: every `src/` caller holds a body, so that is the safe default).
    const rolled = (g: string) =>
      normalize(stepChain(parseGremlin(g), {}), {}, undefined, false).steps.map((s) => s.name);
    expect(rolled('g.V().repeat("a", __.out().limit(2)).times(2)')).toContain('repeat');
    // …and the unnamed form still unrolls, so the guard is about the NAME and nothing else.
    expect(rolled('g.V().repeat(__.out().limit(2)).times(2)')).not.toContain('repeat');
  });


  test('withoutStrategies(RepeatUnrollStrategy) suppresses the STRATEGY, not the widening', () => {
    // The suppression is scoped to what `RepeatUnrollStrategy` actually does — a body of movement +
    // has() (`ALLOWED_STEP_CLASSES`). A BARRIER body is outside it in both directions: upstream
    // declines to unroll it, and for us the unroll is the only route that expresses it. So the mark
    // must NOT reach it, and this is the assertion that costs an answer if it ever does — the corpus
    // scenario `g_withoutStrategiesXRepeatUnrollStrategyX_V_repeatXboth_limitX1XX_timesX2X` expects a
    // count of 1 (RepeatUnrollStrategy.feature), and without the unroll a `limit` body throws.
    // Through `runPasses` WITH the extracted strategies, which is the seam `compile` uses: a
    // `withoutStrategies(...)` subtree is source configuration, so `stepChain` drops it and only
    // `extractStrategies` sees it — a `normalize` of the same text would silently carry no strategies.
    const marked = (g: string) => {
      const tree = parseGremlin(g);
      return runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}, undefined, false).steps;
    };
    for (const spelling of ['g.V()', 'g.withoutStrategies(RepeatUnrollStrategy).V()']) {
      const chain = marked(`${spelling}.repeat(__.both().limit(1)).times(2)`);
      expect(chain.map((s) => s.name)).not.toContain('repeat');
      expect(chain.filter((s) => s.name === 'limit')).toHaveLength(2);
      // A barrier CALL() body is widening too — the mark must not suppress it, or `pageRank`/`connected
      // Component` inside a repeat becomes a throw under an unrelated `withoutStrategies` request.
      const cc = marked(`${spelling}.repeat(__.connectedComponent()).times(2)`);
      expect(cc.map((s) => s.name)).not.toContain('repeat');
      expect(cc.filter((s) => s.name === 'call')).toHaveLength(2);
    }
    // …and the answer is what the corpus asserts, on the real store, however it is spelled.
    expect(vals('g.withoutStrategies(RepeatUnrollStrategy).V().repeat(__.both().limit(1)).times(2)'))
      .toEqual(vals('g.V().repeat(__.both().limit(1)).times(2)'));

    // The other half: a body upstream WOULD unroll is suppressed, and the `repeat` step survives
    // normalization. Pinned as the PROPERTY rather than through a downstream throw (there is none —
    // a movement body compiles either way), which is the lesson the named-repeat defect above taught.
    // Today `tryUnroll` also declines this body for a second reason (a barrier-free body buys no
    // capability, so the pass leaves it alone); when THAT guard goes, this assertion is what keeps the
    // suppression honest.
    const suppressed = marked('g.withoutStrategies(RepeatUnrollStrategy).V().repeat(__.out().has("name")).times(2)');
    expect(suppressed.map((s) => s.name)).toContain('repeat');
    expect(suppressed.find((s) => s.name === 'repeat')!.unrollSuppressed).toBe(true);
  });

  test('the mark reaches a repeat at EVERY depth — a source strategy is not a top-level fact', () => {
    // `withoutStrategies` configures the traversal SOURCE, so it holds inside a body too. A nested
    // body is normalized later and in isolation (`normalize` passes EMPTY_STRATEGY_USE by
    // construction), so a root-only consult would honour the request at the top level and ignore it
    // one level down — which is why the answer is a mark on the step rather than a flag read where
    // the pass runs.
    const repeatsOf = (steps: readonly any[]): any[] => steps.flatMap((s) => [
      ...(s.name === 'repeat' ? [s] : []),
      ...s.args.flatMap((a: any) => (a.value && Array.isArray(a.value.nested) ? repeatsOf(a.value.nested) : [])),
    ]);
    const tree = parseGremlin('g.withoutStrategies(RepeatUnrollStrategy).V().union(__.repeat(__.out()).times(2), __.both())');
    const nested = runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}, undefined, false).steps;
    const found = repeatsOf(nested);
    expect(found).toHaveLength(1);
    expect(found[0].unrollSuppressed).toBe(true);
    // An arg holding no repeat keeps its original PARSE TREE — the identity-preservation
    // `canonicalizeConnectives` had to measure (traversal-param un-parses a sub-traversal via
    // `tree.accept`, which an arg rewritten to Step[] no longer has).
    const union = nested.find((s) => s.name === 'union')!;
    expect(Array.isArray((union.args[1].value as any).nested)).toBe(false);
  });

});
