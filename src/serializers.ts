// ---------- our GraphBinary serializers for the types the client omits ----------
//
// The reused `gremlin` client ships ~30 GraphBinary serializers but leaves three
// core/extended types as unchecked TODOs (see GraphBinary.js header): BigDecimal
// (0x22), Char (0x80), Duration (0x81). Locked decision #4 is reuse-FIRST, not
// reuse-only — "where the client is deficient we fix it in our wire layer" — so we
// hand-roll these three here, idiomatic to the client's own internals (constructor
// registers into `ioc.serializers[code]`, FQ+bare `serialize`, `deserialize`,
// `canBeUsedFor`, `des_error` on failure). Each sub-field reuses a client serializer
// in its BARE form: a bare BigInteger IS `bigIntegerSerializer.serialize(v,false)`, a
// bare int32 is `intSerializer.serialize(v,false)`, a bare int64 is
// `longSerializer.serialize(v,false)`. Wire-verified against the gremlin-test
// `*-v4.gbin` vectors (see test/unit/serializers.test.ts).
//
// TODO(upstream): these are apache/tinkerpop gremlin-js TODOs — file a PR adding them.
// Once released, drop this module and the values land through the client's own ioc.

import { Buffer } from 'buffer';
import { BigDecimal, Duration } from './gremlin-types.ts';

// The client ioc has no shipped type declarations (see io.ts) — type it loosely.
type Ioc = any;
interface Decoded<T> { v: T | null; len: number; }

// ---------- BigDecimal (0x22) ----------
// Wire (FQ): [0x22, value_flag] {scale: int32 BE} {unscaled: BigInteger, bare}.
// value = unscaled × 10^(-scale). The unscaled bytes are byte-identical to a bare
// BigInteger (0x23) body — so we delegate to the client's bigIntegerSerializer.
class BigDecimalSerializer {
  constructor(private ioc: Ioc) {
    ioc.serializers[ioc.DataType.BIGDECIMAL] = this;
  }
  canBeUsedFor(value: unknown): boolean {
    return value instanceof BigDecimal;
  }
  serialize(item: BigDecimal | string | bigint | number | null | undefined, fullyQualifiedFormat = true): Buffer {
    if (item === undefined || item === null) {
      if (fullyQualifiedFormat) return Buffer.from([this.ioc.DataType.BIGDECIMAL, 0x01]);
      // bare null: scale 0 + a minimal one-byte BigInteger 0x00
      return Buffer.concat([this.ioc.intSerializer.serialize(0, false), Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00])]);
    }
    const bd = BigDecimal.from(item);
    const bufs: Buffer[] = [];
    if (fullyQualifiedFormat) bufs.push(Buffer.from([this.ioc.DataType.BIGDECIMAL, 0x00]));
    bufs.push(this.ioc.intSerializer.serialize(bd.scale, false));
    bufs.push(this.ioc.bigIntegerSerializer.serialize(bd.unscaled, false));
    return Buffer.concat(bufs);
  }
  deserialize(buffer: Buffer, fullyQualifiedFormat = true): Decoded<BigDecimal> {
    let len = 0;
    let cursor = buffer;
    try {
      if (buffer === undefined || buffer === null || !(buffer instanceof Buffer)) throw new Error('buffer is missing');
      if (buffer.length < 1) throw new Error('buffer is empty');
      if (fullyQualifiedFormat) {
        const type_code = cursor.readUInt8(); len++;
        if (type_code !== this.ioc.DataType.BIGDECIMAL) throw new Error('unexpected {type_code}');
        cursor = cursor.slice(1);
        if (cursor.length < 1) throw new Error('{value_flag} is missing');
        const value_flag = cursor.readUInt8(); len++;
        if (value_flag === 1) return { v: null, len };
        if (value_flag !== 0) throw new Error('unexpected {value_flag}');
        cursor = cursor.slice(1);
      }
      const { v: scale, len: sl } = this.ioc.intSerializer.deserialize(cursor, false);
      cursor = cursor.slice(sl); len += sl;
      const { v: unscaled, len: ul } = this.ioc.bigIntegerSerializer.deserialize(cursor, false);
      len += ul;
      return { v: new BigDecimal(BigInt(unscaled), Number(scale)), len };
    } catch (err) {
      throw this.ioc.utils.des_error({ serializer: this, args: arguments, cursor, err });
    }
  }
}

// ---------- Duration (0x81) ----------
// Wire (FQ): [0x81, value_flag] {seconds: int64 BE} {nanos: int32 BE} — a java.time
// Duration, where nanos is normalized to [0, 1_000_000_000) and seconds carries the
// floor (so a negative duration has seconds≤0, nanos≥0). Reuses longSerializer (bare
// int64) + intSerializer (bare int32).
class DurationSerializer {
  constructor(private ioc: Ioc) {
    ioc.serializers[ioc.DataType.DURATION] = this;
  }
  canBeUsedFor(value: unknown): boolean {
    return value instanceof Duration;
  }
  serialize(item: Duration | string | bigint | null | undefined, fullyQualifiedFormat = true): Buffer {
    if (item === undefined || item === null) {
      if (fullyQualifiedFormat) return Buffer.from([this.ioc.DataType.DURATION, 0x01]);
      return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // seconds=0, nanos=0
    }
    const d = Duration.from(item);
    const bufs: Buffer[] = [];
    if (fullyQualifiedFormat) bufs.push(Buffer.from([this.ioc.DataType.DURATION, 0x00]));
    bufs.push(this.ioc.longSerializer.serialize(d.seconds, false));
    bufs.push(this.ioc.intSerializer.serialize(d.nanos, false));
    return Buffer.concat(bufs);
  }
  deserialize(buffer: Buffer, fullyQualifiedFormat = true): Decoded<Duration> {
    let len = 0;
    let cursor = buffer;
    try {
      if (buffer === undefined || buffer === null || !(buffer instanceof Buffer)) throw new Error('buffer is missing');
      if (buffer.length < 1) throw new Error('buffer is empty');
      if (fullyQualifiedFormat) {
        const type_code = cursor.readUInt8(); len++;
        if (type_code !== this.ioc.DataType.DURATION) throw new Error('unexpected {type_code}');
        cursor = cursor.slice(1);
        if (cursor.length < 1) throw new Error('{value_flag} is missing');
        const value_flag = cursor.readUInt8(); len++;
        if (value_flag === 1) return { v: null, len };
        if (value_flag !== 0) throw new Error('unexpected {value_flag}');
        cursor = cursor.slice(1);
      }
      const { v: seconds, len: sl } = this.ioc.longSerializer.deserialize(cursor, false);
      cursor = cursor.slice(sl); len += sl;
      const { v: nanos, len: nl } = this.ioc.intSerializer.deserialize(cursor, false);
      len += nl;
      return { v: new Duration(BigInt(seconds), Number(nanos)), len };
    } catch (err) {
      throw this.ioc.utils.des_error({ serializer: this, args: arguments, cursor, err });
    }
  }
}

// ---------- Char (0x80) ----------
// Wire (FQ): [0x80, value_flag] {utf8 bytes of ONE codepoint, 1-4 bytes, NO length
// prefix}. The UTF-8 length is inferred from the leading byte's high bits. A Char is a
// 1-codepoint JS string — indistinguishable from a String by JS type, so canBeUsedFor
// returns FALSE (never auto-selected by anySerializer; a plain string stays a String).
// Char is only ever framed explicitly, from a value whose vtype is 'char'.
class CharSerializer {
  constructor(private ioc: Ioc) {
    ioc.serializers[ioc.DataType.CHAR] = this;
  }
  canBeUsedFor(): boolean {
    return false;
  }
  serialize(item: string | null | undefined, fullyQualifiedFormat = true): Buffer {
    if (item === undefined || item === null) {
      if (fullyQualifiedFormat) return Buffer.from([this.ioc.DataType.CHAR, 0x01]);
      return Buffer.from([0x00]);
    }
    // Exactly one Unicode codepoint. [...s] iterates by codepoint; a surrogate pair
    // counts as one. More than one → the caller mis-typed a String as a Char.
    const cps = [...String(item)];
    if (cps.length !== 1) throw new Error(`Char must be exactly one codepoint, got ${cps.length}`);
    const utf8 = Buffer.from(cps[0], 'utf8');
    const bufs: Buffer[] = [];
    if (fullyQualifiedFormat) bufs.push(Buffer.from([this.ioc.DataType.CHAR, 0x00]));
    bufs.push(utf8);
    return Buffer.concat(bufs);
  }
  deserialize(buffer: Buffer, fullyQualifiedFormat = true): Decoded<string> {
    let len = 0;
    let cursor = buffer;
    try {
      if (buffer === undefined || buffer === null || !(buffer instanceof Buffer)) throw new Error('buffer is missing');
      if (buffer.length < 1) throw new Error('buffer is empty');
      if (fullyQualifiedFormat) {
        const type_code = cursor.readUInt8(); len++;
        if (type_code !== this.ioc.DataType.CHAR) throw new Error('unexpected {type_code}');
        cursor = cursor.slice(1);
        if (cursor.length < 1) throw new Error('{value_flag} is missing');
        const value_flag = cursor.readUInt8(); len++;
        if (value_flag === 1) return { v: null, len };
        if (value_flag !== 0) throw new Error('unexpected {value_flag}');
        cursor = cursor.slice(1);
      }
      // UTF-8 length from the leading byte: 0xxxxxxx=1, 110x=2, 1110=3, 11110=4.
      const b0 = cursor.readUInt8();
      const n = b0 < 0x80 ? 1 : b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
      if (cursor.length < n) throw new Error('unexpected {value} length');
      const v = cursor.slice(0, n).toString('utf8');
      len += n;
      return { v, len };
    } catch (err) {
      throw this.ioc.utils.des_error({ serializer: this, args: arguments, cursor, err });
    }
  }
}

/** Register our three serializers onto the reused client `ioc`. Called once by io.ts
 *  right after it imports the client's GraphBinary module. Inbound decode works via
 *  `ioc.serializers[type_code]` (set in each constructor); outbound auto-selection for a
 *  BigDecimal/Duration instance riding inside a list/map goes through the anySerializer
 *  ordered list, so we splice them in near the front (both use instanceof — specific and
 *  safe). Char is intentionally NOT added (a 1-char string must stay a String). */
export function registerExtendedSerializers(ioc: Ioc): void {
  const bigDecimal = new BigDecimalSerializer(ioc);
  const duration = new DurationSerializer(ioc);
  new CharSerializer(ioc); // registers into ioc.serializers; not auto-selectable
  ioc.anySerializer.serializers.splice(1, 0, bigDecimal, duration);
}
