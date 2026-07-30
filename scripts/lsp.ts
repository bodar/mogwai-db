/**
 * A session against the LSP server that ships INSIDE our pinned `typescript`
 * (`tsc --lsp --stdio` — typescript@7 is the native Go port). Shared by every
 * type-aware script in here; see `rename.ts` for why this server and not a dependency.
 *
 * SESSION-scoped, deliberately not a daemon. Measured on this repo: spawn+initialize is
 * ~70ms, the first query (which builds the program) ~230ms, and every query after that
 * ~1ms. So the cost is the program build INSIDE one process, not the process — which makes
 * the win "open once, query many times", i.e. a library, not a background server.
 *
 * A daemon would additionally have to answer "is the buffer the server holds still what is
 * on disk", across invocations that exist precisely to CHANGE files. That is a cache-coherence
 * problem invented to save ~300ms, and its failure mode is an edit computed against stale text
 * — silently wrong, which is the one outcome these tools exist to prevent. A fresh process
 * reads disk and is definitionally current. Revisit only for a genuinely long-lived client
 * (editor integration, watch mode) that owns the buffers because it is making the edits.
 */
export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

export type Pos = { line: number; character: number };
export type Range = { start: Pos; end: Pos };
export type Edit = { range: Range; newText: string };

export const uriOf = (p: string) => `file://${ROOT}/${p}`;
export const relOf = (u: string) => u.replace(`file://${ROOT}/`, '');

export interface Session {
  /** Send a request and await its response envelope (`{result}` or `{error}`). */
  request(method: string, params: unknown): Promise<any>;
  /** Send a notification (no reply expected). */
  notify(method: string, params: unknown): void;
  /** Open a file from disk so the server will answer queries about it. Idempotent. */
  open(rel: string): Promise<string>;
  /**
   * Re-read `rel` from disk and push it to the server, returning the new text.
   *
   * Call this after writing to a file this session has open. It is ONE operation on purpose:
   * the server's buffer and our text cache must move together. Splitting them — pushing
   * `didChange` while a caller still holds text from `open()` — is exactly the bug that
   * corrupted a batch rename: positions were computed against stale text and sent to a server
   * that had already moved on, so a shorter earlier edit shifted every later column by 4 and
   * the edit landed mid-token. Both sides resync here, or neither does.
   */
  resync(rel: string): Promise<string>;
  close(): void;
}

/** Spawn the server, initialize, and hand back a session. */
export async function startSession(): Promise<Session> {
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
  const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });

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

  await request('initialize', {
    processId: process.pid,
    rootUri: `file://${ROOT}`,
    capabilities: { workspace: { workspaceEdit: { documentChanges: true } } },
  });
  notify('initialized', {});

  // The ONE authoritative record of what text the server has for each file. Every read of a
  // file's content in these tools goes through here, so a caller cannot hold a string the
  // server disagrees with.
  const opened = new Map<string, string>();
  let version = 1;

  const open = async (rel: string) => {
    const cached = opened.get(rel);
    if (cached !== undefined) return cached;
    const text = await Bun.file(`${ROOT}/${rel}`).text();
    notify('textDocument/didOpen',
      { textDocument: { uri: uriOf(rel), languageId: 'typescript', version: ++version, text } });
    opened.set(rel, text);
    return text;
  };

  const resync = async (rel: string) => {
    if (!opened.has(rel)) return open(rel);
    const text = await Bun.file(`${ROOT}/${rel}`).text();
    // `textDocumentSync.change` is 2 (incremental), but a full-range replacement is always legal
    // and is what we want: we are resyncing to disk, not describing a keystroke.
    notify('textDocument/didChange', {
      textDocument: { uri: uriOf(rel), version: ++version },
      contentChanges: [{ text }],
    });
    opened.set(rel, text);
    return text;
  };

  return { request, notify, open, resync, close: () => proc.kill() };
}

/**
 * Apply a `WorkspaceEdit`'s file->edits map to disk.
 *
 * Positions are converted to flat string offsets and edits applied LAST-FIRST, so an earlier edit
 * never shifts a later one's offsets. `positionEncoding` is utf-16 and JS strings are utf-16, so
 * `character` indexes directly.
 *
 * Ranges may span lines and `newText` may contain newlines — both are ordinary for a code action
 * (`removeUnusedImports` rewrites an import block as one multi-line insertion plus a deletion), even
 * though `textDocument/rename` only ever produces single-line, single-token edits. An earlier
 * line-oriented applier here handled the rename case and threw on the rest; a code action would
 * otherwise have inserted a newline mid-file.
 */
export async function applyEdits(byFile: Map<string, Edit[]>): Promise<void> {
  for (const [rel, edits] of byFile) {
    const path = `${ROOT}/${rel}`;
    const text = await Bun.file(path).text();
    await Bun.write(path, applyToText(text, edits, rel));
  }
}

/**
 * The pure core of `applyEdits`: text + edits -> text. Separate so a caller can ask "would this
 * change anything?" without writing (a `source.*` code action is offered for nearly every file and
 * usually rewrites the import block to exactly what it already was).
 */
export function applyToText(text: string, edits: Edit[], rel = '<text>'): string {
  // Line -> flat offset of that line's first character. LSP counts lines by \n, so this is the
  // same split the server used.
  const lineStart: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);
  const offsetOf = (p: Pos) => {
    const base = lineStart[p.line];
    if (base === undefined) throw new Error(`${rel}: edit at line ${p.line + 1}, file has ${lineStart.length} line(s)`);
    // Clamp to the line's end so a character past EOL (legal in LSP) cannot run into the next line.
    const end = p.line + 1 < lineStart.length ? lineStart[p.line + 1] - 1 : text.length;
    return Math.min(base + p.character, end);
  };

  const resolved = edits.map((e) => ({ start: offsetOf(e.range.start), end: offsetOf(e.range.end), newText: e.newText }));
  // Descending by start; for equal starts apply the later-ending one first so two insertions at one
  // point do not swap.
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const [i, e] of resolved.entries()) {
    if (e.start > e.end) throw new Error(`${rel}: inverted edit range`);
    const prev = resolved[i - 1];
    // Overlapping edits would corrupt silently; the protocol forbids them, so a violation is a
    // server bug or a merge of two independent WorkspaceEdits — either way, refuse.
    if (prev && e.end > prev.start) throw new Error(`${rel}: overlapping edit ranges, refusing to apply`);
  }

  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** Normalize a `WorkspaceEdit` (either encoding) into repo-relative path -> edits. */
export function editsOf(result: any): Map<string, Edit[]> {
  const byFile = new Map<string, Edit[]>();
  for (const d of result?.documentChanges ?? []) byFile.set(relOf(d.textDocument.uri), d.edits);
  for (const [u, e] of Object.entries<Edit[]>(result?.changes ?? {})) if (!byFile.has(relOf(u))) byFile.set(relOf(u), e);
  return byFile;
}
