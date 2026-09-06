---
paths:
  - "src/router.ts"
  - "src/manager.ts"
  - "src/http.ts"
  - "src/wire.ts"
  - "src/docs.ts"
  - "src/bun/**"
  - "src/cloudflare/**"
---

# Management API + runtime parity

Whole-graph lifecycle is a thin REST layer on `/gremlin/{g}`, **identical on Bun and Cloudflare** —
no separate control plane. The shared `makeRouter` dispatches by verb onto an injected
`GraphManager`; the store tier (`execute.ts`) compiles+runs+frames and returns GraphBinary buffers.
**No HTTP in the store tier / DO.**

- Verbs: `POST` = query (body), `GET` = query via `?gremlin=` (400 if absent — the cacheable read
  verb), `OPTIONS` = metadata (element counts + version), `PUT` = create-if-absent, `DELETE` = teardown.

## Guardrails

- **Graph selection, and it's a design commitment:** `POST /gremlin/{g}` routes with **no body
  parse** (id from path); the body `g` field is peeked only on the bare `/gremlin` endpoint. The
  `GET` data plane holds the same line from the OTHER side — it reads the QUERY STRING (`?gremlin=`),
  never the body — and reuses the JSON-request seam (`parseJsonQuery`, `wire.ts`) so POST and GET
  share one parse. **TinkerPop has no create/drop-DB API — DO-on-first-access IS provisioning.** Don't
  add a control plane; don't parse the body on the path route.
- **`GET` runs a READ; `OPTIONS` is metadata.** `GET` is cacheable (a POST is not), so it carries the
  read data plane; a bare `GET` with no `gremlin` param 400s rather than silently serving metadata
  (that would mask a caller who meant to send a traversal). Element counts moved to `OPTIONS`, which
  create-on-demands via `mgr.info` exactly as the old GET did. No content negotiation, no
  `Cache-Control`, no read-only-write rejection on GET yet — all deferred.
- **Everything is idempotent + create-on-demand on both runtimes** — CF's DO namespace can't answer
  "does this exist?" (`getByName` always returns a stub), so no verb 404s on a valid id.
- **Teardown = `ctx.storage.deleteAll()`, not dropping tables** (only route to zero storage/billing).
  CF gotcha: a warm DO keeps serving after `deleteAll()` but its tables are gone — `ensureLive()`
  lazily re-runs `initSchema()` on reuse. Lazy, not eager (an abandoned graph stays GC-eligible).
