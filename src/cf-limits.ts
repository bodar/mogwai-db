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
import { CF_MAX_BINDS, CF_MAX_SQL_BYTES, CF_MAX_VALUE_BYTES, fitsUtf8, STATEMENT_TOO_LONG, utf8Bytes, VALUE_TOO_BIG } from './do-limits.ts';

// The numbers live in `do-limits.ts`, shared with the json_each builder that splits a data-sized set
// under the value cap, so the assertion and the producer cannot disagree about where the wall is.
export { CF_MAX_BINDS, CF_MAX_SQL_BYTES, CF_MAX_VALUE_BYTES };

/** The violation, and the PLATFORM'S OWN SPELLING of it where a Durable Object reports it as SQLite's error —
 *  a VALUE past its size (`string or blob too big`) and a statement past its TEXT length (`statement too
 *  long`), each of which the store translates into the user's clear error. `null` for the bind COUNT: past
 *  100 binds is always a defect of ours (a bind list sized by row count), so it stays our diagnostic. */
interface Violation { readonly message: string; readonly platform: string | null }

function violation(sql: string, binds: readonly unknown[]): Violation | null {
  if (binds.length > CF_MAX_BINDS)
    return { platform: null, message: `statement exceeds Cloudflare's ${CF_MAX_BINDS}-bound-parameter limit: ${binds.length} binds in ${describe(sql)}` };
  if (!fitsUtf8(sql, CF_MAX_SQL_BYTES))
    return { platform: STATEMENT_TOO_LONG, message: `statement exceeds Cloudflare's ${CF_MAX_SQL_BYTES}-byte text limit: ${utf8Bytes(sql)} bytes in ${describe(sql)}` };
  for (const [at, bind] of binds.entries()) {
    const size = valueBytes(bind);
    if (size > CF_MAX_VALUE_BYTES)
      return { platform: VALUE_TOO_BIG, message: `bind ${at + 1} exceeds Cloudflare's ${CF_MAX_VALUE_BYTES}-byte value limit: ${size} bytes in ${describe(sql)}` };
  }
  return null;
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
  return violation(sql, binds)?.message ?? null;
}

/** A bind's stored size: a string's UTF-8 bytes (counted only when the 3-bytes-per-unit bound cannot settle
 *  it), a BLOB's length, and 0 for a number/null, which cannot approach the cap. */
function valueBytes(bind: unknown): number {
  if (typeof bind === 'string') return fitsUtf8(bind, CF_MAX_VALUE_BYTES) ? 0 : utf8Bytes(bind);
  if (bind instanceof Uint8Array || bind instanceof ArrayBuffer) return bind.byteLength;
  return 0;
}

const describe = (sql: string): string => (sql.length > 160 ? `${sql.slice(0, 160)}…` : sql);

/**
 * Throw if `sql`/`binds` would be rejected on a Durable Object.
 *
 * A bind past the VALUE cap, and a statement past the TEXT cap, throw the way the DO itself does — SQLite's
 * `string or blob too big` / `statement too long`, with the decorator's diagnostic as the `cause` — because
 * neither is a bind-list defect of ours: one is a value the platform cannot hold, the other a statement as
 * long as the query text made it (a bulk upsert written as literal maps), and the store translates each into
 * the user's clear error (`GraphStore.query`) exactly as it does in production. Thrown as our own diagnostic,
 * the text cap reached the user as a bare `Error` under this decorator and as a decline in production — the
 * test harness disagreeing with the platform it stands in for. The data-sized sets we produce are split under
 * the value cap (`jsonChunks`, `src/json-chunks.ts` — at compile time, and at run time for retained rows), so
 * what still reaches it is a single member past 2 MB.
 * NOT modelled: a value SQLite COMPUTES past the cap (a `json_group_array` over a large fold) —
 * the DO refuses that too (measured), but only the real platform can see it.
 */
export function assertCfLimits(sql: string, binds: readonly unknown[]): void {
  const found = violation(sql, binds);
  if (!found) return;
  if (found.platform) throw new Error(`${found.platform}: SQLITE_TOOBIG`, { cause: new Error(found.message) });
  throw new Error(found.message);
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

  atomically<T>(fn: () => T): T {
    return this.inner.atomically ? this.inner.atomically(fn) : fn();
  }
}
