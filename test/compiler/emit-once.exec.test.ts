import { describe, expect, spyOn, test } from 'bun:test';
import * as check from '../../src/rel/check.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { lowerToRel } from '../../src/compiler/rel/lower.ts';
import { finishLowering } from '../../src/compiler/rel/spine.ts';
import { emit } from '../../src/rel/emit.ts';
import { extractStrategies, parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { BunGraphManager } from '../../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../../src/services/standard.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { decode } from '../support/decode.ts';

/**
 * ONE EMISSION PER LOWERING — a plan crosses out of the algebra once (`renderLowered`), and the value
 * travels on `RelLowering.rendered` to `finishLowering`, which assembles from it and emits nothing.
 *
 * Before, every write emitted its plan THREE times per compile (the bind-budget probe in `lowered()`,
 * `finishLowering`, then `renderProgram`) and every read TWICE — the same SQL each time, so the cost was
 * CPU per request and nothing a result could show. That is exactly why it needs a test of its own: the
 * whole suite stays green with the duplicate emissions back.
 *
 * The meter is `checkPlan`, which every emission runs exactly once (`emitProgram`), spied on the
 * module namespace so no production counter exists. A compile that lowers once must check once.
 */
const emissions = <T>(fn: () => T): { readonly value: T; readonly count: number } => {
  const spy = spyOn(check, 'checkPlan');
  try {
    const value = fn();
    return { value, count: spy.mock.calls.length };
  } finally { spy.mockRestore(); }
};

const emissionsAsync = async <T>(fn: () => Promise<T>): Promise<{ readonly value: T; readonly count: number }> => {
  const spy = spyOn(check, 'checkPlan');
  try {
    const value = await fn();
    return { value, count: spy.mock.calls.length };
  } finally { spy.mockRestore(); }
};

const chainOf = (q: string): IRStep[] => {
  const tree = parseGremlin(q);
  return runPasses(stepChain(tree, NO_PARAMS), extractStrategies(tree, NO_PARAMS), NO_PARAMS).steps as IRStep[];
};

/** Every compile shape that lowers ONCE: a read, a write program with and without a framing read, a
 *  discard, and the same at depth — inside local/where/group bodies, after as()/select(), a repeat. */
const ONE_LOWERING: readonly (readonly [string, 'read' | 'program'])[] = [
  ["g.V().out().order().by('name')", 'read'],
  [MODERN_SEED[0]!, 'program'],
  ['g.V().drop()', 'program'],
  ["g.V().has('age', gt(30)).drop()", 'program'],
  ["g.V().hasLabel('person').property('x', 1).values('name')", 'program'],
  ["g.V().as('a').out().select('a').property('y', 2).id()", 'program'],
  ["g.mergeV([name:'z']).option(Merge.onCreate, [age: 1]).id()", 'program'],
  ["g.V().local(__.out().order().by('name').limit(1)).values('name')", 'read'],
  ["g.V().where(__.out().has('name','lop')).values('name').fold()", 'read'],
  ["g.V().group().by('name').by(__.out().count())", 'read'],
  ["g.V().repeat(__.out()).times(2).path().by('name')", 'read'],
];

describe('a compile emits its lowered plan exactly once', () => {
  for (const [query, kind] of ONE_LOWERING) {
    test(query, () => {
      const { value, count } = emissions(() => compile(query, {}));
      expect(value.kind).toBe(kind);
      expect(count).toBe(1);
    });
  }

  test('a barrier resume (segment.ts → finishLowering) emits once for the head and once for the tail', async () => {
    const mgr = new BunGraphManager(undefined, extendedRegistry);
    for (const g of MODERN_SEED) await mgr.executor('home').framedAsync(g, {});
    const { value, count } = await emissionsAsync(() =>
      mgr.executor('home').framedAsync('g.V().has("name", TextP.regex("^[mj]")).values("name")', {}));
    expect((await Promise.all(value.map((f) => decode(f.buf)))).sort()).toEqual(['josh', 'marko']);
    expect(count).toBe(2);
  });
});

describe('the carried rendering IS the rendering', () => {
  // The value `finishLowering` assembles from must be what an independent emission of the same plan
  // spells, statement for statement — otherwise carrying it would be a second, drifting authority.
  for (const [query] of ONE_LOWERING) {
    test(query, () => {
      const lowered = lowerToRel(chainOf(query), { params: NO_PARAMS, wireTerminal: true });
      expect(lowered).not.toBeNull();
      const compiled = finishLowering(lowered!);
      const fresh = emit(lowered!.plan).map((step) => step.emitted);
      const shipped = compiled.kind === 'read'
        ? [{ sql: compiled.sql, binds: compiled.binds }]
        : compiled.steps.map((step) => step.emitted);
      expect(shipped).toEqual(fresh);
    });
  }
});
