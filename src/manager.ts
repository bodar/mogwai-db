// The graph-lifecycle seam. `GraphManager` is the runtime-specific half of the
// management story: creating, inspecting, and destroying whole graphs. The
// shared `makeRouter` (router.ts) dispatches HTTP verbs onto it, so the two
// runtimes present an identical management API. Everything platform-specific
// (a Bun in-process registry vs a Cloudflare Durable Object namespace) hides
// behind this interface, mirroring how `Sql` hides the SQLite transport.
//
// Semantics are idempotent and create-on-demand, matching Cloudflare's model:
// addressing `/g/{id}` at all brings the graph into existence (a DO springs
// into being on first access; the namespace has no "does this exist?" query).
// So no verb 404s on a well-formed id — GET/POST auto-create an empty graph,
// PUT is create-if-absent, DELETE is a no-op when there's nothing to remove.
import type { GraphStore } from './storage.ts';

export interface GraphInfo {
  vertexCount: number;
  edgeCount: number;
}

export interface GraphManager {
  /** Run a gremlin request against graph `id`, creating it on demand. Returns
   *  the already-framed GraphBinary Response (always HTTP 200; errors ride the
   *  status trailer), so the router passes it straight through. */
  query(id: string, req: Request): Promise<Response>;
  /** Create graph `id` if absent. Idempotent. */
  create(id: string): Promise<void>;
  /** Element counts for graph `id`, creating it on demand (fresh = 0, 0). */
  info(id: string): Promise<GraphInfo>;
  /** Destroy graph `id` and all its storage. Idempotent — destroying an absent
   *  graph is a no-op, not an error. */
  destroy(id: string): Promise<void>;
}

/** Element counts for a store. Shared by both runtimes (Bun reads its own
 *  store; the Cloudflare DO runs it inside itself over `ctx.storage.sql`). */
export function graphInfo(store: GraphStore): GraphInfo {
  const v = store.query<{ c: number }>('SELECT count(*) AS c FROM nodes')[0].c;
  const e = store.query<{ c: number }>('SELECT count(*) AS c FROM edges')[0].c;
  return { vertexCount: v, edgeCount: e };
}
