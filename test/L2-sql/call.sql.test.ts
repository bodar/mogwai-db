// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { type CompileOptions } from '../../src/compiler/compiler.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { read, relirAhead, run, runWith, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('call / search service SQL', () => {
  test('a call() scalar body is a correlated VALUE, compared in place', relirAhead(
    'g.V().where(call("tinker.degree.centrality").is(3))', () => {
    const store = seededStore();
    const withReg: CompileOptions = { registry: standardRegistry };
    // `tinker.degree.centrality` is a `rel` contribution now, so LEGACY refuses it outright and this
    // is RelIR's answer absolutely rather than a differential (§6·1). What it asserts is the SHAPE of
    // that answer: a `streaming` service contributes a per-parent VALUE, and a body that projects a
    // value and then tests it is a COMPARISON — so there is no EXISTS, no pushed child ordinal and no
    // LEFT JOIN rejoin, which is what legacy's scoped-count seam needed to ask the same question.
    const wsql = read('g.V().where(call("tinker.degree.centrality").is(3))', { ...withReg, spine: 'rel' }).sql;
    expect(wsql).not.toContain('EXISTS');
    expect(wsql).not.toContain('LEFT JOIN');
    expect(wsql).toContain('= 3');
    expect(wsql).toContain('rme2.tgt = rn.id');
    // The nested child scope rides the carried origin: only lop (IN-degree 3) survives. (Result
    // shape/values are asserted end-to-end over GraphBinary in test/services.test.ts.)
    const nameOf = (id: unknown) => (run(store, `g.V(${id}).values("name")`) as any[])[0]?.v;
    const kept = runWith(store, 'g.V().where(call("tinker.degree.centrality").is(3))', withReg) as any[];
    expect(kept.map((r) => nameOf(r.id))).toEqual(['lop']);
    // The SAME seam serves a by() slot, which is the whole reason the service hands its body to
    // `ChildSeam.scalar` rather than owning a per-traverser substrate: a group KEY is that value.
    const grouped = runWith(store, 'g.V().group().by(call("tinker.degree.centrality")).by("name")', { ...withReg, spine: 'rel' }) as any[];
    expect(JSON.parse(grouped[0]!.map).map(([k, v]: [any, any]) => [k.v, v.v.map((n: any) => n.v)])).toEqual([
      [0, ['marko', 'peter']], [1, ['vadas', 'josh', 'ripple']], [3, ['lop']],
    ]);
    // A `start` position for a `streaming` service is invalid Gremlin, and once legacy stopped
    // serving this service there is nobody else to raise it — so the check is a THROW, not a decline
    // (§6·5, "the answer is an ERROR").
    expect(() => read('g.call("tinker.degree.centrality")', withReg))
      .toThrow(/must be called mid-traversal on vertices/);
  }, { registry: standardRegistry }));

  test('tinker.search: a source PropertyStream backed by the property_fts trigram index', () => {
    const store = seededStore();
    // THE SPINE IS PINNED: `tinker.search` contributes `kind: 'rel'`, and a service implements
    // `stream` XOR `rel` — two implementations of one service is the duplicated lowering
    // `steps/CLAUDE.md` forbids. So this asserts the spine that HAS a lowering rather than whichever
    // the ambient `MOGWAI_RELIR` switch picks; unpinned, the differential's OFF position would run it
    // against a spine that correctly refuses. The refusal itself is asserted in `services.test.ts`.
    const withReg: CompileOptions = { registry: standardRegistry, spine: 'rel' };
    // g.call("tinker.search",{search:"mar"}).element() → the matched properties' owner vertices.
    // The SQL selects from property_fts (kind='value', a case-insensitive LIKE %term%) and joins
    // back to vertex_properties + nodes + labels for the full PropertyStream payload.
    const sql = read('g.call("tinker.search", ["search": "mar"]).element()', withReg).sql;
    expect(sql).toContain('property_fts');
    // A substring match with the user's metacharacters escaped — asserted for MEANING, because the
    // two spines spell it differently and both are right. Legacy emits the infix `LIKE … ESCAPE`;
    // the RelIR spine emits SQLite's `like(pattern, subject, escape)` FUNCTION, because the closed
    // node set (§7) has no ESCAPE-clause node and the function says the same thing. `predicate.ts`
    // uses that same form for every TextP substring op. The ESCAPE is asserted as "an escape is
    // SUPPLIED" — legacy's `ESCAPE` keyword, or `like()`'s third argument — rather than by matching a
    // backslash literal, which differs between the two renderings and says nothing extra.
    expect(sql.includes('LIKE') || sql.includes('like(')).toBe(true);
    expect(/ESCAPE|like\([^)]*,[^)]*,[^)]*\)/.test(sql)).toBe(true);
    // element() walks each matched property to its owner (marko), reusing the propertyElement tail.
    const names = runWith(store, 'g.call("tinker.search", ["search": "mar"]).element().values("name")', withReg) as any[];
    expect(names.map((r) => r.v)).toEqual(['marko']);
    // type=Edge searches edge properties (empty on the modern graph); VertexProperty → empty.
    expect((runWith(store, 'g.call("tinker.search", ["search": "mar"]).with("type", "Edge").element()', withReg) as any[]).length).toBe(0);
    expect((runWith(store, 'g.call("tinker.search", ["search": "mar"]).with("type", "VertexProperty").element()', withReg) as any[]).length).toBe(0);
  });
});
