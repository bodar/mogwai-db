import { describe, expect, test } from 'bun:test';
import { compile } from '../src/compiler/compiler.ts';
import { read, runWith, seededStore } from './support/harness.ts';

/**
 * THE RelIR SPINE — routing, coverage and the per-traversal differential (§10·4).
 *
 * The corpus-wide differential is `mise run test:legacy-spine` (the whole suite with the switch
 * off) and the coverage ratchet is the census `spine` column. This file holds the three things
 * neither of those can state directly:
 *
 *   1. a covered traversal actually ROUTES to RelIR, so a lowering that silently stopped firing is
 *      a failure here rather than a coverage number nobody read;
 *   2. the two spines return the SAME ROWS for it, asserted side by side at the traversal level;
 *   3. an UNCOVERED shape declines rather than throwing — the decline is the contract that keeps
 *      "not learned yet" from becoming a support regression.
 */

const store = seededStore();
const rowsVia = (gremlin: string, spine: 'rel' | 'legacy') => {
  const plan = read(gremlin, { spine });
  expect(plan.spine).toBe(spine === 'rel' ? 'rel' : 'legacy');
  return store.query(plan.sql, plan.binds).map((row) => JSON.stringify(row)).sort();
};

/** Every shape the lowering covers today. Growing coverage means growing this list. */
const COVERED = [
  'g.V()', 'g.E()', 'g.V(1)', 'g.V(1,2)', 'g.V([1,2])',
  "g.V().hasLabel('person')", "g.V().hasLabel('person','software')", "g.E().hasLabel('knows')",
  "g.V().has('name')", "g.V().has('name','marko')", "g.V().has('age',29)", "g.E().has('weight',0.5)",
  // A RUN of filters is the shape worth pinning: legacy gives each its own CTE that re-joins the
  // element table to reach a column its predecessor projected away, so `has(a).has(b)` costs two
  // redundant self-joins. RelIR conjoins them into one WHERE over one scan — measured, the same
  // index decisions with those SEARCH-by-rowid steps simply absent.
  "g.V().hasLabel('person').has('age',29)", "g.V().has('name','marko').has('age',29)",
  // The P/TextP vocabulary as RelIR expressions. Range comparisons go through the vtype-aware
  // ordering key, so a value stored as TEXT because it does not fit a numeric storage class (a
  // long past 2^53, a bigint, a bigdecimal, a duration) still orders numerically — the one arm
  // where a plausible-looking lowering is silently wrong.
  "g.V().has('age',P.gt(30))", "g.V().has('age',P.lte(29))", "g.V().has('name',P.neq('marko'))",
  "g.V().has('name',P.within('marko','josh'))", "g.V().has('name',P.without('marko'))",
  "g.V().has('name',P.within())", "g.V().has('age',P.between(20,30))", "g.V().has('age',P.inside(20,35))",
  "g.V().has('age',P.gt(20).and(P.lt(30)))", "g.V().has('age',P.not(P.gt(30)))", "g.E().has('weight',P.gte(0.5))",
  // THE SHAPE BOUNDARY: both of these retype element -> scalar, so they exercise the framing
  // bridge's second stream kind rather than one more step in the same one.
  'g.V().count()', 'g.E().count()', "g.V().hasLabel('person').count()", "g.V().has('age',P.gt(29)).count()",
  "g.V().values('name')", "g.V().values('age')", "g.E().values('weight')", "g.V().hasLabel('person').values('name')",
  // `is(P)` past the shape change — the SAME predicate module the source filters use, over the
  // scalar's own `v`, which is the payoff for having built it as a module rather than a helper.
  'g.V().count().is(P.gt(2))', 'g.V().count().is(2)', "g.V().values('age').is(P.gt(29))",
  "g.V().values('name').is('marko')", "g.V().values('age').is(P.between(28,33))",
  "g.V().values('name').is(P.within('marko','josh'))", "g.V().values('name').is(TextP.containing('ark'))",
  "g.V().hasLabel('person').values('age').is(P.gte(30)).is(P.lt(40))", "g.E().values('weight').is(P.gt(0.3))",
  // `values()` is `element.properties(keys)`: no keys means EVERY key, several mean membership.
  // Both spines answered these WRONG until 2026-08-02 — see the semantics test below.
  "g.V().values('name','age')", "g.V().values('name','age',null)", 'g.V().values()', 'g.E().values()',
  // `inject()` — a SCALAR source, and the largest single blocker measured over the corpus: 387 of
  // the 2,298 traversals begin with one. Its relation has NO channels: an injected row is one
  // traverser by construction, so there is no multiplicity to carry and nothing has established an
  // emission order. `count()` reads that off the CHANNEL rather than the step name, which is why it
  // becomes `COUNT(*)` here and `SUM(bulk)` over an element source.
  'g.inject(1)', 'g.inject(1,2,3)', "g.inject('a','b')", 'g.inject(null)', 'g.inject(true)',
  'g.inject(1).count()', 'g.inject(1,2,3).count()', 'g.inject(1,2).is(P.gt(1))',
  'g.inject(1,2).limit(1)', 'g.inject(1,2).skip(1)', 'g.inject(1,2,2).dedup()',
  // The scalar tail is now ONE fold whichever source fed it, so these reach the same arms.
  "g.V().values('name').dedup()", 'g.V().count().count()', "g.V().out().values('name').dedup()",
  // A SCALAR `order()` — a `Sort`, which is what separates it from the element one: over values
  // legacy emits the ORDER BY as a relation (`SELECT p.v FROM c0 p ORDER BY p.v ASC`), whereas over
  // elements it folds into the FRAMING projection, which is Phase 4.2's. `by(Order.asc|desc|shuffle)`
  // is a DIRECTION the algebra can state, so the modulator is covered rather than declining.
  'g.inject(1,2).order()', 'g.inject(3,1,2).order().limit(2)', "g.inject('b','a').order().by(Order.desc)",
  "g.V().values('age').order()", "g.V().values('age').order().range(1,3)",
  "g.V().values('name').order().by(Order.desc)", "g.V().values('age').order().is(P.gt(29))",
  "g.V().values('age').order().dedup()", "g.V().values('age').order().count()",
  // THE MODULATOR SEAM — `by()` as one vocabulary (`modulator.ts`), so a host gains all three
  // projections at once: identity, a property, and a `T` token. `dedup()` is the first ELEMENT host to
  // take a real one, and the projections are the same objects `order()` reads.
  "g.V().dedup().by('name')", "g.V().dedup().by('lang')", "g.E().dedup().by('weight')",
  "g.V().dedup().by(T.label)", "g.E().dedup().by(T.label)", "g.V().dedup().by(T.id)",
  "g.V().out().dedup().by('lang')", "g.V().dedup().by('lang').values('name')",
  "g.V().dedup().by('name').count()", "g.V().values('name').dedup().by()",
  // THE REDUCER FAMILY — four step names, one `Aggregate`, and Phase 4.3's named deliverable. The
  // `min`/`max` pair over a STRING stream is the arm a numeric-only guard would silently answer nothing
  // for, so both are here.
  "g.V().values('age').sum()", "g.V().values('age').min()", "g.V().values('age').max()",
  "g.V().values('age').mean()", "g.V().values('name').min()", "g.V().values('name').max()",
  "g.inject(1,2,3).sum()", "g.inject(1,2,3).mean()", "g.V().out().values('age').sum()",
  "g.V().values('age').asNumber(GType.DOUBLE).sum()", "g.V().values('age').sum().is(P.gt(100))",
  // `ProductiveByStrategy` is the OTHER side of the productivity rule, and it must stay a live
  // position: with it on, a traverser whose `by()` yielded nothing is KEPT.
  "g.withStrategies(ProductiveByStrategy).V().dedup().by('lang')",
  // `P.typeOf` — the whole FAMILY at once, which is the payoff for the predicate vocabulary being a
  // module: one arm serves `is`, `has`, `where` and every nesting inside `P.not`/`and`/`or`. All three
  // resolution modes are here, because each is a different question and only one of them reads a row.
  "g.V().values('age').is(P.typeOf(GType.INT))", "g.V().values('name').is(P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.typeOf('Integer'))", "g.V().has('name',P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.not(P.typeOf(GType.STRING)))", "g.inject(1).is(P.typeOf(GType.INT))",
  "g.V().count().is(P.typeOf(GType.LONG))", "g.V().count().is(P.typeOf(GType.STRING))",
  "g.V().values('age').is(P.typeOf(GType.BOOLEAN))", "g.V().values('age').is(P.typeOf(GType.NULL))",
  "g.V().values('age').is(P.typeOf(GType.VERTEX))",
  "g.V().values('age').is(P.typeOf(GType.INT)).is(P.gt(29))",
  // ELEMENT `order()` — a MINT of the emission-order channel, which is what made the channel set a
  // property of each RELATION rather than of the chain (`analyzeChain` reports `demandsEncounter`
  // FALSE for every one of these). The `by()` projections are the SAME vocabulary the scalar sort and
  // `dedup().by()` read, so all three arrive together; `by('lang')` is the productivity arm, where a
  // vertex without the key is DROPPED rather than sorted last.
  'g.V().order()', 'g.E().order()', "g.V().order().by('name')", "g.V().order().by('age')",
  "g.V().order().by('name',Order.desc)", "g.V().order().by(T.label)", "g.V().order().by(T.id)",
  "g.V().order().by('lang')", "g.withStrategies(ProductiveByStrategy).V().order().by('lang')",
  "g.V().hasLabel('person').order().by('age')", "g.V().out().order().by('name')",
  // …and it COMPOSES, which is the whole reason to mint a channel rather than fold an ORDER BY into
  // the framing SELECT: a slice after it reads the position, a movement after it re-mints, and a
  // retyping terminal carries it into the scalar tail.
  "g.V().order().by('name').limit(2)", "g.V().order().by('name').range(1,3)",
  "g.V().order().by('age').skip(1)", "g.V().order().by('name').dedup()",
  "g.V().order().by('name').count()", "g.V().order().by('name').values('name')",
  "g.V().order().by('name').out()", "g.V().out().order().by('name').limit(2)",
  // The BULKED slice: `movementCollapse` merges convergent walks into (element, N) rows, so a slice
  // after the order has to count TRAVERSERS and trim the boundary row's multiplicity (`bulkSlice`).
  // `LIMIT n` over those rows would answer a different question — the same rows, the wrong count.
  "g.V().both().order().by('name').limit(2)", "g.V().both().order().by('name').range(1,4)",
  "g.V().both().both().order().by('name').limit(3)",
  // `tail(n)` is the same slice read BACKWARDS, which is the whole of it once the position is a
  // relation property; `sample(n)` is `ORDER BY RANDOM() LIMIT n`, so it is covered but compared for
  // SIZE rather than for rows (see the test below — `rowsVia` would be comparing two dice).
  'g.V().tail(2)', 'g.E().tail(1)', 'g.V().tail()', "g.V().hasLabel('person').tail(2)",
  'g.V().out().tail(2)', "g.V().values('name').tail(2)", 'g.V().tail(2).count()',
  "g.V().order().by('name').tail(2)", 'g.V().out().values("name").tail(1)',
];

/**
 * Shapes that must DECLINE, one per reason, so a decline lost to an over-eager lowering is caught
 * by name. `g.V().count()` is the ordinary "step not learned yet"; the rest are the guards.
 */
const DECLINED = [
  "g.V().bothE().otherV()",           // otherV reads the entering vertex — carried state not modelled
  "g.V().as('a').out().select('a')",  // an alias: carried state not modelled
  'g.V().count().fold()',             // a step after the shape change that is NOT in its vocabulary
  'g.inject([1,2])',                  // a COLLECTION argument is a list traverser, a different arm
  'g.inject()',                       // the EMPTY relation, which `Values` refuses to express (§3.3)
  "g.inject('a').inject('b')",        // a second inject is a UNION with the first, not a source
  'g.inject(1,2).order(Scope.local)', // LOCAL scope: a per-traverser sort of a LIST, a different arm
  "g.V().dedup().by(__.out().count())", // a SUB-TRAVERSAL projection: a child lowering, not an expr
  'g.withSack(0).V()',                // a carried sack the source seed would have to declare
  'g.withSideEffect("a",1).V()',      // a side effect
  'g.addV("person")',                 // a write
  "g.V().has('name',TextP.containing('ark'))",  // ftsSubstringPredicate's — see below
  "g.V().has('name',P.within(__.V().values('name').fold()))", // a run-time member list, not a set
  "g.V().has('person','age',29)",     // the three-argument (label, key, value) form
  'g.V().has(T.id,1)',                // a T-token key
  "g.V().has('name',null)",           // a null value: not a literal this route can compare
  "g.V().where(__.has('name','marko'))", // a filter-only body is a predicate on the SAME traverser
  "g.V().where(__.out().order())",    // a body step the child fold has not learned
];

describe('the RelIR spine', () => {
  for (const gremlin of COVERED) {
    test(`${gremlin} routes to RelIR and agrees with legacy`, () => {
      expect(compile(gremlin, {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
      expect(rowsVia(gremlin, 'rel')).toEqual(rowsVia(gremlin, 'legacy'));
    });
  }

  for (const gremlin of DECLINED) {
    test(`${gremlin} declines to the legacy spine`, () => {
      const plan = compile(gremlin, {}, { spine: 'rel' });
      expect(plan.kind === 'read' ? plan.spine : 'legacy').toBe('legacy');
    });
  }

  test('a slice takes its window from the emission order, not from the scan', () => {
    // Compared UNSORTED and against legacy row-for-row: a slice is the one place where the wrong
    // ORDER is the wrong ANSWER, so sorting before comparing would hide exactly the defect this
    // covers. `ms` (the census gate) would not see it either — same multiset size, different rows.
    for (const gremlin of ['g.V().limit(2)', 'g.V().range(1,3)', 'g.V().skip(2)', 'g.V().skip(1).limit(2)',
      'g.V().out().limit(2)', 'g.V().both().limit(3)', 'g.V().out().out().limit(2)', 'g.V().out().range(1,3)',
      "g.V().values('name').limit(2)", "g.V().values('name').skip(1)", "g.V().out().values('name').limit(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
  });

  test('a scalar order() pins the SEQUENCE, not just the multiset', () => {
    // `rowsVia` SORTS, so the COVERED loop above is a multiset comparison and structurally cannot
    // see the two defects an `order()` actually has: a sort in the wrong DIRECTION, and a sort the
    // assembler fused away entirely. Both leave the multiset untouched, so the census cannot see
    // them either (`ms` is the gate, `ord` is telemetry). Row-for-row against legacy is what can.
    for (const gremlin of ['g.inject(3,1,2).order()', "g.inject('c','a','b').order()",
      "g.inject('c','a','b').order().by(Order.desc)", 'g.inject(3,1,2).order().limit(2)',
      'g.inject(3,1,2).order().skip(1)', "g.V().values('age').order()", "g.V().values('name').order()",
      "g.V().values('name').order().by(Order.desc)", "g.V().values('age').order().range(1,3)",
      "g.V().out().values('name').order()", "g.V().values('age').order().is(P.gt(29))"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …and one ABSOLUTE assertion, because a differential agrees when both sides are wrong: the
    // ascending sequence itself, which no scan order can produce by luck three times over.
    const asc = read('g.inject(3,1,2).order()', { spine: 'rel' });
    expect(store.query(asc.sql, asc.binds).map((row: any) => row.v)).toEqual([1, 2, 3]);
  });

  test('an element order() pins the SEQUENCE, and every composition of it', () => {
    // The MINT is only observable as an ORDER, so `rowsVia`'s sorted comparison structurally cannot
    // see any of this: a wrong direction, a sort the assembler fused away, a mint that renumbered
    // per arm rather than once over the fan-out, or a slice reading the stale seed. Row-for-row
    // against legacy is what can — and every one of these is a chain `analyzeChain` reports
    // `demandsEncounter` FALSE for, which is exactly why the channel had to become the relation's.
    for (const gremlin of ['g.V().order()', 'g.E().order()', "g.V().order().by('name')",
      "g.V().order().by('name',Order.desc)", "g.V().order().by('age')", "g.V().order().by(T.label)",
      "g.V().order().by('name').limit(2)", "g.V().order().by('name').range(1,3)",
      "g.V().order().by('age').skip(1)", "g.V().order().by('name').values('name')",
      "g.V().hasLabel('person').order().by('age')", "g.V().out().order().by('name')",
      "g.V().out().order().by('name').limit(2)", "g.V().order().by('name').out()",
      // The BULKED slice: a collapsed row stands for N traversers, so the boundary row's
      // multiplicity is TRIMMED. `LIMIT n` over those rows returns the same rows with the wrong
      // count — right arity per row, wrong number of traversers, invisible to a sorted compare.
      "g.V().both().order().by('name').limit(2)", "g.V().both().order().by('name').range(1,4)",
      "g.V().both().both().order().by('name').limit(3)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …plus two ABSOLUTE assertions, because a differential agrees when both sides are wrong. The
    // modern graph's names ascending, and the same list reversed — no scan order produces either by
    // luck six times over.
    const names = (gremlin: string) => {
      const plan = read(gremlin, { spine: 'rel' });
      return store.query(plan.sql, plan.binds).map((row: any) => JSON.parse(row.props).name[0].v);
    };
    expect(names("g.V().order().by('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    expect(names("g.V().order().by('name',Order.desc)")).toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
    // A non-productive `by('age')` DROPS the two software vertices rather than sorting them first.
    expect(names("g.V().order().by('age')")).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  test('tail(n) reads the emission order backwards, and sample(n) is a size not a sequence', () => {
    // `tail` is the one slice where the order IS the answer twice over: which n, and in what order
    // they are reported (backwards from the end, forwards on the wire). Row-for-row against legacy.
    for (const gremlin of ['g.V().tail(2)', 'g.V().tail()', 'g.E().tail(1)', 'g.V().out().tail(2)',
      "g.V().values('name').tail(2)", "g.V().order().by('name').tail(2)", "g.V().hasLabel('person').tail(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
    // …and an ABSOLUTE one: the LAST two names in emission order, reported forwards.
    const last = read("g.V().order().by('name').tail(2)", { spine: 'rel' });
    expect(store.query(last.sql, last.binds).map((row: any) => JSON.parse(row.props).name[0].v)).toEqual(['ripple', 'vadas']);

    // `sample(n)` is deliberately nondeterministic, so the differential is over the SIZE and the
    // membership — comparing two rows of dice would be comparing the dice. What must hold is that it
    // routes, that it takes n, and that n is bounded by what there is.
    const sampled = read('g.V().sample(2)', { spine: 'rel' });
    expect(sampled.spine).toBe('rel');
    expect(store.query(sampled.sql, sampled.binds)).toHaveLength(2);
    const all = read('g.V().sample(99)', { spine: 'rel' });
    expect(store.query(all.sql, all.binds)).toHaveLength(6);
    // A WEIGHTED sample (`by()`) has no shared form — the weight is a per-shape expression — so it
    // declines through the modulator gate, and LEGACY raises the message it owns. Pinned as the
    // throw rather than as a route, because RelIR throwing FIRST is how "not learned yet" becomes a
    // support regression.
    expect(() => read("g.V().sample(2).by('age')", { spine: 'rel' })).toThrow('by() is only supported');
  });

  test('a scalar order() narrows on its MODULATOR rather than declining wholesale', () => {
    // `by()` is the one modulator the scalar tail reads, because on `order()` it names a DIRECTION
    // and not a projection. So the arms split: a direction routes, and a form that needs a value a
    // scalar stream has not got — `by(key)`, `by(traversal)`, `by(token)`, or two keys at once —
    // declines and legacy raises the message it owns. These are not `DECLINED` entries because
    // legacy THROWS for them: what is being pinned is that RelIR does not throw FIRST, since a
    // deferral raised by the wrong spine is how "not learned yet" turns into a support regression.
    expect(compile("g.V().values('name').order().by(Order.desc)", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    expect(() => compile("g.V().values('name').order().by('age')", {}, { spine: 'rel' }))
      .toThrow('order().by(key/traversal) on a scalar stream not supported');
    expect(() => compile("g.V().values('name').order().by(Order.asc).by(Order.desc)", {}, { spine: 'rel' }))
      .toThrow('multiple order().by() modulators');
  });

  test("a by()'s PRODUCTIVITY is honoured, both ways round", () => {
    // TinkerPop's default `by()` DROPS a traverser it yielded nothing for; `ProductiveByStrategy`
    // keeps it. Both positions are asserted with absolute counts rather than against legacy, because
    // this is the arm where "agrees with the other spine" is the weakest available evidence: a
    // productivity filter omitted on BOTH sides is a shared defect a differential cannot see, and the
    // reference graph makes the difference visible — 6 vertices, only 2 with a `lang`.
    const dropped = read("g.V().dedup().by('lang')", { spine: 'rel' });
    expect(dropped.spine).toBe('rel');
    expect(store.query(dropped.sql, dropped.binds).length).toBe(1);
    const kept = read("g.withStrategies(ProductiveByStrategy).V().dedup().by('lang')", { spine: 'rel' });
    expect(kept.spine).toBe('rel');
    // One survivor per distinct `lang` (java) PLUS one for the null key — SQL groups NULLs together in
    // a `PARTITION BY`, which is what TinkerPop's "all non-productive traversers share a key" means.
    expect(store.query(kept.sql, kept.binds).length).toBe(2);
  });

  test("a reducer's three policies each have a witness the others cannot provide", () => {
    // ELIGIBILITY, BULK WEIGHTING and the DYNAMIC result type are three independent rules, and the
    // reference fixture makes each visible only under a different traversal — so each gets its own
    // assertion rather than trusting one differential to cover all three.
    //
    // 1. ELIGIBILITY is arithmetic-vs-comparable: `min`/`max` admit TEXT because Gremlin's Comparable
    //    does, and a numeric-only guard would answer NULL here rather than a wrong number.
    const minText = read("g.V().values('name').min()", { spine: 'rel' });
    expect(minText.spine).toBe('rel');
    expect(store.query(minText.sql, minText.binds).map((row: any) => row.v)).toEqual(['josh']);

    // 2. BULK WEIGHTING applies to sum/mean and NOT to min/max, and it is only observable once a
    //    collapse upstream has made bulk anything but 1 — `both().both()` is that. A weighted min would
    //    still be the min, which is why the pair is asserted together against legacy.
    for (const gremlin of ["g.V().both().both().values('age').sum()", "g.V().both().both().values('age').mean()",
      "g.V().both().both().values('age').min()", "g.V().both().both().values('age').max()"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }

    // 3. THE MEAN IS FORCED REAL. Integer division answers 30 for the reference ages where the mean is
    //    30.75 — right shape, plausible number, and the ONLY thing that catches it is the value. RelIR
    //    forces it with a `Cast` because §3.2 makes every `Lit` a bind and a JS `1.0` binds as INTEGER,
    //    so legacy's `* 1.0` is not expressible. This assertion is that limit's regression test.
    const mean = read("g.V().values('age').mean()", { spine: 'rel' });
    expect(store.query(mean.sql, mean.binds).map((row: any) => row.v)).toEqual([30.75]);
    // The mechanism is the CAST, asserted directly — `* ?` also appears in this SQL and legitimately so
    // (that is the bulk weighting), which is why the absence of a multiplier is not the thing to check.
    expect(mean.sql).toMatch(/CAST\(sum\([^]*AS REAL\) \//);

    // …and the result's storage class rides out as the `vt` column, because a sum of integers is an
    // integer and of reals a real — there is no compile-time tag to give.
    const sum = read("g.V().values('age').sum()", { spine: 'rel' });
    expect(store.query(sum.sql, sum.binds)).toEqual([{ v: 123, vt: 'integer' }]);
    const real = read("g.V().values('age').asNumber(GType.DOUBLE).sum()", { spine: 'rel' });
    expect(store.query(real.sql, real.binds)).toEqual([{ v: 123, vt: 'real' }]);
  });

  test('a cast over a LITERAL must RAISE, so RelIR declines the constant-folded transforms', () => {
    // The one place a differential is blind by construction: these six traversals must produce an
    // ERROR, and comparing rows against legacy cannot see a missing throw. TinkerPop requires the exact
    // parse/overflow messages and SQL cannot raise them, so legacy folds `asNumber`/`asDate`/`asBool`
    // at COMPILE time over an inject literal. RelIR lowered them as SQLite casts instead, which
    // answered `1` for `'1,000'` and epoch 0 for an invalid date string — a required error turned into
    // a plausible value, which is the worst direction the "never answer a different question" rule has.
    //
    // Caught by L3 (six official scenarios, 1701 → 1695), not by the census, not by the row-for-row
    // probe, and not by the shape assertions. Promoted here so the decline is pinned by name.
    for (const [gremlin, message] of [
      ['g.inject(1694017709000d).asDate()', "Can't parse"],
      ["g.inject('1,000').asNumber(GType.BIGINT)", "Can't parse string '1,000' as number."],
      ['g.inject(300).asNumber(GType.BYTE)', "Can't convert number of type Integer to Byte due to overflow."],
      ['g.inject(32768).asNumber(GType.SHORT)', "Can't convert number of type Integer to Short due to overflow."],
      ["g.inject('invalid str').asDate()", "Can't parse"],
      ['g.inject(null).asDate()', "Can't parse"],
    ] as const) expect(() => compile(gremlin, {}, { spine: 'rel' })).toThrow(message);

    // …and the decline is the CAST SUBFAMILY over a literal, not the family: a string transform of a
    // literal has no parse to fail, so it still routes.
    expect(compile("g.inject('a','b').toUpper()", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    // Over a RUNTIME value there is nothing to fold and the SQL cast is the answer, so it routes there.
    expect(compile("g.V().values('age').asNumber(GType.DOUBLE)", {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
  });

  test('P.typeOf resolves through all THREE modes, and each is a different question', () => {
    // A differential is the weakest evidence here, because a `typeOf` that resolved through the WRONG
    // mode still returns rows — and on a fixture where every value's storage class happens to match
    // its declared type, the wrong mode agrees with the right one. So each mode is pinned by what it
    // must and must not touch.
    //
    // Mode 1, COMPILE-TIME type → constant fold, and the tell is that it reads no row at all:
    // `count()` is a `long`, so the predicate resolves before the query does.
    const folded = read('g.V().count().is(P.typeOf(GType.LONG))', { spine: 'rel' });
    expect(folded.spine).toBe('rel');
    expect(folded.sql).not.toMatch(/typeof\(/i);
    expect(folded.sql).not.toMatch(/vtype/);
    expect(store.query(folded.sql, folded.binds).length).toBe(1);
    const wrong = read('g.V().count().is(P.typeOf(GType.STRING))', { spine: 'rel' });
    expect(store.query(wrong.sql, wrong.binds).length).toBe(0);

    // Mode 2, PER-ROW `vtype` → compare the column, with the storage class as the fallback for a row
    // whose vtype is NULL. Both halves must be present: the column is the only thing that tells a
    // `datetime` from a `long`, and the fallback is the only thing that answers for a raw-inserted row.
    const perRow = read('g.V().values("age").is(P.typeOf(GType.INT))', { spine: 'rel' });
    expect(perRow.sql).toMatch(/vtype/);
    expect(perRow.sql).toMatch(/typeof\(/i);

    // Mode 3, NOTHING KNOWN → the storage-class test alone, and FALSE for every type SQLite's classes
    // cannot distinguish. False rather than a decline, because that is the answer the reference gives.
    const boolean = read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))', { spine: 'rel' });
    expect(store.query(boolean.sql, boolean.binds).length).toBe(0);

    // A GType naming something a property value can never be is FALSE (valid syntax); an unregistered
    // NAME is an ERROR, and the two must not be confused — so the second declines and legacy raises.
    expect(compile('g.V().values("age").is(P.typeOf(GType.VERTEX))', {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
    expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {}, { spine: 'rel' }))
      .toThrow("unregistered type 'bogus-name'");
  });

  test('dedup().by() keeps ONE traverser per key, deterministically', () => {
    // The survivor must be a NAMED row, not "whichever SQLite produced first" — a `PARTITION BY key`
    // with no `ORDER BY` in the window is right-arity and arbitrary, and the reference fixture is
    // small enough that the arbitrary choice is reliably the flattering one. So: row-for-row against
    // legacy, unsorted, plus the perturbation instrument (`MOGWAI_REVERSE_UNORDERED=1`) over this file.
    for (const gremlin of ["g.V().dedup().by('name')", "g.V().dedup().by('lang')",
      "g.V().dedup().by(T.label)", "g.E().dedup().by(T.label)", "g.V().dedup().by(T.id)",
      "g.E().dedup().by('weight')", "g.V().out().dedup().by('lang')",
      "g.V().dedup().by('lang').values('name')", "g.V().out().dedup().by('lang').limit(2)"]) {
      const rel = read(gremlin, { spine: 'rel' });
      const legacy = read(gremlin, { spine: 'legacy' });
      expect(store.query(rel.sql, rel.binds)).toEqual(store.query(legacy.sql, legacy.binds));
    }
  });

  test("a scalar order()'s key is vtype-aware, so a TEXT-stored number sorts numerically", () => {
    // The arm where a plausible-looking lowering is silently wrong, and it needs its own fixture:
    // every `age` in the reference graph fits an INTEGER storage class, so a key that skipped the
    // compare CASE would agree with legacy on all eleven traversals above. A long past 2^53 does not
    // fit, is stored as TEXT, and a lexical sort then puts it BETWEEN 12 and 300 — right multiset,
    // wrong sequence, and nothing else in the suite looks.
    const graph = seededStore();
    for (const value of ['12L', '9007199254740993L', '300L'])
      runWith(graph, `g.addV("n").property("k",${value})`);
    const plan = read("g.V().hasLabel('n').values('k').order()", { spine: 'rel' });
    expect(plan.spine).toBe('rel');
    expect(graph.query(plan.sql, plan.binds).map((row: any) => String(row.v))).toEqual(['12', '300', '9007199254740993']);
  });

  test('a positional step with no position to read fails CLOSED', () => {
    // The decline that is a SAFETY property rather than a coverage gap, and it survived the whole
    // row-algebraic class landing: a slice's answer depends on which rows come first, so a step that
    // reads a position the relation does not carry must DEFER. Omitting the channel would not defer,
    // it would pick a different window from the same multiset — right arity, plausible rows, and a
    // census that structurally cannot see it (`ord` is telemetry, `ms` is the gate).
    //
    // `tail` is where that is reachable: "the last n" is a question ABOUT emission order, and a
    // barrier has consumed the position by the time it is asked. Legacy refuses the same shape from
    // its own side, so what is being pinned is that RelIR does not answer it — nor throw first.
    expect(read('g.V().count().tail(1)', { spine: 'rel' }).spine).toBe('legacy');
    // A WEIGHTED `sample().by()` declines through the modulator gate, and legacy raises the message
    // it owns — pinned in the `tail`/`sample` test above.
    // …and it is a GATE, not a blanket: everything whose order the route DOES thread still routes,
    // including across a fan-out, where the position has to be re-minted rather than carried.
    for (const gremlin of ['g.V().limit(2)', 'g.V().dedup().limit(2)', 'g.V().out().limit(2)',
      'g.V().out().dedup().limit(1)', 'g.V().tail(2)', 'g.V().out().tail(2)', 'g.V().sample(2)']) {
      expect(read(gremlin, { spine: 'rel' }).spine).toBe('rel');
    }
  });

  test('a fast-path switch selects a STRATEGY, and RelIR covers the side it implements', () => {
    // `predicateInlining` chooses between two lowerings of a `where()` body: the correlated EXISTS
    // (which RelIR emits) and a MATERIALIZED child-existence gate — a pushed ordinal, a LEFT JOIN
    // and a rejoin — which it has not learned. With the switch off it therefore declines, exactly
    // as it declines an unlearned step, and both positions stay live for L5's differential.
    //
    // This is NOT the FTS rule inverted. There, reading the flag would have let spine choice dodge
    // an optimization RelIR cannot state at all (an index seek). Here the flag names two strategies
    // and RelIR implements one; covering only what it implements is ordinary coverage.
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel' }).spine).toBe('rel');
    expect(read("g.V().where(__.out('knows'))", { spine: 'rel', fastPaths: { predicateInlining: false } }).spine).toBe('legacy');
    // `movementCollapse` is the other side of the same coin: RelIR states BOTH forms, so it covers
    // the traversal either way and the flag only changes what it emits.
    for (const movementCollapse of [true, false]) {
      expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse } }).spine).toBe('rel');
    }
    // Matched on `sum(…) AS bulk`, not on `GROUP BY`: the element framing projection has a GROUP BY
    // of its own (the property aggregation), so that alone would pass either way. And not on
    // `sum(p.bulk)` either — the assembler fuses the aggregate into the join's block, so the
    // multiplicity is spelled as the expression that computes it, which here is the seed literal.
    const collapsed = /sum\([^)]*\) AS bulk/i;
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: true } }).sql).toMatch(collapsed);
    expect(read('g.V().out()', { spine: 'rel', fastPaths: { movementCollapse: false } }).sql).not.toMatch(collapsed);
  });

  test('a fast path is never silently dropped', () => {
    // THE RULE, and it is general: coverage measures whether the new spine can EXPRESS a
    // traversal, not whether it should take it from a specialized lowering. `has(k, containing(t))`
    // routes through the `property_fts` trigram index; expressing it here as a base-table LIKE scan
    // would be a performance regression the census cannot see, reported by the coverage number as
    // progress. §4.7 is where the fast paths become plan rewrites and this decline lifts.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel' }).spine).toBe('legacy');
    expect(read("g.V().has('name',TextP.containing('ark'))").sql).toContain('property_fts');
    // The decline is a function of the CHAIN alone, never of the fast-path config: making spine
    // choice read `fastPaths` would couple two decisions that have to stay independent.
    expect(read("g.V().has('name',TextP.containing('ark'))", { spine: 'rel', fastPaths: { ftsSubstringPredicate: false } }).spine).toBe('legacy');
  });

  test('the switch is a preference, never a claim about coverage', () => {
    // Asking for RelIR does not make an uncovered chain route there, and asking for legacy always
    // works. Coverage is a property of the CHAIN; if these ever diverge the router has started
    // deciding something the lowering should own.
    expect(read('g.V().as("a").out().select("a")', { spine: 'rel' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'legacy' }).spine).toBe('legacy');
    expect(read('g.V()', { spine: 'rel' }).spine).toBe('rel');
  });

  test('a retyping terminal frames as the same Shape on both spines', () => {
    // Rows agreeing is not enough at the shape boundary: `Compiled.shape` is what the wire framer
    // reads, so a lowering that produced the right VALUES under the wrong shape would round-trip
    // as the wrong GraphBinary type and every row assertion would still pass.
    for (const gremlin of ['g.V().count()', "g.V().values('name')", "g.E().values('weight')"]) {
      expect(read(gremlin, { spine: 'rel' }).shape).toEqual(read(gremlin, { spine: 'legacy' }).shape);
    }
    expect(read('g.V().count()', { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'static', type: 'long' } });
    expect(read("g.V().values('name')", { spine: 'rel' }).shape).toEqual({ kind: 'value', type: { kind: 'perRow', column: 'vtype' } });
  });

  test('values(k…) is the KEY SET, on both spines', () => {
    // Both spines read only `args[0]` until 2026-08-02, so `values('name','age')` returned just the
    // names and `values()` bound null and returned nothing — right arity, plausible rows, and the
    // census recorded both as `ran`. Found by re-expressing the step in RelIR: a second
    // implementation asks questions of the first that no test in the suite was asking.
    //
    // TinkerPop's `PropertiesStep` is `element.properties(keys)` — no keys means EVERY key, several
    // mean membership in the set, and a null key never matches (`Properties.feature:91` pins
    // `values("name","age",null)` as names AND ages). Asserted on both spines, because the fix
    // landed in both and the differential requires them to agree.
    for (const spine of ['legacy', 'rel'] as const) {
      const rows = (g: string) => (store.query(read(g, { spine }).sql, read(g, { spine }).binds) as any[]).map((r) => r.v).sort();
      expect(rows("g.V().values('name')")).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age')")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows("g.V().values('name','age',null)")).toEqual([27, 29, 32, 35, 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.V().values()')).toEqual([27, 29, 32, 35, 'java', 'java', 'josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
      expect(rows('g.E().values()')).toEqual([0.2, 0.4, 0.4, 0.5, 1, 1]);
    }
  });

  test('the emitted SQL does not depend on how many traversals were compiled before it', () => {
    // Relation ids are minted per lowering. A module-global counter would make two compiles of one
    // query produce two different strings — silently breaking every snapshot and any cache keyed
    // on the text, and only under a particular compile order.
    const first = read('g.V(1)', { spine: 'rel' });
    read('g.E()', { spine: 'rel' });
    expect(read('g.V(1)', { spine: 'rel' }).sql).toBe(first.sql);
  });
});
