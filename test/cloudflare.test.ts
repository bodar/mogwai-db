import { graphContract } from './contract.ts';

// Live Durable Object: boot the Worker under `wrangler dev` (local workerd),
// then drive it with the same contract over the same GraphBinary wire as Bun.
const ROOT = `${import.meta.dir}/..`;
const PORT = 8976;

let proc: ReturnType<typeof Bun.spawn> | undefined;

// Readiness must exercise the DURABLE OBJECT path, not just the Worker script. A probe of `/` (or any
// non-/gremlin path) is served by a plain `Response.redirect`/404 that never instantiates a DO, so it
// goes green the instant the isolate loads — while the DO namespace is still warming. The first
// DO-touching request then races that warmup and workerd answers 503, which is the management PUT
// flake. So probe a real `GET /gremlin/{id}` (auto-creates + touches its DO) and treat a 503 — or any
// non-2xx — as NOT-yet-ready. A fresh id per probe keeps the warmup graphs off the shared ids the tests
// use (wrangler dev persists to disk).
async function waitForReady(origin: string, timeoutMs = 50_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/gremlin/warmup-${Date.now()}`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return; // the DO answered — the subsystem is live, not just the script loaded
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await Bun.sleep(250);
  }
  throw new Error(`wrangler dev did not become ready on ${origin} within ${timeoutMs}ms (last: ${last})`);
}

graphContract('cloudflare', {
  async start() {
    proc = Bun.spawn(
      // `--log-level error`: wrangler dev's default `info` narrates every request (`[wrangler:info]
      // POST /gremlin/… 200 OK`) and re-prints an esbuild warning about the VENDORED client's
      // package.json export conditions — ~70 lines per suite run, none of it about this repo's code.
      // Startup failures and real errors still print, which is the only thing this spawn needs to say.
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
        '--log-level', 'error'],
      {
        cwd: ROOT,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    await waitForReady(`http://127.0.0.1:${PORT}`);
    // The contract addresses graphs under {origin}/gremlin/{id}; ids are unique per
    // run so DOs stay fresh (wrangler dev persists state on disk).
    return `http://127.0.0.1:${PORT}`;
  },
  async stop() {
    proc?.kill();
    await proc?.exited;
  },
});
