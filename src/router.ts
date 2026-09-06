// The shared top-level HTTP router — identical on Bun and Cloudflare, and the
// EDGE that owns concerns A (wire parse) and C (HTTP response framing). It parses
// `/{prefix}/{g}` (prefix defaults to `gremlin`), dispatches by verb onto the injected
// `GraphManager`, and owns all management HTTP framing (status codes, JSON). The
// gremlin data plane resolves the graph id from the path (`/{prefix}/{g}`) or, on
// the bare `/gremlin` endpoint a stock TinkerPop client uses, from the request `g`
// field; it then parses the body once, hands {gremlin, params} across the manager
// seam (concern B, run in the store tier), and streams the returned framed buffers
// back out. Nothing routes on the body: a path id is used directly, and the bare
// endpoint's body-peek only happens when there is no path id to route on.
//
// The graph-path prefix is configurable; `gremlin` is the default. The bare `/gremlin`
// endpoint is NOT prefixed — it is a fixed TinkerPop HTTP convention (and the path
// the official cucumber harness / stock GLVs POST to), so it stays regardless.
import type { GraphManager } from './manager.ts';
import type { Http } from './api.ts';
import { parseRequest, parseJsonQuery } from './wire.ts';
import { streamBuffers, jsonResultResponse, errorResponse } from './http.ts';
import { buildDocs, buildOpenApiSpec } from './docs.ts';
import type { AssetStore } from './assetstore.ts';
import { isExamplePath } from './examples.ts';
import { handlePost, handleGet } from './graphql/edge.ts';
import { type ReplicatorRegistry, type ReplicationConfig, newConfigId } from './replicator-registry.ts';
import { isUrl } from './replicate.ts';

/** The bare endpoint a stock TinkerPop client POSTs to (graph named in the body
 *  `g` field). A fixed convention, independent of the configurable graph prefix. */
const BARE_ENDPOINT = '/gremlin';

/** The GraphBinary media type — now the EXPLICIT data-plane opt-in (the default flipped to readable JSON). */
const GRAPHBINARY_MT = 'application/vnd.graphbinary-v4.0';

/**
 * Content negotiation for the gremlin DATA plane, now DEFAULTING to readable UNTYPED-JSON (GraphSON):
 * does this request EXPLICITLY ask for GraphBinary?
 *
 * True only when `Accept` names `application/vnd.graphbinary-v4.0` — the exact mirror of the old
 * `wantsJson`, with the default inverted. This is SAFE because every real binary consumer sends that
 * type EXPLICITLY, so it keeps getting binary: the TinkerPop GLV client
 * (`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/connection.ts:286` —
 * `'Accept': this._responseSerializer.mimeType`, the GraphBinary mime by default) and our own federation
 * transport (`src/http-federation.ts:98` — `Accept: GRAPHBINARY_MIME`). So the L3 conformance suite (which
 * drives that client), the browser GLV, and federation all still get binary. A MISSING `Accept`, `*​/*`
 * (what the Scalar docs "Test Request" panel sends), curl and browsers get readable JSON instead — the
 * reason the docs demo "just makes sense" rather than showing a downloaded binary body. Parsed loosely by
 * substring, mirroring `graphql/edge.ts`'s `negotiate` (the audit-style clients never send q-values that
 * reorder these two), but NOT shared with it — the media types differ.
 */
function prefersBinary(accept: string | null): boolean {
  return accept != null && accept.includes(GRAPHBINARY_MT);
}

// The docs' static assets, served from the injected AssetStore (Bun from the binary-embedded copy, CF from
// the Workers Static Assets binding) rather than a CDN. Three entries: the Scalar UI module `scalarUrl:
// './scalar.js'` points at, the favicon the docs shell links, and the brand logo the API reference shows.
// A GET whose path is in this set — or a known `/examples/<name>.json` reference-graph dataset
// (isExamplePath) — is offered to the AssetStore first; anything else routes as before.
const DOCS_ASSET_PATHS = new Set(['/scalar.js', '/favicon.ico', '/logo.png']);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Per-query observability is a pluggable presentation seam (data capture is a
// separate manager decorator — see test/L3-conformance/telemetry.ts); the conformance
// host swaps in a compact `.`/`E` progress reporter.
export type QueryLogger = (event: {
  id: string;
  gremlin: string;
  ok: boolean;
  results?: number;
  error?: string;
}) => void;

/** The DEFAULT: say nothing. A server that narrates every request is unreadable under any load,
 *  and it buried the suite's own output (~100 `OK …` lines per `mise run test`).
 *
 *  Silent on FAILURE too, which is the less obvious half: a failed traversal is already reported
 *  to the caller on the GraphBinary trailer, so logging it as well duplicates a message that has
 *  a proper channel — and the overwhelmingly common failure here is an unsupported traversal,
 *  i.e. someone else's typo, not our incident. Logging those made the conformance run (where an
 *  expected-deferral population is RATCHETED, ~290 of them) print a wall of red. `verboseLogger`
 *  is the opt-in access log: `$MOGWAI_LOG=1` on the Bun entry point. */
export const silentLogger: QueryLogger = () => {};

/** The one-line-per-query access log, opt-in (CF → wrangler tail; Bun → `$MOGWAI_LOG`). */
export const verboseLogger: QueryLogger = (e) =>
  console.log(e.ok ? `OK   [${e.id}] ${e.gremlin} -> ${e.results} result(s)` : `ERR  ${e.error}`);

// Parse the wire, resolve the graph id (path wins over body `g`, default 'g'), run
// the traversal across the seam, and frame the response. All failure modes — a bad
// body, a compile/SQL error — ride the GraphBinary trailer (HTTP 200) via errorResponse.
async function runQuery(mgr: GraphManager, pathId: string | null, req: Request, log: QueryLogger): Promise<Response> {
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    const { gremlin, params, paramTypes, g, batchSize, bulked } = await parseRequest(raw);
    const id = pathId ?? g ?? 'g';
    const exec = mgr.executor(id);
    // Content negotiation: readable untyped-JSON is now the DEFAULT — a request that does NOT explicitly
    // ask for GraphBinary gets it, UNLESS the executor can't render it (no `jsonAsync`) or the result shape
    // isn't covered yet (`resolveJson` → null), in which case we fall through to the byte-identical
    // GraphBinary path (fail closed on shapes JSON can't render). An explicit GraphBinary Accept — what the
    // GLV clients (connection.ts:286) and federation (http-federation.ts:98) send — skips straight to binary.
    if (!prefersBinary(req.headers.get('Accept')) && exec.jsonAsync) {
      const json = await exec.jsonAsync(gremlin, params, paramTypes);
      if (json !== null) { log({ id, gremlin, ok: true }); return jsonResultResponse(json); }
    }
    const framed = await exec.framedAsync(gremlin, params, paramTypes);
    log({ id, gremlin, ok: true, results: framed.length });
    return streamBuffers(framed, batchSize, bulked);
  } catch (e: any) {
    log({ id: pathId ?? 'g', gremlin: '', ok: false, error: e.message });
    return errorResponse(e.message);
  }
}

// The GET data plane: a READ query built from the URL query string (`?gremlin=…`), the CACHEABLE
// counterpart to the POST body form (a GET is cacheable by any HTTP intermediary; a POST is not). No
// body is read — GET has none — so it reuses the JSON-request seam (`parseJsonQuery`) over fields it
// assembles from the query string. `bindings` is an OPTIONAL JSON-encoded string; a malformed one throws
// and rides the GraphBinary trailer via errorResponse, the same channel as any compile/SQL error. The
// RESPONSE honours the same content negotiation as POST (`prefersBinary`): readable untyped JSON by
// default, GraphBinary (byte-identical to POST) only when the request explicitly sends
// `Accept: application/vnd.graphbinary-v4.0` — what the GLV clients + federation send.
async function runGetQuery(mgr: GraphManager, id: string, searchParams: URLSearchParams, accept: string | null, log: QueryLogger): Promise<Response> {
  try {
    const bindingsRaw = searchParams.get('bindings');
    const rawBatch = searchParams.get('batchSize');
    const { gremlin, params, paramTypes, batchSize, bulked } = parseJsonQuery({
      gremlin: searchParams.get('gremlin')!, // caller already checked present + non-empty
      bindings: bindingsRaw ? JSON.parse(bindingsRaw) : undefined,
      batchSize: rawBatch != null ? Number(rawBatch) : undefined,
      bulkResults: searchParams.get('bulk') === 'true',
    });
    const exec = mgr.executor(id);
    // Same content negotiation as POST (JSON default + fail-closed binary fallback; explicit binary opt-in).
    if (!prefersBinary(accept) && exec.jsonAsync) {
      const json = await exec.jsonAsync(gremlin, params, paramTypes);
      if (json !== null) { log({ id, gremlin, ok: true }); return jsonResultResponse(json); }
    }
    const framed = await exec.framedAsync(gremlin, params, paramTypes);
    log({ id, gremlin, ok: true, results: framed.length });
    return streamBuffers(framed, batchSize, bulked);
  } catch (e: any) {
    log({ id, gremlin: '', ok: false, error: e.message });
    return errorResponse(e.message);
  }
}

/** Parse a replication-config request body into a stored {@link ReplicationConfig} at `id`, failing closed
 *  on a missing/blank `source` or `target` (the two required fields — both graph refs; direction validity is
 *  a run-time check, since a local→local job is legitimate). Unknown fields are ignored. */
function parseConfig(id: string, body: any): ReplicationConfig {
  const source = typeof body?.source === 'string' ? body.source.trim() : '';
  const target = typeof body?.target === 'string' ? body.target.trim() : '';
  if (!source || !target) throw new Error('a replication config needs a non-empty `source` and `target`');
  return {
    id, source, target,
    continuous: body.continuous === true,
    createTarget: body.create_target === true || body.createTarget === true,
    filter: typeof body.filter === 'string' ? body.filter : null,
    placement: typeof body.placement === 'string' ? body.placement : null,
    checkpointInterval: Number.isFinite(body.checkpoint_interval) ? body.checkpoint_interval
      : Number.isFinite(body.checkpointInterval) ? body.checkpointInterval : null,
    useCheckpoints: !(body.use_checkpoints === false || body.useCheckpoints === false),
  };
}

/** Trial-run a captured `filter` against its source and throw on a non-vertex/erroring one — the
 *  save-time validation (filtered-replication-plan §2). Injected (like `runTick`) so the outbound `http`
 *  stays at the composition root, out of the router/store tier. */
export type FilterValidator = (source: string, filter: string) => Promise<void>;

/** The replicator control-plane CRUD (§9): `/_replicator` (list/create) and `/_replicator/{id}`
 *  (get/replace/delete). All JSON, all idempotent + create-on-demand like the graph-lifecycle verbs. A
 *  config with a `filter` is trial-run at save (`validateFilter`) and REJECTED (400) if it does not yield
 *  a vertex stream — fail-closed so a broken filter never becomes a silently-wrong replication (§2/§6). */
async function handleReplicator(mgr: GraphManager, registry: ReplicatorRegistry, id: string | null, req: Request, validateFilter?: FilterValidator): Promise<Response> {
  const save = async (config: ReplicationConfig): Promise<void> => {
    if (config.filter && validateFilter) await validateFilter(config.source, config.filter);
    await registry.putConfig(config);
  };
  try {
    if (id === null) {
      if (req.method === 'GET') return json({ configs: await registry.listConfigs() });
      if (req.method === 'POST') {
        const body = (await req.json()) as any;
        const cid = typeof body?.id === 'string' && body.id ? body.id : newConfigId();
        await save(parseConfig(cid, body));
        return json({ id: cid, ok: true }, 201);
      }
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }
    switch (req.method) {
      case 'GET': {
        const config = await registry.getConfig(id);
        return config ? json(config) : json({ error: 'not found', id }, 404);
      }
      case 'PUT': {
        await save(parseConfig(id, (await req.json()) as any));
        return json({ id, ok: true }, 201);
      }
      case 'DELETE': {
        // UNDO (filtered-replication-plan §6/F3): `?destroy_target=true` also DESTROYS the target replica,
        // not just the config — the dedicated-target undo, where the whole replica is additive so dropping
        // it is a clean reversal (`mgr.destroy`, the same idempotent teardown a `DELETE /gremlin/{g}` runs).
        // Only a LOCAL target id is destroyed here; a REMOTE (`http(s)`) target is left to its own endpoint
        // (destroying it needs an outbound DELETE — deferred with the shared-target before-image journal),
        // and the shared-target case (a target with pre-existing data) is exactly what that journal is for.
        const destroyTarget = new URL(req.url).searchParams.get('destroy_target') === 'true';
        const config = destroyTarget ? await registry.getConfig(id) : null;
        await registry.deleteConfig(id); // idempotent — deleting an absent job succeeds
        if (destroyTarget && config && !isUrl(config.target)) {
          await mgr.destroy(config.target);
          return json({ id, undone: true, target_destroyed: config.target });
        }
        if (destroyTarget && config && isUrl(config.target))
          return json({ id, undone: true, target_destroyed: null, note: 'a remote target is not destroyed by undo; delete it at its own endpoint' });
        return new Response(null, { status: 204 });
      }
      default:
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT, DELETE' } });
    }
  } catch (e: any) {
    return json({ error: e.message }, 400);
  }
}

/** Scheduler introspection (§9): `jobs` = the per-config scheduler state (CouchDB `_scheduler/jobs`);
 *  `docs` = each config merged with its job state (CouchDB `_scheduler/docs`). Both read-only JSON. */
async function handleScheduler(registry: ReplicatorRegistry, which: string): Promise<Response> {
  if (which === 'jobs') return json({ jobs: await registry.listJobs() });
  const [configs, jobs] = await Promise.all([registry.listConfigs(), registry.listJobs()]);
  const byId = new Map(jobs.map((j) => [j.configId, j]));
  const docs = configs.map((c) => ({ ...c, job: byId.get(c.id) ?? null }));
  return json({ docs });
}

export function makeRouter(
  mgr: GraphManager,
  pathPrefix = 'gremlin',
  log: QueryLogger = silentLogger,
  /** The control-plane store for ongoing replication (§9). TOP-LEVEL (`/_replicator[/{id}]`), CouchDB's
   *  node-global `_replicator` — NOT per-graph, since a job is a standalone `{source, target}` run by the
   *  worker-residency scheduler. Optional: a runtime without one returns 501 on those routes. */
  registry?: ReplicatorRegistry,
  /** Fire ONE scheduler tick (the worker-residency runner), backing `POST /_scheduler/run`. Injected so the
   *  router stays out of the scheduler's dependency graph (it just triggers it). Absent ⇒ that route 501s. */
  runTick?: () => Promise<unknown>,
  /** Trial-run a config's `filter` against its source at save (filtered-replication-plan §2). Injected so
   *  the outbound `http` a remote source needs lives at the composition root, not the router. Absent ⇒ a
   *  filter is stored unvalidated (a runtime that has not wired it yet). */
  validateFilter?: FilterValidator,
  /** Where the docs Scalar UI loads its module from. Defaults to the pinned CDN (Bun/CF); the browser
   *  build passes `./scalar.js` so the docs are self-contained (a shipped static asset). */
  scalarUrl?: string,
  /** A script the docs shell loads first. The browser build passes `./mogwai-db.js` so the shell — served
   *  at both `/` (the site root) and `/docs` — also hosts the per-tab WorkerFactory (the browser serves
   *  this shell as its index.html, so this IS the tab the data plane must live in). Bun/CF pass nothing. */
  bootScript?: string,
  /** The version stamped into the OpenAPI `info.version` (`src/version.ts`). Defaults to `'dev'` for
   *  callers that don't stamp one (tests, the conformance host). */
  version = 'dev',
  /** OVERRIDE for the OpenAPI `servers[0].url` base. Left undefined (Bun/CF), the `/openapi.json` handler
   *  derives the base from the request's own origin. The browser build passes one because on a sub-path
   *  deploy (GitHub Pages `/mogwai-db/`) the SW STRIPS that base before the router sees the path, so the
   *  request no longer carries it. A THUNK is accepted as well as a string: the browser cannot read its
   *  registration scope at construction (before the SW installs), so it defers the read to request time. */
  docsBaseUrl?: string | (() => string | undefined),
  /** Where the docs' static assets (the Scalar UI module `scalarUrl` names, the favicon, the logo) are
   *  served from — the Bun binary-embedded copy or the CF Workers Static Assets binding, behind the runtime-
   *  agnostic {@link AssetStore} seam. Optional: absent (bare test routers), those paths are not intercepted
   *  and the docs shell falls back to the pinned CDN (`SCALAR_CDN`). An entry wiring this also passes
   *  `scalarUrl: './scalar.js'` so the docs load the asset same-origin. */
  assets?: AssetStore,
): Http {
  const graphPath = new RegExp(`^/${escapeRe(pathPrefix)}/([^/]+)/?$`);
  // The replicator control plane is TOP-LEVEL (like /docs), not under the graph prefix: `/_replicator`
  // (list/create) and `/_replicator/{id}` (get/replace/delete). CouchDB's `_replicator` DB shape.
  const replicatorPath = new RegExp('^/_replicator(?:/([^/]+))?/?$');
  // Scheduler introspection (CouchDB `_scheduler/jobs` + `_scheduler/docs`, read-only) plus a `run` admin
  // trigger (`POST /_scheduler/run`) that fires one scheduler tick NOW — the uniform, over-HTTP way to drive
  // the worker-residency runner (the cron/interval do it on a schedule in production; this is "run now").
  const schedulerPath = new RegExp('^/_scheduler/(jobs|docs|run)/?$');
  // Peer-facing sync endpoints (§9), CouchDB-shaped under the `_` system prefix: `/{prefix}/{g}/_changes`
  // and (2d) `/{prefix}/{g}/_revs_diff`. A second, longer path so a graph id can never be read as one.
  const systemPath = new RegExp(`^/${escapeRe(pathPrefix)}/([^/]+)/(_[a-z_]+)/?$`);
  // The GraphQL edge is a SEPARATE, fixed path (§5): a GraphQL client speaks its own
  // over-HTTP protocol and JSON envelope, never the Gremlin wire, so it does not share the
  // configurable gremlin prefix or the verb-dispatch below.
  const gqlPath = new RegExp('^/graphql/([^/]+)/?$');
  const { DOCS_HTML } = buildDocs(scalarUrl, bootScript);

  return async function router(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // Docs surface (GET-only). The API reference is the SITE ROOT: `/` serves the Scalar shell DIRECTLY (no
    // redirect), and `/docs` is a kept ALIAS to the same HTML so existing links — and the browser SW's
    // `/docs` route — keep working. Separate paths from /{prefix}/{g}, so GLV traffic is untouched.
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/docs')
        return new Response(DOCS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      // The docs' static assets (the Scalar UI module, the favicon, the logo) plus the `/examples/*.json`
      // reference-graph datasets (src/examples.ts) — served from the injected AssetStore, so both the UI and
      // the example graphs are self-hosted, never a CDN. This is what makes the docs demo self-seeding: the
      // OpenAPI "Load example" entries send `g.io("<origin>/examples/<name>.json").read()`, which fetches
      // right back here. A router with no AssetStore skips this (the shell then uses SCALAR_CDN, and
      // /examples 404s); an AssetStore that doesn't hold the path returns null and we fall through.
      if (assets && (DOCS_ASSET_PATHS.has(pathname) || isExamplePath(pathname))) {
        const asset = await assets.get(pathname);
        if (asset) return asset;
      }
      if (pathname === '/openapi.json') {
        // Request-derived so `servers[0].url` is the ABSOLUTE base this request arrived on and the spec's
        // paths compose. `docsBaseUrl` (a string, or a thunk resolved now) OVERRIDES — the browser SW
        // supplies its sub-path base, which it strips before routing so the request can't reveal it. Bun/CF
        // leave it undefined and fall back to the request origin (e.g. `http://localhost:8182`).
        const override = typeof docsBaseUrl === 'function' ? docsBaseUrl() : docsBaseUrl;
        const base = override ?? new URL(req.url).origin;
        return new Response(JSON.stringify(buildOpenApiSpec(pathPrefix, base, version)), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // The replicator control plane (§9) — top-level CRUD over persistent replication jobs. Matched before
    // the graph path (a distinct root, so no collision) and independent of the configurable graph prefix.
    const repMatch = pathname.match(replicatorPath);
    if (repMatch) {
      if (!registry) return json({ error: 'replication registry not configured' }, 501);
      return handleReplicator(mgr, registry, repMatch[1] ? decodeURIComponent(repMatch[1]) : null, req, validateFilter);
    }

    // Scheduler introspection (`jobs`/`docs`, GET) + the `run` trigger (POST) — one scheduler tick now.
    const schMatch = pathname.match(schedulerPath);
    if (schMatch) {
      if (!registry) return json({ error: 'replication registry not configured' }, 501);
      const which = schMatch[1]!;
      if (which === 'run') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        if (!runTick) return json({ error: 'replication scheduler not configured' }, 501);
        try { return json(await runTick()); } catch (e: any) { return json({ error: e.message }, 500); }
      }
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
      return handleScheduler(registry, which);
    }

    // The GraphQL edge — GraphQL-over-HTTP on `POST /graphql/{g}` (JSON body) and `GET /graphql/{g}`
    // (`?query=`), the two verbs the spec defines and `graphql-http`'s audit grades (§5). Matched
    // BEFORE the gremlin path so the two protocols never collide, and it uses the same executor seam a
    // Gremlin query does. No server-rendered HTML: the endpoint is the product.
    const gqlMatch = pathname.match(gqlPath);
    if (gqlMatch) {
      const gid = decodeURIComponent(gqlMatch[1]!);
      if (req.method === 'POST') return handlePost(mgr.executor(gid), req);
      if (req.method === 'GET') return handleGet(mgr.executor(gid), req);
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }

    // Peer-facing replication endpoints (§9) — the `_`-prefixed system routes, matched before the
    // graph path so `{g}/_changes` never reads `_changes` as a query verb. Store-tier reads framed as
    // JSON, the shape a mogwai peer (Phase 3) consumes.
    const sysMatch = pathname.match(systemPath);
    if (sysMatch) {
      const gid = decodeURIComponent(sysMatch[1]!);
      const endpoint = sysMatch[2]!;
      if (endpoint === '_changes') {
        // The feed is a GET (`?since=&limit=&filter=`) OR a POST (`{since, limit, filter}` JSON body). A
        // captured `filter` (filtered-replication-plan F1) is an arbitrary-length traversal, so a
        // replicator POSTs it (URL-length-safe); a plain caught-up-cursor read stays a GET. Both accepted —
        // the caller decides. `?limit=N` pages the feed (CouchDB `_changes?limit=N`); absent/≤0 ⇒ unpaged.
        if (req.method !== 'GET' && req.method !== 'POST')
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
        try {
          const posLimit = (n: unknown): number | undefined => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : undefined);
          let since = 0, limit: number | undefined, filter: string | undefined;
          if (req.method === 'POST') {
            const body = (await req.json()) as { since?: number; limit?: number; filter?: string };
            since = Math.max(0, Number(body?.since ?? 0) || 0);
            limit = posLimit(body?.limit);
            filter = typeof body?.filter === 'string' && body.filter ? body.filter : undefined;
          } else {
            const params = new URL(req.url).searchParams;
            since = Math.max(0, Number(params.get('since') ?? 0) || 0);
            limit = posLimit(params.get('limit'));
            filter = params.get('filter') || undefined;
          }
          return json(await mgr.changes(gid, since, limit, filter));
        } catch (e: any) { return json({ error: e.message }, 400); } // a non-vertex filter fails closed here
      }
      if (endpoint === '_revs_diff') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try {
          return json(await mgr.revsDiff(gid, (await req.json()) as Record<string, { gen: number; hash: string }[]>));
        } catch (e: any) { return json({ error: e.message }, 400); }
      }
      if (endpoint === '_bulk_get') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try { return json(await mgr.bulkGet(gid, (await req.json()) as { gid: string; kind: 'vertex' | 'edge' }[])); }
        catch (e: any) { return json({ error: e.message }, 400); }
      }
      if (endpoint === '_match_set') {
        // The SOURCE-side current match set as gids for placement (filtered-replication-plan §3/F2).
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try {
          const { filter } = (await req.json()) as { filter: string };
          return json({ gids: await mgr.matchSet(gid, filter) });
        } catch (e: any) { return json({ error: e.message }, 400); } // a non-vertex filter fails closed here
      }
      if (endpoint === '_placement') {
        // Run the TARGET-side placement over the matched gids (§3/F2) — an idempotent graft.
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try {
          const { placement, matchGids } = (await req.json()) as { placement: string; matchGids: string[] };
          await mgr.placement(gid, placement, matchGids);
          return json({ ok: true });
        } catch (e: any) { return json({ error: e.message }, 400); }
      }
      if (endpoint === '_bulk_docs') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try { await mgr.bulkDocs(gid, await req.json()); return json({ ok: true }); }
        catch (e: any) { return json({ error: e.message }, 400); }
      }
      if (endpoint === '_replicate') {
        // One-shot replication (§9): `{source: url}` PULLS a remote into {g}, `{target: url}` PUSHES {g}
        // out. The loop runs at manager (worker) residency, out of the store tier.
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        try { return json(await mgr.replicate(gid, await req.json())); }
        catch (e: any) { return json({ error: e.message }, 400); }
      }
      if (endpoint === '_conflicts') {
        // Surfaced conflicts (§6·3) — winner + shadowed losers per conflicted element, the read that
        // ordinary traversal never shows.
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        return json({ conflicts: await mgr.conflicts(gid) });
      }
      return new Response('Not found', { status: 404 });
    }

    // Bare gremlin endpoint: a stock TinkerPop client POSTs to one URL and names the
    // graph in the request `g` field. No path id → runQuery peeks the parsed body.
    if (req.method === 'POST' && pathname === BARE_ENDPOINT) return runQuery(mgr, null, req, log);

    const match = pathname.match(graphPath);
    if (!match) return new Response('Not found', { status: 404 });
    const id = decodeURIComponent(match[1]);

    switch (req.method) {
      case 'POST': // gremlin query — graph id from the path
        return runQuery(mgr, id, req, log);
      case 'PUT': // create-if-absent (idempotent)
        await mgr.create(id);
        return json({ id, created: true }, 201);
      case 'GET': { // read query from `?gremlin=` — the cacheable data-plane verb (metadata moved to OPTIONS)
        const searchParams = new URL(req.url).searchParams;
        // Require the query parameter: a bare GET has no traversal to run, and silently serving metadata
        // instead (the old behaviour) would mask a caller who meant to send one. Point them at OPTIONS.
        if (!searchParams.get('gremlin'))
          return json({ error: `GET /${pathPrefix}/{id} requires a \`gremlin\` query parameter, e.g. ?gremlin=g.V().count(). Use OPTIONS for graph metadata, or POST with a JSON/GraphBinary body.` }, 400);
        return runGetQuery(mgr, id, searchParams, req.headers.get('Accept'), log);
      }
      case 'OPTIONS': {
        // Graph METADATA — the element counts (+ stamped version) the old GET served, now on the HTTP
        // metadata verb. Auto-creates the graph empty on demand via `mgr.info`, exactly as the old GET
        // did (existence isn't separately detectable, matching Durable Objects, so this never 404s on a
        // well-formed id). Minor overload: it doubles as the literal HTTP OPTIONS verb, hence the `Allow`.
        return new Response(JSON.stringify({ id, version, ...(await mgr.info(id)) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Allow': 'GET, POST, PUT, DELETE, OPTIONS' },
        });
      }
      case 'DELETE': // teardown (idempotent — deleting twice is fine)
        await mgr.destroy(id);
        return new Response(null, { status: 204 });
      default:
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, POST, PUT, DELETE, OPTIONS' },
        });
    }
  };
}
