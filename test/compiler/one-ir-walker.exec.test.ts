// ONE IR WALKER, and the declines and fixes that ride on it (`src/compiler/ir/walk.ts`).
//
// Every whole-tree question the compiler asks — "is there a write anywhere?", "a random draw?", "which
// labels are read?", "a barrier?" — used to enumerate a step's child positions privately, and each copy
// missed a different one (`someStepDeep` saw only `args`, so a write inside `order().by(…)` was invisible
// to the ranked-order head and leaked a `RelIR: Ref …` internal error). This file pins the walker's
// totality and each defect it closed, plus three neighbours found beside it: a scope read in a child
// re-rooted without its host's alias channels, path entries a read keeps, and two internal errors.
import { describe, expect, test } from 'bun:test';
import { compilePlan, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { arg, type Step } from '../../src/gremlin/frontend.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { eachChainDeep, someStepDeep } from '../../src/compiler/ir/walk.ts';
import { bagOf, seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const framed = (q: string) => decodeAll(executeFramed(seededStore(), q).map((f) => f.buf));
const ids = async (q: string) => (await framed(q)).map((v: any) => (Array.isArray(v) ? v.map((x: any) => x.id) : v.id));
const declines = (q: string) => expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);

describe('someStepDeep is TOTAL over every child position', () => {
  const write: Step = { name: 'addV', args: [arg('x')] } as Step;
  const nested = { nested: [write] };
  const host = (extra: Partial<IRStep>): IRStep[] => [{ name: 'identity', args: [], ...extra } as IRStep];
  const writes = (steps: Step[]) => someStepDeep(steps, {}, (s) => s.name === 'addV');

  test.each([
    ['an argument', host({ args: [arg(nested)] })],
    ['a predicate operand', host({ name: 'has', args: [arg('k'), arg({ op: 'eq', operands: [arg(nested)] } as any)] })],
    ['a list member', host({ args: [arg([1, nested] as any)] })],
    ['a map KEY', host({ args: [arg(new Map([[nested, 1]]) as any)] })],
    ['a map value', host({ args: [arg(new Map([['k', nested]]) as any)] })],
    ['a set member', host({ args: [arg(new Set([nested]) as any)] })],
    ['a by() modulator', host({ name: 'order', modulators: [[nested]] })],
    ['a with() option', host({ name: 'call', withArgs: [['k', nested]] })],
    ['a repeat region', host({ name: 'repeat', repeatRegion: [write] })],
    ['a choose() option arm', host({ name: 'choose', optionArms: [write] })],
  ])('sees a write in %s', (_, steps) => expect(writes(steps)).toBe(true));

  test('a body it cannot read answers the caller\'s fail-closed choice', () => {
    const unreadable = host({ args: [arg(nested)] });
    expect(someStepDeep(unreadable, () => null, () => false, true)).toBe(true);
    expect(someStepDeep(unreadable, () => null, () => false, false)).toBe(false);
  });

  // Which positions a walk enters is the CALLER's choice: federate's injection rewrite edits a pushed
  // step's own source text, which no folded by()/with()/cluster is part of, so that question walks
  // `'arguments'` only (and a `select()` anywhere else stays a label READ, so the step stays local).
  test('`arguments` positions see the arguments and nothing folded onto the step', () => {
    const seen = (s: IRStep[]) => {
      let n = 0;
      eachChainDeep(s, (b) => b as readonly Step[], (c) => { if (c.some((x) => x.name === 'addV')) n++; }, () => {}, 'arguments');
      return n > 0;
    };
    expect(seen(host({ args: [arg({ op: 'eq', operands: [arg(nested)] } as any)] }))).toBe(true);
    expect(seen(host({ name: 'order', modulators: [[nested]] }))).toBe(false);
    expect(seen(host({ name: 'call', withArgs: [['k', nested]] }))).toBe(false);
    expect(seen(host({ name: 'repeat', repeatRegion: [write] }))).toBe(false);
    expect(seen(host({ name: 'choose', optionArms: [write] }))).toBe(false);
  });
});

describe('the defects the walker closed, and their neighbours', () => {
  test('a write inside an order()\'s by() declines the ranked head — not `RelIR: Ref …`', () => {
    declines("g.V().hasLabel('person').order().by(addV('x').fold())");
  });

  // `Scoping.getScopeValue` reads the traverser's whole path, so a child keeps its parent's labels
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  // A correlated child re-rooted WITHOUT the alias channel answered `select('a')` as an unbound key:
  // `[1,1]` where the reference counts `[2,2]`.
  test.each([
    "g.V().as('a').out('knows').local(union(select('a'), identity()).count())",
    "g.V(1).as('a').out().map(union(select('a'), identity()).count())",
    "g.V(1).as('a').out().local(union(math('1'), select('a').values('age')).sum())",
  ])('a scope read of a host label the child was not handed declines: %s', (q) => declines(q));

  // Contents only: the within-fold ARM order of a `local(union(…).fold())` is a separate, pre-existing
  // matter (`local(union(constant('x'), values('name')).fold())` folds by content too).
  test('…while a child that IS handed the host labels answers them', async () => {
    const lists = (await framed("g.V().as('a').out('knows').local(union(select('a').values('name'), values('name')).fold())")) as string[][];
    expect(lists.map((l) => [...l].sort())).toEqual([['marko', 'vadas'], ['josh', 'marko']]);
  });

  test('an unbound key is still the EMPTY result (Select.feature), not a decline', async () => {
    expect(await framed("g.V().select('zz').count()")).toEqual([0]);
  });

  // The drop is a CONJUNCTION over the keys (SelectStep.java:74-84): one key bound by NO scope empties
  // the select whatever a hidden key holds, so that answer needs no channel and stays answered.
  test('a hidden key beside a key no scope binds is the empty select, not a decline', async () => {
    expect(await framed("g.V().as('a').out('created').local(union(select('a','b'), identity()).count())")).toEqual([1, 1, 1, 1]);
  });

  // A path entry's labels are a SET: IdentityRemovalStrategy copies an identity()'s labels onto the
  // previous step, and a filter's labels extend the current entry (AbstractStep.prepareTraversalForNextStep,
  // ImmutablePath.extend(Set)).
  test.each([
    "g.V(1).as('a').identity().as('a').select(Pop.all, 'a')",
    "g.V(1).as('a').as('a').select(Pop.all, 'a')",
    "g.V(1).as('a', 'a').select(Pop.all, 'a')",
    "g.V(1).as('a').has('name', 'marko').as('a').select(Pop.all, 'a')",
  ])('one path entry binds a label once: %s', async (q) => expect(await ids(q)).toEqual([[1]]));

  test('…but a step that opens a new entry keeps both binds', async () => {
    expect(bagOf(await ids("g.V(1).as('a').out().as('a').select(Pop.all, 'a')"))).toEqual([[1, 2], [1, 3], [1, 4]]);
  });

  // A child traversal starts on its parent's traverser — the same last path entry — so a branch body's
  // leading bind of a label already there merges too (`LocalStep`/`BranchStep` hand the child's own
  // traverser outward).
  test.each([
    ["g.V(1).as('a').local(identity().as('a')).select(Pop.all, 'a')", [[1]]],
    ["g.V(1).as('a').optional(identity().as('a')).select(Pop.all, 'a')", [[1]]],
    ["g.V(1).as('a').union(identity().as('a'), out().as('a')).select(Pop.all, 'a')", [[1], [1, 2], [1, 3], [1, 4]]],
    ["g.V(1).as('a').local(out().as('a')).select(Pop.all, 'a')", [[1, 2], [1, 3], [1, 4]]],
  ])('a branch body continues its host\'s path entry: %s', async (q, expected) => {
    const got = (await ids(q)) as number[][];
    expect(got.map((l) => l.join(',')).sort()).toEqual((expected as number[][]).map((l) => l.join(',')).sort());
  });

  test('a where() body\'s leading as() is a start-label reference and is left alone', async () => {
    expect(await ids("g.V(1).as('a').where(__.as('a').out().as('b')).select('a')")).toEqual([1]);
  });

  test('a movement over a stream with no bulk channel does not collapse into an ill-formed Aggregate', async () => {
    expect(await framed("g.V().local(__.fold().unfold().optional(__.identity()).has('name','lop')).both().fold().count(local)")).toEqual([3]);
  });

  test('a HAVING whose subquery reads the aggregate gets a derived table — not `misuse of aggregate function`', async () => {
    expect(await framed("g.E().filter(__.inV().dedup().group().by('lang').select('keys'))")).toEqual([]);
    expect((await framed("g.E().filter(__.inV().group().by('lang').select('java'))")).map((e: any) => e.id).sort((x: number, y: number) => x - y)).toEqual([9, 10, 11, 12]);
  });
});

// THE FIX-FORWARD of the walker landing: where a path entry opens, a write in any child value, a scope
// read under every child re-root, and a map-valued member framed as JSON.
describe('path entries: a map/flatMap identity host is kept where the path is read', () => {
  // `MapStep`/`FlatMapStep` emit `traverser.split(result, this)`, which EXTENDS a path-tracking traverser's
  // path (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71),
  // so a traversal that reads the path keeps the host rather than splicing it (`inlineIdentityHostBody`).
  test.each([
    "g.V(1).map(identity()).path()",
    "g.V(1).flatMap(identity()).path()",
    "g.V(1).local(flatMap(identity())).path()",
  ])('%s', async (q) => expect((await framed(q)).map((p: any) => p.objects.map((v: any) => v.id))).toEqual([[1, 1]]));

  test('coalesce() opens an entry too', async () => {
    expect(await ids("g.V(1).as('a').coalesce(has('age'), out()).as('a').select(Pop.all, 'a')")).toEqual([[1, 1]]);
  });

  test('simplePath() filters the repeated entry', async () => {
    expect(await framed("g.V(1).map(identity()).simplePath().count()")).toEqual([0]);
  });

  // A path read is a WHOLE-TRAVERSAL fact: a host inside a body normalized on its own (a branch arm, a
  // repeat body) is kept when the ROOT reads the path, so it answers the entry or declines — never
  // drops it.
  test.each([
    "g.V(1).union(map(identity())).path()",
    "g.V(1).union(union(map(identity()))).path()",
    "g.V(1).optional(flatMap(identity())).path()",
    "g.V(1).union(local(map(identity()))).path()",
  ])('a nested host under a root path read: %s', async (q) => expect((await framed(q)).map((p: any) => p.objects.map((v: any) => v.id))).toEqual([[1, 1]]));

  test('a nested host under a root simplePath() is filtered', async () => {
    expect(await framed("g.V(1).union(map(identity())).simplePath().count()")).toEqual([0]);
    expect(await framed("g.V(1).optional(out().map(identity())).simplePath().count()")).toEqual([0]);
  });

  // A kept host BEHIND A MOVEMENT in an optional/coalesce arm: the arm's exhaustion probe runs the body
  // over a path-free subject, so the flatMap there has no entering path to recover (it was an internal
  // `RelIR: … no declared column 'path'`, and so was a non-identity `flatMap(out())` on trunk).
  const paths = async (q: string) => (await framed(q)).map((p: any) => p.objects.map((v: any) => v.id));
  test.each([
    ["g.V(1).optional(out().map(identity())).path()", [[1, 2, 2], [1, 4, 4], [1, 3, 3]]],
    ["g.V(1).optional(out().flatMap(identity())).path()", [[1, 2, 2], [1, 4, 4], [1, 3, 3]]],
    ["g.V(2).optional(out().map(identity())).path()", [[2]]],
    ["g.V(1).coalesce(out().map(identity()),identity()).path()", [[1, 2, 2], [1, 4, 4], [1, 3, 3]]],
    ["g.V(1).optional(out().flatMap(identity()).out()).path()", [[1, 4, 4, 3], [1, 4, 4, 5]]],
    ["g.V(1).optional(out().flatMap(out())).path()", [[1, 4, 3], [1, 4, 5]]],
  ])('an arm host behind a movement under a path read: %s', async (q, expected) =>
    expect(bagOf(await paths(q))).toEqual(bagOf(expected)));

  test.each([
    "g.V(1).repeat(map(identity())).times(1).path()",
    "g.V(1).coalesce(map(identity())).path()",
  ])('a kept nested host the lowering does not cover declines: %s', (q) => declines(q));

  // A same-label re-bind across a branch host ANSWERS: the entry is not followed out of the host, so a
  // `Pop.all` read may list the element once more than the reference (a deliberate divergence).
  test.each([
    "g.V(1).as('a').choose(has('age'), identity(), out()).as('a').select(Pop.all, 'a')",
    "g.V().as('a').optional(out()).as('a').select(Pop.all, 'a')",
    "g.V(1).as('a').union(identity()).as('a').select(Pop.all, 'a')",
  ])('a re-bind across a branch host answers: %s', async (q) => expect((await framed(q)).length).toBeGreaterThan(0));
});
describe('a write in any correlated child value declines — never `RelIR: Ref …`', () => {
  test.each([
    "g.V().hasLabel('person').order().by(choose(has('age'), addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').order().by(choose(has('age'), addV('y').count(), constant(1))).limit(1)",
    "g.V().hasLabel('person').order().by(choose(has('age'), constant(1), addV('y').count()))",
    "g.V().hasLabel('person').order().by(choose(values('age')).option(29, addV('y').count()).option(none, constant(1)))",
    "g.V().hasLabel('person').order().by(coalesce(addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').project('a').by(choose(has('age'), addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').map(choose(has('age'), addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').group().by(choose(has('age'), addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').dedup().by(choose(has('age'), addV('y').count(), constant(1)))",
    "g.V().hasLabel('person').map(addV('y').count())",
    "g.V().hasLabel('person').local(addV('y').count())",
    "g.V().hasLabel('person').coalesce(addV('y').count(), constant(1))",
    "g.V().hasLabel('person').project('a').by(addV('y').count())",
  ])('%s', (q) => declines(q));
});

describe('every child re-root hands its host labels in as enclosing', () => {
  // A choose() condition and a repeat() until()/emit() predicate re-root at the subject row with no alias
  // channel, exactly as a correlated value does; a scope read of the chain's label declines there too.
  test.each([
    "g.V().as('a').out('knows').choose(union(select('a'), identity()).count().is(2), constant('y'), constant('n'))",
    "g.V().as('a').out('knows').choose(local(select('a')).count().is(1), constant('y'), constant('n'))",
    "g.V().as('a').out('knows').choose(flatMap(select('a')).count().is(1), constant('y'), constant('n'))",
    "g.V().as('a').out('knows').repeat(out()).until(union(select('a'), identity()).count().is(2))",
    "g.V().as('a').out('knows').repeat(out()).until(local(select('a')).count().is(1))",
    "g.V().as('a').out('knows').until(union(select('a'), identity()).count().is(2)).repeat(out())",
    "g.V().as('a').out('knows').repeat(out()).emit(union(select('a'), identity()).count().is(2))",
  ])('%s', (q) => declines(q));

  test('a condition that reads no label still answers', async () => {
    expect(await framed("g.V().as('a').out('knows').choose(has('age'), constant('y'), constant('n'))")).toEqual(['y', 'y']);
  });
});

describe('a map-valued member of a map frames as a map', () => {
  // The map column holds the pairs array as JSON TEXT; without `json()` the envelope embedded it as a
  // string and the framer met `pairs.flatMap is not a function`.
  test.each([
    ["g.V(1).project('x').by(project('y').by(constant(1)))", [new Map([['x', new Map([['y', 1]])]])]],
    ["g.V(1).project('x').by(valueMap('name'))", [new Map([['x', new Map([['name', ['marko']]])]])]],
  ])('%s', async (q, expected) => expect(await framed(q)).toEqual(expected));

  test('an edge stream projecting a valueMap() member', async () => {
    const rows = (await framed("g.E().identity().project('a','b').by(__.identity()).by(__.valueMap()).fold()")) as any[][];
    expect(rows[0]!.map((m: Map<string, any>) => m.get('b').get('weight')).sort()).toEqual([0.2, 0.4, 0.4, 0.5, 1, 1]);
  });
});

// `Grouping.determineBarrierStep` pools every member of a key into ONE value traversal
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125);
// a `by(<pre>.fold())` the pool cannot build must not fall through to a per-member fold.
describe('a group value fold the pool cannot build declines', () => {
  test.each([
    "g.V().as('a').out().group().by(select('a').values('name')).by(values('name').fold())",
    "g.V().as('a').out().group().by(select('a')).by(values('name').fold())",
    "g.V().as('a').out().group('m').by(select('a')).by(values('name').fold()).cap('m')",
  ])('%s', (q) => declines(q));

  test('…while a bare by(fold()) still collects the traversers', async () => {
    const [m] = (await framed("g.V().as('a').out().group().by(select('a').values('name')).by(fold())")) as Map<string, any[]>[];
    expect(m!.get('marko')!.length).toBe(3);
  });
});
