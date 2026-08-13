// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { TYPED_MEMBERS } from '../../src/sql/kernel/render.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { grouped, read, run, seededStore } from '../support/harness.ts';
import { detail } from '../support/output.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('repeat / path SQL', () => {



  test('emit(predicate) carries an emit column tested per row (same engine as until)', () => {
    // emit-after: the seed is never emitted; each recursive row is tested. The RelIR walk claims
    // this one, and the two spines say it differently — legacy carries a materialized `emit` column,
    // RelIR filters the walk on its `loops` channel — so the assertions follow the route rather than
    // pinning the spelling of a route this query no longer takes.
    const after = read('g.V(1).repeat(__.out()).emit(__.has("name","josh"))');
          expect(after.sql).toMatch(/w\d+\.lp0 > 0/);             // seed not emitted under emit-after
      expect(after.sql).toMatch(/EXISTS \(SELECT 1 AS one FROM vertex_properties/); // has() predicate
    
    // emit-before with a COMPOSITE predicate: a correlated property test OR a per-traverser state
    // read. Both spines combine them through their ordinary infix machinery — no bespoke until/emit
    // parser — so the assertion is the OR, and each spine spells its own two operands.
    const before = read('g.V(1).emit(__.has("name","marko").or().loops().is(2)).repeat(__.out())');
    expect(before.sql).toMatch(/\) OR \(/);                    // has() OR loops()
          expect(before.sql).toMatch(/EXISTS \(SELECT 1 AS one FROM vertex_properties/);
      expect(before.sql).toMatch(/w\d+\.lp0 = 2/);             // loops() → the carried `loops` channel
    
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

    // times(4): the collapsed frontier must answer what enumerating every walk answers. The oracle
    // used to be the deleted `bulkRepeatCount` fast path; it is now `movementCollapse`, which is the
    // same claim — an RLE frontier against the plain UNION-ALL movement.
    const r4 = read('g.V().repeat(__.both()).times(4).count()', { fastPaths: { movementCollapse: false } });
    const b4 = read('g.V().repeat(__.both()).times(4).count()', { fastPaths: { movementCollapse: true } });
    expect(Number(store.query<{ v: number }>(b4.sql, b4.binds)[0].v)).toBe(Number(store.query<{ v: number }>(r4.sql, r4.binds)[0].v));

    // times(8): only the bulk path can compute this — the exact total, in milliseconds.
    const [c8] =await decodeAll( executeQuery(store, 'g.V().repeat(__.both()).times(8).count()', {}));
    expect(c8).toBe(2572306572);
    // element form: a BOUNDED frontier — one framed vertex per reachable id (≤ |V|), not 2.5e9 rows —
    // whose multiplicities sum to the full traverser count (the wire ships this as RLE).
    const framed = await executeFramed(store, 'g.V().repeat(__.both()).times(8)', {});
    expect(framed.length).toBeLessThanOrEqual(12);
    expect(framed.reduce((s, f) => s + f.bulk, 0n)).toBe(2572306572n);

    // Collapse is now structural rather than controlled by bulkRepeatCount: bounded repeats splice
    // above the switch and every phase collapses through the ordinary movement machinery.
    const collapsed = read('g.V().repeat(__.both()).times(4).count()');
    expect(collapsed.sql).not.toContain('recursive');
    expect((collapsed.sql.match(/sum\([^)]*bulk\) AS bulk/gi) ?? []).length).toBe(4);
    detail(() => 'bulk repeat times(4) on K12: 4 per-hop collapses, no recursive term');
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
      expect(p.sql).toMatch(/sum\([a-z0-9_.]*bulk\) AS bulk/i); // per-hop frontier collapse
      expect(p.sql.toUpperCase()).toContain('GROUP BY');
    }

    // Correctness: groupCount() per vertex sums to the full traverser total (each of 12 ids gets
    // its multiplicity), and values('w').sum() = w·(total) with w=2. All computed in ms.
    // `grouped` reads legacy's `(gk, gv)` rows and RelIR's framed Map through one public-result view.
    const gc = Object.fromEntries(Object.entries(
      grouped(run(store, 'g.V().repeat(__.both()).times(8).groupCount().by(T.id)')),
    ).map(([k, v]) => [k, Number(v)]));
    const total = Object.values(gc).reduce((s, n) => s + n, 0);
    expect(total).toBe(2572306572);
    expect(Object.keys(gc).length).toBe(12); // one bounded key per reachable vertex, not 2.5e9 rows

    const [sum] =await decodeAll( executeQuery(store, 'g.V().repeat(__.both()).times(8).values("w").sum()', {}));
    expect(Number(sum)).toBe(2 * 2572306572);
  });






  test('path() on the RelIR spine: one JSONB array channel, positions rebuilt as a typed tree', () => {
          const p = read('g.V(1).out().out().path()');
      expect(p.shape).toEqual({ kind: 'jsonbPath', items: TYPED_MEMBERS });
      expect(p.sql).toContain('jsonb_insert(');
      expect(p.sql).toContain('json_each(');
      expect(p.sql).toContain('json_group_array(');
      expect(p.sql).not.toContain('AS p0');
    
  });













  test('a non-path repeat() has unchanged SQL (no JSONB path column added)', () => {
    expect(read('g.V(1).repeat(__.out()).times(2)').sql).not.toContain('path');
  });



  test('until(predicate) carries loops and guards the recursive frontier with the shared predicate', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.has("name","ripple"))');
    expect(p.kind).toBe('read');
    expect(p.sql).toMatch(/WITH RECURSIVE wk_w\d+\(id, lp0, bulk\)/);
    expect(p.sql).toMatch(/w\d+\.lp0 \+ 1/);
    expect(p.sql).toContain('IS NOT 1');             // NULL-safe: only predicate TRUE stops expansion
    expect(p.sql).not.toContain('depth <');          // no artificial depth cap — runs to fixpoint
  });

  test('until(loops().is(n)) tests the depth counter, not an element', () => {
    const p = read('g.V(1).repeat(__.out()).until(__.loops().is(2))');
    // `loops()` is a read of CARRIED STATE, so each spine names its own counter: legacy's
    // materialized `depth`, RelIR's `loops` channel. Both compare it to the literal 2.
    expect(p.sql).toMatch(/w\d+\.lp0 = 2/);
  });


  test('while-do (until before repeat) qualifies the seed id in the correlated predicate', () => {
    const p = read('g.V(3).until(__.has("name","lop")).repeat(__.out())');
    expect(p.kind).toBe('read');
    // Both the seed and later rows are tested through the walk relation's qualified id, never the
    // `node=id` self-match that would read the wrong property row.
    expect(p.sql).toMatch(/rp\d+\.node = w\d+\.id/);
    expect(p.sql).not.toContain('node = id');
  });


  test('until(__.out()) correlates the EXISTS on the walk row via the FROM boundary', () => {
    // The walk uses the SAME child predicate as where()/choose(), so its movement EXISTS is
    // correlated directly to the qualified SelfRef row rather than to a private repeat compiler.
    const p = read('g.V(1).repeat(__.out()).until(__.out())');
    expect(p.kind).toBe('read');
    expect(p.sql).toMatch(/EXISTS \(SELECT rme\d+\.tgt AS one FROM edges rme\d+ WHERE \(rme\d+\.src = w\d+\.id\)\)/);
  });


  test('a both() walk is a COMPOUND term — one arm per direction, not one arm with an OR', () => {
    const p = read('g.V(1).repeat(__.both()).emit()');
    expect(p.kind).toBe('read');
    // seed UNION ALL arm1 UNION ALL arm2 — each arm references the walk exactly once, which is the
    // only shape SQLite accepts (§6). The counter bump distributes over the arms rather than sitting
    // above them, because a projection over a compound would take a derived table and collect both
    // references into one subquery.
    expect(p.sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(p.sql).toMatch(/WITH RECURSIVE wk_w\d+\(id, lp0, bulk\)/);
    // both directions present, and no disjunctive single-arm join standing in for them
    expect(p.sql).toMatch(/\.src = w\d+\.id/);
    expect(p.sql).toMatch(/\.tgt = w\d+\.id/);
    expect(p.sql).not.toMatch(/src = w\d+\.id\) OR \(/);
  });

  test('a no-modulator repeat PRUNES to an empty relation instead of walking', () => {
    // Nothing can leave the walk, so evaluating it is pure cost. The walk is still BUILT — that is
    // what proves the body lowers, carries no effects and changes no shape — and then discarded, the
    // substitution Calcite spells as PruneEmptyRules.
    const p = read('g.V(1).repeat(__.out())');
    expect(p.kind).toBe('read');
    expect(p.sql).not.toContain('WITH RECURSIVE');
    expect(p.sql).toContain('1 = 0');
  });

  // ---------- bare emit() through the recursive walk ----------

  test('emit() BEFORE repeat needs no exit filter — the walk relation IS the emitted set', () => {
    const p = read('g.V(1).emit().repeat(__.out())');
    expect(p.kind).toBe('read');
    expect(p.sql).toMatch(/WITH RECURSIVE wk_w\d+\(id, lp0, bulk\)/);
    // Every row the walk holds leaves it, seed included, so nothing filters the walk on the way out.
    expect(p.sql).not.toMatch(/FROM wk_w\d+ \w+ WHERE/);
  });

  test('emit() AFTER repeat filters the walk to depth >= 1, excluding the seed', () => {
    const p = read('g.V(1).repeat(__.out()).emit()');
    expect(p.kind).toBe('read');
    expect(p.sql).toMatch(/w\d+\.lp0 > 0/);
  });

  test('until-after is SUBSUMED by emit-after: one depth test, not a disjunction', () => {
    // The until-after exit is literally and(deeper, tested), so `deeper OR (deeper AND tested)`
    // reduces to `deeper` — the predicate must not be spelled into the output filter at all.
    const p = read('g.V(1).repeat(__.out()).until(__.hasLabel("software")).emit()');
    expect(p.kind).toBe('read');
    expect(p.sql).toMatch(/w\d+\.lp0 > 0/);
    // …while the EXPANSION guard still consults it, so the walk stops at a software vertex.
    expect(p.sql).toContain('IS NOT 1');
  });

  test('emit(pred) spells the disjunction that bare emit does not need', () => {
    // Bare emit-after IS `deeper`, so an until-after exit — literally and(deeper, …) — is subsumed
    // and no OR is emitted. A predicate makes the two conditions independent, so both appear.
    const bare = read('g.V(1).repeat(__.out()).until(__.hasLabel("software")).emit()');
    expect(bare.sql).not.toContain(') OR (');
    const pred = read('g.V(1).repeat(__.out()).until(__.hasLabel("software")).emit(__.hasLabel("person"))');
    expect(pred.kind).toBe('read');
    expect(pred.sql).toContain(') OR (');
    expect(pred.sql).toMatch(/w\d+\.lp0 > 0/);
  });

  test('until-before with emit-after is a UNION ALL of two arms, not one predicate', () => {
    // The two output routes cannot suppress each other, so a row satisfying both leaves TWICE.
    const p = read('g.V(1).until(__.hasLabel("software")).repeat(__.out()).emit()');
    expect(p.kind).toBe('read');
    expect(p.sql).toContain(' UNION ALL ');
    expect(p.sql).toMatch(/w\d+\.lp0 > 0/);
    // …and the two arms SHARE one walk. `name.ts` binds a multiply-read `Recursive` under its own
    // name because its `SelfRef` is BOUND, not free; asking containment instead made every walk
    // unbindable and spelled this block twice (measured: 1,928 → 1,482 bytes).
    expect(p.sql.match(/WITH RECURSIVE/g)).toHaveLength(1);
    expect(p.sql.match(/wk_w\d+\(id, lp0, bulk\) AS \(/g)).toHaveLength(1);
  });

  // ---------- sack folded through the recursive walk (foldable carried column) ----------



  test('bare movement repeat (no sack) is unchanged — no sk column threaded', () => {
    const p = read('g.V(1).repeat(__.out()).times(2)');
    expect(p.sql).not.toContain('AS sk');
  });




  test('until(__.sack().is(P)) reads the accumulated sack', () => {
    const p = read("g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).until(__.sack().is(gte(50))).sack()");
          // RelIR reads the carried `sack` channel of the walk row, the same way `loops()` reads its own
      // channel — one carried-state reader over a role, not a predicate that knows about sacks.
      // The walk header is the rowid then the channels in ROLE_ORDER, so the sack rides beside the
      // loop counter rather than in a column of its own invention.
      expect(p.sql).toMatch(/WITH RECURSIVE wk_w\d+\(id, sack, lp0, bulk\)/);
      expect(p.sql).toMatch(/w\d+\.sack >= 50/);
      // A sack holds whatever its seed was, so the comparison is TYPE-GUARDED rather than assuming a
      // number — the same honesty `ScalarType.UNKNOWN` buys everywhere else.
      expect(p.sql).toMatch(/typeof\(w\d+\.sack\) IN \('integer', 'real'\)/);
    
  });

  test('a MOVEMENT-FREE body still makes progress when the sack does', () => {
    // The vertex never changes, so only the accumulator can terminate the walk: 0 → 29 → 58 exits at
    // >= 50. Worth pinning because "the body must move" is the intuition a sack fold breaks.
    const store = seededStore();
    const rows = run(store, "g.withSack(0L).V(1).repeat(__.sack(sum).by('age')).until(__.sack().is(gte(50))).sack()");
    expect((rows as any[]).map((r) => r.v)).toEqual([58]);
  });

  test('the BOUNDED spellings UNROLL instead — n phases, n sites, one union at the cap', () => {
    // The other half of the pair above, so the regime split is asserted rather than implied. An
    // unrolled body has no walk at all, which is why none of legacy's markers can appear — and it is
    // the PASS that does it, so this holds whichever route the phases then take.
    for (const gremlin of [
      "g.V(1).repeat(__.out().aggregate('x')).times(2).cap('x')",
      "g.V().local(__.aggregate('a')).repeat(__.out().local(__.aggregate('a'))).times(2).cap('a')",
    ]) {
      const p = read(gremlin);
      expect(p.kind, gremlin).toBe('read');
      expect(p.sql, gremlin).not.toContain('w.depth');
      expect(p.sql, gremlin).not.toContain('RECURSIVE');
    }
  });
});
