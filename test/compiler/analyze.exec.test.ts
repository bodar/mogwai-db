// ChainFacts (src/compiler/ir/analyze.ts): the whole-chain analysis consolidated from the
// former chainTracksPath / demandsEncounterOrder / chainCollapseSafe scans. These assert the
// facts a chain yields, and in particular that demandsEncounter and collapseSafe AGREE about
// what a plain order() does — the drift risk the shared isPlainOrder() predicate removes.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { normalize } from '../../src/compiler/ir/passes.ts';
import { analyzeChain } from '../../src/compiler/ir/analyze.ts';
import { bulkObservedFrom } from '../../src/compiler/ir/bulk.ts';

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
  test('group() distinguishes an ordered member collection from a reducing value traversal', () => {
    expect(facts('g.V().group().by(T.label)').demandsEncounter).toBe(true);
    expect(facts('g.V().group().by(T.label).by("name")').demandsEncounter).toBe(true);
    expect(facts('g.V().group().by(T.label).by(__.fold())').demandsEncounter).toBe(true);
    expect(facts('g.V().group().by(T.label).by(__.count())').demandsEncounter).toBe(false);
    expect(facts('g.V().group().by(T.label).by(__.out().count())').demandsEncounter).toBe(false);
    expect(facts('g.V().group().by(T.label).by(__.outE().values("weight").sum())').demandsEncounter).toBe(false);
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
  test('a count-valued group with a non-fan-out key is a collapse-safe terminal', () => {
    expect(facts('g.V().out().group().by(T.label).by(__.count())').collapseSafe).toBe(true);
    expect(facts('g.V().out().group().by(__.label()).by(__.count())').collapseSafe).toBe(false);
    expect(facts('g.V().out().group().by(T.label).by(__.sum())').collapseSafe).toBe(false);
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

describe('bulkObservedFrom — the POSITIONAL half (src/compiler/ir/bulk.ts)', () => {
  /** The suffix question, asked at the position a collapse would sit at. `from` is the index AFTER the
   *  hop being collapsed, which is what the movement fold passes (`at + 1`). */
  const observed = (gremlin: string, from: number) =>
    bulkObservedFrom(normalize(stepChain(parseGremlin(gremlin), {}), {}, undefined, false).steps, from);

  test('an element leaf observes it — that framing RLEs (v, bulk) onto the wire', () => {
    expect(observed('g.V().out()', 2)).toBe(true);
    expect(observed('g.V().out().both()', 2)).toBe(true);
    expect(observed('g.V().out().has("name","marko")', 2)).toBe(true);
  });

  test('a global reducer observes it, and ENDS the question — nothing behind it sees a multiplicity', () => {
    expect(observed('g.V().out().count()', 2)).toBe(true);
    expect(observed('g.V().out().out().count()', 2)).toBe(true);
    // `count()` is a barrier with a seed, so a step AFTER it reads one row and no bulk.
    expect(observed('g.V().out().count().is(P.gt(2))', 2)).toBe(true);
  });

  test('THE LEAF IS A QUESTION, NOT AN ASSUMPTION: only `elements` carries bulk to the wire', () => {
    // The finding this module records. A scalar/list/map/record/path leaf projects no `bulk` column
    // (`lower.ts`'s `framed` — every arm but `elements`), so N traversers would answer as ONE row.
    expect(observed('g.V().out().values("name")', 2)).toBe(false);
    expect(observed('g.V().out().fold()', 2)).toBe(false);
    expect(observed('g.V().out().path()', 2)).toBe(false);
    // ...but the same projection feeding a reducer is fine: it carries bulk as an ordinary column
    // into the scalar vocabulary, and the reducer weights by it.
    expect(observed('g.V().out().values("age").sum()', 2)).toBe(true);
    expect(observed('g.V().out().id().count()', 2)).toBe(true);
  });

  test('a slice is admitted only behind a plain order(), because bulkSlice needs a position to trim along', () => {
    // The widening the chain verdict cannot express: it admits a post-order slice ONLY under an
    // element terminal, since it cannot see that a reducer behind the slice sums what was trimmed.
    expect(observed('g.V().out().order().by("name").limit(2).count()', 2)).toBe(true);
    expect(observed('g.V().out().order().by("name").tail(2)', 2)).toBe(true);
    // With no order there is nothing to accumulate along — `sliceOp` declines a bulked relation
    // outright, so admitting the collapse here would cost COVERAGE, not just tractability.
    expect(observed('g.V().out().limit(2)', 2)).toBe(false);
    expect(observed('g.V().out().range(0,2).count()', 2)).toBe(false);
    // order().by(traversal) is not plain (shared isPlainOrder), so it opens nothing.
    expect(observed('g.V().out().order().by(__.values("name")).limit(2)', 2)).toBe(false);
  });

  test('`sample` reads rows at EVERY position — a uniform sample of rows is not one of traversers', () => {
    expect(observed('g.V().out().sample(2)', 2)).toBe(false);
    expect(observed('g.V().out().order().by("name").sample(2)', 2)).toBe(false);
  });

  test('a dedup() RESETS the multiplicity, so it ends the question too', () => {
    // DedupGlobalStep.filter calls setBulk(1L) unconditionally, and every arm rowOp admits projects
    // the literal 1. So a slice BEHIND a dedup never meets a multiplicity.
    expect(observed('g.V().out().dedup()', 2)).toBe(true);
    expect(observed('g.V().out().dedup().limit(2)', 2)).toBe(true);
    expect(observed('g.V().out().dedup().by("name").count()', 2)).toBe(true);
    // Scope.local addresses a VALUE's members, not the stream's rows — a different step wearing the
    // same name, and not one shown to reset anything here.
    expect(observed('g.V().out().fold().dedup(Scope.local)', 2)).toBe(false);
  });

  test('an as() is transparent — a label bound AFTER a collapse is well-defined per distinct id', () => {
    // §7.2's positional half: the chain verdict refuses any as() in the prefix because it cannot tell
    // a label bound before a collapse from one bound after it. This can.
    expect(observed('g.V().out().as("a").out().count()', 2)).toBe(true);
    expect(observed('g.V().out().as("a").count()', 2)).toBe(true);
  });

  test('unlearned vocabulary declines, which costs an opportunity and never an answer', () => {
    // `select` is the next candidate and is deliberately not admitted yet (see the module header).
    // NOTE the terminal: under a `count()` the select would not be here at all — `retractUnobservedSelect`
    // (§7.4 item 3) deletes it because a count observes no value, and `retractUnreadAlias` then drops
    // the dead `as()`, so `…as("a").out().select("a").count()` normalizes to `V().out().out().count()`
    // and answers TRUE for a chain that no longer contains either step. Pin the OBSERVABLE form.
    expect(observed('g.V().out().as("a").out().select("a")', 2)).toBe(false);
    expect(observed('g.V().out().as("a").out().select("a").values("name")', 2)).toBe(false);
    expect(observed('g.V().out().union(__.out(),__.in()).count()', 2)).toBe(false);
    expect(observed('g.V().out().aggregate("x").count()', 2)).toBe(false);
    expect(observed('g.V().out().groupCount().by(__.label())', 2)).toBe(false);
  });

  test('a non-fan-out groupCount/group-by-count observes it (Calcite CountSplitter)', () => {
    expect(observed('g.V().out().groupCount()', 2)).toBe(true);
    expect(observed('g.V().out().groupCount().by("name")', 2)).toBe(true);
    expect(observed('g.V().out().group().by(T.label).by(__.count())', 2)).toBe(true);
    expect(observed('g.V().out().group().by(T.label).by(__.sum())', 2)).toBe(false);
  });

  test('asked past the end of the chain, the last movement IS the element leaf', () => {
    expect(observed('g.V().out()', 9)).toBe(true);
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
