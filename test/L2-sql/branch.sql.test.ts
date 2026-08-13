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

describe('branch SQL (and/or/union/optional/choose/coalesce/map/flatMap)', () => {


  test('and()/or() combine branch predicates; nested where(__.and)', () => {
    // THE CONNECTIVE STEPS, on RelIR. `ConnectiveStep` is a `FilterStep` whose `filter` runs
    // `TraversalUtil.test` per arm, so the lowering is the connective over the answers the arms
    // already have — each movement arm is the correlated `EXISTS` a `where()` body would be.
    const a = read('g.V().and(__.out("knows"), __.out("created"))');
    expect(a.kind).toBe('read');
    expect(a.sql).toMatch(/WHERE \(EXISTS \(.*\) AND EXISTS \(/s);
    expect(read('g.V().or(__.out("knows"), __.in("created"))').sql).toMatch(/WHERE \(EXISTS \(.*\) OR EXISTS \(/s);
    // A SINGLE arm is legal Gremlin — `and(t)`/`or(t)` is just "t must produce". ZERO arms declines
    // here (the only way an empty connective reaches a lowering is an infix marker the Pass tier
    // should have rewritten).
    expect(read('g.V().and(__.out("knows"))').sql).toContain('EXISTS (');
    expect(read('g.V().or(__.out("knows"))').sql).toContain('EXISTS (');
  });

  test('infix .and()/.or() connectors split a predicate body (where/choose/until)', () => {
    // where(has().and().has()) → ((p0) AND (p1)). A Pass canonicalizes TinkerPop's `ConnectiveStrategy`
    // into the nested form, so the lowering never sees the infix rule.
    const a = read('g.V().where(__.has("name","x").and().has("age",P.gt(1)))');
    expect(a.sql).toContain(' AND ');
    // NO BINDS: `'name'`, `'x'` and `1` are PARSED LITERALS, and a literal inlines as a typed SQL
    // literal — a `?` serves a user PARAMETER and nothing else.
    expect(a.binds).toEqual([]);
    // or() → (p0 OR p1); OR binds looser so mixed a.and().b.or().c groups as ((a AND b) OR c)
    expect(read('g.V().where(__.has("name","x").or().has("age",P.gt(1)))').sql).toMatch(/EXISTS \(.*\) OR EXISTS \(/s);
    const mixed = read('g.V().where(__.hasLabel("person").and().out("created").or().hasLabel("software"))');
    expect(mixed.sql).toMatch(/\(\(.*AND.*\).*OR.*\)/s);
    // choose() infix predicate now routes through the same split (movement conjunct →
    // correlated EXISTS), then the arms fold.
    const c = read('g.V().choose(__.hasLabel("person").and().out("created"), __.out("knows"), __.identity())');
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    // malformed (leading/trailing/empty operand) → clear throw
    expect(() => compile('g.V().where(__.and().has("name","x"))', {})).toThrow('empty operand');
  });

















});
