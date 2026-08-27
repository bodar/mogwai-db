import { test, expect, describe } from 'bun:test';
import { createRegistry, EMPTY_REGISTRY } from '../src/services/spi/registry.ts';
import { standardRegistry, extendedRegistry } from '../src/services/standard.ts';
import { createAppScope, type RegistryProvider } from '../src/scopes.ts';
import { createDirectoryService } from '../src/services/catalog/directory.ts';
import { createFederateService } from '../src/services/catalog/federate.ts';
import { createIoService } from '../src/services/catalog/io.ts';
import type { IoStore } from '../src/iostore.ts';
import { DIRECTORY_SERVICE_NAME, type Service, type ServiceRegistry } from '../src/services/spi/types.ts';
import { parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { normalize } from '../src/compiler/ir/passes.ts';
import { parseCallSpec, injectionKindOf } from '../src/services/params/call-params.ts';
import { compile, compilePlan } from '../src/compiler/compiler.ts';
import type { ForeignRow } from '../src/services/spi/types.ts';
import type { FederationSource } from '../src/compiler/segment.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { exec, executeQuery } from './support/executor.ts';
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

/** A registry is a function OF its app scope now (services take dependencies at construction), so
 *  resolving one for a direct assertion means minting the scope it lives in. */
const resolved = (provider: RegistryProvider): ServiceRegistry => createAppScope({ registry: provider }).registry;

const stubService = (name: string, internal = false): Service => ({
  name,
  type: 'start',
  internal,
  describeParams: () => ({}),
  resolve: () => ({ kind: 'rel', buildRel: () => { throw new Error('stub'); } }),
});

describe('ServiceRegistry', () => {
  test('get() resolves a registered service by name', () => {
    const r = createRegistry([stubService('tinker.search')]);
    expect(r.get('tinker.search')?.name).toBe('tinker.search');
    expect(r.get('nope')).toBeUndefined();
  });

  test('list() enumerates services but EXCLUDES every internal one', () => {
    const r = createRegistry([
      stubService(DIRECTORY_SERVICE_NAME, true),
      stubService('tinker.search'),
      stubService('tinker.degree.centrality'),
    ]);
    const names = r.list().map((s) => s.name).sort();
    expect(names).toEqual(['tinker.degree.centrality', 'tinker.search']);
    // the directory itself is still resolvable by name, just not listed
    expect(r.get(DIRECTORY_SERVICE_NAME)?.name).toBe(DIRECTORY_SERVICE_NAME);
  });

  test('internal is a FLAG, not the directory name — any service can opt out of --list', () => {
    // What constraint 3 of docs/archive/2026-07-31-di-scopes-and-services-plan.md buys: a service that
    // backs a sugar step (io()) can exist in the production registry and stay out of the
    // reference provider surface the official g_call/g_callXlistX scenarios assert.
    const r = createRegistry([stubService('io', true), stubService('tinker.search')]);
    expect(r.list().map((s) => s.name)).toEqual(['tinker.search']);
    expect(r.get('io')?.name).toBe('io');
  });

  test('EMPTY_REGISTRY is the cycle-free compiler default (no services)', () => {
    expect(EMPTY_REGISTRY.list()).toEqual([]);
    expect(EMPTY_REGISTRY.get('--list')).toBeUndefined();
  });

  test('standardRegistry.list() IS the reference provider surface, exactly', () => {
    // The official g_call / g_callXlistX scenarios assert this exact set, so this is a
    // conformance obligation, not a convenience assertion: anything added to the standard
    // registry that is not a reference service must be `internal` (or belong in extendedRegistry).
    expect(resolved(standardRegistry).list().map((s) => s.name).sort())
      .toEqual(['tinker.degree.centrality', 'tinker.search']);
    // --list itself is registered but excluded from list(). It is always resolvable by name.
    expect(resolved(standardRegistry).get('--list')?.name).toBe('--list');
  });

  test('extendedRegistry.list() is the reference surface PLUS our mogwai.* extensions', () => {
    expect(resolved(extendedRegistry).list().map((s) => s.name).sort())
      .toEqual(['federate', 'schema', 'tinker.degree.centrality', 'tinker.search']);
    expect(resolved(extendedRegistry).get('--list')?.name).toBe('--list');
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

  test('an unrooted nested-traversal param value is CARRIED verbatim (rooted-check moved to federate)', () => {
    // A nested traversal as a param VALUE serializes to a Gremlin string: a source-rooted body to
    // `g.…`, an anonymous body to its `__.…` form verbatim. The source-rooted REQUIREMENT is
    // federate's alone (it runs the traversal on a sibling), so it lives in federate now, not here —
    // an OLAP edge scope (`~tinkerpop.<algo>.edges`) carries an anonymous body through this same seam.
    // federate's own rejection of an unrooted body is federation.test.ts.
    expect(spec('g.call("federate").with("traversal", __.out().values("name"))').params.traversal)
      .toEqual({ kind: 'traversal', gremlin: '__.out().values("name")' });
  });

  test('a rooted nested-traversal param value serializes to a canonical Gremlin string', () => {
    const s = spec('g.call("federate").with("graph", "orders").with("traversal", __.V().has("age", gt(30)))');
    expect(s.serviceName).toBe('federate');
    expect(s.params.graph).toBe('orders');
    expect(s.params.traversal).toEqual({ kind: 'traversal', gremlin: 'g.V().has("age", P.gt(30))' });
  });

  // ---- mid-traversal per-parent INJECTION (the `parent` marker inside the traversal) ----

  test('a parent marker inside the traversal is captured as the injection', () => {
    for (const read of ['__.values("name")', '__.id()', '__.label()']) {
      const s = spec(`g.call("federate", ["graph":"crew", "traversal": __.V().has("name", __.call("parent", ${read}))])`);
      expect(s.injectionTraversal).toBeDefined();          // the marker's READ body, captured
      expect(s.params.graph).toBe('crew');
    }
  });

  test('injectionKindOf classifies the supported direct value reads and rejects others', () => {
    // Classifies the marker's READ body (`call("parent", <read>)`'s 2nd arg). Feed the read directly.
    const kind = (read: string) => injectionKindOf(callStep(`g.call("parent", ${read})`).args[1].value.nested, {});
    expect(kind('__.values("name")')).toEqual({ kind: 'values', key: 'name' });
    expect(kind('__.id()')).toEqual({ kind: 'id' });
    expect(kind('__.label()')).toEqual({ kind: 'label' });
    // Computed / non-direct → null (the caller fails closed with a clear deferral).
    expect(kind('__.values("name").fold()')).toBeNull();
    expect(kind('__.out().count()')).toBeNull();
    expect(kind('__.constant(1)')).toBeNull();
  });

  test('a bare parent marker (no read) throws at parse — fail closed', () => {
    expect(() => spec('g.call("federate", ["graph":"crew", "traversal": __.V().has("name", __.call("parent"))])'))
      .toThrow(/injection marker needs a read/);
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
      resolve: (c) => { seenParams = c.params; throw new Error('probe-reached'); },
    };
    const reg = createRegistry([probe]);
    expect(() => compile('g.call("--list").with("service", "tinker.search")', {}, { registry: () => reg }))
      .toThrow(/probe-reached/);
    expect(seenParams).toEqual({ service: 'tinker.search' });
  });

  test('compile() on a barrier source throws — it needs the async segment executor', () => {
    const federate: Service = {
      name: 'federate',
      type: 'barrier',
      describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', residency: 'worker', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    // compile() only produces the plan; a barrier segment must be DRIVEN against a store, which bare
    // compile() has no access to. compilePlan yields a segment instead of throwing.
    expect(() => compile('g.call("federate")', {}, { registry: () => reg }))
      .toThrow(/must be DRIVEN against a store/);
  });

  test('compilePlan() on a barrier source yields a segment plan (head=null for a source)', () => {
    const federate: Service = {
      name: 'federate',
      type: 'barrier',
      describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', residency: 'worker', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    const plan = compilePlan('g.call("federate")', {}, { registry: () => reg });
    expect(plan.kind).toBe('segment');
    if (plan.kind === 'segment') expect(plan.head).toBeNull();
  });

  test('compilePlan() on a MID-TRAVERSAL barrier yields a segment whose head reads the INJECTED VALUE', () => {
    const federate: Service = {
      name: 'federate', type: 'barrier', describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', residency: 'worker', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    // The head's shape asserted directly — see the note just below on what it is and why.
    const plan = compilePlan(
      'g.V().call("federate", ["graph":"crew"], __.values("name"))', {}, { registry: () => reg });
    expect(plan.kind).toBe('segment');
    if (plan.kind === 'segment') {
      expect(plan.head).not.toBeNull();
      // The head is the prefix ENDING IN THE INJECTION READ — one scalar row per parent, carrying the
      // one field a barrier consumes (`BarrierInput.injectedValue`). It is deliberately NOT the parent
      // element: materializing an id, a label set and a property bag to reach one value was work whose
      // only consumer discarded it.
      expect(plan.head!.shape.kind).toBe('value');
      expect(plan.head!.sql).toContain(' AS v');
    }
  });

  test('a mid-traversal barrier with an UNSUPPORTED injection fails closed', () => {
    const federate: Service = {
      name: 'federate', type: 'barrier', describeParams: () => ({}),
      resolve: () => ({ kind: 'barrier', residency: 'worker', apply: async () => [] }),
    };
    const reg = createRegistry([federate]);
    // The parent marker's read is a computed scalar (`values(k).fold()`) — not a direct value read.
    expect(() => compilePlan(
      'g.V().call("federate", ["graph":"crew", "traversal": __.V().has("name", __.call("parent", __.values("name").fold()))])', {}, { registry: () => reg }))
      .toThrow(/must be a direct value read/);
  });
});

describe('--list (DirectoryService) — end to end over GraphBinary', () => {
  // Register the real directoryService alongside stubs for the OTHER standard services, so
  // --list enumerates realistic names (the actual tinker.* services land in later steps; the
  // directory doesn't care what they do, only that they're registered).
  const reg: RegistryProvider = (app) => createRegistry([
    createDirectoryService(app), stubService('tinker.search'), stubService('tinker.degree.centrality'),
  ]);
  const store = new GraphStore(new BunSqlite(':memory:'));
  // `--list` has exactly ONE lowering. The directory contributes `kind: 'rel'`, and a service
  // implements `stream` XOR `rel` — two implementations of one service is a duplicated lowering the
  // project forbids. So these assert the answer directly.
  const run = async (g: string, params: Record<string, any> = {}) =>
    decodeAll(exec(store, reg, undefined).buffers(g, params, {}));



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

  // `tinker.degree.centrality` contributes `kind: 'rel'`, and a service implements `stream` XOR `rel`,
  // so it has exactly one lowering. These tests assert its answer directly.
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
    { kind: 'vertex', id: 1, label: 'person', labels: ['person'], props: { name: [{ t: 'string', v: 'alice' }] } },
    { kind: 'vertex', id: 2, label: 'person', labels: ['person'], props: { name: [{ t: 'string', v: 'bob' }] } },
  ];
  // The stub takes its source at CONSTRUCTION off the app scope (exactly as the real federate
  // does) and reads params/depth off the call ctx, so `apply` takes only rows.
  const stubFederate = (source: FederationSource | undefined): Service => ({
    name: 'federate',
    type: 'barrier',
    describeParams: () => ({}),
    resolve: ({ params, federationDepth }) => ({
      kind: 'barrier',
      residency: 'worker',
      apply: async () => {
        const r = await source!.executor(String(params.graph)).raw('g.V()', {}, federationDepth + 1);
        return r.kind === 'elements' ? r.rows : (() => { throw new Error('unexpected scalar'); })();
      },
    }),
  });
  const stubSource: FederationSource = { executor: () => ({ raw: async () => ({ kind: 'elements', rows: foreignVerts }) }) };
  const store = new GraphStore(new BunSqlite(':memory:')); // empty — foreign rows are literals
  const reg: RegistryProvider = (app) => createRegistry([stubFederate(app.source)]);
  // The Executor's own `source` is what lands in the app scope the provider reads.
  const ex = new Executor(store, reg, stubSource);
  const run = async (g: string) => decodeAll((await ex.framedAsync(g, {})).map((f: any) => f.buf));

  test('g.call(federate) lands the sibling vertices as detached references', async () => {
    const vs: any[] = await run('g.call("federate").with("graph", "orders")');
    expect(vs.map((v) => v.constructor.name)).toEqual(['Vertex', 'Vertex']);
    expect(vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort()).toEqual(['alice', 'bob']);
  });

  test('a read tail on the federated result runs locally (values over the landed props)', async () => {
    const names: any[] = await run('g.call("federate").with("graph", "orders").values("name")');
    expect(names.sort()).toEqual(['alice', 'bob']);
  });

  test('id() over the federated result reads the landed id', async () => {
    const ids: any[] = await run('g.call("federate").with("graph", "orders").id()');
    expect(ids.map(String).sort()).toEqual(['1', '2']);
  });

  test('the sync path fails closed on a barrier (use framedAsync)', () => {
    expect(() => ex.framed('g.call("federate").with("graph","x")', {}))
      .toThrow(/use the async path/);
  });
});

// A barrier declares WHERE its apply runs (edge-compilation §4·3). federate is the one barrier that
// leaves the DO — a sibling hop is a remote wait the Worker drives; io stays on the DO (its R2 half
// is a rare admin op not worth hoisting, and its apply closes over the store). Nothing reads this
// yet (the Worker-driven drive loop is Phase 2); the test pins the declared answer so a later change
// cannot silently reclassify which barrier leaves.
describe('barrier residency', () => {
  const site = (params: Record<string, unknown>) => ({ params, boundParams: {}, federationDepth: 0 });

  test('federate is a worker barrier (remote wait), io is a do barrier (store-bound)', () => {
    const fed = createFederateService(undefined).resolve(site({ graph: 'crew', traversal: 'g.V()' }));
    const io = createIoService(undefined as unknown as IoStore, undefined).resolve(site({ path: 'g.json', direction: 'read' }));
    expect(fed.kind).toBe('barrier');
    expect(io.kind).toBe('barrier');
    if (fed.kind === 'barrier') expect(fed.residency).toBe('worker');
    if (io.kind === 'barrier') expect(io.residency).toBe('do');
  });
});

describe('schema — reflect the implicit schema as a map stream', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) executeQuery(store, g, {});
  // Decode the stream to plain objects: each row is a GraphBinary Map. Collect into an array of
  // plain-object records so the assertions read as the schema, not the framing.
  const schema = async (): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    for (const b of exec(store, extendedRegistry).buffers("g.call('schema')", {})) {
      const m: any = await decode(b);
      out.push(Object.fromEntries([...m]));
    }
    return out;
  };
  const of = (rows: Record<string, unknown>[], kind: string) => rows.filter((r) => r.kind === kind);

  test('vertex labels — one record per label with its vertex count', async () => {
    const rows = of(await schema(), 'vertexLabel');
    expect(Object.fromEntries(rows.map((r) => [r.name, r.count]))).toEqual({ person: 4, software: 2 });
  });

  test('properties — one record per (label, key) with its Gremlin type', async () => {
    const rows = of(await schema(), 'property').map((r) => `${r.label}.${r.key}:${r.type}`).sort();
    expect(rows).toEqual(['person.age:int', 'person.name:string', 'software.lang:string', 'software.name:string']);
  });

  test('edges — one record per DISTINCT (srcLabel, edgeLabel, tgtLabel) triple', async () => {
    const rows = of(await schema(), 'edge').map((r) => `${r.src}-${r.label}->${r.tgt}`).sort();
    expect(rows).toEqual(['person-created->software', 'person-knows->person']);
  });

  test('edge properties — one record per (edgeLabel, key) with its type', async () => {
    const rows = of(await schema(), 'edgeProperty').map((r) => `${r.label}.${r.key}:${r.type}`).sort();
    expect(rows).toEqual(['created.weight:double', 'knows.weight:double']);
  });

  test('the stream is composable — count() reaches every element', async () => {
    const [n] = await decodeAll(exec(store, extendedRegistry).buffers("g.call('schema').count()", {}));
    expect(Number(n)).toBe(10); // 2 labels + 4 vertex props + 2 edge triples + 2 edge props
  });

  test('fold() collects the whole schema into one list — the list-of-maps substrate', async () => {
    const [list] = await decodeAll(exec(store, extendedRegistry).buffers("g.call('schema').fold()", {}));
    expect((list as unknown[]).length).toBe(10);
  });

  test('schema is an EXTENSION — absent from the reference registry', () => {
    // In `standardRegistry` (the reference-exact surface the L3 corpus asserts) it must NOT appear, or
    // `--list` would enumerate a non-reference service and fail the official g_call scenarios.
    expect(resolved(standardRegistry).get('schema')).toBeUndefined();
    expect(resolved(extendedRegistry).get('schema')?.name).toBe('schema');
  });
});
