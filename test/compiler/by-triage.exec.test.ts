// classifyBy / byAt (src/compiler/steps/tail/child-shape.ts): the ONE pure by()-modulator argument
// triage every host (group/select/project/path/math/format/order/dedup/aggregate) shares.
// These lock the closed-set shape mapping + the round-robin accessor so the ~9 former inline
// copies cannot drift once they route through here.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';
import { classifyBy, byAt, classifyByAt } from '../../src/compiler/steps/tail/child-shape.ts';

/** Normalize a traversal and return the folded `.bys` of its first host step carrying them
 *  (order/group/select/project/dedup — whichever appears). */
const bysOf = (gremlin: string): any[][] => {
  const steps = normalize(stepChain(parseGremlin(gremlin), {})).steps;
  const host = steps.find((s: any) => s.bys?.length);
  return (host?.bys ?? []) as any[][];
};

describe('classifyBy — closed-set shape triage', () => {
  test('bare by() → none', () => {
    // dedup().by() with an empty group.
    expect(classifyBy([]).kind).toBe('none');
    expect(classifyBy(undefined).kind).toBe('none');
  });

  test("by('key') → key", () => {
    const bys = bysOf("g.V().order().by('age')");
    const c = classifyBy(bys[0]);
    expect(c.kind).toBe('key');
    expect(c.kind === 'key' && c.key).toBe('age');
  });

  test("by('key', desc) → key with direction", () => {
    const bys = bysOf("g.V().order().by('age', desc)");
    const c = classifyBy(bys[0]);
    expect(c.kind).toBe('key');
    expect(c.kind === 'key' && c.key).toBe('age');
    expect(c.dir).toBe('desc');
  });

  test('by(T.label) → token', () => {
    const bys = bysOf('g.V().group().by(T.label)');
    const c = classifyBy(bys[0]);
    expect(c.kind).toBe('token');
    expect(c.kind === 'token' && c.token).toBe('label');
  });

  test('by(__.traversal) → nested', () => {
    const bys = bysOf("g.V().group().by(__.out().count())");
    const c = classifyBy(bys[0]);
    expect(c.kind).toBe('nested');
    expect(c.kind === 'nested' && !!c.nested).toBe(true);
  });

  test('bare direction-only by(desc) → none with direction', () => {
    const bys = bysOf('g.V().order().by(desc)');
    const c = classifyBy(bys[0]);
    expect(c.kind).toBe('none');
    expect(c.dir).toBe('desc');
  });

  test('shuffle direction is carried', () => {
    const bys = bysOf('g.V().order().by(shuffle)');
    expect(classifyBy(bys[0]).dir).toBe('shuffle');
  });
});

describe('byAt — round-robin accessor', () => {
  test('single by() feeds every position', () => {
    const bys = bysOf("g.V().project('a','b','c').by('name')");
    expect(byAt(bys, 0)).toBe(bys[0]);
    expect(byAt(bys, 1)).toBe(bys[0]);
    expect(byAt(bys, 2)).toBe(bys[0]);
  });

  test('N by()s feed N positions in order', () => {
    const bys = bysOf("g.V().project('a','b').by('name').by('age')");
    expect(byAt(bys, 0)).toBe(bys[0]);
    expect(byAt(bys, 1)).toBe(bys[1]);
    // wraps
    expect(byAt(bys, 2)).toBe(bys[0]);
  });

  test('no bys → undefined', () => {
    expect(byAt([], 0)).toBeUndefined();
    expect(byAt(undefined, 3)).toBeUndefined();
  });

  test('classifyByAt composes both', () => {
    const bys = bysOf("g.V().project('a','b').by('name').by(__.out().count())");
    expect(classifyByAt(bys, 0).kind).toBe('key');
    expect(classifyByAt(bys, 1).kind).toBe('nested');
  });
});
