import { type IRStep, MUTATING_STEPS } from './strategies.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { isLocalScope, REDUCERS } from './step.ts';

// ---------- content demand: what a POST-BARRIER tail consumes from the fetched result ----------
//
// A federate/barrier result is landed locally, then the LOCAL TAIL (the steps after the barrier)
// reads it. `detachedTail` (lower.ts) already classifies each such step by what it needs — count()
// needs cardinality only, values(k) needs those keys, out()/inV() need adjacency, id()/label() need
// the element token. That classification is currently INLINE in `detachedTail`'s branch dispatch, and
// it decides HOW to lower. This module lifts the same classification into ONE named fact over the
// WHOLE tail, so it can ALSO decide WHAT to fetch (federate pushdown) — and so the two never drift:
// the fetch decision and the tail's accept/decline become the same function of the same steps
// (`docs/2026-08-26-federate-pushdown-design.md`).
//
// It is DATA, no behaviour — the `ChainFacts` pattern (`analyze.ts`): a static walk over the post-`from`
// steps, one record for the whole tail. Consulted, never constructed (`src/compiler/CLAUDE.md`): a
// reader may DECLINE on it, and the safe default it only NARROWS is "fetch everything" — a wrong demand
// must degrade to over-fetching, never to a wrong answer. This phase computes it and routes the decline
// check through it (behaviour-preserving); later phases let it shape the fetch.

/** The movement/endpoint steps that need ADJACENCY (the landed edges) to lower — the keys of `HOPS`
 *  (`lower/movement.ts`). Kept as a NAME set here (this module is an ir-layer leaf and must not import
 *  the rel lowering), asserted equal to `HOPS`'s keys by a test so the two cannot drift. */
export const ADJACENCY_STEPS: ReadonlySet<string> = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'inV', 'outV', 'bothV',
]);

/** What the local tail after a barrier consumes from the fetched result. Every field DEFAULTS to the
 *  conservative "needs everything" so an unrecognized tail over-fetches rather than under-fetches. */
export interface ContentDemand {
  /** Does any step read an element's DATA (a property/label/token/payload)? `false` for a tail that
   *  only counts or dedups by identity — those need no element payload fetched. */
  readonly reachesElements: boolean;
  /** Does any movement/endpoint step run? → the landed EDGES (adjacency) are needed. */
  readonly reachesAdjacency: boolean;
  /** The property keys the tail reads (`values(k…)`/`has(k,…)`/`by(k)`), or `'all'` when a whole-payload
   *  read is present (`valueMap`/`elementMap`/an element-terminal leaf/`properties`) or a key is not a
   *  compile-time literal. `'all'` is the conservative default; a bare key set is what projection
   *  pushdown may narrow the fetch to. */
  readonly keys: ReadonlySet<string> | 'all';
  /** Does the tail END in a bare reducer (`count`/`sum`/… global, no arg)? Then the reduction itself may
   *  push to the sibling and only a scalar need cross. */
  readonly terminalReduction: boolean;
  /** A step the tail may NOT hand off to the main fold over a bound graph — a WRITE (out of scope: a
   *  detached snapshot is immutable) or an element-bag read not yet routed through `GraphSource`
   *  (`propertyMap`). Present here so the ONE classifier owns the decline set `detachedTail` reads. */
  readonly handoffDenied: boolean;
}

/** Steps a bound element stream may NOT hand off to the main fold — writes (out of scope) and the
 *  element-bag/property reads that scan base tables by a foreign id (a wrong answer until routed). This
 *  is the set `detachedTail` fails closed on; it lives HERE so the demand fact owns it. */
export const BOUND_HANDOFF_DENY: ReadonlySet<string> = new Set<string>([
  ...MUTATING_STEPS, 'propertyMap',
]);

/** Whole-payload reads — a step that needs EVERY key/label of an element, so projection can narrow the
 *  fetch to nothing (`keys = 'all'`). `valueMap`/`elementMap` read all keys; `properties` streams them;
 *  a terminal element (no consuming step) frames the whole payload on the wire. */
const WHOLE_PAYLOAD_READS: ReadonlySet<string> = new Set(['valueMap', 'elementMap', 'properties', 'propertyMap']);

/** The keys a single key-reading step names as compile-time literals, or `null` if it reads a key that
 *  is not a literal (a bound param / computed) — which forces `'all'` (we cannot narrow to an unknown
 *  key). `has(k, …)` reads its FIRST arg as the key; `values(k…)` reads all args as keys. */
const literalKeysOf = (step: IRStep): readonly string[] | null => {
  const vals = argValues(step);
  if (step.name === 'values') {
    const keys = vals.filter((k): k is string => typeof k === 'string');
    return keys.length === vals.length ? keys : null; // a non-literal key → cannot narrow
  }
  if (step.name === 'has' || step.name === 'hasNot') {
    const first = vals[0];
    return typeof first === 'string' ? [first] : null;
  }
  return [];
};

/** Compute the content demand of a tail — the steps of `steps` from index `from` onward. A pure walk;
 *  the conservative default (`reachesElements`, `keys: 'all'`) holds until a step proves it can be
 *  narrower, so an unrecognized tail always over-fetches. */
export function contentDemand(steps: readonly IRStep[], from: number): ContentDemand {
  const tail = steps.slice(from);
  let reachesElements = false;
  let reachesAdjacency = false;
  let keysAll = false;
  const keys = new Set<string>();
  let handoffDenied = false;

  for (const step of tail) {
    if (BOUND_HANDOFF_DENY.has(step.name)) handoffDenied = true;
    if (ADJACENCY_STEPS.has(step.name)) { reachesAdjacency = true; reachesElements = true; }
    if (WHOLE_PAYLOAD_READS.has(step.name)) { reachesElements = true; keysAll = true; }
    // Key readers (values/has) contribute keys; a non-literal key widens to 'all'.
    if (step.name === 'values' || step.name === 'has' || step.name === 'hasNot') {
      reachesElements = true;
      const named = literalKeysOf(step);
      if (named === null) keysAll = true; else for (const k of named) keys.add(k);
    }
    // id()/label()/hasLabel()/hasId() read a token, not a property key — an element read, no key.
    if (step.name === 'id' || step.name === 'label' || step.name === 'hasLabel' || step.name === 'hasId') {
      reachesElements = true;
    }
  }

  // A tail that is PURELY count()/dedup() (identity only) reads no element data. If nothing above set
  // `reachesElements`, the tail needs only cardinality/identity — no payload fetch. A bare reducer /
  // dedup does not set it, so this is exactly the "count/dedup only" case.

  const last = tail[tail.length - 1];
  const terminalReduction = !!last && REDUCERS.has(last.name) && argValues(last).length === 0 && !isLocalScope(last);

  return {
    reachesElements,
    reachesAdjacency,
    keys: keysAll ? 'all' : keys,
    terminalReduction,
    handoffDenied,
  };
}
