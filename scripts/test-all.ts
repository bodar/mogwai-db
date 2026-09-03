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

import { brackets, REPO_ROOT } from './brackets.ts';

const root = REPO_ROOT;
const cores = navigator.hardwareConcurrency || 1;

// Passthrough args (everything after the script name). Present ⇒ targeted single-process run.
const passthrough = Bun.argv.slice(2);

/** The env a given bracket's `bun test` needs. Only `browser` is special: it drives a real Chrome, so
 *  it must run with the lane flag set and in its own process (both true here). Unlike CI we do NOT set
 *  MOGWAI_MINIFY — local dev drives the readable unminified build (matches `mise run test:browser`);
 *  CI keeps the minified-artifact guard in scripts/test-bracket.ts. */
function envFor(bracket: string): Record<string, string> | undefined {
  return bracket === 'browser' ? { ...process.env, MOGWAI_RUN_BROWSER: '1' } : undefined;
}

/** Stream a child's piped output live, every line prefixed with the bracket label so N concurrent
 *  children stay navigable. Piped (non-TTY) `bun test` emits plain lines (no spinner), so prefixing is
 *  safe. Returns nothing; the caller awaits process exit separately. */
async function pump(label: string, stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) sink.write(`[${label}] ${line}\n`);
  }
  if (buf.length) sink.write(`[${label}] ${buf}\n`);
}

/** Run one bracket as a child `bun test <files>`, streaming its output prefixed. Resolves to the exit
 *  code (0 = pass). */
async function runBracket(bracket: string, files: string[]): Promise<number> {
  const child = Bun.spawn(['bun', 'test', ...files], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: envFor(bracket),
  });
  await Promise.all([
    pump(bracket, child.stdout, process.stdout),
    pump(bracket, child.stderr, process.stderr),
  ]);
  return child.exited;
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
console.log(`test-all: ${groups.size} brackets [${[...groups.keys()].join(', ')}] · up to ${limit} concurrent (of ${cores} cores)`);

const entries = [...groups.entries()];
const codes = await pool(
  limit,
  entries.map(([bracket, files]) => async () => {
    const code = await runBracket(bracket, files);
    console.log(`── ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}: ${bracket} (${files.length} file(s))`);
    return code;
  }),
);

const failed = entries.filter((_e, i) => codes[i] !== 0).map(([b]) => b);
console.log(
  failed.length
    ? `test-all: FAIL — ${failed.length}/${entries.length} bracket(s) red: ${failed.join(', ')}`
    : `test-all: PASS — all ${entries.length} brackets green`,
);
process.exit(failed.length ? 1 : 0);
