import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
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
