// Drives the page-side edge in a browser: makeRouter over a BrowserCoordinator, exercised with raw
// fetch-shaped Requests (the Service Worker that will intercept real client fetches is 4c; here the router is called
// directly). Proves the full page path — router → coordinator → per-graph dedicated Worker →
// opfs-sahpool — plus multi-graph routing (one Worker per graph) and the management verbs, all in a real
// browser. A dedicated Worker may spawn nested Workers, so this driver worker stands in for the page.
import '../../src/browser/buffer-global.ts'; // first — Buffer for the response framing/decode
import { makeRouter } from '../../src/router.ts';
import { BrowserCoordinator } from '../../src/browser/coordinator.ts';
import { ioc } from '../../src/io.ts';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

self.onmessage = async () => {
  try {
    const coordinator = new BrowserCoordinator('/graph-worker.js');
    const router = makeRouter(coordinator);
    const post = (graphId: string, gremlin: string) =>
      router(new Request(`http://x/gremlin/${graphId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gremlin, batchSize: 10_000 }),
      }));
    const read = async (graphId: string, gremlin: string): Promise<any[]> => {
      const bytes = Buffer.from(await (await post(graphId, gremlin)).arrayBuffer());
      return (await ioc.graphBinaryReader.readResponse(bytes)).result.data;
    };
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const A = `coord-a-${stamp}`, B = `coord-b-${stamp}`;

    await post(A, "g.addV('person').property('name','marko')");
    await post(A, "g.addV('person').property('name','vadas')");
    await post(B, "g.addV('language').property('name','zig')");

    await check('router → coordinator → worker: count on graph A', async () => {
      const d = await read(A, 'g.V().count()');
      if (Number(d[0]) !== 2) throw new Error(`A count = ${d[0]}`);
    });
    await check('multi-graph isolation: B is its own Worker + store', async () => {
      const d = await read(B, 'g.V().count()');
      if (Number(d[0]) !== 1) throw new Error(`B count = ${d[0]}`);
    });
    await check('values read back through the full edge', async () => {
      const d = (await read(A, "g.V().hasLabel('person').values('name')")).map(String).sort();
      if (JSON.stringify(d) !== JSON.stringify(['marko', 'vadas'])) throw new Error(JSON.stringify(d));
    });
    await check('management GET returns counts JSON, auto-creating an empty graph', async () => {
      const j = await (await router(new Request(`http://x/gremlin/coord-fresh-${stamp}`))).json() as any;
      if (j.vertexCount !== 0 || j.edgeCount !== 0) throw new Error(JSON.stringify(j));
    });
    await check('management PUT creates (201)', async () => {
      const res = await router(new Request(`http://x/gremlin/coord-put-${stamp}`, { method: 'PUT' }));
      if (res.status !== 201) throw new Error(`status ${res.status}`);
    });
    await check('destroy wipes the store; re-address recreates it empty', async () => {
      const del = await router(new Request(`http://x/gremlin/${A}`, { method: 'DELETE' }));
      if (del.status !== 204) throw new Error(`delete status ${del.status}`);
      const j = await (await router(new Request(`http://x/gremlin/${A}`))).json() as any;
      if (j.vertexCount !== 0) throw new Error(`after destroy A = ${JSON.stringify(j)}`);
    });

    (self as any).postMessage({ results });
  } catch (e: any) {
    (self as any).postMessage({ results, fatal: String(e?.stack || e) });
  }
};
