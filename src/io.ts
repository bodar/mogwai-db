// Reuse the Apache-2.0 GraphBinary serializers shipped in the gremlin client package
// (locked decision #4 — we never write serializers). All BARE specifiers: `gremlin/io` is
// the subpath export added upstream by apache/tinkerpop#3511 (merged 2026-07-15), so the
// deep relative `node_modules/...` paths this file used to carry are gone — the package's
// own `exports` map now resolves everything, which is also what a published consumer gets.
//
// The package resolves to the SUBMODULE via `bun link` (see scripts/init-submodule.sh):
// the conformance suite runs the submodule's client at master, and the server must frame
// with the same client version it is tested against. npm's newest v4 is 4.0.0-beta.2,
// ~300 commits behind and without the `./io` export. Both runtimes share this one module;
// there is no per-runtime divergence in the io layer.

// @ts-ignore - no shipped type declarations for this subpath export
import ioc from 'gremlin/io';
import { structure, process as gprocess } from 'gremlin';
// The async byte reader the deserializers pull from (sync deserialize(buffer) became
// async deserialize(reader) in apache/tinkerpop#3395, the response-streaming rework).
// The package's `exports` map has NO entry for the internals subpath and `exports` gates
// bare specifiers only — so this must stay a deep RELATIVE import, exactly the shape
// `gremlin/io` had before #3511 added it. Worth upstreaming the same way.
// @ts-ignore - deep import, no shipped type declarations for this subpath
import StreamReader from '../node_modules/gremlin/build/esm/structure/io/binary/internals/StreamReader.js';

const { Vertex, VertexProperty, Edge, Property } = structure;
// The T enum (id/key/label/value tokens). valueMap(true)/elementMap emit maps
// whose id/label keys are these tokens, not strings — the GLV deserializes them
// as T, so they must ride the wire as GraphBinary DataType.T (via EnumSerializer),
// which anySerializer picks automatically for an EnumValue instance.
const { t } = gprocess;

// Extend the reused client ioc with the three GraphBinary serializers it leaves as
// TODOs (BigDecimal/Char/Duration) — locked decision #4 reuse-FIRST allows fixing a
// client deficiency in our wire layer. Registration mutates ioc.serializers[code] (so
// inbound decode resolves them) + splices into anySerializer's ordered list. Done here,
// right after the client module is imported, so every ioc consumer sees the full set.
import { registerExtendedSerializers } from './serializers.ts';
registerExtendedSerializers(ioc);

export { ioc, StreamReader, Vertex, VertexProperty, Edge, Property, t };
