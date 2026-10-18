// `fold([], Operator.addAll)` IS the plain `fold()` at every depth: a per-traverser child folds into a
// FRESH copy of the seed per parent. Java's `ConstantSupplier` aliases one seed list across parents
// (GraphTraversal.java:1300) — object aliasing, not Gremlin semantics; the accepted divergence is
// recorded in docs/feature-support-matrix.md §17 ("Seeded fold per parent").
import { test, expect, describe } from 'bun:test';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { seededStore, run, bare } from '../support/harness.ts';

const s = seededStore();
const names = (g: string) => bare(run(s, g)).map((r: any) => r.v);

describe('a per-traverser seeded fold answers a fresh list per parent', () => {
  test('local(fold([], addAll)) equals local(fold())', () => {
    const seeded = bare(run(s, "g.V().hasLabel('person').local(__.out().values('name').fold([], Operator.addAll))"));
    const plain = bare(run(s, "g.V().hasLabel('person').local(__.out().values('name').fold())"));
    expect(seeded).toEqual(plain);
    expect(seeded.map((r: any) => JSON.parse(r.list).sort())).toEqual([['josh', 'lop', 'vadas'], [], ['lop', 'ripple'], ['lop']]);
  });
  test('where(size > 2) keeps marko', () => {
    expect(names("g.V().hasLabel('person').where(__.out().values('name').fold([], Operator.addAll).count(local).is(gt(2))).values('name')"))
      .toEqual(['marko']);
  });
  test('not(size < 2) keeps marko and josh', () => {
    expect(names("g.V().hasLabel('person').not(__.out().values('name').fold([], Operator.addAll).count(local).is(lt(2))).values('name')").sort())
      .toEqual(['josh', 'marko']);
  });
});

describe('a seed other than [] in a child position still declines', () => {
  for (const g of [
    "g.V().hasLabel('person').local(__.out().values('name').fold(['x'], Operator.addAll))",
    "g.V().hasLabel('person').local(__.out().group().by('name').fold([:], Operator.addAll).count(local))",
  ]) test(g, () => expect(() => compile(g, {})).toThrow(UnsupportedTraversal));
});

describe('a fold that runs once keeps answering', () => {
  test('root list identity', () => {
    expect(bare(run(s, "g.V().values('age').order().fold([], Operator.addAll)"))).toEqual([{ list: '[27,29,32,35]' }]);
  });
  test('root map seed', () => {
    expect(run(s, 'g.inject(["a":1],["b":2]).fold([:], Operator.addAll)')).toHaveLength(1);
  });
  test('an immutable seed per traverser', () => {
    expect(bare(run(s, "g.V().hasLabel('person').local(__.out().values('age').fold(0, Operator.sum))")).map((r: any) => r.v).sort())
      .toEqual([0, 0, 0, 59]);
  });
});
