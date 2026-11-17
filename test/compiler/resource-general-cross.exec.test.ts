// GRAPHSTEP'S GENERAL CROSS — a mid-traversal `V()`/`E()` the shared-read form (`lower/scoped.ts`
// `reSourcedBody`) does not state falls through to the fold's cross join (`lower/movement.ts` `reSource`):
// a prefix carrying a PATH (the split extends it, as a hop does), a read that binds a label of its OWN (it
// rides out of `local`), a rest that reads the HOST traverser under an all-rows host (`local`/`flatMap` emit
// all N × G traversers), and a carried SACK (the split keeps it). `head.split(element, this)` keeps the
// traverser's labels and sack and extends its path:
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:193-221.
//
// A FIRST-row host (`map`/`by()`/a filter) whose rest reads the host traverser stays a decline, decided from
// the query text, naming the shape; a rest that is only `select` of an outer label suggests the likely intent.
import { test, expect, describe } from 'bun:test';
import { seededStore, run, bare, bagOf } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const scalars = (g: string): unknown[] => rows(g).map((r) => r.v);
const count = (g: string): number => Number(scalars(g)[0]);
/** A path row as its members: a vertex by id, anything else by value. */
const members = (row: any): unknown[] => JSON.parse(row.list).map((m: any) => (m.t === 'vertex' ? `v${m.v.id}` : m.v));

describe('a path crosses a re-source: the split extends it', () => {
  test('map(V().count()).path() is [v, 6] per vertex', () => {
    expect(bagOf(rows('g.V().map(V().count()).path()').map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([1, 2, 3, 4, 5, 6].map((id) => JSON.stringify([`v${id}`, 6]))));
  });
  test('out().map(V().count()).path() is [v, w, 6] per edge', () => {
    const got = rows('g.V().out().map(V().count()).path()').map(members);
    expect(got).toHaveLength(6);
    expect(got.every((p) => p.length === 3 && p[2] === 6)).toBe(true);
  });
  test('under repeat().times(1)', () => expect(count('g.V().repeat(out()).times(1).map(V().count()).path().count()')).toBe(6));
  test('after simplePath()', () => expect(count('g.V().both().simplePath().map(V().count()).count()')).toBe(12));
  test('a root mid-traversal V() appends its element', () => {
    expect(bagOf(rows("g.V(1).out('knows').V().has('name','lop').path().by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([JSON.stringify(['marko', 'vadas', 'lop']), JSON.stringify(['marko', 'josh', 'lop'])]));
  });
  test('a split element is a path position simplePath() sees', () => {
    // [1, x, v] is simple where v is neither 1 nor x: 3 × 4.
    expect(count('g.V(1).out().simplePath().V().simplePath().count()')).toBe(12);
  });
  test('path labels gated on by from()', () => {
    expect(bagOf(rows("g.V(1).as('a').out().as('b').V(3).as('c').path().from('b').by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([['vadas', 'lop'], ['josh', 'lop'], ['lop', 'lop']].map((p) => JSON.stringify(p))));
  });
  test('inside a filter', () => {
    expect(count("g.V().where(map(V().count()).path().count(local).is(2)).count()")).toBe(6);
  });
});

describe('a re-sourced read that binds its own label', () => {
  test('local(V().as(x).out().select(x))', () => expect(count("g.V().local(V().as('x').out().select('x')).count()")).toBe(36));
  test('local(V().as(x).out().where(neq(x)))', () => expect(count("g.V().local(V().as('x').out().where(neq('x'))).count()")).toBe(36));
  test('local(V().values(name).as(n).select(n))', () => expect(count("g.V().local(V().values('name').as('n').select('n')).count()")).toBe(36));
  test('the label rides out of local()', () => expect(count("g.V().local(V().has('name','lop').as('x')).select('x').count()")).toBe(6));
  test('under map() the read is shared and its label shed', () => {
    expect(scalars("g.V().map(V().has('name','marko').as('m').out().select('m').values('name'))")).toEqual(Array(6).fill('marko'));
  });
  test('inside a repeat body', () => expect(count("g.V().repeat(local(V().has('name','lop').as('x').select('x'))).times(1).count()")).toBe(6));
});

describe('an all-rows host whose rest reads the host traverser', () => {
  test('as(a).local(V().as(b).select(a,b)) is N × G', () => expect(count("g.V().as('a').local(V().as('b').select('a','b')).count()")).toBe(36));
  test('each pair keeps its own host', () => {
    expect(count("g.V().as('a').local(V().as('b').select('a','b')).select('a').dedup().count()")).toBe(6);
  });
});

describe('a sack crosses a root re-source', () => {
  test('sack(assign).V().sack()', () => expect(count('g.V().sack(assign).by(constant(1)).V().sack().count()')).toBe(36));
  test('the split keeps each traverser\'s own sack', () => {
    expect(count('g.withSack(1).V().sack(sum).by(constant(2)).V().sack().sum()')).toBe(108);
  });
});

describe('a first-row host whose rest reads the host traverser declines, naming the shape', () => {
  const declines = (g: string): string => {
    try { run(s, g); } catch (error) { expect(error).toBeInstanceOf(UnsupportedTraversal); return (error as Error).message; }
    throw new Error(`expected a decline: ${g}`);
  };
  test('map(V().select(a)) suggests the likely intent', () => {
    const message = declines("g.V().as('a').map(V().select('a'))");
    expect(message).toContain('a V()/E() inside map(), by() or a filter');
    expect(message).toContain("select('a').out()");
  });
  test('a self-join idiom is named, not called confused', () => {
    const message = declines("g.V().as('a').map(V().as('b').where(eq('a')).by('name')).values('name')");
    expect(message).toContain('a V()/E() inside map(), by() or a filter');
    expect(message).not.toContain("select('a').out()");
    expect(message).not.toContain('ambiguous');
  });
});
