// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, STATIC, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { Query } from '../../src/sql/kernel/q.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns, toGroupStream, toPathStream, toPropertyStream, toRecordStream, toScalarStream, toVariantStream } from '../../src/compiler/steps/context/stream.ts';
import { popChildScope, pushChildScope, reuseCurrentFrame } from '../../src/compiler/steps/tail/child.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { decode, decodeAll } from '../support/decode.ts';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)
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

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('scalar-parent / projection SQL', () => {
  test('order().by(key[, dir]) folds ORDER BY into the projection select', () => {
    const asc = read('g.V().hasLabel("person").order().by("age").values("name")');
    // the order key is the vtype-aware compareKey (numeric for a TEXT-stored big value)
    expect(asc.sql).toContain("ROW_NUMBER() OVER (ORDER BY (SELECT (CASE WHEN vtype IN ('byte'");
    expect(asc.sql).toContain("ELSE value END) FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) ASC) AS encounter");
    // order().by(key) before a scalar projection routes through the scalar pipeline: the
    // element order becomes the carried encounter (a ROW_NUMBER window). binds: label,
    // the order key (window), the values() join key, then the order key AGAIN for the
    // NON-PRODUCTIVE by() drop — TinkerPop's default by() drops a traverser it yields nothing
    // for, so the projection filters on `<key> IS NOT NULL` (orderProductivityFilter).
    expect(asc.binds).toEqual(['person', 'age', 'name', 'age']);

    const desc = read('g.V().hasLabel("person").order().by("age",desc).values("name")');
    expect(desc.sql).toContain("ELSE value END) FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) DESC");
  });

  test('values().order() sorts the projected scalar', () => {
    const p = read('g.V().values("age").order()');
    // scalar order sorts by the vtype-aware compareKey (numeric for a TEXT-stored big
    // long/bigdecimal/duration, lexical for strings via the ELSE branch).
    expect(p.sql).toContain('ORDER BY (CASE WHEN p.vtype');
    expect(p.sql).toContain('ELSE p.v END) ASC');
    // values() carries the per-row stored type → framed by it (perRowType).
    expect(p.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('range/skip become LIMIT/OFFSET tail modifiers under order()', () => {
    expect(read('g.V().order().by("age").range(1,3).values("name")').sql).toContain('LIMIT 2 OFFSET 1');
    expect(read('g.V().order().by("age").skip(1)').sql).toContain('LIMIT -1 OFFSET 1');
  });

  test('range/skip/limit compose as CTEs when no order() is present', () => {
    expect(read('g.V().range(1,3)').sql).toContain('SELECT p.id, p.bulk FROM c0 p LIMIT 2 OFFSET 1');
    expect(read('g.V().skip(2)').sql).toContain('SELECT p.id, p.bulk FROM c0 p LIMIT -1 OFFSET 2');
  });

  test('illegal range is rejected', () => {
    expect(() => compile('g.V().range(2,1)', {})).toThrow('Not a legal range: [2, 1]');
  });

  test('P3b: uuid/list framing + is(typeOf(LIST)) retypes scalar→ListStream', async () => {
    // A stored TEXT value frames by its true vtype: uuid via UuidSerializer (storage-
    // ambiguous with string), so values('uuid') carries perRowType framing.
    expect(read('g.V().values("uuid")').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // is(typeOf(LIST)) is a RETYPE, not a value filter: the scalar value stream becomes a
    // ListStream whose `list` column is json() of the stored JSONB list value.
    const listed = read('g.V().values("list").is(typeOf(GType.LIST))');
    // typed: items are self-describing {t,v} nodes → framed via frameTypedNode (full-fidelity).
    expect(listed.shape).toEqual({ kind: 'jsonbList', typed: true });
    expect(listed.sql).toContain("json(p.v) AS list");
    expect(listed.sql).toContain("p.vtype = ?");
    expect(listed.binds).toContain('list');
    // once a ListStream, the list substrate composes: unfold/count(local)/range reuse it.
    // typed unfold carries each element's own stored vtype (perRowType framing).
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).count(Scope.local)').shape).toEqual({ kind: 'count' });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold().range(1,3)').sql).toContain('json_each');

    // End-to-end framing: a list value frames as ONE List, unfold explodes it, uuid
    // round-trips through UuidSerializer.
    const store = new GraphStore(new BunSqlite(':memory:'));
    executeQuery(store, "g.addV('data').property('list',['a','b','c']).property('uuid', UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'))", {});
    const dec = (b: Buffer) => decode(b);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST))", {}))).toEqual([['a', 'b', 'c']]);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).unfold()", {}))).toEqual(['a', 'b', 'c']);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).count(Scope.local)", {}))).toEqual([3]);
    expect(await decodeAll(executeQuery(store, "g.V().values('uuid')", {}))).toEqual(['0263f28b-eff9-4c17-8e33-0b41c74b6d4c']);
  });

  test('global count() + is(typeOf(LIST)) identity on a fold() list value', async () => {
    // A fold() collapses the stream into ONE list traverser. A GLOBAL count() counts the list
    // TRAVERSERS (1), distinct from count(Scope.local) which is the list LENGTH — so it routes
    // through the shared relational barrier, not the per-list reducer.
    expect(read("g.V().values('name').fold().count()").shape).toEqual({ kind: 'count' });
    // is(typeOf(LIST)) on a list value is an identity type-assert (a list IS a list) — the
    // terminal stream stays a list, then count() reports 1.
    expect(read("g.V().values('name').fold().is(typeOf(GType.LIST)).count()").shape).toEqual({ kind: 'count' });
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const w of MODERN_SEED) executeQuery(store, w, {});
    const dec = (b: Buffer) => decode(b);
    // one list of 6 names → count 1 (a Long that decodes to a Number after the Int64 fix).
    expect(await decodeAll(executeQuery(store, "g.V().values('name').fold().count()", {}))).toEqual([1]);
    expect(await decodeAll(executeQuery(store, "g.V().values('name').fold().is(typeOf(GType.LIST)).count()", {}))).toEqual([1]);
    // the identity assert leaves the list intact (6 names) when terminal.
    expect(((await decode((executeQuery(store, "g.V().values('name').fold().is(typeOf(GType.LIST))", {}))[0])) as any[]).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('min/max range over comparables (incl. text); mean/sum numeric only', () => {
    const mn = read('g.V().values("age").min()');
    // TinkerPop 4 Strings are Comparable, so min/max include text (numbers order first).
    expect(mn.sql).toContain("typeof(s.v) in ('integer', 'real', 'text')");
    expect(mn.sql).toContain('MIN(s.v)');
    expect(mn.shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").max()').sql).toContain('MAX(s.v)');
    // mean stays numeric-only (never text).
    expect(read('g.V().values("age").mean()').sql).toContain("typeof(s.v) in ('integer', 'real')");
    // mean is always a Double (forced vt='real')
    const avg = read('g.V().values("age").mean()');
    expect(avg.sql).toContain('SUM(s.v * s.bulk) * 1.0 / SUM(s.bulk)');
    expect(avg.sql).toContain("'real' AS vt");
    // min(Scope.local) after fold() reduces the folded list per-list (list phase).
    expect(read('g.V().values("age").fold().min(Scope.local)').shape).toEqual({ kind: 'scalar' });
  });

  test('collection literals parse as one array value; varargs-style steps flatten it', () => {
    // A bracketed list is ONE array arg (walkArgs), not N flattened args. The
    // varargs-style consumers (V/E/hasId + — until the list substrate lands — inject)
    // flatten it back, so these compile identically to the comma-varargs form.
    expect(read('g.V([1,2,3])').sql).toBe(read('g.V(1,2,3)').sql);
    expect(read('g.V().hasId([1,2])').sql).toBe(read('g.V().hasId(1,2)').sql);
    // hasId(1,[2,6]) ≡ hasId(1,2,6): HasIdStep flattens every Collection arg.
    expect(read('g.V().hasId(1,[2,6])').binds).toEqual([1, 2, 6]);
    expect(read('g.inject([1,2,3])').binds).toEqual([1, 2, 3]);
    // A lone P predicate arg is not an array → still passes through, not flattened.
    expect(read('g.V().hasId(P.within([1,2]))').sql).toContain('COALESCE(n.uid, n.id) in (?, ?)');
    // Scope.local is now captured on the step (was silently dropped) — a bare
    // reducer ignores the scope arg, so global sum() is unchanged (Scope.local lands later).
    expect(read('g.inject(1,2,3).sum()').binds).toEqual([1, 2, 3]);
  });

  test('fold() as a value + unfold() re-enters the tail', () => {
    // Element folds retain the row-framing path; scalar folds become a genuine
    // ListStream even when terminal, so item metadata can survive the barrier.
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList', typed: true });
    // A NON-terminal fold() retypes to a JSONB list value (jsonb(json_group_array)),
    // and unfold() explodes it (json_each) — the stream continues. fold().unfold() is
    // an identity roundtrip (deliberately not peepholed).
    const fu = read('g.V().fold().unfold()');
    expect(fu.shape).toEqual({ kind: 'vertex' });
    expect(fu.sql).toContain('json_group_array');
    expect(fu.sql).toContain('json_each');
    // scalar list: values().fold().unfold() → a scalar `v` stream again.
    expect(read('g.V().values("name").fold().unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // unfold() directly on an element stream is identity (a vertex is not a collection).
    expect(read('g.V().unfold()').shape).toEqual({ kind: 'vertex' });
    // continuation after the roundtrip: movement/projection resume as a fresh phase.
    expect(read('g.V().hasLabel("person").fold().unfold().values("name")').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // Scope.local reducers reduce EACH folded list to one scalar (per-list, not global).
    expect(read('g.V().fold().count(Scope.local)').shape).toEqual({ kind: 'count' });
    expect(read('g.V().values("age").fold().sum(Scope.local)').shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").fold().sum(Scope.local)').sql).toContain('json_each');
    // Local reducers are ScalarStream transitions, so a later predicate composes.
    expect(read('g.V().values("age").fold().sum(Scope.local).is(P.gt(1))').shape).toEqual({ kind: 'scalar' });
  });

  test('fold preserves uniform scalar item types through ListStream materialization', async () => {
    const typed = read('g.V().values("age").asNumber(GType.DOUBLE).fold()');
    expect(typed.shape).toEqual({ kind: 'jsonbList', as: 'double' });

    const { ioc } = await import('../../src/io.ts');
    const doubles = executeQuery(seededStore(), 'g.V().values("age").asNumber(GType.DOUBLE).fold()', {})[0];
    // LIST header (type+flag) + bare length (4 bytes), then the first qualified item.
    expect(doubles[6]).toBe(ioc.DataType.DOUBLE);
    expect(((await decode(doubles)) as number[]).sort((a: number, b: number) => a - b)).toEqual([27, 29, 32, 35]);

    const ints = executeQuery(new GraphStore(new BunSqlite(':memory:')), 'g.inject("1",2,"3",4).asNumber().fold()', {})[0];
    expect(ints[6]).toBe(ioc.DataType.INT);
    expect(await decode(ints)).toEqual([1, 2, 3, 4]);
  });

  test('inject([...]) is a real list value (not flattened)', () => {
    // Each bracket arg is ONE list traverser → a JSONB list-value stream.
    expect(read('g.inject([1,3,100,300])').shape).toEqual({ kind: 'jsonbList' });
    expect(read('g.inject([1,2],[3,4])').shape).toEqual({ kind: 'jsonbList' });
    // unfold() explodes the list back to a scalar stream.
    expect(read('g.inject([1,2,3]).unfold()').shape).toEqual({ kind: 'value', type: UNKNOWN });
    // Scope.local reducers act per-list (mean over the numeric elements → Double).
    expect(read('g.inject([null,10,20,null]).mean(Scope.local)').shape).toEqual({ kind: 'scalar' });
    // none(P) on a LIST keeps the list iff no element matches (collection filter).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').sql).toContain('NOT EXISTS');
    // none(pred) is NOT the iterate discard-marker (only a bare none() is stripped).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').shape).toEqual({ kind: 'jsonbList' });
  });

  test('set-op / list-algebra family (combine/intersect/difference/disjunct/product/conjoin/all/any)', () => {
    // combine = concat → a List; intersect/difference/disjunct → a Set (jsonbSet) when terminal.
    expect(read('g.V().values("age").fold().combine([1,2])').shape).toEqual({ kind: 'jsonbList' });
    expect(read('g.V().values("age").fold().intersect([27,29])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("age").fold().difference([27])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("age").fold().disjunct([27])').shape).toEqual({ kind: 'jsonbSet' });
    // merge = set union of both operands → a Set (jsonbSet) when terminal.
    expect(read('g.V().values("age").fold().merge([1,2])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.inject(["a",null,"b"]).merge(["a","c"])').sql).toContain('UNION');
    // null-safe set membership (IS, not =) so null intersects/differs correctly.
    expect(read('g.inject(["a",null,"b"]).difference(["a","c"])').sql).toContain('o.value IS je.value');
    // a Set followed by a list op (order(Scope.local)) degrades to a List (not a Set).
    expect(read('g.V().values("age").fold().intersect([27]).order(Scope.local)').shape).toEqual({ kind: 'jsonbList' });
    // constant(c).fold() and a standalone scalar-list traversal are valid operands.
    expect(read('g.V().values("age").fold().intersect(__.constant(27).fold())').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("name").fold().difference(__.V().values("name").fold())').shape).toEqual({ kind: 'jsonbSet' });
    // the standalone operand embeds as a scalar subquery (its own WITH + json_group_array).
    expect(read('g.V().values("name").fold().difference(__.V().values("name").fold())').sql).toContain('SELECT jsonb(list)');
    // an element-fold operand (a vertex list) isn't a scalar list → defers.
    expect(() => compile('g.V().fold().combine(__.V().fold())', {})).toThrow('must fold a scalar list');
    // argument-type errors mirror TinkerPop's messages.
    expect(() => compile('g.V().fold().combine(2)', {})).toThrow('can only take an array or an Iterable as an argument');
    expect(() => compile('g.V().fold().combine(null)', {})).toThrow("can't be null");
    // product → a list of pair-lists; conjoin → a scalar string.
    expect(read('g.V().values("age").fold().product([1]).unfold()').shape).toEqual({ kind: 'jsonbList' });
    // conjoin joins the members into ONE string, whatever they were — a static 'string'
    // type, not per-value inference at the wire.
    expect(read('g.V().values("name").order().fold().conjoin("_")').shape).toEqual({ kind: 'value', type: STATIC('string') });
    // all(P)/any(P) filter the list (IS TRUE / IS NOT TRUE null handling).
    expect(read('g.V().values("age").order().fold().all(P.gt(10))').sql).toContain('IS NOT TRUE');
    expect(read('g.V().values("age").order().fold().any(P.gt(10))').sql).toContain('IS TRUE');
    // a list-collection step on a scalar stream raises the incoming-type error.
    expect(() => compile('g.V().values("name").fold().unfold().combine([1])', {})).toThrow('incoming traversers');
  });

  test('Scope.local collection transforms reshape a list (order/dedup/limit/tail)', () => {
    // A non-terminal fold() → ListStream; a Scope.local transform rebuilds each list
    // (correlated json_each) and stays a list, so unfold() re-enters afterwards.
    const o = read('g.V().values("age").fold().order(Scope.local)');
    expect(o.shape).toEqual({ kind: 'jsonbList', typed: true });
    expect(o.sql).toContain('json_group_array');
    // order().by(Order.desc) — direction-only by() flips the sort.
    expect(read('g.V().values("age").fold().order(Scope.local).by(Order.desc).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // tail avoids a count() subquery (DESC LIMIT then re-sort asc) so it correlates once.
    const t = read('g.V().values("age").fold().tail(Scope.local,2).unfold()');
    expect(t.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(t.sql).toContain('DESC');
    expect(read('g.V().values("age").fold().dedup(Scope.local).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // Transforms compose: order then skip, both per-list, then unfold.
    expect(read('g.V().values("age").fold().order(Scope.local).skip(Scope.local,2).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // A by(key)/traversal comparator defers clearly.
    expect(() => compile('g.V().values("age").fold().order(Scope.local).by("age")', {})).toThrow('order(Scope.local).by(key/traversal) not yet supported');
  });

  test('Scope.local reducer on a SCALAR stream is per-element (degenerate 1-list)', () => {
    // A scalar's local sum/min/max is the value itself (identity); shape stays a value,
    // and the stored per-row type rides through the identity reducer (perRowType).
    expect(read('g.V(1).values("age").sum(Scope.local)').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(read('g.V(1).values("age").max(Scope.local)').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // mean is ALWAYS Double, even of one value (d[29.0].d) → CAST to REAL, tagged double.
    const mn = read('g.V(1).values("age").mean(Scope.local)');
    expect(mn.shape).toEqual({ kind: 'value', type: STATIC('double') });
    expect(mn.sql).toContain('CAST(');
    // a scalar TRANSFORM's Scope.local stays a no-op (per-element == per-list).
    expect(read('g.V().values("name").toLower(Scope.local)').sql).toContain('lower(');
    // count(local)/limit(local) on a scalar stream aren't worked out yet → fail closed.
    expect(() => compile('g.V().values("age").count(Scope.local)', {})).toThrow('requires a preceding list-producing step');
  });

  test('inject() is a value stream that reducers/modifiers chain onto', () => {
    expect(read('g.inject(1,2,3)').shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(read('g.inject(1,2,3)').binds).toEqual([1, 2, 3]);
    // every inject() value across the chain folds into one VALUES seed (so the tail's
    // dedup/order/reducer see the whole stream)
    expect(read('g.inject(1,3).inject(100,300)').binds).toEqual([1, 3, 100, 300]);
    // reducers reuse the shared wrapper
    expect(read('g.inject(1,2,3).sum()').shape).toEqual({ kind: 'scalar' });
    expect(read('g.inject(1,2,3).sum()').sql).toContain('SUM(s.v)');
    expect(read('g.inject(1,2,3).mean()').sql).toContain('AVG(s.v)');
    expect(read('g.inject(1,2,3).count()').shape).toEqual({ kind: 'count' });
    expect(read('g.inject(1,2,3).fold()').shape).toEqual({ kind: 'jsonbList' });
    // is() BEFORE count() filters the pre-count stream (WHERE inside the counted set)
    expect(read('g.inject(1,2,3).is(P.gt(1)).count()').sql).toContain('WHERE p.v > ?');
    // count is a relational boundary, so later scalar filters compose in position.
    expect(read('g.inject(1,2,3).count().is(P.gt(2))').sql).toContain('WHERE p.v > ?');
    // value modifiers
    expect(read('g.inject(3,1,2).order()').sql).toContain('ORDER BY p.v ASC');
    expect(read('g.inject(1,1,2).dedup()').sql).toContain('DISTINCT p.v');
    const store = new GraphStore(new BunSqlite(':memory:'));
    // as()/select() now work on a scalar (value) stream — the label carries the value.
    expect(run(store, 'g.inject(1).as("a").select("a")').map((r) => r.v)).toEqual([1]);
    expect(run(store, 'g.inject(1,2,3).limit(2).is(P.gt(1))').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.inject(1,2,3).count().is(P.gt(2))').map((r) => r.v)).toEqual([3]);
    expect(run(store, 'g.inject(1,3).inject(100,300).sum()').map((r) => r.v)).toEqual([404]);
  });

  test('chained projection: a scalar projection then count() retypes to a scalar stream (re-entry)', () => {
    // values().count() no longer hits the "one projection per traversal" ceiling — it
    // retypes to a ScalarStream and counts the value ROWS (multi-valued keys counted
    // per-value, matching TinkerPop's values()-flatMap semantics).
    const c = read('g.V().values("age").count()');
    expect(c.shape).toEqual({ kind: 'count' });
    expect(c.sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c1 s');
    // the values() flatMap (now carrying per-row vtype; a collection value → json() text)
    // feeds the count.
    expect(c.sql).toContain("THEN json(vp.value) ELSE vp.value END AS v, vp.vtype AS vtype, p.bulk FROM");
    // intervening scalar-stream modifiers compose through the re-entry
    const dedupCount = read('g.V().values("age").dedup().count()').sql;
    expect(dedupCount).toContain('SELECT DISTINCT p.v AS v');
    expect(dedupCount).toContain('SELECT COUNT(*) AS v FROM c2');
    expect(read('g.V().out().id().count()').shape).toEqual({ kind: 'count' });
    // The reducer is another scalar stream, so lowering can continue past it.
    expect(read('g.V().values("age").count().is(P.gt(2))').sql).toContain('WHERE p.v > ?');

    // Element-side policies before the scalar boundary are rendered first, then the
    // projected rows re-enter the same scalar dispatcher. This was the last route
    // through the old one-projection accumulator ceiling.
    const ordered = read('g.V().order().by("age").limit(2).values("name").count()');
    expect(ordered.shape).toEqual({ kind: 'count' });
    expect(ordered.sql).toContain('ORDER BY (SELECT (CASE WHEN vtype IN');
    expect(ordered.sql).toContain('LIMIT 2 OFFSET 0), c2(v) as (SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c1 s)');
    expect(run(seededStore(), 'g.V().order().by("age").limit(2).values("name").count()').map((r) => r.v))
      .toEqual([2]);
    expect(() => compile('g.V().values("name").id()', {})).toThrow('id() requires element input');
  });

  test('count is a relational scalar boundary and can continue lowering', () => {
    const filtered = read('g.V().values("age").count().is(P.gt(3))');
    expect(filtered.shape).toEqual({ kind: 'count' });
    expect(filtered.sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v');
    expect(filtered.sql).toContain('WHERE p.v > ?');

    const countedAgain = read('g.V().values("age").count().count()');
    expect(countedAgain.shape).toEqual({ kind: 'count' });
    const store = seededStore();
    expect(run(store, 'g.V().values("age").count().is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().values("age").count().count()').map((r) => r.v)).toEqual([1]);
  });

  test('asBool() resolves inject constants at compile time + tags the value shape', () => {
    // The value shape carries `as:'bool'` so the handler frames the 0/1 as Boolean.
    expect(read('g.inject(1).asBool()').shape).toEqual({ kind: 'value', type: STATIC('bool') });
    // TinkerPop truthiness: NaN/0/-0 → false, nonzero → true, "true"/"false"
    // (case-insensitive), bool → itself. Constants resolve to the bound values.
    expect(read('g.inject(1).asBool()').binds).toEqual([true]);
    expect(read('g.inject(0).asBool()').binds).toEqual([false]);
    expect(read('g.inject(-0.0).asBool()').binds).toEqual([false]);
    expect(read('g.inject(NaN).asBool()').binds).toEqual([false]);
    expect(read('g.inject(3.14).asBool()').binds).toEqual([true]);
    expect(read("g.inject('tRUe').asBool()").binds).toEqual([true]);
    expect(read('g.inject(false).asBool()').binds).toEqual([false]);
    // strings are trimmed before the match (AsBoolStep.trim())
    expect(read("g.inject(' true ').asBool()").binds).toEqual([true]);
    // per-value parse errors (can't come from SQL) raise the exact TinkerPop message
    expect(() => compile("g.inject('hello').asBool()", {})).toThrow("Can't parse hello as Boolean.");
    expect(() => compile('g.inject(null).asBool()', {})).toThrow("Can't parse null as Boolean.");
    // on a runtime (V-rooted) stream asBool defers — needs local()/sack()
    expect(() => compile('g.V().values("name").asBool()', {})).toThrow('scalar transform asBool() not supported');
    // fold preserves the uniform item tag; a heterogeneous trailing inject still defers.
    expect(read('g.inject(1,0).asBool().fold()').shape).toEqual({ kind: 'jsonbList', as: 'bool' });
    expect(() => compile('g.inject(1).asBool().inject(5)', {})).toThrow('after typed/reduced/carried scalar state');
  });

  test('asNumber(GType.X) tags the value shape with the target subtype', () => {
    // Target comes from the explicit GType arg (the frontend flattens numeric-literal
    // suffixes, so bare asNumber() can't recover the input subtype — it defers).
    expect(read('g.inject(5).asNumber(GType.LONG)').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.inject(12).asNumber(GType.BYTE)').shape).toEqual({ kind: 'value', type: STATIC('byte') });
    // integer targets truncate toward zero; the converted constant is bound
    expect(read('g.inject(5.43).asNumber(GType.INT)').binds).toEqual([5]);
    expect(read("g.inject('5').asNumber(GType.BYTE)").binds).toEqual([5]);
    // runtime value → SQL CAST + tag (no compile-time constant)
    const f = read('g.V().values("weight").asNumber(GType.FLOAT)');
    expect(f.shape).toEqual({ kind: 'value', type: STATIC('float') });
    expect(f.sql).toContain('CAST(p.v AS REAL)');
    // is(P.typeOf(X)) after a cast is compile-time known (the cast's `as` tag) → the
    // typeOf STATIC-FOLDS to a constant instead of a runtime typeof() test.
    const castTypeOf = read('g.V().values("weight").asNumber(GType.FLOAT).is(P.typeOf(GType.FLOAT))');
    expect(castTypeOf.sql).toContain('CAST(p.v AS REAL) AS v, p.bulk FROM c1 p WHERE 1');
    expect(castTypeOf.sql).not.toContain('typeof(');
    // overflow + non-numeric-token errors raise TinkerPop's exact messages
    expect(() => compile('g.inject(32768).asNumber(GType.SHORT)', {})).toThrow('Can\'t convert number of type Integer to Short due to overflow.');
    expect(() => compile('g.inject(300).asNumber(GType.BYTE)', {})).toThrow('Can\'t convert number of type Integer to Byte due to overflow.');
    expect(() => compile('g.inject(5).asNumber(GType.VERTEX)', {})).toThrow('asNumber() requires a numeric type token, got VERTEX');
    // a reducer is now a later ScalarStream transition; its runtime result type is
    // carried by vt rather than reconstructed from the cast's source position.
    expect(read('g.inject(2.0).asNumber(GType.FLOAT).sum()').shape).toEqual({ kind: 'scalar' });
    // overflow message uses the boxed Java type name (Integer, not Int)
    expect(() => compile('g.inject(3000000000).asNumber(GType.INT)', {})).toThrow('to Integer due to overflow.');
    // blank string is a parse error, not a silent 0
    expect(() => compile('g.inject("").asNumber(GType.INT)', {})).toThrow("Can't parse string '' as number.");
    // consecutive casts remain compile-time checked; the second reports its own overflow.
    expect(() => compile('g.inject(300).asNumber(GType.INT).asNumber(GType.BYTE)', {})).toThrow('to Byte due to overflow');
  });

  test('bare asNumber() recovers the input literal subtype (via Step.argTypes)', () => {
    // The frontend flattens numeric-literal values (5b/5l/5.0 → 5) but records the
    // declared subtype in argTypes; bare asNumber() reads it back to tag the shape.
    expect(read('g.inject(5b).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('byte') });
    expect(read('g.inject(5s).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('short') });
    expect(read('g.inject(5i).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('int') });
    expect(read('g.inject(5l).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.inject(5n).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('bigint') });
    expect(read('g.inject(5.0).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('double') });
    expect(read('g.inject(5.75f).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('float') });
    // un-suffixed integer → int, un-suffixed decimal → double; numeric string → int
    expect(read('g.inject(5).asNumber()').shape).toEqual({ kind: 'value', type: STATIC('int') });
    expect(read("g.inject('5').asNumber()").shape).toEqual({ kind: 'value', type: STATIC('int') });
    // a numeric string is int vs double by its textual form, not its value ("5.0"→double)
    expect(read("g.inject('5.0').asNumber()").shape).toEqual({ kind: 'value', type: STATIC('double') });
    expect(read("g.inject('5e2').asNumber()").shape).toEqual({ kind: 'value', type: STATIC('double') });
    // non-numeric string raises the parse error
    expect(() => compile("g.inject('test').asNumber()", {})).toThrow("Can't parse string 'test' as number.");
    // a stream mixing subtypes can't share one tag → defer
    expect(() => compile('g.inject(5b,5l).asNumber()', {})).toThrow('mixed numeric subtypes');
  });

  test('math("<formula>") compiles to one Double scalar; leaves coerced to REAL', () => {
    // `_` resolves through the by() modulator; result always tagged Double.
    const p = read('g.V().math("_+_").by("age")');
    expect(p.shape).toEqual({ kind: 'value', type: STATIC('double') });
    expect(p.sql).toContain("(CAST((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS REAL) + CAST((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS REAL)) AS v");
    // a missing by() value makes the arithmetic NULL → the traverser is filtered
    expect(p.sql).toContain('is not null');
    // `0-_` (subtraction-based negation) on an edge property
    expect(read('g.V().outE().math("0-_").by("weight")').sql).toContain("(0.0 - CAST((SELECT value FROM edge_properties WHERE edge=n.id AND key=?) AS REAL))");
    // integer literals emit REAL form so `/` is real division, not SQLite integer div
    expect(read('g.V().math("_ / 2").by("age")').sql).toContain('/ 2.0)');
    // `^` → POW, `%` → MOD (SQLite `%` truncates operands to int)
    expect(read('g.V().math("_ ^ 2").by("age")').sql).toContain('POW(');
    expect(read('g.V().math("_ % 10").by("age")').sql).toContain('MOD(');
    // functions: parenthesised call and juxtaposition; exp4j `log` → natural log (LN)
    expect(read('g.V().math("ceil(_ * 100)").by("age")').sql).toContain('CEIL((');
    expect(read('g.V().math("sin _").by("age")').sql).toContain('SIN(');
    expect(read('g.V().math("log _").by("age")').sql).toContain('LN(');
    // cbrt splits on sign (POW domain-errors on a negative base + fractional exponent)
    expect(read('g.V().math("cbrt(_)").by("age")').sql).toContain('CASE WHEN');
    // math is a relational producer; a later barrier is dispatched independently.
    expect(read('g.V().math("_").by("age").is(P.gt(30)).count()').shape).toEqual({ kind: 'count' });
  });

  test('format("…%{token}…") templates a string from properties + by() modulators', () => {
    // a constant template → one string literal, no filter.
    expect(read('g.V().format("Hello world")').shape).toEqual({ kind: 'value', type: UNKNOWN });
    // named tokens read the element's property; the `||` chain NULLs (drops) on a miss.
    const f = read('g.V().format("%{name} is %{age}")');
    expect(f.sql).toContain(' || ');
    expect(f.sql).toContain('is not null'); // missing-property filter
    // %{_} placeholders pull by() modulators positionally (round-robin), like math().
    expect(read('g.V().format("%{_} is %{_}").by(values("name")).by(values("age"))').sql).toContain(' || ');
    // a by()-traversal placeholder (bothE().count()) resolves as a correlated scalar.
    expect(read('g.V().format("%{name} has %{_}").by(__.bothE().count())').sql).toContain('COUNT');
    expect(read('g.V().format("%{name}").count()').shape).toEqual({ kind: 'count' });
  });

  test('math() variables: `_` = current, an identifier = an as()-bound alias', () => {
    // named aliases resolve via the carried rowid column (correlated subquery); one
    // by() feeds every variable (round-robin), N by()s feed N variables positionally.
    const shared = read('g.V().as("a").out("knows").as("b").math("a + b").by("age")');
    expect(shared.sql).toContain("(SELECT value FROM vertex_properties WHERE node=CAST(p.a0 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1)");
    expect(shared.sql).toContain("(SELECT value FROM vertex_properties WHERE node=CAST(p.a1 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1)");
    // per-variable by(): first-seen order (`b` before `a`), nested traversal + key
    const perVar = read('g.V().as("a").out("created").as("b").math("b + a").by(__.in("created").count()).by("age")');
    expect(perVar.sql).toContain('COUNT(c.id) AS v');         // b ← generic child count, total per origin
    expect(perVar.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(perVar.sql).toContain("node=CAST(p.a0 ->> ? AS INTEGER) AND key=?");      // a ← by("age")
    // math() composes with a trailing typed cast (result narrows to the cast's subtype)
    expect(read('g.V().as("a").out("knows").as("b").math("a + b").by("age").asNumber(GType.INT)').shape)
      .toEqual({ kind: 'value', type: STATIC('int') });
    // defers: a variable with no by(), and an unbound identifier
    expect(() => compile('g.V().math("_+_")', {})).toThrow('needs a by() modulator');
    expect(() => compile('g.V().math("a + b").by("age")', {})).toThrow('no such variable "a"');
  });

  test('asDate() casts to a date-tagged epoch-millis value (const-fold + runtime)', () => {
    // inject const-fold: ISO string / int / long epoch → millis, tagged date
    expect(read('g.inject("2023-08-02T00:00:00Z").asDate()').shape).toEqual({ kind: 'value', type: STATIC('date') });
    expect(read('g.inject("2023-08-02T00:00:00Z").asDate()').binds).toEqual([Date.parse('2023-08-02T00:00:00Z')]);
    // an offset-bearing ISO string folds into the correct instant
    expect(read('g.inject("2023-08-02T00:00:00-07:00").asDate()').binds).toEqual([Date.parse('2023-08-02T07:00:00Z')]);
    expect(read('g.inject(1694017707000).asDate()').binds).toEqual([1694017707000]);
    // rejects: float epoch, non-ISO string, null (list defers to frontend flattening)
    expect(() => compile('g.inject(1694017709000.1d).asDate()', {})).toThrow("Can't parse");
    expect(() => compile("g.inject('This String is not an ISO 8601 Date').asDate()", {})).toThrow("Can't parse");
    expect(() => compile('g.inject(null).asDate()', {})).toThrow("Can't parse");
    // runtime: an ISO-text property → unixepoch()*1000; an integer/real is already millis
    const rt = read('g.V().values("birthday").asDate()');
    expect(rt.shape).toEqual({ kind: 'value', type: STATIC('date') });
    expect(rt.sql).toContain("unixepoch(p.v) * 1000");
    // bare asNumber() over a date → its epoch-millis (Long, identity); asDate composes back
    expect(read('g.V().values("birthday").asDate().asNumber().asDate()').shape).toEqual({ kind: 'value', type: STATIC('date') });
    // bare asNumber() as the ms-string leg feeding asDate() is allowed; standalone it
    // can't recover a subtype from a runtime value → fail closed (not a silent CAST)
    expect(read('g.V().values("birthday").asNumber().asDate()').shape).toEqual({ kind: 'value', type: STATIC('date') });
    expect(() => compile('g.V().values("weight").asNumber()', {})).toThrow('non-date runtime value');
    // an offset-less datetime literal is UTC-normalized (not host-local) so Bun ≡ DO
    expect(read("g.inject(datetime('2023-08-02T00:00:00')).dateAdd(second, 0)").binds).toEqual([Date.parse('2023-08-02T00:00:00Z')]);
  });

  test('dateAdd(DT.unit, n) / dateDiff(date) — integer millis arithmetic', () => {
    // dateAdd folds n * fixed-width-unit millis; bare or DT.-prefixed unit; negative n
    const base = Date.parse('2023-08-02T00:00:00Z');
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(DT.hour, 2)").binds).toEqual([base + 2 * 3600000]);
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(hour, -1)").binds).toEqual([base - 3600000]);
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(day, 11)").shape).toEqual({ kind: 'value', type: STATIC('date') });
    // only second/minute/hour/day are valid DT units — the grammar rejects the rest
    expect(() => compile("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(month, 1)", {})).toThrow('parse error');
    // dateDiff = self − other → signed Long; literal / constant(datetime) / constant(null)→0
    const d = read("g.inject(datetime('2023-08-02T00:00:00Z')).dateDiff(datetime('2023-08-09T00:00:00Z'))");
    expect(d.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(d.binds).toEqual([-604800000]);
    expect(read("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(constant(datetime('2023-08-01T00:00:00Z')))").binds).toEqual([604800000]);
    // runtime dateDiff against a literal → v − other_ms (the epoch bound as a value)
    const rd = read('g.V().values("birthday").asNumber().asDate().dateDiff(datetime("1970-01-01T00:00Z"))');
    expect(rd.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(rd.binds).toEqual(['birthday', Date.parse('1970-01-01T00:00Z')]); // the values() join key, then the later dateDiff operand
    // nested inject() as the dateDiff operand defers (not a literal/constant)
    expect(() => compile("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(inject(datetime('2023-10-11T00:00:00Z')))", {})).toThrow('datetime literal or constant');
  });

  test('inject().<scalar transform>() maps to SQLite scalar functions', () => {
    // concat skips nulls (concat_ws) so an all-null result is null, not '' (Gremlin semantics)
    expect(read('g.inject("a","b").concat("c")').sql).toContain("concat_ws('', p.v, ?)");
    expect(read('g.inject("a").length()').sql).toContain('length(p.v)');
    expect(read('g.inject("A").toLower()').sql).toContain('lower(p.v)');
    expect(read('g.inject("a").toUpper()').sql).toContain('upper(p.v)');
    expect(read('g.inject(1).asString()').sql).toContain('CAST(p.v AS TEXT)');
    expect(read('g.inject("hello").substring(1,8)').sql).toContain('substr(p.v');
    expect(read('g.inject("that").replace("h","j")').sql).toContain('replace(p.v');
    // Scope.local on a scalar stream is a no-op (per-element == per-list); it now fuses
    // through the scalar row pipeline like any transform (aliased p.v).
    expect(read('g.inject("a").length(Scope.local)').sql).toContain('length(p.v)');
    // Adjacent transforms fuse into one expression while preserving left-to-right order.
    expect(read('g.inject("a").concat("b").toUpper()').sql).toContain("upper(concat_ws('', p.v, ?))");
    // trim family → SQLite trim/ltrim/rtrim over the Java-whitespace char set
    expect(read('g.inject(" a ").trim()').sql).toContain('trim(p.v, ?)');
    expect(read('g.inject(" a ").lTrim()').sql).toContain('ltrim(p.v, ?)');
    expect(read('g.inject(" a ").rTrim()').sql).toContain('rtrim(p.v, ?)');
    // reverse: string reverses chars (recursive CTE), non-string is identity
    expect(read('g.inject("ab").reverse()').sql).toContain('WITH RECURSIVE rev(');
  });

  test('scalar transforms also wrap an element value projection', () => {
    expect(read("g.V().values('name').substring(2)").sql).toContain("substr(p.v");
    expect(read("g.V().values('name').toUpper()").sql).toContain("upper(p.v)");
    expect(read("g.V().values('name').concat('X')").sql).toContain("concat_ws('', p.v, ?)");
    // chained; is()/order() see the transformed value
    expect(read("g.V().values('name').toUpper().is('MARKO')").sql).toContain('upper(');
    // transform on a non-scalar projection is rejected (no scalar stream to transform)
    expect(() => compile("g.V().valueMap().toUpper()", {})).toThrow('toUpper() cannot consume the valueMap result shape');
  });

  test('values(k).inject(c) appends constants to the value stream', () => {
    const p = read("g.V().values('age').inject(1000).sum()");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain('SUM(s.v * s.bulk)');
    expect(p.binds).toContain(1000);
    // append before a min() reducer
    expect(read("g.V().values('foo').inject(42).min()").sql).toContain('UNION ALL');
    // rejected on a non-scalar projection (inject-append is a scalar-stream op)
    expect(() => compile("g.V().valueMap().inject(1)", {})).toThrow('inject() cannot consume the valueMap result shape');
  });

  test('limit before count wraps the counted id-relation', () => {
    const sql = read('g.V().limit(2).count()').sql;
    expect(sql).toContain('c1(id, bulk) as (SELECT p.id, p.bulk FROM c0 p LIMIT 2)');
    expect(sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c1 s');
  });

  test('inject seeds a VALUES stream', () => {
    const p = read('g.inject(1,2,3)');
    // q-kernel built: Query mints the CTE name (unquoted, identifier-safe) + our
    // SQL casing; binds ride as Value tokens (one row each).
    // inject is a ScalarStream source materialized directly from its VALUES relation.
    expect(p.sql).toBe('with c0(v) as (VALUES (?), (?), (?)) SELECT v FROM c0');
    expect(p.binds).toEqual([1, 2, 3]);
  });

  test('as() threads a synthetic alias column through subsequent CTEs', () => {
    const p = read('g.V().as("a").out("knows").select("a")');
    // as('a') appends the current id to label a0's JSONB history array; out() carries a0
    expect(p.sql).toContain("jsonb_array(jsonb_object('k', ?, 'v', p.id)) AS a0, p.bulk FROM c0");
    expect(p.sql).toContain('SELECT e.tgt AS id, p.a0, p.bulk FROM edges e');
    // select retypes the alias to a fresh element stream (last id out of history), then root framing rejoins it.
    expect(p.sql).toContain('SELECT CAST(p.a0 ->> ? AS INTEGER) AS id, p.a0, p.bulk FROM c2 p');
    expect(p.sql).toContain('JOIN c3 p ON n.id=p.id');
    expect(p.shape).toEqual({ kind: 'vertex' });
  });

  test('single-label select().by(key) → scalar value from the alias column', () => {
    const p = read('g.V().as("a").out().select("a").by("name")');
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS v");
    expect(p.sql).toContain('ON n.id=CAST(p.a0 ->> ? AS INTEGER)');
    const child = read('g.V(1).as("a").out().select("a").by(__.out().count())');
    expect(child.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(child.sql).toContain('SELECT CAST(p.a0 ->> ? AS INTEGER) AS id');
    expect(child.sql).toContain('GROUP BY d.o0');
  });

  test('multi-label select → map shape with per-entry prefixed columns', () => {
    const p = read('g.V().as("a").out().as("b").select("a","b")');
    expect(p.shape).toEqual({ kind: 'map', entries: [
      { key: 'a', prefix: 'e0', sub: 'vertex' },
      { key: 'b', prefix: 'e1', sub: 'vertex' },
    ] });
    expect(p.sql).toContain('COALESCE(e0n.uid, e0n.id) AS e0_id'); // element reports uid ?? rowid
    expect(p.sql).toContain('COALESCE(e1n.uid, e1n.id) AS e1_id');
    expect(p.sql).toContain('JOIN nodes e0n ON e0n.id=CAST(p.a0 ->> ? AS INTEGER)');
    expect(p.sql).toContain('JOIN nodes e1n ON e1n.id=CAST(p.a1 ->> ? AS INTEGER)');
  });

  test('select().by(key) maps every entry to a scalar; by mods cycle', () => {
    const both = read('g.V().as("a").out().as("b").select("a","b").by("name")');
    expect(both.shape).toEqual({ kind: 'map', entries: [
      { key: 'a', prefix: 'e0', sub: 'value' },
      { key: 'b', prefix: 'e1', sub: 'value' },
    ] });
    const cyc = read('g.V().as("a").out().as("b").select("a","b").by("age").by("name")');
    // e0 uses by('age'), e1 uses by('name')
    expect(cyc.sql).toContain("(SELECT value FROM vertex_properties WHERE node=e0n.id AND key=? ORDER BY id LIMIT 1) AS e0_v");
    expect(cyc.sql).toContain("(SELECT value FROM vertex_properties WHERE node=e1n.id AND key=? ORDER BY id LIMIT 1) AS e1_v");
  });

  test('project() applies by mods to the current traverser under fresh keys', () => {
    const p = read('g.V().project("n","a").by("name").by("age")');
    expect(p.shape).toEqual({ kind: 'map', entries: [
      { key: 'n', prefix: 'e0', sub: 'value' },
      { key: 'a', prefix: 'e1', sub: 'value' },
    ] });
    // both entries source the current traverser (p.id), not an alias column
    expect(p.sql).toContain('JOIN nodes e0n ON e0n.id=p.id');
    expect(p.sql).toContain('JOIN nodes e1n ON e1n.id=p.id');
  });

  test('project().by(traversal) lowers each field through child scalar streams', () => {
    const p = read('g.V().project("name","friend").by(__.values("name")).by(__.out().values("name"))');
    expect(p.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'name', prefix: 'e0', sub: 'value' },
        { key: 'friend', prefix: 'e1', sub: 'value' },
      ],
    });
    expect(p.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(p.sql).not.toContain(' AS o1');
    expect(p.sql).toContain('JOIN c');
    expect(p.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V().project("friend").by(__.out().values("name")).select("friend")').shape)
      .toEqual({ kind: 'value', type: UNKNOWN });
    const mixed = read('g.V().project("name","degree").by("name").by(__.out().count())');
    expect(mixed.sql).toContain('SELECT value FROM vertex_properties WHERE node=p0.id AND key=?');
    expect(mixed.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V().project("id","friend").by(T.id).by(__.out().values("name"))').shape.kind).toBe('map');
    const element = read('g.V(1).project("self","friend").by().by(__.out().values("name"))');
    expect(element.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'self', prefix: 'e0', sub: 'vertex' },
        { key: 'friend', prefix: 'e1', sub: 'value' },
      ],
    });
    expect(element.sql).toContain('b0.rid AS e0_rid');
    expect(element.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V(1).project("self","friend").by().by(__.out().values("name")).select("self").out().count()').shape)
      .toEqual({ kind: 'count' });
  });

  test('project/select traversal fields carry typed list and element shapes', () => {
    const shaped = read('g.V(1).project("friends","first").by(__.out().values("name").fold()).by(__.out())');
    expect(shaped.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'friends', prefix: 'e0', sub: 'list', of: { kind: 'scalar', typed: true } },
        { key: 'first', prefix: 'e1', sub: 'vertex' },
      ],
    });
    expect(shaped.sql).toContain('b0.list AS e0_list');
    expect(shaped.sql).toContain('b1.rid AS e1_rid');
    expect(shaped.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V(1).project("friends").by(__.out().values("name").fold()).select("friends").unfold().count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V(1).project("friends","created").by(__.out().values("name").fold()).by(__.out("created").values("name").fold()).select(Column.values).unfold()').shape)
      .toEqual({ kind: 'jsonbList', typed: true });
    expect(read('g.V(1).as("a").out().select("a").by(__.out()).values("name")').shape)
      .toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('multi-select traversal fields re-root generic children on each labelled element', () => {
    const selected = read('g.V(1).as("a").out("knows").as("b").select("a","b").by(__.out().count()).by(__.values("name"))');
    expect(selected.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'a', prefix: 'e0', sub: 'value' },
        { key: 'b', prefix: 'e1', sub: 'value' },
      ],
    });
    expect(selected.sql).toContain('SELECT CAST(p0.a0 ->> ? AS INTEGER) AS id');
    expect(selected.sql).toContain('SELECT CAST(p1.a1 ->> ? AS INTEGER) AS id');
    expect(selected.sql).toContain('ON b1.o0=b0.o0');
    const mixed = read('g.V(1).as("a").out("knows").as("b").select("a","b").by("name").by(__.out().count())');
    expect(mixed.sql).toContain('SELECT value FROM vertex_properties WHERE node=CAST(p0.a0 ->> ? AS INTEGER) AND key=?');
    const element = read('g.V(1).as("a").out("knows").as("b").select("a","b").by().by(__.out().count())');
    expect(element.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'a', prefix: 'e0', sub: 'vertex' },
        { key: 'b', prefix: 'e1', sub: 'value' },
      ],
    });
  });

  test('order() on a record stream sorts by a by(__.select(field)) modulator', () => {
    const p = read("g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).select('a')");
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    // the order CTE sorts the record rows by field b's value column, descending
    expect(p.sql).toContain('ORDER BY r.e1_v DESC');
    // a following limit fuses into the same ORDER BY query (LIMIT after the sort)
    const lim = read("g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).limit(2).select('a')");
    expect(lim.sql).toContain('ORDER BY r.e1_v DESC LIMIT 2 OFFSET 0');
    // an element field orders by its external id
    expect(read("g.V(1).project('self','b').by().by(__.out().count()).order().by(__.select('self')).select('b')").sql)
      .toContain('ORDER BY r.e0_id ASC');
    // bare order() / a list field defer with a clear error
    expect(() => compile("g.V().project('a').by('name').order().select('a')", {})).toThrow('requires a by(field)');
  });

  test('order() on a record executes: sort by a projected count, then extract a field', () => {
    const store = seededStore();
    // lop is created by marko/josh/peter (in-count 3), ripple by josh only (1)
    expect(run(store, "g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).select('a')").map((r) => r.v))
      .toEqual(['lop', 'lop', 'lop', 'ripple']);
    expect(run(store, "g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b')).select('a')").map((r) => r.v))
      .toEqual(['ripple', 'lop', 'lop', 'lop']);
  });

  test('sum(Scope.local) threads carried alias columns (as() survives the per-list reduce)', () => {
    // #5: the list-local reducer used to drop carried cols, so as() after it tripped
    // assertStreamColumns. Now the reduced scalar keeps the a0 history of "v".
    const p = read("g.V().as('v').map(__.bothE().values('weight').fold()).sum(Scope.local).as('s').select('v','s')");
    expect(p.shape.kind).toBe('map');
    expect(p.sql).toContain('AS v, typeof('); // the reducer CTE
    expect(p.sql).toContain(', c.a0, c.bulk FROM'); // a0 carried through the reduce
    // record order by an element field's property: by(__.select(field).values(key))
    const ord = read("g.V().as('v').map(__.bothE().values('weight').fold()).sum(Scope.local).as('s').select('v','s').order().by(__.select('s'), Order.desc).by(__.select('v').values('name'))");
    expect(ord.sql).toContain('ORDER BY r.e1_v DESC');
    expect(ord.sql).toContain("(SELECT value FROM vertex_properties WHERE node=r.e0_rid AND key=? ORDER BY id LIMIT 1) ASC");
  });

  test('order() on a record by a select(field).values(key) modulator executes (Order.feature)', () => {
    const store = seededStore();
    // The terminal ordered map result: sum(weight) desc, tie broken by v's name asc.
    // weights: josh 2.4, marko 1.9, lop 1.0, ripple 1.0, vadas 0.5, peter 0.2.
    const rows = run(store, "g.V().as('v').map(__.bothE().values('weight').fold()).sum(Scope.local).as('s').select('v','s').order().by(__.select('s'), Order.desc).by(__.select('v').values('name'))");
    expect(rows.map((r) => r.e0_id)).toEqual([4, 1, 3, 5, 2, 6]); // josh, marko, lop, ripple, vadas, peter
    expect(rows.map((r) => r.e1_v)).toEqual([2.4, 1.9, 1, 1, 0.5, 0.2]);
  });

  test('record fields re-enter element/scalar/list lowering', () => {
    expect(read('g.V().project("n","a").by("name").by("age").select("a").is(P.gt(30)).count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V().as("a").out().as("b").select("a","b").select("b").out().count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V().project("n","a").by("name").by("age").select(Column.values).unfold().count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V().project("n","a").by("name").by("age").select(Column.keys).unfold().count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V().project("n","a").by("name").by("age").limit(Scope.local,1)').shape)
      .toEqual({ kind: 'map', entries: [{ key: 'n', prefix: 'e0', sub: 'value' }] });
    expect(read('g.V().project("n","a").by("name").by("age").tail(Scope.local,1)').shape)
      .toEqual({ kind: 'map', entries: [{ key: 'a', prefix: 'e1', sub: 'value' }] });
  });

  test('dedup().by() is a windowed modulation-key consumer with explicit encounter order', () => {
    const store = seededStore();
    const ordered = read('g.V().order().by("name",desc).barrier().dedup().by("age").values("name")');
    expect(ordered.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(ordered.sql).toContain('AS encounter');
    expect(run(store, 'g.V().order().by("name",desc).barrier().dedup().by("age").values("name")').map((r) => r.v))
      .toEqual(['vadas', 'peter', 'marko', 'josh']);
    expect(run(store, 'g.V().order().by("name",desc).barrier().dedup().by("age").as("x").values("name")').map((r) => r.v))
      .toEqual(['vadas', 'peter', 'marko', 'josh']);
    expect(run(store, 'g.V().order().by("name",desc).barrier().dedup().by("age").order().by("name").barrier().dedup().values("name")').map((r) => r.v))
      .toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(run(store, 'g.V().both().dedup().by("age").values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter', 'vadas']);
    expect(run(store, 'g.V().both().both().dedup().by(T.label).count()').map((r) => r.v)).toEqual([2]);
    expect(run(store, 'g.V().both().both().dedup().by(__.outE().count()).count()').map((r) => r.v)).toEqual([4]);
  });

  test('order().by(__.traversal): sort via the generic scalar child seam (same as dedup)', () => {
    const store = seededStore();
    // sort by a per-traverser child scalar (out-degree), reusing tryCompileScalarValueRows.
    expect(run(store, 'g.V().order().by(__.out().count(),desc).values("name")').map((r) => r.v))
      .toEqual(['marko', 'josh', 'peter', 'vadas', 'lop', 'ripple']);
    expect(run(store, 'g.V().has("age").order().by(__.values("age")).values("name")').map((r) => r.v))
      .toEqual(['vadas', 'marko', 'josh', 'peter']);
    // the SQL routes through the child seam (a correlated child rank + a fresh encounter).
    expect(read('g.V().order().by(__.out().count()).values("name")').sql).toContain('ROW_NUMBER() OVER');
  });

  test('fold() wraps the projection in a list shape (element or scalar)', () => {
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList', typed: true });
    expect(read('g.V(1).outE().fold()').shape).toEqual({ kind: 'list', elem: 'edge' });
  });

  test('sum() wraps a value stream in SQL SUM → scalar shape', () => {
    const p = read('g.V().values("age").sum()');
    expect(p.shape).toEqual({ kind: 'scalar' });
    expect(p.sql).toContain('SELECT SUM(s.v * s.bulk) AS v, typeof(SUM(s.v * s.bulk)) AS vt FROM');
  });

  test('numeric reducers are scalar streams and preserve dynamic type past filters', () => {
    const summed = read('g.V().values("age").sum().is(P.gt(100))');
    expect(summed.shape).toEqual({ kind: 'scalar' });
    expect(summed.sql).toContain('SUM(s.v * s.bulk) AS v');
    expect(summed.sql).toContain('p.vt AS vt');
    expect(summed.sql).toContain('WHERE p.v > ?');

    const store = seededStore();
    expect(run(store, 'g.V().values("age").sum().is(P.gt(100))').map((r) => r.v)).toEqual([123]);
    expect(run(store, 'g.V().values("age").asNumber(GType.DOUBLE).sum()').map((r) => r.v)).toEqual([123]);
  });

  test('scalar row operators lower left-to-right instead of commuting through a tail accumulator', () => {
    const p = read('g.V().values("age").count().limit(1).is(P.gt(3))');
    expect(p.shape).toEqual({ kind: 'count' });
    expect(p.sql).toContain('LIMIT 1 OFFSET 0');
    expect(p.sql).toContain('WHERE p.v > ?');
    expect(p.sql.indexOf('LIMIT 1 OFFSET 0')).toBeLessThan(p.sql.indexOf('WHERE p.v > ?'));

    const store = seededStore();
    expect(run(store, 'g.V().values("age").count().limit(1).is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().values("age").count().limit(0).is(P.gt(3))')).toEqual([]);
  });

  test('scalar transforms lower relationally and feed later filters/reducers', () => {
    const transformed = read('g.V().values("name").toUpper().is("MARKO")');
    expect(transformed.sql).toContain('upper(p.v) AS v');
    expect(transformed.sql).toContain('WHERE upper(p.v) = ?');

    const fused = read('g.V().values("name").toLower().is(P.neq("x")).toUpper()');
    expect(fused.sql).toContain('upper(lower(p.v)) AS v');
    expect(fused.sql).toContain('WHERE lower(p.v) != ?');
    expect(fused.sql).not.toContain('FROM c2 p)');

    // A keyed/bare order() re-establishes determinism, so the following slice needs no emission
    // encounter — order()+range() fuse into one ORDER BY … LIMIT … OFFSET (demand pass resets).
    const ordered = read('g.V().values("age").order().range(1,3)');
    expect(ordered.sql).toContain('ELSE p.v END) ASC LIMIT 2 OFFSET 1');

    const typedSum = read('g.V().values("age").asNumber(GType.DOUBLE).sum().is(P.gt(100))');
    expect(typedSum.shape).toEqual({ kind: 'scalar' });
    expect(typedSum.sql).toContain('CAST(p.v AS REAL) AS v');
    expect(typedSum.sql).toContain('SUM(s.v * s.bulk) AS v');

    const store = seededStore();
    expect(run(store, 'g.V().values("name").toUpper().is("MARKO")').map((r) => r.v)).toEqual(['MARKO']);
    expect(run(store, 'g.V().values("age").asNumber(GType.DOUBLE).sum().is(P.gt(100))').map((r) => r.v)).toEqual([123]);
  });

  test('aggregation deferred forms throw clearly', () => {
    // group() is now always a GroupStream. Element-LIST values (by(__.out())/bare) re-enter
    // via the list-of-rid substrate; a single-element (tail) value entry still defers.
    expect(() => compile('g.V().group().by("name").by(__.tail()).select(Column.values)', {})).toThrow('single-element (tail) values not yet supported');
    expect(() => compile('g.V().groupCount().by("name").cap("x")', {})).toThrow('cap() on a group value not yet supported');
    expect(() => compile('g.V().properties().group().by()', {})).toThrow('group().by() on a property element is not yet supported');
    expect(() => compile('g.V().group().by("name").by("age").by("x")', {})).toThrow('more than two by() modulators');
    expect(read('g.V().count().fold()').shape).toEqual({ kind: 'jsonbList', as: 'long' });
    expect(() => compile('g.V().sum()', {})).toThrow('sum() of vertex not yet supported');
  });
});
