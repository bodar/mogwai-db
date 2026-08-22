import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { MAX_FEDERATION_DEPTH, guardFederationDepth } from '../src/services/params/federation-depth.ts';
import { createFederateService } from '../src/services/catalog/federate.ts';
import { INJECT_VALUES_KEY } from '../src/compiler/ir/injection.ts';
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
    // The source is a CONSTRUCTION dependency and params/depth come off the call ctx, so `apply`
    // takes only the rows — this test wires the spy the same way the app scope does.
    const contribution: any = createFederateService(spySource).resolve({
      params: { graph: 'crew', traversal: { kind: 'traversal', gremlin: 'g.V().has("name", T.value)' } },
      federationDepth: 0,
    } as any);
    const head = [
      { kind: 'vertex', id: 1, label: 'person', props: {}, ordinal: 1, injectedValue: 'marko' },
      { kind: 'vertex', id: 2, label: 'person', props: {}, ordinal: 2, injectedValue: 'vadas' },
      { kind: 'vertex', id: 3, label: 'person', props: {}, ordinal: 3, injectedValue: 'marko' }, // dup
      { kind: 'vertex', id: 4, label: 'person', props: {}, ordinal: 4, injectedValue: 'josh' },
    ] as const;
    await contribution.apply(head);
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

// SUBGRAPH form (movement over a bound edge Ref — docs/2026-08-21-barrier-substrate-design.md §(B)).
// `.with("subgraph", true)` over an EDGE-producing sub-traversal brings back the edges (which carry
// src/tgt adjacency) PLUS their incident vertices WITH data. The local tail then WALKS it: inV/outV/
// bothV join the landed vertices, so the endpoint re-enters detachedTail with full payload and
// values()/id()/label() compose. A detached element has no live adjacency (TinkerPop) — this is not
// that; it is a real subgraph, materialised as bound relations and traversed locally.
describe('mogwai.graph.federate — SUBGRAPH form (traverse a fetched subgraph locally)', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const vals = async (g: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec))).map((v: any) => v).sort();
  // The oracle: the SAME endpoint traversal run DIRECTLY on the sibling.
  const onCrew = async (g: string) =>
    (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec))).sort();

  test('inV().values(name) — the develops-TARGETS, with their data, from the landed vertices', async () => {
    expect(await vals(sg('.inV().values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").inV().values("name")'));
  });
  test('outV().values(name) — the develops-SOURCES', async () => {
    expect(await vals(sg('.outV().values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").outV().values("name")'));
  });
  test('bothV().values(name) — the UNION of both endpoints (multiset)', async () => {
    expect(await vals(sg('.bothV().values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").bothV().values("name")'));
  });
  test('inV().id() reads the endpoint id off the landed edge', async () => {
    expect((await vals(sg('.inV().id()'))).length).toBe(5); // 5 develops edges → 5 targets
  });
  test('WITHOUT subgraph:true, movement off a detached edge still fails closed', async () => {
    await expect(mgr.executor('home').framedAsync(
      'g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V().hasLabel("person").outE("develops")).inV().values("name")', {}))
      .rejects.toThrow(/not supported after a barrier call/);
  });
});

// SUBGRAPH re-source (TinkerPop's sg.traversal()): `.V()`/`.E()` root a fresh traversal at the fetched
// subgraph, and out/in/both walk the bound edges to the bound vertices — vertex→vertex movement over a
// bound edge Ref. The oracle is always the SAME traversal run directly on the sibling.
describe('mogwai.graph.federate — SUBGRAPH re-source and vertex→vertex movement', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const vals = async (g: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec))).sort();
  const onCrew = async (g: string) =>
    (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec))).sort();

  test('.V() re-sources at the subgraph vertices (the distinct endpoints)', async () => {
    // The subgraph vertices are exactly the endpoints of the develops edges.
    expect(await vals(sg('.V().values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").bothV().dedup().values("name")'));
  });
  test('.V().out(develops) walks vertex→vertex over the bound edges', async () => {
    expect(await vals(sg('.V().out("develops").values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").inV().values("name")'));
  });
  test('.V().in(develops) walks the other way', async () => {
    expect(await vals(sg('.V().in("develops").values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").outV().values("name")'));
  });
  test('.V().out() with no label = every bound edge (only develops here)', async () => {
    expect(await vals(sg('.V().out().values("name")'))).toEqual(await vals(sg('.V().out("develops").values("name")')));
  });
  test('a 2-hop walk terminates on the subgraph boundary (software has no out-develops)', async () => {
    expect(await vals(sg('.V().out("develops").out("develops").values("name")'))).toEqual([]);
  });
});

// has()/hasLabel() FILTER subgraph vertices against their landed {t,v} property tree / label array —
// an EXISTS over the exploded json (multi-valued membership), so they compose anywhere a vertex is on
// the bound stream: after .V() and after a movement hop alike.
describe('mogwai.graph.federate — SUBGRAPH has()/hasLabel filters', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const vals = async (g: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec))).sort();
  const onCrew = async (g: string) =>
    (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec))).sort();

  test('hasLabel(person) keeps the developers', async () => {
    expect(await vals(sg('.V().hasLabel("person").values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").outV().dedup().values("name")'));
  });
  test('hasLabel(software) keeps the targets', async () => {
    expect(await vals(sg('.V().hasLabel("software").values("name")')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").inV().dedup().values("name")'));
  });
  test('has(name, value) filters by an exact property value', async () => {
    expect(await vals(sg('.V().has("name","marko").values("name")'))).toEqual(['marko']);
  });
  test('has(key) keeps vertices that carry the property', async () => {
    // every subgraph vertex has a name; none has an "age" (crew persons carry location, not age).
    expect((await vals(sg('.V().has("name").values("name")'))).length).toBe(5);
    expect(await vals(sg('.V().has("age").values("name")'))).toEqual([]);
  });
  test('has(name, P.neq(...)) — a comparison predicate over the bound value', async () => {
    expect(await vals(sg('.V().hasLabel("person").has("name", P.neq("marko")).values("name")')))
      .toEqual(['matthias', 'stephen']);
  });
  test('has() composes AFTER a movement hop (multiset — one per matching edge)', async () => {
    expect(await vals(sg('.V().hasLabel("person").out("develops").has("name","gremlin").values("name")')))
      .toEqual(['gremlin', 'gremlin', 'gremlin']);
  });
});

// Shape-agnostic row ops (count/dedup) over a landed stream — a detached federated result OR a bound
// subgraph. Neither reads the base tables (count reads cardinality, dedup collapses by element id), so
// both are correct on the landed relation; this also fixes the misattributed "V() not supported" that
// a following count/dedup used to raise.
describe('mogwai.graph.federate — count()/dedup() over the landed stream', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const one = async (g: string) => {
    const r = await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec));
    return Number(r[0]);
  };
  test('.V().count() counts the subgraph vertices', async () => {
    expect(await one(sg('.V().count()'))).toBe(5);
  });
  test('.count() counts the edge stream', async () => {
    expect(await one(sg('.count()'))).toBe(5);
  });
  test('dedup() collapses by element identity, then count()', async () => {
    // 5 develops edges → 5 targets, but only 2 DISTINCT target vertices.
    expect(await one(sg('.V().out("develops").count()'))).toBe(5);
    expect(await one(sg('.V().out("develops").dedup().count()'))).toBe(2);
  });
  test('count() works over a plain (non-subgraph) detached result too', async () => {
    const crewCount = await one('g.call("mogwai.graph.federate").with("graph", "crew").with("traversal", __.V()).count()');
    const direct = Number((await Promise.all((await mgr.executor('crew').framedAsync('g.V().count()', {})).map(dec)))[0]);
    expect(crewCount).toBe(direct);
  });
});

// ELEMENT-TERMINAL subgraph traversals — the chain ends on a bound element, so the WHOLE vertex/edge
// (id, label, property bag) crosses to the wire. This is the leaf-framing path (a bound element frames
// through the landed payload), distinct from the scalar-terminal cases above that end in values()/id()/
// count(). The oracle is the SAME endpoint traversal run directly on the sibling — compared on the
// framed name properties AND the labels, so the whole element round-trips, not just a projected value.
describe('mogwai.graph.federate — SUBGRAPH element-terminal (whole vertices to the wire)', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  // Expand each framed element by its `bulk` (a convergent bound walk collapses to compact (vertex, N)
  // pairs on the wire — the RLE the client expands — so the test expands too to see the full multiset).
  const elems = async (g: string) => {
    const framed = await mgr.executor('home').framedAsync(g, {});
    const decoded = await Promise.all(framed.map(async (f: any) => ({ v: await decode(f.buf), bulk: Number(f.bulk) })));
    return decoded.flatMap(({ v, bulk }) => Array(bulk).fill(v));
  };
  const vlabels = (vs: any[]) => vs.map((v: any) => v.label).sort();
  // The oracle is the SAME traversal read one step SHORTER — its `.values("name")` / `.label()` are
  // validated against the crew sibling above. So an element-terminal result frames correctly iff the
  // WHOLE vertices carry exactly the names and labels that projected value stream does. This pins the
  // leaf-framing (a bound element → id/label/props on the wire) without re-deriving a fresh oracle.
  const projNames = async (t: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(sg(`${t}.values("name")`), {})).map(dec))).sort();
  const projLabels = async (t: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(sg(`${t}.label()`), {})).map(dec))).sort();

  for (const t of ['.inV()', '.V()', '.V().out("develops")', '.V().hasLabel("person")']) {
    test(`${t} returns the vertices WHOLE — names+labels match the projected streams`, async () => {
      const got = await elems(sg(t));
      expect(names(got)).toEqual(await projNames(t));
      expect(vlabels(got)).toEqual(await projLabels(t));
    });
  }
});

// labels() over a bound vertex — the label FAN-OUT (one row per label), rejoined from the landed relation
// through the ONE vocabulary (source.labelNames + the shared order-mint), oracled on the crew sibling.
describe('mogwai.graph.federate — SUBGRAPH labels() fan-out', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const vals = async (g: string) => (await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec))).sort();
  const onCrew = async (g: string) => (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec))).sort();
  test('.V().labels() fans out each subgraph vertex\'s labels', async () => {
    expect(await vals(sg('.V().labels()')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").bothV().dedup().labels()'));
  });
  test('.inV().labels() composes after a movement hop', async () => {
    expect(await vals(sg('.inV().labels()')))
      .toEqual(await onCrew('g.V().hasLabel("person").outE("develops").inV().labels()'));
  });
});

// AGGREGATION over a bound subgraph — group()/groupCount()/order()/project()/fold() compose through the
// MAIN FOLD (detachedTail hands off once the source-position steps are done), with every by()/reducer
// read routed through the BoundGraph. Oracle is always the same traversal run directly on crew.
describe('mogwai.graph.federate — SUBGRAPH aggregation (group/order/project via the main fold)', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const one = async (g: string, on: 'home' | 'crew' = 'home') =>
    dec((await mgr.executor(on).framedAsync(g, {}))[0]!);
  const list = async (g: string, on: 'home' | 'crew' = 'home') =>
    (await Promise.all((await mgr.executor(on).framedAsync(g, {})).map(dec)));
  const crewBoth = 'g.V().hasLabel("person").outE("develops").bothV().dedup()';

  test('order().by(name) over the subgraph vertices', async () => {
    expect(await list(sg('.V().order().by("name").values("name")')))
      .toEqual(await list(`${crewBoth}.order().by("name").values("name")`, 'crew'));
  });
  test('order().by(T.label).by(name) — multi-key order', async () => {
    expect(await list(sg('.V().order().by(T.label).by("name").values("name")')))
      .toEqual(await list(`${crewBoth}.order().by(T.label).by("name").values("name")`, 'crew'));
  });
  test('groupCount().by(T.label) — a map keyed by the landed label', async () => {
    expect(await one(sg('.V().groupCount().by(T.label)')))
      .toEqual(await one(`${crewBoth}.groupCount().by(T.label)`, 'crew'));
  });
  test('group().by(T.label).by(count) — group keyed by label, counted', async () => {
    expect(await one(sg('.V().group().by(T.label).by(__.count())')))
      .toEqual(await one(`${crewBoth}.group().by(T.label).by(__.count())`, 'crew'));
  });
  test('group().by(T.label).by(name-fold) — group value folds in the landed order', async () => {
    expect(await one(sg('.V().group().by(T.label).by(__.values("name").fold())')))
      .toEqual(await one(`${crewBoth}.group().by(T.label).by(__.values("name").fold())`, 'crew'));
  });

  // CHANNELS OVER A BOUND GRAPH: a source-form subgraph seed mints an `encounter` from the landed
  // array order, so a SOURCE-order fold() (no order() step) is deterministic and preserves the stream
  // order. Self-consistent oracle: fold(stream) == the same stream collected, both in landed order.
  test('.V().values(name).fold() collects in the seed (landed) order', async () => {
    expect(await one(sg('.V().values("name").fold()')))
      .toEqual(await list(sg('.V().values("name")')));
  });
  test('.inV().values(name).fold() preserves order after a movement hop', async () => {
    expect(await one(sg('.inV().values("name").fold()')))
      .toEqual(await list(sg('.inV().values("name")')));
  });

  // BULK over a bound graph: a convergent walk collapses to compact (vertex, SUM(bulk)) pairs — the RLE
  // the base graph uses. Correctness is a multiset either way; these assert the collapse actually FIRES
  // (fewer framed rows than traversers) and the reducer reads SUM(bulk).
  test('.V().out(develops).count() sums bulk over the convergent walk', async () => {
    expect(await one(sg('.V().out("develops").count()')))
      .toEqual(await one(`${crewBoth}.out("develops").count()`, 'crew'));
  });
  test('.V().out(develops) element-terminal collapses to compact (vertex, bulk) pairs', async () => {
    const framed = await mgr.executor('home').framedAsync(sg('.V().out("develops")'), {});
    const traversers = framed.reduce((n, f: any) => n + Number(f.bulk), 0);
    expect(framed.length).toBeLessThan(traversers); // collapse fired: compact rows < the multiset they stand for
    expect(traversers).toBe((await list(sg('.V().out("develops").values("name")'))).length);
  });

  test('project(name,label).by(name).by(T.label) — a record per vertex', async () => {
    expect(await list(sg('.V().order().by("name").project("n","l").by("name").by(T.label)')))
      .toEqual(await list(`${crewBoth}.order().by("name").project("n","l").by("name").by(T.label)`, 'crew'));
  });
  test('values(name).fold() collects the subgraph names', async () => {
    expect(await one(sg('.V().order().by("name").values("name").fold()')))
      .toEqual(await one(`${crewBoth}.order().by("name").values("name").fold()`, 'crew'));
  });
});

// Richer subgraph vertex selection: has(key, within(...)), the 3-arg has(label, key, value), and
// V(ids)/E(ids) filtering the bound source by id.
// valueMap()/elementMap() over a bound subgraph — the per-key value arrays read from the landed {t,v}
// tree (source.valueMapPairs), the map/token shaping shared with the base graph. Oracled on crew.
describe('mogwai.graph.federate — SUBGRAPH valueMap()/elementMap()', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const crewBoth = 'g.V().hasLabel("person").outE("develops").bothV().dedup()';
  // Maps compared as a sorted set of JSON strings — key order in a map is not part of the value.
  const maps = async (g: string, on: 'home' | 'crew' = 'home') =>
    (await Promise.all((await mgr.executor(on).framedAsync(g, {})).map((f: any) => decode(f.buf))))
      .map((m: any) => JSON.stringify(m, (_k, v) => (v instanceof Map ? [...v.entries()].sort() : v))).sort();

  test('valueMap(name) reads the landed property tree', async () => {
    expect(await maps(sg('.V().order().by("name").valueMap("name")')))
      .toEqual(await maps(`${crewBoth}.order().by("name").valueMap("name")`, 'crew'));
  });
  test('valueMap() over all keys', async () => {
    expect(await maps(sg('.V().valueMap()'))).toEqual(await maps(`${crewBoth}.valueMap()`, 'crew'));
  });
  test('elementMap()/valueMap(true) — tokens over bound fail closed (tokenRow not yet source-routed)', async () => {
    await expect(mgr.executor('home').framedAsync(sg('.V().elementMap("name")'), {})).rejects.toThrow();
    await expect(mgr.executor('home').framedAsync(sg('.V().valueMap(true, "name")'), {})).rejects.toThrow();
  });
  test('valueMap(name) composes after a movement hop', async () => {
    expect(await maps(sg('.inV().valueMap("name")')))
      .toEqual(await maps(`g.V().hasLabel("person").outE("develops").inV().valueMap("name")`, 'crew'));
  });
});

// properties() over a bound subgraph — the property STREAM exploded from the landed {t,v} tree
// (source.propertyStream), with value()/key()/terminal framing. .id() (no landed vpid) and meta
// (not landed) fail closed. Oracled on crew.
describe('mogwai.graph.federate — SUBGRAPH properties() stream', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const crewBoth = 'g.V().hasLabel("person").outE("develops").bothV().dedup()';
  const vals = async (g: string, on: 'home' | 'crew' = 'home') =>
    (await Promise.all((await mgr.executor(on).framedAsync(g, {})).map((f: any) => decode(f.buf)))).sort();

  test('properties(name).value() reads the landed tree', async () => {
    expect(await vals(sg('.V().properties("name").value()')))
      .toEqual(await vals(`${crewBoth}.properties("name").value()`, 'crew'));
  });
  test('properties(name).key() reads the property key', async () => {
    expect(await vals(sg('.V().properties("name").key()')))
      .toEqual(await vals(`${crewBoth}.properties("name").key()`, 'crew'));
  });
  test('properties().value() over all keys', async () => {
    expect(await vals(sg('.V().properties().value()')))
      .toEqual(await vals(`${crewBoth}.properties().value()`, 'crew'));
  });
  test('properties(name).element().values(name) rebuilds the owner', async () => {
    expect(await vals(sg('.V().properties("name").element().values("name")')))
      .toEqual(await vals(`${crewBoth}.properties("name").element().values("name")`, 'crew'));
  });
  test('properties().id() fails closed (no landed VertexProperty identity)', async () => {
    await expect(mgr.executor('home').framedAsync(sg('.V().properties("name").id()'), {})).rejects.toThrow();
  });
});

describe('mogwai.graph.federate — SUBGRAPH within/3-arg-has/V(ids)', () => {
  const sg = (tail: string) =>
    `g.call("mogwai.graph.federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const vals = async (g: string) =>
    (await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec))).sort();

  test('has(key, within(varargs)) — membership over the bound value', async () => {
    expect(await vals(sg('.V().has("name", within("marko","gremlin")).values("name")'))).toEqual(['gremlin', 'marko']);
  });
  test('has(key, within([list])) — the array form', async () => {
    expect(await vals(sg('.V().has("name", within(["marko","stephen"])).values("name")'))).toEqual(['marko', 'stephen']);
  });
  test('has(label, key, value) — the 3-arg form (label AND key/value)', async () => {
    expect(await vals(sg('.V().has("person","name","marko").values("name")'))).toEqual(['marko']);
    expect(await vals(sg('.V().has("software","name","marko").values("name")'))).toEqual([]);
  });
  test('V(id) filters the bound vertices by id', async () => {
    const ids = (await Promise.all((await mgr.executor('home').framedAsync(sg('.V().id()'), {})).map(dec))).map((x: any) => Number(x)).sort((a, b) => a - b);
    const first = await vals(sg(`.V(${ids[0]}).values("name")`));
    expect(first.length).toBe(1);
  });
});
