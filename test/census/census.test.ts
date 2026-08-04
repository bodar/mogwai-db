// The census gate. See census.ts for what the artifact is and why it does not auto-record.
//
// Seven gates, ordered most-diagnostic first. Each asserts on an array of pre-formatted strings so
// the test runner's own diff IS the report.
import { test, expect, describe } from 'bun:test';
import { EXECUTES, loadCorpus, readBaseline, runCensus, type Row } from './census.ts';

/** Measured 1,425 at the baseline. The floor sits below it so ordinary progress does not trip it,
 *  while a change that guts executability does — without this, a run where everything throws would
 *  pass every other gate vacuously. */
const COVERAGE_FLOOR = 1_400;

const show = (r: Row | undefined): string =>
  !r ? 'absent'
    : EXECUTES.has(r.status) ? `${r.status} n=${r.n} ms=${r.ms ?? '-'}`
    : `${r.status}: ${r.message}`;

const showLegacy = (r: Row | undefined): string =>
  !r?.lstatus ? 'absent'
    : EXECUTES.has(r.lstatus) ? `${r.lstatus} ms=${r.lms ?? '-'}`
    : r.lstatus;

// Run once at module scope, not per test: each corpus traversal is executed in both pinned spine
// positions and all seven gates read the same rows. Doing it in a `beforeAll` would buy nothing and
// doing it per test would cost seven passes.
const corpus = loadCorpus();
const rows = runCensus(corpus);
const baseline = readBaseline();
const now = new Map(rows.map((r) => [r.query, r]));

const executing = rows.filter((r) => EXECUTES.has(r.status));
const crashes = rows.filter((r) => r.status === 'crashed');

describe('census — the refactor guard', () => {
  test('the artifact covers exactly the corpus', () => {
    // A corpus regeneration (`mise run regen-corpus`) that adds or drops traversals lands here
    // rather than silently shrinking every gate below.
    const missing = corpus.filter((q) => !baseline.has(q));
    const stale = [...baseline.keys()].filter((q) => !now.has(q));
    if (missing.length || stale.length)
      console.log(`census: ${missing.length} corpus traversal(s) not in the artifact, ` +
        `${stale.length} artifact row(s) no longer in the corpus — run \`mise run census-record\`.`);
    expect({ missing: missing.slice(0, 20), stale: stale.slice(0, 20) }).toEqual({ missing: [], stale: [] });
  });

  test('no traversal stops executing', () => {
    // The headline regression: support lost. A traversal that answered now defers or crashes.
    const lost = rows
      .filter((r) => !EXECUTES.has(r.status) && baseline.get(r.query) && EXECUTES.has(baseline.get(r.query)!.status))
      .map((r) => `  ${r.query}\n    was ${show(baseline.get(r.query))}\n    now ${show(r)}`);
    expect(lost).toEqual([]);
  });

  test('no executing traversal changes its answer', () => {
    // The regression NOTHING else in the ladder can see: it still runs, it still fails no test, and
    // it returns something different. Compared on the weighed multiset only — `ord` is telemetry.
    const changed = rows.flatMap((r) => {
      const before = baseline.get(r.query);
      const positions: string[] = [];
      if (r.ms && before?.ms && r.ms !== before.ms)
        positions.push(`  ${r.query} [rel]\n    was ${show(before)}\n    now ${show(r)}`);
      if (r.lms && before?.lms && r.lms !== before.lms)
        positions.push(`  ${r.query} [legacy]\n    was ${showLegacy(before)}\n    now ${showLegacy(r)}`);
      return positions;
    });
    expect(changed).toEqual([]);
  });

  test('the legacy position does not change status', () => {
    // This is not the coverage ratchet (`spine`, one-way). Like the answer gate it is two-way:
    // legacy losing OR gaining a shape is a change that needs a written reason.
    const changed = rows
      .filter((r) => baseline.get(r.query) && EXECUTES.has(baseline.get(r.query)!.status) &&
        baseline.get(r.query)!.lstatus !== r.lstatus)
      .map((r) => `  ${r.query}\n    was ${showLegacy(baseline.get(r.query))}\n    now ${showLegacy(r)}`);
    expect(changed).toEqual([]);
  });

  test('no clean deferral becomes a crash', () => {
    // Fail-closed is a contract, not an aspiration: an unsupported shape must throw a CLEAR
    // deferral. A raw TypeError or a SQLite syntax error is the compiler falling over. The baseline
    // is not zero (three crashes exist today, see README), so the gate is "must not grow".
    const newly = crashes
      .filter((r) => baseline.get(r.query) && baseline.get(r.query)!.status !== 'crashed')
      .map((r) => `  ${r.query}\n    was ${show(baseline.get(r.query))}\n    now ${show(r)}`);
    expect(newly).toEqual([]);
    expect(crashes.length).toBeLessThanOrEqual([...baseline.values()].filter((r) => r.status === 'crashed').length);
  });

  test('the RelIR spine covers at least as much as the baseline', () => {
    // THE MIGRATION'S COVERAGE COUNTER (§10·4), and it is a RATCHET for the reason L3's is: a
    // number that is merely printed drifts. The pair below fails differently on purpose — the
    // per-traversal list names WHICH shape stopped routing, which is the finding; the aggregate
    // catches a wholesale loss the per-row check would report as 2,000 lines.
    //
    // It ratchets UP, opposite to `mise run deletion`, and the two are not redundant: coverage says
    // the new spine works, deletion says the old one is gone. Coverage at 100% with a non-empty §8
    // list is a FAILED migration, so neither gate alone can declare this finished.
    const lost = rows
      .filter((r) => r.spine !== 'rel' && baseline.get(r.query)?.spine === 'rel')
      .map((r) => `  ${r.query}\n    was rel, now ${r.spine}`);
    expect(lost).toEqual([]);

    const covered = rows.filter((r) => r.spine === 'rel').length;
    const before = [...baseline.values()].filter((r) => r.spine === 'rel').length;
    const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
    console.log(`census: RelIR spine covers ${covered}/${rows.length} (${pct(covered)}), baseline ${before}` +
      `${covered > before ? ` — +${covered - before}, re-record to bank it` : ''}`);
    expect(covered).toBeGreaterThanOrEqual(before);
  });

  test('coverage floor', () => {
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    console.log(`census: ${rows.length} traversals — ${JSON.stringify(byStatus)}`);

    // Telemetry, never gates. Gains are the good direction; emission-order and message churn are
    // reported so a refactor's blast radius is visible without failing the build over wording.
    const gained = rows.filter((r) => EXECUTES.has(r.status) && baseline.get(r.query) && !EXECUTES.has(baseline.get(r.query)!.status));
    const reordered = rows.filter((r) => r.ord && baseline.get(r.query)?.ord && r.ord !== baseline.get(r.query)!.ord);
    const reworded = rows.filter((r) => r.message && baseline.get(r.query)?.message && r.message !== baseline.get(r.query)!.message);
    const divergent = rows.filter((r) => r.ms !== r.lms || r.status !== r.lstatus);
    if (gained.length) console.log(`  +${gained.length} newly executing (re-record to bank it):\n` +
      gained.slice(0, 20).map((r) => `    + ${r.query}`).join('\n'));
    if (reordered.length) console.log(`  ${reordered.length} emission-order change(s) — telemetry, never gates`);
    console.log(`  ${divergent.length} spine divergence(s) — telemetry, never gates`);
    if (reworded.length) console.log(`  ${reworded.length} deferral message(s) reworded — telemetry`);

    expect(executing.length).toBeGreaterThan(COVERAGE_FLOOR);
  });
});
