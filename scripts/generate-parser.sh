#!/usr/bin/env bash
# Regenerate the tracked parsers from the tinkerpop submodule's grammars via antlr-ng
# (the same generator upstream gremlin-js uses). See docs and regen-corpus.ts for
# why the source is the submodule's `origin/master` ref rather than the pinned gitlink:
# mogwai's parser deliberately tracks tinkerpop master (a forward-compatible superset),
# so it can accept not-yet-released grammar.
#
# TWO grammars, because Gremlin embeds a second LANGUAGE in a string argument:
#
#   Gremlin.g4  (gremlin-language/) -> parser/      the Gremlin surface itself
#   GQL.g4      (gql-gremlin/)      -> parser/gql/  the MATCH pattern sub-language, i.e. the
#                                                   argument of g.match("MATCH (a)-[:knows]->(b)")
#
# The second is why locked decision #2 ("the parser is generated, never edited") survives the
# MATCH-string form at all: `Gremlin.g4` types that argument as an opaque `stringLiteral`, so
# without an upstream grammar for the pattern language the only route would be a hand-written
# parser. Upstream ships one. Do not hand-edit either output — see
# docs/2026-07-28-match-string-frontend-design.md.
#
# antlr-ng requires the grammar file to be named after the grammar, and neither grammar is
# necessarily in the pinned sparse checkout (gql-gremlin is NOT in init-submodule.sh's SPARSE
# set), so each is exported from the ref to a temp file first — `git show` fetches the blob on
# demand in a blobless clone, which is why no sparse change is needed.
#
# Run `mise run generate`; review + commit the regenerated output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SM=vendor/tinkerpop
REF=origin/master

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# The submodule's origin/master ref is only fetched at clone time and never
# refreshed by `git submodule update` (which fetches the pinned SHA), so refresh
# it here or we'd regenerate against a stale clone-time snapshot of master.
git -C "$SM" fetch --filter=blob:none --quiet origin master

# generate <grammar-name> <path-in-submodule> <output-dir>
generate() {
  local name="$1" path="$2" out="$3"
  git -C "$SM" show "$REF:$path" > "$TMP/$name.g4"
  if [[ "$name" == Gremlin ]]; then
    git -C "$TMP" apply "$ROOT/patches/upstream/tinkerpop-06-inject-generic-argument-varargs.patch"
  fi
  bunx antlr-ng -Dlanguage=TypeScript --generate-visitor --generate-listener \
    --exact-output-dir -o "$out" "$TMP/$name.g4"
  echo "$out/ regenerated from tinkerpop $REF ($name.g4)"
}

generate Gremlin gremlin-language/src/main/antlr4/Gremlin.g4     parser
generate GQL     gql-gremlin/src/main/antlr4/GQL.g4              parser/gql
