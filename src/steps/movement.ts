import { q, list, empty, type Expression } from '../q.ts';
import { edges } from '../schema.ts';
import { dirsFor, edgeLabelFilter, type Elem } from '../plan.ts';
import { advance, appendPathPos, carryFrag, prevRel, type PathState, type ElementStream, type StepFn } from './context.ts';

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
// kind. `p0` (the source vertex) is seeded at V() (see steps/index.ts).

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
  return advance(st, list(selects, ' UNION ALL '), pa.opts);
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
  return advance(st, list(selects, ' UNION ALL '), { elem: 'edge', fromV: st.carried.trackFromV ? 'fv' : null, ...pa.opts });
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
  return advance(st, list(selects, ' UNION ALL '), { elem: 'node', fromV: null, ...pa.opts });
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
