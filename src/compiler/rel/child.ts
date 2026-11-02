import { compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../elem.ts';
import type { AliasMap } from '../alias.ts';
import type { IRStep } from '../ir/step.ts';
import type { Binding } from '../../rel/plan.ts';
import type { MapKeyFacts, RecordField, RelFraming } from './framing.ts';
import type { SubjectType } from './predicate.ts';
import type { ListOf, ScalarType } from '../../sql/kernel/render.ts';
import type { ProgramWrites } from './write.ts';
import type { ProgramScopeNames } from '../ir/labels.ts';
import type { SideEffectConstants } from '../../gremlin/frontend.ts';

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
  readonly sideEffects: SideEffectConstants;
  /** EVERY NAME A SCOPE READ MAY RESOLVE PAST THE TRAVERSER'S OWN MAP, program-wide — every side-effect
   *  key (not only the `withSideEffect` constants above: an `aggregate('w')` anywhere registers `w` at
   *  every step) and every path label (`programScopeNames`, `ir/labels.ts`). A reader that cannot see a
   *  scope asks this whether the name may be bound there, and fails closed where it may. */
  readonly scopeNames: ProgramScopeNames;
  /** WHAT THE WHOLE PROGRAM WRITES — a compile-scope fact for the same reason the two environments above
   *  are: a write's runtime value body is a nested argument, and whether it can observe another
   *  traverser's write is a question about every write in the program (`sequentialGuard`). */
  readonly writes: ProgramWrites;
  /** A correlated sub-traversal as ONE VALUE over the host traverser, or `null` to decline. */
  readonly scalar: (body: readonly IRStep[], host: ChildHost) => ChildValue | null;
  /** A correlated sub-traversal as a BOOLEAN over the subject row, or `null` to decline. `aliases` is
   *  the ROW'S path-label scope, the predicate twin of `ChildHost.row`: a `select(<label>)` in the body
   *  re-roots off it (`childPredicate`), so a caller holding a carrying table passes its labels and a
   *  body reading an outer label is answered rather than read as unbound. Absent = no labels in scope. */
  readonly predicate: (body: readonly IRStep[], subject: Subject, negated: boolean, aliases?: AliasMap) => Expr | null;
  /** A ROOTED chain — one correlated to nothing — lowered as a relation, or `null` to decline. */
  readonly rooted: (steps: readonly IRStep[]) => RootedRead | null;
  /** The ONE element an outer `id` names, as a fold-ready element source CORRELATED to the outer row
   *  (`anchoredSeed`) — what a body that must start AT a bound element walks from, inside an `exists`
   *  subplan. `rooted([V()])` joined back on the id is the same rows at ~N² cost. */
  readonly anchored: (elem: Elem, id: Expr) => RootedRead;
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
   *
   * `originFrom` names the INPUT column the origin is seeded from — the host's `id` by default. A
   * write host passes its snapshot's POSITION instead (`ord`), because an element id does not name a
   * TRAVERSER: `g.V(2,4).in().property(…)` visits marko twice, and the reference runs the value body
   * once per traverser (`AddPropertyStep.sideEffect`), so two traversers on one vertex must stay two
   * origins rather than pooling into one whose row count would read as a multi-valued result.
   */
  readonly rows: (body: readonly IRStep[], input: Rel, elem: Elem, aliases: AliasMap, originFrom?: string) => ChildRows | null;
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
   * The value as its self-describing `{t,v}` MEMBER NODE, built from ONE correlated read — set only
   * where the producer reads the value and its tag off the same row (a bare stored `values(k)`), so a
   * map key/value or a collected member keeps its type (`memberNodeOf`, `modulator.ts`) without paying
   * for the tag as a second subquery spelled at every mention. Absent, the node is composed from
   * `expr` and `vtype`, which is the same answer at a plan cost.
   */
  readonly node?: Expr;
  /**
   * DID THIS BODY PRODUCE ANYTHING for this host row — the productivity signal, stated by the arm that
   * built the expression.
   *
   * PRESENCE IS VALUE NULLNESS: a NULL value is an ABSENT one. That is SQL's natural reading and a
   * deliberate divergence from `TraversalProduct`, which keeps a PRODUCTIVE null (`constant([null])
   * .unfold().sum()`) as a value — here it is treated as "nothing came", so a `project()` omits the key,
   * a `select()`/`order()`/`dedup()`/`sack()` drops the traverser, an `aggregate()` collects nothing.
   *
   * - `'always'` — the body cannot be unproductive (a `fold()`/`count()` seeds, a token, the traverser
   *   itself), so a consumer owes no drop; a NULL it yields is kept as a null.
   * - `'value-nullness'` — the body produced exactly where `expr IS NOT NULL` (`presenceOf`).
   * - `'unknown'` — the arm cannot say; a consumer that needs presence DECLINES on it.
   * - `{ when }` — the body produced exactly where `when` holds, and a NULL value under it is a
   *   PRODUCTIVE null. Stated by an arm whose productivity is not its value's nullness and is cheap to
   *   test on its own: a re-sourced body's first value (`map(__.V().choose(…, constant(null)).order()
   *   .limit(1))`), whose presence is an uncorrelated EXISTS over the one fenced row it read the value
   *   from. A consumer that keeps productive nulls (`map()`, a write, a `group()` member node —
   *   `gatedOn`, `modulator.ts`) filters on `when`; one that reads `presenceOf` gets it for free; one that
   *   drops a null value anyway (an ordering/dedup `by()`, §17) still may.
   *
   * REQUIRED, as `yields` and `framing` are: only the arm that built the expression knows, and an
   * OPTIONAL field read "the producer forgot" and "the producer cannot say" as one silence.
   */
  readonly present: Presence;
}

/** A child body's PRODUCTIVITY — see `ChildValue.present`. Never absent. */
export type Presence = 'always' | 'value-nullness' | 'unknown' | PresentWhen;

/** A presence STATED as its own per-row predicate (`ChildValue.present`'s `{ when }`). `orValue`: the body
 *  ALSO produced wherever its value is non-null — a `coalesce` whose earlier arms answer by value and whose
 *  final arm states its own presence. A flag rather than the OR spelled into `when`, so a consumer that
 *  projects the value (`reductionTail`) tests the column instead of reading the value a second time. */
export interface PresentWhen { readonly when: Expr; readonly orValue?: true }

/** A HOST's presence (`ChildHost.present`) — never a stated predicate: a body over the host narrows its
 *  presence to its value's nullness (an `is()`, a `drop` projector, `valueRun`), and narrowing a `{ when }`
 *  that way would read a NULL the filter made as a productive null. */
export type HostPresence = Exclude<Presence, PresentWhen>;

/** A constant TRUE, the per-row predicate `presenceOf` answers for `'always'` — ONE shared object, so a
 *  consumer can test it by reference and spend no `CASE`/filter on it. SQLite folds it. */
export const ALWAYS_PRODUCTIVE: Expr = { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(1) };

/** The presence as a per-row predicate over the body's VALUE — `ALWAYS_PRODUCTIVE` for `'always'`,
 *  `value IS NOT NULL` for `'value-nullness'`, the stated predicate for `{ when }`, or `null` to DECLINE
 *  on `'unknown'`. One function so "decline on unknown" is spelled once. */
export const presenceOf = (present: Presence, value: Expr): Expr | null =>
  present === 'unknown' ? null : present === 'always' ? ALWAYS_PRODUCTIVE
    : present === 'value-nullness' ? isNotNullExpr(value)
      : statedPresence(present, value);

/** A `{ when }` presence as a predicate, given where the VALUE can be read — the value expression itself,
 *  or the column a consumer projected it to. */
export const statedPresence = (present: PresentWhen, value: Expr): Expr =>
  present.orValue ? { kind: 'binary', op: 'or', left: isNotNullExpr(value), right: present.when } : present.when;

const isNotNullExpr = (value: Expr): Expr => ({ kind: 'binary', op: 'is not', left: value, right: compilerNull() });

/**
 * IS THE HOST THERE AT ALL — its own `present` as a per-row predicate over its key (an element's `id`,
 * a scalar's `value`): `ALWAYS_PRODUCTIVE` for a host that cannot be absent (every host but a
 * possibly-unbound label or an intermediate value), `null` to DECLINE where it cannot say.
 *
 * ONE authority for "absent label ⟹ the body's INPUT is empty". A body step that reads THROUGH the key
 * (`values(k)`, `label()`, a movement) already answers nothing for a NULL key; one that reads the ROW or
 * nothing at all (`constant()`, `sack()`, a nested `select()`, the self-rooted one-row relation) must be
 * gated by this, or an unbound label reads as one phantom traverser.
 */
export const hostPresence = (host: ChildHost | Subject): Expr | null =>
  host.kind === 'element' ? presenceOf(presentOfHost(host), host.id)
    : host.kind === 'scalar' ? presenceOf(presentOfHost(host), host.value)
      : ALWAYS_PRODUCTIVE;

/** The host's own `present` as a `Presence` — `'always'` where it carries none (every host but a
 *  possibly-unbound label or an intermediate value). What a body that IS the host reports. */
export const presentOfHost = (host: ChildHost | Subject): Presence =>
  (host.kind === 'element' || host.kind === 'scalar') ? host.present ?? 'always' : 'always';

/** `value` where the host is present, NULL where it is not — `CASE WHEN <present> THEN value END`, and
 *  `value` itself (no per-row term) for a host that cannot be absent. `null` declines with `hostPresence`. */
export const gatedByHost = (host: ChildHost | Subject, value: Expr): Expr | null => {
  const present = hostPresence(host);
  if (!present) return null;
  return caseWhen(present, value);
};

/** `CASE WHEN <pred> THEN value ELSE otherwise END` — `otherwise` NULL ("nothing") unless given — and
 *  `value` itself, no per-row term, where `pred` is the constant `ALWAYS_PRODUCTIVE`. The one spelling of
 *  a presence gate, shared by `gatedByHost` and a member node's `gatedOn` (`modulator.ts`). */
export const caseWhen = (pred: Expr, value: Expr, otherwise: Expr = compilerNull()): Expr =>
  pred === ALWAYS_PRODUCTIVE ? value : { kind: 'case', whens: [[pred, value]], else: otherwise };

/** The host as seen INSIDE a value already gated on its presence (`gatedByHost`): present by
 *  construction there, so a body built under the gate owes no second copy of the same term. The caller
 *  must gate the result on the ORIGINAL host. */
export const presenceDischarged = <H extends ChildHost>(host: H): H =>
  mayBeAbsent(host) ? { ...host, present: 'always' } : host;

/** A host that may be ABSENT on some rows — its `hostPresence` is not the constant truth. */
export const mayBeAbsent = (host: ChildHost | Subject): boolean => presentOfHost(host) !== 'always';

/** The presence of arms whose value is one value's nullness: every arm `'always'` ⟹ `'always'`; any arm
 *  `'unknown'` ⟹ `'unknown'`; otherwise the value's nullness. A stated arm answers `'unknown'` here — a
 *  productive null under it would read as absent — so a CHOICE between arms goes through
 *  `choicePresence`, which names each arm's predicate. */
export const meetPresence = (arms: readonly Presence[]): Presence =>
  arms.every((p) => p === 'always') ? 'always' : arms.some((p) => p === 'unknown') ? 'unknown'
    : arms.some((p) => typeof p === 'object') ? 'unknown' : 'value-nullness';

/** A constant FALSE — the slot a `'value-nullness'` arm takes in a choice's presence `CASE`, where the
 *  outer `orValue` (the CHOSEN arm's value is the choice's value) answers for it. SQLite folds it. */
const NEVER_PRODUCTIVE: Expr = { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(0) };

/** One arm of a CHOICE: taken where `when` holds (the first arm that does), with its own presence. */
export interface ChoiceArm { readonly when: Expr; readonly present: Presence }

/**
 * THE PRESENCE OF A CHOICE — `CASE WHEN g1 THEN … ELSE … END` over `arms`, `otherwise` the `ELSE` arm's —
 * built from the SAME guards as the value's `CASE`, so the two cannot disagree on which arm was chosen. The
 * chosen arm's productivity is the whole's: a productive null in it keeps its row and an unproductive chosen
 * arm drops it (`TraversalMapStep` over `BranchStep`'s chosen branch,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java`).
 *
 * With no STATED arm this is `meetPresence` — the chosen value's nullness, or `'always'`. With one, each arm
 * fills its slot of a presence `CASE`: a stated arm its `when`, an `'always'` arm `ALWAYS_PRODUCTIVE`, a
 * `'value-nullness'` arm FALSE — and `orValue` is then set, because the choice's value IS the chosen arm's,
 * so "the value is non-null" answers for that arm (and for an arm that itself carries `orValue`). `orValue`
 * is set ONLY where an arm needs it, so a choice of stated/`'always'` arms spends no `value IS NOT NULL`
 * term; every slot the same expression folds to it.
 */
export const choicePresence = (arms: readonly ChoiceArm[], otherwise: Presence): Presence => {
  const all = [...arms.map((a) => a.present), otherwise];
  if (!all.some((p) => typeof p === 'object')) return meetPresence(all);
  if (all.some((p) => p === 'unknown')) return 'unknown';
  const slots = all.map((p): Expr => typeof p === 'object' ? p.when : p === 'always' ? ALWAYS_PRODUCTIVE : NEVER_PRODUCTIVE);
  const when: Expr = slots.every((s) => s === slots[0]) ? slots[0]!
    : { kind: 'case', whens: arms.map((a, i) => [a.when, slots[i]!] as const), else: slots.at(-1)! };
  const orValue = all.some((p) => p === 'value-nullness' || (typeof p === 'object' && p.orValue));
  return orValue ? { when, orValue: true } : { when };
};

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
 * THE TYPE TAG A SCALAR HOST CARRIES — its per-row `vtype` where it has one, else its STATIC tag as a
 * compiler literal (the same fact, constant-folded), else nothing. Every scalar host that knows a type
 * is built through this, because a host that dropped its static tag read as STORAGE evidence downstream:
 * a `constant(true)` is SQLite's integer 1, so `math('_+1')` over it passed the Number check and
 * answered `2.0` where `MathStep` raises
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:80-87`).
 * `receiver.ts`'s `evidenceOf` reads a compiler-text tag back as static, so the receiver checks decide
 * it at compile time, and `byNode` frames with it rather than inferring from the JS value (§6·7).
 */
export const hostTag = (type: ScalarType | undefined, vtype: Expr | undefined): Expr | undefined =>
  vtype ?? (type?.kind === 'static' ? compilerText(type.type) : undefined);

/**
 * The traverser a child body is rooted AT — a union rather than a bag of optional fields, because the
 * two cases admit DIFFERENT projections and the type is what makes that visible: an element has
 * properties and tokens, a scalar value has neither. `vtype` is present only where the value came from
 * a stored property, which is the same distinction `predicateExpr`'s `compare` parameter draws.
 */
export type ChildHost =
  | { readonly kind: 'element'; readonly id: Expr; readonly elem: Elem; readonly row?: HostRow;
      /** WHETHER THE HOST IS THERE AT ALL — `'value-nullness'` where it is a LABEL that may be unbound on
       *  this row (`selectRerootHost`, set from `aliasGuard`: a label first bound inside a branch arm, an
       *  `optional()` or a repeat body), so a NULL `id` means "the body's INPUT is empty". ABSENT
       *  (`'always'`) for every other element host, which keeps their SQL byte-identical. Read through
       *  `hostPresence`; an element's id is never a null VALUE, so the reading is exact here. */
      readonly present?: HostPresence }
  | { readonly kind: 'scalar'; readonly value: Expr; readonly vtype?: Expr; readonly row?: HostRow;
      /** WHETHER A NULL `value` IS A VALUE (as `ChildValue.present`). ABSENT (`'always'`) where the host
       *  is a TRAVERSER — a traverser's NULL is a null value. `'value-nullness'` where the host is an
       *  INTERMEDIATE value whose NULL means "nothing": a child value run's value past an `is()` filter or
       *  over an absent property (`valueRun`), a `select(k)` of an absent map key, a `select(<label>)` of a
       *  label unbound on this row. A type-demanding consumer (`math()`'s variables, `receiver.ts`) raises
       *  on a NULL only where it is a value. */
      readonly present?: HostPresence;
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
   *  value to project). `map` is the value expression (a JSONB object); `keyOf`/`valOf` its encodings.
   *  Its KEY FACTS are the framing's (`MapKeyFacts` — `keys` MAY, `held` MUST), which a `select(<key>)`
   *  child body or a `format('%{key}')` needs for TinkerPop's map-key-vs-alias precedence exactly as
   *  `mapTail`'s chain-level `select` does, read through the one `mapKeyPresence`. */
  | ({ readonly kind: 'map'; readonly map: Expr; readonly keyOf: import('../../sql/kernel/render.ts').MapOf; readonly valOf: import('../../sql/kernel/render.ts').MapOf; readonly row?: HostRow } & MapKeyFacts);

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
export interface HostRow {
  readonly rel: Rel;
  readonly aliases: AliasMap;
  /** The host is a NEW traverser the reference GENERATES for this body, not a split of the row's own —
   *  see `freshTraverserRow`. Its path, labels, sack and loops are not the row's. */
  readonly fresh?: true;
}

/** No alias in scope — a fresh traverser's path holds nothing (a module-local twin of `chain.ts`'s
 *  `NO_ALIASES`, which this module cannot import without a cycle). */
const NO_LABELS: AliasMap = new Map();

/**
 * THE ROW OF A BY() RUN ON A SCOPE VALUE — one authority for every host that resolves a LABEL (a select key,
 * a `where(a, P(b))` key, a `dedup(a)` key, a `math()` variable) and then applies a `by()` to it.
 *
 * The reference runs that `by()` through `TraversalUtil.produce(S start, traversal)`, which GENERATES a new
 * traverser for the value (`traversal.getTraverserGenerator().generate(start, …, 1L)`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:125-130`;
 * `SelectOneStep.java:64`, `SelectStep.java:70`, `WherePredicateStep.java:98,135`, `DedupGlobalStep.java:82`,
 * `MathStep.java:73`) — not a split of the current one. So the body sees NO path and NO labels, and the
 * INITIAL sack (`B_O_S_SE_SL_Traverser.java:43-44`): `V().as('a').select('a').by(select('a'))` is EMPTY, and
 * `select('a').by(sack())` reads the seed, never the running sack. The row stays (the scope value is a column
 * of it), but its alias scope is empty and `fresh` tells every state reader (`sack()`/`loops()`) it may not
 * read the row's channels.
 */
export const freshTraverserRow = (rel: Rel): HostRow => ({ rel, aliases: NO_LABELS, fresh: true });

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
  | { readonly kind: 'element'; readonly id: Expr; readonly label?: Expr; readonly rel: Rel; readonly elem: Elem;
      /** As `ChildHost`'s: `'value-nullness'` where the subject is a label unbound on some rows
       *  (`selectRerootSubject`), absent otherwise. */
      readonly present?: HostPresence }
  | { readonly kind: 'scalar'; readonly value: Expr; readonly vtype?: Expr; readonly rel: Rel; readonly type: SubjectType;
      readonly present?: HostPresence }
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
