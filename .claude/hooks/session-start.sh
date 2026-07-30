#!/bin/bash
# Claude Code on the web (remote) session bootstrap for mogwai-db.
#
# This bootstrap needs OUTBOUND egress to two hosts beyond the image: mise.run (the
# installer) and npm.jsr.io (the three `@bodar/*` deps are JSR packages). A web session
# gets whichever egress policy its ENVIRONMENT was created with, and the restrictive one
# blocks both — so step 0 checks before anything expensive runs. We still link the image's
# pre-installed bun under the version mise.toml pins, so the [tools] requirement is
# satisfied without a redundant download.
set -euo pipefail

# Web sessions only — local machines have their own toolchain setup.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# Keep the bootstrap fast and deterministic — skip mise's self-update version pings.
export MISE_VERSION_CHECK=0

# 0. Preflight the egress policy, and do it by REACHABILITY rather than by environment
#    identity. There is no environment name or id in the session env at all;
#    `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` is the closest thing and it reports the
#    environment KIND — it reads `cloud_default` for every `anthropic_cloud` environment,
#    so it cannot tell a permissive one from a restrictive one. What differs between them
#    is what egress the gateway allows, so probe exactly that.
#
#    Why fail rather than degrade: `bun install` cannot resolve `@bodar/*`, so the `q`
#    kernel and the executor do not import, and L2-L5 plus the census cannot run at all.
#    Only L1 does. That is a tree that looks buildable and silently is not — and the
#    submodule clone that precedes the discovery is several hundred MB.
blocked() {
  local code
  # 403/407 = the egress gateway denied the host by policy; 000 = it refused CONNECT.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$1/" 2>/dev/null || true)"
  case "$code" in 000 | 403 | 407) return 0 ;; *) return 1 ;; esac
}

BLOCKED=""
blocked npm.jsr.io && BLOCKED="$BLOCKED
  - npm.jsr.io      the three @bodar/* runtime deps are JSR packages; bun install fails without it"
if ! command -v mise >/dev/null 2>&1 && blocked mise.run; then
  BLOCKED="$BLOCKED
  - mise.run        mise is absent from the image and installs from there"
fi

if [ -n "$BLOCKED" ]; then
  cat >&2 <<EOF
mogwai-db cannot be built in this environment — its egress policy blocks:
$BLOCKED

Stopping here instead of cloning the submodule into a tree that cannot install.
Recreate the session in the environment named "unrestricted" — it is the ONLY one that
builds this project. Both "Default" and "Default Cloud Environment" restrict egress and
will land here again. Environments are listed at
https://claude.ai/settings/code-environments and the policy model is documented at
https://code.claude.com/docs/en/claude-code-on-the-web

If you continue in this session anyway, only L1 will run — treat every other level as
unverified rather than passing.
EOF
  exit 2
fi

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
