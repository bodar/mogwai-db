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
  # Pinned commit recorded in the superproject's tree (the gitlink).
  SHA="$(git ls-tree HEAD "$SM" | awk '{print $3}')"
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
# (@cucumber/cucumber, etc.). Bun runs the TS/JS in lib/ natively — no build, so
# --ignore-scripts skips the package's prepare (antlr generate + tsc build), whose
# tsc otherwise fails resolving this repo's bun-types.
# gremlin-js/ is the bun workspace root (workspaces: gremlin-javascript, -mcp,
# gremlint); install there. --ignore-scripts skips gremlint's prepare tsc build.
echo "[submodule] installing gremlin-js workspace deps (cucumber runner)"
(cd "$SM/gremlin-js" && bun install --ignore-scripts)
echo "[submodule] ready"
