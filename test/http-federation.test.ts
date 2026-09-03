import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { decode } from './support/decode.ts';

// Federation OVER HTTP, end to end, ENTIRELY IN MEMORY — the point of modelling the transport as the
// `Http` seam `(Request)=>Promise<Response>`: the SERVER's own router handler IS the client's outbound
// transport, so a federated hop crosses no socket (docs/2026-09-02-…-plan.md §8). This is the real
// Phase 0 gate: a sub-traversal runs on a remote peer and its vertices/edges come back WITH typed
// properties, and — the critical barrier path — the mid-traversal `select()` correlation injects its
// bound `Map` through `inject($map)` across the wire.

const server = new BunGraphManager(undefined, extendedRegistry);
const serverHttp = makeRouter(server); // the peer's handler, handed to the client as its Http transport
// The client owns `home` and reaches the peer through the server's handler injected as `http`.
const client = new BunGraphManager(undefined, extendedRegistry, undefined, undefined, undefined, serverHttp);
const CREW = 'http://peer.example/gremlin/crew';

const dec = (f: { buf: Buffer }) => decode(f.buf);
const names = (vs: any[]) => vs.map((v) => v.properties?.find((p: any) => p.label === 'name')?.value).sort();
const homeRun = (g: string) => client.executor('home').framedAsync(g, {});
const crewDirect = (g: string) => server.executor('crew').framedAsync(g, {});
const runNames = async (g: string) => names(await Promise.all((await homeRun(g)).map(dec)));

beforeAll(async () => {
  for (const g of MODERN_SEED) await client.executor('home').framedAsync(g, {});
  for (const g of CREW_SEED) await server.executor('crew').framedAsync(g, {});
});

describe('federate over HTTP — outbound client wired to the peer handler in memory', () => {
  test('source form: the sub-traversal runs on the peer; vertices return detached WITH props', async () => {
    const fed = await runNames(`g.call("federate").with("graph", "${CREW}").with("traversal", __.V())`);
    const direct = names(await Promise.all((await crewDirect('g.V()')).map(dec)));
    expect(fed).toEqual(direct);
    expect(fed.length).toBeGreaterThan(0);
  });

  test('a pushed reducer (count) crosses HTTP as a typed scalar', async () => {
    const fed = (await Promise.all((await homeRun(`g.call("federate").with("graph","${CREW}").with("traversal", __.V().count())`)).map(dec))).map(Number);
    const direct = (await Promise.all((await crewDirect('g.V().count()')).map(dec))).map(Number);
    expect(fed).toEqual(direct);
  });

  test('a LOCAL tail runs over the detached results (values over landed props)', async () => {
    const vals = (await Promise.all((await homeRun(`g.call("federate").with("graph","${CREW}").with("traversal", __.V().hasLabel("person")).values("name")`)).map(dec))).sort();
    const expected = names(await Promise.all((await crewDirect('g.V().hasLabel("person")')).map(dec)));
    expect(vals).toEqual(expected);
  });

  test('INJECT-THROUGH: standard as()/select() mid injection works over HTTP (the critical barrier path)', async () => {
    // Synthesizes `g.inject($map).unfold().group().by(Column.keys).by(__.V().has("name",select(Column.values)))`
    // on the peer with a bound Map — carried faithfully as a GraphBinary MAP, the string passed verbatim.
    const argless = `g.V().hasLabel("person").values("name").as("e").call("federate", ["graph":"${CREW}"]).V().has("name", select("e"))`;
    expect(await runNames(argless)).toEqual(['marko']); // only 'marko' is a person in BOTH home and crew
  });

  test('a mapValues count reduces each parent key over HTTP', async () => {
    const argless = `g.V().hasLabel("person").values("name").as("e").call("federate", ["graph":"${CREW}"]).V().has("name", select("e"))`;
    const local = new BunGraphManager(undefined, extendedRegistry); // an all-local twin for the authority
    for (const g of MODERN_SEED) await local.executor('home').framedAsync(g, {});
    for (const g of CREW_SEED) await local.executor('crew').framedAsync(g, {});
    const localArgless = argless.replace(CREW, 'crew');
    const overHttp = (await Promise.all((await homeRun(`${argless}.count()`)).map(dec))).map(Number);
    const allLocal = (await Promise.all((await local.executor('home').framedAsync(`${localArgless}.count()`, {})).map(dec))).map(Number);
    expect(overHttp).toEqual(allLocal);
  });

  test('a map terminal on the peer returns its map over HTTP', async () => {
    const q = '__.V().group().by(T.label).by(__.count())';
    const fed = await Promise.all((await homeRun(`g.call("federate").with("graph","${CREW}").with("traversal", ${q})`)).map(dec));
    const direct = await Promise.all((await crewDirect('g.V().group().by(T.label).by(__.count())')).map(dec));
    expect(Object.fromEntries(fed[0] as Map<string, unknown>)).toEqual(Object.fromEntries(direct[0] as Map<string, unknown>));
  });

  test('a query failure on the peer surfaces as a throw on the client side', async () => {
    await expect(homeRun(`g.call("federate").with("graph","${CREW}").with("traversal", __.V().hasLabel("person").outX())`))
      .rejects.toThrow();
  });
});
