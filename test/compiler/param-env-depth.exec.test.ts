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
