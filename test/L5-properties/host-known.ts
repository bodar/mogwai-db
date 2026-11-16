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
];

/** The id of the diagnosed internal-error entry covering this throw, if any. */
export const knownHostInternal = (query: string, message: string): string | undefined =>
  KNOWN_HOST_INTERNAL.find((k) => k.family.test(norm(query)) && k.message.test(message))?.id;

const norm = (q: string) => q.replace(/"/g, "'");

/** The id of the diagnosed entry covering this law violation, if any. */
export const knownHostDivergence = (law: string, queries: readonly string[]): string | undefined =>
  KNOWN_HOST_DIVERGENCES.find((k) => k.law === law && queries.some((q) => k.family.test(norm(q))))?.id;
