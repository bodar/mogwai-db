import { q, value, list, empty, type Relation, type Expression } from '../q.ts';
import { type Elem } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import type { ForeignRow } from '../services/types.ts';
import {
  carriedCols, carryFrag, type Carry,
} from './context.ts';
import {
  carryOf, continueLowering, dispatchShapeTail, foreignPayload, toScalarStream, toResultStream,
  type ForeignStream, type LoweringResult, type ShapeTailFn,
} from './stream.ts';

export type { ForeignStream } from './stream.ts';

// ---------- detached foreign elements (federated call() results) ----------
//
// A barrier call() (mogwai.graph.federate) awaits a sibling graph, then LANDS the returned
// rows here as DETACHED references — id + label + a property snapshot — in a VALUES CTE, NOT
// as rows in the local nodes/edges tables. `landForeignElements` builds that CTE and lifts it
// into a ForeignStream (stream.ts). Because a ForeignStream is a distinct stream kind that no
// movement/filter StepFn ever receives, local graph movement over a detached element is
// structurally impossible (it fails closed in compileFromForeign's fallback) — matching the
// TinkerPop rule that a detached element carries no live adjacency.
//
// The landed props column is JSON TEXT in the SAME per-key {t,v}-node shape vertexBuffer/
// edgeBuffer already consume (execute.ts propsOf → JSON.parse), so root framing reuses the
// ordinary vertex/edge path verbatim — only the SQL projection differs (literal VALUES columns
// vs a framedProps join). Reads that need only the landed columns — id()/label()/values()/
// valueMap() — read them directly, never joining a local table.

/** One VALUES row for a foreign element: (fid, flabel[, fsrc, ftgt], fprops[, <carried…>]).
 *  `props` is stringified to JSON text so it lands as a bindable literal; framing JSON.parses
 *  it. Extra carried columns (e.g. a rejoin ordinal for mid-traversal) append after fprops. */
function foreignValuesRow(r: ForeignRow, extra: readonly (string | number)[]): Expression {
  const cells: Expression[] = [value(String(r.id)), value(r.label)];
  if (r.kind === 'edge') cells.push(value(String(r.src)), value(String(r.tgt)));
  cells.push(value(JSON.stringify(r.props)));
  for (const x of extra) cells.push(value(x));
  return q`(${list(cells, ', ')})`;
}

/** Land `rows` as a ForeignStream over a VALUES CTE. `elem` is the element kind (the caller
 *  knows it from the sibling traversal's terminal shape). `extraCols` names any columns beyond
 *  the payload that each row carries (a rejoin ordinal for the mid-traversal path); pass the
 *  matching value per row via `extraOf`. An empty `rows` yields a typed empty relation. */
export function landForeignElements(
  c: Carry,
  rows: readonly ForeignRow[],
  elem: Elem,
  extraCols: readonly string[] = [],
  extraOf: (r: ForeignRow) => readonly (string | number)[] = () => [],
): ForeignStream {
  const cols = [...foreignPayload(elem), ...extraCols];
  const rel: Relation = rows.length
    ? c.q.cte(q`VALUES ${list(rows.map((r) => foreignValuesRow(r, extraOf(r))), ', ')}`, cols)
    // Empty: a zero-row relation with the right column layout so downstream lowering is
    // shape-correct (matches directory.ts's `SELECT NULL … WHERE 0` empty-list idiom).
    : c.q.cte(q`SELECT ${list(cols.map((k) => q`NULL AS ${k}`), ', ')} WHERE 0`, cols);
  return { ...c, kind: 'foreign', rel, elem };
}

// ---- the ForeignStream tail ----

/** id()/label() → a scalar reading the landed fid/flabel column (no join). */
const foreignScalarCol = { id: 'fid', label: 'flabel' } as const;
const foreignScalarStep: ShapeTailFn<ForeignStream> = (s, step, _steps, at) => {
  const p = s.rel.as('p');
  const col = foreignScalarCol[step.name as keyof typeof foreignScalarCol];
  const rel = s.q.cte(q`SELECT ${p.c[col]} AS v${carryFrag(s.carried, p)} FROM ${p}`, ['v', ...carriedCols(s.carried)]);
  // id frames as its stored external type (string uid or int); label is always a string.
  return continueLowering(toScalarStream(carryOf(s), rel, step.name === 'label' ? 'string' : undefined), at + 1);
};

/** values(k…) → a scalar per matching property VALUE, read straight from the landed fprops
 *  JSON tree (no vertex_properties join). Each property key maps to a JSON array of {t,v}
 *  nodes (vertex, multi-valued) or a single {t,v} node (edge); json_each explodes it and the
 *  `v` inside each node is the logical value. Keys filter via json path existence. */
const foreignValues: ShapeTailFn<ForeignStream> = (s, step, steps, at) => {
  if (at + 1 < steps.length) throw new Error(`step not implemented after a federated values(): ${steps[at + 1].name}()`);
  const p = s.rel.as('p');
  const keys = step.args.filter((a): a is string => typeof a === 'string');
  // Each fprops entry is key -> [{t,v},…] (vertex) or key -> {t,v} (edge). Normalize both to an
  // array with json_each over the value (a bare object json_each yields its members; we want the
  // node itself), so read the node's `$.v` as the logical value. Filter by requested keys.
  const keyFilter = keys.length ? q` AND je.key IN (${list(keys.map(value), ', ')})` : empty;
  const isEdge = s.elem === 'edge';
  // vertex: json_each over the array of nodes; edge: the value IS one node. Extract $.v.
  const body = isEdge
    ? q`SELECT json_extract(je.value, '$.v') AS v FROM ${p}, json_each(${p.c.fprops}) je WHERE 1${keyFilter}`
    : q`SELECT json_extract(node.value, '$.v') AS v FROM ${p}, json_each(${p.c.fprops}) je, json_each(je.value) node WHERE 1${keyFilter}`;
  return continueLowering(toResultStream(s.q, body, { kind: 'value' }), at + 1);
};

const FOREIGN_TAIL = new Map<string, ShapeTailFn<ForeignStream>>([
  ['id', foreignScalarStep], ['label', foreignScalarStep],
  ['values', foreignValues],
]);

/** Consume a ForeignStream. Only reads over the landed columns are supported; anything that
 *  needs live local adjacency (out/in/both/…) or an unimplemented follow-on falls through to a
 *  clear deferral — never a silent local-table join. */
export function compileFromForeign(s: ForeignStream, steps: PStep[], at: number): LoweringResult {
  return dispatchShapeTail(FOREIGN_TAIL, s, steps, at, () => {
    throw new Error(`step not supported on a detached federated element: ${steps[at].name}() — federated results are detached references; push the traversal into the sub-query instead`);
  });
}
