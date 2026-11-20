// `local(<edge body>).otherV()` — the connector's FORWARDING rejoin (`allRows('forward')`, `lowerBody`'s `fromV`,
// src/compiler/rel/lower/scoped.ts). `LocalStep` emits the CHILD's own traverser
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88),
// so an `otherV()` after it reads the child path's previous object — the vertex the body's edge hop entered from
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java:44-55)
// — and the body's tail edge hop must mint it. The deleted ladder route did this through `childRows`; R7
// (docs/archive/2026-11-16-ladder-retirement-plan.md) moved it onto the connector, at any depth. The L3 witness is
// `g_VX4X_localXbothE_limitX2XX_otherV_name`.
import { describe, expect, test } from 'bun:test';
import { bagOf, bare, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const names = (q: string): string[] => bagOf(bare(run(store, q)).map((r: { v: string }) => r.v));
const lists = (q: string): string[] => bagOf(bare(run(store, q)).map((r: { list: string }) => JSON.stringify((JSON.parse(r.list) as string[]).sort())));

describe('local(<edge body>).otherV() reads the vertex the body entered from', () => {
  test('at the top level: every neighbour, across both directions', () => {
    expect(names("g.V().local(bothE()).otherV().values('name')")).toEqual(bagOf([
      'vadas', 'lop', 'josh', 'marko', 'lop', 'ripple', 'marko', 'marko', 'josh', 'lop', 'josh', 'peter',
    ]));
  });

  test('inside a map() body and under a union() arm', () => {
    expect(lists("g.V().map(local(outE()).otherV().values('name').fold())")).toEqual(bagOf(
      [['josh', 'lop', 'vadas'], [], [], ['lop', 'ripple'], [], ['lop']].map((l) => JSON.stringify(l)),
    ));
    expect(names("g.V().union(local(outE()).otherV(), local(inE()).otherV()).values('name')")).toEqual(
      names("g.V().local(bothE()).otherV().values('name')"),
    );
  });

  test('a body that slices per traverser: the heaviest out-edge of each vertex', () => {
    const rows = bare(run(store, "g.V().project('n').by(local(outE().order().by('weight', desc).limit(1)).otherV().values('name'))"))
      .map((r: { map: string }) => (JSON.parse(r.map) as [{ v: string }, { v: string }][]).map(([, v]) => v.v).join());
    // marko's heaviest is josh (1.0), josh's ripple (1.0), peter's lop (0.2); the rest have no out-edge.
    expect(bagOf(rows)).toEqual(bagOf(['josh', 'ripple', 'lop', '', '', '']));
  });

  test('the forwarded path keeps the body\'s edge', () => {
    expect(bagOf(bare(run(store, "g.V(4).local(bothE()).otherV().path().by('name').by(label)"))
      .map((r: { list: string }) => (JSON.parse(r.list) as { v: string }[]).map((p) => p.v).join('/'))))
      .toEqual(bagOf(['josh/created/lop', 'josh/created/ripple', 'josh/knows/marko']));
  });
});
