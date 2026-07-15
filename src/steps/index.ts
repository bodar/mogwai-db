import { q, value, list, empty, Query, type Expression } from '../q.ts';
import { nodes, edges } from '../schema.ts';
import { type Elem } from '../plan.ts';
import { stepChain, flattenListArgs } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { withCarried, type ElementStream, type StepFn } from './context.ts';
import { move, toEdge, toVertex, otherV } from './movement.ts';
import { as, hasLabel, has, hasId, where, andOr, dedup, simplePath, cyclicPath } from './filter.ts';
import { union, optional, repeat, choose, coalesce, flatMap } from './branch.ts';
import { match } from './match.ts';
import { identity, limit, range, skip } from './passthrough.ts';
import { sack } from './sack.ts';
import { local } from './local.ts';
import { aggregate, group as groupSE, groupCount as groupCountSE } from './sideeffect.ts';
import { type SackSpec } from '../frontend.ts';
import { compileTail, compileFromScalar } from './projection.ts';
import { compileFromList, compileFromMap } from './list.ts';
import { assertStreamColumns, type Stream } from './stream.ts';
import { type Compiled } from '../render.ts';
import { tryBulkRepeatCount } from './bulk.ts';
import { lowerScalarRows } from './scalar.ts';
import { materializeScalarRoot } from './materialize.ts';

export { compileTail };

// ---------- prefix dispatch (Seam 2) ----------
//
// The movement/filter/branch/passthrough compilers, keyed by step name. A step
// absent from this table is where the prefix ends (the tail takes over) — that
// boundary is also the range/limit-before-vs-after-order() split (passthrough.ts).
const PREFIX = new Map<string, StepFn>([
  ['out', move], ['in', move], ['both', move],
  ['outE', toEdge], ['inE', toEdge], ['bothE', toEdge],
  ['outV', toVertex], ['inV', toVertex], ['bothV', toVertex], ['otherV', otherV],
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
  // Only the MUTATE form sack(Operator.x) is a prefix step; bare sack() (read) breaks
  // out to the tail (foldBody guard below).
  ['sack', sack],
  // aggregate() is a pass-through barrier: it registers a named side-effect and
  // returns the stream unchanged, so the traversal continues. (TinkerPop 4 dropped
  // the lazy store() step; aggregate(Scope.local) replaces it — not in the grammar.)
  ['aggregate', aggregate],
  // The SIDE-EFFECTING group('a')/groupCount('a') (has a string key) is a pass-through
  // barrier too; the bare terminal group()/groupCount() breaks to the tail (guard below).
  ['group', groupSE], ['groupCount', groupCountSE],
  // local() with a movement body + per-element limit/range is a prefix step; a
  // scalar-reduction body (local(out().count())) breaks to the tail (guard below).
  ['local', local],
]);

/** A sack step in its mutate form (has an Operator arg); the bare read form is a tail
 *  projection, so it must NOT dispatch as a prefix step. */
const isSackMutate = (s: PStep): boolean => (s.args ?? []).some((a: any) => a && typeof a === 'object' && 'operator' in a);

/** A side-effecting group('a')/groupCount('a') (has a string side-effect key); the bare
 *  form is a terminal barrier handled by compileTail, so it must break out of the prefix. */
const isSideEffectGroup = (s: PStep): boolean => (s.args ?? []).some((a: any) => typeof a === 'string');

/** A local() whose body is a per-element SCALAR reduction (…count()/sum()/…) — it
 *  projects one scalar per input, so it's a tail projector (compileMapScalar), not a
 *  prefix step. A movement + limit/range body stays the prefix window step (local.ts). */
const SCALAR_LOCAL_END = new Set(['count', 'sum', 'min', 'max', 'mean']);
const isScalarLocal = (s: PStep, params: Record<string, any>): boolean => {
  const nested = (s.args ?? [])[0]?.nested;
  if (!nested) return false;
  const body = stepChain(nested, params);
  return body.length > 0 && SCALAR_LOCAL_END.has(body[body.length - 1].name);
};

/** Steps that need the linear path threaded through the fold: the source vertex
 *  becomes path position p0 and every hop appends a position. */
const PATH_STEPS = new Set(['path', 'simplePath', 'cyclicPath']);
const chainTracksPath = (steps: PStep[]): boolean => steps.some((s) => PATH_STEPS.has(s.name));
/** otherV() needs each edge step to record its entering vertex — gate that on the
 *  chain naming otherV, so ordinary edge traversals stay index-only (no dead column). */
const chainNeedsFromV = (steps: PStep[]): boolean => steps.some((s) => s.name === 'otherV');

/** Seed the source CTE (c0) from V(...)/E(...) and its optional id list. When the
 *  chain tracks a path, the source element is path position p0 (projected as the
 *  extra `p0` column). */
function seedSource(first: PStep, query: Query, params: Record<string, any>, trackPath: boolean, sackInit?: SackSpec): ElementStream {
  const elem: Elem = first.name === 'E' ? 'edge' : 'node';
  const srcRel = elem === 'edge' ? edges : nodes;
  const sel = trackPath ? 'id, id AS p0' : 'id';
  // withSack() seeds every traverser's carried sack column with the initial value (a
  // bound Value so a string init like "hello" escapes safely).
  const sackCol: Expression = sackInit ? q`, ${value(sackInit.init)} AS sk` : empty;
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
    body = q`SELECT ${sel}${sackCol} FROM ${srcRel} WHERE ${list(clauses, ' OR ')}`;
  } else {
    body = q`SELECT ${sel}${sackCol} FROM ${srcRel}`;
  }
  const cols = [...(trackPath ? ['id', 'p0'] : ['id']), ...(sackInit ? ['sk'] : [])];
  const path = trackPath ? { kind: 'cols' as const, cols: [{ col: 'p0', elem }] } : undefined;
  return { kind: 'elements', q: query, params, rel: query.cte(body, cols), elem, carried: { aliases: new Map(), origins: [], path, sack: sackInit ? 'sk' : undefined } };
}

/** union(b1, b2, …) as a SOURCE step: compile each branch's prefix into the SAME
 *  Query (so its CTEs share the outer WITH) and UNION ALL the branch id-relations
 *  into one seed. Branches must be vertex-rooted prefixes with no leftover tail or
 *  as() (those defer); the shared-Query recursion also lets a branch be a nested
 *  union. This is the reusable sub-traversal-into-query seam local/map/choose build on. */
function seedUnion(first: PStep, query: Query, params: Record<string, any>, sackInit?: SackSpec): ElementStream {
  if (sackInit) throw new Error('withSack() with a union() source not yet supported');
  const branches = first.args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) throw new Error('union() needs at least one branch');
  const rels = branches.map((b: any) => {
    const bsteps = stepChain(b.nested, params);
    const { st, stop } = buildPrefix(bsteps, params, query);
    if (stop !== bsteps.length) throw new Error(`union() source branch tail __.${bsteps[stop].name}() not yet supported`);
    if (st.elem !== 'node') throw new Error('union() source branch must be vertex-typed');
    if (st.carried.aliases.size > 0) throw new Error('union() source branch with as() not yet supported');
    return st.rel;
  });
  const body = list(rels.map((r) => q`SELECT id FROM ${r}`), ' UNION ALL ');
  return { kind: 'elements', q: query, params, rel: query.cte(body, ['id']), elem: 'node', carried: { aliases: new Map(), origins: [] } };
}

/**
 * Build the movement/filter/branch CTE prefix (the id-relation) by folding the
 * step dispatch over the chain from the source (V/E/union) onward. Stops at the
 * first step absent from PREFIX (order/projection/write) and reports where. Pure
 * functional fold: each StepFn returns a fresh ElementStream; only the Query builder
 * accumulates. `query` is threaded so a nested sub-traversal (union branch) shares
 * the outer WITH.
 */
/** Fold the PREFIX dispatch over `steps` from index `from`, threading ElementStream. Stops at
 *  the first step absent from PREFIX (order/projection/write) and reports where. The
 *  shared primitive behind both buildPrefix (folding from a V/E/union source) and a
 *  branch body (folding from an already-seeded relation — choose()'s arms, see
 *  branch.ts). A body carries no strategies normalization (matching seedUnion), so a
 *  repeat/by cluster inside an arm defers via its own compiler's guards. */
export function foldBody(steps: PStep[], seedSt: ElementStream, from: number): { st: ElementStream; stop: number } {
  let st = seedSt;
  let i = from;
  for (; i < steps.length; i++) {
    const fn = PREFIX.get(steps[i].name);
    // Option-map choose (choose().option()…) is a tail CASE projector, not a prefix
    // branch — stop so compileTail handles it (predicate-form choose has no .options).
    if (!fn
      || (steps[i].name === 'choose' && steps[i].options)
      || (steps[i].name === 'sack' && !isSackMutate(steps[i]))
      || ((steps[i].name === 'group' || steps[i].name === 'groupCount') && !isSideEffectGroup(steps[i]))
      || (steps[i].name === 'local' && isScalarLocal(steps[i], seedSt.params))) break;
    st = fn(steps[i], st);
  }
  return { st, stop: i };
}

export function buildPrefix(steps: PStep[], params: Record<string, any> = {}, query: Query = new Query(), sackInit?: SackSpec): { st: ElementStream; stop: number } {
  const first = steps[0];
  const trackPath = chainTracksPath(steps);
  const seeded = first.name === 'union' ? seedUnion(first, query, params, sackInit)
    : (first.name === 'V' || first.name === 'E') ? seedSource(first, query, params, trackPath, sackInit)
    : (() => { throw new Error(`unsupported source step: ${first.name}`); })();
  // Gate the otherV() entering-vertex tracking on the chain; local()'s body inherits
  // the flag through its {...st} seed, so an inner edge step records it too.
  const st0 = chainNeedsFromV(steps) ? withCarried(seeded, { trackFromV: true }) : seeded;
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
  assertStreamColumns(s);
  if (s.kind === 'elements') {
    const { st, stop } = foldBody(steps, s, at);
    return compileTail(st, steps, stop);
  }
  if (s.kind === 'scalar') {
    const { stream, stop } = lowerScalarRows(s, steps, at);
    if (stop === steps.length) return materializeScalarRoot(stream);
    return compileFromScalar(stream, steps, stop);
  }
  if (s.kind === 'map') return compileFromMap(s, steps, at);
  return compileFromList(s, steps, at);
}

/** A read traversal: prefix fold + tail projection (re-enterable via dispatchNext).
 *  `sackInit` (from withSack()) seeds the carried sack column at the source. */
export function compileRead(steps: PStep[], params: Record<string, any> = {}, sackInit?: SackSpec): Compiled {
  // Traverser bulking: a `repeat(...).times(n).count()` (path/as/sack-free) compiles to
  // unrolled GROUP-BY-SUM(bulk) CTEs instead of an enumerate-every-walk recursion, so a
  // dense/deep count (grateful times(8) ≈ 2.5e15 walks) stays tractable. Null → not the
  // bulkable shape; fall through to the normal fold. See steps/bulk.ts.
  const bulked = tryBulkRepeatCount(steps, params, sackInit);
  if (bulked) return bulked;

  const { st, stop } = buildPrefix(steps, params, new Query(), sackInit);
  return compileTail(st, steps, stop);
}
