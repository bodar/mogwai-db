import { type IRStep, MUTATING_STEPS } from './strategies.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { isLocalScope, REDUCERS } from './step.ts';
import { labelReads, labelsBoundBefore } from './labels.ts';

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
  /** Does the tail need the landed ENDPOINT VERTICES — via a movement/endpoint hop (`out`/`inV`/…) OR a
   *  `.V()` re-source (`sg.traversal().V()`, which re-roots at the fetched vertices)? This is the bit a
   *  subgraph federate reads to decide whether the second endpoint hop pays off: `false` for an edges-only
   *  or reducing tail (`…count()`, `.E()…`), so the endpoint fetch is skipped. A `.E()` re-source needs
   *  only the edges (always fetched), so it does NOT set this. */
  readonly reachesAdjacency: boolean;
  /** The property keys the tail reads (`values(k…)`/`has(k,…)`/`by(k)`), or `'all'` when a whole-payload
   *  read is present (`valueMap`/`elementMap`/an element-terminal leaf/`properties`) or a key is not a
   *  compile-time literal. `'all'` is the conservative default; a bare key set is what projection
   *  pushdown may narrow the fetch to. */
  readonly keys: ReadonlySet<string> | 'all';
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
    // A `.V()` re-source re-roots at the landed VERTICES (`sg.traversal().V()`), so it needs the endpoint
    // fetch exactly as a movement does — even a `…V().count()` reads the vertex relation. `.E()` re-roots
    // at the edges (always fetched), so it does not. Only a re-source is `V`/`E` in a subgraph tail — a
    // leading `V()`/`E()` at index 0 is the source itself, never in a tail slice.
    if (step.name === 'V') { reachesAdjacency = true; reachesElements = true; }
    // `elementMap()` over an EDGE stream emits IN/OUT endpoint entries that REJOIN the landed vertices, so
    // it needs the endpoint fetch. We do not track the stream elem here, so `elementMap` conservatively
    // reaches adjacency — an over-fetch for a vertex `elementMap` (where the "endpoints" are the vertices
    // themselves, so it costs nothing), never an under-fetch (the wrong-answer direction).
    if (step.name === 'elementMap') { reachesAdjacency = true; reachesElements = true; }
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

  return {
    reachesElements,
    reachesAdjacency,
    keys: keysAll ? 'all' : keys,
    handoffDenied,
  };
}

// ---------- pushdown: split the post-barrier tail into a REMOTE prefix and a LOCAL suffix ----------
//
// For the ARG-LESS federate form (`g.call(federate, {graph}).V()…` — no `traversal` arg,
// win 2a in `docs/2026-08-26-federate-pushdown-design.md`), the whole tail after the barrier is a
// CANDIDATE to run on the sibling. Pushdown finds the longest PREFIX of the tail that is remote-safe and
// hands it to the sibling; the rest stays local. This is Calcite's convention/boundary model
// (`vendor/calcite`), specialized: because the sibling runs the SAME engine, pushing is always cheaper
// and almost every step pushes, so the "maximal cut" is a simple prefix walk — no cost-based planner.
//
// A step ENDS the pushable prefix (is LOCAL-DEPENDENT) when it needs LOCAL state the sibling never had.
// Optimistic blocklist — push unless proven local:
//   1. it READS a label bound BEFORE the barrier — a backtrack across the boundary
//      (`as('x') … call(federate) … where(eq('x'))`). A backtrack CONTAINED in the prefix pushes fine
//      (the sibling binds and reads its own `as('a')`), which falls out because `labelsBoundBefore` at the
//      barrier position is barrier-CLEARED, so it holds only the PRE-barrier binds.
//   2. it is a WRITE (`MUTATING_STEPS`) — a detached snapshot is immutable; a write lands nothing.
//   3. it is a nested/second barrier `call()` — its own boundary; treat conservatively as local.
//   4. `labelReads(...).all` — a `path()`-family or unparseable body that observes EVERY label.

/** The reducing steps whose presence as the LAST pushed step means the sibling returns a SCALAR (so the
 *  resume frames a value, not elements). `REDUCERS` = count + the numeric reducers. */
const isBareReducer = (s: IRStep): boolean =>
  REDUCERS.has(s.name) && argValues(s).length === 0 && !isLocalScope(s);

export interface PushablePrefix {
  /** How many tail steps (from `barrier.at + 1`) run on the SIBLING. 0 = nothing pushes. */
  readonly length: number;
  /** Does the pushed prefix END in a bare reducer? Then the sibling returns a SCALAR. */
  readonly reduces: boolean;
}

/** The longest remote-safe prefix of the tail `steps.slice(barrier + 1)`. `params` resolves label reads
 *  faithfully (`labels.ts`). A step that is local-dependent (see above) and everything after it stays
 *  local. Pure `Step[]` reasoning — the correct layer for a plan-time boundary (`src/compiler/CLAUDE.md`). */
export function pushableTailPrefix(steps: readonly IRStep[], barrier: number, params: Record<string, any>): PushablePrefix {
  const from = barrier + 1;
  // Labels bound before the barrier — a prefix step reading one of these backtracks ACROSS the boundary
  // and cannot push. `labelsBoundBefore` clears at the barrier, so this is exactly the pre-barrier set.
  const preBarrier = labelsBoundBefore(steps, from, params);
  let length = 0;
  for (let i = from; i < steps.length; i++) {
    const step = steps[i]!;
    if (MUTATING_STEPS.has(step.name)) break;      // (2) writes stay local
    if (step.name === 'call') break;               // (3) a nested/second barrier — conservative boundary
    const reads = labelReads([step], params);
    if (reads.all) break;                          // (4) path-family / unparseable — observes all labels
    if (preBarrier.size && [...reads.labels].some((l) => preBarrier.has(l))) break; // (1) cross-boundary backtrack
    length++;
  }
  const last = length > 0 ? steps[from + length - 1]! : undefined;
  return { length, reduces: !!last && isBareReducer(last) };
}
