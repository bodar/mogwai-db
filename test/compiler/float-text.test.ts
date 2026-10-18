// `Double.toString` at compile time — the printing authority (`src/gremlin/float.ts`). Each expectation is
// the JDK 19+ `toString` (the shortest decimal that reads back, the closest of those, at least TWO
// significant digits, laid out plain in [1e-3, 1e7)). A Float rides as the Double of its decimal, so it
// prints as that Double (`0.1f` is `0.1`) — a deliberate divergence from Java's float spelling.
import { test, expect } from 'bun:test';
import { javaNumberText, floatingDecimal } from '../../src/gremlin/float.ts';
import { BigDecimal } from '../../src/gremlin/types.ts';

const cases: [number, string][] = [
  [0.1, '0.1'],
  [1e10, '1.0E10'],
  [Number.MIN_VALUE, '4.9E-324'],
  [1e7, '1.0E7'],
  [100, '100.0'],
  [0.001, '0.001'],
  [-1.5e-5, '-1.5E-5'],
  [1 / 3, '0.3333333333333333'],
  [-0, '0.0'],
];
for (const [value, text] of cases)
  test(`Double.toString(${value}) is ${text}`, () => expect(javaNumberText(value)).toBe(text));

test('a floating BigDecimal widening is the printed decimal, scale included', () => {
  expect(floatingDecimal(1.4e-45)).toEqual(new BigDecimal(14n, 46));
  expect(floatingDecimal(1)).toEqual(new BigDecimal(10n, 1));
  expect(floatingDecimal(Infinity)).toBeNull();
});

test('the BigDecimal parser reads an exponent spelling', () => {
  expect(BigDecimal.fromText('1.4e-45')).toEqual(new BigDecimal(14n, 46));
  expect(BigDecimal.fromText('2.9e+22')).toEqual(new BigDecimal(29n, -21));
  expect(BigDecimal.fromText('-1.0E-5')).toEqual(new BigDecimal(-10n, 6));
});
