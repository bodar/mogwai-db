import { type IRStep } from './strategies.ts';
import { argValues, isNested, stepChain } from '../../gremlin/frontend.ts';
import { isLocalScope, isPlainOrder, isStreamBarrier, PATH_FAMILY, REDUCERS } from './step.ts';
import { bulkGroupCollapseTerminal, COLLAPSE_FILTERS, COLLAPSE_MOVES, COLLAPSE_PROJ } from './bulk.ts';

// ---------- whole-chain analysis: annotate, never rewrite ----------
//
// The chain-global properties the lowering needs to know BEFORE it starts folding steps: does the
// chain track a path? does it need a threaded emission-order encounter? Each was previously a
// separate re-walk of `steps` scattered across engine.ts + strategies.ts; two of them re-scanned the
// SAME array (the `demandsEncounterOrder` double-call), and two shared an
// order()-neutralizes-fanout predicate that had to be kept in sync by a prose comment.
// `analyzeChain(steps)` computes them in one place, with the shared predicate (`isPlainOrder`) defined
// ONCE — in `ir/step.ts`, since `chainCollapseSafe` and `ir/bulk.ts` hinge on it too.
//
// This is DATA, no behavior — an immutable record, like FastPathConfig. It is NOT a Pass (it never
// rewrites the chain) and NOT per-step (each field is one value for the whole chain, read
// at one seeding site). `chainNeedsFromV`/`trackFromV` is deliberately NOT here — it is a
// PER-SCOPE derivation (re-computed at lowerElementSteps over each child scope's own,
// narrower step slice) and lives on `carried`, not on a chain-level record.

/** Whole-chain properties derived once, before lowering. Read-only DATA (no methods); the
 *  lowering consults it instead of re-scanning. */
export interface ChainFacts {
  /** was chainTracksPath        → seedSource: add the p0 path column? */
  readonly tracksPath: boolean;
  /** was demandsEncounterOrder  → seedSource: seed + thread the emission-order encounter? */
  readonly demandsEncounter: boolean;
  /** Does a POSITIONAL slice (limit/range/skip/tail at global scope) read the emission order? A
   *  branch merge whose fan-out is read by a slice must present the reference's TRAVERSER-major /
   *  arm-major subset — a key this spine does not mint yet — so the branch DECLINES there rather
   *  than let a deterministic-but-different order pick a wrong subset (a wrong ANSWER, not a
   *  reorder — the `branch-traverser-major.feature` pins). A COLLECT/write demand (fold/cap/group)
   *  takes any deterministic order, since TinkerPop's own branch emission order is impl-defined and
   *  no corpus scenario pins a branch fold's member order. See `withFanoutOrder` (lower.ts). */
  readonly demandsSlice: boolean;
}

/** Steps that need the linear path threaded through the fold: the source vertex becomes path
 *  position p0 and every hop appends a position. */
const PATH_STEPS = PATH_FAMILY;

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

/** Branch-merge steps whose arms each run over the INCOMING stream — so a drop-slice inside an arm
 *  picks the first N in the incoming emission order and, exactly like a top-level slice, needs the
 *  encounter seeded and threaded to the branch. The FLAT scan in `computeDemandsEncounter` cannot see a
 *  nested slice, so `armChains` + `bodyDemandsEncounter` recurse their arm bodies. Without this, a chain
 *  like `V().has(k).union(__.has(k2).limit(1), __.identity())` seeds no order, and whichever scan order a
 *  fast path (propertySeek's `has()`→JOIN) happens to produce silently picks the surviving traverser —
 *  an order-dependent WRONG multiset, the defect `test/L5-properties/known.ts` recorded. */
const BRANCH_MERGE_STEPS = new Set(['union', 'choose', 'coalesce', 'optional']);

/** The nested arm step-chains of a branch-merge step — union/coalesce's nested args and choose's
 *  `optionArms`. An unnormalizable arm is skipped: it declines in the lowering, so at worst this
 *  over- or under-seeds an order column, never mis-answers. */
function armChains(step: IRStep): IRStep[][] {
  const trees: unknown[] = [];
  for (const a of argValues(step)) if (isNested(a)) trees.push((a as { nested: unknown }).nested);
  for (const opt of step.optionArms ?? []) {
    const n = argValues(opt as IRStep).find(isNested);
    if (n) trees.push((n as { nested: unknown }).nested);
  }
  const chains: IRStep[][] = [];
  for (const t of trees) { try { chains.push(stepChain(t, {}) as IRStep[]); } catch { /* unnormalizable — skip */ } }
  return chains;
}

/** Does this step chain contain a drop-slice whose survivor depends on the incoming order — at its own
 *  top level, or inside a nested branch-merge arm (recursively)? `Scope.local` is exempt: it slices a
 *  value's members, not the stream's rows. */
function bodyDemandsEncounter(steps: readonly IRStep[]): boolean {
  return steps.some((s) =>
    (POSITIONAL_CONSUMERS.has(s.name) && !isLocalScope(s))
    || (BRANCH_MERGE_STEPS.has(s.name) && armChains(s).some(bodyDemandsEncounter)));
}

/** Does this `group()` reduce each key's values to an order-insensitive scalar?
 * TinkerPop first makes the structural distinction in `Grouping.hasBarrierInValueTraversal`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java`).
 * Calcite keeps the corresponding property on each aggregate as `requiresGroupOrder`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/sql/SqlAggFunction.java`), rather than on
 * GROUP BY itself. Both checks matter: `fold()` is itself a non-local barrier, but its `addAll`
 * reducer observes member order. A missing value by() and a literal/property value by() are also
 * converted to folds, so all three remain collections. Conservatively retain encounter for a
 * post-barrier transform; only a global numeric reducer/count at the observable tail is classified. */
function groupReducesItsValues(step: IRStep): boolean {
  if (step.name !== 'group') return false;
  const value = (step.modulators ?? [])[1]?.[0];
  if (value === undefined || !isNested(value)) return false;
  try {
    const inner = stepChain(value.nested, {});
    return inner.some(isStreamBarrier) && inner.length > 0
      && REDUCERS.has(inner.at(-1)!.name) && isStreamBarrier(inner.at(-1)!);
  } catch {
    return false;
  }
}

const collectsInOrder = (step: IRStep): boolean =>
  COLLECTING_CONSUMERS.has(step.name) && !groupReducesItsValues(step);
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
    if (collectsInOrder(s)) return true;
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
    // …and the same slice INSIDE a branch-merge arm is order-sensitive w.r.t. the incoming stream, but
    // the flat scan above cannot see it. Seed the encounter so the stream feeding the branch is ordered
    // and the arm's slice is deterministic. An upstream order() already satisfies it (`ordered`).
    if (!ordered && BRANCH_MERGE_STEPS.has(s.name) && armChains(s).some(bodyDemandsEncounter)) return true;
    // dedup(labels) keeps the FIRST traverser per key — first-in-emission, so it needs the
    // encounter. Bare dedup() collapses a multiset regardless of order (never triggers).
    if (sawFanout && s.name === 'dedup' && argValues(s).some((a) => typeof a === 'string')) return true;
    if (FANOUT_STEPS.has(s.name)) { sawFanout = true; ordered = false; }
  }
  return false;
}

// ---------- chainCollapseSafe — THE CHAIN-GLOBAL collapse question, no longer a ChainFacts field ----------
//
// **This is not a `ChainFacts` field any more, and that is the point of §7.4 item 1's last sentence
// ("`collapseSafe` stops being a chain verdict").** It was a whole-chain ANNOTATION once; the lowering
// now answers the same question per position — of the channels carried at the node
// (`groupableChannels`) and of the suffix that must read the multiplicity (`ir/bulk.ts`). A field on
// the shared record implied the lowering needed the verdict, when the lowering answers collapse-safety
// positionally and discarded it on every compile, so the question lives as this standalone predicate.
//
// `demandsEncounter` is folded in HERE rather than at the call site for the same reason the field went
// away: the mutual exclusion (a collapse discards per-row identity, so it cannot coexist with a live
// emission order) is part of what "is a collapse safe for this chain" MEANS, not a second condition a
// caller has to remember. The lowering states the same law positionally, off the relation (`!encounterOf`).
//
// Convergent-walk collapse (SELECT id, SUM(bulk) GROUP BY id at each movement) is
// result-equivalent ONLY when the whole chain is a linear movement/filter prefix ending in a
// global bulk-aware reducer: nothing carries per-traverser identity (path/as/sack), nothing
// is bulk-unaware on rows (order/limit/range/sample), and no branch/barrier/re-entry sits
// between the collapse and the reducer's SUM(bulk). Anything outside these sets → not safe →
// the plain UNION-ALL movement (identical result, unbounded rows).
//
// **It answers TWO questions at once, and only one of them is chain-global.** "Does the state
// carried here survive a merge" is a property of a POSITION (`channels.ts`'s
// `CHANNEL_GROUP_POLICY`), and "will the multiplicity be read" is a property of a SUFFIX
// (`ir/bulk.ts`'s `bulkObservedFrom`). Folding both into one boolean for the whole chain is
// what makes this refuse a collapse at a hop where nothing but `bulk` is carried — see §7.2/§7.3
// of `docs/archive/2026-08-09-repeat-two-regimes-plan.md`, and `ir/bulk.ts`'s header for the two
// references that both model it positionally. The vocabularies below are imported from there
// rather than spelled again here, so the two answers cannot drift while both exist.
const COLLAPSE_REDUCERS = REDUCERS;

export function chainCollapseSafe(steps: IRStep[]): boolean {
  if (computeDemandsEncounter(steps)) return false; // a live emission order and a collapse are mutually exclusive
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
  const groupCountTerminal = bulkGroupCollapseTerminal(last);
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

/** One cohesive analysis of the whole chain → the chain-global facts the lowering reads. It held a third,
 *  `collapseSafe`, now the standalone `chainCollapseSafe` above: a field on this record implied the
 *  lowering needed the verdict, but the lowering answers collapse-safety positionally and discarded it
 *  on every compile. What is left is genuinely used — RelIR seeds its `encounter` and `path` channels
 *  off exactly these two (`lowerChain`).
 *  `isPlainOrder` still lives in `ir/step.ts` because three scans hinge on it and none may drift. */
export function analyzeChain(steps: IRStep[]): ChainFacts {
  return {
    tracksPath: steps.some((s) => PATH_STEPS.has(s.name)),
    demandsEncounter: computeDemandsEncounter(steps),
    demandsSlice: steps.some((s) => POSITIONAL_CONSUMERS.has(s.name) && !isLocalScope(s)),
  };
}
