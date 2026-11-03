// THE DECLINE-REASON CHANNEL (`Declines`, `src/compiler/unsupported.ts`): a decline the lowering decides
// on a framing fact is RECORDED into the compile's one sink and the lowering returns `null` — it never
// throws (`scripts/rel-sweep.ts`'s contract). `compilePlan` reads the sink: a TERMINAL reason is the whole
// message, prefixed by its KIND; an ADVISORY one is only a hint appended to "no lowering covers …".
import { describe, expect, test } from 'bun:test';
import { compilePlan, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { Declines } from '../../src/compiler/unsupported.ts';
import { extractStrategies, parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { lowerToRel } from '../../src/compiler/rel/lower.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';

const declineOf = (q: string): UnsupportedTraversal => {
  try { compilePlan(q, {}); } catch (e) {
    if (e instanceof UnsupportedTraversal) return e;
    throw e;
  }
  throw new Error(`expected ${q} to decline`);
};

/** The chain `lowerToRel` sees, as the rel-sweep builds it. */
const chainOf = (q: string): IRStep[] => {
  const tree = parseGremlin(q);
  return runPasses(stepChain(tree, NO_PARAMS), extractStrategies(tree, NO_PARAMS), NO_PARAMS).steps as IRStep[];
};

const AMBIGUOUS = /^this traversal is ambiguous: V\(\)\/E\(\) inside this body discards the value before it/;
const SHARED = 'a random draw (sample/coin/shuffle) inside a V()/E() body is not supported where the body runs '
  + 'for more than one traverser — it would be drawn once and shared by every row';

describe('the lowering RECORDS a framing-decided decline and returns null — it never throws', () => {
  for (const [q, kind] of [
    ["g.inject(1,2).map(__.V().sample(1).values('name'))", 'shared-draw'],
    ["g.V().optional(__.out().as('a')).map(__.select('a').V().count())", 'resource-under-absent'],
    ["g.V().map(__.values('age').math('_ + 1').by(__.V().count()))", 'resource-under-absent'],
    ["g.V(1).valueMap().mergeV(__.select('name'))", 'map-scope-shadow'],
  ] as const) {
    test(q, () => {
      const declines = new Declines();
      expect(lowerToRel(chainOf(q), { params: NO_PARAMS, declines })).toBeNull();
      expect(declines.terminal()?.kind).toBe(kind);
    });
  }
});

describe('a terminal reason is the message, and its prefix is a property of its kind', () => {
  test('a shared draw keeps its reason and a map()/flatMap() host adds the per-row form', () => {
    const e = declineOf("g.inject(1,2).map(__.V().sample(1).values('name'))");
    expect(e.kind).toBe('shared-draw');
    expect(e.message).toBe(`this traversal is not supported yet: ${SHARED}; use local(__.V()…sample(1)) to draw per row`);
    // The draw's own host is a by(); the map() around it is what names the per-row form.
    expect(declineOf("g.inject(1,2).flatMap(__.project('x').by(__.V().sample(1).values('name')))").message)
      .toBe(`this traversal is not supported yet: ${SHARED}; use local(__.V()…sample(1)) to draw per row`);
  });

  test('a non-map host names no per-row form', () => {
    expect(declineOf("g.inject(1,2).project('x').by(__.V().sample(1).values('name'))").message)
      .toBe(`this traversal is not supported yet: ${SHARED}`);
  });

  test('a re-source under a maybe-absent label reads as ambiguous and keeps the advice', () => {
    const e = declineOf("g.V().optional(__.out().as('a')).map(__.select('a').V().count())");
    expect(e.kind).toBe('resource-under-absent');
    expect(e.message).toMatch(AMBIGUOUS);
    expect(e.message).toContain('did you mean to traverse FROM that value (out()/in()) or to filter by it (V().has(…, …))?');
  });

  test('a re-source under a value run reads as ambiguous and suggests no select() it does not contain', () => {
    const e = declineOf("g.V().map(__.values('age').math('_ + 1').by(__.V().count()))");
    expect(e.message).toMatch(AMBIGUOUS);
    expect(e.message).not.toContain('select(');
  });

  test('at depth: inside local(), a where() body and a union() arm', () => {
    for (const q of [
      "g.V().local(__.optional(__.out().as('a')).map(__.select('a').V().count()))",
      "g.V().where(__.optional(__.out().as('a')).map(__.select('a').V().count()).is(gt(0)))",
      "g.V().union(__.map(__.values('age').math('_ + 1').by(__.V().count())), __.constant(1))",
    ]) expect(declineOf(q).message).toMatch(AMBIGUOUS);
  });

  test('a merge over Maps whose select() a Map key shadows names the shadow', () => {
    const e = declineOf("g.V(1).valueMap().mergeV(__.select('name'))");
    expect(e.kind).toBe('map-scope-shadow');
    expect(e.message).toStartWith("this traversal is not supported yet: a merge over a stream of Maps cannot use select('name')");
  });

  test('a terminal reason recorded while planning a barrier RESUME is that resume\'s decline', () => {
    expect(() => executeFramed(seededStore(), "g.V().has('name', regex('m.*')).map(__.V().sample(1).values('name'))"))
      .toThrow(`this traversal is not supported yet: ${SHARED}; use local(__.V()…sample(1)) to draw per row`);
  });

  test('a traversal no lowering covers still says so', () => {
    const q = "g.V().fold().map(__.unfold().values('age').math('_ + 1').by(__.V().count()))";
    const e = declineOf(q);
    expect(e.kind).toBe('uncovered');
    expect(e.message).toBe(`this traversal is not supported yet: no lowering covers ${q}`);
  });
});

describe('an ADVISORY reason is a hint, never the decline', () => {
  const advisory = { kind: 'map-scope-shadow', message: 'a probe declined here', terminal: false } as const;

  test('a note from a probe whose sibling route succeeds is not reported', () => {
    const declines = new Declines();
    declines.note(advisory);
    // The compile answered: nothing to raise.
    expect(() => declines.raiseTerminal()).not.toThrow();
    expect(declines.terminal()).toBeNull();
  });

  test('on a compile that found no lowering it is APPENDED to "no lowering covers", not substituted', () => {
    const declines = new Declines();
    declines.note(advisory);
    declines.note({ ...advisory, message: 'a later probe' });
    const e = declines.uncovered('g.V().x()');
    expect(e.kind).toBe('uncovered');
    expect(e.message).toBe('this traversal is not supported yet: no lowering covers g.V().x() — a probe declined here');
  });

  test('a terminal reason replaces the message, whatever advisory came first', () => {
    const declines = new Declines();
    declines.note(advisory);
    declines.note({ kind: 'resource-under-absent', message: 'first', terminal: true });
    declines.note({ kind: 'shared-draw', message: 'second', terminal: true });
    expect(declines.uncovered('g.V().x()').message).toBe('this traversal is ambiguous: first');
    expect(() => declines.raiseTerminal()).toThrow('this traversal is ambiguous: first');
  });
});
