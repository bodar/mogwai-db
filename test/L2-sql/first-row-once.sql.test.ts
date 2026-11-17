// A FIRST-ROW READ IS COMPUTED ONCE. A re-sourced body under a first-row host (`map(V()…)`, `by(V()…)`, a
// filter over one) is a read that does not depend on the host traverser, so it is one relation the host's value
// and its presence test both read. Substituting the host's id through that pair must leave the untouched read
// the SAME node (`src/rel/walk.ts` `substRelId`, Calcite's `RelShuttleImpl.visitChild` rule), or it is named
// twice: two byte-identical MATERIALIZED CTEs, the graph scanned and sorted once per copy.
import { test, expect, describe } from 'bun:test';
import { bagOf, read, seededStore, run, bare } from '../support/harness.ts';

/** Every MATERIALIZED body in a plan, as text — two equal bodies are one relation named twice. */
const materializedBodies = (sql: string): string[] => {
  const bodies: string[] = [];
  for (const match of sql.matchAll(/AS MATERIALIZED \(/g)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const start = i;
    for (; i < sql.length && depth; i++) depth += sql[i] === '(' ? 1 : sql[i] === ')' ? -1 : 0;
    bodies.push(sql.slice(start, i - 1));
  }
  return bodies;
};
const duplicated = (sql: string): string[] => materializedBodies(sql).filter((body, i, all) => all.indexOf(body) !== i);

const s = seededStore();
const scalars = (g: string): unknown[] => bare(run(s, g)).map((r: any) => r.v);

describe('a first-row re-source is ONE materialized read', () => {
  for (const q of [
    "g.V().map(V().values('name'))",
    "g.V().map(V().order().by('name').values('name'))",
    "g.V().map(V().constant(null))",
    "g.V().project('a').by(V().values('name'))",
    "g.V().where(map(V().values('name')).is('marko'))",
    "g.V().local(map(V().values('name')))",
    "g.V().union(map(V().values('name')), map(V().values('age')))",
    "g.V().coalesce(map(V().values('name')), constant('x'))",
    "g.V().as('a').map(V().values('name')).select('a')",
    // One re-source in a repeat body. (`repeat(map(V())).times(2)` unrolls to TWO `map(V())` steps lowered
    // separately, so its two equal reads are two lowerings — common-subexpression elimination, not this rule.)
    "g.V().repeat(out()).times(2).map(V().values('name'))",
    "g.V().map(out().map(V().values('name')))",
  ])
    test(q, () => expect(duplicated(read(q).sql)).toEqual([]));

  test('the witness shrinks to one CTE', () => {
    const { sql } = read("g.V().map(V().values('name'))");
    expect(materializedBodies(sql)).toHaveLength(1);
  });
});

describe('the answers are unchanged', () => {
  test('map(V().values(name)) is the first name, once per vertex', () =>
    expect(scalars("g.V().map(V().values('name'))")).toEqual(Array(6).fill('marko')));
  test('an ordered re-source picks the ordered first', () =>
    expect(scalars("g.V().map(V().order().by('name').values('name'))")).toEqual(Array(6).fill('josh')));
  test('a null is still a present row', () =>
    expect(scalars('g.V().map(V().constant(null))')).toEqual(Array(6).fill(null)));
  test('a filter over the read', () =>
    expect(bare(run(s, "g.V().where(map(V().values('name')).is('marko')).count()"))[0].v).toBe(6));
});

// THE UNIT ROW IS NEVER A CTE (`isUnitValues`, `src/rel/block.ts`). Every correlated block re-sourcing from the
// constant one-row seed shares it, and `name` used to bind it — `rN AS (SELECT … FROM (VALUES (1)) …)`, read
// through a `Ref` the emitter's fold cannot erase, re-entered per host row. Left inline, each block's fold
// (`withoutUnit`) erases it.
describe('the constant unit row is not bound into a CTE', () => {
  const unitCte = /\w+ AS (MATERIALIZED )?\(SELECT [^()]* FROM \(VALUES \(1\)\) \w+\)/;
  for (const q of [
    "g.V().map(values('name'))",
    "g.V().map(out().values('name'))",
    "g.withPath().V().as('a').out().map(select('a').values('name'))",
    "g.V().out().map(values('age'))",
    "g.V().local(map(out().values('name')))",
    "g.V().where(map(out().values('name')).is('lop'))",
    "g.V().union(map(values('name')), map(out().values('name')))",
    "g.V().project('a').by(map(out().values('name')))",
    "g.V().coalesce(map(out().values('name')), constant('x'))",
    "g.V().repeat(out()).times(2).map(values('name'))",
  ])
    test(q, () => expect(read(q).sql).not.toMatch(unitCte));

  // Measured 1423 bytes while the unit row was bound, 1314 after.
  test('map(out().values(name)) stays within its byte bound', () =>
    expect(read("g.V().map(out().values('name'))").sql.length).toBeLessThanOrEqual(1314));

  test('the answers are unchanged', () => {
    expect(bagOf(scalars("g.V().map(values('name'))"))).toEqual(bagOf(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']));
    expect(bagOf(scalars("g.V().map(out().values('name'))"))).toEqual(bagOf(['vadas', 'lop', 'lop']));
    expect(bagOf(scalars("g.withPath().V().as('a').out().map(select('a').values('name'))")))
      .toEqual(bagOf(['marko', 'marko', 'marko', 'josh', 'josh', 'peter']));
    expect(bagOf(scalars("g.V().out().map(values('age'))"))).toEqual(bagOf([27, 32]));
  });
});
