import { Database } from 'bun:sqlite';
import type { Sql } from '../storage.ts';
import { assertCfLimits } from '../cf-limits.ts';

/**
 * A row order NOT fixed by an `ORDER BY` is SQLite's to choose, and on a small fixture it reliably
 * chooses the one that looks right — which is how a result that is only INCIDENTALLY deterministic
 * passes an ordered assertion. `PRAGMA reverse_unordered_selects` is SQLite's own switch for
 * exactly this: it reverses every scan whose order the query did not constrain, and leaves an
 * `ORDER BY` alone. So a test that passes under BOTH settings is pinned by the SQL; one that only
 * passes under the default is pinned by luck.
 *
 * Set `MOGWAI_REVERSE_UNORDERED=1` to run any suite the perturbed way — `mise run test:perturbed`.
 * It is an ENV switch rather than a constructor argument on purpose: the value is in flipping it
 * for a WHOLE suite that has no idea it is being perturbed, and a parameter would need threading
 * through every store construction in `test/`, which is precisely the code a perturbation must not
 * get to influence. The census's one-off planner probe (docs, 2026-07-28) is the precedent; this
 * is that probe made permanent and reachable.
 */
const REVERSE_UNORDERED = Bun.env.MOGWAI_REVERSE_UNORDERED === '1';

/**
 * The second suite-wide perturbation, and the same argument applies verbatim: `bun:sqlite` accepts
 * 65,535 binds where a Durable Object accepts 100, so a bind list that scales with ROW COUNT is
 * green here and broken in production. `MOGWAI_CF_LIMITS=1` makes every statement this driver runs
 * assert DO legality — `mise run test:cf-limits`. See src/cf-limits.ts.
 */
const CF_LIMITS = Bun.env.MOGWAI_CF_LIMITS === '1';

/** `Sql` over `bun:sqlite` (dev / local runtime). Synchronous. */
export class BunSqlite implements Sql {
  private db: Database;

  constructor(source: string | Database = ':memory:') {
    const fresh = typeof source === 'string';
    this.db = fresh ? new Database(source) : source;
    // WAL is a no-op on :memory:, and re-issuing it on a `deserialize`d handle is pointless — only a
    // path-backed database ever benefits. The unordered perturbation IS a live connection pragma, so
    // it applies to a snapshot-restored store too (else `test:perturbed` would skip the seeded graph).
    if (fresh) this.db.exec('PRAGMA journal_mode = WAL');
    if (REVERSE_UNORDERED) this.db.exec('PRAGMA reverse_unordered_selects = ON');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    if (CF_LIMITS) assertCfLimits(sql, binds);
    // db.query caches the prepared statement by SQL text.
    return this.db.query(sql).all(...(binds as any[])) as T[];
  }

  close(): void {
    this.db.close();
  }

  /** Snapshot the whole database to a portable byte buffer (bun:sqlite `serialize`). BunSqlite-ONLY
   *  and deliberately NOT on the shared `Sql` interface: the DO runtime (`ctx.storage.sql`) has no
   *  such primitive, and the one caller is the test seed template (test/support/graph.ts). Building
   *  the modern reference graph re-compiles ~12 write traversals through the whole antlr→IR→SQL
   *  pipeline (~89ms), and that was paid once PER read traversal across L5 and the census. */
  serialize(): Uint8Array {
    return this.db.serialize();
  }

  /** Reconstruct a WRITABLE store from a `serialize()` snapshot — an independent in-memory database
   *  with the snapshot's schema+data already present, in ~0.03ms (bun:sqlite `Database.deserialize`;
   *  the `false` is `readonly=false`, since a write traversal mutates its own fresh copy). */
  static fromSnapshot(bytes: Uint8Array): BunSqlite {
    return new BunSqlite(Database.deserialize(bytes, false));
  }
}
