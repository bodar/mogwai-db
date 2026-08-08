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
// The ONE principled exception, and it is the ORACLE's blind spot rather than a licence: where
// TinkerPop itself leaves an emission ORDER unspecified (a `the result should be OF` scenario), the
// two routes may legitimately pick different valid windows — and a POSITIONAL consumer turns that
// within-spec order difference into a `multiset` difference this oracle cannot tell from a wrong
// answer. Such an entry is kept because this is the only channel that can suppress it, and it must
// PROVE within-spec by citing the reference scenario — never assert it. `repeatBodyExpansion` is the
// only one, and the day the oracle can read a traversal's reference assertion it moves out of here.
//
// ****  EMPTY IS THE INTENDED STATE. THE LIST IS NOT EMPTY — see the entries below.  ****
//
// (This line claimed emptiness while an entry already sat below it; a header that describes a state
// the file has left is worse than no header, because it is read as a summary. TWO entries today:
// `repeatBodyExpansion`, an under-determined emission ORDER neither route owns (the within-spec
// exception above); and `predicateInlining`, a genuine contract defect — the generic path THROWS on a
// child body the fast path answers (a slice-then-values existence test the legacy child lowering
// cannot express).
//
// The `propertySeek` entry that sat here was NOT a fast-path defect at all — it was a wrong ANSWER
// present in BOTH spine positions (this oracle's own blind spot), which `propertySeek` merely masked
// by lifting a `has()`'s `EXISTS` into a join. Root cause: SQLite silently drops an `OFFSET` when the
// offset's block has a single-table `FROM` and a positive correlated `EXISTS` in its `WHERE`, so the
// whole `where(…)`/`has(…)`-then-`skip`/`range` family answered wrong under the DEFAULT config. Fixed
// generically by a `MATERIALIZED`-CTE fence between the filter and the offset — `slice` /
// `offsetDropsOverExists` in `src/compiler/rel/lower.ts` — and pinned in
// `test/L4-addendum/offset-over-correlated-exists.feature`.)
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
      + 'ir/analyze.ts). '
      + 'AND TINKERPOP AGREES THE ORDER IS UNSPECIFIED — THIS IS NOT A LOWERING DEFECT: the reference '
      + 'scenario for this EXACT traversal, g_V_repeatXbothX_timesX3X_rangeX5_11X, asserts `the result '
      + 'should be OF` v[marko]/v[josh]/v[peter]/v[lop]/v[vadas]/v[ripple] — i.e. each of the six '
      + 'results need only be ONE OF the six vertices, not a fixed window (vendor/tinkerpop/gremlin-'
      + 'test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/filter/Range.feature, at '
      + 'the pin). Both routes return six valid vertices, so both PASS conformance; they simply pick '
      + "different valid windows. This is the `order`-telemetry class that a slice amplified into a "
      + 'multiset difference the oracle cannot recognise as within-spec — the limitation is the '
      + "ORACLE's (it compares specific multisets), not the lowering's. It is kept here because that "
      + 'is the only channel to suppress it; docs/outstanding-work.md item 20 names this traversal as '
      + 'EXPECTED under the perturbation instrument (an exemption, not a fix), and item 4 owns the '
      + 'OPTIONAL primitive that would make repeat()-then-slice determinate — a nicety the reference '
      + 'does not require, NOT a correctness debt. '
      + 'THIS ENTRY IS WHY THE FLAG WAS ADDED: the flat expansion always won where it recognised a '
      + 'body, so nothing could compare the two routes at all. The first sweep with the switch found '
      + 'exactly one disagreement across the corpus, which is the useful result either way.',
    family: { query: /^g\.V\(\)\.repeat\(__\.both\(\)\)\.times\(3\)\.range\(/ },
  },
  {
    query: "g.V(1).outE().outV().has('name', TextP.containing('a')).where(__.out().range(0, 2).values('name'))",
    fastPath: 'predicateInlining',
    diagnosis:
      'THE GENERIC PATH REFUSES WHAT THE FAST PATH ANSWERS, which inverts the `FastPathConfig` '
      + 'contract rather than merely disagreeing with it. With every switch on, this yields marko at '
      + 'bulk 3; with `predicateInlining` alone disabled it THROWS `where() traversal not supported by '
      + 'inline predicate or generic child existence lowering`. `src/compiler/CLAUDE.md` states the '
      + 'bar a specialized lowering has to clear — "disabling it compiles the same traversal '
      + 'generically" — and this body does not clear it. '
      + 'ATTRIBUTION IS EXACT: all eight switches were toggled off individually against this '
      + 'traversal and only `predicateInlining` changes the outcome. `movementCollapse` off returns '
      + 'THREE separate rows where on returns one row at bulk 3, which is the documented RLE encoding '
      + 'and the same multiset, not a divergence. '
      + 'WHAT THE BODY NEEDS is a child EXISTENCE lowering that admits a slice followed by a value '
      + 'projection (`__.out().range(0, 2).values(k)`): the generic path handles a bare movement body '
      + 'and gives up once the body slices. The shrunk witnesses are the same shape under `not()` and '
      + '`filter()` as well as `where()`, and with `both()`/`otherV()`/`endingWith` substituted, which '
      + 'is why this is ONE entry and one family regex rather than a dozen. '
      + 'SEVERITY: production is CORRECT — the switch defaults on, so this is the disable path, the '
      + 'class the header above records four switches for. It is still a contract defect, because a '
      + 'generic path that cannot express the shape cannot be the semantic authority that arbitrates it. '
      + 'RECORDED RATHER THAN FIXED because the fix is in the LEGACY generic child-existence lowering, '
      + 'a route with an end date, and RelIR reaches the same shape through `correlatedExists` / '
      + '`valuePredicate` instead. It is recorded rather than left to resurface anonymously because the '
      + 'L5 seed is HEAD-derived: this failed CI at `c62b99d` and passed at the very next commit, which '
      + 'changed no code at all. A finding that only appears at some seeds is exactly what this ratchet '
      + 'is for. TO REPRODUCE without waiting for a seed: run the query with `DEFAULT_FAST_PATHS` and '
      + 'then with `{...DEFAULT_FAST_PATHS, predicateInlining: false}` — one row, then a throw. Toggle '
      + 'ONE AT A TIME; a partial config silently disables every key it omits.',
    family: {
      query: /^g\.V\(\d*\)\.outE\(.*\)\.(outV|inV|otherV)\(\)\.has\('name', ?TextP\.\w+\('[^']*'\)\)\.(where|filter|not)\(__\.(out|in|both)\(.*\)\.range\(/,
    },
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
