// A map's static key facts (`src/compiler/rel/framing.ts` `MapKeyFacts`): `keys` is a sound MAY upper
// bound, `held` a sound MUST lower bound. These pin the lattice algebra every writer goes through — the
// branch merge's ONE meet (`meetFraming`), an alias history's join, and a local entry slice — so a merge
// can never adopt one arm's facts for its siblings' rows (the `union(constant([a:3]), constant([a:1,b:2]))
// .select('b')` defect, which read the side effect for both rows).
import { describe, expect, test } from 'bun:test';
import { literalKeyFacts, mapKeyPresence, meetMapKeyFacts, recordKeyFacts, slicedKeyFacts, type RecordField, type RelFraming } from '../../src/compiler/rel/framing.ts';
import { meetFraming } from '../../src/compiler/rel/lower/branch.ts';
import { joinAliasEntry, type AliasEntry } from '../../src/compiler/alias.ts';

const scalar = { kind: 'scalar' } as const;
const map = (facts: object): RelFraming => ({ kind: 'map', keyOf: scalar, valOf: scalar, ...facts });

describe('meetMapKeyFacts — MAY unions, MUST intersects', () => {
  test('keys is the union and held the intersection', () => {
    const met = meetMapKeyFacts([literalKeyFacts(['a']), literalKeyFacts(['a', 'b'])]);
    expect(met.keys).toEqual(['a', 'b']);
    expect(met.held).toEqual(['a']);
    expect(met.exact).toBeUndefined();
  });
  test('an unknown MAY set is the top; an absent MUST set is the bottom', () => {
    const met = meetMapKeyFacts([literalKeyFacts(['a', 'b']), { keys: ['a'] }, {}]);
    expect(met.keys).toBeUndefined();
    expect(met.held).toBeUndefined();
  });
  test('exact survives only over the same keys in the same order', () => {
    expect(meetMapKeyFacts([literalKeyFacts(['a', 'b']), literalKeyFacts(['a', 'b'])]).exact).toBe(true);
    const swapped = meetMapKeyFacts([literalKeyFacts(['a', 'b']), literalKeyFacts(['b', 'a'])]);
    expect(swapped.exact).toBeUndefined();
    expect(swapped.held).toEqual(['a', 'b']);
  });
});

describe('meetFraming — the merged framing of admitted arms', () => {
  test('a map merge meets its key facts, in either arm order', () => {
    for (const arms of [[['a'], ['a', 'b']], [['a', 'b'], ['a']]]) {
      const met = meetFraming(arms.map((keys) => map(literalKeyFacts(keys))));
      expect(met.kind === 'map' && [...met.keys!].sort()).toEqual(['a', 'b']);
      expect(met.kind === 'map' && met.held).toEqual(['a']);
    }
  });
  test('a record merge meets each map-valued FIELD', () => {
    const record = (keys: string[]): RelFraming => ({
      kind: 'record', fields: [{ key: 'm', prefix: 'f0', optional: false, framing: map(literalKeyFacts(keys)) }],
    });
    const met = meetFraming([record(['a']), record(['a', 'b'])]);
    const field = met.kind === 'record' ? met.fields[0]!.framing : null;
    expect(field?.kind === 'map' && field.keys).toEqual(['a', 'b']);
    expect(field?.kind === 'map' && field.held).toEqual(['a']);
  });
});

test('an alias history joining two maps meets their facts', () => {
  const entry = (keys: string[]): AliasEntry => ({ col: 'a0', shapes: new Set(['map']), mapOf: { keyOf: scalar, valOf: scalar, ...literalKeyFacts(keys) } });
  const joined = joinAliasEntry(entry(['a']), entry(['a', 'b']));
  expect(joined.mapOf?.keys).toEqual(['a', 'b']);
  expect(joined.mapOf?.held).toEqual(['a']);
});

describe('slicedKeyFacts — a local entry window', () => {
  test('an exact map re-states held as the window it keeps', () => {
    const facts = literalKeyFacts(['a', 'b', 'c']);
    expect(slicedKeyFacts(facts, { offset: 1, limit: null, fromEnd: false }).held).toEqual(['b', 'c']);
    expect(slicedKeyFacts(facts, { offset: 0, limit: 1, fromEnd: false }).held).toEqual(['a']);
    expect(slicedKeyFacts(facts, { offset: 0, limit: 2, fromEnd: true }).keys).toEqual(['b', 'c']);
    expect(slicedKeyFacts(facts, { offset: 0, limit: 0, fromEnd: false }).keys).toEqual([]);
  });
  test('a non-exact map keeps its MAY set and spends held', () => {
    const fields: RecordField[] = [
      { key: 'a', prefix: 'f0', optional: false, framing: scalarFraming },
      { key: 'b', prefix: 'f1', optional: true, framing: scalarFraming },
    ];
    const facts = recordKeyFacts(fields);
    expect(facts.held).toEqual(['a']);
    const sliced = slicedKeyFacts(facts, { offset: 0, limit: 5, fromEnd: false });
    expect(sliced.keys).toEqual(['a', 'b']);
    expect(sliced.held).toBeUndefined();
  });
});

const scalarFraming: RelFraming = { kind: 'scalar', type: { kind: 'unknown' } } as RelFraming;

// The ONE reading every map-first reader makes. `keys` (the MAY bound) never means present: after a merge
// of `[a:3]` and `[a:1,b:2]`, `b` is a key some rows only MAY hold, which a reader with a same-named label
// behind it must decline rather than drop the rows lacking it.
test('mapKeyPresence — held, absent, or may', () => {
  const merged = meetMapKeyFacts([literalKeyFacts(['a']), literalKeyFacts(['a', 'b'])]);
  expect(mapKeyPresence(merged, 'a')).toBe('held');
  expect(mapKeyPresence(merged, 'b')).toBe('may');
  expect(mapKeyPresence(merged, 'c')).toBe('absent');
  expect(mapKeyPresence({}, 'c')).toBe('may');
});
