import { application } from '../application.ts';
import { allowlistedHttp } from '../http-allowlist.ts';
import { configFromWorkerEnv } from '../config.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';
import { GraphDatabase, type Env } from './graph-store-do.ts';
import { ReplicatorRegistryDO, CloudflareReplicatorRegistry } from './replicator-registry-do.ts';

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
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Build the shared config from `env` (a structured CONFIG object var, or the flat vars) — the same
    // shape the Bun server builds from flags/env. `federate("http://…")` at the edge runs through the
    // allowlisted transport (SSRF guard); empty allowlist ⇒ deny all.
    const config = configFromWorkerEnv(env);
    const app = application({
      manager: new CloudflareGraphManager(env.GRAPH, allowlistedHttp(config.httpAllowlist)),
      pathPrefix: config.pathPrefix,
      // The control-plane registry (§9·2) — the singleton DO, forwarded over RPC; serves `/_replicator`.
      registry: new CloudflareReplicatorRegistry(env.REPLICATOR),
    });
    return app.router(request);
  },
};
