// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { PER_ROW } from '../../src/sql/kernel/render.ts';
import { read } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('movement / edge sources SQL', () => {
  test('E() sources the edges table; default projection is the edge shape', () => {
    // The bare element source is RelIR-routed (§10·4), so BOTH spellings of the id-relation are
    // pinned here and each is pinned against the spine that produces it. Pinning the ambient one
    // would make this assertion flip under `mise run test:legacy-spine`, which is the differential
    // — and a differential that cannot run green is not one.
    const r = read('g.E()', { spine: 'rel' });
    expect(r.sql).toContain('FROM edges re');
    expect(r.shape).toEqual({ kind: 'edge' });
    // The RelIR route builds its OWN payload now (§10·10), so the external-endpoint property below is
    // pinned on both spines rather than only on the one that used to compose the projection — which is
    // the whole point of the tuple having one authority. Aliases are minted per lowering, so the SHAPE
    // of the resolution is what is asserted, never the alias.
    expect(r.sql).toMatch(/\(SELECT COALESCE\(\w+\.uid, \w+\.id\) AS v FROM nodes \w+ WHERE \(\w+\.id = \w+\.src\)\) AS src/);
    expect(r.sql).toMatch(/\(SELECT COALESCE\(\w+\.uid, \w+\.id\) AS v FROM nodes \w+ WHERE \(\w+\.id = \w+\.tgt\)\) AS tgt/);
    expect(read('g.E()', { spine: 'legacy' }).sql).toContain('c0(id, bulk) as (SELECT id, 1 AS bulk FROM edges)');
    const p = read('g.E()', { spine: 'legacy' });
    expect(p.shape).toEqual({ kind: 'edge' });
    // Endpoints resolve to the external id (COALESCE(uid,id)) so a materialized edge
    // reports the SAME endpoint ids as the write path — was raw rowid (n.src, n.tgt),
    // a read/write divergence that surfaced under user-supplied ids.
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS src');
    expect(p.sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.tgt) AS tgt');
    // ...and the resolution must NOT leak into the traversal CTE (index-only scan):
    // the source CTE is still a bare `SELECT id FROM edges`, no endpoint join.
    expect(p.sql).not.toContain('nodes WHERE id=n.src) AS id');
  });

  test('every edge-element materialization path resolves endpoints to external ids', () => {
    // Regression: an edge framed out as an element must report external endpoint
    // ids on ALL paths (was raw rowid), matching the write path (write.ts nodeExtId).
    // fold() over edges reuses the __element edge projection.
    expect(read('g.V(1).outE().fold()', { spine: 'legacy' }).sql).toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=n.src) AS src');
    // path() with an edge position frames endpoints per-position (x{i}_src/_tgt).
    const pth = read('g.V(1).outE().inV().path()', { spine: 'legacy' });
    expect(pth.sql).toContain('WHERE id=x1n.src) AS x1_src');
    expect(pth.sql).toContain('WHERE id=x1n.tgt) AS x1_tgt');
    // group() default value = element list of edges (v_src/_tgt).
    expect(read('g.V(1).outE().group().by(__.label())', { spine: 'legacy' }).sql)
      .toContain('(SELECT COALESCE(uid, id) FROM nodes WHERE id=gn.src) AS v_src');
  });

  // Movement is RelIR-routed (§10·4). What both spines must agree on is the DIRECTION table — which
  // edge column matches the incoming id and which one the outgoing id comes from — so that is what
  // is asserted, once per spine, rather than either one's aliases.
  for (const spine of ['legacy', 'rel'] as const) {
    test(`outE/inE go vertex→edge; outV/inV go edge→vertex — ${spine} spine`, () => {
      const oe = read('g.V(1).outE("knows")', { spine });
      expect(oe.sql).toMatch(/(\w+)\.id AS id[^]*edges \1[^]*\1\.src\s*=\s*\w+\.id|SELECT e\.id AS id, p\.bulk FROM edges e JOIN c0 p ON e\.src=p\.id/);
      expect(oe.shape).toEqual({ kind: 'edge' });

      const iv = read('g.V(1).outE("knows").inV()', { spine });
      // edge → target vertex; back to vertex shape
      expect(iv.sql).toMatch(/(\w+)\.tgt AS id[^]*edges \1[^]*\1\.id\s*=\s*\w+\.id|SELECT e\.tgt AS id, p\.bulk FROM edges e JOIN c1 p ON e\.id=p\.id/);
      expect(iv.shape).toEqual({ kind: 'vertex' });
    });
  }

  test('edge steps reject the wrong element kind', () => {
    expect(() => compile('g.V().outV()', {})).toThrow('outV() expects an edge, not a vertex');
    expect(() => compile('g.E().out()', {})).toThrow('out() expects a vertex, not an edge');

  });

  test('has()/values() on edges filter/project the edges table', () => {
    // An edge `has()` is RelIR-routed, and the two spellings say the same thing two ways: legacy
    // re-joins `edges` per filter CTE, RelIR conjoins into the source scan's own WHERE.
    expect(read('g.E().has("weight",0.5)', { spine: 'legacy' }).sql).toContain('FROM edges n JOIN c0 p ON n.id=p.id');
    // The filter is still conjoined into the source scan's own clause (the EXISTS below); what leads
    // the FROM is the DRIVING SEEK `src/rel/passes/seek.ts` lifts out of it — the same predicate as a
    // relation, so the plan starts at `ep_key_value(key,value)` instead of checking it last. `DISTINCT`
    // is what stops a repeated (key,value) multiplying the traverser, and the `CROSS JOIN` is the order
    // fence that keeps the seek in the outer loop (`docs/2026-08-07-query-plan-stability.md` §3·2).
    expect(read('g.E().has("weight",0.5)', { spine: 'rel' }).sql).toContain(
      "FROM (SELECT DISTINCT rsk0.edge AS sid FROM edge_properties rsk0 WHERE ((rsk0.key = 'weight') AND (rsk0.value = 0.5))) sd0 CROSS JOIN edges re ON (re.id = sd0.sid)");
    expect(read('g.E().has("weight",0.5)', { spine: 'rel' }).sql).toContain('WHERE EXISTS (SELECT 1 AS one FROM edge_properties rp2 WHERE (((rp2.edge = re.id)');
    expect(read('g.V(1).outE().values("weight")', { spine: 'legacy' }).sql).toContain('JOIN edge_properties ep ON ep.edge=n.id AND ep.key=?');
    // `CROSS JOIN`, not `INNER` — the stream drives and the property table is PROBED. SQLite's CROSS
    // JOIN is an inner join whose order is pinned (`src/rel/emit.ts` joinText); the fence is what
    // stops the planner leading with a `key=?` scan of every property in the graph.
    expect(read('g.V(1).outE().values("weight")', { spine: 'rel' }).sql).toMatch(/CROSS JOIN edge_properties \w+ ON \(\(\w+\.edge = \w+\.id\) AND \w+\.key IN/);
  });

  test('single select and record projection preserve edge element typing', () => {
    // Pinned PER SPINE for the reason the `E()` test above states: the payload projection is the RelIR
    // route's own now (§10·10), so the two spines spell the edge-row join differently and an ambient
    // assertion could only be green on one of them — which would make the differential unrunnable.
    for (const spine of ['legacy', 'rel'] as const) {
      const selected = read('g.V(1).outE("knows").as("b").select("b")', { spine });
      expect(selected.shape).toEqual({ kind: 'edge' });
      expect(selected.sql).toMatch(spine === 'legacy' ? /FROM edges n JOIN/ : /INNER JOIN edges \w+ ON/);
    }
    // A record over an EDGE host, pinned per spine for the same reason: legacy carries the field as a
    // prefixed column-set, RelIR collapses it to the one map value, and both read the EDGE property
    // side-table rather than the vertex one — which is the typing this test is actually about.
    expect(read('g.V(1).outE().project("w").by("weight")', { spine: 'legacy' }).shape).toEqual({
      kind: 'map', entries: [{ key: 'w', prefix: 'e0', sub: 'value', type: PER_ROW('e0_vtype') }],
    });
    const rel = read('g.V(1).outE().project("w").by("weight")', { spine: 'rel' });
    expect(rel.spine).toBe('rel');
    expect(rel.shape).toEqual({ kind: 'mapValue' });
    expect(rel.sql).toContain('FROM edge_properties');
  });
});
