import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from './support/executor.ts';
import { ioc, StreamReader } from '../src/io.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { decode, decodeAll } from './support/decode.ts';
import { relirOff } from './support/harness.ts';

// End-to-end fidelity: write a typed collection property, read it back over GraphBinary,
// and assert every element/key survived write→storage→read→frame. Two lenses:
//   - JS-decoded VALUE (Date/Set/Map/BigInt are JS-distinguishable, so they prove the type),
//   - the raw GraphBinary TYPE BYTE per element (the definitive proof — a small long and an
//     int both JS-decode to a number, but their wire DataType differs; a uuid frames as a
//     16-byte UUID, not a look-alike string). The bug this feature fixes is elements being
//     re-inferred from their JS value by the client's container serializers.

const store = () => new GraphStore(new BunSqlite(':memory:'));
const dec = (b: Buffer) => decode(b);
const one = (s: GraphStore, g: string) => dec(executeQuery(s, g, {})[0]);
const D = ioc.DataType;

// The GraphBinary DataType code of each element of a fully-qualified LIST/SET buffer
// ([type,flag, int32 count, elements…]). One StreamReader walks the whole buffer — it owns
// the cursor, so peeking each element's leading type byte is just "read it, then let
// anySerializer consume the rest of that element" (no manual length arithmetic).
async function elementTypeCodes(buf: Buffer): Promise<number[]> {
  const body = buf.subarray(2); // skip container type byte + value flag
  const r = StreamReader.fromBuffer(body);
  const count = await r.readInt32BE();
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(body[r.position]); // the element's type byte, before anySerializer consumes it
    await ioc.anySerializer.deserialize(r);
  }
  return codes;
}

/** The type byte of every value in a fully-qualified GraphBinary MAP. This proves
 * record-field framing uses its declared scalar channel rather than JS inference. */
async function mapValueTypeCodes(buf: Buffer): Promise<number[]> {
  const body = buf.subarray(2);
  const r = StreamReader.fromBuffer(body);
  const count = await r.readInt32BE();
  const codes: number[] = [];
  for (let i = 0; i < count; i++) {
    await ioc.anySerializer.deserialize(r); // key
    codes.push(body[r.position]);
    await ioc.anySerializer.deserialize(r); // value
  }
  return codes;
}
const rawList = (s: GraphStore, g: string): Buffer => executeQuery(s, g, {})[0];

describe('typed collection values round-trip over GraphBinary', () => {
  test('mixed-type list: each element frames with its EXACT GraphBinary type', async () => {
    const s = store();
    const uuid = '0263f28b-eff9-4c17-8e33-0b41c74b6d4c';
    executeQuery(s, `g.addV('d').property('m',[1, 5L, UUID('${uuid}'), datetime('2024-01-02T03:04:05Z')])`, {});
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    // definitive: the per-element wire types (int/long distinguished; uuid a true UUID).
    expect(await elementTypeCodes(buf)).toEqual([D.INT, D.LONG, D.UUID, D.DATETIME]);
    // and the decoded values / JS-distinguishable types.
    const list = await dec(buf) as any[];
    expect(list[0]).toBe(1);
    expect(list[2]).toBe(uuid);
    expect(list[3] instanceof Date).toBe(true);
    expect((list[3] as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });

  test('long > 2^53 inside a list survives losslessly (no JS-number truncation)', async () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[9007199254740993L])", {}); // 2^53 + 2
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    expect(await elementTypeCodes(buf)).toEqual([D.LONG]);
    expect(await dec(buf)).toEqual([9007199254740993n]);
  });

  test('unfold() of a typed list frames each element by its own stored type', async () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[1, 5L, datetime('2024-01-02T03:04:05Z')])", {});
    const bufs = executeQuery(s, "g.V().values('m').is(typeOf(GType.LIST)).unfold()", {});
    expect(bufs.map((b) => b[0])).toEqual([D.INT, D.LONG, D.DATETIME]);
    expect(await dec(bufs[2]) instanceof Date).toBe(true);
  });

  test('set value frames as a GraphBinary Set (distinct from a List)', async () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('s',{1,2,3})", {});
    const buf = rawList(s, "g.V().values('s').is(typeOf(GType.SET))");
    expect(buf[0]).toBe(D.SET);
    expect([...(await dec(buf) as Set<any>)].sort()).toEqual([1, 2, 3]);
  });

  test('bare values(listProp) (no is(typeOf)) frames the whole list, typed (#6)', async () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('m',[1, 5L])", {});
    const buf = rawList(s, "g.V().values('m')");
    expect(buf[0]).toBe(D.LIST);
    expect(await elementTypeCodes(buf)).toEqual([D.INT, D.LONG]);
  });

  test('map value: typed keys and values round-trip (bare values(mapProp), #6)', async () => {
    const s = store();
    executeQuery(s, "g.addV('d').property('data',[a:1,b:2])", {});
    const buf = executeQuery(s, "g.V().values('data')", {})[0];
    expect(buf[0]).toBe(D.MAP);
    const m = await dec(buf) as Map<any, any>;
    expect([...m.entries()]).toEqual([['a', 1], ['b', 2]]);
  });

  test('recursive nesting: list of maps, inner long values keep their type', async () => {
    const s = store();
    // >2^53 inner longs so the JS decode yields BigInt (proving LONG, not INT, framing).
    executeQuery(s, "g.addV('d').property('m',[[a:9007199254740993L],[b:9007199254740994L]])", {});
    const buf = rawList(s, "g.V().values('m').is(typeOf(GType.LIST))");
    expect(await elementTypeCodes(buf)).toEqual([D.MAP, D.MAP]);
    const list = await dec(buf) as any[];
    expect(list.map((x: Map<any, any>) => [...x.entries()])).toEqual([
      [['a', 9007199254740993n]], [['b', 9007199254740994n]],
    ]);
  });

  test('edge collection property round-trips typed elements too', async () => {
    const s = store();
    executeQuery(s, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('tags',['x', 5L])", {});
    const buf = rawList(s, "g.E().hasLabel('knows').values('tags').is(typeOf(GType.LIST))");
    expect(await elementTypeCodes(buf)).toEqual([D.STRING, D.LONG]);
  });
});

describe('record map fields preserve their scalar type channel', () => {
  test('a UUID property frames identically through values() and project().by(key)', async () => {
    const s = store();
    const uuid = 'c32f2a16-2dac-4f1e-a5a0-b3021db7ef5a';
    executeQuery(s, `g.addV('t').property('gid',UUID('${uuid}')).property('name','typed')`, {});

    const direct = rawList(s, "g.V().values('gid')");
    const projected = rawList(s, "g.V().project('gid','name').by('gid').by('name')");
    expect(direct[0]).toBe(D.UUID);
    expect(await mapValueTypeCodes(projected)).toEqual([D.UUID, D.STRING]);

    const decoded = await dec(projected) as Map<string, unknown>;
    expect(decoded.get('gid')).toBe(uuid);
    expect(decoded.get('name')).toBe('typed');
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

  test('g.V() (whole vertex) frames typed property values', async () => {
    const s = store(); seedTyped(s);
    const v = await dec(rawList(s, 'g.V()')) as any;
    const p = propsOf(v);
    expect(p.when instanceof Date).toBe(true);
    expect(p.gid).toBe(UUID);
    expect(p.big).toBe(9007199254740993n);
    expect(p.w).toBe(0.5);
  });

  test('valueMap() frames typed property values', async () => {
    const s = store(); seedTyped(s);
    const m = await dec(rawList(s, 'g.V().valueMap()')) as Map<string, any[]>;
    expect(m.get('when')![0] instanceof Date).toBe(true);
    expect(m.get('gid')![0]).toBe(UUID);
    expect(m.get('big')![0]).toBe(9007199254740993n);
  });

  test('elementMap() frames typed property values', async () => {
    const s = store(); seedTyped(s);
    const m = await dec(rawList(s, 'g.V().elementMap()')) as Map<string, any>;
    expect(m.get('when') instanceof Date).toBe(true);
    expect(m.get('big')).toBe(9007199254740993n);
  });

  test('properties() frames a typed VertexProperty value', async () => {
    const s = store(); seedTyped(s);
    const vps =await decodeAll( executeQuery(s, "g.V().properties('when','big')", {})) as any[];
    const byKey = Object.fromEntries(vps.map((vp) => [vp.label, vp.value]));
    expect(byKey.when instanceof Date).toBe(true);
    expect(byKey.big).toBe(9007199254740993n);
  });

  test('the write-response echo frames typed property values (same fidelity as a read)', async () => {
    const s = store();
    const v = (await decodeAll(seedTyped(s)))[0] as any; // the addV echo
    const p = propsOf(v);
    expect(p.when instanceof Date).toBe(true);
    expect(p.gid).toBe(UUID);
    expect(p.big).toBe(9007199254740993n);
  });

  // Regression (review finding #1): a collection-VALUED property through the valueMap
  // re-entry (select(Column.values)) must round-trip as a real nested list, not a
  // double-encoded string. The re-entry uses the BARE props aggregation.
  test('valueMap().select(values).unfold() of a collection-valued property → nested list', async () => {
    const s = store();
    executeQuery(s, "g.addV('t').property('tags',['a','b'])", {});
    const out =await decodeAll( executeQuery(s, "g.V().valueMap('tags').select(Column.values).unfold()", {}));
    // unfold yields the tags key's value-list [ ['a','b'] ]; the inner ['a','b'] is a REAL
    // nested List (not a double-encoded string) — the finding-#1 regression.
    expect(out).toEqual([[['a', 'b']]]);
  });

  test('edge whole-element + valueMap frame a typed edge-property value', async () => {
    const s = store();
    executeQuery(s, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('since',datetime('2024-01-02T03:04:05Z'))", {});
    const e = await dec(rawList(s, 'g.E()')) as any;
    expect(e.properties[0].value instanceof Date).toBe(true);
    // AN EDGE `valueMap()` VALUE IS THE VALUE ITSELF, NOT A LIST, and the reference is unambiguous:
    // `PropertyMapStep.addElementProperties` collects into a list only `if (isVertex)` and otherwise
    // does `map.put(key, value)`. The corpus pins it too, indirectly but decisively —
    // `integrated/SubgraphStrategy.feature:713-724` asserts `outE().valueMap().select(Column.values).
    // unfold()` yields `d[5].i`, which it could not if the value side were `[5]`. Legacy wraps it, so
    // this is per-spine: what the test is about either way is that the DATE survives typed.
    const m = await dec(rawList(s, "g.E().valueMap()")) as Map<string, any>;
    const since = m.get('since');
    expect((relirOff ? since[0] : since) instanceof Date).toBe(true);
  });
});

// A COMPUTED container (fold/aggregate/dedup/groupCount key) must carry each member's stored
// type exactly like a STORED collection does. The value rides with its per-row `vtype` column
// up to the barrier; the barrier keeps only the compile-time `as` tag, so a stored
// datetime/uuid/long collapses to its bare storage class (epoch-millis Long / a look-alike
// String / an Int) the moment it enters a container.
//
// PENDING the single-type-channel work (docs/outstanding-work.md). These are written as the
// specification of the target behaviour, and dedup() below already meets it.
//
// The obvious fix — fold {t,v} nodes and mark ListOf `typed`, the encoding a STORED typed
// collection uses — was tried and reverted: it is not free. The list rebuild/transform ops
// (order/dedup/limit(Scope.local), the set-op family) read members as BARE SQL values and
// fail closed on a `typed` list (assertUntypedList, list.ts), so always-wrapping turns
// working traversals into deferrals. Wrapping only the rows that NEED it (a type storage
// class cannot express) mixes encodings within one list, which the typed readers do not
// handle: list.ts's unfold does `je.value ->> '$.v'` unconditionally. Making the members
// uniformly typed requires a runtime, per-list decision — i.e. the channel unification, not
// a barrier-local patch.
describe('computed containers preserve each member\'s stored type', () => {
  const UUID = '0263f28b-eff9-4c17-8e33-0b41c74b6d4c';
  // Two vertices so a fold has >1 member; `big` is >2^53 to prove LONG (not INT) framing.
  const seed = (s: GraphStore) => {
    executeQuery(s, `g.addV('t').property('when',datetime('2024-01-02T03:04:05Z')).property('gid',UUID('${UUID}')).property('big',9007199254740993L)`, {});
    executeQuery(s, `g.addV('t').property('when',datetime('2025-06-07T08:09:10Z')).property('gid',UUID('11111111-2222-3333-4444-555555555555')).property('big',9007199254740995L)`, {});
  };

  test('fold() of a datetime property keeps DATETIME per element', async () => {
    const s = store(); seed(s);
    const buf = rawList(s, "g.V().values('when').fold()");
    expect(await elementTypeCodes(buf)).toEqual([D.DATETIME, D.DATETIME]);
    expect((await dec(buf) as any[]).every((d) => d instanceof Date)).toBe(true);
  });

  test('fold() of a uuid property keeps UUID (not a look-alike String)', async () => {
    const s = store(); seed(s);
    expect(await elementTypeCodes(rawList(s, "g.V().values('gid').fold()"))).toEqual([D.UUID, D.UUID]);
  });

  test('fold() of a long property keeps LONG (not Int) and stays lossless', async () => {
    const s = store(); seed(s);
    const buf = rawList(s, "g.V().values('big').fold()");
    expect(await elementTypeCodes(buf)).toEqual([D.LONG, D.LONG]);
    expect(await dec(buf)).toEqual([9007199254740993n, 9007199254740995n]);
  });

  test('fold().unfold() round-trips the element type back onto the scalar stream', () => {
    const s = store(); seed(s);
    const bufs = executeQuery(s, "g.V().values('when').fold().unfold()", {});
    expect(bufs.map((b) => b[0])).toEqual([D.DATETIME, D.DATETIME]);
  });

  test('aggregate().cap() keeps the member type', async () => {
    const s = store(); seed(s);
    expect(await elementTypeCodes(rawList(s, "g.V().values('when').aggregate('a').cap('a')"))).toEqual([D.DATETIME, D.DATETIME]);
  });

  test('dedup() keeps the per-row stored type', () => {
    const s = store(); seed(s);
    const bufs = executeQuery(s, "g.V().values('when').dedup()", {});
    expect(bufs.map((b) => b[0])).toEqual([D.DATETIME, D.DATETIME]);
  });

  test('dedup() does NOT collapse equal values of different stored types', () => {
    const s = store();
    // the same digits stored as a long and as a string are distinct Gremlin values
    executeQuery(s, "g.addV('t').property('k',5L)", {});
    executeQuery(s, "g.addV('t').property('k','5')", {});
    const bufs = executeQuery(s, "g.V().values('k').dedup()", {});
    expect(bufs.map((b) => b[0]).sort()).toEqual([D.STRING, D.LONG].sort());
  });

  test('groupCount() frames a datetime KEY as DATETIME', async () => {
    const s = store(); seed(s);
    const m = await dec(rawList(s, "g.V().values('when').groupCount()")) as Map<any, any>;
    expect([...m.keys()].every((k) => k instanceof Date)).toBe(true);
    // A groupCount value is a Java Long → Int64 on the wire, which the client decodes to a
    // JS Number in the safe range (see .claude/rules/wire-protocol.md — a BigInt here would
    // mean we'd wrongly framed it as GraphBinary BigInteger).
    expect([...m.values()]).toEqual([1, 1]);
  });

  test('groupCount() frames a uuid KEY as UUID', async () => {
    const s = store(); seed(s);
    const m = await dec(rawList(s, "g.V().values('gid').groupCount()")) as Map<any, any>;
    expect([...m.keys()].sort()).toEqual([UUID, '11111111-2222-3333-4444-555555555555'].sort());
  });

  test('a HETEROGENEOUS fold keeps each member its own exact type', async () => {
    const s = store();
    executeQuery(s, `g.addV('t').property('mixed',UUID('${UUID}'))`, {});
    executeQuery(s, "g.addV('t').property('mixed',7)", {});
    executeQuery(s, "g.addV('t').property('mixed',datetime('2024-01-02T03:04:05Z'))", {});
    const codes = await elementTypeCodes(rawList(s, "g.V().values('mixed').fold()"));
    expect(codes.sort()).toEqual([D.UUID, D.INT, D.DATETIME].sort());
  });

  test('an untyped computed scalar still folds unchanged (no vtype → old path)', async () => {
    const s = store(); seed(s);
    // count() is a computed long with no stored vtype column; must stay a plain Long list.
    expect(await elementTypeCodes(rawList(s, 'g.V().count().fold()'))).toEqual([D.LONG]);
  });
});

// The typed-literal SEED: a bare inject() of a datetime/uuid must carry its declared type, or
// is(typeOf(X)) filters every row out and the traversal silently returns []. The declared type
// arrives as a CanonicalType ('datetime'), which must be translated to the framing ValueType
// ('date') — the two vocabularies differ for exactly this type.
describe('bare inject() of a typed literal keeps its declared type', () => {
  const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  test('inject(datetime) frames as DATETIME', async () => {
    const buf = executeQuery(store(), `g.inject(datetime('2023-08-08T00:00:00Z'))`, {})[0];
    expect(buf[0]).toBe(D.DATETIME);
    expect(await dec(buf) instanceof Date).toBe(true);
  });

  test('inject(datetime).is(typeOf(DATETIME)) is not silently empty', async () => {
    const out = executeQuery(store(), `g.inject(datetime('2023-08-08T00:00:00Z')).is(typeOf(GType.DATETIME))`, {});
    expect(out.length).toBe(1);
    expect(await dec(out[0]) instanceof Date).toBe(true);
  });

  test('inject(UUID).is(typeOf(UUID)) is not silently empty', async () => {
    const out = executeQuery(store(), `g.inject(UUID('${UUID}')).is(typeOf(GType.UUID))`, {});
    expect(out.length).toBe(1);
    expect(out[0][0]).toBe(D.UUID);
    expect(await dec(out[0])).toBe(UUID);
  });

  test('a MIXED-type bare inject stays per-value inferred (unchanged)', () => {
    const out = executeQuery(store(), `g.inject(datetime('2023-08-08T00:00:00Z'), 'x')`, {});
    expect(out.length).toBe(2);
  });
});

// Review finding B1: a RECORD select (>1 distinct label) whose property label is read at
// Pop.all must frame each member as a real VertexProperty, exactly like the single-label
// path. The record path formerly reused the scalar `historyValues` (->> text extraction),
// which coerced each property object to a JSON STRING → framing read undefined vpid/pk/pv.
describe('property alias Pop.all in a record select frames real VertexProperties', () => {
  const seeded = () => {
    const s = store();
    for (const q of MODERN_SEED) executeQuery(s, q, {});
    return s;
  };
  test('select(Pop.all, propLabel, otherLabel) frames the property list, not string garbage', async () => {
    const s = seeded();
    // marko (V(1)) name property aliased at 'p'; a second label 'q' makes it a record select.
    const rec = await one(s, "g.V(1).as('q').properties('name').as('p').select(Pop.all, 'p', 'q')") as Map<string, any>;
    const vps = rec.get('p') as any[];
    expect(vps.length).toBe(1);
    expect(vps[0].label).toBe('name');
    expect(vps[0].value).toBe('marko');
  });
});
