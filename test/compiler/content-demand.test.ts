// Phase 1 of federate pushdown (docs/2026-08-26-federate-pushdown-design.md): the ONE tail classifier
// `contentDemand`. This phase is BEHAVIOUR-PRESERVING — the fact is computed and `detachedTail` routes
// its decline check through it, but no fetch behaviour changes yet. These tests pin (a) the fact's
// vocabulary and (b) the two drift risks the convergence exists to remove: the adjacency-step set must
// equal `HOPS`, and the decline set must match what `detachedTail` failed closed on before.
import { test, expect, describe } from 'bun:test';
import { ADJACENCY_STEPS, BOUND_HANDOFF_DENY, contentDemand } from '../../src/compiler/ir/content-demand.ts';
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
  test('count() reaches no elements, terminal reduction, no keys', () => {
    const { steps, from } = tailOf('g.V().count()');
    const d = contentDemand(steps, from);
    expect(d.reachesElements).toBe(false);
    expect(d.reachesAdjacency).toBe(false);
    expect(d.terminalReduction).toBe(true);
    expect(d.keys).toEqual(new Set());
  });

  test('dedup() reaches no elements (identity only), not a reduction', () => {
    const { steps, from } = tailOf('g.V().dedup()');
    const d = contentDemand(steps, from);
    expect(d.reachesElements).toBe(false);
    expect(d.reachesAdjacency).toBe(false);
    expect(d.terminalReduction).toBe(false);
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

  test('a write tail is handoff-denied', () => {
    const { steps, from } = tailOf('g.V().property("x", 1)');
    expect(contentDemand(steps, from).handoffDenied).toBe(true);
  });

  test('has(name, ...) contributes the key; count() after is still a reduction', () => {
    const { steps, from } = tailOf('g.V().has("name", "marko").count()');
    const d = contentDemand(steps, from);
    expect(d.keys).toEqual(new Set(['name']));
    expect(d.terminalReduction).toBe(true);
    expect(d.reachesElements).toBe(true); // has() reads the element
  });
});
