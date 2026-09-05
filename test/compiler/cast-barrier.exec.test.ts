// A bare `asNumber()`/`asBool()` over a RUNTIME per-row stream (`values(k)`) declines in SQL — the value
// could be a non-numeric string that `AsNumberStep`/`AsBoolStep` must RAISE on, and SQL cannot raise per
// row. It lowers instead as a JS value-transform barrier (`cast-barrier.ts`) that runs `coerce.ts`'s own
// coercion, so the runtime path raises TinkerPop's exact message and a numeric/datetime value passes
// through as the reference's identity. See the value-carriage worklist (RelIR §10, §6·7).
import { test, expect, describe } from 'bun:test';
import { storeSeededWith } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

// The AsNumber.feature birthday graph — epoch-millis stored as numbers.
const BIRTHDAYS = ['g.addV("person").property("name","alice").property("birthday",1596326400000)'
  + '.addV("person").property("name","john").property("birthday",597715200000)'];
const framed = (q: string) => decodeAll(executeFramed(storeSeededWith(BIRTHDAYS), q).map((f) => f.buf));
const asc = (xs: number[]) => [...xs].sort((a, b) => a - b);
const EPOCHS = [597715200000, 1596326400000];

describe('bare asNumber() over a per-row stream — the cast barrier', () => {
  test('asNumber() over a numeric per-row value is TinkerPop identity', async () => {
    expect(asc(await framed('g.V().values("birthday").asNumber()') as number[])).toEqual(EPOCHS);
  });

  test('asNumber().asDate().asNumber() round-trips through datetime to the epoch Long', async () => {
    // The AsNumber.feature scenario g_V_valuesXbirthdayX_asNumber_asDate_asNumber (Long result).
    expect(asc(await framed('g.V().values("birthday").asNumber().asDate().asNumber()') as number[])).toEqual(EPOCHS);
  });

  test('asNumber() over a non-numeric string RAISES TinkerPop\'s exact message (the raise SQL cannot do)', () => {
    // `executeFramed` is synchronous and the coercion raises during execution.
    expect(() => framed('g.V().values("name").asNumber()')).toThrow("Can't parse string 'alice' as number.");
  });

  test('asNumber(GType.LONG) stays the SQL cast (not the barrier) — a statically typed cast', async () => {
    // A typed cast is `transform.ts`'s SQL CAST; the barrier claims only the bare, per-row-typed form.
    expect(asc(await framed('g.V().values("birthday").asNumber(GType.LONG)') as number[])).toEqual(EPOCHS);
  });
});
