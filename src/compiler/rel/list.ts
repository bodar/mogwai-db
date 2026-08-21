import { col, compilerInt, compilerNull, compilerText, lit, type Expr } from '../../rel/expr.ts';
import { sliceBound } from './const.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Binding, Guard } from '../../rel/plan.ts';
import type { SortTerm } from '../../rel/types.ts';
import { hasTypedMembers, memberTypeOf, sameScalarType, perRowColumnOf, PER_ROW_ENVELOPE, SCALAR_MEMBERS, STATIC, staticTypeOf, TYPED_MEMBERS, UNKNOWN, withMemberType, type ListOf, type MapOf, type MixedArm, type ScalarType, type Shape } from '../../sql/kernel/render.ts';
import { isNested, isPred, argValues } from '../../gremlin/frontend.ts';
import { GLOBAL_STRING_THROWS, isLocalScope, LIST_LOCAL_TX, sliceOf, sliceParamNames, STRING_LOCAL_TX } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { ChildSeam } from './child.ts';
import type { RelFraming } from './framing.ts';
import { byEncounter, carriedCols, coalesce, collectedArray, collectedOf, EMPTY_ARRAY, fenced, jsonMember, jsonMemberByTypeof, jsonOf, listNode, mapNode, meta, typedNode, typeOf, withPayload, type Minter } from './build.ts';
import { predicateExpr, storedCompareOn, SUBJECT_UNKNOWN } from './predicate.ts';
import { ValueParseError } from '../../gremlin/coerce.ts';
import { byExpr, modulations, orderProductivity } from './modulator.ts';
import { elementNode, elementObject } from './element.ts';
import type { Elem } from '../plan/plan.ts';
import { isLongSumClass, isReducer, reducerAggregate, sumTower } from './reducer.ts';
import { transformExpr } from './transform.ts';

/**
 * THE LIST VOCABULARY — a traverser whose VALUE is a collection, and the ops that read its members.
 *
 * The fifth vocabulary module (after `predicate.ts`, `modulator.ts`, `transform.ts` and
 * `reducer.ts`), and ranked first by `mise run rel-blockers`: **the list shape blocks 194 corpus
 * traversals, the largest family on the board.** It splits by FRAMING ARM rather than by step — the
 * `jsonbList` arm alone is 72, and both halves of it (a `fold()` barrier and a collection LITERAL)
 * frame identically, so one arm serves both.
 *
 * ## The member FRAME is the whole idea
 *
 * Every list op is the same shape: `json_each` the list, do something per member, put it back. The
 * "something" is a vocabulary this project already has — `transform.ts` applied to a member,
 * `predicate.ts` over a member, `reducer.ts` over a member — which is why the frame is what was
 * missing and not the operations. Here that frame is `membersOf` + `listOfMembers`, one home instead
 * of a hand-written correlated subquery per op.
 *
 * **A member op is a CORRELATED SCALAR SUBQUERY, never a relation-level explode**, and that matters
 * for a reason the SQL makes obvious: the list is ONE traverser, so exploding it at relation level
 * would multiply the stream's rows and then need re-grouping by a row identity the algebra does not
 * carry. `Explode` with no `input` is exactly `FROM json_each(<outer expr>)` — the sole-FROM form —
 * and that is why that field is optional.
 *
 * ## What this module does NOT do
 *
 * `null` is the only decline, as in every vocabulary module here. In particular a string transform
 * WITHOUT `Scope.local` is a permanent type error on a collection — TinkerPop's own message is `The
 * toUpper() step can only take string as argument` — so this declines rather than inventing an answer
 * of its own.
 *
 * BOTH scalar member encodings are served: a BARE list, and a SELF-DESCRIBING one whose members may
 * be `{t,v}` nodes (what `fold()` over a per-row-typed stream produces). `memberPayload`/`memberNode`
 * are the two reads and every op goes through one of them, which is what lets a typed list flow
 * through the same code as an untyped one instead of failing closed.
 *
 * An ELEMENT list and a NESTED list are the two that need an EXPANSION rather than a decode, and both
 * now have one at the ROOT only (`listPayloadExpr`). An element list's members stay ROWIDS for the
 * whole of their life inside the algebra — `foldElements` collects them, `unfoldList` hands them back
 * as an ordinary element relation, and only `listPayload` expands them into public payload objects.
 * That is what makes the round trip lossless (a payload object has no rowid to move from) and what
 * keeps a discarded member free: `fold().range(local,0,2)` computes two property bags, not six. The
 * MEMBER OPS still decline an element list — `isBareList` gates every one of them — because a member
 * TRANSFORM or a member PREDICATE over a rowid is a question about the element, not about the value,
 * and that is the child seam's question rather than this module's.
 */

/** The member relation's columns: the value, its position in the list (`json_each.key`, which for a
 *  JSON array IS the index), and its JSON type — the only way to tell a `{t,v}` ENVELOPE from a bare
 *  value, because `json_each` has already extracted the member and `json_type()` errors on a bare
 *  string. Named once because every op reads them. */
const MEMBER = { value: 'mv', ord: 'mo', type: 'mt' } as const;

/** A list's MEMBERS as a relation — `FROM json_each(<list>)`, correlated to whatever relation the
 *  list expression came from. No `input`, which is what makes it correlated (see `rel.ts`). */
const membersOf = (list: Expr, fresh: Minter): Rel => make.explode({
  id: fresh('mx'), expr: list, channels: [], as: MEMBER,
  type: typeOf(meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
});

const memberOrder = (members: Rel, dir: 'asc' | 'desc' = 'asc'): SortTerm =>
  ({ expr: col(members.id, MEMBER.ord), dir });

/**
 * THE TWO WAYS TO READ A MEMBER, and which one an op needs is decided by what it does with it.
 *
 * A `typed` list's members are self-describing `{t,v}` nodes IF the producer wrapped them (a fold
 * whose members are all storage-class-determined stays bare, uniformly per list), so the unwrap is
 * CONDITIONAL on `json_each`'s own type column rather than on the compile-time flag alone.
 *
 * - **PAYLOAD** — the comparable, filterable value. Everything that compares, filters, aggregates or
 *   hands the value onward reads this: ordering a raw `{"t":"int","v":5}` would sort JSON text.
 * - **NODE** — the whole member as it must be written BACK into a rebuilt list, so a subset or a
 *   reorder keeps each member's exact type. `json()` around the envelope is load-bearing: without it
 *   `json_group_array` re-encodes the object as a JSON STRING, which is the double-encoding
 *   corruption a fail-closed guard used to exist for.
 */
const memberPayload = (of: ListOf, members: Rel): Expr => {
  const value = col(members.id, MEMBER.value);
  return isTypedList(of)
    ? {
      kind: 'case',
      // `json_extract(x, '$.v')` rather than SQLite's `->>` operator: the same SQL value, and the
      // node set stays closed (§3.3 — a construct missing from it is a derived form).
      whens: [[eqText(col(members.id, MEMBER.type), 'object'), jsonField(value, 'v')]],
      else: value,
    }
    : value;
};

/** Takes any relation carrying the MEMBER columns — the explode itself, or a slice over it, since a
 *  node addresses its own INPUT. */
const memberNode = (of: ListOf, members: Rel): Expr => {
  const value = col(members.id, MEMBER.value);
  return isTypedList(of)
    ? {
      kind: 'case',
      whens: [[eqText(col(members.id, MEMBER.type), 'object'), { kind: 'call', fn: 'json', args: [value] }]],
      else: value,
    }
    : value;
};

/** A member's own TYPE tag, for a reader that keeps the per-member type rather than the value —
 *  `unfold()` over a typed list, whose members frame by their own `vtype`. A bare member has no tag
 *  recorded, so its type is INFERRED from the storage class, which is what the wire would do anyway. */
const memberVtype = (of: ListOf, members: Rel): Expr | undefined => {
  if (!isTypedList(of)) return undefined;
  return {
    kind: 'case',
    whens: [[eqText(col(members.id, MEMBER.type), 'object'), jsonField(col(members.id, MEMBER.value), 't')]],
    else: inferredVtype(col(members.id, MEMBER.value)),
  };
};

/**
 * A MEMBER'S GREMLIN TYPE, from whichever carrier the list uses — the third member read, and the one
 * whose absence made every list op compare by SQLite storage class.
 *
 * `memberVtype` above answers only for a self-describing list, because that is all `unfold()` needs.
 * Everything that COMPARES needs an answer for all three: a `static` list states its tag at compile
 * time (a literal, which `storedCompareOn` then constant-folds away), an envelope list states it per
 * member, and an untagged one infers it from the storage class — which is exactly what the wire
 * would do, so it is not a second policy.
 */
const memberTypeTag = (of: ListOf, members: Rel): Expr => {
  const type = memberTypeOf(of);
  if (type?.kind === 'static') return compilerText(type.type);
  return memberVtype(of, members) ?? inferredVtype(col(members.id, MEMBER.value));
};

/**
 * THE MEMBER'S ORDERING KEY — `storedCompareOn` over the member's own type, which is the SAME cast
 * authority `order().by()`, the row-level `min`/`max` and every range predicate use.
 *
 * Without it a member compares by SQLite STORAGE CLASS, and a value carried as decimal TEXT because
 * it does not fit one (a long past 2^53, a bigint, a bigdecimal, a duration) compares
 * LEXICOGRAPHICALLY. Measured before this existed:
 * `inject(9007199254740993L, 10007199254740993L).fold().max(Scope.local)` answered the SMALLER value
 * and `min(Scope.local)` the larger, while the global `max()` — which already had this authority —
 * answered correctly.
 */
const memberCompareKey = (of: ListOf, members: Rel): Expr => {
  const value = col(members.id, MEMBER.value);
  const type = memberTypeOf(of);
  if (type?.kind === 'static') return storedCompareOn(compilerText(type.type))(value);
  // AN UNTAGGED MEMBER IS ITS OWN KEY, and that is provable rather than a shortcut: its type is
  // INFERRED from its storage class, and that inference can never disagree with the storage order —
  // TEXT infers `string` (no cast at all), INTEGER infers `int`/`long` (a CAST to INTEGER is the
  // identity) and REAL infers `double` (likewise). So the cast folds away, and emitting it would be
  // pure statement text. The same argument retires `inferredVtype` from the ORDERING key of a
  // self-describing list: only the WRAPPED members can carry a type their storage class does not.
  if (!isTypedList(of)) return value;
  return {
    kind: 'case',
    whens: [[eqText(col(members.id, MEMBER.type), 'object'),
      storedCompareOn(jsonField(value, 't'))(jsonField(value, 'v'))]],
    else: value,
  };
};

const eqText = (subject: Expr, value: string): Expr => ({ kind: 'binary', op: '=', left: subject, right: compilerText(value) });
const jsonField = (node: Expr, field: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [node, compilerText(`$.${field}`)] });

/** The members BACK to a list value. `collected` is the shared idiom (`build.ts`) and carries the two
 *  non-derivable facts; this names the COLUMN a list relation carries them in. */
const listOfMembers = (members: Rel, member: Expr, order: readonly SortTerm[], fresh: Minter): Expr =>
  collectedOf(members, member, order, LIST_COL, fresh);

/** The list column every list relation carries. One name, because the framing layer reads it too. */
export const LIST_COL = 'list';

/** Replace a relation's list value, keeping every other column (and channel) exactly as it was — the
 *  shape every member op that STAYS a list produces. */
const withList = (rel: Rel, list: Expr, fresh: Minter): Rel => make.project({
  id: fresh('lv'), input: rel, channels: rel.channels, type: rel.type,
  exprs: rel.type.cols.map((column) =>
    [column.name, column.name === LIST_COL ? list : col(rel.id, column.name)] as const),
});

/** An UNTAGGED list of scalars — what a member REWRITE always produces, since a transformed member
 *  is a native value the stored type no longer describes, so the output is framed by per-value
 *  inference. Note this is the `unknown` member type and NOT "no type":
 *  a rewrite that KNOWS the result class says so with `withMemberType(of, STATIC(…))`. */
export const BARE_LIST: ListOf = SCALAR_MEMBERS;

const isTypedList = hasTypedMembers;

/** Is this list's member encoding one this module can read? Every scalar member type — untagged,
 *  statically tagged and self-describing — but not an ELEMENT or a nested list, whose members are
 *  rowids and sub-lists respectively and need their own expansion. */
export const isBareList = (of: ListOf): boolean => of.kind === 'scalar';

/**
 * A bare member's canonical Gremlin type, inferred from its SQLite storage class. It is the same
 * inference the wire would apply to an untagged value,
 * so naming it here is not a second policy: it is what lets a MIXED list (some members wrapped, some
 * bare, which is exactly what `typed` means) hand every member a type without a second channel.
 */
export const inferredVtype = (value: Expr): Expr => ({
  kind: 'case',
  whens: [
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'text'), compilerText('string')],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'real'), compilerText('double')],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'null'), compilerNull()],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'integer'), {
      kind: 'case',
      whens: [[{ kind: 'binary', op: 'and',
        left: { kind: 'binary', op: '>=', left: value, right: compilerInt(-2147483648) },
        right: { kind: 'binary', op: '<=', left: value, right: compilerInt(2147483647) } }, compilerText('int')]],
      else: compilerText('long'),
    }],
  ],
  else: compilerText('string'),
});

/**
 * ONE member predicate for `all`/`any`/`none`, null-aware.
 *
 * `P.eq(null)`/`P.neq(null)` cannot go through the ordinary predicate builder: SQL's `= NULL` is
 * NULL, so a null member would never satisfy an `eq(null)`. TinkerPop compares with
 * `Objects.equals`. Getting this wrong answered `IS NULL` for EVERY `eq` — see
 * `test/L4-addendum/list-member-predicate.feature`.
 */
const memberPredicate = (member: Expr, pred: unknown, resolveScalar?: (nested: unknown) => Expr | null): Expr | null => {
  if (isPred(pred) && (pred.op === 'eq' || pred.op === 'neq') && pred.operands[0]?.value === null)
    return { kind: 'binary', op: pred.op === 'eq' ? 'is' : 'is not', left: member, right: compilerNull() };
  return predicateExpr(member, pred, SUBJECT_UNKNOWN, null, null, undefined, undefined, resolveScalar);
};

/** The member ops that HOST a `by()`, so the blanket modulator decline must exempt exactly these two —
 *  `order(Scope.local)` takes a COMPARATOR and `dedup(Scope.local)` a projection. Named for `BY_READERS`'
 *  reason (`lower.ts`): the blanket guard was written before either arm could read a modulator and then
 *  kept declining `order(Scope.local).by(desc)` — a form whose whole content is the comparator, and whose
 *  arm below had been able to answer it all along. A host added to an arm without being added here
 *  silently loses its modulator, which is the failure mode the modulator seam exists to end. */
const LOCAL_BY_HOSTS: ReadonlySet<string> = new Set(['order', 'dedup']);

/**
 * THE LOCAL STRING-TRANSFORM MEMBER-TYPE GUARD — a graph-independent, VALUE-level guard binding.
 *
 * `StringLocalStep.map` throws on any member that is neither null nor a String, per member
 * (`vendor/tinkerpop/gremlin-core/.../step/util/StringLocalStep.java:54-58`): a null member is kept,
 * a String is transformed, ANYTHING ELSE raises `"The <step>(local) step can only take string or list
 * of strings, encountered <class> in list"`. The member type here is PER-ROW (a typed list's `{t,v}`
 * tag) or UNKNOWN (an untagged member's storage class) — never a compile-time `static` tag — so the
 * check cannot be a decline (that would refuse the valid all-string case `values('name').fold()`) and
 * cannot silently coerce (SQLite `upper(1)` = `'1'` is the wrong ANSWER §12). It is a runtime guard:
 * the members whose type tag is NON-NULL and NOT `'string'` are the offenders, and one such row raises.
 *
 * This is the guard-binding family (§6·5) applied to a VALUE rather than a graph row — the same
 * `Binding.guard` mechanism `elementIdGuard`/`mergeE` use, over `json_each(list)` instead of a table.
 * The message is the reference's verbatim up to the corpus-checked prefix (`raise an error with
 * message containing text of "…string or list of strings"`); the offending `<class>` interpolation is
 * omitted because `Guard.valueColumn` APPENDS to the message and the reference spells the class
 * mid-sentence, and no scenario checks past the prefix.
 *
 * The offender predicate is "non-null AND non-string" and it is spelled to compute the type ONCE. An
 * UNTYPED member is exactly its storage class, so `typeof(value) NOT IN ('text','null')` is both the
 * short form AND the correct one (`inferredVtype` maps `text→string`, `null→null`, everything else to a
 * non-string). A TYPED (`{t,v}`) member can carry a type its storage class hides (a bigint as decimal
 * TEXT), so it must read the tag — but `COALESCE(memberTypeTag, 'string') != 'string'` folds the null
 * case in and names the tag once rather than the twice a separate `IS NOT NULL` would.
 */
function nonStringMember(of: ListOf, members: Rel): Expr {
  const value = col(members.id, MEMBER.value);
  if (!isTypedList(of)) return {
    kind: 'unary', op: 'not',
    arg: { kind: 'in-list', expr: { kind: 'call', fn: 'typeof', args: [value] }, values: [compilerText('text'), compilerText('null')] },
  };
  return {
    kind: 'binary', op: '!=',
    left: { kind: 'call', fn: 'coalesce', args: [memberTypeTag(of, members), compilerText('string')] },
    right: compilerText('string'),
  };
}

function localStringMemberGuard(step: IRStep, of: ListOf, input: Rel, fresh: Minter): Binding {
  // The guard is its OWN statement, so it fences `input` inside its own tree — self-contained, and the
  // shared relation ids cannot collide across two independent statements' alias namespaces. It reads the
  // SAME list the main read does; a re-fold of a graph aggregate is one extra statement, inside P5. The
  // explode is ROOTED at `source` (an `input`, not the sole-FROM correlated form `membersOf` builds for
  // an OUTER row) so the `json_each` sees the fence's `list` column within the guard's own query.
  const source = fenced(input, fresh);
  const members = make.explode({
    id: fresh('sgx'), input: source, expr: col(source.id, LIST_COL), channels: [], as: MEMBER,
    type: typeOf(...source.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
  });
  const offenders = make.filter({
    id: fresh('sgf'), input: members, channels: [], type: members.type,
    pred: nonStringMember(of, members),
  });
  const one = make.project({
    id: fresh('sgp'), input: offenders, channels: [], type: typeOf(meta(MEMBER.ord, 'int')),
    exprs: [[MEMBER.ord, col(offenders.id, MEMBER.ord)]],
  });
  const node = make.limit({ id: fresh('sgl'), input: one, channels: [], type: one.type, count: compilerInt(1) });
  const guard: Guard = {
    message: `The ${step.name}(local) step can only take string or list of strings`,
    raiseWhen: 'rows',
  };
  return { name: `${fresh('sg')}`, node, guard };
}

/**
 * A list op that KEEPS the list shape, or `null` to decline.
 *
 * Three families, one frame. A member TRANSFORM rewrites each member; a local SLICE takes a window
 * of the members in position order; `all`/`any`/`none` filter the whole traverser on a member
 * predicate and pass the list through untouched.
 */
export function listMemberOp(
  step: IRStep, input: Rel, of: ListOf, fresh: Minter, child?: ChildSeam,
): { readonly rel: Rel; readonly of: ListOf; readonly rewrites?: boolean; readonly set?: boolean; readonly guard?: Binding } | null {
  if ((step.modulators?.length && !LOCAL_BY_HOSTS.has(step.name)) || step.optionArms) return null;
  // A GLOBAL string transform over a collection is a permanent type error, WHATEVER the member framing:
  // the traverser IS the list, and every `*GlobalStep` throws `IllegalArgumentException` on a non-String
  // receiver (`vendor/tinkerpop/gremlin-core/.../map/{ToUpper,ToLower,Trim,LTrim,RTrim,Length,Substring,
  // Replace}GlobalStep.java`). The shape is CERTAIN here — we are in the list vocabulary — so this raises
  // TinkerPop's own message as the ANSWER (§6·5), before the per-arm member-admission gate below, rather
  // than declining. `asString` is excluded (`GLOBAL_STRING_THROWS` omits it): `AsStringGlobalStep`
  // stringifies any value (`String.valueOf` → `"[1, 2]"`), a real answer this module does not yet build.
  // ⚠️ `replace`'s message alone carries a trailing period (`ReplaceGlobalStep`), the rest do not.
  if (!isLocalScope(step) && GLOBAL_STRING_THROWS.has(step.name)) {
    const dot = step.name === 'replace' ? '.' : '';
    throw new ValueParseError(
      `The ${step.name}() step can only take string as argument, encountered class java.util.ArrayList${dot}`);
  }
  // ⚠️ **MEMBER ADMISSION IS PER ARM, NOT AT THE DOOR.** It was one `isBareList` gate, which is the right
  // answer for exactly the arms that read a member AS A VALUE — a string transform and a member
  // predicate cannot be asked of a rowid. It is the wrong answer for every arm that does not: a local
  // SLICE reads only positions, and `order`/`dedup` need the member's compare key and identity, which an
  // ELEMENT list answers as well as a scalar one does (`GremlinValueComparator` compares an Element by
  // its id, `ElementHelper.hashCode` hashes it by its id — the same two facts the property `RowShape`
  // states one layer up). A single door therefore refused `g.V().fold().order(local).by('age')` as
  // inexpressible when the projection is an ordinary child-seam question about the member.
  const elemOf = of.kind === 'elem' ? of.elem : null;
  if (!isBareList(of) && !elemOf) return null;
  const rel = fenced(input, fresh);
  const list = col(rel.id, LIST_COL);

  // A STRING transform maps over the members — and only with `Scope.local` (the global form threw
  // above). A member read AS A VALUE, so an element member (a ROWID) declines: the transform would
  // rewrite the id, not a string.
  if (STRING_LOCAL_TX.has(step.name)) {
    if (!isLocalScope(step) || !isBareList(of)) return null;
    const members = membersOf(list, fresh);
    // `literal: false` — a member is a value inside a JSON document, not a compile-time literal the
    // constant-folding arms could evaluate, so the folded transforms (`asBool`, bare `asNumber`)
    // decline here exactly as they do over a column.
    const tx = transformExpr(step, memberPayload(of, members), false, fresh);
    if (!tx) return null;
    // The `*LocalStep`s that EXTEND `StringLocalStep` throw on a non-null non-string MEMBER (the set is
    // exactly `GLOBAL_STRING_THROWS` — every one has a `*GlobalStep`/`*LocalStep` pair over
    // `StringLocalStep`). `asString(local)` is NOT one: `AsStringLocalStep` stringifies each member
    // (`String.valueOf`) and only a null member raises `Can't parse null as String.`, a different error
    // this arm does not yet build — so it takes NO guard and its members coerce as before. The member
    // type is per-row/unknown here (never a static tag), so this is a runtime VALUE guard, not a
    // decline: it fires only when a member is provably non-string AT RUN TIME.
    const guard = GLOBAL_STRING_THROWS.has(step.name) ? localStringMemberGuard(step, of, input, fresh) : undefined;
    // A REWRITE reads the payload and writes a BARE member: the recorded type no longer describes the
    // new value (`length()` makes it an integer outright), so re-tagging it would frame the RESULT as
    // the INPUT's type.
    // `rewrites` is what a SET marker cannot survive: the members are new values, so "these are the
    // distinct results of a set operation" has stopped being true of them. A slice and a whole-traverser
    // filter both leave the members alone and keep it.
    return { rel: withList(rel, listOfMembers(members, tx.expr, [memberOrder(members)], fresh), fresh), of: BARE_LIST, rewrites: true, ...(guard ? { guard } : {}) };
  }

  // `reverse()` ON A LIST REVERSES ORDER, not each member, and it takes NO `Scope`: `ReverseStep.map`
  // dispatches on the TRAVERSER'S TYPE — a `String` reverses its characters, an `Iterable` becomes
  // `Collections.reverse(asList(items))`, anything else passes through
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ReverseStep.java`).
  // That is why it is here rather than in `STRING_LOCAL_TX`, whose members are the transforms a list maps
  // over its members — this one is a different operation on a list, not the same one applied per member.
  //
  // Re-aggregating in DESCENDING position order IS the reversal: the members keep their own values and
  // types (so this is not a rewrite), and a later explode renumbers from the new array, which is what
  // makes a following slice read the reversed positions rather than the original ones.
  if (step.name === 'reverse') {
    if (isLocalScope(step) || argValues(step).length) return null;
    const members = membersOf(list, fresh);
    return {
      rel: withList(rel, listOfMembers(members, memberNode(of, members), [memberOrder(members, 'desc')], fresh), fresh),
      of,
      // A reversed SET is a LIST on the wire — `ReverseStep` builds `itemsAsList` and returns it, so the
      // "these are the distinct results of a set operation" marker has stopped being true of the answer
      // even though every member survived.
      set: false,
    };
  }

  // A LOCAL slice takes a window of the MEMBERS, in position order — and `tail(Scope.local, n)` takes
  // it from the far end, which is the same direction flag the row slice uses. The members keep their
  // original positions (the re-aggregate orders by `mo`), so a slice of a slice composes.
  // `order(Scope.local)` SORTS THE MEMBERS IN PLACE, and `dedup(Scope.local)` collapses them —
  // both re-aggregate the same list through the same frame, so they sit together.
  if ((step.name === 'order' || step.name === 'dedup') && isLocalScope(step)) {
    const members = membersOf(list, fresh);
    // THE COMPARE KEY IS `byExpr`'S, not a second policy. A member is a value with a type, which is
    // exactly a SCALAR host — so the vtype-aware cast the row-level `order()` spends comes for free,
    // and the two cannot drift on whether `'10'` sorts before `'9'`. A BARE member has no recorded
    // type, so it infers one from its storage class — the same answer the wire would reach.
    const payload = memberPayload(of, members);
    if (step.name === 'dedup') {
      // ⚠️ THE SCOPE TOKEN IS AN ARGUMENT, so a bare argument COUNT declined the only form this arm
      // serves. `dedup(Scope.local)` carries `{scope:'local'}` in `args` — the very thing `isLocalScope`
      // just read — so `argValues(step).length` was 1 for EVERY traversal reaching here and everything
      // below was unreachable. What it must refuse is a LABEL tuple (`dedup('a','b')`), a path-distinct
      // question this module cannot answer, and a string argument is what names one.
      if (step.modulators?.length || argValues(step).some((a) => typeof a === 'string')) return null;
      // FIRST OCCURRENCE WINS and the surviving order is the original one — `DedupLocalStep` builds a
      // `LinkedHashSet`, so it is insertion order over distinct values.
      //
      // A RANKED WINDOW, not a grouped aggregate, and for `dedupOn`'s reason one level up: the survivor
      // is ONE member and every column must be ITS values — an `Aggregate` can produce `MIN(mo)` but not
      // "the value belonging to the row that had it". The aggregate form here also could not have been
      // right, because it named only two of the three member columns: a TYPED list's member is a value
      // AND a tag, and `memberNode` reads the tag.
      //
      // ⚠️ THE KEY IS THE PAYLOAD **AND** THE TAG, which is the same lesson the property identity key
      // records: `{t:'byte',v:1}` and `{t:'int',v:1}` share a payload and are `Byte(1)` and `Integer(1)`
      // — not equal in Java, so not one member. A bare list has no tag and the payload is the whole key.
      // An ELEMENT member's identity is its ROWID and nothing else (`ElementHelper.hashCode(Element)` is
      // `element.id().hashCode()`), which the payload already is.
      const tag = elemOf ? undefined : memberVtype(of, members);
      const rank = 'mdr';
      const ranked = make.window({
        id: fresh('mdw'), input: members, channels: [], type: typeOf(...members.type.cols, meta(rank, 'int')),
        specs: [[rank, {
          kind: 'window-expr', fn: 'row_number', args: [],
          spec: {
            partitionBy: tag ? [payload, tag] : [payload],
            orderBy: [{ expr: col(members.id, MEMBER.ord), dir: 'asc' }],
          },
        }]],
      });
      const survivors = make.filter({
        id: fresh('mdf'), input: ranked, channels: [], type: ranked.type,
        pred: { kind: 'binary', op: '=', left: col(ranked.id, rank), right: compilerInt(1) },
      });
      // A DEDUPED list is a SET on the wire (`DedupLocalStep` yields a `LinkedHashSet`), which is the
      // same marker `listSetOp`'s four deduping ops carry — and `listTail` now threads it.
      return {
        rel: withList(rel, listOfMembers(survivors, memberNode(of, survivors), [{ expr: col(survivors.id, MEMBER.ord), dir: 'asc' }], fresh), fresh),
        of, set: true,
      };
    }
    // A `by()` needs the seam to normalize a nested body; a caller with none may still order by the
    // bare member, which is the only form this arm serves anyway.
    if (!child && step.modulators?.length) return null;
    const bys = child ? modulations(step, (step.modulators ?? []).length, child) : [];
    if (!bys) return null;
    const parsed = bys.length ? bys : [{ key: { kind: 'identity' } as const }];
    // ONE key. A member has exactly one value, so a second `by()` would have nothing to name; `shuffle`
    // is `RANDOM()` per row and its own answer.
    if (parsed.length !== 1 || parsed[0]!.order === 'shuffle') return null;
    const only = parsed[0]!;
    // WHICH KEY, and the split is the member ENCODING's rather than the step's.
    //
    // Over a SCALAR member the key must be the member ITSELF — a value has no properties — and it is
    // `memberCompareKey`, NOT a second policy: the same `storedCompareOn` authority the row-level
    // `order().by()` and the local reducers spend, so a value carried as decimal TEXT (a long past 2^53,
    // a bigint, a bigdecimal, a duration) sorts NUMERICALLY rather than lexicographically. Getting that
    // wrong is the defect the local reducers already had.
    //
    // Over an ELEMENT member every projection an element has is available, because the member IS an
    // element addressed by its rowid — which is precisely a `ChildHost`, so `by('age')`, `by(T.label)`
    // and `by(<nested body>)` are the ordinary `by()` vocabulary rather than anything list-specific. A
    // bare `by()` sorts by the rowid, which is `GremlinValueComparator`'s own answer for an Element
    // (`Comparator.comparing(Element::id, this)`).
    //
    // ⚠️ SPELLED AGAINST THE RELATION IT IS READ FROM, twice where a drop is owed — a node addresses its
    // own INPUT, and the productivity filter puts a relation BETWEEN the explode and the aggregate. This
    // is `bulkSlice`'s rule (`lower.ts`) and the defect it prevents is a plan referencing an alias that is
    // out of scope where it is read.
    const keyOn = (m: Rel): Expr | null => (elemOf
      ? byExpr(only, { kind: 'element', elem: elemOf, id: col(m.id, MEMBER.value) }, fresh, true, child)
      : only.key.kind === 'identity' ? memberCompareKey(of, m) : null);
    const probe = keyOn(members);
    if (!probe) return null;
    // AN UNPRODUCTIVE `by()` DROPS THE MEMBER, and the reference pins it rather than us inferring it:
    // `g.V().fold().order(local).by('age')` answers FOUR vertices on the modern graph, not six — `lop`
    // and `ripple` have no age (`Order.feature:281-289`). It is a member FILTER, which is the same
    // predicate `orderProductivity` returns for a row and the reason it takes the step: with
    // `ProductiveByStrategy` on, nothing is dropped at all.
    const drop = orderProductivity(step, only, probe);
    const kept = drop
      ? make.filter({ id: fresh('mof'), input: members, channels: [], type: members.type, pred: drop })
      : members;
    const key = drop ? keyOn(kept) : probe;
    if (!key) return null;
    return {
      rel: withList(rel, listOfMembers(kept, memberNode(of, kept), [
        { expr: key, dir: only.order === 'desc' ? 'desc' : 'asc' },
        // THE ORIGINAL POSITION BREAKS TIES, and it is not tidiness: `json_group_array` takes rows in
        // whatever order SQLite produced, so equal keys would land in an arbitrary one — the defect
        // `mise run test:perturbed` exists to find and that no assertion in the ladder can see.
        memberOrder(kept),
      ], fresh), fresh),
      of,
    };
  }

  if (LIST_LOCAL_TX.has(step.name) && isLocalScope(step)) {
    const window = step.name === 'tail'
      ? { offset: 0, limit: Number(argValues(step).find((arg) => typeof arg === 'number') ?? 1) }
      // An illegal `range(Scope.local, 2, 1)` is a `ValueParseError` answer that PROPAGATES (§6·5);
      // only the "not a slice step" routing throw declines. Mirror of `sliceOp`.
      : (() => { try { return sliceOf(step); } catch (e) { if (e instanceof ValueParseError) throw e; return null; } })();
    if (!window) return null;
    const members = membersOf(list, fresh);
    const ordered = make.sort({
      id: fresh('ms'), input: members, channels: [], type: members.type,
      terms: [memberOrder(members, step.name === 'tail' ? 'desc' : 'asc')],
    });

    // A local `limit($x)`/`skip($x)` binds its parameter exactly as the global slice does; `range`
    // and `tail` reduce (the `window` came from a number, `paramName` null). One `sliceBound` seam,
    // so the two scopes cannot drift on whether a `$x` count binds.
    const limitParam = step.name === 'limit' ? sliceParamNames(step)[0] ?? null : null;
    const offsetParam = step.name === 'skip' ? sliceParamNames(step)[0] ?? null : null;
    const taken = make.limit({
      id: fresh('ml'), input: ordered, channels: [], type: ordered.type,
      ...(window.limit === null ? {} : { count: sliceBound(window.limit, limitParam) }),
      ...(window.offset || offsetParam != null ? { offset: sliceBound(window.offset, offsetParam) } : {}),
    });
    // The AGGREGATE reads the sliced relation, so the member expression and the order term name
    // `taken` rather than the explode — the slice is a relation between them.
    return {
      // A SUBSET writes members back WHOLE, so each keeps its exact type — the envelope survives a
      // slice, which is the difference from a rewrite. Read through the SLICED relation, because a node
      // addresses its own input and the slice is a relation between the explode and the aggregate.
      rel: withList(rel, listOfMembers(taken, memberNode(of, taken), [{ expr: col(taken.id, MEMBER.ord), dir: 'asc' }], fresh), fresh),
      of,
    };
  }

  // `all`/`any`/`none` are WHOLE-TRAVERSER filters: the list passes through byte-identical or not at
  // all. `all` is "no member fails", which is not the same as "every member passes" once a predicate
  // can be NULL — hence `IS NOT TRUE` rather than `NOT (…)`.
  if (step.name === 'all' || step.name === 'any' || step.name === 'none') {
    const args = argValues(step);
    // A member PREDICATE reads the member as a value; over an element it is a question about the element
    // and therefore the child seam's, not this module's.
    if (args.length !== 1 || !isBareList(of)) return null;
    const members = membersOf(list, fresh);
    // A member predicate operand that is a ROOTED nested traversal (`none(P.eq(__.V(9999).values(k)))`)
    // resolves to its FIRST value — the operand form the seam owns, here via the child seam's `rooted`
    // read (a member list has no element host, so only the rooted arm applies). Mirrors
    // `nestedFirstValue`'s rooted branch across the module boundary (`list.ts` cannot reach `lower.ts`).
    const resolveScalar = child ? (nested: unknown): Expr | null => {
      const steps = child.body(isNested(nested) ? nested.nested : nested, 'rooted');
      if (!steps?.length) return null;
      const read = child.rooted(steps);
      if (!read || read.effects?.length || read.framing.kind !== 'scalar') return null;
      return { kind: 'scalar', plan: make.project({
        id: fresh('lmv'), input: read.rel, channels: [], type: typeOf(meta('v', 'any', true)),
        exprs: [['v', col(read.rel.id, 'v')]],
      }) };
    } : undefined;
    const pred = memberPredicate(memberPayload(of, members), args[0], resolveScalar);
    if (!pred) return null;
    const failing: Expr = { kind: 'binary', op: 'is not', left: pred, right: compilerInt(1) };
    const probe = (test: Expr): Rel => make.project({
      id: fresh('mp'), input: make.filter({ id: fresh('mf'), input: members, channels: [], type: members.type, pred: test }),
      channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]],
    });
    const keep: Expr = step.name === 'all'
      ? { kind: 'exists', plan: probe(failing), negated: true }
      : { kind: 'exists', plan: probe(pred), negated: step.name === 'none' };
    return { rel: make.filter({ id: fresh('lf'), input: rel, channels: rel.channels, type: rel.type, pred: keep }), of };
  }

  return null;
}

/**
 * A list op that RETYPES the traverser to a scalar, or `null` to decline — the shape boundary out of
 * the list vocabulary, exactly as `terminal` is the one out of the element vocabulary.
 */
export function listRetype(
  step: IRStep, input: Rel, of: ListOf, fresh: Minter,
): {
  readonly rel: Rel; readonly type: import('../../sql/kernel/render.ts').ScalarType;
  readonly result?: 'number' | 'count'; readonly productiveNull?: boolean;
} | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = argValues(step);
  const rel = fenced(input, fresh);
  const list = col(rel.id, LIST_COL);

  // `count(Scope.local)` counts the MEMBERS — a long, and the one local reduction that needs no
  // eligibility guard because a member's storage class cannot make it uncountable. It is answered
  // BEFORE the bare-list gate below, since it never reads a member's VALUE: an ELEMENT-membered list
  // (`aggregate("a").cap("a")`) and a nested one count their members exactly as a scalar list does.
  if (step.name === 'count' && isLocalScope(step)) {
    if (args.some((arg) => typeof arg === 'number')) return null;
    const members = membersOf(list, fresh);
    const total: Expr = {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mc'), input: members, channels: [], type: typeOf(meta('v', 'int')),
        groupBy: [], aggs: [['v', { kind: 'agg', fn: 'count', args: [] }]],
      }),
    };
    return { rel: withPayload(rel, [['v', total]], [meta('v', 'int')], fresh), type: STATIC('long'), result: 'count' };
  }

  // Everything past here reads a member's VALUE (a string transform, a value reducer), which only the
  // SCALAR-membered vocabulary can supply.
  if (!isBareList(of)) return null;

  // `conjoin(sep)` joins the MEMBERS into one string, skipping nulls — so the result is a string
  // whatever the members were, and an all-null list conjoins to `''` rather than to NULL.
  if (step.name === 'conjoin') {
    const [sep, extra] = args;
    if (typeof sep !== 'string' || extra !== undefined) return null;
    const members = membersOf(list, fresh);
    const present = make.filter({
      id: fresh('mf'), input: members, channels: [], type: members.type,
      pred: { kind: 'binary', op: 'is not', left: memberPayload(of, members), right: compilerNull() },
    });
    const joined: Expr = {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mj'), input: present, channels: [], type: typeOf(meta('v', 'text', true)),
        groupBy: [],
        aggs: [['v', {
          kind: 'call',
          fn: 'COALESCE',
          args: [{ kind: 'agg', fn: 'group_concat', args: [memberPayload(of, present), compilerText(sep)], orderBy: [{ expr: col(present.id, MEMBER.ord), dir: 'asc' }] },
            compilerText('')],
        }]],
      }),
    };
    return { rel: withPayload(rel, [['v', joined]], [meta('v', 'text', true)], fresh), type: STATIC('string') };
  }

  // The REDUCER family over the members — the same `reducer.ts` authority the row-level reducers use,
  // so the eligibility guard, the dynamic result class and `mean`'s forced REAL are stated once. There
  // is no multiplicity inside a list: a member is one value, so the bulk-weighted form never applies.
  if (isReducer(step.name) && isLocalScope(step)) {
    if (args.some((arg) => typeof arg === 'number')) return null;
    const members = membersOf(list, fresh);
    const payload = memberPayload(of, members);
    const memberType = memberTypeOf(of);
    /** One correlated subquery over the members, projecting one named column. */
    const scalar = (value: Expr, name: string, type: 'any' | 'text'): readonly [string, Expr] => [name, {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mr'), input: members, channels: [], type: typeOf(meta(name, type, true)),
        groupBy: [], aggs: [[name, value]],
      }),
    }];
    // A NULL reduction is a REAL result exactly when the LIST says nothing was dropped on the way in
    // (`ProductiveByStrategy`), which is the fact `foldScalars` recorded beside the member type. It
    // rides out with every reducer arm below, so no shape can be built that forgets it.
    const productive = of.kind === 'scalar' && of.productiveNull ? { productiveNull: true } : {};
    const asNumber = (value: readonly [string, Expr], vt: readonly [string, Expr]) => ({
      rel: withPayload(rel, [value, vt], [meta('v', 'any', true), meta('vt', 'text', true)], fresh),
      type: UNKNOWN, result: 'number' as const, ...productive,
    });

    // **`min`/`max` ORDER, so they take the ARGMIN/ARGMAX — the winning MEMBER, projected whole —
    // exactly as the row-level pair does.** Two things follow that a `MIN()`/`MAX()` over a cast key
    // cannot give: the winner is chosen by `memberCompareKey` (so a decimal-TEXT long orders
    // numerically instead of lexicographically), and the value returned is the RAW member, so a
    // >2^53 long is not rounded through the cast on its way out. The `vt` is that member's own
    // GREMLIN vtype rather than SQLite's `typeof`, which is what lets the `result:'number'` framer
    // send it back as a `long` through `vtypeToValueType` — before this it came back the string
    // `"9007199254740993"`.
    if (step.name === 'min' || step.name === 'max') {
      const dir: 'asc' | 'desc' = step.name === 'min' ? 'asc' : 'desc';
      // NULL is SKIPPED by min/max (`NumberHelper` returns the non-null side), so it never WINS —
      // but it is not FILTERED, because a NON-EMPTY all-null list reduces to null and
      // `MaxLocalStep` splits on that null rather than skipping the traverser
      // (`gremlin-core/.../step/map/MaxLocalStep.java:45-56`). Nulls therefore sort LAST in both
      // directions, which needs an explicit `IS NULL` term: SQLite puts NULLs first ascending.
      const present = members;
      const key = memberCompareKey(of, present);
      const winner = make.limit({
        id: fresh('mw'),
        input: make.sort({
          id: fresh('mo'), input: present, channels: [], type: present.type,
          // A total tie-break on the raw payload keeps the survivor deterministic, as it does at row level.
          terms: [
            { expr: { kind: 'binary', op: 'is', left: memberPayload(of, present), right: compilerNull() }, dir: 'asc' },
            { expr: key, dir }, { expr: memberPayload(of, present), dir },
          ],
        }),
        channels: [], type: present.type, count: compilerInt(1),
      });
      // THE WINNER IS PICKED ONCE. `v` and `vt` are two columns of one row, and giving each its own
      // correlated subquery would emit the whole sort twice — measured, that alone took the `max`
      // family's statement from 1,250 bytes to 4,108, against a platform that caps a statement at
      // 100 KB. So the pick projects a `{v,t}` pair as ONE value and the payload columns read its
      // two fields, which is the same trick the member ENVELOPE already is.
      const picked: Expr = {
        kind: 'scalar',
        plan: make.project({
          id: fresh('mp'), input: winner, channels: [], type: typeOf(meta('w', 'json')),
          exprs: [['w', {
            kind: 'json-object',
            entries: [['v', memberPayload(of, winner)], ['t', memberTypeTag(of, winner)]],
            binary: false,
          }]],
        }),
      };
      // FENCED, and that is the whole point of naming it: without a materialization boundary the
      // block assembler fuses the two projections into one SELECT and re-inlines `w` at both reads,
      // which is the duplication this shape exists to avoid (measured: 3,024 bytes fused, 1,747
      // fenced, for the same plan).
      const held = fenced(withPayload(rel, [['w', picked]], [meta('w', 'any', true)], fresh), fresh);
      return {
        rel: withPayload(held,
          [['v', jsonField(col(held.id, 'w'), 'v')], ['vt', jsonField(col(held.id, 'w'), 't')]],
          [meta('v', 'any', true), meta('vt', 'text', true)], fresh),
        type: UNKNOWN, result: 'number' as const, ...productive,
      };
    }

    // **`sum` over a KNOWN exact-tail class must admit its decimal-TEXT members.** The eligibility
    // guard is a storage-class test, so a `long`/`bigint` past 2^53 has `typeof = 'text'` ∉ arithmetic
    // and was silently EXCLUDED — the row-level defect §6·7 records, reachable here through exactly
    // the same shape (`inject(9007199254740993L, 1L).fold().sum(Scope.local)` answered 1). Casting
    // through `storedCompareOn` for the known class admits it exactly, and `sumTower` keeps the class
    // and rides a >2^53 result as exact TEXT so the int64 survives the JS-number read.
    if (step.name === 'sum' && memberType?.kind === 'static' && isLongSumClass(memberType.type)) {
      const casted = storedCompareOn(compilerText(memberType.type))(payload);
      const tower = sumTower({ kind: 'agg', fn: 'sum', args: [casted] }, memberType.type);
      return asNumber(scalar(tower.value, 'v', 'any'), scalar(tower.type, 'vt', 'text'));
    }

    // `sum`/`mean` REDUCE rather than order, so the result is a fresh value whose storage class the
    // aggregate itself reports — `typeof(<the aggregate>)`, the row-level rule unchanged. The
    // aggregate is COMPUTED ONCE and its class read off the column: `reducerAggregate` splices its
    // subject into the eligibility guard as well as the aggregate, and for a self-describing list
    // that subject is a decode CASE, so writing the whole thing twice is what made this family's
    // statement grow when projected collections became typed. Same rule as the argmax above.
    const reduced = reducerAggregate(payload, step.name);
    const held = fenced(withPayload(rel, [['v', scalar(reduced.value, 'v', 'any')[1]]], [meta('v', 'any', true)], fresh), fresh);
    return {
      rel: withPayload(held,
        [['v', col(held.id, 'v')], ['vt', step.name === 'mean' ? compilerText('real') : { kind: 'call', fn: 'typeof', args: [col(held.id, 'v')] }]],
        [meta('v', 'any', true), meta('vt', 'text', true)], fresh),
      type: UNKNOWN, result: 'number' as const, ...productive,
    };
  }

  return null;
}

/**
 * `unfold()` — the list boundary in the other direction: one traverser per MEMBER.
 *
 * This one IS a relation-level explode, and the contrast with every op above is the point: a member
 * op computes one value FOR the traverser, while `unfold` makes each member a traverser of its own,
 * so multiplying the relation's rows is the answer rather than the bug it would be elsewhere.
 *
 * The member's POSITION becomes the emission order. `json_each.key` is the index within one list, so
 * it is only a total order where the relation has one row — which is why the caller re-mints through
 * `renumber` rather than declaring `mo` the channel directly.
 */
/** The column an unfolded MIXED member rides in — one self-describing `{t,v}` envelope per row, as
 *  JSON text the `typedNode` framer parses. */
export const NODE_COL = 'node';

export function unfoldList(
  rel: Rel, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly ord: string; readonly typed: boolean; readonly member?: ListOf; readonly mapVal?: MapOf; readonly elem?: Elem; readonly nodes?: readonly MixedArm[] } | null {
  // A NESTED list unfolds into one LIST traverser per member (a `product()`'s pair-lists), which is
  // the same explode with a different payload column — so it is one arm rather than a second function.
  if (of.kind === 'list') return unfoldNested(rel, of, fresh);
  // A MAP-membered list unfolds into one MAP traverser per member (`project().fold().unfold()` round-trip,
  // `select(Pop.all).by(__.…fold()).unfold()`): the same explode as a nested list, landing the member's
  // pairs array in `MAP_COL` and re-entering `mapTail`. `UnfoldStep` iterates the List and yields each
  // Map (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/flatMap/UnfoldStep.java`).
  if (of.kind === 'map') return unfoldMapMembers(rel, of, fresh);
  // A MIXED list unfolds into one SELF-DESCRIBING NODE per member: the members are heterogeneous
  // `{t,v}` envelopes (a vertex beside an edge beside a value), so each becomes a `typedNode` row the
  // wire frames by its own tag. There is no single element/scalar vocabulary to re-enter — a stream
  // that is a vertex on one row and an edge on the next cannot take `out()` — so this is TERMINAL,
  // exactly as the stream-level variant is.
  if (of.kind === 'mixed') {
    const exploded = make.explode({
      id: fresh('umx'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
      type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
    });
    return {
      rel: make.project({
        id: fresh('umn'), input: exploded, channels: rel.channels,
        type: typeOf(meta(NODE_COL, 'json', true), ...carriedCols(rel.channels), meta(MEMBER.ord, 'int')),
        // `json()` turns the JSONB envelope into the text the framer parses — the same read the whole
        // mixed list takes (`listPayloadExpr`), one member at a time.
        exprs: [[NODE_COL, jsonOf(col(exploded.id, MEMBER.value))],
          ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
          [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
      }),
      ord: MEMBER.ord,
      typed: false,
      nodes: of.arms,
    };
  }
  // AN ELEMENT list unfolds back into the ELEMENT vocabulary, and that round trip is the whole reason
  // the members stay rowids: `fold()` collected ids, so `unfold()` hands back a relation whose payload
  // is an `id` — an ordinary element relation, indistinguishable from the one the fold consumed, so
  // `out()`/`has()`/`values()` after it are the ordinary element loop with nothing to know about lists.
  // Had the fold expanded its members to payload objects, this direction would have to parse them back
  // out of JSON and would have LOST the rowid the graph is keyed by.
  if (of.kind === 'elem') {
    const exploded = make.explode({
      id: fresh('ux'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
      type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
    });
    return {
      rel: make.project({
        id: fresh('ue'), input: exploded, channels: rel.channels,
        type: typeOf(meta('id', 'int'), ...carriedCols(rel.channels), meta(MEMBER.ord, 'int')),
        // `json_each` hands a member back with the storage class the JSON held; the CAST states the
        // rowid contract rather than trusting that, which is the same thing the alias channel's own
        // rowid read does.
        exprs: [['id', { kind: 'cast', arg: col(exploded.id, MEMBER.value), to: 'int' }],
          ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
          [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
      }),
      ord: MEMBER.ord,
      typed: false,
      elem: of.elem,
    };
  }
  if (!isBareList(of)) return null;
  const exploded = make.explode({
    id: fresh('uf'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
    type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
  });
  // A TYPED list's members carry their own type out with them: the unfolded stream frames PER ROW off
  // a `vtype` column, exactly as `values()` over a stored property does, so a heterogeneous folded
  // list round-trips instead of being re-inferred under one compile-time tag.
  const vtype = memberVtype(of, exploded);
  return {
    rel: make.project({
      id: fresh('uv'), input: exploded, channels: rel.channels,
      type: typeOf(meta('v', 'any', true), ...(vtype ? [meta('vtype', 'text', true)] : []),
        ...carriedCols(rel.channels), meta(MEMBER.ord, 'int')),
      exprs: [['v', memberPayload(of, exploded)],
        ...(vtype ? [['vtype', vtype] as const] : []),
        ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
        [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
    }),
    ord: MEMBER.ord,
    typed: !!vtype,
  };
}

/**
 * A list VALUE's members as a CORRELATED relation, re-entering the member vocabulary — the seed a
 * `by()` body over a list host (`select(Pop.all).by(__.unfold()…)`) opens with.
 *
 * `unfold()` over a list traverser is a relation-level explode (`unfoldList`); `unfold()` inside a
 * `by()` is the SAME explode CORRELATED to one host's list value — no `input`, exactly as `membersOf`
 * is correlated. An ELEMENT-membered list re-enters the element loop (the members are rowids, `unfoldList`'s
 * own round-trip rule), so the rest of the body is the ordinary correlated element body; a bare-scalar
 * list re-enters the scalar loop. Other member shapes (`typed`/`mixed`/`map`/nested `list`) decline
 * here — their correlated re-entry is its own increment.
 *
 * Returns the correlated member relation plus what it framed, so the caller routes the tail to the
 * matching loop exactly as `unfoldList`'s caller does.
 */
export function correlatedListMembers(
  list: Expr, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly elem: Elem } | { readonly rel: Rel; readonly scalar: ScalarType } | null {
  const exploded = membersOf(jsonOf(list), fresh);
  if (of.kind === 'elem') {
    return {
      rel: make.project({
        id: fresh('cue'), input: exploded, channels: [], type: typeOf(meta('id', 'int')),
        // The same rowid CAST the relation-level element unfold states, for the same reason.
        exprs: [['id', { kind: 'cast', arg: col(exploded.id, MEMBER.value), to: 'int' }]],
      }),
      elem: of.elem,
    };
  }
  if (isBareList(of)) {
    return {
      rel: make.project({
        id: fresh('cuv'), input: exploded, channels: [], type: typeOf(meta('v', 'any', true)),
        exprs: [['v', memberPayload(of, exploded)]],
      }),
      scalar: memberTypeOf(of) ?? UNKNOWN,
    };
  }
  return null;
}

/**
 * `fold()` — the SCALAR stream's barrier into one list traverser, and the other half of the
 * `jsonbList` arm (109 of the family's remaining blockers all stop here).
 *
 * The barrier itself is one `Aggregate`; what makes it an increment is the MEMBER ENCODING, and that
 * decision has two cases:
 *
 * - **no per-row type** (an `inject` source, a transformed value) — the storage class already
 *   determines every member, so the list is BARE and carries the stream's compile-time tag.
 * - **a per-row `vtype`** (a `values()` stream) — the members' types live in a COLUMN, so they may be
 *   heterogeneous and are unknown at compile time. Only a self-describing `{t,v}` node per member can
 *   express that, and whether one is NEEDED is a runtime question about the WHOLE list: wrap iff SOME
 *   member's type is lossy under its storage class. Asked once, so the encoding stays uniform per
 *   list — mixing encodings inside one list is the corruption this shape exists to avoid.
 *
 * **THE STREAM'S `ScalarType` IS THE INPUT, not a `vtype?`/`staticTag?` pair.** The fold is the one
 * place a scalar ROW's type channel becomes a LIST MEMBER's, and both ends now spell it the same
 * way, so the conversion is a CARRIER change (column → envelope) rather than a re-derivation: the
 * caller hands over what it holds and this function decides the encoding. Splitting it into two
 * optionals at the call site is what let a `static`'s `text` flag — the fact that a big long rides
 * as decimal TEXT — fall out of every fold, which is why a `max(Scope.local)` over such a list
 * compared lexicographically and answered the smaller value.
 *
 * "About the whole list" is a WINDOW here: `MAX(<is this row lossy>) OVER ()` is 1 iff any row is. A
 * window "cannot nest inside the json_group_array aggregate" and the naive spelling reaches for
 * `EXISTS` over a second alias instead — true of one SELECT, and not a constraint on a normalized IR:
 * the window is its own node, so the
 * aggregate reads a COLUMN and the assembler opens the nested SELECT that makes it legal (it already
 * refuses to fuse an `Aggregate` over a windowed block). The alternative — an `Exists` whose subplan
 * SHARES the aggregate's input — is what the algebra actually refuses: the `name` pass does not walk
 * expression subplans, so one node would become a `Ref` in one place and stay itself in the other,
 * and `check` fails closed on the ambiguity ("names two different relations in one scope").
 *
 * The list's member order is whatever COLUMNS the caller names, in order: `Agg.orderBy` is what that
 * needs, so there is no node-set question. For a `fold()` that is the one encounter channel; a
 * multi-site named collection names two (the SITE, then that site's encounter), because the
 * reference appends one whole site's `BulkSet` after the previous one's
 * (`AggregateStep.processAllStarts` → `Operator.addAll`). Naming columns rather than one encounter
 * is what lets both be the same fold. With none the list keeps incidental row order, which
 * `analyzeChain` guarantees cannot matter for a `fold` (a COLLECTING consumer,
 * so a chain that reaches one always demands an encounter).
 */
export function foldScalars(
  input: Rel,
  opts: { readonly type: ScalarType; readonly productiveNull?: boolean; readonly order?: readonly string[] },
  fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  // The type column and the position are named rather than passed as EXPRESSIONS, because the relation
  // an expression must address is the window's output and not the caller's input: every node here
  // addresses its own INPUT, and the lossy flag inserts one.
  const vtypeCol = perRowColumnOf(opts.type);
  const vtype = vtypeCol ? col(input.id, vtypeCol) : undefined;
  const flagged = vtype ? withLossyFlag(input, vtype, fresh) : input;
  const value = col(flagged.id, 'v');
  // ORDER BY the encounter when there is one; else by the VALUE — a DETERMINISTIC order for a per-origin
  // CORRELATED fold (`scalarChild`'s list arm), whose `EXISTS`-shaped hop mints no encounter, so without
  // this its `json_group_array` is SCAN order — right by luck, wrong under `test:perturbed`. Only the
  // no-encounter branch is new, so an ordinary fold's SQL is byte-unchanged.
  const order: readonly SortTerm[] = opts.order?.length
    ? opts.order.map((column) => ({ expr: col(flagged.id, column), dir: 'asc' as const }))
    : [{ expr: value, dir: 'asc' as const }];
  // A PER-ROW member envelopes when the whole list is lossy (any member's type does not survive its
  // storage class — now including `double`, whose whole-number members would infer back as Int and whose
  // 17-digit members would lose a bit), else stays bare (the remaining lossless types — `string`/`int` —
  // infer back exactly). A STATIC member has one tag for the list, so it never needs the envelope, but a
  // static REAL still crosses the lossy JSON writer — `jsonMember` makes it exact (a no-op for a static
  // string/int). Both paths reach the one JSON-entry authority.
  const staticTag = vtype ? undefined : staticTypeOf(opts.type);
  const member = vtype
    ? {
      kind: 'case',
      whens: [[col(flagged.id, LOSSY_COL), typedNode(value, col(flagged.id, vtypeCol!))]],
      else: value,
    } as Expr
    // A STATIC tag gates `jsonMember` at compile time; an UNKNOWN one (an inject literal, an untyped
    // stream) has no tag, so it infers from `typeof(value)` — safe because the member IS a column.
    : staticTag ? jsonMember(value, compilerText(staticTag)) : jsonMemberByTypeof(value);
  // The CARRIER moves; the type does not. A column-carried per-row type becomes envelope-carried
  // because a member has no column of its own; `static`/`unknown` cross unchanged, `text` flag and
  // all — which is exactly the fact the old `staticTag: ValueType` pair could not carry.
  const memberType: ScalarType = vtype ? PER_ROW_ENVELOPE : opts.type;
  return {
    rel: make.aggregate({
      id: fresh('fd'), input: flagged, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [],
      aggs: [[LIST_COL, {
        kind: 'call',
        fn: 'jsonb',
        args: [{
          kind: 'call',
          fn: 'COALESCE',
          args: [{ kind: 'agg', fn: 'json_group_array', args: [member], orderBy: order },
            { kind: 'call', fn: 'json', args: [compilerText('[]')] }],
        }],
      }]],
    }),
    of: { kind: 'scalar', type: memberType, productiveNull: !!opts.productiveNull },
  };
}

/**
 * `fold()` OVER AN ELEMENT STREAM — the same barrier, collecting ROWIDS.
 *
 * `foldScalars`' twin, and the difference is one expression: a scalar list collects the VALUE, an
 * element list collects the traverser's rowid and leaves the expansion to the payload arm below. That
 * split is what makes the encoding cheap — a fold's job is the barrier, and expanding six vertices
 * into their property bags inside the aggregate would compute a payload for every member of every
 * intermediate list, including the ones a following `range(local)` or `unfold().limit(1)` throws away.
 *
 * It is also why there is no type question here and a long one in `foldScalars`: every member of an
 * element list IS an element, so `of` says it once and no member needs a tag. `{kind:'elem'}` was
 * already a `ListOf` arm the framer read (`listItemBuffers`,
 * `execute.ts`); this is the increment that first PRODUCES one on this spine, which is exactly what
 * `listPayloadExpr`'s decline comment said it was waiting for.
 *
 * The member ORDER is `foldScalars`' exactly — the columns the caller names, which for a `fold()` is
 * always the one encounter channel: `analyzeChain` makes `fold` a COLLECTING consumer, so a chain
 * reaching one demands an encounter.
 * `COALESCE(…, '[]')` because a fold over ZERO traversers emits `[]` rather than nothing —
 * `FoldStep` supplies a seed, which is the per-step rule §12 cites `gremlin-core` for.
 */
export function foldElements(
  input: Rel, elem: Elem, opts: { readonly order?: readonly string[] }, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  // ORDER BY the encounter when there is one; else by the member ROWID — see `foldScalars`. Only the
  // no-encounter (correlated) branch is new, so an ordinary element fold's SQL is byte-unchanged.
  const order: readonly SortTerm[] = opts.order?.length
    ? opts.order.map((column) => ({ expr: col(input.id, column), dir: 'asc' as const }))
    : [{ expr: col(input.id, 'id'), dir: 'asc' as const }];
  return {
    rel: make.aggregate({
      id: fresh('fe'), input, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [],
      aggs: [[LIST_COL, {
        kind: 'call',
        fn: 'jsonb',
        args: [coalesce({ kind: 'agg', fn: 'json_group_array', args: [col(input.id, 'id')], orderBy: order }, EMPTY_ARRAY)],
      }]],
    }),
    of: { kind: 'elem', elem },
  };
}

/**
 * `fold()` OVER A MAP STREAM — the third fold, collecting the per-row PAIRS ARRAY.
 *
 * `foldScalars`/`foldElements`' twin for the map shape: `project(k…).by(…).fold()`,
 * `valueMap().fold()`, `group().by().by().fold()` — every GraphQL to-many object field at depth ≥ 2.
 * The record collapses to a map first (`recordToMap`) so this side sees ONE column whatever produced
 * it, and the difference from the scalar fold is one expression: a map member is the whole `[[key,
 * valueNode], …]` pairs array, collected under `json()` so `json_group_array` keeps each member a
 * nested JSON array rather than re-encoding it as a string — the SAME double-encoding trap `memberNode`
 * documents, one shape up.
 *
 * `mapCol` is passed rather than imported to keep `list.ts` free of a `map.ts` cycle (map.ts imports
 * `LIST_COL` from here); the caller supplies `MAP_COL`, which every map-framed relation carries.
 *
 * The member order is `foldScalars`' exactly — the columns the caller names, always the one encounter
 * channel for a `fold()` (a COLLECTING consumer demands an encounter); with none the list keeps
 * incidental order, which `analyzeChain` guarantees cannot matter for a fold.
 */
export function foldMaps(
  input: Rel, mapCol: string, of: MapOf, opts: { readonly order?: readonly string[] }, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  const order: readonly SortTerm[] = opts.order?.length
    ? opts.order.map((column) => ({ expr: col(input.id, column), dir: 'asc' as const }))
    : [{ expr: col(input.id, mapCol), dir: 'asc' as const }];
  return {
    rel: make.aggregate({
      id: fresh('fm'), input, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [],
      // `json(mapCol)` for `memberNode`'s reason: the map column is JSONB and `json_group_array` would
      // re-encode a raw JSONB member as a quoted STRING, so it crosses back to text first and rides in
      // as a nested array.
      aggs: [[LIST_COL, collectedArray(jsonOf(col(input.id, mapCol)), order)]],
    }),
    of: { kind: 'map', of },
  };
}

/** The storage-class-determined types a bare member infers back to EXACTLY — `string` and `int`, the two
 *  whose JS value round-trips its own type and precision through the JSON channel. `double` is NOT one:
 *  a whole-number double (`1.0`) infers back as an Int, and a 16-17 digit double loses a bit through
 *  SQLite's 15-digit JSON writer — so a double member takes the `{t,v}` envelope, which carries its tag
 *  AND makes it lossless (`jsonMember`). */
const LOSSLESS_VTYPES = ['string', 'int'] as const;

const LOSSY_COL = 'lossy';

/** Add the whole-relation "does ANY member need an envelope?" answer as a COLUMN —
 *  `MAX(<per-row lossy>) OVER ()`, which is 1 iff some row's recorded type does not survive its
 *  storage class. One question per LIST rather than per member, which is what keeps a list's encoding
 *  uniform: mixing encodings inside one list is the corruption this shape exists to avoid. */
const withLossyFlag = (input: Rel, vtype: Expr, fresh: Minter): Rel => make.window({
  id: fresh('vw'), input, channels: input.channels,
  type: typeOf(...input.type.cols, meta(LOSSY_COL, 'int')),
  specs: [[LOSSY_COL, {
    kind: 'window-expr',
    fn: 'max',
    args: [{
      kind: 'case',
      whens: [[{
        kind: 'binary',
        op: 'and',
        left: { kind: 'binary', op: 'is not', left: vtype, right: compilerNull() },
        // `NOT (x IN …)`, not an `InList` with a negation flag — the node has none, and with the
        // `IS NOT NULL` guard on the left the two forms agree (a NULL is already excluded).
        right: { kind: 'unary', op: 'not', arg: { kind: 'in-list', expr: vtype, values: LOSSLESS_VTYPES.map(compilerText) } },
      }, compilerInt(1)]],
      else: compilerInt(0),
    }],
    spec: { partitionBy: [], orderBy: [] },
  }]],
});

/**
 * THE SET-OP FAMILY — `combine`/`intersect`/`difference`/`disjunct`/`merge`/`product` over a list
 * OPERAND, and 70 corpus traversals that became visible the moment the member frame existed.
 *
 * One lowering, six semantics, and each is a relational statement over the two sides' members rather
 * than a hand-written subquery: a UNION for concatenation, a correlated `EXISTS` for membership, a
 * `Distinct` for the deduped results, a cross join for the product. What makes them a family is that
 * they all read both sides through the same `membersOf`, and what makes them cheap is that the frame
 * was the previous increment.
 *
 * **The OPERAND crosses the seam as ONE VALUE** — `jsonb('[…]')`, a single bind for the whole array —
 * which is the root rule about a set sized by DATA rather than by query text. A TRAVERSAL operand
 * (`merge(__.V().values('name').fold())`) is a child read and declines; a `Map` operand is a permanent
 * type error.
 *
 * **A typed self side is projected to PAYLOADS first**, because the operand is always bare: comparing
 * `{"t":"int","v":5}` against `5` would never match, and emitting a mix of both encodings inside one
 * result list is the corruption the uniform-per-list rule exists to prevent. So a typed self makes
 * the result BARE.
 */
const SET_OPS = new Set(['combine', 'intersect', 'difference', 'disjunct', 'merge', 'product']);

/** The four whose result is a SET rather than a list — deduped content, and it frames as a
 *  GraphBinary SET only when TERMINAL: with a follower (`order(Scope.local)`, `unfold()`) TinkerPop
 *  treats it as a plain List, which is what the suite asserts. */
const SET_RESULT = new Set(['intersect', 'difference', 'disjunct', 'merge']);

const OPERAND = { value: 'ov', ord: 'oo' } as const;

/**
 * THE LIST-FUNCTION STEPS and their SHAPE ERRORS — the traversal's ANSWER is an error, so these RAISE
 * (§6·5's `ValueParseError` channel) rather than declining.
 *
 * Every one of them implements `ListFunction`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/ListFunction.java`),
 * which is where all six messages live and why they are parameterised by the step NAME rather than
 * written out five times: `asCollection` returns null for anything that is not an array or an `Iterable`,
 * and each of the three converters raises its own pair. SQL cannot raise, and the shape is a COMPILE-TIME
 * fact for every case below, so the throw happens here and travels out through the lowering — exactly
 * `asNumber('1,000')`'s route.
 *
 * ⚠️ **Only where the shape is statically CERTAIN.** A SCALAR self is a per-row question — `items` being
 * null selects `nullTraverser` and anything else selects `nonIterableTraverser`, and picking one for a
 * value that may be either would answer with the WRONG ERROR. So the scalar self keeps declining; an
 * ELEMENT / MAP / RECORD / PROPERTY traverser can never be null, which is what makes its message certain.
 */
export const LIST_FUNCTIONS: ReadonlySet<string> = new Set([...SET_OPS, 'conjoin']);

/** `%s step can only take an array or an Iterable type for incoming traversers, encountered %s` — the
 *  SELF is not a collection. The trailing class is Java's and the corpus matches on the prefix, so the
 *  Gremlin type name goes there instead of inventing a Java one. */
export const nonIterableTraverser = (step: IRStep, encountered: string): never => {
  throw new ValueParseError(
    `${step.name} step can only take an array or an Iterable type for incoming traversers, encountered ${encountered}`);
};

/** The operand's two, from `convertArgumentToCollection` (a literal) and `convertTraversalToCollection`
 *  (a traversal). Which pair applies is decided by the ARGUMENT's own form, which is why this takes it. */
export const nonIterableArgument = (step: IRStep, arg: unknown, encountered: string | null): never => {
  const traversal = isNested(arg);
  if (encountered === null) {
    throw new ValueParseError(traversal
      ? `Provided traversal argument for ${step.name} step must yield an iterable type, not null`
      : `Argument provided for ${step.name} step can't be null.`);
  }
  throw new ValueParseError(traversal
    ? `Provided traversal argument for ${step.name} step must yield an iterable type, encountered ${encountered}`
    : `${step.name} step can only take an array or an Iterable as an argument, encountered ${encountered}`);
};

/**
 * A set-op OPERAND as a list expression, or `null` to decline — three forms, one question.
 *
 * A literal ARRAY and `constant(c).fold()` are both COMPILE-TIME lists (the second a one-member one,
 * which is the same fact rather than a special case). A rooted
 * SUB-READ is a relation: its members are only known at run time, so it is lowered by the same fold
 * and read through a `Scalar` expression — no escape node, and if the inner chain is not covered the
 * decline propagates outward, which is the contract one level down.
 *
 * The ADMISSION RULE over the seam's answer is this module's, not the seam's (§6·6): an operand must
 * be LIST-framed, because the set-op operands and the predicate ones share one rule and the two cannot
 * be allowed to disagree about which traversals qualify — a
 * scalar-valued sub-read is not a collection. An operand with EFFECTS is refused for a harder reason:
 * its statements are `Plan` bindings the operand expression cannot carry, so splicing only the
 * relation would drop the write and leave a `Ref` naming a binding that was never made.
 */
function operandList(step: IRStep, arg: unknown, child: ChildSeam): { readonly expr: Expr; readonly of: ListOf } | null {
  const literal = (members: readonly unknown[]) =>
    ({ expr: { kind: 'call', fn: 'jsonb', args: [lit(JSON.stringify(members), 'text')] } as Expr, of: BARE_LIST });
  if (Array.isArray(arg)) return literal(arg);
  // A LITERAL THAT IS NOT A COLLECTION is the reference's own error and not a shape we have yet to learn:
  // `asCollection` returns null for it and `convertArgumentToCollection` raises. `null` is its own message,
  // which is why `nonIterableArgument` takes the type separately rather than deriving it from the value.
  if (!isNested(arg)) {
    if (arg === undefined) return null;
    return nonIterableArgument(step, arg, arg === null ? null : gremlinTypeOfValue(arg));
  }
  const inner = child.body((arg as { readonly nested: unknown }).nested, 'child');
  if (!inner?.length) return null;
  if (inner.length === 2 && inner[0]?.name === 'constant' && inner[1]?.name === 'fold') {
    const [value, extra] = argValues(inner[0]);
    if (extra !== undefined || value === undefined) return null;
    return literal([value]);
  }
  // A BARE `constant(v)` operand — no `fold()` — YIELDS v, and a value is not iterable. Same compile-time
  // fact as the folded form one line up and the same authority answers it; `constant(null)` takes the
  // `not null` wording, which is why the type is passed as `null` rather than derived.
  if (inner.length === 1 && inner[0]!.name === 'constant') {
    const [value, extra] = argValues(inner[0]!);
    if (extra !== undefined || value === undefined || Array.isArray(value)) return null;
    return nonIterableArgument(step, arg, value === null ? null : gremlinTypeOfValue(value));
  }
  const read = child.rooted(inner);
  // A DECLINING operand stays a decline — we cannot type what did not lower, and §6·5's fail-open rule
  // applies exactly here. A LOWERED operand whose framing is not a list IS the reference's error: the
  // traversal yielded a value that is not iterable, and we know which one.
  if (!read || read.effects?.length) return null;
  if (read.framing.kind !== 'list') {
    const yielded = gremlinTypeOfFraming(read.framing);
    return yielded === null ? null : nonIterableArgument(step, arg, yielded);
  }
  return { expr: { kind: 'scalar', plan: read.rel }, of: read.framing.of };
}

/** A LITERAL's Gremlin type name, for the `encountered %s` tail. Java prints a class there and the corpus
 *  matches on the prefix, so naming the Gremlin type is both checkable and more useful to a client than a
 *  Java class we do not have. */
const gremlinTypeOfValue = (value: unknown): string =>
  typeof value === 'string' ? 'string'
    : typeof value === 'boolean' ? 'boolean'
      : typeof value === 'bigint' ? 'long'
        : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'double')
          : value instanceof Map ? 'map' : 'object';

/** What a lowered operand YIELDED, as a Gremlin type name — or `null` where the framing cannot say, which
 *  fails open rather than naming a type the answer does not have. A `path` is deliberately absent: it
 *  coerces to its element sequence and IS iterable, so it never reaches here. */
const gremlinTypeOfFraming = (framing: RelFraming): string | null =>
  framing.kind === 'elements' || framing.kind === 'detached' ? framing.elem
    : framing.kind === 'scalar' ? (framing.type.kind === 'static' ? framing.type.type : 'object')
      : framing.kind === 'map' || framing.kind === 'mapEntry' ? 'map'
        : framing.kind === 'property' ? 'property'
          : framing.kind === 'record' ? 'map'
            : null;

export function listSetOp(
  step: IRStep, input: Rel, of: ListOf, terminal: boolean, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly set?: boolean } | null {
  if (step.modulators?.length || step.optionArms || !SET_OPS.has(step.name)) return null;
  const [arg, extra] = argValues(step);
  if (extra !== undefined) return null;
  // ⚠️ THE OPERAND IS RESOLVED BEFORE THE SELF'S MEMBER ENCODING IS GATED, and the order is the whole
  // difference between an ERROR and a decline: a non-iterable operand is the traversal's own answer
  // whatever the self's members are, so testing `isBareList(of)` first turned every element-member list's
  // `combine(2)` into a silent decline. The gate stays AFTER the thing that raises.
  const resolved = operandList(step, arg, child);
  if (!resolved) return null;
  // TWO MEMBER ENCODINGS ARE ADMITTED, and the split is the SAME per-type identity fact the property
  // `RowShape` and the element-member `order`/`dedup` already state. A BARE-scalar list compares members
  // by their value. An ELEMENT list compares by ROWID, which IS the element's identity —
  // `ElementHelper.hashCode(Element)` is `element.id().hashCode()`, and `areEqual` also demands the same
  // CLASS (`(a instanceof Vertex && b instanceof Vertex) || …`, `ElementHelper.java:463-466`), so a
  // vertex rowid never equals an edge's. BOTH SIDES must therefore be the same element kind: a cross-kind
  // set op matches nothing on identity AND would produce a MIXED-element result the payload layer cannot
  // frame (`listPayloadExpr`'s elem arm is ONE `elem`), so it declines rather than mis-answer. `product`
  // also declines over elements — its members are PAIR-lists whose rowids would frame bare (as integers)
  // instead of as element objects — a distinct shape, not this comparison.
  const elemOf = of.kind === 'elem' ? of.elem : null;
  const bothElem = elemOf !== null && resolved.of.kind === 'elem' && resolved.of.elem === elemOf;
  if (!bothElem && !(isBareList(of) && isBareList(resolved.of))) return null;
  if (bothElem && step.name === 'product') return null;
  const rel = fenced(input, fresh);

  // BOTH SIDES IN ONE VOCABULARY: bare payloads. A typed list's members MAY be `{t,v}` envelopes, and
  // comparing an envelope against a bare value never matches — so either side that might carry one is
  // re-emitted as its payloads first, through the same member frame every other op uses. Applying it
  // to BOTH sides (not only self) is the same code and stays correct for an operand whose members are
  // not all storage-class-determined.
  const payloads = (listExpr: Expr, items: ListOf): Expr => {
    if (!isTypedList(items)) return listExpr;
    const members = membersOf(listExpr, fresh);
    return listOfMembers(members, memberPayload(items, members), [memberOrder(members)], fresh);
  };
  const operand = payloads(resolved.expr, resolved.of);
  const selfList = payloads(col(rel.id, LIST_COL), of);

  const mine = membersOf(selfList, fresh);

  /**
   * One side's members as a single-column `(mv)` relation, optionally filtered.
   *
   * `column` is which of the input's columns holds the member, and the filter is applied BEFORE the
   * projection — so the projection addresses the FILTER, not the explode. Every expression here names
   * the relation it is read from, which is the one rule the emitter's scope enforces and the one this
   * function exists to make impossible to get wrong.
   */
  const valuesOf = (members: Rel, column: string, pred?: (side: Rel) => Expr): Rel => {
    const filtered = pred
      ? make.filter({ id: fresh('sf'), input: members, channels: [], type: members.type, pred: pred(members) })
      : members;
    return make.project({
      id: fresh('sp'), input: filtered, channels: [], type: typeOf(meta(MEMBER.value, 'any', true)),
      exprs: [[MEMBER.value, col(filtered.id, column)]],
    });
  };

  /** Does the OTHER side contain this side's member? `IS`, not `=`: a null member must match a null
   *  member, which is what null-safe membership means and what `=` cannot say. */
  const contains = (other: Expr, mine_: Expr, negated: boolean): Expr => {
    const theirs = membersOf(other, fresh);
    const same = make.filter({
      id: fresh('cf'), input: theirs, channels: [], type: theirs.type,
      pred: { kind: 'binary', op: 'is', left: col(theirs.id, MEMBER.value), right: mine_ },
    });
    return {
      kind: 'exists',
      negated,
      plan: make.project({ id: fresh('cp'), input: same, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] }),
    };
  };

  /**
   * A finished SET result: the members, deduped, back into one list — in VALUE order.
   *
   * A set has no member order, so the order is ours to choose, and choosing it is the point.
   * `Distinct` over `UNION ALL` is §3.3's declared collapse of SQL's distinct `UNION`, but the two
   * differ in an artifact: SQLite implements `UNION` by SORTING, so a `UNION`-based set result comes
   * out in storage-class order (`null`, numbers, then text) BY ACCIDENT while a `SELECT DISTINCT`
   * leaves it to a temp b-tree. Naming the order makes it deterministic by design — the alternative
   * was inheriting a dedup implementation detail as a contract.
   */
  const setOf = (rows: Rel): Rel => {
    const deduped = make.distinct({ id: fresh('sd'), input: rows, channels: [], type: rows.type });
    return withList(rel, listOfMembers(deduped, col(deduped.id, MEMBER.value),
      [{ expr: col(deduped.id, MEMBER.value), dir: 'asc' }], fresh), fresh);
  };

  /** The two sides' single-column member relations, unioned — the shape `merge` and `disjunct`
   *  aggregate over. `all: true` plus the `Distinct` in `setOf` IS SQL's distinct `UNION` (§3.3's
   *  declared collapse), so there is no second union node kind. */
  const union = (left: Rel, right: Rel): Rel => make.union({
    id: fresh('su'), inputs: [left, right], all: true, channels: [],
    type: typeOf(meta(MEMBER.value, 'any', true)),
  });

  const result = ((): Rel | null => {
    switch (step.name) {
      // CONCATENATION: my members then theirs, order, duplicates and nulls all kept. The segment
      // column is what makes "then" expressible — a UNION ALL has no order of its own.
      case 'combine': {
        const seg = (members: Rel, index: number): Rel => make.project({
          id: fresh('cs'), input: members, channels: [],
          type: typeOf(meta(MEMBER.value, 'any', true), meta('seg', 'int'), meta(MEMBER.ord, 'int')),
          exprs: [[MEMBER.value, col(members.id, MEMBER.value)], ['seg', compilerInt(index)], [MEMBER.ord, col(members.id, MEMBER.ord)]],
        });
        const both = make.union({
          id: fresh('cu'), inputs: [seg(mine, 0), seg(membersOf(operand, fresh), 1)],
          all: true, channels: [], type: typeOf(meta(MEMBER.value, 'any', true), meta('seg', 'int'), meta(MEMBER.ord, 'int')),
        });
        return withList(rel, listOfMembers(both, col(both.id, MEMBER.value),
          [{ expr: col(both.id, 'seg'), dir: 'asc' }, { expr: col(both.id, MEMBER.ord), dir: 'asc' }], fresh), fresh);
      }
      // MEMBERSHIP: mine that are (not) theirs, deduped.
      case 'intersect':
        return setOf(valuesOf(mine, MEMBER.value, (side) => contains(operand, col(side.id, MEMBER.value), false)));
      case 'difference':
        return setOf(valuesOf(mine, MEMBER.value, (side) => contains(operand, col(side.id, MEMBER.value), true)));
      // SYMMETRIC difference: in exactly one side, which is the two one-sided differences unioned.
      case 'disjunct':
        return setOf(union(
          valuesOf(mine, MEMBER.value, (side) => contains(operand, col(side.id, MEMBER.value), true)),
          valuesOf(membersOf(operand, fresh), MEMBER.value, (side) => contains(selfList, col(side.id, MEMBER.value), true)),
        ));
      // SET UNION: every distinct member of either side.
      case 'merge':
        return setOf(union(valuesOf(mine, MEMBER.value), valuesOf(membersOf(operand, fresh), MEMBER.value)));
      // CARTESIAN product → a list of PAIR-lists, so the result's members are lists and no further
      // member op reads it (`isBareList` names the scalar encodings only). The second `json_each`
      // takes the first as its INPUT, which is exactly a cross join.
      case 'product': {
        const paired = make.explode({
          id: fresh('px'), input: mine, expr: operand, channels: [], as: OPERAND,
          type: typeOf(...mine.type.cols, meta(OPERAND.value, 'any', true), meta(OPERAND.ord, 'int')),
        });
        const pair: Expr = { kind: 'json-array', items: [col(paired.id, MEMBER.value), col(paired.id, OPERAND.value)], binary: true };
        return withList(rel, listOfMembers(paired, pair,
          [{ expr: col(paired.id, MEMBER.ord), dir: 'asc' }, { expr: col(paired.id, OPERAND.ord), dir: 'asc' }], fresh), fresh);
      }
      default: return null;
    }
  })();
  if (!result) return null;

  // THE RESULT'S MEMBER TYPE IS THE TWO SIDES' MEET. Both sides were normalized to payloads above, so
  // the members no longer state their own types — but where BOTH were bare and AGREED on a static
  // tag, that tag still describes every member of the result and dropping it framed a set of longs
  // by JS inference.
  //
  // 🔴 AN ENVELOPE SIDE IS STILL FLATTENED, so a set-op over stored `datetime`s/`uuid`s loses their
  // types. Normalizing both sides to the TYPED encoding instead is the fix and it is
  // information-preserving (a bare member's tag is what `inferredVtype` reads off its storage class,
  // which is what the wire would infer anyway) — but it MUST be gated on the same RUNTIME lossy test
  // `foldScalars` spends, not on the compile-time `typed` flag. Measured by trying the compile-time
  // gate: `values('name').fold()` is `typed` while every member is bare at run time, so it wrapped
  // members that needed no envelope, changed the bytes of the common case and broke the
  // uniform-only-when-needed rule (6 failures). The runtime test has to span BOTH sides, which
  // is the part that does not exist yet: `withLossyFlag` asks it of one relation.
  //
  // One piece of it IS worth keeping and is not here: `memberTypeTag` returns a NULL tag unresolved
  // for a wrapped member whose `t` is null (`path().by(<a transform>)` writes exactly that), where a
  // null tag means "infer from the value" everywhere else in this channel. That is a latent defect in
  // the tag reader regardless of the set-op, and it surfaced as three conformance scenarios the
  // moment the tag joined a comparison.
  const merged = isTypedList(of) || isTypedList(resolved.of) ? UNKNOWN
    : sameScalarType(memberTypeOf(of) ?? UNKNOWN, memberTypeOf(resolved.of) ?? UNKNOWN)
      ? memberTypeOf(of) ?? UNKNOWN : UNKNOWN;
  // An ELEMENT-membered result keeps its members as ELEMENTS: every op admitted for `bothElem` above
  // carries the rowids through unchanged (a set op neither transforms nor pairs a member), and both
  // sides are the same kind, so the result is a list of that one kind — framed by `listPayloadExpr`'s
  // elem arm exactly as the input was. The scalar `merged` meet is irrelevant to it.
  const resultOf: ListOf = bothElem
    ? of
    : step.name === 'product'
      ? { kind: 'list', of: withMemberType(BARE_LIST, merged) }
      : withMemberType(BARE_LIST, merged);
  return { rel: result, of: resultOf, ...(SET_RESULT.has(step.name) && terminal ? { set: true } : {}) };
}

/** `unfold()` over a list whose MEMBERS are lists: each member becomes a list traverser of its own,
 *  written back WHOLE (`json(…)`) so a nested JSON array stays an array rather than being re-encoded
 *  as a string. Its own members keep the inner encoding, which is what `member` reports. */
function unfoldNested(rel: Rel, of: ListOf & { readonly kind: 'list' }, fresh: Minter): { readonly rel: Rel; readonly ord: string; readonly typed: boolean; readonly member: ListOf } {
  const exploded = make.explode({
    id: fresh('un'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
    type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
  });
  return {
    rel: make.project({
      id: fresh('ul'), input: exploded, channels: rel.channels,
      type: typeOf(meta(LIST_COL, 'json'), ...carriedCols(rel.channels), meta(MEMBER.ord, 'int')),
      exprs: [[LIST_COL, { kind: 'call', fn: 'json', args: [col(exploded.id, MEMBER.value)] }],
        ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
        [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
    }),
    ord: MEMBER.ord,
    typed: false,
    member: of.of,
  };
}

/** `unfold()` over a list of MAPS — `unfoldNested`'s twin, landing each member's pairs array in the
 *  `MAP_COL` the map vocabulary reads (`'map'`, spelled here rather than imported for the `map.ts` cycle
 *  `foldMaps` already documents). The member is a self-describing pairs array, so `json()` around it for
 *  the nested arm's reason: without it the enclosing explode's subtype does not survive. */
function unfoldMapMembers(rel: Rel, of: ListOf & { readonly kind: 'map' }, fresh: Minter): { readonly rel: Rel; readonly ord: string; readonly typed: boolean; readonly mapVal: MapOf } {
  const exploded = make.explode({
    id: fresh('um'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
    type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int'), meta(MEMBER.type, 'text', true)),
  });
  return {
    rel: make.project({
      id: fresh('umv'), input: exploded, channels: rel.channels,
      type: typeOf(meta('map', 'json'), ...carriedCols(rel.channels), meta(MEMBER.ord, 'int')),
      exprs: [['map', { kind: 'call', fn: 'json', args: [col(exploded.id, MEMBER.value)] }],
        ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
        [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
    }),
    ord: MEMBER.ord,
    typed: false,
    mapVal: of.of,
  };
}

/**
 * `is(P.typeOf(LIST|SET))` — a type ASSERT, which RETYPES the stream rather than filtering it.
 *
 * §11's trap in its original form: lowered as a predicate it returns the right ROWS framed as the
 * wrong SHAPE. What it actually means is "keep the rows whose stored value IS a collection, and treat
 * that value as the traverser" — so it needs a per-row stored `vtype` (a computed scalar has no stored
 * collection), and the members are the stored
 * collection's own self-describing `{t,v}` tree, i.e. a TYPED list.
 *
 * A SET differs only in the framing marker: the member substrate is shared, which is exactly why
 * `set` rides on the framing rather than on the relation.
 */
export function collectionRetype(rel: Rel, vtype: string, kind: 'list' | 'set', fresh: Minter): { readonly rel: Rel; readonly of: ListOf; readonly set: boolean } {
  const matching = make.filter({
    id: fresh('cr'), input: rel, channels: rel.channels, type: rel.type,
    pred: { kind: 'binary', op: '=', left: col(rel.id, vtype), right: compilerText(kind) },
  });
  return {
    rel: make.project({
      id: fresh('cl'), input: matching, channels: rel.channels,
      type: typeOf(meta(LIST_COL, 'json'), ...carriedCols(rel.channels)),
      exprs: [[LIST_COL, { kind: 'call', fn: 'json', args: [col(matching.id, 'v')] }],
        ...rel.channels.map((channel) => [channel.col, col(matching.id, channel.col)] as const)],
    }),
    of: TYPED_MEMBERS,
    set: kind === 'set',
  };
}

/**
 * THE LIST PAYLOAD — one row's `list` column, projected to the JSON the framing layer reads (§6·3).
 *
 * `null` declines, as everywhere in this module. Two encodings are served:
 *
 * - a SCALAR-membered list (bare, typed, or a set) is already frameable and rides out as `json(list)` —
 *   the relational column is JSONB, and `json()` is what turns it into the text the framer parses;
 * - a NESTED list is REBUILT one level at a time, because the raw inner values are arrays whose JSON
 *   subtype does not survive the enclosing aggregate. It recurses
 *   through the same member frame every other op in this module uses — `Explode` with no input, i.e. a
 *   correlated `FROM json_each(…)`, which is what makes a per-member computation a scalar subquery rather
 *   than a row multiplication.
 *
 * An ELEMENT-membered list is REBUILT the same way a nested one is, and for the same reason: the members
 * are ROWIDS (what `foldElements` collected) and the wire wants public payload objects, so each one is
 * expanded here — at the ROOT, once per surviving member — rather than inside the barrier that made the
 * list. The framer contract is `listItemBuffers`' own comment: element
 * items arrive as `{id,label,props[,src,tgt]}` objects, rowids already expanded in SQL. That is
 * `elementObject` and NOT `elementNode` — a `{t,v}` envelope here would be a level the `of.kind === 'elem'`
 * framer does not unwrap, and `of` has already said every member is an element.
 */
export function listPayloadExpr(list: Expr, of: ListOf, fresh: Minter): Expr | null {
  // A MIXED list's members were expanded to `{t,v}` envelopes AT THE SITE (`collection.ts`
  // `envelopeSites`) — the one place elements-until-root cannot hold, because a mixed union shares one
  // member column and a bare rowid is indistinguishable from a scalar in it. So there is nothing to
  // expand at the root: the column already holds the wire tree, exactly as the scalar arm's does.
  // A MAP-membered list needs no root expansion for the same reason `scalar`/`mixed` do not: each member
  // is already the self-describing pairs array the framer walks (`foldMaps` collected `json(MAP_COL)`),
  // so the column holds the wire tree and there are no rowids to expand.
  if (of.kind === 'scalar' || of.kind === 'mixed' || of.kind === 'map') return jsonOf(list);
  if (of.kind === 'elem') {
    const rowids = membersOf(jsonOf(list), fresh);
    const expanded = make.aggregate({
      id: fresh('le'), input: rowids, channels: [], type: typeOf(meta('members', 'json', true)),
      groupBy: [],
      aggs: [['members', {
        kind: 'agg', fn: 'json_group_array',
        // `json()` for `jsonOf`'s standing reason: without it the expanded object is re-encoded as a
        // JSON STRING inside the enclosing array.
        args: [jsonOf(elementObject(col(rowids.id, MEMBER.value), of.elem, fresh))],
        orderBy: [memberOrder(rowids)],
      }]],
    });
    return jsonOf(coalesce({ kind: 'scalar', plan: expanded }, EMPTY_ARRAY));
  }
  if (of.kind !== 'list') return null;
  const members = membersOf(jsonOf(list), fresh);
  const inner = listPayloadExpr(col(members.id, MEMBER.value), of.of, fresh);
  if (!inner) return null;
  return rebuiltMembers(members, inner, fresh);
}

/** The ordered `json_group_array` of a per-member expression, COALESCEd to `[]` and re-`json()`ed so the
 *  members' JSON subtype survives the enclosing aggregate. The shared tail of both list expanders. */
function rebuiltMembers(members: Rel, member: Expr, fresh: Minter): Expr {
  const rebuilt = make.aggregate({
    id: fresh('lp'), input: members, channels: [], type: typeOf(meta('members', 'json', true)),
    groupBy: [],
    aggs: [['members', { kind: 'agg', fn: 'json_group_array', args: [member], orderBy: [memberOrder(members)] }]],
  });
  return jsonOf(coalesce({ kind: 'scalar', plan: rebuilt }, EMPTY_ARRAY));
}

/**
 * A list's members as a SELF-DESCRIBING wire array — `listPayloadExpr`'s twin for the tree framer.
 *
 * The distinction is which framer reads the result, exactly the `elementNode`/`elementObject` split
 * (`element.ts`): `listPayloadExpr` targets the top-level `listItemBuffers` framer, whose `elem` arm
 * takes BARE `{id,label,props}` objects; this targets `frameTypedNode`, which walks a `{t,v}` tree and
 * needs every member tagged. So a list nested inside a MAP or RECORD field value (`project('ks').by(
 * __.out().fold())`, `group().by().by(__.out().fold())`) comes through here — its members are framed by
 * the tree walker, not the top-level list arm.
 *
 * - a SCALAR list's members are already frameable by `frameTypedNode` (a bare value infers, a `{t,v}`
 *   envelope self-describes), so it rides out as `json(list)` unchanged — the same shortcut
 *   `listPayloadExpr` takes for the same reason;
 * - a MAP list's members are self-describing pairs arrays; each becomes a `{t:'map', v:pairs}` node so
 *   the tree walker reads a map rather than an untyped array;
 * - an ELEMENT list's members are ROWIDS and expand to `elementNode` (the `{t,v}` form) — the one place
 *   this genuinely differs from `listPayloadExpr`, which expands to the bare `elementObject`;
 * - a NESTED list recurses under `listNode`, so a list of lists frames as `{t:'list', v:[{t:'list',…}]}`.
 */
export function listNodeExpr(list: Expr, of: ListOf, fresh: Minter): Expr | null {
  if (of.kind === 'scalar' || of.kind === 'mixed') return jsonOf(list);
  if (of.kind === 'map') {
    const members = membersOf(jsonOf(list), fresh);
    return rebuiltMembers(members, mapNode(jsonOf(col(members.id, MEMBER.value))), fresh);
  }
  if (of.kind === 'elem') {
    const members = membersOf(jsonOf(list), fresh);
    return rebuiltMembers(members, jsonOf(elementNode(col(members.id, MEMBER.value), of.elem, fresh)), fresh);
  }
  if (of.kind !== 'list') return null;
  const members = membersOf(jsonOf(list), fresh);
  const inner = listNodeExpr(col(members.id, MEMBER.value), of.of, fresh);
  return inner && rebuiltMembers(members, listNode(inner), fresh);
}

/** The list relation as WIRE ROWS: one `list` column per traverser, in emission order, plus the `Shape`
 *  that says how to frame each member. The arm ORDER is deliberate — a nested list is
 *  framed as a `jsonbList` whatever `set` says, because a set OF LISTS has no distinct wire form. */
export function listPayload(rel: Rel, of: ListOf, set: boolean, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } | null {
  const ordered = byEncounter(rel, fresh);
  const payload = listPayloadExpr(col(ordered.id, LIST_COL), of, fresh);
  if (!payload) return null;
  const shape: Shape = of.kind === 'list' ? { kind: 'jsonbList', items: of }
    : set ? { kind: 'jsonbSet', items: of }
      : { kind: 'jsonbList', items: of };
  return {
    rel: make.project({
      id: fresh('lw'), input: ordered, channels: [], type: typeOf(meta(LIST_COL, 'json', true)),
      exprs: [[LIST_COL, payload]],
    }),
    shape,
  };
}
