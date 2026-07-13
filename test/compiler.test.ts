import { test, expect, describe } from 'bun:test';
import { compile } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { seedModern } from './conformance/seed-modern.ts';

// ---------- L2: SQL snapshots (canonical string -> SQL + binds + shape) ----------

const read = (q: string) => {
  const p = compile(q, {});
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

describe('compiler SQL snapshots', () => {
  test('valueMap variants set shape, reuse the vertex row source', () => {
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', keys: null, tokens: false });
    expect(read('g.V().valueMap(true)').shape).toEqual({ kind: 'valueMap', keys: null, tokens: true });
    expect(read('g.V().valueMap("name","age")').shape).toEqual({ kind: 'valueMap', keys: ['name', 'age'], tokens: false });
    expect(read('g.V().elementMap()').shape).toEqual({ kind: 'elementMap', keys: null });
  });

  test('order().by(key[, dir]) folds ORDER BY into the projection select', () => {
    const asc = read('g.V().hasLabel("person").order().by("age").values("name")');
    expect(asc.sql).toContain("ORDER BY json_extract(n.props, '$.age') ASC");
    expect(asc.binds).toEqual(['person']); // name/age spliced as literal paths

    const desc = read('g.V().hasLabel("person").order().by("age",desc).values("name")');
    expect(desc.sql).toContain("ORDER BY json_extract(n.props, '$.age') DESC");
  });

  test('values().order() sorts the projected scalar', () => {
    const p = read('g.V().values("age").order()');
    expect(p.sql).toContain('ORDER BY v ASC');
    expect(p.shape).toEqual({ kind: 'value' });
  });

  test('range/skip become LIMIT/OFFSET tail modifiers under order()', () => {
    expect(read('g.V().order().by("age").range(1,3).values("name")').sql).toContain('LIMIT 2 OFFSET 1');
    expect(read('g.V().order().by("age").skip(1)').sql).toContain('LIMIT -1 OFFSET 1');
  });

  test('range/skip/limit compose as CTEs when no order() is present', () => {
    expect(read('g.V().range(1,3)').sql).toContain('SELECT p.id FROM c0 p LIMIT 2 OFFSET 1');
    expect(read('g.V().skip(2)').sql).toContain('SELECT p.id FROM c0 p LIMIT -1 OFFSET 2');
  });

  test('illegal range is rejected', () => {
    expect(() => compile('g.V().range(2,1)', {})).toThrow('Not a legal range: [2, 1]');
  });

  test('hasId filters on the external id (COALESCE(uid,id))', () => {
    const one = read('g.V().hasId(1)');
    expect(one.sql).toContain('COALESCE(n.uid, n.id) in (?)');
    expect(one.binds).toEqual([1]);
    const many = read('g.V().hasId(1,2)');
    expect(many.sql).toContain('COALESCE(n.uid, n.id) in (?, ?)');
    expect(many.binds).toEqual([1, 2]);
    // nulls dropped from the set; predicate arg passes through
    expect(read('g.V().hasId(1,null)').binds).toEqual([1]);
    expect(read('g.V().hasId(P.neq(1))').sql).toContain('COALESCE(n.uid, n.id) != ?');
    // empty within/without fold to constants, not the SQLite-illegal `IN ()`
    expect(read('g.V().hasId(P.within([]))').sql).toContain('WHERE 0');
    expect(read('g.V().not(__.hasId(P.within([])))').sql).toContain('NOT COALESCE');
  });

  test('P.typeOf maps GType to a SQL typeof() test', () => {
    // value stream + is(): typeof over the projected scalar expr; type binds as ?
    const str = read('g.V().values("name").is(P.typeOf(GType.STRING))');
    expect(str.sql).toContain("typeof(json_extract(n.props, '$.name')) = ?");
    expect(str.binds).toContain('text');
    expect(read('g.V().values("age").is(P.typeOf(GType.INT))').binds).toContain('integer');
    // java class-name string form is equivalent
    expect(read('g.V().values("name").is(P.typeOf("String"))').binds).toContain('text');
    // has(): typeof over the property expression
    expect(read('g.V().has("name", P.typeOf(GType.STRING))').sql).toContain("typeof(json_extract(n.props, '$.name'))");
    // NULL → is-null; recognized-but-unrepresentable type → constant false
    expect(read('g.V().values("age").is(P.typeOf(GType.NULL))').sql).toContain('is null');
    expect(read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))').sql).toMatch(/\b0\b/);
    // P.not wraps and negates the inner predicate
    expect(read('g.V().values("age").is(P.not(P.typeOf(GType.STRING)))').sql).toContain('NOT (typeof(');
    // an unregistered type name raises
    expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {})).toThrow('unregistered type');
  });

  test('min/max/mean reduce over numeric values only', () => {
    const mn = read('g.V().values("age").min()');
    expect(mn.sql).toContain("typeof(v) in ('integer', 'real')"); // non-numeric filtered out → empty
    expect(mn.sql).toContain('MIN(v)');
    expect(mn.shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").max()').sql).toContain('MAX(v)');
    // mean is always a Double (forced vt='real')
    const avg = read('g.V().values("age").mean()');
    expect(avg.sql).toContain('AVG(v)');
    expect(avg.sql).toContain("'real' AS vt");
    // Scope.local / a step after the reducer defer cleanly
    expect(() => compile('g.V().values("age").fold().min(Scope.local)', {})).toThrow('step not implemented after fold(): min()');
  });

  test('inject() is a value stream that reducers/modifiers chain onto', () => {
    expect(read('g.inject(1,2,3)').shape).toEqual({ kind: 'value' });
    expect(read('g.inject(1,2,3)').binds).toEqual([1, 2, 3]);
    // every inject() value across the chain folds into one VALUES seed (so the tail's
    // dedup/order/reducer see the whole stream)
    expect(read('g.inject(1,3).inject(100,300)').binds).toEqual([1, 3, 100, 300]);
    // reducers reuse the shared wrapper
    expect(read('g.inject(1,2,3).sum()').shape).toEqual({ kind: 'scalar' });
    expect(read('g.inject(1,2,3).sum()').sql).toContain('SUM(v)');
    expect(read('g.inject(1,2,3).mean()').sql).toContain('AVG(v)');
    expect(read('g.inject(1,2,3).count()').shape).toEqual({ kind: 'count' });
    expect(read('g.inject(1,2,3).fold()').shape).toEqual({ kind: 'list', elem: 'scalar' });
    // is() BEFORE count() filters the pre-count stream (WHERE inside the counted set)
    expect(read('g.inject(1,2,3).is(P.gt(1)).count()').sql).toContain('COUNT(*) AS v FROM (SELECT v FROM c0 WHERE v > ?)');
    // is()/steps AFTER count() would filter the count value — a different semantics
    // the position-free tail can't express, so defer (never silently miscount).
    expect(() => compile('g.inject(1,2,3).count().is(P.gt(2))', {})).toThrow('step not implemented after count(): is()');
    // value modifiers
    expect(read('g.inject(3,1,2).order()').sql).toContain('ORDER BY v ASC');
    expect(read('g.inject(1,1,2).dedup()').sql).toContain('DISTINCT v');
    // an unsupported follow-on step defers cleanly (shared tail's message, since
    // inject now flows through the same value tail as element projections)
    expect(() => compile('g.inject(1).as("a").select("a")', {})).toThrow('step not implemented: as()');
  });

  test('asBool() resolves inject constants at compile time + tags the value shape', () => {
    // The value shape carries `as:'bool'` so the handler frames the 0/1 as Boolean.
    expect(read('g.inject(1).asBool()').shape).toEqual({ kind: 'value', as: 'bool' });
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
    // composition with a reducer / trailing inject would mis-type the stream — defer,
    // never silently wire the wrong GraphBinary type
    expect(() => compile('g.inject(1,0).asBool().fold()', {})).toThrow('asBool() composed');
    expect(() => compile('g.inject(1).asBool().inject(5)', {})).toThrow('asBool() composed');
  });

  test('asNumber(GType.X) tags the value shape with the target subtype', () => {
    // Target comes from the explicit GType arg (the frontend flattens numeric-literal
    // suffixes, so bare asNumber() can't recover the input subtype — it defers).
    expect(read('g.inject(5).asNumber(GType.LONG)').shape).toEqual({ kind: 'value', as: 'long' });
    expect(read('g.inject(12).asNumber(GType.BYTE)').shape).toEqual({ kind: 'value', as: 'byte' });
    // integer targets truncate toward zero; the converted constant is bound
    expect(read('g.inject(5.43).asNumber(GType.INT)').binds).toEqual([5]);
    expect(read("g.inject('5').asNumber(GType.BYTE)").binds).toEqual([5]);
    // runtime value → SQL CAST + tag (no compile-time constant)
    const f = read('g.V().values("weight").asNumber(GType.FLOAT)');
    expect(f.shape).toEqual({ kind: 'value', as: 'float' });
    expect(f.sql).toContain('CAST(json_extract(n.props');
    // is(P.typeOf(X)) on the uniformly-typed stream rides the existing storage-class
    // typeOf — no precision change needed
    expect(read('g.V().values("weight").asNumber(GType.FLOAT).is(P.typeOf(GType.FLOAT))').sql).toContain("typeof(CAST(");
    // overflow + non-numeric-token errors raise TinkerPop's exact messages
    expect(() => compile('g.inject(32768).asNumber(GType.SHORT)', {})).toThrow('Can\'t convert number of type Integer to Short due to overflow.');
    expect(() => compile('g.inject(300).asNumber(GType.BYTE)', {})).toThrow('Can\'t convert number of type Integer to Byte due to overflow.');
    expect(() => compile('g.inject(5).asNumber(GType.VERTEX)', {})).toThrow('asNumber() requires a numeric type token, got VERTEX');
    // bare asNumber() defers (needs the frontend to preserve numeric-literal subtypes)
    expect(() => compile('g.inject(5).asNumber()', {})).toThrow('asNumber() not supported');
    // a reducer after asNumber() would drop the subtype tag → defer
    expect(() => compile('g.inject(2.0).asNumber(GType.FLOAT).sum()', {})).toThrow('composed with a reducer');
    // overflow message uses the boxed Java type name (Integer, not Int)
    expect(() => compile('g.inject(3000000000).asNumber(GType.INT)', {})).toThrow('to Integer due to overflow.');
    // blank string is a parse error, not a silent 0
    expect(() => compile('g.inject("").asNumber(GType.INT)', {})).toThrow("Can't parse string '' as number.");
    // a composed cast over inject would skip the overflow check (raw serializer crash) → defer
    expect(() => compile('g.inject(300).asNumber(GType.INT).asNumber(GType.BYTE)', {})).toThrow('composed with other transforms over inject()');
  });

  test('group().by(__.bothE().values(k).<reducer>()) is a correlated neighbourhood aggregate', () => {
    const p = read("g.V().hasLabel('software').group().by('name').by(__.bothE().values('weight').mean())");
    // one correlated AVG over incident edges, wrapped by MAX to satisfy GROUP BY;
    // typeof carries the storage class so a whole-number mean still frames as Double
    expect(p.sql).toContain('AVG(json_extract(props');
    expect(p.sql).toContain('src=n.id OR tgt=n.id');
    expect(p.sql).toContain('MAX(');
    expect(p.sql).toContain('gvt');
    expect(read("g.V().group().by('name').by(__.bothE().values('weight').sum())").sql).toContain('SUM(json_extract(props');
  });

  test('inject().<scalar transform>() maps to SQLite scalar functions', () => {
    expect(read('g.inject("a","b").concat("c")').sql).toContain('v ||');
    expect(read('g.inject("a").length()').sql).toContain('length(v)');
    expect(read('g.inject("A").toLower()').sql).toContain('lower(v)');
    expect(read('g.inject("a").toUpper()').sql).toContain('upper(v)');
    expect(read('g.inject(1).asString()').sql).toContain('CAST(v AS TEXT)');
    expect(read('g.inject("hello").substring(1,8)').sql).toContain('substr(v');
    expect(read('g.inject("that").replace("h","j")').sql).toContain('replace(v');
    // Scope.local on a scalar stream is a no-op (per-element == per-list)
    expect(read('g.inject("a").length(Scope.local)').sql).toContain('length(v)');
    // transforms chain — composed inline (upper(v || ?)), one shared value tail
    expect(read('g.inject("a").concat("b").toUpper()').sql).toContain('upper(v ||');
  });

  test('scalar transforms also wrap an element value projection', () => {
    expect(read("g.V().values('name').substring(2)").sql).toContain("substr(json_extract(n.props, '$.name')");
    expect(read("g.V().values('name').toUpper()").sql).toContain("upper(json_extract(n.props, '$.name'))");
    expect(read("g.V().values('name').concat('X')").sql).toContain("json_extract(n.props, '$.name') || ?");
    // chained; is()/order() see the transformed value
    expect(read("g.V().values('name').toUpper().is('MARKO')").sql).toContain('upper(');
    // transform on a non-scalar projection is rejected
    expect(() => compile("g.V().valueMap().toUpper()", {})).toThrow('requires a scalar stream');
  });

  test('values(k).inject(c) appends constants to the value stream', () => {
    const p = read("g.V().values('age').inject(1000).sum()");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain('SUM(v)');
    expect(p.binds).toContain(1000);
    // append before a min() reducer
    expect(read("g.V().values('foo').inject(42).min()").sql).toContain('UNION ALL');
    // rejected on a non-scalar projection
    expect(() => compile("g.V().valueMap().inject(1)", {})).toThrow('non-scalar projection');
  });

  test('union() as a source step UNION ALLs its vertex-rooted branches', () => {
    const p = read("g.union(__.V(2),__.V(4)).values('name')");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain("json_extract(n.props, '$.name')");
    // branches sharing the one WITH clause
    expect(read("g.union(__.V().hasLabel('software'),__.V().hasLabel('person')).count()").shape).toEqual({ kind: 'count' });
    // mid-chain union() still works (different code path)
    expect(read("g.V().union(__.out(),__.in()).values('name')").sql).toContain('UNION ALL');
    // non-vertex / unsupported branch defers with a clear error
    expect(() => compile('g.union(__.inject(1),__.inject(2))', {})).toThrow('unsupported source step: inject');
  });

  test('limit before count wraps the counted id-relation', () => {
    expect(read('g.V().limit(2).count()').sql).toContain('SELECT COUNT(*) AS v FROM (SELECT id FROM c1)');
  });

  test('inject seeds a VALUES stream', () => {
    const p = read('g.inject(1,2,3)');
    // q-kernel built: Query mints the CTE name (unquoted, identifier-safe) + our
    // SQL casing; binds ride as Value tokens (one row each).
    // inject compiles through the shared value tail (projection.ts) — a scalar `v`
    // stream projected from the VALUES CTE.
    expect(p.sql).toBe('with c0(v) as (VALUES (?), (?), (?)) SELECT v AS v FROM c0');
    expect(p.binds).toEqual([1, 2, 3]);
  });

  test('as() threads a synthetic alias column through subsequent CTEs', () => {
    const p = read('g.V().as("a").out("knows").select("a")');
    // as('a') binds the current id to column a0; out() carries a0 while id moves
    expect(p.sql).toContain('id AS a0 FROM c0');
    expect(p.sql).toContain('SELECT e.tgt AS id, p.a0 FROM edges e');
    // single-label select('a') → vertex shape sourced from the alias column
    expect(p.sql).toContain('JOIN c2 p ON n.id=p.a0');
    expect(p.shape).toEqual({ kind: 'vertex' });
  });

  test('single-label select().by(key) → scalar value from the alias column', () => {
    const p = read('g.V().as("a").out().select("a").by("name")');
    expect(p.shape).toEqual({ kind: 'value' });
    expect(p.sql).toContain("json_extract(n.props, '$.name') AS v");
    expect(p.sql).toContain('ON n.id=p.a0');
  });

  test('multi-label select → map shape with per-entry prefixed columns', () => {
    const p = read('g.V().as("a").out().as("b").select("a","b")');
    expect(p.shape).toEqual({ kind: 'map', entries: [
      { key: 'a', prefix: 'e0', sub: 'vertex' },
      { key: 'b', prefix: 'e1', sub: 'vertex' },
    ] });
    expect(p.sql).toContain('COALESCE(e0n.uid, e0n.id) AS e0_id'); // element reports uid ?? rowid
    expect(p.sql).toContain('COALESCE(e1n.uid, e1n.id) AS e1_id');
    expect(p.sql).toContain('JOIN nodes e0n ON e0n.id=p.a0');
    expect(p.sql).toContain('JOIN nodes e1n ON e1n.id=p.a1');
  });

  test('select().by(key) maps every entry to a scalar; by mods cycle', () => {
    const both = read('g.V().as("a").out().as("b").select("a","b").by("name")');
    expect(both.shape).toEqual({ kind: 'map', entries: [
      { key: 'a', prefix: 'e0', sub: 'value' },
      { key: 'b', prefix: 'e1', sub: 'value' },
    ] });
    const cyc = read('g.V().as("a").out().as("b").select("a","b").by("age").by("name")');
    // e0 uses by('age'), e1 uses by('name')
    expect(cyc.sql).toContain("json_extract(e0n.props, '$.age') AS e0_v");
    expect(cyc.sql).toContain("json_extract(e1n.props, '$.name') AS e1_v");
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

  test('select/project by(key) is a projection — does NOT report an index key', () => {
    // Mirrors the values() policy (test/performance.test.ts): only has()/order().by()
    // report indexKeys. A has() filter still does, even alongside a select projection.
    expect(read('g.V().as("a").out().select("a").by("age")').indexKeys).toEqual([]);
    expect(read('g.V().project("n","a").by("name").by("age")').indexKeys).toEqual([]);
    expect(read('g.V().has("age",30).as("a").select("a").by("name")').indexKeys).toEqual(['age']);
  });

  test('semantic strategies fail closed (never silently drop a filtering strategy)', () => {
    // A dropped PartitionStrategy/SubgraphStrategy would return unfiltered data with
    // no error — an isolation leak. Must reject, not silently ignore.
    expect(() => compile("g.withStrategies(new PartitionStrategy(partitionKey:'_p',writePartition:'a',readPartitions:['a'])).V().values('name')", {}))
      .toThrow('withStrategies(...) is not supported');
    expect(() => compile("g.withStrategies(new SubgraphStrategy(vertices:__.has('name','marko'))).V()", {}))
      .toThrow('withStrategies(...) is not supported');
    // ProductiveByStrategy changes by() null semantics — not an optimization. Reject.
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().values("name")', {}))
      .toThrow('withStrategies(...) is not supported');
    // withoutStrategies is coupled to strategy application, so it stays failing-closed
    // for semantic strategies until removal is implemented alongside it.
    expect(() => compile('g.withoutStrategies(PartitionStrategy).V()', {}))
      .toThrow('withoutStrategies(...) is not supported');
    // Mixed list: one unsafe strategy poisons the whole call.
    expect(() => compile('g.withStrategies(CountStrategy, ProductiveByStrategy).V()', {}))
      .toThrow('withStrategies(...) is not supported');
  });

  test('result-preserving optimization strategies accepted as no-ops (correct-by-design)', () => {
    // These cannot change the result set (TinkerPop optimization-strategy contract),
    // so not applying them is exactly correct. The official suite proves it: the
    // withStrategies(X) and withoutStrategies(X) scenarios expect identical rows.
    for (const s of ['CountStrategy', 'IdentityRemovalStrategy', 'FilterRankingStrategy',
                     'LazyBarrierStrategy', 'MatchAlgorithmStrategy', 'RepeatUnrollStrategy']) {
      expect(() => compile(`g.withStrategies(${s}).V().count()`, {})).not.toThrow();
      expect(() => compile(`g.withoutStrategies(${s}).V().count()`, {})).not.toThrow();
    }
    // identity() is the no-op step (what IdentityRemovalStrategy elides) — compiles.
    expect(read('g.V().identity().out().values("name")')).toBeDefined();
    expect(() => compile('g.withStrategies(IdentityRemovalStrategy).V().identity().out()', {})).not.toThrow();
  });

  test('deferred long-tail forms error clearly (never silently mis-execute)', () => {
    expect(() => compile('g.V().select(Pop.first,"a")', {})).toThrow('select(Pop.first) not yet supported');
    expect(() => compile('g.V().as("a").select("a").by(__.out().count())', {})).toThrow('by(traversal) modulator not yet supported');
    expect(() => compile('g.V().as("a").select("a").by(T.id)', {})).toThrow('by(T.id) modulator not yet supported');
    expect(() => compile('g.V().as("a").out().as("b").select("a","b").order()', {})).toThrow('order() after select()/project() not yet supported');
    expect(() => compile('g.V().select("x")', {})).toThrow('no such label');
    // order().by() deferred modulators must throw, not silently sort by id
    expect(() => compile('g.V().order().by(T.label)', {})).toThrow('by(T.label) modulator not yet supported');
    expect(() => compile('g.V().order().by(__.values("age"))', {})).toThrow('by(traversal) modulator not yet supported');
    // dedup: label-scoped and dedup-after-as() deferred rather than answered wrongly
    expect(() => compile('g.V().as("a").out().as("b").dedup("a","b")', {})).toThrow('dedup(label) not yet supported');
    expect(() => compile('g.V().as("a").out().dedup()', {})).toThrow('dedup() after as() not yet supported');
  });

  test('E() sources the edges table; default projection is the edge shape', () => {
    const p = read('g.E()');
    expect(p.sql).toContain('c0(id) as (SELECT id FROM edges)');
    expect(p.shape).toEqual({ kind: 'edge' });
    // Endpoints resolve to the external id (COALESCE(uid,id)) so a materialized edge
    // reports the SAME endpoint ids as the write path — was raw rowid (n.src, n.tgt),
    // a read/write divergence that surfaced under user-supplied ids.
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS src');
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.tgt) AS tgt');
    // ...and the resolution must NOT leak into the traversal CTE (index-only scan):
    // the source CTE is still a bare `SELECT id FROM edges`, no endpoint join.
    expect(p.sql).not.toContain('nodes WHERE id=n.src) AS id');
  });

  test('every edge-element materialization path resolves endpoints to external ids', () => {
    // Regression: an edge framed out as an element must report external endpoint
    // ids on ALL paths (was raw rowid), matching the write path (write.ts nodeExtId).
    // fold() over edges reuses the __element edge projection.
    expect(read('g.V(1).outE().fold()').sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS src');
    // path() with an edge position frames endpoints per-position (x{i}_src/_tgt).
    const pth = read('g.V(1).outE().inV().path()');
    expect(pth.sql).toContain('WHERE id=x1n.src) AS x1_src');
    expect(pth.sql).toContain('WHERE id=x1n.tgt) AS x1_tgt');
    // group() default value = element list of edges (v_src/_tgt).
    expect(read('g.V(1).outE().group().by(__.label())').sql)
      .toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS v_src');
  });

  test('outE/inE go vertex→edge; outV/inV go edge→vertex', () => {
    const oe = read('g.V(1).outE("knows")');
    expect(oe.sql).toContain('SELECT e.id AS id FROM edges e JOIN c0 p ON e.src=p.id');
    expect(oe.shape).toEqual({ kind: 'edge' });

    const iv = read('g.V(1).outE("knows").inV()');
    // edge → target vertex; back to vertex shape
    expect(iv.sql).toContain('SELECT e.tgt AS id FROM edges e JOIN c1 p ON e.id=p.id');
    expect(iv.shape).toEqual({ kind: 'vertex' });
  });

  test('edge steps reject the wrong element kind', () => {
    expect(() => compile('g.V().outV()', {})).toThrow('outV() expects an edge, not a node');
    expect(() => compile('g.E().out()', {})).toThrow('out() expects a vertex, not an edge');
    expect(() => compile('g.E().drop()', {})).toThrow('edge drop() (e.g. g.E().drop()) not yet supported');
    expect(() => compile('g.E().elementMap()', {})).toThrow('elementMap() on edges not yet supported');
  });

  test('has()/values() on edges filter/project the edges table', () => {
    const h = read('g.E().has("weight",0.5)');
    expect(h.sql).toContain('FROM edges n JOIN c0 p ON n.id=p.id');
    // edge has() is not auto-indexed (node-only index helper)
    expect(h.indexKeys).toEqual([]);
    expect(read('g.V(1).outE().values("weight")').sql).toContain("json_extract(n.props, '$.weight') AS v");
  });

  test('select/project of an edge throws rather than silently joining nodes', () => {
    // regression: edge-typed alias/traverser must not join the nodes table
    // (silent empty, or wrong row if node/edge ids collide)
    expect(() => compile('g.V(1).outE("knows").as("b").select("b")', {})).toThrow('select("b") of an edge-typed label is not yet supported');
    expect(() => compile('g.V(1).outE().project("w").by("weight")', {})).toThrow('project() of an edge is not yet supported');
  });

  test('properties() expands props via json_each into a property shape', () => {
    const p = read('g.V().properties()');
    expect(p.sql).toContain('json_each(n.props) je');
    expect(p.shape).toEqual({ kind: 'property' });
    // key filter uses WHERE, and binds the requested keys
    const named = read('g.V().properties("name","age")');
    expect(named.sql).toContain('WHERE je.key IN (?,?)');
    expect(named.binds).toEqual(['name', 'age']);
  });

  test('properties() follow-ons: key/value/count/element project the right column', () => {
    expect(read('g.V().properties().key()').sql).toContain('SELECT pk AS v');
    expect(read('g.V().properties().value()').sql).toContain('SELECT pv AS v');
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'count' });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toContain("json_extract(ownerProps, '$.name')");
  });

  test('properties(): trailing steps past the follow-on throw; edge element().label() allowed', () => {
    // regression: a step after the resolved follow-on must not be silently dropped
    expect(() => compile('g.V(1).properties().key().limit(1)', {})).toThrow('step not implemented after properties(): limit()');
    expect(() => compile('g.V(1).properties().element().values("name").count()', {})).toThrow('step not implemented after properties(): count()');
    // regression: element().label() on an edge property is a scalar — must NOT be blocked
    expect(read('g.E(7).properties().element().label()').sql).toContain('ownerLabel AS v');
    // bare element() on an edge IS still deferred (needs src/tgt)
    expect(() => compile('g.E(7).properties().element()', {})).toThrow('element() of an edge property not yet supported');
  });

  // ---- P2c-2 aggregation: group/groupCount + nested by() ----

  test('group().by(key).by(__.tail()) → element-last, ORDER BY key (assembly path)', () => {
    const p = read('g.V().group().by("name").by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'elementLast', elem: 'vertex' } });
    expect(p.sql).toContain("json_extract(n.props, '$.name') AS gk");
    expect(p.sql).toContain('COALESCE(n.uid, n.id) AS v_id');
    expect(p.sql).toContain('ORDER BY gk'); // element value → no GROUP BY, ordered for run-folding
  });

  test('group().by(key) default value → element list; group by key reports an index key', () => {
    const p = read('g.V().group().by("name")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'elementList', elem: 'vertex' } });
    expect(p.indexKeys).toEqual(['name']); // group().by(key) is a filter/order-position use
  });

  test('group().by(key).by(prop) → scalar-list via json_group_array + GROUP BY', () => {
    const p = read('g.V().group().by("name").by("age")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'scalarList' } });
    expect(p.sql).toContain("json_group_array(json_extract(n.props, '$.age')) AS gv");
    expect(p.sql).toContain('GROUP BY gk');
  });

  test('groupCount() → count value; GROUP BY', () => {
    const p = read('g.V().groupCount().by("name")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    expect(p.sql).toContain('COUNT(*) AS gv');
    expect(p.sql).toContain('GROUP BY gk');
  });

  test('group().by(__.project) composite key with nested scalar by()s (edge gate)', () => {
    const p = read('g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'o' }, { key: 'l' }, { key: 'i' }] }, val: { kind: 'elementLast', elem: 'edge' } });
    // nested scalars → correlated subqueries on the edge endpoints
    expect(p.sql).toContain("(SELECT json_extract(props, '$.name') FROM nodes WHERE id=n.src) AS k0_v");
    expect(p.sql).toContain('(SELECT name FROM labels WHERE id=n.label) AS k1_v');
    expect(p.sql).toContain("(SELECT json_extract(props, '$.name') FROM nodes WHERE id=n.tgt) AS k2_v");
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS v_src'); // edge value framing → external endpoint id
  });

  test('properties().group() over the property stream (vertex-property gate)', () => {
    const p = read('g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'n' }, { key: 'k' }, { key: 'v' }] }, val: { kind: 'elementLast', elem: 'property' } });
    expect(p.sql).toContain("json_extract(c1.ownerProps, '$.name') AS k0_v"); // property-group ctx columns typed via the CTE relation
    expect(p.sql).toContain('pk AS k1_v');
    expect(p.sql).toContain('pv AS k2_v');
    expect(p.sql).toContain('owner AS v_owner'); // property value framing
  });

  test('fold() wraps the projection in a list shape (element or scalar)', () => {
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'list', elem: 'scalar' });
    expect(read('g.V(1).outE().fold()').shape).toEqual({ kind: 'list', elem: 'edge' });
  });

  test('sum() wraps a value stream in SQL SUM → scalar shape', () => {
    const p = read('g.V().values("age").sum()');
    expect(p.shape).toEqual({ kind: 'scalar' });
    expect(p.sql).toContain('SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (');
  });

  test('aggregation deferred forms throw clearly', () => {
    expect(() => compile('g.V().group().by("name").cap("x")', {})).toThrow('step not implemented after group(): cap()');
    expect(() => compile('g.V().group().by(__.out().values("name"))', {})).toThrow(); // deep nested key
    expect(() => compile('g.V().properties().group().by()', {})).toThrow('group().by() on a property element is not yet supported');
    expect(() => compile('g.V().group().by("name").by("age").by("x")', {})).toThrow('more than two by() modulators');
    expect(() => compile('g.V().fold().unfold()', {})).toThrow('step not implemented after fold(): unfold()');
    expect(() => compile('g.V().count().fold()', {})).toThrow('fold() after count() not yet supported');
    expect(() => compile('g.V().sum()', {})).toThrow('sum() of vertex not yet supported');
  });

  // ---- P2b: is / where / not / TextP ----

  test('is(P) folds a predicate onto the projected scalar', () => {
    const gt = read('g.V().values("age").is(P.gt(30))');
    expect(gt.shape).toEqual({ kind: 'value' });
    expect(gt.sql).toContain("json_extract(n.props, '$.age') is not null AND json_extract(n.props, '$.age') > ?");
    expect(gt.binds).toContain(30);
    // bare literal → equality
    expect(read('g.V().values("age").is(29)').sql).toContain("json_extract(n.props, '$.age') = ?");
  });

  test('count().is(P) wraps the count in a value filter (0/1 rows)', () => {
    const p = read('g.V().count().is(P.gt(3))');
    expect(p.sql).toContain('SELECT v FROM (SELECT COUNT(*) AS v FROM');
    expect(p.sql).toContain('WHERE v > ?');
    expect(p.shape).toEqual({ kind: 'count' });
  });

  test('is() on a non-scalar projection throws', () => {
    expect(() => compile('g.V().is(1)', {})).toThrow('is() requires a scalar stream');
  });

  test('TextP compiles to LIKE with a bound, metachar-escaped pattern', () => {
    const sw = read('g.V().has("name", TextP.startingWith("jo"))');
    expect(sw.sql).toContain("like ? escape ?"); // node renderer: lowercase kw, escape bound
    expect(sw.binds).toContain('jo%');
    expect(read('g.V().values("name").is(TextP.containing("ar"))').binds).toContain('%ar%');
    // negation → NOT LIKE
    expect(read('g.V().has("name", TextP.notEndingWith("o"))').sql).toContain("not like ? escape ?");
    // metachars in the user value are escaped, never spliced
    const esc = read('g.V().has("name", TextP.containing("50%_x"))');
    expect(esc.binds).toContain('%50\\%\\_x%');
  });

  test('where(__.movement) → EXISTS filter CTE; not() → NOT COALESCE', () => {
    const w = read('g.V().where(__.out("knows")).values("name")');
    expect(w.sql).toContain('EXISTS(SELECT 1 FROM edges xe WHERE xe.src=n.id AND xe.label IN');
    const n = read('g.V().not(__.out("created")).values("name")');
    expect(n.sql).toContain('WHERE NOT COALESCE((EXISTS(');
  });

  test('where(__.count().is(P)) → correlated scalar compare; reports index key on values(k)', () => {
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")');
    expect(c.sql).toContain('(SELECT COUNT(*) FROM edges WHERE (tgt=n.id)');
    expect(c.sql).toContain('>= ?');
    // where(__.values(k).is(P)) is a filter-position use → index key reported
    expect(read('g.V().where(__.values("age").is(P.gt(30)))').indexKeys).toEqual(['age']);
  });

  test('alias-compare where(P.neq("a")) and where("a",P,by(key)); unknown label throws', () => {
    const idc = read('g.V().as("a").out().where(P.neq("a"))');
    expect(idc.sql).toContain('WHERE n.id != p.a0');
    const keyc = read('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name")');
    expect(keyc.sql).toContain("(SELECT json_extract(props, '$.name') FROM nodes WHERE id=p.a0) = (SELECT json_extract(props, '$.name') FROM nodes WHERE id=p.a1)");
    expect(() => compile('g.V().where("x", P.eq("y"))', {})).toThrow('no such label');
    // alias-compare where() takes at most one by(key) — a second is not a valid
    // modulator here; fail closed rather than silently drop it.
    expect(() => compile('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name").by("age")', {}))
      .toThrow('by() is only supported as an order() or select()/project() modulator');
  });

  test('where(__.<multi-hop chain>) → correlated EXISTS over the path', () => {
    // 2-hop path existence
    const two = read('g.V().where(__.out().out()).values("name")');
    expect(two.sql).toContain('EXISTS(SELECT 1 FROM edges xe0 JOIN nodes xn0 ON xn0.id=xe0.tgt JOIN edges xe1 ON xe1.src=xn0.id JOIN nodes xn1 ON xn1.id=xe1.tgt WHERE xe0.src=n.id');
    // terminal has() on the neighbour
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))').sql)
      .toContain("json_extract(xn0.props, '$.age') > ?");
    // terminal hasLabel()
    expect(read('g.V().where(__.out("created").hasLabel("software"))').sql).toContain('xn0.label IN (SELECT id FROM labels');
    // a lone bare movement keeps the leaner edge-only EXISTS (no node join)
    expect(read('g.V().where(__.out()).count()').sql).toContain('EXISTS(SELECT 1 FROM edges xe WHERE xe.src=n.id))');
  });

  test('where()/filter() deferred forms throw clearly', () => {
    expect(() => compile('g.V().where(__.both().both())', {})).toThrow('multi-hop');
    expect(() => compile('g.V().filter(P.gt(1))', {})).toThrow('filter(predicate) not supported');
  });

  // ---- P2 tail: and/or/union/optional ----

  test('and()/or() combine branch predicates; nested where(__.and)', () => {
    const a = read('g.V().and(__.out("knows"), __.out("created"))');
    expect(a.sql).toContain('WHERE ((EXISTS(SELECT 1 FROM edges xe WHERE xe.src=n.id AND xe.label IN');
    expect(a.sql).toContain(') AND (EXISTS(');
    expect(read('g.V().or(__.out("knows"), __.in("created"))').sql).toContain(') OR (EXISTS(');
    // <2 branches → clear throw
    expect(() => compile('g.V().and(__.out())', {})).toThrow('needs at least two traversal branches');
  });

  test('union() → UNION ALL of branch id-relations, multi-hop bodies fold', () => {
    const u = read('g.V(1).union(__.out("knows"), __.out("created")).values("name")');
    expect(u.sql).toContain('UNION ALL');
    expect(u.sql).toContain('SELECT e.tgt AS id FROM edges e JOIN c0 p ON e.src=p.id');
    // multi-hop branch now folds through the dispatch (was single-hop only)
    expect(read('g.V().union(__.out().out(), __.in()).values("name")').sql)
      .toContain('SELECT e.tgt AS id FROM edges e JOIN c1 p ON e.src=p.id');
    expect(() => compile('g.V().union(__.out())', {})).toThrow('needs at least two branches');
    expect(() => compile('g.V().as("a").union(__.out(), __.in())', {})).toThrow('union() after as() not yet supported');
    // a scalar branch body now defers with the shared scalar-body message
    expect(() => compile('g.V().union(__.values("name"), __.out())', {})).toThrow('scalar/projection body');
    // mixed element kinds across branches
    expect(() => compile('g.V().union(__.out(), __.outE())', {})).toThrow('different element kinds');
  });

  test('optional() → single-hop LEFT JOIN fast path; multi-hop via ordinal', () => {
    const o = read('g.V().optional(__.out("created")).values("name")');
    expect(o.sql).toContain('SELECT COALESCE(e.tgt, p.id) AS id FROM c0 p LEFT JOIN edges e ON e.src=p.id');
    // both()/multi-hop now compile via the coalesce(t, identity) ordinal shape
    const b = read('g.V().optional(__.both()).count()');
    expect(b.sql).toContain('ROW_NUMBER() OVER () AS o');
    expect(b.sql).toContain('WHERE o NOT IN (SELECT o FROM'); // self-on-miss
    expect(read('g.V().optional(__.out().out()).count()').sql).toContain('ROW_NUMBER() OVER () AS o');
    // a body that flips element kind would make self-on-miss mixed-shape → defer
    expect(() => compile('g.V().optional(__.outE())', {})).toThrow('changing element kind');
  });

  test('coalesce() → first non-empty branch per input via the ordinal', () => {
    const c = read('g.V(1).coalesce(__.out("knows"), __.out("created")).values("name")');
    expect(c.sql).toContain('ROW_NUMBER() OVER () AS o');
    // branch 2 emits only for inputs branch 1 produced nothing for
    expect(c.sql).toContain('WHERE o NOT IN (SELECT o FROM');
    expect(c.shape).toEqual({ kind: 'value' });
    expect(() => compile('g.V().coalesce(__.out(), __.values("name"))', {})).toThrow('scalar/projection body');
    expect(() => compile('g.V().coalesce(__.out(), __.outE())', {})).toThrow('different element kinds');
    // an origin-unsafe body step (drops the ordinal) fails closed, not a broken CTE
    expect(() => compile('g.V().coalesce(__.out().dedup(), __.in())', {})).toThrow('input-ordinal not carried');
    // union() inside coalesce threads the ordinal through → valid
    expect(read('g.V().coalesce(__.union(__.out(),__.in()), __.both())').sql).toContain('ROW_NUMBER() OVER () AS o');
  });

  test('flatMap() inlines an element body (fan-out), scalar body defers', () => {
    expect(read('g.V().flatMap(__.out().out()).values("name")').sql)
      .toContain('SELECT e.tgt AS id FROM edges e JOIN c1 p ON e.src=p.id');
    expect(() => compile('g.V().flatMap(__.values("name"))', {})).toThrow('scalar/projection body');
  });

  test('map(__.<scalar>) → per-traverser scalar projection (value shape)', () => {
    const m = read('g.V().map(__.out().count())');
    expect(m.shape).toEqual({ kind: 'value' });
    expect(m.sql).toContain('SELECT (SELECT COUNT(*) FROM edges WHERE (src=n.id)) AS v FROM nodes n JOIN c0 p');
    expect(read('g.V(1).map(__.values("name"))').sql).toContain("json_extract(n.props, '$.name') AS v");
    // element-body map (first-result-only) and select/fold bodies defer
    expect(() => compile('g.V().map(__.out())', {})).toThrow('only supports a terminal count');
    expect(() => compile('g.V().map(__.select("a"))', {})).toThrow('not yet supported');
    expect(() => compile('g.V().map(__.values("name")).map(__.values("age"))', {})).toThrow('step not implemented after map()');
  });

  test('choose(pred, then, else) → gated-seed UNION ALL, arms fold from their seed', () => {
    const c = read('g.V().choose(__.has("name","vadas"), __.out("knows"), __.in("knows"))');
    // two gated seeds off the same source (c0): pred and NOT-pred
    expect(c.sql).toContain("WHERE json_extract(n.props, '$.name') = ?");
    expect(c.sql).toContain("WHERE NOT COALESCE((json_extract(n.props, '$.name') = ?), 0)");
    // arms fold through movement; the two element id-relations merge UNION ALL
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    expect(c.binds).toEqual(['vadas', 'knows', 'vadas', 'knows']);
    // count().is predicate rides as a correlated subquery; multi-hop arm folds
    expect(read('g.V().choose(__.out("knows").count().is(P.gt(0)), __.out("created").out())').sql)
      .toContain('(SELECT COUNT(*) FROM edges WHERE (src=n.id)');
    // 2-arg form: else absent → identity passthrough of the NOT-pred seed
    expect(read('g.V().choose(__.hasLabel("software"), __.in("created"))').sql).toContain('UNION ALL');
  });

  test('choose() deferrals fail closed', () => {
    // a bare choice traversal with no then/else and no option() isn't a supported form
    expect(() => compile('g.V().choose(__.out())', {}))
      .toThrow('predicate form');
    // a scalar/projection arm body can't ride the id-relation
    expect(() => compile('g.V().choose(__.has("x"), __.out(), __.values("name"))', {}))
      .toThrow('not yet supported (scalar/projection body)');
    // mixed element kinds across arms
    expect(() => compile('g.V().choose(__.has("x"), __.out(), __.outE())', {}))
      .toThrow('different element kinds');
    expect(() => compile('g.V().as("a").choose(__.has("x"), __.out(), __.in())', {}))
      .toThrow('choose() after as() not yet supported');
  });

  test('option-map choose → CASE over the choice scalar (value shape)', () => {
    const c = read('g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))');
    expect(c.shape).toEqual({ kind: 'value' });
    expect(c.sql).toContain("CASE WHEN (json_extract(n.props, '$.age') >= ? and json_extract(n.props, '$.age') < ?) THEN ? ELSE ? END AS v");
    expect(c.binds).toEqual([26, 30, 'x', 'z']);
    // T.label choice, literal-equality keys
    expect(read('g.V().choose(T.label).option("person", __.constant("p")).option(Pick.none, __.constant("o"))').sql)
      .toContain('CASE WHEN (SELECT name FROM labels WHERE id=n.label) = ? THEN ? ELSE ? END');
    // count() choice as a correlated subquery
    expect(read('g.V().choose(__.out().count()).option(1, __.values("name")).option(Pick.none, __.values("age"))').sql)
      .toContain('CASE WHEN (SELECT COUNT(*) FROM edges WHERE (src=n.id)) = ? THEN');
  });

  test('option-map choose deferrals fail closed', () => {
    // no Pick.none → unmatched pass-through is mixed vertex/scalar
    expect(() => compile('g.V().choose(__.out().count()).option(1, __.values("name")).option(2, __.values("age"))', {}))
      .toThrow('without a Pick.none default');
    // an element option body isn't a scalar for the CASE (compileNestedScalar rejects it)
    expect(() => compile('g.V().choose(T.label).option("person", __.out("knows")).option(Pick.none, __.constant("x"))', {}))
      .toThrow('only supports a terminal count');
    // Pick.unproductive semantics
    expect(() => compile('g.V().choose(__.values("age")).option(P.gt(30), __.constant("x")).option(Pick.unproductive, __.constant("u")).option(Pick.none, __.constant("z"))', {}))
      .toThrow('Pick.unproductive');
  });

  // ---- P3: repeat/times/emit ----

  test('repeat().times() → WITH RECURSIVE walk c1(id, depth); final depth only', () => {
    const p = read('g.V().repeat(__.out()).times(2).values("name")');
    expect(p.sql).toContain('with recursive');
    expect(p.sql).toContain('as (SELECT id, 0 AS depth FROM c0 UNION ALL SELECT e.tgt AS id, c1.depth + 1 AS depth FROM c1 JOIN edges e ON e.src=c1.id WHERE c1.depth < 2)');
    expect(p.sql).toContain('WHERE depth = 2');
  });

  test('emit position controls the projected depth band', () => {
    expect(read('g.V().repeat(__.out()).times(2).emit()').sql).toContain('WHERE depth >= 1'); // after → iterations
    expect(read('g.V().emit().repeat(__.out()).times(2)').sql).toContain('WHERE depth >= 0'); // before → + seed
    expect(read('g.V().repeat(__.out()).times(2)').sql).toContain('WHERE depth = 2');          // times only → final
  });

  test('both() repeat emits two recursive terms', () => {
    const p = read('g.V().repeat(__.both()).times(2)');
    expect(p.sql).toContain('e.tgt AS id, c1.depth + 1');
    expect(p.sql).toContain('e.src AS id, c1.depth + 1'); // both directions
  });

  test('repeat requires an exit modulator; emit()/until() run unbounded; sequential repeats chain', () => {
    // bare repeat() has no termination AND no output semantics → reject
    expect(() => compile('g.V().repeat(__.out())', {})).toThrow('repeat() requires times(), until(), or emit()');
    // unbounded emit() now compiles — no artificial depth cap; it terminates at the
    // natural fixpoint (frontier exhaustion) on an acyclic body.
    const em = read('g.V().repeat(__.out()).emit()');
    expect(em.sql).toContain('with recursive');
    expect(em.sql).not.toContain('depth <');       // no depth cap in the recursion
    expect(em.sql).toContain('WHERE depth >= 1');   // emit-after band
    expect(() => compile('g.V().repeat(__.out().order()).times(2)', {})).toThrow('single out()/in()/both(), optional .simplePath()');
    expect(() => compile('g.V().emit().times(2)', {})).toThrow('without repeat()');
    // a second repeat is NOT swallowed — it compiles as a chained cluster (two walks)
    const chained = read('g.V().repeat(__.out()).times(1).repeat(__.out()).times(1).values("name")');
    expect((chained.sql.match(/UNION ALL SELECT e\.tgt/g) || []).length).toBe(2); // two walk CTEs
  });

  test('P.inside is exclusive-low (distinct from between)', () => {
    // between = [lo,hi) ; inside = (lo,hi)
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('>= ? and');
    expect(read('g.V().has("age", P.inside(29,35))').sql).toContain('> ? and');
    expect(read('g.V().has("age", P.inside(29,35))').sql).not.toContain('>= ?');
  });

  test('review-fix regressions: no silent mis-execution', () => {
    // edge out().count() must throw (was silently mis-counting via edge id)
    expect(() => compile('g.E().where(__.out().count().is(P.gt(0)))', {})).toThrow('over an edge not yet supported');
    // where(__.move().is(P)) must not silently drop the is()
    expect(() => compile('g.V().where(__.out("knows").is(1))', {})).toThrow('where(__.out().is(P)) not yet supported');
    // is() after limit() must throw (position-sensitive)
    expect(() => compile('g.V().values("age").limit(3).is(P.gt(25))', {})).toThrow('is() after limit()');
    // values(k).is(P) now reports the index key (like has())
    expect(read('g.V().values("age").is(P.gt(30))').indexKeys).toEqual(['age']);
    // alias-compare by(key) on an edge label throws rather than reading nodes
    expect(() => compile('g.V().as("a").outE().as("e").where("e", P.eq("a")).by("weight")', {})).toThrow('edge-typed label not yet supported');
  });

  test('has() still compiles all predicate forms after the predicateSql refactor', () => {
    expect(read('g.V().has("age", 30)').sql).toContain('= ?');
    expect(read('g.V().has("age", P.gt(30))').sql).toContain('> ?');
    expect(read('g.V().has("age", P.within(29,30))').sql).toContain('in (?, ?)');
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('>= ? and');
  });

  test('identifier keys splice as literal JSON paths (index-friendly); exotic keys are bound', () => {
    // Safe identifier: spliced literally so `CREATE INDEX ...(json_extract(props,'$.age'))`
    // can engage. See the property-index performance test below.
    const safe = read('g.V().has("age",30)');
    expect(safe.sql).toContain("json_extract(n.props, '$.age')");
    expect(safe.binds).toEqual([30]); // key not bound

    // Exotic key (space): falls back to the bound `'$.' || ?` form — correct,
    // just not index-eligible. The key value is never spliced into SQL.
    const exotic = read('g.V().has("first name","x")');
    expect(exotic.sql).toContain("json_extract(n.props, '$.' || ?)");
    expect(exotic.sql).not.toContain('first name');
    expect(exotic.binds).toEqual(['first name', 'x']);
  });

  // ---------- path()/simplePath()/cyclicPath() (linear regime) ----------

  test('path() threads a per-position column through the movement fold', () => {
    const p = read('g.V(1).out().out().path()');
    // V() seeds p0; each hop appends a new position holding the moved id, carrying
    // the earlier positions unchanged.
    expect(p.sql).toContain('SELECT id, id AS p0 FROM nodes');
    expect(p.sql).toContain('SELECT e.tgt AS id, p.p0, e.tgt AS p1 FROM edges');
    expect(p.sql).toContain('SELECT e.tgt AS id, p.p0, p.p1, e.tgt AS p2 FROM edges');
    // Non-path queries stay byte-identical (no p-columns).
    expect(read('g.V(1).out().out()').sql).not.toContain('p0');
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'element', elem: 'vertex', prefix: 'x0' },
      { render: 'element', elem: 'vertex', prefix: 'x1' },
      { render: 'element', elem: 'vertex', prefix: 'x2' },
    ] });
  });

  test('path().by(k1).by(k2) cycles modulators round-robin and drops on missing key', () => {
    // Three positions, two by()s → name, age, name (index % byCount).
    const p = read('g.V(1).out().out().path().by("name").by("age")');
    expect(p.sql).toContain("json_extract(x0n.props, '$.name') AS x0_v");
    expect(p.sql).toContain("json_extract(x1n.props, '$.age') AS x1_v");
    expect(p.sql).toContain("json_extract(x2n.props, '$.name') AS x2_v");
    // Non-productive-by is a filter: every projected value must be present or the
    // whole path drops (TinkerPop default, no ProductiveByStrategy).
    expect(p.sql).toContain("json_extract(x0n.props, '$.name') is not null AND");
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }, { render: 'value', prefix: 'x2' },
    ] });
  });

  test('simplePath()/cyclicPath() compile to a static all-pairs identity test', () => {
    // Three same-kind positions → 3 pairs; simple keeps none-equal, cyclic keeps any-equal.
    const simple = read('g.V(1).out().in().simplePath()');
    expect(simple.sql).toContain('WHERE NOT (p.p0 = p.p1 OR p.p0 = p.p2 OR p.p1 = p.p2)');
    const cyclic = read('g.V(1).out().in().cyclicPath()');
    expect(cyclic.sql).toContain('WHERE (p.p0 = p.p1 OR p.p0 = p.p2 OR p.p1 = p.p2)');
  });

  test('path() interleaves edge and vertex positions with the right element shape', () => {
    const p = read('g.V(1).outE("created").inV().path()');
    // edge position frames endpoints as external ids (COALESCE(uid,id)), not raw rowid
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=x1n.src) AS x1_src, (SELECT COALESCE(uid, id) FROM nodes WHERE id=x1n.tgt) AS x1_tgt');
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'element', elem: 'vertex', prefix: 'x0' },
      { render: 'element', elem: 'edge', prefix: 'x1' },
      { render: 'element', elem: 'vertex', prefix: 'x2' },
    ] });
  });

  test('path() over a branch/aggregating source or with an unsupported tail defers cleanly', () => {
    expect(() => compile('g.V().union(__.out(),__.in()).path()', {})).toThrow('path tracking through union() not yet supported');
    // union() as a SOURCE step never seeds p0 → its own clear deferral (not the mid-chain guard).
    expect(() => compile('g.union(__.V(),__.V()).path()', {})).toThrow('path() over a union() source step is not yet supported');
    expect(() => compile('g.V().optional(__.out()).path()', {})).toThrow('path tracking through optional() not yet supported');
    expect(() => compile('g.V(1).out().dedup().path()', {})).toThrow('dedup() with path tracking not yet supported');
    expect(() => compile('g.V(1).out().path().by(__.values("name"))', {})).toThrow('path().by(traversal) modulator not yet supported');
    expect(() => compile('g.V(1).out().path().by(T.id)', {})).toThrow('path().by(T.id) modulator not yet supported');
    expect(() => compile('g.V(1).out().path().order()', {})).toThrow('order() after path() not yet supported');
  });

  // ---------- recursive repeat().path() (JSONB array regime) ----------

  test('repeat().path() accumulates a JSONB array through the WITH RECURSIVE walk', () => {
    const p = read('g.V(1).repeat(__.out()).times(2).path()');
    expect(p.sql).toContain('jsonb_array(id) AS path');                  // seed
    expect(p.sql).toContain("jsonb_insert(c1.path, '$[#]', e.tgt) AS path"); // append per hop
    expect(p.sql).toContain('json_each(pp.path) je JOIN nodes n ON n.id=je.value'); // explode + materialize
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex' });
  });

  test('simplePath() inside repeat() folds into the recursive cycle guard', () => {
    const p = read('g.V().repeat(__.both().simplePath()).times(3).path()');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path) je WHERE je.value=e.tgt)');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path) je WHERE je.value=e.src)'); // both directions
  });

  test('simplePath() in the body works without path() output — array is internal to the walk', () => {
    const p = read('g.V().repeat(__.both().simplePath()).times(3)');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path)'); // guard present
    expect(p.shape).toEqual({ kind: 'vertex' });                            // but output is plain vertices
  });

  test('a non-path repeat() is byte-identical (no JSONB path column added)', () => {
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).not.toContain('path');
  });

  test('recursive path() defers mixed/edge/emit forms with clear errors', () => {
    expect(() => compile('g.V(1).out().repeat(__.out()).times(2).path()', {})).toThrow('path() spanning more than one repeat()/movement is not yet supported');
    expect(() => compile('g.V().repeat(__.outE().inV()).times(2).path()', {})).toThrow('single out()/in()/both(), optional .simplePath()');
    expect(() => compile('g.V().repeat(__.out()).emit().times(2).path()', {})).toThrow('emit() with path() not yet supported');
    // A SECOND repeat cluster after an array-tracked path() would reseed the walk and
    // silently drop the first walk's segment — fail closed instead.
    expect(() => compile('g.V(1).repeat(__.out()).times(1).repeat(__.out()).times(1).path()', {})).toThrow('path() spanning more than one repeat()/movement is not yet supported');
  });

  test('dedup() after a recursive path() distinct-ifies BEFORE row-numbering (ROW_NUMBER would defeat DISTINCT)', () => {
    const p = read('g.V(1).repeat(__.both()).times(1).path().dedup()');
    // DISTINCT must be in its own CTE over the raw path, not the same SELECT as ROW_NUMBER().
    expect(p.sql).toContain('SELECT DISTINCT');
    expect(p.sql.replace(/\s+/g, ' ')).not.toMatch(/DISTINCT[^)]*ROW_NUMBER/);
  });

  // ---------- repeat().until() ----------

  test('until() compiles a `done` column: expand from done=0, output done=1', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.has("name","ripple"))');
    expect(p.sql).toContain('AS done');
    expect(p.sql).toContain('c1.done=0');           // expand only from still-looping rows
    expect(p.sql).toContain('WHERE done = 1');       // output satisfied rows
    expect(p.sql).not.toContain('depth <');          // no artificial depth cap — runs to fixpoint
  });

  test('until(loops().is(n)) tests the depth counter, not an element', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.loops().is(2))');
    expect(p.sql).toContain('c1.depth + 1 = ?');     // done = (new depth) = 2
  });

  test('while-do (until before repeat) qualifies the seed id in the correlated predicate', () => {
    const p = read('g.V(3).until(__.has("name","lop")).repeat(__.out())');
    // seed source aliased `w` so until()'s (SELECT props FROM nodes WHERE id=w.id) is
    // not the `id=id` self-match that would read the wrong row.
    expect(p.sql).toContain('WHERE id=w.id');
    expect(p.sql).not.toContain('WHERE id=id');
  });

  test('until().path() carries both the JSONB path array and the done column', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.has("name","ripple")).path()');
    expect(p.sql).toContain('jsonb_insert');
    expect(p.sql).toContain('AS done');
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex' });
  });

  test('until(__.out()) correlates the EXISTS on the walk row, not itself (alias collision)', () => {
    // The walk aliases its edges `e`; compileExists must NOT reuse `e` or its EXISTS
    // would shadow to `e.src=e.tgt` (a self-loop test disconnected from the walk).
    const p = read('g.V(1).repeat(__.out()).until(__.out())');
    expect(p.sql).toContain('EXISTS(SELECT 1 FROM edges xe WHERE xe.src=e.tgt)');
    expect(p.sql).not.toContain('xe.src=xe.tgt');
  });

  test('until() defers the combinations not yet built', () => {
    expect(() => compile('g.V(1).repeat(__.out()).until(__.has("name","x")).times(3)', {})).toThrow('until() together with times() not yet supported');
    expect(() => compile('g.V(1).repeat(__.out()).emit().until(__.has("name","x"))', {})).toThrow('until() together with emit() not yet supported');
    expect(() => compile('g.V(1).repeat(__.out())', {})).toThrow('repeat() requires times(), until(), or emit()');
  });
});

// ---------- L2: execution semantics against a seeded store ----------

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  seedModern(store);
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('compiler execution semantics', () => {
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
    store.query('INSERT INTO nodes(id,label,props) VALUES(?,?,?)', [1, person, JSON.stringify({ name: 'ouro' })]);
    store.query('INSERT INTO edges(id,src,label,tgt,props) VALUES(?,?,?,?,?)', [2, 1, self, 1, '{}']);
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

  test('select("a").by(key) projects a property of the labelled element', () => {
    const store = seededStore();
    const names = run(store, 'g.V(1).as("a").out("knows").as("b").select("b").by("name")').map((r) => r.v).sort();
    expect(names).toEqual(['josh', 'vadas']);
  });

  test('multi-label select yields the paired elements per traverser', () => {
    const store = seededStore();
    // map shape: each row has e0_/e1_ columns; verify the (a,b) name pairs
    const rows = run(store, 'g.V(1).as("a").out("knows").as("b").select("a","b").by("name")');
    const pairs = rows.map((r) => [r.e0_v, r.e1_v]).sort((x, y) => x[1].localeCompare(y[1]));
    expect(pairs).toEqual([['marko', 'josh'], ['marko', 'vadas']]);
  });

  test('project builds columns from the current traverser', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().hasLabel("person").project("name","age").by("name").by("age")');
    const byName = Object.fromEntries(rows.map((r) => [r.e0_v, r.e1_v]));
    expect(byName).toEqual({ marko: 29, vadas: 27, josh: 32, peter: 35 });
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
  });

  test('group scalar-list drops members missing the property (json_group_array + null filter is in handler)', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().group().by("name").by("age")');
    const byName = Object.fromEntries(rows.map((r) => [r.gk, r.gv]));
    expect(byName.marko).toBe('[29]');
    expect(byName.lop).toBe('[null]'); // SQL keeps null; handler strips it to [] on frame
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
  });

  test('optional()/flatMap() multi-hop execute correctly', () => {
    const store = seededStore();
    // multi-hop optional HIT: marko out().out() = josh's creations = lop,ripple
    expect(run(store, 'g.V(1).optional(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
    // multi-hop optional MISS → self: peter out().out() empty → peter
    expect(run(store, 'g.V(6).optional(__.out().out()).values("name")').map((r) => r.v)).toEqual(['peter']);
    // optional(both()) hit: vadas both = marko (knows-in)
    expect(run(store, 'g.V(2).optional(__.both()).values("name")').map((r) => r.v)).toEqual(['marko']);
    // flatMap = inline the body: marko out().out() = lop,ripple
    expect(run(store, 'g.V(1).flatMap(__.out().out()).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
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
  });

  test('map(__.<scalar>) executes per-traverser', () => {
    const store = seededStore();
    // out-degree per vertex: marko3, josh2, peter1, vadas/lop/ripple 0
    expect(run(store, 'g.V().map(__.out().count())').map((r) => r.v).sort((a, b) => a - b)).toEqual([0, 0, 0, 1, 2, 3]);
    // per-vertex property projection
    expect(run(store, 'g.V(1).out("knows").map(__.values("name"))').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
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
    // SQL: the predicate correlates on the alias column, read back by subquery
    expect(read('g.V().as("a").out().where(__.as("a").values("name").is("marko"))').sql)
      .toContain("(SELECT props FROM nodes WHERE id=p.a0)");
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
  });

  test('match() deferrals fail closed', () => {
    expect(() => compile('g.V().match(__.as("a").both().as("b"))', {})).toThrow('both()');
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
    expect(run(store, 'g.V().values("name").fold()').map((r) => r.v).sort())
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

  test('property() updates existing vertices (overwrite + new key, single cardinality)', () => {
    const store = seededStore();
    // overwrite marko's age, add a new key
    const res = run(store, 'g.V(1).property("age", 30).property("city", "London")');
    expect((res[0] as any).vertex).toEqual({ id: 1, label: 'person', props: { name: 'marko', age: 30, city: 'London' } });
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

  test('property(Cardinality.single) allowed; list/set deferred to W4', () => {
    const store = seededStore();
    run(store, 'g.V(1).property(Cardinality.single, "age", 40)');
    expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([40]);
    expect(() => run(store, 'g.V(1).property(Cardinality.list, "nick", "x")')).toThrow(/W4/);
  });

  test('property() updates edges too (materialized on the wire via edgeBuffer)', () => {
    const store = seededStore();
    const res = run(store, 'g.V(1).outE("created").property("weight2", 0.9)');
    expect((res[0] as any).edge.props).toEqual({ weight: 0.4, weight2: 0.9 });
    expect(run(store, 'g.V(1).outE("created").values("weight2")').map((r) => r.v)).toEqual([0.9]);
  });

  test('addE start-step: from()/to() nested traversals + edge property', () => {
    const store = seededStore();
    const res = run(store, 'g.addE("knows").from(__.V().has("name","marko")).to(__.V().has("name","vadas")).property("weight", 0.9)');
    expect((res[0] as any).edge).toMatchObject({ label: 'knows', src: 1, tgt: 2, props: { weight: 0.9 } });
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

  test('mergeV creates when no match, matches when it exists (inline map)', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    const a = run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
    expect((a[0] as any).vertex).toMatchObject({ label: 'person', props: { name: 'marko' } });
    // second identical merge matches the first → still one vertex
    run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
    expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
    expect(run(store, 'g.V().hasLabel("person").has("name","marko").count()').map((r) => r.v)).toEqual([1]);
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

  test('path() interleaves edges and vertices with materialized props (via handler)', async () => {
    const { makeHandler } = await import('../src/handler.ts');
    const { ioc } = await import('../src/io.ts');
    const handler = makeHandler(seededStore());
    const res = await handler(new Request('http://x/', { method: 'POST', body: JSON.stringify({ gremlin: 'g.V(1).outE("created").inV().path()' }) }));
    const buf = Buffer.from(await res.arrayBuffer());
    const { v: path } = ioc.anySerializer.deserialize(buf.subarray(2)); // skip 0x84,0x00
    expect(path.constructor.name).toBe('Path');
    expect(path.objects.map((o: any) => o.constructor.name)).toEqual(['Vertex', 'Edge', 'Vertex']);
    expect(path.labels).toEqual([new Set(), new Set(), new Set()]); // labels-on-path deferred
    // The reason for hand-framing: vertex props survive (client's serializer drops them).
    expect(path.objects[0].properties.map((p: any) => ({ [p.label]: p.value }))).toEqual([{ name: 'marko' }, { age: 29 }]);
  });

  // ---------- recursive repeat().path() (modern-graph semantics) ----------

  // Decode every Path from a framed GraphBinary response (shared by the recursive tests).
  async function decodePaths(store: GraphStore, gremlin: string): Promise<any[]> {
    const { makeHandler } = await import('../src/handler.ts');
    const { ioc } = await import('../src/io.ts');
    const res = await makeHandler(store)(new Request('http://x/', { method: 'POST', body: JSON.stringify({ gremlin }) }));
    let c = Buffer.from(await res.arrayBuffer()).subarray(2); // skip 0x84,0x00
    const out: any[] = [];
    while (c[0] !== 0xfd) { const { v, len } = ioc.anySerializer.deserialize(c); out.push(v); c = c.subarray(len); }
    return out;
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
    store.query('INSERT INTO nodes(id,label,props) VALUES(1,?,?),(2,?,?)', [person, '{}', person, '{}']);
    store.query('INSERT INTO edges(id,src,label,tgt,props) VALUES(10,1,?,2,?),(11,1,?,2,?)', [knows, '{}', knows, '{}']);
    const npaths = (q: string) => new Set((run(store, q) as any[]).map((r) => r.pk)).size;
    // two parallel 1→2 edges → out() reaches 2 twice → two identical [1,2] paths.
    expect(npaths('g.V(1).repeat(__.out()).times(1).path()')).toBe(2);
    expect(npaths('g.V(1).repeat(__.out()).times(1).path().dedup()')).toBe(1); // collapsed
  });

  // ---------- repeat().until() (modern-graph semantics) ----------

  const uNames = (store: GraphStore, q: string) => (run(store, q) as any[]).map((r) => JSON.parse(r.props).name);

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
    const node = 'INSERT INTO nodes(id, label, props) VALUES(?,?,?)';
    const edge = 'INSERT INTO edges(id, src, label, tgt, props) VALUES(?,?,?,?,?)';
    const N = 40; // deeper than the retired cap
    for (let i = 0; i <= N; i++) store.query(node, [i + 1, person, JSON.stringify({ name: `n${i}` })]);
    for (let i = 0; i < N; i++) store.query(edge, [100 + i, i + 1, knows, i + 2, '{}']); // n0→n1→…→n40
    expect(uNames(store, `g.V(1).repeat(__.out()).until(__.has("name","n${N}"))`)).toEqual([`n${N}`]);
  });
});
