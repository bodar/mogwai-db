import type { Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import { labelIds, meta, typeOf, type Minter } from './build.ts';

// ---------- GraphSource: one traversal vocabulary over two physical graph shapes ----------
//
// The traversal ALGEBRA (`movement`, `values`, `has`, `hasLabel`, `label`, `id`, `V()`/`E()`) is a
// vocabulary written against a graph's LOGICAL operations. It historically read the BASE graph's
// physical SQLite schema (`nodes`/`edges`/`vertex_properties`/`labels`) inline, so an INJECTED graph
// (a federate subgraph, an `io()`/`subgraph()` import) — which arrives in a different physical shape
// (properties as an inline JSON `{t,v}` tree, labels as JSON name arrays, edge labels as name
// strings) — needed a SECOND hand-written vocabulary over the JSON (`foreign.ts`). That is the smell
// this interface retires: the physical access becomes an ABSTRACTION, so one vocabulary flows over
// either shape.
//
// `GraphSource` is what the algebra reads a graph THROUGH. It exposes the LOGICAL operations; each
// implementation emits its own physical SQL. `BaseGraph` (below) is the SQLite tables; `BoundGraph`
// (`foreign.ts`, folded in later) is the landed CTEs/JSON. The vocabulary threads a `GraphSource` on
// `ChainCtx` (default `BaseGraph`); a subgraph segment sets `BoundGraph`.
//
// **Load-bearing boundary decision — labels stay a PREDICATE the source supplies, never a forced
// name.** The base `edges.label` is an interned INT id inside the `e_out(src,label,tgt)` /
// `e_in(tgt,label,src)` covering indexes; forcing labels to names everywhere would add a `labels`
// join to every hop and deoptimise the base. So `edgeLabelMatch` returns the id-set subquery on the
// indexed column for `BaseGraph` (movement's seek is UNCHANGED) and `label IN (names)` for
// `BoundGraph`. The movement JOIN STRUCTURE stays in the vocabulary; only the edge relation + the
// label predicate come from the source.
//
// **Channels are orthogonal — they live on the STREAM, not the graph.** `bulk`/`encounter`/`path` are
// traverser facts the vocabulary threads; `GraphSource` abstracts only the PHYSICAL ROWS. So once the
// vocabulary is source-parameterised the bound graph GAINS collapse/path/order for free.

/** The interface the traversal algebra reads a graph through. Grows one method per rerouted chokepoint
 *  (movement first); each method is a LOGICAL operation whose physical SQL the implementation owns. */
export interface GraphSource {
  /** The edge RELATION a hop joins — the frontier ⋈ edges probe. `BaseGraph` scans the `edges` table
   *  (`id`/`src`/`label`/`tgt`); a landed graph projects its bound-edges CTE to the same logical
   *  columns. The JOIN structure and `ordered` seek stay in `movement`; only this relation comes from
   *  the source. */
  adjacencyEdges(fresh: Minter): Rel;

  /** The label restriction on a hop's edge, as a predicate over `labelCol` (the edge relation's label
   *  column). `labels` is the pre-validated NON-EMPTY label-arg set (movement owns the empty / all-null
   *  cases). `BaseGraph` returns the id-set subquery over the `labels` table on the indexed INT column;
   *  a landed graph returns `label IN (names)` over its name-string column — which is why the boundary
   *  is a predicate, not a shared representation. */
  edgeLabelMatch(labelCol: Expr, labels: readonly Arg[], fresh: Minter): Expr;
}

/** THE BASE GRAPH — the SQLite physical schema. Every method is the CURRENT inline SQL the traversal
 *  algebra used to spell, moved behind the interface so the vocabulary no longer names a table. */
export const BaseGraph: GraphSource = {
  adjacencyEdges: (fresh) => make.scan({
    id: fresh('mv'), table: 'edges', alias: fresh('rme'), channels: [],
    type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
  }),

  edgeLabelMatch: (labelCol, labels, fresh) =>
    ({ kind: 'in-query', expr: labelCol, plan: labelIds(labels, fresh), negated: false }),
};
