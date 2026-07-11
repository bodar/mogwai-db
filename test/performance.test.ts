import { test, expect, describe, beforeAll } from 'bun:test';
import { compile, type Compiled } from '../src/compiler.js';
import { GraphStore } from '../src/storage.js';
import { BunSqlite } from '../src/bun/BunSqlite.js';

// Performance regression guard for property access.
//
// (1) Property predicates/ordering must be able to use an expression index —
//     `CREATE INDEX ...(json_extract(props,'$.k'))`. SQLite only matches such an
//     index against a LITERAL json path; the injection-safe `'$.'||?` form
//     forces a full SCAN and silently defeats the hot-property index strategy.
// (2) Those indexes are built AUTOMATICALLY on first filtered use of a key
//     (compiler reports the hot keys as `indexKeys`; the handler ensures them).
//     This test drives the same compile → ensure-indexes → run path the handler
//     uses, and asserts via EXPLAIN QUERY PLAN that the index gets created and
//     engaged. If either the literal splice or the auto-build regresses, the
//     plans flip back to SCAN and these fail.

describe('property expression indexes: auto-built and engaged', () => {
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
    // NOTE: no manual CREATE INDEX — the indexes below are auto-built by run().
  });

  // Mirror the handler: ensure hot-property indexes, then execute.
  const run = (q: string): { plan: Compiled; details: string[] } => {
    const plan = compile(q, {});
    if (plan.kind !== 'read') throw new Error('expected read plan');
    for (const key of plan.indexKeys ?? []) store.ensureNodePropIndex(key);
    const details = store.query(`EXPLAIN QUERY PLAN ${plan.sql}`, plan.binds).map((r: any) => r.detail);
    return { plan, details };
  };
  const indexNames = () =>
    store.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
  const usesIndex = (d: string[], idx: string) => d.some((s) => s.includes(idx));
  const fullScans = (d: string[]) => d.some((s) => /\bSCAN\b/.test(s) && !/USING\s+(COVERING\s+)?INDEX/.test(s));

  test('has(key) reports the key and auto-builds its index', () => {
    expect(indexNames()).not.toContain('n_prop_age'); // not there yet
    const { plan, details } = run('g.V().has("age", gt(70)).count()');
    expect(plan.indexKeys).toEqual(['age']);
    expect(indexNames()).toContain('n_prop_age'); // built on first use
    expect(usesIndex(details, 'n_prop_age')).toBe(true);
    expect(fullScans(details)).toBe(false);
  });

  test('has(key, value) point lookup auto-builds and uses the index', () => {
    const { details } = run('g.V().has("name", "n42")');
    expect(indexNames()).toContain('n_prop_name');
    expect(usesIndex(details, 'n_prop_name')).toBe(true);
    expect(fullScans(details)).toBe(false);
  });

  test('order().by(key) sorts via the auto-built index, no temp B-tree', () => {
    const { plan, details } = run('g.V().order().by("age").limit(10).id()');
    expect(plan.indexKeys).toContain('age');
    expect(usesIndex(details, 'n_prop_age')).toBe(true);
    expect(details.some((d) => /B-TREE/.test(d))).toBe(false);
  });

  test('exotic (non-identifier) keys are NOT indexed and do not splice', () => {
    const plan = compile('g.V().has("first name", "x")', {});
    if (plan.kind !== 'read') throw new Error('read');
    expect(plan.indexKeys).toEqual([]); // bound, not index-eligible
    expect(plan.sql).toContain("json_extract(n.props, '$.' || ?)");
    expect(plan.sql).not.toContain('first name');
  });

  test('index build is idempotent / cached (no duplicate, no throw on re-run)', () => {
    run('g.V().has("age", lt(30)).count()');
    run('g.V().has("age", lt(30)).count()');
    expect(indexNames().filter((n) => n === 'n_prop_age')).toHaveLength(1);
  });

  test('plain values(key) projection does NOT trigger an index (bounds proliferation)', () => {
    const plan = compile('g.V().values("name")', {});
    if (plan.kind !== 'read') throw new Error('read');
    expect(plan.indexKeys).toEqual([]); // projection alone isn't a filter
  });
});
