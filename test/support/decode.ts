// Decode a GraphBinary buffer back to a JS value — the assertion side of every wire test.
//
// The client's deserializers are ASYNC and read from a StreamReader (apache/tinkerpop#3395
// made deserialization streaming so `fetch` response bodies can be consumed incrementally).
// Over a COMPLETE buffer every read resolves straight from memory, so this is only async in
// signature, never in behaviour. `StreamReader.fromBuffer` is the client's own entry point
// for exactly that case.
//
// One helper rather than the sync `ioc.anySerializer.deserialize(b, true).v` line that used
// to be copy-pasted into ~34 assertions across a dozen files.
import { ioc, StreamReader } from '../../src/io.ts';

/** One fully-qualified GraphBinary value → its JS value. */
export const decode = async (buf: Buffer): Promise<any> =>
  ioc.anySerializer.deserialize(StreamReader.fromBuffer(buf));

/** Decode a list of buffers (a result set) in order. */
export const decodeAll = async (bufs: Buffer[]): Promise<any[]> => {
  const out: any[] = [];
  for (const b of bufs) out.push(await decode(b));
  return out;
};
