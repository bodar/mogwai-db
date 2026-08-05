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
import { read } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('write SQL', () => {
  test('vertex property has(key,val): key AND literal value inlined; only a parameter binds', () => {
    // W4: vertex props are normalized into vertex_properties; has(key,val) is an EXISTS. Both the KEY and
    // a LITERAL value are parsed constants the compiler holds, so RelIR inlines them as ESCAPED SQL
    // literals rather than spending the DO's 100 binds (docs/2026-08-05-parameters-are-the-only-binds.md);
    // legacy still binds both. A WIRE PARAMETER (`$x`) is the one operand that binds on RelIR — that is
    // what the 100 budget is FOR. The static (key,value) index serves either spelling.
    expect(read('g.V().has("age",30)', { spine: 'legacy' }).sql)
      .toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)');
    const rel = read('g.V().has("age",30)', { spine: 'rel' });
    expect(rel.sql).toMatch(/EXISTS \(SELECT 1 AS one FROM vertex_properties \w+ WHERE .*\.key = 'age'.*\.value = 30/);
    // legacy binds [key, value]; RelIR binds NOTHING — both are constants.
    expect(read('g.V().has("age",30)', { spine: 'legacy' }).binds).toEqual(expect.arrayContaining(['age', 30]));
    expect(rel.binds).toEqual([]);
    // A PARAMETER value binds on RelIR (its intent is "variable"); the key stays inlined.
    const param = compile('g.V().has("age",xx1)', { xx1: 30 }, { spine: 'rel' });
    expect(param.kind === 'read' ? param.binds : []).toEqual([30]);
    expect(param.kind === 'read' ? param.sql : '').toMatch(/\.key = 'age'.*\.value = \?/);

    // No injection surface: an inlined key or value is `''`-escaped (textLiteral), NEVER raw-spliced — so
    // one that itself contains a quote survives as an escaped literal, not a break-out. Escaping is the
    // security property now, in place of the bind.
    const inject = read("g.V().has(\"x' OR '1'='1\", \"v\")", { spine: 'rel' });
    expect(inject.sql).toContain("key = 'x'' OR ''1''=''1'");
    expect(inject.binds).toEqual([]);
    // legacy keeps binding the exotic key, so it never reaches the SQL text at all.
    const exoticLegacy = read('g.V().has("first name","x")', { spine: 'legacy' });
    expect(exoticLegacy.sql).not.toContain('first name');
    expect(exoticLegacy.binds).toEqual(expect.arrayContaining(['first name', 'x']));
  });
});
