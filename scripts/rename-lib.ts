/**
 * The rename itself, factored out of `rename.ts` so `rename-batch.ts` can drive N of them
 * through ONE session — which is what structurally removes the `--at` staleness trap rather
 * than only failing loudly on it (see `resolvePosition`).
 */
import { type Edit, type Pos, type Session, applyEdits, editsOf, uriOf } from './lsp.ts';

export type RenameSpec = { file: string; oldName: string; newName: string; at?: string };

export type RenameOutcome =
  | { ok: true; spec: RenameSpec; position: Pos; byFile: Map<string, Edit[]>; edits: number }
  | { ok: false; spec: RenameSpec; error: string };

/**
 * Find a position the server agrees is a renameable symbol.
 *
 * `text` MUST be the CURRENT content of the file. Every occurrence of `oldName` is offered to
 * `textDocument/prepareRename` and the first the server accepts wins — that is what skips
 * comments and strings without a heuristic of our own.
 *
 * `--at` is checked against that same current text. A position computed BEFORE an earlier rename
 * in the same batch is stale (a longer replacement shifts every later column on that line), and
 * without this guard it silently lands on a neighbouring symbol and renames THAT. It cost one
 * aliased import (`type Step as modulators`) to learn.
 */
export async function resolvePosition(
  session: Session, file: string, oldName: string, text: string, at?: string,
): Promise<{ position: Pos } | { error: string }> {
  const lines = text.split('\n');
  const candidates: Pos[] = [];
  if (at) {
    const [l, c] = at.split(':').map(Number);
    const found = lines[l - 1]?.slice(c, c + oldName.length);
    if (found !== oldName) {
      return { error: `--at ${l}:${c} is "${found}", not "${oldName}" — stale position? ` +
        `(recompute it against the CURRENT file: earlier renames shift columns)` };
    }
    candidates.push({ line: l - 1, character: c });
  } else {
    const word = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    lines.forEach((lineText, line) => {
      for (let m = word.exec(lineText); m; m = word.exec(lineText)) candidates.push({ line, character: m.index });
    });
  }
  if (!candidates.length) return { error: `${oldName}: no whole-word occurrence in ${file}` };

  for (const cand of candidates) {
    const prep = await session.request('textDocument/prepareRename', { textDocument: { uri: uriOf(file) }, position: cand });
    if (!prep.error && prep.result) return { position: cand };
  }
  return { error: `${oldName}: ${candidates.length} occurrence(s) in ${file}, none renameable ` +
    `(all in comments/strings? pass --at line:col)` };
}

/**
 * Compute one rename. Does NOT write — the caller applies, so a batch can stop before touching
 * disk.
 *
 * The text used to resolve the position comes from the session, never from a caller-held string:
 * a position computed against text the server does not have is the batch-corruption bug (see
 * `Session.resync`). Pass `resync: true` when an earlier rename in this batch wrote to `file`.
 */
export async function computeRename(
  session: Session, spec: RenameSpec, opts: { resync?: boolean } = {},
): Promise<RenameOutcome> {
  const { file, oldName, newName } = spec;
  const text = opts.resync ? await session.resync(file) : await session.open(file);

  const pos = await resolvePosition(session, file, oldName, text, spec.at);
  if ('error' in pos) return { ok: false, spec, error: pos.error };

  const ren = await session.request('textDocument/rename',
    { textDocument: { uri: uriOf(file) }, position: pos.position, newName });
  if (ren.error) return { ok: false, spec, error: `rename failed: ${JSON.stringify(ren.error)}` };

  const byFile = editsOf(ren.result);
  const edits = [...byFile.values()].reduce((n, e) => n + e.length, 0);
  if (!edits) return { ok: false, spec, error: `${oldName}: server returned no edits` };
  return { ok: true, spec, position: pos.position, byFile, edits };
}

export { applyEdits };
