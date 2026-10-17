import { withChannel, type Channel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { raiseCarried } from '../../rel/raise.ts';
import type { Rel } from '../../rel/rel.ts';
import type { RelId } from '../../rel/types.ts';
import { exprRels, forEachExpr, relChildren, relExprs } from '../../rel/walk.ts';
import { meta, typeOf, type Minter } from './build.ts';
import { isLocalScope, sliceOf, type IRStep } from '../ir/step.ts';
import { isScopeArg } from '../../gremlin/frontend.ts';

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
 * run of filters that keep a raising row, to the step that consumes it. Every other position settles at
 * the source, which is what it did before — exact wherever every row is pulled. `raiseContained` checks
 * the finished plan: a raising relation read by anything other than a vetted carrier or a consumer
 * declines, so a raise a builder dropped on the way can never become an answer.
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

/** Is `step` a HEAD slice — `limit(n)`/`range(0, n)` over the stream — the one consumer that keeps exactly
 *  the rows the reference pulls (`RangeGlobalStep` with `low = 0` pulls `high` traversers and stops). A
 *  `skip`/`range(lo>0, …)` pulls the rows it discards, and `tail`/`sample` drain everything. */
export function headSliceStep(step: IRStep | undefined): boolean {
  if (!step || (step.name !== 'limit' && step.name !== 'range')) return false;
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return false;
  // A PARAMETER bound stays a bind (root CLAUDE.md: a bind serves a user parameter); the widened bound
  // `pulledBy` needs would be a constant beside it, so a parameterized slice keeps the eager settle.
  if (step.args.some((a) => a.name != null)) return false;
  try {
    const slice = sliceOf(step);
    return slice.offset === 0 && slice.limit !== null;
  } catch { return false; }
}

/**
 * THE SLICE THAT PULLS what a head slice's consumer makes the reference evaluate — ONE traverser past the
 * bound. `RangeGlobalStep` tests its bound inside `filter`, AFTER `FilterStep.processNextStart` has pulled
 * the next start (`if (this.high != -1 && counter.get() >= this.high) throw FastNoSuchElementException`),
 * so the `hasNext()` that follows the `high`-th result drags one more traverser through every step before
 * the slice (`g.V().union(values('name'), values('age')).toUpper().limit(1)` raises on marko's age, the
 * second traverser). The raise is settled over THESE rows; the slice proper is taken after it.
 */
export function pulledBy(step: IRStep): IRStep {
  const { offset, limit } = sliceOf(step);
  // `limit(n)`'s count and `range(0, n)`'s high are each the LAST numeric argument.
  const at = step.args.map((a) => !isScopeArg(a.value)).lastIndexOf(true);
  return { ...step, args: step.args.map((a, i) => (i === at ? { ...a, value: offset + limit! + 1 } : a)) };
}

/**
 * MAY A RAISE BORN AT `steps[at - 1]` RIDE TO `steps[at]` — the ONE deferral rule every source asks.
 *
 * Yes where a step CONSUMES it exactly: a head slice (`sliceOp` settles it over the rows it pulls), or —
 * inside a child body whose host asked for its raise as data (`ChainCtx.raiseEscalates`, the body's own
 * step list BY IDENTITY, so no nested or rewritten list inherits it) — the body's terminal reducing barrier,
 * which `escalatedRaise` turns into the child value's `raise`. A run of FILTER steps may stand between
 * (`passesRaise`): `FilterStep` hands a traverser on or drops it, and a raising traverser never reached
 * the filter in the reference, so the filter keeps it (`hostFilter`). Anywhere else the source settles
 * immediately.
 */
export function defersRaise(steps: readonly IRStep[], at: number, escalates: readonly IRStep[] | undefined, collapses: (name: string) => boolean): boolean {
  let next = at;
  while (passesRaise(steps[next])) next++;
  const consumer = steps[next];
  if (headSliceStep(consumer)) return true;
  return escalates === steps && next === steps.length - 1 && consumer !== undefined && collapses(consumer.name);
}

/**
 * IS AN EAGER SETTLE AT `steps[at - 1]` EXACT — does the reference pull EVERY row the source sees? Yes
 * where a DRAINING step comes before any bounded slice (a `CollectingBarrierStep`/`ReducingBarrierStep`
 * drains every start before it emits, `step/util/CollectingBarrierStep.java`), or where nothing bounded
 * follows at all (the root drains to the end). A bounded slice after only streaming steps
 * (`dedup()`, a movement, a map) stops pulling where the reference would, so a raise SQL evaluates on
 * every row would be an error the reference never meets — the caller DECLINES rather than over-raise.
 */
export function settlesExactly(steps: readonly IRStep[], at: number): boolean {
  for (let next = at; next < steps.length; next++) {
    const step = steps[next]!;
    if (DRAINING.has(step.name) && !isLocalScope(step)) return true;
    if ((step.name === 'limit' || step.name === 'range') && !isLocalScope(step)) {
      try { if (sliceOf(step).limit !== null) return false; } catch { return false; }
    }
  }
  return true;
}

/** The steps that pull EVERY start before they emit — the collecting and reducing barriers. */
const DRAINING: ReadonlySet<string> = new Set([
  'order', 'barrier', 'aggregate', 'sample', 'tail', 'fold', 'count', 'sum', 'min', 'max', 'mean',
  'group', 'groupCount', 'tree', 'cap', 'subgraph',
]);

/** The filter steps a pending raise rides THROUGH — each lowered by `hostFilter`, which keeps a raising row.
 *  A form some other route lowers (an alias-compare `where`) is refused at the end by `raiseContained`. */
const FILTER_HOSTS: ReadonlySet<string> = new Set(['where', 'filter', 'not', 'and', 'or', 'has', 'hasLabel', 'hasId', 'hasKey', 'hasValue', 'hasNot']);
const passesRaise = (step: IRStep | undefined): boolean =>
  step !== undefined && FILTER_HOSTS.has(step.name) && !step.modulators?.length && !step.optionArms;

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
