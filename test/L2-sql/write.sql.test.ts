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
  test('vertex property keys bind as parameters (static vp index, no literal splice)', () => {
    // W4: vertex props are normalized into vertex_properties; has(key,val) is an EXISTS
    // with BOTH key and value bound. The static (key,value) index serves a bound key
    // fine (a plain B-tree column, not an expression index), so no literal splice — and
    // no injection surface for any key.
    // Asserted on BOTH spines: this is a security property of the compiler, not of one lowering,
    // and `has()` is RelIR-routed today. Each spine's own spelling of the EXISTS is pinned beside
    // it, but the load-bearing half is the bind list — a key reaching the SQL TEXT is the defect.
    expect(read('g.V().has("age",30)', { spine: 'legacy' }).sql)
      .toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)');
    expect(read('g.V().has("age",30)', { spine: 'rel' }).sql)
      .toMatch(/EXISTS \(SELECT 1 AS one FROM vertex_properties \w+ WHERE .*\.key = \?.*\.value = \?/);

    for (const spine of ['legacy', 'rel'] as const) {
      expect(read('g.V().has("age",30)', { spine }).binds).toEqual(expect.arrayContaining(['age', 30]));
      // an exotic key (space) is handled identically — bound, never spliced into SQL
      const exotic = read('g.V().has("first name","x")', { spine });
      expect(exotic.sql).not.toContain('first name');
      expect(exotic.binds).toEqual(expect.arrayContaining(['first name', 'x']));
    }
  });
});
