// Re-record the L6 workload baseline. `mise run workload-record`.
//
// A command, never the test rewriting itself (the census's rule, test/CLAUDE.md): the baseline holds
// WRONG answers as well as passes, and an auto-record would launder a new wrong answer into the floor.
// So this prints the full report and the delta first, carries every human-written reason forward, and
// writes a NEW wrong answer or divergence with an UNTRIAGED reason — which the test refuses until a
// person replaces it with why the entry is on the books.
import { existsSync, writeFileSync } from 'node:fs';
import { BASELINE_PATH, UNTRIAGED, nextBaseline, readBaseline, report, runWorkload, type Baseline } from './workload.ts';

const results = runWorkload();
const prior: Baseline | null = existsSync(BASELINE_PATH) ? readBaseline() : null;
const next = nextBaseline(results, prior);

console.log(report(results));
if (prior) {
  const changed = results.filter((r) => prior.outcomes[r.entry.id] !== r.outcome);
  console.log(`\n──── delta vs the committed baseline: ${changed.length} change(s)`);
  for (const r of changed) console.log(`  ${r.entry.id}: ${prior.outcomes[r.entry.id] ?? '(new)'} → ${r.outcome}`);
}
const untriaged = [...Object.entries(next.wrong), ...Object.entries(next.divergent)].filter(([, why]) => why.startsWith(UNTRIAGED));
if (untriaged.length) {
  console.log(`\n⚠ ${untriaged.length} entry(ies) need a written reason in ${BASELINE_PATH.pathname} before the test will pass:`);
  for (const [id, why] of untriaged) console.log(`  ${id}: ${why}`);
}
writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 1) + '\n');
console.log(`\nwrote ${BASELINE_PATH.pathname} — ${JSON.stringify(next.counts)}`);
