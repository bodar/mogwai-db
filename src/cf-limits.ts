// The CF-parity harness: Cloudflare's per-statement limits, made observable on Bun.
//
// Durable Object SQLite caps a query at **100 bound parameters** and **100 KB of statement text**
// (https://developers.cloudflare.com/durable-objects/platform/limits/). `bun:sqlite`'s bind cap is
// 65,535 and its text cap is far higher, so a bind list whose length scales with ROW COUNT passes
// every test here and fails only in production. Two shipped paths breached it when this was written
// (`g.V().drop()` and `landForeignElements`) — see docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md
// §1c/§1d — and nothing in the suite could see either, because the suite runs on Bun.
//
// So this is the instrument that converts a DO-only wall into a Bun-visible failure. It sits at the
// `Sql` seam rather than at `GraphStore.query`, so raw-SQL callers and the store's own statements
// are both covered, and it is a DECORATOR (`CfLimitedSql`) — the driver classes (BunSqlite, WasmSqlite)
// know nothing of it; the wrapper composes over any `Sql` where the assertion is wanted.
//
// It is wired at TWO deliberate places, never scattered through the drivers:
//   - explicitly, in a test that asserts one statement's shape (cf-limits.test.ts, bulk.test.ts);
//   - suite-wide-ish, at the L3 conformance host (conformance-server.ts): `MOGWAI_CF_LIMITS=1` wraps
//     THAT host's store factory, so the whole feature corpus is asserted DO-legal on Bun —
//     `mise run test:cf-limits`. L3 is the right seam because it runs the full corpus through the
//     compiler and never against a real DO; the CONTRACT's DO-legality is enforced natively by the real
//     DO in cloudflare.test.ts, and `mise run binds` catches the placeholder idiom statically.
import type { Sql } from './api.ts';

/** Cloudflare DO SQLite: maximum bound parameters in one query. */
export const CF_MAX_BINDS = 100;

/** Cloudflare DO SQLite: maximum length of a SQL statement, in BYTES (UTF-8). */
export const CF_MAX_SQL_BYTES = 100 * 1024;

/** UTF-8 is at most 3 bytes per UTF-16 code unit (a 4-byte codepoint costs two units), so a string
 *  shorter than this cannot possibly exceed the byte cap and needs no encode. */
const NO_ENCODE_BELOW = Math.floor(CF_MAX_SQL_BYTES / 3);

const encoder = new TextEncoder();

/** Exact UTF-8 byte length, encoding only when the cheap bound cannot settle it. */
function sqlBytes(sql: string): number {
  return sql.length < NO_ENCODE_BELOW ? sql.length : encoder.encode(sql).length;
}

/**
 * Would this statement be rejected by a Durable Object? Returns the violation message, or `null`
 * when the statement is DO-legal.
 *
 * The message names the limit, the actual figure and the statement, because the failure it reports
 * is always the same defect — a bind list that scales with row count — and the SQL prefix is what
 * identifies the site. Truncated, since the interesting statements are the huge ones.
 */
export function cfLimitViolation(sql: string, binds: readonly unknown[]): string | null {
  if (binds.length > CF_MAX_BINDS)
    return `statement exceeds Cloudflare's ${CF_MAX_BINDS}-bound-parameter limit: ${binds.length} binds in ${describe(sql)}`;
  const bytes = sqlBytes(sql);
  if (bytes > CF_MAX_SQL_BYTES)
    return `statement exceeds Cloudflare's ${CF_MAX_SQL_BYTES}-byte text limit: ${bytes} bytes in ${describe(sql)}`;
  return null;
}

const describe = (sql: string): string => (sql.length > 160 ? `${sql.slice(0, 160)}…` : sql);

/** Throw if `sql`/`binds` would be rejected on a Durable Object. */
export function assertCfLimits(sql: string, binds: readonly unknown[]): void {
  const violation = cfLimitViolation(sql, binds);
  if (violation) throw new Error(violation);
}

/** A `Sql` that rejects any statement a Durable Object would reject. Composes over any driver;
 *  `exec` carries no binds, so only its text is checked. */
export class CfLimitedSql implements Sql {
  constructor(private inner: Sql) {}

  exec(sql: string): void {
    assertCfLimits(sql, []);
    this.inner.exec(sql);
  }

  query<T = any>(sql: string, binds: readonly unknown[] = []): T[] {
    assertCfLimits(sql, binds);
    return this.inner.query<T>(sql, binds);
  }

  close(): void {
    this.inner.close?.();
  }
}
