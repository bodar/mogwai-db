import type { GraphStore } from './storage.ts';
import { q, type Expression, type Query, type Relation } from './q.ts';

// ---------- compile output contract ----------
//
// The shapes a compiled traversal can produce, plus the two boundaries that turn a
// Query's node tree into a read `Compiled` / a write's `{sql,binds}`. The seam
// between the compiler (produces these) and the handler (frames them onto the wire).
// SQL text is built through the q kernel; this module never touches lazyrecords.

/** Shape nested inside a relational list value. Kept at the render boundary because
 * both ListStream and map/record fields must agree on how GraphBinary frames it. */
export type ListOf =
  | { kind: 'elem'; elem: 'node' | 'edge' }
  | { kind: 'scalar'; as?: ValueType; productiveNull?: boolean }
  | { kind: 'list'; of: ListOf };

// select(labels…)/project(keys…): a Map per row. Each entry names its result
// key plus the SQL column prefix carrying its typed payload.
export type MapEntry =
  | { key: string; prefix: string; sub: 'vertex' | 'edge'; nullable?: boolean }
  | { key: string; prefix: string; sub: 'value' }
  | { key: string; prefix: string; sub: 'list'; of: ListOf };

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
  | { kind: 'scalar'; productive?: boolean }              // by('name')/by(T.label)/by(__.scalar) → column gk
  | { kind: 'element'; elem: ElemShape }                 // bare by() → the element itself, columns k_*
  | { kind: 'map'; parts: { key: string }[] };           // by(__.project(...)) → columns k0_,k1_,…
export type GroupVal =
  | { kind: 'elementList'; elem: ElemShape }             // default/by(__.fold()) → [elements]
  | { kind: 'elementLast'; elem: ElemShape }             // by(__.tail()) → last element
  | { kind: 'scalarList' }                               // by('age') → json_group_array → parsed list
  | { kind: 'list' }                                     // one JSON list value per group key
  | { kind: 'count' }                                    // by(__.count())/groupCount → Long
  | { kind: 'sum' };                                     // by(__.…sum()) → numeric

// path(): one Path per row. Each position frames either a whole element
// (prefix_id/_label/_props[/_src/_tgt]) or, under a by(key) modulator, a scalar
// (prefix_v). Positions are in traversal order; labels ride empty (labels-on-path
// deferred). See docs/2026-07-12-path-tracking-prior-art.md.
export type PathPos =
  | { render: 'element'; elem: ElemShape; prefix: string }
  | { render: 'value'; prefix: string };

// A compile-time type tag on a scalar value stream — the value's GraphBinary type
// is known from the producing step (a typed literal, or an as*() cast's target), NOT
// from the SQLite storage class (which collapses byte..long → INTEGER, float/double →
// REAL). The handler frames `v` with the matching serializer. `undefined` = infer
// from the JS value (anySerializer), the default for untyped projections.
// Emitted by asBool ('bool') and asNumber(GType.X) (the numeric subtypes). The
// numeric tag names the GraphBinary type; SQLite carries the value in whichever
// storage class fits (INTEGER/REAL), and frameValue picks the serializer.
// 'string'/'uuid' frame a stored TEXT value by its true GraphBinary type (a uuid is
// storage-ambiguous with a plain string, so it needs the stored vtype to disambiguate).
// Collections (list/map/set) are NOT ValueTypes: a list-valued property is reached via
// is(typeOf(LIST)) which retypes the scalar stream to a ListStream (the JSONB value
// becomes the `list` column), so it frames through the list substrate, not this tag.
export type ValueType = 'bool' | 'byte' | 'short' | 'int' | 'long' | 'bigint' | 'float' | 'double' | 'date' | 'string' | 'uuid';

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'edge' }
  | { kind: 'property' } // properties(): VertexProperty elements (vpid/owner/pk/pv/pmeta cols)
  | { kind: 'metaProperty' } // properties().properties(): meta-properties as Property elements (mk/mv cols)
  | { kind: 'metaMap' } // properties(k).valueMap(): a VertexProperty's meta as a flat Map (meta col, JSON text)
  | { kind: 'value'; as?: ValueType; perRowType?: boolean } // perRowType: frame each row by its own stored `vtype` column (values() of typed props), not the single `as`
  | { kind: 'variant'; scalarAs?: ValueType; elem?: Exclude<ElemShape, 'property'>; list?: boolean }
  | { kind: 'count' }
  | { kind: 'scalar'; productiveNull?: boolean } // numeric reducer; productive NULL may be a real result
  | { kind: 'list'; elem: ElemShape | 'scalar'; as?: ValueType } // legacy row-fold; scalar items may carry a uniform type
  | { kind: 'jsonbList'; as?: ValueType } // list-VALUE rows; scalar items may carry a uniform type
  | { kind: 'jsonbElementList'; elem: Exclude<ElemShape, 'property'> } // one JSON object-array per relational element list
  | { kind: 'jsonbSet' }    // a set-VALUE stream (intersect/difference/disjunct): one Set per row, from a JSONB `list` column
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean }
  | { kind: 'elementMap'; keys: string[] | null }
  | { kind: 'map'; entries: MapEntry[] }
  | { kind: 'group'; key: GroupKey; val: GroupVal }
  | { kind: 'path'; positions: PathPos[] }                 // linear: one row per path, per-position columns
  | { kind: 'pathGrouped'; elem: ElemShape }               // recursive: N rows per path (pk, ord, element), grouped
  | { kind: 'discard' };

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
}

export interface WritePlan { kind: 'write'; run: (store: GraphStore) => any[]; }

/** Boundary: assemble the Query's CTE prefix + `tail` into one tree (Query.render)
 *  and wrap as a read Compiled. Every bound value lives as a Value token in a CTE
 *  body or the tail, so binds fall out of the single render. */
export function readCompiled(query: Query, tail: Expression, shape: Shape): Compiled {
  const { sql, binds } = query.render(tail);
  return { kind: 'read', sql, binds, shape };
}

/** Render `SELECT <cols> FROM <current id-relation>` over a Query's CTE prefix to
 *  {sql,binds}. The write paths materialize target ids this way before mutating. */
export function renderFrom(query: Query, last: Relation, cols: string = 'id'): { sql: string; binds: any[] } {
  return query.render(q`SELECT ${cols} FROM ${last}`);
}
