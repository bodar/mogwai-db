import type { GraphStore } from '../../storage.ts';
import { q, type Expression, type Query, type Relation } from './q.ts';
import type { ValueNode, ValueType } from '../../gremlin/types.ts';
import type { Elem } from '../../compiler/plan/plan.ts';

// ---------- compile output contract ----------
//
// The shapes a compiled traversal can produce, plus the two boundaries that turn a
// Query's node tree into a read `Compiled` / a write's `{sql,binds}`. The seam
// between the compiler (produces these) and the handler (frames them onto the wire).
// SQL text is built through the q kernel; this module never touches lazyrecords.

/** Shape nested inside a relational list value. Kept at the render boundary because
 * both ListStream and map/record fields must agree on how GraphBinary frames it. */
export type ListOf =
  | { kind: 'elem'; elem: Elem }
  | { kind: 'property'; elem: Elem }
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
  | { kind: 'elem'; elem: Elem }
  | { kind: 'list'; of: ListOf };

// select(labels…)/project(keys…): a Map per row. Each entry names its result
// key plus the SQL column prefix carrying its typed payload.
export type MapEntry =
  | { key: string; prefix: string; sub: 'vertex' | 'edge'; nullable?: boolean }
  // A record/map scalar has the same total type channel as ScalarStream. Its per-row
  // member names the prefixed sibling column in the wide record relation.
  | { key: string; prefix: string; sub: 'value'; type: ScalarType }
  | { key: string; prefix: string; sub: 'list'; of: ListOf };

// The element kind an element-shaped column carries, and the columns that frame
// it. `node`→vertexBuffer(v_id,v_label,v_props); `edge`→edgeBuffer(+v_src,v_tgt);
// `property`→propertyBuffer(v_owner,v_pk,v_pv). Prefix lets a group key AND value
// each carry their own element columns (k_* / v_*).
export type ElemShape = Elem | 'property';

// group()/groupCount(): the whole stream collapses into ONE Map (a barrier).
// The key is a scalar (gk), a token (label/id), an element (framed like a value),
// or a composite Map from project() (k0_,k1_,… parts). The value is reduced per
// group: a list of elements, a single element (tail/last), a list of scalars
// (json_group_array), or a scalar aggregate (count/sum).
export type GroupKey =
  // by('name')/by(T.label)/by(__.scalar)/scalar-group → gk, its type in the ONE channel.
  // A perRow type names a SIBLING column (gkt) rather than a {t,v} envelope: the key is a
  // GROUP BY term (an envelope would group by JSON text), and a bare groupCount() never
  // becomes a MapStream, so there is no blob for it to ride inside.
  | { kind: 'scalar'; productive?: boolean; type?: ScalarType }
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
  // `optional` = a PADDED position of a branched path (a shorter arm left it NULL). The value
  // column alone cannot say whether the position is absent or its by() value is missing, so an
  // optional position carries a sibling `<prefix>_at` presence column (the raw position id) and
  // the handler omits the position when it is NULL. An element position needs no such column —
  // its own `_id` already answers it.
  | { render: 'value'; prefix: string; optional?: true };

// A compile-time type tag on a scalar value stream — the value's GraphBinary type
// is known from the producing step (a typed literal, or an as*() cast's target), NOT
// from the SQLite storage class (which collapses byte..long → INTEGER, float/double →
// REAL). The handler frames `v` with the matching serializer. `undefined` = infer
// from the JS value (anySerializer), the default for untyped projections.
// Emitted by asBool ('boolean') and asNumber(GType.X) (the numeric subtypes). The
// numeric tag names the GraphBinary type; SQLite carries the value in whichever
// storage class fits (INTEGER/REAL), and frameValue picks the serializer.
// 'string'/'uuid' frame a stored TEXT value by its true GraphBinary type (a uuid is
// storage-ambiguous with a plain string, so it needs the stored vtype to disambiguate).
// Collections (list/map/set) are excluded from ValueType: a list-valued property is reached via
// is(typeOf(LIST)) which retypes the scalar stream to a ListStream (the JSONB value
// becomes the `list` column), so it frames through the list substrate, not this tag.
// bigdecimal/char/duration frame from a stored TEXT value (canonical decimal / 1-char /
// total-nanos) via our hand-rolled serializers (serializers.ts) — the value was stored
// as text precisely so its precision survives (see storedScalar / do-sqlite-bind-precision).
// Declared in gremlin/types.ts as `Exclude<CanonicalType, 'list'|'map'|'set'>` — ONE vocabulary,
// with the collection exclusion as its only real content. Re-exported here because this module is
// the compiler's shared type surface and ~24 files take it from here; owning it there is what
// breaks the `types.ts → render.ts → storage.ts → types.ts` loop.
export type { ValueType };

// ---------- the ONE scalar type channel ----------
//
// Every scalar value has a type; the only question is WHERE that type is written down.
// Historically that was two optional fields (`as` — one compile-time tag for the whole
// stream — plus `vtype` — the NAME of a per-row column) and an implicit third case
// ("neither is set, infer from the JS value at the wire"). Two optionals plus an implicit
// third means a step author must remember three things, so they remember one: every bug in
// this area is a barrier propagating `as` and dropping `vtype`. One total union with three
// cases the compiler FORCES you to handle removes the class.
//
// `unknown` is reachable ONLY from the JS-client seam (a JS client cannot distinguish a UUID
// from a string, so a bound param genuinely has no type). It is an UNKNOWN type, not an
// ABSENT one — naming it keeps the model total. If the client is ever fixed, the variant
// becomes unreachable and deletable.
//
// This is a COMPILE-TIME property; the physical encoding stays a per-site choice (bare when
// the SQLite storage class already determines it, a sibling column for row-preserving ops,
// a {t,v} envelope only inside a JSON blob). Conflating the two is what caused the dead end
// recorded in docs/2026-07-25-type-channel-unification.md.
export type ScalarType =
  | { kind: 'static'; type: ValueType }   // a cast, a typed literal, count()→long
  | { kind: 'perRow'; column: string }    // a stored-vtype column — the only heterogeneous-safe case
  | { kind: 'unknown' };                  // the JS-client seam; infer from the JS value at framing

export const STATIC = (type: ValueType): ScalarType => ({ kind: 'static', type });
export const PER_ROW = (column: string): ScalarType => ({ kind: 'perRow', column });
export const UNKNOWN: ScalarType = { kind: 'unknown' };

/** The static tag, when there is one — for the consumers that can only act on a
 *  compile-time type (a uniform item tag, a serializer choice). A perRow/unknown type
 *  yields undefined, which those consumers already read as "infer at the wire". */
export const staticTypeOf = (t: ScalarType | undefined): ValueType | undefined =>
  t?.kind === 'static' ? t.type : undefined;

/** The per-row column name, when the type rides in one. */
export const perRowColumnOf = (t: ScalarType | undefined): string | undefined =>
  t?.kind === 'perRow' ? t.column : undefined;

/** The physical columns a type channel adds to a relation: a per-row type needs its column
 *  declared in the stream's projection; static/unknown need none. */
export const perRowCols = (t: ScalarType | undefined): string[] =>
  t?.kind === 'perRow' ? [t.column] : [];

/** One concrete arm in the wire representation of a VariantStream. A variant is
 * a per-row tagged union, so its framing contract records the arms directly rather
 * than encoding them as unrelated optional flags on Shape. Scalar rows are always
 * present as an arm because a missing static tag means `unknown`, not no scalar arm. */
export type VariantShapeArm =
  | { readonly kind: 'scalar'; readonly type: ScalarType }
  | { readonly kind: 'vertex' }
  | { readonly kind: 'edge' }
  | { readonly kind: 'list'; readonly of: ListOf };

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'edge' }
  | { kind: 'property' } // properties(): VertexProperty elements (vpid/owner/pk/pv/pmeta cols)
  | { kind: 'metaProperty' } // properties().properties(): meta-properties as Property elements (mk/mv cols)
  | { kind: 'metaMap' } // properties(k).valueMap(): a VertexProperty's meta as a flat Map (meta col, JSON text)
  // The ONE type channel at the render boundary (`type`), replacing the former `as?` xor
  // `perRowType?` pair — the same two-optionals-plus-implicit-third trap ScalarStream had.
  // perRow → frame each row by its own stored `vtype` column (values() of typed props; a
  // collection vtype frames the stored {t,v} tree via frameStoredValue); static → one tag
  // for every row; unknown → infer from the JS value.
  | { kind: 'value'; type: ScalarType }
  // A per-row tag: null/scalar/vertex/edge/list. `arms` is the complete declared
  // framing vocabulary; `wholeResult` makes cap() wrap all framed rows in one List.
  | { kind: 'variant'; arms: readonly VariantShapeArm[]; wholeResult?: true }
  | { kind: 'scalar'; productiveNull?: boolean } // numeric reducer; productive NULL may be a real result
  | { kind: 'list'; elem: ElemShape | 'scalar'; as?: ValueType } // legacy row-fold; scalar items may carry a uniform type
  // One JSON list value per row. `items` is total: the former `as`/`typed`/`of`
  // flag bag made four encodings look like optional metadata and forced the framer
  // to reconstruct a fifth. `ListOf` already owns the item question.
  | { kind: 'jsonbList'; items: ListOf }
  | { kind: 'jsonbElementList'; elem: Exclude<ElemShape, 'property'> } // one JSON object-array per relational element list
  | { kind: 'jsonbSet'; typed?: boolean }    // a set-VALUE stream (intersect/difference/disjunct OR a stored typed set): one Set per row, from a JSONB `list` column
  // `labelSet` says the `label` column holds a JSON ARRAY of names (the multi-label regime)
  // rather than one name. Carried on the shape because the SQL and the framer must agree, and the
  // regime is a per-traversal decision the framer cannot re-derive.
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean; labelSet?: boolean }
  | { kind: 'elementMap'; keys: string[] | null; labelSet?: boolean }
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

export type WriteResult =
  | { readonly vertex: { readonly id: any; readonly labels: readonly string[]; readonly props: Record<string, ValueNode> } }
  | { readonly edge: { readonly id: any; readonly label: string; readonly src: any; readonly tgt: any; readonly props: Record<string, ValueNode> } };

/** A mutation may continue as a normal read traversal (e.g. `addV(...).label()`). The
 * mutation remains imperative at the storage seam, while its follower is compiled/framed by
 * the ordinary read spine rather than growing a second output vocabulary in write.ts. */
export interface WriteContinuation { shape: Shape; run: (store: GraphStore) => any[]; }
export interface WritePlan { kind: 'write'; run: (store: GraphStore) => WriteResult[]; continuation?: WriteContinuation; }

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
