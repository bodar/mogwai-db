import { withChannel, type Channel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { exprMayRaise, mayRaise, raiseCarried, raiseTest } from '../../rel/raise.ts';
import type { Rel } from '../../rel/rel.ts';
import type { RelId } from '../../rel/types.ts';
import { exprRels, forEachExpr, forEachRel, relChildren, relExprs } from '../../rel/walk.ts';
import { meta, typeOf, type Minter } from './build.ts';
import { isLocalScope, sliceOf, SLICE_STEPS, type IRStep } from '../ir/step.ts';
import { isNested, isScopeArg, type Step } from '../../gremlin/frontend.ts';
import { eachChildChain, rawBodies } from '../ir/walk.ts';

/**
 * THE PENDING RAISE — a row whose evaluation RAISED, carried as DATA to the step that decides whether the
 * reference ever pulls that row (relir-build-plan §10, cluster E).
 *
 * The reference evaluates a step lazily, one traverser at a time, as the step after it pulls: a
 * `FilterStep` runs its body on the traverser `processNextStart` is handed
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/FilterStep.java`),
 * and a `limit()` stops pulling one traverser past its bound — `RangeGlobalStep.filter` throws
 * `FastNoSuchElementException` on the first traverser it is handed once it holds `high`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/RangeGlobalStep.java`).
 * So `g.V().order().by(label, desc).where(__.values('age').toUpper().fold()).limit(1)` is `[lop]`: `lop`
 * has no age, its fold is `[]`, `ripple` is pulled and is clean, and nothing after it is ever pulled. SQL
 * has no laziness to borrow — a `WHERE` that raises is evaluated on every row before the `ORDER BY`/`LIMIT`
 * above it — so a raise the fold makes a row predicate fires on `marko`, which the reference never reaches.
 *
 * So the raise RIDES THE ROW instead of being thrown: a source projects the reference's message into a
 * `raise`-role channel (`rzp`, NULL on a clean row) and KEEPS the row, so a downstream head slice counts it
 * exactly where the reference would have met it. The slice then SETTLES the channel over the rows the
 * reference pulled (`pulledBy`), and a reducing barrier inside a child body ESCALATES it (any member's
 * raise is the whole collection's: `CollectingBarrierStep` drains every start,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/CollectingBarrierStep.java`)
 * into the child value's own `raise`, which its host carries on the host row in turn.
 *
 * A raise is DEFERRED only across a span this module can prove (`defersRaise`): from its source, through a
 * run of filters that keep a raising row, to the slice run that consumes it (`pullExtent`). Every other
 * position settles at the source — but only where the reference pulls every row reaching it, through every
 * enclosing host up to the root (`PullLevel`, `settlesExactly`); every in-statement raise any step mints is
 * held to that one rule at the step boundary (`raisesWherePulled`), and anywhere it fails the traversal
 * DECLINES. `raiseContained` checks the finished plan: a raising relation read by anything other than a
 * vetted carrier or a consumer declines, so a raise a builder dropped on the way can never become an answer.
 *
 * The executor needs no part in it: the slice's settle is exact over the rows the reference pulls, and a
 * raise never rides past the step that consumes it, so no framed row ever carries one.
 */
export const RAISE: Channel = { col: 'rzp', role: 'raise' };

/** The pending raise a relation carries, if any. */
export const pendingRaise = (rel: Rel): Channel | undefined => rel.channels.find((channel) => channel.role === 'raise');

/** The FIRST offending test's message as a value, NULL where none offends — `raisingWhen` (`receiver.ts`)
 *  with the message in place of the raise. */
export const raiseMessage = (offences: readonly (readonly [Expr, string])[]): Expr =>
  ({ kind: 'case', whens: offences.map(([test, message]) => [test, compilerText(message)] as const), else: compilerNull('text') });


/** `step` as the reference's `RangeGlobalStep` — `limit`/`range`/`skip` over the stream, as its `low` and
 *  `high` (`null`: unbounded) — or `null` where it is no such step. `tail`/`sample` are not: they drain. */
function globalSlice(step: IRStep | undefined): { readonly low: number; readonly high: number | null } | null {
  if (!step || !SLICE_STEPS.has(step.name)) return null;
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return null;
  // A PARAMETER bound stays a bind (root CLAUDE.md: a bind serves a user parameter); the extent `pullExtent`
  // derives would be a constant computed from it, so a parameterized slice keeps the eager settle.
  if (step.args.some((a) => a.name != null)) return null;
  try {
    const { offset, limit } = sliceOf(step);
    // A negative count (`limit(-1)`) is `RangeGlobalStep`'s `high = -1`: unbounded.
    return { low: offset, high: limit === null || limit < 0 ? null : offset + limit };
  } catch { return null; }
}

/**
 * HOW FULLY THE REFERENCE PULLS ONE STEP LIST — the question every raise asks before it is evaluated over
 * every row SQL scans, at ANY depth.
 *
 * The reference is lazy: a step is evaluated on a traverser only when the step after it pulls one, and a
 * `limit()` stops pulling one traverser past its bound (`RangeGlobalStep.filter` throws
 * `FastNoSuchElementException` on the first traverser it is handed once it holds `high`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/RangeGlobalStep.java`).
 * Inside a child body the same is true ONE LEVEL UP: an `optional()`/`local()` iterates its body
 * as its own consumer pulls (`OptionalStep.processNextStart`, `LocalStep.processNextStart`, both one start
 * per pull — `…/step/branch/OptionalStep.java`, `…/step/branch/LocalStep.java`), so a body under a host a
 * slice follows is pulled no further than that slice pulls the host. A body's own exactness is therefore
 * never the body's alone — it is the body's, then its host's position in the chain above, up to the root.
 *
 * A level answers two things: `reached` — every invocation of the list SQL makes, the reference makes too
 * (it pulls every start SQL feeds the list's first step); and `drained` — beyond that, the reference pulls
 * EVERYTHING the list emits, and asks once more (so a head slice at its end meets exactly `n + 1` rows).
 * The root traversal is both. A body is `reached` where its host is (`exactFrom` from the host's own
 * position — a draining host such as `order().by(…)` evaluates every by() it was handed), and `drained`
 * only where its host also iterates it to exhaustion (`LAZY_BODY_HOSTS`): a filter's body or a `by()` is
 * read for its FIRST result (`TraversalUtil.test`/`apply`), and a `choose`'s selector is too.
 */
export interface PullLevel { readonly reached: boolean; readonly drained: boolean }

/** WHERE a tail stands — the list it is folding, the step it is at, and that list's `PullLevel`. Carried on
 *  `ChainCtx.pull` (`pullAt`), so a body lowered from the step at `at` reads its level off its host. `below`
 *  is the relation the tail held BEFORE folding that step, so the next step can tell what it minted
 *  (`raisesWherePulled`). */
export interface PullPosition { readonly steps: readonly IRStep[]; readonly at: number; readonly level: PullLevel; readonly below?: Rel }

/** The top-level traversal: driven to the end by the terminal, every row pulled. */
const TOP: PullLevel = { reached: true, drained: true };

/** Hosts that RESET their body and iterate it to exhaustion for each start before asking for the next one
 *  — when their own output is fully pulled: `LocalStep`/`OptionalStep`/`CoalesceStep` call
 *  `traversal.reset()` per start, `flatMap()`/`sideEffect()` go through `TraversalUtil.applyAll`, which
 *  `prepare`s (resets) it (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java`).
 *
 *  Every `BranchStep` is ABSENT — `union()`, `choose()`, `branch()`. `BranchStep.standardAlgorithm`
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java`)
 *  only `addStart`s each new start into a child it NEVER resets and re-asks `option.hasNext()` once per
 *  start; a body slice's `RangeGlobalStep` keeps ONE counter across all of them, so once it fills, every
 *  later start drags one more upstream traverser through the body before the bound throws. A body slice's
 *  pull count is then `n` + the number of later starts — a function of the DATA, not of the traversal — so
 *  a raise riding to it cannot be settled exactly, and declines. (`choose`'s selector is also read for its
 *  first result only.) */
const LAZY_BODY_HOSTS: ReadonlySet<string> = new Set(['local', 'flatMap', 'optional', 'coalesce', 'sideEffect']);

/** `ctx` at `steps[at]` — the ONE marker every tail sets per step, so a body lowered from that step knows
 *  its host. Within the same list the level is inherited; a new list is a body of the marked host. */
export function pullAt<C extends { readonly pull?: PullPosition }>(ctx: C, steps: readonly IRStep[], at: number, below?: Rel): C {
  if (ctx.pull?.steps === steps && ctx.pull.at === at && ctx.pull.below === below) return ctx;
  return { ...ctx, pull: { steps, at, level: levelOf(ctx.pull, steps), ...(below ? { below } : {}) } };
}

/** The `PullLevel` of `steps`, given the innermost marked position. No marker is the top-level chain. */
function levelOf(pull: PullPosition | undefined, steps: readonly IRStep[]): PullLevel {
  if (!pull) return TOP;
  if (pull.steps === steps) return pull.level;
  const host = pull.steps[pull.at];
  const reached = exactFrom(pull.steps, pull.at, pull.level, 'reached');
  return { reached, drained: reached && host !== undefined && LAZY_BODY_HOSTS.has(host.name) && exactFrom(pull.steps, pull.at, pull.level, 'drained') };
}

/**
 * Does the reference pull EVERY row that reaches `steps[at]` — `need: 'reached'` — or, beyond that, ask
 * once more past the last (`'drained'`)? A DRAINING step (`CollectingBarrierStep`/`ReducingBarrierStep`
 * pull every start before they emit, `step/util/CollectingBarrierStep.java`) settles it as the level's
 * `reached`; a bounded slice first means no; the list's end hands the question to the level.
 *
 * The implicit `NoOpBarrierStep`s `LazyBarrierStrategy` places after a flat-map are NOT drains here: one
 * holds at most `MAX_BARRIER_SIZE` (2500) traversers
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/NoOpBarrierStep.java`),
 * so what it pulls ahead depends on the data — counting one would raise where a larger graph answers.
 */
function exactFrom(steps: readonly IRStep[], at: number, level: PullLevel, need: 'reached' | 'drained'): boolean {
  for (let next = at; next < steps.length; next++) {
    const step = steps[next]!;
    if (DRAINING.has(step.name) && !isLocalScope(step)) return level.reached;
    if ((step.name === 'limit' || step.name === 'range') && !isLocalScope(step)) {
      try { const { limit } = sliceOf(step); if (limit !== null && limit >= 0) return false; } catch { return false; }
    }
  }
  return need === 'drained' ? level.drained : level.reached;
}

/**
 * THE ROWS A SLICE AT `steps[at]` MAKES THE REFERENCE EVALUATE — a count, `'all'` where it pulls its whole
 * input, or `null` where the count is not fixed by the traversal and a raise riding to it must not be
 * settled there.
 *
 * `RangeGlobalStep` tests its bound inside `filter`, AFTER `FilterStep.processNextStart` has pulled the next
 * start, so the `hasNext()` that follows the `high`-th result drags ONE more traverser through every step
 * before the slice (`g.V().union(values('name'), values('age')).toUpper().limit(1)` raises on marko's age):
 * asked `k` times, a `range(low, high)` pulls `min(low + k, high + 1)` — the `low` it discards, then one
 * per request until `high` — and a `skip(low)` pulls `low + k`. That holds only as far as the consumer
 * after the slice asks, so a RUN of slices composes from its far end: the step after the run must drain it
 * (`exactFrom … 'drained'`, through every enclosing host — `k` is then unbounded), and each slice's pulls
 * are the requests of the one before. So `limit(2).limit(1)` pulls 2, not 3 (what `EarlyLimitStrategy`'s
 * merge of adjacent `RangeGlobalStep`s also gives, `…/strategy/optimization/EarlyLimitStrategy.java`
 * `moveRangeStep`), and `skip(1).limit(1)` pulls 3. A filter or a flat-map between two slices makes the
 * inner one's requests data-dependent, so the run ends there and the step after it must drain.
 */
export function pullExtent(steps: readonly IRStep[], at: number, pull: PullPosition | undefined): number | 'all' | null {
  const run: { readonly low: number; readonly high: number | null }[] = [];
  let next = at;
  for (; next < steps.length; next++) {
    const step = steps[next]!;
    const slice = globalSlice(step);
    if (slice) run.push(slice);
    else if (!run.length || !TRANSPARENT.has(step.name) || step.modulators?.length) break;
  }
  if (!run.length || !exactFrom(steps, next, levelOf(pull, steps), 'drained')) return null;
  let requests = Infinity;
  for (let i = run.length - 1; i >= 0; i--) {
    const { low, high } = run[i]!;
    requests = high === null ? low + requests : Math.min(low + requests, high + 1);
  }
  return requests === Infinity ? 'all' : requests;
}

/** The FIRST `extent` rows of the slice's input, as a `limit(extent)` beside it — the rows the reference
 *  pulled (`pullExtent`). The raise is settled over THESE rows; the slice proper is taken after it. */
export function pulledBy(step: IRStep, extent: number): IRStep {
  const count = step.args.find((a) => !isScopeArg(a.value))!;
  return { ...step, name: 'limit', args: [{ ...count, value: extent }] };
}

/**
 * MAY A RAISE BORN AT `steps[at - 1]` RIDE TO `steps[at]` — the ONE deferral rule every source asks.
 *
 * Yes where a step CONSUMES it exactly: a head slice whose pulled extent is fixed (`pullExtent`; `sliceOp`
 * settles it over those rows), or — inside a child body whose host asked for its raise as data
 * (`ChainCtx.raiseEscalates`, the body's own step list BY IDENTITY, so no nested or rewritten list inherits
 * it) — the body's terminal reducing barrier, which `escalatedRaise` turns into the child value's `raise`.
 * A run of FILTER steps may stand between (`passesRaise`): `FilterStep` hands a traverser on or drops it,
 * and a raising traverser never reached the filter in the reference, so the filter keeps it
 * (`hostFilter`); so may a label (`as()`), which is no step of the reference's at all. Anywhere else the
 * source settles immediately.
 */
export function defersRaise(
  steps: readonly IRStep[], at: number, ctx: { readonly pull?: PullPosition; readonly raiseEscalates?: readonly IRStep[] }, collapses: (name: string) => boolean,
): boolean {
  let next = at;
  while (passesRaise(steps[next])) next++;
  const consumer = steps[next];
  // A run pulling its WHOLE input needs no carrying: the eager settle is exact there (`settlesExactly`).
  if (typeof pullExtent(steps, next, ctx.pull) === 'number') return true;
  return ctx.raiseEscalates === steps && next === steps.length - 1 && consumer !== undefined && collapses(consumer.name);
}

/**
 * IS AN EAGER SETTLE AT `steps[at - 1]` EXACT — does the reference pull EVERY row the source sees, at this
 * level AND through every host above it (`PullLevel`)? A bounded slice after only streaming steps
 * (`dedup()`, a movement, a map), or a host a bounded slice follows, stops pulling where the reference
 * would, so a raise SQL evaluates on every row would be an error the reference never meets — the caller
 * DECLINES rather than over-raise.
 */
export function settlesExactly(steps: readonly IRStep[], at: number, ctx: { readonly pull?: PullPosition }): boolean {
  return exactFrom(steps, at, levelOf(ctx.pull, steps), 'reached');
}

/** The steps that pull EVERY start before they emit — the collecting and reducing barriers. */
const DRAINING: ReadonlySet<string> = new Set([
  'order', 'barrier', 'aggregate', 'sample', 'tail', 'fold', 'count', 'sum', 'min', 'max', 'mean',
  'group', 'groupCount', 'tree', 'cap', 'subgraph',
]);

/** Steps that are no step of the reference's — a label rides the previous step, `identity()` is removed
 *  (`IdentityRemovalStrategy`) — so neither changes what is pulled. */
const TRANSPARENT: ReadonlySet<string> = new Set(['as', 'identity']);

/** The filter steps a pending raise rides THROUGH — each lowered by `hostFilter`, which keeps a raising row
 *  — and the transparent steps. A form some other route lowers (an alias-compare `where`) is refused at the
 *  end by `raiseContained`. */
const FILTER_HOSTS: ReadonlySet<string> = new Set(['where', 'filter', 'not', 'and', 'or', 'has', 'hasLabel', 'hasId', 'hasKey', 'hasValue', 'hasNot']);
const passesRaise = (step: IRStep | undefined): boolean =>
  step !== undefined && (FILTER_HOSTS.has(step.name) || TRANSPARENT.has(step.name)) && !step.modulators?.length && !step.optionArms;
/** A relation's rows with `message` POISONING the ones it is non-null on — the row is kept, and an
 *  earlier pending raise on it wins (the reference raised there first). */
export function poisonRows(rel: Rel, message: Expr, fresh: Minter): Rel {
  const prior = pendingRaise(rel);
  const raised: Expr = prior ? { kind: 'call', fn: 'COALESCE', args: [col(rel.id, prior.col), message] } : message;
  const channels = prior ? rel.channels : withChannel(rel.channels, RAISE);
  const cols = prior ? rel.type.cols : [...rel.type.cols, meta(RAISE.col, 'text', true)];
  return make.project({
    id: fresh('rz'), input: rel, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, column.name === RAISE.col ? raised : col(rel.id, column.name)] as const),
  });
}

/** Nodes that READ a raising relation and answer for its raise — a settling filter, an escalation, a child
 *  value guarded by the raise it escalated. Identity-keyed: the plan is a DAG of frozen nodes. */
const CONSUMERS = new WeakSet<Rel>();
/** Nodes INSIDE a claimed raising span — a carrier a consumer has walked and accepted. */
const VETTED = new WeakSet<Rel>();
/** The FILTERS a raising row may pass through: one that keeps it whatever its clause says (`keepingRaise`)
 *  or one that reads only a POSITION (a slice's rank test, `trustSlice`). Any other filter over a raising
 *  relation tests the row's garbage value and could drop it, so a span through one is refused. */
const KEEPS = new WeakSet<Rel>();

/** A filter over a raising relation that KEEPS every raising row — `CASE WHEN <raise> IS NOT NULL THEN 1
 *  ELSE <clause> END` — registered as one a raise may pass through. */
export function keepingRaise(input: Rel, clause: Expr, id: RelId): Rel {
  const pending = pendingRaise(input)!;
  const kept = make.filter({
    id, input, channels: input.channels, type: input.type,
    pred: { kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: col(input.id, pending.col), right: compilerNull() }, compilerInt(1)]], else: clause },
  });
  KEEPS.add(kept);
  return kept;
}

/** The filters a slice built between `top` and its `input` test only a position (a rank, a sample draw is
 *  not a head slice and never gets here), so a raising row passes them by where it stands. */
export function trustSlice(top: Rel, input: Rel): void {
  const seen = new Set<Rel>();
  const stack = [top];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === input || seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'filter') KEEPS.add(node);
    stack.push(...relChildren(node));
  }
}

/** The node kinds a pending raise may ride through: each keeps a row's identity (a 1:1 projection, a
 *  positional window/limit/rank filter, a fence). A join, an aggregate, an explode or a union can drop or
 *  multiply a poisoned row by its garbage value, so a span through one is refused. */
const CARRIERS: ReadonlySet<Rel['kind']> = new Set(['project', 'filter', 'limit', 'window', 'materialize', 'sort', 'distinct']);

/** Claim the raising span under `top`: every raising node reachable through raising carriers is vetted.
 *  `false` where the span reaches a node kind a raise cannot ride through, or a filter that may drop a
 *  raising row. (A source defers only where its own value raises nothing eagerly — `raiseDefersTo`'s
 *  callers — so a span holds no raise SQL would evaluate past the kept rows.) */
function vetSpan(top: Rel): boolean {
  const stack = [top];
  while (stack.length) {
    const node = stack.pop()!;
    if (!pendingRaise(node) || VETTED.has(node)) continue;
    if (!CARRIERS.has(node.kind) || (node.kind === 'filter' && !KEEPS.has(node))) return false;
    VETTED.add(node);
    stack.push(...relChildren(node));
  }
  return true;
}

/** Raise `message` (an expression over the row, or a value over the whole set) where it is non-null. */
const raisingWhere = (message: Expr): Expr =>
  ({ kind: 'case', whens: [[{ kind: 'binary', op: 'is not', left: message, right: compilerNull() }, raiseCarried(message)]], else: compilerInt(1) });

/** `rel` with its pending raise channel dropped behind `settled`, the consumer that answered for it. */
function dropRaise(rel: Rel, settled: Rel, fresh: Minter): Rel {
  const pending = pendingRaise(rel)!;
  CONSUMERS.add(settled);
  const kept = rel.type.cols.filter((column) => column.name !== pending.col);
  const dropped = make.project({
    id: fresh('rzd'), input: settled, channels: rel.channels.filter((channel) => channel !== pending), type: typeOf(...kept),
    exprs: kept.map((column) => [column.name, col(settled.id, column.name)] as const),
  });
  CONSUMERS.add(dropped);
  return dropped;
}

/**
 * SETTLE a pending raise EAGERLY — raise the carried message on any row that holds one — and drop the
 * channel. The answer wherever every row reaching it is one the reference pulls: a slice that drains (a
 * `skip`, a `tail`), or a source with no consumer after it — the evaluation those positions always had.
 */
export function settleRaise(rel: Rel, fresh: Minter): Rel {
  const pending = pendingRaise(rel);
  if (!pending) return rel;
  const settled = make.filter({ id: fresh('rzs'), input: rel, channels: rel.channels, type: rel.type, pred: raisingWhere(col(rel.id, pending.col)) });
  return dropRaise(rel, settled, fresh);
}

/**
 * THE FIRST RAISE OVER A WHOLE RELATION, in traverser order — one value, NULL where no row raised. A
 * reducing barrier's escalation and a head slice's settle both need it: the raise is the SET's (a barrier
 * drains every start; a slice pulls every row it was handed), and an aggregate-shaped scalar is evaluated
 * over all of them, where a per-row `WHERE` sharing a statement with a later `LIMIT` would let SQLite stop
 * scanning — and stop raising — at the limit.
 */
function firstRaise(rows: Rel, fresh: Minter): Expr {
  const pending = pendingRaise(rows)!;
  const raised = make.filter({
    id: fresh('rze'), input: rows, channels: rows.channels, type: rows.type,
    pred: { kind: 'binary', op: 'is not', left: col(rows.id, pending.col), right: compilerNull() },
  });
  const encounter = rows.channels.find((channel) => channel.role === 'encounter');
  const ordered = encounter
    ? make.sort({ id: fresh('rzo'), input: raised, channels: raised.channels, type: raised.type, terms: [{ expr: col(raised.id, encounter.col), dir: 'asc' }] })
    : raised;
  const first = make.limit({ id: fresh('rzl'), input: ordered, channels: ordered.channels, type: ordered.type, count: compilerInt(1) });
  const message = make.project({
    id: fresh('rzm'), input: first, channels: [], type: typeOf(meta(pending.col, 'text', true)),
    exprs: [[pending.col, col(first.id, pending.col)]],
  });
  for (const consumer of [raised, ordered, first, message]) CONSUMERS.add(consumer);
  return { kind: 'scalar', plan: message };
}

/**
 * The rows a head slice PULLED (`pulledBy`), with the raise any of them carried SETTLED and the channel
 * dropped — or `null` where the slice lost the channel or the span it consumed cannot carry one (fail
 * closed, never an answer). The slice proper is taken from these rows afterwards.
 */
export function settledSlice(pulled: Rel, fresh: Minter): Rel | null {
  if (!pendingRaise(pulled) || !vetSpan(pulled)) return null;
  const settled = make.filter({ id: fresh('rzs'), input: pulled, channels: pulled.channels, type: pulled.type, pred: raisingWhere(firstRaise(pulled, fresh)) });
  return dropRaise(pulled, settled, fresh);
}

/**
 * ESCALATE the pending raise inside a child body's reduced plan into ONE value: the first raising row's
 * message in traverser order, NULL where no row raised — the `raise` of the child value the plan computes.
 *
 * `plan` is the body's reduced relation and `readers` every other plan the child value reads (its
 * productivity probe, its type tag): each reads the raising rows, and each is superseded by the raise it
 * guards, so each is a CONSUMER. `null` (decline) where the span is not one vettable stream.
 */
export function escalatedRaise(plan: Rel, readers: readonly Rel[], fresh: Minter): Expr | null {
  const frontier = new Set<Rel>();
  const consumers = new Set<Rel>();
  const seen = new Set<Rel>();
  const walk = (node: Rel): void => {
    if (seen.has(node) || pendingRaise(node)) return;
    seen.add(node);
    for (const child of [...relChildren(node), ...subplans(node)]) {
      // A raise a nested consumer already answered for (a settled slice, an inner escalation) is not ours.
      if (pendingRaise(child)) { if (!CONSUMERS.has(node)) { frontier.add(child); consumers.add(node); } } else walk(child);
    }
  };
  // The root itself may be the raising relation — a bare stream the reader probes directly.
  for (const root of [plan, ...readers]) {
    if (pendingRaise(root)) return null;
    walk(root);
  }
  if (frontier.size !== 1) return frontier.size === 0 ? compilerNull('text') : null;
  const [rows] = frontier;
  if (!vetSpan(rows!)) return null;
  for (const consumer of consumers) CONSUMERS.add(consumer);
  return firstRaise(rows!, fresh);
}

const subplans = (node: Rel): readonly Rel[] => {
  const plans: Rel[] = [];
  for (const e of relExprs(node)) forEachExpr(e, (sub) => plans.push(...exprRels(sub)));
  return plans;
};

/**
 * IS EVERY PENDING RAISE IN THIS PLAN ANSWERED FOR — read only by a vetted carrier that carries it on, or
 * by a consumer that settles or escalates it. A raising relation read by anything else (a builder that
 * rebuilt its channels without it, a barrier nobody escalated) would DROP the raise and answer, which is
 * the one outcome this channel must never produce; the lowering declines instead.
 */
export function raiseContained(plan: Rel): boolean {
  if (pendingRaise(plan)) return false;
  const seen = new Set<Rel>();
  const stack = [plan];
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const ok = CONSUMERS.has(node) || (VETTED.has(node) && pendingRaise(node) !== undefined);
    for (const child of [...relChildren(node), ...subplans(node)]) {
      if (pendingRaise(child) && !ok) return false;
      stack.push(child);
    }
  }
  return true;
}

/**
 * DOES `FilterRankingStrategy` MOVE THE FILTER AT `steps[at]` — past a neighbour in its run of ranked
 * filters, either way?
 *
 * The reference does not run filters in the order they are written: the optimization bubbles each filter
 * ahead of a directly preceding filter of higher rank (`is` 1, `has` 2, `where(P)` 3, a traversal filter /
 * `not` 4, a scoped `where` 5, `or` 6, `and` 7, `where(P).by()` 8, `dedup` 9, `order` 10 — a parent takes
 * the highest rank among its children's steps), at every depth
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/FilterRankingStrategy.java`
 * `apply`, `getStepRank`, `getMaxStepRank`). Order among filters is invisible in the ANSWER — but not in
 * where a filter's RAISE is met: `g.V().where(values('age').toUpper().fold()).hasId(3)` is `[v[3]]`, the
 * `hasId` having run first. A caller lowering a filter that may raise asks this and DECLINES where the
 * reference reorders it, rather than raise on traversers the reference filtered out first (or answer
 * where it raised). Conservative: the strategy's label guard (no swap past a step reading the labels of
 * the one before) is not modelled, so a swap it would skip still counts.
 */
export function filterRankingMoves(steps: readonly IRStep[], at: number): boolean {
  const rank = (index: number): number => filterRank(steps[index]!);
  const own = rank(at);
  if (own === 0) return false;
  const labelled = (step: IRStep | undefined): boolean => step?.name === 'as' || step?.name === 'identity';
  for (let i = at - 1; i >= 0 && (labelled(steps[i]) || rank(i) > 0); i--) if (!labelled(steps[i]) && rank(i) > own) return true;
  for (let i = at + 1; i < steps.length && (labelled(steps[i]) || rank(i) > 0); i++) if (!labelled(steps[i]) && rank(i) < own) return true;
  return false;
}

const RANK_READER = rawBodies({});

/** `FilterRankingStrategy.getStepRank` over an IR step — 0 for anything it does not rank. */
function filterRank(step: IRStep): number {
  const own = baseFilterRank(step);
  if (own === 0) return 0;
  let max = own;
  eachChildChain(step as Step, RANK_READER, (chain) => { for (const child of chain) max = Math.max(max, filterRank(child as IRStep)); });
  return max;
}

function baseFilterRank(step: IRStep): number {
  switch (step.name) {
    case 'is': return 1;
    case 'has': case 'hasLabel': case 'hasId': case 'hasKey': case 'hasValue': return 2;
    case 'where': {
      const nested = step.args.find((a) => isNested(a.value))?.value as { readonly nested: unknown } | undefined;
      if (!nested) return step.modulators?.length ? 8 : 3;
      const body = RANK_READER(nested.nested);
      // `where(traversal)` is a `WhereTraversalStep` where its body starts or ends on a label, else a
      // `TraversalFilterStep` (`GraphTraversal.where(Traversal)`).
      return body && (body[0]?.name === 'as' || body[body.length - 1]?.name === 'as') ? 5 : 4;
    }
    case 'filter': case 'not': case 'hasNot': return 4;
    case 'or': return 6;
    case 'and': return 7;
    case 'dedup': return isLocalScope(step) ? 0 : 9;
    case 'order': return isLocalScope(step) ? 0 : 10;
    default: return 0;
  }
}

/** The filters a SLICE built (`sliceRows`) — a rank, a sample draw: each drops a row by its POSITION,
 *  which the slice's own extent rule (`pullExtent`, `settlesExactly`) already answers for. */
const POSITIONAL = new WeakSet<Rel>();

/** Register every filter between a slice's result `top` and its `input` as positional. */
export function markPositional(top: Rel, input: Rel): void {
  const seen = new Set<Rel>();
  const stack = [top];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === input || seen.has(node)) continue;
    seen.add(node);
    if (node.kind === 'filter') POSITIONAL.add(node);
    stack.push(...relChildren(node));
  }
}

/**
 * IS EVERY IN-STATEMENT RAISE EVALUATED WHEREVER THE REFERENCE MEETS IT, whatever order SQLite evaluates
 * the statement in — the finished-plan check beside `raiseContained`, and the decline when it fails.
 *
 * An eager raise is a FILTER whose predicate is a raise test (`raiseTest`, `src/rel/raise.ts`) — a receiver's offence
 * test, a carried test column, a pending raise's settle, a correlated body that raises — and it fires only
 * when SQLite EVALUATES that predicate on the row. SQL fixes no evaluation order inside a statement: the
 * flattener merges a filter into the block beneath it and splits the `WHERE` on `AND`, a term it finds
 * constant (a statically empty `within()`, a comparison over a one-row `VALUES`) is coded once before the
 * scan and a false one skips the scan outright, and the planner may run either side of a join as the outer
 * loop. So a filter that can DROP a row, above a raising one, may drop it before the raise is evaluated, and
 * the plan answers where the reference — which evaluates a step on each traverser BEFORE the step after it
 * sees it (`FilterStep.processNextStart`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/FilterStep.java`)
 * — raises: `g.inject(1).toUpper().is('x')` answered `[]`.
 *
 * The ONE place that order is fixed is where two filters become one `WHERE`: the emitter fuses a filter
 * over a raising one IN ORDER, as one `CASE` term (`conjoinInOrder`, `src/rel/emit.ts`), and renders a CTE
 * whose block holds a raise test `AS MATERIALIZED`, so SQLite cannot flatten it back into the query that
 * reads it. This check declines every plan that ordering cannot reach:
 * - a dropping filter over a raise test beneath an `explode` (the filter is tied to the member, so the row
 *   of an empty collection is never visited) or inside a union arm (a pushed-down term joins the arm's own
 *   `WHERE`, unordered);
 * - a filter whose predicate reads no column at all and is not plainly true (constant — a false one skips
 *   the whole scan) over ANYTHING that may raise, barriers included.
 * Not covered, and stated rather than hidden: an INNER JOIN above a raise test (the planner may run the
 * other side as the outer loop and never visit a raising row it has no match for) — declining it would
 * refuse every `where(<raising body>).values(k)`.
 *
 * Exact routes stay open. A raise riding as DATA (the pending channel, `poisonRows`) is no raise arm until
 * it is settled, and every filter it passes keeps a raising row (`keepingRaise`). A BARRIER block — an
 * aggregate, a window, a LIMIT subquery, a recursive term — is evaluated whole whenever it is read, so a
 * raise inside one has fired before anything above it drops a row of its output. A filter that cannot be
 * false (a raise test, a forced read) drops nothing, and a slice's POSITIONAL filters (`markPositional`)
 * drop by a position the slice's own extent rule answers for. A DEFERRAL (`deferralExpr`) belongs to the
 * read and is not counted. A `Binding` is another statement (a `ref`).
 */
export function raiseOrdered(plan: Rel): boolean {
  const below = new Map<Rel, boolean>();
  // Does the block `rel` heads — down to the barriers beneath it — hold a raise test?
  const raisesIn = (rel: Rel): boolean => {
    const known = below.get(rel);
    if (known !== undefined) return known;
    below.set(rel, false);
    const raises = !EVALUATION_BARRIERS.has(rel.kind) && (raiseTest(rel) || relChildren(rel).some(raisesIn));
    below.set(rel, raises);
    return raises;
  };
  // Is a raise test beneath a dropping filter out of the emitter's in-order reach? The emitter orders a
  // filter after every raise test FUSED beneath it in its block, whatever joins the block holds (a raise on
  // one SIDE of a join is the join rule's, below). An `explode` ties the filter above it to the member, so
  // an empty collection's row — and a raise on it — is never visited; a union arm takes a pushed-down term
  // of its own. A `Materialize` fuses into the block when it is not bound, and a bound one that raises is
  // rendered `AS MATERIALIZED` (`src/rel/emit.ts`), evaluated whole once read.
  const unordered = (rel: Rel): boolean => {
    switch (rel.kind) {
      case 'filter': case 'project': case 'sort': case 'distinct': case 'materialize': return unordered(rel.input);
      case 'join': return rel.join === 'semi' || rel.join === 'anti' ? unordered(rel.left) : unordered(rel.left) || unordered(rel.right);
      case 'explode': case 'union': return raisesIn(rel);
      default: return false;
    }
  };
  let ordered = true;
  forEachRel(plan, (rel) => {
    if (!ordered) return;
    const input = dropsRows(rel);
    if (input && (constantPredicate(rel) ? mayRaise(input) : unordered(input))) ordered = false;
  });
  return ordered;
}

const EVALUATION_BARRIERS: ReadonlySet<Rel['kind']> = new Set(['aggregate', 'window', 'limit', 'recursive']);

/** The input a node may DROP rows of by their values — a filter that can be false, or an `EXISTS`
 *  (semi/anti join) — or `null`. */
function dropsRows(rel: Rel): Rel | null {
  if (rel.kind === 'filter') return POSITIONAL.has(rel) || neverFalse(rel.pred) || plainlyTrue(rel.pred) ? null : rel.input;
  if (rel.kind === 'join' && (rel.join === 'semi' || rel.join === 'anti')) return rel.left;
  return null;
}

/** A dropping node whose condition reads NO column and is not plainly true — SQLite codes it once, before
 *  the scan, and a false one skips the scan beneath it outright. */
function constantPredicate(rel: Rel): boolean {
  if (rel.kind !== 'filter') return false;
  let reads = false;
  forEachExpr(rel.pred, (node) => { if (node.kind === 'col' || exprRels(node).length) reads = true; });
  return !reads && !plainlyTrue(rel.pred);
}

/** A constant the compiler spelled as TRUE — a truthy literal, or `lit = lit` of one value (an `is()` over
 *  a folded constant). Anything else that reads no column may be false. */
function plainlyTrue(e: Expr): boolean {
  if (e.kind === 'lit') return e.value === true || (typeof e.value === 'number' && e.value !== 0);
  if (e.kind === 'binary' && e.op === 'and') return plainlyTrue(e.left) && plainlyTrue(e.right);
  return e.kind === 'binary' && e.op === '=' && e.left.kind === 'lit' && e.right.kind === 'lit'
    && e.left.value !== null && e.left.value === e.right.value;
}

/** A predicate that is TRUE unless it raises — a conjunction of forced reads, `typeof(x) IS NOT 'raise'`
 *  (`typeof` never answers `'raise'`). It drops no row, so nothing beneath it is skipped. */
function neverFalse(pred: Expr): boolean {
  if (pred.kind === 'binary' && pred.op === 'and') return neverFalse(pred.left) && neverFalse(pred.right);
  // A RAISE TEST (`raisingWhen`, a settle): every arm raises, and otherwise the row passes.
  if (pred.kind === 'case') return pred.whens.every(([, then]) => exprMayRaise(then))
    && pred.else?.kind === 'lit' && (pred.else.value === 1 || pred.else.value === true);
  return pred.kind === 'binary' && pred.op === 'is not' && pred.left.kind === 'call' && pred.left.fn === 'typeof'
    && pred.right.kind === 'lit' && pred.right.value === 'raise';
}

/**
 * THE ONE AUTHORITY OVER AN IN-STATEMENT RAISE A STEP MINTED — whatever minted it: a receiver test, a
 * projector's (`math()`'s variable must be a Number), a list-local reducer's operand, a child value's
 * own raise evaluated per host row (a correlated subplan's, at any depth), a narrowing cast's overflow.
 * SQL evaluates such a raise on every row it reads, so it is exact only where the reference pulls every
 * row reaching that step (`settlesExactly` from the step itself — a DRAINING step pulls all it is handed,
 * so `order().by(<raising>)` is exact under a later `limit()`, and a `project().by(<raising>)` is not).
 * `false` is a DECLINE: the reference would answer where the plan raises.
 *
 * The nodes the step minted are those between `rel` and `pull.below`, where `pull` marks a step of THIS
 * list (a body's own list is a different array, and is checked by its own tail). A pending raise's SETTLE
 * (`settledSlice`/`settleRaise`, registered as consumers) is exempt — it is the exact answer by
 * construction — and a raise carried as DATA (`raiseMessage`) is no raise here at all.
 */
export function raisesWherePulled(pull: PullPosition | undefined, steps: readonly IRStep[], rel: Rel): boolean {
  if (!pull?.below || pull.steps !== steps || rel === pull.below || !mintedRaise(rel, pull.below)) return true;
  return settlesExactly(pull.steps, pull.at, { pull });
}

function mintedRaise(top: Rel, below: Rel): boolean {
  const seen = new Set<Rel>();
  const stack = [top];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === below || seen.has(node)) continue;
    seen.add(node);
    if (!CONSUMERS.has(node) && relExprs(node).some(exprMayRaise)) return true;
    stack.push(...relChildren(node));
  }
  return false;
}
