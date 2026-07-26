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
// `*-v4.gbin` vectors (see test/serializers.test.ts).
//
// TODO(upstream): these are apache/tinkerpop gremlin-js TODOs — file a PR adding them.
// Once released, drop this module and the values land through the client's own ioc.

import { Buffer } from 'buffer';
import { BigDecimal, Duration } from './gremlin/types.ts';

// The client ioc has no shipped type declarations (see io.ts) — type it loosely.
type Ioc = any;

// The client's async byte reader. Deserialization is pull-based and async since
// apache/tinkerpop#3395 (response streaming), so these three serializers implement the same
// contract as the client's own: `deserializeValue(reader, flag, code)` reads a BARE value,
// `deserialize(reader)` reads the type byte first. SERIALIZATION stayed synchronous.
type StreamReader = {
  readUInt8(): Promise<number>;
  readBytes(n: number): Promise<Buffer>;
};

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
  async deserializeValue(reader: StreamReader, valueFlag: number): Promise<BigDecimal | null> {
    if (valueFlag === 1) return null;
    // intSerializer has a deserializeBare; bigInteger/long expose only the (reader, flag,
    // code) form, so pass flag 0x00 = "present, bare" for those.
    const scale = await this.ioc.intSerializer.deserializeBare(reader);
    const unscaled = await this.ioc.bigIntegerSerializer.deserializeValue(reader, 0x00, this.ioc.DataType.BIGINTEGER);
    return new BigDecimal(BigInt(unscaled), Number(scale));
  }
  async deserialize(reader: StreamReader): Promise<BigDecimal | null> {
    const type_code = await reader.readUInt8();
    if (type_code !== this.ioc.DataType.BIGDECIMAL) throw new Error('unexpected {type_code}');
    return this.deserializeValue(reader, await reader.readUInt8());
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
  async deserializeValue(reader: StreamReader, valueFlag: number): Promise<Duration | null> {
    if (valueFlag === 1) return null;
    const seconds = await this.ioc.longSerializer.deserializeValue(reader, 0x00, this.ioc.DataType.LONG);
    const nanos = await this.ioc.intSerializer.deserializeBare(reader);
    return new Duration(BigInt(seconds), Number(nanos));
  }
  async deserialize(reader: StreamReader): Promise<Duration | null> {
    const type_code = await reader.readUInt8();
    if (type_code !== this.ioc.DataType.DURATION) throw new Error('unexpected {type_code}');
    return this.deserializeValue(reader, await reader.readUInt8());
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
  async deserializeValue(reader: StreamReader, valueFlag: number): Promise<string | null> {
    if (valueFlag === 1) return null;
    // A char has NO length prefix — the UTF-8 width comes from the leading byte:
    // 0xxxxxxx=1, 110xxxxx=2, 1110xxxx=3, 11110xxx=4. Read that byte, then the rest.
    const b0 = await reader.readUInt8();
    const n = b0 < 0x80 ? 1 : b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
    const rest = n > 1 ? await reader.readBytes(n - 1) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from([b0]), rest]).toString('utf8');
  }
  async deserialize(reader: StreamReader): Promise<string | null> {
    const type_code = await reader.readUInt8();
    if (type_code !== this.ioc.DataType.CHAR) throw new Error('unexpected {type_code}');
    return this.deserializeValue(reader, await reader.readUInt8());
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
