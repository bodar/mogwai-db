import { q, value, list, Query, type Expression } from '../q.ts';
import { nodes, edges } from '../schema.ts';
import { type Elem } from '../plan.ts';
import { stepChain, flattenListArgs } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { type St, type StepFn } from './context.ts';
import { move, toEdge, toVertex } from './movement.ts';
import { as, hasLabel, has, hasId, where, andOr, dedup, simplePath, cyclicPath } from './filter.ts';
import { union, optional, repeat, choose, coalesce, flatMap } from './branch.ts';
import { match } from './match.ts';
import { identity, limit, range, skip } from './passthrough.ts';
import { compileTail, compileFromScalar } from './projection.ts';
import { compileFromList } from './list.ts';
import { type Stream } from './stream.ts';
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
  ['simplePath', simplePath], ['cyclicPath', cyclicPath],
  ['union', union], ['optional', optional], ['choose', choose],
  ['coalesce', coalesce], ['flatMap', flatMap], ['match', match],
  // The whole folded repeat/emit/times/until cluster dispatches here (strategies
  // anchors it on repeat() when present, else the first cluster step).
  ['repeat', repeat], ['emit', repeat], ['times', repeat], ['until', repeat],
  ['limit', limit], ['range', range], ['skip', skip], ['identity', identity],
]);

/** Steps that need the linear path threaded through the fold: the source vertex
 *  becomes path position p0 and every hop appends a position. */
const PATH_STEPS = new Set(['path', 'simplePath', 'cyclicPath']);
const chainTracksPath = (steps: PStep[]): boolean => steps.some((s) => PATH_STEPS.has(s.name));

/** Seed the source CTE (c0) from V(...)/E(...) and its optional id list. When the
 *  chain tracks a path, the source element is path position p0 (projected as the
 *  extra `p0` column). */
function seedSource(first: PStep, query: Query, params: Record<string, any>, trackPath: boolean): St {
  const elem: Elem = first.name === 'E' ? 'edge' : 'node';
  const srcRel = elem === 'edge' ? edges : nodes;
  const sel = trackPath ? 'id, id AS p0' : 'id';
  // V(1,[2,3]) ≡ V(1,2,3): flatten any Collection id arg (collection literals + bound
  // list params render inline as [..] and parse as arrays).
  const ids = flattenListArgs(first.args);
  let body: Expression;
  if (ids.length > 0) {
    // Numeric args match the rowid, string args the user id (uid); the id-relation
    // carries rowids throughout, so a uid match still projects `id` (the rowid).
    const nums = ids.filter((a) => typeof a === 'number');
    const strs = ids.filter((a) => typeof a === 'string');
    const clauses: Expression[] = [];
    if (nums.length) clauses.push(q`id IN (${list(nums.map(value), ',')})`);
    if (strs.length) clauses.push(q`uid IN (${list(strs.map(value), ',')})`);
    if (!clauses.length) throw new Error('V()/E() ids must be numbers or strings');
    body = q`SELECT ${sel} FROM ${srcRel} WHERE ${list(clauses, ' OR ')}`;
  } else {
    body = q`SELECT ${sel} FROM ${srcRel}`;
  }
  const cols = trackPath ? ['id', 'p0'] : ['id'];
  const path = trackPath ? { kind: 'cols' as const, cols: [{ col: 'p0', elem }] } : undefined;
  return { kind: 'elements', q: query, last: query.cte(body, cols), aliases: new Map(), elem, indexKeys: new Set(), params, path };
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
  return { kind: 'elements', q: query, last: query.cte(body, ['id']), aliases: new Map(), elem: 'node', indexKeys, params };
}

/**
 * Build the movement/filter/branch CTE prefix (the id-relation) by folding the
 * step dispatch over the chain from the source (V/E/union) onward. Stops at the
 * first step absent from PREFIX (order/projection/write) and reports where. Pure
 * functional fold: each StepFn returns a fresh St; only the Query builder
 * accumulates. `query` is threaded so a nested sub-traversal (union branch) shares
 * the outer WITH.
 */
/** Fold the PREFIX dispatch over `steps` from index `from`, threading St. Stops at
 *  the first step absent from PREFIX (order/projection/write) and reports where. The
 *  shared primitive behind both buildPrefix (folding from a V/E/union source) and a
 *  branch body (folding from an already-seeded relation — choose()'s arms, see
 *  branch.ts). A body carries no strategies normalization (matching seedUnion), so a
 *  repeat/by cluster inside an arm defers via its own compiler's guards. */
export function foldBody(steps: PStep[], seedSt: St, from: number): { st: St; stop: number } {
  let st = seedSt;
  let i = from;
  for (; i < steps.length; i++) {
    const fn = PREFIX.get(steps[i].name);
    // Option-map choose (choose().option()…) is a tail CASE projector, not a prefix
    // branch — stop so compileTail handles it (predicate-form choose has no .options).
    if (!fn || (steps[i].name === 'choose' && steps[i].options)) break;
    st = fn(steps[i], st);
  }
  return { st, stop: i };
}

export function buildPrefix(steps: PStep[], params: Record<string, any> = {}, query: Query = new Query()): { st: St; stop: number } {
  const first = steps[0];
  const trackPath = chainTracksPath(steps);
  const st0 = first.name === 'union' ? seedUnion(first, query, params)
    : (first.name === 'V' || first.name === 'E') ? seedSource(first, query, params, trackPath)
    : (() => { throw new Error(`unsupported source step: ${first.name}`); })();
  return foldBody(steps, st0, 1);
}

/**
 * The re-enterable tail dispatcher. Routes a Stream + the remaining steps by shape:
 * an elements stream absorbs any further movement/filter (foldBody) then runs the
 * element tail; a scalar/list stream runs its own tail. A retype step (fold→list,
 * unfold→elements/scalar) inside those tails builds the next Stream and calls back
 * here — so V().fold().unfold().out() flows elements→list→elements→… each phase with
 * its own ≤1 projection. This is what dissolves the old "one projection per traversal"
 * ceiling structurally (each phase has a fresh accumulator).
 */
export function dispatchNext(s: Stream, steps: PStep[], at: number): Compiled {
  if (s.kind === 'elements') {
    const { st, stop } = foldBody(steps, s, at);
    return compileTail(st, steps, stop);
  }
  if (s.kind === 'scalar') return compileFromScalar(s, steps, at);
  return compileFromList(s, steps, at);
}

/** A read traversal: prefix fold + tail projection (re-enterable via dispatchNext). */
export function compileRead(steps: PStep[], params: Record<string, any> = {}): Compiled {
  const { st, stop } = buildPrefix(steps, params);
  return compileTail(st, steps, stop);
}
