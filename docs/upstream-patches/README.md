# Upstream patches for `apache/tinkerpop`

Fixes to the TinkerPop JS cucumber harness found while running the official suite against mogwai.
They are **harness** bugs, not client bugs — each one costs us conformance scenarios or CI
stability, and none of them is specific to our server.

Kept as patch files (not submodule commits) so the submodule tree stays clean: it tracks
`origin/master` directly, and a dirty working tree would disrupt the build.

Apply from the submodule root (`vendor/tinkerpop`):

```sh
cd vendor/tinkerpop
git checkout -b <branch> origin/master
git apply ../../docs/upstream-patches/01-cucumber-uuid-import.patch
```

Both were verified to apply cleanly from a clean `origin/master` tree on 2026-07-26.

## 01 — the generated cucumber `gremlin.js` references an undefined `uuid`

The JS translator emits `uuid.parse(…)` / `uuid.v4()` for UUID literals (16 uses), but the
generated file never imports `uuid` and it is in neither `dependencies` nor `devDependencies`, so
every UUID scenario dies with `uuid is not defined`. Costs us `g_injectXUUIDXXX`.

The generator **is** in-tree — `gremlin-js/gremlin-javascript/scripts/groovy/generate.groovy` —
and the generated `test/cucumber/gremlin.js` is tracked, so the patch touches three files: the
template's import block (the real fix), the `uuid` devDependency, and the regenerated output.

Verified: `uuid@14` exports both `parse` and `v4`, and `parse` returns the 16-byte array the
generated code expects.

## 02 — the cucumber server port is hard-coded

`test/helper.js` pins `45940`/`45941` with no override, so the suite cannot run on a host where
that port is taken — the intermittent CI conflict with our own conformance host, which must own
45940 because the client offers no way to configure it.

Adds `GREMLIN_SERVER_PORT` / `GREMLIN_SERVER_AUTH_PORT`, defaulting to the current values
(verified byte-identical when unset). Also drops a duplicated hard-coded copy in
`test/integration/traversal-test.js`, which already imports from `helper.js` and can just use its
`serverUrl` export.

## Not here

- **`toNumeric` cannot produce a BigInteger** — already written and pushed as
  `danielbodart/tinkerpop@fix-cucumber-bigint-numeric-parsing`; it needs a PR raised, not a patch.
- **Bun's `undici` shim lacks `Agent.close()`/`destroy()`** — a **Bun** bug, not TinkerPop's
  (`close` is non-optional on undici's `Dispatcher`). Worked around in
  `test/support/undici-shim.ts`; report upstream to Bun. Do NOT "fix" it by making the client call
  `close?.()` — that would silently skip real connection-pool teardown wherever a dispatcher
  genuinely lacked it.
