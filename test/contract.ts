import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import gremlin from 'gremlin';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;
const __ = gremlin.process.statics;
const P = gremlin.process.P;

/** A runtime under test: start it, get a URL to connect the GLV to, stop it.
 *  `start` returns the base URL a TinkerPop 4 GLV connects to. */
export interface Harness {
  start(): Promise<string>;
  stop(): Promise<void> | void;
}

/**
 * The shared conformance contract. One set of assertions, driven through the
 * real gremlin GLV over GraphBinary — run against every runtime (Bun server,
 * Cloudflare DO) so the two are proven identical, not tested twice.
 */
export function graphContract(name: string, harness: Harness) {
  describe(name, () => {
    let drc: any, g: any, dan: any, ada: any, zig: any;

    beforeAll(async () => {
      const url = await harness.start();
      drc = new DriverRemoteConnection(url);
      g = traversal().with_(drc);

      // inserts through the wire
      dan = (await g.addV('person').property('name', 'dan').property('age', 44).next()).value;
      ada = (await g.addV('person').property('name', 'ada').property('age', 36).next()).value;
      zig = (await g.addV('language').property('name', 'zig').next()).value;
      await g.V(dan.id).addE('knows').to(__.V(ada.id)).iterate();
      await g.V(dan.id).addE('likes').to(__.V(zig.id)).iterate();
      await g.V(ada.id).addE('likes').to(__.V(zig.id)).iterate();
    }, 60_000); // generous: wrangler dev can take a while to boot

    afterAll(async () => {
      await drc?.close();
      await harness.stop();
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
