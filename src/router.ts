// The shared top-level HTTP router — identical on Bun and Cloudflare. It parses
// `/g/{id}`, dispatches by verb onto the injected `GraphManager`, and owns ALL
// management HTTP framing (status codes, JSON) in one place. The gremlin data
// plane (`POST`) is a pass-through: the manager returns an already-framed
// GraphBinary Response (always 200; errors ride the status trailer per the wire
// protocol), so we don't touch it. Management verbs are plain REST with real
// status codes — that framing is protocol-distinct from gremlin and lives only
// here, never leaking into the manager implementations.
import type { GraphManager } from './manager.ts';

const GRAPH_PATH = /^\/g\/([^/]+)\/?$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function makeRouter(mgr: GraphManager): (req: Request) => Promise<Response> {
  return async function router(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const match = pathname.match(GRAPH_PATH);
    if (!match) return new Response('Not found', { status: 404 });
    const id = decodeURIComponent(match[1]);

    switch (req.method) {
      case 'POST': // gremlin query — pass the framed GraphBinary Response through
        return mgr.query(id, req);
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
