// ONE IR WALKER, and the declines and fixes that ride on it (`src/compiler/ir/walk.ts`).
//
// Every whole-tree question the compiler asks — "is there a write anywhere?", "a random draw?", "which
// labels are read?", "a barrier?" — used to enumerate a step's child positions privately, and each copy
// missed a different one (`someStepDeep` saw only `args`, so a write inside `order().by(…)` was invisible
// to the ranked-order head and leaked a `RelIR: Ref …` internal error). This file pins the walker's
// totality and each defect it closed, plus three neighbours found beside it: a scope read in a child
// re-rooted without its host's alias channels, path-entry label sets, and two internal errors.
import { describe, expect, test } from 'bun:test';
import { compilePlan, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { arg, type Step } from '../../src/gremlin/frontend.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { eachChainDeep, someStepDeep } from '../../src/compiler/ir/walk.ts';
import { seededStore } from '../support/harness.ts';
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
    expect(await ids("g.V(1).as('a').out().as('a').select(Pop.all, 'a')")).toEqual([[1, 2], [1, 3], [1, 4]]);
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
