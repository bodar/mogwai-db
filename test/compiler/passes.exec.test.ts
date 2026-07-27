// The Pass pipeline (src/compiler/ir/pass.ts + passes.ts): ordering invariants that used to live
// only in prose comments + the inside-out normalize() nesting. Encoding them as a test turns a
// silent mis-compile (a future reorder) into a loud failure. Asserted DIRECTLY against the PASSES
// array — no compile() needed.
import { test, expect, describe } from 'bun:test';
import { PASSES } from '../../src/compiler/ir/passes.ts';
import { PASS_CATEGORIES } from '../../src/compiler/ir/pass.ts';
import { foldConnectives } from '../../src/compiler/ir/strategies.ts';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';

const names = PASSES.map((p) => p.name);
const ord = (name: string) => names.indexOf(name);
const catOrd = (cat: string) => PASS_CATEGORIES.indexOf(cat as any);

describe('Pass pipeline ordering invariants', () => {
  test('category order is non-decreasing across PASSES', () => {
    // The flat array is assembled by concatenating category groups in PASS_CATEGORIES order; if a
    // future edit appends a Pass to the wrong group, its category ordinal goes backwards here.
    let last = -1;
    for (const p of PASSES) {
      const idx = catOrd(p.category);
      expect(idx).toBeGreaterThanOrEqual(last);
      last = idx;
    }
  });

  test('extract runs first: stripTerminal is the unique extract member at PASSES[0]', () => {
    expect(PASSES[0].name).toBe('stripTerminal');
    expect(PASSES.filter((p) => p.category === 'extract')).toHaveLength(1);
  });

  test('decoration precedes fold — injectors recurse into RAW {nested} args', () => {
    // Load-bearing: foldRepeatClusters/foldChooseOptions move a repeat()/choose() body from a
    // {nested} arg into .cluster/.options. injectSubgraphRec/injectPartitionRec recurse over the
    // raw {nested} args, so they MUST see the chain before those folds — else a subgraph/partition
    // criterion is silently not injected into the body (an unfiltered leak). See passes.ts.
    expect(catOrd('decoration')).toBeLessThan(catOrd('fold'));
    for (const dec of ['SubgraphStrategy', 'PartitionStrategy', 'ProductiveByStrategy'])
      expect(ord(dec)).toBeLessThan(ord('foldRepeatClusters'));
  });

  test('foldByModulators precedes dropRedundantOrder', () => {
    // dropRedundantOrder skips an order() carrying a by() — which requires foldByModulators to have
    // already absorbed the by() onto the order()'s .bys.
    expect(ord('foldByModulators')).toBeLessThan(ord('dropRedundantOrder'));
  });

  test('collapseFoldCountLocal precedes dropRedundantOrder', () => {
    // collapseFoldCountLocal can expose an order().count() (from fold().count(local)) that
    // dropRedundantOrder then removes; so it must run first.
    expect(ord('collapseFoldCountLocal')).toBeLessThan(ord('dropRedundantOrder'));
  });

  test('verify runs last', () => {
    const verifyIdxs = PASSES.map((p, i) => (p.category === 'verify' ? i : -1)).filter((i) => i >= 0);
    const nonVerifyMax = PASSES.map((p, i) => (p.category !== 'verify' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    for (const vi of verifyIdxs) expect(vi).toBeGreaterThan(nonVerifyMax);
  });

  test('the two RAW-nested-arg folds lead the group, end-labels before connectives', () => {
    // Both rewriteWhereEndLabels and ConnectiveStrategy read the raw `{nested}` args (before
    // foldRepeatClusters/foldChooseOptions move a body into .cluster/.options), so both lead.
    // Their ORDER follows TinkerPop: a where()'s variable locations are resolved at step
    // CONSTRUCTION, before any strategy runs, whereas ConnectiveStrategy is a strategy. It matters
    // for `where(__.as("a").out().and().out().as("b"))` — folding the connective first would move
    // the trailing as("b") inside the and()'s last operand, out of the end-label rewrite's sight.
    const folds = PASSES.filter((p) => p.category === 'fold').map((p) => p.name);
    expect(folds.slice(0, 2)).toEqual(['rewriteWhereEndLabels', 'ConnectiveStrategy']);
    // ConnectiveStrategy is still the only fold that RESTRUCTURES the chain, so it must precede
    // every remaining fold and the whole simplify group.
    expect(ord('ConnectiveStrategy')).toBeLessThan(ord('foldRepeatClusters'));
    expect(ord('ConnectiveStrategy')).toBeLessThan(ord('collapseFoldCountLocal'));
  });
});

// ---------- ConnectiveStrategy (the infix .and()/.or() fold) ----------
//
// This fold lived inside the predicateInlining FAST PATH until 2026-07-27, where it was reachable
// only in a child body and only while that flag was on. These pin the three properties that made
// moving it to a Pass the right call; each one was a measured defect before.
describe('ConnectiveStrategy: infix .and()/.or() folds to the step form', () => {
  const fold = (g: string) => foldConnectives(stepChain(parseGremlin(g), {}), {});
  const shape = (steps: any[]): string =>
    steps.map((s) => {
      const nested = s.args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
      return nested.length ? `${s.name}(${nested.map((n: any) => shape(stepChain(n.nested, {}))).join(', ')})` : s.name;
    }).join('.');

  test('a SOURCE step is never absorbed into an operand', () => {
    // TinkerPop's ConnectiveStrategy.legalCurrentStep excludes GraphStep for exactly this reason;
    // swallowing V() would make the whole traversal one filter over an empty source.
    expect(shape(fold('g.V().has("name","marko").or().has("name","josh")'))).toBe('V.or(has, has)');
    expect(shape(fold('g.E().has("weight",0.5).and().has("weight",0.5)'))).toBe('E.and(has, has)');
  });

  test('an as() ON the source travels WITH it, not into the operand', () => {
    // Our IR difference from TinkerPop, where a label is not a step at all: `as` labels whatever
    // precedes it, so a bind sitting on V() must stay on the outer traverser. Folding it into the
    // branch would confine it and a later select("a") would read an unbound label.
    expect(shape(fold('g.V().as("a").out("knows").and().out("created")'))).toBe('V.as.and(out, out)');
    // …but an as() further along belongs to ITS step and IS absorbed (TinkerPop does this too).
    expect(shape(fold('g.V().out().as("a").and().out("created")'))).toBe('V.and(out.as, out)');
  });

  test('OR binds looser than AND', () => {
    expect(shape(fold('g.V().out("created").and().out("knows").or().in("knows")')))
      .toBe('V.or(and(out, out), in)');
  });

  test('the fold reaches a connective at ANY depth, by the same rule', () => {
    expect(shape(fold('g.V().where(__.out("created").and().out("knows"))')))
      .toBe('V.where(and(out, out))');
    expect(shape(fold('g.V().choose(__.values("age").is(P.gt(29)).and().values("age").is(P.lt(35)), __.values("name"), __.constant("x"))')))
      .toBe('V.choose(and(values.is, values.is), values, constant)');
  });

  test('an untouched chain is returned BY REFERENCE (parse trees survive)', () => {
    // Load-bearing, and it was a real break: a {nested} arg may still be a raw parse tree, and
    // services/params/traversal-param.ts un-parses one back to Gremlin via the client's
    // TranslateVisitor (needs `tree.accept`). An unconditional pass that rebuilt every nested arg
    // as a Step[] broke every federate `with("traversal", __.V())` param.
    const steps = stepChain(parseGremlin('g.V().call("x").with("traversal", __.V().out())'), {});
    expect(foldConnectives(steps, {})).toBe(steps);
  });

  test('an empty operand throws rather than silently dropping a conjunct', () => {
    expect(() => fold('g.V().and().has("name","marko")')).toThrow(/malformed infix/);
  });
});
