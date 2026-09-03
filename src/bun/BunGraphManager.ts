import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore, type Sql } from '../storage.ts';
import { type GraphManager, type GraphInfo, graphInfo, changesFeed, revsDiff } from '../manager.ts';
import { bulkGet, applyWire } from '../replicate.ts';
import type { ChangesFeed, RevsDiffRequest, RevsDiffResponse, BulkGetRef, WireChangeSet } from '../api.ts';
import { Executor } from '../execute.ts';
import type { Executor as ExecutorApi, Http } from '../api.ts';
import type { RegistryProvider } from '../scopes.ts';
import { NO_IO_STORE, type IoStore } from '../iostore.ts';
import type { FastPathConfig } from '../compiler/options/fast-paths.ts';
import { defaultHttp, remoteOrLocal } from '../http-federation.ts';
import { httpAwareIoStore } from '../http-io.ts';
import { BunSqlite } from './BunSqlite.ts';

/**
 * The Bun half of the graph-lifecycle seam: a local, dependency-free mirror of
 * the Cloudflare Durable Object model. One `bun:sqlite` database = one isolated
 * graph, keyed by the `/gremlin/{id}` path exactly as one DO = one graph keyed by
 * `idFromName`. Graphs spring into existence on first access (create-on-demand),
 * matching CF's provisioning: the manager never reports "not found", it just
 * builds an empty graph.
 *
 * The manager is BOTH the graph-lifecycle seam AND the executor factory (executor(id) →
 * a per-graph Executor). Being the executor factory makes it the federation source: a
 * sibling is just another graph THIS manager resolves by id, so the federated service
 * reaches other graphs through the very same executor(id) — no separate env type.
 *
 * Persistence: in-memory by default (each graph a `:memory:` db — ephemeral, fast, ideal
 * for dev/tests). If `dir` is set, each graph is a file `{dir}/{id}.sqlite` that survives
 * restarts. The id is percent-encoded into the filename so an arbitrary graph id can never
 * escape the directory.
 */
export class BunGraphManager implements GraphManager {
  private graphs = new Map<string, { store: GraphStore; sql: Sql }>();
  private readonly registry: RegistryProvider;

  /**
   * `registry` is INJECTED (DI single-source, no default): the entry point decides — production
   * (bun/server.ts) injects the EXTENDED registry (federation on); the L3 conformance host injects
   * `standardRegistry` (reference-exact, no mogwai.* extensions). To change the registry you change
   * it at app construction, nowhere else. It is a PROVIDER, not a registry: the federated service
   * takes THIS manager (the FederationSource) as a construction dependency off the executor's app
   * scope. Still no manager↔registry construction cycle — the provider runs on first use of the
   * scope entry, and executor(id) isn't CALLED until query time.
   */
  constructor(
    private dir: string | undefined,
    registry: RegistryProvider,
    /** The io namespace io() resolves against — one rooted directory, shared by every graph this
     *  manager owns (a document is addressed by path, not by graph). Omitted → io() fails closed
     *  naming the missing binding. */
    private readonly io?: IoStore,
    /** Override the ambient fast-path config for every graph this manager owns — the differential
     *  seam. Omitted in production. */
    private readonly fastPaths?: FastPathConfig,
    /** How a graph's synchronous `Sql` store is constructed from its `source` (`:memory:` or a file
     *  path). Defaults to `bun:sqlite` — this manager's lifecycle logic (map, create-on-demand,
     *  destroy) is storage-agnostic, so the SAME battle-tested manager backs the browser's WASM leaf
     *  by injecting a `WasmSqlite` factory (src/browser/WasmSqlite.ts), which is how that leaf earns
     *  full conformance coverage in-process. `dir` file persistence is a property of the default
     *  bun:sqlite factory; an injected memory-only factory ignores the path. */
    private readonly makeSql: (source: string) => Sql = (source) => new BunSqlite(source),
    /** The outbound HTTP transport a federated call to a remote-URI `graph` runs through
     *  (`docs/2026-09-02-…-plan.md` §8). Defaults to the platform's global `fetch`; a test injects a
     *  server's own router handler to run the hop in memory. Threaded to `HttpForeignExecutor` when
     *  `executor(id)` resolves a remote URI, unused for a local graph. */
    private readonly http: Http = defaultHttp,
  ) {
    if (dir) mkdirSync(dir, { recursive: true });
    this.registry = registry;
    // Make io() URL-aware: an http(s) path fetches a document over the same Http seam federation uses,
    // any other path uses the configured local store (fail-closed NO_IO_STORE when none was bound).
    this.ioStore = httpAwareIoStore(this.io ?? NO_IO_STORE, this.http);
  }

  private readonly ioStore: IoStore;

  private fileFor(id: string): string {
    return join(this.dir!, `${encodeURIComponent(id)}.sqlite`);
  }

  /** Get the graph, opening/creating it on demand (mirrors DO-on-first-access). */
  private resolve(id: string) {
    let g = this.graphs.get(id);
    if (!g) {
      const sql = this.makeSql(this.dir ? this.fileFor(id) : ':memory:');
      const store = new GraphStore(sql); // ctor runs the schema DDL
      g = { store, sql };
      this.graphs.set(id, g);
    }
    return g;
  }

  /** The per-graph executor, bound to that graph's store + the registry + this manager as the
   *  federation source. Created on demand; a sibling federated call reaches this same method. A
   *  fully-qualified `http(s)` URI id resolves to a remote peer over the injected `http` transport
   *  instead of a local graph (§8), so `federate` reaches an external graph through the same seam. */
  executor(id: string): ExecutorApi {
    return remoteOrLocal(id, this.http, () =>
      new Executor(this.resolve(id).store, this.registry, this, this.fastPaths, this.ioStore));
  }

  /**
   * This graph's store, created on demand — the seam a BULK LOAD lands through (`src/bulk.ts`,
   * `src/formats/*`), which by construction bypasses parse→compile→execute.
   *
   * Deliberately NOT on the `GraphManager` interface: a Cloudflare manager holds no local store (its
   * graphs are Durable Objects reached over RPC), so a store accessor there would be a lie. On a DO a
   * bulk load runs INSIDE the object, against its own `ctx.storage.sql`. So this is the local-runtime
   * form of a capability both runtimes have, not a Bun-only capability.
   */
  storeOf(id: string): GraphStore {
    return this.resolve(id).store;
  }

  async create(id: string): Promise<void> {
    this.resolve(id); // idempotent: opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    return graphInfo(this.resolve(id).store);
  }

  async changes(id: string, since: number): Promise<ChangesFeed> {
    return changesFeed(this.resolve(id).store, since);
  }

  async revsDiff(id: string, request: RevsDiffRequest): Promise<RevsDiffResponse> {
    return revsDiff(this.resolve(id).store, request);
  }

  async bulkGet(id: string, refs: readonly BulkGetRef[]): Promise<WireChangeSet> {
    return bulkGet(this.resolve(id).store, refs);
  }

  async bulkDocs(id: string, changes: WireChangeSet): Promise<void> {
    applyWire(this.resolve(id).store, changes);
  }

  async destroy(id: string): Promise<void> {
    // Idempotent teardown. Close any open handle, drop it from the registry, and
    // (dir mode) unlink the file even if it was never loaded this run — so a
    // graph persisted by an earlier run is still destroyable.
    const g = this.graphs.get(id);
    g?.sql.close?.();
    this.graphs.delete(id);
    if (this.dir) {
      // Remove the db and its WAL sidecars (journal_mode=WAL leaves -wal/-shm);
      // force so a never-created / already-gone file is a no-op, not an error.
      const file = this.fileFor(id);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    }
  }
}
