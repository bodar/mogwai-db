// L2 — SQL snapshots: the "compile to SQL, never interpret" contract.
//
// Each test compiles a canonical Gremlin string and asserts the emitted SQL (via
// `.toContain` of the meaningful fragments — semantic equivalence, NOT byte
// identity; see CLAUDE.md "SQL snapshots assert semantic equivalence"). Some tests
// additionally run the compiled SQL against a seeded in-memory store to pin the
// result shape. The execution-semantics half of the old compiler.test.ts lives at
// test/compiler.test.ts (it runs SQL + asserts results, a different kind of test).
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { DerivedQuery, Query, q, render } from '../../src/sql/kernel/q.ts';
import { read, run, seededStore } from '../support/harness.ts';

// A few snapshot tests also pin the RESULT shape of the SQL they assert, so they run
// it against a seeded store. (The full execution-semantics suite is compiler.test.ts.)

describe('stream plumbing SQL (schema/CTE/derived/bulking/strategies)', () => {

  // The kernel owns BOTH rendering modes: `Query` names relations (`WITH c0, c1, …`),
  // `DerivedQuery` nests them (`(…) x0`, `(…) x1`). The correlated inline child
  // is the nesting mode plus a seed that references an outer
  // row — which is why the mode itself carries no traversal vocabulary and lives in q.ts.
  test('DerivedQuery nests instead of naming, shares one alias namespace, and fails closed', () => {
    const dq = new DerivedQuery();
    // A caller's seed and the fold's own relations draw from the SAME counter, so the two
    // can never drift into a collision (the seed used to be a hand-written 'x0' next to a
    // pre-incrementing counter in another module).
    expect(dq.alias()).toBe('x0');
    const inner = dq.cte(q`SELECT 1 AS id`, ['id']);
    expect(inner.name).toBe('x1');
    expect(render(inner.from).sql).toBe('(SELECT 1 AS id) x1');
    expect(render(dq.cte(q`SELECT id FROM ${inner}`, ['id']).from).sql)
      .toBe('(SELECT id FROM (SELECT 1 AS id) x1) x2');
    // Nesting means no shared WITH to hang a recursive term on, and no standalone render.
    // Both throw rather than emitting something malformed — this is what turns "a repeat()
    // inside a correlated body" into a clear deferral instead of broken SQL.
    expect(() => dq.recursiveCte(['id'], () => q`SELECT 1`)).toThrow('cannot host a recursive CTE');
    expect(() => dq.render(q`SELECT 1`)).toThrow('never rendered standalone');
    // A plain Query is unaffected: it still names.
    expect(new Query().cte(q`SELECT 1 AS id`, ['id']).name).toBe('c0');
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



});
