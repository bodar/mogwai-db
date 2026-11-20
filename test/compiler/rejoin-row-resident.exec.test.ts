// A VARIANT or PROPERTY body through the per-traverser REJOIN (`scoped.ts` `rejoin`).
//
// The rejoin carries a body's payload as `payloadCols(rel)` — every non-channel column — through an INNER join
// on the scope key. It used to ask `framingCols` whether it could, and that is the wrong question: `framingCols`
// asks for a FIXED-WIDTH payload a record field can name in advance, which a variant (its width follows its
// declared arms) and a property (a multi-column payload) are not. Both are ordinary columns of each row, so the
// rejoin now asks `rowResident` (`src/compiler/rel/framing.ts`) and the connector answers what only the ladder
// did: an option-map `choose` with differently shaped arms under `local`/`map`, and a per-vertex property window
// under `local` (`vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/map/Local.feature:20-37`).
//
// Every case compares the multiset, value by value, against the answer the deleted ladder route gave.
import { describe, expect, test } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import type { FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { bagOf, bare, runWith, seededStore, storeSeededWith } from '../support/harness.ts';

// One lowering since the ladder was deleted; the loop keeps the mode label in a failure.
const MODES = [['default', undefined]] as const;
const modern = seededStore();
const crew = storeSeededWith(CREW_SEED);
type Store = typeof modern;

/** One row as the value a user reads: a list's members, a property's value, a vertex's id, a scalar. */
const valueOf = (row: Record<string, unknown>): string =>
  row.list != null ? `list:${row.list}` : row.pv !== undefined ? `prop:${row.pk}=${row.pv}` : row.id != null ? `v[${row.id}]` : JSON.stringify(row.v);
const answer = (store: Store, q: string, fastPaths?: FastPathConfig): string[] =>
  bagOf((bare(runWith(store, q, fastPaths && { fastPaths })) as Record<string, unknown>[]).map(valueOf));

const CHOOSE_FOLD = `choose(__.values("age")).option(P.between(26, 30), __.values("name").fold()).option(Pick.none, __.values("name").fold())`;
const CHOOSE_MIXED = `choose(__.values('age')).option(P.between(26,30), __.values('name')).option(Pick.none, __.values('age').fold())`;
const NAMES = ['list:["marko"]', 'list:["vadas"]', 'list:["josh"]', 'list:["peter"]'];

const ANSWERS: readonly (readonly [Store, string, readonly string[]])[] = [
  // The corpus option-map bodies (a variant of list arms) under both per-traverser hosts.
  [modern, `g.V().hasLabel("person").local(__.${CHOOSE_FOLD})`, NAMES],
  [modern, `g.V().hasLabel("person").map(__.${CHOOSE_FOLD})`, NAMES],
  // A BULKED host (`barrier()` collapses the duplicate starts): each host traverser's bulk carries every list
  // twice — body × host multiplicity, value by value.
  [modern, `g.union(__.V(), __.V()).hasLabel("person").barrier().local(__.${CHOOSE_FOLD})`, [...NAMES, ...NAMES]],
  [modern, `g.union(__.V(), __.V()).hasLabel("person").barrier().map(__.${CHOOSE_FOLD})`, [...NAMES, ...NAMES]],
  // A genuinely mixed variant — a scalar arm, a list arm, and the unproductive pass-through of an ageless vertex
  // (`ChooseStep`'s default identity for `Pick.unproductive`,
  // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java:71-78`).
  [modern, `g.V().map(__.${CHOOSE_MIXED})`, ['"marko"', '"vadas"', 'v[3]', 'list:[32]', 'v[5]', 'list:[35]']],
  [modern, `g.V().local(__.${CHOOSE_MIXED}).count()`, ['6']],
  [modern, `g.V().out().local(__.${CHOOSE_FOLD})`, ['list:["vadas"]', 'list:["josh"]', 'v[3]', 'v[3]', 'v[5]', 'v[3]']],
  // Local.feature:20-37 on CREW (on modern it is empty and proves nothing): each vertex's two first locations.
  [crew, `g.V().local(__.properties("location").order().by(T.value, Order.asc).range(0, 2)).value()`,
    ['"brussels"', '"san diego"', '"centreville"', '"dulles"', '"baltimore"', '"bremen"', '"aachen"', '"kaiserslautern"']],
  [crew, `g.V().local(__.properties('location').order().by(T.value, Order.desc).limit(1)).value()`,
    ['"santa fe"', '"purcellville"', '"seattle"', '"spremberg"']],
  // A property stream as the traverser, under every per-traverser host and nested.
  [modern, `g.V().local(__.properties('name').order().by(T.value).limit(1))`,
    ['prop:name=marko', 'prop:name=vadas', 'prop:name=lop', 'prop:name=josh', 'prop:name=ripple', 'prop:name=peter']],
  [modern, `g.V().local(__.local(__.properties('name').order().by(T.value).limit(1))).value()`,
    ['"marko"', '"vadas"', '"lop"', '"josh"', '"ripple"', '"peter"']],
  [modern, `g.V().map(__.local(__.properties('name').limit(1))).value()`,
    ['"marko"', '"vadas"', '"lop"', '"josh"', '"ripple"', '"peter"']],
  [modern, `g.V().where(__.local(__.properties('age').limit(1))).values('name')`, ['"marko"', '"vadas"', '"josh"', '"peter"']],
  [modern, `g.V().both().both().local(__.properties('name').limit(1)).value().groupCount().unfold().select(values)`,
    ['7', '7', '7', '3', '3', '3']],
];

describe('a variant or property body through the per-traverser rejoin', () => {
  for (const [store, q, expected] of ANSWERS) {
    test(q, () => {
      for (const [mode, fastPaths] of MODES) expect(answer(store, q, fastPaths), mode).toEqual(bagOf([...expected]));
    });
  }

  // `map` is a SPLIT host: the emitted value extends the path, and a variant has no one position to append, so
  // the path is dropped (`splitPath` → `dropPath`) and a later `path()` declines cleanly rather than answering a
  // path missing its last object.
  test('a path() after a variant map() declines rather than answer a truncated path', () => {
    for (const [, fastPaths] of MODES) {
      expect(() => runWith(modern, `g.V().hasLabel('person').map(__.${CHOOSE_MIXED}).path()`, fastPaths && { fastPaths }))
        .toThrow(UnsupportedTraversal);
    }
  });
});
