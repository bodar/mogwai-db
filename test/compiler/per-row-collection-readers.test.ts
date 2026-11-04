// A compound reader over a PER-ROW-TYPED scalar stream (`perRowCollectionStep`, src/compiler/rel/lower.ts;
// `perRowCollectionChild`, src/compiler/rel/lower/reduction.ts). The answers live in
// test/L4-addendum/per-row-collection-readers.feature; this pins what a result cannot show — the SHAPE.
import { test, expect, describe } from 'bun:test';
import { read } from '../support/harness.ts';

describe('per-row collection readers — shape', () => {
  test('the split reads ONE relation: each arm filters it on the tag, no arm joins another', () => {
    const sql = read("g.V().values('m').count(local)").sql;
    expect(sql).not.toMatch(/\bJOIN\b[^)]*json_each[^)]*\bJOIN\b[^)]*json_each/);
    expect(sql.match(/vtype = 'map'/g)).toHaveLength(1);
  });

  test('a one-to-one child (count(local)) states its presence — the split is spelled once, not again in an EXISTS', () => {
    const sql = read("g.V().values('m').where(__.count(local).is(2))").sql;
    expect(sql).not.toMatch(/EXISTS/);
  });

  test('every route reads its input behind a hard fence, so a value filter is never flattened into an arm', () => {
    for (const q of ["g.V().values('m').is(neq('text')).count(local)", "g.V().values('m').is(neq('text')).select('k','x')"]) {
      expect(read(q).sql).toMatch(/AS MATERIALIZED/);
    }
  });

  test('a closed walk upstream is self-contained: the hard fence still stands behind an emit()/until() repeat', () => {
    for (const q of [
      "g.V().emit().repeat(out().simplePath()).values('m').is(neq('text')).count(local)",
      "g.V().repeat(out().simplePath()).emit().values('m').is(neq('text')).limit(local,1)",
    ]) {
      const sql = read(q).sql;
      expect(sql).toMatch(/WITH RECURSIVE/);
      expect(sql).toMatch(/AS MATERIALIZED/);
    }
  });

  test('a list function raises in the tag test\'s own WHERE, behind a hard fence — one CASE, no second arm', () => {
    const sql = read("g.V().values('tags').intersect(['a','b'])").sql;
    expect(sql).toMatch(/AS MATERIALIZED/);
    expect(sql.match(/Incoming traverser for intersect step/g)).toHaveLength(1);
    expect(sql.match(/can only take an array or an Iterable type for incoming traversers/g)).toHaveLength(1);
    expect(sql).not.toMatch(/UNION ALL/);
  });

  test('a list function over a stream that is never a collection never reads its operand', () => {
    // `inject(1)` is no collection, so `convertTraverserToCollection` raises before the operand: the
    // operand's own error (a traversal yielding no collection) is not the answer.
    expect(() => read("g.inject(null).combine(__.inject(1))")).not.toThrow();
  });

  test('select(keys) over a non-Map row is a raise behind a hard fence, never a drop', () => {
    const sql = read("g.V().values('m').where(__.count(local).is(2)).select(keys)").sql;
    expect(sql).toMatch(/AS MATERIALIZED/);
    expect(sql).toMatch(/does not have accessible keys/);
  });
});
