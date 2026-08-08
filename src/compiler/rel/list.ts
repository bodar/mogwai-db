import { col, compilerInt, compilerNull, compilerText, lit, type Expr } from '../../rel/expr.ts';
import { sliceBound } from './const.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { SortTerm } from '../../rel/types.ts';
import { hasTypedMembers, memberTypeOf, sameScalarType, perRowColumnOf, PER_ROW_ENVELOPE, SCALAR_MEMBERS, STATIC, TYPED_MEMBERS, UNKNOWN, withMemberType, type ListOf, type ScalarType, type Shape } from '../../sql/kernel/render.ts';
import { isNested, isPred, argValues } from '../../gremlin/frontend.ts';
import { isLocalScope, LIST_LOCAL_TX, sliceOf, sliceParamNames, STRING_LOCAL_TX } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { ChildSeam } from './child.ts';
import { byEncounter, carriedCols, coalesce, collectedOf, EMPTY_ARRAY, fenced, jsonOf, meta, typedNode, typeOf, withPayload, type Minter } from './build.ts';
import { predicateExpr, storedCompareOn, SUBJECT_UNKNOWN } from './predicate.ts';
import { modulations } from './modulator.ts';
import { elementObject } from './element.ts';
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
 * missing and not the operations. Legacy says the same thing (`list.ts` calls `scalarTx` per
 * member); the difference is that there it is four hand-written correlated subqueries and here it is
 * `membersOf` + `listOfMembers`.
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
 * WITHOUT `Scope.local` is a permanent type error on a collection and legacy raises TinkerPop's own
 * message for it (`The toUpper() step can only take string as argument`) — so this declines and lets
 * the spine that owns the message raise it, rather than inventing a second one.
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
 * THE TWO WAYS TO READ A MEMBER, and which one an op needs is decided by what it does with it —
 * legacy's `memberValue`/`memberNode`, same rule, the algebra's vocabulary.
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
 *  recorded, so its type is INFERRED from the storage class, which is what the wire would do anyway
 *  and what legacy's `inferVtypeSql` spells. */
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
 * LEXICOGRAPHICALLY. Measured before this existed, on BOTH spines:
 * `inject(9007199254740993L, 10007199254740993L).fold().max(Scope.local)` answered the SMALLER value
 * and `min(Scope.local)` the larger, while the global `max()` — which already had this authority —
 * answered correctly. One step name, two engines, and only one of them had been fixed.
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
 *  inference (legacy's `retypedList`). Note this is the `unknown` member type and NOT "no type":
 *  a rewrite that KNOWS the result class says so with `withMemberType(of, STATIC(…))`. */
export const BARE_LIST: ListOf = SCALAR_MEMBERS;

const isTypedList = hasTypedMembers;

/** Is this list's member encoding one this module can read? Every scalar member type — untagged,
 *  statically tagged and self-describing — but not an ELEMENT or a nested list, whose members are
 *  rowids and sub-lists respectively and need their own expansion. */
export const isBareList = (of: ListOf): boolean => of.kind === 'scalar';

/**
 * A bare member's canonical Gremlin type, inferred from its SQLite storage class — legacy's
 * `inferVtypeSql`, re-expressed. It is the same inference the wire would apply to an untagged value,
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
 * ONE member predicate for `all`/`any`/`none`, null-aware — the same rule legacy's `memberPredicate`
 * encodes, and it must be stated here too because the two spines render predicates in different
 * vocabularies (`Expression` vs `Expr`) while the SEMANTIC rule is one.
 *
 * `P.eq(null)`/`P.neq(null)` cannot go through the ordinary predicate builder: SQL's `= NULL` is
 * NULL, so a null member would never satisfy an `eq(null)`. TinkerPop compares with
 * `Objects.equals`. Getting this wrong on the legacy side answered `IS NULL` for EVERY `eq` — see
 * `test/L4-addendum/list-member-predicate.feature`.
 */
const memberPredicate = (member: Expr, pred: unknown): Expr | null => {
  if (isPred(pred) && (pred.op === 'eq' || pred.op === 'neq') && pred.operands[0]?.value === null)
    return { kind: 'binary', op: pred.op === 'eq' ? 'is' : 'is not', left: member, right: compilerNull() };
  return predicateExpr(member, pred, SUBJECT_UNKNOWN);
};

/**
 * A list op that KEEPS the list shape, or `null` to decline.
 *
 * Three families, one frame. A member TRANSFORM rewrites each member; a local SLICE takes a window
 * of the members in position order; `all`/`any`/`none` filter the whole traverser on a member
 * predicate and pass the list through untouched.
 */
export function listMemberOp(
  step: IRStep, input: Rel, of: ListOf, fresh: Minter, child?: ChildSeam,
): { readonly rel: Rel; readonly of: ListOf; readonly rewrites?: boolean; readonly set?: boolean } | null {
  if (step.modulators?.length || step.optionArms || !isBareList(of)) return null;
  const rel = fenced(input, fresh);
  const list = col(rel.id, LIST_COL);

  // A STRING transform maps over the members — and only with `Scope.local`. Its global spelling is a
  // permanent type error on a collection (a list is not a string) which legacy raises TinkerPop's own
  // message for, so declining hands it the message rather than inventing a second one.
  if (STRING_LOCAL_TX.has(step.name)) {
    if (!isLocalScope(step)) return null;
    const members = membersOf(list, fresh);
    // `literal: false` — a member is a value inside a JSON document, not a compile-time literal the
    // constant-folding arms could evaluate, so the folded transforms (`asBool`, bare `asNumber`)
    // decline here exactly as they do over a column.
    const tx = transformExpr(step, memberPayload(of, members), false);
    if (!tx) return null;
    // A REWRITE reads the payload and writes a BARE member: the recorded type no longer describes the
    // new value (`length()` makes it an integer outright), so re-tagging it would frame the RESULT as
    // the INPUT's type. Legacy's `retypedList` says the same.
    // `rewrites` is what a SET marker cannot survive: the members are new values, so "these are the
    // distinct results of a set operation" has stopped being true of them. A slice and a whole-traverser
    // filter both leave the members alone and keep it.
    return { rel: withList(rel, listOfMembers(members, tx.expr, [memberOrder(members)], fresh), fresh), of: BARE_LIST, rewrites: true };
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
      // FIRST OCCURRENCE WINS and the surviving order is the original one — `DedupLocalStep` builds a
      // `LinkedHashSet`, so it is insertion order over distinct values. `min(mo)` per distinct payload
      // is that, in one aggregate: the earliest position each value appeared at.
      if (step.modulators?.length || argValues(step).length) return null;
      const distinct = make.aggregate({
        id: fresh('md'), input: members, channels: [],
        type: typeOf(meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int')),
        groupBy: [payload],
        aggs: [[MEMBER.value, { kind: 'agg', fn: 'min', args: [col(members.id, MEMBER.value)] }],
          [MEMBER.ord, { kind: 'agg', fn: 'min', args: [col(members.id, MEMBER.ord)] }]],
      });
      // A DEDUPED list is a SET on the wire (`DedupLocalStep` yields a `LinkedHashSet`), which is the
      // same marker `listSetOp`'s four deduping ops carry — and `listTail` now threads it.
      return {
        rel: withList(rel, listOfMembers(distinct, memberNode(of, distinct), [{ expr: col(distinct.id, MEMBER.ord), dir: 'asc' }], fresh), fresh),
        of, set: true,
      };
    }
    // A `by()` needs the seam to normalize a nested body; a caller with none may still order by the
    // bare member, which is the only form this arm serves anyway.
    if (!child && step.modulators?.length) return null;
    const bys = child ? modulations(step, (step.modulators ?? []).length, child) : [];
    if (!bys) return null;
    const parsed = bys.length ? bys : [{ key: { kind: 'identity' } as const }];
    // ONE key, and it must be the MEMBER ITSELF. A member has exactly one value, so a second `by()`
    // would have nothing to name; a PROJECTION off it (`by('age')`, a nested body) is a question about
    // an element, which is the child seam's rather than this module's — `isBareList` has already
    // gated the only list that could answer it. `shuffle` is `RANDOM()` per row, its own answer.
    if (parsed.length !== 1 || parsed[0]!.key.kind !== 'identity' || parsed[0]!.order === 'shuffle') return null;
    const only = parsed[0]!;
    // `memberCompareKey`, NOT a second policy: it is the same `storedCompareOn` authority the
    // row-level `order().by()` and the local reducers spend, so a value carried as decimal TEXT
    // (a long past 2^53, a bigint, a bigdecimal, a duration) sorts NUMERICALLY rather than
    // lexicographically. Getting that wrong is the defect the local reducers already had.
    const key = memberCompareKey(of, members);
    return {
      rel: withList(rel, listOfMembers(members, memberNode(of, members), [
        { expr: key, dir: only.order === 'desc' ? 'desc' : 'asc' },
        // THE ORIGINAL POSITION BREAKS TIES, and it is not tidiness: `json_group_array` takes rows in
        // whatever order SQLite produced, so equal keys would land in an arbitrary one — the defect
        // `mise run test:perturbed` exists to find and that no assertion in the ladder can see.
        memberOrder(members),
      ], fresh), fresh),
      of,
    };
  }

  if (LIST_LOCAL_TX.has(step.name) && isLocalScope(step)) {
    const window = step.name === 'tail'
      ? { offset: 0, limit: Number(argValues(step).find((arg) => typeof arg === 'number') ?? 1) }
      : (() => { try { return sliceOf(step); } catch { return null; } })();
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
    if (args.length !== 1) return null;
    const members = membersOf(list, fresh);
    const pred = memberPredicate(memberPayload(of, members), args[0]);
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
  if (step.modulators?.length || step.optionArms || !isBareList(of)) return null;
  const args = argValues(step);
  const rel = fenced(input, fresh);
  const list = col(rel.id, LIST_COL);

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

  // `count(Scope.local)` counts the MEMBERS — a long, and the one local reduction that needs no
  // eligibility guard because a member's storage class cannot make it uncountable.
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
      // fenced, for the same plan). Legacy reaches the same place with a `derived` subquery.
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
    // and was silently EXCLUDED — the row-level defect §13g·5 records, reachable here through exactly
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
export function unfoldList(
  rel: Rel, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly ord: string; readonly typed: boolean; readonly member?: ListOf; readonly elem?: Elem } | null {
  // A NESTED list unfolds into one LIST traverser per member (a `product()`'s pair-lists), which is
  // the same explode with a different payload column — so it is one arm rather than a second function.
  if (of.kind === 'list') return unfoldNested(rel, of, fresh);
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
 * `fold()` — the SCALAR stream's barrier into one list traverser, and the other half of the
 * `jsonbList` arm (109 of the family's remaining blockers all stop here).
 *
 * The barrier itself is one `Aggregate`; what makes it an increment is the MEMBER ENCODING, and that
 * decision is legacy's `foldMember` re-expressed rather than re-decided:
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
 * "About the whole list" is a WINDOW here, not legacy's second alias over the same relation:
 * `MAX(<is this row lossy>) OVER ()` is 1 iff any row is. Legacy notes that a window "cannot nest
 * inside the json_group_array aggregate" and reaches for `EXISTS` over a second alias instead — true
 * of one SELECT, and not a constraint on a normalized IR: the window is its own node, so the
 * aggregate reads a COLUMN and the assembler opens the nested SELECT that makes it legal (it already
 * refuses to fuse an `Aggregate` over a windowed block). The alternative — an `Exists` whose subplan
 * SHARES the aggregate's input — is what the algebra actually refuses: the `name` pass does not walk
 * expression subplans, so one node would become a `Ref` in one place and stay itself in the other,
 * and `check` fails closed on the ambiguity ("names two different relations in one scope").
 *
 * The list's member order is the EMISSION order where one is carried: `Agg.orderBy` is what that
 * needs, so there is no node-set question. Without one the list keeps incidental row order, which is
 * what legacy does and what `analyzeChain` guarantees cannot matter (`fold` is a COLLECTING consumer,
 * so a chain that reaches one always demands an encounter).
 */
export function foldScalars(
  input: Rel,
  opts: { readonly type: ScalarType; readonly productiveNull?: boolean; readonly encounter?: string },
  fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  // The type column and the position are named rather than passed as EXPRESSIONS, because the relation
  // an expression must address is the window's output and not the caller's input: every node here
  // addresses its own INPUT, and the lossy flag inserts one.
  const vtypeCol = perRowColumnOf(opts.type);
  const vtype = vtypeCol ? col(input.id, vtypeCol) : undefined;
  const flagged = vtype ? withLossyFlag(input, vtype, fresh) : input;
  const order: readonly SortTerm[] = opts.encounter ? [{ expr: col(flagged.id, opts.encounter), dir: 'asc' }] : [];
  const value = col(flagged.id, 'v');
  const member = vtype
    ? {
      kind: 'case',
      whens: [[col(flagged.id, LOSSY_COL), typedNode(value, col(flagged.id, vtypeCol!))]],
      else: value,
    } as Expr
    : value;
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
 * already the `ListOf` arm legacy produced and the framer already read (`listItemBuffers`,
 * `execute.ts`); this is the increment that first PRODUCES one on this spine, which is exactly what
 * `listPayloadExpr`'s decline comment said it was waiting for.
 *
 * The member ORDER is the emission order where one is carried, which for a `fold()` is always:
 * `analyzeChain` makes `fold` a COLLECTING consumer, so a chain reaching one demands an encounter.
 * `COALESCE(…, '[]')` because a fold over ZERO traversers emits `[]` rather than nothing —
 * `FoldStep` supplies a seed, which is the per-step rule §12 cites `gremlin-core` for.
 */
export function foldElements(
  input: Rel, elem: Elem, opts: { readonly encounter?: string }, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  const order: readonly SortTerm[] = opts.encounter ? [{ expr: col(input.id, opts.encounter), dir: 'asc' }] : [];
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

/** The three storage-class-determined types: a member of one of these needs no envelope, because the
 *  wire would infer exactly that type from the value itself. Legacy's `LOSSLESS_VTYPES`. */
const LOSSLESS_VTYPES = ['string', 'double', 'int'] as const;

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
 * which is the root rule about a set sized by DATA rather than by query text, and which legacy
 * already spells this way. A TRAVERSAL operand (`merge(__.V().values('name').fold())`) is a child
 * read and declines; a `Map` operand is a permanent type error whose message legacy owns.
 *
 * **A typed self side is projected to PAYLOADS first**, because the operand is always bare: comparing
 * `{"t":"int","v":5}` against `5` would never match, and emitting a mix of both encodings inside one
 * result list is the corruption the uniform-per-list rule exists to prevent. So a typed self makes
 * the result BARE, which is what legacy's `retypedList` says too.
 */
const SET_OPS = new Set(['combine', 'intersect', 'difference', 'disjunct', 'merge', 'product']);

/** The four whose result is a SET rather than a list — deduped content, and it frames as a
 *  GraphBinary SET only when TERMINAL: with a follower (`order(Scope.local)`, `unfold()`) TinkerPop
 *  treats it as a plain List, which is what the suite asserts. */
const SET_RESULT = new Set(['intersect', 'difference', 'disjunct', 'merge']);

const OPERAND = { value: 'ov', ord: 'oo' } as const;

/**
 * A set-op OPERAND as a list expression, or `null` to decline — three forms, one question.
 *
 * A literal ARRAY and `constant(c).fold()` are both COMPILE-TIME lists (the second a one-member one,
 * which is the same fact rather than a special case, and exactly how legacy resolves it). A rooted
 * SUB-READ is a relation: its members are only known at run time, so it is lowered by the same fold
 * and read through a `Scalar` expression — no escape node, and if the inner chain is not covered the
 * decline propagates outward, which is the contract one level down.
 *
 * The ADMISSION RULE over the seam's answer is this module's, not the seam's (§6·6): an operand must
 * be LIST-framed, because legacy shares one rule between the set-op operands and the predicate ones
 * (`foldedListSubquery`) and the two cannot be allowed to disagree about which traversals qualify — a
 * scalar-valued sub-read is not a collection. An operand with EFFECTS is refused for a harder reason:
 * its statements are `Plan` bindings the operand expression cannot carry, so splicing only the
 * relation would drop the write and leave a `Ref` naming a binding that was never made.
 */
function operandList(arg: unknown, child: ChildSeam): { readonly expr: Expr; readonly of: ListOf } | null {
  const literal = (members: readonly unknown[]) =>
    ({ expr: { kind: 'call', fn: 'jsonb', args: [lit(JSON.stringify(members), 'text')] } as Expr, of: BARE_LIST });
  if (Array.isArray(arg)) return literal(arg);
  if (!isNested(arg)) return null;
  const inner = child.body((arg as { readonly nested: unknown }).nested, 'child');
  if (!inner?.length) return null;
  if (inner.length === 2 && inner[0]?.name === 'constant' && inner[1]?.name === 'fold') {
    const [value, extra] = argValues(inner[0]);
    if (extra !== undefined || value === undefined) return null;
    return literal([value]);
  }
  const read = child.rooted(inner);
  if (!read || read.effects?.length || read.framing.kind !== 'list') return null;
  return { expr: { kind: 'scalar', plan: read.rel }, of: read.framing.of };
}

export function listSetOp(
  step: IRStep, input: Rel, of: ListOf, terminal: boolean, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly set?: boolean } | null {
  if (step.modulators?.length || step.optionArms || !SET_OPS.has(step.name) || !isBareList(of)) return null;
  const [arg, extra] = argValues(step);
  if (extra !== undefined) return null;
  const resolved = operandList(arg, child);
  if (!resolved || !isBareList(resolved.of)) return null;
  const rel = fenced(input, fresh);

  // BOTH SIDES IN ONE VOCABULARY: bare payloads. A typed list's members MAY be `{t,v}` envelopes, and
  // comparing an envelope against a bare value never matches — so either side that might carry one is
  // re-emitted as its payloads first, through the same member frame every other op uses. Legacy only
  // does this to the SELF side, which happens to work because its sub-read operands are all
  // storage-class-determined on the reference graph; doing it to both is the same code and correct for
  // an operand that is not.
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
   * differ in an artifact: SQLite implements `UNION` by SORTING, so legacy's set results come out in
   * storage-class order (`null`, numbers, then text) BY ACCIDENT while a `SELECT DISTINCT` leaves it to
   * a temp b-tree. Naming the order makes it deterministic by design AND identical to the answer
   * legacy gives today — the alternative was inheriting a dedup implementation detail as a contract.
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
      // takes the first as its INPUT, which is exactly the cross join legacy writes.
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
  // by JS inference. An ENVELOPE side is honestly `unknown` here: flattening it to payloads is what
  // put the two sides in one vocabulary, and recovering the tags needs both sides normalized to the
  // TYPED encoding instead — a different design, noted rather than half-done.
  const merged = isTypedList(of) || isTypedList(resolved.of) ? UNKNOWN
    : sameScalarType(memberTypeOf(of) ?? UNKNOWN, memberTypeOf(resolved.of) ?? UNKNOWN)
      ? memberTypeOf(of) ?? UNKNOWN : UNKNOWN;
  const resultOf: ListOf = step.name === 'product'
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

/**
 * `is(P.typeOf(LIST|SET))` — a type ASSERT, which RETYPES the stream rather than filtering it.
 *
 * §11's trap in its original form: lowered as a predicate it returns the right ROWS framed as the
 * wrong SHAPE. What it actually means is "keep the rows whose stored value IS a collection, and treat
 * that value as the traverser" — so it needs a per-row stored `vtype` (a computed scalar has no stored
 * collection, and legacy's generic `is()` static-folds that case), and the members are the stored
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
 * THE LIST PAYLOAD — one row's `list` column, projected to the JSON the framing layer reads (§10·10).
 *
 * `null` declines, as everywhere in this module. Two encodings are served and each is what legacy's
 * `materializeListRoot` builds for it:
 *
 * - a SCALAR-membered list (bare, typed, or a set) is already frameable and rides out as `json(list)` —
 *   the relational column is JSONB, and `json()` is what turns it into the text the framer parses;
 * - a NESTED list is REBUILT one level at a time, because the raw inner values are arrays whose JSON
 *   subtype does not survive the enclosing aggregate. That is legacy's `nestedListResult` and it recurses
 *   through the same member frame every other op in this module uses — `Explode` with no input, i.e. a
 *   correlated `FROM json_each(…)`, which is what makes a per-member computation a scalar subquery rather
 *   than a row multiplication.
 *
 * An ELEMENT-membered list is REBUILT the same way a nested one is, and for the same reason: the members
 * are ROWIDS (what `foldElements` collected) and the wire wants public payload objects, so each one is
 * expanded here — at the ROOT, once per surviving member — rather than inside the barrier that made the
 * list. Legacy's `elementListResult`, and the framer contract is `listItemBuffers`' own comment: element
 * items arrive as `{id,label,props[,src,tgt]}` objects, rowids already expanded in SQL. That is
 * `elementObject` and NOT `elementNode` — a `{t,v}` envelope here would be a level the `of.kind === 'elem'`
 * framer does not unwrap, and `of` has already said every member is an element.
 */
function listPayloadExpr(list: Expr, of: ListOf, fresh: Minter): Expr | null {
  if (of.kind === 'scalar') return jsonOf(list);
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
  const rebuilt = make.aggregate({
    id: fresh('lp'), input: members, channels: [], type: typeOf(meta('members', 'json', true)),
    groupBy: [],
    aggs: [['members', { kind: 'agg', fn: 'json_group_array', args: [inner], orderBy: [memberOrder(members)] }]],
  });
  return jsonOf(coalesce({ kind: 'scalar', plan: rebuilt }, EMPTY_ARRAY));
}

/** The list relation as WIRE ROWS: one `list` column per traverser, in emission order, plus the `Shape`
 *  that says how to frame each member. Legacy's arm ORDER is preserved deliberately — a nested list is
 *  framed as a `jsonbList` whatever `set` says, because a set OF LISTS has no distinct wire form and
 *  `materializeListRoot` decides it the same way. */
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
