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
 *
 * ## A blocker's step NAME is not always its family
 *
 * Measured 2026-08-03 at 349 routed: `inject` blocked 113 traversals, and **90 of them were blocked by a
 * COLLECTION argument** — `g.inject(["a","b"]).length()` needs the LIST traverser shape, and `inject`
 * itself is already covered. Attributing those to `inject` understated the list shape by 90 and made it
 * look like the fifth family instead of the second. So a blocker is attributed by its CAUSE where the
 * cause is decidable from the step's own arguments, and `blame()` below is the one place that happens.
 * Without it the instrument ranks the wrong work while looking precise, which is worse than a coarse
 * number honestly labelled.
 *
 * ## The blocked count is THREE populations, and "does legacy COMPILE it" is the wrong split
 *
 * A blocked traversal is one of: one some route already ANSWERS (migrating it closes the cut and the
 * answer is already known-correct), one NOBODY answers (lowering it is an outright L3 gain), or one no
 * L3 scenario runs at all (out of the suite's scope — it says nothing either way).
 *
 * ⚠️ **The earlier split asked `compilePlan(q, {}, {spine:'legacy'})` whether legacy COMPILES the
 * traversal, and that is a different question from whether legacy ANSWERS it.** Measured
 * 2026-08-09: every one of the eleven `aggregate` rows it reported as "a real gap the route answers"
 * is a traversal legacy compiles and silently MIS-answers — `register` keeps the last entry of a
 * `Map`, so a label filled at two chain positions discards the first site's members
 * (`src/compiler/steps/prefix/sideeffect.ts:163-164`). A family that ranking called cut-only was
 * worth ~9 L3 outright. So the split here is the CONFORMANCE RESULT, joined through
 * `test/L1-corpus/scenarios.tsv` — the scenario a traversal came from — against the two floors in
 * `test/L3-conformance/l3-state.json`. It is committed data, so this stays submodule-free and
 * needs no run.
 *
 * The `L3` column is the number to rank an increment by: the scenarios that would newly have a
 * chance of passing, counted per scenario rather than per traversal because that is the unit the
 * conformance floor moves in.
 *
 * ## `--step <name>` — the count is the ranking, the LIST is the increment
 *
 * A family total says what to do next; it says nothing about what the increment IS. That question —
 * which traversals, in which POSITION, with which argument forms — was answered by a throwaway script
 * every round, which is a re-derivation of what this file already computes. `--step mergeV` prints the
 * blocked traversals themselves, so the shape of the work is read off the instrument rather than
 * guessed at from a number.
 */
import { argValues, extractSack, extractSideEffects, extractStrategies, parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';
import type { IRStep } from '../src/compiler/ir/step.ts';
import { lowerToRel } from '../src/compiler/rel/lower.ts';

const CORPUS = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);

/** Which SCENARIOS name a traversal — many-to-many, emitted beside `corpus.txt` by `regen-corpus.ts`. */
const SCENARIOS = new Map<string, string[]>();
for (const line of (await Bun.file(new URL('../test/L1-corpus/scenarios.tsv', import.meta.url)).text()).split('\n')) {
  const tab = line.indexOf('\t');
  if (tab < 0) continue;
  const [name, query] = [line.slice(0, tab), line.slice(tab + 1)];
  const named = SCENARIOS.get(query);
  if (named) named.push(name); else SCENARIOS.set(query, [name]);
}

const L3_STATE = await Bun.file(new URL('../test/L3-conformance/l3-state.json', import.meta.url)).json();
/**
 * ANSWERED = the UNION of the two floors, because the question is "does ANY route answer it", and
 * that union is already the project's own definition of the real floor (`test/CLAUDE.md`, the
 * asymmetric gate). A name the default position holds is answered whether RelIR or the legacy
 * fallback produced it — which is exactly the fact that makes lowering it cut-closing rather than a
 * gain.
 */
const ANSWERED: ReadonlySet<string> = new Set<string>([...L3_STATE.passed, ...L3_STATE.legacySpine.passed]);
/**
 * RUN = every name either floor has an opinion about. A scenario in NEITHER set is not a failure —
 * L3 never ran it (a skipped tag, or an upstream scenario newer than the last recorded run), and
 * counting it as a gain would invent an upside the suite cannot confirm.
 */
const RUN: ReadonlySet<string> = new Set<string>([
  ...L3_STATE.passed, ...L3_STATE.failed, ...L3_STATE.legacySpine.passed, ...L3_STATE.legacySpine.failed,
]);

/** The three populations a blocked traversal falls into, plus the scenarios that would newly have a
 *  chance of passing if its family lowered. */
type Verdict = { readonly population: 'answered' | 'open' | 'unscored'; readonly gain: number };
function verdictOf(query: string): Verdict {
  const named = (SCENARIOS.get(query) ?? []).filter((name) => RUN.has(name));
  if (!named.length) return { population: 'unscored', gain: 0 };
  const failing = named.filter((name) => !ANSWERED.has(name));
  // ALL of a traversal's scored scenarios must be answered before it counts as cut-only. One traversal
  // is routinely shared across graph fixtures, and a route that answers it over `gmodern` but not over
  // `gcrew` has not answered it — that partial case is upside, and filing it as cut-closing is the
  // understatement this split exists to remove.
  return { population: failing.length ? 'open' : 'answered', gain: failing.length };
}

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
  // A NAMED collection plus the `cap()` that reads it back. `group`/`groupCount` appear here only in
  // their KEYED form — see `blame()` for why the unkeyed form is a different family entirely.
  'side effects': ['aggregate', 'store', 'cap', 'group', 'groupCount'],
  // A barrier whose RESULT is a map. Not a side effect: nothing is named, nothing is read back with
  // `cap()`, and what is missing is the map traverser shape.
  'the map shape': ['group*', 'groupCount*'],
  // A per-traverser carried CHANNEL, which is neither a collection nor a shape.
  sack: ['sack'],
  'scalar transforms': ['concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
    'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff', 'math', 'format'],
  aliases: ['as', 'select'],
  'the list shape': ['fold', 'unfold'],
  'the property shape': ['properties', 'valueMap', 'elementMap', 'propertyMap', 'key', 'value'],
  branch: ['union', 'choose', 'coalesce', 'optional'],
  'row ops (4.1)': ['order', 'dedup', 'limit', 'skip', 'range', 'tail', 'sample'],
  reducers: ['sum', 'min', 'max', 'mean', 'count'],
};

/**
 * What a blocking step should be COUNTED as — its own name, unless its arguments say the real gap is
 * somewhere else. One case today, measured and load-bearing (see the header): a source seeded with a
 * COLLECTION is blocked by the list traverser shape, not by the source step, which is already covered.
 *
 * Deliberately narrow. A cause-attribution that guessed would make the ranking confidently wrong, so it
 * fires only where the step's own arguments decide it, and every other blocker keeps its plain name.
 */
function blame(step: IRStep): string {
  // `argValues`, NOT `step.args` — an `Arg` is `{value, type, name}` since a user PARAMETER became a
  // first-class IR fact, so every test below reads the VALUE and not the wrapper. Reading the wrapper
  // made `typeof args[0] === 'string'` permanently false, which filed EVERY labelled `group("a")`,
  // `aggregate("a")` and `store("a")` under the unkeyed `*` bucket — so the map shape looked like the
  // largest family on the board while the named-collection substrate looked absent, which is the
  // opposite of the truth. An instrument that ranks the work has to be read as code that can rot.
  const args = argValues(step);
  // An ARRAY or a SET argument seeds one traverser that IS a collection, so what is missing is the list
  // traverser shape. A `Map` argument is the MAP shape and a `Duration` is a rich SCALAR — neither is the
  // list shape, so neither is re-attributed here even though both also block at `inject`. Guessing which
  // family those belong to would be the confidently-wrong ranking this exists to avoid.
  if (SOURCES.has(step.name) && args.some((arg) => Array.isArray(arg) || arg instanceof Set)) return 'fold';
  // A `group`/`groupCount` WITH a string label is a side effect: it fills a named collection that a
  // later `cap()` reads back. WITHOUT one it is an ordinary barrier whose RESULT is a map, and the two
  // need completely different things — a named-collection substrate versus the map traverser shape.
  // Measured 2026-08-04: of 184 blockers filed under "side effects", 64 were the unkeyed form, which
  // made a shape that is the third largest family on the board look like part of the first. The `*`
  // suffix keeps both readable in one table rather than inventing a second step name.
  if (KEYABLE.has(step.name) && !(args.length > 0 && typeof args[0] === 'string')) return `${step.name}*`;
  return step.name;
}

/** Steps whose FIRST argument, when it is a string, names a side-effect collection — and whose meaning
 *  changes family when it is absent. */
const KEYABLE = new Set(['group', 'groupCount', 'aggregate', 'store']);

/** Steps that SEED a traverser from a literal, so the literal's shape is the traverser's shape. */
const SOURCES = new Set(['inject', 'constant']);

/** `--step <name>`: also LIST the traversals this step blocks, with the position it blocks at. */
const wanted = ((): string | null => {
  const i = process.argv.indexOf('--step');
  return i < 0 ? null : (process.argv[i + 1] ?? null);
})();

/** Per BLAMED step: the three populations and the scenario upside. `blocked` is their total. */
type Tally = { blocked: number; answered: number; open: number; unscored: number; gain: number };
const blockedAt = new Map<string, Tally>();
const blockedTraversals: string[] = [];
let covered = 0, unparsed = 0, raised = 0;

for (const query of CORPUS) {
  let steps: IRStep[];
  // The `withSideEffect` registry rides with the chain, exactly as `compiler.ts` supplies it: a
  // constant the lowering is not handed reads as an uncovered gap, which is precisely the
  // measurement error this instrument exists to avoid.
  let sideEffects: Map<string, any>;
  // The SACK SEED rides with the chain for the same reason the `withSideEffect` registry does, and
  // its absence was the same measurement error one step further on: a `withSack()` traversal lowered
  // with no seed declines at its first `sack()` and reads as vocabulary the algebra cannot express,
  // when what happened is that this instrument did not hand it one (§6·6).
  let sack: ReturnType<typeof extractSack>;
  // TWO failures wear one `catch` unless they are separated, and conflating them mis-states this
  // instrument's own denominator: L1 holds parse+chain at 100.0%, so a traversal that does not reach
  // `lowerToRel` did not fail to PARSE — an IR Pass raised on it. That raise is frequently the correct
  // permanent answer (§6·5: "the answer is an ERROR" is never a capability), so it is neither a gap nor
  // L1's business, and the old label said it was both.
  let tree: ReturnType<typeof parseGremlin>;
  try { tree = parseGremlin(query); } catch { unparsed++; continue; }
  try {
    steps = runPasses(stepChain(tree, {}), extractStrategies(tree, {}), {}).steps as IRStep[];
    sideEffects = extractSideEffects(tree, {});
    sack = extractSack(tree, {});
  } catch { raised++; continue; }
  if (!steps.length) continue;
  // EVERY prefix, never stopping at the first decline — because coverage is NOT monotonic in prefix
  // length and assuming it was made this instrument understate its own subject.
  //
  // A step that absorbs a CLUSTER declines as a bare prefix and lowers with its cluster present:
  // `addE` needs its `from`/`to` (both ends implicit is not a traversal that means anything), `mergeV`
  // its `option()` arms, `addV` its `property()` run. Breaking at the first `null` therefore stopped at
  // `…addV().as('a').addV().as('b').addE('knows')` and reported the whole chain blocked AT `addE` —
  // while the chain WITH its endpoints lowers, routes and answers correctly. Measured: 29 traversals
  // attributed to `addE`, including every standard-graph seeder, none of them blocked by it. That is
  // this file's own stated failure mode (ranking the wrong work while looking precise), so the scan
  // costs a few seconds and takes the maximum instead.
  let longest = 0;
  for (let n = 1; n <= steps.length; n++) {
    // A throw counts as a decline. `mise run rel-sweep` is what asserts there are none; here it would
    // only distort the count to treat one differently.
    try { if (lowerToRel(steps.slice(0, n), { sideEffects, sack })) longest = n; } catch { /* a declining prefix, not the end */ }
  }
  if (longest === steps.length) { covered++; continue; }
  // When even the SOURCE declines, the source is the blocker.
  const step = steps[longest] ?? steps[0]!;
  const name = blame(step);
  const verdict = verdictOf(query);
  const tally = blockedAt.get(name) ?? { blocked: 0, answered: 0, open: 0, unscored: 0, gain: 0 };
  tally.blocked++;
  tally[verdict.population]++;
  tally.gain += verdict.gain;
  blockedAt.set(name, tally);
  // The POSITION is half the answer: the same step name at the source and mid-chain are two different
  // increments (a one-row `Values` input versus the traverser stream), and a list that omitted it
  // would hide the split it exists to show. The POPULATION is the other half — a traversal no route
  // answers is a different increment from one that only needs migrating.
  if (name === wanted) blockedTraversals.push(`  ${verdict.population.padEnd(8)} [${longest}/${steps.length}] ${query}`);
}

const EMPTY: Tally = { blocked: 0, answered: 0, open: 0, unscored: 0, gain: 0 };
const sum = (members: readonly string[], of: keyof Tally) =>
  members.reduce((n, m) => n + (blockedAt.get(m) ?? EMPTY)[of], 0);
const breakdown = (members: readonly string[]) => members
  .map((m) => [m, (blockedAt.get(m) ?? EMPTY).blocked] as const).filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}:${n}`).join(' ');
const row = (label: string, members: readonly string[]) => [
  String(sum(members, 'blocked')).padStart(6), String(sum(members, 'answered')).padStart(9),
  String(sum(members, 'open')).padStart(5), String(sum(members, 'unscored')).padStart(9),
  String(sum(members, 'gain')).padStart(5), ' ', label.padEnd(19), breakdown(members),
].join('');

console.log(`rel-blockers: ${covered}/${CORPUS.length} corpus traversals fully covered`);
console.log(`  ${unparsed} unparsed (L1's business, not this one) · ${raised} raised in the IR Pass tier before any lowering was attempted (§6·5 — often the correct permanent answer)\n`);
console.log('  BY FAMILY — blocked splits into three populations; L3 is the scenario upside:');
console.log('  blocked  answered  open  unscored   L3  family');
for (const [name, members] of Object.entries(FAMILIES).sort((a, b) => sum(b[1], 'blocked') - sum(a[1], 'blocked')))
  console.log(row(name, members));

const inAFamily = new Set(Object.values(FAMILIES).flat());
const residue = [...blockedAt].filter(([step]) => !inAFamily.has(step)).sort((a, b) => b[1].blocked - a[1].blocked);
console.log('\n  IN NO FAMILY — where the next family gets recognized:');
console.log(`  ${residue.map(([step, t]) => `${step}:${t.blocked}`).join(' ')}`);
console.log(`\n  RANKED BY L3 UPSIDE — the scenarios no route answers today, per family:`);
for (const [name, members] of Object.entries(FAMILIES).sort((a, b) => sum(b[1], 'gain') - sum(a[1], 'gain')))
  if (sum(members, 'gain') > 0) console.log(`  ${String(sum(members, 'gain')).padStart(4)}  ${name}`);

if (wanted) {
  console.log(`\n  BLOCKED AT ${wanted}() — [population] [covered prefix/steps] traversal:`);
  console.log(blockedTraversals.length ? blockedTraversals.join('\n') : '  (none)');
}
