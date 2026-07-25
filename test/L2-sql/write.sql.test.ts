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
import { assertStreamColumns, toGroupStream, toPathStream, toPropertyStream, toRecordStream, toScalarStream, toVariantStream } from '../../src/compiler/steps/context/stream.ts';
import { popChildScope, pushChildScope, reuseCurrentFrame } from '../../src/compiler/steps/tail/child.ts';
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

describe('write SQL', () => {
  test('vertex property keys bind as parameters (static vp index, no literal splice)', () => {
    // W4: vertex props are normalized into vertex_properties; has(key,val) is an EXISTS
    // with BOTH key and value bound. The static (key,value) index serves a bound key
    // fine (a plain B-tree column, not an expression index), so no literal splice — and
    // no injection surface for any key.
    const safe = read('g.V().has("age",30)');
    expect(safe.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)');
    expect(safe.binds).toEqual(['age', 30]);

    // an exotic key (space) is handled identically — bound, never spliced into SQL
    const exotic = read('g.V().has("first name","x")');
    expect(exotic.sql).not.toContain('first name');
    expect(exotic.binds).toEqual(['first name', 'x']);
  });
});
