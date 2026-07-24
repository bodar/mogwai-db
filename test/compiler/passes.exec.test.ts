// The Pass pipeline (src/compiler/ir/pass.ts + passes.ts): ordering invariants that used to live
// only in prose comments + the inside-out normalize() nesting. Encoding them as a test turns a
// silent mis-compile (a future reorder) into a loud failure. Asserted DIRECTLY against the PASSES
// array — no compile() needed.
import { test, expect, describe } from 'bun:test';
import { PASSES } from '../../src/compiler/ir/passes.ts';
import { PASS_CATEGORIES } from '../../src/compiler/ir/pass.ts';

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
});
