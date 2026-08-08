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
import { expect, test } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { ambientSpine } from '../../src/compiler/options/spine.ts';
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
export const relirOff = ambientSpine() === 'legacy';

/**
 * THE "id is taken" REFUSAL — `Graph.Exceptions.vertexWithIdAlreadyExists` /
 * `edgeWithIdAlreadyExists` (`structure/Graph.java:1364,1368`), verbatim, and the SAME on both spines.
 *
 * It is a function only so the two hosts share one spelling. It deliberately takes no `spine`: the
 * spines disagreed for a while (legacy invented a lowercased, `with`-less version and RelIR's guard
 * copied it), and the first fix here was a spine-AWARE helper that returned whichever string the
 * ambient route happened to raise. That was backwards — legacy is being deleted, so a helper teaching
 * every test to expect its wrong message is the version that OUTLIVES the route. Legacy was corrected
 * instead, at one line, and the asymmetry disappeared rather than being encoded.
 */
export const idAlreadyExists = (kind: 'Vertex' | 'Edge', id: string | number): string =>
  `${kind} with id already exists: ${id}`;

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
 *
 * `options` are the COMPILE options the refusal needs to be about the right thing. A traversal that
 * names a `call()` service refuses for two different reasons without a registry — "unknown service"
 * rather than "legacy does not serve this one" — and a proof of the wrong refusal is not a proof.
 */
/**
 * A CLAIM ABOUT THE RELIR SPINE — SKIPPED in the legacy position, never restated there.
 *
 * **Legacy is a route with an END DATE (§6·1) and is allowed to DRIFT.** Once RelIR owns a shape,
 * what that shape's DESCRIPTOR looks like on the other spine is not a fact worth committing: the
 * assertion and the route are deleted together in Phase 4. Re-stating legacy's answer beside RelIR's
 * — a `{spine:'legacy'}` pin, a `relirOff ? … : …` branch — is work that must be done once per
 * increment and thrown away exactly once, and it accumulated to roughly a dozen sites in one session
 * before anyone named it. So it gets a NAME rather than a convention, because a convention is what
 * drifted back.
 *
 * `test.skip` and not a silent pass: a skipped test is visible in the legacy run's output, so "this
 * claim is RelIR's" stays readable rather than looking like coverage that is quietly absent.
 *
 * TWO things still belong per-spine, and neither is a descriptor:
 *
 * - a divergence in the ANSWER where legacy is right and RelIR declines — that is a claim about
 *   CORRECTNESS, and the decline is what keeps the user's answer right (`relirAhead` is its mirror);
 * - a property of the PLAN that is legacy's own subject, asserted in a test that says so.
 */
export const relOnly = (name: string, body: () => void | Promise<void>): void => {
  (relirOff ? test.skip : test)(name, body);
};

export const relirAhead = (gremlin: string, body: () => void | Promise<void>, options?: CompileOptions) =>
  async (): Promise<void> => {
    if (!relirOff) return body();
    expect(() => runWith(seededStore(), gremlin, options)).toThrow();
  };

// A write-response echo carries each prop value as a self-describing {t,v} typed node (so the wire
// frames it exactly). Tests that assert the written VALUES, not their types, unwrap to plain values.
export const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

/**
 * A GROUP RESULT as a plain object — from EITHER spine.
 *
 * The two carry it differently and both are correct. Legacy's `GroupStream` emits one `(gk, gv)` ROW per
 * key and the wire handler folds the runs into a Map; a RelIR map relation carries ONE row with one
 * `map` column holding the `[[keyNode, valNode], …]` tree, and the map framer reads that. The framed
 * answer is the same Map either way.
 *
 * So a test that read `r.gk`/`r.gv` was asserting the ROUTE, and five did — every one of them failed the
 * moment `groupCount()` migrated, none of them because the answer had changed. What they mean to assert
 * is the grouping, so that is what this reads.
 */
/** A legacy group's list-valued `gv` arrives as JSON TEXT while a RelIR map's value side is already a
 *  parsed array, so "the same Map either way" is only true once the text is read back. Parsed by SHAPE
 *  rather than by try/catch, because a group whose value is a genuine string (`by('name')`) must stay a
 *  string — `'["a"]'` is a collection and `'marko'` is not. */
const collectionish = (v: unknown): unknown =>
  typeof v === 'string' && (v.startsWith('[') || v.startsWith('{')) ? JSON.parse(v) : v;

export const grouped = (rows: readonly any[]): Record<string, unknown> => {
  if (rows.length === 0) return {};
  if (rows[0] && 'gk' in rows[0]) return Object.fromEntries(rows.map((r) => [String(bare(r.gk)), bare(collectionish(r.gv))]));
  const pairs = JSON.parse(rows[0].map) as readonly (readonly [unknown, unknown])[];
  return Object.fromEntries(pairs.map(([k, v]) => [String(bare(k)), bare(v)]));
};

/**
 * WHAT A WRITE ECHOED, as `{id, labels, props}` — from EITHER spine.
 *
 * The two spell the row differently and both are right. The legacy write closure returns its own
 * `{vertex: {id, labels, props}}` record; a RelIR program frames its result rows through the READ
 * element projection, so `label`/`props` arrive as exactly the JSON text `g.V()` returns and the wire
 * layer serializes the two identically — a write reaches the same payload projection a read does.
 *
 * A test that asserted one spelling was asserting the ROUTE: the day the step joined the RelIR spine
 * it failed, having found no defect. What these tests mean to assert is what was WRITTEN, so that is
 * what this reads, and it reads it the same way whichever route answered.
 *
 * `id` is here for that same reason and arrived the same way — a `property(T.id, …)` test reached for
 * `row.edge.id`, which is the legacy spelling and nothing else. The PUBLIC id (`COALESCE(uid, id)`) is
 * as much a thing a write test means to assert as the labels are, so it belongs to the one authority
 * rather than to a `?? row` dance re-spelled per test.
 */
// `props` values are `unknown` and not `unknown[]` because the two elements genuinely differ: a VERTEX
// property is multi-valued (it has a cardinality, so each key holds a list), while an EDGE property is
// single by construction — TinkerPop's `Property` has no cardinality at all, which is the same fact
// `writeOf` enforces when it refuses a cardinality or a meta on an edge.
export const written = (row: any): { id: unknown; labels: unknown[]; props: Record<string, unknown> } => {
  const echo = row?.vertex ?? row?.edge;
  if (echo) return { id: echo.id, labels: echo.labels ?? [echo.label], props: bare(echo.props) };
  const label = row?.label;
  return {
    id: row?.id,
    labels: typeof label === 'string' && label.startsWith('[') ? JSON.parse(label) : [label],
    props: bare(typeof row?.props === 'string' ? JSON.parse(row.props) : row?.props ?? {}),
  };
};

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
