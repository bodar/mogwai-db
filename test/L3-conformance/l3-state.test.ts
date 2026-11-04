// The L3 state file's own contract: what a clean run records, and — the load-bearing half — that a
// scenario we have DECLARED we do not support cannot read as a regression forever.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, type L3StateFile, type ScenarioRow } from './telemetry.ts';
import { EXCLUDED_SCENARIOS } from './tags.ts';
import { EXPECTED_OUTCOMES, REASONS, auditLedger, declinesThatAnswered, type ReasonKey } from './expected-outcomes.ts';

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

// ── The expected-outcome ledger (`expected-outcomes.ts`) against the COMMITTED floor ─────────────────
//
// The live L3 run checks the ledger against what it just measured; these check it against what is
// committed, so a stale ledger fails in every test run and not only the slow one.

const ROOT = new URL('../../', import.meta.url);
const COMMITTED = new URL('./l3-state.json', import.meta.url).pathname;

test('every committed failure is ledgered, and nothing ledgered passes (by multiplicity)', () => {
  const { failed, passed } = readState(COMMITTED);
  expect(failed.length).toBeGreaterThan(0);
  expect(auditLedger(failed, passed)).toEqual({ unledgered: [], stale: [] });
});

test('the audit compares MULTISETS — a repeated name is two scenarios, either of which may pass', () => {
  const ledger = { 'tree-step': ['dup', 'x'] } as const;
  // `dup` fails once and passes once: one ledger entry is exactly right.
  expect(auditLedger(['dup', 'x'], ['dup'], { 'tree-step': ['dup', 'x'] })).toEqual({ unledgered: [], stale: [] });
  // Both `dup` scenarios fail, but the ledger names it once: one is unexplained.
  expect(auditLedger(['dup', 'dup', 'x'], [], ledger).unledgered).toEqual(['dup']);
  // `x` was fixed: its entry is stale and says so.
  expect(auditLedger(['dup'], ['x'], ledger).stale).toEqual([{ name: 'x', passes: true }]);
});

test('every reason is used, and cites a document that says it', () => {
  const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
  const section = (text: string, heading: RegExp) => {
    const start = text.search(heading);
    const rest = text.slice(start + 1);
    const end = rest.search(/^## /m);
    return start < 0 ? '' : rest.slice(0, end < 0 ? undefined : end);
  };
  const divergences = section(read('docs/feature-support-matrix.md'), /^## 17\. /m);
  const wrongAnswers = section(read('docs/outstanding-work.md'), /^## 1\. /m);
  for (const [key, reason] of Object.entries(REASONS) as [ReasonKey, (typeof REASONS)[ReasonKey]][]) {
    expect({ key, names: EXPECTED_OUTCOMES[key].length > 0 }).toEqual({ key, names: true });
    const [path, text] = reason.cite;
    expect({ key, cited: read(path).includes(text) }).toEqual({ key, cited: true });
    // The anti-laundering half: a DIVERGENCE must be a §17 row, a DEFECT must be a §1 wrong answer with
    // its ID. A wrong answer cannot be filed as a divergence, because §17 would have to say it.
    if (reason.kind === 'divergence') expect({ key, in17: path === 'docs/feature-support-matrix.md' && divergences.includes(text) }).toEqual({ key, in17: true });
    if (reason.kind === 'defect') expect({ key, in1: path === 'docs/outstanding-work.md' && /^\([\w-]+\)$/.test(text) && wrongAnswers.includes(text) }).toEqual({ key, in1: true });
  }
});

test('a ledgered decline that answers is reported, whatever the answer', () => {
  const ledger = { 'tree-step': ['declines', 'answers', 'unrun'], 'map-merge': ['wrong'] } as const;
  const queries = [
    { scenario: 'declines', ok: false, declined: true },
    { scenario: 'answers', ok: true },
    { scenario: 'answers', ok: false, declined: false },   // some other error is not a decline either
    { scenario: 'wrong', ok: true },                      // a defect is not held to declining
  ];
  expect(declinesThatAnswered(queries, new Set(['declines', 'answers', 'wrong']), ledger)).toEqual(['answers']);
});
