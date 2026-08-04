#!/usr/bin/env bash
# Provision our vendored submodules leanly: blobless (--filter=blob:none) + sparse
# (only the dirs we consume). Idempotent — safe to run every `mise run test`.
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

# Set by `provision` to the SHA it left the checkout at, for callers that need it (the
# client-build stamp below). A global rather than stdout: `provision` prints progress, so a
# command substitution around it would swallow that and mix it into the value.
PROVISIONED_SHA=

# Materialize $SM at exactly $PINNED, as leanly as the policy allows. Sparse-checkout is
# configured BEFORE anything is checked out — that ordering is the whole reason this script exists.
#
# `full`   — a blobless clone, then checkout the pin. History graph present (~19 MB for calcite,
#            more for tinkerpop), blobs fetched lazily.
# `shallow` — deliberately NOT `clone --depth 1` followed by a fetch of the pin. A pin is normally
#            BEHIND the remote tip (the commit that bumps it lands later than the commit it names),
#            and `git fetch --depth 1 origin <off-tip SHA>` does not fetch one commit: it reconciles
#            the shallow boundary and drags the history graph in with it. Measured on calcite —
#            3.9 MB of pack became 21 MB and stayed there, silently giving up the whole reason for
#            asking for `shallow`. So we never clone the tip at all: init, then fetch exactly the
#            pinned commit at depth 1. `git clone --revision=<sha>` does this in one step but needs
#            git 2.49 and ours is 2.43, so the config the clone would have written (promisor +
#            partialclonefilter, which is what keeps a later lazy blob fetch blobless) is set by hand.
clone_lean() {
  local SM="$1" URL="$2" POLICY="$3" PINNED="$4"; shift 4
  local SPARSE=("$@")

  if [ "$POLICY" = shallow ]; then
    git init --quiet "$SM"
    git -C "$SM" remote add origin "$URL"
    git -C "$SM" config remote.origin.promisor true
    git -C "$SM" config remote.origin.partialclonefilter blob:none
    git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
    # Requesting a SHA rather than a ref needs server-side `uploadpack.allowAnySHA1InWant`; both
    # remotes here are GitHub, which has it on.
    git -C "$SM" fetch --quiet --depth 1 --filter=blob:none origin "$PINNED"
  else
    git clone --filter=blob:none --no-checkout "$URL" "$SM"
    git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
  fi
  git -C "$SM" checkout --quiet "$PINNED"
}

# provision <path> <url> <shallow|full> <sparse-dir>...
#
# `shallow` costs a capability: only the pinned commit exists, so `git log`/`git blame` inside that
# checkout see one commit, and moving the pin means re-provisioning (below). Take that for a
# submodule we only ever READ at the pin (calcite); not for one whose history we compare against
# upstream (tinkerpop). Measured on calcite: 17 MB shallow+sparse, vs 30 MB keeping the full history
# graph, vs 52 MB for a naive `--depth 1` full tree.
provision() {
  local SM="$1" URL="$2" POLICY="$3"; shift 3
  local SPARSE=("$@")

  # Pinned commit recorded in the superproject's INDEX (the gitlink). Read the index,
  # not `ls-tree HEAD`: the index is what `git submodule update` honours, so a staged
  # (not yet committed) pin bump provisions the same commit the update path would.
  local PINNED
  PINNED="$(git ls-files -s "$SM" | awk '{print $2}')"
  if [ -z "$PINNED" ]; then
    echo "[submodule] $SM has no gitlink in the index — is .gitmodules committed?" >&2
    exit 1
  fi
  PROVISIONED_SHA="$PINNED"

  local FRESH=""
  if [ ! -e "$SM/.git" ]; then
    FRESH="fresh blobless+sparse provision"
  else
    # Already provisioned: keep sparse set and move to the pinned SHA when the checkout has
    # DRIFTED from it. Drift is the normal state after `git pull`/`git checkout` of a superproject
    # commit that bumped the pin, and after work in a linked worktree (which provisions its OWN
    # vendor/ and leaves this one where it was) — measured: this checkout sat at beta.2 while the
    # gitlink had moved ~300 commits, so `TreeSerializer.js` was absent from a tree whose pin
    # contains it. Reported, not silent: a stale checkout is the one failure mode here that
    # produces wrong ANSWERS (conformance run against a client the pin does not describe) rather
    # than an error.
    git -C "$SM" sparse-checkout set --cone "${SPARSE[@]}"
    local HEAD_SHA
    HEAD_SHA="$(git -C "$SM" rev-parse HEAD)"
    if [ "$HEAD_SHA" != "$PINNED" ]; then
      echo "[submodule] $SM drifted: ${HEAD_SHA:0:10} -> pinned ${PINNED:0:10}"
      if [ "$POLICY" = shallow ]; then
        # A shallow checkout cannot MOVE without deepening (see clone_lean), so moving the pin is
        # a re-provision. It costs ~0.5s and is exactly lean by construction.
        FRESH="re-provision"
      else
        # `--filter` is only honoured with `--init`, but the clone recorded
        # remote.origin.partialclonefilter=blob:none, so a fetch for an unseen pin stays blobless.
        git -C "$SM" cat-file -e "$PINNED^{commit}" 2>/dev/null \
          || git -C "$SM" fetch --quiet origin "$PINNED"
        git -C "$SM" checkout --quiet "$PINNED"
      fi
    fi
  fi

  if [ -n "$FRESH" ]; then
    echo "[submodule] $FRESH of $SM at ${PINNED:0:10} (blobless+sparse, $POLICY)"
    # Both the working tree and the ABSORBED gitdir go: `absorbgitdirs` below refuses a target that
    # already exists, and on a re-provision a leftover pack there is exactly what we are discarding.
    local GITDIR
    GITDIR="$(git rev-parse --git-dir)/modules/$SM"
    rm -rf "$SM" "$GITDIR"
    clone_lean "$SM" "$URL" "$POLICY" "$PINNED" "${SPARSE[@]}"
    git submodule absorbgitdirs "$SM"
    git submodule init "$SM"
  fi
}

# ── tinkerpop: the upstream we track ──────────────────────────────────────────────────────────
#
# gremlin-language: the Gremlin.g4 grammar source (locked decision #2).
# gremlin-js: the GLV we link as `gremlin` + the cucumber runner. gremlin-test: the .feature corpus.
# gremlin-core: READ-ONLY reference, never built or imported — the Java core engine our naming and
# semantics claims cite. Without it those citations point at a clone outside the repo, at a
# different SHA than the gitlink, so nobody else and no CI run can check them (see
# docs/2026-07-29-tinkerpop-core-engine-alignment.md). +9.8MB against ~400MB already checked out.
#
# `full`, not `shallow`: we read this history — a pin bump is diffed against the previous pin.
provision vendor/tinkerpop https://github.com/apache/tinkerpop.git full \
  gremlin-language gremlin-js gremlin-test gremlin-core
SM=vendor/tinkerpop
PINNED="$PROVISIONED_SHA"

# ── calcite: READ-ONLY prior art for the RelIR ────────────────────────────────────────────────
#
# Never built, never imported, no Java toolchain implied — the same standing as gremlin-core, and
# vendored for the same reason: `src/rel/`'s design cites Calcite's relational-algebra-to-SQL
# machinery, and a citation that resolves only on one laptop is uncheckable by anyone else and by
# CI. At the pin, `vendor/calcite/core/src/main/java/org/apache/calcite/<dir>/<File>.java:NNN`
# resolves for everyone.
#
# The sparse set is what it takes to TRACE that machinery, not a guess at what looks relevant:
#   rel     — the algebra itself, and rel/rel2sql (RelToSqlConverter + SqlImplementor), the
#             closest analogue anywhere to src/rel/emit.ts
#   rex     — RexNode; SqlImplementor is mostly a Rex dispatch, so rel2sql is unreadable without it
#   plan    — RelOptUtil, RelTraitSet: the vocabulary rel/ is written in
#   sql     — SqlNode/SqlDialect, what rel2sql produces
#   sql2rel — RelDecorrelator, the decorrelation prior art
#   util    — ImmutableBitSet, Pair, Util: reached from every file above
#   tools   — RelBuilder, the fluent construction API our lowering is the analogue of
# 16 MB, ~0.5s to clone (measured). Cheap enough to keep in the DEFAULT path — so a fresh checkout
# has it without a second command — against a submodule step that already moves ~400 MB and builds
# a client.
CALCITE_SRC=core/src/main/java/org/apache/calcite
provision vendor/calcite https://github.com/apache/calcite.git shallow \
  "$CALCITE_SRC/rel" "$CALCITE_SRC/rex" "$CALCITE_SRC/plan" "$CALCITE_SRC/sql" \
  "$CALCITE_SRC/sql2rel" "$CALCITE_SRC/util" "$CALCITE_SRC/tools"

# ── the gremlin client: install deps, build, register the link ─────────────────────────────────

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
