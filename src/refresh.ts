// ---------- the post-write element refresh — gid mint / rev recompute ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md §5·1/§6·1. A compiled write lowers to set-based
// SQL with NO per-element JS seam — but a gid is a JS mint and a rev is a JS content-hash (SQLite has
// no hash UDF; the design is runtime-uniform). Concrete tracing showed a write cannot be woven into
// the read barrier's trampoline (it frames its OWN output, entangled with the effects' RETURNING
// bindings). So this is a POST-WRITE pass, run by `frameResolved` once the write's effects commit.
//
// It finds the touched elements by the UNIFORM DIRTY MARKER (`storage.ts`): a create is born `dirty`
// (DEFAULT 1) and a mutation sets it, so `WHERE dirty` is exactly the touched set — INDEX-SERVED by the
// partial index over the dirty rows, never a full scan (empty once refreshed). The flag is SEPARATE
// from the value, so it works for rev too: marking a row stale does not destroy the OLD rev the next
// rev chains from. Runs synchronously after the write commits and before anything interleaves (the
// write path is one synchronous span), so `WHERE dirty` sees exactly this write's rows.
//
// Per dirty row the sweep (re)computes the derived columns and clears the flag in ONE `updateSet`: gid
// is minted only when absent (immutable once set); rev is recomputed from the OLD rev + current
// content (chained, §5·1). Vertices are refreshed BEFORE edges, so an edge's endpoint gids are already
// minted when its rev (which references them, §6·5) is computed.

import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { computeRev, edgeContent, parseRev, vertexContent } from './rev.ts';
import { labelsForOwners, vertexPropsForOwners, edgePropsForOwners } from './formats/drain.ts';
import { updateSet, type SetColumn } from './setwrite.ts';

const GID: SetColumn = { name: 'gid', type: 'blob', blob: true };
const REV: SetColumn = { name: 'rev', type: 'blob', jsonb: true };
const DIRTY: SetColumn = { name: 'dirty', type: 'any' };
// [id, gid, rev, dirty=0] per refreshed row — `hex(NULL)` is '' not NULL in SQLite, so a gid-less row
// (empty string) routes to a mint via `||`; a real gid hex is 32 chars and never empty.

/** Refresh dirty vertices: mint gid where absent, recompute rev from label set + properties, clear
 *  dirty — all in one set-based statement. A no-op (one index-served read) when nothing is dirty. */
function refreshNodes(store: GraphStore): void {
  const rows = store.query<{ id: number; gid: string; rev: string | null }>(
    'SELECT id, hex(gid) AS gid, json(rev) AS rev FROM nodes WHERE dirty');
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const labels = labelsForOwners(store, ids);
  const props = vertexPropsForOwners(store, ids, true); // collection values as json() TEXT, so JSON.stringify is stable
  const updates = rows.map((r) => {
    const content = vertexContent((labels.get(r.id) ?? []).map((l) => l.name), props.get(r.id) ?? []);
    return [r.id, r.gid || mintGid(), computeRev(parseRev(r.rev), content), 0];
  });
  updateSet(store, 'nodes', 'id', [GID, REV, DIRTY], updates);
}

/** Refresh dirty edges: mint gid where absent, recompute rev from label + endpoint GIDS + properties,
 *  clear dirty. Runs AFTER `refreshNodes`, so both endpoint gids are already set. */
function refreshEdges(store: GraphStore): void {
  const rows = store.query<{ id: number; gid: string; rev: string | null; label: string; srcgid: string; tgtgid: string }>(
    `SELECT e.id AS id, hex(e.gid) AS gid, json(e.rev) AS rev, l.name AS label,
            hex(sv.gid) AS srcgid, hex(tv.gid) AS tgtgid
     FROM edges e JOIN labels l ON l.id = e.label
       JOIN nodes sv ON sv.id = e.src JOIN nodes tv ON tv.id = e.tgt
     WHERE e.dirty`);
  if (!rows.length) return;
  const props = edgePropsForOwners(store, rows.map((r) => r.id), true);
  const updates = rows.map((r) => {
    const content = edgeContent(r.label, r.srcgid, r.tgtgid, props.get(r.id) ?? []);
    return [r.id, r.gid || mintGid(), computeRev(parseRev(r.rev), content), 0];
  });
  updateSet(store, 'edges', 'id', [GID, REV, DIRTY], updates);
}

/** Refresh the replication metadata (gid + rev) of the elements a write just touched — called by
 *  `frameResolved` after a write program commits (`plan.kind === 'program'`). Vertices before edges,
 *  so an edge's rev sees its endpoints' minted gids. */
export function refreshElements(store: GraphStore): void {
  refreshNodes(store);
  refreshEdges(store);
}
