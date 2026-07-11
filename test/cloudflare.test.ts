import { graphContract } from './contract.ts';

// Live Durable Object: boot the Worker under `wrangler dev` (local workerd),
// then drive it with the same contract over the same GraphBinary wire as Bun.
const ROOT = `${import.meta.dir}/..`;
const PORT = 8976;

let proc: ReturnType<typeof Bun.spawn> | undefined;

async function waitForReady(url: string, timeoutMs = 50_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any HTTP response (even 404 for a non-/g/ path) means workerd is up.
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`wrangler dev did not become ready on ${url} within ${timeoutMs}ms`);
}

graphContract('cloudflare', {
  async start() {
    proc = Bun.spawn(
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'],
      {
        cwd: ROOT,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    await waitForReady(`http://127.0.0.1:${PORT}/`);
    // Unique graph id per run → fresh DO (wrangler dev persists state on disk).
    return `http://127.0.0.1:${PORT}/g/contract-${Date.now()}`;
  },
  async stop() {
    proc?.kill();
    await proc?.exited;
  },
});
