// A `by(<numeric reducer>)` carries the reducer's DYNAMIC type into a record field and a collection
// member, exactly as `by(count())` and `by('age')` already do. The reducer's result type lives on a
// `vt` column (the winner's own Gremlin vtype for min/max, the aggregate's SQLite storage class for
// sum/mean); the correlated by()-reducer arm used to project only `v` and drop it, so `byField`
// declined for want of a type column it had computed. See scalarChild's reducer arm (lower.ts),
// byField (modulator.ts), projectedMembers (collection.ts) and frameTypedNode's `real` route
// (execute.ts). This is the RelIR Phase 2 `by(<reducer>)` type gap, for the per-traverser correlated
// path; the group-scoped POOLED path (group().by(k).by(sum())) is a separate lowering already covered.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

const pairs = (rows: any[]) => JSON.parse(rows[0].map) as [any, any][];
const field = (rows: any[], key: string) => pairs(rows).find(([k]) => k === key)?.[1];

describe('by(<numeric reducer>) carries its type into fields and members', () => {
  test('project().by(sum()) frames the field by the reducer type, not inference', () => {
    const store = seededStore();
    const r = run(store, 'g.V().has("name","lop").project("n","w").by("name").by(__.inE("created").values("weight").sum())');
    // lop's inbound created weights are 0.4 + 0.4 + 0.2 — a REAL sum, so the field's tag is `real`
    // (routed to Double at the wire), never the Int magnitude inference would pick for a whole number.
    expect(field(r, 'n')).toEqual({ t: 'string', v: 'lop' });
    expect(field(r, 'w').t).toBe('real');
    expect(field(r, 'w').v).toBeCloseTo(1.0, 9);
  });

  test('project().by(mean()) forces a REAL field (the whole-number-mean trap)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().has("name","lop").project("n","w").by("name").by(__.inE("created").values("weight").mean())');
    // mean of [0.4, 0.4, 0.2] ≈ 0.333 — and even a whole-number mean must frame Double, which is why
    // `frameTypedNode` routes a `real` tag through `sumBuffer` rather than inferring by magnitude.
    expect(field(r, 'w').t).toBe('real');
    expect(field(r, 'w').v).toBeCloseTo(1 / 3, 9);
  });

  test('aggregate().by(sum()).cap() member frames IDENTICALLY to the top-level reducer', () => {
    // The strongest correctness bar: a collection member of a `by(sum())` is the same value, framed the
    // same way, as the top-level `…sum()` over the same rows — same `v`, same `vt`.
    for (const name of ['lop', 'ripple']) {
      const store = seededStore();
      const top = run(store, `g.V().has("name","${name}").inE("created").values("weight").sum()`);
      const mem = run(store, `g.V().has("name","${name}").aggregate("a").by(__.inE("created").values("weight").sum()).cap("a").unfold()`);
      expect(mem.map((x) => ({ v: x.v, vt: x.vt }))).toEqual(top.map((x) => ({ v: x.v, vt: x.vt })));
    }
  });

  test('a whole-graph aggregate().by(sum()).cap() collects one typed member per productive vertex', () => {
    const store = seededStore();
    const r = run(store, 'g.V().aggregate("a").by(__.inE("created").values("weight").sum()).cap("a")');
    const members = JSON.parse(r[0].list) as { t: string; v: number }[];
    // lop and ripple are the only vertices with inbound created edges; each contributes one member.
    expect(members.length).toBe(2);
    for (const m of members) { expect(m.v).toBeCloseTo(1.0, 9); expect(['real', 'integer']).toContain(m.t); }
  });

  test('min()/max() in a by() still fail closed (window+materialize path, a separate increment)', () => {
    const store = seededStore();
    for (const reducer of ['min', 'max']) {
      expect(() => run(store, `g.V().has("name","lop").project("n","w").by("name").by(__.inE("created").values("weight").${reducer}())`))
        .toThrow(/not supported yet/);
    }
  });
});
