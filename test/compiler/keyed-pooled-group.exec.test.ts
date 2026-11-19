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
import { bagOf, seededStore } from '../support/harness.ts';
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

  // The keyed tail's guards hold on the connector route as on the host's own: a pooled keyed form INSIDE a
  // connector body reduces once per body (`registerGrouping`), a second pooled site on one label has no
  // `(key, contribution)` row to union (`accumulate`), and a program with effects declines.
  for (const q of [
    "g.V().union(group('a').by(label).by(count()), out()).cap('a')",
    "g.V().group('a').by(label).by(count()).out().group('a').by(label).by(count()).cap('a')",
    "g.V().group('a').by(label).by(count()).addV('x').cap('a')",
  ]) test(`declines: ${q}`, () => {
    expect(() => typed(q, CONNECTOR_ONLY)).toThrow(UnsupportedTraversal);
  });
});

// A pooled keyed group whose map CAN RAISE is evaluated whether or not a `cap` reads it (`CollectingBarrierStep`
// drains every traverser). The drain IS the finished map's binding (`takeFinishedMap`, `collection.ts`): one step
// evaluates it, retained as `json(map)`, and the `cap` reads those rows instead of evaluating the map again.
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
    expect(cap).not.toContain('json_group_array');
    expect(cap).toContain('json_each');
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
    "g.V().group('a').by(label).by(values('age').sum()).where(select('a').count(local).is(1)).count()",
  ]) test(`reads the taken map wherever the collection is read: ${q}`, () => {
    expect(typed(q).length).toBeGreaterThan(0);
  });
});
