// R3 (docs/2026-11-16-ladder-retirement-plan.md): an existence check asks only its body's EXISTENCE PREFIX — the
// body up to its last step that can drop a row (`existencePrefix`, src/compiler/ir/productivity.ts) — through ONE
// authority with two consumers: the `trimExistenceSuffix` Pass (a TRUE existence position is rewritten) and
// `childPredicate` (a `coalesce` arm's emptiness, whose value is still used). And the alias compare
// `where(k, P).by(<traversal>)` is a connector row (`aliasCompare`, src/compiler/rel/lower/scoped.ts), so the
// existence family is LADDERLESS.
import { test, expect, describe } from 'bun:test';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { isNested, parseGremlin, stepChain, type Step } from '../../src/gremlin/frontend.ts';
import { runPasses, EMPTY_STRATEGY_USE } from '../../src/compiler/ir/passes.ts';
import { existencePrefix } from '../../src/compiler/ir/productivity.ts';
import { bagOf, bare, runWith, seededStore } from '../support/harness.ts';

const store = seededStore();
const CONNECTOR_ONLY = { fastPaths: { connectorOnly: true } } as const;
const LADDER_FIRST = { fastPaths: { correlatedChild: true } } as const;
/** The answer as a multiset of plain values (an id for an element row). */
const answer = (q: string, options?: object): string[] => bagOf(bare(runWith(store, q, options as never)).map((r: any) => JSON.stringify(r.v ?? r.id ?? r.map ?? r)));
/** Every switch position answers the same. */
const agreed = (q: string) => {
  const ours = answer(q);
  expect(answer(q, CONNECTOR_ONLY)).toEqual(ours);
  expect(answer(q, LADDER_FIRST)).toEqual(ours);
  return ours;
};

/** The step names of a chain's normalized first nested argument at `host`. */
const bodyAfterPasses = (g: string, host: string): string[] => {
  const steps = runPasses(stepChain(parseGremlin(g), NO_PARAMS), EMPTY_STRATEGY_USE, NO_PARAMS).steps as Step[];
  const at = steps.find((s) => s.name === host);
  const nested = at?.args.find((a) => isNested(a.value))?.value;
  return nested && isNested(nested) ? stepChain(nested.nested, NO_PARAMS).map((s) => s.name) : [];
};

describe('the existence prefix — the authority', () => {
  const prefix = (body: string) => {
    const p = existencePrefix(stepChain(parseGremlin(`g.inject(0).${body}`), NO_PARAMS).slice(1), NO_PARAMS);
    return p && p.map((s) => s.name);
  };
  test('trims what cannot empty a non-empty stream', () => {
    expect(prefix("out().project('a').by(path())")).toEqual(['out']);
    expect(prefix('out().sample(1)')).toEqual(['out']);
    expect(prefix('out().limit(2).range(0, 1).tail(1).id()')).toEqual(['out']);
    expect(prefix("out().valueMap().constant(1).label()")).toEqual(['out']);
    expect(prefix('constant(1)')).toEqual([]);
  });
  test('stops at a step that may drop the row', () => {
    for (const body of ["out().select('a')", "out().dedup().by('name')", "out().order().by('age')", 'out().limit(0)',
      'out().range(1, 3)', "out().sample(1).by('weight')", "out().path().by('name')", 'out().sum()', "out().values('age')"])
      expect(prefix(body), body).toBeNull();
  });
  test('stops at an impure step — an as(), a side effect, a step that may raise, at any depth', () => {
    for (const body of ["out().as('a')", "out().project('a').by(__.as('x'))", "out().project('a').by(__.aggregate('x'))",
      "out().project('a').by(__.values('name').toUpper())"])
      expect(prefix(body), body).toBeNull();
  });
});

describe('the Pass rewrites only TRUE existence positions', () => {
  test('where/filter/not, and/or arms, choose\'s predicate, repeat\'s until', () => {
    expect(bodyAfterPasses("g.V().where(out().project('a').by(path()))", 'where')).toEqual(['out']);
    expect(bodyAfterPasses("g.V().not(out().sample(1))", 'not')).toEqual(['out']);
    expect(bodyAfterPasses("g.V().or(out().limit(1), in())", 'or')).toEqual(['out']);
    expect(bodyAfterPasses("g.V().choose(out().constant(1), constant('a'), constant('b'))", 'choose')).toEqual(['out']);
  });
  test('never a value position, never past an as()', () => {
    expect(bodyAfterPasses("g.V().where(out().as('a'))", 'where')).toEqual(['out', 'as']);
    expect(bodyAfterPasses("g.V().coalesce(out().constant(1), constant(2))", 'coalesce')).toEqual(['out', 'constant']);
    expect(bodyAfterPasses("g.V().map(out().limit(1))", 'map')).toEqual(['out', 'limit']);
  });
});

describe('answers', () => {
  test('the witnesses', () => {
    expect(agreed("g.V().where(out().sample(1)).values('name')")).toEqual(bagOf(['"marko"', '"josh"', '"peter"']));
    expect(agreed("g.V().not(has('age',lt(1)).project('a','b').by(identity()).by(cyclicPath().hasId(4))).count()")).toEqual(['6']);
    expect(agreed("g.V().where(project('b').by(path())).count()")).toEqual(['6']);
    expect(agreed("g.V().where(out().as('a')).values('name')")).toEqual(bagOf(['"marko"', '"josh"', '"peter"']));
  });
  test('at depth: inside local/map, a union arm, a where of a where, choose\'s predicate', () => {
    expect(agreed("g.V().local(where(out().project('x').by(path()))).count()")).toEqual(['3']);
    expect(agreed('g.V().union(where(out().limit(2)), identity()).count()')).toEqual(['9']);
    expect(agreed("g.V().where(where(out().sample(1)).constant(1)).count()")).toEqual(['3']);
    expect(agreed("g.V().map(filter(identity())).count()")).toEqual(['6']);
    expect(agreed("g.V().choose(out().project('x').by(path()), constant('a'), constant('b'))"))
      .toEqual(bagOf(['"a"', '"a"', '"a"', '"b"', '"b"', '"b"']));
  });
  test('a coalesce arm asks its prefix for emptiness and still answers its value (the GraphQL union shape)', () => {
    const q = "g.V().coalesce(hasLabel('person').project('a').by(values('name')), hasLabel('software').project('a').by(values('lang')))";
    expect(agreed(q)).toHaveLength(6);
    expect(answer(q).filter((m) => m.includes('java'))).toHaveLength(2);
  });
  test('an identity by() is a bare by(), over any stream', () =>
    expect(agreed('g.V().label().fold().order(local).dedup().by(__.identity()).count()')).toEqual(['1']));
});

describe('the alias compare by() a traversal is a connector row', () => {
  test('the connector alone answers it', () => {
    expect(agreed("g.V().as('a').out().as('b').where('a', gt('b')).by(out().count()).values('name')"))
      .toEqual(bagOf(['"vadas"', '"josh"', '"lop"', '"lop"', '"ripple"', '"lop"']));
    expect(agreed("g.V().as('a').out('created').as('b').in('created').as('c').both('knows').as('d').where('a', P.lt('b').or(P.gt('c')).and(P.neq('d'))).by('age').by('weight').by(__.in('created').values('age').min()).select('a','b','c','d').by('name')"))
      .toEqual([]);
  });
  test('a by() body no correlated value holds is LANDED as a join column, per operand', () => {
    // marko's first out-name is josh, josh's is lop: only (marko, josh) has both.
    expect(agreed("g.V().as('a').out().as('b').where('a', neq('b')).by(out().order().by('name').values('name').limit(1)).values('name')"))
      .toEqual(['"josh"']);
    // The bare form: the current traverser is the start operand.
    expect(agreed("g.V().as('a').out().as('b').where(lt('a')).by(both().order().by('name').values('name').limit(1)).values('name')"))
      .toEqual(bagOf(['"lop"', '"ripple"', '"lop"']));
  });
  test('a label unbound on a row drops it', () =>
    expect(agreed("g.V().as('a').optional(out().as('b')).where('a', neq('b')).by(out().count()).values('name')"))
      .toEqual(bagOf(['"vadas"', '"josh"', '"lop"', '"lop"', '"ripple"', '"lop"'])));
});
