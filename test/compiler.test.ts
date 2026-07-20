// Compiler execution semantics — the compiled SQL run against a seeded in-memory
// store, asserting RESULTS (not SQL strings). The pure SQL-string snapshots (the
// "compile to SQL" contract) live at test/L2-sql/sql-snapshots.test.ts; this file
// is the behavioural twin — it proves the emitted SQL actually computes the right
// answers over a real graph.
import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
import { ioc } from '../src/io.ts';
import { parseRequest } from '../src/wire.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { assertStreamColumns } from '../src/steps/stream.ts';
import { pushChildScope } from '../src/steps/child.ts';

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

// Stage 1: branch/map consumers over a SCALAR parent (values()/a projected value…). Each
// arm is a cardinality-preserving value sub-traversal lowered through the same engine; the
// consumer gates the value rows and UNION-merges the arms (tryInlineScalarPredicate = the per-row
// productivity oracle). See child.ts tryScalar*Child + scalar.ts gateScalar/unionScalarStreams.
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

describe('compiler execution semantics', () => {
  describe('unified lowering characterization', () => {
    test('every disable-safe fast path is result-equivalent to generic lowering', () => {
      const store = seededStore();
      const cases: Array<{ key: keyof NonNullable<CompileOptions['fastPaths']>; query: string; fastSql: string; genericSql: string }> = [
        {
          // fast middle = the inline correlated movement child (a nested derived EXISTS,
          // no CTE); generic middle = the materialized child-existence gate (ROW_NUMBER
          // domain). Same filterCte plumbing either way.
          key: 'predicateInlining',
          query: 'g.V().where(__.out("knows")).values("name").order()',
          fastSql: 'WHERE EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e',
          genericSql: 'ROW_NUMBER() OVER () AS o0',
        },
        {
          // and()/or() honour the same switch: inline correlated EXISTS vs the generic
          // shared-domain combiner (both branches reuse one ordinal — `c.o0=d.o0`).
          key: 'predicateInlining',
          query: 'g.V().and(__.out("knows"), __.out("created")).values("name").order()',
          fastSql: ') AND (EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e',
          genericSql: 'c.o0=d.o0',
        },
        {
          // count().is(P): fast middle = COUNT over the inline correlated movement child
          // (no CTE); generic middle = the reducer child (COUNT ... GROUP BY o0 HAVING)
          // gated on existence. Same filterCte plumbing either way.
          key: 'predicateInlining',
          query: 'g.V().where(__.out().count().is(gt(1))).values("name").order()',
          fastSql: 'WHERE (SELECT COUNT(*) FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) c) > ?',
          genericSql: 'HAVING COUNT(',
        },
        {
          key: 'singleHopOptional',
          query: 'g.V().optional(__.out("knows")).count()',
          fastSql: 'LEFT JOIN edges',
          genericSql: 'UNION ALL SELECT id',
        },
        {
          key: 'bulkRepeatCount',
          query: 'g.V().repeat(__.out()).times(2).count()',
          fastSql: 'SUM(bulk)',
          genericSql: 'with recursive',
        },
        {
          // frontier collapse: fast = each movement wraps its walks in SUM(bulk) GROUP BY id
          // (bounded frontier); generic = the plain UNION-ALL movement CTE. The terminal count's
          // SUM(bulk) makes them the same total either way.
          key: 'movementCollapse',
          query: 'g.V().both().both().count()',
          fastSql: 'SUM(bulk) AS bulk FROM (SELECT e.tgt AS id',
          genericSql: 'c1(id, bulk) as (SELECT e.tgt AS id',
        },
        {
          // scalar predicate: inline = one WHERE over the value (filters c1 directly); generic
          // = a pushed child scope (ROW_NUMBER domain) gated on a correlated EXISTS. Equivalent.
          key: 'scalarPredicateInlining',
          query: "g.V().values('age').where(__.is(gt(30))).order()",
          fastSql: 'FROM c1 p WHERE',
          genericSql: 'EXISTS (SELECT 1 FROM',
        },
        {
          // and() over a scalar honours the same switch (both arms inline in one WHERE vs both
          // as correlated-existence terms sharing one pushed ordinal).
          key: 'scalarPredicateInlining',
          query: "g.V().values('age').and(__.is(gt(28)),__.is(lt(34))).order()",
          fastSql: 'FROM c1 p WHERE',
          genericSql: 'ROW_NUMBER() OVER () AS o0',
        },
        {
          // choose over a scalar honours the same switch: the predicate gate inlines as one WHERE
          // over the value (then/else seeds) vs a correlated EXISTS over a pushed scalar scope.
          key: 'scalarPredicateInlining',
          query: "g.V().values('age').choose(__.is(gt(30)),__.constant(1),__.constant(0)).order()",
          fastSql: 'FROM c1 p WHERE (',
          genericSql: 'EXISTS (SELECT 1 FROM',
        },
        {
          // coalesce over a scalar honours the same switch: each arm's productivity inlines as a
          // WHERE over the value vs a correlated EXISTS over the arm's child (one shared ordinal).
          key: 'scalarPredicateInlining',
          query: "g.V().values('age').coalesce(__.is(gt(30)),__.constant(0)).order()",
          fastSql: 'FROM c1 p WHERE (',
          genericSql: 'EXISTS (SELECT 1 FROM',
        },
      ];

      for (const { key, query, fastSql, genericSql } of cases) {
        const enabled = { fastPaths: { [key]: true } } as CompileOptions;
        const disabled = { fastPaths: { [key]: false } } as CompileOptions;
        expect(read(query, enabled).sql).toContain(fastSql);
        expect(read(query, disabled).sql).toContain(genericSql);
        expect(runWith(store, query, enabled)).toEqual(runWith(store, query, disabled));
      }

      // Element-terminal movementCollapse can't use the raw-row comparison above: the vertex leaf
      // carries a `bulk` column and emits ONE (v, N) row per element (fastSql), so the rows
      // legitimately DIFFER from the per-walk generic form. Equivalence is at the RLE-expanded
      // multiset — expand each row by its bulk and compare the id bags.
      expect(read('g.V().both().both()', { fastPaths: { movementCollapse: true } }).sql).toContain('AS props, p.bulk AS bulk FROM');
      const idBag = (query: string, fp: Partial<NonNullable<CompileOptions['fastPaths']>>) => {
        const p = read(query, { fastPaths: fp });
        return store.query(p.sql, p.binds).flatMap((r: any) => Array(Number(r.bulk ?? 1)).fill(r.id)).sort();
      };
      expect(idBag('g.V().both().both()', { movementCollapse: true })).toEqual(idBag('g.V().both().both()', { movementCollapse: false })); // collapsed (v,N) expands to the same vertex bag
      // bare dedup() is collapse-safe: it resets bulk to 1, so the collapsed frontier deduplicates
      // to the same distinct-vertex set as the enumerated form.
      expect(idBag('g.V().both().both().dedup()', { movementCollapse: true })).toEqual(idBag('g.V().both().both().dedup()', { movementCollapse: false }));
      // Element-returning repeat also bulks: the frontier unroll frames each vertex as (v, bulk),
      // and the RLE-expanded multiset equals the generic recursive-CTE enumeration.
      expect(read('g.V(1).repeat(__.both()).times(2)', { fastPaths: { bulkRepeatCount: true } }).sql).toContain('AS props, c.bulk AS bulk FROM');
      expect(idBag('g.V(1).repeat(__.both()).times(2)', { bulkRepeatCount: true })).toEqual(idBag('g.V(1).repeat(__.both()).times(2)', { bulkRepeatCount: false }));

      // Bulk-aware order()+limit/range/skip (element-terminal): the collapsed cumulative-bulk window
      // yields the SAME ordered traverser slice as enumerate-then-sort-then-slice. Compare the
      // EXPANDED ROW ORDER (not the multiset) — position is the whole point of order()/limit(). The
      // modern graph's names are unique, so the sort is total and the slice deterministic.
      const orderedBag = (query: string, collapse: boolean) => {
        const p = read(query, { fastPaths: { movementCollapse: collapse } });
        return store.query(p.sql, p.binds).flatMap((r: any) => Array(Number(r.bulk ?? 1)).fill(r.id)); // row order preserved
      };
      for (const query of [
        'g.V().both().order().by("name").limit(4)',
        'g.V().both().order().by("name", Order.desc).limit(3)',
        'g.V().both().both().order().by("name").range(2, 6)',
        'g.V().both().order().by("name").skip(5)',
      ]) {
        expect(read(query, { fastPaths: { movementCollapse: true } }).sql).toContain('OVER (ORDER BY'); // the cumulative-bulk window
        expect(orderedBag(query, true)).toEqual(orderedBag(query, false));
      }
    });

    test('the inline correlated predicate child stays index-only (no MATERIALIZE)', () => {
      // The whole point of the inline-correlated rendering over the materialized generic
      // gate: the movement child is a nested derived subquery the planner drives through
      // the covering edge index, NOT a materialized domain + window. Guard both the
      // EXISTS and the count().is forms against a regression to the heavy shape.
      const store = seededStore();
      const plan = (query: string, options: CompileOptions) => {
        const p = compile(query, {}, options);
        if (p.kind !== 'read') throw new Error('expected read plan');
        return store.query('EXPLAIN QUERY PLAN ' + p.sql, p.binds).map((r: any) => r.detail).join('\n');
      };
      const enabled = { fastPaths: { predicateInlining: true } };
      const disabled = { fastPaths: { predicateInlining: false } };
      for (const query of [
        'g.V().where(__.out("knows")).values("name")',
        'g.V().where(__.out().count().is(gt(1))).values("name")',
      ]) {
        const fast = plan(query, enabled);
        expect(fast).toContain('e_out'); // the correlated movement rides the covering index
        expect(fast).not.toContain('MATERIALIZE');
        expect(plan(query, disabled)).toContain('MATERIALIZE'); // generic gate materializes
      }
    });

    test('duplicate parent traversers remain distinct through a child reduction', () => {
      const store = seededStore();
      // The two identity arms are two traversers with the same vertex id. A future
      // child-domain relation must key them by ordinal, never collapse them by id.
      expect(run(store, 'g.V(1).union(__.identity(),__.identity()).local(__.outE().count())')
        .map((r) => r.v)).toEqual([3, 3]);
    });

    test('empty child count is total per parent, including zero', () => {
      const store = seededStore();
      expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
        .toEqual([0, 0, 0, 1, 2, 3]);
    });

    test('a SQL NULL traverser is distinct from no traverser', () => {
      const store = seededStore();
      expect(run(store, 'g.inject(null).count()').map((r) => r.v)).toEqual([1]);
      expect(run(store, 'g.inject().count()').map((r) => r.v)).toEqual([0]);
    });

    test('nested child ordinals are unique and outer correlation survives', () => {
      const nested = read('g.V().optional(__.out().optional(__.out())).path()');
      expect(nested.sql).toContain('AS o0');
      expect(nested.sql).toContain('AS o1');

      const store = seededStore();
      expect(run(store, 'g.V(1).as("a").optional(__.out("knows")).select("a")')
        .map((r) => r.id)).toEqual([1, 1]);
      expect(run(store, 'g.V(1).optional(__.out("knows")).path()').length).toBe(2);
    });

    test('the current provider encounter key makes local limit deterministic', () => {
      const store = seededStore();
      expect(run(store, 'g.V(1).local(__.outE().limit(1)).inV().values("name")')
        .map((r) => r.v)).toEqual(['vadas']); // edge id 7 precedes edge ids 8 and 9
      expect(run(store, 'g.V(1).flatMap(__.out().range(1,3)).values("name")')
        .map((r) => r.v).sort()).toEqual(['josh', 'lop']);
      expect(run(store, 'g.V(1).map(__.out().skip(1)).values("name")')
        .map((r) => r.v)).toEqual(['lop']);
      expect(run(store, 'g.V(1).local(__.out().limit(2).fold()).unfold().values("name")')
        .map((r) => r.v).sort()).toEqual(['lop', 'vadas']);
    });

    test('scalar child row operators partition by parent before cardinality consumption', () => {
      const store = seededStore();
      // is() must filter the productive child rows before map chooses its first row.
      expect(run(store, 'g.V(1).map(__.out().values("name").is("josh"))').map((r) => r.v)).toEqual(['josh']);
      // order/range are local to marko's child stream and retain their explicit
      // encounter key through successive relational operators.
      expect(run(store, 'g.V(1).map(__.out().values("name").order().by(Order.desc).limit(1))').map((r) => r.v))
        .toEqual(['vadas']);
      expect(run(store, 'g.V(1).flatMap(__.out().values("name").order().range(1,3))').map((r) => r.v))
        .toEqual(['lop', 'vadas']);
      expect(run(store, 'g.V(1).local(__.out().values("name").order().limit(2))').map((r) => r.v))
        .toEqual(['josh', 'lop']);
      expect(run(store, 'g.V(1).flatMap(__.both().label().dedup()).count()').map((r) => r.v)).toEqual([2]);
      // A reducer consumes the already-filtered child rows and restores an explicit
      // zero from the parent domain when none remain.
      expect(run(store, 'g.V().map(__.out().values("name").is("lop").count())').map((r) => r.v).sort())
        .toEqual([0, 0, 0, 1, 1, 1]);
      expect(run(store, 'g.V(1).map(__.outE().values("weight").sum())').map((r) => r.v)).toEqual([1.9]);
      expect(run(store, 'g.V().map(__.out().values("name").fold()).count(Scope.local)').map((r) => r.v).sort())
        .toEqual([0, 0, 0, 1, 2, 3]);
      expect(run(store, 'g.V(1).local(__.out().values("name").order().fold()).unfold()').map((r) => r.v))
        .toEqual(['josh', 'lop', 'vadas']);
      expect(run(store, 'g.V(1).flatMap(__.constant(null).fold()).count(Scope.local)').map((r) => r.v))
        .toEqual([1]);
      expect(run(store, 'g.V().map(__.out().fold()).count(Scope.local)').map((r) => r.v).sort())
        .toEqual([0, 0, 0, 1, 2, 3]);
    });

    test('remaining child barriers stay explicit deferrals until their generic lowering lands', () => {
      expect(read('g.V().local(__.outE().fold())').shape).toEqual({ kind: 'jsonbElementList', elem: 'edge' });
      const lists = run(seededStore(), 'g.V(1).local(__.out().fold())').map((r) => JSON.parse(r.list));
      expect(lists).toHaveLength(1);
      expect(lists[0].map((v: any) => v.id)).toEqual([2, 3, 4]);
      expect(() => compile('g.V().local(__.out().order().by("name").limit(1))', {})).toThrow('not yet supported');
    });

    test('as() labels a scalar stream; select() reads it back with Pop semantics', () => {
      const store = seededStore();
      // single binding: bare/first/last/mixed all yield the one value; all → singleton list
      expect(run(store, 'g.V(1).values("name").as("a").select("a")').map((r) => r.v)).toEqual(['marko']);
      expect(run(store, 'g.V(1).values("name").as("a").select(Pop.first, "a")').map((r) => r.v)).toEqual(['marko']);
      expect(run(store, 'g.V(1).values("name").as("a").select(Pop.last, "a")').map((r) => r.v)).toEqual(['marko']);
      expect(run(store, 'g.V(1).values("name").as("a").select(Pop.mixed, "a")').map((r) => r.v)).toEqual(['marko']);
      expect(run(store, 'g.V(1).values("name").as("a").select(Pop.all, "a")').map((r) => JSON.parse(r.list)))
        .toEqual([['marko']]);
      // a labelled count (a scalar) round-trips
      expect(run(store, 'g.V().hasLabel("person").count().as("a").select("a")').map((r) => r.v)).toEqual([4]);
    });

    test('rebound scalar label accumulates history; Pop reads the right end / all', () => {
      const store = seededStore();
      // name → concat → length, all labelled "a" (3 bindings)
      const q = (pop: string) => `g.V(1).values("name").as("a").concat("X").as("a").length().as("a").select(${pop})`;
      expect(run(store, q('"a"')).map((r) => r.v)).toEqual([6]);          // bare = last = length("markoX")
      expect(run(store, q('Pop.last, "a"')).map((r) => r.v)).toEqual([6]);
      expect(run(store, q('Pop.first, "a"')).map((r) => r.v)).toEqual(['marko']);
      expect(run(store, q('Pop.all, "a"')).map((r) => JSON.parse(r.list))).toEqual([['marko', 'markoX', 6]]);
      // mixed with >1 binding behaves like all
      expect(run(store, q('Pop.mixed, "a"')).map((r) => JSON.parse(r.list))).toEqual([['marko', 'markoX', 6]]);
    });

    test('multi-label select mixes a scalar label and an element label into one Map', () => {
      const record = read('g.V(1).values("name").as("a").select("a")');
      expect(record.shape).toEqual({ kind: 'value' });
      // a → element (vertex), b → its name (scalar): a heterogeneous record
      const mixed = read('g.V(1).as("a").values("name").as("b").select("a","b")');
      expect(mixed.shape).toEqual({ kind: 'map', entries: [
        { key: 'a', prefix: 'e0', sub: 'vertex' },
        { key: 'b', prefix: 'e1', sub: 'value' },
      ] });
    });
  });

  test('has(label, key, value) 3-arg folds in a label filter', () => {
    const store = seededStore();
    // the standard cucumber verification idiom
    expect(run(store, 'g.V().has("person","name","marko").has("age",29).count()').map((r) => r.v)).toEqual([1]);
    // wrong label → no match, even though a software vertex is named "lop"
    expect(run(store, 'g.V().has("person","name","lop").count()').map((r) => r.v)).toEqual([0]);
    expect(run(store, 'g.V().has("software","name","lop").count()').map((r) => r.v)).toEqual([1]);
  });

  test('has(T.label, v) / has(T.id, v) token forms filter on label / id', () => {
    const store = seededStore();
    expect(run(store, 'g.V().has(T.label,"person").count()').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().has(T.id, 1).values("name")').map((r) => r.v)).toEqual(['marko']);
  });

  test('has(T.id|T.label, P) routes through a predicate (no crash on P/TextP)', () => {
    const store = seededStore();
    expect(run(store, 'g.V().has(T.id, P.within(1,2)).values("name")').map((r) => r.v).sort()).toEqual(['marko', 'vadas']);
    expect(run(store, 'g.V().has(T.label, P.eq("software")).count()').map((r) => r.v)).toEqual([2]);
  });

  test('sack(assign).by(key) assigns per-traverser; by-miss drops the traverser', () => {
    const store = seededStore();
    // 4 persons have age; software (lop, ripple) have none → dropped by the by() miss.
    expect(run(store, 'g.V().sack(assign).by("age").sack()').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([27, 29, 32, 35]);
  });

  test('sack(assign).by(T.label) over edges, carried through inV()', () => {
    const store = seededStore();
    expect(run(store, 'g.withSack("hello").V().outE().sack(Operator.assign).by(T.label).inV().sack()').map((r) => r.v).sort())
      .toEqual(['created', 'created', 'created', 'created', 'knows', 'knows']);
  });

  test('withSack(0.0d) + sack(sum).by(weight) accumulates per edge; sum() folds', () => {
    const store = seededStore();
    // each edge contributes its weight to a fresh (0 + weight) sack; sum over all = 3.5.
    expect(run(store, 'g.withSack(0.0d).V().outE().sack(Operator.sum).by("weight").inV().sack().sum()').map((r) => r.v))
      .toEqual([3.5]);
  });

  test('withSack(2) + sack(div).by(__.constant(4.0)) → real division per vertex', () => {
    const store = seededStore();
    expect(run(store, 'g.withSack(2).V().sack(Operator.div).by(__.constant(4.0d)).sack()').map((r) => r.v))
      .toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  test('aggregate(x).by(key).cap(x) is one list; explicit unfold emits scalar members', () => {
    const store = seededStore();
    expect(executeQuery(store, 'g.V().aggregate("x").by("name").cap("x")', {})).toHaveLength(1);
    expect(run(store, 'g.V().aggregate("x").by("name").cap("x").unfold()').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    // by-miss (software has no age) drops the member → 4 ages, not 6 with nulls.
    expect(run(store, 'g.V().aggregate("x").by("age").cap("x").unfold()').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([27, 29, 32, 35]);
  });

  test('bare aggregate(x).cap(x) is one list; explicit unfold emits vertices', () => {
    const store = seededStore();
    expect(executeQuery(store, 'g.V().aggregate("x").cap("x")', {})).toHaveLength(1);
    expect(run(store, 'g.V().aggregate("x").cap("x").unfold()').map((r) => r.id).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('aggregate is a pass-through barrier (traversal continues past it)', () => {
    const store = seededStore();
    // aggregate mid-chain does not disturb the stream: out() still flows on.
    expect(run(store, 'g.V(1).aggregate("x").out().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'vadas']);
  });

  test('cap of an undefined side-effect key throws', () => {
    expect(() => compile('g.V().cap("nope")', {})).toThrow("cap('nope') references an undefined side-effect");
  });

  test('local(scalar reduction) is a per-input scalar (zeros preserved; count is Long)', () => {
    const store = seededStore();
    // out-degree per vertex, incl 0 for the software/leaf vertices.
    expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
    expect(read('g.V().local(__.outE().count())').shape).toEqual({ kind: 'value', as: 'long' });
  });

  test('local(edgeStep.limit(N)) scopes the limit PER input (window), not globally', () => {
    const store = seededStore();
    // marko has 2 knows edges; local limit(1) keeps 1 (per-vertex), then inV → 1 name.
    expect(run(store, 'g.V(1).local(__.outE("knows").limit(1)).inV().values("name")').length).toBe(1);
    // per-input: each of vadas/josh has 1 in-knows → outV = marko, twice (global limit(2) would give 2 total anyway; the point is per-input scoping)
    expect(run(store, 'g.V().local(__.inE("knows").limit(2)).outV().values("name")').map((r) => r.v))
      .toEqual(['marko', 'marko']);
  });

  test('child-scoped local preserves outer aliases and path columns', () => {
    const store = seededStore();
    const selected = run(store, 'g.V(1).as("a").local(__.out().limit(1)).select("a")');
    expect(selected.map((r) => r.id)).toEqual([1]);

    const path = run(store, 'g.V(1).local(__.out().limit(1)).path()');
    expect(path).toHaveLength(1);
    expect([path[0].x0_id, path[0].x1_id]).toEqual([1, 2]);
  });

  describe('child body with movement under path tracking (pushChildScope ordinal-order)', () => {
    // A by()-modulator / reducer / existence child whose body contains movement, lowered while
    // the outer chain tracks a path (simplePath/path/cyclicPath), previously failed CLOSED with a
    // carried-column mismatch: pushChildScope appended the child ordinal physically LAST — after
    // the path columns — desyncing the seed's declared schema (ordinal in its origins slot) from
    // its physical layout, so any child lowered via lowerSteps (assertStreamColumns) threw. The
    // ordinal now lands in its carriedCols position, so these compile and run. Continuation arms
    // (branch/local) still EXTEND the path — the reorder keeps path, it does not strip it.
    test('where(__.out()…) existence child under simplePath', () => {
      // Only josh (id 4) has an out-neighbour named lop; the where child moves under path.
      expect(run(seededStore(), 'g.V().out().simplePath().where(__.out().has("name","lop"))').map((r) => r.id))
        .toEqual([4]);
    });
    test('project().by(__.out().count()) under simplePath', () => {
      expect(run(seededStore(), 'g.V(1).out().simplePath().project("name","oc").by("name").by(__.out().count())'))
        .toEqual([{ e0_v: 'vadas', e1_v: 0 }, { e0_v: 'josh', e1_v: 2 }, { e0_v: 'lop', e1_v: 0 }]);
    });
    test('group().by(T.label).by(__.out().values().fold()) under simplePath', () => {
      expect(run(seededStore(), 'g.V().out().simplePath().group().by(T.label).by(__.out().values("name").fold())'))
        .toEqual([{ gk: 'person', gv: '["lop","ripple"]' }, { gk: 'software', gv: '[]' }]);
    });
    test('project().by(__.out().values().fold()) under simplePath (scoped fold carries the domain path, not the child-extended one)', () => {
      // Guards the scoped-barrier carry: the child fold reduces per origin and must carry the
      // parent domain's path (p0,p1), NOT the child body's out()-extended path (p2).
      expect(run(seededStore(), 'g.V(1).out().simplePath().project("outs").by(__.out().values("name").fold())'))
        .toEqual([{ e0_list: '[]' }, { e0_list: '["lop","ripple"]' }, { e0_list: '[]' }]);
    });
    test('path().by(__.out().count()) — by(traversal) position child under path', () => {
      expect(run(seededStore(), 'g.V(1).out().simplePath().path().by(__.out().count())'))
        .toEqual([{ x0_v: 3, x1_v: 0 }, { x0_v: 3, x1_v: 2 }, { x0_v: 3, x1_v: 0 }]);
    });
    test('branch/local arms still extend the outer path (reorder keeps path, not strips)', () => {
      for (const q of [
        'g.V(1).union(__.out(), __.in()).path()',
        'g.V(1).optional(__.out()).path()',
        'g.V(1).coalesce(__.out(), __.in()).path()',
        'g.V(1).local(__.out().limit(1)).path()',
      ]) expect(() => compile(q, {})).not.toThrow();
    });
  });

  test('otherV() after local(bothE.limit) picks the end away from the input vertex', () => {
    const store = seededStore();
    // josh(4): bothE = marko-knows->josh, josh-created->ripple, josh-created->lop.
    // limit(2) per input → first 2 by edge id; otherV skips josh.
    const two = run(store, 'g.V(4).local(__.bothE().limit(2)).otherV().values("name")').map((r) => r.v);
    expect(two.length).toBe(2);
    for (const name of two) expect(['marko', 'ripple', 'lop']).toContain(name);
    // otherV outside local still needs an edge context.
    expect(() => compile('g.V().otherV()', {})).toThrow('otherV() expects an edge');
  });

  test('local() with a non-movement / no-barrier body defers clearly', () => {
    expect(() => compile('g.V().local(__.out().in().simplePath()).path()', {})).toThrow('not yet supported');
    expect(run(seededStore(), 'g.V(1).local(__.out()).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'vadas']);
  });

  test('sack with two by() modulators throws TinkerPop message', () => {
    expect(() => compile('g.V().sack(assign).by("age").by("name").sack()', {}))
      .toThrow('Sack step can only have one by modulator');
  });

  test('bare sack() with no withSack()/sack(op) throws', () => {
    expect(() => compile('g.V().sack()', {})).toThrow('sack() requires withSack()');
  });

  test('order().by numeric ascending vs descending', () => {
    const store = seededStore();
    expect(run(store, 'g.V().hasLabel("person").order().by("age").values("name")').map((r) => r.v))
      .toEqual(['vadas', 'marko', 'josh', 'peter']); // 27,29,32,35
    expect(run(store, 'g.V().hasLabel("person").order().by("age",desc).values("name")').map((r) => r.v))
      .toEqual(['peter', 'josh', 'marko', 'vadas']);
  });

  test('order().by string is lexicographic', () => {
    const store = seededStore();
    expect(run(store, 'g.V().values("name").order()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('range is 0-based, low-inclusive high-exclusive', () => {
    const store = seededStore();
    expect(run(store, 'g.V().order().by("name").range(1,3).values("name")').map((r) => r.v))
      .toEqual(['lop', 'marko']);
  });

  test('traversers are a multiset — both() preserves duplicates', () => {
    // marko(1) knows vadas+josh and created lop; both() from lop reaches its 3 creators.
    const store = seededStore();
    const names = run(store, 'g.V(3).both("created").values("name")').map((r) => r.v).sort();
    expect(names).toEqual(['josh', 'marko', 'peter']); // lop created by all three
  });

  test('both() on a self-loop yields the vertex twice', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const person = store.labelId('person');
    const self = store.labelId('self');
    store.query('INSERT INTO nodes(id,label) VALUES(?,?)', [1, person]);
    store.query('INSERT INTO vertex_properties(node,key,value) VALUES(?,?,?)', [1, 'name', 'ouro']);
    store.query('INSERT INTO edges(id,src,label,tgt) VALUES(?,?,?,?)', [2, 1, self, 1]);
    expect(run(store, 'g.V(1).both().count()').map((r) => r.v)).toEqual([2]);
  });

  test('has() on a missing property filters the traverser out', () => {
    const store = seededStore();
    // software vertices (lop, ripple) have no age -> excluded
    const names = run(store, 'g.V().has("age", 27).values("name")').map((r) => r.v);
    expect(names).toEqual(['vadas']);
    const some = run(store, 'g.V().values("lang")').map((r) => r.v).sort();
    expect(some).toEqual(['java', 'java']); // only software has lang; no nulls
  });

  test('order().by(key) then id() (n.props alias must be in scope)', () => {
    const store = seededStore();
    // regression: id projection needs the nodes n join so ORDER BY key resolves
    expect(run(store, 'g.V().hasLabel("person").order().by("age").id()').map((r) => r.v))
      .toEqual([2, 1, 4, 6]); // vadas,marko,josh,peter by age 27,29,32,35
  });

  test('select("a") returns the labelled vertex (id after two hops recovered)', () => {
    const store = seededStore();
    // marko(1) as 'a', hop to who he knows, select back to marko each time
    const ids = run(store, 'g.V(1).as("a").out("knows").select("a")').map((r) => r.id);
    expect(ids).toEqual([1, 1]); // marko knows vadas+josh → two traversers, both select marko
  });

  test('single-label select re-enters element/scalar lowering', () => {
    const store = seededStore();
    // marko is selected once per outgoing traverser (3), then traversed out again (3 each).
    expect(run(store, 'g.V(1).as("a").out().select("a").out().count()').map((r) => r.v)).toEqual([9]);
    expect(run(store, 'g.V(1).outE("knows").as("e").select("e").inV().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
    expect(run(store, 'g.V().as("a").out().select("a").by("age").is(P.gt(30)).count()').map((r) => r.v)).toEqual([3]);
  });

  test('select("a").by(key) projects a property of the labelled element', () => {
    const store = seededStore();
    const names = run(store, 'g.V(1).as("a").out("knows").as("b").select("b").by("name")').map((r) => r.v).sort();
    expect(names).toEqual(['josh', 'vadas']);
    expect(run(store, 'g.V(1).as("a").out().select("a").by(__.out().count())').map((r) => r.v))
      .toEqual([3, 3, 3]);
    expect(run(store, 'g.V(1).as("a").out().select("a").by(__.out().values("name").fold()).unfold().count()').map((r) => r.v))
      .toEqual([9]);
    expect(run(store, 'g.V(1).as("a").out().select("a").by(__.out()).values("name")').map((r) => r.v))
      .toEqual(['vadas', 'vadas', 'vadas']);
  });

  test('multi-label select yields the paired elements per traverser', () => {
    const store = seededStore();
    // map shape: each row has e0_/e1_ columns; verify the (a,b) name pairs
    const rows = run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by("name")');
    const pairs = rows.map((r) => [r.e0_v, r.e1_v]).sort((x, y) => x[1].localeCompare(y[1]));
    expect(pairs).toEqual([['marko', 'josh'], ['marko', 'vadas']]);
    expect(run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by(__.out().count()).by(__.values("name"))')
      .map((r) => [r.e0_v, r.e1_v]).sort((x, y) => x[1].localeCompare(y[1])))
      .toEqual([[3, 'josh'], [3, 'vadas']]);
    expect(run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by("name").by(__.out().count())')
      .map((r) => [r.e0_v, r.e1_v]).sort((x, y) => x[1] - y[1]))
      .toEqual([['marko', 0], ['marko', 2]]);
    expect(run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by().by(__.out().count()).select("a").out().count()')
      .map((r) => r.v)).toEqual([6]);
    const lists = run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by(__.out().values("name").fold()).by(__.out().values("name").fold())');
    expect(lists.map((r) => JSON.parse(r.e0_list))).toEqual([
      ['vadas', 'lop', 'josh'], ['vadas', 'lop', 'josh'],
    ]);
    expect(lists.map((r) => JSON.parse(r.e1_list))).toEqual([[], ['lop', 'ripple']]);
  });

  test('project builds columns from the current traverser', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().hasLabel("person").project("name","age").by("name").by("age")');
    const byName = Object.fromEntries(rows.map((r) => [r.e0_v, r.e1_v]));
    expect(byName).toEqual({ marko: 29, vadas: 27, josh: 32, peter: 35 });
  });

  test('traversal-valued project fields use child productivity and preserve parent multiplicity', () => {
    const store = seededStore();
    expect(run(store, 'g.V(1).project("name","friend").by(__.values("name")).by(__.out().values("name"))'))
      .toEqual([{ e0_v: 'marko', e1_v: 'vadas' }]);
    // Vertices without an outgoing child are unproductive: the whole project row drops.
    expect(run(store, 'g.V().project("name","friend").by(__.values("name")).by(__.out().values("name"))')
      .map((r) => r.e0_v).sort()).toEqual(['josh', 'marko', 'peter']);
    // A produced NULL is not an unproductive child row.
    expect(run(store, 'g.V(1).project("x").by(__.constant(null))')).toEqual([{ e0_v: null }]);
    // Equal parents remain separate traversers through the outer by-origin join.
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).project("x").by(__.values("name"))'))
      .toEqual([{ e0_v: 'marko' }, { e0_v: 'marko' }]);
    expect(run(store, 'g.V().project("name","degree").by("name").by(__.out().count())')
      .map((r) => [r.e0_v, r.e1_v]).sort((a, b) => a[0].localeCompare(b[0])))
      .toEqual([
        ['josh', 2], ['lop', 0], ['marko', 3], ['peter', 1], ['ripple', 0], ['vadas', 0],
      ]);
    expect(run(store, 'g.V(1).project("id","kind","friend").by(T.id).by(T.label).by(__.out().values("name"))'))
      .toEqual([{ e0_v: 1, e1_v: 'person', e2_v: 'vadas' }]);
    expect(run(store, 'g.V(1).project("self","friend").by().by(__.out().values("name"))')[0])
      .toMatchObject({ e0_id: 1, e0_label: 'person', e1_v: 'vadas' });
    expect(run(store, 'g.V(1).project("self","friend").by().by(__.out().values("name")).select("self").out().count()')
      .map((r) => r.v)).toEqual([3]);
    expect(run(store, 'g.V(1).outE("knows").project("self","inName").by().by(__.inV().values("name")).select("self").inV().values("name")')
      .map((r) => r.v).sort()).toEqual(['josh', 'vadas']);

    const shaped = run(store, 'g.V(1).project("friends","first").by(__.out().values("name").fold()).by(__.out())');
    expect(JSON.parse(shaped[0].e0_list)).toEqual(['vadas', 'lop', 'josh']);
    expect(shaped[0]).toMatchObject({ e1_id: 2, e1_label: 'person' });
    expect(run(store, 'g.V(1).project("friends").by(__.out().values("name").fold()).select("friends").unfold().order()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'vadas']);
    expect(executeQuery(store, 'g.V(1).project("friends","first").by(__.out().fold()).by(__.out())', {}).length).toBe(1);
  });

  test('RecordStream fields compose back into ordinary streams', () => {
    const store = seededStore();
    expect(run(store, 'g.V().hasLabel("person").project("n","a").by("name").by("age").select("a").is(P.gt(30)).count()').map((r) => r.v))
      .toEqual([2]);
    expect(run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").select("b").out("created").values("name")').map((r) => r.v))
      .toEqual(['lop', 'ripple']);
    expect(run(store, 'g.V().hasLabel("person").project("n","a").by("name").by("age").select(Column.values).unfold().count()').map((r) => r.v))
      .toEqual([8]);
    expect(run(store, 'g.V().hasLabel("person").project("n","a").by("name").by("age").select(Column.keys).unfold().count()').map((r) => r.v))
      .toEqual([8]);
    expect(run(store, 'g.V(1).outE("knows").project("e").by().select("e").inV().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
    expect(run(store, 'g.V(1).project("name","age").by("name").by("age").range(Scope.local,1,2)')[0])
      .toMatchObject({ e1_v: 29 });
  });

  test('rebinding a label (as("a")…as("a")) keeps default Pop=last', () => {
    const store = seededStore();
    // 'a' bound at marko then rebound at each out-neighbour; select('a') = last
    const ids = run(store, 'g.V(1).as("a").out("knows").as("a").select("a")').map((r) => r.id).sort();
    expect(ids).toEqual([2, 4]); // vadas, josh — the rebound (last) positions
  });

  test('outE().inV() equals out(); outV/inV recover edge endpoints', () => {
    const store = seededStore();
    // marko(1) outE knows → 2 edges → inV → vadas+josh (== out('knows'))
    expect(run(store, 'g.V(1).outE("knows").inV().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
    // edge endpoints: edge 9 (marko-created->lop) outV=marko, inV=lop
    expect(run(store, 'g.E(9).outV().values("name")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.E(9).inV().values("name")').map((r) => r.v)).toEqual(['lop']);
  });

  test('E()/hasLabel/count and edge values() over the edges table', () => {
    const store = seededStore();
    expect(run(store, 'g.E().count()').map((r) => r.v)).toEqual([6]);
    expect(run(store, 'g.E().hasLabel("knows").count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V(1).outE("knows").values("weight")').map((r) => r.v).sort())
      .toEqual([0.5, 1.0]);
    // bothE from lop(3): the 3 created-edges into it
    expect(run(store, 'g.V(3).bothE().count()').map((r) => r.v)).toEqual([3]);
  });

  test('properties() streams a VertexProperty per (key,value); key/value/element project', () => {
    const store = seededStore();
    // marko(1) has name+age → two properties
    expect(run(store, 'g.V(1).properties().count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V(1).properties().key()').map((r) => r.v).sort()).toEqual(['age', 'name']);
    expect(run(store, 'g.V(1).properties("name").value()').map((r) => r.v)).toEqual(['marko']);
    // element() returns the owner; both properties resolve back to marko
    expect(run(store, 'g.V(1).properties().element().id()').map((r) => r.v)).toEqual([1, 1]);
    expect(run(store, 'g.V(1).properties("age").element().values("name")').map((r) => r.v)).toEqual(['marko']);
    // edge properties too (edge 7 = marko-knows->vadas, weight 0.5)
    expect(run(store, 'g.E(7).properties().value()').map((r) => r.v)).toEqual([0.5]);
  });

  test('PropertyStream composes through scalar and owner-element dispatch', () => {
    const store = seededStore();
    expect(run(store, 'g.V().properties().hasKey("age").value().is(P.gt(30)).count()').map((r) => r.v)).toEqual([2]);
    // marko has name+age: both property traversers retain the as("a") owner alias.
    expect(run(store, 'g.V(1).as("a").properties().element().select("a")').length).toBe(2);
    expect(run(store, 'g.E(7).properties().element().count()').map((r) => r.v)).toEqual([1]);
  });

  test('group().by(name).by(tail) yields one vertex per name (gate #1 rows)', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().group().by("name").by(__.tail())');
    expect(rows.length).toBe(6);
    const byName = Object.fromEntries(rows.map((r) => [r.gk, r.v_id]));
    expect(byName).toEqual({ marko: 1, vadas: 2, lop: 3, josh: 4, ripple: 5, peter: 6 });
  });

  test('groupCount().by(label) counts per label', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().groupCount().by(T.label)');
    const m = Object.fromEntries(rows.map((r) => [r.gk, r.gv]));
    expect(m).toEqual({ person: 4, software: 2 });
    const degree = Object.fromEntries(run(store, 'g.V().groupCount().by(__.out().count())').map((r) => [r.gk, r.gv]));
    expect(degree).toEqual({ 0: 3, 1: 1, 2: 1, 3: 1 });
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).groupCount().by(__.out().count())'))
      .toEqual([{ gk: 3, gv: 2 }]);
    const firstOut = run(store, 'g.V().group().by(__.out().values("name")).by("name")')
      .map((r) => [r.gk, JSON.parse(r.gv)]).sort((a, b) => a[0].localeCompare(b[0]));
    expect(firstOut).toEqual([
      ['lop', ['josh', 'peter']], ['vadas', ['marko']],
    ]);
  });

  test('group scalar-list drops members missing the property (json_group_array + null filter is in handler)', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().group().by("name").by("age")');
    const byName = Object.fromEntries(rows.map((r) => [r.gk, r.gv]));
    expect(byName.marko).toBe('[29]');
    expect(byName.lop).toBe('[null]'); // SQL keeps null; handler strips it to [] on frame
    const children = Object.fromEntries(run(store, 'g.V().group().by("name").by(__.out().values("name"))')
      .map((r) => [r.gk, JSON.parse(r.gv).sort()]));
    expect(children).toEqual({
      marko: ['josh', 'lop', 'vadas'],
      josh: ['lop', 'ripple'],
      peter: ['lop'],
    });
    const duplicateChildren = JSON.parse(run(store, 'g.V(1).union(__.identity(),__.identity()).group().by("name").by(__.out().values("name"))')[0].gv).sort();
    expect(duplicateChildren).toEqual(['josh', 'josh', 'lop', 'lop', 'vadas', 'vadas']);
    expect(run(store, 'g.V().group().by("name").by(__.values("missing"))')).toEqual([]);
    const initials = Object.fromEntries(run(store, 'g.V().group().by(__.label()).by(__.values("name").substring(0,1))')
      .map((r) => [r.gk, JSON.parse(r.gv).sort()]));
    expect(initials).toEqual({ person: ['j', 'm', 'p', 'v'], software: ['l', 'r'] });
  });

  test('group reducers operate over the complete child row domain for each key', () => {
    const store = seededStore();
    const grouped = (query: string) => Object.fromEntries(run(store, query).map((r) => [r.gk, r.gv]));

    // count is total: parents with no productive child rows retain their key as zero.
    expect(grouped('g.V().group().by(T.label).by(__.count())'))
      .toEqual({ person: 4, software: 2 });
    expect(grouped('g.V().group().by(T.label).by(__.out().count())'))
      .toEqual({ person: 6, software: 0 });

    // Numeric reducers are productive-only. They combine all child rows sharing the
    // final key; an empty software domain contributes no map entry.
    expect(grouped('g.V().group().by(T.label).by(__.values("age").sum())'))
      .toEqual({ person: 123 });
    expect(grouped('g.V().group().by(T.label).by(__.outE().values("weight").sum())'))
      .toEqual({ person: 3.5 });

    // Equal element ids are still distinct traversers. Both marko parents contribute
    // their full outgoing-weight domain (1.9 each) to the shared person reduction.
    expect(grouped('g.V(1).union(__.identity(),__.identity()).group().by(T.label).by(__.outE().values("weight").sum())'))
      .toEqual({ person: 3.8 });
  });

  test('group fold collects child rows once per final key, including empty groups', () => {
    const store = seededStore();
    const rows = Object.fromEntries(
      run(store, 'g.V().group().by(T.label).by(__.out().label().fold())')
        .map((r) => [r.gk, JSON.parse(r.gv)]),
    );
    expect(rows.person.sort()).toEqual(['person', 'person', 'software', 'software', 'software', 'software']);
    expect(rows.software).toEqual([]);

    const duplicate = run(
      store,
      'g.V(1).union(__.identity(),__.identity()).group().by(T.label).by(__.out().label().fold())',
    );
    expect(JSON.parse(duplicate[0].gv).sort())
      .toEqual(['person', 'person', 'person', 'person', 'software', 'software']);

    // A named group side effect retains its live source stream, so cap() reuses the
    // identical shaped child barrier instead of resurrecting a correlated compiler.
    const sideEffect = run(
      store,
      'g.V().group("a").by(T.label).by(__.out().label().fold()).cap("a")',
    );
    const sideEffectRows = Object.fromEntries(sideEffect.map((r) => [r.gk, JSON.parse(r.gv)]));
    expect(sideEffectRows.person.sort()).toEqual(rows.person);
    expect(sideEffectRows.software).toEqual(rows.software);
  });

  test('group element fold emits child elements at the final key boundary', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().group().by(T.label).by(__.out().fold())');
    const ids = (key: string) => rows.filter((r) => r.gk === key && r.v_id != null).map((r) => r.v_id).sort();
    expect(ids('person')).toEqual([2, 3, 3, 3, 4, 5]);
    expect(ids('software')).toEqual([]);
    // The null payload is an explicit empty-group domain row, never a phantom vertex.
    expect(rows.filter((r) => r.gk === 'software')).toHaveLength(2);
    expect(rows.filter((r) => r.gk === 'software').every((r) => r.v_id == null)).toBeTrue();

    expect(run(store, 'g.V().group().by(T.label).by(__.fold())').filter((r) => r.gk === 'person')).toHaveLength(4);
    expect(run(store, 'g.V().group().by(T.label).by(__.outE().fold())').filter((r) => r.gk === 'person' && r.v_id != null)).toHaveLength(6);
    expect(executeQuery(store, 'g.V().group().by(T.label).by(__.out().fold())', {})).toHaveLength(1);
  });

  test('is(P) filters a scalar stream; TextP is LIKE', () => {
    const store = seededStore();
    expect(run(store, 'g.V().values("age").is(P.gt(30))').map((r) => r.v).sort()).toEqual([32, 35]);
    expect(run(store, 'g.V().hasLabel("person").count().is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().has("name", TextP.startingWith("jo")).values("name")').map((r) => r.v)).toEqual(['josh']);
    expect(run(store, 'g.V().values("name").is(TextP.containing("ar"))').map((r) => r.v)).toEqual(['marko']);
  });

  test('where/not/filter filter the traverser (EXISTS/NULL semantics)', () => {
    const store = seededStore();
    // only marko knows anyone
    expect(run(store, 'g.V().where(__.out("knows")).values("name")').map((r) => r.v)).toEqual(['marko']);
    // creators
    expect(run(store, 'g.V().where(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
    // not(created): software has no age either — NULL is kept (not(traversal) = no output)
    expect(run(store, 'g.V().not(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
    // people known by someone
    expect(run(store, 'g.V().hasLabel("person").where(__.inE("knows").count().is(P.gte(1))).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
    expect(run(store, 'g.V().filter(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  });

  test('multi-hop where executes: correlated EXISTS over the path', () => {
    const store = seededStore();
    // has an out-neighbour created ripple → only josh (josh created ripple)
    expect(run(store, 'g.V().where(__.out().has("name","ripple")).values("name")').map((r) => r.v)).toEqual(['josh']);
    // has a 2-hop out path → only marko (marko→josh→ripple/lop)
    expect(run(store, 'g.V().where(__.out().out()).values("name")').map((r) => r.v)).toEqual(['marko']);
    // created something that is a software vertex → marko, josh, peter
    expect(run(store, 'g.V().where(__.out("created").hasLabel("software")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
    // terminal values().is on the neighbour: known-by a person over 30 → nobody (marko is 29)
    expect(run(store, 'g.V().where(__.in("knows").values("age").is(P.gt(30)))').map((r) => r.v)).toEqual([]);
    // where(__.label().is(P)) — current-label predicate
    expect(run(store, 'g.V().where(__.label().is("person")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
    // where(__.not(t)) — negated inner predicate (non-creators)
    expect(run(store, 'g.V().where(__.not(__.out("created"))).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
  });

  test('repeat/times/emit execute (multiset + emit bands)', () => {
    const store = seededStore();
    // exactly 2 out-hops from all V → ripple, lop
    expect(run(store, 'g.V().repeat(__.out()).times(2).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    // times before repeat is the same
    expect(run(store, 'g.V(1).times(2).repeat(__.out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    // emit-after from marko: depth1 {vadas,josh,lop} + depth2 {ripple,lop} — lop twice (multiset)
    expect(run(store, 'g.V(1).repeat(__.out()).times(2).emit().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
    // emit-before adds the seed (marko)
    expect(run(store, 'g.V(1).emit().repeat(__.out()).times(2).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
    // both() one hop from marko = 3 incident
    expect(run(store, 'g.V(1).repeat(__.both()).times(1).count()').map((r) => r.v)).toEqual([3]);
  });

  test('traverser bulking: repeat(...).times(n).count() == naive walk count (unroll path)', () => {
    const store = seededStore();
    // The bulked count (unrolled GROUP-BY-SUM(bulk) CTEs) must equal the exact walk
    // count the enumerate-every-walk recursion would produce. Cross-check against a
    // naive WITH RECURSIVE COUNT(*) for each depth on the modern graph.
    const naive = (t: number) =>
      store.query(
        `WITH RECURSIVE walk(id,depth) AS (SELECT id,0 FROM nodes UNION ALL ` +
        `SELECT e.tgt,walk.depth+1 FROM walk JOIN edges e ON e.src=walk.id WHERE walk.depth<${t}) ` +
        `SELECT COUNT(*) v FROM walk WHERE depth=${t}`,
      )[0].v;
    for (const t of [0, 1, 2, 3]) {
      const bulk = run(store, `g.V().repeat(__.out()).times(${t}).count()`)[0].v;
      expect(Number(bulk)).toBe(Number(naive(t)));
    }
    // times(2) out() over modern = 2 walks (marko->josh->{ripple,lop}); matches the
    // values("name") form's [lop, ripple] above.
    expect(run(store, 'g.V().repeat(__.out()).times(2).count()')[0].v).toBe(2);
    // both() bulks too (two legs merged per hop); V(1).both().times(1) = 3 incident.
    expect(run(store, 'g.V(1).repeat(__.both()).times(1).count()')[0].v).toBe(3);
    // A leading filter restricts the seed frontier (reuses buildPrefix for the source).
    expect(Number(run(store, 'g.V().hasLabel("person").repeat(__.out()).times(1).count()')[0].v))
      .toBe(Number(run(store, 'g.V().hasLabel("person").out().count()')[0].v));
  });

  test('unbounded emit() terminates at the fixpoint (no depth cap) — == times(2) here', () => {
    const store = seededStore();
    // out() from marko bottoms out at depth 2, so emit-only (no times) must terminate
    // there on its own. The test COMPLETING is the proof it terminates; the result must
    // match the depth-bounded form. emit-after → all iterations, not the seed.
    expect(run(store, 'g.V(1).repeat(__.out()).emit().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
    // emit-before adds the seed (marko)
    expect(run(store, 'g.V(1).emit().repeat(__.out()).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas']);
  });

  test('user-supplied string ids: create, seed, traverse, expose (COALESCE uid,id)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const w = (q: string) => { const p = compile(q, {}); if (p.kind !== 'write') throw new Error('want write'); return p.run(store); };
    const r = (q: string) => { const p = compile(q, {}); if (p.kind === 'write') return p.run(store); return store.query(p.sql, p.binds); };
    w('g.addV("person").property(T.id,"person:marko").property("name","marko")');
    w('g.addV("person").property(T.id,"person:vadas").property("name","vadas")');
    w('g.V("person:marko").addE("knows").to(__.V("person:vadas"))');
    expect(r('g.V("person:marko").id()').map((x: any) => x.v)).toEqual(['person:marko']); // V(uid) seed + id() exposure
    expect(r('g.V("person:marko").out("knows").id()').map((x: any) => x.v)).toEqual(['person:vadas']); // traverse + expose
    expect(r('g.V("person:marko").values("name")').map((x: any) => x.v)).toEqual(['marko']);
    // plain addV (no T.id) keeps its integer rowid as the id — mixed graph
    const lop = w('g.addV("software").property("name","lop")');
    expect(typeof (lop[0] as any).vertex.id).toBe('number');
    expect(r('g.V().has("name","lop").id()').map((x: any) => typeof x.v)).toEqual(['number']);
  });

  test('and/or/union/optional execute correctly', () => {
    const store = seededStore();
    // and: has BOTH out-knows and out-created → only marko
    expect(run(store, 'g.V().and(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual(['marko']);
    // union: marko's knows + created neighbours
    expect(run(store, 'g.V(1).union(__.out("knows"), __.out("created")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'vadas']);
    expect(run(store, 'g.V(1).union(__.values("name"), __.constant("x"))').map((r) => r.v).sort())
      .toEqual(['marko', 'x']);
    expect(run(store, 'g.V(1).union(__.values("name").toUpper(), __.constant("x").toUpper())').map((r) => r.v).sort())
      .toEqual(['MARKO', 'X']);
    expect(run(store, 'g.V(1).union(__.out().count(), __.in().count())').map((r) => r.v))
      .toEqual([3, 0]);
    expect(run(store, 'g.V(1).union(__.outE("knows").values("weight").sum(), __.outE("created").values("weight").sum())').map((r) => r.v))
      .toEqual([1.5, 0.4]);
    expect(run(store, 'g.V(1).union(__.out("knows").values("name").fold(), __.out("created").values("name").fold()).unfold().order()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'vadas']);
    expect(run(store, 'g.V(1).union(__.out("knows").fold(), __.out("created").fold()).unfold().values("name").order()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'vadas']);
    // optional hit: josh created ripple+lop
    expect(run(store, 'g.V(4).optional(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    // optional miss: vadas has no out-created → falls back to self
    expect(run(store, 'g.V(2).optional(__.out("created")).values("name")').map((r) => r.v)).toEqual(['vadas']);
    // optional over the whole graph: marko(2 knows) + 5 others as self = 7
    expect(run(store, 'g.V().optional(__.out("knows")).count()').map((r) => r.v)).toEqual([7]);
  });

  test('choose(pred, then, else) executes both arms, multiset preserved', () => {
    const store = seededStore();
    // person → out(created); software → in(created). Covers both arms + multiset.
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.out("created"), __.in("created")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'josh', 'lop', 'lop', 'lop', 'marko', 'peter', 'ripple']);
    // 2-arg: software → in(created) (creators); person → identity (self)
    expect(run(store, 'g.V().choose(__.hasLabel("software"), __.in("created")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'josh', 'josh', 'marko', 'marko', 'peter', 'peter', 'vadas']);
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name"), __.constant("software"))').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter', 'software', 'software', 'vadas']);
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name").toUpper(), __.constant("software").toUpper())').map((r) => r.v).sort())
      .toEqual(['JOSH', 'MARKO', 'PETER', 'SOFTWARE', 'SOFTWARE', 'VADAS']);
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.out().count(), __.in().count()).count()').map((r) => r.v))
      .toEqual([6]);
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.values("name").fold(), __.constant("software").fold()).unfold().count()').map((r) => r.v))
      .toEqual([6]);
    expect(run(store, 'g.V().choose(__.hasLabel("person"), __.identity().fold(), __.in().fold()).unfold().count()').map((r) => r.v))
      .toEqual([8]);
    // predicate = count().is: marko has 2 knows-edges → out(knows); others → self
    expect(run(store, 'g.V(1).choose(__.out("knows").count().is(P.gt(1)), __.out("knows")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
  });

  test('coalesce() executes first-non-empty-per-input, multiset preserved', () => {
    const store = seededStore();
    // per vertex: knows if any, else created. marko→(vadas,josh); josh→(ripple,lop);
    // peter→(lop); vadas/lop/ripple→nothing.
    expect(run(store, 'g.V().coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'lop', 'ripple', 'vadas']);
    // single input, first branch empty → falls to second
    expect(run(store, 'g.V(6).coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual(['lop']);
    // all branches empty → no output (not self)
    expect(run(store, 'g.V(2).coalesce(__.out("knows"), __.out("created")).values("name")').map((r) => r.v)).toEqual([]);
    expect(run(store, 'g.V().coalesce(__.values("age"), __.constant(0))').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 27, 29, 32, 35]);
    expect(run(store, 'g.V(1).coalesce(__.values("missing"), __.values("name"), __.constant("x"))').map((r) => r.v))
      .toEqual(['marko']);
    expect(run(store, 'g.V(1).coalesce(__.values("missing"), __.values("name").toUpper())').map((r) => r.v))
      .toEqual(['MARKO']);
    // count is total, so even zero is productive and prevents fallback.
    expect(run(store, 'g.V(2).coalesce(__.out().count(), __.constant(99))').map((r) => r.v)).toEqual([0]);
    // fold() is total: an empty list is productive, so coalesce must not advance.
    expect(run(store, 'g.V(1).coalesce(__.values("missing").fold(), __.values("name").fold()).unfold().count()').map((r) => r.v))
      .toEqual([0]);
    expect(run(store, 'g.V(2).coalesce(__.out().fold(), __.identity().fold()).unfold().count()').map((r) => r.v))
      .toEqual([0]);
    // Element branch row policies are per parent through the shared child compiler.
    // Two equal parents must each retain their own first outgoing result.
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).coalesce(__.out().limit(1),__.identity()).values("name")').map((r) => r.v))
      .toEqual(['vadas', 'vadas']);
    expect(run(store, 'g.V(1).coalesce(__.out().dedup(),__.identity()).count()').map((r) => r.v))
      .toEqual([3]);
    // Nested element branches use the same non-materializing lowerer. choose() must
    // retain coalesce's parent ordinal so first-productivity remains per traverser.
    expect(run(store, 'g.V().coalesce(__.choose(__.hasLabel("person"),__.out("created"),__.in("created")),__.identity()).count()').map((r) => r.v))
      .toEqual([9]);
  });

  test('optional()/flatMap() multi-hop execute correctly', () => {
    const store = seededStore();
    // multi-hop optional HIT: marko out().out() = josh's creations = lop,ripple
    expect(run(store, 'g.V(1).optional(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    // multi-hop optional MISS → self: peter out().out() empty → peter
    expect(run(store, 'g.V(6).optional(__.out().out()).values("name")').map((r) => r.v)).toEqual(['peter']);
    // optional(both()) hit: vadas both = marko (knows-in)
    expect(run(store, 'g.V(2).optional(__.both()).values("name")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V(1).optional(__.out().dedup()).count()').map((r) => r.v)).toEqual([3]);
    // Rebinding an existing alias inside the child is schema-preserving and now
    // composes through optional's origin scope (a new one-sided alias still fails).
    expect(run(store, 'g.V(1).as("a").optional(__.out().as("a")).select("a").values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'vadas']);
    // flatMap = inline the body: marko out().out() = lop,ripple
    expect(run(store, 'g.V(1).flatMap(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    expect(run(store, 'g.V(1).flatMap(__.out().values("name"))').map((r) => r.v).sort()).toEqual(['josh', 'lop', 'vadas']);
    expect(run(store, 'g.V(1).flatMap(__.out().values("name").toUpper())').map((r) => r.v).sort()).toEqual(['JOSH', 'LOP', 'VADAS']);
    expect(run(store, 'g.V().flatMap(__.values("age")).count()').map((r) => r.v)).toEqual([4]);
  });

  test('branch fork/merge of DIVERGENT arm labels executes (union/coalesce/choose)', () => {
    const store = seededStore();
    // union: arm1 binds 'k' (knows→vadas,josh), arm2 binds 'c' (created→lop). select('k')
    // keeps only arm1 rows (arm2 padded k=NULL → dropped); select('c') only arm2.
    expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created').as('c')).select('k').values('name')").map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
    expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created').as('c')).select('c').values('name')").map((r) => r.v).sort())
      .toEqual(['lop']);
    // the SAME label bound in both arms is NOT divergent — every row is present.
    expect(run(store, "g.V(1).union(__.out('knows').as('x'), __.out('created').as('x')).select('x').values('name')").map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'vadas']);
    // presence guard prevents overcounting: only the binding arm's rows survive select().
    expect(run(store, "g.V(1).union(__.out('knows').as('k'), __.out('created')).select('k').count()").map((r) => r.v))
      .toEqual([2]);
    // coalesce: peter has no knows → the created arm wins and binds 'c'; 'k' is unbound.
    expect(run(store, "g.V(6).coalesce(__.out('knows').as('k'), __.out('created').as('c')).select('c').values('name')").map((r) => r.v).sort())
      .toEqual(['lop']);
    expect(run(store, "g.V(6).coalesce(__.out('knows').as('k'), __.out('created').as('c')).select('k')").map((r) => r.v))
      .toEqual([]);
    // choose: marko matches → then-arm binds 'k'.
    expect(run(store, "g.V(1).choose(__.has('name','marko'), __.out('knows').as('k'), __.out('created').as('c')).select('k').values('name')").map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
  });

  test('where() on a record + P.not alias-compare execute (Where.feature)', () => {
    const store = seededStore();
    const g = "g.V().has('age').as('a').out().in().has('age').as('b').select('a','b')";
    // eq: a==b (out().in() returns to self) → marko×3, josh×2, peter×1
    expect(run(store, `${g}.where('a', P.eq('b')).select('a').values('name')`).map((r) => r.v).sort())
      .toEqual(['josh', 'josh', 'marko', 'marko', 'marko', 'peter']);
    // neq and P.not(eq) are equivalent complements (12 pairs total → 6 each)
    expect(run(store, `${g}.where('a', P.neq('b')).count()`).map((r) => r.v)).toEqual([6]);
    expect(run(store, `${g}.where('a', P.not(P.eq('b'))).count()`).map((r) => r.v)).toEqual([6]);
    // element where(P.not(P.eq(label))) == where(P.neq(label))
    expect(run(store, "g.V(1).as('a').both().where(P.not(P.eq('a'))).values('name')").map((r) => r.v).sort())
      .toEqual(run(store, "g.V(1).as('a').both().where(P.neq('a')).values('name')").map((r) => r.v).sort());
  });

  test('option-map choose executes: choice scalar → matched option body', () => {
    const store = seededStore();
    // age in [26,30) → "x" (marko 29, vadas 27), else "z"
    expect(run(store, 'g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))').map((r) => r.v).sort())
      .toEqual(['x', 'x', 'z', 'z', 'z', 'z']);
    // T.label dispatch: person→P (4), software→S (2)
    expect(run(store, 'g.V().choose(T.label).option("person", __.constant("P")).option("software", __.constant("S")).option(Pick.none, __.constant("?"))').map((r) => r.v).sort())
      .toEqual(['P', 'P', 'P', 'P', 'S', 'S']);
    // out(created) degree: 0→"none" (vadas,lop,ripple), else values(name)
    expect(run(store, 'g.V().choose(__.out("created").count()).option(0, __.constant("none")).option(Pick.none, __.values("name"))').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'none', 'none', 'none', 'peter']);
    expect(run(store, 'g.V().choose(T.label).option("person", __.constant("P")).option(Pick.none, __.constant("S")).is("P").count()').map((r) => r.v))
      .toEqual([4]);
    // Only the SELECTED option body's productivity matters; productive NULL remains
    // a value, while an unproductive matched body drops its parent.
    expect(run(store, 'g.V().choose(T.label).option("software", __.values("age")).option(Pick.none, __.constant("p"))').map((r) => r.v))
      .toEqual(['p', 'p', 'p', 'p']);
    expect(run(store, 'g.V().choose(T.label).option("person", __.constant(null)).option(Pick.none, __.constant("s"))').map((r) => r.v).sort())
      .toEqual([null, null, null, null, 's', 's']);
  });

  test('map(__.<scalar>) executes per-traverser', () => {
    const store = seededStore();
    // out-degree per vertex: marko3, josh2, peter1, vadas/lop/ripple 0
    expect(run(store, 'g.V().map(__.out().count())').map((r) => r.v).sort((a, b) => a - b)).toEqual([0, 0, 0, 1, 2, 3]);
    // per-vertex property projection
    expect(run(store, 'g.V(1).out("knows").map(__.values("name"))').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
    // Productivity is row existence: missing values drop their parents. Movement
    // and scalar projection share the first-productive-row child policy.
    expect(run(store, 'g.V().map(__.values("age"))').map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    expect(run(store, 'g.V(1).map(__.out().values("name"))').map((r) => r.v)).toEqual(['vadas']);
    // A productive null is a real traverser, not an empty child result.
    expect(run(store, 'g.V(1).map(__.constant(null))').map((r) => r.v)).toEqual([null]);
    expect(run(store, 'g.V().map(__.out().count()).is(P.gt(0)).count()').map((r) => r.v)).toEqual([3]);
  });

  test('element-body map keeps the first productive child per parent', () => {
    const store = seededStore();
    expect(run(store, 'g.V().map(__.out()).values("name")').map((r) => r.v).sort())
      .toEqual(['lop', 'lop', 'vadas']);
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).map(__.out()).values("name")').map((r) => r.v))
      .toEqual(['vadas', 'vadas']);
    expect(run(store, 'g.V().map(__.out().hasLabel("software")).values("name")').map((r) => r.v))
      .toEqual(['lop', 'lop', 'lop']);
    expect(run(store, 'g.V(1).map(__.outE("knows")).inV().values("name")').map((r) => r.v))
      .toEqual(['vadas']);
  });

  test('scalar-producing leaves re-enter common lowering', () => {
    const store = seededStore();
    expect(run(store, 'g.V().math("_").by("age").is(P.gt(30)).count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V().as("a").out("created").as("b").math("b + a").by(__.in("created").count()).by("age")').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([32, 33, 35, 38]);
    expect(run(store, 'g.V().format("%{age}").count()').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().format("%{name} has %{_}").by(__.bothE().count())').map((r) => r.v).sort())
      .toEqual(['josh has 3', 'lop has 3', 'marko has 3', 'peter has 1', 'ripple has 1', 'vadas has 1']);
    expect(run(store, 'g.withSack(7).V().sack().is(7).count()').map((r) => r.v)).toEqual([6]);
  });

  test('alias-in-predicate where — re-root the sub-traversal on an as()/select() label', () => {
    const store = seededStore();
    // keep created-things whose creator (a) is josh, then their creators' names
    expect(run(store, 'g.V().as("a").out("created").where(__.as("a").values("name").is("josh")).in("created").values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'josh', 'marko', 'peter']);
    // or() of two select('n') branches (all vertices are person or software)
    expect(run(store, 'g.V().as("n").where(__.or(__.select("n").hasLabel("software"), __.select("n").hasLabel("person"))).select("n").by("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    // multi-hop chain rooted at an alias b
    expect(run(store, 'g.V(1).as("a").out("created").in("created").as("b").where(__.as("b").out("created").has("name","ripple")).values("name")').map((r) => r.v))
      .toEqual(['josh']);
    // SQL: the predicate correlates on the alias column (an ANY-match EXISTS over vertex_properties)
    expect(read('g.V().as("a").out().where(__.as("a").values("name").is("marko"))').sql)
      .toContain("EXISTS(SELECT 1 FROM vertex_properties WHERE node=CAST(p.a0 ->> ? AS INTEGER) AND key=? AND value = ?)");
    // unknown label fails closed
    expect(() => compile('g.V().where(__.as("z").out())', {})).toThrow('no such label');
  });

  test('match() — conjunctive pattern join over shared variables', () => {
    const store = seededStore();
    // a knows b AND a created c (multi-select raw cols are e{i}_v)
    expect(run(store, 'g.V().match(__.as("a").out("knows").as("b"), __.as("a").out("created").as("c")).select("a","b","c").by("name")')
      .map((r: any) => `${r.e0_v}-${r.e1_v}-${r.e2_v}`).sort())
      .toEqual(['marko-josh-lop', 'marko-vadas-lop']);
    // co-creators (a and c both created b), a != c
    expect(run(store, 'g.V().match(__.as("a").out("created").as("b"), __.as("b").in("created").as("c")).where("a",P.neq("c")).select("a","c").by("name")')
      .map((r: any) => `${r.e0_v}-${r.e1_v}`).sort())
      .toEqual(['josh-marko', 'josh-peter', 'marko-josh', 'marko-peter', 'peter-josh', 'peter-marko']);
    // pattern order is declarative (root = the start-only var 'a', not the first pattern)
    expect(run(store, 'g.V().match(__.as("b").out("created").as("c"), __.as("a").out("knows").as("b")).select("a").by("name")').map((r) => r.v).sort())
      .toEqual(['marko', 'marko']);
    // shared-var + has-filter patterns, count of solutions
    expect(run(store, 'g.V().match(__.as("a").out("knows").as("b")).count()').map((r) => r.v)).toEqual([2]);
    // pattern bodies fold through the shared StepFns, so both()/multi-hop/where() work
    // without a private movement/filter vocabulary. both() is bidirectional.
    expect(run(store, 'g.V().match(__.as("a").both("knows").as("b")).select("a","b").by("name")')
      .map((r: any) => `${r.e0_v}-${r.e1_v}`).sort())
      .toEqual(['josh-marko', 'marko-josh', 'marko-vadas', 'vadas-marko']);
    expect(run(store, 'g.V().match(__.as("a").out().out().as("b")).select("a","b").by("name")')
      .map((r: any) => `${r.e0_v}-${r.e1_v}`).sort())
      .toEqual(['marko-lop', 'marko-ripple']);
  });

  test('match() deferrals fail closed', () => {
    // an edge-typed end var (the binding table carries node rowids)
    expect(() => compile('g.V().match(__.as("a").outE("created").as("b"))', {})).toThrow('edge-typed pattern');
    // scalar-terminal pattern (count binds a scalar var)
    expect(() => compile('g.V().match(__.as("a").out("knows").count().as("b"))', {})).toThrow('count()');
    // mutual recursion → no single start-only root
    expect(() => compile('g.V().match(__.as("a").out("created").as("b"), __.as("b").in("created").as("a"))', {})).toThrow('root variable');
    // or/and pattern
    expect(() => compile('g.V().match(__.or(__.as("a").out().as("b")))', {})).toThrow('must start with as');
  });

  test('alias-compare where — the co-creator idiom', () => {
    const store = seededStore();
    // people who created something also created by someone else (exclude self)
    const names = run(store, 'g.V().as("a").out("created").in("created").where(P.neq("a")).values("name")').map((r) => r.v).sort();
    expect(names).toEqual(['josh', 'josh', 'marko', 'marko', 'peter', 'peter']); // all three co-created lop
  });

  test('sum() sums a value stream; fold() collects it', () => {
    const store = seededStore();
    expect(run(store, 'g.V().hasLabel("person").values("age").sum()').map((r) => r.v)).toEqual([123]);
    expect(JSON.parse(run(store, 'g.V().values("name").fold()')[0].list).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('edge-gate composite key rows carry o/l/i + the edge (gate #2)', () => {
    const store = seededStore();
    const rows = run(store, 'g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())');
    // 6 distinct edges → 6 groups; verify marko-created->lop maps to edge 9
    const hit = rows.find((r) => r.k0_v === 'marko' && r.k1_v === 'created' && r.k2_v === 'lop');
    expect(hit.v_id).toBe(9);
    expect(hit.v_src).toBe(1); expect(hit.v_tgt).toBe(3);
  });

  test('drop() after an edge-reading traversal deletes the right vertices', () => {
    // regression: g.V(1).out().drop() must drop marko's out-neighbors, not just
    // their edges. Snapshotting target ids before mutating guards this.
    const store = seededStore();
    run(store, 'g.V(1).out().drop()'); // vadas(2), lop(3), josh(4)
    const remaining = run(store, 'g.V().values("name")').map((r) => r.v).sort();
    expect(remaining).toEqual(['marko', 'peter', 'ripple']);
  });

  test('drop() removes vertices and their incident edges', () => {
    const store = seededStore();
    run(store, 'g.V(1).drop()'); // marko + edges 7,8,9
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([5]);
    // marko was src of 3 edges; all gone
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3);
  });

  test('g.V().drop() empties the graph (cucumber reset idiom)', () => {
    const store = seededStore();
    run(store, 'g.V().drop()');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([0]);
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
  });

  test('edge drop() deletes only the matched edges, not their endpoints', () => {
    const store = seededStore();
    run(store, 'g.V(1).outE().drop()'); // marko's 3 out-edges (7,8,9)
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // every vertex survives
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3); // edges 10,11,12 remain
  });

  test('g.E().drop() removes every edge but keeps all vertices', () => {
    const store = seededStore();
    run(store, 'g.E().drop()');
    expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
  });

  test('property() updates existing vertices (overwrite + new key, single cardinality)', () => {
    const store = seededStore();
    // overwrite marko's age, add a new key
    const res = run(store, 'g.V(1).property("age", 30).property("city", "London")');
    expect(bare((res[0] as any).vertex)).toEqual({ id: 1, label: 'person', props: { name: 'marko', age: 30, city: 'London' } });
    expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([30]);
    expect(run(store, 'g.V(1).values("city")').map((r) => r.v)).toEqual(['London']);
    // untouched vertices keep their props
    expect(run(store, 'g.V(2).values("age")').map((r) => r.v)).toEqual([27]);
  });

  test('property() updates every matched vertex in the set', () => {
    const store = seededStore();
    run(store, 'g.V().hasLabel("person").property("kind", "human")');
    expect(run(store, 'g.V().has("kind","human").count()').map((r) => r.v)).toEqual([4]);
  });

  test('property(k, __.trav): correlated value from the read spine', () => {
    const store = seededStore();
    // scalar copy: each person's age → a new key, evaluated per element
    run(store, 'g.V().has("age").property("a2", __.values("age"))');
    expect(run(store, 'g.V().values("a2")').map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    // count-shaped value: marko(1) has 3 out-edges → deg=3, stored as a Long vtype
    run(store, 'g.V(1).property("deg", __.outE().count())');
    expect(run(store, 'g.V(1).values("deg")').map((r) => r.v)).toEqual([3]);
    expect(store.query("SELECT vtype FROM vertex_properties WHERE key='deg'", []).map((r: any) => r.vtype)).toEqual(['long']);
    // empty nested traversal → the property is NOT written (lop=3 has no age)
    run(store, 'g.V(3).property("noage", __.values("age"))');
    expect(run(store, 'g.V(3).values("noage")').length).toBe(0);
    // edge property from a traversal value
    run(store, 'g.E().property("checked", __.constant(true))');
    expect(run(store, 'g.E().values("checked")').every((r: any) => r.v === 1 || r.v === true)).toBe(true);
  });

  test('property() cardinality: single replaces, list appends, set dedups (W4)', () => {
    const store = seededStore();
    // single replaces the existing value
    run(store, 'g.V(1).property(Cardinality.single, "age", 40)');
    expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([40]);
    // list appends — multiple values under one key
    run(store, 'g.V(1).property(Cardinality.list, "nick", "x")');
    run(store, 'g.V(1).property(Cardinality.list, "nick", "y")');
    expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
    // set dedups by value — re-adding "x" is a no-op
    run(store, 'g.V(1).property(Cardinality.set, "nick", "x")');
    expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
    // has() matches ANY value under the key (multi-property semantics)
    expect(run(store, 'g.V(1).has("nick","y").count()').map((r) => r.v)).toEqual([1]);
  });

  test('addV multi-property + meta-property write (W4)', () => {
    const store = seededStore();
    run(store, 'g.addV("crew").property(Cardinality.list, "location", "sd", "startTime", 1997).property(Cardinality.list, "location", "sf", "startTime", 2005)');
    // both values land under the multi-valued key
    expect(run(store, 'g.V().hasLabel("crew").values("location")').map((r) => r.v).sort()).toEqual(['sd', 'sf']);
    // the meta blob is stored on the VertexProperty row
    const metas = store.query("SELECT json(meta) m FROM vertex_properties WHERE key='location' ORDER BY value").map((r: any) => JSON.parse(r.m));
    expect(metas).toEqual([{ startTime: 1997 }, { startTime: 2005 }]);
  });

  test('meta-property read chains: has(metaKey) filter, properties().properties(), valueMap (W4)', () => {
    const store = seededStore();
    run(store, 'g.V(1).property(Cardinality.single, "name", "stephenm", "since", 2010)');
    // properties(k).has(metaKey, v) filters the VertexProperty stream by its meta
    expect(run(store, 'g.V(1).properties("name").has("since",2010).count()').map((r) => r.v)).toEqual([1]);
    expect(run(store, 'g.V(1).properties("name").has("since",2011).count()').map((r) => r.v)).toEqual([0]);
    // properties().properties() explodes a VertexProperty's meta into Property elements
    expect(run(store, 'g.V(1).properties("name").properties()').length).toBe(1); // one meta-prop: since
    // properties(k).valueMap() shape is a flat meta map
    expect(read('g.V(1).properties("name").valueMap()').shape).toEqual({ kind: 'metaMap' });
    // properties().id() surfaces the real VertexProperty rowid
    expect(read('g.V(1).properties("name").id()').shape).toEqual({ kind: 'value' });
  });

  test('property() updates edges too (materialized on the wire via edgeBuffer)', () => {
    const store = seededStore();
    const res = run(store, 'g.V(1).outE("created").property("weight2", 0.9)');
    expect(bare((res[0] as any).edge.props)).toEqual({ weight: 0.4, weight2: 0.9 });
    expect(run(store, 'g.V(1).outE("created").values("weight2")').map((r) => r.v)).toEqual([0.9]);
  });

  test('addE start-step: from()/to() nested traversals + edge property', () => {
    const store = seededStore();
    const res = run(store, 'g.addE("knows").from(__.V().has("name","marko")).to(__.V().has("name","vadas")).property("weight", 0.9)');
    expect(bare((res[0] as any).edge)).toMatchObject({ label: 'knows', src: 1, tgt: 2, props: { weight: 0.9 } });
    // marko already knew vadas (edge 7); now a second knows edge exists → 2 paths to vadas
    expect(run(store, 'g.V(1).out("knows").has("name","vadas").count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V(1).outE("knows").count()').map((r) => r.v)).toEqual([3]);
  });

  test('addE from() sets outV, incoming traverser is inV', () => {
    const store = seededStore();
    // g.V(2).addE("likes").from(__.V(1)) → edge 1→2 (inV defaults to current, vadas)
    run(store, 'g.V(2).addE("likes").from(__.V(1))');
    expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['vadas']);
  });

  test('addE mid-traversal with as() alias endpoint (per incoming traverser)', () => {
    const store = seededStore();
    // everything marko created gets a createdBy edge back to marko
    run(store, 'g.V(1).as("a").out("created").addE("createdBy").to("a")');
    expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
  });

  test('addE sets its own uid via property(T.id)', () => {
    const store = seededStore();
    const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(T.id, "e:marko-vadas")');
    expect((res[0] as any).edge.id).toBe('e:marko-vadas');
    expect(run(store, 'g.E("e:marko-vadas").label()').map((r) => r.v)).toEqual(['knows']);
  });

  test('addE write-chain graph initializer (addV.as.addV.as.addE.from.to)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.addV("person").property("name","marko").as("a").addV("person").property("name","vadas").as("b").addE("knows").from("a").to("b").property("weight", 0.5)');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V().has("name","marko").out("knows").values("name")').map((r) => r.v)).toEqual(['vadas']);
    expect(run(store, 'g.V().has("name","marko").outE("knows").values("weight")').map((r) => r.v)).toEqual([0.5]);
  });

  test('addV inline property NESTED value routes through resolveSpecValue', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // __.constant(v) as an inline property value — evaluated at the new vertex.
    const res = run(store, 'g.addV("person").property("age", __.constant(29)).property("name", "marko")');
    expect(bare((res[0] as any).vertex)).toMatchObject({ label: 'person', props: { name: 'marko', age: 29 } });
    expect(run(store, 'g.V().has("person","age",29).values("name")').map((r) => r.v)).toEqual(['marko']);
  });

  test('addV nested property value seeds at the NEW (edge-less) vertex → out().count()=0', () => {
    const store = seededStore();
    run(store, 'g.addV("person").property("name","x").property("deg", __.out().count())');
    expect(run(store, 'g.V().has("name","x").values("deg")').map((r) => r.v)).toEqual([0]);
  });

  test('addE inline property NESTED value resolves + response echoes the resolved value', () => {
    const store = seededStore();
    const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property("w", __.constant(0.7))');
    // the framed response carries the resolved scalar, never a {nested} blob
    expect(bare((res[0] as any).edge.props)).toEqual({ w: 0.7 });
    expect(run(store, 'g.V(1).outE("knows").values("w")').map((r) => r.v)).toEqual([0.7]);
  });

  test('addV nested-traversal LABEL is evaluated at run time (no silent "vertex" default)', () => {
    const store = seededStore(); // modern: V(1)=marko/person
    run(store, 'g.addV(__.V(1).label()).property("name","clone")');
    expect(run(store, 'g.V().has("name","clone").label()').map((r) => r.v)).toEqual(['person']);
  });

  test('addE endpoint to(__.select("a")) ≡ to("a") (as()-label via nested select)', () => {
    const store = seededStore();
    run(store, 'g.V(1).as("a").out("created").addE("createdBy").to(__.select("a"))');
    expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
  });

  test('addE endpoint to(__.addV(...)) creates the target vertex as a side effect', () => {
    const store = seededStore(); // modern: 6 vertices
    run(store, 'g.addE("next").from(__.V(1)).to(__.addV("person").property("name","fresh"))');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([7]);
    // marko now has a "next" edge to the freshly-created vertex
    expect(run(store, 'g.V(1).out("next").values("name")').map((r) => r.v)).toEqual(['fresh']);
    expect(run(store, 'g.V().has("name","fresh").label()').map((r) => r.v)).toEqual(['person']);
  });

  test('addE endpoint traversal with a repeat cluster resolves (normalize fix)', () => {
    const store = seededStore(); // modern: V(1)=marko created lop(3)
    // to(...) endpoint uses a folded repeat/times cluster — must normalize before buildPrefix
    run(store, 'g.addE("x").from(__.V(2)).to(__.V(1).repeat(__.out("created")).times(1))');
    expect(run(store, 'g.V(2).out("x").values("name")').map((r) => r.v)).toEqual(['lop']);
  });

  test('addV nested LABEL __.constant(...) resolves (shared value authority)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.addV(__.constant("widget")).property("name","w")');
    expect(run(store, 'g.V().has("name","w").label()').map((r) => r.v)).toEqual(['widget']);
  });

  test('property() with a __.constant(...) KEY resolves; a live-read key fails closed', () => {
    const store = seededStore();
    run(store, 'g.addV("person").property(__.constant("nick"), "bob")');
    expect(run(store, 'g.V().has("nick","bob").count()').map((r) => r.v)).toEqual([1]);
    // a non-constant nested key is fail-closed (never a silent drop / "[object Object]")
    expect(() => run(store, 'g.V(1).property(__.union(__.constant("k")), "v")'))
      .toThrow(/nested-traversal key not yet supported/);
    expect(() => run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(__.union(__.constant("k")), "v")'))
      .toThrow(/nested-traversal key not yet supported/);
  });

  test('addV property value __.constant(UUID(...)) keeps the uuid vtype (not string)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.addV("person").property("gid", __.constant(UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c")))');
    const vt = store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype);
    expect(vt).toEqual(['uuid']);
  });

  test('mergeV creates when no match, matches when it exists (inline map)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const a = run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
    expect(bare((a[0] as any).vertex)).toMatchObject({ label: 'person', props: { name: 'marko' } });
    // second identical merge matches the first → still one vertex
    run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
    expect(run(store, 'g.V().hasLabel("person").has("name","marko").count()').map((r) => r.v)).toEqual([1]);
  });

  test('mergeV map literal with a NESTED value ([k: __.trav]) resolves it', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // a per-value traversal in the merge map — legal per grammar (mapEntry value is a
    // genericLiteral, which includes nestedTraversal). __.constant('zed') → 'zed'.
    run(store, 'g.mergeV([(T.label): "person", name: __.constant("zed")])');
    expect(run(store, 'g.V().hasLabel("person").values("name")').map((r) => r.v)).toEqual(['zed']);
    // matching against the same nested-valued map re-resolves and matches → still one
    run(store, 'g.mergeV([(T.label): "person", name: __.constant("zed")])');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  });

  test('mergeV nested map value is CORRELATED per driver (varies by incoming element)', () => {
    const store = seededStore(); // modern: 4 person vertices
    // per person, merge a "tag" vertex whose src = that person's name → correlation
    // produces one distinct tag per person.
    run(store, 'g.V().hasLabel("person").mergeV([(T.label): "tag", src: __.values("name")])');
    expect(run(store, 'g.V().hasLabel("tag").values("src")').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('mergeV literal map values keep their parsed type (uuid/long), not JS-inferred', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, "g.mergeV([(T.label):'person', gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'), n: 5L])");
    const rows = store.query("SELECT key, vtype FROM vertex_properties ORDER BY key").map((r: any) => [r.key, r.vtype]);
    expect(rows).toEqual([['gid', 'uuid'], ['n', 'long']]);
  });

  test('mergeV nested map value keeps the read-shape type (uuid)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, "g.mergeV([(T.label):'person', gid: __.constant(UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'))])");
    expect(store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
  });

  test('mergeV onCreate typed value is honored on create', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, "g.mergeV([(T.label):'person', name:'x']).option(Merge.onCreate, [gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
    expect(store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
  });

  test('mergeE literal edge property value keeps its parsed type (uuid)', () => {
    const store = seededStore(); // modern: V(1)=marko, V(2)=vadas
    run(store, "g.mergeE([(T.label):'rated', (Direction.OUT): 1, (Direction.IN): 2, gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
    expect(store.query("SELECT vtype FROM edge_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
  });

  test('mergeV whole-arg traversal beyond select-const fails CLOSED with a specific message', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    expect(() => run(store, 'g.inject(0).mergeV(__.identity())'))
      .toThrow(/map-valued driver|not yet supported/);
  });

  test('mergeV([:]) matches all; on empty graph creates one default-label vertex', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.mergeV([:])');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
    // now match-all matches the one; no new vertex
    run(store, 'g.mergeV([:])');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  });

  test('mergeV mid-chain runs per incoming traverser (g.V().mergeV([:]) → N×matches)', () => {
    const store = seededStore(); // 6 vertices
    const res = run(store, 'g.V().mergeV([:])'); // each of 6 drivers matches all 6
    expect(res.length).toBe(36);
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // no creates
  });

  test('mergeV option(onMatch) patches props on the matched vertex', () => {
    const store = seededStore();
    run(store, 'g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, [age: 30])');
    expect(run(store, 'g.V().has("name","marko").values("age")').map((r) => r.v)).toEqual([30]);
  });

  test('mergeV option(onCreate) adds props only on the create branch', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.mergeV([(T.label): "person", name: "stephen"]).option(Merge.onCreate, [created: "Y"])');
    expect(run(store, 'g.V().has("name","stephen").values("created")').map((r) => r.v)).toEqual(['Y']);
  });

  test('mergeV/mergeE map from withSideEffect + __.select(key) constant', () => {
    // onCreate: select("c") is the (absent) match map, select("m") the create props
    const s1 = new GraphStore(new BunSqlite(':memory:'));
    run(s1, 'g.addV("person").property("name","marko").property("age",29)');
    run(s1, 'g.withSideEffect("c",[(T.label):"person","name":"stephen"]).withSideEffect("m",[(T.label):"person","name":"stephen","age":19]).mergeV(__.select("c")).option(Merge.onCreate, __.select("m"))');
    expect(run(s1, 'g.V().has("person","name","stephen").values("age")').map((r) => r.v)).toEqual([19]);
    // onMatch: select("c") matches marko, select("m") patches age
    const s2 = new GraphStore(new BunSqlite(':memory:'));
    run(s2, 'g.addV("person").property("name","marko").property("age",29)');
    run(s2, 'g.withSideEffect("c",[(T.label):"person","name":"marko"]).withSideEffect("m",["age":19]).mergeV(__.select("c")).option(Merge.onMatch, __.select("m"))');
    expect(run(s2, 'g.V().has("person","name","marko").values("age")').map((r) => r.v)).toEqual([19]);
    // mergeE match map from a side-effect constant
    const s3 = new GraphStore(new BunSqlite(':memory:'));
    run(s3, 'g.addV().property(T.id, 1).as("a").addV().property(T.id, 2).as("b")');
    run(s3, 'g.withSideEffect("a",[(T.label):"knows",(Direction.OUT):1,(Direction.IN):2]).mergeE(__.select("a"))');
    expect(run(s3, 'g.E().hasLabel("knows").count()').map((r) => r.v)).toEqual([1]);
    // a select() with no matching withSideEffect fails closed
    expect(() => run(new GraphStore(new BunSqlite(':memory:')), 'g.mergeV(__.select("nope"))'))
      .toThrow("needs a withSideEffect('nope', map)");
  });

  test('write-arg value/key from __.select(k) of a withSideEffect constant', () => {
    // property() value on an existing element
    const s1 = new GraphStore(new BunSqlite(':memory:'));
    run(s1, 'g.addV("software").property("name","lop")');
    run(s1, 'g.withSideEffect("a","test").V().hasLabel("software").property("temp",__.select("a"))');
    expect(run(s1, 'g.V().values("temp")').map((r) => r.v)).toEqual(['test']);
    // addV property() value
    const s2 = new GraphStore(new BunSqlite(':memory:'));
    run(s2, 'g.withSideEffect("a","marko").addV().property("name",__.select("a"))');
    expect(run(s2, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
    // property() KEY from a constant
    const s3 = new GraphStore(new BunSqlite(':memory:'));
    run(s3, 'g.withSideEffect("a","name").addV().property(__.select("a"),"marko")');
    expect(run(s3, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
  });

  test('mergeV accepts a bound Map parameter with EnumValue keys (wire path)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // mimic a GraphBinary-deserialized m[{"t[label]":"person","name":"stephen"}]
    const xx1 = new Map<any, any>([[{ typeName: 'T', elementName: 'label' }, 'person'], ['name', 'stephen']]);
    const p = compile('g.mergeV(xx1).option(Merge.onCreate, null)', { xx1 });
    if (p.kind !== 'write') throw new Error('want write');
    p.run(store);
    const r = compile('g.V().hasLabel("person").has("name","stephen").count()', {});
    if (r.kind !== 'read') throw new Error('want read');
    expect(store.query(r.sql, r.binds).map((x: any) => x.v)).toEqual([1]);
  });

  test('mergeE creates an edge between existing endpoints, then matches it', () => {
    const store = seededStore(); // marko=1, vadas=2, already knows via edge 7
    // a NEW label between marko and josh(4)
    const c = run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
    expect((c[0] as any).edge).toMatchObject({ label: 'likes', src: 1, tgt: 4 });
    expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['josh']);
    // merging again matches the existing edge → no duplicate
    run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
    expect(run(store, 'g.V(1).outE("likes").count()').map((r) => r.v)).toEqual([1]);
  });

  test('mergeE onCreate/onMatch patch edge props on the right branch', () => {
    const store = seededStore();
    run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
    expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['new']);
    // second merge takes the onMatch branch
    run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
    expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['old']);
  });

  test('mergeE raises when an endpoint vertex does not exist', () => {
    const store = seededStore();
    expect(() => run(store, 'g.mergeE([(T.label): "knows", (Direction.OUT): 100, (Direction.IN): 101])'))
      .toThrow(/Vertex does not exist for mergeE/);
  });

  test('bare mergeV()/mergeE() (incoming-as-map) is a clear deferral, not silent match-all', () => {
    const store = seededStore();
    expect(() => run(store, 'g.inject(0).mergeV()')).toThrow(/no argument/);
    expect(() => run(store, 'g.inject(0).mergeE()')).toThrow(/no argument/);
  });

  test('inject(v1,…).mergeV runs once per injected value (arity, not always 1)', () => {
    const store = seededStore(); // 6 vertices
    // 3 injected values → 3 drivers, each match-all matches 6 → 18 results, no creates
    expect(run(store, 'g.inject(1,2,3).mergeV([:])').length).toBe(18);
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
  });

  // ---------- path()/simplePath()/cyclicPath() (modern-graph semantics) ----------

  test('path() emits the ordered walk (one Path per distinct route)', () => {
    const store = seededStore();
    // marko(1)→josh(4)→{lop(3),ripple(5)} — two length-3 paths, in traversal order.
    const paths = run(store, 'g.V(1).out().out().path()').map((r) => [r.x0_id, r.x1_id, r.x2_id]);
    expect(paths).toEqual([[1, 4, 3], [1, 4, 5]]);
  });

  test('simplePath() drops repeated-vertex walks; cyclicPath() keeps only them', () => {
    const store = seededStore();
    // marko→created→lop→created→{marko,josh,peter}: the marko→lop→marko walk cycles.
    expect(run(store, 'g.V(1).out("created").in("created").simplePath().values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'peter']); // marko excluded (revisits marko)
    expect(run(store, 'g.V(1).out("created").in("created").cyclicPath().values("name")').map((r) => r.v))
      .toEqual(['marko']); // only the returns-to-marko walk
  });

  test('path().by(key) projects each element; a missing key drops the whole path', () => {
    const store = seededStore();
    // marko(age29)→{vadas27,josh32, lop(no age)}: lop path drops (non-productive by).
    const rows = run(store, 'g.V(1).out().path().by("age")').map((r) => [r.x0_v, r.x1_v]);
    expect(rows).toEqual([[29, 27], [29, 32]]); // three out-neighbours, only two survive
  });

  test('path() interleaves edges and vertices with materialized props (via framing)', async () => {
    const { ioc } = await import('../src/io.ts');
    const buffers = executeQuery(seededStore(), 'g.V(1).outE("created").inV().path()', {});
    const { v: path } = ioc.anySerializer.deserialize(Buffer.concat(buffers)); // one framed Path value
    expect(path.constructor.name).toBe('Path');
    expect(path.objects.map((o: any) => o.constructor.name)).toEqual(['Vertex', 'Edge', 'Vertex']);
    expect(path.labels).toEqual([new Set(), new Set(), new Set()]); // labels-on-path deferred
    // The reason for hand-framing: vertex props survive (client's serializer drops them).
    expect(path.objects[0].properties.map((p: any) => ({ [p.label]: p.value }))).toEqual([{ name: 'marko' }, { age: 29 }]);
  });

  // ---------- recursive repeat().path() (modern-graph semantics) ----------

  // Decode every Path from a framed GraphBinary response (shared by the recursive tests).
  async function decodePaths(store: GraphStore, gremlin: string): Promise<any[]> {
    const { ioc } = await import('../src/io.ts');
    const buffers = executeQuery(store, gremlin, {}); // one framed Path per result value
    return buffers.map((b) => ioc.anySerializer.deserialize(b).v);
  }

  test('repeat().times(n).path() emits the ordered walk, one Path per route', async () => {
    const paths = await decodePaths(seededStore(), 'g.V(1).repeat(__.out()).times(2).path()');
    // marko(1)→josh(4)→{lop(3),ripple(5)} — cycles allowed (no simplePath), depth-bounded.
    expect(paths.map((p) => p.objects.map((o: any) => o.id))).toEqual([[1, 4, 3], [1, 4, 5]]);
  });

  test('repeat(simplePath).times(3).path() = all acyclic length-4 walks (SimplePath.feature:34)', async () => {
    const paths = await decodePaths(seededStore(), 'g.V().repeat(__.both().simplePath()).times(3).path()');
    expect(paths.length).toBe(18); // the canonical count
    // every path is simple: no vertex repeats within it (the cycle guard held).
    for (const p of paths) {
      const ids = p.objects.map((o: any) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(4); // seed + 3 hops
    }
  });

  test('simplePath() inside repeat() prunes cycles even without path() output', () => {
    const store = seededStore();
    // both() would revisit endlessly; simplePath keeps each 3-hop walk acyclic. The
    // walk carries the path array internally for the guard, then outputs plain vertices.
    const rows = run(store, 'g.V(1).repeat(__.both().simplePath()).times(2)') as any[];
    expect(rows.length).toBeGreaterThan(0);
  });

  test('dedup() after a recursive path() collapses equal paths (multigraph parallel edges)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const person = store.labelId('person'), knows = store.labelId('knows');
    store.query('INSERT INTO nodes(id,label) VALUES(1,?),(2,?)', [person, person]);
    store.query('INSERT INTO edges(id,src,label,tgt) VALUES(10,1,?,2),(11,1,?,2)', [knows, knows]);
    const npaths = (q: string) => new Set((run(store, q) as any[]).map((r) => r.pk)).size;
    // two parallel 1→2 edges → out() reaches 2 twice → two identical [1,2] paths.
    expect(npaths('g.V(1).repeat(__.out()).times(1).path()')).toBe(2);
    expect(npaths('g.V(1).repeat(__.out()).times(1).path().dedup()')).toBe(1); // collapsed
  });

  // ---------- repeat().until() (modern-graph semantics) ----------

  // props JSON is now {key:[{t,v}]} (self-describing typed nodes) — read the leaf payload.
  const uNames = (store: GraphStore, q: string) => (run(store, q) as any[]).map((r) => JSON.parse(r.props).name[0].v);

  test('do-while: repeat(out()).until(pred) runs the body then tests, multiset-correct', () => {
    const store = seededStore();
    // until a property predicate: marko→josh→ripple is the only name=ripple exit.
    expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.has("name","ripple"))')).toEqual(['ripple']);
    // until a label: marko reaches lop directly AND via josh (two paths) + ripple via josh.
    expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.hasLabel("software"))').sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  test('until(loops().is(n)) is equivalent to times(n)', () => {
    const store = seededStore();
    const byUntil = uNames(store, 'g.V(1).repeat(__.out()).until(__.loops().is(2))').sort();
    const byTimes = uNames(store, 'g.V(1).repeat(__.out()).times(2)').sort();
    expect(byUntil).toEqual(byTimes);
    expect(byUntil).toEqual(['lop', 'ripple']);
  });

  test('while-do: until(pred).repeat(t) tests the seed first (emits it un-iterated if it holds)', () => {
    const store = seededStore();
    // lop already satisfies name=lop → emitted without running the body.
    expect(uNames(store, 'g.V(3).until(__.has("name","lop")).repeat(__.out())')).toEqual(['lop']);
    // marko doesn't satisfy hasLabel(software) → iterate until it does.
    expect(uNames(store, 'g.V(1).until(__.hasLabel("software")).repeat(__.out())').sort()).toEqual(['lop', 'lop', 'ripple']);
  });

  test('until().path() emits the route to each satisfied traverser', async () => {
    const paths = await decodePaths(seededStore(), 'g.V(1).repeat(__.out()).until(__.has("name","ripple")).path()');
    expect(paths.map((p) => p.objects.map((o: any) => o.id))).toEqual([[1, 4, 5]]); // marko→josh→ripple
  });

  test('until(__.out()) stops at the first vertex having an out-edge (EXISTS correlates correctly)', () => {
    const store = seededStore();
    // marko→{vadas,josh,lop}; only josh has an out-edge → done. vadas/lop have none →
    // not done and can't expand → dropped. (Bug would self-correlate → wrong set.)
    expect(uNames(store, 'g.V(1).repeat(__.out()).until(__.out())')).toEqual(['josh']);
  });

  test('until() has NO depth cap: reaches a target deeper than the retired 32-hop limit', () => {
    // Regression for removing the 32-hop cap: build a 40-hop linear chain and let
    // until() walk the whole way. Under the old cap this silently returned [] (the
    // target sat beyond depth 32) — a wrong answer masquerading as "no match".
    const store = new GraphStore(new BunSqlite(':memory:'));
    const person = store.labelId('person');
    const knows = store.labelId('knows');
    const node = 'INSERT INTO nodes(id, label) VALUES(?,?)';
    const prop = 'INSERT INTO vertex_properties(node, key, value) VALUES(?,?,?)';
    const edge = 'INSERT INTO edges(id, src, label, tgt) VALUES(?,?,?,?)';
    const N = 40; // deeper than the retired cap
    for (let i = 0; i <= N; i++) { store.query(node, [i + 1, person]); store.query(prop, [i + 1, 'name', `n${i}`]); }
    for (let i = 0; i < N; i++) store.query(edge, [100 + i, i + 1, knows, i + 2]); // n0→n1→…→n40
    expect(uNames(store, `g.V(1).repeat(__.out()).until(__.has("name","n${N}"))`)).toEqual([`n${N}`]);
  });
});

// ---- typed property values, P1: canonical vtype stored on write (docs/2026-07-16-typed-property-values-plan.md) ----
describe('typed property values (P1) — vtype capture + collection storage', () => {
  const fresh = () => new GraphStore(new BunSqlite(':memory:'));
  const vprops = (store: GraphStore, keys: string[]) =>
    store.query<{ key: string; value: any; vtype: string | null }>(
      `SELECT key, value, vtype FROM vertex_properties WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY key`, keys);

  test('inline literal subtypes are stored as canonical vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('i',1).property('l',5L).property('d',2.5).property('s','hi').property('b',true).property('when',datetime('2024-01-01T00:00:00Z')).property('gid',UUID('0-1'))", {});
    const got = Object.fromEntries(vprops(store, ['i', 'l', 'd', 's', 'b', 'when', 'gid']).map((r) => [r.key, r.vtype]));
    expect(got).toEqual({ b: 'boolean', d: 'double', gid: 'uuid', i: 'int', l: 'long', s: 'string', when: 'datetime' });
  });

  test('a list-valued property stores a self-describing typed-JSON tree (vtype=list)', () => {
    const store = fresh();
    // Was "Binding expected string…" before collections serialized to JSONB; now the value
    // column holds the top node's BARE `v` = per-element {t,v} nodes (full-fidelity elements).
    executeQuery(store, "g.addV('d').property('list',['a','b','c'])", {});
    const r = store.query<{ v: string; vtype: string }>("SELECT json(value) AS v, vtype FROM vertex_properties WHERE key='list'")[0];
    expect([r.vtype, JSON.parse(r.v)]).toEqual(['list', [
      { t: 'string', v: 'a' }, { t: 'string', v: 'b' }, { t: 'string', v: 'c' },
    ]]);
    // round-trips back to the plain list value.
    const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
    expect(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST))", {}).map(dec)).toEqual([['a', 'b', 'c']]);
  });

  test('a map-valued property stores ordered typed [key,value] pairs (non-string keys survive)', () => {
    const store = fresh();
    executeQuery(store, "g.addV('x').property('data',[a:1,b:2])", {});
    const r = store.query<{ v: string; vtype: string }>("SELECT json(value) AS v, vtype FROM vertex_properties WHERE key='data'")[0];
    expect([r.vtype, JSON.parse(r.v)]).toEqual(['map', [
      [{ t: 'string', v: 'a' }, { t: 'int', v: 1 }],
      [{ t: 'string', v: 'b' }, { t: 'int', v: 2 }],
    ]]);
  });

  test('edge properties store into the normalized edge_properties table with vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('weight',0.5)", {});
    expect(store.query("SELECT edge, key, value, vtype FROM edge_properties")).toEqual([{ edge: 1, key: 'weight', value: 0.5, vtype: 'double' }]);
    // the flat edges.props blob is retired — reading a value goes through edge_properties.
    expect(executeQuery(store, "g.E().hasLabel('knows').values('weight')", {})).toHaveLength(1);
  });

  test('has(k, typeOf(X)) matches the stored vtype — the storage-class wall falls', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('when',datetime('2024-01-01T00:00:00Z')).property('nick',['a','b']).property('flag',true).property('gid',UUID('0-1')).property('age',30).property('big',5L)", {});
    const n = (g: string) => executeQuery(store, g, {}).length;
    // datetime/list/boolean/uuid were all indistinguishable from int/text/long by
    // storage class alone (folded to false); the stored vtype now answers them.
    expect(n("g.V().has('when', typeOf(GType.DATETIME))")).toBe(1);
    expect(n("g.V().has('nick', typeOf(GType.LIST))")).toBe(1);
    expect(n("g.V().has('flag', typeOf(GType.BOOLEAN))")).toBe(1);
    expect(n("g.V().has('gid', typeOf(GType.UUID))")).toBe(1);
    // numeric subtypes are distinguishable now: 30 is int, 5L is long.
    expect(n("g.V().has('age', typeOf(GType.INT))")).toBe(1);
    expect(n("g.V().has('age', typeOf(GType.LONG))")).toBe(0);
    expect(n("g.V().has('big', typeOf(GType.LONG))")).toBe(1);
    expect(n("g.V().has('when', typeOf(GType.LONG))")).toBe(0);
    // a non-value GType folds to false; a bogus name still raises.
    expect(n("g.V().has('age', typeOf(GType.VERTEX))")).toBe(0);
    expect(() => compile("g.V().has('age', typeOf('bogus-name'))", {})).toThrow('unregistered type');
  });

  test('values(k).is(typeOf(X)) tests the per-row stored vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('t').property('age',30).property('big',5L).property('when',datetime('2024-01-01T00:00:00Z')).property('nm','x')", {});
    const n = (g: string) => executeQuery(store, g, {}).length;
    expect(n("g.V().values('age').is(typeOf(GType.INT))")).toBe(1);
    expect(n("g.V().values('age').is(typeOf(GType.LONG))")).toBe(0); // int, not long
    expect(n("g.V().values('big').is(typeOf(GType.LONG))")).toBe(1);
    expect(n("g.V().values('when').is(typeOf(GType.DATETIME))")).toBe(1);
    expect(n("g.V().values('nm').is(typeOf(GType.STRING))")).toBe(1);
    // the per-row vtype survives a row-preserving order() before the typeOf test
    expect(n("g.V().values('age').order().is(typeOf(GType.INT))")).toBe(1);
    // a cast makes the type compile-known → static fold (asNumber → long)
    expect(n("g.V().values('when').asNumber(GType.LONG).is(typeOf(GType.LONG))")).toBe(1);
  });

  test('has(edgeKey, typeOf(X)) matches the stored edge vtype', () => {
    const store = fresh();
    executeQuery(store, "g.addV('p').as('a').addV('p').as('b').addE('knows').from('a').to('b').property('weight',0.5)", {});
    expect(executeQuery(store, "g.E().has('weight', typeOf(GType.DOUBLE))", {})).toHaveLength(1);
    expect(executeQuery(store, "g.E().has('weight', typeOf(GType.LONG))", {})).toHaveLength(0);
  });

  test('the wire is the truth: a bound param keeps its GraphBinary DataType', () => {
    const store = fresh();
    // 5e9 is out of int32 range → the client serializes it as a GraphBinary Long. The
    // stored vtype must be 'long' (JS-value inference would wrongly guess 'int').
    const bindings = new Map<any, any>([['n', 5_000_000_000], ['s', 'hi']]);
    const fields = new Map<any, any>([['bindings', bindings]]);
    const raw = Buffer.concat([
      Buffer.from([0x84]),
      ioc.mapSerializer.serialize(fields, false),
      ioc.stringSerializer.serialize("g.addV('t').property('big',n).property('txt',s)", false),
    ]);
    const parsed = parseRequest(raw);
    expect(parsed.paramTypes).toEqual({ n: 'long', s: 'string' });
    executeQuery(store, parsed.gremlin, parsed.params, parsed.paramTypes);
    const got = Object.fromEntries(vprops(store, ['big', 'txt']).map((r) => [r.key, r.vtype]));
    expect(got).toEqual({ big: 'long', txt: 'string' });
    // Without the wire types, the write infers from the JS value. 5e9 is out of int32 range,
    // so magnitude-based inference correctly gives 'long' too (and, crucially, doesn't tag it
    // 'int' — which would overflow the strict Int framer). The genuinely-lossy inference cases
    // (a small long, a uuid, a datetime — indistinguishable from int/string by JS value) are
    // covered elsewhere; the wire type is what recovers those.
    const store2 = fresh();
    executeQuery(store2, parsed.gremlin, parsed.params, {});
    expect(store2.query<{ vtype: string }>("SELECT vtype FROM vertex_properties WHERE key='big'")[0].vtype).toBe('long');
  });
});
