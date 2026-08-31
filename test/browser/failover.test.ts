import { test, expect, describe } from 'bun:test';
import type { Page } from 'playwright';
import { withBrowserContext } from './support/harness.ts';

// The cross-tab failover proof — the one increment whose load-bearing facts only a real browser settles.
// Two tabs share ONE origin (one OPFS, one Web-Lock namespace, one Service Worker). Tab A leads a graph;
// we HARD-KILL it (close the page) and assert another tab takes over, re-opens the opfs-sahpool database
// over the committed data, and keeps serving — the DO one-instance guarantee, failed over.
//
// The reader `count()` is issued straight after the kill with NO settle: a hard-killed leader never closes
// its MessagePort, so the SW's stub to the dead Worker HANGS until the new leader (elected by the released
// Web Lock) pushes a fresh port; that push disposes the dead stub, the hung call rejects, and the manager
// retries once against the new leader. So this test also exercises the in-flight-across-failover retry.
describe.skipIf(!process.env.MOGWAI_BROWSER_LANE)('browser: cross-tab leader failover', () => {
  test('a hard-killed leader hands the graph to another tab, data intact', async () => {
    await withBrowserContext(
      {
        pageEntry: Bun.fileURLToPath(import.meta.resolve('./pages/failover.page.ts')),
        serviceWorker: Bun.fileURLToPath(import.meta.resolve('../../src/browser/service-worker.entry.ts')),
        extraWorkers: { '/graph-worker.js': Bun.fileURLToPath(import.meta.resolve('../../src/browser/graph-worker.entry.ts')) },
      },
      async ({ context, origin }) => {
        const G = `failover-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const setup = async (): Promise<Page> => {
          const page = await context.newPage();
          await page.goto(origin);
          await page.waitForFunction('window.__ready === true');
          await page.evaluate('window.mogwai.setup()');
          return page;
        };
        const count = (page: Page): Promise<number> => page.evaluate(([g]) => (window as any).mogwai.count(g), [G]);
        const write = (page: Page, gremlin: string): Promise<void> => page.evaluate(([g, q]) => (window as any).mogwai.write(g, q), [G, gremlin]);

        // Tab A leads G with two ACKED writes.
        const a = await setup();
        await write(a, "g.addV('person').property('name','marko')");
        await write(a, "g.addV('person').property('name','vadas')");
        expect(await count(a)).toBe(2);

        // Tab B joins and queues behind A for G's lock (a failover candidate).
        const b = await setup();
        await b.evaluate(([g]) => (window as any).mogwai.waitContended(g), [G]);

        // HARD-KILL the leader.
        await a.close();

        // Failover: B took over, re-opened opfs-sahpool over the committed data — count intact (and the
        // read that raced the kill retried across the handoff rather than erroring). Two acked writes,
        // present exactly once (never lost, never doubled).
        expect(await count(b)).toBe(2);

        // The new leader is fully functional: another acked write, applied once.
        await write(b, "g.addV('person').property('name','peter')");
        expect(await count(b)).toBe(3);
      },
    );
  }, 120_000);
});
