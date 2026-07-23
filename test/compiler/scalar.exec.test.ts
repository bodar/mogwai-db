// Compiler execution semantics (split from test/compiler.test.ts) — scalar-parent lowering.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { parseRequest } from '../../src/wire.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns } from '../../src/steps/context/stream.ts';
import { pushChildScope } from '../../src/steps/tail/child.ts';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// ---------- execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.
const bare = (v: any): any =>
  Array.isArray(v) ? v.map(bare)
  : v && typeof v === 'object' && 't' in v && 'v' in v ? bare(v.v)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bare(x)]))
  : v;

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('scalar-parent branch/map (Stage 1)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => executeQuery(store, g, {}).map(dec).map((x) => x === null ? '∅' : String(x)).sort();

  test('choose(P, then, else) over a scalar → gated UNION ALL (no inline CASE)', () => {
    const p = read("g.V().hasLabel('person').values('age').choose(eq(29),__.constant('m'),__.constant('o'))");
    expect(p.sql).toContain('UNION ALL');               // the then/else arm merge
    expect(p.sql).toContain('WHERE p.v = ?');           // then-seed gated by the predicate over the value
    expect(p.sql).toContain('WHERE NOT COALESCE((p.v = ?), 0)'); // else-seed is the complement
    expect(vals("g.V().hasLabel('person').values('age').choose(eq(29),__.constant('m'),__.constant('o'))"))
      .toEqual(['m', 'o', 'o', 'o']);
  });

  test('choose(P, then) with no else → identity passthrough of the value', () => {
    expect(vals("g.V().hasLabel('person').values('age').choose(eq(29),__.constant('m'))"))
      .toEqual(['27', '32', '35', 'm'].sort());
  });

  test('choose(traversal-predicate, then, else) over a scalar', () => {
    expect(vals("g.V().hasLabel('person').values('age').choose(__.is(gt(30)),__.constant('big'),__.constant('small'))"))
      .toEqual(['big', 'big', 'small', 'small']);
  });

  test('map()/local()/flatMap() over a scalar apply the value body', () => {
    expect(vals("g.V().hasLabel('person').values('age').map(__.constant('x'))")).toEqual(['x', 'x', 'x', 'x']);
    expect(vals("g.V().hasLabel('person').values('name').map(__.toUpper())")).toEqual(['JOSH', 'MARKO', 'PETER', 'VADAS']);
    expect(vals("g.V().hasLabel('person').values('name').local(__.toUpper())")).toEqual(['JOSH', 'MARKO', 'PETER', 'VADAS']);
  });

  test('map() with a filtering body drops non-productive inputs', () => {
    expect(vals("g.V().hasLabel('person').values('age').map(__.is(gt(30)))")).toEqual(['32', '35']);
  });

  test('union() over a scalar concatenates every arm (multiset-faithful)', () => {
    const p = read("g.V().hasLabel('person').values('age').union(__.constant('a'),__.constant('b'))");
    expect(p.sql).toContain('UNION ALL');
    expect(vals("g.V().hasLabel('person').values('age').union(__.constant('a'),__.constant('b'))"))
      .toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
  });

  test('coalesce() over a scalar → first arm that produces, per row', () => {
    expect(vals("g.V().hasLabel('person').values('age').coalesce(__.is(gt(30)),__.constant('lo'))"))
      .toEqual(['32', '35', 'lo', 'lo'].sort());
  });

  test('a movement/property body over a scalar still fails closed (a scalar has no neighbours)', () => {
    expect(() => compile("g.V().values('age').map(__.out())", {})).toThrow('map() after a scalar stream not yet supported');
    expect(() => compile("g.V().values('age').union(__.out(),__.in())", {})).toThrow('union() after a scalar stream not yet supported');
  });

  // Slice 1: reducer arms (count/sum/min/max/mean) lower per input through the pushed scalar
  // child scope — matching the L3-ratcheted element-parent union/choose/coalesce, which also
  // scope a reducer arm per incoming traverser (tryCompileScalarChild(...,'all')).
  test('reducer arms lower per input (matches the element-parent branch convention)', () => {
    // count()/sum() per input: each value is one traverser → count 1, sum = the value itself.
    expect(vals("g.V().hasLabel('person').values('age').union(__.count(),__.constant(0))"))
      .toEqual(['0', '0', '0', '0', '1', '1', '1', '1']);
    expect(vals("g.V().hasLabel('person').values('age').union(__.sum(),__.constant(0))"))
      .toEqual(['0', '0', '0', '0', '27', '29', '32', '35']);
    // choose/coalesce reducer arms: only the gated subset flows into the arm.
    expect(vals("g.V().hasLabel('person').values('age').choose(__.is(gt(30)),__.count(),__.constant(0))"))
      .toEqual(['0', '0', '1', '1']);
    expect(vals("g.V().hasLabel('person').values('age').coalesce(__.is(gt(30)),__.count())"))
      .toEqual(['1', '1', '32', '35'].sort());
  });

  // Slice 1: a nested value-branch inside an arm composes through the same tryScalar*Child
  // consumer (lowerSteps recursion), so choose/union/coalesce nest.
  test('nested value-branch arms compose', () => {
    expect(vals("g.V().hasLabel('person').values('age').union(__.constant('a'),__.union(__.constant('b'),__.constant('c')))"))
      .toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'c', 'c', 'c', 'c']);
  });

  // Slice 1: tail()/dedup() arms lower via the pushed child scope (the seed carries an
  // encounter, so the partitioned tail/dedup paths are safe — no longer a root-scope throw).
  test('tail()/dedup() arms lower per input via the child scope', () => {
    expect(vals("g.V().hasLabel('person').values('age').union(__.tail(1),__.identity())"))
      .toEqual(['27', '27', '29', '29', '32', '32', '35', '35']);
    expect(vals("g.V().hasLabel('person').as('a').values('age').union(__.dedup(),__.identity())"))
      .toEqual(['27', '27', '29', '29', '32', '32', '35', '35']);
  });

  // Slice 2: a re-source arm (V()/E() head) CROSS JOINs the graph per value inside the pushed
  // scalar child scope; a following count()/reducer/projection reduces PER INPUT. The value is
  // discarded by the re-source (GraphStep(isStart=false)), exactly as at the tail.
  test('V()/E() re-source arms reduce per input', () => {
    // bare re-source count: all 6 vertices per input age → 6 each.
    expect(vals("g.V().hasLabel('person').values('age').map(__.V().count())")).toEqual(['6', '6', '6', '6']);
    // movement then count: out() across all 6 vertices = 6 edges → 6 per input.
    expect(vals("g.V().hasLabel('person').values('age').map(__.V().out().count())")).toEqual(['6', '6', '6', '6']);
    // re-source + projection (multi-value per input), one input via V(1).
    expect(vals("g.V(1).values('age').flatMap(__.V().hasLabel('person').values('name'))"))
      .toEqual(['josh', 'marko', 'peter', 'vadas']);
    // re-source + numeric reducer over the projected values.
    expect(vals("g.V(1).values('age').map(__.V().hasLabel('person').values('age').sum())")).toEqual(['123']);
  });

  // Slice 3: a scalar-parent union whose arms disagree on shape (a scalar value arm + a
  // re-source element arm, or + a fold list arm) merges into a VariantStream — the SAME
  // dynamic-tag shape the element parent produces, via the parent-agnostic merge builders.
  test('mixed-shape union over a scalar → a VariantStream', () => {
    // scalar 'x' + element re-source (all 6 vertices) → 7 tagged rows.
    expect(read("g.V(1).values('age').union(__.constant('x'),__.V())").shape).toEqual({ kind: 'variant', node: true });
    expect(executeQuery(store, "g.V(1).values('age').union(__.constant('x'),__.V())", {})).toHaveLength(7);
    // scalar + list arm (fold of re-sourced names).
    expect(read("g.V(1).values('age').union(__.constant('x'),__.V().values('name').fold())").shape)
      .toEqual({ kind: 'variant', listOf: { kind: 'scalar' } });
    expect(executeQuery(store, "g.V(1).values('age').union(__.constant('x'),__.V().values('name').fold())", {})).toHaveLength(2);
    // shape-agnostic count() composes over the variant (variant.ts VARIANT_TAIL).
    expect(vals("g.V(1).values('age').union(__.constant('x'),__.V()).count()")).toEqual(['7']);
    // homogeneous arms stay a scalar stream (the cascade only falls to variant when mixed).
    expect(read("g.V().values('age').union(__.constant('a'),__.constant('b'))").shape)
      .toEqual({ kind: 'value', as: undefined, perRowType: undefined });
  });

  test('optional() over a scalar: scalar arm restores the value on miss, element arm → variant', () => {
    // scalar arm: a filter arm restores dropped inputs → identity; an always-productive arm wins.
    expect(read("g.V().values('age').optional(__.is(gt(30)))").shape).toEqual({ kind: 'value', as: undefined, perRowType: undefined });
    expect(vals("g.V().hasLabel('person').values('age').optional(__.is(gt(30)))")).toEqual(['27', '29', '32', '35']);
    expect(vals("g.V().hasLabel('person').values('age').optional(__.constant('x'))")).toEqual(['x', 'x', 'x', 'x']);
    expect(vals("g.V().hasLabel('person').values('age').optional(__.V().count())")).toEqual(['6', '6', '6', '6']);
    // element arm → a VariantStream: arm rows where productive, else the value restored.
    expect(read("g.V(1).values('age').optional(__.V())").shape).toEqual({ kind: 'variant', node: true });
    expect(executeQuery(store, "g.V(1).values('age').optional(__.V())", {})).toHaveLength(6); // V() productive → 6 vertices
    // arm unproductive for the input → the value is restored (vk 1).
    expect(vals("g.V(1).values('age').optional(__.V().hasLabel('nope'))")).toEqual(['29']);
  });

  test('mixed-shape coalesce over a scalar → a VariantStream (ordinal-gated first-productive)', () => {
    expect(read("g.V(1).values('age').coalesce(__.is(gt(100)),__.V())").shape).toEqual({ kind: 'variant', node: true });
    // is(gt 100) never fires → every input falls to V() (6 vertices).
    expect(vals("g.V(1).values('age').coalesce(__.is(gt(100)),__.V()).count()")).toEqual(['6']);
    // is(gt 30) fires for 32/35 (their value passes) → 2 values; 29/27 fall to V() → 2×6.
    expect(vals("g.V().hasLabel('person').values('age').coalesce(__.is(gt(30)),__.V()).count()")).toEqual(['14']);
    // homogeneous arms stay scalar (the cascade only falls to variant when mixed).
    expect(read("g.V().values('age').coalesce(__.is(gt(30)),__.constant(0))").shape)
      .toEqual({ kind: 'value', as: undefined, perRowType: undefined });
  });

  test('mixed-shape choose over a scalar → a VariantStream (gate partitions then/else)', () => {
    expect(read("g.V(1).values('age').choose(__.is(lt(30)),__.V(),__.constant('old'))").shape)
      .toEqual({ kind: 'variant', node: true });
    // age 29 < 30 → the then (re-source, 6 vertices) wins; else 'old' is unproductive here.
    expect(executeQuery(store, "g.V(1).values('age').choose(__.is(lt(30)),__.V(),__.constant('old'))", {})).toHaveLength(6);
    // age 29 not > 30 → the else scalar 'young' wins.
    expect(executeQuery(store, "g.V(1).values('age').choose(__.is(gt(30)),__.V(),__.constant('young'))", {})).toHaveLength(1);
  });

  // map() is first-result-only in TinkerPop, whereas flatMap/local emit every result. A ≤1
  // arm body (transform/filter/choose/reducer) is identical under all three; a FAN-OUT body
  // (a nested union, or a re-source projection) makes map take the FIRST emitted result per
  // input, keyed on the branch merge's synthesized emission encounter (canonical emission order,
  // Stage A) — arm 0 before arm 1, re-source in element-id order.
  test('map() is first-result-only: fan-out arm bodies take the first emitted result', () => {
    // fan-out via a nested union: flatMap/local → all 8; map → the first arm's value per input.
    expect(vals("g.V().hasLabel('person').values('age').flatMap(__.union(__.constant('lo'),__.constant('hi')))"))
      .toEqual(['hi', 'hi', 'hi', 'hi', 'lo', 'lo', 'lo', 'lo']);
    expect(vals("g.V().hasLabel('person').values('age').local(__.union(__.constant('lo'),__.constant('hi')))"))
      .toEqual(['hi', 'hi', 'hi', 'hi', 'lo', 'lo', 'lo', 'lo']);
    // map → arm 0 ('lo') per input (4 person ages).
    expect(vals("g.V().hasLabel('person').values('age').map(__.union(__.constant('lo'),__.constant('hi')))"))
      .toEqual(['lo', 'lo', 'lo', 'lo']);
    // fan-out via a re-source projection: flatMap → all names; map → the first (element-id order).
    expect(vals("g.V(1).values('age').flatMap(__.V().hasLabel('person').values('name'))"))
      .toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(vals("g.V(1).values('age').map(__.V().values('name'))")).toEqual(['marko']);
    // ≤1 bodies stay identical under map (transform, choose 1:1, re-source+reducer).
    expect(vals("g.V().hasLabel('person').values('name').map(__.toUpper())")).toEqual(['JOSH', 'MARKO', 'PETER', 'VADAS']);
    expect(vals("g.V().hasLabel('person').values('age').map(__.V().count())")).toEqual(['6', '6', '6', '6']);
  });

  test('re-source arms compose in union/choose/coalesce', () => {
    expect(vals("g.V(1).values('age').union(__.constant('x'),__.V().count())")).toEqual(['6', 'x']);
    // choose: age 29 is not > 30 → the else (constant 0) wins.
    expect(vals("g.V(1).values('age').choose(__.is(gt(30)),__.V().count(),__.constant(0))")).toEqual(['0']);
    // coalesce: the first (impossible) predicate never fires → every input falls to V().count().
    expect(vals("g.V().hasLabel('person').values('age').coalesce(__.is(gt(100)),__.V().count())"))
      .toEqual(['6', '6', '6', '6']);
  });

  // The recognizer must never accept an arm body the scalar engine would THROW on (that
  // breaks the return-null fall-through). These arms defer cleanly to the generic message
  // rather than surfacing a raw mid-lowering throw.
  test('arm bodies the scalar engine cannot lower defer cleanly (fall-through contract)', () => {
    expect(() => compile("g.V().values('age').union(__.asBool(),__.identity())", {}))
      .toThrow('union() after a scalar stream not yet supported');         // asBool has no scalarTx impl
    expect(() => compile("g.V().values('name').choose(__.is(eq('marko')),__.asNumber(),__.identity())", {}))
      .toThrow('choose() after a scalar stream not yet supported');        // bare asNumber() throws on a non-date value
    // out()/in() are adjacency, not a re-source — a scalar has no neighbours, still fails closed
    expect(() => compile("g.V().values('age').union(__.out(),__.identity())", {}))
      .toThrow('union() after a scalar stream not yet supported');
    expect(() => compile("g.V().values('age').map(__.out())", {}))
      .toThrow('map() after a scalar stream not yet supported');
    // a bare re-source with no reducer ends in element space (mixed shape) → deferred to slice 3
    expect(() => compile("g.V().values('age').map(__.V())", {}))
      .toThrow('map() after a scalar stream not yet supported');
    // but asNumber WITH a type arg is a real transform and still lowers
    expect(() => compile("g.V().values('age').map(__.asNumber(GType.DOUBLE))", {})).not.toThrow();
  });
});

// Stage 2: math("<formula>") over a scalar parent — `_` = the value, one arithmetic Double.
describe('scalar math (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('t').property('age',29).property('d',2.5)", {});
  executeQuery(store, "g.addV('t').property('age',27).property('d',1.2)", {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => executeQuery(store, g, {}).map(dec).map(String).sort();

  test('math over the scalar value binds `_` to v', () => {
    expect(vals("g.V().values('age').math('_ * 2')")).toEqual(['54', '58']);
    expect(vals("g.V().values('age').math('_ + 0.5')")).toEqual(['27.5', '29.5']);
    expect(vals("g.V().values('d').math('ceil _')")).toEqual(['2', '3']);
    expect(vals("g.V().values('age').math('_ + _')")).toEqual(['54', '58']);
  });

  test('math always yields a Double', () => {
    expect(read("g.V().values('age').math('_ * 2')").shape).toEqual({ kind: 'value', as: 'double' });
  });

  test('named variables resolve through by()-modulators over the value', () => {
    const store2 = new GraphStore(new BunSqlite(':memory:'));
    for (const a of [29, 27]) executeQuery(store2, `g.addV('t').property('age',${a})`, {});
    const d = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
    const v = (g: string) => executeQuery(store2, g, {}).map(d).map(String).sort();
    expect(v("g.V().values('age').math('_ + a').by(__.constant(100))")).toEqual(['127', '129']);
    expect(v("g.V().values('age').math('a * b').by(__.identity()).by(__.constant(2))")).toEqual(['54', '58']);
  });

  test('a named variable with no by() defers', () => {
    expect(() => compile("g.V().values('age').math('a + b')", {})).toThrow('math() after a scalar stream not yet supported');
  });
});

// Stage 2 consumer: format("…%{_}…") over a scalar — literals + by()-modulator tokens over the value.
describe('scalar format (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const n of ['marko', 'vadas']) executeQuery(store, `g.addV('p').property('name','${n}')`, {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => executeQuery(store, g, {}).map(dec).map(String).sort();

  test('a %{_} by()-modulator token + literals', () => {
    expect(vals("g.V().values('name').format('Hi %{_}!').by(__.toUpper())")).toEqual(['Hi MARKO!', 'Hi VADAS!']);
  });

  test('a token-free template is a constant string', () => {
    expect(vals("g.V().values('name').format('static')")).toEqual(['static', 'static']);
  });

  test('a %{key} property token has no scalar meaning and defers', () => {
    expect(() => compile("g.V().values('name').format('%{name}')", {})).toThrow('format() after a scalar stream not yet supported');
  });
});

// V()/E() after a scalar re-source the graph per traverser (a flatMap → ElementStream): a
// value-alias survives the re-source, and format()'s named token falls back to an as()-label.
describe('V()/E() after a scalar — mid-traversal re-source (Stage 4)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('person').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('software').property('name','lop')", {});
  const dec = (b: Buffer) => { const x = ioc.anySerializer.deserialize(b, true); return x?.v ?? x; };
  const names = (g: string) => executeQuery(store, g, {}).map((b: Buffer) => ioc.anySerializer.deserialize(b, true).v).sort();

  test('inject(x).V() produces all vertices per traverser (multiset), V(id) the id-matched', () => {
    expect(executeQuery(store, 'g.inject(0).V().count()', {}).map(dec)).toEqual([2n]);
    expect(executeQuery(store, 'g.inject(1,2).V().count()', {}).map(dec)).toEqual([4n]); // 2 traversers × 2
    expect(names("g.inject(0).V(1).values('name')")).toEqual(['marko']);
  });

  test('a value-alias survives the re-source and reads as its value', () => {
    expect(executeQuery(store, "g.inject(1).as('age').V().select('age')", {}).map(dec)).toEqual([1, 1]);
  });

  test("format()'s named token falls back to an as()-label when the property is absent", () => {
    expect(names("g.inject(1).as('age').V().format('%{name} is %{age} years old')"))
      .toEqual(['lop is 1 years old', 'marko is 29 years old']); // software has no age → alias 1
    expect(names("g.V().format('%{name} is %{age} years old')")).toEqual(['marko is 29 years old']); // no alias → lop filtered
  });
});

// split(sep) over a scalar string → a List (recursive CTE): separator / "" (chars) / null
// (whitespace); a NULL value stays NULL; a non-string arg raises the spec error.
describe('scalar split (Stage 2)', () => {
  const dec = (b: Buffer) => { const x = ioc.anySerializer.deserialize(b, true).v; return x === null ? null : (x as any[]).map((y: any) => y?.v ?? y); };
  const lists = (g: string) => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    return executeQuery(store, g, {}).map(dec);
  };
  test('split(sep) splits on each occurrence', () => {
    expect(lists('g.inject("marko","vadas","josh").split("a")')).toEqual([['m', 'rko'], ['v', 'd', 's'], ['josh']]);
  });
  test('split("") splits into characters; a null value stays null', () => {
    expect(lists('g.inject("that","this","test",null).split("")')).toEqual([['t', 'h', 'a', 't'], ['t', 'h', 'i', 's'], ['t', 'e', 's', 't'], null]);
  });
  test('split(null) splits on whitespace runs', () => {
    expect(lists('g.inject("hello world","marko").split(null)')).toEqual([['hello', 'world'], ['marko']]);
  });
  test('split(Scope.local) over a scalar needs a preceding fold()', () => {
    expect(() => compile('g.inject("a").split(Scope.local, ",")', {})).toThrow('split(Scope.local) requires a preceding list-producing step');
  });
});

// Root-scope tail(N) on a scalar stream: the last N of the natural order, no encounter
// column required (previously threw "scalar tail requires explicit encounter order").
describe('scalar tail at root (Stage 2 fix)', () => {
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    return executeQuery(store, g, {}).map(dec).map(String);
  };
  test('tail(N) takes the last N; bare tail() the last one', () => {
    expect(vals('g.inject(1,2,3,4).tail(2)')).toEqual(['3', '4']);
    expect(vals('g.inject(1,2,3,4).tail()')).toEqual(['4']);
    expect(vals('g.inject(3,1,2).order().tail(1)')).toEqual(['3']);
  });

  test('where(P)/filter(P) over a scalar filters by a predicate on the value', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const a of [29, 27, 35]) executeQuery(store, `g.addV('p').property('age',${a})`, {});
    const d = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
    const v = (g: string) => executeQuery(store, g, {}).map(d).map(String).sort();
    expect(v("g.V().values('age').where(gt(30))")).toEqual(['35']);
    expect(v("g.V().values('age').where(lte(29)).where(gt(27))")).toEqual(['29']);
  });

  test('aggregate(x)/local(__.aggregate(x)) collect the values; cap(x) reads them', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const n of ['marko', 'vadas', 'josh']) executeQuery(store, `g.addV('p').property('name','${n}')`, {});
    const listOf = (g: string) => {
      const [row] = executeQuery(store, g, {}).map((b: Buffer) => ioc.anySerializer.deserialize(b, true).v);
      return (row as any[]).map((x: any) => String(x?.v ?? x)).sort();
    };
    expect(listOf("g.V().values('name').aggregate('a').cap('a')")).toEqual(['josh', 'marko', 'vadas']);
    expect(listOf("g.V().values('name').local(__.aggregate('a')).cap('a')")).toEqual(['josh', 'marko', 'vadas']);
    // pass-through: the values continue past aggregate()
    const cnt = executeQuery(store, "g.V().values('name').aggregate('a').count()", {}).map((b: Buffer) => ioc.anySerializer.deserialize(b, true).v);
    expect(cnt).toEqual([3n]);
  });
});

// Stage 2 substrate: a SCALAR is a first-class child parent (ChildParent |= ScalarStream).
// pushChildScope re-projects the value `_`=v + a minted encounter, so a reducer-bodied child
// (map(__.count()/sum()/…)) lowers through the same scoped-reducer engine as an element child.
describe('scalar child scope — pushChildScope substrate (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('p').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('p').property('name','vadas').property('age',27)", {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => executeQuery(store, g, {}).map(dec).map(String).sort();

  test('a reducer body reduces the single value per traverser', () => {
    expect(vals("g.V().hasLabel('p').values('age').map(__.count())")).toEqual(['1', '1']);   // count of one value
    expect(vals("g.V().hasLabel('p').values('age').local(__.sum())")).toEqual(['27', '29']); // sum of one value
    expect(vals("g.V().hasLabel('p').values('age').map(__.max())")).toEqual(['27', '29']);
    expect(vals("g.V().hasLabel('p').values('age').map(__.mean())")).toEqual(['27', '29']);
  });

  test('a value-op prefix composes before the scoped reducer', () => {
    expect(vals("g.V().hasLabel('p').values('name').map(__.toUpper().count())")).toEqual(['1', '1']);
  });

  test('cardinality-preserving value bodies still take the light path', () => {
    expect(vals("g.V().hasLabel('p').values('age').map(__.constant('x'))")).toEqual(['x', 'x']);
  });

  test('a movement body still fails closed (a scalar has no neighbours)', () => {
    expect(() => compile("g.V().values('age').map(__.out())", {})).toThrow('map() after a scalar stream not yet supported');
  });
});

// Stage 2 consumer: project('a','b').by(…) over a scalar parent — each field's by() runs
// against the value through the pushChildScope substrate (scalar value fields; no element
// framing). Proves the substrate powers a real modulation consumer.
describe('scalar project — modulation over the value (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('p').property('name','marko').property('age',29)", {});
  executeQuery(store, "g.addV('p').property('name','vadas').property('age',27)", {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true);
  const recs = (g: string) => executeQuery(store, g, {}).map(dec).map((m: any) =>
    m && m.v instanceof Map ? Object.fromEntries([...m.v].map(([k, v]: any) => [k?.v ?? k, v?.v ?? v])) : m?.v ?? m)
    .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  test('by(__.identity()) and by(__.math()) field the value', () => {
    expect(recs("g.V().hasLabel('p').values('age').project('orig','doubled').by(__.identity()).by(__.math('_ * 2'))"))
      .toEqual([{ orig: 27, doubled: 54 }, { orig: 29, doubled: 58 }]);
  });

  test('a bare by() fields the value itself', () => {
    expect(recs("g.V().hasLabel('p').values('age').project('a').by()")).toEqual([{ a: 27 }, { a: 29 }]);
  });

  test('a string-transform field', () => {
    expect(recs("g.V().hasLabel('p').values('name').project('n','up').by(__.identity()).by(__.toUpper())"))
      .toEqual([{ n: 'marko', up: 'MARKO' }, { n: 'vadas', up: 'VADAS' }]);
  });

  test('a reducer field lowers through the scalar child scope', () => {
    expect(recs("g.V().hasLabel('p').values('age').project('v','c').by(__.identity()).by(__.count())"))
      .toEqual([{ v: 27, c: 1 }, { v: 29, c: 1 }]);
  });

  test('a field needing element output over a scalar fails closed', () => {
    expect(() => compile("g.V().values('age').project('x').by(__.out())", {}))
      .toThrow('project() requires element input (a scalar stream has no project)');
  });
});

// Stage 2 consumer: option-map choose(fn).option(k, body)… over a scalar parent — the choice
// and every option body run against the value through the modulation seam (a CASE over v).
describe('scalar option-map choose (Stage 2)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const age of [29, 27, 35]) executeQuery(store, `g.addV('p').property('age',${age})`, {});
  const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
  const vals = (g: string) => executeQuery(store, g, {}).map(dec).map(String).sort();

  test('a predicate-keyed option-map over the value', () => {
    expect(vals("g.V().values('age').choose(__.identity()).option(between(26,30),__.constant('young')).option(Pick.none,__.constant('old'))"))
      .toEqual(['old', 'young', 'young']);
  });

  test('a literal-keyed option-map over the value', () => {
    expect(vals("g.V().values('age').choose(__.identity()).option(29,__.constant('marko')).option(Pick.none,__.constant('other'))"))
      .toEqual(['marko', 'other', 'other']);
  });

  test('no Pick.none default defers (unmatched pass-through is mixed-shape)', () => {
    expect(() => compile("g.V().values('age').choose(__.identity()).option(29,__.constant('m'))", {}))
      .toThrow('choose() after a scalar stream not yet supported');
  });
});
