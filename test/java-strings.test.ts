// JAVA STRING SEMANTICS AGAINST SQLITE'S — where the reference's `java.lang.String` and SQLite's text
// functions read the same string differently, the answer is the reference's or the query DEFERS, never
// SQLite's. Four readings, each at its one authority:
//
//  - ORDER. `String.compareTo` compares UTF-16 units; SQLite's BINARY collation compares code points. The
//    emitter keys every text comparison, sort and extremum (`utf16Key`, `src/rel/emit.ts`).
//  - CASE. `toUpperCase`/`toLowerCase` are Unicode; SQLite's `upper`/`lower` fold ASCII only. A cased
//    non-ASCII character defers (`casedText`, `src/compiler/rel/text-units.ts`).
//  - WHITESPACE. `split(null)` splits on `Character.isWhitespace`, the set `trim()` strips
//    (`JAVA_WHITESPACE`), not JS `\s`.
//  - NUL. A stored NUL stops SQLite's `like`; the trigram seek and `tinker.search` keep such a row a
//    candidate (it then defers) instead of dropping it.
import { describe, expect, test } from 'bun:test';
import { seededStore } from './support/harness.ts';
import { executeQuery } from './support/executor.ts';
import { typedAll } from './support/decode.ts';
import { CASED, UNCASEABLE_TEXT, UNREADABLE_TEXT } from '../src/compiler/rel/text-units.ts';
import { loadGraphson, writeGraphson } from '../src/formats/graphson.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { GraphStore } from '../src/storage.ts';
import type { GraphStore as Store } from '../src/storage.ts';

const answer = (store: Store, gremlin: string, params: Record<string, unknown> = {}): string[] =>
  typedAll(executeQuery(store, gremlin, params));
const runP = (gremlin: string, params: Record<string, unknown> = {}): string[] => answer(seededStore(), gremlin, params);
const str = (s: string): string => JSON.stringify(s);

// U+FFFF and U+E000 sit ABOVE every astral character in UTF-16 (whose units are surrogates, D800..DFFF)
// and BELOW it in code-point order — the one place the two orders disagree.
const HI = '\uFFFF', PUA = '\uE000', EMOJI = '\u{1F600}';

describe("text ORDER is Java's UTF-16 unit order, at every position SQLite orders", () => {
  test.each([
    [`g.inject('${HI}','${EMOJI}').order()`, [str(EMOJI), str(HI)]],
    [`g.inject('${EMOJI}','${HI}').order().by(desc)`, [str(HI), str(EMOJI)]],
    [`g.inject('${PUA}','${EMOJI}').max()`, [str(PUA)]],
    [`g.inject('${PUA}','${EMOJI}').min()`, [str(EMOJI)]],
    [`g.inject('${EMOJI}').is(lt('${HI}'))`, [str(EMOJI)]],
    [`g.inject('${EMOJI}').is(gt('${PUA}'))`, []],
    [`g.inject('${EMOJI}','${HI}').is(between('${EMOJI}','${HI}'))`, [str(EMOJI)]],
    [`g.inject('${EMOJI}','${HI}').is(inside('a','${HI}'))`, [str(EMOJI)]],
    [`g.inject('${EMOJI}','${HI}').where(is(gt('${PUA}')))`, [str(HI)]],
    [`g.inject('${EMOJI}','${HI}').coalesce(is(lt('${PUA}')), constant('n'))`, [str(EMOJI), str('n')]],
    [`g.inject('${HI}','${EMOJI}').fold().order(local)`, [`[${str(EMOJI)},${str(HI)}]`]],
    [`g.inject('${HI}','${EMOJI}').fold().max(local)`, [str(HI)]],
    [`g.inject('${HI}','${EMOJI}').fold().min(local)`, [str(EMOJI)]],
    [`g.inject('${HI}','${EMOJI}').fold('${PUA}', min)`, [str(EMOJI)]],
    [`g.inject('${HI}','${EMOJI}').fold('${PUA}', max)`, [str(HI)]],
    [`g.withSack('${HI}').inject('${EMOJI}').sack(min).sack()`, [str(EMOJI)]],
    [`g.inject('${HI}','${EMOJI}').as('a').order().select('a')`, [str(EMOJI), str(HI)]],
    [`g.inject('${HI}','${EMOJI}').dedup().order().tail(1)`, [str(HI)]],
    [`g.inject('a${HI}','a${EMOJI}').order()`, [str(`a${EMOJI}`), str(`a${HI}`)]],
  ] as const)('%s', (gremlin, expected) => {
    expect(runP(gremlin)).toEqual([...expected]);
  });

  test('a user PARAMETER compares in the same order', () => {
    expect(runP(`g.inject('${EMOJI}','${HI}').is(gt(x))`, { x: EMOJI })).toEqual([str(HI)]);
    expect(runP(`g.inject('${EMOJI}','${HI}').is(lt(x))`, { x: HI })).toEqual([str(EMOJI)]);
  });

  test('STORED strings — has(lt/gt), order().by(key), values().max() — compare in the same order', () => {
    const store = seededStore();
    answer(store, `g.addV('t').property('s','${HI}').addV('t').property('s','${EMOJI}').addV('t').property('s','b')`);
    expect(answer(store, "g.V().hasLabel('t').order().by('s').values('s')")).toEqual([str('b'), str(EMOJI), str(HI)]);
    expect(answer(store, "g.V().hasLabel('t').order().by('s', desc).values('s')")).toEqual([str(HI), str(EMOJI), str('b')]);
    expect(answer(store, `g.V().hasLabel('t').has('s', gt('${PUA}')).values('s')`)).toEqual([str(HI)]);
    expect(answer(store, `g.V().hasLabel('t').has('s', lt('${PUA}')).values('s').order()`)).toEqual([str('b'), str(EMOJI)]);
    expect(answer(store, "g.V().hasLabel('t').values('s').max()")).toEqual([str(HI)]);
    expect(answer(store, "g.V().hasLabel('t').values('s').min()")).toEqual([str('b')]);
  });

  test('ordinary text and numbers keep their order', () => {
    expect(runP("g.V().values('name').order()")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'].map(str));
    expect(runP("g.V().has('name', gt('m')).values('name')")).toEqual(['marko', 'vadas', 'ripple', 'peter'].map(str));
    expect(runP("g.V().values('age').order().by(desc)")).toEqual(['35i', '32i', '29i', '27i']);
    expect(runP("g.V().order().by('name').limit(2).values('name')")).toEqual(['josh', 'lop'].map(str));
  });
});

describe("toUpper()/toLower() are Java's Unicode case mapping, or defer", () => {
  test('CASED covers every non-ASCII character the running engine case-maps (a superset of Java at any version)', () => {
    const cased = (cp: number): boolean => CASED.some(([lo, hi]) => cp >= lo && cp <= hi);
    const missed: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const s = String.fromCodePoint(cp);
      if ((s.toUpperCase() !== s || s.toLowerCase() !== s) && !cased(cp)) missed.push(cp.toString(16));
    }
    expect(missed).toEqual([]);
  });

  test.each([
    ["g.inject('é').toUpper()"], ["g.inject('ß').toUpper()"], ["g.inject('Σ').toLower()"], ["g.inject('É').toLower()"],
    ['g.inject(y).toUpper()'], ['g.inject(x).toUpper()'], ["g.inject(['é','a']).toUpper(local)"],
    ["g.inject('é').map(toUpper())"], ["g.inject('é').union(toUpper(), constant('x'))"],
    ["g.inject('é').choose(toUpper().is('É'), constant('y'), constant('n'))"], ["g.inject('é').where(toUpper().is('É'))"],
    ["g.inject('é').project('u').by(toUpper())"], ["g.inject('é').as('a').select('a').toLower()"],
  ])('a cased non-ASCII character defers: %s', (gremlin) => {
    // `y`: a cased character AFTER a NUL, which a C-string GLOB would stop short of.
    expect(() => runP(gremlin, { x: 'é', y: 'a\u0000é' })).toThrow(UNCASEABLE_TEXT);
  });

  test('ASCII, and non-ASCII text with no cased character, stay exact', () => {
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

describe('a stored NUL never lets the trigram seek or tinker.search drop a match', () => {
  /** The modern graph with marko's name replaced by a NUL-bearing string, loaded through GraphSON — the
   *  reader `io()` uses, and the one way a NUL reaches storage (a Gremlin write declines it). */
  const nulStore = (): Store => {
    const doc = writeGraphson(seededStore()).replace('"marko"', '"ab\\u0000cdef"');
    const store = new GraphStore(new BunSqlite(':memory:'));
    loadGraphson(store, doc);
    return store;
  };

  test.each([
    ["g.V().has('name', containing('cdef')).values('age')"], ["g.V().has('name', containing('def')).count()"],
    ["g.V().has('name', endingWith('def')).values('age')"], ["g.V().has('person','name', containing('cdef')).values('age')"],
    ["g.V().filter(has('name', containing('cdef'))).values('age')"], ["g.V().has('name', regex('cdef')).values('age')"],
    ["g.call('tinker.search', [search:'cdef']).element().values('age')"],
    // An OR'd TextP: the seek may read only a NECESSARY atom, and neither disjunct is one.
    ["g.V().has('name', TextP.containing('cdef').or(TextP.containing('zzz'))).values('age')"],
    ["g.V().has('name', TextP.endingWith('def').or(TextP.startingWith('zzz'))).values('age')"],
    ["g.V().has('name', TextP.notContaining('zzz').and(TextP.notEndingWith('ab'))).values('age')"],
  ])('a NUL-bearing value that may match defers: %s', (gremlin) => {
    expect(() => answer(nulStore(), gremlin)).toThrow(UNREADABLE_TEXT);
  });

  test('an OR\'d TextP over a parameter defers on the NUL-bearing value too', () => {
    expect(() => answer(nulStore(), "g.V().has('name', TextP.containing(x).or(TextP.containing('zzz'))).values('age')", { x: 'cdef' }))
      .toThrow(UNREADABLE_TEXT);
  });

  test('a term the NUL-bearing value does not contain still answers exactly', () => {
    expect(answer(nulStore(), "g.V().has('name', containing('osh')).values('age')")).toEqual(['32i']);
    expect(answer(nulStore(), "g.call('tinker.search', [search:'osh']).element().values('age')")).toEqual(['32i']);
  });
});
