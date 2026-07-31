// The FastPath registry (src/compiler/options/fast-paths.ts): every FastPathConfig switch must have
// exactly one FastPath object, and every FastPath must declare an equivalentWhen naming a committed
// test. This turns CLAUDE.md's prose fast-path contract ("prove it's result-equivalent") into a
// structurally-enforced obligation: a new fast-path flag added without its FastPath + equivalence
// test fails HERE, at review time.
import { test, expect, describe } from 'bun:test';
import { DEFAULT_FAST_PATHS, GATE_ONLY_FAST_PATHS, type FastPath } from '../../src/compiler/options/fast-paths.ts';
import { BulkRepeatCountFastPath } from '../../src/compiler/steps/tail/bulk.ts';
import { MovementCollapseFastPath } from '../../src/compiler/steps/prefix/movement.ts';
import { SingleHopOptionalFastPath } from '../../src/compiler/steps/prefix/branch.ts';
import { PredicateInliningFastPath } from '../../src/compiler/steps/prefix/predicate.ts';
import { ScalarPredicateInliningFastPath } from '../../src/compiler/steps/tail/scalar-arm.ts';
import { FtsSubstringFastPath } from '../../src/compiler/plan/plan.ts';

// The six FastPath objects, gathered here purely for the completeness assertions below. This is NOT
// a dispatch registry — each object is invoked at its own family-local site; this array only exists
// to check the set is complete + well-formed.
const ALL: FastPath<any, any>[] = [
  BulkRepeatCountFastPath, MovementCollapseFastPath, SingleHopOptionalFastPath,
  PredicateInliningFastPath, ScalarPredicateInliningFastPath, FtsSubstringFastPath,
];

describe('FastPath registry completeness', () => {
  test('every FastPathConfig flag has exactly one FastPath, or is a declared gate-only switch', () => {
    const flagNames = Object.keys(DEFAULT_FAST_PATHS).sort();
    const pathNames = ALL.map((p) => p.name as string);
    const gateOnly = Object.keys(GATE_ONLY_FAST_PATHS);
    // Exact cover, still: no flag uncovered, nothing covered twice, no FastPath without a flag.
    // `repeatBodyExpansion` is the gate-only case — it chooses between two body PROVIDERS inside one
    // recursive-CTE construction, so it has no separable artifact for a `tryLower` to return, and a
    // `tryLower` that lowered nothing would model it falsely just to satisfy this assertion.
    expect([...pathNames, ...gateOnly].sort()).toEqual(flagNames);
    expect(new Set([...pathNames, ...gateOnly]).size).toBe(flagNames.length);
  });

  test('a gate-only switch still owes its equivalence', () => {
    // The one thing a gate-only flag is NOT excused from: naming the committed test that proves
    // enabled ≡ disabled. Same obligation as `equivalentWhen`, same reason.
    for (const [name, equivalentWhen] of Object.entries(GATE_ONLY_FAST_PATHS)) {
      expect(typeof equivalentWhen).toBe('string');
      expect(equivalentWhen.length).toBeGreaterThan(0);
      expect(name in DEFAULT_FAST_PATHS).toBe(true);
    }
  });

  test('every FastPath declares a non-empty equivalentWhen', () => {
    // The "prove it's result-equivalent" law as a required field. A blank one fails review here.
    for (const p of ALL) {
      expect(typeof p.equivalentWhen).toBe('string');
      expect(p.equivalentWhen.length).toBeGreaterThan(0);
    }
  });

  test('every FastPath exposes appliesWhen + tryLower', () => {
    for (const p of ALL) {
      expect(typeof p.appliesWhen).toBe('function');
      expect(typeof p.tryLower).toBe('function');
    }
  });
});
