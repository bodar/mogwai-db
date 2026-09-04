import { application } from '../application.ts';
import { allowlistedHttp } from '../http-allowlist.ts';
import { configFromWorkerEnv } from '../config.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';
import { GraphDatabase, type Env } from './graph-store-do.ts';
import { ReplicatorRegistryDO, CloudflareReplicatorRegistry } from './replicator-registry-do.ts';
import { runDueReplications, type SchedulerDeps } from '../scheduler.ts';
import { peerForRef, validateReplicationFilter } from '../replicate.ts';

// Both Durable Object classes must be exported from the Worker's entry module so
// wrangler can bind them (the durable_objects class_name entries).
export { GraphDatabase, ReplicatorRegistryDO };
export type { Env };

// Worker: wire the shared router over a Cloudflare-backed manager. The graph id
// comes from the path (`/gremlin/{g}`, prefix configurable via `env.PATH_PREFIX`) —
// never from body-parsing to route; the bare `/gremlin` endpoint's `g`-field
// fallback is the one exception, and only for a client that carries no path id.
// `POST` runs a gremlin query; `PUT`/`GET`/`DELETE` are the management API,
// identical to the Bun server.
/** The scheduler dependencies for this Worker invocation — the manager (graph DOs over RPC), the singleton
 *  registry DO, and the allowlisted outbound http (SSRF guard) the runner's remote peers use. Built per
 *  invocation, exactly as the fetch handler builds its app. The runner is WORKER-residency (§9): it drives
 *  replication from here, so the graph DOs are only ever clients answering peer RPCs. */
function schedulerDeps(env: Env): SchedulerDeps {
  const http = allowlistedHttp(configFromWorkerEnv(env).httpAllowlist);
  return { registry: new CloudflareReplicatorRegistry(env.REPLICATOR), manager: new CloudflareGraphManager(env.GRAPH, http), http };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Build the shared config from `env` (a structured CONFIG object var, or the flat vars) — the same
    // shape the Bun server builds from flags/env. `federate("http://…")` at the edge runs through the
    // allowlisted transport (SSRF guard); empty allowlist ⇒ deny all.
    const config = configFromWorkerEnv(env);
    const http = allowlistedHttp(config.httpAllowlist);
    const manager = new CloudflareGraphManager(env.GRAPH, http);
    const app = application({
      manager,
      pathPrefix: config.pathPrefix,
      // The control-plane registry (§9·2) — the singleton DO, forwarded over RPC; serves `/_replicator`.
      registry: new CloudflareReplicatorRegistry(env.REPLICATOR),
      // `POST /_scheduler/run` fires one tick at worker residency (the Cron Trigger does it on a schedule).
      runTick: () => runDueReplications(schedulerDeps(env)),
      // Save-time filter validation (filtered-replication-plan §2): trial-run against the source peer.
      validateFilter: (source, filter) => validateReplicationFilter(peerForRef(manager, http, source), filter),
    });
    return app.router(request);
  },

  /** The Cron Trigger handler (§9): a periodic wake that runs the due replication jobs at WORKER residency
   *  — the mogwai analog of CouchDB's scheduler, and why replication is NOT a DO alarm (which would occupy a
   *  graph DO's one slot). Configured by `[triggers] crons` in wrangler.jsonc. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runDueReplications(schedulerDeps(env));
  },
};
