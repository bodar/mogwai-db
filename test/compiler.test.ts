import { test, expect, describe } from 'bun:test';
import { compile, type CompileOptions } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { executeQuery } from '../src/execute.ts';
import { ioc } from '../src/io.ts';
import { parseRequest } from '../src/wire.ts';
import { MODERN_SEED } from './conformance/seed-modern.ts';
import { Query } from '../src/q.ts';
import { assertStreamColumns, toGroupStream, toPathStream, toPropertyStream, toRecordStream, toScalarStream, toVariantStream } from '../src/steps/stream.ts';
import { popChildScope, pushChildScope, reuseCurrentFrame } from '../src/steps/child.ts';
import { readdirSync, readFileSync } from 'node:fs';

// ---------- L2: SQL snapshots (canonical string -> SQL + binds + shape) ----------

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

describe('compiler SQL snapshots', () => {
  test('stream physical schemas are exact and fail immediately on column drift', () => {
    const q = new Query();
    const carry = { q, params: {}, carried: { aliases: new Map(), origins: [] } };
    expect(assertStreamColumns(toScalarStream(carry, q.cte({} as any, ['v']))).kind).toBe('scalar');
    expect(() => toScalarStream(carry, q.cte({} as any, ['value']))).toThrow(
      'scalar stream column mismatch: expected [v], got [value]',
    );
    expect(toVariantStream(carry, q.cte({} as any, ['vk', 'v', 'rid']), { node: true }).kind).toBe('variant');
    expect(() => toVariantStream(carry, q.cte({} as any, ['v', 'rid']), { node: true })).toThrow(
      'variant stream column mismatch',
    );
    const propertyCols = ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pvtype', 'pmeta'];
    expect(toPropertyStream(carry, q.cte({} as any, propertyCols), 'node').kind).toBe('property');
    expect(() => toPropertyStream(carry, q.cte({} as any, propertyCols.slice(1)), 'node')).toThrow(
      'property stream column mismatch',
    );
    const fields = [{ key: 'x', prefix: 'e0', sub: 'vertex' as const }];
    const recordCols = ['e0_rid', 'e0_id', 'e0_label', 'e0_props'];
    expect(toRecordStream(carry, q.cte({} as any, recordCols), fields).kind).toBe('record');
    expect(() => toRecordStream(carry, q.cte({} as any, recordCols.slice(1)), fields)).toThrow(
      'record stream column mismatch',
    );
    const groupKey = { kind: 'scalar' as const };
    const groupVal = { kind: 'count' as const };
    expect(toGroupStream(carry, q.cte({} as any, ['gk', 'gv']), groupKey, groupVal).kind).toBe('group');
    expect(() => toGroupStream(carry, q.cte({} as any, ['mk', 'mv']), groupKey, groupVal)).toThrow(
      'group stream column mismatch',
    );
    const pathLayout = { kind: 'linear' as const, positions: [{ render: 'value' as const, prefix: 'x0' }] };
    expect(toPathStream(carry, q.cte({} as any, ['x0_v']), pathLayout).kind).toBe('path');
    expect(() => toPathStream(carry, q.cte({} as any, ['v']), pathLayout)).toThrow(
      'path stream column mismatch',
    );
  });

  test('child scope retains a parent domain and pushes/pops one physical ordinal', () => {
    const q = new Query();
    const parent = {
      kind: 'elements' as const, elem: 'node' as const, q, params: {},
      rel: q.cte({} as any, ['id']), carried: { aliases: new Map(), origins: [] as string[] },
    };
    const { frame, scope, seed } = pushChildScope(parent);
    expect(frame.domain).toBe(seed.rel);
    expect(frame.ordinal).toBe('o0');
    expect(scope.frames).toEqual([frame]);
    expect(seed.carried.origins).toEqual(['o0']);
    expect(assertStreamColumns(seed)).toBe(seed);

    const reused = pushChildScope(seed, reuseCurrentFrame(scope, frame));
    expect(reused.seed).toBe(seed);
    expect(reused.frame.ordinal).toBe('o0');
    expect(reused.frame.reused).toBe(true);
    expect(reused.seed.carried.origins).toEqual(['o0']);

    const popped = popChildScope(seed, frame);
    expect(popped.carried.origins).toEqual([]);
    expect(popped.rel.cols).toEqual(['id']);
    expect(assertStreamColumns(popped)).toBe(popped);
  });

  test('read steps materialize through one root boundary', () => {
    const dir = new URL('../src/steps/', import.meta.url);
    const allowed = new Set(['materialize.ts', 'write.ts']);
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')] as const);
    const offenders = sources
      .filter(([name]) => !allowed.has(name))
      .filter(([, source]) => source.includes('readCompiled'))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
    expect(sources.some(([, source]) => source.includes('only one projection step is supported per traversal'))).toBe(false);
  });

  test('window rank/filter boundaries use typed derived tables, not paired CTEs', () => {
    const project = read('g.V().project("a","b").by(__.out().values("name")).by(__.in().count())');
    expect(project.sql.split(' as (')).toHaveLength(8); // seven CTEs
    expect(project.sql).toContain('FROM (SELECT r.v AS v, r.o0, ROW_NUMBER() OVER');

    const local = read('g.V().local(__.out().values("name").order().limit(2))');
    expect(local.sql.split(' as (')).toHaveLength(6); // five CTEs
    expect(local.sql).toContain('FROM (SELECT p.v AS v, p.encounter AS encounter');
  });

  test('traverser bulking: times(n).count() unrolls to GROUP-BY-SUM(bulk) CTEs, not a recursion', () => {
    const c = read('g.V().repeat(__.out()).times(3).count()');
    expect(c.shape).toEqual({ kind: 'count' });
    // The bulk path: a per-depth GROUP-BY-SUM, one non-recursive CTE per hop, summed at
    // the end. SQLite rejects an aggregate in a recursive term, so it MUST NOT recurse.
    expect(c.sql).not.toContain('recursive');
    expect(c.sql).toContain('SUM(b) AS bulk');
    expect(c.sql).toContain('GROUP BY nb');
    expect(c.sql).toContain('COALESCE(SUM(bulk), 0) AS v');
    // times(3) → f0 (seed) + three hop CTEs.
    expect((c.sql.match(/GROUP BY nb/g) ?? []).length).toBe(3);
    // A post-repeat as()/movement/select() chain discarded by count remains bulkable:
    // naming/building the final record does not change cardinality, and the extra hop
    // propagates multiplicity with one more grouped frontier.
    const selected = read('g.V().repeat(__.out()).times(5).as("a").out("writtenBy").as("b").select("a","b").count()');
    expect(selected.sql).not.toContain('recursive');
    expect((selected.sql.match(/GROUP BY nb/g) ?? []).length).toBe(6);
    // A NON-bulkable repeat (path/emit/complex body) stays the enumerate-walk
    // recursion — bulking must not hijack it. emit() has no compile-time depth.
    expect(read('g.V(1).repeat(__.out()).emit().times(2).count()').sql).toContain('recursive');
    expect(read('g.V(1).repeat(__.out()).times(2).path()').sql).toContain('recursive');
  });

  test('valueMap variants set shape, reuse the vertex row source', () => {
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', keys: null, tokens: false });
    expect(read('g.V().valueMap(true)').shape).toEqual({ kind: 'valueMap', keys: null, tokens: true });
    expect(read('g.V().valueMap("name","age")').shape).toEqual({ kind: 'valueMap', keys: ['name', 'age'], tokens: false });
    expect(read('g.V().elementMap()').shape).toEqual({ kind: 'elementMap', keys: null });
  });

  test('P3 Stage B: valueMap() re-enterable — select(Column), count, is(typeOf(MAP))', () => {
    // valueMap() → a per-element MapStream (json_each over the {k:[v]} JSON, tagged by a
    // per-element origin o0); select(Column.keys) aggregates one list PER origin.
    const keys = read('g.V().valueMap().select(Column.keys)');
    expect(keys.sql).toContain('json_each');
    expect(keys.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(keys.sql).toContain('GROUP BY');
    expect(keys.shape).toEqual({ kind: 'jsonbList' });
    // key subset filters at SQL level (je.key IN (?)); values().unfold() explodes per element
    const vals = read("g.V().valueMap('location').select(Column.values).unfold()");
    expect(vals.sql).toContain('je.key IN (?)');
    // count() over maps = one per element = count of elements; is(typeOf(MAP)) is identity
    expect(read('g.V().valueMap().count()').shape).toEqual({ kind: 'count' });
    expect(read('g.V().valueMap().is(typeOf(GType.MAP)).count()').shape).toEqual({ kind: 'count' });
    // per-element list ops thread the origin (o0) through unfold + set-ops (was a crash)
    const combined = read("g.V().valueMap('location').select(Column.values).unfold().combine(['seattle'])");
    expect(combined.sql).toContain('o0');
    // select(unbound-label) → empty (TinkerPop); a bound as()-label defers
    expect(read("g.V().valueMap().select('a')").sql).toContain('WHERE 0');
    expect(read("g.V().valueMap().select(Pop.first,'a')").sql).toContain('WHERE 0');
    expect(() => compile("g.V().as('a').valueMap().select('a')", {})).toThrow('select(bound-label) after valueMap() not yet supported');
    // terminal valueMap unchanged; still-unsupported followers fail closed
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', keys: null, tokens: false });
    expect(() => compile('g.V().valueMap(true).select(Column.keys)', {})).toThrow('valueMap(true)/token re-entry not yet supported');
  });

  test('order().by(key[, dir]) folds ORDER BY into the projection select', () => {
    const asc = read('g.V().hasLabel("person").order().by("age").values("name")');
    // the order key is the vtype-aware compareKey (numeric for a TEXT-stored big value)
    expect(asc.sql).toContain("ROW_NUMBER() OVER (ORDER BY (SELECT (CASE WHEN vtype IN ('byte'");
    expect(asc.sql).toContain("ELSE value END) FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) ASC) AS encounter");
    // order().by(key) before a scalar projection routes through the scalar pipeline: the
    // element order becomes the carried encounter (a ROW_NUMBER window). binds: label,
    // the order key (window), then the values() join key.
    expect(asc.binds).toEqual(['person', 'age', 'name']);

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
    expect(p.shape).toEqual({ kind: 'value', perRowType: true });
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

  test('P.typeOf resolves the stored vtype, with a storage-class fallback', () => {
    // value stream + is(): the per-row vtype column (values() reads vp.vtype) answers the
    // type; a NULL-vtype legacy row falls back to typeof(v). Both binds appear (canonical
    // name for the vtype match, storage class for the fallback).
    const str = read('g.V().values("name").is(P.typeOf(GType.STRING))');
    expect(str.sql).toContain('CASE WHEN p.vtype IS NOT NULL THEN p.vtype = ? ELSE typeof(p.v) = ? END');
    expect(str.binds).toContain('string');
    expect(str.binds).toContain('text');
    expect(read('g.V().values("age").is(P.typeOf(GType.INT))').binds).toContain('int');
    // java class-name string form is equivalent
    expect(read('g.V().values("name").is(P.typeOf("String"))').binds).toContain('string');
    // has(): the EXISTS matches the stored vtype (fallback to typeof(value)).
    expect(read('g.V().has("name", P.typeOf(GType.STRING))').sql)
      .toContain('CASE WHEN vtype IS NOT NULL THEN vtype = ? ELSE typeof(value) = ? END');
    // NULL → is-null; a storage-class-invisible type (boolean) → vtype match, else 0.
    expect(read('g.V().values("age").is(P.typeOf(GType.NULL))').sql).toContain('is null');
    expect(read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))').sql)
      .toContain('CASE WHEN p.vtype IS NOT NULL THEN p.vtype = ? ELSE 0 END');
    // P.not wraps and negates the inner predicate
    expect(read('g.V().values("age").is(P.not(P.typeOf(GType.STRING)))').sql).toContain('NOT ((CASE WHEN p.vtype');
    // an unregistered type name raises
    expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {})).toThrow('unregistered type');
  });

  test('P3b: uuid/list framing + is(typeOf(LIST)) retypes scalar→ListStream', () => {
    // A stored TEXT value frames by its true vtype: uuid via UuidSerializer (storage-
    // ambiguous with string), so values('uuid') carries perRowType framing.
    expect(read('g.V().values("uuid")').shape).toEqual({ kind: 'value', perRowType: true });
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
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold()').shape).toEqual({ kind: 'value', perRowType: true });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).count(Scope.local)').shape).toEqual({ kind: 'count' });
    expect(read('g.V().values("list").is(typeOf(GType.LIST)).unfold().range(1,3)').sql).toContain('json_each');

    // End-to-end framing: a list value frames as ONE List, unfold explodes it, uuid
    // round-trips through UuidSerializer.
    const store = new GraphStore(new BunSqlite(':memory:'));
    executeQuery(store, "g.addV('data').property('list',['a','b','c']).property('uuid', UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'))", {});
    const dec = (b: Buffer) => ioc.anySerializer.deserialize(b, true).v;
    expect(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST))", {}).map(dec)).toEqual([['a', 'b', 'c']]);
    expect(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).unfold()", {}).map(dec)).toEqual(['a', 'b', 'c']);
    expect(executeQuery(store, "g.V().values('list').is(typeOf(GType.LIST)).count(Scope.local)", {}).map(dec)).toEqual([3n]);
    expect(executeQuery(store, "g.V().values('uuid')", {}).map(dec)).toEqual(['0263f28b-eff9-4c17-8e33-0b41c74b6d4c']);
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
    expect(avg.sql).toContain('AVG(s.v)');
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
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList' });
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
    expect(read('g.V().hasLabel("person").fold().unfold().values("name")').shape).toEqual({ kind: 'value', perRowType: true });
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

    const { ioc } = await import('../src/io.ts');
    const doubles = executeQuery(seededStore(), 'g.V().values("age").asNumber(GType.DOUBLE).fold()', {})[0];
    // LIST header (type+flag) + bare length (4 bytes), then the first qualified item.
    expect(doubles[6]).toBe(ioc.DataType.DOUBLE);
    expect(ioc.anySerializer.deserialize(doubles).v.sort((a: number, b: number) => a - b)).toEqual([27, 29, 32, 35]);

    const ints = executeQuery(new GraphStore(new BunSqlite(':memory:')), 'g.inject("1",2,"3",4).asNumber().fold()', {})[0];
    expect(ints[6]).toBe(ioc.DataType.INT);
    expect(ioc.anySerializer.deserialize(ints).v).toEqual([1, 2, 3, 4]);
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
    expect(read('g.V().values("name").order().fold().conjoin("_")').shape).toEqual({ kind: 'value' });
    // all(P)/any(P) filter the list (IS TRUE / IS NOT TRUE null handling).
    expect(read('g.V().values("age").order().fold().all(P.gt(10))').sql).toContain('IS NOT TRUE');
    expect(read('g.V().values("age").order().fold().any(P.gt(10))').sql).toContain('IS TRUE');
    // a list-collection step on a scalar stream raises the incoming-type error.
    expect(() => compile('g.V().values("name").fold().unfold().combine([1])', {})).toThrow('incoming traversers');
  });

  test('P3 Stage C: bare groupCount() over a scalar stream groups by value', () => {
    // V().values('name').groupCount() → GROUP BY the value → Map{value: count}.
    const g = read("g.V().out('created').values('name').groupCount()");
    expect(g.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: true }, val: { kind: 'count' } });
    expect(g.sql).toContain('COUNT(*) AS gv');
    expect(g.sql).toContain('GROUP BY');
    // a typed scalar (asNumber(X)) carries its tag so the key frames correctly (not inferred)
    expect(read('g.inject(15).asNumber(GType.BYTE).groupCount()').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: true, as: 'byte' }, val: { kind: 'count' } });
    // null keys are counted (groupCount is productive)
    expect(read('g.inject(10,20,null,20).groupCount()').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: true }, val: { kind: 'count' } });
    // named side-effect groupCount('a') over a scalar defers (needs side-effect state)
    expect(() => compile("g.V().values('name').groupCount('a').cap('a')", {})).toThrow();
  });

  test('P3 Stage C2: count()/is(typeOf(MAP)) re-enter a group value', () => {
    // count() over a group = number of entries (distinct keys) → COUNT(DISTINCT gk)
    const c = read('g.V().group().by(T.label).count()');
    expect(c.shape).toEqual({ kind: 'count' });
    expect(c.sql).toContain('COUNT(DISTINCT');
    // count(Scope.local) on a Map = its size, same value
    expect(read('g.V().group().by(T.label).count(Scope.local)').shape).toEqual({ kind: 'count' });
    // is(typeOf(MAP)) is identity — a group IS a Map
    expect(read('g.V().groupCount().by(T.label).is(typeOf(GType.MAP))').shape.kind).toBe('group');
    // non-scalar-key count + non-MAP typeOf fail closed
    expect(() => compile('g.V().group().count()', {})).toThrow('non-scalar-key group');
    expect(() => compile('g.V().groupCount().by(T.label).is(typeOf(GType.LIST))', {})).toThrow('only is(typeOf(GType.MAP))');
  });

  test('P3 Stage C3: group().unfold() → per-entry Map.Entry stream', () => {
    // unfold a groupCount map → Map.Entry rows; select(Column.keys) projects THIS entry's
    // key per row (scalar), not the whole-map aggregate. Trailing unfold() is scalar-identity.
    const keys = read("g.V().outE().values('weight').groupCount().unfold().select(Column.keys).unfold()");
    expect(keys.shape.kind).toBe('value');
    // select(Column.values) → the entry's value (count → Long) per row
    expect(read("g.V().outE().values('weight').groupCount().unfold().select(Column.values).unfold()").shape)
      .toEqual({ kind: 'value', as: 'long' });
    // element-valued group entries still defer (P4 wall)
    expect(() => compile("g.V().group().by('name').by(__.out().fold()).unfold().select(Column.values)", {}))
      .toThrow('over a group of element values not yet supported');
  });

  test('group()/groupCount() always lowers to GroupStream; Column selection derives MapStream', () => {
    // A terminal GroupStream reaches the existing row-folding groupBuffer Map.
    expect(read('g.V().groupCount().by("name")').shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    // A Column consumer derives MapStream; select(Column.values) aggregates the
    // value column into a list value (one row), unfold() explodes it. Count → Long tag.
    const gv = read('g.V().groupCount().by("name").select(Column.values)');
    expect(gv.shape).toEqual({ kind: 'jsonbList', as: 'long' });
    expect(gv.sql).toContain('json_group_array');
    expect(read('g.V().groupCount().by("name").select(Column.values).unfold()').shape).toEqual({ kind: 'value', as: 'long' });
    // select(Column.keys) over a scalar key → a scalar stream on unfold.
    expect(read('g.V().groupCount().by("name").select(Column.keys).unfold()').shape).toEqual({ kind: 'value' });
    // Element keys (bare groupCount()) carry their rowid → unfold rejoins vertices.
    expect(read('g.V().groupCount().select(Column.keys).unfold()').shape).toEqual({ kind: 'vertex' });
    // group().by(k).by(__.count()) → same scalar-valued map path.
    expect(read('g.V().group().by("name").by(__.count()).select(Column.values).unfold()').shape).toEqual({ kind: 'value', as: 'long' });
    const childKey = read('g.V().groupCount().by(__.out().count())');
    expect(childKey.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    expect(childKey.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(childKey.sql).toContain('JOIN c');
    expect(childKey.sql).toContain('ON gk.o0=gp.o0');
  });

  test('list-VALUED map: group().by().by(__.out()...fold()).select(Column.values)', () => {
    // A neighbour-list value → a list-valued map; select(Column.values) yields a
    // list-of-lists, unfold() explodes to per-list rows, order(Scope.local) sorts each.
    const g = read('g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local)');
    expect(g.shape).toEqual({ kind: 'jsonbList' });
    // The neighbour-list is folded from generic child rows at the group boundary.
    expect(g.sql).toContain('json_group_array');
    expect(g.sql).toContain('ON gf.o0=gp.o0');
    expect(g.sql).not.toContain('MAX((SELECT jsonb(COALESCE(json_group_array');
    // A pre-fold op folds into the correlated subquery (dedup/limit/tail).
    expect(read('g.V().group().by().by(__.out().label().dedup().fold()).select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList' });
    // A scalar key now works too: the fold owns the complete final key domain, so
    // there is no per-parent list for MAX() to pick arbitrarily.
    const scalarKey = read('g.V().group().by("name").by(__.out().label().fold()).select(Column.values)');
    expect(scalarKey.shape).toEqual({ kind: 'jsonbList' });
    expect(scalarKey.sql).toContain('GROUP BY gk');
  });

  test('element-value group: unreduced value traversal implicitly folds to a list', () => {
    const store = seededStore();
    const eq = (a: string, b: string) =>
      JSON.stringify(executeQuery(store, a, {}).map((x) => [...x])) === JSON.stringify(executeQuery(store, b, {}).map((x) => [...x]));
    // by(__.out()) ≡ by(__.out().fold()) — TinkerPop collects an unreduced group value.
    expect(read('g.V().group().by(T.label).by(__.out())').shape).toEqual({ kind: 'group', key: { kind: 'scalar', as: undefined }, val: { kind: 'elementList', elem: 'vertex' } });
    expect(eq('g.V().group().by(T.label).by(__.out())', 'g.V().group().by(T.label).by(__.out().fold())')).toBe(true);
    // a trailing bare order() is the fold's natural id order (no-op), incl. before fold()
    expect(eq('g.V().group().by(T.label).by(__.out().order())', 'g.V().group().by(T.label).by(__.out().fold())')).toBe(true);
    expect(eq('g.V().group().by(T.label).by(__.out().order().fold())', 'g.V().group().by(T.label).by(__.out().fold())')).toBe(true);
    // order() before an order-insensitive reducer, and fold().count(Scope.local), collapse to count()
    expect(eq('g.V().group().by(T.label).by(__.out().order().count())', 'g.V().group().by(T.label).by(__.out().count())')).toBe(true);
    expect(eq('g.V().group().by(T.label).by(__.out().order().fold().count(Scope.local))', 'g.V().group().by(T.label).by(__.out().count())')).toBe(true);
    // the two collapses are general (root chains too)
    expect(eq('g.V().out().order().count()', 'g.V().out().count()')).toBe(true);
    expect(eq('g.V().out().fold().count(Scope.local)', 'g.V().out().count()')).toBe(true);
  });

  test('nested-MAP group value: inner groupCount/group → a Map per outer key (two-level agg)', () => {
    const store = seededStore();
    // properties().groupCount().by(T.label): a Map<name, Map<propKey, count>> per person.
    // marko has name,age (single) → {name:1, age:1}. One outer Map, framed once.
    const c = read("g.V().hasLabel('person').group().by('name').by(__.properties().groupCount().by(T.label))");
    expect(c.shape).toEqual({ kind: 'group', key: { kind: 'scalar', as: undefined }, val: { kind: 'nestedMap', innerVal: 'count' } });
    // two-level: json_group_object over a GROUP BY (outer key, inner key)
    expect(c.sql).toContain('json_group_object');
    expect(c.sql).toContain('vpn.key');
    expect(executeQuery(store, "g.V().hasLabel('person').group().by('name').by(__.properties().groupCount().by(T.label))", {})).toHaveLength(1);
    // edge movement + inner reducer: Map<label, Map<edgeLabel, sum(weight)>>
    const s = read("g.V().group().by(T.label).by(__.bothE().group().by(T.label).by(__.values('weight').sum()))");
    expect(s.shape).toEqual({ kind: 'group', key: { kind: 'scalar', as: undefined }, val: { kind: 'nestedMap', innerVal: 'number' } });
    expect(() => executeQuery(store, "g.V().group().by(T.label).by(__.bothE().group().by(T.label).by(__.values('weight').sum()))", {})).not.toThrow();
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
    // A scalar's local sum/min/max is the value itself (identity); shape stays a value,
    // and the stored per-row type rides through the identity reducer (perRowType).
    expect(read('g.V(1).values("age").sum(Scope.local)').shape).toEqual({ kind: 'value', perRowType: true });
    expect(read('g.V(1).values("age").max(Scope.local)').shape).toEqual({ kind: 'value', perRowType: true });
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
    expect(c.sql).toContain('SELECT COUNT(*) AS v FROM c1');
    // the values() flatMap (now carrying per-row vtype; a collection value → json() text)
    // feeds the count.
    expect(c.sql).toContain("THEN json(vp.value) ELSE vp.value END AS v, vp.vtype AS vtype FROM");
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
    expect(ordered.sql).toContain('LIMIT 2 OFFSET 0), c2(v) as (SELECT COUNT(*) AS v FROM c1)');
    expect(run(seededStore(), 'g.V().order().by("age").limit(2).values("name").count()').map((r) => r.v))
      .toEqual([2]);
    expect(() => compile('g.V().values("name").id()', {})).toThrow('id() requires element input');
  });

  test('count is a relational scalar boundary and can continue lowering', () => {
    const filtered = read('g.V().values("age").count().is(P.gt(3))');
    expect(filtered.shape).toEqual({ kind: 'count' });
    expect(filtered.sql).toContain('SELECT COUNT(*) AS v');
    expect(filtered.sql).toContain('WHERE p.v > ?');

    const countedAgain = read('g.V().values("age").count().count()');
    expect(countedAgain.shape).toEqual({ kind: 'count' });
    const store = seededStore();
    expect(run(store, 'g.V().values("age").count().is(P.gt(3))').map((r) => r.v)).toEqual([4]);
    expect(run(store, 'g.V().values("age").count().count()').map((r) => r.v)).toEqual([1]);
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
    // fold preserves the uniform item tag; a heterogeneous trailing inject still defers.
    expect(read('g.inject(1,0).asBool().fold()').shape).toEqual({ kind: 'jsonbList', as: 'bool' });
    expect(() => compile('g.inject(1).asBool().inject(5)', {})).toThrow('after typed/reduced/carried scalar state');
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
    expect(f.sql).toContain('CAST(p.v AS REAL)');
    // is(P.typeOf(X)) after a cast is compile-time known (the cast's `as` tag) → the
    // typeOf STATIC-FOLDS to a constant instead of a runtime typeof() test.
    const castTypeOf = read('g.V().values("weight").asNumber(GType.FLOAT).is(P.typeOf(GType.FLOAT))');
    expect(castTypeOf.sql).toContain('CAST(p.v AS REAL) AS v FROM c1 p WHERE 1');
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
    expect(read('g.V().format("Hello world")').shape).toEqual({ kind: 'value' });
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
    expect(rt.sql).toContain("unixepoch(p.v) * 1000");
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
    expect(rd.binds).toEqual(['birthday', Date.parse('1970-01-01T00:00Z')]); // the values() join key, then the later dateDiff operand
    // nested inject() as the dateDiff operand defers (not a literal/constant)
    expect(() => compile("g.inject(datetime('2023-08-08T00:00:00Z')).dateDiff(inject(datetime('2023-10-11T00:00:00Z')))", {})).toThrow('datetime literal or constant');
  });

  test('group-scoped reducers aggregate generic child rows at the final group boundary', () => {
    const p = read("g.V().hasLabel('software').group().by('name').by(__.bothE().values('weight').mean())");
    // Movement and values() become ordinary child relations retaining the parent
    // origin. AVG runs once over every raw row in the final key, never once per
    // parent with a MAX() papering over the intermediate result.
    expect(p.sql).toContain('JOIN c');
    expect(p.sql).toContain('ON gr.o0=gp.o0');
    expect(p.sql).toContain('AVG(CASE WHEN typeof(gr.v)');
    expect(p.sql).toContain("'real' AS gvt");
    expect(p.sql).not.toContain('MAX((SELECT AVG(');
    expect(read("g.V().group().by('name').by(__.bothE().values('weight').sum())").sql)
      .toContain('SUM(CASE WHEN typeof(gr.v)');
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
    expect(p.sql).toContain('SUM(s.v)');
    expect(p.binds).toContain(1000);
    // append before a min() reducer
    expect(read("g.V().values('foo').inject(42).min()").sql).toContain('UNION ALL');
    // rejected on a non-scalar projection (inject-append is a scalar-stream op)
    expect(() => compile("g.V().valueMap().inject(1)", {})).toThrow('inject() cannot consume the valueMap result shape');
  });

  test('union() as a source step UNION ALLs its vertex-rooted branches', () => {
    const p = read("g.union(__.V(2),__.V(4)).values('name')");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain('vp.value END AS v');
    // branches sharing the one WITH clause
    expect(read("g.union(__.V().hasLabel('software'),__.V().hasLabel('person')).count()").shape).toEqual({ kind: 'count' });
    // mid-chain union() still works (different code path)
    expect(read("g.V().union(__.out(),__.in()).values('name')").sql).toContain('UNION ALL');
    // non-vertex / unsupported branch defers with a clear error
    expect(() => compile('g.union(__.inject(1),__.inject(2))', {})).toThrow('unsupported source step: inject');
  });

  test('limit before count wraps the counted id-relation', () => {
    const sql = read('g.V().limit(2).count()').sql;
    expect(sql).toContain('c1(id) as (SELECT p.id FROM c0 p LIMIT 2)');
    expect(sql).toContain('SELECT COUNT(*) AS v FROM c1');
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
    expect(p.sql).toContain("jsonb_array(jsonb_object('k', ?, 'v', p.id)) AS a0 FROM c0");
    expect(p.sql).toContain('SELECT e.tgt AS id, p.a0 FROM edges e');
    // select retypes the alias to a fresh element stream (last id out of history), then root framing rejoins it.
    expect(p.sql).toContain('SELECT CAST(p.a0 ->> ? AS INTEGER) AS id, p.a0 FROM c2 p');
    expect(p.sql).toContain('JOIN c3 p ON n.id=p.id');
    expect(p.shape).toEqual({ kind: 'vertex' });
  });

  test('single-label select().by(key) → scalar value from the alias column', () => {
    const p = read('g.V().as("a").out().select("a").by("name")');
    expect(p.shape).toEqual({ kind: 'value' });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS v");
    expect(p.sql).toContain('ON n.id=CAST(p.a0 ->> ? AS INTEGER)');
    const child = read('g.V(1).as("a").out().select("a").by(__.out().count())');
    expect(child.shape).toEqual({ kind: 'value', as: 'long' });
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
      .toEqual({ kind: 'value', as: undefined });
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
        { key: 'friends', prefix: 'e0', sub: 'list', of: { kind: 'scalar' } },
        { key: 'first', prefix: 'e1', sub: 'vertex' },
      ],
    });
    expect(shaped.sql).toContain('b0.list AS e0_list');
    expect(shaped.sql).toContain('b1.rid AS e1_rid');
    expect(shaped.sql).toContain('ON b1.o0=b0.o0');
    expect(read('g.V(1).project("friends").by(__.out().values("name").fold()).select("friends").unfold().count()').shape)
      .toEqual({ kind: 'count' });
    expect(read('g.V(1).project("friends","created").by(__.out().values("name").fold()).by(__.out("created").values("name").fold()).select(Column.values).unfold()').shape)
      .toEqual({ kind: 'jsonbList' });
    expect(read('g.V(1).as("a").out().select("a").by(__.out()).values("name")').shape)
      .toEqual({ kind: 'value', perRowType: true });
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
    expect(p.shape).toEqual({ kind: 'value' });
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
    expect(p.sql).toContain(', c.a0 FROM'); // a0 carried through the reduce
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
    // withoutStrategies(X) is a safe no-op for any strategy we apply only on request (we
    // apply none by default, so there is nothing to suppress) — the sole exception is an
    // always-on strategy whose effect is unconditionally baked in (see ConnectiveStrategy).
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

  test('ProductiveByStrategy makes missing by-results explicit nulls at supported consumers', () => {
    const store = seededStore();
    const grouped = run(store, 'g.withStrategies(ProductiveByStrategy).V().group().by("age").by("name")');
    expect(grouped.find((r) => r.gk == null)).toMatchObject({ gv: '["lop","ripple"]' });
    expect(read('g.withoutStrategies(ProductiveByStrategy).V().group().by("age").by("name")').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'scalarList' } });
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().groupCount().by("age")').find((r) => r.gk == null)?.gv).toBe(2);

    const projected = run(store, 'g.withStrategies(ProductiveByStrategy).V().project("degree","age").by(__.inE().count()).by("age")');
    expect(projected).toHaveLength(6);
    expect(projected.filter((r) => r.e1_v == null).map((r) => r.e0_v).sort()).toEqual([1, 3]);

    const selected = run(store, 'g.withStrategies(ProductiveByStrategy).V().as("a").select("a").by("age")').map((r) => r.v);
    expect(selected.filter((v) => v == null)).toHaveLength(2);
    expect(selected.filter((v) => v != null).sort()).toEqual([27, 29, 32, 35]);
    expect(run(store, 'g.V().as("a").select("a").by("age")').map((r) => r.v).sort())
      .toEqual([27, 29, 32, 35]);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().group().by("age").by("name")', {})).toHaveLength(1);

    const aggregate = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("age").cap("a").unfold()').map((r) => r.v);
    expect(aggregate.filter((v) => v == null)).toHaveLength(2);
    expect(aggregate.filter((v) => v != null).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    const traversed = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by(__.values("age").is(gt(29))).cap("a").unfold()').map((r) => r.v);
    expect(traversed.filter((v) => v == null)).toHaveLength(4);
    expect(traversed.filter((v) => v != null).sort((a, b) => a - b)).toEqual([32, 35]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().local(__.aggregate("a").by("age")).cap("a").unfold()').map((r) => r.v).filter((v) => v == null)).toHaveLength(2);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("age").cap("a").max(Scope.local)').map((r) => r.v)).toEqual([35]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").max(Scope.local)').map((r) => r.v)).toEqual([null]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").unfold().sum()').map((r) => r.v)).toEqual([null]);
    expect(run(store, 'g.V().aggregate("a").by(__.outE("created").count()).cap("a").unfold()').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 1, 2]);
    const elementAggregate = run(store, 'g.V().aggregate("x").by(__.out().order().by("name")).cap("x").unfold()');
    expect(elementAggregate.map((r) => r.id).sort((a, b) => a - b)).toEqual([3, 3, 4]);
    const productiveElements = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("x").by(__.out().order().by("name")).cap("x").unfold()');
    expect(productiveElements.filter((r) => r.vk === 0)).toHaveLength(3);
    expect(productiveElements.filter((r) => r.vk === 2).map((r) => r.id).sort((a, b) => a - b)).toEqual([3, 3, 4]);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("x").by(__.out().order().by("name")).cap("x")', {})).toHaveLength(1);

    const nullableRecord = run(store, 'g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name"))');
    expect(nullableRecord.filter((r) => r.e0_id == null)).toHaveLength(3);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name"))', {})).toHaveLength(6);
    expect(read('g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name")).select("x")').shape)
      .toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().order().by("age")', {})).not.toThrow();
    expect(read('g.withStrategies(ProductiveByStrategy).V().as("a").out().as("b").where("a",eq("b")).by("age")').sql)
      .toContain(' IS ');
    expect(read('g.withStrategies(ProductiveByStrategy).V(1).out().path().by("age")').sql)
      .not.toContain('IS NOT NULL');

    const deduped = run(store, 'g.withStrategies(ProductiveByStrategy).V().order().by("name",desc).barrier().dedup().by("age").values("name")').map((r) => r.v);
    expect(deduped).toEqual(['vadas', 'ripple', 'peter', 'marko', 'josh']);
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

  test('SubgraphStrategy edge criterion + adjacent-vertex checks + recursion (end-to-end)', () => {
    const store = seededStore();
    const vals = (q: string) => run(store, q).map((r: any) => r.v).sort();
    const one = (q: string) => run(store, q).map((r: any) => r.v);
    // An edge criterion filters which edges are traversable: marko has 2 knows + 1 created
    // out-edges; hasLabel("knows") keeps only the two knows edges.
    expect(vals('g.withStrategies(new SubgraphStrategy(edges: __.hasLabel("knows"))).V(1).outE().label()')).toEqual(['knows', 'knows']);
    // out()/in()/both() EXPLODE to edge+vertex when an edge criterion is set, so the
    // traversed edge itself is filtered — marko reaches only his knows-neighbours.
    expect(vals('g.withStrategies(new SubgraphStrategy(edges: __.hasLabel("knows"))).V(1).out().values("name")')).toEqual(['josh', 'vadas']);
    // checkAdjacentVertices: a visible edge needs BOTH endpoints in the subgraph. Of
    // marko's out-edges only marko→josh has both endpoints in {marko,josh}.
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V(1).outE().count()')).toEqual([1]);
    // vertices AND edges together: created-only edges, and both endpoints in the vertex set.
    expect(vals('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh","ripple","lop")), edges: __.hasLabel("created"))).V(1).out().values("name")')).toEqual(['lop']);
    // Injection RECURSES into a nested local() body (previously a hard defer): josh's
    // bothE, filtered so both endpoints ∈ {marko,josh}, leaves only josh↔marko.
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V(4).local(__.bothE().limit(5)).count()')).toEqual([1]);
    // checkAdjacentVertices:false keeps an edge visible even when an endpoint is outside the
    // vertex criterion — honoured, not silently over-filtered. marko's 3 out-edges all
    // survive (only the near endpoint marko must be in {marko}); with the default (true) the
    // adjacency check would drop all 3 (no far endpoint is marko).
    expect(one('g.withStrategies(new SubgraphStrategy(checkAdjacentVertices: false, vertices: __.has("name", P.within("marko")))).V(1).outE().count()')).toEqual([3]);
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko")))).V(1).outE().count()')).toEqual([0]);
  });

  test('complete taxonomy: OLAP/finalization/planning strategies are result-preserving no-ops', () => {
    const store = seededStore();
    const cnt = (q: string) => run(store, q).map((r: any) => r.v);
    // Inert on our OLTP SQL engine — accepting as no-ops is correct-by-design (the query
    // returns identically with/without). Covers the previously-rejected OLAP guards.
    for (const s of ['ComputerFinalizationStrategy', 'GraphFilterStrategy', 'MessagePassingReductionStrategy',
                     'ComputerVerificationStrategy', 'LambdaRestrictionStrategy', 'OptionsStrategy',
                     'GValueReductionStrategy', 'RequirementsStrategy', 'ProfileStrategy', 'ConnectiveStrategy']) {
      expect(cnt(`g.withStrategies(${s}).V().count()`)).toEqual([6]);
    }
  });

  test('semantic/unknown strategies + genuinely-unsupported forms fail closed (never silently leak)', () => {
    // ProductiveByStrategy is a no-op when no by()-consumer exists, but unsupported
    // consumers still fail closed instead of silently using ordinary productivity.
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().values("name")', {})).not.toThrow();
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().dedup().by("age")', {})).not.toThrow();
    // A safe optimization alongside ProductiveBy does not suppress its null-key policy.
    expect(() => compile('g.withStrategies(CountStrategy, ProductiveByStrategy).V().dedup().by("age")', {})).not.toThrow();
    // Unknown / unlisted-semantic strategies fail closed (catch-all reject) — these would
    // change results if silently ignored and are deliberately NOT laundered as no-ops.
    for (const s of ['ElementIdStrategy', 'SackStrategy', 'EventStrategy', 'VertexProgramStrategy'])
      expect(() => compile(`g.withStrategies(${s}).V()`, {})).toThrow('is a semantic or unknown strategy');
    // vertexProperties criterion + a mutating traversal under Subgraph defer clearly.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertexProperties: __.has("a",1))).V()', {}))
      .toThrow('vertexProperties');
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).addV("person")', {}))
      .toThrow('mutating traversal');
    // PartitionStrategy mergeV/mergeE (partition-aware upsert) defers.
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).mergeV([(T.label):"person"])', {}))
      .toThrow('mergeV()/mergeE() not yet supported');
    // withoutStrategies of an always-on (unconditionally-baked) strategy is rejected —
    // silently accepting it would return wrong rows (infix .or() is not disable-able).
    expect(() => compile('g.withoutStrategies(ConnectiveStrategy).V()', {}))
      .toThrow('cannot be disabled');
    // Injection recurses into a repeat() body; the recursive-CTE body compiler then fails
    // closed on movement+where — a clear deferral, NOT an unfiltered leak.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().repeat(__.out()).times(2)', {}))
      .toThrow('not yet supported');
    // A NON-movement nested criterion still compiles — recursion is precise, not blanket.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().where(__.has("name","marko"))', {})).not.toThrow();
    // withoutStrategies suppresses a co-named withStrategies (removal wins).
    expect(() => compile('g.withStrategies(ProductiveByStrategy).withoutStrategies(ProductiveByStrategy).V().values("name")', {})).not.toThrow();
  });

  test('deferred long-tail forms error clearly (never silently mis-execute)', () => {
    // a label bound NOWHERE drops every traverser → empty result (TinkerPop drops, never errors)
    expect(run(seededStore(), 'g.V().select(Pop.first,"a")')).toEqual([]);
    expect(run(seededStore(), 'g.V().select("x")')).toEqual([]);
    expect(() => compile('g.V().as("a").select("a").by(T.id)', {})).toThrow('by(T.id) modulator not yet supported');
    expect(() => compile('g.V().as("a").out().as("b").select("a","b").order()', {})).toThrow('order() on a record requires a by(field)');
    // order().by() deferred modulators must throw, not silently sort by id
    expect(() => compile('g.V().order().by(T.label)', {})).toThrow('by(T.label) modulator not yet supported');
    expect(() => compile('g.V().order().by(__.values("age"))', {})).toThrow('by(traversal) modulator not yet supported');
    // dedup: label-scoped and dedup-after-as() deferred rather than answered wrongly
    expect(() => compile('g.V().as("a").out().as("b").dedup("a","b")', {})).toThrow('dedup(label) not yet supported');
    expect(() => compile('g.V().as("a").out().dedup()', {})).toThrow('dedup() after as() not yet supported');
    expect(() => compile('g.V().dedup().by("age").by("name")', {})).toThrow('at most one by()');
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
      .toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=gn.src) AS v_src');
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
    expect(read('g.V(1).outE().values("weight")').sql).toContain('JOIN edge_properties ep ON ep.edge=n.id AND ep.key=?');
  });

  test('single select and record projection preserve edge element typing', () => {
    const selected = read('g.V(1).outE("knows").as("b").select("b")');
    expect(selected.shape).toEqual({ kind: 'edge' });
    expect(selected.sql).toContain('FROM edges n JOIN');
    expect(read('g.V(1).outE().project("w").by("weight")').shape).toEqual({
      kind: 'map', entries: [{ key: 'w', prefix: 'e0', sub: 'value' }],
    });
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
    expect(read('g.V().properties().key()').sql).toContain('SELECT p.pk AS v');
    expect(read('g.V().properties().value()').sql).toContain('SELECT p.pv AS v');
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'count' });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toContain("JOIN vertex_properties vp ON vp.node=n.id AND vp.key=?");
  });

  test('PropertyStream projections re-enter scalar/element lowering', () => {
    expect(read('g.V(1).properties().key().limit(1)').shape).toEqual({ kind: 'value', as: undefined });
    expect(read('g.V(1).properties().element().values("name").count()').shape).toEqual({ kind: 'count' });
    // element() retypes to an ordinary owner stream, including edge materialization.
    expect(read('g.E(7).properties().element().label()').shape).toEqual({ kind: 'value', as: undefined });
    expect(read('g.E(7).properties().element()').shape).toEqual({ kind: 'edge' });
    // Carried aliases survive the property payload and the owner retype.
    expect(read('g.V(1).as("a").properties().element().select("a")').shape).toEqual({ kind: 'vertex' });
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

  test('non-reducing scalar group values lower through generic child-all productivity', () => {
    const p = read('g.V().group().by("name").by(__.out().values("name"))');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'scalarList' } });
    expect(p.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(p.sql).toContain('ON gv.o0=gp.o0');
    expect(p.sql).toContain('json_group_array(gv.v) AS gv');
    const both = read('g.V().group().by(__.label()).by(__.values("name").substring(0,1))');
    expect(both.sql).toContain('ON gk.o0=gp.o0');
    expect(both.sql).toContain('ON gv.o0=gp.o0');
  });

  test('sack(op).by(key) mutates a carried sk column; bare sack() reads it', () => {
    const p = read('g.V().sack(assign).by("age").sack()');
    expect(p.shape).toEqual({ kind: 'value' });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS sk");
    expect(p.sql).toContain('SELECT p.sk AS v, p.sk FROM'); // scalar CTE reads + carries the sack
    expect(read('g.withSack(1).V().sack().fold()').shape).toEqual({ kind: 'jsonbList' });
    // sum accumulator references the prior sk; div forces REAL division.
    expect(read('g.withSack(0.0d).V().sack(sum).by("age").sack()').sql).toContain('(p.sk + (SELECT value FROM vertex_properties WHERE node=n.id AND key=?');
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()').sql).toContain('(CAST(d.sk AS REAL) / f.v)');
    expect(read('g.withSack(0).V().sack(assign).by(__.outE().count()).sack()').sql)
      .toContain('ROW_NUMBER() OVER (PARTITION BY');
    // sack + a co-carried column (otherV's fromV): the mutate CTE re-projects sk in its
    // carriedCols SLOT, not appended last — so the sk/fv columns don't desync. Regression
    // for the pre-existing bug where sk silently got the fromV rowid.
    expect(read('g.withSack(0).V(1).outE().sack(assign).by(T.label).otherV().sack()').sql)
      .toContain('(SELECT name FROM labels WHERE id=n.label) AS sk'); // sk = the label, not the fv rowid
  });

  test('side-effecting group(a)/groupCount(a) → registered spec re-emitted by cap(a)', () => {
    // group('a').by(key).cap('a') → one Map (lowerGroup over the stashed source).
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
    // Every project field is an independent generic child joined on one outer edge
    // ordinal; no composite-key field uses a correlated scalar mini-compiler.
    expect(p.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(p.sql).toContain('gkp0.v AS k0_v, gkp1.v AS k1_v, gkp2.v AS k2_v');
    expect(p.sql).toContain('JOIN vertex_properties vp ON vp.node=n.id');
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=gn.src) AS v_src'); // edge value framing → external endpoint id
  });

  test('properties().group() lowers by() modulators through the generic child seam', () => {
    // D3: the property group is a live parent stream (pushChildScope over the property
    // payload), so its composite-key parts lower as ordinary scalar children — element()
    // .values() and key()/value() — NOT a hand-rolled inline reader.
    const p = read('g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'n' }, { key: 'k' }, { key: 'v' }] }, val: { kind: 'elementLast', elem: 'property' } });
    // The property parent's multiset-safe domain carries the full property payload.
    expect(p.sql).toContain('p.pk AS pk, p.pv AS pv, p.pvtype AS pvtype, p.pmeta AS pmeta, ROW_NUMBER() OVER () AS o0');
    // element().values("name") → owner re-root + values, joined back as a composite key part.
    expect(p.sql).toContain('gkp0.v AS k0_v, gkp1.v AS k1_v, gkp2.v AS k2_v');
    expect(p.sql).toContain('SELECT p.pk AS v, ROW_NUMBER() OVER (PARTITION BY p.o0'); // key() child, per-origin encounter
    expect(p.sql).toContain('gp.owner AS v_owner'); // the tail() value frames the property element from the domain
    // Result: each vertex property grouped by {owner name, key, value}, value = the property.
    const store = seededStore();
    const rows = run(store, "g.V().hasLabel('person').properties().group().by(__.key()).by(__.value().fold())");
    expect(rows).toEqual([
      { gk: 'age', gv: JSON.stringify([29, 27, 32, 35]) },
      { gk: 'name', gv: JSON.stringify(['marko', 'vadas', 'josh', 'peter']) },
    ]);
  });

  test("properties() group keys use the VertexProperty's OWN T.id/T.label/by(String), not the owner's", () => {
    // Regression guard: a property parent's ScalarCtx must resolve T.label→the property KEY
    // (pk), T.id→the VertexProperty id (vpid), and by(String)→a meta-property — NOT the
    // owning vertex's label/id/sibling-property. (The property ctx once reused the owner's
    // idExpr/labelIdExpr, silently mis-executing these; see propertyCtx.)
    const store = seededStore();
    // by(T.label) groups by the property key.
    expect(run(store, "g.V(1).properties().group().by(T.label).by(__.value().fold())")).toEqual([
      { gk: 'age', gv: JSON.stringify([29]) },
      { gk: 'name', gv: JSON.stringify(['marko']) },
    ]);
    // by(T.id) gives each VertexProperty its own group (distinct vpid per property).
    const byId = run(store, "g.V(1).properties().group().by(T.id).by(__.key())") as Array<{ gk: number; gv: string }>;
    expect(byId.length).toBe(2);
    expect(new Set(byId.map((r) => r.gk)).size).toBe(2); // two distinct property ids, not one owner id
    // T.label lowers to the key column, not an owner-label subquery.
    expect(read("g.V().properties().group().by(T.label).by(__.value())").sql).toContain('p.pk AS gk');
  });

  test('fold() wraps the projection in a list shape (element or scalar)', () => {
    expect(read('g.V().fold()').shape).toEqual({ kind: 'list', elem: 'vertex' });
    expect(read('g.V().values("name").fold()').shape).toEqual({ kind: 'jsonbList' });
    expect(read('g.V(1).outE().fold()').shape).toEqual({ kind: 'list', elem: 'edge' });
  });

  test('sum() wraps a value stream in SQL SUM → scalar shape', () => {
    const p = read('g.V().values("age").sum()');
    expect(p.shape).toEqual({ kind: 'scalar' });
    expect(p.sql).toContain('SELECT SUM(s.v) AS v, typeof(SUM(s.v)) AS vt FROM');
  });

  test('numeric reducers are scalar streams and preserve dynamic type past filters', () => {
    const summed = read('g.V().values("age").sum().is(P.gt(100))');
    expect(summed.shape).toEqual({ kind: 'scalar' });
    expect(summed.sql).toContain('SUM(s.v) AS v');
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

    const ordered = read('g.V().values("age").order().range(1,3)');
    expect(ordered.sql).toContain('ELSE p.v END) ASC LIMIT 2 OFFSET 1');

    const typedSum = read('g.V().values("age").asNumber(GType.DOUBLE).sum().is(P.gt(100))');
    expect(typedSum.shape).toEqual({ kind: 'scalar' });
    expect(typedSum.sql).toContain('CAST(p.v AS REAL) AS v');
    expect(typedSum.sql).toContain('SUM(s.v) AS v');

    const store = seededStore();
    expect(run(store, 'g.V().values("name").toUpper().is("MARKO")').map((r) => r.v)).toEqual(['MARKO']);
    expect(run(store, 'g.V().values("age").asNumber(GType.DOUBLE).sum().is(P.gt(100))').map((r) => r.v)).toEqual([123]);
  });

  test('aggregation deferred forms throw clearly', () => {
    // group() is now always a GroupStream: an element-VALUE layout cannot derive the
    // narrow MapStream consumed by Column.values, and an unknown group consumer defers.
    expect(() => compile('g.V().group().by("name").select(Column.values)', {})).toThrow('over a group of element values not yet supported');
    expect(() => compile('g.V().groupCount().by("name").cap("x")', {})).toThrow('cap() on a group value not yet supported');
    expect(() => compile('g.V().properties().group().by()', {})).toThrow('group().by() on a property element is not yet supported');
    expect(() => compile('g.V().group().by("name").by("age").by("x")', {})).toThrow('more than two by() modulators');
    expect(read('g.V().count().fold()').shape).toEqual({ kind: 'jsonbList', as: 'long' });
    expect(() => compile('g.V().sum()', {})).toThrow('sum() of vertex not yet supported');
  });

  // ---- P2b: is / where / not / TextP ----

  test('is(P) folds a predicate onto the projected scalar', () => {
    const gt = read('g.V().values("age").is(P.gt(30))');
    expect(gt.shape).toEqual({ kind: 'value', perRowType: true });
    // is(gt) folds through the vtype-aware compareKey (numeric-correct for the exact tail)
    expect(gt.sql).toContain("ELSE p.v END) > ?"); // the values() JOIN handles existence; is() adds a relational filter
    expect(gt.binds).toContain(30);
    // bare literal → equality
    expect(read('g.V().values("age").is(29)').sql).toContain("p.v = ?");
  });

  test('count().is(P) wraps the count in a value filter (0/1 rows)', () => {
    const p = read('g.V().count().is(P.gt(3))');
    expect(p.sql).toContain('SELECT COUNT(*) AS v FROM c0');
    expect(p.sql).toContain('WHERE p.v > ?');
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
    // The correlated child is the generic movement StepFn rendered as a nested derived
    // subquery seeded from the outer n.id (index-only; no bespoke xe/xn scheme).
    expect(w.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    const n = read('g.V().not(__.out("created")).values("name")');
    expect(n.sql).toContain('WHERE NOT COALESCE((EXISTS(');
  });

  test('where(__.count().is(P)) → correlated scalar compare over incident edges', () => {
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")');
    expect(c.sql).toContain('(SELECT COUNT(*) FROM (SELECT e.id AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.tgt=p.id');
    expect(c.sql).toContain('>= ?');
  });

  test('alias-compare where(P.neq("a")) and where("a",P,by(key)); unknown label throws', () => {
    const idc = read('g.V().as("a").out().where(P.neq("a"))');
    expect(idc.sql).toContain('WHERE n.id != CAST(p.a0 ->> ? AS INTEGER)');
    const keyc = read('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name")');
    expect(keyc.sql).toContain("(SELECT value FROM vertex_properties WHERE node=CAST(p.a0 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1) = (SELECT value FROM vertex_properties WHERE node=CAST(p.a1 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1)");
    expect(() => compile('g.V().where("x", P.eq("y"))', {})).toThrow('no such label');
    // alias-compare where() takes at most one by(key) — a second is not a valid
    // modulator here; fail closed rather than silently drop it.
    expect(() => compile('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name").by("age")', {}))
      .toThrow('by() is only supported as an order() or select()/project() modulator');
    // P.not(<inner>) negates the alias comparison (== P.neq for eq).
    const notEq = read('g.V().as("a").out().where(P.not(P.eq("a")))');
    expect(notEq.sql).toContain('WHERE NOT COALESCE((n.id = CAST(p.a0 ->> ? AS INTEGER)), 0)');
    expect(read('g.V().as("a").out().as("b").where("a", P.not(P.eq("b")))').sql)
      .toContain('WHERE NOT COALESCE((CAST(p.a0 ->> ? AS INTEGER) = CAST(p.a1 ->> ? AS INTEGER)), 0)');
  });

  test('where() on a record stream compares two carried alias labels', () => {
    const eq = read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.eq("b"))');
    // the record CTE still carries a0/a1; where filters rows by their history-last ids
    expect(eq.sql).toContain('WHERE CAST(r.a0 ->> ? AS INTEGER) = CAST(r.a1 ->> ? AS INTEGER)');
    const neq = read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.neq("b"))');
    expect(neq.sql).toContain('WHERE CAST(r.a0 ->> ? AS INTEGER) != CAST(r.a1 ->> ? AS INTEGER)');
    // P.not on a record where negates; a missing label still throws (drop-not-throw is
    // for select, an unknown label in a comparison is a real error).
    expect(read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.not(P.eq("b")))').sql)
      .toContain('WHERE NOT COALESCE((CAST(r.a0 ->> ? AS INTEGER) = CAST(r.a1 ->> ? AS INTEGER)), 0)');
    expect(() => compile('g.V().as("a").out().as("b").select("a","b").where(__.as("a").out())', {}))
      .toThrow('where() on a record supports only the alias-compare form');
  });

  test('where(__.<multi-hop chain>) → correlated EXISTS over the path', () => {
    // 2-hop path existence: the child fold nests one derived subquery per hop.
    const two = read('g.V().where(__.out().out()).values("name")');
    expect(two.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) p ON e.src=p.id) c)');
    // terminal has() on the neighbour — the has() StepFn is consumed by the child fold,
    // correlating on the reached node (aliased n inside the child, isolated by the FROM
    // boundary from the outer n).
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))').sql)
      .toContain("AND (CASE WHEN vtype IN ('byte'");
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))').sql)
      .toContain("ELSE value END) > ?");
    // terminal hasLabel()
    expect(read('g.V().where(__.out("created").hasLabel("software"))').sql).toContain('n.label IN (SELECT id FROM labels');
    // a lone bare movement keeps the leaner single-hop EXISTS over the movement child
    expect(read('g.V().where(__.out()).count()').sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) c)');
  });

  test('where()/filter() deferred forms throw clearly', () => {
    // multi-hop both() now lowers inline through the correlated movement child (the
    // generic StepFns handle both()'s two-direction fan-out) — a nested-derived EXISTS,
    // not the materialized generic gate (`EXISTS (SELECT 1`, with a space).
    expect(read('g.V().where(__.both().both())').sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e');
    expect(() => compile('g.V().filter(P.gt(1))', {})).toThrow('filter(predicate) not supported');
  });

  test('where/filter/not fall back to generic child row existence', () => {
    const store = seededStore();
    expect(run(store, 'g.V().where(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter']);
    expect(run(store, 'g.V().not(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['lop', 'ripple', 'vadas']);
    expect(read('g.V().filter(__.out().id()).count()').sql).toContain('EXISTS (SELECT 1');
  });

  // ---- P2 tail: and/or/union/optional ----

  test('and()/or() combine branch predicates; nested where(__.and)', () => {
    const a = read('g.V().and(__.out("knows"), __.out("created"))');
    expect(a.sql).toContain('WHERE ((EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    expect(a.sql).toContain(') AND (EXISTS(');
    expect(read('g.V().or(__.out("knows"), __.in("created"))').sql).toContain(') OR (EXISTS(');
    // <2 branches → clear throw
    expect(() => compile('g.V().and(__.out())', {})).toThrow('needs at least two traversal branches');
  });

  test('infix .and()/.or() connectors split a predicate body (where/choose/until)', () => {
    // where(has().and().has()) → ((p0) AND (p1))
    const a = read('g.V().where(__.has("name","x").and().has("age",P.gt(1)))');
    expect(a.sql).toContain(' AND ');
    expect(a.binds).toEqual(['name', 'x', 'age', 1]);
    // or() → ((p0) OR (p1)); OR binds looser so mixed a.and().b.or().c groups as ((a AND b) OR c)
    expect(read('g.V().where(__.has("name","x").or().has("age",P.gt(1)))').sql).toContain(') OR (');
    const mixed = read('g.V().where(__.hasLabel("person").and().out("created").or().hasLabel("software"))');
    expect(mixed.sql).toMatch(/\(\(.*AND.*\).*OR.*\)/s);
    // choose() infix predicate now routes through the same split (movement conjunct →
    // correlated EXISTS), then the arms fold — D2 support-definer removed.
    const c = read('g.V().choose(__.hasLabel("person").and().out("created"), __.out("knows"), __.identity())');
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    // malformed (leading/trailing/empty operand) → clear throw
    expect(() => compile('g.V().where(__.and().has("name","x"))', {})).toThrow('empty operand');
  });

  test('union() → UNION ALL of branch id-relations, multi-hop bodies fold', () => {
    const u = read('g.V(1).union(__.out("knows"), __.out("created")).values("name")');
    expect(u.sql).toContain('UNION ALL');
    expect(u.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(u.sql).toContain('SELECT e.tgt AS id, p.o0 FROM edges e JOIN');
    // multi-hop branch now folds through the dispatch (was single-hop only)
    expect(read('g.V().union(__.out().out(), __.in()).values("name")').sql)
      .toContain('SELECT e.tgt AS id, p.o0 FROM edges e JOIN c2 p ON e.src=p.id');
    // Homogeneous scalar arms lower at the shape-aware dispatcher and re-enter the
    // scalar pipeline; this is not the element-only PREFIX union.
    const scalar = read('g.V(1).union(__.values("name"), __.constant("x")).count()');
    expect(scalar.shape).toEqual({ kind: 'count' });
    expect(scalar.sql).toContain(' AS v FROM');
    expect(scalar.sql).toContain('UNION ALL');
    expect(() => compile('g.V().union(__.out())', {})).toThrow('needs at least two branches');
    // as() before union now threads the alias column through the merge (carried-schema, Move B)
    const ua = read('g.V().as("a").union(__.out(), __.in()).select("a")');
    expect(ua.sql).toContain('UNION ALL');
    expect(ua.sql).toContain('SELECT id, a0 FROM'); // the a0 alias column survives the branch merge
    // a NEW as() bound INSIDE one arm now forks/merges: the label unions into the merged
    // set and the arm that never bound it pads an empty (NULL) history.
    const divU = read('g.V().union(__.as("b").out(), __.in()).select("b")');
    expect(divU.sql).toContain('SELECT id, a0 FROM'); // the binding arm carries its history
    expect(divU.sql).toContain('SELECT id, NULL AS a0 FROM'); // the other arm pads it
    // sack through a fork is fail-closed (split/merge-on-fork unverified — carried-schema didn't silently lift it)
    expect(() => compile('g.withSack(0.0d).V().sack(sum).by("age").union(__.out(), __.in())', {})).toThrow('sack() through union()');
    // mixed scalar+element arms now merge as a dynamic-tag VariantStream (P4)
    const mixedU = read('g.V().union(__.values("name"), __.out())');
    expect(mixedU.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(mixedU.sql).toContain('1 AS vk'); // scalar arm
    expect(mixedU.sql).toContain('2 AS vk'); // node arm
    // mixed element kinds across branches (both element-class) stays the legacy defer
    expect(() => compile('g.V().union(__.out(), __.outE())', {})).toThrow('different element kinds');
  });

  test('optional() → single-hop LEFT JOIN fast path; multi-hop via ordinal', () => {
    const o = read('g.V().optional(__.out("created")).values("name")');
    expect(o.sql).toContain('SELECT COALESCE(e.tgt, p.id) AS id FROM c0 p LEFT JOIN edges e ON e.src=p.id');
    // both()/multi-hop now compile via the coalesce(t, identity) ordinal shape
    const b = read('g.V().optional(__.both()).count()');
    expect(b.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(b.sql).toContain('WHERE o0 NOT IN (SELECT o0 FROM'); // self-on-miss
    expect(read('g.V().optional(__.out().out()).count()').sql).toContain('ROW_NUMBER() OVER () AS o0');
    // a body that flips element kind would make self-on-miss mixed-shape → defer
    expect(() => compile('g.V().optional(__.outE())', {})).toThrow('changing element kind');
    // as() before optional threads the alias through the fast path (carryFrag from the input)
    expect(read('g.V().as("a").optional(__.out()).select("a")').sql)
      .toContain('SELECT COALESCE(e.tgt, p.id) AS id, p.a0 FROM');
    // NESTED optional/coalesce: each mints a UNIQUE ordinal (o0 outer, o1 inner) and
    // carries the outer through — so they compose (unlocks optional(out().optional(out())).path()).
    expect(read('g.V().optional(__.out().optional(__.out())).path()').sql).toContain('AS o1');
    expect(read('g.V(1).coalesce(__.coalesce(__.out(), __.in()), __.both())').sql).toContain('AS o1');
  });

  test('optional total scalar/list children retype without a phantom identity arm', () => {
    const store = seededStore();
    expect(run(store, 'g.V().optional(__.out().count())').map((r) => Number(r.v)).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
    expect(run(store, 'g.V().optional(__.out().values("name").fold()).count(Scope.local)').map((r) => Number(r.v)).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
  });

  test('optional non-total scalar child lowers to a scalar-or-element VariantStream', () => {
    const store = seededStore();
    const plan = read('g.V().optional(__.values("age"))');
    expect(plan.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    const rows = run(store, 'g.V().optional(__.values("age"))');
    expect(rows.filter((r) => r.vk === 1).map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    expect(rows.filter((r) => r.vk === 2).map((r) => r.label)).toEqual(['software', 'software']);
    expect(executeQuery(store, 'g.V().optional(__.values("age"))', {})).toHaveLength(6);
    expect(run(store, 'g.V().optional(__.values("age")).count()').map((r) => r.v)).toEqual([6]);
  });

  test('mixed-shape branch arms merge as a dynamic-tag VariantStream (P4)', () => {
    const store = seededStore();
    // union: scalar arm (name) + element arm (out) — vk 1 vs 2, framing yields all rows
    const uRows = run(store, 'g.V(1).union(__.values("name"), __.out())');
    expect(uRows.filter((r) => r.vk === 1).map((r) => r.v)).toEqual(['marko']);
    expect(uRows.filter((r) => r.vk === 2).length).toBe(3); // marko created lop, knows vadas+josh
    expect(executeQuery(store, 'g.V(1).union(__.values("name"), __.out())', {})).toHaveLength(4);
    // union with an EDGE arm exercises vk=3 + the src/tgt columns
    expect(executeQuery(store, 'g.V(1).union(__.outE(), __.values("age"))', {})).toHaveLength(4);
    // coalesce: element arm wins per input, scalar fallback where empty; gated by ordinal
    const cRows = run(store, 'g.V().coalesce(__.out(), __.values("name"))');
    expect(cRows.some((r) => r.vk === 1)).toBe(true);  // leaves fall back to name
    expect(cRows.some((r) => r.vk === 2)).toBe(true);  // marko/josh have out()
    expect(() => executeQuery(store, 'g.V().coalesce(__.out(), __.values("name"))', {})).not.toThrow();
    // choose: predicate splits, then=element / else=scalar
    expect(() => executeQuery(store, 'g.V().choose(__.out(), __.label(), __.values("name"))', {})).not.toThrow();
  });

  test('coalesce() → first non-empty branch per input via the ordinal', () => {
    const c = read('g.V(1).coalesce(__.out("knows"), __.out("created")).values("name")');
    expect(c.sql).toContain('ROW_NUMBER() OVER () AS o0');
    // branch 2 emits only for inputs branch 1 produced nothing for
    expect(c.sql).toContain('WHERE o0 NOT IN (SELECT o0 FROM');
    expect(c.shape).toEqual({ kind: 'value', perRowType: true });
    const scalar = read('g.V().coalesce(__.values("age"), __.constant(0)).count()');
    expect(scalar.shape).toEqual({ kind: 'count' });
    expect(scalar.sql).toContain('a.o0 NOT IN (SELECT o0 FROM');
    expect(read('g.V().coalesce(__.values("missing").fold(), __.values("name").fold()).unfold().count()').shape)
      .toEqual({ kind: 'count' });
    // mixed element+scalar arms now merge as a dynamic-tag VariantStream (P4), gated
    // per input ordinal like the homogeneous coalesce.
    const mixedC = read('g.V().coalesce(__.out(), __.values("name"))');
    expect(mixedC.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(mixedC.sql).toContain('o0 NOT IN (SELECT o0 FROM'); // second arm gated
    expect(() => compile('g.V().coalesce(__.out(), __.outE())', {})).toThrow('different element kinds');
    // dedup now preserves both the branch ordinal and its inner child ordinal.
    const dedup = read('g.V().coalesce(__.out().dedup(), __.in())');
    expect(dedup.sql).toContain('SELECT DISTINCT p.id AS id, p.o0, p.o1');
    // union() inside coalesce threads the ordinal through → valid
    expect(read('g.V().coalesce(__.union(__.out(),__.in()), __.both())').sql).toContain('ROW_NUMBER() OVER () AS o0');
    // as() before coalesce: originSeed projects the alias alongside the ordinal, the
    // merge outputs it (dropping the internal `o`) → select("a") resolves (Move B)
    const ca = read('g.V().as("a").coalesce(__.out(), __.in()).select("a")');
    expect(ca.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(ca.sql).toContain('SELECT id, a0 FROM');
  });

  test('flatMap() consumes every productive element or scalar child row', () => {
    const sql = read('g.V().flatMap(__.out().out()).values("name")').sql;
    expect(sql).toContain('SELECT e.tgt AS id, p.o0 FROM edges e');
    expect(sql).toContain('SELECT p.id AS id FROM c3 p'); // `all` consumes the child origin
    const scalar = read('g.V().flatMap(__.values("name"))');
    expect(scalar.shape).toEqual({ kind: 'value', as: undefined });
    expect(scalar.sql).toContain('JOIN vertex_properties vp');
    // Every scalar child records provider encounter order explicitly. `all` drops
    // the child ordinal without applying map's second first-per-parent window.
    expect(scalar.sql.match(/PARTITION BY/g)?.length).toBe(1);
  });

  test('map(__.<scalar>) → per-traverser scalar projection (value shape)', () => {
    const m = read('g.V().map(__.out().count())');
    expect(m.shape).toEqual({ kind: 'value', as: 'long' }); // count() is a Long
    // count() is a child-scope barrier, not a correlated scalar fast path: the
    // preserved domain makes an empty child an explicit zero row per origin.
    expect(m.sql).toContain('COUNT(c.id) AS v');
    expect(m.sql).toContain('LEFT JOIN');
    expect(m.sql).toContain('GROUP BY d.o0');
    const localCount = read('g.V().local(__.out().count())');
    expect(localCount.sql).toContain('COUNT(c.id) AS v');
    expect(localCount.sql).toContain('LEFT JOIN');
    const localRows = read('g.V(1).local(__.out().values("name").order().limit(2))');
    expect(localRows.sql).toContain('PARTITION BY p.o0 ORDER BY (CASE WHEN p.vtype');
    expect(localRows.sql).toContain('ELSE p.v END) ASC');
    const carriedCount = read('g.V(1).as("a").local(__.out().count())');
    expect(carriedCount.sql).toContain('COUNT(c.id) AS v, d.a0');
    const childValue = read('g.V(1).map(__.values("name"))');
    expect(childValue.shape).toEqual({ kind: 'value', as: undefined });
    expect(childValue.sql).toContain('JOIN vertex_properties vp');
    expect(childValue.sql).toContain('ROW_NUMBER() OVER (PARTITION BY p.o0');
    expect(read('g.V(1).map(__.values("name").toUpper())').sql).toContain('upper(p.v) AS v');
    expect(read('g.V(1).map(__.out().values("name").order().by(Order.desc).limit(1))').sql)
      .toContain('ELSE p.v END) DESC');
    expect(read('g.V(1).local(__.out().values("name").tail(2))').sql)
      .toContain('PARTITION BY p.o0 ORDER BY p.encounter DESC');
    const reducedChild = read('g.V().map(__.out().values("name").is("lop").count())');
    expect(reducedChild.sql).toContain('COUNT(s.encounter) AS v');
    expect(reducedChild.sql).toContain('LEFT JOIN');
    const foldedChild = read('g.V().map(__.out().values("name").fold()).count(Scope.local)');
    expect(foldedChild.sql).toContain('json_group_array(s.v ORDER BY s.encounter) FILTER');
    expect(foldedChild.sql).toContain("json('[]')");
    expect(read('g.V().map(__.out().fold()).unfold().values("name")').shape).toEqual({ kind: 'value', perRowType: true });
    expect(() => compile('g.V().map(__.constant(1).discard())', {})).toThrow();
    // record/list-valued child bodies still defer; element bodies use generic child scope below.
    expect(() => compile('g.V().map(__.select("a"))', {})).toThrow('not supported by generic scalar lowering');
    expect(() => compile('g.V().map(__.values("name")).map(__.values("age"))', {})).toThrow('map() after a scalar stream not yet supported');
    // The leaf now returns a ScalarStream instead of materializing terminal SQL.
    expect(read('g.V().map(__.out().count()).is(P.gt(0)).count()').shape).toEqual({ kind: 'count' });
  });

  test('map(__.<element body>) uses child scope + first-per-parent cardinality', () => {
    const p = read('g.V().map(__.out()).values("name")');
    expect(p.shape).toEqual({ kind: 'value', perRowType: true });
    expect(p.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(p.sql).toContain('WHERE r.rn=1');
    expect(read('g.V(1).map(__.outE("knows")).inV().values("name")').shape).toEqual({ kind: 'value', perRowType: true });
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
      .toContain('(SELECT COUNT(*) FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    // 2-arg form: else absent → identity passthrough of the NOT-pred seed
    expect(read('g.V().choose(__.hasLabel("software"), __.in("created"))').sql).toContain('UNION ALL');
    const scalar = read('g.V().choose(__.hasLabel("person"), __.values("name"), __.constant("software")).count()');
    expect(scalar.shape).toEqual({ kind: 'count' });
    expect(scalar.sql).toContain(' AS v FROM');
    expect(scalar.sql).toContain('UNION ALL');
  });

  test('choose() deferrals fail closed', () => {
    // a bare choice traversal with no then/else and no option() isn't a supported form
    expect(() => compile('g.V().choose(__.out())', {}))
      .toThrow('predicate form');
    // mixed element+scalar then/else now merge as a dynamic-tag VariantStream (P4)
    const mixedCh = read('g.V().choose(__.has("x"), __.out(), __.values("name"))');
    expect(mixedCh.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    // mixed element kinds across arms (both element-class) stays the legacy defer
    expect(() => compile('g.V().choose(__.has("x"), __.out(), __.outE())', {}))
      .toThrow('different element kinds');
    // as() before choose now threads the alias column through the gated arms + merge (Move B)
    const ca = read('g.V().as("a").choose(__.has("x"), __.out(), __.in()).select("a")');
    expect(ca.sql).toContain('UNION ALL');
    expect(ca.sql).toContain('SELECT id, a0 FROM'); // a0 preserved across the gated-arm merge
    // a NEW as() inside one arm now forks/merges: the non-binding arm pads an empty history.
    const divC = read('g.V().choose(__.has("x"), __.as("b").out(), __.in()).select("b")');
    expect(divC.sql).toContain('SELECT id, a0 FROM');
    expect(divC.sql).toContain('SELECT id, NULL AS a0 FROM');
  });

  test('option-map choose → CASE over the choice scalar (value shape)', () => {
    const c = read('g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))');
    expect(c.shape).toEqual({ kind: 'value' });
    expect(c.sql).toContain('LEFT JOIN');
    expect(c.sql).toContain('m0_present');
    expect(c.sql).toContain('CASE WHEN (p.m0 >= ? and p.m0 < ?) THEN p.m1 ELSE p.m2 END AS v');
    expect(c.binds).toEqual(['age', 'x', 'z', 26, 30, 26, 30]);
    // T.label choice, literal-equality keys
    expect(read('g.V().choose(T.label).option("person", __.constant("p")).option(Pick.none, __.constant("o"))').sql)
      .toContain('CASE WHEN (SELECT name FROM labels WHERE id=n.label) = ? THEN p.m0 ELSE p.m1 END');
    // count() choice is a total generic child barrier
    expect(read('g.V().choose(__.out().count()).option(1, __.values("name")).option(Pick.none, __.values("age"))').sql)
      .toContain('COUNT(c.id) AS v');
    expect(read('g.V().choose(T.label).option("person", __.constant("p")).option(Pick.none, __.constant("o")).fold()').shape)
      .toEqual({ kind: 'jsonbList' });
  });

  test('option-map choose deferrals fail closed', () => {
    // no Pick.none → unmatched pass-through is mixed vertex/scalar
    expect(() => compile('g.V().choose(__.out().count()).option(1, __.values("name")).option(2, __.values("age"))', {}))
      .toThrow('without a Pick.none default');
    // an element option body is rejected by scalar child shape dispatch
    expect(() => compile('g.V().choose(T.label).option("person", __.out("knows")).option(Pick.none, __.constant("x"))', {}))
      .toThrow('not supported by generic scalar child lowering');
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

  test('emit(predicate) carries an emit column tested per row (same engine as until)', () => {
    // emit-after: the seed is never emitted (0 AS emit); each recursive row is tested.
    const after = read('g.V(1).repeat(__.out()).emit(__.has("name","josh"))');
    expect(after.sql).toContain('0 AS emit');                 // seed not emitted under emit-after
    expect(after.sql).toContain('AS emit FROM');              // recursive rows tested
    expect(after.sql).toContain('WHERE emit = 1');            // output = emitted rows
    expect(after.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties'); // has() predicate
    // emit-before: the seed source is aliased (w) so the predicate's correlated nodes
    // subquery references the seed id, not a self-match; loops() composes via .or().
    const before = read('g.V(1).emit(__.has("name","marko").or().loops().is(2)).repeat(__.out())');
    expect(before.sql).toContain('SELECT w.id AS id');        // seed aliased for the correlated test
    expect(before.sql).toContain('c1.depth + 1 = ?');         // loops() → depth compare
    expect(before.sql).toMatch(/\) OR \(/);                    // has() OR loops()
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
    // a barrier body step (order/dedup/limit/…) can't live in a recursive term → defers.
    expect(() => compile('g.V().repeat(__.out().order()).times(2)', {})).toThrow('movements + has()');
    expect(() => compile('g.V().emit().times(2)', {})).toThrow('without repeat()');
    // a second repeat is NOT swallowed — it compiles as a chained cluster (two walks)
    const chained = read('g.V().repeat(__.out()).times(1).repeat(__.out()).times(1).values("name")');
    expect((chained.sql.match(/UNION ALL SELECT e\.tgt/g) || []).length).toBe(2); // two walk CTEs
  });

  test('repeat() body generality: movement + has(), multi-hop, both()-cartesian', () => {
    // bare single movement stays unchanged (alias `e`, no per-hop suffix).
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).toContain('JOIN edges e ON e.src=');
    // movement + has() → a correlated EXISTS filter on the hop's landing node.
    const f = read('g.V(1).repeat(__.out().has("lang","java")).times(2)');
    expect(f.sql).toContain('JOIN edges re1 ON re1.src=');
    expect(f.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties'); // the has() filter
    // multi-hop body → a JOIN chain (two edges) in one recursive SELECT.
    expect(read('g.V(1).repeat(__.in().out()).times(2)').sql).toMatch(/JOIN edges re1 .* JOIN edges re2 /);
    // both() + has() → cartesian over both directions = 2 recursive SELECTs.
    const b = read('g.V().repeat(__.both().has("age",P.lt(30))).times(2)');
    expect((b.sql.match(/EXISTS\(SELECT 1 FROM vertex_properties/g) || []).length).toBe(2);
    // barrier/side-effect + edge-step bodies still defer (can't live in a recursive term).
    expect(() => compile('g.V().repeat(__.out().dedup()).times(2)', {})).toThrow('movements + has()');
    expect(() => compile('g.V().repeat(__.local(__.out())).times(2)', {})).toThrow('movements + has()');
    // multi-hop body + path() defers (intermediate positions lost).
    expect(() => compile('g.V(1).repeat(__.in().out()).times(2).path()', {})).toThrow('multi-hop repeat() body');
  });

  test('P.inside is exclusive-low (distinct from between)', () => {
    // between = [lo,hi) ; inside = (lo,hi)
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('END) >= ?');
    expect(read('g.V().has("age", P.inside(29,35))').sql).toContain('END) > ?');
    expect(read('g.V().has("age", P.inside(29,35))').sql).not.toContain('END) >= ?');
  });

  test('review-fix regressions: no silent mis-execution', () => {
    // edge out().count() must throw (was silently mis-counting via edge id). Now the
    // generic child path recognizes count().is and compiles the child, so the movement
    // itself rejects out() on an edge — a more precise fail-closed error than before.
    expect(() => compile('g.E().where(__.out().count().is(P.gt(0)))', {})).toThrow('out() expects a vertex, not an edge');
    // where(__.move().is(P)) must not silently drop the is()
    expect(() => compile('g.V().where(__.out("knows").is(1))', {})).toThrow('not supported by inline predicate or generic child existence');
    // limit() then is() remains position-sensitive: only the first three values
    // reach the predicate, so Peter's later age (35) cannot leak through.
    const limited = seededStore();
    expect(run(limited, 'g.V().values("age").limit(3).is(P.gt(30))').map((r) => r.v)).toEqual([32]);
    // alias-compare by(key) on an edge label throws rather than reading nodes
    expect(() => compile('g.V().as("a").outE().as("e").where("e", P.eq("a")).by("weight")', {})).toThrow('edge-typed label not yet supported');
  });

  test('has() still compiles all predicate forms after the predicateSql refactor', () => {
    expect(read('g.V().has("age", 30)').sql).toContain('= ?');            // eq stays a raw exact compare
    expect(read('g.V().has("age", P.gt(30))').sql).toContain('END) > ?'); // range → vtype-aware compareKey
    expect(read('g.V().has("age", P.within(29,30))').sql).toContain('in (?, ?)');
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('END) >= ?');
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
    // Non-path queries stay unchanged (no p-columns).
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

  test('P3 Stage A: path() is re-enterable — count()/is(typeOf(PATH))', () => {
    // count() over a linear path → COUNT(*) (one row per path)
    const c = read('g.V(1).out().out().path().count()');
    expect(c.shape).toEqual({ kind: 'count' });
    expect(c.sql).toContain('COUNT(*) AS v');
    // count() over a recursive (grouped) path → COUNT(DISTINCT pk), not exploded elements
    const rc = read('g.V(1).repeat(__.out()).times(2).path().count()');
    expect(rc.shape).toEqual({ kind: 'count' });
    expect(rc.sql).toContain('COUNT(DISTINCT');
    // is(typeOf(GType.PATH)) is identity — a path IS a Path, so the result stays a path
    const t = read('g.V(1).out().out().path().is(typeOf(GType.PATH))');
    expect(t.shape.kind).toBe('path');
    // still-deferred followers fail closed
    expect(() => compile('g.V(1).out().path().unfold()', {})).toThrow('not yet supported');
    expect(() => compile('g.V(1).out().path().select(Column.keys)', {})).toThrow('not yet supported');
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

  test('path() through a branch (pad-to-max cols): threads + pads, remaining forms defer', () => {
    // path now threads through the UNION-ALL branch ops (carried-schema + padding).
    expect(read('g.V(1).union(__.out(), __.in()).path()').shape.kind).toBe('path');
    expect(read('g.V(1).coalesce(__.out(), __.in()).path()').shape.kind).toBe('path');
    expect(read('g.V(1).optional(__.out()).path()').shape.kind).toBe('path');
    expect(read('g.V(1).choose(__.has("name","x"), __.out(), __.in()).path()').shape.kind).toBe('path');
    // ragged arms: the shorter arm's trailing position is NULL-padded + LEFT JOINed.
    const r = read('g.V(1).union(__.out(), __.out().out()).path()');
    expect(r.sql).toContain('NULL AS p2');
    expect(r.sql).toContain('LEFT JOIN');
    // ---- still fail-closed ----
    // union() as a SOURCE step never seeds p0 → its own clear deferral (not the mid-chain path).
    expect(() => compile('g.union(__.V(),__.V()).path()', {})).toThrow('path() over a union() source step is not yet supported');
    // conflicting element kinds at one position (edge vs vertex) → deferred (needs tagged array).
    expect(() => compile('g.V(1).union(__.outE().inV(), __.out()).path()', {})).toThrow('conflicting element kinds');
    // by() can't ride a branched (padded) path — a NULL is indistinguishable from a missing prop.
    expect(() => compile('g.V(1).union(__.out(), __.out().out()).path().by("name")', {})).toThrow('path().by() through a branch not yet supported');
    // unchanged deferrals
    expect(() => compile('g.V(1).out().dedup().path()', {})).toThrow('dedup() with path tracking not yet supported');
    expect(() => compile('g.V(1).out().path().by(__.values("name"))', {})).toThrow('path().by(traversal) modulator not yet supported');
    expect(() => compile('g.V(1).out().path().by(T.id)', {})).toThrow('path().by(T.id) modulator not yet supported');
    expect(() => compile('g.V(1).out().path().order()', {})).toThrow('order() on a path value not yet supported');
  });

  // ---------- recursive repeat().path() (JSONB array regime) ----------

  test('repeat().path() accumulates a JSONB array through the WITH RECURSIVE walk', () => {
    const p = read('g.V(1).repeat(__.out()).times(2).path()');
    expect(p.sql).toContain('jsonb_array(id) AS path');                  // seed
    expect(p.sql).toContain("jsonb_insert(c1.path, '$[#]', e.tgt) AS path"); // append per hop
    expect(p.sql).toContain('json_each(pp.path) je JOIN nodes n ON n.id=je.value'); // explode + materialize
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex' });
  });

  test('recursive path().by(key) projects each position to a scalar (not the whole element)', () => {
    const p = read('g.V(1).repeat(__.out()).times(2).path().by("name")');
    // each exploded position is the property scalar `v`, correlated on je.value
    expect(p.sql).toContain('AS v FROM');
    expect(p.sql).toContain('SELECT value FROM vertex_properties WHERE node=je.value AND key=?');
    // no whole-element framing (no nodes/labels join for the position)
    expect(p.sql).not.toContain('json_each(pp.path) je JOIN nodes n');
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex', byKey: true });
    // a non-productive by(key) drops the whole path if any element lacks the property
    expect(p.sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM json_each');
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

  test('a non-path repeat() has unchanged SQL (no JSONB path column added)', () => {
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).not.toContain('path');
  });

  test('recursive path() defers mixed/edge/emit forms with clear errors', () => {
    expect(() => compile('g.V(1).out().repeat(__.out()).times(2).path()', {})).toThrow('path() spanning more than one repeat()/movement is not yet supported');
    expect(() => compile('g.V().repeat(__.outE().inV()).times(2).path()', {})).toThrow('movements + has()'); // edge-step body deferred
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

  test('until() composes loops() with an element predicate via the shared infix machinery', () => {
    // loops() lowers as a leaf (ctx.loopsExpr = the walk depth), so it combines with a
    // has() through the SAME .or()/.and() split as where() — no bespoke until parser.
    const orp = read("g.V(1).repeat(__.both().simplePath()).until(__.has('name','peter').or().loops().is(3)).has('name','peter').path().by('name')");
    expect(orp.sql).toContain('c1.depth + 1 = ?');                 // loops() → depth compare
    expect(orp.sql).toContain('vertex_properties');                // has() → property EXISTS
    expect(orp.sql).toMatch(/EXISTS\([^)]*vertex_properties[^)]*\)\) OR \(/); // combined by OR
    const andp = read("g.V(1).repeat(__.both().simplePath()).until(__.has('name','peter').and().loops().is(3)).path().by('name')");
    expect(andp.sql).toContain(') AND (');
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

  test('until(__.out()) correlates the EXISTS on the walk row via the FROM boundary', () => {
    // until() has no generic (materialized) fallback — a CTE cannot reference the
    // recursive term's outer row — so it correlates through the SAME inline movement
    // child as where()/choose(). The walk aliases its edges `e`; the child's own movement
    // also aliases `edges e`, but the seed `(SELECT e.tgt AS id)` is a FROM-clause derived
    // table so the child's `e` is NOT laterally visible to it — the seed's `e.tgt` binds
    // to the WALK's `e` through the WHERE-clause EXISTS boundary. No self-shadow, no xe.
    const p = read('g.V(1).repeat(__.out()).until(__.out())');
    expect(p.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT e.tgt AS id) p ON e.src=p.id) c)');
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
// consumer gates the value rows and UNION-merges the arms (scalarChildProduces = the per-row
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

  // The recognizer must never accept an arm body the scalar engine would THROW on (that
  // breaks the return-null fall-through). These arms all defer cleanly to the generic
  // message rather than surfacing a raw mid-lowering throw.
  test('arm bodies the scalar engine cannot lower defer cleanly (fall-through contract)', () => {
    expect(() => compile("g.V().values('age').union(__.asBool(),__.identity())", {}))
      .toThrow('union() after a scalar stream not yet supported');         // asBool has no scalarTx impl
    expect(() => compile("g.V().values('name').choose(__.is(eq('marko')),__.asNumber(),__.identity())", {}))
      .toThrow('choose() after a scalar stream not yet supported');        // bare asNumber() throws on a non-date value
    expect(() => compile("g.V().values('age').union(__.tail(1),__.identity())", {}))
      .toThrow('union() after a scalar stream not yet supported');         // tail() needs an encounter column
    expect(() => compile("g.V().as('a').values('age').union(__.dedup(),__.identity())", {}))
      .toThrow('union() after a scalar stream not yet supported');         // dedup() clears carried → merge desync
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
      ];

      for (const { key, query, fastSql, genericSql } of cases) {
        const enabled = { fastPaths: { [key]: true } } as CompileOptions;
        const disabled = { fastPaths: { [key]: false } } as CompileOptions;
        expect(read(query, enabled).sql).toContain(fastSql);
        expect(read(query, disabled).sql).toContain(genericSql);
        expect(runWith(store, query, enabled)).toEqual(runWith(store, query, disabled));
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
