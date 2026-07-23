// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { Query } from '../../src/sql/kernel/q.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns, toGroupStream, toPathStream, toPropertyStream, toRecordStream, toScalarStream, toVariantStream } from '../../src/steps/context/stream.ts';
import { popChildScope, pushChildScope, reuseCurrentFrame } from '../../src/steps/tail/child.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { readdirSync, readFileSync } from 'node:fs';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)
function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('call / search service SQL', () => {
  test('a call() scalar body lowers through the generalized "lowers-to-scalar" child classifier', () => {
    const store = seededStore();
    const withReg: CompileOptions = { registry: standardRegistry };
    // where(call(dc).is(3)): the classifier now recognizes call() (not just values/id/label) as a
    // scalar producer, so it lowers via the generic child seam — a scoped-count LEFT JOIN over a
    // pushed child ordinal, gated by a correlated EXISTS — with NO bespoke reader.
    const wsql = read('g.V().where(call("tinker.degree.centrality").is(3))', withReg).sql;
    expect(wsql).toContain('EXISTS');
    expect(wsql).toContain('LEFT JOIN');
    // The nested child scope rides the carried origin: only lop (IN-degree 3) survives. (Result
    // shape/values are asserted end-to-end over GraphBinary in test/services.test.ts.)
    const nameOf = (id: unknown) => (run(store, `g.V(${id}).values("name")`) as any[])[0]?.v;
    const kept = runWith(store, 'g.V().where(call("tinker.degree.centrality").is(3))', withReg) as any[];
    expect(kept.map((r) => nameOf(r.id))).toEqual(['lop']);
    // group().by(call(dc)) also flows through the same generalized seam (a scalar group key).
    expect(read('g.V().group().by(call("tinker.degree.centrality")).by("name")', withReg).sql)
      .toContain('LEFT JOIN');
  });

  test('tinker.search: a source PropertyStream backed by the property_fts trigram index', () => {
    const store = seededStore();
    const withReg: CompileOptions = { registry: standardRegistry };
    // g.call("tinker.search",{search:"mar"}).element() → the matched properties' owner vertices.
    // The SQL selects from property_fts (kind='value', a case-insensitive LIKE %term%) and joins
    // back to vertex_properties + nodes + labels for the full PropertyStream payload.
    const sql = read('g.call("tinker.search", ["search": "mar"]).element()', withReg).sql;
    expect(sql).toContain('property_fts');
    expect(sql).toContain("LIKE");            // substring match through the trigram index
    expect(sql).toContain("ESCAPE");          // metachars in the user term are escaped
    // element() walks each matched property to its owner (marko), reusing the propertyElement tail.
    const names = runWith(store, 'g.call("tinker.search", ["search": "mar"]).element().values("name")', withReg) as any[];
    expect(names.map((r) => r.v)).toEqual(['marko']);
    // type=Edge searches edge properties (empty on the modern graph); VertexProperty → empty.
    expect((runWith(store, 'g.call("tinker.search", ["search": "mar"]).with("type", "Edge").element()', withReg) as any[]).length).toBe(0);
    expect((runWith(store, 'g.call("tinker.search", ["search": "mar"]).with("type", "VertexProperty").element()', withReg) as any[]).length).toBe(0);
  });
});
