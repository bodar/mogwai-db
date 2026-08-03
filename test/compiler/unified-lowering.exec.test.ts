// Compiler execution semantics (split from test/compiler.test.ts) — unified lowering / filter / sack / aggregate / order / local.
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { PER_ROW, STATIC } from '../../src/sql/kernel/render.ts';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { rawVertex } from '../support/graph.ts';
import { bagOf, bare, read, run, runWith, seededStore } from '../support/harness.ts';

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe('compiler execution semantics', () => {
describe('unified lowering characterization', () => {
  test('every disable-safe fast path is result-equivalent to generic lowering', () => {
    const store = seededStore();
    const cases: Array<{ key: keyof NonNullable<CompileOptions['fastPaths']>; query: string; fastSql: string; fastPattern?: RegExp; genericSql: string; genericNot?: RegExp }> = [
      {
        // fast middle = the inline correlated movement child (a nested derived EXISTS,
        // no CTE); generic middle = the materialized child-existence gate (ROW_NUMBER
        // domain). Same filterCte plumbing either way.
        //
        // This case is the SWITCH-ASYMMETRIC one: RelIR implements the inlined side of
        // `predicateInlining` and declines the generic side (§10·4), so the enabled position is
        // RelIR-routed and the disabled position is legacy — which is exactly what keeps the switch
        // meaningful rather than a coverage toggle. So the fast side is matched on the SHAPE both
        // spines emit and not on either's aliases: the body reaches `edges` INSIDE the EXISTS. That is
        // the whole difference from the generic side, whose EXISTS reads a materialized CTE — and it
        // must hold with `MOGWAI_RELIR=0` too, where this position is legacy again
        // (`mise run test:legacy-spine`). A pattern that named one spine's join shape failed there,
        // which is the differential doing its job on a test rather than on the compiler.
        key: 'predicateInlining',
        query: 'g.V().where(__.out("knows")).values("name").order()',
        fastSql: 'WHERE EXISTS',
        fastPattern: /EXISTS\s*\([^]*\bFROM edges\b/,
        genericSql: 'ROW_NUMBER() OVER () AS o0',
      },
      {
        // and()/or() honour the same switch: inline correlated EXISTS vs the generic
        // shared-domain combiner (both branches reuse one ordinal — `c.o0=d.o0`).
        key: 'predicateInlining',
        query: 'g.V().and(__.out("knows"), __.out("created")).values("name").order()',
        fastSql: ') AND (EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e',
        genericSql: 'c.o0=d.o0',
      },
      {
        // count().is(P): fast middle = COUNT over the inline correlated movement child
        // (no CTE); generic middle = the reducer child (COUNT ... GROUP BY o0 HAVING)
        // gated on existence. Same filterCte plumbing either way.
        key: 'predicateInlining',
        query: 'g.V().where(__.out().count().is(gt(1))).values("name").order()',
        fastSql: 'WHERE (SELECT COUNT(*) FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id) c) > ?',
        genericSql: 'HAVING COUNT(',
      },
      {
        // choose(pred, then[, else]) honours predicateInlining too (the gating-fix: chooseGate has
        // a generic fallback — tryGateByChildExistence — unlike until()/emit(), so disabling inlining
        // compiles the same choose() generically). Fast = the inline correlated EXISTS gate; generic
        // = the materialized child-existence gate. Result-equivalent.
        key: 'predicateInlining',
        query: 'g.V().choose(__.out("knows"),__.values("name"),__.constant("none")).order()',
        fastSql: 'EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e',
        genericSql: 'ROW_NUMBER() OVER () AS o0',
      },
      {
        // A body that MENTIONS a path-history label inlines like any other: the correlated seed
        // projects the outer row's alias columns (`SELECT n.id AS id, p.a0 AS a0`), so the read
        // two scopes down is physically there to make. Before that seeding the renderer had to
        // decline every label-mentioning body — an absent alias column is indistinguishable from
        // a never-bound label — and the whole family fell to the materialized gate.
        key: 'predicateInlining',
        query: 'g.V().as("x").where(__.out("created").where(__.select("x"))).values("name").order()',
        fastSql: '(SELECT n.id AS id, p.a0 AS a0)',
        genericSql: 'ROW_NUMBER() OVER () AS o0',
      },
      {
        // A label bound mid-body and read back in the SAME body is the other half: the bind mints
        // a fresh alias column INSIDE the correlated child (a1, after the seeded a0) and the
        // select() re-root reads it — no second label mechanism, just the engine's one
        // element-body fold running over the inline seed.
        key: 'predicateInlining',
        query: 'g.V().as("x").where(__.out().as("z").select("z").has("name","lop")).values("name").order()',
        fastSql: 'AS a1 FROM',
        genericSql: 'ROW_NUMBER() OVER () AS o0',
      },
      {
        key: 'singleHopOptional',
        query: 'g.V().optional(__.out("knows")).count()',
        fastSql: 'LEFT JOIN edges',
        genericSql: 'UNION ALL SELECT id',
      },
      {
        // fast = the unrolled GROUP-BY-SUM(bulk) frontier CTEs, whose collapsed (id,bulk) relation
        // re-enters generic lowering; count() finishes via lowerGlobalCount's COALESCE(SUM(bulk)).
        // generic = the enumerate-every-walk recursive CTE. Same total either way.
        key: 'bulkRepeatCount',
        query: 'g.V().repeat(__.out()).times(2).count()',
        fastSql: 'SUM(s.bulk)',
        genericSql: 'with recursive',
      },
      {
        // frontier collapse: fast = each movement wraps its walks in SUM(bulk) GROUP BY id
        // (bounded frontier); generic = the plain UNION-ALL movement CTE. The terminal count's
        // SUM(bulk) makes them the same total either way.
        key: 'movementCollapse',
        query: 'g.V().both().both().count()',
        // RelIR-routed (§10·4), and `movementCollapse` is the one fast path the RelIR route
        // EXPRESSES rather than declines — it is a plan rewrite the algebra can state exactly (a
        // grouped SUM(bulk)) rather than a different physical access path, so the switch keeps
        // both positions and this case keeps testing what it was written to test. Matched on the
        // SHAPE both spines emit (`sum(<bulk>) … GROUP BY`) rather than on either one's aliases.
        fastSql: 'GROUP BY',
        fastPattern: /sum\(\w*\.?bulk\)[^]*GROUP BY/i,
        genericSql: 'UNION ALL',
        genericNot: /GROUP BY/i,
      },
      {
        // scalar predicate: inline = one WHERE over the value (filters c1 directly); generic
        // = a pushed child scope (ROW_NUMBER domain) gated on a correlated EXISTS. Equivalent.
        key: 'scalarPredicateInlining',
        query: "g.V().values('age').where(__.is(gt(30))).order()",
        fastSql: 'FROM c1 p WHERE',
        genericSql: 'EXISTS (SELECT 1 FROM',
      },
      {
        // and() over a scalar honours the same switch (both arms inline in one WHERE vs both
        // as correlated-existence terms sharing one pushed ordinal).
        key: 'scalarPredicateInlining',
        query: "g.V().values('age').and(__.is(gt(28)),__.is(lt(34))).order()",
        fastSql: 'FROM c1 p WHERE',
        genericSql: 'ROW_NUMBER() OVER () AS o0',
      },
      {
        // choose over a scalar honours the same switch: the predicate gate inlines as one WHERE
        // over the value (then/else seeds) vs a correlated EXISTS over a pushed scalar scope.
        key: 'scalarPredicateInlining',
        query: "g.V().values('age').choose(__.is(gt(30)),__.constant(1),__.constant(0)).order()",
        fastSql: 'FROM c1 p WHERE (',
        genericSql: 'EXISTS (SELECT 1 FROM',
      },
      {
        // coalesce over a scalar honours the same switch: each arm's productivity inlines as a
        // WHERE over the value vs a correlated EXISTS over the arm's child (one shared ordinal).
        key: 'scalarPredicateInlining',
        query: "g.V().values('age').coalesce(__.is(gt(30)),__.constant(0)).order()",
        fastSql: 'FROM c1 p WHERE (',
        genericSql: 'EXISTS (SELECT 1 FROM',
      },
    ];

    for (const { key, query, fastSql, fastPattern, genericSql, genericNot } of cases) {
      const enabled = { fastPaths: { [key]: true } } as CompileOptions;
      const disabled = { fastPaths: { [key]: false } } as CompileOptions;
      expect(read(query, enabled).sql).toContain(fastSql);
      if (fastPattern) expect(read(query, enabled).sql).toMatch(fastPattern);
      expect(read(query, disabled).sql).toContain(genericSql);
      if (genericNot) expect(read(query, disabled).sql).not.toMatch(genericNot);
      expect(runWith(store, query, enabled)).toEqual(runWith(store, query, disabled));
    }

    // INFIX .and()/.or() — the shape this suite could not see, and the reason predicateInlining's
    // declared enabled≡disabled contract was FALSE until 2026-07-27. The fold lived inside the fast
    // path, so flipping the flag off did not route the body generically, it lost the capability:
    // 6 corpus traversals compiled only with inlining ON. Every case above happens to have a
    // generic fallback, so the contract violation was invisible here. The fold is now
    // ConnectiveStrategy (a `fold` Pass), which runs regardless of the flag — so these compile
    // BOTH ways and agree, and the flag is a pure performance switch. Do not delete: this is the
    // regression guard for putting a capability back inside a fast path.
    for (const query of [
      'g.V().has("name","marko").or().has("name","josh").values("name").order()',
      'g.V().hasLabel("person").and().has("age",gte(32)).values("name").order()',
      'g.V().where(__.out("created").and().out("knows").or().in("knows")).values("name").order()',
      'g.V().hasLabel("person").choose(__.values("age").is(gt(29)).and().values("age").is(lt(35)),__.values("name"),__.constant("x")).order()',
    ]) {
      const on = { fastPaths: { predicateInlining: true } } as CompileOptions;
      const off = { fastPaths: { predicateInlining: false } } as CompileOptions;
      expect(runWith(store, query, on)).toEqual(runWith(store, query, off));
    }

    // A repeat() INSIDE a filter body — found by L5's rotating seed, and the same contract
    // violation from the other side: the inline renderer is a nested-derived query with no
    // shared WITH, so it cannot host the recursive CTE and its kernel guard THREW, while the
    // materialized gate compiled the body fine. A fast path that throws where the generic path
    // answers is a capability switch. `compileCorrelatedChild` now recognizes the shape up front
    // and declines. Do not delete: this is the guard for that decline.
    for (const query of [
      'g.V(1).where(__.out().repeat(__.identity()).times(1))',
      'g.V(1).where(__.out().identity().repeat(__.has("age",gt(1))).times(1)).values("name")',
      'g.V(1).filter(__.out().repeat(__.identity()).times(1)).values("name")',
      'g.V(1).not(__.out().repeat(__.identity()).times(1)).values("name")',
      'g.V().where(__.out().repeat(__.out()).times(1)).values("name").order()',
    ]) {
      const on = { fastPaths: { predicateInlining: true } } as CompileOptions;
      const off = { fastPaths: { predicateInlining: false } } as CompileOptions;
      expect(runWith(store, query, on)).toEqual(runWith(store, query, off));
    }

    // Element-terminal movementCollapse can't use the raw-row comparison above: the vertex leaf
    // carries a `bulk` column and emits ONE (v, N) row per element (fastSql), so the rows
    // legitimately DIFFER from the per-walk generic form. Equivalence is at the RLE-expanded
    // multiset — expand each row by its bulk and compare the id bags.
    expect(read('g.V().both().both()', { fastPaths: { movementCollapse: true } }).sql).toContain('AS props, p.bulk AS bulk FROM');
    const idBag = (query: string, fp: Partial<NonNullable<CompileOptions['fastPaths']>>) => {
      const p = read(query, { fastPaths: fp });
      return store.query(p.sql, p.binds).flatMap((r: any) => Array(Number(r.bulk ?? 1)).fill(r.id)).sort();
    };
    expect(idBag('g.V().both().both()', { movementCollapse: true })).toEqual(idBag('g.V().both().both()', { movementCollapse: false })); // collapsed (v,N) expands to the same vertex bag
    // bare dedup() is collapse-safe: it resets bulk to 1, so the collapsed frontier deduplicates
    // to the same distinct-vertex set as the enumerated form.
    expect(idBag('g.V().both().both().dedup()', { movementCollapse: true })).toEqual(idBag('g.V().both().both().dedup()', { movementCollapse: false }));
    // Element-returning repeat also bulks: the frontier unroll re-enters generic lowering as a
    // bulk-carrying element stream, and the element leaf frames each vertex as (v, bulk) — the same
    // p.bulk projection movementCollapse uses — so the RLE-expanded multiset equals the generic
    // recursive-CTE enumeration.
    expect(read('g.V(1).repeat(__.both()).times(2)', { fastPaths: { bulkRepeatCount: true } }).sql).toContain('AS props, p.bulk AS bulk FROM');
    expect(idBag('g.V(1).repeat(__.both()).times(2)', { bulkRepeatCount: true })).toEqual(idBag('g.V(1).repeat(__.both()).times(2)', { bulkRepeatCount: false }));

    // Bulk-aware order()+limit/range/skip (element-terminal): the collapsed cumulative-bulk window
    // yields the SAME ordered traverser slice as enumerate-then-sort-then-slice. Compare the
    // EXPANDED ROW ORDER (not the multiset) — position is the whole point of order()/limit(). The
    // modern graph's names are unique, so the sort is total and the slice deterministic.
    const orderedBag = (query: string, collapse: boolean) => {
      const p = read(query, { fastPaths: { movementCollapse: collapse } });
      return store.query(p.sql, p.binds).flatMap((r: any) => Array(Number(r.bulk ?? 1)).fill(r.id)); // row order preserved
    };
    for (const query of [
      'g.V().both().order().by("name").limit(4)',
      'g.V().both().order().by("name", Order.desc).limit(3)',
      'g.V().both().both().order().by("name").range(2, 6)',
      'g.V().both().order().by("name").skip(5)',
    ]) {
      expect(read(query, { fastPaths: { movementCollapse: true } }).sql).toContain('OVER (ORDER BY'); // the cumulative-bulk window
      expect(orderedBag(query, true)).toEqual(orderedBag(query, false));
    }

    // groupCount() / sum / group().by(k).by(count()) after repeat().times(n): the collapsed
    // frontier feeds the generic bulk-aware barrier (SUM(bulk) per key / SUM(v·bulk)), so a
    // dense/deep repeat stays bounded by |V| yet gives the SAME reduction as the enumerate-every-
    // walk recursive form. group/groupCount rows carry (gk, gv); a scalar reducer carries (v). Both
    // are order-independent aggregates → compare sorted rows. This is the equivalence obligation the
    // bulkRepeatCount FastPath's equivalentWhen names.
    const rows = (query: string, on: boolean) => runWith(store, query, { fastPaths: { bulkRepeatCount: on } })
      .map((r: any) => JSON.stringify(bare(r))).sort();
    for (const query of [
      'g.V().repeat(__.both()).times(2).groupCount()',                 // bare element key
      'g.V().repeat(__.both()).times(2).groupCount().by(T.label)',     // token key
      'g.V().repeat(__.out()).times(2).groupCount().by("name")',       // property key
      'g.V().repeat(__.both()).times(2).count()',                      // global count
      'g.V().repeat(__.out()).times(2).values("age").sum()',           // numeric reducer after a scalar projection
      'g.V().repeat(__.both()).times(2).group().by(T.label).by(__.count())', // group value-count
      'g.V(1).repeat(__.both()).times(3).both().groupCount()',         // a bulk-preserving post-repeat movement then groupCount
    ]) {
      expect(rows(query, true)).toEqual(rows(query, false));
    }
    // The fast form genuinely collapses (no recursive walk); the generic form enumerates.
    expect(read('g.V().repeat(__.both()).times(2).groupCount()', { fastPaths: { bulkRepeatCount: true } }).sql).not.toContain('with recursive');
    expect(read('g.V().repeat(__.both()).times(2).groupCount()', { fastPaths: { bulkRepeatCount: false } }).sql).toContain('with recursive');
    expect(read('g.V().repeat(__.out()).times(2).values("age").sum()', { fastPaths: { bulkRepeatCount: true } }).sql).not.toContain('with recursive');
  });

  test('the inline correlated predicate child stays index-only (no MATERIALIZE)', () => {
    // The whole point of the inline-correlated rendering over the materialized generic
    // gate: the movement child is a nested derived subquery the planner drives through
    // the covering edge index, NOT a materialized domain + window. Guard both the
    // EXISTS and the count().is forms against a regression to the heavy shape.
    const store = seededStore();
    const plan = (query: string, options: CompileOptions) => {
      const p = compile(query, {}, options);
      if (p.kind !== 'read') throw new Error('expected read plan');
      return store.query('EXPLAIN QUERY PLAN ' + p.sql, p.binds).map((r: any) => r.detail).join('\n');
    };
    const enabled = { fastPaths: { predicateInlining: true } };
    const disabled = { fastPaths: { predicateInlining: false } };
    for (const query of [
      'g.V().where(__.out("knows")).values("name")',
      'g.V().where(__.out().count().is(gt(1))).values("name")',
      // A label-mentioning body is index-only on exactly the same terms: seeding the outer
      // alias columns adds columns to the correlated relation, not a materialization.
      'g.V().as("x").where(__.out("created").where(__.select("x"))).values("name")',
    ]) {
      const fast = plan(query, enabled);
      expect(fast).toContain('e_out'); // the correlated movement rides the covering index
      expect(fast).not.toContain('MATERIALIZE');
      expect(plan(query, disabled)).toContain('MATERIALIZE'); // generic gate materializes
    }
  });

  test('a scalar projection answers the same at root and in every child position', () => {
    // The child projector used to be a SECOND implementation — its own values/id/label/constant
    // switch — and it read `vp.value` raw where the generic PROJECTORS entry reads
    // `storedValueExpr(value, vtype)`. A LIST-valued property is where the two diverge: at root
    // `values("nums").max()` yields the list, and in a child it yielded NOTHING — a silent wrong
    // answer, not a deferral. The child now lowers `<prefix>.<projection>` through the same
    // `lowerStepsStrict` the root does and continues only the per-origin reducer tail by hand.
    const store = seededStore();
    executeQuery(store, 'g.V().has("name","marko").property("nums", [1,2,3])', {});
    const rootAnswer = run(store, 'g.V().has("name","marko").values("nums").max()').map((r: any) => r.v);
    expect(rootAnswer).toHaveLength(1);
    for (const body of [
      'g.V().has("name","marko").map(__.values("nums").max())',
      'g.V().has("name","marko").local(__.values("nums").max())',
    ]) expect(run(store, body).map((r: any) => r.v)).toEqual(rootAnswer);
    // …and the shapes that already agreed still do, through the one route rather than two.
    expect(run(store, 'g.V().map(__.out().id().count())').map((r: any) => Number(r.v)).sort())
      .toEqual(run(store, 'g.V().map(__.out().count())').map((r: any) => Number(r.v)).sort());
    expect(run(store, 'g.V(1).map(__.out().label().max())').map((r: any) => r.v)).toEqual(['software']);
    expect(run(store, 'g.V(1).map(__.out().constant("z").count())').map((r: any) => Number(r.v))).toEqual([3]);
  });

  test('duplicate parent traversers remain distinct through a child reduction', () => {
    const store = seededStore();
    // The two identity arms are two traversers with the same vertex id. A future
    // child-domain relation must key them by ordinal, never collapse them by id.
    expect(run(store, 'g.V(1).union(__.identity(),__.identity()).local(__.outE().count())')
      .map((r) => r.v)).toEqual([3, 3]);
  });

  test('empty child count is total per parent, including zero', () => {
    const store = seededStore();
    expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
  });

  test('a SQL NULL traverser is distinct from no traverser', () => {
    const store = seededStore();
    expect(run(store, 'g.inject(null).count()').map((r) => r.v)).toEqual([1]);
    expect(run(store, 'g.inject().count()').map((r) => r.v)).toEqual([0]);
  });

  test('nested child ordinals are unique and outer correlation survives', () => {
    const nested = read('g.V().optional(__.out().optional(__.out())).path()');
    expect(nested.sql).toContain('AS o0');
    expect(nested.sql).toContain('AS o1');

    const store = seededStore();
    expect(run(store, 'g.V(1).as("a").optional(__.out("knows")).select("a")')
      .map((r) => r.id)).toEqual([1, 1]);
    expect(run(store, 'g.V(1).optional(__.out("knows")).path()').length).toBe(2);
  });

  test('the current provider encounter key makes local limit deterministic', () => {
    const store = seededStore();
    expect(run(store, 'g.V(1).local(__.outE().limit(1)).inV().values("name")')
      .map((r) => r.v)).toEqual(['vadas']); // edge id 7 precedes edge ids 8 and 9
    expect(run(store, 'g.V(1).local(__.out().order().by("name").limit(1)).values("name")')
      .map((r) => r.v)).toEqual(['josh']);
    expect(run(store, 'g.V(1).flatMap(__.out().range(1,3)).values("name")')
      .map((r) => r.v).sort()).toEqual(['josh', 'lop']);
    expect(run(store, 'g.V(1).map(__.out().skip(1)).values("name")')
      .map((r) => r.v)).toEqual(['lop']);
    expect(run(store, 'g.V(1).local(__.out().limit(2).fold()).unfold().values("name")')
      .map((r) => r.v).sort()).toEqual(['lop', 'vadas']);
  });

  test('scalar child row operators partition by parent before cardinality consumption', () => {
    const store = seededStore();
    // is() must filter the productive child rows before map chooses its first row.
    expect(run(store, 'g.V(1).map(__.out().values("name").is("josh"))').map((r) => r.v)).toEqual(['josh']);
    // order/range are local to marko's child stream and retain their explicit
    // encounter key through successive relational operators.
    expect(run(store, 'g.V(1).map(__.out().values("name").order().by(Order.desc).limit(1))').map((r) => r.v))
      .toEqual(['vadas']);
    expect(run(store, 'g.V(1).flatMap(__.out().values("name").order().range(1,3))').map((r) => r.v))
      .toEqual(['lop', 'vadas']);
    expect(run(store, 'g.V(1).local(__.out().values("name").order().limit(2))').map((r) => r.v))
      .toEqual(['josh', 'lop']);
    expect(run(store, 'g.V(1).flatMap(__.both().label().dedup()).count()').map((r) => r.v)).toEqual([2]);
    // A reducer consumes the already-filtered child rows and restores an explicit
    // zero from the parent domain when none remain.
    expect(run(store, 'g.V().map(__.out().values("name").is("lop").count())').map((r) => r.v).sort())
      .toEqual([0, 0, 0, 1, 1, 1]);
    expect(run(store, 'g.V(1).map(__.outE().values("weight").sum())').map((r) => r.v)).toEqual([1.9]);
    expect(run(store, 'g.V().map(__.out().values("name").fold()).count(Scope.local)').map((r) => r.v).sort())
      .toEqual([0, 0, 0, 1, 2, 3]);
    expect(run(store, 'g.V(1).local(__.out().values("name").order().fold()).unfold()').map((r) => r.v))
      .toEqual(['josh', 'lop', 'vadas']);
    expect(run(store, 'g.V(1).flatMap(__.constant(null).fold()).count(Scope.local)').map((r) => r.v))
      .toEqual([1]);
    expect(run(store, 'g.V().map(__.out().fold()).count(Scope.local)').map((r) => r.v).sort())
      .toEqual([0, 0, 0, 1, 2, 3]);
  });

  test('ordered child existence uses the generic child row pipeline', () => {
    expect(read('g.V().local(__.outE().fold())').shape).toEqual({ kind: 'jsonbElementList', elem: 'edge' });
    const lists = run(seededStore(), 'g.V(1).local(__.out().fold())').map((r) => JSON.parse(r.list));
    expect(lists).toHaveLength(1);
    expect(lists[0].map((v: any) => v.id)).toEqual([2, 3, 4]);
    // The order() is inside where(), which is a FILTER — it decides which vertices survive, not
    // what order the survivors leave in, and nothing downstream asks for one. Multiset.
    expect(bagOf(run(seededStore(), 'g.V().where(__.out().order().by("name").limit(1)).values("name")').map((r) => r.v)))
      .toEqual(['josh', 'marko', 'peter']);
  });

  test('as() labels a scalar stream; select() reads it back with Pop semantics', () => {
    const store = seededStore();
    // single binding: bare/first/last/mixed all yield the one value; all → singleton list
    expect(run(store, 'g.V(1).values("name").as("a").select("a")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V(1).values("name").as("a").select(Pop.first, "a")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V(1).values("name").as("a").select(Pop.last, "a")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V(1).values("name").as("a").select(Pop.mixed, "a")').map((r) => r.v)).toEqual(['marko']);
    expect(run(store, 'g.V(1).values("name").as("a").select(Pop.all, "a")').map((r) => JSON.parse(r.list)))
      .toEqual([[{ t: 'string', v: 'marko' }]]);
    // a labelled count (a scalar) round-trips
    expect(run(store, 'g.V().hasLabel("person").count().as("a").select("a")').map((r) => r.v)).toEqual([4]);
  });

  test('rebound scalar label accumulates history; Pop reads the right end / all', () => {
    const store = seededStore();
    // name → concat → length, all labelled "a" (3 bindings)
    const q = (pop: string) => `g.V(1).values("name").as("a").concat("X").as("a").length().as("a").select(${pop})`;
    expect(run(store, q('"a"')).map((r) => r.v)).toEqual([6]);          // bare = last = length("markoX")
    expect(run(store, q('Pop.last, "a"')).map((r) => r.v)).toEqual([6]);
    expect(run(store, q('Pop.first, "a"')).map((r) => r.v)).toEqual(['marko']);
    expect(run(store, q('Pop.all, "a"')).map((r) => JSON.parse(r.list)))
      .toEqual([[{ t: 'string', v: 'marko' }, 'markoX', 6]]);
    // mixed with >1 binding behaves like all
    expect(run(store, q('Pop.mixed, "a"')).map((r) => JSON.parse(r.list)))
      .toEqual([[{ t: 'string', v: 'marko' }, 'markoX', 6]]);
  });

  test('multi-label select mixes a scalar label and an element label into one Map', () => {
    const record = read('g.V(1).values("name").as("a").select("a")');
    expect(record.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    // a → element (vertex), b → its name (scalar): a heterogeneous record
    const mixed = read('g.V(1).as("a").values("name").as("b").select("a","b")');
    expect(mixed.shape).toEqual({ kind: 'map', entries: [
      { key: 'a', prefix: 'e0', sub: 'vertex' },
      { key: 'b', prefix: 'e1', sub: 'value', type: PER_ROW('e1_vtype') },
    ] });
  });
});
describe('child body with movement under path tracking (pushChildScope ordinal-order)', () => {
  // A by()-modulator / reducer / existence child whose body contains movement, lowered while
  // the outer chain tracks a path (simplePath/path/cyclicPath), previously failed CLOSED with a
  // carried-column mismatch: pushChildScope appended the child ordinal physically LAST — after
  // the path columns — desyncing the seed's declared schema (ordinal in its origins slot) from
  // its physical layout, so any child lowered via lowerSteps (assertStreamColumns) threw. The
  // ordinal now lands in its layoutCols position, so these compile and run. Continuation arms
  // (branch/local) still EXTEND the path — the reorder keeps path, it does not strip it.
  test('where(__.out()…) existence child under simplePath', () => {
    // Only josh (id 4) has an out-neighbour named lop; the where child moves under path.
    expect(run(seededStore(), 'g.V().out().simplePath().where(__.out().has("name","lop"))').map((r) => r.id))
      .toEqual([4]);
  });
  test('project().by(__.out().count()) under simplePath', () => {
    expect(run(seededStore(), 'g.V(1).out().simplePath().project("name","oc").by("name").by(__.out().count())'))
      .toEqual([
        { e0_v: 'vadas', e0_vtype: 'string', e1_v: 0 },
        { e0_v: 'josh', e0_vtype: 'string', e1_v: 2 },
        { e0_v: 'lop', e0_vtype: 'string', e1_v: 0 },
      ]);
  });
  test('group().by(T.label).by(__.out().values().fold()) under simplePath', () => {
    expect(run(seededStore(), 'g.V().out().simplePath().group().by(T.label).by(__.out().values("name").fold())'))
      .toEqual([{ gk: 'person', gv: '["lop","ripple"]' }, { gk: 'software', gv: '[]' }]);
  });
  test('project().by(__.out().values().fold()) under simplePath (scoped fold carries the domain path, not the child-extended one)', () => {
    // Guards the scoped-barrier carry: the child fold reduces per origin and must carry the
    // parent domain's path (p0,p1), NOT the child body's out()-extended path (p2).
    expect(run(seededStore(), 'g.V(1).out().simplePath().project("outs").by(__.out().values("name").fold())'))
      .toEqual([{ e0_list: '[]' }, { e0_list: '["lop","ripple"]' }, { e0_list: '[]' }]);
  });
  test('path().by(__.out().count()) — by(traversal) position child under path', () => {
    expect(run(seededStore(), 'g.V(1).out().simplePath().path().by(__.out().count())'))
      .toEqual([{ x0_v: 3, x1_v: 0 }, { x0_v: 3, x1_v: 2 }, { x0_v: 3, x1_v: 0 }]);
  });
  test('branch/local arms still extend the outer path (reorder keeps path, not strips)', () => {
    for (const q of [
      'g.V(1).union(__.out(), __.in()).path()',
      'g.V(1).optional(__.out()).path()',
      'g.V(1).coalesce(__.out(), __.in()).path()',
      'g.V(1).local(__.out().limit(1)).path()',
    ]) expect(() => compile(q, {})).not.toThrow();
  });
});
test('has(label, key, value) 3-arg folds in a label filter', () => {
  const store = seededStore();
  // the standard cucumber verification idiom
  expect(run(store, 'g.V().has("person","name","marko").has("age",29).count()').map((r) => r.v)).toEqual([1]);
  // wrong label → no match, even though a software vertex is named "lop"
  expect(run(store, 'g.V().has("person","name","lop").count()').map((r) => r.v)).toEqual([0]);
  expect(run(store, 'g.V().has("software","name","lop").count()').map((r) => r.v)).toEqual([1]);
});

test('has(T.label, v) / has(T.id, v) token forms filter on label / id', () => {
  const store = seededStore();
  expect(run(store, 'g.V().has(T.label,"person").count()').map((r) => r.v)).toEqual([4]);
  expect(run(store, 'g.V().has(T.id, 1).values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('has(T.id|T.label, P) routes through a predicate (no crash on P/TextP)', () => {
  const store = seededStore();
  expect(run(store, 'g.V().has(T.id, P.within(1,2)).values("name")').map((r) => r.v).sort()).toEqual(['marko', 'vadas']);
  expect(run(store, 'g.V().has(T.label, P.eq("software")).count()').map((r) => r.v)).toEqual([2]);
});

test('sack(assign).by(key) assigns per-traverser; by-miss drops the traverser', () => {
  const store = seededStore();
  // 4 persons have age; software (lop, ripple) have none → dropped by the by() miss.
  expect(run(store, 'g.V().sack(assign).by("age").sack()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([27, 29, 32, 35]);
});

test('sack(assign).by(T.label) over edges, carried through inV()', () => {
  const store = seededStore();
  expect(run(store, 'g.withSack("hello").V().outE().sack(Operator.assign).by(T.label).inV().sack()').map((r) => r.v).sort())
    .toEqual(['created', 'created', 'created', 'created', 'knows', 'knows']);
});

test('withSack(0.0d) + sack(sum).by(weight) accumulates per edge; sum() folds', () => {
  const store = seededStore();
  // each edge contributes its weight to a fresh (0 + weight) sack; sum over all = 3.5.
  expect(run(store, 'g.withSack(0.0d).V().outE().sack(Operator.sum).by("weight").inV().sack().sum()').map((r) => r.v))
    .toEqual([3.5]);
});

test('withSack(2) + sack(div).by(__.constant(4.0)) → real division per vertex', () => {
  const store = seededStore();
  expect(run(store, 'g.withSack(2).V().sack(Operator.div).by(__.constant(4.0d)).sack()').map((r) => r.v))
    .toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

test('local(__.sack(sum).by(age)) folds the sack per-traverser inside a child scope (Local.feature:224)', () => {
  // V().in() → the incoming-neighbour multiset; barrier() is a no-op on the SQL engine; the
  // local() runs sack(sum).by('age') per traverser (seed 0 + own age) and sack() reads it.
  // A mutate sack(op) is an element-preserving child step, folded through the same engine.
  const store = seededStore();
  expect(run(store, 'g.withSack(0L).V().in().barrier().local(__.sack(sum).by("age")).sack()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([29, 29, 29, 32, 32, 35]);
});

test('aggregate(x).by(key).cap(x) is one list; explicit unfold emits scalar members', () => {
  const store = seededStore();
  expect(executeQuery(store, 'g.V().aggregate("x").by("name").cap("x")', {})).toHaveLength(1);
  expect(run(store, 'g.V().aggregate("x").by("name").cap("x").unfold()').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  // by-miss (software has no age) drops the member → 4 ages, not 6 with nulls.
  expect(run(store, 'g.V().aggregate("x").by("age").cap("x").unfold()').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([27, 29, 32, 35]);
});

test('bare aggregate(x).cap(x) is one list; explicit unfold emits vertices', () => {
  const store = seededStore();
  expect(executeQuery(store, 'g.V().aggregate("x").cap("x")', {})).toHaveLength(1);
  expect(run(store, 'g.V().aggregate("x").cap("x").unfold()').map((r) => r.id).sort((a, b) => a - b))
    .toEqual([1, 2, 3, 4, 5, 6]);
});

test('aggregate is a pass-through barrier (traversal continues past it)', () => {
  const store = seededStore();
  // aggregate mid-chain does not disturb the stream: out() still flows on.
  expect(run(store, 'g.V(1).aggregate("x").out().values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
});

test('cap of an undefined side-effect key throws', () => {
  expect(() => compile('g.V().cap("nope")', {})).toThrow("cap('nope') references an undefined side-effect");
});

test('local(scalar reduction) is a per-input scalar (zeros preserved; count is Long)', () => {
  const store = seededStore();
  // out-degree per vertex, incl 0 for the software/leaf vertices.
  expect(run(store, 'g.V().local(__.outE().count())').map((r) => r.v).sort((a, b) => a - b))
    .toEqual([0, 0, 0, 1, 2, 3]);
  expect(read('g.V().local(__.outE().count())').shape).toEqual({ kind: 'value', type: STATIC('long') });
});

test('local(edgeStep.limit(N)) scopes the limit PER input (window), not globally', () => {
  const store = seededStore();
  // marko has 2 knows edges; local limit(1) keeps 1 (per-vertex), then inV → 1 name.
  expect(run(store, 'g.V(1).local(__.outE("knows").limit(1)).inV().values("name")').length).toBe(1);
  // per-input: each of vadas/josh has 1 in-knows → outV = marko, twice (global limit(2) would give 2 total anyway; the point is per-input scoping)
  expect(run(store, 'g.V().local(__.inE("knows").limit(2)).outV().values("name")').map((r) => r.v))
    .toEqual(['marko', 'marko']);
});

test('child-scoped local preserves outer aliases and path columns', () => {
  const store = seededStore();
  const selected = run(store, 'g.V(1).as("a").local(__.out().limit(1)).select("a")');
  expect(selected.map((r) => r.id)).toEqual([1]);

  const path = run(store, 'g.V(1).local(__.out().limit(1)).path()');
  expect(path).toHaveLength(1);
  expect([path[0].x0_id, path[0].x1_id]).toEqual([1, 2]);
});
test('otherV() after local(bothE.limit) picks the end away from the input vertex', () => {
  const store = seededStore();
  // josh(4): bothE = marko-knows->josh, josh-created->ripple, josh-created->lop.
  // limit(2) per input → first 2 by edge id; otherV skips josh.
  const two = run(store, 'g.V(4).local(__.bothE().limit(2)).otherV().values("name")').map((r) => r.v);
  expect(two.length).toBe(2);
  for (const name of two) expect(['marko', 'ripple', 'lop']).toContain(name);
  // otherV outside local still needs an edge context.
  expect(() => compile('g.V().otherV()', {})).toThrow('otherV() expects an edge');
});

test('local() with a non-movement / no-barrier body defers clearly', () => {
  expect(() => compile('g.V().local(__.out().in().simplePath()).path()', {})).toThrow('not yet supported');
  expect(run(seededStore(), 'g.V(1).local(__.out()).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'vadas']);
  // Nested local() re-enters the same child compiler and restores each inner
  // child scope before the outer local emits its rows.
  expect(run(seededStore(), 'g.V(1).local(__.out().local(__.out().order().by("name").limit(1))).values("name")').map((r) => r.v))
    .toEqual(['lop']);
});

test('dedup() after order() in a child still collapses duplicates', () => {
  const store = seededStore();
  // out().in() from marko revisits marko 3× (via lop/josh/vadas co-authors). order() before
  // dedup() must not defeat the collapse — the minted encounter is per-row unique, so a
  // naive SELECT DISTINCT that carried it would never dedup.
  // No order() in this one, so the collapse is all that is asserted — multiset. Its ordered twin
  // below IS order-asserting, and holds: dedup keeps the first occurrence.
  expect(bagOf(run(store, 'g.V(1).local(__.out().in().dedup()).values("name")').map((r) => r.v)))
    .toEqual(['josh', 'marko', 'peter']);
  expect(run(store, 'g.V(1).local(__.out().in().order().by("name").dedup()).values("name")').map((r) => r.v))
    .toEqual(['josh', 'marko', 'peter']);
  expect(run(store, 'g.V(1).local(__.out().in().order().by("name").dedup()).count()').map((r) => r.v))
    .toEqual([3]);
});

test('sack with two by() modulators throws TinkerPop message', () => {
  expect(() => compile('g.V().sack(assign).by("age").by("name").sack()', {}))
    .toThrow('Sack step can only have one by modulator');
});

test('bare sack() with no withSack()/sack(op) throws', () => {
  expect(() => compile('g.V().sack()', {})).toThrow('sack() requires withSack()');
});

test('order().by numeric ascending vs descending', () => {
  const store = seededStore();
  expect(run(store, 'g.V().hasLabel("person").order().by("age").values("name")').map((r) => r.v))
    .toEqual(['vadas', 'marko', 'josh', 'peter']); // 27,29,32,35
  expect(run(store, 'g.V().hasLabel("person").order().by("age",desc).values("name")').map((r) => r.v))
    .toEqual(['peter', 'josh', 'marko', 'vadas']);
});

test('order().by string is lexicographic', () => {
  const store = seededStore();
  expect(run(store, 'g.V().values("name").order()').map((r) => r.v))
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
});

test('range is 0-based, low-inclusive high-exclusive', () => {
  const store = seededStore();
  expect(run(store, 'g.V().order().by("name").range(1,3).values("name")').map((r) => r.v))
    .toEqual(['lop', 'marko']);
});

test('traversers are a multiset — both() preserves duplicates', () => {
  // marko(1) knows vadas+josh and created lop; both() from lop reaches its 3 creators.
  const store = seededStore();
  const names = run(store, 'g.V(3).both("created").values("name")').map((r) => r.v).sort();
  expect(names).toEqual(['josh', 'marko', 'peter']); // lop created by all three
});

test('both() on a self-loop yields the vertex twice', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const self = store.labelId('self');
  rawVertex(store, 1, 'person');
  store.query('INSERT INTO vertex_properties(node,key,value) VALUES(?,?,?)', [1, 'name', 'ouro']);
  store.query('INSERT INTO edges(id,src,label,tgt) VALUES(?,?,?,?)', [2, 1, self, 1]);
  expect(run(store, 'g.V(1).both().count()').map((r) => r.v)).toEqual([2]);
});

test('has() on a missing property filters the traverser out', () => {
  const store = seededStore();
  // software vertices (lop, ripple) have no age -> excluded
  const names = run(store, 'g.V().has("age", 27).values("name")').map((r) => r.v);
  expect(names).toEqual(['vadas']);
  const some = run(store, 'g.V().values("lang")').map((r) => r.v).sort();
  expect(some).toEqual(['java', 'java']); // only software has lang; no nulls
});

test('is(P) filters a scalar stream; TextP is LIKE', () => {
  const store = seededStore();
  expect(run(store, 'g.V().values("age").is(P.gt(30))').map((r) => r.v).sort()).toEqual([32, 35]);
  expect(run(store, 'g.V().hasLabel("person").count().is(P.gt(3))').map((r) => r.v)).toEqual([4]);
  expect(run(store, 'g.V().has("name", TextP.startingWith("jo")).values("name")').map((r) => r.v)).toEqual(['josh']);
  expect(run(store, 'g.V().values("name").is(TextP.containing("ar"))').map((r) => r.v)).toEqual(['marko']);
});

test('where/not/filter filter the traverser (EXISTS/NULL semantics)', () => {
  const store = seededStore();
  // only marko knows anyone
  expect(run(store, 'g.V().where(__.out("knows")).values("name")').map((r) => r.v)).toEqual(['marko']);
  // creators
  expect(run(store, 'g.V().where(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // not(created): software has no age either — NULL is kept (not(traversal) = no output)
  expect(run(store, 'g.V().not(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
  // people known by someone
  expect(run(store, 'g.V().hasLabel("person").where(__.inE("knows").count().is(P.gte(1))).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'vadas']);
  expect(run(store, 'g.V().filter(__.out("created")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // Child order and slicing are scoped to each parent before EXISTS is tested.
  expect(run(store, 'g.V().where(__.out().hasLabel("person").order().by("name").range(1,2)).values("name")').map((r) => r.v))
    .toEqual(['marko']);
  expect(run(store, 'g.V().not(__.out().hasLabel("person").order().by("name").limit(1)).values("name")').map((r) => r.v).sort())
    .toEqual(['josh', 'lop', 'peter', 'ripple', 'vadas']);
});

test('multi-hop where executes: correlated EXISTS over the path', () => {
  const store = seededStore();
  // has an out-neighbour created ripple → only josh (josh created ripple)
  expect(run(store, 'g.V().where(__.out().has("name","ripple")).values("name")').map((r) => r.v)).toEqual(['josh']);
  // has a 2-hop out path → only marko (marko→josh→ripple/lop)
  expect(run(store, 'g.V().where(__.out().out()).values("name")').map((r) => r.v)).toEqual(['marko']);
  // created something that is a software vertex → marko, josh, peter
  expect(run(store, 'g.V().where(__.out("created").hasLabel("software")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter']);
  // terminal values().is on the neighbour: known-by a person over 30 → nobody (marko is 29)
  expect(run(store, 'g.V().where(__.in("knows").values("age").is(P.gt(30)))').map((r) => r.v)).toEqual([]);
  // where(__.label().is(P)) — current-label predicate
  expect(run(store, 'g.V().where(__.label().is("person")).values("name")').map((r) => r.v).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  // where(__.not(t)) — negated inner predicate (non-creators)
  expect(run(store, 'g.V().where(__.not(__.out("created"))).values("name")').map((r) => r.v).sort()).toEqual(['lop', 'ripple', 'vadas']);
});

// ---------- the shared row ops (item 17) ----------
//
// limit/skip/range/dedup are ONE implementation (`reprojectRows`, tail/barrier.ts) registered into
// each shape's dispatch table, so these assert the SHAPES rather than the ops: before this the
// (shape x row-op) matrix measured 17/50 gaps over these five ops and ten producers, and it is now
// 4/50 — the four survivors being `group`, which declines by design (see the last case).
test('the shared row ops slice every shape whose rows are its traversers', () => {
  const store = seededStore();
  const n = (g: string) => run(store, g).length;

  // A LIST stream is one list VALUE per row, so a row slice selects whole lists. Six vertices →
  // six lists; dedup collapses the three EMPTY ones (lop/vadas/ripple have no out) into one.
  expect(n('g.V().local(__.out().fold())')).toBe(6);
  expect(n('g.V().local(__.out().fold()).limit(2)')).toBe(2);
  expect(n('g.V().local(__.out().fold()).skip(4)')).toBe(2);
  expect(n('g.V().local(__.out().fold()).range(1,3)')).toBe(2);
  expect(n('g.V().local(__.out().fold()).dedup()')).toBe(4);

  // A Map.Entry stream is one row per entry — the shape item 17 measured at 0/10.
  expect(n('g.V().valueMap().unfold()')).toBe(12);
  expect(n('g.V().valueMap().unfold().limit(3)')).toBe(3);
  expect(run(store, 'g.V().valueMap().unfold().count()').map((r) => r.v)).toEqual([12]);

  // A PROPERTY stream is one row per Property/VertexProperty instance. Its `dedup` is NOT the
  // shared one (it collapses on the property payload, not the whole row), so only the slices moved.
  expect(n('g.V().properties()')).toBe(12);
  expect(n('g.V().properties().limit(4)')).toBe(4);
  expect(n('g.V().properties().range(2,5)')).toBe(3);

  // A RECORD row is one traverser; only `dedup` came from the shared set, because `recordSlice`
  // also serves Scope.local (a FIELD slice), which the shared ops decline.
  expect(n("g.V().project('a').by('name')")).toBe(6);
  expect(n("g.V().project('a').by('name').dedup()")).toBe(6);

  // A LINEAR path is row-per-traverser, so it slices; the GROUPED (recursive) regime is one row per
  // POSITION and is what `cardinalityOf` exists to keep out of here.
  expect(n('g.V().out().path().limit(2)')).toBe(2);
});

test('a shared row op fails closed rather than answering a different question', () => {
  const store = seededStore();
  // wholeResult: a group() barrier is ONE map traverser, so slicing its ROWS is not the ask.
  expect(() => run(store, "g.V().group().by('name').limit(2)")).toThrow('on a group value not yet supported');
  // Carried label state makes a bare DISTINCT over the row the wrong collapse key.
  expect(() => run(store, "g.V().as('x').local(__.out().fold()).dedup()"))
    .toThrow('carried path/label state');
  // A by()-scoped dedup is a different collapse key entirely.
  expect(() => run(store, "g.V().local(__.out().fold()).dedup().by('x')")).toThrow('dedup().by()');
  // Scope.local addresses MEMBERS, not rows, so the shared op declines and the list arm's OWN
  // member-slice builder answers — six lists in, six lists out, each truncated to two members.
  //
  // This is the case that caught the shadowing bug, and it is asserted here rather than with the
  // gains above because it is a NON-regression, not a new capability: `LIST_DISPATCH` already owned
  // these four names, and a `new Map` keeps the LAST entry for a duplicate key, so spreading the
  // shared ops after them REPLACED the local builder. A declining handler then fell to the fallback
  // throw instead of to the owner it meant to defer to — `dispatchShapeTail` consults exactly one
  // handler per name, so declining never "falls through" to a previous registration. It cost 42
  // corpus traversals and only the census saw it; the global-form probe that measured the gains was
  // blind to it by construction. `firstOf` composes them instead.
  expect(run(store, 'g.V().local(__.out().fold()).range(Scope.local,0,2)')).toHaveLength(6);
  expect(run(store, 'g.V().local(__.out().fold()).limit(Scope.local,1)')).toHaveLength(6);
});

test('sum() sums a value stream; fold() collects it', () => {
  const store = seededStore();
  expect(run(store, 'g.V().hasLabel("person").values("age").sum()').map((r) => r.v)).toEqual([123]);
  expect(JSON.parse(run(store, 'g.V().values("name").fold()')[0].list).sort())
    .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
});

});
