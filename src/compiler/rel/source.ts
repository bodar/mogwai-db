import { col, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { arg, type Arg } from '../../gremlin/frontend.ts';
import type { Elem } from '../plan/plan.ts';
import { constLit } from './const.ts';
import { and, carriedCols, EDGE_COLS, elementCols, eq, jsonEachSet, JSON_NUMERIC_TYPES, JSON_TEXT_TYPES, keyMembership, labelIds, meta, NODE_COLS, PROPERTIES, storedValue, typeOf, type Minter } from './build.ts';

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

  /** `values(keys…)` — one traverser PER matching property VALUE off an element relation, as a
   *  relation carrying `(v, vtype)` plus the input's channels (a JOIN, so the multiset multiplies).
   *  `keys` is `null` for EVERY key and a name list otherwise (`keyMembership`'s distinction). The
   *  value's Gremlin type is PER ROW off `vtype`, so the CALLER wraps `PER_ROW('vtype')` framing —
   *  the source owns the ROWS, the vocabulary the framing. `BaseGraph` joins `vertex_properties` /
   *  `edge_properties`; a landed graph explodes the inline `{t,v}` tree. */
  propertyValues(input: Rel, kind: Elem, keys: readonly string[] | null, fresh: Minter): Rel;

  /** `V(…)`/`E(…)` — the element SOURCE: one row per element at bulk 1, narrowed by an id list bounded
   *  by the QUERY TEXT (`args`). Returns the physical scan plus the id predicate (or none for the whole
   *  graph); `null` where an id is a shape the source cannot narrow by. `BaseGraph` scans `nodes`/`edges`
   *  and matches numeric ids on the rowid, string ids on the `uid` (a bound collection as one
   *  `jsonb(?)` exploded by `json_each`); a landed graph scans its bound CTE and filters its single
   *  `id` column. The caller derives the element KIND from the step name. */
  elementScan(kind: Elem, args: readonly Arg[], fresh: Minter): { scan: Rel; pred?: Expr } | null;

  /** `hasLabel(names…)` (and the label half of `has(label, k, v)`), as a predicate CORRELATED on the
   *  element `id`. `labels` is the pre-validated NON-EMPTY label-arg set (the caller owns the null /
   *  all-null / empty cases). `labelCol` is the edge's inline label column when the physical row is in
   *  scope (the source position), letting `BaseGraph` read the covering index directly instead of a
   *  correlated id-membership subquery. `BaseGraph` resolves names→ids through `labels` and tests the
   *  side tables (`edges.label` / `vertex_labels`); a landed graph tests membership of its JSON label
   *  array. */
  hasLabelPredicate(kind: Elem, id: Expr, labelCol: Expr | undefined, labels: readonly Arg[], fresh: Minter): Expr;
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

  propertyValues: (input, kind, keys, fresh) => {
    const { table, owner } = PROPERTIES[kind];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying the
    // row is the answer. `ordered` so the stream drives and `vp_node_key(node,key)` is probed rather
    // than the planner leading with a whole-graph `key=?` scan.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', ordered: true, channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keyMembership(col(props.id, 'key'), keys)),
    });
    return make.project({
      id: fresh('sv'), input: joined, channels: input.channels,
      type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)),
      exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')],
        ...input.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
    });
  },

  elementScan: (kind, args, fresh) => {
    // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
    // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal SQL
    // and silently resolve an outer correlation to the inner table.
    const scan = make.scan({
      id: fresh('src'), table: kind === 'edge' ? 'edges' : 'nodes', alias: kind === 'edge' ? 're' : 'rn', channels: [],
      type: typeOf(...(kind === 'edge' ? EDGE_COLS : NODE_COLS)),
    });

    // Ids span two provenances and two columns. PROVENANCE decides bind-vs-inline: a parsed LITERAL id
    // is a constant bounded by the QUERY TEXT and INLINES (a rowid `int`, a uid `text`); a wire
    // PARAMETER (`V($x)`) BINDS, so its value never enters the statement text — a scalar as one `?`, a
    // bound collection (`V($ids)`) as ONE `jsonb(?)` exploded by `json_each`. COLUMN follows the value's
    // type: a number matches the rowid `id`, a string the `uid`.
    const idCol = col(scan.id, 'id');
    const uidCol = col(scan.id, 'uid');
    const inlineNums: number[] = [];
    const inlineStrs: string[] = [];
    const paramClauses: Expr[] = [];
    const inlineOne = (v: unknown): boolean => {
      if (typeof v === 'number') { inlineNums.push(v); return true; }
      if (typeof v === 'string') { inlineStrs.push(v); return true; }
      return false; // an id that is neither declines — a hard error, not a value this route can inline
    };
    for (const a of args) {
      if (a.name == null) {
        // A CONSTANT — a bare scalar id or a bracketed list literal (`V(1, [2,3])` ≡ `V(1,2,3)`); the
        // grammar forbids a param member, so every member is itself a literal that inlines.
        const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
        for (const v of members) if (!inlineOne(v)) return null;
      } else if (Array.isArray(a.value)) {
        // A bound COLLECTION of ids → ONE `jsonb(?)` bind, exploded and routed per member by its json
        // type. The two clauses share the parameter NAME, so the render dedups them to a single bind.
        paramClauses.push({ kind: 'in-query', expr: idCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_NUMERIC_TYPES), negated: false });
        paramClauses.push({ kind: 'in-query', expr: uidCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_TEXT_TYPES), negated: false });
      } else if (typeof a.value === 'number') {
        paramClauses.push(eq(idCol, param(a.value, a.name)));
      } else if (typeof a.value === 'string') {
        paramClauses.push(eq(uidCol, param(a.value, a.name, 'text')));
      } else return null; // a bound id of another shape declines, as its inline sibling does
    }

    // Inline lists first so a param-free `V(...)` renders byte-for-byte as before; `constLit` never
    // declines a number/string, so its assertion cannot fire.
    const clauses: Expr[] = [];
    if (inlineNums.length) clauses.push({ kind: 'in-list', expr: idCol, values: inlineNums.map((n) => constLit(arg(n, 'long'))!) });
    if (inlineStrs.length) clauses.push({ kind: 'in-list', expr: uidCol, values: inlineStrs.map((s) => compilerText(s)) });
    clauses.push(...paramClauses);
    const pred = clauses.reduce<Expr | undefined>((left, right) =>
      left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
    return { scan, pred };
  },

  hasLabelPredicate: (kind, id, labelCol, labels, fresh) => {
    const ids = labelIds(labels, fresh);
    if (kind === 'edge') {
      // Direct where the column is physically present (the source scan), and a membership test on the
      // edge id where it is not (after a movement, the relation is `id` + channels). Same question, and
      // the first form keeps the covering-index read the source position deserves.
      if (labelCol) return { kind: 'in-query', expr: labelCol, plan: ids, negated: false };
      const e = make.scan({ id: fresh('el'), table: 'edges', alias: fresh('rel'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
      const matching = make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: { kind: 'in-query', expr: col(e.id, 'label'), plan: ids, negated: false } });
      const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
      return { kind: 'in-query', expr: id, plan: owners, negated: false };
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const matching = make.filter({ id: fresh('f'), input: vl, channels: [], type: vl.type, pred: { kind: 'in-query', expr: col(vl.id, 'label'), plan: ids, negated: false } });
    const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('node', 'int')), exprs: [['node', col(matching.id, 'node')]] });
    return { kind: 'in-query', expr: id, plan: owners, negated: false };
  },
};
