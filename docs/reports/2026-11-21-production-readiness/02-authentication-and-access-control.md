# 02 — Authentication and access control

**Reviewer concern:** authentication and access control are "required for network-facing production use".

**Verdict:** the concern is valid. The server has **no authentication and no authorization** at any layer.
Every endpoint, every graph and every control-plane action is open to any client that can reach the port.
The one access control that exists is the outbound host allowlist, the server-side request forgery (SSRF)
guard. A safe deployment today needs an authenticating proxy in front of the server. Section 4 gives the
steps. The new feature is planned in `docs/2026-11-21-auth-access-control-plan.md`.

Status keys: **exists** = in the code and tested; **partial** = in the code with a gap; **missing** = not in
the code. "Measured" = observed in a throwaway script on 2026-11-21 (Bun runtime, `startServer({port: 0})`).
"Inferred" = read from code, not run.

This report does not repeat `docs/outstanding-work.md`. That file already records the gap in one line:
"There is no real Cloudflare deployment and no authentication" (`docs/outstanding-work.md:1595-1599`,
item `operations`). `docs/limitations.md` and `docs/feature-support-matrix.md` do not mention access
control.

---

## 1. The current trust model (Explanation)

### 1.1 One trust domain: whoever reaches the port

The HTTP router is `makeRouter` (`src/router.ts:245`). It is the same on Bun and on Cloudflare. It reads
the method and the path, and it dispatches. It never reads an `Authorization` header, a cookie, a client
certificate or any other credential. A search of `src/` for `authorization`, `bearer`, `api key` and
`access-control` finds no match in the request path (inferred, `grep -rni` over `src/`).

The composition root `application()` wires the router with no auth layer (`src/application.ts:43-50`).
Its header comment names auth as future work: "As the server grows (auth, digest…) new services layer on
with `.set()`/`.decorate()`" (`src/application.ts:12-13`). So the extension point exists, but nothing uses
it.

The result: the network boundary is the only boundary. Any client that can send an HTTP request to the
server has the full rights of an administrator.

### 1.2 A graph name is an address, not a secret or a tenant boundary

A graph is selected by its name in the path (`/gremlin/{g}`) or, on the bare `/gremlin` endpoint, by the
body field `g` (`src/router.ts:98-104`). Every verb creates the graph on first use:

- On Cloudflare, `getByName(id)` always returns a Durable Object stub (`src/cloudflare/cloudflare-graph-manager.ts:109-147`).
  A Durable Object (DO) is a single-threaded object with its own SQLite store; one DO holds one graph.
- On Bun, `resolve(id)` opens or creates `{dataDir}/{encodeURIComponent(id)}.sqlite`, or an in-memory
  database (`src/bun/BunGraphManager.ts:79-92`).

`.claude/rules/management-api.md` states this as a design commitment: "DO-on-first-access IS provisioning"
and "no verb 404s on a valid id". So any client can create any number of graphs. On Cloudflare each new
name is a new billed Durable Object (inferred).

Graphs are also not isolated from each other at the query level. The `federate` service runs a
sub-traversal on another graph by name (`src/services/catalog/federate.ts`). It checks recursion depth
(`src/services/params/federation-depth.ts:28`) but not permission. **Measured:** a query sent to graph
`attacker` read a property of graph `victim`:

```
GET /gremlin/attacker?gremlin=g.call("federate").with("graph","victim").with("traversal", __.V().values("pin"))
→ 200 ["1234"]
```

So a per-graph proxy rule (for example "token A may use only `/gremlin/a`") does **not** isolate tenants.
A token that can query any graph can read every graph.

### 1.3 Reads and writes share one verb

There is no read-only channel. `POST /{prefix}/{g}` runs any traversal, read or write
(`src/router.ts:455-456`). `GET /{prefix}/{g}?gremlin=` also runs any traversal, including writes.
`.claude/rules/management-api.md` lists "no read-only-write rejection on GET yet" as deferred.
**Measured:** `GET /gremlin/t1?gremlin=g.addV('x')` returned 200 and created a vertex.

### 1.4 No CORS headers, but simple cross-site requests still run

The router sets no `Access-Control-*` header. So a browser page on another origin cannot read a response.
A browser still sends a "simple request" (a `GET`, or a `POST` with `Content-Type: text/plain`) without a
preflight check, and the server runs it.

`parseRequest` does not check `Content-Type`. It treats any body that does not start with byte `0x84` as
JSON (`src/wire.ts:148-169`). **Measured:** a `POST` with `Content-Type: text/plain` and a JSON body
created a vertex. So a web page that a user opens can write to a mogwai server that the user's browser can
reach, for example `localhost:8182` or an intranet host. This is cross-site request forgery (CSRF).

### 1.5 Outbound HTTP is the one guarded surface

`io()` and `federate` can fetch a URL that the client puts in the query. That is a server-side request
forgery (SSRF) risk. `allowlistedHttp` closes it (`src/http-allowlist.ts:61-86`):

- The default allowlist is empty, and an empty allowlist denies every host (`src/http-allowlist.ts:71-76`).
- Only `http:` and `https:` schemes pass (`src/http-allowlist.ts:66-67`).
- A redirect is not followed (`src/http-allowlist.ts:78-83`).
- The match is on the hostname in the URL, not on a resolved IP, so it works the same on Bun and in a
  Worker (`src/http-allowlist.ts:1-13`).

Both entry points wrap their outbound `Http` with it: Bun at `src/bun/server.ts:32`, the Worker at
`src/cloudflare/worker.ts:28,38`, and the DO at `src/cloudflare/graph-store-do.ts:79-81`. **Measured:**
`g.io("http://169.254.169.254/latest/x.json").read()` failed with "outbound HTTP is disabled — no host
allowlist is configured". Tests: `test/http-allowlist.test.ts` (12 tests) and
`test/replicate-loop.test.ts:88` ("replication is fail-CLOSED against a non-allowlisted peer").

The allowlist controls **where** the server may connect. It does not control **who** may ask it to
connect. Once an operator allowlists a host, every client can make the server fetch from it, and push
replication can send any local graph to it (section 2.3).

### 1.6 Outbound requests carry no credentials

The federation transport sends only `Content-Type` and `Accept` (`src/http-federation.ts:96-101`). The
replication peer client and `httpIoStore` (`src/http-io.ts`) also add no credential. So mogwai cannot
federate with, or replicate to, a peer that needs authentication. If an operator puts an auth proxy in
front of both peers (section 4), replication between them fails with the proxy's HTTP status (inferred).

### 1.7 What the TinkerPop 4 client can send

The vendored `gremlin` JavaScript client has a request-interceptor hook. A connection takes
`interceptors` and an `auth` interceptor that always runs last
(`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/connection.ts:79-82,147-161`). Two auth
interceptors ship:

| Interceptor | Header it sets | Source |
|---|---|---|
| `basic(username, password)` | `authorization: Basic …` | `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/auth.ts:23-27` |
| `sigv4(region, service, …)` | AWS SigV4 headers | `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/auth.ts:37-88` |

A custom interceptor can set any header, for example a bearer token or Cloudflare Access service-token
headers. So a stock client can authenticate to a proxy today with no change to mogwai. The mogwai server
ignores all these headers.

The client also sends `X-Transaction-Id` for a remote transaction
(`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/connection.ts:302-309`). mogwai ignores it;
see report 03 for transactions.

---

## 2. Every exposed endpoint and its protection today (Reference)

All rows: authentication **missing**, authorization **missing**. "Creates graph" means the call creates the
named graph if it does not exist. Line numbers are in `src/router.ts` unless stated.

### 2.1 Data plane

| Method and path | Effect | Creates graph | Line |
|---|---|---|---|
| `POST /gremlin` | Any traversal, read or write. Graph from body field `g`, default `g`. | yes | 448 |
| `POST /{prefix}/{g}` | Any traversal, read or write. | yes | 455-456 |
| `GET /{prefix}/{g}?gremlin=` | Any traversal, **including writes** (measured). | yes | 460-467 |
| `OPTIONS /{prefix}/{g}` | Vertex and edge counts, version. | yes | 468-477 |
| `PUT /{prefix}/{g}` | Create the graph. | yes | 457-459 |
| `DELETE /{prefix}/{g}` | **Destroy the graph** (Bun: drop store; CF: `ctx.storage.deleteAll()`). | — | 478-480 |
| `GET`, `POST /graphql/{g}` | GraphQL query. Mutation and subscription are refused (`src/graphql/translate.ts:79`). | yes | 358-364 |

`{prefix}` is `gremlin` by default and is set by `--path-prefix` / `PATH_PREFIX` (`src/config.ts:40-75`).

### 2.2 Replication peer endpoints, under `/{prefix}/{g}/_…`

| Method and path | Effect | Line |
|---|---|---|
| `GET`, `POST …/_changes` | The whole change feed: every element of the graph. `filter` runs a client traversal. | 373-396 |
| `POST …/_revs_diff` | Which revisions the graph lacks. | 397-402 |
| `POST …/_bulk_get` | Read any element by global id. | 403-407 |
| `POST …/_match_set` | Run a client filter traversal; return matching ids. | 408-415 |
| `POST …/_placement` | Run a client **placement write** traversal. | 416-424 |
| `POST …/_bulk_docs` | **Write** any change set (create, update, delete) into the graph. | 425-429 |
| `POST …/_replicate` | Pull from or push to a URL (through the allowlist). | 430-436 |
| `GET …/_conflicts` | Conflict losers, including their full documents. | 437-442 |

### 2.3 Control plane (top level)

| Method and path | Effect | Line |
|---|---|---|
| `GET`, `POST /_replicator` | List or create replication jobs. | 334-338, 190-200 |
| `GET`, `PUT`, `DELETE /_replicator/{id}` | Read, replace or delete a job. `DELETE …?destroy_target=true` **destroys the local target graph**. | 201-229 |
| `GET /_scheduler/jobs`, `/_scheduler/docs` | Scheduler state, including every job's source and target. | 341-353 |
| `POST /_scheduler/run` | Run one scheduler tick now. | 345-349 |

A job is `{source, target}`, where each is a local graph name or a URL (`src/router.ts:159-173`). So any
client can copy any local graph into another local graph, or push it to any allowlisted host
(`src/replicate.ts:747-761`). The Cron Trigger then runs the job every minute on Cloudflare
(`wrangler.jsonc` `"crons": ["* * * * *"]`; `src/cloudflare/worker.ts:62-64`).

### 2.4 Docs surface (read-only, static)

| Method and path | Effect | Line |
|---|---|---|
| `GET /`, `GET /docs` | API reference HTML. | 307-308 |
| `GET /openapi.json` | OpenAPI spec. | 319-331 |
| `GET /scalar.js`, `/favicon.ico`, `/logo.png`, `/examples/*.json` | Static assets. | 315-318 |

These hold no graph data. Leaving them public is a choice for the operator.

### 2.5 Capabilities reachable from inside a Gremlin query

| Capability | Reach | Guard today | Status |
|---|---|---|---|
| `federate` to a local graph name | Read any graph in the deployment (measured). | Depth guard only (`src/services/params/federation-depth.ts:28`). | missing |
| `federate` to a URL | Query a remote mogwai. | Host allowlist. | exists |
| `io("path").read()` / `.write()` | Read or overwrite any document in the io directory (Bun) or R2 bucket (CF). | Bun path is rooted (`src/bun/FileIoStore.ts:32-36`). No per-client scope. | partial |
| `io("http(s)://…").read()` | Fetch a document. | Host allowlist; HTTP write and list refused (`src/http-io.ts`). | exists |
| `call()` other services | Directory, search, OLAP algorithms (`src/services/standard.ts:60`). | None needed beyond graph access. | — |

### 2.6 Internal surfaces (not reachable from the internet)

| Surface | Note |
|---|---|
| DO RPC methods (`framed`, `runFramed`, `readHead`, `runForeign`, `bulkDocs`, `destroy`, …) | Reached only through the Worker's `GRAPH` binding. `runFramed` runs raw SQL that the caller supplies. The code states the trust assumption: "only the paired Worker holds this DO binding" (`src/cloudflare/graph-store-do.ts:110-113`). |
| `ReplicatorRegistryDO` RPC | Reached only through the `REPLICATOR` binding. |
| Cron Trigger `scheduled()` | Platform-invoked (`src/cloudflare/worker.ts:62-64`). |

### 2.7 Configuration keys that affect exposure

| Key | Runtime | Default | Effect | Source |
|---|---|---|---|---|
| `--port` / `MOGWAI_PORT` | Bun | `8182` | Listen port. There is **no host option**; `Bun.serve({port, fetch})` listens on all interfaces. | `src/bun/server.ts:70` |
| `--allow-host` / `MOGWAI_HTTP_ALLOWLIST` | Bun | empty = deny all | Outbound host allowlist. | `src/config.ts:40-55` |
| `HTTP_ALLOWLIST`, `CONFIG.httpAllowlist` | Worker, DO | empty = deny all | Same. | `src/config.ts:67-75` |
| `--path-prefix` / `PATH_PREFIX` | both | `gremlin` | Graph path prefix. Not a secret. | `src/config.ts` |
| `--io-dir` / `MOGWAI_IO_DIR` | Bun | unset = `io()` off | Where `io()` reads and writes. | `src/bun/server.ts` |
| `IO` R2 binding | CF | bound in `wrangler.jsonc` | Where `io()` reads and writes. | `src/cloudflare/graph-store-do.ts:28-30` |
| `wrangler.jsonc` `vars` | CF | `{}` | Committed config sets no allowlist. | `wrangler.jsonc` |

---

## 3. Threats (Reference)

Each row assumes an attacker who can send HTTP requests to the server. "Today" is the state of the code on
2026-11-21.

| # | Threat | Today | Evidence | Status of mitigation |
|---|---|---|---|---|
| T1 | Read any graph's data. | Possible. | §2.1, §2.2 `_changes`, `_bulk_get`. | missing |
| T2 | Write or delete data in any graph. | Possible. | §2.1, `_bulk_docs`, `_placement`. | missing |
| T3 | Destroy a whole graph. | Possible: `DELETE /{prefix}/{g}`, or `DELETE /_replicator/{id}?destroy_target=true`. | `src/router.ts:478-480,209-224` | missing |
| T4 | Read graph B from a query on graph A. | Possible (measured). Defeats per-path proxy rules. | §1.2 | missing |
| T5 | Copy a graph out to an allowlisted host. | Possible through a push job or `_replicate`. | §2.3 | partial (allowlist limits destinations) |
| T6 | SSRF to an internal host or cloud metadata. | Blocked by default. Possible only to hosts the operator allowlists. | §1.5 | exists |
| T7 | Create unlimited graphs (storage and billing cost). | Possible on every verb. | §1.2 | missing |
| T8 | CSRF: a web page makes a user's browser write to a reachable server. | Possible with `GET` or `text/plain` `POST` (measured). | §1.3, §1.4 | missing |
| T9 | Denial of service with a long query. | Possible. On Bun a query runs synchronously on the one event loop, so it blocks every graph in the process. On CF the per-request CPU limit stops it; it blocks only that graph's DO while it runs. | `src/bun/BunSqlite.ts:39-42`; root `CLAUDE.md` ("the DO's per-request limit [is] the backstop") | missing (Bun), partial (CF) |
| T10 | Overwrite or delete a backup document. | Possible: `g.io("backup.json").write()` replaces it. | §2.5 | missing |
| T11 | Run any replication job on demand. | Possible: `POST /_scheduler/run`. | `src/router.ts:345-349` | missing |
| T12 | Raw SQL through `runFramed`. | Not reachable from the internet. Safe while only the paired Worker holds the binding. | `src/cloudflare/graph-store-do.ts:110-113` | exists (by deployment) |
| T13 | Audit: who did what. | No principal exists. The access log is off by default and has no client identity. | `src/router.ts:72-96` | missing |

---

## 4. Deploy safely today (How-to)

These steps use the code as it is. They put an authenticating proxy in front of mogwai, so mogwai itself
stays open behind it. They are **not** tested by a test in this repository.

The proxy gives an all-or-nothing gate. Every client that passes it has full rights on every graph (T4).
So give credentials only to clients that you trust with all data in the deployment. For several tenants
with different trust, deploy one mogwai per tenant.

### 4.1 Cloudflare: put Cloudflare Access in front of the Worker

Prerequisite: the Worker is on a custom domain in a Cloudflare zone.

1. Attach the Worker to a custom domain, for example `graph.example.com`.
2. Set `"workers_dev": false` in `wrangler.jsonc`. This removes the public `*.workers.dev` URL.
3. Set `"preview_urls": false` in `wrangler.jsonc`. This removes the public preview URLs.
4. In Cloudflare Zero Trust, create an Access application for `graph.example.com`.
5. Create a service token for each client program.
6. Add an Access policy with the action "Service Auth" that includes those service tokens.
7. Keep `vars` empty for `HTTP_ALLOWLIST`, unless a query must fetch from another host.
8. Deploy the Worker.

Steps 2 and 3 are necessary. Access protects a hostname, so any other public hostname for the Worker skips
it (inferred from how Access works; not tested here).

Configure each client to send the service token. With the vendored JavaScript client, add an interceptor:

```ts
const conn = new DriverRemoteConnection('https://graph.example.com/gremlin', {
  interceptors: (req) => {
    req.headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID!;
    req.headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET!;
  },
});
```

The interceptor hook is `connection.ts:79,147-161` in `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/`.

Known limits of this setup:

- The Worker does not verify the `Cf-Access-Jwt-Assertion` header. It trusts the network path. Steps 2-3
  close the other paths.
- Push or pull replication to another Access-protected mogwai fails, because outbound requests carry no
  credentials (§1.6).
- The Cron Trigger still runs saved replication jobs. It does not pass through Access.

### 4.2 Bun: put a reverse proxy in front of the server

1. Run mogwai where only the proxy can reach port 8182. Use a private container network or a host firewall.
2. Do not publish port 8182 on a public interface. mogwai listens on all interfaces (`src/bun/server.ts:70`).
3. Run a reverse proxy (for example Caddy or nginx) on the public port with TLS.
4. In the proxy, require HTTP Basic authentication, or mutual TLS, for every path.
5. In the proxy, forward requests to `http://<mogwai-host>:8182`.
6. Start mogwai with `--data-dir <dir>`. Without it, every graph is in memory and is lost on restart.
7. Leave `--allow-host` unset, unless a query must fetch from another host.

Configure each client with the Basic-auth interceptor that ships with the client:

```ts
import { driver } from 'gremlin';
const conn = new driver.DriverRemoteConnection('https://graph.example.com/gremlin', {
  auth: driver.auth.basic(user, password),
});
```

The proxy must not cache responses. A `GET` can be a write (§1.3).

### 4.3 Both runtimes: close the browser CSRF path

The proxy in 4.1 or 4.2 also closes T8 when it requires a credential that a browser does not add on its
own. A service token or Basic credentials typed into a client program meet this. If the proxy uses a
browser login cookie instead, a cross-site `GET` or `text/plain` `POST` can carry that cookie. Do not use
browser cookie login for the API hostname.

---

## 5. Summary (Reference)

| Area | Status |
|---|---|
| Authentication of clients | missing |
| Authorization per graph, per verb, read vs write | missing |
| Tenant isolation between graphs | missing (federate crosses graphs) |
| Control of graph creation | missing (by design today, `.claude/rules/management-api.md`) |
| Control-plane (replicator, scheduler) protection | missing |
| CSRF protection | missing |
| CORS policy | no headers; browsers cannot read responses cross-origin |
| Outbound SSRF guard | exists, deny-all default, tested |
| Outbound credentials for peers | missing |
| Audit identity | missing |
| Safe deployment with an external proxy | possible today (§4), not tested in repo |

The new feature, with work items and acceptance tests, is in
`docs/2026-11-21-auth-access-control-plan.md`.

---

## Glossary

- **Authentication:** proof of who sends a request.
- **Authorization:** the decision whether that sender may do the requested action.
- **CSRF (cross-site request forgery):** a web page makes a user's browser send a request to another server.
- **CORS (cross-origin resource sharing):** headers that let a browser page read a response from another origin.
- **Durable Object (DO):** a Cloudflare single-threaded object with its own storage. One DO holds one graph.
- **Principal:** the identity that a credential proves.
- **Service token:** a Cloudflare Access client id and secret that a program sends as two headers.
- **Simple request:** a browser request that runs without a CORS preflight check.
- **SSRF (server-side request forgery):** a client makes the server send a request to a target of the client's choice.
