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
import { normalize } from '../../src/compiler/ir/passes.ts';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { bagOf, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const vals = (q: string) => (run(store, q) as any[]).map((r) => r.v ?? r.id);

describe('the repeat() unroll boundary', () => {
  test("the bodies RepeatUnrollStrategy admits — movement and has() — already compile", () => {
    // ALLOWED_STEP_CLASSES exactly: a vertex step, an edge-vertex step, and has().
    // repeat() is deliberately outside the emission-order substrate (analyze.ts returns false for
    // it), so these are multisets.
    expect(bagOf(vals('g.V(1).repeat(__.out()).times(2)'))).toEqual([3, 5]);
    expect(bagOf(vals('g.V(1).repeat(__.outE().inV()).times(2)'))).toEqual([3, 5]);
    expect(bagOf(vals("g.V(1).repeat(__.out().has('name')).times(2)"))).toEqual([3, 5]);
    // …so unrolling them would buy nothing. Every traversal item 3 counts is a BARRIER body, which is
    // the set the reference strategy refuses — that gap is the item, and it is not a free rewrite.
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

  /** §3.6's statement-text budget, which this pass is what multiplies: n copies of a body is n times
   *  the SQL and n×m for a nested repeat. Above the ceiling the pass declines and today's deferral
   *  stands, rather than handing downstream a chain that cannot ship to a Durable Object. */
  test('declines above the unrolled-size ceiling instead of multiplying without bound', () => {
    expect(() => compile('g.V().repeat(__.both().dedup()).times(49).count()', {})).not.toThrow();
    expect(() => compile('g.V().repeat(__.both().dedup()).times(51).count()', {}))
      .toThrow('per-iteration GLOBAL barrier over the whole frontier');
  });

  test('the run must be exactly repeat + times — emit, until and a named loop all decline', () => {
    // Each declines for its own reason: emit() publishes intermediate frontiers (so the result is not
    // n applications of the body), until() is a predicate rather than a count, and a named
    // repeat("a", …) carries a counter loops("a") can read. All three keep today's deferral.
    for (const q of [
      'g.V().repeat(__.dedup().both()).times(2).emit()',
      'g.V().emit().repeat(__.dedup().both()).times(2)',
      "g.V().repeat(__.dedup().both()).until(__.has('name','lop'))",
      // The NAMED loop, which this test's own name has always claimed and its list did not contain —
      // and that gap is exactly how the defect below survived.
      'g.V().repeat("a", __.dedup().both()).times(2)',
    ]) expect(() => compile(q, {})).toThrow();
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

  test('a barrier body defers, and identically however RepeatUnrollStrategy is spelled', () => {
    // `withStrategies(RepeatUnrollStrategy)` must not change an answer: the strategy would decline
    // this body (sample() is a Barrier, not in ALLOWED_STEP_CLASSES), so all three spellings are the
    // same traversal. Pinned because a future unroll that keys off the strategy token rather than off
    // its own equivalence argument would make exactly these three disagree.
    const bodies = [
      'g.V().repeat(__.both().sample(1)).times(2)',
      'g.withStrategies(RepeatUnrollStrategy).V().repeat(__.both().sample(1)).times(2)',
      'g.withoutStrategies(RepeatUnrollStrategy).V().repeat(__.both().sample(1)).times(2)',
    ];
    const messages = bodies.map((q) => {
      try { compile(q, {}); return 'COMPILED'; } catch (e: any) { return e.message; }
    });
    for (const m of messages) expect(m).toContain('sample() is a per-iteration GLOBAL barrier over the whole frontier');
    expect(new Set(messages).size).toBe(1);
  });

  test('the deferral names the per-iteration frontier, which is the reference reading', () => {
    // The wording is load-bearing: it is the claim RepeatStep.java:217 supports, and the reason the
    // generic StepFns cannot be handed the body (they would lower it per-ORIGIN, answering a
    // different question). Every barrier still on the far side of the line has to earn this sentence
    // before it moves — `dedup` earned it and is gone from this list.
    // `order()` has since crossed the line (see UNROLLABLE_BARRIERS) and is gone from this list, as
    // `dedup` was before it. What is left is what still has no argument: a reducer that changes the
    // stream's shape mid-body, and a sampler with no stable position at all.
    for (const q of [
      'g.V().repeat(__.groupCount().out()).times(2).count()',
      'g.V().repeat(__.both().sample(1)).times(2)',
    ]) {
      expect(() => compile(q, {})).toThrow('per-iteration GLOBAL barrier over the whole frontier');
      expect(() => compile(q, {})).toThrow('A fixed times(n) body could be unrolled instead (not built)');
    }
  });
});
