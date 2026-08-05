import { type IRStep } from './strategies.ts';
import { isTokenArg, argValues } from '../../gremlin/frontend.ts';
import { isLocalScope, PATH_FAMILY, REDUCERS, VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, unionOf } from './step.ts';

// ---------- whole-chain analysis: annotate, never rewrite ----------
//
// The chain-global properties the lowering Engine needs to know BEFORE it starts folding
// steps: does the chain track a path? does it need a threaded emission-order encounter? is
// movement-collapse result-safe here? Each was previously a separate re-walk of `steps`
// scattered across engine.ts + strategies.ts; two of them re-scanned the SAME array (the
// `demandsEncounterOrder` double-call), and two shared an order()-neutralizes-fanout
// predicate that had to be kept in sync by a prose comment. `analyzeChain(steps)` computes all
// three in one place, with the shared predicate (`isPlainOrder`) defined ONCE so the two
// scans that consume it cannot drift.
//
// This is DATA, no behavior — an immutable record, like FastPathConfig (and unlike the
// LoweringEngine class, which has injected deps + behavior). It is NOT a Pass (it never
// rewrites the chain) and NOT per-step (each field is one value for the whole chain, read
// at one seeding site). `chainNeedsFromV`/`trackFromV` is deliberately NOT here — it is a
// PER-SCOPE derivation (re-computed at lowerElementSteps over each child scope's own,
// narrower step slice) and lives on `carried`, not on a chain-level record.

/** Whole-chain properties derived once, before lowering. Read-only DATA (no methods); the
 *  Engine consults it instead of re-scanning. */
export interface ChainFacts {
  /** was chainTracksPath        → seedSource: add the p0 path column? */
  readonly tracksPath: boolean;
  /** was demandsEncounterOrder  → seedSource: seed + thread the emission-order encounter? */
  readonly demandsEncounter: boolean;
  /** was chainCollapseSafe      → gate the movementCollapse fast path for this chain */
  readonly collapseSafe: boolean;
}

/** Steps that need the linear path threaded through the fold: the source vertex becomes path
 *  position p0 and every hop appends a position. */
const PATH_STEPS = PATH_FAMILY;

/** A bare/keyed `order()` (no by(traversal)) re-establishes a deterministic total order. It
 *  is THE shared hinge of the two scans below: such an order() both clears "needs an emission
 *  encounter" (a following slice sorts deterministically without one) AND is exactly the
 *  order() after which movementCollapse's post-order limit/range/skip stay result-safe. Both
 *  scans call this one predicate so they cannot disagree on what an order() does — the drift
 *  risk the old two-file prose "must agree" comment carried. order().by(traversal) is NOT
 *  plain (it mints its own encounter / is a nested sort) and returns false. */
function isPlainOrder(step: IRStep): boolean {
  return step.name === 'order' && (step.modulators ?? []).every((by: any[]) => by.length === 0 || typeof by[0] === 'string');
}

// ---------- demandsEncounter (moved verbatim from strategies.ts demandsEncounterOrder) ----------
//
// A traversal needs a threaded emission-order `encounter` ONLY when it contains a positional
// consumer (limit/range/skip/tail/root-fold) DOWNSTREAM of a fan-out — those pick/order a
// deterministic subset. Order-free chains (reducers, existence gates, bare dedup) never seed
// it, so the hot path (index-only movement, movementCollapse) stays untouched. This is the
// COARSE chain-level flag: seed once at the source, and from there each site keys on the
// carried encounter's presence (like trackPath → carried.path), never re-scanning.

/** Steps that fan a traverser out to >1 result per input (so a following slice is
 *  order-sensitive). `values` is conservative — a property MAY be multi-valued. */
const FANOUT_STEPS = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV', 'otherV',
  'values', 'union', 'choose', 'coalesce', 'optional', 'local', 'flatMap',
]);
/** SLICE consumers: their result depends on emission order once a fan-out precedes, and an
 *  upstream `order()` satisfies them because `LIMIT` reads the ordered relation in the same query.
 *  `fold` is deliberately NOT here — it is a collection, and both of those clauses are false for
 *  one (see `COLLECTING_CONSUMERS`). Listing it in both would be two answers to one question. */
const POSITIONAL_CONSUMERS = new Set(['limit', 'range', 'skip', 'tail']);
/** The COLLECTING consumers — they fold N traversers into one whose members are the N, so member
 *  order is part of the answer rather than a property of how the rows arrived. Two consequences
 *  the slice steps above do not share: an upstream `order()` does not satisfy them (they read
 *  across a relation boundary, where SQL drops a subquery's ORDER BY), and neither does the
 *  absence of a fan-out (a bare `g.V().fold()` observes the source's order just as much).
 *  A `group()` value list is itself a fold, so it has the same property. Specifically,
 *  `GroupStep` extends `ReducingBarrierStep` and consumes starts one at a time rather than
 *  parking them in a coalescing TraverserSet: its members therefore keep arrival order,
 *  including separated duplicates. `groupCount` is deliberately absent — its value is a
 *  count in a HashMap, not an ordered member collection. See the pinned reference at
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java`.
 *
 *  `cap` is here as well as `aggregate`, and that is not redundancy: this scan is FLAT, so an
 *  `aggregate` written inside a child body — `g.V().local(aggregate('a')).cap('a')`, the whole
 *  Scope.local family — is invisible to it. `cap` is the step that makes a collection's member
 *  order observable and it is always at the top level, so it is the one that cannot be missed. */
const COLLECTING_CONSUMERS = new Set(['fold', 'aggregate', 'cap', 'group']);
/** The WRITE steps, which are order-sensitive for a reason none of the read consumers share: a
 *  write ASSIGNS ids, in the order it consumes its driver rows, and those ids are observable —
 *  `g.V().as("a").in("created").addE("createdBy").from("a")` creates the same four edges under a
 *  reversed scan and numbers them backwards. Reproducible ids are also something users notice.
 *
 *  This is the same argument COLLECTING_CONSUMERS makes, one step further: there, member order is
 *  part of the answer; here, id assignment is. Measured with `mise run test:perturbed` — three
 *  corpus traversals, all writes, all id-order-only (the graphs were identical). */
const WRITE_STEPS = new Set(['addV', 'addE', 'mergeV', 'mergeE', 'property', 'drop']);

/** Can an encounter be threaded through this PREFIX at all? `repeat()`/`match()` are opaque
 *  boundaries the substrate does not cross — `computeDemandsEncounter` returns false at one for
 *  exactly that reason, and a caller that demands one anyway gets a layout declaring a column the
 *  body never produces ("table c2 has 2 values for 3 columns").
 *
 *  Exported because the WRITE path's demand does not come from its own steps: `buildPrefixFresh` is
 *  handed the prefix with the write step already sliced off, so it cannot ask `analyzeChain` and has
 *  to ask this instead. Same rule, different question — "is one needed" vs "is one possible". */
export const canCarryEncounter = (steps: readonly IRStep[]): boolean =>
  !steps.some((s) => s.name === 'repeat' || s.name === 'match');

/** Does this chain need a threaded emission-order encounter? True iff a positional consumer
 *  appears after a fan-out. repeat()/match() are opaque boundaries this substrate doesn't
 *  cross yet — return false there (preserving today's behaviour, never a silent mis-order). */
function computeDemandsEncounter(steps: IRStep[]): boolean {
  let sawFanout = false;
  // A keyed/bare order() has already put the rows in a deterministic total order, so a slice after
  // it reads that order inside the SAME query and needs no emission encounter. Tracked separately
  // from `sawFanout` because the two answer different questions: this one is "is the order already
  // established", and a slice needs an encounter whenever it is NOT — fan-out or no fan-out.
  let ordered = false;
  for (const s of steps) {
    if (s.name === 'repeat' || s.name === 'match') return false;
    // (Clearing `sawFanout` too keeps the dedup(labels) rule below reading as it always has: the
    // same predicate collapseSafe's sawOrder gate uses, so the two agree and movementCollapse stays
    // enabled for <movement>.order().by(key).limit().)
    if (isPlainOrder(s)) { sawFanout = false; ordered = true; continue; }
    // …but that reasoning is about a SLICE, and it does not extend to a COLLECTION. `LIMIT` reads
    // the ordered relation inside the SAME query, so the ORDER BY genuinely satisfies it. A
    // fold/aggregate reads its rows across a relation boundary, and SQL does not carry a
    // subquery's ORDER BY over one — `json_group_array` takes whatever scan order SQLite picks. So
    // a collection needs a column to order BY *inside* the aggregate whatever established the
    // order, and it needs one even with no fan-out at all: `g.V().fold()` observes the source's
    // order exactly as much as `g.V().out().fold()` does.
    // Measured with `mise run test:perturbed`: 41 corpus traversals and 13 L3 scenarios changed
    // their answer under a reversed scan. Do NOT "simplify" this into the fan-out branch below —
    // that is the shape that was wrong.
    if (COLLECTING_CONSUMERS.has(s.name)) return true;
    // A write consumes its driver rows one at a time and assigns ids as it goes — see WRITE_STEPS.
    // Like a collection and unlike a slice, it needs the encounter with no fan-out at all: a bare
    // `g.V().addE(…)` observes the source's order exactly as much as `g.V().out().addE(…)` does.
    if (WRITE_STEPS.has(s.name)) return true;
    // EVERY row slice needs a column to slice BY, whether or not a fan-out preceded it — this rule
    // used to require one, and `tail` was carved out of it as "the one slice that needs the
    // encounter with no fan-out at all". That carve-out had the right reasoning and the wrong
    // scope. `limit(n)` over an unconstrained relation is "some n", and SQLite's forward scan
    // quietly makes that the source's first n — an ACCIDENT, not an implementation, and reversing
    // the scan takes a different subset: `g.V().limit(2)`, `project(…).limit(2)` and
    // `valueMap(…).limit(2)` all changed their answer under `mise run test:perturbed`. A wrong
    // SUBSET, not a reorder. `tail` merely had no accident available to hide behind, reading from
    // the far end.
    //
    // The cost is a carried column on chains that had none, and it is small by construction: a
    // chain with no fan-out is source + filters + a projection, where the source seeds
    // `encounter = id` and SQLite reads that in rowid order. `movementCollapse` is untouched
    // because a movement IS a fan-out, so those chains were already demanding.
    //
    // `Scope.local` is exempt throughout: that form slices a VALUE's members, not the stream's rows.
    if (!ordered && POSITIONAL_CONSUMERS.has(s.name) && !isLocalScope(s)) return true;
    // dedup(labels) keeps the FIRST traverser per key — first-in-emission, so it needs the
    // encounter. Bare dedup() collapses a multiset regardless of order (never triggers).
    if (sawFanout && s.name === 'dedup' && argValues(s).some((a) => typeof a === 'string')) return true;
    if (FANOUT_STEPS.has(s.name)) { sawFanout = true; ordered = false; }
  }
  return false;
}

// ---------- collapseSafe (moved verbatim from engine.ts chainCollapseSafe) ----------
//
// Convergent-walk collapse (SELECT id, SUM(bulk) GROUP BY id at each movement) is
// result-equivalent ONLY when the whole chain is a linear movement/filter prefix ending in a
// global bulk-aware reducer: nothing carries per-traverser identity (path/as/sack), nothing
// is bulk-unaware on rows (order/limit/range/sample), and no branch/barrier/re-entry sits
// between the collapse and the reducer's SUM(bulk). Anything outside these sets → not safe →
// the plain UNION-ALL movement (identical result, unbounded rows). otherV is deliberately
// excluded (its fromV context is per-traverser identity).
// NOTE the absent OTHER_V: otherV carries fromV (per-traverser identity), which a
// GROUP BY-id collapse would destroy. Excluded deliberately, and now visibly so.
export const COLLAPSE_MOVES = unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES);
const COLLAPSE_FILTERS = new Set(['has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or']);
const COLLAPSE_PROJ = new Set(['values', 'id', 'label']); // a scalar projection feeding a numeric reducer
const COLLAPSE_REDUCERS = REDUCERS;

/** A `groupCount()` terminal whose key does NOT fan out is a bulk-mergeable barrier: it
 *  weights every group by SUM(bulk) (see lowerGroup's isCount), so collapsing convergent
 *  walks into (element, N) before it is result-equivalent — the exact "groupCount after a
 *  big fan-out/repeat" correctness+tractability case. A bare key (the element identity), a
 *  property key `by('name')`, or a token key `by(T.label)` all follow the element's identity,
 *  so merging same-id rows keeps every key intact. A by(traversal) key can fan out (one
 *  traverser → many keys), which a GROUP BY-id merge would corrupt → left unsafe. group()
 *  (element/list values) and group().by().by(reducer) are NOT admitted here: their weighting
 *  is correct-by-construction but their collapse gating is deferred (see the wire-bulking doc). */
function groupCountCollapseTerminal(step: IRStep): boolean {
  if (step.name !== 'groupCount' || (step.args?.length ?? 0) !== 0) return false;
  const modulators = step.modulators ?? [];
  if (modulators.length === 0) return true;
  if (modulators.length !== 1) return false;
  const a = modulators[0]?.[0];
  return a === undefined || typeof a === 'string' || isTokenArg(a);
}

function computeCollapseSafe(steps: IRStep[]): boolean {
  const n = steps.length;
  if (n < 2) return false; // need a source + ≥1 movement
  if (steps[0].name !== 'V' && steps[0].name !== 'E') return false;
  // Three safe terminals: a GLOBAL reducer (count/sum/mean/min/max — its SUM(bulk) sums the
  // multiplicities), optionally after one scalar projection; a non-fan-out `groupCount()`
  // (SUM(bulk) per key); OR an ELEMENT leaf (the bare vertex/edge projection, which frames each
  // element as (v, bulk) on the wire). Everything between the source and the terminal must be
  // movement/filter — anything that carries per-traverser identity (path/as/sack) or reads rows
  // bulk-unaware (order/limit/range/sample/dedup/branch/re-entry) makes a GROUP BY-id merge wrong.
  let end = n; // exclusive bound of the movement/filter prefix
  const last = steps[n - 1];
  const reducerTerminal = COLLAPSE_REDUCERS.has(last.name) && (last.args?.length ?? 0) === 0;
  const groupCountTerminal = groupCountCollapseTerminal(last);
  if (reducerTerminal || groupCountTerminal) {
    end = n - 1;
    if (reducerTerminal && end >= 2 && COLLAPSE_PROJ.has(steps[end - 1].name)) end -= 1; // one scalar projection before the reducer
  }
  let sawMove = false, sawOrder = false;
  for (let i = 1; i < end; i++) {
    const nm = steps[i].name;
    if (COLLAPSE_MOVES.has(nm)) { sawMove = true; continue; }
    if (COLLAPSE_FILTERS.has(nm)) continue;
    // A bare dedup() BEFORE any order() is a prefix step that resets bulk to 1 (one traverser per
    // distinct id), so a GROUP BY-id merge around it is correct. After an order() it is instead a
    // tail ordered-dedup (first-per-key), which does not compose with a collapsed bulk stream →
    // unsafe. dedup(label)/dedup().by() carry extra semantics → unsafe.
    if (nm === 'dedup' && !sawOrder && (steps[i].modulators?.length ?? 0) === 0 && (steps[i].args?.length ?? 0) === 0) continue;
    // Element-terminal only: order() by a property key (or bare) just sorts the collapsed (v, N)
    // rows, and a limit/range/skip AFTER it is bulk-aware (the tail cumulative-bulk window). Both
    // stay identity-free. A reducer terminal routes limit/count through the bulk-UNAWARE count
    // branch, so those forms are left unsafe. order().by(traversal) is unsafe (nested sort).
    if (!reducerTerminal && !groupCountTerminal && isPlainOrder(steps[i])) { sawOrder = true; continue; }
    if (!reducerTerminal && !groupCountTerminal && sawOrder && (nm === 'limit' || nm === 'range' || nm === 'skip')) continue;
    return false; // any other step in the prefix (as/sack/path/branch/re-entry/…) → unsafe
  }
  return sawMove;
}

/** One cohesive analysis of the whole chain → the three chain-global facts. demandsEncounter
 *  and collapseSafe run as separate loops (their state machines track different things), but
 *  both call `isPlainOrder`, so they cannot disagree on how an order() neutralizes a fan-out.
 *  One call site per distinct chain replaces up to three separate re-scans. */
export function analyzeChain(steps: IRStep[]): ChainFacts {
  return {
    tracksPath: steps.some((s) => PATH_STEPS.has(s.name)),
    demandsEncounter: computeDemandsEncounter(steps),
    collapseSafe: computeCollapseSafe(steps),
  };
}
