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
import { parseRequest } from './wire.ts';
import { streamBuffers, errorResponse } from './http.ts';
import { buildDocs } from './docs.ts';

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
// separate manager decorator — see test/conformance/telemetry.ts). The default is
// the verbose one-line-per-query log both runtimes have always emitted (CF → wrangler
// tail); the conformance host swaps in a compact `.`/`E` progress reporter.
export type QueryLogger = (event: {
  id: string;
  gremlin: string;
  ok: boolean;
  results?: number;
  error?: string;
}) => void;

const verboseLogger: QueryLogger = (e) =>
  console.log(e.ok ? `OK   [${e.id}] ${e.gremlin} -> ${e.results} result(s)` : `ERR  ${e.error}`);

// Parse the wire, resolve the graph id (path wins over body `g`, default 'g'), run
// the traversal across the seam, and frame the response. All failure modes — a bad
// body, a compile/SQL error — ride the GraphBinary trailer (HTTP 200) via errorResponse.
async function runQuery(mgr: GraphManager, pathId: string | null, req: Request, log: QueryLogger): Promise<Response> {
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    const { gremlin, params, paramTypes, g, batchSize, bulked } = parseRequest(raw);
    const id = pathId ?? g ?? 'g';
    const framed = await mgr.query(id, gremlin, params, paramTypes);
    log({ id, gremlin, ok: true, results: framed.length });
    return streamBuffers(framed, batchSize, bulked);
  } catch (e: any) {
    log({ id: pathId ?? 'g', gremlin: '', ok: false, error: e.message });
    return errorResponse(e.message);
  }
}

export function makeRouter(
  mgr: GraphManager,
  pathPrefix = 'gremlin',
  log: QueryLogger = verboseLogger,
): (req: Request) => Promise<Response> {
  const graphPath = new RegExp(`^/${escapeRe(pathPrefix)}/([^/]+)/?$`);
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
