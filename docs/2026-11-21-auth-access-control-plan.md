# Authentication and access control — plan

**Status: PROPOSED (2026-11-21). Not started. The owner decides the open questions in §7 before work
starts.** Evidence and threat list: `docs/reports/2026-11-21-production-readiness/02-authentication-and-access-control.md`
(called "report 02" below). Index entry: `docs/outstanding-work.md` item `operations` (`:1595-1599`).

## 1. Goal

A mogwai server that is safe on a public network with no proxy in front of it:

1. Every request, except the docs surface, proves a principal. A principal is the identity a credential proves.
2. Every action is checked against that principal's rights, per graph: read, write, admin.
3. A query on one graph cannot read or write another graph unless the principal may do so.
4. The control plane (replicator, scheduler) and graph teardown need the admin right.
5. A server with no credential configuration keeps today's open behaviour for development, and says so at
   start-up. (Open decision D1.)

Same code on Bun and Cloudflare. No new dependency: tokens are compared with WebCrypto, which both
runtimes have.

## 2. Current state (with citations)

| Fact | Source |
|---|---|
| The router reads no credential. | `src/router.ts:245-488` |
| The composition root has a named but unused auth extension point. | `src/application.ts:12-13,43-50` |
| Every verb creates the named graph. | `.claude/rules/management-api.md`; `src/cloudflare/cloudflare-graph-manager.ts:109-147`; `src/bun/BunGraphManager.ts:84-92` |
| `federate` reaches any local graph by name; only depth is checked. | `src/services/catalog/federate.ts`; `src/services/params/federation-depth.ts:28` |
| `GET ?gremlin=` runs writes. | `src/router.ts:460-467`; measured in report 02 §1.3 |
| Any body that is not GraphBinary is parsed as JSON, whatever the `Content-Type`. | `src/wire.ts:148-169` |
| The outbound host allowlist exists and is deny-all by default. | `src/http-allowlist.ts:61-86` |
| Outbound peer requests carry no credential. | `src/http-federation.ts:96-101`; `src/http-io.ts` |
| The plan kind tells a write from a read: `kind: 'program'` vs `kind: 'read'`. | `src/sql/kernel/render.ts:346,370` |
| A barrier service has no "mutates" flag. `io()` read writes the graph. | `src/services/spi/types.ts`; `src/services/catalog/io.ts` |
| The DO's raw-SQL RPC `runFramed` trusts the paired Worker. | `src/cloudflare/graph-store-do.ts:110-113` |
| The client can send Basic, SigV4 or any custom header. | `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/auth.ts:23-88`; `connection.ts:79-82,147-161` |

## 3. Design

### 3.1 One decorator at the edge

Add an `Authenticator` and an `Authorizer` as decorators on the router `Http`, set in `application()`
with `.decorate('router', …)`. The router stays unchanged. The decorators run before routing on both
runtimes, at the Worker on Cloudflare. The DO never sees credentials. It receives the already-checked
principal's rights as plain data on each RPC.

### 3.2 Credentials

Phase 1 supports two forms. Both are headers that the stock client can send (report 02 §1.7):

- `Authorization: Bearer <token>`.
- `Authorization: Basic <base64(user:token)>`, so `driver.auth.basic()` works with no client code.

Tokens live in configuration as SHA-256 hashes, never in plain text:

- Bun: a JSON file named by `--auth-file` / `MOGWAI_AUTH_FILE`.
- Worker: a Wrangler secret `AUTH` holding the same JSON.

Each entry: `{ name, tokenSha256, grants: [{ graphs: "<glob>", rights: ["read" | "write" | "admin"] }] }`.
Compare hashes in constant time with `crypto.subtle` (no dependency).

Phase 3 (optional, decision D3) adds verification of the Cloudflare Access JWT `Cf-Access-Jwt-Assertion`
with WebCrypto and the team's JWKS.

### 3.3 Authorization rules

| Request | Right needed |
|---|---|
| Docs surface (`/`, `/docs`, `/openapi.json`, static assets) | none (decision D4) |
| `OPTIONS /{prefix}/{g}` | read on `g` |
| `GET /{prefix}/{g}?gremlin=` | read on `g`; a write plan is refused (§3.4) |
| `POST /{prefix}/{g}`, `POST /gremlin` | read on `g`; write on `g` if the plan writes (§3.4) |
| `GET`/`POST /graphql/{g}` | read on `g` |
| `PUT /{prefix}/{g}` | admin on `g` |
| `DELETE /{prefix}/{g}` | admin on `g` |
| `_changes`, `_revs_diff`, `_bulk_get`, `_match_set`, `_conflicts` | read on `g` |
| `_bulk_docs`, `_placement` | write on `g` |
| `_replicate` | write on `g`, plus admin (it reaches out) |
| `/_replicator…`, `/_scheduler…` | admin on `*` |

Graph creation: a request to a graph that the principal has no grant for fails before the graph is touched,
so no DO and no file is created for it. This closes T7 for authenticated deployments.

### 3.4 Read versus write, decided by the compiler's own output

The edge must know whether a traversal writes before it runs it. The compiler already says so: a write is
`kind: 'program'`. Two additions make the answer total:

1. A `Service` declares `effect: 'read' | 'write'`. `io()` with `read` direction is `write`; `io()` with
   `write` direction is a write to the io store (needs right `io`, decision D5); `federate` is `read`.
2. A `RequestScope` entry `access: { write: boolean, graphs: (id) => Rights }`. The compile refuses a plan
   that writes when `write` is false, with a clear error. A service checks `graphs(id)` before a sibling hop.

This respects locked decision 3 (compile to SQL): it is a check on the plan, not interpretation. It respects
the arch rule in `src/compiler/CLAUDE.md`: no Pass reads `ChainFacts`; the check reads only the final plan
kind and the service registry.

### 3.5 Cross-graph checks

`federate` to a local name checks `access.graphs(name).read` before the hop. On Cloudflare the check runs
where the hop starts: the Worker for a Worker-driven federate, and the DO for a DO-driven one. So the rights
must travel to the DO as plain data on the RPC.

Replication jobs store the principal that created them, and the scheduler runs each job with that
principal's rights.

### 3.6 Browser safety

- Refuse a `POST` whose `Content-Type` is not `application/json` or the GraphBinary type, with 415. This
  closes the `text/plain` simple-request path (T8) even with auth off.
- Add no CORS headers by default. An optional `corsOrigins` config adds them for named origins only.

### 3.7 Outbound credentials

Add `outboundAuth: { "<host>": { header: "<name>", secretRef: "<env name>" } }` to `MogwaiConfig`.
`allowlistedHttp` adds the header for an allowlisted host. This lets two authenticated mogwai servers
replicate and federate.

### 3.8 Audit

Add the principal name to the `QueryLogger` event (`src/router.ts:72-78`). The default logger stays silent.

## 4. Ordered work items

Each item lands with its test. "Both runtimes" means Bun tests plus the `wrangler dev` contract
(`test/contract.ts`).

| # | Item | Acceptance test |
|---|---|---|
| A1 | `Content-Type` check on `POST` data-plane and peer endpoints (§3.6). | A `text/plain` POST returns 415 and writes nothing; the stock client and federation still pass (L3 unchanged). |
| A2 | Config: `--auth-file` / `AUTH` secret parsing into `MogwaiConfig.auth`; hashes only. | A config with a plain token is refused at start-up with a clear message. |
| A3 | `Authenticator` decorator; Bearer and Basic. No config ⇒ open, with a start-up warning. | No header ⇒ 401 with `WWW-Authenticate`; wrong token ⇒ 401; right token ⇒ 200. Both runtimes. |
| A4 | Route-level authorization table (§3.3), except query read/write. | One test per row of §3.3, including "no grant ⇒ graph not created" (Bun: no file appears). |
| A5 | `Service.effect` and `RequestScope.access`; refuse a write plan without the write right; refuse writes on `GET` always. | `GET ?gremlin=g.addV()` is refused and writes nothing; a read-only token cannot run `addV`, `drop`, `mergeV` or `io().read()`; L3 still passes with an admin token. |
| A6 | `federate` checks the target graph's read right on both residencies. | Report 02's measured `victim`/`attacker` read is refused on Bun and on `wrangler dev`. |
| A7 | Replication jobs carry their creator; the scheduler runs with those rights. | A job whose creator lost access fails and backs off; it does not copy data. |
| A8 | Outbound credentials (§3.7). | Two in-memory servers with auth replicate through the router handler (`test/support/in-memory-transport.ts`). |
| A9 | Principal in the access log. | `$MOGWAI_LOG=1` lines name the principal. |
| A10 | Docs: a "Security" section in `README`/docs and a row in `docs/feature-support-matrix.md`. | Docs review. |
| A11 | Optional: Cloudflare Access JWT verification (D3). | A forged JWT is refused; a valid test JWT signed with a test key is accepted. |

## 5. Risks

| Risk | Check |
|---|---|
| The write classification misses a mutating path (a new service, a nested write). | A5 adds an L5-style property: every generated traversal whose plan is `program` or contains a `write`-effect service is refused under a read-only grant. |
| The DO trusts rights that the Worker sends. | Same trust domain as `runFramed` today (`src/cloudflare/graph-store-do.ts:110-113`). Document it. |
| Auth adds latency per request. | A hash compare per request; measure with `test/performance.test.ts`. Regression bar is 2× (root `CLAUDE.md`). |
| Glob grants are too coarse for multi-tenant use. | D2. |
| Breaking stock-client use. | A3 accepts Basic, which `driver.auth.basic()` sends. L3 runs with a token. |

## 6. Out of scope

Rate limiting and quotas; user management UI; per-element or per-property access control; OAuth flows.
Each can follow as its own plan.

## 7. Open decisions for the owner

| # | Decision | Options |
|---|---|---|
| D1 | Default with no auth config. | (a) open + warning (today's behaviour); (b) refuse to start unless `--insecure`. |
| D2 | Grant model. | (a) glob on graph name; (b) explicit list; (c) tenant prefix in the path. |
| D3 | Verify Cloudflare Access JWT in the Worker. | Yes (defence in depth, WebCrypto only) / no (trust Access). |
| D4 | Docs surface public. | Yes / behind read right. |
| D5 | `io()` rights. | A separate `io` right, or fold into `write`/`admin`. |
| D6 | Refuse writes on `GET` even with auth off. | Yes (closes CSRF via `GET`, touches `.claude/rules/management-api.md`) / only with auth on. |
| D7 | Any dependency. | None is needed for D1-D6. A JWT library for D3 would need approval; WebCrypto is enough. |

## Glossary

- **Grant:** a rule in the auth config that gives a principal rights on graphs whose names match a pattern.
- **Principal:** the identity a credential proves.
- **Right:** `read`, `write` or `admin` on a graph.
