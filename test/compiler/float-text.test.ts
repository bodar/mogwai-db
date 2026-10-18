// `Float.toString`/`Double.toString` at compile time — the printing half of the float authority
// (`src/gremlin/float.ts`). Each expectation is the JDK 19+ `toString` (the shortest decimal that reads
// back, the closest of those, at least TWO significant digits, laid out plain in [1e-3, 1e7)). The
// cases are ones a JDK 17 runtime (TinkerPop builds `<release>17</release>`, `vendor/tinkerpop/pom.xml`)
// prints identically; its older FloatingDecimal is not always shortest for a NORMAL float
// (`123456789f` is `1.23456792E8` there, `1.2345679E8` from JDK 19). The reference runtime is taken to be
// JDK 19+, and the cases where the two differ are pinned separately at the bottom.
import { test, expect } from 'bun:test';
import { javaNumberText, floatingDecimal } from '../../src/gremlin/float.ts';
import { BigDecimal } from '../../src/gremlin/types.ts';

const cases: [number, boolean, string][] = [
  [0.1, true, '0.1'],
  [1.00390625, true, '1.0039062'],
  [1.4e-45, true, '1.4E-45'],
  [2.8e-45, true, '2.8E-45'],
  [1e-40, true, '1.0E-40'],
  [3.4028234663852886e38, true, '3.4028235E38'],
  [1e10, true, '1.0E10'],
  [16777216, true, '1.6777216E7'],
  [Number.MIN_VALUE, false, '4.9E-324'],
  [1e7, false, '1.0E7'],
  [100, false, '100.0'],
  [0.001, false, '0.001'],
  [-1.5e-5, false, '-1.5E-5'],
  [1 / 3, false, '0.3333333333333333'],
  [-0, false, '0.0'],
];
for (const [value, float, text] of cases)
  test(`${float ? 'Float' : 'Double'}.toString(${value}) is ${text}`, () => expect(javaNumberText(value, float)).toBe(text));

test('a floating BigDecimal widening is the printed decimal, scale included', () => {
  expect(floatingDecimal(1.4e-45, true)).toEqual(new BigDecimal(14n, 46));
  expect(floatingDecimal(1, false)).toEqual(new BigDecimal(10n, 1));
  expect(floatingDecimal(Infinity, false)).toBeNull();
});

test('the BigDecimal parser reads an exponent spelling', () => {
  expect(BigDecimal.fromText('1.4e-45')).toEqual(new BigDecimal(14n, 46));
  expect(BigDecimal.fromText('2.9e+22')).toEqual(new BigDecimal(29n, -21));
  expect(BigDecimal.fromText('-1.0E-5')).toEqual(new BigDecimal(-10n, 6));
});

// THE PINNED JDK: 19+ (JDK-4511638, the shortest `Float.toString`/`Double.toString`). These two print
// differently on a JDK 17 runtime (`1.17549435E-38`, `1.23456792E8`), and `createNumber`'s Float rung reads
// exactly this spelling (`test/compiler/number-class-authority.exec.test.ts`), so the choice is pinned here.
test('Float.toString is the JDK 19+ shortest form', () => {
  expect(javaNumberText(1.1754943508222875e-38, true)).toBe('1.1754944E-38');
  expect(javaNumberText(123456789, true)).toBe('1.2345679E8');
});
