import { test, expect, describe } from 'bun:test';
import { createRegistry, EMPTY_REGISTRY } from '../src/services/spi/registry.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { directoryService } from '../src/services/catalog/directory.ts';
import { DIRECTORY_SERVICE_NAME, type Service, type ServiceRegistry } from '../src/services/spi/types.ts';
import { parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { normalize } from '../src/compiler/ir/passes.ts';
import { parseCallSpec, injectionKindOf } from '../src/services/params/call-params.ts';
import { compile, compilePlan } from '../src/compiler/compiler.ts';
import type { ForeignRow } from '../src/services/spi/types.ts';
import type { FederationSource } from '../src/compiler/segment.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from './support/executor.ts';
import { Executor } from '../src/execute.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode, decodeAll } from './support/decode.ts';

/** Parse a gremlin string, normalize, and return the (single) folded call IRStep. */
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

  // ---- mid-traversal per-parent INJECTION (the 3rd positional arg) ----

  test('a values(k)/id()/label() 3rd arg (beside a map) is captured as the injection', () => {
    for (const inj of ['__.values("name")', '__.id()', '__.label()']) {
      const s = spec(`g.call("mogwai.graph.federate", ["graph":"crew"], ${inj})`);
      expect(s.injectionTraversal).toBeDefined();          // captured
      expect(s.params).toEqual({ graph: 'crew' });         // map still wins as params
    }
  });

  test('injectionKindOf classifies the supported direct value reads and rejects others', () => {
    const kind = (inj: string) => injectionKindOf(callStep(`g.call("s", ["a":"b"], ${inj})`).args[2].nested, {});
    expect(kind('__.values("name")')).toEqual({ kind: 'values', key: 'name' });
    expect(kind('__.id()')).toEqual({ kind: 'id' });
    expect(kind('__.label()')).toEqual({ kind: 'label' });
    // Computed / non-direct → null (the caller fails closed with a clear deferral).
    expect(kind('__.values("name").fold()')).toBeNull();
    expect(kind('__.out().count()')).toBeNull();
    expect(kind('__.constant(1)')).toBeNull();
  });

  test('a NON-injection traversal beside a map is NOT captured (the --list dynamic-params form)', () => {
    // call(name, map, project-traversal) is TinkerPop's call_string_map_traversal: the map wins,
    // the traversal is ordinary dynamic params — NEVER an injection (and never retains the cyclic
    // antlr node, which a toEqual on the spec would choke on).
    const s = spec('g.call("--list", ["service":"tinker.search"], __.project("x").by(__.constant("y")))');
    expect(s.injectionTraversal).toBeUndefined();
    expect(s.params).toEqual({ service: 'tinker.search' });
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

  test('compile() on a barrier source throws — it needs the async segment executor', () => {
    const federate: Service = {
      name: 'mogwai.graph.federate',
      type: 'barrier',
      describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    // compile() is synchronous and cannot resolve a barrier; the executor (executeFramed) drives
    // the async segment plan. compilePlan yields a segment instead of throwing.
    expect(() => compile('g.call("mogwai.graph.federate")', {}, { registry: reg }))
      .toThrow(/segment executor/);
  });

  test('compilePlan() on a barrier source yields a segment plan (head=null for a source)', () => {
    const federate: Service = {
      name: 'mogwai.graph.federate',
      type: 'barrier',
      describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    const plan = compilePlan('g.call("mogwai.graph.federate")', {}, { registry: reg });
    expect(plan.kind).toBe('segment');
    if (plan.kind === 'segment') expect(plan.head).toBeNull();
  });

  test('compilePlan() on a MID-TRAVERSAL barrier yields a segment with a per-parent head (o + injVal)', () => {
    const federate: Service = {
      name: 'mogwai.graph.federate', type: 'barrier', describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    const plan = compilePlan(
      'g.V().call("mogwai.graph.federate", ["graph":"crew"], __.values("name"))', {}, { registry: reg });
    expect(plan.kind).toBe('segment');
    if (plan.kind === 'segment') {
      expect(plan.head).not.toBeNull();
      // The head projects the rejoin ordinal `o` and the per-parent injected value `injVal`
      // alongside the ordinary element payload, so readSegmentHead can drain them.
      expect(plan.head!.sql).toContain(' AS o');
      expect(plan.head!.sql).toContain('injVal');
    }
  });

  test('a mid-traversal barrier with an UNSUPPORTED injection fails closed', () => {
    const federate: Service = {
      name: 'mogwai.graph.federate', type: 'barrier', describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    expect(() => compilePlan(
      'g.V().call("mogwai.graph.federate", ["graph":"crew"], __.values("name").fold())', {}, { registry: reg }))
      .toThrow(/injection must be a direct value read/);
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
  const dec = async (b: Buffer) => await decode(b) as string;
  const run = async (g: string, params: Record<string, any> = {}) =>
    decodeAll(executeQuery(store, g, params, {}, reg));

  test('g_call — bare g.call() lists every service (directory excluded)', async () => {
    expect((await run('g.call()')).sort()).toEqual(['tinker.degree.centrality', 'tinker.search']);
  });

  test('g_callXlistX — explicit "--list" lists every service', async () => {
    expect((await run('g.call("--list")')).sort()).toEqual(['tinker.degree.centrality', 'tinker.search']);
  });

  test('g_callXlistX_withXstring_stringX — .with(service, name) filters', async () => {
    expect(await run('g.call("--list").with("service", "tinker.search")')).toEqual(['tinker.search']);
  });

  test('g_callXlistX_withXstring_traversalX — .with(service, __.constant(name)) filters', async () => {
    expect(await run('g.call("--list").with("service", __.constant("tinker.search"))')).toEqual(['tinker.search']);
  });

  test('g_callXlist_mapX — a map param filters', async () => {
    expect(await run('g.call("--list", xx1)', { xx1: new Map([['service', 'tinker.search']]) }))
      .toEqual(['tinker.search']);
  });

  test('g_callXlist_traversalX — a __.project(service).by(__.constant(name)) param filters', async () => {
    expect(await run('g.call("--list", __.project("service").by(__.constant("tinker.search")))'))
      .toEqual(['tinker.search']);
  });

  test('g_callXlist_map_traversalX — map wins when both given', async () => {
    expect(await run('g.call("--list", xx1, __.project("service").by(__.constant("tinker.search")))',
      { xx1: new Map([['service', 'tinker.search']]) })).toEqual(['tinker.search']);
  });

  test('verbose → a JSON describe blob per service', async () => {
    const [blob] = await run('g.call("--list").with("service", "tinker.search").with("verbose", true)');
    expect(JSON.parse(blob)).toMatchObject({ name: 'tinker.search', type: 'start' });
  });
});

describe('tinker.degree.centrality — per-vertex edge count', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) executeQuery(store, g, {});
  const dec = (b: Buffer) => decode(b);
  const run = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}, {}, standardRegistry)));
  // Decode the project record into a name→degree map (TinkerPop results are UNORDERED, so
  // assert as a map rather than a positional array — g.V() order is unspecified).
  const projMap = async (g: string, params: Record<string, any> = {}): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const b of executeQuery(store, g, params, {}, standardRegistry)) {
      const m: any = await dec(b);
      const name = m.get('vertex').properties?.find((p: any) => p.label === 'name')?.value;
      out[name] = Number(m.get('degree'));
    }
    return out;
  };
  const IN = { marko: 0, vadas: 1, lop: 3, josh: 1, ripple: 1, peter: 0 };
  const OUT = { marko: 3, vadas: 0, lop: 0, josh: 2, ripple: 0, peter: 1 };

  test('g_V_callXdcX — IN degree per vertex, projected with its vertex', async () => {
    expect(await projMap('g.V().as("v").call("tinker.degree.centrality").project("vertex","degree").by(select("v")).by()'))
      .toEqual(IN);
  });

  test('g_V_callXdcX_withXdirection_OUTX — OUT degree', async () => {
    expect(await projMap('g.V().as("v").call("tinker.degree.centrality").with("direction", OUT).project("vertex","degree").by(select("v")).by()'))
      .toEqual(OUT);
  });

  test('g_V_callXdc_mapX_withXdirection_OUTX — a (ignored) map arg + with(direction) OUT', async () => {
    expect(await projMap('g.V().as("v").call("tinker.degree.centrality", xx1).with("direction", OUT).project("vertex","degree").by(select("v")).by()',
      { xx1: new Map([['x', 'y']]) })).toEqual(OUT);
  });

  test('g_V_callXdc_traversalX — direction via __.project(direction).by(__.constant(OUT))', async () => {
    expect(await projMap('g.V().as("v").call("tinker.degree.centrality", __.project("direction").by(__.constant(OUT))).project("vertex","degree").by(select("v")).by()'))
      .toEqual(OUT);
  });

  test('bare mid-traversal degree (no project) yields one scalar per vertex', async () => {
    // Order-independent: the multiset of degrees matches IN's values.
    expect((await run('g.V().call("tinker.degree.centrality")')).map(Number).sort())
      .toEqual(Object.values(IN).sort());
  });

  // Step 5b: a call() body inside where() is recognized as a scalar child via the generalized
  // "lowers-to-scalar" classifier (not a hardcoded values/id/label vocabulary). The child scope
  // is derived from the parent stream so the service reduces per input vertex.
  test('g_V_whereXcallXdcXX — where(call(dc).is(3)) keeps only IN-degree-3 vertices (lop)', async () => {
    const names = async (g: string) =>
      (await decodeAll(executeQuery(store, g, {}, {}, standardRegistry)))
        .map((v: any) => v.properties?.find((p: any) => p.label === 'name')?.value);
    // Only `lop` has IN-degree 3 in the modern graph.
    expect(await names('g.V().where(call("tinker.degree.centrality").is(3))')).toEqual(['lop']);
  });

  test('where(call(dc).with(direction,OUT).is(3)) keeps only OUT-degree-3 vertices (marko)', async () => {
    const names = async (g: string) =>
      (await decodeAll(executeQuery(store, g, {}, {}, standardRegistry)))
        .map((v: any) => v.properties?.find((p: any) => p.label === 'name')?.value);
    expect(await names('g.V().where(call("tinker.degree.centrality").with("direction", OUT).is(3))')).toEqual(['marko']);
  });
});

describe('barrier source form via Executor (stub source → drive → land → frame)', () => {
  // A STUB barrier service + STUB FederationSource — exercises the Executor's segment drive
  // (compilePlan yields a segment → framedAsync awaits apply → lands rows → frames GraphBinary)
  // in ISOLATION, without a manager or real graphs. The source's executor(id).raw returns
  // synthetic detached rows. (The REAL two-graph stack is federation.test.ts.)
  const foreignVerts: ForeignRow[] = [
    { kind: 'vertex', id: 1, label: 'person', props: { name: [{ t: 'string', v: 'alice' }] } },
    { kind: 'vertex', id: 2, label: 'person', props: { name: [{ t: 'string', v: 'bob' }] } },
  ];
  const stubFederate: Service = {
    name: 'mogwai.graph.federate',
    type: 'barrier',
    describeParams: () => ({}),
    resolve: () => ({ kind: 'barrier', apply: async (_in, params, source, depth) => source.executor(String(params.graph)).raw('g.V()', {}, depth + 1) }),
  };
  const stubSource: FederationSource = { executor: () => ({ raw: async () => foreignVerts }) };
  const store = new GraphStore(new BunSqlite(':memory:')); // empty — foreign rows are literals
  const reg = createRegistry([stubFederate]);
  const ex = new Executor(store, reg, stubSource); // Executor bound directly to the stub source
  const dec = (b: Buffer) => decode(b);
  const run = async (g: string) => decodeAll((await ex.framedAsync(g, {})).map((f: any) => f.buf));

  test('g.call(federate) lands the sibling vertices as detached references', async () => {
    const vs: any[] = await run('g.call("mogwai.graph.federate").with("graph", "orders")');
    expect(vs.map((v) => v.constructor.name)).toEqual(['Vertex', 'Vertex']);
    expect(vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort()).toEqual(['alice', 'bob']);
  });

  test('a read tail on the federated result runs locally (values over the landed props)', async () => {
    const names: any[] = await run('g.call("mogwai.graph.federate").with("graph", "orders").values("name")');
    expect(names.sort()).toEqual(['alice', 'bob']);
  });

  test('id() over the federated result reads the landed id', async () => {
    const ids: any[] = await run('g.call("mogwai.graph.federate").with("graph", "orders").id()');
    expect(ids.map(String).sort()).toEqual(['1', '2']);
  });

  test('the sync path fails closed on a barrier (use framedAsync)', () => {
    expect(() => ex.framed('g.call("mogwai.graph.federate").with("graph","x")', {}))
      .toThrow(/use the async path/);
  });
});
