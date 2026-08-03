import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Binding } from '../../rel/plan.ts';
import type { Rel, Table } from '../../rel/rel.ts';
import type { Channels } from '../../channels.ts';
import { insert, remove } from '../../rel/stmt-factory.ts';
import type { Stmt } from '../../rel/stmt.ts';
import { EXCLUDED, type ColMeta, type RelId, type RelType } from '../../rel/types.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/strategies.ts';
import { isNested } from '../../gremlin/frontend.ts';
import { gremlinTypeOf, propertyValueBind } from '../../gremlin/types.ts';
import { propertyFtsEntries } from '../../services/fts-index.ts';
import { mergeMaps, parseProperty, type MergeMaps, type MergeSpec, type ParsedProperty, type PropSpec } from '../steps/write/write.ts';
import { validateLabel, validatePropertyKey } from '../steps/write/validate.ts';
import { and, carriedCols, eq, meta, renumber, typeOf, type Minter } from './build.ts';
import { rewriteExpr } from '../../rel/walk.ts';
import { aliasIdAt } from './alias.ts';
import type { AliasMap } from '../steps/context/context.ts';
import { DEFAULT_VERTEX_CARDINALITY, DEFAULT_VERTEX_LABEL, type LabelCardinality, type VertexCardinality } from '../../api.ts';

/**
 * THE WRITE VOCABULARY — an effect is a `Stmt` binding over a read plan, never a row-at-a-time loop.
 *
 * Phase 2 of the RelIR build plan, and the seventh module on `build.ts`. The read modules answer
 * "what relation is this chain", this one answers "what does it CHANGE", and the two meet at one
 * place: a write consumes the relation the read fold already produced, so there is no second prefix
 * builder and nothing opaque handed across a seam.
 *
 * ## THE INPUT IS A RELATION, and the difference is measurable
 *
 * Every write step here takes the INCOMING TRAVERSERS as a relation and makes it an `Insert.source`:
 * one statement writes N rows, so the statement count is a function of the PLAN — 7 store calls for
 * `g.V().hasLabel('person').property(single,'seen',1)` whether the stream holds ten elements or a
 * hundred. The only rows that ever cross into JS are a `snapshot`'s, as ONE JSON value (§10·5).
 *
 * The legacy write path is the contrast and it is what §8 deletes: it reads its target elements into
 * JS and walks them, so its count is a function of the ROW COUNT — 8 store calls per element for the
 * same traversal, 801 over a hundred vertices.
 *
 * ## The pre-mutation snapshot is the whole design
 *
 * A cascade deletes from tables its own target relation READS — `g.V().out().drop()` selects through
 * `edges` and then deletes them. A CTE would be recomputed by each statement, so the vertex delete
 * would run against a graph its own earlier statement had already changed and silently leave
 * vertices standing. Every target here is therefore a `snapshot` binding (`src/rel/plan.ts`): taken
 * ONCE, retained by the executor, and read by every later statement as one JSON bind exploded by
 * `json_each` — which is also §10·5's rule, so a drop of 10,000 vertices is O(1) binds rather than
 * the 100-parameter wall the legacy path needs `RowBatch` to dodge. `checkPlan` proves the discipline
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
  nodes: { table: 'nodes', owner: 'id', cols: [meta('id', 'int')] },
  edges: { table: 'edges', owner: 'id', cols: [meta('id', 'int')] },
} as const satisfies Readonly<Record<string, { readonly table: Table; readonly owner: string; readonly cols: readonly ColMeta[] }>>;

/** `property_fts` is scoped by the OWNER ELEMENT KIND as well as by the owner id — one virtual table
 *  serves both element kinds, which is why the delete carries the extra equality. */
const FTS_COLS: readonly ColMeta[] = [meta('owner_elem', 'text'), meta('owner', 'int')];

const ID_TYPE: RelType = typeOf(meta('id', 'int'));

/** One `id` column and nothing else — a target set is an identity set, and every channel the read
 *  chain carried (bulk, encounter, an alias history) is state a DELETE has no use for. */
const idsOf = (rel: Rel, fresh: Minter): Rel =>
  make.project({ id: fresh('w'), input: rel, channels: [], type: ID_TYPE, exprs: [['id', col(rel.id, 'id')]] });

/** `DELETE FROM <table> WHERE <owner> IN <retained ids>` — the cascade's only statement shape, and
 *  `InQuery` over a `Ref` is what makes the retained rows a RELATION the predicate joins against
 *  rather than a placeholder list sized by the data (§10·5). */
function deleteOwnedBy(spec: keyof typeof OWNED_BY, owners: Rel, fresh: Minter): Stmt {
  const { table, owner, cols } = OWNED_BY[spec];
  const target = make.scan({ id: fresh('t'), table, alias: fresh('wt'), channels: [], type: typeOf(...cols) });
  return remove({
    target, channels: [], type: typeOf(),
    where: { kind: 'in-query', expr: col(target.id, owner), plan: owners, negated: false },
    returning: [],
  });
}

/** The FTS rows owned by a set of elements. Its own function because the owner column is `owner` on
 *  a virtual table with no `id`, and because the element-kind equality rides with it. */
function deleteFts(elem: Elem, owners: Rel, fresh: Minter): Stmt {
  const target = make.scan({ id: fresh('t'), table: 'property_fts', alias: fresh('wt'), channels: [], type: typeOf(...FTS_COLS) });
  return remove({
    target, channels: [], type: typeOf(),
    where: {
      kind: 'binary', op: 'and',
      left: { kind: 'binary', op: '=', left: col(target.id, 'owner_elem'), right: lit(elem === 'edge' ? 'edge' : 'node', 'text') },
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
    statements.push(deleteFts('edge', owners, fresh),
      deleteOwnedBy('edgeProps', owners, fresh),
      deleteOwnedBy('edges', owners, fresh));
  } else {
    const incident = fresh('inc');
    bindings.push({ name: incident, node: incidentEdges(owners, fresh), snapshot: true });
    const edges = make.ref({ id: fresh('r'), name: incident, channels: [], type: ID_TYPE });
    statements.push(
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

// ---------- property() over an element that already exists ----------

/**
 * `property(k, v)` — the MUTATION, as statements over the elements the read prefix selected.
 *
 * It is `drop()`'s twin and it is where the write wedge stops being one shape: a delete needs only
 * the target's identity, while this needs the target's identity AND hands the SAME traversers back,
 * so its result is an element relation the fold keeps folding. That is what makes
 * `g.V(1).property('k','v').values('k')` plan composition rather than legacy's
 * `elementTailContinuation`, and it is the reason `property()` is a step of the ordinary loop.
 *
 * ## What is expressible, and why the rest DECLINES rather than approximating
 *
 * A LITERAL scalar value is: its stored form, its `vtype` and the FTS text it indexes as are all
 * decided at compile time, so the index rows are an `INSERT … SELECT` over the property insert's own
 * `RETURNING` — the walk that produces them is `propertyFtsEntries`, shared with the legacy path
 * because a re-derived index is a SILENT divergence (`fts-index.ts` measured 9,023 rows against
 * 8,936). A COLLECTION value is expressible too and by the same route — it stores as a
 * self-describing typed `{t,v}` tree, so the only difference is that its JSON text crosses as
 * `jsonb(<text>)` and its index walk emits one row per nested leaf, both of which the shared waists
 * already do. A traversal value, a meta-property and a `T` token key each need something the
 * compile-time value does not have, and every one of them is a decline: legacy answers them today, and
 * answering a different question is the failure mode the routing switch cannot absorb.
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
export type PropertyWrite = PropertySet | PropertyRemoval;

export interface PropertySet {
  readonly kind: 'set';
  readonly key: string;
  /** The value as STORAGE holds it, and the canonical Gremlin type beside it. */
  readonly stored: unknown;
  readonly vtype: string | null;
  /** Is `stored` a COLLECTION's JSON text rather than a scalar? It decides one thing — that the value
   *  crosses as `jsonb(?)` rather than a bare bind — and it is carried rather than re-derived from
   *  `vtype` because `propertyValueBind` is the authority on which types are collections and a second
   *  reading of that list is a second chance to disagree with it. */
  readonly collection: boolean;
  /** The META-PROPERTY object as JSON TEXT, or `null` where the step named none. It crosses as
   *  `jsonb(<text>)` for `stored`'s reason and lands in the property row's own `meta` column. */
  readonly meta: string | null;
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
 * §10·5 is unaffected: the blob goes INTO the table, and this statement's `RETURNING` projects ids
 * only, so nothing untransportable is retained.
 */
const storedExpr = (write: PropertySet): Expr =>
  write.collection ? { kind: 'call', fn: 'jsonb', args: [lit(write.stored, 'text')] } : lit(write.stored);

/** The property side-table each element kind writes, as `Scan` must declare it. */
const PROPERTY_TABLE = {
  vertex: { table: 'vertex_properties' as Table, owner: 'node', cols: [meta('id', 'int'), meta('node', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), meta('meta', 'blob', true)] },
  edge: { table: 'edge_properties' as Table, owner: 'edge', cols: [meta('id', 'int'), meta('edge', 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)] },
} as const;

const CARDINALITY_COLS: readonly ColMeta[] = [meta('node', 'int'), meta('key', 'text'), meta('cardinality', 'text')];
const FTS_ROW_COLS: readonly ColMeta[] = [meta('owner_elem', 'text'), meta('pid', 'int'), meta('owner', 'int'), meta('pk', 'text'), meta('kind', 'text'), meta('text', 'text')];

/** `(id, owner)` — what a property write's `RETURNING` hands the FTS insert. */
const WRITTEN_TYPE: RelType = typeOf(meta('id', 'int'), meta('owner', 'int'));

const text = (value: string): Expr => lit(value, 'text');

/** This element's effective cardinality for one key, as an EXPRESSION — the declaration it carries,
 *  or the graph default. A declared cardinality is a compile-time constant instead, because the
 *  statement that declares it runs first. */
function cardinalityOf(owner: Expr, key: string, declared: VertexCardinality | null, fresh: Minter): Expr {
  if (declared) return text(declared);
  const scan = make.scan({ id: fresh('t'), table: 'vertex_property_cardinality', alias: fresh('wt'), channels: [], type: typeOf(...CARDINALITY_COLS) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, 'node'), owner), eq(col(scan.id, 'key'), text(key))),
  });
  const only = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('cardinality', 'text', true)), exprs: [['cardinality', col(matching.id, 'cardinality')]] });
  return { kind: 'call', fn: 'coalesce', args: [{ kind: 'scalar', plan: only }, text(DEFAULT_VERTEX_CARDINALITY)] };
}

/** `INSERT INTO property_fts … SELECT … FROM <the rows just written> CROSS JOIN <the walk's rows>`.
 *
 *  The pid is known only at run time and the (kind, text) pairs only at compile time, so the two
 *  meet as a cross join — one row per written property per index entry. `Values` is exactly the
 *  right node for a compile-time row set, and there is always at least one entry (the value row),
 *  which is what makes it constructible. */
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
      ['owner_elem', text(elem === 'edge' ? 'edge' : 'node')],
      ['pid', col(paired.id, 'id')], ['owner', col(paired.id, 'owner')], ['pk', text(write.key)],
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
      eq(col(target.id, 'owner_elem'), text(elem === 'edge' ? 'edge' : 'node')),
      { kind: 'in-query', expr: col(target.id, 'pid'), plan: rows, negated: false },
    ),
    returning: [],
  });
}

/** The existing property rows for one key over a set of owners, optionally narrowed further (the
 *  single-cardinality guard). Projected to `id`, which is what both the FTS sweep and the row
 *  delete address them by. */
function existingRows(elem: Elem, owners: Rel, key: string, guard: ((owner: Expr) => Expr) | undefined, fresh: Minter): { readonly ids: Rel; readonly pred: (target: Rel) => Expr } {
  const spec = PROPERTY_TABLE[elem === 'edge' ? 'edge' : 'vertex'];
  const clause = (target: Rel): Expr => and(
    and({ kind: 'in-query', expr: col(target.id, spec.owner), plan: owners, negated: false }, eq(col(target.id, 'key'), text(key))),
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
function propertyStatements(elem: Elem, owners: Rel, write: PropertyWrite, bind: Binder, fresh: Minter): void {
  const spec = PROPERTY_TABLE[elem === 'edge' ? 'edge' : 'vertex'];
  // A MEMBERSHIP test is against one column, and the snapshot carries the traverser's channels too —
  // so the identity projection is taken once here rather than at each of the four predicates that
  // want it. (`IN (SELECT id, bulk, encounter …)` is what SQLite refuses, and it refused it.)
  const ids = make.project({ id: fresh('w'), input: owners, channels: [], type: ID_TYPE, exprs: [['id', col(owners.id, 'id')]] });

  // A REMOVAL is the replace half on its own, with no insert after it and no cardinality consulted:
  // the FTS text those rows own, then the rows. It is UNGUARDED — `property(k, null)` removes under
  // every cardinality, which is what makes it a removal rather than a `single` write of nothing.
  if (write.kind === 'remove') {
    const stale = existingRows(elem, ids, write.key, undefined, fresh);
    bind(dropStaleIndex(elem, stale.ids, fresh));
    const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    bind(remove({ target, channels: [], type: typeOf(), where: stale.pred(target), returning: [] }));
    return;
  }

  // A DECLARED cardinality is a schema write, and it must land before anything reads it back.
  if (write.cardinality) {
    const target = make.scan({ id: fresh('t'), table: 'vertex_property_cardinality', alias: fresh('wt'), channels: [], type: typeOf(...CARDINALITY_COLS) });
    const rows = make.project({
      id: fresh('p'), input: owners, channels: [], type: typeOf(...CARDINALITY_COLS),
      exprs: [['node', col(owners.id, 'id')], ['key', text(write.key)], ['cardinality', text(write.cardinality)]],
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
      : (owner: Expr): Expr => eq(cardinalityOf(owner, write.key, null, fresh), text('single'));
    const stale = existingRows(elem, ids, write.key, guard, fresh);
    bind(dropStaleIndex(elem, stale.ids, fresh));
    if (elem !== 'edge') {
      const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
      bind(remove({ target, channels: [], type: typeOf(), where: stale.pred(target), returning: [] }));
    }
  }

  const target = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
  // A `set` write whose value is already present writes nothing. Expressed as a guard on the SOURCE
  // rather than as a branch, because the cardinality is per element: two owners in one stream can
  // take different arms of it.
  const present = (): Expr => {
    const scan = make.scan({ id: fresh('t'), table: spec.table, alias: fresh('wt'), channels: [], type: typeOf(...spec.cols) });
    const matching = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(and(eq(col(scan.id, spec.owner), col(owners.id, 'id')), eq(col(scan.id, 'key'), text(write.key))),
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
      id: fresh('f'), input: owners, channels: owners.channels, type: owners.type,
      pred: { kind: 'binary', op: 'or', left: { kind: 'binary', op: '!=', left: cardinalityOf(col(owners.id, 'id'), write.key, write.cardinality, fresh), right: text('set') }, right: present() },
    })
    : owners;
  const source = make.project({
    id: fresh('p'), input: seed, channels: [],
    type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true),
      ...(write.meta === null ? [] : [meta('meta', 'blob', true)])),
    exprs: [[spec.owner, col(seed.id, 'id')], ['key', text(write.key)], ['value', storedExpr(write)], ['vtype', write.vtype === null ? lit(null, 'text') : text(write.vtype)],
      ...(write.meta === null ? [] : [['meta', { kind: 'call', fn: 'jsonb', args: [lit(write.meta, 'text')] }] as const])],
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
  bind(indexWritten(bind(rowsWritten), elem, write, fresh));
}

/** Push a binding and hand back a `Ref` to it — the one place a name is minted, so a statement can
 *  read the rows of the statement before it without the caller threading names. */
type Binder = (node: Stmt | Rel, snapshot?: boolean, channels?: Channels) => Rel;

/**
 * A run of `property()` steps over the elements a read prefix selected — the effects, plus the SAME
 * elements to keep folding from.
 *
 * The result is the snapshot re-projected as an element relation, which is the whole reason this
 * step needs no continuation machinery: `property()` is element-PRESERVING, so what comes after it
 * is the ordinary element tail over the ids it already holds. Legacy needs
 * `elementTailContinuation` for exactly this and it is the second traversal machine §8 deletes.
 *
 * The snapshot carries the element's CHANNELS as well as its id, so an emission order survives the
 * write — and only the channels JSON can carry losslessly, which is why an alias history (a JSONB
 * blob) DECLINES rather than arriving at the executor as something a `transportable` check would
 * have to refuse at run time.
 */
export function elementProperty(target: Rel, elem: Elem, writes: readonly PropertyWrite[], fresh: Minter): Effects | null {
  // A role this route cannot put through a snapshot is a DECLINE, not a dropped channel: a `sack` or
  // a `path` would come back missing and the next reader of it would answer a different question.
  const carried = writeInputChannels(target);
  if (carried.length !== target.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = inputRows(target, writeInputCols(target), fresh);
  const { bindings, bind } = effectScope(fresh);
  const owners = bind(seeded.result, true, carried);
  for (const write of writes) propertyStatements(elem, owners, write, bind, fresh);
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
    exprs: cols.map((column) => [column.name, column.name === 'bulk' ? lit(1, 'int') : col(owners.id, column.name)] as const),
  });
  // The target's own CTEs first: they are read by the snapshot's step alone, which is the case
  // `checkSnapshots` leaves alone.
  return { bindings: [...seeded.bindings, ...bindings], result };
}

/**
 * A run of `property()` STEPS → what this route can write, or `null` for "legacy owns it".
 *
 * **The parse is legacy's own** (`parseProperty`), which is §10·8's rule applied where it bites
 * hardest: the cardinality position, the `T`-token form, a `__.select(<withSideEffect const>)` key
 * and the per-argument type channel are four things a second parser would have four chances to get
 * differently, and one of them (the sideEffect-constant VALUE) had already drifted between two
 * copies inside legacy before they were merged. What is re-expressed here is the EMISSION, nothing
 * else.
 *
 * What declines, each because the compile-time value does not carry what the answer needs:
 *
 * - a **nested traversal** key or value — its rows are known only at run time, so neither the stored
 *   value nor its index text exists yet.
 * - a **meta-property**, and a **`T` token** key (an id/label write on an existing element, which
 *   legacy refuses with a message it owns).
 * - an **edge** carrying a cardinality or meta at all, which TinkerPop's `Property` has neither of.
 */
export function propertyWrites(steps: readonly IRStep[], elem: Elem, params: Record<string, any>): readonly PropertyWrite[] | null {
  const writes: PropertyWrite[] = [];
  for (const step of steps) {
    if (step.modulators?.length || step.optionArms) return null;
    let parsed: ParsedProperty;
    // `parseProperty` RAISES on a malformed meta pair, and the message is legacy's business — catch
    // and decline so the spine that owns it raises it, exactly as the coercion prefix does.
    try { parsed = parseProperty(step, undefined, params); } catch { return null; }
    if (parsed.kind !== 'prop') return null;
    const write = writeOf(parsed.spec, elem);
    if (!write) return null;
    writes.push(write);
  }
  return writes.length ? writes : null;
}

/**
 * ONE PARSED SPEC → what this route can WRITE, or `null` for a value the compile-time form does not
 * carry the answer for (the list is in `propertyWrites`' own contract above).
 *
 * The spec is legacy's parse whichever host asked (§10·8): `parseProperty` for a `property()` STEP,
 * a merge map's entries for a `mergeV` arm. Putting the EXPRESSIBILITY question in one place is what
 * stops the two hosts admitting different values: a value one host wrote through a scalar bind while
 * the other wrapped it in `jsonb(…)` would be two encodings of one property, and only one of them
 * reads back.
 */
function writeOf(spec: PropSpec, elem: Elem): PropertyWrite | null {
  if (typeof spec.key !== 'string' || isNested(spec.value)) return null;
  // The key waist, shared: an invalid key is an ERROR legacy raises, never a silently skipped write.
  try { validatePropertyKey(spec.key); } catch { return null; }
  // TinkerPop's null-VALUE rule, and the reason the return type is a union: a null value REMOVES every
  // property under the key. `undefined` is a different thing — an absent argument, which this route has
  // nothing to write for — so the test is `=== null` exactly as `isPropertyRemoval` spells it, never a
  // loose `== null` that would silently turn a missing value into a delete.
  //
  // ASKED BEFORE META AND BEFORE THE CARDINALITY, which is `ElementHelper`'s own order: a removal
  // consults neither, so `property(k, null, 'acl', null)` is an ordinary removal and the meta pair is
  // simply not part of the answer. Asking about meta first made that traversal decline for a reason
  // that does not apply to it.
  if (spec.value === null) return { kind: 'remove', key: spec.key };
  if (spec.value === undefined) return null;
  if (elem === 'edge' && (spec.cardinality !== null || spec.meta)) return null;
  // A META-PROPERTY is a JSONB object on the property row, so it is `storedExpr`'s question again with
  // a different column. It is admitted only where the cardinality is DECLARED `single` or `list`, and
  // the excluded case is a real one rather than caution: under `set` — including the UNDECLARED write
  // whose element turns out to be declared `set` — an equal value already present is not re-inserted
  // and its meta is PATCHED instead, which is an UPDATE statement this route does not emit. Admitting
  // it would silently drop the meta on that arm.
  const meta = spec.meta ? JSON.stringify(spec.meta) : null;
  if (meta !== null && spec.cardinality !== 'single' && spec.cardinality !== 'list') return null;
  const { stored, collection } = propertyValueBind(spec.value, spec.vtype, spec.typeNode);
  return {
    kind: 'set', key: spec.key, stored, collection, meta, vtype: spec.vtype, cardinality: spec.cardinality,
    fts: propertyFtsEntries(spec.value, spec.typeNode),
  };
}

// ---------- addV() ----------

const LABELS_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('name', 'text')];
const NODES_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('uid', 'text', true)];
const VERTEX_LABEL_COLS: readonly ColMeta[] = [meta('node', 'int'), meta('label', 'int')];

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
export function addVertex(input: Rel, labels: readonly string[], writes: readonly PropertyWrite[], ordered: boolean, bind: Binder, fresh: Minter): Rel {
  // ZERO labels is a real state and it is the whole reason this takes a LIST: under
  // `LabelCardinality.ZERO_OR_MORE` a bare `addV()` creates a vertex carrying none, and a merge map
  // with no `T.label` does the same. Nothing to intern and nothing to pair, so both statements are
  // absent rather than emitted over an empty `Values` — which is a relation `Values` refuses to
  // express anyway.
  const labelTarget = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  const labelRow = labels.length ? bind(insert({
    target: labelTarget, cols: ['name'],
    source: make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: labels.map((label) => [text(label)]) }),
    channels: [], type: typeOf(meta('id', 'int')),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] },
    returning: [['id', col(labelTarget.id, 'id')]],
  })) : null;

  const nodesTarget = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [], type: typeOf(...NODES_COLS) });
  // ORDERED BY THE INPUT'S OWN POSITION, explicitly. Rowids are assigned in the source's output
  // order, so this is what makes the k-th created id the k-th input row — leaving it to `json_each`'s
  // array order would be the same answer resting on a scan's convention instead of on a clause.
  const inOrder = input.type.cols.some((column) => column.name === ORD)
    // Channel-PRESERVING, so it declares the input's — a `Sort` that named a shorter list is the
    // dropped-channel defect the obligation table exists to catch, and it caught this one.
    ? make.sort({ id: fresh('so'), input, channels: input.channels, type: input.type, terms: [{ expr: col(input.id, ORD), dir: 'asc' }] })
    : input;
  const rowPerInput = make.project({
    id: fresh('p'), input: inOrder, channels: [], type: typeOf(meta('uid', 'text', true)),
    exprs: [['uid', lit(null, 'text')]],
  });
  const created = bind(insert({
    target: nodesTarget, cols: ['uid'], source: rowPerInput, channels: [], type: ID_TYPE,
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

  for (const write of writes) propertyStatements('vertex', created, write, bind, fresh);

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
      ['bulk', lit(1, 'int')],
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
export function effectScope(fresh: Minter): { readonly bindings: Binding[]; readonly bind: Binder } {
  const bindings: Binding[] = [];
  // A `Ref` DECLARES what it carries, like every other relation. Most of them carry nothing — a
  // statement's `RETURNING` is a bare row set — but a snapshot of the input relation still holds that
  // traverser's channels, and a channel a relation does not declare is one no later step can read.
  const bind: Binder = (node, snapshot, channels = []) => {
    const name = `${fresh('pw')}`;
    bindings.push({ name, node, ...(snapshot ? { snapshot: true } : {}) });
    return make.ref({ id: fresh('r'), name, channels, type: node.type });
  };
  return { bindings, bind };
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
 *  the shared waist, and a name it refuses is an ERROR legacy raises, not a write this route may
 *  silently skip. */
export function elementAddV(input: Rel, step: IRStep, propertySteps: readonly IRStep[], ordered: boolean, params: Record<string, any>, cardinality: LabelCardinality, fresh: Minter): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  const labels = creationLabels(step.args ?? [], cardinality);
  if (!labels) return null;
  const writes = propertySteps.length ? propertyWrites(propertySteps, 'vertex', params) : [];
  if (!writes) return null;
  // A MID-CHAIN input is SNAPSHOTTED, and this one is not about a later statement: `INSERT INTO
  // nodes … SELECT … FROM nodes` reads the table it is writing, which SQLite does not promise to
  // evaluate before the first insert. The snapshot makes the source `json_each(?)`, so the question
  // "which traversers were there" is answered once and cannot be changed by the answer.
  // A `Values` source is one literal row and has nothing to snapshot.
  const seeded = input.kind === 'values' ? null : orderedInput(input, fresh);
  const { bindings, bind } = effectScope(fresh);
  const result = addVertex(seeded ? bind(seeded.result, true, writeInputChannels(input)) : input, labels, writes, ordered, bind, fresh);
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
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
 * a message the conformance suite matches on, and that refusal is the reference's own answer, so the
 * spine that owns the message must be the one to raise it (write-path trap 3).
 *
 * Deduped as a SET before counting, exactly as `insertVertex` does — `addV('a','a')` is one label, so
 * it must not fail a `max: 1` graph.
 */
function creationLabels(args: readonly unknown[], cardinality: LabelCardinality): readonly string[] | null {
  const named = args.length === 1 && Array.isArray(args[0]) ? args[0] as unknown[] : args;
  if (named.some((arg) => typeof arg !== 'string')) return null;
  const labels = [...new Set(named as string[])];
  try { for (const label of labels) validateLabel(label); } catch { return null; }
  const resolved = labels.length || cardinality.min === 0 ? labels : [DEFAULT_VERTEX_LABEL];
  if (resolved.length > cardinality.max || resolved.length < cardinality.min) return null;
  return resolved;
}

/** A creation's input rows: the identity plus the emission order, and nothing else — `addV` reads no
 *  other column of what it is inserting from. The ORDER is the one argument worth keeping from the
 *  legacy write path: a write assigns ids as it goes and those ids are OBSERVABLE, so which row it
 *  sees first is part of the answer. */
function orderedInput(input: Rel, fresh: Minter): { readonly bindings: readonly Binding[]; readonly result: Rel } {
  return inputRows(input, writeInputCols(input), fresh);
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
  return [meta('id', 'int'), ...input.channels
    .filter((channel) => channel.role === 'encounter' || channel.role === 'alias')
    .map((channel) => meta(channel.col, channel.role === 'alias' ? 'json' : 'int', channel.role === 'alias'))];
}

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
   *  subquery. Legacy takes its FIRST row, so this takes one row of the same relation. */
  | { readonly kind: 'read'; readonly rel: Rel };

/** The endpoint as an expression over the relation the edge insert selects FROM. */
function endpointExpr(end: Endpoint, over: Rel, aliases: AliasMap, fresh: Minter): Expr | null {
  if (end.kind === 'traverser') return col(over.id, 'id');
  if (end.kind === 'read') {
    const one = make.limit({ id: fresh('li'), input: end.rel, channels: end.rel.channels, type: end.rel.type, count: lit(1, 'int') });
    const only = make.project({ id: fresh('p'), input: one, channels: [], type: ID_TYPE, exprs: [['id', col(one.id, 'id')]] });
    return { kind: 'scalar', plan: only };
  }
  const entry = aliases.get(end.label);
  // An UNBOUND label is a runtime error legacy raises with a message it owns ("unknown as() label"),
  // so it declines here rather than becoming a NULL endpoint — a silently unproductive write.
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
  input: Rel, elem: Elem, step: IRStep, cluster: readonly IRStep[], aliases: AliasMap,
  ordered: boolean, params: Record<string, any>, reads: SubReads, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  const label = (step.args ?? [])[0];
  if (typeof label !== 'string') return null;
  try { validateLabel(label); } catch { return null; }

  let from: Endpoint = { kind: 'traverser' };
  let to: Endpoint = { kind: 'traverser' };
  let sides = 0;
  const propertySteps: IRStep[] = [];
  for (const member of cluster) {
    if (member.name === 'property') { propertySteps.push(member); continue; }
    if (member.modulators?.length || member.optionArms) return null;
    const parsed = endpointOf((member.args ?? [])[0], reads);
    if (!parsed) return null;
    if (member.name === 'from') from = parsed; else to = parsed;
    sides++;
  }
  // BOTH ends implicit is not a traversal the grammar means anything by, and both ends EXPLICIT is
  // fine (the input is then only a multiplier). At the SOURCE there is no incoming traverser at
  // all, so an implicit end has nothing to be: the one-row seed carries no `id`, and asking it for
  // one is a throw rather than a decline unless it is asked here (`rel-sweep` found exactly that on
  // `addE.from`).
  //
  // **The INPUT'S element kind only matters where an end is implicit**, and that is why it is asked
  // here rather than at the top: an implicit end IS the incoming traverser, so an edge stream would be
  // one for neither side. With both ends named the input is a multiplier and its kind is irrelevant —
  // which is exactly the second `addE` of a seeder chain, whose input is the first `addE`'s edge.
  // Refusing on the kind alone declined every one of them.
  const implicit = from.kind === 'traverser' || to.kind === 'traverser';
  if (sides === 0 || (implicit && (elem !== 'vertex' || !input.type.cols.some((column) => column.name === 'id')))) return null;
  const writes = propertySteps.length ? propertyWrites(propertySteps, 'edge', params) : [];
  if (!writes) return null;

  const carried = input.channels.filter((channel) => channel.role === 'alias');
  const seeded = input.kind === 'values' ? null : inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, writeInputChannels(input)) : input;

  const src = endpointExpr(from, incoming, aliases, fresh);
  const tgt = endpointExpr(to, incoming, aliases, fresh);
  if (!src || !tgt) return null;

  const labelTarget = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  const named = make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: [[text(label)]] });
  const labelRow = bind(insert({
    target: labelTarget, cols: ['name'], source: named, channels: [], type: typeOf(meta('id', 'int')),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] },
    returning: [['id', col(labelTarget.id, 'id')]],
  }));

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
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [],
    type: typeOf(meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [['src', reScope(src, incoming.id, paired.id)], ['label', col(paired.id, 'lbl')], ['tgt', reScope(tgt, incoming.id, paired.id)]],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const created = bind(insert({
    target: edgesTarget, cols: ['src', 'label', 'tgt'], source: rows, channels: [], type: ID_TYPE,
    returning: [['id', col(edgesTarget.id, 'id')]],
  }));

  for (const write of writes) propertyStatements('edge', created, write, bind, fresh);

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
      ['bulk', lit(1, 'int')],
      ...(ordered ? [['encounter', col(zipped.id, 'id')] as const] : []),
    ],
  });
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

/** One `from()`/`to()` argument → the endpoint it names, or `null` for a form this route declines
 *  (`__.addV(…)`, which CREATES its endpoint as a side effect of resolving it, and anything whose
 *  nested chain the read fold does not cover). */
function endpointOf(arg: unknown, reads: SubReads): Endpoint | null {
  if (typeof arg === 'string') return { kind: 'alias', label: arg };
  if (!isNested(arg)) return null;
  const inner = reads.body(arg);
  if (!inner?.length) return null;
  // `__.select("a")` IS the bare label, spelled longhand.
  if (inner.length === 1 && inner[0]!.name === 'select' && typeof inner[0]!.args?.[0] === 'string')
    return { kind: 'alias', label: inner[0]!.args[0] as string };
  const read = reads.rooted(inner);
  return read && { kind: 'read', rel: read };
}

/**
 * THE READ FOLD, handed to the write vocabulary as two functions.
 *
 * An endpoint like `to(__.V(2))` is a ROOTED CHAIN LOWERED INSIDE ANOTHER — the sub-read seam — and
 * the fold that does it lives in `lower.ts`, which imports this module. Passing the two entry points
 * in keeps the import graph a DAG (`build ◂ … ◂ write ◂ lower ◂ spine`) and keeps the decline
 * contract intact: an inner chain this route does not cover propagates outward as a decline, one
 * level down, exactly as the set-op operand seam already does.
 */
export interface SubReads {
  /** A nested argument's normalized body, or `null` where normalizing it RAISES. */
  readonly body: (nested: unknown) => readonly IRStep[] | null;
  /** A rooted VERTEX chain as a one-column relation of rowids, or `null` if it is not covered. */
  readonly rooted: (steps: readonly IRStep[]) => Rel | null;
  /**
   * THE VERTICES A MERGE MAP MATCHES — its criteria handed BACK to the read fold as the
   * `V().hasLabel(l)….has(k, v)…` chain they are, rather than re-expressed as a second predicate
   * vocabulary. Every name must be carried (so one `hasLabel` per name, since one step listing them
   * all is ANY-of) and every entry is an ANY-value property match, which is what `has` already means.
   */
  readonly matching: (labels: readonly string[], props: readonly (readonly [string, unknown])[]) => Rel | null;
}

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
  const positioned = make.window({
    id: fresh('wn'), input: ordered, channels: [], type: typeOf(...ordered.type.cols, meta(ORD, 'int')),
    specs: [[ORD, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: encounter && cols.some((column) => column.name === encounter.col) ? [{ expr: col(ordered.id, encounter.col), dir: 'asc' }] : [] } }]],
  });
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
  return make.window({
    id: fresh('wn'), input: created, channels: [], type: typeOf(...created.type.cols, meta(ORD, 'int')),
    specs: [[ORD, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [{ expr: col(created.id, 'id'), dir: 'asc' }] } }]],
  });
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
 * (`SubReads.matching`) instead of by writing a second predicate vocabulary. Legacy's
 * `commonMergeConds` is those same three clauses spelled a second time, and it is the copy this route
 * does not make — every improvement to `has` (the FTS arm, a vtype-aware compare) serves the merge for
 * free, and a divergence between "what mergeV searches for" and "what has() finds" is not expressible.
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
 *   is not handed.
 * - `T.id` — a numeric id is written as the ROWID after asking whether it is still free
 *   (`assertAvailableElementId`), a runtime refusal an `Insert` cannot state. The MATCH half is
 *   perfectly expressible; declining the pair is what stops a create silently colliding.
 * - `option(onMatch, [(T.label): …])` — label MUTATION, whose refusal depends on the graph's `mutable`
 *   flag and whose write is not a property write at all.
 */
export function elementMergeV(
  input: Rel, step: IRStep, options: readonly IRStep[], propertySteps: readonly IRStep[],
  ordered: boolean, params: Record<string, any>, cardinality: LabelCardinality,
  reads: SubReads, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  let maps: MergeMaps;
  // The parse RAISES for every map shape it refuses, and those messages are the legacy spine's to
  // raise — catch and decline, exactly as the `property()` run does.
  try { maps = mergeMaps(step, options, 'mergeV', undefined, params); } catch { return null; }
  const { match, onCreate, onMatch } = maps;
  for (const spec of [match, onCreate, onMatch]) {
    if (!spec) continue;
    if (spec.id != null || isNested(spec.label)) return null;
    if (Object.values(spec.props).some(isNested) || Object.values(spec.propKeys).some(isNested)) return null;
  }
  // A label on the MATCH arm is a search criterion; a label on `onMatch` is a mutation of an element
  // that already exists, which is a different statement and a different refusal.
  if (onMatch?.label) return null;

  const matchWrites = mergeWrites(onMatch, 'vertex');
  // `onCreate` WINS per key, and `validateNoOverrides` has already proved the two cannot contradict —
  // so the spread is a merge of two agreeing maps, not a precedence rule this route invented.
  const createWrites = mergeWrites(onCreate ? {
    ...onCreate,
    props: { ...match.props, ...onCreate.props },
    propTypes: { ...match.propTypes, ...onCreate.propTypes },
    propCardinalities: { ...match.propCardinalities, ...onCreate.propCardinalities },
  } : match, 'vertex');
  const tailWrites = propertySteps.length ? propertyWrites(propertySteps, 'vertex', params) : [];
  if (!matchWrites || !createWrites || !tailWrites) return null;
  const createLabels = creationLabels(((onCreate?.label ?? match.label) as string[] | null) ?? [], cardinality);
  if (!createLabels) return null;

  const searched = reads.matching((match.label as string[] | null) ?? [], Object.entries(match.props));
  if (!searched) return null;

  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = input.kind === 'values' ? null : inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carried) : input;

  // SNAPSHOTTED for two reasons at once, and either alone would be enough: the create is guarded by
  // this relation's emptiness and would otherwise be a predicate over the very table its own statement
  // inserts into (the `addV` trap, one level up); and every `onMatch` statement after the first has
  // already changed a property the search asked about.
  const matched = bind(idsOf(searched, fresh), true);
  for (const write of matchWrites) propertyStatements('vertex', matched, write, bind, fresh);

  // ONE row off the input, because a create happens once however many traversers asked for it. The
  // incoming columns are dropped first: what the creation needs from it is its ROW COUNT, and
  // carrying an alias through `addVertex` as well would correlate the created row back to an incoming row
  // that the join below is about to cross it with anyway.
  // A `Limit` is channel-PRESERVING by contract (§3.5), so it declares the incoming relation's own list and the
  // projection below is where they are dropped — naming a shorter one here is the dropped-channel
  // defect the factory catches, and it caught this.
  const once = make.limit({
    id: fresh('lm'), input: incoming, channels: incoming.channels, type: incoming.type, count: lit(1, 'int'),
  });
  const absent = make.project({
    id: fresh('p'), input: once, channels: [], type: typeOf(meta('n', 'int')),
    exprs: [['n', lit(1, 'int')]],
  });
  const creating = make.filter({
    id: fresh('f'), input: absent, channels: [], type: absent.type,
    pred: { kind: 'exists', plan: matched, negated: true },
  });
  const created = addVertex(creating, createLabels, createWrites, false, bind, fresh);

  // THE MERGED ELEMENT(S) — the pre-write matches, or the one creation. Exactly one side is ever
  // non-empty, so a UNION ALL states "whichever branch happened" without either knowing about the
  // other.
  const merged = make.union({
    id: fresh('u'), inputs: [matched, idsOf(created, fresh)], all: true, channels: [], type: ID_TYPE,
  });
  // The tail `property()` run acts on whatever the merge EMITTED — matched and created alike, which is
  // upstream's own reading of it (an ordinary AddPropertyStep over the merge's output). One statement
  // set over the union, rather than one per branch.
  const emitted = tailWrites.length ? bind(merged, true) : merged;
  for (const write of tailWrites) propertyStatements('vertex', emitted, write, bind, fresh);

  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result: crossed(incoming, emitted, carried, ordered, fresh) };
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
  spec: Pick<MergeSpec, 'props' | 'propTypes' | 'propCardinalities'> | null, elem: Elem,
): readonly PropertyWrite[] | null {
  if (!spec) return [];
  const writes: PropertyWrite[] = [];
  for (const [key, value] of Object.entries(spec.props)) {
    const typeNode = spec.propTypes[key] ?? null;
    const write = writeOf({
      key, value, vtype: gremlinTypeOf(value, typeNode), typeNode, meta: null,
      cardinality: spec.propCardinalities[key] ?? null,
    }, elem);
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
function crossed(incoming: Rel, produced: Rel, aliases: Channels, ordered: boolean, fresh: Minter): Rel {
  const carried = aliases.filter((channel) => channel.role === 'alias');
  const joined = make.join({
    id: fresh('j'), left: produced, right: incoming, join: 'cross', channels: [],
    type: typeOf(...produced.type.cols, ...incoming.type.cols.map((column) => meta(`in_${column.name}`, column.type, column.nullable))),
  });
  const position = incoming.type.cols.some((column) => column.name === ORD) ? `in_${ORD}` : null;
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
      ['bulk', lit(1, 'int')],
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
