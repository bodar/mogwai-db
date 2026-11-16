// L9 — CONNECTOR-ONLY HOST CLOSURE: the scoped-relation connector, ALONE, never closes over fewer bodies.
//
// L5's host-closure ratchet (`test/L5-properties/host-closure.test.ts`) measures what the SHIPPING
// configuration closes over — the ladder of correlated routes and the connector, each the other's fallback.
// That number cannot tell which of the two did the work, so a change that moved a host's coverage OFF the
// connector and onto a new ladder rung would hold it level. This one runs the same sweep (same engine,
// `host-closure.ts`; same seed and size) with the ladder OFF and no ladder fallback anywhere
// (`FastPathConfig.connectorOnly`), so it reads what the general mechanism answers by itself — the
// mechanism root CLAUDE.md decision 6 makes the only one.
//
// Gates:
//   • ONE-WAY ratchet per host per level (`connector-closure-baseline.json`). A cell falling fails, naming the
//     host/level and listing the queries that newly decline (the baseline keeps a short hash of each query
//     that declined when it was recorded). A rise prints the re-record hint (`mise run connector-record`).
//   • no internal error and no undiagnosed law violation — exactly L5's semantic gate, over the connector's
//     answers. (The sample is drawn by the SHIPPING configuration, as L5 draws it: a body that runs at the top
//     level. So the denominator is independent of the connector, and comparable as the ladder is deleted.)
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { seeded } from '../support/graph.ts';
import { summary, detail } from '../support/output.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { HOSTS } from '../L5-properties/hosts.ts';
import { LEVELS, rate, renderTable, sweep, type ClosureTable } from '../L5-properties/host-closure.ts';

const BASELINE_PATH = new URL('./connector-closure-baseline.json', import.meta.url);
const RECORD = !!process.env.L9_CONNECTOR_RECORD;
/** L5's ratchet sample, so the two tables read side by side. Changing either is a re-record. */
const RATCHET_SEED = 42;
const RATCHET_CASES = 200;
/** How many newly declined queries a falling cell lists. */
const SHOW = 8;
/** The connector ALONE: the ladder neither first nor as a fallback, at a site or for the whole compile. */
const CONNECTOR_ONLY: FastPathConfig = { ...DEFAULT_FAST_PATHS, correlatedChild: false, connectorOnly: true };

interface Baseline {
  readonly seed: number;
  readonly cases: number;
  readonly fingerprint: string;
  readonly table: ClosureTable;
  /** `host@level` → short hashes of the queries that did not run when recorded. */
  readonly declined: Record<string, string[]>;
}

const hash = (q: string) => createHash('sha1').update(q).digest('hex').slice(0, 12);
const store = seeded(MODERN_SEED);

describe('L9 — connector-only host closure', () => {
  test('closure rate per host × level never falls with the connector alone; the host laws hold', () => {
    const r = sweep(store, RATCHET_SEED, RATCHET_CASES, undefined, CONNECTOR_ONLY);
    summary(`L9 connector-only host closure (seed ${RATCHET_SEED}): ${r.cases} cases of ${r.drawn} drawn\n${renderTable(r.table)}`);
    if (r.knownHits.size) summary(`  diagnosed host divergences hit: ${JSON.stringify(Object.fromEntries(r.knownHits))}`);
    expect({ internal: r.internal, divergences: r.divergences }).toEqual({ internal: [], divergences: [] });

    const declined = Object.fromEntries(Object.entries(r.unrun).map(([cell, qs]) => [cell, [...new Set(qs.map(hash))].sort()]));
    const current: Baseline = { seed: RATCHET_SEED, cases: RATCHET_CASES, fingerprint: r.fingerprint, table: r.table, declined };
    if (RECORD) {
      writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
      summary(`  recorded ${BASELINE_PATH.pathname}`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    expect(
      { seed: current.seed, cases: current.cases, fingerprint: current.fingerprint },
      'the generator (or the ratchet sample) changed, so the baseline describes a different sample — re-record with `mise run connector-record` and say why in the commit',
    ).toEqual({ seed: baseline.seed, cases: baseline.cases, fingerprint: baseline.fingerprint });

    const fell: string[] = [];
    const rose: string[] = [];
    for (const h of HOSTS) for (const lvl of LEVELS) {
      const cell = `${h.name}@${lvl}`;
      const [now, was] = [r.table[h.name]![lvl], baseline.table[h.name]?.[lvl]];
      if (!was) { rose.push(`${cell} (new)`); continue; }
      const [a, b] = [rate(now), rate(was)];
      if (a > b + 1e-9) rose.push(`${cell}: ${(100 * b).toFixed(1)}% → ${(100 * a).toFixed(1)}%`);
      if (a >= b - 1e-9) continue;
      const known = new Set(baseline.declined[cell] ?? []);
      const fresh = [...new Set(r.unrun[cell] ?? [])].filter((q) => !known.has(hash(q)));
      fell.push(`${cell}: ${(100 * b).toFixed(1)}% → ${(100 * a).toFixed(1)}% (${was.executed}/${was.applicable} → ${now.executed}/${now.applicable})`
        + (fresh.length ? `; newly declined (${fresh.length}):\n${fresh.slice(0, SHOW).map((q) => `      ${q}`).join('\n')}${fresh.length > SHOW ? `\n      … ${fresh.length - SHOW} more` : ''}` : ''));
    }
    if (rose.length) summary(`  connector closure ROSE — raise the floor with \`mise run connector-record\`: ${rose.join('; ')}`);
    detail(() => `  ${Object.values(declined).reduce((a, x) => a + x.length, 0)} declined host queries`);
    // A fall is a body the connector lowered before and no longer does — fix it in the body's lowering or in
    // `decorrelate.ts`, never by handing the case to a ladder route. Re-recording downward needs the reason.
    expect(fell, 'the connector ALONE stopped closing over a body it closed over before (root CLAUDE.md decision 6)').toEqual([]);
  }, 600_000);
});
