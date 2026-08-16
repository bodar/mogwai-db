// Compiler execution semantics (split from test/compiler.test.ts) — branch (and/or/union/choose/coalesce/optional/map).
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

/** Decode a result set to plain JS (a Map → object, an array recurses) — for the folded-list cases below
 *  whose value is a GraphBinary map, not a raw SQL column. */
const decodedRows = async (q: string): Promise<any[]> => {
  const store = seededStore();
  const norm = (v: any): any =>
    v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)])) : Array.isArray(v) ? v.map(norm) : v;
  return (await decodeAll(executeQuery(store, q))).map(norm);
};

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

test('a union() at the HEAD of a project().by() arm folds to a per-host list', async () => {
  // The union fans marko out over both arms, correlated to the host row; the trailing
  // values().fold() reduces to one list per host. Rooted at a one-row SELF relation so
  // `continueAs` lowers the chain-position branch, then the per-origin fold composes.
  const rows = await decodedRows("g.V().hasLabel('person').has('name','marko').project('net').by(__.union(__.out('knows'), __.out('created')).values('name').fold())");
  // marko knows {vadas, josh} and created {lop} → the union's names, folded.
  expect((rows[0].net as string[]).map(String).sort()).toEqual(['josh', 'lop', 'vadas']);
});

test('an emit-unrolled recurse folds inside a by() — the @recurse shape', async () => {
  // repeat(out).emit().times(2) unrolls to union(out, out.out); inside a by().fold() it is the
  // per-host reachability list to depth 2. marko: knows {vadas, josh}; neither knows anyone → depth 2 empty.
  const rows = await decodedRows("g.V().hasLabel('person').has('name','marko').project('net').by(__.repeat(__.out('knows')).emit().times(2).values('name').fold())");
  expect((rows[0].net as string[]).map(String).sort()).toEqual(['josh', 'vadas']);
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

