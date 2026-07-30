import { q, list, value, empty, type Expression } from '../../sql/kernel/q.ts';
import { elemTable } from '../plan/plan.ts';
import { flattenListArgs } from '../../gremlin/frontend.ts';
import { layoutCols, layoutProjection, type ElementStream } from './context/context.ts';
import { loweringStateOf, toElementStream, type ScalarStream } from './context/stream.ts';
import { type IRStep } from '../ir/strategies.ts';

// ---------- V()/E() as a MID-TRAVERSAL re-source (a shared leaf) ----------
//
// Lives at the steps/ root, not under tail/ or prefix/, because BOTH reach it: the scalar tail
// (`inject(1).V()`) and the element prefix (`g.V(1).as('a').V()`). Its own imports are all
// leaves, so it adds no edge between those two families — putting it in tail/projection.ts and
// importing that from prefix/movement.ts instead created a module-INIT cycle (child-shape.ts
// builds a Set from scalar.ts at import time, and the new edge reordered initialization).

/**
 * V()/E() after a SCALAR: a mid-traversal graph source. TinkerPop's GraphStep(isStart=false)
 * discards the incoming object and re-sources the graph per traverser — V() all vertices, V(id…)
 * the id-matched ones — so it is a flatMap (CROSS JOIN the incoming rows with the target table).
 * Parent-agnostic: the body reads only `carried`/`rel`/`q`, never the parent's payload (a
 * re-source DISCARDS that by definition), so the SCALAR tail and the mid-traversal ELEMENT prefix
 * step share it verbatim rather than growing a second CROSS JOIN.
 * The carried schema (as()-labels) rides forward on the join, so `inject(1).as('a').V()…` keeps
 * its label. A pushed child ordinal (origins) rides through the CROSS JOIN unchanged via
 * layoutProjection — so re-sourcing INSIDE a scalar child scope (a branch/map arm `__.V().count()`)
 * is fine: the re-sourced elements carry the parent ordinal and a following scoped reducer/fold
 * groups by it. Defers (null) only for path/sack/fromV, whose fork/merge through a re-source is
 * not worked out.
 */
export function lowerReSource(s: ScalarStream | ElementStream, step: IRStep): ElementStream | null {
  if (s.traverserLayout.path || s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const elem: 'vertex' | 'edge' = step.name === 'E' ? 'edge' : 'vertex';
  const n = elemTable(elem).as('n');
  const p = s.rel.as('p');
  const cols = layoutCols(s.traverserLayout);
  const rawIds = flattenListArgs(step.args ?? []);
  let where: Expression = empty;
  if (rawIds.length) {
    const nums = rawIds.filter((a) => typeof a === 'number');
    const strs = rawIds.filter((a) => typeof a === 'string');
    const clauses: Expression[] = [];
    if (nums.length) clauses.push(q`${n.c.id} IN (${list(nums.map(value), ',')})`);
    if (strs.length) clauses.push(q`${n.c.uid} IN (${list(strs.map(value), ',')})`);
    where = clauses.length ? q` WHERE ${list(clauses, ' OR ')}` : q` WHERE 0`; // only-null ids → no match
  }
  const rel = s.q.cte(
    q`SELECT ${n.c.id} AS id${layoutProjection(s.traverserLayout, p)} FROM ${p} CROSS JOIN ${n}${where}`,
    ['id', ...cols],
  );
  return { ...toElementStream(loweringStateOf(s), rel, elem), reSourced: true };
}
