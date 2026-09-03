#!/usr/bin/env bun
/**
 * LOCAL PARALLEL TEST RUNNER — the whole suite, fanned across cores as one `bun test` process per
 * bracket. This is what `mise run test` invokes.
 *
 * Bun's test runner is a SINGLE process whose concurrency is IO-only, so a bare `bun test` pins ~1
 * core and the wall is serial. CI already solves this by running one runner per bracket
 * (scripts/test-bracket.ts as a matrix); this is the LOCAL mirror of that — same total bracket
 * function (scripts/brackets.ts), one child `bun test <files>` per bracket, run concurrently. So a
 * 24-core dev box actually uses its cores, and the split is identical to CI by construction (a new
 * `test/L6-…/` dir becomes a child here and a runner there with no edit).
 *
 * This is a shard-and-MERGE orchestrator, which is why it is code and not a set of mise tasks: mise
 * parallelises heterogeneous TASKS in a DAG, but it cannot merge one job's sharded output into a
 * single legible PASS/FAIL report, and its bracket set would have to be hand-listed (losing the
 * derived-totality property). Same reasoning as rel-sweep.ts's self-sharding. See the plan/CLAUDE.md.
 *
 * ## Output — the answer to interwoven parallel output
 *
 * Each bracket's full raw output is captured to its OWN file, `.logs/test-<bracket>.log` (routed exactly
 * where teeshell.sh sends task logs, so they sit beside `mise run test`'s own `.logs/test.log`). The
 * console stays clean: one `── PASS: <bracket> → <log>` line per bracket as it finishes, and a final
 * aggregate. A FAILING bracket is the exception — its output is echoed inline under a header (and still
 * saved) so the failure is visible in a `tail` of the run without opening a file. So you never read a
 * tangle of eight concurrent reporters; you read the one bracket's log, or the inlined failure.
 *
 * ## Two modes
 *
 *   mise run test              → NO args: fan every bracket out concurrently, aggregate, summarise.
 *   mise run test -- <args>    → args present: a single targeted `bun test <args>` (a filter/path).
 *
 * The targeted mode is the fast path for "run just this test" — mise appends `-- <args>` textually to
 * this one command (verified: it appends to the LAST run command, which is why `test` is a single
 * command now), so `mise run test -- test/L3-conformance -t "foo"` reaches here as argv and runs one
 * process. If the filter matches nothing, `bun test` exits fast — the desired behaviour.
 *
 * Type-checking (`tsc --noEmit`) and the submodule are the `test` task's mise DEPENDENCIES, so they
 * have already run before this script starts; this script only runs tests.
 */

import { mkdirSync } from 'node:fs';
import { brackets, REPO_ROOT } from './brackets.ts';

const root = REPO_ROOT;
const cores = navigator.hardwareConcurrency || 1;

// Per-bracket logs go where teeshell.sh routes task logs — `$MISE_PROJECT_ROOT/.logs` — so `mise run
// test`'s own `.logs/test.log` (the aggregate console this script prints) sits beside `.logs/test-L3.log`
// et al. (each bracket's full raw output). This is the answer to interwoven parallel output: you read the
// one bracket's file, never a tangle of eight.
const logdir = `${process.env.MISE_PROJECT_ROOT ?? root}/.logs`;
mkdirSync(logdir, { recursive: true });
const logPathFor = (bracket: string) => `${logdir}/test-${bracket}.log`;

// Passthrough args (everything after the script name). Present ⇒ targeted single-process run.
const passthrough = Bun.argv.slice(2);

/** The env a given bracket's `bun test` needs. Only `browser` is special: it drives a real Chrome, so
 *  it must run with the lane flag set and in its own process (both true here). Unlike CI we do NOT set
 *  MOGWAI_MINIFY — local dev drives the readable unminified build (matches `mise run test:browser`);
 *  CI keeps the minified-artifact guard in scripts/test-bracket.ts. */
function envFor(bracket: string): Record<string, string> | undefined {
  return bracket === 'browser' ? { ...process.env, MOGWAI_RUN_BROWSER: '1' } : undefined;
}

/** Collect a child's stdout+stderr into one string (arrival order; `bun test` writes essentially one
 *  stream, so this reads cleanly). We do NOT stream live — concurrent brackets would interleave — the
 *  captured text goes to the bracket's log file, and only a failing bracket is echoed to the console. */
async function collect(stream: ReadableStream<Uint8Array>, chunks: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) chunks.push(decoder.decode(chunk, { stream: true }));
}

/** Run one bracket as a child `bun test <files>`, capturing its output to `.logs/test-<bracket>.log`.
 *  Resolves to `{ code, output }` (code 0 = pass). */
async function runBracket(bracket: string, files: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(['bun', 'test', ...files], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: envFor(bracket),
  });
  const chunks: string[] = [];
  await Promise.all([collect(child.stdout, chunks), collect(child.stderr, chunks)]);
  const code = await child.exited;
  const output = chunks.join('');
  await Bun.write(logPathFor(bracket), output);
  return { code, output };
}

/** A tiny concurrency pool: run `tasks` with at most `limit` in flight. Preserves nothing about order
 *  of completion; each task reports itself as it finishes. */
async function pool<T>(limit: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── targeted mode ────────────────────────────────────────────────────────────────────────────────
if (passthrough.length) {
  // If the filter targets the browser lane, activate it (otherwise those describes self-skip).
  const wantsBrowser = passthrough.some((a) => a.includes('test/browser'));
  const env = wantsBrowser ? { ...process.env, MOGWAI_RUN_BROWSER: '1' } : undefined;
  const child = Bun.spawn(['bun', 'test', ...passthrough], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'], env });
  process.exit(await child.exited);
}

// ── full fan-out ─────────────────────────────────────────────────────────────────────────────────
// Headroom: leave a couple of cores free so the machine stays responsive (each `bun test` uses ~1.3
// cores; with ~7 brackets this rarely binds, but it is correct on smaller machines). rel-sweep.ts
// self-limits to min(6, cores) the same way.
const limit = Math.max(1, cores - 2);
const groups = brackets(root);
const entries = [...groups.entries()];
console.log(`test-all: ${groups.size} brackets [${entries.map(([k]) => k).join(', ')}] · up to ${limit} concurrent (of ${cores} cores) · per-bracket logs in .logs/test-<bracket>.log`);

const codes = await pool(
  limit,
  entries.map(([bracket, files]) => async () => {
    const { code, output } = await runBracket(bracket, files);
    if (code === 0) {
      // Pass: stay quiet — the full output is in the log file.
      console.log(`── PASS: ${bracket} (${files.length} file(s)) → ${logPathFor(bracket)}`);
    } else {
      // Fail: echo the bracket's output inline (headed) so the failure is visible in a `tail` of the
      // run, THEN the verdict line + log path. This is the loud, read-the-text signal.
      console.log(`\n╭── FAIL (exit ${code}): ${bracket} — output follows (also ${logPathFor(bracket)})`);
      process.stdout.write(output.endsWith('\n') ? output : output + '\n');
      console.log(`╰── ✗ FAILED: ${bracket} (${files.length} file(s)) → ${logPathFor(bracket)}`);
    }
    return code;
  }),
);

const failed = entries.filter((_e, i) => codes[i] !== 0).map(([b]) => b);
console.log(
  failed.length
    ? `test-all: FAIL — ${failed.length}/${entries.length} bracket(s) red: ${failed.join(', ')} (see .logs/test-<bracket>.log)`
    : `test-all: PASS — all ${entries.length} brackets green`,
);
process.exit(failed.length ? 1 : 0);
