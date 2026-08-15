import { test, expect, describe } from 'bun:test';
import { CloudflareGraphManager } from '../src/cloudflare/cloudflare-graph-manager.ts';
import type { GraphDatabase } from '../src/cloudflare/graph-store-do.ts';
import { compilePlan, type Executable } from '../src/compiler/compiler.ts';
import { createAppScope, createCompileScope } from '../src/scopes.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { frameResolved, readSegmentHead, type Framed } from '../src/execute.ts';
import type { ForeignRow } from '../src/api.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { seededStore } from './support/harness.ts';
import { decodeAll } from './support/decode.ts';

// Edge-compilation: the Worker EDGE compiles/renders a plan and runs it on the DO — a non-segment plan
// (read or write) via `runFramed`; a `worker`-resident federation segment DRIVEN from the Worker (Phase
// 2b) via `readHead` + `apply`(siblings via `raw`) + `runFramed`; everything else falls back to
// shipping the Gremlin string to `framed`. These tests exercise the real CloudflareGraphManager →
// EdgeExecutor seam in-process with a FAKE DO stub recording which RPC fired — no workerd. (The
// real-workerd end-to-end lives in test/cloudflare.test.ts's contract.)

/** A fake DO stub over a real store: `runFramed`/`readHead` execute exactly as the DO would (via the
 *  shared `frameResolved`/`readSegmentHead`); `raw` returns fixed sibling rows; `framed` (the DO's own
 *  compile+drive fallback) only RECORDS that the fallback path was taken. */
function fakeManager(store: GraphStore, siblingRows: ForeignRow[] = []) {
  const calls = { runFramed: 0, framed: 0, raw: 0, readHead: 0, lastPlan: null as Executable | null, lastGremlin: '' };
  const stub = {
    runFramed: async (plan: Executable): Promise<Framed[]> => {
      calls.runFramed++; calls.lastPlan = plan;
      return [...frameResolved(store, plan)];
    },
    readHead: async (head: any) => { calls.readHead++; return readSegmentHead(store, head); },
    framed: async (gremlin: string): Promise<Framed[]> => {
      calls.framed++; calls.lastGremlin = gremlin;
      return []; // routing sentinel — the real DO compiles here; we only assert the path was taken
    },
    raw: async (): Promise<ForeignRow[]> => { calls.raw++; return siblingRows; },
  };
  const ns = { getByName: () => stub } as unknown as DurableObjectNamespace<GraphDatabase>;
  return { mgr: new CloudflareGraphManager(ns), calls };
}

describe('edge compilation — EdgeExecutor routing', () => {
  test('a non-segment READ is compiled at the edge and shipped to runFramed (the DO does NOT compile)', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    const out = await mgr.executor('g').framedAsync('g.V().has("name","marko").values("age")', {});
    // The payoff, structurally: runFramed was hit, framed (the DO's compile path) was NOT.
    expect(calls.runFramed).toBe(1);
    expect(calls.framed).toBe(0);
    // The edge shipped exactly the plan a direct compile produces (same sql + binds + shape).
    const direct = compilePlan('g.V().has("name","marko").values("age")', {}, { app: createCompileScope(extendedRegistry) });
    expect(direct.kind).toBe('sql');
    if (direct.kind === 'sql') expect(calls.lastPlan).toEqual(direct.compiled as Executable);
    // …and the framed result is the real answer (marko is 29).
    expect(await decodeAll(out.map((f) => f.buf))).toEqual([29]);
  });

  test('a WRITE (program) is compiled + rendered at the edge and shipped to runFramed (Phase 2a)', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    const out = await mgr.executor('g').framedAsync('g.addV("person").property("name","zephyr")', {});
    expect(calls.runFramed).toBe(1);       // the rendered write program shipped as data
    expect(calls.framed).toBe(0);          // the DO did not compile
    expect(calls.lastPlan?.kind).toBe('program');
    expect(out.length).toBe(1);            // the added vertex frames back
    // …and it PERSISTED in the DO's store — a follow-up read (also edge-compiled) counts it.
    const check = await mgr.executor('g').framedAsync('g.V().has("name","zephyr").count()', {});
    expect(await decodeAll(check.map((f) => f.buf))).toEqual([1]);
  });

  test('a worker-resident FEDERATE (source form) is DRIVEN from the Worker, not full-driven by the DO (Phase 2b)', async () => {
    const store = seededStore();
    // The sibling "crew" graph returns one detached vertex from its raw() hop.
    const sibling: ForeignRow[] = [{ kind: 'vertex', id: 99, label: 'person', labels: ['person'], props: { name: [{ t: 'string', v: 'zeta' }] } }];
    const { mgr, calls } = fakeManager(store, sibling);
    const out = await mgr.executor('g').framedAsync('g.call("mogwai.graph.federate").with("graph","crew").with("traversal","g.V()")', {});
    // The payoff: the top DO did NOT full-drive the loop (framed = 0). The Worker drove it — fanning
    // out to the sibling (raw = 1) and running only the final framing on the DO (runFramed = 1). A
    // source-form federate has a null head, so no readHead.
    expect(calls.framed).toBe(0);
    expect(calls.runFramed).toBe(1);
    expect(calls.raw).toBe(1);
    expect(calls.readHead).toBe(0);
    expect(out.length).toBe(1);   // the sibling's vertex, framed
  });

  test('a MID-traversal federate reads its head on the DO (readHead) but the Worker drives the loop', async () => {
    const store = seededStore();
    const sibling: ForeignRow[] = [{ kind: 'vertex', id: 99, label: 'person', labels: ['person'], props: {} }];
    const { mgr, calls } = fakeManager(store, sibling);
    await mgr.executor('g').framedAsync('g.V().has("name","marko").call("mogwai.graph.federate", ["graph":"crew","traversal":"g.V()"], __.values("name"))', {});
    expect(calls.readHead).toBe(1);   // the per-parent injected value was read on the DO
    expect(calls.raw).toBe(1);        // one batched sibling hop, from the Worker
    expect(calls.framed).toBe(0);     // the DO did not full-drive
    expect(calls.runFramed).toBe(1);  // the final rejoin framed on the DO
  });

  test('a do-resident barrier (io) is NOT worker-driven — it falls back to the DO', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    // io's apply needs the local store the Worker lacks, so residency is 'do' → string fallback.
    await mgr.executor('g').framedAsync('g.io("data/x.json").read()', {});
    expect(calls.framed).toBe(1);
    expect(calls.runFramed).toBe(0);
    expect(calls.readHead).toBe(0);
  });

  test('a MALFORMED traversal falls back — the throw is caught, the DO reports the error', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    await mgr.executor('g').framedAsync('g.V().thisIsNotAStep()', {});
    expect(calls.runFramed).toBe(0);   // edge did not ship a plan
    expect(calls.framed).toBe(1);      // fell back so the DO compiles + reports via the rpc trailer
  });
});

describe('edge compilation — correctness invariants', () => {
  test('store presence does not change the plan — an edge (store-free) compile equals a store-backed one', () => {
    // The crux: the edge has no store, yet must ship the plan the DO (with a store) would compile.
    for (const g of [
      'g.V().count()',
      'g.V().has("name","marko").out("knows").values("name")',
      'g.V().hasLabel("person").order().by("age").limit(2).valueMap()',
    ]) {
      const edge = compilePlan(g, {}, { app: createCompileScope(extendedRegistry) });
      const backed = compilePlan(g, {}, { app: createAppScope({ registry: extendedRegistry, store: new GraphStore(new BunSqlite(':memory:')) }) });
      expect(edge).toEqual(backed);
    }
  });

  test('§2·1 — compile touches the store ZERO times', () => {
    // Count every query/exec on the store; assert compile makes none. (Schema DDL fires in the
    // GraphStore ctor, so the counter is reset AFTER construction — we measure compile alone.)
    let touches = 0;
    const inner = new BunSqlite(':memory:');
    const counting = new Proxy(inner, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if ((prop === 'query' || prop === 'exec') && typeof v === 'function')
          return (...args: any[]) => { touches++; return (v as any).apply(target, args); };
        return v;
      },
    });
    const app = createAppScope({ registry: extendedRegistry, store: new GraphStore(counting as any) });
    touches = 0;
    for (const g of [
      'g.V().count()',
      'g.V().has("name","marko").out("knows").limit(1)',
      'g.V().hasLabel("person").order().by("age").valueMap()',
      'g.V().repeat(__.out()).times(2).values("name")',
      'g.V().group().by("age").by("name")',
      'g.V().project("a","b").by("name").by("age")',
      'g.V().out().out().out().values("name")',
      'g.addV("person").property("name","x")',
    ]) compilePlan(g, {}, { app });
    expect(touches).toBe(0);
  });
});
