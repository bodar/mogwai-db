// Compiler execution semantics (split from test/compiler.test.ts) — scalar-parent lowering.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { STATIC } from '../../src/sql/kernel/render.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { decodeAll } from '../support/decode.ts';
import { read } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe('scalar-parent branch/map (Stage 1)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {});
  const vals = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}))).map((x) => x === null ? '∅' : String(x)).sort();







  test('union() over a scalar concatenates every arm (multiset-faithful)', async () => {
    const p = read("g.V().hasLabel('person').values('age').union(__.constant('a'),__.constant('b'))");
    expect(p.sql).toContain('UNION ALL');
    expect(await vals("g.V().hasLabel('person').values('age').union(__.constant('a'),__.constant('b'))"))
      .toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
  });




  // Slice 1: a nested value-branch inside an arm composes through the same tryScalar*Child
  // consumer (lowerSteps recursion), so choose/union/coalesce nest.
  test('nested value-branch arms compose', async () => {
    expect(await vals("g.V().hasLabel('person').values('age').union(__.constant('a'),__.union(__.constant('b'),__.constant('c')))"))
      .toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'c', 'c', 'c', 'c']);
  });









});


// Stage 2: math("<formula>") over a scalar parent — `_` = the value, one arithmetic Double.
describe('scalar math (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('t').property('age',29).property('d',2.5)", {});
  executeQuery(store, "g.addV('t').property('age',27).property('d',1.2)", {});
  const vals = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}))).map(String).sort();

  test('math over the scalar value binds `_` to v', async () => {
    expect(await vals("g.V().values('age').math('_ * 2')")).toEqual(['54', '58']);
    expect(await vals("g.V().values('age').math('_ + 0.5')")).toEqual(['27.5', '29.5']);
    expect(await vals("g.V().values('d').math('ceil _')")).toEqual(['2', '3']);
    expect(await vals("g.V().values('age').math('_ + _')")).toEqual(['54', '58']);
  });

  test('math always yields a Double', () => {
    expect(read("g.V().values('age').math('_ * 2')").shape).toEqual({ kind: 'value', type: STATIC('double') });
  });


});

// Stage 2 consumer: format("…%{_}…") over a scalar — literals + by()-modulator tokens over the value.
describe('scalar format (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const n of ['marko', 'vadas']) executeQuery(store, `g.addV('p').property('name','${n}')`, {});
  const vals = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}))).map(String).sort();

  test('a %{_} by()-modulator token + literals', async () => {
    expect(await vals("g.V().values('name').format('Hi %{_}!').by(__.toUpper())")).toEqual(['Hi MARKO!', 'Hi VADAS!']);
  });

  test('a token-free template is a constant string', async () => {
    expect(await vals("g.V().values('name').format('static')")).toEqual(['static', 'static']);
  });

});

// V()/E() after a scalar re-source the graph per traverser (a flatMap → ElementStream): a
// value-alias survives the re-source, and format()'s named token falls back to an as()-label.
describe('V()/E() after a scalar — mid-traversal re-source (Stage 4)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('person').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('software').property('name','lop')", {});

  test('mints source-id encounter order after a barrier re-sources the graph', async () => {
    // `count()` emits a new traverser and therefore spends the source's old encounter. The following
    // GraphStep starts a fresh graph iterator, whose rowid order is the deterministic sequence a
    // downstream slice must read.
    expect(await decodeAll(executeQuery(store, "g.V().count().V().limit(1).values('name')", {})))
      .toEqual(['marko']);
  });


});

// split(sep) over a scalar string → a List (recursive CTE): separator / "" (chars) / null
// (whitespace); a NULL value stays NULL; a non-string arg raises the spec error.
describe('scalar split (Stage 2)', () => {
});

// Root-scope tail(N) on a scalar stream: the last N of the natural order, no encounter
// column required (previously threw "scalar tail requires explicit encounter order").
describe('scalar tail at root (Stage 2 fix)', () => {

  test('where(P)/filter(P) over a scalar filters by a predicate on the value', async () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const a of [29, 27, 35]) executeQuery(store, `g.addV('p').property('age',${a})`, {});
    const v = async (g: string) =>
      (await decodeAll(executeQuery(store, g, {}))).map(String).sort();
    expect(await v("g.V().values('age').where(gt(30))")).toEqual(['35']);
    expect(await v("g.V().values('age').where(lte(29)).where(gt(27))")).toEqual(['29']);
  });

  test('aggregate(x)/local(__.aggregate(x)) collect the values; cap(x) reads them', async () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const n of ['marko', 'vadas', 'josh']) executeQuery(store, `g.addV('p').property('name','${n}')`, {});
    const listOf = async (g: string) => {
      const [row] = await decodeAll(executeQuery(store, g, {}));
      return (row as any[]).map((x: any) => String(x?.v ?? x)).sort();
    };
    expect(await listOf("g.V().values('name').aggregate('a').cap('a')")).toEqual(['josh', 'marko', 'vadas']);
    expect(await listOf("g.V().values('name').local(__.aggregate('a')).cap('a')")).toEqual(['josh', 'marko', 'vadas']);
    // pass-through: the values continue past aggregate()
    const cnt =await decodeAll( executeQuery(store, "g.V().values('name').aggregate('a').count()", {}));
    expect(cnt).toEqual([3]);
  });
});

// Stage 2 substrate: a SCALAR is a first-class child parent (ChildParent |= ScalarStream).
// pushChildScope re-projects the value `_`=v + a minted encounter, so a reducer-bodied child
// (map(__.count()/sum()/…)) lowers through the same scoped-reducer engine as an element child.
describe('scalar child scope — pushChildScope substrate (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('p').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('p').property('name','vadas').property('age',27)", {});




});

// Stage 2 consumer: project('a','b').by(…) over a scalar parent — each field's by() runs
// against the value through the pushChildScope substrate (scalar value fields; no element
// framing). Proves the substrate powers a real modulation consumer.
describe('scalar project — modulation over the value (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('p').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('p').property('name','vadas').property('age',27)", {});
  const recs = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {})))
      .map((m: any) => (m instanceof Map ? Object.fromEntries([...m]) : m))
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  test('by(__.identity()) and by(__.math()) field the value', async () => {
    expect(await recs("g.V().hasLabel('p').values('age').project('orig','doubled').by(__.identity()).by(__.math('_ * 2'))"))
      .toEqual([{ orig: 27, doubled: 54 }, { orig: 29, doubled: 58 }]);
  });

  test('a bare by() fields the value itself', async () => {
    expect(await recs("g.V().hasLabel('p').values('age').project('a').by()")).toEqual([{ a: 27 }, { a: 29 }]);
  });

  test('a string-transform field', async () => {
    expect(await recs("g.V().hasLabel('p').values('name').project('n','up').by(__.identity()).by(__.toUpper())"))
      .toEqual([{ n: 'marko', up: 'MARKO' }, { n: 'vadas', up: 'VADAS' }]);
  });


});

// Stage 2 consumer: option-map choose(fn).option(k, body)… over a scalar parent — the choice
// and every option body run against the value through the modulation seam (a CASE over v).
describe('scalar option-map choose (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const age of [29, 27, 35]) executeQuery(store, `g.addV('p').property('age',${age})`, {});



});
