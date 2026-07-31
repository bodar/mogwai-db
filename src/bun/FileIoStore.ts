import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { IoStore } from '../iostore.ts';

/**
 * The Bun half of the IoStore seam: one configured directory, and `io("a/b.json")` is a path
 * under it. ROOTED — every path resolves against the root and is rejected if it escapes, so a
 * client-supplied `../../etc/passwd` reaches nothing. That check is the whole reason this is a
 * class over a root rather than a pair of free fs calls.
 *
 * The Cloudflare twin (R2IoStore) needs no such guard: an R2 key is a key, with no parent
 * directory to walk up into. That is also why a LEADING SLASH is not an absolute path here — a
 * path is a key under the root on both runtimes, so `io("/x.json")` names a key, not the host's
 * filesystem root.
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

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.locate(path)));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const full = this.locate(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  async list(prefix: string): Promise<string[]> {
    // Keys are root-relative and always `/`-separated, so a listing reads the same on both
    // runtimes — an R2 key has no platform separator to reproduce.
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath ?? this.root, e.name).slice(this.root.length + 1).split(sep).join('/'))
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}
