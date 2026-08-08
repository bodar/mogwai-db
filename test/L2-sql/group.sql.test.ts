// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, SCALAR_MEMBERS, STATIC, TYPED_MEMBERS, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { executeQuery } from '../support/executor.ts';
import { decode, decodeAll } from '../support/decode.ts';
import { bagOf, read as bare_read, read, relirOff, run, runWith, seededStore } from '../support/harness.ts';
import type { CompileOptions } from '../../src/compiler/compiler.ts';
import { t } from '../../src/io.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('group / properties SQL', () => {
  test('group() carries emission order into both member-list lowerings', () => {
    const query = 'g.V().both().group().by(T.label)';
    const rel = read(query, { spine: 'rel' });
    expect(rel.sql).toContain('AS go');
    expect(rel.sql).toContain('ORDER BY gm23.go ASC');
    expect(rel.sql).toContain('AS encounter');

    const legacy = read(query, { spine: 'legacy' });
    expect(legacy.sql).toContain('ROW_NUMBER() OVER (ORDER BY p.encounter) AS encounter');
    expect(legacy.sql).toContain('ORDER BY p.encounter');
  });

  // LEGACY'S valueMap SHAPE VOCABULARY, pinned at that spine explicitly.
  //
  // It names the KEYS, the token flag and the label regime on the SHAPE and rebuilds the map in the
  // framer; RelIR builds the map in the ALGEBRA and hands over one `mapValue` blob (§6·3 — a shape is
  // a value plus a framing arm). Both frame the same bytes, which the RelIR-position test below
  // asserts against this one's answers. Pinned rather than made conditional because what these lines
  // are ABOUT is legacy's descriptor, and that claim is the same in either run.
  test('valueMap variants set shape, reuse the vertex row source', () => {
    const legacy = (query: string) => read(query, { spine: 'legacy' }).shape;
    expect(legacy('g.V().valueMap()')).toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: false });
    expect(legacy('g.V().valueMap(true)')).toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    expect(legacy('g.V().valueMap("name","age")')).toEqual({ kind: 'valueMap', labelSet: false, keys: ['name', 'age'], tokens: false });
    expect(legacy('g.V().elementMap()')).toEqual({ kind: 'elementMap', labelSet: false, keys: null });
    // RelIR: ONE blob, whatever the variant — the keys and the tokens are spent building it.
    if (!relirOff) for (const query of ['g.V().valueMap()', 'g.V().valueMap(true)', 'g.V().valueMap("name","age")'])
      expect(read(query).shape).toEqual({ kind: 'mapValue' });
  });

  test('valueMap().with(WithOptions.tokens) desugars to valueMap(true) (item 13)', () => {
    // The JS GLV resolves WithOptions.tokens/.all to the wire strings/ints '~tinkerpop.valueMap.
    // tokens'/15 before sending, so the real conformance query is with('~…tokens'). The tokens
    // option with no selector (or + all) IS valueMap(true): the fold Pass sets the tokens flag,
    // so the shape matches its valueMap(true) equivalent exactly. Both wire and enum forms fold.
    // The DESUGARING is a Pass, so it is true above both spines and asserted on the ambient one.
    expect(read('g.V().valueMap().with("~tinkerpop.valueMap.tokens")').shape)
      .toEqual(read('g.V().valueMap(true)').shape);
    expect(read('g.V().valueMap("name","age").with("~tinkerpop.valueMap.tokens")').shape)
      .toEqual(read('g.V().valueMap(true,"name","age")').shape);
    // …and it reaches legacy's own token flag, which is what says the Pass ran rather than the shapes
    // merely matching each other.
    expect(read('g.V().valueMap().with("~tinkerpop.valueMap.tokens", 15)', { spine: 'legacy' }).shape)
      .toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    expect(read('g.V().valueMap().with(WithOptions.tokens)', { spine: 'legacy' }).shape) // enum form (typed at our server)
      .toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    // A SELECTIVE token subset (labels=2) has no valueMap(true) equivalent yet → fail closed,
    // never silently widened to all-tokens.
    expect(() => read('g.V().valueMap("name","age").with("~tinkerpop.valueMap.tokens", 2).by(__.unfold())'))
      .toThrow('with() cannot consume the valueMap result shape');
  });

  // LEGACY'S valueMap RE-ENTRY, pinned at that spine — RelIR's is the map loop's own test below.
  test('P3 Stage B: valueMap() re-enterable — select(Column), count, is(typeOf(MAP))', () => {
    const read = (query: string, options?: CompileOptions) => bare_read(query, { ...options, spine: 'legacy' });
    // valueMap() → a per-element whole-map blob MapStream (one `map` blob per element, folding
    // {k:[v]} into [[{t,v},valueList],…]); select(Column.keys) aggregates one key-list per map.
    const keys = read('g.V().valueMap().select(Column.keys)');
    expect(keys.sql).toContain('json_each');
    expect(keys.sql).toContain('json_group_array(json_array('); // per-element blob assembly
    // the keys list holds typed {t,v} string nodes (uniform typed map encoding)
    expect(keys.shape).toEqual({ kind: 'jsonbList', items: TYPED_MEMBERS });
    // key subset filters at SQL level (je.key IN (?)); values().unfold() explodes per element
    const vals = read("g.V().valueMap('location').select(Column.values).unfold()");
    expect(vals.sql).toContain('je.key IN (?)');
    // count() over maps = one per element = count of elements; is(typeOf(MAP)) is identity
    expect(read('g.V().valueMap().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().valueMap().is(typeOf(GType.MAP)).count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    // per-element list ops (unfold + set-ops) compose over the derived value list (was a crash)
    const combined = read("g.V().valueMap('location').select(Column.values).unfold().combine(['seattle'])");
    expect(combined.sql).toContain('json_each');
    // select(unbound-label) → empty (TinkerPop); a bound as()-label defers
    expect(read("g.V().valueMap().select('a')").sql).toContain('WHERE 0');
    expect(read("g.V().valueMap().select(Pop.first,'a')").sql).toContain('WHERE 0');
    expect(() => compile("g.V().as('a').valueMap().select('a')", {})).toThrow('select(bound-label) after valueMap() not yet supported');
    // terminal valueMap unchanged; still-unsupported followers fail closed
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: false });
    expect(() => compile('g.V().valueMap(true).select(Column.keys)', {}, { spine: 'legacy' })).toThrow('valueMap(true)/token re-entry not yet supported');
    // RelIR re-enters a TOKEN map like any other: the token entries are ordinary pairs of the same
    // self-describing tree, so the key side is the `T` node beside the property-name nodes.
    if (!relirOff) expect(bare_read('g.V().valueMap(true).select(Column.keys)').shape).toEqual({ kind: 'jsonbSet', items: TYPED_MEMBERS });
  });

  test('order(Scope.local).by(Column.keys/values) re-sorts a map blob in place', () => {
    // group().by(k).by(reducer).order(local).by(values): the pairs array is re-sorted by the
    // value side, type-correctly (compareKey → numeric values sort numerically). Same-shape
    // MapStream out (ordering is a blob transform), so a following unfold()/select re-enters it.
    const byVals = read('g.V().hasLabel("person").group().by("name").by(__.outE().values("weight").sum()).order(Scope.local).by(Column.values)');
    expect(byVals.sql).toContain('json_each');
    expect(byVals.sql).toContain('ORDER BY'); // the in-place re-sort of the pairs
    expect(byVals.sql).toContain('CASE WHEN'); // compareKey numeric/text discrimination
    expect(byVals.shape).toEqual({ kind: 'mapValue' });
    // by(Column.keys) sorts the key side; desc flips direction; both re-enter through unfold().
    const keysUnfold = read('g.V().valueMap().order(Scope.local).by(Column.keys).unfold()');
    expect(keysUnfold.sql).toContain('ORDER BY');
    expect(keysUnfold.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'list', of: SCALAR_MEMBERS } });
    const desc = read('g.V().values("age").groupCount().order(Scope.local).by(Column.values, Order.desc)');
    expect(desc.sql).toContain('DESC');
    // Fail closed: an element/list-valued map side has no total order → clear deferral.
    expect(() => compile('g.V().groupCount().order(Scope.local).by(Column.keys)', {}))
      .toThrow('order(Scope.local).by(Column.keys) over an element/list map key not yet supported');
    // shuffle-local and multi-term/by(key) orders are not Column-local orders → defer elsewhere.
  });

  // LEGACY'S Map.Entry stream, pinned at that spine for `P3 Stage B`'s reason.
  test('Commit A: valueMap().unfold() → per-element Map.Entry stream', () => {
    const read = (query: string, options?: CompileOptions) => bare_read(query, { ...options, spine: 'legacy' });
    // valueMap().unfold(): valueMap retypes to a per-element whole-map blob MapStream, unfold()
    // explodes it to a per-entry MapEntryStream (key = typed {t,v} scalar, value = its list).
    const t = read('g.V().valueMap().unfold()');
    expect(t.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'list', of: SCALAR_MEMBERS } });
    expect(t.sql).toContain('json_each'); // explode the map blob into entry rows
    // select(keys) per entry → the key, framed by its own stored type (a typed {t,v} node).
    expect(read('g.V().valueMap().unfold().select(keys)').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // select(values) per entry → the value (a valueMap value is a list) → a list value.
    expect(read('g.V().valueMap().unfold().select(values)').shape.kind).toBe('jsonbList');
    // map(__.select(keys)) is the 1-to-1 form — unwrapped to the same per-entry key select
    expect(read('g.V().valueMap().unfold().map(__.select(keys))').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // elementMap().unfold() fails CLOSED (token entries + single values deferred)
    expect(() => compile('g.V().elementMap().unfold()', {}, { spine: 'legacy' })).toThrow('elementMap() re-entry not yet supported');
  });

  test('Commit C: is(typeOf(MAP)) over a stored map property → MapStream retype', () => {
    // A stored map property (vtype='map') retypes to a whole-map blob MapStream: the stored
    // value (a [[keyNode,valNode],…] {t,v}-node blob) becomes the `map` column, filtered to map rows.
    const t = read("g.V().values('m').is(typeOf(GType.MAP))");
    expect(t.shape).toEqual({ kind: 'mapValue' });      // terminal → frame each whole map
    expect(t.sql).toContain("= ?");                      // WHERE vtype = 'map'
    // count(Scope.local) → entry count (map size) via json_array_length
    const cnt = read("g.V().values('m').is(typeOf(GType.MAP)).count(Scope.local)");
    expect(cnt.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(cnt.sql).toContain('json_array_length');
    // select(values)/select(keys) → one list value (typed items); unfold() → per-entry MapEntryStream
    expect(read("g.V().values('m').is(typeOf(GType.MAP)).select(values)").shape).toEqual({ kind: 'jsonbList', items: TYPED_MEMBERS });
    expect(read("g.V().values('m').is(typeOf(GType.MAP)).unfold()").shape.kind).toBe('mapEntry');
    // richer followers fail CLOSED (correct-by-design deferral, not mis-execution)
    expect(() => compile("g.V().values('m').is(typeOf(GType.MAP)).where(count(Scope.local).is(P.gt(1)))", {})).toThrow('where() on a map value not yet supported');
    expect(() => compile("g.V().values('m').is(typeOf(GType.MAP)).fold()", {})).toThrow('fold() on a map value not yet supported');
    // a stored scalar of another type (age=int) retypes+filters to EMPTY (WHERE vtype='map'
    // matches no row) — exactly like is(typeOf(LIST)) on a non-list; a correct empty result.
    expect(read("g.V().values('age').is(typeOf(GType.MAP))").shape.kind).toBe('mapValue');
  });

  // LEGACY'S scalar-host groupCount, pinned at that spine — RelIR's is the same `groupBarrier` the
  // element host uses and frames one `mapValue` blob; the assertions here are about legacy's `group`
  // descriptor and its `gkt` sibling column, which is a claim that reads the same in either run.
  test('P3 Stage C: bare groupCount() over a scalar stream groups by value', () => {
    const read = (query: string, options?: CompileOptions) => bare_read(query, { ...options, spine: 'legacy' });
    // V().values('name').groupCount() → GROUP BY the value → Map{value: count}.
    const g = read("g.V().out('created').values('name').groupCount()");
    // A stored-property key carries its per-row type in a sibling column (gkt), so a
    // datetime/uuid key frames exactly instead of collapsing to its storage class.
    expect(g.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: true, type: PER_ROW('gkt') }, val: { kind: 'count' } });
    expect(g.sql).toContain('SUM(c.bulk) AS gv');
    expect(g.sql).toContain('GROUP BY');
    // a typed scalar (asNumber(X)) carries its tag so the key frames correctly (not inferred)
    expect(read('g.inject(15).asNumber(GType.BYTE).groupCount()').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: true, type: STATIC('byte') }, val: { kind: 'count' } });
    // null keys are counted (groupCount is productive)
    expect(read('g.inject(10,20,null,20).groupCount()').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: true, type: UNKNOWN }, val: { kind: 'count' } });
    // A NAMED side-effect groupCount('a') over a scalar defers on legacy (it needs side-effect state);
    // on RelIR the labelled form is the same grouping REGISTERED, so it routes at this host too — one
    // rule, two hosts.
    expect(() => compile("g.V().values('name').groupCount('a').cap('a')", {}, { spine: 'legacy' })).toThrow();
  });

  test('count values decode as Number (Int64), including inside a nested groupCount map', async () => {
    // count()/groupCount() are Java Longs → Int64, which the client decodes to a Number (a
    // bigint would arrive as BigInt — the fidelity bug). Assert the decoded JS TYPE at every
    // depth: a top-level groupCount value AND a groupCount nested as a group's by()-value.
    const store = seededStore();
    const dec = async (q: string) =>
    (await decodeAll(executeQuery(store, q, {})));
    const top = (await dec('g.V().groupCount().by(T.label)'))[0] as Map<string, unknown>;
    expect(typeof top.get('person')).toBe('number');
    expect(top.get('person')).toBe(4);
    // nested: group().by('name').by(out().groupCount().by(T.label)) → Map{name: Map{label: count}}.
    const nested = (await dec("g.V().hasLabel('person').group().by('name').by(__.out().groupCount().by(T.label))"))[0] as Map<string, Map<string, unknown>>;
    expect(typeof nested.get('marko')!.get('person')).toBe('number');
    expect(nested.get('marko')!.get('person')).toBe(2);
    expect(nested.get('josh')!.get('software')).toBe(2);
  });

  test('P3 Stage C2: count()/is(typeOf(MAP)) re-enter a group value', () => {
    // A BARRIER EMITS ONE TRAVERSER, so a global `count()` after `group()` is 1 and only
    // `count(Scope.local)` is the map's SIZE (`GroupStep extends ReducingBarrierStep<S, Map<K,V>>`,
    // gremlin-core `step/map/GroupStep.java:51`). Legacy answers the LOCAL reading under the GLOBAL
    // name — `COUNT(DISTINCT gk)` — which makes the two spellings indistinguishable and contradicts
    // its own `fold().count()`; RelIR counts the map traversers. `sql-hygiene`'s `RELIR_AHEAD` row
    // carries the witness. The assertion is per-spine because the two answers are both PINNED here,
    // not because either is unsettled.
    const c = read('g.V().group().by(T.label).count()');
    expect(c.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(c.sql).toContain(relirOff ? 'COUNT(DISTINCT' : 'count(*)');
    expect(run(seededStore(), 'g.V().group().by(T.label).count()')).toEqual([{ v: relirOff ? 2 : 1 }]);
    // count(Scope.local) on a Map = its size, same value
    expect(read('g.V().group().by(T.label).count(Scope.local)').shape).toEqual({ kind: 'value', type: STATIC('long') });
    // is(typeOf(MAP)) is IDENTITY — a group IS a Map — and the two spines say so through their own
    // whole-map shape (legacy's `group`, RelIR's `mapValue`), framing the same bytes.
    expect(read('g.V().groupCount().by(T.label).is(typeOf(GType.MAP))').shape.kind).toBe(relirOff ? 'group' : 'mapValue');
    // A NON-MATCHING typeOf is the EMPTY RESULT, not an error: `Set.feature:38-43` pins
    // `g.V().values("age").is(P.typeOf(GType.SET))` as "the result should be empty". Legacy refuses
    // the traversal instead, which is a decline RelIR no longer needs.
    if (relirOff) expect(() => compile('g.V().groupCount().by(T.label).is(typeOf(GType.LIST))', {})).toThrow('only is(typeOf(GType.MAP))');
    else expect(run(seededStore(), 'g.V().groupCount().by(T.label).is(typeOf(GType.LIST))')).toEqual([]);
    // A BARE `group()` KEYS BY THE ELEMENT ITSELF, which RelIR now expresses — the key is the ROWID in
    // the `GROUP BY` and `elementNode` builds the entry off it, once per surviving group. Legacy has no
    // element-key group at all and refuses. So `count()` after one is 1 on RelIR (the barrier's single
    // map traverser) and a refusal on legacy.
    if (relirOff) expect(() => compile('g.V().group().count()', {})).toThrow('non-scalar-key group');
    else expect(run(seededStore(), 'g.V().group().count()')).toEqual([{ v: 1 }]);
  });

  test('P3 Stage C3: group().unfold() → per-entry Map.Entry stream', () => {
    // unfold a groupCount map → Map.Entry rows; select(Column.keys) projects THIS entry's
    // key per row (scalar), not the whole-map aggregate. Trailing unfold() is scalar-identity.
    const keys = read("g.V().outE().values('weight').groupCount().unfold().select(Column.keys).unfold()");
    expect(keys.shape.kind).toBe('value');
    // select(Column.values) → the entry's value framed by its own stored type (typed {t,v} node)
    expect(read("g.V().outE().values('weight').groupCount().unfold().select(Column.values).unfold()").shape)
      .toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // element-valued group entries now re-enter via the list-of-element-rid substrate:
    // each entry's value is a list of the out() vertices (json_group_array of v_rid).
    const ev = read("g.V().group().by('name').by(__.out().fold()).unfold().select(Column.values)");
    expect(ev.sql).toContain('json_group_array');
  });

  test('Commit B: a bare terminal Map.Entry stream materializes (size-1 MAP per entry)', () => {
    // group()/groupCount().unfold() with NO following select is a terminal value: the group
    // becomes a whole-map blob (MapStream), unfold() explodes it to a per-entry MapEntryStream,
    // and each entry row frames as a size-1 GraphBinary MAP. Scalar sides are typed {t,v} nodes.
    expect(read('g.V().groupCount().by(T.label).unfold()').shape)
      .toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } });
    // scalar key + scalar-reducer value
    expect(read('g.V().group().by(T.label).by(__.count()).unfold()').shape.kind).toBe('mapEntry');
    // scalar key + a COLLECTED value, and the two spines DECLARE it differently while framing the
    // same bytes: legacy names the value side a list of scalars, RelIR names it one self-describing
    // scalar node — a wrapped property `by()` collects `{t,v}` nodes into a single `{t:'list',v:[…]}`
    // node, so the value side genuinely is one node there. Both frame `{person:[…], software:[…]}`.
    const sl = read("g.V().group().by(T.label).by('name').unfold()");
    expect(sl.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' },
      valOf: relirOff ? { kind: 'list', of: SCALAR_MEMBERS } : { kind: 'scalar' } });
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
    // unfold()` yields `d[5].i`, which it could not if the value side were `[5]`. Legacy wraps it.
    expect(await dec("g.E().hasLabel('knows').valueMap()"))
      .toEqual(relirOff
        ? [new Map([['weight', [0.5]]]), new Map([['weight', [1]]])]
        : [new Map([['weight', 0.5]]), new Map([['weight', 1]])]);
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
    // The map's SIZE. Legacy has no map-local reducer at all ("count(Scope.local) requires a
    // preceding list-producing step"), so this is RelIR ahead rather than a shared claim.
    if (relirOff) expect(() => executeQuery(store, "g.V().hasLabel('software').valueMap().count(Scope.local)")).toThrow();
    else expect(await dec("g.V().hasLabel('software').valueMap().count(Scope.local)")).toEqual([2, 2]);
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
    // (`elementMap("name").as("a")…select("a").select("name")` → `marko`). Legacy answers EMPTY for a
    // key that IS in the map, so this is RelIR ahead and the assertion is per-spine.
    expect(await dec("g.V().has('name','lop').valueMap().select('name')")).toEqual(relirOff ? [] : [['lop']]);
    // `containsKey`, not "the value is not null": an ABSENT key drops the traverser (`SelectOneStep`'s
    // `ifProductive` emits nothing), so the two software vertices are gone rather than null.
    expect(await dec("g.V().valueMap().select('age')")).toEqual(relirOff ? [] : [[29], [27], [32], [35]]);
    // A key in NEITHER the map nor the labels is the empty result on both spines.
    expect(await dec("g.V().valueMap().select('nope')")).toEqual([]);
    // A groupCount map is a scope too — the key is a grouping VALUE, not a property name. Legacy
    // refuses this one outright rather than answering empty, which is the same gap wearing its other
    // face ("select() on a map value requires Column.keys or Column.values").
    if (relirOff) expect(() => executeQuery(store, "g.V().groupCount().by('name').select('marko')")).toThrow();
    else expect(await dec("g.V().groupCount().by('name').select('marko')")).toEqual([1]);
  });

  test('the MAP LOOP: a map traverser answers its sides, its size and its entries', async () => {
    const store = seededStore();
    const dec = async (q: string) => decodeAll(executeQuery(store, q));

    // `select(Column.keys)` over a MAP is a `LinkedHashSet` and `select(Column.values)` an
    // `ArrayList` (gremlin-core `structure/Column.java:22-47`), so the key side frames as a
    // GraphBinary SET. `Set.feature:47-56` pins that reading — `g.V().valueMap().select(keys)`
    // yields `s[name,age]`. Legacy frames a LIST for both; RelIR carries the set marker through the
    // list vocabulary, which is what makes this a per-spine assertion rather than a shared one.
    const keys = read("g.V().groupCount().by('name').select(Column.keys)");
    expect(keys.shape).toEqual(relirOff
      ? { kind: 'jsonbList', items: TYPED_MEMBERS }
      : { kind: 'jsonbSet', items: TYPED_MEMBERS });
    expect(read("g.V().groupCount().by('name').select(Column.values)").shape.kind).toBe('jsonbList');
    expect(await dec("g.V().groupCount().by('name').select(Column.values)"))
      .toEqual([[1, 1, 1, 1, 1, 1]]);

    // `count(Scope.local)` is the map's SIZE — `json_array_length` over the pairs array, no explode.
    expect(await dec("g.V().groupCount().by('name').count(Scope.local)")).toEqual([6]);
    // RelIR reads the SIZE off the pairs array; legacy re-counts the grouped rows.
    expect(read("g.V().groupCount().by('name').count(Scope.local)").sql)
      .toContain(relirOff ? 'COUNT(DISTINCT' : 'json_array_length');

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
    // `count()` is 1 (legacy answers the LOCAL reading — see the `RELIR_AHEAD` row in `sql-hygiene`),
    // and a slice takes the map or nothing.
    expect(await dec("g.V().groupCount().by('name').count()")).toEqual([relirOff ? 6 : 1]);
    if (!relirOff) expect(await dec("g.V().groupCount().by('name').limit(0)")).toEqual([]);
  });

  test('a terminal groupCount() is a MAP VALUE on RelIR and a GroupStream on legacy; Column selection derives MapStream', () => {
    // TWO ROUTES, both correct, and the difference is where the map is BUILT. RelIR emits one `map`
    // column holding the `[[keyNode, valNode], …]` tree and the map framer reads it (§10·9 — a shape is
    // a value plus a framing arm); legacy emits `(gk, gv)` ROWS and the wire handler folds the runs.
    // The framed Map is the same either way, verified byte-for-byte.
    // BOTH routes named EXPLICITLY, never the ambient default: `options.spine` wins over the env, so
    // this holds in both positions of `mise run test:legacy-spine`. Reading the default here made the
    // assertion say "whatever this run is configured for", which the differential immediately failed.
    expect(read('g.V().groupCount().by("name")', { spine: 'rel' }).shape).toEqual({ kind: 'mapValue' });
    // Legacy's own lowering stays pinned — it still answers everything RelIR declines, and it must keep
    // working until §8 deletes it.
    expect(read('g.V().groupCount().by("name")', { spine: 'legacy' }).shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'count' } });
    // A Column consumer derives MapStream; select(Column.values) aggregates the
    // value column into a list value (one row), unfold() explodes it. Count → Long tag.
    const gv = read('g.V().groupCount().by("name").select(Column.values)');
    // the value list holds self-describing {t,v} nodes (each count typed), so it frames typed.
    expect(gv.shape).toEqual({ kind: 'jsonbList', items: TYPED_MEMBERS });
    expect(gv.sql).toContain('json_group_array');
    expect(read('g.V().groupCount().by("name").select(Column.values).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // select(Column.keys) over a scalar key → a typed scalar stream on unfold.
    expect(read('g.V().groupCount().by("name").select(Column.keys).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // Element keys (bare groupCount()) carry their rowid → unfold rejoins vertices. RelIR DECLINES the
    // side reads over an element-keyed map rather than answering them: its blob holds a
    // `{t:'vertex', v:{…}}` node, which frames correctly as a map entry and would decode into the
    // SCALAR vocabulary as a JSON string — a wrong answer where a deferral is available, which is what
    // the `elem` tag on `MapOf` now prevents. So this stays legacy's, and it is pinned there.
    expect(bare_read('g.V().groupCount().select(Column.keys).unfold()', { spine: 'legacy' }).shape).toEqual({ kind: 'vertex' });
    // group().by(k).by(__.count()) → same scalar-valued map path (typed count node → per-row type).
    expect(read('g.V().group().by("name").by(__.count()).select(Column.values).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    const childKey = read('g.V().groupCount().by(__.out().count())', { spine: 'legacy' });
    expect(childKey.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'count' } });
    expect(childKey.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(childKey.sql).toContain('JOIN c');
    expect(childKey.sql).toContain('ON gk.o0=gp.o0');
    // The RelIR route answers a reducing child KEY now — per traverser, which is what a key by() IS.
    // (A reducing child VALUE still declines: it reduces over the whole GROUP, so the per-parent
    // expression would be a plausible wrong value — see `groupBarrier`.) The child is a correlated
    // scalar subquery there rather than a joined child relation, so there are no `o0` ordinals at all.
    if (!relirOff) {
      const rel = read('g.V().groupCount().by(__.out().count())', { spine: 'rel' });
      expect(rel.shape).toEqual({ kind: 'mapValue' });
      expect(rel.sql).not.toContain('o0');
      expect(read('g.V().group().by("name").by(__.out().count())', { spine: 'rel' }).spine).toBe('legacy');
    }
  });

  test('list-VALUED map: group().by().by(__.out()...fold()).select(Column.values)', () => {
    // A neighbour-list value → a list-valued map; select(Column.values) yields a
    // list-of-lists, unfold() explodes to per-list rows, order(Scope.local) sorts each.
    const g = read('g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local)');
    expect(g.shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
    // The neighbour-list is folded from generic child rows at the group boundary.
    expect(g.sql).toContain('json_group_array');
    expect(g.sql).toContain('ON gf.o0=gp.o0');
    expect(g.sql).not.toContain('MAX((SELECT jsonb(COALESCE(json_group_array');
    // A pre-fold op folds into the correlated subquery (dedup/limit/tail).
    expect(read('g.V().group().by().by(__.out().label().dedup().fold()).select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
    // A scalar key now works too: the fold owns the complete final key domain, so
    // there is no per-parent list for MAX() to pick arbitrarily.
    // Terminal select(Column.values) is a list-of-lists; the shape carries its nested
    // `of` so each inner list frames by its own descriptor (here scalar; an element leaf
    // expands its rowids — see materialize.nestedListResult).
    const scalarKey = read('g.V().group().by("name").by(__.out().label().fold()).select(Column.values)');
    expect(scalarKey.shape).toEqual({ kind: 'jsonbList', items: { kind: 'list', of: SCALAR_MEMBERS } });
    expect(scalarKey.sql).toContain('GROUP BY gk');
  });

  test('terminal select(Column.values) over an element-list group frames full elements, not rowids', async () => {
    const store = seededStore();
    const dec = (b: Buffer) => decode(b);
    for (const [q, ctor] of [
      ['g.V().group().by(T.label).by(__.out().fold()).select(Column.values)', 'Vertex'],
      ['g.V().group().by(T.label).by(__.outE().fold()).select(Column.values)', 'Edge'],
    ] as const) {
      // Terminal form: ONE buffer = the outer List of inner element lists (a list-of-lists).
      const outer = await dec(executeQuery(store, q, {})[0]) as any[][];
      const flat = outer.flat();
      // The leaked-rowid bug produced bare JS numbers here; assert real elements instead.
      expect(flat.length).toBeGreaterThan(0);
      for (const item of flat) {
        expect(item?.constructor?.name).toBe(ctor);
        expect(typeof item.id).toBe('number'); // an external id, on a real element — not a bare rowid scalar
      }
      // Equivalence with the always-correct .unfold() twin: appending .unfold() explodes
      // the SAME outer list into one buffer per inner list. Each inner list must be
      // identical (element by element, in order) to its position in the terminal result.
      const unfoldedInner = await decodeAll(executeQuery(store, `${q}.unfold()`, {})) as any[][];
      const idsOf = (lists: any[][]) => lists.map((l) => l.map((v) => v.id));
      expect(idsOf(unfoldedInner)).toEqual(idsOf(outer));
    }
  });

  test('element-value group: unreduced value traversal implicitly folds to a list', () => {
    const store = seededStore();
    const eq = (a: string, b: string) =>
      JSON.stringify(executeQuery(store, a, {}).map((x) => [...x])) === JSON.stringify(executeQuery(store, b, {}).map((x) => [...x]));
    // by(__.out()) ≡ by(__.out().fold()) — TinkerPop collects an unreduced group value.
    expect(read('g.V().group().by(T.label).by(__.out())').shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'elementList', elem: 'vertex' } });
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
    expect(c.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'nestedMap', innerVal: 'count' } });
    // two-level: json_group_object over a lvl1 GROUP BY (outer key, inner key); the inner
    // key is now sourced generically from the properties() child (any alias), not hand-rolled.
    expect(c.sql).toContain('json_group_object');
    expect(c.sql).toContain('GROUP BY gk, ik');
    expect(c.sql).toContain('vertex_properties');
    expect(executeQuery(store, "g.V().hasLabel('person').group().by('name').by(__.properties().groupCount().by(T.label))", {})).toHaveLength(1);
    // correctness: marko → {name:1, age:1} (both single-cardinality property keys)
    const marko = run(store, "g.V().hasLabel('person').group().by('name').by(__.properties().groupCount().by(T.label))")
      .find((r: any) => r.gk === 'marko');
    expect(JSON.parse(marko.gv)).toEqual({ name: 1, age: 1 });
    // edge movement + inner reducer: Map<label, Map<edgeLabel, sum(weight)>>
    const s = read("g.V().group().by(T.label).by(__.bothE().group().by(T.label).by(__.values('weight').sum()))");
    expect(s.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'nestedMap', innerVal: 'number' } });
    // the INNER reducer weights by the outer traverser's bulk carried through the child scope
    // (same substrate all the way down — ≡ unweighted while bulk is 1, so results are unchanged).
    expect(s.sql).toContain('* gng.bulk');
    expect(read("g.V().group().by('name').by(__.properties().groupCount().by(T.label))").sql).toContain('SUM(gp.bulk) AS iv');
    expect(() => executeQuery(store, "g.V().group().by(T.label).by(__.bothE().group().by(T.label).by(__.values('weight').sum()))", {})).not.toThrow();
    // NEW (generic seam unlock): the hand-rolled path only accepted a single BARE movement.
    // The generic child engine composes ANY movement/filter chain in the nested value.
    // (a) filtered movement: out().hasLabel('software').groupCount().by('name')
    const nuA = read("g.V().group().by(T.label).by(__.out().hasLabel('software').groupCount().by('name'))");
    expect(nuA.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'nestedMap', innerVal: 'count' } });
    const personA = run(store, "g.V().group().by(T.label).by(__.out().hasLabel('software').groupCount().by('name'))")
      .find((r: any) => r.gk === 'person');
    expect(JSON.parse(personA.gv)).toEqual({ lop: 3, ripple: 1 }); // marko/josh/peter→lop, josh→ripple
    // (b) multi-hop movement: out().out().groupCount().by(T.label)
    const personB = run(store, "g.V().group().by(T.label).by(__.out().out().groupCount().by(T.label))")
      .find((r: any) => r.gk === 'person');
    expect(JSON.parse(personB.gv)).toEqual({ software: 2 }); // marko→josh→{lop,ripple}
  });

  test('element-valued group re-enters via the list-of-element-rid substrate (Stage 2)', () => {
    const store = seededStore();
    // group().by(label).by(__.out()) → Map<label, [vertices]>. The value rows carry v_rid;
    // select(Column.values)/unfold collapse them into a list-of-element-rids per key that the
    // list substrate rejoins to real vertices.
    const ev = read("g.V().group().by(T.label).by(__.out()).select(Column.values)");
    expect(ev.sql).toContain('json_group_array');
    expect(ev.sql).toContain('v_rid');
    // whole-map values → one list-of-lists; flatten to all out() vertices = 6 modern edges.
    expect(run(store, "g.V().group().by(T.label).by(__.out()).select(Column.values).unfold().unfold().count()")
      .map((r: any) => Number(r.v))).toEqual([6]);
    // per-entry (unfold→entries): each person/software entry's value is its members' out() list;
    // fold form composes identically. 6 distinct names → 6 entries.
    expect(executeQuery(store, "g.V().group().by('name').by(__.out().fold()).unfold().select(Column.values)", {})).toHaveLength(6);
    // element KEY (bare by() → the vertex) + element-list VALUE re-enters too (k_rid + v_rid).
    expect(() => executeQuery(store, "g.V().group().by().by(__.out()).select(Column.values)", {})).not.toThrow();
  });

  test("cap('a') of a group side-effect retypes to a MapStream on a follower", () => {
    // A group('a')/groupCount('a') side-effect, re-emitted by cap('a'), is re-enterable
    // too: select(Column.values)/unfold compose exactly like an inline group().
    expect(read('g.V().groupCount("a").by("name").cap("a").select(Column.values).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(read('g.V().group("a").by().by(__.out().label().fold()).cap("a").select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
  });

  // LEGACY'S group-scoped reducer, pinned at that spine. RelIR builds the same SHAPE by the same
  // argument (the child rows pool and the reducer runs once per key) and spells it in its own
  // vocabulary — the `origin` CHANNEL where legacy carries an `o0` column, and the ordinary fold's
  // movements where legacy hand-builds the join. The RelIR-position assertions are below.
  test('group-scoped reducers aggregate generic child rows at the final group boundary', () => {
    const read = (query: string, options?: CompileOptions) => bare_read(query, { ...options, spine: 'legacy' });
    const p = read("g.V().hasLabel('software').group().by('name').by(__.bothE().values('weight').mean())");
    // Movement and values() become ordinary child relations retaining the parent
    // origin. The reducer runs once over every raw row in the final key (weighted by the
    // child rows' carried bulk — a bulk-weighted mean), never once per parent with a MAX()
    // papering over the intermediate result.
    expect(p.sql).toContain('JOIN c');
    expect(p.sql).toContain('ON gr.o0=gp.o0');
    expect(p.sql).toContain('SUM(CASE WHEN typeof(gr.v) in (\'integer\', \'real\') THEN gr.v END * gr.bulk) * 1.0 / SUM(');
    expect(p.sql).toContain("'real' AS gvt");
    expect(p.sql).not.toContain('MAX((SELECT AVG(');
    expect(read("g.V().group().by('name').by(__.bothE().values('weight').sum())").sql)
      .toContain('SUM(CASE WHEN typeof(gr.v)');
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
    if (relirOff) return;
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
    // Asserted as MEANING rather than spelling, because the RelIR spine now answers this and picks
    // its own aliases (`rpr3`/`rn` vs legacy's `vp`/`n`). Per test/CLAUDE.md a snapshot asserts
    // semantic equivalence, not byte-identity. The name used to say "expands props via json_each",
    // which was true before properties were normalized out of a JSONB blob into their own table.
    const p = read('g.V().properties()');
    expect(p.sql).toMatch(/INNER JOIN vertex_properties \w+ ON|JOIN vertex_properties \w+ ON/);
    expect(p.sql).toMatch(/\bnode\b\s*=/);
    expect(p.shape).toEqual({ kind: 'property' });

    // The key filter is an extra JOIN condition either way. What DIFFERS is where the keys live, and
    // the difference is the parameter budget: a key written in the traversal text is a parsed
    // LITERAL, i.e. a constant the compiler already holds, so RelIR inlines it as a typed SQL
    // literal and spends none of the DO's 100 parameters on it. A bind serves a user PARAMETER and
    // nothing else (root CLAUDE.md). The `properties` family's hygiene baseline records the result
    // directly: binds=0, bound=0.
    const named = read('g.V().properties("name","age")');
    expect(named.sql).toMatch(/\bkey\b IN \('name', ?'age'\)|\bkey\b IN \(\?,\?\)/);
    expect(named.binds.length).toBeLessThanOrEqual(2);
  });

  test('properties() follow-ons: key/value/count/element project the right column', () => {
    // Column MEANING, not the alias: the RelIR spine answers these now and names its own relations.
    // `key()` reads the property table's `key`, `value()` its `value` — whatever each side calls the
    // relation it reads them from.
    expect(read('g.V().properties().key()').sql).toMatch(/\.(key|pk) AS v/);
    expect(read('g.V().properties().value()').sql).toMatch(/\.(value|pv)\b|AS pv\b/);
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toMatch(/vertex_properties \w+ ON/);
  });

  test('PropertyStream projections re-enter scalar/element lowering', () => {
    // A property KEY is a string, always — so the RelIR spine states `STATIC('string')` where legacy
    // left it `UNKNOWN` and let the wire infer one from the JS value. Same bytes either way (the
    // inference reaches String too); the difference is that one is correct by construction and the
    // other by luck, and `UNKNOWN` is documented as "the JS client genuinely cannot say", which is not
    // the situation here.
    // BOTH SPINES ASSERTED, because they legitimately differ and only one of them is stated by
    // construction. Pinned rather than left ambient so the differential's OFF position checks the
    // legacy half instead of failing on the RelIR one.
    expect(read('g.V(1).properties().key().limit(1)', { spine: 'rel' }).shape)
      .toEqual({ kind: 'value', type: STATIC('string') });
    expect(read('g.V(1).properties().key().limit(1)', { spine: 'legacy' }).shape)
      .toEqual({ kind: 'value', type: UNKNOWN });
    expect(read('g.V(1).properties().element().values("name").count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    // element() retypes to an ordinary owner stream, including edge materialization.
    expect(read('g.E(7).properties().element().label()').shape).toEqual({ kind: 'value', type: STATIC('string') });
    expect(read('g.E(7).properties().element()').shape).toEqual({ kind: 'edge' });
    // Layout aliases survive the property payload and the owner retype.
    expect(read('g.V(1).as("a").properties().element().select("a")').shape).toEqual({ kind: 'vertex' });
  });

  test('PropertyStream dedup partitions physical identity or property value', () => {
    const bare = read('g.V().properties().dedup().count()');
    expect(bare.sql).toContain('ROW_NUMBER() OVER (PARTITION BY p.vpid');
    expect(bare.sql).toContain('WHERE r.rn=1');
    const byValue = read('g.V().properties().dedup().by(value).count()');
    expect(byValue.sql).toContain('ROW_NUMBER() OVER (PARTITION BY p.pv');
    const edge = read('g.E().properties().dedup().count()');
    expect(edge.sql).toContain('PARTITION BY p.pk, p.pv');
  });

  test('PropertyStream order mints typed encounter order for key/value/property ids', () => {
    const key = read('g.V().properties().order().by(T.key,desc).key()');
    expect(key.sql).toContain('ROW_NUMBER() OVER (ORDER BY p.pk DESC');
    expect(key.sql).toContain('AS encounter');
    const value = read('g.E().properties().order().by(T.value).value()');
    expect(value.sql).toContain('CASE WHEN p.pvtype IN');
    expect(value.sql).toContain('ORDER BY ((CASE WHEN p.pvtype IN');
    const natural = read('g.E().properties().order().value()');
    expect(natural.sql).toContain('ORDER BY p.pk ASC');
  });

  test('PropertyStream order by traversal uses a per-property scalar child and LEFT JOIN', () => {
    const ordered = read('g.V().properties("name").order().by(__.value())');
    expect(ordered.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(ordered.sql).toContain('LEFT JOIN');
    expect(ordered.sql).toContain('ORDER BY');
  });

  test('property aliases rehydrate PropertyStream or project typed fields', () => {
    const direct = read('g.E(11).properties("weight").as("a").select("a").value()');
    expect(direct.sql).toContain("json_object('vpid'");
    expect(direct.sql).toContain("json_extract(p.a0 -> '$[#-1]', ?)");
    const key = read('g.E(11).properties("weight").as("a").select("a").by(T.key)');
    expect(key.sql).toContain("json_extract(p.a0 -> '$[#-1]', ?)");
    const value = read('g.E(11).properties("weight").as("a").select("a").by(T.value)');
    expect(value.sql).toContain('AS vtype');
    expect(value.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('property alias Pop.all becomes a re-enterable property list', () => {
    const all = read('g.E(11).properties("weight").as("a").select(Pop.all,"a")');
    expect(all.sql).toContain("json_group_array(json(je.value -> '$.v')");
    expect(all.shape).toEqual({ kind: 'jsonbList', items: { kind: 'property', elem: 'edge' } });
  });

  test('group().by(key).by(__.tail()) → element-last, ORDER BY key (assembly path)', () => {
    const p = read('g.V().group().by("name").by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'elementLast', elem: 'vertex' } });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS gk");
    expect(p.sql).toContain('COALESCE(n.uid, n.id) AS v_id');
    expect(p.sql).toContain('ORDER BY gk'); // element value → no GROUP BY, ordered for run-folding
  });

  test('group().by(key) default value → element list; group by key reports an index key', () => {
    // PINNED PER SPINE: this chain is RelIR-routed now (§10·10), and the two express the same map two
    // ways. Legacy ASSEMBLES it — one row per (key, member), folded by the handler, so the shape carries
    // the key/value descriptors the fold needs. RelIR builds ONE self-describing tree per group, whose
    // members are `{t:'vertex', v:{…}}` nodes the framer walks by the rule it already has for a typed
    // list — so `mapValue` is the whole contract and there is nothing per-position to describe.
    expect(read('g.V().group().by("name")', { spine: 'legacy' }).shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'elementList', elem: 'vertex' } });
    expect(read('g.V().group().by("name")', { spine: 'rel' }).shape).toEqual({ kind: 'mapValue' });
    // That the two AGREE on the answer is the census's and L3's job, not this file's — an L2 assertion
    // over SQL text cannot see it.
  });

  test('group().by(key).by(prop) → scalar-list via json_group_array + GROUP BY', () => {
    const p = read('g.V().group().by("name").by("age")', { spine: 'legacy' });
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'scalarList' } });
    expect(p.sql).toContain("json_group_array((SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1)) AS gv");
    expect(p.sql).toContain('GROUP BY gk');
    // The RelIR route reaches the SAME answer with the null drop stated where it belongs: the member is
    // dropped by the aggregate's own `FILTER (WHERE …)`, so a key whose every value was unproductive keeps
    // its place with an EMPTY list. Legacy collects the SQL null and its framer strips it — same wire
    // result, but only because that Shape's framer knows to; the typed tree says it in the data.
    const r = read('g.V().group().by("name").by("age")', { spine: 'rel' });
    expect(r.shape).toEqual({ kind: 'mapValue' });
    expect(r.sql).toMatch(/json_group_array\(json\(\w+\.gt\) ORDER BY \w+\.go ASC\) FILTER \(WHERE \(\w+\.gt IS NOT NULL\)\)/);
  });

  test('group().by(child).by(child) assigns the last arriving traverser\'s scalar value', () => {
    const p = read('g.V().group().by(__.values("name").substring(0,1)).by(__.constant(1))', { spine: 'rel' });
    expect(p.shape).toEqual({ kind: 'mapValue' });
    expect(p.sql).toMatch(/json_extract\(json_group_array\(json\(\w+\.gt\) ORDER BY \w+\.go ASC\) FILTER \(WHERE \(\w+\.gt IS NOT NULL\)\), '\$\[#-1\]'\)/);
    expect(p.sql).not.toContain("json_object('t', 'list', 'v', json_group_array(json(");
  });

  test('non-reducing scalar group values lower through generic child productivity', () => {
    const p = read('g.V().group().by("name").by(__.out().values("name"))');
    // `list`, not `scalarList`: the members are child ROWS, ordered and marked, so the SQL
    // aggregate is authoritative — the wire layer no longer strips nulls in JS (which could
    // not tell an unproductive child from a productive NULL member). `scalarList` remains the
    // DIRECT by(key) projection, which has no child rows and does emit SQL NULLs.
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'list' } });
    expect(p.sql).toContain('ROW_NUMBER() OVER (ORDER BY p.encounter) AS o0');
    expect(p.sql).toContain('ON gv.o0=gp.o0');
    // The member list is EMISSION-ORDERED (per-origin encounter), not incidentally ordered by
    // whatever the join produced — the whole point of routing this through the fold aggregate.
    expect(p.sql).toMatch(/json_group_array\(gv\.v ORDER BY gp\.o0, gv\.encounter\)/);
    // ...but it keeps the INNER join: an unreduced value traversal that produces nothing
    // FILTERS the traverser (Group.feature g_V_hasXperson_name_withinXvadas_peterXX_group_by_
    // byXout_orderX drops the empty key), unlike a fold(), which always produces [].
    expect(p.sql).not.toContain('LEFT JOIN gv');
    const both = read('g.V().group().by(__.label()).by(__.values("name").substring(0,1))', { spine: 'legacy' });
    expect(both.sql).toContain('ON gk.o0=gp.o0');
    expect(both.sql).toContain('ON gv.o0=gp.o0');
    // The RelIR route answers this one now, and the by() CHILD is an EXPRESSION there rather than a
    // joined child relation: a flat value-and-transform body needs no correlation, so there are no `o0`
    // ordinals to join on at all. Its value is the last arriving traverser's first child result, and
    // the productivity rule the comment above states is a pre-aggregate domain filter rather than an
    // INNER JOIN.
    if (!relirOff) {
      const rel = read('g.V().group().by(__.label()).by(__.values("name").substring(0,1))', { spine: 'rel' });
      expect(rel.shape).toEqual({ kind: 'mapValue' });
      expect(rel.sql).not.toContain('o0');
      expect(rel.sql).toContain('substr(');
    }
  });

  // THE TWO SPINES CARRY A SACK DIFFERENTLY, and every assertion below says which one it means.
  // Legacy threads an `sk` column through a CTE per step and hand-rolls the re-projection; RelIR
  // mints an ordinary `sack` CHANNEL, so the whole run FUSES into one SELECT and there is no
  // intermediate relation to name. Both are live routes until Phase 4.
  test('sack(op).by(key) mutates a carried sk column; bare sack() reads it — legacy', () => {
    const legacy = { spine: 'legacy' } as const;
    const p = read('g.V().sack(assign).by("age").sack()', legacy);
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS sk");
    expect(p.sql).toContain('SELECT p.sk AS v, p.sk, p.bulk FROM'); // scalar CTE reads + carries the sack
    expect(read('g.withSack(1).V().sack().fold()', legacy).shape).toEqual({ kind: 'jsonbList', items: SCALAR_MEMBERS });
    // sum accumulator references the prior sk; div forces REAL division.
    expect(read('g.withSack(0.0d).V().sack(sum).by("age").sack()', legacy).sql).toContain('(p.sk + (SELECT value FROM vertex_properties WHERE node=n.id AND key=?');
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()', legacy).sql).toContain('(CAST(d.sk AS REAL) / f.v)');
    expect(read('g.withSack(0).V().sack(assign).by(__.outE().count()).sack()', legacy).sql)
      .toContain('ROW_NUMBER() OVER (PARTITION BY');
    // sack + a co-carried column (otherV's fromV): the mutate CTE re-projects sk in its
    // layoutCols SLOT, not appended last — so the sk/fv columns don't desync. Regression
    // for the pre-existing bug where sk silently got the fromV rowid.
    expect(read('g.withSack(0).V(1).outE().sack(assign).by(T.label).otherV().sack()', legacy).sql)
      .toContain('(SELECT name FROM labels WHERE id=n.label) AS sk'); // sk = the label, not the fv rowid
    // local(__.sack(op).by(...)) folds the sack inside a child scope: a mutate sack is an
    // element-preserving child step, so it lowers through the same engine per pushed parent.
    const localSack = read('g.withSack(0L).V().local(__.sack(sum).by("age")).sack()', legacy);
    expect(localSack.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(localSack.sql).toContain('ROW_NUMBER() OVER ()'); // the child-scope ordinal
    expect(localSack.sql).toContain('AS sk'); // the fold lands in the sk slot within the scope
  });

  test('a sack is an ordinary carried CHANNEL — RelIR', () => {
    const store = seededStore();
    const rel = { spine: 'rel' } as const;
    // THE WHOLE RUN FUSES. Legacy spends a CTE per sack step because each one re-projects the layout
    // by hand; here the seed, the fold and the read are three `Project`s over one relation, and the
    // block assembler puts them in one SELECT. So the assertion worth making is that the SEED is a
    // compile-time constant inlined into the fold, not that a named relation carries it.
    const p = read('g.withSack(0.0d).V().sack(sum).by("age").sack()', rel);
    expect(p.spine).toBe('rel');
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(p.sql).toContain('(0.0 + (SELECT');
    expect(p.binds).toEqual([]);
    // `div` forces REAL division — SQLite's `/` is integer division on integer operands, which is the
    // one operator whose obvious spelling answers a different question.
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()', rel).sql).toContain('CAST(2 AS REAL) / 4.0');
    // `assign` needs no prior value, so it MINTS the channel where no `withSack()` seeded one.
    expect(runWith(store, 'g.V().sack(assign).by("age").sack()', rel).map((r) => r.v)).toEqual([29, 27, 32, 35]);
    // The by() is the ordinary modulator seam, so a CHILD body works here the day it works anywhere —
    // legacy's `sackByValue` refuses a nested traversal outright.
    expect(runWith(store, 'g.withSack(0).V().sack(assign).by(__.outE().count()).sack()', rel).map((r) => r.v).sort())
      .toEqual([0, 0, 0, 1, 2, 3]);
    // A `by()` that yields nothing DROPS the traverser — the vocabulary's rule, not this host's.
    expect(runWith(store, 'g.V().sack(assign).by("age").sack()', rel)).toHaveLength(4);
  });

  test('side-effecting group(a)/groupCount(a) → registered spec re-emitted by cap(a)', () => {
    // ONE MAP EITHER WAY, through two Shape descriptors. Legacy re-runs its stashed grouping SPEC at
    // the `cap()` and frames the resulting ROWS as a `group` (a key column plus per-side descriptors);
    // RelIR registers the grouping's own relation as a named collection and frames the finished JSON
    // tree as a `mapValue` — the same encoding an UNKEYED `group()` already produced, which is the
    // point: a labelled grouping differs from an unlabelled one in what happens to the RESULT, not in
    // how the map is computed, so it needed no second builder.
    const g = read('g.V().group("a").by("name").cap("a")', { spine: 'legacy' });
    expect(g.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'elementList', elem: 'vertex' } });
    // groupCount('a') passes traversers through: out() runs between it and cap('a').
    const gc = read('g.V().groupCount("a").by("name").out().cap("a")', { spine: 'legacy' });
    expect(gc.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'count' } });

    for (const gremlin of ['g.V().group("a").by("name").cap("a")',
      'g.V().groupCount("a").by("name").out().cap("a")']) {
      const rel = read(gremlin, { spine: 'rel' });
      expect(rel.spine, gremlin).toBe('rel');
      expect(rel.shape, gremlin).toEqual({ kind: 'mapValue' });
    }
  });

  test('terminal group(a) with no cap passes the traversers through (side-effect discarded)', () => {
    // a side-effecting group() without a cap is a pass-through: the stream is the result.
    expect(read('g.V().group("a").by("name")').shape).toEqual({ kind: 'vertex' });
  });

  test('withSack() seeds the sk column at the source as a bound value — legacy', () => {
    const p = read('g.withSack(0.0d).V().outE().sack(sum).by("weight").inV().sack()', { spine: 'legacy' });
    expect(p.sql).toContain('? AS sk, 1 AS bulk FROM nodes'); // seeded at V()
    expect(p.binds[0]).toBe(0);
    expect(p.sql).toContain('p.sk, p.bulk FROM edges'); // carried through outE()/inV()
  });

  test('groupCount() → count value; GROUP BY (legacy lowering)', () => {
    // Pinned to the LEGACY spine deliberately: this asserts that lowering's SQL, and RelIR now answers
    // the same traversal with a map value instead. The equivalent RelIR assertions are in the
    // terminal-groupCount test above (shape) and the map-shape L4 feature (answer).
    const p = read('g.V().groupCount().by("name")', { spine: 'legacy' });
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar', productive: false, type: UNKNOWN }, val: { kind: 'count' } });
    // count is the traverser total per key — SUM(bulk) (≡ COUNT while bulk is 1, correct after a fan-out)
    expect(p.sql).toContain('SUM(p.bulk) AS gv');
    expect(p.sql).toContain('GROUP BY gk');
  });

  test('group().by(__.project) composite key with nested scalar by()s (edge gate)', () => {
    const p = read('g.E().group().by(__.project("o","l","i").by(__.outV().values("name")).by(__.label()).by(__.inV().values("name"))).by(__.tail())');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'map', parts: [{ key: 'o' }, { key: 'l' }, { key: 'i' }] }, val: { kind: 'elementLast', elem: 'edge' } });
    // Every project field is an independent generic child joined on one outer edge
    // ordinal; no composite-key field uses a correlated scalar mini-compiler.
    expect(p.sql).toContain('ROW_NUMBER() OVER (ORDER BY p.encounter) AS o0');
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
    expect(p.sql).toContain('p.pk AS pk, p.pv AS pv, p.pvtype AS pvtype, p.pmeta AS pmeta, p.bulk, ROW_NUMBER() OVER (ORDER BY p.encounter) AS o0');
    // element().values("name") → owner re-root + values, joined back as a composite key part.
    expect(p.sql).toContain('gkp0.v AS k0_v, gkp1.v AS k1_v, gkp2.v AS k2_v');
    expect(p.sql).toContain('SELECT p.pk AS v, p.bulk, p.o0, ROW_NUMBER() OVER (PARTITION BY p.o0'); // key() child, per-origin encounter (carried slot)
    expect(p.sql).toContain('gp.owner AS v_owner'); // the tail() value frames the property element from the domain
    // Result: each vertex property grouped by {owner name, key, value}, value = the property.
    const store = seededStore();
    // The GROUPING is what this pins. The member order inside each group follows the emission
    // order of the group's inputs, and `g.V().hasLabel('person').properties()` fixes none — so the
    // members compare as a multiset (an exact list here was pinning SQLite's scan order, which
    // `mise run test:perturbed` reports).
    const rows = run(store, "g.V().hasLabel('person').properties().group().by(__.key()).by(__.value().fold())")
      .map((r: any) => ({ gk: r.gk, gv: bagOf(JSON.parse(r.gv)) }));
    expect(bagOf(rows)).toEqual(bagOf([
      { gk: 'age', gv: bagOf([29, 27, 32, 35]) },
      { gk: 'name', gv: bagOf(['marko', 'vadas', 'josh', 'peter']) },
    ]));
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
 * Every shape here is one legacy REFUSES, which is the §6·1 state "RelIR is ahead" — so each asserts
 * the RelIR answer absolutely, against the reference's semantics, rather than comparing spines.
 */
describe('by(__.select(label)) — the alias arm', () => {
  const entries = (row: any): [any, any][] => JSON.parse(row.map);
  const node = (v: any): any => (v && typeof v === 'object' && 't' in v
    ? (v.t === 'vertex' || v.t === 'edge' ? v.v.props.name[0].v : v.t === 'list' ? v.v.map(node) : v.v)
    : v);
  /** What ROUTE answers this, counting a legacy THROW as legacy — a refusal is an answer about which
   *  spine owns the shape, and swallowing it into a compile error would hide the very asymmetry the
   *  §6·1 "RelIR is ahead" state exists to record. */
  const routeOf = (gremlin: string): string => {
    try {
      const plan = compile(gremlin, {}, { spine: 'rel' });
      return plan.kind === 'read' ? plan.spine : 'legacy';
    } catch { return 'legacy'; }
  };

  test('an ELEMENT label is a first-class group KEY — the shape the map module said it was blocked on', () => {
    const store = seededStore();
    const grouped = runWith(store, 'g.V().as("a").out().group().by(__.select("a"))', { spine: 'rel' });
    // ONE map value, keyed by the labelled VERTEX itself: the key rides as a `{t:'vertex', v:{…}}`
    // member of the self-describing tree, which `frameTypedNode` already walks at any depth. Nothing
    // in the wire vocabulary needed adding — that was the whole claim, and `mapPayload`'s own comment
    // named an element key as the thing it declined.
    expect(grouped).toHaveLength(1);
    expect(entries(grouped[0]).map(([k, v]) => [node(k), node(v)])).toEqual([
      ['marko', ['vadas', 'lop', 'josh']],
      ['josh', ['lop', 'ripple']],
      ['peter', ['lop']],
    ]);
    // Legacy refuses the whole form, so this is `relirAhead` rather than a differential.
    expect(routeOf('g.V().as("a").out().group().by(__.select("a"))')).toBe('rel');
    expect(() => runWith(store, 'g.V().as("a").out().group().by(__.select("a"))', { spine: 'legacy' }))
      .toThrow(/group\(\)\.by\(traversal\) key not supported/);
  });

  test('a VALUE label is an ordering key over a stream that has no properties at all', () => {
    const store = seededStore();
    // A scalar stream's `by()` is identity-only — a value has no properties — so legacy refuses the
    // whole form. The alias channel is not a property, and the entry's own `t` field is what makes
    // the comparison numeric rather than lexical.
    expect(runWith(store, 'g.V().as("a").values("age").as("b").order().by(__.select("b"))', { spine: 'rel' })
      .map((r) => r.v)).toEqual([27, 29, 32, 35]);
    expect(() => runWith(store, 'g.V().as("a").values("age").as("b").order().by(__.select("b"))', { spine: 'legacy' }))
      .toThrow(/order\(\)\.by\(key\/traversal\) on a scalar stream/);
  });

  test('a RECORD field keeps the label as an ELEMENT, so it re-enters as a vertex stream', () => {
    const store = seededStore();
    // The record's payoff, stated as a property rather than as a spelling: the field holds the
    // ROWID, so `select()` on it re-roots to elements and the chain carries on. A blob could not —
    // by then the element is an expanded payload with no id to move from.
    expect(new Set(runWith(store, 'g.V().as("v").out().project("vertex","n").by(__.select("v")).by("name").select("vertex").values("name")', { spine: 'rel' })
      .map((r) => r.v))).toEqual(new Set(['marko', 'josh', 'peter']));
    const plan = read('g.V().as("v").out().project("vertex","n").by(__.select("v")).by("name")', { spine: 'rel' });
    expect(plan.spine).toBe('rel');
    expect(plan.shape).toEqual({ kind: 'mapValue' });
  });

  test('an unreadable label DECLINES rather than answering a different question', () => {
    // A label this relation does not carry, a `Pop.all` LIST result and a multi-label `select` in a
    // by() slot are all shapes the arm cannot express. Each must route away, never guess.
    for (const gremlin of [
      'g.V().out().project("x").by(__.select("nope"))',
      'g.V().as("a").out().as("a").project("x").by(__.select(Pop.all, "a"))',
      'g.V().as("a").as("b").out().project("x").by(__.select("a","b"))',
    ]) expect(routeOf(gremlin), gremlin).toBe('legacy');
  });
});
