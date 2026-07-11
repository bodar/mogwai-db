import { test, expect, describe } from 'bun:test';
import { compile } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { seedModern } from '../conformance/seed-modern.ts';

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

  test('limit before count wraps the counted id-relation', () => {
    expect(read('g.V().limit(2).count()').sql).toContain('SELECT COUNT(*) AS v FROM (SELECT id FROM c1)');
  });

  test('inject seeds a VALUES stream', () => {
    const p = read('g.inject(1,2,3)');
    expect(p.sql).toBe('WITH c0(v) AS (VALUES (?),(?),(?)) SELECT v FROM c0');
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
    expect(p.sql).toContain('e0n.id AS e0_id');
    expect(p.sql).toContain('e1n.id AS e1_id');
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
    expect(p.sql).toContain('c0 AS (SELECT id FROM edges)');
    expect(p.shape).toEqual({ kind: 'edge' });
    expect(p.sql).toContain('n.src, n.tgt');
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
    expect(p.sql).toContain('n.id AS v_id');
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
    expect(p.sql).toContain('n.src AS v_src'); // edge value framing
  });

  test('properties().group() over the property stream (vertex-property gate)', () => {
    const p = read('g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'n' }, { key: 'k' }, { key: 'v' }] }, val: { kind: 'elementLast', elem: 'property' } });
    expect(p.sql).toContain("json_extract(ownerProps, '$.name') AS k0_v");
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
    expect(gt.sql).toContain("json_extract(n.props, '$.age') IS NOT NULL AND json_extract(n.props, '$.age') > ?");
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
    expect(sw.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(sw.binds).toContain('jo%');
    expect(read('g.V().values("name").is(TextP.containing("ar"))').binds).toContain('%ar%');
    // negation → NOT LIKE
    expect(read('g.V().has("name", TextP.notEndingWith("o"))').sql).toContain("NOT LIKE ? ESCAPE '\\'");
    // metachars in the user value are escaped, never spliced
    const esc = read('g.V().has("name", TextP.containing("50%_x"))');
    expect(esc.binds).toContain('%50\\%\\_x%');
  });

  test('where(__.movement) → EXISTS filter CTE; not() → NOT COALESCE', () => {
    const w = read('g.V().where(__.out("knows")).values("name")');
    expect(w.sql).toContain('EXISTS(SELECT 1 FROM edges e WHERE e.src=n.id AND e.label IN');
    const n = read('g.V().not(__.out("created")).values("name")');
    expect(n.sql).toContain('WHERE NOT COALESCE((EXISTS(');
  });

  test('where(__.count().is(P)) → correlated scalar compare; reports index key on values(k)', () => {
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")');
    expect(c.sql).toContain('(SELECT COUNT(*) FROM edges WHERE tgt=n.id');
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
  });

  test('where()/filter() deferred forms throw clearly', () => {
    expect(() => compile('g.V().where(__.out().out())', {})).toThrow('not yet supported');
    expect(() => compile('g.V().filter(P.gt(1))', {})).toThrow('filter(predicate) not supported');
  });

  test('P.inside is exclusive-low (distinct from between)', () => {
    // between = [lo,hi) ; inside = (lo,hi)
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('>= ? AND');
    expect(read('g.V().has("age", P.inside(29,35))').sql).toContain('> ? AND');
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
    expect(read('g.V().has("age", P.within(29,30))').sql).toContain('IN (?,?)');
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('>= ? AND');
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
});
