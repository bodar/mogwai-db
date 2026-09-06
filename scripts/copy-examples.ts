#!/usr/bin/env bun
// Stage the example datasets (src/examples.ts) from the vendored TinkerPop GraphSON corpus into the two
// build locations that serve them, mirroring how `mise run assets` stages the Scalar UI:
//
//   - public/examples/<name>.json      — the served .json copies. Cloudflare uploads them as Static Assets
//                                        (wrangler `assets.directory: ./public`, served at /examples/<name>.json)
//                                        and the browser release copies them beside the docs (scripts/package.ts).
//   - src/bun/examples/<name>.graphson — the Bun binary-EMBED copies. Bun's `with { type: 'file' }` import
//                                        (BunAssetStore.ts) resolves these into the compiled binary. The
//                                        extension is `.graphson`, NOT `.json`, on purpose: the files are
//                                        newline-delimited GraphSON, so tsc's `resolveJsonModule` would try
//                                        to PARSE a .json import (and choke on the JSONL), whereas an
//                                        extension tsc has no loader for falls back to the `*.graphson`
//                                        ambient (src/bun/asset-imports.d.ts) and types as a file-path string
//                                        — the same trick `*/standalone.js`/`*.png` already use for scalar.js.
//
// Both are gitignored build artifacts (see .gitignore). Run by `mise run examples`; the release copies come
// straight from the vendored corpus via the exported helper below (scripts/package.ts), so a `dist/` build
// never depends on this having populated `public/` first.
import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXAMPLE_DATASETS, EXAMPLE_GRAPHSON_DIR } from '../src/examples.ts';

const ROOT = new URL('..', import.meta.url).pathname;

/** Copy every example dataset from the vendored GraphSON corpus into `destDir`, named `<name><ext>`.
 *  Creates `destDir`. Returns the written absolute paths. `ext` defaults to the served `.json` name; the
 *  Bun embed asks for `.graphson` (see the header). */
export async function copyExamplesTo(destDir: string, ext = '.json'): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const written: string[] = [];
  for (const d of EXAMPLE_DATASETS) {
    const src = join(ROOT, EXAMPLE_GRAPHSON_DIR, d.vendorFile);
    const dst = join(destDir, `${d.name}${ext}`);
    await copyFile(src, dst);
    written.push(dst);
  }
  return written;
}

if (import.meta.main) {
  await copyExamplesTo(join(ROOT, 'public', 'examples'), '.json');
  await copyExamplesTo(join(ROOT, 'src', 'bun', 'examples'), '.graphson');
  console.log(`staged ${EXAMPLE_DATASETS.length} example datasets → public/examples/*.json + src/bun/examples/*.graphson`);
}
