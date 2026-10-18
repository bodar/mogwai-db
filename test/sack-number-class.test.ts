// THE SACK'S NUMBER CLASS — what an arithmetic or min/max fold answers, asserted on the WIRE.
//
// L3 and L4 compare numbers loosely (`d[128].s` and `d[128].i` are both the number 128 to their
// harnesses), so the class a fold produces is only visible in the GraphBinary type code. The rule is a
// simple MEET (`meetClass`, src/compiler/rel/sack.ts), not NumberHelper's width lattice: floating if
// either side is, else Long if either side is or the value left 32 bits, else Integer — so a Byte/Short
// fold answers an Integer (an accepted divergence, docs/feature-support-matrix.md).
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

describe('an arithmetic fold takes the meet of the operands\' classes', () => {
  test.each([
    ['g.withSack(1l).inject(2l).sack(sum).sack()', 'Long:3'],
    ['g.withSack(1).inject(2l).sack(sum).sack()', 'Long:3'],
    ['g.withSack(5l).inject(2).sack(div).sack()', 'Long:2'],
    ['g.withSack(5b).inject(2b).sack(sum).sack()', 'Integer:7'],
    ['g.withSack(5s).inject(2b).sack(mult).sack()', 'Integer:10'],
    ['g.withSack(1.0d).inject(2).sack(sum).sack()', 'Double:3'],
    ['g.withSack(1.5f).inject(2).sack(sum).sack()', 'Float:3.5'],
    ['g.withSack(1.5f).inject(2l).sack(sum).sack()', 'Double:3.5'],
    ['g.withSack(127b).inject(0.5f).sack(div).sack()', 'Float:254'],
  ])('%s', async (gremlin, expected) => {
    expect(await typed(gremlin)).toEqual([expected]);
  });
});

describe('an integral result past 32 bits is a Long (Sack.feature)', () => {
  test.each([
    ['g.withSack(127b).inject(1b).sack(sum).sack()', 'Integer:128'],
    ['g.withSack(-128b).inject(-1b).sack(div).sack()', 'Integer:128'],
    ['g.withSack(-2147483648i).inject(-1i).sack(div).sack()', 'Long:2147483648'],
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
    ['g.withSack(true).inject(false).sack(min).sack()', ['Boolean:false']],
    // A pair Java refuses (ClassCastException) answers SQLite's comparison, framed by the winner's storage.
    ["g.withSack('m').inject(1).sack(min).sack()", ['Integer:1']],
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
    ['g.withSack(5n).inject(2).sack(div).sack()', 'a BigInteger or BigDecimal operand is not supported yet'],
    ['g.withSack(1.0d).inject(0).sack(div).sack()', 'floating-point division by zero is not supported yet'],
    ['g.withSack(2147483647l).inject(2147483647l).sack(mult).sack(mult).by(constant(2147483647l)).sack()', 'long overflow'],
    ['g.withSack(2147483647l).inject(2147483647l).sack(mult).sack(mult).by(constant(2147483647l)).count()', 'long overflow'],
  ])('%s raises', (gremlin, message) => {
    expect(() => exec(store).framed(gremlin, {}, {})).toThrow(message);
  });
});

describe('asString of a Float is the text of its value — a whole value keeps its .0', () => {
  test.each([
    ['g.withSack(1.5f).inject(1).sack().asString()', 'String:1.5'],
    ['g.withSack(1.5f).inject(1).sack(sum).by(constant(1.5f)).sack().asString()', 'String:3.0'],
    ['g.inject(-0.0f).asString()', 'String:0.0'],
    ['g.inject(0.1f).asString()', 'String:0.1'],
    // A Float literal lands on its shortest float32 decimal (`floatCanonical`). On an exact tie JS rounds
    // half up where `Float.toString` rounds half even ("1.0039062") — a spelling divergence only.
    ['g.inject(1.00390625f).asString()', 'String:1.0039063'],
  ])('%s', async (gremlin, expected) => {
    expect(await typed(gremlin)).toEqual([expected]);
  });
});
