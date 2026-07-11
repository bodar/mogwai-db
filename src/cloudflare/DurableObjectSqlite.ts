import type { Sql } from '../storage.ts';

/** `Sql` over a Durable Object's `ctx.storage.sql` (production runtime).
 *  `SqlStorage.exec` is synchronous and takes variadic positional bindings;
 *  its cursor's `.toArray()` gives us the rows. */
export class DurableObjectSqlite implements Sql {
  constructor(private sql: SqlStorage) {}

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    return this.sql.exec(sql, ...(binds as unknown[])).toArray() as T[];
  }
}
