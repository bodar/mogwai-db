// A collection PARAMETER as a `within`/`without` set (`within($names)`, a bound list) crosses as ONE
// `jsonb(?)` bind exploded by `json_each` — `subject IN (SELECT value FROM json_each(jsonb(?)))` — for
// ANY size. This is the "parameters are the only binds" thesis applied to a collection: the parameter
// stays a single bind, and the statement text never becomes a function of its data.
//
// It replaces a real DEFECT: before, the faithful-vs-unwrapped split lived in the front-end, which
// FLATTENED a param list into inline `IN ('marko','vadas')` literals — the parameter's data baked into
// the statement text (defeating the cache, and forbidden by the data-not-in-text rule) — and declined a
// >25-member set to legacy. Now the front-end (`parsePredicate`) is faithful and the RelIR predicate
// (`predicateExpr` + `jsonEachInSet`) owns the lowering; a LITERAL still spreads to an inline IN-list.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { seededStore } from '../support/harness.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

const store = seededStore();
const kindOf = (g: string, p: Record<string, any> = {}) => compile(g, p).kind;
const plan = (g: string, p: Record<string, any> = {}) => compile(g, p) as any;
const vals = async (g: string, p: Record<string, any> = {}) => {
  const out: string[] = [];
  for (const b of exec(store).buffers(g, p, {})) out.push(String(await decode(b)));
  return out.sort();
};

describe('collection-PARAMETER within/without → one jsonb(?) bind via json_each', () => {
  const NAMES = ['marko', 'vadas'];

  test('within($names) is ONE bind, json_each, data NOT in the statement text', async () => {
    const g = "g.V().values('name').is(within(names))";
    expect(kindOf(g, { names: NAMES })).toBe('read');
    const p = plan(g, { names: NAMES });
    expect(p.binds).toHaveLength(1);                                   // the whole array as one jsonb bind
    expect(p.binds[0]).toBe(JSON.stringify(NAMES));                   // the JSON text, not spread values
    expect(p.sql).toContain('json_each(jsonb(?))');                  // exploded, not an inline IN-list
    expect(p.sql).not.toContain("'marko'");                          // no data in the statement text
    expect(await vals(g, { names: NAMES })).toEqual(['marko', 'vadas']);
  });

  test('a >25-member param set stays on rel (no decline to legacy) as ONE bind', async () => {
    const many = Array.from({ length: 30 }, (_, i) => 'x' + i).concat('marko');
    const g = "g.V().values('name').is(within(names))";
    expect(kindOf(g, { names: many })).toBe('read');
    expect(plan(g, { names: many }).binds).toHaveLength(1);
    expect(await vals(g, { names: many })).toEqual(['marko']);
  });

  test('a LITERAL within is unchanged — inline IN-list, zero binds', async () => {
    const g = "g.V().values('name').is(within('marko','vadas'))";
    expect(kindOf(g)).toBe('read');
    expect(plan(g).binds).toHaveLength(0);
    expect(plan(g).sql).toContain("IN ('marko', 'vadas')");
    expect(await vals(g)).toEqual(['marko', 'vadas']);
  });

  test('without($names) negates the same json_each membership', async () => {
    const g = "g.V().values('name').is(without(names))";
    expect(plan(g, { names: NAMES }).binds).toHaveLength(1);
    expect(plan(g, { names: NAMES }).sql).toContain('NOT IN (SELECT');
    expect(await vals(g, { names: NAMES })).toEqual(['josh', 'lop', 'peter', 'ripple']);
  });

  test('has(key, within($names)) — the same set, one bind', async () => {
    const g = "g.V().has('name', within(names)).values('name')";
    expect(plan(g, { names: ['marko', 'josh'] }).binds).toHaveLength(1);
    expect(await vals(g, { names: ['marko', 'josh'] })).toEqual(['josh', 'marko']);
  });
});
