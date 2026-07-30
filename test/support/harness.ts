// The four-line preamble that every compile-and-run test file used to carry.
//
// `read`, `seededStore`, `run`, `runWith` and `bare` were byte-identical copy-paste across 18-19
// files in test/L2-sql/ and test/compiler/ — ~80 duplicated definitions. Same move, and same
// directory, as test/support/decode.ts, which exists because one deserialize line had been pasted
// into ~34 assertions.
//
// The duplication was not free: the unused-code flags (docs/2026-07-30-lsp-tooling-plan.md §2)
// reported ~30 errors here, but they were not 30 defects — they were the subset of copies that
// happened to go unused in their own file, which is a property of the copying, not of the tests.
//
// Two things in the tree are NOT this and keep their local definitions: `read` in
// test/serializers.test.ts (deserialize a buffer through a serializer) and `read` in
// test/L3-conformance/glv-compat.ts (a bound `deserializeValue`) are unrelated functions that
// merely share a name.
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from './executor.ts';

/** Compile and assert a READ plan — the SQL-asserting half of L2 and the compiler tests. */
export const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

/** An in-memory store seeded by RUNNING the modern-graph write traversals. */
export function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

/**
 * Compile and execute against a seeded store, dispatching on plan kind.
 *
 * `run` is `runWith` with no options rather than a second copy of the body — passing `undefined`
 * for `options` is what `compile`'s own default already means, so the two cannot drift.
 */
export const runWith = (store: GraphStore, q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

export const run = (store: GraphStore, q: string) => runWith(store, q, undefined);

// A write-response echo carries each prop value as a self-describing {t,v} typed node (so the wire
// frames it exactly). Tests that assert the written VALUES, not their types, unwrap to plain values.
export const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;
