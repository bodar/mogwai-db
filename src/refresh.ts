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
// The `dirty` value is a small enum saying HOW to recompute (`storage.ts`): 1 = a fresh CREATE (rev
// null → `{gen:1, hash}`), 2 = a MUTATION (chain gen+1 off the old rev), 3 = PRESERVE (a bulk-loaded or
// replicated rev kept verbatim — seq+gid only). Per dirty row the sweep computes the derived columns and
// clears the flag in ONE `updateSet`: gid is minted only when absent (immutable once set); `rev` is
// chained from the OLD rev + current content for 1/2 and left ALONE for 3; `seq` is a fresh LOCAL value
// from `nextSeqBlock` for EVERY dirty row (§5·2 — even a preserved-rev row takes a new local cursor, as
// it is a local write event). A PRESERVE row needs no content, so only 1/2 rows read labels/properties.
// Vertices are refreshed BEFORE edges, so an edge's endpoint gids are already minted when its rev (which
// references them, §6·5) is computed, and a write's node seqs precede its edge seqs (§6·2 order).

import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { computeRev, edgeContent, parseRev, vertexContent, type Rev } from './rev.ts';
import { labelsForOwners, vertexPropsForOwners, edgePropsForOwners } from './formats/drain.ts';
import { updateSet, type SetColumn } from './setwrite.ts';

const GID: SetColumn = { name: 'gid', type: 'blob', blob: true };
const REV: SetColumn = { name: 'rev', type: 'blob', jsonb: true };
const SEQ: SetColumn = { name: 'seq', type: 'any' };
const DIRTY: SetColumn = { name: 'dirty', type: 'any' };
// [id, gid, rev, seq, dirty=0] per refreshed row — `hex(NULL)` is '' not NULL in SQLite, so a gid-less
// row (empty string) routes to a mint via `||`; a real gid hex is 32 chars and never empty.

/** The next rev for a dirty row: a PRESERVE (dirty 3) keeps its existing rev verbatim; a CREATE (rev
 *  null) computes `{gen:1, …}`; a MUTATION (rev present) chains gen+1 — the last two are exactly
 *  `computeRev(parent, content)`, so only PRESERVE is special-cased. */
const nextRev = (dirty: number, rev: string | null, content: string): Rev =>
  dirty === PRESERVE ? parseRev(rev)! : computeRev(parseRev(rev), content);
const PRESERVE = 3;

/** Refresh dirty vertices: mint gid where absent, (re)compute or keep rev per the dirty enum, assign a
 *  fresh local seq, clear dirty — all in one set-based statement. A no-op (one index-served read) when
 *  nothing is dirty. Only rows that need a rev (dirty 1/2) read labels/properties. */
function refreshNodes(store: GraphStore): void {
  const rows = store.query<{ id: number; gid: string; rev: string | null; dirty: number }>(
    'SELECT id, hex(gid) AS gid, json(rev) AS rev, dirty FROM nodes WHERE dirty');
  if (!rows.length) return;
  const contentIds = rows.filter((r) => r.dirty !== PRESERVE).map((r) => r.id);
  const labels = labelsForOwners(store, contentIds);
  const props = vertexPropsForOwners(store, contentIds, true); // collection values as json() TEXT, so JSON.stringify is stable
  const base = store.nextSeqBlock(rows.length);
  const updates = rows.map((r, i) => {
    const content = r.dirty === PRESERVE ? '' : vertexContent((labels.get(r.id) ?? []).map((l) => l.name), props.get(r.id) ?? []);
    return [r.id, r.gid || mintGid(), nextRev(r.dirty, r.rev, content), base + i + 1, 0];
  });
  updateSet(store, 'nodes', 'id', [GID, REV, SEQ, DIRTY], updates);
}

/** Refresh dirty edges: mint gid where absent, (re)compute or keep rev, assign a fresh local seq, clear
 *  dirty. Runs AFTER `refreshNodes`, so both endpoint gids are set and edge seqs follow node seqs. */
function refreshEdges(store: GraphStore): void {
  const rows = store.query<{ id: number; gid: string; rev: string | null; dirty: number; label: string; srcgid: string; tgtgid: string }>(
    `SELECT e.id AS id, hex(e.gid) AS gid, json(e.rev) AS rev, e.dirty AS dirty, l.name AS label,
            hex(sv.gid) AS srcgid, hex(tv.gid) AS tgtgid
     FROM edges e JOIN labels l ON l.id = e.label
       JOIN nodes sv ON sv.id = e.src JOIN nodes tv ON tv.id = e.tgt
     WHERE e.dirty`);
  if (!rows.length) return;
  const props = edgePropsForOwners(store, rows.filter((r) => r.dirty !== PRESERVE).map((r) => r.id), true);
  const base = store.nextSeqBlock(rows.length);
  const updates = rows.map((r, i) => {
    const content = r.dirty === PRESERVE ? '' : edgeContent(r.label, r.srcgid, r.tgtgid, props.get(r.id) ?? []);
    return [r.id, r.gid || mintGid(), nextRev(r.dirty, r.rev, content), base + i + 1, 0];
  });
  updateSet(store, 'edges', 'id', [GID, REV, SEQ, DIRTY], updates);
}

/** Refresh the replication metadata (gid + rev) of the elements a write just touched — called by
 *  `frameResolved` after a write program commits (`plan.kind === 'program'`). Vertices before edges,
 *  so an edge's rev sees its endpoints' minted gids. */
export function refreshElements(store: GraphStore): void {
  refreshNodes(store);
  refreshEdges(store);
}
