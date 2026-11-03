// B4: A MAP-KEY COLLISION EXPLAINS ITSELF. Rows MAY hold a key `k` while a side effect or a path label `k`
// is also in scope, so which scope answers would depend on the row (`Scoping.getScopeValue`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
// ONE classifier (`mapKeyCollision`, src/compiler/rel/lower.ts, beside `namedBeyondMap`) names what else
// binds the key, and every map-first reader that declines on it records the same ADVISORY reason (the
// Substrate 0 sink, `Declines`). WHEN a reader declines is unchanged; only the text gains the why. The
// wording is a MAY, because the key fact is what a row MAY hold.
import { describe, expect, test } from 'bun:test';
import { compilePlan, UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { run, seededStore } from '../support/harness.ts';

const declineOf = (q: string): UnsupportedTraversal => {
  try { compilePlan(q, {}); } catch (e) {
    if (e instanceof UnsupportedTraversal) return e;
    throw e;
  }
  throw new Error(`expected ${q} to decline`);
};

/** The hint after the generic "no lowering covers <q> — ". */
const said = (q: string): string => {
  const e = declineOf(q);
  expect(e.kind).toBe('uncovered');
  const prefix = `this traversal is not supported yet: no lowering covers ${q} — `;
  expect(e.message).toStartWith(prefix);
  return e.message.slice(prefix.length);
};

describe('a map-key collision says what collides with what', () => {
  test('a path label named like a property key', () => {
    for (const q of [
      "g.V().as('name').valueMap().select('name')",
      "g.V().as('name').project('name','age').by('name').by('age').select('name')",
      "g.V().as('name').elementMap().select('name')",
    ]) {
      expect(said(q)).toBe("select('name') is ambiguous here: each Map may hold a key 'name' and a path label 'name' is also "
        + "bound, so which one is read would depend on the row — rename the label (as('name1')) or the key");
    }
  });

  test('a side-effect constant names the side effect and suggests renaming it', () => {
    expect(said("g.withSideEffect('a',1).V().constant([a:1]).select('a')"))
      .toBe("select('a') is ambiguous here: each Map may hold a key 'a' and a side effect 'a' is also declared, so "
        + "which one is read would depend on the row — rename the side effect (withSideEffect('a1', …)) or the key");
    expect(said("g.V().as('a').constant([a:1]).select('a')")).toContain("a path label 'a' is also bound");
  });

  test('every map-first reader quotes its own step', () => {
    expect(said("g.V().as('name').valueMap().select('name','age')"))
      .toStartWith("select('name','age') is ambiguous here: each Map may hold a key 'name' and a path label 'name'");
    expect(said("g.inject(10).as('b').union(__.constant([a: 3]), __.constant([a: 1, b: 2])).format('%{b}')"))
      .toStartWith("format('%{b}') is ambiguous here: each Map may hold a key 'b' and a path label 'b'");
    expect(said("g.V().values('age').as('b').constant([a: 1, b: 2]).limit(local, 1).math('b')"))
      .toStartWith("math('b') is ambiguous here: each Map may hold a key 'b' and a path label 'b'");
    expect(said("g.inject(10).as('b').union(__.constant([a: 3]), __.constant([a: 1, b: 10])).dedup('b').count()"))
      .toStartWith("dedup('b') is ambiguous here: each Map may hold a key 'b' and a path label 'b'");
    // A record's OPTIONAL field: `project('m').by(elementMap('name'))` in one arm lacks `age`.
    expect(said("g.withSideEffect('age', 7).V().hasLabel('person').union(__.project('m').by(__.elementMap('name')), "
      + "__.project('m').by(__.elementMap('name', 'age'))).select('m').select('age')"))
      .toStartWith("select('age') is ambiguous here: each Map may hold a key 'age' and a side effect 'age' is also declared");
  });

  test('at depth: inside local(), after as()/select(), inside a union() arm', () => {
    for (const q of [
      "g.V().as('name').local(__.valueMap().select('name'))",
      "g.V().as('name').valueMap().as('m').select('m').select('name')",
      "g.V().as('name').union(__.valueMap().select('name'), __.constant(1))",
    ]) expect(said(q)).toContain('is ambiguous here: each Map may hold a key');
  });

  test('a decline that is NOT a collision gains no reason', () => {
    // A project() over a stream of Maps is not lowered yet, label or no label.
    const q = "g.inject(10).as('b').union(__.constant([a: 3]), __.constant([a: 1, b: 2])).project('x').by(__.select('b'))";
    expect(declineOf(q).message).toBe(`this traversal is not supported yet: no lowering covers ${q}`);
  });

  test('where nothing else binds the key, or no row may hold it, the read still answers', () => {
    const store = seededStore();
    expect(run(store, "g.V().valueMap().select('name').count()")).toEqual([{ v: 6 }]);
    // `b` is outside every row's keys: the label answers for every row.
    expect(run(store, "g.V().as('b').constant([a: 1]).select('b').count()")).toEqual([{ v: 6 }]);
  });
});
