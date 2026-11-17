import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadBulk } from '../../src/bulk.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { reevaluatedCtes } from '../support/cte-runs.ts';
import { runWith, seededStore } from '../support/harness.ts';

// A SHARED CTE SQLITE WOULD FLATTEN INTO EACH READER IS FENCED WHEN A BARRIER OR A WALK LIES BENEATH ITS TOP
// (`fenced`, `src/rel/passes/name.ts`; `copyRerunsBarrier`, `src/rel/copies.ts`). An `emit` condition that reads
// adjacency is asked once per walk STATE (`perState`, `src/compiler/rel/walk.ts`), so the walk's rows past the
// depth test are read twice — the distinct states, then the semi-join that keeps the rows whose state passed.
// That shared relation's top is a row-wise filter, so unfenced SQLite flattened it into both readers and ran the
// recursive CTE twice per statement (two `CO-ROUTINE wk_…` plan rows). Fenced, the walk runs once.

/** A binary tree of `knows` (parent → child) among persons, every fifth vertex a leaf software. */
function treeGraph(n: number): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const software = (i: number): boolean => i % 5 === 0;
  const vs = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return { id: i, labels: [software(i) ? 'software' : 'person'], properties: software(i) ? [] : [{ key: 'age', value: 20 + ((i * 7) % 45) }] };
  });
  const es: { label: string; src: number; tgt: number }[] = [];
  for (let i = 2; i <= n; i++) if (!software(Math.floor(i / 2))) es.push({ label: 'knows', src: Math.floor(i / 2), tgt: i });
  loadBulk(store, vs, es);
  return store;
}

const WALKS = [
  "g.V().repeat(out('knows')).emit(in('knows').has('age',gt(40))).count()",
  "g.V().hasLabel('person').where(repeat(out('knows')).emit(in('knows').has('age',gt(40)))).count()",
  "g.V().local(repeat(out('knows')).emit(in('knows').has('age',gt(40))).count()).sum()",
  "g.V().union(repeat(out('knows')).emit(in('knows').has('age',gt(40))), identity()).count()",
  "g.V().not(repeat(out('knows')).emit(in('knows').has('age',gt(40)))).count()",
  "g.V().project('n').by(repeat(out('knows')).emit(in('knows').has('age',gt(40))).count()).count()",
  // The control: `until` before `emit` — the `twice` route already shares the walk as one CTE.
  "g.V().until(hasLabel('software')).repeat(out()).emit(has('age',gt(30))).count()",
];

const planOf = (store: GraphStore, q: string): { sql: string; plan: { id: number; parent: number; detail: string }[] } => {
  const p = compile(q, {});
  if (p.kind !== 'read' || !p.sql) throw new Error(`${q}: not a single read`);
  return { sql: p.sql, plan: store.query(`EXPLAIN QUERY PLAN ${p.sql}`, p.binds) as never };
};

describe('a shared CTE over a walk is evaluated once per statement', () => {
  const store = treeGraph(200);
  for (const q of WALKS) test(q, () => {
    const { sql, plan } = planOf(store, q);
    expect(reevaluatedCtes(sql, plan)).toEqual([]);
  });

  test('answers on the modern graph', () => {
    const modern = seededStore();
    const count = (q: string): number => Number(runWith(modern, q)[0].v);
    // marko knows vadas and josh; neither has a `knows` parent older than 40 (marko is 29).
    expect(count(WALKS[0]!)).toBe(0);
    expect(count("g.V().repeat(out('knows')).emit(in('knows').has('age',gt(20))).count()")).toBe(2);
    expect(count("g.V().hasLabel('person').where(repeat(out('knows')).emit(in('knows').has('age',gt(20)))).count()")).toBe(1);
    expect(count(WALKS[6]!)).toBe(9);
  });

  test('answers on the tree agree with a per-row reading', () => {
    // Per row and per state answer the same rows: `emit(c)` ≡ `emit(filter(c))`, which no rule fences.
    const count = (q: string): number => Number(runWith(store, q)[0].v);
    expect(count(WALKS[0]!)).toBe(count("g.V().repeat(out('knows')).emit(filter(in('knows').has('age',gt(40)))).count()"));
    expect(count(WALKS[0]!)).toBeGreaterThan(0);
  });
});

describe('the sql-hygiene rule sees a CTE evaluated twice', () => {
  test('two CO-ROUTINE rows naming one CTE are reported; a derived-table alias is not', () => {
    const sql = 'WITH r1 AS (SELECT 1), r2 AS MATERIALIZED (SELECT 2) SELECT * FROM (SELECT 1) d1';
    const row = (id: number, detail: string) => ({ id, parent: 0, detail });
    expect(reevaluatedCtes(sql, [row(1, 'CO-ROUTINE r1'), row(2, 'CO-ROUTINE r1'), row(3, 'MATERIALIZE r2'), row(4, 'CO-ROUTINE d1'), row(5, 'CO-ROUTINE d1')]))
      .toEqual(['CTE r1 is evaluated 2 times — fence it']);
  });
});
