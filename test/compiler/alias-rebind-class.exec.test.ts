// A REBOUND LABEL KEEPS EVERY ENTRY'S OWN CLASS — the label history's ONE type authority is each entry's
// recorded `t` (`objectEntry`, src/compiler/rel/history.ts), never the class of whichever binding came last.
//
// `select(Pop.first/all/mixed, 'a')` reads the bound OBJECTS back off the path unchanged
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java
// via `Scoping.getScopeValue` → `Path.get(Pop, label)`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ImmutablePath.java).
// A rebind (`as('a')…as('a')`) used to OVERWRITE the label's single compile-time class with the last
// binding's, and a branch merge kept the INCOMING one, so a Double came back an Integer (`[3i]`), a
// String a `0`, and a String or a wide Long framed as a Long/Int raised an internal SyntaxError/RangeError.
// Both now go through ONE join (`joinAliasEntry`, src/compiler/alias.ts): a disagreeing class becomes
// the per-entry tag every reader honours.
import { test, expect, describe } from 'bun:test';
import { bagOf, seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';

const store = seededStore();
// One vertex holding the four numeric classes at the same value, so a class read wrongly collides.
executeQuery(store, "g.addV('n').property('f',3.0f).property('d',3.0d).property('i',3).property('l',3L)", {});
const typed = (q: string) => typedAll(executeQuery(store, q, {}));
const declines = (q: string): string => {
  try { typed(q); } catch (error) { return (error as Error).constructor.name; }
  return 'answered';
};

const FOUR = "g.V().hasLabel('n').values('f','d','i','l').as('a')";

describe('select(first/all/mixed) over a rebound label reads each entry by its own class', () => {
  test('a scalar of one class rebound to another', () => {
    const cases: [string, string[]][] = [
      ["g.inject(3.5d).as('a').constant(1).as('a').select(first,'a')", ['3.5d']],
      ["g.inject(3.5f).as('a').constant(1).as('a').select(first,'a')", ['3.5f']],
      ["g.inject('x').as('a').constant(3).as('a').select(first,'a')", ['"x"']],
      ["g.inject(true).as('a').constant(1).as('a').select(first,'a')", ['true']],
      ["g.inject(1).as('a').constant(true).as('a').select(all,'a')", ['[1i,true]']],
      ["g.inject(3L).as('a').constant('x').as('a').select(all,'a')", ['[3L,"x"]']],
      ["g.inject(5).as('a').constant(3L).as('a').select(all,'a')", ['[5i,3L]']],
      ["g.inject(3L).as('a').constant(1).as('a').select(first,'a')", ['3L']],
      ["g.inject(3L).as('a').constant(1).as('a').select(mixed,'a')", ['[3L,1i]']],
      ["g.inject(3L).as('a').constant(1).as('a').select(last,'a')", ['1i']],
      ["g.V().hasLabel('n').values('f').as('a').constant(1.5d).as('a').select(first,'a')", ['3f']],
      // Agreeing classes keep their single static description.
      ["g.inject(3L).as('a').constant(1L).as('a').select(all,'a')", ['[3L,1L]']],
      ["g.inject(3).as('a').constant(1).as('a').select(first,'a')", ['3i']],
    ];
    for (const [q, want] of cases) expect(typed(q), q).toEqual(want);
  });

  test('no internal error frames a String, a wide Long or a Date by another entry\'s class', () => {
    expect(typed("g.inject('x').as('a').constant(3L).as('a').select(all,'a')")).toEqual(['["x",3L]']);
    expect(typed(`${FOUR}.constant(5L).as('a').select(all,'a').fold()`)).toEqual(['[[3f,5L],[3d,5L],[3i,5L],[3L,5L]]']);
    expect(typed("g.inject(9007199254740993L).as('a').constant(1).as('a').select(first,'a')")).toEqual(['9007199254740993L']);
    expect(typed("g.inject(9007199254740993L).as('a').constant(1).as('a').select(all,'a')")).toEqual(['[9007199254740993L,1i]']);
    const date = executeQuery(store, "g.inject(datetime('2020-01-01T00:00:00Z')).as('a').constant(1).as('a').select(first,'a')", {});
    expect(date.length).toBe(1);
  });

  test('a per-row stream rebound to a constant keeps every row\'s class', () => {
    expect(typed(`${FOUR}.constant(1).as('a').select(first,'a').fold()`)).toEqual(['[3f,3d,3i,3L]']);
    expect(bagOf(typed(`${FOUR}.constant(1).as('a').select(all,'a')`))).toEqual(bagOf(['[3f,1i]', '[3d,1i]', '[3i,1i]', '[3L,1i]']));
  });
});

describe('every reader of a rebound label agrees — by(), keys, dedup, at depth', () => {
  test('the Long survives inside project/union/map/choose/by()', () => {
    for (const q of [
      "g.inject(3L).as('a').constant(1).as('a').union(select(first,'a'))",
      "g.inject(3L).as('a').constant(1).as('a').map(select(first,'a'))",
      "g.inject(3L).as('a').constant(1).as('a').choose(constant(true),select(first,'a'),constant(0))",
      "g.inject(3L).as('a').constant(1).as('a').select(first,'a').by(identity())",
    ]) expect(typed(q), q).toEqual(['3L']);
    expect(typed("g.inject(3L).as('a').constant(1).as('a').project('x').by(select(first,'a'))")).toEqual(['{"x":3L}']);
    expect(typed("g.inject(3L).as('a').constant(1).as('a').groupCount().by(select(first,'a'))")).toEqual(['{3L:1L}']);
  });

  test('equal numbers of every class are one key (value plus family), framed as one of them', () => {
    expect(typed(`${FOUR}.constant(1).as('a').groupCount().by(select(first,'a'))`)).toEqual(['{3d:4L}']);
    expect(typed(`${FOUR}.constant(1).as('a').dedup().by(select(first,'a')).count()`)).toEqual(['1L']);
    expect(typed(`${FOUR}.constant(1).as('a').select(first,'a').dedup().count()`)).toEqual(['1L']);
    expect(typed(`${FOUR}.constant(1).as('a').select(all,'a').dedup().count()`)).toEqual(['4L']);
    expect(typed(`${FOUR}.constant(1).as('a').select(all,'a').unfold().dedup().count()`)).toEqual(['2L']);
    expect(typed(`${FOUR}.constant(1).as('a').order().by(select(first,'a')).select(first,'a').fold()`)).toEqual(['[3f,3d,3i,3L]']);
  });
});

describe('a branch merge joins every arm\'s description — BranchStep.java:123-153', () => {
  test('an incoming label an arm rebinds is framed per entry', () => {
    expect(typed("g.inject(3L).as('a').union(constant(1).as('a'), constant(2L).as('a')).select(all,'a')")).toEqual(['[3L,1i]', '[3L,2L]']);
    expect(typed("g.inject(3L).as('a').union(constant(1).as('a'), constant(2L).as('a')).select(last,'a')")).toEqual(['1i', '2L']);
    expect(typed("g.inject(3L).as('a').union(constant(1).as('a'), identity()).select(all,'a')")).toEqual(['[3L,1i]', '[3L]']);
    expect(typed("g.inject(3L).as('a').choose(constant(true), constant(1).as('a'), constant(2)).select(all,'a')")).toEqual(['[3L,1i]']);
    expect(typed("g.inject(3L).as('a').union(constant(1).as('a')).select(mixed,'a')")).toEqual(['[3L,1i]']);
  });

  test('a label first bound in arms that disagree on class', () => {
    expect(typed("g.inject(4).union(constant(1).as('a'), constant(2L).as('a')).select(last,'a')")).toEqual(['1i', '2L']);
    expect(typed("g.inject(4).union(constant(1).as('a'), constant(2L).as('a')).select(all,'a')")).toEqual(['[1i]', '[2L]']);
  });

  test('a history whose LENGTH an arm decides is not read as one entry by Pop.mixed — it declines', () => {
    // One arm rebinds, the other does not: Pop.mixed is a list on one traverser and a scalar on the
    // other, which no single wire shape here answers.
    expect(declines("g.inject(3L).as('a').union(constant(1).as('a'), identity()).select(mixed,'a')")).toBe('UnsupportedTraversal');
    expect(declines("g.inject(4).union(constant(1).as('a'), identity()).constant(2).as('a').select(mixed,'a')")).toBe('UnsupportedTraversal');
    expect(typed("g.inject(4).union(constant(1).as('a'), identity()).constant(2).as('a').select(all,'a')")).toEqual(['[1i,2i]', '[2i]']);
  });
});
