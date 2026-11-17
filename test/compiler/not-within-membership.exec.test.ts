/**
 * `where(P.not(within('x')))` over a side effect is collection NON-membership: `P.not(p)` is `p.negate()`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/P.java:782`) and
 * `within`'s negation is `without`. ONE recogniser (`membershipOf`, `src/compiler/ir/step.ts`) decodes it for both
 * the whole-tree key check and the lowering, so they cannot disagree. The corpus scenario is `Where.feature`'s
 * `g_VX1X_out_aggregateXxX_out_whereXnotXwithinXaXXX`.
 */
import { describe, expect, test } from 'bun:test';
import { membershipOf } from '../../src/compiler/ir/step.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { bare, read, run, seededStore } from '../support/harness.ts';

const store = seededStore();
const values = (q: string): unknown[] => (bare(run(store, q)) as { v: unknown }[]).map((row) => row.v).sort();
const within = (key: unknown) => ({ op: 'within', operands: [{ value: key }] });
const not = (p: unknown) => ({ op: 'not', operands: [{ value: p }] });

describe('membershipOf — the one membership decode', () => {
  test('peels every not, flipping polarity each time', () => {
    expect(membershipOf(within('x'))).toEqual({ key: 'x', negated: false });
    expect(membershipOf({ op: 'without', operands: [{ value: 'x' }] })).toEqual({ key: 'x', negated: true });
    expect(membershipOf(not(within('x')))).toEqual({ key: 'x', negated: true });
    expect(membershipOf(not(not(within('x'))))).toEqual({ key: 'x', negated: false });
    expect(membershipOf(not({ op: 'without', operands: [{ value: 'x' }] }))).toEqual({ key: 'x', negated: false });
  });

  test('is not membership in one collection: several operands, a non-string key, another op', () => {
    expect(membershipOf(not({ op: 'within', operands: [{ value: 'x' }, { value: 'y' }] }))).toBeNull();
    expect(membershipOf(not(within(1)))).toBeNull();
    expect(membershipOf(not({ op: 'eq', operands: [{ value: 'x' }] }))).toBeNull();
    expect(membershipOf('x')).toBeNull();
  });
});

describe('where(P.not(within(k))) over a side effect', () => {
  test('is non-membership — the same answer as without(k)', () => {
    expect(values("g.V(1).out().aggregate('x').out().where(P.not(within('x'))).values('name')")).toEqual(['ripple']);
    expect(values("g.V(1).out().aggregate('x').out().where(without('x')).values('name')")).toEqual(['ripple']);
    expect(values("g.V(1).out().aggregate('x').out().where(P.not(P.not(within('x')))).values('name')")).toEqual(['lop']);
    expect(values("g.V(1).out().aggregate('x').out().where(P.not(without('x'))).values('name')")).toEqual(['lop']);
    expect(values("g.V().has('name','marko').as('a').out('created').aggregate('stash').in('created').out('created')"
      + ".where(P.not(within('stash'))).values('name')")).toEqual(['ripple']);
  });

  test('a one-member LIST key is the same key — the form every GLV sends (`within(["x"])`)', () => {
    expect(values("g.V(1).out().aggregate('x').out().where(not(within(['x']))).values('name')")).toEqual(['ripple']);
    expect(values("g.V(1).out().aggregate('x').out().where(without(['x'])).values('name')")).toEqual(['ripple']);
    expect(values("g.V(1).out().aggregate('x').out().where(within(['x'])).values('name')")).toEqual(['lop']);
    expect(membershipOf(not({ op: 'within', operands: [{ value: ['x'] }] }))).toEqual({ key: 'x', negated: true });
    expect(membershipOf({ op: 'within', operands: [{ value: ['x', 'y'] }] })).toBeNull();
  });

  test('over a VALUE collection', () => {
    expect(values("g.V(1).out().values('age').aggregate('x').fold().V().values('age').where(P.not(within('x')))")).toEqual([29, 35]);
  });

  test('composes at depth — local, filter, choose, coalesce, union, repeat, project().by()', () => {
    const pre = "g.V(1).out().aggregate('x').out()";
    expect(values(`${pre}.local(where(P.not(within('x')))).values('name')`)).toEqual(['ripple']);
    expect(values(`${pre}.filter(where(P.not(within('x')))).values('name')`)).toEqual(['ripple']);
    expect(values(`${pre}.choose(where(P.not(within('x'))), constant('new'), constant('old'))`)).toEqual(['new', 'old']);
    expect(values(`${pre}.coalesce(where(P.not(within('x'))).values('name'), constant('seen'))`)).toEqual(['ripple', 'seen']);
    expect(values(`${pre}.union(where(P.not(within('x'))), identity()).values('name')`)).toEqual(['lop', 'ripple', 'ripple']);
    expect(values("g.V(1).out().aggregate('x').fold().V().repeat(out().where(P.not(within('x')))).times(1).values('name')"))
      .toEqual(['ripple']);
    expect(values("g.V(1).out().aggregate('x').fold().V().project('c').by(out().where(P.not(within('x'))).count()).select('c')"))
      .toEqual([0, 0, 0, 0, 0, 1]);
  });

  test('is the negated 0/1 probe, never NOT IN — the same plan as without()', () => {
    const { sql } = read("g.V(1).out().aggregate('x').out().where(P.not(within('x'))).values('name')");
    expect(sql).not.toMatch(/NOT IN/);
    expect(sql).toMatch(/CASE WHEN \S+ IN \(SELECT/);
    expect(sql).toBe(read("g.V(1).out().aggregate('x').out().where(without('x')).values('name')").sql);
  });

  test('a value member tag is spelled ONCE per member row, not once per key arm', () => {
    const { sql } = read("g.V(1).out().values('age').aggregate('x').fold().V().values('age').where(P.not(within('x')))");
    expect(sql.match(/coalesce\(cu\d+\.vtype/g)?.length).toBe(1);
  });

  test('several keys under not still decline (getSelectKey reads only the first member)', () => {
    expect(() => run(store, "g.V(1).out().aggregate('x').out().where(P.not(within('x','y'))).values('name')"))
      .toThrow(UnsupportedTraversal);
    expect(() => run(store, "g.V(1).out().aggregate('x').out().where(without(['x','y'])).values('name')"))
      .toThrow(UnsupportedTraversal);
  });
});
