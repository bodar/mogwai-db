// Cloudflare Durable Object SQLite's per-statement and per-value limits
// (https://developers.cloudflare.com/durable-objects/platform/limits/) — the ONE place the numbers live.
//
// Two kinds of reader, and the split is why this is its own module rather than part of the test decorator:
//   - the ASSERTION — `CfLimitedSql` (`src/cf-limits.ts`) makes Bun refuse what a DO refuses;
//   - a STRATEGY in shipping code — the one packer (`json-chunks.ts` `jsonChunks`, behind the json_each
//     builder and the executor's retained rows) splits a data-sized set into values a DO can hold.
// Importing ONE constant is what keeps the decorator and the producer from disagreeing about where the
// wall is. Shipping code may read these only as a strategy that stays correct if the platform moves the
// number (merely conservative), never as a refusal (`compiler/rel/spine.ts` `finishLowering` explains why).

/** Maximum bound parameters in one query. */
export const CF_MAX_BINDS = 100;

/** Maximum length of a SQL statement, in BYTES (UTF-8). */
export const CF_MAX_SQL_BYTES = 100 * 1024;

/** Maximum size of one string or BLOB VALUE, in bytes — the documented "maximum string, BLOB or table
 *  row size", 2 MB. The bind-count rule pushes every data-sized set into ONE `json_each(?)` value, so that
 *  value's SIZE is the wall a large set meets next. Measured on workerd (`wrangler dev`, 2026-11): a bind or
 *  a computed value of 2,200,000 bytes is accepted and one of 3,000,000 refused with `string or blob too
 *  big: SQLITE_TOOBIG`, so 2 MiB is at or under the real wall — the conservative side. */
export const CF_MAX_VALUE_BYTES = 2 * 1024 * 1024;

/** SQLite's own message for a value past its length limit, as `sqliteMessage` (`src/storage.ts`) normalizes
 *  it — the one spelling the decorator throws and the store recognizes. */
export const VALUE_TOO_BIG = 'string or blob too big';

/** SQLite's own message for a statement past its text-length limit (`SQLITE_LIMIT_SQL_LENGTH`, the cap behind
 *  a Durable Object's 100 KB — spelled `statement too long: SQLITE_TOOBIG` there, measured under `wrangler
 *  dev`), as `sqliteMessage` normalizes it: the spelling the decorator throws and the store declines. */
export const STATEMENT_TOO_LONG = 'statement too long';

/** Does `text` fit in `cap` UTF-8 bytes? Settled from the length alone when even 3 bytes per UTF-16 unit
 *  (the most any unit costs) fits — every small statement and value — and counted only otherwise. */
export const fitsUtf8 = (text: string, cap: number): boolean => text.length * 3 <= cap || utf8Bytes(text) <= cap;

/** Exact UTF-8 byte length of a JS string, without allocating an encoding. A lone surrogate counts as the
 *  3 bytes of the U+FFFD it is written as. */
export function utf8Bytes(text: string): number {
  let bytes = text.length;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) continue;
    if (unit < 0x800) { bytes += 1; continue; }
    // A high surrogate followed by a low one is ONE 4-byte code point over TWO units: +2 here, +0 for the low.
    if (unit >= 0xd800 && unit <= 0xdbff && at + 1 < text.length) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 2; at++; continue; }
    }
    bytes += 2;
  }
  return bytes;
}
