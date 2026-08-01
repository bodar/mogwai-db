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

  test('P.typeOf resolves the stored vtype, with a storage-class fallback', () => {
    // value stream + is(): the per-row vtype column (values() reads vp.vtype) answers the
    // type; a NULL-vtype legacy row falls back to typeof(v). Both binds appear (canonical
    // name for the vtype match, storage class for the fallback).
    const str = read('g.V().values("name").is(P.typeOf(GType.STRING))');
    expect(str.sql).toContain('CASE WHEN p.vtype IS NOT NULL THEN p.vtype = ? ELSE typeof(p.v) = ? END');
    expect(str.binds).toContain('string');
    expect(str.binds).toContain('text');
    expect(read('g.V().values("age").is(P.typeOf(GType.INT))').binds).toContain('int');
    // java class-name string form is equivalent
    expect(read('g.V().values("name").is(P.typeOf("String"))').binds).toContain('string');
    // has(): the EXISTS matches the stored vtype (fallback to typeof(value)).
    expect(read('g.V().has("name", P.typeOf(GType.STRING))').sql)
      .toContain('CASE WHEN vtype IS NOT NULL THEN vtype = ? ELSE typeof(value) = ? END');
    // NULL → is-null; a storage-class-invisible type (boolean) → vtype match, else 0.
    expect(read('g.V().values("age").is(P.typeOf(GType.NULL))').sql).toContain('is null');
    expect(read('g.V().values("age").is(P.typeOf(GType.BOOLEAN))').sql)
      .toContain('CASE WHEN p.vtype IS NOT NULL THEN p.vtype = ? ELSE 0 END');
    // P.not wraps and negates the inner predicate
    expect(read('g.V().values("age").is(P.not(P.typeOf(GType.STRING)))').sql).toContain('NOT ((CASE WHEN p.vtype');
    // an unregistered type name raises
    expect(() => compile('g.V().values("age").is(P.typeOf("bogus-name"))', {})).toThrow('unregistered type');
  });

  test('is(P) folds a predicate onto the projected scalar', () => {
    const gt = read('g.V().values("age").is(P.gt(30))');
    expect(gt.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // is(gt) folds through the vtype-aware compareKey (numeric-correct for the exact tail)
    expect(gt.sql).toContain("ELSE p.v END) > ?"); // the values() JOIN handles existence; is() adds a relational filter
    expect(gt.binds).toContain(30);
    // bare literal → equality
    expect(read('g.V().values("age").is(29)').sql).toContain("p.v = ?");
  });

  test('count().is(P) wraps the count in a value filter (0/1 rows)', () => {
    const p = read('g.V().count().is(P.gt(3))');
    expect(p.sql).toContain('SELECT COALESCE(SUM(s.bulk), 0) AS v FROM c0 s');
    expect(p.sql).toContain('WHERE p.v > ?');
    expect(p.shape).toEqual({ kind: 'value', type: STATIC('long') });
  });

  test('is() on a non-scalar projection throws', () => {
    expect(() => compile('g.V().is(1)', {})).toThrow('is() requires a scalar stream');
  });

  test('TextP compiles to LIKE with a bound, metachar-escaped pattern', () => {
    const sw = read('g.V().has("name", TextP.startingWith("jo"))');
    expect(sw.sql).toContain("like ? escape ?"); // node renderer: lowercase kw, escape bound
    expect(sw.binds).toContain('jo%');
    expect(read('g.V().values("name").is(TextP.containing("ar"))').binds).toContain('%ar%');
    // negation → NOT LIKE
    expect(read('g.V().has("name", TextP.notEndingWith("o"))').sql).toContain("not like ? escape ?");
    // metachars in the user value are escaped, never spliced
    const esc = read('g.V().has("name", TextP.containing("50%_x"))');
    expect(esc.binds).toContain('%50\\%\\_x%');
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

  test('where(__.movement) → EXISTS filter CTE; not() → NOT COALESCE', () => {
    const w = read('g.V().where(__.out("knows")).values("name")');
    // The correlated child is the generic movement StepFn rendered as a nested derived
    // subquery seeded from the outer n.id (index-only; no bespoke xe/xn scheme).
    expect(w.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    const n = read('g.V().not(__.out("created")).values("name")');
    expect(n.sql).toContain('WHERE NOT COALESCE((EXISTS(');
  });

  test('where(__.count().is(P)) → correlated scalar compare over incident edges', () => {
    const c = read('g.V().where(__.inE("knows").count().is(P.gte(1))).values("name")');
    expect(c.sql).toContain('(SELECT COUNT(*) FROM (SELECT e.id AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.tgt=p.id');
    expect(c.sql).toContain('>= ?');
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
    const two = read('g.V().where(__.out().out()).values("name")');
    expect(two.sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) p ON e.src=p.id) c)');
    // terminal has() on the neighbour — the has() StepFn is consumed by the child fold,
    // correlating on the reached node (aliased n inside the child, isolated by the FROM
    // boundary from the outer n).
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))').sql)
      .toContain("AND (CASE WHEN vtype IN ('byte'");
    expect(read('g.V().where(__.out("knows").has("age", P.gt(30)))').sql)
      .toContain("ELSE value END) > ?");
    // terminal hasLabel()
    // hasLabel is ANY-label membership over vertex_labels — a seek on vl_label(label, node).
    expect(read('g.V().where(__.out("created").hasLabel("software"))').sql).toContain('n.id IN (SELECT vertex_labels.node FROM vertex_labels WHERE vertex_labels.label IN (SELECT id FROM labels');
    // a lone bare movement keeps the leaner single-hop EXISTS over the movement child
    expect(read('g.V().where(__.out()).count()').sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) c)');
  });

  test('where()/filter() deferred forms throw clearly', () => {
    // multi-hop both() now lowers inline through the correlated movement child (the
    // generic StepFns handle both()'s two-direction fan-out) — a nested-derived EXISTS,
    // not the materialized generic gate (`EXISTS (SELECT 1`, with a space).
    expect(read('g.V().where(__.both().both())').sql).toContain('EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e');
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
    const ordered = read('g.V().where(__.out().hasLabel("person").order().by("name").range(1,2))');
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

  test('P.inside is exclusive-low (distinct from between)', () => {
    // between = [lo,hi) ; inside = (lo,hi)
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('END) >= ?');
    expect(read('g.V().has("age", P.inside(29,35))').sql).toContain('END) > ?');
    expect(read('g.V().has("age", P.inside(29,35))').sql).not.toContain('END) >= ?');
  });

  test('has() still compiles all predicate forms after the predicateSql refactor', () => {
    expect(read('g.V().has("age", 30)').sql).toContain('= ?');            // eq stays a raw exact compare
    expect(read('g.V().has("age", P.gt(30))').sql).toContain('END) > ?'); // range → vtype-aware compareKey
    expect(read('g.V().has("age", P.within(29,30))').sql).toContain('in (?, ?)');
    expect(read('g.V().has("age", P.between(29,35))').sql).toContain('END) >= ?');
  });
});
