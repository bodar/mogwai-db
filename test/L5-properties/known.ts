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
// semantic authority, so a difference is always a defect in the optimized lowering (or, as in the
// first entry, in a layer beneath both). Emptying this list is the goal.
//
// ONE ENTRY PER ROOT CAUSE, NOT PER TRAVERSAL. L5's first sweep (3,000 generated traversals + the
// 2,298-traversal corpus) produced 22 divergent traversals in 17 distinct step-signature groups —
// which all reduce to the three causes below, every one of them attributed to `predicateInlining`.
// Recording signatures instead of causes would have written 17 near-identical entries and buried the
// fact that two lines of one file explain most of them.

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
    // The MINIMAL reproduction, deliberately not the corpus traversal that first surfaced this. See
    // the "two wrongs" paragraph in the diagnosis: on the corpus traversal the fast path is
    // accidentally CORRECT, which makes it a badly misleading thing to write a fix against.
    query: "g.V().filter(__.has('software','name','lop'))",
    fastPath: 'predicateInlining',
    diagnosis:
      'SILENT WRONG ANSWER, on a form the support matrix marks ✅ ("works anywhere in a traversal, ' +
      'however deeply nested"). The inline has() leaf destructures only two args — ' +
      '`const [key, val] = body[0].args` (src/compiler/steps/prefix/predicate.ts:252) — so the 3-arg ' +
      'has(LABEL, key, value) form is read as has(key="software", value="name"): "the property named ' +
      "'software' equals 'name'\", which is never true. The arm therefore evaluates to constant FALSE. " +
      'Minimal reproductions, all silently wrong and none of them a deferral: ' +
      'V().filter(__.has("software","name","lop")) → [] (correct: [3]); ' +
      'V().where(__.has("software","name","lop")) → [] (correct: [3]); ' +
      'V().not(__.has("software","name","lop")) → all 6 vertices (correct: 5 — vertex 3 must be ' +
      'excluded, and an always-false arm under not() becomes always-TRUE); ' +
      'V().or(__.hasLabel("person"),__.has("software","name","lop")) → 4 (correct: 5). ' +
      'None of these involves order()/by(), so the defect is isolated to the inline leaf. Outside a ' +
      'predicate body the same has() is correct (filter.ts handles all three arities). ' +
      'TWO WRONGS MAKE A RIGHT — why L3 never caught this. The traversal that first surfaced it, ' +
      'g.V().or(hasLabel("person"),has("software","name","lop")).order().by("age"), is the one ' +
      'presentation where this bug is INVISIBLE: TinkerPop expects 4 rows there (Order.feature — ' +
      'a non-productive by("age") drops the software vertex, which has no age), and the fast path ' +
      'returns 4 by dropping lop for the WRONG reason, at the or() instead of at the order(). The ' +
      'generic path admits lop correctly and then fails to drop it, returning 5. So on that scenario ' +
      'this defect exactly cancels a SECOND, unrelated one (non-productive drop is not applied at ' +
      'order().by(key) — see docs/outstanding-work.md), and the scenario sits in l3-state.json\'s ' +
      'passed[] list. Its @WithProductiveByStrategy twin, where the two do not cancel, is in ' +
      'failed[] and tolerated under the ratchet floor. Do not use that traversal to validate a fix; ' +
      'use the three minimal forms above. ' +
      'FIX (~4 lines): in that leaf, when body[0].args.length === 3, render labelIn(ctx.labelIdExpr, ' +
      '[args[0]]) AND hasProp(ctx, args[1], args[2]) — the conjunction filter.ts already means. ' +
      'Declining (decline(...) → fall through to the generic gate) is the smaller fail-closed ' +
      'alternative, but handling it keeps the fast path applicable. Fixing this ALONE will turn the ' +
      'passing L3 scenario red until the by() half is fixed too — expect that, and fix both.',
    // A `has()` with three literal args, which is the 3-arg form wherever it appears. Keeps the
    // corpus traversal covered (it does carry this defect, cancellation notwithstanding) without
    // pinning the entry to it.
    family: { query: /has\((?:'[^']*'|"[^"]*")\s*,\s*(?:'[^']*'|"[^"]*")\s*,\s*(?:'[^']*'|"[^"]*")\)/ },
  },
  {
    query: "g.V(2).not(__.valueMap().count())",
    fastPath: 'predicateInlining',
    diagnosis:
      'SUPPORT ASYMMETRY — fails closed, so no wrong answer, but it inverts the fast-path contract. ' +
      'This is the big one by volume: 16 of the 17 signatures in the first sweep, all reporting the ' +
      'same message, "<host>() traversal not supported by inline predicate or generic child existence ' +
      'lowering". With predicateInlining ON these traversals run and are correct; with it OFF they are ' +
      'REJECTED, because NEITHER the inline recognizer nor the generic child-existence gate can lower ' +
      'the body. So a whole class of predicate bodies is reachable ONLY through the fast path, while ' +
      'FastPathConfig documents the generic path as the semantic authority and the fast path as a ' +
      'strictly optional accelerator. Equivalently: predicateInlining is not disable-safe. ' +
      'The affected bodies are the ones ending in a reducer or a projection rather than a plain ' +
      'existence test — valueMap().count(), path().count(local), dedup().count(), values(k).sum(), ' +
      'project(a,b)….count(), group()/groupCount().by(k).count() — plus some multi-hop movement ' +
      'bodies (not(__.in("created").limit(1).outE().outV())). Hosts: where/filter/not/and/or/local. ' +
      'Same class, found while diagnosing: V().or(__.has("software","name","lop")) — a single-arm ' +
      'or() — throws "or() needs at least two traversal branches" with fast paths ON but runs under ' +
      'the generic path; the asymmetry points the other way there. ' +
      'FIX: decide which side is wrong before writing code. Either the generic child-existence gate ' +
      'should accept a reducer/projection-terminal body (it is the authority, so this is the ' +
      'contract-honouring answer), or these bodies are genuinely beyond it and the inline recognizer ' +
      'is over-reaching. Note this is INVISIBLE in production — the default config has every fast ' +
      'path on — which is exactly why nothing caught it before: no test ran the generic path.',
    // Keyed on the failure MODE, not on guessed query shapes: this message is emitted at one place
    // and means exactly this defect.
    family: { detail: /not supported by inline predicate or generic child existence lowering/ },
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
