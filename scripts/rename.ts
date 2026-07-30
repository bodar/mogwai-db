#!/usr/bin/env bun
/**
 * Type-aware rename, driven through the LSP server that ships INSIDE our pinned
 * `typescript` dependency (`tsc --lsp --stdio` — typescript@7 is the native Go port).
 *
 * Why this exists rather than a dependency: typescript@7 deleted `tsserver.js` and the
 * `typescript.js` compiler-API bundle, so `typescript-language-server`, `vtsls` and
 * ts-morph either cannot run or would analyse with a DIFFERENT TypeScript than
 * `mise run check` gates on. A rename the gate disagrees with is the one thing we
 * cannot ship. The native server is the only type-aware option that is definitionally
 * in agreement with the compiler — and it needs no new dependency.
 *
 *   bun scripts/rename.ts <file> <oldName> <newName> [--dry] [--at <line>:<col>]
 *
 * For SEVERAL renames use `rename-batch.ts`: one session, and positions recomputed against
 * the current files between renames, which removes the stale-`--at` trap instead of only
 * failing loudly on it. The plumbing is `lsp.ts`; the rename itself is `rename-lib.ts`.
 *
 * Position is found for you: every whole-word occurrence of `oldName` in `<file>` is
 * offered to `textDocument/prepareRename`, and the first the server accepts is used. That
 * is what skips occurrences in comments and strings without a heuristic of our own —
 * the server's own answer to "is this a renameable symbol here" decides.
 *
 * A FIELD rename is therefore scoped by the type it is declared on, not by text: point it
 * at the declaration site and same-named fields on unrelated types are untouched. This is
 * the whole reason `options` -> `optionArms` is safe while `sed` would not be.
 *
 * Exit codes: 0 renamed (or --dry), 1 nothing renameable / server error.
 */
import { startSession } from './lsp.ts';
import { applyEdits, computeRename } from './rename-lib.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const atIdx = args.indexOf('--at');
const at = atIdx >= 0 ? args[atIdx + 1] : undefined;
const [file, oldName, newName] = args.filter((a, i) =>
  !a.startsWith('--') && !(atIdx >= 0 && i === atIdx + 1));

if (!file || !oldName || !newName) {
  console.error('usage: bun scripts/rename.ts <file> <oldName> <newName> [--dry] [--at line:col]');
  process.exit(1);
}

const session = await startSession();
const outcome = await computeRename(session, { file, oldName, newName, at });

if (!outcome.ok) {
  console.error(outcome.error);
  session.close();
  process.exit(1);
}

console.log(`${oldName} -> ${newName} @ ${file}:${outcome.position.line + 1}:${outcome.position.character}` +
  `  ${outcome.byFile.size} files, ${outcome.edits} edits${dry ? '  [dry run]' : ''}`);

if (!dry) await applyEdits(outcome.byFile);

// Comments and strings are NOT touched: LSP `textDocument/rename` has no findInComments
// option (that was tsserver-only). Prose that names the symbol is a separate reviewed pass.
session.close();
