// A PARAMETER'S SIZE IS DATA — so it must never decide whether a traversal runs (root CLAUDE.md, "NEVER
// DECLINE ON DATA SIZE"; "A BIND SERVES A USER PARAMETER").
//
// A client that sends a value as a parameter has told us it is variable. Two walls used to make its SIZE
// decide the answer:
//   - a parameterised property write indexed its FTS text as an INLINED constant (`indexWritten`,
//     src/compiler/rel/write.ts), so the index statement grew one byte per byte of the value. A 100 KB
//     value hit the Durable Object's statement cap in production, and a 400 KB one the compile budget on
//     every runtime — a decline whose message blamed a nesting the one-step write does not have. The text
//     now crosses as the value did: the same parameter (a string's index text IS the string), or a value
//     derived from it under its own reuse key (`ftsTextExpr`).
//   - the compile budget's rendered-bytes charge counted a string constant's payload, so ANY parameter that
//     reaches the text as a constant (a `mergeV($m)` member — the merge decomposes its map at compile time)
//     declined at 400 KB. A constant's payload is data the compile copies, not work it does, so the charge
//     counts it as its quotes (`TextLiteral`, src/sql/kernel/q.ts); statement size stays the store's call.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { CompileBudgetExceeded } from '../../src/sql/kernel/budget.ts';
import type { Executable } from '../../src/sql/kernel/render.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql, CF_MAX_SQL_BYTES } from '../../src/cf-limits.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { executeQuery } from '../support/executor.ts';
import { run } from '../support/harness.ts';

/** Past the DO's 100 KB statement cap AND the compile budget's 400 KB — every wall a size could hit. */
const HUGE = 450_000;
const big = (n: number, tail = ''): string => 'x'.repeat(n - tail.length) + tail;

/** Every statement a compile renders, as `(sql, bind count)`. */
const statements = (plan: Executable): readonly { readonly sql: string; readonly binds: number }[] =>
  plan.kind === 'read'
    ? [{ sql: plan.sql, binds: plan.binds.length }]
    : plan.steps.map((step) => ({ sql: step.emitted.sql, binds: step.emitted.binds.length }));

/** A store seeded with the modern graph that refuses what a Durable Object refuses. */
const doStore = (): GraphStore => {
  const store = new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
  for (const q of MODERN_SEED) executeQuery(store, q, {});
  return store;
};

const ftsTexts = (store: GraphStore, key: string): string[] =>
  store.query<{ text: string }>('SELECT text FROM property_fts WHERE pk = ? ORDER BY rowid', [key]).map((row) => row.text);

describe('a parameterised property write spells the same statements whatever the value\'s size', () => {
  const shapes: readonly [string, (n: number) => Record<string, unknown>][] = [
    ["g.addV('p').property('blob', s)", (n) => ({ s: big(n) })],
    ["g.V().has('name','marko').property('blob', s)", (n) => ({ s: big(n) })],
    ["g.V().property(set, 'blob', s)", (n) => ({ s: big(n) })],
    ["g.addV('p').property(list, 'blob', s, 'note', s)", (n) => ({ s: big(n) })],
    ["g.E().property('blob', s)", (n) => ({ s: big(n) })],
    ["g.V().addE('e').to(__.V().has('name','josh')).property('blob', s)", (n) => ({ s: big(n) })],
    ["g.V().has('name','marko').property(__.constant('blob'), s)", (n) => ({ s: big(n) })],
    // A collection indexes as its `[a, b]` rendering, a value DERIVED from the parameter.
    ["g.addV('p').property('blob', l)", (n) => ({ l: [big(n), 'b'] })],
    ["g.addV('p').property('blob', m)", (n) => ({ m: new Map([['k', big(n)]]) })],
  ];
  for (const [q, params] of shapes) {
    test(q, () => {
      const small = statements(compile(q, params(10)));
      const huge = statements(compile(q, params(HUGE)));
      expect(huge).toEqual(small);
      for (const { sql } of huge) expect(sql.length).toBeLessThan(10_000);
    });
  }
});

describe('a parameterised property write of a value past every statement cap runs, and indexes', () => {
  test('a string: stored and indexed in full, and found by a substring search', () => {
    const store = doStore();
    const s = big(HUGE, 'needle');
    executeQuery(store, "g.V().has('name','marko').property('blob', s)", { s });
    const stored = store.query<{ n: number }>("SELECT length(value) AS n FROM vertex_properties WHERE key = 'blob'");
    expect(stored).toEqual([{ n: HUGE }]);
    expect(ftsTexts(store, 'blob').map((text) => text.length)).toEqual([HUGE]);
    expect(run(store, "g.V().has('blob', containing('needle')).values('name')").map((row: { v: unknown }) => row.v)).toEqual(['marko']);
    expect(store.query<{ n: number }>("SELECT count(*) AS n FROM property_fts WHERE text MATCH 'needle'")).toEqual([{ n: 1 }]);
  });

  test('an edge property, created with the edge', () => {
    const store = doStore();
    executeQuery(store, "g.V().has('name','marko').addE('e').to(__.V().has('name','josh')).property('blob', s)", { s: big(HUGE) });
    expect(ftsTexts(store, 'blob').map((text) => text.length)).toEqual([HUGE]);
  });

  // The DERIVED text: not the parameter's own value, so it binds under its own key rather than sharing
  // the parameter's (the kernel keeps the first value a key is seen with).
  test('a number and a list index as their text', () => {
    const store = doStore();
    executeQuery(store, "g.addV('p').property('n', k).property('l', l)", { k: 3.5, l: ['a', 'brave'] });
    expect(ftsTexts(store, 'n')).toEqual(['3.5']);
    expect(ftsTexts(store, 'l')).toEqual(['[a, brave]']);
  });

  test('one parameter written under two keys indexes both', () => {
    const store = doStore();
    executeQuery(store, "g.addV('p').property('a', s).property('b', s)", { s: 'shared' });
    expect([...ftsTexts(store, 'a'), ...ftsTexts(store, 'b')]).toEqual(['shared', 'shared']);
  });

  test('a PARSED constant still inlines: it is query text, and binds nothing', () => {
    const fts = statements(compile("g.addV('p').property('blob', 'typed')", {})).find(({ sql }) => sql.startsWith('INSERT INTO property_fts'));
    expect(fts?.sql).toContain("'typed'");
  });
});

// A constant's payload is DATA, so the budget never refuses on it. The statement still carries the value
// inline, so a Durable Object refuses it at its own 100 KB cap — the store's call, and a separate
// substrate gap (`mergeV`'s map members as binds), not the compile budget's.
describe('the compile budget never refuses on a value\'s size', () => {
  test('a mergeV map parameter with a member past the budget compiles', () => {
    const m = new Map<string, unknown>([['name', 'zz'], ['blob', big(HUGE)]]);
    expect(() => compile('g.mergeV(m)', { m })).not.toThrow();
    expect(() => compile("g.mergeV([name: 'zz']).option(Merge.onCreate, m)", { m })).not.toThrow();
  });

  test('a typed constant past the budget compiles: its size is the query text\'s, and the store\'s call', () => {
    const plan = compile(`g.addV('p').property('blob', '${big(HUGE)}')`, {});
    expect(Math.max(...statements(plan).map(({ sql }) => sql.length))).toBeGreaterThan(CF_MAX_SQL_BYTES);
  });

  test('an expansion still declines', () => {
    expect(() => compile("g.V().repeat(__.out().order().by('name')).times(800)", {})).toThrow(CompileBudgetExceeded);
  });
});
