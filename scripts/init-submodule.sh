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
SPARSE=(gremlin-language gremlin-js gremlin-test)

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
GLV="$SM/gremlin-js/gremlin-javascript"
if [ ! -f "$GLV/build/esm/structure/io/binary/GraphBinary.js" ]; then
  echo "[submodule] building the gremlin client (needed by the gremlin/io export)"
  (cd "$GLV" && bun run build)
fi

# Register + consume the link. `bun link` in the package registers it globally;
# `bun link gremlin` in the superproject swaps node_modules/gremlin for a symlink.
# Both are idempotent. Guarded so a plain `bun install` that restored the npm
# package re-points it back to the submodule.
if [ "$(readlink "$ROOT/node_modules/gremlin" 2>/dev/null)" != "../$GLV" ]; then
  echo "[submodule] linking gremlin -> $GLV"
  (cd "$GLV" && bun link >/dev/null)
  bun link gremlin >/dev/null
fi
echo "[submodule] ready"
