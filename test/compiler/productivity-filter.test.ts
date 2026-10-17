// `productivityFilter` (src/compiler/rel/modulator.ts) is the ONE authority every by() consumer asks
// whether to drop a traverser — and it reads the projection's PRESENCE, never its value. These pin its
// three answers, because each wrong one is a wrong answer rather than a decline:
//   - ALWAYS_PRODUCTIVE / ProductiveByStrategy → no drop (a token, the traverser itself);
//   - a presence predicate → drop on exactly that predicate (a productive null survives it);
//   - 'unknown' → DECLINE, never the old `value IS NOT NULL` reading that dropped productive nulls.
import { test, expect, describe } from 'bun:test';
import { productivityFilter, nodeProductivityFilter } from '../../src/compiler/rel/modulator.ts';
import { ALWAYS_PRODUCTIVE } from '../../src/compiler/rel/child.ts';
import { compilerInt, type Expr } from '../../src/rel/expr.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';

const step = (productiveBy = false): IRStep => ({ name: 'order', args: [], ...(productiveBy ? { productiveBy } : {}) }) as unknown as IRStep;
const present: Expr = { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(2) };

describe('productivityFilter — by()-productivity is PRESENCE, one authority', () => {
  test('an always-productive projection owes no drop', () => {
    expect(productivityFilter(step(), ALWAYS_PRODUCTIVE)).toEqual({});
  });
  test('a presence predicate IS the drop — not the value\'s nullness', () => {
    expect(productivityFilter(step(), present)).toEqual({ keep: present });
  });
  test('a producer that cannot say DECLINES', () => {
    expect(productivityFilter(step(), 'unknown')).toBeNull();
  });
  test('ProductiveByStrategy drops nothing, even where presence is unknown', () => {
    expect(productivityFilter(step(true), present)).toEqual({});
    expect(productivityFilter(step(true), 'unknown')).toEqual({});
  });
  test('a member node encodes its presence, so its own non-nullness is the drop', () => {
    expect(nodeProductivityFilter(step(), compilerInt(1))).toBeDefined();
    expect(nodeProductivityFilter(step(true), compilerInt(1))).toBeUndefined();
  });
});
