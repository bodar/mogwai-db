// ---------- the post-write element refresh — gid mint / rev recompute ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md §5·1/§6·1. A compiled write (addV/addE/mergeV/
// mergeE/property/label) lowers to set-based SQL with NO per-element JS seam — but a gid is a JS mint
// and a rev is a JS content-hash (SQLite has no hash UDF; the design is runtime-uniform). Concrete
// tracing showed a write cannot be woven into the read barrier's trampoline (it frames its OWN output,
// entangled with the effects' RETURNING bindings, and the trampoline frames the FINAL segment). So the
// refresh is a POST-WRITE pass, run by `frameResolved` once the write's effects have committed.
//
// It finds the elements needing attention by the UNIFORM DIRTY MARKER (`storage.ts`): a create is born
// `dirty` (DEFAULT 1) and a mutation sets it, so `WHERE dirty` is exactly the touched set — and it is
// INDEX-SERVED by the partial index over the dirty rows, never a full scan (empty once refreshed). This
// is the explicit generalization of the old `gid IS NULL` marker; a flag SEPARATE from the value, so it
// works for rev too (increment 2) — marking a row stale does not destroy the OLD rev the next rev
// chains from. Runs synchronously after the write commits and before anything interleaves (the write
// path is one synchronous span), so `WHERE dirty` sees exactly this write's rows.
//
// Per dirty row the sweep (re)computes each derived column and clears the flag in ONE set-based
// `updateSet`: gid is minted only when absent (so it stays immutable — minted once, never re-touched);
// increment 2 adds the rev recompute alongside. The per-column computation differs (gid mints once, rev
// recomputes); the MARKER and the sweep are uniform.

import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { updateSet, type SetColumn } from './setwrite.ts';

const GID: SetColumn = { name: 'gid', type: 'blob', blob: true };
const DIRTY: SetColumn = { name: 'dirty', type: 'any' };

/** Refresh one table's dirty rows: mint a gid where absent (immutable once set), then clear `dirty`,
 *  in one set-based statement. A no-op — one index-served read, no write — when nothing is dirty. */
function refreshTable(store: GraphStore, table: 'nodes' | 'edges'): void {
  const rows = store.query<{ id: number; gid: string }>(`SELECT id, hex(gid) AS gid FROM ${table} WHERE dirty`);
  if (!rows.length) return;
  // [id, gid, dirty=0] per row — gid kept if already set (immutable), minted if absent. NB `hex(NULL)`
  // is the EMPTY STRING in SQLite, not NULL, so `||` (empty is falsy) is what routes a gid-less row to
  // a mint; a real gid hex is 32 chars and never empty.
  const updates = rows.map((r) => [r.id, r.gid || mintGid(), 0]);
  updateSet(store, table, 'id', [GID, DIRTY], updates);
}

/** Refresh the replication metadata of the elements a write just touched — called by `frameResolved`
 *  after a write program commits (`plan.kind === 'program'`). Today: mint gids for dirty vertices and
 *  edges and clear the flag. Increment 2 adds the rev recompute on the same sweep. */
export function refreshElements(store: GraphStore): void {
  refreshTable(store, 'nodes');
  refreshTable(store, 'edges');
}
