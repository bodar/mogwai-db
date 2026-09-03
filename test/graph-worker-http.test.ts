import { test, expect, describe, beforeAll } from 'bun:test';
import { GraphWorkerHost } from '../src/browser/GraphWorkerHost.ts';
import { memoryWasmSqlFactory } from '../src/browser/WasmSqlite.ts';
import { allowlistedHttp } from '../src/http-allowlist.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { writeGraphson } from '../src/formats/graphson.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode } from './support/decode.ts';
import type { Http } from '../src/api.ts';

// Phase 0 (§7/§8 of the replication/http-interop plan) lifted into the BROWSER: the per-graph
// GraphWorkerHost now takes the same injected Http seam Bun/CF use, so io()/federate over an http(s) URL
// works in the browser too — a relative path stays local (OPFS), an http URL fetches over the seam. The
// seam is allowlisted (SSRF guard), so this drives the exact production wiring by injecting the same
// `allowlistedHttp` the Worker builds from the page's config, over an in-memory transport. Runs under
// Bun via the WASM SQL leaf (memoryWasmSqlFactory) — no Chrome needed for the wiring contract.

const DOC_URL = 'https://backup.example/graphs/modern.json';

let graphson: string;
beforeAll(async () => {
  const src = new BunGraphManager(undefined, standardRegistry);
  for (const g of MODERN_SEED) await src.executor('source').framedAsync(g, {});
  graphson = writeGraphson(src.storeOf('source'));
});

/** An in-memory Http serving the modern graph's GraphSON at DOC_URL. */
const serveDoc: Http = async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/graphs/modern.json') return new Response(graphson, { headers: { 'Content-Type': 'application/json' } });
  return new Response('not found', { status: 404 });
};

/** A GraphWorkerHost on an in-memory WASM store (no OPFS/Chrome), with the given Http seam and no local
 *  io binding — so a RELATIVE io path fails closed and only an allowlisted http URL fetches. */
async function openHost(http: Http): Promise<GraphWorkerHost> {
  const makeSql = await memoryWasmSqlFactory();
  return GraphWorkerHost.open(`gw-http-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, {
    makeSql: (gid) => Promise.resolve(makeSql(gid)),
    http,
  });
}

const count = async (host: GraphWorkerHost, g: string): Promise<number> => Number(await decode((await host.framed(g, {}))[0]!.buf));

describe('browser GraphWorkerHost: io()/federate over HTTP (Phase 0 lifted to the browser)', () => {
  test('io(url).read() imports a graph over the allowlisted Http seam', async () => {
    const host = await openHost(allowlistedHttp(['backup.example'], serveDoc));
    await host.framed(`g.io("${DOC_URL}").read()`, {});
    expect(await count(host, 'g.V().count()')).toBe(6);
    expect(await count(host, 'g.E().count()')).toBe(6);
    const ages = await Promise.all((await host.framed('g.V().has("name","marko").values("age")', {})).map((f) => decode(f.buf)));
    expect(ages).toEqual([29]); // typed loader, not raw bytes
  });

  test('io() over HTTP is DENIED when the allowlist is empty (deny-all default)', async () => {
    const host = await openHost(allowlistedHttp([], serveDoc));
    await expect(host.framed(`g.io("${DOC_URL}").read()`, {})).rejects.toThrow(/allowlist/);
  });

  test('a relative io path routes to the local store, not http (fails closed on no binding, not the allowlist)', async () => {
    const host = await openHost(allowlistedHttp([], serveDoc));
    await expect(host.framed('g.io("data/local.json").read()', {})).rejects.toThrow(/no io binding/);
  });
});
