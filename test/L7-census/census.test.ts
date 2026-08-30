// The census gate. See census.ts for what the artifact is and why it does not auto-record.
//
// Seven gates, ordered most-diagnostic first. Each asserts on an array of pre-formatted strings so
// the test runner's own diff IS the report.
import { test, expect, describe } from 'bun:test';
import { EXECUTES, loadCorpus, readBaseline, runCensus, type Row } from './census.ts';

/** Measured 1,263 on the one spine. The floor sits below it so ordinary progress does not trip it,
 *  while a change that guts executability does — without this, a run where everything throws would
 *  pass every other gate vacuously. */
const COVERAGE_FLOOR = 1_200;

const show = (r: Row | undefined): string =>
  !r ? 'absent'
    : EXECUTES.has(r.status) ? `${r.status} n=${r.n} ms=${r.ms ?? '-'}`
    : `${r.status}: ${r.message}`;

// Run once at module scope, not per test: every gate reads the same rows. Doing it in a `beforeAll`
// would buy nothing and doing it per test would cost a pass each.
const corpus = loadCorpus();
const rows = runCensus(corpus);
const baseline = readBaseline();
const now = new Map(rows.map((r) => [r.query, r]));
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
      return r.ms && before?.ms && r.ms !== before.ms
        ? [`  ${r.query}\n    was ${show(before)}\n    now ${show(r)}`]
        : [];
    });
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

  test('coverage floor', () => {
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    console.log(`census: ${rows.length} traversals — ${JSON.stringify(byStatus)}`);

    // Telemetry, never gates. Gains are the good direction; emission-order and message churn are
    // reported so a refactor's blast radius is visible without failing the build over wording.
    const gained = rows.filter((r) => EXECUTES.has(r.status) && baseline.get(r.query) && !EXECUTES.has(baseline.get(r.query)!.status));
    const reordered = rows.filter((r) => r.ord && baseline.get(r.query)?.ord && r.ord !== baseline.get(r.query)!.ord);
    const reworded = rows.filter((r) => r.message && baseline.get(r.query)?.message && r.message !== baseline.get(r.query)!.message);
    if (gained.length) console.log(`  +${gained.length} newly executing (re-record to bank it):\n` +
      gained.slice(0, 20).map((r) => `    + ${r.query}`).join('\n'));
    if (reordered.length) console.log(`  ${reordered.length} emission-order change(s) — telemetry, never gates`);
    if (reworded.length) console.log(`  ${reworded.length} deferral message(s) reworded — telemetry`);

    const executing = rows.filter((r) => EXECUTES.has(r.status));
    expect(executing.length).toBeGreaterThan(COVERAGE_FLOOR);
  });


});
