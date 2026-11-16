#!/usr/bin/env bun
/**
 * The ladder-size ratchet: the `return null` decline sites in `src/compiler/rel/` may not grow.
 *
 *   bun scripts/ladder-check.ts            check against scripts/ladder-baseline.json  (`mise run ladder`)
 *   bun scripts/ladder-check.ts --record   bank the current counts                     (`mise run ladder-record`)
 *   bun scripts/ladder-check.ts --verbose  print every file's count
 *
 * WHY. Root CLAUDE.md locked decision 6: nesting composes through ONE mechanism, the scoped-relation
 * connector (`src/compiler/rel/lower/scoped.ts` + `src/rel/decorrelate.ts`). The pattern it replaces — a
 * correlated route or a `(host, body-shape)` special case per need — is what grew ~890 decline sites and a 98%
 * decline rate at depth 5 (`docs/2026-11-15-compositional-coverage-plan.md` §1). Its §4 names the metric
 * this gate holds: the count of `return null` sites in `src/compiler/rel/`, "down after Phase 3". Every
 * route is a function that answers or returns null, so a new rung is visible here as new `return null`s
 * before anything else can see it.
 *
 * WHAT IS RATCHETED, AND WHY BOTH:
 *   • the TOTAL over `src/compiler/rel/**`, EXCEPT the connector's own file(s) (`CONNECTOR_FILES`), may not
 *     rise. The connector's declines are not ladder growth: they mark where the ONE mechanism does not reach
 *     yet, and their real guard is L9's connector-only closure ratchet (`test/L9-connector/`), which fails
 *     on lost COVERAGE rather than on a site count. Counted here, every connector change raised this
 *     baseline (the inversion added 23, all in scoped.ts) — and a limit raised routinely stops meaning
 *     anything. Body lowering legitimately adds a few declines too (a body is fixed IN the body's lowering
 *     — a new step form often refuses its own sub-cases), so the counted files may trade sites with each
 *     other freely as long as their whole does not grow. The ladder deletion (Phase 3 (d)) is what pays for that headroom.
 *   • PER FILE for the LADDER files below — the correlated-route homes. A total alone would let a new rung
 *     hide behind deletions elsewhere (the ladder deletion is precisely a stream of deletions to hide
 *     behind), and a new rung is exactly what decision 6 forbids. Per file for EVERY file was rejected:
 *     it charges the sanctioned direction (fix the body's lowering, extend the connector) the same toll
 *     as the forbidden one, and a file move would fail it for nothing.
 *
 * A RISE fails, naming the file(s). The fix is almost always not to add the site: route the case through the
 * connector (a `CONNECTORS` row, or the body's own lowering, or one rule in `decorrelate.ts`). If a decline
 * really is right, re-record with `mise run ladder-record` and give the REASON in the commit message — that
 * message is the record. A FALL passes and prints a one-line nudge to re-record, so the floor tightens.
 *
 * COUNTING. Occurrences of `return null` in the CODE part of a line: a line whose code starts with `//`,
 * `*` or `/*` is a comment and skipped, as is anything after a `//` (binds-check.ts's line-level rule — no
 * tokenizer without a new dependency; the residual blind spot is prose inside a block comment that does not
 * start its line with `*`, which this repo does not write).
 *
 * Exit codes: 0 at or under the baseline (or recorded), 1 a rise.
 */
import { ROOT } from './lsp.ts';

const BASELINE = new URL('./ladder-baseline.json', import.meta.url);
const SCOPE = 'src/compiler/rel';
/** The correlated-route homes — the `correlatedChild` ladder's ROUTING, ratcheted file by file. Paths relative to
 *  the repo root. Only routing: `docs/2026-11-16-ladder-retirement-plan.md` R1 measured line coverage of the L1+L6
 *  pools with the ladder first and with the connector alone, and the code BOTH run is shared substrate, not ladder
 *  — the correlated existence and its predicates (`lower/exists.ts`), the correlated first-row read and the child
 *  seam (`lower/reduction.ts`), the arm merges (`lower/branch.ts`, every host of which is `LADDERLESS`), the by()
 *  readers (`modulator.ts` `byField`, read by `record.ts`/`collection.ts`) and the presence vocabulary
 *  (`child.ts`). Those are counted in the total like any lowering. What only the ladder runs is the per-traverser
 *  route (`perTraverserChild`/`flatMapRejoin` and their admission gates), which R1 moved into its own file. */
const LADDER_FILES = [
  `${SCOPE}/lower/per-traverser.ts`,
] as const;
/** The connector's own files: counted and printed, but outside the total (see WHY) — L9 guards them. */
const CONNECTOR_FILES: readonly string[] = [`${SCOPE}/lower/scoped.ts`];
const counted = (f: string) => !CONNECTOR_FILES.includes(f);

interface Baseline { readonly total: number; readonly files: Record<string, number> }

const record = Bun.argv.includes('--record');
const verbose = Bun.argv.includes('--verbose');

/** The code part of a line: '' when the line is a comment, else the text before any `//`. */
function codeOf(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  const slashes = line.indexOf('//');
  return slashes < 0 ? line : line.slice(0, slashes);
}

const files = [...new Bun.Glob(`${SCOPE}/**/*.ts`).scanSync(ROOT)].sort();
if (!files.length) {
  console.error(`found no ${SCOPE}/**/*.ts files — is this being run from the wrong directory?`);
  process.exit(1);
}
const counts: Record<string, number> = {};
for (const rel of files) {
  let n = 0;
  for (const line of (await Bun.file(`${ROOT}/${rel}`).text()).split('\n'))
    n += codeOf(line).match(/\breturn null\b/g)?.length ?? 0;
  if (n) counts[rel] = n;
}
const total = Object.entries(counts).filter(([f]) => counted(f)).reduce((a, [, b]) => a + b, 0);
const ladderNow = LADDER_FILES.reduce((a, f) => a + (counts[f] ?? 0), 0);

if (verbose)
  for (const [f, n] of Object.entries(counts).sort(([, a], [, b]) => b - a))
    console.log(`  ${String(n).padStart(4)}  ${f}${(LADDER_FILES as readonly string[]).includes(f) ? '  (ladder)' : counted(f) ? '' : '  (connector — outside the total)'}`);

if (record) {
  await Bun.write(BASELINE, `${JSON.stringify({ total, files: counts } satisfies Baseline, null, 2)}\n`);
  console.log(`ladder: recorded ${total} decline sites (${ladderNow} in the ladder files) → scripts/ladder-baseline.json — commit it with the reason`);
  process.exit(0);
}

const base = JSON.parse(await Bun.file(BASELINE).text()) as Baseline;
const was = (f: string) => base.files[f] ?? 0;
const rose = (fs: readonly string[]) => fs.filter((f) => (counts[f] ?? 0) > was(f)).map((f) => `${f}: ${was(f)} → ${counts[f] ?? 0}`);

const failures: string[] = [];
const ladderRose = rose(LADDER_FILES);
if (ladderRose.length)
  failures.push(`a LADDER file gained decline sites (per-file ratchet — a deletion elsewhere does not pay for a new rung):\n    ${ladderRose.join('\n    ')}`);
if (total > base.total)
  failures.push(`the total rose ${base.total} → ${total}; files above their recorded count:\n    ${rose(Object.keys(counts).filter(counted)).join('\n    ')}`);

if (failures.length) {
  for (const f of failures) console.error(`ladder: ${f}`);
  console.error([
    '',
    'A new `return null` in src/compiler/rel/ is a new decline site. Nesting composes through ONE mechanism, the',
    'scoped-relation connector (root CLAUDE.md, locked decision 6): route the case through a CONNECTORS row, the',
    "body's own lowering, or one rule in src/rel/decorrelate.ts — never a new correlated route or (host, body-shape)",
    'case. If the decline is genuinely right, re-record with `mise run ladder-record` and give the REASON in the',
    'commit message.',
  ].join('\n'));
  process.exit(1);
}

const ladderWas = LADDER_FILES.reduce((a, f) => a + was(f), 0);
console.log(`ladder: ${total} decline sites in ${SCOPE} (baseline ${base.total}); ladder files ${ladderNow} (baseline ${ladderWas})`);
if (total < base.total || ladderNow < ladderWas)
  console.log('ladder: the count FELL — tighten the floor with `mise run ladder-record` and commit scripts/ladder-baseline.json');
