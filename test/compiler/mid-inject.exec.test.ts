// `inject(x…)` PAST THE SOURCE — the incoming stream UNION ALL one fresh traverser per argument
// (`injectTail`, `src/compiler/rel/lower.ts`). `InjectStep` is a `StartStep`: each injection is a NEW
// traverser of bulk 1 with no labels and a path that starts at it
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/StartStep.java:59-77`),
// added to `starts` ahead of the incoming traversers — so where a consumer reads the order, the
// injections come first. Inside a CHILD traversal the reference injects for the first parent only, so
// that form declines and says why.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { exec } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { seededStore } from '../support/harness.ts';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';

const store: GraphStore = seededStore();
const relExec = exec(store);
const vals = async (g: string) =>
  (await decodeAll(relExec.buffers(g, {}, {}))).map((x: any) =>
    x === null || x === undefined ? 'null' : x?.constructor ? `${x.constructor.name}:${x.toString()}` : String(x));
const sorted = async (g: string) => (await vals(g)).sort();
const declineOf = (g: string): UnsupportedTraversal => {
  try { compile(g, {}); } catch (e) { if (e instanceof UnsupportedTraversal) return e; throw e; }
  throw new Error(`expected ${g} to decline`);
};

describe('mid-traversal inject() on the root traversal', () => {
  test('adds the injected values beside the stream, a null included', async () => {
    expect(await sorted('g.V(1).values("age").inject(null, null)')).toEqual(['Number:29', 'null', 'null'].sort());
    expect(await sorted('g.inject(1, 3).inject(100, 300)')).toEqual(['Number:1', 'Number:100', 'Number:3', 'Number:300']);
  });

  test('feeds a reducer: the injected value is one more member (its wire class: L3 Min/Sum)', async () => {
    expect(await vals('g.V().values("age").inject(1000n).sum()')).toEqual(['BigInt:1123']);
    expect(await vals('g.V().values("foo").inject(9999999999l).min()')).toEqual(['Number:9999999999']);
    expect(await vals('g.V().values("age").inject(1).count()')).toEqual(['Number:5']);
    expect(await vals('g.V().values("age").inject(29).groupCount()')).toHaveLength(1);
  });

  test('an injected traverser is ahead of the stream where the order is read', async () => {
    expect(await vals('g.V().values("age").inject(3, 1).limit(2)')).toEqual(['Number:3', 'Number:1']);
    expect(await vals('g.V(1).values("age").inject(1).fold()')).toEqual(['Array:1,29']);
  });

  test('an injected traverser carries no label: select() drops it, count() after select() too', async () => {
    expect(await sorted('g.V().values("age").as("a").inject(1).select("a")')).toEqual(['Number:27', 'Number:29', 'Number:32', 'Number:35']);
    expect(await vals('g.V().as("a").values("age").inject(1).select("a").count()')).toEqual(['Number:4']);
  });

  test('its path starts at the injected value', async () => {
    const paths = await vals('g.V(1).values("age").inject(7).path()');
    expect(paths).toHaveLength(2);
  });

  test('withSack: an injected traverser holds the initial sack', async () => {
    expect(await vals('g.withSack(1).V(1).values("age").inject(5).sack()')).toEqual(['Number:1', 'Number:1']);
  });

  test('a shape the stream does not have merges as a union() arm would (a variant)', async () => {
    expect(await vals('g.V().inject(1).count()')).toEqual(['Number:7']);
  });

  test('inject() with no argument is the identity mid-traversal, and the empty source', async () => {
    expect(await vals('g.V(1).values("age").inject()')).toEqual(['Number:29']);
    expect(await vals('g.inject()')).toEqual([]);
    expect(await vals('g.inject().count()')).toEqual(['Number:0']);
  });
});

describe('inject() inside a child traversal declines, saying why', () => {
  test.each([
    ['g.V().local(__.values("age").inject(1))'],
    ['g.V().union(__.values("age").inject(1), __.constant(2))'],
    ['g.V().flatMap(__.inject(1).values("age"))'],
  ])('%s', (g) => {
    expect(declineOf(g).message).toContain('inject() with values inside a child traversal');
  });
});
