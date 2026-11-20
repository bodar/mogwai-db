// L9 — CONNECTOR HOST CLOSURE: the scoped-relation connector never closes over fewer bodies.
//
// The same sweep as L5's host-closure ratchet (`test/L5-properties/host-closure.test.ts`; same engine,
// `host-closure.ts`; same seed and size), held PER QUERY rather than per rate. The connector is the one mechanism
// for nesting (root CLAUDE.md decision 6): the ladder of correlated routes and the `correlatedChild` switch that
// ordered it against the connector are deleted (`docs/2026-11-16-ladder-retirement-plan.md` R7), so what this
// sweep reads is what the shipping configuration answers — the connector, and a host's own tail where the
// connector's row does not claim the site (`scopedHost`, `src/compiler/rel/lower/scoped.ts`).
//
// Gates:
//   • ONE-WAY ratchet per host per level (`connector-closure-baseline.json`), held per QUERY: the baseline keeps a
//     short hash of each query that declined when it was recorded, and any query declining now that did not then
//     fails its cell — even at the same rate, where it was swapped for a newly answered one and both are named
//     (`closure-ratchet.ts`). A rise prints the re-record hint (`mise run connector-record`).
//   • no internal error and no undiagnosed law violation — exactly L5's semantic gate.
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { seeded } from '../support/graph.ts';
import { summary, detail } from '../support/output.ts';
import { renderTable, sweep } from '../L5-properties/host-closure.ts';
import { compareClosure, hash, type ClosureBaseline } from './closure-ratchet.ts';

const BASELINE_PATH = new URL('./connector-closure-baseline.json', import.meta.url);
const RECORD = !!process.env.L9_CONNECTOR_RECORD;
/** L5's ratchet sample, so the two tables read side by side. Changing either is a re-record. */
const RATCHET_SEED = 42;
const RATCHET_CASES = 200;

const store = seeded(MODERN_SEED);

describe('L9 — connector host closure', () => {
  test('no host query the connector closed over newly declines (rate per host × level never falls); the host laws hold', () => {
    const r = sweep(store, RATCHET_SEED, RATCHET_CASES);
    summary(`L9 connector host closure (seed ${RATCHET_SEED}): ${r.cases} cases of ${r.drawn} drawn\n${renderTable(r.table)}`);
    if (r.knownHits.size) summary(`  diagnosed host divergences hit: ${JSON.stringify(Object.fromEntries(r.knownHits))}`);
    expect({ internal: r.internal, divergences: r.divergences }).toEqual({ internal: [], divergences: [] });

    const declined = Object.fromEntries(Object.entries(r.unrun).map(([cell, qs]) => [cell, [...new Set(qs.map(hash))].sort()]));
    const current: ClosureBaseline = { seed: RATCHET_SEED, cases: RATCHET_CASES, fingerprint: r.fingerprint, table: r.table, declined };
    if (RECORD) {
      writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
      summary(`  recorded ${BASELINE_PATH.pathname}`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as ClosureBaseline;
    expect(
      { seed: current.seed, cases: current.cases, fingerprint: current.fingerprint },
      'the generator (or the ratchet sample) changed, so the baseline describes a different sample — re-record with `mise run connector-record` and say why in the commit',
    ).toEqual({ seed: baseline.seed, cases: baseline.cases, fingerprint: baseline.fingerprint });

    const { failed, rose } = compareClosure(baseline, { table: r.table, unrun: r.unrun, queries: r.outcomes.keys() });
    if (rose.length) summary(`  connector closure ROSE — raise the floor with \`mise run connector-record\`: ${rose.join('; ')}`);
    detail(() => `  ${Object.values(declined).reduce((a, x) => a + x.length, 0)} declined host queries`);
    // A fresh decline is a body the connector lowered before and no longer does — at a lower rate or swapped for a
    // newly answered one at the same rate. Fix it in the body's lowering or in `decorrelate.ts`, never with a
    // correlated route of its own. An INTENDED new decline is a re-record with its reason in the commit.
    expect(failed, 'the connector stopped closing over a body it closed over before (root CLAUDE.md decision 6)').toEqual([]);
  }, 600_000);
});
