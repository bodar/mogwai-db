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
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { exec, executeQuery } from '../support/executor.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { decode, decodeAll } from '../support/decode.ts';
import { read, relirOff, run, runWith, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

// Every GLOBAL numeric reducer renders `numericReducerAggregate`'s eligibility guard
// (src/compiler/steps/tail/barrier.ts) — the one reducer policy, and the same text the
// group-scoped reducers already emit. Named here so an assertion below says WHICH reducer it
// pins instead of restating 60 characters of CASE. min/max range over text too (TinkerPop 4
// Strings are Comparable); sum/mean are numeric-only.
const eligible = (col: string, text = false): string =>
  `CASE WHEN typeof(${col}) in ('integer', 'real'${text ? ", 'text'" : ''}) THEN ${col} END`;

// A transform pin's semantic fact is WHICH SQLite function wraps the traverser's value — legacy names a
// CTE column (`p.v`), RelIR inlines the projection it fused into the same SELECT, and the assertion must
// survive both (test/CLAUDE.md: snapshots assert semantic equivalence, not byte identity).
const wraps = (fn: string) => new RegExp(`\\b${fn}\\(`);

describe('scalar-parent / projection SQL', () => {
  test('order().by(key[, dir]) folds ORDER BY into the projection select', () => {
    // The LEGACY spelling, named as such: element `order()` is RelIR-routed now (it MINTS the
    // emission-order channel), so a bare `read` here would pin the new spine's shape under the old
    // spine's name. §10·4 — a test that pins a spine's spelling pins BOTH, and the RelIR arm is
    // asserted below rather than left to the differential.
    const asc = read('g.V().hasLabel("person").order().by("age").values("name")', { spine: 'legacy' });
    // the order key is the vtype-aware compareKey (numeric for a TEXT-stored big value)
    expect(asc.sql).toContain("ROW_NUMBER() OVER (ORDER BY (SELECT (CASE WHEN vtype IN ('byte'");
    expect(asc.sql).toContain("ELSE value END) FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) ASC) AS encounter");
    // order().by(key) before a scalar projection routes through the scalar pipeline: the
    // element order becomes the carried encounter (a ROW_NUMBER window). binds: label,
    // the order key (window), the values() join key, then the order key AGAIN for the
    // NON-PRODUCTIVE by() drop — TinkerPop's default by() drops a traverser it yields nothing
    // for, so the projection filters on `<key> IS NOT NULL` (orderProductivityFilter).
    expect(asc.binds).toEqual(['person', 'age', 'name', 'age']);

    const desc = read('g.V().hasLabel("person").order().by("age",desc).values("name")', { spine: 'legacy' });
    expect(desc.sql).toContain("ELSE value END) FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) DESC");

    // The RelIR arm says the same three things in its own vocabulary: the position is MINTED by a
    // `ROW_NUMBER()` over the vtype-aware compare key, the non-productive `by()` drop is present, and
    // the direction reaches the window rather than being lost.
    const relAsc = read('g.V().hasLabel("person").order().by("age").values("name")', { spine: 'rel' });
    expect(relAsc.sql).toMatch(/row_number\(\) OVER \(ORDER BY \(SELECT CASE WHEN \w+\.vtype IN [^]*CAST\(\w+\.value AS INT\)[^]*ASC/);
    // The non-productive drop, spelled with a BOUND null (RelIR binds every `Lit`; legacy inlines it).
    expect(relAsc.sql).toMatch(/\(\(SELECT CASE WHEN [^]*IS NOT \?\)/);
    expect(read('g.V().hasLabel("person").order().by("age",desc).values("name")', { spine: 'rel' }).sql)
      .toMatch(/row_number\(\) OVER \(ORDER BY \(SELECT CASE WHEN [^]*DESC/);
  });

  test('values().order() sorts the projected scalar', () => {
    // A scalar order() is a RELATION operator (unlike the element one, which is the framing
    // projection's ORDER BY), so it is RelIR-routed (§10·4). What both spines must agree on is that
    // the sort key is the VTYPE-AWARE compare key — numeric for a TEXT-stored big long / bigdecimal
    // / duration, lexical for a string via the ELSE branch — so that is what is asserted per spine,
    // rather than either one's aliases.
    const legacy = read('g.V().values("age").order()', { spine: 'legacy' });
    expect(legacy.sql).toContain('ORDER BY (CASE WHEN p.vtype');
    expect(legacy.sql).toContain('ELSE p.v END) ASC');
    const rel = read('g.V().values("age").order()', { spine: 'rel' });
    expect(rel.sql).toMatch(/ORDER BY CASE WHEN \w+\.vtype IN [^]*CAST\(\w+\.v AS INT\)[^]*CAST\(\w+\.v AS REAL\)[^]*ASC/);
    // …and the key reads a COLUMN, not the value expression re-inlined: the `Materialize` fence in
    // front of a clause-position reader is what keeps one order() at 15 binds instead of 24.
    expect(rel.sql).not.toMatch(/ORDER BY[^]*CAST\(CASE/);
    // values() carries the per-row stored type → framed by it (perRowType), on both.
    for (const p of [legacy, rel]) expect(p.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('range/skip become LIMIT/OFFSET tail modifiers under order()', () => {
    // Legacy folds the slice into the framing tail; RelIR reads the position it minted and slices the
    // RELATION, so each spine is pinned in its own spelling (§10·4) and `test:legacy-spine` plus the
    // row-for-row differential in `test/rel-spine.test.ts` are what tie the two answers together.
    expect(read('g.V().order().by("age").range(1,3).values("name")', { spine: 'legacy' }).sql).toContain('LIMIT 2 OFFSET 1');
    expect(read('g.V().order().by("age").skip(1)', { spine: 'legacy' }).sql).toContain('LIMIT -1 OFFSET 1');
    // RelIR: an ORDER BY on the minted channel, then the ordinary LIMIT/OFFSET.
    const rel = read('g.V().order().by("age").range(1,3).values("name")', { spine: 'rel' });
    expect(rel.sql).toMatch(/ORDER BY \w+\.encounter ASC LIMIT \? OFFSET \?/);
    expect(rel.binds).toContain(2);
  });

  test('range/skip/limit compose as CTEs, ordered by the source encounter when no order() is present', () => {
    // The `ORDER BY p.encounter` is the point, and it arrived 2026-08-01: a bare LIMIT/OFFSET took
    // whatever subset SQLite scanned first, which is a WRONG SUBSET rather than a reorder and
    // changed answer under `mise run test:perturbed`. The source seeds `encounter = id`, so the
    // window is now the id order the reference iterates in — and it is a rowid read, not a sort.
    expect(read('g.V().range(1,3)', { spine: 'legacy' }).sql).toContain('SELECT p.id, p.bulk, p.encounter FROM c0 p ORDER BY p.encounter LIMIT 2 OFFSET 1');
    expect(read('g.V().skip(2)', { spine: 'legacy' }).sql).toContain('SELECT p.id, p.bulk, p.encounter FROM c0 p ORDER BY p.encounter LIMIT -1 OFFSET 2');
    expect(read('g.V().range(1,3)', { spine: 'legacy' }).sql).toContain('SELECT id, 1 AS bulk, id AS encounter FROM nodes');
    // Both spines seed the encounter from the ROWID and take the window from it — that is the
    // property, and it is what makes the subset the reference's rather than SQLite's scan order.
    // The ORDER BY's SPELLING differs: the RelIR assembler fuses the sort into the source block, so
    // it orders by the expression that COMPUTES the encounter (`rn.id`) rather than by the column
    // name a separate CTE would have given it. Same order, one derived table fewer.
    for (const spine of ['legacy', 'rel'] as const) {
      const ranged = read('g.V().range(1,3)', { spine }).sql;
      expect(ranged).toMatch(/AS encounter FROM nodes/);
      expect(ranged).toMatch(/ORDER BY [\w.]+(?: ASC)?[^)]*LIMIT[^)]*OFFSET/i);
      expect(read('g.V().skip(2)', { spine }).sql).toMatch(/ORDER BY [\w.]+(?: ASC)?[^)]*OFFSET/i);
    }
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
    // Both spines retype (RelIR takes this chain now), so the LEGACY spelling is pinned by name and the
    // RelIR one beside it — what both must have is the `json(<value>) AS list` projection under a
    // `vtype = 'list'` filter, which is the retype rather than a predicate.
    const listed = read('g.V().values("list").is(typeOf(GType.LIST))', { spine: 'legacy' });
    // typed: items are self-describing {t,v} nodes → framed via frameTypedNode (full-fidelity).
    expect(listed.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    expect(listed.sql).toContain("json(p.v) AS list");
    expect(listed.sql).toContain("p.vtype = ?");
    expect(listed.binds).toContain('list');
    const relListed = read('g.V().values("list").is(typeOf(GType.LIST))', { spine: 'rel' });
    expect(relListed.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    // The RelIR route composes the retype's `json(v)` (relation level) with the payload projection's own
    // `json(list)` (§10·10) — a no-op nesting, since `json()` of valid JSON text is that text. The
    // assertion is about WHICH column becomes the list, not how many times the conversion is spelled;
    // §5a's gate is results and access path, never spelling.
    expect(relListed.sql).toMatch(/json\((?:json\()?\w+\.v\)+ AS list/);
    expect(relListed.sql).toMatch(/WHERE \(\w+\.vtype = \?\)/);
    // once a ListStream, the list substrate composes: unfold/count(local)/range reuse it.
    // typed unfold carries each element's own stored vtype (perRowType framing).
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).count(Scope.local)').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold().range(1,3)').sql).toContain('json_each');

    // End-to-end framing: a list value frames as ONE List, unfold explodes it, uuid
    // round-trips through UuidSerializer.
    const store = new GraphStore(new BunSqlite(':memory:'));
    executeQuery(store, "g.addV('data').property('list',['a','b','c']).property('uuid', UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'))", {});
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST))", {}))).toEqual([['a', 'b', 'c']]);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).unfold()", {}))).toEqual(['a', 'b', 'c']);
    expect(await decodeAll(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).count(Scope.local)", {}))).toEqual([3]);
    expect(await decodeAll(executeQuery(store, "g.V().values('uuid')", {}))).toEqual(['0263f28b-eff9-4c17-8e33-0b41c74b6d4c']);
  });

  test('global count() + is(typeOf(LIST)) identity on a fold() list value', async () => {
    // A fold() collapses the stream into ONE list traverser. A GLOBAL count() counts the list
    // TRAVERSERS (1), distinct from count(Scope.local) which is the list LENGTH — so it routes
    // through the shared relational barrier, not the per-list reducer.
    expect(read("g.V().values('name').fold().count()").shape).toEqual({ kind: 'value', type: STATIC('long') });
    // is(typeOf(LIST)) on a list value is an identity type-assert (a list IS a list) — the
    // terminal stream stays a list, then count() reports 1.
    expect(read("g.V().values('name').fold().is(typeOf(GType.LIST)).count()").shape).toEqual({ kind: 'value', type: STATIC('long') });
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const w of MODERN_SEED) executeQuery(store, w, {});
    // one list of 6 names → count 1 (a Long that decodes to a Number after the Int64 fix).
    expect(await decodeAll(executeQuery(store, "g.V().values('name').fold().count()", {}))).toEqual([1]);
    expect(await decodeAll(executeQuery(store, "g.V().values('name').fold().is(typeOf(GType.LIST)).count()", {}))).toEqual([1]);
    // the identity assert leaves the list intact (6 names) when terminal.
    expect(((await decode((executeQuery(store, "g.V().values('name').fold().is(typeOf(GType.LIST))", {}))[0])) as any[]).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('min/max range over comparables (incl. text); mean/sum numeric only', () => {
    const mn = read('g.V().values("age").min()', { spine: 'legacy' });
    // TinkerPop 4 Strings are Comparable, so min/max include text (numbers order first).
    expect(mn.sql).toContain("typeof(s.v) in ('integer', 'real', 'text')");
    expect(mn.sql).toContain(`MIN(${eligible('s.v', true)})`);
    expect(mn.shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").max()', { spine: 'legacy' }).sql).toContain(`MAX(${eligible('s.v', true)})`);
    // mean stays numeric-only (never text).
    expect(read('g.V().values("age").mean()', { spine: 'legacy' }).sql).toContain("typeof(s.v) in ('integer', 'real')");
    // mean is always a Double (forced vt='real')
    const avg = read('g.V().values("age").mean()', { spine: 'legacy' });
    // The weighted-mean denominator counts only the ELIGIBLE rows' bulk, which is what the
    // policy's nested CASE says and what the WHERE-clause form used to say positionally.
    expect(avg.sql).toContain(`SUM(${eligible('s.v')} * s.bulk) * 1.0 / SUM(CASE WHEN ${eligible('s.v')} IS NOT NULL THEN s.bulk END)`);
    expect(avg.sql).toContain("'real' AS vt");

    // RelIR decides in Gremlin TYPE SPACE, not SQLite storage class: every numeric subtype shares
    // one space, strings occupy the other. The canonical type names are compiler-authored binds.
    for (const [gremlin, spaces] of [
      ['g.V().values("age").min()', ['number', 'string']],
      ['g.V().values("age").max()', ['number', 'string']],
      ['g.V().values("age").sum()', ['number']],
      ['g.V().values("age").mean()', ['number']],
    ] as const) {
      const p = read(gremlin, { spine: 'rel' });
      for (const space of spaces) expect(p.binds).toContain(space);
      expect(p.shape).toEqual({ kind: 'scalar' });
    }
    // …and the mean is forced REAL by a CAST rather than legacy's `* 1.0`: every RelIR `Lit` is a bind
    // and a JS `1.0` binds as an INTEGER, so the multiplier cannot carry the distinction (measured: the
    // reference mean came back 30 instead of 30.75).
    expect(read('g.V().values("age").mean()', { spine: 'rel' }).sql).toMatch(/CAST\(sum\([^]*AS REAL\) \//);
    // min(Scope.local) after fold() reduces the folded list per-list (list phase).
    expect(read('g.V().values("age").fold().min(Scope.local)').shape).toEqual({ kind: 'scalar' });

    // "numeric only" is a RESULT claim, not just an SQL one, and it was false for sum() alone:
    // the global arm carried no eligibility guard, so SQLite coerced each text value to 0 and
    // an all-text sum() returned a fabricated 0. It must report nothing eligible, exactly as the
    // same reducer over an EMPTY stream does — that equality is the pin.
    const store = seededStore();
    expect(run(store, 'g.V().values("name").sum()').map((r) => r.v))
      .toEqual(run(store, 'g.V().hasLabel("nosuch").values("age").sum()').map((r) => r.v));
    expect(run(store, 'g.V().values("name").sum()').map((r) => r.v)).toEqual([null]);
    // A MIXED stream was always right (SQLite contributes 0 per text value), so the guard must
    // not disturb it; min/max over the same mixed stream stay text-inclusive.
    expect(run(store, 'g.V().union(__.values("age"), __.values("name")).sum()').map((r) => r.v)).toEqual([123]);
    expect(run(store, 'g.V().union(__.values("age"), __.values("name")).min()').map((r) => r.v)).toEqual([27]);
  });

  test('reducers use Gremlin type space and preserve a TEXT-carried long', async () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // SPINE PINNED, not ambient. This is the RelIR answer: legacy keeps the storage-class guard and
    // order (§14 — legacy is what §8 deletes, and the L3 ratchet's two floors are what let RelIR be
    // ahead), so reading the ambient switch would make every assertion below say a different thing
    // under `mise run test:legacy-spine`. Pinning is mise.toml's existing rule for a spine-specific
    // assertion. `sum` weighting needs a write, so the seed stays on the ambient route.
    const relir = (gremlin: string) => exec(store, undefined, undefined, 'rel').buffers(gremlin, {});
    expect(await decodeAll(relir('g.inject(9007199254740993L, 1L).sum()')))
      .toEqual([9007199254740994]);
    expect(await decodeAll(relir('g.inject(9007199254740993L, 1L).mean()')))
      .toEqual([4503599627370497]);
    expect(await decodeAll(relir('g.inject(10L, -9007199254740993L).min()')))
      .toEqual([-9007199254740993n]);
    expect(await decodeAll(relir('g.inject(10L, -9007199254740993L).max()')))
      .toEqual([10]);

    // A MIXED type space FAILS CLOSED. The reference refuses it — `NumberHelper.min`/`max` end in
    // `a.compareTo(b)` for a non-Number pair, so `Integer.compareTo(String)` throws — and the
    // alternative is returning SQLite's storage-class extremum (min of [1,"a"] answering 1) silently.
    // The refusal is a property of the ROWS, so it rides `REDUCER_ERROR_PREFIX` out of the aggregate.
    for (const reducer of ['min', 'max'])
      expect(() => relir(`g.inject(1, "a").${reducer}()`))
        .toThrow(`${reducer}() cannot compare values from mixed Gremlin type spaces`);

    // Admitting exact int64 values makes overflow reachable. SQLite raises instead of wrapping,
    // agreeing with NumberHelper.mathOperationWithPromote's required failure.
    expect(() => relir('g.inject(9223372036854775807L, 1L).sum()'))
      .toThrow('integer overflow');

    // A bulk-weighted term overflows during multiplication, which SQLite would otherwise promote
    // to REAL before SUM could raise. A self-loop makes both() carry the vertex at bulk two.
    executeQuery(store, 'g.addV("x").property("n", 9223372036854775807L)', {});
    executeQuery(store, 'g.V(1).addE("loop").to(__.V(1))', {});
    expect(() => relir('g.V(1).both().values("n").sum()'))
      .toThrow('sum() integer overflow');
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
    // What is under test is the FLATTENING — three values, not one array — so the three are asserted by
    // presence on both spines. RelIR's bind list also carries the reducer's eligibility class names, and
    // an exact-equality assertion here would be pinning that unrelated fact.
    for (const spine of ['legacy', 'rel'] as const)
      for (const value of [1, 2, 3]) expect(read('g.inject(1,2,3).sum()', { spine }).binds).toContain(value);
  });

  test('fold() as a value + unfold() re-enters the tail', () => {
    // Element folds retain the row-framing path; scalar folds become a genuine
    // ListStream even when terminal, so item metadata can survive the barrier.
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
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
    expect(read('g.V().fold().count(Scope.local)').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().values("age").fold().sum(Scope.local)').shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").fold().sum(Scope.local)').sql).toContain('json_each');
    // Local reducers are ScalarStream transitions, so a later predicate composes.
    expect(read('g.V().values("age").fold().sum(Scope.local).is(P.gt(1))').shape).toEqual({ kind: 'scalar' });
    // A retype boundary consumes the already-accumulated dedup before materialising the
    // list; it cannot defer that set semantics to terminal framing.
    expect(run(seededStore(), 'g.V().out().dedup().fold().unfold().values("name")').map((r: any) => r.v).sort())
      .toEqual(run(seededStore(), 'g.V().out().dedup().values("name")').map((r: any) => r.v).sort());
  });

  test('fold preserves uniform scalar item types through ListStream materialization', async () => {
    const typed = read('g.V().values("age").asNumber(GType.DOUBLE).fold()');
    expect(typed.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', as: 'double' } });

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
    expect(read('g.inject([1,3,100,300])').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    expect(read('g.inject([1,2],[3,4])').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // unfold() explodes the list back to a scalar stream.
    expect(read('g.inject([1,2,3]).unfold()').shape).toEqual({ kind: 'value', type: UNKNOWN });
    // Scope.local reducers act per-list (mean over the numeric elements → Double).
    expect(read('g.inject([null,10,20,null]).mean(Scope.local)').shape).toEqual({ kind: 'scalar' });
    // none(P) on a LIST keeps the list iff no element matches (collection filter).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').sql).toContain('NOT EXISTS');
    // none(pred) is NOT the iterate discard-marker (only a bare none() is stripped).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
  });

  test('set-op / list-algebra family (combine/intersect/difference/disjunct/product/conjoin/all/any)', () => {
    // combine = concat → a List; intersect/difference/disjunct → a Set (jsonbSet) when terminal.
    expect(read('g.V().values("age").fold().combine([1,2])').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    expect(read('g.V().values("age").fold().intersect([27,29])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("age").fold().difference([27])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("age").fold().disjunct([27])').shape).toEqual({ kind: 'jsonbSet' });
    // merge = set union of both operands → a Set (jsonbSet) when terminal.
    expect(read('g.V().values("age").fold().merge([1,2])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.inject(["a",null,"b"]).merge(["a","c"])', { spine: 'legacy' }).sql).toContain('UNION');
    // null-safe set membership (IS, not =) so null intersects/differs correctly — both spines, each in
    // its own aliases, because getting this wrong is a wrong ANSWER (a null member never matching).
    expect(read('g.inject(["a",null,"b"]).difference(["a","c"])', { spine: 'legacy' }).sql).toContain('o.value IS je.value');
    expect(read('g.inject(["a",null,"b"]).difference(["a","c"])', { spine: 'rel' }).sql)
      .toMatch(/WHERE \(\w+\.value IS \w+\.value\)/);
    // A SET's member order is NAMED rather than inherited from the dedup implementation (`UNION` sorts,
    // `SELECT DISTINCT` does not) — on both spines, so the two agree by construction.
    for (const spine of ['legacy', 'rel'] as const)
      expect(read('g.inject(["a",null,"b"]).merge(["a","c"])', { spine }).sql).toMatch(/ORDER BY \w*\.?\bmv? ?ASC|ORDER BY value/);
    // a Set followed by a list op (order(Scope.local)) degrades to a List (not a Set).
    expect(read('g.V().values("age").fold().intersect([27]).order(Scope.local)').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // constant(c).fold() and a standalone scalar-list traversal are valid operands.
    expect(read('g.V().values("age").fold().intersect(__.constant(27).fold())').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().values("name").fold().difference(__.V().values("name").fold())').shape).toEqual({ kind: 'jsonbSet' });
    // the standalone operand embeds as a scalar subquery (its own WITH + json_group_array).
    // A SUB-READ operand — the members are only known at run time, so the operand is a relation. Legacy
    // compiles it separately and embeds the rendered SQL; RelIR lowers it with the SAME fold into the
    // same algebra and reads it through a `Scalar` expression (no escape node), so each spine is pinned
    // in its own spelling and the row-for-row differential ties the answers.
    expect(read('g.V().values("name").fold().difference(__.V().values("name").fold())', { spine: 'legacy' }).sql)
      .toContain('SELECT jsonb(list)');
    expect(read('g.V().values("name").fold().difference(__.V().values("name").fold())', { spine: 'rel' }).sql)
      .toMatch(/json_each\(\(SELECT jsonb\(COALESCE\(json_group_array/);
    // an element-fold operand (a vertex list) isn't a scalar list → defers.
    expect(() => compile('g.V().fold().combine(__.V().fold())', {})).toThrow('must fold a scalar list');
    // argument-type errors mirror TinkerPop's messages.
    expect(() => compile('g.V().fold().combine(2)', {})).toThrow('can only take an array or an Iterable as an argument');
    expect(() => compile('g.V().fold().combine(null)', {})).toThrow("can't be null");
    // product → a list of pair-lists; conjoin → a scalar string.
    expect(read('g.V().values("age").fold().product([1]).unfold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // conjoin joins the members into ONE string, whatever they were — a static 'string'
    // type, not per-value inference at the wire.
    expect(read('g.V().values("name").order().fold().conjoin("_")').shape).toEqual({ kind: 'value', type: STATIC('string') });
    // all(P)/any(P) filter the list (IS TRUE / IS NOT TRUE null handling).
    // `all` is "no member FAILS", not "every member passes" — the two differ once a predicate can be
    // NULL. Legacy spells the guard `IS NOT TRUE`; RelIR binds the 1 (`IS NOT ?`), which is the same
    // test for a predicate's 0/1/NULL result, so each spine is pinned in its own spelling (§10·4).
    expect(read('g.V().values("age").order().fold().all(P.gt(10))', { spine: 'legacy' }).sql).toContain('IS NOT TRUE');
    expect(read('g.V().values("age").order().fold().all(P.gt(10))', { spine: 'rel' }).sql)
      .toMatch(/NOT EXISTS \(SELECT \? AS one FROM json_each\([^]*IS NOT \?\)\)/);
    // `any` needs no `IS TRUE` guard at all — a `WHERE` already treats NULL as not-satisfied — so
    // legacy's explicit form and RelIR's bare predicate are the same test. `all` is the asymmetric one.
    expect(read('g.V().values("age").order().fold().any(P.gt(10))', { spine: 'legacy' }).sql).toContain('IS TRUE');
    expect(read('g.V().values("age").order().fold().any(P.gt(10))', { spine: 'rel' }).sql)
      .toMatch(/WHERE EXISTS \(SELECT \? AS one FROM json_each\(/);
    // a list-collection step on a scalar stream raises the incoming-type error.
    expect(() => compile('g.V().values("name").fold().unfold().combine([1])', {})).toThrow('incoming traversers');
  });

  test('Scope.local collection transforms reshape a list (order/dedup/limit/tail)', () => {
    // A non-terminal fold() → ListStream; a Scope.local transform rebuilds each list
    // (correlated json_each) and stays a list, so unfold() re-enters afterwards.
    const o = read('g.V().values("age").fold().order(Scope.local)');
    expect(o.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
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
    // An injected row carries NO multiplicity by construction, so the reducer takes the UNWEIGHTED form
    // — the same distinction `count()` draws between `COUNT(*)` and `SUM(bulk)`, read off the channel.
    expect(read('g.inject(1,2,3).sum()', { spine: 'legacy' }).sql).toContain(`SUM(${eligible('s.v')})`);
    expect(read('g.inject(1,2,3).sum()', { spine: 'rel' }).sql).toMatch(/sum\(CASE WHEN \(\w+\.type_space = \?\) THEN \w+\.compare END\) AS v/);
    expect(read('g.inject(1,2,3).sum()', { spine: 'rel' }).sql).not.toMatch(/\* \?\)\) AS v/);
    // Unweighted mean IS `AVG` — no bulk to weight by, so the weighted form's numerator/denominator
    // pair collapses to the builtin, on both spines.
    expect(read('g.inject(1,2,3).mean()', { spine: 'legacy' }).sql).toContain(`AVG(${eligible('s.v')})`);
    expect(read('g.inject(1,2,3).mean()', { spine: 'rel' }).sql).toMatch(/avg\(CASE WHEN \(\w+\.type_space = \?\) THEN \w+\.compare END\)/);
    expect(read('g.inject(1,2,3).count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.inject(1,2,3).fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // is() BEFORE count() filters the pre-count stream (WHERE inside the counted set)
    expect(read('g.inject(1,2,3).is(P.gt(1)).count()', { spine: 'legacy' }).sql).toContain('WHERE p.v > ?');
    // count is a relational boundary, so later scalar filters compose in position.
    expect(read('g.inject(1,2,3).count().is(P.gt(2))', { spine: 'legacy' }).sql).toContain('WHERE p.v > ?');
    // Both spines: the filter is inside the counted set, so the WHERE precedes the aggregate.
    for (const spine of ['legacy', 'rel'] as const) {
      const inner = read('g.inject(1,2,3).is(P.gt(1)).count()', { spine }).sql;
      // The filter is inside the counted set. Which aggregate it is differs by SOURCE, not by
      // spine: an injected row carries no multiplicity, so counting rows IS counting traversers.
      expect(inner).toMatch(/count\(\*\)/i);
      expect(inner).toMatch(/WHERE/i);
    }
    // value modifiers. An injected value carries no stored vtype, so the sort key is the value
    // itself on both spines — the compare CASE is only for a per-row-typed property.
    expect(read('g.inject(3,1,2).order()', { spine: 'legacy' }).sql).toContain('ORDER BY p.v ASC');
    // RelIR MINTS the position rather than leaving the order in a clause: an order that is not a
    // column cannot survive a relation boundary, which is what makes a following `tail()`/slice read
    // the same order the root reports.
    expect(read('g.inject(3,1,2).order()', { spine: 'rel' }).sql)
      .toMatch(/row_number\(\) OVER \(ORDER BY \w+\.column1 ASC\) AS encounter FROM \(VALUES/);
    expect(read('g.inject(1,1,2).dedup()', { spine: 'legacy' }).sql).toContain('DISTINCT p.v');
    // RelIR reaches the same DISTINCT over the injected VALUES directly, with no CTE between.
    expect(read('g.inject(1,1,2).dedup()', { spine: 'rel' }).sql).toMatch(/SELECT DISTINCT \w+\.column1 AS v FROM \(VALUES/);
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
    const c = read('g.V().values("age").count()', { spine: 'legacy' });
    expect(c.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(c.sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c1 s');
    // Both spines count the RLE traverser total, not the rows — `values()` carries the multiplicity
    // and a collapse upstream would otherwise be counted away.
    for (const spine of ['legacy', 'rel'] as const) {
      // A SUM and not a COUNT — the spelling of the summed expression differs, because the RelIR
      // assembler fuses the aggregate into its input's block and spells `bulk` as the expression
      // that computes it. What must agree is which aggregate.
      expect(read('g.V().values("age").count()', { spine }).sql).toMatch(/COALESCE\(sum\(/i);
      expect(read('g.V().values("age").count()', { spine }).shape).toEqual({ kind: 'value', type: STATIC('long') });
    }
    // the values() flatMap (now carrying per-row vtype; a collection value → json() text)
    // feeds the count.
    expect(c.sql).toContain("THEN json(vp.value) ELSE vp.value END AS v, vp.vtype AS vtype, p.bulk FROM");
    // intervening scalar-stream modifiers compose through the re-entry
    const dedupCount = read('g.V().values("age").dedup().count()', { spine: 'legacy' }).sql;
    expect(dedupCount).toContain('SELECT DISTINCT p.v AS v');
    expect(dedupCount).toContain('SELECT COUNT(*) AS v FROM c2');
    // Both spines: a dedup DROPS the multiplicity, so the count that follows is COUNT(*). That is
    // not cosmetic — carrying `bulk` through would put it in the DISTINCT key, so the same value at
    // bulk 1 and bulk 3 would survive twice, and a following SUM would count the duplicates it just
    // removed. Invisible on a fixture where bulk is always 1, which is why it is asserted here.
    for (const spine of ['legacy', 'rel'] as const) {
      const sql = read('g.V().values("age").dedup().count()', { spine }).sql;
      expect(sql).toMatch(/count\(\*\)/i);
      expect(sql).not.toMatch(/sum\(/i);
    }
    // Both spines: a dedup DISCARDS the multiplicity (a survivor stands for itself), so the count
    // that follows is COUNT(*) and not SUM(bulk) — the distinction is semantic, not spelling.
    for (const spine of ['legacy', 'rel'] as const) {
      const sql = read('g.V().values("age").dedup().count()', { spine }).sql;
      expect(sql).toMatch(/DISTINCT/i);
      expect(sql).toMatch(/count\(\*\)/i);
      expect(sql).not.toMatch(/sum\([\w.]*bulk\)[^]*count/i);
    }
    expect(read('g.V().out().id().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    // The reducer is another scalar stream, so lowering can continue past it.
    expect(read('g.V().values("age").count().is(P.gt(2))', { spine: 'legacy' }).sql).toContain('WHERE p.v > ?');

    // Element-side policies before the scalar boundary are rendered first, then the
    // projected rows re-enter the same scalar dispatcher. This was the last route
    // through the old one-projection accumulator ceiling.
    const ordered = read('g.V().order().by("age").limit(2).values("name").count()', { spine: 'legacy' });
    expect(ordered.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(ordered.sql).toContain('ORDER BY (SELECT (CASE WHEN vtype IN');
    expect(ordered.sql).toContain('LIMIT 2), c2(v) as (SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c1 s)');
    expect(run(seededStore(), 'g.V().order().by("age").limit(2).values("name").count()').map((r) => r.v))
      .toEqual([2]);
    expect(() => compile('g.V().values("name").id()', {})).toThrow('id() requires element input');
  });

  test('count is a relational scalar boundary and can continue lowering', () => {
    const filtered = read('g.V().values("age").count().is(P.gt(3))', { spine: 'legacy' });
    expect(filtered.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(filtered.sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v');
    expect(filtered.sql).toContain('WHERE p.v > ?');
    // Both spines agree on the RESULT, which is what a boundary that can continue lowering means.
    for (const spine of ['legacy', 'rel'] as const) {
      expect(read('g.V().values("age").count().is(P.gt(3))', { spine }).shape).toEqual({ kind: 'value', type: STATIC('long') });
    }

    const countedAgain = read('g.V().values("age").count().count()');
    expect(countedAgain.shape).toEqual({ kind: 'value', type: STATIC('long') });
    const store = seededStore();
    expect(run(store, 'g.V().values("age").count().is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().values("age").count().count()').map((r) => r.v)).toEqual([1]);
  });

  test('asBool() resolves inject constants at compile time + tags the value shape', () => {
    // The value shape carries `as:'bool'` so the handler frames the 0/1 as Boolean.
    expect(read('g.inject(1).asBool()').shape).toEqual({ kind: 'value', type: STATIC('boolean') });
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
    expect(read('g.inject(1,0).asBool().fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', as: 'boolean' } });
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
    // runtime value → SQL CAST + tag (no compile-time constant). RelIR-routed, so the CAST is asserted
    // per spine: legacy reads a CTE column, RelIR inlines the projection it fused, and the semantic
    // fact — a cast to REAL over the value — is what both must say.
    for (const spine of ['legacy', 'rel'] as const) {
      const f = read('g.V().values("weight").asNumber(GType.FLOAT)', { spine });
      expect(f.shape).toEqual({ kind: 'value', type: STATIC('float') });
      expect(f.sql).toMatch(/CAST\([^]*AS REAL\)/);
      // is(P.typeOf(X)) after a cast is compile-time known (the cast's `as` tag) → the typeOf
      // STATIC-FOLDS to a constant instead of a runtime typeof() test. `1` and `? = ?` are the two
      // spellings of that true — RelIR has no bare boolean literal (§3.2).
      const castTypeOf = read('g.V().values("weight").asNumber(GType.FLOAT).is(P.typeOf(GType.FLOAT))', { spine });
      expect(castTypeOf.sql).toMatch(/WHERE \(?(1|\? = \?)\)?/);
      expect(castTypeOf.sql).not.toContain('typeof(');
    }
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
    expect(read('g.V().math("_").by("age").is(P.gt(30)).count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
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
    expect(read('g.V().format("%{name}").count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
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
    expect(read('g.inject("2023-08-02T00:00:00Z").asDate()').shape).toEqual({ kind: 'value', type: STATIC('datetime') });
    expect(read('g.inject("2023-08-02T00:00:00Z").asDate()').binds).toEqual([Date.parse('2023-08-02T00:00:00Z')]);
    // an offset-bearing ISO string folds into the correct instant
    expect(read('g.inject("2023-08-02T00:00:00-07:00").asDate()').binds).toEqual([Date.parse('2023-08-02T07:00:00Z')]);
    expect(read('g.inject(1694017707000).asDate()').binds).toEqual([1694017707000]);
    // rejects: float epoch, non-ISO string, null (list defers to frontend flattening)
    expect(() => compile('g.inject(1694017709000.1d).asDate()', {})).toThrow("Can't parse");
    expect(() => compile("g.inject('This String is not an ISO 8601 Date').asDate()", {})).toThrow("Can't parse");
    expect(() => compile('g.inject(null).asDate()', {})).toThrow("Can't parse");
    // runtime: an ISO-text property → unixepoch()*1000; an integer/real is already millis
    for (const spine of ['legacy', 'rel'] as const) {
      const rt = read('g.V().values("birthday").asDate()', { spine });
      expect(rt.shape).toEqual({ kind: 'value', type: STATIC('datetime') });
      // ×1000 is the millis conversion; RelIR binds the factor where legacy inlines it (§3.2).
      expect(rt.sql).toMatch(/unixepoch\([^]*\) \* (1000|\?)/);
    }
    // bare asNumber() over a date → its epoch-millis (Long, identity); asDate composes back
    expect(read('g.V().values("birthday").asDate().asNumber().asDate()').shape).toEqual({ kind: 'value', type: STATIC('datetime') });
    // bare asNumber() as the ms-string leg feeding asDate() is allowed; standalone it
    // can't recover a subtype from a runtime value → fail closed (not a silent CAST)
    expect(read('g.V().values("birthday").asNumber().asDate()').shape).toEqual({ kind: 'value', type: STATIC('datetime') });
    expect(() => compile('g.V().values("weight").asNumber()', {})).toThrow('non-date runtime value');
    // an offset-less datetime literal is UTC-normalized (not host-local) so Bun ≡ DO
    // `toContain`, not `toEqual`: legacy FOLDS the offset into the literal (one bind) while RelIR emits
    // the arithmetic (literal + offset), which answers identically — the fold is an optimization a RelIR
    // `Pass` over `Values`+`Lit` owes, not a semantic difference. What is asserted is the instant.
    for (const spine of ['legacy', 'rel'] as const)
      expect(read("g.inject(datetime('2023-08-02T00:00:00')).dateAdd(second, 0)", { spine }).binds)
        .toContain(Date.parse('2023-08-02T00:00:00Z'));
  });

  test('dateAdd(DT.unit, n) / dateDiff(date) — integer millis arithmetic', () => {
    // dateAdd folds n * fixed-width-unit millis; bare or DT.-prefixed unit; negative n
    const base = Date.parse('2023-08-02T00:00:00Z');
    // BOTH spines fold to the resulting instant now, and by the same function: a leading coercion
    // prefix over an inject literal is `foldConstantCoercions`, which RelIR reuses rather than
    // re-expressing — the arms that RAISE (`asNumber`/`asBool`/`asDate`) are why it must happen at
    // compile time, and `dateAdd`/`dateDiff` ride the same prefix.
    for (const spine of ['legacy', 'rel'] as const) {
      expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(DT.hour, 2)", { spine }).binds).toEqual([base + 2 * 3600000]);
      expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(hour, -1)", { spine }).binds).toEqual([base - 3600000]);
    }
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(day, 11)").shape).toEqual({ kind: 'value', type: STATIC('datetime') });
    // only second/minute/hour/day are valid DT units — the grammar rejects the rest
    expect(() => compile("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(month, 1)", {})).toThrow('parse error');
    // dateDiff = self − other → signed Long; literal / constant(datetime) / constant(null)→0. Both
    // spines fold the leading prefix to ONE bind (see dateAdd above), and the EXECUTED answer is the
    // contract either way.
    for (const spine of ['legacy', 'rel'] as const) {
      const d = read("g.inject(datetime('2023-08-02T00:00:00Z')).dateDiff(datetime('2023-08-09T00:00:00Z'))", { spine });
      expect(d.shape).toEqual({ kind: 'value', type: STATIC('long') });
      expect(d.binds).toEqual([-604800000]);
      expect(seededStore().query(d.sql, d.binds).map((r: any) => r.v)).toEqual([-604800000]);
    }
    expect(read("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(constant(datetime('2023-08-01T00:00:00Z')))").binds).toEqual([604800000]);
    // runtime dateDiff against a literal → v − other_ms (the epoch bound as a value)
    const rd = read('g.V().values("birthday").asNumber().asDate().dateDiff(datetime("1970-01-01T00:00Z"))');
    expect(rd.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(rd.binds).toEqual(['birthday', Date.parse('1970-01-01T00:00Z')]); // the values() join key, then the later dateDiff operand
    // A traversal operand is DateDiffStep's TraversalUtil.apply contract: it is a
    // row-boundary child, not a literal-only special case.
    const child = read("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(__.constant(datetime('2023-10-11T00:00:00Z')))");
    expect(child.shape).toEqual({ kind: 'value', type: STATIC('long') });
  });

  // concat(<traversal>) is the `TraversalUtil.apply` child-value contract, NOT format()'s
  // `TraversalUtil.produce`: ConcatStep extends ScalarMapStep (1-in-1-out) and prepare() sets
  // setBulk(1L), so a child can neither drop nor multiply the parent traverser. Relationally that
  // is a LEFT JOIN over the modulation seam at 'first' cardinality. Values are pinned in
  // test/L4-addendum/concat-traversal.feature; here we pin the SQL contract.
  test('concat(<traversal>) resolves each argument through the modulation seam', () => {
    // LEFT JOIN, never INNER: an unproductive child must not filter the traverser.
    const c = read("g.V().values('name').concat(__.constant('X'))");
    expect(c.sql).toContain('LEFT JOIN');
    expect(c.sql).toContain("concat_ws('',");
    // format() over the same seam keeps its INNER join — the two contracts stay distinct.
    expect(read("g.V().values('name').format('%{_}').by(__.constant('X'))").sql).not.toContain('LEFT JOIN');
    // A label-carried child resolves (select('a') re-roots on the carried alias).
    expect(() => compile("g.V().hasLabel('person').values('name').as('a').constant('Mr.').concat(__.select('a'))", {})).not.toThrow();
    // Multiple traversal args concatenate in ARGUMENT order, one modulation column each.
    const two = read("g.V().values('name').concat(__.constant('X'), __.constant('Y'))");
    expect(two.sql).toContain('m0');
    expect(two.sql).toContain('m1');
    // A re-sourced body is input-independent. Its order and slice run per child origin,
    // then the apply contract takes the first value without a concat-specific lowering.
    expect(() => compile("g.inject('hello').concat(__.V().order().by('name').values('name'))", {})).not.toThrow();
    // A nested arg inside an INLINE predicate body must make the fast path DECLINE, not throw —
    // the recognizer's contract is fall-through, so this compiles via the generic gate.
    expect(() => compile("g.V().values('name').as('a').not(__.concat(__.select('a')).is('x'))", {})).not.toThrow();
  });

  test('inject().<scalar transform>() maps to SQLite scalar functions', () => {
    // The whole family is RelIR-routed over an inject source (the CAST subfamily excepted — see
    // rel-spine.test.ts), so each function is asserted per spine on the function itself.
    for (const spine of ['legacy', 'rel'] as const) {
      // concat skips nulls (concat_ws) so an all-null result is null, not '' (Gremlin semantics)
      expect(read('g.inject("a","b").concat("c")', { spine }).sql).toMatch(wraps('concat_ws'));
      expect(read('g.inject("a").length()', { spine }).sql).toMatch(wraps('length'));
      expect(read('g.inject("A").toLower()', { spine }).sql).toMatch(wraps('lower'));
      expect(read('g.inject("a").toUpper()', { spine }).sql).toMatch(wraps('upper'));
      expect(read('g.inject(1).asString()', { spine }).sql).toMatch(/CAST\([^]*AS TEXT\)/);
      expect(read('g.inject("hello").substring(1,8)', { spine }).sql).toMatch(wraps('substr'));
      expect(read('g.inject("that").replace("h","j")', { spine }).sql).toMatch(wraps('replace'));
      // Scope.local on a scalar stream is a no-op (per-element == per-list) — a scalar IS a
      // one-element list, so per-element and per-list are the same question.
      expect(read('g.inject("a").length(Scope.local)', { spine }).sql).toMatch(wraps('length'));
      // Adjacent transforms FUSE into one expression while preserving left-to-right order. RelIR gets
      // that from the block assembler rather than a hand-rolled segment fold, which is the point.
      expect(read('g.inject("a").concat("b").toUpper()', { spine }).sql).toMatch(/upper\(concat_ws\(/);
      // trim family → SQLite trim/ltrim/rtrim over the JAVA-whitespace char set (a bound second arg)
      expect(read('g.inject(" a ").trim()', { spine }).sql).toMatch(/\btrim\([^]*, \?\)/);
      expect(read('g.inject(" a ").lTrim()', { spine }).sql).toMatch(/ltrim\([^]*, \?\)/);
      expect(read('g.inject(" a ").rTrim()', { spine }).sql).toMatch(/rtrim\([^]*, \?\)/);
    }
    // reverse: a string reverses its chars via a RECURSIVE CTE inside an expression, which RelIR has no
    // node for at all (`Recursive` is a relation, not a scalar subquery) — so it stays legacy's, and
    // the decline is a §7 node-set question rather than unfinished work.
    expect(read('g.inject("ab").reverse()').sql).toContain('WITH RECURSIVE rev(');
  });

  test('scalar transforms also wrap an element value projection', () => {
    for (const spine of ['legacy', 'rel'] as const) {
      expect(read("g.V().values('name').substring(2)", { spine }).sql).toMatch(wraps('substr'));
      expect(read("g.V().values('name').toUpper()", { spine }).sql).toMatch(wraps('upper'));
      expect(read("g.V().values('name').concat('X')", { spine }).sql).toMatch(wraps('concat_ws'));
      // chained; is()/order() see the transformed value
      expect(read("g.V().values('name').toUpper().is('MARKO')", { spine }).sql).toMatch(wraps('upper'));
    }
    // transform on a non-scalar projection is rejected (no scalar stream to transform)
    expect(() => compile("g.V().valueMap().toUpper()", {})).toThrow('toUpper() cannot consume the valueMap result shape');
  });

  test('values(k).inject(c) appends constants to the value stream', () => {
    const p = read("g.V().values('age').inject(1000).sum()");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain(`SUM(${eligible('s.v')} * s.bulk)`);
    expect(p.binds).toContain(1000);
    // append before a min() reducer
    expect(read("g.V().values('foo').inject(42).min()").sql).toContain('UNION ALL');
    // rejected on a non-scalar projection (inject-append is a scalar-stream op)
    expect(() => compile("g.V().valueMap().inject(1)", {})).toThrow('inject() cannot consume the valueMap result shape');
  });

  test('limit before count wraps the counted id-relation', () => {
    expect(read('g.V().limit(2).count()', { spine: 'legacy' }).sql)
      .toContain('c1(id, bulk, encounter) as (SELECT p.id, p.bulk, p.encounter FROM c0 p ORDER BY p.encounter LIMIT 2)');
    // The property both spines owe: the count reduces the SLICED relation, so the window is taken
    // before the SUM rather than after it.
    for (const spine of ['legacy', 'rel'] as const) {
      expect(read('g.V().limit(2).count()', { spine }).sql).toMatch(/ORDER BY [\w.]+(?: ASC)? LIMIT (\?|2)/i);
      expect(read('g.V().limit(2).count()', { spine }).sql).toMatch(/COALESCE\(sum\(/i);
    }
  });

  test('inject seeds a VALUES stream', () => {
    const p = read('g.inject(1,2,3)', { spine: 'legacy' });
    // q-kernel built: Query mints the CTE name (unquoted, identifier-safe) + our
    // SQL casing; binds ride as Value tokens (one row each).
    // inject is a ScalarStream source materialized directly from its VALUES relation.
    // The trailing alias is `materializeScalarRoot`'s, and every root carries one now: the ORDER BY
    // that restores emission order (`rootOrder`) needs a name to qualify the carried encounter with,
    // and asking the question uniformly beats aliasing only when the answer turns out to be yes.
    expect(p.sql).toBe('with c0(v) as (VALUES (?), (?), (?)) SELECT v FROM c0 s');
    expect(p.binds).toEqual([1, 2, 3]);
    // RelIR-routed by default, and it emits the SAME `VALUES` — the one construct measured emitting
    // it (§3.3) — with the CTE collapsed into the derived table the framing selects from.
    const viaRel = read('g.inject(1,2,3)', { spine: 'rel' });
    expect(viaRel.sql).toContain('VALUES (?), (?), (?)');
    expect(viaRel.binds).toEqual([1, 2, 3]);
  });

  test('as() threads a synthetic alias column through subsequent CTEs', () => {
    // The LEGACY spelling, pinned explicitly: this chain routes RelIR by default now, and §10·4's rule
    // is that a test pinning a spine's spelling pins BOTH. The RelIR half is below.
    const p = read('g.V().as("a").out("knows").select("a")', { spine: 'legacy' });
    // as('a') appends the current id to label a0's JSONB history array; out() carries a0
    expect(p.sql).toContain("jsonb_array(jsonb_object('k', ?, 'v', p.id)) AS a0, p.bulk FROM c0");
    expect(p.sql).toContain('SELECT e.tgt AS id, p.a0, p.bulk FROM edges e');
    // select retypes the alias to a fresh element stream (last id out of history), then root framing rejoins it.
    expect(p.sql).toContain('SELECT CAST(p.a0 ->> ? AS INTEGER) AS id, p.a0, p.bulk FROM c2 p');
    expect(p.sql).toContain('JOIN c3 p ON n.id=p.id');
    expect(p.shape).toEqual({ kind: 'vertex' });
    // RelIR writes the IDENTICAL history encoding — `SHAPE_K` is imported rather than restated, which
    // is what makes that a property of the code and not of this assertion — and reads it back with
    // `json_extract` rather than `->>` so the node set stays closed (§3.3). Same shape, same rows.
    const viaRel = read('g.V().as("a").out("knows").select("a")', { spine: 'rel' });
    expect(viaRel.spine).toBe('rel');
    expect(viaRel.sql).toContain("jsonb_array(jsonb_object('k', ?, 'v', ");
    expect(viaRel.sql).toContain("CAST(json_extract(");
    expect(viaRel.shape).toEqual(p.shape);
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
      { key: 'a', prefix: 'e0', sub: 'value', type: PER_ROW('e0_vtype') },
      { key: 'b', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
    ] });
    const cyc = read('g.V().as("a").out().as("b").select("a","b").by("age").by("name")');
    // e0 uses by('age'), e1 uses by('name')
    expect(cyc.sql).toContain('AS e0_vtype');
    expect(cyc.sql).toContain('AS e1_vtype');
  });

  test('project() applies by mods to the current traverser under fresh keys', () => {
    const p = read('g.V().project("n","a").by("name").by("age")');
    expect(p.shape).toEqual({ kind: 'map', entries: [
      { key: 'n', prefix: 'e0', sub: 'value', type: PER_ROW('e0_vtype') },
      { key: 'a', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
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
        { key: 'name', prefix: 'e0', sub: 'value', type: PER_ROW('e0_vtype') },
        { key: 'friend', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
      ],
    });
    expect(p.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(p.sql).not.toContain(' AS o1');
    expect(p.sql).toContain('JOIN c');
    expect(p.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V().project("friend").by(__.out().values("name")).select("friend")').shape)
      .toEqual({ kind: 'value', type: PER_ROW('e0_vtype') });
    const mixed = read('g.V().project("name","degree").by("name").by(__.out().count())');
    expect(mixed.sql).toContain('SELECT value FROM vertex_properties WHERE node=p0.id AND key=?');
    expect(mixed.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V().project("id","friend").by(T.id).by(__.out().values("name"))').shape.kind).toBe('map');
    const element = read('g.V(1).project("self","friend").by().by(__.out().values("name"))');
    expect(element.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'self', prefix: 'e0', sub: 'vertex' },
        { key: 'friend', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
      ],
    });
    expect(element.sql).toContain('b0.rid AS e0_rid');
    expect(element.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V(1).project("self","friend").by().by(__.out().values("name")).select("self").out().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
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
      .toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V(1).project("friends","created").by(__.out().values("name").fold()).by(__.out("created").values("name").fold()).select(Column.values).unfold()').shape)
      .toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    expect(read('g.V(1).as("a").out().select("a").by(__.out()).values("name")').shape)
      .toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('multi-select traversal fields re-root generic children on each labelled element', () => {
    const selected = read('g.V(1).as("a").out("knows").as("b").select("a","b").by(__.out().count()).by(__.values("name"))');
    expect(selected.shape).toEqual({
      kind: 'map',
      entries: [
        { key: 'a', prefix: 'e0', sub: 'value', type: STATIC('long') },
        { key: 'b', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
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
        { key: 'b', prefix: 'e1', sub: 'value', type: STATIC('long') },
      ],
    });
  });

  test('order() on a record stream sorts by a by(__.select(field)) modulator', () => {
    const p = read("g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).select('a')");
    expect(p.shape).toEqual({ kind: 'value', type: PER_ROW('e0_vtype') });
    // the order CTE sorts the record rows by field b's value column, descending
    expect(p.sql).toContain('ORDER BY r.e1_v DESC');
    // a following limit fuses into the same ORDER BY query (LIMIT after the sort)
    const lim = read("g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).limit(2).select('a')");
    expect(lim.sql).toContain('ORDER BY r.e1_v DESC LIMIT 2');
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
      .toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().as("a").out().as("b").select("a","b").select("b").out().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().project("n","a").by("name").by("age").select(Column.values).unfold().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().project("n","a").by("name").by("age").select(Column.keys).unfold().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().project("n","a").by("name").by("age").limit(Scope.local,1)').shape)
      .toEqual({ kind: 'map', entries: [{ key: 'n', prefix: 'e0', sub: 'value', type: PER_ROW('e0_vtype') }] });
    expect(read('g.V().project("n","a").by("name").by("age").tail(Scope.local,1)').shape)
      .toEqual({ kind: 'map', entries: [{ key: 'a', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') }] });
  });

  test('dedup().by() is a windowed modulation-key consumer with explicit encounter order', () => {
    const store = seededStore();
    // Legacy's spelling — RelIR covers this chain now and says the same thing with `row_number()`
    // over the channel it minted, which `test/rel-spine.test.ts` compares row-for-row. What is worth
    // keeping here is the SEMANTIC fact both must have: the survivor per key is the FIRST in the
    // emission order, not the lowest id, which is the defect the census caught when RelIR first took
    // this chain and ranked by id.
    const ordered = read('g.V().order().by("name",desc).barrier().dedup().by("age").values("name")', { spine: 'legacy' });
    expect(ordered.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(ordered.sql).toContain('AS encounter');
    expect(read('g.V().order().by("name",desc).barrier().dedup().by("age").values("name")', { spine: 'rel' }).sql)
      .toMatch(/row_number\(\) OVER \(PARTITION BY [^]*ORDER BY \w+\.encounter ASC, \w+\.id ASC\)/);
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
    expect(read('g.V().order().by(__.out().count()).values("name")', { spine: 'legacy' }).sql).toContain('ROW_NUMBER() OVER');
    // RelIR answers this one now (the by()-traversal child seam's movement+reducer arm) and spells the
    // window in the emitter's own case. The ORDER is asserted spine-neutrally above; this pins that the
    // route still ranks in a window rather than folding the child into the framing ORDER BY.
    if (!relirOff)
      expect(read('g.V().order().by(__.out().count()).values("name")', { spine: 'rel' }).sql)
        .toMatch(/row_number\(\) OVER/i);
  });

  test('a canonicalized empty child remains identity in the generic scalar existence gate', () => {
    const store = seededStore();
    // The inner where is inert because count() always emits. Its removal leaves an
    // empty nested body, which is Gremlin identity — including when it sits inside
    // another scalar where() whose inline predicate fast path is disabled.
    const query = 'g.V(1).id().where(__.where(__.is(P.gt(0)).count()))';
    expect(runWith(store, query, { fastPaths: { scalarPredicateInlining: false } }).map((r) => r.v)).toEqual([1]);
  });

  test('an element child re-enters ordinary lowering after a scoped dedup barrier', () => {
    const store = seededStore();
    const query = 'g.V(1).where(__.out().dedup().hasLabel("person")).values("name")';
    expect(runWith(store, query, { fastPaths: { predicateInlining: false } }).map((r) => r.v)).toEqual(['marko']);
  });

  test('fold() wraps the projection in a list shape (element or scalar)', () => {
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    expect(read('g.V(1).outE().fold()').shape).toEqual({ kind: 'list', elem: 'edge' });
  });

  test('sum() wraps a value stream in SQL SUM → scalar shape', () => {
    const p = read('g.V().values("age").sum()', { spine: 'legacy' });
    expect(p.shape).toEqual({ kind: 'scalar' });
    expect(p.sql).toContain(`SELECT SUM(${eligible('s.v')} * s.bulk) AS v, typeof(SUM(${eligible('s.v')} * s.bulk)) AS vt FROM`);
    // RelIR states the same three facts — the aggregate, the BULK weighting, and the dynamic `vt`
    // column reading the result's own storage class — with the value inlined rather than aliased.
    const rel = read('g.V().values("age").sum()', { spine: 'rel' });
    expect(rel.shape).toEqual({ kind: 'scalar' });
    expect(rel.sql).toMatch(/sum\(\(CASE WHEN \(\w+\.type_space = \?\) THEN \w+\.compare END \* \w+\.bulk\)\) AS v/);
    expect(rel.sql).toMatch(/ELSE typeof\(sum\([^]*END AS vt/);
    expect(rel.binds).toContain('__mogwai_reducer_error:sum() integer overflow');
  });

  test('numeric reducers are scalar streams and preserve dynamic type past filters', () => {
    const summed = read('g.V().values("age").sum().is(P.gt(100))', { spine: 'legacy' });
    expect(summed.shape).toEqual({ kind: 'scalar' });
    expect(summed.sql).toContain(`SUM(${eligible('s.v')} * s.bulk) AS v`);
    expect(summed.sql).toContain('p.vt AS vt');
    expect(summed.sql).toContain('WHERE p.v > ?');
    // A filter over a REDUCED value is a `HAVING` on the RelIR side — one of §3's declared collapses,
    // and the same question legacy asks with a CTE plus a WHERE. Both keep the dynamic `vt` column.
    const summedRel = read('g.V().values("age").sum().is(P.gt(100))', { spine: 'rel' });
    expect(summedRel.shape).toEqual({ kind: 'scalar' });
    // The HAVING now carries the comparability guard (§13a): a numeric bound compares only where the
    // aggregate's own storage class is numeric, else FALSE. So what is pinned is that the filter became a
    // HAVING over the aggregate — not the shape of the comparison inside it.
    expect(summedRel.sql).toMatch(/HAVING [^]*sum\(/);
    expect(summedRel.sql).toMatch(/ AS vt/);

    const store = seededStore();
    expect(run(store, 'g.V().values("age").sum().is(P.gt(100))').map((r) => r.v)).toEqual([123]);
    expect(run(store, 'g.V().values("age").asNumber(GType.DOUBLE).sum()').map((r) => r.v)).toEqual([123]);
  });

  test('scalar row operators lower left-to-right instead of commuting through a tail accumulator', () => {
    const p = read('g.V().values("age").count().limit(1).is(P.gt(3))', { spine: 'legacy' });
    expect(p.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(p.sql).toContain('LIMIT 1');
    expect(p.sql).toContain('WHERE p.v > ?');
    expect(p.sql.indexOf('LIMIT 1')).toBeLessThan(p.sql.indexOf('WHERE p.v > ?'));
    // The ORDER is the point, on either spine: a slice then a filter, never the reverse — which is
    // what "left-to-right instead of commuting through a tail accumulator" means.
    for (const spine of ['legacy', 'rel'] as const) {
      const sql = read('g.V().values("age").count().limit(1).is(P.gt(3))', { spine }).sql;
      expect(sql.search(/LIMIT/i)).toBeLessThan(sql.search(/WHERE/i));
    }

    const store = seededStore();
    expect(run(store, 'g.V().values("age").count().limit(1).is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().values("age").count().limit(0).is(P.gt(3))')).toEqual([]);
  });

  test('scalar transforms lower relationally and feed later filters/reducers', () => {
    // Both spines FUSE a transform run into one SELECT, and both must place a predicate at the position
    // it was WRITTEN: `tx().is().tx()` stays ordered even with no CTE between, because the predicate
    // captures the expression visible where it sits. That ordering is the semantic fact; the aliases are
    // not. Legacy fuses via `fuseScalarSegment`, RelIR via the block assembler — one per spine.
    for (const spine of ['legacy', 'rel'] as const) {
      const transformed = read('g.V().values("name").toUpper().is("MARKO")', { spine });
      expect(transformed.sql).toMatch(/upper\([^]*\) AS v/);
      expect(transformed.sql).toMatch(/WHERE \(?upper\([^]*\) = \?\)?/);

      const fused = read('g.V().values("name").toLower().is(P.neq("x")).toUpper()', { spine });
      // the OUTER transform wraps the inner one — left-to-right order preserved through the fusion
      expect(fused.sql).toMatch(/upper\(lower\(/);
      // …and the predicate sees the value as it was at ITS position: `lower`, never `upper(lower(…))`.
      // `neq` is now total over NULL (§13a): `(x = ?) IS NOT ?` rather than `x != ?`, because negating
      // SQL NULL must be TRUE where TinkerPop's two-valued `test` says so. Either spelling is the
      // predicate; the POINT of this assertion is that its subject is `lower(…)` and not `upper(lower(…))`.
      expect(fused.sql).toMatch(/WHERE \(*lower\([^]*\)( != \?|( = \?\)? IS NOT \?))/);
      expect(fused.sql).not.toMatch(/WHERE \(?upper\(/);
    }
    expect(read('g.V().values("name").toLower().is(P.neq("x")).toUpper()', { spine: 'legacy' }).sql).not.toContain('FROM c2 p)');

    // A keyed/bare order() re-establishes determinism, so the following slice needs no emission
    // encounter from the demand pass — legacy fuses order()+range() into one ORDER BY … LIMIT …
    // OFFSET. RelIR instead MINTS the position at the order() and the slice reads that COLUMN, which
    // is what lets the same slice serve a `tail()` and a movement afterwards; the compare key is then
    // spelled ONCE instead of once per clause reader.
    expect(read('g.V().values("age").order().range(1,3)', { spine: 'legacy' }).sql)
      .toContain('ELSE p.v END) ASC LIMIT 2 OFFSET 1');
    const relSlice = read('g.V().values("age").order().range(1,3)', { spine: 'rel' });
    expect(relSlice.sql).toMatch(/row_number\(\) OVER \(ORDER BY CASE WHEN [^]*ELSE \w+\.v END ASC\) AS encounter/);
    expect(relSlice.sql).toMatch(/ORDER BY \w+\.encounter ASC LIMIT \? OFFSET \?/);

    const typedSum = read('g.V().values("age").asNumber(GType.DOUBLE).sum().is(P.gt(100))');
    expect(typedSum.shape).toEqual({ kind: 'scalar' });
    // The cast is inside the reducer's eligibility guard on the RelIR side (the transform is fused into
    // the aggregate's argument), so what both spines must say is that the value was cast to REAL before
    // being summed — not where the cast sits in the select list.
    expect(typedSum.sql).toMatch(/CAST\([^]*AS REAL\)/);
    // …and the sum is BULK-WEIGHTED over an element source, whichever spine emits it.
    expect(typedSum.sql).toMatch(/(SUM|sum)\([^]*\* \w+\.bulk\)\)? AS v/);

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
    // group() fills a key slot then a value slot; a third by() is invalid Gremlin, refused with
    // GroupStep's own wording by the byModulatorArity verify Pass (test/compiler/by-modulator-arity).
    expect(() => compile('g.V().group().by("name").by("age").by("x")', {})).toThrow('already been set');
    expect(read('g.V().count().fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', as: 'long' } });
    expect(() => compile('g.V().sum()', {})).toThrow('sum() of vertex not yet supported');
  });
});
