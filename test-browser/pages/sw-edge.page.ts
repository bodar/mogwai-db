// The capstone page: the FULL single-tab browser stack, driven by a real client's `fetch`. This page
// hosts the coordinator + graph Workers and installs the page edge; the Service Worker intercepts the
// page's own `fetch('/gremlin/*')` and brokers it back here. So a client — a plain fetch AND the
// UNMODIFIED TinkerPop GLV — reaches the local opfs-sahpool graph with no monkey-patching, proving the
// port's headline thesis end to end in a real browser.
import '../../src/browser/buffer-global.ts'; // first — Buffer for the response framing/decode
import { makeRouter } from '../../src/router.ts';
import { BrowserCoordinator } from '../../src/browser/coordinator.ts';
import { installMogwaiPageEdge, registerServiceWorker } from '../../src/browser/page-edge.ts';
import { ioc } from '../../src/io.ts';
import gremlin from 'gremlin';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

async function main() {
  const log = (m: string) => console.log(`main: ${m}`);
  const coordinator = new BrowserCoordinator('/graph-worker.js');
  const router = makeRouter(coordinator);
  log('registering SW');
  await registerServiceWorker('/sw.js'); // resolves once the SW controls this page
  log(`SW registered; controller=${!!navigator.serviceWorker.controller}`);
  installMogwaiPageEdge(router); // must be installed before any intercepted fetch
  log('edge installed');

  const G = `swg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const gremlinUrl = `${location.origin}/gremlin/${G}`;
  const postJson = (gremlinText: string) =>
    fetch(gremlinUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gremlin: gremlinText, batchSize: 10_000 }) });
  const readCount = async (gremlinText: string): Promise<number> => {
    const bytes = Buffer.from(await (await postJson(gremlinText)).arrayBuffer());
    const data = (await ioc.graphBinaryReader.readResponse(bytes)).result.data;
    return Number(data[0]);
  };

  await check('a plain fetch is intercepted by the SW and reaches the store', async () => {
    log('check1: first postJson');
    await postJson("g.addV('person').property('name','marko').property('age',29)");
    log('check1: first postJson done');
    await postJson("g.addV('person').property('name','vadas').property('age',27)");
    log('check1: reading count');
    const n = await readCount('g.V().count()');
    log(`check1: count=${n}`);
    if (n !== 2) throw new Error(`count = ${n}`);
  });

  await check('the SW routes a management GET (JSON) to the coordinator', async () => {
    const j = await (await fetch(gremlinUrl)).json() as any;
    if (j.vertexCount !== 2) throw new Error(JSON.stringify(j));
  });

  await check('the UNMODIFIED TinkerPop GLV works over the SW edge (fetch)', async () => {
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

  (window as any).__result = { results };
  (window as any).__done = true;
}

main().catch((e: any) => {
  (window as any).__result = { results, fatal: String(e?.stack || e) };
  (window as any).__done = true;
});
