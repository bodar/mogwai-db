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
// What this file therefore pins is the BOUNDARY, not the unroll: the bodies the reference does unroll
// already compile here, and the ones it refuses defer identically however the strategy is spelled.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { run, seededStore } from '../support/harness.ts';

const store = seededStore();
const vals = (q: string) => (run(store, q) as any[]).map((r) => r.v ?? r.id);

describe('the repeat() unroll boundary', () => {
  test("the bodies RepeatUnrollStrategy admits — movement and has() — already compile", () => {
    // ALLOWED_STEP_CLASSES exactly: a vertex step, an edge-vertex step, and has().
    expect(vals('g.V(1).repeat(__.out()).times(2)')).toEqual([3, 5]);
    expect(vals('g.V(1).repeat(__.outE().inV()).times(2)')).toEqual([3, 5]);
    expect(vals("g.V(1).repeat(__.out().has('name')).times(2)")).toEqual([3, 5]);
    // …so unrolling them would buy nothing. Every traversal item 3 counts is a BARRIER body, which is
    // the set the reference strategy refuses — that gap is the item, and it is not a free rewrite.
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
    // different question). If an unroll lands, THIS is the sentence it has to earn.
    for (const q of ['g.V().repeat(__.dedup()).times(2).count()', 'g.V().repeat(__.dedup().both()).times(2)']) {
      expect(() => compile(q, {})).toThrow('per-iteration GLOBAL barrier over the whole frontier');
      expect(() => compile(q, {})).toThrow('A fixed times(n) body could be unrolled instead (not built)');
    }
  });
});
