import { test, expect, describe } from 'bun:test';
import { valueNodeOf, BigDecimal, Duration, type TypeNode } from '../src/gremlin/types.ts';

// Stage 1 of full-fidelity typed collections: valueNodeOf recursively tags a materialized
// JS value with its type tree into a self-describing ValueNode. The write path stores the
// TOP node's BARE `v` (the vtype column names the outer shape); NESTED nodes carry {t,v}.
// Leaves reuse storedScalar's canonical form, so precision survives and read framing can
// reuse frameValue(v, vtypeToValueType(t)).

describe('valueNodeOf', () => {
  test('list of mixed typed scalars → per-element {t,v} envelopes', () => {
    const tn: TypeNode = { t: 'list', items: ['int', 'string', 'uuid'] };
    const node = valueNodeOf([1, 'a', '0263f28b-eff9-4c17-8e33-0b41c74b6d4c'], tn);
    expect(node).toEqual({
      t: 'list',
      v: [
        { t: 'int', v: 1 },
        { t: 'string', v: 'a' },
        { t: 'uuid', v: '0263f28b-eff9-4c17-8e33-0b41c74b6d4c' },
      ],
    });
    // The write path stores the top node's BARE v (JSON-safe).
    expect(() => JSON.stringify(node.v)).not.toThrow();
  });

  test('set value → t:set (distinct from list)', () => {
    const node = valueNodeOf(new Set([1, 2]), { t: 'set', items: ['int', 'int'] });
    expect(node.t).toBe('set');
    expect(node.v).toEqual([{ t: 'int', v: 1 }, { t: 'int', v: 2 }]);
  });

  test('long/bigint > 2^53 leaf stored as lossless decimal TEXT (no number truncation)', () => {
    const big = 9007199254740993n; // 2^53 + 2 — not representable as an exact JS number
    const node = valueNodeOf([big], { t: 'list', items: ['long'] });
    expect(node.v).toEqual([{ t: 'long', v: '9007199254740993' }]);
    expect(JSON.parse(JSON.stringify(node.v))[0].v).toBe('9007199254740993'); // survives JSON
  });

  test('bigdecimal / duration leaves store canonical decimal TEXT', () => {
    const node = valueNodeOf(
      [BigDecimal.fromText('1.50'), Duration.fromTotalNanos(1_500_000_000n)],
      { t: 'list', items: ['bigdecimal', 'duration'] },
    );
    expect(node.v).toEqual([
      { t: 'bigdecimal', v: '1.50' },
      { t: 'duration', v: '1500000000' },
    ]);
  });

  test('datetime leaf normalized to epoch-millis', () => {
    const ms = 1_700_000_000_000;
    expect(valueNodeOf([new Date(ms)], { t: 'list', items: ['datetime'] }).v).toEqual([{ t: 'datetime', v: ms }]);
    expect(valueNodeOf([ms], { t: 'list', items: ['datetime'] }).v).toEqual([{ t: 'datetime', v: ms }]);
  });

  test('map → ordered [keyNode, valNode] pairs preserving typed, non-string keys', () => {
    const m = new Map<any, any>([[1, 'a'], [2, 'b']]);
    const tn: TypeNode = { t: 'map', entries: { '1': { key: 'int', value: 'string' }, '2': { key: 'int', value: 'string' } } };
    expect(valueNodeOf(m, tn).v).toEqual([
      [{ t: 'int', v: 1 }, { t: 'string', v: 'a' }],
      [{ t: 'int', v: 2 }, { t: 'string', v: 'b' }],
    ]);
  });

  test('recursive nesting: list of map-of-list, every leaf typed', () => {
    const inner = new Map<any, any>([['xs', [1n]]]);
    const tn: TypeNode = {
      t: 'list',
      items: [{ t: 'map', entries: { xs: { key: 'string', value: { t: 'list', items: ['long'] } } } }],
    };
    expect(valueNodeOf([inner], tn).v).toEqual([
      { t: 'map', v: [[{ t: 'string', v: 'xs' }, { t: 'list', v: [{ t: 'long', v: 1 }] }]] },
    ]);
  });

  test('untyped channel (null TypeNode) infers leaf types from the JS value', () => {
    expect(valueNodeOf([1, 'a', true], null).v).toEqual([
      { t: 'int', v: 1 },
      { t: 'string', v: 'a' },
      { t: 'boolean', v: true },
    ]);
  });
});
