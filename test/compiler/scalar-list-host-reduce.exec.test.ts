// A `by()` body over a LIST host whose members are SCALARS — `select('a').by(__.unfold().<reducer>)`.
// `correlatedListMembers` already framed a scalar member re-entry; `listHostChild`/`correlatedReduce`
// only accepted an ELEMENT root, so a scalar-membered list host declined where an element one worked.
// A scalar member re-enters the scalar loop, so `count`/`sum`/`max`/`fold` reduce through the SAME
// `correlatedReduce` collapse arms. ⚠️ The member re-entry carries the member POSITION as the ENCOUNTER
// channel, so `fold()` preserves LIST order rather than value-sorting (`foldScalars`' no-encounter
// fallback) — the determinism `mise run test:perturbed` guards. See list.ts / reduction.ts.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

describe('a by() body over a SCALAR-membered list host', () => {
  const one = (store: ReturnType<typeof seededStore>, g: string) => (run(store, g) as any[])[0];

  // The person ages on the modern graph in vertex-encounter order: marko 29, vadas 27, josh 32, peter 35.
  const AGES = "g.V().values('age').fold().as('a').select('a')";

  test('count / sum / max reduce over the members', () => {
    const store = seededStore();
    expect(one(store, `${AGES}.by(__.unfold().count())`).v).toBe(4);
    expect(one(store, `${AGES}.by(__.unfold().sum())`).v).toBe(123); // 29+27+32+35
    expect(one(store, `${AGES}.by(__.unfold().max())`).v).toBe(35);
    expect(one(store, `${AGES}.by(__.unfold().min())`).v).toBe(27);
  });

  test('fold re-collects the members in LIST ORDER, not value order', () => {
    const store = seededStore();
    // Encounter order is [29,27,32,35]; a value-sort would give [27,29,32,35] — the bug the encounter
    // channel prevents.
    expect(one(store, `${AGES}.by(__.unfold().fold())`).list).toBe('[29,27,32,35]');
  });

});
