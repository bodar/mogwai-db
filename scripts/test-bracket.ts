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
 * Every discovered file maps to exactly one bracket:
 *   - `test/L<n>-<name>/…`  →  bracket `L<n>`  (regex on the path — L1, L2, … Ln)
 *   - everything else       →  bracket `other`
 * This is the load-bearing property carried over from the sharder: the brackets are DERIVED from
 * discovery, not a hand-written path list, so a new `test/L6-whatever/` dir becomes its own `L6`
 * runner automatically and a new root-level `test/foo.test.ts` lands in `other` automatically. There
 * is no list to update and no way for a file to fall outside every bracket — the union of the
 * brackets IS `bun test`, by construction. `--matrix` and a run share THIS function, so the plan job
 * and the shard runners cannot disagree about what exists.
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

/** Bun's own test-file patterns, so discovery here matches a bare `bun test`. `bunfig.toml` scopes
 *  the root to `test/`; this mirrors that. */
const PATTERNS = [
  'test/**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_test_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_spec_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
];

/** The TOTAL bracket function. `test/L<n>-…` → `L<n>`; anything else → `other`. Keep it pure and
 *  path-only so `--matrix` and a run agree without re-scanning. */
function bracketOf(file: string): string {
  return file.match(/^test\/(L\d+)-/)?.[1] ?? 'other';
}

/** Discover the whole suite, deduped and sorted (total order → reproducible across machines). */
function discover(root: string): string[] {
  const files = [...new Set(PATTERNS.flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: root })]))].sort();
  if (!files.length) throw new Error(`no test files discovered under test/ — ${PATTERNS.length} patterns matched nothing`);
  return files;
}

/** Group discovered files by bracket. Bracket order: L-levels ascending by number, then `other` last
 *  (so the matrix and the --list output read L1, L2, …, other). */
function brackets(root: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of discover(root)) {
    const key = bracketOf(file);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(file);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    if (a === 'other') return 1;
    if (b === 'other') return -1;
    return Number(a.slice(1)) - Number(b.slice(1));
  });
  return new Map(ordered.map((k) => [k, groups.get(k)!.sort()]));
}

const root = new URL('..', import.meta.url).pathname;

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

// `bun test` with explicit paths, inheriting stdio so the reporter output is the normal one.
const run = Bun.spawn(['bun', 'test', ...mine], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(await run.exited);
