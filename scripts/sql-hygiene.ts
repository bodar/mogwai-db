#!/usr/bin/env bun
/**
 * RelIR SQL HYGIENE — complete authored corpus plans, not the synthetic prefixes rel-sweep owns.
 *
 * The walker counts literal provenance before rendering; bind positions in a rendered string cannot
 * answer that question because a fused expression may occur more than once.  The platform authority
 * still sees every rendered statement, including each retained write effect.
 */
import { cfLimitViolation } from '../src/cf-limits.ts';
import { compile } from '../src/compiler/compiler.ts';
import { extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';
import { emit } from '../src/rel/emit.ts';
import { bindsAsParameter, type Expr } from '../src/rel/expr.ts';
import { forEachExpr, forEachRel, relExprs, stmtChildren, stmtExprs } from '../src/rel/walk.ts';
import { isStmt } from '../src/rel/stmt.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { MODERN_SEED } from '../test/fixtures/seed-modern.ts';
import { exec, executeQuery } from '../test/support/executor.ts';
import { decodeAll } from '../test/support/decode.ts';

const corpus = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);
const verbose = Bun.argv.includes('--verbose');
const json = Bun.argv.includes('--json');
const expected = JSON.parse(await Bun.file(new URL('./sql-hygiene-baseline.json', import.meta.url)).text()) as Record<string, Metric>;
/**
 * RelIR is intentionally ahead of the legacy SQL in these cases. Each witness is asserted by the
 * vendored reference corpus under the pinned TinkerPop revision; do not add a row without one.
 */
const RELIR_AHEAD = new Map([
  ['g.V().group().by(__.values("name").substring(0,1)).by(__.constant(1))', 'gremlin-test/.../sideEffect/Group.feature g_V_group_byXvaluesXnameX_substringX1XX_byXconstantX1XX'],
  ['g.inject("foo").is(P.gt(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXfooX_gtX1dX'],
  ['g.inject("foo").is(P.gte(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXfooX_gteX1dX'],
  ['g.inject(1.0d).is(P.lt("foo"))', 'gremlin-test/.../semantics/Comparability.feature mixed numeric/string ordering'],
  ['g.inject(1.0d).is(P.lte("foo"))', 'gremlin-test/.../semantics/Comparability.feature mixed numeric/string ordering'],
  ['g.inject(1.0d).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectX1dX_neqXNaNX'],
  ['g.inject(NaN).is(P.neq(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXNaNX_neqX1dX'],
  ['g.inject(NaN).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectXNaNX_neqXNaNX'],
  ['g.inject(null).is(P.neq(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXnullX_neqX1dX'],
  ['g.inject(null).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectXnullX_neqXNaNX'],
]);

interface Metric { binds: number; bytes: number; compiler: number; bound: number; }
const maxima = new Map<string, Metric>();
const failures: string[] = [];
let admitted = 0;
let statements = 0;
let pairedReads = 0;
const store = new GraphStore(new BunSqlite(':memory:'));
for (const seed of MODERN_SEED) executeQuery(store, seed, {});
/** Map iteration order is not Gremlin map equality. Lists remain ordered. */
const canon = (value: any): any =>
  value instanceof Map ? ['map', [...value].map(([key, item]) => [canon(key), canon(item)])
    .sort(([a], [b]) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
  : Array.isArray(value) ? value.map(canon)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canon(item)]))
  : typeof value === 'bigint' ? ['bigint', value.toString()]
  : Number.isNaN(value) ? ['nan'] : value;
const comparable = async (query: string, spine: 'rel' | 'legacy') => {
  try { return { ok: true as const, value: JSON.stringify((await decodeAll(exec(store, undefined, undefined, spine).buffers(query, {}))).map(canon)) }; }
  catch (error) { return { ok: false as const, error: (error as Error).message }; }
};

const countExpr = (expr: Expr, counts: { compiler: number; bound: number }): void =>
  forEachExpr(expr, (node) => {
    if (node.kind !== 'lit') return;
    // A user PARAMETER and a mechanical `'bound'` bind both render as a `?`; only a `compiler-*`
    // constant inlines. Count by what BINDS, so the budget number tracks the DO's real measure.
    if (bindsAsParameter(node)) counts.bound++;
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
  // The terminal step is the vocabulary family whose generated statement this is; a whole chain
  // would turn every corpus spelling into a separate baseline and would not detect a family regression.
  const family = steps.at(-1)?.name ?? 'empty';
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
  // THE TWO COMPILES ARE SPLIT, and it is §6·1 rather than tidiness: RelIR answering where legacy
  // DECLINES is the migration — legal, expected, and the whole point of the coverage counter — so a
  // legacy throw here is not a hygiene violation. Catching both together made it one the moment a
  // family started routing (measured: `mergeE` with `option(Merge.outV, …)`, which legacy sheds).
  // A RelIR throw stays a failure: `lowerToRel` already ADMITTED this plan above, so failing to
  // compile it is this route contradicting itself.
  let rel;
  try { rel = compile(query, {}, { spine: 'rel' }); }
  catch (error) { failures.push(`${query}: RelIR admitted the plan, then failed to compile it: ${(error as Error).message}`); continue; }
  let legacy;
  try { legacy = compile(query, {}, { spine: 'legacy' }); }
  catch { continue; }
  try {
    if (rel.kind === 'read' && rel.spine === 'rel' && legacy.kind === 'read') {
      pairedReads++;
      for (const [route, plan] of [['rel', rel], ['legacy', legacy]] as const) {
        const violation = cfLimitViolation(plan.sql, plan.binds);
        if (violation) failures.push(`${query} [${route}]: ${violation}`);
      }
      if (!steps.some((step) => step.name === 'sample')) {
        const [relAnswer, legacyAnswer] = await Promise.all([comparable(query, 'rel'), comparable(query, 'legacy')]);
        // A malformed literal is not an executable paired read; the front-end's common refusal is
        // already L1's contract. A one-sided failure remains a hygiene failure.
        if (relAnswer.ok !== legacyAnswer.ok) failures.push(`${query}: only one spine frames the read`);
        else if (relAnswer.ok && legacyAnswer.ok && relAnswer.value !== legacyAnswer.value && !RELIR_AHEAD.has(query))
          failures.push(`${query}: RelIR and legacy framed answers differ`);
      }
    }
  } catch (error) {
    failures.push(`${query}: paired compile/frame failed: ${(error as Error).message}`);
  }
}

const baseline = Object.fromEntries([...maxima].sort(([a], [b]) => a.localeCompare(b)));
const ratchetFailures: string[] = [];
for (const [family, metric] of Object.entries(baseline)) {
  const prior = expected[family];
  if (!prior) {
    ratchetFailures.push(`${family}: new traversal family needs an explicit baseline`);
    continue;
  }
  // `bound` is ratcheted alongside `binds`/`bytes` to assert the parameter-budget target DIRECTLY: a
  // held constant (a parsed literal, an ordinal, a class name, a key/id) must render as a typed SQL
  // literal, never a bind. So the count of `source: 'bound'` lits per family may only FALL — a rise
  // means a constant leaked back into the bind budget (docs/archive/2026-08-05-parameters-are-the-only-binds.md).
  // A genuinely new query/store data bind is the one legitimate rise, and it moves the baseline with a
  // reason, exactly as a `bytes`/`binds` rise does.
  for (const field of ['binds', 'bytes', 'bound'] as const)
    if (metric[field] > prior[field])
      ratchetFailures.push(`${family}: ${field} rose from ${prior[field]} to ${metric[field]}`);
}
for (const family of Object.keys(expected))
  if (!baseline[family]) ratchetFailures.push(`${family}: baseline family no longer has coverage`);
if (json) {
  console.log(JSON.stringify(baseline, null, 2));
  if (ratchetFailures.length) throw new Error(`sql-hygiene: ${ratchetFailures.length} ratchet violation(s)`);
  process.exit(0);
} else {
  console.log(`sql-hygiene: ${admitted} admitted authored RelIR plans, ${statements} executable statement(s)`);
  console.log(`sql-hygiene: ${pairedReads} paired read(s) framed against the modern seed`);
  console.log(`sql-hygiene: ${maxima.size} traversal family baseline(s)`);
  if (verbose) for (const [family, metric] of Object.entries(baseline))
    console.log(`  ${family}\tbinds=${metric.binds}\tbytes=${metric.bytes}\tcompiler=${metric.compiler}\tbound=${metric.bound}`);
}
if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.log(`  FAIL ${failure}`);
  throw new Error(`sql-hygiene: ${failures.length} violation(s)`);
}
if (ratchetFailures.length) {
  for (const failure of ratchetFailures) console.log(`  RATCHET ${failure}`);
  throw new Error(`sql-hygiene: ${ratchetFailures.length} ratchet violation(s)`);
}
console.log('sql-hygiene: 0 DO-wall violations; literal provenance counted before emission');
