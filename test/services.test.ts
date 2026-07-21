import { test, expect, describe } from 'bun:test';
import { createRegistry, defaultRegistry, DIRECTORY_SERVICE_NAME } from '../src/services/registry.ts';
import type { Service } from '../src/services/types.ts';

// The call() service subsystem: the ServiceRegistry (this file) + the call/with front-end
// fold + param resolver (added as those land). The registry is a DI seam sibling to
// GraphManager; --list enumerates it live, EXCLUDING the directory service itself.

const stubService = (name: string): Service => ({
  name,
  type: 'start',
  describeParams: () => ({}),
  resolve: () => ({ kind: 'stream', build: () => { throw new Error('stub'); } }),
});

describe('ServiceRegistry', () => {
  test('get() resolves a registered service by name', () => {
    const r = createRegistry([stubService('tinker.search')]);
    expect(r.get('tinker.search')?.name).toBe('tinker.search');
    expect(r.get('nope')).toBeUndefined();
  });

  test('list() enumerates services but EXCLUDES the directory service', () => {
    const r = createRegistry([
      stubService(DIRECTORY_SERVICE_NAME),
      stubService('tinker.search'),
      stubService('tinker.degree.centrality'),
    ]);
    const names = r.list().map((s) => s.name).sort();
    expect(names).toEqual(['tinker.degree.centrality', 'tinker.search']);
    // the directory itself is still resolvable by name, just not listed
    expect(r.get(DIRECTORY_SERVICE_NAME)?.name).toBe(DIRECTORY_SERVICE_NAME);
  });

  test('defaultRegistry exists and is enumerable (empty until services land)', () => {
    expect(Array.isArray(defaultRegistry.list())).toBe(true);
  });
});
