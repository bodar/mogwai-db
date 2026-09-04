// ---------- typed GraphBinary RESPONSE decoder — the inverse of execute.ts's framing ----------
//
// The outbound side of federation-over-HTTP (docs/archive/2026-09-02-replication-and-http-interop-plan.md §8).
// Given a full GraphBinary v4 response frame from a PEER graph server — `HEADER | value* | trailer`,
// exactly what `src/http.ts` frames and `src/execute.ts` fills — reconstruct the SAME typed
// `ForeignResult` the in-process / DO-RPC `runForeign` produces (`src/execute.ts`), so a federated hop
// over HTTP is indistinguishable downstream from one over DO RPC.
//
// It is TYPE-PRESERVING where the stock client reader is not. `ioc.graphBinaryReader.readResponse`
// collapses a Long to a JS Number and a UUID/datetime to a String — fine for a Gremlin client, fatal
// for us: a federated element's props and a pushed reducer's scalar must keep their exact Gremlin type
// so a LOCAL tail over the detached result (`has("age", gt(30))`, `order().by("age")`) is correct at
// depth. So we walk the frame ourselves and capture each value's wire DataType as the node's `t` tag
// (`WIRE_TYPE_TO_NAME`) — the exact twin of `execute.ts`'s `foreignElementNode` / `foreignValueNodes` /
// the `{t,v}` scalar. Elements decode at ANY depth (a `fold()` of vertices is a LIST of VERTEX values),
// so the whole `ForeignResult` vocabulary composes rather than only the top level.
//
// The element field layouts mirror `execute.ts`'s `vertexBuffer` / `edgeBuffer` / `vertexPropertyBuffer`
// (which themselves mirror the client's Vertex/Edge/VertexProperty serializers — the client's READ side
// keeps properties; only its WRITE side hardcodes them empty, which is why our server hand-rolls the
// framing but no custom DESERIALIZER is needed here). This is the peer-facing decode substrate the
// replication protocol (Phase 3+) reuses.

import { ioc, StreamReader } from './io.ts';
import { WIRE_TYPE_TO_NAME } from './gremlin/types.ts';
import type { FrameNode, ValueNode } from './gremlin/types.ts';
import type { ForeignResult, ForeignRow, ForeignTerminal } from './api.ts';
import { DEFAULT_VERTEX_LABEL } from './api.ts';

const D = ioc.DataType;

/** The async pull reader the client's serializers read from (`StreamReader.fromBuffer` over a complete
 *  buffer resolves every read from memory — no I/O). Only the cursor primitives we drive by hand. */
interface Reader {
  readUInt8(): Promise<number>;
  readInt32BE(): Promise<number>;
}

// GraphBinary v4 response status codes that are NOT errors (GraphBinaryReader#readStatus / StatusCode).
const OK_STATUS = new Set([200, 204, 206]);

/**
 * Decode a complete GraphBinary v4 response frame into a `ForeignResult`, tagged by the shape the peer
 * produced plus the `terminal` hint — the ONE thing the bytes cannot express (a collapsing reducer's
 * scalar vs a `values(k)` stream both arrive as plain values), passed exactly as the in-process
 * `runForeign` is told (`ForeignTerminal`). Throws the peer's error message on a non-OK status trailer,
 * so a federated hop surfaces a remote failure the same way a local one does.
 *
 * We always request `bulkResults=false` outbound, so the frame is FLAT (one value per traverser) — the
 * true multiset as one `ForeignRow`/node each, no per-value Long multiplicity to expand.
 */
export async function decodeForeignResult(buffer: Buffer, terminal?: ForeignTerminal): Promise<ForeignResult> {
  const r = StreamReader.fromBuffer(buffer) as Reader;
  const version = await r.readUInt8();
  if (version !== 0x84) throw new Error(`federate(http): unsupported GraphBinary response version 0x${version.toString(16)}`);
  await r.readUInt8(); // {bulked} — always false for us (flat frame)

  const nodes: FrameNode[] = [];
  for (;;) {
    const typeCode = await r.readUInt8();
    // End-of-stream marker (MarkerSerializer): {type_code=0xfd}{value_flag=0x00}{value=0x00}.
    if (typeCode === D.MARKER) { await r.readUInt8(); await r.readUInt8(); break; }
    nodes.push(await decodeNode(r, typeCode));
  }

  // {status}: {code:Int bare}{message:nullable String}{exception:nullable String} (GraphBinaryReader#readStatus).
  const code = await r.readInt32BE();
  const message = (await r.readUInt8()) === 0x00 ? await ioc.stringSerializer.deserializeValue(r, 0x00, D.STRING) : null;
  if ((await r.readUInt8()) === 0x00) await ioc.stringSerializer.deserializeValue(r, 0x00, D.STRING); // {exception} — read past
  if (!OK_STATUS.has(code)) throw new Error(message || `federate(http): peer returned status ${code}`);

  return assemble(nodes, terminal);
}

/** One fully-qualified value → a typed `FrameNode`. `typeCode` is pre-read by the frame loop for a
 *  top-level value; nested calls (list items, map entries, element property values) read it here. Every
 *  branch has consumed the type byte and then reads the value_flag, exactly as `AnySerializer.deserialize`
 *  does before dispatching to a serializer's `deserializeValue`. */
async function decodeNode(r: Reader, typeCode?: number): Promise<FrameNode> {
  const tc = typeCode ?? await r.readUInt8();
  const flag = await r.readUInt8();
  if (flag === 0x01) return { t: WIRE_TYPE_TO_NAME[tc] ?? null, v: null }; // typed null

  switch (tc) {
    case D.LIST:
    case D.SET: {
      const count = await r.readInt32BE();
      const items: FrameNode[] = [];
      for (let i = 0; i < count; i++) items.push(await decodeNode(r));
      return { t: tc === D.SET ? 'set' : 'list', v: items };
    }
    case D.MAP: {
      const count = await r.readInt32BE();
      const pairs: [FrameNode, FrameNode][] = [];
      for (let i = 0; i < count; i++) pairs.push([await decodeNode(r), await decodeNode(r)]);
      return { t: 'map', v: pairs };
    }
    case D.VERTEX: return { t: 'vertex', v: await decodeVertexPayload(r) };
    case D.EDGE: return { t: 'edge', v: await decodeEdgePayload(r) };
    default: {
      const t = WIRE_TYPE_TO_NAME[tc];
      if (t === undefined)
        throw new Error(`federate(http): cannot decode GraphBinary type 0x${tc.toString(16)} over HTTP federation`);
      // Reuse the client's own leaf serializer for the value (reuse-first) — we only own the TYPE tag.
      const v = await (ioc.serializers as Record<number, { deserializeValue(r: Reader, flag: number, code: number): Promise<any> }>)[tc].deserializeValue(r, flag, tc);
      return { t, v };
    }
  }
}

/** A bare (non-fully-qualified) value — no leading type byte. Used for a fq value the caller already
 *  knows the type of only in that it is opaque (an element `id`, a `parent` slot): read via the client
 *  serializer and return the raw JS value (an id is `string | number`, needs no `t` tag). */
async function decodeOpaque(r: Reader): Promise<any> {
  const tc = await r.readUInt8();
  const flag = await r.readUInt8();
  if (flag === 0x01) return null;
  return await (ioc.serializers as Record<number, { deserializeValue(r: Reader, flag: number, code: number): Promise<any> }>)[tc].deserializeValue(r, flag, tc);
}

/** Read a BARE list of strings ({label} in every element layout — `listSerializer.deserializeValue`
 *  with a 0x00 flag, exactly as `VertexSerializer` reads it). */
const decodeBareLabels = (r: Reader): Promise<string[] | null> =>
  ioc.listSerializer.deserializeValue(r as any, 0x00, D.LIST) as Promise<string[] | null>;

/** `{id} {label bare-list} {properties fq-LIST<VertexProperty>}` — `vertexBuffer`'s layout. The payload's
 *  `label` is the labels ARRAY (as `foreignElementNode` carries it); the top-level→`ForeignRow` adapter
 *  derives the scalar `.label` from it. */
async function decodeVertexPayload(r: Reader): Promise<Record<string, any>> {
  const id = await decodeOpaque(r);
  const labels = (await decodeBareLabels(r)) ?? [];
  const props = await decodeVertexProps(r);
  return { id, label: labels, props };
}

/** `{id}{label}{inVId=tgt}{inVLabel}{outVId=src}{outVLabel}{parent}{properties fq-LIST<Property>}` —
 *  `edgeBuffer`'s layout; endpoint labels ride empty by design and are read past. */
async function decodeEdgePayload(r: Reader): Promise<Record<string, any>> {
  const id = await decodeOpaque(r);
  const labels = (await decodeBareLabels(r)) ?? [];
  const tgt = await decodeOpaque(r);
  await decodeBareLabels(r);            // {inVLabel} — empty
  const src = await decodeOpaque(r);
  await decodeBareLabels(r);            // {outVLabel} — empty
  await decodeOpaque(r);               // {parent} — null
  const props = await decodeEdgeProps(r);
  return { id, label: labels[0], src, tgt, props };
}

/** A vertex's `{properties}` — a fq LIST of VertexProperty. Grouped BY KEY into arrays of
 *  `{t, v, vpid, meta}` nodes, exactly the store's per-key shape (`propsOf`): single-valued is an array
 *  of one, list-cardinality an array of N. */
async function decodeVertexProps(r: Reader): Promise<Record<string, { t: ValueNode['t']; v: any; vpid: any; meta: Record<string, ValueNode> | null }[]>> {
  await r.readUInt8();                 // {type_code} = LIST
  const flag = await r.readUInt8();
  if (flag === 0x01) return {};        // null properties list
  const count = await r.readInt32BE();
  const props: Record<string, any[]> = {};
  for (let i = 0; i < count; i++) {
    await r.readUInt8();               // {type_code} = VERTEXPROPERTY
    await r.readUInt8();               // {value_flag} = 0x00
    const vpid = await decodeOpaque(r);
    const key = ((await decodeBareLabels(r)) ?? [])[0];
    const value = await decodeNode(r) as any;
    await decodeOpaque(r);             // {parent} — null
    const meta = await decodeMeta(r);
    (props[key] ??= []).push({ t: value.t, v: value.v, vpid, meta });
  }
  return props;
}

/** An edge's `{properties}` — a fq LIST of Property. Edge properties are single-valued, so one
 *  `{t, v}` node per key (no vpid/meta). */
async function decodeEdgeProps(r: Reader): Promise<Record<string, ValueNode>> {
  await r.readUInt8();                 // {type_code} = LIST
  const flag = await r.readUInt8();
  if (flag === 0x01) return {};
  const count = await r.readInt32BE();
  const props: Record<string, ValueNode> = {};
  for (let i = 0; i < count; i++) {
    const p = await decodeProperty(r);
    props[p.key] = { t: p.t, v: p.v } as ValueNode;
  }
  return props;
}

/** One fq Property → `{key, t, v}`. `{key}` is a BARE string, `{value}` fq, `{parent}` fq (discarded). */
async function decodeProperty(r: Reader): Promise<{ key: string; t: ValueNode['t']; v: any }> {
  await r.readUInt8();                 // {type_code} = PROPERTY
  await r.readUInt8();                 // {value_flag} = 0x00
  const key = await ioc.stringSerializer.deserializeValue(r as any, 0x00, D.STRING) as string;
  const value = await decodeNode(r) as any;
  await decodeOpaque(r);               // {parent} — null
  return { key, t: value.t, v: value.v };
}

/** A VertexProperty's meta-`{properties}` (a fq LIST of Property). Empty → `null`, matching the store. */
async function decodeMeta(r: Reader): Promise<Record<string, ValueNode> | null> {
  await r.readUInt8();                 // {type_code} = LIST
  const flag = await r.readUInt8();
  if (flag === 0x01) return null;
  const count = await r.readInt32BE();
  if (count === 0) return null;
  const meta: Record<string, ValueNode> = {};
  for (let i = 0; i < count; i++) {
    const p = await decodeProperty(r);
    meta[p.key] = { t: p.t, v: p.v } as ValueNode;
  }
  return meta;
}

/** A decoded top-level VERTEX/EDGE `FrameNode` → a detached `ForeignRow`. A vertex payload's `label` is
 *  the labels array (`foreignElementNode`), so the scalar `.label` is its first (`Element.label()`'s
 *  "arbitrary label when multiple exist") with the labelless fallback. */
function frameNodeToForeignRow(n: { t: string; v: any }): ForeignRow {
  if (n.t === 'edge') return { kind: 'edge', id: n.v.id, label: n.v.label, src: n.v.src, tgt: n.v.tgt, props: n.v.props };
  const labels: string[] = n.v.label ?? [];
  return { kind: 'vertex', id: n.v.id, label: labels[0] ?? DEFAULT_VERTEX_LABEL, labels, props: n.v.props };
}

const asElement = (n: FrameNode): { t: 'vertex' | 'edge'; v: any } | null =>
  (n != null && typeof n === 'object' && !Array.isArray(n) && ((n as any).t === 'vertex' || (n as any).t === 'edge'))
    ? (n as any) : null;

/** Fold the decoded top-level nodes into the tagged `ForeignResult`, inferring the arm from the values
 *  plus the `terminal` hint — exactly the disambiguation the in-process `runForeign` does from
 *  `plan.shape` + `terminal`, but from the wire (no shape travels over GraphBinary):
 *   - ALL elements → `elements` (detached rows);
 *   - `terminal === 'reduce'` → a collapsed `scalar` (the sole value, or a null scalar for a reducer
 *     that emitted nothing over empty input — e.g. `sum()`, matching the store's `{t:null,v:null}`);
 *   - exactly one MAP and not a reducer → the `map` arm (federate's mapValues-injection transport, and
 *     a source-form map terminal);
 *   - otherwise a `values` STREAM. */
function assemble(nodes: FrameNode[], terminal?: ForeignTerminal): ForeignResult {
  const elems = nodes.map(asElement);
  if (nodes.length > 0 && elems.every((e) => e !== null))
    return { kind: 'elements', rows: elems.map((e) => frameNodeToForeignRow(e!)) };

  if (terminal === 'reduce') {
    const first = nodes[0] as ValueNode | undefined;
    return { kind: 'scalar', value: first ?? { t: null, v: null } };
  }

  if (nodes.length === 1 && (nodes[0] as any)?.t === 'map')
    return { kind: 'map', value: nodes[0] as Extract<ValueNode, { t: 'map' }> };

  return { kind: 'values', values: nodes };
}
