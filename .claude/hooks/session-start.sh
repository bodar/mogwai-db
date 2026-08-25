#!/bin/bash
# Claude Code on the web (remote) session bootstrap for mogwai-db.
#
# This bootstrap needs OUTBOUND egress to two hosts beyond the image: mise.run (the
# installer) and npm.jsr.io (the three `@bodar/*` deps are JSR packages). A web session
# gets whichever egress policy its ENVIRONMENT was created with, and the restrictive one
# blocks both — so step 1 checks before anything expensive runs. We still link the image's
# pre-installed bun under the version mise.toml pins, so the [tools] requirement is
# satisfied without a redundant download.
#
# Step 0 is unrelated to any of that: it repairs git refs the clone gets wrong.
set -euo pipefail

# Web sessions only — local machines have their own toolchain setup.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

# Keep the bootstrap fast and deterministic — skip mise's self-update version pings.
export MISE_VERSION_CHECK=0

# Inject the web-session notes. For SessionStart (unlike most hook events) STDOUT is added to
# Claude's context, so this `cat` is the entire delivery mechanism — which is why the notes
# live in a file no `CLAUDE.md` references: a local session never loads facts that only hold
# in a web session. Runs first so it does not depend on any step below succeeding.
#
# Guarded on existence because the notes are context, never a prerequisite: a missing file
# must not cost the session its toolchain. (`if`, not `[ -f … ] && cat …` — the && form is
# exempt from `set -e`, but it would leave a non-zero status for anything reading it.)
WEB_SESSION_NOTES="$CLAUDE_PROJECT_DIR/.claude/hooks/web-session-notes.md"
if [ -f "$WEB_SESSION_NOTES" ]; then
  cat "$WEB_SESSION_NOTES"
fi

# 0. Repair the local view of the default branch. Runs BEFORE the egress preflight because
#    it needs no network and is still worth having in a session that cannot build.
#
#    Two recurring artifacts of a web-session clone, both of which have already cost real
#    time in a session:
#      - `trunk` (the LOCAL branch) can be left at a SUPERSEDED tip while `origin/trunk`
#        is correct. `git checkout trunk` then silently swaps the working tree for a stale
#        copy of the repo — the failure looks like your edits vanished — and
#        `git merge --ff-only` refuses with "unrelated histories".
#        The clone being SHALLOW is the whole mechanism, and the "unrelated" part is a
#        MISREADING worth not repeating: the harness fetches the default branch more than
#        once at `--depth 50`, and each fetch cuts its own 50-commit window with its own
#        graft in `.git/shallow`. `origin/trunk` advances to the later window's tip — git
#        logs that fetch as a plain `fast-forward`, so upstream it is one ordinary branch —
#        while local `trunk` stays at the earlier one. The two windows do not overlap, so
#        there is no merge base IN THIS CLONE: not two lineages, two truncated views of one.
#        Measured 2026-07-31: local trunk 50 commits back, no merge base, two grafts in
#        `.git/shallow`, and `origin/trunk`'s own reflog recording the fast-forward.
#      - `refs/remotes/origin/HEAD` is unset, so every "what is the default branch" probe
#        (`git symbolic-ref refs/remotes/origin/HEAD`, `git rev-parse --abbrev-ref
#        origin/HEAD`) fails and tooling falls back to guessing.
#
#    Resetting is safe HERE SPECIFICALLY because of the remote-session guard above: the
#    container is ephemeral and the repo was cloned fresh at start, so a divergent local
#    `trunk` is provisioning residue, never work someone authored. It is also recoverable —
#    `git branch -f` writes the previous tip to the branch reflog (`git reflog show trunk`).
#    Do NOT lift this into a non-remote path, where a divergent `trunk` may be real work.
if git -C "$CLAUDE_PROJECT_DIR" rev-parse --verify -q origin/trunk >/dev/null 2>&1; then
  git -C "$CLAUDE_PROJECT_DIR" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/trunk 2>/dev/null || true

  LOCAL_TRUNK="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse -q --verify --short trunk 2>/dev/null || true)"
  ORIGIN_TRUNK="$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --short origin/trunk)"
  CHECKED_OUT="$(git -C "$CLAUDE_PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

  if [ -n "$LOCAL_TRUNK" ] && [ "$LOCAL_TRUNK" != "$ORIGIN_TRUNK" ]; then
    if [ "$CHECKED_OUT" = "trunk" ]; then
      # `git branch -f` refuses to move the checked-out branch, and `reset --hard` here
      # would discard a working tree this hook did not create. Say it and move on.
      echo "[git] local trunk ($LOCAL_TRUNK) differs from origin/trunk ($ORIGIN_TRUNK) and IS CHECKED OUT." >&2
      echo "[git] not touching it — if the tree looks wrong, run: git reset --hard origin/trunk" >&2
    else
      # `>/dev/null`, not cosmetic: `branch -f` prints "set up to track 'origin/trunk'" on
      # STDOUT, and for SessionStart stdout IS Claude's context — a channel this hook reserves
      # for the notes and the cannot-build report. Every diagnostic here goes to stderr.
      git -C "$CLAUDE_PROJECT_DIR" branch -f trunk origin/trunk >/dev/null
      echo "[git] local trunk was $LOCAL_TRUNK, reset to origin/trunk ($ORIGIN_TRUNK); previous tip in \`git reflog show trunk\`" >&2
    fi
  fi

  # 0b. Remove the session branch outright, rather than teach the session to work around it.
  #
  #     The harness checks the session out on `claude/<slug>` and instructs Claude to develop
  #     there, but a repository ruleset rejects `refs/heads/claude/**` outright (creation +
  #     update + non_fast_forward, no bypass actors), so that branch has NO reachable remote.
  #     The failure mode is not the rejected push — it is the work that never gets re-aimed at
  #     trunk afterwards and dies with the container. 29 such branches, pushed before the rule
  #     existed, were swept on 2026-08-03.
  #
  #     Deleting beats redirecting. The rejected alternative was to leave the branch in place
  #     with `branch --set-upstream-to=origin/trunk`: it reads plausibly, but a successful
  #     `HEAD:refs/heads/trunk` push advances `origin/trunk` and leaves LOCAL `trunk` where it
  #     was — so `git checkout trunk` then hands back a tree without the work, which is exactly
  #     the "my edits vanished" trap step 0 above exists to prevent. One less ref is one less
  #     thing that can be wrong; a branch that cannot be pushed has no reason to exist here.
  #
  #     Order is forced: git refuses to delete the branch a worktree has checked out, so the
  #     checkout must land on trunk first. Deleting is safe HERE for the same reason step 0's
  #     reset is — the remote-session guard at the top means the container is ephemeral and the
  #     clone is fresh, so a `claude/…` tip is provisioning residue and not authored work. `-D`
  #     rather than `-d` because the shallow window can leave ancestry unprovable (see above),
  #     and the previous tip stays in the branch reflog for the life of the container either way.
  if [ -n "$CHECKED_OUT" ] && [ "$CHECKED_OUT" != "trunk" ]; then
    if git -C "$CLAUDE_PROJECT_DIR" checkout -q trunk 2>/dev/null; then
      echo "[git] harness checked this session out on '$CHECKED_OUT'; switched to trunk" >&2
    else
      echo "[git] could NOT switch off '$CHECKED_OUT' onto trunk — leaving it alone." >&2
      echo "[git] '$CHECKED_OUT' cannot be pushed (ruleset); commit to trunk or the work is lost." >&2
    fi
  fi
  if [ "$(git -C "$CLAUDE_PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "trunk" ]; then
    # Prefix pattern: `refs/heads/claude/` matches everything beneath it, nested names included.
    # Both loops delete the REF DIRECTLY rather than via `branch -d/-D`: `branch -rd` exists but
    # takes the short name and reports a stale-ref hint on stdout, and stdout IS Claude's context
    # here. `update-ref -d` is silent, takes the full refname the same way in both loops, and
    # `branch -D`'s side effect we DO want (dropping `branch.<name>.*` config) is a no-op for a
    # remote-tracking ref anyway — so config cleanup rides along with the local loop only.
    for STALE in $(git -C "$CLAUDE_PROJECT_DIR" for-each-ref --format='%(refname:short)' 'refs/heads/claude/'); do
      git -C "$CLAUDE_PROJECT_DIR" branch -D "$STALE" >/dev/null 2>&1 &&
        echo "[git] deleted unpushable local branch '$STALE'" >&2
    done
  fi

  #     Leave no remote-tracking stub either. The local branch is gone but `origin/claude/<slug>`
  #     survives it, and a leftover `origin/…` ref reads as "this branch exists upstream" to
  #     anything that lists refs — which is false twice over: the ruleset means it cannot exist
  #     upstream, and this is what made a session reason about the branch after it was deleted.
  #     Done offline with `update-ref -d` rather than `git remote prune origin`, which needs the
  #     network and prunes on the remote's answer; here the ref is known-bogus without asking.
  for STALE in $(git -C "$CLAUDE_PROJECT_DIR" for-each-ref --format='%(refname)' 'refs/remotes/origin/claude/'); do
    git -C "$CLAUDE_PROJECT_DIR" update-ref -d "$STALE" 2>/dev/null &&
      echo "[git] deleted stale remote-tracking ref '${STALE#refs/remotes/}'" >&2
  done

  #     A single-branch clone can pin the session branch in a FETCH refspec, which would refetch
  #     the ref just deleted. Strip only claude-specific refspecs, and only while another remains
  #     — a remote with no fetch refspec at all cannot see origin/trunk, which is a worse break
  #     than the stub. If it is the only one, say so instead of creating that state silently.
  CLAUDE_FETCH="$(git -C "$CLAUDE_PROJECT_DIR" config --get-all remote.origin.fetch 2>/dev/null | grep -c 'claude/' || true)"
  FETCH_TOTAL="$(git -C "$CLAUDE_PROJECT_DIR" config --get-all remote.origin.fetch 2>/dev/null | grep -c . || true)"
  if [ "$CLAUDE_FETCH" -gt 0 ]; then
    if [ "$FETCH_TOTAL" -gt "$CLAUDE_FETCH" ]; then
      git -C "$CLAUDE_PROJECT_DIR" config --unset-all remote.origin.fetch '.*claude/.*' 2>/dev/null || true
      echo "[git] dropped $CLAUDE_FETCH claude/* fetch refspec(s) that would refetch the deleted ref" >&2
    else
      echo "[git] NB remote.origin.fetch only matches claude/* — left in place (removing it would" >&2
      echo "[git]    hide origin/trunk); \`git fetch\` may recreate origin/claude/*." >&2
    fi
  fi
fi

# 1. Preflight the egress policy, and do it by REACHABILITY rather than by environment
#    identity. There is no environment name or id in the session env at all;
#    `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` is the closest thing and it reports the
#    environment KIND — it reads `cloud_default` for every `anthropic_cloud` environment,
#    so it cannot tell a permissive one from a restrictive one. What differs between them
#    is what egress the gateway allows, so probe exactly that.
#
#    Why stop rather than degrade: `bun install` cannot resolve `@bodar/*`, so the `q`
#    kernel and the executor do not import, and L2-L5 plus the census cannot run at all.
#    Only L1 does. That is a tree that looks buildable and silently is not — and the
#    submodule clone that precedes the discovery is several hundred MB.
#
#    Report on STDOUT and exit 0, deliberately, even though this is a failure. Exit 2 is the
#    natural code and it sends this to the WRONG AUDIENCE: for SessionStart, exit-2 stderr
#    renders in the user's transcript as a hook-error notice that CLAUDE NEVER SEES, so the
#    one actor that will otherwise keep running tests and reporting green is the one left
#    uninformed. Exit 0 + stdout is the only channel into the session's context, so the
#    message is addressed to Claude and asks it to relay — a human who sees only "hook
#    success" still learns, via the first reply, that this session cannot build.
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
  cat <<EOF

THIS SESSION CANNOT BUILD mogwai-db. Its environment's egress policy blocks:
$BLOCKED

The bootstrap stopped here rather than cloning the submodule into a tree that cannot install.
Only L1 can run: treat every conformance level above it as UNVERIFIED, never as passing.

Claude: say this in your first reply, before anything else — the session has to be recreated
in the environment named "unrestricted", the only one that builds this project. "Default" and
"Default Cloud Environment" both land here again. The list is at
https://claude.ai/settings/code-environments
EOF
  exit 0
fi

# 2. Install mise via the official installer unless it's already present. The
#    installer drops the binary in ~/.local/bin.
MISE_BIN="$HOME/.local/bin"
command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh
export PATH="$MISE_BIN:$PATH"

# 3. Trust the repo config so every mise command below reads it non-interactively.
mise trust "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true

# 4. Point mise at the pre-installed bun instead of downloading it. Link it under the
#    version mise.toml pins so the [tools] requirement is satisfied.
BUN_BIN="$(command -v bun || true)"
if [ -n "$BUN_BIN" ]; then
  BUN_PREFIX="$(cd "$(dirname "$BUN_BIN")/.." && pwd)"
  BUN_PIN="$(sed -n 's/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$CLAUDE_PROJECT_DIR/mise.toml" | head -1)"
  [ -n "$BUN_PIN" ] && mise link --force "bun@$BUN_PIN" "$BUN_PREFIX" >/dev/null
fi

# 4b. Same move for node: mise.toml pins node to the image's pre-installed version, so link that
#     binary instead of downloading a build of the same version from mise's registry. Only link when
#     the two agree — if the pin ever drifts from what the image ships, let mise fetch the pinned
#     version rather than silently linking a mismatched node under the pinned name.
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  NODE_PREFIX="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"
  NODE_PIN="$(sed -n 's/^[[:space:]]*node[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$CLAUDE_PROJECT_DIR/mise.toml" | head -1)"
  NODE_HAVE="$("$NODE_BIN" --version 2>/dev/null | sed 's/^v//')"
  [ -n "$NODE_PIN" ] && [ "$NODE_PIN" = "$NODE_HAVE" ] && mise link --force "node@$NODE_PIN" "$NODE_PREFIX" >/dev/null
fi

# 5. Install project dependencies. NB this now provisions the submodule and builds the gremlin
#    client too, because `install` depends on `submodule` (gremlin is a `link:` dep — see
#    mise.toml). Slower on a cold session, and deliberately so: the previous npm-dep arrangement
#    meant this very step reinstalled 4.0.0-beta.2 over the client symlink at every session start.
mise run install

# 6. Persist env for the session: mise on PATH + quiet version checks.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export MISE_VERSION_CHECK=0"
    echo "export PATH=\"$MISE_BIN:\$PATH\""
  } >> "$CLAUDE_ENV_FILE"
fi

# 7. One line of confirmation, last. Everything above speaks up only when something is wrong,
#    so a healthy bootstrap was indistinguishable from a hook that never fired. `$SECONDS` is
#    the whole hook, cold submodule provisioning included, which is the number worth seeing.
echo "[bootstrap] mogwai-db ready in ${SECONDS}s — bun ${BUN_PIN:-unpinned} + node ${NODE_PIN:-unpinned} linked, submodule + deps provisioned, 'mise run test' will run."
