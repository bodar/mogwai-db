// Diagnosed host-law divergences — the host-closure law's ratchet (`host-closure.ts`).
//
// Same discipline as `known.ts` and `laws.ts` `knownBroken`: an entry is a WRONG ANSWER WE HAVE NOT
// FIXED, never an acceptable exception. A law that is genuinely invalid in some context is NARROWED in
// `host-closure.ts` instead, with the reference line that narrows it. One entry per ROOT CAUSE, keyed by
// a `family` regex over the queries the law compared, so a generator re-drawing the same cause in a
// different chain does not read as a new finding. Each entry carries a minimal reproduction, which the
// stale-entry test re-runs: a fixed defect fails that test, and deleting the entry is the fix.

export interface KnownHostDivergence {
  readonly id: string;
  /** The law name exactly as `host-closure.ts` names it. */
  readonly law: string;
  /** Matches any of the compared queries (normalised: double quotes → single). */
  readonly family: RegExp;
  /** What is wrong, and where. Required. */
  readonly diagnosis: string;
  /** The smallest pair that still disagrees: the host form, and what the reference says it must equal. */
  readonly repro: { readonly actual: string; readonly expected: string };
}

export const KNOWN_HOST_DIVERGENCES: readonly KnownHostDivergence[] = [
];

/**
 * Diagnosed INTERNAL errors a host form surfaces — a throw that is neither a decline nor a reference
 * error (`test/support/fail-closed.ts`). Same discipline: a defect, one entry per root cause, with the
 * smallest query that still throws it (re-run by the stale-entry test).
 */
export interface KnownHostInternal {
  readonly id: string;
  /** Matches the query. */
  readonly family: RegExp;
  /** Matches the thrown message. */
  readonly message: RegExp;
  readonly diagnosis: string;
  readonly repro: string;
}

export const KNOWN_HOST_INTERNAL: readonly KnownHostInternal[] = [
  {
    id: 'local-leading-path-under-live-path-filter',
    family: /(?:simplePath|cyclicPath)\(\)[\s\S]*\blocal\(/,
    message: /null is not an object \(evaluating 'node\.kind'\)/,
    diagnosis: 'A `local()` body whose `path()` is reached with no movement before it (only filters, or nothing), '
      + 'over a stream whose path channel a `simplePath()`/`cyclicPath()` keeps live, builds a relation holding a '
      + 'NULL expression; `largestExpression` (src/rel/walk.ts:578, via `treeSize`) then dereferences it and a raw '
      + 'TypeError escapes instead of a decline. Without the path filter the same body declines cleanly '
      + '(`g.V().local(__.path())` → UnsupportedTraversal) and with a movement first it runs '
      + '(`g.V().simplePath().local(__.out().path())`), so the null comes from the local() scope reusing the outer '
      + "path channel's empty-movement state. Found by the host-closure law (cc0-host-law).",
    repro: 'g.V().simplePath().local(__.path())',
  },
  {
    id: 'positional-window-in-union-arm-folded-per-traverser',
    family: /\b(?:local|map|flatMap|by)\(/,
    message: /ORDER BY term out of range/,
    diagnosis: 'A positional window (`limit`/`skip`/`range`/`tail`) inside a `union()` arm, folded, under a '
      + 'per-traverser host (`local`/`map`/`flatMap`/`by`): inside the one-row correlated scope the arm\'s '
      + 'encounter is the CONSTANT `0`, and the window renders it as `… ORDER BY 0 ASC LIMIT 1` — a bare '
      + 'integer literal in ORDER BY, which SQLite reads as a result-column ORDINAL and rejects ("1st ORDER '
      + 'BY term out of range") instead of the lowering answering. The same body at the top level runs '
      + '(`g.V().union(__.limit(1)).fold()`), as does the host without the fold '
      + '(`local(__.union(__.limit(1)).count())`). Fix direction: never emit a constant sort key (drop it — a '
      + 'constant orders nothing — or wrap it as an expression). Found by the host-closure law (cc0-host-law).',
    repro: 'g.V().local(__.union(__.limit(1)).fold())',
  },
  {
    id: 'filtered-count-by-over-a-reduced-row',
    family: /\b(?:count|sum|min|max|mean)\(\)\.dedup\(\)\.by\(/,
    message: /misuse of aggregate/,
    diagnosis: 'dedup().by(b) over the ONE row a global reducer produced, where `b` is a FILTER followed by '
      + '`count()` (`__.is(P.gt(0)).count()`, `__.filter(…).count()`), emits a `sum()` aggregate nested in an '
      + 'aggregate context — SQLite refuses "misuse of aggregate: sum()". The same by() under `map`/`order`/'
      + '`project` runs (`g.V().count().map(__.is(P.lt(30)).count())`), as does an unfiltered '
      + '`dedup().by(__.count())` and the same dedup over a NON-reduced stream (`values(\'age\').dedup().by(…)`), '
      + 'so the defect is dedup\'s by-key correlation RE-INLINING the reducer\'s aggregate expression '
      + '(`COALESCE(sum(1), 0)`) into the key subquery\'s WHERE, in the same SELECT that computes it, instead of '
      + 'reading the reduced value as a projected column of a relation — an aggregate inside a nested '
      + 'subquery\'s WHERE is what SQLite refuses (and an expression referenced N times must be computed once '
      + 'anyway, root CLAUDE.md). Found by the host-closure law (cc0-host-law).',
    repro: "g.V().count().dedup().by(__.is(P.gt(0)).count())",
  },
];

/** The id of the diagnosed internal-error entry covering this throw, if any. */
export const knownHostInternal = (query: string, message: string): string | undefined =>
  KNOWN_HOST_INTERNAL.find((k) => k.family.test(norm(query)) && k.message.test(message))?.id;

const norm = (q: string) => q.replace(/"/g, "'");

/** The id of the diagnosed entry covering this law violation, if any. */
export const knownHostDivergence = (law: string, queries: readonly string[]): string | undefined =>
  KNOWN_HOST_DIVERGENCES.find((k) => k.law === law && queries.some((q) => k.family.test(norm(q))))?.id;
