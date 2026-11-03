// A Binary is a value class of its own at every seam it crosses — the parameter channel, storage, the
// GraphBinary framer, the readable JSON response, GraphSON and CSV. It rides as its bytes' hex TEXT
// tagged `binary` (`binaryCarrier`, src/gremlin/types.ts); the query-level compositions are pinned in
// test/L4-addendum/binary-values.feature, and what is here is what a `.feature` cannot spell: a `Buffer`
// PARAMETER, the format writers and readers, and the carrier's own rules.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { loadGraphson, writeGraphson, graphsonValue } from '../src/formats/graphson.ts';
import { writeCsv } from '../src/formats/csv.ts';
import { binaryOfBase64, base64OfBinary, declaredTypeOf } from '../src/gremlin/types.ts';
import { paramEnv } from '../src/gremlin/param-env.ts';
import { untyped } from '../src/untyped.ts';
import { executeQuery } from './support/executor.ts';
import { decodeAll } from './support/decode.ts';

const fresh = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
const b64 = (x: unknown): unknown =>
  x instanceof Uint8Array ? `bin[${Buffer.from(x).toString('base64')}]` : Array.isArray(x) ? x.map(b64) : x;
const run = async (store: GraphStore, q: string, params: Record<string, unknown> = {}, types: Record<string, any> = {}) =>
  b64(await decodeAll(executeQuery(store, q, params, types)));

describe('the carrier', () => {
  test('one hex spelling per byte string, whatever the base64 spelling', () => {
    expect(binaryOfBase64('AQID')).toBe('010203');
    expect(binaryOfBase64('AA==')).toBe('00');
    expect(binaryOfBase64('AA')).toBe('00');
    expect(binaryOfBase64('')).toBe('');
    expect(base64OfBinary('010203')).toBe('AQID');
  });

  test('a spelling that is not base64 is refused, never decoded leniently', () => {
    for (const bad of ['A', 'A===', 'AQ=D', 'AQ*D', 'AA=']) expect(binaryOfBase64(bad)).toBeNull();
  });

  test('hex text order is unsigned byte order', () => {
    const sorted = [[0xff], [0x01, 0x02], [0x00], [0x7f, 0x80], [0x80]]
      .map((bytes) => binaryOfBase64(Buffer.from(bytes).toString('base64'))!).sort();
    expect(sorted).toEqual(['00', '0102', '7F80', '80', 'FF']);
  });
});

describe('a Binary PARAMETER', () => {
  test('a Buffer is typed binary and lands on its carrier, at any depth, its map-key type kept', () => {
    expect(declaredTypeOf(Buffer.from([1, 2, 3]))).toBe('binary');
    const env = paramEnv({ x: Buffer.from([1, 2, 3]), l: [Buffer.from([0])], m: new Map([[Buffer.from([255]), 1]]) });
    expect(env.values.x).toBe('010203');
    expect(env.values.l).toEqual(['00']);
    expect([...env.values.m.keys()]).toEqual(['FF']);
    expect(env.types.m).toEqual({ t: 'map', entries: { FF: { key: 'binary', value: 'int' } } });
  });

  test('answers, compares and stores as the bytes it carries', async () => {
    const store = fresh();
    const x = Buffer.from('AQID', 'base64');
    expect(await run(store, 'g.inject(x)', { x })).toEqual(['bin[AQID]']);
    expect(await run(store, 'g.inject(x).is(Binary("AQID"))', { x })).toEqual(['bin[AQID]']);
    expect(await run(store, 'g.inject(x).is("010203")', { x })).toEqual([]);
    expect(await run(store, 'g.inject(l).unfold()', { l: [x, Buffer.from([0])] })).toEqual(['bin[AQID]', 'bin[AA==]']);
    await run(store, 'g.addV("d").property("b", x)', { x });
    expect(await run(store, 'g.V().has("b", Binary("AQID")).values("b")')).toEqual(['bin[AQID]']);
    expect(await run(store, 'g.V().values("b").is(P.within(l))', { l: [x] })).toEqual(['bin[AQID]']);
  });
});

describe('the formats', () => {
  test('typed GraphSON writes g:Binary base64 and reads it back as the same Binary', async () => {
    const store = fresh();
    executeQuery(store, 'g.addV("d").property("b", Binary("AQID")).addV("e").addE("k").from(V().hasLabel("d")).property("eb", Binary("/w=="))', {});
    const document = writeGraphson(store);
    expect(document).toContain('{"@type":"g:Binary","@value":"AQID"}');
    expect(document).toContain('{"@type":"g:Binary","@value":"/w=="}');
    const copy = fresh();
    loadGraphson(copy, document);
    expect(await run(copy, 'g.V().values("b").is(P.typeOf(GType.BINARY))')).toEqual(['bin[AQID]']);
    expect(await run(copy, 'g.E().values("eb").is(P.typeOf(GType.BINARY))')).toEqual(['bin[/w==]']);
  });

  test('GraphSON v3 `gx:ByteBuffer` reads too, and a non-base64 payload fails closed', () => {
    expect(graphsonValue({ '@type': 'gx:ByteBuffer', '@value': 'AQID' })).toEqual({ value: '010203', type: 'binary' });
    expect(() => graphsonValue({ '@type': 'g:Binary', '@value': 'A' })).toThrow('unparseable g:Binary');
  });

  test('CSV widens a Binary to String, spelled base64', () => {
    const store = fresh();
    executeQuery(store, 'g.addV("d").property("b", Binary("AQID"))', {});
    const { vertices } = writeCsv(store);
    expect(vertices.split('\n')).toEqual(['~id,~label,b:String', '1,d,AQID']);
  });

  test('the readable JSON response spells a Binary base64, as a value and as a map key', () => {
    expect(untyped({ t: 'binary', v: '010203' })).toBe('AQID');
    expect(untyped({ t: 'map', v: [[{ t: 'binary', v: '00' }, 1]] })).toEqual({ 'AA==': 1 });
  });
});
