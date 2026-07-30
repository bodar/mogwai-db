// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, STATIC, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { executeQuery } from '../support/executor.ts';
import { decode, decodeAll } from '../support/decode.ts';
import { read, run, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('group / properties SQL', () => {
  test('valueMap variants set shape, reuse the vertex row source', () => {
    expect(read('g.V().valueMap()').shape).toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: false });
    expect(read('g.V().valueMap(true)').shape).toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    expect(read('g.V().valueMap("name","age")').shape).toEqual({ kind: 'valueMap', labelSet: false, keys: ['name', 'age'], tokens: false });
    expect(read('g.V().elementMap()').shape).toEqual({ kind: 'elementMap', labelSet: false, keys: null });
  });

  test('valueMap().with(WithOptions.tokens) desugars to valueMap(true) (item 13)', () => {
    // The JS GLV resolves WithOptions.tokens/.all to the wire strings/ints '~tinkerpop.valueMap.
    // tokens'/15 before sending, so the real conformance query is with('~…tokens'). The tokens
    // option with no selector (or + all) IS valueMap(true): the fold Pass sets the tokens flag,
    // so the shape matches its valueMap(true) equivalent exactly. Both wire and enum forms fold.
    expect(read('g.V().valueMap().with("~tinkerpop.valueMap.tokens")').shape)
      .toEqual(read('g.V().valueMap(true)').shape);
    expect(read('g.V().valueMap("name","age").with("~tinkerpop.valueMap.tokens")').shape)
      .toEqual(read('g.V().valueMap(true,"name","age")').shape);
    expect(read('g.V().valueMap().with("~tinkerpop.valueMap.tokens", 15)').shape)
      .toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    expect(read('g.V().valueMap().with(WithOptions.tokens)').shape) // enum form (typed at our server)
      .toEqual({ kind: 'valueMap', labelSet: false, keys: null, tokens: true });
    // A SELECTIVE token subset (labels=2) has no valueMap(true) equivalent yet → fail closed,
    // never silently widened to all-tokens.
    expect(() => read('g.V().valueMap("name","age").with("~tinkerpop.valueMap.tokens", 2).by(__.unfold())'))
      .toThrow('with() cannot consume the valueMap result shape');
  });

  test('P3 Stage B: valueMap() re-enterable — select(Column), count, is(typeOf(MAP))', () => {
    // valueMap() → a per-element whole-map blob MapStream (one `map` blob per element, folding
    // {k:[v]} into [[{t,v},valueList],…]); select(Column.keys) aggregates one key-list per map.
    const keys = read('g.V().valueMap().select(Column.keys)');
    expect(keys.sql).toContain('json_each');
    expect(keys.sql).toContain('json_group_array(json_array('); // per-element blob assembly
    // the keys list holds typed {t,v} string nodes (uniform typed map encoding)
    expect(keys.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
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
    expect(() => compile('g.V().valueMap(true).select(Column.keys)', {})).toThrow('valueMap(true)/token re-entry not yet supported');
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
    expect(keysUnfold.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'list', of: { kind: 'scalar' } } });
    const desc = read('g.V().values("age").groupCount().order(Scope.local).by(Column.values, Order.desc)');
    expect(desc.sql).toContain('DESC');
    // Fail closed: an element/list-valued map side has no total order → clear deferral.
    expect(() => compile('g.V().groupCount().order(Scope.local).by(Column.keys)', {}))
      .toThrow('order(Scope.local).by(Column.keys) over an element/list map key not yet supported');
    // shuffle-local and multi-term/by(key) orders are not Column-local orders → defer elsewhere.
  });

  test('Commit A: valueMap().unfold() → per-element Map.Entry stream', () => {
    // valueMap().unfold(): valueMap retypes to a per-element whole-map blob MapStream, unfold()
    // explodes it to a per-entry MapEntryStream (key = typed {t,v} scalar, value = its list).
    const t = read('g.V().valueMap().unfold()');
    expect(t.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'list', of: { kind: 'scalar' } } });
    expect(t.sql).toContain('json_each'); // explode the map blob into entry rows
    // select(keys) per entry → the key, framed by its own stored type (a typed {t,v} node).
    expect(read('g.V().valueMap().unfold().select(keys)').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // select(values) per entry → the value (a valueMap value is a list) → a list value.
    expect(read('g.V().valueMap().unfold().select(values)').shape.kind).toBe('jsonbList');
    // map(__.select(keys)) is the 1-to-1 form — unwrapped to the same per-entry key select
    expect(read('g.V().valueMap().unfold().map(__.select(keys))').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // elementMap().unfold() fails CLOSED (token entries + single values deferred)
    expect(() => compile('g.V().elementMap().unfold()', {})).toThrow('elementMap() re-entry not yet supported');
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
    expect(read("g.V().values('m').is(typeOf(GType.MAP)).select(values)").shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    expect(read("g.V().values('m').is(typeOf(GType.MAP)).unfold()").shape.kind).toBe('mapEntry');
    // richer followers fail CLOSED (correct-by-design deferral, not mis-execution)
    expect(() => compile("g.V().values('m').is(typeOf(GType.MAP)).where(count(Scope.local).is(P.gt(1)))", {})).toThrow('where() on a map value not yet supported');
    expect(() => compile("g.V().values('m').is(typeOf(GType.MAP)).fold()", {})).toThrow('fold() on a map value not yet supported');
    // a stored scalar of another type (age=int) retypes+filters to EMPTY (WHERE vtype='map'
    // matches no row) — exactly like is(typeOf(LIST)) on a non-list; a correct empty result.
    expect(read("g.V().values('age').is(typeOf(GType.MAP))").shape.kind).toBe('mapValue');
  });

  test('P3 Stage C: bare groupCount() over a scalar stream groups by value', () => {
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
    // named side-effect groupCount('a') over a scalar defers (needs side-effect state)
    expect(() => compile("g.V().values('name').groupCount('a').cap('a')", {})).toThrow();
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
    // count() over a group = number of entries (distinct keys) → COUNT(DISTINCT gk)
    const c = read('g.V().group().by(T.label).count()');
    expect(c.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(c.sql).toContain('COUNT(DISTINCT');
    // count(Scope.local) on a Map = its size, same value
    expect(read('g.V().group().by(T.label).count(Scope.local)').shape).toEqual({ kind: 'value', type: STATIC('long') });
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
    // scalar key + scalar-LIST value (by('name') → the value side is a list)
    const sl = read("g.V().group().by(T.label).by('name').unfold()");
    expect(sl.shape).toEqual({ kind: 'mapEntry', keyOf: { kind: 'scalar' }, valOf: { kind: 'list', of: { kind: 'scalar' } } });
    // an ELEMENT-list value: the value column expands its rowids to full element payloads
    // at the root (json_object over nodes), like the list substrate.
    const ev = read("g.V().hasLabel('software').group().by('name').unfold()");
    expect(ev.shape.kind).toBe('mapEntry');
    expect(ev.sql).toContain('json_object');
    // the group is assembled as ONE whole-map blob before unfold explodes it
    expect(read('g.V().groupCount().by(T.label).unfold()').sql).toContain('json_group_array');
  });

  test('group()/groupCount() always lowers to GroupStream; Column selection derives MapStream', () => {
    // A terminal GroupStream reaches the existing row-folding groupBuffer Map.
    expect(read('g.V().groupCount().by("name")').shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    // A Column consumer derives MapStream; select(Column.values) aggregates the
    // value column into a list value (one row), unfold() explodes it. Count → Long tag.
    const gv = read('g.V().groupCount().by("name").select(Column.values)');
    // the value list holds self-describing {t,v} nodes (each count typed), so it frames typed.
    expect(gv.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar', typed: true } });
    expect(gv.sql).toContain('json_group_array');
    expect(read('g.V().groupCount().by("name").select(Column.values).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // select(Column.keys) over a scalar key → a typed scalar stream on unfold.
    expect(read('g.V().groupCount().by("name").select(Column.keys).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // Element keys (bare groupCount()) carry their rowid → unfold rejoins vertices.
    expect(read('g.V().groupCount().select(Column.keys).unfold()').shape).toEqual({ kind: 'vertex' });
    // group().by(k).by(__.count()) → same scalar-valued map path (typed count node → per-row type).
    expect(read('g.V().group().by("name").by(__.count()).select(Column.values).unfold()').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
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
    expect(g.shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // The neighbour-list is folded from generic child rows at the group boundary.
    expect(g.sql).toContain('json_group_array');
    expect(g.sql).toContain('ON gf.o0=gp.o0');
    expect(g.sql).not.toContain('MAX((SELECT jsonb(COALESCE(json_group_array');
    // A pre-fold op folds into the correlated subquery (dedup/limit/tail).
    expect(read('g.V().group().by().by(__.out().label().dedup().fold()).select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // A scalar key now works too: the fold owns the complete final key domain, so
    // there is no per-parent list for MAX() to pick arbitrarily.
    // Terminal select(Column.values) is a list-of-lists; the shape carries its nested
    // `of` so each inner list frames by its own descriptor (here scalar; an element leaf
    // expands its rowids — see materialize.nestedListResult).
    const scalarKey = read('g.V().group().by("name").by(__.out().label().fold()).select(Column.values)');
    expect(scalarKey.shape).toEqual({ kind: 'jsonbList', items: { kind: 'list', of: { kind: 'scalar' } } });
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
    expect(read('g.V().group().by(T.label).by(__.out())').shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'elementList', elem: 'vertex' } });
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
    expect(c.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'nestedMap', innerVal: 'count' } });
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
    expect(s.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'nestedMap', innerVal: 'number' } });
    // the INNER reducer weights by the outer traverser's bulk carried through the child scope
    // (same substrate all the way down — ≡ unweighted while bulk is 1, so results are unchanged).
    expect(s.sql).toContain('* gng.bulk');
    expect(read("g.V().group().by('name').by(__.properties().groupCount().by(T.label))").sql).toContain('SUM(gp.bulk) AS iv');
    expect(() => executeQuery(store, "g.V().group().by(T.label).by(__.bothE().group().by(T.label).by(__.values('weight').sum()))", {})).not.toThrow();
    // NEW (generic seam unlock): the hand-rolled path only accepted a single BARE movement.
    // The generic child engine composes ANY movement/filter chain in the nested value.
    // (a) filtered movement: out().hasLabel('software').groupCount().by('name')
    const nuA = read("g.V().group().by(T.label).by(__.out().hasLabel('software').groupCount().by('name'))");
    expect(nuA.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'nestedMap', innerVal: 'count' } });
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
    expect(read('g.V().group("a").by().by(__.out().label().fold()).cap("a").select(Column.values).unfold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
  });

  test('group-scoped reducers aggregate generic child rows at the final group boundary', () => {
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
    expect(read('g.V().properties().count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(read('g.V().properties().element()').shape).toEqual({ kind: 'vertex' });
    expect(read('g.V().properties().element().values("name")').sql).toContain("JOIN vertex_properties vp ON vp.node=n.id AND vp.key=?");
  });

  test('PropertyStream projections re-enter scalar/element lowering', () => {
    expect(read('g.V(1).properties().key().limit(1)').shape).toEqual({ kind: 'value', type: UNKNOWN });
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
    // `list`, not `scalarList`: the members are child ROWS, ordered and marked, so the SQL
    // aggregate is authoritative — the wire layer no longer strips nulls in JS (which could
    // not tell an unproductive child from a productive NULL member). `scalarList` remains the
    // DIRECT by(key) projection, which has no child rows and does emit SQL NULLs.
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'list' } });
    expect(p.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(p.sql).toContain('ON gv.o0=gp.o0');
    // The member list is EMISSION-ORDERED (per-origin encounter), not incidentally ordered by
    // whatever the join produced — the whole point of routing this through the fold aggregate.
    expect(p.sql).toMatch(/json_group_array\(gv\.v ORDER BY gp\.o0, gv\.encounter\)/);
    // ...but it keeps the INNER join: an unreduced value traversal that produces nothing
    // FILTERS the traverser (Group.feature g_V_hasXperson_name_withinXvadas_peterXX_group_by_
    // byXout_orderX drops the empty key), unlike a fold(), which always produces [].
    expect(p.sql).not.toContain('LEFT JOIN gv');
    const both = read('g.V().group().by(__.label()).by(__.values("name").substring(0,1))');
    expect(both.sql).toContain('ON gk.o0=gp.o0');
    expect(both.sql).toContain('ON gv.o0=gp.o0');
  });

  test('sack(op).by(key) mutates a carried sk column; bare sack() reads it', () => {
    const p = read('g.V().sack(assign).by("age").sack()');
    expect(p.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=n.id AND key=? ORDER BY id LIMIT 1) AS sk");
    expect(p.sql).toContain('SELECT p.sk AS v, p.sk, p.bulk FROM'); // scalar CTE reads + carries the sack
    expect(read('g.withSack(1).V().sack().fold()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    // sum accumulator references the prior sk; div forces REAL division.
    expect(read('g.withSack(0.0d).V().sack(sum).by("age").sack()').sql).toContain('(p.sk + (SELECT value FROM vertex_properties WHERE node=n.id AND key=?');
    expect(read('g.withSack(2).V().sack(div).by(__.constant(4.0d)).sack()').sql).toContain('(CAST(d.sk AS REAL) / f.v)');
    expect(read('g.withSack(0).V().sack(assign).by(__.outE().count()).sack()').sql)
      .toContain('ROW_NUMBER() OVER (PARTITION BY');
    // sack + a co-carried column (otherV's fromV): the mutate CTE re-projects sk in its
    // layoutCols SLOT, not appended last — so the sk/fv columns don't desync. Regression
    // for the pre-existing bug where sk silently got the fromV rowid.
    expect(read('g.withSack(0).V(1).outE().sack(assign).by(T.label).otherV().sack()').sql)
      .toContain('(SELECT name FROM labels WHERE id=n.label) AS sk'); // sk = the label, not the fv rowid
    // local(__.sack(op).by(...)) folds the sack inside a child scope: a mutate sack is an
    // element-preserving child step, so it lowers through the same engine per pushed parent.
    const localSack = read('g.withSack(0L).V().local(__.sack(sum).by("age")).sack()');
    expect(localSack.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(localSack.sql).toContain('ROW_NUMBER() OVER ()'); // the child-scope ordinal
    expect(localSack.sql).toContain('AS sk'); // the fold lands in the sk slot within the scope
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
    expect(p.sql).toContain('? AS sk, 1 AS bulk FROM nodes'); // seeded at V()
    expect(p.binds[0]).toBe(0);
    expect(p.sql).toContain('p.sk, p.bulk FROM edges'); // carried through outE()/inV()
  });

  test('groupCount() → count value; GROUP BY', () => {
    const p = read('g.V().groupCount().by("name")');
    expect(p.shape).toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'count' } });
    // count is the traverser total per key — SUM(bulk) (≡ COUNT while bulk is 1, correct after a fan-out)
    expect(p.sql).toContain('SUM(p.bulk) AS gv');
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
    expect(p.sql).toContain('p.pk AS pk, p.pv AS pv, p.pvtype AS pvtype, p.pmeta AS pmeta, p.bulk, ROW_NUMBER() OVER () AS o0');
    // element().values("name") → owner re-root + values, joined back as a composite key part.
    expect(p.sql).toContain('gkp0.v AS k0_v, gkp1.v AS k1_v, gkp2.v AS k2_v');
    expect(p.sql).toContain('SELECT p.pk AS v, p.bulk, p.o0, ROW_NUMBER() OVER (PARTITION BY p.o0'); // key() child, per-origin encounter (carried slot)
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
});
