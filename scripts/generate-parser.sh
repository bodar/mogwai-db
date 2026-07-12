#!/usr/bin/env bash
# Regenerate parser/ from the tinkerpop submodule's Gremlin grammar via antlr-ng
# (the same generator upstream gremlin-js uses). See docs and regen-corpus.ts for
# why the source is the submodule's `origin/master` ref, not the pinned beta.2
# checkout: mogwai's parser deliberately tracks tinkerpop master (a forward-compatible
# superset — beta.2 clients unaffected, proven by L3=204), so it can accept
# not-yet-released grammar. L3 conformance separately tracks the pinned beta.2 pin.
#
# antlr-ng requires the grammar file to be named after the grammar (Gremlin.g4);
# master's copy is not in the pinned checkout, so export it to a temp file first.
# Run `mise run generate`; review + commit the regenerated parser/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SM=vendor/tinkerpop
REF=origin/master
GRAMMAR="gremlin-language/src/main/antlr4/Gremlin.g4"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# The submodule's origin/master ref is only fetched at clone time and never
# refreshed by `git submodule update` (which fetches the pinned SHA), so refresh
# it here or we'd regenerate against a stale clone-time snapshot of master.
git -C "$SM" fetch --filter=blob:none --quiet origin master
git -C "$SM" show "$REF:$GRAMMAR" > "$TMP/Gremlin.g4"

bunx antlr-ng -Dlanguage=TypeScript --generate-visitor --generate-listener \
  --exact-output-dir -o parser "$TMP/Gremlin.g4"
echo "parser/ regenerated from tinkerpop $REF"
