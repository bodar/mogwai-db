import { col, compilerInt, compilerNull, compilerText, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Binding, Guard } from '../../rel/plan.ts';
import type { Rel, Table } from '../../rel/rel.ts';
import type { Channels } from '../../channels.ts';
import { insert, remove } from '../../rel/stmt-factory.ts';
import type { Stmt } from '../../rel/stmt.ts';
import { EXCLUDED, type ColMeta, type RelId, type RelType } from '../../rel/types.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/strategies.ts';
import { arg, isNested, argValues } from '../../gremlin/frontend.ts';
import type { ChildSeam } from './child.ts';
import { gremlinTypeOf, propertyValueBind } from '../../gremlin/types.ts';
import { propertyFtsEntries } from '../../services/fts-index.ts';
import { constFromNested, Deferral, mergeMaps, parseProperty, type MergeMaps, type MergeSpec, type ParsedProperty, type PropSpec } from '../ir/write-args.ts';
import { validateLabel, validatePropertyKey } from '../../gremlin/validate.ts';
import { and, carriedCols, eq, meta, renumber, typeOf, type Minter } from './build.ts';
import { rewriteExpr } from '../../rel/walk.ts';
import { aliasIdAt } from './alias.ts';
import type { AliasMap } from '../plan/alias.ts';
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
    exprs: [[spec.owner, col(seed.id, 'id')], ['key', text(write.key)], ['value', storedExpr(write)], ['vtype', write.vtype === null ? compilerNull('text') : text(write.vtype)],
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
  //
  // A value indexing as NO entries writes no index statement, and that is a real state rather than a
  // guard: `ftsRowsFor` drops empty text, so `property(k, "")` has nothing to index and the `Values`
  // of (kind, text) pairs would be EMPTY — a relation §3.3 records `Values` as refusing to express,
  // i.e. a throw out of a lowering whose contract is `null`. It only became REACHABLE when
  // `property(T.id, …)` let `addV("p").property(T.id,1).property("name","")` route here at all,
  // which is what the CSV round-trip corpus caught.
  const written = bind(rowsWritten);
  if (write.fts.length) bind(indexWritten(written, elem, write, fresh));
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
    exprs: cols.map((column) => [column.name, column.name === 'bulk' ? compilerInt(1) : col(owners.id, column.name)] as const),
  });
  // The target's own CTEs first: they are read by the snapshot's step alone, which is the case
  // `checkSnapshots` leaves alone.
  return { bindings: [...seeded.bindings, ...bindings], result };
}

/**
 * `addLabel(...)` over an EXISTING vertex stream — a sideEffect that ADDS labels idempotently and
 * passes the SAME vertices through. It is `internLabels`' creation pairing applied to rows that
 * already exist rather than freshly-inserted ones, plus `elementProperty`'s snapshot-then-pass-through.
 *
 * The REFUSALS decline here rather than throw, and the two are not the same choice: `lowerToRel` must
 * never throw (the `rel-sweep` decline-contract gate), so a genuine error is legacy's to raise while
 * its route lives — declining hands the traversal to legacy, which throws the message the conformance
 * suite matches (`"Label mutation is not supported"`). Declined:
 *
 * - an EDGE (edge label cardinality is fixed at ONE by spec — `AddLabel.feature` `g_E_addLabelXfriendX`);
 * - an immutable graph (`labelCardinality.mutable === false` — `g_V_addLabelXemployeeX_single_label_graph`);
 * - a collection argument mixed with others (TinkerPop rejects it), or a nested traversal that is not
 *   a compile-time `constant(...)` (a per-row label value legacy resolves at run time).
 *
 * `addLabel` needs no post-mutation count guard: every MUTABLE cardinality has `max = Infinity`, so a
 * label added to a vertex can never overstep it. (`dropLabels`, which can fall BELOW `min`, is the case
 * that would — a guard binding, and not this step.) The `vertex_labels` PRIMARY KEY (node, label) makes
 * a repeated `addLabel(x)` a no-op via `ON CONFLICT DO NOTHING`.
 */
export function elementAddLabel(
  input: Rel, elem: Elem, step: IRStep, cardinality: LabelCardinality,
  sideEffects: Map<string, any> | undefined, params: Record<string, any>, fresh: Minter,
): Effects | null {
  if (elem === 'edge' || !cardinality.mutable) return null;

  // The arguments are label NAMES: a bare string, a compile-time `constant(...)` (a string or a list),
  // or a collection as the SOLE argument. A non-constant nested traversal needs a per-row value and is
  // legacy's for now; a mixed collection is an error legacy raises.
  const args = argValues(step);
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
  if (!names.length) return null;
  try { for (const name of names) validateLabel(name); } catch { return null; }

  // A snapshot of the incoming vertices, exactly as `elementProperty` takes it — a role this route
  // cannot carry through the snapshot is a decline, not a dropped channel.
  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind } = effectScope(fresh);
  const owners = bind(seeded.result, true, carried);

  const labelRow = internLabels(names, bind, fresh)!; // `names` is non-empty, so never the null arm
  const labelTargetRows = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
  // A CROSS JOIN pairs every incoming vertex with every new label — `addVertex`'s pairing, but the left
  // side is EXISTING ids. Both sides project to a single `id` column so the join's positional output is
  // exactly (node, label).
  const ownerIds = make.project({ id: fresh('p'), input: owners, channels: [], type: ID_TYPE, exprs: [['id', col(owners.id, 'id')]] });
  const pairs = make.join({
    id: fresh('j'), left: ownerIds, right: labelRow, join: 'cross', channels: [],
    type: typeOf(meta('node', 'int'), meta('label', 'int')),
  });
  bind(insert({
    target: labelTargetRows, cols: ['node', 'label'], source: pairs, channels: [], type: typeOf(), returning: [],
    onConflict: { target: ['node', 'label'], set: [] },
  }));

  // Back to an ELEMENT relation, element-PRESERVING exactly as `elementProperty` is: the snapshot IS
  // the pass-through, `bulk` re-minted at 1 because the snapshot did not carry it.
  const channels: Channels = [...carried.filter((channel) => channel.role === 'alias'), BULK_CHANNEL,
    ...carried.filter((channel) => channel.role === 'encounter')];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  const result = make.project({
    id: fresh('c'), input: owners, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, column.name === 'bulk' ? compilerInt(1) : col(owners.id, column.name)] as const),
  });
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
export function propertyWrites(steps: readonly IRStep[], elem: Elem, child: ChildSeam): readonly PropertyWrite[] | null {
  const writes: PropertyWrite[] = [];
  for (const step of steps) {
    if (step.modulators?.length || step.optionArms) return null;
    let parsed: ParsedProperty;
    // A `Deferral` is "not learned yet" and DECLINES; anything else has already been raised by the
    // `writeArguments` verify Pass, above the routing switch, so it cannot arrive here (§6·5). The
    // narrowed catch is the point: the blanket one swallowed a text-level ERROR too, and the census
    // then counted a REFUSED traversal as an uncovered gap forever.
    try { parsed = parseProperty(step, child.sideEffects, child.params); }
    catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
    if (parsed.kind !== 'prop') return null;
    const write = writeOf(parsed.spec, elem, child);
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
function writeOf(spec: PropSpec, elem: Elem, child: ChildSeam): PropertyWrite | null {
  if (typeof spec.key !== 'string') return null;
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
  if (folded && !folded.has) return null;
  const value = folded ? folded.value : spec.value;
  const vtype = folded ? folded.vtype : spec.vtype;
  const typeNode = folded ? folded.typeNode : spec.typeNode;
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
  if (value === null) return { kind: 'remove', key: spec.key };
  if (value === undefined) return null;
  if (elem === 'edge' && (spec.cardinality !== null || spec.meta)) return null;
  // A META-PROPERTY is a JSONB object on the property row, so it is `storedExpr`'s question again with
  // a different column. It is admitted only where the cardinality is DECLARED `single` or `list`, and
  // the excluded case is a real one rather than caution: under `set` — including the UNDECLARED write
  // whose element turns out to be declared `set` — an equal value already present is not re-inserted
  // and its meta is PATCHED instead, which is an UPDATE statement this route does not emit. Admitting
  // it would silently drop the meta on that arm.
  const meta = spec.meta ? JSON.stringify(spec.meta) : null;
  if (meta !== null && spec.cardinality !== 'single' && spec.cardinality !== 'list') return null;
  const { stored, collection } = propertyValueBind(value, vtype, typeNode);
  return {
    kind: 'set', key: spec.key, stored, collection, meta, vtype, cardinality: spec.cardinality,
    fts: propertyFtsEntries(value, typeNode),
  };
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
function internLabels(labels: readonly string[], bind: Binder, fresh: Minter): Rel | null {
  if (!labels.length) return null;
  const target = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  return bind(insert({
    target, cols: ['name'],
    source: make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: labels.map((label) => [text(label)]) }),
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
  input: Rel, labels: readonly string[], uid: string | number | null, writes: readonly PropertyWrite[],
  ordered: boolean, bind: Binder, fresh: Minter,
): Rel {
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
 * rowid, a STRING id is the `uid`. The message is legacy's verbatim, because a decline hands the
 * traversal to a spine that raises exactly this — what the guard buys is the string without the
 * decline, and a reworded one would be a different answer to the conformance suite.
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
    guard: { message: `${elem === 'edge' ? 'edge' : 'vertex'} id already exists: ${uid}`, raiseWhen: 'rows' },
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
 *  the shared waist, and a name it refuses is an ERROR legacy raises, not a write this route may
 *  silently skip. */
export function elementAddV(input: Rel, step: IRStep, propertySteps: readonly IRStep[], ordered: boolean, cardinality: LabelCardinality, child: ChildSeam, fresh: Minter): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  const tokens = creationTokens(propertySteps, child);
  if (!tokens) return null;
  // `property(T.label, …)` REPLACES the step's own labels rather than adding to them — `insertVertex`
  // reads the same way, and it is not an addition: `addV('a').property(T.label,'b')` is a vertex
  // labelled `b`. The count rule then applies to whichever list won.
  const labels = creationLabels(tokens.label === null ? argValues(step) : [tokens.label], cardinality, child);
  if (!labels) return null;
  const writes = tokens.rest.length ? propertyWrites(tokens.rest, 'vertex', child) : [];
  if (!writes) return null;
  // ONE ROW ONLY for a supplied id, and the refusal is arithmetic rather than caution: N input rows
  // would insert N vertices carrying the SAME public id, so the second collides on a UNIQUE the guard
  // is not the authority for. Upstream reaches the same place by a different route — it loops, and its
  // second iteration raises `id already exists` — so a decline here and a raise there agree about the
  // traversal being wrong; they disagree only about which spine says so, which the census records.
  if (tokens.id !== null && !(input.kind === 'values' && input.rows.length === 1)) return null;
  // A MID-CHAIN input is SNAPSHOTTED, and this one is not about a later statement: `INSERT INTO
  // nodes … SELECT … FROM nodes` reads the table it is writing, which SQLite does not promise to
  // evaluate before the first insert. The snapshot makes the source `json_each(?)`, so the question
  // "which traversers were there" is answered once and cannot be changed by the answer.
  // A `Values` source is one literal row and has nothing to snapshot.
  const seeded = input.kind === 'values' ? null : orderedInput(input, fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  // BEFORE the creation, because a check after the insert has nothing left to refuse.
  if (tokens.id !== null) { const check = elementIdGuard(tokens.id, 'vertex', fresh); guard(check.node, check.guard); }
  const result = addVertex(seeded ? bind(seeded.result, true, writeInputChannels(input)) : input, labels, tokens.id, writes, ordered, bind, fresh);
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
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
 * A meta run on a token declines: `property(T.id, 1, 'k', 'v')` is meaningless and legacy raises for
 * it, so the spine that owns the message is the one to say so.
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

function creationLabels(args: readonly unknown[], cardinality: LabelCardinality, child: ChildSeam): readonly string[] | null {
  const folded = args.map((arg) => constLabelArg(arg, child));
  if (folded.some((arg) => arg === undefined)) return null;
  const named = folded.length === 1 && Array.isArray(folded[0]) ? folded[0] as unknown[] : folded;
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
  ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  // FOLDED, so `addE(__.constant("knows"))` is the edge label it names — `AddEdgeStep.java:180-181`
  // unwraps a `ConstantTraversal` before anything else looks at it. Legacy THROWS for this shape
  // ("nested-traversal label not supported"), so RelIR is ahead here rather than at parity, which
  // §6·1 makes a first-class state.
  const stepLabel = constLabelArg((step.args ?? [])[0]?.value, child);
  if (typeof stepLabel !== 'string') return null;

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
  const label = tokens.label ?? stepLabel;
  try { validateLabel(label); } catch { return null; }
  const writes = tokens.rest.length ? propertyWrites(tokens.rest, 'edge', child) : [];
  if (!writes) return null;

  const carried = input.channels.filter((channel) => channel.role === 'alias');
  const seeded = input.kind === 'values' ? null : inputRows(input, writeInputCols(input), fresh);
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

  const labelRow = internLabels([label], bind, fresh)!;

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
 * has, the FTS arm §4.7 lifts. `args` is the whole of an `IRStep` these two steps read; the passes have
 * already run on the chain this belongs to, so re-running them over a synthesized fragment would ask a
 * question about a traversal nobody wrote.
 */
function matching(
  labels: readonly string[], props: readonly (readonly [string, unknown])[], child: ChildSeam, fresh: Minter,
): Rel | null {
  return rootedVertices([
    { name: 'V', args: [] },
    ...labels.map((label) => ({ name: 'hasLabel', args: [arg(label)] })),
    ...props.map(([key, value]) => ({ name: 'has', args: [arg(key), arg(value)] })),
  ] as IRStep[], child, fresh);
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
 * (`matching`, over the child seam) instead of by writing a second predicate vocabulary. Legacy's
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
  ordered: boolean, cardinality: LabelCardinality, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  let maps: MergeMaps;
  // `propertyWrites`' rule, one host up: a `Deferral` declines, a text-level ERROR was already
  // raised by the `writeArguments` verify Pass and cannot reach here (§6·5).
  try { maps = mergeMaps(step, options, 'mergeV', child.sideEffects, child.params); }
  catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
  const { match, onCreate, onMatch } = maps;
  for (const spec of [match, onCreate, onMatch]) {
    if (!spec) continue;
    if (spec.id != null || isNested(spec.label)) return null;
    if (Object.values(spec.props).some(isNested) || Object.values(spec.propKeys).some(isNested)) return null;
  }
  // A label on the MATCH arm is a search criterion; a label on `onMatch` is a mutation of an element
  // that already exists, which is a different statement and a different refusal.
  if (onMatch?.label) return null;

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
  const createLabels = creationLabels(((onCreate?.label ?? match.label) as string[] | null) ?? [], cardinality, child);
  if (!createLabels) return null;

  const searched = matching((match.label as string[] | null) ?? [], Object.entries(match.props), child, fresh);
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
  // A merge map's `T.id` still DECLINES above, so the creation supplies none.
  const created = addVertex(creating, createLabels, null, createWrites, false, bind, fresh);

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

// ---------- mergeE() ----------

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
 * - **no label anywhere** and **more than one** — `mergeE cannot create an edge without a label` /
 *   `an edge takes exactly one label` are raised by the spine that owns them.
 * - **`T.id`** — an edge with a supplied public id; the guard mechanism now exists for it, the
 *   `Insert` column plumbing does not.
 * - **an incoming endpoint over a non-VERTEX stream, or at the source** — there is no traverser to
 *   be an endpoint. `MergeEdgeStep` raises `Out Vertex not specified in onCreate`; legacy raises it
 *   too, one step earlier, so declining hands over the message rather than inventing a second.
 * - **a cardinality or meta on an edge property** — TinkerPop's edge `Property` has neither, and
 *   `writeOf` is the one place that says so.
 */
export function elementMergeE(
  input: Rel, elem: Elem, step: IRStep, options: readonly IRStep[], propertySteps: readonly IRStep[],
  aliases: AliasMap, ordered: boolean, child: ChildSeam, fresh: Minter,
): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  let maps: MergeMaps;
  // `elementMergeV`'s rule: a `Deferral` declines, a text-level ERROR was raised by the
  // `writeArguments` verify Pass and cannot reach here (§6·5).
  try { maps = mergeMaps(step, options, 'mergeE', child.sideEffects, child.params); }
  catch (e) { if (!(e instanceof Deferral)) throw e; return null; }
  const { match, onCreate, onMatch } = maps;
  for (const spec of [match, onCreate, onMatch]) {
    if (!spec) continue;
    if (spec.id != null || isNested(spec.label)) return null;
    if (Object.values(spec.props).some(isNested) || Object.values(spec.propKeys).some(isNested)) return null;
  }
  // An edge carries exactly ONE label and it is fixed at creation, so a label on `onMatch` is not a
  // mutation this route may make — it is one the reference refuses outright.
  if (onMatch?.label) return null;

  const out = mergeEndpoint(match.outV, onCreate?.outV, maps.outV, child, fresh);
  const to = mergeEndpoint(match.inV, onCreate?.inV, maps.inV, child, fresh);
  if (!out || !to) return null;
  const labels = ((onCreate?.label ?? match.label) as string[] | null) ?? [];
  if (labels.length !== 1) return null;

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

  // AN INCOMING ENDPOINT NEEDS AN INCOMING VERTEX. At the source the one-row seed carries no `id`,
  // and an edge stream is not a vertex — either way there is nothing to be an endpoint, which is the
  // refusal `MergeEdgeStep` words as "Out Vertex not specified in onCreate".
  if ((out.kind === 'traverser' || to.kind === 'traverser')
    && (elem !== 'vertex' || !input.type.cols.some((column) => column.name === 'id'))) return null;

  const carried = writeInputChannels(input);
  if (carried.length !== input.channels.filter((channel) => channel.role !== 'bulk').length) return null;
  const seeded = input.kind === 'values' ? null : inputRows(input, writeInputCols(input), fresh);
  const { bindings, bind, guard } = effectScope(fresh);
  const incoming = seeded ? bind(seeded.result, true, carried) : input;

  // THE ENDPOINTS FIRST, so a missing vertex refuses before anything is written. The vocabulary is
  // `addE`'s `Endpoint` — an alias, a rooted read, the incoming traverser, a public id — because a
  // merge's endpoints and a creation's ARE the same four things under different spellings.
  const src = endpointExpr(out, incoming, aliases, fresh, guard);
  const tgt = endpointExpr(to, incoming, aliases, fresh, guard);
  if (!src || !tgt) return null;
  // EVERY ROW CARRIES ITS OWN PAIR, whether or not the pair varies — which is what lets the constant
  // and incoming cases be one lowering rather than two. `ord` names the row that asked; a source seed
  // has no position of its own and is one row, so a literal is the honest answer for it.
  const position: Expr = incoming.type.cols.some((column) => column.name === ORD) ? col(incoming.id, ORD) : compilerInt(1);
  const pairs = bind(make.project({
    id: fresh('p'), input: incoming, channels: [],
    type: typeOf(meta(ORD, 'int'), meta('src', 'int'), meta('tgt', 'int')),
    exprs: [[ORD, position], ['src', src], ['tgt', tgt]],
  }), true);

  const criteria = edgeCriteria(labels[0]!, Object.entries(match.props), child, fresh);
  if (!criteria) return null;
  // SNAPSHOTTED for `mergeV`'s two reasons at once: the create is guarded by this relation's
  // emptiness and would otherwise read the very table its own statement inserts into, and an
  // `onMatch` write can change a property the search asked about.
  const matched = bind(pairedWith(pairs, criteria, fresh), true);
  for (const write of matchWrites) propertyStatements('edge', idsOf(matched, fresh), write, bind, fresh);

  // ONE EDGE PER DISTINCT PAIR THAT FOUND NOTHING. `Distinct` is the whole duplicate rule: two
  // traversers naming the same endpoints create one edge between them and both carry it away.
  const unmatched = make.filter({
    id: fresh('f'), input: pairs, channels: [], type: pairs.type,
    pred: { kind: 'exists', negated: true, plan: make.filter({
      id: fresh('f'), input: matched, channels: [], type: matched.type,
      pred: eq(col(matched.id, ORD), col(pairs.id, ORD)),
    }) },
  });
  const wanted = make.distinct({
    id: fresh('d'), channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int')),
    input: make.project({
      id: fresh('p'), input: unmatched, channels: [], type: typeOf(meta('src', 'int'), meta('tgt', 'int')),
      exprs: [['src', col(unmatched.id, 'src')], ['tgt', col(unmatched.id, 'tgt')]],
    }),
  });
  const labelRow = internLabels(labels, bind, fresh)!;
  const paired = make.join({
    id: fresh('j'), left: wanted, right: labelRow, join: 'cross', channels: [],
    type: typeOf(meta('src', 'int'), meta('tgt', 'int'), meta('lbl', 'int')),
  });
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [], type: typeOf(meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [['src', col(paired.id, 'src')], ['label', col(paired.id, 'lbl')], ['tgt', col(paired.id, 'tgt')]],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  // THE `RETURNING` PROJECTS THE ENDPOINTS, and that is what replaces a positional correlation: an
  // edge's `(src, tgt)` IS the key its input rows are found by, so nothing depends on the order the
  // created rows come back in (P5b's hazard does not arise) or on a spare column to carry.
  const created = bind(insert({
    target: edgesTarget, cols: ['src', 'label', 'tgt'], source: rows, channels: [],
    type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('tgt', 'int')),
    returning: [['id', col(edgesTarget.id, 'id')], ['src', col(edgesTarget.id, 'src')], ['tgt', col(edgesTarget.id, 'tgt')]],
  }));
  for (const write of createWrites) propertyStatements('edge', idsOf(created, fresh), write, bind, fresh);

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
  for (const write of tailWrites) propertyStatements('edge', idsOf(emitted, fresh), write, bind, fresh);

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
 *   token simply redirects to it. Reading it as "the current traverser" is what both spines used to
 *   do, and it is a wrong ANSWER wherever the option names a different vertex; `option(outV,
 *   select("x")).option(inV, select("y"))` over two aliased vertices is exactly that traversal.
 *
 * The option's own value goes through `endpointOf`, so an alias, a rooted read and a public id all
 * arrive already spelled the way `endpointExpr` reads them.
 */
function mergeEndpoint(
  fromMatch: unknown, fromCreate: unknown, option: unknown, child: ChildSeam, fresh: Minter,
): Endpoint | null {
  const named = fromMatch === undefined ? fromCreate : fromMatch;
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
  label: string, props: readonly (readonly [string, unknown])[], child: ChildSeam, fresh: Minter,
): Rel | null {
  const read = child.rooted([
    { name: 'E', args: [] },
    { name: 'hasLabel', args: [arg(label)] },
    ...props.map(([key, value]) => ({ name: 'has', args: [arg(key), arg(value)] })),
  ] as IRStep[]);
  if (!read || read.effects?.length || read.framing.kind !== 'elements' || read.framing.elem !== 'edge') return null;
  return make.project({ id: fresh('p'), input: read.rel, channels: [], type: ID_TYPE, exprs: [['id', col(read.rel.id, 'id')]] });
}

/** Each incoming row's endpoint pair joined to the edges that satisfy BOTH halves of the search —
 *  `(ord, id)`, i.e. which row asked and what it found. */
function pairedWith(pairs: Rel, criteria: Rel, fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const admitted = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-query', expr: col(scan.id, 'id'), plan: criteria, negated: false },
  });
  const joined = make.join({
    id: fresh('j'), left: pairs, right: admitted, join: 'inner', channels: [],
    type: typeOf(meta(ORD, 'int'), meta('src', 'int'), meta('tgt', 'int'),
      ...EDGE_ROW_COLS.map((column) => meta(`e_${column.name}`, column.type, column.nullable))),
    on: and(eq(col(pairs.id, 'src'), col(admitted.id, 'src')), eq(col(pairs.id, 'tgt'), col(admitted.id, 'tgt'))),
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
      key, value, vtype: gremlinTypeOf(value, typeNode), typeNode, meta: null,
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
