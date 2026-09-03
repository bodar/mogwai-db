#!/usr/bin/env bun
/**
 * BRACKETED TEST SPLIT — the CI test suite partitioned into NAMED brackets, one CI runner each.
 *
 * `MOGWAI_BRACKET=L3 bun scripts/test-bracket.ts`  — run one bracket's files (a CI shard runner).
 * `bun scripts/test-bracket.ts --matrix`            — emit the bracket list as JSON (the plan job).
 * `bun scripts/test-bracket.ts --list`              — human-readable: each bracket, its files, cost.
 *
 * ## Why brackets, not cost-shards
 *
 * The predecessor (`test-shard.ts`, deleted) cost-balanced the suite into N anonymous shards. That
 * was optimal for WALL TIME but opaque in the UI: a red `shard 1` told you nothing about which layer
 * broke, so you opened the job to find out. Brackets trade a little balance for LEGIBILITY — a red
 * `test (L2)` says "run `mise run L2` locally" without opening anything.
 *
 * ## The bracket function is TOTAL, so nothing is ever forgotten
 *
 * The partition (`bracketOf`/`discover`/`brackets`) lives in scripts/brackets.ts and is SHARED with the
 * local parallel fan-out (scripts/test-all.ts). Every discovered file maps to exactly one bracket:
 *   - `test/L<n>-<name>/…`  →  bracket `L<n>`     (regex on the path — L1, L2, … Ln)
 *   - `test/browser/…`      →  bracket `browser`  (the one lane that drives a real Chrome, on its own runner)
 *   - everything else       →  bracket `other`
 * Because the function is DERIVED from discovery, a new `test/L6-whatever/` dir becomes its own `L6`
 * runner automatically and a root-level `test/foo.test.ts` lands in `other` automatically. There is no
 * list to update and no way for a file to fall outside every bracket — the union of the brackets IS
 * `bun test`. `--matrix`, a CI run, and `test-all.ts` all share the ONE function, so they cannot disagree.
 *
 * ## `other` is deliberately one bracket, for now
 *
 * `other` is the majority of the suite today, so it is very likely the longest pole. Splitting it is
 * a KNOWN, cheap follow-up (cost-balance `other`'s files into `other-0/1/…`, same LPT packer as the
 * old sharder) — but only worth doing if `other` runs LONGER than the largest L bracket, because the
 * brackets run in parallel and the wall is the slowest one regardless. Measure first (the CI run
 * shows each bracket's time), split only if it pays. Until then, one `other` runner keeps the machinery
 * simple.
 */

import { brackets, discover, REPO_ROOT } from './brackets.ts';

const root = REPO_ROOT;

if (Bun.argv.includes('--matrix')) {
  // The plan job's output: a JSON array of bracket names for GitHub's `strategy.matrix`.
  console.log(JSON.stringify([...brackets(root).keys()]));
  process.exit(0);
}

if (Bun.argv.includes('--list')) {
  for (const [key, files] of brackets(root)) {
    console.log(`${key.padEnd(6)} ${files.length} file(s)`);
    for (const f of files) console.log(`  ${f}`);
  }
  process.exit(0);
}

// Run mode: MOGWAI_BRACKET names which bracket this runner owns.
const wanted = Bun.env.MOGWAI_BRACKET;
if (!wanted) throw new Error('MOGWAI_BRACKET is required (or pass --matrix / --list)');
const groups = brackets(root);
const mine = groups.get(wanted);
if (!mine) throw new Error(`unknown bracket ${JSON.stringify(wanted)} — discovered brackets: ${[...groups.keys()].join(', ')}`);

console.log(`bracket ${wanted}: ${mine.length} of ${discover(root).length} discovered file(s)`);

// The browser bracket runs in its OWN process (this spawn), so activate the lane here — its on-the-fly
// Bun.build is unreliable under the full suite's FD load but solid isolated (see harness browserLaneEnabled).
// MOGWAI_MINIFY makes CI drive the MINIFIED release artifacts (what the zip ships), so a minify regression
// fails the gate — identifier mangling once broke the compiler; this guards it. (Local dev runs the
// readable unminified form via `mise run test:browser`.)
const env = wanted === 'browser' ? { ...process.env, MOGWAI_RUN_BROWSER: '1', MOGWAI_MINIFY: '1' } : undefined;

// `bun test` with explicit paths, inheriting stdio so the reporter output is the normal one.
const run = Bun.spawn(['bun', 'test', ...mine], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'], env });
process.exit(await run.exited);
