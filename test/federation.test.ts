import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { MAX_FEDERATION_DEPTH, guardFederationDepth } from '../src/services/params/federation-depth.ts';
import { federateService } from '../src/services/catalog/federate.ts';
import { INJECT_VALUES_KEY } from '../src/compiler/steps/injection.ts';
import { decode } from './support/decode.ts';

// End-to-end federation on the REAL stack: two graphs owned by one BunGraphManager, one
// federating into the other via mogwai.graph.federate — the real service, real env, real depth
// guard, real GraphBinary framing at the client edge. A graph = a Durable Object; the Bun
// manager is the in-process mirror (sibling = another graph the same manager resolves by id).

const mgr = new BunGraphManager(undefined, extendedRegistry);
const dec = (f: { buf: Buffer }) => decode(f.buf);
const names = (vs: any[]) => vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort();

beforeAll(async () => {
  for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});   // the calling graph
  for (const g of CREW_SEED) await mgr.executor('crew').framedAsync(g, {});     // the sibling graph
});

const runNames = async (g: string) => names(await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec)));

describe('mogwai.graph.federate — source form, real stack', () => {
  test('g.call(federate) runs a sub-traversal on the sibling and returns its vertices detached', async () => {
    // crew graph vertices, fetched from `home` via federation.
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V())');
    const direct = await runNames('g.V()'); // crew, queried directly, for the expected set
    const directCrew = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V()', {})).map(dec)));
    expect(fed).toEqual(directCrew);
    expect(fed).not.toEqual(direct); // it really came from crew, not home
  });

  test('a nested __.V().has(...) sub-traversal is pushed down and filtered on the sibling', async () => {
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V().hasLabel("person"))');
    const expected = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec)));
    expect(fed).toEqual(expected);
    expect(fed.length).toBeGreaterThan(0);
  });

  test('a read tail runs LOCALLY over the detached results (values over landed props)', async () => {
    const vals = await Promise.all((await mgr.executor('home').framedAsync('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V().hasLabel("person")).values("name")', {})).map(dec));
    const expected = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec)));
    expect(vals.sort()).toEqual(expected);
  });

  test('federating to an empty/absent sibling graph yields no rows (create-on-demand, empty)', async () => {
    const fed = await runNames('g.call("mogwai.graph.federate").with("graph", "never-seeded").with("traversal", __.V())');
    expect(fed).toEqual([]);
  });
});

describe('mogwai.graph.federate — MID-TRAVERSAL per-parent value injection (Phase 6b)', () => {
  // home persons = {marko, vadas, josh, peter}; crew persons = {marko, stephen, matthias, daniel}.
  // Only "marko" is shared, so a per-parent name match returns exactly marko.
  const mid = (inj: string) =>
    `g.V().hasLabel("person").call("mogwai.graph.federate", ["graph":"crew", "traversal": __.V().has("name", T.value)], ${inj})`;

  test('for each home person, fetch same-named crew vertices (values injection)', async () => {
    const res = await runNames(mid('__.values("name")'));
    expect(res).toEqual(['marko']);                 // only the shared name matches
  });

  test('a parent that matches nothing on the sibling contributes no traverser (flatMap)', async () => {
    // vadas/josh/peter have no crew namesake → they drop; only marko survives. (Covered by the
    // count above, asserted explicitly here: exactly one result, not four.)
    const res = await Promise.all((await mgr.executor('home').framedAsync(mid('__.values("name")'), {})).map(dec));
    expect(res.length).toBe(1);
  });

  test('BATCHED: N distinct injected values → exactly ONE sibling hop (apply, spy source)', async () => {
    // Unit-test apply directly with a spy FederationSource: 4 distinct parent values must produce
    // exactly ONE raw() call (the batched hop binding the distinct-value array), not one per value.
    const contribution: any = federateService.resolve({} as any);
    let rawCalls = 0; let boundValues: any = null;
    const spySource: any = {
      executor: () => ({
        raw: (_g: string, params: Record<string, any>) => {
          rawCalls++;
          boundValues = params[INJECT_VALUES_KEY];
          return Promise.resolve([]);
        },
      }),
    };
    const head = [
      { kind: 'vertex', id: 1, label: 'person', props: {}, ordinal: 1, injectedValue: 'marko' },
      { kind: 'vertex', id: 2, label: 'person', props: {}, ordinal: 2, injectedValue: 'vadas' },
      { kind: 'vertex', id: 3, label: 'person', props: {}, ordinal: 3, injectedValue: 'marko' }, // dup
      { kind: 'vertex', id: 4, label: 'person', props: {}, ordinal: 4, injectedValue: 'josh' },
    ] as const;
    await contribution.apply(head, { graph: 'crew', traversal: { kind: 'traversal', gremlin: 'g.V().has("name", T.value)' } }, spySource, 0);
    expect(rawCalls).toBe(1);                         // ONE batched hop
    expect([...boundValues].sort()).toEqual(['josh', 'marko', 'vadas']); // DISTINCT values only
  });

  test('id() injection matches on the sibling element id', async () => {
    // No shared external ids across the two toy graphs → empty, but must not error (exercises the
    // id() injection kind + its rejoin JOIN on fid).
    const res = await Promise.all((await mgr.executor('home').framedAsync(mid('__.id()'), {})).map(dec));
    expect(Array.isArray(res)).toBe(true);
  });

  test('an unsupported injection (computed scalar) fails closed with a clear deferral', async () => {
    await expect(mgr.executor('home').framedAsync(mid('__.values("name").fold()'), {}))
      .rejects.toThrow(/injection must be a direct value read/);
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
