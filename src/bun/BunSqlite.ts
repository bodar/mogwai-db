import { Database } from 'bun:sqlite';
import type { Sql } from '../storage.ts';

/** `Sql` over `bun:sqlite` (dev / local runtime). Synchronous. */
export class BunSqlite implements Sql {
  private db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    // db.query caches the prepared statement by SQL text.
    return this.db.query(sql).all(...(binds as any[])) as T[];
  }
}
