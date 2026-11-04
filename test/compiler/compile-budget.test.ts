// THE COMPILE-WORK BUDGET (`CompileBudget`, `src/sql/kernel/budget.ts`). Three things it must hold, and
// none of them shows in an answer:
//
//   - it NEVER refuses a plan whose SQL a Durable Object would accept. Every charge is a lower bound on one
//     statement's text; the instrument below measures that bound against the rendered text over the whole
//     L1 corpus, so a charge that starts over-counting fails here, not in production.
//   - a compile-cost regression is VISIBLE: the corpus's largest charge must stay under an eighth of the
//     budget. A change that makes some ordinary query's plan grow past that is the regression, whatever the
//     wall clock says.
//   - an expansion is refused EARLY: a shared node spelled 2^k times declines from its size, read off the
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

/** A decline. How EARLY it was decided is read off the work meter (`CompileBudget.peak`, the charge that
 *  fired), never a wall clock: the meter is deterministic, a timer is a property of the machine. */
const declineOf = (go: () => unknown): { readonly error: unknown } => {
  try { go(); } catch (error) { return { error }; }
  return { error: undefined };
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
    // The rendered TEXT fired, and the count is named from the unroll the lowering noted — not re-read
    // from the query. The body holds a barrier, so the loop is not offered: only phases can run it.
    expect((error as CompileBudgetExceeded).charged.kind).toBe('text');
    expect((error as Error).message).toBe('this traversal is not supported yet: it expands to more than 400 KB of SQL in one statement; '
      + 'repeat(…).times(800) unrolls its body 800 times — lower the count');
  });

  // A count the unroll's early charge alone refuses: decided before a phase is built. The proxy for "before
  // a phase is built" is the meter, not a wall clock: the unroll's charge fired, and nothing was charged.
  test('a count past the early charge declines before the lowering charges anything', () => {
    const budget = new CompileBudget();
    const { error } = declineOf(() => compile('g.V().repeat(__.out()).times(20000)', {}, { budget }));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect((error as CompileBudgetExceeded).charged).toEqual({ kind: 'unroll', times: 20000, steps: 20000, emit: false, advice: 'loop' });
    expect(budget.peak).toBe(0);
    expect((error as Error).message).toContain('400 KB of SQL');
    expect((error as Error).message).toContain('bound the loop with until(loops().is(n))');
  });

  // A FLAT statement that is mostly the user's LITERAL VALUES — a bulk upsert written as 40,000 literal maps.
  // No repeat(), nothing nests: the decline says the text is literal data spelled into the SQL, not bound
  // (the question "are we binding again?" answered in the product), and blames neither.
  test('a literal bulk upsert past the budget says it is literal text, not a nesting or a repeat()', () => {
    const maps = Array.from({ length: 40_000 }, (_, i) => `[name:'m${i}']`).join(',');
    const { error } = declineOf(() => compile(`g.inject(${maps}).mergeV()`, {}));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    expect((error as CompileBudgetExceeded).charged.kind).toBe('text');
    const message = (error as Error).message;
    expect(message).toStartWith('this traversal is not supported yet: it expands to more than 400 KB of SQL in one statement; '
      + 'most of it is literal values written into the query (');
    expect(message).toContain('spelled into the SQL text itself, not bound as parameters — send the values in smaller batches');
    expect(message).not.toContain('nest');
    expect(message).not.toContain('repeat(');
  }, 30_000);

  test('a count under the budget still compiles', () => {
    expect(compile('g.V().repeat(__.out()).times(1600)', {}).kind).toBe('read');
  });

  // THE cc-1 CLASS, in a real query, is GONE: a guarded string transform names its value in the type test
  // and again in the else arm, so each transform used to double the text — 30 levels was 2^30, refused here
  // off the DAG. The value run now spells its running value once per step (`valueRun`'s `once`), so the
  // same query is linear and simply compiles; the budget's early refusal of a doubling DAG is pinned by the
  // crafted shape below, and the run's linearity by `value-run-once.exec.test.ts`.
  test('a chain of thirty guarded transforms compiles, linearly', () => {
    const transforms = Array.from({ length: 30 }, (_, i) => (i % 2 ? '.toLower()' : '.toUpper()')).join('');
    const budget = new CompileBudget();
    const plan = compile(`g.V().where(__.values('name')${transforms}.is('x'))`, {}, { budget });
    // The work proxy: the largest charge the compile made (every charge is a lower bound on a statement's
    // text, and the passes' work is linear in it) — 2^30 would be refused, linear is a few KB.
    expect(budget.peak).toBeLessThan(40 * 1024);
    expect(plan.kind === 'read' ? plan.sql.length : Infinity).toBeLessThan(40 * 1024);
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

  test('a shared expression 60 levels deep declines from its size, not by writing it out', () => {
    const { error } = declineOf(() => renderLowered(over(accumulator(60)), new CompileBudget()));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    // Refused from the DAG's tree size, before a byte of its text is written — the work proxy for "fast".
    expect((error as CompileBudgetExceeded).charged.kind).toBe('plan');
  });

  // The relational twin: a scalar subquery read twice per level. A `Ref` would share it; inline, it is
  // spelled per use, so the checker and the emitter both meet 2^k subqueries.
  test('a shared subplan 60 levels deep declines from its size, not by writing it out', () => {
    const one = { cols: [{ name: 'v', type: 'int', nullable: false }] } as const;
    let sub: Rel = values({ id: relId('v0'), channels: [], type: one, rows: [[compilerInt(1)]] });
    for (let i = 1; i <= 60; i++) {
      const read: Expr = { kind: 'scalar', plan: sub };
      sub = project({ id: relId(`s${i}`), input: values({ id: relId(`w${i}`), channels: [], type: one, rows: [[compilerInt(1)]] }), channels: [], type: one, exprs: [['v', { kind: 'binary', op: '+', left: read, right: read }]] });
    }
    const { error } = declineOf(() => renderLowered({ bindings: [], result: sub }, new CompileBudget()));
    expect(error).toBeInstanceOf(CompileBudgetExceeded);
    // Refused from the DAG's tree size, before a byte of its text is written — the work proxy for "fast".
    expect((error as CompileBudgetExceeded).charged.kind).toBe('plan');
  });
});
