import type { Channels } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import { PER_ROW, PER_ROW_ENVELOPE, SCALAR_MEMBERS, STATIC, withMemberType, type ListOf, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { Elem } from '../plan/plan.ts';
import { aliasScalarTypeOf, withShape, type AliasEntry, type AliasMap } from '../plan/alias.ts';
import { carriedCols, collectedOf, meta, payloadCols, typeOf, type Minter } from './build.ts';
import type { RelFraming } from './framing.ts';
import { historyAppend, historySeed, objectEntry, shapeOf, type TraverserObject } from './history.ts';

/**
 * THE ALIAS CHANNEL — `as()` writes it, `select()` reads it, and the comparison vocabulary asks it
 * for an operand. The sixth vocabulary module on the RelIR spine
 * (`build ◂ {predicate, modulator, transform, reducer, list, alias} ◂ lower ◂ spine`), and the one
 * §6 named as 4.1's unfinished business: 149 corpus traversals block on it, the largest family
 * outside writes and side effects.
 *
 * ## A label's value is a HISTORY, not a column
 *
 * `as('a')` APPENDS the current object to the label's history, and `select(Pop.first/last/all/mixed)`
 * reads positions from it. One carried column per LABEL holds that history; the shared tagged-entry
 * encoding itself lives in `history.ts`, while this module owns the label names and reads.
 *
 * ## Why the NAME map rides beside the plan
 *
 * A `Channel` is `{col, role}` and nothing else — §2's vocabulary boundary means a RelIR node cannot
 * know a Gremlin label name any more than it can know what a sack is. So the label→column mapping is
 * compiler-side state, and it is the SAME `AliasEntry`/`AliasMap` the framing layer's
 * `TraverserLayout` declares. Sharing the type used to be load-bearing at the SEAM: `spine.ts` handed
 * the map straight over rather than translating one representation into another, and `alias` was the one
 * channel role whose framing form was a NAME map rather than a column. §6·3 retired that seam — the
 * payload projection is the algebra's now, so nothing crosses — and the map is read only HERE, by the
 * `as()`/`select()` vocabulary that builds it. The shared type stays because `select()` re-entry still
 * needs the same entry shape the legacy host reads; it is no longer a claim about a boundary.
 *
 * ## Decline, don't approximate
 *
 * `null` is the only decline, as everywhere on this route. Two shapes fail closed here rather than
 * being answered approximately: a MIXED-shape history (a label bound to a vertex once and a value
 * once) has no single re-entry, and a MAP-shaped or PROPERTY-shaped binding needs a framing arm this
 * route does not have. Both are shapes legacy answers, so declining hands the traversal to the spine
 * that owns the answer.
 */

/**
 * THE LABELS THIS RELATION STILL PHYSICALLY CARRIES — the invariant, enforced by DERIVING it rather
 * than by remembering to clear it.
 *
 * A BARRIER consumes every channel (§3.5), so `count()`/`fold()`/a reducer leaves the alias columns
 * behind while the label map, threaded through the fold as an ordinary variable, still names them.
 * That is the 33% defect category from the other direction: not a dropped column but a map claiming
 * one, and it reads downstream as a `select()` compiling a reference to a column that is not there —
 * a silent empty result at the framing layer, or broken SQL.
 *
 * So every reader asks the RELATION instead of trusting the variable, and there is no per-barrier
 * clear to forget. The dropped NAMES are not remembered here: `CHANNEL_BARRIER_POLICY` calls the alias
 * role `consumed` so a later `select` can tell "a barrier ate it" from "never bound", and both answers
 * are the same DECLINE on this route — the distinction only buys a better message, which is the spine
 * that owns messages' business.
 */
/** MODULE-PRIVATE again since §6·3: its one external reader was `lowerToRel`, pruning the map before
 *  handing it to `spine.ts`'s `TraverserLayout` bridge. With the payload projection inside the algebra
 *  there is no bridge and no map to hand over, so the two readers left are both here. */
export const liveAliases = (aliases: AliasMap, rel: Rel): AliasMap =>
  new Map([...aliases].filter(([, entry]) => rel.channels.some((channel) => channel.col === entry.col)));

/** Keep a traverser only where the label is actually bound on its path. An unbound label DROPS the
 *  row (an empty result), never an error — TinkerPop's `select()` rule, and the reason this is a
 *  predicate rather than a throw. */
export const aliasPresent = (column: Expr): Expr => ({
  kind: 'binary', op: 'and',
  left: { kind: 'binary', op: 'is not', left: column, right: compilerNull() },
  right: { kind: 'binary', op: '>', left: { kind: 'call', fn: 'json_array_length', args: [column] }, right: compilerInt(0) },
});

/** Which end of the history a single-value Pop reads. `mixed` over a once-bound label is that lone
 *  entry, which is `last`; every other `mixed` is a list and never reaches here. */
export type Pop = 'first' | 'last' | 'all' | 'mixed';
const endPath = (end: 'first' | 'last', field: string): string => `${end === 'first' ? '$[0]' : '$[#-1]'}.${field}`;

/** A FIELD of one history entry, by Pop end — `json_extract(a0, '$[#-1].v')`. `json_extract` rather
 *  than SQLite's `->>` operator for the reason the list vocabulary gives: the same SQL value, and the
 *  node set stays closed (§3.3). */
const fieldAt = (column: Expr, end: 'first' | 'last', field: string): Expr =>
  ({ kind: 'call', fn: 'json_extract', args: [column, compilerText(endPath(end, field))] });

/** The rowid an ELEMENT label holds, at one end of its history. */
export const aliasIdAt = (column: Expr, end: 'first' | 'last'): Expr =>
  ({ kind: 'cast', arg: fieldAt(column, end, 'v'), to: 'int' });

/** The stored scalar a VALUE label holds, and its recorded type tag beside it. */
export const aliasValueAt = (column: Expr, end: 'first' | 'last'): Expr => fieldAt(column, end, 'v');
export const aliasTypeAt = (column: Expr, end: 'first' | 'last'): Expr => fieldAt(column, end, 't');

/** The JSON a LIST label holds, back as a list payload. `json()` around it is what makes the value a
 *  collection again rather than the TEXT of one — the symptom that made `fold().as('b').select('b')
 *  .unfold()` emit a single text blob on the legacy route before it was fixed there. */
export const aliasListAt = (column: Expr, end: 'first' | 'last'): Expr =>
  ({ kind: 'call', fn: 'json', args: [fieldAt(column, end, 'v')] });

/**
 * `as(label…)` — bind each label to the current traverser, whatever shape it is.
 *
 * SHAPE-PRESERVING on purpose, and that is what makes one implementation serve the element, scalar
 * and list hosts: the payload columns pass through untouched and only the alias channels change.
 * Which is also why it is the same rule at every position in a chain — `as()` after a movement, after
 * a `values()`, after a `fold()` is one lowering, not three (§6·6: land the vocabulary).
 *
 * A NEW label mints a channel through `withChannel`, so the column lands in `ROLE_ORDER` and the
 * declared type is rebuilt from the channel list rather than appended to — an alias sorts BEFORE
 * every other role, so appending would desync the declared schema from the physical one at the next
 * node. A REBIND reuses the label's existing column and extends its array.
 *
 * Declines a non-string argument: `as()` takes labels and nothing else, so anything else is a
 * front-end shape this has not seen rather than a step to guess at.
 */
export function bindAliases(
  step: IRStep, rel: Rel, aliases: AliasMap, bound: TraverserObject, fresh: Minter,
): { readonly rel: Rel; readonly aliases: AliasMap } | null {
  const labels = (step.args ?? []).map((a) => a.value);
  if (!labels.length || labels.some((label) => typeof label !== 'string')) return null;
  if (step.modulators?.length || step.optionArms) return null;

  const entry = objectEntry(bound);
  const shape = shapeOf(bound);
  // `liveAliases`, not the map as handed over: a barrier upstream consumed the columns, so a rebind
  // after one mints `a0` afresh rather than appending to a column the relation no longer has.
  const next = new Map<string, AliasEntry>(liveAliases(aliases, rel));
  let channels: Channels = rel.channels;
  const set = new Map<string, Expr>();
  for (const label of labels as readonly string[]) {
    const existing = next.get(label);
    const column = existing?.col ?? `a${next.size}`;
    next.set(label, {
      col: column,
      shapes: withShape(existing?.shapes, shape),
      binds: (existing?.binds ?? 0) + 1,
      ...(bound.kind === 'value' ? { scalarType: aliasScalarTypeOf(bound.type) } : {}),
      ...(bound.kind === 'list' ? { listOf: bound.of } : {}),
    });
    if (!existing) channels = withChannel(channels, { col: column, role: 'alias' });
    set.set(column, existing ? historyAppend(col(rel.id, column), entry) : historySeed(entry));
  }

  const payload = payloadCols(rel);
  return {
    rel: make.project({
      id: fresh('as'), input: rel, channels, type: typeOf(...payload, ...carriedCols(channels)),
      exprs: [
        ...payload.map((column) => [column.name, col(rel.id, column.name)] as const),
        ...channels.map((channel) => [channel.col, set.get(channel.col) ?? col(rel.id, channel.col)] as const),
      ],
    }),
    aliases: next,
  };
}

/**
 * WHAT A LABEL RE-ENTERS AS — the read side's whole decision, taken from the entry alone.
 *
 * A total union rather than a set of optionals, for `ScalarType`'s reason
 * (`docs/2026-07-28-scalartype-refactoring-pattern.md`): the three arms need genuinely different
 * things from the relation, and an `elem` that is sometimes absent beside a `type` that is sometimes
 * present is two ways to spell one fact.
 */
export type AliasRead =
  | { readonly kind: 'element'; readonly elem: Elem }
  | { readonly kind: 'value'; readonly type: ScalarType }
  | { readonly kind: 'list'; readonly of: ListOf };

/** A single-shape history, read. A MIXED history declines: it has no single re-entry, and legacy
 *  frames it as a VARIANT stream, which is a shape this route does not produce. `map` and `property`
 *  decline for the same reason — the shape exists above RelIR and the framing arm is not there. */
const readOf = (entry: AliasEntry, vtype: string): AliasRead | null => {
  if (entry.shapes.size !== 1) return null;
  const [shape] = entry.shapes;
  switch (shape) {
    case 'vertex': case 'edge': return { kind: 'element', elem: shape };
    case 'value': return { kind: 'value', type: scalarTypeOfAlias(entry, vtype) };
    case 'list': return entry.listOf ? { kind: 'list', of: entry.listOf } : null;
    default: return null;
  }
};

/** An alias history's scalar type, restored onto the projection that reads it. A `perRow` type names
 *  the NEW column (the entry's `t` field lands there), never the source relation's vanished one —
 *  legacy's `scalarTypeFromAlias` says the same thing and this is the algebra's spelling of it. */
const scalarTypeOfAlias = (entry: AliasEntry, vtype: string): ScalarType =>
  entry.scalarType?.kind === 'static' ? STATIC(entry.scalarType.type)
    : entry.scalarType?.kind === 'perRow' ? PER_ROW(vtype)
      : { kind: 'unknown' };

/** A Pop that returns a history LIST has the same member descriptor as the binding it reads, except
 * that a per-row scalar tag now rides inside each `{t,v}` member rather than a relation column. */
const historyListOf = (entry: AliasEntry): ListOf | null => {
  if (entry.shapes.size !== 1) return null;
  const [shape] = entry.shapes;
  switch (shape) {
    case 'vertex': case 'edge': return { kind: 'elem', elem: shape };
    case 'value': {
      const type = entry.scalarType ?? { kind: 'unknown' } as ScalarType;
      return withMemberType(SCALAR_MEMBERS, type.kind === 'perRow' ? PER_ROW_ENVELOPE : type);
    }
    case 'list': return entry.listOf ? { kind: 'list', of: entry.listOf } : null;
    default: return null;
  }
};

/** The whole alias history as one ordinary list value. The history encoding is already ordered and
 * tagged, so this is not a second collection representation: it projects the existing entries into
 * the list vocabulary's member encodings. In particular a per-row scalar keeps its type envelope;
 * stripping `t` here would make a BigInt/Date selected with Pop.all frame as a plain number/string. */
const historyList = (history: Expr, of: ListOf, fresh: Minter): Expr => {
  const members = make.explode({
    id: fresh('am'), expr: history, channels: [], as: { value: 'av', ord: 'ao', type: 'at' },
    type: typeOf(meta('av', 'any', true), meta('ao', 'int'), meta('at', 'text', true)),
  });
  const entry = col(members.id, 'av');
  const value = { kind: 'call', fn: 'json_extract', args: [entry, compilerText('$.v')] } as Expr;
  const node: Expr = of.kind === 'scalar' && of.type.kind === 'perRow'
    ? { kind: 'json-object', binary: true, entries: [
      ['t', { kind: 'call', fn: 'json_extract', args: [entry, compilerText('$.t')] }], ['v', value],
    ] }
    : of.kind === 'list' ? { kind: 'call', fn: 'json', args: [value] } : value;
  return collectedOf(members, node, [{ expr: col(members.id, 'ao'), dir: 'asc' }], 'list', fresh);
};

/** The presence predicate one label OWES, or `undefined` where it can never be false. A STATICALLY
 *  bound label is present on every row that reached here, so the guard is emitted only for one first
 *  bound inside a branch arm or a repeat body — same SQL as legacy in both cases, and one fewer clause
 *  for the fused block to re-inline. */
export const aliasGuard = (rel: Rel, entry: AliasEntry): Expr | undefined =>
  (entry.binds === undefined ? aliasPresent(col(rel.id, entry.col)) : undefined);

/** The projection every `select()` shares: the payload under its canonical column names, then the
 *  carried channels through unchanged.
 *
 *  It does NOT filter, and the DROP is the caller's for a structural reason rather than a stylistic
 *  one: the payload expressions are written in `rel`'s scope, so a `Filter` between them and `rel`
 *  makes it a GRANDCHILD and every column reference falls out of scope (§3.3 — a `Col` names a
 *  relation in SCOPE, and scope is a node's direct children). The guard therefore sits ABOVE the
 *  projection and reads its COLUMNS, which is also one fewer inlining of a correlated `by()`. */
export function readProjection(
  rel: Rel, payload: readonly (readonly [ColMeta, Expr])[], fresh: Minter,
): Rel {
  const source = rel;
  return make.project({
    id: fresh('sel'), input: source, channels: source.channels,
    type: typeOf(...payload.map(([column_]) => column_), ...carriedCols(source.channels)),
    exprs: [
      ...payload.map(([column_, expr]) => [column_.name, expr] as const),
      ...source.channels.map((channel) => [channel.col, col(source.id, channel.col)] as const),
    ],
  });
}

/**
 * ONE LABEL'S PAYLOAD, read off the row — the shape decision and the expressions, without the
 * relation the reader wants them in.
 *
 * Split out of `selectOne` because `select(label)` is not the only reader any more: a `by()` slot may
 * BE an alias read (`project('v','n').by(__.select('v')).by()`, `order().by(__.select('b'))`), and
 * there the payload lands in a record field's columns rather than in a re-rooted stream of its own.
 * One function so the two cannot disagree about which end of the history a `Pop` names or about which
 * columns a shape needs — the by() host reads the identical answer `select()` does, which is what
 * `Scoping.getScopeValue` says it is reading.
 *
 * `null` for a mixed-shape history, a map/property binding, or a label this relation no longer
 * physically carries. A list-valued Pop reuses the ordinary list vocabulary rather than preserving a
 * special alias result shape.
 */
export function aliasProjection(
  rel: Rel, aliases: AliasMap, label: string, pop: Pop, fresh?: Minter,
): { readonly entry: AliasEntry; readonly read: AliasRead; readonly payload: readonly (readonly [ColMeta, Expr])[] } | null {
  // Asked of the RELATION, so a label a barrier consumed reads as unbound — which is the same
  // DECLINE as a label never bound, and correct for both (TinkerPop drops every traverser either way).
  const entry = liveAliases(aliases, rel).get(label);
  if (!entry) return null;
  // Pop.all is always the whole history. Pop.mixed unwraps exactly one binding and otherwise returns
  // that same list; a linear history with a known count therefore needs no runtime shape guess.
  const list = pop === 'all' || (pop === 'mixed' && entry.binds !== undefined && entry.binds !== 1);
  if (list) {
    const of = historyListOf(entry);
    // The scope-value reader has no relation minter because it only projects expressions into an
    // existing caller node. A Pop list is a correlated relation, so it belongs to select() until
    // that reader grows the same ownership; declining here preserves its prior contract.
    if (!of || !fresh) return null;
    return {
      entry, read: { kind: 'list', of },
      payload: [[meta('list', 'json', true), historyList(col(rel.id, entry.col), of, fresh)]],
    };
  }
  // A dynamically bound history can hold either one entry (the scalar result) or several (the
  // list result). Treating it as either arm would silently change the wire shape, so leave it for
  // the scalar/list Variant lowering rather than guessing from the current SQL row.
  if (pop === 'mixed' && entry.binds === undefined) return null;
  const end: 'first' | 'last' = pop === 'first' ? 'first' : 'last';
  const vtype = 'vtype';
  const read = readOf(entry, vtype);
  if (!read) return null;
  const column = col(rel.id, entry.col);
  if (read.kind === 'element') return { entry, read, payload: [[meta('id', 'int', true), aliasIdAt(column, end)]] };
  if (read.kind === 'list') return { entry, read, payload: [[meta('list', 'json', true), aliasListAt(column, end)]] };
  // A per-row type comes back as a COLUMN, because that is the only form the scalar tail's
  // `carries('vtype')` reads — the same channel name `values()` produces, so a following
  // `is(P.gt(…))` gets the vtype-aware compare key with no further plumbing.
  return {
    entry, read,
    payload: [
      [meta('v', 'any', true), aliasValueAt(column, end)],
      ...(read.type.kind === 'perRow' ? [[meta(vtype, 'text', true), aliasTypeAt(column, end)] as const] : []),
    ],
  };
}

/** An alias READ, as a framing. The label decides the shape; `continueAs` decides the loop. Here
 *  rather than in the fold because both readers — `select()` re-entry and a `by()` slot — need the
 *  identical mapping, and the alias vocabulary is what owns it. */
export const readFraming = (read: AliasRead): RelFraming =>
  read.kind === 'element' ? { kind: 'elements', elem: read.elem }
    : read.kind === 'list' ? { kind: 'list', of: read.of }
      // The label's own recorded type, restored by `aliasProjection` (a per-row type lands in `vtype`).
      : { kind: 'scalar', type: read.type };

/**
 * THE KEYS A `select()` NAMES, and which end of each label's history it reads.
 *
 * The parse alone, exported because both readers need the identical answer: `selectKeys`
 * (`record.ts`) builds the stream, and nothing else may re-derive which arguments are labels.
 * `null` declines an argument that is neither a label nor a `Pop` — a `Column` token or a nested
 * traversal names a different family (map re-entry, a dynamic key), and reading one as "no labels"
 * would answer a different question.
 */
export function selectSpec(step: IRStep): { readonly labels: readonly string[]; readonly pop: Pop } | null {
  if (step.optionArms) return null;
  const args = (step.args ?? []).map((a) => a.value);
  const pops = args.filter((arg): arg is { readonly pop: string } =>
    typeof arg === 'object' && arg !== null && typeof (arg as { pop?: unknown }).pop === 'string');
  const labels = args.filter((arg): arg is string => typeof arg === 'string');
  if (!labels.length || pops.length + labels.length !== args.length) return null;
  return { labels, pop: (pops[0]?.pop ?? 'last') as Pop };
}
