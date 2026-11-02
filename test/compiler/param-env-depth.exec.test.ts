// A user PARAMETER keeps its DECLARED type at every depth a nested body is re-parsed from.
//
// The type of a bound parameter is settled once, at the top of the compile (`paramEnv` →
// `declaredParamTypes`), and travels INSIDE the parameter environment (`ParamEnv`). Before that, the
// front end took the types as a parallel, optional argument beside the values, and every nested
// re-parse (a `union()` arm, a strategy's criterion, a write's inner traversal) passed the values alone —
// so `{x: 5 as Long}` written inside a branch was stored, and framed, as the Int its JS value spells.
// A wrong number class where the user sees it (root CLAUDE.md, "Semantics traps").
import { describe, expect, test } from 'bun:test';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { seededStore } from '../support/harness.ts';
import { stepChain, parseGremlin, isNested } from '../../src/gremlin/frontend.ts';
import { paramEnv } from '../../src/gremlin/param-env.ts';
import type { TypeNode } from '../../src/gremlin/types.ts';

const LONG_X = { values: { x: 5 }, types: { x: 'long' as TypeNode } };
const run = (q: string, values: Record<string, unknown> = LONG_X.values, types: Record<string, TypeNode> = LONG_X.types) =>
  typedAll(executeQuery(seededStore(), q, values, types));

describe('a parameter keeps its declared number class inside a nested body', () => {
  test.each([
    ['a union() arm', "g.V(1).union(__.addV('t').property('b', x)).values('b')"],
    ['a union() inside a union()', "g.V(1).union(__.union(__.addV('t').property('b', x))).values('b')"],
    ['a union() arm writing on the current element', "g.V(1).union(__.identity().property('b', x)).values('b')"],
    ['the root chain (the control)', "g.V(1).property('b', x).values('b')"],
  ])('%s', (_, q) => {
    expect(run(q)).toEqual(['5L']);
  });

  test('a map parameter keeps its entry types inside a nested property(map)', () => {
    const m = new Map([['b', 5]]);
    const types: Record<string, TypeNode> = { m: { t: 'map', entries: { b: { key: 'string', value: 'long' } } } };
    expect(run("g.V(1).union(__.property(m)).values('b')", { m }, types)).toEqual(['5L']);
  });

  test('the value written inside the arm is STORED with its declared vtype', () => {
    const store = seededStore();
    executeQuery(store, "g.V(1).union(__.addV('t').property('b', x))", LONG_X.values, LONG_X.types);
    expect(store.query<{ vtype: string }>("SELECT vtype FROM vertex_properties WHERE key = 'b'")).toEqual([{ vtype: 'long' }]);
  });

  test('an UNTYPED parameter still settles from its JS value at depth (the JSON request path)', () => {
    // A JSON request carries no types; `declaredParamTypes` reads one off the value — and that settled
    // type now reaches a nested arm as well: 5e9 is past int32, so a Long either way.
    expect(run("g.V(1).union(__.addV('t').property('b', x)).values('b')", { x: 5_000_000_000 }, {})).toEqual(['5000000000L']);
  });
});

describe('the front end reads one environment at every depth', () => {
  test('a nested body re-parsed through stepChain carries the parameter type', () => {
    const env = paramEnv({ x: 5 }, { x: 'long' });
    const [, union] = stepChain(parseGremlin("g.V(1).union(__.addV('t').property('b', x))"), env);
    const body = union!.args[0]!.value;
    if (!isNested(body)) throw new Error('expected a nested arm');
    const property = stepChain(body.nested, env).find((s) => s.name === 'property')!;
    expect(property.args[1]).toMatchObject({ value: 5, type: 'long', name: 'x' });
  });

  test('a parameter the channel left untyped is settled once, by the env', () => {
    expect(paramEnv({ b: true, n: 5, big: 5_000_000_000 }).types).toEqual({ b: 'boolean', n: 'int', big: 'long' });
  });
});

describe("a non-iterable list-step operand names its DECLARED type in the `encountered %s` tail", () => {
  const message = (q: string, values: Record<string, unknown> = {}, types: Record<string, TypeNode> = {}) => {
    try { executeQuery(seededStore(), q, values, types); } catch (e) { return (e as Error).message; }
    return 'no error';
  };
  test.each([
    ["g.V().values('name').fold().combine(2)", {}, {}, 'int'],
    ["g.V().values('name').fold().combine(2L)", {}, {}, 'long'],
  ])('%s %o', (q, values, types, encountered) => {
    expect(message(q, values, types)).toEndWith(`encountered ${encountered}`);
  });
});

// A UUID parameter written at depth is now STORED as a uuid (above), which is only right if equality
// against a stored uuid holds. A UUID equals a UUID and nothing else — a String that spells one included
// (`GremlinValueComparator.equals`: `ft == st`,
// `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:239-275`).
describe('a UUID bound equals a UUID, never a String that spells one', () => {
  const U = '6f6b7c64-0b1a-4b8e-9b1c-1a2b3c4d5e6f';
  const UUID_X: Record<string, TypeNode> = { x: 'uuid' };
  test.each([
    ['written in a union() arm', "g.V(1).union(__.property('u', x)).V().has('u', x).count()", '1L'],
    ['written by addV in a union() arm', "g.V(1).union(__.addV('t').property('u', x)).V().has('u', x).count()", '1L'],
    ['written on the root chain', "g.V(1).property('u', x).V().has('u', x).count()", '1L'],
    ['is() after values()', "g.V(1).property('u', x).values('u').is(x).count()", '1L'],
    ['inside where()', "g.V(1).property('u', x).V().where(__.values('u').is(x)).count()", '1L'],
    ['inside local()', "g.V(1).property('u', x).V().local(__.values('u').is(x)).count()", '1L'],
    ['within() a vararg set', "g.V(1).property('u', x).V().has('u', within(x, 'zz')).count()", '1L'],
    ['neq()', "g.V(1).property('u', x).V().has('u', neq(x)).count()", '0L'],
    ['without()', "g.V(1).property('u', x).V().has('u', without(x)).count()", '0L'],
    ['a stored String spelling the UUID', `g.V(1).property('u', '${U}').V().has('u', x).count()`, '0L'],
    ['a stored UUID against the String literal', `g.V(1).property('u', x).V().has('u', '${U}').count()`, '0L'],
    ['an injected UUID against the String literal', `g.inject(UUID('${U}')).fold().unfold().is('${U}').count()`, '0L'],
    ['a typed injected UUID', "g.inject(UUID('" + U + "')).is(x).count()", '1L'],
    ['a typed injected UUID through fold/unfold', "g.inject(UUID('" + U + "')).fold().unfold().is(x).count()", '1L'],
  ])('%s', (_, q, count) => {
    expect(run(q, { x: U }, UUID_X)).toEqual([count]);
  });

  // A list member carries no per-member UUID type, so an UNFOLDED member is a value with no type fact:
  // it compares by its text (`textSpaced`), and a UUID bound must still find it — answering `false` lost
  // every equality row and flipped neq/without. The reference answers these from the member's UUID
  // (`GremlinValueComparator.equals`, cited above); the String-spelling side is §17's untyped-path line.
  const XS: Record<string, TypeNode> = { x: 'uuid', xs: { t: 'list', items: ['uuid'] } };
  test.each([
    [`g.inject([UUID('${U}')]).unfold().is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().is(UUID('${U}')).count()`, '1L'],
    ['g.inject(xs).unfold().is(x).count()', '1L'],
    [`g.inject(1).constant([UUID('${U}')]).unfold().is(x).count()`, '1L'],
    [`g.inject([UUID('${U}'),'a']).unfold().is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().fold().unfold().is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().dedup().is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().where(__.is(x)).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().union(__.identity()).is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().as('a').select('a').is(x).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().is(within(x,'a')).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().is(within(xs)).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().is(P.eq(x).or(P.eq('a'))).count()`, '1L'],
    [`g.inject([UUID('${U}')]).unfold().choose(__.is(x), __.constant(1), __.constant(2))`, '1i'],
    [`g.inject([UUID('${U}')]).unfold().is(neq(x)).count()`, '0L'],
    [`g.inject([UUID('${U}')]).unfold().is(without(xs)).count()`, '0L'],
    [`g.inject([UUID('${U}')]).unfold().is(without(x)).count()`, '0L'],
    ["g.inject(['a']).unfold().is(x).count()", '0L'],
    [`g.inject('${U}').is(x).count()`, '1L'],   // §17: untyped text
  ])('an untyped value: %s', (q, count) => {
    expect(run(q, { x: U, xs: [U] }, XS)).toEqual([count]);
  });

  test('a UUID written at depth is found by a later request, by parameter and by literal', () => {
    const store = seededStore();
    executeQuery(store, "g.V(1).union(__.property('u', x))", { x: U }, UUID_X);
    expect(typedAll(executeQuery(store, "g.V().has('u', x).count()", { x: U }, UUID_X))).toEqual(['1L']);
    expect(typedAll(executeQuery(store, `g.V().has('u', UUID('${U}')).count()`))).toEqual(['1L']);
    expect(typedAll(executeQuery(store, `g.V().has('u', '${U}').count()`))).toEqual(['0L']);
  });

  test.each([
    ['uuid', 'u', '1L'], ['uuid', 's', '0L'], ['string', 'u', '0L'], ['string', 's', '1L'],
  ] as const)('within() a %s list parameter, against the %s property', (item, key, count) => {
    const q = `g.V(1).property('u', UUID('${U}')).property('s', '${U}').V().has('${key}', within(xs)).count()`;
    expect(run(q, { xs: [U] }, { xs: { t: 'list', items: [item] } })).toEqual([count]);
  });
});
