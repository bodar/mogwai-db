// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { PER_ROW, STATIC, UNKNOWN } from '../../src/sql/kernel/render.ts';
import { compile, type CompileOptions } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery, executeFramed } from '../support/executor.ts';
import { ioc } from '../../src/io.ts';
import { Query } from '../../src/sql/kernel/q.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { assertStreamColumns, toGroupStream, toPathStream, toPropertyStream, toRecordStream, toScalarStream, toVariantStream } from '../../src/compiler/steps/context/stream.ts';
import { popChildScope, pushChildScope, reuseCurrentFrame } from '../../src/compiler/steps/tail/child.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { readdirSync, readFileSync } from 'node:fs';

const read = (q: string, options?: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind !== 'read') throw new Error('expected read plan');
  return p;
};

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)
function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) executeQuery(store, q, {}); // seed by running the write traversals
  return store;
}

const run = (store: GraphStore, q: string) => {
  const p = compile(q, {});
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

const runWith = (store: GraphStore, q: string, options: CompileOptions) => {
  const p = compile(q, {}, options);
  if (p.kind === 'write') return p.run(store);
  return store.query(p.sql, p.binds);
};

describe('branch SQL (and/or/union/optional/choose/coalesce/map/flatMap)', () => {
  test('union() as a source lowers each ROOTED branch and routes it to the shared merges', () => {
    const p = read("g.union(__.V(2),__.V(4)).values('name')");
    expect(p.sql).toContain('UNION ALL');
    expect(p.sql).toContain('vp.value END AS v');
    // branches sharing the one WITH clause
    expect(read("g.union(__.V().hasLabel('software'),__.V().hasLabel('person')).count()").shape).toEqual({ kind: 'value', type: STATIC('long') });
    // mid-chain union() still works (the element StepFn — same merge, a parent to fork from)
    expect(read("g.V().union(__.out(),__.in()).values('name')").sql).toContain('UNION ALL');
    // Each branch is a fully ROOTED traversal lowered to its natural shape, so the merge is
    // picked from the arms' KINDS — every shape the mid-traversal union reaches, a source
    // union now reaches too.
    expect(read("g.union(__.V().values('name'))").shape.kind).toBe('value');              // scalar merge
    expect(read('g.union(__.inject(1),__.inject(2))').shape.kind).toBe('value');          // non-V/E-rooted arms
    expect(read("g.union(__.V().values('name').fold(),__.V().values('age').fold())").shape.kind).toBe('jsonbList');
    expect(read("g.union(__.V().values('name'),__.V().hasLabel('person'))").shape.kind).toBe('variant'); // mixed
    expect(read('g.union()').shape.kind).toBe('vertex');                                  // no branches → empty
    // as() inside a branch resolves through the merge's alias union; a positional consumer
    // downstream of the fan-out mints the arm-merge encounter (arm 0 fully before arm 1).
    expect(read("g.union(__.V().as('a').out(),__.V()).select('a').values('name')").shape.kind).toBe('value');
    expect(read('g.union(__.V(),__.V()).limit(3)').sql).toContain('ROW_NUMBER() OVER (ORDER BY m.arm_idx, m.encounter)');
    // An arm whose shape no merge in the family covers fails closed, naming that shape.
    expect(() => compile("g.union(__.V().group().by('name'),__.V())", {})).toThrow('union() source branch producing a group value');
  });

  test('and()/or() combine branch predicates; nested where(__.and)', () => {
    const a = read('g.V().and(__.out("knows"), __.out("created"))');
    expect(a.sql).toContain('WHERE ((EXISTS(SELECT 1 FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    expect(a.sql).toContain(') AND (EXISTS(');
    expect(read('g.V().or(__.out("knows"), __.in("created"))').sql).toContain(') OR (EXISTS(');
    // A SINGLE arm is legal Gremlin — `and(t)`/`or(t)` is just "t must produce" — and the generic
    // child-existence combiner always lowered it. The inline path used to THROW here, which made it
    // NARROWER than the path it accelerates (V().or(__.out()) ran with predicateInlining off and
    // failed with it on). Both paths now accept one arm; ZERO arms still throws.
    expect(read('g.V().and(__.out("knows"))').sql).toContain('EXISTS(');
    expect(read('g.V().or(__.out("knows"))').sql).toContain('EXISTS(');
  });

  test('infix .and()/.or() connectors split a predicate body (where/choose/until)', () => {
    // where(has().and().has()) → ((p0) AND (p1))
    const a = read('g.V().where(__.has("name","x").and().has("age",P.gt(1)))');
    expect(a.sql).toContain(' AND ');
    expect(a.binds).toEqual(['name', 'x', 'age', 1]);
    // or() → ((p0) OR (p1)); OR binds looser so mixed a.and().b.or().c groups as ((a AND b) OR c)
    expect(read('g.V().where(__.has("name","x").or().has("age",P.gt(1)))').sql).toContain(') OR (');
    const mixed = read('g.V().where(__.hasLabel("person").and().out("created").or().hasLabel("software"))');
    expect(mixed.sql).toMatch(/\(\(.*AND.*\).*OR.*\)/s);
    // choose() infix predicate now routes through the same split (movement conjunct →
    // correlated EXISTS), then the arms fold — D2 support-definer removed.
    const c = read('g.V().choose(__.hasLabel("person").and().out("created"), __.out("knows"), __.identity())');
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    // malformed (leading/trailing/empty operand) → clear throw
    expect(() => compile('g.V().where(__.and().has("name","x"))', {})).toThrow('empty operand');
  });

  test('union() → UNION ALL of branch id-relations, multi-hop bodies fold', () => {
    const u = read('g.V(1).union(__.out("knows"), __.out("created")).values("name")');
    expect(u.sql).toContain('UNION ALL');
    expect(u.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(u.sql).toContain('SELECT e.tgt AS id, p.bulk, p.o0 FROM edges e JOIN');
    // multi-hop branch now folds through the dispatch (was single-hop only)
    expect(read('g.V().union(__.out().out(), __.in()).values("name")').sql)
      .toContain('SELECT e.tgt AS id, p.bulk, p.o0 FROM edges e JOIN c2 p ON e.src=p.id');
    // Homogeneous scalar arms lower at the shape-aware dispatcher and re-enter the
    // scalar pipeline; this is not the element-only PREFIX union.
    const scalar = read('g.V(1).union(__.values("name"), __.constant("x")).count()');
    expect(scalar.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(scalar.sql).toContain(' AS v FROM');
    expect(scalar.sql).toContain('UNION ALL');
    // A SINGLE branch is legal Gremlin — union() is varargs and `union(t)` is just t, so the arm merge
    // is a UNION ALL of one. Rejecting it broke the metamorphic law `union(q) === q` (laws.ts), which
    // is how the guard was found. ZERO branches still throws.
    expect(read('g.V().union(__.out())').sql).toContain('FROM');
    // as() before union now threads the alias column through the merge (carried-schema, Move B)
    const ua = read('g.V().as("a").union(__.out(), __.in()).select("a")');
    expect(ua.sql).toContain('UNION ALL');
    expect(ua.sql).toContain('SELECT id, a0, bulk FROM'); // the a0 alias column survives the branch merge
    // a NEW as() bound INSIDE one arm now forks/merges: the label unions into the merged
    // set and the arm that never bound it pads an empty (NULL) history.
    const divU = read('g.V().union(__.as("b").out(), __.in()).select("b")');
    expect(divU.sql).toContain('SELECT id, a0, bulk FROM'); // the binding arm carries its history
    expect(divU.sql).toContain('SELECT id, NULL AS a0, bulk FROM'); // the other arm pads it
    // sack CLONES through a fork (TinkerPop split-only): the incoming sk column rides into
    // every arm via carryFrag, passes through unchanged, and armProjection/rigidCols project
    // it through the merge — so a following sack() reads the pre-fork accumulator per arm.
    const sackU = read('g.withSack(0.0d).V().sack(sum).by("age").union(__.out(), __.in()).sack()');
    expect(sackU.sql).toContain('sk'); // the sack column survives the branch merge
    expect(sackU.sql).toContain('UNION ALL');
    // mixed scalar+element arms now merge as a dynamic-tag VariantStream (P4)
    const mixedU = read('g.V().union(__.values("name"), __.out())');
    expect(mixedU.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(mixedU.sql).toContain('1 AS vk'); // scalar arm
    expect(mixedU.sql).toContain('2 AS vk'); // node arm
    // mixed element kinds across branches (both element-class) stays the legacy defer
    expect(() => compile('g.V().union(__.out(), __.outE())', {})).toThrow('different element kinds');
  });

  test('optional() → single-hop LEFT JOIN fast path; multi-hop via ordinal', () => {
    const o = read('g.V().optional(__.out("created")).values("name")');
    expect(o.sql).toContain('SELECT COALESCE(e.tgt, p.id) AS id, p.bulk FROM c0 p LEFT JOIN edges e ON e.src=p.id');
    // both()/multi-hop now compile via the coalesce(t, identity) ordinal shape
    const b = read('g.V().optional(__.both()).count()');
    expect(b.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(b.sql).toContain('WHERE o0 NOT IN (SELECT o0 FROM'); // self-on-miss
    expect(read('g.V().optional(__.out().out()).count()').sql).toContain('ROW_NUMBER() OVER () AS o0');
    // a body that flips element kind would make self-on-miss mixed-shape → defer
    expect(() => compile('g.V().optional(__.outE())', {})).toThrow('changing element kind');
    // as() before optional threads the alias through the fast path (carryFrag from the input)
    expect(read('g.V().as("a").optional(__.out()).select("a")').sql)
      .toContain('SELECT COALESCE(e.tgt, p.id) AS id, p.a0, p.bulk FROM');
    // NESTED optional/coalesce: each mints a UNIQUE ordinal (o0 outer, o1 inner) and
    // carries the outer through — so they compose (unlocks optional(out().optional(out())).path()).
    expect(read('g.V().optional(__.out().optional(__.out())).path()').sql).toContain('AS o1');
    expect(read('g.V(1).coalesce(__.coalesce(__.out(), __.in()), __.both())').sql).toContain('AS o1');
  });

  test('optional total scalar/list children retype without a phantom identity arm', () => {
    const store = seededStore();
    expect(run(store, 'g.V().optional(__.out().count())').map((r) => Number(r.v)).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
    expect(run(store, 'g.V().optional(__.out().values("name").fold()).count(Scope.local)').map((r) => Number(r.v)).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 2, 3]);
  });

  test('optional non-total scalar child lowers to a scalar-or-element VariantStream', () => {
    const store = seededStore();
    const plan = read('g.V().optional(__.values("age"))');
    expect(plan.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    const rows = run(store, 'g.V().optional(__.values("age"))');
    expect(rows.filter((r) => r.vk === 1).map((r) => r.v).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    expect(rows.filter((r) => r.vk === 2).map((r) => r.label)).toEqual(['software', 'software']);
    expect(executeQuery(store, 'g.V().optional(__.values("age"))', {})).toHaveLength(6);
    expect(run(store, 'g.V().optional(__.values("age")).count()').map((r) => r.v)).toEqual([6]);
  });

  test('mixed-shape branch arms merge as a dynamic-tag VariantStream (P4)', () => {
    const store = seededStore();
    // union: scalar arm (name) + element arm (out) — vk 1 vs 2, framing yields all rows
    const uRows = run(store, 'g.V(1).union(__.values("name"), __.out())');
    expect(uRows.filter((r) => r.vk === 1).map((r) => r.v)).toEqual(['marko']);
    expect(uRows.filter((r) => r.vk === 2).length).toBe(3); // marko created lop, knows vadas+josh
    expect(executeQuery(store, 'g.V(1).union(__.values("name"), __.out())', {})).toHaveLength(4);
    // union with an EDGE arm exercises vk=3 + the src/tgt columns
    expect(executeQuery(store, 'g.V(1).union(__.outE(), __.values("age"))', {})).toHaveLength(4);
    // coalesce: element arm wins per input, scalar fallback where empty; gated by ordinal
    const cRows = run(store, 'g.V().coalesce(__.out(), __.values("name"))');
    expect(cRows.some((r) => r.vk === 1)).toBe(true);  // leaves fall back to name
    expect(cRows.some((r) => r.vk === 2)).toBe(true);  // marko/josh have out()
    expect(() => executeQuery(store, 'g.V().coalesce(__.out(), __.values("name"))', {})).not.toThrow();
    // choose: predicate splits, then=element / else=scalar
    expect(() => executeQuery(store, 'g.V().choose(__.out(), __.label(), __.values("name"))', {})).not.toThrow();
  });

  test('as() inside a SCALAR arm survives the merge and reads back', () => {
    const store = seededStore();
    const M = "g.V().has('name','marko').values('age')";
    // A label bound INSIDE one arm used to be dropped at the merge: unionScalarStreams projected
    // the OUTER carried, so the arm-grown alias column never reached the merged relation's
    // declared schema and select() read nothing back — [] EVEN WHEN EVERY ARM BOUND IT. The merge
    // now unions the arms' label sets (mergeAliasMaps) and each arm projects the canonical alias
    // columns (its own physical column remapped, NULL where it never bound the label).
    expect(run(store, `${M}.union(__.constant('x').as('a'), __.constant('y')).select('a')`).map((r) => r.v))
      .toEqual(['x']); // arm 1 never bound 'a' → its row drops (aliasPresent), matching element arms
    expect(run(store, `${M}.union(__.constant('x').as('a'), __.constant('y').as('a')).select('a')`).map((r) => r.v))
      .toEqual(['x', 'y']); // both arms bind → both survive
    // the un-selected merge is unaffected (both arms' values still flow)
    expect(run(store, `${M}.union(__.constant('x').as('a'), __.constant('y'))`).map((r) => r.v))
      .toEqual(['x', 'y']);
    // and the ELEMENT-arm reference semantics are unchanged (the behaviour this now matches)
    expect(run(store, "g.V().has('name','marko').union(__.out().as('a'), __.in()).select('a')").length).toBe(3);
  });

  test('SCALAR-parent mixed-shape merges re-mint the arm-ordered encounter', () => {
    // These four merges (tryScalarVariant{Union,Choose,Coalesce,Optional}) used to hand-roll
    // their UNION ALL, replicating mergeVariantArms' NO-encounter branch — so with a LIVE
    // encounter (a positional consumer downstream of a fan-out) the arm ordering was silently
    // dropped and the slice picked rows in incidental SQLite order. Routing them through the
    // shared builder mints `ROW_NUMBER() OVER (… ORDER BY arm_idx, arm_encounter)`, i.e. arm 0
    // fully before arm 1 — TinkerPop's union/coalesce/choose emission order.
    //
    // Asserted at the SQL level deliberately: a RESULT-level scenario cannot distinguish the two
    // (with these arm shapes incidental row order coincides with arm order), so only the emitted
    // window function proves the ordering is specified rather than accidental.
    const mixedUnion = read('g.V().values("age").union(__.constant("x"), __.V()).limit(2)');
    expect(mixedUnion.sql).toContain('arm_idx');
    expect(mixedUnion.sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY [\w.]*arm_idx, [\w.]*arm_encounter\)/);
    const mixedCoalesce = read('g.V().values("name").coalesce(__.V(), __.constant("z")).limit(1)');
    expect(mixedCoalesce.sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY [\w.]*arm_idx, [\w.]*arm_encounter\)/);
    // …and NOT minted when no consumer demands emission order (the hot path is untouched:
    // no window, no arm tags).
    expect(read('g.V().values("age").union(__.constant("x"), __.V())').sql).not.toContain('arm_idx');
  });

  test('variant tail: shape-agnostic row-ops (limit/skip/range/dedup) + fail-closed', () => {
    const store = seededStore();
    const base = 'g.V(1).union(__.values("name"), __.out())';
    const full = run(store, base).length; // 4: name 'marko' + 3 out neighbours
    expect(full).toBe(4);
    // limit/skip/range re-project the variant relation, slicing rows without touching
    // the per-row tag — the whole union (all arms) rides through the LIMIT/OFFSET.
    const lim = read(`${base}.limit(2)`);
    expect(lim.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(lim.sql).toContain('SELECT p.vk, p.v, p.rid, p.bulk, p.encounter FROM'); // full column re-projection (encounter seeded: union fan-out + limit)
    expect(lim.sql).toContain('LIMIT 2');
    expect(run(store, `${base}.limit(2)`).length).toBe(2);
    expect(read(`${base}.skip(1)`).sql).toContain('LIMIT -1 OFFSET 1');
    expect(run(store, `${base}.skip(1)`).length).toBe(full - 1);
    expect(read(`${base}.range(1,3)`).sql).toContain('LIMIT 2 OFFSET 1');
    expect(run(store, `${base}.range(1,3)`).length).toBe(2);
    // count barrier over the union still collapses to one Long
    expect(run(store, `${base}.count()`).map((r: any) => Number(r.v))).toEqual([full]);
    // dedup collapses the multiset on the tagged (vk,v,rid) row
    expect(read(`${base}.dedup()`).sql).toContain('SELECT DISTINCT p.vk, p.v, p.rid, p.bulk FROM');
    expect(run(store, 'g.V(1).union(__.out(), __.out()).dedup()').length)
      .toBeLessThan(run(store, 'g.V(1).union(__.out(), __.out())').length);
    // fail closed: steps that must look inside a heterogeneous row cannot apply
    expect(() => compile(`${base}.out()`, {})).toThrow('out() on a variant value not yet supported');
    expect(() => compile(`${base}.order()`, {})).toThrow('order() on a variant value not yet supported');
    // dedup with carried label state defers rather than over-collapsing
    expect(() => compile(`g.V().as("a").union(__.values("name"), __.out()).dedup()`, {}))
      .toThrow('dedup() over a variant with carried path/label state not yet supported');
  });

  test('coalesce() → first non-empty branch per input via the ordinal', () => {
    const c = read('g.V(1).coalesce(__.out("knows"), __.out("created")).values("name")');
    expect(c.sql).toContain('ROW_NUMBER() OVER () AS o0');
    // branch 2 emits only for inputs branch 1 produced nothing for
    expect(c.sql).toContain('WHERE o0 NOT IN (SELECT o0 FROM');
    expect(c.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    const scalar = read('g.V().coalesce(__.values("age"), __.constant(0)).count()');
    expect(scalar.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(scalar.sql).toContain('a.o0 NOT IN (SELECT o0 FROM');
    expect(read('g.V().coalesce(__.values("missing").fold(), __.values("name").fold()).unfold().count()').shape)
      .toEqual({ kind: 'value', type: STATIC('long') });
    // mixed element+scalar arms now merge as a dynamic-tag VariantStream (P4), gated
    // per input ordinal like the homogeneous coalesce.
    const mixedC = read('g.V().coalesce(__.out(), __.values("name"))');
    expect(mixedC.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(mixedC.sql).toContain('o0 NOT IN (SELECT o0 FROM'); // second arm gated
    expect(() => compile('g.V().coalesce(__.out(), __.outE())', {})).toThrow('different element kinds');
    // dedup now preserves both the branch ordinal and its inner child ordinal.
    const dedup = read('g.V().coalesce(__.out().dedup(), __.in())');
    expect(dedup.sql).toContain('SELECT DISTINCT p.id AS id, p.bulk, p.o0, p.o1');
    // union() inside coalesce threads the ordinal through → valid
    expect(read('g.V().coalesce(__.union(__.out(),__.in()), __.both())').sql).toContain('ROW_NUMBER() OVER () AS o0');
    // as() before coalesce: originSeed projects the alias alongside the ordinal, the
    // merge outputs it (dropping the internal `o`) → select("a") resolves (Move B)
    const ca = read('g.V().as("a").coalesce(__.out(), __.in()).select("a")');
    expect(ca.sql).toContain('ROW_NUMBER() OVER () AS o0');
    expect(ca.sql).toContain('SELECT id, a0, bulk FROM');
  });

  test('flatMap() consumes every productive element or scalar child row', () => {
    const sql = read('g.V().flatMap(__.out().out()).values("name")').sql;
    expect(sql).toContain('SELECT e.tgt AS id, p.bulk, p.o0 FROM edges e');
    expect(sql).toContain('SELECT p.id AS id, p.bulk FROM c3 p'); // `all` consumes the child origin
    const scalar = read('g.V().flatMap(__.values("name"))');
    // a child values() keeps its per-row stored type through the child boundary
    expect(scalar.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(scalar.sql).toContain('JOIN vertex_properties vp');
    // Every scalar child records provider encounter order explicitly. `all` drops
    // the child ordinal without applying map's second first-per-parent window.
    expect(scalar.sql.match(/PARTITION BY/g)?.length).toBe(1);
  });

  test('map(__.<scalar>) → per-traverser scalar projection (value shape)', () => {
    const m = read('g.V().map(__.out().count())');
    expect(m.shape).toEqual({ kind: 'value', type: STATIC('long') }); // count() is a Long
    // count() is a child-scope barrier, not a correlated scalar fast path: the
    // preserved domain makes an empty child an explicit zero row per origin.
    expect(m.sql).toContain('COUNT(c.id) AS v');
    expect(m.sql).toContain('LEFT JOIN');
    expect(m.sql).toContain('GROUP BY d.o0');
    const localCount = read('g.V().local(__.out().count())');
    expect(localCount.sql).toContain('COUNT(c.id) AS v');
    expect(localCount.sql).toContain('LEFT JOIN');
    const localRows = read('g.V(1).local(__.out().values("name").order().limit(2))');
    expect(localRows.sql).toContain('PARTITION BY p.o0 ORDER BY (CASE WHEN p.vtype');
    expect(localRows.sql).toContain('ELSE p.v END) ASC');
    const carriedCount = read('g.V(1).as("a").local(__.out().count())');
    expect(carriedCount.sql).toContain('COUNT(c.id) AS v, d.a0');
    const childValue = read('g.V(1).map(__.values("name"))');
    expect(childValue.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(childValue.sql).toContain('JOIN vertex_properties vp');
    expect(childValue.sql).toContain('ROW_NUMBER() OVER (PARTITION BY p.o0');
    expect(read('g.V(1).map(__.values("name").toUpper())').sql).toContain('upper(p.v) AS v');
    expect(read('g.V(1).map(__.out().values("name").order().by(Order.desc).limit(1))').sql)
      .toContain('ELSE p.v END) DESC');
    expect(read('g.V(1).local(__.out().values("name").tail(2))').sql)
      .toContain('PARTITION BY p.o0 ORDER BY p.encounter DESC');
    const reducedChild = read('g.V().map(__.out().values("name").is("lop").count())');
    // A SCOPED reducer counts child rows per parent and does NOT weight by bulk — that column
    // holds the PARENT's multiplicity here, and the domain re-projects it onto the result row, so
    // weighting would apply it twice (test/L2-sql/repeat-path.sql.test.ts P1.2 pins the semantics;
    // the rule is on lowerScopedScalarReducer). A per-key GROUP total does weight — that is P1.1.
    expect(reducedChild.sql).toContain('COUNT(s.encounter) AS v');
    expect(reducedChild.sql).toContain('LEFT JOIN');
    const foldedChild = read('g.V().map(__.out().values("name").fold()).count(Scope.local)');
    // The folded member now carries the per-list encoding decision (bare vs {t,v}); the
    // ORDER BY / FILTER productivity contract is unchanged.
    expect(foldedChild.sql).toContain('ORDER BY s.encounter) FILTER (WHERE s.encounter IS NOT NULL)');
    expect(foldedChild.sql).toContain("json('[]')");
    expect(read('g.V().map(__.out().fold()).unfold().values("name")').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(() => compile('g.V().map(__.constant(1).discard())', {})).toThrow();
    // record/list-valued child bodies still defer; element bodies use generic child scope below.
    // A label select in a child body is NOT a deferral: select("a") with no binding in scope
    // drops every traverser, exactly as it does at root (TinkerPop Select.feature
    // g_V_selectXaX pins the empty result), so the body compiles to a zero-row element child.
    expect(read('g.V().map(__.select("a"))').sql).toContain('WHERE 0');
    expect(() => compile('g.V().map(__.values("name")).map(__.values("age"))', {})).toThrow('map() after a scalar stream not yet supported');
    // The leaf now returns a ScalarStream instead of materializing terminal SQL.
    expect(read('g.V().map(__.out().count()).is(P.gt(0)).count()').shape).toEqual({ kind: 'value', type: STATIC('long') });
  });

  test('map(__.<element body>) uses child scope + first-per-parent cardinality', () => {
    const p = read('g.V().map(__.out()).values("name")');
    expect(p.shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
    expect(p.sql).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(p.sql).toContain('WHERE r.rn=1');
    expect(read('g.V(1).map(__.outE("knows")).inV().values("name")').shape).toEqual({ kind: 'value', type: PER_ROW('vtype') });
  });

  test('choose(pred, then, else) → gated-seed UNION ALL, arms fold from their seed', () => {
    const c = read('g.V().choose(__.has("name","vadas"), __.out("knows"), __.in("knows"))');
    // two gated seeds off the same source (c0): pred and NOT-pred
    expect(c.sql).toContain("WHERE EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)");
    expect(c.sql).toContain("WHERE NOT COALESCE((EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value = ?)), 0)");
    // arms fold through movement; the two element id-relations merge UNION ALL
    expect(c.sql).toContain('UNION ALL');
    expect(c.shape).toEqual({ kind: 'vertex' });
    expect(c.binds).toEqual(['name', 'vadas', 'knows', 'name', 'vadas', 'knows']);
    // count().is predicate rides as a correlated subquery; multi-hop arm folds
    expect(read('g.V().choose(__.out("knows").count().is(P.gt(0)), __.out("created").out())').sql)
      .toContain('(SELECT COUNT(*) FROM (SELECT e.tgt AS id FROM edges e JOIN (SELECT n.id AS id) p ON e.src=p.id AND e.label IN');
    // 2-arg form: else absent → identity passthrough of the NOT-pred seed
    expect(read('g.V().choose(__.hasLabel("software"), __.in("created"))').sql).toContain('UNION ALL');
    const scalar = read('g.V().choose(__.hasLabel("person"), __.values("name"), __.constant("software")).count()');
    expect(scalar.shape).toEqual({ kind: 'value', type: STATIC('long') });
    expect(scalar.sql).toContain(' AS v FROM');
    expect(scalar.sql).toContain('UNION ALL');
  });

  test('choose() deferrals fail closed', () => {
    // a bare choice traversal with no then/else and no option() isn't a supported form
    expect(() => compile('g.V().choose(__.out())', {}))
      .toThrow('predicate form');
    // mixed element+scalar then/else now merge as a dynamic-tag VariantStream (P4)
    const mixedCh = read('g.V().choose(__.has("x"), __.out(), __.values("name"))');
    expect(mixedCh.shape).toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    // mixed element kinds across arms (both element-class) stays the legacy defer
    expect(() => compile('g.V().choose(__.has("x"), __.out(), __.outE())', {}))
      .toThrow('different element kinds');
    // as() before choose now threads the alias column through the gated arms + merge (Move B)
    const ca = read('g.V().as("a").choose(__.has("x"), __.out(), __.in()).select("a")');
    expect(ca.sql).toContain('UNION ALL');
    expect(ca.sql).toContain('SELECT id, a0, bulk FROM'); // a0 preserved across the gated-arm merge
    // a NEW as() inside one arm now forks/merges: the non-binding arm pads an empty history.
    const divC = read('g.V().choose(__.has("x"), __.as("b").out(), __.in()).select("b")');
    expect(divC.sql).toContain('SELECT id, a0, bulk FROM');
    expect(divC.sql).toContain('SELECT id, NULL AS a0, bulk FROM');
  });

  test('option-map choose → CASE over the choice scalar (value shape)', () => {
    // The CASE serves an option map with exactly ONE fallthrough: a Pick.none and no
    // Pick.unproductive. (See lowerChooseOptions for the known gap this leaves.)
    const c = read('g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z"))');
    expect(c.shape).toEqual({ kind: 'value', type: UNKNOWN });
    expect(c.sql).toContain('LEFT JOIN');
    expect(c.sql).toContain('m0_present');
    expect(c.sql).toContain('CASE WHEN (p.m0 >= ? and p.m0 < ?) THEN p.m1 ELSE p.m2 END AS v');
    expect(c.binds).toEqual(['age', 'x', 'z', 26, 30, 26, 30]);
    // A written Pick.unproductive is a SECOND fallthrough — keyed off the choice's PRESENCE, not
    // its value — so it needs the merge's per-arm gating rather than an ELSE.
    expect(read('g.V().choose(__.values("age")).option(P.between(26,30), __.constant("x")).option(Pick.none, __.constant("z")).option(Pick.unproductive, __.constant("u"))').sql)
      .toContain('ch_at');
    // T.label choice, literal-equality keys
    expect(read('g.V().choose(T.label).option("person", __.constant("p")).option(Pick.none, __.constant("o"))').sql)
      .toContain('CASE WHEN (SELECT name FROM labels WHERE id=n.label) = ? THEN p.m0 ELSE p.m1 END');
    // count() choice is a total generic child barrier
    expect(read('g.V().choose(__.out().count()).option(1, __.values("name")).option(Pick.none, __.values("age"))').sql)
      .toContain('COUNT(c.id) AS v');
    expect(read('g.V().choose(T.label).option("person", __.constant("p")).option(Pick.none, __.constant("o")).fold()').shape)
      .toEqual({ kind: 'jsonbList', items: { kind: 'scalar' } });

    const nested = read('g.V().map(__.choose(__.values("age")).option(P.between(26,30), __.values("name")).option(Pick.none, __.constant("unknown")))');
    expect(nested.sql).toContain('CASE WHEN');
    expect(nested.sql).toContain('PARTITION BY');
    expect(nested.sql).toContain('m0_present');
  });

  test('option-map choose is an ARM MERGE; the scalar CASE is its specialization', () => {
    // The CASE projector owns the all-scalar-with-Pick.none form (one CTE, no per-arm gating) —
    // asserted just above. Everything else DECLINES to the generic arm-merge route, which gates
    // the parent per option (first match wins) and routes the arms to the ordinary merges.
    //
    // No Pick.none: TinkerPop passes unmatched inputs through as the ELEMENT, so the result is
    // genuinely mixed scalar/element → the variant merge, not a deferral.
    const passthrough = read('g.V().choose(__.out().count()).option(1, __.values("name")).option(2, __.values("age"))');
    expect(passthrough.shape).toMatchObject({ kind: 'variant', node: true });
    expect(passthrough.sql).toContain('NOT COALESCE'); // the unmatched (element) arm's gate
    // An ELEMENT option body is an arm, not a CASE branch → the element merge.
    expect(read('g.V().choose(T.label).option("person", __.out("knows")).option(Pick.none, __.identity()).values("name")').shape.kind)
      .toBe('value');
    // A discard() body drops its rows, contributing no arm of its own.
    expect(read('g.V().choose(__.out().count()).option(1, __.values("name")).option(Pick.none, __.discard())').shape.kind)
      .toBe('value');
    // optionMapNeedsPassthrough is load-bearing, and precise about WHEN: an always-productive
    // choice (count() is 0 on empty) can never reach the unproductive case, so no element arm is
    // added and the merge stays scalar; a choice that CAN be unproductive with no Pick.none keeps
    // the pass-through. Classify and emit share the predicate, so they cannot disagree.
    expect(read('g.V().choose(__.out().count()).option(1, __.values("name")).option(2, __.values("name"))').shape.kind)
      .toBe('variant');
    // Pick.unproductive is the choice producing NOTHING, distinct from Pick.none (a value that
    // matched no key) — the modulation seam's `present` column is what separates them.
    expect(read('g.V().choose(__.values("age")).option(P.between(26,30), __.values("name")).option(Pick.none, __.values("name")).option(Pick.unproductive, __.label())').sql)
      .toContain('ch_at');
    // ---- still fail-closed ----
    // Pick.any (only reachable via branch(), which is unimplemented) and a choice the correlated
    // modulation seam cannot compile: both routes decline, so the dispatch throws.
    expect(() => compile('g.V().choose(__.values("age")).option(P.gt(30), __.constant("x")).option(Pick.any, __.constant("u")).option(Pick.none, __.constant("z"))', {}))
      .toThrow('choose().option() not yet supported by generic lowering');
    expect(() => compile('g.V().choose(__.out()).option("x", __.constant("a")).option(Pick.none, __.constant("b"))', {}))
      .toThrow('choose().option() not yet supported by generic lowering');
  });
});
