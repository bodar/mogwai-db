import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { MAX_FEDERATION_DEPTH, guardFederationDepth } from '../src/services/params/federation-depth.ts';
import { createFederateService } from '../src/services/catalog/federate.ts';
import { ENDPOINT_IDS_KEY } from '../src/compiler/ir/injection.ts';
import { decode } from './support/decode.ts';
import { parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { pushableTailPrefix } from '../src/compiler/ir/content-demand.ts';

// A federate `traversal` param, built the SAME way production does — parse the sub-traversal string to
// IRStep[] and wrap as a TraversalParam — so a hand-wired spy CallSite can never drift from the shape
// `parseCallSpec` actually produces (a string is NOT the param shape; the steps are).
const subTraversal = (gremlin: string) => ({ kind: 'traversal' as const, steps: stepChain(parseGremlin(gremlin), {}) });

// End-to-end federation on the REAL stack: two graphs owned by one BunGraphManager, one
// federating into the other via federate — the real service, real env, real depth
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

describe('federate — source form, real stack', () => {
  test('g.call(federate) runs a sub-traversal on the sibling and returns its vertices detached', async () => {
    // crew graph vertices, fetched from `home` via federation.
    const fed = await runNames('g.call("federate").with("graph", "crew").with("traversal", __.V())');
    const direct = await runNames('g.V()'); // crew, queried directly, for the expected set
    const directCrew = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V()', {})).map(dec)));
    expect(fed).toEqual(directCrew);
    expect(fed).not.toEqual(direct); // it really came from crew, not home
  });

  test('a MAP-TERMINAL sibling (group/groupCount/project) returns its map, not an error', async () => {
    // Regression: the mapValues rewrite's `out.kind === 'map'` guard once conflated a USER's map terminal
    // with the internal mapValues injection result and threw. A source-form sibling ending in a map step
    // must FRAME its map and return it (pre-rewrite behaviour restored).
    const grp = await Promise.all((await mgr.executor('home').framedAsync('g.call("federate").with("graph","crew").with("traversal", __.V().group().by(T.label).by(__.count()))', {})).map(dec));
    expect(grp.length).toBe(1);
    expect(Object.fromEntries(grp[0] as Map<string, unknown>)).toEqual({ person: 4, software: 2 });
    const proj = await Promise.all((await mgr.executor('home').framedAsync('g.call("federate").with("graph","crew").with("traversal", __.V().hasLabel("person").limit(1).project("n").by("name"))', {})).map(dec));
    expect(proj.length).toBe(1);
    expect(Object.fromEntries(proj[0] as Map<string, unknown>)).toHaveProperty('n');
  });

  test('a nested __.V().has(...) sub-traversal is pushed down and filtered on the sibling', async () => {
    const fed = await runNames('g.call("federate").with("graph", "crew").with("traversal", __.V().hasLabel("person"))');
    const expected = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec)));
    expect(fed).toEqual(expected);
    expect(fed.length).toBeGreaterThan(0);
  });

  test('a read tail runs LOCALLY over the detached results (values over landed props)', async () => {
    const vals = await Promise.all((await mgr.executor('home').framedAsync('g.call("federate").with("graph", "crew").with("traversal", __.V().hasLabel("person")).values("name")', {})).map(dec));
    const expected = names(await Promise.all((await mgr.executor('crew').framedAsync('g.V().hasLabel("person")', {})).map(dec)));
    expect(vals.sort()).toEqual(expected);
  });

  test('federating to an empty/absent sibling graph yields no rows (create-on-demand, empty)', async () => {
    const fed = await runNames('g.call("federate").with("graph", "never-seeded").with("traversal", __.V())');
    expect(fed).toEqual([]);
  });
});

// WIN 2a — the ERGONOMIC ARG-LESS form. No `traversal` arg: federate to a graph, then keep traversing,
// and the compiler INFERS what runs on the sibling (`pushableTailPrefix`) vs locally. The pushable
// prefix's own source text is synthesized into the sibling query; the suffix resumes locally. Oracle:
// the SAME traversal run directly on crew.
describe('federate — arg-less pushdown (win 2a)', () => {
  const argless = (tail: string) => `g.call("federate").with("graph", "crew")${tail}`;
  const onCrew = async (g: string) =>
    (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec)));

  test('arg-less .V() pushes the whole element traversal to the sibling', async () => {
    expect(await runNames(argless('.V().hasLabel("person")')))
      .toEqual(names(await onCrew('g.V().hasLabel("person")')));
  });

  test('a REDUCER pushes and returns a scalar (federate(crew).V().count())', async () => {
    const got = Number((await Promise.all((await mgr.executor('home').framedAsync(argless('.V().count()'), {})).map(dec)))[0]);
    const crew = Number((await onCrew('g.V().count()'))[0]);
    expect(got).toBe(crew);
    expect(got).toBeGreaterThan(0);
  });

  test('a scalar reduction over an EMPTY stream yields nothing (sum/min/mean), matching TinkerPop', async () => {
    // crew persons carry no `age`, so values('age') is empty. sum/min/max/mean over empty emit NOTHING
    // (SumGlobalStep guards processAllStarts — no seed), NOT null/0. Must match direct-on-crew ([]).
    for (const red of ['sum', 'min', 'max', 'mean']) {
      const vals = async (m: string, g: string) => (await Promise.all((await mgr.executor(m).framedAsync(g, {})).map(dec)));
      expect(await vals('home', argless(`.V().values("age").${red}()`)))
        .toEqual(await vals('crew', `g.V().values("age").${red}()`));   // both []
    }
  });

  test('count over an EMPTY stream is 0 (seeded), NOT dropped — the count/sum asymmetry', async () => {
    const got = Number((await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("nope").count()'), {})).map(dec)))[0]);
    expect(got).toBe(0);   // CountGlobalStep seeds 0L; empty count is a real 0, unlike sum/min/max
  });

  test('the out().dedup().count() case pushes WHOLE and is correct (structural 5-vs-2 fix)', async () => {
    const got = Number((await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("person").out("knows").dedup().count()'), {})).map(dec)))[0]);
    const crew = Number((await onCrew('g.V().hasLabel("person").out("knows").dedup().count()'))[0]);
    expect(got).toBe(crew);
  });

  test('a bound param in a pushed step resolves on the sibling', async () => {
    const q = argless('.V().has("name", within(nm)).count()');
    const got = Number((await Promise.all((await mgr.executor('home').framedAsync(q, { nm: ['marko', 'stephen'] })).map(dec)))[0]);
    const crew = Number((await onCrew("g.V().has('name', within('marko','stephen')).count()"))[0]);
    expect(got).toBe(crew);
  });

  test('sum() over a property pushes and returns a typed scalar', async () => {
    // crew persons carry no age; use a property crew has. Oracle against crew directly either way.
    const q = argless('.V().hasLabel("person").values("name").count()');
    const got = Number((await Promise.all((await mgr.executor('home').framedAsync(q, {})).map(dec)))[0]);
    const crew = Number((await onCrew('g.V().hasLabel("person").values("name").count()'))[0]);
    expect(got).toBe(crew);
  });

  test('a cap() reading a PRE-BARRIER collection stays LOCAL — not pushed to the sibling (wrong graph)', () => {
    // `aggregate("x")` accumulates on the PARENT before the barrier; `cap("x")` reads THAT collection, which
    // the sibling never saw. Pushing it would run `g.V().cap("x")` on the sibling against an undefined
    // collection. The boundary must end the pushable prefix at the cap: only `.V()` pushes, the cap stays
    // local. (End-to-end it then fails closed as "cap() unsupported after a barrier" — the RIGHT reason,
    // local: the collection lives on the PARENT and no resume can reach it; the point here is it is not
    // shipped to the sibling. A SELF-CONTAINED cap within the prefix DOES push and frame — see below.)
    const q = 'g.V().aggregate("x").call("federate", ["graph":"crew"]).V().cap("x")';
    const steps = stepChain(parseGremlin(q), {});
    const at = steps.findIndex((s) => s.name === 'call');
    const p = pushableTailPrefix(steps, at, {});
    expect(steps.slice(at + 1, at + 1 + p.length).map((s) => s.name)).toEqual(['V']);   // cap NOT pushed
  });

  test('a SELF-CONTAINED aggregate("a").cap("a") within the prefix is unaffected (the key is written there)', () => {
    // The cap reads a collection written WITHIN the prefix, so it is self-contained — the guard does not
    // fire (the key is in the "written within the prefix" set), and the whole side-effect pushes.
    const q = 'g.call("federate", ["graph":"crew"]).V().aggregate("a").cap("a").unfold()';
    const steps = stepChain(parseGremlin(q), {});
    const at = steps.findIndex((s) => s.name === 'call');
    const p = pushableTailPrefix(steps, at, {});
    expect(steps.slice(at + 1, at + 1 + p.length).map((s) => s.name)).toEqual(['V', 'aggregate', 'cap', 'unfold']);
  });

  // Pushed-collection OUTPUT framing (open item 1): a self-contained collection push that ends in a VALUE
  // stream frames end-to-end. The whole tail runs on the sibling and the N values cross back as typed
  // nodes, each re-emitted as its own traverser — oracled against the SAME traversal run directly on crew.
  test('a self-contained aggregate.cap.unfold.values() STREAM frames end-to-end (== direct on crew)', async () => {
    const tail = '.V().hasLabel("person").aggregate("a").cap("a").unfold().values("name")';
    const got = (await Promise.all((await mgr.executor('home').framedAsync(argless(tail), {})).map(dec))).sort();
    const crew = (await onCrew(`g${tail}`)).sort();
    expect(got).toEqual(crew);
    expect(got.length).toBeGreaterThan(0);   // really ran (not an empty pass)
  });

  test('a pushed values() STREAM frames each value as its own traverser (== direct on crew)', async () => {
    const got = (await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("person").values("name")'), {})).map(dec))).sort();
    expect(got).toEqual((await onCrew('g.V().hasLabel("person").values("name")')).sort());
  });

  test('a pushed fold() OF ELEMENTS returns ONE list of detached vertices (== direct on crew)', async () => {
    const got = await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("person").fold()'), {})).map(dec));
    const crew = await onCrew('g.V().hasLabel("person").fold()');
    // ONE traverser, a list; the members are detached vertices, compared by name (id spaces differ across graphs).
    expect(got.length).toBe(1);
    expect(names(got[0] as any[])).toEqual(names(crew[0] as any[]));
  });

  test('a pushed values().fold() returns ONE list of scalars (== direct on crew)', async () => {
    const got = await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("person").values("name").fold()'), {})).map(dec));
    const crew = await onCrew('g.V().hasLabel("person").values("name").fold()');
    expect(got.length).toBe(1);
    expect((got[0] as any[]).sort()).toEqual((crew[0] as any[]).sort());
  });

  test('an EMPTY value stream is NO traversers; an EMPTY fold is ONE empty list', async () => {
    // A value STREAM over no elements yields nothing (`Values` refuses the empty relation → a Filter(false),
    // the same empty spelling the scalar resume takes). A `fold()` over no elements is still ONE traverser,
    // the empty list — the fold's own identity, unchanged by federation.
    const emptyStream = await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("nope").values("name")'), {})).map(dec));
    expect(emptyStream).toEqual([]);
    const emptyFold = await Promise.all((await mgr.executor('home').framedAsync(argless('.V().hasLabel("nope").fold()'), {})).map(dec));
    expect(emptyFold).toEqual([[]]);
  });
});


describe('federate — standard as()/select() MID injection', () => {
  const argless =
    'g.V().hasLabel("person").values("name").as("e").call("federate", ["graph":"crew"]).V().has("name", select("e"))';
  const explicit =
    'g.V().hasLabel("person").values("name").as("e").call("federate", ["graph":"crew", "traversal": __.V().has("name", select("e"))])';

  test('arg-less and explicit forms inject the pre-barrier alias into the sibling select operand', async () => {
    expect(await runNames(argless)).toEqual(['marko']);
    expect(await runNames(explicit)).toEqual(await runNames(argless));
  });

  test('a parent with no sibling match drops from the flatMap result', async () => {
    const result = await Promise.all((await mgr.executor('home').framedAsync(argless, {})).map(dec));
    expect(result).toHaveLength(1);
  });

  test('a folded alias uses the user-authored within membership predicate', async () => {
    const query = 'g.V().hasLabel("person").values("name").fold().as("e").call("federate", ["graph":"crew"]).V().has("name", within(select("e")))';
    expect(await runNames(query)).toEqual(['marko']);
  });

  test('a multi-valued alias matches by membership rather than list equality', async () => {
    const multi = new BunGraphManager(undefined, extendedRegistry);
    for (const g of MODERN_SEED) await multi.executor('home').framedAsync(g, {});
    for (const g of CREW_SEED) await multi.executor('crew').framedAsync(g, {});
    await multi.executor('home').framedAsync('g.V().has("name","marko").property(Cardinality.list,"name","not-a-crew-name")', {});
    try {
      const query = 'g.V().hasLabel("person").has("name","not-a-crew-name").values("name").fold().as("e").call("federate", ["graph":"crew"]).V().has("name", within(select("e")))';
      const result = await Promise.all((await multi.executor('home').framedAsync(query, {})).map(dec));
      expect(names(result)).toEqual(['marko']);
    } finally {
      await multi.executor('home').framedAsync('g.V().has("name","not-a-crew-name").properties("name").drop()', {});
    }
  });

  test('an id alias can be injected arg-less', async () => {
    const query = 'g.V().hasLabel("person").id().as("e").call("federate", ["graph":"crew"]).V().has(T.id, select("e"))';
    const result = await Promise.all((await mgr.executor('home').framedAsync(query, {})).map(dec));
    expect(Array.isArray(result)).toBe(true);
  });

  test('the standard spelling preserves distinct parents carrying the same injected value', async () => {
    const two = new BunGraphManager(undefined, extendedRegistry);
    for (const g of ['g.addV("person").property("name","marko")', 'g.addV("person").property("name","marko")', 'g.addV("person").property("name","vadas")'])
      await two.executor('home').framedAsync(g, {});
    for (const g of CREW_SEED) await two.executor('crew').framedAsync(g, {});
    const result = await Promise.all((await two.executor('home').framedAsync(argless, {})).map(dec));
    expect(result.length).toBe(2);
  });

  test('a mapValues count reduces each parent key before the global combine', async () => {
    const two = new BunGraphManager(undefined, extendedRegistry);
    for (const g of ['g.addV("person").property("name","marko")', 'g.addV("person").property("name","marko")', 'g.addV("person").property("name","vadas")'])
      await two.executor('home').framedAsync(g, {});
    for (const g of CREW_SEED) await two.executor('crew').framedAsync(g, {});
    const query = `${argless}.count()`;
    const result = await Promise.all((await two.executor('home').framedAsync(query, {})).map(dec));
    expect(result.map(Number)).toEqual([2]); // two distinct parent keys, each with crew marko once
  });

  test('mapValues count pushdown equals the element-scatter authority', async () => {
    const pushed = new BunGraphManager(undefined, extendedRegistry);
    const local = new BunGraphManager(undefined, extendedRegistry);
    for (const graph of [pushed, local]) {
      for (const g of MODERN_SEED) await graph.executor('home').framedAsync(g, {});
      for (const g of CREW_SEED) await graph.executor('crew').framedAsync(g, {});
    }
    const query = `${argless}.count()`;
    const read = async (graph: BunGraphManager) =>
      (await Promise.all((await graph.executor('home').framedAsync(query, {})).map(dec))).map(Number);
    expect(await read(pushed)).toEqual(await read(local));
  });

  test('mapValues reducer empties follow the declared monoid/semigroup algebra', async () => {
    const empty = new BunGraphManager(undefined, extendedRegistry);
    await empty.executor('home').framedAsync('g.addV("person").property("name","nobody")', {});
    for (const g of CREW_SEED) await empty.executor('crew').framedAsync(g, {});
    const head = 'g.V().values("name").as("e").call("federate", ["graph":"crew", "traversal": __.V().has("name", select("e"))])';
    const count = await Promise.all((await empty.executor('home').framedAsync(`${head}.count()`, {})).map(dec));
    expect(count.map(Number)).toEqual([0]);
    const sumHead = 'g.V().values("name").as("e").call("federate", ["graph":"crew", "traversal": __.V().has("name", select("e")).values("missing")])';
    const sum = await Promise.all((await empty.executor('home').framedAsync(`${sumHead}.sum()`, {})).map(dec));
    expect(sum).toEqual([]);
  });

  test('mapValues batches the alias values under one ordinary bound Map', async () => {
    let calls = 0; let gremlin = ''; let bound: unknown;
    const contribution: any = createFederateService({
      executor: () => ({
        runForeign: (g: string, params: Record<string, unknown>) => {
          calls++; gremlin = g; bound = params.injectedMap;
          return Promise.resolve({ kind: 'map', value: { t: 'map', v: [] } });
        },
      }),
    } as any).resolve({
      params: { graph: 'crew', traversal: subTraversal('g.V().has("name", select("e"))') },
      boundParams: {}, federationDepth: 0,
      mapValues: { param: 'injectedMap', label: 'e' },
    });
    await contribution.apply([
      { kind: 'vertex', id: 1, label: 'person', labels: ['person'], props: {}, injectedValue: 'marko' },
      { kind: 'vertex', id: 2, label: 'person', labels: ['person'], props: {}, injectedValue: 'marko' },
    ]);
    expect(calls).toBe(1);
    expect(gremlin).toBe('g.inject(injectedMap).unfold().group().by(Column.keys).by(__.V().has("name",select(Column.values)))');
    expect(bound).toEqual(new Map([['0', 'marko'], ['1', 'marko']]));
  });

  test('mapValues places a bare reducer inside the group value traversal', async () => {
    let gremlin = '';
    const contribution: any = createFederateService({
      executor: () => ({
        runForeign: (g: string) => {
          gremlin = g;
          return Promise.resolve({ kind: 'map', value: { t: 'map', v: [] } });
        },
      }),
    } as any).resolve({
      params: { graph: 'crew', traversal: subTraversal('g.V().has("name", select("e"))') },
      boundParams: {}, federationDepth: 0,
      mapValues: { param: 'injectedMap', label: 'e', reduce: { partial: 'count', combine: 'sum', empty: 'zero' } },
    });
    const result = await contribution.apply([
      { kind: 'vertex', id: 1, label: 'person', labels: ['person'], props: {}, injectedValue: 'marko' },
    ]);
    expect(gremlin).toBe('g.inject(injectedMap).unfold().group().by(Column.keys).by(__.V().has("name",select(Column.values)).count())');
    expect(result.kind).toBe('barrier-scalar');
  });
});


// A MID federate whose sub-traversal is CONSTANT (no `parent` marker) and ends in a VALUE terminal: the
// sibling runs ONCE and each of the P parents re-emits the whole pool — a CROSS scatter (P×N), the
// value-stream analogue of the element rejoin's no-injection cross. (An INJECTED value terminal caps the
// pushed prefix at the marker, so it stays local and comes back through the element rejoin — covered above.)
describe('federate — MID constant sub-traversal returning a VALUE stream (cross scatter)', () => {
  const decAll = async (m: string, g: string) => (await Promise.all((await mgr.executor(m).framedAsync(g, {})).map(dec)));
  const P = async () => (await decAll('home', 'g.V().hasLabel("person").count()')).map(Number)[0];

  test('each parent re-emits the whole value pool (P×N), both arg-less and explicit forms', async () => {
    const p = await P();
    const crewNames = await decAll('crew', 'g.V().hasLabel("person").values("name")');
    for (const q of [
      'g.V().hasLabel("person").call("federate",["graph":"crew"]).V().hasLabel("person").values("name")',
      'g.V().hasLabel("person").call("federate",["graph":"crew","traversal":__.V().hasLabel("person").values("name")])',
    ]) {
      const got = await decAll('home', q);
      expect(got.length).toBe(p * crewNames.length);   // flatMap: P parents × N crew names
      expect([...new Set(got)].sort()).toEqual([...new Set(crewNames)].sort());   // the same value set, repeated
    }
  });

  test('a constant fold() gives each parent ONE list (P traversers, each the whole list)', async () => {
    const p = await P();
    const crewNames = await decAll('crew', 'g.V().hasLabel("person").values("name")');
    const got = await decAll('home', 'g.V().hasLabel("person").call("federate",["graph":"crew","traversal":__.V().hasLabel("person").values("name").fold()])');
    expect(got.length).toBe(p);                        // one list per parent
    expect((got[0] as any[]).sort()).toEqual(crewNames.sort());
  });

  test('NO parents (empty head) → NO traversers (P=0)', async () => {
    const got = await decAll('home', 'g.V().hasLabel("nope").call("federate",["graph":"crew","traversal":__.V().values("name")])');
    expect(got).toEqual([]);
  });
});

describe('federation fails closed', () => {
  const onCrew = async (g: string) => (await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec)));
  test('a missing graph param throws', async () => {
    await expect(mgr.executor('home').framedAsync('g.call("federate").with("traversal", __.V())', {}))
      .rejects.toThrow(/"graph" param/);
  });

  test('an unrooted sub-traversal throws at compile (must be source-rooted)', async () => {
    await expect(mgr.executor('home').framedAsync('g.call("federate").with("graph","crew").with("traversal", __.out())', {}))
      .rejects.toThrow(/source-rooted/);
  });

  test('an EXPLICIT scalar/value sub-traversal frames end-to-end (== direct on crew)', async () => {
    // The explicit `traversal` form now shares the pushed-terminal output framing: a sub-traversal that ends
    // in a VALUE (a reducer scalar or a `values(k)` stream) crosses back on the typed-node transport and
    // frames, rather than being rejected by the old element-only path. `runForeign` classifies the sibling
    // shape AUTHORITATIVELY, so the explicit form needs no pushdown to reach a value result.
    const cnt = (await Promise.all((await mgr.executor('home').framedAsync('g.call("federate").with("graph","crew").with("traversal", __.V().count())', {})).map(dec)));
    expect(cnt.map(Number)).toEqual((await onCrew('g.V().count()')).map(Number));   // a reduced scalar
    const nms = (await Promise.all((await mgr.executor('home').framedAsync('g.call("federate").with("graph","crew").with("traversal", __.V().hasLabel("person").values("name"))', {})).map(dec))).sort();
    expect(nms).toEqual((await onCrew('g.V().hasLabel("person").values("name")')).sort());   // a value stream
  });
});

describe('recursive federation + depth guard', () => {
  // One hop (depth 1) against a real sibling works — a self-federate to 'home' whose body is a
  // plain g.V() is a single non-recursive hop, so it resolves.
  test('a single federated hop resolves (depth 1, no recursion)', async () => {
    const selfFed = 'g.call("federate").with("graph","home").with("traversal", __.V())';
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
describe('federate — SUBGRAPH form (traverse a fetched subgraph locally)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
      'g.call("federate").with("graph", "crew").with("traversal", __.V().hasLabel("person").outE("develops")).inV().values("name")', {}))
      .rejects.toThrow(/not supported after a barrier call/);
  });

  test('the endpoint hop crosses ids as ONE bound param — NOT inline in the sibling Gremlin text', async () => {
    // Spy the second sibling hop (withEndpoints): the distinct endpoint ids must travel under
    // ENDPOINT_IDS_KEY (a bound collection the sibling explodes via json_each), and the id set must
    // NEVER be string-interpolated into the sibling's statement — the data-not-in-text rule, applied
    // across the wire, for ANY subgraph size (see federate.ts withEndpoints / source.ts elementScan).
    const hops: Array<{ gremlin: string; params: Record<string, any> }> = [];
    const edge = (id: number, src: number, tgt: number) =>
      ({ kind: 'edge' as const, id, label: 'develops', src, tgt, props: {}, ordinal: id });
    const spySource: any = {
      executor: () => ({
        runForeign: (gremlin: string, params: Record<string, any>) => {
          hops.push({ gremlin, params });
          // First hop = the edge-producing sub-traversal; second = the endpoint fetch.
          return Promise.resolve({ kind: 'elements', rows: hops.length === 1 ? [edge(10, 1, 2), edge(11, 2, 3)] : [] });
        },
      }),
    };
    const contribution: any = createFederateService(spySource).resolve({
      params: { graph: 'crew', subgraph: true, traversal: subTraversal('g.V().hasLabel("person").outE("develops")') },
      federationDepth: 0,
    } as any);
    await contribution.apply([]); // source form → run sub-traversal once, then fetch endpoints
    expect(hops.length).toBe(2);
    const endpointHop = hops[1];
    // distinct endpoints of edges (1→2),(2→3) = {1,2,3}, crossing as ONE bound-collection param.
    expect([...endpointHop.params[ENDPOINT_IDS_KEY]].sort()).toEqual([1, 2, 3]);
    expect(endpointHop.gremlin).toBe(`g.V(${ENDPOINT_IDS_KEY})`);
    expect(endpointHop.gremlin).not.toMatch(/\d/); // no id digits baked into the statement text
  });

  test('PUSHDOWN: a tail that does not reach endpoints SKIPS the endpoint hop (one sibling call)', async () => {
    // The endpoint fetch is gated on the call-site tailDemand (ContentDemand): a reducing/edges-only tail
    // (reachesAdjacency:false) skips the second hop entirely. Same spy, but resolve() now carries a demand.
    let rawCalls = 0;
    const spySource: any = {
      executor: () => ({
        runForeign: () => { rawCalls++; return Promise.resolve({ kind: 'elements', rows: [{ kind: 'edge', id: 10, label: 'develops', src: 1, tgt: 2, props: {}, ordinal: 10 }] }); },
      }),
    };
    const contribution: any = createFederateService(spySource).resolve({
      params: { graph: 'crew', subgraph: true, traversal: subTraversal('g.V().hasLabel("person").outE("develops")') },
      federationDepth: 0,
      tailDemand: { reachesElements: false, reachesAdjacency: false, keys: new Set(), handoffDenied: false },
    } as any);
    await contribution.apply([]);
    expect(rawCalls).toBe(1); // ONLY the sub-traversal hop — no endpoint fetch
  });

  test('PUSHDOWN: a tail that DOES reach endpoints still fetches them (two sibling calls)', async () => {
    let rawCalls = 0;
    const spySource: any = {
      executor: () => ({
        runForeign: () => { rawCalls++; return Promise.resolve({ kind: 'elements', rows: rawCalls === 1 ? [{ kind: 'edge', id: 10, label: 'develops', src: 1, tgt: 2, props: {}, ordinal: 10 }] : [] }); },
      }),
    };
    const contribution: any = createFederateService(spySource).resolve({
      params: { graph: 'crew', subgraph: true, traversal: subTraversal('g.V().hasLabel("person").outE("develops")') },
      federationDepth: 0,
      tailDemand: { reachesElements: true, reachesAdjacency: true, keys: 'all', handoffDenied: false },
    } as any);
    await contribution.apply([]);
    expect(rawCalls).toBe(2); // sub-traversal + endpoint fetch
  });
});

// SUBGRAPH re-source (TinkerPop's sg.traversal()): `.V()`/`.E()` root a fresh traversal at the fetched
// subgraph, and out/in/both walk the bound edges to the bound vertices — vertex→vertex movement over a
// bound edge Ref. The oracle is always the SAME traversal run directly on the sibling.
describe('federate — SUBGRAPH re-source and vertex→vertex movement', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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

// path() over a bound subgraph: the PATH channel is seeded at the bound source (position 0 = the
// re-source vertex), EXTENDED at each hop (shared `movement`), and each position is REJOINED by id
// through `source.elementNode` (Mechanism B, the leaf's per-position twin) — no base-table read. A
// re-source `.V()` starts a FRESH path (`sg.traversal().V()` discards the stream), so a multi-hop walk
// over the subgraph is structurally identical to the same walk run directly on the sibling.
describe('federate — SUBGRAPH path() (id-carry positions rejoined)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const nameOf = (o: any) => o?.properties?.find((p: any) => p.label === 'name')?.value;
  const pathNames = (p: any) => (p.objects ?? []).map(nameOf);
  const paths = async (g: string, exec = 'home') =>
    (await Promise.all((await mgr.executor(exec).framedAsync(g, {})).map(dec)))
      .map(pathNames)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  test('.V().out("develops").path() — [developer, software] per develops edge, rejoined', async () => {
    const got = await paths(sg('.V().out("develops").path()'));
    expect(got).toEqual(await paths('g.V().out("develops").path()', 'crew'));
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => p.length === 2)).toBe(true); // two rejoined positions per path
  });
  test('.V().out("develops").in("develops").path() — 3 rejoined positions over multi-hop', async () => {
    expect(await paths(sg('.V().out("develops").in("develops").path()')))
      .toEqual(await paths('g.V().out("develops").in("develops").path()', 'crew'));
  });
});

// has()/hasLabel() FILTER subgraph vertices against their landed {t,v} property tree / label array —
// an EXISTS over the exploded json (multi-valued membership), so they compose anywhere a vertex is on
// the bound stream: after .V() and after a movement hop alike.
describe('federate — SUBGRAPH has()/hasLabel filters', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
describe('federate — count()/dedup() over the landed stream', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
    const crewCount = await one('g.call("federate").with("graph", "crew").with("traversal", __.V()).count()');
    const direct = Number((await Promise.all((await mgr.executor('crew').framedAsync('g.V().count()', {})).map(dec)))[0]);
    expect(crewCount).toBe(direct);
  });
});

// ELEMENT-TERMINAL subgraph traversals — the chain ends on a bound element, so the WHOLE vertex/edge
// (id, label, property bag) crosses to the wire. This is the leaf-framing path (a bound element frames
// through the landed payload), distinct from the scalar-terminal cases above that end in values()/id()/
// count(). The oracle is the SAME endpoint traversal run directly on the sibling — compared on the
// framed name properties AND the labels, so the whole element round-trips, not just a projected value.
describe('federate — SUBGRAPH element-terminal (whole vertices to the wire)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
describe('federate — SUBGRAPH labels() fan-out', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
describe('federate — SUBGRAPH aggregation (group/order/project via the main fold)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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

// A whole bound ELEMENT embedded as a MEMBER — a list member (fold), a group VALUE (by(fold())), or a
// project() record field (by(identity())). Each rejoins the landed relation through `source.elementNode`
// (Mechanism B's per-member twin); before it was source-routed these hit the LOCAL base tables against a
// foreign id and CRASHED (`TypeError: null is not an object`). Oracle: the same traversal on crew,
// compared on each embedded vertex's label:name (element identity round-trips; list order may differ
// between the landed array order and crew's native order, so the member SET is the invariant).
describe('federate — SUBGRAPH element as a MEMBER (list / group value / project field)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
  const crewBoth = 'g.V().hasLabel("person").outE("develops").bothV().dedup()';
  const one = async (g: string, on: 'home' | 'crew' = 'home') => dec((await mgr.executor(on).framedAsync(g, {}))[0]!);
  const isVertex = (x: any) => x && typeof x === 'object' && x.label !== undefined && Array.isArray(x.properties);
  // Every vertex nested anywhere in a decoded value, as sorted `label:name` — walks Maps, arrays, objects.
  const nl = (v: any): string[] => {
    const out: string[] = [];
    const walk = (x: any): void => {
      if (isVertex(x)) out.push(`${x.label}:${x.properties.find((p: any) => p.label === 'name')?.value ?? ''}`);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x instanceof Map) x.forEach(walk);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    walk(v);
    return out.sort();
  };
  // A decoded group Map → { key: sorted label:name of its value } — pins per-key membership, not just the union.
  const groupNL = (m: any): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    (m as Map<any, any>).forEach((val, key) => { out[String(key)] = nl(val); });
    return out;
  };

  test('.V().fold() — whole bound vertices collected as a list', async () => {
    expect(nl(await one(sg('.V().fold()')))).toEqual(nl(await one(`${crewBoth}.fold()`, 'crew')));
  });
  test('group().by(T.label).by(__.fold()) — element-valued groups (whole vertices per label)', async () => {
    expect(groupNL(await one(sg('.V().group().by(T.label).by(__.fold())'))))
      .toEqual(groupNL(await one(`${crewBoth}.group().by(T.label).by(__.fold())`, 'crew')));
  });
  test('project(v).by(__.identity()) — a whole bound element as a record field', async () => {
    const got = await Promise.all((await mgr.executor('home').framedAsync(sg('.V().project("v").by(__.identity())'), {})).map(dec));
    const exp = await Promise.all((await mgr.executor('crew').framedAsync(`${crewBoth}.project("v").by(__.identity())`, {})).map(dec));
    expect(nl(got)).toEqual(nl(exp));
  });
});

// Richer subgraph vertex selection: has(key, within(...)), the 3-arg has(label, key, value), and
// V(ids)/E(ids) filtering the bound source by id.
// valueMap()/elementMap() over a bound subgraph — the per-key value arrays read from the landed {t,v}
// tree (source.valueMapPairs), the map/token shaping shared with the base graph. Oracled on crew.
describe('federate — SUBGRAPH valueMap()/elementMap()', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
  // The id/label TOKENS (and an edge's IN/OUT endpoint entries) route through GraphSource now
  // (externalId/labelScalar/labelArray/elementRow), so valueMap(true)/elementMap() compose over the
  // landed relation exactly as valueMap(keys…) does. The landed id IS the crew id, so maps match.
  test('valueMap(true, name) — id/label tokens beside the property array, rejoined', async () => {
    const got = await maps(sg('.V().order().by("name").valueMap(true, "name")'));
    expect(got).toEqual(await maps(`${crewBoth}.order().by("name").valueMap(true, "name")`, 'crew'));
    expect(got.length).toBeGreaterThan(0);
  });
  test('elementMap(name) — flat map with id/label tokens over bound vertices', async () => {
    expect(await maps(sg('.V().order().by("name").elementMap("name")')))
      .toEqual(await maps(`${crewBoth}.order().by("name").elementMap("name")`, 'crew'));
  });
  test('elementMap() on the bound EDGES — IN/OUT endpoint entries rejoin the landed vertices', async () => {
    expect(await maps(sg('.elementMap()')))
      .toEqual(await maps('g.V().hasLabel("person").outE("develops").elementMap()', 'crew'));
  });
  test('valueMap(name) composes after a movement hop', async () => {
    expect(await maps(sg('.inV().valueMap("name")')))
      .toEqual(await maps(`g.V().hasLabel("person").outE("develops").inV().valueMap("name")`, 'crew'));
  });
});

// properties() over a bound subgraph — the property STREAM exploded from the landed {t,v,vpid,meta}
// tree (source.propertyStream), with value()/key()/id()/terminal framing. The DETACHED compile lands
// each property's own id (vpid) and its meta-properties, so .id() and meta-property framing now match
// the source graph rather than failing closed. Oracled on crew.
describe('federate — SUBGRAPH properties() stream', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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
  test('properties(name).id() reads the landed VertexProperty id (vpid)', async () => {
    expect(await vals(sg('.V().properties("name").id()')))
      .toEqual(await vals(`${crewBoth}.properties("name").id()`, 'crew'));
  });
  test('properties(location) carries meta-properties (startTime/endTime) through the landed tree', async () => {
    // `location` is the crew's meta-property showcase; the landed node carries `meta`, so the bound
    // VertexProperty stream frames the same values AND meta-properties as the source graph.
    expect(await vals(sg('.V().properties("location").value()')))
      .toEqual(await vals(`${crewBoth}.properties("location").value()`, 'crew'));
    expect(await vals(sg('.V().properties("location")')))
      .toEqual(await vals(`${crewBoth}.properties("location")`, 'crew'));
  });
});

describe('federate — SUBGRAPH within/3-arg-has/V(ids)', () => {
  const sg = (tail: string) =>
    `g.call("federate").with("graph", "crew").with("subgraph", true).with("traversal", __.V().hasLabel("person").outE("develops"))${tail}`;
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

describe('federate — bound-EDGE has(key) presence', () => {
  // Bound-EDGE has(key) / has(key, value) matches exactly the edges that carry the key, over the bound
  // graph, identical to the source. develops edges carry `since`, uses edges carry `skill` (crew fixture).
  // (The correlated `hasPropertyPredicate` edge branch stays fail-closed correct — `IS NOT NULL`, not the
  // always-false `!= NULL` — even though the main edge-has path is the `boundPropertyRelation` join.)
  const fedN = async (trav: string) =>
    Number((await Promise.all((await mgr.executor('home').framedAsync(`g.call("federate").with("graph","crew").with("traversal", ${trav})`, {})).map(dec)))[0]);
  const crewN = async (g: string) =>
    Number((await Promise.all((await mgr.executor('crew').framedAsync(g, {})).map(dec)))[0]);

  test('E().has(key) matches the edges that HAVE the key', async () => {
    const expected = await crewN('g.E().has("since").count()');
    expect(expected).toBeGreaterThan(0); // sanity: the crew graph really has such edges
    expect(await fedN('__.E().has("since").count()')).toBe(expected);
  });

  test('E().has(key, value) filters by the bound value', async () => {
    const expected = await crewN('g.E().has("since", gt(2010)).count()');
    expect(expected).toBeGreaterThan(0);
    expect(await fedN('__.E().has("since", gt(2010)).count()')).toBe(expected);
  });
});

// MULTI-GRAPH MERGE — a federate barrier NESTED in a `union` arm (`nestedBranchSegment`, segment.ts).
// Each arm's sibling graph runs its own RPC and LANDS as its own bound relation; the arms merge, and the
// linear trampoline drives the sibling calls in turn (N arms → N segments → N bound CTEs before the SQL
// merge). Phase 1 is fail-closed on what needs a later phase: the post-merge tail must be a CARDINALITY
// tail (count/limit), because materializing merged elements needs the graph-tagged unified relation and
// dedup/group across graphs needs the graph discriminator. The oracle is the arms run directly + summed.
describe('federate — nested in union arms (multi-graph merge)', () => {
  const count = async (g: string) =>
    Number((await Promise.all((await mgr.executor('home').framedAsync(g, {})).map(dec)))[0]);
  const onGraph = async (graph: string, g: string) =>
    Number((await Promise.all((await mgr.executor(graph).framedAsync(g, {})).map(dec)))[0]);

  test('union of two DIFFERENT siblings, count() — each landed, then merged', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","home").V()).count()'))
      .toBe(crew + home);
  });

  test('bound arm + BASE arm merge (federate(crew).V() ∪ local V())', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.V()).count()')).toBe(crew + home);
  });

  test('per-arm-local suffix runs on each arm\'s OWN bound graph (hasLabel inside the arm)', async () => {
    const crewP = await onGraph('crew', 'g.V().hasLabel("person").count()');
    const homeP = await onGraph('home', 'g.V().hasLabel("person").count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V().hasLabel("person"), __.call("federate").with("graph","home").V().hasLabel("person")).count()'))
      .toBe(crewP + homeP);
  });

  test('explicit traversal arms frame and merge (with("traversal", __.V()))', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").with("traversal", __.V()), __.call("federate").with("graph","home").with("traversal", __.V())).count()'))
      .toBe(crew + home);
  });

  test('THREE sibling arms accumulate three bound graphs before the merge', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","home").V(), __.call("federate").with("graph","crew").V()).count()'))
      .toBe(crew + home + crew);
  });

  test('post-merge limit(n).count() bounds the merged stream', async () => {
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","home").V()).limit(3).count()')).toBe(3);
  });

  test('edge arms merge (E() ∪ E())', async () => {
    const crewE = await onGraph('crew', 'g.E().count()');
    const homeE = await onGraph('home', 'g.E().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").E(), __.call("federate").with("graph","home").E()).count()')).toBe(crewE + homeE);
  });

  // CROSS-GRAPH IDENTITY (Phase 2, the `graph` discriminator channel): dedup over the merged stream keeps
  // per-graph identity — A's id 5 and B's id 5 do NOT collapse — while a within-graph duplicate still does.
  test('dedup() across two DIFFERENT graphs keeps per-graph identity (no cross-graph collapse)', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    // crew and home ids overlap; without the discriminator this would collapse to ~max(crew,home).
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","home").V()).dedup().count()'))
      .toBe(crew + home);
  });
  test('dedup() within the SAME graph (both arms crew) still collapses duplicates', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","crew").V()).dedup().count()'))
      .toBe(crew);
  });
  test('dedup() across a bound graph + the BASE graph keeps both', async () => {
    const crew = await onGraph('crew', 'g.V().count()');
    const home = await onGraph('home', 'g.V().count()');
    expect(await count('g.union(__.call("federate").with("graph","crew").V(), __.V()).dedup().count()')).toBe(crew + home);
  });

  // FAIL CLOSED (still open until Phase 3): a post-merge tail that MATERIALIZES merged elements needs the
  // graph-tagged unified relation, so it must REFUSE — never misjoin against one graph.
  const merged2 = 'g.union(__.call("federate").with("graph","crew").V(), __.call("federate").with("graph","home").V())';
  test('post-merge values() over the merged stream refuses (needs the unified relation)', async () => {
    expect(mgr.executor('home').framedAsync(`${merged2}.values("name")`, {})).rejects.toThrow(/not supported/);
  });
  test('bare element return over the merged stream refuses (needs the unified relation)', async () => {
    expect(mgr.executor('home').framedAsync(merged2, {})).rejects.toThrow(/not supported/);
  });
});
