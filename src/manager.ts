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
export function changesFeed(store: GraphStore, since: number): ChangesFeed {
  const rows = store.query<{ seq: number; id: string; kind: string; rev: string | null; deleted: number }>(
    `SELECT seq, hex(gid) AS id, 'vertex' AS kind, json(rev) AS rev, 0 AS deleted FROM nodes WHERE seq > ? AND gid IS NOT NULL
     UNION ALL
     SELECT seq, hex(gid) AS id, 'edge' AS kind, json(rev) AS rev, 0 AS deleted FROM edges WHERE seq > ? AND gid IS NOT NULL
     UNION ALL
     SELECT seq, hex(gid) AS id, kind, json(rev) AS rev, 1 AS deleted FROM tombstones WHERE seq > ?
     ORDER BY seq`, [since, since, since]);
  const results: ChangeRow[] = rows.map((r) => ({
    seq: r.seq, id: r.id, kind: r.kind as 'vertex' | 'edge',
    rev: r.rev ? JSON.parse(r.rev) as { gen: number; hash: string } : null,
    ...(r.deleted ? { deleted: true as const } : {}),
  }));
  return { results, last_seq: store.nextSeqBlock(0) };
}

/** A rev as a canonical comparison key — CouchDB's `gen-hash`. */
const revKey = (r: WireRev): string => `${r.gen}-${r.hash}`;

/**
 * The `_revs_diff` lookup (§4 primitive 2), shared like `changesFeed`: given the revs a peer holds per
 * element gid, return which this graph is MISSING, so the source ships only those. A pure gid/rev key
 * lookup — the efficiency engine that never touches a body.
 *
 * "Has gid@rev" here is an EXACT {gen,hash} match against this graph's LIVE row for that gid OR a
 * tombstone for it (a delete at that rev is still "had"). This is the single-leaf answer; the rev-TREE
 * ancestry check (a newer rev subsumes an offered ancestor, so it is not missing) is Phase 4 — until
 * then the diff is conservative (it may re-offer an ancestor), which the idempotent apply makes safe.
 * Gids are hex (as `_changes` emits); the lookup is `hex(gid) IN (json_each(?))` — ONE JSON bind, never
 * a data-sized placeholder list (§6·2).
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
  // gid (upper hex) → the set of rev keys this graph holds for it.
  const held = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.rev) continue;
    const rev = JSON.parse(r.rev) as WireRev;
    (held.get(r.gid) ?? held.set(r.gid, new Set()).get(r.gid)!).add(revKey(rev));
  }
  const out: Record<string, { missing: WireRev[] }> = {};
  for (const [gid, revs] of Object.entries(request)) {
    const have = held.get(gid.toUpperCase());
    const missing = revs.filter((r) => !have?.has(revKey(r)));
    if (missing.length) out[gid] = { missing };
  }
  return out;
}
