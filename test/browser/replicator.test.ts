import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserPage, browserLaneEnabled } from './support/harness.ts';

// Phase 5c-browser: the replication control plane in a REAL browser. The Service Worker edge intercepts
// `/_replicator` + `/_scheduler`, brokers config CRUD to the SINGLETON registry Worker (persistent
// opfs-sahpool), and runs the worker-residency scheduler at the edge over the graph Workers — the browser
// twin of the CF singleton registry DO + Cron scheduler. Runs in the `browser` CI bracket.
describe.skipIf(!browserLaneEnabled())('browser: replication control plane (registry Worker + scheduler)', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserPage({
      pageEntry: Bun.fileURLToPath(import.meta.resolve('./pages/replicator.page.ts')),
      serviceWorker: Bun.fileURLToPath(import.meta.resolve('../../src/browser/service-worker.ts')),
      extraWorkers: {
        '/worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/worker.ts')),
        '/registry-worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/registry-worker.ts')),
      },
    });
  }, 90_000);

  const NAMES = [
    'registry CRUD round-trips through the SW to the persistent registry Worker',
    'POST /_scheduler/run replicates a local→local job at the SW edge',
    '_scheduler/docs shows the job with its state',
  ];

  test('the page ran every replication check (no fatal)', () => {
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
