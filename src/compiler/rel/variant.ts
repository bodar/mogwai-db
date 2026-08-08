import { col, compilerInt, compilerNull, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import { STATIC, staticTypeOf, UNKNOWN, type Shape, type VariantShapeArm } from '../../sql/kernel/render.ts';
import { byEncounter, carriedCols, meta, typeOf, type Minter } from './build.ts';
import { correlatedElementColumns } from './element.ts';
import type { RelFraming } from './framing.ts';

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
 * `Shape{kind:'variant'}` and the `vk` discriminant are legacy's, and `execute.ts` frames them today:
 * `0` null, `1` scalar, `2` vertex, `3` edge, `4` list. So this adds no wire concept — it teaches the
 * ALGEBRA to produce rows the framer has always been able to read, which is what §6·3 means by a
 * shape being a value plus a framing arm.
 *
 * ## Rowids until the root — the same rule the element list follows
 *
 * An element arm carries its ROWID in `rid` and nothing else. The expansion into `id`/`label`/`props`
 * happens once, at the root (`variantPayload`), so a branch whose element rows are filtered or sliced
 * away never computes a property bag for them. Legacy reaches the same place with two `LEFT JOIN`s
 * gated on the tag; correlated reads say it without the gating, because a subquery over a rowid the
 * other arm did not set is NULL and a `vk` the framer does not read never asks.
 *
 * ## What this deliberately does NOT do
 *
 * A variant is TERMINAL here. `compileFromVariant` on the legacy side answers a handful of steps over
 * one (a `count`, a slice, an alias compare); each is expressible and none is written, so a step after
 * a variant DECLINES rather than being silently dropped — `continueAs`'s map arm, for the same reason.
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
  if (framing.kind === 'scalar') return framing.result === undefined ? { kind: 'scalar', type: framing.type } : null;
  if (framing.kind === 'elements') return { kind: 'elements', elem: framing.elem };
  if (framing.kind === 'list') return framing.set ? null : { kind: 'list', of: framing.of };
  return null;
}

/**
 * Re-project one arm onto the shared variant payload — its own column filled, the others NULL.
 *
 * This is `withMergedVtype`'s move one level up, and the parallel is worth seeing: a scalar-tag
 * disagreement widens the schema by one column and a SHAPE disagreement widens it by three, but both
 * are "make the arms comparable, then let the ordinary `Union` merge them". Neither invents a node.
 */
export function variantArm(rel: Rel, arm: VariantArm, hasList: boolean, fresh: Minter): Rel {
  const carried = rel.channels;
  const tag = tagOf(arm);
  const value: Expr = arm.kind === 'scalar' ? col(rel.id, 'v') : compilerNull();
  const rowid: Expr = arm.kind === 'elements' ? col(rel.id, 'id') : compilerNull('int');
  const listed: Expr = arm.kind === 'list' ? col(rel.id, 'list') : compilerNull('json');
  const cols: ColMeta[] = [meta(VK, 'int'), meta('v', 'any', true), meta(RID, 'int', true),
    ...(hasList ? [meta('list', 'json', true)] : [])];
  return make.project({
    id: fresh('va'), input: rel, channels: carried,
    type: typeOf(...cols, ...carriedCols(carried)),
    exprs: [[VK, compilerInt(tag)], ['v', value], [RID, rowid],
      ...(hasList ? [['list', listed] as const] : []),
      ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
  });
}

/** Does this set of arms need the `list` column at all? Asked once so every arm agrees — a `Union` is
 *  positional, so one arm projecting a column another does not is a width mismatch, not a null. */
export const variantHasList = (arms: readonly VariantArm[]): boolean => arms.some((arm) => arm.kind === 'list');

/**
 * THE VARIANT ROOT — the tagged rows as the wire tuple, plus the `Shape` that reads them.
 *
 * Every element arm's rowid expands HERE and only here (`correlatedElementColumns`), which is what
 * keeps a discarded row free. The tuple is the union of what the declared arms need: `vk` and `v`
 * always, the element triple where some arm is an element, `src`/`tgt` where one is an edge, and
 * `list` where one is a list.
 *
 * The SCALAR arm is declared even where no arm produced one, matching legacy — the framer reads
 * `staticTypeOf(scalar.type)` and a missing arm would make a `vk=1` row throw rather than infer. A
 * per-row scalar tag is the one thing the wire vocabulary is short of (`VariantShapeArm.scalar` takes
 * a whole `ScalarType`, but the framer reads only its static tag), so arms whose types disagree frame
 * `UNKNOWN` and infer per value — the same answer legacy gives, and the extension point §6·7 names.
 */
export function variantPayload(
  rel: Rel, arms: readonly VariantArm[], fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } | null {
  const ordered = byEncounter(rel, fresh);
  const elems = new Set(arms.flatMap((arm) => (arm.kind === 'elements' ? [arm.elem] : [])));
  const listArm = arms.find((arm): arm is Extract<VariantArm, { kind: 'list' }> => arm.kind === 'list');
  const scalars = arms.filter((arm): arm is Extract<VariantArm, { kind: 'scalar' }> => arm.kind === 'scalar');
  // ONE STATIC tag across every scalar arm, or `UNKNOWN` — and never the `perRow` a scalar arm may
  // arrive with. That is not a simplification, it is the payload telling the truth: this tuple has no
  // `vtype` column, and the framer reads `staticTypeOf(scalar.type)`, so declaring `perRow` would be a
  // claim about a column that is not there. It costs nothing today because `staticTypeOf` of a
  // `perRow` is undefined and the framer infers per value either way — the DECLARATION would simply
  // be describing a row shape the algebra did not build. Carrying the column instead is §6·7's
  // extension point (`VariantShapeArm.scalar` already takes a whole `ScalarType`), and it wants the
  // framer to read it, which is a wire change rather than this one.
  const tags = new Set(scalars.map((arm) => staticTypeOf(arm.type)));
  const uniform = tags.size === 1 ? [...tags][0] : undefined;
  const scalarType = uniform ? STATIC(uniform) : UNKNOWN;

  const payload: (readonly [ColMeta, Expr])[] = [
    [meta(VK, 'int'), col(ordered.id, VK)],
    [meta('v', 'any', true), col(ordered.id, 'v')],
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
  if (listArm) payload.push([meta('list', 'json', true), jsonList(ordered)]);

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
    shape: { kind: 'variant', arms: declaredArms, wholeResult: false },
  };
}

const eqTag = (rel: Rel, tag: number): Expr => ({ kind: 'binary', op: '=', left: col(rel.id, VK), right: compilerInt(tag) });

/** The list column as the TEXT the framer parses — the relational column is JSONB, and `json()` is
 *  what turns it into text, exactly as the list payload does for a whole-list traverser. */
const jsonList = (rel: Rel): Expr => ({ kind: 'call', fn: 'json', args: [col(rel.id, 'list')] });
