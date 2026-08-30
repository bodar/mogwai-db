// mkdir/rm have no `Bun.*` namespace equivalent — Bun implements node:fs natively and that is the
// idiomatic way to make/remove a directory here. Existence checks (Bun.file().exists()), recursive
// listing (Bun.Glob) and the byte streams (Bun.file().stream()/.writer()) all use Bun's own APIs.
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { IoSink, IoStore } from '../iostore.ts';

/**
 * The Bun half of the IoStore seam: one configured directory, and `io("a/b.json")` is a path
 * under it. ROOTED — every path resolves against the root and is rejected if it escapes, so a
 * client-supplied `../../etc/passwd` reaches nothing. That check is the whole reason this is a
 * class over a root rather than a pair of free fs calls.
 *
 * STREAMING both ways (the seam's contract): a read is `Bun.file(...).stream()`, a write drains
 * into a `Bun.file(...).writer()` FileSink — each an incremental, OS-buffered pipe, so a 10 GB
 * document never sits in the isolate's heap. The Cloudflare twin (R2IoStore) reaches the same
 * bound through R2 multipart upload.
 *
 * The Cloudflare twin needs no rooting guard: an R2 key is a key, with no parent directory to walk
 * up into. That is also why a LEADING SLASH is not an absolute path here — a path is a key under
 * the root on both runtimes, so `io("/x.json")` names a key, not the host's filesystem root.
 */
export class FileIoStore implements IoStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve `path` under the root, or throw. `resolve` collapses `..` first, so the prefix test
   *  is on the FINAL location — the only form that cannot be tricked by a path that leaves and
   *  re-enters (`a/../../root/x`). */
  private locate(path: string): string {
    const full = resolve(join(this.root, path));
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error(`io("${path}"): path escapes the configured io directory`);
    return full;
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const full = this.locate(path);
    // Fail closed on a missing key — the absence surfaces HERE (as R2IoStore's does), not silently
    // on the first chunk read. `Bun.file().exists()` is the Bun-native stat; the message mirrors
    // R2's `no such object` so the two IoStore leaves read alike.
    if (!(await Bun.file(full).exists()))
      throw new Error(`io("${path}"): no such document in the io directory`);
    return Bun.file(full).stream();
  }

  async writeStream(path: string): Promise<IoSink> {
    const full = this.locate(path);
    await mkdir(dirname(full), { recursive: true });
    const sink = Bun.file(full).writer();
    return {
      write: async (chunk) => { sink.write(chunk); },
      close: async () => { await sink.end(); },
      // A failed drain must not leave a half-graph behind — flush what is queued to release the
      // handle, then remove the partial file (`force` so a never-touched path is a no-op).
      abort: async () => { await sink.end(); await rm(full, { force: true }); },
    };
  }

  async list(prefix: string): Promise<string[]> {
    // Keys are root-relative and always `/`-separated (Bun.Glob normalizes), so a listing reads the
    // same on both runtimes — an R2 key has no platform separator to reproduce. `**/*` matches
    // root-level files as well as nested ones; `dot: true` keeps a dot-prefixed key, which the old
    // `readdir` walk also returned.
    const keys: string[] = [];
    for await (const key of new Bun.Glob('**/*').scan({ cwd: this.root, onlyFiles: true, dot: true }))
      if (key.startsWith(prefix)) keys.push(key);
    return keys.sort();
  }
}
