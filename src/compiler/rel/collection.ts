import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import { argValues, type MergePolicy } from '../../gremlin/frontend.ts';
import { flatType } from '../../gremlin/types.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Binding } from '../../rel/plan.ts';
import { meetScalarTypes, perRowColumnOf, perRowCols, sameScalarType, STATIC, staticTypeOf, typeCarriedBy, UNKNOWN, type ListOf, type MixedArm, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { isLocalScope, ranPerTraverser } from '../ir/step.ts';
import type { IRStep } from '../ir/step.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { byField, isProductiveBy, modulations, productivityFilter } from './modulator.ts';
import { foldElements, foldScalars, inferredVtype, LIST_COL } from './list.ts';
import { carriedCols, collectedArray, eq, jsonOf, meta, typedNode, typeOf, withMergedVtype, type Minter } from './build.ts';
import { elementNode } from './element.ts';
import { framingCols, type FramedRel, type RelFraming } from './framing.ts';
import { groupMap, groupRowCols, KEY_COL, ORD_COL, sameGroupRecipe, type GroupRecipe, type GroupRows } from './map.ts';
import { ADD_ALL, ASSIGN, BULK_OPS, COLLECTION_OPS, FOLD_OPS, isLogicalOp, mergeStep } from './operator.ts';
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
  /**
   * DID THIS SITE'S BARRIER HOLD ONE TRAVERSER AT A TIME, or the whole stream?
   *
   * `AggregateStep.processAllStarts` drains its starts into ONE `BulkSet` and, for a BULK operator,
   * merges that whole set as a single value (`:131-151`). Under `local(aggregate(…))` a `LocalStep`
   * runs the body per traverser, so each of those "sets" holds one member. For every operator that
   * folds MEMBER BY MEMBER the distinction is invisible — which is why the IR is free to splice the
   * `local()` away — and for `Operator.assign` it is the whole answer: the global form assigns every
   * member and the per-traverser form assigns the last one alone.
   *
   * It is a property of the SITE and not of the collection, because two positions in one chain may
   * differ; and it is read off the step (`ranPerTraverser`) rather than re-derived, because the pass
   * that erased the wrapper is the only thing that still knew.
   */
  readonly perTraverser: boolean;
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
   * A KEYED GROUPING's contributions — `group("a")`/`groupCount("a")`, whose member is a
   * `(key, value-contribution)` pair and whose reduction is `groupMap` at the `cap`.
   *
   * The arm the other two are the model for, and it used to be `reduced`: the map was built at the WRITE
   * site and stored finished, which is defensible for one site and wrong for a second — `GroupBiOperator`
   * merges per KEY, so two positions filling one label hold both sites' contributions and a stored map
   * has already thrown away which rows came from where. Same argument the module header makes for
   * `aggregate`, one container along.
   *
   * `recipe` is what `groupMap` needs and is comparable DATA, so `accumulate` can refuse two sites whose
   * groupings would not be the same grouping (`sameGroupRecipe`, `map.ts`).
   */
  | { readonly kind: 'grouped'; readonly recipe: GroupRecipe }
  /**
   * A POOLED grouping, ALREADY REDUCED — `group("a").by(k).by(<reducing traversal>)`, whose value side is
   * a JOIN over the group's members' child rows (`groupReduced`, `map.ts`).
   *
   * The one arm with no member rows behind it, and therefore the one that is SINGLE-SITE by construction:
   * the child rows POOL per group and the barrier reduces the pool once, so there is no
   * `(key, contribution)` pair a second site could contribute. It is not a transitional arm — it is what
   * "this shape genuinely has no member relation" looks like, and a second registration on the label
   * declines rather than being merged into a map that has already discarded where its rows came from.
   */
  | { readonly kind: 'reduced'; readonly framing: RelFraming }
  /**
   * MIXED MEMBER SHAPES — sites contributing different KINDS into one label (a vertex site beside an
   * edge site, an element beside a value). The member-level tagged union one level BELOW the
   * stream-level variant (`variant.ts`): where that discriminates a per-ROW shape, this discriminates a
   * per-MEMBER one inside a single list.
   *
   * Its sites are ALREADY normalised to a single self-describing `{t,v}` envelope column
   * (`MEMBER_ENVELOPE`), because a mixed `UNION ALL` shares one member column and a bare rowid is
   * indistinguishable from a scalar in it — so the element-until-root rule the `elements` arm keeps
   * cannot hold here, and each element is expanded at its SITE (`envelopeSites`). `arms` is the complete
   * member vocabulary, carried so `cap("a").unfold()` can declare the right VARIANT arms.
   */
  | { readonly kind: 'mixed'; readonly arms: readonly MixedArm[] };

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
  policies: ReadonlyMap<string, MergePolicy>, child: ChildSeam, fresh: Minter, mutating: boolean,
): readonly Binding[] | null {
  const label = labelOf(step);
  if (label === null) return null;
  // A `withSideEffect(name, seed, Operator.x)` collection is NOT empty when the traversal starts and
  // is not merged by concatenation either: the declaration supplies an initial value and the operator
  // says how each contribution combines with it. Both facts travel on the policy and are SPENT AT THE
  // READ, which is where the reference spends them too (`SideEffectCapStep.generateFinalResult`) — so
  // the registration's only business with them is to carry them and to refuse an operator no read can
  // spend. `COLLECTION_OPS` is that one authority (`operator.ts`), which is why `assign` is refused
  // here by name rather than by a shape check three functions away.
  //
  // `policies` is a separate map from the constant registry, and it has to be: a consumer of that
  // registry wants a value it can SUBSTITUTE and a policy has none to give. It reports BOTH
  // declaration forms, though, and that is not a widening for tidiness — a bare
  // `withSideEffect("a", {"alice"})` on a label an `aggregate` also fills is a policy too, because
  // `registerIfAbsent` keeps that supplier and lets this step fill in the missing reducer
  // (`DefaultTraversalSideEffects.java:110-119`). Reading only the reducer form dropped that seed and
  // answered a plausible list.
  //
  // **The DEFAULT operator is THIS STEP's fact, which is why it is applied here.** `AggregateStep`'s
  // constructor registers `(BulkSetSupplier, Operator.addAll)` (`AggregateStep.java:57`); `group("a")`
  // registers its own. So the front end reports the declaration and the step that consumes it says
  // what a missing operator means — one place per step, rather than a default baked into the parse.
  const declared = policies.get(label);
  const merge = declared && { ...declared, operator: declared.operator ?? ADD_ALL };
  if (merge && !COLLECTION_OPS.has(merge.operator)) return null;
  const bys = modulations(step, 1, child);
  if (!bys) return null;
  const encounter = input.channels.find((channel) => channel.role === 'encounter');
  const built = bys[0]
    ? projectedMembers(step, input, host, framing, bys[0], encounter, child, fresh)
    : traverserMembers(step, input, framing, encounter);
  if (!built) return null;
  const policied = { ...built, merge };
  const { collection: retained, bindings } = mutating ? snapshotted(policied, fresh) : { collection: policied, bindings: [] };
  const held = collections.get(label);
  if (!held) { collections.set(label, retained); return bindings; }
  // A label a KEYED form already filled holds `(key, contribution)` members, and an `aggregate` site's
  // are bare values: mixing them is `Operator.addAll` over a Map and a Collection, which is the
  // reference's own IllegalArgumentException ("Objects must be both of Map or Collection",
  // `Operator.java:178-196`) — an error, not two member relations to union.
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
  // A KEYED or POOLED grouping is a MAP, not a collection, and it never mixes: `Operator.addAll` over a
  // Map and a Collection is the reference's own IllegalArgumentException ("Objects must be both of Map
  // or Collection", `Operator.java:178-196`). Two keyed sites must be the SAME grouping
  // (`sameGroupRecipe`, `map.ts`), or a plausibly-wrong map results; a pooled `reduced` has no member
  // rows for a second site to union onto. Both decline rather than going mixed.
  if (held.of.kind === 'reduced' || added.of.kind === 'reduced') return null;
  if (held.of.kind === 'grouped' || added.of.kind === 'grouped')
    return held.of.kind === 'grouped' && added.of.kind === 'grouped'
      && sameGroupRecipe(held.of.recipe, added.of.recipe) ? { sites, of: held.of, merge } : null;
  // TWO ELEMENT sites of the SAME kind stay `elements` — members are rowids until the root, which keeps
  // a discarded member free (`foldElements`). Different kinds cannot: their rowids share no table, so
  // they go MIXED.
  if (held.of.kind === 'elements' && added.of.kind === 'elements' && held.of.elem === added.of.elem)
    return { sites, of: held.of, merge };
  // TWO SCALAR sites MEET their per-value types and stay `scalars`. `productiveNull` is orthogonal to
  // the type and says whether a NULL member is a REAL value or the framer's signal to emit nothing; two
  // sites that answer it differently are two member ENCODINGS, so they cannot meet as scalars and go
  // mixed instead (the envelope encoding is self-describing per member, so the disagreement dissolves).
  if (held.of.kind === 'scalars' && added.of.kind === 'scalars'
    && held.of.productiveNull === added.of.productiveNull) {
    const type = meetScalarTypes([held.of.type, added.of.type]);
    return {
      sites: [...honouring(held.sites, held.of.type, type, fresh), ...honouring(added.sites, added.of.type, type, fresh)],
      of: { kind: 'scalars', type, productiveNull: held.of.productiveNull },
      merge,
    };
  }
  // EVERYTHING ELSE among {elements, scalars, mixed} is a MIXED collection — the member-level tagged
  // union. A declared merge POLICY over mixed members has no fold this route spells (a seed is a list
  // or a scalar, neither of which combines with a heterogeneous multiset), so it declines rather than
  // dropping the seed.
  if (merge) return null;
  return {
    sites: [...envelopeSites(held, fresh), ...envelopeSites(added, fresh)],
    of: { kind: 'mixed', arms: dedupeArms([...armsOf(held.of), ...armsOf(added.of)]) },
    merge: undefined,
  };
}

/** The column a MIXED collection's heterogeneous sites UNION on — one self-describing `{t,v}` envelope
 *  per member. A JSONB blob so the json subtype survives the union boundary; the fold reads it with
 *  `json()`, the same round trip `list.ts`'s nested-list rebuild makes. */
const MEMBER_ENVELOPE = 'me';

/** A member shape's arm vocabulary — one arm per element kind, one for scalars. A `mixed` side already
 *  carries its arms; the others contribute exactly one. `grouped`/`reduced` never reach here. */
const armsOf = (of: Members): readonly MixedArm[] =>
  of.kind === 'elements' ? [{ kind: 'elem', elem: of.elem }]
    : of.kind === 'scalars' ? [{ kind: 'scalar' }]
      : of.kind === 'mixed' ? of.arms : [];

/** The declared arm vocabulary, DEDUPED — two vertex sites are one `vertex` arm, so `unfold()` declares
 *  each shape once. */
const dedupeArms = (arms: readonly MixedArm[]): readonly MixedArm[] => {
  const seen = new Set<string>();
  return arms.filter((arm) => {
    const key = arm.kind === 'elem' ? `e:${arm.elem}` : 's';
    return seen.has(key) ? false : (seen.add(key), true);
  });
};

/**
 * A COLLECTION'S SITES, each normalised to one `{t,v}` envelope column so heterogeneous sites can
 * `UNION ALL`. A `mixed` side is already in that form and passes through; an `elements`/`scalars` side
 * converts each member.
 *
 * ⚠️ **An element expands to its PUBLIC PAYLOAD HERE, at the site — the one place elements-until-root
 * cannot hold.** The `elements` arm keeps rowids until the root because a bare rowid is enough when
 * every member is the same kind; a mixed union shares one column, where a rowid `5` and a scalar `5`
 * are indistinguishable, so each element must be self-describing before the union. That is why this is
 * its own arm rather than `elements` reused.
 */
function envelopeSites(collection: Collection, fresh: Minter): readonly Site[] {
  if (collection.of.kind === 'mixed') return collection.sites;
  return collection.sites.map((site) => {
    const envelope = memberEnvelope(site.rel, collection.of, fresh);
    const orderMeta = site.order.map((name) => site.rel.type.cols.find((column) => column.name === name) ?? meta(name, 'any'));
    return {
      rel: make.project({
        id: fresh('mez'), input: site.rel, channels: [],
        type: typeOf(meta(MEMBER_ENVELOPE, 'json', true), ...orderMeta),
        // `jsonb(<envelope>)` so the blob survives the union; the envelope itself is `json_object` text.
        exprs: [[MEMBER_ENVELOPE, { kind: 'call', fn: 'jsonb', args: [envelope] }],
          ...site.order.map((name) => [name, col(site.rel.id, name)] as const)],
      }),
      order: site.order,
      perTraverser: site.perTraverser,
    };
  });
}

/** ONE member's self-describing `{t,v}` envelope. An element is `{"t":"vertex","v":{payload}}`
 *  (`elementNode`); a scalar is `{"t":<vtype>,"v":<value>}` (`typedNode`), the type read from the
 *  member's own carrier — a per-row column, a static tag, or inferred from the storage class where the
 *  stream never declared one. */
function memberEnvelope(rel: Rel, of: Members, fresh: Minter): Expr {
  if (of.kind === 'elements') return elementNode(col(rel.id, 'id'), of.elem, fresh);
  if (of.kind !== 'scalars') throw new Error(`memberEnvelope: ${of.kind} has no scalar member`);
  const value = col(rel.id, 'v');
  const column = perRowColumnOf(of.type);
  const tag = staticTypeOf(of.type);
  const vtype: Expr = column ? col(rel.id, column) : tag ? compilerText(tag) : inferredVtype(value);
  return typedNode(value, vtype);
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
export function registerGrouping(
  step: IRStep, rows: GroupRows, collections: Collections,
  policies: ReadonlyMap<string, MergePolicy>, fresh: Minter,
): boolean {
  const label = labelOf(step);
  if (label === null) return false;
  // A DECLARED policy on a keyed label is a seeded map merge — `GroupSideEffectStep` registers
  // `(HashMapSupplier, GroupBiOperator)` and `registerIfAbsent` keeps a declared supplier, so the
  // grouping accumulates INTO the declared map. Nothing here builds that, and registering anyway would
  // drop the seed silently, so it declines.
  if (policies.has(label)) return false;
  // A COLLECTING grouping states its member order and a COUNTING one has none to state — its rows carry
  // no `go` column at all (`groupRowCols`), and a count is order-free by construction. Naming a column
  // the site does not have is what `accumulated` would then project, and the checker catches it.
  //
  // A POOLED value registers its FINISHED map instead, and `accumulate` then refuses a second site: the
  // group's members' child rows pool and the barrier reduces the pool once, so there is no
  // `(key, contribution)` row a union could take. See the `reduced` arm.
  const added: Collection = rows.done
    ? {
      sites: [{ rel: rows.done.rel, order: [], perTraverser: true }],
      of: { kind: 'reduced', framing: { kind: 'map', keyOf: rows.done.keyOf, valOf: rows.done.valOf } },
      merge: undefined,
    }
    : {
      sites: [{ rel: rows.rel, order: rows.recipe.counting ? [] : [ORD_COL], perTraverser: true }],
      of: { kind: 'grouped', recipe: rows.recipe },
      merge: undefined,
    };
  const held = collections.get(label);
  if (!held) { collections.set(label, added); return true; }
  const accumulated = accumulate(held, added, fresh);
  if (!accumulated) return false;
  collections.set(label, accumulated);
  return true;
}

/** A site's member order: the encounter channel where the stream carries one, and nothing where it
 *  does not — the same "incidental row order" a `fold()` accepts on the same terms. */
const orderOf = (encounter: Channel | undefined): readonly string[] => encounter ? [encounter.col] : [];

/** The BARE `aggregate("a")` — the traversers themselves are the members, in whichever shape the
 *  stream already had. */
function traverserMembers(
  step: IRStep, input: Rel, framing: RelFraming, encounter: Channel | undefined,
): Collection | null {
  const sites = [{ rel: input, order: orderOf(encounter), perTraverser: ranPerTraverser(step) }];
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
    sites: [{ rel: rows, order: orderOf(encounter), perTraverser: ranPerTraverser(step) }],
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
 * `Aggregate`s with `channels: []`, which is what drops the layout at the barrier.
 * Everything after it is the ordinary list tail — `unfold()`, `count(local)`, a local reducer, a
 * member op — with nothing to know about side effects.
 *
 * A collection NOTHING reached needs no arm: both folds `COALESCE` an empty aggregate to `[]`, so
 * `cap()` over it is an EMPTY list — which is what the reference's `BulkSet` seed supplies.
 */
export function reduce(collection: Collection, fresh: Minter): FramedRel | null {
  // A KEYED GROUPING reduces per KEY rather than into a list, so its policy question is a different one
  // (`GroupBiOperator` merges maps, not members) and `registerGrouping` refuses a declared one outright.
  // What it shares with the other two arms is everything that matters: N sites are a `UNION ALL` of
  // member relations, ordered by (site ordinal, that site's own), reduced ONCE at the read.
  if (collection.of.kind === 'reduced') return { rel: collection.sites[0]!.rel, framing: collection.of.framing };
  // A MIXED collection's sites already hold `{t,v}` envelopes in ONE column (`envelopeSites`), so the
  // reduction is the ordinary list fold — `UNION ALL` the sites, then `json_group_array` the envelope
  // column, exactly as `foldScalars` does over a typed member. The framing is a `mixed` list, and
  // `unfold()` reads its `arms` to build a variant.
  if (collection.of.kind === 'mixed') {
    const site = collection.sites.length === 1
      ? collection.sites[0]!
      : accumulated(collection.sites, [MEMBER_ENVELOPE], fresh);
    const order = site.order.map((name) => ({ expr: col(site.rel.id, name), dir: 'asc' as const }));
    const rel = make.aggregate({
      id: fresh('fx'), input: site.rel, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [], aggs: [[LIST_COL, collectedArray(jsonOf(col(site.rel.id, MEMBER_ENVELOPE)), order)]],
    });
    return { rel, framing: { kind: 'list', of: { kind: 'mixed', arms: collection.of.arms } } };
  }
  if (collection.of.kind === 'grouped') {
    const { recipe } = collection.of;
    const grouped = collection.sites.length === 1
      ? { site: collection.sites[0]!, order: [ORD_COL] as readonly string[] }
      : (() => {
        const site = accumulated(collection.sites, groupRowCols(recipe), fresh);
        return { site, order: site.order };
      })();
    const map = groupMap(grouped.site.rel, recipe, fresh, grouped.order);
    return { rel: map.rel, framing: { kind: 'map', keyOf: map.keyOf, valOf: map.valOf } };
  }
  // `addAll` IS the ordinary list fold — over one more site. So the policy is spent BEFORE the
  // reduction rather than instead of it, and everything downstream sees a plain collection.
  const seeded = collection.merge?.operator === ADD_ALL ? seedAsSite(collection, fresh) : collection;
  if (!seeded) return null;
  const { sites, of, merge } = seeded;
  // `grouped`/`reduced` are maps, `mixed` reduced above — the seeded list fold below serves only the two
  // list arms. A `mixed` here would mean a declared policy over mixed members, which `accumulate`
  // already refused (a seed cannot fold into a heterogeneous multiset).
  if (of.kind === 'grouped' || of.kind === 'reduced' || of.kind === 'mixed') return null;
  // `assign` REPLACES, so only the LAST merge survives and every site before it is dead — which makes
  // it the one policy that narrows the site list rather than reading all of it.
  const surviving = merge?.operator === ASSIGN ? [sites[sites.length - 1]!] : sites;
  const accumulation = surviving.length === 1 ? surviving[0]! : accumulated(surviving, memberCols(of), fresh);
  // Every other DECLARED policy replaces the fold outright: the members combine into the seed by the
  // operator, and the answer is a SCALAR rather than a list.
  if (merge && merge.operator !== ADD_ALL && merge.operator !== ASSIGN)
    return seededFold(accumulation.rel, accumulation.order, of, merge, fresh);
  // A PER-TRAVERSER `assign` assigns a one-member set each time, so the answer is the LAST member
  // alone; a global one assigns the whole set. Both discard the seed, which is what `assign` IS.
  const assigned = merge?.operator === ASSIGN && accumulation.perTraverser
    ? lastMember(accumulation, fresh) : accumulation;
  // A SET seed makes `addAll` DEDUP, and it also makes the answer a Set on the wire. `assign` discards
  // the seed, so its set-ness goes with it — the assigned value is the site's own `BulkSet`.
  const setSeeded = merge?.operator === ADD_ALL && merge.seed.value instanceof Set;
  const { rel, order } = setSeeded ? firstOccurrences(assigned, memberCols(of), fresh) : assigned;
  const folded = of.kind === 'elements'
    ? listed(foldElements(rel, of.elem, { order }, fresh))
    : listed(foldScalars(rel, { type: of.type, productiveNull: of.productiveNull, order }, fresh));
  return setSeeded ? { ...folded, framing: { ...folded.framing, set: true } } : folded;
}

/**
 * THE LAST MEMBER ALONE — what a PER-TRAVERSER `Operator.assign` leaves behind.
 *
 * `assign` returns its second argument (`Operator.java:104-110`), so the collection is whatever the
 * final `sideEffects.add` handed it. Under `local(aggregate(…))` a `LocalStep` makes every traverser its
 * own barrier, so that final value is a one-member `BulkSet` — the last traverser's — and `cap` returns
 * it as a one-member list. The corpus states the difference rather than describing it: the same
 * declaration answers `[29,27,32,35]` at chain position and `[35]` under `local` after an
 * `order().by("age")` (`Aggregate.feature:552-575`).
 *
 * ⚠️ **"Last" is only as defined as the site's own order, and that is the REFERENCE's answer too** —
 * which is exactly why its scenario adds an `order().by("age")` and says so in a comment. With no
 * ordering the pick is arbitrary in TinkerPop as well, so an arbitrary pick here is faithful rather
 * than sloppy; what would not be faithful is inventing an order to look deterministic.
 */
function lastMember(site: Site, fresh: Minter): Site {
  // The channels ride through, and every node here must say so: a member relation still carries the
  // encounter channel that ORDERS it, and the obligation checker refuses a slice that silently drops one
  // ("sort changed its carried channels") rather than letting the declared schema desync from the rows.
  const carried = site.rel.channels;
  const ordered = make.sort({
    id: fresh('sy'), input: site.rel, channels: carried, type: site.rel.type,
    terms: site.order.map((name) => ({ expr: col(site.rel.id, name), dir: 'desc' as const })),
  });
  return {
    rel: make.limit({ id: fresh('sz'), input: ordered, channels: carried, type: ordered.type, count: compilerInt(1) }),
    order: site.order,
    perTraverser: site.perTraverser,
  };
}

/**
 * THE FIRST OCCURRENCE OF EACH DISTINCT MEMBER — what a `Set`-seeded `addAll` leaves behind.
 *
 * `addAll(a, b)` is `a.addAll(b)` (`Operator.java:178-196`), so when the seed is a `Set` the collection
 * IS that set and every later contribution is offered to `Set.add`: a member equal to one already there
 * changes nothing, and a `LinkedHashSet` keeps the position of the FIRST one. That is the one place a
 * collection's multiset licence is revoked — `BulkSet` bumps a repeat's count, a `Set` drops it.
 *
 * It is a KEYED dedup rather than `Distinct`, and the algebra's own comment says why (`rel.ts`,
 * `distinct`): whole-row `SELECT DISTINCT` cannot express it, because the rows carry the site ordinal and
 * the encounter that ORDER them and those differ for every duplicate. `Window(row_number PARTITION BY
 * <member>)` + `Filter(rn = 1)` is the shape, and partitioning by the member's columns rather than by `v`
 * alone is what keeps a typed `1` and a `"1"` two members.
 */
function firstOccurrences(site: Site, cols: readonly string[], fresh: Minter): Site {
  const kept = 'sq';
  const carried = site.rel.channels;
  const ranked = make.window({
    id: fresh('sk'), input: site.rel, channels: carried,
    type: typeOf(...site.rel.type.cols, meta(kept, 'int')),
    specs: [[kept, {
      kind: 'window-expr', fn: 'row_number', args: [],
      spec: {
        partitionBy: cols.map((name) => col(site.rel.id, name)),
        orderBy: site.order.map((name) => ({ expr: col(site.rel.id, name), dir: 'asc' as const })),
      },
    }]],
  });
  return {
    rel: make.filter({
      id: fresh('sx'), input: ranked, channels: carried, type: ranked.type,
      pred: eq(col(ranked.id, kept), compilerInt(1)),
    }),
    order: site.order,
    perTraverser: site.perTraverser,
  };
}

/**
 * `Operator.addAll` — THE SEED'S ITEMS AS SITE 0, so the reduction stays the list fold. `null` declines.
 *
 * `addAll(a, b)` is `a.addAll(b)` (`Operator.java:178-196`), and the value `AggregateStep` hands it is the
 * site's whole `BulkSet` (`:147-148` — `addAll` is one of the two BULK operators). So the answer is the
 * seed's items, then site 1's members, then site 2's: `Collection.sites` with one more site in FRONT, which
 * is a thing this module already knows how to be. Nothing new decides the order and nothing new merges the
 * types — the seed goes through `accumulate` exactly as a second `aggregate("a")` position does, so a
 * String seed beside Integer members MEETS at a per-value type rather than mis-tagging either side.
 *
 * A `Set` seed is the same prepend — a JS `Set` still carries its items as `members` — and the DEDUP it
 * additionally implies belongs at the read, over every site's members at once (`firstOccurrences`).
 */
function seedAsSite({ sites, of, merge }: Collection, fresh: Minter): Collection | null {
  // Only a collection LITERAL carries per-item `Arg`s. A bound list PARAMETER is ONE oversized value
  // with no members to spell as rows, and a SCALAR seed is `Operator.addAll`'s own
  // IllegalArgumentException ("Objects must be both of Map or Collection") rather than a list to prepend.
  const items = merge?.seed.members;
  if (!items) return null;
  // An EMPTY seed adds nothing, and `Values` has no empty form — so it is the absence of a site, not a
  // site of no rows.
  if (!items.length) return { sites, of, merge };
  // Mixed member SHAPES — a scalar seed beside ELEMENT members — is the member-level tagged union
  // (Phase 3b), one level below the stream variant. Not this function's to invent.
  if (of.kind !== 'scalars') return null;
  const literals = items.map(constLit);
  if (literals.some((literal) => literal === null)) return null;
  // Each item's DECLARED type, met the same way two sites' are. Where the items agree the seed site is
  // STATIC and costs no column; where they disagree the tag rides per row in the meet's own column,
  // which is `injectSource`'s arm for exactly the same problem one layer up.
  const itemTypes = items.map((item) => {
    const tag = flatType(item.type);
    return tag === null || tag === 'list' || tag === 'map' || tag === 'set' ? UNKNOWN : STATIC(tag);
  });
  const type = meetScalarTypes(itemTypes);
  const tagColumn = perRowColumnOf(type);
  const seed: Site = {
    rel: make.values({
      id: fresh('sd'), channels: [],
      type: typeOf(meta('v', 'any', true), ...(tagColumn ? [meta(tagColumn, 'text', true)] : [])),
      rows: literals.map((literal, i) => {
        const tag = staticTypeOf(itemTypes[i]!);
        return tagColumn ? [literal!, tag ? compilerText(tag) : compilerNull('text')] : [literal!];
      }),
    }),
    // NO order of its own: the seed's items are a written-down sequence and the `Values` rows carry it
    // incidentally, exactly as a site with no encounter channel does.
    order: [],
    // The seed is not a barrier at all — it is a written-down value — so the granularity question does
    // not arise for it. `false` is the answer that makes `addAll` behave, and `addAll` is the only
    // operator that ever sees this site.
    perTraverser: false,
  };
  return accumulate({ sites: [seed], of: { kind: 'scalars', type, productiveNull: of.productiveNull }, merge },
    { sites, of, merge }, fresh);
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
  of.kind === 'elements' ? ['id']
    : of.kind === 'scalars' ? ['v', ...perRowCols(of.type)]
      : of.kind === 'grouped' ? groupRowCols(of.recipe)
        : of.kind === 'mixed' ? [MEMBER_ENVELOPE] : [];

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
    // The ACCUMULATION's granularity is the LAST site's, because that is the barrier whose merge lands
    // last and `assign` keeps only the last one. Every other operator ignores it.
    perTraverser: sites[sites.length - 1]!.perTraverser,
  };
}

/** A fold's `{rel, of}` as the framed relation `cap()` hands to `continueAs`. One place, so the two
 *  folds cannot describe themselves differently. */
const listed = (folded: { readonly rel: Rel; readonly of: ListOf }): ListedRel =>
  ({ rel: folded.rel, framing: { kind: 'list', of: folded.of } });

/** `listed`'s result, with its framing NARROWED to the list arm — so a caller may add the `set` marker
 *  without widening it back to the whole union first. */
type ListedRel = { readonly rel: Rel; readonly framing: Extract<RelFraming, { readonly kind: 'list' }> };

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

/** The collection a `cap("a")` names, WITHOUT reducing it — so a consumer-driven read can pick the
 *  fold. `null` for a modulated cap or an unknown label, exactly as `readCollection` declines. */
export function collectionOf(step: IRStep, collections: Collections): Collection | undefined {
  if (step.modulators?.length) return undefined;
  const label = labelOf(step);
  return label === null ? undefined : collections.get(label);
}

/**
 * `cap("a").select(Column.keys)` over a KEYED grouping — the DISTINCT keys as a SET traverser,
 * projected DIRECTLY off the collection's member rows, WITHOUT building the intermediate map blob.
 *
 * This is the consumer-driven fold this doc's thesis asks for (§ "reduced at the READ"): the fold to a
 * JSONB map is chosen by what CONSUMES the collection, not unconditionally at the read.
 * `select(Column.keys)` wants the KEY SIDE, so it reads the key column of the member relation — for an
 * element-identity key the ROWID, kept as a rowid the way `foldElements` keeps element-list members,
 * so the resulting set MOVES (`.unfold().both()`) natively. Folding to the map first expands the key to
 * a PUBLIC payload (`COALESCE(uid, id)`) and LOSES that rowid — the same trap `list.ts`'s `unfoldList`
 * calls out for element lists ("would have LOST the rowid the graph is keyed by").
 *
 * ELEMENT keys ONLY: a scalar / `by(key)`-keyed grouping reaches its keys through the ordinary map
 * blob, which is not lossy for a scalar, so this intercepts only the case the blob path cannot serve.
 * `Column.values` needs the per-key reduction and is a separate read.
 */
export function groupedKeys(collection: Collection, fresh: Minter): ListedRel | null {
  if (collection.of.kind !== 'grouped') return null;
  const { recipe } = collection.of;
  if (recipe.keyElem === undefined) return null;
  // N sites are a UNION of member rows, exactly as `reduce`'s grouped arm accumulates them.
  const site = collection.sites.length === 1
    ? collection.sites[0]!
    : accumulated(collection.sites, groupRowCols(recipe), fresh);
  // The key column is the ROWID; project it as `id` (what `foldElements` reads) and DEDUP, because
  // `Column.keys` is the SET of the map's distinct keys — the per-key grouping the blob would have
  // done, taken on the key alone.
  const ids = make.project({
    id: fresh('ck'), input: site.rel, channels: [], type: typeOf(meta('id', 'int')),
    exprs: [['id', col(site.rel.id, KEY_COL)]],
  });
  const distinct = make.distinct({ id: fresh('cd'), input: ids, channels: [], type: ids.type });
  const folded = foldElements(distinct, recipe.keyElem, { order: ['id'] }, fresh);
  return { rel: folded.rel, framing: { kind: 'list', of: folded.of, set: true } };
}
