// A VERTEX ELEMENT on the wire must report EVERY label, not one.
//
// GraphBinary's Vertex `{label}` field is a bare LIST, and the client reads all of it —
// `VertexSerializer.deserializeValue` keeps `labels` and derives `.label` from `labels[0]`. So this
// is not a format change and not regime-dependent: `with("singlelabel")` governs how elementMap()/
// valueMap(true) RENDER a T.label entry, never what a vertex element carries.
//
// This lives here rather than in an L4 `.feature` because upstream's Gherkin has NO SYNTAX for
// asserting a returned vertex's label SET — `v[tux]` compares by id, which is exactly why the
// official runner never noticed. The assertion has to deserialize through the real client, so the
// level that can make it is an exec test. (Recorded as a third symptom in
// patches/upstream/tinkerpop-03-multilabel-default-untestable.md.)
//
// The one thing NOT to weaken here: assert `labels`, not `label`. The client always populates
// `.label` from `labels[0]`, so a one-label wire frame passes any `.label` assertion — that is the
// shape of the bug this file exists to keep out.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { LabelCardinality } from '../src/api.ts';
import { exec } from './support/executor.ts';
import { streamBuffers } from '../src/http.ts';
import { ioc } from '../src/io.ts';
import { ZOO_SEED } from './fixtures/seed-zoo.ts';

const zoo = () => {
  const store = new GraphStore(new BunSqlite(':memory:'), LabelCardinality.ZERO_OR_MORE);
  for (const w of ZOO_SEED) exec(store).buffers(w, {});
  return store;
};

/** Run `gremlin` and decode the response with the CLIENT's own reader, so what is asserted is what
 *  a GLV would actually see — not our own view of our own bytes. */
async function results(store: GraphStore, gremlin: string): Promise<any[]> {
  const res = streamBuffers(exec(store).framed(gremlin, {}), 64);
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  const parsed = await (ioc as any).graphBinaryReader.readResponse(Buffer.concat(chunks));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

/** `tux` is the zoo's showcase vertex: animal + bird + aquatic + endangered, which is not a
 *  hierarchy. Sorted because the wire order is the stable label-id order, not argument order. */
const TUX = ['animal', 'aquatic', 'bird', 'endangered'];
const labelsOf = (v: any): string[] => [...v.labels].sort();

describe('a vertex element carries its whole label set', () => {
  test('g.V() — the plain element leaf', async () => {
    const store = zoo();
    const [tux] = await results(store, 'g.V(1)');
    expect(labelsOf(tux)).toEqual(TUX);
    // The client still derives a single `.label` for 3.x-shaped code, and it agrees with our
    // scalar pick (`vertexLabelName` orders by label id, so both take the same first element).
    expect(tux.label).toBe('animal');
  });

  test('a single-label vertex still frames a list of one', async () => {
    const store = zoo();
    // `canopy` deliberately carries only `habitat` — the zoo's control case.
    const [v] = await results(store, "g.V().hasLabel('habitat').has('name','canopy')");
    expect(labelsOf(v)).toEqual(['habitat']);
  });

  test('every element-payload position agrees — path, select, project, group, list, Map.Entry', async () => {
    const store = zoo();
    // Each of these reaches a DIFFERENT payload builder; before they shared one authority they
    // could (and did) disagree, which is the reason this asserts all of them rather than one.
    const [path] = await results(store, 'g.V(1).path()');
    expect(labelsOf(path.objects[0])).toEqual(TUX);

    const [sel] = await results(store, "g.V(1).as('a').select('a')");
    expect(labelsOf(sel)).toEqual(TUX);

    const [proj] = await results(store, "g.V(1).project('self').by()");
    expect(labelsOf(proj.get('self'))).toEqual(TUX);

    const [folded] = await results(store, 'g.V(1).fold()');
    expect(labelsOf(folded[0])).toEqual(TUX);

    const [grouped] = await results(store, "g.V(1).group().by('name')");
    expect(labelsOf(grouped.get('tux')[0])).toEqual(TUX);
  });

  test('a multi-label vertex created by addV() reports every label in its write response', async () => {
    const store = zoo();
    const [v] = await results(store, "g.addV('animal','mammal').property('name','otto')");
    expect(labelsOf(v)).toEqual(['animal', 'mammal']);
  });

  test('addLabel() widens the set the wire reports', async () => {
    const store = zoo();
    // The write→read continuation frames through the ordinary read spine, so this pins that the
    // continuation's payload agrees with a fresh read.
    await results(store, "g.V(1).addLabel('rescued')");
    const [tux] = await results(store, 'g.V(1)');
    expect(labelsOf(tux)).toEqual([...TUX, 'rescued'].sort());
  });

  test('an EDGE frames exactly one label — cardinality ONE is fixed by the spec', async () => {
    const store = zoo();
    const [e] = await results(store, 'g.V(1).outE().limit(1)');
    expect(typeof e.label).toBe('string');
    expect(e.label.startsWith('[')).toBe(false); // not the vertex's JSON-array payload form
  });
});
