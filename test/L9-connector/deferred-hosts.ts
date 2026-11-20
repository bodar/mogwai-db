// The hosts the scoped-relation connector does NOT own yet — each with the one-line reason and its blocker.
//
// `host-totality.test.ts` demands that every child-taking position the front end can produce is either a
// `CONNECTORS` row (`src/compiler/rel/lower/scoped.ts`, mirrored as `CONNECTOR_HOSTS` in `ir/analyze.ts`) or
// an entry here. So a new host cannot quietly get a route of its own: it is a CONNECTORS row, or it is written
// down here with why not and what would let it be one (root CLAUDE.md, locked decision 6).
//
// KEYS. A plain step name is the step's ARGUMENT position (`sideEffect(__.x)`); `<step>.by` / `<step>.with`
// is that step's `by()`/`with()` MODULATOR position (`path().by(__.x)`). `P(traversal)` is a predicate's
// traversal operand (`is(P.eq(__.x))`). A connector host covers both its positions, so `order.by` needs no row.
//
// When a host becomes a CONNECTORS row, DELETE its entry — the totality test fails on an entry that names a
// connector host, so the table can only describe what is genuinely deferred.

export interface Deferred {
  /** Why the connector does not own this position today. */
  readonly reason: string;
  /** What has to exist before it can — the work that would turn this into a CONNECTORS row. */
  readonly blocker: string;
  /**
   * Is this position in the ladder retirement's scope (`docs/2026-11-16-ladder-retirement-plan.md` R0/R6)?
   *  • `ladder` — a per-traverser child the host reads in the ladder's style: a correlated per-shape read of
   *    the body (the child seam's scalar or predicate answer, a body the ladder alone may hold), where the
   *    connector's scoped body is the general replacement. R6 moves these onto CONNECTORS rows, by workload reach.
   *  • `host-owned` — the host's own lowering owns the position and is not a correlated child route: a
   *    `Recursive` term, a write plan, a declarative pattern, a service, a graph-computer option, an option map.
   *    Out of the retirement's scope; it becomes a CONNECTORS row (or never does) on its own schedule.
   */
  readonly scope: 'ladder' | 'host-owned';
}

// Shared rows, for positions deferred for ONE reason.
const WRITE_ARG: Deferred = {
  reason: "a write's value/endpoint child — lowered inside the write plan (`rel/write.ts`) through the child seam's scalar/rooted answer",
  blocker: 'a scoped body inside a write: a graph WRITE threaded through a decorrelated body (collected side effects already are — `keyedBody`)',
  scope: 'host-owned',
};
const VALUE_ARG: Deferred = {
  reason: "a traversal-valued ARGUMENT of a value step (list/string/date ops) — the step's own payload builder reads it",
  blocker: 'a CONNECTORS row landing the argument as a join column (`byValues`, the S5 typed carrier)',
  scope: 'ladder',
};
const PREDICATE_OPERAND: Deferred = {
  reason: 'a predicate whose operand is a traversal — lowered by the filter family, not a host',
  blocker: 'a CONNECTORS row landing the operand per traverser as a join column, the predicate reading it (`byValues`)',
  scope: 'ladder',
};
const PROJECTION_BY: Deferred = {
  reason: "by() of a projection step that is not a connector host — the step's payload builder reads it through the child seam",
  blocker: "a CONNECTORS row for the step, landing each by() value as a join column read through `childSeam` (as order/group/project do)",
  scope: 'ladder',
};
const OLAP_WITH: Deferred = {
  reason: 'a with() option of a graph-computer / service step — configuration, not a per-traverser body',
  blocker: 'none — not a per-traverser child; a CONNECTORS row would need the step to run its option per traverser first',
  scope: 'host-owned',
};
const RESOURCE: Deferred = {
  reason: 're-sources the stream (reads ids/start rows from a child) — a body that draws or re-sources stays the ladder\'s (`scopedBody`)',
  blocker: 'a connector body that re-sources (the nested scope stack, plan Phase 3 item 2)',
  scope: 'ladder',
};
const REPEAT: Deferred = {
  reason: 'repeat()\'s body/loop condition — bounded is the IR unroll, unbounded a `Recursive` term (docs/archive/2026-08-09-repeat-two-regimes-plan.md)',
  // An unbounded until/emit condition of ANY head (coalesce/local/union/choose …) is the existence connector's
  // CORRELATED body over the walk row (`correlatedExistence`, `lower/scoped.ts`) — a nested SELECT, which may sit
  // inside the recursive term (`src/rel/recursive.ts` P2). A `limit(n)` there is a plain LIMIT (a one-row scope
  // has one key, `src/rel/decorrelate.ts`) and a trailing `count().is(P)` counts only as far as P can tell
  // (`boundConditionCount`, `ir/strategies.ts`), so the work per walk row is bounded. An EMIT condition is asked
  // over the FINISHED walk, once per distinct traverser state (`perState`, `walk.ts`), so any head answers
  // linearly there. An in-term until whose exhausting work reads only the frontier element's OWN rows
  // (`elementMap()`, `properties()`, a `project()` of its values) is bounded by the element and answers
  // (`perHostWork`'s `readsNeighbourhood`, `src/rel/work.ts`). What stays refused is the in-term until whose
  // exhausting work reads a NEIGHBOURHOOD: evaluated per FRONTIER row, never per distinct element.
  blocker: "SQLite's recursive-term law: no DISTINCT/aggregate/window in the recursive SELECT itself (`BARRIER_IN_TERM`) and no join to a keyed domain, so an until() condition is evaluated per frontier row, never once per distinct element — one of any head whose per-row work reads a whole NEIGHBOURHOOD (a barrier or a FILTER over an unbounded input that scans edges: `until(local(in().order().by(k).limit(1)))`, `until(union(in(),out()).has(k,v))`, `until(project('a').by(out().count()).select('a').is(0))`) would be quadratic at a hub and declines with that reason (`hubInWalkTerm`), as does one that DRAWS (`sample`/`coin`), holds its own walk, or orders/groups by a host column (`correlatedBody`'s refusals); a barrier over the element's own properties/labels is bounded by the element and answers",
  // The plan's open owner question ("should repeat until/emit's own condition lowering stay as it is?"): yes,
  // provisionally — the regime split IS the host's lowering, and its conditions use the shared correlated
  // predicate builders R1 extracts as substrate, not a ladder route.
  scope: 'host-owned',
};
const OPTION_MAP: Deferred = {
  reason: 'the option-map form (`choose(k).option(…)`, `branch(t).option(…)`, `mergeV().option(Merge.x, …)`) stays the host\'s own',
  blocker: 'a landed key value (the by()-values-as-join-columns primitive) routing each option arm',
  scope: 'host-owned',
};

export const DEFERRED_HOSTS: Readonly<Record<string, Deferred>> = {
  repeat: REPEAT,
  until: REPEAT,
  emit: REPEAT,
  option: OPTION_MAP,
  branch: OPTION_MAP,
  match: {
    reason: 'declarative match() is its own lowering (`rel/match.ts`) — patterns join on labels, not a per-traverser body',
    blocker: 'deprecated in TinkerPop 4; a pattern as connector bodies joined on bound labels (not planned)',
    scope: 'host-owned',
  },
  select: { reason: 'select(traversal) — the KEY is the child\'s value', blocker: VALUE_ARG.blocker, scope: 'ladder' },
  V: RESOURCE,
  E: RESOURCE,
  call: { reason: "a service's parameter traversal — the service owns it (`src/services/`)", blocker: 'services are barriers/streams, not per-traverser bodies', scope: 'host-owned' },
  addE: WRITE_ARG,
  addV: WRITE_ARG,
  addLabel: WRITE_ARG,
  dropLabel: WRITE_ARG,
  property: WRITE_ARG,
  from: WRITE_ARG,
  to: WRITE_ARG,
  mergeV: WRITE_ARG,
  mergeE: WRITE_ARG,
  concat: VALUE_ARG,
  dateDiff: VALUE_ARG,
  combine: VALUE_ARG,
  difference: VALUE_ARG,
  disjunct: VALUE_ARG,
  intersect: VALUE_ARG,
  merge: VALUE_ARG,
  product: VALUE_ARG,
  has: PREDICATE_OPERAND,
  hasId: PREDICATE_OPERAND,
  hasKey: PREDICATE_OPERAND,
  hasLabel: PREDICATE_OPERAND,
  hasValue: PREDICATE_OPERAND,
  is: PREDICATE_OPERAND,
  none: PREDICATE_OPERAND,
  'P(traversal)': PREDICATE_OPERAND,
  'path.by': PROJECTION_BY,
  'select.by': PROJECTION_BY,
  'valueMap.by': PROJECTION_BY,
  'sack.by': PROJECTION_BY,
  'math.by': PROJECTION_BY,
  'format.by': PROJECTION_BY,
  'aggregate.by': PROJECTION_BY,
  'call.with': OLAP_WITH,
  'connectedComponent.with': OLAP_WITH,
  'pageRank.with': OLAP_WITH,
  'peerPressure.with': OLAP_WITH,
  'shortestPath.with': OLAP_WITH,
};
