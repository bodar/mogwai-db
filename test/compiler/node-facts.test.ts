import { describe, expect, spyOn, test } from 'bun:test';
import * as walk from '../../src/rel/walk.ts';
import { compile } from '../../src/compiler/compiler.ts';
import { lowerToRel } from '../../src/compiler/rel/lower.ts';
import { extractStrategies, parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import type { Plan } from '../../src/rel/plan.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { isStmt, type Stmt } from '../../src/rel/stmt.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

/**
 * PER-NODE FACTS ARE SYNTHESIZED ONCE PER NODE (`nodeFact`, `src/rel/walk.ts`) — Calcite's
 * `RelMetadataQuery` discipline. Two things can go wrong with that, and neither shows in an answer:
 *
 *   - a fact rewritten bottom-up answers something different from the whole-subtree walk it replaced.
 *     `refNames`/`hasFreeSelfRef` are now synthesized from their children's answers; the walks they
 *     replaced are kept HERE as the oracle and compared at every node of every corpus plan.
 *   - a fact, or a whole-plan walk, quietly stops being memoised. The compile is still right, just
 *     slower by a factor of the plan's size — the class of regression `freeRelIds`' 2^k measurement and
 *     `relDepth`'s O(n²) note in `walk.ts` describe. The meter is `relChildren`/`exprChildren`, spied on
 *     the module namespace so no production counter exists: the enumerations a compile makes per
 *     DISTINCT node must stay a small constant, and must not grow with the plan.
 */

const CORPUS = (await Bun.file(new URL('../L1-corpus/corpus.txt', import.meta.url)).text()).split('\n').filter(Boolean);
/** The largest program the corpus compiles — 108 statements of `addV(...).as(...)` + `addE`. */
const SEED_WRITE = CORPUS.find((q) => q.startsWith('g.addV("person").property("name", " marko ")'))!;

const lowered = (q: string): Plan | null => {
  try {
    const tree = parseGremlin(q);
    const steps = runPasses(stepChain(tree, NO_PARAMS), extractStrategies(tree, NO_PARAMS), NO_PARAMS).steps as IRStep[];
    return lowerToRel(steps, { params: NO_PARAMS, wireTerminal: true })?.plan ?? null;
  } catch { return null; }
};

/** Every relation of a plan — its bindings' (a statement's children and subplans included) and its result's. */
const nodesOf = (plan: Plan): { readonly rels: readonly Rel[]; readonly stmts: readonly Stmt[] } => {
  const roots: Rel[] = [plan.result];
  const stmts: Stmt[] = [];
  for (const { node } of plan.bindings) {
    if (!isStmt(node)) { roots.push(node); continue; }
    stmts.push(node);
    roots.push(...walk.stmtChildren(node));
    walk.stmtExprs(node).forEach((e) => walk.forEachExpr(e, (x) => roots.push(...walk.exprRels(x))));
  }
  const rels: Rel[] = [];
  walk.forEachRel(roots, (r) => rels.push(r));
  return { rels, stmts };
};

/** THE ORACLES — the whole-subtree walks the synthesized facts replaced, verbatim in meaning. */
const walkedRefNames = (node: Rel | Stmt): ReadonlySet<string> => {
  const names = new Set<string>();
  const relation = (r: Rel): void => walk.forEachRel(r, (n) => { if (n.kind === 'ref') names.add(n.name); });
  if (isStmt(node)) {
    walk.stmtChildren(node).forEach(relation);
    walk.stmtExprs(node).forEach((e) => walk.forEachExpr(e, (n) => walk.exprRels(n).forEach(relation)));
  } else relation(node);
  return names;
};
const walkedFreeSelfRef = (plan: Rel): boolean => {
  const bound = new Set<string>(), referenced = new Set<string>();
  walk.forEachRel(plan, (r) => {
    if (r.kind === 'recursive') bound.add(r.name);
    if (r.kind === 'self-ref') referenced.add(r.name);
  });
  return [...referenced].some((name) => !bound.has(name));
};
const walkedFreeRelIds = (plan: Rel): ReadonlySet<string> => {
  const defined = new Set<string>(), referenced = new Set<string>();
  walk.forEachRel(plan, (r) => {
    defined.add(r.id);
    walk.relExprs(r).forEach((e) => walk.forEachExpr(e, (x) => { if (x.kind === 'col') referenced.add(x.rel); }));
  });
  return new Set([...referenced].filter((id) => !defined.has(id)));
};
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe('a synthesized fact answers what the whole-subtree walk answers, at every node of every corpus plan', () => {
  test('refNames, hasFreeSelfRef and freeRelIds', () => {
    let plans = 0, nodes = 0;
    for (const q of CORPUS) {
      const plan = lowered(q);
      if (!plan) continue;
      plans++;
      const { rels, stmts } = nodesOf(plan);
      for (const r of rels) {
        nodes++;
        const at = `${q} @ ${r.kind} ${r.id}`;
        expect(sorted(walk.refNames(r)), at).toEqual(sorted(walkedRefNames(r)));
        expect(walk.hasFreeSelfRef(r), at).toBe(walkedFreeSelfRef(r));
        expect(sorted(walk.freeRelIds(r)), at).toEqual(sorted(walkedFreeRelIds(r)));
      }
      for (const s of stmts) expect(sorted(walk.refNames(s)), q).toEqual(sorted(walkedRefNames(s)));
    }
    // The corpus must actually have exercised the facts — walks, refs and correlated plans among them.
    expect(plans).toBeGreaterThan(1000);
    expect(nodes).toBeGreaterThan(20_000);
  }, 120_000);
});

/** Enumerations of child relations and sub-expressions made while `fn` runs, per DISTINCT node. */
const enumerations = (fn: () => void): { readonly rels: number; readonly exprs: number; readonly distinct: number } => {
  const rc = spyOn(walk, 'relChildren');
  const ec = spyOn(walk, 'exprChildren');
  try {
    fn();
    const distinct = new Set(rc.mock.calls.map(([r]) => r)).size;
    const distinctExprs = new Set(ec.mock.calls.map(([e]) => e)).size;
    return { rels: rc.mock.calls.length / Math.max(1, distinct), exprs: ec.mock.calls.length / Math.max(1, distinctExprs), distinct };
  } finally { rc.mockRestore(); ec.mockRestore(); }
};

describe('a compile enumerates each node a small constant number of times', () => {
  /**
   * The bound is the compile's walk COUNT — lowering, the passes, `check`, the emitter each walk the plan
   * a few times, and each fact enumerates a node once when it is synthesized — not a per-fact count.
   * Measured when the facts became per-node: 4.7–9.7 per relation and 7.0–9.2 per expression over these
   * plans. The relation figure includes `freeRelIds` proving a correlated id absent from a subtree
   * (`definesId`), which is bounded by the spine cut (`boundedSpine`) and is the same search the
   * walk-per-ask did.
   */
  const FIXED: readonly (readonly [string, string])[] = [
    ['times(100)', "g.V().repeat(out().order().by('name')).times(100)"],
    ['the 108-statement seed write', SEED_WRITE],
    ['a walk read by two arms', "g.V(1).until(hasLabel('software')).repeat(out()).emit()"],
    ['a modern-graph seed edge', MODERN_SEED[6]!],
    ['a correlated body inside a repeat', "g.V().repeat(local(out().where(out().count().is(gt(0))).limit(1))).times(3).values('name')"],
  ];
  for (const [label, q] of FIXED) {
    test(label, () => {
      const { rels, exprs } = enumerations(() => compile(q, {}));
      expect(rels).toBeLessThan(12);
      expect(exprs).toBeLessThan(12);
    });
  }

  test('and the constant does not grow with the plan', () => {
    // `both()` is the DAG shape: each hop is a Union whose two arms read ONE input, so a walk that lost
    // its visited-set, or a fact that lost its memo, grows with the hop count rather than the node count.
    // Both lengths are past the spine cut (`SPINE_DEPTH_BOUND`), which bounds every per-step search, so
    // what is left to grow is a re-walk that the memo or a visited-set should have stopped.
    const at = (hops: number) => enumerations(() => compile(`g.V()${'.both()'.repeat(hops)}.count()`, {}));
    const small = at(40), large = at(160);
    expect(large.distinct).toBeGreaterThan(3 * small.distinct);
    expect(large.rels).toBeLessThan(small.rels * 1.2);
    expect(large.exprs).toBeLessThan(small.exprs * 1.2);
  });

  test('a fact asked again is answered without enumerating anything', () => {
    const plan = lowered(SEED_WRITE)!;
    const { rels, stmts } = nodesOf(plan);
    // Ask every fact once, so each is synthesized…
    const ask = () => {
      rels.forEach((r) => { walk.refNames(r); walk.hasFreeSelfRef(r); walk.freeRelIds(r); walk.refReads(r); walk.relDepth(r); });
      stmts.forEach((s) => walk.refNames(s));
    };
    ask();
    // …then again: every answer is the node's, so not one child list is built.
    const rc = spyOn(walk, 'relChildren');
    const ec = spyOn(walk, 'exprChildren');
    try {
      ask();
      expect(rc.mock.calls.length).toBe(0);
      expect(ec.mock.calls.length).toBe(0);
    } finally { rc.mockRestore(); ec.mockRestore(); }
  });
});
