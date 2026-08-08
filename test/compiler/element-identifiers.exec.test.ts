// The element-identifier rules (src/compiler/steps/write/validate.ts) — TinkerPop's
// `ElementHelper.validateProperty`/`validateLabel` and `Graph.Hidden`, which nothing here enforced.
//
// The merge half of this is covered by the official corpus (`MergeVertex.feature`,
// `MergeEdge.feature` assert the message text), so those cases live in L3. What the corpus does NOT
// cover is the same rule on the ORDINARY write steps — `addV`, `addE`, `property` — which accepted
// `~`-prefixed and empty identifiers and wrote them. `~` is TinkerPop's HIDDEN namespace: a graph
// that lets a user write there loses the ability to tell its own bookkeeping keys from theirs.
//
// These pin the two storage WAISTS (`labelNames` for every label, `applyVertexProperty`/
// `insertEdgeProperty` for every property key) rather than each write step, which is the point of
// having a waist — a new write step inherits the rule instead of having to remember it.
import { describe, expect, test } from 'bun:test';
import { grouped, runWith } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { validateLabel, validatePropertyKey } from '../../src/gremlin/validate.ts';

const store = () => new GraphStore(new BunSqlite(':memory:'));
const rejects = (q: string, message: string) => expect(() => runWith(store(), q)).toThrow(message);

describe('the identifier rules themselves', () => {
  test('a property key may not be null, empty or hidden', () => {
    expect(() => validatePropertyKey(null)).toThrow('Property key can not be null');
    expect(() => validatePropertyKey('')).toThrow('Property key can not be the empty string');
    expect(() => validatePropertyKey('~id')).toThrow('Property key can not be a hidden key: ~id');
    expect(validatePropertyKey('name')).toBe('name');
  });

  test('a label may not be null, empty or hidden', () => {
    expect(() => validateLabel(null)).toThrow('Label can not be null');
    expect(() => validateLabel('')).toThrow('Label can not be empty');
    expect(() => validateLabel('~vertex')).toThrow('Label can not be a hidden key: ~vertex');
    expect(validateLabel('person')).toBe('person');
  });
});

describe('every write reaches them through a waist', () => {
  test('labels — addV, addE and a multi-label list', () => {
    rejects("g.addV('~vertex')", 'Label can not be a hidden key: ~vertex');
    rejects("g.addV('')", 'Label can not be empty');
    rejects("g.addV('a','~b')", 'Label can not be a hidden key: ~b');
    rejects("g.addV('a').as('x').addV('b').as('y').addE('~knows').from('x').to('y')", 'Label can not be a hidden key: ~knows');
  });

  test('property keys — vertex and edge, on create and on a later property()', () => {
    rejects("g.addV('x').property('~id','y')", 'Property key can not be a hidden key: ~id');
    rejects("g.addV('x').property('','y')", 'Property key can not be the empty string');
    rejects("g.addV('a').as('x').addV('b').as('y').addE('knows').from('x').to('y').property('~w',1)",
      'Property key can not be a hidden key: ~w');
  });

  test('a merge map is validated as a MAP, so a search-only key is rejected too', () => {
    // `~id` here is a search criterion; against a matching graph it would never reach a writer.
    const s = store();
    runWith(s, "g.addV('vertex')");
    expect(() => runWith(s, "g.mergeV(['~id':1])")).toThrow('Property key can not be a hidden key: ~id');
  });

  test('the merge-map key rule fires from the verify PASS, so both spines raise it', () => {
    // `MergeElementStep.validate` calls `ElementHelper.validateProperty` on every String key of every
    // arm (gremlin-core `.../step/map/MergeElementStep.java:278,314-316`), and a STATIC key is
    // decidable from the TEXT. So it belongs in the shared parse, which the `writeArguments` verify
    // Pass runs ABOVE the routing switch (§6·5) — not in a route.
    //
    // It used to live only in legacy's `validateResolvedMergeSpec`, which made the refusal a spine's
    // property: RelIR had to DECLINE the whole traversal to reach the message, and the census then
    // counted a traversal TinkerPop itself rejects as an uncovered gap.
    for (const spine of ['rel', 'legacy'] as const)
      for (const [gremlin, message] of [
        ["g.mergeV([:]).option(Merge.onCreate,['~label':'vertex'])", 'Property key can not be a hidden key: ~label'],
        ["g.mergeV([:]).option(Merge.onMatch,['~id':1])", 'Property key can not be a hidden key: ~id'],
        ["g.mergeV(['':1])", 'Property key can not be the empty string'],
      ] as const)
        expect(() => runWith(store(), gremlin, { spine }), `${spine} ${gremlin}`).toThrow(message);
  });

  test('legal identifiers are untouched', () => {
    const s = store();
    expect(runWith(s, "g.addV('person').property('name','marko')")).toHaveLength(1);
    // A `~` anywhere but the START is an ordinary character, exactly as Graph.Hidden defines it.
    expect(runWith(s, "g.addV('per~son').property('na~me','marko')")).toHaveLength(1);
  });
});

// `T.id` at a by()-modulator position must denote the SAME id `id()` frames.
//
// Twelve hosts each wrote their own two-arm `token === 'label' ? … : token === 'id' ? …` resolver,
// and four of them returned the INTERNAL rowid. That is invisible on a graph whose ids are rowids —
// which the modern fixture is, and which is why nothing caught it — and becomes a wrong answer the
// moment a graph supplies its own ids. `tokenExpr` (plan/plan.ts) is now the one resolution, and it
// returns the outward-facing `COALESCE(uid, id)`.
describe('T.id is the outward-facing id at every by() position', () => {
  const withIds = () => {
    const s = store();
    runWith(s, "g.addV('p').property(T.id,'alice').property('name','a')");
    runWith(s, "g.addV('p').property(T.id,'bob').property('name','b')");
    runWith(s, "g.addV('q').property(T.id,'carol').property('name','c')");
    return s;
  };
  const vals = (s: GraphStore, q: string) => (runWith(s, q) as any[]).map((r) => r.v ?? r.id);
  /** A group() plan's rows are the raw key/value pair columns — read them as the pairs they are
   *  rather than through the wire framer, which is a different subject from the KEY resolution. */
  // Through the harness's `grouped`, not off `gk`/`gv`: the two spines spell a group row differently
  // by design, so reading the columns would assert the ROUTE rather than the keying this test is about.
  const pairs = (s: GraphStore, q: string) => Object.entries(grouped(runWith(s, q))).map(([k, v]) => [k, Number(v)]);

  test('group().by(T.id) keys on the user id, not the rowid', () => {
    const s = withIds();
    // The keys `id()` frames — anything else means the group key and the element disagree.
    expect(vals(s, 'g.V().id()')).toEqual(['alice', 'bob', 'carol']);
    expect(pairs(s, 'g.V().group().by(T.id).by(__.count())'))
      .toEqual([['alice', 1], ['bob', 1], ['carol', 1]]);
  });

  test('order().by(T.id)/by(T.label) sort by the resolved token, not by rowid', () => {
    const s = withIds();
    // Descending by LABEL puts the sole `q` first; ties keep their scan order, so only the
    // partition is asserted, not the order within it.
    expect(vals(s, 'g.V().order().by(T.label, Order.desc).values("name")')[0]).toBe('c');
    expect(vals(s, 'g.V().order().by(T.id).values("name")')).toEqual(['a', 'b', 'c']);
  });

  test('a VertexProperty resolves T.label/T.key to its key and T.value to its value', () => {
    // The property arm of the same authority — `VertexProperty.label()` IS the key. These were
    // per-host gaps: `by(T.value)` had no resolver at any host before the hoist.
    const s = withIds();
    expect(pairs(s, 'g.V().properties().group().by(T.key).by(__.count())')).toEqual([['name', 3]]);
    expect(pairs(s, 'g.V().properties().group().by(T.value).by(__.count())'))
      .toEqual([['a', 1], ['b', 1], ['c', 1]]);
  });
});
