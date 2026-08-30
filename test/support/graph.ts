import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { exec } from './executor.ts';

// Shared graph-minting primitives. These began in `test/L5-properties/oracle.ts`; they moved here
// when the census (test/L7-census/) became a second consumer, because a helper used by two levels
// that lives inside one of them is how a third consumer ends up hand-rolling a copy.

/** Insert a vertex at a KNOWN rowid with its labels, by raw SQL — the fixture shape used by the
 *  handful of tests that need exact ids (a self-loop, a 40-deep chain, the 5k perf graph). A
 *  vertex's labels live in `vertex_labels`, so this is two statements; going through
 *  `addVertexLabels` keeps the set semantics (and the interning) in one place. */
export function rawVertex(store: GraphStore, id: number, ...labelNames: string[]): void {
  store.query('INSERT INTO nodes(id) VALUES(?)', [id]);
  store.addVertexLabels(id, labelNames);
}

// Minting a seed graph is expensive: each seed traversal re-compiles through the whole antlr→IR→SQL
// pipeline (~87ms for MODERN_SEED), and L5 + the census mint once PER corpus traversal — so that cost
// was paid thousands of times per run and dominated both (measured 2026-08-21: ~65% of every L5
// traversal). But a seed is a STABLE array reference (MODERN_SEED is a module const), so its compiled
// result is memoisable: compile once, snapshot the database to bytes, and restore an independent
// writable copy per call in ~0.8ms (110× faster). The copy is isolated — a write mutates only its own,
// rowids reset (no AUTOINCREMENT) — so this preserves EXACTLY the fresh-store-per-mint semantics the
// differential and census rely on; it just stops recompiling the same graph. Keyed by array reference:
// a one-off seed built inline compiles as before; the hot MODERN_SEED path pays one compile per process.
const snapshotCache = new WeakMap<readonly string[], Uint8Array>();

/** Seed a fresh in-memory graph by running write traversals through the normal query path (the
 *  same way every other test seeds — no runtime-specific store hook). Memoised per seed reference:
 *  see `snapshotCache` above. */
export function seeded(seed: readonly string[]): GraphStore {
  let snapshot = snapshotCache.get(seed);
  if (snapshot === undefined) {
    const raw = new BunSqlite(':memory:');
    const store = new GraphStore(raw);
    for (const q of seed) exec(store).buffers(q, {});
    snapshot = raw.serialize();
    snapshotCache.set(seed, snapshot);
  }
  return new GraphStore(BunSqlite.fromSnapshot(snapshot));
}

/** Mints a graph at a known baseline state. A READ shares one store (reads don't mutate); a WRITE
 *  needs a fresh one per run, or the second run would see the first's mutations and "diverge" on
 *  rowids alone — a harness artifact, not a defect. */
export type StoreFactory = () => GraphStore;

/** Does this traversal mutate? Decided by the compiler's own routing, not by string-matching for
 *  addV/drop — a chain like `V().property(k,v)` is a write with no add* in it, and the compiler is
 *  the only authority on which chains carry effects. A traversal that fails to compile is not a
 *  write (it will throw identically however it is run).
 *
 *  **Asked as "not a read", not as "is a write".** A mutating traversal compiles to a `program`, and a
 *  probe that string-matched `addV`/`drop` instead silently let a `g.V().drop()` share the read store and
 *  empty it for every traversal after it. The question this probe is really asking is whether a shared
 *  store survives the traversal, and only `kind === 'read'` answers yes.
 *
 *  NOTE this uses a bare `compile()`, so it sees no service registry: a `call()` traversal throws
 *  here and is reported as a non-write, which is correct (no `call()` form is a write today). Do
 *  NOT reuse this as a general "does it compile" probe — see the header on test/L7-census/census.ts. */
export function isWrite(q: string): boolean {
  // Treat a throw as no answer rather than as "read": a traversal that fails to compile is not a
  // write (it throws identically however it is run), but it must not be filed as a read that shares
  // the fixture store either.
  //
  // A misclassification here is expensive. `mergeE(…).option(Merge.outV, …)` once threw and was filed
  // as a READ, and the census then ran it against its SHARED store — where the working lowering
  // happily created six SELF-LOOPS. Every later traversal saw a cyclic graph, and a cyclic `repeat()`
  // without `simplePath()` is infinite per the spec, so the suite hung rather than failed. A
  // misclassified write does not corrupt one row; it corrupts the fixture.
  {
    try { if (compile(q, {}).kind !== 'read') return true; } catch { /* no answer — not a read */ }
  }
  return false;
}

/**
 * Is this traversal's RESULT legitimately nondeterministic?
 *
 * It lives here, beside `isWrite`, for the reason `test/CLAUDE.md` gives for `seeded`: the census
 * and L5 both need the answer and neither owns it. The census withholds a digest for these; L5's
 * fast-path DIFFERENTIAL must skip them outright, because it compares two runs and a random result
 * differs between any two runs whatever the fast paths do.
 *
 * The sources, each probe-confirmed to give four different answers in four runs: `sample()`/`coin()`
 * and `Order.shuffle` lower to SQL `RANDOM()`, and an ARGUMENT-LESS `datetime()` reads the clock —
 * hence the `\(\s*\)`, since `datetime('2020-01-01')` is perfectly deterministic.
 *
 * A regex and not the compiler, unlike `isWrite`: nondeterminism is a property of the SQL a step
 * emits, and no compiled artifact reports it. TinkerPop's own answer
 * (`withStrategies(SeedStrategy(seed: …))`) is unimplemented here, so we cannot lean on it.
 */
const NONDETERMINISTIC = /\b(?:sample|coin)\s*\(|Order\.shuffle|\bshuffle\b|\b(?:datetime|DateTime)\s*\(\s*\)/;
export const isNondeterministic = (q: string): boolean => NONDETERMINISTIC.test(q);

/**
 * Is this traversal's result determined only up to WHICH members a positional window picks?
 *
 * A weaker property than `isNondeterministic` and a different one: the same compiled statement gives
 * the same answer every run, but two DIFFERENT statements over the same multiset may pick different
 * members. `range`/`limit`/`tail`/`skip` are positional consumers, and a movement/filter relation has
 * no emission order for them to be faithful to — SQLite has no reason to visit two plans' rows in the
 * same order. Measured: `g.V(1).out().union(__.identity(), __.range(0, 2))` yields {2,2,3,4,4} while
 * the same chain plus `.fold().unfold()` yields {2,2,3,3,4} — one arm took vadas+josh, the other
 * vadas+lop, both "the first two".
 *
 * TinkerPop, iterating lazily over a definite sequence, has one answer here, so this is a real
 * under-determination on our side and not a licence — it is `docs/outstanding-work.md` item 4 (the
 * missing emission-order primitive) surfacing where item 20 predicts. What it means for an ORACLE is
 * that a comparison between two different chains cannot evaluate anything over such a prefix: the
 * disagreement is the missing order channel, already filed, not the property under test. L5's
 * METAMORPHIC oracle therefore skips these (and reports the count); the fast-path DIFFERENTIAL does
 * not, because there both sides are the same chain — where a positional window does still diverge,
 * that is a diagnosed entry in `L5-properties/known.ts` rather than a whole class.
 *
 * An `order()` earlier in the chain supplies the missing channel, so a windowed chain that has one is
 * determinate and stays in scope.
 */
const POSITIONAL_WINDOW = /\b(?:range|limit|tail|skip)\s*\(/g;

/**
 * How much of the result an un-ordered positional window leaves undetermined:
 *
 *   `null`          — nothing (no window, or an `order()` supplies the channel).
 *   `'members'`     — WHICH rows the window took. The traverser COUNT still holds, so a law can be
 *                     compared on cardinality. This is the window at the tail of its scope.
 *   `'cardinality'` — the count too, because something data-dependent FOLLOWS the window:
 *                     `range(0, 2).hasLabel('person')` filters whatever the window happened to pick,
 *                     so two plans differ in how many survive. Nothing is comparable.
 *
 * "Something follows" is judged syntactically — ANY chained step, so a count-preserving one
 * (`order()`, `as()`) reads as `'cardinality'` too. Deliberately the conservative direction: it costs
 * an oracle some coverage, which the run reports, where the other direction would compare a count
 * that is not determined.
 */
export function orderIndeterminacy(q: string): 'members' | 'cardinality' | null {
  let worst: 'members' | 'cardinality' | null = null;
  for (const at of q.matchAll(POSITIONAL_WINDOW)) {
    const start = at.index + at[0].length;
    if (/\border\s*\(/.test(q.slice(0, at.index))) continue; // ordered: determinate
    // Walk to the window call's matching `)`; a chained step after it consumes the picked rows.
    let depth = 1, i = start;
    for (; i < q.length && depth > 0; i++) depth += q[i] === '(' ? 1 : q[i] === ')' ? -1 : 0;
    if (q[i] === '.') return 'cardinality';
    worst = 'members';
  }
  return worst;
}
