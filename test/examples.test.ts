import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { startServer } from '../src/bun/server.ts';
import { EXAMPLE_NAMES } from '../src/examples.ts';

// The example datasets end-to-end over the REAL Bun edge (increment 6b). This is the payoff of increment
// 6a (io()-from-URL): the AssetStore serves /examples/<name>.json, and a `g.io("<origin>/examples/<name>
// .json").read()` seeds a fresh graph from the server's OWN origin — the docs demo is self-seeding. We run
// a real HTTP server (BunAssetStore serves the embedded copies) and drive it with plain fetch, with the
// loopback host allowlisted exactly as an operator's `--allow-host 127.0.0.1` would (the io() SSRF guard is
// deny-all by default, so a self-hosted instance must opt its own host in — same as test/http-io.test.ts).

let server: ReturnType<typeof startServer>;
let origin: string;

beforeAll(() => {
  // port 0 → an ephemeral port; allowlist loopback so the server's own /examples/ fetch is permitted.
  server = startServer({ port: 0, httpAllowlist: ['127.0.0.1'] });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

/** POST a traversal and return the parsed untyped-JSON result array (Accept: application/json). */
async function run(id: string, gremlin: string): Promise<unknown[]> {
  const res = await fetch(`${origin}/gremlin/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ gremlin }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
}

describe('example datasets served + loadable via io() over the real Bun edge', () => {
  test('every /examples/<name>.json is served as JSON with real GraphSON bytes', async () => {
    for (const name of EXAMPLE_NAMES) {
      const res = await fetch(`${origin}/examples/${name}.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(100); // not a 404 body
      // Newline-delimited adjacency GraphSON — the first line parses as a labelled vertex.
      expect(JSON.parse(text.split('\n')[0]!)).toHaveProperty('label');
    }
  });

  test('io() loads the modern graph from /examples/modern.json (6 vertices, 6 edges)', async () => {
    const id = `ex-modern-${Date.now()}`;
    await run(id, `g.io("${origin}/examples/modern.json").read()`); // seed from the server's own origin
    expect(await run(id, 'g.V().count()')).toEqual([6]);
    expect(await run(id, 'g.E().count()')).toEqual([6]);
    // Not vacuous: a typed value survived the fetch → two-pass streaming load (marko's age).
    expect(await run(id, 'g.V().has("name","marko").values("age")')).toEqual([29]);
  });

  test('io() smoke-loads crew + sink (non-empty)', async () => {
    for (const name of ['crew', 'sink']) {
      const id = `ex-${name}-${Date.now()}`;
      await run(id, `g.io("${origin}/examples/${name}.json").read()`);
      const [vertexCount] = await run(id, 'g.V().count()') as [number];
      expect(vertexCount).toBeGreaterThan(0);
    }
  });
});
