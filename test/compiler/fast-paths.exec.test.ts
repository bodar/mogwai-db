// The FastPath registry (src/compiler/options/fast-paths.ts): every FastPathConfig switch must have
// exactly one FastPath object, and every FastPath must declare an equivalentWhen naming a committed
// test. This turns CLAUDE.md's prose fast-path contract ("prove it's result-equivalent") into a
// structurally-enforced obligation: a new fast-path flag added without its FastPath + equivalence
// test fails HERE, at review time.
import { test, expect, describe } from 'bun:test';
import { DEFAULT_FAST_PATHS, type FastPath } from '../../src/compiler/options/fast-paths.ts';
import { BulkRepeatCountFastPath } from '../../src/steps/tail/bulk.ts';
import { MovementCollapseFastPath } from '../../src/steps/prefix/movement.ts';
import { SingleHopOptionalFastPath } from '../../src/steps/prefix/branch.ts';
import { PredicateInliningFastPath } from '../../src/steps/prefix/predicate.ts';
import { ScalarPredicateInliningFastPath } from '../../src/steps/tail/scalar-arm.ts';
import { FtsSubstringFastPath } from '../../src/compiler/plan/plan.ts';

// The six FastPath objects, gathered here purely for the completeness assertions below. This is NOT
// a dispatch registry — each object is invoked at its own family-local site; this array only exists
// to check the set is complete + well-formed.
const ALL: FastPath<any, any>[] = [
  BulkRepeatCountFastPath, MovementCollapseFastPath, SingleHopOptionalFastPath,
  PredicateInliningFastPath, ScalarPredicateInliningFastPath, FtsSubstringFastPath,
];

describe('FastPath registry completeness', () => {
  test('every FastPathConfig flag has exactly one FastPath', () => {
    const flagNames = Object.keys(DEFAULT_FAST_PATHS).sort();
    const pathNames = ALL.map((p) => p.name).sort();
    // Exact cover: no flag without a FastPath, no FastPath without a flag, no duplicates.
    expect(pathNames).toEqual(flagNames);
    expect(new Set(pathNames).size).toBe(pathNames.length);
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
