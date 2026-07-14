import { test, expect, describe } from 'bun:test';
import { compile } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
import { MODERN_SEED } from './conformance/seed-modern.ts';

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
    expect(asc.sql).toContain("ORDER BY (SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) ASC");
    expect(asc.binds).toEqual(['person', 'name', 'age']); // label, then the values() join key + the order key (bound)

    const desc = read('g.V().hasLabel("person").order().by("age",desc).values("name")');
    expect(desc.sql).toContain("ORDER BY (SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) DESC");
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
    expect(str.sql).toContain("typeof(vp.value) = ?");
    expect(str.binds).toContain('text');
    expect(read('g.V().values("age").is(P.typeOf(GType.INT))').binds).toContain('integer');
    // java class-name string form is equivalent
    expect(read('g.V().values("name").is(P.typeOf("String"))').binds).toContain('text');
    // has(): typeof over the property expression
    expect(read('g.V().has("name", P.typeOf(GType.STRING))').sql).toContain("typeof(value) = ?");
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
    // A TERMINAL fold() is unchanged: N rows collapsed to one List by the handler.
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'list', elem: 'scalar' });
    // A NON-terminal fold() retypes to a JSONB list value (jsonb(json_group_array)),
    // and unfold() explodes it (json_each) — the stream continues. fold().unfold() is
    // an identity roundtrip (deliberately not peepholed).
    const fu = read('g.V().fold().unfold()');
    expect(fu.shape).toEqual({ kind: 'vertex' });
    expect(fu.sql).toContain('json_group_array');
    expect(fu.sql).toContain('json_each');
    // scalar list: values().fold().unfold() → a scalar `v` stream again.
    expect(read('g.V().values("name").fold().unfold()').shape).toEqual({ kind: 'value' });
    // unfold() directly on an element stream is identity (a vertex is not a collection).
    expect(read('g.V().unfold()').shape).toEqual({ kind: 'vertex' });
    // continuation after the roundtrip: movement/projection resume as a fresh phase.
    expect(read('g.V().hasLabel("person").fold().unfold().values("name")').shape).toEqual({ kind: 'value' });
    // Scope.local reducers reduce EACH folded list to one scalar (per-list, not global).
    expect(read('g.V().fold().count(Scope.local)').shape).toEqual({ kind: 'count' });
    expect(read('g.V().values("age").fold().sum(Scope.local)').shape).toEqual({ kind: 'scalar' });
    expect(read('g.V().values("age").fold().sum(Scope.local)').sql).toContain('json_each');
    // a trailing step after a local reducer, and inject-as-list, are later commits.
    expect(() => compile('g.V().values("age").fold().sum(Scope.local).is(P.gt(1))', {})).toThrow('step after sum(Scope.local) not yet supported');
  });

  test('inject([...]) is a real list value (not flattened)', () => {
    // Each bracket arg is ONE list traverser → a JSONB list-value stream.
    expect(read('g.inject([1,3,100,300])').shape).toEqual({ kind: 'jsonbList' });
    expect(read('g.inject([1,2],[3,4])').shape).toEqual({ kind: 'jsonbList' });
    // unfold() explodes the list back to a scalar stream.
    expect(read('g.inject([1,2,3]).unfold()').shape).toEqual({ kind: 'value' });
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
    // null-safe set membership (IS, not =) so null intersects/differs correctly.
    expect(read('g.inject(["a",null,"b"]).difference(["a","c"])').sql).toContain('o.value IS je.value');
    // a Set followed by a list op (order(Scope.local)) degrades to a List (not a Set).
    expect(read('g.V().values("age").fold().intersect([27]).order(Scope.local)').shape).toEqual({ kind: 'jsonbList' });
    // constant(c).fold() is a valid compile-time operand; a standalone traversal defers.
    expect(read('g.V().values("age").fold().intersect(__.constant(27).fold())').shape).toEqual({ kind: 'jsonbSet' });
    expect(() => compile('g.V().fold().combine(__.V().fold())', {})).toThrow('nested-traversal operand not yet supported');
    // argument-type errors mirror TinkerPop's messages.
    expect(() => compile('g.V().fold().combine(2)', {})).toThrow('can only take an array or an Iterable as an argument');
    expect(() => compile('g.V().fold().combine(null)', {})).toThrow("can't be null");
    // product → a list of pair-lists; conjoin → a scalar string.
    expect(read('g.V().values("age").fold().product([1]).unfold()').shape).toEqual({ kind: 'jsonbList' });
    expect(read('g.V().values("name").order().fold().conjoin("_")').shape).toEqual({ kind: 'value' });
    // all(P)/any(P) filter the list (IS TRUE / IS NOT TRUE null handling).
    expect(read('g.V().values("age").order().fold().all(P.gt(10))').sql).toContain('IS NOT TRUE');
    expect(read('g.V().values("age").order().fold().any(P.gt(10))').sql).toContain('IS TRUE');
    // a list-collection step on a scalar stream raises the incoming-type error.
    expect(() => compile('g.V().values("name").fold().unfold().combine([1])', {})).toThrow('incoming traversers');
  });

  test('group()/groupCount() retypes to a MapStream on a follower (select(Column.*))', () => {
    // A TERMINAL group() is unchanged — the row-folding groupBuffer Map.
    expect(read('g.V().groupCount().by("name")').shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    // A NON-terminal group() retypes → MapStream; select(Column.values) aggregates the
    // value column into a list value (one row), unfold() explodes it. Count → Long tag.
    const gv = read('g.V().groupCount().by("name").select(Column.values)');
    expect(gv.shape).toEqual({ kind: 'jsonbList' });
    expect(gv.sql).toContain('json_group_array');
    expect(read('g.V().groupCount().by("name").select(Column.values).unfold()').shape).toEqual({ kind: 'value', as: 'long' });
    // select(Column.keys) over a scalar key → a scalar stream on unfold.
    expect(read('g.V().groupCount().by("name").select(Column.keys).unfold()').shape).toEqual({ kind: 'value' });
    // Element keys (bare groupCount()) carry their rowid → unfold rejoins vertices.
    expect(read('g.V().groupCount().select(Column.keys).unfold()').shape).toEqual({ kind: 'vertex' });
    // group().by(k).by(__.count()) → same scalar-valued map path.
    expect(read('g.V().group().by("name").by(__.count()).select(Column.values).unfold()').shape).toEqual({ kind: 'value', as: 'long' });
  });

  test('list-VALUED map: group().by().by(__.out()...fold()).select(Column.values)', () => {
    // A neighbour-list value → a list-valued map; select(Column.values) yields a
    // list-of-lists, unfold() explodes to per-list rows, order(Scope.local) sorts each.
    const g = read('g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local)');
    expect(g.shape).toEqual({ kind: 'jsonbList' });
    // The neighbour-list is one correlated JSONB array per key (edge-id order).
    expect(g.sql).toContain('json_group_array');
    // A pre-fold op folds into the correlated subquery (dedup/limit/tail).
    expect(read('g.V().group().by().by(__.out().label().dedup().fold()).select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList' });
    // A non-element key with a neighbour-list value defers (MAX would pick one member).
    expect(() => compile('g.V().group().by("name").by(__.out().label().fold()).select(Column.values)', {}))
      .toThrow('non-element key and a neighbour-list value not yet supported');
  });

  test("cap('a') of a group side-effect retypes to a MapStream on a follower", () => {
    // A group('a')/groupCount('a') side-effect, re-emitted by cap('a'), is re-enterable
    // too: select(Column.values)/unfold compose exactly like an inline group().
    expect(read('g.V().groupCount("a").by("name").cap("a").select(Column.values).unfold()').shape).toEqual({ kind: 'value', as: 'long' });
    expect(read('g.V().group("a").by().by(__.out().label().fold()).cap("a").select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList' });
  });

  test('Scope.local collection transforms reshape a list (order/dedup/limit/tail)', () => {
    // A non-terminal fold() → ListStream; a Scope.local transform rebuilds each list
    // (correlated json_each) and stays a list, so unfold() re-enters afterwards.
    const o = read('g.V().values("age").fold().order(Scope.local)');
    expect(o.shape).toEqual({ kind: 'jsonbList' });
    expect(o.sql).toContain('json_group_array');
    // order().by(Order.desc) — direction-only by() flips the sort.
    expect(read('g.V().values("age").fold().order(Scope.local).by(Order.desc).unfold()').shape).toEqual({ kind: 'value' });
    // tail avoids a count() subquery (DESC LIMIT then re-sort asc) so it correlates once.
    const t = read('g.V().values("age").fold().tail(Scope.local,2).unfold()');
    expect(t.shape).toEqual({ kind: 'value' });
    expect(t.sql).toContain('DESC');
    expect(read('g.V().values("age").fold().dedup(Scope.local).unfold()').shape).toEqual({ kind: 'value' });
    // Transforms compose: order then skip, both per-list, then unfold.
    expect(read('g.V().values("age").fold().order(Scope.local).skip(Scope.local,2).unfold()').shape).toEqual({ kind: 'value' });
    // A by(key)/traversal comparator defers clearly.
    expect(() => compile('g.V().values("age").fold().order(Scope.local).by("age")', {})).toThrow('order(Scope.local).by(key/traversal) not yet supported');
  });

  test('Scope.local reducer on a SCALAR stream is per-element (degenerate 1-list)', () => {
    // A scalar's local sum/min/max is the value itself (identity); shape stays value.
    expect(read('g.V(1).values("age").sum(Scope.local)').shape).toEqual({ kind: 'value' });
    expect(read('g.V(1).values("age").max(Scope.local)').shape).toEqual({ kind: 'value' });
    // mean is ALWAYS Double, even of one value (d[29.0].d) → CAST to REAL, tagged double.
    const mn = read('g.V(1).values("age").mean(Scope.local)');
    expect(mn.shape).toEqual({ kind: 'value', as: 'double' });
    expect(mn.sql).toContain('CAST(');
    // a scalar TRANSFORM's Scope.local stays a no-op (per-element == per-list).
    expect(read('g.V().values("name").toLower(Scope.local)').sql).toContain('lower(');
    // count(local)/limit(local) on a scalar stream aren't worked out yet → fail closed.
    expect(() => compile('g.V().values("age").count(Scope.local)', {})).toThrow('requires a preceding list-producing step');
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
    expect(f.sql).toContain('CAST(vp.value AS REAL)');
    // is(P.typeOf(X)) on the uniformly-typed stream rides the existing storage-class
    // typeOf — no precision change needed
    expect(read('g.V().values("weight").asNumber(GType.FLOAT).is(P.typeOf(GType.FLOAT))').sql).toContain("typeof(CAST(");
    // overflow + non-numeric-token errors raise TinkerPop's exact messages
    expect(() => compile('g.inject(32768).asNumber(GType.SHORT)', {})).toThrow('Can\'t convert number of type Integer to Short due to overflow.');
    expect(() => compile('g.inject(300).asNumber(GType.BYTE)', {})).toThrow('Can\'t convert number of type Integer to Byte due to overflow.');
    expect(() => compile('g.inject(5).asNumber(GType.VERTEX)', {})).toThrow('asNumber() requires a numeric type token, got VERTEX');
    // a reducer after asNumber() would drop the subtype tag → defer
    expect(() => compile('g.inject(2.0).asNumber(GType.FLOAT).sum()', {})).toThrow('composed with a reducer');
    // overflow message uses the boxed Java type name (Integer, not Int)
    expect(() => compile('g.inject(3000000000).asNumber(GType.INT)', {})).toThrow('to Integer due to overflow.');
    // blank string is a parse error, not a silent 0
    expect(() => compile('g.inject("").asNumber(GType.INT)', {})).toThrow("Can't parse string '' as number.");
    // a composed cast over inject would skip the overflow check (raw serializer crash) → defer
    expect(() => compile('g.inject(300).asNumber(GType.INT).asNumber(GType.BYTE)', {})).toThrow('composed with other transforms over inject()');
  });

  test('bare asNumber() recovers the input literal subtype (via Step.argTypes)', () => {
    // The frontend flattens numeric-literal values (5b/5l/5.0 → 5) but records the
    // declared subtype in argTypes; bare asNumber() reads it back to tag the shape.
    expect(read('g.inject(5b).asNumber()').shape).toEqual({ kind: 'value', as: 'byte' });
    expect(read('g.inject(5s).asNumber()').shape).toEqual({ kind: 'value', as: 'short' });
    expect(read('g.inject(5i).asNumber()').shape).toEqual({ kind: 'value', as: 'int' });
    expect(read('g.inject(5l).asNumber()').shape).toEqual({ kind: 'value', as: 'long' });
    expect(read('g.inject(5n).asNumber()').shape).toEqual({ kind: 'value', as: 'bigint' });
    expect(read('g.inject(5.0).asNumber()').shape).toEqual({ kind: 'value', as: 'double' });
    expect(read('g.inject(5.75f).asNumber()').shape).toEqual({ kind: 'value', as: 'float' });
    // un-suffixed integer → int, un-suffixed decimal → double; numeric string → int
    expect(read('g.inject(5).asNumber()').shape).toEqual({ kind: 'value', as: 'int' });
    expect(read("g.inject('5').asNumber()").shape).toEqual({ kind: 'value', as: 'int' });
    // a numeric string is int vs double by its textual form, not its value ("5.0"→double)
    expect(read("g.inject('5.0').asNumber()").shape).toEqual({ kind: 'value', as: 'double' });
    expect(read("g.inject('5e2').asNumber()").shape).toEqual({ kind: 'value', as: 'double' });
    // non-numeric string raises the parse error
    expect(() => compile("g.inject('test').asNumber()", {})).toThrow("Can't parse string 'test' as number.");
    // a stream mixing subtypes can't share one tag → defer
    expect(() => compile('g.inject(5b,5l).asNumber()', {})).toThrow('mixed numeric subtypes');
  });

  test('math("<formula>") compiles to one Double scalar; leaves coerced to REAL', () => {
    // `_` resolves through the by() modulator; result always tagged Double.
    const p = read('g.V().math("_+_").by("age")');
    expect(p.shape).toEqual({ kind: 'value', as: 'double' });
    expect(p.sql).toContain("(CAST((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS REAL) + CAST((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS REAL)) AS v");
    // a missing by() value makes the arithmetic NULL → the traverser is filtered
    expect(p.sql).toContain('is not null');
    // `0-_` (subtraction-based negation) on an edge property
    expect(read('g.V().outE().math("0-_").by("weight")').sql).toContain("(0.0 - CAST(json_extract(n.props, '$.weight') AS REAL))");
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
  });

  test('math() variables: `_` = current, an identifier = an as()-bound alias', () => {
    // named aliases resolve via the carried rowid column (correlated subquery); one
    // by() feeds every variable (round-robin), N by()s feed N variables positionally.
    const shared = read('g.V().as("a").out("knows").as("b").math("a + b").by("age")');
    expect(shared.sql).toContain("(SELECT value FROM vertex_properties WHERE node=p.a0 AND key=? ORDER BY id LIMIT 1)");
    expect(shared.sql).toContain("(SELECT value FROM vertex_properties WHERE node=p.a1 AND key=? ORDER BY id LIMIT 1)");
    // per-variable by(): first-seen order (`b` before `a`), nested traversal + key
    const perVar = read('g.V().as("a").out("created").as("b").math("b + a").by(__.in("created").count()).by("age")');
    expect(perVar.sql).toContain('COUNT(*)');                 // b ← by(__.in("created").count())
    expect(perVar.sql).toContain("node=p.a0 AND key=?");      // a ← by("age")
    // math() composes with a trailing typed cast (result narrows to the cast's subtype)
    expect(read('g.V().as("a").out("knows").as("b").math("a + b").by("age").asNumber(GType.INT)').shape)
      .toEqual({ kind: 'value', as: 'int' });
    // defers: a variable with no by(), and an unbound identifier
    expect(() => compile('g.V().math("_+_")', {})).toThrow('needs a by() modulator');
    expect(() => compile('g.V().math("a + b").by("age")', {})).toThrow('no such variable "a"');
  });

  test('asDate() casts to a date-tagged epoch-millis value (const-fold + runtime)', () => {
    // inject const-fold: ISO string / int / long epoch → millis, tagged date
    expect(read('g.inject("2023-08-02T00:00:00Z").asDate()').shape).toEqual({ kind: 'value', as: 'date' });
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
    expect(rt.shape).toEqual({ kind: 'value', as: 'date' });
    expect(rt.sql).toContain("unixepoch(vp.value) * 1000");
    // bare asNumber() over a date → its epoch-millis (Long, identity); asDate composes back
    expect(read('g.V().values("birthday").asDate().asNumber().asDate()').shape).toEqual({ kind: 'value', as: 'date' });
    // bare asNumber() as the ms-string leg feeding asDate() is allowed; standalone it
    // can't recover a subtype from a runtime value → fail closed (not a silent CAST)
    expect(read('g.V().values("birthday").asNumber().asDate()').shape).toEqual({ kind: 'value', as: 'date' });
    expect(() => compile('g.V().values("weight").asNumber()', {})).toThrow('non-date runtime value');
    // an offset-less datetime literal is UTC-normalized (not host-local) so Bun ≡ DO
    expect(read("g.inject(datetime('2023-08-02T00:00:00')).dateAdd(second, 0)").binds).toEqual([Date.parse('2023-08-02T00:00:00Z')]);
  });

  test('dateAdd(DT.unit, n) / dateDiff(date) — integer millis arithmetic', () => {
    // dateAdd folds n * fixed-width-unit millis; bare or DT.-prefixed unit; negative n
    const base = Date.parse('2023-08-02T00:00:00Z');
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(DT.hour, 2)").binds).toEqual([base + 2 * 3600000]);
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(hour, -1)").binds).toEqual([base - 3600000]);
    expect(read("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(day, 11)").shape).toEqual({ kind: 'value', as: 'date' });
    // only second/minute/hour/day are valid DT units — the grammar rejects the rest
    expect(() => compile("g.inject(datetime('2023-08-02T00:00:00Z')).dateAdd(month, 1)", {})).toThrow('parse error');
    // dateDiff = self − other → signed Long; literal / constant(datetime) / constant(null)→0
    const d = read("g.inject(datetime('2023-08-02T00:00:00Z')).dateDiff(datetime('2023-08-09T00:00:00Z'))");
    expect(d.shape).toEqual({ kind: 'value', as: 'long' });
    expect(d.binds).toEqual([-604800000]);
    expect(read("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(constant(datetime('2023-08-01T00:00:00Z')))").binds).toEqual([604800000]);
    // runtime dateDiff against a literal → v − other_ms (the epoch bound as a value)
    const rd = read('g.V().values("birthday").asNumber().asDate().dateDiff(datetime("1970-01-01T00:00Z"))');
    expect(rd.shape).toEqual({ kind: 'value', as: 'long' });
    expect(rd.binds).toEqual([Date.parse('1970-01-01T00:00Z'), 'birthday']); // the other epoch (= 0), then the values() join key
    // nested inject() as the dateDiff operand defers (not a literal/constant)
    expect(() => compile("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(inject(datetime('2023-10-11T00:00:00Z')))", {})).toThrow('datetime literal or constant');
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
    // concat skips nulls (concat_ws) so an all-null result is null, not '' (Gremlin semantics)
    expect(read('g.inject("a","b").concat("c")').sql).toContain("concat_ws('', v, ?)");
    expect(read('g.inject("a").length()').sql).toContain('length(v)');
    expect(read('g.inject("A").toLower()').sql).toContain('lower(v)');
    expect(read('g.inject("a").toUpper()').sql).toContain('upper(v)');
    expect(read('g.inject(1).asString()').sql).toContain('CAST(v AS TEXT)');
    expect(read('g.inject("hello").substring(1,8)').sql).toContain('substr(v');
    expect(read('g.inject("that").replace("h","j")').sql).toContain('replace(v');
    // Scope.local on a scalar stream is a no-op (per-element == per-list)
    expect(read('g.inject("a").length(Scope.local)').sql).toContain('length(v)');
    // transforms chain — composed inline (upper(v || ?)), one shared value tail
    expect(read('g.inject("a").concat("b").toUpper()').sql).toContain('upper(concat_ws(');
    // trim family → SQLite trim/ltrim/rtrim over the Java-whitespace char set
    expect(read('g.inject(" a ").trim()').sql).toContain('trim(v, ?)');
    expect(read('g.inject(" a ").lTrim()').sql).toContain('ltrim(v, ?)');
    expect(read('g.inject(" a ").rTrim()').sql).toContain('rtrim(v, ?)');
    // reverse: string reverses chars (recursive CTE), non-string is identity
    expect(read('g.inject("ab").reverse()').sql).toContain('WITH RECURSIVE rev(');
  });

  test('scalar transforms also wrap an element value projection', () => {
    expect(read("g.V().values('name').substring(2)").sql).toContain("substr(vp.value");
    expect(read("g.V().values('name').toUpper()").sql).toContain("upper(vp.value)");
    expect(read("g.V().values('name').concat('X')").sql).toContain("concat_ws('', vp.value, ?)");
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
    expect(p.sql).toContain('vp.value AS v');
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
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS v");
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
    // withoutStrategies(anything) is a safe no-op: we apply NO strategy by default,
    // so there is nothing to suppress — including for semantic strategies.
    expect(() => compile('g.withoutStrategies(PartitionStrategy).V()', {})).not.toThrow();
    expect(() => compile('g.withoutStrategies(SubgraphStrategy, ProductiveByStrategy).V()', {})).not.toThrow();
  });

  test('SubgraphStrategy injects the vertex criterion as a filter after every vertex step', () => {
    // vertices: __.has(k,P) → a where() filter CTE spliced after V() (and after each
    // out/in/both). Both endpoints of a hop are checked: source filtered before, the
    // moved-to vertex filtered after.
    const sql = read('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("a","b")))).V().values("name")').sql;
    expect(sql).toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value in (?, ?))'); // criterion applied
    // after V() the filter is c1 (source c0 → filtered c1)
    expect(sql).toMatch(/c1\(id\) as \(SELECT n\.id FROM nodes n JOIN c0 p .* WHERE EXISTS\(SELECT 1 FROM vertex_properties WHERE node=n\.id AND key=\? AND value in/);
  });

  test('PartitionStrategy read-filter isolates partitions; write-stamp tags created elements', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // write two vertices into partitions a and b via the write-stamp
    run(store, 'g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).addV("person").property("name","marko")');
    run(store, 'g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"b")).addV("person").property("name","josh")');
    // the stamp is a real property (normalized into vertex_properties)
    expect(store.query("SELECT value p FROM vertex_properties WHERE key='_p' ORDER BY node").map((r: any) => r.p)).toEqual(['a', 'b']);
    // read visibility follows readPartitions
    const names = (q: string) => run(store, q).map((r: any) => r.v).sort();
    expect(names('g.V().values("name")')).toEqual(['josh', 'marko']); // unfiltered: both
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a"])).V().values("name")')).toEqual(['marko']);
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a","b"])).V().values("name")')).toEqual(['josh', 'marko']);
    // empty readPartitions → sees nothing
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:[])).V().values("name")')).toEqual([]);
    // writePartition-only (readPartitions OMITTED) defaults to EMPTY → sees nothing,
    // NOT everything. Gating the read filter on presence would leak all data.
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).V().values("name")')).toEqual([]);
  });

  test('SubgraphStrategy filters real traversal results end-to-end', () => {
    const store = seededStore();
    const names = (q: string) => run(store, q).map((r: any) => r.v).sort();
    // only marko + josh are "in" the subgraph; count and values both respect it
    expect(run(store, 'g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V().count()').map((r: any) => r.v)).toEqual([2]);
    expect(names('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V().values("name")')).toEqual(['josh', 'marko']);
    // a hop lands only on vertices inside the subgraph: marko knows vadas+josh, but
    // vadas is filtered out → only josh survives
    expect(names('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().has("name","marko").out("knows").values("name")')).toEqual(['josh', 'vadas']);
  });

  test('verification strategies throw TinkerPop\'s canonical messages (pass a legal traversal)', () => {
    // ReadOnly: any mutating step rejected; a read passes.
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).V().out("knows").values("name")', {})).not.toThrow();
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).addV("person")', {}))
      .toThrow('The provided traversal has a mutating step and thus is not read only');
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).E().property("weight",0)', {}))
      .toThrow('The provided traversal has a mutating step and thus is not read only');
    // EdgeLabel: bare out() rejected only when throwException:true; false → no-op pass.
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true, logWarning:false)).V().out()', {}))
      .toThrow('The provided traversal contains a vertex step without any specified edge label');
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:false)).V().out()', {})).not.toThrow();
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true)).V().out("knows")', {})).not.toThrow();
    // ReservedKeys: default {id,label}; config keys overrides. Message names the key.
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true)).addV("person").property("id",123)', {}))
      .toThrow('is setting a property key to a reserved word: id');
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true, keys:{"age"})).addV("person").property("age",29)', {}))
      .toThrow('is setting a property key to a reserved word: age');
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true)).addV("person").property("name","marko")', {})).not.toThrow();
    // `to` is only a vertex step in the to(Direction) form — an addE().to(__.V(...))
    // endpoint modulator must NOT trip EdgeLabel verification.
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true)).addE("knows").from(__.V(1)).to(__.V(2))', {})).not.toThrow();
  });

  test('semantic/unknown strategies + deferred forms fail closed (never silently leak)', () => {
    // ProductiveByStrategy changes by() null semantics — not an optimization. Reject.
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().values("name")', {}))
      .toThrow('withStrategies(...) is not supported');
    // Mixed list: one unsafe strategy poisons the whole call (Count is safe, ProductiveBy not).
    expect(() => compile('g.withStrategies(CountStrategy, ProductiveByStrategy).V()', {}))
      .toThrow('withStrategies(...) is not supported');
    // Deferred subsets throw clearly rather than under-filter:
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.has("name","x"), edges: __.has("weight",1))).V()', {}))
      .toThrow('SubgraphStrategy(edges) criterion not yet supported');
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.has("name","x"))).V().outE("knows")', {}))
      .toThrow('SubgraphStrategy with an edge step');
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.has("name","x"))).V().repeat(__.out()).times(2)', {}))
      .toThrow('SubgraphStrategy with a repeat() sub-traversal');
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).mergeV([(T.label):"person"])', {}))
      .toThrow('PartitionStrategy with mergeV() not yet supported');
    // Nested sub-traversals that PRODUCE elements would be computed unfiltered (leak)
    // — must defer, not under-filter. map/group by-modulator movement, and/or nested
    // inside a where() criterion, and an addE nested endpoint all fail closed.
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a"])).V().map(__.out().count())', {}))
      .toThrow('element-producing sub-traversal inside map()');
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a"])).V().group().by(__.out().count())', {}))
      .toThrow('element-producing sub-traversal inside by()');
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().where(__.or(__.out("knows"), __.out("created")))', {}))
      .toThrow('element-producing sub-traversal inside where()');
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a"], writePartition:"a")).V().as("x").addE("knows").from("x").to(__.V(2))', {}))
      .toThrow('element-producing sub-traversal inside to()');
    // ...but a NON-producing nested body (scalar map, has-only criterion, alias
    // endpoint) still compiles — the guard is precise, not blanket.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().map(__.values("name"))', {})).not.toThrow();
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().where(__.has("name","marko"))', {})).not.toThrow();
    // withoutStrategies suppresses a co-named withStrategies (removal wins) — so a
    // withoutStrategies(ProductiveBy) makes the otherwise-rejected call compile.
    expect(() => compile('g.withStrategies(ProductiveByStrategy).withoutStrategies(ProductiveByStrategy).V().values("name")', {})).not.toThrow();
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
    expect(() => compile('g.E().elementMap()', {})).toThrow('elementMap() on edges not yet supported');
  });

  test('has()/values() on edges filter/project the edges table', () => {
    const h = read('g.E().has("weight",0.5)');
    expect(h.sql).toContain('FROM edges n JOIN c0 p ON n.id=p.id');
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
    expect(p.sql).toContain('JOIN vertex_properties vp ON vp.node=n.id');
    expect(p.shape).toEqual({ kind: 'property' });
    // key filter is an extra JOIN condition, and binds the requested keys
    const named = read('g.V().properties("name","age")');
    expect(named.sql).toContain('AND vp.key IN (?,?)');
    expect(named.binds).toEqual(['name', 'age']);
  });

  test('properties() follow-ons: key/value/count/element project the right column', () => {
    expect(read('g.V().properties().key()').sql).toContain('SELECT pk AS v');
    expect(read('g.V().properties().value()').sql).toContain('SELECT pv AS v');
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'count' });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toContain("(SELECT value FROM vertex_properties WHERE node=owner AND key=? ORDER BY id LIMIT 1)");
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
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS gk");
    expect(p.sql).toContain('COALESCE(n.uid, n.id) AS v_id');
    expect(p.sql).toContain('ORDER BY gk'); // element value → no GROUP BY, ordered for run-folding
  });

  test('group().by(key) default value → element list; group by key reports an index key', () => {
    const p = read('g.V().group().by("name")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'elementList', elem: 'vertex' } });
  });

  test('group().by(key).by(prop) → scalar-list via json_group_array + GROUP BY', () => {
    const p = read('g.V().group().by("name").by("age")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'scalarList' } });
    expect(p.sql).toContain("json_group_array((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1)) AS gv");
    expect(p.sql).toContain('GROUP BY gk');
  });

  test('sack(op).by(key) mutates a carried sk column; bare sack() reads it', () => {
    const p = read('g.V().sack(assign).by("age").sack()');
    expect(p.shape).toEqual({ kind: 'value' });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS sk");
    expect(p.sql).toContain('SELECT p.sk AS v FROM'); // bare sack() reads the carried column
    // sum accumulator references the prior sk; div forces REAL division.
    expect(read('g.withSack(0.0d).V().sack(sum).by("age").sack()').sql).toContain('(p.sk + (SELECT value FROM vertex_properties WHERE node=n.id AND key=?');
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()').sql).toContain('(CAST(p.sk AS REAL) / ?)');
  });

  test('side-effecting group(a)/groupCount(a) → registered spec re-emitted by cap(a)', () => {
    // group('a').by(key).cap('a') → one Map (compileGroup over the stashed source).
    const g = read('g.V().group("a").by("name").cap("a")');
    expect(g.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'elementList', elem: 'vertex' } });
    // groupCount('a') passes traversers through: out() runs between it and cap('a').
    const gc = read('g.V().groupCount("a").by("name").out().cap("a")');
    expect(gc.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
  });

  test('terminal group(a) with no cap passes the traversers through (side-effect discarded)', () => {
    // a side-effecting group() without a cap is a pass-through: the stream is the result.
    expect(read('g.V().group("a").by("name")').shape).toEqual({ kind: 'vertex' });
  });

  test('withSack() seeds the sk column at the source as a bound value', () => {
    const p = read('g.withSack(0.0d).V().outE().sack(sum).by("weight").inV().sack()');
    expect(p.sql).toContain('? AS sk FROM nodes'); // seeded at V()
    expect(p.binds[0]).toBe(0);
    expect(p.sql).toContain('p.sk FROM edges'); // carried through outE()/inV()
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
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.src AND key=? ORDER BY id LIMIT 1) AS k0_v");
    expect(p.sql).toContain('(SELECT name FROM labels WHERE id=n.label) AS k1_v');
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.tgt AND key=? ORDER BY id LIMIT 1) AS k2_v");
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS v_src'); // edge value framing → external endpoint id
  });

  test('properties().group() over the property stream (vertex-property gate)', () => {
    const p = read('g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'n' }, { key: 'k' }, { key: 'v' }] }, val: { kind: 'elementLast', elem: 'property' } });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=c1.owner AND key=? ORDER BY id LIMIT 1) AS k0_v"); // property-group ctx columns typed via the CTE relation
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
    // group() is now re-enterable (retypes to a MapStream on a follower): an element-
    // VALUE group can't collapse to one map-value column, and an unknown step on a
    // (scalar-valued) map defers in the map arm — both clear.
    expect(() => compile('g.V().group().by("name").select(Column.values)', {})).toThrow('select(Column) over a group of element values not yet supported');
    expect(() => compile('g.V().groupCount().by("name").cap("x")', {})).toThrow('cap() on a map value not yet supported');
    expect(() => compile('g.V().group().by(__.out().values("name"))', {})).toThrow(); // deep nested key
    expect(() => compile('g.V().properties().group().by()', {})).toThrow('group().by() on a property element is not yet supported');
    expect(() => compile('g.V().group().by("name").by("age").by("x")', {})).toThrow('more than two by() modulators');
    expect(() => compile('g.V().count().fold()', {})).toThrow('fold() after count() not yet supported');
    expect(() => compile('g.V().sum()', {})).toThrow('sum() of vertex not yet supported');
  });

  // ---- P2b: is / where / not / TextP ----

  test('is(P) folds a predicate onto the projected scalar', () => {
    const gt = read('g.V().values("age").is(P.gt(30))');
    expect(gt.shape).toEqual({ kind: 'value' });
    expect(gt.sql).toContain("WHERE vp.value > ?"); // the values() JOIN handles existence; is() adds the predicate
    expect(gt.binds).toContain(30);
    // bare literal → equality
    expect(read('g.V().values("age").is(29)').sql).toContain("vp.value = ?");
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

  test('where(__.count().is(P)) → correlated scalar compare over incident edges', () => {
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")');
    expect(c.sql).toContain('(SELECT COUNT(*) FROM edges WHERE (tgt=n.id)');
    expect(c.sql).toContain('>= ?');
  });

  test('alias-compare where(P.neq("a")) and where("a",P,by(key)); unknown label throws', () => {
    const idc = read('g.V().as("a").out().where(P.neq("a"))');
    expect(idc.sql).toContain('WHERE n.id != p.a0');
    const keyc = read('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name")');
    expect(keyc.sql).toContain("(SELECT value FROM vertex_properties WHERE node=p.a0 AND key=? ORDER BY id LIMIT 1) = (SELECT value FROM vertex_properties WHERE node=p.a1 AND key=? ORDER BY id LIMIT 1)");
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
      .toContain("EXISTS(SELECT 1 FROM vertex_properties WHERE node=xn0.id AND key=? AND value > ?)");
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
    expect(m.shape).toEqual({ kind: 'value', as: 'long' }); // count() is a Long
    expect(m.sql).toContain('SELECT (SELECT COUNT(*) FROM edges WHERE (src=n.id)) AS v FROM nodes n JOIN c0 p');
    expect(read('g.V(1).map(__.values("name"))').shape).toEqual({ kind: 'value', as: undefined });
    expect(read('g.V(1).map(__.values("name"))').sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS v");
    // element-body map (first-result-only) and select/fold bodies defer
    expect(() => compile('g.V().map(__.out())', {})).toThrow('only supports a terminal count');
    expect(() => compile('g.V().map(__.select("a"))', {})).toThrow('not yet supported');
    expect(() => compile('g.V().map(__.values("name")).map(__.values("age"))', {})).toThrow('step not implemented after map()');
  });

  test('choose(pred, then, else) → gated-seed UNION ALL, arms fold from their seed', () => {
    const c = read('g.V().choose(__.has("name","vadas"), __.out("knows"), __.in("knows"))');
    // two gated seeds off the same source (c0): pred and NOT-pred
    expect(c.sql).toContain("WHERE EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)");
    expect(c.sql).toContain("WHERE NOT COALESCE((EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)), 0)");
    // arms fold through movement; the two element id-relations merge UNION ALL
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    expect(c.binds).toEqual(['name', 'vadas', 'knows', 'name', 'vadas', 'knows']);
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
    expect(c.sql).toContain("CASE WHEN ((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) >= ? and (SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) < ?) THEN ? ELSE ? END AS v");
    expect(c.binds).toEqual(['age', 26, 'age', 30, 'x', 'z']);
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
    // alias-compare by(key) on an edge label throws rather than reading nodes
    expect(() => compile('g.V().as("a").outE().as("e").where("e", P.eq("a")).by("weight")', {})).toThrow('edge-typed label not yet supported');
  });

  test('has() still compiles all predicate forms after the predicateSql refactor', () => {
    expect(read('g.V().has("age", 30)').sql).toContain('= ?');
    expect(read('g.V().has("age", P.gt(30))').sql).toContain('> ?');
    expect(read('g.V().has("age", P.within(29,30))').sql).toContain('in (?, ?)');
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('>= ? and');
  });

  test('vertex property keys bind as parameters (static vp index, no literal splice)', () => {
    // W4: vertex props are normalized into vertex_properties; has(key,val) is an EXISTS
    // with BOTH key and value bound. The static (key,value) index serves a bound key
    // fine (a plain B-tree column, not an expression index), so no literal splice — and
    // no injection surface for any key.
    const safe = read('g.V().has("age",30)');
    expect(safe.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)');
    expect(safe.binds).toEqual(['age', 30]);

    // an exotic key (space) is handled identically — bound, never spliced into SQL
    const exotic = read('g.V().has("first name","x")');
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
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x0n.id AND key=? ORDER BY id LIMIT 1) AS x0_v");
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x1n.id AND key=? ORDER BY id LIMIT 1) AS x1_v");
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x2n.id AND key=? ORDER BY id LIMIT 1) AS x2_v");
    // Non-productive-by is a filter: every projected value must be present or the
    // whole path drops (TinkerPop default, no ProductiveByStrategy).
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x0n.id AND key=? ORDER BY id LIMIT 1) is not null AND");
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
    // seed source aliased `w` so until()'s correlated predicate references the seed as
    // `node=w.id`, not the `node=id` self-match that would read the wrong row.
    expect(p.sql).toContain('node=w.id');
    expect(p.sql).not.toContain('node=id ');
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
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
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

  test('aggregate(x).by(key).cap(x) bags a scalar; cap unrolls to individual results', () => {
    const store = seededStore();
    expect(run(store, 'g.V().aggregate("x").by("name").cap("x")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    // by-miss (software has no age) drops the member → 4 ages, not 6 with nulls.
    expect(run(store, 'g.V().aggregate("x").by("age").cap("x")').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([27, 29, 32, 35]);
  });

  test('bare aggregate(x).cap(x) bags elements; cap unrolls to vertices', () => {
    const store = seededStore();
    expect(run(store, 'g.V().aggregate("x").cap("x")').map((r) => r.id).sort((a, b) => a - b))
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
    expect(() => compile('g.V().local(__.out())', {})).toThrow('per-element limit()/range() only');
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
    store.query('INSERT INTO edges(id,src,label,tgt,props) VALUES(?,?,?,?,jsonb(?))', [2, 1, self, 1, '{}']);
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
    // SQL: the predicate correlates on the alias column (an ANY-match EXISTS over vertex_properties)
    expect(read('g.V().as("a").out().where(__.as("a").values("name").is("marko"))').sql)
      .toContain("EXISTS(SELECT 1 FROM vertex_properties WHERE node=p.a0 AND key=? AND value = ?)");
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
    store.query('INSERT INTO edges(id,src,label,tgt,props) VALUES(10,1,?,2,jsonb(?)),(11,1,?,2,jsonb(?))', [knows, '{}', knows, '{}']);
    const npaths = (q: string) => new Set((run(store, q) as any[]).map((r) => r.pk)).size;
    // two parallel 1→2 edges → out() reaches 2 twice → two identical [1,2] paths.
    expect(npaths('g.V(1).repeat(__.out()).times(1).path()')).toBe(2);
    expect(npaths('g.V(1).repeat(__.out()).times(1).path().dedup()')).toBe(1); // collapsed
  });

  // ---------- repeat().until() (modern-graph semantics) ----------

  const uNames = (store: GraphStore, q: string) => (run(store, q) as any[]).map((r) => JSON.parse(r.props).name[0]);

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
    const edge = 'INSERT INTO edges(id, src, label, tgt, props) VALUES(?,?,?,?,jsonb(?))';
    const N = 40; // deeper than the retired cap
    for (let i = 0; i <= N; i++) { store.query(node, [i + 1, person]); store.query(prop, [i + 1, 'name', `n${i}`]); }
    for (let i = 0; i < N; i++) store.query(edge, [100 + i, i + 1, knows, i + 2, '{}']); // n0→n1→…→n40
    expect(uNames(store, `g.V(1).repeat(__.out()).until(__.has("name","n${N}"))`)).toEqual([`n${N}`]);
  });
});
