// `is(typeOf(GType.X))` over every framing whose GType is known, and the MAP retype of a per-row-typed
// scalar. One fold (`predicate.ts` `typeOfExpr`'s static mode, by GType ASSIGNABILITY — `gremlin/types.ts`
// `assignable`) answers a map, a record, a path, an element and a property; a stored map-valued property
// retypes into the map tail through `continueAs`, so every map follower composes after it.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { bagOf, seededStore } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const heterogeneous = () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('d').property('name','m').property('m',[a:1,b:2,c:3])", {});
  executeQuery(store, "g.addV('d').property('name','s').property('m','text')", {});
  executeQuery(store, "g.addV('d').property('name','l').property('m',['x','y'])", {});
  executeQuery(store, "g.addV('d').property('name','n').property('m',7)", {});
  return store;
};
const values = async (store: GraphStore, g: string) => decodeAll(executeQuery(store, g, {}));

describe('is(typeOf(MAP)) over a per-row-typed scalar RETYPES to a map', () => {
  test('keeps only the map-valued rows, framed as maps', async () => {
    const store = heterogeneous();
    const [only] = await values(store, "g.V().values('m').is(typeOf(GType.MAP))");
    expect(only instanceof Map ? Object.fromEntries(only) : only).toEqual({ a: 1, b: 2, c: 3 });
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).count()")).toEqual([1]);
  });

  test('the map tail serves every follower', async () => {
    const store = heterogeneous();
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).count(local)")).toEqual([3]);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).select(values)")).toEqual([[1, 2, 3]]);
    expect(bagOf(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).select(keys).unfold()"))).toEqual(['a', 'b', 'c']);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).unfold().count()")).toEqual([3]);
  });

  test('composes inside local, where, union and after another type test', async () => {
    const store = heterogeneous();
    expect(await values(store, "g.V().local(__.values('m').is(typeOf(GType.MAP)).count(local))")).toEqual([3]);
    expect(await values(store, "g.V().where(__.values('m').is(typeOf(GType.MAP))).values('name')")).toEqual(['m']);
    expect(await values(store, "g.V().union(__.values('m').is(typeOf(GType.MAP)), __.values('m').is(typeOf(GType.MAP))).count(local)")).toEqual([3, 3]);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).is(typeOf(GType.MAP)).count()")).toEqual([1]);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.MAP)).is(typeOf(GType.LIST)).count()")).toEqual([0]);
  });

  test('a scalar column that holds no map answers nothing', async () => {
    expect(await values(seededStore(), "g.V().values('age').is(typeOf(GType.MAP))")).toEqual([]);
  });

  test('the LIST retype still keeps its own rows beside it', async () => {
    const store = heterogeneous();
    expect(await values(store, "g.V().values('m').is(typeOf(GType.LIST))")).toEqual([['x', 'y']]);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.LIST)).count(local)")).toEqual([2]);
  });
});

describe('is(typeOf(X)) over a framing whose GType is known folds at compile time', () => {
  const n = async (g: string) => (await values(seededStore(), g))[0];

  test('maps, records and paths', async () => {
    expect(await n("g.V().valueMap().is(typeOf(GType.MAP)).count()")).toBe(6);
    expect(await n("g.V().valueMap().is(typeOf(GType.LIST)).count()")).toBe(0);
    // `Tree extends HashMap`, not the reverse: a map is not a TREE.
    expect(await n("g.V().valueMap().is(typeOf(GType.TREE)).count()")).toBe(0);
    expect(await n("g.V().project('a').by('name').is(typeOf(GType.MAP)).count()")).toBe(6);
    expect(await n("g.V().path().is(typeOf(GType.PATH)).count()")).toBe(6);
    expect(await n("g.V().path().is(P.not(typeOf(GType.PATH))).count()")).toBe(0);
    expect(await n("g.V().valueMap().is(typeOf(GType.LIST).or(typeOf(GType.MAP))).count()")).toBe(6);
  });

  test('elements and properties, with PROPERTY over VPROPERTY', async () => {
    expect(await n("g.V().is(typeOf(GType.VERTEX)).count()")).toBe(6);
    expect(await n("g.V().is(typeOf(GType.EDGE)).count()")).toBe(0);
    expect(await n("g.E().is(typeOf(GType.EDGE)).count()")).toBe(6);
    expect(await n("g.V().where(__.is(typeOf(GType.VERTEX))).count()")).toBe(6);
    expect(await n("g.V().properties().is(typeOf(GType.VPROPERTY)).count()")).toBe(12);
    expect(await n("g.V().properties().is(typeOf(GType.PROPERTY)).count()")).toBe(12);
    expect(await n("g.E().properties().is(typeOf(GType.PROPERTY)).count()")).toBe(6);
    expect(await n("g.E().properties().is(typeOf(GType.VPROPERTY)).count()")).toBe(0);
  });

  test('NUMBER answers for every numeric GType, compile-time and per row', async () => {
    expect(await n("g.V().count().is(typeOf(GType.NUMBER))")).toBe(6);
    expect(await n("g.V().values('age').is(typeOf(GType.NUMBER)).count()")).toBe(4);
    expect(await n("g.V().values('name').is(typeOf(GType.NUMBER)).count()")).toBe(0);
    expect(await n("g.E().values('weight').is(typeOf('Number')).count()")).toBe(6);
  });

  test('a compile-time scalar is never a collection', async () => {
    expect(await values(seededStore(), "g.V().count().is(typeOf(GType.LIST))")).toEqual([]);
  });

  test('a value predicate over a non-scalar framing, or an unregistered type, still declines', () => {
    const store = seededStore();
    expect(() => executeQuery(store, "g.V().properties().is(P.eq(1))", {})).toThrow(UnsupportedTraversal);
    expect(() => executeQuery(store, "g.V().valueMap().is(P.eq(1))", {})).toThrow(UnsupportedTraversal);
    expect(() => executeQuery(store, "g.V().is(typeOf('NoSuchType'))", {})).toThrow(UnsupportedTraversal);
  });
});

describe('a SET retyped by is(typeOf(SET)) stays a Set wherever the value travels', () => {
  // SelectStep and fold/unfold hand the object back unchanged, so the value's own class survives:
  // the set marker rides on a label's history entry and on a folded member, not only on the stream.
  const withSet = () => {
    const store = heterogeneous();
    executeQuery(store, "g.addV('d').property('name','t').property('m',{'x','y'})", {});
    return store;
  };
  const isSetOf = (v: unknown, members: unknown[]) => {
    expect(v instanceof Set).toBe(true);
    expect([...(v as Set<unknown>)]).toEqual(members);
  };

  test('through as()/select(), a record field, and select(all)', async () => {
    const store = withSet();
    isSetOf((await values(store, "g.V().values('m').is(typeOf(GType.SET)).as('a').select('a')"))[0], ['x', 'y']);
    isSetOf((await values(store, "g.V().as('v').values('m').is(typeOf(GType.SET)).as('a').select('v','a').select('a')"))[0], ['x', 'y']);
    const [all] = await values(store, "g.V().values('m').is(typeOf(GType.SET)).as('a').select(all, 'a')");
    isSetOf((all as unknown[])[0], ['x', 'y']);
  });

  test('through fold() and back out of unfold(), at any depth', async () => {
    const store = withSet();
    isSetOf(((await values(store, "g.V().values('m').is(typeOf(GType.SET)).fold()"))[0] as unknown[])[0], ['x', 'y']);
    isSetOf((await values(store, "g.V().values('m').is(typeOf(GType.SET)).fold().unfold()"))[0], ['x', 'y']);
    isSetOf((await values(store, "g.V().values('m').is(typeOf(GType.SET)).fold().fold().unfold().unfold()"))[0], ['x', 'y']);
    isSetOf((await values(store, "g.V().values('m').is(typeOf(GType.SET)).fold().as('a').select('a').unfold()"))[0], ['x', 'y']);
    // `dedup(local)` makes a set (`DedupLocalStep` yields a LinkedHashSet): the same marker, the same road.
    expect((await values(seededStore(), "g.V().values('name').fold().dedup(local).fold().unfold()"))[0] instanceof Set).toBe(true);
  });

  test('a LIST stays a List on the same road', async () => {
    const store = withSet();
    expect(await values(store, "g.V().values('m').is(typeOf(GType.LIST)).as('a').select('a')")).toEqual([['x', 'y']]);
    expect(await values(store, "g.V().values('m').is(typeOf(GType.LIST)).fold().unfold()")).toEqual([['x', 'y']]);
  });

  test('order(local) UNMAKES a Set, wherever the result travels; a local slice keeps it', async () => {
    // `OrderLocalStep.map` collects any Collection with `Collectors.toList()` (OrderLocalStep.java:73-76),
    // so a sorted set is a List — through as()/select(), fold(), fold().unfold() and a local() body.
    // `RangeLocalStep` keeps a Set a LinkedHashSet, so a slice is the contrast.
    const store = seededStore();
    const sorted = ['josh', 'lop', 'ripple', 'vadas'];
    const prefix = "g.V().out().values('name').fold().dedup(local)";
    const isList = (v: unknown, members: unknown[]) => { expect(Array.isArray(v)).toBe(true); expect(v).toEqual(members); };
    isList((await values(store, `${prefix}.order(local)`))[0], sorted);
    isList((await values(store, `${prefix}.order(local).as('a').select('a')`))[0], sorted);
    isList((await values(store, `${prefix}.order(local).by(desc).as('a').select('a')`))[0], [...sorted].reverse());
    isList(((await values(store, `${prefix}.order(local).fold()`))[0] as unknown[])[0], sorted);
    isList((await values(store, `${prefix}.order(local).fold().unfold()`))[0], sorted);
    for (const v of await values(store, "g.V().local(__.out().values('name').fold().dedup(local).order(local)).as('s').select('s')")) expect(Array.isArray(v)).toBe(true);
    // A sorted list sliced is still a list; a set sliced is still a set; a sorted list re-deduped is a set again.
    isList((await values(store, `${prefix}.order(local).limit(local, 2)`))[0], ['josh', 'lop']);
    expect((await values(store, `${prefix}.limit(local, 2)`))[0] instanceof Set).toBe(true);
    expect((await values(store, `${prefix}.order(local).dedup(local)`))[0] instanceof Set).toBe(true);
    // The retyped Set takes the same road.
    isList((await values(withSet(), "g.V().values('m').is(typeOf(GType.SET)).order(local).by(desc).as('a').select('a')"))[0], ['y', 'x']);
  });

  test('a branch whose arms disagree on Set vs List declines rather than framing both as the first', () => {
    const store = withSet();
    expect(() => executeQuery(store, "g.V().union(__.values('m').is(typeOf(GType.SET)), __.values('m').is(typeOf(GType.LIST)))", {})).toThrow(UnsupportedTraversal);
    expect(() => executeQuery(store, "g.V().coalesce(__.values('m').is(typeOf(GType.LIST)), __.values('m').is(typeOf(GType.SET)))", {})).toThrow(UnsupportedTraversal);
  });

  test('a per-traverser map() body yields the stored collection itself', async () => {
    const store = withSet();
    expect(bagOf((await values(store, "g.V().map(__.values('m'))")).map((v) => v instanceof Set ? `set:${[...v]}` : v instanceof Map ? 'map' : JSON.stringify(v))))
      .toEqual(bagOf(['map', '"text"', '["x","y"]', 'set:x,y', '7']));
    isSetOf((await values(store, "g.V().map(__.values('m').is(typeOf(GType.SET)))"))[0], ['x', 'y']);
  });
});

describe('count(local) is a per-traverser map, not a seeded barrier', () => {
  // `CountLocalStep extends ScalarMapStep`: over an empty arm it emits nothing, so a coalesce falls
  // through to its fallback (only a GLOBAL count()/fold() seeds an answer from nothing).
  test('a coalesce arm ending in count(local) does not swallow the fallback', async () => {
    expect(bagOf(await values(heterogeneous(), "g.V().coalesce(__.values('m').is(typeOf(GType.MAP)).count(local), __.constant(-1))"))).toEqual(bagOf([3, -1, -1, -1]));
    expect(bagOf(await values(seededStore(), "g.V().coalesce(__.values('age').count(local), __.constant(-1))"))).toEqual(bagOf([1, 1, 1, 1, -1, -1]));
    expect(bagOf(await values(seededStore(), "g.V().coalesce(__.values('age').is(typeOf(GType.NUMBER)).count(local), __.constant(-1))"))).toEqual(bagOf([1, 1, 1, 1, -1, -1]));
    // A GLOBAL count still seeds 0 and exhausts the coalesce.
    expect(bagOf(await values(seededStore(), "g.V().coalesce(__.values('age').count(), __.constant(-1))"))).toEqual(bagOf([1, 1, 0, 1, 0, 1]));
  });
});

describe('is(typeOf(LIST|SET)) over a LIST framing stays a decline', () => {
  // The list framing does not name its GType: `cap()` of an undeclared `aggregate` frames a BulkSet — a
  // SET by GType (`BulkSet extends AbstractSet`) — as a plain list. Folding off the framing would answer
  // `cap('x').is(typeOf(LIST))` TRUE where the
  // reference answers nothing, so it declines until the framing carries the collection's GType.
  test('fold and cap decline rather than guess', () => {
    const store = seededStore();
    expect(() => executeQuery(store, "g.V().values('name').fold().is(typeOf(GType.LIST))", {})).toThrow(UnsupportedTraversal);
    expect(() => executeQuery(store, "g.V().values('name').aggregate('x').cap('x').is(typeOf(GType.LIST))", {})).toThrow(UnsupportedTraversal);
  });
});
