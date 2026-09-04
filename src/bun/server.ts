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
import { runDueReplications, startPollingScheduler, type SchedulerDeps } from '../scheduler.ts';
import { peerForRef, validateReplicationFilter } from '../replicate.ts';
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
  const { port = 8182, dataDir, ioDir, pathPrefix, log, httpAllowlist = [], schedulerIntervalMs } = config;
  // Production injects the EXTENDED registry (federation on). The single place the registry
  // choice is made; the conformance host injects standardRegistry at its own construction.
  // The outbound Http seam is allowlisted (SSRF guard) — the one seam io(), federate, and the
  // replication scheduler's remote peers all share.
  const http = allowlistedHttp(httpAllowlist);
  const manager = new BunGraphManager(
    dataDir,
    extendedRegistry,
    ioDir ? new FileIoStore(ioDir) : undefined,
    undefined, // fastPaths (default)
    undefined, // makeSql (default bun:sqlite)
    http,
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
  // The worker-residency replication scheduler (§9): `runTick` backs `POST /_scheduler/run`, and when a
  // poll interval is configured a background `setInterval` drives it too (continuous replication). The
  // graph DOs/stores stay pure data-plane clients — the runner orchestrates from here.
  const schedulerDeps: SchedulerDeps = { registry, manager, http };
  const runTick = () => runDueReplications(schedulerDeps);
  // Save-time filter validation (filtered-replication-plan §2): trial-run a config's filter against its
  // source peer (local via the manager, remote via the allowlisted http) — built here where both live.
  const validateFilter = (source: string, filter: string) => validateReplicationFilter(peerForRef(manager, http, source), filter);
  const stopScheduler = schedulerIntervalMs && schedulerIntervalMs > 0
    ? startPollingScheduler(schedulerDeps, schedulerIntervalMs)
    : undefined;
  // Silent by default (router.ts `silentLogger` — a failure reaches the client on the wire, which
  // is its channel). `log` (from `$MOGWAI_LOG`) turns the one-line-per-query access log back on.
  const app = application({ manager, pathPrefix, log: log ? verboseLogger : undefined, registry, runTick, validateFilter });
  const server = Bun.serve({ port, fetch: app.router });
  // Stop the background scheduler when the server is stopped, so a test (or a graceful shutdown) leaks no
  // timer. Wrap `stop` rather than changing the return type, so existing callers are unaffected.
  if (stopScheduler) {
    const originalStop = server.stop.bind(server);
    server.stop = (closeActiveConnections?: boolean) => { stopScheduler(); return originalStop(closeActiveConnections); };
  }
  return server;
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
