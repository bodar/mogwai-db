import { mkdirSync, rmSync } from 'node:fs';
import { type TypeNode } from '../gremlin-types.ts';
import { join } from 'node:path';
import { GraphStore } from '../storage.ts';
import { type GraphManager, type GraphInfo, graphInfo } from '../manager.ts';
import { executeFramed, type Framed } from '../execute.ts';
import { standardRegistry } from '../services/standard.ts';
import type { ServiceRegistry } from '../services/types.ts';
import { BunSqlite } from './BunSqlite.ts';

/**
 * The Bun half of the graph-lifecycle seam: a local, dependency-free mirror of
 * the Cloudflare Durable Object model. One `bun:sqlite` database = one isolated
 * graph, keyed by the `/gremlin/{id}` path exactly as one DO = one graph keyed by
 * `idFromName`. Graphs spring into existence on first access (create-on-demand),
 * matching CF's provisioning: the registry never reports "not found", it just
 * builds an empty graph.
 *
 * Persistence: in-memory by default (each graph a `:memory:` db — ephemeral,
 * fast, ideal for dev/tests). If `dir` is set, each graph is a file
 * `{dir}/{id}.sqlite` that survives restarts — the closest local analogue to a
 * DO's durable storage. The id is percent-encoded into the filename so an
 * arbitrary graph id (CF accepts any name) can never escape the directory.
 */
export class BunGraphManager implements GraphManager {
  private graphs = new Map<string, { store: GraphStore; sql: BunSqlite }>();

  constructor(private dir?: string, private registry: ServiceRegistry = standardRegistry) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private fileFor(id: string): string {
    return join(this.dir!, `${encodeURIComponent(id)}.sqlite`);
  }

  /** Get the graph, opening/creating it on demand (mirrors DO-on-first-access). */
  private resolve(id: string) {
    let g = this.graphs.get(id);
    if (!g) {
      const sql = new BunSqlite(this.dir ? this.fileFor(id) : ':memory:');
      const store = new GraphStore(sql); // ctor runs the schema DDL
      g = { store, sql };
      this.graphs.set(id, g);
    }
    return g;
  }

  async query(id: string, gremlin: string, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Promise<Framed[]> {
    return executeFramed(this.resolve(id).store, gremlin, params, paramTypes, this.registry);
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
