// A uniform pick of an EDGE followed by `otherV()` — `bothE().sample(1).otherV()`, and its
// `order().by(shuffle).limit(1)` spelling (rewritten into `sample(1)`). `sample` keeps rows whole and its
// fenced RANDOM() window carries every channel (`perOriginWindow`, src/compiler/rel/build.ts), so the edge's
// entering vertex survives the draw and `otherV()` reads it — `sample` is in `FROM_V_TRANSPARENT`
// (src/compiler/rel/lower.ts). `otherV()` is the edge end that is not the path's previous object
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java),
// and a sample is a pure filter over its traversers
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/SampleGlobalStep.java),
// so the step between them does not change which vertex is "other". This is the TinkerPop random-walk recipe.
import { describe, expect, test } from 'bun:test';
import { bare, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const count = (q: string): number => bare(run(store, q))[0].v;

describe('a sampled edge feeds otherV()', () => {
  test('global: one edge drawn over the whole stream yields one vertex', () => {
    expect(count('g.V().bothE().sample(1).otherV().count()')).toBe(1);
    expect(count('g.V().bothE().order().by(shuffle).limit(1).otherV().count()')).toBe(1);
    expect(count('g.V().bothE().sample(3).otherV().count()')).toBe(3);
  });

  test('per traverser: one neighbour for every vertex with an edge, in every child host', () => {
    // modern: every vertex has at least one edge; 4 have an in-edge; 3 have an out-edge.
    expect(count('g.V().local(__.bothE().order().by(shuffle).limit(1).otherV()).count()')).toBe(6);
    expect(count('g.V().local(__.bothE().sample(1)).otherV().count()')).toBe(6); // the forwarding rejoin
    expect(count('g.V().flatMap(__.inE().order().by(shuffle).limit(1).otherV()).count()')).toBe(4);
    expect(count('g.V().map(__.outE().order().by(shuffle).limit(1).otherV()).count()')).toBe(3);
    expect(count("g.V().project('a').by(__.bothE().sample(1).otherV().values('name')).count()")).toBe(6);
    expect(count('g.V().optional(__.outE().sample(1).otherV()).count()')).toBe(6);
    // degrees 3,1,3,3,1,1 → min(2, d) summed
    expect(count('g.V().local(__.bothE().sample(2).otherV()).count()')).toBe(9);
    // a filter or a label between the draw and otherV() keeps the entering vertex
    expect(count("g.V().local(__.bothE().sample(1).as('e').has('weight', gt(0)).otherV()).count()")).toBe(6);
  });

  test('the drawn neighbour is ADJACENT to the vertex it was drawn from', () => {
    // each person's neighbour set; a wrong "other" end would name the vertex itself
    const neighbours: Record<string, string[]> = {
      marko: ['vadas', 'josh', 'lop'], vadas: ['marko'], lop: ['marko', 'josh', 'peter'],
      josh: ['marko', 'ripple', 'lop'], ripple: ['josh'], peter: ['lop'],
    };
    for (let i = 0; i < 10; i++) {
      const rows = bare(run(store, "g.V().as('s').local(__.bothE().sample(1).otherV()).as('o').select('s','o').by('name')"));
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        const m = Object.fromEntries((JSON.parse(r.map) as [{ v: string }, { v: string }][]).map(([k, v]) => [k.v, v.v]));
        expect(neighbours[m.s!]).toContain(m.o!);
      }
    }
  });

  test('inside a repeat body: the random walk', () => {
    expect(count("g.V().hasLabel('person').repeat(__.local(__.bothE().order().by(shuffle).limit(1).otherV())).times(2).count()")).toBe(4);
    for (let i = 0; i < 10; i++) {
      const paths = bare(run(store, 'g.V(1).repeat(__.local(__.bothE().sample(1).otherV())).times(4).path()'));
      expect(paths).toHaveLength(1);
      const objs = JSON.parse(paths[0].list) as { t: string; v: { id: number; src: number; tgt: number } }[];
      // 5 vertices with the 4 drawn edges between them
      expect(objs.map((o) => o.t)).toEqual(['vertex', 'edge', 'vertex', 'edge', 'vertex', 'edge', 'vertex', 'edge', 'vertex']);
      expect(objs[0]!.v.id).toBe(1);
      for (let k = 1; k < objs.length; k += 2) {
        const [a, e, b] = [objs[k - 1]!.v.id, objs[k]!.v, objs[k + 1]!.v.id];
        expect([[e.src, e.tgt], [e.tgt, e.src]]).toContainEqual([a, b]);
      }
    }
  });

  test('the pick is uniform over the edges', () => {
    // josh (4) has one edge each to ripple, lop and marko. 300 draws: each share lands in [0.2, 0.47]
    // with overwhelming probability (≈ 6σ either side of 1/3).
    const seen: Record<string, number> = {};
    const draws = 300;
    for (let i = 0; i < draws; i++) {
      const [row] = bare(run(store, "g.V(4).local(__.bothE().sample(1).otherV()).values('name')"));
      seen[row.v] = (seen[row.v] ?? 0) + 1;
    }
    expect(Object.keys(seen).sort()).toEqual(['lop', 'marko', 'ripple']);
    for (const n of Object.values(seen)) {
      expect(n / draws).toBeGreaterThanOrEqual(0.2);
      expect(n / draws).toBeLessThanOrEqual(0.47);
    }
  });
});
