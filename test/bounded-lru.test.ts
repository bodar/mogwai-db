// The bounded LRU (`src/bounded-lru.ts`) that the parse cache and the plan cache share.
import { describe, expect, test } from 'bun:test';
import { BoundedLru } from '../src/bounded-lru.ts';

const text = (maxEntries: number, maxWeight?: number, maxEntryWeight?: number) =>
  new BoundedLru<string, string>({ maxEntries, maxWeight, maxEntryWeight, weigh: (_k, v) => v.length });

describe('BoundedLru', () => {
  test('get counts hits and misses', () => {
    const lru = text(4);
    expect(lru.get('a')).toBeUndefined();
    lru.set('a', 'xx');
    expect(lru.get('a')).toBe('xx');
    expect(lru.stats()).toEqual({ hits: 1, misses: 1, size: 1, weight: 2 });
  });

  test('past max entries, the least recently used goes', () => {
    const lru = text(2);
    lru.set('a', '1'); lru.set('b', '2');
    lru.get('a');
    lru.set('c', '3');
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('1');
    expect(lru.get('c')).toBe('3');
  });

  test('past max weight, the least recently used go first, until the bound holds', () => {
    const lru = text(10, 10);
    lru.set('a', 'aaa'); lru.set('b', 'bbb'); lru.set('c', 'ccc');
    lru.get('a');                    // b is now least recently used, then c
    lru.set('d', 'dddddd');          // 15 → evict b (12), then c (9)
    expect(lru.stats()).toMatchObject({ size: 2, weight: 9 });
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBeUndefined();
    expect(lru.get('a')).toBe('aaa');
    expect(lru.get('d')).toBe('dddddd');
  });

  test('an entry past the per-entry limit is not held, removes its key, and evicts nothing else', () => {
    const lru = text(10, 100, 5);
    lru.set('a', 'aaa'); lru.set('b', 'bbb');
    lru.set('b', 'bbbbbb');
    expect(lru.stats()).toMatchObject({ size: 1, weight: 3 });
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe('aaa');
  });

  test('replacing a key replaces its weight', () => {
    const lru = text(10, 100);
    lru.set('a', 'aaaa'); lru.set('a', 'a');
    expect(lru.stats()).toMatchObject({ size: 1, weight: 1 });
  });
});
