// Compiler execution semantics (split from test/compiler.test.ts) — group / groupCount / properties / valueMap.
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
import { decodeAll } from '../support/decode.ts';

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

describe("group/properties execution", () => {
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

test('properties().dedup() uses property identity and by(value) uses the value key', () => {
  const store = seededStore();
  // both() repeats owners, but each physical vertex property remains one traverser.
  expect(run(store, 'g.V().both().properties().dedup().count()').map((r) => r.v)).toEqual([12]);
  // Edge Property has no vpid; equal key/value properties collapse across edges.
  expect(run(store, 'g.V().bothE().properties().dedup().count()').map((r) => r.v)).toEqual([4]);

  const duplicate = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(duplicate, "g.addV('person').property('name','josh').addV('person').property('name','josh').addV('person').property('name','josh')", {});
  expect(run(duplicate, 'g.V().properties("name").dedup().count()').map((r) => r.v)).toEqual([3]);
  expect(run(duplicate, 'g.V().properties("name").dedup().by(value).count()').map((r) => r.v)).toEqual([1]);
});

test('properties().order() sorts by natural property order, key, and typed value', () => {
  const store = seededStore();
  expect(run(store, 'g.V().properties().order().by(T.key, desc).key()').map((r) => r.v))
    .toEqual(['name', 'name', 'name', 'name', 'name', 'name', 'lang', 'lang', 'age', 'age', 'age', 'age']);
  expect(run(store, 'g.E().properties().order().value()').map((r) => r.v))
    .toEqual([0.2, 0.4, 0.4, 0.5, 1.0, 1.0]);
  expect(run(store, 'g.E().properties().order().by(desc).value()').map((r) => r.v))
    .toEqual([1.0, 1.0, 0.5, 0.4, 0.4, 0.2]);
  expect(run(store, 'g.V().properties().order().id()').map((r) => r.v))
    .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('properties().order().by(traversal) uses the generic property child scope', () => {
  const store = seededStore();
  expect(run(store, 'g.V().hasLabel("person").properties("name").order().by(__.value()).value()').map((r) => r.v))
    .toEqual(['josh', 'marko', 'peter', 'vadas']);
  expect(run(store, 'g.V().hasLabel("person").properties("age").order().by(__.value(), Order.desc).value()').map((r) => r.v))
    .toEqual([35, 32, 29, 27]);
});

test('properties().order().by(traversal) sorts numerically, not lexically (TEXT-stored numbers)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // bigdecimal rides as TEXT storage class (see compareKey), so a plain ORDER BY sorts it
  // lexically ("200.0" < "3.0" < "35.0" < "9.0") — the by(traversal) branch must apply
  // compareKey like the token branch does, giving true numeric order.
  for (const n of ['9.0', '35.0', '3.0', '200.0']) executeQuery(store, `g.addV('m').property('n',${n}M)`, {});
  expect(run(store, 'g.V().properties("n").order().by(__.value()).value()').map((r) => r.v))
    .toEqual(['3.0', '9.0', '35.0', '200.0']);
  expect(run(store, 'g.V().properties("n").order().by(__.value(), Order.desc).value()').map((r) => r.v))
    .toEqual(['200.0', '35.0', '9.0', '3.0']);
});

test('property aliases select directly or project T.key/T.value/T.id', () => {
  const store = seededStore();
  expect(run(store, 'g.E(11).properties("weight").as("a").select("a").by(T.key)').map((r) => r.v))
    .toEqual(['weight']);
  expect(run(store, 'g.E(11).properties("weight").as("a").select("a").by(T.value)').map((r) => r.v))
    .toEqual([0.4]);
  expect(run(store, 'g.E(11).properties("weight").as("a").select("a").value()').map((r) => r.v))
    .toEqual([0.4]);
  expect(run(store, 'g.V(1).properties("name").as("p").select("p").by(T.id)').map((r) => r.v))
    .toEqual([1]);
});

test('property aliases support Pop.all and multi-bound Pop.mixed through unfold()', () => {
  const store = seededStore();
  expect(run(store, 'g.E(11).properties("weight").as("p").select(Pop.all, "p").unfold().value()').map((r) => r.v))
    .toEqual([0.4]);
  expect(run(store, 'g.E(11).properties("weight").as("p").as("p").select(Pop.mixed, "p").unfold().value()').map((r) => r.v))
    .toEqual([0.4, 0.4]);
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

test('an unreduced scalar group value is emission-ordered, and unproductive still filters', () => {
  const store = seededStore();
  const marko = (q: string) => JSON.parse(run(store, q).filter((r: any) => r.gk === 'marko')[0].gv);

  // ORDER: the member list follows the child's emission order, not whatever order the join
  // happened to produce. marko's out-neighbours are vadas(2), lop(3), josh(4) in edge order.
  expect(marko('g.V().group().by("name").by(__.out().values("name"))')).toEqual(['vadas', 'lop', 'josh']);
  // ...and it STAYS that way when the body grows a CTE. Before the value path was routed
  // through the fold aggregate it emitted a bare json_group_array with no ORDER BY, so the
  // order was incidental: a label re-root in the body silently permuted it.
  expect(marko(`g.V().group().by("name").by(__.out().as("a").select("a").values("name"))`))
    .toEqual(['vadas', 'lop', 'josh']);
  expect(marko('g.V().group().by("name").by(__.out().values("name").fold())')).toEqual(['vadas', 'lop', 'josh']);

  // FILTERING: sharing the fold's AGGREGATE must not import the fold's PRODUCTIVITY. An
  // unreduced value traversal that yields nothing filters the traverser, so the key vanishes;
  // fold() is a barrier that always yields (an empty list), so the key survives. TinkerPop pins
  // both on the same graph (Group.feature …_group_by_byXout_foldX vs …_byXout_orderX).
  const keys = (q: string) => run(store, q).map((r: any) => r.gk).sort();
  expect(keys('g.V().group().by("name").by(__.out().values("name"))')).toEqual(['josh', 'marko', 'peter']);
  expect(keys('g.V().group().by("name").by(__.out().values("name").fold())'))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  // a wholly unproductive value traversal filters every traverser → no groups at all
  expect(run(store, 'g.V().group().by("name").by(__.values("missing"))')).toEqual([]);
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

test('edge-gate composite key rows carry o/l/i + the edge (gate #2)', () => {
  const store = seededStore();
  const rows = run(store, 'g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())');
  // 6 distinct edges → 6 groups; verify marko-created->lop maps to edge 9
  const hit = rows.find((r) => r.k0_v === 'marko' && r.k1_v === 'created' && r.k2_v === 'lop');
  expect(hit.v_id).toBe(9);
  expect(hit.v_src).toBe(1); expect(hit.v_tgt).toBe(3);
});
});

// ---------- a MAP-shaped child body (the fourth child shape) ----------
//
// The child seam admitted element/scalar/list bodies; a map-producing body was inadmissible at
// EVERY position, which is why four separate index items named it as their blocker. It needed no new
// SQL — `lowerValueMap` is the ONE map builder and a MapStream is a one-column `map` blob plus
// carried columns (structurally a scalar's `v`). What was missing: the builder REFUSED to run with a
// live origin and declared no carried columns, so it could never rejoin a parent.
describe('a valueMap() child body', () => {
  // The oracle: a child map must decode to the SAME Map the root form does. Asserted through the
  // real GraphBinary wire, not the SQL rows, because the terminal framing is the part that had no
  // path for a list value side (properties are multi-valued).
  //
  // NB compared as a MULTISET, deliberately. Emission order through a child scope already differs
  // from the root form for the LONG-STANDING scalar child — `g.V(1).local(__.out().values("name"))`
  // yields [vadas,lop,josh] where `g.V(1).out().values("name")` yields [josh,lop,vadas] — so a map
  // child matching the root's order would make it the ONLY shape that does. That divergence is real
  // and pre-existing (canonical-emission-order territory, not this seam's), so these tests hold the
  // map child to the same contract as its siblings and the order gap is recorded below, not hidden.
  const framed = async (store: GraphStore, g: string) => {
    const vs = await decodeAll(executeQuery(store, g, {}));
    return vs.map((v: any) => JSON.stringify(v instanceof Map ? Object.fromEntries(v) : v)).sort();
  };

  test('a child map frames identically to the root form', async () => {
    const store = seededStore();
    for (const [child, root] of [
      ['g.V(1).local(__.valueMap("name"))', 'g.V(1).valueMap("name")'],
      ['g.V(1).map(__.valueMap("name"))', 'g.V(1).valueMap("name")'],
      ['g.V(1).local(__.valueMap())', 'g.V(1).valueMap()'],
      ['g.V().local(__.valueMap("name"))', 'g.V().valueMap("name")'],
    ]) expect(await framed(store, child)).toEqual(await framed(store, root));
  });

  test('the body composes a movement/filter prefix, so it is the ordinary element fold', async () => {
    const store = seededStore();
    // One map per REACHED element, not per parent — the prefix fans out and the rejoin keeps it.
    expect(await framed(store, 'g.V(1).local(__.out().valueMap("name"))'))
      .toEqual(await framed(store, 'g.V(1).out().valueMap("name")'));
    // …and a filtered prefix, proving the row-local vocabulary is the gate (not a map allow-list).
    expect(await framed(store, 'g.V(1).local(__.out().hasLabel("person").valueMap("name"))'))
      .toEqual(['{"name":["josh"]}', '{"name":["vadas"]}']);
  });

  test('one map per parent — the rejoin is per-origin, not global', async () => {
    const store = seededStore();
    // Every vertex yields exactly its own map: 6 vertices in, 6 maps out, each matching its root
    // projection. A rejoin that lost the ordinal would cross-product these.
    const child = await framed(seededStore(), 'g.V().local(__.valueMap("name"))');
    expect(child.length).toBe(6);
    expect(child).toEqual(await framed(store, 'g.V().valueMap("name")'));
  });

  test('KNOWN GAP, shared with every other child shape: emission order is not the root order', async () => {
    // Documented rather than hidden. A child scope re-orders relative to the root form, and the
    // long-standing SCALAR child does it identically — so this is the canonical-emission-order item,
    // not a map-child defect. Pinned as an EQUALITY between the two shapes so that whenever the
    // order gap is fixed, it must be fixed for both and this test tells us.
    const store = seededStore();
    const raw = async (g: string) => (await decodeAll(executeQuery(store, g, {})))
      .map((v: any) => (v instanceof Map ? (Object.values(Object.fromEntries(v))[0] as any[])?.[0] : v));
    expect(await raw('g.V(1).local(__.out().valueMap("name"))'))
      .toEqual(await raw('g.V(1).local(__.out().values("name"))'));
    // …and both differ from the root order, which is the gap itself.
    expect(await raw('g.V(1).local(__.out().values("name"))'))
      .not.toEqual(await raw('g.V(1).out().values("name")'));
  });

  test('there is ONE blob encoding: typed key, BARE value array', () => {
    const store = seededStore();
    // The blob is [[{t:'string',v:key},[values]],…] — the value side a naked array, which is the
    // untyped list substrate's contract that select(Column.values)/unfold own. It needs no rebuild
    // to frame: the typed framer treats a bare ARRAY as a list of bare members, exactly as it
    // treats a bare scalar as an inferred value. An earlier cut wrapped it into a typed
    // {t:'list'} node at materialize time, which meant two encodings and a conversion.
    const rows = run(store, 'g.V(1).local(__.valueMap("name"))') as any[];
    expect(JSON.parse(rows[0].map)).toEqual([[{ t: 'string', v: 'name' }, ['marko']]]);
  });

  test('the re-entry consumers still see the BARE value side (contract unchanged)', () => {
    const store = seededStore();
    // select(Column.values)/unfold aggregate the value side as a plain nested array. If materialize
    // had typed the blob in place instead, this would come back double-encoded.
    expect((run(store, 'g.V(1).valueMap("name").select(Column.values)') as any[]).length).toBe(1);
    expect((run(store, 'g.V(1).valueMap("name").unfold()') as any[]).length).toBe(1);
  });

  test('a retyping suffix and an element-valued map fail CLOSED', () => {
    const store = seededStore();
    // A suffix that retypes the map (unfold/select(Column)/count(local)) lands on a list/entry/
    // scalar shape, so the consumer needs the matching rejoin — declined, not answered.
    expect(() => run(store, 'g.V(1).local(__.valueMap().unfold())')).toThrow(/not yet supported/);
    // valueMap(true) tokens re-entry keeps the builder's own deferral.
    expect(() => run(store, 'g.V(1).local(__.valueMap(true))')).toThrow(/not yet supported/);
  });
});
