// ---------- replication apply — landing a peer's changes by GID (§4 primitive 5, §6·1/§6·2) ----------
//
// docs/2026-09-02-replication-and-http-interop-plan.md. The write half of the peer protocol: given the
// element documents a source sent (its `_bulk_get` reply) and the deletes from its `_changes` feed, land
// them on THIS graph — idempotently, at their stated rev, keyed by GID.
//
// GID is the axis (§6·1): a replicated element is matched to a LOCAL rowid by its gid, not by the
// source's rowid (two peers mint rowids independently). New gid → a fresh local rowid; known gid → its
// existing rowid, whose content is overwritten (the rev decides the winner, single-leaf until Phase 4).
// Edges reference endpoints by gid; here they are resolved gid→local-rowid and vertices land BEFORE edges
// (§6·2), so an endpoint is always present when its edge lands. This REUSES the bulk loader — the upsert
// is `loadBulk(replace)` over rows re-keyed to local rowids, with the carried rev PRESERVED (the loader's
// replace path is rev-aware). Only the gid→rowid resolution is new.
//
// A delete is applied DIRECTLY (not via the compiled `drop()` cascade): the source sends every
// cascade-deleted element as its own delete, so re-cascading here would double-tombstone. We remove the
// one element's live rows + owned children and record a tombstone at the carried rev; a fresh LOCAL seq
// is assigned by the same refresh the upserts trigger, so a replicated delete enters this graph's feed.

import type { GraphStore } from './storage.ts';
import { loadBulk, type BulkEdge, type BulkProperty, type BulkVertex } from './bulk.ts';
import { deleteMembers, insertSet } from './setwrite.ts';
import { refreshElements } from './refresh.ts';

/** A replicated vertex document (what `_bulk_get` returns / `_bulk_docs` applies): identity + version +
 *  content, keyed by GID. `rev` is the `{gen, hash}` JSON text, preserved verbatim on apply. */
export interface ReplVertex {
  readonly gid: string;
  readonly rev: string;
  readonly labels: readonly string[];
  readonly properties: readonly BulkProperty[];
}

/** A replicated edge document — endpoints by GID (§6·1), resolved to local rowids on apply. */
export interface ReplEdge {
  readonly gid: string;
  readonly rev: string;
  readonly label: string;
  readonly srcGid: string;
  readonly tgtGid: string;
  readonly properties: readonly BulkProperty[];
}

/** A replicated delete (a `_changes` entry with `deleted: true`): the element's gid, its tombstone rev,
 *  and which kind — no body, since there is nothing left to carry. */
export interface ReplDelete {
  readonly gid: string;
  readonly rev: string | null;
  readonly kind: 'vertex' | 'edge';
}

/** One batch to apply: live upserts (vertices before edges by construction) and deletes. */
export interface ChangeSet {
  readonly vertices?: readonly ReplVertex[];
  readonly edges?: readonly ReplEdge[];
  readonly deletes?: readonly ReplDelete[];
}

const upper = (gid: string): string => gid.toUpperCase();

/** hex(gid) → local rowid for the gids that already exist in `table`. One `json_each` membership read
 *  (never a data-sized placeholder list, §6·2), the same access path `_revs_diff` uses. */
function resolveGids(store: GraphStore, table: 'nodes' | 'edges', gids: readonly string[]): Map<string, number> {
  if (!gids.length) return new Map();
  const rows = store.query<{ gid: string; id: number }>(
    `SELECT hex(gid) AS gid, id FROM ${table} WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(gids.map(upper))]);
  return new Map(rows.map((r) => [r.gid, r.id]));
}

const maxId = (store: GraphStore, table: 'nodes' | 'edges'): number =>
  (store.query<{ m: number | null }>(`SELECT max(id) AS m FROM ${table}`)[0].m ?? 0);

/**
 * Apply a batch of replicated changes to `store`, idempotently and keyed by GID. Deletes first, then the
 * live upserts (whose `loadBulk` flush refreshes gid/rev/seq and assigns the delete tombstones' seqs); an
 * all-delete batch triggers the refresh itself.
 */
export function applyChanges(store: GraphStore, cs: ChangeSet): void {
  const vertices = cs.vertices ?? [], edges = cs.edges ?? [], deletes = cs.deletes ?? [];

  applyDeletes(store, deletes);

  // Every vertex gid the batch names — its own, and every edge endpoint — resolved to a local rowid, a
  // fresh one minted (above the current max) for a gid this graph has not seen.
  const vGids = new Set<string>();
  for (const v of vertices) vGids.add(upper(v.gid));
  for (const e of edges) { vGids.add(upper(e.srcGid)); vGids.add(upper(e.tgtGid)); }
  const vRow = resolveGids(store, 'nodes', [...vGids]);
  let nextNode = maxId(store, 'nodes') + 1;
  for (const g of vGids) if (!vRow.has(g)) vRow.set(g, nextNode++);

  const eRow = resolveGids(store, 'edges', edges.map((e) => upper(e.gid)));
  let nextEdge = maxId(store, 'edges') + 1;
  for (const e of edges) if (!eRow.has(upper(e.gid))) eRow.set(upper(e.gid), nextEdge++);

  const bulkV: BulkVertex[] = vertices.map((v) => ({
    id: vRow.get(upper(v.gid))!, labels: [...v.labels], properties: [...v.properties], gid: upper(v.gid), rev: v.rev,
  }));
  const bulkE: BulkEdge[] = edges.map((e) => ({
    id: eRow.get(upper(e.gid))!, label: e.label, src: vRow.get(upper(e.srcGid))!, tgt: vRow.get(upper(e.tgtGid))!,
    properties: [...e.properties], gid: upper(e.gid), rev: e.rev,
  }));

  if (bulkV.length || bulkE.length) loadBulk(store, bulkV, bulkE, { idPolicy: 'preserve', onCollision: 'replace' });
  else if (deletes.length) refreshElements(store); // no upsert flush to piggyback on — assign the tombstones' seqs
}

/** Remove each deleted element's live rows + owned children (NOT a cascade — the source sends every
 *  cascade-deleted element as its own delete), and record a tombstone at the carried rev, deduped by gid
 *  so a re-apply is a no-op. The tombstone's local seq is assigned by `applyChanges`'s later refresh. */
function applyDeletes(store: GraphStore, deletes: readonly ReplDelete[]): void {
  if (!deletes.length) return;
  const vGids = deletes.filter((d) => d.kind === 'vertex').map((d) => upper(d.gid));
  const eGids = deletes.filter((d) => d.kind === 'edge').map((d) => upper(d.gid));
  const vIds = [...resolveGids(store, 'nodes', vGids).values()];
  const eIds = [...resolveGids(store, 'edges', eGids).values()];

  if (vIds.length) {
    deleteMembers(store, 'vertex_properties', 'node', vIds);
    deleteMembers(store, 'vertex_labels', 'node', vIds);
    deleteMembers(store, 'vertex_property_cardinality', 'node', vIds);
    store.query("DELETE FROM property_fts WHERE owner_elem = 'node' AND owner IN (SELECT value FROM json_each(?))", [JSON.stringify(vIds)]);
    deleteMembers(store, 'nodes', 'id', vIds);
  }
  if (eIds.length) {
    deleteMembers(store, 'edge_properties', 'edge', eIds);
    store.query("DELETE FROM property_fts WHERE owner_elem = 'edge' AND owner IN (SELECT value FROM json_each(?))", [JSON.stringify(eIds)]);
    deleteMembers(store, 'edges', 'id', eIds);
  }

  // A tombstone per delete, skipping a gid already tombstoned (idempotent). gid crosses as hex→unhex,
  // rev as jsonb text, seq NULL (the refresh assigns it).
  const allGids = deletes.map((d) => upper(d.gid));
  const already = new Set(store.query<{ gid: string }>(
    'SELECT hex(gid) AS gid FROM tombstones WHERE hex(gid) IN (SELECT value FROM json_each(?))',
    [JSON.stringify(allGids)]).map((r) => r.gid));
  const record = deletes.filter((d) => !already.has(upper(d.gid)));
  if (record.length) insertSet(store, 'tombstones',
    [{ name: 'gid', type: 'blob', blob: true }, { name: 'rev', type: 'blob', jsonb: true }, { name: 'kind', type: 'any' }],
    record.map((d) => [upper(d.gid), d.rev, d.kind]));
}
