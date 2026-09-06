// The ONE source of truth for the running version, surfaced in the OpenAPI `info.version` and by the Bun
// CLI's `--version`. DERIVED from the repo (major.commitCount.build — `scripts/version.ts`) and STAMPED
// into each artifact at build time by `scripts/package.ts`, which defines `process.env.MOGWAI_VERSION`
// for every browser bundle, compiled binary, and worker package. Run UNSTAMPED from source (mise, the
// test suite, `bun src/bun/server.ts`) the env var is unset and this reads `'dev'` — an honest marker
// that this is not a released build.
//
// The `typeof process` guard is load-bearing for the BROWSER build: there is no `process` global there, so
// a bare `process.env.…` read would throw at module load and take the whole Service Worker down. The
// packager stamps the real value by DEFINING `process.env.MOGWAI_VERSION` (scripts/package.ts), which the
// bundler folds to a string literal in place — so the guard costs the browser nothing once stamped, and an
// UNSTAMPED browser bundle (a test bundle, an ad-hoc build) safely reads `'dev'` instead of crashing.
export const VERSION = (typeof process !== 'undefined' ? process.env.MOGWAI_VERSION : undefined) ?? 'dev';
