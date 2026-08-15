import { test, expect, describe } from 'bun:test';
import { CloudflareGraphManager } from '../src/cloudflare/cloudflare-graph-manager.ts';
import type { GraphDatabase } from '../src/cloudflare/graph-store-do.ts';
import { compilePlan, type Compiled } from '../src/compiler/compiler.ts';
import { createAppScope, createCompileScope } from '../src/scopes.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { frameResolved, type Framed } from '../src/execute.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { seededStore } from './support/harness.ts';
import { decodeAll } from './support/decode.ts';

// Edge-compilation Phase 1: the Worker EDGE compiles a non-segment READ and ships the `Compiled` to
// the DO's `runFramed`; everything else (writes → program, federation → segment, a compile throw)
// falls back to shipping the Gremlin string to `framed`. These tests exercise the real
// CloudflareGraphManager → EdgeExecutor seam in-process, with a FAKE DO stub recording which RPC it
// received — no workerd. (The real-workerd end-to-end lives in test/cloudflare.test.ts's contract.)

/** A fake DO stub over a real store: `runFramed` executes the shipped plan exactly as the DO would
 *  (via the shared `frameResolved`); `framed`/`raw` only RECORD that the fallback path was taken. */
function fakeManager(store: GraphStore) {
  const calls = { runFramed: 0, framed: 0, raw: 0, lastPlan: null as Compiled | null, lastGremlin: '' };
  const stub = {
    runFramed: async (plan: Compiled): Promise<Framed[]> => {
      calls.runFramed++; calls.lastPlan = plan;
      return [...frameResolved(store, plan)];
    },
    framed: async (gremlin: string): Promise<Framed[]> => {
      calls.framed++; calls.lastGremlin = gremlin;
      return []; // routing sentinel — the real DO compiles here; we only assert the path was taken
    },
    raw: async (): Promise<any[]> => { calls.raw++; return []; },
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
    if (direct.kind === 'sql') expect(calls.lastPlan).toEqual(direct.compiled as Compiled);
    // …and the framed result is the real answer (marko is 29).
    expect(await decodeAll(out.map((f) => f.buf))).toEqual([29]);
  });

  test('a WRITE (program) falls back to shipping the string', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    await mgr.executor('g').framedAsync('g.addV("person").property("name","x")', {});
    expect(calls.runFramed).toBe(0);
    expect(calls.framed).toBe(1);
  });

  test('a FEDERATED call (segment) falls back to shipping the string', async () => {
    const store = seededStore();
    const { mgr, calls } = fakeManager(store);
    await mgr.executor('g').framedAsync('g.call("mogwai.graph.federate").with("graph","crew")', {});
    expect(calls.runFramed).toBe(0);
    expect(calls.framed).toBe(1);
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
