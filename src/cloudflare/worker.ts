import { DurableObject } from 'cloudflare:workers';
import { GraphStore } from '../storage.js';
import { application } from '../application.js';
import { DurableObjectSqlite } from './DurableObjectSqlite.js';

export interface Env {
  GRAPH: DurableObjectNamespace<GraphDatabase>;
}

/** One Durable Object = one isolated graph database. The DO owns a
 *  `ctx.storage.sql`-backed store; the request handler is the same
 *  runtime-agnostic one the Bun server uses. */
export class GraphDatabase extends DurableObject<Env> {
  private handler: (req: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema DDL runs synchronously here (GraphStore ctor); no async init, so
    // no blockConcurrencyWhile needed — it completes before any fetch.
    const store = new GraphStore(new DurableObjectSqlite(ctx.storage.sql));
    this.handler = application({ store }).handler;
  }

  fetch(request: Request): Promise<Response> {
    return this.handler(request);
  }
}

// Worker router (LOCKED design): POST /g/{graphId} → idFromName → DO. The
// graph springs into existence on first request. We route on the URL only —
// never body-parse to route.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const match = pathname.match(/^\/g\/([^/]+)\/?$/);
    if (!match) return new Response('Not found', { status: 404 });
    const stub = env.GRAPH.getByName(match[1]);
    return stub.fetch(request);
  },
};
