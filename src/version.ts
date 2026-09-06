// The ONE source of truth for the running version, surfaced in the OpenAPI `info.version` and by the Bun
// CLI's `--version`. DERIVED from the repo (major.commitCount.build — `scripts/version.ts`) and STAMPED
// into each artifact at build time by `scripts/package.ts`, which DEFINES the bare `MOGWAI_VERSION`
// identifier for every browser bundle, compiled binary, and worker package. Run UNSTAMPED from source
// (mise, the test suite, `bun src/bun/server.ts`) the identifier is undefined and this reads `'dev'` — an
// honest marker that this is not a released build.
//
// A BARE identifier (`MOGWAI_VERSION`), not `process.env.MOGWAI_VERSION`, is load-bearing for the BROWSER:
// a browser bundle has no `process` global, so the previous `typeof process !== 'undefined' ? … : undefined`
// guard — needed so an UNSTAMPED bundle would not throw — took the `undefined` branch at RUNTIME and hid
// the stamped literal, so the deployed Pages site read `'dev'`. `typeof MOGWAI_VERSION` is safe on an
// undeclared name (yields `'undefined'`, never a ReferenceError), so the guard and the stamped value can
// coexist: the packager's `define` folds `MOGWAI_VERSION` to the literal (reachable, no `process`), and an
// unstamped build reads `'dev'`. Bun/CF also define the same bare identifier, so all three agree.
declare const MOGWAI_VERSION: string | undefined;
export const VERSION = (typeof MOGWAI_VERSION === 'string' ? MOGWAI_VERSION : undefined) ?? 'dev';
