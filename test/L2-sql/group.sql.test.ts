// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { STATIC, TYPED_MEMBERS, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { read as bare_read, read, run, runWith, seededStore } from '../support/harness.ts';
import { t } from '../../src/io.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('group / properties SQL', () => {

  // ONE BLOB, WHATEVER THE VARIANT — the keys and the tokens are spent BUILDING the map, so nothing
  // about them survives onto the shape. That is §6·3: a shape is a value plus a framing arm, and the
  // arm here is the one every map value already had.
  test('valueMap variants all frame as one map VALUE', () => {
    for (const query of ['g.V().valueMap()', 'g.V().valueMap(true)', 'g.V().valueMap("name","age")', 'g.V().elementMap()'])
      expect(read(query).shape).toEqual({ kind: 'mapValue' });
  });








  test('P3 Stage C2: count()/is(typeOf(MAP)) re-enter a group value', () => {
    // A BARRIER EMITS ONE TRAVERSER, so a global `count()` after `group()` is 1 and only
    // `count(Scope.local)` is the map's SIZE (`GroupStep extends ReducingBarrierStep<S, Map<K,V>>`,
    // gremlin-core `step/map/GroupStep.java:51`). The lowering counts the map traversers.
    const c = read('g.V().group().by(T.label).count()');
    expect(c.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(c.sql).toContain('count(*)');
    expect(run(seededStore(), 'g.V().group().by(T.label).count()')).toEqual([{ v: 1 }]);
    // count(Scope.local) on a Map = its size, same value
    expect(read('g.V().group().by(T.label).count(Scope.local)').shape).toEqual({ kind: 'value', type: STATIC('long') });
    // is(typeOf(MAP)) is IDENTITY — a group IS a Map — expressed through the whole-map `mapValue` shape.
    expect(read('g.V().groupCount().by(T.label).is(typeOf(GType.MAP))').shape.kind).toBe('mapValue');
    // A NON-MATCHING typeOf is the EMPTY RESULT, not an error: `Set.feature:38-43` pins
    // `g.V().values("age").is(P.typeOf(GType.SET))` as "the result should be empty".
    expect(run(seededStore(), 'g.V().groupCount().by(T.label).is(typeOf(GType.LIST))')).toEqual([]);
    // A BARE `group()` KEYS BY THE ELEMENT ITSELF — the key is the ROWID in the `GROUP BY` and
    // `elementNode` builds the entry off it, once per surviving group. So `count()` after one is 1
    // (the barrier's single map traverser).
    expect(run(seededStore(), 'g.V().group().count()')).toEqual([{ v: 1 }]);
  });


  test('Commit B: a bare terminal Map.Entry stream materializes (size-1 MAP per entry)', () => {
    // group()/groupCount().unfold() with NO following select is a terminal value: the group
    // becomes a whole-map blob (MapStream), unfold() explodes it to a per-entry MapEntryStream,
    // and each entry row frames as a size-1 GraphBinary MAP. Scalar sides are typed {t,v} nodes.
    expect(read('g.V().groupCount().by(T.label).unfold()').shape)
      .toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } });
    // scalar key + scalar-reducer value
    expect(read('g.V().group().by(T.label).by(__.count()).unfold()').shape.kind).toBe('mapEntry');
    // scalar key + a COLLECTED value, named as one self-describing scalar node: a wrapped property
    // `by()` collects `{t,v}` nodes into a single `{t:'list',v:[…]}` node, so the value side genuinely
    // is one node. Frames `{person:[…], software:[…]}`.
    const sl = read("g.V().group().by(T.label).by('name').unfold()");
    expect(sl.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' },
      valOf: { kind: 'scalar' } });
    // an ELEMENT-list value: the value column expands its rowids to full element payloads
    // at the root (json_object over nodes), like the list substrate.
    const ev = read("g.V().hasLabel('software').group().by('name').unfold()");
    expect(ev.shape.kind).toBe('mapEntry');
    expect(ev.sql).toContain('json_object');
    // the group is assembled as ONE whole-map blob before unfold explodes it
    expect(read('g.V().groupCount().by(T.label).unfold()').sql).toContain('json_group_array');
  });

  test('valueMap() is a PER-ROW map producer, and the map loop takes its tail', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));

    // A VERTEX key is MULTI-VALUED so its value is a LIST; an EDGE key's is the value itself
    // (`PropertyMapStep.addElementProperties` — `map.compute(key, …values.add(value))` for a Vertex,
    // `map.put(key, value)` otherwise). Same asymmetry the element payload's own bags carry.
    expect(await dec("g.V().hasLabel('software').valueMap()"))
      .toEqual([new Map([['name', ['lop']], ['lang', ['java']]]), new Map([['name', ['ripple']], ['lang', ['java']]])]);
    // AN EDGE's value is FLAT, and the corpus pins it decisively though indirectly:
    // `integrated/SubgraphStrategy.feature:713-724` asserts `outE().valueMap().select(Column.values).
    // unfold()` yields `d[5].i`, which it could not if the value side were `[5]`.
    expect(await dec("g.E().hasLabel('knows').valueMap()"))
      .toEqual([new Map([['weight', 0.5]]), new Map([['weight', 1]])]);
    // A key SUBSET filters in SQL, and a key the element does not carry is simply absent — not null.
    expect(await dec("g.V().hasLabel('software').valueMap('name','age')"))
      .toEqual([new Map([['name', ['lop']]]), new Map([['name', ['ripple']]])]);

    // `valueMap(true)` (and `with(WithOptions.tokens)`, which a Pass desugars to it) adds the id and
    // label entries keyed by `T.id`/`T.label` — a GraphBinary type of its own, which is the `T` arm
    // `FrameNode` grew for it. The tokens LEAD, which is `addIncludedOptions` running before the
    // properties are added.
    const withTokens = (await dec("g.V().hasLabel('software').has('name','lop').valueMap(true)"))[0] as Map<unknown, unknown>;
    expect([...withTokens.keys()].map(String)).toEqual(['T.id', 'T.label', 'name', 'lang']);
    expect(withTokens.get(t.label)).toBe('software');
    expect(await dec("g.V().has('name','lop').valueMap().with('~tinkerpop.valueMap.tokens')"))
      .toEqual(await dec("g.V().has('name','lop').valueMap(true)"));

    // AND IT COMPOSES WITH THE MAP LOOP, which is the whole point of building the producer onto the
    // same shape: the sides, the size and the entries all work over a `valueMap()` unchanged.
    // The map's SIZE, via a map-local reducer.
    expect(await dec("g.V().hasLabel('software').valueMap().count(Scope.local)")).toEqual([2, 2]);
    expect(await dec("g.V().has('name','lop').valueMap().select(Column.values)")).toEqual([[['lop'], ['java']]]);
    expect(await dec("g.V().has('name','lop').valueMap().unfold().select(Column.keys)")).toEqual(['name', 'lang']);
    // An element with NO properties is an EMPTY map and still one traverser.
    expect(await dec("g.V().hasLabel('software').valueMap('nope')")).toEqual([new Map(), new Map()]);
  });

  test('a MAP IS A SCOPE: select(<key>) reads it before the path labels', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));
    // `Scoping.getScopeValue` asks `object instanceof Map && containsKey(key)` FIRST and only then the
    // side effects and the path labels (gremlin-core `step/Scoping.java:119-135`), and
    // `Select.feature:758-769` pins the resolution end to end
    // (`elementMap("name").as("a")…select("a").select("name")` → `marko`).
    expect(await dec("g.V().has('name','lop').valueMap().select('name')")).toEqual([['lop']]);
    // `containsKey`, not "the value is not null": an ABSENT key drops the traverser (`SelectOneStep`'s
    // `ifProductive` emits nothing), so the two software vertices are gone rather than null.
    expect(await dec("g.V().valueMap().select('age')")).toEqual([[29], [27], [32], [35]]);
    // A key in NEITHER the map nor the labels is the empty result.
    expect(await dec("g.V().valueMap().select('nope')")).toEqual([]);
    // A groupCount map is a scope too — the key is a grouping VALUE, not a property name.
    expect(await dec("g.V().groupCount().by('name').select('marko')")).toEqual([1]);
  });

  test('select(name) over a NAMED COLLECTION cross-joins the finished side effect onto the stream', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));
    // `Scoping.getScopeValue` consults `traverser.getSideEffects()` before the path
    // (`step/Scoping.java:119-131`), so `select("a")` naming a `groupCount`/`group`/`aggregate`
    // side effect resolves to the FINISHED collection, emitted once per surviving traverser — a CROSS
    // join of the stream onto the one-row reduced value. `count(Scope.local)` then counts its entries.
    // GroupCount.feature `g_V_groupCountXaX_selectXaX_countXlocalX` / Group.feature the `by("name")` twin:
    // 6 traversers each see the size-6 map → [6,6,6,6,6,6].
    expect(await dec("g.V().groupCount('a').select('a').count(local)")).toEqual([6, 6, 6, 6, 6, 6]);
    expect(await dec("g.V().group('a').by('name').by().select('a').count(local)")).toEqual([6, 6, 6, 6, 6, 6]);
    // The alias map rides THROUGH the cross join, so a `select` back to a still-live path LABEL after a
    // collection select composes (Select.feature the withoutStrategies scenario): the 6 vertices, once each.
    const labelled = await dec('g.withoutStrategies(LazyBarrierStrategy).V().as("label").local(aggregate("x")).select("x").select("label")');
    expect(labelled.map((v: any) => v.id).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    // A repeat/unfold composition: aggregate all vertices twice → the 12-member list, taken once, unfolded.
    expect((await dec('g.V().repeat(__.aggregate("x")).times(2).select("x").limit(1).unfold()')).length).toBe(12);
  });

  test('a Scope.local slice over a multi-key select record is an order-preserving ENTRY slice', async () => {
    const store = seededStore();
    const asMap = async (q: string) => (await decodeAll(executeQuery(store, q))).map((m: any) => Object.fromEntries(m));
    // A multi-key `select(k…).by(…)` frames as a RECORD; a `Scope.local` count/slice reads it AS A MAP
    // (`Scoping`/`SelectStep` yield a LinkedHashMap), so the record COLLAPSES via `recordToMap` and
    // re-enters `mapTail`. `limit`/`range`/`tail`(Scope.local) keep a window of the ENTRIES in insertion
    // order (`RangeLocalStep.applyRangeMap` / `TailLocalStep`), pinned by the corpus:
    // count(local) — the record's entry count (Group/GroupCount `select(a).count(local)` share the arm).
    expect(await decodeAll(executeQuery(store,
      'g.V().as("a").out().as("b").select("a","b").by("name").count(local)'))).toEqual([2, 2, 2, 2, 2, 2]);
    // Range.feature: limit keeps the FIRST n entries; the `c` label is unbound over a 2-hop `in()`.
    expect(await asMap('g.V().as("a").in().as("b").in().as("c").select("a","b","c").by("name").limit(Scope.local, 1)'))
      .toEqual([{ a: 'lop' }, { a: 'ripple' }]);
    // range(1,2) drops entry 0, keeps entry 1; tail(1) keeps the LAST entry — all in insertion order.
    expect(await asMap('g.V().as("a").out().as("b").out().as("c").select("a","b","c").by("name").range(Scope.local, 1, 2)'))
      .toEqual([{ b: 'josh' }, { b: 'josh' }]);
    expect(await asMap('g.V().as("a").out().as("b").out().as("c").select("a","b","c").by("name").tail(Scope.local, 1)').then((r) => r.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))))
      .toEqual([{ c: 'lop' }, { c: 'ripple' }]);
  });

  test('the MAP LOOP: a map traverser answers its sides, its size and its entries', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));

    // `select(Column.keys)` over a MAP is a `LinkedHashSet` and `select(Column.values)` an
    // `ArrayList` (gremlin-core `structure/Column.java:22-47`), so the key side frames as a
    // GraphBinary SET. `Set.feature:47-56` pins that reading — `g.V().valueMap().select(keys)`
    // yields `s[name,age]` — and the set marker rides through the list vocabulary to say so.
    expect(read("g.V().groupCount().by('name').select(Column.keys)").shape)
      .toEqual({ kind: 'jsonbSet', items: TYPED_MEMBERS });
    expect(read("g.V().groupCount().by('name').select(Column.values)").shape.kind).toBe('jsonbList');
    expect(await dec("g.V().groupCount().by('name').select(Column.values)"))
      .toEqual([[1, 1, 1, 1, 1, 1]]);

    // `count(Scope.local)` is the map's SIZE — `json_array_length` over the pairs array, no explode.
    expect(await dec("g.V().groupCount().by('name').count(Scope.local)")).toEqual([6]);
    // The SIZE is read off the pairs array.
    expect(read("g.V().groupCount().by('name').count(Scope.local)").sql)
      .toContain('json_array_length');

    // `unfold()` makes each ENTRY a traverser, and a following `select(Column.*)` takes THAT entry's
    // side rather than collecting one — the same `Column`, a different host (`Column.java:26-29`).
    expect(await dec("g.V().groupCount().by('name').unfold()"))
      .toEqual([new Map([['josh', 1]]), new Map([['lop', 1]]), new Map([['marko', 1]]),
        new Map([['peter', 1]]), new Map([['ripple', 1]]), new Map([['vadas', 1]])]);
    expect(await dec("g.V().groupCount().by('name').unfold().select(Column.keys)"))
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    expect(await dec("g.V().groupCount().by('name').unfold().select(Column.values)"))
      .toEqual([1, 1, 1, 1, 1, 1]);

    // A BARRIER emits ONE traverser, so the whole global row vocabulary applies to that one row:
    // `count()` is 1, and a slice takes the map or nothing.
    expect(await dec("g.V().groupCount().by('name').count()")).toEqual([1]);
    expect(await dec("g.V().groupCount().by('name').limit(0)")).toEqual([]);
  });









  test('the GROUP-SCOPED reducer pools the child rows, and the ORIGIN channel is what carries the key', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));
    // `GroupStep` applies the value traversal's PRE-BARRIER part per traverser and lets the BARRIER
    // reduce what every member of a key contributed (`Grouping.determineBarrierStep`), so this is one
    // sum per LABEL and not the sum of per-vertex sums re-summed. The two agree for `sum` and disagree
    // for `mean`, which is why it may not be a decomposition table.
    expect(await dec("g.V().hasLabel('software').group().by('name').by(__.bothE().values('weight').sum())"))
      .toEqual([new Map([['lop', 1], ['ripple', 1]])]);
    expect(await dec("g.V().hasLabel('software').group().by('name').by(__.bothE().values('weight').max())"))
      .toEqual([new Map([['lop', 0.4], ['ripple', 1]])]);
    // `by(__.count())` with an EMPTY body is not that question: it counts the group's own traversers,
    // which is `groupCount()`'s value exactly, and it re-enters that arm rather than growing a second
    // spelling of one answer.
    expect(await dec("g.V().has('lang').group().by('lang').by(__.count())")).toEqual([new Map([['java', 2]])]);
    // The ORIGIN CHANNEL is the mechanism, and the SQL says so: the seed names it, the movement's arms
    // carry it, and the KEY is re-read off it rather than carried through the join.
    const sql = bare_read("g.V().group().by('name').by(__.bothE().values('weight').sum())").sql;
    expect(sql).toContain('AS origin');
    expect(sql).toMatch(/rp\d+\.node = \w+\.origin/);
    // A body reading a LABEL resolves, because the host's labels ride into the sub-fold — handing over
    // an empty map would have made an unresolvable `select()` (now the EMPTY RESULT) pool zero rows.
    expect(await dec("g.V().hasLabel('person').as('p').out('created').group().by('name').by(__.select('p').values('age').sum())"))
      .toEqual([new Map([['lop', 96], ['ripple', 32]])]);
  });

  test('properties() joins the property table into a property shape', () => {
    // Asserted as MEANING rather than spelling, because the lowering picks its own aliases
    // (`rpr3`/`rn`). Per test/CLAUDE.md a snapshot asserts semantic equivalence, not byte-identity.
    // The name used to say "expands props via json_each", which was true before properties were
    // normalized out of a JSONB blob into their own table.
    const p = read('g.V().properties()');
    expect(p.sql).toMatch(/INNER JOIN vertex_properties \w+ ON|JOIN vertex_properties \w+ ON/);
    expect(p.sql).toMatch(/\bnode\b\s*=/);
    expect(p.shape).toEqual({ kind: 'property' });

    // The key filter is an extra JOIN condition. A key written in the traversal text is a parsed
    // LITERAL, i.e. a constant the compiler already holds, so the lowering inlines it as a typed SQL
    // literal and spends none of the DO's 100 parameters on it. A bind serves a user PARAMETER and
    // nothing else (root CLAUDE.md). The `properties` family's hygiene baseline records the result
    // directly: binds=0, bound=0.
    const named = read('g.V().properties("name","age")');
    expect(named.sql).toMatch(/\bkey\b IN \('name', ?'age'\)|\bkey\b IN \(\?,\?\)/);
    expect(named.binds.length).toBeLessThanOrEqual(2);
  });

  test('properties() follow-ons: key/value/count/element project the right column', () => {
    // Column MEANING, not the alias: the lowering names its own relations. `key()` reads the property
    // table's `key`, `value()` its `value` — whatever the lowering calls the relation it reads them
    // from.
    expect(read('g.V().properties().key()').sql).toMatch(/\.(key|pk) AS v/);
    expect(read('g.V().properties().value()').sql).toMatch(/\.(value|pv)\b|AS pv\b/);
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toMatch(/vertex_properties \w+ ON/);
  });







  // `by(__.tail())` — the group's value is the LAST TRAVERSER routed to the key
  // (`Grouping.determineBarrierStep` finds the barrier; `TailGlobalStep(1)` keeps the last to arrive,
  // which is the members' own encounter order). It is the collecting arm plus one `$[#-1]`, which is
  // why it declares `mapValue` like every other map and needs no shape of its own.
  test('group().by(key).by(__.tail()) is the LAST member, through the collecting arm', () => {
    const p = read('g.V().group().by("name").by(__.tail())');
    expect(p.shape).toEqual({ kind: 'mapValue' });
    expect(p.sql).toContain("'$[#-1]'");
  });



  test('group().by(child).by(child) assigns the last arriving traverser\'s scalar value', () => {
    const p = read('g.V().group().by(__.values("name").substring(0,1)).by(__.constant(1))');
    expect(p.shape).toEqual({ kind: 'mapValue' });
    expect(p.sql).toMatch(/json_extract\(json_group_array\(json\(\w+\.gt\) ORDER BY \w+\.go ASC\) FILTER \(WHERE \(\w+\.gt IS NOT NULL\)\), '\$\[#-1\]'\)/);
    expect(p.sql).not.toContain("json_object('t', 'list', 'v', json_group_array(json(");
  });



  test('a sack is an ordinary carried CHANNEL — RelIR', () => {
    const store = seededStore();
    const rel = {} as const;
    // THE WHOLE RUN FUSES: the seed, the fold and the read are three `Project`s over one relation, and
    // the block assembler puts them in one SELECT. So the assertion worth making is that the SEED is a
    // compile-time constant inlined into the fold, not that a named relation carries it.
    const p = read('g.withSack(0.0d).V().sack(sum).by("age").sack()', rel);
    expect(p.kind).toBe('read');
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(p.sql).toContain('(0.0 + (SELECT');
    expect(p.binds).toEqual([]);
    // `div` forces REAL division — SQLite's `/` is integer division on integer operands, which is the
    // one operator whose obvious spelling answers a different question.
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()', rel).sql).toContain('CAST(2 AS REAL) / 4.0');
    // `assign` needs no prior value, so it MINTS the channel where no `withSack()` seeded one.
    expect(runWith(store, 'g.V().sack(assign).by("age").sack()', rel).map((r) => r.v)).toEqual([29, 27, 32, 35]);
    // The by() is the ordinary modulator seam, so a CHILD body works here the day it works anywhere.
    expect(runWith(store, 'g.withSack(0).V().sack(assign).by(__.outE().count()).sack()', rel).map((r) => r.v).sort())
      .toEqual([0, 0, 0, 1, 2, 3]);
    // A `by()` that yields nothing DROPS the traverser — the vocabulary's rule, not this host's.
    expect(runWith(store, 'g.V().sack(assign).by("age").sack()', rel)).toHaveLength(4);
  });


  test('terminal group(a) with no cap passes the traversers through (side-effect discarded)', () => {
    // a side-effecting group() without a cap is a pass-through: the stream is the result.
    expect(read('g.V().group("a").by("name")').shape).toEqual({ kind: 'vertex' });
  });



  // ---------- upstream's own GRAPH-SNAPSHOT reads: an ELEMENT-KEYED / RECORD-KEYED side read ----------
  //
  // These two are `getEdges`/`getVertexProperties` from the cucumber harness's `BeforeAll`
  // (`vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/world.js:157-190`), verbatim.
  //
  // A `project()` key is the RECORD shape collapsed to a map VALUE — the boundary `record.ts`
  // always named — so the group key is one `{t:'map', v:[[k,node],…]}` column and the shape is the
  // ordinary `mapValue`.
  test('group().by(__.project) — a RECORD-keyed group over an edge stream (upstream getEdges)', () => {
    const gremlin = 'g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())';
    const p = read(gremlin);
    expect(p.kind).toBe('read');
    expect(p.shape).toEqual({ kind: 'mapValue' });
    // The key IS the record's map node, named once as a column and grouped by that column — the
    // plan-quality rule every by() key here follows (a correlated subquery inlined at each position
    // is what naming it prevents).
    expect(p.sql).toContain("json_object('t', 'map', 'v'");
    expect(p.sql).toContain('GROUP BY');
    // Each field lowers through the ORDINARY child seam: `outV()`/`inV()` re-root the host to the
    // endpoint (exactly one by the schema), `label()` is the token projection every by() shares.
    expect(p.sql).toContain('SELECT ree');   // the endpoint re-root reads the edge row
    expect(p.sql).toContain('FROM labels');  // label() → the labels dictionary, not a second spelling

    // THE ANSWER — what the harness actually consumes: a Map keyed by a Map. The key rides as the
    // typed pairs array, each field under its OWN type, which is what lets a record key round-trip.
    const store = seededStore();
    const pairs = JSON.parse(run(store, gremlin)[0]!.map) as [any, any][];
    expect(pairs).toHaveLength(6); // 6 distinct (out-name, label, in-name) triples in the modern graph
    const marko = pairs.find(([k]) => k.v[0][1].v === 'marko' && k.v[2][1].v === 'lop');
    expect(marko![0]).toEqual({ t: 'map', v: [
      ['o', { t: 'string', v: 'marko' }], ['l', { t: 'string', v: 'created' }], ['i', { t: 'string', v: 'lop' }],
    ] });
    // The VALUE is the last edge routed to that key — one edge, framed as a typed element member.
    expect(marko![1].t).toBe('edge');
    expect(marko![1].v.id).toBe(9);
  });

  test('properties().group() — a RECORD key over a PROPERTY stream (upstream getVertexProperties)', () => {
    const gremlin = 'g.V().properties().group().by(__.project("n","k","v").by(__.element().values("name")).by(__.key()).by(__.value())).by(__.tail())';
    const p = read(gremlin);
    expect(p.kind).toBe('read');
    expect(p.shape).toEqual({ kind: 'mapValue' });
    // Every key part is the ORDINARY child seam over a PROPERTY host — `element()` re-roots to the
    // owner (exactly one by the schema) and `key()`/`value()` are correlated reads of the stored row.
    // There is no property-specific reader, which is what makes the same `project()` work here and
    // over the edge stream above.
    expect(p.sql).toContain("json_object('t', 'map', 'v'");
    expect(p.sql).toContain('FROM vertex_properties');
    // The group's members are the PROPERTIES themselves — the typed tree's third element kind.
    expect(p.sql).toContain("'t', 'property'");

    const store = seededStore();
    const pairs = JSON.parse(run(store, gremlin)[0]!.map) as [any, any][];
    // 12 vertex properties in the modern graph, each its own (owner-name, key, value) triple.
    expect(pairs).toHaveLength(12);
    // An `age` key keeps its stored INT type where the owner's name is a string — the per-row type
    // channel (§6·7) surviving into a record field and out again, which is the whole reason the
    // harness can stringify these keys and get upstream's own `n-k->v` back.
    const markoAge = pairs.find(([k]) => k.v[0][1].v === 'marko' && k.v[1][1].v === 'age');
    expect(markoAge![0]).toEqual({ t: 'map', v: [
      ['n', { t: 'string', v: 'marko' }], ['k', { t: 'string', v: 'age' }], ['v', { t: 'int', v: 29 }],
    ] });
    // The VALUE is the VertexProperty itself — the typed tree's third element kind.
    expect(markoAge![1]).toEqual({ t: 'property', v: { vpid: 2, owner: 1, pk: 'age', pv: 29, pvtype: 'int', pmeta: null } });
  });

  // The NEIGHBOURING combinations of the two shapes above. Neither is in the corpus and both are
  // legal Gremlin: a record key and a re-rooted host compose wherever a `by()` body is legal, so the
  // question "does this work HERE?" must not have a per-position answer.
  test('a RECORD key and a RE-ROOTED host compose at every by() position they are legal in', () => {
    const store = seededStore();
    // A record key over the simplest host — a vertex stream, no re-rooting involved.
    const byNameLang = JSON.parse(run(store, 'g.V().group().by(__.project("n","l").by("name").by(T.label)).by(__.count())')[0]!.map) as [any, any][];
    expect(byNameLang).toHaveLength(6);
    expect(byNameLang.every(([k]) => k.t === 'map' && k.v.length === 2)).toBeTrue();

    // A re-rooted host as the WHOLE body — the value is the endpoint ELEMENT, so the key is a vertex
    // member rather than a scalar. `byNode`'s element arm and the seam's element framing, meeting.
    const byOutV = JSON.parse(run(store, 'g.E().group().by(__.outV()).by(__.count())')[0]!.map) as [any, any][];
    expect(byOutV).toHaveLength(3); // marko, josh, peter are the only out-vertices
    expect(byOutV.every(([k]) => k.t === 'vertex')).toBeTrue();

    // The same re-rooting one host along: `element()` over a PROPERTY stream, as a group key.
    const byOwner = JSON.parse(run(store, 'g.V().properties().group().by(__.element()).by(__.count())')[0]!.map) as [any, any][];
    expect(byOwner).toHaveLength(6);
    expect(byOwner.every(([k]) => k.t === 'vertex')).toBeTrue();

    // A record key NESTED in a record key — the assembly is recursive, so depth changes nothing.
    const nested = JSON.parse(run(store, 'g.E().group().by(__.project("l","e").by(__.label()).by(__.project("o").by(__.outV().values("name")))).by(__.count())')[0]!.map) as [any, any][];
    expect(nested.every(([k]) => k.t === 'map' && k.v[1][1].t === 'map')).toBeTrue();
  });



});

/**
 * `by(__.select(label))` — THE ALIAS ARM of the by() vocabulary.
 *
 * It reads as a nested traversal and is not one: the answer is the alias CHANNEL on the host's own
 * row, not a correlated subquery over the traverser. `Scoping.getScopeValue` makes no distinction
 * between a `select()` in a `by()` and one in the chain (the map, then side-effects, then the path
 * labels — `vendor/tinkerpop/gremlin-core/.../step/Scoping.java:117-131`), so the arm lives in
 * `modulator.ts` and EVERY host gained it at once.
 *
 * The shapes the arm cannot express are asserted to REFUSE (raise `UnsupportedTraversal`); everything
 * it can express asserts the answer absolutely, against the reference's semantics.
 */
describe('by(__.select(label)) — the alias arm', () => {
  const node = (v: any): any => (v && typeof v === 'object' && 't' in v
    ? (v.t === 'vertex' || v.t === 'edge' ? v.v.props.name[0].v : v.t === 'list' ? v.v.map(node) : v.v)
    : v);
  test('a RECORD field keeps the label as an ELEMENT, so it re-enters as a vertex stream', () => {
    const store = seededStore();
    // The record's payoff, stated as a property rather than as a spelling: the field holds the
    // ROWID, so `select()` on it re-roots to elements and the chain carries on. A blob could not —
    // by then the element is an expanded payload with no id to move from.
    expect(new Set(runWith(store, 'g.V().as("v").out().project("vertex","n").by(__.select("v")).by("name").select("vertex").values("name")')
      .map((r) => r.v))).toEqual(new Set(['marko', 'josh', 'peter']));
    const plan = read('g.V().as("v").out().project("vertex","n").by(__.select("v")).by("name")');
    expect(plan.kind).toBe('read');
    expect(plan.shape).toEqual({ kind: 'mapValue' });
  });

  test('an unreadable label DECLINES rather than answering a different question', () => {
    // A label this relation does not carry, a `Pop.all` LIST result and a multi-label `select` in a
    // by() slot are all shapes the arm cannot express. Each must route away, never guess.
    for (const gremlin of [
      'g.V().out().project("x").by(__.select("nope"))',
      'g.V().as("a").out().as("a").project("x").by(__.select(Pop.all, "a"))',
      'g.V().as("a").as("b").out().project("x").by(__.select("a","b"))',
    ]) expect(() => compile(gremlin, {}), gremlin).toThrow(UnsupportedTraversal);
  });
});
