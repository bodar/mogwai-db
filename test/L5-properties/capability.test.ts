// Capability ratchet over the independently-authored L5 shape table. This is not
// derived from lowering dispatch maps: a valid transition may compile, defer, or
// expose a bug, and only the last outcome is forbidden here.
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { seeded } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { outcomeOf, ALL_GENERIC, INTERNAL_ERROR } from './oracle.ts';
import { transitionWitnesses, traversal } from './generate.ts';
import { KNOWN_RAW_WITNESSES } from './capability-baseline.ts';
import { L5_SEED } from './seed.ts';
import { describeThrow, failsClosed } from '../support/fail-closed.ts';


describe('L5 capability ratchet', () => {
  test('every declared transition witness and generated composition either execute or fail closed', () => {
    const seed = L5_SEED;
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
      if (INTERNAL_ERROR.test(outcome.message)) {
        const expected = KNOWN_RAW_WITNESSES.get(query);
        if (expected === outcome.message) seenKnown.add(query);
        else raw.push(`${query}\n    ${outcome.message}`);
      }
    }
    console.log(`L5 capability: ${witnesses.length} transition witnesses + ${samples.length} generated compositions — ${ran} ran, ${deferred} declared deferrals`);
    expect(raw).toEqual([]);
    // Every baseline entry is run UNCONDITIONALLY, not merely looked for among the queries this
    // seed drew. That distinction is the whole check: computed over the drawn set, "stale" also
    // meant "not drawn", so a FIXED entry was indistinguishable from an unlucky sample and the
    // ratchet printed the same ambiguous line on every run while one entry sat here already fixed.
    // Run directly, a stale entry can only mean fixed — so it FAILS, and deleting it is the fix.
    const stale = [...KNOWN_RAW_WITNESSES].filter(([query, message]) => {
      if (seenKnown.has(query)) return false;
      const outcome = outcomeOf(seeded(MODERN_SEED), query, ALL_GENERIC);
      return outcome.kind === 'rows' || outcome.message !== message;
    }).map(([query]) => query);
    expect(stale).toEqual([]);
  }, 120_000);

  /**
   * NO INTERNAL ERROR ESCAPES — deeper compositions than the ratchet above draws, plus the internal
   * errors reviewers reached by hand, each run as a fixed witness. Every throw must PASS `failsClosed`
   * (`test/support/fail-closed.ts`): an `UnsupportedTraversal`, a data-raised reference error, or a
   * message the reference corpus itself asserts. Positive, not a list of known-bad shapes, so an internal
   * error nobody has seen yet fails here too, with no baseline to absorb it. (The federate seams, which
   * this single-graph generator cannot reach, have the same sweep in `test/federation.test.ts`.)
   */
  test('no generated composition surfaces an internal error', () => {
    const witnesses = [
      "g.V().hasLabel('person').order().by(addV('x').fold())",
      "g.V().as('a').out('knows').union(select('a'), identity())",
      "g.V().local(__.fold().unfold().optional(__.identity()).has('name','lop')).both().fold().count(local)",
      "g.E().filter(__.inV().dedup().group().by('lang').select('keys'))",
      "g.V(1).as('a','a').select(Pop.all,'a')",
    ];
    const deep = fc.sample(traversal({ steps: 8, depth: 3 }), { seed: L5_SEED, numRuns: 200 }).map((generated) => generated.query);
    const internal: string[] = [];
    for (const query of [...witnesses, ...deep]) {
      const outcome = outcomeOf(seeded(MODERN_SEED), query, ALL_GENERIC);
      if (outcome.kind === 'threw' && !failsClosed(outcome.error))
        internal.push(`${query}\n    ${describeThrow(outcome.error)}`);
    }
    expect(internal).toEqual([]);
  }, 120_000);
});
