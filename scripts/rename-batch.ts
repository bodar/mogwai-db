#!/usr/bin/env bun
/**
 * Batch type-aware rename: N renames through ONE LSP session.
 *
 *   bun scripts/rename-batch.ts <plan.tsv> [--dry] [--keep-going]
 *
 * The plan is TSV (blank lines and `#` comments skipped), one rename per line:
 *
 *   src/compiler/ir/step.ts <TAB> options <TAB> optionArms
 *   src/compiler/ir/pass.ts <TAB> run     <TAB> rewrite     <TAB> 61:11
 *
 * A 4th column is an optional `line:col` (1-based line, 0-based column), same as `--at`.
 *
 * WHY THIS EXISTS — it is not just a speed wrapper. Running `rename.ts` N times is not merely
 * N cold starts (~300ms each); it is N renames whose `--at` positions were all computed against
 * the ORIGINAL files. The first rename invalidates the rest: a longer replacement shifts every
 * later column on that line, and a rename that moves a declaration shifts lines. `rename.ts`
 * fails loudly on that (the guard in resolvePosition), which is correct but leaves the operator
 * hand-recomputing positions mid-campaign.
 *
 * Here, positions are resolved against the CURRENT file immediately before each rename, and the
 * server is resynced from disk after each one, so the trap cannot arise. That is a structural
 * fix, not a louder error.
 *
 * SEQUENTIAL BY CONSTRUCTION. Renames are not independent: rename i can edit a file rename i+1
 * points at (that is the normal case in a vocabulary campaign, where several symbols live in one
 * file). They are applied one at a time, each against the result of the last.
 *
 * FAIL-CLOSED BY DEFAULT. The first failure stops the batch, leaving earlier renames applied and
 * printing exactly where it stopped, so the remaining plan lines are the resume point. This
 * matches the project's "never silently answer a different question" rule: a half-applied
 * vocabulary change is recoverable, a batch that skipped one rename and kept going is a chain
 * of edits nobody verified. `--keep-going` opts out for the case where the renames really are
 * unrelated.
 *
 * Exit codes: 0 all renames applied (or --dry), 1 a rename failed.
 */
import { startSession } from './lsp.ts';
import { type RenameSpec, applyEdits, computeRename } from './rename-lib.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const keepGoing = args.includes('--keep-going');
const planPath = args.find((a) => !a.startsWith('--'));

if (!planPath) {
  console.error('usage: bun scripts/rename-batch.ts <plan.tsv> [--dry] [--keep-going]');
  process.exit(1);
}

const raw = await Bun.file(planPath).text().catch(() => {
  console.error(`cannot read plan: ${planPath}`);
  process.exit(1);
});

const plan: RenameSpec[] = [];
raw.split('\n').forEach((line, i) => {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;
  const [file, oldName, newName, at] = t.split('\t').map((s) => s.trim());
  if (!file || !oldName || !newName) {
    console.error(`${planPath}:${i + 1}: need at least file<TAB>oldName<TAB>newName`);
    process.exit(1);
  }
  plan.push({ file, oldName, newName, at: at || undefined });
});

if (!plan.length) {
  console.error(`${planPath}: no renames in plan`);
  process.exit(1);
}

const session = await startSession();
let applied = 0;
let failed = 0;
const touched = new Set<string>();

for (const [i, spec] of plan.entries()) {
  const n = `[${i + 1}/${plan.length}]`;
  // Resync from disk when an earlier rename in THIS batch already wrote to the file the server
  // has open — its buffer is stale by exactly the edits we just applied.
  const outcome = await computeRename(session, spec, { resync: touched.has(spec.file) });

  if (!outcome.ok) {
    failed++;
    console.error(`${n} ✗ ${spec.oldName} -> ${spec.newName} @ ${spec.file}\n      ${outcome.error}`);
    if (keepGoing) continue;
    console.error(`\nstopped at plan line ${i + 1}; ${applied} rename(s) applied${dry ? ' [dry run]' : ''}.` +
      `\nremaining plan lines are the resume point (positions will be recomputed against current files).`);
    session.close();
    process.exit(1);
  }

  const files = [...outcome.byFile.keys()];
  console.log(`${n} ✓ ${spec.oldName} -> ${spec.newName} @ ${spec.file}:${outcome.position.line + 1}:${outcome.position.character}` +
    `  ${outcome.byFile.size} files, ${outcome.edits} edits${dry ? '  [dry run]' : ''}`);

  if (!dry) {
    await applyEdits(outcome.byFile);
    // Every file this rename edited now differs from the server's buffer AND from the session's
    // text cache. `resync` moves both together — the NEXT rename resolves its position against
    // current text, which is the batch's whole point.
    for (const f of files) { touched.add(f); await session.resync(f); }
  }
  applied++;
}

session.close();
console.log(`\n${applied} of ${plan.length} rename(s) ${dry ? 'resolved [dry run]' : 'applied'}` +
  `${failed ? `, ${failed} failed` : ''}.`);
if (failed) {
  console.error('run `mise run check` before committing — a partially applied batch may not type-check.');
  process.exit(1);
}
console.log('next: `mise run check`, then read the comments — LSP rename never touches prose.');
