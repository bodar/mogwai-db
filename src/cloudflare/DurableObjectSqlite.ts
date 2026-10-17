import type { Sql } from '../storage.ts';

/** `Sql` over a Durable Object's `ctx.storage.sql` (production runtime).
 *  `SqlStorage.exec` is synchronous and takes variadic positional bindings;
 *  its cursor's `.toArray()` gives us the rows. `transact` is the DO's own atomic unit,
 *  `ctx.storage.transactionSync` — `sql.exec` refuses `BEGIN`/`SAVEPOINT`, so there is no other. */
export class DurableObjectSqlite implements Sql {
  constructor(private sql: SqlStorage, private transact?: <T>(fn: () => T) => T) {}

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    return this.sql.exec(sql, ...(binds as unknown[])).toArray() as T[];
  }

  atomically<T>(fn: () => T): T {
    return this.transact ? this.transact(fn) : fn();
  }
}
