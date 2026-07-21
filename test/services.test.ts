import { test, expect, describe } from 'bun:test';
import { createRegistry, EMPTY_REGISTRY } from '../src/services/registry.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { directoryService } from '../src/services/directory.ts';
import { DIRECTORY_SERVICE_NAME, type Service, type ServiceRegistry } from '../src/services/types.ts';
import { parseGremlin, stepChain } from '../src/frontend.ts';
import { normalize } from '../src/strategies.ts';
import { parseCallSpec } from '../src/services/call-params.ts';
import { compile } from '../src/compiler.ts';
import { runPlan, type Plan } from '../src/segment.ts';
import type { ForeignRow, ServiceEnv } from '../src/services/types.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
import { ioc } from '../src/io.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';

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

  test('EMPTY_REGISTRY is the cycle-free compiler default (no services)', () => {
    expect(EMPTY_REGISTRY.list()).toEqual([]);
    expect(EMPTY_REGISTRY.get('--list')).toBeUndefined();
  });

  test('standardRegistry lists the DirectoryService-excluded standard services', () => {
    // --list itself is registered but excluded from list(); as more services land they
    // appear here. It is always resolvable by name.
    expect(standardRegistry.get('--list')?.name).toBe('--list');
  });
});

describe('segment plan trampoline (runPlan)', () => {
  // A stand-in Compiled — runPlan never inspects its internals, only the caller's readHead
  // does, so a bare tagged object is enough to drive the trampoline in isolation.
  const compiled = (tag: string): any => ({ kind: 'read', sql: tag, binds: [], shape: { kind: 'discard' } });
  const noEnv: ServiceEnv = { federateQuery: async () => { throw new Error('unused'); } };
  const vrow = (id: number, ordinal?: number): ForeignRow => ({ kind: 'vertex', id, label: 'x', props: {}, ordinal });

  test('a plain sql Plan returns immediately, no async work', async () => {
    const c = compiled('final');
    const out = await runPlan({ kind: 'sql', compiled: c }, noEnv, () => { throw new Error('readHead must not run'); });
    expect(out).toBe(c);
  });

  test('a single barrier segment: read head -> await apply -> resume to sql', async () => {
    const final = compiled('resumed');
    let sawRows: readonly ForeignRow[] | undefined;
    const plan: Plan = {
      kind: 'segment',
      head: compiled('head'),
      params: {},
      apply: async (rows) => { sawRows = rows; return [vrow(1), vrow(2)]; },
      resume: (foreign) => { expect(foreign.map((r) => r.id)).toEqual([1, 2]); return { kind: 'sql', compiled: final }; },
    };
    const out = await runPlan(plan, noEnv, (h) => { expect(h.sql).toBe('head'); return [vrow(9)]; });
    expect(sawRows?.map((r) => r.id)).toEqual([9]); // head rows reached apply
    expect(out).toBe(final);
  });

  test('a null head (source form) applies over an empty input, readHead never called', async () => {
    const final = compiled('src');
    let sawRows: readonly ForeignRow[] | undefined;
    const plan: Plan = {
      kind: 'segment', head: null, params: { graph: 'orders' },
      apply: async (rows) => { sawRows = rows; return [vrow(7)]; },
      resume: () => ({ kind: 'sql', compiled: final }),
    };
    const out = await runPlan(plan, noEnv, () => { throw new Error('readHead must not run for a null head'); });
    expect(sawRows).toEqual([]);
    expect(out).toBe(final);
  });

  test('chained segments: resume can itself yield another segment (multi-hop)', async () => {
    const final = compiled('after-two-hops');
    const hopB: Plan = {
      kind: 'segment', head: null, params: {},
      apply: async () => [vrow(2)],
      resume: () => ({ kind: 'sql', compiled: final }),
    };
    const hopA: Plan = {
      kind: 'segment', head: null, params: {},
      apply: async () => [vrow(1)],
      resume: () => hopB, // second call() in the chain
    };
    const out = await runPlan(hopA, noEnv, () => []);
    expect(out).toBe(final);
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

  test('an unrooted nested-traversal param value fails closed (must be source-rooted)', () => {
    // A nested traversal as a param VALUE is a sub-traversal (federate's `traversal`): it
    // serializes to a rooted Gremlin string. An unrooted body (__.out()…) cannot become a
    // valid g.-rooted query, so it fails closed — no silent guessed source.
    expect(() => spec('g.call("mogwai.graph.federate").with("traversal", __.out().values("name"))'))
      .toThrow(/source-rooted/);
  });

  test('a rooted nested-traversal param value serializes to a canonical Gremlin string', () => {
    const s = spec('g.call("mogwai.graph.federate").with("graph", "orders").with("traversal", __.V().has("age", gt(30)))');
    expect(s.serviceName).toBe('mogwai.graph.federate');
    expect(s.params.graph).toBe('orders');
    expect(s.params.traversal).toEqual({ kind: 'traversal', gremlin: 'g.V().has("age", P.gt(30))' });
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
      resolve: () => ({ kind: 'barrier', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    expect(() => compile('g.call("mogwai.graph.federate")', {}, { registry: reg }))
      .toThrow(/barrier\/async services are not yet supported/);
  });
});

describe('--list (DirectoryService) — end to end over GraphBinary', () => {
  // Register the real directoryService alongside stubs for the OTHER standard services, so
  // --list enumerates realistic names (the actual tinker.* services land in later steps; the
  // directory doesn't care what they do, only that they're registered).
  const reg: ServiceRegistry = createRegistry([
    directoryService, stubService('tinker.search'), stubService('tinker.degree.centrality'),
  ]);
  const store = new GraphStore(new BunSqlite(':memory:'));
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v as string;
  const run = (g: string, params: Record<string, any> = {}) =>
    executeQuery(store, g, params, {}, reg).map(dec);

  test('g_call — bare g.call() lists every service (directory excluded)', () => {
    expect(run('g.call()').sort()).toEqual(['tinker.degree.centrality', 'tinker.search']);
  });

  test('g_callXlistX — explicit "--list" lists every service', () => {
    expect(run('g.call("--list")').sort()).toEqual(['tinker.degree.centrality', 'tinker.search']);
  });

  test('g_callXlistX_withXstring_stringX — .with(service, name) filters', () => {
    expect(run('g.call("--list").with("service", "tinker.search")')).toEqual(['tinker.search']);
  });

  test('g_callXlistX_withXstring_traversalX — .with(service, __.constant(name)) filters', () => {
    expect(run('g.call("--list").with("service", __.constant("tinker.search"))')).toEqual(['tinker.search']);
  });

  test('g_callXlist_mapX — a map param filters', () => {
    expect(run('g.call("--list", xx1)', { xx1: new Map([['service', 'tinker.search']]) }))
      .toEqual(['tinker.search']);
  });

  test('g_callXlist_traversalX — a __.project(service).by(__.constant(name)) param filters', () => {
    expect(run('g.call("--list", __.project("service").by(__.constant("tinker.search")))'))
      .toEqual(['tinker.search']);
  });

  test('g_callXlist_map_traversalX — map wins when both given', () => {
    expect(run('g.call("--list", xx1, __.project("service").by(__.constant("tinker.search")))',
      { xx1: new Map([['service', 'tinker.search']]) })).toEqual(['tinker.search']);
  });

  test('verbose → a JSON describe blob per service', () => {
    const [blob] = run('g.call("--list").with("service", "tinker.search").with("verbose", true)');
    expect(JSON.parse(blob)).toMatchObject({ name: 'tinker.search', type: 'start' });
  });
});

describe('tinker.degree.centrality — per-vertex edge count', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) executeQuery(store, g, {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const run = (g: string) => executeQuery(store, g, {}, {}, standardRegistry).map(dec);
  // Decode the project record into a name→degree map (TinkerPop results are UNORDERED, so
  // assert as a map rather than a positional array — g.V() order is unspecified).
  const projMap = (g: string, params: Record<string, any> = {}): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const b of executeQuery(store, g, params, {}, standardRegistry)) {
      const m: any = dec(b);
      const name = m.get('vertex').properties?.find((p: any) => p.label === 'name')?.value;
      out[name] = Number(m.get('degree'));
    }
    return out;
  };
  const IN = { marko: 0, vadas: 1, lop: 3, josh: 1, ripple: 1, peter: 0 };
  const OUT = { marko: 3, vadas: 0, lop: 0, josh: 2, ripple: 0, peter: 1 };

  test('g_V_callXdcX — IN degree per vertex, projected with its vertex', () => {
    expect(projMap('g.V().as("v").call("tinker.degree.centrality").project("vertex","degree").by(select("v")).by()'))
      .toEqual(IN);
  });

  test('g_V_callXdcX_withXdirection_OUTX — OUT degree', () => {
    expect(projMap('g.V().as("v").call("tinker.degree.centrality").with("direction", OUT).project("vertex","degree").by(select("v")).by()'))
      .toEqual(OUT);
  });

  test('g_V_callXdc_mapX_withXdirection_OUTX — a (ignored) map arg + with(direction) OUT', () => {
    expect(projMap('g.V().as("v").call("tinker.degree.centrality", xx1).with("direction", OUT).project("vertex","degree").by(select("v")).by()',
      { xx1: new Map([['x', 'y']]) })).toEqual(OUT);
  });

  test('g_V_callXdc_traversalX — direction via __.project(direction).by(__.constant(OUT))', () => {
    expect(projMap('g.V().as("v").call("tinker.degree.centrality", __.project("direction").by(__.constant(OUT))).project("vertex","degree").by(select("v")).by()'))
      .toEqual(OUT);
  });

  test('bare mid-traversal degree (no project) yields one scalar per vertex', () => {
    // Order-independent: the multiset of degrees matches IN's values.
    expect(run('g.V().call("tinker.degree.centrality")').map(Number).sort())
      .toEqual(Object.values(IN).sort());
  });

  // Step 5b: a call() body inside where() is recognized as a scalar child via the generalized
  // "lowers-to-scalar" classifier (not a hardcoded values/id/label vocabulary). The child scope
  // is derived from the parent stream so the service reduces per input vertex.
  test('g_V_whereXcallXdcXX — where(call(dc).is(3)) keeps only IN-degree-3 vertices (lop)', () => {
    const names = (g: string) =>
      executeQuery(store, g, {}, {}, standardRegistry).map((b) => {
        const v: any = dec(b);
        return v.properties?.find((p: any) => p.label === 'name')?.value;
      });
    // Only `lop` has IN-degree 3 in the modern graph.
    expect(names('g.V().where(call("tinker.degree.centrality").is(3))')).toEqual(['lop']);
  });

  test('where(call(dc).with(direction,OUT).is(3)) keeps only OUT-degree-3 vertices (marko)', () => {
    const names = (g: string) =>
      executeQuery(store, g, {}, {}, standardRegistry).map((b) => {
        const v: any = dec(b);
        return v.properties?.find((p: any) => p.label === 'name')?.value;
      });
    expect(names('g.V().where(call("tinker.degree.centrality").with("direction", OUT).is(3))')).toEqual(['marko']);
  });
});
