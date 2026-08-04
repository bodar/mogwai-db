#!/usr/bin/env bun
/**
 * THE DECLINE-CONTRACT GATE — `lowerToRel` returns a plan or `null`, and NEVER throws.
 *
 * That contract is the whole reason the dual spine is safe (§10·4): a covered chain routes RelIR, an
 * uncovered one declines and the legacy spine answers it exactly as it does today. A THROW from the
 * lowering is neither — it is the new spine raising an error on a traversal the old one compiles
 * fine, which is a support REGRESSION rather than a deferral. Nothing else in the suite can see it,
 * because `compileViaRel` is only reached along paths the router already thinks are covered.
 *
 * ## Why a sweep rather than tests
 *
 * The defects this finds are not in a step's own lowering; they are in the COMBINATION of a step with
 * chain-global state the step never mentions. Both it has caught were of that shape:
 *
 *   - a `collapse` requested on a chain that also demands an emission order built a plan whose
 *     declared type promised a position column the projection had dropped (2026-08-02);
 *   - a post-movement `Filter` naming `BULK` rather than passing its input's channels through dropped
 *     the position under `demandsEncounter` — RelIR threw where legacy answered (2026-08-03).
 *
 * Neither is reachable by writing a test for the step, because neither step is wrong. So the sweep
 * enumerates the product of every corpus PREFIX with every configuration the compiler can hand the
 * lowering, which is the smallest space that contains both.
 *
 * ## The three chain shapes, and why the last two exist
 *
 * `demandsEncounter` is a chain-GLOBAL fact (`analyzeChain`), so a prefix that never slices can only
 * ever be lowered UNORDERED — and the ordered position is exactly where a hardcoded channel list goes
 * wrong. Appending a `limit(1)` makes every prefix demand an order; INSERTING one right after the
 * source additionally forces every later filter out of the source-scope phase (where the relation has
 * no channels at all) and into the id-relation phase, which is the position that threads them. The
 * 2026-08-03 defect is invisible without that third shape: no corpus traversal has an
 * `E().limit(…).has(…)` prefix, and L5 found it only because its generated corpus happened to.
 *
 * Zero violations IS the gate — deliberately not a ratchet, so a new one fails the build rather than
 * widening an allowlist (the `arch`/`lint`/`binds` standing).
 */
import { extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import type { IRStep } from '../src/compiler/ir/step.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';
import { DO_BIND_CAP, planBindCount } from '../src/rel/check.ts';
import { emit, emitRelational } from '../src/rel/emit.ts';
import { retained } from '../src/rel/plan.ts';
import { render } from '../src/sql/kernel/q.ts';

const CORPUS = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);

/**
 * ## Sharding, and why the parent spawns rather than the workflow fanning out
 *
 * The sweep was the single longest pole in the gate once the suite was split across runners: 105s on a
 * CI runner, against 56s for the longest test shard. The corpus loop is embarrassingly parallel (each
 * traversal is independent), so it shards by index across child processes of this same script.
 * Measured here, one run each: 54.8s at 1 → 32.5s at 2 → 22.0s at 4 → 19.3s at 6.
 *
 * Doing it here rather than as a CI matrix keeps `mise run rel-sweep` one command that behaves the same
 * everywhere, and keeps the shards on the four cores of ONE runner instead of paying a fresh provision
 * on four.
 *
 * `min(4, cores)` by default — 4 because that is what a CI runner has, and capped because the shards do
 * not scale for free: total cpu goes 63s at 1 → 99s at 4 → 139s at 6, each re-paying JIT warmup on the
 * same hot lowering loop. Past the core count that trade only worsens.
 *
 * Free inside `mise run ci` too, which is the case worth checking rather than assuming: there the sweep
 * runs alongside `bun test`, and a matched pair on the same commit gave the same 76s wall either way —
 * the sweep went 59.5s → 27.0s while `test` stayed at ~74.5s and remained the pole. So the fan-out
 * shortens the sweep's own CI job without lengthening the one command a developer runs.
 *
 * A child reports as JSON and the parent merges in SHARD ORDER, so `first at` stays deterministic —
 * it is the lowest shard index that saw the message, and within a shard the first chain, which is the
 * same "one entry per root cause" discipline as before and not a per-prefix list.
 */
const SHARDS = Number(Bun.env.SWEEP_SHARDS ?? Math.min(4, navigator.hardwareConcurrency || 1));
const SHARD = Bun.env.SWEEP_SHARD === undefined ? null : Number(Bun.env.SWEEP_SHARD);
if (!Number.isInteger(SHARDS) || SHARDS < 1) throw new Error(`SWEEP_SHARDS must be a positive integer, got ${Bun.env.SWEEP_SHARDS}`);

if (SHARD === null && SHARDS > 1) {
  // PARENT: fan out, merge, report. Deliberately not `--shard`-flag driven — the env var is what a
  // child inherits, and a child re-running this file is the whole mechanism.
  type Report = { violations: [string, string][]; accounting: [string, string][]; swept: number; emitted: number};
  const children = Array.from({ length: SHARDS }, (_unused, index) =>
    Bun.spawn(['bun', import.meta.path], {
      env: { ...process.env, SWEEP_SHARDS: String(SHARDS), SWEEP_SHARD: String(index) },
      stdout: 'pipe', stderr: 'inherit',
    }));
  // Drained CONCURRENTLY, not one child at a time: a sequential read blocks on child 0 while the
  // others can fill their pipe buffers, which is a deadlock waiting for a bigger report.
  const reports = await Promise.all(children.map(async (child) => {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    // A child that died without a report is a failure of the sweep, not a clean run: say so and stop
    // rather than merging a hole and printing "0 violations".
    if (code !== 0 || !text.trim()) {
      console.log('rel-sweep: a shard exited without reporting — see the error above');
      process.exit(1);
    }
    return JSON.parse(text) as Report;
  }));
  const merged = { violations: new Map<string, string>(), accounting: new Map<string, string>(), swept: 0, emitted: 0 };
  for (const shard of reports) {
    for (const [message, where] of shard.violations) if (!merged.violations.has(message)) merged.violations.set(message, where);
    for (const [message, where] of shard.accounting) if (!merged.accounting.has(message)) merged.accounting.set(message, where);
    merged.swept += shard.swept; merged.emitted += shard.emitted;
  }
  report(merged.violations, merged.accounting, merged.swept, merged.emitted, SHARDS);
}

/** The synthetic slice. `limit(1)` and not `range`/`tail`: it is the cheapest step that makes
 *  `analyzeChain` demand an emission order, and what is under test is the ORDER, not the slice. */
const SLICE = { name: 'limit', args: [1] } as unknown as IRStep;
type Shape = 'authored' | 'ordered' | 'ordered-at-source';

const violations = new Map<string, string>();
/** The bind-accounting violations, kept apart because they are a different property (below). */
const accounting = new Map<string, string>();
let swept = 0;
let emitted = 0;

/**
 * THE ADMITTED COUNT MUST BOUND THE ENFORCED COUNT.
 *
 * `lowerToRel` declines above the cap on `planBindCount`, which counts IR OCCURRENCES; the wall
 * counts the RENDERED bind list, and the two are different numbers — the assembler can spell one
 * `Lit` more than once when it fuses a clause reader into the block that computes its subject
 * (measured in the algebra: 91 occurrences rendering as 181 binds). A seam that admits on the first
 * and meets the wall on the second admits on a number that is not the wall, and the refusal then
 * arrives past the point where another route could have been chosen — the fail-closed violation the
 * routing switch cannot absorb.
 *
 * `renderedSteps` therefore renders and asks the real list, so the property swept here is the one that
 * matters: **a plan the seam ADMITTED renders within the platform cap.** It is what makes the wall
 * unreachable from the routing decision rather than merely unlikely.
 *
 * The divergence is real and reachable, which is why this is swept rather than assumed: measured
 * over every corpus prefix before the fix, 50 distinct prefixes rendered MORE binds than were
 * counted, the widest 42 against 31. None crossed 100 on today's corpus — the cheap count would
 * have looked correct for exactly as long as that held.
 *
 * Each executable step's count, one statement for a read and N for a program. Not `emitQuery`, which
 * refuses above the cap itself: this must measure what an ADMITTED plan renders, so the counting and
 * the refusal stay separable and a violation reports a NUMBER. A PROGRAM is measured PER STEP,
 * because each of its statements meets the wall on its own — summing them would report a number no
 * database ever asks.
 */
const renderedSteps = (plan: Parameters<typeof planBindCount>[0]): readonly number[] =>
  plan.bindings.some((binding) => retained(binding))
    ? emit(plan).map((step) => step.emitted.binds.length)
    : [render(emitRelational(plan)).binds.length];

/** Sweep ONE configuration, recording both properties above. */
function sweepOne(chain: IRStep[], collapse: boolean, correlatedChildren: boolean, at: () => string): void {
  try {
    const lowered = lowerToRel(chain, { collapse, correlatedChildren });
    if (!lowered) return;
    const rendered = renderedSteps(lowered.plan);
    emitted++;
    const widest = Math.max(...rendered);
    if (widest > DO_BIND_CAP) {
      const message = `an admitted plan renders ${widest} binds, above the cap of ${DO_BIND_CAP}`;
      if (!accounting.has(message)) accounting.set(message, at());
    }
  } catch (error) {
    // One entry per MESSAGE, with the first chain that produced it — the same "one entry per root
    // cause" discipline L5's `known.ts` uses, because one dropped channel shows up on hundreds of
    // prefixes and a per-prefix list would bury the count.
    const message = (error as Error).message.split('\n')[0]!.slice(0, 100);
    if (!violations.has(message)) violations.set(message, at());
  }
}

/**
 * NOTHING HERE IS RE-SWEPT — measured, after assuming otherwise.
 *
 * The corpus shares prefixes heavily (6,878 prefixes over 2,298 traversals are only 3,388 distinct
 * chains by step NAME AND ARGS), so half the combinations look like exact repeats, and memoizing them
 * looked like a free 18%. It is not: `runPasses` annotates each step with the analysis its position in
 * ITS chain implies, so two same-named steps are different inputs to `lowerToRel`. Keyed on the whole
 * step object the duplicate count is exactly ZERO.
 *
 * Recorded because the cheap key does not merely under-save, it MIS-SAVES: with a name+args key the
 * sweep skipped 41,880 of 82,536 combinations and looked 18% faster, and a fingerprint comparison then
 * caught 47 pairs that disagreed — `V.limit.group [ordered-at-source]` rendering 16 binds where the
 * "same" combination had rendered 13. So the fast version of this gate was a QUIETLY NARROWER gate,
 * which is the one thing it must not be. The saving is in the shards above instead.
 */
for (const [index, query] of CORPUS.entries()) {
  if (SHARD !== null && index % SHARDS !== SHARD) continue;
  let steps: IRStep[];
  // A traversal the FRONT END rejects is not this gate's business — L1 owns parse coverage.
  try {
    const tree = parseGremlin(query);
    steps = runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}).steps as IRStep[];
  } catch { continue; }
  if (!steps.length) continue;

  for (let n = 1; n <= steps.length; n++) {
    const prefix = steps.slice(0, n);
    for (const shape of ['authored', 'ordered', 'ordered-at-source'] as Shape[]) {
      const chain = shape === 'authored' ? prefix
        : shape === 'ordered' ? [...prefix, SLICE]
          : [prefix[0]!, SLICE, ...prefix.slice(1)];
      // Both fast-path switches the lowering reads, in both positions: each selects between two
      // lowering STRATEGIES, so each is a configuration the compiler really can hand it.
      for (const collapse of [true, false]) for (const correlatedChildren of [true, false]) {
        swept++;
        const at = () => `${chain.map((step) => step.name).join('.')}  [${shape} collapse=${collapse} correlatedChildren=${correlatedChildren}]`;
        sweepOne(chain, collapse, correlatedChildren, at);
      }
    }
  }
}

// A CHILD reports; the parent merges and does the printing. stdout is the channel, so a child must
// print nothing else — hence `stderr: 'inherit'` on the spawn, which is where a real error goes.
if (SHARD !== null) {
  console.log(JSON.stringify({ violations: [...violations], accounting: [...accounting], swept, emitted }));
  process.exit(0);
}
report(violations, accounting, swept, emitted, 1);

/** The one report, so a sharded run and a single-process run are indistinguishable in output.
 *  A declaration, not a const arrow: the parent branch above calls it before this line. */
function report(
  violations: Map<string, string>, accounting: Map<string, string>,
  swept: number, emitted: number, shards: number,
): never {
  const how = shards > 1 ? `, ${shards} shards` : '';
  console.log(`rel-sweep: ${swept} prefix × shape × switch combinations over ${CORPUS.length} corpus traversals${how}`);
  console.log(`rel-sweep: ${emitted} admitted plans rendered — every one within the ${DO_BIND_CAP}-bind platform cap`);
  if (!violations.size && !accounting.size) {
    console.log('rel-sweep: 0 violations — the decline contract and the bind accounting both hold');
    process.exit(0);
  }
  for (const [message, where] of violations) console.log(`  THROW ${message}\n        first at ${where}`);
  for (const [message, where] of accounting) console.log(`  BINDS ${message}\n        first at ${where}`);
  if (violations.size) console.log(`\nrel-sweep: ${violations.size} distinct decline violation(s) — lowerToRel must DECLINE, never throw`);
  if (accounting.size) console.log(`\nrel-sweep: ${accounting.size} distinct bind-accounting violation(s) — a plan the seam admits must render within the platform cap`);
  process.exit(1);
}
