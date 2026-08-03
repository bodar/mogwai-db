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
import { expect } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { runProgram } from '../../src/program.ts';
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
  // A RelIR program is several statements, so running it is the executor's job, not a `query` call.
  if (p.kind === 'program') return [...runProgram(store, p.program, p.tail)] as any[];
  return store.query(p.sql, p.binds);
};

export const run = (store: GraphStore, q: string) => runWith(store, q, undefined);

/**
 * IS THE RELIR SPINE OFF — the differential's other position (`mise run test:legacy-spine`).
 *
 * Read it directly ONLY for a property about the PLAN rather than the ANSWER — the statement-count
 * pin is the one case: both spines return the same rows, and what differs is that legacy spends a
 * statement per element. For a divergence in the ANSWER, use `relirAhead` below; a bare `test.skip`
 * there is the form that lets the dangerous case through.
 */
export const relirOff = process.env.MOGWAI_RELIR === '0';

/**
 * A TRAVERSAL RELIR ANSWERS AND THE LEGACY SPINE REFUSES — declared, and PROVEN in both positions.
 *
 * The RelIR route is allowed to be ahead: `mise run ci` does not include the differential, and the
 * census's spine column ratchets one way, both so that a capability legacy lacks is never a reason
 * to cripple its replacement. What the differential still has to be told is WHICH WAY ROUND a given
 * divergence goes, or it reads a deliberate improvement as a regression.
 *
 * A bare `test.skip` under `relirOff` would say that — and would say it equally well if the two
 * spines both answered and answered DIFFERENTLY, which is not an improvement but a defect. So this
 * does not skip. With RelIR off it asserts the traversal THROWS, which turns "legacy refuses this"
 * from an assumption into the thing the differential run proves. The day legacy learns the shape,
 * this fails and the caller deletes it — which is the correct end for a marker whose whole content
 * is a gap.
 *
 * `body` runs only on the RelIR side; `gremlin` is the traversal whose refusal is the claim.
 */
export const relirAhead = (gremlin: string, body: () => void) => (): void => {
  if (!relirOff) return body();
  expect(() => runWith(seededStore(), gremlin)).toThrow();
};

// A write-response echo carries each prop value as a self-describing {t,v} typed node (so the wire
// frames it exactly). Tests that assert the written VALUES, not their types, unwrap to plain values.
export const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

/**
 * A result MULTISET, for a traversal whose order nothing determines.
 *
 * No `order()` and no positional consumer means the rows come out unordered by design (Crux 4 of
 * docs/2026-07-19-canonical-emission-order.md: we order only when a consumer asks), so an exact
 * `toEqual([...])` on such a result pins SQLite's scan choice rather than our semantics — and
 * `mise run test:perturbed` is the instrument that says so out loud. Sorting by JSON compares rows
 * of any shape, including arrays of arrays.
 *
 * Use it ONLY after checking the traversal really is order-free. When the traversal DOES fix an
 * order — an `order()`, a slice, a branch's arm order — the exact assertion is the point and a
 * failure under perturbation is a defect, not fragility.
 */
export const bagOf = <T>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
