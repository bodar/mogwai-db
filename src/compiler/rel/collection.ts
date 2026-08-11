import { col, compilerInt, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import { argValues, type MergePolicy } from '../../gremlin/frontend.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Binding } from '../../rel/plan.ts';
import { meetScalarTypes, perRowCols, sameScalarType, STATIC, typeCarriedBy, UNKNOWN, type ListOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { isLocalScope } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { byField, isProductiveBy, modulations, productivityFilter } from './modulator.ts';
import { foldElements, foldScalars } from './list.ts';
import { carriedCols, eq, meta, typeOf, withMergedVtype, type Minter } from './build.ts';
import { framingCols, type FramedRel, type RelFraming } from './framing.ts';
import { BULK_OPS, FOLD_OPS, isLogicalOp, mergeStep } from './operator.ts';
import { constLit } from './const.ts';
import type { Channel } from '../../channels.ts';

/**
 * NAMED COLLECTIONS — `aggregate("a")` RETAINS a relation under a name, `cap("a")` REDUCES it.
 *
 * It needs no new node kind, no `Binding` and no executor change, for §3.0's reason: *a named CTE and
 * a prior result are the same concept.* A collection is the relation the traversal held at the point
 * the side effect was written, and a relation referenced from two places in the DAG is what the
 * `name` pass already turns into a CTE. So `aggregate` records a node and `cap` reads it; the sharing
 * is the mechanism.
 *
 * ## Why the reduction happens at the CAP and not at the aggregate
 *
 * Because that is where the reference puts it — `SideEffectCapStep.generateFinalResult`
 * (`vendor/tinkerpop/gremlin-core/.../step/sideEffect/SideEffectCapStep.java:96-105`). `aggregate` is
 * a barrier, so the collection IS complete by the time anything reads it; what the barrier decides is
 * WHEN, not WHAT, and folding at the write site confuses the two.
 *
 * This module used to fold at the aggregate and store the folded list, and argued for it at length.
 * That argument is sound **for one site** and does not survive a second: a label filled at two chain
 * positions is then N-1 list concatenations, each re-exploding JSON, instead of a `UNION ALL` of
 * member relations — the algebra's own node. Holding MEMBER ROWS also puts `withLossyFlag`'s
 * whole-relation question (`list.ts:769-789`) over every site's members rather than per site, which
 * is the difference between one member encoding and an inconsistent one, and makes `cap().unfold()`
 * cancel rather than fold-then-explode. Full rationale + phases:
 * `docs/2026-08-09-named-collections-are-bindings-plan.md`.
 *
 * ## What declines, and why each is the honest answer
 *
 * (A chain with a MUTATING step and a label registered TWICE both used to be here. Neither is a
 * decline any more: the sites are a list unioned at the read, and in a program with effects each is
 * a `snapshot` binding — see `snapshotted`.)
 *
 * - **`aggregate(Scope.local, "a")`** — TinkerPop 4's replacement for the lazy `store()`, which is
 *   non-blocking. Relationally that is the same SET at the end of the traversal and a DIFFERENT one
 *   read mid-traversal, so it is only safe once a mid-chain read exists to distinguish them.
 * - **a multi-label `cap("a","b")`**, which yields a MAP of collections rather than one list.
 * - **the BULK merge operators `addAll`/`assign`**, which fold a site's whole member SET rather than
 *   one member at a time (`AggregateStep.java:131-151`). `addAll` wants the seed's items as a site
 *   BEFORE every registration site; `assign` additionally distinguishes a global barrier from a
 *   `local(aggregate(…))` one, which the IR splice erases. Both are member-relation questions, not
 *   fold-expression ones — see `seededFold`. Every other `Operator` folds (`operator.ts`).
 */

/**
 * A NAMED COLLECTION — the rows the traversal RETAINED under a name, and what one of them IS.
 *
 * Not a value: a site's `rel` is one row per contributed traverser, unfolded, and the reduction is
 * `reduce()`'s at the read. That split is what lets N registration SITES be a list here and a
 * `UNION ALL` at the read, instead of N-1 list concatenations each re-exploding JSON.
 *
 * **`sites` is a LIST, in chain order, and that order is load-bearing.** The reference drains one
 * site's traversers into a `BulkSet` in encounter order and then `addAll`s that whole set into the
 * collection (`AggregateStep.java:124-153`, `Operator.java:178-196`), so the members of site 1
 * precede the members of site 2. Keeping the sites apart until the read is what makes that
 * expressible — a single pre-merged relation has already lost which rows came from where.
 */
export interface Collection {
  readonly sites: readonly Site[];
  readonly of: Members;
  /**
   * HOW THE MEMBERS COMBINE, when the traversal DECLARED it — `withSideEffect(k, seed, Operator.x)`.
   *
   * A separate field from `Members` and not a `Members` arm, because the two answer different halves
   * of one reduction: `of` says what a member IS (which decides the encoding and the framing), and
   * this says how members FOLD INTO A SEED (which decides whether the answer is a list or a scalar).
   * `undefined` is the default policy every `aggregate("a")` registers on its own —
   * `(BulkSetSupplier, Operator.addAll)` over an empty seed (`AggregateStep.java:57`) — which is the
   * plain list fold and needs no object to say so.
   */
  readonly merge: MergePolicy | undefined;
}

/**
 * ONE REGISTRATION SITE's contribution — its member rows and the columns that order them.
 *
 * The order is a property of the SITE and not of what a member is: two sites are two positions in the
 * chain, each with its own emission order, and those orders are not comparable. Hoisting it onto
 * `Members` would have made it look like one fact when it is N.
 *
 * `order` is a COLUMN LIST rather than one encounter channel because the accumulation of N sites is
 * itself a site, and its order is two columns (the site ordinal, then that site's encounter). Same
 * list the folds take.
 */
export interface Site {
  readonly rel: Rel;
  readonly order: readonly string[];
}

/**
 * WHAT ONE MEMBER IS — and therefore which reduction `cap()` runs and what framing it hands on.
 *
 * A TOTAL union, per the `ScalarType` template (`docs/2026-07-28-scalartype-refactoring-pattern.md`):
 * every field an arm needs is declared on that arm, `| undefined` rather than optional, so a new
 * member kind cannot be added without answering the reduction's questions. The two fold-parameter
 * arms carry exactly what `foldElements`/`foldScalars` ask for, which is the point — `reduce()` is a
 * dispatch, not a second place that decides encodings.
 */
export type Members =
  /** An ELEMENT stream's traversers; the member is the rowid and `unfoldList` casts it back. */
  | { readonly kind: 'elements'; readonly elem: Elem }
  /** A VALUE stream's traversers, or a `by()` projection's values; the member is the row's `v`. */
  | { readonly kind: 'scalars'; readonly type: ScalarType; readonly productiveNull: boolean }
  /**
   * ALREADY REDUCED by whoever registered it — `group("a")`/`groupCount("a")`, whose map a grouping
   * barrier built before this module ever saw it. The arm is a transitional one: Phase 4 gives the
   * keyed forms member rows too (a `(key, value-contribution)` pair reduced by `groupBarrier` at the
   * cap), at which point `registerMap` and this arm disappear together. It exists rather than a
   * `reduce?:` optional because a partly-total descriptor is the failure mode the totality invariant
   * was earned against.
   */
  | { readonly kind: 'reduced'; readonly framing: RelFraming };

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
 * `aggregate("a")` — RETAIN the member rows under the label and PASS THE TRAVERSERS THROUGH, or
 * `false` to decline.
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
 * **THE `by()` PROJECTION STAYS HERE; only the FOLD moved to the read.** It has to: `by(__.outE(
 * "created").count())` is correlated to the traverser that is at this position NOW, so evaluating it
 * at the cap would score it against a different relation entirely.
 *
 * PRODUCTIVITY is the by() vocabulary's, unchanged: a traverser whose `by()` yields nothing
 * contributes NO member (`TraversalUtil.produce` again), and `ProductiveByStrategy` turns that off.
 *
 * **IN A PROGRAM WITH EFFECTS THE SITE IS SNAPSHOTTED**, and the bindings come back so the caller can
 * put them in the chain's effect sequence AT THIS POSITION — see `snapshotted`. A `null` return is
 * the decline; an EMPTY array is a registration that needed no binding, which is every read program.
 */
export function registerCollection(
  step: IRStep, input: Rel, host: ChildHost, framing: RelFraming, collections: Collections,
  reducers: ReadonlyMap<string, MergePolicy>, child: ChildSeam, fresh: Minter, mutating: boolean,
): readonly Binding[] | null {
  const label = labelOf(step);
  if (label === null) return null;
  // A `withSideEffect(name, seed, Operator.x)` collection is NOT empty when the traversal starts and
  // is not merged by concatenation either: the declaration supplies an initial value and the operator
  // says how each contribution combines with it. Both facts travel on the policy and are spent at the
  // READ, which is where the reference spends them too — so the registration's only business with
  // them is to carry them and to refuse an operator this route cannot yet fold. The BULK pair
  // (`addAll`/`assign`) is that refusal: it merges a site's whole member SET rather than one member at
  // a time (`AggregateStep.java:131-151`), which is a question about the member relation and not about
  // this expression.
  //
  // `reducers` is a separate map from the constant registry, and it has to be: the front end skips
  // the reducer form when building that registry (its value is not a constant to substitute), so
  // before `sideEffectReducers` existed this fact was not visible at all — the label read as fresh.
  // A fact the front end drops is one no lowering can either fold or decline on.
  const merge = reducers.get(label);
  if (merge && !(merge.operator !== undefined && FOLD_OPS.has(merge.operator))) return null;
  const bys = modulations(step, 1, child);
  if (!bys) return null;
  const encounter = input.channels.find((channel) => channel.role === 'encounter');
  const built = bys[0]
    ? projectedMembers(step, input, host, framing, bys[0], encounter, child, fresh)
    : traverserMembers(input, framing, encounter);
  if (!built) return null;
  const policied = { ...built, merge };
  const { collection: retained, bindings } = mutating ? snapshotted(policied, fresh) : { collection: policied, bindings: [] };
  const held = collections.get(label);
  if (!held) { collections.set(label, retained); return bindings; }
  const accumulated = accumulate(held, retained, fresh);
  if (!accumulated) return null;
  collections.set(label, accumulated);
  return bindings;
}

/**
 * THE SITE'S ROWS, TAKEN — a `snapshot` binding plus a `Ref` to it, which is what makes a named
 * collection legal in a program with effects.
 *
 * A CTE is re-evaluated by every statement that names it: correct in a read program, a silent wrong
 * answer in one with effects, because the collection would then see the graph AFTER the write. That
 * is §3.0's answer and it is already built — `write.ts` produces exactly this shape and `runProgram`
 * already retains it — so the four `if (ctx.mutating) return null` declines were a placeholder for
 * machinery that had shipped.
 *
 * ⚠️ **The site is NARROWED to its member columns before it is bound, and that is not tidiness.** A
 * retained binding's rows cross the executor seam as JSON (`src/program.ts`), which fails closed on
 * what it cannot carry — and an element site's raw relation carries the alias channel as JSONB. The
 * members are what the collection is FOR, so binding them rather than the whole traverser row is both
 * the smaller statement and the one whose columns can travel.
 */
function snapshotted(
  collection: Collection, fresh: Minter,
): { readonly collection: Collection; readonly bindings: readonly Binding[] } {
  const cols = [...memberCols(collection.of), ...collection.sites[0]!.order];
  const bindings: Binding[] = [];
  const sites = collection.sites.map((site) => {
    const narrowed = make.project({
      id: fresh('cs'), input: site.rel, channels: [],
      type: typeOf(...cols.map((name) => site.rel.type.cols.find((column) => column.name === name) ?? meta(name, 'any'))),
      exprs: cols.map((name) => [name, col(site.rel.id, name)] as const),
    });
    const name = fresh('agg');
    bindings.push({ name, node: narrowed, snapshot: true });
    return { ...site, rel: make.ref({ id: fresh('r'), name, channels: [], type: narrowed.type }) };
  });
  return { collection: { ...collection, sites }, bindings };
}

/**
 * A SECOND SITE ACCUMULATES — side effects live on the ROOT traversal (`AggregateStep.java:57`
 * resolves through `this.getTraversal().getSideEffects()`), so a label filled at two chain positions
 * holds both sites' members.
 *
 * What the sites must AGREE on is what a member IS, because the reduction is one fold and has one
 * answer to give. Two SCALAR sites whose types differ do not disagree about that — a tag
 * disagreement is not a shape disagreement — so they MEET, exactly as two branch arms do and through
 * the same pair (`meetScalarTypes` + `withMergedVtype`). Anything else declines; a union of member
 * SHAPES is the dynamic-tag variant's question, one level down at the member encoding, and is not
 * this module's to invent.
 */
function accumulate(held: Collection, added: Collection, fresh: Minter): Collection | null {
  const sites = [...held.sites, ...added.sites];
  // The POLICY is the LABEL's, not the site's — one `withSideEffect` declaration, however many
  // registration positions read it — so it is carried rather than merged, and the two sides cannot
  // disagree about it by construction.
  const merge = held.merge;
  if (held.of.kind === 'elements' && added.of.kind === 'elements')
    return held.of.elem === added.of.elem ? { sites, of: held.of, merge } : null;
  if (held.of.kind !== 'scalars' || added.of.kind !== 'scalars') return null;
  // `productiveNull` is orthogonal to the type and says whether a NULL member is a REAL value or the
  // framer's signal to emit nothing. Two sites that answer it differently are two different member
  // encodings, and picking either would silently change one site's answer.
  if (held.of.productiveNull !== added.of.productiveNull) return null;
  const type = meetScalarTypes([held.of.type, added.of.type]);
  return {
    sites: [...honouring(held.sites, held.of.type, type, fresh), ...honouring(added.sites, added.of.type, type, fresh)],
    of: { kind: 'scalars', type, productiveNull: held.of.productiveNull },
    merge,
  };
}

/** Sites re-projected so they can be read as the MET type — a no-op where `from` already IS the meet,
 *  which is the common case and the one that must cost no node. */
const honouring = (sites: readonly Site[], from: ScalarType, to: ScalarType, fresh: Minter): readonly Site[] =>
  sameScalarType(from, to) ? sites : sites.map((site) => ({ ...site, rel: withMergedVtype(site.rel, from, fresh) }));

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
  step: IRStep, built: FramedRel, collections: Collections,
  reducers: ReadonlyMap<string, MergePolicy>,
): boolean {
  const label = labelOf(step);
  if (label === null || collections.has(label) || reducers.has(label)) return false;
  collections.set(label, {
    sites: [{ rel: built.rel, order: [] }],
    of: { kind: 'reduced', framing: built.framing },
    merge: undefined,
  });
  return true;
}

/** A site's member order: the encounter channel where the stream carries one, and nothing where it
 *  does not — the same "incidental row order" a `fold()` accepts on the same terms. */
const orderOf = (encounter: Channel | undefined): readonly string[] => encounter ? [encounter.col] : [];

/** The BARE `aggregate("a")` — the traversers themselves are the members, in whichever shape the
 *  stream already had. */
function traverserMembers(
  input: Rel, framing: RelFraming, encounter: Channel | undefined,
): Collection | null {
  const sites = [{ rel: input, order: orderOf(encounter) }];
  if (framing.kind === 'elements') return { sites, of: { kind: 'elements', elem: framing.elem }, merge: undefined };
  if (framing.kind !== 'scalar') return null;
  return { sites, of: { kind: 'scalars', type: framing.type, productiveNull: false }, merge: undefined };
}

/**
 * `aggregate("a").by(<projection>)` — the projection's value per traverser, as the member rows.
 *
 * A projected collection is always a SCALAR one, whatever the host was: `by("age")` over vertices
 * collects ages. The one exception the vocabulary can express — an alias `by(__.select('v'))` whose
 * label holds an ELEMENT — declines rather than collecting a rowid it has no framing arm for here.
 */
function projectedMembers(
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
  return {
    sites: [{ rel: rows, order: orderOf(encounter) }],
    of: {
      kind: 'scalars',
      type: typeCarriedBy(field.framing.type, (column) => cols.some((declared) => declared.name === column)),
      productiveNull: isProductiveBy(step),
    },
    merge: undefined,
  };
}

/**
 * THE REDUCTION — a collection's retained rows as the ONE traverser `cap("a")` emits.
 *
 * The one place a named collection's fold is chosen, off `Members`, instead of three call sites
 * inside two register functions. `withLossyFlag`'s whole-relation question therefore runs over every
 * site's members at once, which is what makes the member encoding uniform (`list.ts:769-789`).
 *
 * A cap emits a single fresh traverser, so what comes back carries NO channels: both folds are
 * `Aggregate`s with `channels: []`, which is the same thing legacy spells as `dropLayoutAtBarrier`.
 * Everything after it is the ordinary list tail — `unfold()`, `count(local)`, a local reducer, a
 * member op — with nothing to know about side effects.
 *
 * A collection NOTHING reached needs no arm: both folds `COALESCE` an empty aggregate to `[]`, so
 * `cap()` over it is an EMPTY list — which is what the reference's `BulkSet` seed supplies.
 */
export function reduce({ sites, of, merge }: Collection, fresh: Minter): FramedRel | null {
  if (of.kind === 'reduced') return { rel: sites[0]!.rel, framing: of.framing };
  const { rel, order } = sites.length === 1 ? sites[0]! : accumulated(sites, memberCols(of), fresh);
  // A DECLARED merge policy replaces the fold outright: the members combine into the seed by the
  // operator, and for everything but the BULK pair that is a SCALAR rather than a list.
  if (merge) return seededFold(rel, order, of, merge, fresh);
  if (of.kind === 'elements') return listed(foldElements(rel, of.elem, { order }, fresh));
  return listed(foldScalars(rel, { type: of.type, productiveNull: of.productiveNull, order }, fresh));
}

/** The walk's two columns: the member ordinal reached so far, and the accumulator. Named apart from
 *  the member relation's own `v`/order columns so the recursive term's join declares no duplicate. */
const FOLD_POS = 'fo';
const FOLD_ACC = 'fa';
/** The member relation's columns as the term reads them — its value, and its position in the order. */
const MEMBER_VAL = 'mv';
const MEMBER_ORD = 'mo';

/**
 * THE SEEDED LEFT FOLD — `withSideEffect(k, seed, Operator.x)`'s reduction, as a `Recursive` walk over
 * the ordered member relation. `null` declines.
 *
 * `sideEffects.add(k, v)` is `set(k, getReducer(k).apply(get(k), v))`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/DefaultTraversalSideEffects.java:88-91`)
 * — a LEFT FOLD over the members in order, seeded by the declared supplier. That is a walk, not an
 * aggregate: see `operator.ts` for why picking nine SQL aggregates instead would answer two of them
 * wrongly. The order is the one Phase 2 already pinned (the site ordinal, then that site's encounter),
 * so nothing new decides it.
 *
 * **Only ONE node here is the walk, and the ordinal comes from OUTSIDE it.** A recursive term may hold
 * no window function (`recursive.ts`, `BARRIER_IN_TERM`), so the `ROW_NUMBER` that turns "the members
 * in order" into "the member at position n" is computed on the member relation and JOINED in — which
 * is legal precisely because the join opens a nested SELECT for it (`block.ts`: the barrier laws stop
 * at every nested SELECT, measured).
 *
 * **A collection NOTHING reached still answers the SEED**, and it falls out rather than needing an arm:
 * the walk's seed row is `(0, seed)` and no member joins to it, so the last row IS the seed — which is
 * `get(k)` over a side effect nothing added to, exactly.
 */
function seededFold(
  members: Rel, order: readonly string[], of: Members, policy: MergePolicy, fresh: Minter,
): FramedRel | null {
  const operator = policy.operator;
  // The BULK pair is named rather than falling into the generic decline, because the two refusals are
  // different facts: `addAll`/`assign` are a member-relation question this route has not built, and
  // anything else is not an `Operator` this fold spells at all.
  if (operator === undefined || BULK_OPS.has(operator) || !FOLD_OPS.has(operator)) return null;
  // `NumberHelper`/`Operator` act on a VALUE (`(Number) a`, `(boolean) a`), so an element-membered
  // collection folded by an arithmetic operator is a ClassCastException in the reference and a decline
  // here. A `reduced` member is a map a grouping barrier already built — a different reduction.
  if (of.kind !== 'scalars') return null;
  const seed = constLit(policy.seed);
  // A COLLECTION seed has no scalar literal form, which is `constLit`'s own answer — and it is only
  // ever legal for the BULK pair, already refused above.
  if (!seed) return null;

  const keys = order.map((_, i) => `k${i}`);
  const keyCols = keys.map((key) => meta(key, 'any', true));
  // The members, narrowed to what the fold reads. Narrowing is the same move `accumulated` makes and
  // for the same reason: past this point a row is a member, and the walk's join must declare no column
  // name twice.
  const narrowed = make.project({
    id: fresh('sn'), input: members, channels: [], type: typeOf(meta(MEMBER_VAL, 'any', true), ...keyCols),
    exprs: [[MEMBER_VAL, col(members.id, 'v')],
      ...order.map((name, i) => [keys[i]!, col(members.id, name)] as const)],
  });
  // A member's POSITION in the fold. `ROW_NUMBER` over no order terms is well-defined and arbitrary,
  // which is the same licence `foldScalars` takes over a site with no encounter channel: the reference
  // pins no order on a capped collection at all.
  const numbered = make.window({
    id: fresh('sw'), input: narrowed, channels: [],
    type: typeOf(meta(MEMBER_VAL, 'any', true), ...keyCols, meta(MEMBER_ORD, 'int')),
    specs: [[MEMBER_ORD, {
      kind: 'window-expr', fn: 'row_number', args: [],
      spec: { partitionBy: [], orderBy: keys.map((key) => ({ expr: col(narrowed.id, key), dir: 'asc' as const })) },
    }]],
  });

  const walkType = typeOf(meta(FOLD_POS, 'int'), meta(FOLD_ACC, 'any', true));
  const walkId = fresh('sr');
  let foldable = true;
  const walk = make.recursive({
    id: walkId, name: `fd_${walkId}`, channels: [], type: walkType, cols: [FOLD_POS, FOLD_ACC],
    seed: make.values({ id: fresh('ss'), channels: [], type: walkType, rows: [[compilerInt(0), seed]] }),
    step: (self) => {
      const joined = make.join({
        id: fresh('sj'), left: self, right: numbered, join: 'inner', channels: [],
        type: typeOf(meta(FOLD_POS, 'int'), meta(FOLD_ACC, 'any', true),
          meta(MEMBER_VAL, 'any', true), ...keyCols, meta(MEMBER_ORD, 'int')),
        on: eq(col(numbered.id, MEMBER_ORD),
          { kind: 'binary', op: '+', left: col(self.id, FOLD_POS), right: compilerInt(1) }),
      });
      const folded = mergeStep(operator, col(joined.id, FOLD_ACC), col(joined.id, MEMBER_VAL));
      if (!folded) { foldable = false; return self; }
      return make.project({
        id: fresh('sp'), input: joined, channels: [], type: walkType,
        exprs: [[FOLD_POS, col(joined.id, MEMBER_ORD)], [FOLD_ACC, folded]],
      });
    },
  });
  // One authority for SQLite's recursive-term laws, asked as a DECLINE here exactly as `repeatWalk`
  // asks it — and asking constructs the memoised step, so `foldable` reports the inner decline too.
  if (recursiveViolation(walk) || !foldable) return null;

  // THE LAST ROW IS THE ANSWER — the fold is linear, so the greatest ordinal is the completed
  // accumulator. Both nodes sit OUTSIDE the walk, where an `ORDER BY … LIMIT` means what it says.
  const deepest = make.limit({
    id: fresh('sl'), channels: [], type: walkType, count: compilerInt(1),
    input: make.sort({
      id: fresh('so'), input: walk, channels: [], type: walkType,
      terms: [{ expr: col(walk.id, FOLD_POS), dir: 'desc' }],
    }),
  });
  // **THE RESULT'S STORAGE CLASS IS DYNAMIC, exactly as a numeric reducer's is** — `NumberHelper`
  // returns the highest common class of the operands, so a fold of integers is an integer and one
  // touching a real is a real, and there is no compile-time tag to give. That is the `result: 'number'`
  // framing arm and its `vt` column (`reducer.ts`, `framing.ts`). `and`/`or` are the exception: they
  // answer a BOOLEAN, which `typeof` would report as `integer`, so they state their type.
  const logical = isLogicalOp(operator);
  const value = col(deepest.id, FOLD_ACC);
  return {
    rel: make.project({
      id: fresh('sv'), input: deepest, channels: [],
      type: typeOf(meta('v', 'any', true), ...(logical ? [] : [meta('vt', 'text', true)])),
      exprs: [['v', value], ...(logical ? [] : [['vt', { kind: 'call', fn: 'typeof', args: [value] } as Expr] as const])],
    }),
    framing: logical
      ? { kind: 'scalar', type: STATIC('boolean'), productiveNull: of.productiveNull }
      : { kind: 'scalar', type: UNKNOWN, result: 'number', productiveNull: of.productiveNull },
  };
}

/** The column a member ITSELF occupies, plus the one its type rides in when it has one. What a site
 *  must project down to before it can be unioned with another — everything else it carries (its
 *  aliases, its path, its own encounter) is about the chain position, not about the member. */
const memberCols = (of: Members): readonly string[] =>
  of.kind === 'elements' ? ['id'] : of.kind === 'scalars' ? ['v', ...perRowCols(of.type)] : [];

/** The ORDINAL of the site a member came from, and that site's own emission position — see
 *  `Collection.sites`. Ordering by the pair is what reproduces `Operator.addAll` appending one whole
 *  site's `BulkSet` after the previous one's, rather than interleaving two incomparable orders. */
const SITE_COL = 'site';
const SITE_ENCOUNTER_COL = 'siteenc';

/**
 * N SITES AS ONE MEMBER RELATION — `UNION ALL` over each site narrowed to the member columns, with
 * the site ordinal and that site's own encounter projected as ONE comparable order.
 *
 * ALL, never distinct: a collection is a multiset (`BulkSet` bumps a repeat member's count rather
 * than dropping it, `BulkSet.java:131`), so a vertex reached twice contributes twice.
 *
 * The narrowing is not tidiness — it is what makes the union WELL-TYPED. Two sites sit at different
 * chain positions, so they carry different channels and different declared types, and a `UNION ALL`
 * over their raw relations is not expressible. Narrowing states the same thing semantically: past
 * this point the rows are members, and a member has no aliases and no path.
 *
 * A site with NO encounter channel contributes 0, which orders its members among themselves
 * incidentally — the same answer that site alone would have given, rather than a claim the plan
 * cannot support.
 */
function accumulated(sites: readonly Site[], cols: readonly string[], fresh: Minter): Site {
  // The member columns keep the DECLARED metadata of the first site rather than a fabricated one:
  // the sites agree on `Members`, so they agree on what `v`/`id` holds, and inventing a storage class
  // here would be a second authority on a fact the relation already states.
  const first = sites[0]!.rel.type.cols;
  const type = typeOf(...cols.map((name) => first.find((column) => column.name === name) ?? meta(name, 'any')),
    meta(SITE_COL, 'int'), meta(SITE_ENCOUNTER_COL, 'int'));
  const arms = sites.map((site, ordinal) => make.project({
    id: fresh('cm'), input: site.rel, channels: [], type,
    exprs: [...cols.map((name) => [name, col(site.rel.id, name)] as const),
      [SITE_COL, compilerInt(ordinal)],
      // A site with NO order of its own contributes a constant, which orders its members among
      // themselves incidentally — the same answer that site alone would have given.
      [SITE_ENCOUNTER_COL, site.order[0] === undefined ? compilerInt(0) : col(site.rel.id, site.order[0])]],
  }));
  return {
    rel: make.union({ id: fresh('cu'), inputs: arms, all: true, channels: [], type }),
    order: [SITE_COL, SITE_ENCOUNTER_COL],
  };
}

/** A fold's `{rel, of}` as the framed relation `cap()` hands to `continueAs`. One place, so the two
 *  folds cannot describe themselves differently. */
const listed = (folded: { readonly rel: Rel; readonly of: ListOf }): FramedRel =>
  ({ rel: folded.rel, framing: { kind: 'list', of: folded.of } });

/**
 * `cap("a")` — the named collection, REDUCED, or `null` to decline.
 *
 * The read is where the reduction is, so this is `collections.get` plus `reduce`. Keeping them in one
 * function is what stops a second caller reading a collection and forgetting to reduce it — the
 * registry holds member rows now, and member rows are not a traverser.
 */
export function readCollection(step: IRStep, collections: Collections, fresh: Minter): FramedRel | null {
  if (step.modulators?.length) return null;
  const label = labelOf(step);
  if (label === null) return null;
  const collection = collections.get(label);
  return collection ? reduce(collection, fresh) : null;
}
