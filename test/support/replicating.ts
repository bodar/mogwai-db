// Graphs with replication metadata ON from birth. A graph computes gid/rev/seq only once it first exposes
// identity (`src/refresh.ts` `exposeIdentity`), so a test of the metadata ITSELF — how a write mints,
// chains and sequences it — starts from a graph where it is already on.
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { BunGraphManager } from '../../src/bun/BunGraphManager.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { exposeIdentity } from '../../src/refresh.ts';

/** A `bun:sqlite` connection whose graph schema exists with replication metadata ON. */
const replicatingSql = (source: string): BunSqlite => {
  const sql = new BunSqlite(source);
  exposeIdentity(new GraphStore(sql), 0);
  return sql;
};

/** An in-memory store with replication metadata ON. */
export const replicatingStore = (): GraphStore => new GraphStore(replicatingSql(':memory:'));

/** A manager whose every graph has replication metadata ON. */
export const replicatingManager = (): BunGraphManager =>
  new BunGraphManager(undefined, standardRegistry, undefined, undefined, replicatingSql);
