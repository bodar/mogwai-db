import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserPage, browserLaneEnabled } from './support/harness.ts';

// Phase 5c-browser-2: the browser's BACKGROUND replication scheduler in a REAL browser. A Web-Lock-elected
// tab ticks `POST /_scheduler/run` on a timer; the SW's runner uses an allowlisted http built from the
// config the page sent it. Proves the ticker auto-syncs a job, and that the page config reached the SW.
describe.skipIf(!browserLaneEnabled())('browser: background scheduler ticker + config-to-SW', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserPage({
      pageEntry: Bun.fileURLToPath(import.meta.resolve('./pages/scheduler-ticker.page.ts')),
      serviceWorker: Bun.fileURLToPath(import.meta.resolve('../../src/browser/service-worker.ts')),
      extraWorkers: {
        '/worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/worker.ts')),
        '/registry-worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/registry-worker.ts')),
      },
    });
  }, 90_000);

  const NAMES = [
    'an elected tab auto-syncs a local→local job on the timer (no manual run)',
    'the SW scheduler uses the allowlist from the page config (mogwai-config delivered)',
  ];

  test('the page ran every scheduler check (no fatal)', () => {
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
