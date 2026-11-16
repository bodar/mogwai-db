// The workload's ONE value comparison: a fully-qualified GraphBinary v4 value → a canonical, TYPED string.
//
// It reads the WIRE BYTES, not the `gremlin` client's decoded JS values, because the client decodes an
// Int and a Double to the same JS `number` — and `3` vs `3.0` is a wrong answer a user sees (root
// CLAUDE.md: "a wrong number class where the user sees it"). Both sides of a comparison go through this
// file: mogwai's `Framed.buf` in the test, and TinkerGraph's HTTP response body in the one-off golden
// generator (`scripts/workload-goldens/generate.ts`), so the two can only disagree about the ANSWER.
//
// The spelling (stable, human-readable, diffable in `goldens.json`):
//   null · true/false · "string" · 3i (Int) 3l (Long) 3s (Short) 3b (Byte) 3n (BigInteger)
//   0.5d (Double) 0.5f (Float) 3.14m (BigDecimal) · uuid[…] dt[ISO, offset] du[s.nanos] c[x] bin[base64]
//   [a,b] (List)  set[a,b] (Set, sorted)  {k:v,…} (Map, entries sorted — a Map's key order is not part
//   of its value)  path[a,b] (Path objects in order; step labels are not compared, as upstream)
//   v[id] e[id] (an element is compared BY ID, upstream's rule — label and properties are not part of
//   it)  vp[key=value] (a VertexProperty by key and value: its id is an implementation detail)
//   prop[key=value]  T.id / Direction.OUT / Merge.onCreate  tree{key:subtree,…}
//
// A LIST is ordered or not by the CALLER's choice (`orderedLists`): a fold over an unordered stream has
// no defined member order (docs/feature-support-matrix.md §17 "Unordered slices and terminal streams";
// L8 reverses it on purpose), so by default its members compare as a multiset. A Path is always
// ordered — its order is the traversal's history, never a scan accident.
//
// An element id renders WITHOUT its number class (`v[1]`, never `v[1l]`): which integer class an id
// carries is TinkerGraph's id-manager configuration, not part of the answer.

export interface CanonOptions {
  /** Keep a List's member order (true) or compare its members as a multiset (false, the default). */
  readonly orderedLists?: boolean;
}

/** One canonicalized top-level value with the traverser bulk it carried. */
export interface CanonValue { readonly text: string; readonly next: number }

const sortJoin = (xs: string[]) => [...xs].sort().join(',');

/** Canonicalize the fully-qualified value at `at`; returns its text and the offset just past it. */
export function canonAt(b: Uint8Array, at: number, opts: CanonOptions = {}): CanonValue {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  let o = at;
  const u8 = () => buf[o++]!;
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const i64 = () => { const v = buf.readBigInt64BE(o); o += 8; return v; };
  const str = () => { const n = i32(); const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const bigint = () => {
    const n = i32();
    if (n < 1) throw new Error(`canon: BigInteger length ${n}`);
    let v = BigInt('0x' + buf.toString('hex', o, o + n));
    if (buf[o]! & 0x80) v = BigInt.asIntN(n * 8, v);
    o += n;
    return v;
  };
  const num = (n: number | bigint) => (typeof n === 'number' && Object.is(n, -0) ? '-0' : String(n));

  // A bare id value (fully-qualified, but rendered without its class).
  const idText = (): string => {
    const t = fq();
    return t.replace(/^(-?\d+)[ilsbn]$/, '$1');
  };
  // A bare List of Strings (an element's labels) — read and discarded: labels are not compared.
  const bareList = (): string[] => { const n = i32(); const out: string[] = []; for (let i = 0; i < n; i++) out.push(fq()); return out; };

  function value(code: number, flag: number): string {
    switch (code) {
      case 0x01: return `${i32()}i`;
      case 0x02: return `${i64()}l`;
      case 0x26: { const v = buf.readInt16BE(o); o += 2; return `${v}s`; }
      case 0x24: { const v = buf.readInt8(o); o += 1; return `${v}b`; }
      case 0x23: return `${bigint()}n`;
      case 0x07: { const v = buf.readDoubleBE(o); o += 8; return `${num(v)}d`; }
      case 0x08: { const v = buf.readFloatBE(o); o += 4; return `${num(Math.fround(v))}f`; }
      case 0x22: { // BigDecimal: {scale: Int}{unscaled: BigInteger}
        const scale = i32(); const u = bigint();
        const neg = u < 0n; let digits = (neg ? -u : u).toString();
        if (scale > 0) { digits = digits.padStart(scale + 1, '0'); digits = digits.slice(0, -scale) + '.' + digits.slice(-scale); }
        else if (scale < 0) digits += '0'.repeat(-scale);
        return `${neg ? '-' : ''}${digits}m`;
      }
      case 0x03: return JSON.stringify(str());
      case 0x27: return u8() ? 'true' : 'false';
      case 0x0c: { const h = buf.toString('hex', o, o + 16); o += 16; return `uuid[${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}]`; }
      case 0x04: { // OffsetDateTime: {year Int}{month Byte}{day Byte}{nanos-of-day Long}{offset-seconds Int}
        const year = i32(); const month = u8(); const day = u8(); const nanos = i64(); const off = i32();
        const ms = Date.UTC(year, month - 1, day) + Number(nanos / 1_000_000n) - off * 1000;
        return `dt[${new Date(ms).toISOString()},${Number(nanos % 1_000_000n)}]`;
      }
      case 0x81: { const s = i64(); const n = i32(); return `du[${s}.${String(n).padStart(9, '0')}]`; }
      case 0x80: { // Char: one UTF-8 sequence, its length read from the lead byte
        const lead = buf[o]!; const n = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
        const s = buf.toString('utf8', o, o + n); o += n; return `c[${s}]`;
      }
      case 0x25: { const n = i32(); const s = buf.toString('base64', o, o + n); o += n; return `bin[${s}]`; }
      case 0x09: case 0x0b: { // List / Set; value_flag 0x02 = bulked (each member followed by a Long bulk)
        const n = i32(); const out: string[] = [];
        for (let i = 0; i < n; i++) {
          const m = fq();
          const bulk = flag === 0x02 ? Number(i64()) : 1;
          for (let k = 0; k < bulk; k++) out.push(m);
        }
        if (code === 0x0b) return `set[${sortJoin(out)}]`;
        return `[${opts.orderedLists ? out.join(',') : sortJoin(out)}]`;
      }
      case 0x0a: {
        const n = i32(); const out: string[] = [];
        for (let i = 0; i < n; i++) { const k = fq(); const v = fq(); out.push(`${k}:${v}`); }
        return `{${sortJoin(out)}}`;
      }
      case 0x11: { const id = idText(); bareList(); fq(); return `v[${id}]`; }
      case 0x0d: { // {id}{labels}{inVId}{inVLabels}{outVId}{outVLabels}{parent}{properties}
        const id = idText(); bareList(); fq(); bareList(); fq(); bareList(); fq(); fq();
        return `e[${id}]`;
      }
      case 0x12: { fq(); const label = bareList(); const v = fq(); fq(); fq(); return `vp[${label.map((l) => JSON.parse(l)).join('::')}=${v}]`; }
      case 0x0f: { const key = str(); const v = fq(); fq(); return `prop[${key}=${v}]`; }
      case 0x0e: { // Path: {labels: List<Set<String>>}{objects: List}
        fq();
        const tag = buf[o]!;
        if (tag !== 0x09) throw new Error(`canon: Path objects are not a List (0x${tag.toString(16)})`);
        o++; const f = u8(); if (f === 0x01) return 'path[]';
        const n = i32(); const objs: string[] = [];
        for (let i = 0; i < n; i++) objs.push(fq());
        return `path[${objs.join(',')}]`;
      }
      case 0x18: case 0x20: case 0x2e: {
        const name = JSON.parse(fq()) as string;
        return `${code === 0x18 ? 'Direction' : code === 0x20 ? 'T' : 'Merge'}.${name}`;
      }
      case 0x2b: {
        const tree = (): string => {
          const n = i32(); const out: string[] = [];
          for (let i = 0; i < n; i++) { const k = fq(); out.push(`${k}:${tree()}`); }
          return `tree{${sortJoin(out)}}`;
        };
        return tree();
      }
      case 0xfe: return 'null';
      default: throw new Error(`canon: no reader for GraphBinary type 0x${code.toString(16)}`);
    }
  }

  function fq(): string {
    const code = u8();
    if (code === 0xfd) { o++; return '<end>'; } // the response stream's end marker: {0xFD}{flag}{byte}
    const flag = u8();
    if (flag === 0x01) return 'null';
    return value(code, flag);
  }

  const text = fq();
  return { text, next: o };
}

/** Canonicalize one complete fully-qualified value (a mogwai `Framed.buf`). */
export const canon = (buf: Uint8Array, opts: CanonOptions = {}): string => canonAt(buf, 0, opts).text;

/**
 * Read a whole GraphBinary v4 HTTP RESPONSE body (what Gremlin Server — or mogwai's own HTTP edge —
 * returns for `Accept: application/vnd.graphbinary-v4.0`): `{version 0x84}{bulked}{value[,bulk]}…{marker}
 * {status Int}{message}{exception}`, the layout `GraphBinaryReader.readResponse` reads
 * (vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/structure/io/binary/internals/GraphBinaryReader.js).
 * Bulk is expanded into repeated values, so the result is the traverser multiset spelled out.
 */
export function canonResponse(body: Uint8Array, opts: CanonOptions = {}): { values: string[]; status: number; message: string | null; exception: string | null } {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (buf[0] !== 0x84) throw new Error(`canon: unsupported response version 0x${buf[0]?.toString(16)}`);
  const bulked = buf[1] === 0x01;
  let o = 2;
  const values: string[] = [];
  for (;;) {
    if (buf[o] === 0xfd) { o += 3; break; }
    const { text, next } = canonAt(buf, o, opts);
    o = next;
    let bulk = 1;
    if (bulked) { if (buf[o] !== 0x02) throw new Error('canon: bulk is not a Long'); bulk = Number(buf.readBigInt64BE(o + 2)); o += 10; }
    for (let i = 0; i < bulk; i++) values.push(text);
  }
  const status = buf.readInt32BE(o); o += 4;
  const nstr = (): string | null => {
    if (buf[o++] === 0x01) return null;
    const n = buf.readInt32BE(o); o += 4; const s = buf.toString('utf8', o, o + n); o += n; return s;
  };
  const message = nstr();
  const exception = nstr();
  return { values, status, message, exception };
}
