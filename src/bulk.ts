// The bulk loader — N elements into one graph's tables, through set-based `insertSet` (src/setwrite.ts).
//
// Design: docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §2. Measured there: seeding the
// grateful-dead graph by write traversals is 5,918 ms and 98,198 statements, of which only 17% is
// spent inside SQLite. The cost is JS per-element round-tripping — a whole read plan compiled and run
// per edge ENDPOINT, a response framed for every element, and every property read back to echo it.
// So a bulk path does not win by "multi-row INSERT". It wins by **not compiling a traversal per
// element, not framing a response, and not reading back what it just wrote.**
//
// Four invariants, and the third is the one that makes this safe to have at all:
//
//  1. **No statement's bind list is a function of row count** — every insert is one relational
//     `insertSet` (src/setwrite.ts), whose N rows cross as ONE JSON bind exploded by `json_each`, so
//     nothing here can breach a Durable Object's 100-bind cap. The collision-check reads land the
//     same way — one `json_each(?)` membership, never an `IN (…)` sized by the batch.
//  2. **Runtime-uniform.** No ATTACH, no second database, no literal inlining, no Bun-only branch:
//     the same statements run on `bun:sqlite` and on DO storage.
//  3. **It REUSES the write path's semantics, never reimplements them.** The value channel is
//     `propertyValueBind` and the FTS rows are `propertyFtsRows` — the same functions
//     `applyVertexProperty` calls. A loader that re-derives either is a silent storage/index
//     divergence, and `test/bulk.test.ts` pins the equivalence table-by-table.
//  4. **The loader mints ids.** Landing a property row and its `property_fts` rows in one pass needs
//     `pid` BEFORE the insert, and multi-row `RETURNING` has no defined row order — so ids come from
//     one `SELECT max(id)` per table, not from a statement per row.
//
// TWO COLLISION POLICIES (`onCollision`). APPEND (`'error'`, default) makes no match-vs-create
// decision — a key that already exists FAILS CLOSED. UPSERT (`'replace'`) resolves the interleaved
// read/write as a WHOLE-BATCH decision rather than a per-element one: buffer raw, then in ONE pass
// (`resolveReplace`) dedup by key (last-write-wins), read which keys already exist, wipe the matched
// elements' owned rows, and land the incoming definition — a set-based form, never a per-element loop.
// The match domain is the PRE-BATCH snapshot: a row matches what the graph held before the batch, not
// a sibling row, which is what keeps the whole thing one pass. `docs/outstanding-work.md` (set-based
// writes) records the semantics.
//
// Appending into a NON-EMPTY graph is supported through `idPolicy: 'remap'` (plan doc §7): local
// rowids have no cross-graph meaning, so a second graph's ids collide for no reason, and remapping is
// one pass with no schema change. Under the default `'preserve'` a collision fails closed with a
// message naming the option — never a silent merge, and never a raw UNIQUE constraint error.
import type { GraphStore } from './storage.ts';
import { mintGid } from './uuid.ts';
import { deleteMembers, insertSet, type SetColumn } from './setwrite.ts';
import { gremlinTypeOf, propertyValueBind, type CanonicalType, type TypeNode } from './gremlin/types.ts';
import { PROPERTY_FTS_COLUMNS, propertyFtsRows, type OwnerElem } from './services/fts-index.ts';

/** One property instance to land. `vtype` defaults to what the JS value infers to (`gremlinTypeOf`),
 *  which is what an untyped reader (CSV, plain JSON) can offer; a typed reader (GraphSON) passes the
 *  canonical type it read, and `typeNode` carries per-leaf types for a collection. `id` lets a format
 *  that ships VertexProperty ids (typed GraphSON does) preserve them. */
export interface BulkProperty {
  readonly key: string;
  readonly value: unknown;
  readonly vtype?: CanonicalType | null;
  readonly typeNode?: TypeNode | null;
  readonly meta?: Record<string, unknown> | null;
  readonly id?: number;
}

/** A vertex to land. A NUMBER id becomes the rowid directly (so a reference fixture's ids survive);
 *  a STRING id becomes `nodes.uid` with a minted rowid — the same rule `insertRow` follows for
 *  `property(T.id, …)`. Absent = minted. */
export interface BulkVertex {
  readonly id?: number | string | null;
  readonly labels: readonly string[];
  readonly properties?: readonly BulkProperty[];
  /** Global identity (§6·1), a 32-char hex uuid_v7. Present → PRESERVED verbatim (a replicated element
   *  keeps its gid across peers); absent → a fresh one is minted at load. Same preserve-or-mint policy
   *  the document `id` follows. */
  readonly gid?: string | null;
}

/** An edge to land. `src`/`tgt` name vertices by the id the SOURCE used — a number matches a landed
 *  numeric id, a string matches a landed `uid`. Both must already be known to this loader (its own
 *  landed vertices) or present in the store as a rowid. */
export interface BulkEdge {
  readonly id?: number | string | null;
  readonly label: string;
  readonly src: number | string;
  readonly tgt: number | string;
  readonly properties?: readonly BulkProperty[];
  /** Global identity (§6·1) — preserve-or-mint, as {@link BulkVertex.gid}. */
  readonly gid?: string | null;
}

/**
 * How a load resolves the ids it is handed.
 *
 *   `'preserve'` (default) — a NUMERIC source id becomes the rowid, so a reference fixture's ids
 *     land exactly (`V(1)` means what the file meant). Correct for a load into an empty or disjoint
 *     graph, which is what phases 1–6 need; a collision with an existing element FAILS CLOSED.
 *   `'remap'` — every element takes a MINTED rowid and its source id is kept as `uid`. This is what
 *     makes a load into a NON-EMPTY graph work (plan doc §7): `labels.id` and `nodes.id`/`edges.id`
 *     are local rowids with no cross-graph meaning, so two graphs' ids collide for no reason. Edge
 *     endpoints resolve through the same source→rowid map either way, so nothing else changes.
 *   `'renumber'` — mint the rowid and DROP the source id. The same offset without the provenance, for
 *     the case `'remap'` structurally cannot serve: `nodes.uid`/`edges.uid` are UNIQUE (they are the
 *     TinkerPop user-supplied id), so the SAME source graph can only be remapped into a target once.
 *     Loading it twice, or loading two sources that share an id space, needs the ids dropped.
 *
 * What `'remap'` preserves is id PROVENANCE, not id LOOKUP: `uid` is a TEXT column, so a remapped
 * element is `V('3')`, not `V(3)`. That asymmetry is the schema's (`COALESCE(uid, id)` over a TEXT
 * uid), not this loader's, and it is the honest cost of not widening the primary key — which §7
 * refuted on measurement.
 */
export type IdPolicy = 'preserve' | 'remap' | 'renumber';

/**
 * What a load does when an incoming element's NATURAL ID (a numeric id → `nodes`/`edges.id`, a string
 * id → `.uid`) already names an element — pre-existing in the graph OR appearing twice in one batch,
 * which are the same event (a match by that key) resolved the same way.
 *
 *   `'error'` (default) — a collision FAILS CLOSED, naming the element and the option (`assertNoCollisions`).
 *     The append modes (phases 1–7) that never match keep exactly this behaviour.
 *   `'replace'` — LAST WRITE WINS: the matched element's definition is replaced by the newcomer's.
 *     For a VERTEX this wipes its owned property rows (properties, labels, cardinality, FTS text) and
 *     re-lands the incoming ones, keeping the vertex's rowid and its incident EDGES — so a re-import
 *     refreshes data without severing relationships (mirrors `mergeV`'s onMatch). For an EDGE, which
 *     nothing references, it is a full delete-and-reinsert. Within one batch, duplicate keys collapse
 *     to the LAST definition. This is the idempotent re-import mode: it matches by natural id and is
 *     independent of `idPolicy`'s minting.
 */
export type CollisionPolicy = 'error' | 'replace';

export interface BulkOptions {
  readonly idPolicy?: IdPolicy;
  readonly onCollision?: CollisionPolicy;
}

export interface BulkStats {
  readonly vertices: number;
  readonly edges: number;
  readonly properties: number;
  readonly ftsRows: number;
  /** Statements issued. The headline number the plan doc measures against per-element writes. */
  readonly statements: number;
}

/** Rows buffered for one table: `jsonb(?)` columns need their own fixed-shape statement, so a
 *  property batch splits by whether the VALUE is a collection. */
interface PropertyRows { scalar: unknown[][]; collection: unknown[][] }

/** LAST-WRITE-WINS dedup by natural id, preserving first-seen order. A NUMERIC id keys a different
 *  namespace from a STRING id (the `id` column vs `uid`), so `1` and `"1"` never collapse together; an
 *  element with no id has no key and is always kept (it can neither match nor collide). */
function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => number | string | null | undefined): T[] {
  const keyed = new Map<string, T>();
  const anonymous: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === undefined) anonymous.push(item);
    else keyed.set(typeof key === 'number' ? `n${key}` : `s${key}`, item);
  }
  return [...keyed.values(), ...anonymous];
}

const VERTEX_PROP_COLUMNS = ['id', 'node', 'key', 'value', 'vtype', 'meta'] as const;
const EDGE_PROP_COLUMNS = ['id', 'edge', 'key', 'value', 'vtype'] as const;

/**
 * Buffer elements, then land them in one chunked pass per table.
 *
 * Add vertices before the edges that reference them (every format here is naturally ordered that
 * way: a GraphSON adjacency line carries its own vertex, and a CSV vertex file precedes its edge
 * file). An edge whose endpoint this loader has not seen is resolved against the store at `flush`,
 * and fails closed if it is not there either.
 */
export class BulkLoader {
  private readonly labels = new Map<string, number>();
  /** source id (stringified) → landed rowid, for edge endpoint resolution. */
  private readonly vertexIds = new Map<string, number>();
  private nodeRows: unknown[][] = [];
  private vertexLabelRows: unknown[][] = [];
  private vertexProps: PropertyRows = { scalar: [], collection: [] };
  private edgeRows: unknown[][] = [];
  private edgeProps: PropertyRows = { scalar: [], collection: [] };
  private ftsRows: unknown[][] = [];
  /** Edges whose endpoints were not yet known when they were added — resolved at `flush`, AFTER the
   *  vertices land. `uid` is carried rather than re-derived: it is `idOf`'s output, so it already
   *  reflects the id POLICY (under `'remap'` a numeric source id becomes a uid, under `'renumber'`
   *  nothing does), which a second `typeof edge.id === 'string'` test at flush time cannot know. */
  private pendingEdges: Array<{ edge: BulkEdge; id: number; uid: string | null; gid: string }> = [];
  /** Under `onCollision: 'replace'` the elements are buffered RAW and resolved at `flush`: a rowid
   *  cannot be assigned until a batched read has decided which keys already exist, and an in-batch
   *  duplicate must collapse to its LAST definition before anything is materialized. The append modes
   *  leave these empty and buffer eagerly as before. */
  private rawVertices: BulkVertex[] = [];
  private rawEdges: BulkEdge[] = [];
  private nextNode: number;
  private nextEdge: number;
  private nextVertexProp: number;
  private nextEdgeProp: number;
  private counts = { vertices: 0, edges: 0, properties: 0, statements: 0 };
  private readonly emptyTarget: boolean;

  /** The resolved policy — `options.idPolicy` defaults to `'preserve'` HERE rather than at each use,
   *  because a `=== 'preserve'` test against an absent option silently skipped the collision check. */
  private readonly policy: IdPolicy;
  private readonly onCollision: CollisionPolicy;

  constructor(private store: GraphStore, options: BulkOptions = {}) {
    this.policy = options.idPolicy ?? 'preserve';
    this.onCollision = options.onCollision ?? 'error';
    // One query per table, not per row (invariant 4). `max(id)` of an empty table is NULL → start 1.
    this.nextNode = this.maxOf('nodes') + 1;
    this.nextEdge = this.maxOf('edges') + 1;
    this.nextVertexProp = this.maxOf('vertex_properties') + 1;
    this.nextEdgeProp = this.maxOf('edge_properties') + 1;
    this.counts.statements = 4;
    // Was this graph empty when the load began? If so no collision check is needed at all — see
    // assertNoCollisions. Read from the cursors, so it costs no extra statement.
    this.emptyTarget = this.nextNode === 1 && this.nextEdge === 1;
  }

  private maxOf(table: string): number {
    return this.store.query<{ m: number | null }>(`SELECT max(id) AS m FROM ${table}`)[0].m ?? 0;
  }

  /** Intern a label name, memoized — the per-element path re-interns for every element (8,857
   *  statements for grateful-dead, one per element); this issues one per DISTINCT label. */
  private labelId(name: string): number {
    const known = this.labels.get(name);
    if (known !== undefined) return known;
    const id = this.store.labelId(name);
    this.counts.statements++;
    this.labels.set(name, id);
    return id;
  }

  /** Split an id into (rowid, uid). Under `'preserve'` this is exactly what the per-element write
   *  path does for `property(T.id, …)`: a number IS the rowid, a string is the uid. Under `'remap'`
   *  the rowid is always minted and the source id — number or string — is kept as the uid, so the
   *  provenance survives a collision-free offset. */
  private idOf(id: number | string | null | undefined, next: () => number): { rowid: number; uid: string | null } {
    if (this.policy === 'renumber') return { rowid: next(), uid: null };
    if (this.policy === 'remap')
      return { rowid: next(), uid: id === null || id === undefined ? null : String(id) };
    if (typeof id === 'number') return { rowid: id, uid: null };
    return { rowid: next(), uid: typeof id === 'string' ? id : null };
  }

  /** Buffer one vertex; returns its rowid (0 under `'replace'`, where the rowid is decided at `flush`
   *  and no caller here reads the return anyway). */
  vertex(v: BulkVertex): number {
    if (this.onCollision === 'replace') { this.rawVertices.push(v); return 0; }
    const { rowid, uid } = this.idOf(v.id, () => this.nextNode++);
    // A numeric id may sit past the mint cursor, and the next minted id must not collide with it.
    if (rowid >= this.nextNode) this.nextNode = rowid + 1;
    this.bufferVertex(rowid, uid, v, true);
    return rowid;
  }

  /** Land one vertex's rows into the buffers, given an already-resolved (rowid, uid). `pushRow` is
   *  false for a REPLACE match, whose `nodes` row already exists and is kept (rowid + edges survive) —
   *  only its owned property rows are wiped and re-landed. */
  private bufferVertex(rowid: number, uid: string | null, v: BulkVertex, pushRow: boolean): void {
    // gid is minted only for a fresh row; a REPLACE match keeps its existing gid (immutable identity),
    // so no gid is recomputed when the `nodes` row is not re-pushed.
    if (pushRow) this.nodeRows.push([rowid, uid, v.gid ?? mintGid()]);
    if (v.id !== null && v.id !== undefined) this.vertexIds.set(String(v.id), rowid);
    for (const name of new Set(v.labels)) this.vertexLabelRows.push([rowid, this.labelId(name)]);
    for (const p of v.properties ?? [])
      this.property(this.vertexProps, 'node', rowid, p, () => p.id ?? this.nextVertexProp++, 'vertex');
    this.counts.vertices++;
  }

  /** Buffer one edge; returns its rowid (0 under `'replace'`, as `vertex`). */
  edge(e: BulkEdge): number {
    if (this.onCollision === 'replace') { this.rawEdges.push(e); return 0; }
    const { rowid, uid } = this.idOf(e.id, () => this.nextEdge++);
    if (rowid >= this.nextEdge) this.nextEdge = rowid + 1;
    this.bufferEdge(rowid, uid, e);
    return rowid;
  }

  /** Land one edge's rows into the buffers, given an already-resolved (rowid, uid). Endpoints resolve
   *  now when the source vertex is known, at `flush` otherwise. */
  private bufferEdge(rowid: number, uid: string | null, e: BulkEdge): void {
    const src = this.vertexIds.get(String(e.src));
    const tgt = this.vertexIds.get(String(e.tgt));
    // Mint the gid ONCE here (not at flush) so the deferred path carries the same value it would land.
    const gid = e.gid ?? mintGid();
    if (src !== undefined && tgt !== undefined) this.edgeRows.push([rowid, uid, src, this.labelId(e.label), tgt, gid]);
    else this.pendingEdges.push({ edge: e, id: rowid, uid, gid });
    for (const p of e.properties ?? [])
      this.property(this.edgeProps, 'edge', rowid, p, () => p.id ?? this.nextEdgeProp++, 'edge');
    this.counts.edges++;
  }

  /** One property row plus its FTS rows, both through the shared write-path helpers (invariant 3). */
  private property(
    into: PropertyRows, ownerElem: OwnerElem, owner: number,
    p: BulkProperty, mintId: () => number, kind: 'vertex' | 'edge',
  ): void {
    const vtype = p.vtype !== undefined ? p.vtype : gremlinTypeOf(p.value, p.typeNode ?? null);
    const { stored, collection } = propertyValueBind(p.value, vtype, p.typeNode ?? null);
    const pid = mintId();
    if (kind === 'vertex') {
      if (pid >= this.nextVertexProp) this.nextVertexProp = pid + 1;
      const meta = p.meta ? JSON.stringify(p.meta) : null;
      (collection ? into.collection : into.scalar).push([pid, owner, p.key, stored, vtype, meta]);
    } else {
      if (pid >= this.nextEdgeProp) this.nextEdgeProp = pid + 1;
      if (p.meta) throw new Error(`meta-properties are not valid on an edge property (edge ${owner}, key ${p.key})`);
      (collection ? into.collection : into.scalar).push([pid, owner, p.key, stored, vtype]);
    }
    this.ftsRows.push(...propertyFtsRows(ownerElem, pid, owner, p.key, p.value, p.typeNode ?? null));
    this.counts.properties++;
  }

  /**
   * Land everything buffered. Idempotent (the buffers empty), so a streaming reader may flush per
   * chunk of input and a caller that forgets to flush loses nothing but the last batch.
   *
   * Table order follows the foreign keys — nodes before vertex_labels/vertex_properties, edges before
   * edge_properties — and property_fts last, since nothing references it.
   */
  flush(): BulkStats {
    // REPLACE resolves the raw buffer into rowids and wipes matched elements' subtrees BEFORE landing;
    // it owns collision handling, so the append-only collision CHECK is exactly what it replaces.
    if (this.onCollision === 'replace') this.resolveReplace();
    else this.assertNoCollisions();
    this.land('nodes', ['id', 'uid', 'gid'], this.nodeRows);
    this.land('vertex_labels', ['node', 'label'], this.vertexLabelRows);
    this.land('vertex_properties', VERTEX_PROP_COLUMNS, this.vertexProps.scalar);
    this.land('vertex_properties', VERTEX_PROP_COLUMNS, this.vertexProps.collection, true);

    // Endpoints resolve AFTER the vertices land, so a store lookup can see this batch's own rows —
    // which is what makes an edge referencing a MINTED id (no source id to remember it by) resolvable
    // at all, not just one referencing a source id.
    for (const { edge, id, uid, gid } of this.pendingEdges) {
      const src = this.resolveEndpoint(edge.src, edge);
      const tgt = this.resolveEndpoint(edge.tgt, edge);
      this.edgeRows.push([id, uid, src, this.labelId(edge.label), tgt, gid]);
    }
    this.pendingEdges = [];
    this.land('edges', ['id', 'uid', 'src', 'label', 'tgt', 'gid'], this.edgeRows);
    this.land('edge_properties', EDGE_PROP_COLUMNS, this.edgeProps.scalar);
    this.land('edge_properties', EDGE_PROP_COLUMNS, this.edgeProps.collection, true);
    const fts = this.ftsRows.length;
    this.land('property_fts', PROPERTY_FTS_COLUMNS, this.ftsRows);

    this.nodeRows = []; this.vertexLabelRows = []; this.edgeRows = [];
    this.vertexProps = { scalar: [], collection: [] };
    this.edgeProps = { scalar: [], collection: [] };
    this.ftsRows = [];
    this.rawVertices = []; this.rawEdges = [];
    return { ...this.counts, ftsRows: fts };
  }

  /**
   * RESOLVE THE 'replace' RAW BUFFER (last-write-wins), then land through the same buffers `flush`
   * reads. Three passes, and the ORDER is the whole of the correctness:
   *
   *  1. **Dedup by natural id, keeping the LAST** — an in-batch duplicate collapses to its final
   *     definition, so only one set of rows is ever materialized for a key. An element with no id has
   *     no key: it can neither match nor collide, so it is always a fresh insert.
   *  2. **Resolve which keys already exist**, in ONE batched read per element kind and column
   *     (`json_each` membership, never a per-element lookup). A matched vertex REUSES its existing
   *     rowid — which is what keeps its incident edges valid — and does not re-land its `nodes` row; a
   *     matched edge is deleted whole (nothing references it) and re-inserted fresh.
   *  3. **Wipe matched elements' owned rows BEFORE `flush` lands the new ones** — a vertex's
   *     properties/labels/cardinality/FTS, an edge's row/properties/FTS — so old and new never coexist.
   *
   * Vertices are placed before edges so an edge's endpoints resolve against this batch's assigned
   * rowids (`vertexIds`), matched or minted.
   */
  private resolveReplace(): void {
    const vertices = dedupeByKey(this.rawVertices, (v) => v.id);
    const numericV = vertices.filter((v) => typeof v.id === 'number').map((v) => v.id as number);
    const uidV = vertices.filter((v) => typeof v.id === 'string').map((v) => v.id as string);
    const existingId = this.existing('nodes', 'id', numericV);
    const existingUid = this.existingUid('nodes', uidV);

    const matchedVertices: number[] = [];
    for (const v of vertices) {
      if (typeof v.id === 'number') {
        const matched = existingId.has(v.id);
        if (matched) matchedVertices.push(v.id);
        if (v.id >= this.nextNode) this.nextNode = v.id + 1;
        this.bufferVertex(v.id, null, v, !matched);
      } else if (typeof v.id === 'string') {
        const rowid = existingUid.get(v.id);
        if (rowid !== undefined) { matchedVertices.push(rowid); this.bufferVertex(rowid, v.id, v, false); }
        else this.bufferVertex(this.nextNode++, v.id, v, true);
      } else {
        this.bufferVertex(this.nextNode++, null, v, true);
      }
    }
    // A vertex keeps its rowid and edges; only its owned property rows go, to be re-landed by `flush`.
    this.wipeVertexChildren(matchedVertices);

    const edges = dedupeByKey(this.rawEdges, (e) => e.id);
    const numericE = edges.filter((e) => typeof e.id === 'number').map((e) => e.id as number);
    const uidE = edges.filter((e) => typeof e.id === 'string').map((e) => e.id as string);
    const existingEId = this.existing('edges', 'id', numericE);
    const existingEUid = this.existingUid('edges', uidE);

    const matchedEdges: number[] = [];
    for (const e of edges) {
      if (typeof e.id === 'number') {
        if (existingEId.has(e.id)) matchedEdges.push(e.id);
        if (e.id >= this.nextEdge) this.nextEdge = e.id + 1;
        this.bufferEdge(e.id, null, e);
      } else if (typeof e.id === 'string') {
        const old = existingEUid.get(e.id);
        if (old !== undefined) matchedEdges.push(old);
        this.bufferEdge(this.nextEdge++, e.id, e);
      } else {
        this.bufferEdge(this.nextEdge++, null, e);
      }
    }
    // An edge is referenced by nothing, so a match is a full delete-and-reinsert: drop the old row.
    this.wipeEdges(matchedEdges);
  }

  /** The subset of `ids` that already exist in `table.column`, in ONE `json_each` read. */
  private existing(table: 'nodes' | 'edges', column: 'id', ids: readonly number[]): Set<number> {
    if (!ids.length) return new Set();
    this.counts.statements++;
    return new Set(this.store.query<{ v: number }>(
      `SELECT ${column} AS v FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)]).map((r) => r.v));
  }

  /** The existing rowid for each of `uids` that is already present — one `json_each` read. */
  private existingUid(table: 'nodes' | 'edges', uids: readonly string[]): Map<string, number> {
    if (!uids.length) return new Map();
    this.counts.statements++;
    return new Map(this.store.query<{ id: number; uid: string }>(
      `SELECT id, uid FROM ${table} WHERE uid IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(uids)]).map((r) => [r.uid, r.id] as const));
  }

  /** Remove a matched vertex's owned rows — everything but the `nodes` row itself and its edges — so
   *  `flush` re-lands the incoming definition. Each delete is one `json_each` bind. */
  private wipeVertexChildren(ids: readonly number[]): void {
    if (!ids.length) return;
    this.wipeFts('node', ids);
    this.counts.statements += deleteMembers(this.store, 'vertex_properties', 'node', ids)
      + deleteMembers(this.store, 'vertex_labels', 'node', ids)
      + deleteMembers(this.store, 'vertex_property_cardinality', 'node', ids);
  }

  /** Delete a matched edge whole — its row, its properties, its FTS text. */
  private wipeEdges(ids: readonly number[]): void {
    if (!ids.length) return;
    this.wipeFts('edge', ids);
    this.counts.statements += deleteMembers(this.store, 'edge_properties', 'edge', ids)
      + deleteMembers(this.store, 'edges', 'id', ids);
  }

  /** The FTS sweep is scoped by owner ELEMENT KIND as well as owner id (a node rowid and an edge rowid
   *  can numerically coincide), so it carries the `owner_elem` predicate `deleteMembers` cannot. */
  private wipeFts(ownerElem: OwnerElem, ids: readonly number[]): void {
    this.store.query(
      `DELETE FROM property_fts WHERE owner_elem=? AND owner IN (SELECT value FROM json_each(?))`,
      [ownerElem, JSON.stringify([...ids])]);
    this.counts.statements++;
  }

  /**
   * An id or uid this batch claims may already exist — the load-into-non-empty case. SQLite would
   * report `UNIQUE constraint failed: nodes.id`, which is true but says nothing about what to do;
   * this names the element, the state and the option that resolves it.
   *
   * SKIPPED ENTIRELY when the target was EMPTY at construction, which is every seeding load: nothing
   * can collide with rows that do not exist, so the common path pays nothing. Otherwise it is two
   * chunked `SELECT`s per table (~6% more statements on a 4,000-element batch), which buys turning a
   * production-shaped mystery into an instruction.
   *
   * PENDING edges are checked alongside the resolved ones. They are not in `edgeRows` yet (their
   * endpoints resolve after the vertices land), and leaving them out meant an edge-only load — which
   * is exactly what a CSV edge FILE is, and what no earlier format produced — reported SQLite's raw
   * `UNIQUE constraint failed` instead of naming the policy that resolves it.
   */
  private assertNoCollisions(): void {
    if (this.emptyTarget) return;
    const edges = [...this.edgeRows, ...this.pendingEdges.map(({ id, uid }) => [id, uid])];
    for (const [table, rows] of [['nodes', this.nodeRows], ['edges', edges]] as const) {
      // A minted rowid is past max(id) by construction, so only an EXPLICIT id can collide.
      if (this.policy === 'preserve') this.assertFree(table, 'id', rows.map((r) => r[0]),
        "load with { idPolicy: 'remap' } to mint fresh ids and keep the source ids as uid");
      // uid is UNIQUE — the TinkerPop user-supplied id — so remapping the same source twice collides.
      this.assertFree(table, 'uid', rows.map((r) => r[1]).filter((u) => u !== null),
        "load with { idPolicy: 'renumber' } to drop the source ids, which uid cannot hold twice");
    }
  }

  private assertFree(table: string, column: 'id' | 'uid', values: readonly unknown[], remedy: string): void {
    if (!values.length) return;
    // The batch's ids cross as ONE JSON bind exploded by `json_each` — a membership set sized by DATA
    // is a single value, never an `IN (…)` list the DO bind cap would reject (§6·2). `json_each` routes
    // a JSON number to the INTEGER `id` and a JSON string to the TEXT `uid` by its own storage class,
    // exactly as a `V($ids)` id list does.
    //
    // `MIN` rather than `LIMIT 1`: which colliding id the message NAMES is user-visible, and a bare
    // LIMIT 1 names whichever the scan reached first — so the same failed load reported a different id
    // depending on SQLite's scan direction (`mise run test:perturbed`). The lowest one is stable and is
    // the one a user re-running the load will hit first anyway.
    const clash = this.store.query<{ v: unknown }>(
      `SELECT MIN(${column}) AS v FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`,
      [JSON.stringify([...values])])[0];
    this.counts.statements++;
    if (clash !== undefined && clash.v !== null)
      throw new Error(`bulk load: ${table} ${column} ${JSON.stringify(clash.v)} already exists in this graph — ${remedy}`);
  }

  /** A batch of rows for one table, as ONE relational `Insert` (src/setwrite.ts). `jsonbValue` is the
   *  collection shape — its `value` column crosses as `jsonb(<text>)` rather than a bare cell, the same
   *  way `meta` always does. The scalar and collection batches stay SEPARATE calls because a scalar's
   *  storage class must be the JSON value's own (`42` → INTEGER), which every numeric order/range
   *  predicate rides on, while a collection's is a parsed blob; one statement cannot spell both cells. */
  private land(table: string, columns: readonly string[], rows: unknown[][], jsonbValue = false): void {
    // A JSONB column carries its JSON TEXT wrapped in `jsonb(<text>)`. `meta` always rides that shape —
    // `jsonb(NULL)` is NULL (verified), so a nullable JSONB column needs no second batch.
    const isJsonb = (c: string) => c === 'meta' || c === 'rev' || (jsonbValue && c === 'value');
    const isBlob = (c: string) => c === 'gid'; // a raw BLOB, crossed as hex + unhex()'d (setwrite.ts)
    const spec: SetColumn[] = columns.map((c) => ({
      name: c, type: isJsonb(c) || isBlob(c) ? 'blob' : 'any', jsonb: isJsonb(c), blob: isBlob(c),
    }));
    this.counts.statements += insertSet(this.store, table, spec, rows);
  }

  private resolveEndpoint(id: number | string, edge: BulkEdge): number {
    const landed = this.vertexIds.get(String(id));
    if (landed !== undefined) return landed;
    const col = typeof id === 'number' ? 'id' : 'uid';
    const row = this.store.query<{ id: number }>(`SELECT id FROM nodes WHERE ${col}=?`, [id])[0];
    this.counts.statements++;
    if (!row) throw new Error(`bulk load: edge ${String(edge.id ?? edge.label)} references unknown vertex ${String(id)}`);
    this.vertexIds.set(String(id), row.id);
    return row.id;
  }
}

/** Load a whole graph in one call — the convenience form over `BulkLoader`. Vertices land first, so
 *  edges resolve their endpoints without a store lookup. */
export function loadBulk(
  store: GraphStore, vertices: Iterable<BulkVertex>, edges: Iterable<BulkEdge> = [], options?: BulkOptions,
): BulkStats {
  const loader = new BulkLoader(store, options);
  for (const v of vertices) loader.vertex(v);
  for (const e of edges) loader.edge(e);
  return loader.flush();
}

/**
 * A BulkLoader that lands and RESETS every `batchSize` elements — the loader a STREAMING reader
 * (formats/graphson.ts, formats/csv.ts over `io()`) drains through, so peak memory is one batch's
 * buffered rows rather than the whole document. A `BulkLoader` alone buffers every row AND grows an
 * unbounded source-id→rowid map until its single `flush()`; that is fine for an in-memory document
 * but is exactly the 10 GB Durable Object OOM this whole path exists to avoid.
 *
 * It works by CUTTING a fresh `BulkLoader` per batch. A fresh loader re-reads its `max(id)` cursors
 * from the store (four statements, amortized to nothing over a large batch) and starts with empty
 * buffers and an empty id cache — so an edge in a later batch resolves its endpoints against the
 * rows PRIOR batches already landed (`BulkLoader.resolveEndpoint`), never against an in-memory map
 * that would have to hold every vertex. That is why a streaming GraphSON load runs vertices to
 * completion FIRST and edges second (formats/graphson.ts `loadGraphsonStreaming`): by the time any
 * edge is seen, every vertex it could name is already in the store.
 *
 * `onCollision:'replace'` is refused: last-write-wins is a WHOLE-BATCH resolution (dedup by key, one
 * batched existence read, wipe-then-reland) that cannot span independently-flushed batches. A
 * caller that needs replace holds the document in memory and uses `BulkLoader`/`loadBulk` directly.
 */
export class BatchingLoader {
  private loader: BulkLoader;
  private pending = 0;
  private finished = false;
  private readonly totals = { vertices: 0, edges: 0, properties: 0, ftsRows: 0, statements: 0 };

  constructor(
    private readonly store: GraphStore,
    private readonly options: BulkOptions = {},
    private readonly batchSize = 5000,
  ) {
    if (options.onCollision === 'replace')
      throw new Error('BatchingLoader does not support onCollision:"replace" — a whole-batch '
        + 'last-write-wins cannot span streamed batches; load an in-memory document with loadBulk for replace');
    this.loader = new BulkLoader(store, options);
  }

  vertex(v: BulkVertex): void { this.loader.vertex(v); this.tick(); }
  edge(e: BulkEdge): void { this.loader.edge(e); this.tick(); }

  private tick(): void {
    if (++this.pending >= this.batchSize) this.cut();
  }

  /** Land the current batch and start a fresh loader. */
  private cut(): void {
    this.accumulate(this.loader.flush());
    this.loader = new BulkLoader(this.store, this.options);
    this.pending = 0;
  }

  private accumulate(s: BulkStats): void {
    this.totals.vertices += s.vertices;
    this.totals.edges += s.edges;
    this.totals.properties += s.properties;
    this.totals.ftsRows += s.ftsRows;
    this.totals.statements += s.statements;
  }

  /** Land the final batch and return the whole load's stats. Idempotent — a second call flushes
   *  nothing (the loader's `counts` are cumulative, so re-accumulating them would double-count). */
  done(): BulkStats {
    if (!this.finished) {
      this.accumulate(this.loader.flush());
      this.finished = true;
    }
    return { ...this.totals };
  }
}
