// ---------- variant-value tail: shape-agnostic row-ops over a widened union ----------
//
// A VariantStream (stream.ts) is a heterogeneous per-row union — each row tagged `vk`
// as null / scalar / node / edge / list — produced when branch arms disagree on shape
// (e.g. union(out(), values('name'))). Steps that look INSIDE a row — movement, value
// filters, order, math — cannot apply uniformly across the arms and so fail closed;
// this is intrinsic to the union, not merely unbuilt. Only shape-agnostic steps
// compose: count/unfold, plus the row-preserving slices (limit/skip/range) and dedup.
// They name only the physical column list and never inspect the per-row tag, so every
// arm rides through unchanged.

import { q, list, empty, type Expression, type Relation } from '../../sql/kernel/q.ts';
import { rangeToOffsetLimit } from '../../compiler/plan/plan.ts';
import { type PStep } from '../../compiler/ir/strategies.ts';
import { carryOf, continueLowering, dispatchShapeTail, toVariantStream, type ListStream, type LoweringResult, type ScalarStream, type ShapeTailFn, type VariantArms, type VariantStream } from '../context/stream.ts';
import { carryFrag, carryFragMint, carriedCols, carriedWith, partitionOver, type Carry } from '../context/context.ts';
import { lowerGlobalCount } from './barrier.ts';

// ---------- variant-arm merge builders (parent-agnostic; element- and scalar-parent share) ----------
//
// A branch (union/choose/coalesce) whose arms disagree on shape merges them into a VariantStream.
// Each arm compiles to its natural shape (element/scalar/list) tagged `vk`, and these builders
// stitch the tagged rows into one relation. They touch only a bare Carry (carried columns), so
// an element parent (branch.ts) and a scalar parent (child.ts) reuse them verbatim — only the
// per-arm compiler differs (a scalar re-sources rather than walks).

/** The item-shape a set of list arms unify to (or throws if incompatible). */
export const unifyLists = (arms: readonly ListStream[]): ListStream['of'] => {
  const ofs = arms.map((arm) => arm.of);
  if (ofs.every((of) => of.kind === 'scalar')) {
    const tags = ofs.map((of) => of.kind === 'scalar' ? of.as : undefined);
    return { kind: 'scalar', as: tags.every((tag) => tag === tags[0]) ? tags[0] : undefined };
  }
  if (ofs.every((of) => of.kind === 'elem')) {
    const elems = ofs.map((of) => of.kind === 'elem' ? of.elem : undefined);
    if (elems.every((elem) => elem === elems[0])) return { kind: 'elem', elem: elems[0]! };
  }
  throw new Error('list branch arms have incompatible item shapes');
};

/** One compiled branch arm tagged by its natural shape (vk 1 scalar / 2 node / 3 edge /
 *  4 list). Parent-agnostic: an element-parent (branch.ts) and a scalar-parent (child.ts)
 *  both build these, so the merge builders below take a bare Carry, not an ElementStream. */
export interface VariantArm {
  readonly rel: Relation;
  readonly vk: 1 | 2 | 3 | 4;
  readonly as?: ScalarStream['as'];
  readonly listOf?: ListStream['of'];
}

/** The union of arm shapes → the widened stream's arm flags. */
export function variantArmsMeta(arms: readonly VariantArm[]): VariantArms {
  const scalarArms = arms.filter((a) => a.vk === 1);
  const listArms = arms.filter((a) => a.vk === 4);
  const scalarAs = scalarArms.length && scalarArms.every((a) => a.as === scalarArms[0].as) ? scalarArms[0].as : undefined;
  const listOf = listArms.length ? unifyLists(listArms.map((a) => ({ of: a.listOf! } as ListStream))) : undefined;
  return { scalarAs, node: arms.some((a) => a.vk === 2) || undefined, edge: arms.some((a) => a.vk === 3) || undefined, listOf };
}

/** One arm's variant-row SELECT: `vk, v, rid[, list]` + the outer carried columns.
 *  `gate` (coalesce's not-in-prior / any per-arm filter) receives the aliased arm rel.
 *  Takes a bare Carry so element- and scalar-parent merges share it. */
export function variantArmSelect(arm: VariantArm, carry: Carry, hasList: boolean, gate?: (a: Relation) => Expression | undefined): Expression {
  const a = arm.rel.as('a');
  const cols: Expression[] = [
    q`${arm.vk} AS vk`,
    q`${arm.vk === 1 ? a.c.v : q`NULL`} AS v`,
    q`${arm.vk === 2 || arm.vk === 3 ? a.c.id : q`NULL`} AS rid`,
  ];
  if (hasList) cols.push(q`${arm.vk === 4 ? a.c.list : q`NULL`} AS list`);
  const g = gate?.(a);
  return q`SELECT ${list(cols, ', ')}${carryFrag(carry.carried, a)} FROM ${a}${g ? q` WHERE ${g}` : empty}`;
}

export const variantCols = (carry: Carry, hasList: boolean): string[] =>
  ['vk', 'v', 'rid', ...(hasList ? ['list'] : []), ...carriedCols(carry.carried)];

const carryWith = (base: Carry, carried: Carry['carried']): Carry =>
  ({ q: base.q, params: base.params, sideEffects: base.sideEffects, carried });

/** Merge a set of variant arms (mixed-shape branch) into one VariantStream. Parent-agnostic
 *  (element- and scalar-parent share it). When emission order is live, SYNTHESIZE the canonical
 *  encounter: tag arm k `arm_idx=k`, keep its own encounter as `arm_encounter`, then re-mint
 *  `encounter = ROW_NUMBER() OVER (<partition> ORDER BY arm_idx, arm_encounter)` in the carried
 *  slot — arm a before arm b, matching TinkerPop union/coalesce/choose order. Without a live
 *  encounter it is a plain UNION ALL. `gateFor` supplies a per-arm WHERE (coalesce's not-in-prior). */
export function mergeVariantArms(base: Carry, arms: readonly VariantArm[], meta: VariantArms, gateFor?: (a: Relation, k: number) => Expression | undefined): VariantStream {
  const hasList = !!meta.listOf;
  const enc = base.carried.encounter;
  if (!enc) {
    const rel = base.q.cte(
      list(arms.map((arm, k) => variantArmSelect(arm, base, hasList, gateFor && ((a: Relation) => gateFor(a, k)))), ' UNION ALL '),
      variantCols(base, hasList),
    );
    return toVariantStream(base, rel, meta);
  }
  const baseNoEnc = carriedWith(base.carried, { encounter: null });
  const payloadCols = ['vk', 'v', 'rid', ...(hasList ? ['list'] : [])];
  const parts = arms.map((arm, k) => {
    const a = arm.rel.as('a');
    const cols: Expression[] = [
      q`${arm.vk} AS vk`,
      q`${arm.vk === 1 ? a.c.v : q`NULL`} AS v`,
      q`${arm.vk === 2 || arm.vk === 3 ? a.c.id : q`NULL`} AS rid`,
    ];
    if (hasList) cols.push(q`${arm.vk === 4 ? a.c.list : q`NULL`} AS list`);
    cols.push(q`${k} AS arm_idx`, q`${a.c[enc]} AS arm_encounter`);
    const gate = gateFor?.(a, k);
    return q`SELECT ${list(cols, ', ')}${carryFrag(baseNoEnc, a)} FROM ${a}${gate ? q` WHERE ${gate}` : empty}`;
  });
  const inner = base.q.cte(list(parts, ' UNION ALL '), [...payloadCols, 'arm_idx', 'arm_encounter', ...carriedCols(baseNoEnc)]);
  const m = inner.as('m');
  const over = partitionOver(base.carried, m, q`${m.c.arm_idx}, ${m.c.arm_encounter}`);
  const outCarried = carriedWith(baseNoEnc, { encounter: 'encounter' });
  const proj = list(payloadCols.map((c) => q`${m.c[c]} AS ${c}`), ', ');
  const rel = base.q.cte(
    q`SELECT ${proj}${carryFragMint(outCarried, m, 'encounter', q`ROW_NUMBER() OVER (${over})`)} FROM ${m}`,
    [...payloadCols, ...carriedCols(outCarried)],
  );
  return toVariantStream(carryWith(base, outCarried), rel, meta);
}

const armsOf = (s: VariantStream) => ({ scalarAs: s.scalarAs, node: s.node, edge: s.edge, listOf: s.listOf });

/** Re-project every physical column of the variant relation, optionally slicing rows
 *  or collapsing duplicates. Shape-agnostic: it names only the declared columns and
 *  never touches the per-row tag, so all arms survive intact. */
function reselect(s: VariantStream, opts: { distinct?: boolean; suffix?: Expression }): VariantStream {
  const p = s.rel.as('p');
  const cols = s.rel.cols;
  const projected = list(cols.map((c) => q`${p.c[c]}`), ', ');
  const body = q`SELECT ${opts.distinct ? q`DISTINCT ` : empty}${projected} FROM ${p}${opts.suffix ?? empty}`;
  return toVariantStream(carryOf(s), s.q.cte(body, cols), armsOf(s), s.result);
}

const variantSlice = (suffix: (step: PStep) => Expression): ShapeTailFn<VariantStream> =>
  (s, step, _steps, at) => continueLowering(reselect(s, { suffix: suffix(step) }), at + 1);

const VARIANT_TAIL = new Map<string, ShapeTailFn<VariantStream>>([
  // count is a relational barrier over any shaped row stream → one Long scalar.
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  // unfold() only re-opens a cap()'d aggregate (result:'list') back into member rows;
  // over an already-row variant there is nothing to unfold → fall through to the throw.
  ['unfold', (s, _step, _steps, at) =>
    s.result === 'list' ? continueLowering({ ...s, result: 'rows' as const }, at + 1) : null],
  ['limit', variantSlice((step) => q` LIMIT ${Number(step.args[0])}`)],
  ['skip', variantSlice((step) => q` LIMIT -1 OFFSET ${Number(step.args[0])}`)],
  ['range', variantSlice((step) => {
    const { offset, limit } = rangeToOffsetLimit(step.args);
    return q` LIMIT ${limit} OFFSET ${offset}`;
  })],
  // dedup() collapses the multiset on the current object = the tagged (vk,v,rid) row.
  // Label/by()-scoped and carried path/label state defer rather than over-collapse,
  // mirroring element dedup (filter.ts).
  ['dedup', (s, step, _steps, at) => {
    if (step.args.length > 0) throw new Error('dedup(label) not yet supported');
    if ((step.bys ?? []).length) throw new Error('dedup().by() over a variant value not yet supported');
    // A carried bulk column rides through the DISTINCT re-projection (bulk≡1 today, so
    // DISTINCT is unaffected); real path/label state still defers.
    if (carriedCols(s.carried).some((c) => c !== s.carried.bulk)) throw new Error('dedup() over a variant with carried path/label state not yet supported (path-distinct semantics)');
    return continueLowering(reselect(s, { distinct: true }), at + 1);
  }],
]);

/** The variant arm of lowerSteps: shape-agnostic row-ops over a widened union; every
 *  step that would need per-arm shape knowledge fails closed here. */
export function compileFromVariant(s: VariantStream, steps: PStep[], at: number): LoweringResult {
  return dispatchShapeTail(VARIANT_TAIL, s, steps, at, () => {
    throw new Error(`${steps[at].name}() on a variant value not yet supported`);
  });
}
