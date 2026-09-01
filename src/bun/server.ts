import { parseArgs } from 'node:util';
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
  // CLI flags, each falling back to its env var then the built-in default (so the Docker image can set
  // MOGWAI_DB_DIR=/data and a bare-binary user can pass --data-dir). Bun provides node:util parseArgs.
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      'io-dir': { type: 'string' },
      'path-prefix': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      [
        'mogwai-db — a TinkerPop 4 Gremlin server on SQLite',
        '',
        'Flags (each falls back to the env var in parens, then the default):',
        '  --port <n>          listen port (MOGWAI_PORT, 8182)',
        '  --data-dir <dir>    where per-graph SQLite files live (MOGWAI_DB_DIR; in-memory if unset)',
        '  --io-dir <dir>      where io() reads/writes whole-graph documents (MOGWAI_IO_DIR; io() off if unset)',
        '  --path-prefix <p>   graph path prefix (MOGWAI_PATH_PREFIX, "gremlin")',
        '  -h, --help          this help',
      ].join('\n'),
    );
    process.exit(0);
  }
  const portArg = values.port ?? Bun.env.MOGWAI_PORT;
  // Pass `undefined` when a flag is absent so startServer's own env/default handling applies.
  const server = startServer(portArg ? Number(portArg) : undefined, values['data-dir'], values['path-prefix'], values['io-dir']);
  const prefix = values['path-prefix'] ?? Bun.env.MOGWAI_PATH_PREFIX ?? 'gremlin';
  console.log(`mogwai-db listening on :${server.port} (graphs at /${prefix}/{id})`);
}
