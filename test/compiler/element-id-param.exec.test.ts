// A wire PARAMETER as a `V()`/`E()` id or a `hasLabel()`/`out()` label must BIND, never inline —
// exactly the "parameters are the only binds" thesis the `within($list)` set already keeps
// (docs/archive/2026-08-05-parameters-are-the-only-binds.md). Before this, `elementScan`/`labelIds` read
// their arguments through `flattenListArgs(argValues(step))`, which strips the `Arg` object and with
// it the parameter NAME, so a bound id/label was inlined as a compound constant — a scalar as a
// literal and a bound COLLECTION as an inline `IN (…)` of its data. That baked a parameter's data into
// the statement text (defeating the cache and, for a data-sized set, risking the 100 KB text wall) and
// made the byte image of `V($xs)` identical to `V([1,2,3])`.
//
// Now: a parsed literal id/label still inlines (zero binds); a scalar parameter binds as one `?`; a
// bound COLLECTION crosses as ONE `jsonb(?)` bind exploded by `json_each` — for any size — routed per
// member by json_each's own type (a JSON number → the rowid column, a JSON string → `uid`), so a
// heterogeneous bound id list is faithful without our reading its data.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { seededStore } from '../support/harness.ts';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

const store = seededStore();
const kindOf = (g: string, p: Record<string, any> = {}) => compile(g, p).kind;
const plan = (g: string, p: Record<string, any> = {}) => compile(g, p) as any;
// This file's subject is the bind discipline — "a bind serves a user PARAMETER, nothing else earns
// one". The `vals` helper below executes the same lowering `plan` compiles, so the plan half and the
// answer half describe one compilation, not two.
const valsIn = async (s: ReturnType<typeof seededStore>, g: string, p: Record<string, any> = {}) => {
  const out: string[] = [];
  for (const b of exec(s).buffers(g, p, {})) out.push(String(await decode(b)));
  return out.sort();
};
const vals = (g: string, p: Record<string, any> = {}) => valsIn(store, g, p);

describe('V()/E() id PARAMETER → bind, never inline', () => {
  test('V($xs) collection is ONE jsonb(?) bind exploded by json_each, data NOT in the text', async () => {
    const g = "g.V(xs).values('name')";
    expect(kindOf(g, { xs: [1, 2] })).toBe('read');
    const p = plan(g, { xs: [1, 2] });
    expect(p.binds).toHaveLength(1);                        // the whole array, one jsonb bind
    expect(p.binds[0]).toBe(JSON.stringify([1, 2]));        // JSON text, not spread values
    expect(p.sql).toContain('json_each(jsonb(?');           // exploded in-query
    expect(p.sql).not.toContain('IN (1, 2)');               // no data in the statement text
    expect(await vals(g, { xs: [1, 2] })).toEqual(['marko', 'vadas']);
  });

  test('a bound id collection answers the same as the literal form', async () => {
    expect(await vals("g.V(xs).values('name')", { xs: [1, 2] }))
      .toEqual(await vals("g.V([1,2]).values('name')"));
  });

  test('V($x) scalar id binds as a single ?', async () => {
    const g = "g.V(x).values('name')";
    const p = plan(g, { x: 1 });
    expect(p.binds).toEqual([1]);
    expect(p.sql).not.toContain('IN (1)');
    expect(await vals(g, { x: 1 })).toEqual(['marko']);
  });

  test('a string-uid collection routes to the uid column (one bind)', async () => {
    const s = seeded([
      "g.addV('t').property(T.id,'foo').property('name','F')",
      "g.addV('t').property(T.id,'bar').property('name','B')",
      "g.addV('t').property(T.id,'baz').property('name','Z')",
    ]);
    const g = "g.V(xs).values('name')";
    expect(plan(g, { xs: ['foo', 'bar'] }).binds).toHaveLength(1);
    expect(await valsIn(s, g, { xs: ['foo', 'bar'] })).toEqual(['B', 'F']);
  });

  test('a MIXED bound id list routes per member by json type — numbers to rowid, strings to uid', async () => {
    const s = seeded([
      "g.addV('t').property(T.id,1).property('name','one')",
      "g.addV('t').property(T.id,'u2').property('name','two')",
      "g.addV('t').property(T.id,3).property('name','three')",
    ]);
    const g = "g.V(xs).values('name')";
    const p = plan(g, { xs: [1, 'u2'] });
    expect(p.binds).toHaveLength(1);                                     // one bind, whatever the mix
    expect(p.sql).toContain("IN ('integer', 'real')");                  // numeric members → rowid
    expect(p.sql).toContain("IN ('text')");                             // string members → uid
    expect(await valsIn(s, g, { xs: [1, 'u2'] })).toEqual(['one', 'two']);
  });

  test('E($xs) binds the same way', async () => {
    const g = "g.E(xs).count()";
    const p = plan(g, { xs: [7, 8] });
    expect(p.binds).toHaveLength(1);
    expect(p.sql).toContain('json_each(jsonb(?');
    expect(await vals(g, { xs: [7, 8] })).toEqual(['2']);
  });

  test('a repeated id parameter dedups to a single bind (?1 reused across both routing clauses)', () => {
    const p = plan("g.V(xs).count()", { xs: [1, 2, 3] });
    expect(p.binds).toHaveLength(1);
    expect(p.sql).toContain('?1');
  });

  test('a LITERAL V() is unchanged — inline IN-list, zero binds', () => {
    const p = plan("g.V(1,2,3).count()");
    expect(p.binds).toHaveLength(0);
    expect(p.sql).toContain('IN (1, 2, 3)');
  });
});

describe('label PARAMETER → bind, never inline', () => {
  test('hasLabel($l) scalar binds as one ? on the label name', async () => {
    const g = "g.V().hasLabel(l).count()";
    const p = plan(g, { l: 'person' });
    expect(p.binds).toEqual(['person']);
    expect(p.sql).not.toContain("IN ('person')");
    expect(await vals(g, { l: 'person' })).toEqual(['4']);
  });

  test('hasLabel($ls) collection is ONE jsonb(?) bind via json_each, data not in text', async () => {
    const g = "g.V().hasLabel(ls).count()";
    const p = plan(g, { ls: ['person', 'software'] });
    expect(p.binds).toHaveLength(1);
    expect(p.binds[0]).toBe(JSON.stringify(['person', 'software']));
    expect(p.sql).toContain('json_each(jsonb(?');
    expect(p.sql).not.toContain("'software'");
    expect(await vals(g, { ls: ['person', 'software'] })).toEqual(['6']);
  });

  test('a movement label parameter (out($l)) binds and answers as the literal', async () => {
    const g = "g.V(1).out(l).values('name')";
    const p = plan(g, { l: 'knows' });
    expect(p.binds).toContain('knows');
    expect(p.sql).toContain('rl');                                       // the labels-table join stays
    expect(await vals(g, { l: 'knows' })).toEqual(await vals("g.V(1).out('knows').values('name')"));
  });

  test('has($label, key, value) with a bound label binds the label', async () => {
    const g = "g.V().has(l, 'name', 'marko').count()";
    const p = plan(g, { l: 'person' });
    expect(p.binds).toContain('person');
    expect(await vals(g, { l: 'person' })).toEqual(['1']);
  });

  test('a LITERAL label is unchanged — inline, zero binds', () => {
    expect(plan("g.V().hasLabel('person').count()").binds).toHaveLength(0);
    expect(plan("g.V().out('knows').count()").binds).toHaveLength(0);
    expect(plan("g.V().hasLabel('person').count()").sql).toContain("IN ('person')");
  });
});

// `hasId`/`has(T.id, …)` ask the SAME id question `V(ids)` does, so they go through the same routing
// (`idMembership`, `src/compiler/rel/source.ts`) — parameters included: a scalar binds as one `?`, a
// bound collection as one `jsonb(?)`, numbers to the rowid (on a row with no `uid`), strings to `uid`.
describe('hasId / has(T.id) share the V() id routing, parameters included', () => {
  // rowid 1 carries the user id 'x' (so it does NOT answer to 1); rowid 2 is a plain vertex.
  const s = seeded(["g.addV('a').property(T.id,'x').property('name','X')", "g.addV('b').property('name','B')"]);

  test('hasId($xs) is ONE jsonb(?) bind and matches V($xs)', async () => {
    const g = "g.V().hasId(xs).values('name')";
    const p = plan(g, { xs: [1, 2, 'x'] });
    expect(p.binds).toHaveLength(1);
    expect(await valsIn(s, g, { xs: [1, 2, 'x'] })).toEqual(['B', 'X']);
    expect(await valsIn(s, g, { xs: [1, 2, 'x'] })).toEqual(await valsIn(s, "g.V(xs).values('name')", { xs: [1, 2, 'x'] }));
  });

  test('has(T.id, $x) binds the scalar; a number never names a uid vertex by its rowid', async () => {
    const p = plan("g.V().has(T.id, x).values('name')", { x: 1 });
    expect(p.binds).toEqual([1]);
    expect(await valsIn(s, "g.V().has(T.id, x).values('name')", { x: 1 })).toEqual([]);
    expect(await valsIn(s, "g.V().has(T.id, x).values('name')", { x: 2 })).toEqual(['B']);
    expect(await valsIn(s, "g.V().has(T.id, x).values('name')", { x: 'x' })).toEqual(['X']);
  });

  test('without($xs) is the exact complement, uid rows included', async () => {
    expect(await valsIn(s, "g.V().hasId(without(xs)).values('name')", { xs: [1] })).toEqual(['B', 'X']);
    expect(await valsIn(s, "g.V().hasId(without(xs)).values('name')", { xs: [2] })).toEqual(['X']);
    expect(await valsIn(s, "g.V().V().hasId(without(xs)).values('name')", { xs: ['x'] })).toEqual(['B', 'B']);
  });

  test('after a re-source the routing is an uncorrelated membership, same answer', async () => {
    expect(await valsIn(s, "g.V().V().hasId(xs).values('name')", { xs: [1, 2] })).toEqual(['B', 'B']);
    expect(await valsIn(s, "g.V().V().has(T.id, lt(5)).values('name')")).toEqual(['B', 'B']);
  });
});

// A collection is UNROLLED only when it is the SINGLE id argument (TINKERPOP-3273,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java
// `hasId`; `GraphStep` for `V()`). Among several arguments a list — literal OR bound — is one literal id,
// which no element has. HasId.feature `g_VX1X_out_hasIdX2_listXid3_id4XX` pins the corpus case.
describe('a list among several id arguments matches nothing', () => {
  const p = { vid1: 1, vid2: 2, xx1: [3, 4], x: [2] };
  test('hasId / within / has(T.id) keep only the scalar operands', async () => {
    expect(await vals("g.V(vid1).out().hasId(vid2, xx1).values('name')", p)).toEqual(['vadas']);
    expect(await vals("g.V().hasId(within(vid2, xx1)).values('name')", p)).toEqual(['vadas']);
    expect(await vals("g.V().has(T.id, within(vid2, xx1)).values('name')", p)).toEqual(['vadas']);
    expect(await vals("g.V().hasId(x, 4).values('name')", p)).toEqual(['josh']);
    expect(await vals("g.V().hasId(x, x).values('name')", p)).toEqual([]);
  });
  test('without() over a list among several loses no row', async () => {
    expect(await vals("g.V().hasId(without(vid2, xx1)).values('name')", p)).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple']);
    expect(await vals("g.V().hasId(without(x, x)).values('name')", p)).toHaveLength(6);
  });
  test('V() follows the same rule; a single collection still unrolls', async () => {
    expect(await vals("g.V(vid2, xx1).values('name')", p)).toEqual(['vadas']);
    expect(await vals("g.V(x, x).values('name')", p)).toEqual([]);
    expect(await vals("g.V(xx1).values('name')", p)).toEqual(['josh', 'lop']);
    expect(await vals("g.V().hasId(xx1).values('name')", p)).toEqual(['josh', 'lop']);
  });
});

// A NULL id is one no element has (`Vertex.feature` `g_VXnullX`/`g_VX1_nullX`, `Edge.feature`
// `g_EX11_nullX`): it contributes no clause, and a set whose only member is null matches NOTHING. The
// trap is the lone null — `undefined` from `idMembership` means "no ids", i.e. the WHOLE graph — so
// `V(null)` and `V($x)` with x = null must be EMPTY, not `V()`. An app passing a nullable id parameter
// is the reach.
describe('a null id matches nothing — never the whole graph', () => {
  test('a lone literal null is empty, not V()', async () => {
    expect(await vals("g.V(null).values('name')")).toEqual([]);
    expect(await vals('g.E(null).count()')).toEqual(['0']);
    expect(await vals('g.V(null, null).count()')).toEqual(['0']);
    expect(await vals('g.V([null]).count()')).toEqual(['0']);
  });

  test('a null beside a real id drops out', async () => {
    expect(await vals("g.V(1, null).values('name')")).toEqual(['marko']);
    expect(await vals("g.inject(1).V(1, null).values('name')")).toEqual(['marko']);
    expect(await vals('g.E(11, null).count()')).toEqual(['1']);
  });

  test('a bound scalar id whose value is null is empty, not V(), and spends no bind', async () => {
    expect(plan("g.V(x).values('name')", { x: null }).binds).toEqual([]);
    expect(await vals("g.V(x).values('name')", { x: null })).toEqual([]);
    expect(await vals("g.V(x, 1).values('name')", { x: null })).toEqual(['marko']);
    expect(await vals('g.V().hasId(x).count()', { x: null })).toEqual(['0']);
    expect(await vals("g.V(xs).values('name')", { xs: [1, null] })).toEqual(['marko']);
  });

  test('composes as a mid-traversal source and under the id predicates', async () => {
    expect(await vals('g.V().local(__.V(null)).count()')).toEqual(['0']);
    expect(await vals("g.V(1).union(__.V(null), __.V(2, null)).values('name')")).toEqual(['vadas']);
    expect(await vals("g.V(1).repeat(__.out().hasId(2, null)).times(1).values('name')")).toEqual(['vadas']);
    expect(await vals('g.V().has(T.id, neq(null)).count()')).toEqual(['6']);
    expect(await vals('g.V().has(T.id, without(null, 1)).count()')).toEqual(['5']);
  });

  test('a null member adds no SQL: routed exactly as the id set without it', () => {
    expect(plan('g.V(1, null)').sql).toBe(plan('g.V(1)').sql);
    // Not the per-row `COALESCE(uid, id)` comparison a null member used to fall back to.
    expect(plan('g.V().out().hasId(2, null).count()').sql).toBe(plan('g.V().out().hasId(2).count()').sql);
    expect(plan('g.V().has(T.id, without(null, 1)).count()').sql).toBe(plan('g.V().has(T.id, without(1)).count()').sql);
  });

  test('another unplaceable id shape still declines', () => {
    expect(() => compile('g.V(true)', {})).toThrow(/not supported/);
  });
});
