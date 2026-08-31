import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserWorker, browserLaneEnabled } from './support/harness.ts';

// The page-side edge in a real browser: makeRouter over the BrowserGraphManager (id → per-graph dedicated
// Worker → opfs-sahpool). Proves the full page path plus multi-graph routing and the management verbs —
// the whole browser store stack short of the Service Worker fetch intercept. Runs in the `browser` bracket.
describe.skipIf(!browserLaneEnabled())('browser: manager + makeRouter over per-graph Workers', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserWorker({
      entry: Bun.fileURLToPath(import.meta.resolve('./workers/browser-graph-manager.worker.ts')),
      extraWorkers: { '/graph-worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/worker.ts')) },
    });
  }, 90_000);

  const NAMES = [
    'router → manager → worker: count on graph A',
    'multi-graph isolation: B is its own Worker + store',
    'values read back through the full edge',
    'management GET returns counts JSON, auto-creating an empty graph',
    'management PUT creates (201)',
    'destroy wipes the store; re-address recreates it empty',
  ];

  test('the driver ran every edge check (no fatal)', () => {
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
