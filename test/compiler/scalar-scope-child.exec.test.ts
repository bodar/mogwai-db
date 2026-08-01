// A `map(B)`/`local(B)` whose body is scalar-shaped is a SCALAR PRODUCER at every child position —
// `isScalarProducingScope` (tail/child-shape.ts) plus the `isOneRowProjection` proof that lets
// `first` cardinality rank on a trivial encounter.
//
// The gap this closes was a pure classifier gap: root lowering has always accepted
// `g.V().out().local(__.count())`, so the identical body one level in was declining a shape the
// engine can already lower. The tests are therefore written as ROOT-vs-CHILD equivalences wherever
// one exists — that is the property, and it is stronger than an expected-value table because it
// cannot drift if the fixture changes.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { run, seededStore } from '../support/harness.ts';

const store = seededStore();
const vals = (q: string) => (run(store, q) as any[]).map((r) => r.v ?? r.e0_v ?? r.id);
/** Traversers are a MULTISET. Two spellings of the same question agree row for row only when
 *  something upstream fixes an emission order; where neither does, comparing sorted is the honest
 *  assertion (a stronger one here would be pinning an order SQLite chose — see the perturbation
 *  instrument in test/CLAUDE.md). */
const bag = (q: string) => [...vals(q)].sort();

describe('a scalar-bodied map()/local() composes as a scalar producer in a child body', () => {
  test('child-in-child agrees with the same body at root', () => {
    // The outer local() supplies one traverser at a time, so the inner scope sees exactly what the
    // root chain does.
    for (const [child, root] of [
      ['g.V().local(__.out().local(__.count()))', 'g.V().out().local(__.count())'],
      ['g.V().local(__.out().map(__.count()))', 'g.V().out().map(__.count())'],
      ['g.V().local(__.out().local(__.in().count()))', 'g.V().out().local(__.in().count())'],
    ] as const) expect(bag(child)).toEqual(bag(root));
  });

  test('the scope is transparent where the body is a bare reduction', () => {
    // local(__.out().count()) and out().count() are the same per-traverser question, so every
    // by()-consumer must read the same values through either spelling.
    for (const [wrapped, direct] of [
      ["g.V().project('n').by(__.local(__.out().count()))", "g.V().project('n').by(__.out().count())"],
      ["g.V().project('n').by(__.map(__.out().count()))", "g.V().project('n').by(__.out().count())"],
      ['g.V().order().by(__.local(__.out().count()))', 'g.V().order().by(__.out().count())'],
      ['g.V().order().by(__.map(__.out().count()))', 'g.V().order().by(__.out().count())'],
    ] as const) expect(vals(wrapped)).toEqual(vals(direct));
  });

  test('it reaches the filter, branch and group positions too', () => {
    // `bag`, not `vals`: neither spelling constrains the order of the vertices that survive the
    // filter, and `mise run test:perturbed` reverses exactly that scan.
    expect(bag('g.V().where(__.local(__.out().count()).is(P.gt(1)))'))
      .toEqual(bag('g.V().where(__.out().count().is(P.gt(1)))'));
    // NOT compared against `union(__.out().count(), __.in().count())`: a bare count() in a branch
    // arm is a GLOBAL barrier over the whole branch input (it answers [6,6]), which is a different
    // question — that asymmetry is the branch-arm plan's T1, not this lift. The per-traverser spelling is the one
    // this change unlocks, so it is asserted directly.
    expect(bag('g.V().union(__.local(__.out().count()), __.local(__.in().count()))'))
      .toEqual([...vals('g.V().local(__.out().count())'), ...vals('g.V().local(__.in().count())')].sort());
    expect(() => compile('g.V().group().by(__.map(__.out().count())).by(__.count())', {})).not.toThrow();
  });

  test('map() takes the FIRST result, so a fan-out body still yields one per input', () => {
    // marko/josh/peter have out-edges; each neighbour's local(count()) is 1, and map keeps one.
    // The three vertices with no out-edges produce nothing — map filters an unproductive body.
    expect(vals('g.V().map(__.out().local(__.count()))')).toEqual([1, 1, 1]);
  });
});

describe('the cardinality proof is the gate — a many-valued local() body stays out', () => {
  test('local(__.<fan-out scalar>) is NOT admitted as a one-per-input producer', () => {
    // `local(__.out().values("name"))` yields MANY scalars per input, so calling it a scalar
    // producer would silently change the classifier's cardinality contract. It must not compile
    // through this route — either it declines here or something else answers, but the arity claim
    // is never made. Asserted through a `first`-cardinality consumer, which is where a wrong claim
    // would surface as an arbitrary pick.
    let msg = '';
    try { compile("g.V().project('n').by(__.local(__.out().values('name')))", {}); } catch (e: any) { msg = String(e.message); }
    expect(msg).not.toBe('');
  });

  test('the root spellings this generalizes from are unchanged', () => {
    expect(vals('g.V().out().local(__.count())')).toEqual([1, 1, 1, 1, 1, 1]);
    expect(vals('g.V().local(__.out().count())')).toEqual(vals('g.V().map(__.out().count())'));
  });
});
