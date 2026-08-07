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
import { read, run, runWith, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('call / search service SQL', () => {
  test('a call() scalar body lowers through the generalized "lowers-to-scalar" child classifier', () => {
    const store = seededStore();
    const withReg: CompileOptions = { registry: standardRegistry };
    // where(call(dc).is(3)): the classifier now recognizes call() (not just values/id/label) as a
    // scalar producer, so it lowers via the generic child seam — a scoped-count LEFT JOIN over a
    // pushed child ordinal, gated by a correlated EXISTS — with NO bespoke reader.
    const wsql = read('g.V().where(call("tinker.degree.centrality").is(3))', withReg).sql;
    expect(wsql).toContain('EXISTS');
    expect(wsql).toContain('LEFT JOIN');
    // The nested child scope rides the carried origin: only lop (IN-degree 3) survives. (Result
    // shape/values are asserted end-to-end over GraphBinary in test/services.test.ts.)
    const nameOf = (id: unknown) => (run(store, `g.V(${id}).values("name")`) as any[])[0]?.v;
    const kept = runWith(store, 'g.V().where(call("tinker.degree.centrality").is(3))', withReg) as any[];
    expect(kept.map((r) => nameOf(r.id))).toEqual(['lop']);
    // group().by(call(dc)) also flows through the same generalized seam (a scalar group key).
    expect(read('g.V().group().by(call("tinker.degree.centrality")).by("name")', withReg).sql)
      .toContain('LEFT JOIN');
  });

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
