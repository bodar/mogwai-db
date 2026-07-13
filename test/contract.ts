import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const P = gremlin.process.P;

/** A runtime under test: start it, get its ORIGIN (base URL, no graph path), stop
 *  it. Graphs are addressed under `{origin}/g/{id}` identically on both runtimes,
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
      expect(Object.keys(spec.paths['/g/{graphId}'])).toEqual(
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
      drc = new DriverRemoteConnection(`${getOrigin()}/g/gremlin-${Date.now()}`);
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
      expect((await g.V().count().next()).value).toBe(3n);
    });

    test('hasLabel + values', async () => {
      expect(await g.V().hasLabel('person').values('name').toList()).toEqual(['dan', 'ada']);
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
      expect(await g.V(zig.id).in_('likes').values('name').toList()).toEqual(['dan', 'ada']);
    });

    test('both + dedup', async () => {
      expect((await g.V(zig.id).both().dedup().count().next()).value).toBe(2n);
    });

    test('two hops', async () => {
      expect(await g.V().has('name', 'dan').out('knows').out('likes').values('name').toList()).toEqual(['zig']);
    });

    test('label()', async () => {
      expect(await g.V(zig.id).label().toList()).toEqual(['language']);
    });

    test('limit', async () => {
      expect((await g.V().limit(2).count().next()).value).toBe(2n);
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
      expect((await g.V().has('name', 'doomed').count().next()).value).toBe(0n);
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
function managementContract(getOrigin: () => string) {
  describe('management', () => {
    const graphUrl = (id: string) => `${getOrigin()}/g/${id}`;
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
