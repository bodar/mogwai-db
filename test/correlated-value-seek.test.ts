import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { loadBulk } from '../src/bulk.ts';
import { compile } from '../src/compiler/compiler.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';
import { exec } from './support/executor.ts';
import { decode } from './support/decode.ts';

// A `has(k, v)` WHOSE VALUE IS READ OFF AN OUTER ROW — `V().values('name').as('e').V().has('name', select('e'))`,
// a value join — narrows through the `(key, value)` property index PER OUTER ROW.
//
// The property `EXISTS` a `has()` lowers to can only CHECK an element SQLite already holds, so a re-source `V()`
// meeting a correlated value was a full graph scan per incoming traverser: measured on trunk 818 ms at 1k
// vertices → 50.6 s at 8k (62×). The semijoin pass (`src/rel/passes/semijoin.ts`, `narrowFilter`) now adds
// `element.id IN (SELECT owner FROM vertex_properties WHERE key = k AND value = <outer value>)` beside the
// untouched `EXISTS`: the same rows by construction (the conjunct is implied by the predicate it stands next
// to), driven from the index. The pass walks correlated subplans (`rewriteRels`), so the same narrowing
// reaches a `group().by()`/`project().by()` value traversal, a union arm, and a federated sibling's per-key
// count without a case for any of them.
//
// Every query here is checked against the generic path (`propertySeek` off) — the seek narrows, never decides
// — and against a closed-form count; the scaling tests assert ~linear growth at 1k → 8k (quadratic is 64×).

/** `n` vertices `u0…`, labelled alternately `q`/`p`, vertex i named `n{i mod n/2}` (so each name is held by
 *  exactly TWO vertices) with `k = i mod 3`, and a ring of `x` edges i → i+1. */
function graph(n: number, sql: (raw: BunSqlite) => import('../src/api.ts').Sql = (raw) => raw): GraphStore {
  const store = new GraphStore(sql(new BunSqlite(':memory:')));
  loadBulk(
    store,
    Array.from({ length: n }, (_, i) => ({ id: `u${i}`, labels: [i % 2 ? 'p' : 'q'], properties: [{ key: 'name', value: `n${i % (n / 2)}` }, { key: 'k', value: i % 3 }] })),
    Array.from({ length: n }, (_, i) => ({ label: 'x', src: `u${i}`, tgt: `u${(i + 1) % n}` })),
  );
  return store;
}

const SCALE_TIMEOUT_MS = 60_000;
const OFF = { ...DEFAULT_FAST_PATHS, propertySeek: false };
const answer = async (store: GraphStore, q: string, params: Record<string, unknown> = {}, fastPaths = DEFAULT_FAST_PATHS) =>
  Promise.all(exec(store, undefined, fastPaths).buffers(q, params).map((b) => decode(b)));

/** Best of three wall times — one warm-up run first, so compile and statement-cache cost are not measured. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  await run();
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** 1k → 8k is 8× more rows. Linear is ≈8×, N log N ≈10×; quadratic is 64×. The 5 ms floor keeps a
 *  sub-millisecond 1k time from turning scheduler noise into a ratio. */
const expectLinear = (small: number, large: number) => expect(large / Math.max(small, 5)).toBeLessThan(20);

const VALUE_JOIN = "g.V().values('name').as('e').V().has('name', select('e')).count()";

describe('a correlated has(k, select(…)) seeks the property index per outer row', () => {
  const small = graph(1_000);
  const large = graph(8_000);

  test('the value join answers the closed form (every vertex meets the two holding its name) at 1k and 8k', async () => {
    expect(await answer(small, VALUE_JOIN)).toEqual([2_000]);
    expect(await answer(large, VALUE_JOIN)).toEqual([16_000]);
  }, SCALE_TIMEOUT_MS);

  for (const [name, q, params] of [
    ['a re-source V() after values()', VALUE_JOIN, {}],
    ['an injected collection PARAMETER, unfolded', "g.inject(xs).unfold().as('e').V().has('name', select('e')).count()", 'xs'],
    ['after hasLabel() — a label membership on the same element does not take the access path', "g.V().values('name').as('e').V().hasLabel('p').has('name', select('e')).out().count()", {}],
    ['inside a group().by() value traversal', "g.V().group().by('name').by(__.values('name').as('e').V().has('name', select('e')).count()).select(values).unfold().sum()", {}],
    ['in both arms of a union()', "g.V().values('name').as('e').union(__.V().has('name', select('e')), __.V().has('name', select('e')).out()).count()", {}],
  ] as const) {
    test(`${name}: linear from 1k to 8k`, async () => {
      const bind = (n: number) => (params === 'xs' ? { xs: Array.from({ length: n }, (_, i) => `n${i}`) } : {});
      const t1 = await timed(() => answer(small, q, bind(1_000)));
      const t8 = await timed(() => answer(large, q, bind(8_000)));
      expectLinear(t1, t8);
    }, SCALE_TIMEOUT_MS);
  }
});

describe('the narrowing NARROWS and never decides', () => {
  const store = graph(200);
  for (const q of [
    VALUE_JOIN,
    "g.V().values('name').as('e').V().hasLabel('p').has('name', select('e')).values('k').sum()",
    "g.V().values('name').as('e').V().has('name', select('e')).has('k', 1).count()",
    "g.V().as('a').values('name').as('e').V().has('name', select('e')).where(neq('a')).count()",
    "g.V().values('name').as('e').V().has('name', select('e')).as('m').select('e', 'm').count()",
    "g.V().project('n', 'c').by('name').by(__.values('name').as('e').V().has('name', select('e')).count()).select('c').sum()",
    "g.V().values('name').as('e').V('u0').has('name', select('e')).count()",
    "g.V().values('name').as('e').V().hasId(within(1, 2, 3)).has('name', select('e')).count()",
    "g.E().as('x').outV().values('name').as('e').V().has('name', select('e')).count()",
  ]) {
    test(`propertySeek on = off: ${q}`, async () => {
      expect(await answer(store, q)).toEqual(await answer(store, q, {}, OFF));
    });
  }
});

describe('the access path', () => {
  const store = graph(1_000);
  const plan = (q: string): string[] => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    return (store.query(`EXPLAIN QUERY PLAN ${p.sql}`, [...p.binds]) as { id: number; parent: number; detail: string }[])
      .map((r) => r.detail);
  };
  const correlatedSeek = (details: readonly string[]) => {
    const at = details.findIndex((d) => d.startsWith('CORRELATED LIST SUBQUERY'));
    return at >= 0 && details[at + 1]!.includes('vp_key_value (key=? AND value=?)');
  };

  test('the value join seeks vp_key_value(key, value) under a CORRELATED subquery', () => {
    expect(correlatedSeek(plan(VALUE_JOIN))).toBe(true);
  });

  test('a string id V(\'u0\') is respected as a bound — no per-outer-row seek', () => {
    expect(correlatedSeek(plan("g.V().values('name').as('e').V('u0').has('name', select('e')).count()"))).toBe(false);
  });

  test('a key restriction on the element (has(T.id, lt(4))) stays the access path', () => {
    expect(correlatedSeek(plan("g.V().values('name').as('e').V().has(T.id, lt(4)).has('name', select('e')).count()"))).toBe(false);
  });

  test('a CONSTANT seek outranks the correlated one', () => {
    const q = "g.V().values('name').as('e').V().has('k', 1).has('name', select('e')).count()";
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    // The constant `has('k', 1)` is the lifted seek the re-source is driven from; no correlated seek joins it.
    expect(p.sql).toContain("key = 'k'");
    expect(correlatedSeek(plan(q))).toBe(false);
  });

  test('an element reached by a join key (out()) is not narrowed — the edge already drives it', () => {
    expect(correlatedSeek(plan("g.V().as('a').values('name').as('e').select('a').out().has('name', select('e')).count()"))).toBe(false);
  });
});

describe('a federated sibling reads its per-parent value through the same seek', () => {
  const managerOf = (n: number) => {
    const mgr = new BunGraphManager(undefined, extendedRegistry, undefined, undefined, (source) => new CfLimitedSql(new BunSqlite(source)));
    loadBulk(mgr.storeOf('x'), Array.from({ length: n }, (_, i) => ({ labels: ['person'], properties: [{ key: 'name', value: `n${i}` }, { key: 'age', value: i }] })));
    loadBulk(mgr.storeOf('home'), Array.from({ length: n }, (_, i) => ({ labels: ['p'], properties: [{ key: 'name', value: `n${i}` }, { key: 'i', value: i }] })));
    return mgr;
  };
  const run = async (mgr: BunGraphManager, q: string) => Promise.all((await mgr.executor('home').framedAsync(q, {})).map((f) => decode(f.buf)));

  for (const q of [
    "g.V().hasLabel('p').values('name').as('e').call('federate',['graph':'x']).V().has('name', select('e')).count()",
    "g.V().hasLabel('p').values('name').as('e').call('federate',['graph':'x','traversal':__.V().has('name', select('e'))]).count()",
  ]) {
    test(`P = N = 1k → 8k, linear, on a DO-limited store: ${q}`, async () => {
      const small = managerOf(1_000);
      const large = managerOf(8_000);
      expect(await run(small, q)).toEqual([1_000]);
      expect(await run(large, q)).toEqual([8_000]);
      expectLinear(await timed(() => run(small, q)), await timed(() => run(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  test('a federate traversal ending in a VALUE over a parent label declines cleanly, never a bare Error', async () => {
    const mgr = managerOf(20);
    const q = "g.V().hasLabel('p').values('i').as('e').call('federate',['graph':'x','traversal':__.V().has('age', select('e')).count()])";
    await expect(run(mgr, q)).rejects.toMatchObject({ name: 'UnsupportedTraversal' });
  });
});
