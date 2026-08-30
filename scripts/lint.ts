#!/usr/bin/env bun
/**
 * The unused-code checks, over our source only.
 *
 *   bun scripts/lint.ts [--verbose]
 *
 * Three flags that cannot live in `tsconfig.json` — `noUnusedLocals`, `noUnusedParameters`,
 * `verbatimModuleSyntax`. Generated `parser/` fails 24 of them and must never be hand-edited
 * (root CLAUDE.md, locked decision 2), and every config-level way to exempt it was measured and
 * does not work: `include`/`exclude` only filter the ROOT set (an imported file is still checked
 * with the root config's flags, so `parser/` returns via src/gremlin/frontend.ts); project
 * references would scope it but `composite` requires emit (TS6310) and this project is `noEmit` by
 * design; and a `link:`/workspace package does not help, because tsc resolves the symlink back to
 * the real path and even a real copy under `node_modules/` is still linted (`skipLibCheck` covers
 * `.d.ts` only — there is no source equivalent). The long comment in `tsconfig.json` is the record.
 *
 * So the exemption is invocation-scoped: run tsc with the flags, then filter `parser/` out of the
 * OUTPUT. That filtering is the whole job, and the one rule is that it stays HONEST — every
 * suppressed error is counted and attributed on stdout, never silently dropped.
 *
 * Why filtering output is safe rather than a hole: this run ADDS three flags to the ones
 * `mise run check` already gates on. Real type errors in `parser/` are `check`'s job and it does
 * not exempt anything; the only thing suppressed here is unused-code noise in generated files.
 *
 * Fail closed: a tsc diagnostic that does not parse into a file path is REPORTED and fails the run
 * rather than being assumed exempt.
 *
 * Exit codes: 0 clean, 1 an error in our code (or an unparseable diagnostic, or tsc itself failing
 * for a reason other than diagnostics).
 */

const verbose = process.argv.includes('--verbose');

/** Prefixes whose unused-code diagnostics are suppressed. Generated — never hand-edited. */
const GENERATED = ['parser/'];

/**
 * The three flags. Kept here and not in tsconfig.json for the reason in the header; the six
 * CORRECTNESS flags do live in tsconfig.json, because `parser/` passes those.
 */
const FLAGS = ['--noUnusedLocals', '--noUnusedParameters', '--verbatimModuleSyntax'];

// `--pretty false` forces the PLAIN `path(line,col): error TSxxxx` diagnostic format the DIAG regex
// below parses. Without it, tsc emits its COLORIZED multi-line format whenever it detects colour
// support — and `FORCE_COLOR` in the ambient env (a harness sets `FORCE_COLOR=3`) turns it on even
// through a pipe, so every diagnostic became unparseable and the gate FAILED CLOSED on a clean tree.
// The format is now pinned rather than left to colour detection.
const proc = Bun.spawn(['bunx', 'tsc', '--noEmit', '--pretty', 'false', ...FLAGS], {
  cwd: new URL('..', import.meta.url).pathname,
  stdout: 'pipe',
  stderr: 'pipe',
});
const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
await proc.exited;

if (err.trim()) console.error(err.trim());

// `path(line,col): error TSxxxx: message` — tsc's pretty-printer is off under `bunx tsc` piped.
const DIAG = /^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const ours: string[] = [];
const exempt: string[] = [];
const unparsed: string[] = [];

for (const line of out.split('\n')) {
  if (!line.includes('error TS')) continue;
  const m = DIAG.exec(line);
  if (!m) { unparsed.push(line); continue; }
  (GENERATED.some((g) => m[1].startsWith(g)) ? exempt : ours).push(line);
}

// ---------- report ----------
// Attribute every suppression. A count alone would let `parser/` quietly grow a new failure mode;
// the per-directory tally is what makes a change there visible without reading the files.
if (exempt.length) {
  const byDir = new Map<string, number>();
  for (const e of exempt) {
    const dir = e.slice(0, e.lastIndexOf('/') + 1);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const tally = [...byDir.entries()].sort().map(([d, n]) => `${d} ${n}`).join(', ');
  console.log(`lint: ${exempt.length} error(s) suppressed in generated code (${tally})`);
  if (verbose) for (const e of exempt) console.log(`  - ${e}`);
}

if (unparsed.length) {
  console.error(`\n${unparsed.length} diagnostic(s) could not be attributed to a file — failing closed:`);
  for (const u of unparsed) console.error(`  ${u}`);
}

if (ours.length) {
  console.error(`\n${ours.length} unused-code error(s) in our source:`);
  for (const o of ours) console.error(`  ${o}`);
  console.error(`\nFlags: ${FLAGS.join(' ')}. \`bun scripts/fix.ts --unused\` clears unused IMPORTS;`);
  console.error('unused locals, parameters and private fields need judgement — see');
  console.error('docs/2026-07-30-lsp-tooling-plan.md §2 for how the last backlog was cleared.');
}

if (ours.length || unparsed.length) process.exit(1);

// tsc exited non-zero but produced nothing we could attribute: a config or invocation failure.
if (proc.exitCode !== 0 && !exempt.length) {
  console.error(`tsc exited ${proc.exitCode} with no parseable diagnostics — failing closed.`);
  process.exit(1);
}

console.log(`lint: clean — 0 unused locals, parameters or non-type-only type imports in our source.`);
