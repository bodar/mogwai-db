import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { SortTerm } from '../../rel/types.ts';
import { STATIC, UNKNOWN, type ListOf } from '../../sql/kernel/render.ts';
import { isPred } from '../../gremlin/frontend.ts';
import { isLocalScope, sliceOf } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import { LIST_LOCAL_TX, STRING_LOCAL_TX } from '../steps/tail/list.ts';
import { meta, typeOf, type Minter } from './build.ts';
import { predicateExpr, SUBJECT_UNKNOWN } from './predicate.ts';
import { isReducer, reducerAggregate } from './reducer.ts';
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
 * Only a BARE member encoding is served today: a `typed` list's members are self-describing `{t,v}`
 * nodes, which needs the same decode `fold()` over a stored-property stream produces, and that is
 * the next increment rather than a guess here.
 */

/** The member relation's two columns: the value, and its position in the list (`json_each.key`,
 *  which for a JSON array IS the index). Named once because every op reads both. */
const MEMBER = { value: 'mv', ord: 'mo' } as const;

/** A list's MEMBERS as a relation — `FROM json_each(<list>)`, correlated to whatever relation the
 *  list expression came from. No `input`, which is what makes it correlated (see `rel.ts`). */
const membersOf = (list: Expr, fresh: Minter): Rel => make.explode({
  id: fresh('mx'), expr: list, channels: [], as: MEMBER,
  type: typeOf(meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int')),
});

const memberValue = (members: Rel): Expr => col(members.id, MEMBER.value);
const memberOrder = (members: Rel, dir: 'asc' | 'desc' = 'asc'): SortTerm =>
  ({ expr: col(members.id, MEMBER.ord), dir });

/**
 * The members BACK to a list value — `jsonb(COALESCE(json_group_array(<member> ORDER BY …), '[]'))`.
 *
 * The `COALESCE` is not defensive: `json_group_array` over ZERO rows is NULL, so an empty list would
 * come back as a null traverser value rather than as an empty list. Legacy spells it the same way.
 */
const listOfMembers = (members: Rel, member: Expr, order: readonly SortTerm[], fresh: Minter): Expr => ({
  kind: 'scalar',
  plan: make.aggregate({
    id: fresh('ma'), input: members, channels: [], type: typeOf(meta('list', 'json')),
    groupBy: [],
    aggs: [['list', {
      kind: 'call',
      fn: 'jsonb',
      args: [{
        kind: 'call',
        fn: 'COALESCE',
        args: [{ kind: 'agg', fn: 'json_group_array', args: [member], orderBy: order },
          { kind: 'call', fn: 'json', args: [lit('[]', 'text')] }],
      }],
    }]],
  }),
});

/** The list column every list relation carries. One name, because the framing layer reads it too. */
export const LIST_COL = 'list';

/** Replace a relation's list value, keeping every other column (and channel) exactly as it was — the
 *  shape every member op that STAYS a list produces. */
const withList = (rel: Rel, list: Expr, fresh: Minter): Rel => make.project({
  id: fresh('lv'), input: rel, channels: rel.channels, type: rel.type,
  exprs: rel.type.cols.map((column) =>
    [column.name, column.name === LIST_COL ? list : col(rel.id, column.name)] as const),
});

/** A bare list of scalars — the one member encoding this module serves, and what a member REWRITE
 *  always produces: a transformed member is a native value the stored type no longer describes, so
 *  the output list is untagged and framed by per-value inference (legacy's `retypedList`). */
export const BARE_LIST: ListOf = { kind: 'scalar' };

/** Is this list's member encoding one this module can read? A `typed` list carries `{t,v}` nodes and
 *  needs the decode `fold()` over a stored-property stream produces — the next increment. */
export const isBareList = (of: ListOf): boolean => of.kind === 'scalar' && !of.typed;

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
  if (isPred(pred) && (pred.op === 'eq' || pred.op === 'neq') && pred.values[0] === null)
    return { kind: 'binary', op: pred.op === 'eq' ? 'is' : 'is not', left: member, right: lit(null, 'any') };
  return predicateExpr(member, pred, SUBJECT_UNKNOWN);
};

/**
 * A list op that KEEPS the list shape, or `null` to decline.
 *
 * Three families, one frame. A member TRANSFORM rewrites each member; a local SLICE takes a window
 * of the members in position order; `all`/`any`/`none` filter the whole traverser on a member
 * predicate and pass the list through untouched.
 */
export function listMemberOp(step: IRStep, rel: Rel, of: ListOf, fresh: Minter): { readonly rel: Rel; readonly of: ListOf } | null {
  if (step.modulators?.length || step.optionArms || !isBareList(of)) return null;
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
    const tx = transformExpr(step, memberValue(members), false);
    if (!tx) return null;
    return { rel: withList(rel, listOfMembers(members, tx.expr, [memberOrder(members)], fresh), fresh), of: BARE_LIST };
  }

  // A LOCAL slice takes a window of the MEMBERS, in position order — and `tail(Scope.local, n)` takes
  // it from the far end, which is the same direction flag the row slice uses. The members keep their
  // original positions (the re-aggregate orders by `mo`), so a slice of a slice composes.
  if (LIST_LOCAL_TX.has(step.name) && isLocalScope(step)) {
    if (step.name === 'order' || step.name === 'dedup') return null;
    const window = step.name === 'tail'
      ? { offset: 0, limit: Number((step.args ?? []).find((arg: unknown) => typeof arg === 'number') ?? 1) }
      : (() => { try { return sliceOf(step); } catch { return null; } })();
    if (!window) return null;
    const members = membersOf(list, fresh);
    const ordered = make.sort({
      id: fresh('ms'), input: members, channels: [], type: members.type,
      terms: [memberOrder(members, step.name === 'tail' ? 'desc' : 'asc')],
    });
    const taken = make.limit({
      id: fresh('ml'), input: ordered, channels: [], type: ordered.type,
      ...(window.limit === null ? {} : { count: lit(window.limit, 'int') }),
      ...(window.offset ? { offset: lit(window.offset, 'int') } : {}),
    });
    // The AGGREGATE reads the sliced relation, so the member expression and the order term name
    // `taken` rather than the explode — the slice is a relation between them.
    return {
      rel: withList(rel, listOfMembers(taken, col(taken.id, MEMBER.value), [{ expr: col(taken.id, MEMBER.ord), dir: 'asc' }], fresh), fresh),
      of,
    };
  }

  // `all`/`any`/`none` are WHOLE-TRAVERSER filters: the list passes through byte-identical or not at
  // all. `all` is "no member fails", which is not the same as "every member passes" once a predicate
  // can be NULL — hence `IS NOT TRUE` rather than `NOT (…)`.
  if (step.name === 'all' || step.name === 'any' || step.name === 'none') {
    const args = step.args ?? [];
    if (args.length !== 1) return null;
    const members = membersOf(list, fresh);
    const pred = memberPredicate(memberValue(members), args[0]);
    if (!pred) return null;
    const failing: Expr = { kind: 'binary', op: 'is not', left: pred, right: lit(1, 'int') };
    const probe = (test: Expr): Rel => make.project({
      id: fresh('mp'), input: make.filter({ id: fresh('mf'), input: members, channels: [], type: members.type, pred: test }),
      channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', lit(1, 'int')]],
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
  step: IRStep, rel: Rel, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly type: import('../../sql/kernel/render.ts').ScalarType; readonly result?: 'number' | 'count' } | null {
  if (step.modulators?.length || step.optionArms || !isBareList(of)) return null;
  const args = step.args ?? [];
  const list = col(rel.id, LIST_COL);

  // `conjoin(sep)` joins the MEMBERS into one string, skipping nulls — so the result is a string
  // whatever the members were, and an all-null list conjoins to `''` rather than to NULL.
  if (step.name === 'conjoin') {
    const [sep, extra] = args;
    if (typeof sep !== 'string' || extra !== undefined) return null;
    const members = membersOf(list, fresh);
    const present = make.filter({
      id: fresh('mf'), input: members, channels: [], type: members.type,
      pred: { kind: 'binary', op: 'is not', left: memberValue(members), right: lit(null, 'any') },
    });
    const joined: Expr = {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mj'), input: present, channels: [], type: typeOf(meta('v', 'text', true)),
        groupBy: [],
        aggs: [['v', {
          kind: 'call',
          fn: 'COALESCE',
          args: [{ kind: 'agg', fn: 'group_concat', args: [col(present.id, MEMBER.value), lit(sep, 'text')], orderBy: [{ expr: col(present.id, MEMBER.ord), dir: 'asc' }] },
            lit('', 'text')],
        }]],
      }),
    };
    return { rel: scalarOf(rel, [['v', joined]], [meta('v', 'text', true)], fresh), type: STATIC('string') };
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
    return { rel: scalarOf(rel, [['v', total]], [meta('v', 'int')], fresh), type: STATIC('long'), result: 'count' };
  }

  // The REDUCER family over the members — the same `reducer.ts` authority the row-level reducers use,
  // so the eligibility guard, the dynamic result class and `mean`'s forced REAL are stated once. There
  // is no multiplicity inside a list: a member is one value, so the bulk-weighted form never applies.
  if (isReducer(step.name) && isLocalScope(step)) {
    if (args.some((arg) => typeof arg === 'number')) return null;
    const members = membersOf(list, fresh);
    const reduced = reducerAggregate(memberValue(members), step.name);
    const scalar = (value: Expr, name: string, type: 'any' | 'text'): readonly [string, Expr] => [name, {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mr'), input: members, channels: [], type: typeOf(meta(name, type, true)),
        groupBy: [], aggs: [[name, value]],
      }),
    }];
    // TWO correlated subqueries over the same members, which is what legacy emits too: the result's
    // storage class is `typeof(<the aggregate>)`, and SQL has nowhere to name the aggregate once.
    return {
      rel: scalarOf(rel, [scalar(reduced.value, 'v', 'any'), scalar(reduced.type, 'vt', 'text')],
        [meta('v', 'any', true), meta('vt', 'text', true)], fresh),
      type: UNKNOWN, result: 'number',
    };
  }

  return null;
}

/** Replace a list relation's payload with scalar columns, keeping the carried channels — the
 *  projection every retype above ends with. */
const scalarOf = (
  rel: Rel, exprs: readonly (readonly [string, Expr])[], cols: readonly import('../../rel/types.ts').ColMeta[], fresh: Minter,
): Rel => make.project({
  id: fresh('ls'), input: rel, channels: rel.channels,
  type: typeOf(...cols, ...rel.channels.map((channel) => meta(channel.col, 'int'))),
  exprs: [...exprs, ...rel.channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
});

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
export function unfoldList(rel: Rel, of: ListOf, fresh: Minter): { readonly rel: Rel; readonly ord: string } | null {
  if (!isBareList(of)) return null;
  const exploded = make.explode({
    id: fresh('uf'), input: rel, expr: col(rel.id, LIST_COL), channels: rel.channels, as: MEMBER,
    type: typeOf(...rel.type.cols, meta(MEMBER.value, 'any', true), meta(MEMBER.ord, 'int')),
  });
  return {
    rel: make.project({
      id: fresh('uv'), input: exploded, channels: rel.channels,
      type: typeOf(meta('v', 'any', true), ...rel.channels.map((channel) => meta(channel.col, 'int')), meta(MEMBER.ord, 'int')),
      exprs: [['v', col(exploded.id, MEMBER.value)],
        ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
        [MEMBER.ord, col(exploded.id, MEMBER.ord)]],
    }),
    ord: MEMBER.ord,
  };
}
