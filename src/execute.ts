import type { Executor as ExecutorApi, ForeignRow } from './api.ts';
import { DEFAULT_VERTEX_LABEL } from './api.ts';
import { compilePlan, hasTypedMembers, perRowColumn, perRowColumnOf, staticTypeOf, type Compiled, type ElemShape, type Executable, type FastPathConfig, type GroupKey, type GroupVal, type ListOf, type MapEntry, type MapOf, type PathPos, type ScalarType, type ValueType } from './compiler/compiler.ts';
import type { FederationSource, Plan } from './compiler/segment.ts';
import { hasSerializer, isCollectionType, valueNodeFromStored, type FrameNode, type TypeNode, type ValueNode } from './gremlin/types.ts';
import { direction, ioc, Property, t, VertexProperty } from './io.ts';
import { createAppScope, type AppScope, type RegistryProvider } from './scopes.ts';
import type { IoStore } from './iostore.ts';
import { runProgram } from './program.ts';
import type { Spine } from './sql/kernel/render.ts';
import type { GraphStore } from './storage.ts';

// ---- GraphBinary v4 result framing ----
// This module is CONCERN B — execute + frame. `executeQuery` compiles a traversal,
// runs it against the store, and returns the ONE-per-result GraphBinary value
// buffers as a materialized array. It carries NO HTTP notion: the response frame
// (HEADER | value* | trailer) and its chunk pacing live in http.ts (concern C);
// wire parsing lives in wire.ts (concern A). The store tier (Bun in-process / a
// Durable Object) runs THIS; the edge does A and C. The row array is fully drained
// by store.query() regardless (a DO SQLite cursor can't cross awaits), so returning
// an array rather than a lazy generator costs no extra floor — it just moves the
// (already unavoidable) materialization behind the manager seam honestly.

// Custom vertex framing to MATERIALIZE properties. The client's
// VertexSerializer.serialize() hardcodes an empty property list (the client
// never sends props), so routing a Vertex through anySerializer drops them.
// We frame the vertex from ioc primitives instead — its deserialize side reads
// properties fine. Per-property framing (id/label/value) is left to
// VertexPropertySerializer via the qualified list, which serializes correctly.
// props is {key: [value, …]} — one VertexProperty per value (multi-property). The id
// is synthetic (owner.ordinal); scenarios compare on key+value+owner, not this id.
// props is {key: [{t,v}, …]} — each value a self-describing typed node (plan.ts
// propNodeExpr). We hand-roll every VertexProperty (value via frameTypedNode → its EXACT
// GraphBinary type) instead of routing through the client's VertexPropertySerializer, which
// re-infers the value type from its JS runtime value (the #5 bug).
function vertexBuffer(id: number, labels: readonly string[], props: Record<string, ValueNode[]>): Buffer {
  let pid = 0;
  const vprops: Buffer[] = [];
  for (const [k, nodes] of Object.entries(props))
    for (const node of nodes) vprops.push(vertexPropertyBuffer(`${id}.${pid++}`, k, frameTypedNode(node), null));
  return Buffer.concat([
    Buffer.from([ioc.DataType.VERTEX, 0x00]),
    ioc.anySerializer.serialize(id),                 // {id}, fully qualified
    ioc.listSerializer.serialize([...labels], false), // {label}: a bare list of EVERY label
    listBuffer(vprops),                               // {properties}: qualified LIST of hand-framed VertexProperty
  ]);
}

/** A vertex's label PAYLOAD → its label list. Every producer emits ALL of a vertex's labels
 *  (`labelPayloadFor`, plan.ts), because GraphBinary's `{label}` field IS a list and the client
 *  reads all of it — `VertexSerializer.deserializeValue` keeps `labels` and derives `.label` from
 *  `labels[0]`.
 *
 *  TWO producer forms, both deterministic, neither sniffed: a relation COLUMN arrives as JSON
 *  TEXT (SQLite's JSON subtype does not survive the value boundary), while a member of a
 *  `json_object` payload (a materialized list item, a Map.Entry side) arrives ALREADY PARSED as an
 *  array, because `elementPayloadObject` pins the subtype with `json()` so it nests. Anything else
 *  throws here rather than silently framing a one-label vertex. */
const labelsOf = (payload: string | string[]): string[] => Array.isArray(payload) ? payload : JSON.parse(payload);

/** The two label fields a detached VERTEX carries across a federated hop, from the one payload
 *  column: `labels` is the set the far side frames, `label` the scalar pick `Element.label()`
 *  promises and the mid-traversal rejoin matches on. A zero-label vertex reports the default name
 *  rather than `undefined` — the same fallback the write path applies. */
const foreignLabels = (payload: string) => {
  const labels = labelsOf(payload);
  return { label: labels[0] ?? DEFAULT_VERTEX_LABEL, labels };
};

// Custom edge framing to MATERIALIZE properties — EdgeSerializer.serialize
// hardcodes an empty property list, exactly like VertexSerializer. Wire layout
// (mirrors EdgeSerializer): id, {label} bare list, inV(=tgt) id + bare label
// list, outV(=src) id + bare label list, null parent, qualified property list.
// Endpoint labels ride empty (as the addE write path does); readers that need
// endpoint names traverse for them rather than read the embedded edge element.
// props is {key: {t,v}} — one typed node per key (edge Property is single). Each Property
// is hand-rolled (value via frameTypedNode) so its GraphBinary type is exact, bypassing the
// client's PropertySerializer value-inference.
function edgeBuffer(id: number, label: string, src: number, tgt: number, props: Record<string, ValueNode>): Buffer {
  const eprops = Object.entries(props).map(([k, node]) => propertyFrame(k, frameTypedNode(node)));
  return Buffer.concat([
    Buffer.from([ioc.DataType.EDGE, 0x00]),
    ioc.anySerializer.serialize(id),
    ioc.listSerializer.serialize([label], false),
    ioc.anySerializer.serialize(tgt),          // inV id
    ioc.listSerializer.serialize([], false),   // inV label (omitted)
    ioc.anySerializer.serialize(src),          // outV id
    ioc.listSerializer.serialize([], false),   // outV label (omitted)
    ioc.unspecifiedNullSerializer.serialize(null), // parent
    listBuffer(eprops),                             // properties: qualified LIST of hand-framed Property
  ]);
}

// A GraphBinary Property (fq) with a PRE-FRAMED value buffer — mirrors the client
// PropertySerializer layout ([PROPERTY,0x00], {key} bare string, {value} fq, {parent} null)
// but takes an already-typed value so a typed/collection edge-property value frames exactly.
function propertyFrame(key: string, valueBuf: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([ioc.DataType.PROPERTY, 0x00]),
    ioc.stringSerializer.serialize(key, false),
    valueBuf,
    ioc.unspecifiedNullSerializer.serialize(null),
  ]);
}

// properties(): a standalone VertexProperty element per (owner, key, value) row.
// Synthetic id (owner:key) — used by the group/select element paths that don't carry
// a real vpid or meta.
function propertyBuffer(owner: number, key: string, value: any): Buffer {
  return ioc.anySerializer.serialize(new VertexProperty(`${owner}:${key}`, key, value, []));
}

// A VertexProperty WITH its meta-properties, hand-framed — the client's
// VertexPropertySerializer.serialize() hardcodes an empty {properties} list (same bug
// as Vertex/Edge), so routing through anySerializer would drop the meta. Layout mirrors
// VertexPropertySerializer: id, {label}=[key] bare, value, null parent, qualified meta
// list. `Property`'s own serializer is not buggy, so meta items frame via listSerializer.
function vertexPropertyBuffer(id: any, key: string, valueBuf: Buffer, meta: Record<string, any> | null): Buffer {
  const metaProps = meta ? Object.entries(meta).map(([k, v]) => new Property(k, v)) : [];
  return Buffer.concat([
    Buffer.from([ioc.DataType.VERTEXPROPERTY, 0x00]),
    ioc.anySerializer.serialize(id),
    ioc.listSerializer.serialize([key], false),
    valueBuf,                                       // PRE-FRAMED (typed): its GraphBinary type is exact
    ioc.unspecifiedNullSerializer.serialize(null), // parent
    ioc.listSerializer.serialize(metaProps, true), // {properties} = meta, qualified
  ]);
}

// valueMap()/valueMap(true)/valueMap(keys...): Map<key, [values]>; with tokens,
// prepend the T.id/T.label entries (T tokens ride as GraphBinary DataType.T).
// props is {key:[values]} (multi-valued). valueMap → Map<key, [values]>; with tokens,
// prepend the T.id/T.label entries (T tokens ride as GraphBinary DataType.T).
// props is {key: [{t,v}, …]}. Hand-roll the MAP so each property value's List frames
// through frameTypedNode (exact element types) instead of the client's MapSerializer →
// listSerializer inferring them. Token entries (T.id/T.label) frame via anySerializer
// (an EnumValue rides as DataType.T; id/label are plain int/string).
function mapFromEntries(pairs: [Buffer, Buffer][]): Buffer {
  const parts: Buffer[] = [Buffer.from([ioc.DataType.MAP, 0x00]), ioc.intSerializer.serialize(pairs.length, false)];
  for (const [k, v] of pairs) { parts.push(k, v); }
  return Buffer.concat(parts);
}
/** The `T.label` value of a map shape. Under the MULTI-LABEL regime the `label` column carries a
 *  JSON array of every name and frames as a GraphBinary SET (`s[animal,bird,…]`); under the
 *  single-label regime it is one name and frames as a plain string. The regime rides on the Shape
 *  because SQL and framer must agree and the framer cannot re-derive it. */
function labelTokenBuffer(label: string, labelSet: boolean): Buffer {
  if (!labelSet) return ioc.anySerializer.serialize(label);
  return setBuffer((JSON.parse(label) as string[]).map((n) => ioc.anySerializer.serialize(n)));
}

function valueMapBuffer(id: number, label: string, props: Record<string, ValueNode[]>,
                        keys: string[] | null, tokens: boolean, labelSet = false): Buffer {
  const pairs: [Buffer, Buffer][] = [];
  if (tokens) { pairs.push([ioc.anySerializer.serialize(t.id), ioc.anySerializer.serialize(id)]); pairs.push([ioc.anySerializer.serialize(t.label), labelTokenBuffer(label, labelSet)]); }
  for (const key of keys ?? Object.keys(props)) if (key in props)
    pairs.push([ioc.anySerializer.serialize(key), listBuffer(props[key].map(frameTypedNode))]);
  return mapFromEntries(pairs);
}

// elementMap(): flat Map with ONE value per key (first under multi); id/label tokens
// are ALWAYS present. The single value frames typed via frameTypedNode.
function elementMapBuffer(id: number, label: string, props: Record<string, ValueNode[]>,
                          keys: string[] | null, labelSet = false): Buffer {
  const pairs: [Buffer, Buffer][] = [
    [ioc.anySerializer.serialize(t.id), ioc.anySerializer.serialize(id)],
    [ioc.anySerializer.serialize(t.label), labelTokenBuffer(label, labelSet)],
  ];
  for (const key of keys ?? Object.keys(props)) if (key in props)
    pairs.push([ioc.anySerializer.serialize(key), frameTypedNode(props[key][0])]);
  return mapFromEntries(pairs);
}

// select(labels…)/project(keys…): one GraphBinary Map per row. Framed by hand
// (not via anySerializer on a JS Map) because vertex-valued entries must go
// through vertexBuffer — routing a Vertex through anySerializer drops its props
// (the same client-serializer bug vertexBuffer exists to work around). Layout
// mirrors MapSerializer: [MAP, 0x00], bare int32 count, then key/value pairs
// where each value is an already-fully-qualified buffer.
function mapBuffer(row: any, entries: MapEntry[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([ioc.DataType.MAP, 0x00]),
    ioc.intSerializer.serialize(entries.length, false),
  ];
  for (const e of entries) {
    parts.push(ioc.anySerializer.serialize(e.key));
    parts.push(e.sub === 'value'
      ? recordValueBuffer(row, e.prefix, e.type)
      : e.sub === 'list'
        ? listFieldBuffer(row[`${e.prefix}_list`], e.of)
        : e.nullable && row[`${e.prefix}_id`] === null
          ? frameValue(null, undefined)
          : elementBuffer(row, e.prefix, e.sub));
  }
  return Buffer.concat(parts);
}

/** Frame a scalar field from its declared record channel. Unlike a bare JS value,
 * a stored UUID/date/long needs its sibling vtype to avoid storage-class inference. */
function recordValueBuffer(row: any, prefix: string, type: ScalarType): Buffer {
  const v = row[`${prefix}_v`];
  if (type.kind !== 'perRow') return frameValue(v, staticTypeOf(type));
  const vtype = row[perRowColumn(type, 'recordValueBuffer')];
  return isCollectionType(vtype) ? frameStoredValue(v, vtype) : frameValue(v, vtypeToValueType(vtype));
}

// One side (key/value) of a Map.Entry row → a fully-qualified GraphBinary buffer, per
// its MapOf shape. A TYPED scalar arrives as a self-describing {t,v} node (JSON text) and
// frames via frameTypedNode (each entry its own exact type — stored heterogeneous maps); a
// bare scalar frames by its uniform tag (or infers); an element arrives as a JSON object
// string (SQL elementValueResult) → vertexBuffer/edgeBuffer to keep props; a list via frameListOf.
function mapSideBuffer(raw: any, of: MapOf): Buffer {
  if (of.kind === 'elem') return raw == null ? frameValue(null, undefined) : (of.elem === 'edge' ? rowEdge : rowVertex)(JSON.parse(raw));
  if (of.kind === 'list') return frameListOf(raw, of.of);
  // scalar: always a self-describing {t,v} node (JSON text) → frame each its own exact type.
  return frameTypedNode(raw == null ? null : (typeof raw === 'string' ? JSON.parse(raw) : raw));
}

// A Map.Entry (group()/valueMap()/is(typeOf(MAP)).unfold()) frames as a one-entry MAP —
// the settled GraphBinary v4 wire form (TinkerPop MapEntrySerializer transforms an entry
// into a size-1 Map; TINKERPOP-3104). key/value each frame by their MapOf.
function mapEntryBuffer(row: any, keyOf: MapOf, valOf: MapOf): Buffer {
  return mapFromEntries([[mapSideBuffer(row.mk, keyOf), mapSideBuffer(row.mv, valOf)]]);
}

function listFieldBuffer(json: string, of: import('./sql/kernel/render.ts').ListOf): Buffer {
  const items = JSON.parse(json);
  if (of.kind === 'elem') return listBuffer(items.map(of.elem === 'edge' ? rowEdge : rowVertex));
  if (of.kind === 'property') return listBuffer(items.map(framePropertyRow));
  return ioc.listSerializer.serialize(items);
}

// A GraphBinary LIST framed by hand (mirrors ArraySerializer) so element items
// go through vertexBuffer/edgeBuffer — routing them via listSerializer→
// anySerializer would drop their props (same client-serializer bug).
function listBuffer(items: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([ioc.DataType.LIST, 0x00]),
    ioc.intSerializer.serialize(items.length, false),
    ...items,
  ]);
}

// A GraphBinary SET framed by hand (same layout as LIST, DataType.SET) so its items go
// through the typed framer instead of the client's element-type-inferring SetSerializer.
function setBuffer(items: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([ioc.DataType.SET, 0x00]),
    ioc.intSerializer.serialize(items.length, false),
    ...items,
  ]);
}

// ---- the unified typed-value framer (self-describing collection values) ----
//
// A stored collection value is a self-describing {t,v} tree (gremlin-types.valueNodeOf).
// frameTypedNode frames ANY node — a container recurses through listBuffer/setBuffer/a
// hand-rolled MAP; a leaf reuses the SAME scalar table as frameValue (vtypeToValueType(t)),
// so a nested long/uuid/datetime/bigdecimal/char/duration frames EXACTLY (no client
// JS-type inference — the bug this replaces). frameStoredValue is the entry from a raw
// (value, vtype) column pair: a scalar frames straight; a collection JSON.parses the bare
// top `v` (the vtype column names the outer shape) and frames the reconstructed node.

function frameTypedNode(node: FrameNode): Buffer {
  if (node == null) return frameValue(null, undefined);
  // A BARE member: the producer omitted the envelope because the storage class already
  // determines the type (a fold whose members are all string/int/long/double — see
  // barrier.ts foldMember). Infer from the JS value, which is exactly what the envelope
  // would have encoded. A node is always an OBJECT, so a primitive is unambiguous.
  if (typeof node !== 'object') return frameValue(node, undefined);
  // A BARE ARRAY is a list whose members are themselves bare — the same principle as the bare
  // member above, one level up: the producer omitted the {t:'list'} envelope because being an array
  // already determines the type. This is what lets a map blob keep ONE encoding: a valueMap-derived
  // map's value side is a naked array of property values (the untyped list substrate's contract),
  // and it now frames without the blob being rebuilt into a typed tree first.
  if (Array.isArray(node)) return listBuffer(node.map(frameTypedNode));
  if (node.t === 'list') return listBuffer((node.v as FrameNode[]).map(frameTypedNode));
  if (node.t === 'set') return setBuffer((node.v as FrameNode[]).map(frameTypedNode));
  if (node.t === 'map') return typedMapBuffer(node.v as [FrameNode, FrameNode][]);
  // An ELEMENT member — `v` is the public payload the SQL side already expanded, so this is the same
  // `rowVertex`/`rowEdge` the top-level element shapes use. It is one arm rather than a descriptor at
  // every container for the reason the bare-array arm above is: the tree is SELF-DESCRIBING, so a list
  // of elements, a map whose value is a list of elements and an element map key all frame by this one
  // rule at a different depth. The alternative is a `MapOf`/`ListOf` `elem` tag threaded to every
  // position, which is how a payload tuple ends up spelled at fourteen sites.
  if (node.t === 'vertex') return rowVertex(node.v);
  if (node.t === 'edge') return rowEdge(node.v);
  // A `T` TOKEN, which is a GraphBinary type of its own rather than the string it prints as — a
  // `valueMap(true)`/`elementMap()` key. One arm here, so a token composes at every depth the tree
  // reaches (a map key today; a list member or a nested map's key the day one produces it) exactly
  // as the element arm above does.
  if (node.t === 'T') return ioc.anySerializer.serialize(t[node.v]);
  // A `Direction` token, the same standing as `T` one enum along — an edge `elementMap()`'s two
  // endpoint entries are keyed by it, and it is a GraphBinary type of its own (`DataType.DIRECTION`).
  if (node.t === 'D') return ioc.anySerializer.serialize(direction[node.v === 'IN' ? 'in' : 'out']);
  return frameValue(node.v, vtypeToValueType(node.t));
}

// A GraphBinary MAP from ordered typed [key, value] node pairs — keys AND values framed
// by the typed framer (so a non-string / typed key rides its true type). Layout mirrors
// mapBuffer: [MAP, 0x00], bare int32 count, then key/value fully-qualified buffers.
function typedMapBuffer(pairs: [FrameNode, FrameNode][]): Buffer {
  const parts: Buffer[] = [Buffer.from([ioc.DataType.MAP, 0x00]), ioc.intSerializer.serialize(pairs.length, false)];
  for (const [k, v] of pairs) { parts.push(frameTypedNode(k), frameTypedNode(v)); }
  return Buffer.concat(parts);
}

// Frame a stored (value, vtype) column pair: reconstruct its ValueNode (the one rule, in
// gremlin-types) and frame the tree — a scalar leaf routes to frameValue via frameTypedNode.
const frameStoredValue = (raw: any, vtype: string | null): Buffer => frameTypedNode(valueNodeFromStored(raw, vtype));

// Frame one VertexProperty from a property-payload row ({vpid,owner,pk,pv,pvtype,pmeta}) —
// shared by the top-level property stream and the two list-of-property paths. Edge Property
// has no vpid → synthesise `owner:pk`. pmeta may arrive as a JSON string (list paths) or an
// already-parsed object (row path); normalise both.
const framePropertyRow = (x: any): Buffer =>
  vertexPropertyBuffer(
    x.vpid ?? `${x.owner}:${x.pk}`, x.pk, frameStoredValue(x.pv, x.pvtype ?? null),
    x.pmeta ? (typeof x.pmeta === 'string' ? JSON.parse(x.pmeta) : x.pmeta) : null,
  );

// Frame a vertex/edge from a plain (unprefixed) result row — the id/label/props
// (+ src/tgt) projection the vertex/edge/list shapes share.
const propsOf = (props: any): Record<string, any> => typeof props === 'string' ? JSON.parse(props) : props;
const rowVertex = (r: any): Buffer => vertexBuffer(r.id, labelsOf(r.label), propsOf(r.props));
const rowEdge = (r: any): Buffer => edgeBuffer(r.id, r.label, r.src, r.tgt, propsOf(r.props));

// Frame one element (vertex/edge/property) from prefixed columns (k_* / v_*).
function elementBuffer(r: any, prefix: string, elem: ElemShape): Buffer {
  if (elem === 'edge') return edgeBuffer(r[`${prefix}_id`], r[`${prefix}_label`], r[`${prefix}_src`], r[`${prefix}_tgt`], JSON.parse(r[`${prefix}_props`]));
  if (elem === 'property') return propertyBuffer(r[`${prefix}_owner`], r[`${prefix}_pk`], r[`${prefix}_pv`]);
  return vertexBuffer(r[`${prefix}_id`], labelsOf(r[`${prefix}_label`]), JSON.parse(r[`${prefix}_props`]));
}

// path(): one GraphBinary Path per row (mirrors PathSerializer). {objects} is
// hand-framed via listBuffer so element positions go through vertexBuffer/edgeBuffer
// (routing them via anySerializer would drop props — the same client bug). {labels}
// rides as one empty Set per position (labels-on-path deferred); it's plain data
// (empty Sets), so listSerializer handles it directly.
function framePath(objects: Buffer[]): Buffer {
  const labels = objects.map(() => new Set<string>()); // labels-on-path deferred → one empty Set per object
  return Buffer.concat([
    Buffer.from([ioc.DataType.PATH, 0x00]),
    ioc.listSerializer.serialize(labels), // {labels}: List<Set<String>>
    listBuffer(objects),                  // {objects}: List of framed, fully-qualified values
  ]);
}

// Linear path(): one row → one Path, positions framed from per-position columns. A
// branch-padded position (a shorter arm's trailing NULL) has a null id column → omit it,
// so a short-arm path is genuinely shorter (a pure-linear path is never null here, so
// this skip is a no-op there).
function pathBuffer(r: any, positions: PathPos[]): Buffer {
  const objs: Buffer[] = [];
  for (const pos of positions) {
    if (pos.render === 'element') {
      if (r[`${pos.prefix}_id`] == null) continue;
      objs.push(elementBuffer(r, pos.prefix, pos.elem));
    } else {
      // A padded position of a branched path is ABSENT, not null-valued — its presence column
      // says so (a by() value that is genuinely missing dropped the whole path back in SQL).
      if (pos.optional && r[`${pos.prefix}_at`] == null) continue;
      objs.push(ioc.anySerializer.serialize(r[`${pos.prefix}_v`]));
    }
  }
  return framePath(objs);
}

// Recursive repeat().path(): rows arrive ORDER BY (pk, ord) — one row per path
// element, runs of equal pk being one path. Fold each pk-run into a Path.
function pathGroupedBuffers(rows: any[], elem: ElemShape, byKey?: boolean): Buffer[] {
  // by(key) projects each position to a scalar value (column `v`); otherwise each
  // position is the whole element framed from its row.
  const frame = byKey ? (r: any) => ioc.anySerializer.serialize(r.v) : elem === 'edge' ? rowEdge : rowVertex;
  const out: Buffer[] = [];
  let objs: Buffer[] = [];
  let curPk: any;
  for (const r of rows) {
    if (r.pk !== curPk) { if (objs.length) out.push(framePath(objs)); objs = []; curPk = r.pk; }
    objs.push(frame(r));
  }
  if (objs.length) out.push(framePath(objs));
  return out;
}

// A summed numeric, framed to match SQLite's storage class of the SUM (passed as
// typeof(): 'real' → Double even when whole, e.g. 1.0; 'integer' → Int/Long by
// magnitude via NumberSerializationStrategy). Mirrors TinkerPop sum() typing —
// int props sum to Int/Long (d[123].i), double props to Double (d[1.0].d).
function sumBuffer(v: number, storageClass: string): Buffer {
  return storageClass === 'real' ? ioc.doubleSerializer.serialize(v, true) : ioc.anySerializer.serialize(v);
}

// count()/groupCount() results are Java Longs → GraphBinary Int64 (0x02), which the client decodes
// to a JS Number for safe-range values (what TinkerPop emits and the conformance harness's
// parseFloat expects). Passing a JS bigint to anySerializer instead selects BigInteger (0x23 →
// decodes to a JS BigInt), which mismatches every `d[n].l` count assertion — so frame counts
// explicitly as Int64. (sumBuffer passes a plain Number, so anySerializer already picks Int/Long
// by magnitude there; only the BigInt-carrying count sites need this.)
const countBuffer = (v: any): Buffer => ioc.longSerializer.serialize(BigInt(v), true);

// A scalar value(), framed by its compile-time type tag (Shape `as`) when set — the
// GraphBinary type comes from the producing step, not the SQLite storage class. No
// tag → infer from the JS value (anySerializer). 'bool': SQLite carries the boolean
// as 0/1, so frame Boolean(v) explicitly (anySerializer would otherwise emit Int).
// A stored canonical vtype IS the framing tag (one vocabulary). uuid frames via
// uuidSerializer (storage-ambiguous with string, so the stored vtype disambiguates);
// string via stringSerializer. list/map/set are deliberately absent: a stored
// collection value is a JSONB blob, reached through is(typeOf(LIST))→ListStream (which
// json()s it in SQL and frames via the list substrate), never this per-row scalar tag.
// bigdecimal/char/duration frame from their stored canonical TEXT via our serializers.
// Our three hand-rolled serializers (serializers.ts, registered onto ioc by io.ts). Each
// serialize() accepts the stored canonical TEXT (BigDecimal.from / Duration.from / a
// 1-char string) → the exact GraphBinary value, no precision lost through a JS number.
const serializers = ioc.serializers as Record<number, { serialize(v: any, fq?: boolean): Buffer }>;
const bigDecimalSerializer = serializers[ioc.DataType.BIGDECIMAL];
const durationSerializer = serializers[ioc.DataType.DURATION];
const charSerializer = serializers[ioc.DataType.CHAR];
// A stored canonical vtype IS a ValueType unless it names a collection — those are JSONB blobs
// reached through the list/map substrate, and `undefined` here means "infer from the JS value".
// hasSerializer also rejects an unrecognized name, so a corrupt vtype degrades to inference
// rather than falling off frameValue's non-exhaustive switch and returning an empty Buffer.
const vtypeToValueType = (vt: string | null): ValueType | undefined =>
  vt && !isCollectionType(vt) && hasSerializer(vt) ? (vt as ValueType) : undefined;

function frameValue(v: any, as: ValueType | undefined): Buffer {
  switch (as) {
    case undefined: return ioc.anySerializer.serialize(v);
    case 'boolean': return ioc.booleanSerializer.serialize(Boolean(v), true);
    case 'byte': return ioc.byteSerializer.serialize(Number(v), true);
    case 'short': return ioc.shortSerializer.serialize(Number(v), true);
    case 'int': return ioc.intSerializer.serialize(Number(v), true);
    // Long/BigInteger take a BigInt; SQLite hands back a JS number (or bigint) for
    // the reachable magnitudes — coerce through BigInt either way.
    case 'long': return ioc.longSerializer.serialize(BigInt(v), true);
    case 'bigint': return ioc.bigIntegerSerializer.serialize(BigInt(v), true);
    case 'float': return ioc.floatSerializer.serialize(Number(v), true);
    case 'double': return ioc.doubleSerializer.serialize(Number(v), true);
    // Datetime is carried as epoch-millis (INTEGER); the client's DateTimeSerializer
    // takes a JS Date (GraphBinary DATETIME 0x04, UTC wire), so reconstruct it here.
    case 'datetime': return ioc.dateTimeSerializer.serialize(new Date(Number(v)), true);
    // A stored TEXT value framed by its true type: uuid via UuidSerializer (16-byte
    // GraphBinary UUID from the string), string explicitly (anySerializer would also
    // pick String, but the stored vtype lets uuid win over a look-alike string).
    case 'string': return ioc.stringSerializer.serialize(String(v), true);
    case 'uuid': return ioc.uuidSerializer.serialize(String(v), true);
    // The exact tail: the value is a stored canonical TEXT string. serialize() parses it
    // (BigDecimal.fromText / Duration total-nanos / 1-codepoint char) → exact GraphBinary.
    case 'bigdecimal': return bigDecimalSerializer.serialize(String(v), true);
    case 'duration': return durationSerializer.serialize(String(v), true);
    case 'char': return charSerializer.serialize(String(v), true);
  }
}

// Frame one JSON list value by its item shape — shared by the list-VALUE shapes and a
// variant's list (vk=4) arm. Element items arrive as {id,label,props[,src,tgt]} objects
// (rowids already expanded to public payloads in SQL); scalars frame by their tag or infer.
function listItemBuffers(json: string, of: ListOf): Buffer[] {
  const items = JSON.parse(json);
  if (of.kind === 'elem') return items.map(of.elem === 'edge' ? rowEdge : rowVertex);
  if (of.kind === 'property') return items.map(framePropertyRow);
  if (of.kind === 'scalar') {
    // The member type channel, read exactly as a scalar ROW's is: an envelope-carried per-row type
    // means each member is a self-describing {t,v} node, a static tag applies to every member, and
    // an unknown type infers from the JS value (correct for the storage-class-determined three).
    const as = staticTypeOf(of.type);
    return hasTypedMembers(of) ? items.map(frameTypedNode)
      : as ? items.map((x: any) => frameValue(x, as))
        : items.map((x: any) => ioc.anySerializer.serialize(x));
  }
  // A list-of-lists: frame each inner member by its own descriptor so an element leaf
  // (e.g. terminal select(Column.values) over an element-list-valued group) frames its
  // members as Vertex/Edge, not the client's JS-inferred maps. SQL already expanded the
  // leaf rowids into element payload objects (materialize.nestedListResult); recursing
  // here descends the same nesting the descriptor records.
  return items.map((inner: any) => frameListOf(JSON.stringify(inner), of.of));
}

function frameListOf(json: string, of: ListOf): Buffer {
  // A NULL list column is a genuine null traverser, not a list (e.g. split() of a null value)
  // — frame it as null rather than mapping over a non-array.
  if (json == null) return frameValue(null, undefined);
  return listBuffer(listItemBuffers(json, of));
}

// The GraphBinary key + a canonical string (JS Map dedup key) for one group row.
function groupKey(r: any, key: GroupKey): { buf: Buffer; canon: string } {
  if (key.kind === 'element') return { buf: elementBuffer(r, 'k', key.elem), canon: `e:${r[key.elem === 'property' ? 'k_pk' : 'k_id']}` };
  if (key.kind === 'map') {
    const m = new Map<any, any>();
    key.parts.forEach((p, i) => m.set(p.key, r[`k${i}_v`]));
    return { buf: ioc.anySerializer.serialize(m), canon: 'm:' + key.parts.map((_, i) => JSON.stringify(r[`k${i}_v`])).join('\x00') };
  }
  // The key's type, from the best channel available: a per-row stored vtype column (the
  // truth channel — a datetime/uuid key keeps its exact type) beats the compile-time tag
  // (asNumber(BYTE).groupCount()), and an untagged key infers from the JS value (correct
  // for string/int/double, where the storage class already determines the type).
  const keyCol = perRowColumnOf(key.type);
  const perRow = keyCol ? r[keyCol] as string | null : null;
  if (perRow) {
    // Distinct stored types are distinct keys, so the type joins the canonical dedup key.
    return { buf: frameStoredValue(r.gk, perRow), canon: `s:${perRow}:` + JSON.stringify(r.gk) };
  }
  const staticAs = staticTypeOf(key.type);
  const buf = staticAs ? frameValue(r.gk, staticAs) : ioc.anySerializer.serialize(r.gk);
  return { buf, canon: `s:${staticAs ?? ''}:` + JSON.stringify(r.gk) };
}

// group()/groupCount(): fold ALL rows into ONE GraphBinary Map. Element-valued
// groups arrive one row per MEMBER, in the parent's EMISSION order — so same-key rows are
// interleaved, not contiguous, and that is deliberate (a group's value list is a `fold` and keeps
// arrival order). The accumulator below is keyed on the canonical key precisely so a run is never
// required; do NOT "optimize" it into a run-detecting loop. Scalar-reducer groups arrive one row
// per group (GROUP BY). One loop keyed on GroupVal handles both.
function groupBuffer(rows: any[], key: GroupKey, val: GroupVal): Buffer {
  const groups = new Map<string, { buf: Buffer; members: Buffer[]; gv: any; gvt: string }>();
  for (const r of rows) {
    // A scalar key over a missing property is SQL NULL — TinkerPop's by(key) uses
    // values(key), which yields nothing, so such elements form NO group (not a
    // spurious null-keyed one). Drop them here (covers both GROUP BY and ORDER BY paths).
    if (key.kind === 'scalar' && !key.productive && r.gk == null) continue;
    const k = groupKey(r, key);
    let g = groups.get(k.canon);
    if (!g) { g = { buf: k.buf, members: [], gv: undefined, gvt: '' }; groups.set(k.canon, g); }
    if (val.kind === 'elementList' || val.kind === 'elementLast') {
      // A LEFT-joined group-scoped element fold emits one null payload row so an
      // empty key still exists and frames as []; it is domain, not a member.
      if (r.v_id != null || val.elem === 'property' && r.v_pk != null)
        g.members.push(elementBuffer(r, 'v', val.elem));
    }
    else { g.gv = r.gv; g.gvt = r.gvt; } // count/sum/scalarList: precomputed, one row per group
  }
  const valueBuf = (g: { members: Buffer[]; gv: any; gvt: string }): Buffer => {
    switch (val.kind) {
      case 'elementList': return listBuffer(g.members);
      case 'elementLast': return g.members[g.members.length - 1];
      case 'count': return countBuffer(g.gv);
      case 'sum': return sumBuffer(g.gv, g.gvt);
      case 'list': return ioc.listSerializer.serialize(JSON.parse(g.gv));
      // The DIRECT by('age') projection only: it reads the property inline, so an element
      // missing it contributes a SQL NULL that must be dropped (values semantics). A
      // by(__.traversal) value no longer arrives here — it goes through the child seam, whose
      // rows are marked and filtered in SQL ('list'), so it can distinguish an unproductive
      // child from a productive NULL member instead of blanket-stripping both.
      case 'scalarList': return ioc.listSerializer.serialize(JSON.parse(g.gv).filter((x: any) => x !== null));
      // A nested groupCount/group value: gv is a JSON object {innerKey: innerVal}
      // framed as a Map. count values are Java Longs → Int64 (countBuffer), so they decode to a
      // Number like every other count (an anySerializer.serialize(BigInt) would pick BigInteger —
      // the same fidelity bug fixed for top-level counts); a numeric reducer value infers its type
      // via anySerializer. Built as a MAP buffer directly so the count values keep the Int64 type.
      case 'nestedMap': {
        const entries = Object.entries(JSON.parse(g.gv) as Record<string, any>);
        const isCount = val.innerVal === 'count';
        const nested: Buffer[] = [Buffer.from([ioc.DataType.MAP, 0x00]), ioc.intSerializer.serialize(entries.length, false)];
        for (const [k, v] of entries) nested.push(ioc.anySerializer.serialize(k), isCount ? countBuffer(v) : ioc.anySerializer.serialize(v));
        return Buffer.concat(nested);
      }
    }
  };
  const parts: Buffer[] = [Buffer.from([ioc.DataType.MAP, 0x00]), ioc.intSerializer.serialize(groups.size, false)];
  for (const g of groups.values()) { parts.push(g.buf, valueBuf(g)); }
  return Buffer.concat(parts);
}

// A generator over the result value buffers: per-row shapes `yield` one buffer per
// row (framed over the already-materialized row array — never a live cursor); barrier
// shapes (group/list) drain the array then yield their one value. `executeQuery`
// spreads it into the returned array — the generator form is retained only because it
// expresses per-row vs barrier shapes cleanly, not for laziness (there is none: the
// row array is fully drained up front by store.query(), a DO SQLite cursor being
// unable to cross awaits). Any compile/SQL/framing error throws straight out of
// executeQuery to the edge's one try/catch — there is no partial/streamed state.
// A stored per-row multiplicity: the movementCollapse `bulk` column merged N convergent walks
// into one (value, N) row. bulk is ORTHOGONAL to shape — the framer reads a `bulk` column
// wherever a leaf carries one (only vertex/edge today), 1 otherwise; no Shape variant knows it.
const bulkOf = (r: any): bigint => (r?.bulk != null ? BigInt(r.bulk) : 1n);

// Element leaves may carry that per-row bulk; every other shape is a single-multiplicity value.
// The write path and all non-element value shapes frame through frameValues (bulk 1); only the
// element leaves read the column here, so the multiplicity plumbing touches exactly two cases.
function* frameResolved(store: GraphStore, plan: Executable): Generator<Framed> {
  if (plan.kind === 'write') {
    if (plan.continuation) {
      plan.run(store);
      const { shape, run } = plan.continuation;
      const rows = run(store);
      if (shape.kind === 'vertex') { for (const r of rows) yield { buf: rowVertex(r), bulk: bulkOf(r) }; return; }
      if (shape.kind === 'edge') { for (const r of rows) yield { buf: rowEdge(r), bulk: bulkOf(r) }; return; }
      for (const buf of frameValues(rows, shape)) yield { buf, bulk: 1n };
      return;
    }
    for (const r of plan.run(store)) {
      // A write response's vertex prop bag is already {key:[values]} — the shape vertexBuffer wants.
      // It used to be flat and get wrapped in a 1-list here, which silently truncated a
      // multi-property to its first value on the write path only.
      if ('vertex' in r) yield { buf: vertexBuffer(r.vertex.id, r.vertex.labels, r.vertex.props), bulk: 1n };
      else {
        const e = r.edge;
        // Frame via edgeBuffer so edge properties materialize — routing through
        // anySerializer's EdgeSerializer drops them (same client bug edgeBuffer works around).
        yield { buf: edgeBuffer(e.id, e.label, e.src, e.tgt, e.props ?? {}), bulk: 1n };
      }
    }
    return;
  }
  // A PROGRAM's rows come from the executor rather than one `query`, and everything downstream is
  // identical: shape is the framing contract whether the traversal wrote or only read (§2), so the
  // effects change WHERE the rows come from and nothing about how they are framed.
  const rows = (plan.kind === 'program' ? runProgram(store, plan.program, plan.tail) : store.query(plan.sql, plan.binds)) as any[];
  const shape = plan.shape;
  if (shape.kind === 'vertex') { for (const r of rows) yield { buf: rowVertex(r), bulk: bulkOf(r) }; return; }
  if (shape.kind === 'edge') { for (const r of rows) yield { buf: rowEdge(r), bulk: bulkOf(r) }; return; }
  for (const buf of frameValues(rows, shape)) yield { buf, bulk: 1n };
}

// Every non-element value shape → one Buffer per result, single multiplicity. Unchanged framing;
// element leaves (vertex/edge) are handled in framedResults so they can carry a per-row bulk.
function* frameValues(rows: any[], shape: import('./sql/kernel/render.ts').Shape): Generator<Buffer> {
  switch (shape.kind) {
    case 'vertex': case 'edge': return; // framed in framedResults with per-row bulk
    case 'valueMap': for (const r of rows) yield valueMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys, shape.tokens, shape.labelSet); return;
    case 'elementMap': for (const r of rows) yield elementMapBuffer(r.id, r.label, JSON.parse(r.props), shape.keys, shape.labelSet); return;
    // Per-row framing: values() of a typed prop frames each row by its own stored vtype
    // (like variant frames by vk); a collection vtype frames the stored {t,v} tree via
    // frameStoredValue (fixes bare values(collectionProp)); otherwise the single `as` applies.
    case 'value': {
      const t = shape.type;
      for (const r of rows) {
        if (t.kind !== 'perRow') { yield frameValue(r.v, staticTypeOf(t)); continue; }
        const vtype = r[perRowColumn(t, "Shape 'value'")];
        // A collection vtype names the OUTER shape, so frame the stored {t,v} tree.
        yield isCollectionType(vtype) ? frameStoredValue(r.v, vtype) : frameValue(r.v, vtypeToValueType(vtype));
      }
      return;
    }
    // P4 dynamic-tag row: dispatch each row by its own `vk` — null / scalar / node /
    // edge / list — mirroring the per-row `vtype` dispatch of `case 'value'`.
    case 'variant': {
      const scalar = shape.arms.find((arm) => arm.kind === 'scalar');
      const vertex = shape.arms.some((arm) => arm.kind === 'vertex');
      const edge = shape.arms.some((arm) => arm.kind === 'edge');
      const list = shape.arms.find((arm): arm is Extract<typeof arm, { kind: 'list' }> => arm.kind === 'list');
      const framed = rows.map((r) => {
        if (r.vk === 0) return frameValue(null, undefined);
        if (r.vk === 1 && scalar) return frameValue(r.v, staticTypeOf(scalar.type));
        if (r.vk === 2 && vertex) return rowVertex(r);
        if (r.vk === 3 && edge) return rowEdge(r);
        if (r.vk === 4 && list) return frameListOf(r.list, list.of);
        throw new Error(`invalid variant result tag ${r.vk}`);
      });
      if (shape.wholeResult) yield listBuffer(framed);
      else yield* framed;
      return;
    }
    // A numeric reducer result. `vt` carries EITHER a Gremlin vtype (`min`/`max` emit the winning
    // row's own — `int`/`long`/`string`) OR a SQLite storage class (`sum`/`mean` emit `typeof` —
    // `integer`/`real`/`text`); the two vocabularies are disjoint, so `vtypeToValueType` resolves the
    // former and returns undefined for the latter. Framing a Gremlin vtype through the same path
    // `values()` uses is what lets a text-carried long come back a `long` rather than a String;
    // storage class falls to `sumBuffer` (Int/Long/Double by magnitude). SUM of an empty stream is
    // NULL → no result (TinkerPop yields nothing, matching SQL sum aggregation).
    case 'scalar': for (const r of rows) if (r.v !== null || shape.productiveNull) {
      if (r.v === null) yield frameValue(null, undefined);
      else { const as = vtypeToValueType(r.vt); yield as !== undefined ? frameValue(r.v, as) : sumBuffer(r.v, r.vt); }
    } return;
    case 'map': for (const r of rows) yield mapBuffer(r, shape.entries); return;
    // A whole-map VALUE per row: the `map` blob is [[keyNode,valNode],…] of self-describing
    // {t,v} nodes → frame the reconstructed map tree (each key/value its own exact type).
    case 'mapValue': for (const r of rows) yield frameTypedNode({ t: 'map', v: JSON.parse(r.map) }); return;
    // A Map.Entry stream (map unfold): one size-1 MAP per row.
    case 'mapEntry': for (const r of rows) yield mapEntryBuffer(r, shape.keyOf, shape.valOf); return;
    case 'path': for (const r of rows) yield pathBuffer(r, shape.positions); return;
    // pathGrouped folds pk-runs into Paths — a bounded fold, so yield each completed Path.
    case 'pathGrouped': yield* pathGroupedBuffers(rows, shape.elem, shape.byKey); return;
    // A VertexProperty with its real id + meta-properties framed (vpid null on edges → synthetic).
    case 'property': for (const r of rows) yield framePropertyRow(r); return;
    // properties().properties(): meta-properties as Property elements.
    case 'metaProperty': for (const r of rows) yield ioc.anySerializer.serialize(new Property(r.mk, r.mv)); return;
    // properties(k).valueMap(): a VertexProperty's meta as a flat Map.
    case 'metaMap': for (const r of rows) yield ioc.anySerializer.serialize(new Map(Object.entries(r.meta ? JSON.parse(r.meta) : {}))); return;
    // Barriers: the whole stream collapses to ONE value (Map / List).
    case 'group': yield groupBuffer(rows, shape.key, shape.val); return;
    case 'list': {
      // fold() reuses the plain vertex/edge projection (unprefixed id/label/…),
      // unlike group's v_-prefixed element columns.
      if (shape.elem === 'scalar') yield shape.as
        ? listBuffer(rows.map((r) => frameValue(r.v, shape.as)))
        : ioc.listSerializer.serialize(rows.map((r) => r.v));
      else yield listBuffer(rows.map(shape.elem === 'edge' ? rowEdge : rowVertex));
      return;
    }
    // A list-VALUE stream: one framed List per row (the `list` column arrives as JSON
    // text via json(), so it JSON.parses; scalar elements frame via listSerializer).
    // A list-VALUE stream: frame each row's list by its item descriptor (shared with the
    // variant list arm + record list fields) — typed {t,v} items, a uniform `as` tag, or infer.
    case 'jsonbList': for (const r of rows) yield frameListOf(r.list, shape.items); return;
    case 'jsonbPath': for (const r of rows) yield framePath(listItemBuffers(r.list, shape.items)); return;
    // Relational element-list values materialize as ordered JSON object arrays in
    // SQL, then frame each member through the same property-preserving element
    // encoders as ordinary vertex/edge rows.
    case 'jsonbElementList': for (const r of rows) {
      const items = JSON.parse(r.list);
      yield listBuffer(items.map(shape.elem === 'edge' ? rowEdge : rowVertex));
    } return;
    // A set-VALUE stream (intersect/difference/disjunct, or a stored typed set): frame each
    // list column as a Set — typed items via frameTypedNode (exact element types), else the
    // client's element-inferring SetSerializer over the computed scalars.
    case 'jsonbSet': for (const r of rows)
      yield shape.typed ? setBuffer((JSON.parse(r.list) as ValueNode[]).map(frameTypedNode))
        : ioc.setSerializer.serialize(new Set(JSON.parse(r.list))); return;
    case 'discard': return;
  }
}

/** One framed result value paired with its traverser multiplicity (the GraphBinary V4
 *  bulked-response RLE count). `bulk` is 1 for an un-collapsed traverser; a movement
 *  collapse (GROUP BY id, SUM(bulk)) yields >1, so the edge emits (value, N) instead of
 *  N copies. bigint carries the full i64 range (SQLite raises `integer overflow` past it). */
export type Framed = { buf: Buffer; bulk: bigint };

/**
 * Concern B — the per-GRAPH executor: compile + run + frame a traversal against ONE graph's
 * store. Bound at construction to its `store`, the service `registry`, and the `source` (how to
 * reach OTHER graphs for federation — the GraphManager, which is the executor factory). Runs
 * where the store lives (Bun in-process / inside a DO), so only bytes/rows cross the seam;
 * wire parsing (A) and HTTP framing/pacing (C) live at the edge. Two tail projections of the
 * SAME compile+resolve: `framed` → GraphBinary buffers (client wire); `raw` → detached
 * ForeignRow[] (internal federated transfer). Throws on any compile/SQL/framing failure — the
 * edge frames the error.
 */
export class Executor implements ExecutorApi {
  /** The app-scope DI: this graph's ambient compile dependencies (registry + fastPaths +
   *  federation source), built once. Passed into every compile as CompileOptions.app so the
   *  compiler reads its dependencies from one scope rather than loose per-call arguments. */
  private readonly app: AppScope;
  constructor(
    private readonly store: GraphStore,
    // NOT a `private readonly` field: it is read once here to build the AppScope and never
    // through `this`, so the modifier declared a property nothing uses.
    registry: RegistryProvider,
    // Also NOT a `private readonly`: like `registry` it is read once to build the AppScope. The
    // federated service takes it from there at CONSTRUCTION, so the executor no longer hands it to
    // a barrier's apply at run time.
    source: FederationSource,
    /** Override the ambient fast-path config for every compile on this executor. Omitted in
     *  production (DEFAULT_FAST_PATHS). `createAppScope` has always accepted it; the Executor
     *  simply never threaded it, which left the fast-path equivalence obligation declared
     *  (`FastPath.equivalentWhen`) but unprovable through the real data plane — L5 flips these
     *  off and asserts the generic lowering answers identically. */
    fastPaths?: FastPathConfig,
    /** Where io() reads and writes documents. Omitted → the fail-closed NO_IO_STORE, so an
     *  unbound graph reports the missing binding rather than silently doing nothing. */
    io?: IoStore,
    /** Override the ambient spine for every compile on this executor. The spine equivalence
     *  obligation (§10·4) needs the same real-data-plane proof as fast paths: the census answer
     *  gate runs both pinned positions. A `rel` pin still declines to legacy for an uncovered
     *  chain, because coverage is a property of the chain, not of the request. */
    private readonly spine?: Spine,
  ) {
    this.app = createAppScope({ registry, source, fastPaths, io, store, labelCardinality: store.labelCardinality });
  }

  /** SYNC GraphBinary buffers with per-value bulk (concern C appends it as a Long). A
   *  non-federated traversal compiles to ONE SQL statement and never suspends, so this pays no
   *  async tax. THROWS if the traversal contains a federated call() (use framedAsync). */
  framed(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Framed[] {
    return [...frameResolved(this.store, this.runSync(gremlin, params, paramTypes))];
  }

  /** SYNC flat Buffer[] (bulk expanded to the full multiset) — `framed` for callers that want
   *  plain buffers. Not the wire path (which keeps the compact (value, N) pairs). */
  buffers(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Buffer[] {
    return this.framed(gremlin, params, paramTypes).flatMap((f) =>
      f.bulk === 1n ? [f.buf] : (Array(Number(f.bulk)).fill(f.buf) as Buffer[]));
  }

  /** ASYNC GraphBinary buffers — the client wire path (router). Handles a federated top-level
   *  call() by driving the segment loop (the one await); a non-federated query resolves with zero
   *  async work. A top-level query is federation depth 0. */
  async framedAsync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    const plan = await this.drive(gremlin, params, paramTypes, 0);
    return [...frameResolved(this.store, plan)];
  }

  /** The INTERNAL (non-GraphBinary) row projection — the raw-row transfer a federated hop uses
   *  (a sibling's result crosses as decoded JS rows, framed to GraphBinary only at the CLIENT
   *  edge; never encode→decode→re-encode). `depth` is MANDATORY: this hop's federation depth, so
   *  a federated call can never forget to thread it (a nested federate hops at depth+1). The
   *  federate contract is detached ELEMENT references, so the traversal MUST end vertex/edge — any
   *  other terminal fails closed, not a silent different answer. props/src/tgt arrive in the shape
   *  rowVertex/rowEdge read; propsOf parses the JSON props into the {t,v}-node object. */
  async raw(gremlin: string, params: Record<string, any>, depth: number, paramTypes: Record<string, TypeNode> = {}): Promise<ForeignRow[]> {
    const plan = await this.drive(gremlin, params, paramTypes, depth);
    if (plan.kind !== 'read')
      throw new Error('federated traversal must be a read that yields vertices or edges, not a write');
    const rows = this.store.query(plan.sql, plan.binds) as any[];
    if (plan.shape.kind === 'vertex')
      return rows.map((r) => ({ kind: 'vertex', id: r.id, ...foreignLabels(r.label), props: propsOf(r.props) }));
    if (plan.shape.kind === 'edge')
      return rows.map((r) => ({ kind: 'edge', id: r.id, label: r.label, src: r.src, tgt: r.tgt, props: propsOf(r.props) }));
    throw new Error(`federated traversal must yield vertices or edges (detached references), not a ${plan.shape.kind} result`);
  }

  /** Compile SYNCHRONOUSLY and reject a barrier. A non-federated traversal is ONE SQL statement —
   *  compilePlan returns {kind:'sql'} and there is nothing to await. A federated call() compiles
   *  to a segment plan, which needs the async segment loop (drive) — so this throws, fail-closed
   *  (the sync API cannot honestly run federation). Shares compilePlan + the framing tail with the
   *  async path; only the await-loop differs. */
  private runSync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>): Executable {
    const plan = compilePlan(gremlin, params, { app: this.app, federationDepth: 0, spine: this.spine }, paramTypes);
    if (plan.kind === 'segment')
      throw new Error('this traversal contains a federated call() — use the async path (framedAsync / raw), not the sync framed()/buffers()');
    return plan.compiled;
  }

  /** Drive a (possibly segmented) plan to a final synchronous Compiled/WritePlan — the ONE await
   *  boundary, and the ONLY async loop outside a runtime entry point. A pure single-segment
   *  traversal (all of Phases 1-5) returns immediately, zero async overhead. A barrier (federate)
   *  loops: read+drain head → await apply() → land + resume. `federationDepth` rides
   *  CompileOptions beside the registry, reaching the service's CallSite so the barrier's
   *  apply closure captures it (a recursive federate hops at depth+1). */
  private async drive(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>, federationDepth: number): Promise<Executable> {
    let p: Plan = compilePlan(gremlin, params, { app: this.app, federationDepth, spine: this.spine }, paramTypes);
    while (p.kind === 'segment') {
      const rows = p.head ? this.readSegmentHead(p.head) : [];
      const foreign = await p.apply(rows);
      p = p.resume(foreign, rows);
    }
    return p.compiled;
  }

  /** Read a barrier segment's HEAD into the barrier's input rows (mid-traversal parent
   *  projection, 6b — a source-form barrier has a null head and never calls this). Synchronous:
   *  the row array is fully drained before any barrier await (no cursor across an await). */
  private readSegmentHead(head: Compiled): ForeignRow[] {
    const rows = this.store.query(head.sql, head.binds) as any[];
    // The mid-traversal head projects `o` (rejoin ordinal) and `injVal` (the per-parent injected
    // scalar) alongside the ordinary element payload; both free-ride outside the Shape (read here,
    // not framed). `injVal` is absent on a source-form head (which never reaches this method).
    const inj = (r: any) => ('injVal' in r ? { injectedValue: r.injVal } : {});
    if (head.shape.kind === 'edge')
      return rows.map((r) => ({ kind: 'edge', id: r.id, label: r.label, src: r.src, tgt: r.tgt, props: propsOf(r.props), ordinal: r.o, ...inj(r) }));
    return rows.map((r) => ({ kind: 'vertex', id: r.id, ...foreignLabels(r.label), props: propsOf(r.props), ordinal: r.o, ...inj(r) }));
  }
}
