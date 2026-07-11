import { test, expect, describe, beforeAll } from 'bun:test';
import { compile } from '../src/compiler.js';
import { GraphStore } from '../src/storage.js';
import { BunSqlite } from '../src/bun/BunSqlite.js';

// Performance regression guard. Property predicates and ordering must be able to
// use an on-demand expression index — `CREATE INDEX ...(json_extract(props,'$.k'))`.
// SQLite only matches such an index against a LITERAL json path; the injection-
// safe `json_extract(props,'$.'||?)` form the compiler used to emit forces a
// full table SCAN and silently defeats the hot-property index strategy the
// project's perf claim depends on. These tests assert (via EXPLAIN QUERY PLAN,
// so they're machine-independent) that the index actually engages. If someone
// reverts propExtract() to the bound-path form, these flip to SCAN and fail.

describe('property expression indexes engage (perf regression guard)', () => {
  let store: GraphStore, raw: BunSqlite;

  beforeAll(() => {
    raw = new BunSqlite(':memory:');
    store = new GraphStore(raw);
    const person = store.labelId('person');
    raw.exec('BEGIN');
    for (let i = 1; i <= 5000; i++) {
      store.query('INSERT INTO nodes(id,label,props) VALUES(?,?,?)',
        [i, person, JSON.stringify({ name: 'n' + i, age: 18 + (i % 60) })]);
    }
    raw.exec('COMMIT');
    // The "management endpoint" story: an operator indexes a hot property.
    raw.exec("CREATE INDEX n_age ON nodes(json_extract(props, '$.age'))");
    raw.exec("CREATE INDEX n_name ON nodes(json_extract(props, '$.name'))");
  });

  const plan = (q: string): string[] => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected read plan');
    return store.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds).map((r: any) => r.detail);
  };
  const usesIndex = (detail: string[], idx: string) => detail.some((d) => d.includes(idx));
  const fullScans = (detail: string[]) =>
    detail.some((d) => /\bSCAN\b/.test(d) && !/USING\s+(COVERING\s+)?INDEX/.test(d));

  test('has(key, predicate) range filter uses the property index, not a scan', () => {
    const p = plan('g.V().has("age", gt(70)).count()');
    expect(usesIndex(p, 'n_age')).toBe(true);
    expect(fullScans(p)).toBe(false);
  });

  test('has(key, value) point lookup uses the property index', () => {
    const p = plan('g.V().has("name", "n42")');
    expect(usesIndex(p, 'n_name')).toBe(true);
    expect(fullScans(p)).toBe(false);
  });

  test('values(key) projection uses the property index (covering)', () => {
    const p = plan('g.V().values("age")');
    expect(usesIndex(p, 'n_age')).toBe(true);
  });

  test('order().by(key) sorts via the index, no temp B-tree', () => {
    const p = plan('g.V().order().by("age").limit(10).id()');
    expect(usesIndex(p, 'n_age')).toBe(true);
    expect(p.some((d) => /B-TREE/.test(d))).toBe(false);
  });

  test('the compiled path is a literal (index-matchable), not a bound concat', () => {
    const p = compile('g.V().has("age", 30)', {});
    if (p.kind !== 'read') throw new Error('read');
    expect(p.sql).toContain("json_extract(n.props, '$.age')");
    expect(p.sql).not.toContain("'$.' || ?");
  });
});
