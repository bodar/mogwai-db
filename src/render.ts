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
  | { kind: 'property'; elem: 'node' | 'edge' }
  // `typed`: items are self-describing {t,v} ValueNodes (a stored typed collection),
  // so unfold carries each element's own vtype and framing routes through frameTypedNode
  // (not the single `as` tag). A computed scalar list (fold of scalars) stays untyped.
  | { kind: 'scalar'; as?: ValueType; productiveNull?: boolean; typed?: boolean }
  | { kind: 'list'; of: ListOf };

// How a map stream's key/value column is shaped — kept at the render boundary (like
// ListOf/MapEntry) so a MapStream's mapEntry Shape can name it. A key/value is a bare
// scalar (mk/mv hold the value, `as` its GraphBinary tag), an element rowid (rejoined to
// nodes/edges when framed out), or a JSONB list (framed via frameListOf).
export type MapOf =
  // The scalar side of a map is ALWAYS a self-describing {t,v} ValueNode (framed via
  // frameTypedNode → each entry its own exact type; heterogeneous maps round-trip). Every
  // producer (group/groupCount/valueMap/is(typeOf(MAP))) emits this one encoding. An element
  // (rejoined from a rowid) or a list value can't be a scalar envelope → their own kinds.
  | { kind: 'scalar' }
  | { kind: 'elem'; elem: 'node' | 'edge' }
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
  | { kind: 'scalar'; productive?: boolean; as?: ValueType } // by('name')/by(T.label)/by(__.scalar)/scalar-group → gk; `as` frames a typed key (asNumber(BYTE).groupCount())
  | { kind: 'element'; elem: ElemShape }                 // bare by() → the element itself, columns k_*
  | { kind: 'map'; parts: { key: string }[] };           // by(__.project(...)) → columns k0_,k1_,…
export type GroupVal =
  | { kind: 'elementList'; elem: ElemShape }             // default/by(__.fold()) → [elements]
  | { kind: 'elementLast'; elem: ElemShape }             // by(__.tail()) → last element
  | { kind: 'scalarList' }                               // by('age') → json_group_array → parsed list
  | { kind: 'list' }                                     // one JSON list value per group key
  | { kind: 'count' }                                    // by(__.count())/groupCount → Long
  | { kind: 'sum' }                                      // by(__.…sum()) → numeric
  | { kind: 'nestedMap'; innerVal: 'count' | 'number' }; // by(__.<move>.groupCount()/group().by().by(reduce)) → a Map per key (json_group_object)

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
// bigdecimal/char/duration frame from a stored TEXT value (canonical decimal / 1-char /
// total-nanos) via our hand-rolled serializers (serializers.ts) — the value was stored
// as text precisely so its precision survives (see storedScalar / do-sqlite-bind-precision).
export type ValueType = 'bool' | 'byte' | 'short' | 'int' | 'long' | 'bigint' | 'float' | 'double' | 'date' | 'string' | 'uuid' | 'bigdecimal' | 'char' | 'duration';

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'edge' }
  | { kind: 'property' } // properties(): VertexProperty elements (vpid/owner/pk/pv/pmeta cols)
  | { kind: 'metaProperty' } // properties().properties(): meta-properties as Property elements (mk/mv cols)
  | { kind: 'metaMap' } // properties(k).valueMap(): a VertexProperty's meta as a flat Map (meta col, JSON text)
  | { kind: 'value'; as?: ValueType; perRowType?: boolean } // perRowType: frame each row by its own stored `vtype` column (values() of typed props), not the single `as`; a collection vtype frames the stored {t,v} tree via frameStoredValue
  | { kind: 'variant'; scalarAs?: ValueType; node?: boolean; edge?: boolean; listOf?: ListOf; list?: boolean } // per-row tag: null/scalar/node/edge/list; `list` wraps ALL rows into one outer List (cap)
  | { kind: 'count' }
  | { kind: 'scalar'; productiveNull?: boolean } // numeric reducer; productive NULL may be a real result
  | { kind: 'list'; elem: ElemShape | 'scalar'; as?: ValueType } // legacy row-fold; scalar items may carry a uniform type
  | { kind: 'jsonbList'; as?: ValueType; typed?: boolean; of?: ListOf } // list-VALUE rows; `typed` → items are {t,v} nodes framed via frameTypedNode; `as` is a uniform item type; `of` (a nested list whose leaf is an element list) frames each member by its own descriptor via frameListOf
  | { kind: 'jsonbElementList'; elem: Exclude<ElemShape, 'property'> } // one JSON object-array per relational element list
  | { kind: 'jsonbSet'; typed?: boolean }    // a set-VALUE stream (intersect/difference/disjunct OR a stored typed set): one Set per row, from a JSONB `list` column
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean }
  | { kind: 'elementMap'; keys: string[] | null }
  | { kind: 'map'; entries: MapEntry[] }
  | { kind: 'mapValue' } // one whole map VALUE per row: a `map` JSONB column [[keyNode,valNode],…] with self-describing {t,v} scalar sides → one GraphBinary MAP (frameTypedNode)
  | { kind: 'mapEntry'; keyOf: MapOf; valOf: MapOf } // one Map.Entry per row (a MapStream unfold) → each frames as a size-1 GraphBinary MAP
  | { kind: 'group'; key: GroupKey; val: GroupVal }
  | { kind: 'path'; positions: PathPos[] }                 // linear: one row per path, per-position columns
  | { kind: 'pathGrouped'; elem: ElemShape; byKey?: boolean } // recursive: N rows per path (pk, ord, element|value), grouped
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
