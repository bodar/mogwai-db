// The compiled-plan cache (`src/compiler/plan-cache.ts`): a repeated identical request skips the
// compile, and nothing the cache serves can be stale. A plan is a function of the request alone (text,
// parameter values and types, federation depth, detached mode), so the tests below prove each input
// is in the key, and each request the key cannot make safe is never cached.
import { describe, expect, test } from 'bun:test';
import { compilePlan } from '../../src/compiler/compiler.ts';
import { PlanCache, planCacheKey, PLAN_CACHE_MAX_ENTRY_TEXT_UNITS } from '../../src/compiler/plan-cache.ts';
import { parseCacheStats, PARSE_CACHE_MAX_ENTRY_TEXT_UNITS } from '../../src/gremlin/frontend.ts';
import { createAppScope, type AppScope } from '../../src/scopes.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { frameResolved } from '../../src/execute.ts';
import { paramEnv } from '../../src/gremlin/param-env.ts';
import { CompileBudget } from '../../src/sql/kernel/budget.ts';
import { seededStore } from '../support/harness.ts';
import { exec } from '../support/executor.ts';
import { decode as deserialize } from '../support/decode.ts';
import type { GraphStore } from '../../src/storage.ts';

const scope = (store?: GraphStore, planCache?: PlanCache): AppScope =>
  createAppScope({ registry: standardRegistry, store, planCache });

/** Compile through the cache and run the plan, as the Executor does for a single-statement plan. */
async function answer(store: GraphStore, app: AppScope, q: string, params: Record<string, any> = {}): Promise<unknown[]> {
  const plan = compilePlan(q, params, { app });
  if (plan.kind !== 'sql') throw new Error('expected a single-statement plan');
  return Promise.all(frameResolved(store, plan.compiled).map((f) => deserialize(f.buf)));
}

describe('a repeated request is a hit', () => {
  test('the second identical compile returns the same plan without compiling', () => {
    const app = scope();
    const q = "g.V().has('person','name','marko').out('knows').values('name')";
    const first = compilePlan(q, {}, { app });
    const second = compilePlan(q, {}, { app });
    expect(second).toBe(first);
    expect(app.planCache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  test('a cached plan is frozen, so a caller that mutates it fails at once', () => {
    const app = scope();
    const plan = compilePlan('g.V().count()', {}, { app });
    expect(Object.isFrozen(plan)).toBe(true);
    if (plan.kind !== 'sql') throw new Error('expected sql');
    expect(Object.isFrozen(plan.compiled)).toBe(true);
    expect(() => { (plan.compiled as any).sql = 'x'; }).toThrow();
  });

  test('an Executor answers the same through its cache, read and write', () => {
    const store = seededStore();
    const ex = exec(store);
    const q = "g.V().has('name','marko').out().values('name').order()";
    const first = ex.framed(q, {}).map((f) => f.buf.toString('hex'));
    expect(ex.framed(q, {}).map((f) => f.buf.toString('hex'))).toEqual(first);
    const w = "g.addV('thing').property('name', n)";
    ex.framed(w, { n: 'a' });
    ex.framed(w, { n: 'a' });
    const count = ex.framed("g.V().hasLabel('thing').count()", {});
    expect(ex.framed("g.V().hasLabel('thing').count()", {}).map((f) => f.buf.toString('hex'))).toEqual(count.map((f) => f.buf.toString('hex')));
    expect(ex.framed("g.V().hasLabel('thing').values('name')", {}).length).toBe(2);
  });
});

describe('nothing the cache serves is stale', () => {
  // LDBC q19's shape. It compiles to a SEGMENT plan (its ranked local order runs a head read), which
  // is never cached — the one plan whose compile and execution interleave.
  test('a groupCount winner read after a write that changes it is the new winner', async () => {
    const store = seededStore();
    const app = scope(store);
    const q = "g.V().hasLabel('person').groupCount().by('name').order(local).by(values, desc).limit(local, 1)";
    const ex = exec(store);
    const before = ex.framed(q, {}).map((f) => f.buf.toString('hex'));
    for (let i = 0; i < 3; i++) ex.framed("g.addV('person').property('name', 'zed')", {});
    const after = ex.framed(q, {});
    expect(after.map((f) => f.buf.toString('hex'))).not.toEqual(before);
    const winner = await deserialize(after[0]!.buf) as Map<string, number>;
    expect([...winner]).toEqual([['zed', 3]]);
    expect(compilePlan(q, {}, { app }).kind).toBe('segment');
    expect(app.planCache.stats().size).toBe(0);
  });

  test('a cacheable read sees a write made between two hits', async () => {
    const store = seededStore();
    const app = scope(store);
    const q = "g.V().hasLabel('person').count()";
    expect(await answer(store, app, q)).toEqual([4]);
    await answer(store, app, "g.addV('person')");
    expect(await answer(store, app, q)).toEqual([5]);
    expect(app.planCache.stats().hits).toBe(1);
  });

  test('datetime() is "now" at each request — never served from the cache', async () => {
    const app = scope();
    const store = seededStore();
    const a = await answer(store, app, 'g.inject(datetime())');
    await Bun.sleep(5);
    const b = await answer(store, app, 'g.inject(datetime())');
    expect((b[0] as Date).getTime()).toBeGreaterThan((a[0] as Date).getTime());
    expect(app.planCache.stats().size).toBe(0);
    // A datetime with a string is a constant of the text, so it IS cached.
    await answer(store, app, "g.inject(datetime('2020-01-01T00:00:00Z'))");
    expect(app.planCache.stats().size).toBe(1);
  });

  test('UUID() is a fresh random uuid at each request — never served from the cache', async () => {
    const app = scope();
    const store = seededStore();
    const a = await answer(store, app, 'g.inject(UUID())');
    const b = await answer(store, app, 'g.inject(UUID())');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toEqual(b[0]);
    expect(app.planCache.stats().size).toBe(0);
    // A UUID with a string is a constant of the text, so it IS cached.
    await answer(store, app, "g.inject(UUID('6c1f4a2e-0000-4000-8000-000000000000'))");
    expect(app.planCache.stats().size).toBe(1);
  });

  test('a nested datetime() is found at any depth', () => {
    const app = scope();
    compilePlan("g.V().project('a').by(constant(datetime()))", {}, { app });
    expect(app.planCache.stats().size).toBe(0);
  });

  test('different parameter values do not share an entry', async () => {
    const store = seededStore();
    const app = scope(store);
    const q = "g.V().has('age', x).values('name')";
    expect(await answer(store, app, q, { x: 29 })).toEqual(['marko']);
    expect(await answer(store, app, q, { x: 32 })).toEqual(['josh']);
    expect(await answer(store, app, q, { x: 29 })).toEqual(['marko']);
    expect(app.planCache.stats()).toMatchObject({ hits: 1, size: 2 });
  });

  test('a parameter whose VALUE the compile reads (a loop bound) gives each value its own answer', async () => {
    const store = seededStore();
    const app = scope(store);
    const q = "g.V().has('name','marko').repeat(out()).until(loops().is(n)).count()";
    const one = await answer(store, app, q, { n: 1 });
    const two = await answer(store, app, q, { n: 2 });
    expect(one).toEqual([3]);
    expect(two).toEqual([2]);
    expect(await answer(store, app, q, { n: 1 })).toEqual([3]);
  });

  test('a parameter declared with a different type is a different key', () => {
    const k = (types: Record<string, any>) => planCacheKey('g.inject(x)', paramEnv({ x: 1 }, types), 0, false);
    expect(k({ x: 'int' })).not.toBe(k({ x: 'long' }));
    expect(planCacheKey('g.inject(x)', paramEnv({ x: 0 }), 0, false)).not.toBe(planCacheKey('g.inject(x)', paramEnv({ x: -0 }), 0, false));
    expect(planCacheKey('g.inject(x)', paramEnv({ x: 1 }), 0, false)).not.toBe(planCacheKey('g.inject(x)', paramEnv({ x: 1n }), 0, false));
    expect(planCacheKey('g.inject(x)', paramEnv({ x: new Map([['a', 1]]) }), 0, false))
      .not.toBe(planCacheKey('g.inject(x)', paramEnv({ x: { a: 1 } }), 0, false));
    expect(planCacheKey('g.V()', paramEnv({}), 0, false)).not.toBe(planCacheKey('g.V()', paramEnv({}), 1, false));
    expect(planCacheKey('g.V()', paramEnv({}), 0, false)).not.toBe(planCacheKey('g.V()', paramEnv({}), 0, true));
  });
});

describe('what is never cached', () => {
  test('a large parameter (a bulk upsert, a long within() list) still answers, and is not held', async () => {
    const store = seededStore();
    const app = scope(store);
    const props = new Map<any, any>(Array.from({ length: 400 }, (_, i) => [`k${i}`, `value-${i}`]));
    expect((await answer(store, app, 'g.mergeV(m)', { m: props })).length).toBe(1);
    expect(await answer(store, app, "g.V().has('k399', 'value-399').count()")).toEqual([1]);
    const names = ['marko', ...Array.from({ length: 1000 }, (_, i) => `absent-${i}`)];
    expect(await answer(store, app, "g.V().has('name', within(names)).count()", { names })).toEqual([1]);
    // Only the small parameter-free count read above is held.
    expect(app.planCache.stats().size).toBe(1);
  });

  test('a segment plan (a regex barrier) is never cached', () => {
    const app = scope();
    compilePlan("g.V().has('name', regex('m.*'))", {}, { app });
    expect(app.planCache.stats().size).toBe(0);
  });

  test('a failed compile is never cached', () => {
    const app = scope();
    expect(() => compilePlan('g.V().next()', {}, { app })).toThrow();
    expect(app.planCache.stats().size).toBe(0);
  });

  test('a caller-held budget always compiles', () => {
    const app = scope();
    compilePlan('g.V()', {}, { app, budget: new CompileBudget() });
    compilePlan('g.V()', {}, { app, budget: new CompileBudget() });
    expect(app.planCache.stats()).toMatchObject({ hits: 0, size: 0 });
  });

  test('a parameter with no canonical spelling is not cached', () => {
    class Opaque { constructor(readonly v: number) {} }
    expect(planCacheKey('g.inject(x)', paramEnv({ x: new Opaque(1) }), 0, false)).toBeNull();
  });
});

describe('the LRU bound', () => {
  test('past max entries, the least-recently-used entry goes', () => {
    const app = scope(undefined, new PlanCache(2));
    compilePlan('g.V().count()', {}, { app });
    compilePlan('g.E().count()', {}, { app });
    compilePlan('g.V().count()', {}, { app });           // V is now most recently used
    compilePlan("g.V().values('name')", {}, { app });   // evicts E
    expect(app.planCache.stats().size).toBe(2);
    const misses = app.planCache.stats().misses;
    compilePlan('g.V().count()', {}, { app });
    expect(app.planCache.stats().misses).toBe(misses);
    compilePlan('g.E().count()', {}, { app });
    expect(app.planCache.stats().misses).toBe(misses + 1);
  });

  test('past max text, the least-recently-used entries go', () => {
    const probe = scope();
    compilePlan('g.V().count()', {}, { app: probe });
    const one = probe.planCache.stats().textUnits;
    const app = scope(undefined, new PlanCache(512, Math.floor(one * 2.5)));
    compilePlan('g.V().count()', {}, { app });
    compilePlan('g.V().count().is(1)', {}, { app });
    compilePlan('g.V().count().is(2)', {}, { app });
    const stats = app.planCache.stats();
    expect(stats.textUnits).toBeLessThanOrEqual(Math.floor(one * 2.5));
    expect(stats.size).toBeLessThan(3);
  });
});

/** One traversal of `n` vertex inserts: a batch write whose plan is large. */
const batch = (n: number, tag = ''): string =>
  'g' + Array.from({ length: n }, (_, i) => `.addV('person').property('name','${tag}n${i}')`).join('');

describe('the per-entry limit', () => {
  test('a plan past the per-entry limit is not held, and an older plan under its key goes', () => {
    const plans = new PlanCache(512, 1 << 20, 1000);
    const small = compilePlan('g.V().count()', {}, { app: scope() });
    const large = compilePlan(batch(10), {}, { app: scope() });
    plans.set('k', small);
    expect(plans.stats().size).toBe(1);
    plans.set('k', large);
    expect(plans.stats()).toMatchObject({ size: 0, textUnits: 0 });
    expect(plans.get('k')).toBeUndefined();
  });

  test('a large batch write compiled again and again is never held, and hot reads stay', async () => {
    const store = seededStore();
    const app = scope(store);
    const hot = ["g.V().hasLabel('person').count()", "g.V().has('name','marko').out().values('name')"];
    for (const q of hot) await answer(store, app, q);
    const q = batch(100);
    for (let i = 0; i < 10; i++) compilePlan(q, {}, { app });
    expect(app.planCache.stats().size).toBe(hot.length);
    const { misses } = app.planCache.stats();
    expect(await answer(store, app, hot[0]!)).toEqual([4]);
    await answer(store, app, hot[1]!);
    expect(app.planCache.stats().misses).toBe(misses);
  });
});

describe('the parse cache', () => {
  test("its per-entry limit is at least the plan cache's, so a text whose plan is held keeps its parse", () => {
    expect(PARSE_CACHE_MAX_ENTRY_TEXT_UNITS).toBeGreaterThanOrEqual(PLAN_CACHE_MAX_ENTRY_TEXT_UNITS);
  });

  test('a repeated text is a hit', () => {
    const q = "g.V().has('name','parse-cache-hit').count()";
    const before = parseCacheStats();
    compilePlan(q, {}, {});
    compilePlan(q, {}, {});
    const after = parseCacheStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });

  test('a text past its per-entry limit is parsed once per compile and not held', () => {
    const q = `g.inject('${'x'.repeat(PARSE_CACHE_MAX_ENTRY_TEXT_UNITS)}')`;
    const before = parseCacheStats();
    compilePlan(q, {}, { app: scope() });
    compilePlan(q, {}, { app: scope() });
    const after = parseCacheStats();
    // One miss is one parse: a compile parses the text once, not again for the volatility test.
    expect(after.misses - before.misses).toBe(2);
    expect(after.hits - before.hits).toBe(0);
    expect(after.weight).toBeLessThanOrEqual(before.weight);
  });
});
