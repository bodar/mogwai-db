// L5 — the fast-path differential, over two input sources.
//
// The oracle (oracle.ts) needs traversals to run. Two sources, each covering what the other can't:
//
//   CORPUS    — the 2,298 canonical traversals L1 already parses. Real Gremlin, written by TinkerPop,
//               deterministic, zero generator risk. Broad but fixed: it can only ever exercise
//               compositions somebody already wrote down.
//   GENERATED — fast-check walking the shape lattice (shape.ts). Narrower vocabulary, unbounded
//               compositions: it reaches nesting depths and step combinations no corpus contains,
//               which is the "ceiling" test/CLAUDE.md asks about and the floor cannot measure. It
//               found 16 of the 17 signatures in the first sweep; the corpus found the other 1.
//
// Both are gated against the same ratchet (known.ts). CI runs a FIXED SEED so a green run stays
// green — a property test that flakes is a property test people disable. `mise run L5-random` takes a
// random seed for exploration; anything it finds gets diagnosed into known.ts (or fixed) and, per
// test/CLAUDE.md, promoted into an L4 `.feature` so the floor rises permanently.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import {
  differential, gatingDivergences, seeded, ran, onlyDisabled, FAST_PATH_NAMES, GATING,
  type Divergence,
} from './oracle.ts';
import { traversal } from './generate.ts';
import { isKnown, staleEntries } from './known.ts';

/** Fixed unless L5_SEED is set — see the header on why CI must not run a random seed. */
const SEED = Number(process.env.L5_SEED ?? 42);
/** Generated-traversal count. Deliberately modest by default so L5 stays inside a normal test run;
 *  L5_RUNS raises it for an exploration pass. */
const RUNS = Number(process.env.L5_RUNS ?? 300);

const mint = () => seeded(MODERN_SEED);
const report = (q: string, ds: readonly Divergence[]) =>
  ds.map((d) => `  ${q}\n    [${d.kind}] ${d.detail}`).join('\n');
/** A gating divergence that isn't already diagnosed. */
const unexplained = (q: string, generic?: Parameters<typeof gatingDivergences>[2]) =>
  gatingDivergences(mint, q, generic).filter((d) => !isKnown(q, d.detail));

describe('L5 — fast-path differential', () => {
  // ---------- source 1: the L1 corpus ----------
  test('every executable corpus traversal answers the same with fast paths off', () => {
    const corpus = readFileSync(new URL('../L1-corpus/corpus.txt', import.meta.url), 'utf8')
      .split('\n').filter(Boolean);
    const shared = mint();

    let executed = 0;
    const unknown: string[] = [];
    const byKind: Record<string, number> = {};

    for (const q of corpus) {
      // A traversal that doesn't run under the default config can't be differentiated — it throws
      // identically on both sides (an unsupported shape, or a corpus traversal wanting bound
      // params). Counting these keeps the pass honest: coverage is asserted below.
      if (!ran(shared, q)) continue;
      executed++;
      const ds = differential(mint, q);
      for (const d of ds) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
      const news = ds.filter((d) => GATING.has(d.kind) && !isKnown(q, d.detail));
      if (news.length) unknown.push(report(q, news));
    }

    console.log(`L5 corpus: ${corpus.length} traversals, ${executed} executable`);
    console.log(`  divergences by kind: ${JSON.stringify(byKind)} (order = telemetry, never gates)`);
    console.log(`  ${unknown.length} not explained by the ratchet`);
    if (unknown.length) console.log('\nNEW divergences:\n' + unknown.join('\n'));

    // The differential proves nothing over traversals that never ran, so hold a coverage floor. The
    // measured figure is ~1,368; the floor sits below it so ordinary progress doesn't trip it, while
    // a change that guts executability does.
    expect(executed).toBeGreaterThan(1_200);
    expect(unknown).toEqual([]);
  }, 600_000);

  // ---------- source 2: the shape-directed generator ----------
  test('every generated traversal answers the same with fast paths off', () => {
    const unknown: string[] = [];

    fc.assert(
      fc.property(traversal({ steps: 5, depth: 2 }), (g) => {
        const news = unexplained(g.query);
        if (news.length === 0) return true;
        unknown.push(report(g.query, news));
        // Returning false (rather than throwing) lets fast-check SHRINK: it walks the choice
        // sequence back to the smallest generated traversal that still diverges. That is the
        // difference between a usable report and a depth-5 nested haystack — the first run of this
        // suite shrank a 7-step nested counterexample to a 4-step one in 6 steps.
        return false;
      }),
      { seed: SEED, numRuns: RUNS, verbose: true },
    );

    // Coverage: a run where nothing executed would pass vacuously. Sampled separately from the
    // property (fc.assert stops at the first failure, so counting inside it would under-report).
    const shared = mint();
    const executed = fc.sample(traversal({ steps: 5, depth: 2 }), { seed: SEED, numRuns: RUNS })
      .filter((g) => ran(shared, g.query)).length;
    console.log(`L5 generated: ${RUNS} traversals @ seed ${SEED}, ${executed} executable`);
    expect(executed).toBeGreaterThan(RUNS / 4);
  }, 600_000);

  // ---------- attribution: one switch at a time ----------
  //
  // The tests above flip all six at once, which proves equivalence but not WHICH path broke it.
  // Disabling exactly one isolates the culprit, and it is a strictly stronger check too: a pair of
  // fast paths whose errors cancel when both are off shows up here and nowhere else.
  describe('each fast path in isolation', () => {
    for (const name of FAST_PATH_NAMES) {
      test(`${name} is equivalent to its generic fallback`, () => {
        const unknown: string[] = [];
        fc.assert(
          fc.property(traversal({ steps: 4, depth: 2 }), (g) => {
            const news = unexplained(g.query, onlyDisabled(name));
            if (news.length === 0) return true;
            unknown.push(report(g.query, news));
            return false;
          }),
          { seed: SEED, numRuns: Math.max(60, Math.floor(RUNS / 3)), verbose: true },
        );
        expect(unknown).toEqual([]);
      }, 300_000);
    }
  });

  // ---------- the ratchet's own hygiene ----------
  test('no stale ratchet entries', () => {
    // Every KNOWN entry must still reproduce; one that doesn't is either fixed (delete it) or no
    // longer reachable (fix it). Checked against each entry's own `query` rather than from the corpus
    // run's findings, so this holds regardless of test ordering.
    const seen = new Set<string>();
    for (const k of staleEntries(new Set()))
      if (gatingDivergences(mint, k.query).length > 0)
        seen.add(k.query.replace(/"/g, "'").replace(/\s+/g, ' ').trim());
    const stale = staleEntries(seen);
    if (stale.length)
      console.log('stale ratchet entries (no longer diverge — delete them):\n' +
        stale.map((s) => `  ${s.query}`).join('\n'));
    expect(stale).toEqual([]);
  }, 120_000);
});
