#!/usr/bin/env bash
# Provision the tinkerpop submodule leanly: blobless (--filter=blob:none) + sparse
# (only the three dirs we consume). Idempotent — safe to run every `mise run test`.
#
# Why a script and not plain `git submodule update --init`: sparse-checkout must be
# configured BEFORE the working tree is populated, or a blobless checkout still
# fetches every blob in the tree at that commit (hundreds of MB). Stock submodule
# update gives no hook between clone and checkout, so on a fresh tree we clone
# --no-checkout, set sparse, then checkout the pinned gitlink SHA ourselves.
set -euo pipefail

# Neutralize CDPATH: if set in the caller's environment, `cd` to a dir found via
# CDPATH echoes the resolved path to stdout, which would poison the command
# substitution below (ROOT would capture the path twice) and break `cd "$ROOT"`.
unset CDPATH

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SM=vendor/tinkerpop
URL=https://github.com/apache/tinkerpop.git
# gremlin-language: the Gremlin.g4 grammar source (locked decision #2).
# gremlin-js: the GLV we link as `gremlin` + the cucumber runner. gremlin-test: the .feature corpus.
# gremlin-core: READ-ONLY reference, never built or imported — the Java core engine our naming and
# semantics claims cite. Without it those citations point at a clone outside the repo, at a
# different SHA than the gitlink, so nobody else and no CI run can check them (see
# docs/2026-07-29-tinkerpop-core-engine-alignment.md). +9.8MB against ~400MB already checked out.
SPARSE=(gremlin-language gremlin-js gremlin-test gremlin-core)

if [ ! -e "$SM/.git" ]; then
  echo "[submodule] fresh blobless+sparse provision of $SM"
  # Pinned commit recorded in the superproject's INDEX (the gitlink). Read the index,
  # not `ls-tree HEAD`: the index is what `git submodule update` honours, so a staged
  # (not yet committed) pin bump provisions the same commit the update path would.
  SHA="$(git ls-files -s "$SM" | awk '{print $2}')"
  rm -rf "$SM"
  git clone --filter=blob:none --no-checkout "$URL" "$SM"
  git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
  git -C "$SM" checkout --quiet "$SHA"
  git submodule absorbgitdirs "$SM"
  git submodule init "$SM"
else
  # Already provisioned: keep sparse set and fast-forward to the pinned SHA.
  # --filter is only honoured with --init (no-op here since already cloned).
  git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
  git submodule update --init --filter=blob:none "$SM"
fi

# The cucumber runner + GLV source live in the submodule and need their own deps
# (@cucumber/cucumber, etc.). gremlin-js/ is the bun workspace root (workspaces:
# gremlin-javascript, -mcp, gremlint); install there. --ignore-scripts skips the
# packages' prepare (antlr generate + tsc build) — gremlint's tsc otherwise fails
# resolving this repo's bun-types, and we drive the build we DO need explicitly below.
echo "[submodule] installing gremlin-js workspace deps (cucumber runner)"
(cd "$SM/gremlin-js" && bun install --ignore-scripts)

# The SERVER frames responses with the same client the conformance suite tests it
# with, so `gremlin` resolves to the submodule rather than the npm package (npm's
# newest v4 is 4.0.0-beta.2, ~300 commits behind and without the ./io export). The
# package's `exports` map points at build/esm, so the build must exist before the
# link is usable — `bun run build` (duel) emits both ESM and CJS. Skipped when the
# build is already current, since it costs ~30s.
#
# GREMLIN_CLIENT_BUILD_CACHE (optional, CI only — unset locally, where the build survives in the
# tree anyway) names a directory OUTSIDE the submodule holding a previously-built client. It has
# to be outside: the fresh-clone branch above `rm -rf`s $SM, so anything a CI cache restored into
# the submodule would be gone by the time we get here. The caller is responsible for keying that
# cache on the gitlink SHA — this script adopts whatever it is given, exactly as it would trust a
# build already present in the tree.
GLV="$SM/gremlin-js/gremlin-javascript"
BUILT="$GLV/build/esm/structure/io/binary/GraphBinary.js"
CACHE="${GREMLIN_CLIENT_BUILD_CACHE:-}"
if [ ! -f "$BUILT" ] && [ -n "$CACHE" ] && [ -f "$CACHE/esm/structure/io/binary/GraphBinary.js" ]; then
  echo "[submodule] adopting the cached gremlin client build from $CACHE"
  mkdir -p "$GLV/build"
  cp -a "$CACHE/." "$GLV/build/"
fi
if [ ! -f "$BUILT" ]; then
  echo "[submodule] building the gremlin client (needed by the gremlin/io export)"
  (cd "$GLV" && bun run build)
  # Populate the cache for the next run. Write to a temp dir and move it into place so an
  # interrupted copy cannot leave a HALF-BUILT client for the next run to adopt.
  if [ -n "$CACHE" ] && [ -f "$BUILT" ]; then
    rm -rf "$CACHE" "$CACHE.tmp"
    mkdir -p "$CACHE.tmp"
    cp -a "$GLV/build/." "$CACHE.tmp/"
    mv "$CACHE.tmp" "$CACHE"
  fi
fi

# REGISTER the link only. `bun link` inside the package publishes it to bun's global link
# registry; CONSUMING it is package.json's job now (`"gremlin": "link:gremlin"`), which is why
# this no longer runs `bun link gremlin` in the superproject or guards on readlink.
#
# That inversion is the point: while the superproject declared the npm dep, any plain
# `bun install` re-installed 4.0.0-beta.2 over the symlink and only a later `mise run submodule`
# healed it — so the client silently changed under whatever ran in between. With the link: dep,
# `bun install` reproduces the symlink, and on a machine where this registration has NOT happened
# it fails outright instead of falling back to npm. Hence `[tasks.install]` depends on this task:
# registration must precede the superproject's install, and this script deliberately needs nothing
# from the superproject's node_modules, which is what keeps that edge acyclic.
#
# Unconditional (not guarded): re-registering is idempotent and costs milliseconds, and the guard
# it replaces was itself the workaround for the clobber that no longer happens.
echo "[submodule] registering the gremlin link -> $GLV"
(cd "$GLV" && bun link >/dev/null)
echo "[submodule] ready"
