// SQLite's decimal <-> binary64 conversion is exact only near 1 (`src/rel/exact-decimal.ts`). These pin the
// measured fact the range rests on, and the two JS-side authorities that keep a value off SQLite's decimal
// text outside it: a compiler literal is spelled as an exact product, and a JSON tree headed into SQLite refuses.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { stringifyExact } from '../src/json-exact.ts';
import { EXACT_DECIMAL_MAX, EXACT_DECIMAL_MIN, exactRealSpelling, hasExactDecimal } from '../src/rel/exact-decimal.ts';
import { RaisedByQuery } from '../src/rel/raise.ts';

const db = new Database(':memory:');
const select = (sql: string): unknown => (db.query(`SELECT ${sql} AS x`).get() as { x: unknown }).x;

/** A deterministic spread of doubles of 1-17 significant digits over the whole binary64 range. */
function* doubles(count: number): Generator<number> {
  let s = 20261017;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < count; i++) {
    const v = Number(((1 + rnd() * 9) * 10 ** (Math.floor(rnd() * 632) - 324)).toPrecision(1 + (i % 17))) * (i % 2 ? -1 : 1);
    if (Number.isFinite(v) && v !== 0) yield v;
  }
}

describe("SQLite's decimal text is NOT exact far from 1 — the fact the range rests on", () => {
  test('a literal beyond the range reads back as another number', () => {
    expect(select('1.5e-300')).not.toBe(1.5e-300);
    expect(select("printf('%!.17g', 3.743024233818054E203)")).not.toBe('3.743024233818054e+203');
  });
  test('inside the range, every 15-17 digit spelling round-trips through printf and the reader', () => {
    let wrong = 0;
    for (const v of doubles(20000)) {
      if (Math.abs(v) < EXACT_DECIMAL_MIN || Math.abs(v) > EXACT_DECIMAL_MAX) continue;
      if (select(String(v)) !== v || Number(select(`printf('%!.17g', ${String(v)})`)) !== v) wrong++;
    }
    expect(wrong).toBe(0);
  });
});

describe('a compiler literal outside the range is spelled as an exact product', () => {
  test('every spelling evaluates to exactly its value, subnormals and the extremes included', () => {
    const values = [5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, -1.7976931348623157e308,
      1.5e-300, 3.7430242338180544e203, 3.2101885945796966e119, ...doubles(5000)];
    for (const v of values) {
      const spelled = exactRealSpelling(v);
      if (hasExactDecimal(v)) expect(spelled).toBeNull();
      else expect([v, select(spelled!)]).toEqual([v, v]);
    }
  });
});

describe('a JSON tree headed into SQLite refuses a number outside the range', () => {
  test('refuses, at any depth', () => {
    for (const tree of [[1.5e-300], { a: [3.2101885945796966e119] }, 1e300])
      expect(() => stringifyExact(tree)).toThrow(RaisedByQuery);
  });
  test('keeps everything else', () => {
    expect(stringifyExact([1e116, 1e-80, 0, -0, Infinity, 0.30000000000000004, 12345678901234567890])).toBe(
      '[1e+116,1e-80,0,0,9.0e+999,0.30000000000000004,12345678901234567000]');
  });
});
