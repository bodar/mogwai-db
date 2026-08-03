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

const CORPUS = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);

/** The synthetic slice. `limit(1)` and not `range`/`tail`: it is the cheapest step that makes
 *  `analyzeChain` demand an emission order, and what is under test is the ORDER, not the slice. */
const SLICE = { name: 'limit', args: [1] } as unknown as IRStep;
type Shape = 'authored' | 'ordered' | 'ordered-at-source';

const violations = new Map<string, string>();
let swept = 0;

for (const query of CORPUS) {
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
        try { lowerToRel(chain, { collapse, correlatedChildren }); } catch (error) {
          // One entry per MESSAGE, with the first chain that produced it — the same "one entry per
          // root cause" discipline L5's `known.ts` uses, because one dropped channel shows up on
          // hundreds of prefixes and a per-prefix list would bury the count.
          const message = (error as Error).message.split('\n')[0]!.slice(0, 100);
          if (!violations.has(message))
            violations.set(message, `${chain.map((step) => step.name).join('.')}  [${shape} collapse=${collapse} correlatedChildren=${correlatedChildren}]`);
        }
      }
    }
  }
}

console.log(`rel-sweep: ${swept} prefix × shape × switch combinations over ${CORPUS.length} corpus traversals`);
if (!violations.size) {
  console.log('rel-sweep: 0 violations — the decline contract holds');
  process.exit(0);
}
for (const [message, where] of violations) console.log(`  THROW ${message}\n        first at ${where}`);
console.log(`\nrel-sweep: ${violations.size} distinct violation(s) — lowerToRel must DECLINE, never throw`);
process.exit(1);
