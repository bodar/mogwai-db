// The canonical TinkerPop "crew" graph (TinkerFactory.generateTheCrew) — the
// multi/meta-property showcase: `location` is a list-cardinality property whose each
// value carries startTime/endTime meta-properties. Element ids match the official
// scenarios. Vertex properties are normalized rows (W4); meta rides the JSONB `meta`
// column; edge properties are a flat JSONB blob.
import type { GraphStore } from '../../src/storage.ts';

export function seedCrew(store: GraphStore) {
  const person = store.labelId('person');
  const software = store.labelId('software');
  const develops = store.labelId('develops');
  const uses = store.labelId('uses');
  const traverses = store.labelId('traverses');

  const node = 'INSERT INTO nodes(id, label) VALUES(?,?)';
  const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
  const metaProp = 'INSERT INTO vertex_properties(node, key, value, meta) VALUES(?,?,?,jsonb(?))';
  const addV = (id: number, label: number, name: string) => { store.query(node, [id, label]); store.query(prop, [id, 'name', name]); };
  addV(1, person, 'marko');
  addV(7, person, 'stephen');
  addV(8, person, 'matthias');
  addV(9, person, 'daniel');
  addV(10, software, 'gremlin');
  addV(11, software, 'tinkergraph');

  // location: list-cardinality, each value with startTime[/endTime] meta-properties.
  const loc = (nodeId: number, value: string, meta: Record<string, number>) =>
    store.query(metaProp, [nodeId, 'location', value, JSON.stringify(meta)]);
  loc(1, 'san diego', { startTime: 1997, endTime: 2001 });
  loc(1, 'santa cruz', { startTime: 2001, endTime: 2004 });
  loc(1, 'brussels', { startTime: 2004, endTime: 2005 });
  loc(1, 'santa fe', { startTime: 2005 });
  loc(7, 'centreville', { startTime: 1990, endTime: 2000 });
  loc(7, 'dulles', { startTime: 2000, endTime: 2006 });
  loc(7, 'purcellville', { startTime: 2006 });
  loc(8, 'bremen', { startTime: 2004, endTime: 2007 });
  loc(8, 'baltimore', { startTime: 2007, endTime: 2011 });
  loc(8, 'oakland', { startTime: 2011, endTime: 2014 });
  loc(8, 'seattle', { startTime: 2014 });
  loc(9, 'spremberg', { startTime: 1982, endTime: 2005 });
  loc(9, 'kaiserslautern', { startTime: 2005, endTime: 2009 });
  loc(9, 'aachen', { startTime: 2009 });

  const edge = 'INSERT INTO edges(id, src, label, tgt, props) VALUES(?,?,?,?,jsonb(?))';
  const e = (id: number, src: number, label: number, tgt: number, props: Record<string, any>) =>
    store.query(edge, [id, src, label, tgt, JSON.stringify(props)]);
  e(13, 1, develops, 10, { since: 2009 });
  e(14, 1, develops, 11, { since: 2010 });
  e(15, 1, uses, 10, { skill: 4 });
  e(16, 1, uses, 11, { skill: 5 });
  e(17, 7, develops, 10, { since: 2010 });
  e(18, 7, develops, 11, { since: 2011 });
  e(19, 7, uses, 10, { skill: 5 });
  e(20, 7, uses, 11, { skill: 4 });
  e(21, 8, develops, 10, { since: 2012 });
  e(22, 8, uses, 10, { skill: 3 });
  e(23, 8, uses, 11, { skill: 3 });
  e(24, 9, uses, 10, { skill: 5 });
  e(25, 9, uses, 11, { skill: 3 });
  e(26, 10, traverses, 11, {});
}
