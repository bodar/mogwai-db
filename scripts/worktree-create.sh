#!/usr/bin/env bash
set -euo pipefail

# Claude Code WorktreeCreate hook. Input: JSON on stdin with .name and .cwd.
#
# The hook OWNS worktree creation: when it exists, Claude Code delegates the
# `git worktree add` to us and reads the worktree's absolute path from STDOUT —
# that path is the only thing it consumes, so every other line goes to stderr or
# it corrupts the value.
#
# Why it exists: without it a fresh worktree carries the submodule GITLINKS but no
# checkouts — `vendor/tinkerpop`, `vendor/calcite`, … are empty until the first
# `mise run <task>` that depends on `submodule` provisions them. So the reference
# implementations this repo cites constantly come up empty exactly when you start
# reading them. This provisions at creation, and does it by SHARING the main
# checkout's already-provisioned copies (init-submodule.sh's share_from_main:
# symlink when the pins agree, instant, no second clone; local provision only on a
# divergent pin). `--submodules-only` stops at the checkouts — the gremlin client
# build + link registration stay with the worktree's first `mise run`, which the
# build graph already sequences, so creation stays fast.

INPUT=$(cat)
NAME=$(echo "$INPUT" | jq -r '.name')
CWD=$(echo "$INPUT" | jq -r '.cwd')

WORKTREE_DIR="$CWD/.claude/worktrees/$NAME"

# New branch off HEAD, `worktree-`-prefixed to match the branch names Claude Code's
# own worktree creation produces (see `git worktree list`).
git -C "$CWD" worktree add -b "worktree-$NAME" "$WORKTREE_DIR" HEAD >&2

# Provision now, sharing main's copies where the pins agree. Runs from INSIDE the new
# worktree so init-submodule.sh's git-dir/git-common-dir check sees a linked worktree
# and takes the share path; it uses the worktree's own committed copy of the script.
(cd "$WORKTREE_DIR" && bash scripts/init-submodule.sh --submodules-only >&2)

# The path — the only thing Claude Code reads from this hook.
echo "$WORKTREE_DIR"
