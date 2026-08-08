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
/** Bank the new baseline in place — see the `--record` block near the bottom for which ratchet
 *  failures a recorder may legitimately bank and which one it must refuse. */
const record = Bun.argv.includes('--record');
const expected = JSON.parse(await Bun.file(new URL('./sql-hygiene-baseline.json', import.meta.url)).text()) as Record<string, Metric>;
/**
 * RelIR is intentionally ahead of the legacy SQL in these cases. Each witness is asserted by the
 * vendored reference corpus under the pinned TinkerPop revision; do not add a row without one.
 */
const RELIR_AHEAD = new Map([
  ['g.V().group().by(__.values("name").substring(0,1)).by(__.constant(1))', 'gremlin-test/.../sideEffect/Group.feature g_V_group_byXvaluesXnameX_substringX1XX_byXconstantX1XX'],
  // The IMPLICIT PASS-THROUGH of an option-map `choose`. Only `Pick.none` is written and the choice
  // (`values("age")`) can be UNPRODUCTIVE, so the age-less vertices are claimed by neither written arm
  // and TinkerPop emits them WHOLE — the reference installs identity traversals for both `Pick` tokens
  // (`gremlin-core/.../branch/ChooseStep.java:65-81`). `Choose.feature:371-387` pins
  // `marko, vadas, v[lop], josh, v[ripple], peter`: RelIR answers exactly that, legacy answers
  // `lop`/`ripple` as STRINGS because its scalar CASE projector has one fallthrough and routes the
  // unproductive inputs into it. Legacy's own `lowerChooseOptions` documents the gap in place.
  ['g.V().choose(__.values("age")). option(P.between(26, 30), __.values("name")). option(Pick.none, __.values("name"))',
    'gremlin-test/.../branch/Choose.feature g_V_chooseXageX_optionXbetweenX26_30X_nameX_optionXnone_nameX'],
  // THE KEYED TWIN of the row above, and it needs no second argument — the same grouping, read back
  // through `cap()` instead of becoming the traverser. It arrived here the day the named-collection
  // substrate made `group("a")` route, which is worth noting: a shed capability does not become a new
  // divergence when a NEIGHBOURING family lands, it simply becomes VISIBLE. `Grouping.convertValueTraversal`
  // (gremlin-core, `step/Grouping.java:92-101`) appends `fold()` for a `ValueTraversal`/`TokenTraversal`/
  // `IdentityTraversal`/`ColumnTraversal` only; an anonymous CHILD is returned unchanged, so its
  // barrier is null and the bi-operator is `Operator.assign` — ONE value per key, not a list. RelIR
  // says `{j: 1}`, legacy says `{j: [1]}`, and the reference is with RelIR.
  ['g.V().group("a").by(__.values("name").substring(0,1)).by(__.constant(1)).cap("a")',
    'gremlin-test/.../sideEffect/Group.feature — the keyed twin; Grouping.java:92-101 appends fold() only for the four simple traversals'],
  // A BARRIER EMITS ONE TRAVERSER, so a global `count()` after `group()` is 1 and only
  // `count(Scope.local)` is the map's SIZE. `GroupStep extends ReducingBarrierStep<S, Map<K,V>>`
  // (gremlin-core, `step/map/GroupStep.java:51`) and `Count.feature:54` pins the local reading
  // (`g.V().fold().count(Scope.local)` → 6) as the one that counts CONTENTS. Legacy answers 2 for
  // BOTH spellings, which makes them indistinguishable — and it contradicts itself one shape over:
  // both spines already answer 1 for `g.V().fold().count()`, the same barrier with a list result.
  // It became visible the day the map stopped being terminal; before that RelIR declined the tail.
  ['g.V().group().by(label).count()',
    'gremlin-core/.../step/map/GroupStep.java:51 (a ReducingBarrierStep emits ONE traverser) + gremlin-test/.../map/Count.feature:54'],
  ['g.inject("foo").is(P.gt(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXfooX_gtX1dX'],
  ['g.inject("foo").is(P.gte(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXfooX_gteX1dX'],
  ['g.inject(1.0d).is(P.lt("foo"))', 'gremlin-test/.../semantics/Comparability.feature mixed numeric/string ordering'],
  ['g.inject(1.0d).is(P.lte("foo"))', 'gremlin-test/.../semantics/Comparability.feature mixed numeric/string ordering'],
  ['g.inject(1.0d).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectX1dX_neqXNaNX'],
  ['g.inject(NaN).is(P.neq(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXNaNX_neqX1dX'],
  ['g.inject(NaN).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectXNaNX_neqXNaNX'],
  ['g.inject(null).is(P.neq(1.0d))', 'gremlin-test/.../semantics/Comparability.feature InjectXnullX_neqX1dX'],
  ['g.inject(null).is(P.neq(NaN))', 'gremlin-test/.../semantics/Comparability.feature InjectXnullX_neqXNaNX'],
  // `project()` OMITS an unproductive key and keeps the traverser; legacy DROPS the traverser, which
  // is `select()`'s rule applied to the wrong host. The reference expects SIX rows, two of them
  // `m[{"a":…}]` with no `b` at all (Project.feature:84-90) — so RelIR is right and legacy is not.
  // Not fixed on legacy: its record framer has no per-field "absent" marker (`MapEntry` carries
  // `nullable` for an element only), so agreeing would mean growing the framing vocabulary of a route
  // with an end date. §6·1 — legacy sheds the shape.
  ['g.V().project("a", "b"). by(__.inE().count()). by("age")',
    'gremlin-test/.../map/Project.feature g_V_projectXa_bX_byXinE_countX_byXageX'],
  // The MIRROR of the row above, and the pair is worth reading together: `select()` DROPS a traverser
  // whose `by()` is unproductive (`break` → `EmptyTraverser`, SelectStep.java:74-81) where `project()`
  // omits the key and keeps it. Legacy has the two rules the wrong way round on both hosts. The
  // reference expects FOUR rows here — lop and ripple have no `age`, so they are gone entirely
  // (Select.feature:844-847), against legacy's six with a null `a`.
  ['g.V().as("a","n").select("a","n").by("age").by("name")',
    'gremlin-test/.../map/Select.feature g_V_asXa_nX_selectXa_nX_byXageX_byXnameX'],
]);

interface Metric { binds: number; bytes: number; compiler: number; bound: number; }
const maxima = new Map<string, Metric>();
const failures: string[] = [];
/** Traversals where the two spines return the SAME rows in a different order — telemetry, never a
 *  gate, exactly as the census treats the same fact. A number worth watching move, so it is printed
 *  on a green run too (the summary line below). */
const reordered: string[] = [];
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
/**
 * A framed answer as TWO comparisons, because the two spines agreeing on WHICH traversers come back
 * and agreeing on the ORDER they come back in are different claims with different standing.
 *
 * `value` is the ordered rendering; `multiset` is the same rows sorted, so it is blind to order and
 * to nothing else. Only the multiset GATES. A traversal that does not call `order()` has no
 * specified emission order — traversers are a multiset (root `CLAUDE.md`) — so two spines emitting
 * the same rows in different orders are both right, and failing the build on it would make any plan
 * change to either spine a build break.
 *
 * **This is the census's rule, not a new one.** `test/census/` gates on "no executing traversal
 * changes its answer" and reports emission-order change as telemetry that never gates; this script
 * measured the same axis and gated on it, which was the two instruments disagreeing about the
 * standing of one fact rather than a stricter check. Measured when the RelIR spine's join order was
 * pinned (`docs/2026-08-07-query-plan-stability.md` §3·2): 53 corpus traversals reordered, every one
 * of them multiset-identical, and BOTH spines' orders stable under `MOGWAI_REVERSE_UNORDERED=1` —
 * so neither was passing by luck, and neither was more correct.
 *
 * What this does NOT concede: an order the language DOES specify is `order()`'s, which is an
 * `ORDER BY` in the emitted SQL and therefore survives any plan change. If that ever diverges
 * between spines the rows themselves diverge with it, and the multiset gate below catches it.
 */
const comparable = async (query: string, spine: 'rel' | 'legacy') => {
  try {
    const rows = (await decodeAll(exec(store, undefined, undefined, spine).buffers(query, {}))).map(canon);
    const rendered = rows.map((row) => JSON.stringify(row));
    return { ok: true as const, value: JSON.stringify(rendered), multiset: JSON.stringify([...rendered].sort()) };
  } catch (error) { return { ok: false as const, error: (error as Error).message }; }
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
        else if (relAnswer.ok && legacyAnswer.ok && !RELIR_AHEAD.has(query)) {
          // WHICH ROWS gates; WHAT ORDER is telemetry. See `comparable` for why the two claims have
          // different standing, and for the measurement that separated them.
          if (relAnswer.multiset !== legacyAnswer.multiset) failures.push(`${query}: RelIR and legacy framed answers differ`);
          else if (relAnswer.value !== legacyAnswer.value) reordered.push(query);
        }
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
