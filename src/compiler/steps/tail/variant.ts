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

import { q, list, empty, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { type ValueType } from '../../../sql/kernel/render.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { continueLowering, variantPayloadCols, dispatchShapeTail, toListStream, toVariantStream, type ListStream, type LoweringResult, type ShapeTailFn, type VariantArms, type VariantStream } from '../context/stream.ts';
import { armOrderKey, branchFork, layoutProjection, layoutArmProjection, layoutGrewAliases, mergeArmRelation, patchLayout, mergeLayouts, type LoweringState, type TraverserLayout } from '../context/context.ts';
import { globalRowOps, lowerGlobalCount } from './barrier.ts';

// ---------- variant-arm merge builders (parent-agnostic; element- and scalar-parent share) ----------
//
// A branch (union/choose/coalesce) whose arms disagree on shape merges them into a VariantStream.
// Each arm compiles to its natural shape (element/scalar/list) tagged `vk`, and these builders
// stitch the tagged rows into one relation. They touch only a bare LoweringState (carried columns), so
// an element parent (branch.ts) and a scalar parent (child.ts) reuse them verbatim — only the
// per-arm compiler differs (a scalar re-sources rather than walks).

const stateWithLayout = (base: LoweringState, layout: LoweringState['traverserLayout']): LoweringState =>
  ({ q: base.q, params: base.params, sideEffects: base.sideEffects, traverserLayout: layout });

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

/** Merge a set of HOMOGENEOUS list arms (union/coalesce/choose over `…fold()` bodies) into one
 *  ListStream — the list twin of finishElementMerge/unionScalarStreams/mergeVariantArms, which
 *  the three element-parent list branches previously hand-rolled verbatim. Parent-agnostic (a
 *  bare LoweringState) so a future scalar-parent homogeneous-list branch reuses it rather than growing a
 *  fourth copy. `gateFor` supplies a per-arm WHERE (coalesce's not-in-prior).
 *
 *  EMISSION ORDER: each arm's fold() already collapsed its own multiset to ONE row per input, so
 *  a merge emits ≤1 row per arm per input and arm order IS observable in principle — but no
 *  positional consumer can reach it today (`limit()` on a list value throws), so there is nothing
 *  to order and minting would be dead SQL. The mint is therefore gated on a live carried
 *  encounter exactly like the siblings: the day a list-valued limit/range lands, this merge
 *  re-mints `ROW_NUMBER() OVER (… ORDER BY arm_idx, arm_encounter)` and is correct by
 *  construction rather than a silent take-first bug. */
export function finishListMerge(
  base: LoweringState, arms: readonly ListStream[], gateFor?: (a: Relation, k: number) => Expression | undefined,
): ListStream {
  const of = unifyLists(arms);
  const mint = !!base.traverserLayout.encounter;
  // Union the arms' LABEL SETS onto the base. An arm may bind a label the base never saw —
  // `union(__.out().fold().as("x"), …)` binds it on the LIST the fold produced, which survives the
  // barrier because it is bound after it. Without the union that column is absent from the merged
  // schema and a later select() reads nothing: a silent [].
  //
  // `rigid: 'rehomed'` and not 'peer': these arms are child-scoped and tryCompileListChild has
  // already re-homed them onto the parent, so the rigid-role comparison is false here (a child
  // scope pushed an ordinal the base lacks) — asserting it breaks coalesce outright.
  // See unionScalarStreams: the arms' schema is the branch's fork point, which carries the frozen
  // input order when this branch froze one; mergeArmRelation consumes it.
  const { fork } = branchFork(base.traverserLayout, arms[0].traverserLayout);
  const merged = mergeLayouts(fork, arms.map((a) => a.traverserLayout), { rigid: 'rehomed' });
  const grew = layoutGrewAliases(fork, merged);
  // Keep the SEED's entries when the merge added no column: a rebuilt entry re-derives binds/
  // shapes/scalarType from the arms, which is right for a label an arm introduced and wrong for
  // one the seed already owned.
  const out = patchLayout(grew ? merged : fork, mint ? { encounter: null } : {});
  const parts = arms.map((arm, k) => {
    const a = arm.rel.as('a');
    const key = armOrderKey(out, arm.traverserLayout, a);
    const tag = mint ? q`, ${k} AS arm_idx, ${key.ordinal} AS arm_ordinal, ${key.encounter} AS arm_encounter` : empty;
    const gate = gateFor?.(a, k);
    return q`SELECT ${a.c.list} AS list${tag}${layoutArmProjection(out, arm.traverserLayout, a, grew)} FROM ${a}${gate ? q` WHERE ${gate}` : empty}`;
  });
  const armMerge = mergeArmRelation(base, out, ['list'], parts, mint);
  return toListStream(stateWithLayout(base, armMerge.traverserLayout), armMerge.rel, of);
}

/** One compiled branch arm tagged by its natural shape (vk 1 scalar / 2 node / 3 edge /
 *  4 list). Parent-agnostic: an element-parent (branch.ts) and a scalar-parent (child.ts)
 *  both build these, so the merge builders below take a bare LoweringState, not an ElementStream. */
export interface VariantArm {
  readonly rel: Relation;
  readonly vk: 1 | 2 | 3 | 4;
  readonly as?: ValueType;
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

/** One arm's variant payload EXPRESSIONS, in `variantPayloadCols` order: the arm's own shape
 *  populates its column and NULLs the others, so a heterogeneous union has one physical schema. */
const variantArmPayload = (arm: VariantArm, a: Relation, hasList: boolean): Expression[] => {
  const cols: Expression[] = [
    q`${arm.vk} AS vk`,
    q`${arm.vk === 1 ? a.c.v : q`NULL`} AS v`,
    q`${arm.vk === 2 || arm.vk === 3 ? a.c.id : q`NULL`} AS rid`,
  ];
  if (hasList) cols.push(q`${arm.vk === 4 ? a.c.list : q`NULL`} AS list`);
  return cols;
};

/** Merge a set of variant arms (mixed-shape branch) into one VariantStream. Parent-agnostic
 *  (element- and scalar-parent share it). When emission order is live, SYNTHESIZE the canonical
 *  encounter: tag arm k `arm_idx=k`, keep its own encounter as `arm_encounter`, then re-mint
 *  `encounter = ROW_NUMBER() OVER (<partition> ORDER BY arm_idx, arm_encounter)` in the carried
 *  slot — arm a before arm b, matching TinkerPop union/coalesce/choose order. Without a live
 *  encounter it is a plain UNION ALL. `gateFor` supplies a per-arm WHERE (coalesce's not-in-prior).
 *
 *  Unlike its scalar/list siblings the arms do NOT grow the label set here: a mixed-shape merge is
 *  reached only from the branch triage, which classifies each arm's shape and has no route for an
 *  arm-minted alias column, so the base's carried schema rides through unchanged. */
export function mergeVariantArms(base: LoweringState, arms: readonly VariantArm[], meta: VariantArms, gateFor?: (a: Relation, k: number) => Expression | undefined, fork?: TraverserLayout): VariantStream {
  const hasList = !!meta.listOf;
  const enc = base.traverserLayout.encounter;
  // A `VariantArm` is a bare (rel, vk) pair with no layout of its own, so unlike the scalar and
  // list merges this one cannot DERIVE the branch's fork point from its arms — the caller that
  // froze an input order hands it in. Everything downstream is the same: `out` declares it, the
  // arms project it, `mergeArmRelation` sorts by it and pops it.
  const out = patchLayout(fork ?? base.traverserLayout, enc ? { encounter: null } : {});
  const armOrd = (fork ?? base.traverserLayout).origins.length > base.traverserLayout.origins.length
    ? (fork ?? base.traverserLayout).origins.at(-1) : undefined;
  const parts = arms.map((arm, k) => {
    const a = arm.rel.as('a');
    const cols = variantArmPayload(arm, a, hasList);
    // A VariantArm is a bare (rel, vk) pair, so the pair-key helper has no arm layout to read: the
    // caller's `fork` already says which ordinal the arms carry, and `out` is what the merge keeps.
    if (enc) cols.push(q`${k} AS arm_idx`, armOrd ? q`${a.c[armOrd]} AS arm_ordinal` : q`1 AS arm_ordinal`, q`${a.c[enc]} AS arm_encounter`);
    const gate = gateFor?.(a, k);
    return q`SELECT ${list(cols, ', ')}${layoutProjection(out, a)} FROM ${a}${gate ? q` WHERE ${gate}` : empty}`;
  });
  return mergeVariantParts(base, parts, meta, fork);
}

/** The merge CORE, over per-arm SELECTs already built by the caller: a plain UNION ALL when
 *  emission order is not live, else re-mint the canonical `encounter` from the arms'
 *  `arm_idx`/`arm_encounter` tags. Split out (the `finishElementMerge` precedent, branch.ts) so a
 *  merge whose arms are HETEROGENEOUS — optional()'s hit row from the arm vs miss row from the
 *  pushed DOMAIN — reuses the identical mint rather than hand-rolling a second copy. When the
 *  encounter is live, every `part` MUST carry trailing `arm_idx, arm_encounter` columns (the
 *  no-encounter form must not); a mismatch trips assertStreamColumns immediately. */
export function mergeVariantParts(base: LoweringState, parts: readonly Expression[], meta: VariantArms, fork?: TraverserLayout): VariantStream {
  const hasList = !!meta.listOf;
  const mint = !!base.traverserLayout.encounter;
  const out = patchLayout(fork ?? base.traverserLayout, mint ? { encounter: null } : {});
  const armMerge = mergeArmRelation(base, out, variantPayloadCols(hasList), parts, mint);
  return toVariantStream(stateWithLayout(base, armMerge.traverserLayout), armMerge.rel, meta);
}

const VARIANT_DISPATCH = new Map<string, ShapeTailFn<VariantStream>>([
  // count is a relational barrier over any shaped row stream → one Long scalar.
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  // unfold() only re-opens a cap()'d aggregate (result:'list') back into member rows;
  // over an already-row variant there is nothing to unfold → fall through to the throw.
  ['unfold', (s, _step, _steps, at) =>
    s.result === 'list' ? continueLowering({ ...s, result: 'rows' as const }, at + 1) : null],
  // limit/skip/range/dedup are the SHARED row ops verbatim: a variant's rows ARE its traversers,
  // and the ops name only the declared column list, so every arm rides through untouched. This file
  // used to re-declare all four, and the copy was the global slice MINUS `globalRowOps`'
  // `isLocalScope` decline — so `limit(Scope.local, 1)` read the scope TOKEN as its row count and
  // emitted `LIMIT NaN` (item 27). Declining sends it to the fallback throw below instead: a
  // variant row can be a list, so slicing its MEMBERS is a per-arm question no merge answers.
  ...globalRowOps<VariantStream>(),
]);

/** The variant arm of lowerSteps: shape-agnostic row-ops over a widened union; every
 *  step that would need per-arm shape knowledge fails closed here. */
export function compileFromVariant(s: VariantStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(VARIANT_DISPATCH, s, steps, at, () => {
    throw new Error(`${steps[at].name}() on a variant value not yet supported`);
  });
}
