// Compiler execution semantics (split from test/compiler.test.ts) — writes (drop / property / addV / addE / mergeV / mergeE).
// Runs compiled SQL against a seeded in-memory store, asserting RESULTS. Pure cut-
// and-paste relocation; the SQL-string snapshots live at test/L2-sql/*.sql.test.ts.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { idAlreadyExists, run, seededStore, written } from '../support/harness.ts';
import { isRowsBind } from '../../src/rel/emit.ts';
import { executeQuery } from '../support/executor.ts';
import { CF_MAX_BINDS } from '../../src/cf-limits.ts';
import type { RunStep } from '../../src/program.ts';

// A SNAPSHOT read on the rendered steps: a retained READ (not a mutation) whose rows a LATER step
// references via a json_each RowsBind — the pre-mutation read a cascade/merge depends on. A mutation's
// own RETURNING rows are also retained+referenced, so the non-mutation filter is what isolates the read.
const snapshotReads = (steps: readonly RunStep[]): readonly RunStep[] => {
  const referenced = new Set(steps.flatMap((step) => step.emitted.binds.filter(isRowsBind).map((bind) => bind.rowsOf)));
  return steps.filter((step) => step.binding !== undefined && referenced.has(step.binding) && !/^\s*(INSERT|UPDATE|DELETE)/i.test(step.emitted.sql));
};

// ---------- execution semantics against a seeded store ----------

// A write-response echo now carries each prop value as a self-describing {t,v} typed node
// (so the wire frames it exactly). Tests that assert the written VALUES (not their types)
// unwrap the nodes to plain values with this recursive helper.

describe("write execution", () => {
test('drop() after an edge-reading traversal deletes the right vertices', () => {
  // regression: g.V(1).out().drop() must drop marko's out-neighbors, not just
  // their edges. Snapshotting target ids before mutating guards this.
  const store = seededStore();
  run(store, 'g.V(1).out().drop()'); // vadas(2), lop(3), josh(4)
  const remaining = run(store, 'g.V().values("name")').map((r) => r.v).sort();
  expect(remaining).toEqual(['marko', 'peter', 'ripple']);
});

test('drop() removes vertices and their incident edges', () => {
  const store = seededStore();
  run(store, 'g.V(1).drop()'); // marko + edges 7,8,9
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([5]);
  // marko was src of 3 edges; all gone
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3);
});

test('g.V().drop() empties the graph (cucumber reset idiom)', () => {
  const store = seededStore();
  run(store, 'g.V().drop()');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([0]);
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
});

test('edge drop() deletes only the matched edges, not their endpoints', () => {
  const store = seededStore();
  run(store, 'g.V(1).outE().drop()'); // marko's 3 out-edges (7,8,9)
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // every vertex survives
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(3); // edges 10,11,12 remain
});

test('g.E().drop() removes every edge but keeps all vertices', () => {
  const store = seededStore();
  run(store, 'g.E().drop()');
  expect(store.query('SELECT COUNT(*) AS c FROM edges')[0].c).toBe(0);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
});

// The SHAPE, pinned — the semantics above are asserted by reading the graph back, so nothing else
// here would notice a drop() being lowered a different way. This test pins that lowering directly.
//
// What the shape says: the target is a RETAINED read (`snapshot`), so the cascade's statements read
// the ids the graph had BEFORE any of them ran — the property `g.V().out().drop()` above depends on,
// and one a CTE could not have, since a CTE reading `edges` is a different question after the
// incident-edge delete. Every statement carries O(1) binds because that retained set crosses as ONE
// JSON value (§6·2); `test/cf-limits.test.ts` is where that is measured at 250 elements.
test('drop() compiles to a RelIR program whose target is snapshotted, not a re-evaluated CTE', () => {
  const vertex = compile('g.V().has("name","marko").drop()', {});
  expect(vertex.kind).toBe('program');
  if (vertex.kind !== 'program') throw new Error('unreachable');
  // The snapshot property, asserted on the SHIPPED steps (the algebra no longer travels on a Program).
  // A snapshot is a retained READ referenced by a LATER statement as ONE json_each RowsBind — so the
  // cascade reads the pre-mutation ids rather than re-scanning a table an earlier delete already
  // changed. Two here: the matched vertices, and the edges incident to them. (A mutation's own
  // RETURNING rows are also retained+referenced, so filter those out — a snapshot is a read.)
  expect(snapshotReads(vertex.steps).length).toBe(2);
  expect(vertex.steps.filter((step) => step.emitted.sql.startsWith('DELETE')).length).toBe(8);
  expect(Math.max(...vertex.steps.map((step) => step.emitted.binds.length))).toBeLessThanOrEqual(CF_MAX_BINDS);

  const edge = compile('g.E().drop()', {});
  if (edge.kind !== 'program') throw new Error('an edge drop() is a program too');
  // No cascade to an element: an edge takes only its own property rows and their FTS text.
  expect(edge.steps.filter((step) => step.emitted.sql.startsWith('DELETE')).length).toBe(3);
});

// THE PROPERTY THE WHOLE WRITE WEDGE EXISTS FOR, asserted rather than described.
//
// A per-element write path would read its target elements into JS and walk them, making its statement
// count a function of the ROW COUNT. A RelIR program's is a function of the PLAN: the elements are an
// `Insert.source`, one statement writes N rows, and the only rows that cross into JS are a
// snapshot's — as ONE JSON value, which is §6·2's rule.
//
// A count that is merely SMALL would not say this; a count that is IDENTICAL at ten elements and a
// hundred does. Measured, not asserted from the shape of the code — the failure this guards against
// is a future step quietly reintroducing a per-element loop behind the same API.
(test)('a write program runs the same number of statements whatever the element count', () => {
  const runs = (n: number): number => {
    const inner = new BunSqlite(':memory:');
    let calls = 0;
    const counting = { exec: (...a: any[]) => (inner as any).exec(...a), query: (sql: string, binds?: any[]) => { calls++; return (inner as any).query(sql, binds); } } as any;
    const store = new GraphStore(counting);
    for (let i = 1; i <= n; i++) run(store, `g.addV('person').property('name','p${i}')`);
    const before = calls;
    run(store, "g.V().hasLabel('person').property(single,'seen',1)");
    return calls - before;
  };
  expect(runs(10)).toBe(runs(100));
});

test('property() updates existing vertices (overwrite + new key, single cardinality)', () => {
  const store = seededStore();
  // overwrite marko's age, add a new key. `single` is SPELLED OUT: the graph default is `list`
  // (api.ts, DEFAULT_VERTEX_CARDINALITY), so an undeclared write would append a second age —
  // which is the next test.
  // ONE traverser out, and it is the vertex — asserted on the WIRE rather than on whatever object
  // the compile route happens to hand back. The properties themselves are read back below, which is
  // the assertion that survives however the write is framed.
  expect(executeQuery(store, 'g.V(1).property(single, "age", 30).property("city", "London")').length).toBe(1);
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([30]);
  expect(run(store, 'g.V(1).values("city")').map((r) => r.v)).toEqual(['London']);
  // untouched vertices keep their props
  expect(run(store, 'g.V(2).values("age")').map((r) => r.v)).toEqual([27]);
});

test('an UNDECLARED property() appends, because the graph default is list', () => {
  const store = seededStore();
  run(store, 'g.V(1).property("age", 30)');
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v).sort((a, b) => a - b)).toEqual([29, 30]);
  // …and the declaration is per (node, key): vadas is untouched, and a `single` declared on her
  // does not follow marko's key.
  run(store, 'g.V(2).property(single, "age", 28)');
  run(store, 'g.V(2).property("age", 26)');
  expect(run(store, 'g.V(2).values("age")').map((r) => r.v)).toEqual([26]);
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v).sort((a, b) => a - b)).toEqual([29, 30]);
});

test('property() updates every matched vertex in the set', () => {
  const store = seededStore();
  run(store, 'g.V().hasLabel("person").property("kind", "human")');
  expect(run(store, 'g.V().has("kind","human").count()').map((r) => r.v)).toEqual([4]);
});

test('drop() forgets a vertex\'s cardinality declarations', () => {
  const store = seededStore();
  run(store, 'g.V(1).property(single, "nick", "okram")');
  run(store, 'g.V().drop()');
  // A fresh vertex must not inherit the dropped one's `single` declaration — the reason the
  // declaration is scoped to (node, key) and deleted with the vertex.
  run(store, 'g.addV("person").property("nick", "a").property("nick", "b")');
  expect(run(store, 'g.V().values("nick")').map((r) => r.v).sort()).toEqual(['a', 'b']);
  expect(store.query('SELECT COUNT(*) AS n FROM vertex_property_cardinality', [])[0].n).toBe(0);
});


test('property() cardinality: single replaces, list appends, set dedups (W4)', () => {
  const store = seededStore();
  // single replaces the existing value
  run(store, 'g.V(1).property(Cardinality.single, "age", 40)');
  expect(run(store, 'g.V(1).values("age")').map((r) => r.v)).toEqual([40]);
  // list appends — multiple values under one key
  run(store, 'g.V(1).property(Cardinality.list, "nick", "x")');
  run(store, 'g.V(1).property(Cardinality.list, "nick", "y")');
  expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
  // set dedups by value — re-adding "x" is a no-op
  run(store, 'g.V(1).property(Cardinality.set, "nick", "x")');
  expect(run(store, 'g.V(1).values("nick")').map((r) => r.v).sort()).toEqual(['x', 'y']);
  // has() matches ANY value under the key (multi-property semantics)
  expect(run(store, 'g.V(1).has("nick","y").count()').map((r) => r.v)).toEqual([1]);
});

test('addV multi-property + meta-property write (W4)', () => {
  const store = seededStore();
  run(store, 'g.addV("crew").property(Cardinality.list, "location", "sd", "startTime", 1997).property(Cardinality.list, "location", "sf", "startTime", 2005)');
  // both values land under the multi-valued key
  expect(run(store, 'g.V().hasLabel("crew").values("location")').map((r) => r.v).sort()).toEqual(['sd', 'sf']);
  // the meta blob is stored on the VertexProperty row
  const metas = store.query("SELECT json(meta) m FROM vertex_properties WHERE key='location' ORDER BY value").map((r: any) => JSON.parse(r.m));
  expect(metas).toEqual([{ startTime: 1997 }, { startTime: 2005 }]);
});


test('property() updates edges too (materialized on the wire via edgeBuffer)', () => {
  const store = seededStore();
  // The wire payload is the point of this one: a client's own EdgeSerializer drops properties, so
  // `edgeBuffer` writes them itself — an edge framed with no props would be a SHORTER buffer, which
  // is what a byte-length assertion over the two writes catches without pinning the encoding.
  const before = executeQuery(store, 'g.V(1).outE("created")');
  const after = executeQuery(store, 'g.V(1).outE("created").property("weight2", 0.9)');
  expect([before.length, after.length]).toEqual([1, 1]);
  expect(after[0]!.length).toBeGreaterThan(before[0]!.length);
  expect(run(store, 'g.V(1).outE("created").values("weight2")').map((r) => r.v)).toEqual([0.9]);
  expect(run(store, 'g.V(1).outE("created").values("weight")').map((r) => r.v)).toEqual([0.4]);
});

// THE CORRELATION, which is the only thing that makes a label bound BEFORE a creation still usable
// after it. An `Insert`'s `RETURNING` carries the target table's columns and not its source's, so
// nothing comes back saying which input row produced which output row; the two positions (the input
// carries its own, the created rows recover theirs from their monotonic ids) are what join them.
test('a label bound before addV() is still bound after it — the write chain', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV("a").as("x").addV("b").as("y").addE("e").from("x").to("y")');
  // The EDGE'S DIRECTION is the assertion: `from("x")` names the FIRST creation, which only survives
  // the second one if the alias came through it.
  expect(run(store, 'g.E().hasLabel("e").outV().label()').map((r: any) => r.v)).toEqual(['a']);
  expect(run(store, 'g.E().hasLabel("e").inV().label()').map((r: any) => r.v)).toEqual(['b']);
});

const CLONE_EACH = 'g.V().hasLabel("person").as("p").addV("clone").addE("of").to("p")';
test('addV() over many traversers pairs each new element with ITS OWN input row', () => {
  const store = seededStore();
  // One clone per person, each edged back to the person it was cloned from. A cross join would give
  // 16 edges; a correlation that paired wrongly would give a person with two incoming edges and
  // another with none. (Which clone got which person is unobservable — clones carry nothing to tell
  // them apart — so this is as strong as the assertion can honestly be.)
  run(store, CLONE_EACH);
  expect(run(store, 'g.E().hasLabel("of").count()').map((r: any) => r.v)).toEqual([4]);
  expect(run(store, 'g.E().hasLabel("of").inV().values("name").order()').map((r: any) => r.v))
    .toEqual(['josh', 'marko', 'peter', 'vadas']);
  expect(run(store, 'g.E().hasLabel("of").outV().dedup().count()').map((r: any) => r.v)).toEqual([4]);
});

test('addE start-step: from()/to() nested traversals + edge property', () => {
  const store = seededStore();
  // The edge's IDENTITY read back, rather than the write artifact's own object: the graph is what the
  // traversal is about, whatever shape the write echo takes.
  run(store, 'g.addE("knows").from(__.V().has("name","marko")).to(__.V().has("name","vadas")).property("weight", 0.9)');
  expect(run(store, 'g.V().has("name","marko").outE("knows").has("weight",0.9).inV().values("name")').map((r: any) => r.v)).toEqual(['vadas']);
  expect(run(store, 'g.E().hasLabel("knows").has("weight",0.9).count()').map((r: any) => r.v)).toEqual([1]);
  // marko already knew vadas (edge 7); now a second knows edge exists → 2 paths to vadas
  expect(run(store, 'g.V(1).out("knows").has("name","vadas").count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V(1).outE("knows").count()').map((r) => r.v)).toEqual([3]);
});

test('addE from() sets outV, incoming traverser is inV', () => {
  const store = seededStore();
  // g.V(2).addE("likes").from(__.V(1)) → edge 1→2 (inV defaults to current, vadas)
  run(store, 'g.V(2).addE("likes").from(__.V(1))');
  expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['vadas']);
});

test('addE mid-traversal with as() alias endpoint (per incoming traverser)', () => {
  const store = seededStore();
  // everything marko created gets a createdBy edge back to marko
  run(store, 'g.V(1).as("a").out("created").addE("createdBy").to("a")');
  expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('addE sets its own uid via property(T.id)', () => {
  const store = seededStore();
  const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(T.id, "e:marko-vadas")');
  // `written` and not `res[0].edge.id`: a RelIR program frames the created edge through the read
  // element projection, so the echo is flat and carries the public id, which is what this test means
  // to assert.
  expect(written(res[0]).id).toBe('e:marko-vadas');
  expect(run(store, 'g.E("e:marko-vadas").label()').map((r) => r.v)).toEqual(['knows']);
});

test('custom vertex and edge ids fail at the shared identity boundary', () => {
  const store = seededStore();
  // `idAlreadyExists` and not a literal: the refusal message is the reference's own sentence, built in
  // one place, so the assertion matches that matcher rather than duplicating the string here.
  expect(() => run(store, 'g.addV().property(T.id, 1)')).toThrow(idAlreadyExists('Vertex', 1));
  run(store, 'g.addV().property(T.id, "marko")');
  expect(() => run(store, 'g.addV().property(T.id, "marko")')).toThrow(idAlreadyExists('Vertex', 'marko'));
  expect(() => run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property(T.id, 7)')).toThrow(idAlreadyExists('Edge', 7));
});

test('addE write-chain graph initializer (addV.as.addV.as.addE.from.to)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV("person").property("name","marko").as("a").addV("person").property("name","vadas").as("b").addE("knows").from("a").to("b").property("weight", 0.5)');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([2]);
  expect(run(store, 'g.V().has("name","marko").out("knows").values("name")').map((r) => r.v)).toEqual(['vadas']);
  expect(run(store, 'g.V().has("name","marko").outE("knows").values("weight")').map((r) => r.v)).toEqual([0.5]);
});

test('addV inline property NESTED value routes through resolveSpecValue', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // __.constant(v) as an inline property value — evaluated at the new vertex.
  const res = run(store, 'g.addV("person").property("age", __.constant(29)).property("name", "marko")');
  // `written` and not `res[0].vertex`: the echo is the flat read element projection. What the test
  // means is what was written, which is what it reads.
  expect(written(res[0])).toMatchObject({ labels: ['person'], props: { name: ['marko'], age: [29] } });
  expect(run(store, 'g.V().has("person","age",29).values("name")').map((r) => r.v)).toEqual(['marko']);
});


test('addE inline property NESTED value resolves + response echoes the resolved value', () => {
  const store = seededStore();
  const res = run(store, 'g.addE("knows").from(__.V(1)).to(__.V(2)).property("w", __.constant(0.7))');
  // the framed response carries the resolved scalar, never a {nested} blob — read through `written`,
  // since the echo is flat rather than `{edge: …}`.
  expect(written(res[0]).props).toEqual({ w: 0.7 });
  expect(run(store, 'g.V(1).outE("knows").values("w")').map((r) => r.v)).toEqual([0.7]);
});

test('addV nested-traversal LABEL is evaluated at run time (no silent "vertex" default)', () => {
  const store = seededStore(); // modern: V(1)=marko/person
  run(store, 'g.addV(__.V(1).label()).property("name","clone")');
  expect(run(store, 'g.V().has("name","clone").label()').map((r) => r.v)).toEqual(['person']);
});




test('addE endpoint to(__.select("a")) ≡ to("a") (as()-label via nested select)', () => {
  const store = seededStore();
  run(store, 'g.V(1).as("a").out("created").addE("createdBy").to(__.select("a"))');
  expect(run(store, 'g.V(3).out("createdBy").values("name")').map((r) => r.v)).toEqual(['marko']);
});


test('addE endpoint traversal with a repeat cluster resolves (normalize fix)', () => {
  const store = seededStore(); // modern: V(1)=marko created lop(3)
  // to(...) endpoint uses a folded repeat/times cluster — must normalize before buildPrefix
  run(store, 'g.addE("x").from(__.V(2)).to(__.V(1).repeat(__.out("created")).times(1))');
  expect(run(store, 'g.V(2).out("x").values("name")').map((r) => r.v)).toEqual(['lop']);
});

test('addV nested LABEL __.constant(...) resolves (shared value authority)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV(__.constant("widget")).property("name","w")');
  expect(run(store, 'g.V().has("name","w").label()').map((r) => r.v)).toEqual(['widget']);
});


test('addV property value __.constant(UUID(...)) keeps the uuid vtype (not string)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.addV("person").property("gid", __.constant(UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c")))');
  const vt = store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype);
  expect(vt).toEqual(['uuid']);
});

test('mergeV creates when no match, matches when it exists (inline map)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const a = run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
  expect(written(a[0])).toMatchObject({ labels: ['person'], props: { name: ['marko'] } });
  // second identical merge matches the first → still one vertex, and the MATCH branch echoes it too.
  const b = run(store, 'g.mergeV([(T.label): "person", name: "marko"])');
  expect(written(b[0])).toMatchObject({ labels: ['person'], props: { name: ['marko'] } });
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  expect(run(store, 'g.V().hasLabel("person").has("name","marko").count()').map((r) => r.v)).toEqual([1]);
});

// The SHAPE, pinned — the semantics above are asserted by reading the graph back, so nothing else
// here would notice a merge being lowered a different way. This test pins that lowering directly.
//
// What the shape says is the whole design: upstream's "search, then branch on whether anything was
// found" needs a row COUNT before the next statement can be chosen, and a program of statements over
// relations cannot ask for one. So neither branch is a branch — the `onMatch` writes run over the match
// relation (empty on the create path) and the create runs over a source guarded by `NOT EXISTS <the
// match>` (empty on the match path). The match is SNAPSHOTTED because both of those read it after the
// statements between have changed the very properties it asked about.
test('mergeV compiles to a RelIR program whose two branches are both unconditional statements', () => {
  const plan = compile('g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, [age: 33])', {});
  expect(plan.kind).toBe('program');
  if (plan.kind !== 'program') throw new Error('unreachable');
  // ONE snapshot: the search, a retained READ referenced (as a json_each RowsBind) after the writes
  // changed what it asked about. Asserted on the shipped steps, since the algebra no longer travels.
  expect(snapshotReads(plan.steps).length).toBe(1);
  // Both branches emit, in one program, on every run: the create's INSERT INTO nodes and the onMatch
  // write's INSERT INTO vertex_properties are both there, and which of them writes a row is decided by
  // a predicate rather than by which statements were assembled.
  expect(plan.steps.some((step) => /INSERT INTO nodes/.test(step.emitted.sql))).toBe(true);
  expect(plan.steps.some((step) => /INSERT INTO vertex_properties/.test(step.emitted.sql))).toBe(true);
  // Same platform budget every write program is held to — the search crosses as ONE JSON value (§6·2),
  // so no statement's bind count is a function of how many elements the search matched.
  expect(Math.max(...plan.steps.map((step) => step.emitted.binds.length))).toBeLessThanOrEqual(CF_MAX_BINDS);
});

// A merge's statement count is a function of the PLAN, exactly as `property()`'s is above: the search
// is an `Insert.source`/`InQuery` relation, never rows walked in JS. A per-element path would run the
// match query plus eight store calls PER MATCHED ELEMENT; this must not move with the match count at all.
(test)('a mergeV program runs the same number of statements whatever the match count', () => {
  const runs = (n: number): number => {
    const inner = new BunSqlite(':memory:');
    let calls = 0;
    const counting = { exec: (...a: any[]) => (inner as any).exec(...a), query: (sql: string, binds?: any[]) => { calls++; return (inner as any).query(sql, binds); } } as any;
    const store = new GraphStore(counting);
    for (let i = 1; i <= n; i++) run(store, "g.addV('person').property('name','marko')");
    const before = calls;
    run(store, "g.mergeV([(T.label): 'person', name: 'marko']).option(Merge.onMatch, [age: 33])");
    return calls - before;
  };
  expect(runs(10)).toBe(runs(100));
});



test('mergeV literal map values keep their parsed type (uuid/long), not JS-inferred', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, "g.mergeV([(T.label):'person', gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c'), n: 5L])");
  const rows = store.query("SELECT key, vtype FROM vertex_properties ORDER BY key").map((r: any) => [r.key, r.vtype]);
  expect(rows).toEqual([['gid', 'uuid'], ['n', 'long']]);
});


test('mergeV onCreate typed value is honored on create', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, "g.mergeV([(T.label):'person', name:'x']).option(Merge.onCreate, [gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
  expect(store.query("SELECT vtype FROM vertex_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
});

test('mergeE literal edge property value keeps its parsed type (uuid)', () => {
  const store = seededStore(); // modern: V(1)=marko, V(2)=vadas
  run(store, "g.mergeE([(T.label):'rated', (Direction.OUT): 1, (Direction.IN): 2, gid: UUID('0263f28b-eff9-4c17-8e33-0b41c74b6d4c')])");
  expect(store.query("SELECT vtype FROM edge_properties WHERE key='gid'").map((r: any) => r.vtype)).toEqual(['uuid']);
});


test('mergeV([:]) matches all; on empty graph creates one default-label vertex', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.mergeV([:])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
  // now match-all matches the one; no new vertex
  run(store, 'g.mergeV([:])');
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([1]);
});

test('mergeV mid-chain runs per incoming traverser (g.V().mergeV([:]) → N×matches)', () => {
  const store = seededStore(); // 6 vertices
  const res = run(store, 'g.V().mergeV([:])'); // each of 6 drivers matches all 6
  expect(res.length).toBe(36);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]); // no creates
});

test('mergeV option(onMatch) patches props on the matched vertex', () => {
  const store = seededStore();
  // An onMatch map that names NO cardinality gets the graph default, which is `list` — MergeVertexStep
  // reads `features().vertex().getCardinality(key)` exactly as property() does, so a patch APPENDS.
  // `Cardinality.single(…)` in the map is how upstream says "replace" (CHANGELOG: "Allowed mergeV()
  // and property(Map) to more easily define Cardinality values for … onMatch and onCreate").
  run(store, 'g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, [age: 30])');
  expect(run(store, 'g.V().has("name","marko").values("age")').map((r) => r.v).sort((a, b) => a - b)).toEqual([29, 30]);

  const replaced = seededStore();
  run(replaced, 'g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, [age: Cardinality.single(30)])');
  expect(run(replaced, 'g.V().has("name","marko").values("age")').map((r) => r.v)).toEqual([30]);
});

test('mergeV option maps preserve CardinalityValueTraversal and the option default', () => {
  const ages = (option: string) => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    run(store, 'g.addV("person").property("name","marko").property(Cardinality.list,"age",29).property(Cardinality.list,"age",31).property(Cardinality.list,"age",32)');
    run(store, `g.mergeV([(T.label): "person", name: "marko"]).option(Merge.onMatch, ${option})`);
    return run(store, 'g.V().has("name","marko").values("age")').map((r) => r.v).sort();
  };
  expect(ages('[age: Cardinality.list(33)]')).toEqual([29, 31, 32, 33]);
  expect(ages('[age: Cardinality.set(31)]')).toEqual([29, 31, 32]);
  expect(ages('[age: Cardinality.single(33)]')).toEqual([33]);
  expect(ages('[age: 33], Cardinality.set')).toEqual([29, 31, 32, 33]);

  const created = new GraphStore(new BunSqlite(':memory:'));
  run(created, 'g.mergeV([(T.label): "person", name: "alice"]).option(Merge.onCreate, [age: Cardinality.set(81)])');
  expect(run(created, 'g.V().has("name","alice").values("age")').map((r) => r.v)).toEqual([81]);
});

test('mergeV option(onCreate) adds props only on the create branch', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  run(store, 'g.mergeV([(T.label): "person", name: "stephen"]).option(Merge.onCreate, [created: "Y"])');
  expect(run(store, 'g.V().has("name","stephen").values("created")').map((r) => r.v)).toEqual(['Y']);
});


test('write-arg value/key from __.select(k) of a withSideEffect constant', () => {
  // property() value on an existing element
  const s1 = new GraphStore(new BunSqlite(':memory:'));
  run(s1, 'g.addV("software").property("name","lop")');
  run(s1, 'g.withSideEffect("a","test").V().hasLabel("software").property("temp",__.select("a"))');
  expect(run(s1, 'g.V().values("temp")').map((r) => r.v)).toEqual(['test']);
  // addV property() value
  const s2 = new GraphStore(new BunSqlite(':memory:'));
  run(s2, 'g.withSideEffect("a","marko").addV().property("name",__.select("a"))');
  expect(run(s2, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
  // property() KEY from a constant
  const s3 = new GraphStore(new BunSqlite(':memory:'));
  run(s3, 'g.withSideEffect("a","name").addV().property(__.select("a"),"marko")');
  expect(run(s3, 'g.V().values("name")').map((r) => r.v)).toEqual(['marko']);
});

test('mergeV accepts a bound Map parameter with EnumValue keys (wire path)', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  // mimic a GraphBinary-deserialized m[{"t[label]":"person","name":"stephen"}]
  const xx1 = new Map<any, any>([[{ typeName: 'T', elementName: 'label' }, 'person'], ['name', 'stephen']]);
  // Through the EXECUTOR rather than by asserting a plan kind: the claim is that a bound Map with
  // EnumValue keys parses and merges, and pinning `kind === 'write'` made it also claim how the merge
  // was lowered — a claim that failed the day mergeV joined the RelIR route and found nothing.
  executeQuery(store, 'g.mergeV(xx1).option(Merge.onCreate, null)', { xx1 });
  const r = compile('g.V().hasLabel("person").has("name","stephen").count()', {});
  if (r.kind !== 'read') throw new Error('want read');
  expect(store.query(r.sql, r.binds).map((x: any) => x.v)).toEqual([1]);
});

test('mergeE creates an edge between existing endpoints, then matches it', () => {
  const store = seededStore(); // marko=1, vadas=2, already knows via edge 7
  // a NEW label between marko and josh(4)
  const c = run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
  // ONE traverser, and the edge it names asserted by READING IT BACK rather than off the write's own
  // row: those columns are a lowering detail, not the answer. The read-back describes the edge in a
  // way that survives however the write is framed.
  expect(c).toHaveLength(1);
  expect(run(store, 'g.V(1).outE("likes").label()').map((r) => r.v)).toEqual(['likes']);
  expect(run(store, 'g.V(1).out("likes").values("name")').map((r) => r.v)).toEqual(['josh']);
  // merging again matches the existing edge → no duplicate
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4])');
  expect(run(store, 'g.V(1).outE("likes").count()').map((r) => r.v)).toEqual([1]);
});

test('mergeE onCreate/onMatch patch edge props on the right branch', () => {
  const store = seededStore();
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
  expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['new']);
  // second merge takes the onMatch branch
  run(store, 'g.mergeE([(T.label): "likes", (Direction.OUT): 1, (Direction.IN): 4]).option(Merge.onCreate, [w: "new"]).option(Merge.onMatch, [w: "old"])');
  expect(run(store, 'g.V(1).outE("likes").values("w")').map((r) => r.v)).toEqual(['old']);
});

test('mergeE raises when an endpoint vertex does not exist', () => {
  const store = seededStore();
  expect(() => run(store, 'g.mergeE([(T.label): "knows", (Direction.OUT): 100, (Direction.IN): 101])'))
    .toThrow(/Vertex does not exist for mergeE/);
});


test('inject(v1,…).mergeV runs once per injected value (arity, not always 1)', () => {
  const store = seededStore(); // 6 vertices
  // 3 injected values → 3 drivers, each match-all matches 6 → 18 results, no creates
  expect(run(store, 'g.inject(1,2,3).mergeV([:])').length).toBe(18);
  expect(run(store, 'g.V().count()').map((r) => r.v)).toEqual([6]);
});
});
