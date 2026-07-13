import { test, expect, describe, beforeAll } from 'bun:test';
import { compile, type Compiled } from '../src/compiler.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';

// Performance regression guard for property access (W4).
//
// Vertex properties are normalized into `vertex_properties` with STATIC covering
// indexes built once at schema time: vp_key_value(key,value) and vp_node_key(node,key).
// has()/order().by()/values() must ride one of these — an index SEARCH, never a full
// SCAN of vertex_properties. This replaces the old self-tuning json_extract expression
// index (and its literal-splice requirement); a bound key still seeks a plain B-tree
// column, so there is nothing to auto-build and no per-key indexKeys reporting anymore.

describe('property indexes: static vp indexes engage (no full scan)', () => {
  let store: GraphStore, raw: BunSqlite;

  beforeAll(() => {
    raw = new BunSqlite(':memory:');
    store = new GraphStore(raw);
    const person = store.labelId('person');
    raw.exec('BEGIN');
    const node = 'INSERT INTO nodes(id,label) VALUES(?,?)';
    const prop = 'INSERT INTO vertex_properties(node,key,value) VALUES(?,?,?)';
    for (let i = 1; i <= 5000; i++) {
      store.query(node, [i, person]);
      store.query(prop, [i, 'name', 'n' + i]);
      store.query(prop, [i, 'age', 18 + (i % 60)]);
    }
    raw.exec('COMMIT');
  });

  const plan = (q: string): Compiled => {
    const p = compile(q, {});
    if (p.kind !== 'read') throw new Error('expected read plan');
    return p;
  };
  const explain = (p: Compiled) => store.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds).map((r: any) => r.detail);
  // EXPLAIN names the table by its alias (vp) or full name, and may insert EXISTS —
  // key on the vp_ index name instead.
  const usesVpIndex = (d: string[]) => d.some((s) => /USING (COVERING )?INDEX vp_/.test(s));
  const scansVp = (d: string[]) => d.some((s) => /\bSCAN (vertex_properties|vp)\b/.test(s) && !/USING/.test(s));

  test('the static vp indexes exist at schema time (no self-tuning build)', () => {
    const idx = store.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
    expect(idx).toContain('vp_key_value');
    expect(idx).toContain('vp_node_key');
  });

  test('has(key, P) rides a vp index (no full scan of vertex_properties)', () => {
    const p = plan('g.V().has("age", gt(70)).count()');
    const d = explain(p);
    expect(usesVpIndex(d)).toBe(true);
    expect(scansVp(d)).toBe(false);
  });

  test('has(key, value) point lookup rides a vp index', () => {
    const d = explain(plan('g.V().has("name", "n42")'));
    expect(usesVpIndex(d)).toBe(true);
    expect(scansVp(d)).toBe(false);
  });

  test('order().by(key) resolves the sort value via a vp index', () => {
    const d = explain(plan('g.V().order().by("age").limit(10).id()'));
    expect(usesVpIndex(d)).toBe(true);
  });

  test('values(key) flatMap join rides a vp index', () => {
    const d = explain(plan('g.V().values("name")'));
    expect(usesVpIndex(d)).toBe(true);
  });
});
