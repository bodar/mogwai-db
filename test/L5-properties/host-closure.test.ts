// L5 — the host-closure law (cc0-host-law). Engine, laws and rationale: `host-closure.ts`.
//
// Two sweeps:
//   • the RATCHET sample — a FIXED seed and size, recorded in `host-closure-baseline.json`, so the
//     closure rate per host × level is comparable run to run. One-way: a rate may not fall; a rise prints
//     the re-record hint (`mise run L5-host-record`). The baseline also pins the generator's fingerprint,
//     so a generator change cannot silently compare rates over a different sample.
//   • the EXPLORATION sample — the HEAD-derived L5 seed (`L5_SEED`), `L5_HOST_RUNS` cases, so every
//     commit checks the semantic laws over a fresh corpus. Its closure table is printed, never ratcheted.
// Both gate on the same two things: no internal error, and no undiagnosed law violation.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { seeded } from '../support/graph.ts';
import { summary, detail } from '../support/output.ts';
import { outcomeOf } from './oracle.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';
import { L5_SEED, L5_SEED_SOURCE } from './seed.ts';
import { HOSTS } from './hosts.ts';
import { BODY_BUDGET, rate, renderTable, sweep, type ClosureTable, type SweepResult } from './host-closure.ts';
import { KNOWN_HOST_DIVERGENCES, KNOWN_HOST_INTERNAL } from './host-known.ts';

const BASELINE_PATH = new URL('./host-closure-baseline.json', import.meta.url);
const RECORD = !!process.env.L5_HOST_RECORD;
/** The ratchet sample. Changing either is a re-record. */
const RATCHET_SEED = 42;
const RATCHET_CASES = 200;
/** Exploration size at the HEAD seed: `L5_HOST_RUNS`, else a fifth of `L5_RUNS` (so `mise run L5-random`'s
 *  3,000 explores 600 host cases), at least 60. */
const RUNS = Number(process.env.L5_HOST_RUNS ?? Math.max(60, Math.floor(Number(process.env.L5_RUNS ?? 300) / 5)));
/** The exploration body's own child-nesting depth (`L5_HOST_DEPTH`, default the ratchet's). */
const EXPLORE_BODY = { ...BODY_BUDGET, depth: Number(process.env.L5_HOST_DEPTH ?? BODY_BUDGET.depth) };

interface Baseline {
  readonly seed: number;
  readonly cases: number;
  readonly fingerprint: string;
  readonly table: ClosureTable;
}

const store = seeded(MODERN_SEED);

const gateSemantics = (r: SweepResult) => {
  expect({ internal: r.internal, divergences: r.divergences }).toEqual({ internal: [], divergences: [] });
};

const lawCensus = (r: SweepResult) =>
  [...r.laws].map(([name, t]) => `    ${name}: ${t.evaluated} evaluated, ${t.indeterminate} window-indeterminate`).join('\n');

describe('L5 — host closure', () => {
  test('ratchet sample: closure rate per host × level never falls; the host laws hold', () => {
    const r = sweep(store, RATCHET_SEED, RATCHET_CASES);
    summary(`L5 host closure (ratchet, seed ${RATCHET_SEED}): ${r.cases} cases of ${r.drawn} drawn\n${renderTable(r.table)}`);
    detail(() => `  laws:\n${lawCensus(r)}`);
    if (r.knownHits.size) summary(`  diagnosed host divergences hit: ${JSON.stringify(Object.fromEntries(r.knownHits))}`);
    gateSemantics(r);

    const current: Baseline = { seed: RATCHET_SEED, cases: RATCHET_CASES, fingerprint: r.fingerprint, table: r.table };
    if (RECORD) {
      writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
      summary(`  recorded ${BASELINE_PATH.pathname}`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    // A different sample makes every rate incomparable — say so rather than compare noise.
    expect(
      { seed: current.seed, cases: current.cases, fingerprint: current.fingerprint },
      'the generator (or the ratchet sample) changed, so the baseline describes a different sample — re-record with `mise run L5-host-record` and say why in the commit',
    ).toEqual({ seed: baseline.seed, cases: baseline.cases, fingerprint: baseline.fingerprint });

    const fell: string[] = [];
    const rose: string[] = [];
    for (const h of HOSTS) for (const lvl of ['1', '2'] as const) {
      const [now, was] = [r.table[h.name]![lvl], baseline.table[h.name]?.[lvl]];
      if (!was) { rose.push(`${h.name}@${lvl} (new)`); continue; }
      const [a, b] = [rate(now), rate(was)];
      if (a < b - 1e-9) fell.push(`${h.name}@${lvl}: ${(100 * b).toFixed(1)}% → ${(100 * a).toFixed(1)}% (${was.executed}/${was.applicable} → ${now.executed}/${now.applicable})`);
      else if (a > b + 1e-9) rose.push(`${h.name}@${lvl}: ${(100 * b).toFixed(1)}% → ${(100 * a).toFixed(1)}%`);
    }
    if (rose.length) summary(`  host closure ROSE — raise the floor with \`mise run L5-host-record\`: ${rose.join('; ')}`);
    // A fall is a host that stopped lowering a body it lowered before — or, when the denominator grew, a
    // body that newly runs inline but not under this host: a NEW seam gap either way. Fix it; re-recording
    // downward needs the reason in the commit message.
    expect(fell).toEqual([]);
  }, 600_000);

  test('exploration sample (HEAD seed): the host laws hold, no internal error', () => {
    const r = sweep(store, L5_SEED, RUNS, EXPLORE_BODY);
    summary(`L5 host closure (explore, seed ${L5_SEED} ${L5_SEED_SOURCE}): ${r.cases} cases`
      + ` — L1 ${pct(r, '1')}, L2 ${pct(r, '2')}`);
    detail(() => `${renderTable(r.table)}\n  laws:\n${lawCensus(r)}`);
    if (r.knownHits.size) summary(`  diagnosed host divergences hit: ${JSON.stringify(Object.fromEntries(r.knownHits))}`);
    gateSemantics(r);
  }, 600_000);

  test('every diagnosed host divergence still reproduces', () => {
    // A fixed entry must be deleted, not left to pretend it tracks something. Reproduces = both forms run
    // and the two disagree as multisets.
    const stale = KNOWN_HOST_DIVERGENCES.filter((k) => {
      const [a, b] = [outcomeOf(store, k.repro.actual, DEFAULT_FAST_PATHS), outcomeOf(store, k.repro.expected, DEFAULT_FAST_PATHS)];
      if (a.kind !== 'rows' || b.kind !== 'rows') return true;
      return a.weighed.size === b.weighed.size && [...a.weighed].every(([key, v]) => b.weighed.get(key) === v);
    }).map((k) => k.id);
    // An internal-error entry reproduces while its repro still throws the diagnosed message.
    const staleInternal = KNOWN_HOST_INTERNAL.filter((k) => {
      const o = outcomeOf(store, k.repro, DEFAULT_FAST_PATHS);
      return o.kind === 'rows' || !k.message.test(o.message) || !k.family.test(k.repro);
    }).map((k) => k.id);
    expect([...stale, ...staleInternal]).toEqual([]);
  });
});

function pct(r: SweepResult, lvl: '1' | '2'): string {
  const t = Object.values(r.table).reduce((a, x) => ({ applicable: a.applicable + x[lvl].applicable, executed: a.executed + x[lvl].executed }), { applicable: 0, executed: 0 });
  return `${(100 * rate(t)).toFixed(1)}% (${t.executed}/${t.applicable})`;
}
