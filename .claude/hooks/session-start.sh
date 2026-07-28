#!/bin/bash
# Claude Code on the web (remote) session bootstrap for mogwai-db.
#
# Web sessions run with unrestricted network egress, so mise installs itself via the
# official installer (mise.run) and fetches whatever it needs directly. We still link
# the image's pre-installed bun under the version mise.toml pins, so the [tools]
# requirement is satisfied without a redundant download.
set -euo pipefail

# Web sessions only — local machines have their own toolchain setup.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# Keep the bootstrap fast and deterministic — skip mise's self-update version pings.
export MISE_VERSION_CHECK=0

# 1. Install mise via the official installer unless it's already present. The
#    installer drops the binary in ~/.local/bin.
MISE_BIN="$HOME/.local/bin"
command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh
export PATH="$MISE_BIN:$PATH"

# 2. Trust the repo config so every mise command below reads it non-interactively.
mise trust "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true

# 3. Point mise at the pre-installed bun instead of downloading it. Link it under the
#    version mise.toml pins so the [tools] requirement is satisfied.
BUN_BIN="$(command -v bun || true)"
if [ -n "$BUN_BIN" ]; then
  BUN_PREFIX="$(cd "$(dirname "$BUN_BIN")/.." && pwd)"
  BUN_PIN="$(sed -n 's/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$CLAUDE_PROJECT_DIR/mise.toml" | head -1)"
  [ -n "$BUN_PIN" ] && mise link --force "bun@$BUN_PIN" "$BUN_PREFIX" >/dev/null
fi

# 4. Install project dependencies. NB this now provisions the submodule and builds the gremlin
#    client too, because `install` depends on `submodule` (gremlin is a `link:` dep — see
#    mise.toml). Slower on a cold session, and deliberately so: the previous npm-dep arrangement
#    meant this very step reinstalled 4.0.0-beta.2 over the client symlink at every session start.
mise run install

# 5. Persist env for the session: mise on PATH + quiet version checks.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export MISE_VERSION_CHECK=0"
    echo "export PATH=\"$MISE_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi
