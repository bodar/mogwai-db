import { col, compilerInt, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { argValues } from '../../gremlin/frontend.ts';
import type { Rel } from '../../rel/rel.ts';
import { meetScalarTypes, perRowCols, sameScalarType, typeCarriedBy, type ListOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { isLocalScope } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { byField, isProductiveBy, modulations, productivityFilter } from './modulator.ts';
import { foldElements, foldScalars } from './list.ts';
import { carriedCols, meta, typeOf, withMergedVtype, type Minter } from './build.ts';
import { framingCols, type FramedRel, type RelFraming } from './framing.ts';
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
 * - **a chain with a MUTATING step.** A shared read node is re-evaluated by every statement that
 *   names it, which is correct in a read program and a silent wrong answer in one with effects — the
 *   collection would see the graph AFTER the write. §3.0's answer is a `snapshot` binding, and that
 *   is the increment this one is a prerequisite for, not a shortcut it may take.
 * - **a label registered TWICE.** Phase 2's subject: a second registration becomes a `UNION ALL` into
 *   the existing member relation, which is the reference's answer (side effects live on the ROOT
 *   traversal, `AggregateStep.java:57`) and which the member-row shape below is what makes expressible.
 *   Until then, failing closed beats keeping whichever arm ran last — which is what LEGACY does
 *   silently (`steps/prefix/sideeffect.ts:163-164`, and it mis-answers nine L3 scenarios).
 * - **`aggregate(Scope.local, "a")`** — TinkerPop 4's replacement for the lazy `store()`, which is
 *   non-blocking. Relationally that is the same SET at the end of the traversal and a DIFFERENT one
 *   read mid-traversal, so it is only safe once a mid-chain read exists to distinguish them.
 * - **a multi-label `cap("a","b")`**, which yields a MAP of collections rather than one list.
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
 */
export function registerCollection(
  step: IRStep, input: Rel, host: ChildHost, framing: RelFraming, collections: Collections,
  reducers: ReadonlySet<string>, child: ChildSeam, fresh: Minter,
): boolean {
  const label = labelOf(step);
  if (label === null) return false;
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
  const retained = bys[0]
    ? projectedMembers(step, input, host, framing, bys[0], encounter, child, fresh)
    : traverserMembers(input, framing, encounter);
  if (!retained) return false;
  const held = collections.get(label);
  if (!held) { collections.set(label, retained); return true; }
  const accumulated = accumulate(held, retained, fresh);
  if (!accumulated) return false;
  collections.set(label, accumulated);
  return true;
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
  if (held.of.kind === 'elements' && added.of.kind === 'elements')
    return held.of.elem === added.of.elem ? { sites, of: held.of } : null;
  if (held.of.kind !== 'scalars' || added.of.kind !== 'scalars') return null;
  // `productiveNull` is orthogonal to the type and says whether a NULL member is a REAL value or the
  // framer's signal to emit nothing. Two sites that answer it differently are two different member
  // encodings, and picking either would silently change one site's answer.
  if (held.of.productiveNull !== added.of.productiveNull) return null;
  const type = meetScalarTypes([held.of.type, added.of.type]);
  return {
    sites: [...honouring(held.sites, held.of.type, type, fresh), ...honouring(added.sites, added.of.type, type, fresh)],
    of: { kind: 'scalars', type, productiveNull: held.of.productiveNull },
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
  reducers: ReadonlySet<string>,
): boolean {
  const label = labelOf(step);
  if (label === null || collections.has(label) || reducers.has(label)) return false;
  collections.set(label, {
    sites: [{ rel: built.rel, order: [] }],
    of: { kind: 'reduced', framing: built.framing },
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
  if (framing.kind === 'elements') return { sites, of: { kind: 'elements', elem: framing.elem } };
  if (framing.kind !== 'scalar') return null;
  return { sites, of: { kind: 'scalars', type: framing.type, productiveNull: false } };
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
export function reduce({ sites, of }: Collection, fresh: Minter): FramedRel {
  if (of.kind === 'reduced') return { rel: sites[0]!.rel, framing: of.framing };
  const { rel, order } = sites.length === 1 ? sites[0]! : accumulated(sites, memberCols(of), fresh);
  if (of.kind === 'elements') return listed(foldElements(rel, of.elem, { order }, fresh));
  return listed(foldScalars(rel, { type: of.type, productiveNull: of.productiveNull, order }, fresh));
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
