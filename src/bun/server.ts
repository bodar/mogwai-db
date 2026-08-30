import { application } from '../application.ts';
import { verboseLogger } from '../router.ts';
import { BunGraphManager } from './BunGraphManager.ts';
import { FileIoStore } from './FileIoStore.ts';
import { extendedRegistry } from '../services/standard.ts';

/** Bun entry point: build the multi-graph manager (in-memory by default, or a
 *  directory of files when `$MOGWAI_DB_DIR` is set), wire the shared router, and
 *  serve. Graphs are addressed by `/gremlin/{id}` — the same management API as the
 *  Cloudflare Worker, just running locally over `bun:sqlite`. The graph-path
 *  prefix can be overridden with `$MOGWAI_PATH_PREFIX` (defaults to `gremlin`). */
export function startServer(
  port = 8182,
  dir = Bun.env.MOGWAI_DB_DIR,
  pathPrefix = Bun.env.MOGWAI_PATH_PREFIX,
  /** The io namespace `io("…")` resolves against, rooted at this directory. The Bun twin of the
   *  Worker's optional `IO` R2 binding, and optional for the same reason: absent, io() fails closed
   *  naming what is missing rather than resolving a path against the process's cwd. */
  ioDir = Bun.env.MOGWAI_IO_DIR,
) {
  // Production injects the EXTENDED registry (federation on). The single place the registry
  // choice is made; the conformance host injects standardRegistry at its own construction.
  const manager = new BunGraphManager(dir, extendedRegistry, ioDir ? new FileIoStore(ioDir) : undefined);
  // Silent by default (router.ts `silentLogger` — a failure reaches the client on the wire, which
  // is its channel). `$MOGWAI_LOG=1` turns the one-line-per-query access log back on.
  const app = application({ manager, pathPrefix, log: Bun.env.MOGWAI_LOG ? verboseLogger : undefined });
  return Bun.serve({ port, fetch: app.router });
}

if (import.meta.main) {
  const server = startServer();
  const prefix = Bun.env.MOGWAI_PATH_PREFIX ?? 'gremlin';
  console.log(`mogwai-db listening on :${server.port} (graphs at /${prefix}/{id})`);
}
