import { describe, expect, test } from 'bun:test';
import { bare, read, run, seededStore } from '../support/harness.ts';

// AN EDGE READ PINNED AT BOTH ENDPOINTS IS A POINT LOOKUP — the `e_pair(src, tgt)` index (`src/storage.ts`). With no
// label, neither `e_out(src,label,tgt)` nor `e_in(tgt,label,src)` has both pinned columns as a prefix, so the probe
// would read one endpoint's whole neighbourhood; `e_pair`'s prefix IS the probe, and SQLite's planner seeks it with
// no rewrite of ours. The scaling half is in walk-condition-hub-scale.exec.test.ts.
//
// Hand-computed on the modern graph: out-edges marko→{lop, vadas, josh}, josh→{ripple, lop}, peter→lop (6), no
// self-loops, no 2-cycles; the one triangle is marko–josh–lop.
const store = seededStore();
const count = (q: string): number => Number(bare(run(store, q)[0]).v);
const plan = (q: string): string => {
  const { sql, binds } = read(q);
  return store.query(`EXPLAIN QUERY PLAN ${sql}`, binds).map((row: any) => row.detail).join('\n');
};

describe('an edge test between two known vertices', () => {
  test('answers', () => {
    expect(count("g.V().as('a').out().where(__.in().as('a')).count()")).toBe(6); // every out-edge closes back
    expect(count("g.V().as('a').both().where(__.both().as('a')).count()")).toBe(12);
    expect(count("g.V().as('a').out().out().where(__.in().as('a')).count()")).toBe(1); // marko→josh→lop, and marko created lop
    expect(count("g.V().as('a').repeat(both().simplePath()).times(2).where(__.both().as('a')).count()")).toBe(6); // 1 triangle × 6 orientations
    expect(count("g.V().as('a').out().as('b').where(__.in('knows').as('a')).count()")).toBe(2);
    expect(count("g.V().as('a').repeat(out()).emit(as('c').select('a').out().where(eq('c'))).count()")).toBe(7); // marko: lop, vadas, josh, lop-via-josh; josh: ripple, lop; peter: lop
    expect(count("g.V().as('a').repeat(out()).until(where(__.in().as('a'))).count()")).toBe(6); // every first hop: each closes back to its start
  });

  test('the probe seeks both endpoints, in either direction and through both()', () => {
    for (const q of [
      "g.V().as('a').out().where(__.in().as('a')).count()",
      "g.V().as('a').in().where(__.out().as('a')).count()",
      "g.V().as('a').out().where(__.both().as('a')).count()",
      "g.V().as('a').repeat(out()).emit(where(__.in().as('a'))).count()",
    ]) expect(plan(q)).toMatch(/USING COVERING INDEX e_pair \((src=\? AND tgt=\?|tgt=\? AND src=\?)\)/);
  });

  test('a read that names its label keeps the adjacency index', () => {
    expect(plan("g.V().as('a').out().where(__.in('knows').as('a')).count()")).toMatch(/USING COVERING INDEX e_(in|out) \((tgt|src)=\? AND label=\? AND (src|tgt)=\?\)/);
  });
});
