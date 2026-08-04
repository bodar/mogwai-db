import type { Channels } from '../../channels.ts';
import { withChannel } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import type { ListOf, ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { Elem } from '../plan/plan.ts';
import { SHAPE_K, elemShape, type AliasShape } from '../steps/context/alias.ts';
import { aliasScalarTypeOf, withShape, type AliasEntry, type AliasMap } from '../steps/context/context.ts';
import { carriedCols, meta, payloadCols, typeOf, type Minter } from './build.ts';

/**
 * THE ALIAS CHANNEL — `as()` writes it, `select()` reads it, and the comparison vocabulary asks it
 * for an operand. The sixth vocabulary module on the RelIR spine
 * (`build ◂ {predicate, modulator, transform, reducer, list, alias} ◂ lower ◂ spine`), and the one
 * §6 named as 4.1's unfinished business: 149 corpus traversals block on it, the largest family
 * outside writes and side effects.
 *
 * ## A label's value is a PATH HISTORY, not a column
 *
 * `as('a')` does not remember a rowid; it APPENDS the current object to the label's history, which is
 * TinkerPop's `Path` exactly (`select(Pop.first/last/all/mixed)` reads positions off it). So one
 * carried column per LABEL holds a JSONB array of tagged entries, and a rebind extends the array
 * rather than overwriting it. The tag is what lets one label hold — and accumulate — objects of
 * different shapes: a vertex, a value, a folded list.
 *
 * **The `k` tags are IMPORTED, not restated.** `SHAPE_K` lives with the legacy encoding
 * (`steps/context/alias.ts`) and this module writes the same entries, because the tag numbers are
 * DATA and a second copy of them is a second chance for the two spines to drift silently (§10·8 —
 * share data and pure computation, re-express only the emission). What IS re-expressed here is the
 * emission: legacy builds `q` templates, this builds `Expr` nodes.
 *
 * ## Why the NAME map rides beside the plan
 *
 * A `Channel` is `{col, role}` and nothing else — §2's vocabulary boundary means a RelIR node cannot
 * know a Gremlin label name any more than it can know what a sack is. So the label→column mapping is
 * compiler-side state, and it is the SAME `AliasEntry`/`AliasMap` the framing layer's
 * `TraverserLayout` declares: sharing that type is what lets `spine.ts` hand the map straight over
 * instead of translating one representation into another (and it is why `alias` is the one
 * `LAYOUT_FIELD` role whose framing form is a NAME map rather than a column).
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
/** MODULE-PRIVATE again since §10·10: its one external reader was `lowerToRel`, pruning the map before
 *  handing it to `spine.ts`'s `TraverserLayout` bridge. With the payload projection inside the algebra
 *  there is no bridge and no map to hand over, so the two readers left are both here. */
const liveAliases = (aliases: AliasMap, rel: Rel): AliasMap =>
  new Map([...aliases].filter(([, entry]) => rel.channels.some((channel) => channel.col === entry.col)));

/** What `as()` is binding — one arm per stream shape, so the entry's tag and its payload cannot be
 *  chosen independently of each other. A `value` binding carries its type through the history's own
 *  `t` field, which is the only place a per-row `vtype` column can survive becoming JSON. */
export type AliasValue =
  | { readonly kind: 'element'; readonly elem: Elem; readonly id: Expr }
  | { readonly kind: 'value'; readonly value: Expr; readonly type: ScalarType; readonly vtype?: Expr }
  | { readonly kind: 'list'; readonly list: Expr; readonly of: ListOf };

const shapeOf = (bound: AliasValue): AliasShape =>
  bound.kind === 'element' ? elemShape(bound.elem) : bound.kind === 'list' ? 'list' : 'value';

/**
 * ONE tagged history entry — `jsonb_object('k', <k>, 'v', <value>[, 't', <type>])`.
 *
 * A list's payload goes through `json()` so SQLite stores it AS json rather than as a quoted string;
 * that is the double-encoding corruption the list vocabulary's `memberNode` guards the same way.
 */
const entryExpr = (bound: AliasValue): Expr => {
  const k = lit(SHAPE_K[shapeOf(bound)], 'int');
  if (bound.kind === 'element') return { kind: 'json-object', entries: [['k', k], ['v', bound.id]], binary: true };
  if (bound.kind === 'list')
    return { kind: 'json-object', entries: [['k', k], ['v', { kind: 'call', fn: 'json', args: [bound.list] }]], binary: true };
  // A STATIC tag is a compile-time string; a PER-ROW one is the stream's own `vtype` column, and this
  // is the boundary where that column stops being a relation column and becomes a self-describing
  // field. An `unknown` type has nothing honest to record, so the entry carries no tag at all and the
  // read side infers from the storage class exactly as the wire would.
  const tag = bound.type.kind === 'static' ? lit(bound.type.type, 'text') : bound.vtype;
  return {
    kind: 'json-object', binary: true,
    entries: [['k', k], ['v', bound.value], ...(tag ? [['t', tag] as const] : [])],
  };
};

/** A brand-new label's column value: a one-element history array (array-ALWAYS, even for one
 *  binding — that uniformity is what makes every Pop read one expression rather than two). */
const seedExpr = (entry: Expr): Expr => ({ kind: 'json-array', items: [entry], binary: true });

/** A rebind, appended. Total on a NULL column: a row that reached here through a path which never
 *  bound the label starts a fresh array rather than producing NULL, which is what keeps `as()` a
 *  pass-through for every row instead of a filter. */
const appendExpr = (prev: Expr, entry: Expr): Expr => ({
  kind: 'case',
  whens: [[{ kind: 'binary', op: 'is', left: prev, right: lit(null, 'any') }, seedExpr(entry)]],
  else: { kind: 'call', fn: 'jsonb_insert', args: [prev, lit('$[#]', 'text'), entry] },
});

/** Keep a traverser only where the label is actually bound on its path. An unbound label DROPS the
 *  row (an empty result), never an error — TinkerPop's `select()` rule, and the reason this is a
 *  predicate rather than a throw. */
export const aliasPresent = (column: Expr): Expr => ({
  kind: 'binary', op: 'and',
  left: { kind: 'binary', op: 'is not', left: column, right: lit(null, 'any') },
  right: { kind: 'binary', op: '>', left: { kind: 'call', fn: 'json_array_length', args: [column] }, right: lit(0, 'int') },
});

/** Which end of the history a single-value Pop reads. `mixed` over a once-bound label is that lone
 *  entry, which is `last`; every other `mixed` is a list and never reaches here. */
export type Pop = 'first' | 'last' | 'all' | 'mixed';
const endPath = (end: 'first' | 'last', field: string): string => `${end === 'first' ? '$[0]' : '$[#-1]'}.${field}`;

/** A FIELD of one history entry, by Pop end — `json_extract(a0, '$[#-1].v')`. `json_extract` rather
 *  than SQLite's `->>` operator for the reason the list vocabulary gives: the same SQL value, and the
 *  node set stays closed (§3.3). */
const fieldAt = (column: Expr, end: 'first' | 'last', field: string): Expr =>
  ({ kind: 'call', fn: 'json_extract', args: [column, lit(endPath(end, field), 'text')] });

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
 * a `values()`, after a `fold()` is one lowering, not three (§10·8: land the vocabulary).
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
  step: IRStep, rel: Rel, aliases: AliasMap, bound: AliasValue, fresh: Minter,
): { readonly rel: Rel; readonly aliases: AliasMap } | null {
  const labels = step.args ?? [];
  if (!labels.length || labels.some((label) => typeof label !== 'string')) return null;
  if (step.modulators?.length || step.optionArms) return null;

  const entry = entryExpr(bound);
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
    set.set(column, existing ? appendExpr(col(rel.id, column), entry) : seedExpr(entry));
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
  entry.scalarType?.kind === 'static' ? { kind: 'static', type: entry.scalarType.type }
    : entry.scalarType?.kind === 'perRow' ? { kind: 'perRow', column: vtype }
      : { kind: 'unknown' };

/** The projection every `select(label)` shares: the label's payload, then the carried channels
 *  through unchanged, filtered to the rows where the label is bound. */
function readProjection(
  rel: Rel, entry: AliasEntry, payload: readonly (readonly [ColMeta, Expr])[], fresh: Minter,
): Rel {
  const column = col(rel.id, entry.col);
  // A STATICALLY-bound label is present on every row that reached here, so the guard is emitted only
  // where it can actually be false — a label first bound inside a branch arm or a repeat body. Same
  // SQL as legacy in both cases, and one fewer clause for the fused block to re-inline.
  const source = entry.binds === undefined
    ? make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: aliasPresent(column) })
    : rel;
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
 * `select(label)` / `select(Pop, label)` with ONE label — the label's history, re-entered as a
 * stream of its own shape.
 *
 * Host-agnostic like `bindAliases`, and for the same reason: nothing here reads the CURRENT
 * traverser, only the alias column and the carried channels. That is legacy's finding too
 * (`selectOneFromAlias` was written against an element stream and nothing in it needed one) and it is
 * what lets `values('name').select('a')` reach the identical answer as `out().select('a')`.
 *
 * Three declines, each a shape rather than a step: a `Pop.all`/`Pop.mixed` LIST result (the history
 * as a whole is a collection, which needs the member frame over an alias column — a further arm of
 * this same module, not a different one), a modulated `select(label).by(…)` (the by() vocabulary
 * reads the SELECTED element's properties, which is the next arm), and an unbound label whose
 * EMPTY-result answer legacy spells as a degenerate relation this algebra deliberately cannot
 * express (`Values([])`, §3.3).
 */
export function selectOne(
  step: IRStep, rel: Rel, aliases: AliasMap, fresh: Minter,
): { readonly rel: Rel; readonly read: AliasRead } | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];
  const pops = args.filter((arg): arg is { readonly pop: string } =>
    typeof arg === 'object' && arg !== null && typeof (arg as { pop?: unknown }).pop === 'string');
  const labels = args.filter((arg): arg is string => typeof arg === 'string');
  if (labels.length !== 1 || pops.length + labels.length !== args.length) return null;
  const pop = (pops[0]?.pop ?? 'last') as Pop;

  // Asked of the RELATION, so a label a barrier consumed reads as unbound — which is the same
  // DECLINE as a label never bound, and correct for both (TinkerPop drops every traverser either way).
  const entry = liveAliases(aliases, rel).get(labels[0]!);
  // A label bound NOWHERE drops every traverser. The honest lowering of that is the empty relation,
  // which §3.3 records `Values` as refusing to express — so this declines and legacy answers, rather
  // than filtering on a column that does not exist.
  if (!entry) return null;
  // `mixed` over a once-bound label IS that lone entry (TinkerPop's "singleton unwrapped, else
  // List"), decided by the compile-time binding count; every other `all`/`mixed` is a LIST value and
  // is the arm above's business.
  if (pop === 'all' || (pop === 'mixed' && entry.binds !== 1)) return null;
  const end: 'first' | 'last' = pop === 'first' ? 'first' : 'last';

  const vtype = 'vtype';
  const read = readOf(entry, vtype);
  if (!read) return null;
  const column = col(rel.id, entry.col);

  if (read.kind === 'element')
    return { rel: readProjection(rel, entry, [[meta('id', 'int'), aliasIdAt(column, end)]], fresh), read };
  if (read.kind === 'list')
    return { rel: readProjection(rel, entry, [[meta('list', 'json'), aliasListAt(column, end)]], fresh), read };
  // A per-row type comes back as a COLUMN, because that is the only form the scalar tail's
  // `carries('vtype')` reads — the same channel name `values()` produces, so a following
  // `is(P.gt(…))` gets the vtype-aware compare key with no further plumbing.
  const perRow = read.type.kind === 'perRow';
  return {
    rel: readProjection(rel, entry, [
      [meta('v', 'any', true), aliasValueAt(column, end)],
      ...(perRow ? [[meta(vtype, 'text', true), aliasTypeAt(column, end)] as const] : []),
    ], fresh),
    read,
  };
}
