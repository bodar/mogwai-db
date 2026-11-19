// A NAMED COLLECTION READ INSIDE A CHILD BODY — `aggregate('a').where(select('a')…)`, and the keyed
// `group('a')`/`groupCount('a')` alike. The body reads the FINISHED collection (the read is the root's reduced
// relation, uncorrelated, crossed with the body's one host row — `selectCollection`, `src/compiler/rel/lower.ts`);
// Java's lazy side-effect visibility is not emulated.
//
// The collection's member relation IS the root's stream beneath the side effect, so one relation sits at two
// scopes of one plan: as the connector body's correlation target and under the collection the body reads. Two
// walker rules keep that legal, and both are what these cases pin (each used to reach the user as a bare RelIR
// error):
// - `rewriteRels` leaves an untouched node the SAME node (`src/rel/walk.ts`; Calcite's `RelShuttleImpl`), so a
//   rewrite of the body (`slicesByKeys`) does not mint a second relation under the stream's id ("relation id 'c1'
//   names two different relations in one scope");
// - `freeRelIds` does not let a relation buried in one spine input bind another input's correlation, so the
//   correlated body does not look self-contained and is not hoisted to a CTE that cannot see the outer row
//   ("no relation 'c1' is in scope").
import { describe, expect, test } from 'bun:test';
import { col, eq } from '../../src/rel/expr.ts';
import { filter, join, project, scan } from '../../src/rel/factory.ts';
import { relId } from '../../src/rel/types.ts';
import { forEachRel, freeRelIds, rewriteRels } from '../../src/rel/walk.ts';
import { bare, run, runWith, seededStore } from '../support/harness.ts';
import { CONNECTOR_ONLY } from '../L9-connector/ladder-reach.ts';
import { reevaluatedCtes } from '../support/cte-runs.ts';
import { compile } from '../../src/compiler/compiler.ts';

const values = (q: string, connectorOnly = false): unknown[] =>
  (bare(connectorOnly ? runWith(seededStore(), q, { fastPaths: CONNECTOR_ONLY }) : run(seededStore(), q)) as { v: unknown }[])
    .map((row) => row.v);

// Hand-checked on the modern graph: 6 vertices (4 person, 2 software), 6 distinct names.
const CASES: readonly (readonly [string, readonly unknown[]])[] = [
  // `a` holds all 6 vertices whichever host reads it.
  ["g.V().aggregate('a').where(select('a').count(local).is(6)).count()", [6]],
  ["g.V().aggregate('a').map(select('a').count(local)).limit(1)", [6]],
  ["g.V().aggregate('a').where(select('a').unfold().hasLabel('person')).count()", [6]],
  // {person:4, software:2} — two keys.
  ["g.V().groupCount('a').by(label).where(select('a').count(local).is(2)).count()", [6]],
  ["g.V().group('a').by(label).by(count()).where(select('a').count(local).is(1)).count()", [0]],
  // Six names, so six entries — never two.
  ["g.V().group('a').by('name').by(count()).where(select('a').unfold().count().is(2)).count()", [0]],
  // `software` has no age, so its `sum()` is empty and the key is dropped: one key.
  ["g.V().group('a').by(label).by(values('age').sum()).where(select('a').count(local).is(1)).count()", [6]],
  // At depth and under other hosts.
  ["g.V().aggregate('a').not(select('a').count(local).is(5)).count()", [6]],
  ["g.V().aggregate('a').where(map(select('a').count(local)).is(6)).count()", [6]],
  ["g.V().aggregate('a').where(where(select('a').count(local).is(6))).count()", [6]],
  ["g.V().aggregate('a').where(local(select('a').unfold().out().count().is(6))).count()", [6]],
  ["g.V().aggregate('a').repeat(where(select('a').count(local).is(6)).out()).times(1).count()", [6]],
  ["g.V().aggregate('a').union(select('a').count(local), constant(1)).sum()", [42]],
  ["g.V().aggregate('a').choose(select('a').count(local).is(6), constant('six'), constant('no')).dedup()", ['six']],
  ["g.V().aggregate('a').coalesce(select('a').unfold().has('name','nobody'), constant('x')).count()", [6]],
  ["g.V().aggregate('a').local(select('a').unfold().limit(2)).count()", [12]],
  ["g.V().as('v').aggregate('a').where(select('a').unfold().where(eq('v'))).count()", [6]],
  // Two sites accumulate (6 + 6 out-neighbours); the out-neighbours are lop×3, vadas, josh, ripple.
  ["g.V().aggregate('a').out().aggregate('a').where(select('a').count(local).is(12)).count()", [6]],
  ["g.V().out().aggregate('a').where(select('a').unfold().dedup().count().is(4)).count()", [6]],
  ["g.V().groupCount('a').by(label).where(select('a').select('person').is(4)).count()", [6]],
  ["g.V().aggregate('a').groupCount('b').by(label).where(select('b').count(local).is(2)).where(select('a').count(local).is(6)).count()", [6]],
];

describe('a named collection read inside a connector body', () => {
  for (const [q, expected] of CASES) {
    test(q, () => {
      expect(values(q)).toEqual([...expected]);
      expect(values(q, true)).toEqual([...expected]);
    });
  }
});

// The collection is ONE uncorrelated relation evaluated once per statement, never re-run per host row.
describe('the collection is evaluated once', () => {
  const store = seededStore();
  for (const [q] of CASES) {
    const p = compile(q, {});
    if (p.kind !== 'read' || !p.sql) continue;
    const sql = p.sql, binds = p.binds;
    test(q, () => expect(reevaluatedCtes(sql, store.query(`EXPLAIN QUERY PLAN ${sql}`, binds) as never)).toEqual([]));
  }
});

describe('the walker rules beneath it', () => {
  const idCol = { name: 'id', type: 'int', nullable: false } as const;
  const type = { cols: [idCol] };
  const nodes = scan({ id: relId('n'), table: 'nodes', alias: 'n', channels: [], type });
  const stream = project({ id: relId('s'), input: nodes, channels: [], type, exprs: [['id', col(nodes.id, 'id')]] });

  test('rewriteRels leaves an untouched subtree the same node', () => {
    const edges = scan({ id: relId('e'), table: 'edges', alias: 'e', channels: [], type });
    const top = join({ id: relId('j'), left: stream, right: edges, join: 'cross', channels: [], type: { cols: [idCol, { ...idCol, name: 'id2' }] } });
    const out = rewriteRels(top, (mapped) => (mapped.kind === 'scan' && mapped.id === edges.id
      ? scan({ id: relId('e'), table: 'edges', alias: 'e2', channels: [], type }) : mapped));
    const found = new Set<unknown>();
    forEachRel(out, (r) => { if (r.id === stream.id) found.add(r); });
    expect([...found]).toEqual([stream]);
    expect(rewriteRels(stream, (mapped) => mapped)).toBe(stream);
  });

  test("a relation buried in one join input does not bind the other input's correlation", () => {
    // The left input correlates to `s`; the right input holds `s` itself (a collection over the stream).
    const seed = filter({ id: relId('f'), input: nodes, channels: [], type, pred: eq(col(nodes.id, 'id'), col(stream.id, 'id')) });
    const seeded = project({ id: relId('p'), input: seed, channels: [], type, exprs: [['id', col(seed.id, 'id')]] });
    const over = project({ id: relId('q'), input: stream, channels: [], type, exprs: [['id', col(stream.id, 'id')]] });
    const both = join({ id: relId('k'), left: seeded, right: over, join: 'cross', channels: [], type: { cols: [idCol, { ...idCol, name: 'id2' }] } });
    expect([...freeRelIds(both)]).toEqual(['s']);
  });

});
