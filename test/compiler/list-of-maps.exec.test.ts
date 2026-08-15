// A LIST WHOSE MEMBERS ARE MAPS — `project(k…).by(…).fold()`, `valueMap().fold()`,
// `group().…fold()`, and a nested `project().by(__.…project().fold())`. This is the RelIR substrate the
// GraphQL front-end plan (`docs/2026-08-07-graphql-front-end-plan.md` §2·2) names as "the substrate
// item, and it comes first": every GraphQL to-many object field at depth ≥ 2 is a list of maps.
//
// `fold()` gained an arm on the RECORD and MAP tails (it existed only on the scalar/element tails), a
// `foldMaps` producer collects the per-row pairs array, `ListOf` grew a `map` member arm, and a `list`
// field inside a `project()` slot now frames through `listNodeExpr` (the self-describing twin of
// `listPayloadExpr` — the `elementNode`/`elementObject` split, one level up). These assert the DECODED
// wire, because the whole point is the GraphBinary shape a client receives.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

/** Decode a result set and normalise the GraphBinary tree to plain JS: a Map → object, a Vertex/Edge →
 *  `{V:id}`/`{E:id}`, everything else itself. Asserts on VALUES, not element identity. */
const norm = (v: any): any =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, norm(x)]))
  : Array.isArray(v) ? v.map(norm)
  : v && v.constructor && (v.constructor.name === 'Vertex' || v.constructor.name === 'Edge')
    ? { [v.constructor.name === 'Vertex' ? 'V' : 'E']: v.id }
    : v;

const decoded = async (q: string): Promise<any[]> => {
  const store = seededStore();
  return (await decodeAll(executeQuery(store, q))).map(norm);
};

describe('a list of maps — fold() over a record / map stream', () => {
  test('project().by().fold() is one traverser: a list of single-key maps', async () => {
    const r = await decoded("g.V().hasLabel('person').project('n').by('name').fold()");
    expect(r).toEqual([[{ n: 'marko' }, { n: 'vadas' }, { n: 'josh' }, { n: 'peter' }]]);
  });

  test('a multi-field project().fold() keeps every field per member', async () => {
    const r = await decoded("g.V().hasLabel('person').project('n','a').by('name').by('age').fold()");
    expect(r).toEqual([[
      { n: 'marko', a: 29 }, { n: 'vadas', a: 27 }, { n: 'josh', a: 32 }, { n: 'peter', a: 35 },
    ]]);
  });

  test('valueMap().fold() carries the list-valued map entries', async () => {
    const r = await decoded("g.V().hasLabel('person').valueMap('name').fold()");
    expect(r).toEqual([[
      { name: ['marko'] }, { name: ['vadas'] }, { name: ['josh'] }, { name: ['peter'] },
    ]]);
  });

  test('groupCount().fold() folds the ONE barrier map into a size-1 list', async () => {
    const r = await decoded("g.V().hasLabel('person').groupCount().by('name').fold()");
    expect(r).toEqual([[{ marko: 1, vadas: 1, josh: 1, peter: 1 }]]);
  });

  test('group().by().by(k).fold() likewise', async () => {
    const r = await decoded("g.V().hasLabel('person').group().by('name').by('age').fold()");
    expect(r).toEqual([[{ marko: [29], vadas: [27], josh: [32], peter: [35] }]]);
  });
});

describe('a nested selection — a list of maps as a project() FIELD', () => {
  test('project().by(__.out().project().by().fold()) — GraphQL depth-2', async () => {
    // marko knows josh + vadas; every other person knows nobody, so their `knows` field is [].
    const r = await decoded(
      "g.V().hasLabel('person').project('name','knows').by('name')" +
      ".by(__.out('knows').project('name').by('name').fold())");
    expect(r).toEqual([
      { name: 'marko', knows: [{ name: 'josh' }, { name: 'vadas' }] },
      { name: 'vadas', knows: [] },
      { name: 'josh', knows: [] },
      { name: 'peter', knows: [] },
    ]);
  });

  test('a scalar-fold field — project().by(__.out().values().fold())', async () => {
    const r = await decoded(
      "g.V().has('name','marko').project('name','known').by('name').by(__.out('knows').values('name').fold())");
    expect(r).toEqual([{ name: 'marko', known: ['josh', 'vadas'] }]);
  });

  test('an EMPTY fold field keeps its key with [] — the fold is always productive', async () => {
    // vadas knows nobody. A `fold()` seeds `[]`, so the field is never absent: the key stays with an
    // empty list, NOT dropped. This is also why the field carries no presence guard (which would
    // otherwise re-emit the whole value subquery — the depth-3 duplication fix).
    const r = await decoded(
      "g.V().has('name','vadas').project('name','knows').by('name').by(__.out('knows').values('name').fold())");
    expect(r).toEqual([{ name: 'vadas', knows: [] }]);
  });

  test('an ELEMENT-fold field frames its members as vertices, not untyped objects', async () => {
    // The `elementNode`/`elementObject` distinction: nested in a map value, a folded element list must
    // ride as `{t:'vertex',…}` so the tree framer decodes real Vertices.
    const r = await decoded("g.V().has('name','marko').project('friends').by(__.out('knows').fold())");
    expect(r).toEqual([{ friends: [{ V: 2 }, { V: 4 }] }]);
  });
});

describe('unfold() over a list of maps — the round trip', () => {
  test('project().fold().unfold() restores the map stream', async () => {
    const r = await decoded("g.V().hasLabel('person').project('n').by('name').fold().unfold()");
    expect(r).toEqual([{ n: 'marko' }, { n: 'vadas' }, { n: 'josh' }, { n: 'peter' }]);
  });

  test('valueMap().fold().unfold() likewise, list values intact', async () => {
    const r = await decoded("g.V().hasLabel('person').valueMap('name').fold().unfold()");
    expect(r).toEqual([{ name: ['marko'] }, { name: ['vadas'] }, { name: ['josh'] }, { name: ['peter'] }]);
  });

  test('groupCount().fold().unfold() restores the single barrier map', async () => {
    const r = await decoded("g.V().hasLabel('person').groupCount().by('name').fold().unfold()");
    expect(r).toEqual([{ marko: 1, vadas: 1, josh: 1, peter: 1 }]);
  });

  test('select(<key>) re-reads a field off the unfolded map — the BARE-key path', async () => {
    // The unfolded map's key is a bare string (project()'s encoding), so `mapKey` must read it through
    // the tolerant `keyMatches`. Before that, this select returned the empty result.
    const r = await decoded("g.V().hasLabel('person').project('n').by('name').fold().unfold().select('n')");
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });

  test('select(<key>) over a {t,v}-key map (group/valueMap) still resolves — no regression', async () => {
    expect(await decoded("g.V().hasLabel('person').valueMap('name').fold().unfold().select('name')"))
      .toEqual([['marko'], ['vadas'], ['josh'], ['peter']]);
    // A group's {t,v}-key select, untouched by the tolerant match.
    expect(await decoded("g.V().hasLabel('person').groupCount().by('name').select('marko')")).toEqual([1]);
  });
});

describe('a by() body over a LIST host — the list ChildHost', () => {
  test('select(Pop.all).by(__.unfold().values(k).fold()) — the collection re-entry', async () => {
    // Each 'a' position holds the WHOLE history (a list of elements); the by() body unfolds it and
    // re-collects the names, so every result is one list per traverser.
    const r = await decoded("g.V().as('a').out().as('a').out().as('a').select(Pop.all,'a').by(__.unfold().values('name').fold())");
    // Two length-3 paths from marko: [marko,josh,lop] and [marko,josh,ripple], names sorted per list.
    expect(r).toEqual([['josh', 'lop', 'marko'], ['josh', 'marko', 'ripple']]);
  });

  test('select(Pop.all).by(__.unfold().count()) counts the collection', async () => {
    const r = await decoded("g.V().as('a').out().as('a').out().as('a').select(Pop.all,'a').by(__.unfold().count())");
    expect(r).toEqual([3, 3]);
  });

  test('the Pop.all history accumulates per traverser, and the by() body reduces each', async () => {
    // marko is bound to 'a', then each knows-target appends: history [marko,vadas] and [marko,josh].
    // Two traversers, each unfolded and its names re-collected (sorted per list).
    const r = await decoded("g.V().has('name','marko').as('a').out('knows').as('a').select(Pop.all,'a').by(__.unfold().values('name').fold())");
    expect(r).toEqual([['marko', 'vadas'], ['josh', 'marko']]);
  });
});
