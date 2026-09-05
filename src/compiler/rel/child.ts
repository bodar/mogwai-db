import { compilerInt, type Expr } from '../../rel/expr.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../elem.ts';
import type { AliasMap } from '../alias.ts';
import type { IRStep } from '../ir/step.ts';
import type { Binding } from '../../rel/plan.ts';
import type { RecordField, RelFraming } from './framing.ts';
import type { SubjectType } from './predicate.ts';
import type { ListOf } from '../../sql/kernel/render.ts';

/**
 * THE CHILD SEAM — ONE interface, THREE total answers to "lower an inner body" (§6·6).
 *
 * Four spellings of this question used to exist, each grown where a host first needed one: `ByChild`
 * (`modulator.ts`, a correlated scalar), `SubReads.body`/`rooted`/`matching` (`write.ts`, a rooted
 * relation), `ListCtx.subRead` (`list.ts`, a rooted relation read as a value) and
 * `FilterCtx.correlatedChildren` → `correlatedExists` (`lower.ts`, a correlated predicate). They are
 * one concept answered four times, and the cost was not duplication for its own sake: a host gained a
 * child body only where it had been TAUGHT one, so `by(__.out().count())` worked and
 * `property('k', __.out().count())` did not — the same body, the same fold, the same correlated
 * scalar, refused because the write vocabulary had been handed the ROOTED answer and no other.
 *
 * With one seam a child body works wherever a child body is LEGAL, and the by()-child matrix grows in
 * one place instead of four.
 *
 * ## Why exactly three, and why that is a closed set
 *
 * A child body can only be consumed three ways, and the distinction is what the CONSUMER does with the
 * rows rather than what the body contains:
 *
 * - **`scalar`** — the body's single value, correlated to one host traverser. A `by()` projection, a
 *   `property()` value, a nested `addV` label. Renders as a correlated scalar subquery, which P2
 *   confirms is legal even inside a recursive term.
 * - **`predicate`** — does the body PRODUCE anything for this traverser. A `where()`/`filter()`/`not()`
 *   body, a `choose()` condition. Renders as a conjunction of ordinary clauses where the body never
 *   leaves the traverser, and as a correlated `EXISTS` where it moves.
 * - **`rooted`** — the body is a whole chain of its OWN (`__.V(2)`, a set-op operand, a merge search),
 *   correlated to nothing. Renders as an ordinary relation, spliced in.
 *
 * There is no fourth because there is no fourth THING to do with rows: read one value, ask whether any
 * exist, or take the relation. A body applied to a whole relation of hosts at once is not a child at
 * all — it is the ordinary fold with that relation as its input, which is what `rooted` re-enters.
 *
 * ## The two rules, inherited unchanged from `predicate.ts` and `modulator.ts`
 *
 * - **No answer throws.** Every arm returns `null` for a form it cannot express, and the whole
 *   traversal is not covered (a miss the caller raises as `UnsupportedTraversal`). `body()` is part of
 *   that contract and not a convenience: normalizing a nested body RE-RUNS the Pass pipeline over it,
 *   and `rewriteWhereVariables` legitimately hard-errors on a `where(__.as(l))` start variable the
 *   body's own scope never bound. A raise there is a legitimate error, not this route's crash.
 * - **No answer answers a DIFFERENT question.** An arm reproduces the reference semantics exactly or
 *   declines.
 *
 * ## Why the interface is INJECTED rather than imported
 *
 * The implementations live beside the fold (`lower.ts`) because every one of them re-enters it; the
 * declaration lives here because four modules consume it and the fold imports all four. Injecting the
 * seam is what keeps the module DAG one-way — `build ◂ {modulator, list, write} ◂ lower ◂ spine` — and
 * it is the same dependency inversion each of the four spellings used separately, now spelled once.
 */
export interface ChildSeam {
  /**
   * THE TWO COMPILE-SCOPE CONSTANT ENVIRONMENTS a nested argument resolves against — the wire
   * `bindings` map and the `withSideEffect(name, constant)` registry the front-end extracted.
   *
   * On the seam rather than beside it for one reason: every consumer that parses a nested argument
   * needs both, and threading them separately is how they drift apart. `parseProperty` and
   * `mergeMaps` take exactly this pair, and the write vocabulary reaching them through the seam is
   * what stopped `mergeV(__.select(c))` reading as an uncovered gap.
   */
  readonly params: Record<string, any>;
  readonly sideEffects: Map<string, any>;
  /** A correlated sub-traversal as ONE VALUE over the host traverser, or `null` to decline. */
  readonly scalar: (body: readonly IRStep[], host: ChildHost) => ChildValue | null;
  /** A correlated sub-traversal as a BOOLEAN over the subject row, or `null` to decline. */
  readonly predicate: (body: readonly IRStep[], subject: Subject, negated: boolean) => Expr | null;
  /** A ROOTED chain — one correlated to nothing — lowered as a relation, or `null` to decline. */
  readonly rooted: (steps: readonly IRStep[]) => RootedRead | null;
  /**
   * A child body lowered over the host STREAM — one row per child TRAVERSER, carrying an `origin`
   * channel that names the host row it descends from. `null` declines.
   *
   * THE FOURTH ANSWER, and it is the one a GROUP-SCOPED reduction needs: `scalar` collapses the body to
   * one value PER HOST ROW, which is the wrong shape when the reducer must see every group member's
   * child traversers pooled. So this hands back the rows themselves and lets the CONSUMER decide the
   * grouping — the same division `rooted` makes, one correlation along.
   *
   * It is a JOIN and not a correlated subquery because SQLite has no `LATERAL`: the correlation becomes
   * the join's `ON`, which is what the ordinary fold's movements already build from an input relation.
   * That is also why the origin has to be a CHANNEL — a join keeps its input's channels and drops its
   * payload (§3.5), so a plain column naming the parent would not survive the first hop.
   */
  readonly rows: (body: readonly IRStep[], input: Rel, elem: Elem, aliases: AliasMap) => ChildRows | null;
  /**
   * Run the ordinary fold over a supplied stream. This is not another way to consume a child
   * result: the recursive walk needs the body relation itself, rooted at its `SelfRef`, so it hands
   * that relation back to the same fold every top-level chain uses.
   */
  readonly chain: (input: Rel, framing: RelFraming, body: readonly IRStep[], aliases: AliasMap) => ChainRead | null;
  /**
   * SCOPE a stream PER ORIGIN — mint a per-ROW `origin` channel (a `ROW_NUMBER() OVER ()` unique per
   * row) so a per-origin barrier in a body run over it (`limit`/`range`/`skip`/`tail`/`dedup`, which
   * consult the ambient `origin`) self-scopes to the row it descended from. `unscopeRows` sheds it once
   * the body is done, so the origin never rides into a downstream whole-row `dedup`/merge. This is the
   * ONE per-origin substrate — `local`/`flatMap` reach it through `rows` (origin = the host rowid),
   * `match` reaches it here (origin = a per-binding-row number, because a binding row is not identified
   * by any element it holds). A body with no per-origin barrier scopes nothing and calls neither.
   */
  readonly scopeRows: (rows: Rel) => Rel;
  readonly unscopeRows: (rows: Rel) => Rel;
  /** A nested argument's normalized body, or `null` where normalizing it RAISES. */
  readonly body: (nested: unknown, scope: BodyScope) => readonly IRStep[] | null;
}

/** A continued chain: a rooted read plus the labels live at its end. */
export interface ChainRead extends RootedRead {
  readonly aliases: AliasMap;
}

/**
 * A CHILD BODY'S ROWS over a host STREAM — the relation, what its traversers ARE, and the column that
 * names each one's host row.
 *
 * `origin` is a COLUMN NAME rather than an expression because the consumer both GROUPS by it and
 * re-projects the host's own key from it, and two spellings of one column is how those two uses drift.
 */
export interface ChildRows {
  readonly rel: Rel;
  readonly framing: RelFraming;
  readonly origin: string;
  /**
   * The labels LIVE at the body's end — the host labels that rode IN plus any the body itself bound.
   *
   * A per-traverser-spliced body must thread this OUT to parent scope for the combinators whose
   * TinkerPop step forwards the full `Traverser.Admin` — `local` (`LocalStep.processNextStart` returns
   * `localTraversal.nextTraverser()`), and through their own merges `union`/`choose`/`repeat`. Plain
   * `flatMap` UNWRAPS to a value and re-derives from the pre-child head (`Traverser.split`), so it sheds
   * these and keeps only the incoming map. The physical alias CHANNELS ride through the rejoin as
   * ordinary carried columns either way; this field is the name→column half the framing layer owns,
   * which `childRows` used to compute and discard.
   */
  readonly aliases: AliasMap;
}

/**
 * A CHILD BODY'S ONE RESULT for one host traverser — the value, and WHAT IT IS.
 *
 * The framing is not decoration, and returning the bare `Expr` was §6·7's discard in miniature: a
 * child body knows its result's Gremlin type at the point it computes it — `__.out().count()` is a
 * LONG, `__.values('x').asNumber(GType.BYTE)` a Byte, `__.values('n').asDate()` a Date — and
 * `transformExpr` already reports it. Dropping it made every child projection frame by JS-value
 * inference at the wire, which cannot tell a Long from an Int or a Date from a number. Carrying it
 * costs one field and helps every consumer at once; guessing it back is per-consumer and lossy.
 *
 * `framing` is the full `RelFraming` rather than a `ScalarType` because the arm's contract is a
 * CARDINALITY — one result per host traverser — and not a shape. A body whose one result is an
 * ELEMENT (`by(__.select('v'))`) is the same correlated read with a rowid in the column, and typing
 * it narrowly would be the boundary that has to be widened again later. Consumers that can only use
 * a value narrow it themselves.
 */
export interface ChildValue {
  readonly expr: Expr;
  readonly framing: RelFraming;
  /**
   * DID THE BODY HAVE ONLY ONE RESULT TO GIVE, or did this expression TAKE THE FIRST of several — the
   * other end of the cardinality question `present` opens, and REQUIRED for the same reason `framing`
   * is: only the arm that built the expression knows.
   *
   * The arm's contract is one value per host row, and there are two different ways to honour it.
   * `__.out().count()` and `__.outV()` yield exactly one BY CONSTRUCTION — a reducing barrier, an
   * endpoint the schema makes single-valued. `__.values('name')` yields one PER PROPERTY ROW and the
   * expression picks the first in insertion order, which is `map()`'s semantics and is NOT
   * `local()`/`flatMap()`'s.
   *
   * So a consumer that emits every result must refuse `'first'` and a consumer that wants the first
   * may take either. Leaving it implicit meant reading it off the framing — "a reducing `result` marker
   * means exactly one" — which is true today and true only by coincidence: it made `local(__.outV())`
   * decline, because an endpoint re-root is single-valued without being a reducer.
   */
  readonly yields: 'one' | 'first';
  /**
   * The value's PER-ROW type, where the body read one from storage — the second correlated read that
   * a `perRow` framing names a column for.
   *
   * It is a separate field rather than part of `framing` because the two say different things: the
   * framing says the type rides per row, and this is the expression that produces it. A consumer that
   * can only project ONE column per correlated read (an ordering key, a map entry's node) ignores it
   * and reads the framing as untyped; a consumer that projects the field's whole payload (`byField`)
   * lands it beside the value, which is what stops `by(__.values('uuid'))` framing as a plain string.
   */
  readonly vtype?: Expr;
  /**
   * DID THIS BODY PRODUCE ANYTHING for this host row — the productivity signal, carried rather than
   * guessed back from the value.
   *
   * `TraversalProduct` is explicit that a productive NULL is a value (`util/TraversalProduct.java`),
   * so `expr IS NULL` answers a DIFFERENT question from "the body was unproductive" and a consumer
   * that conflates them is wrong in exactly the case it was reaching for. The option-map `choose` is
   * that consumer: `Pick.none` claims a productive choice that matched no key and `Pick.unproductive`
   * claims a choice that produced nothing, and TinkerPop routes them to different arms. This is the
   * same signal a modulation's `present` column carries, so it is carriage rather than semantics —
   * §6·7's rule at a third seam.
   *
   * ABSENT means the arm CANNOT SAY, and a consumer that needs it must then decline: an unknown
   * productivity is not "always productive". A body that is always productive says so with a true
   * literal, which is a claim rather than a silence.
   */
  readonly present?: Expr;
}

/** A body that CANNOT be unproductive, as an expression — the claim `ChildValue.present` wants where
 *  the answer is "always", since its absence means "cannot say" and the two must stay distinguishable.
 *  A constant true; SQLite folds it and the emitter never sees a branch on it. It lives HERE, beside the
 *  `present` field it fills, so every producer (`lower.ts`) and every consumer (`modulator.ts`'s
 *  `optional` decision) reads the SAME object — the productivity test is a reference-equality check, and
 *  a second copy would silently answer "cannot say" where one meant "always". */
export const ALWAYS_PRODUCTIVE: Expr = { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(1) };

/**
 * WHICH normalization a nested argument gets, and the two are not interchangeable.
 *
 * A `child` body is rooted at the CURRENT traverser (`__.out().count()`), so `childSteps` strips no
 * source and the Pass pipeline runs with the parent's scope in view. A `rooted` body is a chain of its
 * own (`__.V(2)`), so it goes through `normalize(stepChain(…))` — running `childSteps` on one strips
 * its source and answers the empty chain, i.e. an endpoint that silently matched nothing.
 */
export type BodyScope = 'child' | 'rooted';

/**
 * The traverser a child body is rooted AT — a union rather than a bag of optional fields, because the
 * two cases admit DIFFERENT projections and the type is what makes that visible: an element has
 * properties and tokens, a scalar value has neither. `vtype` is present only where the value came from
 * a stored property, which is the same distinction `predicateExpr`'s `compare` parameter draws.
 */
export type ChildHost =
  | { readonly kind: 'element'; readonly id: Expr; readonly elem: Elem; readonly row?: HostRow }
  | { readonly kind: 'scalar'; readonly value: Expr; readonly vtype?: Expr; readonly row?: HostRow;
      /** Present only for a child rooted at an unfolded Map.Entry. */
      readonly entry?: { readonly key: Expr; readonly val: Expr; readonly keyOf: import('../../sql/kernel/render.ts').MapOf; readonly valOf: import('../../sql/kernel/render.ts').MapOf } }
  /** A PROPERTY traverser — `properties()`, addressed by the stored row's own rowid exactly as an
   *  element host is addressed by its element rowid. Its three projections (`key()`, `value()`,
   *  `element()`) are correlated reads of that row (`propertyReadOf`, `property.ts`), which is what
   *  lets `group().by(__.project(…).by(__.element().values('name')).by(__.key()).by(__.value()))`
   *  compose out of the SAME by()/child vocabulary every other host uses.
   *
   *  `ownerElem` is required because the two owners differ in the row's COLUMNS and not merely in
   *  their values: an edge `Property` has no meta-properties and no identity of its own. */
  | { readonly kind: 'property'; readonly id: Expr; readonly ownerElem: Elem; readonly row?: HostRow }
  /** A RECORD traverser — its own MAP SCOPE. `Scoping.getScopeValue` tries the traverser's Map before
   *  the side effects and the path labels, so `by(__.select('b'))` over a `project('a','b')` names the
   *  FIELD and not a same-named `as()` label. The fields ride on the host rather than on `HostRow`
   *  because they are what the traverser IS, not state carried beside it. */
  | { readonly kind: 'record'; readonly fields: readonly RecordField[]; readonly row?: HostRow }
  /** A LIST traverser — a collection VALUE the body iterates. `select(Pop.all).by(__.unfold()…)`,
   *  `project('ks').by(__.select('a').unfold()…)`: the traverser IS a list, and a `by()` over it opens
   *  with a step that consumes the collection (`unfold()`, `count(Scope.local)`). `list` is the value
   *  expression (a JSONB array) and `of` its member encoding, exactly the pair the `list` framing carries
   *  — so the child body re-enters the list vocabulary correlated to this one host, the same way the
   *  element host re-enters the element loop. */
  | { readonly kind: 'list'; readonly list: Expr; readonly of: ListOf; readonly row?: HostRow }
  /** A MAP traverser — a `valueMap()`/`group()` map VALUE. It exists so the shape-parameterised row-op
   *  engine (`rowOp`) can carry a map like any other stream: its DEDUP identity is the whole `MAP_COL`
   *  JSON (a `LinkedHashMap` in canonical key order compares by entries), and its ORDER declines — a Java
   *  `Map` is not `Comparable`, so every `by()`/order arm below returns `null` for it (there is no scalar
   *  value to project). `map` is the value expression (a JSONB object); `keyOf`/`valOf` its encodings. */
  | { readonly kind: 'map'; readonly map: Expr; readonly keyOf: import('../../sql/kernel/render.ts').MapOf; readonly valOf: import('../../sql/kernel/render.ts').MapOf; readonly row?: HostRow };

/**
 * THE ROW the host traverser rides on — its relation and the labels bound on it.
 *
 * A `by()` projection is not always a question about the traverser's VALUE. `by(__.select('v'))` reads
 * the ALIAS CHANNEL, which is carried state on the row rather than anything a correlated subquery over
 * the traverser could find, and `Scoping.getScopeValue` puts it in the same slot as a property read
 * (the map, then side-effects, then the path labels). The predicate arm has had this all along as
 * `Subject.rel`; the projection arms need it for the same reason.
 *
 * OPTIONAL because not every host has one to give — a `by()` inside a path position is projecting from
 * a rowid, not from a row of the outer relation — and the alias arm declines rather than guessing when
 * it is absent.
 */
export interface HostRow { readonly rel: Rel; readonly aliases: AliasMap; }

/**
 * WHAT A CORRELATED PREDICATE IS FILTERING — a total union over the traverser SHAPE, exactly as
 * `ChildHost` is, and for the identical reason.
 *
 * The filter vocabulary is not element-only and never was: `and`/`or`/`not`/`filter`/`where`/`is` are
 * questions about a TRAVERSER, and a Gremlin traverser is an element in some positions and a value in
 * others. Carrying `Elem` as a second parameter beside an element-shaped `Subject` made that
 * assumption structural — every arm took an `elem` it could not have been given for
 * `g.V().values('age').and(is(P.gt(30)), is(P.lt(40)))`, so the whole connective family declined over
 * a scalar stream while working over an element one. That is a composition the language admits and
 * the algebra can express, so it was a missing feature rather than a boundary.
 *
 * Folding `elem` INTO the union is what makes the shape decidable at each arm rather than assumed by
 * the signature: an element-only clause (`hasLabel`, `has`, `hasId`) reads `subject.elem` after
 * narrowing and declines on the scalar arm, while a shape-independent one never looks.
 *
 * On the element arm, `label` is present only where the relation physically carries it — an edge SCAN
 * does, a moved id-relation does not — so the edge label test can take the direct column read at the
 * source and the membership form elsewhere, without either position having to know which it is in.
 * On the scalar arm, `type` is what the stream knows about its own values (the same fact
 * `predicateExpr` takes) and `vtype` the column carrying it per row, where there is one.
 */
export type Subject =
  | { readonly kind: 'element'; readonly id: Expr; readonly label?: Expr; readonly rel: Rel; readonly elem: Elem }
  | { readonly kind: 'scalar'; readonly value: Expr; readonly vtype?: Expr; readonly rel: Rel; readonly type: SubjectType }
  /** A PROPERTY traverser as a filter/branch subject — the third traverser shape a correlated body can
   *  be rooted at, mirroring the `property` `ChildHost`. It carries no `value`/`type`: a property is not
   *  a scalar, so a value predicate (`is`) declines on it and a body-over-property folds through the
   *  property host (`key()`/`value()`/`element()` retype it). `ownerElem` distinguishes the owners the
   *  same way the host does. Correlated by the stored row's own rowid (`id`). */
  | { readonly kind: 'property'; readonly id: Expr; readonly ownerElem: Elem; readonly rel: Rel };

/**
 * A ROOTED chain, lowered — the relation plus what it holds and what it ran first.
 *
 * Deliberately POLICY-FREE: the seam answers what the chain IS, and each consumer applies its own
 * admission rule over that answer. An `addE` endpoint wants a vertex relation with no effects; a set-op
 * operand wants a list framing. Putting either test in here would make the seam the union of its
 * callers' requirements, which is the shape it exists to collapse.
 */
export interface RootedRead {
  readonly rel: Rel;
  readonly framing: RelFraming;
  /** The statements this chain runs before its result is read — absent for every pure read. */
  readonly effects?: readonly Binding[];
}
