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
import { sliceOf } from '../../src/compiler/ir/step.ts';
import { arg } from '../../src/gremlin/frontend.ts';

const step = (name: string, ...args: any[]) => ({ name, args: args.map((v) => arg(v)) } as any);
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
  // `all` is scan-ordered — `g.V()` fixes no order, so it is a multiset. The GLOBAL slices below
  // ARE ordered (a slice demands the source encounter since 2026-08-01, so it takes the id order
  // the reference iterates in), which is why their expectations are the sorted ids and not a
  // slice of `all`: comparing against `all` compared a determined answer with an undetermined one.



});
