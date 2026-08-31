import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserWorker } from './support/harness.ts';

// The graph-worker STORE tier (GraphWorkerHost) driven in a real Chrome over the REAL opfs-sahpool VFS:
// seed a graph and read it back through the full compiler → executor → GraphBinary wire, decoding with
// the vendored client's own reader. Proves the entire core runs in a dedicated Worker on the production
// storage VFS (test/browser-wasm.test.ts proves the same core under Bun over :memory: — this closes the
// real-browser + real-VFS half). Separate lane; run with `mise run test:browser`.
describe.skipIf(!process.env.MOGWAI_BROWSER_LANE)('browser: GraphWorkerHost over opfs-sahpool', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserWorker({ entry: Bun.fileURLToPath(import.meta.resolve('./workers/graph-worker.worker.ts')) });
  }, 90_000);

  const NAMES = [
    'count() over the opfs-sahpool store',
    'hasLabel + values (property read from WASM SQLite)',
    'has(age, gt(28)) filters',
    'out(knows) traverses an edge',
    'order().by(age) sorts',
    'label() reads the interned label',
    'a vertex round-trips id, label, and materialized properties',
  ];

  test('the worker seeded and ran every check (no fatal)', () => {
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
