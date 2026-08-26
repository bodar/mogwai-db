// Phase 1 of federate pushdown (docs/2026-08-26-federate-pushdown-design.md): the ONE tail classifier
// `contentDemand`. This phase is BEHAVIOUR-PRESERVING — the fact is computed and `detachedTail` routes
// its decline check through it, but no fetch behaviour changes yet. These tests pin (a) the fact's
// vocabulary and (b) the two drift risks the convergence exists to remove: the adjacency-step set must
// equal `HOPS`, and the decline set must match what `detachedTail` failed closed on before.
import { test, expect, describe } from 'bun:test';
import { ADJACENCY_STEPS, BOUND_HANDOFF_DENY, contentDemand, pushableTailPrefix } from '../../src/compiler/ir/content-demand.ts';
import { HOPS } from '../../src/compiler/rel/lower/movement.ts';
import { MUTATING_STEPS } from '../../src/compiler/ir/strategies.ts';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';

// A tail is the steps AFTER a barrier. Build one by parsing a g.V()… chain, normalizing to the IR the
// lowering sees, and slicing off the source. The federation suite covers end-to-end; here we unit the
// fact directly on the normalized step chain, so it matches what `detachedTail` reads.
const tailOf = (gremlin: string) => {
  const steps = normalize(stepChain(parseGremlin(gremlin), {})).steps as any[];
  return { steps, from: 1 }; // drop the source V()/E()
};

describe('ADJACENCY_STEPS mirrors HOPS — cannot drift', () => {
  test('the adjacency set is exactly HOPS keys', () => {
    expect([...ADJACENCY_STEPS].sort()).toEqual(Object.keys(HOPS).sort());
  });
});

describe('BOUND_HANDOFF_DENY — the decline set detachedTail reads', () => {
  test('is writes + propertyMap (the old inline set)', () => {
    expect([...BOUND_HANDOFF_DENY].sort()).toEqual([...MUTATING_STEPS, 'propertyMap'].sort());
  });
});

describe('contentDemand — what the tail consumes', () => {
  test('count() reaches no elements, no keys', () => {
    const { steps, from } = tailOf('g.V().count()');
    const d = contentDemand(steps, from);
    expect(d.reachesElements).toBe(false);
    expect(d.reachesAdjacency).toBe(false);
    expect(d.keys).toEqual(new Set());
  });

  test('dedup() reaches no elements (identity only)', () => {
    const { steps, from } = tailOf('g.V().dedup()');
    const d = contentDemand(steps, from);
    expect(d.reachesElements).toBe(false);
    expect(d.reachesAdjacency).toBe(false);
  });

  test('values(name) reaches elements, narrows keys to {name}, no adjacency', () => {
    const { steps, from } = tailOf('g.V().values("name")');
    const d = contentDemand(steps, from);
    expect(d.reachesElements).toBe(true);
    expect(d.reachesAdjacency).toBe(false);
    expect(d.keys).toEqual(new Set(['name']));
  });

  test('out() reaches adjacency (and elements)', () => {
    const { steps, from } = tailOf('g.V().out()');
    const d = contentDemand(steps, from);
    expect(d.reachesAdjacency).toBe(true);
    expect(d.reachesElements).toBe(true);
  });

  test('inV().values(name) — movement then a key read: adjacency + {name}', () => {
    const { steps, from } = tailOf('g.E().inV().values("name")');
    const d = contentDemand(steps, from);
    expect(d.reachesAdjacency).toBe(true);
    expect(d.keys).toEqual(new Set(['name']));
  });

  test('valueMap() widens keys to all', () => {
    const { steps, from } = tailOf('g.V().valueMap()');
    const d = contentDemand(steps, from);
    expect(d.keys).toBe('all');
    expect(d.reachesElements).toBe(true);
  });

  test('.V() re-source reaches adjacency (needs the landed endpoint vertices) even before count()', () => {
    // A subgraph `.V().count()` re-roots at the fetched vertices, so the endpoint fetch must NOT be
    // skipped — reachesAdjacency guards exactly that.
    const { steps, from } = tailOf('g.E().V().count()');
    expect(contentDemand(steps, from).reachesAdjacency).toBe(true);
  });

  test('.E() re-source does NOT reach adjacency (edges are always fetched)', () => {
    const { steps, from } = tailOf('g.V().E().count()');
    expect(contentDemand(steps, from).reachesAdjacency).toBe(false);
  });

  test('elementMap() reaches adjacency — an edge elementMap rejoins endpoint vertices', () => {
    // Conservative: elementMap over an edge stream emits IN/OUT endpoint entries needing the landed
    // vertices. We do not track the stream elem, so elementMap always reaches adjacency (safe over-fetch).
    const { steps, from } = tailOf('g.E().elementMap()');
    expect(contentDemand(steps, from).reachesAdjacency).toBe(true);
  });

  test('a write tail is handoff-denied', () => {
    const { steps, from } = tailOf('g.V().property("x", 1)');
    expect(contentDemand(steps, from).handoffDenied).toBe(true);
  });

  test('has(name, ...) still contributes the key', () => {
    const { steps, from } = tailOf('g.V().has("name", "marko").count()');
    const d = contentDemand(steps, from);
    expect(d.keys).toEqual(new Set(['name']));
    expect(d.reachesElements).toBe(true); // has() reads the element
  });
});

describe('pushableTailPrefix — the remote/local boundary walk', () => {
  // The chain is g.call(federate)<tail>; the barrier is at index 0, so the tail begins at 1.
  const prefixOf = (tail: string, params: Record<string, any> = {}) => {
    const steps = normalize(stepChain(parseGremlin(`g.call("x")${tail}`), params)).steps as any[];
    return pushableTailPrefix(steps, 0, params);
  };

  test('the WHOLE tail pushes when every step is remote-safe', () => {
    const p = prefixOf('.V().hasLabel("person").out("knows").count()');
    expect(p.length).toBe(4);          // V, hasLabel, out, count all push
    expect(p.reduces).toBe(true);      // ends in count() -> sibling returns a scalar
  });

  test('a movement chain then dedup then count all push (the 5-vs-2 case fixed structurally)', () => {
    const p = prefixOf('.V().out("develops").dedup().count()');
    expect(p.length).toBe(4);          // out+dedup+count push WHOLE, not just count
    expect(p.reduces).toBe(true);
  });

  test('an element tail pushes without reducing', () => {
    const p = prefixOf('.V().hasLabel("person")');
    expect(p.length).toBe(2);
    expect(p.reduces).toBe(false);     // no reducer -> sibling returns elements
  });

  test('a WRITE ends the prefix (stays local)', () => {
    const p = prefixOf('.V().property("x", 1)');
    expect(p.length).toBe(1);          // V() pushes, property() is the boundary
  });

  test('a nested/second call() ends the prefix', () => {
    const p = prefixOf('.V().call("y")');
    expect(p.length).toBe(1);          // V() pushes, the second call is a boundary
  });

  test('a self-contained backtrack pushes (as() bound INSIDE the prefix)', () => {
    const p = prefixOf('.V().as("a").out().where(eq("a"))');
    expect(p.length).toBe(4);          // as/out/where all push — the label is prefix-local
  });

  test('a backtrack to a PRE-barrier label ends the prefix', () => {
    // g.V().as("x").call(federate).where(eq("x")) — the where reads a label bound before the barrier.
    const steps = normalize(stepChain(parseGremlin('g.V().as("x").call("f").where(eq("x"))'), {})).steps as any[];
    const barrierAt = steps.findIndex((s: any) => s.name === 'call');
    const p = pushableTailPrefix(steps, barrierAt, {});
    expect(p.length).toBe(0);          // where(eq("x")) reads pre-barrier 'x' -> nothing pushes
  });
});
