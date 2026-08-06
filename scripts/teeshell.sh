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
# Announce on stderr only — mise shows it (prefixed with the task label) but it stays
# OUT of the log file, keeping the file pure task output.
echo "── log: $log" >&2
exit "$ec"
