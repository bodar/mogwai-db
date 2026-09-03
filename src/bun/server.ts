import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { application } from '../application.ts';
import { verboseLogger } from '../router.ts';
import { allowlistedHttp } from '../http-allowlist.ts';
import { configFromBun, type MogwaiConfig } from '../config.ts';
import { BunGraphManager } from './BunGraphManager.ts';
import { BunSqlite } from './BunSqlite.ts';
import { FileIoStore } from './FileIoStore.ts';
import { ReplicatorStore, storeRegistry } from '../replicator-registry.ts';
import { extendedRegistry } from '../services/standard.ts';

/** Bun entry point: build the multi-graph manager (in-memory by default, or a
 *  directory of files when `dataDir` is set), wire the shared router, and serve.
 *  Graphs are addressed by `/gremlin/{id}` — the same management API as the
 *  Cloudflare Worker, just running locally over `bun:sqlite`. Takes a
 *  {@link MogwaiConfig} — the ONE config shape both runtimes share (the CLI
 *  block below builds it from flags/env via `configFromBun`; a Worker builds the
 *  same shape from its `env`). `httpAllowlist` confines io()/federate outbound
 *  fetches (empty ⇒ deny all — the SSRF guard). */
export function startServer(config: Partial<MogwaiConfig> = {}) {
  const { port = 8182, dataDir, ioDir, pathPrefix, log, httpAllowlist = [] } = config;
  // Production injects the EXTENDED registry (federation on). The single place the registry
  // choice is made; the conformance host injects standardRegistry at its own construction.
  // The outbound Http seam is allowlisted (SSRF guard) — the one seam io() and federate share.
  const manager = new BunGraphManager(
    dataDir,
    extendedRegistry,
    ioDir ? new FileIoStore(ioDir) : undefined,
    undefined, // fastPaths (default)
    undefined, // makeSql (default bun:sqlite)
    allowlistedHttp(httpAllowlist),
  );
  // The replicator control-plane store (§9) — a SINGLETON, separate from any graph. Persisted under a
  // `_control/` subdirectory when `dataDir` is set (a subdir can never collide with a graph file
  // `{dir}/{id}.sqlite`, since an id encodes its `/` away), else in-memory. Serves `/_replicator` CRUD.
  let registrySql;
  if (dataDir) {
    const controlDir = join(dataDir, '_control');
    mkdirSync(controlDir, { recursive: true });
    registrySql = new BunSqlite(join(controlDir, 'replicator.sqlite'));
  } else {
    registrySql = new BunSqlite(':memory:');
  }
  const registry = storeRegistry(new ReplicatorStore(registrySql));
  // Silent by default (router.ts `silentLogger` — a failure reaches the client on the wire, which
  // is its channel). `log` (from `$MOGWAI_LOG`) turns the one-line-per-query access log back on.
  const app = application({ manager, pathPrefix, log: log ? verboseLogger : undefined, registry });
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
      'allow-host': { type: 'string', multiple: true },
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
        '  --allow-host <h>    permit io()/federate to fetch this host (repeatable; MOGWAI_HTTP_ALLOWLIST,',
        '                      comma-separated). NONE set ⇒ outbound HTTP is DISABLED (deny all).',
        '  -h, --help          this help',
      ].join('\n'),
    );
    process.exit(0);
  }
  // Assemble the one shared config shape from flags → env → defaults, then start.
  const config = configFromBun(
    {
      port: values.port,
      dataDir: values['data-dir'],
      ioDir: values['io-dir'],
      pathPrefix: values['path-prefix'],
      allowHost: values['allow-host'],
    },
    Bun.env,
  );
  const server = startServer(config);
  console.log(`mogwai-db listening on :${server.port} (graphs at /${config.pathPrefix ?? 'gremlin'}/{id})`);
}
