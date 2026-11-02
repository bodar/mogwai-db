// A WHERE/NOT/MATCH LEG BODY SEES THE ROW'S PATH LABELS. A `where(__.select('a')…)` body runs over a
// SPLIT of the outer traverser (`TraversalFilterStep.filter` → `TraversalUtil.test`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TraversalFilterStep.java:62),
// so its path — every `as()` bound before the step — is in scope, and a second `select('b')` in the body
// reads the outer `b` (`SelectOneStep` → `Scoping.getScopeValue`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java).
// The leg route (`match.ts` `legSingle`) used to hand its body to the predicate seam WITHOUT the row's
// aliases, so that select read as unbound: `where` answered 0 and `not` 6. The seam now takes the
// aliases and dispatches through the one entry `filter()` uses (`childPredicate`).
//
// The MULTI-correlation route (`match.ts` `legCorrelated`) walks the body from its anchored start
// SEEDED with the outer labels it reads, so a `where(P.eq('c'))` filters at its OWN position and a
// `limit`/`dedup`/`range` after it slices the constrained stream. It used to lift every label
// constraint to a clause applied AFTER the walk, so a slice ran first: `limit(1)` kept an arbitrary
// in-neighbour and the post-walk equality then dropped half the rows (12 -> 6). Only a body reading the
// whole path (`path()`) still declines — the seed carries labels, not path positions.
import { test, expect, describe } from 'bun:test';
import { seededStore, storeSeededWith, run, bare } from '../support/harness.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { exec } from '../support/executor.ts';

const s = seededStore();
const count = (g: string): number => bare(run(s, g))[0].v;
const BA = "g.V().as('b').out().as('a')"; // 6 rows; every `b` (marko, josh, peter) is a person

describe('a leg body reads the outer row labels', () => {
  test('where(select(a).select(b))', () => expect(count(`${BA}.where(__.select('a').select('b')).count()`)).toBe(6));
  test('not(select(a).select(b))', () => expect(count(`${BA}.not(__.select('a').select('b')).count()`)).toBe(0));
  test('where(select(b).select(b)) — start and read are one label', () =>
    expect(count("g.V().as('b').out().where(__.select('b').select('b')).count()")).toBe(6));
  test('filter() control agrees', () => expect(count(`${BA}.filter(__.select('a').select('b')).count()`)).toBe(6));
  test('a movement after the second select', () =>
    expect(count(`${BA}.where(__.select('a').select('b').out('created')).count()`)).toBe(6));
  test('a filter on the second select', () =>
    expect(count(`${BA}.where(__.select('a').select('b').has('age', P.gt(32))).count()`)).toBe(1));
  test('a nested where inside a where', () =>
    expect(count(`${BA}.where(__.select('a').where(__.select('a').select('b'))).count()`)).toBe(6));
  test('a nested not inside a where', () =>
    expect(count(`${BA}.where(__.select('a').not(__.select('b').hasLabel('software'))).count()`)).toBe(6));
  test('inside a union arm', () =>
    expect(count(`${BA}.union(__.where(__.select('a').select('b')), __.not(__.select('a').select('b'))).count()`)).toBe(6));
  test('inside local()', () => expect(count(`${BA}.local(__.where(__.select('a').select('b'))).count()`)).toBe(6));
  test('a match() where-leg with a second select of a bound label', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c'), __.where(__.as('a').select('b').hasLabel('person'))).count()`)).toBe(12));
  test('a where after match() reads a pre-match label', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c')).where(__.select('c').select('b').has('age', P.gt(30))).count()`)).toBe(7));
});

// BAC: 12 rows (b, a, c ∈ in(a)); c is always an in-neighbour of a, so every leg below that asks for
// one keeps all 12, and its `not` keeps none.
const BAC = `${BA}.in().as('c')`;

describe('a multi-correlation leg filters at its own position, then slices', () => {
  test('limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(12));
  test('dedup().limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup().limit(1)).count()`)).toBe(12));
  test('range after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).range(0, 1)).count()`)).toBe(12));
  test('dedup().by(label) after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup().by(T.label)).count()`)).toBe(12));
  test('order().by().limit after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).order().by('name').limit(1)).count()`)).toBe(12));
  test('not(…limit) is the complement', () =>
    expect(count(`${BAC}.not(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(0));
  test('the unsliced dedup witness', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).dedup()).count()`)).toBe(12));
  test('neq then limit', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.neq('c')).limit(1)).count()`)).toBe(9));
  test('inside local()', () =>
    expect(count(`${BAC}.local(__.where(__.select('a').in().where(P.eq('c')).limit(1))).count()`)).toBe(12));
  test('inside a union arm', () =>
    expect(count(`${BAC}.union(__.where(__.select('a').in().where(P.eq('c')).limit(1)), __.identity()).count()`)).toBe(24));
  test('after match() — the record tail', () =>
    expect(count(`${BA}.match(__.as('a').in().as('c')).where(__.select('a').in().where(P.eq('c')).limit(1)).count()`)).toBe(12));
});

describe('a multi-correlation leg reads outer labels after the correlation', () => {
  test('select(b) after the label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).select('b')).count()`)).toBe(12));
  test('a filter on that select', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).select('b').has('age', P.gt(30))).count()`)).toBe(7));
  test('a second positional label filter', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).where(P.eq('b'))).count()`)).toBe(6));
  test('a where-theta over two outer labels', () =>
    expect(count(`${BAC}.where(__.select('a').in().where(P.eq('c')).where('c', P.eq('b'))).count()`)).toBe(6));
  test('Pop.first/all over a rebound outer label keep its history', () => {
    const AA = "g.V().as('a').out().as('a').in().as('c')";
    expect(count(`${AA}.where(__.select('a').in().where(P.eq('c')).select(Pop.first, 'a').hasLabel('person')).count()`)).toBe(12);
    expect(count(`${AA}.where(__.select('a').in().where(P.eq('c')).select(Pop.all, 'a').count(Scope.local).is(2)).count()`)).toBe(12);
  });
  test('a repeat body then an outer select', () =>
    expect(count(`${BA}.where(__.select('a').repeat(__.out()).times(1).select('b')).count()`)).toBe(1)); // only a=josh moves on
  test('a body reading the whole path still declines', () =>
    expect(() => run(s, `${BAC}.where(__.select('a').in().where(P.eq('c')).path()).count()`)).toThrow(UnsupportedTraversal));
  test('a multi-correlation leg reading only its correlated labels still answers', () =>
    expect(count("g.V().as('a').out().as('b').match(__.as('a').out().as('b'), __.where(__.as('a').out('knows').as('b'))).count()")).toBe(2));
});

// A VALUE TRAVERSER'S BARE `where(P.eq(label))` — `WherePredicateStep` with no start key compares the
// traverser itself against the label (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java`),
// so over `values(…)` the subject is a typed SCALAR. `bareAliasWhere` (`src/compiler/rel/lower.ts`) takes
// it with the value leaf: `typedValueEq` for eq/neq (so `true` is not `1` and `30` is `30.0`),
// `comparableTheta` for an ordering (same bucket, else false), and a scalar against an ELEMENT label folds
// at compile time (`neq` true, everything else false — a String is never a Vertex). `P.not` is pushed INTO
// the op (`Compare.negate`), so a cross-bucket ordering stays false under it.
const names = (g: string): string[] => bare(run(s, g)).map((r: { v: string }) => r.v).sort();

describe('a value traverser compares against a label', () => {
  test('in a leg, against a value label', () =>
    expect(count("g.V().as('b').values('name').as('n').select('b').out().as('a').where(__.select('a').in().values('name').where(P.eq('n'))).count()")).toBe(6));
  test('in a leg, a computed double against an int label (29.0 = 29)', () =>
    expect(count("g.V().as('b').values('age').as('n').select('b').out().as('a').where(__.select('a').in().values('age').math('_ + 0').where(P.eq('n'))).count()")).toBe(6));
  test('in a leg, against an element label — never equal', () =>
    expect(count(`${BA}.where(__.select('a').in().values('name').where(P.eq('b'))).count()`)).toBe(0));
  test('at top level', () =>
    expect(names("g.V().as('a').values('name').as('n').select('a').out().as('b').in().values('name').where(P.eq('n'))"))
      .toEqual(['josh', 'josh', 'marko', 'marko', 'marko', 'peter']));
  test('a String against a Vertex label is []', () =>
    expect(bare(run(s, "g.V(1).as('x').values('name').where(P.eq('x'))"))).toEqual([]));
  test('neq against a Vertex label keeps it', () =>
    expect(names("g.V(1).as('x').values('name').where(P.not(P.eq('x')))")).toEqual(['marko']));
  test('not(ordering) across buckets stays false', () => {
    expect(bare(run(s, "g.V(1).as('x').values('name').where(P.not(P.lt('x')))"))).toEqual([]);
    expect(bare(run(s, "g.V(1).values('age').as('a').constant('x').where(P.not(P.gt('a')))"))).toEqual([]);
    expect(bare(run(s, "g.V(1).values('age').as('a').constant('x').where(P.not(P.lte('a').or(P.eq('a'))))"))).toEqual([]);
  });
  test('a boolean is not an int', () => {
    expect(bare(run(s, "g.inject(true).as('i').constant(1).where(P.eq('i'))"))).toEqual([]);
    expect(bare(run(s, "g.inject(true).as('i').constant(1).where(P.neq('i'))"))).toEqual([{ v: 1 }]);
  });
  test('an int equals the same double', () =>
    expect(bare(run(s, "g.V(1).values('age').as('a').math('_ + 1.0').math('_ - 1').where(P.eq('a'))")).map((r: { v: number }) => r.v)).toEqual([29]));
  test('an ordering within one bucket', () =>
    expect(count("g.V().values('age').as('a').V().values('age').where(P.gt('a')).count()")).toBe(6));
  test('a label unbound on the row drops it, even for a folded neq', () =>
    expect(count("g.V().as('a').optional(__.out().as('o')).values('name').where(P.neq('o')).count()")).toBe(6));
  test('inside a union arm', () =>
    expect(count("g.V().as('a').values('name').as('n').select('a').union(__.out().values('name').where(P.lt('n')), __.in().values('name').where(P.gt('n'))).count()")).toBe(6));
  test('inside a repeat body inside a where', () =>
    expect(count("g.V().as('a').values('name').as('n').select('a').where(__.repeat(__.out()).times(1).values('name').where(P.lt('n'))).count()")).toBe(2));
  test('inside flatMap', () =>
    expect(names("g.V().as('a').values('name').as('n').select('a').flatMap(__.out().values('name').where(P.lt('n')))")).toEqual(['josh', 'lop', 'lop']));
  test('a by()-modulated label compare in a leg declines (unbuilt), never a wrong count', () =>
    expect(() => run(s, `${BAC}.where(__.select('a').in().where(P.eq('c')).by(T.label)).count()`)).toThrow(UnsupportedTraversal));
});

// An UNKNOWN-typed side (an untagged `inject`, a `select` of an untagged label) is typed by the value's own
// inference — the framer's — so it is never SQLite's raw `=`, which calls `true` equal to `1`
// (`GremlinValueComparator`: Boolean and Integer are different comparability types).
describe('an untyped side is typed by its value', () => {
  const rows = (g: string) => bare(run(s, g)).map((r: { v: unknown }) => r.v);
  test('a boolean against an untyped int label', () => {
    expect(rows("g.inject(1).as('a').constant(true).where(P.eq('a'))")).toEqual([]);
    expect(rows("g.inject([1]).unfold().as('a').constant(true).where(P.eq('a'))")).toEqual([]);
    expect(rows("g.inject([0]).unfold().as('a').constant(false).where(P.eq('a'))")).toEqual([]);
    expect(rows("g.inject(1).as('a').constant(true).where(P.neq('a'))")).toEqual([1]);
    expect(rows("g.inject(1).as('a').constant(true).where(P.not(P.eq('a')))")).toEqual([1]);
  });
  test('a projected boolean against an untyped int label', () => {
    const K = "g.inject(1).as('i').V(1).project('k').by(__.constant(true)).select('k')";
    expect(rows(`${K}.where(P.eq('i'))`)).toEqual([]);
    expect(rows(`${K}.where(P.neq('i'))`)).toEqual([1]);
    expect(count("g.inject(1).as('i').V().project('k').by(__.constant(true)).select('k').where(P.eq('i')).count()")).toBe(0);
    // the untyped side as the subject, the boolean as the label
    expect(rows(`${K}.as('j').select('i').where(P.eq('j'))`)).toEqual([]);
  });
  test('an untyped int against an untyped int, and orderings', () => {
    expect(rows("g.inject(1).as('i').V(1).project('k').by(__.constant(1)).select('k').where(P.eq('i'))")).toEqual([1]);
    expect(rows("g.inject(2).as('a').select('a').where(P.lt('a'))")).toEqual([]);
    expect(rows("g.inject(2).as('a').select('a').where(P.lte('a'))")).toEqual([2]);
    expect(rows("g.inject('x').as('a').constant(1).where(P.not(P.lt('a')))")).toEqual([]);
  });
  test('two value labels, boolean vs int and int vs double', () => {
    expect(count("g.inject(true).as('a').constant(1).as('b').V(1).where('a', P.eq('b')).count()")).toBe(0);
    expect(count("g.inject(1).as('a').constant(1.0).as('b').V(1).where('a', P.eq('b')).count()")).toBe(1);
  });
});

// NULL is a value: comparable to null alone (`GremlinValueComparator.comparable`), so `eq`/`lte`/`gte` hold
// iff both are null, `neq` iff not both, `lt`/`gt` never — never SQL's unknown, which drops the row.
describe('a null value or label', () => {
  const rows = (g: string) => bare(run(s, g)).map((r: { v: unknown }) => r.v);
  test('eq / neq', () => {
    expect(rows("g.inject(null).as('a').constant(null).where(P.eq('a'))")).toEqual([null]);
    expect(rows("g.inject(1).as('a').constant(null).where(P.neq('a'))")).toEqual([null]);
    expect(rows("g.inject(null).as('a').constant(1).where(P.not(P.eq('a')))")).toEqual([1]);
    expect(rows("g.inject('x').as('a').constant(null).where(P.eq('a'))")).toEqual([]);
  });
  test('a null label never loses a neq row', () => {
    expect(rows("g.inject(null, 1).as('a').V(1).values('age').where(P.neq('a'))")).toEqual([29, 29]);
    expect(rows("g.inject(null, 1).as('a').V(1).values('age').where(P.eq('a'))")).toEqual([]);
  });
  test('orderings: null against null is compare 0', () => {
    expect(rows("g.inject(null).as('a').constant(null).where(P.lte('a'))")).toEqual([null]);
    expect(rows("g.inject(null).as('a').constant(null).where(P.lt('a'))")).toEqual([]);
    expect(rows("g.inject(null).as('a').constant(null).where(P.not(P.lt('a')))")).toEqual([null]);
    expect(rows("g.inject(null).as('a').constant(1).where(P.not(P.lt('a')))")).toEqual([]);
  });
  test('two value labels', () => {
    expect(count("g.inject(1).as('a').constant(null).as('b').V(1).where('a', P.neq('b')).count()")).toBe(1);
    expect(count("g.inject(null).as('a').constant(null).as('b').V(1).where('a', P.eq('b')).count()")).toBe(1);
  });
});

describe('two value labels compare by type', () => {
  // (age 29 → 27), (29 → 32): marko is the only aged vertex with aged out-neighbours.
  const VW = "g.V().has('age').as('v').values('age').as('a').select('v').out().has('age').as('w').values('age').as('b').select('w')";
  test('lt', () => expect(count(`${VW}.where('a', P.lt('b')).count()`)).toBe(1));
  test('not(lt) is gte', () => expect(count(`${VW}.where('a', P.not(P.lt('b'))).count()`)).toBe(1));
  test('a connective', () => expect(count(`${VW}.where('a', P.eq('b').or(P.gt('b'))).count()`)).toBe(1));
  test('neq', () => expect(count(`${VW}.where('a', P.neq('b')).count()`)).toBe(2));
  test('a value label against an element label', () =>
    expect(count("g.V().has('age').as('v').values('name').as('a').select('v').where('a', P.eq('v')).count()")).toBe(0));
});

describe('a movement-headed where body reads the outer labels', () => {
  test('where(in().where(P.eq(a))) answers as its select(b) twin', () => {
    expect(count("g.V().as('a').out().as('b').where(__.in().where(P.eq('a'))).count()")).toBe(6);
    expect(count("g.V().as('a').out().as('b').where(__.select('b').in().where(P.eq('a'))).count()")).toBe(6);
  });
});

// A SELF-LOOP + PARALLEL-EDGE graph: x→y twice, x→x, y→y. Multiplicity is what a correlated EXISTS or a
// seeded leg could lose; every expectation below is counted by hand off the four edges.
describe('multiplicity over self-loops and parallel edges', () => {
  const loops = storeSeededWith([
    "g.addV('n').property('name','x').as('x').addV('n').property('name','y').as('y').addE('e').from('x').to('y').addE('e').from('x').to('y').addE('e').from('x').to('x').addE('e').from('y').to('y')",
  ]);
  const at = (g: string): number => bare(run(loops, g))[0].v;
  const LBAC = "g.V().as('b').out().as('a').in().as('c')"; // 10 rows
  test('the base', () => expect(at(`${LBAC}.count()`)).toBe(10));
  test('b reaches a exactly twice', () =>
    expect(at(`${LBAC}.where(__.select('b').out().where(P.eq('a')).count().is(2)).count()`)).toBe(6));
  test('a value label in a leg', () =>
    expect(at("g.V().as('b').values('name').as('n').select('b').out().as('a').where(__.select('a').in().values('name').where(P.eq('n'))).count()")).toBe(4));
  test('a movement-headed body counting its label matches', () =>
    expect(at("g.V().as('b').out().as('a').where(__.in().where(P.eq('b')).count().is(2)).count()")).toBe(2));
});

// AN UNTYPED PARAMETER IS TYPED BY ITS VALUE. The JSON request channel (and an Executor caller passing no
// types) declares no parameter type, and an untyped JS `true` reached SQLite as the INTEGER `1`, so every
// reader downstream saw an Integer and ordered it against the ages: `{x: true}` counted 4. The compile seam
// now completes the parameter types from the JS value (`declaredParamTypes`), so a Boolean label answers as
// the literal `inject(true)` does — `GremlinValueComparator` never orders a Boolean against a Number
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java).
describe('an untyped (JSON-channel) parameter label', () => {
  const ex = exec(s);
  const json = async (g: string, params: Record<string, unknown>) =>
    JSON.parse(await ex.jsonAsync(g, params)).map((v: any) => v?.['@value'] ?? v);
  const AGE = "g.inject(x).as('a').V()";
  test('a Boolean is never ordered against a Number', async () => {
    for (const x of [true, false]) {
      const literal = await json(`g.inject(${x}).as('a').V().values('age').where(P.gte('a')).count()`, {});
      expect(await json(`${AGE}.values('age').where(P.gte('a')).count()`, { x })).toEqual(literal);
      expect(literal).toEqual([0]);
    }
    expect(await json(`${AGE}.local(__.values('age').where(P.gte('a'))).count()`, { x: true })).toEqual([0]);
    expect(await json(`${AGE}.as('v').values('age').where(P.gt('a')).select('v').values('name')`, { x: true })).toEqual([]);
  });
  test('a Boolean does not equal 1', async () =>
    expect(await json("g.inject(x).as('a').constant(1).where(P.eq('a'))", { x: true })).toEqual([]));
  test('numbers and strings still compare', async () => {
    expect(await json(`${AGE}.values('age').where(P.gte('a')).count()`, { x: 30 })).toEqual([2]);
    expect(await json(`${AGE}.values('age').where(P.eq('a')).count()`, { x: 29 })).toEqual([1]);
    expect(await json(`${AGE}.values('name').where(P.eq('a'))`, { x: 'josh' })).toEqual(['josh']);
  });
});
