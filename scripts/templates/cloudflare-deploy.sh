#!/usr/bin/env bash
# mogwai-db — deploy the prebuilt Cloudflare Worker to your OWN account. No build required.
#
#   export CLOUDFLARE_API_TOKEN=<token>        # required — Workers Scripts + Durable Objects + R2 edit
#   export CLOUDFLARE_ACCOUNT_ID=<account id>  # only if the token can see more than one account
#   ./deploy.sh
#
# Deploys worker.js as-is per wrangler.jsonc (no re-bundle), creating the R2 store if it is missing.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN is not set." >&2
  echo "  Create a token with Workers Scripts + Durable Objects + R2 edit permissions, then:" >&2
  echo "    export CLOUDFLARE_API_TOKEN=<token>" >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "note: CLOUDFLARE_ACCOUNT_ID is not set — wrangler will infer it from the token" >&2
  echo "      (set it if the token can see more than one account)." >&2
fi

# Use a locally-installed wrangler if present, otherwise fetch it with npx.
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
else
  WRANGLER=(npx --yes wrangler)
fi

# The io() whole-graph import/export store. Idempotent — a create over an existing bucket is fine.
BUCKET="__MOGWAI_BUCKET__"
echo "ensuring R2 bucket ${BUCKET} exists…"
if ! out=$("${WRANGLER[@]}" r2 bucket create "${BUCKET}" 2>&1); then
  if echo "${out}" | grep -qiE 'already (exists|own)'; then
    echo "  ${BUCKET} already exists — continuing."
  else
    echo "${out}" >&2
    exit 1
  fi
fi

echo "deploying mogwai-db…"
"${WRANGLER[@]}" deploy
echo
echo "deployed. Query a graph:  POST https://<your-worker-url>/gremlin/{id}   body {\"gremlin\":\"g.V().count()\"}"
