// Shared browser-bundling config — ONE place both the production browser entries and the Playwright
// test harness bundle a browser worker, so they cannot disagree about the shims a browser build needs.
//
// The core is otherwise browser-clean (no `node:` imports of its own — the compiler, executor, and wire
// are runtime-agnostic). Two things a browser build must supply:
//   - `Buffer` — used ambiently across the wire layer. The worker ENTRY provides it (`import { Buffer }
//     from 'buffer'; globalThis.Buffer = Buffer`), which Bun's bundler resolves via its `buffer` browser
//     polyfill. Kept at the entry rather than here because it is a GLOBAL install, not a module rewrite.
//   - `node:util.isDeepStrictEqual` — the vendored gremlin client's one node-builtin export Bun's
//     browser polyfill lacks; aliased to our shim below.
import type { BunPlugin } from 'bun';

const NODE_UTIL_SHIM = Bun.fileURLToPath(import.meta.resolve('./node-util-shim.ts'));

/** Alias `node:util` (the client's only unpolyfilled builtin) to our shim. The shim provides
 *  `isDeepStrictEqual`; nothing else in the bundle imports from `node:util` (measured — one call site
 *  in the client build), so replacing the whole module is safe here. */
export function browserBundlePlugin(): BunPlugin {
  return {
    name: 'mogwai-browser-shims',
    setup(build) {
      build.onResolve({ filter: /^node:util$/ }, () => ({ path: NODE_UTIL_SHIM }));
    },
  };
}

/** Bundle a browser worker/entry to a single ESM string, with the browser shims applied. Throws with
 *  the bundler logs on failure (a missing polyfill export surfaces HERE, at build, not at runtime). */
export async function bundleBrowser(entry: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [browserBundlePlugin()],
  });
  if (!out.success) throw new Error(`browser bundle failed:\n${out.logs.map((l) => String(l)).join('\n')}`);
  return out.outputs[0].text();
}
