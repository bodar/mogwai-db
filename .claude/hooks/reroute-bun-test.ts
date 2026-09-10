#!/usr/bin/env bun
/**
 * PreToolUse (Bash) hook: reroute a stray bare `bun test` to `mise run test`.
 *
 * Bare `bun test` is NEVER what we want in this repo — it skips `tsc --noEmit` and the submodule
 * provisioning that the `test` mise task depends on (so a type error or a missing client ships green),
 * and it runs the suite as ONE serial process instead of the cored fan-out. CLAUDE.md says as much, but
 * saying it does not stop it happening, so this hook makes it structural.
 *
 * It mirrors the global RTK rewrite hook's mechanism: a PreToolUse Bash hook that returns
 * `hookSpecificOutput.updatedInput.command` to transparently rewrite the command. RTK passes `bun test`
 * through untouched, so the two never collide.
 *
 * Behaviour:
 *   - `bun test [args…]` (optionally nothing after)      → rewrite to `mise run test [-- args…]`.
 *     The args ride through mise's `-- ` passthrough into scripts/test-all.ts, which runs them as a
 *     targeted single `bun test` (the fast path). No args → the full cored fan-out.
 *   - a `bun test` buried in a compound/env-prefixed command (`X=1 bun test …`, `cd x && bun test`) is
 *     NOT safe to rewrite wholesale, so DENY with guidance instead of mis-rewriting. Denying is correct
 *     here: running bare `bun test` was the wrong move regardless.
 *   - anything that is not a `bun test` invocation → pass through silently (no output, exit 0).
 *
 * Only the Bash tool reaches here (the settings.json matcher), and the command the mise task runs
 * executes inside mise's task shell, not through the Bash tool — so this never rewrites its own output.
 *
 * RUNTIME IS BUN, deliberately: this was Python until 2026-09-10, and on a machine with no `python3`
 * it failed with exit 127 on EVERY Bash call — noisy, and the guard silently never ran. Bun is the
 * project's own pinned runtime (mise.toml), so the interpreter is guaranteed present wherever the
 * repo builds at all. Do not reintroduce an interpreter this project does not already require.
 */

// A SIMPLE `bun test` invocation: only leading/trailing whitespace around `bun test`, optionally
// followed by args. Anchored, so `echo "bun test"`, `bun run test`, `bun testfoo` and `mise run test`
// do not match. A NEWLINE means a multi-line script → treated as compound below.
const SIMPLE = /^\s*bun\s+test(?:\s+(.*))?\s*$/;
// Does the command reference a `bun test` at all (for the compound/deny case)?
const MENTIONS = /(?:^|[\s;&|(])bun\s+test(?:\s|$)/;
// Shell control operators / newlines that make wholesale rewrite unsafe.
const COMPOUND = /[;&|\n]|\bcd\b|=\S/;

const REASON =
  'Rerouted to `mise run test`: bare `bun test` skips tsc --noEmit + submodule provisioning ' +
  "(the test task's deps) and runs one serial process instead of the cored fan-out. " +
  'Pass a filter with `mise run test -- <args>`.';
const DENY_REASON =
  "Don't run bare `bun test` — it skips tsc --noEmit + the submodule (test's mise deps) and is " +
  'serial. Use `mise run test` (full suite, fanned across cores) or `mise run test -- <args>` for a ' +
  'filter/path. (This command was too complex to rewrite automatically.)';

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

let data: { tool_name?: unknown; tool_input?: { command?: unknown } };
try {
  data = JSON.parse(await Bun.stdin.text());
} catch {
  process.exit(0); // not JSON we understand — pass through
}

if (data?.tool_name === 'Bash') {
  const cmd = data.tool_input?.command;
  if (typeof cmd === 'string') {
    const m = cmd.includes('\n') ? null : SIMPLE.exec(cmd);
    if (m) {
      const args = (m[1] ?? '').trim();
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecisionReason: REASON,
          updatedInput: { command: `mise run test${args ? ` -- ${args}` : ''}` },
        },
      });
    } else if (MENTIONS.test(cmd) && COMPOUND.test(cmd)) {
      // A `bun test` embedded in something more complex — deny rather than mis-rewrite.
      emit({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: DENY_REASON,
        },
      });
    }
    // Not a bun test invocation — silent pass-through.
  }
}
