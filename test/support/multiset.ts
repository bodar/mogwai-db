import type { Framed } from '../../src/execute.ts';

/**
 * A traverser multiset, keyed by the GraphBinary encoding of the value and valued by total bulk.
 *
 * This is the ONLY comparison that can hold across the movement-collapse switch. Collapse emits one
 * row carrying `SUM(bulk)`; the generic UNION-ALL form emits `bulk` separate rows ("same result, more
 * rows", per the flag's own comment). Both denote the same multiset of traversers, so summing bulk per
 * distinct value is what makes them comparable — and it is also just what a traverser multiset IS
 * (root `CLAUDE.md`: "Traversers are multisets"). Expanding bulk into literal copies would be
 * equivalent but is not an option: collapse exists precisely because the walk count it folds up can be
 * exponential.
 *
 * ## Why it lives in `test/support/` and not in either caller
 *
 * L5's differential oracle (`L5-properties/oracle.ts`) and the census (`census/census.ts`) both need
 * it, so it lives in neither — the same rule `test/support/graph.ts` already follows for the shared
 * seeds.
 *
 * That is not tidiness. The census had its own answer digest which folded bulk in **per row**
 * (`hex[i]*bulk`, sorted) under a comment claiming it "denotes the traverser MULTISET, exactly what
 * oracle.ts's `weigh()` compares". It did not: `{a, b, b, b}` emitted as four bulk-1 rows and the same
 * multiset emitted as `(a,1),(b,3)` hash differently, so the answer-change gate — the one instrument
 * §7.5 of `docs/2026-08-09-repeat-two-regimes-plan.md` names as THE gate for collapse work — reported a
 * changed answer for every traversal that merely started collapsing. Two readings of one fact, and the
 * wrong one was load-bearing.
 */
export function weigh(framed: readonly Framed[]): ReadonlyMap<string, bigint> {
  const m = new Map<string, bigint>();
  for (const f of framed) {
    const k = f.buf.toString('hex');
    m.set(k, (m.get(k) ?? 0n) + f.bulk);
  }
  return m;
}

/** The multiset as a stable string — sorted `value*totalBulk` pairs. What a digest hashes. */
export const multisetKey = (framed: readonly Framed[]): string =>
  [...weigh(framed)].map(([hex, bulk]) => `${hex}*${bulk}`).sort().join('|');
