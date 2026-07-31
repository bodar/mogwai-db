// The bulk loader — N elements into one graph's tables, through RowBatch.
//
// Design: docs/2026-07-31-bulk-transfer-and-io-substrate-plan.md §2. Measured there: seeding the
// grateful-dead graph by write traversals is 5,918 ms and 98,198 statements, of which only 17% is
// spent inside SQLite. The cost is JS per-element round-tripping — a whole read plan compiled and run
// per edge ENDPOINT, a response framed for every element, and every property read back to echo it.
// So a bulk path does not win by "multi-row INSERT". It wins by **not compiling a traversal per
// element, not framing a response, and not reading back what it just wrote.**
//
// Four invariants, and the third is the one that makes this safe to have at all:
//
//  1. **No statement's bind list is a function of row count** — every insert goes through
//     `insertRows` (src/rowbatch.ts), so nothing here can breach a Durable Object's 100-bind cap.
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
// SCOPE: append into an EMPTY-or-disjoint graph. There is no match-vs-create decision here, which is
// exactly why phase 1 can exist without resolving the interleaved read/write item (plan doc §9): an
// upsert mode WOULD inherit it, and should be built as this loader's second mode rather than as a fix
// inside the per-element `run`. A collision with an existing id fails closed rather than merging.
import type { GraphStore } from './storage.ts';
import { insertRows } from './rowbatch.ts';
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
  private pendingEdges: Array<{ edge: BulkEdge; id: number }> = [];
  private nextNode: number;
  private nextEdge: number;
  private nextVertexProp: number;
  private nextEdgeProp: number;
  private counts = { vertices: 0, edges: 0, properties: 0, statements: 0 };

  constructor(private store: GraphStore) {
    // One query per table, not per row (invariant 4). `max(id)` of an empty table is NULL → start 1.
    this.nextNode = this.maxOf('nodes') + 1;
    this.nextEdge = this.maxOf('edges') + 1;
    this.nextVertexProp = this.maxOf('vertex_properties') + 1;
    this.nextEdgeProp = this.maxOf('edge_properties') + 1;
    this.counts.statements = 4;
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

  /** Split an id into (rowid, uid) exactly as the per-element write path does. */
  private idOf(id: number | string | null | undefined, next: () => number): { rowid: number; uid: string | null } {
    if (typeof id === 'number') return { rowid: id, uid: null };
    return { rowid: next(), uid: typeof id === 'string' ? id : null };
  }

  /** Buffer one vertex; returns its rowid. */
  vertex(v: BulkVertex): number {
    const { rowid, uid } = this.idOf(v.id, () => this.nextNode++);
    // A numeric id may sit past the mint cursor, and the next minted id must not collide with it.
    if (rowid >= this.nextNode) this.nextNode = rowid + 1;
    this.nodeRows.push([rowid, uid]);
    if (v.id !== null && v.id !== undefined) this.vertexIds.set(String(v.id), rowid);
    for (const name of new Set(v.labels)) this.vertexLabelRows.push([rowid, this.labelId(name)]);
    for (const p of v.properties ?? [])
      this.property(this.vertexProps, 'node', rowid, p, () => p.id ?? this.nextVertexProp++, 'vertex');
    this.counts.vertices++;
    return rowid;
  }

  /** Buffer one edge; returns its rowid. Endpoints resolve now when known, at `flush` otherwise. */
  edge(e: BulkEdge): number {
    const { rowid, uid } = this.idOf(e.id, () => this.nextEdge++);
    if (rowid >= this.nextEdge) this.nextEdge = rowid + 1;
    const src = this.vertexIds.get(String(e.src));
    const tgt = this.vertexIds.get(String(e.tgt));
    if (src !== undefined && tgt !== undefined) this.edgeRows.push([rowid, uid, src, this.labelId(e.label), tgt]);
    else this.pendingEdges.push({ edge: e, id: rowid });
    for (const p of e.properties ?? [])
      this.property(this.edgeProps, 'edge', rowid, p, () => p.id ?? this.nextEdgeProp++, 'edge');
    this.counts.edges++;
    return rowid;
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
    this.land('nodes', ['id', 'uid'], this.nodeRows);
    this.land('vertex_labels', ['node', 'label'], this.vertexLabelRows);
    this.land('vertex_properties', VERTEX_PROP_COLUMNS, this.vertexProps.scalar);
    this.land('vertex_properties', VERTEX_PROP_COLUMNS, this.vertexProps.collection, true);

    // Endpoints resolve AFTER the vertices land, so a store lookup can see this batch's own rows —
    // which is what makes an edge referencing a MINTED id (no source id to remember it by) resolvable
    // at all, not just one referencing a source id.
    for (const { edge, id } of this.pendingEdges) {
      const src = this.resolveEndpoint(edge.src, edge);
      const tgt = this.resolveEndpoint(edge.tgt, edge);
      this.edgeRows.push([id, typeof edge.id === 'string' ? edge.id : null, src, this.labelId(edge.label), tgt]);
    }
    this.pendingEdges = [];
    this.land('edges', ['id', 'uid', 'src', 'label', 'tgt'], this.edgeRows);
    this.land('edge_properties', EDGE_PROP_COLUMNS, this.edgeProps.scalar);
    this.land('edge_properties', EDGE_PROP_COLUMNS, this.edgeProps.collection, true);
    const fts = this.ftsRows.length;
    this.land('property_fts', PROPERTY_FTS_COLUMNS, this.ftsRows);

    this.nodeRows = []; this.vertexLabelRows = []; this.edgeRows = [];
    this.vertexProps = { scalar: [], collection: [] };
    this.edgeProps = { scalar: [], collection: [] };
    this.ftsRows = [];
    return { ...this.counts, ftsRows: fts };
  }

  /** A batch of rows for one table. `jsonbValue` is the collection/meta shape — a SEPARATE statement
   *  because a fixed-shape `VALUES` tuple cannot render `?` for one row's value and `jsonb(?)` for
   *  another's. Splitting by shape (rather than binding JSON text for scalars too) is what keeps a
   *  scalar's SQLite storage class, which every numeric order/range predicate rides on. */
  private land(table: string, columns: readonly string[], rows: unknown[][], jsonbValue = false): void {
    if (!rows.length) return;
    // A JSONB column binds its JSON TEXT wrapped in `jsonb(?)`. `meta` always rides that shape —
    // `jsonb(NULL)` is NULL (verified), so a nullable JSONB column needs no second statement.
    const cell = (c: string) => (c === 'meta' || (jsonbValue && c === 'value') ? 'jsonb(?)' : '?');
    this.counts.statements += insertRows(this.store, table, columns, rows, { cell });
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
  store: GraphStore, vertices: Iterable<BulkVertex>, edges: Iterable<BulkEdge> = [],
): BulkStats {
  const loader = new BulkLoader(store);
  for (const v of vertices) loader.vertex(v);
  for (const e of edges) loader.edge(e);
  return loader.flush();
}
