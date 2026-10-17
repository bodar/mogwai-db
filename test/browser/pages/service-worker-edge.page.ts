// The capstone page: the FULL single-tab browser stack, driven by a real client's `fetch`. This page is
// just the WorkerFactory — it spawns/owns the graph Workers on the Service Worker's behalf. The SW is the
// edge (runs makeRouter, holds a DIRECT stub to each graph's Worker); it intercepts the page's own
// `fetch('/gremlin/*')` and answers it itself. So a client — a plain fetch AND the UNMODIFIED TinkerPop
// GLV — reaches the local opfs-sahpool graph with no monkey-patching, proving the port's headline thesis
// end to end in a real browser.
import '../../../src/browser/buffer-global.ts'; // first — Buffer for the response decode
import { installMogwai } from '../../../src/browser/worker-factory.ts';
import { ioc } from '../../../src/io.ts';
import gremlin from 'gremlin';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

async function main() {
  // The whole production bootstrap: register the SW + install the factory, resolving ./service-worker.js
  // and ./worker.js relative to this page (import.meta.url) — the real relative-resolution path.
  await installMogwai();

  const G = `swg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const gremlinUrl = `${location.origin}/gremlin/${G}`;
  const postJson = (gremlinText: string) =>
    // Explicit GraphBinary Accept — `readCount` decodes the binary response, and JSON is now the edge
    // default (a missing Accept would return GraphSON JSON, unparseable by the GraphBinary reader).
    fetch(gremlinUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.graphbinary-v4.0' }, body: JSON.stringify({ gremlin: gremlinText, batchSize: 10_000 }) });
  const readCount = async (gremlinText: string): Promise<number> => {
    const bytes = Buffer.from(await (await postJson(gremlinText)).arrayBuffer());
    const data = (await ioc.graphBinaryReader.readResponse(bytes)).result.data;
    return Number(data[0]);
  };

  await check('a plain fetch is intercepted by the Service Worker and reaches the store', async () => {
    await postJson("g.addV('person').property('name','marko').property('age',29)");
    await postJson("g.addV('person').property('name','vadas').property('age',27)");
    const n = await readCount('g.V().count()');
    if (n !== 2) throw new Error(`count = ${n}`);
  });

  await check('the Service Worker routes a management OPTIONS (JSON) to the manager', async () => {
    const j = await (await fetch(gremlinUrl, { method: 'OPTIONS' })).json() as any;
    if (j.vertexCount !== 2) throw new Error(JSON.stringify(j));
  });

  await check('the UNMODIFIED TinkerPop GLV works over the Service Worker edge (fetch)', async () => {
    const { DriverRemoteConnection } = gremlin.driver;
    const { traversal } = gremlin.process.AnonymousTraversalSource;
    const conn = new DriverRemoteConnection(gremlinUrl);
    const g = traversal().with_(conn);
    try {
      const c = (await g.V().count().next()).value;
      if (Number(c) !== 2) throw new Error(`glv count = ${c}`);
      const names = (await g.V().hasLabel('person').values('name').toList()).map(String).sort();
      if (JSON.stringify(names) !== JSON.stringify(['marko', 'vadas'])) throw new Error(`glv names = ${JSON.stringify(names)}`);
      const olderName = (await g.V().has('age', gremlin.process.P.gt(28)).values('name').next()).value;
      if (olderName !== 'marko') throw new Error(`glv gt = ${olderName}`);
    } finally {
      await conn.close();
    }
  });

  // The WorkerFactory's destroy path (SW edge → factory.destroyGraph → closeGraphWorker → removeOpfsDir),
  // repeated: removing the graph's OPFS directory while its Worker still held the opfs-sahpool access
  // handles failed with NoModificationAllowedError — and the SW used to swallow that and answer 204 over
  // data that was still there.
  await check('destroy over the Service Worker edge wipes the graph; re-address recreates it empty (×5)', async () => {
    for (let i = 0; i < 5; i++) {
      const url = `${location.origin}/gremlin/${G}-cycle-${i}`;
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gremlin: "g.addV('person')" }) });
      const del = await fetch(url, { method: 'DELETE' });
      if (del.status !== 204) throw new Error(`cycle ${i}: delete status ${del.status}: ${await del.text()}`);
      const j = await (await fetch(url, { method: 'OPTIONS' })).json() as any;
      if (j.vertexCount !== 0) throw new Error(`cycle ${i}: after destroy = ${JSON.stringify(j)}`);
    }
  });

  // Destroy a BUSY graph over the edge: a runaway query (a cyclic repeat() with no times(), infinite per
  // the spec) occupies the graph Worker's one thread, so it never answers a close request. The factory's
  // teardown must still finish — bounded, by terminating the Worker — remove the store and release the
  // graph's Web Lock (a re-address below needs it), and the cut-off query must fail, never be answered.
  await check('destroy over the Service Worker edge during a runaway query is bounded and fails the query', async () => {
    const url = `${location.origin}/gremlin/${G}-runaway`;
    const send = (gremlinText: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.graphbinary-v4.0' }, body: JSON.stringify({ gremlin: gremlinText }) });
    await send("g.addV('person').as('a').addE('self').to('a')");
    const runaway = send('g.V().repeat(both()).emit().count()').then(
      async (res) => {
        const r = await ioc.graphBinaryReader.readResponse(Buffer.from(await res.arrayBuffer())).catch((e: unknown) => ({ status: { code: -1, message: String(e) }, result: { data: [] } }));
        return { http: res.status, code: r.status?.code, message: String(r.status?.message ?? ''), data: r.result?.data };
      },
      (e: unknown) => ({ http: -1, code: -1, message: String(e), data: undefined }),
    );
    await new Promise((r) => setTimeout(r, 500)); // let the Worker get stuck in the query
    const within = <T,>(p: Promise<T>, ms: number, what: string) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} still pending after ${ms}ms`)), ms))]);
    const del = await within(fetch(url, { method: 'DELETE' }), 25_000, 'DELETE');
    if (del.status !== 204) throw new Error(`delete status ${del.status}: ${await del.text()}`);
    const out = await within(runaway, 5_000, 'the cut-off query');
    const failed = out.http >= 400 || (out.code !== undefined && out.code !== 200 && out.code !== 204);
    if (!failed || !/destroyed/.test(out.message)) throw new Error(`cut-off query did not fail as destroyed: ${JSON.stringify(out)}`);
    const j = await within((async () => (await fetch(url, { method: 'OPTIONS' })).json() as Promise<any>)(), 15_000, 're-address');
    if (j.vertexCount !== 0) throw new Error(`after destroy = ${JSON.stringify(j)}`);
  });

  (window as any).__result = { results };
  (window as any).__done = true;
}

main().catch((e: any) => {
  (window as any).__result = { results, fatal: String(e?.stack || e) };
  (window as any).__done = true;
});
