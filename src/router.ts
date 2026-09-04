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
import { parseRequest } from './wire.ts';
import { streamBuffers, errorResponse } from './http.ts';
import { buildDocs } from './docs.ts';
import { handlePost, handleGet } from './graphql/edge.ts';
import { type ReplicatorRegistry, type ReplicationConfig, newConfigId } from './replicator-registry.ts';

/** The bare endpoint a stock TinkerPop client POSTs to (graph named in the body
 *  `g` field). A fixed convention, independent of the configurable graph prefix. */
const BARE_ENDPOINT = '/gremlin';

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
    const framed = await mgr.executor(id).framedAsync(gremlin, params, paramTypes);
    log({ id, gremlin, ok: true, results: framed.length });
    return streamBuffers(framed, batchSize, bulked);
  } catch (e: any) {
    log({ id: pathId ?? 'g', gremlin: '', ok: false, error: e.message });
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
    checkpointInterval: Number.isFinite(body.checkpoint_interval) ? body.checkpoint_interval
      : Number.isFinite(body.checkpointInterval) ? body.checkpointInterval : null,
    useCheckpoints: !(body.use_checkpoints === false || body.useCheckpoints === false),
  };
}

/** The replicator control-plane CRUD (§9): `/_replicator` (list/create) and `/_replicator/{id}`
 *  (get/replace/delete). All JSON, all idempotent + create-on-demand like the graph-lifecycle verbs. */
async function handleReplicator(registry: ReplicatorRegistry, id: string | null, req: Request): Promise<Response> {
  try {
    if (id === null) {
      if (req.method === 'GET') return json({ configs: await registry.listConfigs() });
      if (req.method === 'POST') {
        const body = (await req.json()) as any;
        const cid = typeof body?.id === 'string' && body.id ? body.id : newConfigId();
        const config = parseConfig(cid, body);
        await registry.putConfig(config);
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
        await registry.putConfig(parseConfig(id, (await req.json()) as any));
        return json({ id, ok: true }, 201);
      }
      case 'DELETE':
        await registry.deleteConfig(id); // idempotent — deleting an absent job succeeds
        return new Response(null, { status: 204 });
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
  const { DOCS_HTML, OPENAPI_JSON } = buildDocs(pathPrefix);

  return async function router(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // Docs surface (GET-only). Separate paths from /{prefix}/{g}, so GLV traffic is untouched.
    if (req.method === 'GET') {
      if (pathname === '/') return Response.redirect(new URL('/docs', req.url).toString(), 302);
      if (pathname === '/docs')
        return new Response(DOCS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (pathname === '/openapi.json')
        return new Response(OPENAPI_JSON, { headers: { 'Content-Type': 'application/json' } });
    }

    // The replicator control plane (§9) — top-level CRUD over persistent replication jobs. Matched before
    // the graph path (a distinct root, so no collision) and independent of the configurable graph prefix.
    const repMatch = pathname.match(replicatorPath);
    if (repMatch) {
      if (!registry) return json({ error: 'replication registry not configured' }, 501);
      return handleReplicator(registry, repMatch[1] ? decodeURIComponent(repMatch[1]) : null, req);
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
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
        const params = new URL(req.url).searchParams;
        const since = Math.max(0, Number(params.get('since') ?? 0) || 0);
        // `?limit=N` pages the feed (CouchDB `_changes?limit=N`) so a replicator drains a large graph in
        // bounded batches; absent/≤0 ⇒ the whole feed (unpaged).
        const rawLimit = Number(params.get('limit'));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
        return json(await mgr.changes(gid, since, limit));
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
      case 'GET': // info — auto-creates empty on demand, mirroring CF provisioning
        return json({ id, ...(await mgr.info(id)) });
      case 'DELETE': // teardown (idempotent — deleting twice is fine)
        await mgr.destroy(id);
        return new Response(null, { status: 204 });
      default:
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, POST, PUT, DELETE' },
        });
    }
  };
}
