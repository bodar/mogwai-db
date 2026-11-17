import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { loadBulk } from '../src/bulk.ts';
import { compile } from '../src/compiler/compiler.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';
import { exec } from './support/executor.ts';
import { decode } from './support/decode.ts';
import { seededStore, zooStore } from './support/harness.ts';

// A CORRELATED re-source filtered over an OWNER-JOINED property row — `V().where(neq('a')).values('name').is(c)`,
// `properties('name').hasValue(c)` — narrows its candidates by the property seek exactly as `has('name', c)` does
// (`ownerJoined`, `src/rel/passes/leading.ts`): the spine conjunct over the property row becomes a candidate
// `EXISTS(props WHERE props.owner = cand.id AND …)`, the shape `semijoin`'s `ownerColumn`/`indexSeek` recognise, so
// the candidates read `vp_key_value` once per statement. Before it a MISS read the whole graph per host:
// measured 767 ms at 1k → 3.2 s at 2k vertices on the `is('zzz')` shape below.
//
// The conjunct only NARROWS — the body's own filter still decides — so every answer is checked against the plan
// with the seek strategies off (`propertySeek`), and the scaling test asserts ~linear growth 1k → 8k.

const OFF = { ...DEFAULT_FAST_PATHS, propertySeek: false };
const answer = async (store: GraphStore, q: string, fastPaths = DEFAULT_FAST_PATHS) =>
  Promise.all(exec(store, undefined, fastPaths).buffers(q, {}).map((b) => decode(b)));
const sql = (q: string, fastPaths = DEFAULT_FAST_PATHS): string => {
  const p = compile(q, {}, { fastPaths });
  if (p.kind !== 'read') throw new Error('expected a read plan');
  return p.sql;
};
/** The narrowing `IN` the property seek places on the leading candidates. */
const narrowed = (q: string, fastPaths = DEFAULT_FAST_PATHS): boolean => /IN \(SELECT rsk\d+\.(node|edge) AS sid FROM (vertex|edge)_properties/.test(sql(q, fastPaths));

const SEEKS = [
  "g.V().as('a').where(V().where(neq('a')).values('name').is('marko')).values('name')",
  "g.V().as('a').map(V().where(neq('a')).values('name').is('josh')).count()",
  "g.V().as('a').where(V().where(neq('a')).properties('name').hasValue('marko')).values('name')",
  "g.V().as('a').where(V().where(neq('a')).properties('name').hasValue('marko').value()).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name').is('zzz')).count()",
  "g.V().as('a').where(V().where(neq('a')).values('age').is(gt(30))).values('name')",
  "g.V().as('a').not(V().where(neq('a')).values('age').is(gt(30))).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('age').is(lt(30)).is(gt(26))).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(within('marko','josh'))).values('name')",
  "g.V().as('a').local(where(V().where(neq('a')).values('name').is('vadas'))).values('name')",
  "g.V().as('a').union(where(V().where(neq('a')).values('name').is('vadas')), constant('x')).count()",
  "g.V().as('a').where(E().where(outV().where(neq('a'))).values('weight').is(0.5)).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name','age').is('marko')).values('name')",
  // A TextP spells SEVERAL conjuncts over the one property row (a type test, the `like`, the `instr`); they go
  // in ONE owner `EXISTS` (`ownerProbe`), so the seek lifts the whole conjunction, not the type test alone.
  "g.V().as('a').where(V().where(neq('a')).values('name').is(containing('zz'))).count()",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('zz'))).count()",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(endingWith('zz'))).count()",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(containing('ar'))).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('jo'))).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(endingWith('sh'))).values('name')",
  "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('m')).is(endingWith('o'))).values('name')",
  "g.V().as('a').not(V().where(neq('a')).values('name').is(notContaining('o'))).values('name')",
];

/** The owner-probe `EXISTS`es `leading` puts on the candidates — `SELECT <props>.node AS one FROM vertex_properties`. */
const ownerProbes = (q: string): number => sql(q).match(/EXISTS \(SELECT \w+\.node AS one FROM vertex_properties/g)?.length ?? 0;

describe('a filter over an owner-joined property row narrows the leading candidates', () => {
  for (const q of SEEKS) {
    test(`the property seek recognises the candidate filter: ${q}`, () => {
      expect(narrowed(q)).toBe(true);
      expect(narrowed(q, OFF)).toBe(false);
    });
  }

  for (const q of [
    "g.V().as('a').where(V().where(neq('a')).values('name').is(containing('zz'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('zz'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(endingWith('zz'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('m')).is(endingWith('o'))).values('name')",
  ]) {
    test(`every conjunct over the one property row is ONE owner EXISTS: ${q}`, () => {
      expect(ownerProbes(q)).toBe(1);
    });
  }

  test('a property row joined to a HOP, not to the leading element, is not its candidate filter', () => {
    expect(narrowed("g.V().as('a').where(V().where(neq('a')).out().values('name').is('josh')).count()")).toBe(false);
  });
});

describe('the narrowing NARROWS and never decides', () => {
  const modern = seededStore();
  for (const q of SEEKS) {
    test(`propertySeek on = off: ${q}`, async () => {
      expect(await answer(modern, q)).toEqual(await answer(modern, q, OFF));
    });
  }

  test('modern: every vertex but marko meets another marko', async () => {
    expect((await answer(modern, SEEKS[0]!)).sort()).toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
  });

  // `Cardinality.list`: an owner holding the value among several still counts once (the seek is a set test).
  const zoo = zooStore();
  for (const q of [
    "g.V().as('a').where(V().where(neq('a')).values('diet').is('squid')).values('name')",
    "g.V().as('a').where(V().where(neq('a')).properties('diet').hasValue('fish')).count()",
    "g.V().as('a').map(V().where(neq('a')).values('diet').is(startingWith('f'))).count()",
    // Two conjuncts over a list key: met by DIFFERENT rows of one vertex (`fish` starts with f, `squid` ends
    // with d) is not a row the body keeps; one probe holds both conjuncts of ONE row, so it agrees.
    "g.V().as('a').where(V().where(neq('a')).values('diet').is(startingWith('f')).is(endingWith('d'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('diet').is(startingWith('s')).is(endingWith('d'))).count()",
  ]) {
    test(`zoo, propertySeek on = off: ${q}`, async () => {
      expect(await answer(zoo, q)).toEqual(await answer(zoo, q, OFF));
    });
  }

  test('zoo: conjuncts met by different rows of a list key do not admit the owner', async () => {
    expect(await answer(zoo, "g.V().as('a').where(V().where(neq('a')).values('diet').is(startingWith('f')).is(endingWith('d'))).count()")).toEqual([0]);
    expect(await answer(zoo, "g.V().as('a').where(V().where(neq('a')).values('diet').is(startingWith('s')).is(endingWith('d'))).count()")).not.toEqual([0]);
  });

  test('modern: TextP over the owner-joined row', async () => {
    expect((await answer(modern, "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('m')).is(endingWith('o'))).values('name')")).sort())
      .toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
    expect(await answer(modern, "g.V().as('a').where(V().where(neq('a')).values('name').is(containing('zz'))).count()")).toEqual([0]);
  });
});

describe('scaling', () => {
  /** `n` vertices `p{i}` with a ring of edges — enough for a re-source per host. */
  const graph = (n: number): GraphStore => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    loadBulk(
      store,
      Array.from({ length: n }, (_, i) => ({ id: i + 1, labels: ['person'], properties: [{ key: 'name', value: `p${i + 1}` }] })),
      Array.from({ length: n }, (_, i) => ({ label: 'knows', src: i + 1, tgt: ((i + 1) % n) + 1 })),
    );
    return store;
  };
  const timed = async (run: () => Promise<unknown>): Promise<number> => {
    await run();
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await run();
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const small = graph(1_000);
  const large = graph(8_000);
  for (const q of [
    "g.V().as('a').where(V().where(neq('a')).values('name').is('zzz')).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is('p7')).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(containing('zz'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(startingWith('zz'))).count()",
    "g.V().as('a').where(V().where(neq('a')).values('name').is(endingWith('zz'))).count()",
  ]) {
    test(`linear from 1k to 8k: ${q}`, async () => {
      const t1 = await timed(() => answer(small, q));
      const t8 = await timed(() => answer(large, q));
      expect(t8 / Math.max(t1, 5)).toBeLessThan(20);
    }, 60_000);
  }
});
