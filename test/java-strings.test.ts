// JAVA STRING SEMANTICS AGAINST SQLITE'S — where the reference's `java.lang.String` and SQLite's text
// functions read the same string differently. Three readings:
//
//  - ORDER is SQLite's BINARY (code-point) order, a deliberate divergence (`docs/feature-support-matrix.md`).
//    Only astral vs U+E000..U+FFFF differs.
//  - CASE is SQLite's ASCII-only `upper`/`lower`, a deliberate divergence: `'é'` stays `'é'`.
//  - WHITESPACE. `split(null)` splits on `Character.isWhitespace`, the set `trim()` strips
//    (`JAVA_WHITESPACE`), not JS `\s`.
import { describe, expect, test } from 'bun:test';
import { seededStore } from './support/harness.ts';
import { executeQuery } from './support/executor.ts';
import { typedAll } from './support/decode.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { GraphStore } from '../src/storage.ts';
import type { GraphStore as Store } from '../src/storage.ts';

const answer = (store: Store, gremlin: string, params: Record<string, unknown> = {}): string[] =>
  typedAll(executeQuery(store, gremlin, params));
const runP = (gremlin: string, params: Record<string, unknown> = {}): string[] => answer(seededStore(), gremlin, params);
const str = (s: string): string => JSON.stringify(s);

// U+FFFF and U+E000 sit BELOW every astral character in code-point order (and above it in Java's UTF-16
// order) — the one place the two disagree. The answer is the code-point order, the same at every position.
const HI = '\uFFFF', PUA = '\uE000', EMOJI = '\u{1F600}';

describe('text ORDER is code-point order, at every position SQLite orders', () => {
  test.each([
    [`g.inject('${HI}','${EMOJI}').order()`, [str(HI), str(EMOJI)]],
    [`g.inject('${PUA}','${EMOJI}').max()`, [str(EMOJI)]],
    [`g.inject('${EMOJI}').is(gt('${PUA}'))`, [str(EMOJI)]],
    [`g.inject('${HI}','${EMOJI}').fold().order(local)`, [`[${str(HI)},${str(EMOJI)}]`]],
    [`g.withSack('${HI}').inject('${EMOJI}').sack(min).sack()`, [str(HI)]],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([...expected]);
  });

  test('STORED strings compare in the same order', () => {
    const store = seededStore();
    answer(store, `g.addV('t').property('s','${HI}').addV('t').property('s','${EMOJI}').addV('t').property('s','b')`);
    expect(answer(store, "g.V().hasLabel('t').order().by('s').values('s')")).toEqual([str('b'), str(HI), str(EMOJI)]);
    expect(answer(store, "g.V().hasLabel('t').values('s').max()")).toEqual([str(EMOJI)]);
  });

  test('ordinary text and numbers keep their order', () => {
    expect(runP("g.V().values('name').order()")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'].map(str));
    expect(runP("g.V().has('name', gt('m')).values('name')")).toEqual(['marko', 'vadas', 'ripple', 'peter'].map(str));
    expect(runP("g.V().values('age').order().by(desc)")).toEqual(['35i', '32i', '29i', '27i']);
    expect(runP("g.V().order().by('name').limit(2).values('name')")).toEqual(['josh', 'lop'].map(str));
  });
});

describe("toUpper()/toLower() are SQLite's ASCII case fold", () => {
  test.each([
    ["g.inject('é').toUpper()", 'é'], ["g.inject('ÉA').toLower()", 'Éa'], ["g.inject('éa').map(toUpper())", 'éA'],
  ] as const)('a non-ASCII character is left as it is: %s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([str(expected)]);
  });

  test('ASCII is folded, everything else passes through', () => {
    expect(runP("g.V().values('name').toUpper().order()")).toEqual(['JOSH', 'LOP', 'MARKO', 'PETER', 'RIPPLE', 'VADAS'].map(str));
    expect(runP("g.inject('MiXeD 1').toLower()")).toEqual([str('mixed 1')]);
    expect(runP(`g.inject('ab${EMOJI}日本').toUpper()`)).toEqual([str(`AB${EMOJI}日本`)]);
    expect(runP('g.inject(x).toUpper()', { x: 'a\u0000b' })).toEqual([str('A\u0000B')]);
  });
});

describe("split(null) splits on Java's whitespace — Character.isWhitespace, the set trim() strips", () => {
  test.each([
    ["g.inject('a\\u00a0b').split(null)", [`[${str('a\u00A0b')}]`]],   // NBSP is not Java whitespace
    ["g.inject('a\\ufeffb').split(null)", [`[${str('a\uFEFFb')}]`]],   // nor is the BOM
    ["g.inject('a\\u2007b').split(null)", [`[${str('a\u2007b')}]`]],   // nor the figure space
    ["g.inject('a\\u001cb').split(null)", [`[${str('a')},${str('b')}]`]], // the file separator IS
    ["g.inject(' a \\u3000 b\\t').split(null)", [`[${str('a')},${str('b')}]`]],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([...expected]);
  });
});

// TextP is Java's EXACT `startsWith`/`endsWith`/`contains` (`Text.java`), where SQLite's LIKE folds ASCII
// case; and a TextP combined by `or` is a disjunction the trigram seek must not narrow to one arm.
describe('TextP is case-exact and a combined TextP is seeked only by a necessary atom', () => {
  test.each([
    ["g.V().has('name', containing('ARK')).values('name')", []],
    ["g.V().values('name').is(startingWith('MA'))", []],
    ["g.V().has('name', endingWith('KO')).values('name')", []],
    ["g.V().has('name', endingWith('ko')).values('name')", ['"marko"']],
    ["g.V().has('name', notContaining('ARK')).count()", ['6L']],
    ["g.V().has('name', notEndingWith('rko')).count()", ['5L']],
    ["g.V().has('name', endingWith('')).count()", ['6L']],
    ["g.V().has('name', notStartingWith('')).count()", ['0L']],
    ["g.V().has('name', TextP.containing('ark').or(TextP.containing('osh'))).values('name')", ['"marko"', '"josh"']],
    ["g.V().has('name', TextP.containing('ark').or(P.eq('josh'))).values('name')", ['"marko"', '"josh"']],
    ["g.V().has('name', TextP.notContaining('ark').or(TextP.containing('osh'))).values('name')", ['"vadas"', '"lop"', '"josh"', '"ripple"', '"peter"']],
    ["g.V().has('name', TextP.notContaining('ark').and(TextP.containing('osh'))).values('name')", ['"josh"']],
    ["g.V().has('name', TextP.containing('ark').and(TextP.containing('mar'))).values('name')", ['"marko"']],
    ["g.E().outV().has('name', TextP.containing('ark').or(TextP.containing('osh'))).dedup().values('name')", ['"marko"', '"josh"']],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin).sort()).toEqual([...expected].sort());
  });
});

// asDate() of a run-time String is `DatetimeHelper.parse`, not SQLite's `unixepoch`: the shapes both read
// alike answer, everything else defers (SQLite answered NULL for a name, and normalized `02-30`).
describe('asDate() of a run-time String answers only where both date grammars agree', () => {
  const dated = (value: string): Store => {
    const store = seededStore();
    executeQuery(store, `g.addV('d').property('s', ${str(value)})`, {});
    return store;
  };
  test.each([['2020-08-02'], ['2020-08-02T10:11:12Z']])('%s answers', (value) => {
    expect(answer(dated(value), "g.V().hasLabel('d').values('s').asDate().asNumber()")).toEqual([`${Date.parse(value)}L`]);
  });
  test.each([['marko'], ['2020-02-30'], ['2020-08-02 10:11:12'], ['now']])('%s defers', (value) => {
    expect(() => answer(dated(value), "g.V().hasLabel('d').values('s').asDate()")).toThrow(/asDate\(\) of a value/);
  });
});

// FORMAT. `FormatStep` appends each token with `StringBuilder.append(Object)` — `String.valueOf`
// (`vendor/tinkerpop/gremlin-core/.../step/map/FormatStep.java:100,114`) — so every token is rendered by
// `asString()`'s one authority (`asStringOf`, `src/compiler/rel/receiver.ts`), never SQLite's text.
describe('format() renders every token as String.valueOf, or defers', () => {
  test.each([
    ["g.E().hasId(8).format('w=%{weight}')", 'w=1.0'],
    ["g.E().hasId(8).values('weight').format('%{_}')", '1.0'],
    ["g.E().hasId(8).format('%{_}').by(values('weight'))", '1.0'],
    ["g.E().hasId(8).project('w').by('weight').format('%{w}')", '1.0'],
    ["g.E().hasId(8).values('weight').as('w').V(1).format('%{name} %{w}')", 'marko 1.0'],
    ["g.V(1).local(__.outE().hasId(8).values('weight').format('%{_}'))", '1.0'],
    ["g.V(1).union(__.outE().hasId(8).format('%{weight}'))", '1.0'],
    ["g.inject(['a':true]).format('%{a}')", 'true'],
    ["g.inject(true).format('%{_}')", 'true'],
    ["g.inject(['a':0.1f]).format('%{a}')", '0.1'],
    ["g.inject(['a':-0.0d]).format('%{a}')", '0.0'],
    ["g.inject(['a':1.0d]).format('%{a}')", '1.0'],
    ["g.inject(1.5d).format('%{_}')", '1.5'],
    ["g.inject(2).format('%{_}')", '2'],
  ])('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([str(expected)]);
  });

  // `1.0E20`, `[x, y]` and `{x=1}` are Java renderings SQL does not reproduce: the token defers.
  test.each([
    ["g.inject(1e20d).format('%{_}')"], ["g.inject(['a':1e20d]).format('%{a}')"],
    ["g.inject(['a':['x','y']]).format('%{a}')"], ["g.inject(['a':['x':1]]).format('%{a}')"],
  ])('a token SQL cannot spell defers: %s', (gremlin) => {
    expect(() => runP(gremlin)).toThrow(/not supported/);
  });

  // An ELEMENT-valued scope key (`v[1]`), a side-effect key — a `withSideEffect` constant OR any keyed
  // writer's, wherever it stands — or a label bound past a re-rooting `V()` is read where the property is
  // ABSENT (`Scoping.getScopeValue`, `.../traversal/step/Scoping.java:119-131`), so an absent property must
  // not drop the traverser: the reference appends the scoped value. It defers, at every depth.
  test.each([
    ["g.V().as('a').out().format('%{a}')"], ["g.V().as('n').format('%{n}')"], ["g.withSideEffect('w',1).V().format('%{w}')"],
    ["g.V().aggregate('w').format('%{w}')"], ["g.V().aggregate('w').format('%{name}%{w}')"],
    ["g.V().groupCount('w').format('%{w}')"], ["g.V().group('w').by('name').format('%{w}')"],
    ["g.V().format('%{w}').aggregate('w')"], ["g.V().local(__.format('%{w}')).aggregate('w')"],
    ["g.V().aggregate('w').union(__.format('%{w}'))"], ["g.V().aggregate('w').project('f').by(__.format('%{w}'))"],
    ["g.V().values('age').as('x').project('a').by(__.V().has('name','marko').format('%{name}%{x}'))"],
  ])('a named token this cannot read defers rather than drop the traverser: %s', (gremlin) => {
    expect(() => runP(gremlin)).toThrow(/not supported/);
  });

  // ...but where the PROPERTY is present the scope is never read, so those answer exactly.
  test.each([
    ["g.V(1).as('name').format('%{name}')", ['marko']],
    ["g.V().has('age').as('age').format('%{age}')", ['29', '27', '32', '35']],
    ["g.V(1).aggregate('w').format('%{name}')", ['marko']],
    ["g.withSideEffect('w',1).V(1).format('%{name}')", ['marko']],
    // Existence alone: the token is productive either way, so nothing is read and nothing defers.
    ["g.V().union(__.format('%{w}'), __.aggregate('w')).count()", [12]],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual(expected.map((e) => typeof e === 'string' ? str(e) : `${e}L`));
  });

  // A MAP's token keys are `T.id`/`T.label` (and an edge's `Direction.IN`/`OUT`), never the strings
  // `"id"`/`"label"`: `containsKey("label")` is false (`Scoping.java:121`), nothing else binds the name,
  // and the token is unproductive — the traverser drops. The same one key match serves `select(k)`.
  test.each([
    ["g.V().elementMap().format('%{label}')"], ["g.V().elementMap().format('%{id}')"],
    ["g.V().valueMap(true).format('%{label}')"], ["g.E().elementMap().format('%{IN}')"],
    ["g.V().elementMap().select('label')"], ["g.V().elementMap().select('id')"], ["g.E().elementMap().select('OUT')"],
  ])('a T/Direction map key is not its string name: %s', (gremlin) => {
    expect(runP(gremlin)).toEqual([]);
  });

  // `Vertex.property(key)` THROWS over a key with several values (`.../gremlin/structure/Vertex.java:69-79`)
  // — the reference's own message, wherever the token is evaluated, existence-only positions included.
  const multi = (): Store => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    executeQuery(store, "g.addV('p').property('name','a').property(list,'x',1).property(list,'x',2)", {});
    executeQuery(store, "g.addV('p').property('name','b').property('x',3)", {});
    return store;
  };
  test.each([
    ["g.V().format('%{x}')"], ["g.V().format('%{x}').count()"], ["g.V().where(__.format('%{x}'))"],
    ["g.V().local(__.format('%{x}'))"], ["g.V().project('f').by(__.format('%{x}'))"], ["g.V().union(__.format('%{x}'))"],
  ])('a multi-valued property token raises the reference error: %s', (gremlin) => {
    expect(() => answer(multi(), gremlin)).toThrow('Multiple properties exist for the provided key, use Vertex.properties(x)');
  });
  test('a single-valued vertex still answers, and elementMap keeps the last value', () => {
    expect(answer(multi(), "g.V().has('name','b').format('%{x}')")).toEqual([str('3')]);
    expect(answer(multi(), "g.V().elementMap().format('%{x}')")).toEqual([str('2'), str('3')]);
  });

  // UNDER A SLICE the raise is the slice's to settle over the traversers the reference PULLS: it rides the
  // row and is met only where pulled. Where the statement may evaluate a traverser the reference never
  // pulls (past a `dedup()`), the token DEFERS rather than raise an error the reference may not.
  test('a multi-valued token under a slice raises exactly where pulled, or defers', () => {
    expect(() => answer(multi(), "g.V().format('%{x}').limit(1)")).toThrow('Multiple properties exist for the provided key, use Vertex.properties(x)');
    expect(answer(multi(), "g.V().has('name','b').format('%{x}').limit(1)")).toEqual([str('3')]);
    // The first token is unproductive on `b`... and `a`'s `y` is absent, so `x` is never read.
    expect(answer(multi(), "g.V().format('%{y}%{x}').limit(1)")).toEqual([]);
    expect(() => answer(multi(), "g.V().format('%{x}').dedup().limit(1)")).toThrow(/not supported|Multiple properties/);
  });

  // A slice after `format()` is a plain slice: every token kind above answers through it (the rendering's
  // deferral belongs to the value's READ, `FORMAT_STRING`), and a zero-width slice — whose input the
  // reference still pulls — declines over a token that may raise.
  test.each([
    ["g.V().format('%{name}').limit(2)", ['marko', 'vadas']],
    ["g.E().hasId(8).format('%{weight}').limit(1)", ['1.0']],
    ["g.V().values('name').format('%{_}').limit(1)", ['marko']],
    ["g.V().format('%{_}').by('name').limit(1)", ['marko']],
    ["g.V().elementMap().format('%{name}').limit(1)", ['marko']],
    ["g.V().format('%{name}').range(1,3)", ['vadas', 'lop']],
    ["g.V().format('%{name}').dedup().limit(2)", ['marko', 'vadas']],
    ["g.V().union(__.format('%{name}').limit(1), __.format('%{age}'))", ['marko', '29', '27', '32', '35']],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual(expected.map(str));
  });

  // `BigDecimal.toString()` is its carried decimal text exactly where that is the plain form — a scale of
  // zero or more and an adjusted exponent of -6 or more; `0.0000001m` is `1E-7` and `0.0000000m` `0E-7`.
  test.each([
    ["g.inject(3.5m).format('%{_}')", '3.5'], ["g.inject(1.0m).format('%{_}')", '1.0'],
    ["g.inject(['a':3.5m]).format('%{a}')", '3.5'], ["g.inject(100m).format('%{_}')", '100'],
    ["g.inject(-3.50m).format('%{_}')", '-3.50'], ["g.inject(0.000001m).format('%{_}')", '0.000001'],
    ["g.inject(0.000000m).format('%{_}')", '0.000000'],
  ])('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([str(expected)]);
  });
  test.each([["g.inject(0.0000001m).format('%{_}')"], ["g.inject(0.0000000m).format('%{_}')"]])(
    'a BigDecimal whose toString is not its text defers: %s', (gremlin) => {
      expect(() => runP(gremlin)).toThrow(/not supported/);
    });
});

// A `T`/`Direction` TOKEN reached as a bare value (an `elementMap()` key) is the enum, not its name: it
// frames as the token and is never EQUAL to a String (`GremlinValueComparator.equals`, `ft == st`).
describe('a T/Direction token is not the String it prints as', () => {
  test.each([
    ["g.V(1).elementMap().unfold().select(keys)", ['T.id', 'T.label', '"name"', '"age"']],
    ["g.V(1).elementMap().select(keys).unfold()", ['T.id', 'T.label', '"name"', '"age"']],
    ["g.E(7).elementMap().unfold().select(keys)", ['T.id', 'T.label', 'Direction.IN', 'Direction.OUT', '"weight"']],
    ["g.V(1).elementMap().unfold().select(keys).is('label')", []],
    ["g.V(1).elementMap().select(keys).unfold().is(within('id','name'))", ['"name"']],
    ["g.V(1).elementMap().unfold().select(keys).where(__.is('label'))", []],
    ["g.V(1).elementMap().unfold().select(keys).is(neq('label')).count()", ['4L']],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([...expected]);
  });
});

// SPLIT. `StringUtil.split` (`vendor/tinkerpop/gremlin-core/.../util/StringUtil.java:49,51`): an EMPTY
// separator is Java's `String.split("")`, any other Commons `splitByWholeSeparator`, which drops leading
// and adjacent empty tokens but keeps a TRAILING one.
describe("split() keeps the reference's empty tokens", () => {
  test.each([
    ["g.inject('a,').split(',')", ['a', '']], ["g.inject('a,,').split(',')", ['a', '']],
    ["g.inject(',').split(',')", ['']], ["g.inject('xaa').split('aa')", ['x', '']],
    ["g.inject(',a,,b').split(',')", ['a', 'b']], ["g.inject('').split(',')", []],
    ["g.inject('').split('')", ['']], ["g.inject('ab').split('')", ['a', 'b']],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([`[${expected.map(str).join(',')}]`]);
  });
});
