// The L3 state file's own contract: what a clean run records, and — the load-bearing half — that a
// scenario we have DECLARED we do not support cannot read as a regression forever.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, type L3StateFile, type ScenarioRow } from './telemetry.ts';
import { EXCLUDED_SCENARIOS } from './tags.ts';

const STATE = join(tmpdir(), `mogwai-l3-state-${process.pid}.json`);

beforeEach(() => rmSync(STATE, { force: true }));
afterAll(() => rmSync(STATE, { force: true }));

const writeFixture = (state: L3StateFile): void =>
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

const rows: ScenarioRow[] = [
  { name: 'b', passed: true },
  { name: 'a', passed: true },
  { name: 'failed', passed: false },
];

test('a clean run records its own rows, sorted, and reads them back', () => {
  writeFixture({ passing: 0, total: 0, passed: [], failed: [] });
  writeState(STATE, rows);

  expect(readState(STATE)).toEqual({ passing: 2, total: 3, passed: ['a', 'b'], failed: ['failed'] });
});

test('a missing file reads as the empty bootstrap floor rather than throwing', () => {
  expect(readState(STATE)).toEqual({ passing: 0, total: 0, passed: [], failed: [] });
});

// ⚠️ **AN EXCLUDED SCENARIO CANNOT BE A REGRESSION.** When a name joins `EXCLUDED_SCENARIOS` — a
// capability we have DECLARED we do not have — it leaves the live report's numerator and denominator
// both. A floor still naming it would read as "was passing, now gone" forever, and no clean run could
// ever rewrite it: the ratchet fails, so the state is never recorded, so the ratchet fails. Filtering
// on READ is what makes the floor self-healing, and it keeps the decision in ONE place — the
// exclusion list — rather than requiring a hand-edit of the artifact.
test('a floor naming an EXCLUDED scenario self-heals on read', () => {
  const excluded = [...EXCLUDED_SCENARIOS][0];
  if (!excluded) return;   // nothing excluded today — the rule holds, there is just no witness
  writeFixture({ passing: 2, total: 2, passed: ['a', excluded], failed: [] });

  expect(readState(STATE)).toEqual({ passing: 1, total: 1, passed: ['a'], failed: [] });
});
