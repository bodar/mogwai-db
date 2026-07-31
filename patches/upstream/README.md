# Patches we owe upstream

Fixes found while building mogwai that belong in someone else's repository. None is specific to our
server, so each is kept in a form that can be submitted as-is. Filenames are prefixed with the
project they target.

**This is not where a patch we APPLY lives.** The parent directory is bun's patch dir
(`--patches-dir` defaults to `./patches`), and only the files named in `package.json`'s
`patchedDependencies` are applied at install time — everything in here is inert. One fix appears in
both places on purpose; see `antlr4ng-dfa-state-hash-collision.patch` below.

## `antlr4ng` — hash collisions in the shared prediction DFA

`antlr4ng-dfa-state-hash-collision.patch` — a `git format-patch` commit against
[`mike-lischke/antlr4ng`](https://github.com/mike-lischke/antlr4ng) `src/dfa/DFA.ts`, plus a
regression test. `DFA` keyed a decision's states on `ATNConfigSet.hashCode()` and never consulted
`equals()`, so two structurally different configuration sets sharing a 32-bit hash were conflated
and one valid query permanently broke another — for the life of the process, which in a Durable
Object means every later request the isolate serves.

Raised as **[antlr4ng#109](https://github.com/mike-lischke/antlr4ng/pull/109), still open.** Until it
ships we carry the same fix locally as `../antlr4ng@3.0.16.patch` — that one is bun's format, applied
to the shipped `dist/index.cjs`/`dist/index.mjs` rather than to `src/`, and it is load-bearing (see
`CLAUDE.md` and `docs/outstanding-work.md` 0f). Close-out is: PR merges, bump, drop the bun patch,
delete this file.

## `apache/tinkerpop` — JS cucumber harness

Found running the official suite against mogwai. **Harness** bugs, not client bugs — each costs us
conformance scenarios or CI stability.

Kept as patch files (not submodule commits) so the submodule tree stays clean: it tracks
`origin/master` directly, and a dirty working tree would disrupt the build.

Apply from the submodule root (`vendor/tinkerpop`):

```sh
cd vendor/tinkerpop
git checkout -b <branch> origin/master
git apply ../../patches/upstream/tinkerpop-01-cucumber-uuid-import.patch
```

Both were verified to apply cleanly from a clean `origin/master` tree on 2026-07-26.

### 01 — the generated cucumber `gremlin.js` references an undefined `uuid`

The JS translator emits `uuid.parse(…)` / `uuid.v4()` for UUID literals (16 uses), but the
generated file never imports `uuid` and it is in neither `dependencies` nor `devDependencies`, so
every UUID scenario dies with `uuid is not defined`. Costs us `g_injectXUUIDXXX`.

The generator **is** in-tree — `gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy` —
and the generated `test/cucumber/gremlin.js` is tracked, so the patch touches three files: the
template's import block (the real fix), the `uuid` devDependency, and the regenerated output.

Verified: `uuid@14` exports both `parse` and `v4`, and `parse` returns the 16-byte array the
generated code expects.

### 02 — the cucumber server port is hard-coded

`test/helper.js` pins `45940`/`45941` with no override, so the suite cannot run on a host where
that port is taken — the intermittent CI conflict with our own conformance host, which must own
45940 because the client offers no way to configure it.

Adds `GREMLIN_SERVER_PORT` / `GREMLIN_SERVER_AUTH_PORT`, defaulting to the current values
(verified byte-identical when unset). Also drops a duplicated hard-coded copy in
`test/integration/traversal-test.js`, which already imports from `helper.js` and can just use its
`serverUrl` export.

### 03 — the multi-label default is untestable (an ISSUE, not a patch)

`tinkerpop-03-multilabel-default-untestable.md` is a write-up, not a patch: the fix is a
`gremlin-core` API addition, so it needs to be raised as an issue. Kept here because it is an
upstream payload like the rest.

## Not here

- **`toNumeric` cannot produce a BigInteger** — already written and pushed as
  `danielbodart/tinkerpop@fix-cucumber-bigint-numeric-parsing`; it needs a PR raised, not a patch.
- **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a **Bun** bug, not TinkerPop's
  (`close` is non-optional on undici's `Dispatcher`). Worked around in
  `test/support/undici-shim.ts`; report upstream to Bun. Do NOT "fix" it by making the client call
  `close?.()` — that would silently skip real connection-pool teardown wherever a dispatcher
  genuinely lacked it.
