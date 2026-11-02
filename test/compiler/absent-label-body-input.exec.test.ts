// AN UNBOUND LABEL EMPTIES THE BODY'S INPUT. A label first bound inside a branch arm / `optional()` /
// repeat body is unbound on some rows, and a child body rerooted at it (`select('a')…`) must see NO
// traverser there: `SelectOneStep` emits nothing for a missing key
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java:57-73),
// `TraversalMapStep` drops a traverser whose child yields nothing (step/map/TraversalMapStep.java:52), a
// seeded reducer over the empty input still emits its seed (step/util/ReducingBarrierStep.java:143-148 —
// `count()` 0, `fold()` []), `project()` omits the key and `order().by()` filters (step/map/OrderGlobalStep.java:84).
//
// ONE authority carries it: the rerooted host's `present` (`ChildHost`/`Subject`, `rel/child.ts`), read
// through `hostPresence` by the one self-rooted constructor (`hostSelfRow`) and the expression arms.
// Over the modern graph `g.V().optional(__.out().as('a'))` is 9 rows: 6 bind `a`, 3 (the leaves) do not.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { seededStore, run, bare } from '../support/harness.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const vals = (g: string): any[] => rows(g).map((r) => r.v);
const count = (g: string): number => vals(g)[0];
const sorted = (xs: readonly unknown[]): unknown[] => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const OPT = "g.V().optional(__.out().as('a'))";

describe('a value body over an unbound label produces nothing', () => {
  test('map(select)', () => expect(count(`${OPT}.map(__.select('a')).count()`)).toBe(6));
  test('map(select.label) has no null', () => expect(sorted(vals(`${OPT}.map(__.select('a').label())`)))
    .toEqual(['person', 'person', 'software', 'software', 'software', 'software']));
  test('map(select.id) has no null', () => expect(sorted(vals(`${OPT}.map(__.select('a').id())`))).toEqual([2, 3, 3, 3, 4, 5]));
  test('map(select.constant)', () => expect(count(`${OPT}.map(__.select('a').constant(5)).count()`)).toBe(6));
  test('flatMap(select)', () => expect(count(`${OPT}.flatMap(__.select('a')).count()`)).toBe(6));
  test('flatMap(select.label)', () => expect(count(`${OPT}.flatMap(__.select('a').label()).count()`)).toBe(6));
  test('project().by(select.label) omits the key', () => {
    const maps = rows(`${OPT}.project('x').by(__.select('a').label())`).map((r) => r.map);
    expect(maps).toHaveLength(9);
    expect(maps.filter((m) => m === '[]')).toHaveLength(3);
  });
  test('order().by(select.label) filters', () => expect(count(`${OPT}.order().by(__.select('a').label()).count()`)).toBe(6));
  test('group().by(select.label) has no null key', () => {
    const map = JSON.parse(rows(`${OPT}.group().by(__.select('a').label()).by(__.count())`)[0].map);
    expect(map.map(([k, v]: any) => [k.v, v.v])).toEqual([['person', 2], ['software', 4]]);
  });
  test('a select of a second label past an unbound one', () =>
    expect(count(`${OPT}.as('b').map(__.select('a').select('b')).count()`)).toBe(6));
  test('a mid-chain union arm label', () => {
    expect(count("g.V().has('name','marko').union(__.identity().as('a'), __.out()).map(__.select('a')).count()")).toBe(1);
    expect(vals("g.V().has('name','marko').union(__.identity().as('a'), __.out()).map(__.select('a').label())")).toEqual(['person']);
  });
});

describe('a seeded tail over an unbound label emits its seed', () => {
  const zeros = (g: string) => sorted(vals(g));
  test('map(select.label.count)', () => expect(zeros(`${OPT}.map(__.select('a').label().count())`)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]));
  test('map(select.constant.count)', () => expect(zeros(`${OPT}.map(__.select('a').constant(5).count())`)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1]));
  test('local(select.label.fold)', () => {
    const lists = rows(`${OPT}.local(__.select('a').label().fold())`).map((r) => r.list);
    expect(lists).toHaveLength(9);
    expect(lists.filter((l) => l === '[]')).toHaveLength(3);
    expect(lists).not.toContain('[null]');
  });
  test('map(select.id.fold)', () => expect(rows(`${OPT}.map(__.select('a').id().fold())`).filter((r) => r.list === '[]')).toHaveLength(3));
});

describe('a filter body over an unbound label', () => {
  test('where(select)', () => expect(count(`${OPT}.where(__.select('a')).count()`)).toBe(6));
  test('not(select)', () => expect(count(`${OPT}.not(__.select('a')).count()`)).toBe(3));
  test('where(select.label)', () => expect(count(`${OPT}.where(__.select('a').label()).count()`)).toBe(6));
  test('not(select.label)', () => expect(count(`${OPT}.not(__.select('a').label()).count()`)).toBe(3));
  test('where(select.constant)', () => expect(count(`${OPT}.where(__.select('a').constant(1)).count()`)).toBe(6));
  test('a mid-chain union arm label', () =>
    expect(count("g.V().has('name','marko').union(__.identity().as('a'), __.out()).where(__.select('a')).count()")).toBe(1));
});

describe('non-regressions: a body keyed on the label id was already right', () => {
  test('map(select.out.count)', () => expect(sorted(vals(`${OPT}.map(__.select('a').out().count())`))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]));
  test('where(select.values.count.is(0)) keeps the unbound rows', () =>
    expect(count(`${OPT}.where(__.select('a').values('name').count().is(0)).count()`)).toBe(3));
  test('project().by(select.out.count) is 0 for an unbound label', () => {
    const maps = rows(`${OPT}.project('x').by(__.select('a').out().count())`).map((r) => JSON.parse(r.map)[0][1].v);
    expect(sorted(maps)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
  test('not(select.hasLabel)', () => expect(count(`${OPT}.not(__.select('a').hasLabel('software')).count()`)).toBe(5));
});

describe('a value label bound in a union arm', () => {
  const U = "g.inject(0).union(__.constant(1).as('a'), __.constant(2))";
  test('map(select)', () => expect(count(`${U}.map(__.select('a')).count()`)).toBe(1));
  test('local(select) has no phantom null', () => expect(vals(`${U}.local(__.select('a'))`)).toEqual([1]));
  test('map(select.constant)', () => expect(vals(`${U}.map(__.select('a').constant(5))`)).toEqual([5]));
  test('map(select.math) does not raise on the unbound row', () => expect(vals(`${U}.map(__.select('a').math('_ + 1'))`)).toEqual([2]));
  test('project().by(select.constant) omits the key', () =>
    expect(rows(`${U}.project('x').by(__.select('a').constant(5))`).map((r) => r.map).filter((m) => m === '[]')).toHaveLength(1));
  test('not(select.constant)', () => expect(vals(`${U}.not(__.select('a').constant(1))`)).toEqual([2]));
});

// A RE-SOURCING body (`select('a').V()…`) never reads through the host, so its input is emptied by
// `reSourcedUnder` (`rel/lower/reduction.ts`): a mid-traversal GraphStep emits once per incoming traverser
// (step/map/GraphStep.java), so over an unbound label the body answers what it answers over NOTHING.
describe('a re-sourcing body over an unbound label sees an empty input', () => {
  test('map(select.V.count) is 0 there', () => expect(sorted(vals(`${OPT}.map(__.select('a').V().count())`))).toEqual([0, 0, 0, 6, 6, 6, 6, 6, 6]));
  test('a continuation after the seed computes on it', () =>
    expect(sorted(vals(`${OPT}.map(__.select('a').V().count().math('_+1'))`))).toEqual([1, 1, 1, 7, 7, 7, 7, 7, 7]));
  test('an unseeded tail is nothing', () => expect(count(`${OPT}.map(__.select('a').V().values('name')).count()`)).toBe(6));
  test('local(select.E.count)', () => expect(sorted(vals(`${OPT}.local(__.select('a').E().count())`))).toEqual([0, 0, 0, 6, 6, 6, 6, 6, 6]));
  test('local(select.V.fold).count(local)', () =>
    expect(sorted(vals(`${OPT}.local(__.select('a').V().fold()).count(local)`))).toEqual([0, 0, 0, 6, 6, 6, 6, 6, 6]));
  test('flatMap(select.V) fans out only from bound rows', () => expect(count(`${OPT}.flatMap(__.select('a').V()).count()`)).toBe(36));
  test('project().by(select.V.count) is 0 there', () => {
    const xs = rows(`${OPT}.project('x').by(__.select('a').V().count())`).map((r) => JSON.parse(r.map)[0][1].v);
    expect(sorted(xs)).toEqual([0, 0, 0, 6, 6, 6, 6, 6, 6]);
  });
  test('a statically bound label keeps the plain rooted read', () => {
    const plan = compile("g.V().as('a').out().map(__.select('a').V().count())", {});
    if (plan.kind !== 'read') throw new Error('expected read plan');
    expect(plan.sql).not.toContain('CASE WHEN');
  });
});

// A record built over the possibly-absent label is gated ONCE (`presenceDischarged`): its by()s run under
// that gate, so the presence term is not re-spelled inside the map it already guards.
test('a record over an unbound label spells its presence term once per map', () => {
  const g = `${OPT}.project('x').by(__.select('a').project('y').by(__.constant(1))).select('x').select('y').sum()`;
  expect(vals(g)).toEqual([6]);
  const plan = compile(g, {});
  if (plan.kind !== 'read') throw new Error('expected read plan');
  const presence = plan.sql.match(/json_extract\(\w+\.a0, '\$\[#-1\]\.v'\) AS INT\) IS NOT NULL/g)?.length ?? 0;
  const maps = plan.sql.split("json_object('t', 'string', 'v', 'y')").length - 1;
  expect(maps).toBeGreaterThan(0);
  expect(presence).toBe(maps);
});

describe('a statically bound label owes no presence term', () => {
  for (const g of [
    "g.V().as('a').out().map(__.select('a').label())",
    "g.V().as('a').out().map(__.select('a').constant(5))",
    "g.V().as('a').out().map(__.select('a').constant(5).count())",
  ]) test(g, () => {
    const plan = compile(g, {});
    if (plan.kind !== 'read') throw new Error('expected read plan');
    expect(plan.sql).not.toContain('IS NOT NULL');
    expect(plan.sql).not.toContain('CASE WHEN');
  });
});
