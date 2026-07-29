// L5 — the metamorphic oracle: every law in laws.ts, over generated contexts.
//
// Both sides of a law run through the SAME lowering with the SAME config, so this tests semantics
// rather than fast paths — the axis the differential (differential.test.ts) structurally cannot
// reach, since it compares the two lowerings against each other and is blind to a defect they share.
//
// GATING DIFFERS FROM THE DIFFERENTIAL, and the reason matters. There, one side throwing IS a defect:
// a fast path must never change whether a traversal is supported. Here it is not: if `outE(l).inV()`
// compiles and `out(l)` does not (or the reverse), the law simply cannot be evaluated — that is a
// support gap, which fails closed and is already visible in the matrix. Only a case where BOTH sides
// ran and disagreed proves a wrong answer. So:
//
//   both ran, multisets differ  → DEFECT, fails the run
//   one side threw              → not evaluable; counted and reported, never gated
//   same multiset, order differs → telemetry (same reasoning as the differential: order().by(key)
//                                  gives only a partial order, so a tie reordering is within spec)
//
// Reporting the not-evaluable count is what keeps a pass honest: a law whose every instantiation
// throws would otherwise look identical to a law that holds everywhere.
import { test, expect, describe } from 'bun:test';
import fc from 'fast-check';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { outcomeOf, diverge, GATING } from './oracle.ts';
import { seeded } from '../support/graph.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';
import { prefix } from './generate.ts';
import { LAWS } from './laws.ts';
import { L5_SEED } from './seed.ts';

const SEED = L5_SEED;
/** Per-law instantiations. Modest by default (there are ~17 laws, so this is ~1,300 pairs and ~2,600
 *  compiles); L5_RUNS raises it for an exploration pass. */
const RUNS = Number(process.env.L5_LAW_RUNS ?? Math.max(40, Math.floor(Number(process.env.L5_RUNS ?? 300) / 4)));

describe('L5 — metamorphic laws', () => {
  // A single store: every law is a READ pair, so nothing mutates and one seeding serves the suite.
  const store = seeded(MODERN_SEED);

  LAWS.forEach((law, i) => {
    test(`${law.name}`, () => {
      const broken: string[] = [];
      let evaluated = 0, prefixUnsupported = 0, lawFormUnsupported = 0, orderDiffs = 0, knownBrokenHits = 0;

      fc.assert(
        fc.property(prefix(law.on, { steps: 4, depth: 2 }), (p) => {
          const a = outcomeOf(store, law.lhs(p.src), DEFAULT_FAST_PATHS);
          const b = outcomeOf(store, law.rhs(p.src), DEFAULT_FAST_PATHS);
          // Either side unsupported → the law says nothing here. Split by CAUSE, because the two
          // mean different things: an unsupported PREFIX is a ceiling measure (the generator reached
          // a composition we do not lower yet, already fail-closed and visible in the matrix), while
          // a prefix that compiles but a law FORM that does not is a support asymmetry between two
          // spellings of the same thing — the more interesting signal, and the one worth chasing.
          if (a.kind === 'threw' || b.kind === 'threw') {
            if (outcomeOf(store, p.src, DEFAULT_FAST_PATHS).kind === 'threw') prefixUnsupported++;
            else lawFormUnsupported++;
            return true;
          }
          evaluated++;
          const d = diverge(a, b, store);
          if (!d) return true;
          if (!GATING.has(d.kind)) { orderDiffs++; return true; }
          // A diagnosed context (laws.ts knownBroken) — a bug we have not fixed, tracked rather than
          // gated, exactly as the differential's ratchet works. Never an "acceptable exception": an
          // invalid law gets NARROWED instead (as the order() permutation law was, to the bare form).
          if (law.knownBroken?.some((k) => k.prefix.test(p.src))) { knownBrokenHits++; return true; }
          broken.push(`  prefix ${p.src}\n    lhs ${law.lhs(p.src)}\n    rhs ${law.rhs(p.src)}\n    [${d.kind}] ${d.detail}`);
          // false (not throw) so fast-check shrinks the PREFIX to the smallest context that breaks
          // the law — which is the whole point of generating the context.
          return false;
        }),
        // SEED + i so the laws sample different contexts rather than all re-testing one set.
        { seed: SEED + i, numRuns: RUNS, verbose: true },
      );

      if (broken.length) console.log(`LAW BROKEN — ${law.name}\n  why: ${law.why}\n${broken.join('\n')}`);
      expect(broken).toEqual([]);
      // A law that never evaluated proves nothing — surface it rather than passing silently.
      expect(evaluated).toBeGreaterThan(0);
      console.log(`  ${law.name}: ${evaluated} evaluated`
        + `, ${prefixUnsupported} prefix-unsupported, ${lawFormUnsupported} law-form-unsupported`
        + `, ${orderDiffs} order-only`
        + (knownBrokenHits ? `, ${knownBrokenHits} KNOWN-BROKEN (diagnosed in laws.ts)` : ''));
    }, 600_000);
  });

  test('every law states its reasoning', () => {
    // A law without a stated spec fact is an assumption: when it fails, nobody can tell whether the
    // engine or the law is wrong. Cheap structural guard, in the spirit of FastPath.equivalentWhen.
    for (const law of LAWS) {
      expect(law.why.length).toBeGreaterThan(40);
      expect(law.lhs('g.V()')).not.toEqual(law.rhs('g.V()'));
    }
    expect(LAWS.length).toBeGreaterThan(10);
  });
});
