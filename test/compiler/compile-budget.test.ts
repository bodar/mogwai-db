// THE COMPILE-WORK BUDGET (`CompileBudget`, `src/sql/kernel/budget.ts`). Three things it must hold, and
// none of them shows in an answer:
//
//   - it NEVER refuses a plan whose SQL a Durable Object would accept. Every charge is a lower bound on one
//     statement's text; the instrument below measures that bound against the rendered text over the whole
//     L1 corpus, so a charge that starts over-counting fails here, not in production.
//   - a compile-cost regression is VISIBLE: the corpus's largest charge must stay under an eighth of the
//     budget. A change that makes some ordinary query's plan grow past that is the regression, whatever the
//     wall clock says.
//   - an expansion is refused EARLY: a shared node spelled 2^k times declines in milliseconds, from the
//     DAG, rather than after the passes and the emitter have written it out (`spelledSize`).
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { lowerToRel } from '../../src/compiler/rel/lower.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';
import { extractStrategies, parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { renderedSteps, renderLowered } from '../../src/rel/emit.ts';
import { col, compilerInt, type Expr } from '../../src/rel/expr.ts';
import { project, scan, values } from '../../src/rel/factory.ts';
import type { Plan } from '../../src/rel/plan.ts';
import type { Rel } from '../../src/rel/rel.ts';
import { relId } from '../../src/rel/types.ts';
import { largestExpression, spelledSize } from '../../src/rel/walk.ts';
import { COMPILE_BUDGET_BYTES, CompileBudget, CompileBudgetExceeded } from '../../src/sql/kernel/budget.ts';
import { detail, summary } from '../support/output.ts';

const CORPUS = (await Bun.file(new URL('../L1-corpus/corpus.txt', import.meta.url)).text()).split('\n').filter(Boolean);

/** A decline, and how long it took to say so. */
const declineOf = (go: () => unknown): { readonly error: unknown; readonly ms: number } => {
  const started = performance.now();
  try { go(); } catch (error) { return { error, ms: performance.now() - started }; }
  return { error: undefined, ms: performance.now() - started };
};

describe('the L1 corpus under the compile budget', () => {
  // ONE lowering per corpus query with its own meter, as `compilePlan` gives every compile.
  const measured = CORPUS.flatMap((q) => {
    try {
      const tree = parseGremlin(q);
      const steps = runPasses(stepChain(tree, NO_PARAMS), extractStrategies(tree, NO_PARAMS), NO_PARAMS).steps as IRStep[];
      const budget = new CompileBudget();
      const lowered = lowerToRel(steps, { params: NO_PARAMS, wireTerminal: true, budget });
      if (!lowered) return [];
      // A numbered placeholder (`?12`) is charged as its `?`, a string constant as its two quotes (its
      // payload is data, `TextLiteral` in q.ts); the rest of the text — the structure — is charged exactly.
      // So the charge lies between the structure (every quoted run emptied, the compiler's own quoted
      // text included) and the whole text.
      const texts = renderedSteps(lowered.rendered).map((step) => step.emitted.sql.replace(/\?\d+/g, '?'));
      const largestStatement = Math.max(...texts.map((text) => text.replace(/'(?:[^']|'')*'/g, "''").length));
      const largestText = Math.max(...texts.map((text) => text.length));
      return [{ q, plan: lowered.plan, budget, largestStatement, largestText }];
    } catch { return []; }
  });

  test('most of the corpus lowers, so the instrument measures something', () => {
    expect(measured.length).toBeGreaterThan(1500);
  });

  // THE INSTRUMENT. Today's largest charge is ~16 KB (a `map(…fold()).sum(local)` over two labels); the
  // ceiling is an eighth of the budget, so the margin between the corpus and a refusal stays 8×.
  test('the largest charge any corpus query makes stays under an eighth of the budget', () => {
    const worst = measured.reduce((a, b) => (b.budget.peak > a.budget.peak ? b : a));
    summary(`compile budget: corpus peak ${worst.budget.peak} B of ${COMPILE_BUDGET_BYTES} (ceiling ${COMPILE_BUDGET_BYTES / 8})`);
    detail(() => `  worst: ${worst.q}`);
    expect(worst.budget.peak).toBeLessThan(COMPILE_BUDGET_BYTES / 8);
  });

  // THE SIZING RULE, measured: each early charge is a count of NODES, charged as bytes because every node
  // spells at least one. If a lowering ever produced nodes that spell nothing, an early charge could exceed
  // the text it stands for — and a budget sized against the text would then refuse a plan the store takes.
  test('every early charge is a lower bound on the text it stands for', () => {
    const over = measured.flatMap(({ q, plan, largestStatement }) => {
      const units = [...plan.bindings.map((binding) => binding.node), plan.result];
      const nodes = Math.max(...units.map(spelledSize), largestExpression(units));
      return nodes > largestStatement ? [{ q, nodes, largestStatement }] : [];
    });
    expect(over).toEqual([]);
  });

  test('the rendered-bytes charge is exact over the structure: between it and the whole text', () => {
    for (const { budget, largestStatement, largestText } of measured) {
      expect(budget.peak).toBeGreaterThanOrEqual(largestStatement);
      expect(budget.peak).toBeLessThanOrEqual(largestText);
    }
  });
});

describe('an expansion past the budget declines, in the user\'s terms', () => {
  // A bounded repeat whose body renders ~750 bytes a phase: 800 phases is ~600 KB. The unroll's early
  // charge is at the cheapest step's bytes (40), so the count alone cannot refuse it without refusing
  // bodies a Durable Object runs — it declines at the rendered-bytes charge instead, a bounded, linear
  // compile rather than a statement the store refuses after it.
  test('times(800) over order().by() declines naming the count', () => {
    const { error } = declineOf(() => compile("g.V().repeat(__.out().order().by('name')).times(800)", {}));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect(error).toBeInstanceOf(UnsupportedTraversal);
    expect((error as Error).message).toContain('expands to more than 400 KB of SQL in one statement');
    expect((error as Error).message).toContain('repeat(…).times(800) unrolls its body 800 times');
  });

  // A count the unroll's early charge alone refuses: decided before a phase is built.
  test('a count past the early charge declines in milliseconds', () => {
    const { error, ms } = declineOf(() => compile('g.V().repeat(__.out()).times(20000)', {}));
    expect(error).toBeInstanceOf(UnsupportedTraversal);
    expect((error as Error).message).toContain('400 KB of SQL');
    expect(ms).toBeLessThan(250);
  });

  test('a count under the budget still compiles', () => {
    expect(compile('g.V().repeat(__.out()).times(1600)', {}).kind).toBe('read');
  });

  // THE cc-1 CLASS, in a real query: a guarded string transform names its value in the type test and again
  // in the else arm, so each transform doubles the text (filed beside `recordPairs`' fix). Its DAG is 30
  // levels; its text would be 2^30. Refused off the DAG before any pass walks the tree.
  test('a chain of guarded transforms whose text doubles per step declines in milliseconds', () => {
    const transforms = Array.from({ length: 30 }, (_, i) => (i % 2 ? '.toLower()' : '.toUpper()')).join('');
    const { error, ms } = declineOf(() => compile(`g.V().where(__.values('name')${transforms}.is('x'))`, {}));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect((error as Error).message).toContain('split it into smaller traversals');
    expect(ms).toBeLessThan(500);
  });
});

describe('a crafted shared DAG declines from its size, not by writing it out', () => {
  const nodes = scan({ id: relId('n'), table: 'nodes', alias: 'n', channels: [], type: { cols: [{ name: 'id', type: 'int', nullable: false }] } });
  const over = (e: Expr): Plan => ({
    bindings: [],
    result: project({ id: relId('p'), input: nodes, channels: [], type: { cols: [{ name: 'v', type: 'any', nullable: true }] }, exprs: [['v', e]] }),
  });

  // THE cc-1 SHAPE: a running value named in a branch AND in the else arm, k levels deep. k nodes, 2^k text.
  const accumulator = (k: number): Expr => {
    let acc: Expr = col(nodes.id, 'id');
    for (let i = 0; i < k; i++) {
      const grown: Expr = { kind: 'binary', op: '+', left: acc, right: compilerInt(1) };
      acc = { kind: 'case', whens: [[{ kind: 'binary', op: '>', left: acc, right: compilerInt(i) }, grown]], else: acc };
    }
    return acc;
  };

  test('a small one renders, and its tree size is what it spells', () => {
    const plan = over(accumulator(4));
    const sql = renderedSteps(renderLowered(plan, new CompileBudget()))[0]!.emitted.sql;
    expect(spelledSize(plan.result)).toBeLessThanOrEqual(sql.length);
  });

  test('a shared expression 60 levels deep declines in milliseconds', () => {
    const { error, ms } = declineOf(() => renderLowered(over(accumulator(60)), new CompileBudget()));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect(ms).toBeLessThan(100);
  });

  // The relational twin: a scalar subquery read twice per level. A `Ref` would share it; inline, it is
  // spelled per use, so the checker and the emitter both meet 2^k subqueries.
  test('a shared subplan 60 levels deep declines in milliseconds', () => {
    const one = { cols: [{ name: 'v', type: 'int', nullable: false }] } as const;
    let sub: Rel = values({ id: relId('v0'), channels: [], type: one, rows: [[compilerInt(1)]] });
    for (let i = 1; i <= 60; i++) {
      const read: Expr = { kind: 'scalar', plan: sub };
      sub = project({ id: relId(`s${i}`), input: values({ id: relId(`w${i}`), channels: [], type: one, rows: [[compilerInt(1)]] }), channels: [], type: one, exprs: [['v', { kind: 'binary', op: '+', left: read, right: read }]] });
    }
    const { error, ms } = declineOf(() => renderLowered({ bindings: [], result: sub }, new CompileBudget()));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect(ms).toBeLessThan(100);
  });
});
