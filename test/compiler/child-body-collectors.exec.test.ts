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
import { bare, run, runWith, seededStore } from '../support/harness.ts';

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

  test('the same under every connector host, connector alone', () => {
    for (const host of ['sideEffect', 'local', 'flatMap', 'where', 'optional'])
      expect((bare(runWith(store, `g.V().${host}(out().aggregate('x')).cap('x').unfold().count()`, { fastPaths: { connectorOnly: true } })) as { v: unknown }[])[0]!.v).toBe(6);
  });

  test('members come host-major: a host traverser\'s body rows stay together', () => {
    // order().by('name') pins the hosts (josh, lop, marko, peter, ripple, vadas); each body is one property value.
    const names = (bare(run(store, "g.V().order().by('name').local(values('name').aggregate('x')).cap('x')")) as { list: string }[])[0]!.list;
    expect(JSON.parse(names)).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a body whose collection is read inside the same body declines, naming the collection and the host', () => {
    expect(() => run(store, "g.V().local(out().aggregate('x').cap('x'))")).toThrow(UnsupportedTraversal);
    expect(() => run(store, "g.V().local(out().aggregate('x').cap('x'))")).toThrow(/a side effect \('x'\) collected inside local\(\)/);
  });

  test('a write in a sideEffect() body still declines with its own reason', () => {
    expect(() => run(seededStore(), "g.V().sideEffect(addV('z'))")).toThrow(/a write \(addV\(\)\) inside sideEffect\(\)/);
  });
});
