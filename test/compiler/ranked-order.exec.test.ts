// The RANKED-ORDER barrier (`src/compiler/rel/ranked-order.ts`) — a GLOBAL `order()` whose key SQL has no
// comparator for (a list, a map, a path: TinkerPop 4 ORDERABILITY recurses into collections). The head reads
// every traverser's key, JS dense-ranks the keys, and the resume re-lowers the whole chain joined to its
// rank. The L4 addendum (`ranked-order.feature`, `path-stream-rowops.feature`) pins the reference answers;
// this file pins the MECHANISM's contract — when the barrier is (and is not) taken, how the JS step ranks,
// and that it fails closed rather than raising after a head has run.
import { test, expect, describe } from 'bun:test';
import { compile, compilePlan, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { rankKeys, UNRANKED_KEY } from '../../src/compiler/rel/ranked-order.ts';
import { orderMapLocalValue, orderabilityCompare } from '../../src/compiler/rel/orderability.ts';
import { parseExactJson } from '../../src/json-exact.ts';
import { seededStore, storeSeededWith } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const framed = (q: string) => decodeAll(executeFramed(seededStore(), q).map((f) => f.buf));

describe('ranked order: when the barrier is taken', () => {
  test('a key SQL CAN compare keeps its single-statement plan — the barrier is a fallback, never a re-route', () => {
    for (const q of ['g.V().order().by("name")', 'g.V().order().by(__.out().count())', 'g.V().values("age").order().by(desc)']) {
      expect(compilePlan(q, {}).kind).toBe('sql');
    }
  });

  test('a LIST key is a segment whose head reads the DISTINCT key texts', () => {
    const plan = compilePlan('g.V().order().by(__.values("age").fold()).values("name")', {});
    expect(plan.kind).toBe('segment');
    if (plan.kind !== 'segment' || plan.mode !== 'sync') throw new Error('expected a sync segment');
    expect(plan.head?.sql).toMatch(/SELECT DISTINCT/);
    expect(plan.head?.binds ?? []).toEqual([]);
  });

  test('the resume carries the ranking as ONE json_each bind, whatever the stream size', () => {
    const plan = compilePlan('g.V().out().path().order().by(desc)', {});
    if (plan.kind !== 'segment' || plan.mode !== 'sync') throw new Error('expected a sync segment');
    const ranks = Array.from({ length: 500 }, (_, i) => `[${i}]`);
    const resumed = plan.resume(ranks.map((injectedValue) => ({ injectedValue })));
    if (resumed.kind !== 'sql' || resumed.compiled.kind !== 'read') throw new Error('expected a sql resume');
    expect(resumed.compiled.binds.length).toBe(1);
  });

  test('a rest of the chain nothing lowers stays UnsupportedTraversal — declined at compile time, not raised by the resume', () => {
    expect(() => compilePlan('g.V().out().out().path().order().by(desc).as("p").select("p")', {})).toThrow(UnsupportedTraversal);
  });

  test('a chain that WRITES declines: the resume re-reads the prefix, which a mutation could have moved', () => {
    expect(() => compilePlan('g.V().sideEffect(__.addV("x")).order().by(__.values("age").fold())', {})).toThrow(UnsupportedTraversal);
  });

  test('compile() refuses the segment the way it refuses every barrier', () => {
    expect(() => compile('g.V().order().by(__.values("age").fold())', {})).toThrow(/segment plan/);
  });
});

describe('ranked order: the JS step', () => {
  test('dense ranks by ORDERABILITY, the shorter list (a prefix) first', () => {
    expect(rankKeys(['[[1,2]]', '[[1]]', '[[]]', '[[0,9]]'], ['asc'])).toEqual([['[[]]', 0], ['[[0,9]]', 1], ['[[1]]', 2], ['[[1,2]]', 3]]);
  });

  test('keys ORDERABILITY calls equal share a rank even where their texts differ (1 and 1.0)', () => {
    const ranks = new Map(rankKeys(['[1]', '[1.0]', '[2]'], ['asc']));
    expect(ranks.get('[1]')).toBe(ranks.get('[1.0]'));
    expect(ranks.get('[2]')).toBe(ranks.get('[1]')! + 1);
  });

  test('each position keeps its own direction (Order.desc is the reversed comparator)', () => {
    const ranked = rankKeys(['[[1],"b"]', '[[1],"a"]', '[[2],"z"]'], ['desc', 'asc']).map(([text]) => text);
    expect(ranked).toEqual(['[[2],"z"]', '[[1],"a"]', '[[1],"b"]']);
  });

  test('duplicate key texts collapse to one entry', () => {
    expect(rankKeys(['[1]', '[1]', '[1]'], ['asc'])).toEqual([['[1]', 0]]);
  });
});

describe('order(Scope.local) over a MAP', () => {
  const pairs = [[{ t: 'string', v: 'b' }, { t: 'int', v: 1 }], [{ t: 'string', v: 'a' }, { t: 'int', v: 2 }], [{ t: 'string', v: 'c' }, { t: 'int', v: 1 }]];
  const keys = (sorted: unknown) => (sorted as [{ v: string }, unknown][]).map(([k]) => k.v);

  test('no by() is the identity Order.asc over the whole ENTRY — key, then value', () => {
    expect(keys(orderMapLocalValue([])(pairs))).toEqual(['a', 'b', 'c']);
  });

  test('by(Column.values) is STABLE on ties, by(Column.keys, desc) reverses the key order', () => {
    expect(keys(orderMapLocalValue([{ side: 'values', dir: 'asc' }])(pairs))).toEqual(['b', 'c', 'a']);
    expect(keys(orderMapLocalValue([{ side: 'keys', dir: 'desc' }])(pairs))).toEqual(['c', 'b', 'a']);
  });
});

describe('ranked order: end to end', () => {
  test('a path stream sorts element-wise and keeps its labels for a later select()', async () => {
    expect(await framed('g.V().out().out().as("head").path().order().by(desc).select("head").values("name")')).toEqual(['ripple', 'lop']);
  });

  test('a traverser carried through the sort is ITSELF afterwards — the element moves on', async () => {
    // peter (35) and josh (32) rank first; peter→lop, josh→ripple+lop.
    expect([...await framed('g.V().order().by(__.values("age").fold(), desc).by("name").limit(2).out().values("name")')].sort())
      .toEqual(['lop', 'lop', 'ripple']);
  });
});

describe('ranked order: the two statements must see ONE stream', () => {
  // The head ranks the keys of one run of the prefix; the resume sorts another. A prefix that DRAWS
  // (`SampleGlobalStep`/`CoinStep`/`OrderGlobalStep`'s shuffle, each an unseeded `java.util.Random`)
  // answers a different stream each run, so it declines rather than sorting by keys never ranked.
  test.each([
    'g.V().sample(3).order().by(__.out().values("name").fold()).values("name")',
    'g.V().coin(0.5).order().by(__.out().values("name").fold()).values("name")',
    'g.V().order().by(Order.shuffle).limit(3).order().by(__.out().values("name").fold()).values("name")',
    'g.V().order().by(__.out().sample(1).fold()).values("name")',
    'g.V().local(__.out().sample(1)).order().by(__.out().values("name").fold())',
  ])('a random prefix declines: %s', (q) => {
    expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);
  });

  test('a traverser whose key the head never ranked FAILS the resume — never sorts first as an unranked NULL', () => {
    const plan = compilePlan('g.V().order().by(__.out().values("name").fold()).values("name")', {});
    if (plan.kind !== 'segment' || plan.mode !== 'sync') throw new Error('expected a sync segment');
    const store = seededStore();
    const keys = (store.query(plan.head.sql, plan.head.binds) as { v: string }[]).map((row) => row.v);
    // Rank every key but one — what a head and a resume that disagreed on the stream would look like.
    const resumed = plan.resume(keys.slice(1).map((injectedValue) => ({ injectedValue })));
    if (resumed.kind !== 'sql' || resumed.compiled.kind !== 'read') throw new Error('expected a sql resume');
    const { sql, binds } = resumed.compiled;
    expect(() => store.query(sql, binds)).toThrow(UNRANKED_KEY);
  });

  test('the ranking is ONE materialized relation joined once, not a correlated lookup per traverser', () => {
    const plan = compilePlan('g.V().order().by(__.out().values("name").fold()).values("name")', {});
    if (plan.kind !== 'segment' || plan.mode !== 'sync') throw new Error('expected a sync segment');
    const resumed = plan.resume([{ injectedValue: '[null]' }]);
    if (resumed.kind !== 'sql' || resumed.compiled.kind !== 'read') throw new Error('expected a sql resume');
    expect(resumed.compiled.sql).toMatch(/AS MATERIALIZED \(SELECT json_extract/);
    expect(resumed.compiled.sql).toMatch(/LEFT JOIN/);
    // `json_each` appears once — in the ranking CTE — never inside the sort.
    expect(resumed.compiled.sql.match(/json_each/g)?.length).toBe(1);
  });
});

describe('order(Scope.local) by an ENTRY comparator over a NON-map head', () => {
  // `by(Order.desc)` reads as an entry comparator, but the map barrier owns it only over a MAP; over a
  // list it is the inline fold's, and a LATER barrier in the chain must still be found.
  test('a later split() barrier is reached', async () => {
    expect(await framed('g.V().values("name").fold().order(Scope.local).by(Order.desc).unfold().split("a")'))
      .toEqual([['v', 'd', 's'], ['ripple'], ['peter'], ['m', 'rko'], ['lop'], ['josh']]);
  });

  test('a later nested-list order(local) barrier is reached', async () => {
    expect(await framed('g.V().values("name").fold().order(Scope.local).by(Order.desc).unfold().fold().fold().order(Scope.local)'))
      .toEqual([[['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']]]);
  });
});

describe('select(label) where a SIDE EFFECT holds the same name', () => {
  // `Scoping.getScopeValue` returns the side effect before it asks the path
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:126-131`),
  // so reading the `as()` alias would answer the wrong scope; the builder cannot read the side effect, so
  // it declines.
  test.each([
    'g.withSideEffect("a",1).V().as("a").select("a")',
    'g.withSideEffect("a",1).V().as("a").path().select("a")',
  ])('declines rather than reading the alias: %s', (q) => {
    expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);
  });

  // The same precedence at EVERY scope reader, not only `select()`: a record host's `by(__.select(…))`
  // re-root, an element/scalar host's, `math`/`where`, and a side effect named by a keyed WRITER
  // (`aggregate('x')` registers `x` for the whole traversal, before the writer runs). Each answered off
  // the alias before `sideEffectShadowedLabel` (`ir/labels.ts`) declined the traversal up front.
  test.each([
    'g.withSideEffect("x",1).V().as("x").project("n").by("name").order().by(__.select("x").values("name"), Order.desc).select("n")',
    'g.withSideEffect("x",1).V().as("x").project("n").by("name").order().by(__.select("x").values("age")).select("n")',
    'g.withSideEffect("x",1).V().as("x").order().by(__.select("x").values("name"))',
    'g.withSideEffect("x",1).V().values("age").as("x").order().by(__.select("x"), Order.desc)',
    'g.withSideEffect("x",100).V().values("age").as("x").math("_ + x")',
    'g.withSideEffect("x",1).V().as("x").where("x", P.eq("x"))',
    'g.V().as("x").aggregate("x").project("a").by(__.select("x"))',
    'g.V().as("x").out().groupCount("x").by("name").select("x")',
    'g.V().repeat(__.as("x").out()).times(1).order().by(__.path().count(Scope.local)).aggregate("x")',
  ])('declines a side-effect-shadowed label at any reader: %s', (q) => {
    expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);
  });

  test('a label NOT shadowed still answers through the record re-root', async () => {
    expect(await framed('g.withSideEffect("y",1).V().as("x").project("n").by("name").order().by(__.select("x").values("name"), Order.desc).select("n")'))
      .toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
  });
});

describe('a by() key whose fold reads only the HOST — the aggregate stays per traverser', () => {
  // `label().fold()`/`id().fold()` fold a one-row body spelled entirely out of the host row. SQL evaluates
  // such an aggregate in the OUTER query, so it collapsed the whole host stream into one row — through the
  // ranked order a 6-vertex sort answered ONE vertex. The emitter now anchors an aggregate in its own
  // input (`unanchoredAggregate`, `src/rel/emit.ts`).
  test('order().by(label().fold()) keeps every traverser', async () => {
    expect(await framed('g.V().order().by(__.label().fold()).by("name").values("name")'))
      .toEqual(['josh', 'marko', 'peter', 'vadas', 'lop', 'ripple']);
    expect(await framed('g.V().order().by(__.label().fold()).count()')).toEqual([6]);
  });

  test('order().by(id().fold(), desc) is the reverse id order', async () => {
    expect(await framed('g.V().order().by(__.id().fold(), desc).values("name")'))
      .toEqual(['peter', 'ripple', 'josh', 'lop', 'vadas', 'marko']);
  });

  test('project() and groupCount() over the same fold are one list per host', async () => {
    const rows = await framed('g.V().project("n","k").by("name").by(__.label().fold())');
    expect(rows.map((m: Map<string, unknown>) => [m.get('n'), m.get('k')]))
      .toEqual([['marko', ['person']], ['vadas', ['person']], ['lop', ['software']], ['josh', ['person']], ['ripple', ['software']], ['peter', ['person']]]);
    const [counted] = await framed('g.V().groupCount().by(__.label().fold())');
    expect([...(counted as Map<unknown, number>).entries()]).toEqual([[['person'], 4], [['software'], 2]]);
  });
});

describe('a long past 2^53 compares EXACTLY (NumberHelper.compare, not a double)', () => {
  const store = storeSeededWith(['g.addV("a").property("n",9007199254740993L)', 'g.addV("a").property("n",9007199254740992L)']);
  const run = (q: string) => decodeAll(executeFramed(store, q).map((f) => f.buf));

  test('the ranked order sorts both directions', async () => {
    expect(await run('g.V().order().by(__.values("n").fold()).values("n")')).toEqual([9007199254740992n, 9007199254740993n]);
    expect(await run('g.V().order().by(__.values("n").fold(), desc).values("n")')).toEqual([9007199254740993n, 9007199254740992n]);
  });

  test('the map-local order sorts both directions', async () => {
    const keys = async (q: string) => [...((await run(q))[0] as Map<bigint, unknown>).keys()];
    expect(await keys('g.V().group().by("n").by("n").order(Scope.local).by(Column.values)')).toEqual([9007199254740992n, 9007199254740993n]);
    expect(await keys('g.V().group().by("n").by("n").order(Scope.local).by(Column.values, desc)')).toEqual([9007199254740993n, 9007199254740992n]);
  });
});

describe('orderability: numbers compare in their HIGHEST COMMON CLASS', () => {
  // `NumberHelper.compare` → `getHighestCommonNumberClass`
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:362-398,670-681).
  const long = (v: string) => ({ t: 'long', v });
  test.each([
    ['long vs long past 2^53 is exact', long('9007199254740993'), long('9007199254740992'), 1],
    ['long vs double widens the long to double (Java rounds it too)', long('9007199254740993'), { t: 'double', v: 9007199254740992 }, 0],
    ['int vs float compares as double (a Float rides as its Double)', { t: 'int', v: 16777217 }, { t: 'float', v: 16777216 }, 1],
    ['bigint vs double compares as BigDecimal', { t: 'bigint', v: '9007199254740993' }, { t: 'double', v: 9007199254740992 }, 1],
    ['bigdecimal vs double uses the double\'s shortest decimal', { t: 'bigdecimal', v: '0.1' }, { t: 'double', v: 0.1 }, 0],
    ['bigdecimal vs float uses the decimal of the Double it rides as', { t: 'bigdecimal', v: '0.1' }, { t: 'float', v: 0.1 }, 0],
    ['bigdecimal ignores scale', { t: 'bigdecimal', v: '1.50' }, { t: 'bigdecimal', v: '1.5' }, 0],
    ['NaN sorts after every number', Number.NaN, { t: 'double', v: Infinity }, 1],
  ] as const)('%s', (_name, a, b, sign) => {
    expect(Math.sign(orderabilityCompare(a, b))).toBe(sign);
    expect(Math.sign(orderabilityCompare(b, a)) + sign).toBe(0);
  });

  test('a BARE integral number past 2^53 DECLINES — it may be a rounded Long or a whole-valued Double, and they compare differently', () => {
    // An untyped column carries a wide INTEGER bare (`jsonMemberByTypeof`), so `JSON.parse` has already
    // rounded it; two distinct Longs would tie. Only the JSON text can tell, and this comparator has lost it.
    expect(() => orderabilityCompare(2 ** 53 + 2, 2 ** 53)).toThrow(UnsupportedTraversal);
    expect(() => orderabilityCompare(1e20, 2.5)).toThrow(UnsupportedTraversal);
    // A fractional, safe or non-finite bare number is still decided.
    expect(Math.sign(orderabilityCompare(2.5, 1))).toBe(1);
    expect(Math.sign(orderabilityCompare(Infinity, 1))).toBe(1);
  });

  test('the exact parse tells a wide Long (an INTEGER spelling) from a whole-valued Double (a point or exponent)', () => {
    // SQLite's JSON writer: an INTEGER has no point or exponent, a REAL always has one.
    const [a, b, c, d] = parseExactJson('[9007199254740993, 9007199254740992, 2.7e+19, 2.9000000000000000e+19]') as unknown[];
    expect(Math.sign(orderabilityCompare(a, b))).toBe(1); // two Longs that round together stay distinct
    expect(Math.sign(orderabilityCompare(c, d))).toBe(-1);
    expect(Math.sign(orderabilityCompare(c, a))).toBe(1); // Long vs Double compares as double (NumberHelper)
    // A raw number re-stringifies EXACTLY — what a value barrier re-injects.
    expect(JSON.stringify([a, c])).toBe('[9007199254740993,2.7e+19]');
    // A wide `v` under a tag keeps the tag's class.
    const [tagged] = parseExactJson('[{"t":"double","v":2.7e+19}]') as unknown[];
    expect(orderabilityCompare(tagged, c)).toBe(0);
    // A typed null leaf is a null (ORDERABILITY's lowest rung), never "a number with no value".
    expect(Math.sign(orderabilityCompare({ t: 'double', v: null }, 1))).toBe(-1);
  });

  test('an infinity meeting a BigDecimal raises BigDecimal.valueOf\'s own message', () => {
    expect(() => orderabilityCompare({ t: 'double', v: Infinity }, { t: 'bigdecimal', v: '1.5' }))
      .toThrow('Character I is neither a decimal digit number, decimal point, nor "e" notation exponential mark.');
  });
});

describe('a DOUBLE whose value is integral and past 2^53 orders as a double, at every comparator', () => {
  // `math()` answers a Double; SQLite's JSON writes 2.7e19 as an integral number `JSON.parse` reads back as
  // `27000000000000000000`. It was classed a Long and raised "lost precision" — after the head had run.
  test('a global order() over value lists', async () => {
    expect(await framed('g.V().hasLabel("person").local(__.values("age").math("_ * 1e18").fold()).order()'))
      .toEqual([[2.7e19], [2.9e19], [3.2e19], [3.5e19]]);
    expect(await framed('g.inject([1e20d],[2.5d]).order()')).toEqual([[2.5], [1e20]]);
  });

  test('dedup(Scope.local)', async () => {
    expect(await framed('g.inject([1e20d],[1e20d]).fold().dedup(Scope.local)')).toEqual([[[1e20]]]);
  });

  test('the ranked order, both directions', async () => {
    expect(await framed('g.V().hasLabel("person").order().by(__.values("age").math("_ * 1e18").fold()).values("name")'))
      .toEqual(['vadas', 'marko', 'josh', 'peter']);
    expect(await framed('g.V().hasLabel("person").order().by(__.values("age").math("_ * 1e16").fold(), desc).values("name")'))
      .toEqual(['peter', 'josh', 'marko', 'vadas']);
  });
});

describe('an aggregate is anchored by the COLUMNS it names, never by text inside a string literal', () => {
  // `concat("u17.")` inlines the literal `'u17.'`; a pattern over the rendered SQL read it as a reference
  // to the minted alias `u17`, so the host-only fold was left unanchored and collapsed the stream into one
  // row. The anchoring check now tokenizes the SQL (`qualifiers`, `src/rel/emit.ts`). The literals are
  // HARVESTED from the plan's own SQL, so each one is sure to spell a real alias of it.
  const aliases = (q: string): string[] => {
    const plan = compilePlan(q, {});
    const sql = plan.kind === 'sql' && plan.compiled.kind === 'read' ? plan.compiled.sql : '';
    return [...new Set(sql.match(/\b[A-Za-z_]+\d+\b/g) ?? [])];
  };

  test('order().by(label().concat(<alias>.).fold()) keeps every traverser', async () => {
    for (const literal of ['u17.', 'u2.', "'u2.", 'u2.u3.']) {
      expect(await framed(`g.V().order().by(__.label().concat("${literal}").fold()).count()`)).toEqual([6]);
    }
  });

  test('project().by(label().concat(<alias>.).fold()) is one list per host', async () => {
    const harvested = aliases('g.V().project("a").by(__.label().concat("zz.").fold())');
    expect(harvested.length).toBeGreaterThan(0);
    for (const alias of harvested) {
      const rows = await framed(`g.V().project("a").by(__.label().concat("${alias}.").fold())`);
      expect(rows.length).toBe(6);
    }
  });
});

describe('a from()/to() sub-path the reference may THROW on declines (Path.subPath)', () => {
  // `Path.subPath` throws couldNotLocatePathFromLabel/ToLabel and couldNotIsolatedSubPath
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Path.java:259-292);
  // the lowering's window answered an EMPTY path instead. `unlocatableSubPath` (ir/labels.ts).
  test.each([
    'g.V().out().path().from("a")',
    'g.V().out().path().from("a").order()',
    'g.V().as("a").out().path().to("b")',
    'g.V().as("a").out().as("b").path().from("b").to("a")',
    'g.V().as("a").out().simplePath().from("x")',
    'g.V().as("a").out().cyclicPath().to("x")',
    'g.V().as("a").fold().unfold().path().from("a")',
    'g.V().as("a").out().optional(__.out().as("b")).path().from("a").to("b")',
    'g.V().as("b").out().as("a").out().as("b").union(__.as("a"), __.identity()).path().from("a").to("b")',
    'g.V().local(__.out().path().from("a"))',
  ])('declines: %s', (q) => {
    expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);
  });

  test('a sub-path bound on every traverser, in order, still answers', async () => {
    expect(await framed('g.V().as("a").out().as("b").out().as("c").path().from("b").to("c").by("name").count()')).toEqual([2]);
    expect(await framed('g.V().as("a").union(__.out().as("a"), __.identity()).as("b").path().from("a").to("b").count()')).toEqual([12]);
  });
});

describe('order(Scope.local) by an entry comparator whose TAIL nothing lowers', () => {
  // The map barrier plans its resume at COMPILE time, as the ranked barrier does: a tail no lowering
  // covers declines with UnsupportedTraversal instead of raising ResumeGap after the head has run.
  test.each([
    'g.V().group().by(__.values("age")).order(Scope.local).by(Column.keys, desc).unfold().select(Column.values).unfold().values("name")',
    'g.V().group().by("name").by("age").order(Scope.local).by(Column.values).math("_ + 0")',
  ])('declines: %s', (q) => {
    expect(() => compilePlan(q, {})).toThrow(UnsupportedTraversal);
  });
});

describe('a COMPUTED long past 2^53 stays exact at every JS reader (an untyped column carries it bare)', () => {
  // `NumberHelper.add` on Longs is `Math.addExact` — an exact Long sum
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java), so two
  // sums that round to the same double are still two different Longs, ordered and kept apart exactly.
  // A=2^52+1, B=2^52+2, C=2^52: each y+y+3 is 2^53+5, 2^53+7, 2^53+3 — the first two round together.
  const ys = () => storeSeededWith([
    'g.addV("n").property("name","A").property("y",4503599627370497L)',
    'g.addV("n").property("name","B").property("y",4503599627370498L)',
    'g.addV("n").property("name","C").property("y",4503599627370496L)',
  ]);
  const run = (q: string) => decodeAll(executeFramed(ys(), q).map((f) => f.buf));
  const sums = '__.union(__.values("y"),__.values("y"),__.constant(3)).sum()';

  test('the ranked order ranks two Long sums that round together apart (the reference: C, A, B)', async () => {
    expect(await run(`g.V().order().by(${sums}.fold()).values("name")`)).toEqual(['C', 'A', 'B']);
    expect(await run(`g.V().order().by(${sums}.fold(), desc).values("name")`)).toEqual(['B', 'A', 'C']);
    // marko 2^53+29 vs vadas 2^53+27 — trunk's SQL-keyed `by(…sum())` order, through the ranked barrier.
    expect(await framed('g.V().hasLabel("person").order().by(__.union(__.constant(4503599627370496L), __.constant(4503599627370496L), __.values("age")).sum().fold()).values("name")'))
      .toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  test('a value barrier compares AND re-injects the exact sum — order(local), dedup(local), a global order()', async () => {
    const big = (n: number) => 9007199254740992n + BigInt(n);
    expect(await run(`g.V().local(${sums}.fold()).fold().order(Scope.local)`)).toEqual([[[big(3)], [big(5)], [big(7)]]]);
    expect(await run(`g.V().local(${sums}.fold()).fold().dedup(Scope.local)`)).toEqual([[[big(5)], [big(7)], [big(3)]]]);
    expect(await run(`g.V().local(${sums}.fold()).order()`)).toEqual([[big(3)], [big(5)], [big(7)]]);
  });

  test('the wire frames a folded wide sum as a Long, exactly — never a String, never a rounding', async () => {
    const big = (n: number) => 9007199254740992n + BigInt(n);
    expect(await run(`g.V().local(${sums}).fold()`)).toEqual([[big(5), big(7), big(3)]]);
    expect(await run(`g.V().local(${sums}.fold()).fold()`)).toEqual([[[big(5)], [big(7)], [big(3)]]]);
    expect(await run(`g.V().local(${sums}).fold().asString()`)).toEqual([`[${big(5)}, ${big(7)}, ${big(3)}]`]);
  });

  test('a map-local order by Column.values over wide sums', async () => {
    const [m] = await run(`g.V().group().by("name").by(${sums}).order(Scope.local).by(Column.values)`);
    expect([...(m as Map<string, unknown>).keys()]).toEqual(['C', 'A', 'B']);
  });
});

describe('a sub-path past a barrier that hands on the SAME traverser stays locatable', () => {
  // `DedupGlobalStep`/`RangeGlobalStep` are FilterSteps, `TailGlobalStep` pops its buffer, `OrderGlobalStep`/
  // `SampleGlobalStep` re-emit their TraverserSet (vendor/tinkerpop/gremlin-core/.../step/filter/,
  // .../step/util/CollectingBarrierStep.java) — the path, and the `as()` label on it, survive.
  test.each([
    ['g.V().as("a").out().limit(2).path().from("a").by("name")', [['marko', 'lop'], ['marko', 'vadas']]],
    ['g.V().as("a").out().order().by("name").limit(1).path().from("a").by("name")', [['marko', 'josh']]],
  ] as const)('%s', async (q, expected) => {
    const paths = (await framed(q)) as { objects: unknown[] }[];
    expect(paths.map((p) => p.objects).sort()).toEqual([...expected].map((e) => [...e]).sort());
  });

  test('a from-label bound AFTER the to-label declines — Path.subPath raises couldNotIsolatedSubPath there (Path.java:284)', () => {
    expect(() => compilePlan('g.V().as("a").out().as("b").in().as("a").simplePath().from("a").to("b").path()', {})).toThrow(UnsupportedTraversal);
  });
});
