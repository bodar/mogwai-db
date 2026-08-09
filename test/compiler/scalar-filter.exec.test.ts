// THE FILTER FAMILY OVER A VALUE STREAM — `and`/`or`/`not`/`filter`/`where(<body>)` applied to a
// traverser that is a VALUE rather than an element, plus the ordering comparability the same change
// exposed.
//
// It has its own file because what is under test is a COMPOSITION rather than a step: each of these
// connectives already worked over an element stream, and the corpus exercises the scalar position
// mostly through `g.inject(1d).and(is(…), is(…))`-shaped semantics scenarios. The neighbouring
// compositions the corpus does NOT name — a connective over a PROPERTY-derived value stream, one
// nested inside another, a `not()` over an unproductive body — are the ones a scalar-only regression
// would slip through, so they are pinned here.
import { describe, expect, test } from 'bun:test';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { read, relOnly, seededStore } from '../support/harness.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';

describe('the filter family over a scalar stream', () => {
  const store = seededStore();
  const vals = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}))).map((x) => (x === null ? '∅' : String(x))).sort();

  test('and() over a value stream conjoins its arms', async () => {
    expect(await vals("g.V().values('age').and(__.is(P.gt(28)),__.is(P.lt(35)))")).toEqual(['29', '32']);
  });

  test('or() over a value stream disjoins its arms', async () => {
    expect(await vals("g.V().values('age').or(__.is(P.lt(28)),__.is(P.gt(34)))")).toEqual(['27', '35']);
  });

  test('not() over a value stream is NULL-SAFE — a body that produced nothing is KEPT', async () => {
    // The whole point of `notProduced`: `NOT NULL` is NULL, so a plain `NOT` would drop the very rows
    // a negation exists to keep. Every age fails `gt(99)`, so every one survives the negation.
    expect(await vals("g.V().values('age').not(__.is(P.gt(99)))")).toEqual(['27', '29', '32', '35']);
  });

  test('filter() over a value stream takes a whole nested connective', async () => {
    expect(await vals("g.V().values('age').filter(__.or(__.and(__.is(P.gt(28)),__.is(P.lt(30))),__.is(P.gt(34))))"))
      .toEqual(['29', '35']);
  });

  test('where(<body>) over a value stream is the same question filter() asks', async () => {
    expect(await vals("g.V().values('age').where(__.is(P.gt(33)))")).toEqual(['35']);
  });

  test('the connectives NEST to any depth over a value stream', async () => {
    expect(await vals("g.V().values('age').and(__.or(__.is(P.eq(27)),__.is(P.eq(35))),__.not(__.is(P.eq(35))))"))
      .toEqual(['27']);
  });

  test('a connective survives a value stream that came from inject() rather than a property', async () => {
    expect(await vals('g.inject(1,2,3,4).and(__.is(P.gt(1)),__.is(P.lt(4)))')).toEqual(['2', '3']);
  });

  test('an ELEMENT-only clause still declines over a value stream rather than answering', () => {
    // `has()` reads a property row, which a value traverser does not have — so the connective
    // DECLINES the whole step (one unanswerable arm declines all of them) and the traversal routes
    // to the spine that owns the message. That the message is LEGACY'S is the decline contract
    // working: RelIR must not invent an answer about a property row that is not there.
    expect(() => read("g.V().values('age').and(__.has('name'),__.is(P.gt(28)))"))
      .toThrow('and() after a scalar stream not yet supported');
  });
});

describe('ordering comparability follows the BOUND’s own Gremlin type', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  executeQuery(store, "g.addV('t').property('when',datetime('2024-01-01T00:00:00Z')).property('age',30)", {});
  executeQuery(store, "g.addV('t').property('when',datetime('2019-01-01T00:00:00Z')).property('age',10)", {});
  const vals = async (g: string) =>
    (await decodeAll(executeQuery(store, g, {}))).map((x) => (x === null ? '∅' : String(x))).sort();

  test('a datetime bound compares against a stored datetime', async () => {
    // The regression this arm exists for: the CASE used to test the plain NUMERIC vtypes, so a
    // temporal bound — epoch millis, and numeric to SQLite — fell to the `else` and answered FALSE
    // for every row. Two datetimes ARE comparable, and only two datetimes are.
    expect(await vals("g.V().values('when').is(P.gt(datetime('2020-01-01T00:00:00Z')))"))
      .toHaveLength(1);
  });

  test('a datetime bound is NOT comparable with a stored number', async () => {
    expect(await vals("g.V().values('age').is(P.gt(datetime('2020-01-01T00:00:00Z')))")).toEqual([]);
  });

  // RELIR'S CLAIM, not legacy's: legacy's `compareKey` casts a stored `datetime` with the plain
  // integrals, so it compares epoch millis against `20` and answers TRUE for both rows. That is a
  // defect in a route with an end date, and restating it here would commit it — `relOnly` is the
  // marker for exactly that (`test/support/harness.ts`).
  relOnly('a plain numeric bound is NOT comparable with a stored datetime', async () => {
    expect(await vals("g.V().values('when').is(P.gt(20))")).toEqual([]);
  });

  test('a datetime bound survives the connectives it now reaches through', async () => {
    expect(await vals("g.V().values('when').and(__.is(P.gt(datetime('2020-01-01T00:00:00Z'))),__.is(P.lt(datetime('2030-01-01T00:00:00Z'))))"))
      .toHaveLength(1);
  });
});
