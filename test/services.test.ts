import { test, expect, describe } from 'bun:test';
import { createRegistry, defaultRegistry, DIRECTORY_SERVICE_NAME } from '../src/services/registry.ts';
import type { Service } from '../src/services/types.ts';
import { parseGremlin, stepChain } from '../src/frontend.ts';
import { normalize } from '../src/strategies.ts';
import { parseCallSpec } from '../src/services/call-params.ts';
import { compile } from '../src/compiler.ts';

/** Parse a gremlin string, normalize, and return the (single) folded call PStep. */
const callStep = (gremlin: string, params: Record<string, any> = {}) => {
  const steps = normalize(stepChain(parseGremlin(gremlin), params)).steps;
  return steps.find((s) => s.name === 'call')!;
};
const spec = (gremlin: string, params: Record<string, any> = {}) =>
  parseCallSpec(callStep(gremlin, params), params);

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

describe('call/with fold + param resolution', () => {
  test('bare g.call() defaults to the directory service, no params', () => {
    expect(spec('g.call()')).toEqual({ serviceName: DIRECTORY_SERVICE_NAME, params: {} });
  });

  test('g.call("--list") — explicit name, no params', () => {
    expect(spec('g.call("--list")')).toEqual({ serviceName: '--list', params: {} });
  });

  test('.with(k, string) folds onto the call and resolves to a string param', () => {
    expect(spec('g.call("--list").with("service", "tinker.search")'))
      .toEqual({ serviceName: '--list', params: { service: 'tinker.search' } });
  });

  test('.with(k, __.constant(x)) resolves the traversal to its constant', () => {
    expect(spec('g.call("--list").with("service", __.constant("tinker.search"))'))
      .toEqual({ serviceName: '--list', params: { service: 'tinker.search' } });
  });

  test('a bound-param Map arg becomes the params', () => {
    expect(spec('g.call("--list", xx1)', { xx1: new Map([['service', 'tinker.search']]) }))
      .toEqual({ serviceName: '--list', params: { service: 'tinker.search' } });
  });

  test('a __.project(k).by(__.constant(v)) traversal arg becomes a constant map', () => {
    expect(spec('g.call("--list", __.project("service").by(__.constant("tinker.search")))'))
      .toEqual({ serviceName: '--list', params: { service: 'tinker.search' } });
  });

  test('when BOTH a map and a traversal arg are given, the map wins', () => {
    // TinkerPop's own g_callXlist_map_traversalX note: the map is what applies.
    expect(spec('g.call("--list", xx1, __.project("service").by(__.constant("tinker.search")))',
      { xx1: new Map([['x', 'y']]) }))
      .toEqual({ serviceName: '--list', params: { x: 'y' } });
  });

  test('.with() layers on top of a map arg, winning on key collision', () => {
    expect(spec('g.call("tinker.search", xx1).with("type", "Vertex")',
      { xx1: new Map([['search', 'mar']]) }))
      .toEqual({ serviceName: 'tinker.search', params: { search: 'mar', type: 'Vertex' } });
  });

  test('mid-traversal .with(direction, OUT) carries the enum token', () => {
    // OUT parses as {direction:'out'}; the service interprets it (Step 5).
    expect(spec('g.V().as("v").call("tinker.degree.centrality").with("direction", OUT)').params)
      .toEqual({ direction: { direction: 'out' } });
  });

  test('a non-constant param-value traversal fails closed', () => {
    expect(() => spec('g.call("tinker.search").with("search", __.out().values("name"))'))
      .toThrow(/not yet supported/);
  });
});

describe('call() routing (seedCall)', () => {
  test('an unknown service throws a clear error (end-to-end parse→fold→spec→registry)', () => {
    // defaultRegistry is empty until services land, so --list is unknown here.
    expect(() => compile('g.call("--list")', {})).toThrow(/unknown service '--list'/);
  });

  test('a registered service is reached with its resolved params', () => {
    let seenParams: unknown;
    const probe: Service = {
      name: '--list',
      type: 'start',
      describeParams: () => ({}),
      resolve: (ctx) => ({
        kind: 'stream',
        build: (c) => { seenParams = c.params; throw new Error('probe-reached'); },
      }),
    };
    const reg = createRegistry([probe]);
    expect(() => compile('g.call("--list").with("service", "tinker.search")', {}, { registry: reg }))
      .toThrow(/probe-reached/);
    expect(seenParams).toEqual({ service: 'tinker.search' });
  });

  test('a barrier-kind service fails closed as not-yet-supported (Phase 6)', () => {
    const federate: Service = {
      name: 'mogwai.graph.federate',
      type: 'barrier',
      describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', apply: () => [] }),
    };
    const reg = createRegistry([federate]);
    expect(() => compile('g.call("mogwai.graph.federate")', {}, { registry: reg }))
      .toThrow(/barrier\/async services are not yet supported/);
  });
});
