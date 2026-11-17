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

  // `deferred-hosts.ts` scope `host-owned` is the authority: a family host beneath such a position is the host's
  // own lowering's, not the ladder's, so it charges `other` — at any depth, and wherever the host-owned site is.
  test('a family host beneath a HOST-OWNED position charges `other`', () => {
    // The Grateful Dead match() with a map() pattern (L1): match() is its own lowering (`rel/match.ts`).
    expect(familyOf('g.V().match(__.as("a").has("song", "name", "HERE COMES SUNSHINE"), __.as("a").map(__.inE("followedBy").values("weight").mean()).as("b"), __.as("a").inE("followedBy").as("c"), __.as("c").filter(__.values("weight").where(P.gte("b"))).outV().as("d")). select("d").by("name")')).toBe('other');
    expect(familyOf('g.V().where(__.repeat(__.out().map(__.out())).times(2))')).toBe('other');
    expect(familyOf("g.V().map(__.choose(label()).option('person', __.where(__.out())))")).toBe('other');
    expect(familyOf("g.V().hasLabel('person').local(__.choose(__.values('age')).option(P.between(26, 30), __.values('name').fold()).option(Pick.none, __.values('name').fold()))")).toBe('other');
    expect(familyOf("g.V().addV('x').property('n', __.map(__.out().count()))")).toBe('other');
    // The deepest site still decides: a family host deeper than the host-owned one, elsewhere in the query.
    expect(familyOf("g.V().local(__.union(__.repeat(__.out()).times(2), __.map(__.group().by(__.out().count()))))")).toBe('group');
    // A family host BESIDE a host-owned position (not beneath it) is still charged — at its depth, too.
    expect(familyOf("g.V().where(__.out()).repeat(__.out()).times(2)")).toBe('existence');
    expect(familyOf('g.V().repeat(__.both("followedBy")).times(2).group("a").by("songType").by(__.count()).cap("a")')).toBe('group');
    // A `ladder`-scoped deferral is not host-owned: what is beneath it is charged as before.
    expect(familyOf("g.V().sideEffect(__.map(__.out()))")).toBe('per-traverser');
  });

  // FIRES (`ladder-reach.ts`): a draw is compiled under its first child order alone, so a `CopiedDraw` there is
  // counted whatever the default did. After R2b no draw's first order declines with it; N7 reads 0 over the pools.
  test('a draw is checked for a CopiedDraw retry fire, and does not fire once R2b closed it', () => {
    const r = reach(["g.V().local(out().sample(1).union(identity(), identity()))", "g.V().project('a','b').by(out().sample(1)).by(out().sample(1))"].map((q) => ({ pool: 'W', q, store })));
    expect({ fires: r.fires, counted: counts(r).fires, differ: r.differ, random: r.random.length }).toEqual({ fires: [], counted: 0, differ: [], random: 2 });
  });
});
