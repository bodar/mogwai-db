#!/usr/bin/env bash
# Run the full CI gate and end with an UNMISSABLE, pipe-safe verdict.
#
# `mise run ci` already exits non-zero on any failed task — a failed dependency
# propagates its exit code and mise skips the parent's `run` (verified on mise
# 2026.8.x: a task whose dep exits 3 makes `mise run <parent>` exit 3). So the
# exit code was never the bug.
#
# The trap this guards is the INVOCATION. `mise run ci 2>&1 | tail`/`| grep`
# makes the PIPELINE return tail's/grep's exit 0 — bash reports the last stage's
# status and the tool shell has no `pipefail` — so a RED run reads green and a
# red commit ships. No exit code can survive a pipe; that is shell semantics,
# not something mise can fix. The only signal that survives `| tail` is a
# terminal LINE, so this wrapper prints one:
#
#   CI: PASS            (last line, exit 0)
#   CI: FAIL (exit N)   (last line, exit N)
#
# Run it as `bash scripts/ci.sh`; when you pipe it, read the LAST LINE (grep
# `CI: FAIL`) rather than trusting the pipeline's exit code. `set -o pipefail`
# here keeps the code truthful for the un-piped case.
set -o pipefail

mise run ci
ec=$?

if [ "$ec" -eq 0 ]; then
  echo "CI: PASS"
else
  echo "CI: FAIL (exit $ec)"
fi
exit "$ec"
