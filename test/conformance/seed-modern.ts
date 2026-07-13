// The canonical TinkerPop "modern" graph, with the exact element ids the
// official Gherkin scenarios reference. Seed an empty store before running
// the conformance suite. Vertex properties are normalized rows (W4); edge
// properties are a flat JSONB blob.
import type { GraphStore } from '../../src/storage.ts';

export function seedModern(store: GraphStore) {
  const person = store.labelId('person');
  const software = store.labelId('software');
  const knows = store.labelId('knows');
  const created = store.labelId('created');

  const node = 'INSERT INTO nodes(id, label) VALUES(?,?)';
  const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
  const addV = (id: number, label: number, props: Record<string, any>) => {
    store.query(node, [id, label]);
    for (const [k, v] of Object.entries(props)) store.query(prop, [id, k, v]);
  };
  addV(1, person, { name: 'marko', age: 29 });
  addV(2, person, { name: 'vadas', age: 27 });
  addV(3, software, { name: 'lop', lang: 'java' });
  addV(4, person, { name: 'josh', age: 32 });
  addV(5, software, { name: 'ripple', lang: 'java' });
  addV(6, person, { name: 'peter', age: 35 });

  const edge = 'INSERT INTO edges(id, src, label, tgt, props) VALUES(?,?,?,?,jsonb(?))';
  store.query(edge, [7, 1, knows, 2, JSON.stringify({ weight: 0.5 })]);
  store.query(edge, [8, 1, knows, 4, JSON.stringify({ weight: 1.0 })]);
  store.query(edge, [9, 1, created, 3, JSON.stringify({ weight: 0.4 })]);
  store.query(edge, [10, 4, created, 5, JSON.stringify({ weight: 1.0 })]);
  store.query(edge, [11, 4, created, 3, JSON.stringify({ weight: 0.4 })]);
  store.query(edge, [12, 6, created, 3, JSON.stringify({ weight: 0.2 })]);
}
