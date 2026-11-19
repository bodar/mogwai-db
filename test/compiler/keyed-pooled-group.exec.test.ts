// A KEYED `group("a")` WHOSE VALUE `by()` POOLS (`by(count())`, `by(out().count())`, `by(values('name').fold())`)
// is answered by the CONNECTOR: the same per-key pool the barrier form builds (`pooledGroupMap`,
// `src/compiler/rel/lower/scoped.ts` — one decorrelated `Aggregate` grouped by the key's own columns), registered
// under its label through the ONE keyed-group tail the host's own lowering also calls (`keyedGroupTail`,
// `src/compiler/rel/lower.ts`), so registration, drain and re-entry — and their guards — are one authority.
// `GroupSideEffectStep` passes its traversers on, so the stream after the step is the INCOMING one
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/GroupSideEffectStep.java`).
//
// Every case runs with the connector ALONE (`connectorOnly`, no ladder) and the default, and the two give the
// same typed multiset — `typedAll` keeps the number class.
import { describe, expect, test } from 'bun:test';
import { compile, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { exec } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { bagOf, runWith, seededStore } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../../src/cf-limits.ts';
import { loadBulk } from '../../src/bulk.ts';
import { CONNECTOR_ONLY } from '../L9-connector/ladder-reach.ts';
import type { FastPathConfig } from '../../src/compiler/options/fast-paths.ts';

const typed = (q: string, fastPaths?: FastPathConfig): string[] => bagOf(typedAll(exec(seededStore(), undefined, fastPaths).buffers(q, {})));

const SAME: readonly string[] = [
  "g.V().hasLabel('person').group('g').by('name').by(__.out('created').count()).cap('g')",
  "g.V().group('a').by(T.label).by(__.outE().values('weight').sum()).cap('a')",
  "g.V().group('a').by().by(__.out().label().dedup().fold()).cap('a').select(Column.values).unfold().order(Scope.local)",
  "g.V().hasLabel('person').as('p').out('created').group('a').by('name').by(__.select('p').values('age').sum()).cap('a')",
  "g.V().group('m').by(__.label()).by(__.label().count()).cap('m')",
  "g.V().group('a').by(out().count()).by(values('name').fold()).cap('a')",
  "g.V().group('a').by(label).by(out().count()).cap('a').select(Column.values).unfold().sum()",
  // The side effect passes its traversers on: the stream after it is the incoming one, labels and all.
  "g.V().group('a').by(label).by(count()).count()",
  "g.V().as('p').group('a').by(label).by(out().count()).select('p').values('name')",
  "g.V().group('a').by(label).by(count()).out().cap('a')",
  "g.V().group('a').by(label).by(values('name').fold()).where(out()).cap('a')",
  "g.V().group('a').by(label).by(count()).sideEffect(out()).cap('a')",
  // Under a per-traverser host whose body the connector reduces to a stream identity, and after select().
  "g.V().map(group('a').by(label).by(count())).cap('a')",
  "g.V().as('p').out().select('p').group('a').by('name').by(out().count()).cap('a')",
];

describe('a keyed pooled group() is the connector\'s, through the host\'s own keyed tail', () => {
  for (const q of SAME) test(q, () => {
    const connector = typed(q, CONNECTOR_ONLY);
    expect(connector.length).toBeGreaterThan(0);
    expect(connector).toEqual(typed(q));
  });

  test('the pooled map is the one the barrier form builds', () => {
    expect(typed("g.V().group('a').by(label).by(out().count()).cap('a')", CONNECTOR_ONLY))
      .toEqual(typed("g.V().group().by(label).by(out().count())", CONNECTOR_ONLY));
  });

  // The keyed tail's guards hold on the connector route as on the host's own: a program with effects declines, and
  // two sites that are not ONE grouping (different value by()s) have no reduction to share (`accumulate`).
  for (const q of [
    "g.V().group('a').by(label).by(count()).addV('x').cap('a')",
    "g.V().union(group('a').by(label).by(count()), group('a').by(label).by(values('name').fold())).cap('a')",
  ]) test(`declines: ${q}`, () => {
    expect(() => typed(q, CONNECTOR_ONLY)).toThrow(UnsupportedTraversal);
  });
});

// THE POOL IS ITS MEMBERS (`PoolRecipe`, `collection.ts`): each site registers its traversers beside their keys, and
// the reader reduces every site's members ONCE — so a second site (another branch arm, a later position, an unrolled
// repeat) unions its members onto the first, and a site inside a connector body (`where`/`local`/`optional`) is keyed
// per host row like any collector's. Each answer is the reference's, by hand over the modern graph.
describe('a keyed pooled group() pools its members across sites and bodies, reduced once at the reader', () => {
  for (const [q, expected] of [
    // a branch arm, beside a sibling that collects nothing
    ["g.V().union(group('a').by(label).by(count()), out()).cap('a')", '{"person":4L,"software":2L}'],
    ["g.V().choose(has('age'), group('a').by(label).by(count()), out()).cap('a')", '{"person":4L}'],
    ["g.V().optional(group('a').by(label).by(count())).cap('a')", '{"person":4L,"software":2L}'],
    ["g.V().coalesce(group('a').by(label).by(count()), out()).cap('a')", '{"person":4L,"software":2L}'],
    // TWO sites, one grouping: the members of both, pooled per key (V: 4 persons, 2 software; out(): 2 and 4)
    ["g.V().group('a').by(label).by(count()).out().group('a').by(label).by(count()).cap('a')", '{"person":6L,"software":6L}'],
    ["g.V().union(group('a').by(label).by(count()), out().group('a').by(label).by(count())).cap('a')", '{"person":6L,"software":6L}'],
    // the pool is the KEY's, across sites: one dedup over every person member's out()
    ["g.V().union(group('a').by(label).by(out().dedup().count()), out().group('a').by(label).by(out().dedup().count())).cap('a')",
      '{"person":4L,"software":0L}'],
    // a connector body's site, keyed per host row
    ["g.V().where(group('a').by(label).by(count())).cap('a')", '{"person":4L,"software":2L}'],
    ["g.V().local(out().group('a').by(label).by(count())).cap('a')", '{"person":2L,"software":4L}'],
    ["g.V().union(local(out().group('a').by(label).by(count())), optional(in().group('a').by(label).by(count()))).cap('a')",
      '{"person":8L,"software":4L}'],
    // a seeded reducer keeps its seed for a key whose pool reduced to nothing
    ["g.V().where(out().group('a').by(label).by(out().count())).cap('a')", '{"person":2L,"software":0L}'],
    ["g.V().group('a').by(label).by(out('nothing').count()).cap('a')", '{"person":0L,"software":0L}'],
  ] as const) test(q, () => {
    expect(typed(q, CONNECTOR_ONLY)).toEqual([expected]);
    expect(typed(q)).toEqual([expected]);
  });

  test('a list value pools both sites\' members', () => {
    const q = "g.V().union(group('a').by(label).by(values('age').fold()), group('a').by(label).by(values('age').fold())).cap('a')";
    const [map] = typed(q);
    expect(map).toContain('"software":[]');
    expect(map!.match(/\d+i/g)!.sort()).toEqual(['27i', '27i', '29i', '29i', '32i', '32i', '35i', '35i']);
  });

  test('a draw in the value body keeps its named decline, wherever the site is', () => {
    for (const q of [
      "g.V().union(group('a').by(label).by(values('name').sample(1).fold()), out()).cap('a')",
      "g.V().where(group('a').by(label).by(values('name').sample(1).fold())).cap('a')",
    ]) expect(() => typed(q)).toThrow(/a random draw .* inside a group\(\) value by\(\)/);
  });
});

// A pooled keyed group whose map CAN RAISE is evaluated whether or not a `cap` reads it (`CollectingBarrierStep`
// drains every traverser). The drain IS the finished map's binding (`takeFinishedMap`, `collection.ts`): one step
// evaluates it, retained as its ENTRIES (one row per key, so the transport splits it like any retained set), and the
// `cap` re-folds those rows instead of evaluating the map again.
describe('a raising pooled keyed group is evaluated ONCE, and the drain and the cap read that evaluation', () => {
  const steps = (q: string) => {
    const plan = compile(q, {}, undefined);
    if (plan.kind !== 'program') throw new Error(`expected a program for ${q}`);
    return plan.steps.map((step) => step.emitted.sql);
  };

  test('the cap reads the retained map rather than re-grouping', () => {
    const [drain, cap, ...rest] = steps("g.V().group('a').by(label).by(values('age').sum()).cap('a')");
    expect(rest).toEqual([]);
    expect(drain).toContain('json_group_array');
    // The cap reads the graph not at all: only the retained entries, exploded from their transport bind.
    expect(cap).not.toMatch(/\b(nodes|vertex_properties|edges)\b/);
    expect(cap).toContain('json_each(?)');
  });

  // RETAINED AS ITS ENTRIES, one row per key: retained rows are packed at ROW boundaries under a DO's 2 MB value cap,
  // so a map retained as ONE cell would be refused on data size where the plain barrier answers.
  test('the drain retains one row per key, and an empty map stays an empty map', () => {
    const q = "g.V().group('a').by('name').by(values('age').sum()).cap('a')";
    const [drain] = steps(q);
    expect(seededStore().query(drain!, [])).toHaveLength(4);
    expect(typed("g.V().hasLabel('none').group('a').by('name').by(values('age').sum()).cap('a')"))
      .toEqual(typed("g.V().hasLabel('none').group().by('name').by(values('age').sum())"));
  });

  test('a map past one Durable Object value still answers, as the plain barrier does', () => {
    const store = new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
    loadBulk(store, Array.from({ length: 36_000 }, (_, i) => ({
      labels: ['person'], properties: [{ key: 'name', value: `person-number-${i}` }, { key: 'age', value: i % 90, vtype: 'int' as const }],
    })));
    const keyed = runWith(store, "g.V().group('a').by('name').by(values('age').sum()).cap('a')");
    expect(keyed).toEqual(runWith(store, "g.V().group().by('name').by(values('age').sum())"));
  });

  // The map rides as JSON TEXT, each value inside its `{t,v}` envelope, so a Double keeps its class across the
  // transport (`JSON.stringify(2.0)` is `'2'` — a bare number would come back an integer).
  test('a Double keeps its class across the transport', () => {
    expect(typed("g.E().group('a').by(label).by(values('weight').sum()).cap('a')"))
      .toEqual(typed("g.E().group().by(label).by(values('weight').sum())"));
    expect(typed("g.V().group('a').by('name').by(values('age').sum()).cap('a')"))
      .toEqual(typed("g.V().group().by('name').by(values('age').sum())"));
  });

  for (const q of [
    "g.V().group('a').by(label).by(values('name').sum()).cap('a')",
    "g.V().group('a').by(label).by(values('name').sum()).count()",
    "g.V().hasLabel('person').group('a').by('name').by(values('age').math('_/0').sum()).values('name')",
  ]) test(`still raises, read or not: ${q}`, () => {
    expect(() => typed(q)).toThrow();
    expect(() => typed(q)).not.toThrow(UnsupportedTraversal);
  });

  for (const q of [
    "g.V().group('a').by(label).by(values('age').sum()).cap('a').unfold()",
    "g.V().group('a').by(label).by(values('age').sum()).cap('a').select(Column.keys)",
    "g.V().group('a').by(label).by(values('age').sum()).select('a')",
    "g.V().group('a').by(label).by(values('age').sum()).repeat(out()).times(1).cap('a')",
  ]) test(`reads the taken map wherever the collection is read: ${q}`, () => {
    expect(typed(q).length).toBeGreaterThan(0);
  });

  // Inside a connector body: `software` has no age, so its key drops and the map holds one entry — every
  // vertex passes (`test/compiler/collection-read-in-body.exec.test.ts` holds the family).
  test('reads the taken map inside a where() body', () => {
    const q = "g.V().group('a').by(label).by(values('age').sum()).where(select('a').count(local).is(1)).count()";
    expect(typed(q)).toEqual(typed('g.inject(6L)'));
    expect(typed(q, CONNECTOR_ONLY)).toEqual(typed('g.inject(6L)'));
  });
});

// A keyed value that is exactly `count()` is SPLITTABLE (`countsTraversers`, `map.ts`): every site registers
// `groupCount("a")`'s own counting rows — `(key, contribution)`, summed per key at the reader — rather than a member
// pool, whatever the site's position and however many sites the label has. A count has no per-member state, so the
// plan carries no member spool and no first-arrival domain. Answers by hand over the modern graph.
describe('a keyed group() whose value is count() registers the counting rows at every site', () => {
  for (const [q, expected] of [
    ["g.V().union(group('a').by(label).by(count()), group('a').by(label).by(count())).cap('a')", '{"person":8L,"software":4L}'],
    ["g.V().choose(hasLabel('person'), group('a').by('name').by(count()), identity()).cap('a')",
      '{"josh":1L,"marko":1L,"peter":1L,"vadas":1L}'],
    ["g.V().both().group('a').by('name').by(count()).cap('a')",
      '{"josh":3L,"lop":3L,"marko":3L,"peter":1L,"ripple":1L,"vadas":1L}'],
    ["g.V().repeat(out().group('a').by(label).by(count())).times(2).cap('a')", '{"person":2L,"software":6L}'],
    ["g.V().sideEffect(group('a').by(label).by(count())).cap('a')", '{"person":4L,"software":2L}'],
  ] as const) test(q, () => {
    expect(typed(q, CONNECTOR_ONLY)).toEqual([expected]);
    expect(typed(q)).toEqual([expected]);
  });

  test('the keyed count is groupCount\'s map, with no member spool', () => {
    for (const q of [
      "g.V().union(group('a').by(label).by(count()), out()).cap('a')",
      "g.V().group('a').by('name').by(count()).cap('a')",
    ]) {
      const plan = compile(q, {}, undefined);
      if (plan.kind !== 'read') throw new Error(`expected a read for ${q}`);
      expect(plan.sql).not.toContain('%020d');
    }
    expect(typed("g.V().union(group('a').by(label).by(count()), out()).cap('a')"))
      .toEqual(typed("g.V().union(groupCount('a').by(label), out()).cap('a')"));
  });

  // Two steps naming one label are two side-effect operators even where their rows agree, and a count site beside a
  // pooled one shares no reduction: both stay a clean decline.
  for (const q of [
    "g.V().union(group('a').by(label).by(count()), groupCount('a').by(label)).cap('a')",
    "g.V().union(group('a').by(label).by(count()), group('a').by(label).by(out().count())).cap('a')",
  ]) test(`declines: ${q}`, () => {
    expect(() => typed(q, CONNECTOR_ONLY)).toThrow(UnsupportedTraversal);
    expect(() => typed(q)).toThrow(UnsupportedTraversal);
  });
});
