import { describe, expect, test } from 'bun:test';
import {
  gtypeName, isCardinalityArg, isColumnArg, isDirectionArg, isDtArg, isGTypeArg,
  isMergeArg, isOperatorArg, isOrderArg, isPickArg, isPopArg, isScopeArg,
  isTokenArg, isWithOptionArg,
} from '../src/gremlin/frontend.ts';
import { cardinalityOf } from '../src/compiler/steps/context/stream.ts';

describe('channel contracts', () => {
  test('front-end tagged arguments narrow only through their declared tag', () => {
    const cases: readonly [unknown, (v: unknown) => boolean][] = [
      [{ order: 'asc' }, isOrderArg], [{ pop: 'first' }, isPopArg],
      [{ column: 'keys' }, isColumnArg], [{ token: 'id' }, isTokenArg],
      [{ direction: 'out' }, isDirectionArg], [{ merge: 'oncreate' }, isMergeArg],
      [{ cardinality: 'single' }, isCardinalityArg], [{ gtype: 'string' }, isGTypeArg],
      [{ pick: 'none' }, isPickArg], [{ withOption: 'tokens' }, isWithOptionArg],
      [{ dt: 'day' }, isDtArg], [{ operator: 'sum' }, isOperatorArg], [{ scope: 'local' }, isScopeArg],
    ];
    for (const [value, guard] of cases) {
      expect(guard(value)).toBe(true);
      expect(guard({ unrelated: true })).toBe(false);
    }
    expect(gtypeName({ gtype: 'UUID' })).toBe('UUID');
    expect(gtypeName('STRING')).toBe('STRING');
    expect(gtypeName({ token: 'id' })).toBeNull();
  });

  test('relational cardinality distinguishes rows, whole results, and path runs', () => {
    expect(cardinalityOf({ kind: 'scalar', rel: { cols: [] }, traverserLayout: {} } as any)).toEqual({ kind: 'perRow' });
    expect(cardinalityOf({ kind: 'group', rel: { cols: [] }, traverserLayout: {} } as any)).toEqual({ kind: 'wholeResult' });
    expect(cardinalityOf({ kind: 'path', layout: { kind: 'grouped', elem: 'vertex' }, rel: { cols: ['pk', 'ord'] }, traverserLayout: {} } as any))
      .toEqual({ kind: 'runsByKey', key: 'pk' });
    expect(() => cardinalityOf({ kind: 'path', layout: { kind: 'grouped', elem: 'vertex' }, rel: { cols: ['ord'] }, traverserLayout: {} } as any))
      .toThrow('requires its pk run key');
  });
});
