#!/bin/bash
# Claude Code on the web (remote) session bootstrap for mogwai-db.
#
# The web sandbox's egress policy blocks mise.run, *.jdx.dev, and third-party
# GitHub release hosts, so mise can neither self-install nor fetch bun the usual
# way. Instead we install mise from npm (registry.npmjs.org is allowed) and point
# it at the image's pre-installed bun via `mise link`, so no blocked host is
# touched. Project deps come from *.jsr.io, which must be on the egress allowlist.
set -euo pipefail

# Web sessions only — local machines have their own toolchain setup.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# mise pings *.jdx.dev to self-update / list versions; those are blocked here.
export MISE_VERSION_CHECK=0

# 1. Install mise itself from npm (the mise.run installer + GitHub releases are blocked).
command -v mise >/dev/null 2>&1 || npm install -g mise

# Expose the npm global bin (where mise lands) for the rest of this script.
NPM_BIN="$(npm prefix -g)/bin"
export PATH="$NPM_BIN:$PATH"

# 2. Point mise at the pre-installed bun instead of fetching it from GitHub. Link it
#    under the version mise.toml pins so the [tools] requirement is satisfied offline.
BUN_BIN="$(command -v bun || true)"
if [ -n "$BUN_BIN" ]; then
  BUN_PREFIX="$(cd "$(dirname "$BUN_BIN")/.." && pwd)"
  BUN_PIN="$(sed -n 's/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$CLAUDE_PROJECT_DIR/mise.toml" | head -1)"
  [ -n "$BUN_PIN" ] && mise link --force "bun@$BUN_PIN" "$BUN_PREFIX" >/dev/null
fi

# 3. Trust the repo config so mise reads it non-interactively.
mise trust "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true

# 4. Install project dependencies (requires *.jsr.io on the egress allowlist).
mise run install

# 5. Persist env for the session: mise on PATH + quiet version checks.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export MISE_VERSION_CHECK=0"
    echo "export PATH=\"$NPM_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi
