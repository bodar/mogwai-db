// A `boolean`-tagged value frames as a GraphBinary Boolean (type 0x27), never the Int that SQLite's 1/0
// would infer. `frameValue` decodes it through `booleanOfStored` (`src/gremlin/types.ts`) — the same decode
// GraphSON, CSV and the untyped JSON response use — so a stored 1/0 and an unstored JS true/false (a
// parameter) all reach the wire as the same Boolean.
import { test, expect, describe } from 'bun:test';
import { ioc } from '../src/io.ts';
import { executeQuery } from './support/executor.ts';
import { storeSeededWith } from './support/harness.ts';
import type { TypeNode } from '../src/gremlin/types.ts';

const store = storeSeededWith([
  "g.addV('p').property('n','a').property('ok', true)",
  "g.addV('p').property('n','b').property('ok', false)",
]);
const T = ioc.booleanSerializer.serialize(true, true);
const F = ioc.booleanSerializer.serialize(false, true);
const run = (q: string, params: Record<string, unknown> = {}, types: Record<string, TypeNode> = {}) =>
  executeQuery(store, q, params, types);

describe('a Boolean frames as GraphBinary Boolean', () => {
  test('inject(true), inject(false): a literal that never reached storage', () => {
    expect(run('g.inject(true)')).toEqual([T]);
    expect(run('g.inject(false)')).toEqual([F]);
    expect(run('g.inject(true,false)')).toEqual([T, F]);
  });

  test('a JS true/false parameter', () => {
    expect(run('g.inject(x)', { x: true })).toEqual([T]);
    expect(run('g.inject(x)', { x: false })).toEqual([F]);
  });

  test('a stored 1/0 property through values() and valueMap()', () => {
    expect(run("g.V().has('n','a').values('ok')")).toEqual([T]);
    expect(run("g.V().has('n','b').values('ok')")).toEqual([F]);
    const vm = run("g.V().has('n','a').valueMap('ok')")[0]!;
    expect(vm.subarray(vm.length - T.length)).toEqual(T);
    const vmF = run("g.V().has('n','b').valueMap('ok')")[0]!;
    expect(vmF.subarray(vmF.length - F.length)).toEqual(F);
  });

  test('a stored Boolean inside a child: local, coalesce, select().by()', () => {
    expect(run("g.V().has('n','a').local(values('ok'))")).toEqual([T]);
    expect(run("g.V().has('n','b').coalesce(values('missing'), values('ok'))")).toEqual([F]);
    expect(run("g.V().has('n','a').as('v').select('v').by('ok')")).toEqual([T]);
  });
});
