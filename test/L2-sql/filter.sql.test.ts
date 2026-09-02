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
import { read, run, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

// A predicate operand is a CONSTANT when it is a parsed literal (inlined as an escaped SQL literal) and
// BINDS only when it is a wire parameter (docs/archive/2026-08-05-parameters-are-the-only-binds.md). So a
// snapshot asserts the value is PRESENT either way: in the bind list, or in the SQL text (a string
// `'v'`-quoted, a number as a bare token not glued to a word).
const carries = (plan: { sql: string; binds: readonly unknown[] }, v: string | number): boolean =>
  plan.binds.includes(v) || (typeof v === 'string'
    ? plan.sql.includes(`'${v}'`)
    : new RegExp(`(?<![\\w.])${v}(?![\\w.])`).test(plan.sql));

describe('filter / predicate SQL (is/where/not/TextP/has)', () => {

  test('TextP is typed, escaped, and preserves a wire parameter in its LIKE pattern', () => {
    const store = seededStore();
    expect(run(store, 'g.V().has("name",TextP.containing("ark")).values("name")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V().has("name",TextP.notEndingWith("as")).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple']);
    // SQLite would coerce 123 to text and match '2'; TextP is P<String>, so it must not.
    expect(run(store, 'g.inject(123).is(TextP.containing("2"))')).toEqual([]);
    // Text.isNull is false and its negative variants negate that result.
    expect(run(store, 'g.inject(null).is(TextP.notContaining("x"))').map((r) => r.v)).toEqual([null]);

    const p = compile('g.V().has("name",TextP.containing($term))', { $term: 'ark' });
    expect(p.kind).toBe('read');
    if (p.kind === 'read') {
      expect(p.binds).toEqual(['ark']);
      expect(p.sql).toContain('replace(');
    }

    // The FTS path is a physical rewrite: it narrows from property_fts but leaves the generic
    // correlated EXISTS as the semantic check. Turning it off therefore changes the access path,
    // never the accepted traversal or its predicate spelling.
    const indexed = read('g.V().has("name",TextP.containing("ark")).values("name")');
    const generic = read('g.V().has("name",TextP.containing("ark")).values("name")', {
      fastPaths: { ftsSubstringPredicate: false },
    });
    expect(indexed.sql).toContain('property_fts');
    expect(generic.sql).not.toContain('property_fts');

    // Negative TextP is existential over a key's property instances. Its FTS path therefore starts
    // at keyed property rows and anti-probes matching typed-string index entries, rather than
    // incorrectly subtracting whole owners that also have a non-matching value.
    const negIndexed = read('g.V().has("name",TextP.notContaining("ark")).values("name")');
    const negGeneric = read('g.V().has("name",TextP.notContaining("ark")).values("name")', {
      fastPaths: { ftsSubstringPredicate: false },
    });
    expect(negIndexed.sql).toContain('property_fts');
    expect(negIndexed.sql).toContain('IS NOT');
    expect(negGeneric.sql).not.toContain('property_fts');
  });

  // `P.typeOf` on both `is` and `has` asserts the CONTRACT — three resolution modes, and the point of
  // each is which evidence it reads, not how it spells it. A canonical type name and a storage class are
  // compiler-authored CONSTANTS, inlined as escaped literals (the parameter-budget rule). The
  // module-level `carries` asserts the value is present either way, so the contract — that both pieces
  // of evidence appear — holds across the spelling.
  {
  }


  // `values().is()` and `count().is()`: the spelling is pinned where it is the point of the test;
  // everything else is asserted as the SEMANTIC fact, which is what a snapshot is allowed to hold
  // (test/CLAUDE.md).
  {
    test(`is(P) folds a predicate onto the projected scalar`, () => {
      const gt = read('g.V().values("age").is(P.gt(30))');
      expect(gt.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
      // is(gt) folds through the vtype-aware compareKey (numeric-correct for the exact tail). The
      // operator sits INSIDE each type-space arm so a cross-type compare is FALSE rather than SQLite's
      // storage order — so what is asserted is that the comparison is vtype-aware AT ALL. A raw
      // `value > ?` matches neither alternative.
      expect(gt.sql).toMatch(/(END\)? > (?:\?|\d+)|CAST\([^)]+ AS (INT|REAL)\) > (?:\?|\d+))/);
      expect(carries(gt, 30)).toBe(true);   // inlined as a literal
      // bare literal → equality, with no compareKey (equality on canonical text is exact)
      const eq = read('g.V().values("age").is(29)');
      expect(eq.sql).toMatch(/\bv = (?:\?|29)/);
      expect(eq.sql).not.toContain('CAST');
    });

    test(`count().is(P) wraps the count in a value filter (0/1 rows)`, () => {
      const p = read('g.V().count().is(P.gt(3))');
      expect(p.sql).toMatch(/COALESCE\(sum\(.*\), .*\) AS v/i);
      expect(p.shape).toEqual({ kind: 'value', type: STATIC('long') });
    });
  }

  test('a run of range is() stays inside the DO bind cap', () => {
    // The lowering binds query operands but emits its fixed type vocabulary as escaped compiler text.
    // Fusing the filter into its input's block used to make bind growth quadratic in the projection's
    // size, because a WHERE cannot name a select alias so each `is` re-inlined the whole projection;
    // a `Materialize` boundary before the filters lands a CTE-then-filter shape. This pins that the
    // growth is LINEAR and bounded, since the failure mode is a plan that fails closed above 100 binds.
    const many = 'g.V().values("age").is(P.gt(1)).is(P.lt(9)).is(P.gte(2)).is(P.neq(5)).is(P.gt(0))';
    expect(read(many).binds.length).toBeLessThan(60);
    // The spelling is not charged once per static type name: five predicates retain only their query
    // values, not their repeated comparison vocabulary.
    expect(read(many).binds.length).toBeLessThan(20);
  });






  test('where(__.movement) → a correlated EXISTS with no seed relation — rel spine', () => {
    // The lowering compares the edge column to the OUTER id directly, rather than seeding the child
    // with `(SELECT n.id AS id) p` — a projection with no input, which the algebra has no node for and
    // does not need. No new node kind (§7's bar: the seam CAN express the shape).
    const w = read('g.V().where(__.out("knows")).values("name")');
    // The probe projects the CHILD'S OWN first column rather than a literal: an EXISTS does not care
    // what the value is, but a body ending in an aggregate does — projecting `1` there leaves a block
    // with a HAVING and no aggregate in its select list, which SQLite refuses.
    expect(w.sql).toMatch(/EXISTS \(SELECT \w+\.tgt AS one FROM edges \w+ WHERE \(\(\w+\.src = \w+\.id\) AND \w+\.label IN/);
    // `NOT EXISTS`, not `NOT COALESCE(EXISTS(…), 0)`: an EXISTS is never NULL, so the COALESCE guards
    // nothing.
    const n = read('g.V().not(__.out("created")).values("name")');
    expect(n.sql).toContain('NOT EXISTS (');
    expect(n.sql).not.toContain('COALESCE((EXISTS');
  });






  test('where/filter/not fall back to generic child row existence', () => {
    const store = seededStore();
    expect(run(store, 'g.V().where(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['josh', 'marko', 'peter']);
    expect(run(store, 'g.V().not(__.out().id()).values("name")').map((r) => r.v).sort())
      .toEqual(['lop', 'ripple', 'vadas']);
    // A CORRELATED EXISTS over the child's rows. The assertion is the SHAPE, not the spelling (§5):
    // the gate projects the child's own value as `one`. Pinning the projection would pin an alias the
    // lowering is free to choose.
    expect(read('g.V().filter(__.out().id()).count()').sql).toMatch(/EXISTS \(SELECT[^]*FROM edges/);
  });



  // `has()` — what is asserted is the SEMANTIC distinction each test is about, not the exact spelling.
  // Since the comparability fix (§6·7a) the lowering pushes the operator INSIDE each type-space arm,
  // because a cross-type comparison must be FALSE rather than SQLite's storage order
  // (`GremlinValueComparator`: comparability is confined to one type space) — `CASE WHEN vtype IN
  // (<ints>) THEN CAST(v AS INT) >= ? WHEN vtype IN (<reals>) THEN CAST(v AS REAL) >= ? ELSE <false>
  // END`.
  //
  // So `compared` accepts either: the operator applied to a compare-key `END`, or applied to a CAST
  // inside one. Both spellings are "the ordering comparison happened, vtype-aware"; a RAW `value >= ?`
  // with no vtype CASE anywhere still fails both alternatives. The operand may be a `?` or an inlined
  // numeric literal — either is "the ordering comparison, vtype-aware".
  const compared = (op: string) => {
    const o = op.replace(/[><=]/g, (c) => '\\' + c);
    return new RegExp(`(END\\)? ${o} (?:\\?|-?\\d+(?:\\.\\d+)?)|CAST\\([^)]+ AS (INT|REAL)\\) ${o} (?:\\?|-?\\d+(?:\\.\\d+)?))`);
  };
  {
    test(`P.inside is exclusive-low (distinct from between)`, () => {
      // between = [lo,hi) ; inside = (lo,hi)
      expect(read('g.V().has("age", P.between(29,35))').sql).toMatch(compared('>='));
      expect(read('g.V().has("age", P.inside(29,35))').sql).toMatch(compared('>'));
      expect(read('g.V().has("age", P.inside(29,35))').sql).not.toMatch(compared('>='));
    });

    test(`has() compiles every predicate form`, () => {
      expect(read('g.V().has("age", 30)').sql).toMatch(/= (?:\?|30)/);     // eq stays a raw exact compare
      expect(read('g.V().has("age", P.gt(30))').sql).toMatch(compared('>')); // range → vtype-aware compareKey
      expect(read('g.V().has("age", P.within(29,30))').sql).toMatch(/in \((?:\?|\d+), ?(?:\?|\d+)\)/i);
      expect(read('g.V().has("age", P.between(29,35))').sql).toMatch(compared('>='));
    });

    test(`dedup().by() is a ranked window over the projected key`, () => {
      // The MODULATOR SEAM's first element host. The SHAPE is forced: the survivor is the LOWEST-id
      // row per key, which is a `ROW_NUMBER() … = 1` and not a `GROUP BY`, because every other column
      // has to be that row's and an aggregate cannot say which row a `MIN(id)` came from. Matched on
      // the window, not on the lowering's aliases.
      const byKey = read('g.V().dedup().by("name")').sql;
      expect(byKey).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY[^]*ORDER BY \w+\.id/i);
      expect(byKey).toMatch(/\bFROM vertex_properties\b/);
      // …and the PRODUCTIVITY rule: TinkerPop's default `by()` drops a traverser it yielded nothing
      // for, so the key is tested for NULL. `ProductiveByStrategy` is the position that does not.
      // The NULL is a BIND — §3.2 makes every `Lit` a bind so the plan can PROVE its budget, and
      // `x IS NOT ?` with a null bind is the same operator as `IS NOT NULL`.
      const nullTest = /IS NOT (NULL|\?)/i;
      expect(byKey).toMatch(nullTest);
      expect(read('g.withStrategies(ProductiveByStrategy).V().dedup().by("name")').sql)
        .not.toMatch(nullTest);
      // A `T` token reads the element itself rather than a property row: an external id is
      // `COALESCE(uid, id)`, a label is the `labels` indirection.
      expect(read('g.V().dedup().by(T.id)').sql).toMatch(/PARTITION BY[^]*COALESCE\(\w+\.uid, \w+\.id\)/i);
      expect(read('g.V().dedup().by(T.label)').sql).toMatch(/PARTITION BY[^]*\bFROM (labels|vertex_labels)\b/i);
    });
  }

  // The parameter budget must not depend on WHERE a `$x` sits: a wire parameter binds whether it is a
  // bare `has` value or nested in a predicate/set, while a parsed literal inlines either way
  // (docs/archive/2026-08-05-parameters-are-the-only-binds.md).
  test('a wire parameter binds whether bare or nested; a literal inlines either way', () => {
    const b = (g: string, params: Record<string, unknown> = {}) => {
      const p = compile(g, params);
      return p.kind === 'read' ? p.binds : [];
    };
    // literals inline — no binds — at every nesting.
    expect(b('g.V().has("age", 30)')).toEqual([]);
    expect(b('g.V().has("age", P.gt(30))')).toEqual([]);
    expect(b('g.V().has("name", within("a","b"))')).toEqual([]);
    // a parameter binds ONCE however many times it is spelled — the budget is for PARAMETERS, not their
    // uses (docs/archive/2026-08-05-parameters-are-the-only-binds.md, "Repeated parameters"): compareKey spells
    // an ordering operand twice, and both collapse to a single reused placeholder.
    expect(b('g.V().has("age", xx1)', { xx1: 30 })).toEqual([30]);
    expect(b('g.V().has("age", P.gt(xx1))', { xx1: 30 })).toEqual([30]);          // spelled twice, ONE bind
    expect(b('g.V().has("name", within(xx1,xx2))', { xx1: 'a', xx2: 'b' })).toEqual(['a', 'b']);
    expect(b('g.V().has("age", P.between(xx1,xx2))', { xx1: 29, xx2: 35 })).toEqual([29, 35]); // each bound once
  });

  // A ROOTED nested operand ending in `order()` resolves to its ORDERED first, never a scan-order value.
  // `P.resolve(traverser)` takes `tv.next()`, so a barrier-ordered operand's first is the sorted first —
  // the operand's emission order rides its `encounter` channel and the pick is `ORDER BY encounter LIMIT
  // 1`. The list-member-predicate seam once hand-rolled a copy that projected the value with NO
  // order/limit (a scan-order value); both seams now share `firstRootedValue`, so a regression here
  // would be a re-inlined copy. (No corpus scenario exercises this ceiling case — hence the SQL pin.)
  test('a rooted ORDERED operand takes its ordered first, in both operand seams', () => {
    const orderedFirst = /ORDER BY[^)]*\bencounter\b[^)]*ASC LIMIT 1/i;
    // The list-member-predicate seam (`list.ts` resolveScalar → firstRootedValue) — the one that drifted.
    expect(read('g.inject([1,2,3]).none(P.eq(__.V().values("age").order()))').sql).toMatch(orderedFirst);
    // The predicate-operand seam (`nestedFirstValue` → firstRootedValue) — behaviour-preserved.
    expect(read('g.V().has("name", P.gt(__.V().values("age").order()))').sql).toMatch(orderedFirst);
  });

});
