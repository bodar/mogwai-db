import { application } from '../application.ts';
import { CloudflareGraphManager } from './cloudflare-graph-manager.ts';
import { GraphDatabase, type Env } from './graph-store-do.ts';

// The Durable Object class must be exported from the Worker's entry module so
// wrangler can bind it (the [[durable_objects]] class_name).
export { GraphDatabase };
export type { Env };

// Worker: wire the shared router over a Cloudflare-backed manager. The graph id
// comes from the path (`/gremlin/{g}`, prefix configurable via `env.PATH_PREFIX`) —
// never from body-parsing to route; the bare `/gremlin` endpoint's `g`-field
// fallback is the one exception, and only for a client that carries no path id.
// `POST` runs a gremlin query; `PUT`/`GET`/`DELETE` are the management API,
// identical to the Bun server.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = application({
      manager: new CloudflareGraphManager(env.GRAPH),
      pathPrefix: env.PATH_PREFIX,
    });
    return app.router(request);
  },
};
