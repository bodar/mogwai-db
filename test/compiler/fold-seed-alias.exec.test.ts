// A MUTABLE `fold(seed, Operator)` seed is ONE object across parent traversers in the reference —
// `GraphTraversal.fold(E2, BiFunction)` wraps the literal in a `ConstantSupplier`
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java:1300),
// `ReducingBarrierStep` re-fetches that same object after each per-parent reset
// (.../process/traversal/step/util/ReducingBarrierStep.java:88-111), and `Operator.addAll` mutates it
// (.../process/traversal/Operator.java:187-194). Every lowering folds into a fresh accumulator, so a
// per-traverser fold with a list/map seed must DECLINE at every depth (`perTraverserMutableFold`,
// `src/compiler/ir/fold-seed.ts`); only a fold that runs once — a step of the root chain — answers.
import { test, expect, describe } from 'bun:test';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { seededStore, run, bare } from '../support/harness.ts';

const declines = (g: string) => expect(() => compile(g, {})).toThrow(UnsupportedTraversal);

describe('a per-traverser fold with a mutable seed declines at every depth', () => {
  // Each answered a per-parent FRESH list (or a count of one) on trunk; the reference aliases.
  const perTraverser = [
    // the audit's two: a where() body (reference keeps all four persons: 3,3,5,6 > 2) and a local() body
    "g.V().hasLabel('person').where(__.out().values('name').fold([], Operator.addAll).count(local).is(gt(2))).values('name')",
    "g.V().hasLabel('person').local(__.out().values('name').fold([], Operator.addAll))",
    // the same body under every other per-traverser host
    "g.V().hasLabel('person').map(__.out().values('name').fold([], Operator.addAll))",
    "g.V().hasLabel('person').flatMap(__.out().values('name').fold([], Operator.addAll))",
    "g.V().hasLabel('person').project('a').by(__.out().values('name').fold([], Operator.addAll))",
    "g.V().hasLabel('person').as('p').select('p').by(__.out().values('name').fold([], Operator.addAll))",
    "g.V().hasLabel('person').not(__.out().values('name').fold([], Operator.addAll).count(local).is(lt(2))).values('name')",
    "g.V().hasLabel('person').choose(__.out().values('name').fold([], Operator.addAll).count(local).is(gt(2)), __.constant(1), __.constant(2))",
    "g.V().hasLabel('person').coalesce(__.out().values('name').fold([], Operator.addAll), __.constant(2))",
    "g.V().hasLabel('person').local(__.out().values('name').fold([], Operator.addAll).unfold())",
    "g.V().hasLabel('person').local(__.out().values('name').fold([], Operator.addAll).count(local))",
    "g.V().hasLabel('person').local(__.out().fold([], Operator.addAll))",
    "g.V().hasLabel('person').map(__.out().valueMap().fold([], Operator.addAll))",
    // nested: a union arm inside a per-traverser host, a fold of a fold, a two-hop where()
    "g.V().hasLabel('person').local(__.union(__.out().values('name').fold([], Operator.addAll), __.constant(1)))",
    "g.V().hasLabel('person').local(__.out().values('name').fold([], Operator.addAll).fold([], Operator.addAll))",
    "g.V().hasLabel('person').where(__.out().out().values('name').fold([], Operator.addAll).count(local).is(gt(0))).values('name')",
    // a non-empty list seed and a map seed, same rule
    "g.V().hasLabel('person').local(__.out().values('name').fold(['x'], Operator.addAll))",
    "g.V().hasLabel('person').local(__.out().group().by('name').fold([:], Operator.addAll).count(local))",
    // an infix and() moves the authored top-level fold into a per-traverser operand (ConnectiveStrategy)
    "g.V().hasLabel('person').values('name').fold([], Operator.addAll).count(local).is(gt(2)).and().count(local).is(gt(1))",
  ];
  for (const g of perTraverser) test(g, () => declines(g));
});

describe('a fold that runs once keeps answering', () => {
  const s = seededStore();
  test('root list identity', () => {
    expect(bare(run(s, "g.V().values('age').order().fold([], Operator.addAll)"))).toEqual([{ list: '[27,29,32,35]' }]);
  });
  test('root map seed', () => {
    expect(run(s, 'g.inject(["a":1],["b":2]).fold([:], Operator.addAll)')).toHaveLength(1);
  });
  test('an immutable seed is unaffected per traverser', () => {
    expect(bare(run(s, "g.V().hasLabel('person').local(__.out().values('age').fold(0, Operator.sum))")).map((r: any) => r.v))
      .toEqual([59, 0, 0, 0]);
  });
  test('plain fold() per traverser is unaffected', () => {
    expect(run(s, "g.V().hasLabel('person').local(__.out().values('name').fold())")).toHaveLength(4);
  });
});
