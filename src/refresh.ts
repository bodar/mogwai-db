// ---------- the post-write element refresh — gid mint / rev recompute ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md §5·1/§6·1. A compiled write (addV/addE/mergeV/
// mergeE/property/label) lowers to set-based SQL with NO per-element JS seam — but a gid is a JS mint
// and a rev is a JS content-hash (SQLite has no hash UDF; the design is runtime-uniform). Concrete
// tracing showed a write cannot be woven into the read barrier's trampoline (it frames its OWN output,
// entangled with the effects' RETURNING bindings, and the trampoline frames the FINAL segment). So the
// refresh is a POST-WRITE pass, run by `frameResolved` once the write's effects have committed.
//
// It finds the elements needing attention by the NATURAL NULL MARKER — a created element leaves `gid`
// (and, from increment 2, `rev`) null, so `WHERE gid IS NULL` is exactly the just-created set, and it
// is INDEX-SERVED (the UNIQUE index over the nullable `gid` column stores the nulls), never a full
// scan. No write-algebra surgery, no touched-id accumulation: the store's own null columns are the
// touched-set. Runs synchronously after the write commits and before anything interleaves (the write
// path is one synchronous span), so `gid IS NULL` sees exactly this write's new rows.

import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { updateSet } from './setwrite.ts';

/** Mint a gid for every gid-less row of `table` (the just-created elements), writing them back in one
 *  set-based statement. A no-op — one index-served read, no write — when nothing is gid-less. */
function mintMissingGids(store: GraphStore, table: 'nodes' | 'edges'): void {
  const ids = store.query<{ id: number }>(`SELECT id FROM ${table} WHERE gid IS NULL`).map((r) => r.id);
  if (!ids.length) return;
  updateSet(store, table, 'id', [{ name: 'gid', type: 'blob', blob: true }], ids.map((id) => [id, mintGid()]));
}

/** Refresh the replication metadata of the elements a write just touched — called by `frameResolved`
 *  after a write program commits (`plan.kind === 'program'`). Today: mint gids for gid-less vertices
 *  and edges. Increment 2 adds the rev recompute for rev-null elements here, keyed the same way. */
export function refreshElements(store: GraphStore): void {
  mintMissingGids(store, 'nodes');
  mintMissingGids(store, 'edges');
}
