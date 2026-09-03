/**
 * THE BRACKET FUNCTION — the total partition of the test suite into named brackets, shared by every
 * consumer so they cannot disagree about what exists.
 *
 *   - CI's single-bracket runner + matrix + list  → scripts/test-bracket.ts
 *   - the LOCAL parallel fan-out                   → scripts/test-all.ts
 *
 * Both import `brackets()` from here. That shared import IS the load-bearing property: the brackets are
 * DERIVED from discovery (not a hand-written path list), so a new `test/L6-whatever/` dir becomes its
 * own `L6` bracket everywhere at once, and the union of the brackets is `bun test` by construction.
 * Keep everything here PURE and path-only (no spawning, no env) so `--matrix`, `--list`, a CI shard,
 * and the local orchestrator all compute the identical set without re-scanning differently.
 */

/** Bun's own test-file patterns, so discovery here matches a bare `bun test`. `bunfig.toml` scopes
 *  the root to `test/`; this mirrors that. */
export const PATTERNS = [
  'test/**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_test_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  'test/**/*_spec_*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
];

/** The TOTAL bracket function. `test/L<n>-…` → `L<n>`; `test/browser/…` → `browser` (its own runner, so
 *  the one bracket that launches a real Chrome is isolated and legible — a red `test (browser)` says the
 *  browser lane broke); anything else → `other`. Pure and path-only so every caller agrees. */
export function bracketOf(file: string): string {
  if (file.startsWith('test/browser/')) return 'browser';
  return file.match(/^test\/(L\d+)-/)?.[1] ?? 'other';
}

/** Discover the whole suite, deduped and sorted (total order → reproducible across machines). */
export function discover(root: string): string[] {
  const files = [...new Set(PATTERNS.flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: root })]))].sort();
  if (!files.length) throw new Error(`no test files discovered under test/ — ${PATTERNS.length} patterns matched nothing`);
  return files;
}

/** Group discovered files by bracket. Bracket order: L-levels ascending by number, then `browser`, then
 *  `other` last (so the matrix and the --list output read L1, L2, …, browser, other). */
export function brackets(root: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of discover(root)) {
    const key = bracketOf(file);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(file);
  }
  const rank = (k: string) => (k === 'other' ? Number.MAX_SAFE_INTEGER : k === 'browser' ? Number.MAX_SAFE_INTEGER - 1 : Number(k.slice(1)));
  const ordered = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  return new Map(ordered.map((k) => [k, groups.get(k)!.sort()]));
}

/** The repository root, one level up from `scripts/`. Callers pass it to the functions above. */
export const REPO_ROOT = new URL('..', import.meta.url).pathname;
