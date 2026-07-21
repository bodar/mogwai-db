import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from './support/executor.ts';
import { ioc } from '../src/io.ts';

// End-to-end fidelity: write a typed collection property, read it back over GraphBinary,
// and assert every element/key survived write→storage→read→frame. Two lenses:
//   - JS-decoded VALUE (Date/Set/Map/BigInt are JS-distinguishable, so they prove the type),
//   - the raw GraphBinary TYPE BYTE per element (the definitive proof — a small long and an
//     int both JS-decode to a number, but their wire DataType differs; a uuid frames as a
//     16-byte UUID, not a look-alike string). The bug this feature fixes is elements being
//     re-inferred from their JS value by the client's container serializers.

const store = () => new GraphStore(new BunSqlite(':memory:'));
const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
const one = (s: GraphStore, g: string) => dec(executeQuery(s, g, {})[0]);
const D = ioc.DataType;

// The GraphBinary DataType code of each element of a fully-qualified LIST/SET buffer
// ([type,flag, int32 count, elements…]) — advancing element-by-element via anySerializer.
function elementTypeCodes(buf: Buffer): number[] {
  let cur = buf.subarray(2); // skip container type byte + value flag
  const count = cur.readInt32BE(0); cur = cur.subarray(4);
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(cur[0]);
    const { len } = ioc.anySerializer.deserialize(cur, true);
    cur = cur.subarray(len);
  }
  return codes;
}
const rawList = (s: GraphStore, g: string): Buffer => executeQuery(s, g, {})[0];

describe('typed collection values round-trip over GraphBinary', () => {
  test('mixed-type list: each element frames with its EXACT GraphBinary type', () => {
    const s = store();
    const uuid = '0263f28b-eff9-4c17-8e33-0b41c74b6d4c';
    executeQuery(s, `g.addV('d').property('m',[1, 5L, UUID('${uuid}'), datetime('2024-01-02T03:04:05Z')])`, {});
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    // definitive: the per-element wire types (int/long distinguished; uuid a true UUID).
    expect(elementTypeCodes(buf)).toEqual([D.INT, D.LONG, D.UUID, D.DATETIME]);
    // and the decoded values / JS-distinguishable types.
    const list = dec(buf) as any[];
    expect(list[0]).toBe(1);
    expect(list[2]).toBe(uuid);
    expect(list[3] instanceof Date).toBe(true);
    expect((list[3] as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });

  test('long > 2^53 inside a list survives losslessly (no JS-number truncation)', () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[9007199254740993L])", {}); // 2^53 + 2
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    expect(elementTypeCodes(buf)).toEqual([D.LONG]);
    expect(dec(buf)).toEqual([9007199254740993n]);
  });

  test('unfold() of a typed list frames each element by its own stored type', () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[1, 5L, datetime('2024-01-02T03:04:05Z')])", {});
    const bufs = executeQuery(s, "g.V().values('m').is(typeOf(GType.LIST)).unfold()", {});
    expect(bufs.map((b) => b[0])).toEqual([D.INT, D.LONG, D.DATETIME]);
    expect(dec(bufs[2]) instanceof Date).toBe(true);
  });

  test('set value frames as a GraphBinary Set (distinct from a List)', () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('s',{1,2,3})", {});
    const buf = rawList(s, "g.V().values('s').is(typeOf(GType.SET))");
    expect(buf[0]).toBe(D.SET);
    expect([...(dec(buf) as Set<any>)].sort()).toEqual([1, 2, 3]);
  });

  test('bare values(listProp) (no is(typeOf)) frames the whole list, typed (#6)', () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[1, 5L])", {});
    const buf = rawList(s, "g.V().values('m')");
    expect(buf[0]).toBe(D.LIST);
    expect(elementTypeCodes(buf)).toEqual([D.INT, D.LONG]);
  });

  test('map value: typed keys and values round-trip (bare values(mapProp), #6)', () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('data',[a:1,b:2])", {});
    const buf = executeQuery(s, "g.V().values('data')", {})[0];
    expect(buf[0]).toBe(D.MAP);
    const m = dec(buf) as Map<any, any>;
    expect([...m.entries()]).toEqual([['a', 1], ['b', 2]]);
  });

  test('recursive nesting: list of maps, inner long values keep their type', () => {
    const s = store();
    // >2^53 inner longs so the JS decode yields BigInt (proving LONG, not INT, framing).
    executeQuery(s, "g.addV('d').property('m',[[a:9007199254740993L],[b:9007199254740994L]])", {});
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    expect(elementTypeCodes(buf)).toEqual([D.MAP, D.MAP]);
    const list = dec(buf) as any[];
    expect(list.map((x: Map<any, any>) => [...x.entries()])).toEqual([
      [['a', 9007199254740993n]], [['b', 9007199254740994n]],
    ]);
  });

  test('edge collection property round-trips typed elements too', () => {
    const s = store();
    executeQuery(s, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('tags',['x', 5L])", {});
    const buf = rawList(s, "g.E().hasLabel('knows').values('tags').is(typeOf(GType.LIST))");
    expect(elementTypeCodes(buf)).toEqual([D.STRING, D.LONG]);
  });
});

// #5: whole-element framing (valueMap/vertex/edge/properties/write-echo) must carry each
// property value's stored type, not let the client's serializers re-infer it from the JS
// value. datetime→Date, long>2^53→BigInt, and a decimal-string double are JS-distinguishable
// proofs the type survived the whole-element path.
describe('#5 whole-element framing carries scalar property types', () => {
  const UUID = '0263f28b-eff9-4c17-8e33-0b41c74b6d4c';
  const seedTyped = (s: GraphStore) =>
    executeQuery(s, `g.addV('t').property('when',datetime('2024-01-02T03:04:05Z')).property('gid',UUID('${UUID}')).property('big',9007199254740993L).property('w',0.5)`, {});
  // Decode a Vertex/VertexProperty and pull {key: value} (first value per key).
  const propsOf = (v: any): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const p of v.properties ?? []) if (!(p.label in out)) out[p.label] = p.value;
    return out;
  };

  test('g.V() (whole vertex) frames typed property values', () => {
    const s = store(); seedTyped(s);
    const v = dec(rawList(s, 'g.V()')) as any;
    const p = propsOf(v);
    expect(p.when instanceof Date).toBe(true);
    expect(p.gid).toBe(UUID);
    expect(p.big).toBe(9007199254740993n);
    expect(p.w).toBe(0.5);
  });

  test('valueMap() frames typed property values', () => {
    const s = store(); seedTyped(s);
    const m = dec(rawList(s, 'g.V().valueMap()')) as Map<string, any[]>;
    expect(m.get('when')![0] instanceof Date).toBe(true);
    expect(m.get('gid')![0]).toBe(UUID);
    expect(m.get('big')![0]).toBe(9007199254740993n);
  });

  test('elementMap() frames typed property values', () => {
    const s = store(); seedTyped(s);
    const m = dec(rawList(s, 'g.V().elementMap()')) as Map<string, any>;
    expect(m.get('when') instanceof Date).toBe(true);
    expect(m.get('big')).toBe(9007199254740993n);
  });

  test('properties() frames a typed VertexProperty value', () => {
    const s = store(); seedTyped(s);
    const vps = executeQuery(s, "g.V().properties('when','big')", {}).map(dec) as any[];
    const byKey = Object.fromEntries(vps.map((vp) => [vp.label, vp.value]));
    expect(byKey.when instanceof Date).toBe(true);
    expect(byKey.big).toBe(9007199254740993n);
  });

  test('the write-response echo frames typed property values (same fidelity as a read)', () => {
    const s = store();
    const v = seedTyped(s).map(dec)[0] as any; // the addV echo
    const p = propsOf(v);
    expect(p.when instanceof Date).toBe(true);
    expect(p.gid).toBe(UUID);
    expect(p.big).toBe(9007199254740993n);
  });

  // Regression (review finding #1): a collection-VALUED property through the valueMap
  // re-entry (select(Column.values)) must round-trip as a real nested list, not a
  // double-encoded string. The re-entry uses the BARE props aggregation.
  test('valueMap().select(values).unfold() of a collection-valued property → nested list', () => {
    const s = store();
    executeQuery(s, "g.addV('t').property('tags',['a','b'])", {});
    const out = executeQuery(s, "g.V().valueMap('tags').select(Column.values).unfold()", {}).map(dec);
    // unfold yields the tags key's value-list [ ['a','b'] ]; the inner ['a','b'] is a REAL
    // nested List (not a double-encoded string) — the finding-#1 regression.
    expect(out).toEqual([[['a', 'b']]]);
  });

  test('edge whole-element + valueMap frame a typed edge-property value', () => {
    const s = store();
    executeQuery(s, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('since',datetime('2024-01-02T03:04:05Z'))", {});
    const e = dec(rawList(s, 'g.E()')) as any;
    expect(e.properties[0].value instanceof Date).toBe(true);
    const m = dec(rawList(s, "g.E().valueMap()")) as Map<string, any[]>;
    expect(m.get('since')![0] instanceof Date).toBe(true);
  });
});
