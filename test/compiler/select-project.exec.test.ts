// Compiler execution semantics (split from test/compiler.test.ts) — select / project / match / RecordStream.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { run, runWith, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe("select/project execution", () => {
test('select("a") returns the labelled vertex (id after two hops recovered)', () => {
  const store = seededStore();
  // marko(1) as 'a', hop to who he knows, select back to marko each time
  const ids = run(store, 'g.V(1).as("a").out("knows").select("a")').map((r) => r.id);
  expect(ids).toEqual([1, 1]); // marko knows vadas+josh → two traversers, both select marko
});

test('single-label select re-enters element/scalar lowering', () => {
  const store = seededStore();
  // marko is selected once per outgoing traverser (3), then traversed out again (3 each).
  expect(run(store, 'g.V(1).as("a").out().select("a").out().count()').map((r) => r.v)).toEqual([9]);
  expect(run(store, 'g.V(1).outE("knows").as("e").select("e").inV().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'vadas']);
  expect(run(store, 'g.V().as("a").out().select("a").by("age").is(P.gt(30)).count()').map((r) => r.v)).toEqual([3]);
});



/**
 * A RECORD ROW as a plain object.
 *
 * A record arrives as the one `map` JSONB column of `[[key, valueNode], …]` pairs; the fallback
 * branch reads the older prefixed-column spelling (`e0_v`, `e1_id`, …). Reading the value out here —
 * rather than pinning assertions to a column layout — is what keeps these VALUE assertions about
 * values, so they survive the lowering moving under them.
 */
const recordRow = (row: any, keys: readonly string[]): Record<string, any> => {
  if (typeof row.map === 'string') {
    const node = (v: any): any => (v && typeof v === 'object' && 't' in v ? v.v : v);
    return Object.fromEntries((JSON.parse(row.map) as [string, any][]).map(([k, v]) => [k, node(v)]));
  }
  return Object.fromEntries(keys.map((k, i) => [k, row[`e${i}_v`] ?? row[`e${i}_id`]]).filter(([, v]) => v !== undefined));
};

test('project builds columns from the current traverser', () => {
  const store = seededStore();
  {
    const rows = runWith(store, 'g.V().hasLabel("person").project("name","age").by("name").by("age")');
    const byName = Object.fromEntries(rows.map((r) => Object.values(recordRow(r, ['name', 'age']))));
    expect(byName).toEqual({ marko: 29, vadas: 27, josh: 32, peter: 35 });
  }
});



test('rebinding a label (as("a")…as("a")) keeps default Pop=last', () => {
  const store = seededStore();
  // 'a' bound at marko then rebound at each out-neighbour; select('a') = last
  const ids = run(store, 'g.V(1).as("a").out("knows").as("a").select("a")').map((r) => r.id).sort();
  expect(ids).toEqual([2, 4]); // vadas, josh — the rebound (last) positions
});








// `select(label).by(key)` over a VALUE-shaped parent used to return the labelled ELEMENT and drop
// the by() — byte-identical to the by()-less form, so the modulator vanished silently. Only
// `lowerSingleSelect` (over an element stream) applies modulators; `dispatchAlias` routes a
// scalar/list/variant parent straight to the shape-agnostic resolver, which is by()-less by
// contract. That contract is now enforced there rather than assumed.
//
// This asserts the DEFERRAL, not the answer: 'marko' is what TinkerPop gives, and reaching it means
// reaching the modulator owner from a value-shaped parent (see
// docs/archive/2026-07-28-match-string-frontend-design.md). Pinned so it cannot regress to the wrong answer
// — a test that accepted the vertex here would have locked the bug in.
// `select(label).by(key)` composed in the MAIN chain but was declined at every CHILD position: the
// shape classifier read only what the label held and never the modulator, so a by()-projected
// element never registered as a scalar producer. Each case is pinned against its `values(key)`
// equivalent rather than a literal — the two are the same computation, so an equivalence failure
// means one of the routes drifted, which a hand-written expectation could not tell us.
describe('select(label).by(key) as a child body', () => {
  // Classify must admit only what emit serves. A TOKEN by (`by(T.id)`) is rejected by the emitter,
  // so the classifier must not admit it either — a classify/emit mismatch is a crash, not a
  // deferral, because consumers assert on the classification.
  test('a token by() stays declined, so classify and emit admit the same set', () => {
    const store = seededStore();
    expect(() => run(store, 'g.V().as("a").out("knows").map(__.select("a").by(T.id))')).toThrow();
  });
});



});

// The alias comparison is ONE test over ONE row re-projection, so it composes with every shape
// that physically carries the alias columns — not just the two that happened to implement it.
//
// It was two ~28-line copies (`where`'s alias branch in prefix/filter.ts and `recordWhere` here),
// identical down to the `where().by(key) on an edge-typed label` message being written out twice,
// and it ran on element and record only. The index read them as differing in "how a label resolves
// to {id, elem}"; they do not — that is one function over a different RELATION.
describe('the alias comparison is shape-uniform', () => {
  // Every shape's rows are the same 6 traversers' worth of a→b pairs, so the property under test is
  // stated as a PARTITION rather than a value table: eq and neq must split the unfiltered rows, on
  // every shape, without anyone having to say what the rows contain.
  // TRAVERSERS, not rows. A partition law is about cardinality of the traverser stream, and a row is
  // not a traverser: RelIR collapses convergent walks per POSITION now, so the unfiltered chain (whose
  // two aliases are dead and retracted) comes back RLE-encoded as 3 rows carrying 12 traversers while
  // each `where()` half keeps its labels live, cannot collapse, and comes back as 12 rows. Counting
  // rows made that read as 3 != 12 — a broken law where the law holds exactly. §7.5 of the repeat
  // two-regimes plan: the row count legitimately moves under a collapse and is not the answer.






});
