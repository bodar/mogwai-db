import { q, value, list, Query, type Expression } from '../q.ts';
import { nodes, edges } from '../schema.ts';
import { type Elem } from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { type St, type StepFn } from './context.ts';
import { move, toEdge, toVertex } from './movement.ts';
import { as, hasLabel, has, hasId, where, andOr, dedup } from './filter.ts';
import { union, optional, repeat } from './branch.ts';
import { limit, range, skip } from './passthrough.ts';
import { compileTail } from './projection.ts';
import { type Compiled } from '../render.ts';

export { compileTail };

// ---------- prefix dispatch (Seam 2) ----------
//
// The movement/filter/branch/passthrough compilers, keyed by step name. A step
// absent from this table is where the prefix ends (the tail takes over) — that
// boundary is also the range/limit-before-vs-after-order() split (passthrough.ts).
const PREFIX = new Map<string, StepFn>([
  ['out', move], ['in', move], ['both', move],
  ['outE', toEdge], ['inE', toEdge], ['bothE', toEdge],
  ['outV', toVertex], ['inV', toVertex], ['bothV', toVertex],
  ['as', as], ['hasLabel', hasLabel], ['has', has], ['hasId', hasId],
  ['where', where], ['filter', where], ['not', where],
  ['and', andOr], ['or', andOr], ['dedup', dedup],
  ['union', union], ['optional', optional],
  // The whole folded repeat/emit/times/until cluster dispatches here (strategies
  // anchors it on repeat() when present, else the first cluster step).
  ['repeat', repeat], ['emit', repeat], ['times', repeat], ['until', repeat],
  ['limit', limit], ['range', range], ['skip', skip],
]);

/** Seed the source CTE (c0) from V(...)/E(...) and its optional id list. */
function seedSource(first: PStep, query: Query, params: Record<string, any>): St {
  const elem: Elem = first.name === 'E' ? 'edge' : 'node';
  const srcRel = elem === 'edge' ? edges : nodes;
  let body: Expression;
  if (first.args.length > 0) {
    // Numeric args match the rowid, string args the user id (uid); the id-relation
    // carries rowids throughout, so a uid match still projects `id` (the rowid).
    const nums = first.args.filter((a) => typeof a === 'number');
    const strs = first.args.filter((a) => typeof a === 'string');
    const clauses: Expression[] = [];
    if (nums.length) clauses.push(q`id IN (${list(nums.map(value), ',')})`);
    if (strs.length) clauses.push(q`uid IN (${list(strs.map(value), ',')})`);
    if (!clauses.length) throw new Error('V()/E() ids must be numbers or strings');
    body = q`SELECT id FROM ${srcRel} WHERE ${list(clauses, ' OR ')}`;
  } else {
    body = q`SELECT id FROM ${srcRel}`;
  }
  return { q: query, last: query.cte(body, ['id']), aliases: new Map(), elem, indexKeys: new Set(), params };
}

/** union(b1, b2, …) as a SOURCE step: compile each branch's prefix into the SAME
 *  Query (so its CTEs share the outer WITH) and UNION ALL the branch id-relations
 *  into one seed. Branches must be vertex-rooted prefixes with no leftover tail or
 *  as() (those defer); the shared-Query recursion also lets a branch be a nested
 *  union. This is the reusable sub-traversal-into-query seam local/map/choose build on. */
function seedUnion(first: PStep, query: Query, params: Record<string, any>): St {
  const branches = first.args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) throw new Error('union() needs at least one branch');
  const indexKeys = new Set<string>();
  const rels = branches.map((b: any) => {
    const bsteps = stepChain(b.nested, params);
    const { st, stop } = buildPrefix(bsteps, params, query);
    if (stop !== bsteps.length) throw new Error(`union() source branch tail __.${bsteps[stop].name}() not yet supported`);
    if (st.elem !== 'node') throw new Error('union() source branch must be vertex-typed');
    if (st.aliases.size > 0) throw new Error('union() source branch with as() not yet supported');
    for (const k of st.indexKeys) indexKeys.add(k);
    return st.last;
  });
  const body = list(rels.map((r) => q`SELECT id FROM ${r}`), ' UNION ALL ');
  return { q: query, last: query.cte(body, ['id']), aliases: new Map(), elem: 'node', indexKeys, params };
}

/**
 * Build the movement/filter/branch CTE prefix (the id-relation) by folding the
 * step dispatch over the chain from the source (V/E/union) onward. Stops at the
 * first step absent from PREFIX (order/projection/write) and reports where. Pure
 * functional fold: each StepFn returns a fresh St; only the Query builder
 * accumulates. `query` is threaded so a nested sub-traversal (union branch) shares
 * the outer WITH.
 */
export function buildPrefix(steps: PStep[], params: Record<string, any> = {}, query: Query = new Query()): { st: St; stop: number } {
  const first = steps[0];
  const st0 = first.name === 'union' ? seedUnion(first, query, params)
    : (first.name === 'V' || first.name === 'E') ? seedSource(first, query, params)
    : (() => { throw new Error(`unsupported source step: ${first.name}`); })();
  let st = st0;
  let i = 1;
  for (; i < steps.length; i++) {
    const fn = PREFIX.get(steps[i].name);
    if (!fn) break;
    st = fn(steps[i], st);
  }
  return { st, stop: i };
}

/** A read traversal: prefix fold + tail projection. */
export function compileRead(steps: PStep[], params: Record<string, any> = {}): Compiled {
  const { st, stop } = buildPrefix(steps, params);
  return compileTail(st, steps, stop);
}
