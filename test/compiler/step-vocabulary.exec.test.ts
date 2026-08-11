// The step-name vocabularies (src/compiler/ir/step.ts): the bases, and the exact membership every
// consuming Set is expected to have after being rewritten as a DERIVATION of them.
//
// This test exists because the derivation refactor's success criterion is a number that does not
// move: every set had to keep its membership EXACTLY, so "no membership changed" needs to be
// asserted, not assumed. Two rows are the whole point of the file — COLLAPSE_MOVES and
// POSITION_MOVEMENTS exclude `otherV` while VERTEX_PRODUCERS includes it, and that difference is
// load-bearing (otherV carries fromV, i.e. per-traverser identity a GROUP BY-id collapse destroys,
// but a partition/subgraph vertex criterion must still fire after it).
//
// POSITION_MOVEMENTS's exclusion of otherV WAS a bug and is FIXED — it now includes it
// (tail/path.ts, tested end to end by test/L4-addendum/where-under-otherv-context.feature). This
// file used to assert the opposite, and it could not have caught the change either way: it
// compared a set REBUILT here out of the bases, not the one the compiler uses, so the two were
// free to disagree. Both consuming sets are now imported and asserted directly, which is the only
// version of this test that means anything.
import { test, expect, describe } from 'bun:test';
import {
    unionOf, VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V, VERTEX_SOURCE, EDGE_SOURCE,
    PATH_FAMILY, NUMERIC_REDUCERS, REDUCERS,
} from '../../src/compiler/ir/step.ts';
import { COLLAPSE_MOVES } from '../../src/compiler/ir/bulk.ts';
import { POSITION_MOVEMENTS } from '../../src/compiler/steps/tail/path.ts';

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('step-name vocabulary bases', () => {
  test('the bases are disjoint where they must be', () => {
    expect(sorted(VERTEX_MOVES)).toEqual(['both', 'in', 'out']);
    expect(sorted(EDGE_MOVES)).toEqual(['bothE', 'inE', 'outE']);
    expect(sorted(ENDPOINT_MOVES)).toEqual(['bothV', 'inV', 'outV']);
    expect(sorted(OTHER_V)).toEqual(['otherV']);
    // ENDPOINT_MOVES must NOT contain otherV — that separation is what lets the consumers differ.
    expect(ENDPOINT_MOVES.has('otherV')).toBe(false);
    expect(sorted(VERTEX_SOURCE)).toEqual(['V']);
    expect(sorted(EDGE_SOURCE)).toEqual(['E']);
    expect(sorted(PATH_FAMILY)).toEqual(['cyclicPath', 'path', 'simplePath']);
  });

  test('REDUCERS is NUMERIC_REDUCERS plus count', () => {
    expect(sorted(NUMERIC_REDUCERS)).toEqual(['max', 'mean', 'min', 'sum']);
    expect(sorted(REDUCERS)).toEqual(['count', 'max', 'mean', 'min', 'sum']);
    expect(NUMERIC_REDUCERS.has('count')).toBe(false);
  });

  test('unionOf is a set union, not a concat', () => {
    expect(sorted(unionOf(VERTEX_MOVES, VERTEX_MOVES))).toEqual(['both', 'in', 'out']);
    expect(unionOf(VERTEX_MOVES, EDGE_MOVES).size).toBe(6);
    expect(unionOf().size).toBe(0);
  });
});

describe('the derived movement sets still differ on otherV exactly as before', () => {
  // Spelled out rather than imported: these consuming sets are deliberately module-private, and
  // duplicating the expectation here is what makes a membership change fail loudly.
  const NINE = ['both', 'bothE', 'bothV', 'in', 'inE', 'inV', 'out', 'outE', 'outV'];

  test('COLLAPSE_MOVES: the nine, no otherV — the one exclusion that is load-bearing', () => {
    // otherV carries the entering-vertex context, i.e. per-traverser identity a GROUP BY-id
    // collapse destroys. Asserted on the REAL set, not a local rebuild.
    expect(sorted(COLLAPSE_MOVES)).toEqual(NINE);
    expect(COLLAPSE_MOVES.has('otherV')).toBe(false);
    expect(sorted(unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES))).toEqual(NINE);
  });

  test('POSITION_MOVEMENTS: the nine PLUS otherV', () => {
    // The opposite membership from COLLAPSE_MOVES, and for the opposite reason: a path position
    // must record the vertex a bothE().otherV() reached, not the edge it came from.
    expect(sorted(POSITION_MOVEMENTS)).toEqual([...NINE, 'otherV'].sort());
    expect(POSITION_MOVEMENTS.has('otherV')).toBe(true);
  });

  test('VERTEX_PRODUCERS: V + vertex + endpoint + otherV, no edge steps', () => {
    const derived = unionOf(VERTEX_SOURCE, VERTEX_MOVES, ENDPOINT_MOVES, OTHER_V);
    expect(sorted(derived)).toEqual(['V', 'both', 'bothV', 'in', 'inV', 'otherV', 'out', 'outV']);
    expect(derived.has('otherV')).toBe(true);
    expect([...EDGE_MOVES].some((s) => derived.has(s))).toBe(false);
  });

  test('EDGE_PRODUCERS: E + the vertex→edge steps', () => {
    expect(sorted(unionOf(EDGE_SOURCE, EDGE_MOVES))).toEqual(['E', 'bothE', 'inE', 'outE']);
  });

  test('MOVES (correlated predicates): vertex + edge, no edge→vertex', () => {
    const derived = unionOf(VERTEX_MOVES, EDGE_MOVES);
    expect(sorted(derived)).toEqual(['both', 'bothE', 'in', 'inE', 'out', 'outE']);
    expect([...ENDPOINT_MOVES].some((s) => derived.has(s))).toBe(false);
  });

  test('REPEAT_MOVES / BULK_MOVES: vertex-to-vertex only, for two different reasons', () => {
    expect(sorted(VERTEX_MOVES)).toEqual(['both', 'in', 'out']);
  });
});
