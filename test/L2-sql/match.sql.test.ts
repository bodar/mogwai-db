// L2 — SQL snapshots for match(): the "compile to SQL, never interpret" contract.
//
// match() is a BINDING TABLE threaded through the ordinary fold (src/compiler/rel/match.ts): the root
// label seeds the incoming traverser, each pattern re-roots at its start alias and JOINS its movement
// on, and the end either widens the alias channels (a bind) or adds an equality constraint (a back
// edge). What these snapshots pin is that structure — a join per hop, a constraint per back edge, and
// the bindings MAP at a terminal — not byte identity (see CLAUDE.md "SQL snapshots assert semantic
// equivalence"). The result-shape half is covered by test/compiler tests and L3.
import { test, expect, describe } from 'bun:test';
import { read, run, seededStore } from '../support/harness.ts';

describe('match() SQL', () => {
  // A single binding pattern: one movement joined onto the binding table, emitting the {a,b} map.
  test('single pattern → one join + a two-key bindings map', () => {
    const p = read('g.V().match(__.as("a").out().as("b"))');
    // Terminal match emits the bindings MAP as one map-valued column.
    expect(p.shape).toEqual({ kind: 'mapValue' });
    // The binding table is the root scan; the pattern is a join onto it.
    expect(p.sql).toMatch(/FROM nodes rn[^]*edges/);
    // Both declared variables are projected into the bindings map.
    expect(p.sql).toContain("json_array('a'");
    expect(p.sql).toContain("json_array('b'");
  });

  // A two-pattern chain: two hops, so two edge joins, and the second pattern's start re-roots on the
  // FIRST pattern's bound end — the join order the readiness scheduler produced.
  test('chained patterns → a join per hop', () => {
    const p = read('g.V().match(__.as("a").out("knows").as("b"), __.as("b").out("created").as("c"))');
    expect((p.sql.match(/edges rme\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(p.sql).toContain("json_array('c'");
    // Both hop labels are filtered on the labels table.
    expect(p.sql).toContain("'knows'");
    expect(p.sql).toContain("'created'");
  });

  // A back edge (`as('a')` re-used as an end) is a CONSTRAINT, not a bind: the produced element must
  // equal the already-bound `a`, which lands as a WHERE equality against the root row rather than a
  // new column.
  test('back edge → an equality constraint, not a new binding', () => {
    const p = read('g.V().match(__.as("a").out("created").as("b"), __.as("b").in("created").as("a"))');
    // Two hops (out, in) → two edge joins.
    expect((p.sql.match(/edges rme\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The map declares only a and b (a is not re-bound to a fresh column by the back edge).
    expect(p.sql).toContain("json_array('a'");
    expect(p.sql).toContain("json_array('b'");
    // The constraint ties the second hop back to the root row — a WHERE comparing to rn.
    expect(p.sql).toMatch(/WHERE[^]*rn\.id/);
  });

  // A non-terminal match leaves the pattern variables on the stream as alias channels for a downstream
  // select() to read, rather than materializing the map early.
  test('non-terminal select over match reads the alias channels', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().match(__.as("a").out().as("b")).select("b").by(T.id)') as any[];
    // Six out-edges in the modern graph → six bound b's.
    expect(rows.length).toBe(6);
  });
});
