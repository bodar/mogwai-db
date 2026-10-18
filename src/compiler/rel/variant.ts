import { col, compilerInt, compilerNull, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import { isPerRow, meetScalarTypes, MERGED_VTYPE, perRowColumnOf, PER_ROW, UNKNOWN, withMemberType, type ListOf, type ScalarType, type Shape, type VariantShapeArm } from '../../sql/kernel/render.ts';
import { byEncounter, carriedCols, mergedVtypeOf, meta, typeOf, type Minter } from './build.ts';
import type { GraphSource } from './source.ts';
import { correlatedElementColumns } from './element.ts';
import type { RelFraming } from './framing.ts';
import { listPayloadExpr } from './list.ts';

/**
 * THE VARIANT — a branch whose arms have DIFFERENT SHAPES, as a per-row tagged union.
 *
 * The dominant remaining blocker in the branch family, and almost all of it is one syntactic shape:
 * `choose(pred, __.values('name'))`. A two-argument `choose` has an IMPLICIT identity else arm
 * (`ChooseStep`'s private constructor installs one; RelIR spells it as the empty body), so the moment
 * the `then` arm changes shape the branch is mixed — an element arm and a scalar arm — and
 * `sameFraming` refuses it. Nothing about it is exotic; the two arms simply need somewhere to say
 * which of them a row came from.
 *
 * ## The wire vocabulary already exists, and reusing it is the point
 *
 * `Shape{kind:'variant'}` and the `vk` discriminant already exist, and `execute.ts` frames them today:
 * `0` null, `1` scalar, `2` vertex, `3` edge, `4` list. So this adds no wire concept — it teaches the
 * ALGEBRA to produce rows the framer has always been able to read, which is what §6·3 means by a
 * shape being a value plus a framing arm.
 *
 * ## Rowids until the root — the same rule the element list follows
 *
 * An element arm carries its ROWID in `rid` and nothing else. The expansion into `id`/`label`/`props`
 * happens once, at the root (`variantPayload`), so a branch whose element rows are filtered or sliced
 * away never computes a property bag for them. Correlated reads reach it without any tag-gating,
 * because a subquery over a rowid the other arm did not set is NULL and a `vk` the framer does not
 * read never asks.
 *
 * ## What this deliberately does NOT do
 *
 * A variant is TERMINAL here. A handful of steps over one (a `count`, a slice, an alias compare) are
 * expressible and none is written, so a step after a variant DECLINES rather than being silently
 * dropped — `continueAs`'s map arm, for the same reason.
 */

/** One arm's shape, and the `vk` tag that names it on the wire. A tag is a property of the arm's
 *  SHAPE, never of its position, which is what lets two arms of the same shape share one. */
export type VariantArm =
  | { readonly kind: 'scalar'; readonly type: import('../../sql/kernel/render.ts').ScalarType }
  | { readonly kind: 'elements'; readonly elem: 'vertex' | 'edge' }
  | { readonly kind: 'list'; readonly of: import('../../sql/kernel/render.ts').ListOf };

/** The relational payload a variant row carries: the tag, the scalar value, the element rowid, and the
 *  list blob — each populated by exactly one arm and NULL in the rest. `list` is present only where
 *  some arm is a list, so the common element/scalar variant costs three columns. */
const VK = 'vk';
const RID = 'rid';

const tagOf = (arm: VariantArm): number =>
  (arm.kind === 'scalar' ? 1 : arm.kind === 'list' ? 4 : arm.elem === 'edge' ? 3 : 2);

/**
 * The arm a framing describes, or `null` where the shape has no `vk` at all.
 *
 * `path`, `map`, `record`, `property` and `discard` decline — not because a tagged union could not
 * hold them in principle, but because the framer has no `vk` for them, and inventing one here would
 * be a wire concept this layer does not own (§6·3: RelIR builds the VALUE, `execute.ts` frames it).
 */
export function variantArmOf(framing: RelFraming): VariantArm | null {
  // An ENVELOPE-carried per-row type belongs to a value inside a JSON blob; a scalar ROW has no envelope
  // to read it from, so the arm declines rather than projecting a tag it cannot reach (`mergedVtypeOf`
  // would NULL it and the framer would infer — a different class, not the reference's).
  if (framing.kind === 'scalar') {
    return framing.result === undefined && !(isPerRow(framing.type) && !perRowColumnOf(framing.type))
      ? { kind: 'scalar', type: framing.type } : null;
  }
  if (framing.kind === 'elements') return { kind: 'elements', elem: framing.elem };
  if (framing.kind === 'list') return framing.set ? null : { kind: 'list', of: framing.of };
  return null;
}

/**
 * THE DECLARED VOCABULARY of a variant — ONE arm per wire tag, each carrying a description that is true
 * of EVERY row the tag will frame — or `null` to decline.
 *
 * The wire has one `vk` per kind (`1` scalar, `2` vertex, `3` edge, `4` list), so several arms of one
 * kind share a single declared arm, and that arm's description must hold for all of them. Collapsing them
 * by kind and keeping the FIRST arm's description is how a variant answered a different question:
 * `choose(p, out().fold(), id().fold())` framed the id list's members as vertices,
 * `union(values('name').fold(), out().fold())` framed the vertices as bare ids, and
 * `union(out(), values('age'), count())` framed the `count()` Long as an Int.
 *
 * - **scalar arms MEET** (`meetScalarTypes`, the meet the plain scalar merge and a named collection's
 *   sites already use): one static tag where they agree, else a per-row tag in `MERGED_VTYPE` that each
 *   arm fills with its own (`variantArm`) and the framer reads per row. A uniform per-row type is
 *   re-homed on that column too, because the variant payload does not carry an arm's own type column.
 * - **list arms must share ONE member descriptor** (`listMembersMeet`): identical, or bare scalar members
 *   that inference frames exactly. Lists of different members otherwise have no shared `of`, and a per-row
 *   member descriptor is a wire vocabulary the variant does not have — so they DECLINE. That is the
 *   reference's answer withheld, never a different one.
 * - element arms differ only by `elem`, which is already the tag (`2`/`3`).
 */
export function variantVocabulary(arms: readonly VariantArm[]): readonly VariantArm[] | null {
  const lists = arms.filter((arm): arm is Extract<VariantArm, { kind: 'list' }> => arm.kind === 'list');
  const members = lists.length ? listMembersMeet(lists.map((arm) => arm.of)) : null;
  if (lists.length && !members) return null;
  const scalars = arms.flatMap((arm) => (arm.kind === 'scalar' ? [arm.type] : []));
  const declared = new Map<string, VariantArm>();
  for (const arm of arms) {
    const key = arm.kind === 'elements' ? `e:${arm.elem}` : arm.kind;
    if (declared.has(key)) continue;
    declared.set(key, arm.kind === 'scalar' ? { kind: 'scalar', type: variantScalarType(scalars) }
      : arm.kind === 'list' ? { kind: 'list', of: members! } : arm);
  }
  return [...declared.values()];
}

/** The member types whose STATIC framing and storage-class inference frame identically — a JSON
 *  integer infers an Int (`anySerializer` picks Int in the 32-bit range a stored Int is in) and a JSON
 *  string a String. Every other tag (a Long, a Double whose `1.0` reads back as `1`, a Boolean stored as
 *  `0`/`1`, a date, a uuid) is information inference loses. */
const INFERRED_EXACTLY: ReadonlySet<string> = new Set(['int', 'string']);

/**
 * ONE member descriptor true of every list arm's members, or `null` — the list half of the variant's
 * declared vocabulary. Identical descriptors are trivially shared. Otherwise only BARE scalar members
 * meet, and only to `unknown` (infer per member), which is exact precisely where each arm's own tag is
 * one inference reproduces (`INFERRED_EXACTLY`) or is itself `unknown`. Envelope-typed members cannot
 * share a descriptor with bare ones (the framer would read a bare value as an envelope, or an envelope as
 * a value), and element, map, path and nested lists have no meet at all.
 */
const listMembersMeet = (ofs: readonly ListOf[]): ListOf | null => {
  const [first] = ofs as [ListOf, ...ListOf[]];
  if (ofs.every((of) => JSON.stringify(of) === JSON.stringify(first))) return first;
  const inferable = (of: ListOf): boolean => of.kind === 'scalar' && of.productiveNull === (first.kind === 'scalar' && first.productiveNull)
    && (of.type.kind === 'unknown' || (of.type.kind === 'static' && !of.type.text && INFERRED_EXACTLY.has(of.type.type)));
  return first.kind === 'scalar' && ofs.every(inferable) ? withMemberType(first, UNKNOWN) : null;
};

/** The scalar arm's declared type: the arms' meet, a per-row one always on `MERGED_VTYPE` (the column
 *  `variantArm` writes), never an arm's own per-row column the variant payload does not carry. */
const variantScalarType = (types: readonly ScalarType[]): ScalarType => {
  const met = meetScalarTypes(types);
  return met.kind === 'perRow' ? PER_ROW(MERGED_VTYPE) : met;
};

/** Does the declared scalar arm read a per-row tag? Then every arm projects `MERGED_VTYPE`. */
const scalarPerRow = (vocabulary: readonly VariantArm[]): boolean =>
  vocabulary.some((arm) => arm.kind === 'scalar' && arm.type.kind === 'perRow');

/**
 * Re-project one arm onto the shared variant payload — its own column filled, the others NULL.
 *
 * This is `withMergedVtype`'s move one level up, and the parallel is worth seeing: a scalar-tag
 * disagreement widens the schema by one column and a SHAPE disagreement widens it by three, but both
 * are "make the arms comparable, then let the ordinary `Union` merge them". Neither invents a node.
 * Where the scalar arms' types disagree (`variantVocabulary`) the two moves compose: the payload gains
 * `MERGED_VTYPE`, which a scalar arm fills with its own tag (`mergedVtypeOf`) and every other arm NULLs.
 */
export function variantArm(rel: Rel, arm: VariantArm, vocabulary: readonly VariantArm[], fresh: Minter): Rel {
  const carried = rel.channels;
  const tag = tagOf(arm);
  const hasList = vocabulary.some((declared) => declared.kind === 'list');
  const perRow = scalarPerRow(vocabulary);
  const value: Expr = arm.kind === 'scalar' ? col(rel.id, 'v') : compilerNull();
  const vtype: Expr = arm.kind === 'scalar' ? mergedVtypeOf(rel, arm.type) : compilerNull('text');
  const rowid: Expr = arm.kind === 'elements' ? col(rel.id, 'id') : compilerNull('int');
  const listed: Expr = arm.kind === 'list' ? col(rel.id, 'list') : compilerNull('json');
  const cols: ColMeta[] = [meta(VK, 'int'), meta('v', 'any', true),
    ...(perRow ? [meta(MERGED_VTYPE, 'text', true)] : []), meta(RID, 'int', true),
    ...(hasList ? [meta('list', 'json', true)] : [])];
  return make.project({
    id: fresh('va'), input: rel, channels: carried,
    type: typeOf(...cols, ...carriedCols(carried)),
    exprs: [[VK, compilerInt(tag)], ['v', value], ...(perRow ? [[MERGED_VTYPE, vtype] as const] : []), [RID, rowid],
      ...(hasList ? [['list', listed] as const] : []),
      ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
  });
}

/**
 * THE VARIANT ROOT — the tagged rows as the wire tuple, plus the `Shape` that reads them.
 *
 * Every element arm's rowid expands HERE and only here (`correlatedElementColumns`), which is what
 * keeps a discarded row free. The tuple is the union of what the declared arms need: `vk` and `v`
 * always, the element triple where some arm is an element, `src`/`tgt` where one is an edge, and
 * `list` where one is a list.
 *
 * The SCALAR arm is declared even where no arm produced one — a missing arm would make a `vk=1` row
 * throw rather than infer. Its type is a whole `ScalarType` (`VariantShapeArm.scalar`), and the framer
 * reads it as it reads a scalar row's: a per-row type from the `MERGED_VTYPE` column projected here.
 * `arms` is the DECLARED vocabulary (`variantVocabulary`), one arm per tag.
 */
export function variantPayload(
  rel: Rel, arms: readonly VariantArm[], source: GraphSource, fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } | null {
  const ordered = byEncounter(rel, fresh);
  const elems = new Set(arms.flatMap((arm) => (arm.kind === 'elements' ? [arm.elem] : [])));
  const listArm = arms.find((arm): arm is Extract<VariantArm, { kind: 'list' }> => arm.kind === 'list');
  // The scalar arm is the declared vocabulary's (`variantVocabulary`) — ONE type that is true of every
  // scalar row: the arms' common static tag, or a per-row tag in `MERGED_VTYPE` each arm filled with its
  // own. It used to be "one static tag, else UNKNOWN", and UNKNOWN infers from the storage class, which
  // cannot tell a `count()` Long from an Int or a stored `1.0` Double from an Int. Where no arm is a
  // scalar the arm is still declared (UNKNOWN): the framer needs a `vk=1` reader to exist.
  const scalarType: ScalarType = arms.find((arm): arm is Extract<VariantArm, { kind: 'scalar' }> => arm.kind === 'scalar')?.type
    ?? { kind: 'unknown' };
  const perRow = scalarType.kind === 'perRow';

  const payload: (readonly [ColMeta, Expr])[] = [
    [meta(VK, 'int'), col(ordered.id, VK)],
    [meta('v', 'any', true), col(ordered.id, 'v')],
    ...(perRow ? [[meta(MERGED_VTYPE, 'text', true), col(ordered.id, MERGED_VTYPE)] as const] : []),
  ];
  // The element triple is a CASE over the tag rather than a per-kind column, because the framer reads
  // ONE `id`/`label`/`props` whichever kind the row is — `rowVertex` and `rowEdge` take the same names.
  if (elems.size) {
    const rowid = col(ordered.id, RID);
    const byKind = [...elems].map((elem) => [elem, correlatedElementColumns(rowid, elem, fresh)] as const);
    const names = new Set(byKind.flatMap(([, cols]) => cols.map(([column]) => column.name)));
    for (const name of names) {
      const whens = byKind.flatMap(([elem, cols]) => {
        const found = cols.find(([column]) => column.name === name);
        return found ? [[eqTag(ordered, elem === 'edge' ? 3 : 2), found[1]] as const] : [];
      });
      const declared = byKind.flatMap(([, cols]) => cols.filter(([column]) => column.name === name))[0]![0];
      payload.push([meta(name, declared.type, true), { kind: 'case', whens }]);
    }
  }
  // The list arm's members are framed at the ROOT exactly as a whole-list traverser's are — a
  // list-of-SCALARS/map is already the wire tree, a list-of-ELEMENTS expands its rowids to
  // `{id,label,props}` objects (`listPayloadExpr`, the SAME expansion the non-variant list uses), so
  // `rowVertex` in the framer reads a member object rather than a bare rowid. A member shape it cannot
  // frame (a nested unframeable) declines the whole variant.
  if (listArm) {
    const listExpr = listPayloadExpr(col(ordered.id, 'list'), listArm.of, source, fresh);
    if (!listExpr) return null;
    payload.push([meta('list', 'json', true), listExpr]);
  }

  const declaredArms: VariantShapeArm[] = [
    { kind: 'scalar', type: scalarType },
    ...(elems.has('vertex') ? [{ kind: 'vertex' } as const] : []),
    ...(elems.has('edge') ? [{ kind: 'edge' } as const] : []),
    ...(listArm ? [{ kind: 'list', of: listArm.of } as const] : []),
  ];
  return {
    rel: make.project({
      id: fresh('vw'), input: ordered, channels: [], type: typeOf(...payload.map(([column]) => column)),
      exprs: payload.map(([column, expr]) => [column.name, expr] as const),
    }),
    shape: { kind: 'variant', arms: declaredArms },
  };
}

const eqTag = (rel: Rel, tag: number): Expr => ({ kind: 'binary', op: '=', left: col(rel.id, VK), right: compilerInt(tag) });
