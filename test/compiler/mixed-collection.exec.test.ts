// MIXED-MEMBER named collections — a label filled at sites contributing DIFFERENT member kinds
// (a vertex site beside an edge site, an element beside a value). `accumulate` produces a `mixed`
// Members arm (collection.ts): each site's members are normalised to a self-describing `{t,v}`
// envelope column, `UNION ALL`-ed in site order, and folded into a `jsonbList` whose members the wire
// frames through the ONE `frameTypedNode` rule. This is the member-level tagged union one level below
// the stream VariantArm — combinatorial completeness for a label the corpus never mixes directly, but
// which is valid Gremlin (`aggregate` is a pass-through, so any two shapes can fill one label).
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const capList = async (g: string): Promise<any[]> => {
  const [list] = await decodeAll(executeQuery(seededStore(), g, {}));
  return list as any[];
};
const kinds = (list: any[]): string[] => list.map((x) => x?.constructor?.name ?? typeof x);
const nameOf = (v: any): string => v.properties.find((p: any) => p.key === 'name').value;

describe('mixed-member collections', () => {
  test('a vertex site and an edge site fill one label — cap yields both, in site order', async () => {
    // site 1 = the 6 vertices, site 2 = the 6 out-edges. `outE()` is only a movement between the two
    // aggregates; the members are 6 vertices then 6 edges.
    const list = await capList('g.V().aggregate("a").outE().aggregate("a").cap("a")');
    expect(list.length).toBe(12);
    expect(kinds(list)).toEqual([...Array(6).fill('Vertex'), ...Array(6).fill('Edge')]);
    // the payloads survived the envelope round trip: names on the vertices, labels on the edges.
    expect(list.slice(0, 6).map(nameOf).sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    expect(new Set(list.slice(6).map((e: any) => e.label))).toEqual(new Set(['knows', 'created']));
  });

  test('an element site and a scalar site fill one label — cap yields vertices then strings', async () => {
    const list = await capList('g.V().aggregate("a").values("name").aggregate("a").cap("a")');
    expect(list.length).toBe(12);
    expect(kinds(list)).toEqual([...Array(6).fill('Vertex'), ...Array(6).fill('String')]);
    expect(list.slice(6).sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('three sites of two kinds interleave in chain order', async () => {
    // vertex, then edge, then vertex again → arms {vertex, edge}; the second vertex site follows the
    // edge site, so the multiset is 6 V + 6 E + the edges' target vertices.
    const list = await capList('g.V().aggregate("a").outE().aggregate("a").inV().aggregate("a").cap("a")');
    expect(list.length).toBe(18);
    expect(kinds(list)).toEqual([...Array(6).fill('Vertex'), ...Array(6).fill('Edge'), ...Array(6).fill('Vertex')]);
  });

  test('count(Scope.local) over a mixed list is the member count', async () => {
    const [members] = await decodeAll(executeQuery(seededStore(),
      'g.V().aggregate("a").outE().aggregate("a").cap("a").count(Scope.local)', {}));
    expect(Number(members)).toBe(12);
  });

  test('unfold() over a mixed list emits one typed traverser per member, in site order', async () => {
    // each member frames by its OWN {t,v} tag (frameTypedNode) — a vertex, an edge, a value — which is
    // what preserves a per-member type the stream variant's single static scalar arm would infer away.
    const ve = await decodeAll(executeQuery(seededStore(),
      'g.V().aggregate("a").outE().aggregate("a").cap("a").unfold()', {})) as any[];
    expect(ve.map((x) => x?.constructor?.name)).toEqual([...Array(6).fill('Vertex'), ...Array(6).fill('Edge')]);

    const vs = await decodeAll(executeQuery(seededStore(),
      'g.V().aggregate("a").values("name").aggregate("a").cap("a").unfold()', {})) as any[];
    expect(vs.map((x) => x?.constructor?.name)).toEqual([...Array(6).fill('Vertex'), ...Array(6).fill('String')]);
    expect(vs.slice(6).sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a withSideEffect list seed prepends before element members — a mixed collection', async () => {
    // `addAll([1,2,3], bulkSetOfVertices)` = [1,2,3, v…] — the seed items and the members are different
    // kinds, so the label is mixed. The seed used to decline (seedAsSite deferred it to Phase 3b).
    const list = await decodeAll(executeQuery(seededStore(),
      'g.withSideEffect("a",[1,2,3],Operator.addAll).V().aggregate("a").cap("a").unfold()', {})) as any[];
    expect(kinds(list)).toEqual(['Number', 'Number', 'Number', ...Array(6).fill('Vertex')]);
    expect(list.slice(0, 3).map(Number)).toEqual([1, 2, 3]);
  });

  test('a list seed prepends before genuinely-mixed sites, in order', async () => {
    const list = await decodeAll(executeQuery(seededStore(),
      'g.withSideEffect("a",[1,2,3],Operator.addAll).V().aggregate("a").outE().aggregate("a").cap("a").unfold()', {})) as any[];
    expect(kinds(list)).toEqual(['Number', 'Number', 'Number', ...Array(6).fill('Vertex'), ...Array(6).fill('Edge')]);
  });

  test('a non-addAll operator over mixed members declines — it acts on a value, not a multiset', async () => {
    // `sum`/`mult`/… are `(Number) a` in the reference — a ClassCastException over a heterogeneous
    // multiset — so a declared arithmetic policy over mixed sites fails closed rather than mis-folding.
    expect(() => executeQuery(seededStore(),
      'g.withSideEffect("a",1,Operator.sum).V().aggregate("a").outE().aggregate("a").cap("a")', {}))
      .toThrow(/not supported/);
  });

  test('an all-vertex label still unfolds through the element vocabulary, not the mixed one', async () => {
    // the corpus scenario: outE()/inV() are movements between two VERTEX aggregate sites, so the label
    // is homogeneous and stays `elements` — mixed is reserved for genuinely different kinds.
    const list = await decodeAll(executeQuery(seededStore(),
      'g.V().local(aggregate("a")).outE().inV().local(aggregate("a")).cap("a").unfold().dedup()', {})) as any[];
    expect(list.every((x) => x?.constructor?.name === 'Vertex')).toBe(true);
    expect(list.map((v: any) => nameOf(v)).sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });
});
