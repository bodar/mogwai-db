// Known fast-path divergences — the L5 ratchet.
//
// Same discipline as `l3-state.json`: a committed floor, so a run fails on anything NEW while the
// already-diagnosed gaps don't block the gate. Unlike L3's state file this one is hand-curated, and
// each entry must say what the defect IS — an entry without a diagnosis is a silenced test, not a
// tracked finding.
//
// An entry here is a BUG WE HAVE NOT FIXED, never a case where divergence is acceptable. The
// fast-path contract admits no acceptable divergence: `FastPathConfig`'s own doc comments promise
// "Disabling routes through the generic path — result-equivalent", and the generic path is the
// semantic authority, so a difference is always a defect in the optimized lowering (or in a layer
// beneath both).
//
// ****  THE LIST IS CURRENTLY EMPTY, AND THAT IS THE INTENDED STATE.  ****
//
// L5's first sweep produced 22 divergent traversals in 17 step-signature groups. They reduced to
// FOUR root causes, all now fixed (L3 1475 → 1490, +15/−0, each pinned in an L4 `.feature`):
//   1. infix-composed predicates flattened by the front-end          → parseComposedPredicate
//   2. 3-arg has(LABEL,k,v) mis-read inside an inline predicate leaf  → prefix/predicate.ts
//   3. an always-producing filter body neither path could agree on    → isAlwaysProductiveFilterNoOp
//      (+ the artificial `and()/or() needs two branches` guard, which made the inline path
//      narrower than the path it accelerates)
//   4. bulkRepeatCount's seed frontier weighting by COUNT(*) instead of SUM(bulk), losing the
//      input multiplicity — a wrong answer in the DEFAULT config                → tail/bulk.ts
//
// So do not read an empty list as "nothing is tested". Read it as: the differential currently finds
// no disagreement over ~4,000 generated traversals and the 2,298-traversal corpus, with every
// switch off and each one off alone. If you are adding an entry, you are recording a REGRESSION or a
// newly-reached defect — say which, and diagnose it.
//
// ONE ENTRY PER ROOT CAUSE, NOT PER TRAVERSAL. Recording signatures instead of causes would have
// written 17 near-identical entries for what turned out to be four bugs, and buried the fact that a
// couple of lines in one file explained most of them.
//
// WHAT THIS ORACLE CANNOT SEE, so an empty list is not a claim of correctness: the differential
// compares the two lowerings against each other, so a defect PRESENT IN BOTH is invisible to it.
// Two such were found by hand while diagnosing these four and were fixed through the generic
// lowering paths: non-productive `by(key)` at `order()`, and unproductive numeric reducers in a
// filter position. Keep adding metamorphic laws for this blind-spot class rather than treating an
// empty differential ratchet as a proof of correctness.

export interface KnownDivergence {
  /** The minimal reproduction, verbatim. Also what the stale-entry check re-runs. */
  readonly query: string;
  /** Which fast-path switch attributes the divergence (`onlyDisabled(name)` reproduces it). */
  readonly fastPath: string;
  /** What actually goes wrong. Required — see the header. */
  readonly diagnosis: string;
  /**
   * Matches the FAMILY this defect covers, when more than one traversal reaches it.
   *
   * A ratchet keyed on exact strings works for a fixed corpus and fails for a generator: the
   * generator rediscovers the same root cause dressed in a different chain every run, so suppressing
   * one string leaves the run red on a variant that is not a new finding. Two ways to describe a
   * family, and `detail` is much the better one where it applies:
   *   • `detail` — match the DIVERGENCE's own message, i.e. the observed failure mode. Precise: it
   *     cannot accidentally cover an unrelated traversal that merely looks similar.
   *   • `query`  — match the traversal source. A guess about which shapes trigger the cause, so use
   *     it only when the failure mode has no distinctive message.
   * Absent = exact match only, correct for a defect only the fixed corpus reaches.
   */
  readonly family?: { readonly detail?: RegExp; readonly query?: RegExp };
}

export const KNOWN: readonly KnownDivergence[] = [
  {
    query: 'g.V().repeat(__.both()).times(3).range(5, 11)',
    fastPath: 'repeatBodyExpansion',
    diagnosis:
      "repeat()'s two body routes emit the walk in different orders, and a POSITIONAL consumer after "
      + 'the walk then picks a different window from the same multiset. The flat expansion walks the '
      + 'frontier inline; the keyed relation joins a precompiled (from_id, to_id) table, and SQLite '
      + 'has no reason to visit the two in the same order. Neither is wrong ON ITS OWN — the walk has '
      + 'no emission order to be faithful to, because a recursive CTE cannot window across iterations '
      + '(the encounter demand pass returns false at repeat()/match() for exactly this reason, '
      + 'ir/analyze.ts). So the defect is the UNDER-DETERMINATION, not either route, and it is already '
      + 'filed as such: docs/outstanding-work.md item 20 names this traversal as EXPECTED under the '
      + 'perturbation instrument, and item 4 owns the missing primitive. '
      + 'THIS ENTRY IS WHY THE FLAG WAS ADDED: the flat expansion always won where it recognised a '
      + 'body, so nothing could compare the two routes at all. The first sweep with the switch found '
      + 'exactly one disagreement across the corpus, which is the useful result either way.',
    family: { query: /^g\.V\(\)\.repeat\(__\.both\(\)\)\.times\(3\)\.range\(/ },
  },
];

/** Normalise the quote style / whitespace the corpus and the generator differ on. */
const norm = (q: string) => q.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
const INDEX = new Set(KNOWN.map((k) => norm(k.query)));
const QUERY_FAMILIES = KNOWN.map((k) => k.family?.query).filter(Boolean) as RegExp[];
const DETAIL_FAMILIES = KNOWN.map((k) => k.family?.detail).filter(Boolean) as RegExp[];

/** Is this divergence already diagnosed? `detail` is the divergence's own message when available —
 *  pass it, so a family keyed on the failure mode can match. */
export const isKnown = (query: string, detail = ''): boolean =>
  INDEX.has(norm(query))
  || QUERY_FAMILIES.some((f) => f.test(norm(query)))
  || (detail !== '' && DETAIL_FAMILIES.some((f) => f.test(detail)));

/** Known entries never hit by a run — a stale entry means the bug was fixed (delete the entry) or
 *  the traversal stopped being reachable (fix the entry). Either way it should not sit here silently
 *  pretending to track something. */
export const staleEntries = (seen: ReadonlySet<string>): KnownDivergence[] =>
  KNOWN.filter((k) => !seen.has(norm(k.query)));
