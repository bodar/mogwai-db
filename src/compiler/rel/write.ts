import { col, compilerInt, compilerNull, compilerText, isNot, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Binding, Guard } from '../../rel/plan.ts';
import type { Rel, Table } from '../../rel/rel.ts';
import type { Channels } from '../../channels.ts';
import { insert, remove, update } from '../../rel/stmt-factory.ts';
import type { Stmt } from '../../rel/stmt.ts';
import { EXCLUDED, type ColMeta, type RelId, type RelType } from '../../rel/types.ts';
import type { Elem } from '../elem.ts';
import type { IRStep } from '../ir/strategies.ts';
import { arg, isNested, isTokenArg, stepChain } from '../../gremlin/frontend.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { gremlinTypeOf, propertyValueBind, type CanonicalType, type TypeNode } from '../../gremlin/types.ts';
import { propertyFtsEntries } from '../../services/fts-index.ts';
import { constFromNested, Deferral, mergeMaps, parseProperty, readCardinality, type MergeMaps, type MergeSpec, type MetaPropSpec, type ParsedProperty, type PropSpec } from '../ir/write-args.ts';
import { MAP_COL, PAIR, pairsOf, pairSide } from './map.ts';
import type { MapOf } from '../../sql/kernel/render.ts';
import { validateLabel, validatePropertyKey } from '../../gremlin/validate.ts';
import { and, carriedCols, eq, explodeMembers, fenced, meta, or, reducedVtype, renumber, rowNumberWindow, typeOf, type Minter } from './build.ts';
import { rewriteExpr } from '../../rel/walk.ts';
import { aliasIdAt } from './alias.ts';
import { propertyOwnerId, propertyRowId } from './property.ts';
import { typedValueEq } from './predicate.ts';
import type { ChildValue } from './child.ts';
import type { AliasMap } from '../alias.ts';
import { DEFAULT_VERTEX_CARDINALITY, type VertexCardinality } from '../../api.ts';
import { constLit } from './const.ts';
import { fieldCol, framingCols, type RelFraming } from './framing.ts';
import { EDGE_MOVES, EDGE_SOURCE, ENDPOINT_MOVES, OTHER_V, unionOf, VERTEX_MOVES, VERTEX_SOURCE } from '../ir/step.ts';
import { IO_SERVICE_NAME } from '../../services/spi/types.ts';
import { nondeterministic } from './ranked-order.ts';

/**
 * THE WRITE VOCABULARY — an effect is a `Stmt` binding over a read plan, never a row-at-a-time loop.
 *
 * Phase 2 of the RelIR build plan, and the seventh module on `build.ts`. The read modules answer
 * "what relation is this chain", this one answers "what does it CHANGE", and the two meet at one
 * place: a write consumes the relation the read fold already produced, so there is no second prefix
 * builder and nothing opaque handed across a seam.
 *
 * ## THE INPUT IS A RELATION
 *
 * Every write step here takes the INCOMING TRAVERSERS as a relation and makes it an `Insert.source`:
 * one statement writes N rows, so the statement count is a function of the PLAN — 7 store calls for
 * `g.V().hasLabel('person').property(single,'seen',1)` whether the stream holds ten elements or a
 * hundred. The only rows that ever cross into JS are a `snapshot`'s, as ONE JSON value (§6·2). A
 * row-at-a-time write, by contrast, would make the count a function of the ROW COUNT — 8 store calls
 * per element, 801 over a hundred vertices.
 *
 * ## The pre-mutation snapshot is the whole design
 *
 * A cascade deletes from tables its own target relation READS — `g.V().out().drop()` selects through
 * `edges` and then deletes them. A CTE would be recomputed by each statement, so the vertex delete
 * would run against a graph its own earlier statement had already changed and silently leave
 * vertices standing. Every target here is therefore a `snapshot` binding (`src/rel/plan.ts`): taken
 * ONCE, retained by the executor, and read by every later statement as one JSON bind exploded by
 * `json_each` — which is also §6·2's rule, so a drop of 10,000 vertices is O(1) binds rather than a
 * 100-parameter wall. `checkPlan` proves the discipline
 * rather than trusting it: a plain CTE read by two steps of a program with effects is a THROW.
 *
 * ## Why the cascade is a list of statements and not a foreign key
 *
 * `ON DELETE CASCADE` would need the FK enforcement pragma on in both runtimes and would still not
 * reach `property_fts`, which is a virtual table nothing references. The cascade is ours either way,
 * so it is stated where it can be read.
 */

/** The physical columns each cascade statement addresses its rows by. `Scan` is the one node that
 *  names the schema (§3.3), so a table the cascade touches declares its shape HERE — the read side's
 *  `NODE_COLS`/`EDGE_COLS` are the same list for the two element tables. */
const OWNED_BY = {
  vertexProps: { table: 'vertex_properties', owner: 'node', cols: [meta('id', 'int'), meta('node', 'int')] },
  vertexCardinality: { table: 'vertex_property_cardinality', owner: 'node', cols: [meta('node', 'int'), meta('key', 'text')] },
  vertexLabels: { table: 'vertex_labels', owner: 'node', cols: [meta('node', 'int'), meta('label', 'int')] },
  edgeProps: { table: 'edge_properties', owner: 'edge', cols: [meta('id', 'int'), meta('edge', 'int')] },
  // The same two tables addressed by the property row's OWN id rather than by its owner — what
  // `drop()` over a PROPERTY stream deletes. Separate entries and not a parameter, because the KEY is
  // the whole difference between "this element's properties" and "these properties".
  vertexPropRows: { table: 'vertex_properties', owner: 'id', cols: [meta('id', 'int')] },
  edgePropRows: { table: 'edge_properties', owner: 'id', cols: [meta('id', 'int')] },
  nodes: { table: 'nodes', owner: 'id', cols: [meta('id', 'int')] },
  edges: { table: 'edges', owner: 'id', cols: [meta('id', 'int')] },
} as const satisfies Readonly<Record<string, { readonly table: Table; readonly owner: string; readonly cols: readonly ColMeta[] }>>;

/** `property_fts` is scoped by the OWNER ELEMENT KIND as well as by the owner id — one virtual table
 *  serves both element kinds, which is why the delete carries the extra equality. */
const FTS_COLS: readonly ColMeta[] = [meta('owner_elem', 'text'), meta('owner', 'int')];

const ID_TYPE: RelType = typeOf(meta('id', 'int'));

/** An empty alias map for the creation hosts (`addVertex`, `mergeV`) that carry no `as()` scope of
 *  their own to a runtime value body — a body reading an outer `select('a')` there resolves to the
 *  empty result rather than a live label. Defined locally because importing `lower/`'s `NO_ALIASES`
 *  would invert the module DAG (`write` is imported BY `lower`). */
const NO_ALIASES: AliasMap = new Map();

/** One `id` column and nothing else — a target set is an identity set, and every channel the read
 *  chain carried (bulk, encounter, an alias history) is state a DELETE has no use for. */
const idsOf = (rel: Rel, fresh: Minter): Rel =>
  make.project({ id: fresh('w'), input: rel, channels: [], type: ID_TYPE, exprs: [['id', col(rel.id, 'id')]] });

/** `DELETE FROM <table> WHERE <owner> IN <retained ids>` — the cascade's only statement shape, and
 *  `InQuery` over a `Ref` is what makes the retained rows a RELATION the predicate joins against
 *  rather than a placeholder list sized by the data (§6·2). */
function deleteOwnedBy(spec: keyof typeof OWNED_BY, owners: Rel, fresh: Minter): Stmt {
  const { table, owner, cols } = OWNED_BY[spec];
  const target = make.scan({ id: fresh('t'), table, alias: fresh('wt'), channels: [], type: typeOf(...cols) });
  return remove({
    target, channels: [], type: typeOf(),
    where: { kind: 'in-query', expr: col(target.id, owner), plan: owners, negated: false },
    returning: [],
  });
}

/**
 * `UPDATE <nodes|edges> SET dirty = 2 WHERE id IN <owner ids>` — the touch-rev-on-write marker
 * (docs/archive/2026-09-02-replication-and-http-interop-plan.md §5·1). A content mutation over EXISTING
 * elements changes their `rev`, but the recompute is a JS content-hash the set-based SQL cannot do
 * inline, so the mutation only FLAGS the elements and the post-write refresh (`src/refresh.ts`)
 * recomputes gid/rev over `WHERE dirty` after the program commits. `owners` is a bare `(id)` relation
 * of the OWNER ELEMENTS (a `property()`'s vertices, a `dropLabel`'s vertices, a `mergeV` onMatch's
 * matched vertices — never the property rows), so `InQuery` over it is O(plan size), never a data-sized
 * bind list (§6·2), exactly as `deleteOwnedBy` is.
 *
 * `dirty = 2` (a mutation), distinct from the DEFAULT 1 a create is born with (`storage.ts`); the
 * refresh reads neither value, driving gen off whether a `rev` already exists (null → gen 1 create,
 * present → gen+1 chain), so the 1-vs-2 split is a diagnostic, not load-bearing. A CREATE path never
 * calls this — its rows are already dirty — so this fires once per mutation site, over existing rows only.
 */
function markDirty(elem: Elem, owners: Rel, fresh: Minter): Stmt {
  const { table } = OWNED_BY[elem === 'edge' ? 'edges' : 'nodes'];
  const target = make.scan({ id: fresh('t'), table, alias: fresh('wt'), channels: [], type: typeOf(meta('id', 'int'), meta('dirty', 'int')) });
  return update({
    target, channels: [], type: typeOf(), set: [['dirty', compilerInt(2)]],
    where: { kind: 'in-query', expr: col(target.id, 'id'), plan: owners, negated: false },
    returning: [],
  });
}

/**
 * Record a TOMBSTONE per deleted element (§6·4) — `INSERT INTO tombstones (gid, rev, kind) SELECT gid,
 * rev, '<kind>' FROM <nodes|edges> WHERE id IN <snapshot> AND gid IS NOT NULL`. Run BEFORE the element
 * row is deleted, so its gid/rev are still readable; it reads the LIVE table (not the id-only snapshot)
 * for those columns. `gid IS NOT NULL` skips an element created and dropped in one program — it never
 * committed a gid and no peer ever saw it, so a tombstone for it would be a dangling delete. `seq` is
 * left NULL: the post-write refresh assigns a fresh LOCAL one, so a delete enters the by-seq feed like
 * any write (§5·2). O(plan size) via `InQuery`, never a data-sized bind list (§6·2), like the deletes.
 */
function recordTombstones(elem: Elem, owners: Rel, fresh: Minter): Stmt {
  const source = OWNED_BY[elem === 'edge' ? 'edges' : 'nodes'].table;
  const scan = make.scan({ id: fresh('t'), table: source, alias: fresh('wt'), channels: [], type: typeOf(meta('id', 'int'), meta('gid', 'blob', true), meta('rev', 'blob', true)) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and({ kind: 'in-query', expr: col(scan.id, 'id'), plan: owners, negated: false },
      { kind: 'binary', op: 'is not', left: col(scan.id, 'gid'), right: compilerNull('blob') }),
  });
  const rows = make.project({
    id: fresh('p'), input: matching, channels: [], type: typeOf(meta('gid', 'blob', true), meta('rev', 'blob', true), meta('kind', 'text')),
    exprs: [['gid', col(matching.id, 'gid')], ['rev', col(matching.id, 'rev')], ['kind', text(elem === 'edge' ? 'edge' : 'vertex')]],
  });
  const target = make.scan({ id: fresh('t'), table: 'tombstones', alias: fresh('wt'), channels: [], type: typeOf(meta('gid', 'blob', true), meta('rev', 'blob', true), meta('kind', 'text')) });
  return insert({ target, cols: ['gid', 'rev', 'kind'], source: rows, channels: [], type: typeOf(), returning: [] });
}

/** The FTS rows owned by a set of elements. Its own function because the owner column is `owner` on
 *  a virtual table with no `id`, and because the element-kind equality rides with it. */
function deleteFts(elem: Elem, owners: Rel, fresh: Minter): Stmt {
  const target = make.scan({ id: fresh('t'), table: 'property_fts', alias: fresh('wt'), channels: [], type: typeOf(...FTS_COLS) });
  return remove({
    target, channels: [], type: typeOf(),
    where: {
      kind: 'binary', op: 'and',
      left: { kind: 'binary', op: '=', left: col(target.id, 'owner_elem'), right: compilerText(elem === 'edge' ? 'edge' : 'node') },
      right: { kind: 'in-query', expr: col(target.id, 'owner'), plan: owners, negated: false },
    },
    returning: [],
  });
}

/** The edges INCIDENT to a set of vertices, either direction. Snapshotted for the same reason the
 *  target is: it is read by four later statements, three of which have already changed the graph. */
function incidentEdges(vertices: Rel, fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('tgt', 'int')) });
  const touching: Expr = {
    kind: 'binary', op: 'or',
    left: { kind: 'in-query', expr: col(scan.id, 'src'), plan: vertices, negated: false },
    right: { kind: 'in-query', expr: col(scan.id, 'tgt'), plan: vertices, negated: false },
  };
  const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: touching });
  return make.project({ id: fresh('w'), input: matching, channels: [], type: ID_TYPE, exprs: [['id', col(matching.id, 'id')]] });
}

/** A program's effects plus the relation its result is — what a write step hands back to the fold. */
export interface Effects { readonly bindings: readonly Binding[]; readonly result: Rel; }

/**
 * `drop()` over an ELEMENT stream — the cascade, as statements.
 *
 * A vertex takes its incident edges with it, an edge takes only its own rows, and both take the FTS
 * text their properties own. The ORDER is the referencing direction (a child before the row it names)
 * and it is stated once here rather than being an emergent property of eight call sites.
 *
 * The result is the LAST statement, whose `RETURNING` is empty: `drop()` produces no traversers, so
 * the program's result relation is a statement with no columns and the framing is `discard`. That is
 * why nothing in this module has to build an empty relation, which `Values` refuses to express.
 */
export function elementDrop(target: Rel, elem: Elem, fresh: Minter): Effects {
  // The target is lowered like any other relation — `name` binds its shared subexpressions as CTEs —
  // and only then snapshotted. Those CTEs are read by ONE step (the snapshot's own SELECT), which is
  // exactly the case `checkSnapshots` leaves alone.
  const targetPlan = nameBindings(idsOf(target, fresh));
  const ids = fresh('drop');
  const owners = make.ref({ id: fresh('r'), name: ids, channels: [], type: ID_TYPE });
  const bindings: Binding[] = [...targetPlan.bindings, { name: ids, node: targetPlan.result, snapshot: true }];

  const statements: Stmt[] = [];
  if (elem === 'edge') {
    statements.push(
      // Tombstone the edges FIRST, while their gid/rev are still on the row (§6·4).
      recordTombstones('edge', owners, fresh),
      deleteFts('edge', owners, fresh),
      deleteOwnedBy('edgeProps', owners, fresh),
      deleteOwnedBy('edges', owners, fresh));
  } else {
    const incident = fresh('inc');
    bindings.push({ name: incident, node: incidentEdges(owners, fresh), snapshot: true });
    const edges = make.ref({ id: fresh('r'), name: incident, channels: [], type: ID_TYPE });
    statements.push(
      // Tombstone the vertex AND its incident edges (both are being deleted, so both must propagate)
      // before any element row is removed — the gid/rev they carry are read off the live tables.
      recordTombstones('vertex', owners, fresh),
      recordTombstones('edge', edges, fresh),
      deleteFts('edge', edges, fresh),
      deleteFts('vertex', owners, fresh),
      deleteOwnedBy('edgeProps', edges, fresh),
      deleteOwnedBy('edges', edges, fresh),
      deleteOwnedBy('vertexProps', owners, fresh),
      // A per-element cardinality DECLARATION dies with the element that carries it — that is the
      // whole point of scoping it to (node, key), so a later vertex cannot inherit stale schema.
      deleteOwnedBy('vertexCardinality', owners, fresh),
      deleteOwnedBy('vertexLabels', owners, fresh),
      deleteOwnedBy('nodes', owners, fresh));
  }

  const last = statements[statements.length - 1]!;
  const names = statements.map(() => fresh('d'));
  statements.forEach((node, i) => bindings.push({ name: names[i]!, node }));
  return { bindings, result: make.ref({ id: fresh('r'), name: names[names.length - 1]!, channels: [], type: last.type }) };
}

/**
 * `drop()` over a PROPERTY stream — `g.V().properties().drop()` removes the properties and leaves
 * every element standing. There is no cascade: a property owns nothing but its index text.
 *
 * **Both element kinds delete BY THE PROPERTY ROW'S OWN id.** A Gremlin edge `Property` has no
 * identity of its own on the WIRE, so the alternative would address edge properties by the
 * `(edge, key)` PAIR, through a `VALUES` list chunked by row count. That is a bind list sized by DATA,
 * which is exactly the shape `mise run binds` exists to keep out and which a compiled plan cannot
 * chunk at all (§6·2). The physical row has an id either way, so addressing it is both simpler and
 * O(plan size): one statement, one `InQuery` against the retained rows.
 *
 * The FTS sweep is `dropStaleIndex` unchanged — it already deletes by `pid`, which is that same row id.
 */
export function propertyDrop(target: Rel, elem: Elem, fresh: Minter): Effects {
  // Snapshot first, for `elementDrop`'s reason: the rows to delete must be decided before the first
  // statement changes what a later one would select. The snapshot carries BOTH the property ROW id
  // (what the deletes address) and its OWNER ELEMENT id (what the rev touch marks dirty, §5·1) — one
  // lowering of the target, so the owner is captured before the property rows are gone.
  const PDROP_TYPE = typeOf(meta('id', 'int'), meta('owner', 'int'));
  const targetPlan = nameBindings(make.project({
    id: fresh('w'), input: target, channels: [], type: PDROP_TYPE,
    exprs: [['id', propertyRowId(target)], ['owner', propertyOwnerId(target, elem)]],
  }));
  const ids = fresh('pdrop');
  const snap = make.ref({ id: fresh('r'), name: ids, channels: [], type: PDROP_TYPE });
  const bindings: Binding[] = [...targetPlan.bindings, { name: ids, node: targetPlan.result, snapshot: true }];
  // A FRESH single-column projection per consumer — an `InQuery` matches one column, and a shared
  // node would be the two-column `IN` SQLite refuses (the `mergeE` snapshot reads `idsOf` the same way).
  const rowIds = (): Rel => make.project({ id: fresh('w'), input: snap, channels: [], type: ID_TYPE, exprs: [['id', col(snap.id, 'id')]] });

  // The index text before the row it describes — the referencing direction `elementDrop` states once.
  // The rev touch marks the OWNER ELEMENTS dirty: dropping a property changes their content hash (§5·1).
  const statements: Stmt[] = [
    dropStaleIndex(elem, rowIds(), fresh),
    deleteOwnedBy(elem === 'edge' ? 'edgePropRows' : 'vertexPropRows', rowIds(), fresh),
    markDirty(elem, make.project({ id: fresh('w'), input: snap, channels: [], type: ID_TYPE, exprs: [['id', col(snap.id, 'owner')]] }), fresh),
  ];
  // A per-element cardinality DECLARATION is deliberately untouched: it is scoped to (node, key) and
  // describes the KEY's schema, not the value that happened to be stored under it. Dropping the last
  // value of a `list` key does not make the key `single`.
  const names = statements.map(() => fresh('d'));
  statements.forEach((node, i) => bindings.push({ name: names[i]!, node }));
  const last = statements[statements.length - 1]!;
  return { bindings, result: make.ref({ id: fresh('r'), name: names[names.length - 1]!, channels: [], type: last.type }) };
}

// ---------- property() over an element that already exists ----------

/**
 * `property(k, v)` — the MUTATION, as statements over the elements the read prefix selected.
 *
 * It is `drop()`'s twin and it is where the write wedge stops being one shape: a delete needs only
 * the target's identity, while this needs the target's identity AND hands the SAME traversers back,
 * so its result is an element relation the fold keeps folding. That is what makes
 * `g.V(1).property('k','v').values('k')` plan composition, and it is the reason `property()` is a
 * step of the ordinary loop.
 *
 * ## What is expressible, and why the rest DECLINES rather than approximating
 *
 * A LITERAL scalar value is: its stored form, its `vtype` and the FTS text it indexes as are all
 * decided at compile time, so the index rows are an `INSERT … SELECT` over the property insert's own
 * `RETURNING` — the walk that produces them is `propertyFtsEntries`, the one authority for it,
 * because a re-derived index is a SILENT divergence (`fts-index.ts` measured 9,023 rows against
 * 8,936). A COLLECTION value is expressible too and by the same route — it stores as a
 * self-describing typed `{t,v}` tree, so the only difference is that its JSON text crosses as
 * `jsonb(<text>)` and its index walk emits one row per nested leaf, both of which the shared waists
 * already do. A traversal value, a meta-property and a `T` token key each need something the
 * compile-time value does not have, so each raises `UnsupportedTraversal` rather than answering a
 * different question — the failure mode a fail-closed compiler must never fall into.
 *
 * **`null` is expressible and is not a write at all** — it is TinkerPop's property REMOVAL rule, a
 * delete wearing a write's spelling, which is why `PropertyWrite` is a union rather than a record with
 * a nullable value.
 *
 * ## The cardinality is a PER-ELEMENT question, and stays one
 *
 * An explicit `property(Cardinality.x, …)` DECLARES, which is an upsert into the declaration table
 * and a compile-time constant thereafter. Absent one the effective cardinality is
 * `COALESCE(<this element's declaration>, <the graph default>)` — different for two elements in the
 * same stream — so it is an EXPRESSION each statement is guarded by, never a branch taken once.
 * Collapsing it to a constant is exactly the bug that made a repeated `property(k, v)` overwrite.
 */
/**
 * WHAT ONE `property()` DOES — a total union, because `property(k, null)` is not a write of null.
 *
 * TinkerPop's null-VALUE rule: on a graph that does not declare `supportsNullPropertyValues` — ours
 * does not — `property(k, null)` REMOVES every property under `k`. Modelled as a variant rather than
 * as a `stored: null` because the two arms share almost nothing: a removal has no stored value, no
 * vtype, no index rows to write, and it ignores the DECLARED cardinality entirely (`ElementHelper`
 * removes before it resolves one, so `property(single, k, null)` writes no declaration either). Every
 * one of those would have been an optional field whose emptiness meant "this is really the other
 * thing", which is the vocabulary shape `ScalarType` exists as the counter-example to.
 */
export type PropertyWrite = PropertySet | PropertyRemoval | PropertyRuntimeSet | PropertyMapSet;

export interface PropertySet {
  readonly kind: 'set';
  readonly key: string;
  readonly keyName: string | null;
  /** The value as STORAGE holds it, and the canonical Gremlin type beside it. */
  readonly stored: import('../../gremlin/frontend.ts').ArgValue;
  readonly valueName: string | null;
  readonly typeNode: TypeNode | null;
  readonly vtype: CanonicalType | null;
  /** Is `stored` a COLLECTION's JSON text rather than a scalar? It decides one thing — that the value
   *  crosses as `jsonb(?)` rather than a bare bind — and it is carried rather than re-derived from
   *  `vtype` because `propertyValueBind` is the authority on which types are collections and a second
   *  reading of that list is a second chance to disagree with it. */
  readonly collection: boolean;
  /** The META-PROPERTY object as JSON TEXT, or `null` where the step named none. It crosses as
   *  `jsonb(<text>)` for `stored`'s reason and lands in the property row's own `meta` column. */
  readonly meta: readonly MetaPropSpec[] | null;
  /** What this value indexes as: (kind, text) pairs from the ONE shared walk. */
  readonly fts: readonly { readonly kind: string; readonly text: string }[];
  /** The DECLARED cardinality, or `null` for "the traversal named none" — a real state, since only
   *  the element's own declaration may resolve it. Always `null` for an edge (single by spec). */
  readonly cardinality: VertexCardinality | null;
}

/** `property(k, null)` — every property under `k` goes, whatever the cardinality says. */
export interface PropertyRemoval {
  readonly kind: 'remove';
  readonly key: string;
  readonly keyName: string | null;
}

/**
 * `property(k, __.trav)` — a value the compile-time form does NOT carry, so it is resolved PER
 * incoming traverser at lowering time, correlated to the owner row through `ChildSeam.rows`
 * (`prepareRuntimeWrite`). This is the write side's per-*traverser* surface, the twin of the
 * per-*graph* rooted one `runtimeLabel` already has: a label body reads the graph (one value for the
 * whole batch), a property VALUE body reads the traverser it is being written onto — so
 * `property('age2', __.values('age'))` names a different value for every vertex it visits.
 *
 * The reference is `AddPropertyStep.handleTraversalValue`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java:127-200`):
 * the body is run per traverser and ALL its results collected — 0 → the mutation is skipped and the
 * element passes through, >1 under an effective `single` → raise, `list`/`set` → each result is a
 * value, else the one value. So the answer is a correlated RELATION (one row per child result), not a
 * scalar — which is exactly `ChildRows`, joined to the owners by the `origin` it carries.
 *
 * The body is NORMALIZED here (`child.body(nested, 'child')`) and nothing else: whether it LOWERS, and
 * to a scalar, is `prepareRuntimeWrite`'s question, because only there is the owner relation the
 * value correlates against in scope (a scalar subquery correlated to a relation not in the write
 * statement's own scope is silently wrong SQL, not a decline — the correlation-scope rule).
 */
export interface PropertyRuntimeSet {
  readonly kind: 'runtime';
  /** The KEY — a constant, or a body resolved per traverser (`property(__.values('name'), …)`;
   *  `Parameters.get(traverser, T.key, …)` applies a key traversal exactly as it does a value). */
  readonly key: string | { readonly body: readonly IRStep[] };
  readonly keyName: string | null;
  /** The VALUE — a traversal rooted at the current traverser (`'child'` scope), or a constant where only
   *  the key is runtime (the constant's statement spelling, `storedExpr`'s, and its type). */
  readonly value: { readonly body: readonly IRStep[] } | { readonly expr: Expr; readonly vtype: CanonicalType | null };
  /** The DECLARED cardinality, or `null` for the graph default — the same per-element question a
   *  constant write carries, resolved per owner in `runtimeWriteRows`. */
  readonly cardinality: VertexCardinality | null;
  /** META-PROPERTIES — on each written row, or patched onto an equal value a `set` element already holds. */
  readonly meta: readonly MetaPropSpec[] | null;
  /** The `property()` step this write came from, by IDENTITY — how `sequentialGuard` finds its own run
   *  in `ProgramWrites`. Absent, every other write in the program counts as another traverser's. */
  readonly step?: IRStep;
}

/** `property(__.trav)` — the single-argument MAP form (`mapFormStatements`). */
export interface PropertyMapSet {
  readonly kind: 'map';
  readonly body: readonly IRStep[];
  /** See `PropertyRuntimeSet.step`. */
  readonly step?: IRStep;
}

/**
 * THE VALUE AS THE STATEMENT SPELLS IT — a bare bind for a scalar, `jsonb(<text>)` for a collection.
 *
 * A collection stores as a self-describing typed `{t,v}` tree and a raw array/Map bind throws at the
 * SQLite seam, so the JSON TEXT is what crosses and SQLite builds the blob. Written once because the
 * value appears at TWO places in one statement set — the row being inserted and the `set`-cardinality
 * "is it already present" comparison — and a form that differed between them would silently append a
 * duplicate instead of matching.
 *
 * §6·2 is unaffected: the blob goes INTO the table, and this statement's `RETURNING` projects ids
 * only, so nothing untransportable is retained.
 */
const storedExpr = (write: PropertySet): Expr => {
  if (write.collection) {
    const text = write.valueName === null ? compilerText(String(write.stored)) : param(write.stored, write.valueName, 'text');
    return { kind: 'call', fn: 'jsonb', args: [text] };
  }
  // `vtype` preserves Gremlin's declared type. SQLite's scalar storage class remains the
  // materialized value's class, which is why an integral Double continues to land INTEGER
  // (the JSON set writer has the same representation). This keeps writes and bulk imports
  // byte-identical while `vtype: double` still frames the property as a Double on read.
  const storageType = typeof write.stored === 'number' && Number.isInteger(write.stored) ? 'int' : write.vtype;
  return constLit(arg(write.stored, storageType, write.valueName))!;
};

const metaExpr = (meta: NonNullable<PropertySet['meta']>): Expr => ({
  kind: 'call', fn: 'jsonb', args: [{
    kind: 'call', fn: 'json_object', args: meta.flatMap((entry) => {
      const key = entry.keyName === null ? compilerText(entry.key) : param(entry.key, entry.keyName, 'text');
      const { stored, collection } = propertyValueBind(entry.value, entry.vtype, entry.typeNode);
      const value: Expr = collection
        ? { kind: 'call', fn: 'json', args: [entry.valueName === null ? compilerText(String(stored)) : param(stored, entry.valueName, 'text')] }
        : constLit(arg(stored, entry.vtype, entry.valueName))!;
      return [key, value];
    }),
  }],
});

/**
 * THE `set` ARM'S META PATCH — a `set` write whose value is already present inserts nothing, and its
 * meta-properties are ATTACHED to the property that holds it instead: `ElementHelper.stageVertexProperty`
 * finds the equal value and calls `attachProperties(property, keyValues)`
 * (`structure/util/ElementHelper.java:399-417`), which sets each key and leaves the others — a JSON merge
 * patch of the new object onto the stored one (`json_patch`, RFC 7396). One UPDATE over every matched row,
 * narrowed to the elements whose effective cardinality is `set` where none was declared.
 *
 * It runs BEFORE the insert, so the rows it can reach are the ones that were already there — exactly the
 * ones the insert skips; a row the insert adds carries its meta from the start.
 */
function patchSetMeta(meta: readonly MetaPropSpec[], declared: VertexCardinality | null, matches: (target: Rel) => Expr, fresh: Minter): Stmt {
  const spec = PROPERTY_TABLE.vertex;
  const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  const patched: Expr = { kind: 'call', fn: 'jsonb', args: [{
    kind: 'call', fn: 'json_patch', args: [{ kind: 'call', fn: 'coalesce', args: [col(target.id, 'meta'), compilerText('{}')] }, metaExpr(meta)],
  }] };
  return update({
    target, channels: [], type: typeOf(), set: [['meta', patched]], returning: [],
    where: and(matches(target), declared === 'set' ? undefined : eq(cardinalityOf(col(target.id, spec.owner), col(target.id, 'key'), null, fresh), text('set'))),
  });
}

/** The property side-table each element kind writes, as `Scan` must declare it. */
const PROPERTY_TABLE = {
  vertex: { table: 'vertex_properties' as Table, owner: 'node', cols: [meta('id', 'int'), meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), meta('meta', 'blob', true)] },
  edge: { table: 'edge_properties' as Table, owner: 'edge', cols: [meta('id', 'int'), meta('edge', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)] },
} as const;

const CARDINALITY_COLS: readonly ColMeta[] = [meta('node', 'int'), meta('key', 'text'), meta('cardinality', 'text')];
const FTS_ROW_COLS: readonly ColMeta[] = [meta('owner_elem', 'text'), meta('pid', 'int'), meta('owner', 'int'), meta('pk', 'text'), meta('kind', 'text'), meta('text', 'text')];

/** `(id, owner)` — what a property write's `RETURNING` hands the FTS insert. */
const WRITTEN_TYPE: RelType = typeOf(meta('id', 'int'), meta('owner', 'int'));

const text = (value: string): Expr => compilerText(value);
const propertyKeyExpr = (key: string, name: string | null): Expr => name === null ? compilerText(key) : param(key, name, 'text');

/** This element's effective cardinality for one key, as an EXPRESSION — the declaration it carries,
 *  or the graph default. A declared cardinality is a compile-time constant instead, because the
 *  statement that declares it runs first. */
function cardinalityOf(owner: Expr, key: Expr, declared: VertexCardinality | null, fresh: Minter): Expr {
  if (declared) return text(declared);
  const scan = make.scan({ id: fresh('t'), table: 'vertex_property_cardinality', alias: fresh('wt'), channels: [], type: typeOf(...CARDINALITY_COLS) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, 'node'), owner), eq(col(scan.id, 'key'), key)),
  });
  const only = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('cardinality', 'text', true)), exprs: [['cardinality', col(matching.id, 'cardinality')]] });
  return { kind: 'call', fn: 'coalesce', args: [{ kind: 'scalar', plan: only }, text(DEFAULT_VERTEX_CARDINALITY)] };
}

/** `INSERT INTO property_fts … SELECT … FROM <the rows just written> CROSS JOIN <the walk's rows>`.
 *
 *  The pid is known only at run time and the (kind, text) pairs only at compile time, so the two
 *  meet as a cross join — one row per written property per index entry. `Values` is exactly the
 *  right node for a compile-time row set. The CALLER checks that there is at least one entry —
 *  `ftsRowsFor` drops empty text, so `property(k, "")` indexes as none and an empty `Values` is not
 *  a relation this algebra can express. */
function indexWritten(written: Rel, elem: Elem, write: PropertySet, fresh: Minter): Stmt {
  const entries = make.values({
    id: fresh('fv'), channels: [], type: typeOf(meta('kind', 'text'), meta('text', 'text')),
    rows: write.fts.map((entry) => [text(entry.kind), text(entry.text)]),
  });
  const paired = make.join({
    id: fresh('j'), left: written, right: entries, join: 'cross', channels: [],
    type: typeOf(meta('id', 'int'), meta('owner', 'int'), meta('kind', 'text'), meta('text', 'text')),
  });
  const row = make.project({
    id: fresh('p'), input: paired, channels: [], type: typeOf(...FTS_ROW_COLS),
    exprs: [
      // `compilerText`, not `text`: the OWNER KIND is a compile-time fact off `elem` and can never be
      // user data, so binding it spent one of the 100 on a constant the compiler already holds. Its
      // twin in `deleteFts` always inlined; these two did not, and the sql-hygiene `bound` ratchet is
      // what surfaced the disagreement (the drop family reached this path for the first time).
      ['owner_elem', compilerText(elem === 'edge' ? 'edge' : 'node')],
      ['pid', col(paired.id, 'id')], ['owner', col(paired.id, 'owner')], ['pk', propertyKeyExpr(write.key, write.keyName)],
      ['kind', col(paired.id, 'kind')], ['text', col(paired.id, 'text')],
    ],
  });
  const target = make.scan({ id: fresh('t'), table: 'property_fts', alias: fresh('wt'), channels: [], type: typeOf(...FTS_ROW_COLS) });
  return insert({
    target, cols: FTS_ROW_COLS.map((column) => column.name), source: row,
    channels: [], type: typeOf(), returning: [],
  });
}

/** The FTS text a set of property rows owns — `pid IN (SELECT id FROM <property table> WHERE …)`.
 *  Written as a membership predicate over the same relation the delete beside it narrows, so the
 *  two cannot drift apart into naming different rows. */
function dropStaleIndex(elem: Elem, rows: Rel, fresh: Minter): Stmt {
  const target = make.scan({ id: fresh('t'), table: 'property_fts', alias: fresh('wt'), channels: [], type: typeOf(...FTS_COLS, meta('pid', 'int')) });
  return remove({
    target, channels: [], type: typeOf(),
    where: and(
      eq(col(target.id, 'owner_elem'), compilerText(elem === 'edge' ? 'edge' : 'node')),
      { kind: 'in-query', expr: col(target.id, 'pid'), plan: rows, negated: false },
    ),
    returning: [],
  });
}

/** The existing property rows for one key over a set of owners, optionally narrowed further (the
 *  single-cardinality guard). Projected to `id`, which is what both the FTS sweep and the row
 *  delete address them by. */
function existingRows(elem: Elem, owners: Rel, key: Expr, guard: ((owner: Expr) => Expr) | undefined, fresh: Minter): { readonly ids: Rel; readonly pred: (target: Rel) => Expr } {
  const spec = PROPERTY_TABLE[elem === 'edge' ? 'edge' : 'vertex'];
  const clause = (target: Rel): Expr => and(
    and({ kind: 'in-query', expr: col(target.id, spec.owner), plan: owners, negated: false }, eq(col(target.id, 'key'), key)),
    guard ? guard(col(target.id, spec.owner)) : undefined,
  );
  const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: clause(scan) });
  return {
    ids: make.project({ id: fresh('p'), input: matching, channels: [], type: ID_TYPE, exprs: [['id', col(matching.id, 'id')]] }),
    pred: clause,
  };
}

/**
 * ONE `property(k, v)`, as the statements it runs over a set of owners.
 *
 * The order is the one the semantics require and nothing about it is incidental: a `single` write
 * REPLACES, so the rows it displaces (and the FTS text they own) go before the insert; the insert
 * itself is guarded so a `set` write of a value already present is a no-op; and the index rows
 * follow the insert because only it knows their pid.
 */
function propertyStatements(
  elem: Elem, owners: Rel, write: PropertyWrite, bind: Binder, fresh: Minter,
  child: ChildSeam, aliases: AliasMap, guard: Guarder, sequenced = false,
): boolean {
  const spec = PROPERTY_TABLE[elem === 'edge' ? 'edge' : 'vertex'];
  // A MEMBERSHIP test is against one column, and the snapshot carries the traverser's channels too —
  // so the identity projection is taken once here rather than at each of the four predicates that
  // want it. (`IN (SELECT id, bulk, encounter …)` is what SQLite refuses, and it refused it.)
  const ids = make.project({ id: fresh('w'), input: owners, channels: [], type: ID_TYPE, exprs: [['id', col(owners.id, 'id')]] });

  // A RUNTIME value (or key, or the MAP form) is resolved per TRAVERSER of `owners` — a different SOURCE
  // (one row per child result, not per owner) and per-traverser raises the constant path never needs —
  // so it runs its own statement builder (`ownerSite` → `prepareRuntimeWrite`/`mapFormStatements`) and
  // DECLINES (`false`) where the body does not lower to a scalar. Nothing after this line is shared.
  // `sequenced` says the caller has already pushed this write's `sequenceGuard`, ahead of the run.
  if (write.kind === 'runtime' || write.kind === 'map') {
    const { site, targets } = ownerSite(owners, elem, aliases, fresh);
    if (!sequenced) sequenceGuard(site, write, child, guard, fresh);
    if (write.kind === 'map') return mapFormStatements(elem, site, targets, write.body, bind, fresh, child, guard);
    const apply = prepareRuntimeWrite(elem, site, write, fresh, child, guard, undefined, true);
    if (!apply) return false;
    apply(targets, bind);
    return true;
  }

  // A REMOVAL is the replace half on its own, with no insert after it and no cardinality consulted:
  // the FTS text those rows own, then the rows. It is UNGUARDED — `property(k, null)` removes under
  // every cardinality, which is what makes it a removal rather than a `single` write of nothing.
  if (write.kind === 'remove') {
    const stale = existingRows(elem, ids, propertyKeyExpr(write.key, write.keyName), undefined, fresh);
    bind(dropStaleIndex(elem, stale.ids, fresh));
    const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    bind(remove({ target, channels: [], type: typeOf(), where: stale.pred(target), returning: [] }));
    return true;
  }

  // A DECLARED cardinality is a schema write, and it must land before anything reads it back.
  if (write.cardinality) {
    const target = make.scan({ id: fresh('t'), table: 'vertex_property_cardinality', alias: fresh('wt'), channels: [], type: typeOf(...CARDINALITY_COLS) });
    const rows = make.project({
      id: fresh('p'), input: owners, channels: [], type: typeOf(...CARDINALITY_COLS),
      exprs: [['node', col(owners.id, 'id')], ['key', propertyKeyExpr(write.key, write.keyName)], ['cardinality', text(write.cardinality)]],
    });
    bind(insert({
      target, cols: CARDINALITY_COLS.map((column) => column.name), source: rows, channels: [], type: typeOf(),
      onConflict: { target: ['node', 'key'], set: [['cardinality', col(EXCLUDED, 'cardinality')]] },
      returning: [],
    }));
  }

  // An EDGE is single by spec (`UNIQUE(edge, key)`), so its stale text goes unconditionally and the
  // row itself is an UPSERT — the id survives, which is why the sweep must precede it.
  // A VERTEX replaces only where the effective cardinality says `single`.
  const replaces = elem === 'edge' || write.cardinality === 'single' || write.cardinality === null;
  if (replaces) {
    const guard = elem === 'edge' || write.cardinality === 'single'
      ? undefined
      : (owner: Expr): Expr => eq(cardinalityOf(owner, propertyKeyExpr(write.key, write.keyName), null, fresh), text('single'));
    const stale = existingRows(elem, ids, propertyKeyExpr(write.key, write.keyName), guard, fresh);
    bind(dropStaleIndex(elem, stale.ids, fresh));
    if (elem !== 'edge') {
      const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
      bind(remove({ target, channels: [], type: typeOf(), where: stale.pred(target), returning: [] }));
    }
  }

  // Meta on a value a `set` element already holds is a PATCH of that row, not a second row.
  if (elem !== 'edge' && write.meta !== null && (write.cardinality === null || write.cardinality === 'set')) {
    bind(patchSetMeta(write.meta, write.cardinality, (t) => and(
      and({ kind: 'in-query', expr: col(t.id, spec.owner), plan: ids, negated: false }, eq(col(t.id, 'key'), propertyKeyExpr(write.key, write.keyName))),
      eq(col(t.id, 'value'), storedExpr(write)),
    ), fresh));
  }

  const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  // ONE ROW PER ELEMENT unless the element keeps every value. Several traversers on one element are the
  // reference's loop run once each (`AddPropertyStep.sideEffect` per traverser), and every run writes
  // the SAME constant: a `single` run replaces the last one's value with an equal one, a `set` run finds
  // it already present, an edge property is single by spec — so each leaves ONE row, and only `list`
  // appends per traverser. Inserting per traverser left `g.V(2,4).in().property(single,'x',1)` holding
  // marko's `x` twice. Only a TRAVERSER snapshot (one carrying its position) can repeat an element; a
  // creation's own rows and an id set cannot, and pay nothing for it.
  const ranked = rowNumberWindow(owners, 'once', owners.channels, { partitionBy: [col(owners.id, 'id')], orderBy: [] }, fresh);
  const first = eq(col(ranked.id, 'once'), compilerInt(1));
  const undeclared = elem !== 'edge' && write.cardinality === null;
  const repeats = owners.type.cols.some((column) => column.name === ORD);
  const base = !repeats || (elem !== 'edge' && write.cardinality === 'list') ? owners : make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: undeclared ? or(first, eq(cardinalityOf(col(ranked.id, 'id'), propertyKeyExpr(write.key, write.keyName), null, fresh), text('list'))) : first,
  });
  // A `set` write whose value is already present writes nothing. Expressed as a guard on the SOURCE
  // rather than as a branch, because the cardinality is per element: two owners in one stream can
  // take different arms of it.
  const present = (): Expr => {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const matching = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), col(base.id, 'id')), eq(col(scan.id, 'key'), propertyKeyExpr(write.key, write.keyName))),
        eq(col(scan.id, 'value'), storedExpr(write))),
    });
    return { kind: 'exists', plan: matching, negated: true };
  };
  const skippable = elem !== 'edge' && write.cardinality !== 'single' && write.cardinality !== 'list';
  // The relation the projection reads is the FILTER where there is one — a `Col` names a relation in
  // SCOPE, and scope is a node's direct children, so naming the grandparent here is the mistake the
  // checker catches as "no relation in scope" (it did, on the first run).
  const seed = skippable
    ? make.filter({
      // The OWNERS relation carries the traverser's channels (a snapshot keeps them), and a `Filter`
      // is channel-preserving by contract — naming a shorter list is the dropped-channel defect.
      id: fresh('f'), input: base, channels: base.channels, type: base.type,
      pred: { kind: 'binary', op: 'or', left: { kind: 'binary', op: '!=', left: cardinalityOf(col(base.id, 'id'), propertyKeyExpr(write.key, write.keyName), write.cardinality, fresh), right: text('set') }, right: present() },
    })
    : base;
  const source = make.project({
    id: fresh('p'), input: seed, channels: [],
    type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true),
      ...(write.meta === null ? [] : [meta('meta', 'blob', true)])),
    exprs: [[spec.owner, col(seed.id, 'id')], ['key', propertyKeyExpr(write.key, write.keyName)], ['value', storedExpr(write)], ['vtype', write.vtype === null ? compilerNull('text') : compilerText(write.vtype)],
      ...(write.meta === null ? [] : [['meta', metaExpr(write.meta)] as const])],
  });
  const rowsWritten = insert({
    target, cols: [spec.owner, 'key', 'value', 'vtype', ...(write.meta === null ? [] : ['meta'])], source, channels: [], type: WRITTEN_TYPE,
    ...(elem === 'edge'
      ? { onConflict: { target: ['edge', 'key'], set: [['value', col(EXCLUDED, 'value')], ['vtype', col(EXCLUDED, 'vtype')]] } }
      : {}),
    returning: [['id', col(target.id, 'id')], ['owner', col(target.id, spec.owner)]],
  });
  // The insert's `RETURNING` is RETAINED by construction (a statement binding always is), which is
  // what lets the index rows join against pids that did not exist a statement ago.
  //
  // A value indexing as NO entries writes no index statement, and that is a real state rather than a
  // guard: `ftsRowsFor` drops empty text, so `property(k, "")` has nothing to index and the `Values`
  // of (kind, text) pairs would be EMPTY — a relation §3.3 records `Values` as refusing to express,
  // i.e. a throw out of a lowering whose contract is `null`. It only became REACHABLE when
  // `property(T.id, …)` let `addV("p").property(T.id,1).property("name","")` route here at all,
  // which is what the CSV round-trip corpus caught.
  const written = bind(rowsWritten);
  if (write.fts.length) bind(indexWritten(written, elem, write, fresh));
  return true;
}

/**
 * WHERE A RUNTIME VALUE IS EVALUATED, AND WHAT IT IS WRITTEN ONTO — which are two relations, not one.
 *
 * TinkerPop evaluates a `property()` VALUE traversal against one of two traversers, and which one is
 * decided by where the step ended up, not by the step's text (`dsl/graph/GraphTraversal.java:3996-4044`):
 *
 *  - an ordinary `AddPropertyStep` runs it against the traverser it MUTATES — the element itself
 *    (`AddPropertyStep.sideEffect`, `step/sideEffect/AddPropertyStep.java:93-121`);
 *  - a `property()` FOLDED into the `addV`/`addE` before it (no cardinality, no meta, a `String`/`T`/
 *    `Traversal` key — every `property()` after an `addE`) becomes one of that step's parameters, which
 *    `AddVertexStep.map` resolves against the INCOMING traverser before the element exists
 *    (`Parameters.getKeyValues(traverser)`, `step/util/Parameters.java:171-183`; `AddVertexStep.java:140-162`).
 *
 * So `g.V().addV('animal').property('name', __.values('name'))` names the SOURCE vertex's name, and
 * running the body over the created vertex (which has none) answered a different question. A site says
 * both halves: the `host` the body runs over and the `targets` that map each host row onto the element
 * it writes — the identity for an ordinary step, the creation's positional correlation for a folded one.
 */
interface RuntimeSite {
  /** One row per incoming TRAVERSER — `id` plus the channels a body may read (aliases). */
  readonly host: Rel;
  readonly hostElem: Elem;
  /** The `host` column that names a traverser uniquely — the snapshot's `ord` where it has one (an
   *  element id does not: `g.V(2,4).in()` visits marko twice), `id` for freshly created rows. */
  readonly origin: string;
  readonly aliases: AliasMap;
  /** HOW MANY results the reference takes from the body — `all` for `AddPropertyStep.handleTraversalValue`
   *  (`applyAll`, cardinality-aware), `first` for a folded parameter (`TraversalUtil.apply` = `next()`,
   *  which RAISES on no result, `process/traversal/util/TraversalUtil.java:41-53`). */
  readonly resolve: 'all' | 'first';
}

/** The columns every runtime value relation is normalized to, so the statements below read ONE shape
 *  whichever child arm produced it: the traverser (`o`), its value and type, and the child's own order
 *  (`sq`) — which is what "the FIRST result" and the per-traverser insertion order are relative to. */
const VALUE_ROW_COLS: readonly ColMeta[] = [meta('o', 'int'), meta('v', 'any', true), meta('vt', 'text', true), meta('sq', 'int', true)];

/**
 * The Gremlin type a scalar framing STATES for every row, as the `vtype` to store beside the value — or
 * NULL, which stores the value untyped so it frames by its storage class.
 *
 * Only where that statement and the stored form agree by construction: a NATIVE (non-`text`) numeric or
 * string, whose SQLite storage class is already that type's — `count()` is a Long however small it is,
 * and storing it untyped would read back as an Int. Any other static tag (a datetime, an exact decimal
 * tail) names an encoding a computed value is not promised to be in, so it is left to inference rather
 * than asserted.
 */
const STATED_VTYPES: ReadonlySet<string> = new Set(['long', 'int', 'double', 'float', 'string']);
const scalarVtype = (framing: RelFraming): Expr =>
  framing.kind === 'scalar' && framing.type.kind === 'static' && !framing.type.text && STATED_VTYPES.has(framing.type.type)
    ? compilerText(framing.type.type) : compilerNull('text');

/** The site of an ORDINARY `property()` step over `owners` — the body reads the element it writes. The
 *  traverser is the snapshot's position where the owners carry one, else the element id itself. */
function ownerSite(owners: Rel, elem: Elem, aliases: AliasMap, fresh: Minter): { readonly site: RuntimeSite; readonly targets: Rel } {
  const origin = owners.type.cols.some((column) => column.name === ORD) ? ORD : 'id';
  return { site: { host: owners, hostElem: elem, origin, aliases, resolve: 'all' }, targets: targetsOf(owners, origin, fresh) };
}

/** `(o, owner)` — which element each traverser writes: the rows' own id, keyed by their traverser
 *  column. An ordinary step's identity, and a creation's too once `positioned` has recovered each new
 *  row's position — which is a folded parameter's correlation back to the input row that made it. */
const targetsOf = (rows: Rel, origin: string, fresh: Minter): Rel => make.project({
  id: fresh('tg'), input: rows, channels: [], type: typeOf(meta('o', 'int'), meta('owner', 'int')),
  exprs: [['o', col(rows.id, origin)], ['owner', col(rows.id, 'id')]],
});

/**
 * WHAT A RUNTIME BODY CAN OBSERVE — the property keys it may read, and whether it can leave the traverser
 * it was handed. A static, FAIL-CLOSED walk over the body and everything nested in it (arguments,
 * predicate operands, `by()` modulators, repeat/option bodies): every answer over-approximates, because
 * the only use of it is to REFUSE (`sequentialGuard`), and an over-approximation costs a refusal where a
 * miss would cost a wrong answer. `labels.ts` makes the same trade for label reads, for the same reason.
 *
 *  - `keys` — a string argument of a key-reading step or a `by()` modulator; `'all'` for a whole-payload
 *    read (`values()`/`properties()`/`valueMap()`/… with no key, `hasKey`/`hasValue`) or a nested body
 *    this walk cannot normalize.
 *  - `leaves` — the body can reach an element OTHER than its own traverser's: a movement, a graph source,
 *    or a label/path read (an alias names whatever element the traverser passed earlier).
 *  - `sources` — the body re-sources the graph (`V()`/`E()`/`call()`), the only way to reach an element
 *    with no edges, which is what a vertex an `addV` just made is.
 */
interface BodyReach { readonly keys: ReadonlySet<string> | 'all'; readonly leaves: boolean; readonly sources: boolean; readonly labels: boolean }

const KEY_READING_STEPS: ReadonlySet<string> = new Set(['values', 'properties', 'valueMap', 'elementMap', 'propertyMap', 'has', 'hasNot', 'hasKey', 'hasValue']);
const GRAPH_SOURCES: ReadonlySet<string> = unionOf(VERTEX_SOURCE, EDGE_SOURCE);
const ELEMENT_MOVES: ReadonlySet<string> = unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V, new Set(['toE', 'toV']));
/** Steps whose answer can be an element bound EARLIER on the traverser's path, not the current one. */
const LABEL_READING_STEPS: ReadonlySet<string> = new Set(['select', 'path', 'simplePath', 'cyclicPath', 'tree', 'match', 'cap', 'sack']);
/** Steps that read an element's LABEL — what `addLabel`/`dropLabel` change: `label()`, the multi-label
 *  `labels()` (`LabelsStep`, `vendor/tinkerpop/gremlin-test/…/features/sideEffect/DropLabel.feature:30`),
 *  `hasLabel()`, and the two maps that carry `T.label`. Two other spellings are caught per step in
 *  `bodyReach`: a `T.label` token anywhere in a step's arguments or modulators (`has(T.label, …)`,
 *  `by(T.label)`, `readsLabelToken`), and the THREE-argument `has(label, key, value)`, which `HasStep`
 *  composes with a `T.label` container (`GraphTraversal.has(String label, String propertyKey, …)`,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java`)
 *  — `lower/filter.ts` lowers it to `hasLabelClause` AND the property clause for the same reason. */
const LABEL_READS: ReadonlySet<string> = new Set(['label', 'labels', 'hasLabel', 'elementMap', 'valueMap']);
/** Steps whose reads this walk cannot enumerate — a service (`call()`, which may search any key or
 *  label), a merge (its match map reads keys AND `T.label`, possibly through a parameter), a graph
 *  document or algorithm, a body-level write. Each reads EVERYTHING: any key, any label, any element. */
const OPAQUE_STEPS: ReadonlySet<string> = new Set([
  'call', 'mergeV', 'mergeE', 'io', 'read', 'write', 'subgraph', 'profile', 'pageRank', 'peerPressure', 'connectedComponent', 'shortestPath',
  'addV', 'addE', 'property', 'drop', 'addLabel', 'dropLabel', 'dropLabels',
]);
/**
 * Steps that by THEMSELVES read no property key and no label and stay on their traverser's element or
 * value — their arguments, modulators and nested bodies are still walked. The walk is an ALLOWLIST of
 * non-readers rather than a list of readers because a reader list is closed only until the next step
 * lands, and a missed reader is a wrong answer where a missed non-reader only costs a refusal — the trade
 * `ir/labels.ts` makes for `as()` labels. A step in NONE of these sets is treated as `OPAQUE_STEPS`.
 */
const READS_NOTHING: ReadonlySet<string> = new Set([
  'as', 'identity', 'barrier', 'by', 'option', 'times', 'until', 'emit', 'with', 'from', 'to', 'loops', 'index', 'id', 'key', 'value', 'element',
  'is', 'where', 'not', 'and', 'or', 'filter', 'dedup', 'limit', 'range', 'skip', 'tail', 'coin', 'sample', 'timeLimit', 'none', 'discard', 'hasId', 'fail',
  'local', 'map', 'flatMap', 'union', 'coalesce', 'choose', 'optional', 'repeat', 'branch', 'sideEffect',
  'constant', 'inject', 'count', 'sum', 'min', 'max', 'mean', 'fold', 'unfold', 'math', 'project', 'order', 'group', 'groupCount', 'aggregate',
  'asString', 'toUpper', 'toLower', 'length', 'trim', 'lTrim', 'rTrim', 'replace', 'split', 'substring', 'concat', 'format',
  'asDate', 'dateAdd', 'dateDiff', 'asNumber', 'asBool', 'combine', 'difference', 'disjunct', 'intersect', 'merge', 'product', 'reverse', 'conjoin', 'all', 'any',
]);
const KNOWN_READS: ReadonlySet<string> = unionOf(KEY_READING_STEPS, GRAPH_SOURCES, ELEMENT_MOVES, LABEL_READING_STEPS, LABEL_READS, OPAQUE_STEPS, READS_NOTHING);
/** `math()`'s own vocabulary — the current value `_` and `FUNCTIONS`; every OTHER identifier in its
 *  expression is a variable, i.e. a label it reads (`MathStep.getVariables`,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:188-208`). */
const MATH_WORDS: ReadonlySet<string> = new Set(['_', 'abs', 'acos', 'asin', 'atan', 'cbrt', 'ceil', 'cos', 'cosh', 'exp', 'floor', 'log', 'log10', 'log2', 'signum', 'sin', 'sinh', 'sqrt', 'tan', 'tanh']);

function bodyReach(steps: readonly IRStep[], child: ChildSeam): BodyReach {
  const keys = new Set<string>();
  let all = false, leaves = false, sources = false, labels = false;
  const strings = (value: unknown, into: (s: string) => void): void => {
    if (typeof value === 'string') { into(value); return; }
    if (value == null || typeof value !== 'object' || isNested(value)) return;
    if (value instanceof Map) { for (const [k, v] of value) { strings(k, into); strings(v, into); } return; }
    if (Array.isArray(value)) { for (const v of value) strings(v, into); return; }
    if ('value' in value) strings((value as { value: unknown }).value, into);
    if ('operands' in value) strings((value as { operands: unknown }).operands, into);
  };
  const nested = (value: unknown): void => {
    if (isNested(value)) {
      const body = child.body(value.nested, 'child');
      if (body === null) { all = true; leaves = true; sources = true; labels = true; return; }
      walk(body);
      return;
    }
    if (value == null || typeof value !== 'object') return;
    if (value instanceof Map) { for (const v of value.values()) nested(v); return; }
    if (Array.isArray(value)) { for (const v of value) nested(v); return; }
    if ('value' in value) nested((value as { value: unknown }).value);
    if ('operands' in value) nested((value as { operands: unknown }).operands);
  };
  const walk = (body: readonly IRStep[]): void => {
    for (const step of body) {
      const args = step.args.map((a) => a.value);
      if (OPAQUE_STEPS.has(step.name) || !KNOWN_READS.has(step.name)) { all = true; leaves = true; sources = true; labels = true; }
      if (GRAPH_SOURCES.has(step.name)) { sources = true; leaves = true; }
      if (ELEMENT_MOVES.has(step.name) || LABEL_READING_STEPS.has(step.name)) leaves = true;
      if (LABEL_READS.has(step.name) || (step.name === 'has' && args.length >= 3)
        || readsLabelToken([...args, ...(step.modulators ?? []).flat()])) labels = true;
      // A label spelled as an argument — `where('a', P)`, `where(P.eq('a'))`, `dedup('a')` — or inside
      // `math()`'s expression.
      if ((step.name === 'where' || step.name === 'dedup') && args.some((a) => !isNested(a))) leaves = true;
      if (step.name === 'math') strings(args, (s) => { if ((s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((w) => !MATH_WORDS.has(w))) leaves = true; });
      if (KEY_READING_STEPS.has(step.name)) {
        let named = false;
        strings(args, (s) => { keys.add(s); named = true; });
        if (!named || step.name === 'hasKey' || step.name === 'hasValue') all = true;
      }
      // `format('%{name}')` reads a property OR a label by that name.
      if (step.name === 'format') strings(args, (s) => { for (const [, w] of s.matchAll(/%\{([^}]*)\}/g)) { keys.add(w!); leaves = true; } });
      for (const modulator of step.modulators ?? []) for (const value of modulator) {
        strings(value, (s) => keys.add(s));
        nested(value);
      }
      for (const value of args) nested(value);
      if (step.repeatRegion) walk(step.repeatRegion as IRStep[]);
      if (step.optionArms) walk(step.optionArms as IRStep[]);
    }
  };
  walk(steps);
  return { keys: all ? 'all' : keys, leaves, sources, labels };
}

/** Does a `T.label` token sit anywhere in these argument values (a predicate's operands, a collection)? */
const readsLabelToken = (values: readonly unknown[]): boolean => values.some(function found(value: unknown): boolean {
  if (isTokenArg(value)) return value.token === 'label';
  if (value == null || typeof value !== 'object' || isNested(value)) return false;
  if (value instanceof Map) return [...value.keys(), ...value.values()].some(found);
  if (Array.isArray(value)) return value.some(found);
  return ('value' in value && found((value as { value: unknown }).value)) || ('operands' in value && found((value as { operands: unknown }).operands));
});

/**
 * WHAT A WHOLE PROGRAM CAN WRITE — every mutation at any nesting depth, summarized for `sequentialGuard`.
 *
 * The reference's one-traverser-at-a-time loop is not a property of ONE step: a lazy pipeline with no
 * barrier between two mutating steps (`LazyBarrierStrategy` adds none after a `g.V(ids)` source of fewer
 * than five ids, nor after a single flat-map, `strategy/optimization/LazyBarrierStrategy.java:93-125`)
 * hands traverser 1 through EVERY later step before traverser 2's body in an earlier step runs — and
 * traverser 2 through every EARLIER step before traverser 1's body in a later one. So
 * `g.E(7,8).property('a', __.outV().outE().values('b').count()).property('b', 1)` gives ONE of the two
 * edges `a=1` (the other's `b` already exists), where a plan that runs each step for every traverser
 * gives `0` to both. A body is therefore safe only if it cannot observe anything ANOTHER traverser writes
 * anywhere in that pipeline — earlier step or later — and the pipeline's extent is not decided here (a
 * barrier, a nested write, a `sideEffect` body), so this summarizes the whole PROGRAM. Every answer
 * over-approximates, which costs a refusal and never an answer.
 *
 *  - `writers` — every `property()` step's keys (`'all'` for a key only known at run time, or the map
 *    form), with the RUN it belongs to — a maximal sequence of consecutive `property()` steps in one
 *    chain, which writes every traverser's OWN element — and whether it writes an element the program
 *    has just CREATED (the run right after an `addV`/`addE`, folded or not), which only a body that can
 *    REACH a new element observes. A writer inside a `repeat()`/`option()` region or a nested body is
 *    never anyone's own run (`-1`). `runOf` finds a step's run by identity.
 *  - `anyKey` — a merge (its match arm writes onto a found element) or a drop: any key, any element.
 *  - `labels` — a label mutation; `creates`/`edges` — a new vertex or edge (an edge is reachable by
 *    movement, a vertex only by re-sourcing the graph); `drops` — an element or property removal.
 *
 * A nested body the walk cannot read, or an `io()` (a read loads a whole graph), is `everythingWritten`.
 *
 *  - `draws` — the program holds a random step (`nondeterministic`, ranked-order.ts), so no relation
 *    re-evaluated in a statement of its own counts the stream another statement consumed (`afterWrite`).
 *  - `upstream` — the one LOWERING-TIME part: the mutating steps whose tail is being lowered right now,
 *    innermost last (`afterWrite`). Every other field says WHAT the program writes; this says which of
 *    those writes run UPSTREAM of the step being lowered, and over which stream — the fact
 *    `sequentialGuard` needs and the site's own host cannot give (see there).
 */
export interface ProgramWrites {
  readonly writers: readonly KeyWriter[];
  /** EVERY write step in the program, one entry per step (any depth), classified by `writeSiteOf` — what
   *  a merge counts to ask whether a write OTHER than its own cluster exists (`mergeObservesOtherWrites`).
   *  `'unknown'` when the walk could not read a body (`everythingWritten`). */
  readonly sites: readonly WriteSite[] | 'unknown';
  readonly runOf: ReadonlyMap<IRStep, number>;
  readonly anyKey: boolean;
  readonly labels: boolean;
  readonly creates: boolean;
  readonly edges: boolean;
  readonly drops: boolean;
  readonly draws: boolean;
  readonly upstream: UpstreamWrite[];
}
interface KeyWriter { readonly run: number; readonly keys: ReadonlySet<string> | 'all'; readonly fresh: boolean }

/**
 * A MUTATING STEP UPSTREAM of whatever is being lowered: what it writes (its own steps summarized by
 * `programWrites`), and the name of the binding that will hold how many traversers it runs over — taken
 * only if a guard asks for it (`used`), so a program with no observing body pays no statement.
 */
interface UpstreamWrite { readonly effect: ProgramWrites; readonly count: string | null; used: boolean }

const everythingWritten = (): ProgramWrites =>
  ({ writers: [], sites: 'unknown', runOf: new Map(), anyKey: true, labels: true, creates: true, edges: true, drops: true, draws: true, upstream: [] });

/** One write step of the program — WHAT it writes, at the grain a merge's search can be observed by. */
interface WriteSite {
  readonly op: 'addV' | 'addE' | 'mergeV' | 'mergeE' | 'drop' | 'label' | 'property';
  /** A `property()` write's key; `'all'` when it is only known at run time (or the map form). */
  readonly keys: ReadonlySet<string> | 'all';
}

/** THE ONE CLASSIFIER of a step as a write site — `programWrites` and a merge's own cluster
 *  (`mergeObservesOtherWrites`) both read a step through it, so the merge's subtraction of itself cannot
 *  disagree with the program's count. `null` = not a write. */
function writeSiteOf(step: IRStep): WriteSite | null {
  switch (step.name) {
    case 'addV': case 'addE': case 'mergeV': case 'mergeE': case 'drop': return { op: step.name, keys: 'all' };
    case 'addLabel': case 'dropLabel': case 'dropLabels': return { op: 'label', keys: 'all' };
    case 'property': {
      const key = readCardinality(step.args.map((a) => a.value)).rest[0];
      return { op: 'property', keys: typeof key === 'string' ? new Set([key]) : 'all' };
    }
    default: return null;
  }
}

/** Steps after which the traverser is still the element an `addV`/`addE` just made. */
const KEEPS_FRESH: ReadonlySet<string> = new Set(['property', 'as']);

export function programWrites(steps: readonly IRStep[], params: Record<string, any>): ProgramWrites {
  const writers: KeyWriter[] = [];
  const sites: WriteSite[] = [];
  const runOf = new Map<IRStep, number>();
  let runs = 0, anyKey = false, labels = false, creates = false, edges = false, drops = false, unreadable = false;
  const nested = (value: unknown): void => {
    if (isNested(value)) {
      let body: readonly IRStep[];
      try { body = stepChain(value.nested, params); } catch { unreadable = true; return; }
      walk(body, false);
      return;
    }
    if (value == null || typeof value !== 'object') return;
    if (value instanceof Map) { for (const [k, v] of value) { nested(k); nested(v); } return; }
    if (Array.isArray(value)) { for (const v of value) nested(v); return; }
    if ('value' in value) nested((value as { value: unknown }).value);
    if ('operands' in value) nested((value as { operands: unknown }).operands);
  };
  const walk = (chain: readonly IRStep[], ownable: boolean): void => {
    let fresh = false, run = -1;
    for (const step of chain) {
      const args = step.args.map((a) => a.value);
      if (step.name !== 'property') run = -1;
      const site = writeSiteOf(step);
      if (site) sites.push(site);
      switch (step.name) {
        case 'addV': creates = true; break;
        case 'addE': creates = true; edges = true; break;
        // A merge's onMatch map APPENDS a `T.label` to the found vertex (`MergeVertexStep.java:106-113`,
        // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java`).
        case 'mergeV': creates = true; anyKey = true; labels = true; break;
        case 'mergeE': creates = true; edges = true; anyKey = true; labels = true; break;
        case 'drop': drops = true; anyKey = true; break;
        case 'addLabel': case 'dropLabel': case 'dropLabels': labels = true; break;
        // `io()` survives as itself only in a nested body read afresh; the top-level chain has been
        // through `desugarIo`, which turns it into `call(IO_SERVICE_NAME, …)` — the one service that
        // writes the graph (the OLAP services write only their scratch `barrier_state`).
        case 'io': unreadable = true; break;
        case 'call': if (args[0] === IO_SERVICE_NAME) unreadable = true; break;
        case 'property': {
          if (run < 0 && ownable) run = runs++;
          if (run >= 0) runOf.set(step, run);
          const key = readCardinality(args).rest[0];
          writers.push({ run, keys: typeof key === 'string' ? new Set([key]) : 'all', fresh });
          break;
        }
      }
      fresh = step.name === 'addV' || step.name === 'addE' || (fresh && KEEPS_FRESH.has(step.name));
      for (const value of args) nested(value);
      for (const modulator of step.modulators ?? []) for (const value of modulator) nested(value);
      for (const [, value] of step.withArgs ?? []) nested(value);
      if (step.repeatRegion) walk(step.repeatRegion as IRStep[], false);
      if (step.optionArms) walk(step.optionArms as IRStep[], false);
    }
  };
  walk(steps, true);
  return unreadable ? everythingWritten() : { writers, sites, runOf, anyKey, labels, creates, edges, drops, draws: nondeterministic(steps, params), upstream: [] };
}

/**
 * LOWER A WRITE'S TAIL WITH THE WRITE KNOWN TO BE UPSTREAM of it — the one place every mutating step's
 * continuation is composed (`writer` is the step(s) it lowered, `bindings` their statements, `input` the
 * stream they ran over), so a `property(k, <traversal>)` site anywhere in that tail, at any depth that
 * inherits this program's `ProgramWrites`, can ask how many traversers the write ran over.
 *
 * That count is what the site's own host cannot say. The reference pulls traverser 2 through the
 * upstream write only after traverser 1 has gone all the way through the site, whatever FILTER sits in
 * between: `RangeGlobalStep` and every `FilterStep` pull their next start lazily, and no barrier is
 * inserted for a short id source (`strategy/optimization/LazyBarrierStrategy.java:93-125`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java`).
 * So `g.V(1,2).addLabel('z').has('name','marko').property('n', __.V().hasLabel('z').count())` meets ONE
 * host row and owes `n=1` — vadas is not labelled yet — while one statement per step labels both first.
 *
 * The count is a binding of its own, run BEFORE the write's statements, and only when a site used it.
 * `input` is `null` where no relation counts the traversers the write ran over — a branch's arm writes
 * (`withBranchEffects`, lower.ts) — and then an observing site always refuses. So does every site in a
 * program that DRAWS (`ProgramWrites.draws`): the count is its own statement over `input`, and a
 * `coin()`/`sample()` in it would draw afresh there, so it need not count the stream the write consumed.
 */
export function afterWrite<T extends { readonly effects?: readonly Binding[] }>(
  writes: ProgramWrites, input: Rel | null, writer: readonly IRStep[], bindings: readonly Binding[],
  params: Record<string, any>, fresh: Minter, tail: () => T | null,
): T | null {
  const entry: UpstreamWrite = { effect: programWrites(writer, params), count: input && !writes.draws ? fresh('wn') : null, used: false };
  writes.upstream.push(entry);
  let lowered: T | null;
  try { lowered = tail(); } finally { writes.upstream.splice(writes.upstream.indexOf(entry), 1); }
  if (!lowered) return null;
  const counted = input && entry.count !== null && entry.used ? [streamCount(input, entry.count, fresh)] : [];
  return { ...lowered, effects: [...counted, ...bindings, ...(lowered.effects ?? [])] };
}

/** How many TRAVERSERS `input` holds — its rows, each weighted by its bulk where it carries one — as a
 *  retained `(n)` binding, so the count is the one taken before the write and not a re-read after it. */
function streamCount(input: Rel, name: string, fresh: Minter): Binding {
  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  const node = make.aggregate({
    id: fresh('wc'), input, channels: [], type: typeOf(meta('n', 'int')), groupBy: [],
    aggs: [['n', bulk ? { kind: 'agg', fn: 'sum', args: [col(input.id, bulk.col)] } : { kind: 'agg', fn: 'count', args: [compilerInt(1)] }]],
  });
  return { name, node, snapshot: true };
}

/** Can a body that reaches `reach` observe what `effect` writes — onto any element, since an upstream
 *  write's traversers are not the site's? */
const observes = (reach: BodyReach, effect: ProgramWrites): boolean => {
  let keys: KeySet = effect.anyKey ? 'all' : new Set<string>();
  for (const writer of effect.writers) keys = unite(keys, writer.keys);
  return meets(reach.keys, keys) || (effect.labels && reach.labels)
    || (reach.sources && (effect.creates || effect.drops)) || (reach.leaves && (effect.edges || effect.drops));
};

/**
 * THE REFERENCE RUNS ONE TRAVERSER AT A TIME; A WRITE HERE IS ONE STATEMENT — and the two only agree when
 * no traverser's value body can observe what ANOTHER traverser writes, at this step or at any other.
 *
 * `AddPropertyStep.sideEffect` resolves a traverser's body and mutates, and only then is the next
 * traverser pulled (`step/sideEffect/AddPropertyStep.java:93-121`) — and the lazy pipeline first hands
 * that traverser on through every LATER step, since no barrier sits in between for a short id source or a
 * single movement (`LazyBarrierStrategy` inserts one only after a SECOND flat-map,
 * `strategy/optimization/LazyBarrierStrategy.java:93-125`). So `g.V(2,4).in().property(single, 'age',
 * __.values('age').math('_+1'))` meets marko twice and the second visit reads the first's 30: 31.0; and
 * `g.E(7,8).property('a', __.outV().outE().values('b').count()).property('b', 1)` lets the second edge's
 * body count the first edge's `b`. The plan runs each step for EVERY traverser, each body read before its
 * own step writes — the reference exactly when nothing a body reads is written by another traverser
 * anywhere in the program (`ProgramWrites`), and a different answer otherwise. Where that cannot be ruled
 * out statically, a guard rules it out at run time and REFUSES — before the write's RUN writes anything (`sequenceGuard`):
 *
 *  - keys written by this write's OWN RUN land on each traverser's own element, so a body that reads one
 *    is safe while it stays on its own element and no element occurs twice in the stream (the guard: an
 *    element id repeated in the host) — and only while the stream is ONE traverser if it can leave its
 *    element (the guard: a second host row);
 *  - keys written ANYWHERE ELSE (another run, a nested write, a merge, a drop) may land on any element,
 *    and a label mutation on any element's labels, so a body that reads one is safe only over one
 *    traverser;
 *  - keys written onto a NEW element, and new or removed elements themselves, are seen only by a body that
 *    can reach them — by re-sourcing the graph, or by any movement for a new edge or a removal — and such
 *    a body too is safe only over one traverser. A FOLDED parameter's own keys are of this kind: they
 *    land on the element its creation makes.
 *
 * `keys` is the write's own keys, `null` for a key only known at run time — then ANY key the body reads
 * may be the written one. `step` is the write's own `property()` step, which names its run; absent, or
 * not found (a nested body normalized afresh), no other write counts as its own run, which only refuses
 * more.
 */
function sequentialGuard(
  site: RuntimeSite, bodies: readonly (readonly IRStep[])[], keys: readonly string[] | null, step: IRStep | undefined,
  child: ChildSeam, guard: Guarder, fresh: Minter,
): void {
  const program = child.writes;
  const run = step === undefined ? undefined : program.runOf.get(step);
  const mine: KeySet = keys === null ? 'all' : new Set(keys);
  let own: KeySet = site.resolve === 'all' ? mine : new Set<string>();
  let created: KeySet = site.resolve === 'all' ? new Set<string>() : mine;
  let elsewhere: KeySet = program.anyKey ? 'all' : new Set<string>();
  for (const writer of program.writers) {
    if (writer.fresh) created = unite(created, writer.keys);
    else if (run !== undefined && writer.run === run) own = unite(own, writer.keys);
    else elsewhere = unite(elsewhere, writer.keys);
  }
  const reaches = bodies.map((body) => bodyReach(body, child));
  const leaves = reaches.some((reach) => reach.leaves);
  const readsOwn = reaches.some((reach) => meets(reach.keys, own));
  const readsElsewhere = reaches.some((reach) => meets(reach.keys, elsewhere) || (program.labels && reach.labels));
  const seesNew = reaches.some((reach) => (reach.sources && (program.creates || program.drops))
    || (reach.leaves && (program.edges || program.drops))
    || (meets(reach.keys, created) && (reach.sources || (program.edges && reach.leaves))));
  const perStream = readsElsewhere || seesNew || (readsOwn && (leaves || site.resolve === 'first'));
  const perElement = !perStream && readsOwn;
  // An UPSTREAM write the body can observe is one statement only when ONE traverser ran through it — its
  // own stream's count, not the host's: a filter, a `limit`, a `select` between the two hides from the
  // host the traversers the reference has not yet pulled through the write (`afterWrite`).
  for (const upstream of program.upstream) {
    if (!reaches.some((reach) => observes(reach, upstream.effect))) continue;
    upstream.used = true;
    // An uncountable stream (a branch's arm writes) is taken to be many: the guard always raises.
    const counted = upstream.count === null
      ? make.values({ id: fresh('wu'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(2)]] })
      : make.ref({ id: fresh('r'), name: upstream.count, channels: [], type: typeOf(meta('n', 'int')) });
    const many = make.filter({ id: fresh('rf'), input: counted, channels: [], type: counted.type, pred: { kind: 'binary', op: '>', left: col(counted.id, 'n'), right: compilerInt(1) } });
    guard(make.project({ id: fresh('p'), input: many, channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', col(many.id, 'n')]] }),
      { message: SEQUENTIAL_READ, raiseWhen: 'rows' });
  }
  if (!perElement && !perStream) return;
  const counts = make.aggregate({
    id: fresh('rc'), input: site.host, channels: [], type: typeOf(...(perElement ? [meta('id', 'int')] : []), meta('n', 'int')),
    groupBy: perElement ? [col(site.host.id, 'id')] : [], aggs: [['n', { kind: 'agg', fn: 'count', args: [compilerInt(1)] }]],
  });
  const repeated = make.filter({ id: fresh('rf'), input: counts, channels: [], type: counts.type, pred: { kind: 'binary', op: '>', left: col(counts.id, 'n'), right: compilerInt(1) } });
  guard(make.project({ id: fresh('p'), input: repeated, channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', col(repeated.id, 'n')]] }),
    { message: SEQUENTIAL_READ, raiseWhen: 'rows' });
}

/**
 * A runtime or map-form write's `sequentialGuard` over `site`: every body it resolves, and its own keys
 * (`null` — any — for a runtime key, and for the map form, whose program writer is `'all'` anyway).
 *
 * Its own function because WHEN it runs is the caller's to choose. The guard reads only the site's host,
 * so it can run ahead of a whole `property()` run (`elementProperty`) — which is what keeps a refusal at
 * the run's third step from leaving the first two written.
 */
function sequenceGuard(site: RuntimeSite, write: PropertyRuntimeSet | PropertyMapSet, child: ChildSeam, guard: Guarder, fresh: Minter): void {
  const bodies = write.kind === 'map' ? [write.body]
    : [...('body' in write.value ? [write.value.body] : []), ...(typeof write.key === 'string' ? [] : [write.key.body])];
  sequentialGuard(site, bodies, write.kind === 'runtime' && typeof write.key === 'string' ? [write.key] : null, write.step, child, guard, fresh);
}

type KeySet = ReadonlySet<string> | 'all';
const unite = (a: KeySet, b: KeySet): KeySet => (a === 'all' || b === 'all' ? 'all' : new Set([...a, ...b]));
/** Can a body that reads `read` observe a write of `written`? */
const meets = (read: KeySet, written: KeySet): boolean =>
  read === 'all' ? written === 'all' || written.size > 0
  : written === 'all' ? read.size > 0
  : [...read].some((key) => written.has(key));

/**
 * A NULL value the body resolved, refused before anything is written. A non-productive framing is the
 * framer's signal for "no result", yet `constant(null)` still carries its null as a row — so a null here is
 * either a real null, which the reference turns into a REMOVAL of the key (`ElementHelper.attachProperties`,
 * `structure/util/ElementHelper.java:316-381`), or no value at all, which is no mutation. The two need
 * different statements and the row cannot say which it is; storing it, which is neither, is the one answer
 * known to be wrong.
 */
function nullValueGuard(values: Rel, guard: Guarder, fresh: Minter): void {
  const nulls = make.filter({ id: fresh('f'), input: values, channels: [], type: values.type, pred: { kind: 'binary', op: 'is', left: col(values.id, 'v'), right: compilerNull() } });
  guard(make.project({ id: fresh('p'), input: nulls, channels: [], type: typeOf(meta('o', 'int')), exprs: [['o', col(nulls.id, 'o')]] }),
    { message: NULL_VALUE, raiseWhen: 'rows' });
}

const SEQUENTIAL_READ = 'this traversal is not supported yet: a property() traversal here may read what another traverser writes, and TinkerPop runs each traverser through every mutating step before resolving the next one\'s value';
const NULL_VALUE = 'this traversal is not supported yet: a property() traversal resolved to null, which TinkerPop applies as a removal of the key';
const UNORDERED_FIRST = 'this traversal is not supported yet: property() takes the first result of its traversal, and the traversal produced several different values with no order to say which is first';

/**
 * A runtime body → its rows over the site's host, normalized to `VALUE_ROW_COLS`, plus whether the body
 * can yield MANY per traverser (which decides the >1 raise). Two child arms, whichever fits:
 *
 *  - **`child.rows`** where the body may yield many (`__.values('k')`, `__.out().values('k')`): one row
 *    per result, keyed by the `origin` channel — seeded from the site's traverser column, so two
 *    traversers on one element stay two. Its `encounter` channel, where the body carries one, is the
 *    child's own order.
 *  - **`child.scalar`** where the body reduces to ONE (`__.out().count()`, `__.sum()`, an endpoint) —
 *    `child.rows` declines a reducing barrier (it sheds the origin), but the value is exactly one, so the
 *    correlated scalar is the right shape. An unproductive traverser is filtered out — the reference's
 *    0-result case as an absent row.
 *
 * `null` declines: a non-scalar result (an element/list/map value is not a property value), or a
 * reducer whose productivity the arm cannot state (a 0-result would be indistinguishable from a value).
 * A NULL row is not declined here but refused at run time by the writer (`nullValueGuard`): a framing's
 * `productiveNull` only says a null MAY be real (every numeric reducer states it, and `sum()` over ages
 * never yields one), so declining on it refused writes that are always answerable, while the row itself is
 * the only thing that knows whether a null actually arrived.
 *
 * The `framing` rides out because a KEY's type check needs the type the body STATES, not only the one a
 * row stores (`runtimeKeyRows`).
 */
function resolveValueRows(
  body: readonly IRStep[], site: RuntimeSite, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly mayBeMulti: boolean; readonly framing: RelFraming } | null {
  const rows = child.rows(body, site.host, site.hostElem, site.aliases, site.origin);
  if (rows && rows.framing.kind === 'scalar') {
    const typed = rows.rel.type.cols.some((column) => column.name === 'vtype');
    const reduced = rows.framing.result === 'number' && rows.rel.type.cols.some((column) => column.name === 'vt');
    const encounter = rows.rel.channels.find((channel) => channel.role === 'encounter');
    return {
      rel: make.project({
        id: fresh('rv'), input: rows.rel, channels: [], type: typeOf(...VALUE_ROW_COLS),
        exprs: [['o', col(rows.rel.id, rows.origin)], ['v', col(rows.rel.id, 'v')],
          ['vt', typed ? col(rows.rel.id, 'vtype') : reduced ? reducedVtype(col(rows.rel.id, 'vt')) : scalarVtype(rows.framing)],
          ['sq', encounter ? col(rows.rel.id, encounter.col) : compilerInt(0)]],
      }),
      mayBeMulti: true,
      framing: rows.framing,
    };
  }
  const host: ChildHost = { kind: 'element', id: col(site.host.id, 'id'), elem: site.hostElem, row: { rel: site.host, aliases: site.aliases } };
  const produced = child.scalar(body, host);
  if (!produced || produced.framing.kind !== 'scalar' || produced.yields !== 'one' || !produced.present) return null;
  // A NUMERIC reducer's `vt` is either a Gremlin type or a storage class (`reducedVtype` says which).
  const vt = produced.framing.result === 'number' ? (produced.vtype && reducedVtype(produced.vtype)) : produced.vtype;
  const valued = make.project({
    id: fresh('rv'), input: site.host, channels: [], type: typeOf(...VALUE_ROW_COLS, meta('present', 'int', true)),
    exprs: [['o', col(site.host.id, site.origin)], ['v', produced.expr], ['vt', vt ?? scalarVtype(produced.framing)],
      ['sq', compilerInt(0)], ['present', produced.present]],
  });
  const kept = make.filter({ id: fresh('rf'), input: valued, channels: [], type: valued.type, pred: col(valued.id, 'present') });
  return {
    rel: make.project({ id: fresh('rv'), input: kept, channels: [], type: typeOf(...VALUE_ROW_COLS), exprs: VALUE_ROW_COLS.map((column) => [column.name, col(kept.id, column.name)] as const) }),
    mayBeMulti: false,
    framing: produced.framing,
  };
}

/**
 * The FIRST row per traverser — `TraversalUtil.apply`'s `next()`, `handleTraversalValue`'s
 * `results.get(0)` — by the child's own order, `sq`.
 *
 * WHICH row is first is the body's ITERATION order, and the plan states one only where the child rows
 * carry an encounter that separates them. Where it does not — `sq` is the constant `0` when the child has
 * no encounter channel, and a host encounter carried through a fan-out is one value for every row it fans
 * out to — several DIFFERENT values tie for first, and taking one would be the scan's choice dressed as
 * the reference's: `addE(…).property('w', __.out().values('name'))` names whichever neighbour SQLite
 * visits first. So a tie between different values RAISES, before anything is written; a tie between
 * equal values is no choice at all and passes (`__.out().values('lang')` over two `java` rows).
 */
function firstPerTraverser(rel: Rel, guard: Guarder, fresh: Minter): Rel {
  const tied = make.window({
    id: fresh('rn'), input: rel, channels: [], type: typeOf(...rel.type.cols, meta('lo', 'any', true), meta('hi', 'any', true), meta('tlo', 'text', true), meta('thi', 'text', true)),
    specs: (['lo', 'hi', 'tlo', 'thi'] as const).map((name) => [name, {
      kind: 'window-expr', fn: name.endsWith('lo') ? 'min' : 'max',
      args: [name.startsWith('t') ? { kind: 'call', fn: 'coalesce', args: [col(rel.id, 'vt'), compilerText('')] } : col(rel.id, 'v')],
      spec: { partitionBy: [col(rel.id, 'o'), col(rel.id, 'sq')], orderBy: [] },
    }] as const),
  });
  const leading = rowNumberWindow(tied, 'lead', [], { partitionBy: [col(tied.id, 'o')], orderBy: [{ expr: col(tied.id, 'sq'), dir: 'asc' }] }, fresh);
  const ambiguous = make.filter({
    id: fresh('f'), input: leading, channels: [], type: leading.type,
    pred: and(eq(col(leading.id, 'lead'), compilerInt(1)), or(
      { kind: 'binary', op: 'is not', left: col(leading.id, 'lo'), right: col(leading.id, 'hi') },
      { kind: 'binary', op: 'is not', left: col(leading.id, 'tlo'), right: col(leading.id, 'thi') })),
  });
  guard(make.project({ id: fresh('p'), input: ambiguous, channels: [], type: typeOf(meta('o', 'int')), exprs: [['o', col(ambiguous.id, 'o')]] }),
    { message: UNORDERED_FIRST, raiseWhen: 'rows' });
  const ranked = rowNumberWindow(rel, 'rk', [], { partitionBy: [col(rel.id, 'o')], orderBy: [{ expr: col(rel.id, 'sq'), dir: 'asc' }] }, fresh);
  const first = make.filter({ id: fresh('rf'), input: ranked, channels: [], type: ranked.type, pred: eq(col(ranked.id, 'rk'), compilerInt(1)) });
  return make.project({ id: fresh('rv'), input: first, channels: [], type: rel.type, exprs: rel.type.cols.map((column) => [column.name, col(first.id, column.name)] as const) });
}

/**
 * `TraversalUtil.apply`'s refusal when a FOLDED parameter body yields nothing — a guard over the host
 * rows with no value row. Before anything is written: the reference raises while resolving the
 * creation's parameters, so nothing was created.
 */
function absentGuard(site: RuntimeSite, rows: Rel, guard: Guarder, fresh: Minter): void {
  const matching = make.filter({ id: fresh('f'), input: rows, channels: [], type: rows.type, pred: eq(col(rows.id, 'o'), col(site.host.id, site.origin)) });
  const missing = make.filter({ id: fresh('f'), input: site.host, channels: site.host.channels, type: site.host.type, pred: { kind: 'exists', plan: matching, negated: true } });
  guard(make.project({ id: fresh('p'), input: missing, channels: [], type: typeOf(meta('o', 'int')), exprs: [['o', col(missing.id, site.origin)]] }),
    { message: ABSENT_LABEL, raiseWhen: 'rows' });
}

/**
 * A RUNTIME KEY — `property(__.values('name'), v)` — as `(o, k)` rows, with the reference's checks on
 * the resolved value as guards. The key is ALWAYS one value (`Parameters.get(traverser, T.key, …).get(0)`
 * applies the traversal, `TraversalUtil.apply`), so it is the first row and an absent one RAISES.
 *
 * `ElementHelper.validateProperty`'s three sentences are pure predicates over the value
 * (`structure/util/ElementHelper.java:80-90`, `Property.Exceptions` `structure/Property.java:134-143`),
 * so they ride as guards exactly as a runtime label's do. A NON-STRING key the reference refuses by a
 * cast — a `ClassCastException` on the step path, `legalPropertyKeyValueArray`'s sentence on the folded
 * one (`structure/util/ElementHelper.java:98-105`); the second is the one with portable text, so it is the one raised.
 */
function runtimeKeyRows(body: readonly IRStep[], site: RuntimeSite, child: ChildSeam, guard: Guarder, fresh: Minter): Rel | null {
  const resolved = resolveValueRows(body, site, child, fresh);
  if (!resolved) return null;
  absentGuard(site, resolved.rel, guard, fresh);
  const first = firstPerTraverser(resolved.rel, guard, fresh);
  const keyText = (rel: Rel): Expr => ({ kind: 'cast', arg: col(rel.id, 'v'), to: 'text' });
  const typeOfKey: Expr = { kind: 'call', fn: 'typeof', args: [col(first.id, 'v')] };
  // A String is TEXT, but not all TEXT is a String: a uuid, a datetime or an exact-decimal tail is stored
  // as text too, and says so either in the row's own type (`vt`, a `values()` read of a typed property)
  // or in the type the body's framing STATES for every row (`constant(UUID(…))`). Either one naming a
  // type other than `string` is the reference's non-String key.
  const { framing } = resolved;
  const statedOther = framing.kind === 'scalar' && framing.type.kind === 'static' && framing.type.type !== 'string';
  const notString: Expr = statedOther ? { kind: 'binary', op: '!=', left: typeOfKey, right: text('null') } : or(
    { kind: 'binary', op: '!=', left: typeOfKey, right: text('text') },
    { kind: 'binary', op: '!=', left: { kind: 'call', fn: 'coalesce', args: [col(first.id, 'vt'), text('string')] }, right: text('string') });
  const rules: readonly (readonly [Expr, string, boolean])[] = [
    [eq(typeOfKey, text('null')), 'Property key can not be null', false],
    [notString, 'The provided key/value array must have a String or T on even array indices', false],
    [eq(keyText(first), text('')), 'Property key can not be the empty string', false],
    [{ kind: 'binary', op: 'like', left: keyText(first), right: text('~%') }, 'Property key can not be a hidden key: ', true],
  ];
  for (const [pred, message, names] of rules) {
    const bad = make.filter({ id: fresh('f'), input: first, channels: [], type: first.type, pred });
    guard(make.project({ id: fresh('p'), input: bad, channels: [], type: typeOf(meta('v', 'text', true)), exprs: [['v', keyText(bad)]] }),
      { message, raiseWhen: 'rows', ...(names ? { valueColumn: 'v' } : {}) });
  }
  return make.project({ id: fresh('rk'), input: first, channels: [], type: typeOf(meta('o', 'int'), meta('k', 'text')), exprs: [['o', col(first.id, 'o')], ['k', keyText(first)]] });
}

/** `(o, owner, k, v, vt, sq)` — the value rows joined to the element each traverser writes and to the
 *  key it writes under. The ONE relation every statement of a runtime write reads. */
const KEYED_ROW_COLS: readonly ColMeta[] = [meta('o', 'int'), meta('owner', 'int'), meta('k', 'text'), meta('v', 'any', true), meta('vt', 'text', true), meta('sq', 'int', true)];

/** A write's KEY — a compile-time expression, or `(o, k)` rows resolved per traverser. */
type RuntimeKey = { readonly kind: 'const'; readonly expr: Expr } | { readonly kind: 'rows'; readonly rows: Rel };

function keyedRows(values: Rel, targets: Rel, key: RuntimeKey, fresh: Minter): Rel {
  const targeted = make.join({
    id: fresh('j'), left: values, right: targets, join: 'inner', channels: [],
    type: typeOf(...values.type.cols, meta('to', 'int'), meta('owner', 'int')),
    on: eq(col(values.id, 'o'), col(targets.id, 'o')),
  });
  if (key.kind === 'const') {
    return make.project({
      id: fresh('kr'), input: targeted, channels: [], type: typeOf(...KEYED_ROW_COLS),
      exprs: KEYED_ROW_COLS.map((column) => [column.name, column.name === 'k' ? key.expr : col(targeted.id, column.name)] as const),
    });
  }
  const keyed = make.join({
    id: fresh('j'), left: targeted, right: key.rows, join: 'inner', channels: [],
    type: typeOf(...targeted.type.cols, meta('ko', 'int'), meta('k', 'text')),
    on: eq(col(targeted.id, 'o'), col(key.rows.id, 'o')),
  });
  return make.project({
    id: fresh('kr'), input: keyed, channels: [], type: typeOf(...KEYED_ROW_COLS),
    exprs: KEYED_ROW_COLS.map((column) => [column.name, col(keyed.id, column.name)] as const),
  });
}

/**
 * `property(k, __.trav)` — a per-traverser VALUE, as the statements it runs. The reference is
 * `AddPropertyStep.handleTraversalValue`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java:127-200`)
 * for an ordinary step, and `Parameters.getKeyValues` for a folded one (see `RuntimeSite`):
 *
 *  - **0 results → no mutation.** The traverser is simply absent from the value rows, so nothing is
 *    inserted AND nothing is replaced — the stale delete is scoped to the elements that got a value, which
 *    is what keeps `property(single, 'age', __.out('none').values('age'))` from erasing the old age. On a
 *    folded parameter 0 results is `TraversalUtil.apply`'s raise instead.
 *  - **>1 under an effective `single` → the reference's sentence, verbatim, with the count** (`:178-182`).
 *    The effective cardinality is `cardinalityOf`'s per-owner expression, so declared-single fires on any
 *    traverser with >1, declared-list/set never fires, and undeclared fires only where the element
 *    resolves single.
 *  - **>1 under `list`/`set` → each result is written**; a non-vertex takes the FIRST (`effectiveCard` is
 *    null for an edge, `:174-176`, so it falls to `results.get(0)`).
 *  - **Several traversers on ONE element** are the reference's loop run once each, so `single` leaves the
 *    LAST one's value, `set` keeps one copy of each distinct value, and `list` keeps all — the per-element
 *    reduction below states that as windows instead of as N statements. That is the loop only while no
 *    traverser's body reads what ANOTHER traverser wrote — at this step (the second run of
 *    `__.values('age').math('_+1')` reads the first's result) or at any other mutating step of the
 *    program, earlier or later, since the reference's lazy pipeline interleaves them per traverser. The
 *    caller's `sequentialGuard` refuses, at run time and before anything is written, every write whose
 *    body it cannot prove blind to all of those (`ProgramWrites` over-approximates them), so what reaches
 *    here reads the same values whichever order the traversers take.
 *
 * **THE VALUE IS READ BEFORE ANYTHING IT COULD READ IS CHANGED.** The reference resolves the body and
 * THEN mutates, so `property(single, 'age', __.values('age').math('_+1'))` reads the OLD age. Deleting
 * the displaced rows first and inserting second re-ran the body against a vertex that no longer had an
 * age, and wrote nothing at all. So the insert runs FIRST (its source is the only reader of the body that
 * writes anything), and the displaced rows are the ones for the same (element, key) that the insert did
 * NOT just create — read off its `RETURNING`, which is retained and so names exactly the new rows.
 *
 * NO in-plan FTS: a runtime value's index text is not known until it is stored, so the post-write refresh
 * (`src/refresh.ts`) indexes it from the stored `{t,v}` tree through the ONE authoritative walk — which
 * is also why stale-on-overwrite deletes stay here (`dropStaleIndex`), so the refresh only ever INSERTS.
 */
function runtimeWriteRows(
  elem: Elem, rows: Rel, mayBeMulti: boolean, cardinality: VertexCardinality | null, meta_: PropertyRuntimeSet['meta'],
  bind: Binder, guard: Guarder, fresh: Minter,
): void {
  const spec = PROPERTY_TABLE[elem === 'edge' ? 'edge' : 'vertex'];
  const card = (rel: Rel): Expr => cardinalityOf(col(rel.id, 'owner'), col(rel.id, 'k'), cardinality, fresh);

  // THE >1-UNDER-SINGLE RAISE, over the value rows counted per TRAVERSER — before anything is written.
  // Only a MANY-per-traverser body can overstep; a reducing/scalar one is one value by construction, and
  // an edge never raises (it takes the first).
  if (mayBeMulti && elem !== 'edge') {
    const counts = make.aggregate({
      id: fresh('rc'), input: rows, channels: [], type: typeOf(meta('o', 'int'), meta('owner', 'int'), meta('k', 'text'), meta('n', 'int')),
      groupBy: [col(rows.id, 'o'), col(rows.id, 'owner'), col(rows.id, 'k')], aggs: [['n', { kind: 'agg', fn: 'count', args: [compilerInt(1)] }]],
    });
    const offending = make.filter({
      id: fresh('rf'), input: counts, channels: [], type: counts.type,
      pred: and({ kind: 'binary', op: '>', left: col(counts.id, 'n'), right: compilerInt(1) }, eq(card(counts), text('single'))),
    });
    // The FIRST offending traverser is the one the reference raises on, and its count is the one it names.
    const first = make.sort({ id: fresh('so'), input: offending, channels: [], type: offending.type, terms: [{ expr: col(offending.id, 'o'), dir: 'asc' }] });
    guard(make.project({ id: fresh('p'), input: first, channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', col(first.id, 'n')]] }),
      { message: 'Single-cardinality property requires exactly one value, but traversal produced ', raiseWhen: 'rows', valueColumn: 'n', tail: ' results' });
  }

  // A DECLARED cardinality is a schema write, before anything reads it back — `propertyStatements`' rule.
  if (cardinality) {
    const target = make.scan({ id: fresh('t'), table: 'vertex_property_cardinality', alias: fresh('wt'), channels: [], type: typeOf(...CARDINALITY_COLS) });
    const declared = make.project({
      id: fresh('p'), input: rows, channels: [], type: typeOf(...CARDINALITY_COLS),
      exprs: [['node', col(rows.id, 'owner')], ['key', col(rows.id, 'k')], ['cardinality', text(cardinality)]],
    });
    bind(insert({
      target, cols: CARDINALITY_COLS.map((column) => column.name), source: declared, channels: [], type: typeOf(),
      onConflict: { target: ['node', 'key'], set: [['cardinality', col(EXCLUDED, 'cardinality')]] }, returning: [],
    }));
  }

  // THE PER-ELEMENT REDUCTION. `last` ranks an element's rows latest-traverser-first (one value survives
  // a `single`, and an edge is single by spec); `firstOfValue` ranks each distinct value's copies
  // earliest-first (one copy survives a `set`, and only if the element does not already hold it).
  const ranked = make.window({
    id: fresh('rn'), input: rows, channels: [], type: typeOf(...rows.type.cols, meta('last', 'int'), meta('fv', 'int')),
    specs: [
      ['last', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [col(rows.id, 'owner'), col(rows.id, 'k')], orderBy: [{ expr: col(rows.id, 'o'), dir: 'desc' }, { expr: col(rows.id, 'sq'), dir: 'desc' }] } }],
      ['fv', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [col(rows.id, 'owner'), col(rows.id, 'k'), col(rows.id, 'v')], orderBy: [{ expr: col(rows.id, 'o'), dir: 'asc' }, { expr: col(rows.id, 'sq'), dir: 'asc' }] } }],
    ],
  });
  const present = (): Expr => {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const matching = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), col(ranked.id, 'owner')), eq(col(scan.id, 'key'), col(ranked.id, 'k'))), eq(col(scan.id, 'value'), col(ranked.id, 'v'))),
    });
    return { kind: 'exists', plan: matching, negated: true };
  };
  const isLast = eq(col(ranked.id, 'last'), compilerInt(1));
  const keep: Expr | undefined = elem === 'edge' ? isLast
    : cardinality === 'list' ? undefined
    : cardinality === 'single' ? isLast
    : cardinality === 'set' ? and(eq(col(ranked.id, 'fv'), compilerInt(1)), present())
    : or(or(and(eq(card(ranked), text('single')), isLast), and(eq(card(ranked), text('set')), and(eq(col(ranked.id, 'fv'), compilerInt(1)), present()))),
      { kind: 'unary', op: 'not', arg: { kind: 'in-list', expr: card(ranked), values: [text('single'), text('set')] } });
  const kept = keep ? make.filter({ id: fresh('f'), input: ranked, channels: [], type: ranked.type, pred: keep }) : ranked;
  // IN TRAVERSER ORDER, then the child's own: rowids are assigned in source order, and a multi-property's
  // values read back in rowid order, so this is what keeps `property(list, k, __.out().values('name'))`
  // listing the names in the order the body produced them — WHERE THE PLAN STATES ONE. `sq` is the child's
  // encounter, and a body with none (or one a fan-out does not refine) ties every result of a traverser at
  // one `sq`; those rows are inserted in whatever order SQLite yields them, which is not claimed to be the
  // reference's iteration order. It decides only the ORDER of the values a list/set holds, never WHICH
  // values are written (unlike a "first" pick, which `firstPerTraverser` refuses on a tie).
  const ordered = make.sort({ id: fresh('so'), input: kept, channels: [], type: kept.type, terms: [{ expr: col(kept.id, 'o'), dir: 'asc' }, { expr: col(kept.id, 'sq'), dir: 'asc' }] });

  // An EDGE property is an UPSERT on `(edge, key)`, so the row id SURVIVES and the refresh — which skips a
  // pid it already indexed — would keep the OLD text. Its stale index rows go first, scoped to the
  // (element, key) pairs being written; the body has not been re-read by anything that mutated yet.
  if (elem === 'edge') {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const pairs = make.filter({ id: fresh('f'), input: rows, channels: [], type: rows.type, pred: and(eq(col(rows.id, 'owner'), col(scan.id, spec.owner)), eq(col(rows.id, 'k'), col(scan.id, 'key'))) });
    const displaced = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: { kind: 'exists', plan: pairs, negated: false } });
    bind(dropStaleIndex('edge', make.project({ id: fresh('p'), input: displaced, channels: [], type: ID_TYPE, exprs: [['id', col(displaced.id, 'id')]] }), fresh));
  }

  // Meta on a value a `set` element already holds is a PATCH of that row (`patchSetMeta`). It changes no
  // VALUE, so the insert below is still the first statement to change anything the body reads.
  if (elem !== 'edge' && meta_ !== null && (cardinality === null || cardinality === 'set')) {
    bind(patchSetMeta(meta_, cardinality, (t) => ({
      kind: 'exists', negated: false, plan: make.filter({
        id: fresh('f'), input: rows, channels: [], type: rows.type,
        pred: and(and(eq(col(rows.id, 'owner'), col(t.id, spec.owner)), eq(col(rows.id, 'k'), col(t.id, 'key'))), eq(col(rows.id, 'v'), col(t.id, 'value'))),
      }),
    }), fresh));
  }

  const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  const withMeta = elem !== 'edge' && meta_ !== null;
  const source = make.project({
    id: fresh('p'), input: ordered, channels: [],
    type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), ...(withMeta ? [meta('meta', 'blob', true)] : [])),
    exprs: [[spec.owner, col(ordered.id, 'owner')], ['key', col(ordered.id, 'k')], ['value', col(ordered.id, 'v')], ['vtype', col(ordered.id, 'vt')],
      ...(withMeta ? [['meta', metaExpr(meta_!)] as const] : [])],
  });
  const written = bind(insert({
    target, cols: [spec.owner, 'key', 'value', 'vtype', ...(withMeta ? ['meta'] : [])], source, channels: [], type: RUNTIME_WRITTEN_TYPE,
    ...(elem === 'edge' ? { onConflict: { target: ['edge', 'key'], set: [['value', col(EXCLUDED, 'value')], ['vtype', col(EXCLUDED, 'vtype')]] } } : {}),
    returning: [['id', col(target.id, 'id')], ['owner', col(target.id, spec.owner)], ['k', col(target.id, 'key')]],
  }));
  if (elem === 'edge') return;

  // THE DISPLACED ROWS of a `single` write — the same (element, key) as a row just written, not one of
  // them, on an element whose effective cardinality is `single`. AFTER the insert, so the body read the
  // pre-mutation value (see the header).
  const displaced = (scan: Rel): Expr => {
    const sameSlot = make.filter({ id: fresh('f'), input: written, channels: [], type: written.type, pred: and(eq(col(written.id, 'owner'), col(scan.id, spec.owner)), eq(col(written.id, 'k'), col(scan.id, 'key'))) });
    const newIds = make.project({ id: fresh('p'), input: written, channels: [], type: ID_TYPE, exprs: [['id', col(written.id, 'id')]] });
    return and(and({ kind: 'exists', plan: sameSlot, negated: false }, { kind: 'in-query', expr: col(scan.id, 'id'), plan: newIds, negated: true }),
      cardinality === 'single' ? undefined : eq(cardinalityOf(col(scan.id, spec.owner), col(scan.id, 'key'), null, fresh), text('single')));
  };
  if (cardinality !== 'list' && cardinality !== 'set') {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const stale = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: displaced(scan) });
    bind(dropStaleIndex('vertex', make.project({ id: fresh('p'), input: stale, channels: [], type: ID_TYPE, exprs: [['id', col(stale.id, 'id')]] }), fresh));
    const t = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    bind(remove({ target: t, channels: [], type: typeOf(), where: displaced(t), returning: [] }));
  }
}

/** `(id, owner, k)` — a runtime write's `RETURNING`: the new rows, and the (element, key) slot each
 *  fills, which is what the displaced-row delete matches on. */
const RUNTIME_WRITTEN_TYPE: RelType = typeOf(meta('id', 'int'), meta('owner', 'int'), meta('k', 'text'));

/**
 * ONE runtime `property()` over a site, in TWO PHASES: resolve the key and the value — pushing every
 * refusal the resolved values owe — and hand back the writer, which needs only the `(o, owner)` targets.
 *
 * Split because a FOLDED parameter's refusals must land before the CREATION, which is also before its
 * targets exist: the reference resolves an `addV`'s parameters and only then calls `addVertex`
 * (`AddVertexStep.map`, `step/map/AddVertexStep.java:140-162`), so an absent value raises with nothing
 * created. An ordinary step simply applies the writer at once. `null` declines.
 *
 * **A FOLDED parameter's values are also TAKEN before the creation** — snapshot bindings, read once — and
 * not merely checked then. The writer's insert runs after the creation, and a body re-run there sees the
 * graph the creation changed: `g.V(1,4).addE('e').to(__.V(2)).property('w', __.out().values('name'))`
 * found its OWN new edge and named vadas for both. The ordinary step needs no snapshot: its insert is the
 * first statement that changes anything its body could read (see `runtimeWriteRows`).
 */
function prepareRuntimeWrite(
  elem: Elem, site: RuntimeSite, write: PropertyRuntimeSet, fresh: Minter, child: ChildSeam, guard: Guarder,
  bind?: Binder, sequenced = false,
): ((targets: Rel, bind: Binder) => void) | null {
  const value = write.value;
  const resolved = 'body' in value ? resolveValueRows(value.body, site, child, fresh) : {
    // A CONSTANT value under a runtime key is one row per traverser — the same relation, so the writer
    // below has one input shape and not two.
    rel: make.project({
      id: fresh('rv'), input: site.host, channels: [], type: typeOf(...VALUE_ROW_COLS),
      exprs: [['o', col(site.host.id, site.origin)], ['v', value.expr], ['vt', value.vtype === null ? compilerNull('text') : compilerText(value.vtype)], ['sq', compilerInt(0)]],
    }),
    mayBeMulti: false,
    framing: { kind: 'scalar', type: { kind: 'unknown' } } as RelFraming,
  };
  if (!resolved) return null;
  // Before anything is resolved into a write: whether one statement can stand for the reference's
  // one-traverser-at-a-time loop — unless the caller asked that ahead of its whole run.
  if (!sequenced) sequenceGuard(site, write, child, guard, fresh);
  let key: RuntimeKey;
  if (typeof write.key === 'string') key = { kind: 'const', expr: propertyKeyExpr(write.key, write.keyName) };
  else {
    const rows = runtimeKeyRows(write.key.body, site, child, guard, fresh);
    if (!rows) return null;
    key = { kind: 'rows', rows: bind ? bind(rows, true) : rows };
  }
  // A FOLDED parameter is one value or a raise; an edge property is the first of several (see the
  // writer's header).
  const first = site.resolve === 'first' || elem === 'edge';
  if (site.resolve === 'first') absentGuard(site, resolved.rel, guard, fresh);
  const values = first ? firstPerTraverser(resolved.rel, guard, fresh) : resolved.rel;
  // Only the values the write APPLIES are asked: a null behind the first result of a folded parameter or
  // an edge value is never applied by the reference either.
  nullValueGuard(values, guard, fresh);
  const taken = bind ? bind(transportableValues(values, fresh), true) : values;
  return (targets, bindLater) => runtimeWriteRows(
    elem, keyedRows(taken, targets, key, fresh), resolved.mayBeMulti && !first, write.cardinality, write.meta, bindLater, guard, fresh,
  );
}

/**
 * Value rows as a RETAINED binding can carry them. A snapshot crosses as JSON (§6·2), which has one
 * number type: an untyped REAL `2.0` would come back INTEGER `2` and frame as an Int. Its type is what
 * an untyped REAL frames as anyway — a Double — so stating it keeps the answer the storage class gave.
 */
function transportableValues(values: Rel, fresh: Minter): Rel {
  const v = col(values.id, 'v');
  return make.project({
    id: fresh('tv'), input: values, channels: [], type: values.type,
    exprs: values.type.cols.map((column) => [column.name, column.name !== 'vt' ? col(values.id, column.name) : {
      kind: 'call', fn: 'coalesce', args: [col(values.id, 'vt'), {
        kind: 'case', whens: [[eq({ kind: 'call', fn: 'typeof', args: [v] }, text('real')), text('double')]], else: compilerNull('text'),
      }],
    }] as const),
  });
}

/**
 * `property(__.trav)` — the MAP FORM (`AddPropertyStep.handleTraversalValue`, `mapForm`, `:147-169`): the
 * body's ONE result is a `Map`, and each entry is a property under the graph's default cardinality.
 *
 * Covered where the map is a RECORD — a map whose keys are known at compile time (`project(…)`,
 * `select(a, b)`) — because then every entry is a column, and the whole write is the runtime writer over a
 * UNION of one keyed row set per field: ONE insert, so the body is read once, before anything changes, as
 * the reference reads it. Declined: an EDGE (a map entry is a vertex-cardinality write), a map whose keys
 * only exist at run time, a field whose value is not a scalar, and an OPTIONAL field that may be a
 * productive null (a required one is refused at run time only if a null actually arrives).
 *
 * The refusals are the reference's: >1 result is *"property(traversal) requires the traversal to produce
 * a Map, but got: "* naming the first result's class — a `LinkedHashMap`, which is what both record
 * producers build (`ProjectStep.java:64`, `SelectStep`). 0 results is no mutation.
 */
function mapFormStatements(
  elem: Elem, site: RuntimeSite, targets: Rel, body: readonly IRStep[], bind: Binder, fresh: Minter,
  child: ChildSeam, guard: Guarder,
): boolean {
  if (elem === 'edge') return false;
  const rows = child.rows(body, site.host, site.hostElem, site.aliases, site.origin);
  if (!rows || rows.framing.kind !== 'record' || !rows.framing.fields.length) return false;
  const rel = rows.rel;
  // An entry's ORDER is its key's position in the map — `LinkedHashMap` iterates in insertion order and
  // the reference applies the entries in that order (`AddPropertyStep.java:152-160`) — which is what
  // `sq` carries for the writer's per-traverser ordering, there being one map per traverser.
  const perField: Rel[] = [];
  for (const [index, field] of rows.framing.fields.entries()) {
    // A productive NULL would be `property(k, null)` — a REMOVAL, which this writer does not emit. For a
    // REQUIRED field the row says whether one arrived, so `nullValueGuard` below refuses it at run time
    // exactly as the step form does (`resolveValueRows`). An OPTIONAL field cannot say: its absence IS a
    // null first column (`record.ts` `presence`), so a real null and a missing entry are one row — and
    // they owe different answers (a removal vs. no mutation). That one is declined.
    if (field.framing.kind !== 'scalar' || (field.optional && field.framing.productiveNull)) return false;
    try { validatePropertyKey(field.key); } catch { return false; }
    const cols = framingCols(field.framing);
    if (!cols) return false;
    const typeCol = cols.find((column) => column.name !== 'v');
    const value = col(rel.id, fieldCol(field.prefix, 'v'));
    const vt = typeCol && typeCol.name === 'vtype' ? col(rel.id, fieldCol(field.prefix, 'vtype'))
      : typeCol && typeCol.name === 'vt' ? reducedVtype(col(rel.id, fieldCol(field.prefix, 'vt'))) : scalarVtype(field.framing);
    const entry = make.project({
      id: fresh('mf'), input: rel, channels: [], type: typeOf(...VALUE_ROW_COLS, meta('k', 'text')),
      exprs: [['o', col(rel.id, rows.origin)], ['v', value], ['vt', vt],
        ['sq', compilerInt(index)], ['k', text(field.key)]],
    });
    // An OPTIONAL field is an entry the map may not HAVE — `ProjectStep` omits an unproductive `by()`'s
    // key (`ProjectStep.java:66`) — and its absence is the record's own presence test (`record.ts`
    // `presence`: the field's first column is NULL), so the entry is simply not a row.
    perField.push(field.optional
      ? make.filter({ id: fresh('f'), input: entry, channels: [], type: entry.type, pred: { kind: 'binary', op: 'is not', left: col(entry.id, 'v'), right: compilerNull() } })
      : entry);
  }
  // MORE THAN ONE MAP for a traverser is the reference's refusal, before anything is written.
  const counts = make.aggregate({
    id: fresh('rc'), input: rel, channels: [], type: typeOf(meta('o', 'int'), meta('n', 'int')),
    groupBy: [col(rel.id, rows.origin)], aggs: [['n', { kind: 'agg', fn: 'count', args: [compilerInt(1)] }]],
  });
  const many = make.filter({ id: fresh('rf'), input: counts, channels: [], type: counts.type, pred: { kind: 'binary', op: '>', left: col(counts.id, 'n'), right: compilerInt(1) } });
  guard(make.project({ id: fresh('p'), input: many, channels: [], type: typeOf(meta('o', 'int')), exprs: [['o', col(many.id, 'o')]] }),
    { message: 'property(traversal) requires the traversal to produce a Map, but got: LinkedHashMap', raiseWhen: 'rows' });
  const entries = perField.length === 1 ? perField[0]! : make.union({ id: fresh('u'), inputs: perField, all: true, channels: [], type: perField[0]!.type });
  // The map's entries are writes like any other: refused where an entry the map DOES have holds a null —
  // and, by the caller before the run's first statement (`sequenceGuard`), where one statement cannot
  // stand for the reference's per-traverser loop.
  nullValueGuard(entries, guard, fresh);
  const keyed = make.join({
    id: fresh('j'), left: entries, right: targets, join: 'inner', channels: [],
    type: typeOf(...entries.type.cols, meta('to', 'int'), meta('owner', 'int')),
    on: eq(col(entries.id, 'o'), col(targets.id, 'o')),
  });
  const keyedRows_ = make.project({
    id: fresh('kr'), input: keyed, channels: [], type: typeOf(...KEYED_ROW_COLS),
    exprs: KEYED_ROW_COLS.map((column) => [column.name, col(keyed.id, column.name)] as const),
  });
  runtimeWriteRows(elem, keyedRows_, false, null, null, bind, guard, fresh);
  return true;
}

/**
 * A runtime `onMatch`/`onCreate` VALUE — resolved at the DRIVER, written onto the merged element.
 *
 * `MergeVertexStep` materializes the onMatch/onCreate map at the INCOMING traverser
 * (`materializeMap(traverser, …)`, `MergeVertexStep.java:103`/`:153`), NOT at the matched/created
 * element — so a computed value there is the DRIVER's, applied onto whatever the merge produced. That
 * is the whole difference from the `property()` tail (an ordinary `AddPropertyStep` rooted at the merge
 * OUTPUT). It resolves as a ROOTED SCALAR over the driver relation: for the common single-driver merge
 * that is exact; a multi-driver CONSTANT search shares its matches, so the value is one driver's (the
 * first) — a degenerate shape with no observable order and no corpus scenario. FTS is deferred to the
 * post-write refresh like every runtime value.
 */
function mergeArmValueWrite(
  target: Rel, driver: Rel, write: PropertyRuntimeSet, driverElem: Elem | undefined, bind: Binder, fresh: Minter,
  child: ChildSeam, aliases: AliasMap,
): boolean {
  const spec = PROPERTY_TABLE.vertex;
  // A merge map's keys are literal and its values carry no meta, so only the plain form arrives here.
  if (typeof write.key !== 'string' || !('body' in write.value) || write.meta !== null) return false;
  const key = propertyKeyExpr(write.key, write.keyName);
  // The value body is rooted at the DRIVER, so it reads the driver's element kind; `?? 'vertex'`
  // preserves the prior hardcode for a cannot-say driver. The WRITE target is `vertex` (mergeV only).
  const resolved = resolveValueRows(write.value.body, { host: driver, hostElem: driverElem ?? 'vertex', origin: 'id', aliases, resolve: 'first' }, child, fresh);
  if (!resolved) return false;
  const valueRel = resolved.rel;
  // The driver's value as a rooted scalar — one value for the (shared) merged elements.
  const one = make.limit({ id: fresh('li'), input: valueRel, channels: valueRel.channels, type: valueRel.type, count: compilerInt(1) });
  const scalarOf = (column: string, kind: 'any' | 'text'): Expr => ({
    kind: 'scalar', plan: make.project({ id: fresh('p'), input: one, channels: [], type: typeOf(meta(column, kind, true)), exprs: [[column, col(one.id, column)]] }),
  });
  const valueExpr = scalarOf('v', 'any');
  const vtypeExpr: Expr = scalarOf('vt', 'text');
  const ids = idsOf(target, fresh);
  const owner = (rel: Rel): Expr => col(rel.id, 'id');

  // A `single` (declared, or the element default) REPLACES the merged elements' rows for the key.
  const replaces = write.cardinality === 'single' || write.cardinality === null;
  if (replaces) {
    const g = write.cardinality === 'single' ? undefined : (o: Expr): Expr => eq(cardinalityOf(o, key, null, fresh), text('single'));
    const stale = existingRows('vertex', ids, key, g, fresh);
    bind(dropStaleIndex('vertex', stale.ids, fresh));
    const t = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    bind(remove({ target: t, channels: [], type: typeOf(), where: stale.pred(t), returning: [] }));
  }
  // A `set` write (declared, or the element default) does not re-insert a value already present.
  const skippable = write.cardinality !== 'single' && write.cardinality !== 'list';
  const present = (): Expr => {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const matching = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), owner(ids)), eq(col(scan.id, 'key'), key)), eq(col(scan.id, 'value'), scalarOf('v', 'any'))),
    });
    return { kind: 'exists', plan: matching, negated: true };
  };
  const seed = skippable
    ? make.filter({ id: fresh('f'), input: ids, channels: ids.channels, type: ids.type,
        pred: { kind: 'binary', op: 'or', left: { kind: 'binary', op: '!=', left: cardinalityOf(owner(ids), key, write.cardinality, fresh), right: text('set') }, right: present() } })
    : ids;
  const t = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  const source = make.project({
    id: fresh('p'), input: seed, channels: [], type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    exprs: [[spec.owner, owner(seed)], ['key', key], ['value', valueExpr], ['vtype', vtypeExpr]],
  });
  bind(insert({ target: t, cols: [spec.owner, 'key', 'value', 'vtype'], source, channels: [], type: WRITTEN_TYPE, returning: [['id', col(t.id, 'id')], ['owner', col(t.id, spec.owner)]] }));
  return true;
}

/**
 * A RUNTIME `onMatch`/`onCreate` value over a CORRELATED merge search — resolved at the DRIVER, written
 * onto the PER-DRIVER merged element (`target` = `(ord, id)`).
 *
 * The difference from `mergeArmValueWrite` is the correlation: a correlated search's drivers match (or
 * create) DIFFERENT elements, so the arm value cannot be one rooted scalar shared across them — it is
 * resolved per driver (`child.scalar` over the incoming stream) and JOINED to the target by `ord`, so
 * each merged element gets ITS OWN driver's value. A merge arm value is SINGLE per driver
 * (`materializeMap` = `TraversalUtil.apply`.next()), so this covers single/default (a `replace`); an
 * explicit `list`/`set` arm cardinality declines (fail closed — no corpus, and the set-dedup would need
 * the per-owner form `runtimeWriteRows` builds).
 */
function armValueWriteCorrelated(
  target: Rel, incoming: Rel, hasOrd: boolean, write: PropertyRuntimeSet, driverElem: Elem | undefined,
  bind: Binder, fresh: Minter, child: ChildSeam, aliases: AliasMap,
): boolean {
  if (write.cardinality === 'list' || write.cardinality === 'set') return false;
  // The WRITE lands on the merged VERTEX (a runtime EDGE property value is declined upstream in
  // `writeOf`, so this is only ever reached for a vertex merge). The VALUE body is rooted at the DRIVER
  // (`driverElem` — the incoming stream's kind), `?? 'vertex'` preserving the prior hardcode for a
  // cannot-say driver.
  const spec = PROPERTY_TABLE.vertex;
  if (typeof write.key !== 'string' || !('body' in write.value) || write.meta !== null) return false;
  const key = propertyKeyExpr(write.key, write.keyName);
  const host: ChildHost = { kind: 'element', id: col(incoming.id, 'id'), elem: driverElem ?? 'vertex', row: { rel: incoming, aliases } };
  const produced = child.scalar(write.value.body, host);
  if (!produced || produced.framing.kind !== 'scalar' || produced.present === undefined) return false;
  // The value AT the driver, carrying the driver's `ord` so it lands on the right merged element. An
  // unproductive driver is filtered out (the reference's 0-result skip), the same shape the carrier uses.
  const valsAll = make.project({
    id: fresh('av'), input: incoming, channels: [],
    type: typeOf(...(hasOrd ? [meta('vord', 'int')] : []), meta('v', 'any', true), meta('vtype', 'text', true), meta('present', 'int', true)),
    exprs: [...(hasOrd ? [['vord', col(incoming.id, ORD)] as const] : []), ['v', produced.expr], ['vtype', produced.vtype ?? compilerNull('text')], ['present', produced.present]],
  });
  const vals = make.filter({ id: fresh('af'), input: valsAll, channels: [], type: valsAll.type, pred: col(valsAll.id, 'present') });
  const joined = make.join({
    id: fresh('j'), left: target, right: vals, channels: [],
    ...(hasOrd ? { join: 'inner' as const, on: eq(col(target.id, ORD), col(vals.id, 'vord')) } : { join: 'cross' as const }),
    type: typeOf(...target.type.cols, ...vals.type.cols),
  });
  const paired = bind(make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(meta('id', 'int'), meta('v', 'any', true), meta('vtype', 'text', true)),
    exprs: [['id', col(joined.id, 'id')], ['v', col(joined.id, 'v')], ['vtype', col(joined.id, 'vtype')]],
  }), true);
  const ids = idsOf(paired, fresh);
  // REPLACE the key on the merged vertices (single, declared or the element default) before the insert.
  const g = write.cardinality === 'single' ? undefined : (owner: Expr): Expr => eq(cardinalityOf(owner, key, null, fresh), text('single'));
  const stale = existingRows('vertex', ids, key, g, fresh);
  bind(dropStaleIndex('vertex', stale.ids, fresh));
  const t0 = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  bind(remove({ target: t0, channels: [], type: typeOf(), where: stale.pred(t0), returning: [] }));
  const t = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  const source = make.project({
    id: fresh('p'), input: paired, channels: [], type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    exprs: [[spec.owner, col(paired.id, 'id')], ['key', key], ['value', col(paired.id, 'v')], ['vtype', col(paired.id, 'vtype')]],
  });
  bind(insert({ target: t, cols: [spec.owner, 'key', 'value', 'vtype'], source, channels: [], type: WRITTEN_TYPE, returning: [['id', col(t.id, 'id')], ['owner', col(t.id, spec.owner)]] }));
  return true;
}

/** Push a binding and hand back a `Ref` to it — the one place a name is minted, so a statement can
 *  read the rows of the statement before it without the caller threading names. */
type Binder = (node: Stmt | Rel, snapshot?: boolean, channels?: Channels) => Rel;

/** Push a GUARD binding — a refusal the graph decides, carried by the plan (§6·5). Separate from
 *  `Binder` because nothing reads its `Ref`: what it returns is a step, not a relation, and giving
 *  the caller one would invite a read of rows whose only purpose is to be counted. */
type Guarder = (node: Rel, guard: Guard) => void;

/**
 * A run of `property()` steps over the elements a read prefix selected — the effects, plus the SAME
 * elements to keep folding from.
 *
 * The result is the snapshot re-projected as an element relation, which is the whole reason this
 * step needs no continuation machinery: `property()` is element-PRESERVING, so what comes after it
 * is the ordinary element tail over the ids it already holds.
 *
 * The snapshot carries the element's CHANNELS as well as its id, so an emission order survives the
 * write — and only the channels JSON can carry losslessly, which is why an alias history (a JSONB
 * blob) DECLINES rather than arriving at the executor as something a `transportable` check would
 * have to refuse at run time.
 */
export function elementProperty(target: Rel, elem: Elem, writes: readonly PropertyWrite[], child: ChildSeam, aliases: AliasMap, fresh: Minter): Effects | null {
  // A role this route cannot put through a snapshot is a DECLINE, not a dropped channel: a `sack` or
  // a `path` would come back missing and the next reader of it would answer a different question.
  const carried = writeInputChannels(target);
  if (carried.length !== target.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = inputRows(target, writeInputCols(target), fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const owners = bind(seeded.result, true, carried);
  // A runtime value body that does not lower to a scalar DECLINES the whole write (`false`), which is
  // the ordinary miss the fold turns into `UnsupportedTraversal` — never a silent skip.
  // Every runtime write's sequential refusal FIRST, before the run's first statement: it reads only the
  // snapshot, so asking it early changes no answer, and asking it late would leave the run's earlier
  // writes applied by a traversal that is then refused.
  for (const write of writes) if (write.kind === 'runtime' || write.kind === 'map') sequenceGuard(ownerSite(owners, elem, aliases, fresh).site, write, child, guard, fresh);
  for (const write of writes) if (!propertyStatements(elem, owners, write, bind, fresh, child, aliases, guard, true)) return null;
  // Touch the rev of every mutated element: a `property()` write changed their content (§5·1).
  bind(markDirty(elem, idsOf(owners, fresh), fresh));
  // Back to an ELEMENT relation. `property()` is element-PRESERVING, so this IS the snapshot — no
  // correlation to do, unlike a creation, whose output rows say nothing about which input made them.
  // `bulk` is re-minted at 1 because the snapshot did not carry it: a multiplicity is a fact about
  // the stream that a write neither reads nor changes, and re-declaring it is cheaper than
  // round-tripping it. The position column the snapshot carries is dropped here — it exists to
  // correlate, and there is nothing to correlate with.
  const channels: Channels = [...carried.filter((channel) => channel.role === 'alias'), BULK_CHANNEL,
    ...carried.filter((channel) => channel.role === 'encounter')];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  const result = make.project({
    id: fresh('c'), input: owners, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, column.name === 'bulk' ? compilerInt(1) : col(owners.id, column.name)] as const),
  });
  // The target's own CTEs first: they are read by the snapshot's step alone, which is the case
  // `checkSnapshots` leaves alone.
  return { bindings: [...seeded.bindings, ...bindings], result };
}

/**
 * A LABEL-MUTATION STEP'S ARGUMENTS → the names it addresses, or `null` for a form this route
 * declines. ONE authority because `addLabel`, `dropLabel` and `dropLabels` all ask it and the
 * argument grammar is one grammar — three copies would be three chances to fold a `constant(...)`
 * differently or to admit a mixed collection at one host and refuse it at another.
 *
 * A name is a bare string, a compile-time `constant(...)` (a string or a list), or a collection as
 * the SOLE argument. Declined: a nested traversal that does not fold to a constant (a per-row label),
 * and a collection MIXED with other arguments — TinkerPop rejects that outright (`DropLabel.feature`
 * asserts an error "containing text of `Collection`"), so it is an error to raise rather than a write
 * this route may silently reinterpret.
 *
 * `dropLabels()` is deliberately NOT a caller: it takes no arguments and means every label, which is
 * an absent list rather than an empty one.
 */
function mutationLabelNames(
  step: IRStep, sideEffects: Map<string, any> | undefined, params: Record<string, any>,
): readonly string[] | null {
  const args = step.args.map((a) => a.value);
  const names: string[] = [];
  for (const value of args) {
    let resolved: unknown = value;
    if (isNested(value)) {
      const folded = constFromNested(value, sideEffects, params);
      if (!folded.has) return null;
      resolved = folded.value;
    }
    if (Array.isArray(resolved)) {
      if (args.length > 1) return null;
      names.push(...resolved.map(String));
    } else names.push(String(resolved));
  }
  return names;
}

/**
 * `addLabel(...)` over an EXISTING vertex stream — a sideEffect that ADDS labels idempotently and
 * passes the SAME vertices through. It is `internLabels`' creation pairing applied to rows that
 * already exist rather than freshly-inserted ones, plus `elementProperty`'s snapshot-then-pass-through.
 *
 * The REFUSALS decline (return `null`) rather than throw: `lowerToRel` must never throw (the
 * `rel-sweep` decline-contract gate), so a form it cannot cover surfaces as `UnsupportedTraversal`
 * rather than being mis-executed. Declined:
 *
 * - an EDGE (edge label cardinality is fixed at ONE by spec — `AddLabel.feature` `g_E_addLabelXfriendX`);
 * - an immutable graph (`labelCardinality.mutable === false` — `g_V_addLabelXemployeeX_single_label_graph`);
 * - a collection argument mixed with others (TinkerPop rejects it), or a nested traversal that is not
 *   a compile-time `constant(...)` (a per-row label value).
 *
 * `addLabel` needs no post-mutation count guard: every MUTABLE cardinality has `max = Infinity`, so a
 * label added to a vertex can never overstep it. (`dropLabels`, which can fall BELOW `min`, is the case
 * that would — a guard binding, and not this step.) The `vertex_labels` PRIMARY KEY (node, label) makes
 * a repeated `addLabel(x)` a no-op via `ON CONFLICT DO NOTHING`.
 */
export function elementAddLabel(
  input: Rel, elem: Elem, step: IRStep,
  sideEffects: Map<string, any> | undefined, params: Record<string, any>, fresh: Minter,
): Effects | null {
  if (elem === 'edge') return null;

  const names = mutationLabelNames(step, sideEffects, params);
  if (!names?.length) return null;
  // `addLabel` VALIDATES and `dropLabel` does not, which is the reference's own asymmetry rather than
  // an oversight here: a name being added becomes a stored label and goes through `ElementHelper`,
  // while a name being removed is only ever COMPARED against the ones already stored — an invalid one
  // simply matches nothing, which is the same no-op `dropLabel("xyz")` already is.
  try { for (const name of names) validateLabel(name); } catch { return null; }

  const scope = labelMutationScope(input, fresh);
  if (!scope) return null;

  bindLabels(scope.ownerIds(), names, scope.bind, fresh);
  return scope.passThrough();
}

/**
 * BIND A SET OF LABELS TO A SET OF VERTICES, idempotently — the statement `addLabel` IS, factored out
 * because a merge's `onMatch` arm needs exactly it and nothing else of that step.
 *
 * A CROSS JOIN pairs every owner with every label — `addVertex`'s pairing, but the left side is
 * EXISTING ids. Both sides project to a single `id` column so the join's positional output is exactly
 * `(node, label)`. `vertex_labels` is `PRIMARY KEY (node, label)`, so a label already carried is a
 * no-op through `ON CONFLICT DO NOTHING` rather than through a check this had to write.
 */
function bindLabels(ownerIds: Rel, names: readonly string[], bind: Binder, fresh: Minter): void {
  const labelRow = internLabels(names.map(text), bind, fresh)!; // `names` is non-empty, so never the null arm
  const target = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
  const pairs = make.join({
    id: fresh('j'), left: ownerIds, right: labelRow, join: 'cross', channels: [],
    type: typeOf(meta('node', 'int'), meta('label', 'int')),
  });
  bind(insert({
    target, cols: ['node', 'label'], source: pairs, channels: [], type: typeOf(), returning: [],
    onConflict: { target: ['node', 'label'], set: [] },
  }));
}

/**
 * THE SHAPE EVERY LABEL SIDE-EFFECT HAS — snapshot the incoming vertices, run statements against the
 * snapshot, hand the SAME vertices back.
 *
 * Shared by `addLabel` and `dropLabel`/`dropLabels` because it is the whole of what they have in
 * common and none of what differs: they are `elementProperty`'s snapshot-then-pass-through with a
 * different statement in the middle. Two copies of it would be two chances to drop a channel on one
 * host only — and a channel this route cannot put through a snapshot is a DECLINE (`null`), never a
 * silently dropped one, because a `sack` or a `path` would come back missing and the next reader of
 * it would answer a different question.
 *
 * `passThrough()` reads the binding list at CALL time, so it must be called last — after every
 * `bind`/`guard` the caller makes.
 */
function labelMutationScope(input: Rel, fresh: Minter): {
  readonly bind: Binder; readonly guard: Guarder;
  /** The snapshot as a bare `(id)` relation — what a statement addresses its rows by. */
  readonly ownerIds: () => Rel;
  readonly passThrough: () => Effects;
} | null {
  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const owners = bind(seeded.result, true, carried);
  // Touch the rev of every mutated vertex: an add/drop of a label changed its content (§5·1). This
  // scope is vertex-only (`addLabel`/`dropLabel` decline edges above), so the element kind is fixed.
  bind(markDirty('vertex', make.project({ id: fresh('p'), input: owners, channels: [], type: ID_TYPE, exprs: [['id', col(owners.id, 'id')]] }), fresh));
  return {
    bind, guard,
    ownerIds: () => make.project({ id: fresh('p'), input: owners, channels: [], type: ID_TYPE, exprs: [['id', col(owners.id, 'id')]] }),
    passThrough: () => {
      // Back to an ELEMENT relation, element-PRESERVING exactly as `elementProperty` is: the snapshot
      // IS the pass-through, `bulk` re-minted at 1 because the snapshot did not carry it.
      const channels: Channels = [...carried.filter((channel) => channel.role === 'alias'), BULK_CHANNEL,
        ...carried.filter((channel) => channel.role === 'encounter')];
      const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
      const result = make.project({
        id: fresh('c'), input: owners, channels, type: typeOf(...cols),
        exprs: cols.map((column) => [column.name, column.name === 'bulk' ? compilerInt(1) : col(owners.id, column.name)] as const),
      });
      return { bindings: [...seeded.bindings, ...bindings], result };
    },
  };
}

/**
 * `dropLabel(…)` / `dropLabels()` over an EXISTING vertex stream — `addLabel`'s mirror, one DELETE
 * where that one has an INSERT, and the same snapshot-then-pass-through around it.
 *
 * **The two steps differ only in WHICH labels and in WHEN the cardinality floor can be decided, and
 * that second difference is the whole design** (`structure/util/LabelCardinalityValidator.java`):
 *
 * - `dropLabels()` is `validateDropAll`, which raises for ANY `min > 0` *whatever the element
 *   carries*. That is a COMPILE-TIME question the moment the cardinality is threaded, so it declines
 *   here rather than becoming a guard — under `ONE_OR_MORE` no vertex can ever survive it.
 * - `dropLabel(x…)` is `validateDrop`, which SIMULATES the removal and raises only if the survivors
 *   fall below `min`. That is arithmetic over the DATA, so it is a GUARD BINDING (§6·5) — the general
 *   lesson the `addE` id collision established, applied to a refusal that is per ROW rather than per
 *   plan. `addLabel` needed none because every MUTABLE cardinality has `max = Infinity`; this is the
 *   step at the other end of that sentence.
 *
 * The guard runs BEFORE the delete, which is the reference's own order — it simulates the removal
 * rather than performing and inspecting one — and it is also what keeps the refusal from leaving a
 * partly-stripped vertex behind.
 *
 * Declined for `addLabel`'s reasons and no others: an EDGE (edge label cardinality is fixed at ONE by
 * spec — `DropLabel.feature` `g_E_dropLabelXknowsX_labels`), an immutable graph, and a collection
 * argument mixed with others. `dropLabel("xyz")` on a label the vertex does not carry is a NO-OP and
 * not an error — the DELETE simply matches nothing, which is what the scenario asserts.
 */
export function elementDropLabel(
  input: Rel, elem: Elem, step: IRStep,
  sideEffects: Map<string, any> | undefined, params: Record<string, any>, fresh: Minter,
): Effects | null {
  if (elem === 'edge') return null;
  const all = step.name === 'dropLabels';
  if (all && step.args.length) return null;
  // `null` NAMES means EVERY label, and that reading belongs to `dropLabels()` ALONE — the branch is
  // on the step, never on the resolver's answer. `mutationLabelNames` also returns `null`, and there
  // it means DECLINE; conflating the two made `dropLabel(constant(["a","b"]), constant("c"))` — a
  // mixed collection TinkerPop rejects — silently drop every label the vertex had instead of
  // declining it as unsupported.
  const names = all ? null : mutationLabelNames(step, sideEffects, params);
  if (!all && !names?.length) return null;

  const scope = labelMutationScope(input, fresh);
  if (!scope) return null;
  scope.bind(deleteVertexLabels(scope.ownerIds(), names, fresh));
  return scope.passThrough();
}

/** `DELETE FROM vertex_labels WHERE node IN <owners>` — narrowed to the NAMED labels, or every label
 *  when `names` is null (`dropLabels()`). The name set is bounded by the QUERY TEXT and never by row
 *  count, so an `InList` inside the `labels` lookup is right here and a JSON bind is not. */
function deleteVertexLabels(owners: Rel, names: readonly string[] | null, fresh: Minter): Stmt {
  if (!names) return deleteOwnedBy('vertexLabels', owners, fresh);
  const { table, owner, cols } = OWNED_BY.vertexLabels;
  const target = make.scan({ id: fresh('t'), table, alias: fresh('wt'), channels: [], type: typeOf(...cols) });
  return remove({
    target, channels: [], type: typeOf(),
    where: and(
      { kind: 'in-query', expr: col(target.id, owner), plan: owners, negated: false },
      { kind: 'in-query', expr: col(target.id, 'label'), plan: namedLabelIds(names, fresh), negated: false },
    )!,
    returning: [],
  });
}

/** The ids of a compile-time set of label NAMES — `labels` is the name→id interning table, and a name
 *  that was never interned simply contributes no row, which is why `dropLabel("xyz")` is a no-op. */
function namedLabelIds(names: readonly string[], fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-list', expr: col(scan.id, 'name'), values: names.map((name) => text(name)) },
  });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: ID_TYPE, exprs: [['id', col(matching.id, 'id')]] });
}


/**
 * A run of `property()` STEPS → what this route can write, or `null` for a form it does not cover.
 *
 * **The parse is `parseProperty`'s**, the one authority, which is §6·6's rule applied where it bites
 * hardest: the cardinality position, the `T`-token form, a `__.select(<withSideEffect const>)` key
 * and the per-argument type channel are four things a second parser would have four chances to get
 * differently, and one of them (the sideEffect-constant VALUE) had once drifted between two copies
 * before they were merged. What is re-expressed here is the EMISSION, nothing else.
 *
 * What declines, each because the compile-time value does not carry what the answer needs:
 *
 * - a **nested traversal** key or value — its rows are known only at run time, so neither the stored
 *   value nor its index text exists yet.
 * - a **meta-property**, and a **`T` token** key (an id/label write on an existing element, which is
 *   an unsupported form).
 * - an **edge** carrying a cardinality or meta at all, which TinkerPop's `Property` has neither of.
 */
export function propertyWrites(steps: readonly IRStep[], elem: Elem, child: ChildSeam): readonly PropertyWrite[] | null {
  const writes: PropertyWrite[] = [];
  for (const step of steps) {
    if (step.modulators?.length || step.optionArms) return null;
    let parsed: ParsedProperty;
    // A `Deferral` is "not learned yet" and DECLINES; anything else has already been raised by the
    // `writeArguments` verify Pass, which runs earlier, so it cannot arrive here (§6·5). The
    // narrowed catch is the point: the blanket one swallowed a text-level ERROR too, and the census
    // then counted a REFUSED traversal as an uncovered gap forever.
    try { parsed = parseProperty(step, child.sideEffects, child.params); }
    catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
    if (parsed.kind === 'mapBody') {
      const body = child.body(parsed.nested.nested, 'child');
      if (!body?.length) return null;
      writes.push({ kind: 'map', body, step });
      continue;
    }
    if (parsed.kind !== 'prop') return null;
    const write = writeOf(parsed.spec, elem, child, true);
    if (!write) return null;
    writes.push(write.kind === 'runtime' ? { ...write, step } : write);
  }
  return writes.length ? writes : null;
}

/**
 * IS THIS `property()` FOLDED INTO THE CREATION BEFORE IT — `GraphTraversal.property`'s own test
 * (`dsl/graph/GraphTraversal.java:4034-4037`), asked of a step that follows an `addV`. A folded step is a
 * PARAMETER of the creation: applied when the vertex is made, before any unfolded `property()`, and with
 * a traversal value resolved against the creation's INCOMING traverser. Every `property()` after an
 * `addE` folds (an edge property has no cardinality and no meta to stop it), so only `addV` asks.
 */
function foldsIntoAddV(step: IRStep, child: ChildSeam): boolean {
  let parsed: ParsedProperty;
  try { parsed = parseProperty(step, child.sideEffects, child.params); } catch { return false; }
  if (parsed.kind !== 'prop') return false;
  const { spec } = parsed;
  // The test is on the key AS WRITTEN: `key instanceof Traversal` holds for `__.constant('k')` too, which
  // the parse has already folded to the string it names — and a traversal key folds whatever cardinality
  // came with it, a string key only without one.
  const writtenKey = step.args[readCardinality(step.args.map((a) => a.value)).off]?.value;
  return spec.meta === null && (isNested(writtenKey) || (typeof spec.key === 'string' && spec.cardinality === null));
}

/**
 * ONE PARSED SPEC → what this route can WRITE, or `null` for a value the compile-time form does not
 * carry the answer for (the list is in `propertyWrites`' own contract above).
 *
 * The spec is the shared parse whichever host asked (§6·6): `parseProperty` for a `property()` STEP,
 * a merge map's entries for a `mergeV` arm. Putting the EXPRESSIBILITY question in one place is what
 * stops the two hosts admitting different values: a value one host wrote through a scalar bind while
 * the other wrapped it in `jsonb(…)` would be two encodings of one property, and only one of them
 * reads back.
 */
function writeOf(spec: PropSpec, elem: Elem, child: ChildSeam, step = false): PropertyWrite | null {
  // A RUNTIME KEY (`property(__.values('name'), v)`) is a `property()` STEP's form only — a merge map's
  // keys are its own literal keys. It is resolved per traverser like a value, with
  // `ElementHelper.validateProperty`'s checks as guards on what it resolves to (`runtimeKeyRows`).
  const keyBody = typeof spec.key === 'string' ? null
    : step && isNested(spec.key) ? child.body(spec.key.nested, 'child') : undefined;
  if (keyBody === undefined || (keyBody !== null && !keyBody.length)) return null;
  if (keyBody) return runtimeKeyedWrite(spec, keyBody, elem, child);
  const key = spec.key as string;
  // A `ConstantTraversal` VALUE is a literal in traversal clothing and the reference says so where it
  // decides the question — `AddPropertyStep.java:106-110` excludes it from the traversal-value path
  // outright ("used internally by TinkerPop to wrap literal values"), so it never reaches
  // `handleTraversalValue` and none of that step's per-traverser rules (0 results → no mutation,
  // >1 under `single` → raise) apply to it.
  //
  // **The FOLD CARRIES THE DECLARED TYPE, which is the whole reason this could not land beside the
  // label fold.** A label is always a string; a value is not, and `vtype` alone names only the OUTER
  // stored shape. `constFromNested` now returns the constant's own `TypeNode` too, so a collection
  // constant tags each element losslessly (`valueNodeOf`) instead of being re-inferred from the JS
  // value — which cannot tell a uuid from a string or a datetime from a long (§6·7).
  const folded = isNested(spec.value) ? constFromNested(spec.value, child.sideEffects, child.params) : null;
  // A NESTED value that does NOT fold to a constant is a per-traverser value: resolved correlated to
  // the traverser in `prepareRuntimeWrite`, not a decline. On an EDGE it takes the FIRST result
  // (`handleTraversalValue`'s `effectiveCard` is null for a non-vertex, `AddPropertyStep.java:172-199`)
  // — a `property()` STEP's form only: a merge map's arm value is the DRIVER's, a different traverser,
  // which the merge's own arm writers resolve for a vertex and nothing resolves for an edge yet.
  if (folded && !folded.has) {
    if (!isNested(spec.value) || (elem === 'edge' && (!step || spec.cardinality !== null || spec.meta !== null))) return null;
    const body = child.body(spec.value.nested, 'child');
    if (!body?.length) return null;
    try { validatePropertyKey(key); } catch { return null; }
    return { kind: 'runtime', key, keyName: spec.keyName, value: { body }, cardinality: spec.cardinality, meta: spec.meta };
  }
  const value = folded ? folded.value : spec.value;
  const vtype = folded ? folded.vtype : spec.vtype;
  const typeNode = folded ? folded.typeNode : spec.typeNode;
  // The key waist, shared: an invalid key is an ERROR the validator raises, never a silently skipped write.
  try { validatePropertyKey(key); } catch { return null; }
  // TinkerPop's null-VALUE rule, and the reason the return type is a union: a null value REMOVES every
  // property under the key. `undefined` is a different thing — an absent argument, which this route has
  // nothing to write for — so the test is `=== null` exactly as `isPropertyRemoval` spells it, never a
  // loose `== null` that would silently turn a missing value into a delete.
  //
  // ASKED BEFORE META AND BEFORE THE CARDINALITY, which is `ElementHelper`'s own order: a removal
  // consults neither, so `property(k, null, 'acl', null)` is an ordinary removal and the meta pair is
  // simply not part of the answer. Asking about meta first made that traversal decline for a reason
  // that does not apply to it.
  if (value === null) return { kind: 'remove', key, keyName: spec.keyName };
  if (value === undefined) return null;
  if (elem === 'edge' && (spec.cardinality !== null || spec.meta)) return null;
  // A META-PROPERTY is a JSONB object on the property row, so it is `storedExpr`'s question again with
  // a different column — and under `set` (declared, or the UNDECLARED write whose element resolves
  // `set`) an equal value already present is not re-inserted but has its meta PATCHED, which is
  // `patchSetMeta`'s UPDATE.
  const meta = spec.meta;
  const { stored, collection } = propertyValueBind(value, vtype, typeNode);
  if (!collection && !constLit(arg(stored, vtype, spec.valueName))) return null;
  return {
    kind: 'set', key, keyName: spec.keyName, stored, valueName: spec.valueName, typeNode, collection, meta, vtype, cardinality: spec.cardinality,
    fts: propertyFtsEntries(value, typeNode),
  };
}

/**
 * A `property()` whose KEY is a traversal → a runtime write, whatever its value is: a traversal value
 * resolves as one, and a constant rides as the expression the constant path would store (`storedExpr`)
 * so the two cannot encode one value two ways. The constant path's rules carry over unchanged — a null
 * value (a removal under a key nobody knows yet) and a value it cannot express decline.
 */
function runtimeKeyedWrite(spec: PropSpec, keyBody: readonly IRStep[], elem: Elem, child: ChildSeam): PropertyWrite | null {
  if (elem === 'edge' && (spec.cardinality !== null || spec.meta !== null)) return null;
  const base = { kind: 'runtime' as const, key: { body: keyBody }, keyName: null, cardinality: spec.cardinality, meta: spec.meta };
  const folded = isNested(spec.value) ? constFromNested(spec.value, child.sideEffects, child.params) : null;
  if (folded && !folded.has) {
    const body = isNested(spec.value) ? child.body(spec.value.nested, 'child') : null;
    return body?.length ? { ...base, value: { body } } : null;
  }
  const value = folded ? folded.value : spec.value;
  const vtype = folded ? folded.vtype : spec.vtype;
  const typeNode = folded ? folded.typeNode : spec.typeNode;
  if (value === null || value === undefined) return null;
  const { stored, collection } = propertyValueBind(value, vtype, typeNode);
  if (!collection && !constLit(arg(stored, vtype, spec.valueName))) return null;
  const expr = storedExpr({
    kind: 'set', key: '', keyName: null, stored, valueName: spec.valueName, typeNode, collection, meta: null, vtype, cardinality: spec.cardinality, fts: [],
  });
  return { ...base, value: { expr, vtype } };
}

// ---------- addV() ----------

const LABELS_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('name', 'text')];
const NODES_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('uid', 'text', true)];
const VERTEX_LABEL_COLS: readonly ColMeta[] = [meta('node', 'int'), meta('label', 'int')];

/**
 * THE LABEL NAME → ID INDIRECTION, as one statement — `GraphStore.labelId`'s idiom in the algebra.
 *
 * The `labels` table is a SET, so `ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING
 * id` is what returns the id whether the row was new or already there; `DO NOTHING` returns no row
 * on the existing case, which is why it is not that. It interns the WHOLE list in one statement, so
 * the bind count is a function of the query TEXT and not of anything the data decides.
 *
 * `null` for an EMPTY list, and that is a real state rather than a guard: under
 * `LabelCardinality.ZERO_OR_MORE` a bare `addV()` creates a vertex carrying none, and there is
 * nothing to intern — `Values` refuses the empty relation anyway (§3.3).
 *
 * Written once because all three creations need it (`addV`, `addE`, `mergeE`'s create arm) and a
 * third hand-rolled copy of an upsert whose `DO UPDATE` looks redundant is a third chance to write
 * the `DO NOTHING` that silently returns nothing.
 */
function internLabels(labels: readonly Expr[], bind: Binder, fresh: Minter): Rel | null {
  if (!labels.length) return null;
  const target = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  return bind(insert({
    target, cols: ['name'],
    // EXPRESSIONS rather than literal strings, so a RUNTIME label interns by the same statement a
    // constant one does. A scalar subquery is a legal `VALUES` row here because it is row-independent
    // — the label body is rooted, so it yields the same name for every row the creation makes.
    source: make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: labels.map((label) => [label]) }),
    channels: [], type: typeOf(meta('id', 'int')),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] },
    returning: [['id', col(target.id, 'id')]],
  }));
}

/**
 * `addV(label)` — ONE new vertex per incoming traverser, as statements.
 *
 * It is `property()`'s mirror and it reuses `property()` whole: the trailing `property()` run writes
 * against the ids the node insert RETURNED, which is the same function that writes against the ids a
 * read prefix selected. A vertex creation is therefore a LABEL resolution, a row, and then the
 * property vocabulary — not a fourth write shape.
 *
 * Three things are load-bearing:
 *
 * - **The label name→id indirection is an UPSERT**, exactly as `GraphStore.labelId` does it: the
 *   `labels` table is a set, so `ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id`
 *   is the idiom that returns the id whether the row was new or already there. `DO NOTHING` would
 *   return no row on the existing case, which is why it is not that. It interns the WHOLE list in one
 *   statement, so the bind count is a function of the query text and not of anything the data decides.
 * - **The new ids ARE the emission order.** SQLite assigns rowids in the insert's output order, so a
 *   fresh vertex's `encounter` is its own id — exact, free, and not a window over rows whose order
 *   is only conventionally the array's.
 * - **The INPUT relation decides HOW MANY.** At the source that is one row (`Values`); mid-chain it
 *   is the traverser stream, so `g.V().addV('x')` creates one per vertex, which is the semantics
 *   rather than a special case.
 */
export function addVertex(
  input: Rel, labels: readonly Expr[], uid: string | number | null, writes: readonly PropertyWrite[],
  ordered: boolean, bind: Binder, fresh: Minter, child: ChildSeam, aliases: AliasMap, guard: Guarder,
  folded: readonly FoldedWrite[] = [],
): Rel | null {
  // ZERO labels is a real state and it is the whole reason this takes a LIST: under
  // `LabelCardinality.ZERO_OR_MORE` a bare `addV()` creates a vertex carrying none, and a merge map
  // with no `T.label` does the same. Nothing to intern and nothing to pair, so both statements are
  // absent rather than emitted over an empty `Values` — which is a relation `Values` refuses to
  // express anyway.
  const labelRow = internLabels(labels, bind, fresh);

  const nodesTarget = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [], type: typeOf(...NODES_COLS) });
  // ORDERED BY THE INPUT'S OWN POSITION, explicitly. Rowids are assigned in the source's output
  // order, so this is what makes the k-th created id the k-th input row — leaving it to `json_each`'s
  // array order would be the same answer resting on a scan's convention instead of on a clause.
  const inOrder = input.type.cols.some((column) => column.name === ORD)
    // Channel-PRESERVING, so it declares the input's — a `Sort` that named a shorter list is the
    // dropped-channel defect the obligation table exists to catch, and it caught this one.
    ? make.sort({ id: fresh('so'), input, channels: input.channels, type: input.type, terms: [{ expr: col(input.id, ORD), dir: 'asc' }] })
    : input;
  // A CALLER-SUPPLIED PUBLIC ID lands in one of two columns and the choice is the value's own type,
  // exactly as `insertRow` spells it: a NUMBER is the rowid, a STRING is the `uid`. Absent, the row
  // carries a NULL `uid` and takes whatever rowid SQLite assigns. Whether the id is still FREE is not
  // a question this layer can answer — the caller pushes an `elementIdGuard` before this statement.
  const column = uid === null ? 'uid' : typeof uid === 'number' ? 'id' : 'uid';
  const supplied: Expr = uid === null ? compilerNull('text') : typeof uid === 'number' ? compilerInt(uid) : text(uid);
  const rowPerInput = make.project({
    id: fresh('p'), input: inOrder, channels: [],
    type: typeOf(column === 'id' ? meta('id', 'int') : meta('uid', 'text', true)),
    exprs: [[column, supplied]],
  });
  const created = bind(insert({
    target: nodesTarget, cols: [column], source: rowPerInput, channels: [], type: ID_TYPE,
    returning: [['id', col(nodesTarget.id, 'id')]],
  }));

  if (labelRow) {
    const labelTargetRows = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
    // A CROSS JOIN, so N labels are N pairs per created node — the same statement whether the list
    // holds one name or four, which is what makes a multi-label creation no new shape.
    const pairs = make.join({
      id: fresh('j'), left: created, right: labelRow, join: 'cross', channels: [],
      type: typeOf(meta('node', 'int'), meta('label', 'int')),
    });
    bind(insert({
      target: labelTargetRows, cols: ['node', 'label'], source: pairs, channels: [], type: typeOf(), returning: [],
    }));
  }

  // THE CREATION'S OWN PARAMETERS FIRST — the `property()` steps folded into it, which the reference
  // passes to `addVertex` and so applies before any step after it runs (`foldsIntoAddV`). A constant is
  // an ordinary write over the new rows; a runtime one was resolved against the INCOMING traverser
  // (`prepareRuntimeWrite`) and only needs to know which new row each traverser made — the position
  // `positioned` recovers, which is the same correlation the alias carry below joins on.
  for (const write of folded) {
    if (typeof write === 'function') write(targetsOf(positioned(created, fresh), ORD, fresh), bind);
    else if (!propertyStatements('vertex', created, write, bind, fresh, child, aliases, guard)) return null;
  }
  // A runtime value in a LATER `property()` step reads the vertex it writes — correlated to `created` by
  // `child.rows` (a standalone joinable relation, not an enclosing-scope subquery), so it reads
  // properties the creation just wrote. A body that does not lower to a scalar declines.
  for (const write of writes) if (!propertyStatements('vertex', created, write, bind, fresh, child, aliases, guard)) return null;

  // WHAT THE NEW TRAVERSER CARRIES FORWARD. `addV` MINTS a traverser, so `bulk` is 1 and its
  // `encounter` is its own id — the created rows ARE in emission order. Every OTHER carried channel
  // belongs to the traverser that drove the creation, and an alias is the one that has to survive:
  // `g.addV().as('a').addV().as('b').addE('e').from('a')` is the corpus's dominant write chain, and
  // 'a' is bound BEFORE the second creation.
  //
  // Carrying it needs the correlation, because an `Insert`'s `RETURNING` says nothing about which
  // input row produced a given output row. The two positions (`inputRows` materialized the input's,
  // `positioned` recovers the created rows' from their own ids) are what make the join exact. With no
  // alias to carry there is nothing to correlate WITH, so the created rows stand alone — that is not
  // a second implementation, it is the join having no second side.
  const carried = input.channels.filter((channel) => channel.role === 'alias');
  const channels: Channels = [...carried, ...(ordered ? [BULK_CHANNEL, ENCOUNTER_CHANNEL] : [BULK_CHANNEL])];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  const ranked = positioned(created, fresh);
  const zipped = carried.length
    ? make.join({
      id: fresh('j'), left: ranked, right: input, join: 'inner', channels: [],
      type: typeOf(...ranked.type.cols, ...input.type.cols.map((column) => meta(`in_${column.name}`, column.type, column.nullable))),
      on: eq(col(ranked.id, ORD), col(input.id, ORD)),
    })
    : created;
  return make.project({
    id: fresh('c'), input: zipped, channels, type: typeOf(...cols),
    // IN THE DECLARED ORDER — `cols` is the id followed by the channels in `ROLE_ORDER`, and a
    // `Project` must emit exactly that sequence.
    exprs: [
      ['id', col(zipped.id, 'id')],
      ...carried.map((channel) => [channel.col, col(zipped.id, `in_${channel.col}`)] as const),
      ['bulk', compilerInt(1)],
      ...(ordered ? [['encounter', col(zipped.id, 'id')] as const] : []),
    ],
  });
}

/** The two channels a MINTED traverser declares for itself. Written once because `addV` and `addE`
 *  both mint, and a role list spelled at each site is a role list that can disagree. */
const BULK_CHANNEL = { col: 'bulk', role: 'bulk' } as const;
const ENCOUNTER_CHANNEL = { col: 'encounter', role: 'encounter' } as const;

/** The bindings a write step accumulates, plus the `Binder` that pushes them — the shape every write
 *  host opens with, so a name is minted in ONE place. */
export function effectScope(fresh: Minter): { readonly bindings: Binding[]; readonly bind: Binder; readonly guard: Guarder } {
  const bindings: Binding[] = [];
  // A `Ref` DECLARES what it carries, like every other relation. Most of them carry nothing — a
  // statement's `RETURNING` is a bare row set — but a snapshot of the input relation still holds that
  // traverser's channels, and a channel a relation does not declare is one no later step can read.
  const bind: Binder = (node, snapshot, channels = []) => {
    const name = `${fresh('pw')}`;
    bindings.push({ name, node, ...(snapshot ? { snapshot: true } : {}) });
    return make.ref({ id: fresh('r'), name, channels, type: node.type });
  };
  // POSITION IS THE WHOLE CONTRACT: a guard must be pushed BEFORE the statement it protects, because
  // the executor runs bindings in list order and a check after the write has nothing left to refuse.
  const guard: Guarder = (node, spec) => { bindings.push({ name: `${fresh('gw')}`, node, guard: spec }); };
  return { bindings, bind, guard };
}

/**
 * IS THIS PUBLIC ELEMENT ID STILL FREE — the relation a guard binding counts.
 *
 * `assertAvailableElementId` asks the same question with the same two columns: a NUMERIC id is the
 * rowid, a STRING id is the `uid`.
 *
 * **The message is the REFERENCE's, and this comment used to say it was LEGACY's — which was both the
 * wrong authority and, as it turned out, the wrong string.** `Graph.java:1364,1368` says
 * *"Vertex with id already exists: %s"*; the code once said *"vertex id already exists: 7"*. The
 * wording must come from the reference, never be borrowed from elsewhere: a borrowed string has no
 * checkable provenance, and correctness here must not be contingent on it.
 *
 * It survived because the comment ASSERTED the provenance confidently enough to be quoted instead of
 * checked. A comment claiming "the reference's, verbatim" is not evidence; the vendored file is.
 *
 * `Limit 1` because the count is only ever compared against zero, and the projection is one column
 * because nothing reads it.
 */
function elementIdGuard(uid: string | number, elem: Elem, fresh: Minter): { readonly node: Rel; readonly guard: Guard } {
  const table: Table = elem === 'edge' ? 'edges' : 'nodes';
  const scan = make.scan({
    id: fresh('t'), table, alias: fresh('wt'), channels: [],
    type: typeOf(meta('id', 'int'), meta('uid', 'text', true)),
  });
  const taken = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: typeof uid === 'number' ? eq(col(scan.id, 'id'), compilerInt(uid)) : eq(col(scan.id, 'uid'), text(uid)),
  });
  const one = make.project({ id: fresh('p'), input: taken, channels: [], type: ID_TYPE, exprs: [['id', col(taken.id, 'id')]] });
  return {
    node: make.limit({ id: fresh('li'), input: one, channels: [], type: ID_TYPE, count: compilerInt(1) }),
    // `Graph.Exceptions.vertexWithIdAlreadyExists` / `edgeWithIdAlreadyExists`
    // (`structure/Graph.java:1364,1368`), verbatim. The id IS a compile-time constant here — a
    // supplied `T.id` — so the sentence carries it outright and needs no `valueColumn`.
    guard: { message: `${elem === 'edge' ? 'Edge' : 'Vertex'} with id already exists: ${uid}`, raiseWhen: 'rows' },
  };
}

/** The channels a write's input snapshot still carries — the twin of `writeInputCols`, which decides
 *  the COLUMNS. Two views of one rule, so a column kept without its channel (or the reverse) is not
 *  expressible. */
const writeInputChannels = (input: Rel): Channels =>
  input.channels.filter((channel) => channel.role === 'encounter' || channel.role === 'alias');

/** `addV(<label>)` and its trailing `property()` run → the effects and the new vertices.
 *
 *  `input` is what decides HOW MANY, and its two callers are the whole story: a `Values` row at
 *  the source (`g.addV(…)` is one vertex), the traverser relation mid-chain (`g.V().addV(…)` is one
 *  per vertex). A label that is a nested traversal or an invalid one declines — the label validator is
 *  the shared waist, and a name it refuses is an ERROR, not a write this route may
 *  silently skip. */
export function elementAddV(
  input: Rel, step: IRStep, propertySteps: readonly IRStep[], ordered: boolean, child: ChildSeam, fresh: Minter,
  elem: Elem | null = null, aliases: AliasMap = NO_ALIASES,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  const tokens = creationTokens(propertySteps, child);
  if (!tokens) return null;
  // `property(T.label, …)` REPLACES the step's own labels rather than adding to them — `insertVertex`
  // reads the same way, and it is not an addition: `addV('a').property(T.label,'b')` is a vertex
  // labelled `b`. The count rule then applies to whichever list won.
  const labels = creationLabels(tokens.label === null ? step.args.map((a) => a.value) : [tokens.label], child, fresh);
  if (!labels) return null;
  // The run splits where the reference's FOLD splits it (`foldsIntoAddV`): the creation's own
  // parameters, then the `property()` steps that stayed steps — in that order, whatever order they were
  // written in, because the folded ones are applied by `addVertex` itself.
  const foldedSteps = tokens.rest.filter((s) => foldsIntoAddV(s, child));
  const laterSteps = tokens.rest.filter((s) => !foldsIntoAddV(s, child));
  // A folded parameter carries NO cardinality: `GraphTraversal.property` folds a TRAVERSAL key whatever
  // cardinality was given and hands the creation only `addProperty(key, value)`
  // (`dsl/graph/GraphTraversal.java:4034-4037`), so the write takes the graph's default for the key — and
  // declares nothing on the new element, which a declared cardinality here would (and every later write to
  // that key would then read it). A string key folds only without one, so this is only ever a traversal
  // key — a runtime one, or a `__.constant('k')` the parse already folded to its string.
  const foldedParsed = foldedSteps.length ? propertyWrites(foldedSteps, 'vertex', child) : [];
  const foldedWrites = foldedParsed && foldedParsed.map((write) => ((write.kind === 'runtime' || write.kind === 'set') && write.cardinality !== null ? { ...write, cardinality: null } : write));
  const writes = laterSteps.length ? propertyWrites(laterSteps, 'vertex', child) : [];
  if (!foldedWrites || !writes) return null;
  // ONE ROW ONLY for a supplied id, and the refusal is arithmetic rather than caution: N input rows
  // would insert N vertices carrying the SAME public id, so the second collides on a UNIQUE the guard
  // is not the authority for. Upstream reaches the same place by a different route — it loops, and its
  // second iteration raises `id already exists` — so a decline here and the reference's raise agree
  // that the traversal is wrong; they differ only in how it is reported.
  if (tokens.id !== null && !(input.kind === 'values' && input.rows.length === 1)) return null;
  // A MID-CHAIN input is SNAPSHOTTED, and this one is not about a later statement: `INSERT INTO
  // nodes … SELECT … FROM nodes` reads the table it is writing, which SQLite does not promise to
  // evaluate before the first insert. The snapshot makes the source `json_each(?)`, so the question
  // "which traversers were there" is answered once and cannot be changed by the answer.
  // A ONE-ROW `Values` source has nothing to snapshot (`writeSnapshot`); a multi-row one is snapshotted.
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  // BEFORE the creation, because a check after the insert has nothing left to refuse.
  if (tokens.id !== null) { const check = elementIdGuard(tokens.id, 'vertex', fresh); guard(check.node, check.guard); }
  // A RUNTIME label's validity, also before the creation — the reference validates the resolved value
  // and so must we, and a check after the insert has nothing left to refuse.
  for (const runtime of labels.runtime) labelGuards(runtime, guard, fresh);
  const incoming = seeded ? bind(seeded.result, true, writeInputChannels(input)) : input;
  const folded = foldedParameters(foldedWrites, 'vertex', incoming, elem, aliases, child, bind, guard, fresh);
  if (!folded) return null;
  const result = addVertex(incoming, labels.names, tokens.id, writes, ordered, bind, fresh, child, NO_ALIASES, guard, folded);
  if (!result) return null;
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

/** A creation's folded parameter as `addVertex`/`addE` apply it: a constant write, or a runtime one
 *  already RESOLVED against the incoming traverser and waiting only for the new rows' targets. */
type FoldedWrite = PropertyWrite | ((targets: Rel, bind: Binder) => void);

/**
 * A creation's FOLDED `property()` parameters, resolved against its INCOMING traverser — `null` to decline.
 *
 * A constant passes through. A runtime key or value is `Parameters.getKeyValues(traverser)`'s
 * `TraversalUtil.apply` over the traverser the creation consumes (`step/util/Parameters.java:171-183`),
 * so its site is the incoming SNAPSHOT — keyed by the snapshot's position, which is how the new rows
 * correlate back to it — and every refusal it owes is pushed NOW, before the creation, because the
 * reference raises while resolving the parameters and so creates nothing.
 *
 * Where that traverser is NOT an element this route can root a body at — the SOURCE form (`g.addV()`
 * resolves its parameters against a placeholder `false` traverser, `AddVertexStartStep.java:144-149`), a
 * scalar or a cannot-say stream — only a body that RE-SOURCES first (`__.V(1).values('name')`) is
 * answerable, because it reads nothing of the traverser it is handed; the host is then the incoming rows
 * with no element to offer. Anything else declines.
 */
function foldedParameters(
  writes: readonly PropertyWrite[], elem: Elem, incoming: Rel, incomingElem: Elem | null, aliases: AliasMap,
  child: ChildSeam, bind: Binder, guard: Guarder, fresh: Minter,
): readonly FoldedWrite[] | null {
  const rooted = incomingElem !== null && incoming.kind !== 'values'
    && incoming.type.cols.some((column) => column.name === 'id') && incoming.type.cols.some((column) => column.name === ORD);
  const out: FoldedWrite[] = [];
  for (const write of writes) {
    if (write.kind !== 'runtime') { out.push(write); continue; }
    let site: RuntimeSite;
    if (rooted && incomingElem !== null) site = { host: incoming, hostElem: incomingElem, origin: ORD, aliases, resolve: 'first' };
    else {
      const bodies = [...('body' in write.value ? [write.value.body] : []), ...(typeof write.key === 'string' ? [] : [write.key.body])];
      if (!bodies.every((body) => body[0]?.name === 'V' || body[0]?.name === 'E')) return null;
      // The source's one row is position 1 — the position `positioned` gives the one vertex it creates.
      const host = make.project({
        id: fresh('h'), input: incoming, channels: [], type: typeOf(meta('id', 'int', true), meta(ORD, 'int')),
        exprs: [['id', compilerNull('int')], [ORD, incoming.type.cols.some((column) => column.name === ORD) ? col(incoming.id, ORD) : compilerInt(1)]],
      });
      site = { host, hostElem: 'vertex', origin: ORD, aliases: NO_ALIASES, resolve: 'first' };
    }
    const apply = prepareRuntimeWrite(elem, site, write, fresh, child, guard, bind);
    if (!apply) return null;
    out.push(apply);
  }
  return out;
}

/**
 * A creation's `property()` run split into its `T` TOKENS and the ordinary writes — or `null` to
 * decline.
 *
 * `T.id` and `T.label` on a vertex being CREATED are not property writes at all and not the
 * immutability refusal they are on an existing element: they SUPPLY the new vertex's public id and
 * its label. `parseProperty` already separates them (`kind: 'token'`), so this is a partition of the
 * run rather than a second parse — which is what keeps the `T`-token rules in one place while the
 * two hosts emit differently.
 *
 * A meta run on a token declines: `property(T.id, 1, 'k', 'v')` is meaningless and the reference
 * raises for it, so this route declines it as unsupported.
 */
function creationTokens(
  steps: readonly IRStep[], child: ChildSeam,
): { readonly id: string | number | null; readonly label: string | null; readonly rest: readonly IRStep[] } | null {
  let id: string | number | null = null;
  let label: string | null = null;
  const rest: IRStep[] = [];
  for (const step of steps) {
    if (step.modulators?.length || step.optionArms) return null;
    let parsed: ParsedProperty;
    try { parsed = parseProperty(step, child.sideEffects, child.params); }
    catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
    if (parsed.kind !== 'token') { rest.push(step); continue; }
    if (parsed.meta) return null;
    if (parsed.token === 'id') {
      if (typeof parsed.value !== 'string' && typeof parsed.value !== 'number') return null;
      id = parsed.value;
    } else if (parsed.token === 'label') {
      if (typeof parsed.value !== 'string') return null;
      label = parsed.value;
    } else return null;
  }
  return { id, label, rest };
}

/**
 * A LABEL argument that is really a LITERAL, unwrapped — or `undefined` for a nested body this route
 * cannot fold.
 *
 * **`ConstantTraversal` is TinkerPop's own wrapper for a literal and every write host unwraps it
 * explicitly**, so folding one is the reference's behaviour rather than an approximation of it:
 * `AddVertexStep.java:253-259` ("Handles ConstantTraversal, which can be resolved to a" literal),
 * `AddEdgeStep.java:180-181`, and `AddPropertyStep.java:106-110`, whose comment states the rule
 * outright — *"Exclude ConstantTraversal which is used internally by TinkerPop to wrap literal
 * values."* A constant is therefore NOT a traversal value at all; it never reaches the reference's
 * per-traverser path.
 *
 * ONE authority for the question because three hosts ask it (`addV`'s labels, a merge map's
 * `T.label`, `addE`'s label), and a per-host copy is a per-host chance to fold differently. It is
 * deliberately the LABEL fold only: a label is always a string, so nothing here touches the typed
 * value channel (§6·7) the way a folded property VALUE would — that one owes an answer about which
 * vtype survives the fold, and owes it in its own change.
 *
 * `undefined` rather than `null` is the miss, because `null` is a legal folded value elsewhere and a
 * label list must not silently gain one.
 */
function constLabelArg(value: unknown, child: ChildSeam): unknown {
  if (!isNested(value)) return value;
  const folded = constFromNested(value, child.sideEffects, child.params);
  return folded.has ? folded.value : undefined;
}

/**
 * THE LABELS A CREATION GIVES ITS NEW VERTEX — `addV`'s arguments and a merge map's `T.label` reduced
 * to the same list, or `null` for a form this route declines.
 *
 * **A creation with NO label of its own is answerable, and it needed only the graph's declared
 * cardinality.** `insertVertex` spells the same rule: an unstated list takes the graph default where
 * the cardinality demands at least one label, and stays empty where it permits zero. That is a
 * compile-time question the moment the cardinality is threaded (see `Lowering.labelCardinality`) —
 * what made it look like a runtime one was that this seam had not been handed the value.
 *
 * The COUNT rule is the other half, and it is a DECLINE rather than a throw: `assertLabelCount` raises
 * a message the conformance suite matches on, and that refusal is the reference's own answer, so it is
 * declined here rather than mis-executed (write-path trap 3).
 *
 * Deduped as a SET before counting, exactly as `insertVertex` does — `addV('a','a')` is one label, so
 * it must not fail a `max: 1` graph.
 */
function creationLabels(
  args: readonly unknown[], child: ChildSeam, fresh: Minter,
): CreationLabels | null {
  // A nested arg that does NOT fold keeps its original `{nested}` value rather than becoming a miss:
  // the fold is an optimization for a literal in traversal clothing, and what it leaves behind is a
  // RUNTIME label for the branch below — not a decline. (Returning `undefined` here and testing for it
  // first is what silently killed that branch: every runtime label died before reaching it.)
  const folded = args.map((arg) => constLabelArg(arg, child) ?? arg);
  const named = folded.length === 1 && Array.isArray(folded[0]) ? folded[0] as unknown[] : folded;

  // A RUNTIME label — a nested body that did not fold to a literal — is resolved by the child seam and
  // validated by a guard, not declined. See `runtimeLabel` for why the reference makes that possible.
  // Only the SOLE-ARGUMENT form is taken here: `addV(a, __.trav)` is upstream's `Collection` path, whose
  // error vocabulary is a different four messages (`resolveLabelCollection`), so answering it with this
  // one's would be the wrong answer rather than a missing one.
  if (named.length === 1 && isNested(named[0])) {
    const resolved = runtimeLabel(named[0], child, fresh);
    return resolved && { names: [resolved.expr], runtime: [resolved] };
  }
  if (named.some((arg) => typeof arg !== 'string')) return null;
  const labels = [...new Set(named as string[])];
  try { for (const label of labels) validateLabel(label); } catch { return null; }
  // NO DEFAULT LABEL IS SUPPLIED. A bare `g.addV()` stores nothing, which `Labels.feature`
  // `g_addV_labels` asserts outright (`count of 0`); `DEFAULT_VERTEX_LABEL` is only what a
  // label-less vertex REPORTS for `label()`.
  return { names: labels.map(text), runtime: [] };
}

/** A creation's labels as EXPRESSIONS, plus the subset whose value only exists at run time and
 *  therefore needs `labelGuards`. A constant creation carries an empty `runtime` and costs nothing. */
interface CreationLabels {
  readonly names: readonly Expr[];
  readonly runtime: readonly RuntimeLabel[];
}

/**
 * ONE label argument → its expression, plus the guards it owes — the single-label form of
 * `creationLabels`, for the host that takes exactly one.
 *
 * `addE` is that host: an edge label is singular by spec, so it has no `Collection` arm and none of
 * `resolveLabelCollection`'s four messages apply to it. Sharing this with `addV` rather than letting
 * the edge host grow its own resolution is the point — a second copy is a second chance to fold a
 * constant differently, or to forget a guard.
 */
function labelSource(value: unknown, child: ChildSeam, fresh: Minter): CreationLabels | null {
  const folded = constLabelArg(value, child) ?? value;
  if (isNested(folded)) {
    const resolved = runtimeLabel(folded, child, fresh);
    return resolved && { names: [resolved.expr], runtime: [resolved] };
  }
  if (typeof folded !== 'string') return null;
  try { validateLabel(folded); } catch { return null; }
  return { names: [text(folded)], runtime: [] };
}

/**
 * A nested label body → the ONE value it produces, as an expression.
 *
 * `TraversalUtil.apply` is `traversal.next()` — the FIRST result — so this is the child seam's rooted
 * arm plus a `Limit 1`, exactly as `endpointOf`'s `read` arm already spells it for `to(__.V(2))`. The
 * body is ROOTED rather than correlated because a label body reads the graph, not the traverser being
 * created: `addV(__.V().has('name','marko').label())` names one label for every row it creates.
 *
 * A body with EFFECTS is refused: resolving a label must not also mutate the graph, and the rooted arm
 * is deliberately policy-free about that (§6·6), so the admission rule is the consumer's — here.
 */
function runtimeLabel(value: { readonly nested: unknown }, child: ChildSeam, fresh: Minter): RuntimeLabel | null {
  const body = child.body(value.nested, 'rooted');
  if (!body?.length) return null;
  const read = child.rooted(body);
  if (!read || read.effects?.length) return null;
  if (read.framing.kind !== 'scalar') return null;
  const one = make.limit({ id: fresh('li'), input: read.rel, channels: read.rel.channels, type: read.rel.type, count: compilerInt(1) });
  const only = make.project({
    id: fresh('p'), input: one, channels: [], type: typeOf(meta('v', 'text')), exprs: [['v', col(one.id, 'v')]],
  });
  // The RELATION rides beside the expression, and it is not redundant: a scalar subquery collapses
  // "no row" and "a row holding NULL" to the same NULL, while the reference raises DIFFERENT errors
  // for them. `EXISTS` over this same relation is what tells them apart (see `labelGuards`).
  return { expr: { kind: 'scalar', plan: only }, plan: only };
}

/** A label resolved at run time: the value as an expression, and the relation it came from — the
 *  second is what makes "produced nothing" distinguishable from "produced null". */
interface RuntimeLabel {
  readonly expr: Expr;
  readonly plan: Rel;
}

/**
 * THE VALIDITY OF A LABEL NOBODY WILL SEE UNTIL EXECUTION — as guard bindings, which run once over
 * the whole set rather than row by row.
 *
 * `ElementHelper.validateLabel` is three PURE PREDICATES over the value — null, empty, hidden
 * (`Graph.Hidden.HIDDEN_PREFIX` is `~`) — with no graph access and no traverser state, so all three
 * are expressible in SQL. These run once, over the whole set, BEFORE anything is written — one
 * statement each, O(plan size) — and the message is the one our shared `validateLabel` owns.
 *
 * **The NON-STRING case is deliberately absent, and that is agreement rather than an omission.** The
 * reference casts `(String)` and would raise; our shared `validateLabel` COERCES (`String(label)`) —
 * and `labels.name` is TEXT, so SQLite's affinity coerces identically here. Raising here would be a
 * divergence invented by this function. The coercion itself is a real deviation from the reference,
 * and it is shared code's to fix, not this seam's (plan §Phase 1).
 */
/**
 * `TraversalUtil.apply`'s refusal when a body yields NO value — the reference's own sentence
 * (`process/traversal/util/TraversalUtil.java:41-53`), truncated to the stable PREFIX because its
 * `%s` tail interpolates Java object descriptions (the split traverser, the traversal, its parent)
 * that no other implementation can reproduce. TinkerPop's own conformance assertions are
 * `containing text of`, so the prefix is the matchable part and the tail is decoration.
 *
 * A CONSTANT because more than one host raises it — a nested label on `addV` today, on `addE` and a
 * nested property key next — and because a string spelled at each site is a string that drifts.
 */
const ABSENT_LABEL = 'The provided traverser does not map to a value';

function labelGuards(label: RuntimeLabel, guard: Guarder, fresh: Minter): void {
  // TEXT-cast before the string tests for the same reason `labels.name` is a TEXT column: SQLite's
  // affinity would coerce on the way in anyway, so comparing the raw value would test something the
  // stored label is not.
  const asText: Expr = { kind: 'cast', arg: label.expr, to: 'text' };
  const produced: Expr = { kind: 'exists', plan: label.plan, negated: false };
  // **EVERY MESSAGE HERE IS THE REFERENCE'S.** A message must come from the reference, never be
  // borrowed from elsewhere — a borrowed string has no checkable provenance, and correctness must not
  // depend on it. `Element.Exceptions` (`structure/Element.java:212-222`) owns the three
  // `Label can not be …` sentences, and `TraversalUtil.apply`
  // (`process/traversal/util/TraversalUtil.java:41-53`) owns the absent-value one.
  //
  // **AN ABSENT BODY AND A NULL VALUE ARE DIFFERENT ERRORS, AND THEY ARE DISTINGUISHABLE.** A scalar
  // subquery collapses them — both read as NULL — but `EXISTS` over the same relation does not, so
  // each of the reference's two sentences fires on its own precise condition and neither is a choice
  // between them: `NOT EXISTS` is `TraversalUtil.apply`'s "does not map to a value", while a row that
  // exists and holds NULL is `validateLabel`'s "can not be null". The absent sentence interpolates
  // Java object descriptions no other implementation can reproduce, so `ABSENT_LABEL` is its stable
  // prefix — the part a `containing text of` assertion matches.
  const rules: readonly (readonly [Expr, string, boolean])[] = [
    [{ kind: 'exists', plan: label.plan, negated: true }, ABSENT_LABEL, false],
    [and(produced, { kind: 'binary', op: 'is', left: label.expr, right: compilerNull('text') }), 'Label can not be null', false],
    [eq(asText, compilerText('')), 'Label can not be empty', false],
    [{ kind: 'binary', op: 'like', left: asText, right: compilerText('~%') }, 'Label can not be a hidden key: ', true],
  ];
  for (const [pred, message, names] of rules) {
    const row = make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('one', 'int')), rows: [[compilerInt(1)]] });
    const bad = make.filter({ id: fresh('f'), input: row, channels: [], type: row.type, pred });
    // The guard relation PROJECTS THE LABEL so the executor can append it — the hidden-key sentence
    // names the offending value and a runtime value has none to interpolate at compile time.
    guard(make.project({
      id: fresh('p'), input: bad, channels: [], type: typeOf(meta('v', 'text')), exprs: [['v', asText]],
    }), { message, raiseWhen: 'rows', ...(names ? { valueColumn: 'v' } : {}) });
  }
}

/**
 * A write's INPUT SNAPSHOT — its identity, emission order and aliases (`writeInputCols`), positioned —
 * or `null` for the one input that needs none: a literal `Values` of AT MOST ONE row.
 *
 * **THE EXEMPTION IS BY ROW COUNT, NOT BY NODE KIND, and that is the whole rule.** Every write host reads
 * an input WITHOUT an `ord` column as "one traverser" — `elementMergeE` stamps every pair with the
 * literal position `1`, `crossed` falls back to a CROSS join, the computed merges drop their per-driver
 * correlation — which is exactly right for `g.mergeE(…)`'s one-row source seed and exactly wrong for
 * `g.inject(1,2,3)`, a three-row `Values`: every pair shared position 1, so each of the three found rows
 * re-joined all three traversers and `mergeE` emitted NINE where `MergeEdgeStep` (one `flatMap` per
 * incoming traverser, `vendor/tinkerpop/gremlin-core/.../step/map/MergeEdgeStep.java`) emits three. A
 * multi-row `Values` is therefore snapshotted like any mid-chain input, so the "no position ⇒ one row"
 * reading every host makes is TRUE by construction rather than by each host remembering a caveat.
 * One function for every write host, because the defect was the same predicate copied six times.
 *
 * The ORDER is load-bearing: a write assigns ids as it goes and those ids are OBSERVABLE, so which row
 * it sees first is part of the answer.
 */
function writeSnapshot(input: Rel, fresh: Minter): { readonly bindings: readonly Binding[]; readonly result: Rel } | null {
  return input.kind === 'values' && input.rows.length <= 1 ? null : inputRows(input, writeInputCols(input), fresh);
}

/**
 * **A MERGE RUNS ONE TRAVERSER AT A TIME, and a set-based merge is only that loop when no traverser can
 * observe an earlier one's write.** `MergeVertexStep.flatMap` / `MergeEdgeStep.flatMap`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java:78-177`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeEdgeStep.java:255-338`)
 * search, then `IteratorUtils.peek(onMatch)` over what the search found, else create — PER incoming
 * traverser, against the graph as every EARLIER traverser left it; a `property()` tail is an
 * `AddPropertyStep` per emitted traverser (`.../step/sideEffect/AddPropertyStep.java:94`). Every merge host
 * here instead searches ONCE, before any write, for every driver (`matched` is a snapshot), applies `onMatch`
 * to that snapshot once per ELEMENT, creates once per distinct create key, and runs the tail once per
 * element. That is the loop exactly when no later iteration would have seen an earlier one's write; when
 * one would have, the answer differs, and the honest answer is a refusal rather than the snapshot's.
 *
 * So this is THE ONE AUTHORITY every merge host calls (the constant, computed and map-valued searches, both
 * element kinds — which is what covers every depth a merge can sit at: a union arm, a `V(1,2)` mid-chain
 * driver, a multi-row `inject`). It pushes guard bindings BEFORE any of the merge's writes (the executor runs
 * bindings in order), each raising in one runtime situation:
 *
 *  - **(1) two drivers land on ONE pre-existing element** while the `onMatch`/tail `repeats` (a `list`
 *    append, a per-traverser value — each driver writes its own) or `mutatesSearch` (it writes a key the
 *    search reads, so the later driver's search no longer finds the element).
 *  - **(2) a later driver would MATCH what an earlier one CREATED** — two drivers that both missed, whose
 *    searches `couldMatch` the earlier one's creation, where the later one would then have run `onMatch`
 *    on it (`acts`), repeated a write on it (`repeats`), or not have shared it with the earlier one here
 *    (`createKey` differs — two creations where the loop makes one). Two misses with the SAME create key
 *    and an inert `onMatch` are what `Distinct` already answers correctly — one creation, carried by both
 *    — so that common case still runs.
 *  - **(3) a PER-DRIVER search whose `onMatch` or tail writes a searched key** — one driver's write can make an
 *    element newly match another driver's different search, which no pairwise test over the snapshot sees.
 *  - **(0) ANY OTHER write in the program the search could observe** (`othersObserved`,
 *    `mergeObservesOtherWrites`) — refused over a second driver outright. The loop interleaves the WHOLE
 *    pipeline per traverser, not just this step: traverser 1 runs every later step (a `drop()`, an `addV`)
 *    before traverser 2 is pulled into the merge, and every EARLIER step for traverser 2 runs after
 *    traverser 1's merge. Nothing outside this merge's own cluster is visible to the guards above, so the
 *    one fact they cannot model is the one that refuses.
 *
 * Runtime rather than compile-time because the answer is the DATA's: `g.V().mergeE(m).option(onMatch, …)`
 * over an existing edge is the loop exactly, and only a miss (or a match) shared by two drivers is not. An
 * input with no `ord` is one traverser (`writeSnapshot`), where none of the three can arise.
 */
function guardMergeInterleaving(
  op: 'mergeV' | 'mergeE', incoming: Rel, matched: Rel,
  unmatched: {
    /** The per-driver rows that missed, carrying `ord` — retained once and self-joined. */
    readonly rel: Rel;
    /** What `wanted` dedupes creations by; `null` when it is the same for every driver. */
    readonly createKey: ((rel: RelId) => Expr) | null;
    /** Could the LATER driver's search find the EARLIER one's creation? `null` = always. */
    readonly couldMatch: ((earlier: RelId, later: RelId) => Expr) | null;
  } | null,
  facts: MergeWriteFacts & { readonly perDriverSearch: boolean },
  bind: Binder, guard: Guarder, fresh: Minter,
): void {
  if (!incoming.type.cols.some((column) => column.name === ORD)) return;
  const unsupported = (why: string): Guard => ({ message: `this traversal is not supported yet: ${op}() over several traversers ${why} — the reference merges one traverser at a time`, raiseWhen: 'rows' });
  const raiseOnRows = (rel: Rel, why: string): void => guard(make.limit({
    id: fresh('li'), channels: [], type: typeOf(meta('n', 'int')), count: compilerInt(1),
    input: make.project({ id: fresh('p'), input: rel, channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', compilerInt(1)]] }),
  }), unsupported(why));
  const second = (): Rel => make.limit({ id: fresh('li'), input: incoming, channels: incoming.channels, type: incoming.type, count: compilerInt(1), offset: compilerInt(1) });
  const lt = (a: Expr, b: Expr): Expr => ({ kind: 'binary', op: '<', left: a, right: b });
  const always = eq(compilerInt(1), compilerInt(1));
  // A self-join of one relation: two trees over the same retained rows, the right side's names
  // suffixed so the declared type stays positional and unambiguous.
  const selfJoin = (left: Rel, right: Rel, on: Expr): Rel => make.join({
    id: fresh('j'), left, right, join: 'inner', channels: [], on,
    type: typeOf(...left.type.cols, ...right.type.cols.map((c) => meta(`b_${c.name}`, c.type, true))),
  });

  // (0) — ANOTHER write in the program, earlier or later in the pipeline, that a later driver's search could
  // observe: the one test that needs no pairwise reading, because the loop interleaves it with every driver.
  if (facts.othersObserved) {
    raiseOnRows(second(), 'in a traversal with another write (an addV/addE/merge, a drop, a label, or a property() write to a searched key) that a later traverser\'s search would observe');
    return;
  }
  // (3) — a per-driver search the onMatch or the tail can redirect.
  if (facts.perDriverSearch && facts.mutatesSearch) {
    raiseOnRows(second(), 'with an onMatch or property() write to a key a per-traverser search reads');
    return;
  }
  // (1) — one pre-existing element reached by two drivers. An input-independent search (`matched` with no
  // `ord`) reaches every match from every driver.
  if (facts.repeats || facts.mutatesSearch) {
    const why = 'reaching one element with an onMatch or property() write the next traverser observes (a searched key, a list append, or a per-traverser value)';
    if (matched.type.cols.some((column) => column.name === ORD) && matched.kind === 'ref') {
      const other = make.ref({ id: fresh('r'), name: matched.name, channels: [], type: matched.type });
      raiseOnRows(selfJoin(matched, other, and(eq(col(matched.id, 'id'), col(other.id, 'id')), lt(col(matched.id, ORD), col(other.id, ORD)))), why);
    } else {
      const two = second();
      raiseOnRows(make.filter({ id: fresh('f'), input: two, channels: two.channels, type: two.type, pred: { kind: 'exists', plan: matched, negated: false } }), why);
    }
  }
  // (2) — a creation a later driver would have matched.
  if (!unmatched || (!facts.acts && !facts.repeats && !facts.mutatesSearch && unmatched.createKey === null)) return;
  const u = unmatched.rel;
  const earlier = bind(make.project({
    id: fresh('p'), input: u, channels: [], type: u.type, exprs: u.type.cols.map((column) => [column.name, col(u.id, column.name)] as const),
  }), true) as Extract<Rel, { kind: 'ref' }>;
  const later = make.ref({ id: fresh('r'), name: earlier.name, channels: [], type: earlier.type });
  const { createKey, couldMatch } = unmatched;
  const observable: Expr = facts.acts || facts.repeats || facts.mutatesSearch || !createKey ? always
    : isNot(createKey(earlier.id), createKey(later.id));
  raiseOnRows(selfJoin(earlier, later, and(and(lt(col(earlier.id, ORD), col(later.id, ORD)),
    couldMatch ? couldMatch(earlier.id, later.id) : always), observable)),
  'where a later traverser would match what an earlier one created');
}

/** `guardMergeInterleaving`'s `couldMatch` for a COMPUTED search (`mergeV/mergeE(__.project(…))`): could the
 *  LATER driver's search find what the EARLIER driver's map created? Per key — the later driver's key does
 *  not narrow (an unproductive body, `pp = 0`), or the creation carries it: the earlier map's value, under
 *  the search's own compare (`typedValueEq`), or an `onCreate` constant (read as "could", its value is not
 *  compared here — fail closed). */
function computedCouldMatch(
  cKeys: readonly string[], onCreate: MergeSpec | null,
  ppCol: (i: number) => string, cvCol: (i: number) => string, ptCol: (i: number) => string,
): (earlier: RelId, later: RelId) => Expr {
  const always = eq(compilerInt(1), compilerInt(1));
  const created = new Set(Object.keys(onCreate?.props ?? {}));
  return (earlier, later) => cKeys.map((key, i): Expr => created.has(key) ? always
    : or(eq(col(later, ppCol(i)), compilerInt(0)), and(eq(col(earlier, ppCol(i)), compilerInt(1)),
      typedValueEq(col(earlier, cvCol(i)), col(earlier, ptCol(i)), col(later, cvCol(i)), col(later, ptCol(i))))))
    .reduce((a, b) => and(a, b), always);
}

/** `guardMergeInterleaving`'s `couldMatch` for a MAP-VALUED driver (`inject(map).mergeV()`): could the
 *  LATER driver's map find what the EARLIER driver's map created? Every STRING entry of the later map must
 *  be carried by the creation — an equal entry of the earlier map (`typedValueEq`, the search's compare),
 *  or an `onCreate` key (read as "could", fail closed). A `T.label` entry is read as "could" too: over-
 *  refusing a pair whose labels differ is a refusal, never a wrong answer. */
function mapCouldMatch(onCreate: MergeSpec | null, fresh: Minter): (earlier: RelId, later: RelId) => Expr {
  const created = Object.keys(onCreate?.props ?? {});
  const ext = (e: Expr, path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [e, compilerText(path)] });
  const side = (p: Rel, which: 'keys' | 'values', path: string): Expr => ext(pairSide(col(p.id, PAIR.value), which), path);
  return (earlier, later) => {
    const need = pairsOf(col(later, MAP_COL), fresh);
    const have = pairsOf(col(earlier, MAP_COL), fresh);
    const carried = make.filter({
      id: fresh('f'), input: have, channels: [], type: have.type,
      pred: and(and(eq(side(have, 'keys', '$.t'), compilerText('string')), eq(side(have, 'keys', '$.v'), side(need, 'keys', '$.v'))),
        typedValueEq(side(have, 'values', '$.v'), side(have, 'values', '$.t'), side(need, 'values', '$.v'), side(need, 'values', '$.t'))),
    });
    const fromOnCreate: Expr = created.length
      ? { kind: 'in-list', expr: side(need, 'keys', '$.v'), values: created.map(compilerText) }
      : eq(compilerInt(1), compilerInt(0));
    const uncarried = make.filter({
      id: fresh('f'), input: need, channels: [], type: need.type,
      pred: and(and(eq(side(need, 'keys', '$.t'), compilerText('string')), { kind: 'unary', op: 'not', arg: fromOnCreate }),
        { kind: 'exists', plan: carried, negated: true }),
    });
    return { kind: 'exists', plan: uncarried, negated: true };
  };
}

/** What a merge's `onMatch` and `property()` tail do, as `guardMergeInterleaving` reads it. */
interface MergeWriteFacts {
  /** The `onMatch` changes the element at all (a write or an appended label). */
  readonly acts: boolean;
  /** A write that is NOT idempotent per traverser — a `list` append (stated, or a VERTEX write that names
   *  no cardinality), or a value/key/map computed per traverser — on `onMatch` or the tail: each driver
   *  reaching an element writes its own. */
  readonly repeats: boolean;
  /** The `onMatch` OR the tail writes (or drops) a property key the search reads. */
  readonly mutatesSearch: boolean;
  /** A write OUTSIDE this merge's own cluster could change what the search finds (`mergeObservesOtherWrites`). */
  readonly othersObserved: boolean;
}

/** `MergeWriteFacts` from a host's parsed writes. `searched` is the set of property keys the search reads,
 *  `null` when that set is DATA (a map-valued driver) and so any written key may be one.
 *
 *  **A vertex write with NO stated cardinality repeats.** `cardinality === null` is "the traversal named
 *  none", resolved only at the element (`PropertySet.cardinality`), and that resolution here APPENDS:
 *  `g.addV('p').property('t','x').property('t','y').values('t')` is `[x,y]`. The reference's `onMatch`
 *  writes `v.property(graph.features().vertex().getCardinality(key), key, val)` once per traverser
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java:129`)
 *  and a tail is an `AddPropertyStep` per traverser
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java:94`),
 *  so N drivers reaching one vertex append N times where the snapshot appends once. Nothing here proves a
 *  key single, so the unstated form fails closed exactly like `list` — the two spellings of one query
 *  (`[age:30]` and `[age:Cardinality.list(30)]`) now get one treatment. An edge property is single by spec
 *  (its `cardinality` is always `null`), so only `element === 'vertex'` reads `null` as an append.
 *
 *  **A tail write to a SEARCHED key is `mutatesSearch` too.** The pipeline is lazy — `LazyBarrierStrategy`
 *  puts no `NoOpBarrierStep` after a merge's `flatMap`
 *  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java`)
 *  — so traverser 1's `property()` tail runs BEFORE traverser 2 searches: `g.inject(1,2,3).mergeV([name:'zz'])
 *  .property(single,'name','yy')` leaves three vertices in the reference, where the snapshot creates one. */
function mergeWriteFacts(
  element: 'vertex' | 'edge',
  onMatch: readonly PropertyWrite[], appended: readonly string[], tail: readonly PropertyWrite[], searched: ReadonlySet<string> | null,
  propertySteps: readonly IRStep[], program: ProgramWrites,
): MergeWriteFacts {
  const perTraverser = (write: PropertyWrite): boolean => write.kind === 'runtime' || write.kind === 'map'
    || (write.kind === 'set' && (write.cardinality === 'list' || (element === 'vertex' && write.cardinality === null)));
  const writesSearched = (write: PropertyWrite): boolean => write.kind === 'map' || searched === null
    || (write.kind === 'runtime' ? typeof write.key !== 'string' || searched.has(write.key) : searched.has(write.key));
  return {
    acts: onMatch.length > 0 || appended.length > 0,
    repeats: onMatch.some(perTraverser) || tail.some(perTraverser),
    mutatesSearch: onMatch.some(writesSearched) || tail.some(writesSearched),
    othersObserved: mergeObservesOtherWrites(element, propertySteps, searched, program),
  };
}

/**
 * **DOES A WRITE OUTSIDE THIS MERGE'S OWN CLUSTER CHANGE WHAT ITS SEARCH FINDS?** The reference pipeline is
 * lazy: a merge is a `FlatMapStep` and `LazyBarrierStrategy` puts no `NoOpBarrierStep` after the FIRST
 * flat-map, nor anywhere in a traversal holding a `DropStep` (its early `return` on
 * `hasStepOfAssignableClass(DropStep.class, …)`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java`),
 * and `AddVertexStep`/`AddEdgeStep` are map steps. So traverser 1 runs EVERY later step before traverser 2
 * is pulled into the merge's `flatMap` search (`MergeVertexStep.java:78-177`, `MergeEdgeStep.java:255-338`):
 * `g.inject(1,2,3).mergeV([name:'zz']).properties('name').drop()` leaves three new vertices there (each
 * later search misses), and `….addV('p').property('name','zz')` lets traverser 2's search find two. An
 * EARLIER write interleaves the same way, from the other side. The plan writes each step for every driver
 * at once, so it answers those only when no other write can touch what the search reads — and the
 * pipeline's extent is not decided here (a branch arm, a nested body), so this reads the whole PROGRAM
 * (`ProgramWrites.sites`), the reading `sequentialGuard` already makes for a value body.
 *
 * Counted, not matched by identity: a nested body is normalized afresh, so this merge's own step need not
 * be the one the program walk saw. The program's sites the search can observe, minus this merge's own
 * (itself, plus each of its `property()` tail steps that writes a searched key — the tail the guards
 * above already read), must be none. The classification over-approximates and refuses rather than answers:
 *  - a `drop()` (an element or a property, of any kind — dropping a vertex drops its edges): always;
 *  - a creation of the merge's own element kind (`addV`/`mergeV` for a vertex search, `addE`/`mergeE`
 *    for an edge search); a vertex creation counts for an edge search too, since an endpoint resolves by
 *    vertex (`MergeEdgeStep.resolveVertex`) — fail closed;
 *  - a label mutation, for a vertex search (an edge's label is immutable);
 *  - a `property()` write whose key the search reads (`searched`; `null` = any key may be searched).
 * An `'unknown'` program (an unreadable body) always observes.
 */
function mergeObservesOtherWrites(
  element: 'vertex' | 'edge', propertySteps: readonly IRStep[], searched: ReadonlySet<string> | null, program: ProgramWrites,
): boolean {
  if (program.sites === 'unknown') return true;
  const observes = (site: WriteSite): boolean => {
    switch (site.op) {
      case 'drop': case 'addV': case 'mergeV': return true;
      case 'addE': case 'mergeE': return element === 'edge';
      case 'label': return element === 'vertex';
      case 'property': return site.keys === 'all' || searched === null || [...site.keys].some((key) => searched.has(key));
    }
  };
  const own = 1 + propertySteps.map(writeSiteOf).filter((site): site is WriteSite => site !== null && observes(site)).length;
  return program.sites.filter(observes).length !== own;
}

/**
 * WHICH OF AN INPUT RELATION'S COLUMNS A WRITE HAS TO KEEP: its identity, its emission order, and
 * every ALIAS it carries.
 *
 * Shared by `addV` and `addE` because they need the same set for different reasons — `addE` READS an
 * alias (a `from("a")` endpoint) and `addV` CARRIES it (a label bound before the creation must still
 * be bound after it). Deriving it in one place is what stops the two drifting into keeping different
 * columns and then disagreeing about what survives a write.
 *
 * Every other role is deliberately absent, and absent means the chain DECLINES rather than losing it
 * silently: a `sack` or a `path` is state this route does not carry through a creation, and the
 * relation it hands back simply does not declare the channel, so a later reader of it fails closed.
 */
function writeInputCols(input: Rel): readonly ColMeta[] {
  return [traverserCol(input), ...input.channels
    .filter((channel) => channel.role === 'encounter' || channel.role === 'alias')
    .map((channel) => meta(channel.col, channel.role === 'alias' ? 'json' : 'int', channel.role === 'alias'))];
}

/**
 * THE COLUMN AN INPUT RELATION CARRIES ITS TRAVERSER IN — `id` for an ELEMENT relation, `v` for a
 * SCALAR one.
 *
 * A write asks this question for two different reasons and only one of them cares about the answer.
 * Where the traverser IS the subject — a property's owner, an implicit `addE` endpoint, an
 * `addLabel` target — the write reads `id` and a scalar stream is refused ANYWAY, by the same
 * `elem !== 'vertex'` tests that already guard those. Where the input is only a MULTIPLIER — a
 * creation, a merge, whose row count is all they take from it — nothing reads the column at all and
 * the snapshot merely has to carry SOMETHING, because a projection with no columns is not a SELECT.
 *
 * So this is not a widening of what a write may do to a traverser; it is the snapshot ceasing to
 * assume the traverser is an element. `g.inject(0).mergeV([:])` is `g.V().mergeV([:])` with a
 * different multiplier, and the reason it declined was that `inputRows` projected a column its input
 * does not have.
 */
const traverserCol = (input: Rel): ColMeta =>
  input.type.cols.some((column) => column.name === 'id') ? meta('id', 'int')
  : input.type.cols.some((column) => column.name === MAP_COL) ? meta(MAP_COL, 'json')
  : meta('v', 'any', true);

// ---------- addE() ----------

const EDGE_ROW_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** Where an edge endpoint comes from — the three forms `from()`/`to()` take that are decidable
 *  against the INPUT relation, plus the implicit one. */
type Endpoint =
  /** No `from()`/`to()` on that side: the incoming traverser IS that end, which is what makes
   *  `g.V(1).addE('e').to(x)` an out-edge of the current vertex. */
  | { readonly kind: 'traverser' }
  /** An `as()` LABEL, spelled bare (`from("a")`) or as `__.select("a")` — the same thing, and the
   *  label's history holds the element, so the endpoint is its last entry's rowid. */
  | { readonly kind: 'alias'; readonly label: string }
  /** A ROOTED sub-read (`to(__.V(2))`, `from(V().has(…))`) — a relation, read through a scalar
   *  subquery. `next()` takes the FIRST row, so this takes one row of the same relation. */
  | { readonly kind: 'read'; readonly rel: Rel }
  /** A PUBLIC ID naming an existing vertex — `mergeE`'s only extra form, because a merge map states
   *  its endpoints by id where `from()`/`to()` state them by label or traversal. Whether the vertex
   *  is THERE is the graph's answer, so it arrives with a guard (§6·5). */
  | { readonly kind: 'vertex'; readonly uid: string | number };

/** The endpoint as an expression over the relation the edge insert selects FROM. `guard` is required
 *  only by the `vertex` arm, whose refusal the graph decides; a host with no such arm passes none. */
function endpointExpr(end: Endpoint, over: Rel, aliases: AliasMap, fresh: Minter, guard?: Guarder): Expr | null {
  if (end.kind === 'traverser') return col(over.id, 'id');
  if (end.kind === 'vertex') return guard ? endpointRowid(end.uid, guard, fresh) : null;
  if (end.kind === 'read') {
    const one = make.limit({ id: fresh('li'), input: end.rel, channels: end.rel.channels, type: end.rel.type, count: compilerInt(1) });
    const only = make.project({ id: fresh('p'), input: one, channels: [], type: ID_TYPE, exprs: [['id', col(one.id, 'id')]] });
    return { kind: 'scalar', plan: only };
  }
  const entry = aliases.get(end.label);
  // An UNBOUND label is a runtime error ("unknown as() label"), so it declines here rather than
  // becoming a NULL endpoint — a silently unproductive write.
  if (!entry) return null;
  return aliasIdAt(col(over.id, entry.col), 'last');
}

/**
 * `addE(label)` with its `from`/`to`/`property` cluster — ONE edge per incoming traverser.
 *
 * Its shape is `addV`'s and it reuses the same three pieces: the label UPSERT, an `Insert … SELECT …
 * RETURNING` whose SOURCE decides how many, and then `property()`'s statements over the returned
 * ids. What differs is that an edge has ENDPOINTS, and the whole of that difference is two
 * expressions written in the INPUT relation's scope — so `from("a")` (an alias column it carries),
 * `to(__.V(2))` (a scalar subquery) and an omitted side (the incoming traverser) are one lowering.
 *
 * **No correlation key is needed for the ENDPOINTS and that is not luck**: every endpoint form here is
 * decidable against the INPUT row, so `src` and `tgt` are columns of the insert's own source. One IS
 * needed to carry the INCOMING traversers' ALIASES forward, and it is `addV`'s — the created rows recover their
 * position from their own ids and join back to the input's. That is what makes a SECOND `addE` in the
 * same chain work, which is the corpus's dominant write shape (every standard-graph seeder is six
 * `addV`s and then six `addE`s reading the labels they bound).
 */
export function elementAddE(
  input: Rel, elem: Elem | null, step: IRStep, cluster: readonly IRStep[], aliases: AliasMap,
  ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  // The label is resolved by `labelSource` BELOW, once `property(T.label, …)` has had its say — a
  // `typeof !== 'string'` gate here would reject a nested body before the resolution that handles it
  // ever ran, which is exactly what it did. It stays raw until then.
  const stepLabel = (step.args ?? [])[0]?.value;

  let from: Endpoint = { kind: 'traverser' };
  let to: Endpoint = { kind: 'traverser' };
  const propertySteps: IRStep[] = [];
  for (const member of cluster) {
    if (member.name === 'property') { propertySteps.push(member); continue; }
    if (member.modulators?.length || member.optionArms) return null;
    const parsed = endpointOf((member.args ?? [])[0]?.value, child, fresh);
    if (!parsed) return null;
    if (member.name === 'from') from = parsed; else to = parsed;
  }
  // BOTH ends implicit is a SELF-LOOP on the incoming vertex, not a meaningless shape:
  // `AddEdgeStep` defaults an unset endpoint to `traverser::get`
  // (`vendor/tinkerpop/gremlin-core/.../step/map/AddEdgeStepContract.java:88-92`), so `addE("self")`
  // with no `from`/`to` attaches an edge from the current traverser to itself. `addV(…).addE("self")`
  // is exactly that. The one form that is genuinely nothing is the SOURCE (`AddEdgeStartStep` defaults
  // both to `() -> null`, `AddEdgeStartStep.java:127,136`, and raises), and the `id`-carrying guard
  // below already declines it: a one-row `Values` seed carries no `id`, so an implicit end has nothing
  // to be — asking it for one is a throw rather than a decline unless it is asked here (`rel-sweep`
  // found exactly that on `addE.from`).
  //
  // **The INPUT'S element kind only matters where an end is implicit**, and that is why it is asked
  // here rather than at the top: an implicit end IS the incoming traverser, so an edge stream would be
  // one for neither side. With both ends named the input is a multiplier and its kind is irrelevant —
  // which is exactly the second `addE` of a seeder chain, whose input is the first `addE`'s edge.
  // Refusing on the kind alone declined every one of them.
  const implicit = from.kind === 'traverser' || to.kind === 'traverser';
  if (implicit && (elem !== 'vertex' || !input.type.cols.some((column) => column.name === 'id'))) return null;
  // The `T` TOKENS are `addV`'s partition on the edge host — `creationTokens` is host-agnostic because
  // `parseProperty` reports a token neutrally and lets the host decide (write-args.ts). Both tokens are
  // the reference's on this step: `AddEdgeStep` carries `T.id` (`getElementId`/`setElementId`) and reads
  // `T.label` out of the same `internalParameters` its constructor writes the step's own label into
  // (`AddEdgeStep.java:100-112`), so `property(T.label, l)` REPLACES the label exactly as it does on
  // `addV`. Validating the WINNER rather than the step's argument is what makes that true.
  const tokens = creationTokens(propertySteps, child);
  if (!tokens) return null;
  // A RUNTIME label works here for the same reason it works on `addV`, and by the same two pieces:
  // the seam's rooted arm resolves the body's FIRST value (`TraversalUtil.apply` is `next()`), and the
  // reference's three validity rules are pure predicates over that value, so they ride as guards. The
  // only host-specific part is which label WINS — `property(T.label, …)` replaces the step's argument,
  // and whichever won is the one validated.
  const label = labelSource(tokens.label ?? stepLabel, child, fresh);
  if (!label) return null;
  const writes = tokens.rest.length ? propertyWrites(tokens.rest, 'edge', child) : [];
  if (!writes) return null;

  const carried = input.channels.filter((channel) => channel.role === 'alias');
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, writeInputChannels(input)) : input;

  const src = endpointExpr(from, incoming, aliases, fresh);
  const tgt = endpointExpr(to, incoming, aliases, fresh);
  if (!src || !tgt) return null;

  // A SUPPLIED PUBLIC ID needs BOTH graph-dependent refusals, and `addV` only needs the first because it
  // can prove the second at compile time (its one-row case is a literal `Values`). An `addE` mid-chain
  // input is a traverser relation — `g.V(1)` yields one row and `g.V()` yields six, and nothing static
  // separates them — so the arithmetic `addV` settles by declining becomes a guard here:
  //
  // - **is the id TAKEN** — `elementIdGuard`, the existing binding, verbatim;
  // - **is the input MORE THAN ONE ROW** — N rows would insert N edges carrying the same public id and
  //   the second would collide on a UNIQUE the guard is not the authority for, surfacing as a raw SQLite
  //   error rather than the reference's sentence. Upstream reaches the same verdict by looping and
  //   raising `id already exists` on its second iteration, so the MESSAGE IS THE SAME ONE — which is why
  //   this is a guard and not a decline (a decline would hand back a traversal the algebra can express).
  //
  // `Limit{offset: 1, count: 1}` is the row-count test written as a relation: it is non-empty exactly
  // when a second row exists, which is what `raiseWhen: 'rows'` asks.
  if (tokens.id !== null) {
    const taken = elementIdGuard(tokens.id, 'edge', fresh);
    guard(taken.node, taken.guard);
    const second = make.limit({
      id: fresh('li'), input: incoming, channels: incoming.channels, type: incoming.type,
      count: compilerInt(1), offset: compilerInt(1),
    });
    // A CONSTANT, never a column of the input: this guard asks ONLY "is there a second row", so reading
    // a column would couple it to a shape it has no business knowing. It bit exactly that way —
    // projecting `id` threw `no declared column 'id'` for the SOURCE form (`g.addE(l).from(x).to(y)`),
    // whose input is the one-row `Values` seed that carries no `id` by construction (the same fact the
    // implicit-endpoint guard above relies on). A row-count test is column-agnostic or it is wrong.
    guard(make.project({ id: fresh('p'), input: second, channels: [], type: ID_TYPE, exprs: [['id', compilerInt(1)]] }), taken.guard);
  }

  // A RUNTIME label's validity, before the insert — a check after it has nothing left to refuse.
  for (const runtime of label.runtime) labelGuards(runtime, guard, fresh);
  // EVERY `property()` after an `addE` is one of its PARAMETERS (`GraphTraversal.property` folds into an
  // `AddEdgeStepContract` unconditionally, `dsl/graph/GraphTraversal.java:4034`), so a traversal value is
  // resolved against the INCOMING traverser — and its refusals, like the label's, before the insert.
  const folded = foldedParameters(writes, 'edge', incoming, elem, aliases, child, bind, guard, fresh);
  if (!folded) return null;
  const labelRow = internLabels(label.names, bind, fresh)!;

  // ORDERED BY THE INPUT'S OWN POSITION, for `addVertex`'s reason: rowids are assigned in the source's
  // output order, so this is what makes the k-th created edge the k-th input row — which is what the
  // alias carry below joins on. Channel-PRESERVING, so the `Sort` declares its input's list.
  const inOrder = incoming.type.cols.some((column) => column.name === ORD)
    ? make.sort({ id: fresh('so'), input: incoming, channels: incoming.channels, type: incoming.type, terms: [{ expr: col(incoming.id, ORD), dir: 'asc' }] })
    : incoming;
  const paired = make.join({
    id: fresh('j'), left: inOrder, right: labelRow, join: 'cross', channels: [],
    type: typeOf(...inOrder.type.cols, meta('lbl', 'int')),
  });
  // A CALLER-SUPPLIED PUBLIC ID lands in one of two columns and the choice is the value's own type,
  // exactly as `addVertex` spells it for `nodes`: a NUMBER is the rowid, a STRING is the `uid`. Absent,
  // the row names neither and takes whatever rowid SQLite assigns.
  const idCol = tokens.id === null ? null : typeof tokens.id === 'number' ? 'id' : 'uid';
  const idMeta = idCol === 'id' ? meta('id', 'int') : meta('uid', 'text', true);
  const idExpr: Expr | null = tokens.id === null ? null : typeof tokens.id === 'number' ? compilerInt(tokens.id) : text(tokens.id);
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [],
    type: typeOf(...(idCol ? [idMeta] : []), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [
      ...(idCol ? [[idCol, idExpr!] as const] : []),
      ['src', reScope(src, incoming.id, paired.id)], ['label', col(paired.id, 'lbl')], ['tgt', reScope(tgt, incoming.id, paired.id)],
    ],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const created = bind(insert({
    target: edgesTarget, cols: [...(idCol ? [idCol] : []), 'src', 'label', 'tgt'], source: rows, channels: [], type: ID_TYPE,
    returning: [['id', col(edgesTarget.id, 'id')]],
  }));

  for (const write of folded) {
    if (typeof write === 'function') write(targetsOf(positioned(created, fresh), ORD, fresh), bind);
    else if (!propertyStatements('edge', created, write, bind, fresh, child, aliases, guard)) return null;
  }

  // THE ALIASES CARRY, by `addVertex`'s mechanism because it is the same question: an `Insert`'s
  // `RETURNING` says nothing about which input row produced a given output row, so the created rows
  // recover their position from their own ids and join back to the position the input carried. Without
  // it a SECOND `addE` in one chain has no labels to read, and that is the corpus's dominant write
  // shape — every standard-graph seeder binds six `as()`es over six `addV`s and then reads them from
  // six `addE`s.
  const channels: Channels = [...carried, ...(ordered ? [BULK_CHANNEL, ENCOUNTER_CHANNEL] : [BULK_CHANNEL])];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  const ranked = positioned(created, fresh);
  const zipped = carried.length
    ? make.join({
      id: fresh('j'), left: ranked, right: incoming, join: 'inner', channels: [],
      type: typeOf(...ranked.type.cols, ...incoming.type.cols.map((column) => meta(`in_${column.name}`, column.type, column.nullable))),
      on: eq(col(ranked.id, ORD), col(incoming.id, ORD)),
    })
    : created;
  const result = make.project({
    id: fresh('c'), input: zipped, channels, type: typeOf(...cols),
    // IN THE DECLARED ORDER — the id followed by the channels in `ROLE_ORDER`.
    exprs: [
      ['id', col(zipped.id, 'id')],
      ...carried.map((channel) => [channel.col, col(zipped.id, `in_${channel.col}`)] as const),
      ['bulk', compilerInt(1)],
      ...(ordered ? [['encounter', col(zipped.id, 'id')] as const] : []),
    ],
  });
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

/** One `from()`/`to()` argument → the endpoint it names, or `null` for a form this route declines
 *  (`__.addV(…)`, which CREATES its endpoint as a side effect of resolving it, and anything whose
 *  nested chain the read fold does not cover). */
function endpointOf(value: unknown, child: ChildSeam, fresh: Minter, ids = false): Endpoint | null {
  // A bare STRING is an `as()` label to `from()`/`to()`, and a public vertex id to a merge map's
  // endpoint option — the same characters meaning different things because the two hosts declare
  // different vocabularies. `ids` is which host is asking, stated rather than sniffed.
  if (typeof value === 'string') return ids ? { kind: 'vertex', uid: value } : { kind: 'alias', label: value };
  if (ids && typeof value === 'number') return { kind: 'vertex', uid: value };
  if (!isNested(value)) return null;
  const inner = child.body(value.nested, 'rooted');
  if (!inner?.length) return null;
  // `__.select("a")` IS the bare label, spelled longhand.
  if (inner.length === 1 && inner[0]!.name === 'select' && typeof inner[0]!.args?.[0]?.value === 'string')
    return { kind: 'alias', label: inner[0]!.args[0].value as string };
  const read = rootedVertices(inner, child, fresh);
  return read && { kind: 'read', rel: read };
}

/**
 * A ROOTED chain as a one-column relation of VERTEX rowids — the child seam's third answer plus THIS
 * vocabulary's own admission rule (§6·6).
 *
 * The rule is the write's, not the seam's: an endpoint must be a VERTEX stream (an edge has no end an
 * edge can attach to), and a rooted chain with EFFECTS of its own is refused rather than spliced —
 * that endpoint is `__.addV(…)`, whose creation has to be ORDERED against the edge insert, and whose
 * statements are `Plan` bindings a spliced relation would silently drop.
 */
function rootedVertices(steps: readonly IRStep[], child: ChildSeam, fresh: Minter): Rel | null {
  const read = child.rooted(steps);
  if (!read || read.effects?.length || read.framing.kind !== 'elements' || read.framing.elem !== 'vertex') return null;
  return make.project({ id: fresh('ep'), input: read.rel, channels: [], type: ID_TYPE, exprs: [['id', col(read.rel.id, 'id')]] });
}

/**
 * THE VERTICES A MERGE MAP MATCHES — its criteria handed BACK to the read fold as the
 * `V().hasLabel(l)….has(k, v)…` chain they are, rather than re-expressed as a second predicate
 * vocabulary. Every name must be carried (so one `hasLabel` per name, since one step listing them all
 * is ANY-of) and every entry is an ANY-value property match, which is what `has` already means.
 *
 * SYNTHESIZED STEPS, deliberately: writing the criteria as the steps they are and sending them through
 * the seam is the only spelling under which the merge's search and `has()`'s answer cannot drift apart.
 * It also means the search inherits whatever `has` learns next — the vtype-aware compare it already
 * has, the FTS arm §4 lifts. `args` is the whole of an `IRStep` these two steps read; the passes have
 * already run on the chain this belongs to, so re-running them over a synthesized fragment would ask a
 * question about a traversal nobody wrote.
 */
function matching(
  id: string | number | null,
  labels: readonly string[], props: readonly (readonly [string, import('../../gremlin/frontend.ts').ArgValue])[], child: ChildSeam, fresh: Minter,
): Rel | null {
  // A SUPPLIED `T.id` is `searchVerticesTraversal`'s `g.V(id)` narrowing, spelled as the `hasId(id)`
  // step it is equivalent to — the same read-fold path `g.V().has(T.id, …)` takes, reading the
  // external id (`COALESCE(uid, id)`). So the merge search inherits id matching from `hasId` rather
  // than re-expressing it, exactly as it inherits label/property matching from those steps.
  return rootedVertices([
    { name: 'V', args: [] },
    ...(id === null ? [] : [{ name: 'hasId', args: [arg(id)] }]),
    ...labels.map((label) => ({ name: 'hasLabel', args: [arg(label)] })),
    ...props.map(([key, value]) => ({ name: 'has', args: [arg(key), arg(value)] })),
  ] as IRStep[], child, fresh);
}

/** A merge map's `T.id` slot as the scalar an element id may be — `null` for "the map named none"
 *  (an absent slot), and `false` for "named, but not a placeable id". A nested id is filtered out by
 *  the caller before this, so the only remaining non-scalar is a shape this route declines rather than
 *  coercing (`addV`/`addE`'s `T.id` decline the same non-string/number values). */
const idOrNull = (id: unknown): string | number | null | false =>
  id === null || id === undefined ? null : typeof id === 'string' || typeof id === 'number' ? id : false;

/** Rewrite a `Col` written against `from` so it names `to` instead — what a CROSS JOIN's projection
 *  needs, because a join's outputs are spelled in ITS scope and not its sides'. */
const reScope = (e: Expr, from: RelId, to: RelId): Expr =>
  rewriteExpr(e, (node) => (node.kind === 'col' && node.rel === from ? { ...node, rel: to } : node));

/**
 * An input relation projected to the columns a write needs, IN EMISSION ORDER, carrying its own
 * POSITION, and named.
 *
 * An ALIAS column crosses as `json(…)` TEXT: the retained-row transport carries what JSON carries
 * losslessly, and a JSONB blob is not that (`src/program.ts` fails closed on one). `->>`/
 * `json_extract` read the two identically, so nothing downstream learns which it got.
 *
 * **The position is MATERIALIZED here rather than recovered later, and that is what makes a write's
 * result correlatable with its input.** An `Insert`'s `RETURNING` carries the TARGET table's columns
 * and not its source's, so nothing comes back saying which input row produced it; SQLite also does
 * not promise an order for `RETURNING` rows. What it does promise is that a rowid is assigned per
 * inserted row, monotonically — so the created side recovers its position from its own `id`
 * (`ORDER_BY_ID` below) and this side carries the position it was inserted IN. Two positions, joined:
 * an exact correlation that depends on neither the transport's row order nor a spare column.
 */
function inputRows(input: Rel, cols: readonly ColMeta[], fresh: Minter): { readonly bindings: readonly Binding[]; readonly result: Rel } {
  const jsonOf = (column: ColMeta): Expr =>
    column.type === 'json' ? { kind: 'call', fn: 'json', args: [col(input.id, column.name)] } : col(input.id, column.name);
  const declared = cols.map((column) => (column.type === 'json' ? meta(column.name, 'text', true) : column));
  const kept = make.project({
    id: fresh('w'), input: input, channels: [], type: typeOf(...declared),
    exprs: cols.map((column) => [column.name, jsonOf(column)] as const),
  });
  const encounter = input.channels.find((channel) => channel.role === 'encounter');
  const ordered = encounter && cols.some((column) => column.name === encounter.col)
    ? make.sort({ id: fresh('so'), input: kept, channels: [], type: kept.type, terms: [{ expr: col(kept.id, encounter.col), dir: 'asc' }] })
    : kept;
  // A chain with NO emission order still gets a position, and it is not a contradiction: the order is
  // arbitrary but it is FIXED the moment these rows are retained, and every later reader sorts by the
  // column rather than re-deriving it. An unordered chain has no answer to "which was first"; it must
  // still have ONE answer to "which input row is this created row".
  const positioned = rowNumberWindow(ordered, ORD, [], { partitionBy: [],
    orderBy: encounter && cols.some((column) => column.name === encounter.col) ? [{ expr: col(ordered.id, encounter.col), dir: 'asc' }] : [] }, fresh);
  return nameBindings(positioned);
}

/** The column a write's input carries its POSITION in, and the created rows recover theirs into.
 *  One name, because the join is between two relations that must agree on it. */
const ORD = 'ord';

/** The created rows with their position recovered from their own ids — `ROW_NUMBER() OVER (ORDER BY
 *  id)`. SQLite assigns a rowid per inserted row in the source's order, so the k-th smallest id IS
 *  the k-th input row; reading it off the DATA is what makes this independent of whatever order the
 *  `RETURNING` rows happened to arrive in. */
function positioned(created: Rel, fresh: Minter): Rel {
  return rowNumberWindow(created, ORD, [], { partitionBy: [], orderBy: [{ expr: col(created.id, 'id'), dir: 'asc' }] }, fresh);
}

// ---------- mergeV() ----------

/**
 * `mergeV(map)` with its `option()` arms and the `property()` run after them — the upsert, as
 * statements over ONE search relation.
 *
 * ## THE BRANCH IS NOT CONTROL FLOW, and that is the whole design
 *
 * Upstream searches, then applies `onMatch` to every match — or, where there were none, creates from
 * the merge map plus `onCreate`. Read as an `if` that needs a row COUNT before the next statement can
 * be chosen, which is exactly what a program of statements over relations cannot express. Read
 * RELATIONALLY it needs nothing at all: the `onMatch` writes run over the MATCH relation, which is
 * empty on the create path and therefore writes nothing; and the create runs over a source GUARDED by
 * `NOT EXISTS <the match>`, which is empty on the match path and therefore inserts nothing. Two total
 * statements, no branch taken anywhere — and the same reason an input of N rows needs no loop.
 *
 * ## THE SEARCH IS `V().hasLabel(…).has(k, v)`, spelled as those steps
 *
 * A merge map's criteria are a `has()` chain and nothing more: `T.label` is `hasLabel` (EVERY name
 * must be carried, so one step per name rather than one step listing them, which is ANY), and a
 * property entry is `has(key, value)` — an ANY-value `EXISTS` over the normalized table, which is
 * already what `has` means. So the search is built by handing those steps back to the READ FOLD
 * (`matching`, over the child seam) instead of by writing a second predicate vocabulary. That second
 * copy of the three clauses is the one this route does not make — every improvement to `has` (the FTS
 * arm, a vtype-aware compare) serves the merge for free, and a divergence between "what mergeV
 * searches for" and "what has() finds" is not expressible.
 *
 * ## WHAT THE INPUT CONTRIBUTES IS A COUNT
 *
 * A constant merge map poses the same search for every incoming traverser, so the input decides how
 * MANY results there are and nothing else: the result is the input CROSS JOIN the merged element(s),
 * which is upstream's per-traverser loop stated as a relation. `g.V().mergeV([:])` over two vertices
 * is FOUR traversers for exactly that reason and the scenario asserts it. The create takes `LIMIT 1`
 * off the input because upstream's second iteration matches what its first one created — one vertex,
 * N traversers, and the N comes from the join.
 *
 * **The result is the SNAPSHOT union the created ids, never the search re-run.** Re-reading the search
 * after the writes looks equivalent and is not: `option(onMatch, [name: 'allen'])` under a `single`
 * cardinality changes the very property the search asked about, so the re-read would return nothing
 * and the traversal would emit no traverser at all. A corpus scenario does exactly this.
 *
 * ## WHAT DECLINES, each because the answer is not a compile-time one
 *
 * - a NESTED label/key/value anywhere in a map — resolved per incoming traverser against the graph, which is
 *   `resolveMergeSpec`'s row-at-a-time surface and not an expression. A `__.select(k)` whole-arg map
 *   is the same decline for a smaller reason: it needs the `withSideEffect` constants, which this seam
 *   is not handed. A nested `T.id` value declines for the same reason (a per-row id).
 * - `option(onMatch, [(T.label): …])` — label MUTATION, whose refusal depends on the graph's `mutable`
 *   flag and whose write is not a property write at all.
 *
 * ## `T.id` IS SUPPORTED, and it is the SEARCH's id, the CREATE's id, and a CONDITIONAL guard
 *
 * The search narrows by the merge argument's id (`hasId`, above), the create writes `onCreate`'s id or
 * the merge argument's, and the "already exists" refusal is a guard that fires ONLY on the create branch
 * — `addV`'s unconditional guard would wrongly raise on a match, because a search-by-id match already
 * owns that id. A non-scalar id (a shape no vertex id can be) declines, as it does on `addV`.
 */

/**
 * `onMatch` over the MATCHED vertices — the append-only labels first (their own table), then the property
 * writes. The RUNTIME write is dispatched by the caller, because that is the ONE thing the two vertex-merge
 * paths do differently: a constant merge's matches are input-independent, so its runtime arm value is one
 * rooted scalar (`mergeArmValueWrite`); a correlated merge's matches differ per driver, so its value is
 * per-driver (`armValueWriteCorrelated`). Everything else — the labels, the constant-write dispatch — is
 * identical, and sharing it is what stops the two paths drifting (that drift once dropped a `markDirty`).
 * `false` declines.
 */
function applyMergeOnMatch(
  matchedIds: Rel, appended: readonly string[], matchWrites: readonly PropertyWrite[],
  runtimeWrite: (write: PropertyRuntimeSet) => boolean,
  bind: Binder, guard: Guarder, fresh: Minter, child: ChildSeam,
): boolean {
  if (appended.length) bindLabels(matchedIds, appended, bind, fresh);
  for (const write of matchWrites) {
    const ok = write.kind === 'runtime' ? runtimeWrite(write)
      : propertyStatements('vertex', matchedIds, write, bind, fresh, child, NO_ALIASES, guard);
    if (!ok) return false;
  }
  return true;
}

/**
 * THE MERGED VERTICES EMITTED — matched ∪ created, the `property()` tail run over the union (matched and
 * created alike), the matched vertices' rev touched (created are born dirty; an empty matched is a no-op),
 * and the whole crossed back onto the incoming traversers. SHARED by both vertex-merge paths: the create's
 * SHAPE (a constant merge's single `LIMIT 1` create vs a correlated merge's create-per-distinct-map) and
 * the `crossed` CORRELATE flag are the only host differences, and they are the two arguments. `null`
 * declines. The `markDirty` lands at the END here rather than mid-program — its only reader is the
 * post-write refresh, which runs once after every statement, so its position among them does not matter.
 */
function emitMergeVertices(
  incoming: Rel, matched: Rel, produced: Rel, matchedIds: Rel, dirtied: boolean,
  tailWrites: readonly PropertyWrite[], correlate: boolean, ordered: boolean, carriedCh: Channels,
  bind: Binder, guard: Guarder, fresh: Minter, child: ChildSeam,
): Rel | null {
  const merged = make.union({ id: fresh('u'), inputs: [matched, produced], all: true, channels: [], type: matched.type });
  const emitted = tailWrites.length ? bind(merged, true) : merged;
  for (const write of tailWrites) if (!propertyStatements('vertex', emitted, write, bind, fresh, child, NO_ALIASES, guard)) return null;
  if (dirtied || tailWrites.length) bind(markDirty('vertex', matchedIds, fresh));
  return crossed(incoming, emitted, carriedCh, ordered, fresh, correlate);
}

/**
 * `mergeV(__.project('k').by(__.body))` — the CORRELATED merge SEARCH, whose criteria are computed
 * PER DRIVER rather than being compile-time constants.
 *
 * `MergeElementStep.materializeMap` runs the whole map-producing traversal at the incoming traverser
 * (`TraversalUtil.apply`, `vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53`), so the
 * search values are CONCRETE per driver and the search is a literal `has(k, concreteValue)` chain
 * (`.../step/map/MergeElementStep.java:397-404`). Two searches for two drivers, so `mergeV`'s
 * input-INDEPENDENT cross join (one search for all drivers) is the wrong correlation — this is
 * `mergeE`'s endpoint machinery on the vertex host: a per-driver CARRIER, a decorrelated equi-join
 * (Calcite's `RelDecorrelator` form — a projected column joined, never a LATERAL), one create per
 * DISTINCT computed map that found nothing, and `crossed(…, correlate=true)`.
 *
 * The constant criteria (label / constant props / `T.id`) stay input-independent through `matching`
 * (the read fold), so they keep inheriting whatever `has()`/`hasLabel()` learn; only the COMPUTED
 * criteria are carried and joined here. An unproductive by-body OMITS its key for that driver
 * (`ProjectStep.ifProductive`, `.../step/map/ProjectStep.java:62-70`), read as "this criterion does not
 * narrow" — not a raise (a bare `project` always emits a map, so there is no 0-result raise here; that
 * is the general map-producing-traversal case, deferred).
 *
 * The first increment covers the SEARCH map with no `option()` arms and no `property()` tail — those
 * over a computed search decline (a clean deferral, never a wrong answer), handled in the constant path.
 */
function mergeVComputed(
  input: Rel, match: MergeSpec, onCreate: MergeSpec | null, onMatch: MergeSpec | null,
  propertySteps: readonly IRStep[], driverElem: Elem | undefined, ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  const cKeys = Object.keys(match.computed);
  const searchId = idOrNull(match.id);
  if (searchId === false) return null;
  // The `property()` TAIL is an ordinary AddPropertyStep over the merge OUTPUT (matched and created
  // alike), exactly as it is on a constant merge — same parse, run below over `emitted`.
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'vertex', child) : [];
  if (!tailWrites) return null;
  // The `option()` arms — CONSTANT only. An `onMatch` writes over the MATCHED vertices, an `onCreate`
  // over the CREATED ones (its label/props join the creation). A RUNTIME arm value resolves at the
  // DRIVER (`materializeMap(traverser)`) and declines here: over a multi-driver computed search the
  // matched vertices differ per driver, so it needs an ord-correlated write, a separate increment.
  const appended = [...new Set(((onMatch?.label as string[] | null) ?? []))];
  try { for (const name of appended) validateLabel(name); } catch { return null; }
  const matchWrites = mergeWrites(onMatch, 'vertex', child);
  const createExtra = onCreate ? mergeWrites(onCreate, 'vertex', child) : [];
  if (!matchWrites || !createExtra) return null;
  // The created vertex's LABEL is `onCreate`'s where it gives one, else the merge argument's (a `project`
  // gives none). A runtime label declines.
  const labels = ((onCreate?.label ?? match.label) as string[] | null) ?? [];

  const carriedCh = writeInputChannels(input);
  if (carriedCh.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carriedCh) : input;
  const hasOrd = incoming.type.cols.some((column) => column.name === ORD);

  // THE CARRIER — one `(present, value, vtype)` triple per computed key, resolved at the DRIVER. A body
  // that does not lower to a scalar, or cannot state its productivity (`present` ABSENT ≠ "always
  // productive", `child.ts`), declines the whole search rather than mis-executing.
  // The driver-rooted body reads the DRIVER's own property (`by('key')`/`by(__.values(k))`), so the
  // host is the driver's element kind. `?? 'vertex'` preserves the prior hardcode for a cannot-say
  // driver (after a branch/select) — a simplification the map-valued-driver substrate revisits.
  const host: ChildHost = { kind: 'element', id: col(incoming.id, 'id'), elem: driverElem ?? 'vertex', row: { rel: incoming, aliases: NO_ALIASES } };
  // The value's Gremlin TYPE at the driver — a `has(k, concreteValue)` compare needs it, and it comes
  // from one of three places: a per-row read carries it as a `vtype` column (`__.values(k)`); a static
  // scalar states it in its framing (`count()`→`long`); a bare literal states it in its storage class
  // (`__.constant('x')` frames as `unknown`, so read the lit). A value we cannot type DECLINES the whole
  // search rather than comparing against a NULL vtype, which silently matches nothing (a duplicate
  // create — a wrong answer, not a coverage gap).
  const litVtype = (e: Expr): string | null =>
    e.kind === 'lit' ? (e.type === 'text' ? 'string' : e.type === 'int' ? 'int' : e.type === 'real' ? 'double' : null) : null;
  const values: ChildValue[] = [];
  const pts: Expr[] = [];
  for (const key of cKeys) {
    const produced = child.scalar(match.computed[key]!, host);
    if (!produced || produced.framing.kind !== 'scalar' || produced.present === undefined) return null;
    const pt = produced.vtype
      ?? (produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static' ? compilerText(String(produced.framing.type.type)) : null)
      ?? (litVtype(produced.expr) ? compilerText(litVtype(produced.expr)!) : null);
    if (!pt) return null;
    values.push(produced);
    pts.push(pt);
  }
  const ppCol = (i: number) => `pp${i}`, cvCol = (i: number) => `cv${i}`, ptCol = (i: number) => `pt${i}`;
  // Every dropped key normalises to `(0, NULL, NULL)`, so two drivers that drop the same key agree — the
  // value the unproductive body happened to leave never leaks into the identity or the compare.
  const gate = (present: Expr, e: Expr): Expr => ({ kind: 'case', whens: [[present, e]], else: compilerNull('text') });
  const tupleCols = cKeys.flatMap((_, i) => [meta(ppCol(i), 'int'), meta(cvCol(i), 'any', true), meta(ptCol(i), 'text', true)]);
  const carrier = bind(make.project({
    id: fresh('cc'), input: incoming, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), ...tupleCols),
    exprs: [
      ...(hasOrd ? [[ORD, col(incoming.id, ORD)] as const] : []),
      ...cKeys.flatMap((_, i) => [
        [ppCol(i), { kind: 'case', whens: [[values[i]!.present!, compilerInt(1)]], else: compilerInt(0) } as Expr] as const,
        [cvCol(i), gate(values[i]!.present!, values[i]!.expr)] as const,
        [ptCol(i), gate(values[i]!.present!, pts[i]!)] as const,
      ]),
    ],
  }), true);
  // A per-driver identity over the computed MAP — two drivers create ONE vertex iff their maps are equal
  // (`Map.equals`, `record.ts`), stated as a JSON tuple of the normalised `(present, vtype, value)`s.
  const tupleKey = (rel: RelId): Expr => ({ kind: 'call', fn: 'json_array', args: cKeys.flatMap((_, i) => [col(rel, ppCol(i)), col(rel, ptCol(i)), col(rel, cvCol(i))]) });

  // THE MATCH — candidates (constant criteria, input-independent) narrowed by every computed criterion.
  const candidates = matching(searchId, labels, Object.entries(match.props), child, fresh);
  if (!candidates) return null;
  // `has(k, concreteValue)` per key as a correlated EXISTS over the candidate's stored property, compared
  // vtype-aware (`typedValueEq` = `Compare.eq`); an unproductive key (`present=0`) does not narrow.
  const criterion = (candId: Expr, i: number): Expr => {
    const spec = PROPERTY_TABLE.vertex;
    const scan = make.scan({ id: fresh('vp'), table: spec.table, alias: fresh('rp'), channels: [], type: typeOf(...spec.cols) });
    const matched = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), candId), eq(col(scan.id, 'key'), compilerText(cKeys[i]!))),
        typedValueEq(col(scan.id, 'value'), col(scan.id, 'vtype'), col(carrier.id, cvCol(i)), col(carrier.id, ptCol(i)))),
    });
    const probe = make.project({ id: fresh('p'), input: matched, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return or(eq(col(carrier.id, ppCol(i)), compilerInt(0)), { kind: 'exists', plan: probe, negated: false });
  };
  const conj = cKeys.map((_, i) => criterion(col(candidates.id, 'id'), i)).reduce((a, b) => and(a, b));
  const joined = make.join({
    id: fresh('j'), left: carrier, right: candidates, join: 'inner', on: conj, channels: [],
    type: typeOf(...carrier.type.cols, meta('id', 'int')),
  });
  const matched = bind(make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(joined.id, ORD)] as const] : []), ['id', col(joined.id, 'id')]],
  }), true);
  // ROWS THAT FOUND NOTHING — carrier rows whose `ord` has no matched row (or, one driver with no `ord`,
  // the carrier when `matched` is empty).
  const trueLit = eq(compilerInt(1), compilerInt(1));
  const unmatched = make.filter({
    id: fresh('f'), input: carrier, channels: [], type: carrier.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: hasOrd ? eq(col(matched.id, ORD), col(carrier.id, ORD)) : trueLit }) },
  });
  // ONE TRAVERSER AT A TIME, before any write (`guardMergeInterleaving`).
  guardMergeInterleaving('mergeV', incoming, matched,
    { rel: unmatched, createKey: tupleKey, couldMatch: computedCouldMatch(cKeys, onCreate, ppCol, cvCol, ptCol) },
    { ...mergeWriteFacts('vertex', matchWrites, appended, tailWrites, new Set([...cKeys, ...Object.keys(match.props)]), propertySteps, child.writes), perDriverSearch: true },
    bind, guard, fresh);
  // `onMatch` over the MATCHED vertices — shared with the constant path; the per-driver runtime write
  // (`armValueWriteCorrelated`, correlated by `ord`) is the one host difference. Empty on the create path.
  if (!applyMergeOnMatch(idsOf(matched, fresh), appended, matchWrites,
    (write) => armValueWriteCorrelated(matched, incoming, hasOrd, write, driverElem, bind, fresh, child, NO_ALIASES),
    bind, guard, fresh, child)) return null;
  // ONE CREATE PER DISTINCT COMPUTED MAP — `Distinct` collapses the tuple (its NULL columns compare EQUAL,
  // which a join's `=` would not — the JSON key handles that side).
  const wanted = bind(rowNumberWindow(make.distinct({
    id: fresh('d'), channels: [], type: typeOf(...tupleCols),
    input: make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...tupleCols),
      exprs: cKeys.flatMap((_, i) => [[ppCol(i), col(unmatched.id, ppCol(i))] as const, [cvCol(i), col(unmatched.id, cvCol(i))] as const, [ptCol(i), col(unmatched.id, ptCol(i))] as const]) }),
  }), 'word', [], { partitionBy: [], orderBy: [] }, fresh), true);

  // THE CREATE — a vertex per wanted tuple, in `word` order so the assigned rowids recover their tuple.
  const nodesTarget = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [], type: typeOf(...NODES_COLS) });
  const inOrder = make.sort({ id: fresh('so'), input: wanted, channels: wanted.channels, type: wanted.type, terms: [{ expr: col(wanted.id, 'word'), dir: 'asc' }] });
  const rowPer = make.project({ id: fresh('p'), input: inOrder, channels: [], type: typeOf(meta('uid', 'text', true)), exprs: [['uid', compilerNull('text')]] });
  const created = bind(insert({ target: nodesTarget, cols: ['uid'], source: rowPer, channels: [], type: ID_TYPE, returning: [['id', col(nodesTarget.id, 'id')]] }));
  const createLabels = creationLabels(labels, child, fresh);
  if (!createLabels || createLabels.runtime?.length) return null;
  const labelRow = internLabels(createLabels.names, bind, fresh);
  if (labelRow) {
    const labelTargetRows = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
    const pairs = make.join({ id: fresh('j'), left: created, right: labelRow, join: 'cross', channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    bind(insert({ target: labelTargetRows, cols: ['node', 'label'], source: pairs, channels: [], type: typeOf(), returning: [] }));
  }
  // The created rows correlated back to their tuple by POSITION (rowid order = insertion order = `word`).
  const rankedCreated = positioned(created, fresh);
  // A bare join's declared `type` maps POSITIONALLY onto `left.cols ++ right.cols`, so it must list the
  // sides in that order — `rankedCreated` (id, ord) then `wanted` (pp/cv/pt…, word).
  const createdTuples = bind(make.join({
    id: fresh('j'), left: rankedCreated, right: wanted, join: 'inner', on: eq(col(rankedCreated.id, ORD), col(wanted.id, 'word')), channels: [],
    type: typeOf(...rankedCreated.type.cols, ...wanted.type.cols),
  }), true);
  // Write each PRESENT computed value onto its created vertex — FTS is the post-write refresh's (a created
  // vertex is born dirty), the same route every runtime value takes.
  for (let i = 0; i < cKeys.length; i++) {
    const spec = PROPERTY_TABLE.vertex;
    const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const present = make.filter({ id: fresh('f'), input: createdTuples, channels: [], type: createdTuples.type, pred: eq(col(createdTuples.id, ppCol(i)), compilerInt(1)) });
    const rows = make.project({
      id: fresh('p'), input: present, channels: [], type: typeOf(meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      exprs: [['node', col(present.id, 'id')], ['key', compilerText(cKeys[i]!)], ['value', col(present.id, cvCol(i))], ['vtype', col(present.id, ptCol(i))]],
    });
    bind(insert({ target, cols: ['node', 'key', 'value', 'vtype'], source: rows, channels: [], type: WRITTEN_TYPE, returning: [['id', col(target.id, 'id')], ['owner', col(target.id, spec.owner)]] }));
  }
  // `onCreate`'s own CONSTANT properties, over the created vertices (its label already joined the
  // creation above). Additional to the merge argument's computed values, which are already written. A
  // RUNTIME onCreate value is deferred to below — it needs `createdFor`, the per-driver correlation.
  for (const write of createExtra) if (write.kind !== 'runtime' && !propertyStatements('vertex', created, write, bind, fresh, child, NO_ALIASES, guard)) return null;

  // THE CREATED VERTEX PER UNMATCHED DRIVER — join the driver's tuple KEY to the created tuple's, so the
  // one vertex made for a repeated map is carried by every driver that asked for it (`crossed`'s equi-join).
  const umMin = make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('tk', 'text')),
    exprs: [...(hasOrd ? [[ORD, col(unmatched.id, ORD)] as const] : []), ['tk', tupleKey(unmatched.id)]] });
  const ctMin = make.project({ id: fresh('p'), input: createdTuples, channels: [], type: typeOf(meta('cid', 'int'), meta('tk', 'text')),
    exprs: [['cid', col(createdTuples.id, 'id')], ['tk', tupleKey(createdTuples.id)]] });
  const cf = make.join({ id: fresh('j'), left: umMin, right: ctMin, join: 'inner', on: eq(col(umMin.id, 'tk'), col(ctMin.id, 'tk')), channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('tk', 'text'), meta('cid', 'int'), meta('ct_tk', 'text')) });
  const createdFor = bind(make.project({ id: fresh('p'), input: cf, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(cf.id, ORD)] as const] : []), ['id', col(cf.id, 'cid')]] }), true);
  // A RUNTIME `onCreate` value resolves at the DRIVER and lands per-driver on the vertex that driver
  // created (`createdFor` carries the `ord` that asked) — the same correlated write `onMatch` uses.
  for (const write of createExtra) if (write.kind === 'runtime' && !armValueWriteCorrelated(createdFor, incoming, hasOrd, write, driverElem, bind, fresh, child, NO_ALIASES)) return null;

  const result = emitMergeVertices(incoming, matched, createdFor, idsOf(matched, fresh),
    appended.length > 0 || matchWrites.length > 0, tailWrites, true, ordered, carriedCh, bind, guard, fresh, child);
  if (!result) return null;
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

/**
 * A map-VALUED merge driver for vertices — `inject([k:v,…]).mergeV()` / `mergeV(__.identity())`, where
 * the incoming TRAVERSER is the merge map (`MergeElementStep.materializeMap` with the identity/no-arg map
 * traversal, `vendor/tinkerpop/gremlin-core/.../step/map/MergeElementStep.java:339-353`). The map's
 * (key,value) entries are decomposed PER DRIVER at runtime via `json_each` over `MAP_COL`, so the search
 * KEY SET is DATA, not compile-time strings (which is what separates this from `mergeV(__.project(…))`).
 *
 * FIRST SUB-INCREMENT — a SCALAR-valued map with STRING property keys (`inject`/`select` of a scalar map).
 * Deferred, fail-closed, each a later sub-increment: a LIST-valued map (`valueMap()`, `valOf` list — its
 * value would compare a stored scalar against a JSON list, never equal); TOKEN keys (`T.label`/`T.id`,
 * declined by the map producer `mapLiteralBlob` upstream so they cannot arrive here) — so the search
 * narrows by properties alone and the create's label is `onCreate`'s or the default `vertex`; and a RUNTIME
 * arm value, which roots at the (map) driver and needs a map host.
 */
export function mergeVFromMap(
  input: Rel, maps: MergeMaps, valOf: MapOf, propertySteps: readonly IRStep[],
  ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (valOf.kind !== 'scalar') return null;
  const { onCreate, onMatch } = maps;
  const appended = [...new Set(((onMatch?.label as string[] | null) ?? []))];
  try { for (const name of appended) validateLabel(name); } catch { return null; }
  const matchWrites = mergeWrites(onMatch, 'vertex', child);
  const createExtra = onCreate ? mergeWrites(onCreate, 'vertex', child) : [];
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'vertex', child) : [];
  if (!matchWrites || !createExtra || !tailWrites) return null;
  // A RUNTIME arm value roots at the map driver (no element id) — deferred, so constant arms only here.
  if (matchWrites.some((write) => write.kind === 'runtime') || createExtra.some((write) => write.kind === 'runtime')) return null;
  const createLabels = creationLabels(((onCreate?.label as string[] | null) ?? []), child, fresh);
  if (!createLabels || createLabels.runtime?.length) return null;

  const carriedCh = writeInputChannels(input);
  if (carriedCh.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  // ALWAYS snapshot (even a `values` inject source) — the search reads the map three times and the
  // create needs a per-driver `ord` to correlate its output back, both of which want a retained relation.
  const seeded = inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = bind(seeded.result, true, carriedCh);
  if (!incoming.type.cols.some((column) => column.name === MAP_COL)) return null; // not a map stream
  const hasOrd = incoming.type.cols.some((column) => column.name === ORD);
  // The CARRIER — the driver's map (and its `ord`), reprojected WITHOUT the channels, so every search
  // filter/join below is channel-free; `incoming` keeps the channels for the final `crossed`.
  const carrier = bind(make.project({
    id: fresh('cc'), input: incoming, channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta(MAP_COL, 'json')),
    exprs: [...(hasOrd ? [[ORD, col(incoming.id, ORD)] as const] : []), [MAP_COL, col(incoming.id, MAP_COL)]],
  }), true);
  const driverMap = col(carrier.id, MAP_COL);
  const ext = (e: Expr, path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [e, compilerText(path)] });
  const jsonText = (e: Expr): Expr => ({ kind: 'call', fn: 'json', args: [e] });
  // The four sides of a pair (`[keyNode, valNode]`, each a `{t,v}` node): the key's type/value and the
  // value's value/type. A STRING key is a property criterion; a `{t:'T', v:'label'}` key is the label.
  const keyT = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'keys'), '$.t');
  const keyV = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'keys'), '$.v');
  const valV = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'values'), '$.v');
  const valT = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'values'), '$.t');
  const isToken = (p: Rel, name: 'label' | 'id'): Expr => and(eq(keyT(p), compilerText('T')), eq(keyV(p), compilerText(name)));
  // The map's `T.label` value as a per-row scalar (NULL when the map names none) — narrows the search and
  // labels the created vertex.
  const mapLabelScalar = (mapCol: Expr): Expr => {
    const p = pairsOf(mapCol, fresh);
    const hits = make.filter({ id: fresh('f'), input: p, channels: [], type: p.type, pred: isToken(p, 'label') });
    return { kind: 'scalar', plan: make.limit({
      id: fresh('li'), channels: [], type: typeOf(meta('lbl', 'any', true)), count: compilerInt(1),
      input: make.project({ id: fresh('p'), input: hits, channels: [], type: typeOf(meta('lbl', 'any', true)), exprs: [['lbl', valV(hits)]] }) }) };
  };
  // FAIL CLOSED on a `T.id` in the map — search-by-id / create-with-id is its own machinery (a per-driver
  // id and its collision guards); until then a map carrying it REFUSES rather than silently ignoring the
  // id criterion (a wrong answer). The guard fires per driver whose map holds a T.id.
  const idProbe = pairsOf(driverMap, fresh);
  guard(make.limit({
    id: fresh('li'), channels: [], type: typeOf(meta('n', 'int')), count: compilerInt(1),
    input: make.project({ id: fresh('p'), channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', compilerInt(1)]],
      input: make.filter({ id: fresh('f'), input: carrier, channels: [], type: carrier.type,
        pred: { kind: 'exists', negated: false, plan: make.filter({ id: fresh('f'), input: idProbe, channels: [], type: idProbe.type, pred: isToken(idProbe, 'id') }) } }) }),
  }), { message: 'mergeV with a T.id in a map-valued driver is not yet supported', raiseWhen: 'rows' });

  // THE MATCH — every vertex the driver's whole map is satisfied by. `allMatch` is NOT EXISTS a map entry
  // the candidate does NOT have (`has(k, v)` for every entry) — the dynamic-key form of `mergeVComputed`'s
  // per-key EXISTS, the key read off the pair instead of a compile-time string. An empty map matches
  // every vertex, exactly as `V()` does (`searchVerticesTraversal` returns `g.V()` for an empty map).
  const allMatch = (candId: Expr): Expr => {
    const pairs = pairsOf(driverMap, fresh);
    // A STRING property key satisfied by a stored property (vtype-aware compare).
    const vp = make.scan({ id: fresh('vp'), table: PROPERTY_TABLE.vertex.table, alias: fresh('rp'), channels: [], type: typeOf(...PROPERTY_TABLE.vertex.cols) });
    const vpMatch = make.filter({
      id: fresh('f'), input: vp, channels: [], type: vp.type,
      pred: and(and(eq(col(vp.id, 'node'), candId), eq(col(vp.id, 'key'), keyV(pairs))),
        typedValueEq(col(vp.id, 'value'), col(vp.id, 'vtype'), valV(pairs), valT(pairs))),
    });
    const propProbe = make.project({ id: fresh('p'), input: vpMatch, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    // A `T.label` key satisfied by the candidate carrying that label (hasLabel over vertex_labels).
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rl'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
    const lb = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rb'), channels: [], type: typeOf(...LABELS_COLS) });
    const vlJoin = make.join({ id: fresh('j'), left: vl, right: lb, join: 'inner', on: eq(col(vl.id, 'label'), col(lb.id, 'id')), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int'), meta('id', 'int'), meta('name', 'text')) });
    const vlMatch = make.filter({ id: fresh('f'), input: vlJoin, channels: [], type: vlJoin.type, pred: and(eq(col(vlJoin.id, 'node'), candId), eq(col(vlJoin.id, 'name'), valV(pairs))) });
    const labelProbe = make.project({ id: fresh('p'), input: vlMatch, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    // A pair the candidate FAILS: a string property it lacks, or the T.label it does not carry. (A T.id
    // pair cannot reach here — the guard above refused any map holding one.) `allMatch` = no such pair.
    const unsat = make.filter({
      id: fresh('f'), input: pairs, channels: [], type: pairs.type,
      pred: or(and(eq(keyT(pairs), compilerText('string')), { kind: 'exists', negated: true, plan: propProbe }),
        and(isToken(pairs, 'label'), { kind: 'exists', negated: true, plan: labelProbe })),
    });
    return { kind: 'exists', plan: unsat, negated: true };
  };
  const candScan = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('nc'), channels: [], type: typeOf(...NODES_COLS) });
  const candidates = make.project({ id: fresh('p'), input: candScan, channels: [], type: ID_TYPE, exprs: [['id', col(candScan.id, 'id')]] });
  const joined = make.join({
    id: fresh('j'), left: carrier, right: candidates, join: 'inner', on: allMatch(col(candidates.id, 'id')), channels: [],
    type: typeOf(...carrier.type.cols, meta('id', 'int')),
  });
  const matched = bind(make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(joined.id, ORD)] as const] : []), ['id', col(joined.id, 'id')]],
  }), true);
  // ROWS THAT FOUND NOTHING → one create per DISTINCT map (two drivers with the same map create one vertex).
  const trueLit = eq(compilerInt(1), compilerInt(1));
  const unmatched = make.filter({
    id: fresh('f'), input: carrier, channels: [], type: carrier.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: hasOrd ? eq(col(matched.id, ORD), col(carrier.id, ORD)) : trueLit }) },
  });
  // ONE TRAVERSER AT A TIME, before any write (`guardMergeInterleaving`). The search's key set is DATA, so
  // any onMatch key may be searched (`null`), and a driver's `[name:x]` finds another's `[name:x, age:1]`
  // creation — `mapCouldMatch`.
  guardMergeInterleaving('mergeV', incoming, matched,
    { rel: unmatched, createKey: (rel) => jsonText(col(rel, MAP_COL)), couldMatch: mapCouldMatch(onCreate, fresh) },
    { ...mergeWriteFacts('vertex', matchWrites, appended, tailWrites, null, propertySteps, child.writes), perDriverSearch: true }, bind, guard, fresh);
  // `onMatch` CONSTANT writes over the matched vertices (runtime declined above, so the callback is never
  // reached). Shared with the other vertex-merge paths.
  if (!applyMergeOnMatch(idsOf(matched, fresh), appended, matchWrites, () => false, bind, guard, fresh, child)) return null;
  const wanted = bind(rowNumberWindow(make.distinct({
    id: fresh('d'), channels: [], type: typeOf(meta(MAP_COL, 'json')),
    input: make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta(MAP_COL, 'json')), exprs: [[MAP_COL, col(unmatched.id, MAP_COL)]] }),
  }), 'word', [], { partitionBy: [], orderBy: [] }, fresh), true);

  // THE CREATE — a vertex per wanted map, in `word` order so the assigned rowids recover their map.
  const nodesTarget = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [], type: typeOf(...NODES_COLS) });
  const inOrder = make.sort({ id: fresh('so'), input: wanted, channels: wanted.channels, type: wanted.type, terms: [{ expr: col(wanted.id, 'word'), dir: 'asc' }] });
  const rowPer = make.project({ id: fresh('p'), input: inOrder, channels: [], type: typeOf(meta('uid', 'text', true)), exprs: [['uid', compilerNull('text')]] });
  const created = bind(insert({ target: nodesTarget, cols: ['uid'], source: rowPer, channels: [], type: ID_TYPE, returning: [['id', col(nodesTarget.id, 'id')]] }));
  const labelRow = internLabels(createLabels.names, bind, fresh);
  if (labelRow) {
    const labelTargetRows = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
    const labelPairs = make.join({ id: fresh('j'), left: created, right: labelRow, join: 'cross', channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    bind(insert({ target: labelTargetRows, cols: ['node', 'label'], source: labelPairs, channels: [], type: typeOf(), returning: [] }));
  }
  // The created rows correlated back to their map by POSITION (rowid order = insertion order = `word`).
  const rankedCreated = positioned(created, fresh);
  const createdMaps = bind(make.join({
    id: fresh('j'), left: rankedCreated, right: wanted, join: 'inner', on: eq(col(rankedCreated.id, ORD), col(wanted.id, 'word')), channels: [],
    type: typeOf(...rankedCreated.type.cols, ...wanted.type.cols),
  }), true);
  // WRITE THE MAP'S PROPERTIES onto each created vertex — one relational Insert over `json_each` (the
  // sanctioned data-sized write form): explode each created vertex's map into entries, KEEPING the
  // vertex id (`explodeMembers` carries the input row's columns), and project `(node, key, value, vtype)`.
  const { exploded } = explodeMembers(fenced(createdMaps, fresh), MAP_COL, PAIR, fresh);
  // Only STRING-key pairs become properties — a `T.label`/`T.id` token pair is not a property (the label
  // is written below; a `T.id` was refused by the guard). `exploded` carries the created vertex id.
  const propPairs = make.filter({ id: fresh('f'), input: exploded, channels: [], type: exploded.type,
    pred: eq(ext(pairSide(col(exploded.id, PAIR.value), 'keys'), '$.t'), compilerText('string')) });
  const propRows = make.project({
    id: fresh('p'), input: propPairs, channels: [],
    type: typeOf(meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    exprs: [['node', col(propPairs.id, 'id')], ['key', ext(pairSide(col(propPairs.id, PAIR.value), 'keys'), '$.v')],
      ['value', ext(pairSide(col(propPairs.id, PAIR.value), 'values'), '$.v')], ['vtype', ext(pairSide(col(propPairs.id, PAIR.value), 'values'), '$.t')]],
  });
  const propTarget = make.scan({ id: fresh('t'), table: PROPERTY_TABLE.vertex.table, alias: fresh('wt'), channels: [], type: typeOf(...PROPERTY_TABLE.vertex.cols) });
  bind(insert({ target: propTarget, cols: ['node', 'key', 'value', 'vtype'], source: propRows, channels: [], type: WRITTEN_TYPE, returning: [['id', col(propTarget.id, 'id')], ['owner', col(propTarget.id, 'node')]] }));
  // THE CREATED VERTEX'S LABEL, from the map's `T.label` (per created map). Intern the distinct label
  // names — an upsert, `internLabels`' idiom, but data-sized over the created maps rather than a
  // compile-time list — then link each created vertex to its label id by name. A map with no `T.label`
  // yields NULL and contributes no row (the labelless default, as g.addV()). The `onCreate` CONSTANT
  // label (below, `internLabels(createLabels.names)` ran above) is the fallback when the map names none.
  const namedCreated = make.project({ id: fresh('p'), input: createdMaps, channels: [], type: typeOf(meta('id', 'int'), meta('name', 'any', true)),
    exprs: [['id', col(createdMaps.id, 'id')], ['name', mapLabelScalar(col(createdMaps.id, MAP_COL))]] });
  const labelled = bind(make.filter({ id: fresh('f'), input: namedCreated, channels: [], type: namedCreated.type,
    pred: { kind: 'binary', op: 'is not', left: col(namedCreated.id, 'name'), right: compilerNull('text') } }), true);
  const distinctNames = make.distinct({ id: fresh('d'), channels: [], type: typeOf(meta('name', 'text')),
    input: make.project({ id: fresh('p'), input: labelled, channels: [], type: typeOf(meta('name', 'text')), exprs: [['name', col(labelled.id, 'name')]] }) });
  const labelsTable = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  bind(insert({ target: labelsTable, cols: ['name'], source: distinctNames, channels: [], type: typeOf(),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] }, returning: [] }));
  const lbLookup = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('rb'), channels: [], type: typeOf(...LABELS_COLS) });
  const vlJoined = make.join({ id: fresh('j'), left: labelled, right: lbLookup, join: 'inner', on: eq(col(labelled.id, 'name'), col(lbLookup.id, 'name')), channels: [],
    type: typeOf(meta('id', 'int'), meta('name', 'text'), meta('lid', 'int'), meta('lname', 'text')) });
  const vlTarget = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
  bind(insert({ target: vlTarget, cols: ['node', 'label'], channels: [], type: typeOf(), returning: [],
    source: make.project({ id: fresh('p'), input: vlJoined, channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')), exprs: [['node', col(vlJoined.id, 'id')], ['label', col(vlJoined.id, 'lid')]] }) }));
  // `onCreate`'s own CONSTANT properties, over the created vertices (its label already joined the creation).
  for (const write of createExtra) if (!propertyStatements('vertex', idsOf(created, fresh), write, bind, fresh, child, NO_ALIASES, guard)) return null;

  // THE CREATED VERTEX PER UNMATCHED DRIVER — join the driver's map to the created map (as canonical JSON
  // text), so the one vertex made for a repeated map is carried by every driver that asked (`crossed`).
  const umMin = make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('mk', 'text')),
    exprs: [...(hasOrd ? [[ORD, col(unmatched.id, ORD)] as const] : []), ['mk', jsonText(col(unmatched.id, MAP_COL))]] });
  const ctMin = make.project({ id: fresh('p'), input: createdMaps, channels: [], type: typeOf(meta('cid', 'int'), meta('mk', 'text')),
    exprs: [['cid', col(createdMaps.id, 'id')], ['mk', jsonText(col(createdMaps.id, MAP_COL))]] });
  const cf = make.join({ id: fresh('j'), left: umMin, right: ctMin, join: 'inner', on: eq(col(umMin.id, 'mk'), col(ctMin.id, 'mk')), channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('mk', 'text'), meta('cid', 'int'), meta('ct_mk', 'text')) });
  const createdFor = bind(make.project({ id: fresh('p'), input: cf, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(cf.id, ORD)] as const] : []), ['id', col(cf.id, 'cid')]] }), true);

  const result = emitMergeVertices(incoming, matched, createdFor, idsOf(matched, fresh),
    appended.length > 0 || matchWrites.length > 0, tailWrites, true, ordered, carriedCh, bind, guard, fresh, child);
  if (!result) return null;
  return { bindings: [...seeded.bindings, ...bindings], result };
}

/** The vtype tags an external vertex id carries when it is a ROWID (SQLite's integer storage class) —
 *  so a map endpoint value with one of these resolves against `nodes.id`, and anything else against the
 *  `uid`. The same rowid-vs-uid split `elementScan` draws from a value's JS type, drawn here from the
 *  stored `{t,v}` node's tag because the endpoint arrives as data in the driver's map. */
const NUMERIC_ID_VTYPES: readonly string[] = ['byte', 'short', 'int', 'long', 'bigint'];

/**
 * A map-VALUED merge driver for EDGES — `inject([T.label:…, (OUT):…, (IN):…]).mergeE()` /
 * `mergeE(__.identity())` / `select("m").mergeE()`, where the incoming TRAVERSER is the merge map
 * (`MergeElementStep.materializeMap` with the identity/no-arg map traversal). The map's entries are
 * decomposed PER DRIVER at runtime via `json_each` over `MAP_COL`, so the search — label, endpoints AND
 * property criteria — is DATA, not compile-time strings. `mergeVFromMap`'s shape on the edge host, with
 * `mergeEComputed`'s create/`crossed` machinery.
 *
 * **The whole map is the search AND the create source** (`onCreateTraversal == null` ⇒ `onCreateMap`
 * is the merge map, `MergeEdgeStep.onCreateMap:342`). So — unlike `mergeEComputed`, whose `project`
 * search admits only string keys — the endpoints and label narrow the search here:
 * `searchEdges` reads `T.label`→`hasLabel`, `Direction.OUT`→`outV().hasId`, `Direction.IN`→`inV().hasId`
 * and each string key→`has(k, v)` (`MergeEdgeStep.java:168-219`); the create needs BOTH endpoints (else
 * the reference's per-traverser raise, `:313-316`), the label (or `Edge.DEFAULT_LABEL`, `:320`) and the
 * string properties (`:324-330`). An endpoint is a vertex EXTERNAL id resolved to its rowid, raising
 * `Vertex does not exist for mergeE` when it names no vertex (`resolveVertex:398-409`).
 *
 * Deferred, fail-closed (each a `null` decline): a LIST-valued map (stored scalar vs JSON list never
 * compares equal); a `T.id` in the map (search/create by edge id — its own machinery, guarded below);
 * an `option(Merge.outV/inV)` or an `onCreate` endpoint over a map driver (endpoints come from the map
 * here); a RUNTIME arm value (roots at the map driver, needs a map host).
 */
export function mergeEFromMap(
  input: Rel, maps: MergeMaps, valOf: MapOf, propertySteps: readonly IRStep[],
  ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (valOf.kind !== 'scalar') return null;
  const { onCreate, onMatch } = maps;
  // An edge carries exactly ONE immutable label, so a label on `onMatch` is refused.
  if (onMatch?.label) return null;
  // Endpoints come from the DRIVER MAP's Direction keys; an option- or onCreate-supplied endpoint over a
  // map driver is a separate combination — decline rather than silently ignore it (fail closed).
  if (maps.outV !== undefined || maps.inV !== undefined) return null;
  if (onCreate?.outV !== undefined || onCreate?.inV !== undefined) return null;
  const matchWrites = mergeWrites(onMatch, 'edge', child);
  const createExtra = onCreate ? mergeWrites(onCreate, 'edge', child) : [];
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'edge', child) : [];
  if (!matchWrites || !createExtra || !tailWrites) return null;
  // A RUNTIME arm value roots at the map driver (no element id) — deferred, so constant arms only here.
  if (matchWrites.some((write) => write.kind === 'runtime') || createExtra.some((write) => write.kind === 'runtime')) return null;
  // The create's fallback label — `onCreate`'s single constant label if it named one, else the edge
  // default (`Edge.DEFAULT_LABEL`); the map's own `T.label` wins over it per driver (below). An edge
  // takes exactly one label, so a multi-name `onCreate` label declines.
  const onCreateLabels = ((onCreate?.label as string[] | null) ?? []);
  if (onCreateLabels.length > 1) return null;
  const fallbackLabel = onCreateLabels[0] ?? 'edge';
  try { validateLabel(fallbackLabel); } catch { return null; }

  const carriedCh = writeInputChannels(input);
  if (carriedCh.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  // ALWAYS snapshot — the search reads the map several times and the create needs a per-driver `ord` to
  // correlate its output back, both of which want a retained relation.
  const seeded = inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = bind(seeded.result, true, carriedCh);
  if (!incoming.type.cols.some((column) => column.name === MAP_COL)) return null; // not a map stream
  const hasOrd = incoming.type.cols.some((column) => column.name === ORD);

  // The four sides of a pair (`[keyNode, valNode]`, each a `{t,v}` node), and the key CLASS probes.
  const ext = (e: Expr, path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [e, compilerText(path)] });
  const jsonText = (e: Expr): Expr => ({ kind: 'call', fn: 'json', args: [e] });
  const keyT = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'keys'), '$.t');
  const keyV = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'keys'), '$.v');
  const valV = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'values'), '$.v');
  const valT = (p: Rel): Expr => ext(pairSide(col(p.id, PAIR.value), 'values'), '$.t');
  const isToken = (p: Rel, name: 'label' | 'id'): Expr => and(eq(keyT(p), compilerText('T')), eq(keyV(p), compilerText(name)));
  const isDir = (p: Rel, side: 'OUT' | 'IN'): Expr => and(eq(keyT(p), compilerText('D')), eq(keyV(p), compilerText(side)));

  // The carrier — the driver's map (and its `ord`), reprojected WITHOUT the channels, so every search
  // filter/join below is channel-free; `incoming` keeps the channels for the final `crossed`.
  const carrier0 = bind(make.project({
    id: fresh('cc'), input: incoming, channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta(MAP_COL, 'json')),
    exprs: [...(hasOrd ? [[ORD, col(incoming.id, ORD)] as const] : []), [MAP_COL, col(incoming.id, MAP_COL)]],
  }), true);
  const map0 = col(carrier0.id, MAP_COL);

  // FAIL CLOSED on a `T.id` in the map — search/create by edge id is its own machinery; until then a map
  // carrying it REFUSES rather than silently ignoring the id criterion (a wrong answer).
  const idProbe = pairsOf(map0, fresh);
  guard(make.limit({
    id: fresh('li'), channels: [], type: typeOf(meta('n', 'int')), count: compilerInt(1),
    input: make.project({ id: fresh('p'), channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', compilerInt(1)]],
      input: make.filter({ id: fresh('f'), input: carrier0, channels: [], type: carrier0.type,
        pred: { kind: 'exists', negated: false, plan: make.filter({ id: fresh('f'), input: idProbe, channels: [], type: idProbe.type, pred: isToken(idProbe, 'id') }) } }) }),
  }), { message: 'mergeE with a T.id in a map-valued driver is not yet supported', raiseWhen: 'rows' });

  // The map's `T.label` value as a per-row scalar (NULL when the map names none) — narrows the search and
  // labels the created edge.
  const mapLabelScalar = (mapCol: Expr): Expr => {
    const p = pairsOf(mapCol, fresh);
    const hits = make.filter({ id: fresh('f'), input: p, channels: [], type: p.type, pred: isToken(p, 'label') });
    return { kind: 'scalar', plan: make.limit({
      id: fresh('li'), channels: [], type: typeOf(meta('lbl', 'any', true)), count: compilerInt(1),
      input: make.project({ id: fresh('p'), input: hits, channels: [], type: typeOf(meta('lbl', 'any', true)), exprs: [['lbl', valV(hits)]] }) }) };
  };
  // Does the map carry this Direction key at all — the `containsKey(direction)` the create raise reads.
  const hasDir = (mapCol: Expr, side: 'OUT' | 'IN'): Expr => {
    const p = pairsOf(mapCol, fresh);
    return { kind: 'exists', negated: false, plan: make.filter({ id: fresh('f'), input: p, channels: [], type: p.type, pred: isDir(p, side) }) };
  };
  // The map's `Direction.OUT`/`Direction.IN` value RESOLVED to a vertex rowid — the external id matched
  // against `nodes.id` for a numeric-typed id, `nodes.uid` for a string one (`elementScan`'s provenance
  // rule, the value's stored tag standing in for its JS type). NULL when the map names no such endpoint
  // OR the id names no vertex — the two are told apart by `hasDir` above, so the missing-endpoint raise
  // and the missing-vertex raise stay distinct.
  const endpointRowid = (mapCol: Expr, side: 'OUT' | 'IN'): Expr => {
    const p = pairsOf(mapCol, fresh);
    const hits = make.filter({ id: fresh('f'), input: p, channels: [], type: p.type, pred: isDir(p, side) });
    const nodeScan = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('rn'), channels: [], type: typeOf(...NODES_COLS) });
    const numeric: Expr = { kind: 'in-list', expr: valT(hits), values: NUMERIC_ID_VTYPES.map((t) => compilerText(t)) };
    const match: Expr = { kind: 'case', whens: [[numeric, eq(col(nodeScan.id, 'id'), valV(hits))]], else: eq(col(nodeScan.id, 'uid'), valV(hits)) };
    const joined = make.join({ id: fresh('j'), left: hits, right: nodeScan, join: 'inner', on: match, channels: [],
      type: typeOf(...hits.type.cols, ...NODES_COLS) });
    const only = make.project({ id: fresh('p'), input: joined, channels: [], type: ID_TYPE, exprs: [['id', col(joined.id, 'id')]] });
    return { kind: 'scalar', plan: make.limit({ id: fresh('li'), input: only, channels: [], type: ID_TYPE, count: compilerInt(1) }) };
  };

  // The carrier's resolved per-driver facts: the map (passed through), its endpoints as rowids, whether
  // each Direction is present, and the label name. Every search/create reference below is a column, not a
  // repeated subquery.
  const carrier = bind(make.project({
    id: fresh('cc'), input: carrier0, channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta(MAP_COL, 'json'),
      meta('src', 'int', true), meta('tgt', 'int', true), meta('hasOut', 'int'), meta('hasIn', 'int'), meta('lbl', 'any', true)),
    exprs: [
      ...(hasOrd ? [[ORD, col(carrier0.id, ORD)] as const] : []),
      [MAP_COL, map0],
      ['src', endpointRowid(map0, 'OUT')], ['tgt', endpointRowid(map0, 'IN')],
      ['hasOut', { kind: 'case', whens: [[hasDir(map0, 'OUT'), compilerInt(1)]], else: compilerInt(0) }],
      ['hasIn', { kind: 'case', whens: [[hasDir(map0, 'IN'), compilerInt(1)]], else: compilerInt(0) }],
      ['lbl', mapLabelScalar(map0)],
    ],
  }), true);
  const driverMap = col(carrier.id, MAP_COL);

  // THE MATCH — every edge the driver's whole map is satisfied by: no STRING-key pair the candidate
  // lacks (dynamic-key EXISTS over `edge_properties`, vtype-aware), narrowed by the label (`hasLabel`),
  // the source endpoint (`edge.src`), and the target endpoint (`edge.tgt`) where the map named them.
  const candScan = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('ec'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  // Renamed so the search join's output names stay unique — the candidate's own endpoints/label do not
  // collide with the carrier's resolved `src`/`tgt`.
  const candidates = make.project({
    id: fresh('p'), input: candScan, channels: [], type: typeOf(meta('cid', 'int'), meta('csrc', 'int'), meta('clabel', 'int'), meta('ctgt', 'int')),
    exprs: [['cid', col(candScan.id, 'id')], ['csrc', col(candScan.id, 'src')], ['clabel', col(candScan.id, 'label')], ['ctgt', col(candScan.id, 'tgt')]],
  });
  const allMatch = (cand: Rel): Expr => {
    const candId = col(cand.id, 'cid');
    const pairs = pairsOf(driverMap, fresh);
    const spec = PROPERTY_TABLE.edge;
    const ep = make.scan({ id: fresh('ep'), table: spec.table, alias: fresh('rp'), channels: [], type: typeOf(...spec.cols) });
    const epMatch = make.filter({
      id: fresh('f'), input: ep, channels: [], type: ep.type,
      pred: and(and(eq(col(ep.id, spec.owner), candId), eq(col(ep.id, 'key'), keyV(pairs))),
        typedValueEq(col(ep.id, 'value'), col(ep.id, 'vtype'), valV(pairs), valT(pairs))),
    });
    const propProbe = make.project({ id: fresh('p'), input: epMatch, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    // A STRING-key pair the candidate FAILS. (A `T.label`/`Direction`/`T.id` pair cannot reach here — the
    // label/endpoints narrow via columns below, and a `T.id` was refused by the guard.)
    const unsat = make.filter({
      id: fresh('f'), input: pairs, channels: [], type: pairs.type,
      pred: and(eq(keyT(pairs), compilerText('string')), { kind: 'exists', negated: true, plan: propProbe }),
    });
    const propsOk: Expr = { kind: 'exists', negated: true, plan: unsat };
    // The label: no `T.label` in the map matches any label, else the candidate's label must be that name.
    const lblCol = col(carrier.id, 'lbl');
    const lb = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('rb'), channels: [], type: typeOf(...LABELS_COLS) });
    const lblFilter = make.filter({ id: fresh('f'), input: lb, channels: [], type: lb.type, pred: eq(col(lb.id, 'name'), lblCol) });
    const lblIds = make.project({ id: fresh('p'), input: lblFilter, channels: [], type: ID_TYPE, exprs: [['id', col(lblFilter.id, 'id')]] });
    const labelOk: Expr = or({ kind: 'binary', op: 'is', left: lblCol, right: compilerNull('text') },
      { kind: 'in-query', expr: col(cand.id, 'clabel'), plan: lblIds, negated: false });
    // The endpoints: a side the map did not name does not narrow; one it named must equal the candidate's.
    const outOk: Expr = or(eq(col(carrier.id, 'hasOut'), compilerInt(0)), eq(col(cand.id, 'csrc'), col(carrier.id, 'src')));
    const inOk: Expr = or(eq(col(carrier.id, 'hasIn'), compilerInt(0)), eq(col(cand.id, 'ctgt'), col(carrier.id, 'tgt')));
    return and(and(propsOk, labelOk), and(outOk, inOk));
  };
  const joined = make.join({
    id: fresh('j'), left: carrier, right: candidates, join: 'inner', on: allMatch(candidates), channels: [],
    type: typeOf(...carrier.type.cols, ...candidates.type.cols),
  });
  const matched = bind(make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(joined.id, ORD)] as const] : []), ['id', col(joined.id, 'cid')]],
  }), true);
  // ROWS THAT FOUND NOTHING — a carrier row whose `ord` has no matched row (or the single-row carrier
  // when `matched` is empty).
  const trueLit = eq(compilerInt(1), compilerInt(1));
  const unmatched = make.filter({
    id: fresh('f'), input: carrier, channels: [], type: carrier.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: hasOrd ? eq(col(matched.id, ORD), col(carrier.id, ORD)) : trueLit }) },
  });
  // ONE TRAVERSER AT A TIME, before any write — `mergeVFromMap`'s reading (the search's key set is DATA),
  // plus the endpoints: a later map's named side must be the earlier creation's.
  const mapCould = mapCouldMatch(onCreate, fresh);
  const sameSide = (earlier: RelId, later: RelId, has: string, side: string): Expr =>
    or(eq(col(later, has), compilerInt(0)), { kind: 'binary', op: 'is', left: col(earlier, side), right: col(later, side) });
  guardMergeInterleaving('mergeE', incoming, matched, {
    rel: unmatched,
    createKey: (rel) => ({ kind: 'call', fn: 'json_array', args: [col(rel, 'src'), col(rel, 'tgt'), jsonText(col(rel, MAP_COL))] }),
    couldMatch: (earlier, later) => and(mapCould(earlier, later), and(sameSide(earlier, later, 'hasOut', 'src'), sameSide(earlier, later, 'hasIn', 'tgt'))),
  }, { ...mergeWriteFacts('edge', matchWrites, [], tailWrites, null, propertySteps, child.writes), perDriverSearch: true }, bind, guard, fresh);
  // `onMatch` CONSTANT writes over the matched edges (runtime declined above). Empty on the create path.
  for (const write of matchWrites) if (!propertyStatements('edge', idsOf(matched, fresh), write, bind, fresh, child, NO_ALIASES, guard)) return null;
  if (matchWrites.length || tailWrites.length) bind(markDirty('edge', idsOf(matched, fresh), fresh));
  // THE CREATE RAISES, per driver whose search missed — the reference's three sentences, in its order:
  // OUT missing, then IN missing, then an endpoint that names no vertex (`MergeEdgeStep:313-319`).
  const raiseOn = (pred: Expr, message: string): void => {
    guard(make.limit({
      id: fresh('li'), channels: [], type: typeOf(meta('n', 'int')), count: compilerInt(1),
      input: make.project({ id: fresh('p'), channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', compilerInt(1)]],
        input: make.filter({ id: fresh('f'), input: unmatched, channels: [], type: unmatched.type, pred }) }),
    }), { message, raiseWhen: 'rows' });
  };
  const isNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is', left: e, right: compilerNull('int') });
  raiseOn(eq(col(unmatched.id, 'hasOut'), compilerInt(0)), 'Out Vertex not specified in onCreate - edge cannot be created');
  raiseOn(and(eq(col(unmatched.id, 'hasOut'), compilerInt(1)), eq(col(unmatched.id, 'hasIn'), compilerInt(0))), 'In Vertex not specified in onCreate - edge cannot be created');
  raiseOn(and(and(eq(col(unmatched.id, 'hasOut'), compilerInt(1)), eq(col(unmatched.id, 'hasIn'), compilerInt(1))),
    or(isNull(col(unmatched.id, 'src')), isNull(col(unmatched.id, 'tgt')))), 'Vertex does not exist for mergeE');

  // ONE EDGE PER DISTINCT `(src, tgt, map)` THAT FOUND NOTHING. The guards above abort the traversal
  // before this runs unless every unmatched row has both endpoints resolved, so `src`/`tgt` are non-null
  // for every wanted row.
  const wanted = bind(rowNumberWindow(make.distinct({
    id: fresh('d'), channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int'), meta(MAP_COL, 'json')),
    input: make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int'), meta(MAP_COL, 'json')),
      exprs: [['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')], [MAP_COL, col(unmatched.id, MAP_COL)]] }),
  }), 'word', [], { partitionBy: [], orderBy: [] }, fresh), true);

  // THE CREATED EDGE'S LABEL — the map's `T.label` per wanted row, else the fallback. Intern the DISTINCT
  // names (an upsert, data-sized over the wanted rows), then resolve each wanted row's label id by name.
  const wantedLbl = make.project({
    id: fresh('p'), input: wanted, channels: [], type: typeOf(meta('word', 'int'), meta('src', 'int'), meta('tgt', 'int'), meta(MAP_COL, 'json'), meta('name', 'text')),
    exprs: [['word', col(wanted.id, 'word')], ['src', col(wanted.id, 'src')], ['tgt', col(wanted.id, 'tgt')], [MAP_COL, col(wanted.id, MAP_COL)],
      ['name', { kind: 'call', fn: 'COALESCE', args: [mapLabelScalar(col(wanted.id, MAP_COL)), text(fallbackLabel)] }]],
  });
  const labelling = bind(wantedLbl, true);
  const distinctNames = make.distinct({ id: fresh('d'), channels: [], type: typeOf(meta('name', 'text')),
    input: make.project({ id: fresh('p'), input: labelling, channels: [], type: typeOf(meta('name', 'text')), exprs: [['name', col(labelling.id, 'name')]] }) });
  const labelsTable = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  bind(insert({ target: labelsTable, cols: ['name'], source: distinctNames, channels: [], type: typeOf(),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] }, returning: [] }));
  const lbLookup = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('rb'), channels: [], type: typeOf(...LABELS_COLS) });
  const withLid = make.join({ id: fresh('j'), left: labelling, right: lbLookup, join: 'inner', on: eq(col(labelling.id, 'name'), col(lbLookup.id, 'name')), channels: [],
    type: typeOf(meta('word', 'int'), meta('src', 'int'), meta('tgt', 'int'), meta(MAP_COL, 'json', true), meta('name', 'text'), meta('lid', 'int'), meta('lname', 'text')) });

  // THE CREATE — an edge per wanted tuple, in `word` order so the assigned rowids recover their tuple.
  const inOrder = make.sort({ id: fresh('so'), input: withLid, channels: [], type: withLid.type, terms: [{ expr: col(withLid.id, 'word'), dir: 'asc' }] });
  const rows = make.project({
    id: fresh('p'), input: inOrder, channels: [], type: typeOf(meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [['src', col(inOrder.id, 'src')], ['label', col(inOrder.id, 'lid')], ['tgt', col(inOrder.id, 'tgt')]],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const created = bind(insert({
    target: edgesTarget, cols: ['src', 'label', 'tgt'], source: rows, channels: [],
    type: typeOf(meta('id', 'int')), returning: [['id', col(edgesTarget.id, 'id')]],
  }));
  const rankedCreated = positioned(created, fresh);
  const createdTuples = bind(make.join({
    id: fresh('j'), left: rankedCreated, right: wanted, join: 'inner', on: eq(col(rankedCreated.id, ORD), col(wanted.id, 'word')), channels: [],
    type: typeOf(...rankedCreated.type.cols, ...wanted.type.cols),
  }), true);
  // WRITE THE MAP'S STRING PROPERTIES onto each created edge — one relational Insert over `json_each`:
  // explode each created edge's map into entries KEEPING the edge id, keep only string-key pairs (a
  // `T.label`/`Direction`/`T.id` token is not a property), and project `(edge, key, value, vtype)`.
  const { exploded } = explodeMembers(fenced(createdTuples, fresh), MAP_COL, PAIR, fresh);
  const propPairs = make.filter({ id: fresh('f'), input: exploded, channels: [], type: exploded.type,
    pred: eq(ext(pairSide(col(exploded.id, PAIR.value), 'keys'), '$.t'), compilerText('string')) });
  const propRows = make.project({
    id: fresh('p'), input: propPairs, channels: [],
    type: typeOf(meta('edge', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    exprs: [['edge', col(propPairs.id, 'id')], ['key', ext(pairSide(col(propPairs.id, PAIR.value), 'keys'), '$.v')],
      ['value', ext(pairSide(col(propPairs.id, PAIR.value), 'values'), '$.v')], ['vtype', ext(pairSide(col(propPairs.id, PAIR.value), 'values'), '$.t')]],
  });
  const propTarget = make.scan({ id: fresh('t'), table: PROPERTY_TABLE.edge.table, alias: fresh('wt'), channels: [], type: typeOf(...PROPERTY_TABLE.edge.cols) });
  bind(insert({ target: propTarget, cols: ['edge', 'key', 'value', 'vtype'], source: propRows, channels: [], type: WRITTEN_TYPE, returning: [['id', col(propTarget.id, 'id')], ['owner', col(propTarget.id, 'edge')]] }));
  // `onCreate`'s own CONSTANT properties, over the created edges (a shared key upserts, so `onCreate`
  // wins over the map's value written above).
  for (const write of createExtra) if (!propertyStatements('edge', idsOf(created, fresh), write, bind, fresh, child, NO_ALIASES, guard)) return null;

  // THE CREATED EDGE PER UNMATCHED DRIVER — join the driver's `(src, tgt, map)` to the created tuple's,
  // so the one edge made for a repeated tuple is carried by every driver that asked (`crossed` by `ord`).
  const umMin = make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('src', 'int'), meta('tgt', 'int'), meta('mk', 'text')),
    exprs: [...(hasOrd ? [[ORD, col(unmatched.id, ORD)] as const] : []), ['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')], ['mk', jsonText(col(unmatched.id, MAP_COL))]] });
  const ctMin = make.project({ id: fresh('p'), input: createdTuples, channels: [], type: typeOf(meta('cid', 'int'), meta('src', 'int'), meta('tgt', 'int'), meta('mk', 'text')),
    exprs: [['cid', col(createdTuples.id, 'id')], ['src', col(createdTuples.id, 'src')], ['tgt', col(createdTuples.id, 'tgt')], ['mk', jsonText(col(createdTuples.id, MAP_COL))]] });
  const cf = make.join({ id: fresh('j'), left: umMin, right: ctMin, join: 'inner',
    on: and(and(eq(col(umMin.id, 'src'), col(ctMin.id, 'src')), eq(col(umMin.id, 'tgt'), col(ctMin.id, 'tgt'))), eq(col(umMin.id, 'mk'), col(ctMin.id, 'mk'))), channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('src', 'int'), meta('tgt', 'int'), meta('mk', 'text'), meta('cid', 'int'), meta('ct_src', 'int'), meta('ct_tgt', 'int'), meta('ct_mk', 'text')) });
  const createdFor = bind(make.project({ id: fresh('p'), input: cf, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(cf.id, ORD)] as const] : []), ['id', col(cf.id, 'cid')]] }), true);

  // THE MERGED EDGES — matched ∪ created, the tail over the union, the whole crossed back onto the input.
  const merged = make.union({
    id: fresh('u'), all: true, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    inputs: [matched, createdFor],
  });
  const emitted = tailWrites.length ? bind(merged, true) : merged;
  for (const write of tailWrites) if (!propertyStatements('edge', idsOf(emitted, fresh), write, bind, fresh, child, NO_ALIASES, guard)) return null;
  return { bindings: [...seeded.bindings, ...bindings], result: crossed(incoming, emitted, carriedCh, ordered, fresh, true) };
}

export function elementMergeV(
  input: Rel, step: IRStep, options: readonly IRStep[], propertySteps: readonly IRStep[],
  driverElem: Elem | undefined, ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  let maps: MergeMaps;
  // `propertyWrites`' rule, one host up: a `Deferral` declines, a text-level ERROR was already
  // raised by the `writeArguments` verify Pass and cannot reach here (§6·5).
  try { maps = mergeMaps(step, options, 'mergeV', child.sideEffects, child.params); }
  catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
  const { match, onCreate, onMatch } = maps;
  // THE MAP-VALUED DRIVER (`mergeV()`/`mergeV(__.identity())`) is handled where the map value is in
  // scope — `mapTail` — because the driver IS a map, not an element. An element or scalar stream
  // reaching here with that form has no map to decompose (a vertex is not a Map), so it declines.
  if (maps.matchFromDriver) return null;
  for (const spec of [match, onCreate, onMatch]) {
    if (!spec) continue;
    // A nested LABEL/id (a per-driver element identity) and a nested KEY (a per-driver property key)
    // are the correlated-SEARCH surface, deferred. A nested VALUE is only a search criterion in the
    // MATCH map; in `onCreate`/`onMatch` it is a WRITE over the created/matched element, which the
    // runtime property path (`prepareRuntimeWrite`, over the merge's own owner relation) resolves.
    if (isNested(spec.id) || isNested(spec.label)) return null;
    if (Object.values(spec.propKeys).some(isNested)) return null;
  }
  if (Object.values(match.props).some(isNested)) return null;
  // A COMPUTED merge argument (`mergeV(__.project('k').by(__.body))`) — the search varies per driver, so
  // it takes the correlated path rather than the input-independent cross join below. A `property()` tail
  // and `option(onMatch/onCreate)` arms all compose: a constant write is element-agnostic, and a RUNTIME
  // arm value resolves at the DRIVER and lands per-driver on the vertex that driver matched/created
  // (`armValueWriteCorrelated`, correlated by `ord`). An explicit list/set arm cardinality on a runtime
  // value declines inside (fail closed).
  if (Object.keys(match.computed).length) return mergeVComputed(input, match, onCreate, onMatch, propertySteps, driverElem, ordered, child, fresh);
  // A SUPPLIED `T.id` — the SEARCH narrows by the merge argument's id (`searchVerticesTraversal` reads
  // `mergeMap.get(T.id)`), the CREATE writes `onCreate`'s id or, absent one, the merge argument's
  // (`onCreateMap` is their union) — and `validateNoOverrides` has already proved the two agree. A
  // non-scalar id is not a vertex id this route can place, so it declines rather than mis-executing.
  const searchId = idOrNull(match.id);
  const createId = idOrNull(onCreate?.id ?? match.id);
  if (searchId === false || createId === false) return null;
  // **A LABEL ON `onMatch` IS APPEND-ONLY `addLabel`, not a replacement** — the reference handles it
  // apart from every other entry and says so:
  // *"Handle T.label separately: append-only addLabel semantics for multi-label support"*
  // (`MergeVertexStep.java:106-113` → `ElementHelper.applyLabelsToVertex`, `.../util/ElementHelper.java:293-305`).
  // So it is `addLabel`'s statement over the MATCHED vertices, and an EMPTY collection is a no-op
  // rather than a clear — `applyLabelsToVertex` returns without touching the vertex (`:298`), which is
  // what `g_mergeVXlabel_person_name_markoX_optionXonMatch_label_emptyX` asserts.
  //
  // The refusals are `addLabel`'s and are asked HERE, before anything is built: a nested label declines
  // above, an immutable graph declines, and an invalid name is an ERROR rather than a write to skip.
  // No count guard is owed — every MUTABLE
  // cardinality has `max = Infinity`, so appending can never overstep it.
  const appended = [...new Set(((onMatch?.label as string[] | null) ?? []))];
  try { for (const name of appended) validateLabel(name); } catch { return null; }

  const matchWrites = mergeWrites(onMatch, 'vertex', child);
  // `onCreate` WINS per key, and `validateNoOverrides` has already proved the two cannot contradict —
  // so the spread is a merge of two agreeing maps, not a precedence rule this route invented.
  const createWrites = mergeWrites(onCreate ? {
    ...onCreate,
    props: { ...match.props, ...onCreate.props },
    propTypes: { ...match.propTypes, ...onCreate.propTypes },
    propCardinalities: { ...match.propCardinalities, ...onCreate.propCardinalities },
  } : match, 'vertex', child);
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'vertex', child) : [];
  if (!matchWrites || !createWrites || !tailWrites) return null;
  const createLabels = creationLabels(((onCreate?.label ?? match.label) as string[] | null) ?? [], child, fresh);
  if (!createLabels) return null;

  const searched = matching(searchId, (match.label as string[] | null) ?? [], Object.entries(match.props), child, fresh);
  if (!searched) return null;

  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carried) : input;

  // SNAPSHOTTED for two reasons at once, and either alone would be enough: the create is guarded by
  // this relation's emptiness and would otherwise be a predicate over the very table its own statement
  // inserts into (the `addV` trap, one level up); and every `onMatch` statement after the first has
  // already changed a property the search asked about.
  const matched = bind(idsOf(searched, fresh), true);
  // ONE TRAVERSER AT A TIME — the search is input-independent, so every driver misses together and a
  // later one would match the one creation (`guardMergeInterleaving`).
  guardMergeInterleaving('mergeV', incoming, matched, incoming.type.cols.some((column) => column.name === ORD) ? {
    rel: make.filter({
      id: fresh('f'), channels: [], type: typeOf(meta(ORD, 'int')), pred: { kind: 'exists', plan: matched, negated: true },
      input: make.project({ id: fresh('p'), input: incoming, channels: [], type: typeOf(meta(ORD, 'int')), exprs: [[ORD, col(incoming.id, ORD)]] }),
    }),
    createKey: null, couldMatch: null,
  } : null, { ...mergeWriteFacts('vertex', matchWrites, appended, tailWrites, new Set(Object.keys(match.props)), propertySteps, child.writes), perDriverSearch: false }, bind, guard, fresh);
  // IS THE CREATE ID STILL FREE — but only WHEN a create happens, which is `mergeV`'s whole difference
  // from `addV`'s unconditional guard. The search is by id (`hasId` above), so a MATCH already owns that
  // id and no collision is possible; a create runs only where the search came back empty, and collides
  // exactly when a NON-matching element already holds the id (a vertex with id 1 but the wrong label).
  // So the guard is `elementIdGuard`'s relation NARROWED by `NOT EXISTS <the match>`: it is non-empty
  // precisely on the create-and-collide case, and `raiseWhen: 'rows'` speaks the reference's sentence there.
  if (createId !== null) {
    const idTaken = elementIdGuard(createId, 'vertex', fresh);
    guard(make.filter({
      id: fresh('f'), input: idTaken.node, channels: [], type: idTaken.node.type,
      pred: { kind: 'exists', plan: matched, negated: true },
    }), idTaken.guard);
  }
  // `onMatch` over the MATCHED vertices — shared with the computed path (`applyMergeOnMatch`). An
  // `onMatch` RUNTIME value resolves at the DRIVER (`materializeMap(traverser)`, `MergeVertexStep.java:103`);
  // a constant search's matches are input-independent, so its runtime value is one rooted scalar
  // (`mergeArmValueWrite`) — the one host difference. (The rev touch moves to `emitMergeVertices` below.)
  if (!applyMergeOnMatch(matched, appended, matchWrites,
    (write) => mergeArmValueWrite(matched, incoming, write, driverElem, bind, fresh, child, NO_ALIASES),
    bind, guard, fresh, child)) return null;

  // ONE row off the input, because a create happens once however many traversers asked for it. The
  // incoming columns are dropped first: what the creation needs from it is its ROW COUNT, and
  // carrying an alias through `addVertex` as well would correlate the created row back to an incoming row
  // that the join below is about to cross it with anyway.
  // A `Limit` is channel-PRESERVING by contract (§3.5), so it declares the incoming relation's own list and the
  // projection below is where they are dropped — naming a shorter one here is the dropped-channel
  // defect the factory catches, and it caught this.
  const once = make.limit({
    id: fresh('lm'), input: incoming, channels: incoming.channels, type: incoming.type, count: compilerInt(1),
  });
  const absent = make.project({
    id: fresh('p'), input: once, channels: [], type: typeOf(meta('n', 'int')),
    exprs: [['n', compilerInt(1)]],
  });
  const creating = make.filter({
    id: fresh('f'), input: absent, channels: [], type: absent.type,
    pred: { kind: 'exists', plan: matched, negated: true },
  });
  // The creation supplies the merge's id (`onCreate`'s, else the merge argument's — `createId`), routed
  // to the rowid or `uid` column by `addVertex` exactly as `addV` does. The guard above has already made
  // a colliding id a clear raise, so the insert here only ever runs against a free one. A runtime tail
  // value that does not lower to a scalar declines the whole creation (`null`).
  // An `onCreate` RUNTIME value resolves at the DRIVER too (`onCreateMap(traverser)`,
  // `MergeVertexStep.java:153`), not at the created element — so the constant writes (the merge
  // criteria + any literal onCreate values) go through `addVertex`, and a runtime onCreate value is
  // written onto the created rows by `mergeArmValueWrite` afterward. `addV`'s own runtime values stay
  // element-rooted (its `AddPropertyStep` resolves at the created element), which is why this split is
  // the merge caller's, not `addVertex`'s.
  const createConst = createWrites.filter((write) => write.kind !== 'runtime');
  const createRuntime = createWrites.filter((write): write is PropertyRuntimeSet => write.kind === 'runtime');
  const created = addVertex(creating, createLabels.names, createId, createConst, false, bind, fresh, child, NO_ALIASES, guard);
  if (!created) return null;
  for (const write of createRuntime) if (!mergeArmValueWrite(created, incoming, write, driverElem, bind, fresh, child, NO_ALIASES)) return null;

  // THE MERGED ELEMENT(S) — the pre-write matches (`matched`) UNION the one creation, the tail run over
  // the union, the matched rev touched, and the whole crossed back onto the input. Shared with the
  // computed path (`emitMergeVertices`); the input-independent CROSS join (`correlate` false) is this
  // host's difference — every match pairs with every driver, upstream's per-traverser loop stated once.
  const result = emitMergeVertices(incoming, matched, idsOf(created, fresh), matched,
    appended.length > 0 || matchWrites.length > 0, tailWrites, false, ordered, carried, bind, guard, fresh, child);
  if (!result) return null;
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

// ---------- mergeE() ----------

/**
 * `mergeE(__.project('k').by(__.body))` — the CORRELATED edge merge SEARCH, criteria computed PER
 * DRIVER. `mergeVComputed`'s shape on the edge host: `MergeElementStep.materializeMap` runs the whole
 * map-producing traversal at the driver (`TraversalUtil.apply`,
 * `vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53`), so the search values are CONCRETE
 * per driver and the search is a literal `has(k, concreteValue)` chain over edges
 * (`.../step/map/MergeEdgeStep.java:218`). A per-driver CARRIER, a decorrelated equi-join (Calcite's
 * `RelDecorrelator` form — a projected column joined, never a LATERAL), one create per DISTINCT
 * `(endpoints, computed map)` that found nothing, and `crossed(…, correlate=true)`.
 *
 * **A `project` search map admits only STRING property keys** — no `Direction`/`T.label` token key — so
 * a computed edge search narrows by properties alone (every edge, then the computed criterion), never by
 * endpoints or label; those come from `option(onCreate, …)` for the CREATE, exactly where `elementMergeE`
 * reads them. A computed TOKEN key (endpoints/label per driver) is the general map-producing-traversal
 * case, deferred. An unproductive by-body OMITS its key for that driver (`ProjectStep.ifProductive`),
 * read as "does not narrow" — a bare `project` always emits a map, so there is no 0-result raise here.
 */
function mergeEComputed(
  input: Rel, maps: MergeMaps, match: MergeSpec, onCreate: MergeSpec | null, onMatch: MergeSpec | null,
  propertySteps: readonly IRStep[], aliases: AliasMap, driverElem: Elem | undefined,
  ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  const cKeys = Object.keys(match.computed);
  // An edge carries exactly ONE immutable label, so a label on `onMatch` is refused (as the constant
  // path refuses it) rather than a mutation this route may make.
  if (onMatch?.label) return null;
  // The search map is a `project`, so it names no `T.id`/`Direction`/`T.label`; the CREATE takes its id,
  // endpoints and label from `onCreate` — the same resolution `elementMergeE` does (with `match.*` here
  // always absent). A non-scalar id declines.
  const createId = idOrNull(onCreate?.id ?? match.id);
  if (createId === false) return null;
  const createOut = endpointSlot(onCreate?.outV, maps.outV, child, fresh);
  const createIn = endpointSlot(onCreate?.inV, maps.inV, child, fresh);
  if (createOut === null || createIn === null) return null;
  const creating = createOut !== undefined && createIn !== undefined;
  const labels = ((onCreate?.label ?? match.label) as string[] | null) ?? [];
  if (creating && labels.length !== 1) return null;

  // Edge properties are single-valued (no cardinality, no meta), which `mergeWrites`/`propertyWrites`
  // over `'edge'` already enforce.
  const matchWrites = mergeWrites(onMatch, 'edge', child);
  const createExtra = onCreate ? mergeWrites(onCreate, 'edge', child) : [];
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'edge', child) : [];
  if (!matchWrites || !createExtra || !tailWrites) return null;

  const carriedCh = writeInputChannels(input);
  if (carriedCh.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carriedCh) : input;
  const hasOrd = incoming.type.cols.some((column) => column.name === ORD);

  // THE CREATE ENDPOINTS, resolved per driver over `incoming` (endpoints first, so a missing vertex
  // refuses before anything is written) — `elementMergeE`'s `Endpoint` vocabulary verbatim.
  const src = createOut === undefined ? undefined : endpointExpr(createOut, incoming, aliases, fresh, guard);
  const tgt = createIn === undefined ? undefined : endpointExpr(createIn, incoming, aliases, fresh, guard);
  if ((createOut !== undefined && !src) || (createIn !== undefined && !tgt)) return null;

  // THE CARRIER — `mergeVComputed`'s per-key `(present, value, vtype)` triples PLUS this driver's create
  // endpoints, so one relation carries both the search criterion and what a miss would create. The value
  // body is rooted at the DRIVER (`driverElem`); a body that cannot state its productivity declines.
  const host: ChildHost = { kind: 'element', id: col(incoming.id, 'id'), elem: driverElem ?? 'vertex', row: { rel: incoming, aliases } };
  const litVtype = (e: Expr): string | null =>
    e.kind === 'lit' ? (e.type === 'text' ? 'string' : e.type === 'int' ? 'int' : e.type === 'real' ? 'double' : null) : null;
  const values: ChildValue[] = [];
  const pts: Expr[] = [];
  for (const key of cKeys) {
    const produced = child.scalar(match.computed[key]!, host);
    if (!produced || produced.framing.kind !== 'scalar' || produced.present === undefined) return null;
    const pt = produced.vtype
      ?? (produced.framing.kind === 'scalar' && produced.framing.type.kind === 'static' ? compilerText(String(produced.framing.type.type)) : null)
      ?? (litVtype(produced.expr) ? compilerText(litVtype(produced.expr)!) : null);
    if (!pt) return null;
    values.push(produced);
    pts.push(pt);
  }
  const ppCol = (i: number) => `pp${i}`, cvCol = (i: number) => `cv${i}`, ptCol = (i: number) => `pt${i}`;
  const gate = (present: Expr, e: Expr): Expr => ({ kind: 'case', whens: [[present, e]], else: compilerNull('text') });
  const tupleCols = cKeys.flatMap((_, i) => [meta(ppCol(i), 'int'), meta(cvCol(i), 'any', true), meta(ptCol(i), 'text', true)]);
  const endpointCols: readonly ColMeta[] = [...(src ? [meta('src', 'int')] : []), ...(tgt ? [meta('tgt', 'int')] : [])];
  const carrier = bind(make.project({
    id: fresh('cc'), input: incoming, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), ...endpointCols, ...tupleCols),
    exprs: [
      ...(hasOrd ? [[ORD, col(incoming.id, ORD)] as const] : []),
      ...(src ? [['src', src] as const] : []),
      ...(tgt ? [['tgt', tgt] as const] : []),
      ...cKeys.flatMap((_, i) => [
        [ppCol(i), { kind: 'case', whens: [[values[i]!.present!, compilerInt(1)]], else: compilerInt(0) } as Expr] as const,
        [cvCol(i), gate(values[i]!.present!, values[i]!.expr)] as const,
        [ptCol(i), gate(values[i]!.present!, pts[i]!)] as const,
      ]),
    ],
  }), true);
  // A per-driver identity over the computed MAP — two drivers create ONE edge iff their endpoints AND
  // maps are equal (the endpoints join the tuple key below).
  const tupleKey = (rel: RelId): Expr => ({ kind: 'call', fn: 'json_array', args: cKeys.flatMap((_, i) => [col(rel, ppCol(i)), col(rel, ptCol(i)), col(rel, cvCol(i))]) });

  // THE MATCH — every edge (the search map has no constant id/label/props), narrowed by every computed
  // criterion as a correlated EXISTS over the candidate edge's stored property, vtype-aware
  // (`typedValueEq` = `Compare.eq`). Endpoints do NOT narrow the search (`MergeEdgeStep` searches by the
  // MATCH map alone; `onCreate`'s endpoints are for the create). An unproductive key does not narrow.
  const candidates = edgeCriteria(null, null, [], child, fresh);
  if (!candidates) return null;
  const criterion = (candId: Expr, i: number): Expr => {
    const spec = PROPERTY_TABLE.edge;
    const scan = make.scan({ id: fresh('ep'), table: spec.table, alias: fresh('rp'), channels: [], type: typeOf(...spec.cols) });
    const matchedRows = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), candId), eq(col(scan.id, 'key'), compilerText(cKeys[i]!))),
        typedValueEq(col(scan.id, 'value'), col(scan.id, 'vtype'), col(carrier.id, cvCol(i)), col(carrier.id, ptCol(i)))),
    });
    const probe = make.project({ id: fresh('p'), input: matchedRows, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return or(eq(col(carrier.id, ppCol(i)), compilerInt(0)), { kind: 'exists', plan: probe, negated: false });
  };
  const conj = cKeys.map((_, i) => criterion(col(candidates.id, 'id'), i)).reduce((a, b) => and(a, b));
  const joined = make.join({
    id: fresh('j'), left: carrier, right: candidates, join: 'inner', on: conj, channels: [],
    type: typeOf(...carrier.type.cols, meta('id', 'int')),
  });
  const matched = bind(make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(joined.id, ORD)] as const] : []), ['id', col(joined.id, 'id')]],
  }), true);
  // `onMatch` over the MATCHED edges. A runtime EDGE arm value is declined upstream (`writeOf`, the
  // take-first edge path), so `matchWrites` is constant-only here — a computed mergeE whose onMatch holds
  // a `__.trav` value declines the whole merge (fail closed), the same deferral the inline edge path has.
  // Empty on the create path. (Run below, after the interleaving guard.)
  //
  // ROWS THAT FOUND NOTHING — carrier rows whose `ord` has no matched row (or the single-row carrier when
  // `matched` is empty).
  const trueLit = eq(compilerInt(1), compilerInt(1));
  const unmatched = make.filter({
    id: fresh('f'), input: carrier, channels: [], type: carrier.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: hasOrd ? eq(col(matched.id, ORD), col(carrier.id, ORD)) : trueLit }) },
  });
  // ONE TRAVERSER AT A TIME, before any write (`guardMergeInterleaving`). The search narrows by the computed
  // map ALONE — never the endpoints (`MergeEdgeStep.searchEdges(mergeMap)`, `MergeEdgeStep.java:264`) — so
  // two drivers with one map but different endpoints are one edge in the loop (the second MATCHES the
  // first's creation) and two here: the create key is the endpoints AND the map, as `wanted` dedupes them.
  guardMergeInterleaving('mergeE', incoming, matched, {
    rel: unmatched, couldMatch: computedCouldMatch(cKeys, onCreate, ppCol, cvCol, ptCol),
    createKey: (rel) => ({ kind: 'call', fn: 'json_array', args: [...(src ? [col(rel, 'src')] : []), ...(tgt ? [col(rel, 'tgt')] : []), tupleKey(rel)] }),
  }, { ...mergeWriteFacts('edge', matchWrites, [], tailWrites, new Set(cKeys), propertySteps, child.writes), perDriverSearch: true }, bind, guard, fresh);
  for (const write of matchWrites) if (!propertyStatements('edge', idsOf(matched, fresh), write, bind, fresh, child, aliases, guard)) return null;
  // Touch the rev of the matched edges whenever onMatch or the tail mutated them (created edges are born
  // dirty); an empty matched is a no-op. Before the create branch, so it covers the tail over `matched`.
  if (matchWrites.length || tailWrites.length) bind(markDirty('edge', idsOf(matched, fresh), fresh));

  // A SEARCH THAT MISSED WITH NO ENDPOINTS TO CREATE IS A RAISE, not a decline (`MergeEdgeStep` reaches
  // its endpoint check only after an empty search) — `raiseWhen: 'rows'` fires precisely on the rows that
  // found nothing, the reference's per-traverser sentence.
  if (!creating) {
    guard(make.limit({
      id: fresh('li'), channels: [], type: typeOf(meta('n', 'int')), count: compilerInt(1),
      input: make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta('n', 'int')), exprs: [['n', compilerInt(1)]] }),
    }), {
      message: `${createOut === undefined ? 'Out' : 'In'} Vertex not specified in onCreate - edge cannot be created`,
      raiseWhen: 'rows',
    });
    const found = tailWrites.length ? bind(matched, true) : matched;
    for (const write of tailWrites) if (!propertyStatements('edge', idsOf(found, fresh), write, bind, fresh, child, aliases, guard)) return null;
    return { bindings: [...(seeded?.bindings ?? []), ...bindings], result: crossed(incoming, found, carriedCh, ordered, fresh, true) };
  }

  // ONE EDGE PER DISTINCT `(src, tgt, computed map)` THAT FOUND NOTHING. Two drivers naming the same
  // endpoints AND the same map create one edge; a different map (or different endpoints) is a different
  // edge. `Distinct`'s NULL columns compare EQUAL, which the JSON key below handles for the equi-join.
  const wantedCols: readonly ColMeta[] = [meta('src', 'int'), meta('tgt', 'int'), ...tupleCols];
  const wanted = bind(rowNumberWindow(make.distinct({
    id: fresh('d'), channels: [], type: typeOf(...wantedCols),
    input: make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...wantedCols),
      exprs: [['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')],
        ...cKeys.flatMap((_, i) => [[ppCol(i), col(unmatched.id, ppCol(i))] as const, [cvCol(i), col(unmatched.id, cvCol(i))] as const, [ptCol(i), col(unmatched.id, ptCol(i))] as const])] }),
  }), 'word', [], { partitionBy: [], orderBy: [] }, fresh), true);
  // A SUPPLIED EDGE `T.id` collides two ways (as `elementMergeE`): taken while a create happens, and more
  // than one distinct edge wanting the one id.
  if (createId !== null) {
    const idTaken = elementIdGuard(createId, 'edge', fresh);
    guard(make.filter({
      id: fresh('f'), input: idTaken.node, channels: [], type: idTaken.node.type,
      pred: { kind: 'exists', plan: wanted, negated: false },
    }), idTaken.guard);
    const second = make.limit({ id: fresh('li'), input: wanted, channels: [], type: wanted.type, count: compilerInt(1), offset: compilerInt(1) });
    guard(make.project({ id: fresh('p'), input: second, channels: [], type: ID_TYPE, exprs: [['id', compilerInt(1)]] }), idTaken.guard);
  }

  // THE CREATE — an edge per wanted tuple, in `word` order so the assigned rowids recover their tuple.
  const labelRow = internLabels(labels.map(text), bind, fresh)!;
  const inOrder = make.sort({ id: fresh('so'), input: wanted, channels: wanted.channels, type: wanted.type, terms: [{ expr: col(wanted.id, 'word'), dir: 'asc' }] });
  const paired = make.join({
    id: fresh('j'), left: inOrder, right: labelRow, join: 'cross', channels: [],
    type: typeOf(...inOrder.type.cols, meta('lbl', 'int')),
  });
  const idCol = createId === null ? null : typeof createId === 'number' ? 'id' : 'uid';
  const idMeta = idCol === 'id' ? meta('id', 'int') : meta('uid', 'text', true);
  const idExpr: Expr | null = createId === null ? null : typeof createId === 'number' ? compilerInt(createId) : text(createId);
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [],
    type: typeOf(...(idCol ? [idMeta] : []), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [
      ...(idCol ? [[idCol, idExpr!] as const] : []),
      ['src', col(paired.id, 'src')], ['label', col(paired.id, 'lbl')], ['tgt', col(paired.id, 'tgt')],
    ],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const created = bind(insert({
    target: edgesTarget, cols: [...(idCol ? [idCol] : []), 'src', 'label', 'tgt'], source: rows, channels: [],
    type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('tgt', 'int')),
    returning: [['id', col(edgesTarget.id, 'id')], ['src', col(edgesTarget.id, 'src')], ['tgt', col(edgesTarget.id, 'tgt')]],
  }));
  // The created rows correlated back to their tuple by POSITION (rowid order = insertion order = `word`).
  // The created relation is projected to `id` alone first, so the positional join to `wanted` carries no
  // duplicate `src`/`tgt` column (a bare join names its type positionally).
  const createdIds = make.project({ id: fresh('p'), input: created, channels: [], type: ID_TYPE, exprs: [['id', col(created.id, 'id')]] });
  const rankedCreated = positioned(createdIds, fresh);
  const createdTuples = bind(make.join({
    id: fresh('j'), left: rankedCreated, right: wanted, join: 'inner', on: eq(col(rankedCreated.id, ORD), col(wanted.id, 'word')), channels: [],
    type: typeOf(...rankedCreated.type.cols, ...wanted.type.cols),
  }), true);
  // Write each PRESENT computed value onto its created edge (single-valued; FTS is the post-write
  // refresh's, a created edge is born dirty).
  for (let i = 0; i < cKeys.length; i++) {
    const spec = PROPERTY_TABLE.edge;
    const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const present = make.filter({ id: fresh('f'), input: createdTuples, channels: [], type: createdTuples.type, pred: eq(col(createdTuples.id, ppCol(i)), compilerInt(1)) });
    const rowsP = make.project({
      id: fresh('p'), input: present, channels: [], type: typeOf(meta('edge', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      exprs: [['edge', col(present.id, 'id')], ['key', compilerText(cKeys[i]!)], ['value', col(present.id, cvCol(i))], ['vtype', col(present.id, ptCol(i))]],
    });
    bind(insert({ target, cols: ['edge', 'key', 'value', 'vtype'], source: rowsP, channels: [], type: WRITTEN_TYPE, returning: [['id', col(target.id, 'id')], ['owner', col(target.id, spec.owner)]] }));
  }
  // `onCreate`'s own CONSTANT properties, over the created edges (its label already joined the creation;
  // a runtime onCreate edge value declines upstream, as onMatch's does). A shared key upserts, so
  // `onCreate` wins over the computed value written above.
  for (const write of createExtra) if (!propertyStatements('edge', idsOf(created, fresh), write, bind, fresh, child, aliases, guard)) return null;

  // THE CREATED EDGE PER UNMATCHED DRIVER — join the driver's `(src, tgt, tupleKey)` to the created
  // tuple's, so the one edge made for a repeated `(endpoints, map)` is carried by every driver that asked
  // (`crossed`'s equi-join by `ord`).
  const umMin = make.project({ id: fresh('p'), input: unmatched, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('src', 'int'), meta('tgt', 'int'), meta('tk', 'text')),
    exprs: [...(hasOrd ? [[ORD, col(unmatched.id, ORD)] as const] : []), ['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')], ['tk', tupleKey(unmatched.id)]] });
  const ctMin = make.project({ id: fresh('p'), input: createdTuples, channels: [], type: typeOf(meta('cid', 'int'), meta('src', 'int'), meta('tgt', 'int'), meta('tk', 'text')),
    exprs: [['cid', col(createdTuples.id, 'id')], ['src', col(createdTuples.id, 'src')], ['tgt', col(createdTuples.id, 'tgt')], ['tk', tupleKey(createdTuples.id)]] });
  const cf = make.join({ id: fresh('j'), left: umMin, right: ctMin, join: 'inner',
    on: and(and(eq(col(umMin.id, 'src'), col(ctMin.id, 'src')), eq(col(umMin.id, 'tgt'), col(ctMin.id, 'tgt'))), eq(col(umMin.id, 'tk'), col(ctMin.id, 'tk'))), channels: [],
    type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('src', 'int'), meta('tgt', 'int'), meta('tk', 'text'), meta('cid', 'int'), meta('ct_src', 'int'), meta('ct_tgt', 'int'), meta('ct_tk', 'text')) });
  const createdFor = bind(make.project({ id: fresh('p'), input: cf, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    exprs: [...(hasOrd ? [[ORD, col(cf.id, ORD)] as const] : []), ['id', col(cf.id, 'cid')]] }), true);

  // THE MERGED EDGES — matched ∪ created, the tail over the union, the whole crossed back onto the input.
  const merged = make.union({
    id: fresh('u'), all: true, channels: [], type: typeOf(...(hasOrd ? [meta(ORD, 'int')] : []), meta('id', 'int')),
    inputs: [matched, createdFor],
  });
  const emitted = tailWrites.length ? bind(merged, true) : merged;
  for (const write of tailWrites) if (!propertyStatements('edge', idsOf(emitted, fresh), write, bind, fresh, child, aliases, guard)) return null;
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result: crossed(incoming, emitted, carriedCh, ordered, fresh, true) };
}

/**
 * `mergeE(map)` with its `option()` arms and the `property()` run after them — the edge upsert.
 *
 * It is `mergeV`'s shape with ENDPOINTS, and everything `mergeV`'s comment says about the branch not
 * being control flow holds unchanged: the `onMatch` writes run over the MATCH relation (empty on the
 * create path, so they write nothing) and the create runs over a source guarded by
 * `NOT EXISTS <the match>` (empty on the match path, so it inserts nothing).
 *
 * ## THE SEARCH IS `E().hasLabel(l).has(k, v)` NARROWED BY THE ENDPOINTS
 *
 * The label and property criteria go back to the READ FOLD as the steps they are, exactly as
 * `mergeV`'s do and for the same reason — one authority for what `has()` finds, so the merge cannot
 * drift from it. What `has()` has no spelling for is `src`/`tgt`, so the endpoints are an ordinary
 * predicate over the `edges` scan and the fold's answer arrives as an `IN` over its ids. Two halves,
 * neither of them a second predicate vocabulary.
 *
 * ## AN ENDPOINT IS EITHER A CONSTANT OR THE INCOMING TRAVERSER, AND ONE SHAPE SERVES BOTH
 *
 * `Merge.outV`/`Merge.inV` in a slot means "the vertex that arrived here", so with one of them the
 * search VARIES per input row and `mergeV`'s input-independent cross join is the wrong correlation.
 * The tempting read is that these are two lowerings. They are one, and the thing that unifies them is
 * carrying the endpoint PAIR beside each incoming row:
 *
 * - **the match** joins those pairs to `edges` on `(src, tgt)`, so it comes back as `(ord, id)` —
 *   which row asked, and what it found;
 * - **the create** inserts one edge per DISTINCT pair that found nothing, and its `RETURNING`
 *   projects `src` and `tgt` alongside the id, so the created edges JOIN BACK BY VALUE.
 *
 * That last point is why there is no positional correlation here and no P5b dance: an `Insert`'s
 * `RETURNING` normally says nothing about which input row produced a row, but an edge's endpoints ARE
 * the correlation key. **`Distinct` over the pair is what makes duplicates right rather than lucky**:
 * two traversers naming the same endpoints get ONE edge and two traversers, which is upstream's
 * second loop iteration matching what its first one created. A constant-endpoint merge is the
 * degenerate case of exactly that — every row carries the same pair, so `Distinct` leaves one, and
 * the `LIMIT 1` the mergeV shape needs is not a rule this has to state.
 *
 * ## WHAT DECLINES, and why each is not a wrong answer
 *
 * - **no label anywhere** and **more than one** — declined; the reference raises
 *   `mergeE cannot create an edge without a label` / `an edge takes exactly one label`.
 * - **`T.id` IS SUPPORTED** — the search narrows by it (`hasId` in `edgeCriteria`), the create routes it
 *   to the rowid/`uid` column (`elementAddE`'s plumbing), and TWO guards raise the reference's "already
 *   exists" on collision (id taken on the create branch; two distinct pairs claiming one id). A nested or
 *   non-scalar id declines, as on `addE`.
 * - **an incoming endpoint over a non-VERTEX stream, or at the source** — there is no traverser to
 *   be an endpoint. `MergeEdgeStep` raises `Out Vertex not specified in onCreate`, so declining
 *   defers to that message rather than inventing a second.
 * - **a cardinality or meta on an edge property** — TinkerPop's edge `Property` has neither, and
 *   `writeOf` is the one place that says so.
 */
export function elementMergeE(
  input: Rel, step: IRStep, options: readonly IRStep[], propertySteps: readonly IRStep[],
  aliases: AliasMap, driverElem: Elem | undefined, ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  let maps: MergeMaps;
  // `elementMergeV`'s rule: a `Deferral` declines, a text-level ERROR was raised by the
  // `writeArguments` verify Pass and cannot reach here (§6·5).
  try { maps = mergeMaps(step, options, 'mergeE', child.sideEffects, child.params); }
  catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
  const { match, onCreate, onMatch } = maps;
  // The map-VALUED driver is `mapTail`'s (the map is not an element); an element/scalar driver has no
  // map here. (Edge map-valued merge is a later sub-increment; for now it declines everywhere.)
  if (maps.matchFromDriver) return null;
  for (const spec of [match, onCreate, onMatch]) {
    if (!spec) continue;
    if (isNested(spec.id) || isNested(spec.label)) return null;
    if (Object.values(spec.props).some(isNested) || Object.values(spec.propKeys).some(isNested)) return null;
  }
  // A COMPUTED merge argument (`mergeE(__.project('k').by(__.body))`) — the search criterion varies per
  // driver, so it takes the correlated path rather than `edgeCriteria`'s input-independent constant read
  // below (which reads only `match.props` and would DROP the computed criterion — a wrong answer). The
  // create's endpoints/label come from `option(onCreate, …)`, since a `project` search map admits no
  // Direction/T.label token key. `property()` tails and `option(onMatch/onCreate)` arms all compose.
  if (Object.keys(match.computed).length) return mergeEComputed(input, maps, match, onCreate, onMatch, propertySteps, aliases, driverElem, ordered, child, fresh);
  // An edge carries exactly ONE label and it is fixed at creation, so a label on `onMatch` is not a
  // mutation this route may make — it is one the reference refuses outright.
  if (onMatch?.label) return null;
  // A SUPPLIED `T.id`, the same three roles it has on `mergeV`: the SEARCH narrows by the merge
  // argument's id (`searchEdges` reads `mergeMap.get(T.id)`), the CREATE writes `onCreate`'s id or the
  // merge argument's, and a non-scalar id declines. The create's collision refusal is TWO guards below,
  // because an edge id can collide two ways a vertex id cannot (below).
  const searchId = idOrNull(match.id);
  const createId = idOrNull(onCreate?.id ?? match.id);
  if (searchId === false || createId === false) return null;

  // **THE SEARCH READS THE MERGE MAP AND ONLY THE MERGE MAP.** `searchEdges` is handed the resolved
  // MATCH map alone, and `onCreateMap` is built afterwards and only once the search came back empty
  // (`MergeEdgeStep.flatMap`, gremlin-core `.../step/map/MergeEdgeStep.java:258-311`). So an endpoint
  // or a label that exists ONLY on `option(onCreate, …)` narrows NOTHING — reading the union here made
  // `mergeE([(T.label):'knows']).option(onCreate, [(OUT):1,(IN):2])` search for a 1→2 edge where the
  // reference searches every `knows` edge, and then CREATE a duplicate whenever one existed elsewhere.
  // A wrong answer, and one no scenario named: only the reference could see it.
  const matchOut = endpointSlot(match.outV, maps.outV, child, fresh);
  const matchIn = endpointSlot(match.inV, maps.inV, child, fresh);
  if (matchOut === null || matchIn === null) return null;
  const createOut = matchOut ?? endpointSlot(onCreate?.outV, maps.outV, child, fresh);
  const createIn = matchIn ?? endpointSlot(onCreate?.inV, maps.inV, child, fresh);
  if (createOut === null || createIn === null) return null;

  // A CREATE NEEDS BOTH ENDS, and a map that supplies neither is NOT a refusal to compile: the search
  // still runs (`g.E()` narrowed by whatever the map did give), and the reference raises only where it
  // came back empty (`:312-316`). That is a GUARD BINDING, so `g.mergeE([:])` answers the edge it finds
  // and raises the reference's sentence exactly when there is none.
  const creating = createOut !== undefined && createIn !== undefined;
  // The SEARCH's label is the match map's; the CREATE's may come from `onCreate`. One name for both is
  // the same conflation as the endpoints, one field over.
  const searchLabels = (match.label as string[] | null) ?? [];
  const labels = ((onCreate?.label ?? match.label) as string[] | null) ?? [];
  if (searchLabels.length > 1) return null;
  if (creating && labels.length !== 1) return null;

  const matchWrites = mergeWrites(onMatch, 'edge', child);
  // `onCreate` WINS per key, and `validateNoOverrides` has already proved the two cannot contradict.
  const createWrites = mergeWrites(onCreate ? {
    ...onCreate,
    props: { ...match.props, ...onCreate.props },
    propTypes: { ...match.propTypes, ...onCreate.propTypes },
    propCardinalities: { ...match.propCardinalities, ...onCreate.propCardinalities },
  } : match, 'edge', child);
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'edge', child) : [];
  if (!matchWrites || !createWrites || !tailWrites) return null;

  // **THERE IS NO `traverser` ENDPOINT ON THIS STEP, and that is `MergeEdgeStep`'s rule rather than a
  // limitation of ours.** `resolveVertex` returns immediately when the map has no `Direction` key
  // ("no Direction specified in the map, nothing to resolve", `:232-234`), so an omitted endpoint is
  // NOT the incoming traverser the way `addE`'s is — it simply drops out of the search. `endpointOf`
  // accordingly never yields `{kind:'traverser'}` here, which is why this step takes NO element kind:
  // the incoming stream's KIND cannot change its answer, and a scalar one is as legal as a vertex one.
  // The parameter it used to take guarded a case that could not arise, and the guard's presence read
  // as evidence that it could.
  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = writeSnapshot(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carried) : input;

  // THE ENDPOINTS FIRST, so a missing vertex refuses before anything is written. The vocabulary is
  // `addE`'s `Endpoint` — an alias, a rooted read, the incoming traverser, a public id — because a
  // merge's endpoints and a creation's ARE the same four things under different spellings.
  const src = createOut === undefined ? undefined : endpointExpr(createOut, incoming, aliases, fresh, guard);
  const tgt = createIn === undefined ? undefined : endpointExpr(createIn, incoming, aliases, fresh, guard);
  if ((createOut !== undefined && !src) || (createIn !== undefined && !tgt)) return null;
  // EVERY ROW CARRIES ITS OWN PAIR, whether or not the pair varies — which is what lets the constant
  // and incoming cases be one lowering rather than two. `ord` names the row that asked; a source seed
  // has no position of its own and is one row, so a literal is the honest answer for it.
  //
  // A SIDE THE MAP NEVER MENTIONED HAS NO COLUMN AT ALL, rather than a nullable one: whether it is
  // there is a COMPILE-TIME fact, so a NULL would only be a value the join and the insert both have
  // to remember not to trust.
  const position: Expr = incoming.type.cols.some((column) => column.name === ORD) ? col(incoming.id, ORD) : compilerInt(1);
  const pairCols: readonly ColMeta[] = [meta(ORD, 'int'),
    ...(src ? [meta('src', 'int')] : []), ...(tgt ? [meta('tgt', 'int')] : [])];
  const pairs = bind(make.project({
    id: fresh('p'), input: incoming, channels: [], type: typeOf(...pairCols),
    exprs: [[ORD, position], ...(src ? [['src', src] as const] : []), ...(tgt ? [['tgt', tgt] as const] : [])],
  }), true);

  const criteria = edgeCriteria(searchId, searchLabels[0] ?? null, Object.entries(match.props), child, fresh);
  if (!criteria) return null;
  // SNAPSHOTTED for `mergeV`'s two reasons at once: the create is guarded by this relation's
  // emptiness and would otherwise read the very table its own statement inserts into, and an
  // `onMatch` write can change a property the search asked about.
  const matched = bind(pairedWith(pairs, criteria, { bySrc: matchOut !== undefined, byTgt: matchIn !== undefined }, fresh), true);

  // ONE EDGE PER DISTINCT PAIR THAT FOUND NOTHING. `Distinct` is the whole duplicate rule: two
  // traversers naming the same endpoints create one edge between them and both carry it away.
  const unmatched = make.filter({
    id: fresh('f'), input: pairs, channels: [], type: pairs.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: eq(col(matched.id, ORD), col(pairs.id, ORD)),
    }) },
  });
  // ONE TRAVERSER AT A TIME, before any write. The SEARCH key is the endpoints the search narrows by
  // (none ⇒ every driver's search finds every creation); the CREATE key is the pair `wanted` dedupes.
  type Side = 'src' | 'tgt';
  const createSides: Side[] = [...(src ? ['src' as const] : []), ...(tgt ? ['tgt' as const] : [])];
  const searchSides: Side[] = [...(matchOut !== undefined ? ['src' as const] : []), ...(matchIn !== undefined ? ['tgt' as const] : [])];
  guardMergeInterleaving('mergeE', incoming, matched, creating ? {
    rel: unmatched,
    createKey: createSides.length ? (rel) => ({ kind: 'call', fn: 'json_array', args: createSides.map((side) => col(rel, side)) }) : null,
    couldMatch: searchSides.length
      ? (earlier, later) => searchSides.map((side) => eq(col(earlier, side), col(later, side))).reduce((a, b) => and(a, b))
      : null,
  } : null, { ...mergeWriteFacts('edge', matchWrites, [], tailWrites, new Set(Object.keys(match.props)), propertySteps, child.writes), perDriverSearch: false }, bind, guard, fresh);
  for (const write of matchWrites) if (!propertyStatements('edge', idsOf(matched, fresh), write, bind, fresh, child, aliases, guard)) return null;
  // Touch the rev of the MATCHED (existing) edges whenever onMatch or the tail `property()` run mutated
  // them (§5·1); created edges are born dirty, and an empty `matched` is a no-op. Placed before the
  // create/match branch, so it covers the tail writes both branches run over the matched subset.
  if (matchWrites.length || tailWrites.length) bind(markDirty('edge', idsOf(matched, fresh), fresh));

  // **A CREATE THE MAP CANNOT DESCRIBE IS A GUARD, NOT A DECLINE** (§6·5). `MergeEdgeStep` reaches its
  // endpoint check only after the search came back empty, so the refusal is per ROW and arithmetic over
  // the data: `unmatched` is exactly the rows that found nothing, so `raiseWhen: 'rows'` fires precisely
  // where the reference's loop would. `g.mergeE([:])` therefore ANSWERS the edge it finds and raises
  // only when there is none, which is the pair of scenarios `MergeEdge.feature` states side by side
  // (`g_mergeEXemptyX_exists` counts 1; `g_mergeEXemptyX` raises).
  //
  // OUT is tested before IN because the reference tests it first (`:312-315`) and the two sentences
  // differ; a map missing both must say the same thing upstream says.
  if (!creating) {
    guard(make.limit({
      id: fresh('li'), channels: [], type: typeOf(meta(ORD, 'int')), count: compilerInt(1),
      input: make.project({
        id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta(ORD, 'int')),
        exprs: [[ORD, col(unmatched.id, ORD)]],
      }),
    }), {
      message: `${createOut === undefined ? 'Out' : 'In'} Vertex not specified in onCreate - edge cannot be created`,
      raiseWhen: 'rows',
    });
    const found = tailWrites.length ? bind(matched, true) : matched;
    for (const write of tailWrites) if (!propertyStatements('edge', idsOf(found, fresh), write, bind, fresh, child, aliases, guard)) return null;
    return { bindings: [...(seeded?.bindings ?? []), ...bindings], result: crossed(incoming, found, carried, ordered, fresh, true) };
  }
  const wantedRel = make.distinct({
    id: fresh('d'), channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int')),
    input: make.project({
      id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int')),
      exprs: [['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')]],
    }),
  });
  // A SUPPLIED EDGE `T.id` reads `wanted` from THREE places — the create insert and both collision
  // guards — so it is a SNAPSHOT (retained, read once), not a plain CTE `checkSnapshots` would refuse
  // three readers of. Absent an id it stays a plain relation feeding the one insert, so the no-id path
  // is byte-identical.
  const wanted = createId === null ? wantedRel : bind(wantedRel, true);
  // AN EDGE ID COLLIDES TWO WAYS, and both are arithmetic over the data an `Insert` cannot state — one
  // more than `mergeV`'s single conditional guard, because an edge is created per DISTINCT endpoint pair:
  //  - **the id is TAKEN while a create happens** — `wanted` non-empty means the search (which narrows by
  //    the id, `hasId` above) came back empty for some pair, so an existing edge with that id would have
  //    matched; creating against it collides. `elementIdGuard` NARROWED by `EXISTS <wanted>` — `mergeV`'s
  //    conditional guard, on the edge host.
  //  - **more than ONE distinct pair wants creating** — one supplied id cannot label two edges, so a
  //    second `wanted` row is the collision `addE` raises on its second input row. `Limit{offset:1}` is
  //    the "is there a second" test, column-agnostic exactly as `addE`'s is.
  if (createId !== null) {
    const idTaken = elementIdGuard(createId, 'edge', fresh);
    guard(make.filter({
      id: fresh('f'), input: idTaken.node, channels: [], type: idTaken.node.type,
      pred: { kind: 'exists', plan: wanted, negated: false },
    }), idTaken.guard);
    const second = make.limit({
      id: fresh('li'), input: wanted, channels: [], type: wanted.type, count: compilerInt(1), offset: compilerInt(1),
    });
    guard(make.project({ id: fresh('p'), input: second, channels: [], type: ID_TYPE, exprs: [['id', compilerInt(1)]] }), idTaken.guard);
  }
  const labelRow = internLabels(labels.map(text), bind, fresh)!;
  const paired = make.join({
    id: fresh('j'), left: wanted, right: labelRow, join: 'cross', channels: [],
    type: typeOf(meta('src', 'int'), meta('tgt', 'int'), meta('lbl', 'int')),
  });
  // A CALLER-SUPPLIED PUBLIC ID lands in one of two columns and the choice is the value's own type,
  // exactly as `elementAddE` spells it for `edges`: a NUMBER is the rowid, a STRING is the `uid`. Absent,
  // the row names neither and takes whatever rowid SQLite assigns. The guards above have already made a
  // collision a clear raise, so the insert here only ever runs against a free id.
  const idCol = createId === null ? null : typeof createId === 'number' ? 'id' : 'uid';
  const idMeta = idCol === 'id' ? meta('id', 'int') : meta('uid', 'text', true);
  const idExpr: Expr | null = createId === null ? null : typeof createId === 'number' ? compilerInt(createId) : text(createId);
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [],
    type: typeOf(...(idCol ? [idMeta] : []), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [
      ...(idCol ? [[idCol, idExpr!] as const] : []),
      ['src', col(paired.id, 'src')], ['label', col(paired.id, 'lbl')], ['tgt', col(paired.id, 'tgt')],
    ],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  // THE `RETURNING` PROJECTS THE ENDPOINTS, and that is what replaces a positional correlation: an
  // edge's `(src, tgt)` IS the key its input rows are found by, so nothing depends on the order the
  // created rows come back in (P5b's hazard does not arise) or on a spare column to carry.
  const created = bind(insert({
    target: edgesTarget, cols: [...(idCol ? [idCol] : []), 'src', 'label', 'tgt'], source: rows, channels: [],
    type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('tgt', 'int')),
    returning: [['id', col(edgesTarget.id, 'id')], ['src', col(edgesTarget.id, 'src')], ['tgt', col(edgesTarget.id, 'tgt')]],
  }));
  for (const write of createWrites) if (!propertyStatements('edge', idsOf(created, fresh), write, bind, fresh, child, aliases, guard)) return null;

  const createdFor = make.join({
    id: fresh('j'), left: pairs, right: created, join: 'inner', channels: [],
    type: typeOf(meta(ORD, 'int'), meta('src', 'int'), meta('tgt', 'int'), meta('id', 'int'), meta('csrc', 'int'), meta('ctgt', 'int')),
    on: and(eq(col(pairs.id, 'src'), col(created.id, 'src')), eq(col(pairs.id, 'tgt'), col(created.id, 'tgt'))),
  });
  // Exactly one branch produced any given (row, edge), so a UNION ALL states "whichever happened".
  const merged = make.union({
    id: fresh('u'), all: true, channels: [], type: typeOf(meta(ORD, 'int'), meta('id', 'int')),
    inputs: [
      matched,
      make.project({
        id: fresh('p'), input: createdFor, channels: [], type: typeOf(meta(ORD, 'int'), meta('id', 'int')),
        exprs: [[ORD, col(createdFor.id, ORD)], ['id', col(createdFor.id, 'id')]],
      }),
    ],
  });
  const emitted = tailWrites.length ? bind(merged, true) : merged;
  for (const write of tailWrites) if (!propertyStatements('edge', idsOf(emitted, fresh), write, bind, fresh, child, aliases, guard)) return null;

  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result: crossed(incoming, emitted, carried, ordered, fresh, true) };
}

/**
 * A merge map's endpoint slot, resolved to the shared `Endpoint` vocabulary — or `null` to decline.
 *
 * Two rules, both `MergeEdgeStep`'s and neither symmetric with the property maps:
 *
 * - **the merge argument's slot wins, and `onCreate` supplies one it left out.** `undefined` from
 *   `null` therefore matters: a slot the map never mentioned falls through, a slot naming something
 *   unusable is a decline.
 * - **a `Merge.outV`/`Merge.inV` TOKEN is a reference to `option(Merge.outV, …)`, not to the
 *   incoming traverser** (`resolveVertex`, gremlin-core .../step/map/MergeEdgeStep.java:231-251).
 *   The option is guaranteed present — `mergeMaps` raises otherwise, from the verify Pass — so the
 *   token simply redirects to it. Reading it as "the current traverser" was the earlier reading, and
 *   it is a wrong ANSWER wherever the option names a different vertex; `option(outV,
 *   select("x")).option(inV, select("y"))` over two aliased vertices is exactly that traversal.
 *
 * The option's own value goes through `endpointOf`, so an alias, a rooted read and a public id all
 * arrive already spelled the way `endpointExpr` reads them.
 */
function endpointSlot(
  named: unknown, option: unknown, child: ChildSeam, fresh: Minter,
): Endpoint | undefined | null {
  // THREE ANSWERS, and collapsing the first two is what tied the search to the create: `undefined` is
  // "this map never mentioned the side", which the reference reads as "do not narrow by it"; `null` is
  // "mentioned, and this route cannot express it", which is a decline.
  if (named === undefined) return undefined;
  if (named !== null && typeof named === 'object' && (named as { incoming?: unknown }).incoming !== undefined)
    return option === undefined ? null : endpointOf(option, child, fresh, true);
  return typeof named === 'string' || typeof named === 'number' ? { kind: 'vertex', uid: named } : null;
}

/**
 * A public vertex id as the ROWID an edge row stores, behind the guard that says it exists.
 *
 * `resolveMergeEndpoint` asks exactly this and raises exactly this message; the guard binding is what
 * lets the algebra raise it too instead of declining the whole traversal for it (§6·5). The scalar
 * subquery and the guard read the SAME relation, so the value written and the value checked cannot
 * come apart.
 */
function endpointRowid(uid: string | number, guard: Guarder, fresh: Minter): Expr {
  const scan = make.scan({
    id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [],
    type: typeOf(meta('id', 'int'), meta('uid', 'text', true)),
  });
  const found = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: typeof uid === 'number' ? eq(col(scan.id, 'id'), compilerInt(uid)) : eq(col(scan.id, 'uid'), text(uid)),
  });
  const only = make.project({ id: fresh('p'), input: found, channels: [], type: ID_TYPE, exprs: [['id', col(found.id, 'id')]] });
  guard(make.limit({ id: fresh('li'), input: only, channels: [], type: ID_TYPE, count: compilerInt(1) }),
    { message: 'Vertex does not exist for mergeE', raiseWhen: 'empty' });
  return { kind: 'scalar', plan: only };
}

/**
 * THE EDGES A MERGE MAP'S LABEL AND PROPERTIES ADMIT — through the read fold, as the steps they are.
 *
 * The endpoints are deliberately NOT here: `hasLabel`/`has` are what `E()` already answers, while
 * `src`/`tgt` are COLUMNS no step names, so the two halves meet in `pairedWith` instead of one of
 * them being re-expressed. What that buys is `mergeV`'s property — the merge inherits whatever `has()`
 * learns next, and a divergence between "what mergeE searches for" and "what has() finds" is not
 * expressible.
 */
function edgeCriteria(
  id: string | number | null,
  label: string | null, props: readonly (readonly [string, import('../../gremlin/frontend.ts').ArgValue])[], child: ChildSeam, fresh: Minter,
): Rel | null {
  const read = child.rooted([
    { name: 'E', args: [] },
    // A supplied `T.id` is `searchEdges`' `g.E(eid)` narrowing, spelled as `hasId(eid)` — the endpoints
    // it also narrows by (`where(outV().hasId(…))` upstream) stay in `pairedWith`, so this is only the
    // id-and-label-and-property half of the search, read through the same fold `g.E().has(T.id,…)` uses.
    ...(id === null ? [] : [{ name: 'hasId', args: [arg(id)] }]),
    // A map with no `T.label` searches EVERY edge — `searchEdges` adds `hasLabel` only when the label
    // is non-null, so an absent one is one fewer step rather than a different chain.
    ...(label === null ? [] : [{ name: 'hasLabel', args: [arg(label)] }]),
    ...props.map(([key, value]) => ({ name: 'has', args: [arg(key), arg(value)] })),
  ] as IRStep[]);
  if (!read || read.effects?.length || read.framing.kind !== 'elements' || read.framing.elem !== 'edge') return null;
  return make.project({ id: fresh('p'), input: read.rel, channels: [], type: ID_TYPE, exprs: [['id', col(read.rel.id, 'id')]] });
}

/**
 * Each incoming row joined to the edges that satisfy the search — `(ord, id)`, i.e. which row asked
 * and what it found.
 *
 * **WHICH ENDPOINTS NARROW IS A COMPILE-TIME FACT AND IS PASSED IN, never read off `pairs`.** A row may
 * carry a `src` because the CREATE needs one while the MERGE map never mentioned it, and joining on
 * that column would be searching by a constraint the reference does not have. With neither side
 * narrowing, every incoming row is paired with every admitted edge — a CROSS join, which is
 * `searchEdges`' bare `g.E()` arm spelled in the algebra.
 */
function pairedWith(pairs: Rel, criteria: Rel, by: { readonly bySrc: boolean; readonly byTgt: boolean }, fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const admitted = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-query', expr: col(scan.id, 'id'), plan: criteria, negated: false },
  });
  const bySrc = by.bySrc ? eq(col(pairs.id, 'src'), col(admitted.id, 'src')) : undefined;
  const byTgt = by.byTgt ? eq(col(pairs.id, 'tgt'), col(admitted.id, 'tgt')) : undefined;
  // `and` REFUSES a conjunction of nothing, deliberately, so the "narrow by neither" case is spelled
  // here as an absent ON rather than smuggled through it as a `TRUE`.
  const on = bySrc && byTgt ? and(bySrc, byTgt) : bySrc ?? byTgt;
  const joined = make.join({
    id: fresh('j'), left: pairs, right: admitted, ...(on ? { join: 'inner' as const, on } : { join: 'cross' as const }),
    channels: [],
    type: typeOf(...pairs.type.cols,
      ...EDGE_ROW_COLS.map((column) => meta(`e_${column.name}`, column.type, column.nullable))),
  });
  return make.project({
    id: fresh('p'), input: joined, channels: [], type: typeOf(meta(ORD, 'int'), meta('id', 'int')),
    exprs: [[ORD, col(joined.id, ORD)], ['id', col(joined.id, 'e_id')]],
  });
}

/**
 * A merge map's PROPERTY entries as writes — `null` for a map holding a value this route cannot write,
 * and the empty list for no map at all (an absent `option()` arm writes nothing, which is a real state
 * and not a decline).
 *
 * A merge map is not a `PropSpec` list — its values carry their type in a parallel `propTypes` and
 * their cardinality in a parallel `propCardinalities` — so it is reshaped into one and goes through the
 * same `writeOf`. `?? null` on the cardinality preserves "the map declared none", which only the
 * element's own declaration may resolve.
 */
function mergeWrites(
  spec: Pick<MergeSpec, 'props' | 'propTypes' | 'propCardinalities'> | null, elem: Elem, child: ChildSeam,
): readonly PropertyWrite[] | null {
  if (!spec) return [];
  const writes: PropertyWrite[] = [];
  for (const [key, value] of Object.entries(spec.props)) {
    const typeNode = spec.propTypes[key] ?? null;
    const write = writeOf({
      key, keyName: null, value, valueName: null, vtype: gremlinTypeOf(value, typeNode), typeNode, meta: null,
      cardinality: spec.propCardinalities[key] ?? null,
    }, elem, child);
    if (!write) return null;
    writes.push(write);
  }
  return writes;
}

/**
 * THE INCOMING TRAVERSERS CROSSED WITH WHAT A STEP PRODUCED — one traverser per (incoming row, produced
 * element) pair, carrying the incoming aliases and a freshly minted position.
 *
 * This is what a step whose output does NOT correspond row-for-row with its input hands back, and
 * `mergeV` is the first: a creation returns one row per input row (so `addV` JOINS on the position),
 * a merge returns the elements the SEARCH found, which no input row produced. So the correlation is a
 * cross join by construction rather than an equality — the per-traverser loop upstream runs, stated
 * once.
 *
 * The minted order is the incoming position and then the element's id, which is the order the loop
 * would have emitted in: outer iteration first, and within one iteration the search's own rowid order.
 * An input with no position of its own is a one-row seed, where the element order IS the whole order.
 */
function crossed(
  incoming: Rel, produced: Rel, aliases: Channels, ordered: boolean, fresh: Minter, correlate = false,
): Rel {
  const carried = aliases.filter((channel) => channel.role === 'alias');
  const position = incoming.type.cols.some((column) => column.name === ORD) ? `in_${ORD}` : null;
  // CROSS or EQUI, and the choice is whether the produced rows KNOW which incoming row they belong
  // to. `mergeV`'s search is input-independent, so every element pairs with every traverser and the
  // cross IS the per-traverser loop stated once. `mergeE`'s endpoints may be the traverser itself, so
  // its rows carry the `ord` that asked and the join is on it. One function because everything after
  // this line — the alias carry, the bulk re-mint, the re-minted emission order — is identical, and
  // a second copy of that is the dropped-channel defect waiting for a witness.
  const joined = make.join({
    id: fresh('j'), left: produced, right: incoming, channels: [],
    join: correlate && position ? 'inner' : 'cross',
    ...(correlate && position ? { on: eq(col(produced.id, ORD), col(incoming.id, ORD)) } : {}),
    type: typeOf(...produced.type.cols, ...incoming.type.cols.map((column) => meta(`in_${column.name}`, column.type, column.nullable))),
  });
  const channels: Channels = [...carried, ...(ordered ? [BULK_CHANNEL, ENCOUNTER_CHANNEL] : [BULK_CHANNEL])];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  // The pre-mint projection carries the two sort keys as columns and NOT the encounter, which
  // `renumber` is what brings into existence — so its `cols` may name a column its input has not got,
  // and this one must not.
  const payload: readonly ColMeta[] = [meta('id', 'int'), ...carried.map((channel) => meta(channel.col, 'json', true)),
    meta('bulk', 'int'), ...(position ? [meta(ORD, 'int')] : [])];
  const flat = make.project({
    id: fresh('c'), input: joined, channels: ordered ? [] : channels, type: typeOf(...(ordered ? payload : cols)),
    exprs: [
      ['id', col(joined.id, 'id')],
      ...carried.map((channel) => [channel.col, col(joined.id, `in_${channel.col}`)] as const),
      // A merge neither reads nor changes a multiplicity, so the emitted traverser is bulk 1 — the same
      // re-mint `property()` makes, and for the same reason.
      ['bulk', compilerInt(1)],
      ...(ordered && position ? [[ORD, col(joined.id, position)] as const] : []),
    ],
  });
  return ordered
    ? renumber(flat, [
      ...(position ? [{ expr: col(flat.id, ORD), dir: 'asc' } as const] : []),
      { expr: col(flat.id, 'id'), dir: 'asc' },
    ], cols, channels, fresh)
    : flat;
}
