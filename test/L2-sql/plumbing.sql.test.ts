// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
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

describe('stream plumbing SQL (schema/CTE/derived/bulking/strategies)', () => {
  test('stream physical schemas are exact and fail immediately on column drift', () => {
    const q = new Query();
    const carry = { q, params: {}, carried: { aliases: new Map(), origins: [] } };
    expect(assertStreamColumns(toScalarStream(carry, q.cte({} as any, ['v']))).kind).toBe('scalar');
    expect(() => toScalarStream(carry, q.cte({} as any, ['value']))).toThrow(
      'scalar stream column mismatch: expected [v], got [value]',
    );
    expect(toVariantStream(carry, q.cte({} as any, ['vk', 'v', 'rid']), { node: true }).kind).toBe('variant');
    expect(() => toVariantStream(carry, q.cte({} as any, ['v', 'rid']), { node: true })).toThrow(
      'variant stream column mismatch',
    );
    const propertyCols = ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pvtype', 'pmeta'];
    expect(toPropertyStream(carry, q.cte({} as any, propertyCols), 'node').kind).toBe('property');
    expect(() => toPropertyStream(carry, q.cte({} as any, propertyCols.slice(1)), 'node')).toThrow(
      'property stream column mismatch',
    );
    const fields = [{ key: 'x', prefix: 'e0', sub: 'vertex' as const }];
    const recordCols = ['e0_rid', 'e0_id', 'e0_label', 'e0_props'];
    expect(toRecordStream(carry, q.cte({} as any, recordCols), fields).kind).toBe('record');
    expect(() => toRecordStream(carry, q.cte({} as any, recordCols.slice(1)), fields)).toThrow(
      'record stream column mismatch',
    );
    const groupKey = { kind: 'scalar' as const };
    const groupVal = { kind: 'count' as const };
    expect(toGroupStream(carry, q.cte({} as any, ['gk', 'gv']), groupKey, groupVal).kind).toBe('group');
    expect(() => toGroupStream(carry, q.cte({} as any, ['mk', 'mv']), groupKey, groupVal)).toThrow(
      'group stream column mismatch',
    );
    const pathLayout = { kind: 'linear' as const, positions: [{ render: 'value' as const, prefix: 'x0' }] };
    expect(toPathStream(carry, q.cte({} as any, ['x0_v']), pathLayout).kind).toBe('path');
    expect(() => toPathStream(carry, q.cte({} as any, ['v']), pathLayout)).toThrow(
      'path stream column mismatch',
    );
  });

  test('child scope retains a parent domain and pushes/pops one physical ordinal', () => {
    const q = new Query();
    const parent = {
      kind: 'elements' as const, elem: 'node' as const, q, params: {},
      rel: q.cte({} as any, ['id']), carried: { aliases: new Map(), origins: [] as string[] },
    };
    const { frame, scope, seed } = pushChildScope(parent);
    expect(frame.domain).toBe(seed.rel);
    expect(frame.ordinal).toBe('o0');
    expect(scope.frames).toEqual([frame]);
    expect(seed.carried.origins).toEqual(['o0']);
    expect(assertStreamColumns(seed)).toBe(seed);

    const reused = pushChildScope(seed, reuseCurrentFrame(scope, frame));
    expect(reused.seed).toBe(seed);
    expect(reused.frame.ordinal).toBe('o0');
    expect(reused.frame.reused).toBe(true);
    expect(reused.seed.carried.origins).toEqual(['o0']);

    const popped = popChildScope(seed, frame);
    expect(popped.carried.origins).toEqual([]);
    expect(popped.rel.cols).toEqual(['id']);
    expect(assertStreamColumns(popped)).toBe(popped);
  });

  test('read steps materialize through one root boundary', () => {
    const dir = new URL('../../src/compiler/steps/', import.meta.url);
    const allowed = new Set(['materialize.ts', 'write.ts']);
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')] as const);
    const offenders = sources
      .filter(([name]) => !allowed.has(name))
      .filter(([, source]) => source.includes('readCompiled'))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
    expect(sources.some(([, source]) => source.includes('only one projection step is supported per traversal'))).toBe(false);
  });

  test('window rank/filter boundaries use typed derived tables, not paired CTEs', () => {
    const project = read('g.V().project("a","b").by(__.out().values("name")).by(__.in().count())');
    expect(project.sql.split(' as (')).toHaveLength(8); // seven CTEs
    // the child's per-row vtype column rides through the first-row ranking too, so the
    // projected value keeps its stored type.
    expect(project.sql).toContain('FROM (SELECT r.v AS v, r.vtype AS vtype, r.bulk, r.o0, ROW_NUMBER() OVER');

    const local = read('g.V().local(__.out().values("name").order().limit(2))');
    expect(local.sql.split(' as (')).toHaveLength(6); // five CTEs
    // The child order()+limit() slice keys off the per-origin carried encounter.
    expect(local.sql).toContain('ROW_NUMBER() OVER (PARTITION BY p.o0 ORDER BY p.encounter) AS rn');
  });

  test('traverser bulking: times(n).count() unrolls to GROUP-BY-SUM(bulk) CTEs, not a recursion', () => {
    const c = read('g.V().repeat(__.out()).times(3).count()');
    expect(c.shape).toEqual({ kind: 'count' });
    // The bulk path: a per-depth GROUP-BY-SUM, one non-recursive CTE per hop, summed at
    // the end. SQLite rejects an aggregate in a recursive term, so it MUST NOT recurse.
    expect(c.sql).not.toContain('recursive');
    expect(c.sql).toContain('SUM(b) AS bulk');
    expect(c.sql).toContain('GROUP BY nb');
    expect(c.sql).toContain('COALESCE(SUM(s.bulk), 0) AS v');
    // times(3) → f0 (seed) + three hop CTEs.
    expect((c.sql.match(/GROUP BY nb/g) ?? []).length).toBe(3);
    // A post-repeat as()/movement/select() chain discarded by count remains bulkable: the
    // collapsed frontier re-enters generic lowering, and count() sums bulk regardless of the
    // identity as()/select() name (cardinality is unchanged). The times(5) unroll is five
    // GROUP-BY-SUM frontiers; the post-as() out("writtenBy") hop rides bulk forward as a plain
    // UNION-ALL movement (per-hop collapse is off once an alias is live) — still bounded from the
    // |V|-bounded frontier, never the exponential walk count, and never a recursion.
    const selected = read('g.V().repeat(__.out()).times(5).as("a").out("writtenBy").as("b").select("a","b").count()');
    expect(selected.sql).not.toContain('recursive');
    expect((selected.sql.match(/GROUP BY nb/g) ?? []).length).toBe(5);
    expect(selected.shape).toEqual({ kind: 'count' });
    // A NON-bulkable repeat (path/emit/complex body) stays the enumerate-walk
    // recursion — bulking must not hijack it. emit() has no compile-time depth.
    expect(read('g.V(1).repeat(__.out()).emit().times(2).count()').sql).toContain('recursive');
    expect(read('g.V(1).repeat(__.out()).times(2).path()').sql).toContain('recursive');
  });

  test('result-preserving optimization strategies accepted as no-ops (correct-by-design)', () => {
    // These cannot change the result set (TinkerPop optimization-strategy contract),
    // so not applying them is exactly correct. The official suite proves it: the
    // withStrategies(X) and withoutStrategies(X) scenarios expect identical rows.
    for (const s of ['CountStrategy', 'IdentityRemovalStrategy', 'FilterRankingStrategy',
                     'LazyBarrierStrategy', 'MatchAlgorithmStrategy', 'RepeatUnrollStrategy']) {
      expect(() => compile(`g.withStrategies(${s}).V().count()`, {})).not.toThrow();
      expect(() => compile(`g.withoutStrategies(${s}).V().count()`, {})).not.toThrow();
    }
    // identity() is the no-op step (what IdentityRemovalStrategy elides) — compiles.
    expect(read('g.V().identity().out().values("name")')).toBeDefined();
    expect(() => compile('g.withStrategies(IdentityRemovalStrategy).V().identity().out()', {})).not.toThrow();
    // withoutStrategies(X) is a safe no-op for any strategy we apply only on request (we
    // apply none by default, so there is nothing to suppress) — the sole exception is an
    // always-on strategy whose effect is unconditionally baked in (see ConnectiveStrategy).
    expect(() => compile('g.withoutStrategies(PartitionStrategy).V()', {})).not.toThrow();
    expect(() => compile('g.withoutStrategies(SubgraphStrategy, ProductiveByStrategy).V()', {})).not.toThrow();
  });

  test('SubgraphStrategy injects the vertex criterion as a filter after every vertex step', () => {
    // vertices: __.has(k,P) → a where() filter CTE spliced after V() (and after each
    // out/in/both). Both endpoints of a hop are checked: source filtered before, the
    // moved-to vertex filtered after.
    const sql = read('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("a","b")))).V().values("name")').sql;
    expect(sql).toContain('EXISTS(SELECT 1 FROM vertex_properties WHERE node=n.id AND key=? AND value in (?, ?))'); // criterion applied
    // after V() the filter is c1 (source c0 → filtered c1)
    expect(sql).toMatch(/c1\(id, bulk\) as \(SELECT n\.id, p\.bulk FROM nodes n JOIN c0 p .* WHERE EXISTS\(SELECT 1 FROM vertex_properties WHERE node=n\.id AND key=\? AND value in/);
  });

  test('PartitionStrategy read-filter isolates partitions; write-stamp tags created elements', () => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    // write two vertices into partitions a and b via the write-stamp
    run(store, 'g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).addV("person").property("name","marko")');
    run(store, 'g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"b")).addV("person").property("name","josh")');
    // the stamp is a real property (normalized into vertex_properties)
    expect(store.query("SELECT value p FROM vertex_properties WHERE key='_p' ORDER BY node").map((r: any) => r.p)).toEqual(['a', 'b']);
    // read visibility follows readPartitions
    const names = (q: string) => run(store, q).map((r: any) => r.v).sort();
    expect(names('g.V().values("name")')).toEqual(['josh', 'marko']); // unfiltered: both
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a"])).V().values("name")')).toEqual(['marko']);
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:["a","b"])).V().values("name")')).toEqual(['josh', 'marko']);
    // empty readPartitions → sees nothing
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", readPartitions:[])).V().values("name")')).toEqual([]);
    // writePartition-only (readPartitions OMITTED) defaults to EMPTY → sees nothing,
    // NOT everything. Gating the read filter on presence would leak all data.
    expect(names('g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).V().values("name")')).toEqual([]);
  });

  test('SubgraphStrategy filters real traversal results end-to-end', () => {
    const store = seededStore();
    const names = (q: string) => run(store, q).map((r: any) => r.v).sort();
    // only marko + josh are "in" the subgraph; count and values both respect it
    expect(run(store, 'g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V().count()').map((r: any) => r.v)).toEqual([2]);
    expect(names('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V().values("name")')).toEqual(['josh', 'marko']);
    // a hop lands only on vertices inside the subgraph: marko knows vadas+josh, but
    // vadas is filtered out → only josh survives
    expect(names('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().has("name","marko").out("knows").values("name")')).toEqual(['josh', 'vadas']);
  });

  test('ProductiveByStrategy makes missing by-results explicit nulls at supported consumers', () => {
    const store = seededStore();
    const grouped = run(store, 'g.withStrategies(ProductiveByStrategy).V().group().by("age").by("name")');
    expect(grouped.find((r) => r.gk == null)).toMatchObject({ gv: '["lop","ripple"]' });
    expect(read('g.withoutStrategies(ProductiveByStrategy).V().group().by("age").by("name")').shape)
      .toEqual({ kind: 'group', key: { kind: 'scalar' }, val: { kind: 'scalarList' } });
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().groupCount().by("age")').find((r) => r.gk == null)?.gv).toBe(2);

    const projected = run(store, 'g.withStrategies(ProductiveByStrategy).V().project("degree","age").by(__.inE().count()).by("age")');
    expect(projected).toHaveLength(6);
    expect(projected.filter((r) => r.e1_v == null).map((r) => r.e0_v).sort()).toEqual([1, 3]);

    const selected = run(store, 'g.withStrategies(ProductiveByStrategy).V().as("a").select("a").by("age")').map((r) => r.v);
    expect(selected.filter((v) => v == null)).toHaveLength(2);
    expect(selected.filter((v) => v != null).sort()).toEqual([27, 29, 32, 35]);
    expect(run(store, 'g.V().as("a").select("a").by("age")').map((r) => r.v).sort())
      .toEqual([27, 29, 32, 35]);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().group().by("age").by("name")', {})).toHaveLength(1);

    const aggregate = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("age").cap("a").unfold()').map((r) => r.v);
    expect(aggregate.filter((v) => v == null)).toHaveLength(2);
    expect(aggregate.filter((v) => v != null).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    const traversed = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by(__.values("age").is(gt(29))).cap("a").unfold()').map((r) => r.v);
    expect(traversed.filter((v) => v == null)).toHaveLength(4);
    expect(traversed.filter((v) => v != null).sort((a, b) => a - b)).toEqual([32, 35]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().local(__.aggregate("a").by("age")).cap("a").unfold()').map((r) => r.v).filter((v) => v == null)).toHaveLength(2);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("age").cap("a").max(Scope.local)').map((r) => r.v)).toEqual([35]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").max(Scope.local)').map((r) => r.v)).toEqual([null]);
    expect(run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").unfold().sum()').map((r) => r.v)).toEqual([null]);
    expect(run(store, 'g.V().aggregate("a").by(__.outE("created").count()).cap("a").unfold()').map((r) => r.v).sort((a, b) => a - b))
      .toEqual([0, 0, 0, 1, 1, 2]);
    const elementAggregate = run(store, 'g.V().aggregate("x").by(__.out().order().by("name")).cap("x").unfold()');
    expect(elementAggregate.map((r) => r.id).sort((a, b) => a - b)).toEqual([3, 3, 4]);
    const productiveElements = run(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("x").by(__.out().order().by("name")).cap("x").unfold()');
    expect(productiveElements.filter((r) => r.vk === 0)).toHaveLength(3);
    expect(productiveElements.filter((r) => r.vk === 2).map((r) => r.id).sort((a, b) => a - b)).toEqual([3, 3, 4]);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().aggregate("x").by(__.out().order().by("name")).cap("x")', {})).toHaveLength(1);

    const nullableRecord = run(store, 'g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name"))');
    expect(nullableRecord.filter((r) => r.e0_id == null)).toHaveLength(3);
    expect(executeQuery(store, 'g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name"))', {})).toHaveLength(6);
    expect(read('g.withStrategies(ProductiveByStrategy).V().project("x").by(__.out().order().by("name")).select("x")').shape)
      .toEqual({ kind: 'variant', scalarAs: undefined, node: true });
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().order().by("age")', {})).not.toThrow();
    expect(read('g.withStrategies(ProductiveByStrategy).V().as("a").out().as("b").where("a",eq("b")).by("age")').sql)
      .toContain(' IS ');
    expect(read('g.withStrategies(ProductiveByStrategy).V(1).out().path().by("age")').sql)
      .not.toContain('IS NOT NULL');

    const deduped = run(store, 'g.withStrategies(ProductiveByStrategy).V().order().by("name",desc).barrier().dedup().by("age").values("name")').map((r) => r.v);
    expect(deduped).toEqual(['vadas', 'ripple', 'peter', 'marko', 'josh']);
  });

  test('verification strategies throw TinkerPop\'s canonical messages (pass a legal traversal)', () => {
    // ReadOnly: any mutating step rejected; a read passes.
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).V().out("knows").values("name")', {})).not.toThrow();
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).addV("person")', {}))
      .toThrow('The provided traversal has a mutating step and thus is not read only');
    expect(() => compile('g.withStrategies(ReadOnlyStrategy).E().property("weight",0)', {}))
      .toThrow('The provided traversal has a mutating step and thus is not read only');
    // EdgeLabel: bare out() rejected only when throwException:true; false → no-op pass.
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true, logWarning:false)).V().out()', {}))
      .toThrow('The provided traversal contains a vertex step without any specified edge label');
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:false)).V().out()', {})).not.toThrow();
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true)).V().out("knows")', {})).not.toThrow();
    // ReservedKeys: default {id,label}; config keys overrides. Message names the key.
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true)).addV("person").property("id",123)', {}))
      .toThrow('is setting a property key to a reserved word: id');
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true, keys:{"age"})).addV("person").property("age",29)', {}))
      .toThrow('is setting a property key to a reserved word: age');
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true)).addV("person").property("name","marko")', {})).not.toThrow();
    // Verify runs against the user's ORIGINAL (pre-decoration) chain, not the injected one:
    // PartitionStrategy(partitionKey:"label") injects property("label", ...) after addV as a write
    // stamp. That injected stamp must NOT trip ReservedKeysVerificationStrategy (default {id,label})
    // — the user's authored addV("person") sets no reserved key. Verifying the rewritten chain would
    // spuriously reject a strategy combination TinkerPop itself allows.
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"label", writePartition:"a"), ReservedKeysVerificationStrategy(throwException:true)).addV("person")', {})).not.toThrow();
    // A user-written property("label", ...) DOES trip it (the stamp exemption is only for the injected one).
    expect(() => compile('g.withStrategies(ReservedKeysVerificationStrategy(throwException:true)).addV("person").property("label","x")', {}))
      .toThrow('is setting a property key to a reserved word: label');
    // `to` is only a vertex step in the to(Direction) form — an addE().to(__.V(...))
    // endpoint modulator must NOT trip EdgeLabel verification.
    expect(() => compile('g.withStrategies(EdgeLabelVerificationStrategy(throwException:true)).addE("knows").from(__.V(1)).to(__.V(2))', {})).not.toThrow();
  });

  test('SubgraphStrategy edge criterion + adjacent-vertex checks + recursion (end-to-end)', () => {
    const store = seededStore();
    const vals = (q: string) => run(store, q).map((r: any) => r.v).sort();
    const one = (q: string) => run(store, q).map((r: any) => r.v);
    // An edge criterion filters which edges are traversable: marko has 2 knows + 1 created
    // out-edges; hasLabel("knows") keeps only the two knows edges.
    expect(vals('g.withStrategies(new SubgraphStrategy(edges: __.hasLabel("knows"))).V(1).outE().label()')).toEqual(['knows', 'knows']);
    // out()/in()/both() EXPLODE to edge+vertex when an edge criterion is set, so the
    // traversed edge itself is filtered — marko reaches only his knows-neighbours.
    expect(vals('g.withStrategies(new SubgraphStrategy(edges: __.hasLabel("knows"))).V(1).out().values("name")')).toEqual(['josh', 'vadas']);
    // checkAdjacentVertices: a visible edge needs BOTH endpoints in the subgraph. Of
    // marko's out-edges only marko→josh has both endpoints in {marko,josh}.
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V(1).outE().count()')).toEqual([1]);
    // vertices AND edges together: created-only edges, and both endpoints in the vertex set.
    expect(vals('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh","ripple","lop")), edges: __.hasLabel("created"))).V(1).out().values("name")')).toEqual(['lop']);
    // Injection RECURSES into a nested local() body (previously a hard defer): josh's
    // bothE, filtered so both endpoints ∈ {marko,josh}, leaves only josh↔marko.
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko","josh")))).V(4).local(__.bothE().limit(5)).count()')).toEqual([1]);
    // checkAdjacentVertices:false keeps an edge visible even when an endpoint is outside the
    // vertex criterion — honoured, not silently over-filtered. marko's 3 out-edges all
    // survive (only the near endpoint marko must be in {marko}); with the default (true) the
    // adjacency check would drop all 3 (no far endpoint is marko).
    expect(one('g.withStrategies(new SubgraphStrategy(checkAdjacentVertices: false, vertices: __.has("name", P.within("marko")))).V(1).outE().count()')).toEqual([3]);
    expect(one('g.withStrategies(new SubgraphStrategy(vertices: __.has("name", P.within("marko")))).V(1).outE().count()')).toEqual([0]);
  });

  test('complete taxonomy: OLAP/finalization/planning strategies are result-preserving no-ops', () => {
    const store = seededStore();
    const cnt = (q: string) => run(store, q).map((r: any) => r.v);
    // Inert on our OLTP SQL engine — accepting as no-ops is correct-by-design (the query
    // returns identically with/without). Covers the previously-rejected OLAP guards.
    for (const s of ['ComputerFinalizationStrategy', 'GraphFilterStrategy', 'MessagePassingReductionStrategy',
                     'ComputerVerificationStrategy', 'LambdaRestrictionStrategy', 'OptionsStrategy',
                     'GValueReductionStrategy', 'RequirementsStrategy', 'ProfileStrategy', 'ConnectiveStrategy']) {
      expect(cnt(`g.withStrategies(${s}).V().count()`)).toEqual([6]);
    }
  });

  test('semantic/unknown strategies + genuinely-unsupported forms fail closed (never silently leak)', () => {
    // ProductiveByStrategy is a no-op when no by()-consumer exists, but unsupported
    // consumers still fail closed instead of silently using ordinary productivity.
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().values("name")', {})).not.toThrow();
    expect(() => compile('g.withStrategies(ProductiveByStrategy).V().dedup().by("age")', {})).not.toThrow();
    // A safe optimization alongside ProductiveBy does not suppress its null-key policy.
    expect(() => compile('g.withStrategies(CountStrategy, ProductiveByStrategy).V().dedup().by("age")', {})).not.toThrow();
    // Unknown / unlisted-semantic strategies fail closed (catch-all reject) — these would
    // change results if silently ignored and are deliberately NOT laundered as no-ops.
    for (const s of ['ElementIdStrategy', 'SackStrategy', 'EventStrategy', 'VertexProgramStrategy'])
      expect(() => compile(`g.withStrategies(${s}).V()`, {})).toThrow('is a semantic or unknown strategy');
    // vertexProperties criterion + a mutating traversal under Subgraph defer clearly.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertexProperties: __.has("a",1))).V()', {}))
      .toThrow('vertexProperties');
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).addV("person")', {}))
      .toThrow('mutating traversal');
    // PartitionStrategy mergeV/mergeE (partition-aware upsert) defers.
    expect(() => compile('g.withStrategies(new PartitionStrategy(partitionKey:"_p", writePartition:"a")).mergeV([(T.label):"person"])', {}))
      .toThrow('mergeV()/mergeE() not yet supported');
    // withoutStrategies of an always-on (unconditionally-baked) strategy is rejected —
    // silently accepting it would return wrong rows (infix .or() is not disable-able).
    expect(() => compile('g.withoutStrategies(ConnectiveStrategy).V()', {}))
      .toThrow('cannot be disabled');
    // Injection recurses into a repeat() body; the recursive-CTE body compiler then fails
    // closed on movement+where — a clear deferral, NOT an unfiltered leak.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().repeat(__.out()).times(2)', {}))
      .toThrow('not yet supported');
    // A NON-movement nested criterion still compiles — recursion is precise, not blanket.
    expect(() => compile('g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person"))).V().where(__.has("name","marko"))', {})).not.toThrow();
    // withoutStrategies suppresses a co-named withStrategies (removal wins).
    expect(() => compile('g.withStrategies(ProductiveByStrategy).withoutStrategies(ProductiveByStrategy).V().values("name")', {})).not.toThrow();
  });

  test('deferred long-tail forms error clearly (never silently mis-execute)', () => {
    // a label bound NOWHERE drops every traverser → empty result (TinkerPop drops, never errors)
    expect(run(seededStore(), 'g.V().select(Pop.first,"a")')).toEqual([]);
    expect(run(seededStore(), 'g.V().select("x")')).toEqual([]);
    expect(() => compile('g.V().as("a").select("a").by(T.id)', {})).toThrow('by(T.id) modulator not yet supported');
    expect(() => compile('g.V().as("a").out().as("b").select("a","b").order()', {})).toThrow('order() on a record requires a by(field)');
    // order().by() deferred modulators must throw, not silently sort by id. A pure
    // key/token order() with a T-token still defers (no traversal term → the acc.orders
    // machinery, which has no token support yet).
    expect(() => compile('g.V().order().by(T.label)', {})).toThrow('by(T.label) modulator not yet supported');
    // single AND multi-term order().by(traversal) are now supported (mixing keys/traversals),
    // lowered through the shared multi-modulator seam — see order-traversal-multi.feature (L4)
    // and the order().by() SQL tests. They must NOT throw.
    expect(() => compile('g.V().order().by("name").by(__.values("age"))', {})).not.toThrow();
    expect(() => compile('g.V().order().by(__.in().count()).by(__.out().count())', {})).not.toThrow();
    // dedup: dedup(labels) is supported (see the dedup(labels) test); bare dedup after as()
    // stays deferred rather than answered wrongly (path-distinct semantics).
    expect(() => compile('g.V().as("a").out().dedup()', {})).toThrow('dedup() after as() not yet supported');
    expect(() => compile('g.V().dedup().by("age").by("name")', {})).toThrow('at most one by()');
  });

  test('review-fix regressions: no silent mis-execution', () => {
    // edge out().count() must throw (was silently mis-counting via edge id). Now the
    // generic child path recognizes count().is and compiles the child, so the movement
    // itself rejects out() on an edge — a more precise fail-closed error than before.
    expect(() => compile('g.E().where(__.out().count().is(P.gt(0)))', {})).toThrow('out() expects a vertex, not an edge');
    // where(__.move().is(P)) must not silently drop the is()
    expect(() => compile('g.V().where(__.out("knows").is(1))', {})).toThrow('not supported by inline predicate or generic child existence');
    // limit() then is() remains position-sensitive: only the first three values
    // reach the predicate, so Peter's later age (35) cannot leak through.
    const limited = seededStore();
    expect(run(limited, 'g.V().values("age").limit(3).is(P.gt(30))').map((r) => r.v)).toEqual([32]);
    // alias-compare by(key) on an edge label throws rather than reading nodes
    expect(() => compile('g.V().as("a").outE().as("e").where("e", P.eq("a")).by("weight")', {})).toThrow('edge-typed label not yet supported');
  });
});
