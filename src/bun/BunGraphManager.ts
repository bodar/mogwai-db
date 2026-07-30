import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GraphStore } from '../storage.ts';
import { LabelCardinality } from '../api.ts';
import { type GraphManager, type GraphInfo, graphInfo } from '../manager.ts';
import { Executor } from '../execute.ts';
import type { Executor as ExecutorApi } from '../api.ts';
import type { ServiceRegistry } from '../services/spi/types.ts';
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
  private graphs = new Map<string, { store: GraphStore; sql: BunSqlite }>();
  private readonly registry: ServiceRegistry;

  /**
   * `registry` is INJECTED (DI single-source, no default): the entry point decides — production
   * (bun/server.ts) injects the EXTENDED registry (federation on); the L3 conformance host injects
   * `standardRegistry` (reference-exact, no mogwai.* extensions). To change the registry you change
   * it at app construction, nowhere else. The federated service reaches sibling graphs through THIS
   * manager (the FederationSource), threaded to its apply at execution time — no manager↔registry
   * construction cycle, because executor(id) isn't CALLED until query time.
   */
  /** `labelCardinalityFor` declares a graph's VERTEX label cardinality at provisioning time,
   *  which is where TinkerPop puts it too (a provider's `Graph.Features`). Defaults to `ONE` —
   *  TinkerGraph's default and 3.x-compatible — so a graph is single-label unless something asks
   *  for otherwise. The conformance host uses it to serve `gmultilabel`/`gzoo` as ZERO_OR_MORE
   *  beside single-label reference graphs, which is exactly what the official runner expects. */
  constructor(
    private dir: string | undefined,
    registry: ServiceRegistry,
    private labelCardinalityFor: (id: string) => LabelCardinality = () => LabelCardinality.ONE,
  ) {
    if (dir) mkdirSync(dir, { recursive: true });
    this.registry = registry;
  }

  private fileFor(id: string): string {
    return join(this.dir!, `${encodeURIComponent(id)}.sqlite`);
  }

  /** Get the graph, opening/creating it on demand (mirrors DO-on-first-access). */
  private resolve(id: string) {
    let g = this.graphs.get(id);
    if (!g) {
      const sql = new BunSqlite(this.dir ? this.fileFor(id) : ':memory:');
      const store = new GraphStore(sql, this.labelCardinalityFor(id)); // ctor runs the schema DDL
      g = { store, sql };
      this.graphs.set(id, g);
    }
    return g;
  }

  /** The per-graph executor, bound to that graph's store + the registry + this manager as the
   *  federation source. Created on demand; a sibling federated call reaches this same method. */
  executor(id: string): ExecutorApi {
    return new Executor(this.resolve(id).store, this.registry, this);
  }

  async create(id: string): Promise<void> {
    this.resolve(id); // idempotent: opening runs the schema, materializing an empty graph
  }

  async info(id: string): Promise<GraphInfo> {
    return graphInfo(this.resolve(id).store);
  }

  async destroy(id: string): Promise<void> {
    // Idempotent teardown. Close any open handle, drop it from the registry, and
    // (dir mode) unlink the file even if it was never loaded this run — so a
    // graph persisted by an earlier run is still destroyable.
    const g = this.graphs.get(id);
    g?.sql.close();
    this.graphs.delete(id);
    if (this.dir) {
      // Remove the db and its WAL sidecars (journal_mode=WAL leaves -wal/-shm);
      // force so a never-created / already-gone file is a no-op, not an error.
      const file = this.fileFor(id);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    }
  }
}
