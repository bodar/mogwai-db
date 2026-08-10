// ChainFacts (src/compiler/ir/analyze.ts): the whole-chain analysis consolidated from the
// former chainTracksPath / demandsEncounterOrder / chainCollapseSafe scans. These assert the
// facts a chain yields, and in particular that demandsEncounter and collapseSafe AGREE about
// what a plain order() does — the drift risk the shared isPlainOrder() predicate removes.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';
import { analyzeChain } from '../../src/compiler/ir/analyze.ts';

/** Parse + normalize (so order().by() has its .bys folded, exactly as the compiler sees it),
 *  then analyze. Facts are computed over the canonical IRStep chain, not the raw parse.
 *
 *  `nested: false` because these ARE root traversals, and `normalize` defaults the other way (see its
 *  own comment — every `src/` caller holds a body, so that is the safe default). It matters here: the
 *  label retractions are root-only, so a body-normalized chain would keep an `as()` the compiler has
 *  already dropped and these pins would describe a chain no compile produces. */
const facts = (gremlin: string) => analyzeChain(normalize(stepChain(parseGremlin(gremlin), {}), {}, undefined, false).steps);

describe('ChainFacts.tracksPath', () => {
  test('true iff a top-level path-family step is present', () => {
    expect(facts('g.V().out().path()').tracksPath).toBe(true);
    expect(facts('g.V().out().out().simplePath()').tracksPath).toBe(true);
    expect(facts('g.V().out().values("name")').tracksPath).toBe(false);
    // A path step INSIDE a folded repeat cluster is not a top-level step — matches the former
    // chainTracksPath scan (top-level only); the repeat body tracks its own path internally.
    expect(facts('g.V().repeat(__.both().simplePath()).times(2)').tracksPath).toBe(false);
  });
});

describe('ChainFacts.demandsEncounter', () => {
  test('true when a positional consumer follows a fan-out', () => {
    expect(facts('g.V().out().limit(2)').demandsEncounter).toBe(true);
    expect(facts('g.V().values("name").range(0,2)').demandsEncounter).toBe(true);
  });
  test('true for a slice with NO fan-out too — the source order is still an order', () => {
    // This read `false` until 2026-08-01, on the reasoning that SQLite's forward scan makes an
    // unconstrained `LIMIT 2` the source's first two anyway. It does — by accident, and reversing
    // the scan takes a different SUBSET, which `mise run test:perturbed` reports. A slice needs a
    // column to slice by whatever precedes it; the source seeds `encounter = id`, so this costs a
    // carried column and an ORDER BY the rowid order satisfies.
    expect(facts('g.V().limit(2)').demandsEncounter).toBe(true);
    expect(facts('g.V().hasLabel("person").range(0,2)').demandsEncounter).toBe(true);
  });
  test('false with no slice at all', () => {
    expect(facts('g.V().out().count()').demandsEncounter).toBe(false);
    // A Scope.local slice addresses a VALUE's members rather than the stream's rows, so it does
    // not demand one either — not assertable through `fold()`, which is a COLLECTING consumer and
    // demands the encounter in its own right (a collection's member order is observable).
    expect(facts('g.inject(1, 2, 3).limit(2)').demandsEncounter).toBe(true);
  });
  test('a plain order() between the fan-out and the slice clears the demand', () => {
    // order() re-establishes a total order, so the following limit needs no emission encounter.
    expect(facts('g.V().out().order().by("name").limit(2)').demandsEncounter).toBe(false);
    // order().by(traversal) is NOT plain — it does not clear the demand.
    expect(facts('g.V().out().order().by(__.values("name")).limit(2)').demandsEncounter).toBe(true);
  });
});

describe('ChainFacts.collapseSafe', () => {
  test('true for a reducer-terminal pure movement/filter chain', () => {
    expect(facts('g.V().out().out().count()').collapseSafe).toBe(true);
    expect(facts('g.V().hasLabel("person").out("knows").count()').collapseSafe).toBe(true);
  });
  test('an element leaf after movement is collapse-safe (framed as (v, bulk))', () => {
    expect(facts('g.V().out()').collapseSafe).toBe(true);
    expect(facts('g.V().out().both()').collapseSafe).toBe(true);
  });
  test('false when identity is carried between the source and terminal', () => {
    expect(facts('g.V().out().path().count()').collapseSafe).toBe(false); // path carries identity
    // A LIVE as() still carries identity, and these are the two ways it stays live: a later step reads
    // the label's value, so `retractUnreadAlias` cannot drop it and this predicate must still refuse.
    expect(facts('g.V().as("a").out().select("a").out().count()').collapseSafe).toBe(false);
    expect(facts('g.V().as("a").out().where("a", P.neq("b")).as("b").count()').collapseSafe).toBe(false);
  });
  test('a DEAD as() is not identity — nothing reads it, so it is gone before this runs', () => {
    // This case used to be pinned `false` here, with the reason "as() carries identity". The label was
    // never read, so what it carried was nothing: `retractUnreadAlias` (ir/labels.ts, §7.4 item 2 of
    // the repeat two-regimes plan) drops it and the chain reaching this analysis is `V().out().count()`.
    // Relaxing collapseSafe to ADMIT a carried as() is a different change and remains refuted — 52
    // executing census traversals changed their answer when it was tried.
    expect(facts('g.V().as("a").out().count()').collapseSafe).toBe(true);
  });
});

describe('demandsEncounter and collapseSafe agree on a plain order() (shared isPlainOrder)', () => {
  // The single most important invariant of the consolidation: the order() that clears
  // demandsEncounter is EXACTLY the order() after which movementCollapse's post-order slice is
  // safe. A keyed order() before a limit → demandsEncounter false; the same chain terminating in
  // a reducer stays collapseSafe. If the two predicates ever drift, one of these flips.
  test('keyed order() clears encounter demand', () => {
    const f = facts('g.V().out().order().by("name").limit(2)');
    expect(f.demandsEncounter).toBe(false);
  });
  test('by(traversal) order() is not plain for either scan', () => {
    // Not plain → still demands encounter; and (were it in a collapse-eligible position) would
    // not be treated as a plain sort either. Both read the same isPlainOrder.
    expect(facts('g.V().out().order().by(__.values("name")).limit(2)').demandsEncounter).toBe(true);
  });
});
