// Compiler execution semantics (split from test/compiler.test.ts) — select / project / match / RecordStream.
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
import { assertStreamColumns } from '../../src/compiler/steps/context/stream.ts';
import { pushChildScope } from '../../src/compiler/steps/tail/child.ts';

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

describe("select/project execution", () => {
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

});
