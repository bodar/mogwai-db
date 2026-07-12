import type { GraphStore } from './storage.ts';
import { sql as lsql, type Sql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { statement } from '@bodar/lazyrecords/sql/statement/ordinalPlaceholder.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';
import { q, type Query, type Relation } from './q.ts';

// ---------- compile output contract ----------
//
// The shapes a compiled traversal can produce and the boundary that renders a
// lazyrecords node tree to `{sql, binds}`. This is the seam between the compiler
// (produces these) and the handler (frames them onto the wire).

// select(labels…)/project(keys…): a Map per row. Each entry names its result
// key plus the SQL column prefix carrying its value, and whether that value is
// a whole vertex (prefix_id/_label/_props) or a scalar (prefix_v).
export interface MapEntry { key: string; prefix: string; sub: 'vertex' | 'value'; }

// The element kind an element-shaped column carries, and the columns that frame
// it. `node`→vertexBuffer(v_id,v_label,v_props); `edge`→edgeBuffer(+v_src,v_tgt);
// `property`→propertyBuffer(v_owner,v_pk,v_pv). Prefix lets a group key AND value
// each carry their own element columns (k_* / v_*).
export type ElemShape = 'vertex' | 'edge' | 'property';

// group()/groupCount(): the whole stream collapses into ONE Map (a barrier).
// The key is a scalar (gk), a token (label/id), an element (framed like a value),
// or a composite Map from project() (k0_,k1_,… parts). The value is reduced per
// group: a list of elements, a single element (tail/last), a list of scalars
// (json_group_array), or a scalar aggregate (count/sum).
export type GroupKey =
  | { kind: 'scalar' }                                   // by('name')/by(T.label)/by(__.scalar) → column gk
  | { kind: 'element'; elem: ElemShape }                 // bare by() → the element itself, columns k_*
  | { kind: 'map'; parts: { key: string }[] };           // by(__.project(...)) → columns k0_,k1_,…
export type GroupVal =
  | { kind: 'elementList'; elem: ElemShape }             // default/by(__.fold()) → [elements]
  | { kind: 'elementLast'; elem: ElemShape }             // by(__.tail()) → last element
  | { kind: 'scalarList' }                               // by('age') → json_group_array → parsed list
  | { kind: 'count' }                                    // by(__.count())/groupCount → Long
  | { kind: 'sum' };                                     // by(__.…sum()) → numeric

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'edge' }
  | { kind: 'property' } // properties(): VertexProperty elements (owner/key/value cols)
  | { kind: 'value' }
  | { kind: 'count' }
  | { kind: 'scalar' } // sum(): one numeric; handler picks Long/Double per value (numberBuffer)
  | { kind: 'list'; elem: ElemShape | 'scalar' }   // fold(): the whole stream as one List value
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean }
  | { kind: 'elementMap'; keys: string[] | null }
  | { kind: 'map'; entries: MapEntry[] }
  | { kind: 'group'; key: GroupKey; val: GroupVal }
  | { kind: 'discard' };

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
  /** Identifier-safe property keys used in a filter/order position — the
   *  handler ensures a matching expression index exists before running, so hot
   *  properties become index seeks on first filtered use (self-tuning). */
  indexKeys?: string[];
}

export interface WritePlan { kind: 'write'; run: (store: GraphStore) => any[]; }

/** Boundary: render a self-contained lazyrecords Sql tree to a read Compiled.
 *  Binds fall out of the tree (statement → {text,args}); no parallel array. Used
 *  for reads with no CTE prefix. */
export function compiled(tree: Sql, shape: Shape, indexKeys?: string[]): Compiled {
  const { text, args } = statement(tree);
  return { kind: 'read', sql: text, binds: args, shape, ...(indexKeys ? { indexKeys } : {}) };
}

/** Fragment boundary: render a node Expression to `{sql,binds}`. Binds fall out of
 *  the tree — no parallel array. Used at the few spots that still need a standalone
 *  `{sql,binds}` (e.g. a merge run-closure's match query). */
export function render(node: Expression): { sql: string; binds: any[] } {
  const { text, args } = statement(lsql(node));
  return { sql: text, binds: args };
}

/** Boundary: assemble the Query's CTE prefix + `tail` into one tree (Query.render)
 *  and wrap as a read Compiled. Every bound value lives as a Value token in a CTE
 *  body or the tail, so binds fall out of the single render. */
export function readCompiled(query: Query, tail: Expression, shape: Shape, indexKeys?: string[]): Compiled {
  const { sql, binds } = query.render(tail);
  return { kind: 'read', sql, binds, shape, ...(indexKeys ? { indexKeys } : {}) };
}

/** Render `SELECT <cols> FROM <current id-relation>` over a Query's CTE prefix to
 *  {sql,binds}. The write paths materialize target ids this way before mutating. */
export function renderFrom(query: Query, last: Relation, cols: string = 'id'): { sql: string; binds: any[] } {
  return query.render(q`SELECT ${cols} FROM ${last}`);
}
