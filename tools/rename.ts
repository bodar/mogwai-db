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
 *   bun tools/rename.ts <file> <oldName> <newName> [--dry] [--at <line>:<col>]
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
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

type Pos = { line: number; character: number };
type Edit = { range: { start: Pos; end: Pos }; newText: string };

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const atIdx = args.indexOf('--at');
const at = atIdx >= 0 ? args[atIdx + 1] : undefined;
const [file, oldName, newName] = args.filter((a, i) =>
  !a.startsWith('--') && !(atIdx >= 0 && i === atIdx + 1));

if (!file || !oldName || !newName) {
  console.error('usage: bun tools/rename.ts <file> <oldName> <newName> [--dry] [--at line:col]');
  process.exit(1);
}

// ---------- LSP plumbing: framed JSON-RPC over the server's stdio ----------
const proc = Bun.spawn([`${ROOT}/node_modules/typescript/bin/tsc`, '--lsp', '--stdio'],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: ROOT });

const send = (m: unknown) => {
  const b = JSON.stringify(m);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
  proc.stdin.flush();
};
const pending = new Map<number, (r: any) => void>();
let id = 0;
const request = (method: string, params: unknown) =>
  new Promise<any>((res) => { pending.set(++id, res); send({ jsonrpc: '2.0', id, method, params }); });

const reader = proc.stdout.getReader();
void (async () => {
  let buf = Buffer.alloc(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString())?.[1]);
      if (buf.length < sep + 4 + len) break;
      const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
      buf = buf.subarray(sep + 4 + len);
      // A server->client REQUEST (it has both `method` and `id`) must be answered, or the
      // server blocks and every later request hangs — `client/registerCapability` arrives
      // right after `initialized` and cost three debugging rounds to find.
      if (msg.method && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null });
      const fn = msg.id !== undefined && !msg.method ? pending.get(msg.id) : undefined;
      if (fn) { fn(msg); pending.delete(msg.id); }
    }
  }
})();

const uriOf = (p: string) => `file://${ROOT}/${p}`;
const relOf = (u: string) => u.replace(`file://${ROOT}/`, '');

await request('initialize', {
  processId: process.pid,
  rootUri: `file://${ROOT}`,
  capabilities: { workspace: { workspaceEdit: { documentChanges: true } } },
});
send({ jsonrpc: '2.0', method: 'initialized', params: {} });

const text = await Bun.file(`${ROOT}/${file}`).text();
send({ jsonrpc: '2.0', method: 'textDocument/didOpen',
  params: { textDocument: { uri: uriOf(file), languageId: 'typescript', version: 1, text } } });

// ---------- find a position the server agrees is a renameable symbol ----------
const lines = text.split('\n');
const candidates: Pos[] = [];
if (at) {
  const [l, c] = at.split(':').map(Number);
  // Assert the token really is there. An `--at` computed BEFORE an earlier rename in the same
  // batch is stale — a longer replacement shifts every later column on that line — and without
  // this guard the position silently lands on a neighbouring symbol and renames THAT. It cost
  // one aliased import (`type Step as modulators`) to learn; a stale position must fail loudly.
  const found = lines[l - 1]?.slice(c, c + oldName.length);
  if (found !== oldName) {
    console.error(`--at ${l}:${c} is "${found}", not "${oldName}" — stale position? ` +
      `(recompute it against the CURRENT file: earlier renames shift columns)`);
    proc.kill(); process.exit(1);
  }
  candidates.push({ line: l - 1, character: c });
} else {
  const word = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  lines.forEach((lineText, line) => {
    for (let m = word.exec(lineText); m; m = word.exec(lineText)) candidates.push({ line, character: m.index });
  });
}
if (!candidates.length) {
  console.error(`${oldName}: no whole-word occurrence in ${file}`);
  proc.kill(); process.exit(1);
}

let position: Pos | undefined;
for (const cand of candidates) {
  const prep = await request('textDocument/prepareRename', { textDocument: { uri: uriOf(file) }, position: cand });
  if (!prep.error && prep.result) { position = cand; break; }
}
if (!position) {
  console.error(`${oldName}: ${candidates.length} occurrence(s) in ${file}, none renameable ` +
    `(all in comments/strings? pass --at line:col)`);
  proc.kill(); process.exit(1);
}

// ---------- rename ----------
const ren = await request('textDocument/rename',
  { textDocument: { uri: uriOf(file) }, position, newName });
if (ren.error) {
  console.error(`rename failed: ${JSON.stringify(ren.error)}`);
  proc.kill(); process.exit(1);
}

const byFile = new Map<string, Edit[]>();
for (const d of ren.result?.documentChanges ?? []) byFile.set(relOf(d.textDocument.uri), d.edits);
for (const [u, e] of Object.entries<Edit[]>(ren.result?.changes ?? {})) if (!byFile.has(relOf(u))) byFile.set(relOf(u), e);

const total = [...byFile.values()].reduce((n, e) => n + e.length, 0);
console.log(`${oldName} -> ${newName} @ ${file}:${position.line + 1}:${position.character}` +
  `  ${byFile.size} files, ${total} edits${dry ? '  [dry run]' : ''}`);

if (!dry) {
  for (const [rel, edits] of byFile) {
    const path = `${ROOT}/${rel}`;
    const src = (await Bun.file(path).text()).split('\n');
    // Apply per line, right-to-left, so earlier edits never shift later offsets.
    // `positionEncoding` is utf-16 and JS strings are utf-16, so `character` indexes directly.
    const perLine = new Map<number, Edit[]>();
    for (const e of edits) {
      const line = e.range.start.line;
      if (!perLine.has(line)) perLine.set(line, []);
      perLine.get(line)!.push(e);
    }
    for (const [line, es] of perLine) {
      if (es.some((e) => e.range.end.line !== line)) throw new Error(`${rel}: multi-line edit range, refusing to apply`);
      for (const e of es.sort((a, b) => b.range.start.character - a.range.start.character))
        src[line] = src[line].slice(0, e.range.start.character) + e.newText + src[line].slice(e.range.end.character);
    }
    await Bun.write(path, src.join('\n'));
  }
}

// Comments and strings are NOT touched: LSP `textDocument/rename` has no findInComments
// option (that was tsserver-only). Prose that names the symbol is a separate reviewed pass.
proc.kill();
