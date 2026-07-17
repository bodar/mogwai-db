// End-to-end exactness for the types that must NOT funnel through a JS number:
// bigdecimal, char, duration, and long/bigint past 2^53. A value is written via a normal
// traversal (parse → storedScalar → bind) and read back via values() over GraphBinary
// (frame → readResponse), then asserted EXACT. These would all lose precision under the
// old parseInt/parseFloat + bigint→Number path (see do-sqlite-bind-precision).
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
import { streamBuffers } from '../src/http.ts';
import { ioc } from '../src/io.ts';
import { BigDecimal, Duration } from '../src/gremlin-types.ts';

async function values(gremlin: string, writes: string[]): Promise<any[]> {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(store, w, {});
  const buffers = executeQuery(store, gremlin, {});
  const res = streamBuffers(buffers, 64);
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  const parsed = (ioc as any).graphBinaryReader.readResponse(Buffer.concat(chunks));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

describe('exact BigDecimal round-trip', () => {
  test('a 30-digit decimal f64 cannot hold survives write→read', async () => {
    const exact = '3.141592653589793238462643383279';
    const [v] = await values("g.V().values('bd')", [`g.addV('t').property('bd', ${exact}m)`]);
    expect(v).toBeInstanceOf(BigDecimal);
    expect(v.toString()).toBe(exact);
    // sanity: this value is genuinely beyond f64 (the old parseFloat path would differ)
    expect(v.toString()).not.toBe(String(parseFloat(exact)));
  });
});

describe('exact Duration round-trip', () => {
  test('Duration(90, 500000000) survives with nanos intact', async () => {
    const [v] = await values("g.V().values('d')", [`g.addV('t').property('d', Duration(90, 500000000))`]);
    expect(v).toBeInstanceOf(Duration);
    expect(v.seconds).toBe(90n);
    expect(v.nanos).toBe(500000000);
  });
});

describe('char round-trip', () => {
  test("'x'c frames as a Char (1-char string), distinct from a String property", async () => {
    const [v] = await values("g.V().values('c')", [`g.addV('t').property('c', 'x'c)`]);
    expect(v).toBe('x');
  });
});

describe('exact long past 2^53', () => {
  test('9007199254740993l (2^53+1) survives — the funnel bug is dead', async () => {
    const [v] = await values("g.V().values('n')", [`g.addV('t').property('n', 9007199254740993l)`]);
    // longSerializer.deserialize returns a BigInt for out-of-safe-range values
    expect(v).toBe(9007199254740993n);
  });
  test('a small long still round-trips as a JS number', async () => {
    const [v] = await values("g.V().values('n')", [`g.addV('t').property('n', 42l)`]);
    expect(v).toBe(42);
  });
});

describe('numeric ordering/range over the exact tail (option b)', () => {
  // A key mixing a small long (numeric storage) with two big ones (TEXT storage) —
  // plain SQL would order the TEXT rows lexically / after the numeric one. compareKey
  // makes order() and range() numeric regardless of storage class.
  const writes = [
    `g.addV('t').property('n', 9007199254740993l)`,  // 2^53+1  (TEXT)
    `g.addV('t').property('n', 10000000000000000l)`, // 1e16    (TEXT)
    `g.addV('t').property('n', 999999999999999l)`,   // ~1e15   (numeric, < 2^53)
  ];
  test('order().by(long) is numeric, not lexical', async () => {
    const out = await values("g.V().order().by('n').values('n')", writes);
    expect(out.map((v) => BigInt(v).toString())).toEqual(
      ['999999999999999', '9007199254740993', '10000000000000000']);
  });
  test('range filter over a big long compares numerically', async () => {
    const out = await values("g.V().has('n', P.gt(9007199254740992l)).values('n')", writes);
    // 2^53+1 and 1e16 exceed 2^53; ~1e15 does not
    expect(out.map((v) => BigInt(v).toString()).sort()).toEqual(
      ['10000000000000000', '9007199254740993']);
  });
  test('bigdecimal ordering is numeric', async () => {
    const out = await values("g.V().order().by('d').values('d')", [
      `g.addV('t').property('d', 10.5m)`,
      `g.addV('t').property('d', 9.9m)`,
      `g.addV('t').property('d', 100.25m)`,
    ]);
    expect(out.map((v) => v.toString())).toEqual(['9.9', '10.5', '100.25']);
  });
});
