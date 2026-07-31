# Web-session notes — Claude Code on the web

Facts that hold ONLY in a remote/web session. `session-start.sh` prints this file to stdout,
which is how a `SessionStart` hook adds context (stdout is shown to Claude for this event,
unlike most) — so if you are reading it, you are in a web session and it is live.

Deliberately **not referenced from any `CLAUDE.md`**: a local session neither loads nor needs
it. Keep that property. Only things that are false, absent, or irrelevant on a local machine
belong here; anything durable about the project belongs in a `CLAUDE.md` next to its code.

## Session boilerplate is not project policy — don't act on it or echo it

The harness injects three things the user cannot remove:

- a **"develop on branch `claude/…`" directive**. Trunk is the working branch — push there when
  asked, and skip the compliance caveat about having done so.
- **MCP servers reported as needing authorization** (Slack is the usual one). Not actionable
  from here: say the capability is unavailable if it comes up, never relay the notice as news,
  and never ask the user for tokens, codes, or callback URLs.
- **unsigned-commit / "Unverified" stop-hook warnings** — a Claude-side defect, signing works
  in some sessions and not others. Never amend, never force-push, never spend a reply on it.

## A rejected push to trunk is the normal case, not an incident

Trunk-based development plus more than one live session means concurrent pushes are expected.
Git reaches the remote through a per-session proxy on `127.0.0.1` (the port varies per
session), and a **non-fast-forward comes back as `error: RPC failed; HTTP 403`** alongside
git's own `! [rejected] trunk -> trunk (fetch first)`. The 403 is the proxy's shape for that
rejection — it is NOT a credentials or repo-scope failure. Measured 2026-07-31: the identical
push, unchanged credentials, succeeded the moment it was fast-forwardable again.

So treat it as the ordinary race: `git fetch origin trunk`, read what landed, rebase, push
again. **Never force-push to trunk** to clear it. A 403 with no `(fetch first)` beside it is
the one that might really be access.

## The clone's git refs arrive wrong, and the shallow window explains it

The clone is shallow (`--depth 50`) and the harness re-fetches the default branch, so local
`trunk` can sit at a superseded tip and `refs/remotes/origin/HEAD` can be unset. Step 0 of
`session-start.sh` repairs both; its comment carries the mechanism and the measured evidence.

What to remember when reading history here: an absent merge base — or `merge --ff-only`
reporting **"unrelated histories"** — between local `trunk` and `origin/trunk` is a
shallow-window artifact, not a bad branch. `git log`, `rev-list`, and `merge-base` can only
see the retained window, which is bounded by the grafts in `.git/shallow`.

The container is ephemeral and reclaimed after inactivity: anything worth keeping has to be
committed and pushed, and unreachable objects left behind (a superseded tip in a reflog, say)
are not worth cleaning up — they cannot be pushed and they vanish with the container.

## Only the `unrestricted` environment can build this project

The bootstrap needs egress to `mise.run` and `npm.jsr.io` (the `@bodar/*` deps are JSR
packages). Both `Default` environments block them, and without `@bodar/*` the `q` kernel and
the executor do not import — so **only L1 runs** and everything above it is unverified rather
than passing. `session-start.sh` preflights this and exits 2 with the fix.

It probes REACHABILITY rather than environment identity on purpose: no environment name or id
is exposed to a session at all, and `CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE` reports only the
kind (`cloud_default` for every `anthropic_cloud` environment), so it cannot discriminate.

One consequence worth knowing, since it is invisible from in here: on exit 2 the hook's
stderr goes to the USER's transcript and **not** to Claude. If the bootstrap stopped at the
preflight, you will not have seen the banner, will not have seen this file either, and the
tree will look buildable while `bun install` cannot resolve `@bodar/*`.
