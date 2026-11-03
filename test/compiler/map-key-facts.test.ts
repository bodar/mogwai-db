// A map's static key fact (`src/compiler/rel/framing.ts` `MapKeyFacts`): `keys` is a sound MAY upper
// bound, and there is deliberately no MUST set. These pin the ONE meet every merge goes through — the
// branch merge (`meetFraming`) and an alias history's join — so a merge can never adopt one arm's keys for
// its siblings' rows (the `union(constant([a:3]), constant([a:1,b:2])).select('b')` defect, which read the
// side effect for both rows).
import { describe, expect, test } from 'bun:test';
import { literalKeyFacts, mayHoldKey, meetMapKeyFacts, recordKeyFacts, type RecordField, type RelFraming } from '../../src/compiler/rel/framing.ts';
import { meetFraming } from '../../src/compiler/rel/lower/branch.ts';
import { joinAliasEntry, type AliasEntry } from '../../src/compiler/alias.ts';

const scalar = { kind: 'scalar' } as const;
const map = (facts: object): RelFraming => ({ kind: 'map', keyOf: scalar, valOf: scalar, ...facts });
const scalarFraming: RelFraming = { kind: 'scalar', type: { kind: 'unknown' } } as RelFraming;

describe('meetMapKeyFacts — the MAY sets union', () => {
  test('keys is the union', () => {
    expect(meetMapKeyFacts([literalKeyFacts(['a']), literalKeyFacts(['a', 'b'])])).toEqual({ keys: ['a', 'b'] });
  });
  test('an unknown MAY set is the top', () => {
    expect(meetMapKeyFacts([literalKeyFacts(['a', 'b']), { keys: ['a'] }, {}])).toEqual({});
  });
  test('a literal with a non-string key states no MAY set', () => {
    expect(literalKeyFacts(['a', 1])).toEqual({});
  });
});

describe('meetFraming — the merged framing of admitted arms', () => {
  test('a map merge unions its keys, in either arm order', () => {
    for (const arms of [[['a'], ['a', 'b']], [['a', 'b'], ['a']]]) {
      const met = meetFraming(arms.map((keys) => map(literalKeyFacts(keys))));
      expect(met.kind === 'map' && [...met.keys!].sort()).toEqual(['a', 'b']);
    }
  });
  test('a record merge meets each map-valued FIELD', () => {
    const record = (keys: string[]): RelFraming => ({
      kind: 'record', fields: [{ key: 'm', prefix: 'f0', optional: false, framing: map(literalKeyFacts(keys)) }],
    });
    const met = meetFraming([record(['a']), record(['a', 'b'])]);
    const field = met.kind === 'record' ? met.fields[0]!.framing : null;
    expect(field?.kind === 'map' && field.keys).toEqual(['a', 'b']);
  });
});

test('an alias history joining two maps unions their keys', () => {
  const entry = (keys: string[]): AliasEntry => ({ col: 'a0', shapes: new Set(['map']), mapOf: { keyOf: scalar, valOf: scalar, ...literalKeyFacts(keys) } });
  expect(joinAliasEntry(entry(['a']), entry(['a', 'b'])).mapOf?.keys).toEqual(['a', 'b']);
});

test('a record collapsed to a map MAY hold every field, optional or not', () => {
  const fields: RecordField[] = [
    { key: 'a', prefix: 'f0', optional: false, framing: scalarFraming },
    { key: 'b', prefix: 'f1', optional: true, framing: scalarFraming },
  ];
  expect(recordKeyFacts(fields)).toEqual({ keys: ['a', 'b'] });
});

// The ONE reading every map-first reader makes: only a key OUTSIDE a known MAY set is known absent.
test('mayHoldKey — false only outside a known key set', () => {
  const merged = meetMapKeyFacts([literalKeyFacts(['a']), literalKeyFacts(['a', 'b'])]);
  expect(mayHoldKey(merged, 'a')).toBe(true);
  expect(mayHoldKey(merged, 'b')).toBe(true);
  expect(mayHoldKey(merged, 'c')).toBe(false);
  expect(mayHoldKey({}, 'c')).toBe(true);
});
