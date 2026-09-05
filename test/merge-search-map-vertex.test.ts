// A map-VALUED merge driver for vertices — `inject([k:v,…]).mergeV()` / `mergeV(__.identity())`.
//
// The incoming TRAVERSER is the merge map (MergeElementStep.materializeMap with the identity/no-arg map
// traversal, vendor/tinkerpop/.../step/map/MergeElementStep.java:339-353). Its (key,value) entries are
// decomposed PER DRIVER at runtime via json_each over MAP_COL — the search KEY SET is DATA, not
// compile-time strings. First sub-increment: SCALAR-valued maps with STRING property keys (token keys
// T.label/T.id are a later sub-increment; a list-valued map declines). Validated by OUR tests — the
// corpus map-valued scenarios all carry T.label and are exercised once that lands.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from './support/executor.ts';
import { streamBuffers } from '../src/http.ts';
import { ioc } from '../src/io.ts';

function store(writes: string[]): GraphStore {
  const s = new GraphStore(new BunSqlite(':memory:'));
  for (const w of writes) executeQuery(s, w, {});
  return s;
}
async function run(s: GraphStore, gremlin: string): Promise<any[]> {
  const buffers = await executeFramed(s, gremlin, {});
  const res = streamBuffers(buffers, 64);
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  const parsed = await (ioc as any).graphBinaryReader.readResponse(Buffer.concat(chunks));
  expect(parsed.status.code).toBe(200);
  return parsed.result.data;
}

const seed = [
  "g.addV('person').property('name','marko').property('age',29)",
  "g.addV('person').property('name','vadas').property('age',27)",
];

describe('map-valued mergeV — inject([k:v]).mergeV() / mergeV(__.identity())', () => {
  test('MATCH by a single-key map returns the vertex, creates nothing', async () => {
    const s = store(seed);
    const before = await run(s, 'g.V().count()');
    expect(await run(s, "g.inject([name:'marko']).mergeV().values('name')")).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual(before);
  });

  test('__.identity() is the same as no-arg', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([name:'marko']).mergeV(__.identity()).values('name')")).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([2]);
  });

  test('MISS creates a vertex carrying the map, and returns it (labelless by default, as g.addV())', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([name:'brandnew']).mergeV().values('name')")).toEqual(['brandnew']);
    // No T.label anywhere -> no stored label row (the same state g.addV() leaves; a labelless vertex
    // reports the default 'vertex' only through the element framing, and .label() reads the raw null).
    expect(await run(s, "g.V().has('name','brandnew').count()")).toEqual([1]);
    expect(await run(s, 'g.V().count()')).toEqual([3]);
  });

  test('ALL entries must match — a multi-key map matches only a vertex with every property', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([name:'marko',age:29]).mergeV().values('name')")).toEqual(['marko']);
    // age 99 does not match marko -> a miss -> create
    expect(await run(s, "g.inject([name:'marko',age:99]).mergeV().count()")).toEqual([1]);
    expect(await run(s, "g.V().has('name','marko').count()")).toEqual([2]);
  });

  test('a numeric map value compares numerically across storage class', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([age:29.0]).mergeV().values('name')")).toEqual(['marko']); // 29.0 == stored int 29
  });

  test('TWO drivers — one matches, one creates; each carries its own vertex', async () => {
    const s = store(seed);
    expect((await run(s, "g.inject([name:'marko'],[name:'stephen']).mergeV().values('name')")).sort())
      .toEqual(['marko', 'stephen']);
    expect(await run(s, 'g.V().count()')).toEqual([3]); // marko matched, stephen created
  });

  test('DISTINCT create — two identical maps that both miss create ONE vertex', async () => {
    const s = store(seed);
    expect(await run(s, "g.inject([name:'dup'],[name:'dup']).mergeV().count()")).toEqual([2]); // both carry it
    expect(await run(s, "g.V().has('name','dup').count()")).toEqual([1]);                       // one created
  });

  test('onCreate supplies a LABEL and extra constant props for the created vertex', async () => {
    const s = store(seed);
    await run(s, "g.inject([name:'kuzu']).mergeV().option(Merge.onCreate,[T.label:'person','lang':'gremlin'])");
    expect(await run(s, "g.V().has('name','kuzu').label()")).toEqual(['person']);
    expect(await run(s, "g.V().has('name','kuzu').values('lang')")).toEqual(['gremlin']);
  });

  test('onMatch CONSTANT arm writes on the matched vertex', async () => {
    const s = store(seed);
    await run(s, "g.inject([name:'marko']).mergeV().option(Merge.onMatch,['seen':'yes'])");
    expect(await run(s, "g.V().has('name','marko').values('seen')")).toEqual(['yes']);
  });

  test('a property() TAIL runs over the merge output (matched and created alike)', async () => {
    const s = store(seed);
    await run(s, "g.inject([name:'marko']).mergeV().property('tag','m')");
    expect(await run(s, "g.V().has('name','marko').values('tag')")).toEqual(['m']);
    await run(s, "g.inject([name:'fresh']).mergeV().property('tag','c')");
    expect(await run(s, "g.V().has('name','fresh').values('tag')")).toEqual(['c']);
  });

  test('an element (non-map) driver with no-arg mergeV declines (a vertex is not a map)', async () => {
    const s = store(seed);
    await expect(run(s, "g.V().mergeV()")).rejects.toThrow();
  });
});

// TOKEN keys in the map (T.label) — the corpus map-valued scenarios (inject([T.label:…, name:…]).mergeV()).
// The map producer (mapLiteralBlob) now encodes a T token key as {t:'T', v:name}, the same shape
// valueMap(true) emits; the search narrows by the label (hasLabel over vertex_labels) and the create
// labels the vertex from it. A T.id in the map is refused (fail closed) — search/create by id is separate.
describe('map-valued mergeV with a T.label key', () => {
  const person = ["g.addV('person').property('name','marko').property('age',29)"];

  test('MATCH by [T.label, name] finds the labelled vertex, creates nothing', async () => {
    const s = store(person);
    expect(await run(s, "g.inject([T.label:'person',name:'marko']).mergeV().values('name')")).toEqual(['marko']);
    expect(await run(s, 'g.V().count()')).toEqual([1]);
  });

  test('CREATE labels the new vertex from the map T.label', async () => {
    const s = store(person);
    expect(await run(s, "g.inject([T.label:'person',name:'stephen']).mergeV().values('name')")).toEqual(['stephen']);
    expect(await run(s, "g.V().has('person','name','stephen').count()")).toEqual([1]);
    expect(await run(s, "g.V().has('name','stephen').label()")).toEqual(['person']);
    expect(await run(s, 'g.V().count()')).toEqual([2]);
  });

  test('the LABEL narrows the search — [software, marko] does not match the person marko, so it creates', async () => {
    const s = store(person);
    expect(await run(s, "g.inject([T.label:'software',name:'marko']).mergeV().count()")).toEqual([1]);
    expect(await run(s, "g.V().has('software','name','marko').count()")).toEqual([1]);
    expect(await run(s, "g.V().has('name','marko').count()")).toEqual([2]); // person marko + software marko
  });

  test('the corpus form — two maps, mergeV(__.identity()): one matches, one creates', async () => {
    const s = store(person);
    expect((await run(s, "g.inject([T.label:'person',name:'marko'],[T.label:'person',name:'stephen']).mergeV(__.identity()).values('name')")).sort())
      .toEqual(['marko', 'stephen']);
    expect(await run(s, 'g.V().count()')).toEqual([2]);
  });

  test('a T.id in the map is refused (fail closed — search/create by id is a separate feature)', async () => {
    const s = store(person);
    await expect(run(s, "g.inject([T.id:5,name:'x']).mergeV()")).rejects.toThrow(/T.id/);
  });
});
