#!/usr/bin/env bun
/**
 * RelIR SQL HYGIENE — complete authored corpus plans, not the synthetic prefixes rel-sweep owns.
 *
 * The walker counts literal provenance before rendering; bind positions in a rendered string cannot
 * answer that question because a fused expression may occur more than once.  The platform authority
 * still sees every rendered statement, including each retained write effect.
 */
import { cfLimitViolation } from '../src/cf-limits.ts';
import { ValueParseError } from '../src/gremlin/coerce.ts';
import { UnsupportedTraversal, compile } from '../src/compiler/compiler.ts';
import { extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';
import { emit } from '../src/rel/emit.ts';
import { bindsAsParameter, type Expr } from '../src/rel/expr.ts';
import { forEachExpr, forEachRel, relExprs, stmtChildren, stmtExprs } from '../src/rel/walk.ts';
import { isStmt } from '../src/rel/stmt.ts';

const corpus = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);
const verbose = Bun.argv.includes('--verbose');
const json = Bun.argv.includes('--json');
/** Bank the new baseline in place — see the `--record` block near the bottom for which ratchet
 *  failures a recorder may legitimately bank and which one it must refuse. */
const record = Bun.argv.includes('--record');
const expected = JSON.parse(await Bun.file(new URL('./sql-hygiene-baseline.json', import.meta.url)).text()) as Record<string, Metric>;
/**
 * Each witness is asserted by the vendored reference corpus under the pinned TinkerPop revision; do
 * not add a row without one.
 */

interface Metric { binds: number; bytes: number; compiler: number; bound: number; }
const maxima = new Map<string, Metric>();
const failures: string[] = [];
/** Vestigial telemetry: the differential it once fed is gone, so nothing populates it and the summary
 *  line's count is always 0. Emission order was reported there, never gated — exactly as the census
 *  treats the same fact. */
const reordered: string[] = [];
/** Vestigial telemetry: the differential it once fed is gone, so nothing populates it and the summary
 *  line's count is always 0. */
const diverged: string[] = [];
let admitted = 0;
let statements = 0;
let pairedReads = 0;
/** Map iteration order is not Gremlin map equality. Lists remain ordered. */
const canon = (value: any): any =>
  value instanceof Map ? ['map', [...value].map(([key, item]) => [canon(key), canon(item)])
    .sort(([a], [b]) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
  : Array.isArray(value) ? value.map(canon)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canon(item)]))
  : typeof value === 'bigint' ? ['bigint', value.toString()]
  : Number.isNaN(value) ? ['nan'] : value;
/**
 * Vestigial telemetry from the retired differential — the `value`/`multiset` comparison it described
 * no longer runs, so `reordered`/`diverged` stay empty.
 *
 * The durable facts it rested on still hold: a traversal that does not call `order()` has no
 * specified emission order — traversers are a multiset (root `CLAUDE.md`) — so emission order is
 * telemetry that never gates, exactly as `test/L7-census/` treats it (it gates on "no executing
 * traversal changes its answer" and reports emission-order change as telemetry). The order `order()`
 * DOES specify is an `ORDER BY` in the emitted SQL and therefore survives any plan change.
 */

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
  // A traversal whose ANSWER is an error (a literal that cannot parse — `asNumber('1,000')`) raises
  // out of the lowering by design, and is not a plan to sweep. `null` is the other exit: not covered.
  let lowered;
  try { lowered = lowerToRel(steps, { correlatedChildren: true }); } catch { continue; }
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
  // THE COMPILE MUST NOT CONTRADICT THE LOWERING. `lowerToRel` ADMITTED this plan above, so a throw
  // out of the full compile is this route disagreeing with itself — a hygiene failure, not a decline.
  // ⚠️ THE TWO CALLS ASK DIFFERENT QUESTIONS, so only a THROW is a finding. This sweep lowers `steps`
  // with a bare environment while `compile` extracts the traversal's own — its `withSideEffect`
  // constants, its source options — so a chain the bare lowering admits can legitimately DECLINE with
  // the fuller one (§6·6: a fact the caller does not hand over is not a fact the algebra lacks).
  // A throw is different: the lowering already admitted this plan, so failing to render it is the
  // compile contradicting itself.
  try { compile(query, {}); }
  catch (error) {
    if (error instanceof UnsupportedTraversal || error instanceof ValueParseError) continue;
    failures.push(`${query}: the lowering admitted the plan, then the compile failed: ${(error as Error).message}`);
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
const lostCoverage = Object.keys(expected).filter((family) => !baseline[family]);
for (const family of lostCoverage) ratchetFailures.push(`${family}: baseline family no longer has coverage`);
/**
 * `--record` BANKS the new baseline, and the reason it lives in the script rather than in a shell
 * redirect is that not every ratchet failure means the same thing to a recorder.
 *
 * A `binds`/`bytes`/`bound` RISE and a NEW family are what you are recording — refusing them would
 * make the recorder unable to record, so it prints them and banks anyway; the justification belongs
 * in the commit message, which is what the ratchet is actually for.
 *
 * **LOST COVERAGE is the one that does not.** A family in the baseline with no plan behind it any
 * more means the corpus stopped reaching a lowering, and banking that would delete the evidence
 * instead of moving it — the ratchet would come back green having quietly forgotten what it was
 * measuring. So it fails, names the families, and banks nothing.
 *
 * This was `bun scripts/sql-hygiene.ts --json > … || true` in `mise.toml` for exactly one commit.
 * That form had to swallow the exit code (the `--json` path prints and THEN throws on the rises it
 * just found), and swallowing it took the coverage check with it — a real regression made invisible
 * by a shell idiom, which is why the decision moved in here where the three cases are separable.
 */
if (record) {
  const path = new URL('./sql-hygiene-baseline.json', import.meta.url);
  if (lostCoverage.length) {
    for (const family of lostCoverage) console.log(`  LOST ${family}`);
    throw new Error(`sql-hygiene --record: ${lostCoverage.length} family/families lost coverage; banked nothing`);
  }
  await Bun.write(path, `${JSON.stringify(baseline, null, 2)}\n`);
  const moved = ratchetFailures.filter((failure) => !failure.includes('no longer has coverage'));
  for (const failure of moved) console.log(`  BANKED ${failure}`);
  console.log(`sql-hygiene --record: banked ${Object.keys(baseline).length} families, ${moved.length} ratchet move(s) — put the reason in the commit message`);
  process.exit(0);
}
if (json) {
  console.log(JSON.stringify(baseline, null, 2));
  if (ratchetFailures.length) throw new Error(`sql-hygiene: ${ratchetFailures.length} ratchet violation(s)`);
  process.exit(0);
} else {
  console.log(`sql-hygiene: ${admitted} admitted authored RelIR plans, ${statements} executable statement(s)`);
  console.log(`sql-hygiene: ${pairedReads} paired read(s) framed against the modern seed`);
  console.log(`sql-hygiene: ${maxima.size} traversal family baseline(s)`);
  // Same standing and same spelling as the census's own line: a number worth watching move, never a
  // gate. The NAMES are verbose-only, because 50-odd of them is a wall of text and the count is what
  // a reader is watching.
  console.log(`  ${reordered.length} spine emission-order difference(s) — telemetry, never gates`);
  console.log(`  ${diverged.length} spine framed-answer difference(s) — telemetry: RelIR follows the reference`);
  if (verbose) for (const query of diverged) console.log(`    ${query}`);
  if (verbose) for (const query of reordered) console.log(`  ORDER ${query}`);
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
