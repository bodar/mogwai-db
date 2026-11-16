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
    id: 'seed-twice-in-decorrelated-exists',
    family: /(?:where|filter|not)\(__\.union\(__\.identity\(\), __\.identity\(\)\)\)/,
    message: /names two different relations in one scope/,
    diagnosis: 'Pre-existing on trunk (bb433d7f), drawn by the HEAD-derived exploration seed. An existence host '
      + '(where/filter/not) whose body is union(identity(), identity()) over a SCALAR stream, nested in a DECORRELATED '
      + 'connector body (map, order().by, …): the union arms ARE the seed row (`seedRow`, lower/scoped.ts), so the '
      + "EXISTS subquery holds the seed relation itself; most likely (unconfirmed) `decorrelate` (src/rel/decorrelate.ts) rebuilds the seed's "
      + 'project keyed under the SAME id and re-points column reads, but not the relation object inside the subquery — '
      + 'so one id names the old and the keyed seed. Over an element stream the body lowers as a seek and never meets it. '
      + 'Fix in decorrelate: rewrite a subquery plan held in an expression through the same memoized `go`.',
    repro: 'g.inject(1).map(__.where(__.union(__.identity(), __.identity())))',
  },
];

/** The id of the diagnosed internal-error entry covering this throw, if any. */
export const knownHostInternal = (query: string, message: string): string | undefined =>
  KNOWN_HOST_INTERNAL.find((k) => k.family.test(norm(query)) && k.message.test(message))?.id;

const norm = (q: string) => q.replace(/"/g, "'");

/** The id of the diagnosed entry covering this law violation, if any. */
export const knownHostDivergence = (law: string, queries: readonly string[]): string | undefined =>
  KNOWN_HOST_DIVERGENCES.find((k) => k.law === law && queries.some((q) => k.family.test(norm(q))))?.id;
