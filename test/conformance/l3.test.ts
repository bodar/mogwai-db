// L3 — the official TinkerPop cucumber suite, as a ratcheted `bun test`.
//
// TinkerPop's own JS cucumber runner (vendored via the `vendor/tinkerpop`
// submodule, pinned at 4.0.0-beta.2) drives the official Gherkin feature files
// over GraphBinary against a live in-process mogwai-db. The number of passing
// scenarios is THE conformance number; this test ratchets it: fewer than the
// committed baseline fails the build, more auto-bumps the baseline (locally —
// CI never rewrites it, so there is no push-back / re-trigger loop).
//
// The step scope lives in ./tags.ts (widen as steps land). The full runbook and
// history is in ./README-cucumber.md. ./conformance.test.ts is the fast
// in-process mini-L3 that proves the wire path without the submodule.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConformanceServer } from './conformance-server.ts';
import { L3_TAGS } from './tags.ts';
import { telemetryPath, readTelemetry, summarize, collectScenarios, formatReport, readPassingSet, writePassingSet, regressions, formatRegressions } from './telemetry.ts';

// helper.js in the GLV hardcodes http://localhost:45940 — the port is not
// configurable, so the host must own it for the duration of the run.
const PORT = 45940;
const ROOT = new URL('../../', import.meta.url).pathname;
const GLV = join(ROOT, 'vendor/tinkerpop/gremlin-js/gremlin-javascript');
const FEATURES = join(ROOT, 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/');
const CUCUMBER_BIN = join(ROOT, 'vendor/tinkerpop/gremlin-js/node_modules/.bin/cucumber-js');
const BASELINE = new URL('./baseline.json', import.meta.url).pathname;
// The committed set of scenario NAMES passing at baseline — lets the ratchet name exactly
// which scenarios regressed (vs only reporting that the count fell). Kept in lockstep with
// baseline.json's count on every clean bump.
const PASSING_SET = new URL('./l3-passing.txt', import.meta.url).pathname;
// Every human-facing file that quotes the conformance number, kept in lockstep
// with the ratchet so the prose can never drift from baseline.json.
const SYNC_FILES = [join(ROOT, 'README.md'), join(ROOT, 'docs/feature-support-matrix.md')];

// Rewrite the count between the <!-- L3:passing --> … <!-- /L3:passing -->
// markers in each synced file. Markdown has no native placeholder, so we use the
// universal HTML-comment-anchor convention and rewrite only what's between the
// markers (idempotent, re-runnable). Grouped with commas by hand — no ICU/locale
// dependency. Returns the basenames actually changed (for the commit hint).
function syncCountFiles(passing: number): string[] {
  const grouped = String(passing).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const marker = /(<!-- L3:passing -->).*?(<!-- \/L3:passing -->)/s;
  const changed: string[] = [];
  for (const file of SYNC_FILES) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(marker, `$1${grouped}$2`);
    if (next === text) continue;
    writeFileSync(file, next);
    changed.push(file.slice(ROOT.length).replace(/^\/+/, ''));
  }
  return changed;
}

// Provisioning (git clone + workspace install) and the cucumber run can each
// take minutes; the default 5s hook/test timeout would abort them.
const LONG = 600_000;

let server: Awaited<ReturnType<typeof startConformanceServer>> | undefined;

beforeAll(async () => {
  // Self-heal: `mise run test` provisions the submodule first, but a bare
  // `bun test` does not — so if the runner deps are missing, provision now.
  if (!existsSync(CUCUMBER_BIN)) {
    const p = Bun.spawn({ cmd: ['bash', join(ROOT, 'scripts/init-submodule.sh')], cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
    if ((await p.exited) !== 0) throw new Error('submodule provisioning failed — run `mise run submodule`');
  }
  server = await startConformanceServer(PORT);
}, LONG);

afterAll(() => server?.stop(true));

test('L3 conformance ratchet — official TinkerPop cucumber suite over GraphBinary', async () => {
  const report = join(tmpdir(), `mogwai-l3-${process.pid}.json`);
  const proc = Bun.spawn({
    cmd: [
      'bunx', '--bun', 'cucumber-js',
      '--tags', L3_TAGS,
      '--format', `json:${report}`,
      '--format', 'summary',
      '--import', 'test/cucumber',
      FEATURES,
    ],
    cwd: GLV,
    env: { ...process.env, CLIENT_MIMETYPE: 'application/vnd.graphbinary-v4.0' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  // Terminate the in-process server's compact `.`/`E` progress line (telemetry mode)
  // so the aggregate output below starts clean on its own line.
  if (telemetryPath()) process.stdout.write('\n');

  if (!existsSync(report)) {
    throw new Error(`cucumber produced no report — the runner likely failed to start.\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
  }

  // A scenario passes iff every one of its steps passed (matches cucumber's own
  // "N passed" summary count — cross-checked below).
  const json: any[] = JSON.parse(readFileSync(report, 'utf8'));
  let passing = 0, total = 0;
  for (const feat of json) for (const el of feat.elements ?? []) {
    if (el.type && el.type !== 'scenario') continue;
    total++;
    const steps = el.steps ?? [];
    if (steps.length && steps.every((s: any) => s.result?.status === 'passed')) passing++;
  }

  // Cross-check against cucumber's printed summary so a formatter change can't
  // silently drift our count away from the tool's own.
  const summary = out.match(/(\d+) scenarios? \((?:.*?(\d+) passed)?/);
  const reported = summary?.[2] ? Number(summary[2]) : undefined;
  if (reported !== undefined && reported !== passing) {
    throw new Error(`count mismatch: parsed ${passing} but cucumber summary says ${reported}. Summary:\n${out.slice(-400)}`);
  }

  const baseline: { passing: number } = JSON.parse(readFileSync(BASELINE, 'utf8'));
  console.log(`L3 conformance: ${passing}/${total} scenarios pass (baseline ${baseline.passing})`);

  // Per-scenario ratchet. The passing SET names exactly what regressed — a scenario that
  // passed at baseline and fails now — with no noise from the always-failing deferred set.
  // This is a STRICTER gate than the count: a net-positive run that silently breaks a
  // previously-green scenario still fails here (the count alone would hide it).
  const rows = collectScenarios(json);
  const passingNow = new Set(rows.filter((r) => r.passed).map((r) => r.name));
  const baseSet = readPassingSet(PASSING_SET);
  const regressed = regressions(baseSet, rows);
  if (regressed.length) console.log(formatRegressions(regressed));

  // Opt-in telemetry (MOGWAI_L3_TELEMETRY): the systematic-gap view (deferral buckets +
  // failing-step frequency), joined from the server NDJSON. Read-only.
  const tpath = telemetryPath();
  if (tpath) {
    const sum = summarize(readTelemetry(tpath));
    console.log(formatReport(sum, rows));
    const artifact = tpath.replace(/\.ndjson$/, '') + '.summary.json';
    writeFileSync(artifact, JSON.stringify({ ...sum, scenarios: rows }, null, 2) + '\n');
    console.log(`L3 telemetry summary → ${artifact}`);
  }

  // Gate 1: no scenario may regress (names them above). Gate 2: the count never falls.
  expect(regressed).toHaveLength(0);
  expect(passing).toBeGreaterThanOrEqual(baseline.passing);

  // Clean run: fold any newly-passing scenarios into the committed set, and bump the count
  // + synced prose. CI never rewrites (no push-back loop) — it only reports the delta.
  const setChanged = passingNow.size !== baseSet.size || [...passingNow].some((n) => !baseSet.has(n));
  if (passing > baseline.passing || setChanged) {
    if (process.env.CI) {
      if (passing > baseline.passing)
        console.log(`L3 ahead of baseline by ${passing - baseline.passing} — run locally to auto-bump baseline.json + l3-passing.txt (+ README + feature-support-matrix), then commit all (CI does not rewrite them).`);
    } else {
      writeFileSync(BASELINE, JSON.stringify({ ...baseline, passing }, null, 2) + '\n');
      writePassingSet(PASSING_SET, passingNow);
      const synced = passing !== baseline.passing ? syncCountFiles(passing) : [];
      const bump = passing !== baseline.passing ? `${baseline.passing} → ${passing}` : `set +${passingNow.size - baseSet.size}`;
      const also = synced.length ? ` + ${synced.join(' + ')}` : '';
      console.log(`L3 baseline updated (${bump}). Commit test/conformance/baseline.json + test/conformance/l3-passing.txt${also}.`);
    }
  }
}, LONG);
