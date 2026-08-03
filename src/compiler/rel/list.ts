import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { SortTerm } from '../../rel/types.ts';
import { STATIC, UNKNOWN, type ListOf, type ValueType } from '../../sql/kernel/render.ts';
import { isPred } from '../../gremlin/frontend.ts';
import { isLocalScope, sliceOf } from '../ir/step.ts';
import type { IRStep } from '../ir/strategies.ts';
import { LIST_LOCAL_TX, STRING_LOCAL_TX } from '../steps/tail/list.ts';
import { meta, typedNode, typeOf, type Minter } from './build.ts';
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
 * BOTH scalar member encodings are served: a BARE list, and a SELF-DESCRIBING one whose members may
 * be `{t,v}` nodes (what `fold()` over a per-row-typed stream produces). `memberPayload`/`memberNode`
 * are the two reads and every op goes through one of them, which is what lets a typed list flow
 * through the same code as an untyped one instead of failing closed. An ELEMENT list (rowids) and a
 * NESTED list are not served — each needs its own expansion, not a decode.
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

const eqText = (subject: Expr, value: string): Expr => ({ kind: 'binary', op: '=', left: subject, right: lit(value, 'text') });
const jsonField = (node: Expr, field: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [node, lit(`$.${field}`, 'text')] });

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

/**
 * A FENCE in front of a member op, and it is a legality wall rather than a bind-budget hint (§11).
 *
 * A member op's `json_each(<list>)` is a FROM-clause reader, and SQL has no way to name a select alias
 * there — so fused into the block that COMPUTES the list it re-inlines the whole expression. Where the
 * list came from a `fold()` that expression is `json_group_array(…)`, and SQLite refuses an aggregate
 * inside a table-valued function argument outright (`misuse of aggregate function
 * json_group_array()`): a THROW, from the position where legacy answers. The block model already
 * tracks the symmetric fact for windows (`windowed` — "nothing may reference it from WHERE, GROUP BY
 * or a table-valued function argument"); this is the same rule one node earlier, and fencing here
 * lands legacy's own CTE-per-list-op shape.
 */
const fenced = (rel: Rel, fresh: Minter): Rel =>
  (rel.kind === 'materialize' ? rel : make.materialize({ id: fresh('lm'), input: rel, channels: rel.channels, type: rel.type }));

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

/** A SELF-DESCRIBING list — members MAY be `{t,v}` nodes, and the readers detect the envelope per
 *  member (`memberPayload`). This is what a `fold()` over a per-row-typed stream produces. */
export const TYPED_LIST: ListOf = { kind: 'scalar', typed: true };

const isTypedList = (of: ListOf): boolean => of.kind === 'scalar' && !!of.typed;

/** Is this list's member encoding one this module can read? Both scalar encodings now — a bare list
 *  and a self-describing one — but not an ELEMENT or a nested list, whose members are rowids and
 *  sub-lists respectively and need their own expansion. */
export const isBareList = (of: ListOf): boolean => of.kind === 'scalar';

/**
 * A bare member's canonical Gremlin type, inferred from its SQLite storage class — legacy's
 * `inferVtypeSql`, re-expressed. It is the same inference the wire would apply to an untagged value,
 * so naming it here is not a second policy: it is what lets a MIXED list (some members wrapped, some
 * bare, which is exactly what `typed` means) hand every member a type without a second channel.
 */
const inferredVtype = (value: Expr): Expr => ({
  kind: 'case',
  whens: [
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'text'), lit('string', 'text')],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'real'), lit('double', 'text')],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'null'), lit(null, 'any')],
    [eqText({ kind: 'call', fn: 'typeof', args: [value] }, 'integer'), {
      kind: 'case',
      whens: [[{ kind: 'binary', op: 'and',
        left: { kind: 'binary', op: '>=', left: value, right: lit(-2147483648, 'int') },
        right: { kind: 'binary', op: '<=', left: value, right: lit(2147483647, 'int') } }, lit('int', 'text')]],
      else: lit('long', 'text'),
    }],
  ],
  else: lit('string', 'text'),
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
export function listMemberOp(step: IRStep, input: Rel, of: ListOf, fresh: Minter): { readonly rel: Rel; readonly of: ListOf } | null {
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
    const args = step.args ?? [];
    if (args.length !== 1) return null;
    const members = membersOf(list, fresh);
    const pred = memberPredicate(memberPayload(of, members), args[0]);
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
  step: IRStep, input: Rel, of: ListOf, fresh: Minter,
): { readonly rel: Rel; readonly type: import('../../sql/kernel/render.ts').ScalarType; readonly result?: 'number' | 'count' } | null {
  if (step.modulators?.length || step.optionArms || !isBareList(of)) return null;
  const args = step.args ?? [];
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
      pred: { kind: 'binary', op: 'is not', left: memberPayload(of, members), right: lit(null, 'any') },
    });
    const joined: Expr = {
      kind: 'scalar',
      plan: make.aggregate({
        id: fresh('mj'), input: present, channels: [], type: typeOf(meta('v', 'text', true)),
        groupBy: [],
        aggs: [['v', {
          kind: 'call',
          fn: 'COALESCE',
          args: [{ kind: 'agg', fn: 'group_concat', args: [memberPayload(of, present), lit(sep, 'text')], orderBy: [{ expr: col(present.id, MEMBER.ord), dir: 'asc' }] },
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
    const reduced = reducerAggregate(memberPayload(of, members), step.name);
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
export function unfoldList(rel: Rel, of: ListOf, fresh: Minter): { readonly rel: Rel; readonly ord: string; readonly typed: boolean } | null {
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
        ...rel.channels.map((channel) => meta(channel.col, 'int')), meta(MEMBER.ord, 'int')),
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
  input: Rel, opts: { readonly vtype?: string; readonly staticTag?: ValueType; readonly encounter?: string }, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf } {
  const { staticTag } = opts;
  // The type column and the position are named rather than passed as EXPRESSIONS, because the relation
  // an expression must address is the window's output and not the caller's input: every node here
  // addresses its own INPUT, and the lossy flag inserts one.
  const vtype = opts.vtype ? col(input.id, opts.vtype) : undefined;
  const flagged = vtype ? withLossyFlag(input, vtype, fresh) : input;
  const order: readonly SortTerm[] = opts.encounter ? [{ expr: col(flagged.id, opts.encounter), dir: 'asc' }] : [];
  const value = col(flagged.id, 'v');
  const member = vtype
    ? {
      kind: 'case',
      whens: [[col(flagged.id, LOSSY_COL), typedNode(value, col(flagged.id, opts.vtype!))]],
      else: value,
    } as Expr
    : value;
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
            { kind: 'call', fn: 'json', args: [lit('[]', 'text')] }],
        }],
      }]],
    }),
    of: vtype ? TYPED_LIST : { kind: 'scalar', ...(staticTag ? { as: staticTag } : {}) },
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
        left: { kind: 'binary', op: 'is not', left: vtype, right: lit(null, 'any') },
        // `NOT (x IN …)`, not an `InList` with a negation flag — the node has none, and with the
        // `IS NOT NULL` guard on the left the two forms agree (a NULL is already excluded).
        right: { kind: 'unary', op: 'not', arg: { kind: 'in-list', expr: vtype, values: LOSSLESS_VTYPES.map((cls) => lit(cls, 'text')) } },
      }, lit(1, 'int')]],
      else: lit(0, 'int'),
    }],
    spec: { partitionBy: [], orderBy: [] },
  }]],
});
