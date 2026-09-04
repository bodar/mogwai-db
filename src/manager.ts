// The graph-lifecycle seam. `GraphManager` is the runtime-specific half of the
// management story: creating, inspecting, and destroying whole graphs. The
// shared `makeRouter` (router.ts) dispatches HTTP verbs onto it, so the two
// runtimes present an identical management API. Everything platform-specific
// (a Bun in-process registry vs a Cloudflare Durable Object namespace) hides
// behind this interface, mirroring how `Sql` hides the SQLite transport.
//
// Semantics are idempotent and create-on-demand, matching Cloudflare's model:
// addressing `/gremlin/{id}` at all brings the graph into existence (a DO springs
// into being on first access; the namespace has no "does this exist?" query).
// So no verb 404s on a well-formed id — GET/POST auto-create an empty graph,
// PUT is create-if-absent, DELETE is a no-op when there's nothing to remove.
import type { GraphStore } from './storage.ts';
import type { ChangesFeed, ChangeRow, GraphInfo, RevsDiffRequest, RevsDiffResponse, WireRev } from './api.ts';
// The GraphManager / GraphInfo / Executor seams now live in the API surface (src/api.ts).
// Re-exported here so existing `import { GraphManager } from './manager.ts'` sites keep working.
export type { GraphManager, GraphInfo, Executor, RemoteExecutor } from './api.ts';

/** Element counts for a store. Shared by both runtimes (Bun reads its own
 *  store; the Cloudflare DO runs it inside itself over `ctx.storage.sql`). */
export function graphInfo(store: GraphStore): GraphInfo {
  const v = store.query<{ c: number }>('SELECT count(*) AS c FROM nodes')[0].c;
  const e = store.query<{ c: number }>('SELECT count(*) AS c FROM edges')[0].c;
  return { vertexCount: v, edgeCount: e };
}

/**
 * The by-sequence change feed since cursor `since` (§5·2), shared by every runtime the way `graphInfo`
 * is — store-tier read work, so it runs where the graph lives (Bun in-process, a DO over its own SQL).
 *
 * ONE query: a UNION of live nodes/edges `WHERE seq > since` and tombstones `WHERE seq > since`, ordered
 * by the globally-unique `seq`, so each element appears ONCE at its latest state (a delete as its
 * tombstone, `deleted: true`). `since = 0` enumerates the full current state (every live element has
 * seq > 0); the feed is current-state-sized because a write MOVES an element's entry, never appends.
 * Keyed by `gid` (cross-peer identity), so a live element without one (a pre-column row) is excluded —
 * it has no identity to ship. `last_seq` is the graph's `update_seq`: a client checkpoints it and
 * resumes with `since = last_seq`.
 */
export function changesFeed(store: GraphStore, since: number, limit?: number, match?: readonly (string | number)[]): ChangesFeed {
  // A `limit` PAGES the feed (CouchDB `_changes?limit=N`): the replicator drains a large graph in bounded
  // batches so no single `applyWire` span busy-locks the single-threaded store — the pacing substrate
  // (§7 / the replication plan Phase 5a). Safe to page by `seq` because every element/tombstone carries a
  // DISTINCT, strictly-monotonic seq (assigned `base + i + 1` from `nextSeqBlock`, refresh.ts), so no two
  // rows share a boundary seq — a `LIMIT` can never split a seq-group and drop a row.
  const paged = limit != null && limit > 0;
  // FILTERED replication (filtered-replication-plan F1): when `match` is present, the live feed is
  // restricted to the matched vertices plus their 1-HOP EDGE-CLOSURE — the matched vertices, the edges
  // incident to them, and the OTHER endpoint each such edge reaches. That is an edge-closed subgraph,
  // valid by construction (a boundary edge pulls its endpoint in, parent §6·3), never transitive (§2).
  // TOMBSTONES ship IN FULL regardless of the filter (§4): `applyDeletes` is a no-op for a gid the target
  // does not hold, and a once-boundary element's later delete must still propagate. `match` carries the
  // filter's matched vertices as their EXTERNAL ids (`COALESCE(uid, id)`, the id a traversal yields),
  // resolved back to rowids in the `matched` CTE — `json_each` preserves each JSON value's type and
  // `COALESCE(uid, id)` has NONE affinity, so an integer rowid matches an integer and a uid string a
  // string, never crossing. ONE JSON bind for the whole set (the binds rule, §6·2), never a placeholder list.
  const filtered = match !== undefined;
  const rows = store.query<{ seq: number; id: string; kind: string; rev: string | null; deleted: number }>(
    filtered
      ? `WITH matched(id) AS (
           SELECT id FROM nodes WHERE COALESCE(uid, id) IN (SELECT value FROM json_each(?))),
         incident(eid, other) AS (
           SELECT id, tgt FROM edges WHERE src IN (SELECT id FROM matched)
           UNION ALL SELECT id, src FROM edges WHERE tgt IN (SELECT id FROM matched)),
         vclosure(id) AS (SELECT id FROM matched UNION SELECT other FROM incident),
         eclosure(id) AS (SELECT eid FROM incident)
         SELECT seq, hex(gid) AS id, 'vertex' AS kind, json(rev) AS rev, 0 AS deleted FROM nodes
           WHERE seq > ? AND gid IS NOT NULL AND id IN (SELECT id FROM vclosure)
         UNION ALL
         SELECT seq, hex(gid) AS id, 'edge' AS kind, json(rev) AS rev, 0 AS deleted FROM edges
           WHERE seq > ? AND gid IS NOT NULL AND id IN (SELECT id FROM eclosure)
         UNION ALL
         SELECT seq, hex(gid) AS id, kind, json(rev) AS rev, 1 AS deleted FROM tombstones WHERE seq > ?
         ORDER BY seq${paged ? ' LIMIT ?' : ''}`
      : `SELECT seq, hex(gid) AS id, 'vertex' AS kind, json(rev) AS rev, 0 AS deleted FROM nodes WHERE seq > ? AND gid IS NOT NULL
         UNION ALL
         SELECT seq, hex(gid) AS id, 'edge' AS kind, json(rev) AS rev, 0 AS deleted FROM edges WHERE seq > ? AND gid IS NOT NULL
         UNION ALL
         SELECT seq, hex(gid) AS id, kind, json(rev) AS rev, 1 AS deleted FROM tombstones WHERE seq > ?
         ORDER BY seq${paged ? ' LIMIT ?' : ''}`,
    filtered
      ? (paged ? [JSON.stringify(match), since, since, since, limit] : [JSON.stringify(match), since, since, since])
      : (paged ? [since, since, since, limit] : [since, since, since]));
  const conflicts = conflictLeaves(store, rows.filter((r) => !r.deleted).map((r) => r.id)); // gid → loser leaf revs (4b-2)
  const results: ChangeRow[] = rows.map((r) => ({
    seq: r.seq, id: r.id, kind: r.kind as 'vertex' | 'edge',
    // A live row carries the LEAF only (its ancestry stays in the store, revs_diff reads it); a DELETE
    // carries the FULL ancestry, since a tombstone has no body and the feed is its only lineage carrier.
    rev: r.deleted ? fullRev(r.rev) : leafRev(r.rev),
    ...(r.deleted ? { deleted: true as const } : {}),
    ...(conflicts.get(r.id)?.length ? { conflicts: conflicts.get(r.id) } : {}),
  }));
  // When a page was TRUNCATED (a full batch), the cursor resumes at the last row's seq so the next page
  // reads strictly after it; otherwise the feed is fully drained and `last_seq` is the graph's `update_seq`
  // (a re-pull from there reads nothing, even if the highest element seq is below the counter).
  const truncated = paged && rows.length === limit;
  const last_seq = truncated ? rows[rows.length - 1]!.seq : store.nextSeqBlock(0);
  return { results, last_seq };
}

/** gid → its shadowed conflict-LOSER leaf revs (4b-2), so the feed advertises them (`?style=all_docs`).
 *  Only real divergent-content leaves — a delete marker (`{deleted}`) or uid marker (`{uidConflict}`) is
 *  a local surfacing, not a leaf a peer fetches. */
function conflictLeaves(store: GraphStore, gids: readonly string[]): Map<string, WireRev[]> {
  const out = new Map<string, WireRev[]>();
  if (!gids.length) return out;
  const rows = store.query<{ gid: string; doc: string }>(
    'SELECT hex(gid) AS gid, json(doc) AS doc FROM conflicts WHERE hex(gid) IN (SELECT value FROM json_each(?))',
    [JSON.stringify(gids)]);
  for (const r of rows) {
    const doc = JSON.parse(r.doc) as { deleted?: boolean; uidConflict?: string; rev?: string };
    if (doc.deleted || doc.uidConflict) continue; // not a content leaf
    const rev = leafRev(doc.rev ?? null);
    if (rev) (out.get(r.gid) ?? out.set(r.gid, []).get(r.gid)!).push(rev);
  }
  return out;
}

/** The stored rev's LEAF `{gen, hash}` — the feed's shape, dropping the rev-tree `ids` (a `_changes`
 *  entry is a leaf pointer; ancestry is the store's business). */
const leafRev = (raw: string | null): { gen: number; hash: string } | null => {
  if (!raw) return null;
  const r = JSON.parse(raw) as { gen: number; hash: string };
  return { gen: r.gen, hash: r.hash };
};

/** The stored rev WITH its ancestry (`ids`) — a delete's feed shape, so apply can classify it against a
 *  peer's live edit (§6·3). Seeds `[hash]` for a pre-tree rev. */
const fullRev = (raw: string | null): WireRev | null => {
  if (!raw) return null;
  const r = JSON.parse(raw) as { gen: number; hash: string; ids?: string[] };
  return { gen: r.gen, hash: r.hash, ids: r.ids ?? [r.hash] };
};

/**
 * The `_revs_diff` lookup (§4 primitive 2), shared like `changesFeed`: given the revs a peer holds per
 * element gid, return which this graph is MISSING, so the source ships only those. A pure gid/rev key
 * lookup — the efficiency engine that never touches a body.
 *
 * "Has gid@rev" is: the offered leaf hash appears ANYWHERE in this graph's rev-TREE for that gid — its
 * live row's tree OR a tombstone's — so a newer local rev SUBSUMES an offered ancestor (that hash is on
 * the ancestry line) and the ancestor is not re-fetched (§6·4). Membership is by HASH (the tree's `ids`
 * are hashes); gids are hex (as `_changes` emits), looked up via `hex(gid) IN (json_each(?))` — ONE JSON
 * bind, never a data-sized placeholder list (§6·2).
 */
export function revsDiff(store: GraphStore, request: RevsDiffRequest): RevsDiffResponse {
  const gids = Object.keys(request).map((g) => g.toUpperCase());
  if (!gids.length) return {};
  const gidsJson = JSON.stringify(gids);
  const rows = store.query<{ gid: string; rev: string | null }>(
    `SELECT hex(gid) AS gid, json(rev) AS rev FROM nodes WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))
     UNION ALL
     SELECT hex(gid) AS gid, json(rev) AS rev FROM edges WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))
     UNION ALL
     SELECT hex(gid) AS gid, json(rev) AS rev FROM tombstones WHERE hex(gid) IN (SELECT value FROM json_each(?))`,
    [gidsJson, gidsJson, gidsJson]);
  // gid (upper hex) → every hash on this graph's rev-tree(s) for it (leaf + ancestry), so an offered
  // ancestor is recognised as already held.
  const held = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.rev) continue;
    const rev = JSON.parse(r.rev) as { hash: string; ids?: string[] };
    const set = held.get(r.gid) ?? held.set(r.gid, new Set()).get(r.gid)!;
    for (const h of rev.ids ?? [rev.hash]) set.add(h);
  }
  const out: Record<string, { missing: WireRev[] }> = {};
  for (const [gid, revs] of Object.entries(request)) {
    const have = held.get(gid.toUpperCase());
    const missing = revs.filter((r) => !have?.has(r.hash)); // by hash: the offer is a leaf, matched against the tree
    if (missing.length) out[gid] = { missing };
  }
  return out;
}
