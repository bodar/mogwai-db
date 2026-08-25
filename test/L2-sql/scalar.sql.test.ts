// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, SCALAR_MEMBERS, STATIC, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { executeQuery } from '../support/executor.ts';
import { decode, decodeAll } from '../support/decode.ts';
import { read, run, runWith, seededStore, storeSeededWith } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

// Every GLOBAL numeric reducer goes through the one reducer-eligibility policy — the same text the
// group-scoped reducers already emit. Named here so an assertion below says WHICH reducer it
// pins instead of restating 60 characters of CASE. min/max range over text too (TinkerPop 4
// Strings are Comparable); sum/mean are numeric-only.

// A transform pin's semantic fact is WHICH SQLite function wraps the traverser's value — the lowering
// inlines the projection it fused into the same SELECT, and the assertion must survive that spelling
// (test/CLAUDE.md: snapshots assert semantic equivalence, not byte identity).

// A one-value inject const-folds its seed to a COMPILE-TIME CONSTANT, inlined as a typed SQL literal
// rather than a bound `?` (the parameter-budget win: a constant the compiler holds spends none of the
// DO's 100 binds — docs/archive/2026-08-05-parameters-are-the-only-binds.md). So a const-fold test asserts the
// inlined VALUE here instead of on `.binds`: `1`/`0` for a boolean, epoch-millis for a date, and so on.

describe('scalar-parent / projection SQL', () => {










  test('fold preserves uniform scalar item types through ListStream materialization', async () => {
    const typed = read('g.V().values("age").asNumber(GType.DOUBLE).fold()');
    expect(typed.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', type: STATIC('double'), productiveNull: false } });

    const { ioc } = await import('../../src/io.ts');
    const doubles = executeQuery(seededStore(), 'g.V().values("age").asNumber(GType.DOUBLE).fold()', {})[0];
    // LIST header (type+flag) + bare length (4 bytes), then the first qualified item.
    expect(doubles[6]).toBe(ioc.DataType.DOUBLE);
    expect(((await decode(doubles)) as number[]).sort((a: number, b: number) => a - b)).toEqual([27, 29, 32, 35]);

    const ints = executeQuery(new GraphStore(new BunSqlite(':memory:')), 'g.inject("1",2,"3",4).asNumber().fold()', {})[0];
    expect(ints[6]).toBe(ioc.DataType.INT);
    expect(await decode(ints)).toEqual([1, 2, 3, 4]);
  });

  test('bare asNumber() over a known-numeric/datetime stream is the reference identity', async () => {
    // `AsNumberStep.map` returns a `Number` UNCHANGED and a `Date`/`OffsetDateTime` as its epoch-milli
    // Long (`vendor/tinkerpop/.../map/AsNumberStep.java:57-72`). Over a runtime stream already framed
    // numeric or datetime it therefore needs no cast and cannot raise — the value is the same, only the
    // tag moves (datetime → long). A bare `asNumber()` over an UNTYPED property still declines (it could
    // meet a non-numeric value it must RAISE on, which SQL cannot do — the runtime-guard increment).
    expect(read('g.V().count().asNumber()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().values("birthday").asDate().asNumber()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(() => read('g.V().values("age").asNumber()')).toThrow(UnsupportedTraversal);

    // The round-trip the reference pins (AsDate.feature `g_V_valuesXbirthdayX_asDate_asNumber_asDate`):
    // a date → asDate (datetime) → asNumber (long millis) → asDate recovers the original instant.
    const store = storeSeededWith([
      'g.addV("person").property("name","alice").property("birthday","2020-08-02").' +
        'addV("person").property("name","suzy").property("birthday","1965-10-31")',
    ]);
    const round = await decodeAll(executeQuery(store, 'g.V().values("birthday").asDate().asNumber().asDate()', {}));
    expect(round.every((v) => v instanceof Date)).toBe(true);
    expect(round.map((v: Date) => v.toISOString()).sort())
      .toEqual(['1965-10-31T00:00:00.000Z', '2020-08-02T00:00:00.000Z']);
  });

  test('asBool() over a known-numeric/boolean stream is the reference identity (guard-free)', async () => {
    // `AsBoolStep.map` (`vendor/tinkerpop/.../map/AsBoolStep.java:38-54`): a Boolean is itself, a Number
    // is `NaN → false else != 0`. Both are SQL-total, so over a runtime stream framed numeric or boolean
    // this needs no guard. A String parses `true`/`false` and RAISES otherwise — SQL cannot, so an
    // UNTYPED property still declines to the runtime-guard increment. `NaN != 0` is not-true in SQLite,
    // which gives `NaN → false` for free.
    expect(read('g.V().count().asBool()').shape).toEqual({ kind: 'value', type: STATIC('boolean') });
    expect(() => read('g.V().values("age").asBool()')).toThrow(UnsupportedTraversal);

    // AsBool.feature `g_VXX_localX_outE_countX_asBool` over the modern graph: outE().count() != 0 per
    // vertex → marko/josh/peter true, vadas/lop/ripple false.
    const bools = await decodeAll(executeQuery(seededStore(), 'g.V().local(__.outE().count()).asBool()', {}));
    expect(bools).toEqual([true, false, false, true, false, true]);
  });

  test('dateDiff() over a constant(datetime|null) nested operand folds to a millis subtraction', async () => {
    // The other operand resolves to a millis CONSTANT: a datetime literal, or a `constant(datetime)`/
    // `constant(null)` nested traversal (`dateDiffOtherMs` owns `constant(null)` → epoch 0, `new
    // Date(null)`). Reused rather than re-parsed here (the §2 boundary). A datetime LITERAL operand
    // already worked; the nested-constant form is what lands. All fold to zero binds.
    for (const g of [
      'g.V().values("birthday").asDate().dateDiff(__.constant(null))',
      'g.V().values("birthday").asDate().dateDiff(datetime("1970-01-01T00:00Z"))',
    ]) expect(read(g).binds.length, g).toBe(0);

    // DateDiff.feature `g_V_hasXname_aliceX_valuesXbirthdayX_asDate_dateDiffXconstantXnullXX`:
    // dateDiff(null) is dateDiff(epoch 0), so the answer is the birthday millis itself.
    const store = storeSeededWith(['g.addV("person").property("name","alice").property("birthday",1596326400000)']);
    const r = await decodeAll(executeQuery(store,
      'g.V().has("name","alice").values("birthday").asDate().dateDiff(__.constant(null))', {}));
    expect(r).toEqual([1596326400000]);
  });

  test('inject([...]) is a real list value (not flattened)', () => {
    // Each bracket arg is ONE list traverser → a JSONB list-value stream.
    expect(read('g.inject([1,3,100,300])').shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
    expect(read('g.inject([1,2],[3,4])').shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
    // unfold() explodes the list back to a scalar stream.
    expect(read('g.inject([1,2,3]).unfold()').shape).toEqual({ kind: 'value', type: UNKNOWN });
    // Scope.local reducers act per-list (mean over the numeric elements → Double).
    expect(read('g.inject([null,10,20,null]).mean(Scope.local)').shape).toEqual({ kind: 'scalar', productiveNull: false });
    // none(P) on a LIST keeps the list iff no element matches (collection filter).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').sql).toContain('NOT EXISTS');
    // none(pred) is NOT the iterate discard-marker (only a bare none() is stripped).
    expect(read('g.inject([5,8,10],[10,7]).none(P.lt(7))').shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
  });










  test('math("<formula>") compiles to one Double scalar; leaves coerced to REAL', () => {
    // The lexer, the precedence climb, the function NAME set and the three expansions that are SQL
    // FACTS rather than operator names live once in `src/gremlin/math.ts`; the lowering supplies only
    // the construction primitives (`relMathOps`). `log`→`LN`, `cbrt`'s sign split and `signum`'s
    // three-way CASE are non-derivable facts, which is why they live in one place. Spelling is
    // deliberately NOT pinned (§5); each `toContain` is a semantic claim about what the formula
    // compiled TO.
    {
      // `_` resolves through the by() modulator; result always tagged Double.
      const p = read('g.V().math("_+_").by("age")');
      expect(p.shape).toEqual({ kind: 'value', type: STATIC('double') });
      // a leaf is coerced to REAL, so `math()` is all-double arithmetic whatever the column holds
      expect(p.sql).toContain('AS REAL)');
      // a missing by() value makes the arithmetic NULL → the traverser is filtered
      expect(p.sql.toLowerCase()).toContain('is not null');
      // `0-_` (subtraction-based negation) on an edge property
      expect(read('g.V().outE().math("0-_").by("weight")').sql).toContain('(0.0 - CAST(');
      // integer literals emit REAL form so `/` is real division, not SQLite integer div
      expect(read('g.V().math("_ / 2").by("age")').sql).toContain('/ 2.0)');
      // `^` → POW, `%` → MOD (SQLite `%` truncates operands to int)
      expect(read('g.V().math("_ ^ 2").by("age")').sql).toContain('POW(');
      expect(read('g.V().math("_ % 10").by("age")').sql).toContain('MOD(');
      // functions: parenthesised call and juxtaposition; exp4j `log` → natural log (LN)
      expect(read('g.V().math("ceil(_ * 100)").by("age")').sql).toContain('CEIL((');
      expect(read('g.V().math("sin _").by("age")').sql).toContain('SIN(');
      expect(read('g.V().math("log _").by("age")').sql).toContain('LN(');
      // cbrt and signum split on sign — cbrt because POW domain-errors on a negative base with a
      // fractional exponent, signum because SQLite has no builtin for it at all.
      expect(read('g.V().math("cbrt(_)").by("age")').sql).toContain('CASE WHEN');
      expect(read('g.V().math("signum(_)").by("age")').sql).toContain('CASE WHEN');
      // math is a relational producer; a later barrier is dispatched independently.
      expect(read('g.V().math("_").by("age").is(P.gt(30)).count()').shape)
        .toEqual({ kind: 'value', type: STATIC('long') });
    }
  });

















  test('project() builds one map value per row from correlated field reads — RelIR', () => {
    const p = read('g.V().project("n","a").by("name").by("age")');
    expect(p.kind).toBe('read');
    expect(p.shape).toEqual({ kind: 'mapValue' });
    // Each field is a correlated read of the CURRENT traverser (`rn.id`), and the pairs array carries
    // the key beside the value's own `{t,v}` node — the same encoding `group()` emits.
    expect(p.sql).toContain("json_array('n', json_object('t'");
    expect(p.sql).toContain("json_array('a', json_object('t'");
    expect(p.sql).toContain("rp3.key = 'name'");
    expect(p.sql).toContain("rp17.key = 'age'");
    // BOTH fields are droppable (a property `by()` can be unproductive), so the array is ACCUMULATED
    // rather than spelled as one `json_array(pair, pair)` — an absent key is omitted, never null.
    expect(p.sql).toContain('json_insert');
  });


  /**
   * `select(keys…)` AT EVERY ARITY — ONE lowering, and the RECORD substrate is what made the
   * multi-label form cost nothing beyond the arity difference.
   *
   * Row-for-row spelling is not the assertion here: a property `by()` carries the label's stored
   * `vtype` beside the value. So these assert the ANSWER, decoded, and against the reference's
   * semantics.
   */
  test('select() at every arity is one lowering — RelIR', () => {
    const store = seededStore();
    const entries = (row: any): [string, any][] =>
      (JSON.parse(row.map) as [string, any][]).map(([k, v]) => [k, v && typeof v === 'object' && 't' in v
        ? (v.t === 'vertex' || v.t === 'edge' ? v.v.props.name[0].v : v.v) : v]);

    // ONE key with a `by()` — `SelectOneStep`: the label's value, then the by() applied to IT. The
    // stored `vtype` rides along, which is what keeps a selected uuid/datetime exact at the wire.
    const one = read("g.V().as('a').out().select('a').by('name')");
    expect(one.kind).toBe('read');
    expect(one.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(runWith(store, "g.V().as('a').out().select('a').by('name')").map((r) => r.v).sort())
      .toEqual(['josh', 'josh', 'marko', 'marko', 'marko', 'peter']);

    // SEVERAL keys — `SelectStep`: a RECORD, whose by() ring applies to what each label held rather
    // than to the current traverser. So this is two property reads off two different elements.
    const many = read("g.V().as('a').out().as('b').select('a','b').by('name')");
    expect(many.kind).toBe('read');
    expect(many.shape).toEqual({ kind: 'mapValue' });
    expect((runWith(store, "g.V().as('a').out().as('b').select('a','b').by('name')") as any[])
      .map(entries).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))))
      .toEqual([
        [['a', 'josh'], ['b', 'lop']], [['a', 'josh'], ['b', 'ripple']],
        [['a', 'marko'], ['b', 'josh']], [['a', 'marko'], ['b', 'lop']], [['a', 'marko'], ['b', 'vadas']],
        [['a', 'peter'], ['b', 'lop']],
      ]);
    // A bare multi-label select packages the ELEMENTS themselves — the field keeps the rowid, so the
    // record's value side is a `{t:'vertex', …}` member and not a re-derived payload.
    expect((runWith(store, "g.V(1).as('a').out('knows').as('b').select('a','b')") as any[])
      .map(entries)).toEqual([[['a', 'marko'], ['b', 'vadas']], [['a', 'marko'], ['b', 'josh']]]);

    // AN UNPRODUCTIVE by() DROPS THE TRAVERSER, which is `select()`'s rule and the exact OPPOSITE of
    // `project()`'s (which omits the key and keeps it). The reference expects FOUR rows, without lop
    // and ripple (Select.feature:844-847).
    expect((runWith(store, 'g.V().as("a","n").select("a","n").by("age").by("name")') as any[])
      .map(entries)).toEqual([
        [['a', 29], ['n', 'marko']], [['a', 27], ['n', 'vadas']],
        [['a', 32], ['n', 'josh']], [['a', 35], ['n', 'peter']],
      ]);
    // …and `ProductiveByStrategy` turns the drop off, at BOTH arities.
    expect(runWith(store, 'g.withStrategies(ProductiveByStrategy).V().as("a").select("a").by("age")')
      .map((r) => r.v)).toEqual([29, 27, null, 32, null, 35]);
  });

  test('a record FIELD re-enters as a stream of its own shape — RelIR', () => {
    // The whole point of carrying fields as columns: `select(key)` is a RENAME, so whichever tail
    // loop owns the field's framing takes the rest of the chain and nothing is decoded back out of a
    // blob. A value field re-roots to a VALUE stream…
    const degree = read('g.V().project("degree").by(__.out().count()).select("degree")');
    expect(degree.kind).toBe('read');
    expect(degree.shape).toEqual({ kind: 'value', type: STATIC('long') });
    // …a PROPERTY field keeps the stored type it was read with…
    expect(read('g.V().project("n").by("name").select("n")').shape)
      .toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // …and an ELEMENT field to a vertex stream, which then moves and reduces like any other.
    expect(read('g.V(1).project("self","degree").by().by(__.out().count()).select("self")').shape)
      .toEqual({ kind: 'vertex' });
    expect(read('g.V(1).project("self","degree").by().by(__.out().count()).select("self").out().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
    // A `count()` field keeps its Gremlin LONG: the child seam reports the reducer's own framing
    // rather than handing back a bare expression for the wire to guess at (§6·7).
    expect(read('g.V().project("degree").by(__.out().count())').sql).toContain("'t', 'long'");
  });





  test('order() on a record executes: sort by a projected count, then extract a field', () => {
    const store = seededStore();
    // lop is created by marko/josh/peter (in-count 3), ripple by josh only (1)
    expect(run(store, "g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b'), Order.desc).select('a')").map((r) => r.v))
      .toEqual(['lop', 'lop', 'lop', 'ripple']);
    expect(run(store, "g.V().out('created').project('a','b').by('name').by(__.in('created').count()).order().by(__.select('b')).select('a')").map((r) => r.v))
      .toEqual(['ripple', 'lop', 'lop', 'lop']);
  });







  test('an element child re-enters ordinary lowering after a scoped dedup barrier', () => {
    const store = seededStore();
    const query = 'g.V(1).where(__.out().dedup().hasLabel("person")).values("name")';
    expect(runWith(store, query, { fastPaths: { predicateInlining: false } }).map((r) => r.v)).toEqual(['marko']);
  });






});
