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
const SHARED = 'a random draw (sample/coin/shuffle) inside a V()/E() body is not supported where the body may run '
  + 'for more than one traverser — it would be drawn once and shared by every row';

describe('the lowering RECORDS a framing-decided decline and returns null — it never throws', () => {
  for (const [q, kind] of [
    ["g.V().has('age', __.V().sample(1).values('age'))", 'shared-draw'],
    ["g.V().map(__.V().coin(0.5).count())", 'shared-draw'],
    ["g.V().optional(__.out().as('a')).map(__.select('a').V().count())", 'resource-under-absent'],
    ["g.V().optional(__.out().as('a')).flatMap(__.select('a').V())", 'resource-under-absent'],
    ["g.V(1).valueMap().mergeV(__.select('name'))", 'merge-own-entry'],
  ] as const) {
    test(q, () => {
      const declines = new Declines();
      expect(lowerToRel(chainOf(q), { params: NO_PARAMS, declines })).toBeNull();
      expect(declines.terminal()?.kind).toBe(kind);
    });
  }
});

describe('a terminal reason is the message, and its prefix is a property of its kind', () => {
  // A ONCE-evaluated read (a predicate operand) shares one draw by every host: declined, naming no per-row form.
  test('a shared draw keeps its reason and a predicate operand names no per-row form', () => {
    for (const q of [
      "g.V().has('age', __.V().sample(1).values('age'))",
      "g.V().values('age').is(gt(__.V().sample(1).values('age')))",
    ]) {
      const e = declineOf(q);
      expect(e.kind).toBe('shared-draw');
      expect(e.message).toBe(`this traversal is not supported yet: ${SHARED}`);
    }
  });

  // A connector body that draws over a re-source draws per scope row (`reSourcedBody`/`drawnPerOrigin`,
  // `src/compiler/rel/lower/scoped.ts`) where the draw is a uniform pick; a `coin` or a `sample` that is not one
  // (weighted, local) keeps the shared-draw decline (`declinedDraw`) — the owner's call, R4.5 (A).
  test('a connector body whose draw over a re-source is not a uniform pick keeps the shared-draw reason', () => {
    for (const q of [
      "g.V().map(__.V().coin(0.5).count())",
      "g.V().local(__.V().coin(0.5).count())",
      "g.V().where(__.V().coin(0.5))",
      "g.V().hasLabel('person').local(__.V().hasLabel('software').coin(1.0)).count()",
      "g.V().local(__.V().sample(1).by('age'))",
      "g.V().hasLabel('holder').map(__.V().hasLabel('person').fold().sample(local,1)).count()",
    ]) {
      const e = declineOf(q);
      expect(e.kind).toBe('shared-draw');
      expect(e.message).toBe(`this traversal is not supported yet: ${SHARED}`);
    }
  });

  test('a connector body that draws a uniform pick over a re-source answers', () => {
    for (const q of [
      "g.V().map(__.V().sample(1).values('name'))",
      "g.inject(1,2).map(__.V().sample(1).values('name'))",
      "g.inject(1,2).project('x').by(__.V().sample(1).values('name'))",
      "g.inject(1,2).flatMap(__.project('x').by(__.V().sample(1).values('name')))",
      "g.V().out().map(__.V().hasLabel('person').sample(1).values('name').fold())",
    ]) expect(() => compilePlan(q, {})).not.toThrow();
  });

  test('a re-source under a maybe-absent label reads as ambiguous and keeps the advice', () => {
    const e = declineOf("g.V().optional(__.out().as('a')).map(__.select('a').V().count())");
    expect(e.kind).toBe('resource-under-absent');
    expect(e.message).toMatch(AMBIGUOUS);
    expect(e.message).toContain('did you mean to traverse FROM that value (out()/in()) or to filter by it (V().has(…, …))?');
  });

  // A value READ before the body's re-source is an ordinary filter: the row it drops is dropped by the map, and
  // the row it keeps has its value — nothing about the answer depends on an unbound label. The connector answers
  // it (each person's `math('_ + 1')` over the graph's count, 7); only a discarded `select()` of a label that may
  // be unbound is explained (`admitsReSource`).
  test('a re-source after a value read answers', () => {
    expect(() => compilePlan("g.V().map(__.values('age').math('_ + 1').by(__.V().count()))", {})).not.toThrow();
    expect(() => compilePlan("g.V().map(__.values('age').V().count())", {})).not.toThrow();
  });

  test('at depth: inside local(), a where() body and a union() arm', () => {
    for (const q of [
      "g.V().local(__.optional(__.out().as('a')).map(__.select('a').V().count()))",
      "g.V().where(__.optional(__.out().as('a')).map(__.select('a').V().count()).is(gt(0)))",
      "g.V().union(__.optional(__.out().as('a')).map(__.select('a').V().count()), __.constant(1))",
    ]) expect(declineOf(q).message).toMatch(AMBIGUOUS);
  });

  test('a merge select() over Maps that MAY hold the key names the side-effect collision', () => {
    const e = declineOf("g.withSideEffect('name',[age:1]).V(1).valueMap().mergeV(__.select('name'))");
    expect(e.kind).toBe('merge-map-scope');
    expect(e.message).toStartWith("this traversal is not supported yet: a Map stream MAY hold 'name' and a side effect 'name' is declared");
  });

  test('with no side effect it is a plain own-entry decline, with no rename advice', () => {
    const e = declineOf("g.V(1).valueMap().mergeV(__.select('name'))");
    expect(e.kind).toBe('merge-own-entry');
    expect(e.message).toBe("this traversal is not supported yet: reading a Map's own 'name' entry (select('name') over a stream of Maps) as a merge argument");
  });

  test('a terminal reason recorded while planning a barrier RESUME is that resume\'s decline', () => {
    expect(() => executeFramed(seededStore(), "g.V().has('name', regex('m.*')).has('age', __.V().sample(1).values('age'))"))
      .toThrow(`this traversal is not supported yet: ${SHARED}`);
  });

  test('a traversal no lowering covers still says so', () => {
    const q = "g.V().out().local(__.V().has('name','lop').count()).path()";
    const e = declineOf(q);
    expect(e.kind).toBe('uncovered');
    // The re-source's advisory reason (`reSourcedBody`) is a hint after the decline, never in its place.
    expect(e.message).toStartWith(`this traversal is not supported yet: no lowering covers ${q} — a V()/E() inside local()`);
  });
});

describe('an ADVISORY reason is a hint, never the decline', () => {
  const advisory = { kind: 'merge-map-scope', message: 'a probe declined here', terminal: false } as const;

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

// A HOST'S OWN DECLINE (`Declines.hostDeclined`, recorded by the connector dispatch) travels like any reason:
// recorded into a route's fork, it reaches the compile only through `adopt`. So whichever of a site's two routes is
// tried first, the record says the same thing — a route that declined while its sibling answered leaves none.
describe('a host-decline record follows fork/adopt', () => {
  const host = {};
  test('a fork that is not adopted leaves no record', () => {
    const declines = new Declines();
    declines.fork().hostDeclined(host);
    expect(declines.declinedAt(host)).toBe(false);
  });
  test('an adopted fork carries its record, at any depth', () => {
    const declines = new Declines();
    const outer = declines.fork();
    const inner = outer.fork();
    inner.hostDeclined(host);
    outer.adopt(inner);
    expect(declines.declinedAt(host)).toBe(false);
    declines.adopt(outer);
    expect(declines.declinedAt(host)).toBe(true);
    expect(declines.declinedAt({})).toBe(false);
  });
  test('an advisory displaces only the kind it names', () => {
    const declines = new Declines();
    declines.note({ kind: 'effect-in-child', message: 'collected', terminal: false });
    declines.note({ kind: 'write-in-child', message: 'other', terminal: false }, 'merge-map-scope');
    expect(declines.uncovered('q').message).toEndWith('— collected');
    declines.note({ kind: 'write-in-child', message: 'wrote', terminal: false }, 'effect-in-child');
    expect(declines.uncovered('q').message).toEndWith('— wrote');
  });
});
