import { test, expect, describe } from 'bun:test';
import gremlin from 'gremlin';
import './support/undici-shim.ts'; // Bun's undici Agent lacks close() — see the shim's header
import { graphContract } from './contract.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { writeGraphson } from '../src/formats/graphson.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;

// Live Durable Object: boot the Worker under `wrangler dev` (local workerd),
// then drive it with the same contract over the same GraphBinary wire as Bun.
const ROOT = `${import.meta.dir}/..`;
const PORT = 8976;
// The loopback host the io()-from-a-URL test serves its GraphSON doc from — allowlisted on the wrangler
// dev worker (via `--var HTTP_ALLOWLIST`) so the DO's outbound fetch is permitted. 127.0.0.1 is exactly
// the kind of internal host the SSRF guard blocks by DEFAULT; the test opts it in deliberately, proving
// the guard is a real gate (deny-all until an operator allowlists), not that loopback is trusted.
const DOC_HOST = '127.0.0.1';

let proc: ReturnType<typeof Bun.spawn> | undefined;

// Readiness must exercise the DURABLE OBJECT path, not just the Worker script. A probe of `/` (or any
// non-/gremlin path) is served by a plain static docs/404 response that never instantiates a DO, so it
// goes green the instant the isolate loads — while the DO namespace is still warming. The first
// DO-touching request then races that warmup and workerd answers 503, which is the management PUT
// flake. So probe a real `OPTIONS /gremlin/{id}` (the metadata verb — auto-creates + touches its DO) and
// treat a 503 — or any non-2xx — as NOT-yet-ready. A fresh id per probe keeps the warmup graphs off the
// shared ids the tests use (wrangler dev persists to disk).
async function waitForReady(origin: string, timeoutMs = 50_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/gremlin/warmup-${Date.now()}`, { method: 'OPTIONS', signal: AbortSignal.timeout(2_000) });
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
      // `--var HTTP_ALLOWLIST:127.0.0.1`: the DO's outbound io()/federate seam is deny-all by default
      // (empty allowlist). The io()-from-a-URL DO-boundary test below serves its doc from a loopback
      // Bun.serve, so the DO must be allowed to fetch that host — set ONLY here (dev), never in the
      // committed prod `wrangler.jsonc` vars (which stay `{}` = deny-all).
      ['./node_modules/.bin/wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1',
        '--log-level', 'error', '--var', `HTTP_ALLOWLIST:${DOC_HOST}`],
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
}, {
  servesAssets: true, // the Worker serves /scalar.js, /favicon.ico, /logo.png from the ASSETS binding
  // io() FROM A URL over the REAL workerd DO boundary — the make-or-break for the CF http-io wiring, which
  // a green Bun run cannot prove (the DO constructs its own allowlisted `Http` and `httpAwareIoStore`
  // INSIDE the DO — graph-store-do.ts — so only real workerd exercises it). The DO does the outbound fetch
  // at its own residency (io() is `residency: 'do'`); we serve the GraphSON doc from a loopback Bun.serve
  // the DO is allowlisted to reach, then assert the graph loaded through the two-pass streaming loader.
  extra: (getOrigin) => {
    describe('io from a URL (workerd DO boundary)', () => {
      // Build the modern graph's GraphSON once (a real dump, so the DO exercises the typed loader).
      let graphson: string;
      const graphUrl = (id: string) => `${getOrigin()}/gremlin/${id}`;
      const counts = async (id: string) => (await (await fetch(graphUrl(id), { method: 'OPTIONS' })).json()) as any;

      test('the DO fetches a URL through its allowlisted http seam and loads the graph', async () => {
        const src = new BunGraphManager(undefined, standardRegistry);
        for (const g of MODERN_SEED) await src.executor('src').framedAsync(g, {});
        graphson = writeGraphson(src.storeOf('src'));

        // A loopback doc server the workerd DO can fetch (its host is `--var`-allowlisted above).
        const docServer = Bun.serve({
          hostname: DOC_HOST,
          port: 0, // ephemeral
          fetch: (req) =>
            new URL(req.url).pathname === '/modern.json'
              ? new Response(graphson, { headers: { 'Content-Type': 'application/json' } })
              : new Response('not found', { status: 404 }),
        });
        const id = `io-url-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const conn = new DriverRemoteConnection(graphUrl(id));
        try {
          const g = traversal().with_(conn);
          const url = `http://${DOC_HOST}:${docServer.port}/modern.json`;
          await g.io(url).read().iterate(); // the DO fetches `url` and streams it into its own store
          // The modern graph (6 vertices, 6 edges) is now resident in the DO, fetched over HTTP.
          expect(await counts(id)).toMatchObject({ vertexCount: 6, edgeCount: 6 });
          // Not vacuous: a typed value survived the fetch → two-pass streaming load (marko's age).
          expect(await g.V().has('name', 'marko').values('age').toList()).toEqual([29]);
        } finally {
          await conn.close();
          docServer.stop(true);
        }
      }, 40_000);
    });
  },
});
