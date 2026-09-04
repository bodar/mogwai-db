// ---------- uuid_v7 — global element identity (`gid`) ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md §6·1. A `gid` is a graph element's CROSS-PEER
// identity, minted once at creation and immutable — separate from the local sequential rowid (which
// stays the fast join key and never leaves the store). It is a uuid_v7 (RFC 9562), CouchDB's own
// `couch_uuids.erl` `v7_bin` layout: a 48-bit millisecond timestamp then version 7, 12 random bits,
// variant 2, and 62 random bits. The 74 random bits make it globally unique with NO instance prefix
// and NO coordination — two independent deployments collide only on the same millisecond AND the same
// 74-bit draw (never). The timestamp buys secondary-index locality, never uniqueness.
//
// PORTABLE + SYNC by construction: `crypto.getRandomValues` is a synchronous global on Bun, a
// Durable Object / Worker, and the browser (unlike `node:crypto`, absent in the browser, and
// `crypto.subtle`, which is async and cannot run in the synchronous write path). It mints raw bytes.
//
// The store column is a 16-byte BLOB (compact — 16 vs a 36-char string, which is double-digit GB at
// 10^8 elements against the DO's 10 GB ceiling, §6·5). But the JSON transport a set-based write/read
// crosses (json_each) cannot carry raw bytes, and `program.ts`'s `transportable()` fails closed on a
// non-JSON value. So JS works in HEX throughout — mint → hex, cross the wire as hex text, and SQL
// materializes the BLOB with `unhex()` on write and `hex()` on read. JS never handles the raw bytes.

/** Mint a fresh uuid_v7 as a 32-char lowercase hex string (the 16 bytes hex-encoded). This is the form
 *  everything in JS holds; the storage layer turns it into a 16-byte BLOB via `unhex()`. */
export function mintGid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // {unix_ts_ms:48} — big-endian, bytes 0..5.
  const ms = Date.now();
  // ms is < 2^48 until year 10889, so the high 16 bits fit a plain number; split to avoid bit-ops
  // past 2^31. floor(ms / 2^32) is the top 16 bits; ms % 2^32 the low 32.
  const hi = Math.floor(ms / 0x100000000); // top 16 bits of the 48
  const lo = ms >>> 0;                      // low 32 bits
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;

  // {ver:4} = 0111 in the high nibble of byte 6; the low nibble stays random (rand_a).
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  // {var:2} = 10 in the top two bits of byte 8; the rest stays random (rand_b).
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  return toHex(bytes);
}

const HEX = '0123456789abcdef';

/** 16 (or any) bytes → lowercase hex, no separators — the `hex()`/`unhex()` form SQLite round-trips. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}
