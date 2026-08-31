import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserWorker, browserLaneEnabled } from './support/harness.ts';

// The BROWSER lane (Playwright → real Chrome). Everything paper-verifiable about the browser port runs
// under bun test against WASM SQLite in-process (test/bun-wasm.test.ts); this lane proves the parts
// that ONLY a real browser has — here, OpfsIoStore over real OPFS. It runs as part of a normal `bun test`
// (its own `browser` CI bracket); `browserLaneEnabled()` skips it where no system Chrome exists.
describe.skipIf(!browserLaneEnabled())('browser: OpfsIoStore over real OPFS', () => {
  let results: { name: string; ok: boolean; error?: string }[] = [];

  beforeAll(async () => {
    const out = await runBrowserWorker({ entry: Bun.fileURLToPath(import.meta.resolve('./workers/iostore.worker.ts')) });
    results = out.results;
  }, 90_000);

  // One test per check the worker ran, so a red run names the exact IoStore behaviour that broke.
  const NAMES = [
    'write then read round-trips through a stream',
    'a multi-chunk write reassembles in order',
    'an absent document fails closed',
    'list returns sorted root-relative keys, scoped by prefix',
    'a read is re-openable (two passes — GraphSON needs it)',
    'a rewrite truncates (no stale tail)',
    'abort leaves no half-graph behind',
  ];

  test('every OpfsIoStore check ran (worker reached the end)', () => {
    expect(results.map((r) => r.name).sort()).toEqual([...NAMES].sort());
  });

  for (const name of NAMES) {
    test(name, () => {
      const r = results.find((x) => x.name === name);
      expect(r, `check "${name}" did not run`).toBeDefined();
      expect(r!.ok ? null : r!.error).toBeNull();
    });
  }
});
