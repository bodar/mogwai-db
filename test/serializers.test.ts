import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ioc as iocTyped } from '../src/io.ts';
import { BigDecimal, Duration } from '../src/gremlin/types.ts';

// The client ioc ships no type declarations (see io.ts) — index it loosely in the test.
const ioc = iocTyped as any;

// Canonical GraphBinary wire vectors shipped in the pinned vendor submodule. Each is a
// fully-qualified single value. We assert byte-exact round-trip (deserialize→serialize)
// against ground truth, plus explicit value/edge checks — this is the contract an
// upstream apache/tinkerpop gremlin-js PR would have to satisfy.
const DIR = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphbinary';
const vec = (name: string) => Buffer.from(readFileSync(`${DIR}/${name}.gbin`));

const bigDecimal = ioc.serializers[ioc.DataType.BIGDECIMAL];
const duration = ioc.serializers[ioc.DataType.DURATION];
const char = ioc.serializers[ioc.DataType.CHAR];

describe('BigDecimal (0x22)', () => {
  for (const name of ['pos-bigdecimal-v4', 'neg-bigdecimal-v4']) {
    test(`${name} round-trips byte-exact`, () => {
      const bytes = vec(name);
      const { v, len } = bigDecimal.deserialize(bytes);
      expect(len).toBe(bytes.length);
      expect(v).toBeInstanceOf(BigDecimal);
      expect(bigDecimal.serialize(v)).toEqual(bytes);
    });
  }
  test('sign is preserved and distinct', () => {
    const pos = bigDecimal.deserialize(vec('pos-bigdecimal-v4')).v as BigDecimal;
    const neg = bigDecimal.deserialize(vec('neg-bigdecimal-v4')).v as BigDecimal;
    expect(pos.unscaled > 0n).toBe(true);
    expect(neg.unscaled < 0n).toBe(true);
  });
  test('decimal text round-trips through fromText', () => {
    for (const s of ['0', '1.5', '-1.5', '0.50', '123456789012345678901234567890.0001', '-0.0000000001']) {
      expect(BigDecimal.fromText(s).toString()).toBe(s);
    }
  });
  test('serialize accepts a decimal string (the stored form)', () => {
    const bytes = vec('pos-bigdecimal-v4');
    const asStr = (bigDecimal.deserialize(bytes).v as BigDecimal).toString();
    expect(bigDecimal.serialize(asStr)).toEqual(bytes);
  });
});

describe('Duration (0x81)', () => {
  test('zero duration = 0s/0ns, byte-exact', () => {
    const bytes = vec('zero-duration-v4');
    const { v } = duration.deserialize(bytes);
    expect((v as Duration).seconds).toBe(0n);
    expect((v as Duration).nanos).toBe(0);
    expect(duration.serialize(v)).toEqual(bytes);
  });
  test('forever duration = max int64 s / 999999999 ns, byte-exact', () => {
    const bytes = vec('forever-duration-v4');
    const { v } = duration.deserialize(bytes);
    expect((v as Duration).seconds).toBe(9223372036854775807n);
    expect((v as Duration).nanos).toBe(999999999);
    expect(duration.serialize(v)).toEqual(bytes);
  });
  test('total-nanos round-trips, including negative (Java normalization)', () => {
    const neg = Duration.fromTotalNanos(-1_500_000_000n); // -1.5s
    expect(neg.seconds).toBe(-2n);
    expect(neg.nanos).toBe(500000000);
    expect(neg.totalNanos()).toBe(-1_500_000_000n);
    expect(Duration.from(neg.toString()).totalNanos()).toBe(-1_500_000_000n);
  });
});

describe('Char (0x80)', () => {
  test('single-byte char round-trips byte-exact', () => {
    const bytes = vec('single-byte-char-v4');
    const { v, len } = char.deserialize(bytes);
    expect(typeof v).toBe('string');
    expect((v as string).length).toBe(1);
    expect(len).toBe(bytes.length);
    expect(char.serialize(v)).toEqual(bytes);
  });
  test('multi-byte char round-trips byte-exact (2-byte UTF-8)', () => {
    const bytes = vec('multi-byte-char-v4');
    const { v } = char.deserialize(bytes);
    expect(char.serialize(v)).toEqual(bytes);
  });
  test('rejects a multi-codepoint string', () => {
    expect(() => char.serialize('ab')).toThrow();
  });
  test('not auto-selected by anySerializer (a plain string stays String)', () => {
    // 'a' must frame as STRING (0x03), never CHAR (0x80).
    expect(ioc.anySerializer.serialize('a')[0]).toBe(ioc.DataType.STRING);
  });
});

describe('anySerializer routing', () => {
  test('inbound decode resolves our registered type codes', () => {
    expect(ioc.anySerializer.deserialize(vec('pos-bigdecimal-v4')).v).toBeInstanceOf(BigDecimal);
    expect(ioc.anySerializer.deserialize(vec('zero-duration-v4')).v).toBeInstanceOf(Duration);
  });
  test('outbound auto-selects BigDecimal/Duration instances', () => {
    expect(ioc.anySerializer.serialize(BigDecimal.fromText('1.5'))[0]).toBe(ioc.DataType.BIGDECIMAL);
    expect(ioc.anySerializer.serialize(Duration.fromTotalNanos(0n))[0]).toBe(ioc.DataType.DURATION);
  });
});
