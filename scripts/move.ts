#!/usr/bin/env bun
/**
 * Move a file and rewrite every import path that pointed at it.
 *
 *   bun scripts/move.ts <from> <to> [--dry]
 *
 * The mechanism is `workspace/willRenameFiles`, which our pinned `tsc --lsp` advertises with a
 * `**​/*.{ts,tsx,js,jsx,...}` filter and answers with a real `WorkspaceEdit`. So the import fixup is
 * TypeScript's own — it cannot disagree with what `mise run check` gates on, which is the same
 * property that makes `rename.ts` and `fix.ts` trustworthy.
 *
 * ORDER IS LOAD-BEARING: ask for the edits, APPLY them, and only then move the file. The returned
 * edit set is keyed by the file's OLD uri wherever the moved file's own relative imports need
 * rewriting (a file that moves between directories almost always has some), so moving first would
 * leave those edits addressed to a path that no longer exists.
 *
 * `git mv` rather than a raw rename: it keeps the move in the index as a rename, which is what
 * makes `git log --follow` and review diffs readable — a delete+add pair loses the file's history
 * at exactly the moment someone will want it.
 *
 * WHAT THIS IS NOT: moving a SYMBOL to another file. That is TypeScript's `Move to file` refactor,
 * and this server does not expose it — `codeActionProvider.codeActionKinds` is
 * `quickfix, source.organizeImports, source.removeUnusedImports, source.sortImports, source.fixAll`
 * with no `refactor.*` kind at all, and a `textDocument/codeAction` asking for `refactor` or
 * `refactor.move` over a declaration returns zero actions. Measured, not assumed. See
 * docs/2026-07-30-lsp-tooling-plan.md §4.
 *
 * Exit codes: 0 moved (or nothing to do), 1 a validation failure or a server error.
 */
import { ROOT, applyEdits, editsOf, startSession, uriOf } from './lsp.ts';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const [from, to] = argv.filter((a) => !a.startsWith('--'));

if (!from || !to) {
  console.error('usage: bun scripts/move.ts <from> <to> [--dry]');
  process.exit(1);
}

const fail = (msg: string) => { console.error(`move: ${msg}`); process.exit(1); };

if (from.startsWith('/') || to.startsWith('/')) fail('paths must be repo-relative');
if (from.startsWith('parser/') || to.startsWith('parser/')) fail('parser/ is generated — never hand-moved (locked decision 2)');
if (!await Bun.file(`${ROOT}/${from}`).exists()) fail(`${from} does not exist`);
if (await Bun.file(`${ROOT}/${to}`).exists()) fail(`${to} already exists — refusing to overwrite`);

const session = await startSession();
// Open the file so the server has built a program that contains it; willRenameFiles is answered
// against that program, and an unopened file yields an empty edit set that looks like "no importers".
await session.open(from);

const res = await session.request('workspace/willRenameFiles', {
  files: [{ oldUri: uriOf(from), newUri: uriOf(to) }],
});
session.close();

if (res.error) fail(`server error: ${JSON.stringify(res.error)}`);

const byFile = editsOf(res.result);
const total = [...byFile.values()].reduce((n, e) => n + e.length, 0);

console.log(`move: ${from} -> ${to}`);
if (!total) {
  console.log('       no import paths need rewriting (nothing imports it, or all imports are bare)');
} else {
  console.log(`       ${total} import edit(s) across ${byFile.size} file(s):`);
  for (const [rel, edits] of [...byFile].sort()) console.log(`         ${rel}  ${edits.length} edit(s)`);
}

if (dry) { console.log('\n[dry run] nothing written'); process.exit(0); }

// Edits first, then the move — see the header.
await applyEdits(byFile);

const mv = Bun.spawn(['git', 'mv', from, to], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
const mvErr = await new Response(mv.stderr).text();
await mv.exited;
if (mv.exitCode !== 0) fail(`git mv failed (import edits ARE already applied — revert them): ${mvErr.trim()}`);

console.log('\nmoved. Run `mise run check` — the import fixup is tsc\'s own, but nothing here proves');
console.log('the file belongs at its new path.');
