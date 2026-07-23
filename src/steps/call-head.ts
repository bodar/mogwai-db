import { q, list, empty, type Expression } from '../sql/kernel/q.ts';
import { framedProps, extIdOf } from '../compiler/plan/plan.ts';
import { edges, labels, nodes } from '../sql/schema.ts';
import { type Compiled } from '../sql/kernel/render.ts';
import { materializeRoot } from './materialize.ts';
import { type ElementStream } from './context.ts';
import { pushChildScope, tryCompileScalarValueChild, type ChildFrame, type CompileScope } from './child.ts';

// ---------- the mid-traversal barrier call() HEAD (Phase 6b) ----------
//
// A mid-traversal V().call(barrier, …, __.values('k')) suspends into a segment whose HEAD is a
// COMPLETE Compiled: one row per parent traverser carrying (id, label, props[, src, tgt], o, injVal).
//   - `o`     — the multiset-safe rejoin ordinal pushChildScope mints (ROW_NUMBER), the column
//               readSegmentHead reads into a head row (execute.ts).
//   - `injVal`— the per-parent injected scalar (values(k)/id()/label()), computed by the ORDINARY
//               child-scalar machinery (tryCompileScalarValueChild) — the exact seam
//               tinker.degree.centrality/math()/format() already use. LEFT JOIN so a parent whose
//               injection produced nothing still appears (injVal NULL) rather than vanishing.
// The id/label/props projection reuses framedProps/extIdOf exactly like an ordinary element leaf,
// so readSegmentHead frames these rows through the same vertex/edge path (its `injVal`/`o` reads
// free-ride outside the Shape, as `o` already does today). A call with NO injection traversal
// (a constant sub-traversal) projects injVal NULL for every parent — apply's batching treats that
// as the single degenerate group (run once).

export interface CallHead {
  readonly head: Compiled;
  readonly frame: ChildFrame;
}

/** Build the per-parent head for a mid-traversal barrier call() over an element parent. Pushes a
 *  child scope on `parent` (minting the rejoin ordinal), computes the injected scalar per parent
 *  via the generic child-scalar seam, and materializes (id, label, props[, src, tgt], o, injVal). */
export function buildCallHead(parent: ElementStream, scope: CompileScope, injection: any): CallHead {
  const pushed = pushChildScope(parent, scope);
  const injScalar = injection ? tryCompileScalarValueChild(pushed.seed, injection, 'first', pushed.scope) : null;
  if (injection && !injScalar)
    throw new Error('mid-traversal call() injection must be a direct value read — __.values(key), __.id(), or __.label()');

  const elem = parent.elem;
  const d = pushed.frame.domain.as('d');
  const n = (elem === 'edge' ? edges : nodes).as('n');
  const l = labels.as('l');
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const payload = elem === 'edge'
    ? q`${extId} AS id, ${l.c.name} AS label, ${extIdOf(n.c.src)} AS src, ${extIdOf(n.c.tgt)} AS tgt, ${framedProps(n, 'edge')} AS props`
    : q`${extId} AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props`;
  const elemJoin = q`${d} JOIN ${n} ON ${n.c.id}=${d.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`;

  const ord = pushed.frame.ordinal;
  let injCol: Expression = q`NULL AS injVal`;
  let injJoin: Expression = empty;
  if (injScalar) {
    const s = injScalar.rel.as('s');
    injCol = q`${s.c.v} AS injVal`;
    injJoin = q` LEFT JOIN ${s} ON ${s.c[ord]}=${d.c[ord]}`;
  }
  const sql = q`SELECT ${payload}, ${d.c[ord]} AS o, ${injCol} FROM ${elemJoin}${injJoin}`;
  const head = materializeRoot(parent.q, sql, { kind: elem === 'edge' ? 'edge' : 'vertex' });
  return { head, frame: pushed.frame };
}
