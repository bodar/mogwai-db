// A COMPUTED property value is stored with a TOTAL type tag (outstanding-work F1).
//
// A value whose body states no static type (`id()`, `values('name').length()`, a branch arm that could
// not say) used to be stored with `vtype` NULL. A range `has(k, gt(x))` compares by the stored tag, so
// the row was invisible to it: `g.V().property('i2', id())` then `has('i2', gt(3))` counted 0. The writer
// now completes the tag from the value's storage class (`totalTag`, `inferredVtype`) — the wire's own
// inference, so the read-back value and its type do not change.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { bare, run, seededStore } from '../support/harness.ts';

/** Run each traversal in order against one fresh modern graph; answer the LAST one's rows, bare. */
const after = (...qs: string[]): unknown => {
  const store = seededStore();
  let out: unknown;
  for (const q of qs) out = run(store, q);
  return bare(out);
};
const count = (...qs: string[]): unknown => (after(...qs) as { v: unknown }[])[0]!.v;

describe('a computed property value keeps a type tag a range has() can read', () => {
  test.each([
    ["g.V().property('i2', id()).iterate()", "g.V().has('i2', gt(3)).count()", 3],
    ["g.V().property('i2', id()).iterate()", "g.V().has('i2', gte(1)).count()", 6],
    ["g.V().property('w', values('name').length()).iterate()", "g.V().has('w', gt(-1000)).count()", 6],
    ["g.V().property('w', out().id()).iterate()", "g.V().has('w', gt(-1000)).count()", 3],
    ["g.V().property('w', map(id())).iterate()", "g.V().has('w', gt(0)).count()", 6],
    ["g.V().property('w', local(values('name').length())).iterate()", "g.V().has('w', gt(-1000)).count()", 6],
    ["g.V().property(list, 'w', id()).iterate()", "g.V().has('w', gt(0)).count()", 6],
    // a branch arm that states no type (`id()`) beside one that does (`values('age')`)
    ["g.V().property('w', coalesce(values('age'), id())).iterate()", "g.V().has('w', gt(-1000)).count()", 6],
    ["g.V().property('w', choose(has('age'), values('age'), id())).iterate()", "g.V().has('w', gt(-1000)).count()", 6],
    ["g.V().property('w', union(id())).iterate()", "g.V().has('w', gt(-1000)).count()", 6],
    // the map form, a re-sourced body, an edge
    ["g.V().property(__.project('w').by(id())).iterate()", "g.V().has('w', gt(0)).count()", 6],
    ["g.addV('x').property('w', V(1).id()).iterate()", "g.V().has('w', gt(0)).count()", 1],
    ["g.V(1).addE('z').to(V(2)).property('w', id()).iterate()", "g.E().has('w', gt(0)).count()", 1],
    // a merge arm resolved per driver
    ["g.V().hasLabel('person').mergeV(__.project('name').by(__.values('name'))).option(Merge.onMatch, ['echo': __.id()]).iterate()",
      "g.V().has('echo', gt(0)).count()", 4],
  ])('%s; %s', (write, read, want) => {
    expect(count(write, read)).toBe(want);
  });

  test('the stored tag is the one the wire infers: Int inside int32, Long past it, String for text', () => {
    expect(after("g.V().property('w', values('name').length()).iterate()", "g.V(1).values('w')")).toEqual([{ v: 5, vtype: 'int' }]);
    expect(after("g.addV('x').property(T.id, 'abc').iterate()", "g.V('abc').property('w', id()).iterate()", "g.V('abc').values('w')"))
      .toEqual([{ v: 'abc', vtype: 'string' }]);
    expect(count("g.addV('x').property(T.id, 'abc').iterate()", "g.V('abc').property('w', id()).iterate()", "g.V().has('w', gt('a')).count()")).toBe(1);
    expect(after("g.addV('x').property(T.id, 5000000000).iterate()", "g.V(5000000000).property('w', id()).iterate()", "g.V(5000000000).values('w')"))
      .toEqual([{ v: 5000000000, vtype: 'long' }]);
    expect(count("g.addV('x').property(T.id, 5000000000).iterate()", "g.V(5000000000).property('w', id()).iterate()", "g.V().has('w', gt(4000000000)).count()")).toBe(1);
  });

  test('a static tag stays a literal: no storage-class inference in the write', () => {
    const sql = (q: string): string => {
      const plan = compile(q, {});
      return plan.kind === 'program' ? plan.steps.map((step) => step.emitted.sql).join('\n') : plan.sql;
    };
    expect(sql("g.V().property('c', out().count()).iterate()")).not.toContain("THEN 'int' ELSE 'long'");
    expect(sql("g.V().property('a2', values('age')).iterate()")).not.toContain("THEN 'int' ELSE 'long'");
    expect(sql("g.V().property('w', id()).iterate()")).toContain("THEN 'int' ELSE 'long'");
  });
});
