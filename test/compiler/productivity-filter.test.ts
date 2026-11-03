// `productivityFilter` (src/compiler/rel/modulator.ts) is the ONE authority every by() consumer asks
// whether to drop a traverser. Presence is VALUE NULLNESS (`ChildValue.present`): a NULL by() value is an
// absent one. These pin its three answers, because each wrong one is a wrong answer rather than a decline:
//   - 'always' / ProductiveByStrategy → no drop (a token, the traverser itself);
//   - 'value-nullness' → drop where the value IS NULL;
//   - 'unknown' → DECLINE;
//   - a STATED { when } → keep on the statement, so a NULL value under it is a productive null.
import { test, expect, describe } from 'bun:test';
import { productivityFilter } from '../../src/compiler/rel/modulator.ts';
import { col, type Expr } from '../../src/rel/expr.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import type { RelId } from '../../src/rel/types.ts';

const step = (productiveBy = false): IRStep => ({ name: 'order', args: [], ...(productiveBy ? { productiveBy } : {}) }) as unknown as IRStep;
const value: Expr = col('r1' as RelId, 'v');

describe('productivityFilter — by()-productivity is value nullness, one authority', () => {
  test('an always-productive projection owes no drop', () => {
    expect(productivityFilter(step(), 'always', value)).toEqual({});
  });
  test('a value-nullness projection drops a NULL value', () => {
    expect(productivityFilter(step(), 'value-nullness', value)).toEqual({ keep: { kind: 'binary', op: 'is not', left: value, right: expect.anything() } });
  });
  test('a producer that cannot say DECLINES', () => {
    expect(productivityFilter(step(), 'unknown', value)).toBeNull();
  });
  test('a STATED presence keeps on its statement, not on the value', () => {
    const when: Expr = col('r1' as RelId, 'p');
    expect(productivityFilter(step(), { when }, value)).toEqual({ keep: when });
    expect(productivityFilter(step(), { present: { when } }, value)).toEqual({ keep: when });
  });
  test('ProductiveByStrategy drops nothing, even where presence is unknown', () => {
    expect(productivityFilter(step(true), 'value-nullness', value)).toEqual({});
    expect(productivityFilter(step(true), 'unknown', value)).toEqual({});
  });
});
