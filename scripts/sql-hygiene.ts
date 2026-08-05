#!/usr/bin/env bun
/**
 * RelIR SQL HYGIENE — complete authored corpus plans, not the synthetic prefixes rel-sweep owns.
 *
 * The walker counts literal provenance before rendering; bind positions in a rendered string cannot
 * answer that question because a fused expression may occur more than once.  The platform authority
 * still sees every rendered statement, including each retained write effect.
 */
import { cfLimitViolation } from '../src/cf-limits.ts';
import { extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';
import { emit } from '../src/rel/emit.ts';
import type { Expr } from '../src/rel/expr.ts';
import { forEachExpr, forEachRel, relExprs, stmtChildren, stmtExprs } from '../src/rel/walk.ts';
import { isStmt } from '../src/rel/stmt.ts';

const corpus = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);
const verbose = Bun.argv.includes('--verbose');

interface Metric { binds: number; bytes: number; compiler: number; bound: number; }
const maxima = new Map<string, Metric>();
const failures: string[] = [];
let admitted = 0;
let statements = 0;

const countExpr = (expr: Expr, counts: { compiler: number; bound: number }): void =>
  forEachExpr(expr, (node) => {
    if (node.kind !== 'lit') return;
    if (node.source === 'bound') counts.bound++;
    else counts.compiler++;
  });

for (const query of corpus) {
  let steps;
  try {
    const tree = parseGremlin(query);
    steps = runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}).steps;
  } catch { continue; }
  const lowered = lowerToRel(steps, { correlatedChildren: true });
  if (!lowered) continue;
  admitted++;
  const counts = { compiler: 0, bound: 0 };
  const seen = new Set<object>();
  const visitRel = (rel: Parameters<typeof forEachRel>[0]): void => forEachRel(rel, (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    relExprs(node).forEach((expr) => countExpr(expr, counts));
  });
  visitRel(lowered.plan.result);
  for (const binding of lowered.plan.bindings) {
    if (isStmt(binding.node)) {
      stmtExprs(binding.node).forEach((expr) => countExpr(expr, counts));
      stmtChildren(binding.node).forEach(visitRel);
    } else visitRel(binding.node);
  }
  const family = steps.map((step) => step.name).join('.') || 'empty';
  let rendered;
  try { rendered = emit(lowered.plan); }
  catch (error) { failures.push(`${query}: ${(error as Error).message}`); continue; }
  for (const [index, step] of rendered.entries()) {
    statements++;
    const violation = cfLimitViolation(step.emitted.sql, step.emitted.binds);
    if (violation) failures.push(`${query} [statement ${index + 1}]: ${violation}`);
    const next = { binds: step.emitted.binds.length, bytes: Buffer.byteLength(step.emitted.sql), compiler: counts.compiler, bound: counts.bound };
    const prior = maxima.get(family) ?? next;
    maxima.set(family, {
      binds: Math.max(prior.binds, next.binds), bytes: Math.max(prior.bytes, next.bytes),
      compiler: Math.max(prior.compiler, next.compiler), bound: Math.max(prior.bound, next.bound),
    });
  }
}

console.log(`sql-hygiene: ${admitted} admitted authored RelIR plans, ${statements} executable statement(s)`);
console.log(`sql-hygiene: ${maxima.size} traversal family baseline(s)`);
if (verbose) for (const [family, metric] of [...maxima].sort(([a], [b]) => a.localeCompare(b)))
  console.log(`  ${family}\tbinds=${metric.binds}\tbytes=${metric.bytes}\tcompiler=${metric.compiler}\tbound=${metric.bound}`);
if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.log(`  FAIL ${failure}`);
  throw new Error(`sql-hygiene: ${failures.length} violation(s)`);
}
console.log('sql-hygiene: 0 DO-wall violations; literal provenance counted before emission');
