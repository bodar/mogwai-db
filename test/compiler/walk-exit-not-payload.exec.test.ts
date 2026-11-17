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

  // A CONDITION SEES THE TRAVERSER'S LABELS. A condition traverser is a split of the walk's and carries its path
  // (`B_O_S_SE_SL_Traverser.split`, vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/B_O_S_SE_SL_Traverser.java),
  // so the walk hands its alias map to every condition. Asked without it, a label bound INSIDE the condition minted
  // the column an outer label already held and a bare `channel column 'a0' is already carried` reached the user.
  // Each is checked against the same query with the inner label dropped: on the modern graph no vertex is its own
  // neighbour, so `as('b').in().where(neq('b'))` ≡ `in()` and `as('x').out().where(eq('x'))` never holds.
  test('an outer label beside a label bound inside the condition', () => {
    const same = (q: string, plain: string) => expect(bagOf(run(store, q) as any[])).toEqual(bagOf(run(store, plain) as any[]));
    same("g.V().as('a').repeat(out()).until(hasLabel('software')).emit(as('b').in().where(neq('b'))).path()",
      "g.V().as('a').repeat(out()).until(hasLabel('software')).emit(in()).path()");
    same("g.V().as('s').repeat(out()).until(hasLabel('software')).emit(as('x').out()).select('s')",
      "g.V().as('s').repeat(out()).until(hasLabel('software')).emit(out()).select('s')");
    same("g.V().as('a').repeat(out()).until(hasLabel('software')).emit(as('b').where('a',neq('b'))).path()",
      "g.V().as('a').repeat(out()).until(hasLabel('software')).emit(where(neq('a'))).path()");
    same("g.V().as('s').repeat(out()).emit(as('x').out()).path()", "g.V().as('s').repeat(out()).emit(out()).path()");
    same("g.V().as('a').repeat(out()).until(hasLabel('software')).emit(as('a').in()).select(all,'a')",
      "g.V().as('a').repeat(out()).until(hasLabel('software')).emit(in()).select(all,'a')");
    expect(values("g.V().as('s').repeat(both().simplePath()).until(loops().is(3)).emit(as('x').out().where(eq('x'))).count()"))
      .toEqual(values("g.V().as('s').repeat(both().simplePath()).until(loops().is(3)).count()"));
    // The outer label read inside the condition: marko's walk emits vadas, josh and the exits; josh is not marko.
    expect(values("g.V().as('s').where(repeat(out()).until(hasLabel('software')).emit(as('x').where('s',neq('x')).in('created'))).values('name')"))
      .toEqual(bagOf(['marko', 'josh', 'peter']));
    expect(values("g.V().as('s').local(repeat(out()).until(hasLabel('software')).emit(as('x').local(in().limit(1))).select('s').count())"))
      .toEqual(bagOf([5, 0, 0, 2, 0, 1]));
  });

  test('a label the condition binds over a column it is not told about declines cleanly, never an internal error', () => {
    // `until(…)` inside the recursive term: a filter over an unbounded neighbourhood is refused there (per-row
    // work, `correlatedExistence`) — with or without the outer label, the same clean refusal.
    for (const q of ["g.V().as('a').repeat(out()).until(as('b').in().where(neq('b'))).path()",
      "g.V().repeat(out()).until(as('b').in().where(neq('b'))).path()"])
      expect(() => run(store, q)).toThrow(/not supported/);
  });

  test('answers as the same query without the until filtered to the same rows', () => {
    // With no `until` the walk runs on past software (which has no out-edges here), so the emitting rows are the
    // same set; the `until` adds the exits that emit's condition would also have admitted, so the two agree here.
    expect(values("g.V().repeat(out()).until(hasLabel('software')).emit(local(in().limit(1))).values('name')"))
      .toEqual(values("g.V().repeat(out()).emit(local(in().limit(1))).values('name')"));
  });
});
