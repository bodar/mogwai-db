// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, STATIC } from '../../src/sql/kernel/render.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { read, run, runWith, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('filter / predicate SQL (is/where/not/TextP/has)', () => {
  test('hasId filters on the external id (COALESCE(uid,id))', () => {
    const one = read('g.V().hasId(1)');
    expect(one.sql).toContain('COALESCE(n.uid, n.id) in (?)');
    expect(one.binds).toEqual([1]);
    const many = read('g.V().hasId(1,2)');
    expect(many.sql).toContain('COALESCE(n.uid, n.id) in (?, ?)');
    expect(many.binds).toEqual([1, 2]);
    // nulls dropped from the set; predicate arg passes through
    expect(read('g.V().hasId(1,null)').binds).toEqual([1]);
    expect(read('g.V().hasId(P.neq(1))').sql).toContain('COALESCE(n.uid, n.id) != ?');
    // empty within/without fold to constants, not the SQLite-illegal `IN ()`
    expect(read('g.V().hasId(P.within([]))').sql).toContain('WHERE 0');
    expect(read('g.V().not(__.hasId(P.within([])))').sql).toContain('NOT COALESCE');
  });

  // `P.typeOf` is RelIR-routed on both `is` and `has`, so the CONTRACT is asserted once per spine —
  // three resolution modes, and the point of each is which evidence it reads, not how it spells it.
  // A canonical type name and a storage class are compiler-authored CONSTANTS: legacy binds them, RelIR
  // inlines them as escaped literals (the parameter-budget rule). `carries` asserts the value is present
  // either way, so the contract — that both pieces of evidence appear — holds across the spelling.
  const carries = (plan: { sql: string; binds: readonly unknown[] }, v: string): boolean =>
    plan.binds.includes(v) || plan.sql.includes(`'${v}'`);
  for (const spine of ['legacy', 'rel'] as const) {
    test(`P.typeOf resolves the stored vtype, with a storage-class fallback — ${spine} spine`, () => {
      // value stream + is(): the per-row vtype column (values() reads vp.vtype) answers the type; a
      // NULL-vtype legacy row falls back to typeof(v). BOTH halves must be present — the column is the
      // only thing that tells a datetime from a long, the fallback the only thing that answers for a
      // raw-inserted row — and both binds appear (canonical name, then storage class).
      const str = read('g.V().values("name").is(P.typeOf(GType.STRING))', { spine });
      expect(str.sql).toMatch(/CASE WHEN \(?\w+\.vtype IS NOT (NULL|\?)\)? THEN \(?\w+\.vtype = (?:\?|'\w+')\)? ELSE \(?typeof\(\w+\.v\) = (?:\?|'\w+')\)? END/);
      expect(carries(str, 'string')).toBe(true);
      expect(carries(str, 'text')).toBe(true);
      expect(carries(read('g.V().values("age").is(P.typeOf(GType.INT))', { spine }), 'int')).toBe(true);
      // java class-name string form is equivalent
      expect(carries(read('g.V().values("name").is(P.typeOf("String"))', { spine }), 'string')).toBe(true);
      // has(): the same test, over the property row's own vtype rather than the projected one.
      expect(read('g.V().has("name", P.typeOf(GType.STRING))', { spine }).sql)
        .toMatch(/CASE WHEN \(?\w*\.?vtype IS NOT (NULL|\?)\)? THEN \(?\w*\.?vtype = (?:\?|'\w+')\)? ELSE \(?typeof\(\w*\.?value\) = (?:\?|'\w+')\)? END/);
      // NULL → is-null; a storage-class-invisible type (boolean) → vtype match, else FALSE. `0` and
      // `1 = 0` are the two spellings of that false — RelIR has no bare boolean literal (§3.2).
      expect(read('g.V().values("age").is(P.typeOf(GType.NULL))', { spine }).sql).toMatch(/is null|IS \?/i);
      expect(read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))', { spine }).sql)
        .toMatch(/THEN \(?\w+\.vtype = (?:\?|'\w+')\)? ELSE \(?(0|1 = 0|\? = \?)\)? END/);
      // P.not negates the inner predicate, and the SPELLING is the §13a fix: `NOT (p)` is NULL when
      // `p` is, which drops a row TinkerPop keeps (its `test` is two-valued, so negating an unknown is
      // TRUE), so RelIR emits `p IS NOT 1` instead. Legacy still spells the bare `NOT (…)`. Either is
      // "the inner predicate, negated"; what must not appear is the inner predicate un-negated.
      expect(read('g.V().values("age").is(P.not(P.typeOf(GType.STRING)))', { spine }).sql)
        .toMatch(/(NOT \(+CASE WHEN|CASE WHEN[^]*END IS NOT (1|\?))/);
      // an unregistered type name RAISES, and RelIR must not answer it instead: an unreadable name is
      // an error, unlike a GType that names something a value can never be (which is FALSE).
      expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {}, { spine })).toThrow('unregistered type');
    });
  }

  test('is(typeOf(LIST|SET|MAP)) is a shape RETYPE, and both spines retype', () => {
    // The one arm where treating `typeOf` as an ordinary predicate is a WRONG ANSWER rather than a
    // missing one: over a scalar stream carrying a stored collection, the assert retypes the stream to
    // a list or a map, so filtering would return the right rows framed as the wrong shape. Both spines
    // reach the retype through legacy's ONE `typeOfAssert` decode (via `collectionAssert`) — five arms
    // had already drifted decoding this inline, which is why there is one decode and not a sixth copy.
    for (const gremlin of ['g.V().values("uuid").is(P.typeOf(GType.LIST))', 'g.V().values("list").is(P.typeOf(GType.SET))']) {
      expect(compile(gremlin, {}, { spine: 'rel' })).toMatchObject({ spine: 'rel' });
      for (const spine of ['legacy', 'rel'] as const) expect(read(gremlin, { spine }).shape.kind).not.toBe('value');
    }
    // A MAP retype declines: RelIR has the LIST shape and not the map one, so it hands the traversal to
    // the spine that does — the decline is not a loss of support.
    const mapped = compile('g.V().values("age").is(P.typeOf(GType.MAP))', {}, { spine: 'rel' });
    expect(mapped.kind === 'read' ? mapped.spine : 'legacy').toBe('legacy');
    expect(read('g.V().values("age").is(P.typeOf(GType.MAP))').shape.kind).not.toBe('value');
  });

  // `values().is()` and `count().is()` are RelIR-routed, so both run on BOTH spines. Each spine's
  // own spelling is pinned where it is the point of the test; everything else is asserted as the
  // SEMANTIC fact, which is what a snapshot is allowed to hold (test/CLAUDE.md).
  for (const spine of ['legacy', 'rel'] as const) {
    test(`is(P) folds a predicate onto the projected scalar — ${spine} spine`, () => {
      const gt = read('g.V().values("age").is(P.gt(30))', { spine });
      expect(gt.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
      // is(gt) folds through the vtype-aware compareKey (numeric-correct for the exact tail). The two
      // spines put the operator in different places since the comparability fix (§13a) — legacy after
      // the compare-key `END`, RelIR inside each type-space arm so a cross-type compare is FALSE
      // rather than SQLite's storage order — so what is asserted is that the comparison is vtype-aware
      // AT ALL. A raw `value > ?` matches neither alternative.
      expect(gt.sql).toMatch(/(END\)? > \?|CAST\([^)]+ AS (INT|REAL)\) > \?)/);
      expect(gt.binds).toContain(30);
      // bare literal → equality, with no compareKey (equality on canonical text is exact)
      const eq = read('g.V().values("age").is(29)', { spine });
      expect(eq.sql).toMatch(/\bv = \?/);
      expect(eq.sql).not.toContain('CAST');
    });

    test(`count().is(P) wraps the count in a value filter (0/1 rows) — ${spine} spine`, () => {
      const p = read('g.V().count().is(P.gt(3))', { spine });
      expect(p.sql).toMatch(/COALESCE\(sum\(.*\), .*\) AS v/i);
      expect(p.shape).toEqual({ kind: 'value', type: STATIC('long') });
    });
  }

  test('a run of range is() stays inside the DO bind cap on both spines', () => {
    // RelIR binds query operands but emits its fixed type vocabulary as escaped compiler text. Fusing
    // the filter into its input's block used to make bind growth quadratic in
    // the projection's size, because a WHERE cannot name a select alias so each `is` re-inlined the
    // whole projection; a `Materialize` boundary before the filters lands the same CTE-then-filter
    // shape legacy emits. This pins that the growth is LINEAR and bounded, since the failure mode
    // is a plan that fails closed above 100 binds where legacy answers.
    const many = 'g.V().values("age").is(P.gt(1)).is(P.lt(9)).is(P.gte(2)).is(P.neq(5)).is(P.gt(0))';
    for (const spine of ['legacy', 'rel'] as const) expect(read(many, { spine }).binds.length).toBeLessThan(60);
    // The RelIR spelling is no longer charged once per static type name: five predicates retain only
    // their query values, not their repeated comparison vocabulary.
    expect(read(many, { spine: 'rel' }).binds.length).toBeLessThan(20);
  });

  test('is() on a non-scalar projection throws', () => {
    expect(() => compile('g.V().is(1)', {})).toThrow('is() requires a scalar stream');
  });

  test('TextP compiles to LIKE with a metachar-escaped pattern (bound on legacy, inlined on rel)', () => {
    // The pattern is a parsed literal → a constant: legacy binds it (the operator form
    // `x LIKE ? ESCAPE ?`), RelIR inlines it as an escaped literal in the `like(pattern, subject, esc)`
    // function form. Either way the LIKE metachars are backslash-escaped and the SQL-quotes doubled, so
    // the user value is never raw-spliced — escaping is the guard, not the bind.
    const sw = read('g.V().has("name", TextP.startingWith("jo"))');   // has(stored) → legacy (FTS decline)
    expect(sw.sql).toContain("like ? escape ?"); // node renderer: lowercase kw, escape bound
    expect(sw.binds).toContain('jo%');
    // values().is(TextP) is RelIR-routed → the pattern inlines into the like() call.
    expect(read('g.V().values("name").is(TextP.containing("ar"))').sql).toContain("like('%ar%',");
    // negation → NOT LIKE
    expect(read('g.V().has("name", TextP.notEndingWith("o"))').sql).toContain("not like ? escape ?");
    // metachars in the user value are escaped, never spliced — on both spellings.
    expect(read('g.V().has("name", TextP.containing("50%_x"))').binds).toContain('%50\\%\\_x%'); // legacy bind
    expect(read('g.V().values("name").is(TextP.containing("50%_x"))').sql).toContain("like('%50\\%\\_x%',"); // rel inline
  });

  test('ftsSubstringPredicate: has(k, >=3-char substring) routes through property_fts, LIKE fallback equivalent', () => {
    const store = seededStore();
    const on = read('g.V().has("name", TextP.containing("ark"))');
    // Fast path ON (default): a MATCH prefilter + LIKE position-confirm over the trigram index.
    expect(on.sql).toContain('property_fts');
    expect(on.sql).toContain('MATCH');
    expect(on.sql).toContain('kind');
    // The MATCH phrase (literal-quoted term) and the LIKE pattern are both bound, not spliced.
    expect(on.binds).toContain('"ark"');
    expect(on.binds).toContain('%ark%');
    // Fast path OFF → the generic base-table LIKE scan (the semantic authority + equivalence
    // fallback); no property_fts.
    const off = read('g.V().has("name", TextP.containing("ark"))', { fastPaths: { ftsSubstringPredicate: false } });
    expect(off.sql).not.toContain('property_fts');
    expect(off.sql).toContain('like ? escape ?');
    // Result-equivalent: both select the same vertices (marko, via 'ar' in 'marko'... 'ark' here).
    const namesOn = (run(store, 'g.V().has("name", TextP.containing("ar")).values("name")') as any[]).map((r) => r.v).sort();
    const namesOff = (runWith(store, 'g.V().has("name", TextP.containing("ar")).values("name")', { fastPaths: { ftsSubstringPredicate: false } }) as any[]).map((r) => r.v).sort();
    expect(namesOn).toEqual(namesOff);
    expect(namesOn).toEqual(['marko']);
    // startingWith excludes a mid-string hit (the LIKE position-confirm): 'jo' floor-guarded,
    // use a >=3 anchored term. 'jos' starts josh only.
    expect((run(store, 'g.V().has("name", TextP.startingWith("jos")).values("name")') as any[]).map((r) => r.v)).toEqual(['josh']);
    // The index is genuinely used (EXPLAIN shows the FTS virtual-table index, not a base scan).
    const plan = store.query<{ detail: string }>('EXPLAIN QUERY PLAN ' + on.sql, on.binds).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/property_fts.*VIRTUAL TABLE INDEX/);
  });

  test('ftsSubstringPredicate: <3-char and negated substrings stay on the generic LIKE path', () => {
    const store = seededStore();
    // A <3-char term has no index-only answer → generic LIKE scan (NOT fail-closed).
    const short = read('g.V().has("name", TextP.containing("ar"))');
    expect(short.sql).not.toContain('property_fts');
    expect(short.sql).toContain('like ? escape ?');
    // A negated op (notContaining) stays on LIKE: the trigram index finds MATCHES, not the
    // "exists a value that does NOT match" the ANY-match negation needs.
    const neg = read('g.V().has("name", TextP.notContaining("ark"))');
    expect(neg.sql).not.toContain('property_fts');
    expect(neg.sql).toContain('not like ? escape ?');
    expect((run(store, 'g.V().has("name", TextP.notContaining("ark")).values("name")') as any[]).map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
  });

  test('where(__.movement) → EXISTS filter CTE; not() → NOT COALESCE — legacy spine', () => {
    // The correlated child is the generic movement StepFn rendered as a nested derived
    // subquery seeded from the outer n.id (index-only; no bespoke xe/xn scheme).
    const w = read('g.V().where(__.out("knows")).values("name")', { spine: 'legacy' });
    expect(w.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    const n = read('g.V().not(__.out("created")).values("name")', { spine: 'legacy' });
    expect(n.sql).toContain('WHERE NOT COALESCE((EXISTS(');
  });

  test('where(__.movement) → a correlated EXISTS with no seed relation — rel spine', () => {
    // RelIR compares the edge column to the OUTER id directly, where legacy seeds the child with
    // `(SELECT n.id AS id) p` — a projection with no input, which the algebra has no node for and
    // does not need. One derived table fewer, and no new node kind (§7's bar: the seam CAN express
    // the shape).
    const w = read('g.V().where(__.out("knows")).values("name")', { spine: 'rel' });
    // The probe projects the CHILD'S OWN first column rather than a literal: an EXISTS does not care
    // what the value is, but a body ending in an aggregate does — projecting `1` there leaves a block
    // with a HAVING and no aggregate in its select list, which SQLite refuses.
    expect(w.sql).toMatch(/EXISTS \(SELECT \w+\.tgt AS one FROM edges \w+ WHERE \(\(\w+\.src = \w+\.id\) AND \w+\.label IN/);
    // `NOT EXISTS`, not legacy's `NOT COALESCE(EXISTS(…), 0)`: an EXISTS is never NULL, so the
    // COALESCE guards nothing.
    const n = read('g.V().not(__.out("created")).values("name")', { spine: 'rel' });
    expect(n.sql).toContain('NOT EXISTS (');
    expect(n.sql).not.toContain('COALESCE((EXISTS');
  });

  test('where(__.count().is(P)) → correlated scalar compare over incident edges', () => {
    // LEGACY's spelling, pinned explicitly — a correlated child ending in count().is() routes RelIR
    // now that the child body folds through the ordinary loop (§10·4: a spelling pin pins both).
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")', { spine: 'legacy' });
    expect(c.sql).toContain('(SELECT COUNT(*) FROM (SELECT e.id AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.tgt=p.id');
    expect(c.sql).toContain('>= ?');
    // RelIR asks the same question as an EXISTS over the child's own aggregate, which is why the
    // aggregate has to stay in the probe's select list — see the `AS one` note above.
    const cRel = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")', { spine: 'rel' });
    expect(cRel.spine).toBe('rel');
    expect(cRel.sql).toContain('EXISTS (');
    expect(cRel.sql).toContain('HAVING');
  });

  test('alias-compare where(P.neq("a")) and where("a",P,by(key)); unknown label throws', () => {
    const idc = read('g.V().as("a").out().where(P.neq("a"))');
    expect(idc.sql).toContain('WHERE n.id != CAST(p.a0 ->> ? AS INTEGER)');
    const keyc = read('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name")');
    expect(keyc.sql).toContain("(SELECT value FROM vertex_properties WHERE node=CAST(p.a0 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1) = (SELECT value FROM vertex_properties WHERE node=CAST(p.a1 ->> ? AS INTEGER) AND key=? ORDER BY id LIMIT 1)");
    expect(() => compile('g.V().where("x", P.eq("y"))', {})).toThrow('no such label');
    // alias-compare where() takes at most one by(key) — a second is not a valid
    // modulator here; fail closed rather than silently drop it.
    expect(() => compile('g.V().as("a").out().as("b").where("a", P.eq("b")).by("name").by("age")', {}))
      .toThrow('by() is only supported as an order() or select()/project() modulator');
    // P.not(<inner>) negates the alias comparison (== P.neq for eq).
    const notEq = read('g.V().as("a").out().where(P.not(P.eq("a")))');
    expect(notEq.sql).toContain('WHERE NOT COALESCE((n.id = CAST(p.a0 ->> ? AS INTEGER)), 0)');
    expect(read('g.V().as("a").out().as("b").where("a", P.not(P.eq("b")))').sql)
      .toContain('WHERE NOT COALESCE((CAST(p.a0 ->> ? AS INTEGER) = CAST(p.a1 ->> ? AS INTEGER)), 0)');
  });

  test('where() on a record stream compares two carried alias labels', () => {
    const eq = read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.eq("b"))');
    // The record CTE still carries a0/a1; where filters rows by their history-last ids. The source
    // relation is aliased `p` because this is now the SHARED row re-projection (`aliasCompareRows`)
    // rather than a record-local copy — same rows, same predicate, one implementation.
    expect(eq.sql).toContain('WHERE CAST(p.a0 ->> ? AS INTEGER) = CAST(p.a1 ->> ? AS INTEGER)');
    const neq = read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.neq("b"))');
    expect(neq.sql).toContain('WHERE CAST(p.a0 ->> ? AS INTEGER) != CAST(p.a1 ->> ? AS INTEGER)');
    // P.not on a record where negates; a missing label still throws (drop-not-throw is
    // for select, an unknown label in a comparison is a real error).
    expect(read('g.V().as("a").out().in().as("b").select("a","b").where("a", P.not(P.eq("b")))').sql)
      .toContain('WHERE NOT COALESCE((CAST(p.a0 ->> ? AS INTEGER) = CAST(p.a1 ->> ? AS INTEGER)), 0)');
    expect(() => compile('g.V().as("a").out().as("b").select("a","b").where(__.as("a").out())', {}))
      .toThrow('where() on a record supports only the alias-compare form');
  });

  test('where(__.<multi-hop chain>) → correlated EXISTS over the path', () => {
    // 2-hop path existence: the child fold nests one derived subquery per hop.
    const two = read('g.V().where(__.out().out()).values("name")', { spine: 'legacy' });
    expect(two.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) p ON e.src=p.id) c)');
    // terminal has() on the neighbour — the has() StepFn is consumed by the child fold,
    // correlating on the reached node (aliased n inside the child, isolated by the FROM
    // boundary from the outer n).
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))', { spine: 'legacy' }).sql)
      .toContain("AND (CASE WHEN vtype IN ('byte'");
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))', { spine: 'legacy' }).sql)
      .toContain("ELSE value END) > ?");
    // terminal hasLabel()
    // hasLabel is ANY-label membership over vertex_labels — a seek on vl_label(label, node).
    expect(read('g.V().where(__.out("created").hasLabel("software"))', { spine: 'legacy' }).sql).toContain('n.id IN (SELECT vertex_labels.node FROM vertex_labels WHERE vertex_labels.label IN (SELECT id FROM labels');
    // a lone bare movement keeps the leaner single-hop EXISTS over the movement child
    expect(read('g.V().where(__.out()).count()', { spine: 'legacy' }).sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) c)');

    // Both spines reach the same vtype-aware compare and the same label membership; only the
    // spelling differs, so the shared fragments are what is asserted across them.
    for (const spine of ['legacy', 'rel'] as const) {
      expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))', { spine }).sql)
        .toMatch(/(END\)? > \?|CAST\([^)]+ AS (INT|REAL)\) > \?)/);
      expect(read('g.V().where(__.out("created").hasLabel("software"))', { spine }).sql).toMatch(/vertex_labels[^]*labels/);
    }
  });

  test('where()/filter() deferred forms throw clearly', () => {
    // multi-hop both() now lowers inline through the correlated movement child (the
    // generic StepFns handle both()'s two-direction fan-out) — a nested-derived EXISTS,
    // not the materialized generic gate (`EXISTS (SELECT 1`, with a space).
    expect(read('g.V().where(__.both().both())', { spine: 'legacy' }).sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e');
    // The RelIR route reaches the same shape from the other side: a UNION ALL of the two
    // directions, correlated on the outer id, inside one EXISTS.
    expect(read('g.V().where(__.both().both())', { spine: 'rel' }).sql).toMatch(/EXISTS \(SELECT[^]*UNION ALL/);
    expect(() => compile('g.V().filter(P.gt(1))', {})).toThrow('filter(predicate) not supported');
  });

  test('where/filter/not fall back to generic child row existence', () => {
    const store = seededStore();
    expect(run(store, 'g.V().where(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter']);
    expect(run(store, 'g.V().not(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['lop', 'ripple', 'vadas']);
    expect(read('g.V().filter(__.out().id()).count()').sql).toContain('EXISTS (SELECT 1');
  });

  test('where child order is per-parent and precedes range/limit before EXISTS', () => {
    // LEGACY's shape: the child is compiled once for every parent and PARTITIONed back apart, so the
    // per-parent order is a window. RelIR needs no partition at all — the child is a subquery
    // evaluated per outer row, so its ORDER BY and its slice are per-parent by construction. Two
    // spellings of one contract, which is why the ROW assertion below is the one left spine-ambient.
    const ordered = read('g.V().where(__.out().hasLabel("person").order().by("name").range(1,2))', { spine: 'legacy' });
    expect(ordered.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(ordered.sql).toContain('ORDER BY');
    expect(ordered.sql).toContain('EXISTS (SELECT 1');
    const store = seededStore();
    expect(run(store, 'g.V().where(__.out().hasLabel("person").order().by("name").range(1,2)).values("name")').map((r) => r.v))
      .toEqual(['marko']);
  });

  test('nested local() reuses child ordinals and ordered movement rows', () => {
    const nested = read('g.V(1).local(__.out().local(__.out().order().by("name").limit(1)))');
    expect(nested.sql.match(/PARTITION BY/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(nested.sql).toContain('ORDER BY');
    // The inner order() windows over the FULL origin stack (partitionOver), not just the
    // innermost ordinal — equivalent here (o1 is globally unique) but robust under nesting.
    expect(nested.sql).toContain('PARTITION BY p.o0, p.o1');
  });

  // `has()` is RelIR-routed (§10·4), so these two run on BOTH spines. What is asserted is the
  // SEMANTIC distinction each test is about, not the spelling the spines legitimately differ over —
  // and since the comparability fix (§13a) they differ MORE than parenthesisation:
  //
  //  - legacy applies the operator to the whole vtype-aware compare key: `(CASE … END) >= ?`.
  //  - RelIR pushes the operator INSIDE each type-space arm, because a cross-type comparison must be
  //    FALSE rather than SQLite's storage order (`GremlinValueComparator`: comparability is confined
  //    to one type space) — `CASE WHEN vtype IN (<ints>) THEN CAST(v AS INT) >= ? WHEN vtype IN
  //    (<reals>) THEN CAST(v AS REAL) >= ? ELSE <false> END`.
  //
  // So `compared` accepts either: the operator applied to a compare-key `END`, or applied to a CAST
  // inside one. Both spellings are "the ordering comparison happened, vtype-aware"; neither pins a
  // spine's shape, and a RAW `value >= ?` with no vtype CASE anywhere still fails both alternatives.
  const compared = (op: string) => {
    const o = op.replace(/[><=]/g, (c) => '\\' + c);
    return new RegExp(`(END\\)? ${o} \\?|CAST\\([^)]+ AS (INT|REAL)\\) ${o} \\?)`);
  };
  for (const spine of ['legacy', 'rel'] as const) {
    test(`P.inside is exclusive-low (distinct from between) — ${spine} spine`, () => {
      // between = [lo,hi) ; inside = (lo,hi)
      expect(read('g.V().has("age", P.between(29,35))', { spine }).sql).toMatch(compared('>='));
      expect(read('g.V().has("age", P.inside(29,35))', { spine }).sql).toMatch(compared('>'));
      expect(read('g.V().has("age", P.inside(29,35))', { spine }).sql).not.toMatch(compared('>='));
    });

    test(`has() compiles every predicate form — ${spine} spine`, () => {
      expect(read('g.V().has("age", 30)', { spine }).sql).toContain('= ?');          // eq stays a raw exact compare
      expect(read('g.V().has("age", P.gt(30))', { spine }).sql).toMatch(compared('>')); // range → vtype-aware compareKey
      expect(read('g.V().has("age", P.within(29,30))', { spine }).sql).toMatch(/in \(\?, ?\?\)/i);
      expect(read('g.V().has("age", P.between(29,35))', { spine }).sql).toMatch(compared('>='));
    });

    test(`dedup().by() is a ranked window over the projected key — ${spine} spine`, () => {
      // The MODULATOR SEAM's first element host. Both spines emit the same SHAPE and must: the
      // survivor is the LOWEST-id row per key, which is a `ROW_NUMBER() … = 1` and not a `GROUP BY`,
      // because every other column has to be that row's and an aggregate cannot say which row a
      // `MIN(id)` came from. Matched on the window, not on either spine's aliases.
      const byKey = read('g.V().dedup().by("name")', { spine }).sql;
      expect(byKey).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY[^]*ORDER BY \w+\.id/i);
      expect(byKey).toMatch(/\bFROM vertex_properties\b/);
      // …and the PRODUCTIVITY rule: TinkerPop's default `by()` drops a traverser it yielded nothing
      // for, so the key is tested for NULL. `ProductiveByStrategy` is the position that does not.
      // The NULL is a BIND on the RelIR side and inline on the legacy one — §3.2 makes every `Lit` a
      // bind so the plan can PROVE its budget, and `x IS NOT ?` with a null bind is the same operator.
      const nullTest = /IS NOT (NULL|\?)/i;
      expect(byKey).toMatch(nullTest);
      expect(read('g.withStrategies(ProductiveByStrategy).V().dedup().by("name")', { spine }).sql)
        .not.toMatch(nullTest);
      // A `T` token reads the element itself rather than a property row: an external id is
      // `COALESCE(uid, id)`, a label is the `labels` indirection.
      expect(read('g.V().dedup().by(T.id)', { spine }).sql).toMatch(/PARTITION BY[^]*COALESCE\(\w+\.uid, \w+\.id\)/i);
      expect(read('g.V().dedup().by(T.label)', { spine }).sql).toMatch(/PARTITION BY[^]*\bFROM (labels|vertex_labels)\b/i);
    });
  }
});
