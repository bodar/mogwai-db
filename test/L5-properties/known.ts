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
// ****  EMPTY IS THE INTENDED STATE. THE LIST IS NOT EMPTY — see the entries below.  ****
//
// (This line claimed emptiness while an entry already sat below it; a header that describes a state
// the file has left is worse than no header, because it is read as a summary. Two entries today:
// `repeatBodyExpansion`, an under-determined emission ORDER neither route owns, and `propertySeek`,
// a slice dropped by the generic fallback — the second is a real defect awaiting a fix, not a
// tolerated difference.)
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
  {
    query: "g.V().has('age', P.gt(0)).where(__.outE()).skip(1)",
    fastPath: 'propertySeek',
    diagnosis:
      'A NEWLY-REACHED DEFECT, not a regression: the generic fallback DROPS A FOLLOWING SLICE when a '
      + 'property `has()` is followed by a `where()`/`filter()` child body. Measured on the modern '
      + "graph, `g.V().has('age',P.gt(0)).where(__.outE()).skip(1)` is [4,6] — age>0 gives "
      + '{marko,vadas,josh,peter}, the child keeps those with out-edges {1,4,6}, skip(1) drops the '
      + 'first — and that is what the DEFAULT config answers on both spines. With propertySeek alone '
      + 'disabled it answers [1,4,6]: the skip is gone, not merely reordered. '
      + 'ATTRIBUTION IS EXACT, not inferred — every one of the other seven switches was toggled off '
      + 'individually against the same traversal and all seven still answer [4,6]. '
      + '`g.V().has(...).filter(__.outE("created")).skip(2)` is the same cause with a different arity '
      + '([6] correct, [4,6] with the switch off), which is why this is ONE entry and not two. '
      + 'SEVERITY: production is CORRECT, because the switch defaults on — this is the disable path, '
      + 'exactly the class this oracle exists for (the header above records four switches that '
      + 'shipped before L5 and whose generic path had never been executed). It is still a defect in '
      + "the optimized lowering's contract, since `FastPathConfig` promises the generic path is "
      + 'result-equivalent AND the semantic authority; here the accelerated path is the correct one, '
      + 'which inverts that and means the authority cannot be trusted to arbitrate. '
      + 'NOT YET DIAGNOSED TO A LINE: what remains is why the non-seek `has` lowering loses a '
      + 'following slice. Recorded rather than fixed because the fix is an unrelated read-path '
      + 'investigation and the finding surfaced mid-way through Phase 1 write work; the L5 seed is '
      + 'HEAD-derived, so this WILL resurface, and the point of the entry is that it resurfaces named. '
      + 'TO REPRODUCE, without waiting for a seed to land on it again: run the traversal directly '
      + 'against the modern graph with `DEFAULT_FAST_PATHS` and then with `{...DEFAULT_FAST_PATHS, '
      + 'propertySeek: false}` — the answers are [4,6] and [1,4,6]. Toggle the switches ONE AT A TIME '
      + 'rather than passing a partial config: a partial object silently disables every key it omits, '
      + 'which is how this was first mis-attributed to the generic path in general. The seed that '
      + 'surfaced it was `L5_SEED=4264137` (`bun test test/L5-properties/differential.test.ts`), kept '
      + 'because a seed that is known to hit a defect is worth more than one that merely might.',
    family: { query: /^g\.V\(\)\.has\('age', ?P\.(gt|gte)\(\d+\)\)\.(where|filter)\(__\.outE\(.*\)\)\.skip\(/ },
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
