// L9 — the closure ratchet's comparison (`closure-ratchet.ts`), driven with synthetic sweeps: it is held per
// QUERY, so a fresh decline fails its cell even where a newly answered query holds the rate level.
import { describe, expect, test } from 'bun:test';
import type { ClosureTable } from '../L5-properties/host-closure.ts';
import { HOSTS } from '../L5-properties/hosts.ts';
import { compareClosure, hash, type ClosureBaseline } from './closure-ratchet.ts';

const host = HOSTS[0]!.name;
const cell = `${host}@1`;
const table = (executed: number, applicable: number): ClosureTable =>
  ({ [host]: { 1: { applicable, executed }, 2: { applicable: 0, executed: 0 }, 3: { applicable: 0, executed: 0 } } });
const QUERIES = ['g.V().a()', 'g.V().b()', 'g.V().c()', 'g.V().d()'];
const baseline: ClosureBaseline = { seed: 1, cases: 4, fingerprint: 'f', table: table(3, 4), declined: { [cell]: [hash('g.V().a()')] } };

describe('L9 — the closure ratchet comparison', () => {
  test('the same declines: passes', () => {
    expect(compareClosure(baseline, { table: table(3, 4), unrun: { [cell]: ['g.V().a()'] }, queries: QUERIES }))
      .toEqual({ failed: [], rose: [] });
  });

  test('same rate, one fresh decline swapped for a newly answered query: FAILS, naming both', () => {
    const { failed, rose } = compareClosure(baseline, { table: table(3, 4), unrun: { [cell]: ['g.V().b()'] }, queries: QUERIES });
    expect(rose).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`${cell}: 75.0% → 75.0%`);
    expect(failed[0]).toContain('SWAP');
    expect(failed[0]).toMatch(/newly declined \(1\):\n\s+g\.V\(\)\.b\(\)/);
    expect(failed[0]).toMatch(/newly answered \(1\):\n\s+g\.V\(\)\.a\(\)/);
  });

  test('a fall: fails with the fresh decline', () => {
    const { failed } = compareClosure(baseline, { table: table(2, 4), unrun: { [cell]: ['g.V().a()', 'g.V().c()'] }, queries: QUERIES });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('75.0% → 50.0%');
    expect(failed[0]).not.toContain('SWAP');
    expect(failed[0]).toMatch(/newly declined \(1\):\n\s+g\.V\(\)\.c\(\)/);
  });

  test('a rise: no failure, the re-record hint', () => {
    expect(compareClosure(baseline, { table: table(4, 4), unrun: {}, queries: QUERIES }))
      .toEqual({ failed: [], rose: [`${cell}: 75.0% → 100.0%`] });
  });
});
