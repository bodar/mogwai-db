import { describe, expect, test } from 'bun:test';
import { createAppScope, createRequestScope, createCompilerScope } from '../src/scopes.ts';
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

  test('a compiler scope inherits app AND request deps by direct access', () => {
    const registry = createRegistry([]);
    const fastPaths = { ...DEFAULT_FAST_PATHS, movementCollapse: false };
    const app = createAppScope({ registry: () => registry, fastPaths });
    const sourceOptions = new Map([['~mogwai.test', true]]);
    const request = createRequestScope(app, { params: { x: 1 }, federationDepth: 2, sourceOptions });
    const scope = createCompilerScope(request);

    // inherited from the app scope — the direct-read contract
    expect(scope.registry).toBe(registry);
    expect(scope.fastPaths).toBe(fastPaths);
    expect(scope.fastPaths.movementCollapse).toBe(false);

    // inherited from the request scope — one traversal's fixed context
    expect(scope.params).toEqual({ x: 1 });
    expect(scope.federationDepth).toBe(2);
    expect(scope.sourceOptions).toBe(sourceOptions);

    // the compiler scope's own per-compilation collaborator
    expect(scope.q).toBeDefined();
  });

  test('a nested sub-compile INHERITS the whole request — only the Query is fresh', () => {
    // What the request tier is for: before it, every nested createCompilerScope restated params
    // and federationDepth, and silently reset sourceOptions to an empty Map.
    const sourceOptions = new Map([['~mogwai.test', true]]);
    const request = createRequestScope(createAppScope(), { params: { x: 1 }, federationDepth: 3, sourceOptions });
    const nested = createCompilerScope(request);
    expect(nested.federationDepth).toBe(3);
    expect(nested.sourceOptions).toBe(sourceOptions);
    expect(nested.params).toEqual({ x: 1 });
  });

  test('params is the one request entry a sub-compile may override', () => {
    // inject() seeds its own source and lowers against an empty param table; everything else it
    // must still inherit. An ABSENT override inherits rather than resetting to {}.
    const request = createRequestScope(createAppScope(), { params: { x: 1 }, federationDepth: 3 });
    expect(createCompilerScope(request, { params: {} }).params).toEqual({});
    expect(createCompilerScope(request, { params: {} }).federationDepth).toBe(3);
    expect(createCompilerScope(request, {}).params).toEqual({ x: 1 });
  });

  test('the registry provider is LAZY and sees the whole scope it lives in', () => {
    // Constraint 1 of docs/2026-07-31-di-scopes-and-services-plan.md: `registry` is a function of
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

  test('each compiler scope gets a fresh Query but shares the request scope', () => {
    const request = createRequestScope(createAppScope(), {});
    const a = createCompilerScope(request);
    const b = createCompilerScope(request);
    expect(a.q).not.toBe(b.q);          // independent CTE namespaces
    expect(a.registry).toBe(b.registry); // same shared app-scope dependency
  });
});
