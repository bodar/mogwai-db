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

import { q, list, empty, type Expression } from '../q.ts';
import { rangeToOffsetLimit } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryOf, continueLowering, dispatchShapeTail, toVariantStream, type LoweringResult, type ShapeTailFn, type VariantStream } from './stream.ts';
import { carriedCols } from './context.ts';
import { lowerGlobalCount } from './barrier.ts';

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
