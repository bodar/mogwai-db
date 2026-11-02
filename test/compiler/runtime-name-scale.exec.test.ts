// A PER-TRAVERSER RUNTIME NAME IS LINEAR IN THE TRAVERSERS — `addV(<traversal>)`, `addLabel(<traversal>)`
// and `property(<traversal>, v)` over every vertex of a graph a production DO actually holds.
//
// Every one of them pairs TAKEN snapshots — the resolved names, the created ids, the interned labels — and
// a snapshot arrives as `json_each(?)`, which SQLite can neither index nor keep. Joined as an inner loop
// it is re-decoded per outer row, so each route was O(N²): measured on trunk over ~6k vertices,
// `addV` 9.3 s, `addLabel` 32 s, `property` 24.9 s — each passing every six-vertex fixture, and each a
// CPU wall that only a production-sized DO reaches. The cure is in the emitter (`spools`,
// `src/rel/emit.ts`): a snapshot read more than once, or as an inner side, becomes a MATERIALIZED CTE the
// planner auto-indexes; the stale-slot delete is driven from the written rows (`slotRows`,
// `src/compiler/rel/write.ts`).
//
// Two assertions, deliberately of different kinds: the PLAN (deterministic — no statement scans a taken
// snapshot as an inner loop, read off SQLite's own EXPLAIN) and a WALL budget generous enough to hold on a
// loaded CI runner yet far below the quadratic cost.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { runSteps } from '../../src/program.ts';
import { isRowsBind } from '../../src/rel/emit.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { rawVertex } from '../support/graph.ts';
import { run } from '../support/harness.ts';
import { nestedSnapshotScans, type PlanRow } from '../support/snapshot-scans.ts';

const N = 6000;
/** Quadratic was ≥ 9 s at this size on trunk; linear is ~0.1 s. */
const BUDGET_MS = 3000;

function graph(n: number): GraphStore {
  const raw = new BunSqlite(':memory:');
  const store = new GraphStore(raw);
  raw.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    rawVertex(store, i, 'person');
    store.query('INSERT INTO vertex_properties(node,key,value,vtype) VALUES(?,?,?,?)', [i, 'name', `n${i}`, 'string']);
  }
  // A chain, so an edge write has n - 1 traversers too.
  const next = store.labelId('next');
  for (let i = 1; i < n; i++) store.query('INSERT INTO edges(src,label,tgt) VALUES(?,?,?)', [i, next, i + 1]);
  raw.exec('COMMIT');
  return store;
}

/** Run a write program, recording every statement it executed so its plan can be asked afterwards. */
function runRecorded(store: GraphStore, q: string): { rows: readonly Record<string, unknown>[]; ms: number; statements: { sql: string; binds: readonly unknown[] }[] } {
  const compiled = compile(q, {});
  if (compiled.kind !== 'program') throw new Error(`expected a write program for ${q}`);
  const statements: { sql: string; binds: readonly unknown[] }[] = [];
  const recording = {
    query: <T>(sql: string, binds: readonly unknown[] = []): T[] => { statements.push({ sql, binds }); return store.query<T>(sql, binds); },
    atomically: <T>(fn: () => T): T => store.atomically(fn),
  };
  const start = performance.now();
  const rows = runSteps(recording, compiled);
  return { rows, ms: performance.now() - start, statements };
}

/** Each executed statement's planner verdict: the snapshots it scans as an inner loop. */
const innerSnapshotScans = (store: GraphStore, statements: readonly { sql: string; binds: readonly unknown[] }[]): string[] =>
  statements.flatMap(({ sql, binds }) => {
    const plan = store.query<PlanRow>(`EXPLAIN QUERY PLAN ${sql}`, binds.map((bind) => (isRowsBind(bind) ? '[]' : bind)));
    return nestedSnapshotScans(sql, plan).map((alias) => `${alias} in: ${sql.slice(0, 160)}`);
  });

/** Every executable statement of a write program, in order. */
const statementsOf = (q: string): readonly { readonly sql: string; readonly binds: readonly unknown[] }[] => {
  const compiled = compile(q, {});
  if (compiled.kind !== 'program') throw new Error(`expected a write program for ${q}`);
  return compiled.steps.map((step) => step.emitted);
};

describe('a taken snapshot is spooled per statement, only where it is read again', () => {
  test('a single streaming read keeps its json_each, byte for byte', () => {
    const insert = statementsOf("g.V().addV('x').count()").find((step) => step.sql.startsWith('INSERT INTO nodes'))!;
    expect(insert.sql).toBe("INSERT INTO nodes (uid) SELECT NULL AS uid FROM json_each(?) r6 ORDER BY json_extract(r6.value, '$[2]') ASC RETURNING nodes.id AS id");
  });

  test('a pairing join spools both inner sides, one bind each, and nothing a later statement does not read', () => {
    const steps = statementsOf("g.V().addV(__.values('name')).count()");
    const pairing = steps.find((step) => step.sql.includes('INSERT INTO vertex_labels'))!;
    expect(pairing.sql.match(/ AS MATERIALIZED \(/g)?.length).toBe(2);
    // created ids (streamed), names and interned labels (spooled): three snapshots, three binds.
    expect(pairing.binds.filter(isRowsBind).length).toBe(3);
    // The spool is the statement's, not the program's: the count after it reads one snapshot once.
    expect(steps.at(-1)!.sql).not.toContain('MATERIALIZED');
  });
});

describe(`a runtime name or value over ${N} traversers is linear`, () => {
  for (const [q, traversers, check, read] of [
    // The three runtime NAMES — the witnesses.
    ["g.V().addV(__.values('name')).count()", N, "g.V().hasLabel('n4242').count()", 1],
    ["g.V().addLabel(__.values('name')).count()", N, "g.V(4242).labels().count()", 2],
    ["g.V().property(__.values('name'), 1).count()", N, "g.V(4242).values('n4242')", 1],
    // The same pairing under a runtime VALUE: the displaced-slot delete of a single write, the meta patch of
    // a set write, and an edge's first-result value.
    ["g.V().property(single, 'copy', __.values('name')).count()", N, "g.V(4242).values('copy')", 'n4242'],
    ["g.V().property(set, 'name', __.values('name'), 'acl', 'x').count()", N, "g.V(4242).properties('name').count()", 1],
    ["g.E().property('w', __.outV().values('name')).count()", N - 1, "g.E().has('w', 'n4242').inV().id()", 4243],
  ] as const) {
    test(q, () => {
      const store = graph(N);
      const { rows, ms, statements } = runRecorded(store, q);
      expect(rows.map((row) => row.v)).toEqual([traversers]);
      // The answer at scale, not only the speed: traverser 4242 got ITS OWN name or value.
      expect(run(store, check).map((row: any) => row.v)).toEqual([read]);
      expect(innerSnapshotScans(store, statements)).toEqual([]);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});
