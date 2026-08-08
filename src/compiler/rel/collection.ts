import { col, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { argValues } from '../../gremlin/frontend.ts';
import type { Rel } from '../../rel/rel.ts';
import { typeCarriedBy, type ListOf } from '../../sql/kernel/render.ts';
import { isLocalScope } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { byField, isProductiveBy, modulations, productivityFilter } from './modulator.ts';
import { foldElements, foldScalars } from './list.ts';
import { carriedCols, typeOf, type Minter } from './build.ts';
import { framingCols, type RelFraming } from './framing.ts';
import type { Channel } from '../../channels.ts';

/**
 * NAMED COLLECTIONS — `aggregate("a")` fills one, `cap("a")` reads it back.
 *
 * Ranked FIRST by `mise run rel-blockers` (95 corpus traversals) once that instrument stopped
 * reading the `Arg` wrapper, and it needs no new node kind, no `Binding` and no executor change. The
 * reason is §3.0's: *a named CTE and a prior result are the same concept.* A collection is simply the
 * relation the traversal HELD at the point the side effect was written, folded into one list — and a
 * relation referenced from two places in the DAG is what the `name` pass already turns into a CTE.
 * So `aggregate` records a node and `cap` reads it; the sharing is the mechanism.
 *
 * ## Why the fold happens AT the aggregate rather than at the cap
 *
 * Because that is what "the value at this point" means. `aggregate` is a BARRIER: every traverser is
 * collected before any proceeds, so the collection is complete and `cap` — wherever it sits — reads
 * the whole of it. Folding at the aggregate site makes that a property of the plan; deferring it to
 * `cap` would mean re-deriving which relation was current N steps earlier, which is exactly the
 * "the query never exists as data" problem the whole migration is about.
 *
 * ## What declines, and why each is the honest answer
 *
 * - **a chain with a MUTATING step.** A shared read node is re-evaluated by every statement that
 *   names it, which is correct in a read program and a silent wrong answer in one with effects — the
 *   collection would see the graph AFTER the write. §3.0's answer is a `snapshot` binding, and that
 *   is the increment this one is a prerequisite for, not a shortcut it may take.
 * - **a label registered TWICE.** Two arms of a `union()` lower from the same input and would each
 *   register under the same name, so the second registration cannot be told from a re-aggregation
 *   into one collection. Failing closed there beats keeping whichever arm ran last.
 * - **`aggregate(Scope.local, "a")`** — TinkerPop 4's replacement for the lazy `store()`, which is
 *   non-blocking. Relationally that is the same SET at the end of the traversal and a DIFFERENT one
 *   read mid-traversal, so it is only safe once a mid-chain read exists to distinguish them.
 * - **a multi-label `cap("a","b")`**, which yields a MAP of collections rather than one list.
 */

/**
 * A registered collection: the relation, and WHAT IT HOLDS.
 *
 * `RelFraming` rather than a `ListOf`, because a named collection is not always a list. A
 * `group("a")` fills a MAP and `cap("a")` reads that map back, so the shape is whatever the step
 * that filled it produced — and carrying the framing is what makes `cap` shape-polymorphic for free:
 * it hands the pair to `continueAs`, the one dispatcher, and whichever tail owns that shape takes the
 * rest of the chain. Narrowing this to a list would have bought a second `cap` arm per shape.
 */
export interface Collection {
  readonly rel: Rel;
  readonly framing: RelFraming;
}

/** The registry a chain carries — MUTABLE, because a side effect is chain-global state written at one
 *  step and read at another, which is the one thing a fold's return value cannot carry backwards. */
export type Collections = Map<string, Collection>;

/** The label a `aggregate`/`cap` names, or `null` when the step is not the single-string form this
 *  module serves. Shared so the two sides cannot disagree about what counts as a name. */
function labelOf(step: IRStep): string | null {
  if (step.optionArms || isLocalScope(step)) return null;
  const args = argValues(step);
  return args.length === 1 && typeof args[0] === 'string' ? args[0] : null;
}

/**
 * `aggregate("a")` — register the collection and PASS THE TRAVERSERS THROUGH, or `null` to decline.
 *
 * The relation is unchanged: `AggregateGlobalStep` emits everything it collected, so this is a
 * shape-preserving step of whichever loop called it. What it returns is the registration having
 * happened, which is why the caller `continue`s on `true` rather than rebinding its relation.
 *
 * The `by()` decides what a MEMBER is, and it is `byField` that answers rather than `byExpr`: the
 * question is what the projection IS, and `byExpr` collapses it to one comparable value on purpose.
 * With no `by()` the member is the traverser itself — the element for an element stream, the value
 * for a scalar one — which is `AggregateGlobalStep`'s default.
 *
 * PRODUCTIVITY is the by() vocabulary's, unchanged: a traverser whose `by()` yields nothing
 * contributes NO member (`TraversalUtil.produce` again), and `ProductiveByStrategy` turns that off.
 */
export function registerCollection(
  step: IRStep, input: Rel, host: ChildHost, framing: RelFraming, collections: Collections,
  reducers: ReadonlySet<string>, child: ChildSeam, fresh: Minter,
): boolean {
  const label = labelOf(step);
  if (label === null || collections.has(label)) return false;
  // A `withSideEffect(name, seed, Operator.x)` collection is NOT empty when the traversal starts and
  // is not merged by concatenation either: the declaration supplies an initial value and the operator
  // says how each contribution combines with it. Registering here would silently drop both and answer
  // a plausible list — the one thing the decline contract exists to prevent. Same shape of gap as
  // `withSack(seed, Operator.x)`, and the same answer: a merge POLICY, not a step.
  //
  // `reducers` is a separate set from the constant registry, and it has to be: the front end skips
  // the reducer form when building that registry (its value is not a constant to substitute), so
  // before `sideEffectReducers` existed this decline was not expressible at all — the label read as
  // fresh. A fact the front end drops is one no lowering can decline on.
  if (reducers.has(label)) return false;
  const bys = modulations(step, 1, child);
  if (!bys) return false;
  const encounter = input.channels.find((channel) => channel.role === 'encounter');
  const collected = bys[0]
    ? foldProjection(step, input, host, framing, bys[0], encounter, child, fresh)
    : foldTraversers(input, framing, encounter, fresh);
  if (!collected) return false;
  collections.set(label, collected);
  return true;
}

/**
 * `group("a")`/`groupCount("a")` — register the MAP a grouping barrier built, or `false` to decline.
 *
 * The keyed form of these two is a SIDE EFFECT and not a barrier result: `GroupSideEffectStep` fills
 * the named map and passes its incoming traversers on, which is `aggregate`'s contract exactly. So
 * the only thing that differs from `registerCollection` is WHO built the relation — the caller has
 * already run `groupBarrier`, because deciding a grouping is the map shape's job and not this
 * module's. What is shared is the registry discipline: the same label rules, the same refusals.
 */
export function registerMap(
  step: IRStep, built: { readonly rel: Rel; readonly framing: RelFraming }, collections: Collections,
  reducers: ReadonlySet<string>,
): boolean {
  const label = labelOf(step);
  if (label === null || collections.has(label) || reducers.has(label)) return false;
  collections.set(label, built);
  return true;
}

/** The BARE `aggregate("a")` — the traversers themselves, folded by whichever fold their shape has. */
function foldTraversers(
  input: Rel, framing: RelFraming, encounter: Channel | undefined, fresh: Minter,
): Collection | null {
  const at = encounter ? { encounter: encounter.col } : {};
  if (framing.kind === 'elements') return listed(foldElements(input, framing.elem, at, fresh));
  if (framing.kind !== 'scalar') return null;
  return listed(foldScalars(input, { type: framing.type, ...at }, fresh));
}

/** A fold's `{rel, of}` as a `Collection`. One place, so the two folds cannot describe themselves
 *  differently. */
const listed = (folded: { readonly rel: Rel; readonly of: ListOf }): Collection =>
  ({ rel: folded.rel, framing: { kind: 'list', of: folded.of } });

/**
 * `aggregate("a").by(<projection>)` — the projection's value per traverser, folded.
 *
 * A projected collection is always a SCALAR one, whatever the host was: `by("age")` over vertices
 * collects ages. The one exception the vocabulary can express — an alias `by(__.select('v'))` whose
 * label holds an ELEMENT — declines rather than collecting a rowid it has no framing arm for here.
 */
function foldProjection(
  step: IRStep, input: Rel, host: ChildHost, framing: RelFraming,
  modulation: import('./modulator.ts').Modulation, encounter: Channel | undefined,
  child: ChildSeam, fresh: Minter,
): Collection | null {
  const field = byField(step, modulation, host, framing, (name) => col(input.id, name), fresh, child);
  if (!field || field.framing.kind !== 'scalar') return null;
  // A numeric reducer's type is the aggregate's runtime `typeof` in `vt`, which `byField` already
  // declines to supply rather than recomputing the aggregate; every other scalar `by()` declares `v`
  // and, where its type rides in a column, that column too.
  const cols = framingCols(field.framing);
  if (!cols || !field.exprs.some(([name]) => name === 'v')) return null;
  const projections = cols.map((column) => {
    const expr = field.exprs.find(([name]) => name === column.name)?.[1];
    return expr ? ([column.name, expr] as const) : null;
  });
  if (projections.some((projection) => projection === null)) return null;
  const carried = encounter ? [encounter] : [];
  // THE TYPE COLUMN IS PROJECTED WITH THE VALUE, which is the whole of what used to be missing. This
  // projection declared `v` alone, so a `by('age')`'s per-row type had nowhere to ride and degraded
  // to `unknown` — every projected collection folded BARE, and a `by('uuid')` collection framed its
  // members as Strings. `framingCols` is the authority on which columns a framing owes, so asking it
  // rather than naming `v` is also what makes the child-body and property arms carry their tags for
  // free.
  const projected = make.project({
    id: fresh('ag'), input, channels: carried,
    type: typeOf(...cols, ...carriedCols(carried)),
    exprs: [...projections as readonly (readonly [string, Expr])[],
      ...carried.map((channel) => [channel.col, col(input.id, channel.col)] as const)],
  });
  // An unproductive projection contributes no member — the same rule every other by() host spends,
  // asked through the same function so `ProductiveByStrategy` turns it off here too.
  const drop = productivityFilter(step, col(projected.id, 'v'));
  const rows = drop
    ? make.filter({ id: fresh('af'), input: projected, channels: carried, type: projected.type, pred: drop })
    : projected;
  // **`productiveNull` rides with the type.** Under `ProductiveByStrategy` nothing is dropped, so an
  // unproductive projection leaves an explicit NULL member — and a local reducer over an all-null
  // collection must then emit that NULL as a REAL result rather than being read as "no result".
  // These two travelling together is exactly what the old vocabulary could not express: `typed` was a
  // CONSTANT `ListOf`, so claiming the type DROPPED this flag, and the resulting "a typed list of
  // nulls emits nothing where a bare one emits null" got recorded as an open question about
  // `MaxLocalStep`. It was never that; it was one field falling out of a constant.
  return listed(foldScalars(rows, {
    type: typeCarriedBy(field.framing.type, (column) => cols.some((declared) => declared.name === column)),
    ...(isProductiveBy(step) ? { productiveNull: true } : {}),
    ...(encounter ? { encounter: encounter.col } : {}),
  }, fresh));
}

/**
 * `cap("a")` — the collection as ONE list traverser, or `null` to decline.
 *
 * A cap emits a single fresh traverser, so the relation it hands back carries NO channels: the
 * folded list already has none, which is the same thing legacy spells as `dropLayoutAtBarrier`.
 * Everything after it is the ordinary list tail — `unfold()`, `count(local)`, a local reducer, a
 * member op — with nothing to know about side effects.
 *
 * A collection NOTHING reached needs no arm here: both folds `COALESCE` an empty aggregate to `[]`,
 * so `cap()` over it is an EMPTY list — which is what the reference's `BulkSet` seed supplies.
 */
export function readCollection(step: IRStep, collections: Collections): Collection | null {
  if (step.modulators?.length) return null;
  const label = labelOf(step);
  return label === null ? null : collections.get(label) ?? null;
}
