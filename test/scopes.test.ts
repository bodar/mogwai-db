import { describe, expect, test } from 'bun:test';
import { createAppScope, createRequestScope } from '../src/scopes.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';
import { EMPTY_REGISTRY, createRegistry } from '../src/services/spi/registry.ts';

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

  test('a request scope inherits app deps by direct access', () => {
    const registry = createRegistry([]);
    const fastPaths = { ...DEFAULT_FAST_PATHS, movementCollapse: false };
    const app = createAppScope({ registry: () => registry, fastPaths });
    const sourceOptions = new Map([['~mogwai.test', true]]);
    const scope = createRequestScope(app, { params: { x: 1 }, federationDepth: 2, sourceOptions });

    // inherited from the app scope — the direct-read contract
    expect(scope.registry).toBe(registry);
    expect(scope.fastPaths).toBe(fastPaths);
    expect(scope.fastPaths.movementCollapse).toBe(false);

    // the request scope's own entries — one traversal's fixed context
    expect(scope.params).toEqual({ x: 1 });
    expect(scope.federationDepth).toBe(2);
    expect(scope.sourceOptions).toBe(sourceOptions);
  });

  test('the registry provider is LAZY and sees the whole scope it lives in', () => {
    // Constraint 1 of docs/archive/2026-07-31-di-scopes-and-services-plan.md: `registry` is a function of
    // its own container, so its services take dependencies (source, and the registry itself) at
    // construction. That is only not-a-cycle because the provider runs on first READ.
    let built = 0;
    let seenSource: unknown = 'unread';
    const source = { executor: () => { throw new Error('unused'); } };
    const app = createAppScope({
      source,
      registry: (scope) => { built++; seenSource = scope.source; return createRegistry([]); },
    });
    expect(built).toBe(0);              // declaring the scope builds nothing
    const first = app.registry;
    expect(built).toBe(1);
    expect(seenSource).toBe(source);    // the provider reads its sibling entries
    expect(app.registry).toBe(first);   // and resolves once, not per read
  });


});
