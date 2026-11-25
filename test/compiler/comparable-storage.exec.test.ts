// A STORED NUMBER IS ITS COMPARABLE FORM; ITS EXACT DIGITS ARE FOR OUTPUT ONLY.
//
// A property row keeps every number in `value` as SQLite compares and indexes it natively — a BigDecimal as
// its REAL, a long as its INTEGER, a BigInteger past int64 as its REAL — and the digits a JS number cannot
// carry (a BigDecimal, a long/bigint past ±2^53) in `exact` (`storedForm`, src/compiler/rel/build.ts). So
// every compare, seek and sort reads `value` with no decimal arm (the documented "a BigDecimal compares at
// double precision", `docs/limitations.md`), and every reader that hands the value onward reads the digits.
// A STREAM (`inject(1m)`, `values(k).is(…)`) still carries a number as decimal TEXT and keeps its arm.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../../src/cf-limits.ts';
import { loadGraphson, writeGraphson } from '../../src/formats/graphson.ts';
import { exec, executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';
import { read } from '../support/harness.ts';

const fresh = (): GraphStore => new GraphStore(new BunSqlite(':memory:'));
const store = (...writes: string[]): GraphStore => {
  const s = fresh();
  for (const w of writes) executeQuery(s, w, {});
  return s;
};
/** A decoded value as text: a BigDecimal as its digits and scale, a bigint as its digits + `n`. */
const show = (v: any): string => typeof v === 'bigint' ? `${v}n`
  : v && typeof v === 'object' && 'unscaled' in v ? `${v.unscaled}e-${v.scale}m`
    : Array.isArray(v) ? `[${v.map(show).join(',')}]`
      : v instanceof Map ? `{${[...v].map(([k, x]) => `${show(k)}:${show(x)}`).join(',')}}`
        : JSON.stringify(v);
const answer = async (s: GraphStore, q: string, params: Record<string, unknown> = {}): Promise<string[]> =>
  (await decodeAll(executeQuery(s, q, params))).map(show);

describe('a stored BigDecimal compares by its number', () => {
  const ages = (): GraphStore => store("g.addV('p').property('age', 29m)", "g.addV('p').property('age', 29)", "g.addV('p').property('age', 'x')");
  test('a list parameter meets a stored 29m', async () => {
    expect(await answer(ages(), "g.V().has('age', within(xs)).count()", { xs: [29, 30] })).toEqual(['2']);
  });
  test('a range meets a stored 29m', async () => {
    expect(await answer(ages(), "g.V().has('age', gt(28)).count()")).toEqual(['2']);
    expect(await answer(ages(), "g.V().has('age', between(28.5m, 29.5m)).count()")).toEqual(['2']);
  });
  test('a String spelling the number never equals it', async () => {
    const s = store("g.addV('p').property('n', '31')", "g.addV('p').property('n', 31m)");
    expect(await answer(s, "g.V().has('n', 31.0m).count()")).toEqual(['1']);
    expect(await answer(s, "g.V().has('n', within(31.0m, 5)).count()")).toEqual(['1']);
  });
  test('an 18-digit BigDecimal finds itself, and frames with its exact digits', async () => {
    const s = store("g.addV('p').property('n', 123456789012345678m)");
    expect(await answer(s, "g.V().has('n', 123456789012345678m).count()")).toEqual(['1']);
    expect(await answer(s, "g.V().has('n', 123456789012345678m).values('n')")).toEqual(['123456789012345678e-0m']);
    expect(await exec(s).jsonAsync("g.V().has('n', 123456789012345678m).values('n')", {})).toContain('123456789012345678');
  });
  test('a scale survives: 2.50m frames as 2.50 and still equals 2.5', async () => {
    const s = store("g.addV('p').property('price', 2.50m)");
    expect(await answer(s, "g.V().has('price', 2.5).values('price')")).toEqual(['250e-2m']);
  });
  test('order().by(key) over int and BigDecimal sorts numerically', async () => {
    const s = store(...[3, '2.5m', '10m', 1, '-0.5m', 9.75].map((p) => `g.addV('p').property('price', ${p})`));
    expect(await answer(s, "g.V().order().by('price').values('price')")).toEqual(['-5e-1m', '1', '25e-1m', '3', '9.75', '10e-0m']);
    expect(await answer(s, "g.V().order().by('price', desc).limit(2).values('price')")).toEqual(['10e-0m', '9.75']);
  });
  test('a stream subject keeps its arm', async () => {
    expect(await answer(fresh(), 'g.inject(1m).is(1)')).toEqual(['1e-0m']);
    const s = store("g.addV('p').property('n', 2.5m)");
    expect(await answer(s, "g.V().values('n').is(gt(2))")).toEqual(['25e-1m']);
  });
});

describe('a long past 2^53 is stored as its INTEGER and round-trips exactly', () => {
  for (const [name, mk] of [['Bun', fresh], ['cf-limits', () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')))]] as const) {
    test(name, async () => {
      const s = mk();
      executeQuery(s, "g.addV('p').property('n', 1152921504606846977L)", {});
      expect(await answer(s, "g.V().has('n', 1152921504606846977L).values('n')")).toEqual(['1152921504606846977n']);
      expect(await answer(s, "g.V().has('n', 1152921504606846976L).count()")).toEqual(['0']);
      expect(typedAll(executeQuery(s, "g.V().values('n')", {}))).toEqual(['1152921504606846977L']);
      expect(s.query("SELECT typeof(value) AS t FROM vertex_properties", [])).toEqual([{ t: 'integer' }]);
    });
  }
});

describe('the exact digits reach every output', () => {
  const s = (): GraphStore => store("g.addV('p').property('d', 98765432109876543.21m).property('n', 1152921504606846977L)");
  test('valueMap, elementMap, properties().value(), a by() of a project', async () => {
    expect(await answer(s(), "g.V().valueMap('d')")).toEqual(['{"d":[9876543210987654321e-2m]}']);
    expect(await answer(s(), "g.V().elementMap('n').select('n')")).toEqual(['1152921504606846977n']);
    expect(await answer(s(), "g.V().properties('d').value()")).toEqual(['9876543210987654321e-2m']);
    expect(await answer(s(), "g.V().project('d').by('d').select('d')")).toEqual(['9876543210987654321e-2m']);
  });
  test('the JSON response', async () => {
    const json = await exec(s()).jsonAsync("g.V().values('d', 'n').fold()", {});
    expect(json).toContain('98765432109876543.21');
    expect(json).toContain('1152921504606846977');
  });
  test('a GraphSON round trip', async () => {
    const copy = fresh();
    loadGraphson(copy, writeGraphson(s()));
    expect((await answer(copy, "g.V().has('d', 98765432109876543.21m).values('d', 'n')")).sort()).toEqual(['1152921504606846977n', '9876543210987654321e-2m']);
  });
  test('a computed write carries the digits', async () => {
    const t = s();
    executeQuery(t, "g.V().property('e', values('d'))", {});
    expect(await answer(t, "g.V().has('e', 98765432109876543.21m).values('e')")).toEqual(['9876543210987654321e-2m']);
  });
});

describe('at depth: a stored compare composes under every host', () => {
  const s = (): GraphStore => store("g.addV('p').property('price', 2.5m).addV('q').property('price', 3).addV('r').property('price', 7.25m)");
  for (const [q, want] of [
    ["g.V().where(has('price', gt(2.6))).count()", ['2']],
    ["g.V().not(has('price', 2.5)).count()", ['2']],
    ["g.V().union(has('price', 2.5), has('price', 7.25m)).count()", ['2']],
    ["g.V().local(has('price', within(3, 7.25))).count()", ['2']],
    ["g.V().choose(has('price', 7.25m), constant(1), constant(0)).sum()", ['1']],
    ["g.V().coalesce(has('price', 3.0m).values('price'), constant(0)).sum()", ['3']],
    ["g.V().group().by(values('price').is(gt(2))).by(count()).select(keys).unfold().count()", ['3']],
    ["g.V().as('a').has('price', 2.5m).select('a').count()", ['1']],
  ] as const) {
    test(q, async () => {
      expect(await answer(s(), q)).toEqual([...want]);
    });
  }
});

// A NESTED operand hands on the value's PAYLOAD — a BigDecimal's or a wide long's decimal TEXT — while the
// stored row holds its comparable REAL/INTEGER, so the compare is by Gremlin type (`valueTheta`,
// `scalarMembership`), never raw: a raw `=` dropped every row here, including a row equal to itself.
describe('a nested operand meets a stored BigDecimal or wide long', () => {
  const prices = (): GraphStore => store(
    "g.addV('p').property('i', 1).property('price', 10.00m).property('list', 10.00m)",
    "g.addV('p').property('i', 2).property('price', 12.50m).property('list', 10m)",
    "g.addV('p').property('i', 3).property('price', 8).property('list', 8.0m)",
    "g.addV('p').property('i', 4).property('price', 12345678901234567L).property('list', 12345678901234567L)");
  const sorted = async (s: GraphStore, q: string): Promise<string[]> => (await answer(s, q)).sort();
  for (const [q, want] of [
    ["g.V().has('price', P.eq(__.values('list'))).values('i')", ['1', '3', '4']],
    ["g.V().has('price', __.values('list')).values('i')", ['1', '3', '4']],
    ["g.V().has('price', P.eq(__.values('price'))).values('i')", ['1', '2', '3', '4']],
    ["g.V().has('price', P.gt(__.values('list'))).values('i')", ['2']],
    ["g.V().has('price', P.lte(__.values('list'))).values('i')", ['1', '3', '4']],
    ["g.V().has('price', P.eq(__.V().has('i', 4).values('list'))).values('i')", ['4']],
    ["g.V().has('price', P.within(__.V().values('list').fold())).values('i')", ['1', '3', '4']],
    ["g.V().has('price', P.without(__.V().values('list').fold())).values('i')", ['2']],
    ["g.V().has('price', P.within(__.values('list'), __.constant(99))).values('i')", ['1', '3', '4']],
    ["g.V().has('i', 1).values('price').as('pp').V().has('price', select('pp')).values('i')", ['1']],
    ["g.V().as('a').V().has('price', P.eq(__.select('a').values('list'))).values('i')", ['1', '1', '3', '4']],
    ["g.V().where(has('price', P.eq(__.values('list')))).values('i')", ['1', '3', '4']],
    ["g.V().local(has('price', P.within(__.V().values('list').fold()))).values('i')", ['1', '3', '4']],
    ["g.V().has('price', P.not(P.lt(__.values('list')))).values('i')", ['1', '2', '3', '4']],
  ] as const) {
    test(q, async () => {
      expect(await sorted(prices(), q)).toEqual([...want]);
    });
  }
  test('a wide long and a String spelling a BigDecimal', async () => {
    const s = store(
      "g.addV('p').property('k', 'x').property('w', 9007199254740993L).property('d', 1.5m)",
      "g.addV('p').property('k', 'y').property('w', 9007199254740993L).property('d', 1.5)",
      "g.addV('p').property('k', 'z').property('d', '1.5').property('w', 5L)");
    expect(await sorted(s, "g.V().has('k', 'x').values('w').as('ww').V().has('w', select('ww')).values('k')")).toEqual(['"x"', '"y"']);
    expect(await sorted(s, "g.V().has('k', 'x').as('a').V().has('w', gte(__.select('a').values('w'))).values('k')")).toEqual(['"x"', '"y"']);
    expect(await sorted(s, "g.V().has('w', within(__.V().has('k', 'x').values('w').fold())).values('k')")).toEqual(['"x"', '"y"']);
    // `1.5m` equals the Double `1.5` and never the String '1.5'.
    expect(await sorted(s, "g.V().has('k', 'x').as('a').V().has('d', __.select('a').values('d')).values('k')")).toEqual(['"x"', '"y"']);
  });
});

describe('a merge by a BigDecimal key upserts one element', () => {
  test('a constant map and a computed project', async () => {
    const t = store("g.addV('p').property('sku', 'a').property('price', 2.50m)");
    executeQuery(t, "g.inject([sku:'a', price:2.5]).mergeV()", {});
    executeQuery(t, "g.V().has('sku','a').mergeV(__.project('sku','price').by('sku').by('price'))", {});
    expect(await answer(t, 'g.V().count()')).toEqual(['1']);
  });
});

describe('the plan', () => {
  test("has('Post','ID',962077547172) is one (key, value) SEARCH", () => {
    const s = fresh();
    const { sql, binds } = read("g.V().has('Post','ID',962077547172).count()");
    const details = s.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [...binds]).map((r) => r.detail);
    expect(details.filter((d) => d.includes('vp_key_value'))).toEqual([expect.stringContaining('(key=? AND value=?)')]);
  });
  test('an ordering against a nested operand seeks the element\'s (node, key) row, never a value range', () => {
    const s = fresh();
    for (const q of ["g.V().has('price', gt(__.values('list'))).count()", "g.V().has('price', gt(__.V().has('i', 4).values('list'))).count()"]) {
      const { sql, binds } = read(q);
      const details = s.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [...binds]).map((r) => r.detail);
      expect(details.filter((d) => d.includes('value>'))).toEqual([]);
    }
  });
  test('no decimal index exists', () => {
    expect(fresh().query("SELECT name FROM sqlite_master WHERE name LIKE '%decimal%'", [])).toEqual([]);
  });
});
