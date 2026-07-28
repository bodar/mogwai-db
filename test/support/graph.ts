import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { exec } from './executor.ts';

// Shared graph-minting primitives. These began in `test/L5-properties/oracle.ts`; they moved here
// when the census (test/census/) became a second consumer, because a helper used by two levels
// that lives inside one of them is how a third consumer ends up hand-rolling a copy.

/** Seed a fresh in-memory graph by running write traversals through the normal query path (the
 *  same way every other test seeds — no runtime-specific store hook). */
export function seeded(seed: readonly string[]): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of seed) exec(store).buffers(q, {});
  return store;
}

/** Mints a graph at a known baseline state. A READ shares one store (reads don't mutate); a WRITE
 *  needs a fresh one per run, or the second run would see the first's mutations and "diverge" on
 *  rowids alone — a harness artifact, not a defect. */
export type StoreFactory = () => GraphStore;

/** Does this traversal mutate? Decided by the compiler's own routing (`kind === 'write'`), not by
 *  string-matching for addV/drop — a chain like `V().property(k,v)` is a write with no add* in it,
 *  and the compiler is the only authority on which chains route to routeWrite. A traversal that
 *  fails to compile is not a write (it will throw identically however it is run).
 *
 *  NOTE this uses a bare `compile()`, so it sees no service registry: a `call()` traversal throws
 *  here and is reported as a non-write, which is correct (no `call()` form is a write today). Do
 *  NOT reuse this as a general "does it compile" probe — see the header on test/census/census.ts. */
export function isWrite(q: string): boolean {
  try { return compile(q, {}).kind === 'write'; } catch { return false; }
}
