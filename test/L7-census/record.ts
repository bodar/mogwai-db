// Re-record the census baseline. `mise run census-record`.
//
// Deliberately a separate script rather than the test rewriting itself. L3 auto-records on a clean
// local run because its artifact is a monotone floor; the census is a two-way baseline where the
// dangerous transition is "still runs, different answer", and an auto-record would launder exactly
// that. Re-recording is a decision, so it takes a command.
//
// Print the delta before writing, so whoever runs this sees what they are banking.
import { EXECUTES, loadCorpus, readBaseline, runCensus, writeCensus } from './census.ts';

const corpus = loadCorpus();
const rows = runCensus(corpus);

let baseline: Map<string, ReturnType<typeof runCensus>[number]>;
try { baseline = readBaseline(); } catch { baseline = new Map(); }

if (baseline.size === 0) {
  console.log('census: no existing baseline — recording a fresh one.');
} else {
  const gained = rows.filter((r) => EXECUTES.has(r.status) && baseline.get(r.query) && !EXECUTES.has(baseline.get(r.query)!.status));
  const lost = rows.filter((r) => !EXECUTES.has(r.status) && baseline.get(r.query) && EXECUTES.has(baseline.get(r.query)!.status));
  const changed = rows.filter((r) => r.ms && baseline.get(r.query)?.ms && r.ms !== baseline.get(r.query)!.ms);

  console.log(`\n──── census delta vs the committed baseline ────`);
  console.log(`  +${gained.length} newly executing · -${lost.length} stopped executing · ${changed.length} changed answer\n`);
  for (const r of gained.slice(0, 40)) console.log(`  + ${r.query}`);
  for (const r of lost.slice(0, 40)) console.log(`  - ${r.query}\n      now ${r.status}: ${r.message}`);
  for (const r of changed.slice(0, 40)) console.log(`  ~ ${r.query}\n      ${baseline.get(r.query)!.ms} → ${r.ms}`);
  if (lost.length || changed.length)
    console.log('\n  ⚠ A lost or changed row is a REGRESSION unless you can say why it is not.\n' +
      '    Put the reason in the commit message; that is the whole value of this artifact.');
}

const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

writeCensus(rows);
console.log(`\ncensus recorded: ${rows.length} traversals — ${JSON.stringify(byStatus)}`);
console.log('Commit test/census/goldens.tsv + test/census/deferrals.tsv.');
