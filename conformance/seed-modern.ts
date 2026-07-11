// The canonical TinkerPop "modern" graph, with the exact element ids the
// official Gherkin scenarios reference. Seed an empty store before running
// the conformance suite.
import type { GraphStore } from '../src/storage.js';

export function seedModern(store: GraphStore) {
  const person = store.labelId('person');
  const software = store.labelId('software');
  const knows = store.labelId('knows');
  const created = store.labelId('created');

  const v = store.db.prepare('INSERT INTO nodes(id, label, props) VALUES(?,?,?)');
  v.run(1, person, JSON.stringify({ name: 'marko', age: 29 }));
  v.run(2, person, JSON.stringify({ name: 'vadas', age: 27 }));
  v.run(3, software, JSON.stringify({ name: 'lop', lang: 'java' }));
  v.run(4, person, JSON.stringify({ name: 'josh', age: 32 }));
  v.run(5, software, JSON.stringify({ name: 'ripple', lang: 'java' }));
  v.run(6, person, JSON.stringify({ name: 'peter', age: 35 }));

  const e = store.db.prepare('INSERT INTO edges(id, src, label, tgt, props) VALUES(?,?,?,?,?)');
  e.run(7, 1, knows, 2, JSON.stringify({ weight: 0.5 }));
  e.run(8, 1, knows, 4, JSON.stringify({ weight: 1.0 }));
  e.run(9, 1, created, 3, JSON.stringify({ weight: 0.4 }));
  e.run(10, 4, created, 5, JSON.stringify({ weight: 1.0 }));
  e.run(11, 4, created, 3, JSON.stringify({ weight: 0.4 }));
  e.run(12, 6, created, 3, JSON.stringify({ weight: 0.2 }));
}
