// A tiny graph with USER-SUPPLIED string ids (uid set), to exercise the
// UserSuppliedIds target feature end-to-end. rowids (1,2 / 3) stay the internal
// PKs; "alice"/"bob"/"e1" are the outward-facing ids the client sees. Used to
// prove read-path edge endpoints report the external id, matching the write path.
import type { GraphStore } from '../../src/storage.ts';

export function seedUid(store: GraphStore) {
  const person = store.labelId('person');
  const knows = store.labelId('knows');

  const node = 'INSERT INTO nodes(id, uid, label) VALUES(?,?,?)';
  const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
  store.query(node, [1, 'alice', person]);
  store.query(prop, [1, 'name', 'alice']);
  store.query(node, [2, 'bob', person]);
  store.query(prop, [2, 'name', 'bob']);

  const edge = 'INSERT INTO edges(id, uid, src, label, tgt, props) VALUES(?,?,?,?,?,jsonb(?))';
  store.query(edge, [3, 'e1', 1, knows, 2, JSON.stringify({ weight: 0.5 })]);
}
