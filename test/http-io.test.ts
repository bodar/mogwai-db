import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { writeGraphson } from '../src/formats/graphson.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';
import type { Http } from '../src/api.ts';

// io() over HTTP: `g.io("https://…/modern.json").read()` imports a whole GraphSON DOCUMENT over the
// same `Http` seam federation uses — a URL is just another document location, so the io service is
// untouched and only the injected IoStore becomes URL-aware (docs/2026-09-02-…-plan.md §7/§9).
// Wired in memory: a test Http serves a GraphSON string, and a fresh graph reads it through io().

const DOC_URL = 'https://backup.example/graphs/modern.json';

// Build the document once from a real modern graph, then serve it over an in-memory Http handler.
let graphson: string;
beforeAll(async () => {
  const src = new BunGraphManager(undefined, standardRegistry);
  for (const g of MODERN_SEED) await src.executor('source').framedAsync(g, {});
  graphson = writeGraphson(src.storeOf('source'));
});

const serveDoc: Http = async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/graphs/modern.json') return new Response(graphson, { headers: { 'Content-Type': 'application/json' } });
  return new Response('not found', { status: 404 });
};

const count = async (mgr: BunGraphManager, id: string, g: string): Promise<number> =>
  Number(await decode((await mgr.executor(id).framedAsync(g, {}))[0]!.buf));

describe('io() from a URL — a GraphSON document fetched over the Http seam', () => {
  test('g.io(url).read() imports another graph over HTTP into a fresh local graph', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, serveDoc);
    await mgr.executor('target').framedAsync(`g.io("${DOC_URL}").read()`, {});
    // The modern graph: 6 vertices, 6 edges — now resident in the fresh local graph.
    expect(await count(mgr, 'target', 'g.V().count()')).toBe(6);
    expect(await count(mgr, 'target', 'g.E().count()')).toBe(6);
    // A real value survived the round trip (marko's age), so the fetch fed the typed loader, not bytes.
    const ages = await Promise.all((await mgr.executor('target').framedAsync('g.V().has("name","marko").values("age")', {})).map((f) => decode(f.buf)));
    expect(ages).toEqual([29]);
  });

  test('a fetch failure fails closed with the URL', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, serveDoc);
    await expect(mgr.executor('target').framedAsync('g.io("https://backup.example/graphs/absent.json").read()', {}))
      .rejects.toThrow();
  });

  test('a non-URL io path with no local binding still fails closed naming the binding', async () => {
    const mgr = new BunGraphManager(undefined, standardRegistry, undefined, undefined, undefined, serveDoc);
    await expect(mgr.executor('target').framedAsync('g.io("data/local.json").read()', {}))
      .rejects.toThrow(/no io binding/);
  });
});
