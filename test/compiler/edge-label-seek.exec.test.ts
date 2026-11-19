import { describe, expect, test } from 'bun:test';
import { bagOf, bare, read, run, seededStore } from '../support/harness.ts';

// A ROOT EDGE SCAN BY LABEL IS A SEEK — the `e_label(label)` index (`src/storage.ts`), the edge half of the vertex
// `vl_label` split. `E().hasLabel(x)` pins only `label`, which is no prefix of e_out(src,label,tgt), e_in(tgt,label,src)
// or e_pair(src,tgt), so without it SQLite scans a whole adjacency index and filters: O(|E|) per query whatever |x|.
// SQLite's own planner chooses the seek; no lowering names the index, so it reaches every position a root `E()` can
// stand in. An ADJACENCY read (`V(1).outE('knows')`) keeps e_out — its `src` pin makes that the better prefix.
//
// Hand-computed on the modern graph: knows = {marko→vadas 0.5, marko→josh 1.0}; created = {marko→lop 0.4,
// josh→ripple 1.0, josh→lop 0.4, peter→lop 0.2}.
const store = seededStore();
const values = (q: string) => run(store, q).map((r: any) => bare(r).v);
const plan = (q: string): string => {
  const { sql, binds } = read(q);
  return store.query(`EXPLAIN QUERY PLAN ${sql}`, binds).map((row: any) => row.detail).join('\n');
};
const SEEK = /SEARCH \w+ USING COVERING INDEX e_label \(label=\?\)/;

describe('a root E().hasLabel(x)', () => {
  test('answers', () => {
    expect(values("g.E().hasLabel('knows').count()")).toEqual([2]);
    expect(values("g.E().hasLabel('knows','created').count()")).toEqual([6]);
    expect(values("g.E().hasLabel('nope').count()")).toEqual([0]);
    expect(bagOf(values("g.E().hasLabel('created').values('weight')"))).toEqual(bagOf([0.4, 1.0, 0.4, 0.2]));
    expect(bagOf(values("g.E().hasLabel('knows').inV().values('name')"))).toEqual(bagOf(['vadas', 'josh']));
    expect(values("g.E().hasLabel('created').where(__.outV().has('name','josh')).count()")).toEqual([2]);
    expect(values("g.inject(1).flatMap(__.E().hasLabel('created').count())")).toEqual([4]);
    expect(values("g.V().hasLabel('software').map(__.E().hasLabel('knows').count())")).toEqual([2, 2]);
    expect(values('g.E().count()')).toEqual([6]);
  });

  test('seeks e_label at the root and inside a child traversal', () => {
    for (const q of [
      "g.E().hasLabel('knows').count()",
      "g.E().hasLabel('knows','created').count()",
      "g.E().hasLabel('created').values('weight')",
      "g.E().hasLabel('knows').inV().values('name')",
      "g.E().hasLabel('created').where(__.outV().has('name','josh')).count()",
      "g.inject(1).flatMap(__.E().hasLabel('created').count())",
      "g.V().hasLabel('software').map(__.E().hasLabel('knows').count())",
    ]) expect(plan(q)).toMatch(SEEK);
  });

  test('an adjacency read keeps its endpoint index', () => {
    const p = plan("g.V(1).outE('knows')");
    expect(p).toMatch(/USING COVERING INDEX e_out \(src=\? AND label=\?\)/);
    expect(p).not.toMatch(/e_label/);
  });
});
