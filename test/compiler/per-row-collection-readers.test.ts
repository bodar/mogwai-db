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

  test('select(keys) over a non-Map row is a raise behind a hard fence, never a drop', () => {
    const sql = read("g.V().values('m').where(__.count(local).is(2)).select(keys)").sql;
    expect(sql).toMatch(/AS MATERIALIZED/);
    expect(sql).toMatch(/does not have accessible keys/);
  });
});
