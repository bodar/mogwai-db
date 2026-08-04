#!/usr/bin/env bun
/**
 * ONE SHARD OF THE SUITE — `MOGWAI_SHARDS=n MOGWAI_SHARD=i bun scripts/test-shard.ts`.
 *
 * A single `bun test` is ONE process and bun does not parallelise across files, so the suite is a
 * serial CPU pole: measured 61s locally, 117s on a CI runner. Sharding it across CI JOBS (one runner
 * each, 4 dedicated cores) is what shortens the wall — sharding inside one runner does not, because
 * every extra bun process re-pays JIT warmup (measured: 2 test shards ∥ 2 sweep shards on a 4-core
 * pin took 66.8s against 72.9s unsharded, and 4+2 was worse at 71.8s).
 *
 * ## Why this DERIVES the split instead of naming directories
 *
 * The obvious version is two mise tasks with hand-written path lists. That is a silent-coverage
 * footgun: add `test/L6-whatever/` and neither list names it, so nothing runs it and CI stays green
 * on a suite that shrank. Deriving the shards from DISCOVERY makes the union the whole suite by
 * construction — a new file lands in some shard whether or not anyone remembers this script exists.
 *
 * So: discover, then partition. The cost table below only decides WHICH shard a file lands in, never
 * WHETHER it lands in one. A stale or missing entry costs balance (one shard runs long), never
 * coverage — which is why an unknown file gets a default cost rather than an error.
 */

/** Bun's own test-file patterns, so discovery here matches what a bare `bun test` would collect.
 *  `bunfig.toml` scopes the root to `test/`; this mirrors that rather than re-deriving it. */
const PATTERNS = [
  'test/**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_test_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_spec_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
];

/** Measured seconds per file (`bun test <file>` on a 24-core dev box, 2026-08-04). Only the files
 *  worth balancing around are listed — everything else is DEFAULT_COST, which is roughly the median.
 *  Re-measure with `bun scripts/test-shard.ts --costs` when the balance drifts. */
const COST: Record<string, number> = {
  'test/L5-properties/differential.test.ts': 20.3,
  'test/L3-conformance/l3.test.ts': 17.0,
  'test/census/census.test.ts': 8.7,
  'test/L5-properties/table.test.ts': 3.8,
  'test/L5-properties/shape-annotation.test.ts': 3.3,
  'test/L5-properties/metamorphic.test.ts': 3.0,
  'test/L4-addendum/l4.test.ts': 2.4,
  'test/L1-corpus/corpus.test.ts': 2.2,
  'test/L5-properties/capability.test.ts': 2.0,
};
const DEFAULT_COST = 0.35;

const SHARDS = Number(Bun.env.MOGWAI_SHARDS ?? 1);
const SHARD = Number(Bun.env.MOGWAI_SHARD ?? 0);
if (!Number.isInteger(SHARDS) || SHARDS < 1) throw new Error(`MOGWAI_SHARDS must be a positive integer, got ${Bun.env.MOGWAI_SHARDS}`);
if (!Number.isInteger(SHARD) || SHARD < 0 || SHARD >= SHARDS) throw new Error(`MOGWAI_SHARD must be in [0, ${SHARDS}), got ${Bun.env.MOGWAI_SHARD}`);

const root = new URL('..', import.meta.url).pathname;
const files = [...new Set(PATTERNS.flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: root })]))].sort();
if (!files.length) throw new Error(`no test files discovered under test/ — ${PATTERNS.length} patterns matched nothing`);

if (Bun.argv.includes('--costs')) {
  // Print each file's measured cost, so the table above can be refreshed from one run.
  for (const file of files) {
    const started = Bun.nanoseconds();
    await Bun.spawn(['bun', 'test', file], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exited;
    const seconds = (Bun.nanoseconds() - started) / 1e9;
    if (seconds >= 1) console.log(`  '${file}': ${seconds.toFixed(1)},`);
  }
  process.exit(0);
}

/** Longest-processing-time-first bin packing: sort by cost descending, put each file in the shard
 *  with the least work so far. Deterministic (the sort is total — cost then path), so shard i holds
 *  the same files on every machine and a failure is reproducible from the shard index alone. */
const bins = Array.from({ length: SHARDS }, () => ({ files: [] as string[], cost: 0 }));
for (const file of [...files].sort((a, b) => (COST[b] ?? DEFAULT_COST) - (COST[a] ?? DEFAULT_COST) || a.localeCompare(b))) {
  const bin = bins.reduce((least, b) => (b.cost < least.cost ? b : least));
  bin.files.push(file);
  bin.cost += COST[file] ?? DEFAULT_COST;
}

const mine = bins[SHARD]!;
console.log(`shard ${SHARD + 1}/${SHARDS}: ${mine.files.length} of ${files.length} discovered file(s), ~${mine.cost.toFixed(1)}s estimated`);
console.log(`  (shard sizes: ${bins.map((b) => `${b.files.length}@${b.cost.toFixed(0)}s`).join(' ')})`);

// `bun test` with explicit paths, inheriting stdio so the reporter output is the normal one.
const run = Bun.spawn(['bun', 'test', ...mine.files.sort()], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(await run.exited);
