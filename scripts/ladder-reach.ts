// LADDER REACH — the instrument (`mise run ladder-reach`): what the shipping default answers that the scoped-relation
// connector ALONE does not, per pool and per ladder family, plus the answers only `bothChildOrders`' second child
// order rescues. `docs/2026-11-16-ladder-retirement-plan.md` R0.
//
// The GATE is L9's ladder-reach ratchet (`test/L9-connector/connector-closure.test.ts`), over the pools L9 already
// sweeps. This is the WIDER sample the retirement audit measured with, deliberately not in `ci` (minutes, not
// seconds): the L1 corpus, the L6 workload, and the generator's hosts over 200 distinct bodies at level 1 (`H1`)
// and EVERY well-typed host pair at level 2 (`H2`, ~25k traversals). Same engine (`ladder-reach.ts`), so the two
// agree on what a ladder-only answer, a family and a rescue are. All modes run in this one process: the modes are
// per-compile options (`FastPathConfig.connectorOnly`, `childOrderRetry`), not process state.
//
//   bun scripts/ladder-reach.ts [--cases N] [--list]
//     --cases N  distinct bodies for H1/H2 (default 200)
//     --list     print every ladder-only traversal, not only the table
import fc from 'fast-check';
import { MODERN_SEED } from '../test/fixtures/seed-modern.ts';
import { seeded, isNondeterministic } from '../test/support/graph.ts';
import { hostCase } from '../test/L5-properties/generate.ts';
import { HOSTS } from '../test/L5-properties/hosts.ts';
import { BODY_BUDGET, PREFIX_BUDGET } from '../test/L5-properties/host-closure.ts';
import { counts, l1Pool, l6Pool, reach, renderCounts, type PoolQuery } from '../test/L9-connector/ladder-reach.ts';

const arg = (name: string) => { const i = Bun.argv.indexOf(name); return i < 0 ? undefined : Bun.argv[i + 1]; };
const CASES = Number(arg('--cases') ?? 200);
const LIST = Bun.argv.includes('--list');

const modern = seeded(MODERN_SEED);
const hostPool: PoolQuery[] = [];
const seen = new Set<string>();
for (const c of fc.sample(hostCase(PREFIX_BUDGET, BODY_BUDGET), { seed: 42, numRuns: CASES * 4 })) {
  const inline = `${c.prefix}.${c.body}`;
  if (seen.has(inline) || isNondeterministic(inline)) continue;
  seen.add(inline);
  if (seen.size > CASES) break;
  const anon = `__.${c.body}`;
  for (const h of HOSTS) if (h.applies(c.from, c.to)) {
    hostPool.push({ pool: 'H1', q: `${c.prefix}.${h.render(anon)}`, store: modern });
    const mid = h.out(c.from, c.to);
    for (const h1 of HOSTS) if (h1.applies(c.from, mid)) hostPool.push({ pool: 'H2', q: `${c.prefix}.${h1.render(`__.${h.render(anon)}`)}`, store: modern });
  }
}

const t0 = performance.now();
const r = reach([...l1Pool(),...l6Pool(), ...hostPool]);
const secs = ((performance.now() - t0) / 1000).toFixed(1);
for (const [pool, t] of Object.entries(r.pools)) console.log(`  ${pool}: ${t.queries} traversals, default answers ${t.byDefault}, connector alone ${t.connectorOnly}`);
console.log(`ladder-only (answered by default, not by the connector alone), ${secs}s:\n${renderCounts(counts(r))}`);
if (LIST) for (const x of r.ladderOnly) console.log(`  ${x.pool}\t${x.family}${x.rescued ? ' (rescued)' : ''}\t${x.q}`);
if (r.differ.length) console.log(`DIFFER — both answered, different multisets (${r.differ.length}):\n${r.differ.map((q) => `  ${q}`).join('\n')}`);
if (r.connectorOnlyAnswers.length) console.log(`CONNECTOR-ONLY answers the default lost (${r.connectorOnlyAnswers.length}):\n${r.connectorOnlyAnswers.map((q) => `  ${q}`).join('\n')}`);
if (r.differ.length || r.connectorOnlyAnswers.length) process.exit(1);
