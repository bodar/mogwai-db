import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { read, runWith } from '../support/harness.ts';
import { classify, planOf, schemaFacts } from '../../scripts/sql-plan.ts';

// AN UNBOUNDED WALK'S CONDITION MUST NOT COST A HUB'S NEIGHBOURHOOD PER WALK ROW — many walk rows reach one hub.
//  - `emit(c)` is asked over the FINISHED walk once per DISTINCT traverser state (`perState`,
//    `src/compiler/rel/walk.ts`): any head, a filtered union/coalesce/choose, an ORDER — measured 24–35× per 8×
//    when it was asked per row, ~6–7× now.
//  - `until(c)` runs INSIDE the recursive term, per frontier row (`correlatedExistence`,
//    `src/compiler/rel/lower/scoped.ts`): a `limit(n)` there is a plain LIMIT (a one-row scope has one key,
//    `src/rel/decorrelate.ts`; was 41×), a `count().is(P)` reads only as far as P can tell
//    (`boundConditionCount`, `src/compiler/ir/strategies.ts`; was 27×), and a condition whose per-row work stays a
//    neighbourhood — a barrier, or a filter, over an unbounded input — declines rather than run quadratically.
//    Its answer is a column of the walk (`EXIT`), asked once per produced row and READ by the term's stop test,
//    the exit arm and the emit arm alike.
//  - Under a scoping host (`where`/`local`/`not`/`map`/`choose`) the walk is keyed by scope, but the passing set is
//    a row-wise function of the walk rows it filters, so the decorrelator leaves it UNKEYED
//    (`existenceOverOwnRows`, `src/rel/decorrelate.ts`): one DISTINCT across scopes, a hub's condition asked once.
//    Measured `where(…emit(in('created').has(…)))` ≈17× → ≈6× per 8×.

/** `chains` chains of 6 persons (knows), each person `created` one of 20 shared software HUBS and a private leaf;
 *  `vocabulary` widens the label vocabulary by that many vertex labels and as many edge labels, each on a
 *  disconnected pair of its own. */
function hubGraph(chains: number, vocabulary = 0): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const vs: { id: string; labels: string[]; properties: { key: string; value: unknown }[] }[] = [];
  const es: { label: string; src: string; tgt: string }[] = [];
  for (let h = 0; h < 20; h++) vs.push({ id: `h${h}`, labels: ['software'], properties: [] });
  for (let c = 0; c < chains; c++) {
    for (let i = 0; i < 6; i++) {
      vs.push({ id: `p${c}_${i}`, labels: ['person'], properties: [{ key: 'age', value: 20 + ((c + i) % 30) }] });
      vs.push({ id: `l${c}_${i}`, labels: ['software'], properties: [] });
      es.push({ label: 'created', src: `p${c}_${i}`, tgt: `h${(c * 6 + i) % 20}` });
      es.push({ label: 'created', src: `p${c}_${i}`, tgt: `l${c}_${i}` });
      if (i) es.push({ label: 'knows', src: `p${c}_${i - 1}`, tgt: `p${c}_${i}` });
    }
  }
  for (let k = 0; k < vocabulary; k++) {
    vs.push({ id: `xa${k}`, labels: [`vl${k}`], properties: [] }, { id: `xb${k}`, labels: [`vl${k}`], properties: [] });
    es.push({ label: `el${k}`, src: `xa${k}`, tgt: `xb${k}` });
  }
  loadBulk(store, vs, es);
  return store;
}

/** Best of three wall times after one warm-up run. */
function timed(f: () => unknown): number {
  f();
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); f(); best = Math.min(best, performance.now() - t0); }
  return best;
}

/** 130 → 1050 chains is ~8× the walk. Linear is ≈8×, N log N ≈10×; the quadratic forms measured ~27–52×. */
const expectLinear = (small: number, large: number) => expect(large / Math.max(small, 5)).toBeLessThan(16);

const SCALE_TIMEOUT_MS = 60_000;

describe('a walk condition at a hub costs O(1) per frontier row', () => {
  const small = hubGraph(130);
  const large = hubGraph(1050);
  const count = (store: GraphStore, q: string): number => Number(runWith(store, q)[0].v);

  for (const [q, atSmall] of [
    ["g.V().repeat(out()).emit(local(in().limit(1))).count()", 7410],
    ["g.V().repeat(out()).until(local(in('created').limit(1).has('age',gt(40)))).count()", 756],
    ["g.V().repeat(out()).until(union(out('knows'),in('created')).count().is(gt(1))).count()", 2730],
    ["g.V().repeat(out()).until(in('created').count().is(gt(1))).count()", 2730],
    ["g.V().repeat(out()).emit(union(in('created'),out('knows')).has('age',gt(45))).count()", 2680],
    ["g.V().repeat(out()).emit(coalesce(in('created').has('age',gt(45)),out('nope'))).count()", 2520],
    ["g.V().repeat(out()).emit(choose(hasLabel('software'),in('created').has('age',gt(45)),out('knows'))).count()", 3820],
    ["g.V().repeat(out()).emit(optional(in('created').has('age',gt(45)))).count()", 7410],
    ["g.V().repeat(out()).emit(in('created').has('age',gt(45))).count()", 2520],
    ["g.V().repeat(out()).emit(local(in().order().by('age').limit(1))).count()", 7410],
    ["g.V().repeat(out()).until(has('age',gt(40))).emit(in('created').has('age',gt(45))).count()", 1980],
    ["g.V().repeat(out()).until(optional(in('created').has('age',gt(45)))).count()", 2210],
    // A barrier over the frontier element's OWN rows is bounded by the element, so a hub does not multiply it: it
    // stays in the term (`perHostWork`'s `readsNeighbourhood`, `src/rel/work.ts`), as until(has('age',gt(40))).
    ["g.V().repeat(out()).until(elementMap().select('age').is(gt(40))).count()", 220],
    ["g.V().repeat(out()).until(properties('age').value().is(gt(40))).count()", 220],
    ["g.V().repeat(out()).until(project('a').by(values('age')).select('a').is(gt(40))).count()", 220],
    ["g.V().repeat(out()).until(group().by(label).select(keys).count(local).is(1)).count()", 2210],
    // Beside a landed `until`, an emit condition is asked of the TRAVERSER, not of the walk row with its `EXIT`
    // column (`asked`, `walk.ts`) — so it still takes the per-state route.
    ["g.V().repeat(out()).until(hasLabel('software')).emit(local(in().limit(1))).count()", 7410],
    ["g.V().repeat(out()).until(hasLabel('software')).emit(coalesce(in('created').has('age',gt(30)),out('nope'))).count()", 5460],
    ["g.V().until(hasLabel('software')).repeat(out()).emit(coalesce(in('created').has('age',gt(30)),out('nope'))).count()", 10636],
    ["g.V().emit(local(in().limit(1))).repeat(out()).until(hasLabel('software')).count()", 8860],
    // The condition is handed the walk's labels: an outer label beside one the condition binds, and an outer label
    // the condition reads (which keys its states by that label's history, still linear).
    ["g.V().as('a').repeat(out()).until(hasLabel('software')).emit(as('b').in().where(neq('b'))).count()", 7410],
    ["g.V().as('s').where(repeat(out()).until(hasLabel('software')).emit(as('x').where('s',neq('x')).in('created'))).count()", 780],
    // A condition testing ADJACENCY to an outer label pins both endpoints of one edge read, with no label: a point
    // lookup on `e_pair(src, tgt)` (`src/storage.ts`) — without it each probe read a hub's whole in-neighbourhood
    // (24–45× per 8×). The same index serves it outside a walk, and at any label vocabulary (below).
    ["g.V().as('a').repeat(out()).emit(where(__.in().as('a'))).count()", 2210],
    ["g.V().as('a').repeat(out()).until(where(__.in().as('a'))).count()", 2210],
    ["g.V().as('a').repeat(out()).emit(as('c').select('a').out().where(eq('c'))).count()", 2210],
    ["g.V().as('a').repeat(out()).emit(where(__.both().as('a'))).count()", 2210],
    ["g.V().as('a').where(repeat(out()).emit(as('c').select('a').out().where(eq('c')))).count()", 780],
    ["g.V().as('a').local(repeat(out()).until(hasLabel('software')).emit(where(__.in().as('a'))).count()).sum()", 6110],
    ["g.V().as('a').out().where(__.in().as('a')).count()", 2210],
    ["g.V().as('a').in().where(__.out().as('a')).count()", 2210],
    ["g.V().as('a').out().as('b').where(__.both().as('a')).count()", 2210],
  ] as const) {
    test(q, () => {
      expect(count(small, q)).toBe(atSmall);
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // The adjacency probe is one seek whatever the graph's label VOCABULARY: 300 vertex and 300 edge labels beside the
  // hub graph's three. (Read through the vocabulary as `label IN (SELECT id FROM labels)`, each probe was |labels|
  // seeks — measured 26 → 787 ms for the first row at 1050 chains; 16 ms on `e_pair`.) Both sizes below carry the
  // same vocabulary, so a per-label probe cost still scales linearly between them: the guard is the PLAN SQLite
  // chose on the wide graph — the label-free probe pins `src` and `tgt` of `e_pair`, reads no label index, and the
  // plan gate's own classifier (`classify`, `scripts/sql-plan.ts`) finds nothing but the root `V()` — never a
  // wall-clock ratio between two stores, which CI noise can flip.
  test('an adjacency probe does not scale with the label vocabulary', () => {
    const wideSmall = hubGraph(130, 300);
    const wideLarge = hubGraph(1050, 300);
    const facts = schemaFacts(wideLarge);
    // Each extra edge closes back to its own start once, so a one-hop closure gains exactly 300 rows.
    for (const [q, gained] of [
      ["g.V().as('a').out().out().where(__.in().as('a')).count()", 0],
      ["g.V().as('a').repeat(out()).emit(where(__.in().as('a'))).count()", 300],
      ["g.V().as('a').out().where(__.in().as('a')).count()", 300],
    ] as const) {
      expect(count(wideLarge, q)).toBe(count(large, q) + gained);
      const got = planOf(wideLarge, q)!;
      const details = got.plan.map((r) => r.detail);
      expect(details).toContainEqual(expect.stringMatching(/^SEARCH \w+ (EXISTS )?USING COVERING INDEX e_pair \(src=\? AND tgt=\?\)$/));
      expect(details.filter((d) => /\b(e_label|labels)\b|label=\?/.test(d))).toEqual([]);
      expect(classify(got.plan, got.sql, facts).map((f) => `${f.cls}:${f.table}`)).toEqual(['root:nodes']);
      expectLinear(timed(() => runWith(wideSmall, q)), timed(() => runWith(wideLarge, q)));
    }
  }, SCALE_TIMEOUT_MS);

  // A SCOPED walk asks its emit condition once per distinct state ACROSS scopes: the DISTINCT is over the state
  // alone, never the scope key (which would merge nothing and cost ≈2.4× the per-row form).
  for (const [q, atSmall] of [
    ["g.V().where(repeat(out()).emit(in('created').has('age',gt(45)))).count()", 754],
    ["g.V().where(repeat(out()).emit(union(in('created'),out('knows')).has('age',gt(45)))).count()", 754],
    ["g.V().hasLabel('person').local(repeat(out('knows')).emit(out('knows').has('age',gt(45))).count()).sum()", 160],
    ["g.V().not(repeat(out()).emit(in('created').has('age',gt(45)))).count()", 826],
    ["g.V().map(repeat(out()).emit(in('created').has('age',gt(30))).count()).sum()", 4376],
    ["g.V().choose(repeat(out()).emit(in('created').has('age',gt(45))),constant(1),constant(2)).sum()", 2406],
    ["g.V().local(local(repeat(out()).emit(in('created').has('age',gt(30))).count())).sum()", 4376],
    ["g.V().where(repeat(out()).until(hasLabel('software')).emit(union(in('created'),out('nope')))).count()", 780],
    ["g.V().local(repeat(out()).until(hasLabel('software')).emit(choose(in('created'),constant(1))).count()).sum()", 7410],
    ["g.V().not(repeat(out()).until(hasLabel('software')).emit(local(in().limit(1)).hasLabel('person'))).count()", 800],
  ] as const) {
    test(`scoped: ${q}`, () => {
      expect(count(small, q)).toBe(atSmall);
      expect(read(q).sql.match(/SELECT DISTINCT [^)]*\)/g)).toEqual([expect.stringMatching(/^SELECT DISTINCT \w+\.id AS id FROM \w+ \w+\)$/)]);
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // A body READ IN FULL whose filter tests one element by a subquery asks it once per distinct element across
  // every host — the magic set (`src/rel/passes/magic.ts`): the hub's in-neighbourhood is read once, not once per
  // host reaching it (measured 16–41× per 8× before, ~3–4× now).
  for (const [q, atSmall] of [
    ["g.V().local(out().out().where(in().has('age',gt(50))).count()).sum()", 0],
    ["g.V().local(out().out().where(in().has('age',gt(45))).count()).sum()", 664],
    ["g.V().map(out().out().where(in().has('age',gt(45))).count()).sum()", 664],
    ["g.V().local(local(out().out().where(in().has('age',gt(45))).count())).sum()", 664],
    ["g.V().local(out().out().not(in().has('age',gt(45))).count()).sum()", 1156],
    ["g.V().local(union(out().out().where(in().has('age',gt(45))),out()).count()).sum()", 2874],
    ["g.V().local(out().out().dedup().where(in().has('age',gt(45))).count()).sum()", 664],
  ] as const) {
    test(`magic: ${q}`, () => {
      expect(count(small, q)).toBe(atSmall);
      expect(read(q).sql).toContain('AS MATERIALIZED');
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // A BOUNDED host (`rowBounds`) asks its body a constant number of times: nothing to share, so it is left as it
  // is — one vertex's two-hop neighbourhood at either size, with no domain spooled beside it.
  test("magic: a point query stays a point query — g.V('p0_1').local(out().out().where(in().has('age',gt(45))).count())", () => {
    const q = "g.V('p0_1').local(out().out().where(in().has('age',gt(45))).count())";
    expect(count(small, q)).toBe(1);
    expect(read(q).sql).not.toContain('MATERIALIZED');
    expect(timed(() => runWith(large, q)) / Math.max(timed(() => runWith(small, q)), 5)).toBeLessThan(2);
  }, SCALE_TIMEOUT_MS);

  // A test that stops at its first index seek (`perHostWork(…).exhausts` false) costs per host what the semi-join
  // probe replacing it would: nothing to share, so no domain — measured 2× slower at 8k with one. Still linear.
  for (const [q, atSmall] of [
    ['g.V().local(out().where(out()).count()).sum()', 650],
    ["g.V().project('n','f').by('name').by(out().where(out('knows')).count()).select('f').sum()", 520],
  ] as const) {
    test(`magic: a one-seek test is not rewritten — ${q}`, () => {
      expect(count(small, q)).toBe(atSmall);
      expect(read(q).sql).not.toContain('MATERIALIZED');
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // A SELECTIVE but unbounded host (one label of many) is still rewritten: no static fact tells it from a hub's
  // hosts without statistics (the R6-1 residue in `docs/archive/2026-11-16-ladder-retirement-plan.md`). Only linear.
  test("magic: a selective host stays linear — g.V().hasLabel('software').local(__.in().where(out().has('age',gt(30))).count()).sum()", () => {
    const q = "g.V().hasLabel('software').local(__.in().where(out().has('age',gt(30))).count()).sum()";
    expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
  }, SCALE_TIMEOUT_MS);

  // A host whose rows a COPY could re-pick (`picks`, `src/rel/copies.ts`): an unordered `limit` leaves its rows to
  // SQLite's plan, so a domain built from a second evaluation could hold other rows than the body reads. The
  // outermost host is read ONCE instead — one fenced CTE the host and the domain both read — so it is still
  // rewritten. Each answers as the same walk at the root does (the per-host counts sum to the root's count, and the
  // root's own collapse never uses the pass), with the rewrite and without it.
  test('magic: a host holding an unordered pick is read once, and answers as the root does', () => {
    const unordered = "g.V().limit(50).out().local(out().where(__.in().has('age',gt(30))).count()).sum()";
    const ordered = "g.V().order().by(id,desc).limit(50).out().local(out().where(__.in().has('age',gt(30))).count()).sum()";
    expect(read(unordered).sql).toMatch(/^WITH (\w+) AS MATERIALIZED \(.*LIMIT 50\).*FROM \1 /);
    expect(read(ordered).sql).toContain('AS MATERIALIZED');
    for (const q of [unordered, ordered]) {
      const atRoot = q.replace(".local(out().where(__.in().has('age',gt(30))).count()).sum()", ".out().where(__.in().has('age',gt(30))).count()");
      expect(count(large, q)).toBe(count(large, atRoot));
    }
  }, SCALE_TIMEOUT_MS);

  // NO BOUND BUT ONE ROW keeps a host per row: a `limit(k)` is a page size or a safety cap the data may stay under,
  // and a pick in the BODY's input (`out().limit(5)`) or a nested host's is WIDENED out of the domain (`unpicked`), a
  // superset of the `x` the body tests. Left per host, each measured 14–19× per 8× (quadratic at 4× more data).
  // Every one answers as its pick-free twin on this graph (a person has at most 2 `created` and 3 out-edges).
  for (const [q, atSmall] of [
    ["g.V().hasLabel('person').limit(100000).local(out('created').where(__.in('created').has('age',gt(45))).count()).sum()", 720],
    ["g.V().hasLabel('person').order().by('age').limit(100000).local(out('created').where(__.in('created').has('age',gt(45))).count()).sum()", 720],
    ["g.V().hasLabel('person').local(out().limit(5).where(__.in('created').has('age',gt(45))).count()).sum()", 720],
    ["g.V().hasLabel('person').local(out('created').limit(2).where(__.in('created').has('age',gt(45))).count()).sum()", 720],
    ["g.V().hasLabel('person').project('c').by(out('created').limit(3).where(__.in('created').has('age',gt(45))).count()).select('c').sum()", 720],
    ["g.V().hasLabel('person').local(local(out('created').limit(2).where(__.in('created').has('age',gt(45))).count())).sum()", 720],
    ["g.V().hasLabel('person').local(out('knows').limit(3).local(out('created').where(__.in('created').has('age',gt(45))).count())).sum()", 600],
    ["g.V().hasLabel('person').limit(100000).out().local(out().where(__.in().has('age',gt(45))).count()).sum()", 664],
    ["g.V().hasLabel('person').limit(100000).out('knows').local(out('created').where(__.in('created').has('age',gt(45))).count()).sum()", 600],
  ] as const) {
    test(`magic: a pick or a cap is no reason to probe per host — ${q}`, () => {
      expect(count(small, q)).toBe(atSmall);
      expect(read(q).sql).toContain('AS MATERIALIZED');
      expectLinear(timed(() => runWith(small, q)), timed(() => runWith(large, q)));
    }, SCALE_TIMEOUT_MS);
  }

  // An EXISTS body stops at its first row, so a domain would be all the work it skips: on a uniform graph of
  // out-degree 20 a passing `where` measured 10.6 ms → 505 ms at 8k with the rewrite. It keeps its short-circuit.
  test('magic: an existence body is not rewritten', () => {
    expect(read("g.V().where(out().out().where(in().has('age',gt(50)))).count()").sql).not.toContain('MATERIALIZED');
    expect(read("g.V().local(out().out().where(in().has('age',gt(50))).count()).limit(3)").sql).not.toContain('MATERIALIZED');
  });

  test('an until is asked once per walk row and read everywhere else', () => {
    const { sql } = read("g.V().repeat(out()).until(has('age',gt(40))).emit(in('created').has('age',gt(45))).count()");
    expect(sql.match(/> 40\)/g)).toHaveLength(2); // the INT and REAL spellings of the one test
    expect(sql.match(/lp0 > 0/g)).toHaveLength(1);
  });

  for (const q of [
    "g.V().repeat(out()).until(local(in().order().by('age').limit(1))).count()",
    "g.V().repeat(out()).until(union(in('created'),out('knows')).has('age',gt(45))).count()",
    "g.V().repeat(out()).until(coalesce(in('created').has('age',gt(45)),out('nope'))).count()",
    "g.V().repeat(out()).until(project('a').by(out().count()).select('a').is(0)).count()",
  ]) {
    test(`an until whose per-row work is a whole neighbourhood declines: ${q}`, () => {
      expect(() => runWith(small, q)).toThrow(/not supported/);
    });
  }
});
