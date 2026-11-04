import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_VALUE_BYTES } from '../src/cf-limits.ts';
import { utf8Bytes } from '../src/do-limits.ts';
import { RaisedByQuery } from '../src/rel/raise.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { loadBulk, type BulkVertex } from '../src/bulk.ts';
import { lowerTypedNodeStream } from '../src/compiler/rel/lower.ts';
import { finishLowering } from '../src/compiler/rel/spine.ts';
import type { FrameNode } from '../src/gremlin/types.ts';
import { decode } from './support/decode.ts';

// A federated VALUE STREAM at production size, on a store that refuses what a Durable Object refuses.
//
// A pushed-down federate terminal that ends in values (`values(k)`, `fold()`, `unfold()`) brings its
// result back as N `{t,v}` nodes. Those nodes used to be inlined into the resumed statement as one
// `VALUES` row each, and the mid-traversal scatter inlined one `VALUES` row per PARENT — so the
// statement text grew with the data: ~200 KB for 5,000 names, refused only by a DO's 100 KB wall and
// green on every Bun store (`src/cf-limits.ts`). The set now crosses as ONE JSON bind exploded by
// `json_each`, the same rule an element landing follows, so these run under `CfLimitedSql`. Under a
// plain BunSqlite every one of them would pass either way — the limited store IS the regression gate.

const N = 5_000;
const ROW_SCALE_TIMEOUT_MS = 30_000;
// Long enough that even the one-node fold() (bare strings, no `{t,v}` envelope per member) is past 100 KB inlined.
const name = (i: number) => `name-of-person-number-${String(i).padStart(5, '0')}`;

const mgr = new BunGraphManager(undefined, extendedRegistry, undefined, undefined, (source) => new CfLimitedSql(new BunSqlite(source)));
const dec = (f: { buf: Buffer }) => decode(f.buf);
const run = async (graph: string, g: string) => Promise.all((await mgr.executor(graph).framedAsync(g, {})).map(dec));

beforeAll(() => {
  // `big`: the SIBLING — N named people plus three `few` vertices a constant sub-traversal returns.
  const people: BulkVertex[] = Array.from({ length: N }, (_, i) => ({ labels: ['person'], properties: [{ key: 'name', value: name(i) }] }));
  const few: BulkVertex[] = ['a', 'b', 'c'].map((n) => ({ labels: ['few'], properties: [{ key: 'name', value: n }] }));
  loadBulk(mgr.storeOf('big'), [...people, ...few]);
  // `home`: the CALLER — N parents for the mid-traversal scatter.
  loadBulk(mgr.storeOf('home'), Array.from({ length: N }, (_, i) => ({ labels: ['parent'], properties: [{ key: 'i', value: i }] })));
});

const source = (sub: string) => `g.call("federate", ["graph":"big","traversal":__.${sub}])`;

describe('a federated value stream lands as one bind at any size', () => {
  test(`a pushed values() stream of ${N} names answers on a DO-legal store`, async () => {
    const got = await run('home', source('V().hasLabel("person").values("name")'));
    expect(got.length).toBe(N);
    expect([...got].sort()).toEqual(Array.from({ length: N }, (_, i) => name(i)));
  }, ROW_SCALE_TIMEOUT_MS);

  test(`a pushed fold() — ONE node holding ${N} members — answers on a DO-legal store`, async () => {
    const got = await run('home', source('V().hasLabel("person").values("name").fold()'));
    expect(got.length).toBe(1);
    expect((got[0] as string[]).length).toBe(N);
  }, ROW_SCALE_TIMEOUT_MS);

  test('the answer keeps the order the sibling EMITTED (a pushed order() survives the landing)', async () => {
    const q = 'V().hasLabel("person").order().by("name", desc).values("name")';
    const got = await run('home', source(q));
    expect(got).toEqual(await run('big', `g.${q}`));
    expect(got[0]).toBe(name(N - 1));
  }, ROW_SCALE_TIMEOUT_MS);

  test(`a mid V().call(federate, <constant values sub>) over ${N} parents answers P×N`, async () => {
    const got = await run('home', 'g.V().hasLabel("parent").call("federate", ["graph":"big","traversal":__.V().hasLabel("few").order().by("name").values("name")])');
    expect(got.length).toBe(N * 3);
    // Each parent re-emits the WHOLE pool in the sibling's order — call() is a flatMap per parent.
    expect(got.slice(0, 6)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  }, ROW_SCALE_TIMEOUT_MS);

  test(`a mid constant ELEMENT sub over ${N} parents (the element rejoin's parent relation) answers P×N`, async () => {
    const got = await run('home', 'g.V().hasLabel("parent").call("federate", ["graph":"big","traversal":__.V().hasLabel("few")]).values("name")');
    expect(got.length).toBe(N * 3);
  }, ROW_SCALE_TIMEOUT_MS);

  test('an empty stream, and a mid call over NO parents, are no traversers', async () => {
    expect(await run('home', source('V().hasLabel("nope").values("name")'))).toEqual([]);
    expect(await run('home', 'g.V().hasLabel("nope").call("federate", ["graph":"big","traversal":__.V().hasLabel("few").values("name")])')).toEqual([]);
  });
});

// PAST ONE DURABLE OBJECT VALUE. "One bind" was the rule above, and it moved the wall from the bind count
// to the bind's SIZE: a DO caps one value at 2 MB (`src/do-limits.ts`), so 8,000 wide people landed as ONE
// `json_each` value (an `elementMap()` is ~4 MB) were refused in production and green on Bun. Every landing
// now goes through the one builder (`compiler/rel/build.ts` `jsonEachRelation`), which splits such a set at
// member boundaries into several values. Each test here first checks that ITS payload is past the cap —
// otherwise it would pass without the split and gate nothing.
describe('a federated landing past one DO value (2 MB) lands whole, in order', () => {
  const W = 8_000;
  const wideName = (i: number) => `${String(i).padStart(5, '0')}-${'n'.repeat(290)}`;
  // Loaded in batches each under the cap, so these tests isolate the LANDING's split from the load's
  // (`test/value-cap-split.test.ts` gates the load).
  beforeAll(() => {
    const people: BulkVertex[] = Array.from({ length: W }, (_, i) => ({
      labels: ['person'], properties: [{ key: 'name', value: wideName(i) }, { key: 'age', value: i }],
    }));
    for (let at = 0; at < W; at += 1_000) loadBulk(mgr.storeOf('wide'), people.slice(at, at + 1_000));
  });
  const wideSource = (sub: string) => `g.call("federate", ["graph":"wide","traversal":__.${sub}])`;
  /** The sibling's own answer is past the cap — so the landing, which also carries each `{t,v}` envelope, is. */
  const pastCap = async (sub: string) => {
    const answer = await run('wide', `g.${sub}`);
    const spelled = JSON.stringify(answer, (_, v: unknown) => (v instanceof Map ? [...v] : v));
    expect(utf8Bytes(spelled)).toBeGreaterThan(CF_MAX_VALUE_BYTES);
    return answer;
  };

  for (const sub of [
    'V().hasLabel("person").order().by("name").elementMap()',
    'V().hasLabel("person").order().by("name").valueMap()',
    'V().hasLabel("person").order().by("name").project("n","a").by("name").by("age")',
    'V().hasLabel("person").order().by("name").values("name")',
  ]) {
    test(`a pushed ${sub.slice(sub.lastIndexOf(').') + 2)} stream of ${W} lands every member in the sibling's order`, async () => {
      const expected = await pastCap(sub);
      const got = await run('home', wideSource(sub));
      expect(got.length).toBe(W);
      expect(got).toEqual(expected);
    }, ROW_SCALE_TIMEOUT_MS);
  }

  // A multiset: a landed ELEMENT stream read back through `values()` is not order-pinned at the wire (L8
  // reverses it at any size, one chunk or several), so this asserts no element is lost or duplicated.
  test(`an ELEMENT landing of ${W} wide people keeps every element`, async () => {
    await pastCap('V().hasLabel("person").elementMap()');
    const got = await run('home', `${wideSource('V().hasLabel("person")')}.values("name")`);
    expect([...got].sort()).toEqual(Array.from({ length: W }, (_, i) => wideName(i)));
  }, ROW_SCALE_TIMEOUT_MS);

  test('a landed element stream that REPEATS each element keeps its multiplicity past the cap', async () => {
    const got = await run('home', `${wideSource('V().hasLabel("person").union(identity(), identity())')}.count()`);
    expect(got).toEqual([2 * W]);
  }, ROW_SCALE_TIMEOUT_MS);

  test('a mid call() whose pool is past the cap re-emits the WHOLE pool per parent, duplicates and order kept', async () => {
    const sub = 'V().hasLabel("person").union(values("name"), values("name")).order()';
    await pastCap(sub);
    const got = await run('home', `g.V().hasLabel("parent").limit(2).call("federate", ["graph":"wide","traversal":__.${sub}])`);
    const pool = Array.from({ length: W }, (_, i) => [wideName(i), wideName(i)]).flat();
    expect(got).toEqual([...pool, ...pool]);
  }, ROW_SCALE_TIMEOUT_MS);

  // ONE member past the cap cannot be split — no Durable Object can hold it as a value at all. That is the
  // PLATFORM's limit, and the user is told so in its terms rather than handed SQLite's bare message (or a
  // decline that blames the traversal). On Bun alone (no cap to model) these answer.
  for (const sub of ['V().hasLabel("person").values("name").fold()', 'V().hasLabel("person").groupCount().by("name")']) {
    test(`a pushed ${sub.slice(sub.lastIndexOf(').') + 2)} — ONE value past the cap — is a clear platform-limit error`, async () => {
      await pastCap(sub);
      const failure = await run('home', wideSource(sub)).then(() => null, (e: unknown) => e);
      expect(failure).toBeInstanceOf(RaisedByQuery);
      expect((failure as Error).message).toMatch(/a single value is larger than this graph's storage can hold \(a Durable Object's SQLite caps one string or JSON value at 2 MB\)/);
    }, ROW_SCALE_TIMEOUT_MS);
  }
});

// The resumed statement itself: its TEXT is a property of the plan, never of how many values came back.
describe('the value-stream resume statement is O(plan), not O(data)', () => {
  const nodes = (n: number): FrameNode[] => Array.from({ length: n }, (_, i) => ({ t: 'string', v: name(i) }) as FrameNode);
  const plan = (n: number, parents?: number) => {
    const p = finishLowering(lowerTypedNodeStream(nodes(n), parents));
    if (p.kind !== 'read') throw new Error('expected a read plan');
    return p;
  };

  test('10 values and 5,000 values compile to byte-identical text with one bind', () => {
    const [small, large] = [plan(10), plan(N)];
    expect(large.sql).toBe(small.sql);
    expect(small.binds.length).toBe(1);
    expect(large.binds.length).toBe(1);
  });

  test('the scatter binds the pool once and the parents once, whatever P and N are', () => {
    const [small, large] = [plan(10, 2), plan(N, N)];
    expect(large.sql).toBe(small.sql);
    expect(small.binds.length).toBe(2);
    expect(large.binds.length).toBe(2);
  });

  test('rows come back in the order the nodes were emitted, not sorted by value', () => {
    const store = new CfLimitedSql(new BunSqlite(':memory:'));
    const emitted = ['zed', 'amy', 'mid'].map((v) => ({ t: 'string', v }) as FrameNode);
    const p = finishLowering(lowerTypedNodeStream(emitted));
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(store.query(p.sql, p.binds).map((r) => JSON.parse(String(r.node)).v)).toEqual(['zed', 'amy', 'mid']);
  });
});
