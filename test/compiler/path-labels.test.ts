// The MAY-direction path-label helper (src/compiler/ir/labels.ts `pathLabelsAt`) and the barrier
// partition it clears on. `consumesPath` is a POSITIVE list — a may-analysis is unsafe in the clearing
// direction — so the partition test below is what stops a new `GLOBAL_BARRIER_STEPS` name from silently
// being neither: it must be classified as passing the traverser, consuming the path, or per-traverser.
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain, type Step } from '../../src/gremlin/frontend.ts';
import { GLOBAL_BARRIER_STEPS } from '../../src/compiler/ir/step.ts';
import { consumesPath, passesTraverser, pathLabelsAt } from '../../src/compiler/ir/labels.ts';

const chain = (gremlin: string): Step[] => stepChain(parseGremlin(gremlin), NO_PARAMS);
/** The LAST step of `g.V().<step>` — the parser takes a whole traversal, never a bare `__` step. */
const one = (step: string): Step => chain(`g.V().${step}`).at(-1)!;
const held = (gremlin: string): string[] => {
  const steps = chain(gremlin);
  const at = pathLabelsAt(steps, steps.length, NO_PARAMS);
  expect(at.all).toBe(false);
  return [...at.labels].sort();
};

describe('barrier partition', () => {
  // `local` is the one per-traverser name: `LocalStep` runs its body per traverser and keeps the outer path.
  const PER_TRAVERSER = new Set(['local']);
  test('every global barrier name passes the traverser, consumes the path, or is per-traverser', () => {
    for (const name of GLOBAL_BARRIER_STEPS) {
      const bare = { name, args: [] } as unknown as Step;
      const classes = [passesTraverser(bare), consumesPath(bare), PER_TRAVERSER.has(name)].filter(Boolean).length;
      expect({ name, classes }).toEqual({ name, classes: 1 });
    }
  });
  test('a KEYED side-effect writer passes the traverser; the unkeyed reducer consumes', () => {
    for (const q of ["group('k')", "groupCount('k')", "tree('k')"]) {
      const s = one(q);
      expect([q, passesTraverser(s), consumesPath(s)]).toEqual([q, true, false]);
    }
    for (const q of ['group()', 'groupCount()', 'tree()', 'fold()', 'count()', "cap('k')"]) {
      const s = one(q);
      expect([q, passesTraverser(s), consumesPath(s)]).toEqual([q, false, true]);
    }
  });
  test('a Scope.local reducer is a map over one value — it does not consume the path', () => {
    expect(consumesPath(one('count(Scope.local)'))).toBe(false);
  });
});

describe('pathLabelsAt', () => {
  test('a path-passing barrier keeps the labels bound before it', () => {
    for (const b of ['order()', "aggregate('q')", 'limit(2)', 'dedup()', 'barrier()', "group('k')"])
      expect([b, held(`g.V().as('a').out().${b}`)]).toEqual([b, ['a']]);
  });
  test('a top-level path-consuming barrier clears, and a later bind survives it', () => {
    expect(held("g.V().as('a').out().count()")).toEqual([]);
    expect(held("g.V().as('a').out().fold().as('b')")).toEqual(['b']);
  });
  test('a NESTED barrier does not replace the outer traverser', () => {
    expect(held("g.V().as('a').local(__.out().count())")).toEqual(['a']);
    expect(held("g.V().as('a').where(__.out().count().is(2))")).toEqual(['a']);
  });
  test('a bind at ANY depth may be on the path (over-approximate)', () => {
    expect(held("g.V().union(__.out().as('x'), __.in())")).toEqual(['x']);
    expect(held("g.V().match(__.as('x').out().as('y'))")).toEqual(['x', 'y']);
  });
  test('only binds before the index count', () => {
    const steps = chain("g.V().as('a').out().as('b')");
    expect([...pathLabelsAt(steps, 2, NO_PARAMS).labels]).toEqual(['a']);
  });
});
