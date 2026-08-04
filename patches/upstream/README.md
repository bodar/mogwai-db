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

Verified to apply cleanly from a clean `origin/master` tree: 01 on 2026-07-26, 04 on 2026-08-04.

### 01 — the generated cucumber `gremlin.js` references an undefined `uuid`

The JS translator emits `uuid.parse(…)` / `uuid.v4()` for UUID literals (16 uses), but the
generated file never imports `uuid` and it is in neither `dependencies` nor `devDependencies`, so
every UUID scenario dies with `uuid is not defined`. Costs us `g_injectXUUIDXXX`.

The generator **is** in-tree — `gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy` —
and the generated `test/cucumber/gremlin.js` is tracked, so the patch touches three files: the
template's import block (the real fix), the `uuid` devDependency, and the regenerated output.

Verified: `uuid@14` exports both `parse` and `v4`, and `parse` returns the 16-byte array the
generated code expects.

### 02 — WITHDRAWN, superseded by 04

Was "make the hard-coded cucumber port configurable" (`GREMLIN_SERVER_PORT`). Deleted rather than
kept, because 04 removes the reason to want it: with an injectable `fetch` there is no port to
configure, and shipping both would have offered a workaround for a problem the other patch cures.
The port is a symptom — the suite could only reach a server by URL.

### 03 — the multi-label default is untestable (an ISSUE, not a patch)

`tinkerpop-03-multilabel-default-untestable.md` is a write-up, not a patch: the fix is a
`gremlin-core` API addition, so it needs to be raised as an issue. Kept here because it is an
upstream payload like the rest.

### 04 — the client cannot be given a `fetch`, so the suite needs a socket

`tinkerpop-04-connection-fetch-option.patch` adds `ConnectionOptions.fetch`, defaulting to the
platform default exactly as today (`options.fetch ?? httpFetch.fetch`, read at call time so the
existing test-swap of the holder still works). Two files' worth of behaviour, ~15 lines, one call
site.

The point is what it unlocks: `fetch`, a Bun/Node server handler and a service-worker `fetch` handler
all have the shape `(Request) => Promise<Response>`, so an embedder that already owns its server can
hand the handler straight to the client and **no socket is ever opened**. The official cucumber suite
then runs in the same process as the server under test.

That is worth having upstream for the reason 02 existed: `test/helper.js` hard-codes 45940, which is
inside Linux's ephemeral range, so it can be taken as the SOURCE port of any unrelated outbound
connection on the host and then fail to bind with `EADDRINUSE` while nothing listens. A port override
makes that rarer; not needing a port makes it impossible.

`lib/driver/dispatcher.ts` already says the holder exists "so tests can swap `fetch`", so this is that
intent finished as a supported option rather than a monkeypatch. We use it as the give-back; our own
L3 still swaps the holder, because upstream's cucumber world constructs its connections in
`test/helper.js` and takes no options (`test/support/in-memory-transport.ts` explains the rest).

Verified: applies cleanly to `origin/master` at the pinned gitlink, and `tsc --noEmit` is clean in the
patched client.

## Not here

- **`toNumeric` cannot produce a BigInteger** — already written and pushed as
  `danielbodart/tinkerpop@fix-cucumber-bigint-numeric-parsing`; it needs a PR raised, not a patch.
- **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a **Bun** bug, not TinkerPop's
  (`close` is non-optional on undici's `Dispatcher`). Worked around in
  `test/support/undici-shim.ts`; report upstream to Bun. Do NOT "fix" it by making the client call
  `close?.()` — that would silently skip real connection-pool teardown wherever a dispatcher
  genuinely lacked it.
