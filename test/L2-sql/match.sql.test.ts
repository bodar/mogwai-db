// L2 — SQL snapshots for match(): the "compile to SQL, never interpret" contract.
//
// match() is a BINDING TABLE threaded through the ordinary fold (src/compiler/rel/match.ts): the root
// label seeds the incoming traverser, each pattern re-roots at its start alias and JOINS its movement
// on, and the end either widens the alias channels (a bind) or adds an equality constraint (a back
// edge). What these snapshots pin is that structure — a join per hop, a constraint per back edge, and
// the bindings MAP at a terminal — not byte identity (see CLAUDE.md "SQL snapshots assert semantic
// equivalence"). The result-shape half is covered by test/compiler tests and L3.
import { test, expect, describe } from 'bun:test';
import { read, run, seededStore } from '../support/harness.ts';

describe('match() SQL', () => {
  // A single binding pattern: one movement joined onto the binding table, emitting the {a,b} map.
  test('single pattern → one join + a two-key bindings map', () => {
    const p = read('g.V().match(__.as("a").out().as("b"))');
    // Terminal match emits the bindings MAP as one map-valued column.
    expect(p.shape).toEqual({ kind: 'mapValue' });
    // The binding table is the root scan; the pattern is a join onto it.
    expect(p.sql).toMatch(/FROM nodes rn[^]*edges/);
    // Both declared variables are projected into the bindings map.
    expect(p.sql).toContain("json_array('a'");
    expect(p.sql).toContain("json_array('b'");
  });

  // A two-pattern chain: two hops, so two edge joins, and the second pattern's start re-roots on the
  // FIRST pattern's bound end — the join order the readiness scheduler produced.
  test('chained patterns → a join per hop', () => {
    const p = read('g.V().match(__.as("a").out("knows").as("b"), __.as("b").out("created").as("c"))');
    expect((p.sql.match(/edges rme\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(p.sql).toContain("json_array('c'");
    // Both hop labels are filtered on the labels table.
    expect(p.sql).toContain("'knows'");
    expect(p.sql).toContain("'created'");
  });

  // A back edge (`as('a')` re-used as an end) is a CONSTRAINT, not a bind: the produced element must
  // equal the already-bound `a`, which lands as a WHERE equality against the root row rather than a
  // new column.
  test('back edge → an equality constraint, not a new binding', () => {
    const p = read('g.V().match(__.as("a").out("created").as("b"), __.as("b").in("created").as("a"))');
    // Two hops (out, in) → two edge joins.
    expect((p.sql.match(/edges rme\d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The map declares only a and b (a is not re-bound to a fresh column by the back edge).
    expect(p.sql).toContain("json_array('a'");
    expect(p.sql).toContain("json_array('b'");
    // The constraint ties the second hop back to the root row — a WHERE comparing to rn.
    expect(p.sql).toMatch(/WHERE[^]*rn\.id/);
  });

  // A no-end pattern (`as('d').has(…)`) binds nothing — it re-roots at the alias and FILTERS, so it
  // adds no column and only narrows the table.
  test('constraint pattern → a re-rooted filter, no new binding', () => {
    const p = read('g.V().match(__.as("d").in("knows").as("a"), __.as("d").has("name","vadas"))');
    // Only d and a are declared (the has() pattern binds nothing).
    expect(p.sql).toContain("json_array('d'");
    expect(p.sql).toContain("json_array('a'");
    expect(p.sql).not.toContain("json_array('c'");
    // The has() lands as a property existence filter, not a join that widens the row.
    expect(p.sql).toContain("'vadas'");
  });

  // A per-row SCALAR end (`values('name').as('b')`) binds a VALUE, not an element — one row per
  // property value, each carrying b as a stored scalar.
  test('per-row scalar end binds a value', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().match(__.as("a").out("knows").values("name").as("b"))') as any[];
    // marko knows vadas + josh → two (a,b) bindings; nobody else has a knows edge.
    expect(rows.length).toBe(2);
  });

  // A reducing-barrier end (`count().as('b')`) binds a PER-ORIGIN reduction with a 0/empty default —
  // through the scalar-child seam, not the row fold, so a vertex with no matching edge binds 0 rather
  // than dropping out.
  test('count() end binds a per-origin count (0 for empty), via the scalar-child seam', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().match(__.as("a").out("knows").count().as("b")).select("b")') as any[];
    // Every vertex is kept: marko's out-knows is 2, everyone else's is 0.
    expect(rows.length).toBe(6);
    const counts = rows.map((r: any) => Number(r.v)).sort((x, y) => x - y);
    expect(counts).toEqual([0, 0, 0, 0, 0, 2]);
  });

  // When the match's start variables are ALREADY bound before it (`V().as('a').out().as('b').match(…)`),
  // it runs in the zero-root regime — the root is not rebound, so the pre-bound values are preserved.
  test('pre-bound start variables (zero-root) are not corrupted', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().as("a").out().as("b").match(__.as("a").out().count().as("c"), __.as("b").in().count().as("c"))') as any[];
    // Only marko(out-degree 3)/lop(in-degree 3) agree on the shared count c.
    expect(rows.length).toBe(1);
  });

  // An inline `where('a', P.neq('c'))` leg is a two-variable THETA clause between bound aliases — a
  // Filter comparing two rowids, binding nothing.
  test('where(key, P.neq(key)) leg compares two bound aliases', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().match(__.where("a", P.neq("c")), __.as("a").out("created").as("b"), __.as("b").in("created").as("c")).select("a", "c")') as any[];
    // The a≠c co-creators of a shared project — 6 ordered pairs among {marko,josh,peter} over lop.
    expect(rows.length).toBe(6);
  });

  // A non-terminal match leaves the pattern variables on the stream as alias channels for a downstream
  // select() to read, rather than materializing the map early.
  test('non-terminal select over match reads the alias channels', () => {
    const store = seededStore();
    const rows = run(store, 'g.V().match(__.as("a").out().as("b")).select("b").by(T.id)') as any[];
    // Six out-edges in the modern graph → six bound b's.
    expect(rows.length).toBe(6);
  });

  // A SINGLE-correlation where(traversal) leg — its body reads only its own start alias — is a
  // correlated EXISTS over that one element (the tested predicate seam), keeping rows the body
  // produces for.
  test('where(traversal) leg reading one alias → a correlated EXISTS (semi)', () => {
    const p = read('g.V().match(__.as("a").out("created").as("b"), __.where(__.as("b").in()))');
    // An existence test, not a negated one — the semi-join keeps rows the body produces for.
    expect(p.sql).toMatch(/(?<!NOT )EXISTS \(SELECT/);
    const rows = run(seededStore(), 'g.V().match(__.as("a").out("created").as("b"), __.where(__.as("b").in())).select("a","b").by("name")') as any[];
    // marko/josh/peter -created-> lop (which has 3 in-edges) and josh -created-> ripple (1 in-edge).
    expect(rows.length).toBe(4);
  });

  // A MULTI-correlation not(traversal) leg — the body constrains a SECOND bound alias — is a
  // multi-column ANTI JOIN: a NOT EXISTS over a FRESH walk (its own source, never a re-derivation of
  // the binding table) correlated back on every alias the leg reads.
  test('not(traversal) leg reading two aliases → a multi-column NOT EXISTS (anti)', () => {
    const p = read('g.V().match(__.as("a").out().as("b"), __.not(__.as("a").out("created").as("b")))');
    expect(p.sql).toMatch(/NOT EXISTS \(SELECT/);
    const rows = run(seededStore(), 'g.V().match(__.as("a").out().as("b"), __.not(__.as("a").out("created").as("b"))).select("a","b").by("name")') as any[];
    // marko's out-neighbours are vadas, josh (knows) and lop (created); excluding the created pair
    // leaves the two knows pairs.
    expect(rows.length).toBe(2);
  });

  // A leg whose `where(P.eq(bound))` sits in the MIDDLE of the body (a step follows it) is correlated
  // just the same — every label constraint at any depth binds the walk's position as a channel. Here
  // `where(P.eq("b"))` is followed by `values("name")`, so it is NOT the trailing end.
  test('mid-body where(P.eq) in a leg correlates at its position, not only at the tail', () => {
    const q = 'g.V().match(__.as("a").out("created").as("b"), __.as("a").out("knows").as("c"), __.where(__.as("c").out("created").where(P.eq("b")).values("name")))';
    const p = read(q);
    // A semi-join existence test — the leg keeps rows the body produces for.
    expect(p.sql).toMatch(/(?<!NOT )EXISTS \(SELECT/);
    const rows = run(seededStore(), q + '.select("a","b","c").by("name")') as any[];
    // a created b, a knows c, c created b (then a name exists). marko-created-lop, marko-knows-josh,
    // josh-created-lop → exactly {a:marko, b:lop, c:josh}.
    expect(rows.length).toBe(1);
    // The terminal bindings map, one row: {a:marko, b:lop, c:josh}.
    const map = (rows[0] as { map: string }).map;
    for (const [k, v] of [['a', 'marko'], ['b', 'lop'], ['c', 'josh']]) expect(map).toContain(`["${k}",{"t":"string","v":"${v}"}]`);
  });
});
