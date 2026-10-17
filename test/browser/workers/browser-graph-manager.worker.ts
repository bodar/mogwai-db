// Drives the page-side edge in a browser: makeRouter over a BrowserGraphManager, exercised with raw
// fetch-shaped Requests (the Service Worker that will intercept real client fetches is 4c; here the router is called
// directly). Proves the full page path — router → manager → per-graph dedicated Worker →
// opfs-sahpool — plus multi-graph routing (one Worker per graph) and the management verbs, all in a real
// browser. A dedicated Worker may spawn nested Workers, so this driver worker stands in for the page.
import '../../../src/browser/buffer-global.ts'; // first — Buffer for the response framing/decode
import { makeRouter } from '../../../src/router.ts';
import { BrowserGraphManager, LocalWorkerSource } from '../../../src/browser/BrowserGraphManager.ts';
import { ioc } from '../../../src/io.ts';
import { spawnGraphWorker, destroyGraphWorker } from '../../../src/browser/worker-spawn.ts';
import type { GraphWorkerHost } from '../../../src/browser/GraphWorkerHost.ts';
import { newMessagePortRpcSession } from 'capnweb';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

self.onmessage = async () => {
  try {
    const manager = new BrowserGraphManager(new LocalWorkerSource('/graph-worker.js'));
    const router = makeRouter(manager);
    const post = (graphId: string, gremlin: string) =>
      router(new Request(`http://x/gremlin/${graphId}`, {
        // Explicit GraphBinary Accept — `read` decodes the binary response, and JSON is now the router
        // default (a missing Accept would return GraphSON JSON, unparseable by the GraphBinary reader).
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.graphbinary-v4.0' },
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

    await check('router → manager → worker: count on graph A', async () => {
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
    await check('management OPTIONS returns counts JSON, auto-creating an empty graph', async () => {
      const j = await (await router(new Request(`http://x/gremlin/coord-fresh-${stamp}`, { method: 'OPTIONS' }))).json() as any;
      if (j.vertexCount !== 0 || j.edgeCount !== 0) throw new Error(JSON.stringify(j));
    });
    await check('management PUT creates (201)', async () => {
      const res = await router(new Request(`http://x/gremlin/coord-put-${stamp}`, { method: 'PUT' }));
      if (res.status !== 201) throw new Error(`status ${res.status}`);
    });
    await check('destroy wipes the store; re-address recreates it empty', async () => {
      const del = await router(new Request(`http://x/gremlin/${A}`, { method: 'DELETE' }));
      if (del.status !== 204) throw new Error(`delete status ${del.status}`);
      const j = await (await router(new Request(`http://x/gremlin/${A}`, { method: 'OPTIONS' }))).json() as any;
      if (j.vertexCount !== 0) throw new Error(`after destroy A = ${JSON.stringify(j)}`);
    });

    // The destroy RACE, amplified: a graph whose Worker is live and holding its opfs-sahpool access
    // handles is destroyed straight after a write, then re-addressed — many times over, so a destroy that
    // removes the OPFS directory before the Worker has RELEASED its handles (NoModificationAllowedError)
    // or that leaves the old rows behind cannot pass by luck of scheduling.
    await check('destroy is reliable under repetition (write → destroy → re-address, ×5)', async () => {
      for (let i = 0; i < 5; i++) {
        const G = `coord-cycle-${stamp}-${i}`;
        await post(G, "g.addV('person').property('name','x')");
        const del = await router(new Request(`http://x/gremlin/${G}`, { method: 'DELETE' }));
        if (del.status !== 204) throw new Error(`cycle ${i}: delete status ${del.status}: ${await del.text()}`);
        const j = await (await router(new Request(`http://x/gremlin/${G}`, { method: 'OPTIONS' }))).json() as any;
        if (j.vertexCount !== 0) throw new Error(`cycle ${i}: after destroy = ${JSON.stringify(j)}`);
        await manager.destroy(G);
      }
    });

    // A request for a graph issued WHILE its destroy is in flight is ordered after the destroy: it must land
    // on a fresh graph that survives — never spawn a second Worker over the directory the old one still
    // holds handles in, only for the destroy's removal to delete it underneath the new Worker.
    await check('a write issued during destroy lands on the fresh graph and survives (×3)', async () => {
      for (let i = 0; i < 3; i++) {
        const G = `coord-overlap-${stamp}-${i}`;
        await post(G, "g.addV('person').property('name','before').as('a').addE('self').to('a')");
        // Cycle 0 destroys a BUSY Worker (a runaway query), whose teardown takes the bounded-close path —
        // the widest window for a new Worker to race the old one's still-held handles.
        if (i === 0) {
          void post(G, 'g.V().repeat(both()).emit().count()').catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
        }
        // manager.destroy directly (not a DELETE through the router), so the destroy is issued FIRST — the
        // router's own awaits would leave which request reaches the manager first to scheduling.
        const del = manager.destroy(G);
        const write = post(G, "g.addV('person').property('name','after')");
        const [, w] = await Promise.all([del, write]);
        if (w.status !== 200) throw new Error(`cycle ${i}: write status ${w.status}: ${await w.text()}`);
        const names = (await read(G, 'g.V().values("name")')).map(String);
        if (JSON.stringify(names) !== JSON.stringify(['after'])) throw new Error(`cycle ${i}: after overlap = ${JSON.stringify(names)}`);
        await manager.destroy(G);
      }
    });

    // The OPEN-side twin of the destroy race: a graph's owner Worker dies WITHOUT a close (its tab was closed —
    // the cross-tab failover case — modelled here by terminate()), and a new Worker opens the same graph
    // straight away. The dead Worker's access handles are released only when its thread is torn down, with
    // no event to await, so the new pool must wait them out rather than fail its open (which would leave the
    // graph unopenable for that Worker's whole life) — and must find the committed data intact.
    await check('a graph re-opened right after its owner Worker died waits out the handles, data intact (×3)', async () => {
      for (let i = 0; i < 3; i++) {
        const T = `coord-reopen-${stamp}-${i}`;
        const a = spawnGraphWorker('/graph-worker.js', T);
        const sa = newMessagePortRpcSession<GraphWorkerHost>(a.port);
        await sa.framed("g.addV('person').as('a').addE('self').to('a')", {});
        void Promise.resolve(sa.framed('g.V().repeat(both()).emit().count()', {})).catch(() => {}); // busy at death
        await new Promise((r) => setTimeout(r, 200));
        a.worker.terminate();
        const b = spawnGraphWorker('/graph-worker.js', T);
        const sb = newMessagePortRpcSession<GraphWorkerHost>(b.port);
        try {
          const info = await sb.info();
          if (info.vertexCount !== 1 || info.edgeCount !== 1) throw new Error(`cycle ${i}: reopened = ${JSON.stringify(info)}`);
        } finally {
          sa[Symbol.dispose]();
          sb[Symbol.dispose]();
          await destroyGraphWorker(b.worker, T); // b is healthy: closes, then removes the directory
        }
      }
    });

    // Destroy while the graph's Worker is BUSY: a cyclic repeat() with no times() is infinite per the spec
    // (and the browser has no per-request limit), so the Worker's one thread never dequeues a close request.
    // The destroy must still finish — bounded, by terminating the Worker — and remove the store; and the cut-off
    // query must FAIL, never be retried against the fresh empty graph a retry would resurrect.
    await check('destroy during a runaway query is bounded, removes the store, and fails the query', async () => {
      const R = `coord-runaway-${stamp}`;
      await post(R, "g.addV('person').as('a').addE('self').to('a')");
      const runaway = post(R, 'g.V().repeat(both()).emit().count()').then(
        async (res) => {
          const bytes = Buffer.from(await res.arrayBuffer());
          const r = await ioc.graphBinaryReader.readResponse(bytes).catch((e: unknown) => ({ status: { code: -1, message: String(e) }, result: { data: [] } }));
          return { http: res.status, code: r.status?.code, message: String(r.status?.message ?? ''), data: r.result?.data };
        },
        (e: unknown) => ({ http: -1, code: -1, message: String(e), data: undefined }),
      );
      await new Promise((r) => setTimeout(r, 500)); // let the Worker get stuck in the query
      const within = <T>(p: Promise<T>, ms: number, what: string) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} still pending after ${ms}ms`)), ms))]);
      const del = await within(router(new Request(`http://x/gremlin/${R}`, { method: 'DELETE' })), 25_000, 'DELETE');
      if (del.status !== 204) throw new Error(`delete status ${del.status}: ${await del.text()}`);
      const out = await within(runaway, 5_000, 'the cut-off query');
      const failed = out.http >= 400 || (out.code !== undefined && out.code !== 200 && out.code !== 204);
      if (!failed || !/destroyed/.test(out.message)) throw new Error(`cut-off query did not fail as destroyed: ${JSON.stringify(out)}`);
      const j = await (await router(new Request(`http://x/gremlin/${R}`, { method: 'OPTIONS' }))).json() as any;
      if (j.vertexCount !== 0) throw new Error(`after destroy = ${JSON.stringify(j)}`);
      await manager.destroy(R);
    });

    (self as any).postMessage({ results });
  } catch (e: any) {
    (self as any).postMessage({ results, fatal: String(e?.stack || e) });
  }
};
