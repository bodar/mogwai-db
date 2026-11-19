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
import { bagOf, bare, grouped, runWith, seededStore } from '../support/harness.ts';

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

// P1 (one effect vocabulary): the trim's impurity guard asks the SAME effect predicate `dropEffectFreeSideEffect`
// asks (`stepHasEffect`, src/compiler/ir/step.ts). Its old private list missed addLabel/dropLabel(s) and keyed
// tree('t'), so `where(addLabel('x').count())` trimmed to `where(identity())`: every vertex answered, and the write
// silently never ran. Now the trim keeps the write and the filter declines, naming it.
describe('an effect in an existence body is never trimmed away', () => {
  const declined = (q: string, options?: object): string => {
    try { runWith(seededStore(), q, options as never); } catch (error) { return (error as Error).message; }
    throw new Error(`answered: ${q}`);
  };
  test('the trim stops at every effect the sideEffect() rewrite counts', () => {
    expect(bodyAfterPasses("g.V().where(addLabel('x').count())", 'where')).toEqual(['addLabel', 'count']);
    expect(bodyAfterPasses("g.V().where(out().dropLabel('person').count())", 'where')).toEqual(['out', 'dropLabel', 'count']);
    expect(bodyAfterPasses("g.V().where(dropLabels().count())", 'where')).toEqual(['dropLabels', 'count']);
    expect(bodyAfterPasses("g.V().where(tree('t').count())", 'where')).toEqual(['tree', 'count']);
    expect(bodyAfterPasses("g.V().where(sack(sum).by('age').count())", 'where')).toEqual(['sack', 'by', 'count']);
    // A pure reducer body still trims: bare group()/tree() are reducers, not side effects.
    expect(bodyAfterPasses("g.V().where(group().by('name').count())", 'where')).toEqual([]);
    expect(bodyAfterPasses("g.V().where(out().tree().count())", 'where')).toEqual([]);
  });
  test('a write in a filter body declines, naming the write and the filter — at every filter host and depth', () => {
    for (const [q, write, host] of [
      ["g.V().where(__.addLabel('x').count())", 'addLabel', 'where'],
      ["g.V().where(__.out().addLabel('w').count()).count()", 'addLabel', 'where'],
      ["g.V().where(__.dropLabels().count())", 'dropLabels', 'where'],
      ["g.V().filter(__.addLabel('x').count())", 'addLabel', 'filter'],
      ["g.V().not(__.dropLabel('person').count())", 'dropLabel', 'not'],
      ["g.V().and(__.out(), __.out().property('x', 1))", 'property', 'and'],
      ["g.V().local(__.where(__.addLabel('x').count()))", 'addLabel', 'where'],
      ["g.V().union(__.where(__.map(__.addLabel('x')).count()))", 'addLabel', 'where'],
      ["g.V().where(__.where(__.out().drop()).count())", 'drop', 'where'],
    ] as const) {
      for (const options of [undefined, CONNECTOR_ONLY, LADDER_FIRST])
        expect(declined(q, options), q).toContain(`a write (${write}()) inside ${host}()`);
    }
  });
  test('nothing is written by a declined filter', () => {
    const graph = seededStore();
    expect(() => runWith(graph, "g.V().where(__.addLabel('x').count())")).toThrow();
    expect(bare(runWith(graph, "g.V().hasLabel('x').count()"))).toEqual([{ v: 0 }]);
  });
  test('a keyed collector in a filter body is no longer trimmed away; a pure reducer still answers', () => {
    expect(declined("g.V().where(__.tree('t').count())")).toContain('not supported');
    expect(agreed("g.V().where(__.group().by('name').count()).count()")).toEqual(['6']);
  });
});

// M4: a write in ANY child body is named in the user's terms, by the one builder (`writeInChild`,
// src/compiler/unsupported.ts) at the one site that sees every child with its host — the program's write summary
// (`programWrites`, src/compiler/rel/write.ts). A filter host keeps the terminal write-in-filter wording (above).
// The ADVICE follows the write's SHAPE, classified once where the write is found: an addV()/addE() in a branch body
// is the UPSERT idiom, pointed at mergeV()/mergeE(), which we support; a property()/drop() (or a merge, already an
// upsert) is told to move the write out. The hint is given only where the fold declined AT the write's top-level
// host (`noteChildWrite`, src/compiler/rel/lower.ts); where that is not known — the host never reached a lowering of
// its own (`sideEffect`, a write's own argument) — it says the write MAY be why. Both are hints after "no lowering
// covers …", never a decline of their own.
describe('a write in a non-filter child body declines, naming the write, the host and the likely intent', () => {
  const declined = (q: string, options?: object): string => {
    try { runWith(seededStore(), q, options as never); } catch (error) { return (error as Error).message; }
    throw new Error(`answered: ${q}`);
  };
  const UPSERT = 'for an upsert (fold().coalesce(unfold(), addV(…))) use mergeV()/mergeE()';
  const OUTER = 'put the write in the outer traversal';
  const SURE = 'is not supported yet', MAYBE = 'may not be supported here';
  for (const [q, write, host, advice, certainty] of [
    // one case per write kind
    ["g.V().has('name','zz').fold().coalesce(unfold(), addV('person').property('name','zz'))", 'addV', 'coalesce', UPSERT, SURE],
    ["g.V().has('name','marko').coalesce(outE('knows').has('weight',0.5), addE('knows').to(V(2)))", 'addE', 'coalesce', UPSERT, SURE],
    ["g.V().local(property('x', 1))", 'property', 'local', OUTER, SURE],
    ['g.V().sideEffect(drop())', 'drop', 'sideEffect', OUTER, SURE], // R6: sideEffect() is a CONNECTORS host, so the fold declines AT it
    ["g.V().local(mergeV([name: 'zz']))", 'mergeV', 'local', OUTER, SURE],
    ["g.V().optional(addV('x'))", 'addV', 'optional', UPSERT, SURE],
    ["g.V().group().by(addV('x'))", 'addV', 'group().by', OUTER, SURE],
    // the advice is the write's shape, not the host's family: a property() write in a branch is no upsert
    ["g.V().has('person','name','marko').choose(has('age',gt(20)), property('adult',true), property('adult',false))", 'property', 'choose', OUTER, SURE],
    ["g.V().union(addV('x'), identity()).count()", 'addV', 'union', UPSERT, SURE],
    // at depth: the innermost host is the one named
    ["g.V().local(coalesce(out(), addV('x')))", 'addV', 'coalesce', UPSERT, SURE],
    ["g.V().union(local(sideEffect(drop())), identity())", 'drop', 'sideEffect', OUTER, SURE],
    ["g.V().local(union(addV('x'), identity()).count())", 'addV', 'union', UPSERT, SURE],
    ["g.V().map(union(addV('x'), identity()).fold())", 'addV', 'union', UPSERT, SURE],
    ["g.V().addE('x').to(coalesce(V(1), addV('y')))", 'addV', 'coalesce', UPSERT, MAYBE],
    // a DISCARD arm: the host declines itself even though a stream (of nothing) was handed past it
    ["g.V().hasLabel('software').union(drop())", 'drop', 'union', OUTER, SURE],
    ["g.V().union(drop()).count()", 'drop', 'union', OUTER, SURE],
    ["g.V().local(union(drop())).count()", 'drop', 'union', OUTER, SURE],
    // a body that both collects and writes declines for the WRITE, not for the collection
    ["g.V().sideEffect(out().aggregate('x').property('k',1)).cap('x')", 'property', 'sideEffect', OUTER, SURE],
    // the host that is not a connector site records nothing, so the hint says the write MAY be why
    ["g.V().repeat(out().drop()).times(2)", 'drop', 'repeat', OUTER, MAYBE],
  ] as const) {
    test(q, () => {
      for (const options of [undefined, CONNECTOR_ONLY, LADDER_FIRST]) {
        const message = declined(q, options);
        expect(message, q).toContain('no lowering covers');
        expect(message, q).toContain(`a write (${write}()) inside ${host}() ${certainty}; ${advice}`);
      }
    });
  }
  // A child write that lowers fine is not blamed for a decline elsewhere: the hint is only where the fold declined
  // AT the write's host. Here the write's own lowering declines on a framing fact — the traverser's path is tracked
  // (the simplePath() in the later local()) — and that is what the user reads, from the write itself.
  test('a write is blamed for the fact that declined it, not for its host', () => {
    for (const options of [undefined, CONNECTOR_ONLY, LADDER_FIRST]) {
      const message = declined("g.V().hasLabel('software').union(addV('x')).local(V().simplePath().count())", options);
      expect(message).not.toContain('inside union()');
      expect(message).toContain('a write (addV()) on a traverser whose path is tracked');
      expect(declined("g.V().addV('x').path()", options)).toContain('a write (addV()) on a traverser whose path is tracked');
    }
  });
  test('a write whose host lowered is not blamed for a decline after it, or before it', () => {
    for (const options of [undefined, CONNECTOR_ONLY, LADDER_FIRST])
      for (const q of [
        "g.V().has('person','name','marko').union(addV('x')).valueMap().unfold().unfold()",
        "g.V().valueMap().unfold().unfold().union(addV('x'))",
      ]) {
        const message = declined(q, options);
        expect(message, q).toContain('no lowering covers');
        expect(message, q).not.toContain('a write');
      }
  });
  // A keyed group() whose value by() POOLS registers the pool's MEMBERS, so a child body's site is keyed per host
  // row like any collector's and the one reduction runs at the cap (`PoolRecipe`, src/compiler/rel/collection.ts).
  // Every switch position answers the same, nested hosts included.
  for (const [q, expected] of [
    ["g.V().sideEffect(out().group('x').by('name').by(count())).cap('x')", { josh: 1, lop: 3, ripple: 1, vadas: 1 }],
    ["g.V().local(out().group('x').by('name').by(count())).cap('x')", { josh: 1, lop: 3, ripple: 1, vadas: 1 }],
    ["g.V().sideEffect(local(out().group('x').by('name').by(count()))).cap('x')", { josh: 1, lop: 3, ripple: 1, vadas: 1 }],
    // the seed per key: lop's three members reach nothing, and fold() over an empty pool is []
    ["g.V().optional(out().group('x').by('name').by(out().values('name').fold())).cap('x')",
      { josh: ['lop', 'ripple'], lop: [], ripple: [], vadas: [] }],
    // a bare fold() is the traverser-collect, not a pool
    ["g.V().sideEffect(out().group('x').by('name').by(values('name').fold())).cap('x')",
      { josh: ['josh'], lop: ['lop', 'lop', 'lop'], ripple: ['ripple'], vadas: ['vadas'] }],
  ] as const) {
    test(`a keyed group() with a reducing value by() in a child body answers: ${q}`, () => {
      const sorted = (map: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]));
      const ours = sorted(grouped(runWith(seededStore(), q)));
      expect(ours).toEqual(expected as Record<string, unknown>);
      expect(sorted(grouped(runWith(seededStore(), q, LADDER_FIRST as never)))).toEqual(ours);
      expect(sorted(grouped(runWith(seededStore(), q, CONNECTOR_ONLY as never)))).toEqual(ours);
    });
  }
  // A pool whose reduction can RAISE (a `sum()`'s narrowing overflow) is evaluated where it is collected, so its
  // drain is the finished map (`takeFinishedMap`) — one map per body, which cannot key per host row. ONE raiser
  // (`keyedBody`) reading ONE carrier (the body's fork, `refuseSite`): the same explanation under every switch.
  test("a keyed group() whose pooled value can raise names the collection and why, in a child body", () => {
    const q = "g.V().sideEffect(out().group('x').by('name').by(values('age').sum())).cap('x')";
    const message = declined(q);
    expect(message).toContain("a side effect ('x') collected inside sideEffect() is not supported in this form yet");
    expect(message).toContain('a group() value by() that reduces or folds, here sum()');
    expect(declined(q, LADDER_FIRST)).toBe(message);
    expect(declined(q, CONNECTOR_ONLY)).toBe(message);
  });
  test('a write that lowers inside its host answers, with no hint', () => {
    expect(bare(runWith(seededStore(), "g.V().has('person','name','marko').union(addV('x')).count()"))).toEqual([{ v: 1 }]);
  });
  test('nothing is written by a declined child write', () => {
    const graph = seededStore();
    expect(() => runWith(graph, "g.V().local(addV('x'))")).toThrow();
    expect(bare(runWith(graph, "g.V().hasLabel('x').count()"))).toEqual([{ v: 0 }]);
  });
  test('a child write that lowers is untouched by the hint', () => {
    expect(bare(runWith(seededStore(), "g.V().hasLabel('software').union(addV('x')).label()"))).toEqual([{ v: 'x' }, { v: 'x' }]);
  });
});
