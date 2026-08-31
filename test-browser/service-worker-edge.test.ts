import { test, expect, describe, beforeAll } from 'bun:test';
import { runBrowserPage } from './support/harness.ts';

// The CAPSTONE of the single-tab browser path: the Service Worker HTTP edge intercepting a real client's
// fetch and brokering it to a page that hosts the coordinator + graph Workers over opfs-sahpool. Proves
// the port's headline thesis end to end in a real browser — a plain fetch AND the UNMODIFIED TinkerPop
// GLV both reach the local graph with no monkey-patching. Separate lane; `mise run test:browser`.
describe('browser: Service Worker edge + unmodified GLV', () => {
  let out: { results: { name: string; ok: boolean; error?: string }[]; fatal?: string };

  beforeAll(async () => {
    out = await runBrowserPage({
      pageEntry: Bun.fileURLToPath(import.meta.resolve('./pages/service-worker-edge.page.ts')),
      serviceWorker: Bun.fileURLToPath(import.meta.resolve('../src/browser/service-worker.entry.ts')),
      extraWorkers: { '/graph-worker.js': Bun.fileURLToPath(import.meta.resolve('../src/browser/graph-worker.entry.ts')) },
    });
  }, 90_000);

  const NAMES = [
    'a plain fetch is intercepted by the Service Worker and reaches the store',
    'the Service Worker routes a management GET (JSON) to the coordinator',
    'the UNMODIFIED TinkerPop GLV works over the Service Worker edge (fetch)',
  ];

  test('the page ran every edge check (no fatal)', () => {
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
