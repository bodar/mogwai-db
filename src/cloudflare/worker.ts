import { DurableObject } from 'cloudflare:workers';
import { GraphStore } from '../storage.ts';
import { application } from '../application.ts';
import { type GraphManager, type GraphInfo, graphInfo } from '../manager.ts';
import { makeHandler } from '../handler.ts';
import { DurableObjectSqlite } from './DurableObjectSqlite.ts';

export interface Env {
  GRAPH: DurableObjectNamespace<GraphDatabase>;
}

/** One Durable Object = one isolated graph database. The DO owns a
 *  `ctx.storage.sql`-backed store; the request handler is the same
 *  runtime-agnostic one the Bun server uses. Lifecycle (create/info/destroy)
 *  is exposed as RPC the Worker's `GraphManager` calls — `destroy` uses
 *  `ctx.storage.deleteAll()`, the only way to fully remove a DO's storage
 *  (dropping tables leaves internal metadata behind). */
export class GraphDatabase extends DurableObject<Env> {
  private store: GraphStore;
  private handler: (req: Request) => Promise<Response>;
  // Set by destroy(): this warm instance's storage was wiped. CF doesn't evict
  // the instance synchronously, so if it's reused before eviction we must
  // restore the schema first (see ensureLive). Left false and abandoned, the
  // storage stays empty so the DO is GC-eligible and stops billing.
  private wiped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema DDL runs synchronously here (GraphStore ctor); no async init, so
    // no blockConcurrencyWhile needed — it completes before any fetch/RPC.
    this.store = new GraphStore(new DurableObjectSqlite(ctx.storage.sql));
    this.handler = makeHandler(this.store);
  }

  /** Restore the schema if this instance was wiped by a prior destroy() and is
   *  now being reused (CF kept it warm rather than evicting it). Recreates an
   *  empty graph on demand — the same semantics as Bun rebuilding a dropped
   *  store, and as a cold instance whose ctor reruns the DDL. */
  private ensureLive(): void {
    if (this.wiped) {
      this.store.initSchema();
      this.wiped = false;
    }
  }

  fetch(request: Request): Promise<Response> {
    this.ensureLive();
    return this.handler(request);
  }

  // ---- lifecycle RPC (called by CloudflareGraphManager) ----

  /** No-op beyond materializing the graph: constructing the DO already ran the
   *  schema DDL, so simply addressing it has created it. Present for symmetry. */
  create(): void {
    this.ensureLive();
  }

  info(): GraphInfo {
    this.ensureLive();
    return graphInfo(this.store);
  }

  /** Fully remove this graph's storage. `deleteAll()` is the only way to clear
   *  a DO to zero (and stop billing); a comp date >= 2026-02-24 also drops the
   *  alarm — we set none, so it's moot either way. Mark the instance wiped so a
   *  reuse before eviction restores the schema (ensureLive). */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.wiped = true;
  }
}

/** The Cloudflare half of the graph-lifecycle seam. The DO namespace *is* the
 *  registry: `getByName` maps a graph id to its DO. `query` forwards the request
 *  into the DO (which runs the shared handler); lifecycle verbs are DO RPC. */
class CloudflareGraphManager implements GraphManager {
  constructor(private ns: DurableObjectNamespace<GraphDatabase>) {}

  query(id: string, req: Request): Promise<Response> {
    return this.ns.getByName(id).fetch(req);
  }
  create(id: string): Promise<void> {
    return this.ns.getByName(id).create();
  }
  info(id: string): Promise<GraphInfo> {
    return this.ns.getByName(id).info();
  }
  destroy(id: string): Promise<void> {
    return this.ns.getByName(id).destroy();
  }
}

// Worker: wire the shared router over a Cloudflare-backed manager. Routing is
// on the URL path only (LOCKED design) — never body-parse to route. `POST`
// runs a gremlin query; `PUT`/`GET`/`DELETE` are the management API, identical
// to the Bun server.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = application({ manager: new CloudflareGraphManager(env.GRAPH) });
    return app.router(request);
  },
};
