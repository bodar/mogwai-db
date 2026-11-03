// Steps whose meaning is decided by the QUERY TEXT alone, so each is a constant or nothing rather
// than a decline:
//
//   - an `emit()`/`until()`/`times()` with no `repeat()` to modulate is INVALID Gremlin
//     (`StandardVerificationStrategy.java:83-85`) — said so, not "not supported yet";
//   - `times(n ≤ 0)` is `until(loops() >= n)` already true: before the body (`times(0).repeat(b)`) the
//     region is nothing, after it (`repeat(b).times(0)`) the do-while runs once, i.e. `times(1)`
//     (`RepeatStep.java:265-278`, `:334-341`). The grammar admits only an integer LITERAL there
//     (`Gremlin.g4` `traversalMethod_times`), so the count is always known at the unroll;
//   - `identity()` as a filter is true, a non-terminal `discard()` false (`DiscardStep.java`);
//   - a `sideEffect(body)` whose drained body writes, collects and raises nothing is the identity.
//
// Each is exercised at depth — inside branch arms, filter bodies and per-traverser hosts — since the
// rules live at the seam (`verifyStandard`, the bounded-repeat unroll, `sourceFilter`, a simplify Pass)
// rather than at the named scenario.
import { describe, expect, test } from 'bun:test';
import { VerificationException } from '../../src/gremlin/coerce.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { seededStore, run, bare } from '../support/harness.ts';

const store = seededStore();
const values = (q: string): unknown[] => (bare(run(store, q)) as any[]).map((r) => ('list' in r ? JSON.parse(r.list) : r.v));
const count = (q: string): number => values(q)[0] as number;
const names = (q: string): string[] => (values(q) as string[]).slice().sort();

describe('a repeat modulator without repeat() is invalid Gremlin', () => {
  test.each([
    'g.V().emit()',
    'g.V().until(__.identity())',
    'g.V().times(5)',
    // a filled slot is not refilled: the second modulator starts a NEW RepeatStep with no body
    'g.V().repeat(__.out()).emit().emit()',
    'g.V().repeat(__.out()).times(2).times(1)',
    'g.V().repeat(__.out()).until(__.hasLabel("software")).times(1)',
    // at depth: a branch arm, a filter body, a repeat body
    'g.V().union(__.emit(), __.out())',
    'g.V().where(__.out().times(2))',
    'g.V().repeat(__.out().emit()).times(2)',
  ])('%s', (q) => {
    expect(() => run(store, q)).toThrow(VerificationException);
    expect(() => run(store, q)).toThrow('The repeat()-traversal was not defined');
  });

  test.each([
    'g.V().emit().repeat(__.out()).times(1).count()',
    'g.V().times(1).repeat(__.out()).count()',
    'g.V().repeat(__.out()).times(1).repeat(__.out()).times(1).count()',
  ])('a modulator BESIDE its repeat() is not the error: %s', (q) => {
    expect(() => run(store, q)).not.toThrow();
  });

  test('an as() labels the repeat rather than ending it, so a later modulator is not stray', () => {
    // Whether it lowers is another matter; it must not be called invalid.
    try { run(store, 'g.V().repeat(__.out()).as("a").times(1).count()'); } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedTraversal);
    }
  });
});

describe('times(n ≤ 0)', () => {
  const marko = 'g.V().has("person","name","marko")';
  test('AFTER repeat(): the body runs once', () => {
    expect(names(`${marko}.repeat(__.out("created")).times(0).values("name")`)).toEqual(['lop']);
    expect(names(`${marko}.repeat(__.out("created")).times(-3).values("name")`)).toEqual(['lop']);
  });
  test('BEFORE repeat(): the region is nothing', () => {
    expect(names(`${marko}.times(0).repeat(__.out("created")).values("name")`)).toEqual(['marko']);
    expect(names(`${marko}.times(-1).repeat(__.out()).emit().values("name")`)).toEqual(['marko']);
    expect(names(`${marko}.emit().times(0).repeat(__.out()).values("name")`)).toEqual(['marko']);
  });
  test('with emit(): exactly times(1)', () => {
    expect(count('g.V(1).repeat(__.out()).emit().times(0).count()')).toBe(3);
    expect(count('g.V(1).emit().repeat(__.out()).times(0).count()')).toBe(4);
  });
  test('at depth: a branch arm, a filter body, a per-traverser host, a path', () => {
    expect(count('g.V().union(__.times(0).repeat(__.out()), __.repeat(__.out()).times(0)).count()')).toBe(12);
    expect(names('g.V().where(__.times(0).repeat(__.out()).has("name","marko")).values("name")')).toEqual(['marko']);
    expect(count('g.V().local(__.times(0).repeat(__.out())).count()')).toBe(6);
    expect(count('g.V(1).times(0).repeat(__.out()).out().path().count()')).toBe(3);
  });
});

describe('identity() and discard() as filter constants', () => {
  test('a non-terminal discard() keeps nothing, over every stream it reaches', () => {
    expect(values('g.V().discard().fold()')).toEqual([[]]);
    expect(count('g.V().out().discard().count()')).toBe(0);
    expect(count('g.V().values("age").discard().count()')).toBe(0);
    expect(count('g.V().properties().discard().count()')).toBe(0);
  });
  test('discard() at depth', () => {
    expect(count('g.V().union(__.discard(), __.out()).count()')).toBe(6);
    expect(count('g.V().where(__.discard()).count()')).toBe(0);
    expect(count('g.V().not(__.discard()).count()')).toBe(6);
    expect(count('g.V().optional(__.out().discard()).count()')).toBe(6);
    expect(count('g.V().local(__.values("age").discard()).count()')).toBe(0);
  });
  test('a discard() does not cancel a side effect before it', () => {
    expect(count('g.V().aggregate("x").discard().cap("x").count(local)')).toBe(6);
  });
  test('identity() as a filter is true, not(identity()) false', () => {
    expect(count('g.V().where(__.identity()).count()')).toBe(6);
    expect(count('g.V().not(__.identity()).count()')).toBe(0);
    expect(values('g.V().values("name").not(__.identity()).fold()')).toEqual([[]]);
    expect(values('g.V().choose(__.not(__.identity()), __.constant(1), __.constant(2)).dedup()')).toEqual([2]);
  });
});

describe('an effect-free sideEffect() is the identity', () => {
  test.each([
    ['g.V().sideEffect(__.identity()).count()', 6],
    ['g.V().sideEffect(__.out().values("name")).count()', 6],
    ['g.V().sideEffect(__.math("_ / 0")).count()', 6],
    ['g.V().union(__.sideEffect(__.outE()), __.out()).count()', 12],
    ['g.V().coalesce(__.sideEffect(__.out()), __.constant(1)).count()', 6],
    ['g.V().choose(__.hasLabel("person"), __.sideEffect(__.out()), __.out()).count()', 4],
    ['g.V().where(__.sideEffect(__.out()).out()).count()', 3],
    ['g.V().repeat(__.out().sideEffect(__.values("name"))).times(2).count()', 2],
    ['g.V().as("a").sideEffect(__.select("a")).select("a").count()', 6],
  ] as const)('%s', (q, n) => {
    expect(count(q)).toBe(n);
  });
  test('a group by() body', () => {
    const [m] = bare(run(store, 'g.V().group().by(__.values("name").sideEffect(__.constant("zyx")).substring(0,1)).by(__.constant(1).sideEffect(__.constant("xyz")))')) as any[];
    expect(m).toBeDefined();
  });
  test.each([
    'g.V().sideEffect(__.fail()).count()',
    'g.V().sideEffect(__.property("k", 1)).count()',
    'g.V().sideEffect(__.groupCount("a")).cap("a")',
    'g.V().sideEffect(__.out().sideEffect(__.aggregate("x"))).cap("x")',
    'g.V().sideEffect(__.call("tinker.search")).count()',
  ])('a body with an effect is NOT removed: %s', (q) => {
    const steps = normalize(stepChain(parseGremlin(q), NO_PARAMS), NO_PARAMS).steps;
    expect(steps.map((s) => s.name)).toContain('sideEffect');
  });
  test('an effect-free one IS removed, leaving the identity where it was the whole body', () => {
    const names = (q: string) => normalize(stepChain(parseGremlin(q), NO_PARAMS), NO_PARAMS).steps.map((s) => s.name);
    expect(names('g.V().sideEffect(__.out().values("name")).count()')).toEqual(['V', 'count']);
  });
});
