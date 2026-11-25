// A NUMERIC EQUALITY KEEPS ITS INDEX SEEK, AND STILL MATCHES A STORED BIGDECIMAL.
//
// `has(k, 1)` compares a stored BigDecimal by its REAL (`decimalTextArm`, src/compiler/rel/predicate.ts), so the
// predicate is `value = 1 OR (vtype = 'bigdecimal' AND CAST(value AS REAL) = 1)`. The owner seek reads each
// disjunct as its own arm (`seekArms`, src/rel/passes/semijoin.ts): `vp_key_value`/`ep_key_value` for the raw
// compare, the partial `vp_decimal`/`ep_decimal` for the decimal arm. The plan shape is pinned in
// test/plan-stability.test.ts; this file pins the ANSWER — the decimal arm still matches, on vertices and edges,
// and an element both arms match comes back once.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { bare, run } from '../support/harness.ts';

function store(): GraphStore {
  const s = new GraphStore(new BunSqlite(':memory:'));
  run(s, "g.addV('a').property('name','dec').property('n', 1m).as('x')"
    + ".addV('a').property('name','int').property('n', 1).as('y')"
    + ".addV('a').property('name','two').property('n', 2)"
    + ".addV('a').property('name','other').property('n', 3).as('z')"
    + ".addE('e').from('x').to('y').property('name','dec').property('w', 1m)"
    + ".addE('e').from('y').to('z').property('name','int').property('w', 1)"
    + ".addE('e').from('z').to('x').property('name','other').property('w', 3)");
  // One vertex both arms match: a list property holding the Integer 1 AND the BigDecimal 1.
  run(s, "g.addV('a').property('name','both').property(list, 'n', 1).property(list, 'n', 1m)");
  return s;
}

const names = (s: GraphStore, q: string): string[] => run(s, q).map((r) => bare(r.v)).sort();

describe('a numeric equality matches a stored BigDecimal through its seek', () => {
  const s = store();
  test.each([
    ["g.V().has('n', 1).values('name')", ['both', 'dec', 'int']],
    ["g.V().has('n', within(1, 2)).values('name')", ['both', 'dec', 'int', 'two']],
    ["g.V().has('a', 'n', 1).values('name')", ['both', 'dec', 'int']],
    ["g.E().has('w', 1).values('name')", ['dec', 'int']],
    ["g.E().has('w', within(1, 2)).values('name')", ['dec', 'int']],
    // At depth: the same seek inside a child traversal and after a hop.
    ["g.V().has('name','other').out().has('n', 1).values('name')", ['dec']],
    ["g.V().where(__.outE().has('w', 1)).values('name')", ['dec', 'int']],
    ["g.V().has('n', 3).union(__.has('n', 3), __.V().has('n', 1)).values('name')", ['both', 'dec', 'int', 'other']],
  ] as const)('%s', (q, expected) => {
    expect(names(s, q)).toEqual([...expected].sort());
  });
});
