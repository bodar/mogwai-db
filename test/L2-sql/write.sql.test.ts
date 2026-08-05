// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { read } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('write SQL', () => {
  test('vertex property has(key,val): key inlined as an escaped literal, value bound', () => {
    // W4: vertex props are normalized into vertex_properties; has(key,val) is an EXISTS. The KEY is a
    // parsed literal the compiler holds — a CONSTANT — so RelIR inlines it as an ESCAPED SQL literal
    // rather than spending one of the DO's 100 binds on it (the parameter-budget rule,
    // docs/2026-08-05-parameters-are-the-only-binds.md); legacy still binds it. The VALUE is genuine
    // data and stays bound on both. The static (key,value) index serves either spelling.
    expect(read('g.V().has("age",30)', { spine: 'legacy' }).sql)
      .toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)');
    expect(read('g.V().has("age",30)', { spine: 'rel' }).sql)
      .toMatch(/EXISTS \(SELECT 1 AS one FROM vertex_properties \w+ WHERE .*\.key = 'age'.*\.value = \?/);
    // legacy binds [key, value]; RelIR binds only [value] — the key no longer competes for the budget.
    expect(read('g.V().has("age",30)', { spine: 'legacy' }).binds).toEqual(expect.arrayContaining(['age', 30]));
    const rel = read('g.V().has("age",30)', { spine: 'rel' });
    expect(rel.binds).toEqual([30]);
    expect(rel.binds).not.toContain('age');

    // No injection surface: an inlined key is `''`-escaped (textLiteral), NEVER raw-spliced — so a key
    // that itself contains a quote survives as an escaped literal, not a break-out. Escaping is the
    // security property now, in place of the bind.
    const inject = read("g.V().has(\"x' OR '1'='1\", \"v\")", { spine: 'rel' });
    expect(inject.sql).toContain("key = 'x'' OR ''1''=''1'");
    expect(inject.binds).toEqual(['v']);
    // legacy keeps binding the exotic key, so it never reaches the SQL text at all.
    const exoticLegacy = read('g.V().has("first name","x")', { spine: 'legacy' });
    expect(exoticLegacy.sql).not.toContain('first name');
    expect(exoticLegacy.binds).toEqual(expect.arrayContaining(['first name', 'x']));
  });
});
