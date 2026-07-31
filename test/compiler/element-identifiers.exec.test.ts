// The element-identifier rules (src/compiler/steps/write/validate.ts) — TinkerPop's
// `ElementHelper.validateProperty`/`validateLabel` and `Graph.Hidden`, which nothing here enforced.
//
// The merge half of this is covered by the official corpus (`MergeVertex.feature`,
// `MergeEdge.feature` assert the message text), so those cases live in L3. What the corpus does NOT
// cover is the same rule on the ORDINARY write steps — `addV`, `addE`, `property` — which accepted
// `~`-prefixed and empty identifiers and wrote them. `~` is TinkerPop's HIDDEN namespace: a graph
// that lets a user write there loses the ability to tell its own bookkeeping keys from theirs.
//
// These pin the two storage WAISTS (`labelNames` for every label, `applyVertexProperty`/
// `insertEdgeProperty` for every property key) rather than each write step, which is the point of
// having a waist — a new write step inherits the rule instead of having to remember it.
import { describe, expect, test } from 'bun:test';
import { runWith } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { validateLabel, validatePropertyKey } from '../../src/compiler/steps/write/validate.ts';

const store = () => new GraphStore(new BunSqlite(':memory:'));
const rejects = (q: string, message: string) => expect(() => runWith(store(), q)).toThrow(message);

describe('the identifier rules themselves', () => {
  test('a property key may not be null, empty or hidden', () => {
    expect(() => validatePropertyKey(null)).toThrow('Property key can not be null');
    expect(() => validatePropertyKey('')).toThrow('Property key can not be the empty string');
    expect(() => validatePropertyKey('~id')).toThrow('Property key can not be a hidden key: ~id');
    expect(validatePropertyKey('name')).toBe('name');
  });

  test('a label may not be null, empty or hidden', () => {
    expect(() => validateLabel(null)).toThrow('Label can not be null');
    expect(() => validateLabel('')).toThrow('Label can not be empty');
    expect(() => validateLabel('~vertex')).toThrow('Label can not be a hidden key: ~vertex');
    expect(validateLabel('person')).toBe('person');
  });
});

describe('every write reaches them through a waist', () => {
  test('labels — addV, addE and a multi-label list', () => {
    rejects("g.addV('~vertex')", 'Label can not be a hidden key: ~vertex');
    rejects("g.addV('')", 'Label can not be empty');
    rejects("g.addV('a','~b')", 'Label can not be a hidden key: ~b');
    rejects("g.addV('a').as('x').addV('b').as('y').addE('~knows').from('x').to('y')", 'Label can not be a hidden key: ~knows');
  });

  test('property keys — vertex and edge, on create and on a later property()', () => {
    rejects("g.addV('x').property('~id','y')", 'Property key can not be a hidden key: ~id');
    rejects("g.addV('x').property('','y')", 'Property key can not be the empty string');
    rejects("g.addV('a').as('x').addV('b').as('y').addE('knows').from('x').to('y').property('~w',1)",
      'Property key can not be a hidden key: ~w');
  });

  test('a merge map is validated as a MAP, so a search-only key is rejected too', () => {
    // `~id` here is a search criterion; against a matching graph it would never reach a writer.
    const s = store();
    runWith(s, "g.addV('vertex')");
    expect(() => runWith(s, "g.mergeV(['~id':1])")).toThrow('Property key can not be a hidden key: ~id');
  });

  test('legal identifiers are untouched', () => {
    const s = store();
    expect(runWith(s, "g.addV('person').property('name','marko')")).toHaveLength(1);
    // A `~` anywhere but the START is an ordinary character, exactly as Graph.Hidden defines it.
    expect(runWith(s, "g.addV('per~son').property('na~me','marko')")).toHaveLength(1);
  });
});
