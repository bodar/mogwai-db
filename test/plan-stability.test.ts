import { describe, expect, test } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { loadBulk, type BulkEdge, type BulkVertex } from '../src/bulk.ts';
import { read } from './support/harness.ts';
import { accessPaths } from './support/sql-core.ts';

// Plan STABILITY — the regression guard for the join-order fence (`Join.ordered`) and the source
// seek (`src/rel/passes/semijoin.ts`, `indexSeek` / `propertySeek`). RelIR plan §1 P4 records why they exist: DO SQLite
// gathers statistics but cannot BOUND `ANALYZE`, so the lowering pins the access path at compile time
// from what the traversal already states, and a filtered lookup must reach the SAME plan with and
// without `sqlite_stat1`. A plan only correct after `ANALYZE` is a plan wrong on every young graph —
// and on the runtime we ship to, that is every graph on its first requests. Left unguarded, a change
// that weakens the fence or the seek makes the plan lean on the planner's cardinality guess again,
// and the 9.8 s → 19 ms cliff comes back silently.
//
// Why the fixture must be big: on the 6-vertex modern graph the bad plan and the good plan both cost
// nothing and pick the same access path, so the divergence is invisible. A few thousand vertices is
// where the planner forms an opinion — bulk-loaded, so it is milliseconds to build.

const N = 2_000; // 2000 person + 2000 software = 4000 vertices, 10000 edges

function* vertices(): Iterable<BulkVertex> {
  for (let i = 1; i <= N; i++) yield { id: i, labels: ['person'], properties: [{ key: 'name', value: `p${i}` }] };
  for (let i = 1; i <= N; i++) yield { id: N + i, labels: ['software'], properties: [{ key: 'name', value: `s${i}` }, { key: 'lang', value: 'java' }] };
  // A few USER-SUPPLIED string ids (the `uid` column) — what `V('u0')`/`E('e0')` seek on.
  for (let i = 0; i < 10; i++) yield { id: `u${i}`, labels: ['tagged'] };
}

function* edges(): Iterable<BulkEdge> {
  for (let i = 1; i <= N; i++) {
    for (let k = 1; k <= 4; k++) yield { label: 'knows', src: i, tgt: ((i + k - 1) % N) + 1 };
    yield { label: 'created', src: i, tgt: N + (((i - 1) % N) + 1) };
  }
  for (let i = 0; i < 10; i++) yield { id: `e${i}`, label: 'tags', src: `u${i}`, tgt: i + 1 };
}

function build(analyze: boolean): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  loadBulk(store, vertices(), edges());
  if (analyze) store.query('ANALYZE'); // populate sqlite_stat1 — the "warm graph" the young graph must match
  return store;
}

// Two SEPARATE connections rather than one ANALYZE'd in place: bun:sqlite caches a prepared statement
// by its SQL text, so re-running `EXPLAIN QUERY PLAN <sql>` on the same store after ANALYZE could
// return the plan cached from before it and make the comparison pass falsely.
const noStats = build(false);
const withStats = build(true);

// The access into the O(graph) tables: the property-index seeks (`vp_key_value`, `vp_node_key`) and
// the edge-index seeks (`e_out`, `e_in`). This is where a wrong plan is the 516× cliff, and it is
// what the fence and seek pin. Deliberately EXCLUDES the label/type tables: `labels` and
// `vertex_labels` are O(distinct labels), so ANALYZE legitimately switches a low-selectivity label
// filter (`hasLabel('person')` matches half the graph) from an index search to a table scan — a
// correct, harmless choice, and exactly the kind of blessed-single-path churn RelIR plan §5 warns a
// gate must not assert. Filtering to the graph-sized seeks is what keeps this gate meaningful and
// non-flaky at once.
const bigTablePaths = (paths: readonly string[]): readonly string[] =>
  paths.filter((p) => /\b(?:vp_key_value|vp_node_key|e_out|e_in)\b/.test(p));

const SHAPES: Readonly<Record<string, string>> = {
  'point lookup': "g.V().has('person','name','p1000')",
  '1-hop': "g.V().has('person','name','p1000').out('knows').values('name')",
  'long chain': "g.V().has('person','name','p1000').out('knows').out('knows').values('name')",
  'label scan': "g.V().hasLabel('software')",
  'ordered page': "g.V().hasLabel('person').order().by('name').limit(10).values('name')",
};

// The FILTERED shapes carry a selective `has(k,v)` at the source — the case the seek is for.
const FILTERED = new Set(['point lookup', '1-hop', 'long chain']);

describe('query-plan stability', () => {
  for (const [name, gremlin] of Object.entries(SHAPES)) {
    const { sql, binds } = read(gremlin);
    const cold = bigTablePaths(accessPaths(noStats, sql, binds));
    const warm = bigTablePaths(accessPaths(withStats, sql, binds));

    test(`${name}: graph-sized access path is the same with and without stats`, () => {
      // "Plan-stable by construction": a cold graph (no sqlite_stat1) reaches the big tables exactly
      // as a warm one (ANALYZE'd) does. This is stronger and cheaper than a table of blessed paths —
      // no single expected plan to go stale — and it fails on precisely the defect §1 P4 describes.
      expect(cold).toEqual(warm);
    });

    if (FILTERED.has(name)) {
      test(`${name}: the source seek fired (drives the property index)`, () => {
        // `vp_key_value` is present only because the seek lifted the `has()` into a driven join;
        // verified against the switch — turning `propertySeek` off removes it, so this has teeth.
        expect(cold.some((p) => p.includes('vp_key_value'))).toBe(true);
      });
    }
  }
});

// ID ROUTING — every id question (`V(ids)`, `E(ids)`, `hasId`, `has(T.id, …)`) is ONE authority
// (`idMembership`, `src/compiler/rel/source.ts`), and its point is that each becomes a rowid or
// `uid`-UNIQUE SEEK. The `COALESCE(uid, id)` comparison it replaced could only be checked per row, so
// `hasId(within(1,2,3))` scanned the graph. Asserted over EVERY access, not just the big tables, because
// the id lookup into `nodes`/`edges` is exactly the access path at stake.
//
// The pin is "a SEEK with and without stats", deliberately not plan identity: `uid IS NULL AND id IN (…)`
// is served cold by the covering `(uid, rowid)` autoindex and warm by the rowid itself — two exact seeks
// of the same cost, and the kind of blessed-single-path churn RelIR plan §5 warns a gate must not
// assert. What a young graph must never get is a SCAN, and that is what fails here.
const ID_SEEKS: Readonly<Record<string, string>> = {
  'V(uid)': "g.V('u0').id()",
  'E(uid)': "g.E('e0').id()",
  'hasId(within)': 'g.V().hasId(within(1,2,3)).count()',
  'has(T.id, gt)': 'g.V().has(T.id, gt(3990)).count()',
};

describe('id routing: every id question is a seek', () => {
  const scans = (paths: readonly string[]) => paths.filter((p) => !p.startsWith('SEARCH') && !p.startsWith('USE TEMP B-TREE'));
  for (const [name, gremlin] of Object.entries(ID_SEEKS)) {
    const { sql, binds } = read(gremlin);
    test(`${name}: every access is a SEARCH (rowid / uid seek), cold and warm`, () => {
      for (const store of [noStats, withStats]) {
        const paths = accessPaths(store, sql, binds);
        expect(paths.length).toBeGreaterThan(0);
        expect(scans(paths)).toEqual([]);
      }
    });
  }
  test('a hasId AFTER a hop adds no scan — its membership is an uncorrelated seek, not a per-row EXISTS', () => {
    const hop = read("g.V().out('knows').count()");
    const filtered = read("g.V().out('knows').hasId(within(1,2,3)).count()");
    for (const store of [noStats, withStats]) {
      expect(scans(accessPaths(store, filtered.sql, filtered.binds))).toEqual(scans(accessPaths(store, hop.sql, hop.binds)));
    }
  });
});

