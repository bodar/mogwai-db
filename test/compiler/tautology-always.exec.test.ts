// THE TAUTOLOGY IS SPELLED ONCE — `always` in `src/rel/expr.ts`. An empty conjunction is
// `conjoin(xs) ?? always`, never a fold SEEDED with `1 = 1` (which put a leading `1 = 1 AND` into every
// merge search, residual and pair test). The constant TRUE a lowering states (`CONSTANT.true`) and the
// `'always'` presence (`ALWAYS_PRODUCTIVE`) are that same object, so a by-reference elision sees all of them.
import { describe, expect, test } from 'bun:test';
import { always, conjoin } from '../../src/rel/expr.ts';
import { CONSTANT } from '../../src/compiler/rel/predicate.ts';
import { ALWAYS_PRODUCTIVE } from '../../src/compiler/rel/child.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { bare, run, seededStore } from '../support/harness.ts';

/** A `1 = 1` conjoined to something: the seeded-fold residue this file guards against. */
const SEEDED = /\(1 = 1\) AND|AND \(1 = 1\)/;

describe('the tautology `always`', () => {
  test('one shared object: an empty conjunction, the stated TRUE and the always-productive presence', () => {
    expect(conjoin([]) ?? always).toBe(always);
    expect(CONSTANT.true).toBe(always);
    expect(ALWAYS_PRODUCTIVE).toBe(always);
  });

  // A computed map with two keys: the residual, the unnarrowed drivers and the pair test are each a
  // conjunction over the keys; a map-valued driver seeks through `mapEntrySeeks` with no extra narrowing.
  test.each([
    "g.V().mergeV(__.project('name','lang').by('name').by(constant('java')))",
    "g.inject([name:'marko',k:'x'],[name:'nobody']).mergeV()",
  ])('no statement conjoins a `1 = 1`: %s', (q) => {
    expect(JSON.stringify(compile(q, {}))).not.toMatch(SEEDED);
  });

  test('the merge still answers: one match per existing name, one create per new one', () => {
    const store = seededStore();
    const values = (q: string): unknown[] => (bare(run(store, q)) as { v: unknown }[]).map((row) => row.v);
    const [before] = values('g.V().count()') as number[];
    expect(values("g.inject([name:'marko'],[name:'nobody']).mergeV().values('name')").sort()).toEqual(['marko', 'nobody']);
    expect(values('g.V().count()')).toEqual([before! + 1]);
  });
});
