import type { Executor as ExecutorApi, ForeignResult, ForeignRow, ForeignTerminal } from './api.ts';
import type { BarrierInput } from './services/spi/types.ts';
import { DEFAULT_VERTEX_LABEL } from './api.ts';
import { compilePlan, UnsupportedTraversal, hasTypedMembers, perRowColumn, perRowColumnOf, staticTypeOf, type Compiled, type Executable, type FastPathConfig, type ListOf, type MapOf, type ScalarType, type Shape, type ValueType } from './compiler/compiler.ts';
import { dateOfMillis } from './gremlin/coerce.ts';
import type { FederationSource } from './compiler/segment.ts';
import type { Elem } from './compiler/elem.ts';
import { hasSerializer, isCollectionType, valueNodeFromStored, type FrameNode, type TypeNode, type ValueNode } from './gremlin/types.ts';
import { direction, ioc, Property, t } from './io.ts';
import { createAppScope, type AppScope, type RegistryProvider } from './scopes.ts';
import type { IoStore } from './iostore.ts';
import { runSteps } from './program.ts';
import { untyped } from './untyped.ts';
import { refreshElements } from './refresh.ts';
import { driveSegments, driveSegmentsSync, type SegmentHost } from './drive.ts';
import type { GraphStore } from './storage.ts';
import { exactNumberOf, isExactNumber, parseExactJson, type ExactNumber } from './json-exact.ts';
import { bigDecimalOfCarrier } from './gremlin/float.ts';

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

// A GraphBinary container header — its DataType tag, the 0x00 value-present byte, and the bare int32
// element COUNT — followed by the already-fully-qualified member buffers (mirrors the client's
// List/Set/Map serializers). LIST/SET carry one buffer per element; a MAP carries two per entry (key
// then value), so `count` is the logical element/entry count, passed rather than derived from
// `members.length`. Every hand-framed container goes through here so the header is written in one place.
function sizedContainer(tag: number, count: number, members: readonly Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([tag, 0x00]), ioc.intSerializer.serialize(count, false), ...members]);
}


// A GraphBinary LIST framed by hand (mirrors ArraySerializer) so element items
// go through vertexBuffer/edgeBuffer — routing them via listSerializer→
// anySerializer would drop their props (same client-serializer bug).
function listBuffer(items: Buffer[]): Buffer {
  return sizedContainer(ioc.DataType.LIST, items.length, items);
}

// A GraphBinary SET framed by hand (same layout as LIST, DataType.SET) so its items go
// through the typed framer instead of the client's element-type-inferring SetSerializer.
function setBuffer(items: Buffer[]): Buffer {
  return sizedContainer(ioc.DataType.SET, items.length, items);
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
  // An untagged number past 2^53 the list framer kept exact (`exactNumberBuffer`).
  if (isExactNumber(node)) return exactNumberBuffer(node);
  // A BARE member: the producer omitted the envelope because the storage class already
  // determines the type (a string/int member — per member, as `listLiteralBlob` and
  // `list.ts lossyMember` decide). Infer from the JS value, which is exactly what the envelope
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
  // A PROPERTY member, the element arm's third kind. `v` is the same `{vpid,owner,pk,pv,pvtype,pmeta}`
  // tuple the top-level property stream and the property-membered list already frame, so this is one
  // arm and not a payload vocabulary: `g.V().properties().group().by(…).by(__.tail())` puts a
  // VertexProperty in a map value, and it frames by the rule that already framed it in a list.
  if (node.t === 'property') return framePropertyRow(node.v);
  // A PATH — its positions, each framed by this same rule, so an element position keeps its properties.
  if (node.t === 'path') return framePath(node.v.map(frameTypedNode));
  // A `T` TOKEN, which is a GraphBinary type of its own rather than the string it prints as — a
  // `valueMap(true)`/`elementMap()` key. One arm here, so a token composes at every depth the tree
  // reaches (a map key today; a list member or a nested map's key the day one produces it) exactly
  // as the element arm above does.
  if (node.t === 'T') return ioc.anySerializer.serialize(t[node.v]);
  // A `Direction` token, the same standing as `T` one enum along — an edge `elementMap()`'s two
  // endpoint entries are keyed by it, and it is a GraphBinary type of its own (`DataType.DIRECTION`).
  if (node.t === 'D') return ioc.anySerializer.serialize(direction[node.v === 'IN' ? 'in' : 'out']);
  // A scalar leaf's tag is EITHER a Gremlin vtype (`int`/`double`/`datetime` — a stored value, or
  // min/max's winner) OR a numeric reducer's SQLite storage class (`integer`/`real` from sum/mean's
  // `typeof`). The two are disjoint, so this mirrors the top-level `scalar` Shape: resolve
  // a Gremlin vtype exactly, and route a storage class through `sumBuffer` — which forces DOUBLE for
  // `real` so a whole-number mean (`30.0`) frames as a Double rather than the Int magnitude inference
  // would pick. A null tag infers, unchanged.
  const tag: string | null = node.t;
  // A leaf value `parseExactJson` kept as its source text frames from that text — the tag names the class.
  const value = isExactNumber(node.v) ? node.v.rawJSON : node.v;
  const as = vtypeToValueType(tag);
  // A BigDecimal reads its carrier's own spelling (`bigDecimalOfCarrier` — a raw JSON REAL is a Double's
  // `BigDecimal.valueOf`, not the decimal text it happens to print as).
  if (as !== undefined) return frameValue(as === 'bigdecimal' ? node.v : value, as);
  if (tag != null) return sumBuffer(value, tag);
  return isExactNumber(node.v) ? exactNumberBuffer(node.v) : frameValue(value, undefined);
}

// A GraphBinary MAP from ordered typed [key, value] node pairs — keys AND values framed
// by the typed framer (so a non-string / typed key rides its true type). Layout mirrors
// the client's MapSerializer: [MAP, 0x00], bare int32 count, then key/value fully-qualified buffers.
function typedMapBuffer(pairs: [FrameNode, FrameNode][]): Buffer {
  return sizedContainer(ioc.DataType.MAP, pairs.length,
    pairs.flatMap(([k, v]) => [frameTypedNode(k), frameTypedNode(v)]));
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

// A summed numeric, framed to match SQLite's storage class of the SUM (passed as
// typeof(): 'real' → Double even when whole, e.g. 1.0; 'integer' → Int/Long by
// magnitude via NumberSerializationStrategy). Mirrors TinkerPop sum() typing —
// int props sum to Int/Long (d[123].i), double props to Double (d[1.0].d).
// A NULL is null whatever the class, by `frameValue`'s rule: a reducer's null — an all-null `mean()`,
// which `MeanGlobalStep` emits as null (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:80-84`)
// and which keeps its `real` tag inside a `{t,v}` node — was `Number(null)`, a Double 0.0.
function sumBuffer(v: number | string | null, storageClass: string): Buffer {
  if (v === null || v === undefined) return ioc.anySerializer.serialize(null);
  if (storageClass === 'real') return ioc.doubleSerializer.serialize(Number(v), true);
  // An INTEGER past 2^53 rides as decimal TEXT (`build.ts` `asExactWideInt` — a JS number would round it);
  // SQLite's INTEGER is an int64, so it is a `Long`, reconstructed exactly. `anySerializer` would frame
  // the text as a String (`local(…sum()).fold()` answered `["9007199254740997", …]`).
  if (storageClass === 'integer' && typeof v === 'string') return ioc.longSerializer.serialize(BigInt(v), true);
  return ioc.anySerializer.serialize(v);
}

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
  // A NULL value is null on the wire whatever its declared tag — a static numeric/boolean/date tag
  // describes the stream, not this row, and coercing (`Number(null)` → 0, `Boolean(null)` → false,
  // `BigInt(null)` throws) would turn a genuine null traverser into a plausible value. Every GLV
  // decodes a typed-null and an untyped-null to the same language null (a Band-3 tag distinction,
  // build-plan §12), so the untyped null is the observationally-correct framing — and it is already
  // the convention every explicit `frameValue(null, undefined)` call site here relies on. This is the
  // one place `asNumber(GType.INT)` over a null (`AsNumberStep.map` returns null) and an all-null
  // min/max (§10: one null traverser is emitted) frame correctly instead of as 0.
  if (v === null || v === undefined) return ioc.anySerializer.serialize(null);
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
    // A Float rides as a Double (`floatCanonical`); HERE, at the wire, it becomes float32.
    case 'float': return ioc.floatSerializer.serialize(Math.fround(Number(v)), true);
    case 'double': return ioc.doubleSerializer.serialize(Number(v), true);
    // Datetime is carried as epoch-millis (INTEGER); the client's DateTimeSerializer
    // takes a JS Date (GraphBinary DATETIME 0x04, UTC wire), so reconstruct it here.
    case 'datetime': return ioc.dateTimeSerializer.serialize(dateOfMillis(v), true);
    // A stored TEXT value framed by its true type: uuid via UuidSerializer (16-byte
    // GraphBinary UUID from the string), string explicitly (anySerializer would also
    // pick String, but the stored vtype lets uuid win over a look-alike string).
    case 'string': return ioc.stringSerializer.serialize(String(v), true);
    case 'uuid': return ioc.uuidSerializer.serialize(String(v), true);
    // The exact tail: the value is a stored canonical TEXT string. serialize() parses it
    // (BigDecimal.fromText / Duration total-nanos / 1-codepoint char) → exact GraphBinary.
    // Every carrier — decimal TEXT, an INTEGER, a REAL, a list member's raw JSON spelling — is read by the
    // ONE carrier authority, which fixes the SCALE (`bigDecimalOfCarrier`, `gremlin/float.ts`).
    case 'bigdecimal': return bigDecimalSerializer.serialize(bigDecimalOfCarrier(v), true);
    case 'duration': return durationSerializer.serialize(String(v), true);
    case 'char': return charSerializer.serialize(String(v), true);
  }
}

// A list member whose type the compile did not know rides SQLite's JSON bare, and past 2^53 `JSON.parse`
// would round it (the wire then carries a number nobody stored). The list framer parses with
// `parseExactJson` (`json-exact.ts`), which keeps such a number as its source text — re-stringifying
// exactly through the nested-list arm's `JSON.stringify(inner)` — and each leaf frames it here: an
// integral spelling is SQLite's INTEGER, an int64, so a `Long`; any other spelling a `Double`.
function exactNumberBuffer(x: ExactNumber): Buffer {
  const { integral, text } = exactNumberOf(x);
  return integral ? ioc.longSerializer.serialize(BigInt(text), true) : ioc.doubleSerializer.serialize(Number(text), true);
}

// A stored per-row multiplicity: the movementCollapse `bulk` column merged N convergent walks
// into one (value, N) row. bulk is ORTHOGONAL to shape — only the element leaves (vertex/edge) carry
// the column; every other shape is a single-multiplicity value.
const bulkOf = (r: any): bigint => (r?.bulk != null ? BigInt(r.bulk) : 1n);

/** One result value as a self-describing `FrameNode`, paired with its traverser multiplicity. */
type ResultNode = { node: FrameNode; bulk: bigint };

// ---- result rows → NODE TREE: the ONE projection every result tail reads ----
//
// `rowsToNodes` turns a plan's rows into the self-describing `FrameNode` tree, per its `Shape` — TOTAL
// over the Shape union. Every tail is a projection of those nodes and nothing else: GraphBinary frames
// each through `frameTypedNode` (`frameResolved`), the readable JSON response renders each through
// `untyped` (`resolveJson`), and a federated hop ships them as its value stream (`runForeign`). One reader
// per row shape is what keeps the three from framing one value three ways.

/** One element row's public payload as a `{t,v}` element node — the `{id,label,props[,src,tgt]}` tuple
 *  `rowVertex`/`rowEdge` consume. A vertex's `label` is the labels array; an edge carries `src`/`tgt`. */
const elementNode = (raw: any, elem: Elem): FrameNode =>
  elem === 'edge'
    ? { t: 'edge', v: { id: raw.id, label: raw.label, src: raw.src, tgt: raw.tgt, props: propsOf(raw.props) } }
    : { t: 'vertex', v: { id: raw.id, label: labelsOf(raw.label), props: propsOf(raw.props) } };

/** ONE scalar cell by its declared type channel — the rule a scalar ROW (`value`), a record field and a
 *  variant's scalar arm all follow: a static tag applies as is, a column-carried per-row type reads its
 *  sibling column (a collection vtype nests the stored `{t,v}` tree, a `T`/`Direction` token is a
 *  GraphBinary enum rather than the string it prints as, an unrecognized tag infers), and an unknown type
 *  infers. */
function scalarCellNode(v: any, row: any, type: ScalarType, at: string): FrameNode {
  if (type.kind !== 'perRow') return { t: staticTypeOf(type) ?? null, v };
  const vtype = row[perRowColumn(type, at)] ?? null;
  if ((vtype === 'T' || vtype === 'D') && typeof v === 'string') return { t: vtype, v } as FrameNode;
  return isCollectionType(vtype) ? valueNodeFromStored(v, vtype) : { t: vtypeToValueType(vtype) ?? null, v };
}

/** A JSON list's PARSED members as nodes, per its `ListOf`. Element members ride the element arm, a
 *  property member the property arm; a scalar member carries its static tag, is already a `{t,v}` node
 *  (envelope-typed), or is bare (inferred — a non-primitive wrapped as an untagged leaf so it is not
 *  mistaken for a node); a mixed/map member self-describes; a path member is a path; a nested list
 *  recurses, a null inner list is a null member. */
function listMemberNodes(items: any[], of: ListOf): FrameNode[] {
  switch (of.kind) {
    case 'elem': return items.map((it) => elementNode(it, of.elem));
    case 'property': return items.map((it) => ({ t: 'property' as const, v: it }));
    case 'scalar': {
      if (hasTypedMembers(of)) return items;
      const as = staticTypeOf(of.type);
      if (as !== undefined) return items.map((x) => ({ t: as, v: x }));
      return items.map((x) => (x !== null && typeof x === 'object' && !isExactNumber(x) ? { t: null, v: x } : x));
    }
    case 'mixed': return items;
    case 'map': return items.map((pairs) => ({ t: 'map' as const, v: pairs }));
    case 'path': return items.map((inner) => ({ t: 'path' as const, v: listMemberNodes(inner, of.of) }));
    case 'list': return items.map((inner) => (inner == null ? null : { t: 'list' as const, v: listMemberNodes(inner, of.of) }));
  }
}

/** A JSON list COLUMN as one node of the given container tag — parsed EXACTLY (a member past 2^53 keeps
 *  its digits). A NULL column is a genuine null traverser (`split()` of a null), not a list. */
const listColumnNode = (json: string | null, of: ListOf, t: 'list' | 'set' | 'path' = 'list'): FrameNode =>
  json == null ? null : ({ t, v: listMemberNodes(parseExactJson(json), of) } as FrameNode);

/** One side (key/value) of a Map.Entry row, per its `MapOf`: an element (JSON object text), a list, else
 *  a self-describing `{t,v}` node (already parsed, or JSON text). */
function mapSideNode(raw: any, of: MapOf): FrameNode {
  if (raw == null) return null;
  if (of.kind === 'elem') return elementNode(JSON.parse(raw), of.elem);
  if (of.kind === 'list') return listColumnNode(raw, of.of);
  return typeof raw === 'string' ? parseExactJson(raw) : raw;
}

/** A variant row by its own `vk` tag — null / scalar / vertex / edge / list. The scalar arm's type is the
 *  MEET of every scalar arm (`variantVocabulary`). */
function variantNodes(rows: any[], shape: Extract<Shape, { kind: 'variant' }>): FrameNode[] {
  const scalar = shape.arms.find((arm) => arm.kind === 'scalar');
  const list = shape.arms.find((arm): arm is Extract<typeof arm, { kind: 'list' }> => arm.kind === 'list');
  const has = (kind: 'vertex' | 'edge') => shape.arms.some((arm) => arm.kind === kind);
  return rows.map((r): FrameNode => {
    if (r.vk === 0) return null;
    if (r.vk === 1 && scalar) return scalarCellNode(r.v, r, scalar.type, "Shape 'variant'");
    if (r.vk === 2 && has('vertex')) return elementNode(r, 'vertex');
    if (r.vk === 3 && has('edge')) return elementNode(r, 'edge');
    if (r.vk === 4 && list) return listColumnNode(r.list, list.of);
    throw new Error(`invalid variant result tag ${r.vk}`);
  });
}

/** The value nodes of a non-element shape, one per result (bulk 1). */
function valueNodes(shape: Shape, rows: any[]): FrameNode[] {
  switch (shape.kind) {
    case 'vertex': case 'edge': return rows.map((r) => elementNode(r, shape.kind));
    case 'value': return rows.map((r) => scalarCellNode(r.v, r, shape.type, "Shape 'value'"));
    case 'variant': return variantNodes(rows, shape);
    // A numeric reducer: `vt` is EITHER a Gremlin vtype (min/max's winner) OR a SQLite storage class
    // (sum/mean's `typeof`) — `frameTypedNode`'s leaf resolves both. SUM of an empty stream is NULL → no
    // result (TinkerPop yields nothing), unless the null is productive.
    case 'scalar': return rows.filter((r) => r.v !== null || shape.productiveNull).map((r) => (r.v === null ? null : { t: r.vt ?? null, v: r.v }));
    case 'mapValue': return rows.map((r) => ({ t: 'map', v: parseExactJson(r.map) }));
    // A Map.Entry frames as a size-1 map (TINKERPOP-3104: a remote Map.Entry is a one-entry Map).
    case 'mapEntry': return rows.map((r) => ({ t: 'map', v: [[mapSideNode(r.mk, shape.keyOf), mapSideNode(r.mv, shape.valOf)]] }));
    case 'typedNode': return rows.map((r) => (r.node == null ? null : parseExactJson(r.node)));
    // A VertexProperty with its real id + meta-properties (vpid null on edges → synthetic).
    case 'property': return rows.map((r) => ({ t: 'property', v: r }));
    case 'jsonbList': return rows.map((r) => listColumnNode(r.list, shape.items));
    case 'jsonbSet': return rows.map((r) => listColumnNode(r.list, shape.items, 'set'));
    case 'jsonbPath': return rows.map((r) => listColumnNode(r.list, shape.items, 'path'));
    case 'discard': return [];
  }
}

/** A plan's result rows as `(node, bulk)` pairs — TOTAL over `Shape`. Only an element leaf reads a
 *  per-row `bulk`; every other shape is single-multiplicity. */
function rowsToNodes(shape: Shape, rows: any[]): ResultNode[] {
  if (shape.kind === 'vertex' || shape.kind === 'edge')
    return rows.map((r) => ({ node: elementNode(r, shape.kind as Elem), bulk: bulkOf(r) }));
  return valueNodes(shape, rows).map((node) => ({ node, bulk: 1n }));
}

/** Run a plan and project its rows to nodes. A PROGRAM's rows come from the executor rather than one
 *  `query`, and its effects get their gid (the §6·1 post-write refresh — keyed on `gid IS NULL`, so a
 *  write that created nothing is a no-op). An OLAP DECORATE barrier's scratch is dropped once the rows are
 *  materialized, whether or not that succeeded. */
function resolveNodes(store: GraphStore, plan: Executable): ResultNode[] {
  try {
    const rows = (plan.kind === 'program' ? runSteps(store, plan) : store.query(plan.sql, plan.binds)) as any[];
    if (plan.kind === 'program') refreshElements(store);
    return rowsToNodes(plan.shape, rows);
  } finally {
    if (plan.cleanup) for (const run of plan.cleanup) store.dropBarrierRun(run);
  }
}

/** Run a plan and frame each result as GraphBinary, with its multiplicity. This is the ONE seam both
 *  runtimes cross (Bun's Executor and the DO's runFramed), so a compiled write gets its gid wherever it runs. */
export function frameResolved(store: GraphStore, plan: Executable): Framed[] {
  return resolveNodes(store, plan).map(({ node, bulk }) => ({ buf: frameTypedNode(node), bulk }));
}

/** One framed result value paired with its traverser multiplicity (the GraphBinary V4
 *  bulked-response RLE count). `bulk` is 1 for an un-collapsed traverser; a movement
 *  collapse (GROUP BY id, SUM(bulk)) yields >1, so the edge emits (value, N) instead of
 *  N copies. bigint carries the full i64 range (SQLite raises `integer overflow` past it). */
export type Framed = { buf: Buffer; bulk: bigint };

/** Render a plan's result as an untyped-JSON ARRAY string (the negotiated `application/json` response).
 *  The bulk-N multiplicity is EXPANDED — a collapsed `(value, N)` row emits N copies — so the array
 *  matches what a client sees when it expands the bulked GraphBinary response. A write's run and its
 *  rendering are ONE atomic unit (`GraphStore.atomically`). */
function resolveJson(store: GraphStore, plan: Executable): string {
  const render = (): string => {
    const out: unknown[] = [];
    for (const { node, bulk } of resolveNodes(store, plan)) for (let k = bulk; k > 0n; k--) out.push(untyped(node));
    return JSON.stringify(out);
  };
  return plan.kind === 'program' ? store.atomically(render) : render();
}

/**
 * Concern B — the per-GRAPH executor: compile + run + frame a traversal against ONE graph's
 * store. Bound at construction to its `store`, the service `registry`, and the `source` (how to
 * reach OTHER graphs for federation — the GraphManager, which is the executor factory). Runs
 * where the store lives (Bun in-process / inside a DO), so only bytes/rows cross the seam;
 * wire parsing (A) and HTTP framing/pacing (C) live at the edge. Two tail projections of the
 * SAME compile+resolve: `framed` → GraphBinary buffers (client wire); `runForeign` → detached
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
  ) {
    this.app = createAppScope({ registry, source, fastPaths, io, store });
  }

  /** SYNC GraphBinary buffers with per-value bulk (concern C appends it as a Long). A
   *  non-federated traversal compiles to ONE SQL statement and never suspends, so this pays no
   *  async tax. THROWS if the traversal contains a federated call() (use framedAsync). */
  framed(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Framed[] {
    return frameResolved(this.store, this.runSync(gremlin, params, paramTypes));
  }

  /** SYNC flat Buffer[] (bulk expanded to the full multiset) — `framed` for callers that want
   *  plain buffers. Not the wire path (which keeps the compact (value, N) pairs). */
  buffers(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Buffer[] {
    return this.framed(gremlin, params, paramTypes).flatMap((f) =>
      f.bulk === 1n ? [f.buf] : (Array(Number(f.bulk)).fill(f.buf) as Buffer[]));
  }

  /** Run a captured replication FILTER against this graph and return the matched vertices' EXTERNAL ids
   *  (`COALESCE(uid, id)` — the id a vertex traversal yields), the source-side selector for filtered
   *  replication (filtered-replication-plan §2/F1). `changesFeed` resolves these back to rowids and closes
   *  the 1-hop subgraph. FAILS CLOSED: the traversal must be a READ whose terminal is a VERTEX stream —
   *  a scalar/edge/write filter throws with a clear message. This one check is BOTH the run-time contract
   *  AND the save-time validation (§2: "confirm its terminal is a vertex stream"). Sync, like `framed`: a
   *  filter is an ordinary local read, and a filter that tries to federate throws via `runSync`
   *  (fail-closed — a cross-graph selector is not in scope). */
  filterVertexIds(gremlin: string, params: Record<string, any> = {}): (string | number)[] {
    const plan = this.runSync(gremlin, params, {});
    if (plan.kind !== 'read')
      throw new UnsupportedTraversal('a replication filter must be a read that yields a vertex stream, not a write');
    if (plan.shape.kind !== 'vertex')
      throw new UnsupportedTraversal(`a replication filter must yield a vertex stream, not a ${plan.shape.kind} result`);
    return (this.store.query(plan.sql, plan.binds) as { id: string | number }[]).map((r) => r.id);
  }

  /** ASYNC GraphBinary buffers — the client wire path (router). Handles a federated top-level
   *  call() by driving the segment loop (the one await); a non-federated query resolves with zero
   *  async work. A top-level query is federation depth 0. */
  async framedAsync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    const plan = await this.drive(gremlin, params, paramTypes, 0);
    return frameResolved(this.store, plan);
  }

  /** ASYNC untyped-JSON string — the content-negotiated (`Accept: application/json`) readable response.
   *  Same compile+drive as `framedAsync`; only the tail projection differs (`resolveJson` instead of
   *  `frameResolved`), and both read the same result nodes, so every shape renders. */
  async jsonAsync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<string> {
    const plan = await this.drive(gremlin, params, paramTypes, 0);
    return resolveJson(this.store, plan);
  }

  /** The INTERNAL (non-GraphBinary) result transfer a federated hop uses (a sibling's result crosses as
   *  decoded JS, framed to GraphBinary only at the CLIENT edge; never encode→decode→re-encode). `depth`
   *  is MANDATORY: this hop's federation depth, so a federated call can never forget to thread it (a
   *  nested federate hops at depth+1). Returns a `ForeignResult` tagged by the SIBLING'S shape: ELEMENTS
   *  (vertex/edge detached references — props/src/tgt in the shape rowVertex/rowEdge read, `propsOf`
   *  parsing the JSON props into {t,v} nodes), or a SCALAR for a pushed-down bare reducer
   *  (count/sum/max/min/mean). A scalar crosses as a `{t,v}` `ValueNode` so its Gremlin type survives the
   *  JSON transfer (a Long stays a Long) — `count`'s type is the plan's static `ScalarType`, the numeric
   *  reducers' is the per-row `vt` column (a Gremlin vtype or a SQLite storage class, the same two the
   *  local `scalar` framer resolves), or a VALUE stream of the same result nodes every local tail reads. */
  async runForeign(gremlin: string, params: Record<string, any>, depth: number, paramTypes: Record<string, TypeNode> = {}, terminal?: ForeignTerminal): Promise<ForeignResult> {
    // DETACHED compile: a federated fetch lands the subgraph, so its element props carry the extra
    // facts a landed element needs to reconstruct a full detached form — property ids and meta-properties.
    const plan = await this.drive(gremlin, params, paramTypes, depth, true);
    if (plan.kind !== 'read')
      throw new UnsupportedTraversal('federated traversal must be a read that yields vertices or edges, not a write');
    const rows = this.store.query(plan.sql, plan.binds) as any[];
    // An element row may carry a COLLAPSED multiplicity (`bulk`, the movementCollapse `SUM(bulk)` — the
    // same column `frameResolved` reads via `bulkOf`). The transfer is a FLAT traverser stream, exactly
    // what an HTTP peer receives (`foreign-decode.ts` requests `bulkResults=false`), so each row lands
    // `bulk` times. Dropping it landed the DISTINCT elements, and a local `fold().count(local)` counted those.
    const flat = (one: (r: any) => ForeignRow): ForeignRow[] => rows.flatMap((r) => {
      const n = Number(bulkOf(r));
      const el = one(r);
      return n === 1 ? [el] : Array.from({ length: n }, () => el);
    });
    if (plan.shape.kind === 'vertex')
      return { kind: 'elements', rows: flat((r) => ({ kind: 'vertex', id: r.id, ...foreignLabels(r.label), props: propsOf(r.props) })) };
    if (plan.shape.kind === 'edge')
      return { kind: 'elements', rows: flat((r) => ({ kind: 'edge', id: r.id, label: r.label, src: r.src, tgt: r.tgt, props: propsOf(r.props) })) };
    // A pushed-down REDUCER collapses the whole stream to ONE value. `count()` is `value` (static
    // ScalarType — a Long); sum/max/min/mean are `scalar` (per-row `vt`). It arrives here ONLY when the
    // caller flagged the pushed terminal `'reduce'`, which is the ONE fact that disambiguates a `value`
    // shape that is a collapsing count from a `value` shape that is a `values(k)` STREAM (both compile to
    // `value`, differing only in reducer-vs-stream SEMANTICS — count over empty is 0, values over empty is
    // []). SUM of an empty stream is NULL → no value (TinkerPop yields nothing), so carry a null scalar and
    // let the resume frame nothing.
    if (terminal === 'reduce') {
      if (plan.shape.kind === 'value')
        // `ValueType` is a subset of `CanonicalType` (`gremlin/types.ts`), so the static type IS the
        // ValueNode `t` tag directly — no conversion. `count()` → `{t:'long', v}`, framed as a Long.
        return { kind: 'scalar', value: { t: staticTypeOf(plan.shape.type) ?? null, v: rows[0]?.v ?? null } };
      if (plan.shape.kind === 'scalar')
        // The per-row `vt` is a Gremlin vtype (min/max's winner) OR a SQLite storage class (sum/mean) —
        // the same two disjoint vocabularies `frameTypedNode`'s leaf resolves, so it re-frames exactly.
        return { kind: 'scalar', value: { t: (rows[0]?.vt ?? null) as ValueNode['t'], v: rows[0]?.v ?? null } };
      // A pushed-down mid-traversal REDUCTION returns a `(key→partial)` MAP (`group().by(key).by(partial())`).
      // `mapValue` already IS the ValueNode `t:'map'` shape — `[[keyNode, valNode],…]` of self-describing
      // nodes — so it crosses on the scalar arm losslessly (keys and partials keep their Gremlin types). An
      // empty group set yields no row → an empty map, which the combine reads as "every parent matched 0".
      if (plan.shape.kind === 'mapValue')
        return { kind: 'scalar', value: { t: 'map', v: rows[0]?.map ? parseExactJson(rows[0].map) : [] } };
      throw new Error(`federate: expected a reduced scalar or keyed map from the pushed reducer, got a ${plan.shape.kind} result`);
    }
    // The mapValues injection query (`'keyedMap'`, `ForeignTerminal`) crosses as ONE typed map tree. Its
    // parent keys remain ordinary Gremlin map keys for the caller-side resume. Any OTHER `mapValue` result
    // is a stream of maps and frames below, one node per row.
    if (terminal === 'keyedMap') {
      if (plan.shape.kind !== 'mapValue') throw new Error(`federate: expected a keyed map from the mapValues injection, got a ${plan.shape.kind} result`);
      return { kind: 'map', value: { t: 'map', v: rows[0]?.map ? parseExactJson(rows[0].map) : [] } };
    }
    // A pushed-down VALUE-PRODUCING terminal (`values(k)`, `unfold()`, `fold()`, `cap('a')`, …): the whole
    // tail ran on the sibling and returned a STREAM of N values, each re-framed by its own Gremlin type. It
    // rides the SAME `{t,v}` envelope the scalar arm uses — one node per member — so the resume unfolds each
    // into its own traverser (`lowerTypedNodeStream`), the scalar reducer's framing one cardinality up. They
    // are the SAME result nodes the local tails frame (`valueNodes`), so every shape crosses.
    return { kind: 'values', values: valueNodes(plan.shape, rows) };
  }

  /** Compile SYNCHRONOUSLY and reject a barrier. A non-federated traversal is ONE SQL statement —
   *  compilePlan returns {kind:'sql'} and there is nothing to await. A federated call() compiles
   *  to a segment plan, which needs the async segment loop (drive) — so this throws, fail-closed
   *  (the sync API cannot honestly run federation). Shares compilePlan + the framing tail with the
   *  async path; only the await-loop differs. */
  private runSync(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>): Executable {
    const plan = compilePlan(gremlin, params, { app: this.app, federationDepth: 0 }, paramTypes);
    // A SYNC barrier (regex) IS drivable here — its head read and resume run with no await, so the whole
    // traversal is one atomic synchronous stretch. Only an ASYNC barrier (federate, io) throws, since
    // this path has no await to run its transform. (`driveSegmentsSync`.)
    return driveSegmentsSync(this.segmentHost, plan);
  }

  /** This Executor as a `SegmentHost` (src/drive.ts): compile bound to this app scope, and the
   *  segment-head read against this store. Built once — `driveSegments` is a free function so the
   *  SAME loop runs in-process here and Worker-side in Phase 2; the Executor is only the in-process
   *  host. `federationDepth` threads through `compile` so a recursive federate hops at depth+1. */
  private readonly segmentHost: SegmentHost = {
    compile: (gremlin, params, paramTypes, federationDepth, detached) =>
      compilePlan(gremlin, params, { app: this.app, federationDepth, detached }, paramTypes),
    readHead: (head) => readSegmentHead(this.store, head),
    // A sync barrier's head, read WITHOUT an await — same local `store.query`, so it interleaves with
    // nothing. `readSegmentHead` is already synchronous; the two readers differ only in that the async
    // one may be an RPC Worker-side, which a sync barrier (always local) never is.
    readHeadSync: (head) => readSegmentHead(this.store, head),
    // Leak-on-throw belt: drop the barrier runs of a chain that threw mid-drive (the framer's cleanup
    // only fires for a chain that fully drove). Idempotent per run — a DELETE by token.
    dropRuns: (runs) => { for (const run of runs) this.store.dropBarrierRun(run); },
  };

  /** Drive a (possibly segmented) plan to a final synchronous Compiled/Program — the ONE await
   *  boundary, and the ONLY async loop outside a runtime entry point. A pure single-segment
   *  traversal (all of Phases 1-5) returns immediately, zero async overhead. A barrier (federate)
   *  loops: read+drain head → await apply() → land + resume. The loop itself is `driveSegments`;
   *  this method only supplies the in-process host. */
  private drive(gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode>, federationDepth: number, detached = false): Promise<Executable> {
    return driveSegments(this.segmentHost, gremlin, params, paramTypes, federationDepth, detached);
  }

}

/** Read a barrier segment's HEAD into the barrier's input rows (mid-traversal parent projection, 6b —
 *  a source-form barrier has a null head and never calls this). Synchronous: the row array is fully
 *  drained before any barrier await (no cursor across an await). A free function (like `frameResolved`)
 *  so the DO can expose it as an RPC for Worker-driven federation (§4·2) — the Worker holds the loop,
 *  the DO runs this brief head read and its request closes. */
export function readSegmentHead(store: GraphStore, head: Compiled): BarrierInput[] {
  const rows = store.query(head.sql, head.binds) as any[];
  // A SCALAR head is the injected VALUE itself, one row per parent — everything a barrier reads of
  // its input (`BarrierInput`). The element-shaped arms below are the legacy route's head, which
  // materialized the whole parent tuple to reach the same one field.
  // A per-row typed head also delivers the row's TAG, which is what tells a Boolean (0/1) or a Date (epoch
  // millis) from the number it is stored as (`BarrierInput.injectedType`).
  if (head.shape.kind === 'value') {
    const tagCol = perRowColumnOf(head.shape.type);
    return rows.map((r) => (tagCol ? { injectedValue: r.v, injectedType: r[tagCol] ?? null }
      : { injectedValue: r.v }));
  }
  if (head.shape.kind === 'jsonbList') return rows.map((r) => ({ injectedValue: JSON.parse(r.list), injectedText: r.list }));
  // A `mapValue` head delivers each traverser's map as its PAIRS array `[[keyNode,valNode],…]` — the same
  // encoding the `map` column carries (a global `order()` over a map stream reads it, `orderMapStreamValue`).
  if (head.shape.kind === 'mapValue') return rows.map((r) => ({ injectedValue: JSON.parse(r.map), injectedText: r.map }));
  // The mid-traversal head projects `o` (rejoin ordinal) and `injVal` (the per-parent injected
  // scalar) alongside the ordinary element payload; both free-ride outside the Shape (read here,
  // not framed). `injVal` is absent on a source-form head (which never reaches this method).
  const inj = (r: any) => ('injVal' in r ? { injectedValue: r.injVal } : {});
  if (head.shape.kind === 'edge')
    return rows.map((r) => ({ kind: 'edge', id: r.id, label: r.label, src: r.src, tgt: r.tgt, props: propsOf(r.props), ordinal: r.o, ...inj(r) }));
  return rows.map((r) => ({ kind: 'vertex', id: r.id, ...foreignLabels(r.label), props: propsOf(r.props), ordinal: r.o, ...inj(r) }));
}
