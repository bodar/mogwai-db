import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { ioc } from '../src/io.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { MAX_FEDERATION_DEPTH, guardFederationDepth } from '../src/services/federation-depth.ts';

// End-to-end federation on the REAL stack: two graphs owned by one BunGraphManager, one
// federating into the other via mogwai.graph.federate — the real service, real env, real depth
// guard, real GraphBinary framing at the client edge. A graph = a Durable Object; the Bun
// manager is the in-process mirror (sibling = another graph the same manager resolves by id).

const mgr = new BunGraphManager(undefined, extendedRegistry);
const dec = (f: { buf: Buffer }) => ioc.anySerializer.deserialize(f.buf, true).v;
const names = (vs: any[]) => vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort();

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});   // the calling graph
  for (const g of CREW_SEED) await mgr.executor('crew').framedAsync(g, {});     // the sibling graph
});

const runNames = async (g: string) => names((await mgr.executor('home').framedAsync(g, {})).map(dec));

describe('mogwai.graph.federate — source form, real stack', () => {
  test('g.call(federate) runs a sub-traversal on the sibling and returns its vertices detached', async () => {
    // crew graph vertices, fetched from `home` via federation.
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V())');
    const direct = await runNames('g.V()'); // crew, queried directly, for the expected set
    const directCrew = names((await mgr.executor('crew').framedAsync('g.V()', {})).map(dec));
    expect(fed).toEqual(directCrew);
    expect(fed).not.toEqual(direct); // it really came from crew, not home
  });

  test('a nested __.V().has(...) sub-traversal is pushed down and filtered on the sibling', async () => {
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V().hasLabel("person"))');
    const expected = names((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec));
    expect(fed).toEqual(expected);
    expect(fed.length).toBeGreaterThan(0);
  });

  test('a read tail runs LOCALLY over the detached results (values over landed props)', async () => {
    const vals = (await mgr.executor('home').framedAsync('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V().hasLabel("person")).values("name")', {})).map(dec);
    const expected = names((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec));
    expect(vals.sort()).toEqual(expected);
  });

  test('federating to an empty/absent sibling graph yields no rows (create-on-demand, empty)', async () => {
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "never-seeded").with("traversal", __.V())');
    expect(fed).toEqual([]);
  });
});

describe('federation fails closed', () => {
  test('a missing graph param throws', async () => {
    await expect(mgr.executor('home').framedAsync('g.call("mogwai.graph.federate").with("traversal", __.V())', {}))
      .rejects.toThrow(/"graph" param/);
  });

  test('an unrooted sub-traversal throws at compile (must be source-rooted)', async () => {
    await expect(mgr.executor('home').framedAsync('g.call("mogwai.graph.federate").with("graph","crew").with("traversal", __.out())', {}))
      .rejects.toThrow(/source-rooted/);
  });

  test('a non-element sub-traversal terminal fails closed (detached element references only)', async () => {
    await expect(mgr.executor('home').framedAsync('g.call("mogwai.graph.federate").with("graph","crew").with("traversal", __.V().count())', {}))
      .rejects.toThrow(/must yield vertices or edges/);
  });
});

describe('recursive federation + depth guard', () => {
  // One hop (depth 1) against a real sibling works — a self-federate to 'home' whose body is a
  // plain g.V() is a single non-recursive hop, so it resolves.
  test('a single federated hop resolves (depth 1, no recursion)', async () => {
    const selfFed = 'g.call("mogwai.graph.federate").with("graph","home").with("traversal", __.V())';
    await expect(mgr.executor('home').framedAsync(selfFed, {})).resolves.toBeDefined();
  });

  // A GENUINELY recursive chain (a sub-traversal that itself federates) needs the mid-traversal
  // call form (Phase 6b) or a data-seeded federate, neither expressible as a source-form inline
  // string here — so the guard itself is unit-tested directly (federation-depth.test.ts). The
  // env passes depth+1 per hop and guardFederationDepth throws past the ceiling; that wiring is
  // exercised by the depth threaded through this hop (the env received depth 0, ran the sibling
  // at depth 0, and a nested federate would have hopped to 1, 2, … until MAX).
  test('MAX_FEDERATION_DEPTH is a small, positive ceiling', () => {
    expect(MAX_FEDERATION_DEPTH).toBeGreaterThan(0);
    expect(MAX_FEDERATION_DEPTH).toBeLessThan(20);
  });

  test('guardFederationDepth throws past the ceiling, passes at/under it', () => {
    for (let d = 0; d <= MAX_FEDERATION_DEPTH; d++)
      expect(() => guardFederationDepth(d, 'g')).not.toThrow();
    expect(() => guardFederationDepth(MAX_FEDERATION_DEPTH + 1, 'g')).toThrow(/federation depth exceeded/);
  });
});
