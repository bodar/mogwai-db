import { q, empty, type Expression } from '../../../sql/kernel/q.ts';
import { rangeToOffsetLimit } from '../../plan/plan.ts';
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

export const limit: StepFn = (s, st) => {
  if (st.traverserLayout.origins.length) return scopedSlice(st, 0, Number(s.args[0]));
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p}${orderByEncounter(st, p)} LIMIT ${Number(s.args[0])}`);
};

export const range: StepFn = (s, st) => {
  const { offset, limit } = rangeToOffsetLimit(s.args);
  if (st.traverserLayout.origins.length) return scopedSlice(st, offset, limit);
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p}${orderByEncounter(st, p)} LIMIT ${limit} OFFSET ${offset}`);
};

export const skip: StepFn = (s, st) => {
  if (st.traverserLayout.origins.length) return scopedSlice(st, Number(s.args[0]), null);
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${p.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${p}${orderByEncounter(st, p)} LIMIT -1 OFFSET ${Number(s.args[0])}`);
};
