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
import { runWith } from '../support/harness.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';
import { reach, familyOf, counts, CONNECTOR_ONLY } from './ladder-reach.ts';

const store = seeded(MODERN_SEED);
const run = (q: string) => reach([{ pool: 'W', q, store }]);

describe('L9 — ladder reach engine', () => {
  test('a draw a later step filters, under an existence host: CLOSED (R2b) — the connector alone answers it, per scope row', () => {
    // A draw is the connector's: always decorrelated, one draw per host row (`scopedBody`, `decorrelate.ts`).
    // A draw (`isNondeterministic`) still counts in its pool, but its answers are not compared: two runs of it
    // differ whatever the modes do, so it lands in `random`, never in `differ`.
    const q = "g.V().where(out().sample(1).has('age')).values('name')";
    const r = run(q);
    expect({ ladderOnly: r.ladderOnly.length, differ: r.differ, random: r.random, pools: r.pools.W })
      .toEqual({ ladderOnly: 0, differ: [], random: [`W\t${q}`], pools: { queries: 1, byDefault: 1, connectorOnly: 1 } });
  });

  // The per-scope draw checked BY VALUE: of the modern vertices only marko has a `knows` edge, and both vertices
  // he knows (vadas, josh) have an age, so whichever is drawn the answer is [marko] — in both modes, every run.
  test('a draw whose outcome is deterministic: [marko] under the default and the connector alone', () => {
    const q = "g.V().where(out('knows').sample(1).has('age')).values('name')";
    for (const fastPaths of [DEFAULT_FAST_PATHS, CONNECTOR_ONLY]) expect(runWith(store, q, { fastPaths }).map((r) => r.v)).toEqual(['marko']);
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
