// THE SACK'S NUMBER CLASS — what `NumberHelper` gives an arithmetic or min/max fold, asserted on the WIRE.
//
// L3 and L4 compare numbers loosely (`d[128].s` and `d[128].i` are both the number 128 to their
// harnesses), so the class a fold produces is only visible in the GraphBinary type code. The reference:
// the operands' highest common class (`getHighestCommonNumberInfo`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-390),
// widened one width at a time on overflow (`mathOperationWithPromote`, :401-428), and the type-tag
// authority that carries it is `foldedTag` (src/compiler/rel/sack.ts).
import { describe, expect, test } from 'bun:test';
import { seededStore } from './support/harness.ts';
import { exec } from './support/executor.ts';
import { decode } from './support/decode.ts';

const store = seededStore();

/** GraphBinary type codes (`DataType` in the client's io/binary). */
const CLASS: Record<number, string> = {
  0x01: 'Integer', 0x02: 'Long', 0x07: 'Double', 0x08: 'Float', 0x23: 'BigInteger', 0x24: 'Byte', 0x26: 'Short',
  0x03: 'String', 0x27: 'Boolean',
};

/** Every result as `Class:value`. */
async function typed(gremlin: string): Promise<string[]> {
  const out: string[] = [];
  for (const framed of exec(store).framed(gremlin, {}, {})) {
    const buf = Buffer.from(framed.buf);
    out.push(`${CLASS[buf[0]!] ?? buf[0]}:${String(await decode(buf))}`);
  }
  return out;
}

describe('an arithmetic fold takes the operands\' highest common class', () => {
  test.each([
    ['g.withSack(1l).inject(2l).sack(sum).sack()', 'Long:3'],
    ['g.withSack(1).inject(2l).sack(sum).sack()', 'Long:3'],
    ['g.withSack(5l).inject(2).sack(div).sack()', 'Long:2'],
    ['g.withSack(5n).inject(2).sack(div).sack()', 'BigInteger:2'],
    ['g.withSack(5b).inject(2b).sack(sum).sack()', 'Byte:7'],
    ['g.withSack(5s).inject(2b).sack(mult).sack()', 'Short:10'],
    ['g.withSack(1.0d).inject(2).sack(sum).sack()', 'Double:3'],
    ['g.withSack(1.5f).inject(2).sack(sum).sack()', 'Float:3.5'],
    ['g.withSack(1.5f).inject(2l).sack(sum).sack()', 'Double:3.5'],
    ['g.withSack(127b).inject(0.5f).sack(div).sack()', 'Float:254'],
  ])('%s', async (gremlin, expected) => {
    expect(await typed(gremlin)).toEqual([expected]);
  });
});

describe('an integral result past its class widens one width at a time (Sack.feature)', () => {
  test.each([
    ['g.withSack(127b).inject(1b).sack(sum).sack()', 'Short:128'],
    ['g.withSack(-128b).inject(1b).sack(minus).sack()', 'Short:-129'],
    ['g.withSack(127b).inject(2b).sack(mult).sack()', 'Short:254'],
    ['g.withSack(-128b).inject(-1b).sack(div).sack()', 'Short:128'],
    ['g.withSack(32767s).inject(1s).sack(sum).sack()', 'Integer:32768'],
    ['g.withSack(-32768s).inject(-1s).sack(div).sack()', 'Integer:32768'],
    ['g.withSack(2147483647i).inject(1i).sack(sum).sack()', 'Long:2147483648'],
    ['g.withSack(2147483647i).inject(2i).sack(mult).sack()', 'Long:4294967294'],
  ])('%s', async (gremlin, expected) => {
    expect(await typed(gremlin)).toEqual([expected]);
  });
});

describe('min/max answer in the common class of two Numbers, and a NULL side yields the other', () => {
  test.each([
    ['g.withSack(1).inject(2l).sack(min).sack()', ['Long:1']],
    ['g.withSack(1).inject(2.5d).sack(max).sack()', ['Double:2.5']],
    ['g.withSack(1).inject(null).sack(max).sack()', ['Integer:1']],
    ['g.withSack(1).inject(null).sack(sum).sack()', ['Integer:1']],
    ["g.withSack('m').V().hasLabel('software').sack(min).by('name').sack()", ['String:lop', 'String:m']],
  ])('%s', async (gremlin, expected) => {
    expect((await typed(gremlin)).sort()).toEqual([...expected].sort());
  });
});

describe('integral div truncates, and a zero divisor raises the reference\'s message', () => {
  test('withSack(1).sack(div).by(constant(2)) is the Integer 0', async () => {
    expect(await typed('g.withSack(1).inject(1).sack(div).by(constant(2)).sack()')).toEqual(['Integer:0']);
  });
  test.each([
    ['g.withSack(1).inject(1).sack(div).by(constant(0)).sack()', '/ by zero'],
    ['g.withSack(5n).inject(0).sack(div).sack()', 'BigInteger divide by zero'],
    ['g.withSack(1.0d).inject(0).sack(div).sack()', 'floating-point division by zero is not supported yet'],
    ['g.withSack(2147483647l).inject(2147483647l).sack(mult).sack(mult).by(constant(2147483647l)).sack()', 'long overflow'],
    ['g.withSack(2147483647l).inject(2147483647l).sack(mult).sack(mult).by(constant(2147483647l)).count()', 'long overflow'],
  ])('%s raises', (gremlin, message) => {
    expect(() => exec(store).framed(gremlin, {}, {})).toThrow(message);
  });
});

describe('asString of a Float renders Float.toString where SQLite can say it', () => {
  test.each([
    ['g.withSack(1.5f).inject(1).sack().asString()', 'String:1.5'],
    ['g.withSack(1.5f).inject(1).sack(sum).by(constant(1.5f)).sack().asString()', 'String:3.0'],
    ['g.inject(-0.0f).asString()', 'String:0.0'],
    ['g.inject(0.1f).asString()', 'String:0.1'],
  ])('%s', async (gremlin, expected) => {
    expect(await typed(gremlin)).toEqual([expected]);
  });
  // Float.toString(1.00390625f) is "1.0039062" — the shortest decimal that rounds to the FLOAT, not the exact one.
  test('a Float whose exact decimal is not its shortest raises the deferral rather than print it', () => {
    expect(() => exec(store).framed('g.inject(1.00390625f).asString()', {}, {})).toThrow('not supported yet');
  });
});
