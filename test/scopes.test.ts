import { describe, expect, test } from 'bun:test';
import { createAppScope, createCompilerScope } from '../src/scopes.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';
import { EMPTY_REGISTRY, createRegistry } from '../src/services/registry.ts';

// The DI scopes (src/scopes.ts) separate compiler DEPENDENCIES from per-query state. A
// compiler scope is a CHILD of an app scope and must expose the app scope's entries by DIRECT
// access (registry/fastPaths), not only through a factory — this guards the parent-inheritance
// contract the whole object-model refactor depends on.

describe('DI scopes', () => {
  test('an app scope exposes its own defaults', () => {
    const app = createAppScope();
    expect(app.fastPaths).toBe(DEFAULT_FAST_PATHS);
    expect(app.registry).toBe(EMPTY_REGISTRY);
    expect(app.source).toBeUndefined();
  });

  test('a compiler scope inherits app-scope deps by direct access', () => {
    const registry = createRegistry([]);
    const fastPaths = { ...DEFAULT_FAST_PATHS, movementCollapse: false };
    const app = createAppScope({ registry, fastPaths });
    const scope = createCompilerScope(app, { params: { x: 1 }, federationDepth: 2 });

    // inherited from the app scope — the direct-read contract
    expect(scope.registry).toBe(registry);
    expect(scope.fastPaths).toBe(fastPaths);
    expect(scope.fastPaths.movementCollapse).toBe(false);

    // the compiler scope's own per-compilation collaborators
    expect(scope.params).toEqual({ x: 1 });
    expect(scope.federationDepth).toBe(2);
    expect(scope.q).toBeDefined();
  });

  test('each compiler scope gets a fresh Query but shares the app scope', () => {
    const app = createAppScope();
    const a = createCompilerScope(app, { params: {} });
    const b = createCompilerScope(app, { params: {} });
    expect(a.q).not.toBe(b.q);          // independent CTE namespaces
    expect(a.registry).toBe(b.registry); // same shared app-scope dependency
  });
});
