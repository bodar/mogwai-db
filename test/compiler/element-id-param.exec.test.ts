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
const onRel = (g: string, p: Record<string, any> = {}) => { const c = compile(g, p, { spine: 'rel' }); return c.kind === 'read' ? c.spine : c.kind; };
const plan = (g: string, p: Record<string, any> = {}) => compile(g, p, { spine: 'rel' }) as any;
const valsIn = async (s: ReturnType<typeof seededStore>, g: string, p: Record<string, any> = {}) => {
  const out: string[] = [];
  for (const b of exec(s).buffers(g, p, {})) out.push(String(await decode(b)));
  return out.sort();
};
const vals = (g: string, p: Record<string, any> = {}) => valsIn(store, g, p);

describe('V()/E() id PARAMETER → bind, never inline', () => {
  test('V($xs) collection is ONE jsonb(?) bind exploded by json_each, data NOT in the text', async () => {
    const g = "g.V(xs).values('name')";
    expect(onRel(g, { xs: [1, 2] })).toBe('rel');
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
