import type { GraphStore } from '../../storage.ts';
import { q, type Expression, type Query, type Relation } from './q.ts';
import type { ValueNode, ValueType } from '../../gremlin/types.ts';
import type { Elem } from '../../compiler/plan/plan.ts';
import type { Plan as RelPlan } from '../../rel/plan.ts';

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
  // A scalar member has THE SAME total type channel a scalar row has — `static` is one uniform
  // compile-time tag for every member, `perRow` (carrier `envelope`) means the members are
  // self-describing `{t,v}` ValueNodes so each states its own type, `unknown` means infer from the
  // storage class at the wire. It used to be `as?` + `typed?` + an implicit third case: the exact
  // two-optionals-plus-implicit-third trap `ScalarType` was built to end, one layer down, and it
  // cost real answers — `typed` was a CONSTANT `ListOf`, so tagging a list DROPPED `as` and
  // `productiveNull` rather than widening them, and every member op read the raw value because the
  // tag it needed was in a vocabulary it did not share with the row-level one.
  //
  // `productiveNull` is orthogonal to the type and stays its own field: it says whether a NULL
  // reduction over these members is a REAL result (`ProductiveByStrategy`) or the framer's signal
  // to emit nothing. Use `withMemberType` to change one without dropping the other.
  | { kind: 'scalar'; type: ScalarType; productiveNull: boolean }
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
  | { key: string; prefix: string; sub: 'vertex' | 'edge'; nullable: boolean }
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
  | { kind: 'scalar'; productive: boolean; type: ScalarType }
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
  | { render: 'value'; prefix: string; optional: boolean };

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
// This is a COMPILE-TIME property; the physical encoding stays a per-site choice, and the
// CARRIER union below is that choice made TOTAL rather than left to prose. Conflating the type
// with its encoding is what caused the dead end recorded in
// docs/archive/2026-07-25-type-channel-unification.md; leaving the encoding UNNAMED is what let a
// list's member type be spelled as a second, lossier vocabulary (`ListOf`'s former `as?`+`typed?`)
// for as long as it was.
export type ScalarType =
  // `text`: this static scalar is stored as decimal TEXT — an inlined or bound EXACT TAIL
  // (`inject(9.99m)`, a bound big long/Duration) rather than a native REAL/INT (`count()`,
  // `asNumber(BIGDECIMAL)`). The two share a tag (`bigdecimal`/`long`) but not a storage class, so an
  // ordering comparison must cast a `text` subject to its numeric class and leave a native one alone.
  | { kind: 'static'; type: ValueType; text: boolean }   // a cast, a typed literal, count()→long
  | { kind: 'perRow'; carrier: TypeCarrier } // per-value types — the only heterogeneous-safe case
  | { kind: 'unknown' };                  // the JS-client seam; infer from the JS value at framing

/**
 * WHERE a per-row type is physically written down — the encoding, named.
 *
 * A row-preserving relation can put the type in a SIBLING COLUMN, because a relation has columns.
 * A value living inside a JSON blob cannot: a list member has no column of its own, so its type
 * rides in the member itself as a `{t,v}` ENVELOPE, discriminated at read time by `json_each`'s own
 * `type` column. Both are the same COMPILE-TIME fact ("this value states its own type"); only the
 * read differs, so the two must be one `ScalarType` case with two carriers rather than two type
 * vocabularies — the second vocabulary is what silently dropped `productiveNull` and the static tag
 * whenever a list was retyped.
 *
 * The envelope is deliberately UNIFORM PER LIST (`barrier.ts foldMember` / `list.ts withLossyFlag`
 * ask once per relation whether ANY member is lossy under its storage class), because mixing the
 * two encodings inside one list is the corruption that dead end hit.
 */
export type TypeCarrier =
  | { kind: 'column'; name: string }      // a sibling column of the relation (the stored `vtype`)
  | { kind: 'envelope' };                 // a `{t,v}` node inside a JSON blob (a typed list member)

export const STATIC = (type: ValueType, text = false): ScalarType => ({ kind: 'static', type, text });

/** Whether a static scalar is stored as decimal TEXT (an exact tail), so an ordering compare must cast it. */
export const staticIsText = (t: ScalarType | undefined): boolean => t?.kind === 'static' && t.text === true;
export const PER_ROW = (column: string): ScalarType => ({ kind: 'perRow', carrier: { kind: 'column', name: column } });
/** A per-value type carried by the value itself — the encoding a typed list's members use. */
export const PER_ROW_ENVELOPE: ScalarType = { kind: 'perRow', carrier: { kind: 'envelope' } };
export const UNKNOWN: ScalarType = { kind: 'unknown' };

/** The static tag, when there is one — for the consumers that can only act on a
 *  compile-time type (a uniform item tag, a serializer choice). A perRow/unknown type
 *  yields undefined, which those consumers already read as "infer at the wire". */
export const staticTypeOf = (t: ScalarType | undefined): ValueType | undefined =>
  t?.kind === 'static' ? t.type : undefined;

/** The per-row column name, when the type rides in one. An ENVELOPE-carried per-row type has no
 *  column by construction, so it answers `undefined` exactly as `static`/`unknown` do — a caller
 *  that can only read a column is asking "is there a column", not "is the type per-row". */
export const perRowColumnOf = (t: ScalarType | undefined): string | undefined =>
  t?.kind === 'perRow' && t.carrier.kind === 'column' ? t.carrier.name : undefined;

/** Whether the value states its OWN type (either carrier) — the question a reader that can decode
 *  both asks, and the one `perRowColumnOf` deliberately cannot answer. */
export const isPerRow = (t: ScalarType | undefined): boolean => t?.kind === 'perRow';

/** The column a per-row type rides in AT A RELATION BOUNDARY, where an envelope cannot reach: a
 *  relation row has columns, so a scalar row's type is always column-carried, and the envelope
 *  carrier belongs to a value inside a JSON blob. Raising here names the seam rather than reading
 *  `row[undefined]` and framing every value as untyped — a fail-closed invariant, not a decline. */
/** Structural equality over the type channel — the question "do these two streams/members agree?",
 *  asked by every arm merge and every list unification. One authority, because a hand-rolled
 *  comparison that forgets `text` (or a carrier) reports agreement where there is none. */
export const sameScalarType = (a: ScalarType, b: ScalarType): boolean =>
  a.kind !== b.kind ? false
    : a.kind === 'static' ? a.type === (b as typeof a).type && !!a.text === !!(b as typeof a).text
      : a.kind === 'perRow' ? a.carrier.kind === (b as typeof a).carrier.kind
        && perRowColumnOf(a) === perRowColumnOf(b)
        : true;

/**
 * The strongest type a relation can HONOUR — a column-carried per-row type whose column the
 * relation does not declare degrades to `unknown` rather than claiming a column that is not there.
 *
 * The rule `assertStreamColumns` caught during the original unification ("a merge that cannot carry
 * a per-row type must degrade EXPLICITLY"), stated once instead of re-spelled at each narrowing
 * projection. Three sites narrow this way — the global `fold`, a projected collection, and
 * `aggregate().by(traversal)`'s `first` window — and each had its own inline ternary, which is how
 * the `static` case's `text` flag came to be dropped at two of them.
 */
export const typeCarriedBy = (t: ScalarType, carries: (column: string) => boolean): ScalarType => {
  const column = perRowColumnOf(t);
  return column === undefined || carries(column) ? t : UNKNOWN;
};

export const perRowColumn = (t: ScalarType, at: string): string => {
  const column = perRowColumnOf(t);
  if (column === undefined) throw new Error(`${at}: a per-row type carried by an envelope has no relation column`);
  return column;
};

/** The physical columns a type channel adds to a relation: a column-carried per-row type needs its
 *  column declared in the stream's projection; an envelope, static and unknown need none. */
export const perRowCols = (t: ScalarType | undefined): string[] => {
  const column = perRowColumnOf(t);
  return column === undefined ? [] : [column];
};

// ---------- the same channel, one layer down: a LIST's members ----------

/** A scalar-membered list whose members carry no tag — the type is whatever the storage class
 *  says at the wire. The old `{ kind: 'scalar' }` with every optional absent. */
export const SCALAR_MEMBERS: ListOf = { kind: 'scalar', type: UNKNOWN, productiveNull: false };

/** A scalar-membered list whose members are self-describing `{t,v}` nodes. The old `TYPED_LIST`
 *  constant — but reached through `withMemberType` wherever an existing list is being re-tagged,
 *  because assigning the constant is exactly how `productiveNull` used to be lost. */
export const TYPED_MEMBERS: ListOf = { kind: 'scalar', type: PER_ROW_ENVELOPE, productiveNull: false };

/** Re-tag a list's members, PRESERVING everything the tag is not — the named preserving rebuild
 *  that makes "assign a constant `ListOf` and silently drop its other fields" unexpressible. A
 *  non-scalar list has no member tag to change and passes through. */
export const withMemberType = (of: ListOf, type: ScalarType): ListOf =>
  of.kind === 'scalar' ? { ...of, type } : of;

/** The member type of a scalar-membered list; `undefined` for element/property/nested lists, whose
 *  members are not scalars at all. */
export const memberTypeOf = (of: ListOf): ScalarType | undefined =>
  of.kind === 'scalar' ? of.type : undefined;

/** Are this list's members self-describing `{t,v}` envelopes? The one question every member READ
 *  asks, so it is stated once rather than re-derived from the carrier at each site. */
export const hasTypedMembers = (of: ListOf): boolean =>
  of.kind === 'scalar' && of.type.kind === 'perRow' && of.type.carrier.kind === 'envelope';

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
  | { kind: 'variant'; arms: readonly VariantShapeArm[]; wholeResult: boolean }
  | { kind: 'scalar'; productiveNull: boolean } // numeric reducer; productive NULL may be a real result
  // The legacy ROW-fold: one List per result, built from the RESULT ROWS rather than from a JSON
  // column (that is `jsonbList`). Elements only — its single producer (`projection.ts` `compileFold`)
  // throws for every other projection shape, so the `'scalar'` item arm and the `as?` tag it carried
  // were UNREACHABLE, and with them a whole framer branch. A fifth encoding that looked like optional
  // metadata, which is exactly what `ListOf` was made total to stop.
  | { kind: 'list'; elem: Exclude<ElemShape, 'property'> }
  // One JSON list value per row. `items` is total: the former `as`/`typed`/`of`
  // flag bag made four encodings look like optional metadata and forced the framer
  // to reconstruct a fifth. `ListOf` already owns the item question.
  | { kind: 'jsonbList'; items: ListOf }
  | { kind: 'jsonbPath'; items: ListOf } // one JSONB array of positions per row → one GraphBinary Path
  | { kind: 'jsonbElementList'; elem: Exclude<ElemShape, 'property'> } // one JSON object-array per relational element list
  // A set-VALUE stream (intersect/difference/disjunct OR a stored typed set): one Set per row, from
  // a JSONB `list` column. `items` is the SAME total member descriptor `jsonbList` carries — it was a
  // `typed?: boolean`, which is the last of the four flag-bag spellings and the only one that could
  // not say a set's members share one STATIC type.
  | { kind: 'jsonbSet'; items: ListOf }
  // `labelSet` says the `label` column holds a JSON ARRAY of names (the multi-label regime)
  // rather than one name. Carried on the shape because the SQL and the framer must agree, and the
  // regime is a per-traversal decision the framer cannot re-derive.
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean; labelSet: boolean }
  | { kind: 'elementMap'; keys: string[] | null; labelSet: boolean }
  | { kind: 'map'; entries: MapEntry[] }
  | { kind: 'mapValue' } // one whole map VALUE per row: a `map` JSONB column [[keyNode,valNode],…] with self-describing {t,v} scalar sides → one GraphBinary MAP (frameTypedNode)
  | { kind: 'mapEntry'; keyOf: MapOf; valOf: MapOf } // one Map.Entry per row (a MapStream unfold) → each frames as a size-1 GraphBinary MAP
  | { kind: 'group'; key: GroupKey; val: GroupVal }
  | { kind: 'path'; positions: PathPos[] }                 // linear: one row per path, per-position columns
  | { kind: 'pathGrouped'; elem: ElemShape; byKey: boolean } // recursive: N rows per path (pk, ord, element|value), grouped
  | { kind: 'discard' };

/** Which lowering produced a compile. There are two only while the RelIR migration runs, and
 *  `legacy` is scheduled for deletion with the spine it names (§10·4 — the dual spine is a harness
 *  with an end date). It is a compile FACT, not a flag: the coverage ratchet reads it, and so does
 *  anyone asking why a traversal's SQL looks the way it does. */
export type Spine = 'legacy' | 'rel';

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
  spine: Spine;
}

/**
 * A compiled traversal WITH EFFECTS — RelIR's §3.0 program: an ordered list of bindings the executor
 * runs, statements and retained reads alike, ending in the rows to frame.
 *
 * It sits beside `Compiled` rather than inside it because the difference is real — a read is ONE
 * statement and this is several — and beside `WritePlan` rather than replacing it because the two
 * say opposite things about where the traversal machine lives: a `WritePlan` is a JS closure that
 * walks drivers and calls the store, while this is DATA the algebra produced and one executor runs.
 * `WritePlan` is on §8's deletion list; this is what replaces it.
 *
 * `shape` is the framing contract exactly as a read's is, so the wire layer needs no write vocabulary.
 */
export interface Program {
  kind: 'program';
  program: RelPlan;
  /** The FRAMING read, composed above RelIR and run last — absent when the traversal produces no
   *  traverser at all (`drop()`), where the program's own last statement is the result. Its binds
   *  may hold a `RowsBind` marker, which the executor fills with the rows it retained. */
  tail?: { sql: string; binds: any[] };
  shape: Shape;
  spine: Spine;
}

/** What `compile()` hands back: one statement, a program, or the legacy write closure. */
export type Executable = Compiled | Program | WritePlan;

export type WriteResult =
  // A vertex's props are multi-valued per key (cardinality list/set); an EDGE's are not — TinkerPop's
  // edge `Property` is single by spec. The asymmetry is the schema's, so the type carries it.
  | { readonly vertex: { readonly id: any; readonly labels: readonly string[]; readonly props: Record<string, ValueNode[]> } }
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
  // Every caller of this boundary IS the legacy spine; the RelIR route composes its relation into
  // the same framing and re-stamps the field. So the default is a statement about who is here, not
  // an unknown.
  return { kind: 'read', sql, binds, shape, spine: 'legacy' };
}

/** Render `SELECT <cols> FROM <current id-relation>` over a Query's CTE prefix to
 *  {sql,binds}. The write paths materialize target ids this way before mutating. */
export function renderFrom(query: Query, last: Relation, cols: string = 'id'): { sql: string; binds: any[] } {
  return query.render(q`SELECT ${cols} FROM ${last}`);
}
