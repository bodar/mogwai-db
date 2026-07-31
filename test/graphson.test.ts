import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { LabelCardinality } from '../src/api.ts';
import { loadGraphson, graphsonValue } from '../src/formats/graphson.ts';
import { executeQuery } from './support/executor.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { BigDecimal, Duration } from '../src/gremlin/types.ts';

// The typed GraphSON adjacency reader (src/formats/graphson.ts) — read against the corpus's own
// whole-graph fixtures, which is the only authority on the format.
//
// Two properties are worth separating, because only the first is byte-level:
//
//   SEMANTIC equivalence with the hand-authored seeds — the same traversals give the same answers.
//   That is what the conformance host depends on, and L3's count is the wider assertion of it.
//
//   ID equivalence is NOT claimed for a file load, and deliberately: the file carries VertexProperty
//   ids (crew's first `name` instance is id 0) and the reader PRESERVES them, where the write path
//   mints 1..N in encounter order. Preserving them is the point — a lossless format round-trips
//   `vertex_properties.id`, and TinkerPop asserts VertexProperty ids in its own crew scenarios. So
//   the byte-identity gate lives in test/bulk.test.ts, over the same INPUT both ways.

const GRAPHSON = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';
const fixture = (name: string) => readFileSync(new URL(`../${GRAPHSON}/${name}`, import.meta.url).pathname, 'utf8');

const fresh = (cardinality?: LabelCardinality) => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')), cardinality);
const seededByTraversals = (seed: readonly string[]) => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of seed) executeQuery(store, q, {});
  return store;
};

describe('graphsonValue — the type channel, 17 for 17', () => {
  const decode = (json: string) => graphsonValue(JSON.parse(json));

  test('every scalar @type maps onto a canonical type', () => {
    expect(decode('{"@type":"g:Int32","@value":5}')).toEqual({ value: 5, type: 'int' });
    expect(decode('{"@type":"g:Int64","@value":5}')).toEqual({ value: 5, type: 'long' });
    expect(decode('{"@type":"g:Double","@value":1.0}')).toEqual({ value: 1, type: 'double' });
    expect(decode('{"@type":"g:Float","@value":1.5}')).toEqual({ value: 1.5, type: 'float' });
    expect(decode('{"@type":"gx:Byte","@value":3}')).toEqual({ value: 3, type: 'byte' });
    expect(decode('{"@type":"gx:Int16","@value":3}')).toEqual({ value: 3, type: 'short' });
    expect(decode('{"@type":"gx:Char","@value":"x"}')).toEqual({ value: 'x', type: 'char' });
    expect(decode('{"@type":"g:UUID","@value":"41d2e28a-20a4-4ab0-b379-d810dede3786"}'))
      .toEqual({ value: '41d2e28a-20a4-4ab0-b379-d810dede3786', type: 'uuid' });
    expect(decode('"bare"')).toEqual({ value: 'bare', type: 'string' });
    expect(decode('true')).toEqual({ value: true, type: 'boolean' });
  });

  test('the exact-tail types keep their carrier, so nothing rounds through a double', () => {
    // A big integer written as a string is exact; written as a JSON number it has already lost bits
    // before we see it, which is why the string spelling is the one that matters.
    expect(decode('{"@type":"gx:BigInteger","@value":"9007199254740993"}'))
      .toEqual({ value: 9007199254740993n, type: 'bigint' });
    const dec = decode('{"@type":"gx:BigDecimal","@value":"3.141592653589793238462643383279"}');
    expect(dec.type).toBe('bigdecimal');
    expect(String(dec.value)).toBe(String(BigDecimal.from('3.141592653589793238462643383279')));
    // gx:Duration is ISO-8601; our carrier is total nanos.
    expect((decode('{"@type":"gx:Duration","@value":"PT1M30.5S"}').value as Duration).totalNanos())
      .toBe(90_500_000_000n);
    // A datetime is epoch-millis internally (the same representation datetime('…') produces).
    expect(decode('{"@type":"gx:DateTime","@value":"2018-03-22T00:35:44.741Z"}'))
      .toEqual({ value: Date.parse('2018-03-22T00:35:44.741Z'), type: 'datetime' });
  });

  test('containers carry a per-leaf type tree, and g:Map keys are typed', () => {
    expect(decode('{"@type":"g:List","@value":[{"@type":"g:Int32","@value":1},"a"]}'))
      .toEqual({ value: [1, 'a'], type: { t: 'list', items: ['int', 'string'] } });
    expect(decode('{"@type":"g:Set","@value":[{"@type":"g:Int32","@value":1}]}'))
      .toEqual({ value: new Set([1]), type: { t: 'set', items: ['int'] } });
    // The flat alternating [k,v,k,v] array exists precisely so a key can be typed.
    const map = decode('{"@type":"g:Map","@value":[{"@type":"g:Int64","@value":7},"seven"]}');
    expect(map.value).toEqual(new Map([[7, 'seven']]));
    expect(map.type).toEqual({ t: 'map', entries: { 7: { key: 'long', value: 'string' } } });
  });

  test('an unknown @type fails closed rather than landing an inferred type', () => {
    // Silently dropping the type would store the value with a guessed vtype — a wrong answer in the
    // one channel this format exists to preserve.
    expect(() => decode('{"@type":"g:Metrics","@value":{}}')).toThrow(/unsupported @type "g:Metrics"/);
  });
});

describe('the reference graphs load from their own GraphSON files', () => {
  test('modern: identical answers to MODERN_SEED, and the file KEEPS the types the old seed dropped', () => {
    const store = fresh();
    loadGraphson(store, fixture('tinkerpop-modern-v3.json'));
    const reference = seededByTraversals(MODERN_SEED);
    for (const q of [
      'g.V().count()', 'g.E().count()',
      "g.V().has('name','marko').out('knows').values('name').order().fold()",
      "g.V().hasLabel('software').in('created').values('name').order().fold()",
      "g.E().has('weight',P.gt(0.4)).count()",
      "g.V().values('age').order().fold()",
      "g.V().has('name',TextP.containing('ark')).values('name').fold()",
    ])
      expect([q, executeQuery(store, q, {})]).toEqual([q, executeQuery(reference, q, {})]);

    // The old string-building seed (test fixture, now retired) unwrapped every @type and re-emitted a
    // bare literal, so `{"@type":"g:Double","@value":1.0}` re-entered as the integer 1. The typed
    // reader keeps it a double — this is the assertion that says the type channel survived the file.
    expect(store.query<{ vtype: string }>("SELECT DISTINCT vtype FROM edge_properties WHERE key='weight'"))
      .toEqual([{ vtype: 'double' }]);
    expect(store.query<{ vtype: string }>("SELECT DISTINCT vtype FROM vertex_properties WHERE key='age'"))
      .toEqual([{ vtype: 'int' }]);
  });

  test('crew: multi-properties, meta-properties and preserved VertexProperty ids', () => {
    const store = fresh();
    loadGraphson(store, fixture('tinkerpop-crew-v3.json'));
    const reference = seededByTraversals(CREW_SEED);
    for (const q of [
      'g.V().count()', 'g.E().count()',
      "g.V().has('name','marko').properties('location').count()",
      "g.V().has('name','marko').properties('location').value().order().fold()",
      "g.V().has('name','marko').out('develops').values('name').order().fold()",
    ])
      expect([q, executeQuery(store, q, {})]).toEqual([q, executeQuery(reference, q, {})]);

    // The file's own VertexProperty ids, preserved — marko's first `name` instance is id 0 there.
    expect(store.query<{ id: number }>("SELECT id FROM vertex_properties WHERE node=1 AND key='name'"))
      .toEqual([{ id: 0 }]);
    // Meta-properties land as the flat {metaKey: value} JSONB bag the write path builds.
    expect(store.query<{ meta: string }>(
      "SELECT json(meta) AS meta FROM vertex_properties WHERE node=1 AND key='location' ORDER BY id LIMIT 1")
      .map((r) => JSON.parse(r.meta)))
      .toEqual([{ startTime: 1997, endTime: 2001 }]);
  });

  test('grateful-dead: 808 vertices and 8,049 edges, batched and DO-legal', () => {
    const store = fresh();
    const stats = loadGraphson(store, fixture('grateful-dead-v3.json'));
    expect([stats.vertices, stats.edges]).toEqual([808, 8049]);
    // The plan measured the write-traversal seed at 98,198 statements (11.1 per element) and 5,918 ms.
    // Statement count is the deterministic half of that win, so it is what gets asserted.
    expect(stats.statements).toBeLessThan(2000);
    // 8,936 property_fts rows — the figure the REAL write path produces (plan doc §1a). A loader with
    // its own FTS walk produced 9,023 in the probe that motivated propertyFtsRows; this is the number
    // that says both paths share the walk.
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM property_fts')[0].n).toBe(8936);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM vertex_properties')[0].n).toBe(1976);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edge_properties')[0].n).toBe(7047);
    expect(executeQuery(store, "g.V().has('name','HEY BO DIDDLEY').out('followedBy').count()", {}).length).toBe(1);
  });

  test('sink: the self-loop graph keeps its integer ids (V(1000)/V(2000) scenarios)', () => {
    const store = fresh();
    loadGraphson(store, fixture('tinkerpop-sink-v3.json'));
    expect(store.query<{ id: number }>('SELECT id FROM nodes ORDER BY id').map((r) => r.id)).toEqual([1000, 2000, 2001]);
    // Its two self-loops (edge 1001 on `loops`, edge 2003 on a `message`) each land ONCE, even though
    // an adjacency file lists them twice — as that vertex's outE AND its inE. Only outE is read.
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges WHERE src=tgt')[0].n).toBe(2);
    expect(store.query<{ n: number }>('SELECT count(*) AS n FROM edges')[0].n).toBe(3);
  });
});

describe('v3 and v4 differ in exactly one field, and the other artefacts fail closed', () => {
  // No v4 line-oriented adjacency fixture ships with the corpus (every `-v4` file is a detached
  // `g:Vertex` or the `g:graph` container), so the v4 label form is exercised against a document in
  // the shape our own writer emits.
  const v4 = [
    '{"id":{"@type":"g:Int32","@value":1},"label":["person","employee"],'
      + '"properties":{"name":[{"id":{"@type":"g:Int64","@value":1},"value":"marko"}]},'
      + '"outE":{"knows":[{"id":{"@type":"g:Int32","@value":7},"inV":{"@type":"g:Int32","@value":2},'
      + '"properties":{"weight":{"@type":"g:Double","@value":0.5}}}]}}',
    '{"id":{"@type":"g:Int32","@value":2},"label":["person"]}',
    '{"id":{"@type":"g:Int32","@value":3},"label":[]}',
  ].join('\n');

  test('a v4 label ARRAY lands as the label set, including multi-label and none', () => {
    const store = fresh(LabelCardinality.ZERO_OR_MORE);
    loadGraphson(store, v4);
    expect(store.query<{ id: number; labels: string | null }>(
      `SELECT n.id AS id, group_concat(l.name, ',') AS labels FROM nodes n
       LEFT JOIN vertex_labels vl ON vl.node = n.id LEFT JOIN labels l ON l.id = vl.label
       GROUP BY n.id ORDER BY n.id`))
      .toEqual([{ id: 1, labels: 'person,employee' }, { id: 2, labels: 'person' }, { id: 3, labels: null }]);
    // A zero-label vertex is zero rows in vertex_labels — the representation ZERO_OR_MORE needs.
    expect(executeQuery(store, "g.V().hasLabel('employee').count()", {}).length).toBe(1);
  });

  test('a g:Vertex or g:graph document is refused by name, not read as an adjacency line', () => {
    // Both are real GraphSON and both are the WRONG artefact here (plan doc §4c·1). Reading one as an
    // adjacency line would take `id` as undefined and land a vertex under the uid "undefined".
    expect(() => loadGraphson(fresh(), fixture('multi-label-vertex-v4.json').replace(/\n\s*/g, '')))
      .toThrow(/"g:Vertex" is not the line-oriented adjacency form/);
    expect(() => loadGraphson(fresh(), fixture('tinker-graph-v4.json').replace(/\n\s*/g, '')))
      .toThrow(/"g:graph" is not the line-oriented adjacency form/);
  });

  test('a malformed line names its line number', () => {
    expect(() => loadGraphson(fresh(), '{"id":{"@type":"g:Int32","@value":1},"label":"a"}\n{oops'))
      .toThrow(/GraphSON line 2:/);
  });
});
