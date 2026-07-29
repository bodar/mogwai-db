// Capability ratchet over the independently-authored L5 shape table. This is not
// derived from lowering dispatch maps: a valid transition may compile, defer, or
// expose a bug, and only the last outcome is forbidden here.
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { seeded } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { outcomeOf, ALL_GENERIC } from './oracle.ts';
import { transitionWitnesses, traversal } from './generate.ts';
import { KNOWN_RAW_WITNESSES } from './capability-baseline.ts';

const RAW_FAILURE = /^(?:Binding expected |.*\b(?:TypeError|RangeError)\b)|\b(?:syntax error|constraint failed|no such (?:column|table))\b/i;

describe('L5 capability ratchet', () => {
  test('every declared transition witness and generated composition either execute or fail closed', () => {
    const seed = Number(process.env.L5_SEED ?? 42);
    const samples = fc.sample(traversal({ steps: 5, depth: 2 }), { seed, numRuns: 240 });
    const witnesses = transitionWitnesses();
    const raw: string[] = [];
    const seenKnown = new Set<string>();
    let ran = 0;
    let deferred = 0;
    for (const query of [...witnesses.map((witness) => witness.query), ...samples.map((generated) => generated.query)]) {
      const outcome = outcomeOf(seeded(MODERN_SEED), query, ALL_GENERIC);
      if (outcome.kind === 'rows') { ran++; continue; }
      deferred++;
      if (RAW_FAILURE.test(outcome.message)) {
        const expected = KNOWN_RAW_WITNESSES.get(query);
        if (expected === outcome.message) seenKnown.add(query);
        else raw.push(`${query}\n    ${outcome.message}`);
      }
    }
    console.log(`L5 capability: ${witnesses.length} transition witnesses + ${samples.length} generated compositions — ${ran} ran, ${deferred} declared deferrals`);
    expect(raw).toEqual([]);
    // A baseline row that no longer occurs is an improvement, not a failure. Keep it
    // visible so the next intentional update can delete the stale diagnosis.
    const stale = [...KNOWN_RAW_WITNESSES.keys()].filter((query) => !seenKnown.has(query));
    if (stale.length) console.log(`L5 capability: ${stale.length} known raw witness(es) not drawn by this seed`);
  }, 120_000);
});
