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

# Pinned commit recorded in the superproject's INDEX (the gitlink). Read the index,
# not `ls-tree HEAD`: the index is what `git submodule update` honours, so a staged
# (not yet committed) pin bump provisions the same commit the update path would.
PINNED="$(git ls-files -s "$SM" | awk '{print $2}')"

if [ ! -e "$SM/.git" ]; then
  echo "[submodule] fresh blobless+sparse provision of $SM"
  rm -rf "$SM"
  git clone --filter=blob:none --no-checkout "$URL" "$SM"
  git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
  git -C "$SM" checkout --quiet "$PINNED"
  git submodule absorbgitdirs "$SM"
  git submodule init "$SM"
else
  # Already provisioned: keep sparse set and move to the pinned SHA when the checkout has
  # DRIFTED from it. Drift is the normal state after `git pull`/`git checkout` of a superproject
  # commit that bumped the pin, and after work in a linked worktree (which provisions its OWN
  # vendor/tinkerpop and leaves this one where it was) — measured: this checkout sat at beta.2
  # while the gitlink had moved ~300 commits, so `TreeSerializer.js` was absent from a tree whose
  # pin contains it. Reported, not silent: a stale checkout is the one failure mode here that
  # produces wrong ANSWERS (conformance run against a client the pin does not describe) rather
  # than an error.
  git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
  HEAD_SHA="$(git -C "$SM" rev-parse HEAD)"
  if [ "$HEAD_SHA" != "$PINNED" ]; then
    echo "[submodule] checkout drifted: ${HEAD_SHA:0:10} -> pinned ${PINNED:0:10}"
    # --filter is only honoured with --init, but the clone recorded
    # remote.origin.partialclonefilter=blob:none, so a fetch for an unseen pin stays blobless.
    git submodule update --init --filter=blob:none "$SM"
  fi
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
# "Current" is a SHA match, not file existence. The existence guard this replaces made a pin bump
# a no-op for the artifact everything actually imports: the checkout moved, `build/esm/…` still
# held the OLD commit's client, and nothing anywhere said so. Measured on this tree — source had
# `TreeSerializer.js`, `build/esm/…/internals/` did not, and the build was three weeks older than
# the checkout. The stamp lives INSIDE build/, so deleting the build invalidates it by
# construction and cannot outlive what it certifies. `MOGWAI_FORCE_CLIENT_BUILD=1` for the one
# case a SHA cannot see: hand-edited submodule source (an upstream patch under development).
GLV="$SM/gremlin-js/gremlin-javascript"
BUILT_FROM="$GLV/build/.mogwai-built-from"
if [ ! -f "$GLV/build/esm/structure/io/binary/GraphBinary.js" ] \
  || [ "$(cat "$BUILT_FROM" 2>/dev/null || true)" != "$PINNED" ] \
  || [ -n "${MOGWAI_FORCE_CLIENT_BUILD:-}" ]; then
  echo "[submodule] building the gremlin client at ${PINNED:0:10} (needed by the gremlin/io export)"
  (cd "$GLV" && bun run build)
  echo "$PINNED" > "$BUILT_FROM"
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
