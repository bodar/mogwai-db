// `constant(c)` CARRIES ITS OWN TYPE to the wire.
//
// Gremlin spells numeric type LEXICALLY — `30`, `30L`, `30.5`, `30.5f` are four different types written
// four ways — and the front end parses that into `Arg.type` and carries it end to end. `constantRetype`
// then framed every plain literal `UNKNOWN` ("infer from the value at the wire"), so the type was
// re-derived from the SQL storage class, which cannot see a lexical distinction. `constLit` narrows that
// class further still, inlining a boolean as INTEGER 1.
//
// The result was three silently wrong wire types, and the third is the one that matters most: a client
// asking for `constant(true)` got the integer 1.
//
// Asserted on the TYPE BYTE, not the decoded JS value, because that is where the defect lived — JS cannot
// tell an Int from a Long, so a value-level assertion passed throughout (§6·7: the type is the thing
// being carried, so the type is the thing to assert).
import { test, expect, describe } from 'bun:test';
import { seededStore, zooStore } from '../support/harness.ts';
import { exec } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';

/** The GraphBinary type NAME of a result's first buffer — `ioc.DataType` reversed, so the expectation
 *  reads as a type rather than as a magic byte and stays byte-stable with the client's own enum. */
const CODE: Record<number, string> = Object.fromEntries(
  Object.entries(ioc.DataType).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v as number, k]));

const wireType = (q: string): string => {
  const buf = exec(seededStore()).buffers(q, {})[0]!;
  return CODE[buf[0]!] ?? `0x${buf[0]!.toString(16)}`;
};

describe('constant() carries its declared type', () => {
  test('the numeric ladder keeps its LEXICAL type', () => {
    expect(wireType(`g.V().limit(1).constant(30)`)).toBe('INT');
    // Was INT — the `L` suffix was parsed, carried on `Arg.type`, and then dropped at framing.
    expect(wireType(`g.V().limit(1).constant(30L)`)).toBe('LONG');
    expect(wireType(`g.V().limit(1).constant(30.5)`)).toBe('DOUBLE');
    // Was DOUBLE, for the same reason.
    expect(wireType(`g.V().limit(1).constant(30.5f)`)).toBe('FLOAT');
  });

  // THE SHARPEST CASE: `constLit` inlines a boolean as INTEGER 1 (a deliberate storage choice — SQLite
  // has no boolean class), so inference had no way back to BOOLEAN and a client received the integer 1.
  test('a boolean constant is a BOOLEAN, not the integer it is stored as', () => {
    expect(wireType(`g.V().limit(1).constant(true)`)).toBe('BOOLEAN');
    expect(wireType(`g.V().limit(1).constant(false)`)).toBe('BOOLEAN');
  });

  test('a string constant is unaffected', () => {
    expect(wireType(`g.V().limit(1).constant('x')`)).toBe('STRING');
  });

  // The framer ALREADY renders a tagged value from a narrower column — a stored boolean property is an
  // INTEGER column plus a `boolean` vtype and frames as GraphBinary BOOLEAN. That is why this needed a
  // declaration and no framer work: the route existed, the constant just never named its type.
  test('a stored boolean proves the framer route this relies on', () => {
    const buf = exec(zooStore()).buffers(`g.V(1).values('captiveBorn')`, {})[0]!;
    expect(CODE[buf[0]!]).toBe('BOOLEAN');
  });

  // A constant inside a project FIELD travels the record's typed-node encoding rather than a bare wire
  // value, and it must carry the same type — `__typename`-style constant fields are the common shape.
  test('a constant in a project field keeps its type too', async () => {
    const buf = exec(seededStore()).buffers(`g.V().limit(1).project('a').by(__.constant(30L))`, {})[0]!;
    expect(CODE[buf[0]!]).toBe('MAP');
    // The map's single value is the constant, and it deserializes to the declared type. The client's own
    // reader is the authority on what a GLV would see.
    const { decode } = await import('../support/decode.ts');
    const map = await decode(buf);
    expect([...(map as Map<string, unknown>).keys()]).toEqual(['a']);
    expect(String((map as Map<string, unknown>).get('a'))).toBe('30');
  });
});
