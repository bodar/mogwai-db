// ---------- replication apply — landing a peer's changes by GID (§4 primitive 5, §6·1/§6·2) ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md. The write half of the peer protocol: given the
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
import { labelsForOwners, vertexPropsForOwners, edgePropsForOwners } from './formats/drain.ts';
import { vertexPropsJson, edgePropsJson, vertexProperties, edgeProperties } from './formats/graphson.ts';
import { changesFeed, revsDiff } from './manager.ts';
import { parseRev, descendsFrom, revWins, type Rev } from './rev.ts';
import type {
  BulkGetRef, WireChangeSet, WireVertex, WireEdge, WireDelete, WireRev, ChangesFeed, RevsDiffRequest,
  RevsDiffResponse, Http, GraphManager, ReplicateOptions, ReplicationStats, ConflictEntry,
} from './api.ts';

/** A replicated vertex document (what `_bulk_get` returns / `_bulk_docs` applies): identity + version +
 *  content, keyed by GID. `rev` is the `{gen, hash}` JSON text, preserved verbatim on apply. */
export interface ReplVertex {
  readonly gid: string;
  readonly rev: string;
  readonly uid?: string | null;
  readonly labels: readonly string[];
  readonly properties: readonly BulkProperty[];
}

/** A replicated edge document — endpoints by GID (§6·1), resolved to local rowids on apply. */
export interface ReplEdge {
  readonly gid: string;
  readonly rev: string;
  readonly uid?: string | null;
  readonly label: string;
  readonly srcGid: string;
  readonly tgtGid: string;
  readonly properties: readonly BulkProperty[];
}

/** A replicated delete (a `_changes` entry with `deleted: true`): the element's gid, its tombstone rev,
 *  and which kind — no body. The same shape as the wire's `WireDelete` (a delete needs no serialization,
 *  so the apply substrate and the wire share it). */
export type ReplDelete = WireDelete;

/** One batch to apply: live upserts (vertices before edges by construction) and deletes. */
export interface ChangeSet {
  readonly vertices?: readonly ReplVertex[];
  readonly edges?: readonly ReplEdge[];
  readonly deletes?: readonly ReplDelete[];
}

// The WIRE document (`_bulk_get` reply / `_bulk_docs` request) — `WireVertex`/`WireEdge`/`WireChangeSet`/
// `BulkGetRef` — lives in the manager seam (`src/api.ts`), because the manager methods carry it and
// `api.ts` is the base of the import graph. Properties cross as their GraphSON TYPED-VALUE form, NOT as
// bare `BulkProperty`: a collection value is a `Map`/`Set` that JSON-drops, while the GraphSON form is
// wire-safe and round-trips every type + multi-property + meta through the one proven codec
// (`src/formats/graphson.ts`). `applyWire` parses it back to a `BulkProperty` `ChangeSet` and hands it to
// `applyChanges` — so the apply substrate stays format-free.

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

  if (bulkV.length || bulkE.length) {
    loadBulk(store, bulkV, bulkE, { idPolicy: 'preserve', onCollision: 'replace' });
    // RESURRECT (§6·3, not-deleted beats deleted): a live version supersedes a local tombstone for the
    // same gid, so drop the tombstone and SURFACE the superseded delete as a conflict (never lost).
    resurrect(store, [...bulkV.map((v) => v.gid!), ...bulkE.map((e) => e.gid!)]);
    // uid is a post-pass (§6·1): loadBulk landed every element with uid NULL; assign each carried uid,
    // reconciling a cross-peer collision (two gids claiming one uid) rather than hitting UNIQUE(uid).
    applyUids(store, 'nodes', vertices);
    applyUids(store, 'edges', edges);
  } else if (deletes.length) refreshElements(store); // no upsert flush to piggyback on — assign the tombstones' seqs
}

/**
 * Assign each element's carried `uid` after `loadBulk` landed it uid-null, reconciling a cross-peer
 * collision (§6·1). A uid is unique PER GRAPH, but a partition lets two independent creates (distinct
 * gids) claim the same uid — importing a UNIQUE(uid) violation neither peer had. It reconciles like any
 * conflict (never reject, never lose): the WINNER keeps the uid, the loser's is shadowed and surfaced.
 * Winner = not-deleted (both live here) > LOWER gid — a total, clock-free order both peers agree on, so
 * they converge (and since gid is uuid_v7 it also means "first to claim the name"). NOT auto-merged: the
 * two elements stay distinct, only the user knows if they are the same thing.
 */
function applyUids(store: GraphStore, table: 'nodes' | 'edges', items: readonly { gid: string; uid?: string | null }[]): void {
  const kind = table === 'nodes' ? 'vertex' : 'edge';
  for (const it of items) {
    if (it.uid == null) continue;
    const gid = upper(it.gid);
    const holder = store.query<{ gid: string }>(`SELECT hex(gid) AS gid FROM ${table} WHERE uid = ?`, [it.uid])[0];
    if (holder && upper(holder.gid) !== gid) {
      if (gid < upper(holder.gid)) { // incoming wins the uid (lower gid)
        store.query(`UPDATE ${table} SET uid = NULL WHERE hex(gid) = ?`, [upper(holder.gid)]); // strip loser FIRST (UNIQUE)
        store.query(`UPDATE ${table} SET uid = ? WHERE hex(gid) = ?`, [it.uid, gid]);
        shadowUid(store, holder.gid, it.uid, kind); // surface the existing loser's uid-loss
      } else shadowUid(store, gid, it.uid, kind); // incoming loses — it keeps uid NULL, surface
    } else if (!holder) {
      store.query(`UPDATE ${table} SET uid = ? WHERE hex(gid) = ?`, [it.uid, gid]); // no collision
    }
    // holder is this same gid → uid already assigned, nothing to do (idempotent re-apply)
  }
}

/** Surface a losing UID claim in the shadow store (§6·1) — the element still exists (its gid, content),
 *  it just lost the contested uid. Marker doc, keyed by the uid so several coexist. */
function shadowUid(store: GraphStore, gid: string, uid: string, kind: 'vertex' | 'edge'): void {
  shadowLeaf(store, gid, `uid:${uid}`, kind, { uidConflict: uid, kind });
}

/** A live upsert supersedes a local tombstone for the same gid (not-deleted beats deleted, §6·3): drop
 *  the tombstone (the element is back) and shadow the superseded delete so it is surfaced, not lost. */
function resurrect(store: GraphStore, gids: readonly string[]): void {
  if (!gids.length) return;
  const j = JSON.stringify(gids.map(upper));
  const toms = store.query<{ gid: string; rev: string | null; kind: string }>(
    'SELECT hex(gid) AS gid, json(rev) AS rev, kind FROM tombstones WHERE hex(gid) IN (SELECT value FROM json_each(?))', [j]);
  if (!toms.length) return;
  for (const t of toms) shadowDelete(store, t.gid, t.rev, t.kind as 'vertex' | 'edge');
  store.query('DELETE FROM tombstones WHERE hex(gid) IN (SELECT value FROM json_each(?))', [j]);
}

/** Surface a losing DELETE in the shadow store — a delete carries no body, so its "doc" is a marker
 *  `{deleted, rev, kind}`, keyed by its rev hash (or `deleted` when it has none). */
function shadowDelete(store: GraphStore, gid: string, revText: string | null, kind: 'vertex' | 'edge'): void {
  shadowLeaf(store, gid, parseRev(revText)?.hash ?? 'deleted', kind, { deleted: true, rev: revText, kind });
}

/** Apply each incoming delete — remove the element's live rows + owned children (NOT a cascade: the
 *  source sends every cascade-deleted element as its own delete) and record a tombstone at the carried
 *  rev, deduped by gid (idempotent). The seq is assigned by `applyChanges`'s later refresh.
 *
 *  THE REFERENTIAL RULE (§6·3, no CouchDB analog): a vertex delete whose vertex is still referenced by a
 *  LIVE edge is REFUSED — a referencing edge is an existence-claim, so the vertex is RESURRECTED (kept
 *  live, not removed, no tombstone) and the delete is surfaced as a conflict. Never rejects the delete,
 *  never drops the edge — the live graph stays consistent by construction (V is back, E doesn't dangle). */
function applyDeletes(store: GraphStore, deletes: readonly ReplDelete[]): void {
  if (!deletes.length) return;
  const vRow = resolveGids(store, 'nodes', deletes.filter((d) => d.kind === 'vertex').map((d) => upper(d.gid)));
  const eRow = resolveGids(store, 'edges', deletes.filter((d) => d.kind === 'edge').map((d) => upper(d.gid)));
  const vLocal = localRevs(store, 'nodes', [...vRow.keys()]); // gid → local LIVE rev, for the concurrency check
  const eLocal = localRevs(store, 'edges', [...eRow.keys()]);

  // Which of the to-be-deleted vertices are still endpoints of a LIVE edge → resurrect them (referential).
  const vIds = [...vRow.values()];
  const referenced = new Set(vIds.length ? store.query<{ id: number }>(
    `SELECT src AS id FROM edges WHERE src IN (SELECT value FROM json_each(?))
     UNION SELECT tgt AS id FROM edges WHERE tgt IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(vIds), JSON.stringify(vIds)]).map((r) => r.id) : []);

  // A delete is REFUSED (surfaced, not applied) when it conflicts with the LIVE element (§6·3): a vertex
  // a live edge references (existence-claim), OR a delete that does not DESCEND the local live rev — a
  // concurrent edit, so not-deleted beats deleted. A delete that descends (a normal delete-after-edit) or
  // meets no live element applies. A delete without a rev (a direct, non-replicated call) always applies.
  const removeV: number[] = [], removeE: number[] = [];
  const refused = new Set<string>();
  const concurrent = (d: ReplDelete, local: Rev | undefined): boolean => {
    const del = parseRev(d.rev);
    return local !== undefined && del !== null && !descendsFrom(del, local);
  };
  for (const d of deletes) {
    const g = upper(d.gid);
    if (d.kind === 'vertex') {
      const rowid = vRow.get(g);
      if (rowid === undefined) continue; // no local live vertex — nothing to remove (still tombstoned below)
      if (referenced.has(rowid) || concurrent(d, vLocal.get(g))) { shadowDelete(store, d.gid, d.rev, 'vertex'); refused.add(g); }
      else removeV.push(rowid);
    } else {
      const rowid = eRow.get(g);
      if (rowid === undefined) continue;
      if (concurrent(d, eLocal.get(g))) { shadowDelete(store, d.gid, d.rev, 'edge'); refused.add(g); }
      else removeE.push(rowid);
    }
  }

  if (removeV.length) {
    deleteMembers(store, 'vertex_properties', 'node', removeV);
    deleteMembers(store, 'vertex_labels', 'node', removeV);
    deleteMembers(store, 'vertex_property_cardinality', 'node', removeV);
    store.query("DELETE FROM property_fts WHERE owner_elem = 'node' AND owner IN (SELECT value FROM json_each(?))", [JSON.stringify(removeV)]);
    deleteMembers(store, 'nodes', 'id', removeV);
  }
  if (removeE.length) {
    deleteMembers(store, 'edge_properties', 'edge', removeE);
    store.query("DELETE FROM property_fts WHERE owner_elem = 'edge' AND owner IN (SELECT value FROM json_each(?))", [JSON.stringify(removeE)]);
    deleteMembers(store, 'edges', 'id', removeE);
  }

  // A tombstone per APPLIED delete (a refused one is surfaced, not tombstoned), skipping a gid already
  // tombstoned. gid crosses as hex→unhex, rev as jsonb text, seq NULL (the refresh assigns it).
  const applied = deletes.filter((d) => !refused.has(upper(d.gid)));
  const already = new Set(store.query<{ gid: string }>(
    'SELECT hex(gid) AS gid FROM tombstones WHERE hex(gid) IN (SELECT value FROM json_each(?))',
    [JSON.stringify(applied.map((d) => upper(d.gid)))]).map((r) => r.gid));
  const record = applied.filter((d) => !already.has(upper(d.gid)));
  if (record.length) insertSet(store, 'tombstones',
    [{ name: 'gid', type: 'blob', blob: true }, { name: 'rev', type: 'blob', jsonb: true }, { name: 'kind', type: 'any' }],
    record.map((d) => [upper(d.gid), d.rev, d.kind]));
}

/**
 * Read the BODIES of the elements a peer asked for (`_bulk_get`), as wire documents keyed by gid. The
 * source of the transfer's payload: `_changes` gives gid+rev, `_revs_diff` narrows to what is missing,
 * and this returns the labels + typed properties + endpoint gids to actually apply. Properties ride the
 * GraphSON typed-value form (wire-safe, full-fidelity) via the shared codec. A ref whose gid this graph
 * does not hold is simply absent from the reply (it may have been deleted since the feed was read).
 */
export function bulkGet(store: GraphStore, refs: readonly BulkGetRef[]): WireChangeSet {
  const vertices: WireVertex[] = [];
  const edges: WireEdge[] = [];
  // A ref naming a SPECIFIC rev wants a shadowed conflict LOSER (4b-2): serve it from the conflict store;
  // if there is no such shadow the rev is the live one, so it falls through to the live body below.
  const plain: BulkGetRef[] = [];
  for (const ref of refs) {
    if (!ref.rev) { plain.push(ref); continue; }
    const row = store.query<{ doc: string }>('SELECT json(doc) AS doc FROM conflicts WHERE hex(gid) = ? AND rev_hash = ?', [upper(ref.gid), ref.rev])[0];
    if (row) {
      const doc = JSON.parse(row.doc) as WireVertex & WireEdge & { deleted?: boolean; uidConflict?: string };
      if (!doc.deleted && !doc.uidConflict) (ref.kind === 'vertex' ? vertices : edges).push(doc);
    } else plain.push({ gid: ref.gid, kind: ref.kind });
  }
  const live = liveBodies(store, plain);
  vertices.push(...live.vertices!);
  edges.push(...live.edges!);
  return { vertices, edges };
}

/** The LIVE bodies (winners) of the referenced elements, keyed by gid — the ordinary transfer payload. */
function liveBodies(store: GraphStore, refs: readonly BulkGetRef[]): { vertices: WireVertex[]; edges: WireEdge[] } {
  const vGids = refs.filter((r) => r.kind === 'vertex').map((r) => upper(r.gid));
  const eGids = refs.filter((r) => r.kind === 'edge').map((r) => upper(r.gid));

  const vRows = vGids.length ? store.query<{ id: number; gid: string; rev: string; uid: string | null }>(
    'SELECT id, hex(gid) AS gid, json(rev) AS rev, uid FROM nodes WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))',
    [JSON.stringify(vGids)]) : [];
  const vIds = vRows.map((r) => r.id);
  const labels = labelsForOwners(store, vIds);
  const vprops = vertexPropsForOwners(store, vIds, true); // collection values as json() text
  const vertices: WireVertex[] = vRows.map((r) => ({
    gid: r.gid, rev: r.rev, uid: r.uid,
    labels: (labels.get(r.id) ?? []).map((l) => l.name),
    properties: vertexPropsJson(vprops.get(r.id) ?? []),
  }));

  const eRows = eGids.length ? store.query<{ id: number; gid: string; rev: string; uid: string | null; label: string; src: string; tgt: string }>(
    `SELECT e.id AS id, hex(e.gid) AS gid, json(e.rev) AS rev, e.uid AS uid, l.name AS label, hex(sv.gid) AS src, hex(tv.gid) AS tgt
     FROM edges e JOIN labels l ON l.id = e.label JOIN nodes sv ON sv.id = e.src JOIN nodes tv ON tv.id = e.tgt
     WHERE e.gid IS NOT NULL AND hex(e.gid) IN (SELECT value FROM json_each(?))`, [JSON.stringify(eGids)]) : [];
  const eprops = edgePropsForOwners(store, eRows.map((r) => r.id), true);
  const edges: WireEdge[] = eRows.map((r) => ({
    gid: r.gid, rev: r.rev, uid: r.uid, label: r.label, srcGid: r.src, tgtGid: r.tgt,
    properties: edgePropsJson(eprops.get(r.id) ?? []),
  }));

  return { vertices, edges };
}

/** hex(gid) → the live rev-tree this graph holds for it, for a set of gids. */
function localRevs(store: GraphStore, table: 'nodes' | 'edges', gids: readonly string[]): Map<string, Rev> {
  if (!gids.length) return new Map();
  const rows = store.query<{ gid: string; rev: string | null }>(
    `SELECT hex(gid) AS gid, json(rev) AS rev FROM ${table} WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(gids.map(upper))]);
  const out = new Map<string, Rev>();
  for (const r of rows) { const rev = parseRev(r.rev); if (rev) out.set(r.gid, rev); }
  return out;
}

/** Record a LOSING leaf in the shadow store (§6·3), deduped by (gid, hash). `doc` is the loser's wire
 *  document, so its version is not lost. Fixed-shape insert (never a data-sized bind list). */
function shadowLeaf(store: GraphStore, gid: string, revHash: string, kind: 'vertex' | 'edge', doc: unknown): void {
  store.query('INSERT OR IGNORE INTO conflicts(gid, rev_hash, kind, doc) VALUES (unhex(?), ?, ?, jsonb(?))',
    [upper(gid), revHash, kind, JSON.stringify(doc)]);
}

/**
 * Classify each incoming wire element against this graph's live rev-tree (§6·3), returning the ones to
 * APPLY (the rest are skipped or shadowed):
 *   - no local, or a fast-forward (incoming descends local) → APPLY (advance).
 *   - identical, or incoming is an ANCESTOR of local → skip (already have it).
 *   - DIVERGENT (neither descends) → a conflict, resolved by `revWins`: if the incoming wins, shadow the
 *     LOCAL version (its content read before apply overwrites it) and APPLY the incoming; if the local
 *     wins, shadow the INCOMING and skip it. Either way BOTH versions survive.
 */
function classifyWire<W extends { gid: string; rev: string }, R>(
  store: GraphStore, table: 'nodes' | 'edges', kind: 'vertex' | 'edge', incoming: readonly W[], toRepl: (w: W) => R,
): R[] {
  if (!incoming.length) return [];
  const local = localRevs(store, table, incoming.map((w) => w.gid));
  const accept: R[] = [];
  const shadowLocal: string[] = [];   // gids whose CURRENT local content must be shadowed (incoming wins)
  const shadowIncoming: W[] = [];      // incoming losers (local wins) — shadow the wire doc itself
  for (const w of incoming) {
    const loc = local.get(upper(w.gid));
    const inc = parseRev(w.rev);
    if (!loc || !inc) { accept.push(toRepl(w)); continue; }        // new (or unparseable rev — apply, fail-safe)
    if (inc.hash === loc.hash) continue;                            // identical → already have it
    if (descendsFrom(inc, loc)) { accept.push(toRepl(w)); continue; } // fast-forward → advance
    if (descendsFrom(loc, inc)) continue;                          // incoming is an ancestor → already have
    if (revWins(inc, false, loc, false)) { shadowLocal.push(upper(w.gid)); accept.push(toRepl(w)); } // incoming wins
    else shadowIncoming.push(w);                                    // local wins → incoming loses
  }
  // Shadow the local losers with their CURRENT content (read before `applyChanges` overwrites it).
  if (shadowLocal.length) {
    const docs = bulkGet(store, shadowLocal.map((gid) => ({ gid, kind })));
    for (const d of (kind === 'vertex' ? docs.vertices ?? [] : docs.edges ?? []))
      shadowLeaf(store, d.gid, parseRev(d.rev)!.hash, kind, d);
  }
  for (const w of shadowIncoming) shadowLeaf(store, w.gid, parseRev(w.rev)!.hash, kind, w);
  return accept;
}

/**
 * Apply a WIRE change set (`_bulk_docs`): classify each element against the local rev-tree, PRESERVING a
 * divergent conflict in the shadow store (§6·3) rather than losing a write, then hand the accepted
 * (new / fast-forward / conflict-winning) elements to {@link applyChanges} as a format-free `ChangeSet`.
 * Two peers cross-replicating CONVERGE: `revWins` is deterministic, so each keeps the same winner live
 * and shadows the same loser.
 */
/** Drop each property's source VertexProperty `id` so the target MINTS a fresh one — a property rowid is
 *  LOCAL (like the element rowid, §6·1), so preserving it across peers collides on `vertex_properties.id`.
 *  Property identity is not gid-tracked; re-minting is the correct cross-peer behaviour. */
const reminted = (props: readonly BulkProperty[]): BulkProperty[] => props.map(({ id: _id, ...p }) => p);

export function applyWire(store: GraphStore, ws: WireChangeSet): void {
  const vertices = classifyWire(store, 'nodes', 'vertex', ws.vertices ?? [],
    (v) => ({ gid: v.gid, rev: v.rev, uid: v.uid, labels: v.labels, properties: reminted(vertexProperties(v.properties)) }));
  const edges = classifyWire(store, 'edges', 'edge', ws.edges ?? [],
    (e) => ({ gid: e.gid, rev: e.rev, uid: e.uid, label: e.label, srcGid: e.srcGid, tgtGid: e.tgtGid, properties: reminted(edgeProperties(e.properties)) }));
  applyChanges(store, { vertices, edges, deletes: ws.deletes ?? [] });
}

/** The conflict LOSERS shadowed for an element (§6·3) — the conflict-aware read a surfacing query needs
 *  (the live winner is the ordinary row). Each is the losing wire document at its rev. */
export function conflictsFor(store: GraphStore, gidHex: string): { rev_hash: string; kind: string; doc: unknown }[] {
  return store.query<{ rev_hash: string; kind: string; doc: string }>(
    'SELECT rev_hash, kind, json(doc) AS doc FROM conflicts WHERE hex(gid) = ?', [gidHex.toUpperCase()])
    .map((r) => ({ rev_hash: r.rev_hash, kind: r.kind, doc: JSON.parse(r.doc) as unknown }));
}

/** hex(gid) → live leaf rev, for a set of conflicted gids (nodes + edges). */
function liveRevs(store: GraphStore, gids: readonly string[]): Map<string, WireRev> {
  const out = new Map<string, WireRev>();
  if (!gids.length) return out;
  const j = JSON.stringify(gids);
  const rows = store.query<{ gid: string; rev: string | null }>(
    `SELECT hex(gid) AS gid, json(rev) AS rev FROM nodes WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))
     UNION ALL
     SELECT hex(gid) AS gid, json(rev) AS rev FROM edges WHERE gid IS NOT NULL AND hex(gid) IN (SELECT value FROM json_each(?))`,
    [j, j]);
  for (const r of rows) { const rev = parseRev(r.rev); if (rev) out.set(r.gid, { gen: rev.gen, hash: rev.hash }); }
  return out;
}

/** Every surfaced conflict (§6·3): the live winner + shadowed losers per conflicted element. The
 *  `?conflicts=true` analog — the ONLY read that sees a conflict; ordinary traversal returns the winner
 *  alone. Empty in the common (read≫write) case, since the shadow store is seldom populated. */
export function conflictsFeed(store: GraphStore): ConflictEntry[] {
  const rows = store.query<{ gid: string; kind: string; doc: string }>(
    'SELECT hex(gid) AS gid, kind, json(doc) AS doc FROM conflicts ORDER BY gid, rev_hash');
  if (!rows.length) return [];
  const byGid = new Map<string, { kind: 'vertex' | 'edge'; losers: { rev: WireRev; doc: unknown }[] }>();
  for (const r of rows) {
    const doc = JSON.parse(r.doc) as { rev: string };
    const rev = parseRev(doc.rev);
    const e = byGid.get(r.gid) ?? byGid.set(r.gid, { kind: r.kind as 'vertex' | 'edge', losers: [] }).get(r.gid)!;
    e.losers.push({ rev: rev ? { gen: rev.gen, hash: rev.hash } : { gen: 0, hash: '' }, doc });
  }
  const winners = liveRevs(store, [...byGid.keys()]);
  return [...byGid].map(([gid, e]) => ({ gid, kind: e.kind, winner: winners.get(gid) ?? null, losers: e.losers }));
}

// ---------- the replicator: the pull/push loop + checkpoint + peer client (§9, §5) ----------

/** A replication CHECKPOINT (§9·2): read (`seq` omitted) or write graph-local cursor for a replication
 *  id. Not replicated — pure local job state, so a plain table, `INSERT OR REPLACE` by construction. */
export function checkpoint(store: GraphStore, replicationId: string, seq?: number): number {
  if (seq === undefined)
    return store.query<{ s: number }>('SELECT source_last_seq AS s FROM replication_checkpoint WHERE replication_id = ?', [replicationId])[0]?.s ?? 0;
  store.query('INSERT OR REPLACE INTO replication_checkpoint(replication_id, source_last_seq) VALUES (?, ?)', [replicationId, seq]);
  return seq;
}

/** A replication PEER — the four protocol operations, direction-agnostic. A local peer binds a manager's
 *  own methods; a remote peer is an `Http` caller over the `_` endpoints. The loop drives two of them. */
export interface Peer {
  changes(since: number, limit?: number): Promise<ChangesFeed>;
  revsDiff(request: RevsDiffRequest): Promise<RevsDiffResponse>;
  bulkGet(refs: readonly BulkGetRef[]): Promise<WireChangeSet>;
  bulkDocs(changes: WireChangeSet): Promise<void>;
}

/** A local peer over a manager's own graph — no HTTP hop, just the in-process (or DO-RPC) methods. */
export function localPeer(mgr: GraphManager, id: string): Peer {
  return {
    changes: (since, limit) => mgr.changes(id, since, limit),
    revsDiff: (request) => mgr.revsDiff(id, request),
    bulkGet: (refs) => mgr.bulkGet(id, refs),
    bulkDocs: (changes) => mgr.bulkDocs(id, changes),
  };
}

/** A local peer over a raw store — the same four operations run in-process (the browser Worker, which
 *  holds a store + http but is not a manager). Reuses the shared store-tier functions. */
export function storePeer(store: GraphStore): Peer {
  return {
    changes: async (since, limit) => changesFeed(store, since, limit),
    revsDiff: async (request) => revsDiff(store, request),
    bulkGet: async (refs) => bulkGet(store, refs),
    bulkDocs: async (changes) => applyWire(store, changes),
  };
}

/**
 * A remote peer over the `_` HTTP endpoints of a graph URL, spoken through the injected `Http` seam.
 *
 * **SSRF is closed at the seam, not here.** The `url` comes from a `_replicate` request, so a naive
 * fetch would be a textbook server-side request forgery — but `http` is the SAME injected transport
 * `io()`/`federate` use, and every production entry point wraps it in `allowlistedHttp`
 * (`src/http-allowlist.ts`): empty allowlist ⇒ DENY ALL (fail closed), hostname-matched (never a
 * resolved IP, so DNS-rebinding-proof and Worker-portable), non-http(s) refused, redirects refused. So
 * replication reaches ONLY operator-allowlisted peers, by construction — a raw `http` here (a test's
 * in-memory router) is the only way past it, and that never touches a real network. Do NOT pass an
 * unwrapped transport to this in a runtime path.
 */
export function remotePeer(http: Http, url: string): Peer {
  const base = url.replace(/\/$/, '');
  const post = async <T>(ep: string, body: unknown): Promise<T> => {
    const res = await http(new Request(`${base}/${ep}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    if (!res.ok) throw new Error(`replication: ${ep} on ${base} returned ${res.status}`);
    return res.json() as Promise<T>;
  };
  return {
    changes: async (since, limit) => {
      const q = limit != null && limit > 0 ? `?since=${since}&limit=${limit}` : `?since=${since}`;
      const res = await http(new Request(`${base}/_changes${q}`));
      if (!res.ok) throw new Error(`replication: _changes on ${base} returned ${res.status}`);
      return res.json() as Promise<ChangesFeed>;
    },
    revsDiff: (request) => post('_revs_diff', request),
    bulkGet: (refs) => post('_bulk_get', refs),
    bulkDocs: async (changes) => { await post('_bulk_docs', changes); },
  };
}

/** The default page size for a paged pull (CouchDB's `worker_batch_size` default). Bounds how many change
 *  entries — and thus element bodies — one pass fetches and applies, so no single `applyWire` span
 *  busy-locks the single-threaded store. Follows CouchDB (§4 governing principle); tune by measurement. */
export const DEFAULT_REPLICATION_BATCH = 500;

/** A replicator's checkpoint accessors — read the resume cursor, write it after a page commits. */
export interface Checkpoint { read(): Promise<number>; write(seq: number): Promise<void>; }

/** Pacing controls for {@link runReplication} — the "breakpoints" that keep replication from running at
 *  max speed and busy-locking a single-threaded store (the plan's Phase-5 pacing requirement). */
export interface PaceOptions {
  /** Change entries fetched + applied per page (default {@link DEFAULT_REPLICATION_BATCH}). Bounds each
   *  synchronous apply span. `<= 0` disables paging (one unbounded pass — the pre-5a behaviour). */
  batchSize?: number;
  /** Awaited AFTER each page commits and BEFORE the next — the pacing breakpoint. A scheduler yields the
   *  DO / sleeps here so ordinary requests are served between pages. Default: a microtask yield. */
  pace?: (progress: { batches: number; read: number; written: number; deleted: number }) => Promise<void> | void;
  /** Stop after this many pages even if more remains (the per-wake bound a scheduler re-arms on). Default:
   *  drain fully. When it stops with work still pending, the result's `more` is true. */
  maxBatches?: number;
}

/** {@link ReplicationStats} plus whether the run stopped with work still pending (`maxBatches` reached) —
 *  what a scheduler reads to decide whether to re-arm soon (more) or at the poll interval (caught up). */
export interface ReplicationRunStats extends ReplicationStats { readonly batches: number; readonly more: boolean; }

/** ONE bounded replication page, direction-agnostic (§4·4): read the source feed from the checkpoint (at
 *  most `batchSize` entries), ask the target which revs it lacks, fetch only those bodies, apply them WITH
 *  the deletes, then the conflict-loser leg, and advance the checkpoint. Idempotent. `more` is true when
 *  the page filled (there is likely another page). This is the pacing primitive — one span, bounded by
 *  `batchSize` — that both the one-shot drain and the scheduler's per-wake work are built from. */
export async function runReplicationPass(
  source: Peer, target: Peer, cp: Checkpoint, batchSize = DEFAULT_REPLICATION_BATCH,
): Promise<ReplicationRunStats> {
  const since = await cp.read();
  const limit = batchSize > 0 ? batchSize : undefined;
  const feed = await source.changes(since, limit);
  const live = feed.results.filter((r) => !r.deleted && r.rev);
  const deletes: WireDelete[] = feed.results.filter((r) => r.deleted)
    .map((r) => ({ gid: r.id, rev: r.rev ? JSON.stringify(r.rev) : null, kind: r.kind }));

  const offer: Record<string, WireRev[]> = {};
  for (const r of live) offer[r.id] = [r.rev!];
  const missing = live.length ? await target.revsDiff(offer) : {};
  const refs: BulkGetRef[] = live.filter((r) => missing[r.id]).map((r) => ({ gid: r.id, kind: r.kind }));

  const bodies = refs.length ? await source.bulkGet(refs) : {};
  let written = (bodies.vertices?.length ?? 0) + (bodies.edges?.length ?? 0);
  if (written || deletes.length) await target.bulkDocs({ ...bodies, deletes });

  // Phase B — conflict LOSER propagation (4b-2): the feed advertises each element's shadowed losing
  // leaves (`change.conflicts`). Fetch any the target lacks and apply them SEPARATELY (after the winners,
  // so each is one leaf per gid classified against the now-live winner → shadowed). This is what makes
  // convergence ORDER-INDEPENDENT: a peer that already holds the winner still learns the loser.
  const loserOffer: Record<string, WireRev[]> = {};
  const loserKind = new Map<string, 'vertex' | 'edge'>();
  for (const c of live) for (const lr of c.conflicts ?? []) { (loserOffer[c.id] ??= []).push(lr); loserKind.set(c.id, c.kind); }
  const loserMissing = Object.keys(loserOffer).length ? await target.revsDiff(loserOffer) : {};
  const loserRefs: BulkGetRef[] = [];
  for (const [gid, { missing }] of Object.entries(loserMissing)) for (const r of missing) loserRefs.push({ gid, kind: loserKind.get(gid)!, rev: r.hash });
  if (loserRefs.length) { await target.bulkDocs(await source.bulkGet(loserRefs)); written += loserRefs.length; }

  await cp.write(feed.last_seq);
  // A full page (`limit` rows) means the feed was truncated, so another page likely remains; a short page
  // means the source is drained through `last_seq`.
  const more = limit != null && feed.results.length >= limit;
  return { read: feed.results.length, written, deleted: deletes.length, last_seq: feed.last_seq, batches: 1, more };
}

/** Direction-agnostic replication (§4·4): drive {@link runReplicationPass} in a PAGED, PACED loop until
 *  the source is drained (or `maxBatches` is reached). Each page is bounded by `batchSize` and the loop
 *  awaits `pace()` between pages, so a large-graph pull never busy-locks the store — the pacing substrate
 *  (Phase 5a). The one-shot `_replicate` drains fully (no `maxBatches`); a scheduler bounds it per wake
 *  and re-arms while `more`. Resumable: every page advances the checkpoint, so an interrupted drain
 *  resumes from the last committed page. */
export async function runReplication(
  source: Peer, target: Peer, cp: Checkpoint, opts: PaceOptions = {},
): Promise<ReplicationRunStats> {
  const batchSize = opts.batchSize ?? DEFAULT_REPLICATION_BATCH;
  const pace = opts.pace ?? (() => Promise.resolve());
  const total = { read: 0, written: 0, deleted: 0, last_seq: await cp.read(), batches: 0, more: false };
  for (;;) {
    const p = await runReplicationPass(source, target, cp, batchSize);
    total.read += p.read; total.written += p.written; total.deleted += p.deleted;
    total.last_seq = p.last_seq; total.batches += 1;
    if (!p.more) break; // source drained
    if (opts.maxBatches != null && total.batches >= opts.maxBatches) { total.more = true; break; }
    await pace({ batches: total.batches, read: total.read, written: total.written, deleted: total.deleted });
  }
  return total;
}

/** A deterministic replication id (§5): stable across runs so a re-run resumes from the same checkpoint,
 *  and distinct per (direction, peer, local graph) so two replications never share a cursor. */
export const replicationId = (direction: 'pull' | 'push', remote: string, local: string): string =>
  `${direction}:${remote}:${local}`;

/** Whether a graph ref is a remote `http(s)` URL (→ a `remotePeer`) rather than a local graph id. */
export const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/**
 * The direction-agnostic core (§4·4): resolve `{source|target: url}` to a pull or a push around the given
 * LOCAL peer, then run one pass with the given checkpoint accessors. `{source: url}` PULLS the remote into
 * the local graph; `{target: url}` PUSHES the local graph out. Orchestrated at worker/edge residency (§7)
 * — the remote peer's waits never touch the store tier.
 */
function replicateWith(
  local: Peer, localRef: string, http: Http, opts: ReplicateOptions,
  cp: (replId: string, seq?: number) => number | Promise<number>,
): Promise<ReplicationStats> {
  let source: Peer, target: Peer, direction: 'pull' | 'push', remote: string;
  if (opts.source && isUrl(opts.source)) { direction = 'pull'; remote = opts.source; source = remotePeer(http, opts.source); target = local; }
  else if (opts.target && isUrl(opts.target)) { direction = 'push'; remote = opts.target; source = local; target = remotePeer(http, opts.target); }
  else return Promise.reject(new Error('_replicate needs exactly one remote http(s) `source` or `target`'));
  const replId = replicationId(direction, remote, localRef);
  return runReplication(source, target, {
    read: async () => cp(replId),
    write: async (seq) => { await cp(replId, seq); },
  });
}

/** A one-shot replication for `localId` via a manager's own methods (Bun in-process, CF over DO RPC) —
 *  the local peer, checkpoint, and http all reached through the manager. */
export function managerReplicate(mgr: GraphManager, http: Http, localId: string, opts: ReplicateOptions): Promise<ReplicationStats> {
  return replicateWith(localPeer(mgr, localId), localId, http, opts, (replId, seq) => mgr.checkpoint(localId, replId, seq));
}

/** A one-shot replication run entirely over a raw store + http (the browser Worker) — the local peer,
 *  checkpoint and store all in-process, only the remote peer crossing the wire. */
export function storeReplicate(store: GraphStore, localRef: string, http: Http, opts: ReplicateOptions): Promise<ReplicationStats> {
  return replicateWith(storePeer(store), localRef, http, opts, (replId, seq) => checkpoint(store, replId, seq));
}
