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

describe('movement / edge sources SQL', () => {


  // Movement is RelIR-routed. What matters is the DIRECTION table — which edge column matches the
  // incoming id and which one the outgoing id comes from — so that is what is asserted, rather than
  // the lowering's aliases.
  {
    test(`outE/inE go vertex→edge; outV/inV go edge→vertex`, () => {
      const oe = read('g.V(1).outE("knows")');
      expect(oe.sql).toMatch(/(\w+)\.id AS id[^]*edges \1[^]*\1\.src\s*=\s*\w+\.id|SELECT e\.id AS id, p\.bulk FROM edges e JOIN c0 p ON e\.src=p\.id/);
      expect(oe.shape).toEqual({ kind: 'edge' });

      const iv = read('g.V(1).outE("knows").inV()');
      // edge → target vertex; back to vertex shape
      expect(iv.sql).toMatch(/(\w+)\.tgt AS id[^]*edges \1[^]*\1\.id\s*=\s*\w+\.id|SELECT e\.tgt AS id, p\.bulk FROM edges e JOIN c1 p ON e\.id=p\.id/);
      expect(iv.shape).toEqual({ kind: 'vertex' });
    });
  }



});
