// L3 telemetry — always on, test-only, zero ratchet risk.
//
// THE PROBLEM. Bare cucumber pass/fail throws away the gremlin string, the step
// chain, and the compiler's clean deferral message (see the trace in
// README-cucumber.md). So a rising count tells us the number moved but never
// WHICH step-chains fail or WHY — the systematic view is blind. The truncation is
// NOT cucumber's: the clean throw survives end-to-end (the server logs `ERR <msg>`
// at router.ts; feature-steps.js prints it clean to stderr) and the JSON report is
// on disk — the harness just has to read it.
//
// THE CAPTURE. Two independent signals, joined by the gremlin string:
//  - SERVER SIDE: a pass-through GraphManager decorator logs every query the
//    conformance host runs — {g, gremlin, ok, error, steps} — reusing the L1
//    corpus parse machinery (parseGremlin+stepChain) for the step chain. This is
//    where the deferral message is CLEANEST (the compiler's own throw, before
//    cucumber wraps it in a chai assertion), and it distinguishes a compile/exec
//    throw from a wrong-answer (a scenario can fail cucumber while ok:true here).
//    The decorator re-throws unchanged, so behaviour and the ratchet count are
//    byte-identical.
//  - CUCUMBER SIDE: the JSON report already on disk gives scenario names and
//    pass/fail (read-only, after the ratchet assertion).
//
// THE STATE. l3-state.json (committed) records the last known run: the count and
// the exact PASSED/FAILED scenario-name sets. Every local run diffs against it to
// print the DELTA (gains + regressions), then rewrites it on a clean run. It is
// the single source of truth for the ratchet — no separate baseline.json.
import { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import type { GraphManager, GraphInfo } from '../../src/manager.ts';
import type { RemoteExecutor } from '../../src/api.ts';

export interface QueryRecord {
  g: string;
  gremlin: string;
  ok: boolean;
  error?: string;
  steps: string[];
}

/** The top-level step-name chain of a gremlin string, best-effort (same scope as
 *  the L1 corpus machinery — does not descend into nested traversals). Returns []
 *  on any parse/chain failure; never throws (telemetry must not perturb a run). */
export function stepNames(gremlin: string, params: Record<string, any>): string[] {
  try {
    return [...stepChain(parseGremlin(gremlin), params)].map((s) => s.name);
  } catch {
    return [];
  }
}

/** The per-run NDJSON capture file (always on): a transient, gitignored artifact
 *  beside this module. Cleared at the start of each run so a summary reflects only
 *  the current run; the durable cross-run state is l3-state.json. */
export function telemetryPath(): string {
  return new URL('./l3-telemetry.ndjson', import.meta.url).pathname;
}

/** A pass-through GraphManager that appends one NDJSON QueryRecord per query and re-throws
 *  unchanged. Instruments the DATA PLANE — executor(id).framedAsync — by decorating the Executor
 *  the inner manager hands back; create/info/destroy delegate verbatim. Wrapping this around the
 *  served manager (AFTER seeding) is behaviour-neutral, so the L3 ratchet is unaffected. */
export class LoggingGraphManager implements GraphManager {
  constructor(private readonly inner: GraphManager, private readonly file: string) {}

  executor(id: string): RemoteExecutor {
    const inner = this.inner.executor(id);
    const log = (rec: QueryRecord) => this.log(rec);
    return {
      raw: (g, p, depth, t) => inner.raw(g, p, depth, t),
      async framedAsync(gremlin, params, paramTypes) {
        try {
          const r = await inner.framedAsync(gremlin, params, paramTypes);
          log({ g: id, gremlin, ok: true, steps: stepNames(gremlin, params) });
          return r;
        } catch (e: any) {
          log({ g: id, gremlin, ok: false, error: e?.message ?? String(e), steps: stepNames(gremlin, params) });
          throw e;
        }
      },
    };
  }
  create(id: string): Promise<void> { return this.inner.create(id); }
  info(id: string): Promise<GraphInfo> { return this.inner.info(id); }
  destroy(id: string): Promise<void> { return this.inner.destroy(id); }

  private log(rec: QueryRecord): void {
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }
}

/** Read an NDJSON telemetry file into records (skips blank/corrupt lines). */
export function readTelemetry(file: string): QueryRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l) as QueryRecord]; } catch { return []; } });
}

/** Start each run from a clean file, so a summary reflects only this run. */
export function clearTelemetry(file: string): void {
  if (existsSync(file)) rmSync(file);
}

// ---------- expected-error classification (the compact progress line) ----------
//
// A negative scenario asserts `... the traversal will raise an error with message <cmp>
// text of "<substr>"`. When our compiler throws a message CONTAINING that literal substring
// it is SATISFYING that assertion — an EXPECTED error, not a gap — so the scenario passes.
// Extracting those literals from the feature tree lets the progress line distinguish an
// expected throw (a quiet `·`) from a real compile/exec gap (`E`). This is deliberately keyed
// on the corpus's OWN assertion strings, not on our message shape: a real bug that throws a
// canonical-looking error (e.g. a bad bind, an unexpected parse error) is NOT in this set, so
// it still shows as `E`. (The ~9 message-agnostic `will raise an error` scenarios can't be
// matched by text and stay `E` — a small, honest residual, still caught by the ratchet.)

/** The literal expected-error message substrings asserted across the feature tree. Scanned
 *  once; returns [] if the dir is absent (telemetry must never perturb a run). */
export function expectedErrorSubstrings(featuresDir: string): string[] {
  try {
    const out = new Set<string>();
    for (const f of readdirSync(featuresDir, { recursive: true, encoding: 'utf8' })) {
      if (typeof f !== 'string' || !f.endsWith('.feature')) continue;
      const text = readFileSync(join(featuresDir, f), 'utf8');
      for (const m of text.matchAll(/raise an error with message \w+ text of "([^"]*)"/g)) out.add(m[1]);
    }
    return [...out];
  } catch {
    return [];
  }
}

/** The compact progress mark for one query outcome: `.` ran, `·` an expected throw (its
 *  message matches a negative scenario's assertion), `E` a real compile/exec gap. */
export function progressMark(ev: { ok: boolean; error?: string }, expected: readonly string[]): '.' | '·' | 'E' {
  if (ev.ok) return '.';
  const msg = ev.error ?? '';
  return expected.some((s) => msg.includes(s)) ? '·' : 'E';
}

// ---------- aggregation: the systematic-gap view ----------

/** Collapse a deferral message to a bucket key: mask quoted tokens and digits so
 *  "repeat(__.out().dedup()) not yet supported" and its `sack()`/`limit()` variants
 *  fall in one bucket. This is what turns N one-off failures into a ranked list of
 *  the FEW systematic walls. */
export function bucketKey(msg: string): string {
  return msg
    .replace(/`[^`]*`/g, '`…`')
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, 'N')
    .trim()
    .slice(0, 200);
}

const dedupKey = (r: QueryRecord) => `${r.g}\x00${r.gremlin}`;

/** A throw whose message satisfies a negative scenario's assertion — an expected error, not a gap. */
const matchesExpected = (error: string | undefined, expected: readonly string[]) =>
  expected.some((s) => (error ?? '').includes(s));

export interface TelemetrySummary {
  totalQueries: number;
  uniqueQueries: number;
  /** Unique REAL-GAP failures: throws that don't satisfy a negative scenario's assertion.
   *  Expected negative-test throws (the scenario passes) are not gaps and aren't counted here. */
  uniqueFailed: number;
  /** Deferral buckets over the real gaps, most frequent first. */
  buckets: { key: string; count: number; example: string; exampleSteps: string[] }[];
  /** Step names appearing in real-gap failing chains, most frequent first. */
  failingSteps: { step: string; count: number }[];
  /** Contiguous runs of real-gap throws (a coherent feature/area), largest first. */
  clusters: GapCluster[];
}

/** A contiguous run of real-gap throws in execution order. Because the cucumber suite runs
 *  scenarios in feature-file order, a run is a coherent AREA (usually one feature): its `size`
 *  and error-type spread say how much a single root-cause fix would unlock — the signal the
 *  frequency-sorted buckets lose by scattering one area's failures across many small buckets. */
export interface GapCluster {
  /** Distinct (graph, gremlin) real-gap throws in the run. */
  size: number;
  /** The run's error composition (bucketed), most frequent first. One type + a big size = the
   *  highest-leverage target; many types = a heterogeneous stretch worth less. */
  buckets: { key: string; count: number }[];
  /** A representative failing traversal from the run. */
  example: string;
}

/** Cluster the raw (ordered) telemetry into contiguous real-gap runs. A run tolerates up to
 *  `gap` intervening non-gap records (a passing/expected-throw scenario between two failing ones)
 *  so a near-solid block stays one cluster; `min` drops incidental singletons. Sizes dedup by
 *  (graph, gremlin), so a cluster's size is comparable to the bucket counts. */
export function clusterGaps(records: QueryRecord[], expected: readonly string[] = [], gap = 2, min = 4): GapCluster[] {
  const isGap = (r: QueryRecord) => !r.ok && !matchesExpected(r.error, expected);
  const clusters: GapCluster[] = [];
  let i = 0;
  while (i < records.length) {
    if (!isGap(records[i])) { i++; continue; }
    // Extend the run while no more than `gap` consecutive non-gap records interrupt it.
    let end = i, since = 0;
    for (let k = i; k < records.length; k++) {
      if (isGap(records[k])) { end = k; since = 0; }
      else if (++since > gap) break;
    }
    const seen = new Set<string>();
    const bk = new Map<string, number>();
    let example = '';
    for (let k = i; k <= end; k++) {
      const r = records[k];
      if (!isGap(r) || seen.has(dedupKey(r))) continue;
      seen.add(dedupKey(r));
      if (!example) example = r.gremlin;
      const key = bucketKey(r.error ?? '(no message)');
      bk.set(key, (bk.get(key) ?? 0) + 1);
    }
    if (seen.size >= min)
      clusters.push({ size: seen.size, example, buckets: [...bk.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count) });
    i = end + 1;
  }
  return clusters.sort((a, b) => b.size - a.size);
}

/** Summarize the run's telemetry into the systematic-gap view. `expected` (the corpus's own
 *  expected-error substrings, from expectedErrorSubstrings) drops the noise: a throw whose
 *  message contains one is an EXPECTED negative-test error (the scenario passes), not a gap, so
 *  it's excluded from every count and ranking. Omit it (or pass []) to treat every throw as a gap. */
export function summarize(records: QueryRecord[], expected: readonly string[] = []): TelemetrySummary {
  // Dedup by (graph, gremlin): re-runs (e.g. "count of" re-queries) and the
  // per-graph BeforeAll aggregations would otherwise inflate every bucket.
  const uniq = new Map<string, QueryRecord>();
  for (const r of records) {
    const k = dedupKey(r);
    // A query is deterministic; if any observation failed, treat it as failed.
    const prev = uniq.get(k);
    if (!prev || (prev.ok && !r.ok)) uniq.set(k, r);
  }
  const all = [...uniq.values()];
  const failed = all.filter((r) => !r.ok);
  const gaps = failed.filter((r) => !matchesExpected(r.error, expected));

  const buckets = new Map<string, { count: number; example: string; exampleSteps: string[] }>();
  for (const r of gaps) {
    const key = bucketKey(r.error ?? '(no message)');
    const b = buckets.get(key);
    if (b) b.count++;
    else buckets.set(key, { count: 1, example: r.gremlin, exampleSteps: r.steps });
  }

  const stepCounts = new Map<string, number>();
  for (const r of gaps) for (const s of new Set(r.steps)) stepCounts.set(s, (stepCounts.get(s) ?? 0) + 1);

  return {
    totalQueries: records.length,
    uniqueQueries: all.length,
    uniqueFailed: gaps.length,
    buckets: [...buckets.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count),
    failingSteps: [...stepCounts.entries()].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count),
    clusters: clusterGaps(records, expected),
  };
}

/** A scenario row lifted from the cucumber JSON report (read-only). */
export interface ScenarioRow {
  name: string;
  passed: boolean;
  firstFailingStep?: string;
  errorMessage?: string;
}

/** Extract per-scenario pass/fail + the first failing step from the cucumber JSON
 *  report — the info l3.test.ts currently discards. `errorMessage` is the chai
 *  assertion (the clean deferral is in the server NDJSON); the embedded Error text
 *  is pulled out when present. */
export function collectScenarios(cucumberJson: any[]): ScenarioRow[] {
  const rows: ScenarioRow[] = [];
  for (const feat of cucumberJson) for (const el of feat.elements ?? []) {
    if (el.type && el.type !== 'scenario') continue;
    const steps = el.steps ?? [];
    const passed = steps.length > 0 && steps.every((s: any) => s.result?.status === 'passed');
    if (passed) { rows.push({ name: el.name, passed: true }); continue; }
    const bad = steps.find((s: any) => s.result?.status && s.result.status !== 'passed');
    const raw: string | undefined = bad?.result?.error_message;
    const embedded = raw?.match(/Error:\s*([^\n]+?)(?:\s+at\s|\n|$)/)?.[1];
    rows.push({ name: el.name, passed: false, firstFailingStep: bad?.name, errorMessage: embedded ?? raw?.split('\n')[0] });
  }
  return rows;
}

// ---------- l3-state.json: the committed last-known-run + the delta ----------
//
// The count alone is blind two ways: it can't say WHICH scenario broke, and a
// net-positive run (more gained than lost) hides a real regression. l3-state.json
// records the exact PASSED and FAILED scenario-name sets from the last committed
// run (plus the derived count). Every run diffs against it:
//   - GAINS      — passed now, was NOT passing before (a fix landed).
//   - REGRESSIONS — was passing before, fails now (something broke → FAIL the build).
// Scenario names are globally unique in the TinkerPop gherkin corpus, so a bare
// name is a stable key. On a clean local run the state is rewritten to the current
// run (CI never rewrites). This is the single ratchet source of truth — the count
// is `passed.length`, so there is no separate baseline file.

export interface L3State {
  /** Passing-scenario count = passed.length. Kept explicit for greppability + the
   *  cucumber-summary cross-check. */
  passing: number;
  /** Total scenarios in scope at record time. */
  total: number;
  /** Sorted scenario names that passed. */
  passed: string[];
  /** Sorted scenario names that were in scope and failed. */
  failed: string[];
  _comment?: string;
}

const STATE_COMMENT =
  'L3 conformance last-known run: the passing/failing scenario sets of the official ' +
  'TinkerPop cucumber suite (scoped by test/L3-conformance/tags.ts). `bun test` FAILS if a ' +
  'scenario in `passed` now fails (a regression) or the count drops; it auto-records the ' +
  'current run here on a clean local run (CI never rewrites). `passing` = passed.length is ' +
  'the ratchet floor. Commit this file with every bump. Never hand-edit `passed` to hide a ' +
  'regression.';

export function readState(file: string): L3State {
  if (!existsSync(file)) return { passing: 0, total: 0, passed: [], failed: [] };
  const s = JSON.parse(readFileSync(file, 'utf8')) as L3State;
  return { passing: s.passing ?? 0, total: s.total ?? 0, passed: s.passed ?? [], failed: s.failed ?? [] };
}

export function writeState(file: string, rows: ScenarioRow[]): void {
  const passed = rows.filter((r) => r.passed).map((r) => r.name).sort();
  const failed = rows.filter((r) => !r.passed).map((r) => r.name).sort();
  const state: L3State = { passing: passed.length, total: rows.length, passed, failed, _comment: STATE_COMMENT };
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export interface L3Delta {
  /** Passed now, was not passing in committed state (fixes that landed). */
  gained: ScenarioRow[];
  /** Was passing in committed state, fails now (the true regressions). */
  regressed: ScenarioRow[];
}

/** Diff the committed state against this run's scenario rows. */
export function delta(prev: L3State, rows: ScenarioRow[]): L3Delta {
  const wasPassing = new Set(prev.passed);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const gained = rows.filter((r) => r.passed && !wasPassing.has(r.name));
  const regressed = [...wasPassing]
    .filter((n) => byName.has(n) && !byName.get(n)!.passed)
    .map((n) => byName.get(n)!);
  return { gained, regressed };
}

/** The human-facing before/after: gains (green) then regressions (red, with the
 *  step + error that broke them). Empty string when nothing changed. */
export function formatDelta(d: L3Delta): string {
  if (!d.gained.length && !d.regressed.length) return '';
  const L: string[] = [''];
  L.push(`──── L3 delta vs last committed run: +${d.gained.length} gained, -${d.regressed.length} regressed ────`);
  if (d.gained.length) {
    L.push('');
    L.push(`✅ NEWLY PASSING (${d.gained.length}):`);
    for (const r of d.gained) L.push(`  + ${r.name}`);
  }
  if (d.regressed.length) {
    L.push('');
    L.push(`❌ REGRESSED — passed at last run, fails now (${d.regressed.length}):`);
    for (const r of d.regressed) {
      L.push(`  - ${r.name}`);
      if (r.firstFailingStep) L.push(`      step:  ${r.firstFailingStep}`);
      if (r.errorMessage) L.push(`      error: ${r.errorMessage}`);
    }
  }
  L.push('');
  return L.join('\n');
}

/** The human-readable L3 telemetry report: deferral buckets (the systematic walls),
 *  failing-step frequency, and cucumber scenario tallies. */
export function formatReport(sum: TelemetrySummary, scenarios: ScenarioRow[]): string {
  const L: string[] = [];
  const passed = scenarios.filter((s) => s.passed).length;
  L.push('');
  L.push('════════ L3 TELEMETRY ════════');
  L.push(`queries: ${sum.totalQueries} total, ${sum.uniqueQueries} unique, ${sum.uniqueFailed} real gaps (expected negative-test throws excluded)`);
  L.push(`scenarios: ${passed}/${scenarios.length} passed`);
  L.push('');
  L.push('── deferral buckets (real gaps, most frequent first) ──');
  for (const b of sum.buckets.slice(0, 30)) {
    L.push(`  ${String(b.count).padStart(4)}  ${b.key}`);
    L.push(`        e.g. ${b.example.slice(0, 110)}`);
  }
  if (sum.buckets.length > 30) L.push(`  … ${sum.buckets.length - 30} more buckets`);
  L.push('');
  L.push('── steps present in failing chains (frequency) ──');
  L.push('  ' + sum.failingSteps.slice(0, 30).map((s) => `${s.step}:${s.count}`).join('  '));
  L.push('');
  // Contiguous real-gap runs = coherent areas (cucumber runs scenarios in feature-file order).
  // The leading number is the clump size (what the E-run in the progress line shows); "biggest
  // K×" is how many share the top error type — a high K near the clump size means ONE fix clears
  // the clump (high leverage), while many types with a small "biggest" is a fragmented stretch.
  // This is the signal the buckets above lose by scattering one area's failures across messages.
  L.push('── failure clusters (contiguous areas; high "biggest" near the size = one fix clears it) ──');
  for (const c of sum.clusters.slice(0, 12)) {
    const dom = c.buckets[0];
    const nt = c.buckets.length;
    L.push(`  ${String(c.size).padStart(4)}  ${nt} type${nt === 1 ? '' : 's'}, biggest ${dom.count}×  ·  ${dom.key.slice(0, 58)}`);
    L.push(`        e.g. ${c.example.slice(0, 96)}`);
  }
  if (sum.clusters.length > 12) L.push(`  … ${sum.clusters.length - 12} more clusters`);
  L.push('══════════════════════════════');
  return L.join('\n');
}
