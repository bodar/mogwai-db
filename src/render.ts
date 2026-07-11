import type { GraphStore } from './storage.ts';
import { sql as lsql, type Sql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { statement } from '@bodar/lazyrecords/sql/statement/ordinalPlaceholder.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';
import { cte } from '@bodar/lazyrecords/sql/ansi/CommonTableExpression.ts';
import { withRecursive } from '@bodar/lazyrecords/sql/ansi/WithClause.ts';

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

/** Boundary: render a finished lazyrecords Sql tree to a read Compiled. Binds fall
 *  out of the tree (statement → {text,args}); no hand-maintained parallel array. */
export function compiled(tree: Sql, shape: Shape, indexKeys?: string[]): Compiled {
  const { text, args } = statement(tree);
  return { kind: 'read', sql: text, binds: args, shape, ...(indexKeys ? { indexKeys } : {}) };
}

/** Fragment boundary: render a node Expression to `{sql,binds}`. Binds fall out of
 *  the tree — no parallel array. Used at the few remaining spots that still need a
 *  standalone `{sql,binds}` (e.g. a run-closure's match query). */
export function render(node: Expression): { sql: string; binds: any[] } {
  const { text, args } = statement(lsql(node));
  return { sql: text, binds: args };
}

/** One movement/filter CTE: its name (`c0`, `w1`), its body node, and — for a
 *  recursive walk — an explicit `(id, depth)` column list. The whole read query is
 *  ONE tree (all CTE bodies + the tail), so binds derive from it in a single render. */
export interface CteDef { name: string; body: Expression; cols?: string[]; }

/** Assemble `WITH RECURSIVE "c0" AS (…), "c1" AS (…) <tail>` as one node tree.
 *  Every bound value lives as a Value token inside a body/tail sub-node, so the
 *  binds fall out of the one render — no per-CTE render()+bind-array threading. */
export function withPrefixTree(ctes: CteDef[], tail: Expression): Sql {
  return lsql(withRecursive(ctes.map((c) => cte(c.name, c.body, c.cols)), tail));
}

/** Boundary: assemble the CTE prefix + tail into one tree and render to a read Compiled. */
export function readCompiled(ctes: CteDef[], tail: Expression, shape: Shape, indexKeys?: string[]): Compiled {
  return compiled(withPrefixTree(ctes, tail), shape, indexKeys);
}
