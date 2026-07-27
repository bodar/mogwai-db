import { q, list, empty, derived, type Expression } from '../../../sql/kernel/q.ts';
import { edges } from '../../../sql/schema.ts';
import { dirsFor, edgeLabelFilter, type Elem } from '../../plan/plan.ts';
import { advance, appendPathPos, carryFrag, carryFragMint, carriedCols, carriedWith, partitionOver, prevRel, type Carried, type PathState, type ElementStream, type StepFn } from '../context/context.ts';
import { fastPathContextOf } from '../../engine/deps.ts';
import { runFastPath, type FastPath } from '../../options/fast-paths.ts';
import { lowerReSource } from '../resource.ts';

/** True iff the ONLY live carried column is bulk — no per-traverser identity (aliases/path/
 *  sack/fromV) and no branch origin. Frontier collapse is result-preserving exactly here. */
const isBulkOnly = (c: Carried): boolean =>
  !!c.bulk && c.aliases.size === 0 && !c.path && c.origins.length === 0 && !c.sack && !c.fromV && !c.encounter;

type MoveOpts = { elem?: Elem; fromV?: string | null; path?: PathState };

/** The movementCollapse fast path. The CHAIN-level gate (chainCollapseSafe) is already folded into
 *  ctx.enabled.movementCollapse by collapseSafeFastPaths, so appliesWhen only does the PER-MOVE
 *  live-state check: collapse is result-preserving exactly when no per-traverser identity rides the
 *  carried columns (isBulkOnly) and this hop mints neither fromV nor a path position. tryLower emits
 *  `SELECT id, SUM(bulk) … GROUP BY id`, bounding the frontier by reachable |V|; a downstream
 *  reducer's SUM(bulk) is unchanged. Declines → the plain UNION-ALL body, an identical result set. */
export const MovementCollapseFastPath: FastPath<[ElementStream, Expression, MoveOpts], ElementStream> = {
  name: 'movementCollapse',
  equivalentWhen: 'every disable-safe fast path is result-equivalent to generic lowering',
  appliesWhen: (ctx, st, _body, opts) => ctx.enabled.movementCollapse && isBulkOnly(st.carried) && !opts.fromV && !opts.path,
  tryLower: (_ctx, st, body, opts) => advance(st, q`SELECT id, SUM(bulk) AS bulk FROM (${body}) mv GROUP BY id`, opts),
};

/** Append a movement CTE. The movementCollapse fast path merges convergent walks when no identity
 *  is live; otherwise the plain UNION-ALL body (identical result set), refined for emission order
 *  when an encounter is live. */
function finishMove(st: ElementStream, body: Expression, opts: MoveOpts): ElementStream {
  const collapsed = runFastPath(MovementCollapseFastPath, fastPathContextOf(st), st, body, opts);
  if (collapsed) return collapsed;
  if (!st.carried.encounter) return advance(st, body, opts);
  // Emission-order refine: a movement fans a traverser out to several neighbours/edges, so the
  // encounter must be recomputed — a fresh ROW_NUMBER over (the traverser's prior encounter,
  // then the new element id as the local tiebreak, an implementation-defined but deterministic
  // movement order). A window can't span the body's UNION-ALL direction arms, so wrap the whole
  // body as a derived table and number over it (per-origin inside a child scope via partitionOver).
  const carried = carriedWith(st.carried, opts as { fromV?: string | null; path?: PathState });
  const enc = carried.encounter!;
  const cols = ['id', ...carriedCols(carried)];
  const mv = derived(body, cols, 'mv');
  const over = partitionOver(carried, mv, q`${mv.c[enc]}, ${mv.c.id}`);
  const outBody = q`SELECT ${mv.c.id} AS id${carryFragMint(carried, mv, enc, q`ROW_NUMBER() OVER (${over})`)} FROM ${mv}`;
  return { ...st, carried, elem: opts.elem ?? st.elem, rel: st.q.cte(outBody, cols) };
}

// ---------- movement (vertex ⇄ edge traversal) ----------
//
// Each movement appends one UNION ALL CTE: the id moves to the neighbour/edge/
// endpoint while the carried alias columns ride unchanged from `p` (what recovers
// "the vertex before the hop"). out/in/both stay on vertices; …E crosses to edges;
// …V crosses back to vertices (elem flips, so the next step reads the right table).
//
// When path tracking is active (chain has path()/simplePath()/cyclicPath()), each
// hop is also a new path element: every branch projects its moved id a SECOND time
// as a fresh position column p{k}, and the new PathState records that position's
// kind. `p0` (the source vertex) is seeded at V() (see the source seeding in
// src/compiler/engine/engine.ts).

/** The path-append for a movement whose new element is `newElem`: returns the SQL
 *  fragment `, <idExpr> AS p{k}` to splice into each branch, the advance()-opts to
 *  register the position, and undefined-fragments/opts when not tracking. `idExpr`
 *  is the branch's own moved-id expression (the same value bound to `id`). */
function pathAppend(st: ElementStream, newElem: Elem): { frag: (idExpr: Expression) => Expression; opts: { path?: PathState } } {
  if (!st.carried.path) return { frag: () => empty, opts: {} };
  const { path, col } = appendPathPos(st.carried.path, newElem);
  return { frag: (idExpr) => q`, ${idExpr} AS ${col}`, opts: { path } };
}

/** out()/in()/both(): vertex → neighbour vertices over the (from,to) edge pairs. */
export const move: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${st.elem}`);
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag(st.carried, p);
  const pa = pathAppend(st, 'node');
  const selects = dirsFor(s.name).map(([from, to]) =>
    q`SELECT ${e.c[to]} AS id${cf}${pa.frag(e.c[to])} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
  return finishMove(st, list(selects, ' UNION ALL '), pa.opts);
};

/** outE()/inE()/bothE(): vertex → incident edges. The new id is the EDGE id. Records
 *  the entering vertex (`p.id`) in a carried `fv` column so a following otherV() knows
 *  which end to skip; bothE's two UNION branches both entered from `p.id`. */
export const toEdge: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${st.elem}`);
  const froms = s.name === 'outE' ? ['src'] : s.name === 'inE' ? ['tgt'] : ['src', 'tgt'];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag(st.carried, p);
  const pa = pathAppend(st, 'edge');
  // Only record the entering vertex when a downstream otherV() needs it (trackFromV) —
  // otherwise every edge step would carry a dead column off the index-only hot path.
  const fvCol = (idExpr: Expression) => st.carried.trackFromV ? q`, ${idExpr} AS fv` : empty;
  const selects = froms.map((from) =>
    q`SELECT ${e.c.id} AS id${cf}${pa.frag(e.c.id)}${fvCol(p.c.id)} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
  return finishMove(st, list(selects, ' UNION ALL '), { elem: 'edge', fromV: st.carried.trackFromV ? 'fv' : null, ...pa.opts });
};

/** outV()/inV()/bothV(): edge → endpoint vertices. The new id is the NODE id. Landing
 *  on a vertex clears the edge-entered-from context (fv). */
export const toVertex: StepFn = (s, st) => {
  if (st.elem !== 'edge') throw new Error(`${s.name}() expects an edge, not a ${st.elem}`);
  const cols = s.name === 'outV' ? ['src'] : s.name === 'inV' ? ['tgt'] : ['src', 'tgt'];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag({ ...st.carried, fromV: undefined }, p); // fv is dropped at the vertex
  const pa = pathAppend(st, 'node');
  const selects = cols.map((col) =>
    q`SELECT ${e.c[col]} AS id${cf}${pa.frag(e.c[col])} FROM ${e} JOIN ${p} ON ${e.c.id}=${p.c.id}`);
  return finishMove(st, list(selects, ' UNION ALL '), { elem: 'node', fromV: null, ...pa.opts });
};

/** otherV(): edge → the endpoint that ISN'T the one the traverser was on before the
 *  edge step (the carried `fv`). Well-defined only right after an edge step (the fv
 *  context); bothE()'s ambiguous direction is exactly why this is needed. */
export const otherV: StepFn = (s, st) => {
  if (st.elem !== 'edge') throw new Error(`otherV() expects an edge, not a ${st.elem}`);
  if (!st.carried.fromV) throw new Error('otherV() requires a preceding edge step (no entering-vertex context)');
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const fv = p.c[st.carried.fromV];
  const cf = carryFrag({ ...st.carried, fromV: undefined }, p); // fv is consumed here
  const other = q`CASE WHEN ${e.c.src}=${fv} THEN ${e.c.tgt} ELSE ${e.c.src} END`;
  const pa = pathAppend(st, 'node');
  const body = q`SELECT ${other} AS id${cf}${pa.frag(other)} FROM ${e} JOIN ${p} ON ${e.c.id}=${p.c.id}`;
  return advance(st, body, { elem: 'node', fromV: null, ...pa.opts });
};

/** V()/E() MID-TRAVERSAL: re-source the graph, discarding the current element.
 *
 *  Not movement — there is no edge to follow. It is a flatMap that CROSS JOINs the target table
 *  onto each incoming traverser, which is precisely what `lowerReSource` already does for a
 *  SCALAR parent (`inject(1).as('a').V()…`). The body reads only the carried schema, never the
 *  parent's payload — a re-source discards that by definition — so the two parents share it
 *  rather than growing a second CROSS JOIN.
 *
 *  Carrying the schema forward is the whole point of the step: `g.V(1).as('a').V().has('age',
 *  gt(__.select('a').values('age')))` re-sources every vertex and compares each against the
 *  label bound before the re-source.
 *
 *  Only reachable mid-chain: `seedRooted` consumes a SOURCE V()/E() before the prefix fold
 *  begins, so this StepFn never sees the source position. Defers on path/sack/fromV, whose
 *  fork through a re-source is not worked out (lowerReSource's own guard). */
export const reSource: StepFn = (s, st) => {
  const out = lowerReSource(st, s);
  if (!out) throw new Error(`${s.name}() mid-traversal after path()/sack()/otherV() not yet supported (the carried fork through a re-source is undefined)`);
  return out;
};
