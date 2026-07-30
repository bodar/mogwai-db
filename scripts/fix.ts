#!/usr/bin/env bun
/**
 * Apply TypeScript's own source-level code actions across the repo.
 *
 *   bun scripts/fix.ts [--organize] [--unused] [--all] [--dry] [<glob-or-path>...]
 *
 * Defaults to `--unused` (remove unused imports) over `src test scripts` — the safe, always-correct
 * one. `--organize` additionally SORTS and merges import statements, which is a much larger diff;
 * ask for it deliberately.
 *
 * Why this and not a linter: these are the SAME fixes `tsc` itself would apply, computed by the
 * server inside our pinned `typescript`, so they cannot disagree with what `mise run check` gates
 * on. No new dependency, and no second opinion about what "unused" means.
 *
 * Exit codes: 0 clean or fixed, 1 a server error (never non-zero merely for having found fixes).
 */
import { ROOT, type Edit, applyEdits, applyToText, editsOf, startSession, uriOf } from './lsp.ts';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const organize = argv.includes('--organize');
const all = argv.includes('--all');
// `--unused` is the default; naming any other action turns the default off unless asked for too.
const unused = argv.includes('--unused') || (!organize && !all);
const targets = argv.filter((a) => !a.startsWith('--'));

const KINDS = [
  ...(unused ? ['source.removeUnusedImports'] : []),
  ...(organize ? ['source.organizeImports'] : []),
  ...(all ? ['source.fixAll'] : []),
];

const glob = new Bun.Glob('**/*.ts');
const roots = targets.length ? targets : ['src', 'test', 'scripts'];
const files: string[] = [];
for (const root of roots) {
  const stat = await Bun.file(`${ROOT}/${root}`).exists();
  // A bare file path is used as-is; a directory is swept. `parser/` is generated — never touch it.
  if (stat && root.endsWith('.ts')) { files.push(root); continue; }
  for await (const rel of glob.scan({ cwd: `${ROOT}/${root}`, onlyFiles: true }))
    files.push(`${root}/${rel}`);
}
if (!files.length) {
  console.error(`no .ts files under: ${roots.join(', ')}`);
  process.exit(1);
}

const session = await startSession();
let changedFiles = 0;
let totalEdits = 0;

for (const file of files) {
  await session.open(file);
  // One request per kind. The range is the whole document for a `source.*` action — the server
  // ignores it for these kinds, but a zero-range is what editors send and what the server expects.
  for (const kind of KINDS) {
    const r = await session.request('textDocument/codeAction', {
      textDocument: { uri: uriOf(file) },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: [kind] },
    });
    if (r.error) {
      console.error(`${file}: ${kind}: ${JSON.stringify(r.error)}`);
      session.close();
      process.exit(1);
    }
    for (const action of r.result ?? []) {
      // Most actions arrive with `edit` inline; the protocol allows a lazy action that must be
      // resolved first. Handle both rather than assuming the shape we happened to measure.
      const edit = action.edit ?? (await session.request('codeAction/resolve', action)).result?.edit;
      const byFile = editsOf(edit);
      const n = [...byFile.values()].reduce((a: number, e: Edit[]) => a + e.length, 0);
      if (!n) continue;

      // The server offers these actions for EVERY file with imports, and its edit is a rewrite of
      // the whole import block — which is usually byte-identical to what is already there. Applying
      // those is churn: 1037 "edits" across 152 files on a tree `tsc` calls clean. Compare the
      // resulting text and skip when nothing actually changes.
      const effective = new Map<string, Edit[]>();
      for (const [f, es] of byFile) {
        const before = await Bun.file(`${ROOT}/${f}`).text();
        if (applyToText(before, es) !== before) effective.set(f, es);
      }
      if (!effective.size) continue;

      const m = [...effective.values()].reduce((a: number, e: Edit[]) => a + e.length, 0);
      totalEdits += m;
      changedFiles++;
      console.log(`${file}: ${action.title} — ${m} edit(s)${dry ? '  [dry run]' : ''}`);
      if (!dry) {
        await applyEdits(effective);
        // The file on disk no longer matches the server's buffer; resync before the next kind
        // computes against it. Same rule as the batch rename.
        for (const f of effective.keys()) await session.resync(f);
      }
    }
  }
}

session.close();
console.log(totalEdits
  ? `\n${totalEdits} edit(s) across ${changedFiles} file-action(s)${dry ? ' [dry run]' : ''}; run \`mise run check\`.`
  : `\nnothing to fix across ${files.length} file(s).`);
