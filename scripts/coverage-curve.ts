// The depth curve, as a report or a re-record (cc0-curve, docs/2026-11-15-compositional-coverage-plan.md).
//
//   bun scripts/coverage-curve.ts            print both profiles' curves at the CI sample size
//   bun scripts/coverage-curve.ts --record   rewrite test/L5-properties/coverage-baseline.json
//   COVERAGE_PER_SEED=n                      a bigger exploration sample (report only — never recorded)
//   COVERAGE_OFF=name[,name]                 the curve with those fast paths OFF (report only — never recorded);
//                                            with `MOGWAI_CONNECTOR_ONLY=1` and `correlatedChild`, the general path alone
//
// Recording is a command, not something the test does on its own. A new baseline needs a commit message
// that names WHY the curve moved.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure, render, CI_PER_SEED, PROFILES, type Profile } from '../test/L5-properties/coverage.ts';
import { DEFAULT_FAST_PATHS } from '../src/compiler/options/fast-paths.ts';

const record = process.argv.includes('--record');
const off = (process.env.COVERAGE_OFF ?? '').split(',').filter(Boolean);
if (record && (process.env.COVERAGE_PER_SEED || off.length)) {
  console.error('refusing to record an exploration sample: unset COVERAGE_PER_SEED and COVERAGE_OFF');
  process.exit(1);
}
const profiles: Record<string, unknown> = {};
let internal = 0;
for (const profile of Object.keys(PROFILES) as Profile[]) {
  const curve = measure(profile, CI_PER_SEED, { ...DEFAULT_FAST_PATHS, ...Object.fromEntries(off.map((name) => [name, false])) });
  console.log(render(curve));
  for (const q of curve.internal) console.log(`  INTERNAL ERROR: ${q}`);
  internal += curve.internal.length;
  profiles[profile] = curve.byDepth;
}
if (record) {
  if (internal) { console.error('refusing to record a run with internal errors'); process.exit(1); }
  const path = join(import.meta.dir, '..', 'test/L5-properties/coverage-baseline.json');
  writeFileSync(path, JSON.stringify({ perSeed: CI_PER_SEED, profiles }, null, 2) + '\n');
  console.log(`recorded ${path}`);
}
