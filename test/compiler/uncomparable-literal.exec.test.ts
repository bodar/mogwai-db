import { describe, expect, test } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { UNCOMPARABLE_LITERAL } from '../../src/compiler/ir/uncarried-literal.ts';

// A map- or set-valued value is stored and compared as JSON text, whose entry order is the order it was
// written in — so two maps the reference calls equal (`LinkedHashMap.equals` is order-free) are two to SQL.
// `uncomparableLiteral` declines an equality against one, or a merge MATCH criterion holding one, from the
// query text, at every depth, with the reason. Unseen, `g.inject([b:2,a:[x:1,y:2]],[a:[y:2,x:1]]).mergeV()`
// created two vertices where the reference creates one.

const run = (q: string, params: Record<string, unknown> = {}) => executeFramed(seededStore(), q, params);

describe('a map- or set-valued equality operand or merge criterion declines, naming why', () => {
  const nested = new Map([['a', new Map([['x', 1]])]]);
  const declined: [string, Record<string, unknown>][] = [
    ['g.inject([b:2,a:[x:1,y:2]],[a:[y:2,x:1]]).mergeV()', {}],
    ["g.V().has('m',[a:1])", {}],
    ["g.V().has('m', within([[a:1]]))", {}],
    ['g.mergeV([name:[a:1]])', {}],
    ['g.mergeV(m)', { m: nested }],
    ['g.inject(rows).unfold().mergeV()', { rows: [new Map([['name', 'x']]), nested] }],
    // ...at depth, and through every equality form.
    ["g.V().has('m', neq([a:1])).count()", {}],
    ["g.V().has('m', without([[a:1]])).count()", {}],
    ["g.V().has('name', within(xs)).count()", { xs: ['marko', new Map([['a', 1]])] }],
    ["g.V().has('age', eq(29).or(neq([a:1]))).count()", {}],
    ["g.V().local(has('m',[a:1]))", {}],
    ["g.V().union(where(values('m').is([a:1])), identity()).count()", {}],
    ["g.V().filter(where(values('name').is(within([[a:1]])))).count()", {}],
    ["g.V().repeat(out().has('m', [a:1])).times(2).count()", {}],
    ['g.V().local(union(inject([name:{1,2}]).mergeV(), identity())).count()', {}],
    ['g.inject(1).choose(identity(), inject([name:[a:1]]).mergeV())', {}],
    ["g.V(1).as('x').V(2).as('y').mergeE([(T.label):'k', (Direction.from):1, (Direction.to):2, w:[a:1]])", {}],
  ];
  for (const [q, params] of declined) test(`declines: ${q}`, () => expect(() => run(q, params)).toThrow(UNCOMPARABLE_LITERAL));

  // A scalar or list operand, a membership list, and a WRITTEN (onCreate/onMatch) map all still answer.
  const answered: [string, Record<string, unknown>, number][] = [
    ["g.V().has('name', within(['marko','josh'])).values('name')", {}, 2],
    ["g.V().has('name', within(xs)).values('name')", { xs: ['marko', 'josh'] }, 2],
    ['g.V().hasId([1,2])', {}, 2],
    ["g.inject([name:[1,2]]).mergeV().values('name')", {}, 1],
    ["g.mergeV([name:'x']).option(onCreate, [m:[a:1]])", {}, 1],
    // A `T.label` Set in a merge criterion is a label membership list, not a compared value.
    ["g.mergeV([(T.label): {'a', 'b'}]).labels()", {}, 2],
    ["g.mergeV([name:'marko']).option(onMatch, [m:[a:1]]).values('name')", {}, 1],
  ];
  for (const [q, params, n] of answered) test(`answers: ${q}`, () => expect(run(q, params).length).toBe(n));
});
