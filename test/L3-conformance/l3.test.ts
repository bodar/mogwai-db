// L3 — the official TinkerPop cucumber suite, as a ratcheted `bun test`.
//
// TinkerPop's own Gherkin corpus and its own JS step definitions (both vendored via the
// `vendor/tinkerpop` submodule, tracking `origin/master`) drive mogwai-db over GraphBinary. The
// number of passing scenarios is THE conformance number; this test ratchets it against the last
// committed run recorded in l3-state.json, and a clean local run re-records the state (CI never
// rewrites it, so there is no push-back / re-trigger loop). The two floors gate DIFFERENTLY: the
// RelIR floor is a hard ratchet, the legacy floor may only lose what the RelIR floor holds — see the
// gates below and §6·1 of docs/2026-08-01-relir-build-plan.md.
// Telemetry (the compact `.`/`E` progress line + the systematic-gap summary) is always on.
//
// ── ONE PROCESS, NO SOCKET ────────────────────────────────────────────────────────────────────────
//
// Cucumber runs HERE, through its programmatic api (`test/support/cucumber.ts`), and the client talks
// to the conformance host as a `fetch` HANDLER (`test/support/in-memory-transport.ts`) rather than
// over TCP. There is no server, no port and no child process.
//
// That is a correctness fix, not a tidy-up. Spawning the runner forced the host to be reachable by
// URL, which forced a fixed port the GLV chose and we could not change — one inside Linux's ephemeral
// range, so an unrelated outbound connection on the host could take it and the bind would fail
// `EADDRINUSE` with nothing listening. Measured locally and intermittently red in CI. A handler
// cannot collide with anything.
//
// The step scope lives in ./tags.ts (widen as steps land). The full runbook and history is in
// ./README-cucumber.md. ./conformance.test.ts is the mini-L3 that still goes over a real socket on an
// EPHEMERAL port, deliberately — it is the one place the TCP path itself is under test.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../support/undici-shim.ts'; // client teardown calls Agent.close() — see the shim's header
import { buildConformanceApp } from './conformance-server.ts';
import { installInMemoryTransport, type InMemoryTransport } from '../support/in-memory-transport.ts';
import { runFeatures, GLV } from '../support/cucumber.ts';
import { L3_TAGS, isExcludedScenario } from './tags.ts';
import { ambientSpine } from '../../src/compiler/options/spine.ts';
import { telemetryPath, readTelemetry, summarize, collectScenarios, formatReport, readState, writeState, stateOf, delta, formatDelta, formatSpineGap, partitionLegacyRegressions, unionPassing, expectedErrorSubstrings } from './telemetry.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
// A GLOB, not a bare directory: cucumber 13 (the submodule's runner since the master bump)
// no longer walks a directory argument — a bare path matches 0 features, silently.
const FEATURES = join(ROOT, 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/**/*.feature');
// Upstream's step definitions + world. Also a glob, for the same reason.
const STEPS = 'test/cucumber/*.js';
// Our GraphBinary extensions, loaded into the same registry: without them a valid server
// BigDecimal/Char/Duration response fails to decode before the official assertion can inspect it.
// RELATIVE to cucumber's cwd (the GLV), like the step glob — an absolute path here is accepted and
// then silently not loaded, which costs exactly the 10 BIGINT/BIGDECIMAL scenarios and nothing else.
const GLV_COMPAT = '../../../../test/L3-conformance/glv-compat.ts';
// Provisioning marker: the corpus + upstream's generated step data. Cheaper and more honest than
// checking for a `cucumber-js` BIN, which we no longer run.
const STEP_DATA = join(GLV, 'test/cucumber/gremlin.js');
// The single committed ratchet file: the default spine's last-known run at top level and the legacy
// spine's in its own section. A clean local run rewrites only its section; the file replaces the old
// baseline.json + l3-passing.txt pair.
const STATE = new URL('./l3-state.json', import.meta.url).pathname;
// Every human-facing file that quotes the conformance number, kept in lockstep
// with the ratchet so the prose can never drift from l3-state.json.
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

let transport: InMemoryTransport | undefined;

beforeAll(async () => {
  // Self-heal: `mise run test` provisions the submodule first, but a bare
  // `bun test` does not — so if the corpus or step data is missing, provision now.
  if (!existsSync(STEP_DATA)) {
    const p = Bun.spawn({ cmd: ['bash', join(ROOT, 'scripts/init-submodule.sh')], cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
    if ((await p.exited) !== 0) throw new Error('submodule provisioning failed — run `mise run submodule`');
  }
  // Seed the reference graphs and take the handler. Nothing listens.
  const app = await buildConformanceApp();
  transport = await installInMemoryTransport(app.fetch);
}, LONG);

afterAll(() => transport?.restore());

test('L3 conformance ratchet — official TinkerPop cucumber suite over GraphBinary', async () => {
  // Read the process position ONCE and carry it through every state operation: crossing sections is
  // the failure mode, because one configuration must never gate on or rewrite the other's floor.
  const spine = ambientSpine();
  const report = join(tmpdir(), `mogwai-l3-${process.pid}.json`);
  // The `json` formatter is cucumber's OWN output and stays the measurement: `collectScenarios`
  // reads its shape, and the committed floor was recorded from it. Only how cucumber is DRIVEN
  // changed here — swapping the counting to message envelopes in the same step would have moved the
  // transport and the measurement at once, and the count has subtleties that were misdiagnosed twice
  // (see test/CLAUDE.md on repeated scenario names).
  const { stdout: out } = await runFeatures({
    paths: [FEATURES],
    imports: [STEPS, GLV_COMPAT],
    tags: L3_TAGS,
    formats: [`json:${report}`],
  });

  // Terminate the host's compact `.`/`E` progress line so the aggregate output below starts clean
  // on its own line.
  process.stdout.write('\n');

  // The client MUST have gone through the handler. Without this a swap that silently missed would
  // read as a server bug (every scenario failing to connect) rather than as a harness bug.
  transport!.assertUsed();

  if (!existsSync(report)) {
    throw new Error(`cucumber produced no report — the run likely failed to start.\n--- cucumber stdout ---\n${out}`);
  }

  // A scenario passes iff every one of its steps passed (matches cucumber's own
  // "N passed" summary count — cross-checked below).
  const json: any[] = JSON.parse(readFileSync(report, 'utf8'));
  let passing = 0, total = 0;
  for (const feat of json) for (const el of feat.elements ?? []) {
    if (el.type && el.type !== 'scenario') continue;
    // A DECLARED WALL is not part of the denominator — see `EXCLUDED_SCENARIOS` in tags.ts. It never
    // reaches `passing` either (it fails), so cucumber's own summary cross-check below still holds.
    if (isExcludedScenario(el.name)) continue;
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

  const recordedRel = readState(STATE, 'rel');
  const recordedLegacy = readState(STATE, 'legacy');
  const prev = spine === 'rel' ? recordedRel : recordedLegacy;
  const spineLabel = spine === 'rel' ? 'RelIR spine' : 'legacy spine';
  console.log(`L3 conformance [${spineLabel}]: ${passing}/${total} scenarios pass (last recorded ${prev.passing})`);

  // Per-scenario delta vs the committed last-known run. The passing SET in l3-state.json
  // names exactly what changed — GAINS (fixes) and REGRESSIONS (a scenario that passed
  // last run and fails now) — with no noise from the always-failing deferred set. The
  // regression gate is STRICTER than the count: a net-positive run that silently breaks a
  // previously-green scenario still fails here (the count alone would hide it).
  const rows = collectScenarios(json);
  const d = delta(prev, rows);
  const deltaText = formatDelta(d);
  if (deltaText) console.log(deltaText);

  // The live side uses this run while the other side uses its last recorded section — the same value
  // `writeState` would record, through the same function, so the printed gap cannot drift from the
  // floor that gets committed.
  const current = stateOf(rows);
  const gapText = formatSpineGap(
    spine === 'rel' ? current : recordedRel,
    spine === 'legacy' ? current : recordedLegacy,
    spine,
  );
  if (gapText) console.log(gapText);

  // The systematic-gap view (deferral buckets + failing-step frequency), joined from the
  // server NDJSON captured this run. Always on. The NDJSON + summary are gitignored
  // transient artifacts; only l3-state.json carries durable cross-run state.
  const tpath = telemetryPath();
  // Partition failures with the corpus's own expected-error strings: a throw satisfying a
  // negative scenario's assertion is an expected error (scenario passes), kept out of the
  // buckets so the ranking reflects only real gaps.
  const sum = summarize(readTelemetry(tpath), expectedErrorSubstrings(FEATURES));
  console.log(formatReport(sum, rows));
  const artifact = tpath.replace(/\.ndjson$/, '') + '.summary.json';
  writeFileSync(artifact, JSON.stringify({ ...sum, scenarios: rows }, null, 2) + '\n');
  console.log(`L3 telemetry summary → ${artifact}`);

  // ── THE GATES, and they are ASYMMETRIC by design (§6·1) ──────────────────────────────────────
  //
  // The RelIR floor is a hard ratchet: no scenario may regress (named in the delta above) and the
  // count never falls.
  //
  // The LEGACY floor is not, because legacy is a route with an end date. A RelIR increment that
  // re-expresses a shape legacy only half-supported may cost legacy a scenario, and that trade is
  // fine — gaining five and losing five on a spine scheduled for deletion is progress, not a
  // regression. So the legacy side gates on the UNION: legacy may shed anything the RelIR floor
  // holds, and may not lose a name no spine holds. Two assertions that fail differently on purpose
  // (the second also catches a name that left SCOPE, which `delta` cannot see).
  const shed = spine === 'legacy' ? partitionLegacyRegressions(d.regressed, recordedRel) : undefined;
  if (shed?.shed.length) {
    console.log(`L3 [legacy spine] shed ${shed.shed.length} scenario(s) the RelIR floor holds — ` +
      `legal (§6·1), lowers the legacy floor:\n${shed.shed.map((r) => `  - ${r.name}`).join('\n')}`);
  }
  expect(shed ? shed.uncompensated : d.regressed).toHaveLength(0);
  if (spine === 'rel') {
    expect(passing).toBeGreaterThanOrEqual(prev.passing);
  } else {
    const before = unionPassing(recordedRel, recordedLegacy).size;
    const after = unionPassing(recordedRel, current).size;
    if (after !== before) console.log(`L3 union floor: ${before} → ${after} distinct scenario names`);
    expect(after).toBeGreaterThanOrEqual(before);
  }

  // Clean local run: record the current run as the selected spine's last-known state. CI never
  // rewrites (no push-back loop) — it only reports the delta.
  const changed = d.gained.length > 0 || d.regressed.length > 0 || rows.length !== prev.total;
  if (changed) {
    if (process.env.CI) {
      if (d.gained.length || shed?.shed.length) {
        const prose = spine === 'rel' ? ' (+ README + feature-support-matrix)' : '';
        const move = d.gained.length ? `ahead by +${d.gained.length}` : `shed ${shed!.shed.length}`;
        console.log(`L3 [${spineLabel}] ${move} — run locally to record l3-state.json${prose}, then commit (CI does not rewrite them).`);
      }
    } else {
      writeState(STATE, rows, spine);
      const bump = passing !== prev.passing ? `${prev.passing} → ${passing}` : `+${d.gained.length}/-${d.regressed.length}`;
      console.log(`L3 state [${spineLabel}] recorded (${bump}). Commit test/L3-conformance/l3-state.json.`);
    }
  }
  // THE PROSE SYNC IS UNCONDITIONAL on a clean local RelIR run, and that is the fix for a merge
  // hazard rather than belt-and-braces. It used to fire only when the recorded count MOVED, which is
  // precisely the case a rebase erases: git merges two agents' `passed` insertions cleanly, so the
  // floor grows while nothing in this run "changed" relative to the merged file — and README kept
  // quoting the pre-merge number with every gate green. `syncCountFiles` writes only when the file
  // disagrees, so asking every run costs a read and cannot loop. A LEGACY run must never touch the
  // prose: it records its own floor, and the number these files quote is the default configuration's.
  if (spine === 'rel' && !process.env.CI) {
    // …and the STORED count self-heals for the same reason. Nothing computes with it (`readState`
    // derives the floor from `passed`), but it is what a human reads out of the file, and a merge can
    // leave it one behind. Re-recording the run is the repair, and it is the run's own rows either way.
    const stored = (JSON.parse(readFileSync(STATE, 'utf8')) as { passing?: number }).passing;
    if (stored !== passing) {
      writeState(STATE, rows, spine);
      console.log(`L3 stored count repaired ${stored} → ${passing} (a merge had left it behind).`);
    }
    const synced = syncCountFiles(passing);
    if (synced.length) console.log(`L3 prose count synced to ${passing} — commit ${synced.join(' + ')}.`);
  }
}, LONG);
