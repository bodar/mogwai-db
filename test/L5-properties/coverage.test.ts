// THE DEPTH-CURVE RATCHET (cc0-curve). One-way, like L3's `l3-state.json`: at every child-nesting depth,
// in both profiles, the number of queries that ANSWER may not fall below the committed baseline, and no
// query may surface an internal error. A rise prints the re-record hint (`mise run coverage-record`).
//
// The sample is FIXED (fixed seeds × `CI_PER_SEED`, `coverage.ts` `PROFILES`), so the comparison is exact
// rather than statistical. If a bucket's SIZE `n` differs from the baseline, the generator changed — the
// test says so and asks for a re-record with a reason, instead of comparing two different samples.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { measure, render, CI_PER_SEED, PROFILES, type Curve, type Profile } from './coverage.ts';
import { summary, detail } from '../support/output.ts';

const BASELINE_PATH = new URL('./coverage-baseline.json', import.meta.url);
type Baseline = { perSeed: number; profiles: Record<Profile, Curve['byDepth']> };

describe('L5 coverage — the depth curve', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

  for (const profile of Object.keys(PROFILES) as Profile[]) {
    test(`${profile}: no depth answers fewer queries than the baseline, and nothing surfaces an internal error`, () => {
      const curve = measure(profile, CI_PER_SEED);
      const rates = Object.entries(curve.byDepth).map(([d, b]) => `d${d} ${(b.executeRate * 100).toFixed(0)}%`).join(' · ');
      summary(`L5 coverage ${profile}: ${rates}`);
      detail(() => render(curve));
      expect(curve.internal).toEqual([]);
      if (CI_PER_SEED !== baseline.perSeed) return; // an exploration run (COVERAGE_PER_SEED) is telemetry only

      const was = baseline.profiles[profile];
      const resampled = Object.keys(curve.byDepth).length !== Object.keys(was).length
        || Object.entries(curve.byDepth).some(([d, b]) => was[d]?.n !== b.n);
      if (resampled)
        throw new Error(`${profile}: the generated sample changed (bucket sizes differ from coverage-baseline.json) — `
          + 'the generator or a fixed seed moved. Re-record with `mise run coverage-record` and say why in the commit.');

      const regressed = Object.entries(curve.byDepth).filter(([d, b]) => b.rows < was[d]!.rows)
        .map(([d, b]) => `depth ${d}: ${b.rows} answer, baseline ${was[d]!.rows}`);
      expect(regressed).toEqual([]);
      const improved = Object.entries(curve.byDepth).some(([d, b]) => b.rows > was[d]!.rows);
      if (improved) summary(`  ${profile} improved on the baseline — re-record with \`mise run coverage-record\``);
    }, 300_000);
  }
});
