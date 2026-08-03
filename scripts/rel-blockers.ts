#!/usr/bin/env bun
/**
 * THE WORKLIST INSTRUMENT — where does the RelIR fold GIVE UP, per step and per FAMILY.
 *
 * An INSTRUMENT and not a gate (the `orphans` standing): every number here is a question about what to
 * do next, and none of them has a right answer the build could check.
 *
 * ## Why it counts where the fold gives up, not what a step would buy
 *
 * The earlier measure was marginal: admit step X to the covered set and count the chains that become
 * fully covered. It assumes the REST of the chain is already covered, which is exactly what is false
 * early on — `inject` measured worth ZERO by that method and was worth +81, because every traversal it
 * heads also contains steps the fold had not learned. Taking the longest prefix that lowers and naming
 * the step AFTER it assumes nothing.
 *
 * ## Why the FAMILY total is the number to rank by
 *
 * Per-step counts systematically understate a vocabulary: the scalar transforms are eighteen step names
 * whose largest member blocks 60 traversals and which together block 153, and no per-step table can
 * show that. They are also one lowering — a transform is an expression over the traverser's value plus,
 * for the `as*` casts, a framing retype — so landing the family is barely more work than landing its
 * largest member. That is the whole argument for ranking by family (§10·7/§10·8): a family closes
 * cleanly, a step leaves a ragged edge, and the ragged edge is what makes the NEXT increment expensive.
 *
 * A step that is in no family below is listed separately rather than silently dropped — the residue is
 * where the next family gets recognized, and `inject` sat in it for two rounds before being spotted.
 */
import { extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import type { IRStep } from '../src/compiler/ir/step.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';

const CORPUS = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);

/**
 * The FAMILIES, by what a single lowering would have to say — not by TinkerPop's package layout.
 *
 * `fold`/`unfold` are together because both are the LIST shape's boundary; `as`/`select` because both
 * are the alias channel; the reducers because all of them are one `Aggregate` reading row→traverser
 * cardinality off the plan. A grouping that followed step names rather than lowerings would rank the
 * wrong thing, which is the failure mode this file exists to avoid.
 */
const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  writes: ['addV', 'addE', 'property', 'mergeV', 'mergeE', 'drop'],
  'side effects': ['aggregate', 'store', 'cap', 'sack', 'groupCount', 'group'],
  'scalar transforms': ['concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
    'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff', 'math', 'format'],
  aliases: ['as', 'select'],
  'the list shape': ['fold', 'unfold'],
  'the property shape': ['properties', 'valueMap', 'elementMap', 'propertyMap', 'key', 'value'],
  branch: ['union', 'choose', 'coalesce', 'optional'],
  'row ops (4.1)': ['order', 'dedup', 'limit', 'skip', 'range', 'tail', 'sample'],
  reducers: ['sum', 'min', 'max', 'mean', 'count'],
};

const blockedAt = new Map<string, number>();
let covered = 0, unparsed = 0;

for (const query of CORPUS) {
  let steps: IRStep[];
  try {
    const tree = parseGremlin(query);
    steps = runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}).steps as IRStep[];
  } catch { unparsed++; continue; }
  if (!steps.length) continue;
  let longest = 0;
  for (let n = 1; n <= steps.length; n++) {
    // A throw ends the prefix as a decline does. `mise run rel-sweep` is what asserts there are none;
    // here it would only distort the count to treat one differently.
    try { if (lowerToRel(steps.slice(0, n))) longest = n; else break; } catch { break; }
  }
  if (longest === steps.length) { covered++; continue; }
  // When even the SOURCE declines, the source is the blocker.
  const step = steps[longest]?.name ?? steps[0]!.name;
  blockedAt.set(step, (blockedAt.get(step) ?? 0) + 1);
}

const total = (members: readonly string[]) => members.reduce((sum, m) => sum + (blockedAt.get(m) ?? 0), 0);
const breakdown = (members: readonly string[]) => members
  .map((m) => [m, blockedAt.get(m) ?? 0] as const).filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}:${n}`).join(' ');

console.log(`rel-blockers: ${covered}/${CORPUS.length} corpus traversals fully covered (${unparsed} unparsed — L1's business, not this one)\n`);
console.log('  BY FAMILY — the number to rank by:');
for (const [name, members] of Object.entries(FAMILIES).sort((a, b) => total(b[1]) - total(a[1])))
  console.log(`  ${String(total(members)).padStart(4)}  ${name.padEnd(19)} ${breakdown(members)}`);

const inAFamily = new Set(Object.values(FAMILIES).flat());
const residue = [...blockedAt].filter(([step]) => !inAFamily.has(step)).sort((a, b) => b[1] - a[1]);
console.log('\n  IN NO FAMILY — where the next family gets recognized:');
console.log(`  ${residue.map(([step, n]) => `${step}:${n}`).join(' ')}`);
