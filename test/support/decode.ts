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

/** A result rendered with its NUMBER CLASSES and signs — `1i`, `1L`, `1d`, `-0d`, `1f`, `[…]`, `set[…]`,
 *  `{k:v,…}` — for the assertions `decode` cannot make: the client hands back a JS number for an Int and
 *  a Double alike, and `-0` deep-equals `0` wherever it is nested. Covers the scalar, list, set and map
 *  codes; any other value renders as `<0x..>`, so an assertion on it fails visibly rather than passes. */
export const typedAll = (bufs: Buffer[]): string[] => bufs.map((buf) => typedValue(buf, 0)[0]);

function typedValue(b: Buffer, at: number): [string, number] {
  const code = b[at]!;
  let o = at + 2;
  if (b[at + 1] === 1) return ['null', o];
  const items = (n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) { const [text, next] = typedValue(b, o); out.push(text); o = next; }
    return out;
  };
  switch (code) {
    case 0x01: return [`${b.readInt32BE(o)}i`, o + 4];
    case 0x02: return [`${b.readBigInt64BE(o)}L`, o + 8];
    case 0x07: { const d = b.readDoubleBE(o); return [`${Object.is(d, -0) ? '-0' : d}d`, o + 8]; }
    case 0x08: { const f = b.readFloatBE(o); return [`${Object.is(f, -0) ? '-0' : f}f`, o + 4]; }
    case 0x03: { const n = b.readInt32BE(o); return [JSON.stringify(b.toString('utf8', o + 4, o + 4 + n)), o + 4 + n]; }
    case 0x27: return [b[o] ? 'true' : 'false', o + 1];
    case 0x09: { const n = b.readInt32BE(o); o += 4; return [`[${items(n).join(',')}]`, o]; }
    case 0x0b: { const n = b.readInt32BE(o); o += 4; return [`set[${items(n).join(',')}]`, o]; }
    case 0x0a: {
      const n = b.readInt32BE(o); o += 4;
      const kv = items(n * 2);
      return [`{${Array.from({ length: n }, (_, i) => `${kv[2 * i]}:${kv[2 * i + 1]}`).join(',')}}`, o];
    }
    // An ENUM (Direction / T / Merge): its element name is a fully-qualified String — `T.id` renders `T.id`.
    case 0x18: case 0x20: case 0x2e: {
      const [name, next] = typedValue(b, o);
      return [`${code === 0x18 ? 'Direction' : code === 0x20 ? 'T' : 'Merge'}.${JSON.parse(name)}`, next];
    }
    // Any other code has no width this renderer knows, so the rest of the buffer is unreadable: say so
    // as the whole result rather than hand the cursor past the end to the next item, which read an
    // `undefined` type code and threw a TypeError that looked like a SERVER fault (an elementMap's T keys).
    default:
      if (at !== 0) throw new Error(`typedAll: no renderer for GraphBinary code 0x${code.toString(16)} inside a container`);
      return [`<0x${code.toString(16)}>`, b.length];
  }
}
