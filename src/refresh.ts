// ---------- the post-write element refresh — gid mint / rev recompute ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md §5·1/§6·1. A compiled write lowers to set-based
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
//
// ON DEMAND (docs/2026-11-25-storage-density-plan.md S3): all of the above runs only once the graph has
// first EXPOSED identity — a replication call or a GraphSON export (`exposeIdentity`). Until then a write
// mints no gid, hashes no content and takes no seq (`refreshOff`), so a graph that never replicates or
// exports stores none of them. Enabling backfills the earlier elements in resumable rowid pages.

import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { computeRev, decodeRev, edgeContent, encodeRev, vertexContent } from './rev.ts';
import { labelsForOwners, vertexPropsForOwners, edgePropsForOwners, type PropRow } from './formats/drain.ts';
import { insertSet, updateSet, type SetColumn } from './setwrite.ts';
import { valueNodeFromStored } from './gremlin/types.ts';
import { PROPERTY_FTS_COLUMNS, ftsRowid, propertyFtsTextOfNode, type OwnerElem } from './services/fts-index.ts';

const GID: SetColumn = { name: 'gid', type: 'blob', blob: true };
const REV: SetColumn = { name: 'rev', type: 'blob', blob: true }; // the packed rev, as hex (rev.ts encodeRev)
const SEQ: SetColumn = { name: 'seq', type: 'any' };
const DIRTY: SetColumn = { name: 'dirty', type: 'any' };
// [id, gid, rev, seq, dirty=0] per refreshed row — `hex(NULL)` is '' not NULL in SQLite, so a gid-less
// row (empty string) routes to a mint via `||`; a real gid hex is 32 chars and never empty.

/** The next stored rev (hex) for a dirty row: a PRESERVE (dirty 3) keeps its existing rev's bytes
 *  verbatim; a CREATE (rev '') computes `{gen:1, …}`; a MUTATION (rev present) chains gen+1 — the last
 *  two are exactly `computeRev(parent, content)`, so only PRESERVE is special-cased. */
const nextRev = (dirty: number, rev: string, content: string): string =>
  dirty === PRESERVE ? rev : encodeRev(computeRev(decodeRev(rev), content));
const PRESERVE = 3;

type Elem = 'node' | 'edge';
interface ElemRow { id: number; gid: string; rev: string; dirty: number; label?: string; srcgid?: string; tgtgid?: string }

/** The rows to recompute, as `x` (a vertex, or an edge joined to its label and endpoint gids). `dirty` is
 *  the enum expression: the stored flag for a refresh, derived from `rev` for a backfill page. */
function selectRows(store: GraphStore, elem: Elem, where: string, dirty: string, tail = '', binds: unknown[] = []): ElemRow[] {
  return store.query<ElemRow>(elem === 'node'
    ? `SELECT x.id AS id, hex(x.gid) AS gid, hex(x.rev) AS rev, ${dirty} AS dirty FROM nodes x WHERE ${where} ORDER BY x.id ${tail}`
    : `SELECT x.id AS id, hex(x.gid) AS gid, hex(x.rev) AS rev, ${dirty} AS dirty, l.name AS label,
              hex(sv.gid) AS srcgid, hex(tv.gid) AS tgtgid
       FROM edges x JOIN labels l ON l.id = x.label JOIN nodes sv ON sv.id = x.src JOIN nodes tv ON tv.id = x.tgt
       WHERE ${where} ORDER BY x.id ${tail}`, binds);
}

/** Recompute `rows` in ONE `updateSet`. `full` (replication on): mint a missing gid, compute or keep the
 *  rev per the dirty enum, assign a fresh local seq, clear dirty. Not `full` (off): keep an EXISTING rev
 *  current — the caller selects only rows that have one — with no gid mint and no seq. Only a row whose
 *  rev is computed (not PRESERVE) reads labels/properties. */
function recompute(store: GraphStore, elem: Elem, rows: readonly ElemRow[], full: boolean): void {
  if (!rows.length) return;
  const contentIds = rows.filter((r) => r.dirty !== PRESERVE).map((r) => r.id);
  // collection values as json() TEXT, so JSON.stringify is stable
  const props = elem === 'node' ? vertexPropsForOwners(store, contentIds, true) : edgePropsForOwners(store, contentIds, true);
  const labels = elem === 'node' ? labelsForOwners(store, contentIds) : undefined;
  const rev = (r: ElemRow): string => nextRev(r.dirty, r.rev, r.dirty === PRESERVE ? ''
    : labels ? vertexContent((labels.get(r.id) ?? []).map((l) => l.name), props.get(r.id) ?? [])
    : edgeContent(r.label!, r.srcgid!, r.tgtgid!, props.get(r.id) ?? []));
  const table = elem === 'node' ? 'nodes' : 'edges';
  if (!full) return void updateSet(store, table, 'id', [REV, DIRTY], rows.map((r) => [r.id, rev(r), 0]));
  const base = store.nextSeqBlock(rows.length);
  updateSet(store, table, 'id', [GID, REV, SEQ, DIRTY], rows.map((r, i) => [r.id, r.gid || mintGid(), rev(r), base + i + 1, 0]));
}

/** Replication ON: today's refresh of every dirty row, vertices before edges. First, each UN-SEQUENCED
 *  endpoint of a dirty edge (a vertex written before enable, not yet reached by the backfill) is marked
 *  dirty, so it takes its gid, rev and a seq BELOW the edge's: the edge's rev sees a gid, and the feed
 *  keeps vertex-before-edge (§6·2). */
function refreshOn(store: GraphStore): void {
  store.query(`UPDATE nodes SET dirty = CASE WHEN rev IS NULL THEN 1 ELSE 3 END
    WHERE seq IS NULL AND NOT dirty AND id IN (SELECT src FROM edges WHERE dirty UNION SELECT tgt FROM edges WHERE dirty)`);
  for (const elem of ['node', 'edge'] as const) recompute(store, elem, selectRows(store, elem, 'x.dirty', 'x.dirty'), true);
}

/** Replication OFF: a write computes no gid, rev or seq — except that a rev, once it exists (a dump's
 *  preserved lineage), is kept current, so a peer holding the old rev later receives the change. A
 *  rev-less row stays rev-less and is not hashed. Every dirty flag is cleared. */
function refreshOff(store: GraphStore): void {
  for (const elem of ['node', 'edge'] as const) {
    recompute(store, elem, selectRows(store, elem, 'x.dirty AND x.dirty <> 3 AND x.rev IS NOT NULL', 'x.dirty'), false);
    store.query(`UPDATE ${elem === 'node' ? 'nodes' : 'edges'} SET dirty = 0 WHERE dirty`);
  }
}

const replicationOn = (store: GraphStore): boolean =>
  store.query<{ enabled: number }>('SELECT enabled FROM replication')[0]!.enabled === 1;

/** Elements per backfill statement when the caller sets no bound — one page of content in memory. */
const BACKFILL_PAGE = 1000;

/**
 * Turn replication metadata ON (idempotent) and BACKFILL the elements written before that. Per page, one
 * `updateSet` over the next rowid range of rows with `seq IS NULL` — vertices, then edges (an edge's rev
 * references its endpoints' gids) — mints a missing gid, computes a missing rev (an existing one is
 * current, by `refreshOff`) and assigns a fresh seq. A row written after enable already has a seq, so it
 * is skipped without a high-water mark. The cursor lives in the `replication` row, so a large graph
 * drains across calls. `limit` bounds this call's elements (absent = drain fully). Returns whether the
 * backfill is COMPLETE.
 *
 * The one entry for every store-tier call that exposes identity: the replication endpoints
 * (`changesFeed`, `revsDiff`, `applyWire`, `matchSetGids`) and the GraphSON export (`graphsonLines`).
 */
export function exposeIdentity(store: GraphStore, limit?: number): boolean {
  store.query('UPDATE replication SET enabled = 1 WHERE NOT enabled');
  let { kind, after } = store.query<{ kind: string; after: number }>(
    'SELECT backfill_kind AS kind, backfill_after AS after FROM replication')[0]!;
  let budget = limit ?? Infinity;
  while (kind !== 'done' && budget > 0) {
    const page = Math.min(budget, BACKFILL_PAGE);
    const elem: Elem = kind === 'vertex' ? 'node' : 'edge';
    const rows = selectRows(store, elem, 'x.id > ? AND x.seq IS NULL', 'CASE WHEN x.rev IS NULL THEN 1 ELSE 3 END', 'LIMIT ?', [after, page]);
    recompute(store, elem, rows, true);
    budget -= rows.length;
    if (rows.length < page) { kind = kind === 'vertex' ? 'edge' : 'done'; after = 0; }
    else after = rows[rows.length - 1]!.id;
    store.query('UPDATE replication SET backfill_kind = ?, backfill_after = ?', [kind, after]);
  }
  return kind === 'done';
}

/** Assign a fresh local seq to every tombstone a `drop()` just recorded (`seq IS NULL`, §6·4), so a
 *  delete enters the by-seq feed after the same write's live elements. The gid/rev were captured by the
 *  compiled drop; only the local seq is the refresh's to assign. A no-op when nothing was deleted. */
function refreshTombstones(store: GraphStore): void {
  const rows = store.query<{ id: number }>('SELECT id FROM tombstones WHERE seq IS NULL ORDER BY id');
  if (!rows.length) return;
  const base = store.nextSeqBlock(rows.length);
  updateSet(store, 'tombstones', 'id', [SEQ], rows.map((r, i) => [r.id, base + i + 1]));
}

/** The `property_fts` columns as `insertSet` typing — the same list as `PROPERTY_FTS_COLUMNS`, in the
 *  same order the row tuples below emit. `rowid`/`pid`/`owner` bind as plain integers. */
const FTS_SET_COLS: readonly SetColumn[] = PROPERTY_FTS_COLUMNS.map((name) =>
  ({ name, type: name === 'rowid' || name === 'pid' || name === 'owner' ? 'any' : 'text' }));

/** The `property_fts` rows a set of dirty owners' STILL-UNINDEXED properties should carry.
 *
 *  A `property(k, __.trav)` value is not indexed in the compiled plan — its text is not known until it
 *  is stored — so the post-write refresh derives it from the STORED self-describing `{t,v}` tree
 *  (`valueNodeFromStored`) through the ONE rendering (`propertyFtsTextOfNode`), the same one the
 *  constant write path and the bulk loader use, so the index cannot diverge. A property whose row is
 *  ALREADY in `property_fts` was indexed in-plan (a constant value) and is skipped — a rowid seek per
 *  property, since the FTS rowid is the signed property id; a stale-on-overwrite delete stayed in the
 *  plan (`dropStaleIndex`), so this only ever INSERTS. */
function ftsRowsForDirty(store: GraphStore, ownerElem: OwnerElem, props: Map<number, PropRow[]>): unknown[][] {
  const candidates = [...props.values()].flatMap((ps) => ps.map((p) => ftsRowid(ownerElem, p.id)));
  if (!candidates.length) return [];
  const indexed = new Set(store.query<{ rowid: number }>(
    'SELECT rowid FROM property_fts WHERE rowid IN (SELECT value FROM json_each(?))',
    [JSON.stringify(candidates)]).map((r) => r.rowid));
  const rows: unknown[][] = [];
  for (const [owner, ps] of props)
    for (const p of ps) {
      const rowid = ftsRowid(ownerElem, p.id);
      if (indexed.has(rowid)) continue;
      const text = propertyFtsTextOfNode(valueNodeFromStored(p.value, p.vtype));
      if (text !== null) rows.push([rowid, ownerElem, p.id, owner, p.key, text]);
    }
  return rows;
}

/** Index the runtime-written properties of the elements this write touched — `property(k, __.trav)`,
 *  whose value text is only knowable once stored. Runs BEFORE `refreshOn`/`refreshOff` clear the
 *  dirty flag, so `WHERE dirty` is still this write's touched set. A no-op (two index-served reads)
 *  when nothing is dirty. */
function refreshFts(store: GraphStore): void {
  const nodeIds = store.query<{ id: number }>('SELECT id FROM nodes WHERE dirty').map((r) => r.id);
  const edgeIds = store.query<{ id: number }>('SELECT id FROM edges WHERE dirty').map((r) => r.id);
  if (!nodeIds.length && !edgeIds.length) return;
  const rows: unknown[][] = [];
  if (nodeIds.length) rows.push(...ftsRowsForDirty(store, 'node', vertexPropsForOwners(store, nodeIds, true)));
  if (edgeIds.length) rows.push(...ftsRowsForDirty(store, 'edge', edgePropsForOwners(store, edgeIds, true)));
  insertSet(store, 'property_fts', FTS_SET_COLS, rows);
}

/** Refresh the replication metadata (gid + rev + seq; only a kept-current rev while replication is off)
 *  of the elements a write just touched, and assign seqs to any new tombstones — called by `frameResolved` after a write program commits
 *  (`plan.kind === 'program'`). FTS first (it reads `WHERE dirty`, which the metadata refresh clears),
 *  then vertices before edges (an edge's rev sees its endpoints' minted gids), then tombstones (a
 *  delete's seq follows the same write's live seqs, §6·2). */
export function refreshElements(store: GraphStore): void {
  refreshFts(store);
  if (replicationOn(store)) refreshOn(store);
  else refreshOff(store);
  refreshTombstones(store);
}
