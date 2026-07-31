// Compiler execution semantics (split from test/compiler.test.ts) — select / project / match / RecordStream.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { executeQuery } from '../support/executor.ts';
import { read, run, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

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
    .toEqual([{ e0_v: 'marko', e0_vtype: 'string', e1_v: 'vadas', e1_vtype: 'string' }]);
  // Vertices without an outgoing child are unproductive: the whole project row drops.
  expect(run(store, 'g.V().project("name","friend").by(__.values("name")).by(__.out().values("name"))')
    .map((r) => r.e0_v).sort()).toEqual(['josh', 'marko', 'peter']);
  // A produced NULL is not an unproductive child row.
  expect(run(store, 'g.V(1).project("x").by(__.constant(null))')).toEqual([{ e0_v: null }]);
  // Equal parents remain separate traversers through the outer by-origin join.
  expect(run(store, 'g.V(1).union(__.identity(),__.identity()).project("x").by(__.values("name"))'))
    .toEqual([{ e0_v: 'marko', e0_vtype: 'string' }, { e0_v: 'marko', e0_vtype: 'string' }]);
  expect(run(store, 'g.V().project("name","degree").by("name").by(__.out().count())')
    .map((r) => [r.e0_v, r.e1_v]).sort((a, b) => a[0].localeCompare(b[0])))
    .toEqual([
      ['josh', 2], ['lop', 0], ['marko', 3], ['peter', 1], ['ripple', 0], ['vadas', 0],
    ]);
  expect(run(store, 'g.V(1).project("id","kind","friend").by(T.id).by(T.label).by(__.out().values("name"))'))
    .toEqual([{ e0_v: 1, e1_v: 'person', e2_v: 'vadas', e2_vtype: 'string' }]);
  expect(run(store, 'g.V(1).project("self","friend").by().by(__.out().values("name"))')[0])
    // by() with no argument frames the element itself, so e0_label is the PAYLOAD form; the
    // by(T.label) field above is a SCALAR position and still picks one name.
    .toMatchObject({ e0_id: 1, e0_label: '["person"]', e1_v: 'vadas' });
  expect(run(store, 'g.V(1).project("self","friend").by().by(__.out().values("name")).select("self").out().count()')
    .map((r) => r.v)).toEqual([3]);
  expect(run(store, 'g.V(1).outE("knows").project("self","inName").by().by(__.inV().values("name")).select("self").inV().values("name")')
    .map((r) => r.v).sort()).toEqual(['josh', 'vadas']);

  const shaped = run(store, 'g.V(1).project("friends","first").by(__.out().values("name").fold()).by(__.out())');
  expect(JSON.parse(shaped[0].e0_list)).toEqual(['vadas', 'lop', 'josh']);
  expect(shaped[0]).toMatchObject({ e1_id: 2, e1_label: '["person"]' });
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

test('match() binds a variable of ANY shape, not just a node', () => {
  // The binding table was never the limitation — aliasEntry has always tagged
  // node/edge/value/list/map. What insisted on nodes was applyPattern folding only the ELEMENT
  // prefix, so it stopped at the first non-element step. It now runs the full shaped loop
  // (lowerRootedArm's shape, seeded from a bound var) and binds on the resulting stream's KIND.
  const store = seededStore();
  // SCALAR end var — b holds a name string. Same solution set as binding b as an element.
  expect(run(store, 'g.V().match(__.as("a").out("knows").values("name").as("b")).select("b")').map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
  expect(run(store, 'g.V().match(__.as("a").out("knows").as("b")).select("b").by("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
  // The static type tag rides into the entry, so a numeric var comes back a NUMBER, not "27".
  expect(run(store, 'g.V().match(__.as("a").values("age").as("x")).select("x")').map((r) => r.v).sort())
    .toEqual([27, 29, 32, 35]);
  // EDGE end var — b holds the edge itself, framed with its own props.
  const edges = run(store, 'g.V().match(__.as("a").outE("knows").as("b")).select("b")');
  expect(edges.map((r: any) => r.label)).toEqual(['knows', 'knows']);
  expect(edges.map((r: any) => `${r.src}->${r.tgt}`).sort()).toEqual(['1->2', '1->4']);
  // …and an edge var can then be a pattern's START: the seed re-roots on an edge rowid, which
  // needs the var's recorded SHAPE (assuming 'node' would read the edge id as a node id).
  expect(run(store, 'g.V().match(__.as("a").outE("created").as("e"), __.as("e").inV().as("b")).select("a","b").by("name")')
    .map((r: any) => `${r.e0_v}-${r.e1_v}`).sort())
    .toEqual(['josh-lop', 'josh-ripple', 'marko-lop', 'peter-lop']);
  // A scalar var re-used across patterns CONSTRAINS by value. Only software carries `lang`.
  expect(run(store, 'g.V().match(__.as("a").values("lang").as("n"), __.as("a").values("lang").as("n")).select("a").by("name")')
    .map((r) => r.v).sort()).toEqual(['lop', 'ripple']);
});

test('match() reduces PER BINDING, agreeing with the per-parent child route', () => {
  // A global barrier in a pattern body observes the whole stream, and here that stream IS the
  // binding table — lowering it at that scope would answer ONE count across ALL bindings. So a
  // barrier body routes through the child seam instead, which restores one row per binding.
  // Pinned against `map(__.<same body>)` rather than against constants: same semantics, already
  // established route, so a divergence is a real bug and not a fixture edit.
  const store = seededStore();
  const vals = (g: string) => run(store, g).map((r) => r.v);
  for (const [m, ref] of [
    ['g.V().match(__.as("a").out("knows").count().as("b")).select("b")', 'g.V().map(__.out("knows").count())'],
    ['g.V().match(__.as("a").out("created").count().as("n")).select("n")', 'g.V().map(__.out("created").count())'],
    ['g.V().match(__.as("a").both().count().as("n")).select("n")', 'g.V().map(__.both().count())'],
    ['g.V().match(__.as("a").outE("created").values("weight").sum().as("w")).select("w")',
     'g.V().map(__.outE("created").values("weight").sum())'],
    ['g.V().match(__.as("a").out().values("name").max().as("m")).select("m")',
     'g.V().map(__.out().values("name").max())'],
  ] as [string, string][]) {
    expect(vals(m)).toEqual(vals(ref));
  }
  // Only marko knows anyone, so a GLOBAL count would collapse this to a single row of 2.
  expect(vals('g.V().match(__.as("a").out("knows").count().as("b")).select("b")')).toEqual([2, 0, 0, 0, 0, 0]);
});

test('match() deferrals fail closed', () => {
  // A LIST-shaped end var (fold()) has no binding entry yet — the alias table can hold a list,
  // but nothing reads one back as a match variable, so it defers instead of binding something
  // downstream cannot consume.
  expect(() => compile('g.V().match(__.as("a").out("knows").fold().as("b"))', {})).toThrow('not yet supported');
  // A pattern cannot START from a scalar var — there is no rowid to re-root on. Fails closed
  // rather than reading the value as an id.
  expect(() => compile('g.V().match(__.as("a").values("name").as("n"), __.as("n").out().as("c"))', {}))
    .toThrow('non-element variable');
  // Re-binding a var at a DIFFERENT shape would compare a rowid against a value — meaningless
  // rather than merely narrower, so it is rejected instead of silently never matching.
  expect(() => compile('g.V().match(__.as("a").out("knows").as("b"), __.as("a").values("name").as("b"))', {}))
    .toThrow('cross-shape constraint');
  // Mutual recursion: every start is also an end, so no pattern can go FIRST. Zero roots is now a
  // legitimate shape (every start already bound before the match), so this is no longer caught by
  // counting roots — it surfaces where the fold actually stalls, naming the variable.
  expect(() => compile('g.V().match(__.as("a").out("created").as("b"), __.as("b").in("created").as("a"))', {})).toThrow('unbound start variable');
  // TWO fresh roots — two disjoint components, and the binding table has one id.
  expect(() => compile('g.V().match(__.as("a").out().as("b"), __.as("c").out().as("d"))', {})).toThrow('root variables');
  // and/or in match position are pattern GROUPS that BIND their nested ends (the corpus asserts
  // those variables come back), so they defer rather than lower as a filter that drops them.
  expect(() => compile('g.V().match(__.or(__.as("a").out().as("b")))', {})).toThrow('must start with as');
  // A filter reading a variable no pattern ever binds cannot become ready.
  expect(() => compile('g.V().match(__.as("a").out().as("b"), __.where("a", P.neq("zz")))', {})).toThrow('which no pattern binds');
});

test('alias-compare where — the co-creator idiom', () => {
  const store = seededStore();
  // people who created something also created by someone else (exclude self)
  const names = run(store, 'g.V().as("a").out("created").in("created").where(P.neq("a")).values("name")').map((r) => r.v).sort();
  expect(names).toEqual(['josh', 'josh', 'marko', 'marko', 'peter', 'peter']); // all three co-created lop
});

// `select(label).by(key)` over a VALUE-shaped parent used to return the labelled ELEMENT and drop
// the by() — byte-identical to the by()-less form, so the modulator vanished silently. Only
// `lowerSingleSelect` (over an element stream) applies modulators; `dispatchAlias` routes a
// scalar/list/variant parent straight to the shape-agnostic resolver, which is by()-less by
// contract. That contract is now enforced there rather than assumed.
//
// This asserts the DEFERRAL, not the answer: 'marko' is what TinkerPop gives, and reaching it means
// reaching the modulator owner from a value-shaped parent (see
// docs/archive/2026-07-28-match-string-frontend-design.md). Pinned so it cannot regress to the wrong answer
// — a test that accepted the vertex here would have locked the bug in.
// `select(label).by(key)` composed in the MAIN chain but was declined at every CHILD position: the
// shape classifier read only what the label held and never the modulator, so a by()-projected
// element never registered as a scalar producer. Each case is pinned against its `values(key)`
// equivalent rather than a literal — the two are the same computation, so an equivalence failure
// means one of the routes drifted, which a hand-written expectation could not tell us.
describe('select(label).by(key) as a child body', () => {
  const cases: [string, string, string][] = [
    ['map', 'map(__.select("a").by("name"))', 'map(__.select("a").values("name"))'],
    ['order().by', 'order().by(__.select("a").by("name")).values("name")', 'order().by(__.select("a").values("name")).values("name")'],
    ['group().by', 'group().by(__.select("a").by("name")).by(__.count())', 'group().by(__.select("a").values("name")).by(__.count())'],
  ];
  // Compared on VALUES, not raw rows: the two routes differ in the internal type CHANNEL —
  // values() carries a per-row `vtype` tag, by(key) resolves a static type — which is
  // representational, not observable. Verified separately that both frame a numeric property as a
  // number (`by("age")`/`values("age")` → 29, and the same on an edge label's `weight`), so the
  // channel difference does not reach the wire. Comparing raw rows would fail on `vtype` alone.
  const values = (rows: any[]) => rows.map((r) => (Object.hasOwn(r, 'v') ? r.v : r));
  for (const [name, byForm, valuesForm] of cases)
    test(`${name} — by(key) equals the values(key) form`, () => {
      const store = seededStore();
      const head = 'g.V().as("a").out("knows").';
      expect(values(run(store, head + byForm))).toEqual(values(run(store, head + valuesForm)));
    });

  test('where — the by() is a productive-existence filter, not a drop-everything', () => {
    const store = seededStore();
    expect(run(store, 'g.V().as("a").out("knows").where(__.select("a").by("name")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'vadas']);
  });

  // Classify must admit only what emit serves. A TOKEN by (`by(T.id)`) is rejected by the emitter,
  // so the classifier must not admit it either — a classify/emit mismatch is a crash, not a
  // deferral, because consumers assert on the classification.
  test('a token by() stays declined, so classify and emit admit the same set', () => {
    const store = seededStore();
    expect(() => run(store, 'g.V().as("a").out("knows").map(__.select("a").by(T.id))')).toThrow();
  });
});

// This case went through three states, and the sequence is the point: it returned the labelled
// ELEMENT and silently dropped the by() (byte-identical to the by()-less form); then it failed
// closed, once the by()-less resolver's contract was enforced rather than assumed; now it ANSWERS,
// because the modulator projection was extracted shape-agnostically (`selectKeyFromAlias`) rather
// than reimplemented per parent shape. ONE implementation, so the two routes cannot disagree — which
// is the property this test defends.
test('select(label).by(key) answers the same over a value-shaped parent as over an element one', () => {
  const store = seededStore();
  expect(run(store, 'g.V().has("name","marko").as("a").values("name").select("a").by("name")').map((r) => r.v))
    .toEqual(['marko']);
  expect(run(store, 'g.V().has("name","marko").as("a").out("created").select("a").by("name")').map((r) => r.v))
    .toEqual(['marko']);
  // The by()-less form is unaffected — it legitimately yields the labelled vertex, not a property.
  expect(run(store, 'g.V().has("name","marko").as("a").values("name").select("a")').map((r) => r.id))
    .toEqual([1]);
});

// The shared projection serves a KEY by at Pop.last and nothing else. A token by has no shared
// implementation to reach, and a non-last Pop under a by() is unsupported on the element route too,
// so answering either here would make the two routes disagree — the very failure the extraction
// exists to prevent. Both still fail closed.
test('a token by() over a value-shaped parent still fails closed', () => {
  const store = seededStore();
  expect(() => run(store, 'g.V().has("name","marko").as("a").values("name").select("a").by(T.id)'))
    .toThrow('supports only a property-key by()');
});

});
