// A tab in the cross-tab failover scenario. Each tab is a WorkerFactory (registers the shared Service
// Worker + installs the factory); the driver (the bun test) opens two of them in ONE BrowserContext and
// calls this API step by step via `page.evaluate`. So the tabs share one origin's OPFS, Web Locks, and
// the single Service Worker — exactly the production shape.
import '../../../src/browser/buffer-global.ts'; // first — Buffer for the response decode
import { installMogwai } from '../../../src/browser/worker-factory.ts';
import { ioc } from '../../../src/io.ts';

const origin = location.origin;

async function post(graphId: string, gremlin: string): Promise<Response> {
  return fetch(`${origin}/gremlin/${graphId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gremlin, batchSize: 10_000 }),
  });
}

const api = {
  /** Register the SW + install this tab's WorkerFactory. After this, the SW re-broadcasts any active
   *  graphs to this tab so it queues for their leadership (a failover candidate). */
  async setup(): Promise<void> {
    await installMogwai(); // register SW + install factory, sibling scripts resolved relative to this page
  },

  /** Run a write query (a plain fetch through the SW edge). Resolves only on the response — an ACKED write. */
  async write(graphId: string, gremlin: string): Promise<void> {
    const res = await post(graphId, gremlin);
    if (!res.ok) throw new Error(`write ${res.status}`);
    await res.arrayBuffer();
  },

  /** `g.V().count()` through the SW edge, decoded to a number. */
  async count(graphId: string): Promise<number> {
    const bytes = Buffer.from(await (await post(graphId, 'g.V().count()')).arrayBuffer());
    const data = (await ioc.graphBinaryReader.readResponse(bytes)).result.data;
    return Number(data[0]);
  },

  /** Wait until graph `graphId`'s Web Lock is CONTENDED — held by one tab and pending for at least one
   *  other. That is the observable "this tab is queued behind the leader," so the driver can hard-kill the
   *  leader knowing a failover candidate exists. */
  async waitContended(graphId: string, timeoutMs = 8_000): Promise<void> {
    const name = `mogwai-graph-${graphId}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = await navigator.locks.query();
      const n = [...(snap.held ?? []), ...(snap.pending ?? [])].filter((l) => l.name === name).length;
      if (n >= 2) return;
      if (Date.now() > deadline) throw new Error(`lock ${name} never became contended (saw ${n})`);
      await new Promise((r) => setTimeout(r, 40));
    }
  },
};

(window as any).mogwai = api;
(window as any).__ready = true;
