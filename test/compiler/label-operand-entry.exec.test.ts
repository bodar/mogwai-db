// A VALUE LABEL AS A PREDICATE OPERAND READS ITS HISTORY ENTRY ONCE — `has(k, gt(select('e')))`.
//
// A per-row-typed value label's value and its type tag are two fields of ONE history entry (`{k, v, t}`). The
// producer that knows the label's column and end hands that entry on (`aliasEntryAt`, src/compiler/rel/alias.ts):
// `aliasOperandAt` puts it on the operand, and `selectRerootHost` puts it on the scalar host, so a bare
// `select('e')` body yields it as `ChildValue.labelEntry`. The comparison binds it once as the one row of a
// `VALUES` and reads `$.v`/`$.t` off it (`overOperand`, src/compiler/rel/predicate.ts). No consumer recognises the
// entry back out of a `json_extract(…, '$[#-1].v')` read any more.
//
// The semantics are TinkerPop's `P.gt(Traversal)`: the operand is the traversal's FIRST result over the current
// traverser (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/P.java`
// `resolve`), here the label's value; a cross-type ordering is false, never SQLite's storage-class order
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java`).
import { describe, expect, test } from 'bun:test';
import { bagOf, bare, read, run, seededStore, storeSeededWith } from '../support/harness.ts';

const values = (s: ReturnType<typeof seededStore>, g: string): unknown[] => bagOf(bare(run(s, g)).map((row: { v: unknown }) => row.v));

describe('a value label operand binds its history entry once', () => {
  const GT = "g.V().values('age').as('e').V().has('age', gt(select('e'))).count()";

  test('the operand reads the whole entry, never its fields apart', () => {
    const sql = read(GT).sql;
    expect(sql).toContain("'$[#-1]')");
    // The operand's value and tag are read off the bound entry, not walked out of the history per field.
    expect(sql).not.toContain("'$[#-1].v'");
    expect(sql).toContain("'$.v'");
  });

  test('the range compare keeps its (key, value) seek', () => {
    const plan = read(GT);
    const store = seededStore();
    const detail = store.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${plan.sql}`, plan.binds).map((r) => r.detail).join('\n');
    expect(detail).toMatch(/\(key=\? AND value>\?\)/);
  });
});

describe('the answers, at depth', () => {
  const s = seededStore();
  // ages: marko 29, vadas 27, josh 32, peter 35.
  test.each<[string, string, unknown[]]>([
    ['root', "g.V().values('age').as('e').V().has('age', gt(select('e'))).count()", [6]],
    ['eq', "g.V().values('age').as('e').V().has('age', select('e')).count()", [4]],
    ['within', "g.V().values('age').as('e').V().has('age', within(select('e'))).count()", [4]],
    ['not()', "g.V().values('age').as('e').V().not(has('age', gt(select('e')))).count()", [18]],
    ['optional()', "g.V().values('age').as('e').V().optional(has('age', gte(select('e')))).count()", [24]],
    ['map()', "g.V().values('age').as('e').map(V().has('age', lt(select('e'))).count())", [1, 0, 2, 3]],
    ['Pop.first', "g.V().values('age').as('e').V().has('age', gt(select(first, 'e'))).count()", [6]],
    ['after select() of an element label', "g.V().as('v').values('age').as('e').select('v').out().has('age', gt(select('e'))).values('name')", ['josh']],
    ['a label bound in one union() arm', "g.V().union(values('age').as('e'), constant(1)).V().has('age', gt(select('e'))).count()", [6]],
    // An untagged injected `30` records a NULL `t`: the comparability guard reads the value's own type there,
    // so 30 still orders against the stored ints (it dropped every row before), and `'x'` never does.
    ['a mixed-type inject: a string never orders against a number', "g.inject(1.5d, 30, 'x').as('e').V().has('age', gt(select('e'))).count()", [6]],
    ['an untagged int beside a double', "g.inject(29.0d, 29).as('e').V().has('age', gte(select('e'))).values('name')", ['marko', 'josh', 'peter', 'marko', 'josh', 'peter']],
  ])('%s', (_name, g, expected) => expect(values(s, g)).toEqual(bagOf(expected)));

  test('local() folds each label its own matches', () =>
    expect(bare(run(s, "g.V().values('age').as('e').local(V().has('age', lt(select('e'))).values('name').fold())")).map((r: { list: string }) => bagOf(JSON.parse(r.list))))
      .toEqual(expect.arrayContaining([['vadas'], [], bagOf(['marko', 'vadas']), bagOf(['josh', 'marko', 'vadas'])])));

  test('a string label orders strings', () => {
    const t = storeSeededWith([
      "g.addV('x').property('k','e').property('s','b')",
      "g.addV('x').property('k','b').property('s','c')",
      "g.addV('x').property('k','c').property('s','d')",
    ]);
    expect(values(t, "g.V().has('k','e').values('s').as('x').V().has('s', P.gt(__.select('x'))).values('k')")).toEqual(bagOf(['b', 'c']));
  });

  test('a double keeps the spelling its as() site wrote: it meets itself', () => {
    const t = storeSeededWith(["g.addV('x').property('d', 0.30000000000000004d)", "g.addV('x').property('d', 0.3d)"]);
    expect(values(t, "g.V().values('d').as('e').V().has('d', select('e')).count()")).toEqual([2]);
    expect(values(t, "g.V().values('d').as('e').V().has('d', gt(select('e'))).count()")).toEqual([1]);
  });
});
