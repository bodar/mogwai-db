import { q, list } from '../q.ts';
import { edges } from '../schema.ts';
import { dirsFor, edgeLabelFilter } from '../plan.ts';
import { advance, carryFrag, prevRel, type StepFn } from './context.ts';

// ---------- movement (vertex ⇄ edge traversal) ----------
//
// Each movement appends one UNION ALL CTE: the id moves to the neighbour/edge/
// endpoint while the carried alias columns ride unchanged from `p` (what recovers
// "the vertex before the hop"). out/in/both stay on vertices; …E crosses to edges;
// …V crosses back to vertices (elem flips, so the next step reads the right table).

/** out()/in()/both(): vertex → neighbour vertices over the (from,to) edge pairs. */
export const move: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${st.elem}`);
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag(st, p);
  const selects = dirsFor(s.name).map(([from, to]) =>
    q`SELECT ${e.c[to]} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
  return advance(st, list(selects, ' UNION ALL '));
};

/** outE()/inE()/bothE(): vertex → incident edges. The new id is the EDGE id. */
export const toEdge: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${st.elem}`);
  const froms = s.name === 'outE' ? ['src'] : s.name === 'inE' ? ['tgt'] : ['src', 'tgt'];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag(st, p);
  const selects = froms.map((from) =>
    q`SELECT ${e.c.id} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c[from]}=${p.c.id}${edgeLabelFilter(s.args)}`);
  return advance(st, list(selects, ' UNION ALL '), { elem: 'edge' });
};

/** outV()/inV()/bothV(): edge → endpoint vertices. The new id is the NODE id. */
export const toVertex: StepFn = (s, st) => {
  if (st.elem !== 'edge') throw new Error(`${s.name}() expects an edge, not a ${st.elem}`);
  const cols = s.name === 'outV' ? ['src'] : s.name === 'inV' ? ['tgt'] : ['src', 'tgt'];
  const e = edges.as('e');
  const p = prevRel(st, 'p');
  const cf = carryFrag(st, p);
  const selects = cols.map((col) =>
    q`SELECT ${e.c[col]} AS id${cf} FROM ${e} JOIN ${p} ON ${e.c.id}=${p.c.id}`);
  return advance(st, list(selects, ' UNION ALL '), { elem: 'node' });
};
