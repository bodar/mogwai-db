import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';
import './support/undici-shim.ts'; // Bun's undici Agent lacks close() — see the shim's header

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const P = gremlin.process.P;

/** A runtime under test: start it, get its ORIGIN (base URL, no graph path), stop
 *  it. Graphs are addressed under `{origin}/gremlin/{id}` identically on both runtimes,
 *  so the same contract proves them equivalent — data plane and management. */
export interface Harness {
  start(): Promise<string>;
  stop(): Promise<void> | void;
}

/**
 * The shared conformance contract. One set of assertions, driven through the
 * real gremlin GLV over GraphBinary — run against every runtime (Bun server,
 * Cloudflare DO) so the two are proven identical, not tested twice. Boots the
 * runtime ONCE, then exercises both the gremlin data plane and the graph
 * management API (create/info/destroy over plain HTTP verbs).
 */
export function graphContract(name: string, harness: Harness) {
  describe(name, () => {
    let origin: string;
    beforeAll(async () => {
      origin = await harness.start();
    }, 60_000); // generous: wrangler dev can take a while to boot
    afterAll(async () => {
      await harness.stop();
    });

    gremlinContract(() => origin);
    managementContract(() => origin);
    docsContract(() => origin);
    ioContract(() => origin);
    federationContract(() => origin);
    olapContract(() => origin);
  });
}

/**
 * OLAP DECORATE barriers (pageRank/connectedComponent/peerPressure) on the REAL runtime. Their
 * `(id → value)` vector is SQL-RESIDENT — computed into the `barrier_state` scratch table and read
 * back by the decorate tail — so this is the ONLY place that new SQL is exercised on real **DO SQLite**:
 * `WITHOUT ROWID` + `INSERT … RETURNING` (the run-token allocation), `WITH … INSERT` per round, a
 * `ROW_NUMBER()` window (peerPressure), `IS NOT` convergence, and the post-frame GC `DELETE`. The
 * Program/clone lesson (federation above) is that a DO-only SQL fault is invisible on Bun and surfaces
 * only on workerd — so a decorate barrier that ran only in the unit tests would be unverified here.
 * Runs on Bun too, proving parity.
 */
function olapContract(getOrigin: () => string) {
  const PR_KEY = 'gremlin.pageRankVertexProgram.pageRank';
  const CC_KEY = 'gremlin.connectedComponentVertexProgram.component';
  const PP_KEY = 'gremlin.peerPressureVertexProgram.cluster';
  describe('olap (decorate barriers — barrier_state SQL on the real store)', () => {
    const graphUrl = (id: string) => `${getOrigin()}/gremlin/${id}`;

    test('pageRank/connectedComponent/peerPressure decorate the live stream and reclaim their scratch', async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const conn = new DriverRemoteConnection(graphUrl(`olap-${stamp}`));
      const g = traversal().with_(conn);
      try {
        // marko→josh (knows), marko→lop, josh→lop (created). lop is a SINK (out-degree 0) — its rank
        // accrues from both and is redistributed via the teleport energy, so it ranks highest.
        await g.addV('person').property('name', 'marko').as('m')
          .addV('person').property('name', 'josh').as('j')
          .addV('software').property('name', 'lop').as('l')
          .addE('knows').from_('m').to('j')
          .addE('created').from_('m').to('l')
          .addE('created').from_('j').to('l')
          .iterate();

        // Every vertex is decorated → element-preserving count. Proves each barrier's per-round SQL
        // (seed, relaxation, convergence) and the alloc/GC lifecycle run end to end on this store.
        expect((await g.V().pageRank().has(PR_KEY).count().next()).value).toBe(3);
        expect((await g.V().connectedComponent().has(CC_KEY).count().next()).value).toBe(3);
        expect((await g.V().peerPressure().has(PP_KEY).count().next()).value).toBe(3);

        // The decorated REAL score reads back positive, and the sink ranks first.
        const ranks = await g.V().pageRank().values(PR_KEY).toList();
        expect(ranks.length).toBe(3);
        expect(ranks.every((r) => typeof r === 'number' && r > 0)).toBe(true);
        expect((await g.V().pageRank().order().by(PR_KEY, gremlin.process.order.desc).by('name').values('name').next()).value)
          .toBe('lop');

        // Undirected connectivity: all three vertices share ONE component id.
        const comps = await g.V().connectedComponent().project('name', CC_KEY).by('name').by(CC_KEY).toList();
        expect(new Set(comps.map((m: any) => String(m.get(CC_KEY)))).size).toBe(1);

        // hits — the MULTI-CHANNEL decorate barrier (hub=channel 0, auth=channel 1). Proves the
        // two-channel barrier_state read AND the in-place UPDATE normalisation run on the real DO store.
        // lop is the strongest authority (in-edges from marko+josh); marko the strongest hub (out only).
        expect((await g.V().call('hits').has('hub').has('auth').count().next()).value).toBe(3);
        const topAuth = await g.V().call('hits').order().by('auth', gremlin.process.order.desc).limit(1).values('name').next();
        expect(topAuth.value).toBe('lop');
        const topHub = await g.V().call('hits').order().by('hub', gremlin.process.order.desc).limit(1).values('name').next();
        expect(topHub.value).toBe('marko');

        // closeness — a SCOPE-keyed barrier (reuses relaxShortestPath's per-source distances).
        // IN direction: lop & josh are reached (closeness 1 each), marko is a pure source (0). Proves the
        // all-source relaxation + the per-scope aggregation write (scope 0) run on the real DO store.
        expect((await g.V().call('closeness').has('closeness').count().next()).value).toBe(3);
        const closeness = await g.V().call('closeness').values('closeness').toList() as number[];
        expect(closeness.reduce((a, b) => a + b, 0)).toBeCloseTo(2.0, 10);

        // betweenness (Brandes) — the MULTI-SOURCE + KEEP-ALL-ROUNDS barrier. Proves the forward
        // level-BFS, the reverse dependency pass and the per-source aggregation all run on the real DO.
        // On this graph every shortest path is a direct edge, so all betweenness is 0 — but all three
        // vertices are decorated, which exercises the full compute end to end.
        expect((await g.V().call('betweenness').has('betweenness').count().next()).value).toBe(3);

        // nodeSimilarity — the PAIR-OUTPUT barrier (a stream of {node1,node2,similarity} maps, a
        // new output shape). Out-neighbours: marko→{josh,lop}, josh→{lop}; Jaccard(marko,josh)=1/2, both
        // directions → 2 pairs. Proves the pair compute + map framing run on the real DO.
        const sims = await g.call('nodeSimilarity').toList();
        expect(sims.length).toBe(2);
        for (const m of sims as Map<string, unknown>[]) expect(m.get('similarity')).toBeCloseTo(0.5, 10);

        // scc — DIRECTED strongly connected components (one-shot mutual-reachability CTE). This
        // graph is a DAG (marko→josh→lop, marko→lop; no back edges), so every vertex is its OWN SCC —
        // 3 distinct component ids, the exact opposite of connectedComponent's single undirected one.
        // Proves the recursive closure + the decorate read run on the real DO store.
        expect((await g.V().call('scc').has('componentId').count().next()).value).toBe(3);
        const scc = await g.V().call('scc').values('componentId').toList();
        expect(new Set(scc.map((c) => String(c))).size).toBe(3);

        // articleRank — the SECOND multi-channel barrier (rank=channel 0, delta=channel 1). lop is
        // the only sink (fed by marko+josh), so it ranks highest; every vertex is decorated with a positive
        // rank. Proves the two-channel delta-accumulation loop runs end to end on the real DO store.
        expect((await g.V().call('articleRank').has('articleRank').count().next()).value).toBe(3);
        const arRanks = await g.V().call('articleRank').values('articleRank').toList() as number[];
        expect(arRanks.every((r) => typeof r === 'number' && r > 0)).toBe(true);
        expect((await g.V().call('articleRank').order().by('articleRank', gremlin.process.order.desc).by('name').values('name').next()).value)
          .toBe('lop');
      } finally { await conn.close(); }
    }, 40_000);
  });
}

/**
 * Cross-graph `federate()` on the REAL runtime — the ONLY place edge-compilation's Worker-driven
 * federation (Phase 2b) is proven end to end. On Cloudflare this exercises the whole seam across TWO
 * real Durable Objects: the Worker compiles the federate to a segment, DRIVES the loop itself, reads
 * the head via the `readHead` RPC (mid form), runs `apply` on the Worker (hopping to the sibling DO via
 * `raw`), and frames the resumed plan via `runFramed`. The Program refactor proved a clone/RPC fault is
 * invisible on Bun and only surfaces on workerd, so a `readHead`/`BarrierInput[]` or foreign-row-bind
 * fault would surface HERE and nowhere in the unit tests. Runs on Bun too (in-process), proving parity.
 */
function federationContract(getOrigin: () => string) {
  describe('federation', () => {
    const graphUrl = (id: string) => `${getOrigin()}/gremlin/${id}`;

    test('source-form federate hops to a sibling graph and returns its vertices (Worker-driven on CF)', async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const crewId = `fed-${stamp}-crew`;
      const home = new DriverRemoteConnection(graphUrl(`fed-${stamp}-home`));
      const crew = new DriverRemoteConnection(graphUrl(crewId));
      const gh = traversal().with_(home), gc = traversal().with_(crew);
      try {
        await gc.addV('person').property('name', 'zeta').iterate();
        await gc.addV('person').property('name', 'theta').iterate();
        // home is empty of persons; the names below can only have come from the crew sibling.
        const fed = (await gh.call('federate')
          .with_('graph', crewId).with_('traversal', __.V().hasLabel('person'))
          .values('name').toList()).sort();
        expect(fed).toEqual(['theta', 'zeta']);
      } finally { await home.close(); await crew.close(); }
    }, 40_000);

    test('mid-traversal federate reads its head via RPC and rejoins (exercises readHead on CF)', async () => {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const crewId = `fed-${stamp}-crew`;
      const home = new DriverRemoteConnection(graphUrl(`fed-${stamp}-home`));
      const crew = new DriverRemoteConnection(graphUrl(crewId));
      const gh = traversal().with_(home), gc = traversal().with_(crew);
      try {
        await gh.addV('person').property('name', 'marko').iterate();   // shared name
        await gh.addV('person').property('name', 'onlyhome').iterate();
        await gc.addV('person').property('name', 'marko').iterate();   // shared name
        await gc.addV('person').property('name', 'onlycrew').iterate();
        // For each home person, hop to crew matching on the injected name; only "marko" is shared.
        // The injection is a value aliased before the federate barrier and read across it — pure
        // standard Gremlin (`as('e')` … `select('e')`), expressible by the STOCK GLV, no client change.
        const fed = await gh.V().hasLabel('person').values('name').as('e')
          .call('federate', { graph: crewId, traversal: __.V().has('name', __.select('e')) })
          .values('name').toList();
        expect(fed).toEqual(['marko']);
      } finally { await home.close(); await crew.close(); }
    }, 40_000);
  });
}

// The self-describing docs surface: an OpenAPI spec + an interactive Scalar
// reference, served identically on both runtimes.
function docsContract(getOrigin: () => string) {
  describe('docs', () => {
    test('GET /openapi.json serves a valid OpenAPI spec', async () => {
      const res = await fetch(`${getOrigin()}/openapi.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const spec = (await res.json()) as any;
      expect(spec.openapi).toMatch(/^3\./);
      expect(Object.keys(spec.paths['/gremlin/{graphId}'])).toEqual(
        expect.arrayContaining(['post', 'put', 'get', 'delete']),
      );
    });

    test('GET /docs serves the Scalar reference HTML', async () => {
      const res = await fetch(`${getOrigin()}/docs`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('createApiReference');
      expect(html).toContain('/openapi.json');
    });

    test('GET / redirects to the docs', async () => {
      const res = await fetch(`${getOrigin()}/`);
      expect(res.redirected).toBe(true);
      expect(new URL(res.url).pathname).toBe('/docs');
      expect(await res.text()).toContain('createApiReference');
    });
  });
}

// The gremlin data plane: seed a graph over the wire, then read it back.
function gremlinContract(getOrigin: () => string) {
  describe('gremlin', () => {
    let drc: any, g: any, dan: any, ada: any, zig: any;

    beforeAll(async () => {
      // A fresh graph id per run keeps the seed isolated from other graphs.
      drc = new DriverRemoteConnection(`${getOrigin()}/gremlin/gremlin-${Date.now()}`);
      g = traversal().with_(drc);

      // inserts through the wire
      dan = (await g.addV('person').property('name', 'dan').property('age', 44).next()).value;
      ada = (await g.addV('person').property('name', 'ada').property('age', 36).next()).value;
      zig = (await g.addV('language').property('name', 'zig').next()).value;
      await g.V(dan.id).addE('knows').to(__.V(ada.id)).iterate();
      await g.V(dan.id).addE('likes').to(__.V(zig.id)).iterate();
      await g.V(ada.id).addE('likes').to(__.V(zig.id)).iterate();
    }, 60_000);

    afterAll(async () => {
      await drc?.close();
    });

    test('inserts return materialized vertices', () => {
      expect(dan.constructor.name).toBe('Vertex');
      expect(typeof dan.id).toBe('number');
    });

    test('count vertices', async () => {
      expect((await g.V().count().next()).value).toBe(3);
    });

    test('hasLabel + values', async () => {
      // bare values() has no guaranteed order (TinkerPop); compare as a set
      expect((await g.V().hasLabel('person').values('name').toList()).sort()).toEqual(['ada', 'dan']);
    });

    test('has eq', async () => {
      expect(await g.V().has('name', 'dan').values('age').toList()).toEqual([44]);
    });

    test('P.gt', async () => {
      expect(await g.V().has('age', P.gt(40)).values('name').toList()).toEqual(['dan']);
    });

    test('out(knows)', async () => {
      expect(await g.V(dan.id).out('knows').values('name').toList()).toEqual(['ada']);
    });

    test('in(likes)', async () => {
      // bare values() has no guaranteed order (TinkerPop); compare as a set
      expect((await g.V(zig.id).in_('likes').values('name').toList()).sort()).toEqual(['ada', 'dan']);
    });

    test('both + dedup', async () => {
      expect((await g.V(zig.id).both().dedup().count().next()).value).toBe(2);
    });

    test('two hops', async () => {
      expect(await g.V().has('name', 'dan').out('knows').out('likes').values('name').toList()).toEqual(['zig']);
    });

    test('label()', async () => {
      expect(await g.V(zig.id).label().toList()).toEqual(['language']);
    });

    test('limit', async () => {
      expect((await g.V().limit(2).count().next()).value).toBe(2);
    });

    test('chunked streaming round-trips: raw JSON-in, batchSize-paced GraphBinary out', async () => {
      // Exercise the streaming path over real HTTP on this runtime: a raw POST (JSON
      // request body, GraphBinary response) with a tiny batchSize so the response is
      // emitted as a multi-chunk ReadableStream, then reassembled and decoded. Proves
      // the streamed frame stays byte-correct across the wire and that batchSize is
      // accepted end-to-end. (Whether the HTTP layer advertises Content-Length vs
      // chunked transfer is runtime-dependent — Bun buffers small stream bodies — so
      // the deterministic chunk-pacing proof lives in test/streaming.test.ts instead.)
      const { ioc } = await import('../src/io.ts');
      const res = await fetch(`${getOrigin()}/gremlin/stream-${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gremlin: 'g.inject(1,2,3,4,5)', batchSize: 2 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.graphbinary-v4.0');
      const parsed = await ioc.graphBinaryReader.readResponse(Buffer.from(await res.arrayBuffer()));
      expect(parsed.status.code).toBe(200);
      expect(parsed.result.data.map((x: any) => Number(x))).toEqual([1, 2, 3, 4, 5]);
    });

    test('vertex round-trips id, label, and materialized properties', async () => {
      const v = (await g.V().has('name', 'ada').next()).value;
      expect(v.id).toBe(ada.id);
      expect(v.label).toBe('person');
      // Custom vertex framing (P1) materializes properties over the wire.
      const props = Object.fromEntries((v.properties ?? []).map((p: any) => [p.key, p.value]));
      expect(props).toEqual({ name: 'ada', age: 36 });
    });

    test('valueMap(keys) returns list-valued map', async () => {
      const m = (await g.V().has('name', 'dan').valueMap('name', 'age').next()).value;
      expect(m.get('name')).toEqual(['dan']);
      expect(m.get('age')).toEqual([44]);
    });

    test('elementMap returns flat scalar map with id/label tokens', async () => {
      const m = (await g.V().has('name', 'dan').elementMap().next()).value;
      expect(m.get('name')).toBe('dan');
      expect(m.get('age')).toBe(44);
      // id/label ride as T tokens; find them by their string element name.
      const byToken = (name: string) =>
        [...m.entries()].find(([k]: any) => k?.elementName === name)?.[1];
      expect(byToken('id')).toBe(dan.id);
      expect(byToken('label')).toBe('person');
    });

    test('order().by(key) then values', async () => {
      expect(await g.V().hasLabel('person').order().by('age').values('name').toList())
        .toEqual(['ada', 'dan']); // 36 < 44
    });

    test('order().by(key, desc)', async () => {
      expect(await g.V().hasLabel('person').order().by('age', gremlin.process.order.desc).values('name').toList())
        .toEqual(['dan', 'ada']);
    });

    test('values().order() sorts scalars ascending', async () => {
      expect(await g.V().hasLabel('person').values('age').order().toList()).toEqual([36, 44]);
    });

    test('order + range window', async () => {
      expect(await g.V().hasLabel('person').order().by('age').range(0, 1).values('name').toList())
        .toEqual(['ada']);
    });

    test('order + skip', async () => {
      expect(await g.V().hasLabel('person').order().by('age').skip(1).values('name').toList())
        .toEqual(['dan']);
    });

    test('inject seeds a constant value stream', async () => {
      expect(await g.inject(1, 2, 3).toList()).toEqual([1, 2, 3]);
    });

    test('drop removes a vertex and its incident edges', async () => {
      const doomed = (await g.addV('temp').property('name', 'doomed').next()).value;
      await g.V(dan.id).addE('knows').to(__.V(doomed.id)).iterate();
      await g.V(doomed.id).drop().iterate();
      expect((await g.V().has('name', 'doomed').count().next()).value).toBe(0);
      // incident edge is gone: dan still only knows ada
      expect(await g.V(dan.id).out('knows').values('name').toList()).toEqual(['ada']);
    });

    test('edge drop removes only the matched edge, keeping its endpoints', async () => {
      // dan -likes-> zig (seeded). Drop just that edge via an edge-typed traversal.
      await g.V(dan.id).outE('likes').drop().iterate();
      expect(await g.V(dan.id).out('likes').toList()).toEqual([]);
      // dan's other edge and both endpoints survive.
      expect(await g.V(dan.id).out('knows').values('name').toList()).toEqual(['ada']);
      expect((await g.V(dan.id).values('name').next()).value).toBe('dan');
      expect((await g.V(zig.id).values('name').next()).value).toBe('zig');
    });

    // Cross-runtime bind coercion: bun:sqlite accepts boolean binds, DO's
    // ctx.storage.sql rejects them. Added last so the extra vertex doesn't
    // perturb the count/limit assertions above.
    test('boolean predicate works on both runtimes', async () => {
      const t = (await g.addV('thing').property('name', 'flag').property('active', true).next()).value;
      expect(await g.V().has('active', true).id().toList()).toEqual([t.id]);
      expect(await g.V().has('active', false).id().toList()).toEqual([]);
    });

    test('unsupported step rejected server-side', async () => {
      expect(g.V().sack().toList()).rejects.toThrow();
    });
  });
}

// The management API: whole-graph lifecycle over plain HTTP verbs. Idempotent and
// create-on-demand on BOTH runtimes — matching Cloudflare's provisioning (a DO
// springs into being on first access; the namespace can't report "not found"),
// which the Bun registry mirrors so the local, dependency-free server has
// identical semantics.
/**
 * `io()` on the REAL runtime, which is the only place the second storage seam is proven.
 *
 * Both halves of `IoStore` are exercised here and nowhere else: on Bun a rooted `FileIoStore`
 * (`$MOGWAI_IO_DIR`), inside a Durable Object an **R2 bucket binding** — the thing
 * `outstanding-work.md` used to call impossible ("`io().write()` needs a filesystem a DO does not
 * have"). Neither is reachable from a unit test: R2 exists only under workerd, and the DO reads the
 * binding off its own env. So this test is what says the CF write side runs at all, rather than
 * merely type-checking.
 *
 * Both formats, because they have different shapes: GraphSON is one document, CSV is two.
 */
function ioContract(getOrigin: () => string) {
  describe('io', () => {
    const graphUrl = (id: string) => `${getOrigin()}/gremlin/${id}`;
    const counts = async (id: string) => (await (await fetch(graphUrl(id))).json()) as any;

    test('a graph dumps itself out and reads back into another — GraphSON and CSV', async () => {
      // One prefix per run: the io namespace is per-DEPLOYMENT (one bucket / one directory), not per
      // graph, and `wrangler dev` persists its local bucket across runs.
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const conns = new Map<string, InstanceType<typeof DriverRemoteConnection>>();
      const g = (id: string) => {
        if (!conns.has(id)) conns.set(id, new DriverRemoteConnection(graphUrl(`io-${stamp}-${id}`)));
        return traversal().with_(conns.get(id)!);
      };
      try {
        await g('src').addV('person').property('name', 'marko').property('age', 29).iterate();
        await g('src').addV('person').property('name', 'vadas').property('age', 27).iterate();
        // A nested `to()` rather than a mid-chain `V()` re-source: the edge is the same, and the
        // re-source is a separate gap (tracked in rel-spine's DECLINED list) that this test is not
        // about — its subject is the io round trip.
        await g('src').V().has('name', 'marko').as('a')
          .addE('knows').to(__.V().has('name', 'vadas')).from_('a').property('weight', 0.5).iterate();

        await g('src').io(`${stamp}/dump.json`).write().iterate();
        await g('json').io(`${stamp}/dump.json`).read().iterate();
        expect(await counts(`io-${stamp}-json`)).toMatchObject({ vertexCount: 2, edgeCount: 1 });

        // CSV writes TWO documents at derived keys; each is an ordinary readable path, vertices first.
        await g('src').io(`${stamp}/dump.csv`).write().iterate();
        await g('csv').io(`${stamp}/dump-vertices.csv`).read().iterate();
        await g('csv').io(`${stamp}/dump-edges.csv`).read().iterate();
        expect(await counts(`io-${stamp}-csv`)).toMatchObject({ vertexCount: 2, edgeCount: 1 });

        // Not vacuous about WHAT came back: the typed property survives both formats.
        expect(await g('json').V().has('name', 'marko').values('age').toList()).toEqual([29]);
        expect(await g('csv').V().has('name', 'marko').values('age').toList()).toEqual([29]);
      } finally {
        for (const c of conns.values()) await c.close();
      }
    }, 40_000);
  });
}

function managementContract(getOrigin: () => string) {
  describe('management', () => {
    const graphUrl = (id: string) => `${getOrigin()}/gremlin/${id}`;
    // Unique id per test so runs don't collide (wrangler dev persists to disk).
    const freshId = (tag: string) => `mgmt-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    test('PUT creates a graph (201)', async () => {
      const res = await fetch(graphUrl(freshId('put')), { method: 'PUT' });
      expect(res.status).toBe(201);
    });

    test('GET returns element counts, auto-creating an empty graph', async () => {
      const res = await fetch(graphUrl(freshId('get')));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ vertexCount: 0, edgeCount: 0 });
    });

    test('full lifecycle: write, count, destroy, recreated empty', async () => {
      const id = freshId('life');
      const drc = new DriverRemoteConnection(graphUrl(id));
      const g = traversal().with_(drc);
      try {
        await g.addV('person').property('name', 'x').iterate();
        await g.addV('person').property('name', 'y').iterate();

        const before = (await (await fetch(graphUrl(id))).json()) as any;
        expect(before.vertexCount).toBe(2);

        const del = await fetch(graphUrl(id), { method: 'DELETE' });
        expect(del.status).toBe(204);

        // Re-addressing recreates the graph empty (CF provisioning; Bun mirrors).
        const after = (await (await fetch(graphUrl(id))).json()) as any;
        expect(after.vertexCount).toBe(0);
      } finally {
        await drc.close();
      }
    }, 30_000);

    test('DELETE is idempotent (delete twice is fine)', async () => {
      const id = freshId('idem');
      expect((await fetch(graphUrl(id), { method: 'DELETE' })).status).toBe(204);
      expect((await fetch(graphUrl(id), { method: 'DELETE' })).status).toBe(204);
    });

    test('malformed path 404s', async () => {
      expect((await fetch(`${getOrigin()}/nope`)).status).toBe(404);
    });

    test('unsupported method 405s', async () => {
      expect((await fetch(graphUrl(freshId('method')), { method: 'PATCH' })).status).toBe(405);
    });
  });
}
