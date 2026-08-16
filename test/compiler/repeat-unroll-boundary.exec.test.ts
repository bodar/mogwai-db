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
// What this file pins is the BOUNDARY, which has since MOVED once: `dedup` is now unrolled
// (`UNROLLABLE_BARRIERS`, ir/strategies.ts) because its argument is airtight — a bare `dedup()` is a
// stateless collapse of the set it is handed, so n phase-local collapses and n per-iteration
// collapses agree row for row. Every other barrier is still on the far side, and the file's job is to
// keep the line visible rather than to bless a direction.
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
      ['g.V().repeat(__.dedup()).times(2).count()', 'g.V().dedup().dedup().count()'],
      ['g.V().repeat(__.dedup().both()).times(2).count()', 'g.V().dedup().both().dedup().both().count()'],
      ['g.V().repeat(__.both().dedup()).times(2).count()', 'g.V().both().dedup().both().dedup().count()'],
      ['g.V().repeat(__.dedup().both()).times(3).count()', 'g.V().dedup().both().dedup().both().dedup().both().count()'],
      ["g.V().repeat(__.both().dedup()).times(1).values('name')", "g.V().both().dedup().values('name')"],
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

  /**
   * THE STEP CEILING IS GONE, AND `times(51)` IS THE WITNESS.
   *
   * The pass used to refuse past 100 spliced steps — a step count standing in for the DO's 100 KB of
   * statement text, charging every body the worst measured per-step cost. A `both().dedup()` body is
   * two steps, so `times(51)` was 102 and fell to a route that cannot express a per-iteration barrier
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
      expect(() => compile(`g.V().repeat(__.both().dedup()).times(${n}).count()`, {})).not.toThrow();
    }
    // …and the multiplication is still LINEAR in n, so the text a body costs stays predictable.
    const bytes = (n: number): number => {
      const plan = compile(`g.V().repeat(__.both().dedup()).times(${n}).count()`, {});
      if (!('sql' in plan)) throw new Error('expected a read plan');
      return plan.sql.length;
    };
    const small = bytes(50);
    const large = bytes(200);
    expect(large).toBeGreaterThan(small * 3);
    expect(large).toBeLessThan(small * 5);
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
      'g.V().emit().repeat(__.dedup()).times(2)',
    ]) expect(() => compile(q, {})).not.toThrow();
    // emit(pred) — a predicate emit — is NOT a union of prefixes; it declines to the walk / a refusal.
    expect(() => compile('g.V().repeat(__.out()).emit(__.has("name","x")).times(2)', {})).toThrow();
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
    expect(rolled('g.V().repeat("a", __.out().dedup()).times(2)')).toContain('repeat');
    // …and the unnamed form still unrolls, so the guard is about the NAME and nothing else.
    expect(rolled('g.V().repeat(__.out().dedup()).times(2)')).not.toContain('repeat');
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
