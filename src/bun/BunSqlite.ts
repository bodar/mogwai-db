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
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

const REVERSE_UNORDERED = env?.MOGWAI_REVERSE_UNORDERED === '1';

/**
 * The second suite-wide perturbation, and the same argument applies verbatim: `bun:sqlite` accepts
 * 65,535 binds where a Durable Object accepts 100, so a bind list that scales with ROW COUNT is
 * green here and broken in production. `MOGWAI_CF_LIMITS=1` makes every statement this driver runs
 * assert DO legality — `mise run test:cf-limits`. See src/cf-limits.ts.
 */
const CF_LIMITS = env?.MOGWAI_CF_LIMITS === '1';

/** `Sql` over `bun:sqlite` (dev / local runtime). Synchronous. */
export class BunSqlite implements Sql {
  private db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
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
}
