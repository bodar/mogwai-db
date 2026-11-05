import { expect, spyOn, test } from 'bun:test';
import * as check from '../../src/rel/check.ts';
import * as lower from '../../src/compiler/rel/lower.ts';
import { compile } from '../../src/compiler/compiler.ts';

/**
 * COMPILE WORK OVER THE WHOLE L1 CORPUS — a ratchet on how many times the compiler lowers and emits.
 *
 * Compile CPU is invisible to every answer: a change that lowers a plan twice, or emits it three times
 * (which writes once did, `emit-once.exec.test.ts`), keeps the whole suite green and only costs CPU per
 * request. A wall-clock gate would flake, so this counts the two expensive operations instead —
 * `lowerToRel` and `checkPlan` (run once by every emission) — spied on their module namespaces, so no
 * production counter exists. The compile budget (`compile-budget.test.ts`) meters SQL BYTES; this meters
 * WORK, so a slower compiler that emits the same SQL still shows up.
 *
 * The ceilings are today's counts. A rise means duplicated work: find it rather than raise the number. A
 * fall is an improvement: lower the number in the same commit. A corpus regeneration (`regen-corpus.ts`)
 * re-records them. Queries compile without their parameters, so some decline; that is deterministic.
 */
const CEILING = { lowerings: 2016, emissions: 1797, perQuery: 12 } as const;

const corpus = (await Bun.file(new URL('../L1-corpus/corpus.txt', import.meta.url)).text()).split('\n').filter(Boolean);

test('the L1 corpus compiles within its lowering and emission ceilings', () => {
  const lowerings = spyOn(lower, 'lowerToRel'), emissions = spyOn(check, 'checkPlan');
  try {
    let perQuery = 0;
    for (const q of corpus) {
      const before = lowerings.mock.calls.length + emissions.mock.calls.length;
      try { compile(q, {}); } catch { /* a decline still did its work; it is counted */ }
      perQuery = Math.max(perQuery, lowerings.mock.calls.length + emissions.mock.calls.length - before);
    }
    expect(lowerings.mock.calls.length).toBeLessThanOrEqual(CEILING.lowerings);
    expect(emissions.mock.calls.length).toBeLessThanOrEqual(CEILING.emissions);
    expect(perQuery).toBeLessThanOrEqual(CEILING.perQuery);
  } finally {
    lowerings.mockRestore(); emissions.mockRestore();
  }
}, 60_000); // ~2,400 compiles; generous for a slow CI runner
