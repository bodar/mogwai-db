// L9 — the ladder-reach ENGINE (`ladder-reach.ts`): its two measurement modes do what the ratchet counts them as,
// and its family attribution is the rule it states. The ratchet itself runs in `connector-closure.test.ts`, over
// the closure sweep it shares.
//
// The witnesses are today's ladder-only answers (`docs/2026-11-16-ladder-retirement-plan.md`). A retirement step
// that closes one (R3 the existence draw, R2 the join width) moves its expectation here in the same commit, as it
// moves the ratchet's count.
import { describe, expect, test } from 'bun:test';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { seeded } from '../support/graph.ts';
import { reach, familyOf, counts } from './ladder-reach.ts';

const store = seeded(MODERN_SEED);
const run = (q: string) => reach([{ pool: 'W', q, store }]);

describe('L9 — ladder reach engine', () => {
  test('a draw a later step filters, under an existence host: the default answers, the connector alone declines', () => {
    const r = run("g.V().where(out().sample(1).has('age')).values('name')");
    expect(r.ladderOnly.map((x) => [x.family, x.rescued])).toEqual([['existence', false]]);
  });

  // A TRAILING draw is trimmed from an existence body (`existencePrefix`), so the connector answers it.
  test('a trailing draw under an existence host: both answer, and agree', () => {
    const r = run("g.V().where(out().sample(1)).values('name')");
    expect(r.ladderOnly).toEqual([]);
    expect(r.differ).toEqual([]);
  });

  test('an alias compare by() a traversal: the connector alone answers it, and the two agree', () => {
    const r = run("g.V().as('a').out().as('b').where('a', gt('b')).by(out().count())");
    expect(r.ladderOnly).toEqual([]);
    expect(r.differ).toEqual([]);
  });

  // R2: the emitter closes a join side past SQLite's width, so neither order needs the other's plan.
  test('a join too wide for one SELECT is answered by the connector alone, with no retry', () => {
    const r = run('g.V().local(repeat(out()).times(63)).count()');
    expect({ ladderOnly: r.ladderOnly.length, differ: r.differ, rescued: counts(r).rescued }).toEqual({ ladderOnly: 0, differ: [], rescued: 0 });
  });

  test('a traversal both modes answer is not ladder-only, and agrees', () => {
    const r = run("g.V().where(out('created')).values('name')");
    expect({ ladderOnly: r.ladderOnly.length, differ: r.differ, pools: r.pools.W }).toEqual({ ladderOnly: 0, differ: [], pools: { queries: 1, byDefault: 1, connectorOnly: 1 } });
  });

  test('a ladder-only answer is charged to its DEEPEST family host, at any depth and under any host', () => {
    expect(familyOf("g.V().map(__.where(__.out()))")).toBe('existence');
    expect(familyOf("g.V().where(__.map(__.out()))")).toBe('per-traverser');
    expect(familyOf("g.V().union(__.local(__.group().by(label).by(__.out().count())))")).toBe('group');
    expect(familyOf("g.V().as('a').out().where('a', gt('a')).by(__.out().count())")).toBe('existence');
    expect(familyOf("g.V().project('x').by(__.coalesce(__.out(), __.in()))")).toBe('other');
    expect(familyOf('g.V().out()')).toBe('other');
  });
});
