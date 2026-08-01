// `sliceOf` (src/compiler/ir/step.ts) — the ONE decode of `limit`/`skip`/`range`, and the seven
// fail-closed VIOLATIONS it retires (docs/outstanding-work.md item 27).
//
// The defect this file pins was not a missing feature but a missing SUBTRACTION: nine sites read a
// slice's row count as `Number(step.args[0])`, and `Scope.local` puts a scope TOKEN in that slot.
// `Number({scope:'local'})` is `NaN`, which SQLite binds as NULL, so the traversal reached execution
// and failed there (`no such column: NaN`) or, worse, rendered structurally broken SQL. Every case
// below therefore asserts on RUNNING the traversal, not on the compile: the old bug compiled fine.
//
// The reference semantics come from `RangeLocalStep.applyRange` in
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/RangeLocalStep.java:
// it slices a Map, an Iterable or an array and `return start` for everything else.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { sliceOf } from '../../src/compiler/ir/step.ts';
import { bagOf, run, seededStore } from '../support/harness.ts';

const step = (name: string, ...args: any[]) => ({ name, args } as any);
const LOCAL = { scope: 'local' };

describe('sliceOf — one decode of the three slice steps', () => {
  test('the scope token is not an argument', () => {
    expect(sliceOf(step('limit', 2))).toEqual({ scope: 'global', offset: 0, limit: 2 });
    expect(sliceOf(step('limit', LOCAL, 2))).toEqual({ scope: 'local', offset: 0, limit: 2 });
    expect(sliceOf(step('skip', 3))).toEqual({ scope: 'global', offset: 3, limit: null });
    expect(sliceOf(step('skip', LOCAL, 3))).toEqual({ scope: 'local', offset: 3, limit: null });
    expect(sliceOf(step('range', 1, 4))).toEqual({ scope: 'global', offset: 1, limit: 3 });
    expect(sliceOf(step('range', LOCAL, 1, 4))).toEqual({ scope: 'local', offset: 1, limit: 3 });
  });

  test('a negative high bound is "no upper bound", spelled null rather than -1', () => {
    // null, not -1, because the two consumers that COMPUTE with it (scopedSlice, partitionedSlice)
    // take offset+count and would read `offset + -1` as a real upper bound. SQL's `LIMIT -1` is a
    // rendering detail and lives in `limitOffset`.
    expect(sliceOf(step('range', 2, -1))).toEqual({ scope: 'global', offset: 2, limit: null });
  });

  test('an illegal range is rejected with TinkerPop\'s wording', () => {
    expect(() => sliceOf(step('range', 4, 1))).toThrow('Not a legal range: [4, 1]');
  });

  test('a non-slice step is a programming error, not a silent zero', () => {
    expect(() => sliceOf(step('tail', 2))).toThrow('tail() is not a slice step');
  });
});

describe('Scope.local slices no longer emit malformed SQL (item 27)', () => {
  const store = seededStore();
  const ids = (q: string) => run(store, q).map((r: any) => r.id);
  const all = ids('g.V()');
  // `all` is scan-ordered — `g.V()` fixes no order, so it is a multiset. The GLOBAL slices below
  // ARE ordered (a slice demands the source encounter since 2026-08-01, so it takes the id order
  // the reference iterates in), which is why their expectations are the sorted ids and not a
  // slice of `all`: comparing against `all` compared a determined answer with an undetermined one.
  const byId = [...all].sort((a: number, b: number) => a - b);

  test('on an ELEMENT stream a local slice is IDENTITY, per RangeLocalStep.applyRange', () => {
    // A vertex is not a Map, an Iterable or an array, so the reference returns it unchanged.
    // These three used to bind NaN and die with `no such column: NaN`.
    expect(bagOf(ids('g.V().limit(Scope.local,1)'))).toEqual(bagOf(all));
    expect(bagOf(ids('g.V().skip(Scope.local,1)'))).toEqual(bagOf(all));
    expect(bagOf(ids('g.V().range(Scope.local,0,1)'))).toEqual(bagOf(all));
    // …and mid-chain, where the slice is a prefix CTE rather than the last step. Compared by
    // COUNT, not by rows: the flat chain scans that gate movementCollapse key on the step NAME, so
    // a Scope.local limit still costs the collapse and the two plans differ in physical form (one
    // row with `bulk` 3 vs three rows) while denoting the same traverser multiset. Teaching those
    // scans that this one form is identity would need shape knowledge a flat scan does not have.
    expect(run(store, 'g.V().limit(Scope.local,1).out().count()')).toEqual(run(store, 'g.V().out().count()'));
    // The GLOBAL forms still slice rows — and now do it in the source's id order.
    expect(ids('g.V().limit(2)')).toEqual(byId.slice(0, 2));
    expect(ids('g.V().skip(2)')).toEqual(byId.slice(2));
    expect(ids('g.V().range(1,3)')).toEqual(byId.slice(1, 3));
  });

  test('on a VARIANT stream a local slice DECLINES to the fail-closed throw', () => {
    // A variant row can be a list, so slicing its members is a per-arm question no merge answers.
    // This tail used to carry the global slice WITHOUT the Scope.local guard — the omission that
    // made it the only shape to render `LIMIT NaN` from a spread-in row op.
    const base = "g.V().union(__.values('name'), __.out())";
    for (const s of ['limit(Scope.local,1)', 'skip(Scope.local,1)', 'range(Scope.local,0,1)'])
      expect(() => compile(`${base}.${s}`, {})).toThrow(`${s.split('(')[0]}() on a variant value not yet supported`);
    // the global row ops still lower — declining must not have shadowed them
    expect(run(store, `${base}.limit(2)`).length).toBe(2);
  });

  test('a RECORD sliced down to zero fields defers instead of rendering `SELECT  FROM`', () => {
    // The guard was `no fields AND no carried columns`, so a one-field project with a live `bulk`
    // column slipped past it into an empty column list. The reference answer is an empty map per
    // traverser, which needs a record shape that can carry zero fields.
    expect(() => run(store, "g.V().project('n').by('name').skip(Scope.local,1)"))
      .toThrow('skip(Scope.local) slicing a record down to zero fields not yet supported');
    // a slice that leaves at least one field is unaffected
    expect(run(store, "g.V().project('a','b').by('name').by('name').limit(Scope.local,1)").length).toBe(all.length);
  });
});
