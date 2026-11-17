// min()/max() IS ONE ARGMIN AGGREGATE — `arg_min(value, key)` / `arg_max(value, key)` (Calcite's `ARG_MIN`),
// spelled as SQLite's `MIN(key)`/`MAX(key)` with the winner's columns as BARE columns
// (`src/compiler/rel/lower.ts` global min/max reducer, `src/rel/emit.ts` `bareWinner`). Because it is an
// ordinary scalar `Aggregate`, a min/max inside a child body is keyed by its scope with the decorrelator's
// existing Aggregate rule (`src/rel/decorrelate.ts`) — one `GROUP BY`, not a correlated window per host — so
// it composes under every host and at depth.
//
// The semantics it must keep (`vendor/tinkerpop/gremlin-core/.../step/map/MaxGlobalStep.java` + `NumberHelper`):
// ZERO rows emit NOTHING (no seed), an all-null input emits ONE null, null never wins, the winner keeps its
// own class (an Int stays an Int — `typedAll` keeps `3` vs `3.0` apart), and values of different types refuse.
import { describe, expect, test } from 'bun:test';
import { exec } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { bagOf, LADDER, read, seededStore } from '../support/harness.ts';
import { CONNECTOR_ONLY } from '../L9-connector/ladder-reach.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { aggregate, values } from '../../src/rel/factory.ts';
import { col, lit } from '../../src/rel/expr.ts';
import { relId } from '../../src/rel/types.ts';

const MODES = [['connector', CONNECTOR_ONLY], ['default', undefined], ['ladder', { ...DEFAULT_FAST_PATHS, ...LADDER }]] as const;
const typed = (q: string, fastPaths?: FastPathConfig): string[] => bagOf(typedAll(exec(seededStore(), undefined, fastPaths).buffers(q, {})));

const ANSWERS: readonly (readonly [string, readonly string[]])[] = [
  // The witnesses: a per-host min/max under project/map/union/local, the class kept, an empty host dropped.
  ["g.V().project('n','m').by('name').by(outE().values('weight').min())",
    ['{"n":"marko","m":0.4d}', '{"n":"vadas"}', '{"n":"lop"}', '{"n":"josh","m":0.4d}', '{"n":"ripple"}', '{"n":"peter","m":0.2d}']],
  ["g.V().map(outE().values('weight').min()).count()", ['3L']],
  ["g.V().union(map(outE().values('weight').min()), constant(0))", ['0.4d', '0.4d', '0.2d', '0i', '0i', '0i', '0i', '0i', '0i']],
  ["g.V().local(outE().values('weight').max())", ['1d', '1d', '0.2d']],
  ["g.V().map(out().values('age').max())", ['32i']],
  // The root form: ONE null over all-null input, NOTHING over none.
  ['g.inject(null,null).max()', ['null']],
  ["g.V().values('nope').min()", []],
  ["g.V().values('age').min()", ['27i']],
  ["g.V().values('name').max()", ['"vadas"']],
  ['g.inject(9007199254740993L, 1L).max()', ['9007199254740993L']],
  ['g.inject(5, 2.0d).max()', ['5i']],
  ['g.inject(null, 3, null).min()', ['3i']],
  // Deeper: a reducer over a reducer, a branch arm, a predicate body, an order key, a group value, repeat.
  ["g.V().map(out().map(outE().values('weight').max()).min())", ['1d']],
  ["g.V().map(union(out().values('age'), in().values('age')).min())", ['27i', '29i', '29i', '29i', '32i']],
  ["g.V().group().by(label).by(values('age').max())", ['{"person":35i}']],
  ["g.V().where(map(outE().values('weight').max()).is(gt(0.5))).values('name')", ['"marko"', '"josh"']],
  ["g.V().not(map(outE().values('weight').min()).is(lt(0.5))).values('name')", ['"vadas"', '"lop"', '"ripple"']],
  ["g.V().order().by(outE().values('weight').min()).values('name')", ['"peter"', '"marko"', '"josh"']],
  ["g.V().choose(hasLabel('person'), map(outE().values('weight').min()), constant(-1))", ['0.4d', '0.4d', '0.2d', '-1i', '-1i']],
  ["g.V().coalesce(map(outE().values('weight').min()), constant(-1))", ['0.4d', '0.4d', '0.2d', '-1i', '-1i', '-1i']],
  ["g.V().repeat(map(out().values('age').max())).times(1)", ['32i']],
  ["g.V().local(both().values('age').max().is(gt(30)))", ['32i', '35i', '32i']],
  ["g.V().as('a').map(outE().values('weight').min()).as('b').select('a','b').by('name').by()",
    ['{"a":"marko","b":0.4d}', '{"a":"josh","b":0.4d}', '{"a":"peter","b":0.2d}']],
  ["g.V().project('x').by(both().id().min())", ['{"x":2i}', '{"x":1i}', '{"x":1i}', '{"x":1i}', '{"x":4i}', '{"x":3i}']],
  ["g.V().map(label().max())", ['"person"', '"person"', '"software"', '"person"', '"software"', '"person"']],
];

describe('min()/max() answer as one argmin aggregate, at the root and in every body', () => {
  for (const [q, expected] of ANSWERS)
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => expect(typed(q, fastPaths)).toEqual(bagOf(expected)));
});

describe('values of different types refuse, wherever the min/max sits', () => {
  for (const q of ["g.inject(1, 'a').max()", "g.V().local(union(values('age'), constant('x')).max())", "g.V().map(union(values('age'), constant('x')).min()).count()"])
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => expect(() => typed(q, fastPaths)).toThrow('min/max over values of different types is not supported'));
});

describe('the bare-column law is structural', () => {
  const input = values({ id: relId('in'), channels: [], rows: [[lit(1, 'int'), lit(2, 'int')]], type: { cols: [{ name: 'a', type: 'int', nullable: false }, { name: 'b', type: 'int', nullable: false }] } });
  const type = { cols: [{ name: 'x', type: 'any' as const, nullable: true }, { name: 'y', type: 'any' as const, nullable: true }] };
  const argMin = (value: string, key: string) => ({ kind: 'agg', fn: 'arg_min', args: [col(relId('in'), value), col(relId('in'), key)] } as const);
  test('several arg-extrema over ONE key are one min()', () => {
    expect(() => aggregate({ id: relId('ok'), input, channels: [], type, groupBy: [], aggs: [['x', argMin('a', 'b')], ['y', argMin('b', 'b')]] })).not.toThrow();
  });
  test('a second key is refused', () => {
    expect(() => aggregate({ id: relId('two'), input, channels: [], type, groupBy: [], aggs: [['x', argMin('a', 'b')], ['y', argMin('b', 'a')]] }))
      .toThrow('may hold no other min/max');
  });
  test('a plain min() beside an arg-extremum is refused', () => {
    expect(() => aggregate({ id: relId('mix'), input, channels: [], type, groupBy: [], aggs: [['x', argMin('a', 'b')], ['y', { kind: 'agg', fn: 'max', args: [col(relId('in'), 'a')] }]] }))
      .toThrow('may hold no other min/max');
  });
});

// min(local)/max(local) ARE THE SAME AGGREGATE over a list's members (`src/compiler/rel/list.ts`, `argExtremum` in
// `src/compiler/rel/reducer.ts`): the null skip, the empty input, the mixed-class refusal and the exact winner carry
// over from the global form, and `MaxLocalStep`'s later-member tie-break becomes SQLite's (§17). The semantics
// pinned here (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MaxLocalStep.java`):
// a non-empty all-null list emits ONE null, an empty list emits NOTHING, null never wins.
const LOCAL_ANSWERS: readonly (readonly [string, readonly string[]])[] = [
  ["g.V().local(out().values('age').fold().max(local))", ['32i']],
  ["g.V().local(out().values('age').fold().min(local))", ['27i']],
  ['g.inject([1,2.0d,3L]).max(local)', ['3L']],
  ['g.inject([1,2.0d,3L]).min(local)', ['1i']],
  ['g.inject(9007199254740993L, 1L).fold().max(local)', ['9007199254740993L']],
  ['g.inject(9007199254740993L, 10007199254740993L).fold().min(local)', ['9007199254740993L']],
  ['g.inject([null,null]).max(local)', ['null']],
  ['g.inject([]).max(local)', []],
  ['g.inject([1,null,3]).min(local)', ['1i']],
  ["g.V().values('name').fold().min(local)", ['"josh"']],
  // Deeper: a project field, a branch arm, a filter body, a group value, a label, repeat, a list of reduced values.
  ["g.V().project('m').by(out().values('age').fold().max(local))", ['{"m":32i}', '{}', '{}', '{}', '{}', '{}']],
  ["g.V().choose(hasLabel('person'), out().values('age').fold().max(local), constant(-1))", ['32i', '-1i', '-1i']],
  ["g.V().where(values('age').fold().min(local).is(gt(30))).values('name')", ['"josh"', '"peter"']],
  ["g.V().group().by(label).by(values('age').fold().max(local))", ['{"person":35i}']],
  ["g.V().map(outE().values('weight').fold().min(local).is(lt(0.5)))", ['0.4d', '0.4d', '0.2d']],
  ["g.V().as('a').map(out().values('age').fold().max(local)).as('b').select('a','b').by('name').by()", ['{"a":"marko","b":32i}']],
  ["g.V().repeat(map(out().values('age').fold().max(local))).times(1)", ['32i']],
  ["g.V().map(values('age').fold().max(local)).fold().max(local)", ['35i']],
];

describe('min(local)/max(local) answer as the same arg-extremum aggregate, at the root and in every body', () => {
  for (const [q, expected] of LOCAL_ANSWERS)
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => expect(typed(q, fastPaths)).toEqual(bagOf(expected)));
  for (const q of ["g.inject([1,'a']).max(local)", "g.V().local(union(values('age'), constant('x')).fold().max(local))"])
    for (const [mode, fastPaths] of MODES)
      test(`refuses: ${q} (${mode})`, () => expect(() => typed(q, fastPaths)).toThrow('min/max over values of different types is not supported'));
});

// A PER-HOST PICK of a min/max over a stored property is ONE KEYED search (`lower/scoped.ts` `pickKey` over
// `threadingRowKey`, `src/rel/copies.ts`): the winner's property rowid is searched once per host and its value and
// type tag are read back off that row, where the value and the tag were each a correlated scalar re-running the
// whole aggregate (and a third copy tested presence). The search keeps the reducer's own raise and empty-input
// filter, so a mixed-type group still refuses, an empty host still drops, and a wide long comes back exact.
describe('a per-host min/max is searched once, its value and tag read off the winning row', () => {
  const mutated = (q: string, fastPaths?: FastPathConfig): string[] => {
    const store = seededStore();
    const parts = q.split(' ;; ');
    for (const part of parts.slice(0, -1)) exec(store, undefined, fastPaths).buffers(part, {});
    return bagOf(typedAll(exec(store, undefined, fastPaths).buffers(parts.at(-1)!, {})));
  };
  const ANSWERED: readonly (readonly [string, readonly string[]])[] = [
    ["g.V(2).property(single,'age',9007199254740993L) ;; g.V().map(out().values('age').max())", ['9007199254740993L']],
    ["g.V(2).property(single,'age',9007199254740993L) ;; g.V().map(out().values('age').min())", ['32i']],
    ["g.V(2).property(single,'age',9007199254740993L) ;; g.V().project('m').by(out().values('age').max())", ['{"m":9007199254740993L}', '{}', '{}', '{}', '{}', '{}']],
    ["g.V().map(out().values('age').is(gt(28)).max())", ['32i']],
    ["g.V().map(out().values('age').max()).is(gt(30))", ['32i']],
    ["g.V().map(outE().values('weight').max()).fold()", ['[1d,1d,0.2d]']],
  ];
  for (const [q, expected] of ANSWERED)
    for (const [mode, fastPaths] of MODES)
      test(`${q} (${mode})`, () => expect(mutated(q, fastPaths)).toEqual(bagOf(expected)));
  for (const [mode, fastPaths] of MODES)
    test(`refuses a mixed-type group (${mode})`, () =>
      expect(() => mutated("g.V(2).property(single,'age','old') ;; g.V().map(out().values('age').max())", fastPaths))
        .toThrow('min/max over values of different types is not supported'));
  // ONE search: the reducer's class-count raise is spelled once, where the value, the tag and the presence test
  // each spelled it.
  for (const q of ["g.V().map(out().values('age').max())", "g.V().project('n','m').by('name').by(outE().values('weight').min())"])
    test(`one search: ${q}`, () => expect(read(q).sql.split('count(DISTINCT').length - 1).toBe(1));
});
