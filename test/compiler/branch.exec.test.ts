// Compiler execution semantics (split from test/compiler.test.ts) — branch (and/or/union/choose/coalesce/optional/map).
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe("branch execution", () => {









test('scalar-producing leaves re-enter common lowering', () => {
  const store = seededStore();
  expect(run(store, 'g.V().math("_").by("age").is(P.gt(30)).count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V().as("a").out("created").as("b").math("b + a").by(__.in("created").count()).by("age")').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([32, 33, 35, 38]);
  expect(run(store, 'g.V().format("%{age}").count()').map((r) => r.v)).toEqual([4]);
  expect(run(store, 'g.V().format("%{name} has %{_}").by(__.bothE().count())').map((r) => r.v).sort())
    .toEqual(['josh has 3', 'lop has 3', 'marko has 3', 'peter has 1', 'ripple has 1', 'vadas has 1']);
  expect(run(store, 'g.withSack(7).V().sack().is(7).count()').map((r) => r.v)).toEqual([6]);
});

test('sack clones through a union() fork (TinkerPop split-only, no merge)', () => {
  const store = seededStore();
  // withSack(5) then union(out, out): each arm gets a CLONE of sack=5; the arms never
  // recombine, so every one of marko's 3×2 endpoints carries the pre-fork value 5.
  expect(run(store, 'g.withSack(5L).V(1).union(__.out(), __.out()).sack()').map((r) => r.v))
    .toEqual([5, 5, 5, 5, 5, 5]);
  // a sack assigned BEFORE the fork rides into both arms unchanged.
  expect(run(store, "g.withSack(0L).V(1).sack(assign).by('age').union(__.identity(), __.identity()).sack()").map((r) => r.v))
    .toEqual([29, 29]); // marko's age, cloned into each identity arm
});












});

