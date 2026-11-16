// The `air-routes` graph — Kelvin R. Lawrence's model of the world airline route network (3,504
// airports, 237 countries, 7 continents, 1 version vertex; 50,637 `route` + 7,008 `contains` edges),
// the dataset *Practical Gremlin: An Apache TinkerPop Tutorial* is written against.
//
// PROVENANCE AND LICENCE. `air-routes.graphml.gz` is `data/air-routes.xml` from the Apache TinkerPop
// 4.0.0-beta.3 Gremlin Server binary distribution (apache-tinkerpop-gremlin-server-4.0.0-beta.3-bin.zip,
// sha512 ec584b51…9923 per archive.apache.org), gzipped (`gzip -9 -n`); the uncompressed file's sha256 is
// 1fc49196d6b72c1c1c827becc9865ba4a5f55828c51a239e6666f67d3e16d29a. It is the same graph TinkerPop's own
// `TinkerFactory` "airroutes" dataset and `LoadGraphWith.GraphData.AIR_ROUTES` load. It is byte-identical
// (bar one typo in the header comment) to `sample-data/air-routes.graphml` in github.com/krlawrence/graph
// at ccbe3d53f2d9982b5fa9ef16715485c2bd3a0cf5. Both are distributed under the Apache License 2.0
// (TinkerPop's LICENSE; the krlawrence/graph repository's LICENSE). Author: Kelvin R. Lawrence.
// NOTE the file's own header comment asks that the data be used "as a learning aid only and not for any
// commercial use"; it is used here only as a test fixture.
//
// LOADING. Parsed from GraphML (a fixed, entity-free file, so a line reader is enough — no XML dependency)
// and landed through the set-based bulk loader (`src/bulk.ts`) with the GraphML node/edge ids as the
// element rowids — the ids TinkerGraph assigns under `vertexIdManager=LONG`, so `V(3)` means the same
// vertex on both systems. Property types follow the GraphML `attr.type` (`int` → Integer, `double` →
// Double, else String); `labelV`/`labelE` are the labels, as TinkerPop's GraphMLReader reads them.
// Seeding through write traversals would take ~60k compiles; the bulk path is the one built for this.
import { readFileSync } from 'node:fs';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk, type BulkEdge, type BulkProperty, type BulkVertex } from '../../src/bulk.ts';
import type { CanonicalType } from '../../src/gremlin/types.ts';

const FILE = new URL('./air-routes.graphml.gz', import.meta.url);

interface Key { readonly name: string; readonly type: CanonicalType }

/** Parse the GraphML document into bulk vertices and edges. */
export function parseAirRoutes(xml: string): { vertices: BulkVertex[]; edges: BulkEdge[] } {
  const keys = new Map<string, Key>();
  for (const m of xml.matchAll(/<key id='(\w+)'\s+for='\w+'\s+attr\.name='(\w+)'\s+attr\.type='(\w+)'/g))
    keys.set(m[1]!, { name: m[2]!, type: m[3] === 'int' ? 'int' : m[3] === 'double' ? 'double' : 'string' });
  const vertices: BulkVertex[] = [];
  const edges: BulkEdge[] = [];
  const element = /<(node|edge) id='(\d+)'(?: source='(\d+)' target='(\d+)')?>([\s\S]*?)<\/\1>/g;
  for (const m of xml.matchAll(element)) {
    let label = m[1] === 'node' ? 'vertex' : 'edge';
    const properties: BulkProperty[] = [];
    for (const d of m[5]!.matchAll(/<data key='(\w+)'>([^<]*)<\/data>/g)) {
      const key = keys.get(d[1]!);
      if (!key) throw new Error(`air-routes: undeclared GraphML key '${d[1]}'`);
      if (key.name === 'labelV' || key.name === 'labelE') { label = d[2]!; continue; }
      const raw = d[2]!;
      const value = key.type === 'string' ? raw : Number(raw);
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`air-routes: bad ${key.type} '${raw}'`);
      properties.push({ key: key.name, value, vtype: key.type });
    }
    if (m[1] === 'node') vertices.push({ id: Number(m[2]), labels: [label], properties });
    else edges.push({ id: Number(m[2]), label, src: Number(m[3]), tgt: Number(m[4]), properties });
  }
  return { vertices, edges };
}

let snapshot: Uint8Array | undefined;

/** A fresh, independent in-memory store holding air-routes. The parse + load runs once per process and
 *  is snapshotted (the `seeded` idiom in test/support/graph.ts); each call restores a private copy. */
export function airRoutes(): GraphStore {
  if (!snapshot) {
    const raw = new BunSqlite(':memory:');
    const { vertices, edges } = parseAirRoutes(new TextDecoder().decode(Bun.gunzipSync(readFileSync(FILE))));
    if (vertices.length !== 3749 || edges.length !== 57645)
      throw new Error(`air-routes: parsed ${vertices.length} vertices / ${edges.length} edges, expected 3749 / 57645`);
    loadBulk(new GraphStore(raw), vertices, edges);
    snapshot = raw.serialize();
  }
  return new GraphStore(BunSqlite.fromSnapshot(snapshot));
}
