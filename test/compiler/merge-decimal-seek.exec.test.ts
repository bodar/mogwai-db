// A MERGE SEARCH FINDS A STORED BIGDECIMAL THROUGH ITS DECIMAL INDEX.
//
// A per-driver merge search (`seekedSearch`, src/compiler/rel/write.ts) narrows each numeric criterion by the
// stored TEXT tail its cast could meet (`decimalTextSeeks`): a BigDecimal through the partial
// `vp_decimal`/`ep_decimal` index on `(key, CAST(value AS REAL))` — the very cast the search's residual
// compares — and a long/bigint stored as TEXT (|c| ≥ 2^53) through a `(key, value)` range. The residual
// decides; these tests pin the ANSWER (a match does not create) and the PLAN (each arm is a SEARCH).
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { runSteps } from '../../src/program.ts';
import { isRowsBind } from '../../src/rel/emit.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { bare, run } from '../support/harness.ts';

const fresh = (): GraphStore => new GraphStore(new BunSqlite(':memory:'));
const count = (s: GraphStore, q: string): number => bare(run(s, q)[0].v);

describe('a merge search matches a stored BigDecimal and a TEXT-stored long', () => {
  for (const [name, seed, merge, check, expected] of [
    ['1m by 1', "g.addV('p').property('n', 1m)", "g.inject([n:1]).mergeV()", "g.V().count()", 1],
    ['1m by 1.0', "g.addV('p').property('n', 1m)", "g.inject([n:1.0]).mergeV()", "g.V().count()", 1],
    ['1m by 1m', "g.addV('p').property('n', 1m)", "g.inject([n:1m]).mergeV()", "g.V().count()", 1],
    ['-0.5m by -0.5', "g.addV('p').property('n', -0.5m)", "g.inject([n:-0.5]).mergeV()", "g.V().count()", 1],
    ['a computed search', "g.addV('p').property('n', 1m).addV('q').property('n', 1)", "g.V().hasLabel('q').mergeV(__.project('n').by(values('n')))", "g.V().count()", 2],
    ['an edge weight 0.5m', "g.addV('a').as('a').addV('b').addE('e').from('a').property('w', 0.5m)", "g.inject([(T.label):'e', w:0.5]).mergeE()", "g.E().count()", 1],
    ['a long exactly 2^53 (TEXT)', "g.addV('p').property('n', 9007199254740992L)", "g.inject([n:9007199254740992L]).mergeV()", "g.V().count()", 1],
    ['-2^53 (TEXT)', "g.addV('p').property('n', -9007199254740992L)", "g.inject([n:-9007199254740992L]).mergeV()", "g.V().count()", 1],
    ['2^53 by its double', "g.addV('p').property('n', 9007199254740992L)", "g.inject([n:9007199254740992.0]).mergeV()", "g.V().count()", 1],
    ['2^60 + 1 (TEXT)', "g.addV('p').property('n', 1152921504606846977L)", "g.inject([n:1152921504606846977L]).mergeV()", "g.V().count()", 1],
    // The REAL cast of 9007199254740993.0 is 2^53, which is not the long 9007199254740993: no match.
    ['9007199254740993.0m by 9007199254740993L', "g.addV('p').property('n', 9007199254740993.0m)", "g.inject([n:9007199254740993L]).mergeV()", "g.V().count()", 2],
    // Past 2^53 a spooled criterion crosses as its double's exact digits (`stringifyExact`), not JS's
    // shortest spelling (2^55 as 36028797018963970, another number to SQLite), so the point seek finds it.
    ['a stored double 2^55 by its double', "g.addV('p').property('n', 36028797018963968.0)", "g.inject([n:36028797018963968.0]).mergeV()", "g.V().count()", 1],
    ['2^55m by 2^55m', "g.addV('p').property('n', 36028797018963968m)", "g.inject([n:36028797018963968m]).mergeV()", "g.V().count()", 1],
    ['2^55m by its double', "g.addV('p').property('n', 36028797018963968m)", "g.inject([n:36028797018963968.0]).mergeV()", "g.V().count()", 1],
    ['2^60m by 2^60m', "g.addV('p').property('n', 1152921504606846976m)", "g.inject([n:1152921504606846976m]).mergeV()", "g.V().count()", 1],
    ['2^62m by 2^62m', "g.addV('p').property('n', 4611686018427387904m)", "g.inject([n:4611686018427387904m]).mergeV()", "g.V().count()", 1],
    ['-2^55m by -2^55m', "g.addV('p').property('n', -36028797018963968m)", "g.inject([n:-36028797018963968m]).mergeV()", "g.V().count()", 1],
    ['a 19-digit decimal past 2^53', "g.addV('p').property('acct', 98765432109876543.21m)", "g.inject([acct:98765432109876543.21m]).mergeV()", "g.V().count()", 1],
    ['an edge weight 2^55m', "g.addV('a').as('a').addV('b').addE('e').from('a').property('w', 36028797018963968m)", "g.inject([(T.label):'e', w:36028797018963968m]).mergeE()", "g.E().count()", 1],
    ['a string-valued key',"g.addV('p').property('n', '1')", "g.inject([n:1]).mergeV()", "g.V().count()", 2],
    // At depth: drivers from a union of arms, a computed search after as(), and a criterion from a coalesce body.
    ['drivers from union arms', "g.addV('p').property('n', 1m).addV('p').property('n', 2.5m)", "g.inject(0).union(__.constant([n:1]), __.constant([n:2.5])).mergeV()", "g.V().count()", 2],
    ['a computed search after as()', "g.addV('p').property('n', 2.5m).addV('q').property('n', 2.5)", "g.V().hasLabel('q').as('x').mergeV(__.project('n').by(values('n')))", "g.V().count()", 2],
    ['a criterion from a coalesce body', "g.addV('p').property('n', 0.25m).addV('q').property('m', 0.25)", "g.V().hasLabel('q').mergeV(__.project('n').by(__.coalesce(values('n'), values('m'))))", "g.V().count()", 2],
  ] as const) {
    test(name, () => {
      const s = fresh();
      run(s, seed);
      run(s, merge);
      expect(count(s, check)).toBe(expected);
    });
  }
});

/** The plan of every statement a merge runs — the merge itself, not its seed. */
function plans(store: GraphStore, q: string): string[] {
  const compiled = compile(q, {});
  if (compiled.kind !== 'program') throw new Error(`expected a write program for ${q}`);
  const statements: { sql: string; binds: readonly unknown[] }[] = [];
  runSteps({
    query: <T>(sql: string, binds: readonly unknown[] = []): T[] => { statements.push({ sql, binds }); return store.query<T>(sql, binds); },
    atomically: <T>(fn: () => T): T => store.atomically(fn),
  }, compiled);
  return statements.flatMap(({ sql, binds }) => store.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`,
    binds.map((bind) => (isRowsBind(bind) ? '[]' : bind))).map((row) => row.detail));
}

describe('each numeric arm is an index SEARCH', () => {
  test('a vertex search seeks vp_decimal and the long range of vp_key_value', () => {
    const s = fresh();
    rawVertex(s, 1, 'p');
    s.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [1, 'n', 'abc', 'string']);
    const plan = plans(s, 'g.inject([n:1]).mergeV()');
    expect(plan.some((d) => /^SEARCH rsk\d+ USING INDEX vp_decimal \(key=\? AND <expr>=\?\)$/.test(d))).toBe(true);
    expect(plan.some((d) => /^SEARCH rsk\d+ USING INDEX vp_key_value \(key=\? AND value>\? AND value<\?\)$/.test(d))).toBe(true);
    expect(plan.filter((d) => /\brsk\d+\b/.test(d)).every((d) => d.startsWith('SEARCH'))).toBe(true);
  });
  test('an edge search seeks ep_decimal', () => {
    const s = fresh();
    run(s, "g.addV('a').as('a').addV('b').addE('e').from('a').property('w', 0.5m)");
    const plan = plans(s, "g.inject([(T.label):'e', w:0.5]).mergeE()");
    expect(plan.some((d) => /^SEARCH rsk\d+ USING INDEX ep_decimal \(key=\? AND <expr>=\?\)$/.test(d))).toBe(true);
  });
});
