import { describe, expect, test } from 'bun:test';
import { bagOf, bare, run, seededStore } from '../support/harness.ts';

// A WALK WITH AN `until` LANDS ITS ANSWER AS A COLUMN (`EXIT`, `src/compiler/rel/walk.ts`), AND THAT COLUMN IS NOT
// PAYLOAD. An `emit` condition over the finished walk is asked of the TRAVERSER (`traverserView`, `asked`), so a
// condition whose head lowers only as a correlated EXISTS — `local`, `union`, `coalesce`, `choose` — answers beside
// an `until` exactly as it does without one. Before, it saw `[id, wx]` as the subject's payload and declined.
//
// Hand-computed on the modern graph: marko→{lop, vadas, josh}, josh→{ripple, lop}, peter→lop; `until` stops at
// software (lop, ripple). The non-exiting rows past the first hop are vadas and josh (from marko). `in()` is
// non-empty for vadas, josh, lop, ripple; `in('created')` only for lop and ripple.
const store = seededStore();
const values = (q: string): unknown[] => bagOf((run(store, q) as any[]).map((row) => bare(row).v));
const EXITS = ['lop', 'lop', 'lop', 'lop', 'ripple', 'ripple'];

describe('until + emit(child traversal): the exit column is not payload', () => {
  test('emit(local(…)) at the root — exits plus the emitting non-exits', () => {
    expect(values("g.V().repeat(out()).until(hasLabel('software')).emit(local(in().limit(1))).values('name')"))
      .toEqual(bagOf([...EXITS, 'vadas', 'josh']));
  });

  test('emit(coalesce(…)) at the root — no non-exit has a creator, so the exits alone', () => {
    expect(values("g.V().repeat(out()).until(hasLabel('software')).emit(coalesce(in('created').has('age',gt(30)),out('nope'))).values('name')"))
      .toEqual(bagOf(EXITS));
  });

  test('emit(union(…)) under where — the starts with any leaving row', () => {
    expect(values("g.V().where(repeat(out()).until(hasLabel('software')).emit(union(in('created'),out('nope')))).values('name')"))
      .toEqual(bagOf(['marko', 'josh', 'peter']));
  });

  test('emit(choose(…)) under local — a two-armed-by-identity choose is always productive', () => {
    expect(values("g.V().local(repeat(out()).until(hasLabel('software')).emit(choose(in('created'),constant(1))).count())"))
      .toEqual(bagOf([5, 0, 0, 2, 0, 1]));
  });

  test('at depth: map(local(…)) of a walk, not(…) of a walk, emit(where(local(…)))', () => {
    expect(values("g.V().map(local(repeat(out()).until(hasLabel('software')).emit(coalesce(in('created'),out('nope'))).count()))"))
      .toEqual(bagOf([3, 0, 0, 2, 0, 1]));
    expect(values("g.V().not(repeat(out()).until(hasLabel('software')).emit(local(in().limit(1)).hasLabel('person'))).values('name')"))
      .toEqual(bagOf(['vadas', 'lop', 'ripple']));
    expect(values("g.V().repeat(out()).until(hasLabel('software')).emit(where(local(in().limit(1)))).values('name')"))
      .toEqual(bagOf([...EXITS, 'vadas', 'josh']));
  });

  test('answers as the same query without the until filtered to the same rows', () => {
    // With no `until` the walk runs on past software (which has no out-edges here), so the emitting rows are the
    // same set; the `until` adds the exits that emit's condition would also have admitted, so the two agree here.
    expect(values("g.V().repeat(out()).until(hasLabel('software')).emit(local(in().limit(1))).values('name')"))
      .toEqual(values("g.V().repeat(out()).emit(local(in().limit(1))).values('name')"));
  });
});
