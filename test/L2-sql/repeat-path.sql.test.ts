// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { STATIC } from '../../src/sql/kernel/render.ts';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { grouped, read, relirOff, run, runWith, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('repeat / path SQL', () => {
  test('dedup(labels): dedup by an as()-label tuple (optional by()), composes with path()', () => {
    const store = seededStore();
    // partition by the labels' current values; carried state (path/aliases) rides through.
    const sql = read('g.V().as("a").out().as("b").in().as("c").dedup("a","b").path().by("name")').sql;
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    // bare dedup(labels) partitions by element identity; by(key)/by(T) project each label.
    expect(read('g.V().as("a").both().as("b").dedup("a","b").by(T.label).select("a","b").by("name")').sql)
      .toContain('PARTITION BY');
    // dedup(a,b) keeps one traverser per distinct (a,b) pair.
    expect(run(store, 'g.V().as("a").out().as("b").in().as("c").dedup("a","b").count()').map((r) => r.v)).toEqual([6]);
    // dedup(labels).by(traversal) fails closed.
    expect(() => compile('g.V().as("a").both().as("b").dedup("a","b").by(__.out())', {})).toThrow('not yet supported');
  });

  test('repeat().times() → WITH RECURSIVE walk c1(id, depth); final depth only', () => {
    const p = read('g.V().repeat(__.out()).times(2).values("name")');
    expect(p.sql).toContain('with recursive');
    expect(p.sql).toContain('as (SELECT id, 0 AS depth FROM c0 UNION ALL SELECT e.tgt AS id, c1.depth + 1 AS depth FROM c1 JOIN edges e ON e.src=c1.id WHERE c1.depth < 2)');
    expect(p.sql).toContain('WHERE depth = 2');
  });

  test('emit position controls the projected depth band', () => {
    expect(read('g.V().repeat(__.out()).times(2).emit()').sql).toContain('WHERE depth >= 1'); // after → iterations
    expect(read('g.V().emit().repeat(__.out()).times(2)').sql).toContain('WHERE depth >= 0'); // before → + seed
    expect(read('g.V().repeat(__.out()).times(2)').sql).toContain('SUM(b) AS bulk');           // times only, single move → the bulk unroll (bounded frontier, no recursion)
  });

  test('emit(predicate) carries an emit column tested per row (same engine as until)', () => {
    // emit-after: the seed is never emitted (0 AS emit); each recursive row is tested.
    const after = read('g.V(1).repeat(__.out()).emit(__.has("name","josh"))');
    expect(after.sql).toContain('0 AS emit');                 // seed not emitted under emit-after
    expect(after.sql).toContain('AS emit FROM');              // recursive rows tested
    expect(after.sql).toContain('WHERE emit = 1');            // output = emitted rows
    expect(after.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties'); // has() predicate
    // emit-before: the seed source is aliased (w) so the predicate's correlated nodes
    // subquery references the seed id, not a self-match; loops() composes via .or().
    const before = read('g.V(1).emit(__.has("name","marko").or().loops().is(2)).repeat(__.out())');
    expect(before.sql).toContain('SELECT w.id AS id');        // seed aliased for the correlated test
    expect(before.sql).toContain('c1.depth + 1 = ?');         // loops() → depth compare
    expect(before.sql).toMatch(/\) OR \(/);                    // has() OR loops()
  });

  test('both() repeat emits two recursive terms', () => {
    // emit forces the recursive engine (a times-only single-move repeat now takes the bulk unroll);
    // both() expands to two directional recursive terms.
    const p = read('g.V().repeat(__.both()).times(2).emit()');
    expect(p.sql).toContain('e.tgt AS id, c1.depth + 1');
    expect(p.sql).toContain('e.src AS id, c1.depth + 1'); // both directions
  });

  test('bulk repeat stays tractable where enumerating every walk cannot', async () => {
    // K12 clique (66 edges, one per pair). repeat(both()).times(d) has ~22^d walks per start —
    // ~5e10 at depth 8 — which the recursive enumerate-every-walk path cannot materialize. The bulk
    // unroll keeps the frontier bounded by |V|, so a 2.5-billion-traverser count returns in ms.
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (let i = 0; i < 12; i++) executeQuery(store, "g.addV('n')", {});
    const ids = store.query<{ id: number }>('SELECT id FROM nodes').map((r) => r.id);
    for (const a of ids) for (const b of ids) if (a < b) store.query('INSERT INTO edges(src,label,tgt) VALUES (?,?,?)', [a, 0, b]);
    store.query('INSERT OR IGNORE INTO labels(id,name) VALUES (0,?)', ['n']);

    // times(4): recursive still finishes, so assert bulk == recursive (correctness).
    const r4 = read('g.V().repeat(__.both()).times(4).count()', { fastPaths: { bulkRepeatCount: false } });
    const b4 = read('g.V().repeat(__.both()).times(4).count()', { fastPaths: { bulkRepeatCount: true } });
    expect(Number(store.query<{ v: number }>(b4.sql, b4.binds)[0].v)).toBe(Number(store.query<{ v: number }>(r4.sql, r4.binds)[0].v));

    // times(8): only the bulk path can compute this — the exact total, in milliseconds.
    const [c8] =await decodeAll( executeQuery(store, 'g.V().repeat(__.both()).times(8).count()', {}));
    expect(c8).toBe(2572306572);
    // element form: a BOUNDED frontier — one framed vertex per reachable id (≤ |V|), not 2.5e9 rows —
    // whose multiplicities sum to the full traverser count (the wire ships this as RLE).
    const framed = await executeFramed(store, 'g.V().repeat(__.both()).times(8)', {});
    expect(framed.length).toBeLessThanOrEqual(12);
    expect(framed.reduce((s, f) => s + f.bulk, 0n)).toBe(2572306572n);

    // A flavour of the gap at a depth the recursive path still finishes (times(4) ≈ tens of ms):
    // the bulk unroll is orders of magnitude faster. Loose bound (real gap ~170×) so a busy CI box
    // never flakes; the numbers are logged for the record.
    const ms = (bulk: boolean) => {
      const p = read('g.V().repeat(__.both()).times(4).count()', { fastPaths: { bulkRepeatCount: bulk } });
      const t = performance.now(); store.query(p.sql, p.binds); return performance.now() - t;
    };
    const bulkMs = ms(true), recursiveMs = ms(false);
    console.log(`bulk repeat times(4) on K12: bulk ${bulkMs.toFixed(2)}ms vs recursive ${recursiveMs.toFixed(1)}ms (${(recursiveMs / bulkMs).toFixed(0)}×)`);
    expect(recursiveMs).toBeGreaterThan(bulkMs * 5);
  });

  test('bulk overflowing i64 fails loud (native, matches TinkerPop long bulk)', () => {
    // A traverser total past 2^63 must throw, not silently wrap or lose precision — the bulk column
    // stays an INTEGER end to end (a regression to REAL would compute a wrong finite number). K20
    // both().times(14) ≈ 38^14 ≈ 6e21 overflows; SQLite raises `integer overflow` mid-SUM.
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (let i = 0; i < 20; i++) executeQuery(store, "g.addV('n')", {});
    const ids = store.query<{ id: number }>('SELECT id FROM nodes').map((r) => r.id);
    for (const a of ids) for (const b of ids) if (a < b) store.query('INSERT INTO edges(src,label,tgt) VALUES (?,?,?)', [a, 0, b]);
    store.query('INSERT OR IGNORE INTO labels(id,name) VALUES (0,?)', ['n']);
    expect(() => executeQuery(store, 'g.V().repeat(__.both()).times(14).count()', {})).toThrow('integer overflow');
  });

  test('bulk repeat feeds groupCount()/sum/group().by(count()) — bounded where enumerating explodes', async () => {
    // Same K12 clique. A groupCount()/sum after repeat().times(8) has the same ~2.5e9-traverser
    // blow-up as count(); the bulk unroll re-enters generic lowering as a collapsed (id, bulk)
    // frontier, so the bulk-aware barrier (SUM(bulk) per key / SUM(v·bulk)) stays bounded by |V|.
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (let i = 0; i < 12; i++) executeQuery(store, "g.addV('n').property('w', 2)", {});
    const ids = store.query<{ id: number }>('SELECT id FROM nodes').map((r) => r.id);
    for (const a of ids) for (const b of ids) if (a < b) store.query('INSERT INTO edges(src,label,tgt) VALUES (?,?,?)', [a, 0, b]);

    // The compiled SQL must NOT recurse (the recursive term cannot host an aggregate) and must
    // carry the unrolled GROUP-BY-SUM frontier — proof it is the bulk path, not enumeration.
    for (const gq of [
      'g.V().repeat(__.both()).times(8).groupCount()',
      'g.V().repeat(__.both()).times(8).groupCount().by(T.label)',
      'g.V().repeat(__.both()).times(8).values("w").sum()',
      'g.V().repeat(__.both()).times(8).group().by(T.label).by(__.count())',
    ]) {
      const p = compile(gq, {}); if (p.kind !== 'read') throw new Error('read');
      expect(p.sql).not.toContain('recursive');
      expect(p.sql).toContain('SUM(b) AS bulk'); // the unrolled per-hop frontier collapse
    }

    // Correctness: groupCount() per vertex sums to the full traverser total (each of 12 ids gets
    // its multiplicity), and values('w').sum() = w·(total) with w=2. All computed in ms.
    const gc = Object.fromEntries(
      store.query<{ gk: any; gv: number }>(...(() => { const p = compile('g.V().repeat(__.both()).times(8).groupCount().by(T.id)', {}); if (p.kind !== 'read') throw new Error('read'); return [p.sql, p.binds] as const; })())
        .map((r) => [String(r.gk), Number(r.gv)]));
    const total = Object.values(gc).reduce((s, n) => s + n, 0);
    expect(total).toBe(2572306572);
    expect(Object.keys(gc).length).toBe(12); // one bounded key per reachable vertex, not 2.5e9 rows

    const [sum] =await decodeAll( executeQuery(store, 'g.V().repeat(__.both()).times(8).values("w").sum()', {}));
    expect(Number(sum)).toBe(2 * 2572306572);
  });

  test('P1.1 groupCount() weights by bulk; movementCollapse stays result-equivalent', () => {
    // Diamond: a→b, a→c, b→d, c→d. The two 2-hop walks a→b→d and a→c→d converge on d, so
    // groupCount() over a fan-out must count 2 for d — the case a per-key COUNT(*) gets wrong
    // once movement collapses convergent walks into (element, N) frontier rows.
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (let i = 0; i < 4; i++) executeQuery(store, "g.addV('n')", {});
    const [a, b, c, d] = store.query<{ id: number }>('SELECT id FROM nodes ORDER BY id').map((r) => r.id);
    store.query('INSERT OR IGNORE INTO labels(id,name) VALUES (0,?)', ['n']);
    for (const [s, t] of [[a, b], [a, c], [b, d], [c, d]]) store.query('INSERT INTO edges(src,label,tgt) VALUES (?,?,?)', [s, 0, t]);

    const gq = `g.V(${a}).out().out().groupCount().by(T.id)`;
    // Route-agnostic: `grouped` reads legacy's `(gk, gv)` rows and a RelIR map value alike, so this
    // asserts the WEIGHTING rather than which spine produced it.
    const asMap = (rows: any[]) => Object.fromEntries(Object.entries(grouped(rows)).map(([k, v]) => [k, Number(v)]));
    // Enabled (default) vs disabled movementCollapse are result-equivalent — the fast path's bar.
    expect(asMap(runWith(store, gq, { fastPaths: { movementCollapse: true } }))).toEqual({ [String(d)]: 2 });
    expect(asMap(runWith(store, gq, { fastPaths: { movementCollapse: false } }))).toEqual({ [String(d)]: 2 });

    // The enabled form actually collapses the frontier (SUM(bulk)) and weights the group by it;
    // the disabled form enumerates every walk (plain UNION ALL) but still emits the SUM(bulk)
    // weighting (≡ COUNT while bulk is 1). Both correct — one is bounded, one is not.
    const sqlOf = (opts: CompileOptions) => { const p = compile(gq, {}, opts); if (p.kind !== 'read') throw new Error('read'); return p.sql; };
    const on = sqlOf({ fastPaths: { movementCollapse: true } });
    const off = sqlOf({ fastPaths: { movementCollapse: false } });
    // Asserted as PROPERTIES rather than as either spine's spelling: both routes emit a frontier
    // collapse and a bulk-weighted count, with different aliases and different case.
    const collapses = (sql: string) => /sum\([^)]*bulk\)\s+AS\s+bulk/i.test(sql);
    const weighted = (sql: string) => /sum\([^)]*bulk\)\s+AS\s+gv/i.test(sql);
    expect(collapses(on)).toBe(true);        // convergent-walk frontier collapse
    expect(weighted(on)).toBe(true);         // bulk-weighted group count
    expect(collapses(off)).toBe(false);      // no collapse when disabled

    // With collapse OFF the two spines differ in SPELLING and agree in answer, which the two
    // `asMap` assertions above already prove. Legacy emits `SUM(bulk)` unconditionally; RelIR emits
    // `COUNT(*)`, because with no collapse every row IS one traverser and `bulked` says so — the same
    // number by a cheaper aggregate. Legacy's unconditional form stays pinned on its own spine, since
    // it is a property of that lowering and must hold until §8 deletes it.
    expect(weighted(sqlOf({ fastPaths: { movementCollapse: false }, spine: 'legacy' }))).toBe(true);

    // A by(traversal) KEY can map one traverser to many keys — a GROUP BY-id merge would
    // corrupt it, so that shape must NOT enable collapse (stays the enumerated path) even with
    // movement present. (The token/string/bare keys above DO collapse; see `on` asserting it.)
    const fanKey = compile("g.V().out().groupCount().by(__.values('name'))", {}, {});
    if (fanKey.kind !== 'read') throw new Error('read');
    expect(fanKey.sql).not.toContain('SUM(bulk) AS bulk');

    // Equivalence holds on a real fan-in graph too (modern: several starts converge on lop).
    for (const mg of ['g.V().out().groupCount().by(T.label)', 'g.V().both().both().groupCount().by(T.label)']) {
      const seeded = seededStore();
      expect(asMap(runWith(seeded, mg, { fastPaths: { movementCollapse: true } })))
        .toEqual(asMap(runWith(seeded, mg, { fastPaths: { movementCollapse: false } })));
    }
  });

  test('P1.2 a SCOPED reducer does NOT weight by bulk — a child answers per traverser', () => {
    // The other side of P1.1's axis. Both live in one column called `bulk`, and they mean opposite
    // things: P1.1 counts the TRAVERSERS in a group (weight by their multiplicity), while a child
    // body's reducer counts what ONE traverser produced. `pushChildScope` projects the parent's
    // carried schema into the child domain, so a collapsed parent row hands every child row the
    // PARENT's bulk — and the domain re-projects it onto the result row too, so weighting the
    // scoped aggregate applied it twice. Diamond with a tail: a→b, a→c, b→d, c→d, d→e, d→f. The
    // two 2-hop walks converge, so `V(a).out().out()` collapses to the single row (d, bulk=2),
    // and d has exactly 2 children (ages 5 and 6). Per traverser that is count 2 and sum 11 —
    // weighted it was 4 and 22, so every predicate below silently matched NOTHING as soon as the
    // outer chain collapsed (a movementCollapse equivalence violation on the DEFAULT config).
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const [n, age] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 6]] as [string, number][])
      executeQuery(store, `g.addV('n').property('name','${n}').property('age',${age})`, {});
    const ids = store.query<{ id: number }>('SELECT id FROM nodes ORDER BY id').map((r) => r.id);
    const [a, b, c, d] = ids;
    for (const [s, t] of [[a, b], [a, c], [b, d], [c, d], [d, ids[4]], [d, ids[5]]])
      store.query('INSERT INTO edges(src,label,tgt) VALUES (?,?,?)', [s, 0, t]);

    // Two switches decide WHICH lowering answers, so the pin has to hold across their product:
    // movementCollapse is what makes bulk exceed 1 at all, and predicateInlining OFF is what
    // routes the child body through the materialized child seam (the inline correlated predicate
    // is a separate lowering, and it was always unweighted — which is how the two disagreed).
    const total = (q: string, fastPaths: CompileOptions['fastPaths']) =>
      Number((runWith(store, q, { fastPaths })[0] as any).v);
    const everyLowering = (q: string, expected: number) => {
      for (const movementCollapse of [true, false])
        for (const inline of [true, false]) {
          const fastPaths = { movementCollapse, predicateInlining: inline, scalarPredicateInlining: inline };
          // The flags ride in the expectation so a failure names the combination that broke.
          expect({ movementCollapse, inline, v: total(q, fastPaths) })
            .toEqual({ movementCollapse, inline, v: expected });
        }
    };
    const surviving = (body: string) => `g.V(${a}).out().out().where(${body}).count()`;
    everyLowering(surviving("__.out().count().is(P.eq(2))"), 2);                  // element ROWS
    everyLowering(surviving("__.out().values('age').count().is(P.eq(2))"), 2);    // scalar rows
    everyLowering(surviving("__.out().values('age').sum().is(P.eq(11))"), 2);     // 5+6, not 22
    everyLowering(surviving("__.out().values('age').mean().is(P.eq(5.5))"), 2);   // uniform bulk cancels
    everyLowering(surviving("__.out().values('age').max().is(P.eq(6))"), 2);      // bulk-invariant
    // The weighted answers must now be rejected under every lowering — without this the pin
    // passes for a stream that merely stopped collapsing.
    everyLowering(surviving("__.out().count().is(P.eq(4))"), 0);
    everyLowering(surviving("__.out().values('age').sum().is(P.eq(22))"), 0);

    // Numeric reducers differ from count()/fold(): an empty child emits no traverser, so an
    // existence consumer must reject its parent. Check every reducer and both the inline and
    // materialized routes; the fast path may only accelerate the generic contract.
    const namesFor = (reducer: string, inline: boolean) =>
      runWith(seededStore(), `g.V().where(__.out().values('age').${reducer}()).values('name')`, {
        fastPaths: { predicateInlining: inline, scalarPredicateInlining: inline },
      }).map((r: any) => r.v).sort();
    for (const reducer of ['sum', 'min', 'max', 'mean']) {
      expect(namesFor(reducer, true)).toEqual(['marko']);
      expect(namesFor(reducer, false)).toEqual(['marko']);
    }

    // The rule as SQL shape, in BOTH directions — the same query collapses its frontier and
    // weights its GLOBAL count by that bulk, while the SCOPED reducer inside it does not.
    const off = { fastPaths: { movementCollapse: true, predicateInlining: false, scalarPredicateInlining: false } };
    const sumSql = read(surviving("__.out().values('age').sum().is(P.eq(11))"), off).sql;
    expect(sumSql).toContain('SUM(bulk) AS bulk');                                  // frontier collapsed
    expect(sumSql).toContain('COALESCE(SUM(s.bulk), 0) AS v');                      // GLOBAL count weights
    expect(sumSql).not.toContain('* s.bulk');                                       // scoped sum does not
    const cntSql = read(surviving('__.out().count().is(P.eq(2))'), off).sql;
    expect(cntSql).not.toContain('CASE WHEN s.encounter IS NOT NULL THEN s.bulk');  // scoped count does not
    // ONE aggregate for a scoped element-row count: the domain LEFT JOIN carries it, with no
    // `1 AS v` marker relation in front to satisfy a scalar reducer's contract.
    expect(cntSql).toContain('COUNT(c.id) AS v, d.bulk, d.o0, 1 AS encounter');
    expect(cntSql).toContain('HAVING COUNT(c.id) = ?');
    expect(cntSql).not.toContain('1 AS v');
  });

  test('repeat requires an exit modulator; emit()/until() run unbounded; sequential repeats chain', () => {
    // bare repeat() has no termination AND no output semantics → reject
    expect(() => compile('g.V().repeat(__.out())', {})).toThrow('repeat() requires times(), until(), or emit()');
    // unbounded emit() now compiles — no artificial depth cap; it terminates at the
    // natural fixpoint (frontier exhaustion) on an acyclic body.
    const em = read('g.V().repeat(__.out()).emit()');
    expect(em.sql).toContain('with recursive');
    expect(em.sql).not.toContain('depth <');       // no depth cap in the recursion
    expect(em.sql).toContain('WHERE depth >= 1');   // emit-after band
    // a barrier body step (order/dedup/limit/…) can't live in a recursive term → defers.
    expect(() => compile('g.V().repeat(__.out().order()).times(2)', {})).toThrow('not yet supported');
    // The named overload is normalized to the same body channel before lowering;
    // its counter namespace is deferred explicitly until named loops are modeled.
    expect(() => compile('g.V().repeat("a", __.out()).times(2)', {}))
      .toThrow('named-loop form not yet supported');
    // …and a cluster with NO repeat at all is invalid Gremlin, not a deferral — refused with
    // StandardVerificationStrategy's own wording (see test/compiler/by-modulator-arity).
    expect(() => compile('g.V().emit().times(2)', {})).toThrow('The repeat()-traversal was not defined');
    // a second repeat is NOT swallowed — it compiles as a chained cluster (two walks)
    const chained = read('g.V().repeat(__.out()).times(1).repeat(__.out()).times(1).values("name")');
    expect((chained.sql.match(/UNION ALL SELECT e\.tgt/g) || []).length).toBe(2); // two walk CTEs
  });

  test('repeat() body generality: movement + has(), multi-hop, both()-cartesian', () => {
    // bare single movement stays unchanged (alias `e`, no per-hop suffix).
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).toContain('JOIN edges e ON e.src=');
    // movement + has() → a correlated EXISTS filter on the hop's landing node.
    const f = read('g.V(1).repeat(__.out().has("lang","java")).times(2)');
    expect(f.sql).toContain('JOIN edges re1 ON re1.src=');
    expect(f.sql).toContain('EXISTS(SELECT 1 FROM vertex_properties'); // the has() filter
    // multi-hop body → a JOIN chain (two edges) in one recursive SELECT.
    expect(read('g.V(1).repeat(__.in().out()).times(2)').sql).toMatch(/JOIN edges re1 .* JOIN edges re2 /);
    // both() + has() → cartesian over both directions = 2 recursive SELECTs.
    const b = read('g.V().repeat(__.both().has("age",P.lt(30))).times(2)');
    expect((b.sql.match(/EXISTS\(SELECT 1 FROM vertex_properties/g) || []).length).toBe(2);
    // Barrier/collection body steps still defer — they cannot live in a recursive term. `dedup` is no
    // longer one of them: a fixed times(n) UNROLLS it into n ordinary phases (unrollFixedRepeat,
    // ir/strategies.ts), so the example here is a barrier that stays on the far side of that line.
    expect(() => compile('g.V().repeat(__.out().order()).times(2)', {})).toThrow('not yet supported');
    // …and the dedup body reaches SQL now, with no recursive term at all — n spliced phases.
    expect(read('g.V().repeat(__.out().dedup()).times(2)').sql).not.toContain('RECURSIVE');
    expect(() => compile('g.V().repeat(__.local(__.out())).times(2)', {})).toThrow('not yet supported');
    // multi-hop body + path() defers (intermediate positions lost).
    expect(() => compile('g.V(1).repeat(__.in().out()).times(2).path()', {})).toThrow('multi-hop repeat() body');
  });

  test('path() threads a per-position column through the movement fold', () => {
    const p = read('g.V(1).out().out().path()', { spine: 'legacy' });
    // V() seeds p0; each hop appends a new position holding the moved id, carrying
    // the earlier positions unchanged.
    expect(p.sql).toContain('SELECT id, 1 AS bulk, id AS p0 FROM nodes');
    expect(p.sql).toContain('SELECT e.tgt AS id, p.bulk, p.p0, e.tgt AS p1 FROM edges');
    expect(p.sql).toContain('SELECT e.tgt AS id, p.bulk, p.p0, p.p1, e.tgt AS p2 FROM edges');
    // Non-path queries stay unchanged (no p-columns).
    expect(read('g.V(1).out().out()').sql).not.toContain('p0');
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'element', elem: 'vertex', prefix: 'x0' },
      { render: 'element', elem: 'vertex', prefix: 'x1' },
      { render: 'element', elem: 'vertex', prefix: 'x2' },
    ] });
  });

  test('path() on the RelIR spine: one JSONB array channel, positions rebuilt as a typed tree', () => {
    if (!relirOff) {
      const p = read('g.V(1).out().out().path()');
      expect(p.shape).toEqual({ kind: 'jsonbPath', items: { kind: 'scalar', typed: true } });
      expect(p.sql).toContain('jsonb_insert(');
      expect(p.sql).toContain('json_each(');
      expect(p.sql).toContain('json_group_array(');
      expect(p.sql).not.toContain('AS p0');
    }
  });

  test('path().by(k1).by(k2) cycles modulators round-robin and drops on missing key', () => {
    // Three positions, two by()s → name, age, name (index % byCount).
    const p = read('g.V(1).out().out().path().by("name").by("age")');
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x0n.id AND key=? ORDER BY id LIMIT 1) AS x0_v");
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x1n.id AND key=? ORDER BY id LIMIT 1) AS x1_v");
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x2n.id AND key=? ORDER BY id LIMIT 1) AS x2_v");
    // Non-productive-by is a filter: every projected value must be present or the
    // whole path drops (TinkerPop default, no ProductiveByStrategy).
    expect(p.sql).toContain("(SELECT value FROM vertex_properties WHERE node=x0n.id AND key=? ORDER BY id LIMIT 1) is not null AND");
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }, { render: 'value', prefix: 'x2' },
    ] });
  });

  test('simplePath()/cyclicPath() compile to a static all-pairs identity test', () => {
    // Three same-kind positions → 3 pairs; simple keeps none-equal, cyclic keeps any-equal.
    const simple = read('g.V(1).out().in().simplePath()');
    expect(simple.sql).toContain('WHERE NOT (p.p0 = p.p1 OR p.p0 = p.p2 OR p.p1 = p.p2)');
    const cyclic = read('g.V(1).out().in().cyclicPath()');
    expect(cyclic.sql).toContain('WHERE (p.p0 = p.p1 OR p.p0 = p.p2 OR p.p1 = p.p2)');
  });

  test('P3 Stage A: path() is re-enterable — count()/is(typeOf(PATH))', () => {
    // count() over a linear path → COUNT(*) (one row per path)
    const c = read('g.V(1).out().out().path().count()');
    expect(c.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(c.sql).toContain('COUNT(*) AS v');
    // count() over a recursive (grouped) path → COUNT(DISTINCT pk), not exploded elements
    const rc = read('g.V(1).repeat(__.out()).times(2).path().count()');
    expect(rc.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(rc.sql).toContain('COUNT(DISTINCT');
    // is(typeOf(GType.PATH)) is identity — a path IS a Path, so the result stays a path
    const t = read('g.V(1).out().out().path().is(typeOf(GType.PATH))');
    expect(t.shape.kind).toBe('path');
    // still-deferred followers fail closed
    expect(() => compile('g.V(1).out().path().select(Column.keys)', {})).toThrow('not yet supported');
  });

  test('P3 Stage B: path().by(key) retypes into the list engine (set-ops/reverse/unfold/conjoin)', () => {
    // A homogeneous scalar path coerces to one list value per row, so the whole list-value
    // engine composes: combine/reverse → List, merge/difference/intersect/disjunct → Set,
    // conjoin → String, unfold → the exploded scalars.
    expect(read('g.V().out().out().path().by("name").reverse()').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    expect(read('g.V().out().out().path().by("name").combine(["x"])').shape).toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });
    expect(read('g.V().out().out().path().by("name").merge(["x"])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().out().out().path().by("name").difference(["x"])').shape).toEqual({ kind: 'jsonbSet' });
    expect(read('g.V().out().out().path().by("name").conjoin("-")').shape).toEqual({ kind: 'value', type: STATIC('string') });
    // the retype builds one JSON array per path row from the position value columns.
    expect(read('g.V().out().out().path().by("name").reverse()').sql).toContain('json_array');
    // an element-position path (no by(key)) is NOT list-representable → still fails closed.
    expect(() => compile('g.V(1).out().path().unfold()', {})).toThrow('not yet supported');
    expect(() => compile('g.V(1).out().path().reverse()', {})).toThrow('not yet supported');
  });

  test('path().from(l)/to(l): scope positions to the static label range', () => {
    // from("b").to("c") slices to positions [1..2] (b bound at hop 1, c at hop 2) — the
    // path keeps only those two positions, framed by(name).
    const ft = read('g.V().as("a").out().as("b").out().as("c").path().from("b").to("c").by("name")');
    expect(ft.shape).toEqual({ kind: 'path', positions: [
      { render: 'value', prefix: 'x0' },
      { render: 'value', prefix: 'x1' },
    ] });
    // from() only → [1..end]; to() only → [0..that label].
    expect((read('g.V().as("a").out().as("b").out().as("c").path().from("b")').shape as any).positions).toHaveLength(2);
    expect((read('g.V().as("a").out().as("b").out().as("c").path().to("b")').shape as any).positions).toHaveLength(2);
    // simplePath().from()/to() scopes the distinctness pair-loop (folds onto simplePath).
    expect(read('g.V().both().as("a").both().as("b").simplePath().path().by("name").from("a").to("b")').shape.kind).toBe('path');
    // an unbound from/to label fails closed.
    expect(() => compile('g.V().as("a").out().path().from("z")', {})).toThrow('not bound to a path position');
    // from()/to() over a recursive repeat().path() fails closed (a recursive path has no
    // static per-position labels — here the as()-before-repeat deferral trips first).
    expect(() => compile('g.V().as("a").repeat(__.out()).times(2).path().from("a")', {})).toThrow('not yet supported');
  });

  test('path().by(T.token) and path().by(__.traversal): per-position scalar', () => {
    // by(T.label)/by(T.id) project the token inline; both are value positions.
    const lbl = read('g.V().out().path().by(T.label)');
    expect(lbl.shape).toEqual({ kind: 'path', positions: [{ render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }] });
    expect(read('g.V(1).out().path().by(T.id)').sql).toContain('COALESCE');
    // by(__.trav) positions lower through the generic scalar child seam (pushChildScope +
    // tryCompileScalarValueChild), re-rooted per position — the same seam select/dedup/order use.
    // by(__.values(k).transform): a value+transform chain.
    expect(read('g.V().out().out().path().by(__.values("name").toUpper())').sql.toLowerCase()).toContain('upper(');
    // by(__.<movement>.count()): a per-position scalar child → one value column per position.
    const cnt = read('g.V().out().path().by(__.out().count())');
    expect(cnt.shape).toEqual({ kind: 'path', positions: [{ render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }] });
    // by(__.choose(...))/by(__.coalesce(...)): a bare 1-to-1 branch at the position lowers
    // through the element-parent scalar-branch compilers (one value per position, no first-
    // collapse needed). Both stay value positions.
    expect(read('g.V().out().path().by(__.choose(__.hasLabel("person"), __.constant("P"), __.constant("S")))').shape)
      .toEqual({ kind: 'path', positions: [{ render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }] });
    expect(read('g.V().out().path().by(__.coalesce(__.values("lang"), __.constant("none")))').shape)
      .toEqual({ kind: 'path', positions: [{ render: 'value', prefix: 'x0' }, { render: 'value', prefix: 'x1' }] });
    // a by(traversal) shape the scalar child seam can't classify (a bare group barrier) fails closed.
    expect(() => compile('g.V().out().path().by(__.groupCount())', {})).toThrow('path().by(traversal)');
    // union() at a position FANS OUT (N values); a position holds one → fail closed (take-first
    // needs an emission order, the same locked non-goal as map() over a fan-out arm).
    expect(() => compile('g.V().out().path().by(__.union(__.values("name"), __.constant("x")))', {})).toThrow('fans out');
    // a choose()/coalesce() ARM that fans out (movement/re-source) would multiply the path row
    // (the branch route has no first-collapse) → fail closed, same non-goal.
    expect(() => compile('g.V().out().path().by(__.coalesce(__.out().values("name"), __.constant("x")))', {})).toThrow('fans out');
    expect(() => compile('g.V().out().path().by(__.choose(__.hasLabel("person"), __.out().values("name"), __.constant("x")))', {})).toThrow('fans out');
    // a movement/filter PREFIX before the branch would make it multi-valued per position without
    // the value seam's first-collapse → deferred (not mis-executed).
    expect(() => compile('g.V().out().path().by(__.out().choose(__.hasLabel("person"), __.constant("P"), __.constant("S")))', {})).toThrow('path().by(traversal)');
  });

  test('path() interleaves edge and vertex positions with the right element shape', () => {
    const p = read('g.V(1).outE("created").inV().path()', { spine: 'legacy' });
    // edge position frames endpoints as external ids (COALESCE(uid,id)), not raw rowid
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=x1n.src) AS x1_src, (SELECT COALESCE(uid, id) FROM nodes WHERE id=x1n.tgt) AS x1_tgt');
    expect(p.shape).toEqual({ kind: 'path', positions: [
      { render: 'element', elem: 'vertex', prefix: 'x0' },
      { render: 'element', elem: 'edge', prefix: 'x1' },
      { render: 'element', elem: 'vertex', prefix: 'x2' },
    ] });
  });

  test('path() through a branch (pad-to-max cols): threads + pads, remaining forms defer', () => {
    // path now threads through the UNION-ALL branch ops (carried-schema + padding).
    expect(read('g.V(1).union(__.out(), __.in()).path()', { spine: 'legacy' }).shape.kind).toBe('path');
    expect(read('g.V(1).coalesce(__.out(), __.in()).path()', { spine: 'legacy' }).shape.kind).toBe('path');
    expect(read('g.V(1).optional(__.out()).path()', { spine: 'legacy' }).shape.kind).toBe('path');
    expect(read('g.V(1).choose(__.has("name","x"), __.out(), __.in()).path()', { spine: 'legacy' }).shape.kind).toBe('path');
    // ragged arms: the shorter arm's trailing position is NULL-padded + LEFT JOINed.
    const r = read('g.V(1).union(__.out(), __.out().out()).path()', { spine: 'legacy' });
    expect(r.sql).toContain('NULL AS p2');
    expect(r.sql).toContain('LEFT JOIN');
    // A union() SOURCE tracks the path too: each rooted arm seeds its own p0 and the merge pads
    // the shorter arm, so a short-arm path is genuinely shorter (not a dropped row).
    const s = read('g.union(__.V().out().out(), __.V().hasLabel("software")).path()', { spine: 'legacy' });
    expect(s.sql).toContain('NULL AS p1');
    expect((s.shape as any).positions).toHaveLength(3);
    // by() over a PADDED position: the value column NULLs both when the position is absent and
    // when its property is missing, so an optional position carries a presence column (`_at`)
    // and only a present-but-missing value drops the whole path.
    const b = read('g.V(1).union(__.out(), __.out().out()).path().by("name")', { spine: 'legacy' });
    expect(b.sql).toContain('AS x2_at');
    expect(b.sql).toContain('p.p2 IS NULL OR');
    expect((b.shape as any).positions[2]).toEqual({ render: 'value', prefix: 'x2', optional: true });
    expect((b.shape as any).positions[0]).toEqual({ render: 'value', prefix: 'x0' }); // p0 is never padded
    // ---- still fail-closed ----
    // conflicting element kinds at one position (edge vs vertex) → deferred (needs tagged array).
    expect(() => compile('g.V(1).union(__.outE().inV(), __.out()).path()', {}, { spine: 'legacy' })).toThrow('conflicting element kinds');
    // unchanged deferrals
    expect(() => compile('g.V(1).out().dedup().path()', {}, { spine: 'legacy' })).toThrow('dedup() with path tracking not yet supported');
    // by(__.values(k))/by(T.id) now compile to a per-position scalar; only an unrenderable
    // by(traversal) shape defers.
    expect(read('g.V(1).out().path().by(__.values("name"))', { spine: 'legacy' }).shape.kind).toBe('path');
    expect(read('g.V(1).out().path().by(T.id)', { spine: 'legacy' }).shape.kind).toBe('path');
    expect(() => compile('g.V(1).out().path().by(__.groupCount())', {}, { spine: 'legacy' })).toThrow('path().by(traversal)');
    expect(() => compile('g.V(1).out().path().order()', {}, { spine: 'legacy' })).toThrow('order() on a path value not yet supported');
  });

  test('repeat().path() accumulates a JSONB array through the WITH RECURSIVE walk', () => {
    const p = read('g.V(1).repeat(__.out()).times(2).path()');
    expect(p.sql).toContain('jsonb_array(id) AS path');                  // seed
    expect(p.sql).toContain("jsonb_insert(c1.path, '$[#]', e.tgt) AS path"); // append per hop
    expect(p.sql).toContain('json_each(pp.path) je JOIN nodes n ON n.id=je.value'); // explode + materialize
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex' });
  });

  test('recursive path().by(key) projects each position to a scalar (not the whole element)', () => {
    const p = read('g.V(1).repeat(__.out()).times(2).path().by("name")');
    // each exploded position is the property scalar `v`, correlated on je.value
    expect(p.sql).toContain('AS v FROM');
    expect(p.sql).toContain('SELECT value FROM vertex_properties WHERE node=je.value AND key=?');
    // no whole-element framing (no nodes/labels join for the position)
    expect(p.sql).not.toContain('json_each(pp.path) je JOIN nodes n');
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex', byKey: true });
    // a non-productive by(key) drops the whole path if any element lacks the property
    expect(p.sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM json_each');
  });

  test('simplePath() inside repeat() folds into the recursive cycle guard', () => {
    const p = read('g.V().repeat(__.both().simplePath()).times(3).path()');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path) je WHERE je.value=e.tgt)');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path) je WHERE je.value=e.src)'); // both directions
  });

  test('simplePath() in the body works without path() output — array is internal to the walk', () => {
    const p = read('g.V().repeat(__.both().simplePath()).times(3)');
    expect(p.sql).toContain('NOT EXISTS (SELECT 1 FROM json_each(c1.path)'); // guard present
    expect(p.shape).toEqual({ kind: 'vertex' });                            // but output is plain vertices
  });

  test('a non-path repeat() has unchanged SQL (no JSONB path column added)', () => {
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).not.toContain('path');
  });

  test('recursive path() defers mixed/edge/emit forms with clear errors', () => {
    expect(() => compile('g.V(1).out().repeat(__.out()).times(2).path()', {})).toThrow('path() spanning more than one repeat()/movement is not yet supported');
    // an edge-step body now COMPILES; only path()/simplePath() OVER it is deferred (edge-aware path regime).
    expect(() => compile('g.V().repeat(__.outE().inV()).times(2).path()', {})).toThrow('edge steps (outE()/inV()) in a repeat() body not yet supported');
    expect(() => compile('g.V().repeat(__.out()).emit().times(2).path()', {})).toThrow('emit() with path() not yet supported');
    // A SECOND repeat cluster after an array-tracked path() would reseed the walk and
    // silently drop the first walk's segment — fail closed instead.
    expect(() => compile('g.V(1).repeat(__.out()).times(1).repeat(__.out()).times(1).path()', {})).toThrow('path() spanning more than one repeat()/movement is not yet supported');
  });

  test('dedup() after a recursive path() distinct-ifies BEFORE row-numbering (ROW_NUMBER would defeat DISTINCT)', () => {
    const p = read('g.V(1).repeat(__.both()).times(1).path().dedup()');
    // DISTINCT must be in its own CTE over the raw path, not the same SELECT as ROW_NUMBER().
    expect(p.sql).toContain('SELECT DISTINCT');
    expect(p.sql.replace(/\s+/g, ' ')).not.toMatch(/DISTINCT[^)]*ROW_NUMBER/);
  });

  test('until() compiles a `done` column: expand from done=0, output done=1', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.has("name","ripple"))');
    expect(p.sql).toContain('AS done');
    expect(p.sql).toContain('c1.done=0');           // expand only from still-looping rows
    expect(p.sql).toContain('WHERE done = 1');       // output satisfied rows
    expect(p.sql).not.toContain('depth <');          // no artificial depth cap — runs to fixpoint
  });

  test('until(loops().is(n)) tests the depth counter, not an element', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.loops().is(2))');
    expect(p.sql).toContain('c1.depth + 1 = ?');     // done = (new depth) = 2
  });

  test('until() composes loops() with an element predicate via the shared infix machinery', () => {
    // loops() lowers as a leaf (ctx.loopsExpr = the walk depth), so it combines with a
    // has() through the SAME .or()/.and() split as where() — no bespoke until parser.
    const orp = read("g.V(1).repeat(__.both().simplePath()).until(__.has('name','peter').or().loops().is(3)).has('name','peter').path().by('name')");
    expect(orp.sql).toContain('c1.depth + 1 = ?');                 // loops() → depth compare
    expect(orp.sql).toContain('vertex_properties');                // has() → property EXISTS
    expect(orp.sql).toMatch(/EXISTS\([^)]*vertex_properties[^)]*\)\) OR \(/); // combined by OR
    const andp = read("g.V(1).repeat(__.both().simplePath()).until(__.has('name','peter').and().loops().is(3)).path().by('name')");
    expect(andp.sql).toContain(') AND (');
  });

  test('while-do (until before repeat) qualifies the seed id in the correlated predicate', () => {
    const p = read('g.V(3).until(__.has("name","lop")).repeat(__.out())');
    // seed source aliased `w` so until()'s correlated predicate references the seed as
    // `node=w.id`, not the `node=id` self-match that would read the wrong row.
    expect(p.sql).toContain('node=w.id');
    expect(p.sql).not.toContain('node=id ');
  });

  test('until().path() carries both the JSONB path array and the done column', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.has("name","ripple")).path()');
    expect(p.sql).toContain('jsonb_insert');
    expect(p.sql).toContain('AS done');
    expect(p.shape).toEqual({ kind: 'pathGrouped', elem: 'vertex' });
  });

  test('until(__.out()) correlates the EXISTS on the walk row via the FROM boundary', () => {
    // until() has no generic (materialized) fallback — a CTE cannot reference the
    // recursive term's outer row — so it correlates through the SAME inline movement
    // child as where()/choose(). The walk aliases its edges `e`; the child's own movement
    // also aliases `edges e`, but the seed `(SELECT e.tgt AS id)` is a FROM-clause derived
    // table so the child's `e` is NOT laterally visible to it — the seed's `e.tgt` binds
    // to the WALK's `e` through the WHERE-clause EXISTS boundary. No self-shadow, no xe.
    const p = read('g.V(1).repeat(__.out()).until(__.out())');
    expect(p.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT e.tgt AS id) p ON e.src=p.id) c)');
  });

  test('until() defers the combinations not yet built', () => {
    expect(() => compile('g.V(1).repeat(__.out()).until(__.has("name","x")).times(3)', {})).toThrow('until() together with times() not yet supported');
    expect(() => compile('g.V(1).repeat(__.out()).emit().until(__.has("name","x"))', {})).toThrow('until() together with emit() not yet supported');
    expect(() => compile('g.V(1).repeat(__.out())', {})).toThrow('repeat() requires times(), until(), or emit()');
  });

  // ---------- sack folded through the recursive walk (foldable carried column) ----------

  test('sack(op).by() in a repeat body carries + folds a sk column through the walk', () => {
    // movement-free accumulate + a sack-reading where guard (TinkerPop Repeat.feature:664).
    const p = read('g.withSack(0L).V().repeat(__.sack(sum).by("age").where(__.sack().is(lt(59)))).times(2)');
    // the recursive CTE declares `sk`, seeds it from the outer sack, folds per iteration…
    expect(p.sql).toContain(', sk, bulk)'); // walk output carries sk before bulk (layoutCols order)
    expect(p.sql).toContain('AS sk FROM c0'); // base term seeds sk from the source sack col
    expect(p.sql).toMatch(/\(c\d+\.sk \+ \(SELECT value FROM vertex_properties/); // fold: prev.sk + by('age')
    // …and the where(__.sack().is(lt(59))) guard reads the freshly-folded sack in the term.
    expect(p.sql).toMatch(/\(c\d+\.sk \+ \(SELECT value FROM vertex_properties WHERE node=c\d+\.id AND key=\? ORDER BY id LIMIT 1\)\) < \?/);
  });

  test('sack(mult).by(constant) folds a per-hop decay factor across a movement walk', () => {
    // spreading-activation decay: relevance × factor per hop — the agent-memory primitive.
    const p = read('g.withSack(1.0d).V(1).repeat(__.out().sack(mult).by(__.constant(0.5d))).times(2).sack()');
    expect(p.sql).toMatch(/\(c\d+\.sk \* CAST\(\? AS REAL\)\) AS sk/); // fold on the walked edge's target
    expect(p.sql).toContain('re1.tgt AS id'); // movement + sack fold in ONE flat recursive term
  });

  test('bare movement repeat (no sack) is unchanged — no sk column threaded', () => {
    const p = read('g.V(1).repeat(__.out()).times(2)');
    expect(p.sql).not.toContain('AS sk');
  });

  test('repeat body sack defers a fan-out by(traversal) with a clear throw', () => {
    expect(() => compile('g.withSack(0L).V().repeat(__.sack(sum).by(__.out().values("age"))).times(2)', {}))
      .toThrow('sack().by(traversal) in a repeat() body not yet supported');
  });

  test('edge-step body outE().sack(op).by(edgeKey).inV() folds the EDGE property along the walk', () => {
    // path-weight accumulation: pause ON the edge to read its weight, then land back on the vertex.
    const p = read("g.withSack(0.0d).V(1).repeat(__.outE().sack(sum).by('weight').inV()).times(2).sack()");
    expect(p.sql).toMatch(/\(c\d+\.sk \+ \(SELECT value FROM edge_properties WHERE edge=re\d+\.id AND key=\?\)\)/); // reads edge_properties, not vertex
    expect(p.sql).toContain('re1.tgt AS id'); // inV() lands back on the edge's target vertex
  });

  test('a repeat() body left ON an edge (no closing inV()) is rejected', () => {
    expect(() => compile("g.withSack(0.0d).V(1).repeat(__.outE().sack(sum).by('weight')).times(2)", {}))
      .toThrow('a repeat() body must end on a vertex');
  });

  test('until(__.sack().is(P)) reads the accumulated sack in the done column', () => {
    const p = read("g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).until(__.sack().is(gte(50))).sack()");
    // the done column tests the freshly-folded sack against the predicate.
    expect(p.sql).toMatch(/CASE WHEN \(c\d+\.sk \+ \(SELECT value FROM vertex_properties[^)]*\)\) >= \? THEN 1 ELSE 0 END AS done/);
  });

  test('a body-terminal aggregate() collects the walk rows (depth ≥ 1) into a bag CTE', () => {
    const p = read("g.V(1).repeat(__.out().aggregate('x')).times(2).cap('x')");
    // the aggregate bag is a post-walk jsonb list sourced from the walk's non-seed rows.
    expect(p.sql).toContain('AS m FROM');
    expect(p.sql).toContain('WHERE w.depth >= 1');
    // local(__.aggregate('x')) folds the same way (local scopes the side-effect per traverser).
    expect(read("g.V(1).repeat(__.out().local(__.aggregate('x'))).times(2).cap('x')").sql).toContain('WHERE w.depth >= 1');
  });

  test('a pre-repeat aggregate bag is multiset-unioned with the in-repeat rows (BulkSet)', () => {
    const p = read("g.V().local(__.aggregate('a')).repeat(__.out().local(__.aggregate('a'))).times(2).cap('a')");
    expect(p.sql).toContain('json_each'); // prior bag's members unioned first
    expect(p.sql).toContain('UNION ALL SELECT'); // then the walk's depth≥1 rows
  });
});
