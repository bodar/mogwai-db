// A STORED NULL property value under a child traversal answers what the same traversal answers at the top level.
//
// No write traversal stores a null (`property(k, null)` removes the key), but a bulk or GraphSON load does
// (`src/bulk.ts` writes the value it is handed), so a vertex can hold `x = null`. `values('x')` then emits one
// null traverser — and a child body is applied per traverser exactly as the root is (`TraversalUtil.apply`), so
// `map(values('x'))` is that null (`TraversalMapStep` emits `mapTraversal.next()`,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53`)
// and `where(values('x'))` keeps the vertex (`TraversalFilterStep` keeps a traverser whose child has a next).
//
// The old ladder read a NULL first value as "no result" and dropped the vertex in both; the scoped-relation
// connector — the default since the Phase 3 inversion (`docs/2026-11-15-compositional-coverage-plan.md` cc3c) —
// asks the body's existence where its first value is NULL, and agrees with the top level.
import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { compile } from '../../src/compiler/compiler.ts';

const store = new GraphStore(new BunSqlite(':memory:'));
loadBulk(store, [
  { id: 1, labels: ['a'], properties: [{ key: 'x', value: null }] },
  { id: 2, labels: ['a'], properties: [] },
], []);
const rows = (q: string) => {
  const p = compile(q, {}, {});
  if (p.kind !== 'read') throw new Error('expected a read');
  return store.query(p.sql, p.binds);
};

describe('a stored null property under a child traversal', () => {
  test('map(values(k)) is values(k) per traverser — the null is one result', () => {
    expect(rows("g.V().values('x')")).toHaveLength(1);
    expect(rows("g.V().map(values('x'))")).toEqual(rows("g.V().values('x')"));
  });
  test('where(values(k)) keeps the vertex whose key holds a null', () => {
    expect(rows("g.V().where(values('x'))")).toHaveLength(1);
  });
});
