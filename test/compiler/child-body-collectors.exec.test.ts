// A side effect collected inside a CHILD body (`sideEffect`/`local`/`where`/… — R6): the connector lowers the body
// into a FORK of the named collections, so each collector site is PENDING (correlated to the body's one host row),
// then keys the body's tail AND every pending site in ONE decorrelation (`keyedBody`, `src/compiler/rel/lower/scoped.ts`;
// `decorrelateAll`, `src/rel/decorrelate.ts`) and commits the keyed sites to the host's registry. The answers are in
// `test/L4-addendum/child-body-collectors.feature`; this file pins the pieces a scenario cannot see.
import { describe, expect, test } from 'bun:test';
import { decorrelateAll } from '../../src/rel/decorrelate.ts';
import { col, eq } from '../../src/rel/expr.ts';
import { filter, project, scan } from '../../src/rel/factory.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { relId } from '../../src/rel/types.ts';
import { forEachRel } from '../../src/rel/walk.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { bare, read, run, runWith, seededStore } from '../support/harness.ts';

const store = seededStore();
const one = (q: string): unknown => (bare(run(store, q)) as { v: unknown }[])[0]!.v;

describe('decorrelateAll: several plans over one outer row share ONE memo', () => {
  const idCol = { name: 'id', type: 'int', nullable: false } as const;
  const outer = scan({ id: relId('o'), table: 'nodes', alias: 'o', channels: [], type: { cols: [idCol] } });
  // A correlated prefix (`edges WHERE src = outer.id`) read by two plans — a body's tail and a collector site.
  const edges = scan({ id: relId('e'), table: 'edges', alias: 'e', channels: [], type: { cols: [idCol] } });
  const prefix = filter({ id: relId('p'), input: edges, channels: [], type: edges.type, pred: eq(col(edges.id, 'id'), col(outer.id, 'id')) });
  const reader = (name: string): Rel => project({ id: relId(name), input: prefix, channels: [], type: prefix.type, exprs: [['id', col(prefix.id, 'id')]] });
  let n = 0;
  const fresh = (hint: string) => relId(`${hint}${n++}`);
  const nodesNamed = (r: Rel, id: string): Set<Rel> => {
    const found = new Set<Rel>();
    forEachRel(r, (x) => { if (x.id === id) found.add(x); });
    return found;
  };

  test('the shared prefix is ONE keyed node in both answers, not two rewrites of it', () => {
    const out = decorrelateAll([reader('a'), reader('b')], outer, 'id', fresh, undefined, () => true);
    expect(out).not.toBeNull();
    const [a, b] = out!;
    const inA = [...nodesNamed(a!.rel, 'p')], inB = [...nodesNamed(b!.rel, 'p')];
    expect(inA).toHaveLength(1);
    expect(inB).toEqual(inA);
  });
});

describe('a collector in a child body', () => {
  test('counts every host traverser once — the body rows, at the collector', () => {
    expect(one("g.V().sideEffect(out().aggregate('x')).cap('x').unfold().count()")).toBe(6);
    expect(one("g.V().both().sideEffect(aggregate('x')).cap('x').unfold().count()")).toBe(12);
    expect(one("g.V().sideEffect(out().aggregate('x').local(out().aggregate('x'))).cap('x').unfold().count()")).toBe(8);
  });

  test('the same under every connector host', () => {
    for (const host of ['sideEffect', 'local', 'flatMap', 'where', 'optional'])
      expect((bare(runWith(store, `g.V().${host}(out().aggregate('x')).cap('x').unfold().count()`)) as { v: unknown }[])[0]!.v).toBe(6);
  });

  test('members come host-major: a host traverser\'s body rows stay together', () => {
    // order().by('name') pins the hosts (josh, lop, marko, peter, ripple, vadas); each body is one property value.
    const names = (bare(run(store, "g.V().order().by('name').local(values('name').aggregate('x')).cap('x')")) as { list: string }[])[0]!.list;
    expect(JSON.parse(names)).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('the host position orders the members off the domain — no rejoin of the site to the host stream', () => {
    // `scopedSite` reads the host's encounter from the decorrelation's domain (`decorrelateAll`'s `carry`); a second
    // read of the scoped host relation would be a self-join of every site row back to it.
    const { sql } = read("g.V().order().by('name').local(out().aggregate('x')).cap('x')");
    const scope = sql.match(/^WITH (r\d+) AS/)![1]!;
    // The scope relation is read ONCE by the site: its body's own scan, with the host position beside it.
    expect(sql.match(new RegExp(`(FROM|JOIN) ${scope} `, 'g'))).toHaveLength(1);
    const names = (bare(run(store, "g.V().order().by('name').local(out().values('name').aggregate('x')).cap('x')")) as { list: string }[])[0]!.list;
    expect(JSON.parse(names).sort()).toEqual(['josh', 'lop', 'lop', 'lop', 'ripple', 'vadas']);
  });

  test('a body whose collection is read inside the same body declines, naming the collection and the host', () => {
    expect(() => run(store, "g.V().local(out().aggregate('x').cap('x'))")).toThrow(UnsupportedTraversal);
    expect(() => run(store, "g.V().local(out().aggregate('x').cap('x'))")).toThrow(/a side effect \('x'\) collected inside local\(\)/);
  });

  test('a write in a sideEffect() body still declines with its own reason', () => {
    expect(() => run(seededStore(), "g.V().sideEffect(addV('z'))")).toThrow(/a write \(addV\(\)\) inside sideEffect\(\)/);
  });
});

// THE COST OF READING A BODY-FILLED COLLECTION. Inlined, the keyed site re-joins the whole scope relation inside a
// membership probe evaluated per outer row — O(N²), measured 59–75× from 1k to 8k vertices. Spooled (one fenced
// relation, `spooledSite`) and probed by one uncorrelated `IN` (`memberOf`), it is linear: ~8–9× (`bun
// scripts/scaling-probe.ts --only collect`). These pin the plan facts that make it so.
describe('reading a body-filled collection', () => {
  test('the keyed site is ONE materialized relation, probed by an uncorrelated IN — never a per-row EXISTS', () => {
    for (const q of [
      "g.V().sideEffect(out().aggregate('x')).where(without('x')).count()",
      "g.V().local(out().aggregate('x')).where(within('x')).count()",
      "g.V().sideEffect(out().values('name').aggregate('x')).values('name').where(within('x')).count()",
    ]) {
      const { sql } = read(q);
      expect(sql.match(/AS MATERIALIZED/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/ IN \(SELECT/);
      expect(sql).not.toMatch(/EXISTS \(SELECT 1 AS one FROM \(SELECT/);
    }
  });

  test('without() is the negated 0/1 probe, never NOT IN (whose miss rescans the set for a NULL member)', () => {
    const { sql } = read("g.V().sideEffect(out().aggregate('x')).where(without('x')).count()");
    expect(sql).not.toMatch(/NOT IN/);
    expect(sql).toMatch(/CASE WHEN \S+ IN \(SELECT/);
  });

  test('answers what the barrier form does', () => {
    const names = (q: string): string[] => (bare(run(store, q)) as { v: string }[]).map((row) => row.v).sort();
    expect(names("g.V().sideEffect(out().aggregate('x')).where(without('x')).values('name')")).toEqual(['marko', 'peter']);
    expect(names("g.V().local(out().aggregate('x')).where(without('x')).values('name')")).toEqual([]);
    expect(names("g.V().sideEffect(out().values('name').aggregate('x')).values('name').where(without('x'))")).toEqual(['marko', 'peter']);
    expect(one("g.V().sideEffect(out().aggregate('x')).where(within('x')).count()")).toBe(4);
  });
});
