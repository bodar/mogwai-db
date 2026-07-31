import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { LabelCardinality } from '../src/api.ts';
import { loadGraphson, graphsonValue, writeGraphson } from '../src/formats/graphson.ts';
import { executeQuery } from './support/executor.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { CREW_SEED } from './fixtures/seed-crew.ts';
import { ZOO_SEED } from './fixtures/seed-zoo.ts';
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

// ---------- the writer (v4) ----------

/**
 * The CANONICAL projection a round-trip is compared on: every column the format carries, and none it
 * does not.
 *
 * Two local ids are deliberately excluded, because GraphSON has no field for either and a round-trip
 * therefore cannot preserve them — asserting on them would be asserting that two loads happened to
 * intern in the same order:
 *
 *   `labels.id`          — an interning rowid. The NAME is what the file carries, so vertex_labels and
 *                          edges are joined to it and compared by name.
 *   `edge_properties.id` — TinkerPop's edge `Property` has no id at all (unlike a VertexProperty,
 *                          whose id the file DOES carry and this projection therefore keeps).
 *
 * Everything else is compared exactly, storage class included: `typeof(value)` is what catches a type
 * that survived as a name but not as a representation (an int re-read as a real).
 */
const CANONICAL: Array<[string, string]> = [
  ['nodes', 'SELECT id, uid FROM nodes ORDER BY id'],
  ['vertex_labels',
    `SELECT vl.node AS node, l.name AS label FROM vertex_labels vl JOIN labels l ON l.id = vl.label
     ORDER BY node, label`],
  ['vertex_properties',
    `SELECT id, node, key, value, typeof(value) AS storage, vtype,
            CASE WHEN meta IS NULL THEN NULL ELSE json(meta) END AS meta
     FROM vertex_properties ORDER BY node, key, id`],
  ['edges',
    `SELECT e.id AS id, e.uid AS uid, e.src AS src, l.name AS label, e.tgt AS tgt
     FROM edges e JOIN labels l ON l.id = e.label ORDER BY e.id`],
  ['edge_properties', 'SELECT edge, key, value, typeof(value) AS storage, vtype FROM edge_properties ORDER BY edge, key'],
  ['property_fts',
    `SELECT owner_elem, owner, pk, kind, text FROM property_fts
     ORDER BY owner_elem, owner, pk, kind, text`],
];

const canonical = (store: GraphStore) =>
  Object.fromEntries(CANONICAL.map(([name, sql]) => [name, store.query(sql).map((r: any) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `blob:${Buffer.from(v).toString('hex')}` : v])))]));

/** Write `store` out and read it back into a fresh one — the round trip both gates assert on. */
function roundTrip(store: GraphStore, cardinality?: LabelCardinality): { document: string; reloaded: GraphStore } {
  const document = writeGraphson(store);
  const reloaded = fresh(cardinality);
  loadGraphson(reloaded, document);
  return { document, reloaded };
}

describe('the v4 writer round-trips every reference graph', () => {
  for (const file of ['tinkerpop-modern-v3.json', 'tinkerpop-crew-v3.json', 'tinkerpop-sink-v3.json']) {
    test(`${file}: load → write v4 → load is canonically identical`, () => {
      const store = fresh();
      loadGraphson(store, fixture(file));
      const { reloaded } = roundTrip(store);
      expect(canonical(reloaded)).toEqual(canonical(store));
    });
  }

  test('grateful-dead: 808 vertices and 8,049 edges survive a whole-graph dump', () => {
    // The scale case, and the one that says the drain is not accidentally O(n²): it pages the vertices
    // (keysetPages) and chunks every per-page read, all under the CF-parity store.
    const store = fresh();
    loadGraphson(store, fixture('grateful-dead-v3.json'));
    const { document, reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));
    expect(document.split('\n').length).toBe(808);
  });

  test('the output is v4: a label ARRAY, and one line per vertex', () => {
    const store = fresh();
    loadGraphson(store, fixture('tinkerpop-modern-v3.json'));
    const lines = writeGraphson(store).split('\n');
    expect(lines.length).toBe(6);
    const first = JSON.parse(lines[0]);
    expect(first.label).toEqual(['person']);
    expect(first.id).toEqual({ '@type': 'g:Int32', '@value': 1 });
    // Both incidence directions, because TinkerPop's own readGraph reads the IN side — a file with
    // only outE reads as edgeless there. Vertex 1 is marko: three outE, no inE.
    expect(Object.keys(first.outE).sort()).toEqual(['created', 'knows']);
    expect(JSON.parse(lines[1]).inE.knows[0].outV).toEqual({ '@type': 'g:Int32', '@value': 1 });
  });
});

describe('the round trip preserves what the type channel carries', () => {
  test('multi-label vertices survive — the assertion a v3 writer could not pass', () => {
    // gzoo is the multi-label showcase (ten of its thirteen vertices carry several labels). v3's
    // `label` is ONE bare string, so a v3 writer is lossy for exactly the graph that exercises the
    // feature we declare (§4c); v4's label array is what makes this test possible.
    const store = new GraphStore(new BunSqlite(':memory:'), LabelCardinality.ZERO_OR_MORE);
    for (const q of ZOO_SEED) executeQuery(store, q, {});
    const { document, reloaded } = roundTrip(store, LabelCardinality.ZERO_OR_MORE);
    expect(canonical(reloaded)).toEqual(canonical(store));
    // Not vacuous: the graph really does carry multi-label vertices, and one deliberately single one.
    const labelCounts = JSON.parse(document.split('\n')[0]).label;
    expect(labelCounts).toEqual(['animal', 'bird', 'aquatic', 'endangered']);
    expect(executeQuery(reloaded, "g.V().hasLabel('endangered').count()", {}))
      .toEqual(executeQuery(store, "g.V().hasLabel('endangered').count()", {}));
  });

  test('the exact-tail and time types survive: long > 2^53, BigDecimal, Duration, datetime, uuid', () => {
    const store = fresh();
    for (const q of [
      'g.addV("typed").property(T.id,1)'
      + '.property("n", 9007199254740993L)'
      + '.property("bd", 3.141592653589793238462643383279M)'
      + '.property("du", Duration(90, 500000000))'
      + '.property("dt", datetime("2024-01-01T00:00:00Z"))'
      + '.property("u", UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c"))',
    ]) executeQuery(store, q, {});
    const { document, reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));

    // The exact-digit types must reach the file as bare JSON NUMBERS, not as strings: JSON numbers are
    // arbitrary-precision by spec (max-long-v4.json is 9223372036854775807), and a string would be a
    // different value to every other reader.
    expect(document).toContain('{"@type":"g:Int64","@value":9007199254740993}');
    expect(document).toContain('{"@type":"g:BigDecimal","@value":3.141592653589793238462643383279}');
    // ISO-8601 for both time types, the spelling the corpus fixtures use.
    expect(document).toContain('{"@type":"g:Duration","@value":"PT1M30.5S"}');
    expect(document).toContain('{"@type":"g:DateTime","@value":"2024-01-01T00:00:00.000Z"}');
  });

  test('a NEGATIVE duration round-trips — it was WRITE-ONLY until the ISO parser moved onto Duration', () => {
    // The writer negates the COMPONENTS (`PT-2M-3.5S`, matching negative-duration-v4.json) and the
    // reader's own regex accepted only `(\d+)M` — so a negative duration went out in a spelling our
    // own reader refused. Nothing caught it because every fixture and every other assertion here uses
    // a positive one; it surfaced only when CSV needed the same parser and it moved onto `Duration`.
    const store = fresh();
    loadGraphson(store, '{"id":{"@type":"g:Int32","@value":1},"label":["t"],"properties":{"d":['
      + '{"id":{"@type":"g:Int64","@value":1},"value":{"@type":"g:Duration","@value":"PT-2M-3.5S"}}]}}');
    expect(store.query('SELECT value FROM vertex_properties')).toEqual([{ value: '-123500000000' }]);
    const { document, reloaded } = roundTrip(store);
    expect(document).toContain('{"@type":"g:Duration","@value":"PT-2M-3.5S"}');
    expect(canonical(reloaded)).toEqual(canonical(store));
    // The other legal spelling of the same value — one leading sign, which some producers emit.
    expect(Duration.fromIso('-PT2M3.5S').totalNanos()).toBe(-123_500_000_000n);
  });

  test('typed collections survive, including a typed map KEY', () => {
    const store = fresh();
    executeQuery(store, 'g.addV("c").property(T.id,1).property("tags", ["a","brave"])', {});
    loadGraphson(store, JSON.stringify({
      id: { '@type': 'g:Int32', '@value': 2 },
      label: ['c'],
      properties: {
        scores: [{
          id: { '@type': 'g:Int64', '@value': 99 },
          value: { '@type': 'g:Map', '@value': [{ '@type': 'g:Int64', '@value': 7 }, { '@type': 'g:Double', '@value': 1.5 }] },
        }],
      },
    }));
    const { document, reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));
    // The map went out as the flat alternating array with its key still a g:Int64.
    expect(document).toContain('{"@type":"g:Map","@value":[{"@type":"g:Int64","@value":7},{"@type":"g:Double","@value":1.5}]}');
    expect(document).toContain('{"@type":"g:List","@value":["a","brave"]}');
  });

  test('a user-supplied string id round-trips as a bare string id', () => {
    const store = fresh();
    loadGraphson(store, [
      '{"id":"v:a","label":["person"],"outE":{"knows":[{"id":"e:ab","inV":"v:b"}]}}',
      '{"id":"v:b","label":["person"]}',
    ].join('\n'));
    const { document, reloaded } = roundTrip(store);
    expect(canonical(reloaded)).toEqual(canonical(store));
    expect(document).toContain('"id":"v:a"');
    expect(document).toContain('"inV":"v:b"');
  });
});
