// Phase 5c-browser-2: the browser's BACKGROUND replication scheduler. A Web-Lock-elected tab ticks
// `POST /_scheduler/run` on a timer (waking the SW to run due jobs), and the SW's runner uses an
// allowlisted http built from the config this page sends it (`mogwai-config`) — the "pull from a remote
// peer into this tab" enabler. This page proves both: an auto-synced local→local job (the ticker), and
// that the config's host allowlist reached the SW's scheduler.
import '../../../src/browser/buffer-global.ts';
import { installMogwai } from '../../../src/browser/worker-factory.ts';

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() >= deadline) return v;
    await sleep(25);
  }
}

async function main() {
  // A short scheduler interval turns the background ticker on; the allowlist is what the SW's scheduler uses
  // for a remote peer (proved below via a non-allowlisted host's refusal message).
  await installMogwai({ config: { httpAllowlist: ['allowed.example'], schedulerIntervalMs: 40 } });

  const O = location.origin;
  const ts = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const jsonReq = (path: string, method: string, body?: unknown) =>
    fetch(`${O}${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const gremlin = (g: string, text: string) =>
    fetch(`${O}/gremlin/${g}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gremlin: text, batchSize: 10_000 }) });
  const vertexCount = async (g: string): Promise<number> => ((await (await fetch(`${O}/gremlin/${g}`)).json()) as any).vertexCount;
  const jobOf = async (id: string): Promise<any> => {
    const docs = (await (await jsonReq('/_scheduler/docs', 'GET')).json()) as any;
    return docs.docs.find((d: any) => d.id === id)?.job ?? null;
  };

  await check('an elected tab auto-syncs a local→local job on the timer (no manual run)', async () => {
    const src = `tsrc-${ts}`, dst = `tdst-${ts}`;
    await gremlin(src, "g.addV('person').addV('person').addV('person')");
    await jsonReq(`/_replicator/tjob-${ts}`, 'PUT', { source: src, target: dst, continuous: true });
    // Do NOT POST /_scheduler/run — the background ticker must drive it.
    const n = await until(() => vertexCount(dst), (v) => v === 3);
    if (n !== 3) throw new Error(`dst vertexCount = ${n} (ticker did not sync)`);
  });

  await check('the SW scheduler uses the allowlist from the page config (mogwai-config delivered)', async () => {
    // A remote job to a NON-allowlisted host: the ticker runs it and it is refused. The refusal message
    // proves the config's allowlist reached the SW — "not allowlisted" (a non-empty list) vs the deny-all
    // "outbound HTTP is disabled" we'd see if the config had never arrived.
    await jsonReq(`/_replicator/tremote-${ts}`, 'PUT', { source: 'http://blocked.example/gremlin/x', target: `rdst-${ts}`, continuous: true });
    const job = await until(() => jobOf(`tremote-${ts}`), (j) => !!j && j.state === 'crashing');
    const msg = String((job?.info as any)?.error ?? '');
    if (!/not allowlisted/.test(msg) || !/allowed\.example/.test(msg)) throw new Error(`unexpected error: ${msg}`);
  });

  (window as any).__result = { results };
  (window as any).__done = true;
}

main().catch((e: any) => {
  (window as any).__result = { results, fatal: String(e?.stack || e) };
  (window as any).__done = true;
});
