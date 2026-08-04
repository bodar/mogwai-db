// L3 state-section isolation — the load-bearing rule that neither spine configuration can lower
// the other's conformance floor when a clean local run records its own results.

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, spineGap, writeState, type L3StateFile, type ScenarioRow } from './telemetry.ts';

const STATE = join(tmpdir(), `mogwai-l3-state-${process.pid}.json`);
const relRows: ScenarioRow[] = [
  { name: 'rel-b', passed: true },
  { name: 'rel-a', passed: true },
  { name: 'rel-failed', passed: false },
];
const legacyRows: ScenarioRow[] = [
  { name: 'legacy-a', passed: true },
  { name: 'legacy-failed', passed: false },
];

beforeEach(() => rmSync(STATE, { force: true }));
afterAll(() => rmSync(STATE, { force: true }));

const writeFixture = (state: L3StateFile): void =>
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');

const parsed = (): L3StateFile => JSON.parse(readFileSync(STATE, 'utf8')) as L3StateFile;
const topFloor = (state: L3StateFile): unknown => ({
  passing: state.passing,
  total: state.total,
  passed: state.passed,
  failed: state.failed,
});

test('a legacy write leaves the top-level floor byte-identical', () => {
  const initial: L3StateFile = {
    passing: 2, total: 3, passed: ['rel-a', 'rel-b'], failed: ['rel-failed'],
    _comment: 'old explanation',
  };
  writeFixture(initial);
  const before = JSON.stringify(topFloor(parsed()));

  writeState(STATE, legacyRows, 'legacy');

  expect(JSON.stringify(topFloor(parsed()))).toBe(before);
});

test('a default write leaves the legacy floor byte-identical', () => {
  const initial: L3StateFile = {
    passing: 1, total: 1, passed: ['old-rel'], failed: [],
    legacySpine: { passing: 1, total: 2, passed: ['legacy-a'], failed: ['legacy-failed'] },
  };
  writeFixture(initial);
  const before = JSON.stringify(parsed().legacySpine);

  writeState(STATE, relRows, 'rel');

  expect(JSON.stringify(parsed().legacySpine)).toBe(before);
});

test('a missing legacy section reads as the empty bootstrap floor', () => {
  writeFixture({ passing: 1, total: 1, passed: ['rel-a'], failed: [] });

  expect(readState(STATE, 'legacy')).toEqual({ passing: 0, total: 0, passed: [], failed: [] });
});

test('each spine reads back exactly its own write', () => {
  writeState(STATE, relRows, 'rel');
  writeState(STATE, legacyRows, 'legacy');

  expect(readState(STATE, 'rel')).toEqual({
    passing: 2, total: 3, passed: ['rel-a', 'rel-b'], failed: ['rel-failed'],
  });
  expect(readState(STATE, 'legacy')).toEqual({
    passing: 1, total: 2, passed: ['legacy-a'], failed: ['legacy-failed'],
  });
  expect(readState(STATE, 'rel')).not.toEqual(readState(STATE, 'legacy'));
});

test('spineGap reports both set directions despite repeated scenario names', () => {
  const gap = spineGap(
    { passing: 3, total: 3, passed: ['shared', 'rel-only', 'rel-only'], failed: [] },
    { passing: 3, total: 3, passed: ['shared', 'legacy-only', 'legacy-only'], failed: [] },
  );

  expect(gap).toEqual({ relOnly: ['rel-only'], legacyOnly: ['legacy-only'] });
});
