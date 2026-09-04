// The replication control plane in a REAL browser (Phase 5c-browser): the Service Worker edge intercepting
// `/_replicator` + `/_scheduler`, brokering CRUD to the SINGLETON registry Worker (its own opfs-sahpool DB),
// and running the worker-residency scheduler at the edge over the graph Workers. This is where the browser's
// persistent registry + scheduler are proven end to end over the real opfs-sahpool VFS.
import '../../../src/browser/buffer-global.ts'; // first — Buffer for the wire layer
import { installMogwai } from '../../../src/browser/worker-factory.ts';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

async function main() {
  await installMogwai(); // register SW + factory; ./service-worker.js, ./worker.js, ./registry-worker.js beside this page

  const O = location.origin;
  const ts = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const jsonReq = (path: string, method: string, body?: unknown) =>
    fetch(`${O}${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const gremlin = (g: string, text: string) =>
    fetch(`${O}/gremlin/${g}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gremlin: text, batchSize: 10_000 }) });
  const vertexCount = async (g: string): Promise<number> => ((await (await fetch(`${O}/gremlin/${g}`)).json()) as any).vertexCount;

  await check('registry CRUD round-trips through the SW to the persistent registry Worker', async () => {
    const id = `rjob-crud-${ts}`;
    const put = await jsonReq(`/_replicator/${id}`, 'PUT', { source: 'a', target: 'b', continuous: true });
    if (put.status !== 201) throw new Error(`PUT ${put.status}`);
    const got = (await (await jsonReq(`/_replicator/${id}`, 'GET')).json()) as any;
    if (got.id !== id || got.continuous !== true) throw new Error(`GET ${JSON.stringify(got)}`);
    const list = (await (await jsonReq('/_replicator', 'GET')).json()) as any;
    if (!list.configs.some((c: any) => c.id === id)) throw new Error('not listed');
    if ((await jsonReq(`/_replicator/${id}`, 'DELETE')).status !== 204) throw new Error('DELETE not 204');
    if ((await jsonReq(`/_replicator/${id}`, 'GET')).status !== 404) throw new Error('GET after delete not 404');
  });

  await check('POST /_scheduler/run replicates a local→local job at the SW edge', async () => {
    const src = `rsrc-${ts}`;
    const dst = `rdst-${ts}`;
    await gremlin(src, "g.addV('person').property('name','marko').addV('person').property('name','vadas')");
    await jsonReq(`/_replicator/rjob-${ts}`, 'PUT', { source: src, target: dst, continuous: false });
    const tick = (await (await jsonReq('/_scheduler/run', 'POST')).json()) as any;
    if (!(tick.ran >= 1)) throw new Error(`ran = ${tick.ran}`);
    const n = await vertexCount(dst);
    if (n !== 2) throw new Error(`dst vertexCount = ${n}`);
  });

  await check('_scheduler/docs shows the job with its state', async () => {
    const docs = (await (await jsonReq('/_scheduler/docs', 'GET')).json()) as any;
    const doc = docs.docs.find((d: any) => d.id === `rjob-${ts}`);
    if (!doc) throw new Error('job not in _scheduler/docs');
    if (!doc.job || doc.job.state !== 'completed') throw new Error(`state = ${JSON.stringify(doc.job)}`);
  });

  (window as any).__result = { results };
  (window as any).__done = true;
}

main().catch((e: any) => {
  (window as any).__result = { results, fatal: String(e?.stack || e) };
  (window as any).__done = true;
});
