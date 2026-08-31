import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserWorker } from './support/harness.ts';

// The graph-worker postMessage TRANSPORT (graph-worker.entry.ts + GraphWorkerClient) in a real browser:
// a driver worker spawns the graph-worker as a nested dedicated Worker and drives it over RPC. Proves
// Framed[] crosses the structured-clone boundary and that a query FAILURE returns as a value (the RPC
// rejects rather than hanging) — the browser twin of the Cloudflare clone-boundary test.
describe('browser: graph-worker RPC transport', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserWorker({
      entry: Bun.fileURLToPath(import.meta.resolve('./workers/graph-worker-rpc.worker.ts')),
      extraWorkers: { '/graph-worker.js': Bun.fileURLToPath(import.meta.resolve('../src/browser/graph-worker.entry.ts')) },
    });
  }, 90_000);

  const NAMES = [
    'open boots the host with empty counts',
    'info reflects the seeded writes',
    'a query result crosses the boundary and decodes',
    'a filtered value stream crosses and decodes',
    'a failing query rejects as a value (does not hang the RPC)',
  ];

  test('the driver ran every transport check (no fatal)', () => {
    expect(out.fatal ?? null).toBeNull();
    expect(out.results.map((r) => r.name).sort()).toEqual([...NAMES].sort());
  });

  for (const name of NAMES) {
    test(name, () => {
      const r = out.results.find((x) => x.name === name);
      expect(r, `check "${name}" did not run`).toBeDefined();
      expect(r!.ok ? null : r!.error).toBeNull();
    });
  }
});
