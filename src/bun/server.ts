import { application } from '../application.ts';
import { BunGraphManager } from './BunGraphManager.ts';

/** Bun entry point: build the multi-graph manager (in-memory by default, or a
 *  directory of files when `$MOGWAI_DB_DIR` is set), wire the shared router, and
 *  serve. Graphs are addressed by `/g/{id}` — the same management API as the
 *  Cloudflare Worker, just running locally over `bun:sqlite`. */
export function startServer(port = 8182, dir = process.env.MOGWAI_DB_DIR) {
  const manager = new BunGraphManager(dir);
  const app = application({ manager });
  return Bun.serve({ port, fetch: app.router });
}

if (import.meta.main) {
  const server = startServer();
  console.log(`mogwai-db listening on :${server.port} (graphs at /g/{id})`);
}
