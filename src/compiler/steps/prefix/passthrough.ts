import { q, empty, type Expression } from '../../../sql/kernel/q.ts';
import { isLocalScope, sliceOf, type IRStep } from '../../ir/step.ts';
import { argValues } from '../../../gremlin/frontend.ts';
import { limitOffset } from '../../plan/plan.ts';
import { appendCte, layoutCols, layoutProjection, prevRel, type ElementStream, type StepFn } from '../context/context.ts';

// ---------- passthrough range/limit/skip (prefix phase) ----------
//
// limit/range/skip compose as CTEs while still on the id-relation — i.e. BEFORE
// any order(). Once order() appears they fall out of the prefix table (a name the
// dispatch has no entry for) and the tail folds them into ORDER BY/LIMIT/OFFSET
// instead. So mid-chain `out().limit(5).out()` truncates here, while
// `order().by(k).limit(5)` truncates after the sort — the split IS the dispatch
// boundary (see src/compiler/engine/engine.ts).

// identity(): the no-op step — passes the current traverser set through unchanged
// (TinkerPop's own identity). IdentityRemovalStrategy exists to elide it; we keep the
// step so a traversal that names it explicitly (or one built by a client that doesn't
// run that strategy) compiles the same.
export const identity: StepFn = (_s, st) => st;

// A prefix slice picks a DETERMINISTIC window only when the chain carries emission order
// (canonical emission order, Stage B — seeded when a positional consumer follows a fan-out);
// otherwise it stays an order-free LIMIT over incidental row order (hot path unchanged).
const orderByEncounter = (st: { traverserLayout: { encounter?: string } }, p: ReturnType<typeof prevRel>): Expression =>
  st.traverserLayout.encounter ? q` ORDER BY ${p.c[st.traverserLayout.encounter]}` : empty;

/** A prefix slice inside a child scope is local to each invocation, never one global
 * LIMIT across all parent traversers. The child ordinal is a multiset-safe identity,
 * so its window partition preserves duplicate equal parents too. */
function scopedSlice(st: ElementStream, offset: number, limit: number | null): ElementStream {
  const origin = st.traverserLayout.origins.at(-1);
  if (!origin) throw new Error('scoped slice requires a child origin');
  const p = prevRel(st, 'p');
  const order = st.traverserLayout.encounter ? p.c[st.traverserLayout.encounter] : p.c.id;
  const ranked = st.q.cte(
    q`SELECT ${p.c.id} AS id${layoutProjection(st.traverserLayout, p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${order}) AS srn FROM ${p}`,
    ['id', ...layoutCols(st.traverserLayout), 'srn'],
  );
  const r = ranked.as('r');
  const stop = limit === null ? null : offset + limit;
  return appendCte(st,
    q`SELECT ${r.c.id} AS id${layoutProjection(st.traverserLayout, r)} FROM ${r} WHERE ${r.c.srn} > ${offset}${stop === null ? empty : q` AND ${r.c.srn} <= ${stop}`}`);
}

/**
 * limit/skip/range over an ELEMENT stream — one body for all three, because `sliceOf` already
 * turned the three spellings into the one window they denote.
 *
 * **`Scope.local` is IDENTITY here, and that is the reference's answer, not a shortcut.**
 * `RangeLocalStep.applyRange` (gremlin-core) slices a `Map`, an `Iterable` or an array and
 * `return start` for anything else — and a vertex/edge is none of those, so `V().limit(local,1)`
 * yields every vertex unchanged. We used to read the scope TOKEN as the row count and emit
 * `LIMIT NaN`, i.e. `no such column: NaN` at execution (item 27). The element tail
 * (`foldTailAcc`) already treats the local forms of sum/min/max/order/dedup as identity for
 * exactly this reason; the slices join them.
 */
const elementSlice: StepFn = (s, st) => {
  const slice = sliceOf(s);
  if (slice.scope === 'local') return st;
  if (st.traverserLayout.origins.length) return scopedSlice(st, slice.offset, slice.limit);
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p}${orderByEncounter(st, p)}${limitOffset(slice)}`);
};

export const limit = elementSlice;
export const range = elementSlice;
export const skip = elementSlice;

/** The one numeric argument of `tail`/`sample`, past any scope token. Neither is a `sliceOf` step:
 *  `tail` is a window measured from the far END, `sample` is not a window at all. */
const armCount = (s: IRStep): number =>
  Number(argValues(s).find((a) => typeof a === 'number') ?? 1);

/**
 * `tail(n)` over an ELEMENT stream — the last n traversers in emission order, which is `limit(n)`
 * read backwards. The element twin of the shared row op (`globalRowOps`, tail/barrier.ts); the two
 * cannot be one function because an element stream is not dispatched through `dispatchShapeTail`.
 *
 * It REQUIRES a carried encounter, and that is the semantics rather than a limitation: "the last n"
 * is a question about emission order, so a relation carrying none has no last. `tail` is already in
 * `POSITIONAL_CONSUMERS`, so a chain with a fan-out upstream seeds one; a chain without a fan-out has
 * nothing to be last OF in any order the traversal fixed, and fails closed here rather than inventing
 * one out of rowid order.
 *
 * `Scope.local` is identity for the same reason the slices are — `RangeLocalStep.applyRange` returns a
 * non-collection unchanged, and an element is one.
 */
export const tail: StepFn = (s, st) => {
  if (isLocalScope(s)) return st;
  const enc = st.traverserLayout.encounter;
  if (!enc) throw new Error('tail() over an element stream requires emission order (nothing upstream fixed one — an order() or a fan-out does)');
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p} ORDER BY ${p.c[enc]} DESC LIMIT ${armCount(s)}`);
};

/**
 * `sample(n)` over an ELEMENT stream — n traversers chosen uniformly.
 *
 * `SampleGlobalStep` is a weighted reservoir sample whose weights come from a `by()` modulator; with
 * no modulator every weight is 1, and a uniform sample of n is exactly `ORDER BY RANDOM() LIMIT n`.
 * A `by()` weight is a per-shape expression with no shared form, so it fails closed.
 */
export const sample: StepFn = (s, st) => {
  if (isLocalScope(s)) return st;
  if ((s.modulators ?? []).length) throw new Error('sample().by(weight) not yet supported (weighted reservoir sampling)');
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p} ORDER BY RANDOM() LIMIT ${armCount(s)}`);
};
