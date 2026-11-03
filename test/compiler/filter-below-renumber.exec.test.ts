// A FILTER AFTER A RE-SOURCING FAN-OUT RUNS BEFORE THE RENUMBER — `fuse`'s transpose (`src/rel/passes/fuse.ts`).
//
// `g.V().hasLabel('holder').order().by('name').V().hasLabel('person')` re-sources the graph per holder, and
// the fan-out RENUMBERS the emission order (a `ROW_NUMBER()` over holders × V). The label membership sat
// above that window, so the window sorted |holders| × |V| rows and only then kept the persons: 1.0 s at 1k
// holders, 62 s at 8k (61×) with a fixed 100 persons — a CPU wall no six-vertex fixture can see. Pushed below
// the window, the membership seeks the persons first and the sort is |holders| × |persons|: 0.15 s → 0.94 s.
//
// Sound because nothing above reads the number as a VALUE, only as an order: the filtered rows keep their
// relative order and only renumber densely. The order-sensitive answers below (a fold, a limit, a choose arm's
// limit) are the check that the ORDER survived, not merely the multiset.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { runSteps } from '../../src/program.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { bare } from '../support/harness.ts';

/** `holders` holder vertices then `others` vertices of which the first `persons` are persons, every one named. */
function graph(holders: number, others: number, persons: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  let id = 1;
  const named = (v: number, name: string) =>
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [v, 'name', name, 'string']);
  // Holder names DESCEND with id, so `order().by('name')` is not the id order and the renumber matters.
  for (let i = 0; i < holders; i++) { const v = id++; rawVertex(store, v, 'holder'); named(v, `h${String(holders - i).padStart(6, '0')}`); }
  for (let i = 0; i < others; i++) { const v = id++; rawVertex(store, v, i < persons ? 'person' : 'software'); named(v, `n${v}`); }
  raw.exec('COMMIT');
  return store;
}

function timed(store: GraphStore, q: string): { rows: any[]; ms: number } {
  const compiled = compile(q, {});
  const start = performance.now();
  const rows = compiled.kind === 'program' ? [...runSteps(store, compiled)] : store.query(compiled.sql, compiled.binds);
  return { rows: bare(rows), ms: performance.now() - start };
}

describe('a filter after a re-sourcing fan-out runs below the renumber', () => {
  test('holders × V re-sourced and filtered to persons runs inside the budget at 6k vertices', () => {
    const N = 6000;
    const store = graph(N, N, 100);
    const { rows, ms } = timed(store, "g.V().hasLabel('holder').order().by('name').V().hasLabel('person').values('name').count()");
    expect(rows).toEqual([{ v: N * 100 }]);
    // Quadratic was ~35 s at this size; linear is ~0.7 s.
    expect(ms).toBeLessThan(5000);
  });

  test('the ORDER the sort imposed survives the transpose — in the stream, under a limit, and in a choose arm', () => {
    const store = graph(3, 4, 2);
    // Holders sort h000001 (id 3), h000002 (id 2), h000003 (id 1); per holder the persons in id order (4, 5).
    const perHolder = ['n4', 'n5'];
    expect(timed(store, "g.V().hasLabel('holder').order().by('name').V().hasLabel('person').values('name').fold()").rows)
      .toEqual([{ list: JSON.stringify([...perHolder, ...perHolder, ...perHolder]) }]);
    expect(timed(store, "g.V().hasLabel('holder').order().by('name').as('h').V().hasLabel('person').limit(3).select('h').values('name').fold()").rows)
      .toEqual([{ list: JSON.stringify(['h000001', 'h000001', 'h000002']) }]);
    expect(timed(store, "g.V().hasLabel('holder').order().by('name').choose(has('name'), V().hasLabel('person').limit(3), identity()).values('name').fold()").rows)
      .toEqual([{ list: JSON.stringify(['n4', 'n5', 'n4']) }]);
  });

  test('the plan seeks the persons inside the renumbering SELECT, not above it', () => {
    const compiled = compile("g.V().hasLabel('holder').order().by('name').V().hasLabel('person').values('name').count()", {});
    if (compiled.kind !== 'read') throw new Error('expected a read plan');
    // The fan-out's renumber and the person membership share one SELECT: the membership precedes the
    // window's FROM closing, i.e. it is the window block's own WHERE.
    expect(compiled.sql).toMatch(/row_number\(\) OVER \(ORDER BY \w+\.encounter ASC, rn\.id ASC\) AS encounter FROM [^]*CROSS JOIN nodes rn WHERE rn\.id IN/);
  });
});
