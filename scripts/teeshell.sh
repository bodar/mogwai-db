#!/usr/bin/env bash
# The task shell mise runs EVERY task through (wired in mise.toml's [task_config]).
# It tees each task's combined stdout+stderr to `$MISE_PROJECT_ROOT/.logs/<task>.log`
# (the last run of that task; overwritten each time), then announces the path — so a
# run's full output is always sitting in a file to `grep`/`Read` and never has to be
# re-run just to see output that scrolled past or got swallowed by a `tail`/`grep`.
#
# WHY the task SHELL and not a `tee` in each task's `run =`: a task's dependencies run
# as SEPARATE sibling tasks whose output streams to mise's stdout, OUTSIDE the parent
# task's `run` subprocess — so a `tee` inside `run =` would capture that one task and
# miss every dependency (measured). The shell, by contrast, wraps EVERY task mise
# executes, dependencies included, each into its own file. `mise run ci` therefore
# leaves one clean log per sub-task (check.log, lint.log, test.log, …), which is what
# you want when one member of a fan-out is the one that failed.
#
# mise invokes this as:  teeshell.sh -c "<the run script>"   (so "$2" is the script).
# Escape hatch: a task that needs a real tty (interactive prompt) sets `raw = true`,
# which bypasses this shell entirely.
set -o pipefail

logdir="${MISE_PROJECT_ROOT:-.}/.logs"
mkdir -p "$logdir"
# Task names here are flat, but a file-task name can carry a '/'; keep it a filename.
log="$logdir/${MISE_TASK_NAME//\//_}.log"
log="${log:-$logdir/task.log}"

bash -c "$2" 2>&1 | tee "$log"
ec="${PIPESTATUS[0]}"
# Announce on stderr only — mise shows it (prefixed with the task label) but it stays OUT of the log
# file, keeping the file pure task output. On FAILURE the announcement is a loud, unmissable verdict
# naming the task, its exit code, and its log — so a piped `mise run <task> | tail` shows the truth in
# the TEXT (the piped exit code is always the pager's, never the task's; read the output, or run
# unpiped where mise's own exit is truthful). This is why there is no separate ci-verdict wrapper: the
# per-task FAIL line here + mise's own terminal `ERROR task failed` + the `ci` task's `CI passed` echo
# already put an accurate verdict in the output.
if [ "$ec" -eq 0 ]; then
  echo "── log: $log" >&2
else
  echo "── ✗ FAILED (exit $ec): ${MISE_TASK_NAME:-task} — log: $log" >&2
fi
exit "$ec"
