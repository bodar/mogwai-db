import { q, list, empty, type Expression } from '../q.ts';
import { rangeToOffsetLimit } from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { advance, carriedCols, type StepFn } from './context.ts';
import { foldBody } from './index.ts';
import { pushChildScope } from './child.ts';

// ---------- local() — per-element scope ----------
//
// local(childTraversal) runs the child ONCE PER incoming traverser, independently, so
// a barrier inside it scopes PER-element, not across the whole stream:
// local(outE().limit(1)) = one edge PER vertex, unlike the global outE().limit(1).
//
// Two shapes, dispatched by body (like sack/group):
//  · SCALAR reduction body (local(outE().count())) → a tail projector reusing
//    compileMapScalar/compileNestedScalar (foldBody breaks it to the tail).
//  · MOVEMENT + a per-element limit/range (this StepFn) → the movement folds normally,
//    then the barrier is applied as a WINDOW partitioned by the input ordinal.
//
// The input ordinal (a fresh ROW_NUMBER, the coalesce/optional technique) keeps the
// window per-traverser even across the multiset (two equal input vertices stay
// distinct). Deferred (clear throws): non-movement bodies (match/simplePath/union/
// nested local), a body with no per-element barrier, order()/dedup() inside local,
// sack/fromV still defer until their split/merge policy is explicit.

const BODY_MOVES = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV', 'otherV']);
const WINDOW_BARRIERS = new Set(['limit', 'range']);

export const local: StepFn = (s, st) => {
  const body = stepChain((s.args ?? [])[0]?.nested, st.params);
  if (!body.length) throw new Error('local(traversal) required');
  const c = st.carried;
  if (c.sack || c.fromV)
    throw new Error('local() through sack/otherV state not yet supported');

  const last = body[body.length - 1];
  if (!WINDOW_BARRIERS.has(last.name))
    throw new Error(`local(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (movement + a per-element limit()/range() only)`);
  const moveSteps = body.slice(0, -1);
  if (!moveSteps.length || moveSteps.some((c) => !BODY_MOVES.has(c.name)))
    throw new Error(`local(__.${body.map((c) => c.name + '()').join('.')}) not yet supported (movement steps only before the barrier)`);

  // Tag each input with a fresh ordinal so the window scopes per input traverser
  // (multiset-safe), then fold the movement carrying it.
  const { frame, seed } = pushChildScope(st);
  const { st: end, stop } = foldBody(moveSteps, seed, 0);
  if (stop !== moveSteps.length)
    throw new Error(`local(__.${moveSteps[stop].name}()) body step not yet supported`);

  // The carried columns to keep on the way out: everything the body accrued (e.g. the
  // otherV() fv context) EXCEPT the internal ordinal.
  const p = end.rel.as('p');
  const others = carriedCols(end.carried).filter((c) => c !== frame.ordinal);
  const frag = (rel: typeof p) => (others.length ? list(others.map((c) => q`, ${rel.c[c]}`), '') : empty);

  // ROW_NUMBER within each input ordinal → the per-element slice (limit = 1..N,
  // range[lo,hi) = lo+1..hi). ORDER BY id = element (insertion) order.
  const { offset, limit } = last.name === 'limit' ? { offset: 0, limit: Number(last.args[0]) } : rangeToOffsetLimit(last.args);
  const ranked = st.q.cte(
    q`SELECT ${p.c.id} AS id${frag(p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[frame.ordinal]} ORDER BY ${p.c.id}) AS rn FROM ${p}`,
    ['id', ...others, 'rn'],
  );
  const r = ranked.as('r');
  const hi = limit === null ? null : offset + limit;
  const guards: Expression[] = [q`${r.c.rn} > ${offset}`, ...(hi !== null ? [q`${r.c.rn} <= ${hi}`] : [])];

  // Advance from `end` (carries the body's fromV/elem), dropping the ordinal.
  return advance(end, q`SELECT ${r.c.id} AS id${frag(r)} FROM ${r} WHERE ${list(guards, ' AND ')}`,
    { elem: end.elem, origins: st.carried.origins, cols: ['id', ...others] });
};
