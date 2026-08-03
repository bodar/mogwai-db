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
import { propertyValueBind } from '../../gremlin/types.ts';
import { propertyFtsEntries } from '../../services/fts-index.ts';
import { parseProperty, type ParsedProperty } from '../steps/write/write.ts';
import { validateLabel, validatePropertyKey } from '../steps/write/validate.ts';
import { and, carriedCols, eq, meta, typeOf, type Minter } from './build.ts';
import { rewriteExpr } from '../../rel/walk.ts';
import { aliasIdAt } from './alias.ts';
import type { AliasMap } from '../steps/context/context.ts';
import { DEFAULT_VERTEX_CARDINALITY, type VertexCardinality } from '../../api.ts';

/**
 * THE WRITE VOCABULARY — an effect is a `Stmt` binding over a read plan, never a driver loop.
 *
 * Phase 2 of the RelIR build plan, and the seventh module on `build.ts`. The read modules answer
 * "what relation is this chain", this one answers "what does it CHANGE", and the two meet at one
 * place: a write consumes the relation the read fold already produced, so there is no second prefix
 * builder and no `renderDriverRows` opaque `{sql, binds}` handed across a seam.
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
 * 8,936). A traversal value, a collection, a meta-property, a `T` token key and the `null` REMOVAL
 * rule each need something the compile-time value does not have, and every one of them is a
 * decline: legacy answers them today, and answering a different question is the failure mode the
 * routing switch cannot absorb.
 *
 * ## The cardinality is a PER-ELEMENT question, and stays one
 *
 * An explicit `property(Cardinality.x, …)` DECLARES, which is an upsert into the declaration table
 * and a compile-time constant thereafter. Absent one the effective cardinality is
 * `COALESCE(<this element's declaration>, <the graph default>)` — different for two elements in the
 * same stream — so it is an EXPRESSION each statement is guarded by, never a branch taken once.
 * Collapsing it to a constant is exactly the bug that made a repeated `property(k, v)` overwrite.
 */
export interface PropertyWrite {
  readonly key: string;
  /** The value as STORAGE holds it, and the canonical Gremlin type beside it. */
  readonly stored: unknown;
  readonly vtype: string | null;
  /** What this value indexes as: (kind, text) pairs from the ONE shared walk. */
  readonly fts: readonly { readonly kind: string; readonly text: string }[];
  /** The DECLARED cardinality, or `null` for "the traversal named none" — a real state, since only
   *  the element's own declaration may resolve it. Always `null` for an edge (single by spec). */
  readonly cardinality: VertexCardinality | null;
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
function indexWritten(written: Rel, elem: Elem, write: PropertyWrite, fresh: Minter): Stmt {
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
        eq(col(scan.id, 'value'), lit(write.stored))),
    });
    return { kind: 'exists', plan: matching, negated: true };
  };
  const skippable = elem !== 'edge' && write.cardinality !== 'single' && write.cardinality !== 'list';
  // The relation the projection reads is the FILTER where there is one — a `Col` names a relation in
  // SCOPE, and scope is a node's direct children, so naming the grandparent here is the mistake the
  // checker catches as "no relation in scope" (it did, on the first run).
  const seed = skippable
    ? make.filter({
      id: fresh('f'), input: owners, channels: [], type: owners.type,
      pred: { kind: 'binary', op: 'or', left: { kind: 'binary', op: '!=', left: cardinalityOf(col(owners.id, 'id'), write.key, write.cardinality, fresh), right: text('set') }, right: present() },
    })
    : owners;
  const source = make.project({
    id: fresh('p'), input: seed, channels: [],
    type: typeOf(meta(spec.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    exprs: [[spec.owner, col(seed.id, 'id')], ['key', text(write.key)], ['value', lit(write.stored)], ['vtype', write.vtype === null ? lit(null, 'text') : text(write.vtype)]],
  });
  const rowsWritten = insert({
    target, cols: [spec.owner, 'key', 'value', 'vtype'], source, channels: [], type: WRITTEN_TYPE,
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
type Binder = (node: Stmt | Rel, snapshot?: boolean) => Rel;

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
  const carried = target.channels;
  if (carried.some((channel) => channel.role !== 'bulk' && channel.role !== 'encounter')) return null;
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(carried)];
  const kept = make.project({
    id: fresh('w'), input: target, channels: carried, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(target.id, column.name)] as const),
  });
  const targetPlan = nameBindings(kept);
  const { bindings, bind } = effectScope(fresh);
  const owners = bind(targetPlan.result, true);
  for (const write of writes) propertyStatements(elem, owners, write, bind, fresh);
  // Back to an ELEMENT relation, re-declaring the channels the snapshot carried through.
  const result = make.project({
    id: fresh('c'), input: owners, channels: carried, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(owners.id, column.name)] as const),
  });
  // The target's own CTEs first: they are read by the snapshot's step alone, which is the case
  // `checkSnapshots` leaves alone.
  return { bindings: [...targetPlan.bindings, ...bindings], result };
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
 * - a **collection** value — it stores as a JSONB tree, which is a different bind shape and a
 *   different index walk; the arm is real, not absent, and it is a further increment.
 * - **`null`** — that is TinkerPop's property REMOVAL rule, a delete wearing a write's spelling.
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
    const spec = parsed.spec;
    if (typeof spec.key !== 'string' || spec.meta || isNested(spec.value) || spec.value == null) return null;
    if (elem === 'edge' && spec.cardinality !== null) return null;
    // The key waist, shared: an invalid key is an ERROR legacy raises, never a silently skipped write.
    try { validatePropertyKey(spec.key); } catch { return null; }
    const { stored, collection } = propertyValueBind(spec.value, spec.vtype, spec.typeNode);
    if (collection) return null;
    writes.push({
      key: spec.key, stored, vtype: spec.vtype, cardinality: spec.cardinality,
      fts: propertyFtsEntries(spec.value, spec.typeNode),
    });
  }
  return writes.length ? writes : null;
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
 *   return no row on the existing case, which is why it is not that.
 * - **The new ids ARE the emission order.** SQLite assigns rowids in the insert's output order, so a
 *   fresh vertex's `encounter` is its own id — exact, free, and not a window over rows whose order
 *   is only conventionally the array's.
 * - **The driver relation decides HOW MANY.** At the source that is one row (`Values`); mid-chain it
 *   is the traverser stream, so `g.V().addV('x')` creates one per vertex, which is the semantics
 *   rather than a special case.
 */
export function addVertex(drivers: Rel, label: string, writes: readonly PropertyWrite[], ordered: boolean, bind: Binder, fresh: Minter): Rel {
  const labelTarget = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  const named = make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: [[text(label)]] });
  const labelRow = bind(insert({
    target: labelTarget, cols: ['name'], source: named, channels: [], type: typeOf(meta('id', 'int')),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] },
    returning: [['id', col(labelTarget.id, 'id')]],
  }));

  const nodesTarget = make.scan({ id: fresh('t'), table: 'nodes', alias: fresh('wt'), channels: [], type: typeOf(...NODES_COLS) });
  const fresh_ = make.project({
    id: fresh('p'), input: drivers, channels: [], type: typeOf(meta('uid', 'text', true)),
    exprs: [['uid', lit(null, 'text')]],
  });
  const created = bind(insert({
    target: nodesTarget, cols: ['uid'], source: fresh_, channels: [], type: ID_TYPE,
    returning: [['id', col(nodesTarget.id, 'id')]],
  }));

  const labelTargetRows = make.scan({ id: fresh('t'), table: 'vertex_labels', alias: fresh('wt'), channels: [], type: typeOf(...VERTEX_LABEL_COLS) });
  const pairs = make.join({
    id: fresh('j'), left: created, right: labelRow, join: 'cross', channels: [],
    type: typeOf(meta('node', 'int'), meta('label', 'int')),
  });
  bind(insert({
    target: labelTargetRows, cols: ['node', 'label'], source: pairs, channels: [], type: typeOf(), returning: [],
  }));

  for (const write of writes) propertyStatements('vertex', created, write, bind, fresh);

  const channels: Channels = ordered ? [{ col: 'bulk', role: 'bulk' }, { col: 'encounter', role: 'encounter' }] : [{ col: 'bulk', role: 'bulk' }];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  return make.project({
    id: fresh('c'), input: created, channels, type: typeOf(...cols),
    exprs: [['id', col(created.id, 'id')], ['bulk', lit(1, 'int')],
      ...(ordered ? [['encounter', col(created.id, 'id')] as const] : [])],
  });
}

/** The bindings a write step accumulates, plus the `Binder` that pushes them — the shape every write
 *  host opens with, so a name is minted in ONE place. */
export function effectScope(fresh: Minter): { readonly bindings: Binding[]; readonly bind: Binder } {
  const bindings: Binding[] = [];
  const bind: Binder = (node, snapshot) => {
    const name = `${fresh('pw')}`;
    bindings.push({ name, node, ...(snapshot ? { snapshot: true } : {}) });
    return make.ref({ id: fresh('r'), name, channels: [], type: node.type });
  };
  return { bindings, bind };
}

/** `addV(<label>)` and its trailing `property()` run → the effects and the new vertices.
 *
 *  `drivers` is what decides HOW MANY, and its two callers are the whole story: a `Values` row at
 *  the source (`g.addV(…)` is one vertex), the traverser relation mid-chain (`g.V().addV(…)` is one
 *  per vertex). A label that is a nested traversal, more than one label, or an invalid one declines —
 *  the label validator is the shared waist, and a name it refuses is an ERROR legacy raises, not a
 *  write this route may silently skip. */
export function elementAddV(drivers: Rel, step: IRStep, propertySteps: readonly IRStep[], ordered: boolean, params: Record<string, any>, fresh: Minter): Effects | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];
  // A BARE `addV()` is not a compile-time question: under `LabelCardinality.ZERO_OR_MORE` it creates a
  // vertex with NO labels and under `ONE` it takes the graph default, and which one the graph declares
  // is a property of the STORE. Declining is the honest answer — writing the default label would be a
  // plausible wrong answer on a multi-label graph, which an L4 pin caught.
  if (args.length !== 1) return null;
  const label = args[0];
  if (typeof label !== 'string') return null;
  try { validateLabel(label); } catch { return null; }
  const writes = propertySteps.length ? propertyWrites(propertySteps, 'vertex', params) : [];
  if (!writes) return null;
  // A MID-CHAIN driver is SNAPSHOTTED, and this one is not about a later statement: `INSERT INTO
  // nodes … SELECT … FROM nodes` reads the table it is writing, which SQLite does not promise to
  // evaluate before the first insert. The snapshot makes the source `json_each(?)`, so the question
  // "which traversers were there" is answered once and cannot be changed by the answer.
  // A `Values` source is one literal row and has nothing to snapshot.
  const seeded = drivers.kind === 'values' ? null : driverOrder(drivers, fresh);
  const { bindings, bind } = effectScope(fresh);
  const result = addVertex(seeded ? bind(seeded.result, true) : drivers, label, writes, ordered, bind, fresh);
  return { bindings: [...(seeded?.bindings ?? []), ...bindings], result };
}

/** A creation's driver rows: the identity plus the emission order, and nothing else — `addV` reads
 *  no other column of its driver. The ORDER is the argument the legacy write path makes about
 *  `renderDriverRows`: a write assigns ids as it goes and those ids are OBSERVABLE, so which row it
 *  sees first is part of the answer. */
function driverOrder(drivers: Rel, fresh: Minter): { readonly bindings: readonly Binding[]; readonly result: Rel } {
  const encounter = drivers.channels.find((channel) => channel.role === 'encounter');
  return driverRows(drivers, encounter ? [meta('id', 'int'), meta(encounter.col, 'int')] : [meta('id', 'int')], fresh);
}

// ---------- addE() ----------

const EDGE_ROW_COLS: readonly ColMeta[] = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** Where an edge endpoint comes from — the three forms `from()`/`to()` take that are decidable
 *  against the DRIVER relation, plus the implicit one. */
type Endpoint =
  /** No `from()`/`to()` on that side: the incoming traverser IS that end, which is what makes
   *  `g.V(1).addE('e').to(x)` an out-edge of the current vertex. */
  | { readonly kind: 'driver' }
  /** An `as()` LABEL, spelled bare (`from("a")`) or as `__.select("a")` — the same thing, and the
   *  label's history holds the element, so the endpoint is its last entry's rowid. */
  | { readonly kind: 'alias'; readonly label: string }
  /** A ROOTED sub-read (`to(__.V(2))`, `from(V().has(…))`) — a relation, read through a scalar
   *  subquery. Legacy takes its FIRST row, so this takes one row of the same relation. */
  | { readonly kind: 'read'; readonly rel: Rel };

/** The endpoint as an expression over the driver relation. */
function endpointExpr(end: Endpoint, driver: Rel, aliases: AliasMap, fresh: Minter): Expr | null {
  if (end.kind === 'driver') return col(driver.id, 'id');
  if (end.kind === 'read') {
    const one = make.limit({ id: fresh('li'), input: end.rel, channels: [], type: end.rel.type, count: lit(1, 'int') });
    const only = make.project({ id: fresh('p'), input: one, channels: [], type: ID_TYPE, exprs: [['id', col(one.id, 'id')]] });
    return { kind: 'scalar', plan: only };
  }
  const entry = aliases.get(end.label);
  // An UNBOUND label is a runtime error legacy raises with a message it owns ("unknown as() label"),
  // so it declines here rather than becoming a NULL endpoint — a silently unproductive write.
  if (!entry) return null;
  return aliasIdAt(col(driver.id, entry.col), 'last');
}

/**
 * `addE(label)` with its `from`/`to`/`property` cluster — ONE edge per incoming traverser.
 *
 * Its shape is `addV`'s and it reuses the same three pieces: the label UPSERT, an `Insert … SELECT …
 * RETURNING` whose SOURCE decides how many, and then `property()`'s statements over the returned
 * ids. What differs is that an edge has ENDPOINTS, and the whole of that difference is two
 * expressions written in the driver's scope — so `from("a")` (an alias column on the driver),
 * `to(__.V(2))` (a scalar subquery) and an omitted side (the driver itself) are one lowering.
 *
 * **No correlation key is needed and that is not luck**: every endpoint form here is decidable
 * against the DRIVER row, so `src` and `tgt` are columns of the insert's own source. The form that
 * would need one — an alias bound to a vertex `addV()` created EARLIER in the same chain — declines,
 * because `addV`'s `RETURNING` carries the target table's columns and not its source's.
 */
export function elementAddE(
  drivers: Rel, elem: Elem, step: IRStep, cluster: readonly IRStep[], aliases: AliasMap,
  ordered: boolean, params: Record<string, any>, reads: SubReads, fresh: Minter,
): Effects | null {
  // An edge's ends are VERTICES; an edge-stream driver would be one for neither end.
  if (elem !== 'vertex' || step.modulators?.length || step.optionArms) return null;
  const label = (step.args ?? [])[0];
  if (typeof label !== 'string') return null;
  try { validateLabel(label); } catch { return null; }

  let from: Endpoint = { kind: 'driver' };
  let to: Endpoint = { kind: 'driver' };
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
  // fine (the driver is then only a multiplier). At the SOURCE there is no incoming traverser at
  // all, so an implicit end has nothing to be: the one-row seed carries no `id`, and asking it for
  // one is a throw rather than a decline unless it is asked here (`rel-sweep` found exactly that on
  // `addE.from`).
  const implicit = from.kind === 'driver' || to.kind === 'driver';
  if (sides === 0 || (implicit && !drivers.type.cols.some((column) => column.name === 'id'))) return null;
  const writes = propertySteps.length ? propertyWrites(propertySteps, 'edge', params) : [];
  if (!writes) return null;

  const carried: readonly ColMeta[] = [meta('id', 'int'),
    ...drivers.channels.filter((channel) => channel.role === 'encounter' || channel.role === 'alias').map((channel) => meta(channel.col, channel.role === 'alias' ? 'json' : 'int', channel.role === 'alias'))];
  const seeded = drivers.kind === 'values' ? null : driverRows(drivers, carried, fresh);
  const { bindings, bind } = effectScope(fresh);
  const driver = seeded ? bind(seeded.result, true) : drivers;

  const src = endpointExpr(from, driver, aliases, fresh);
  const tgt = endpointExpr(to, driver, aliases, fresh);
  if (!src || !tgt) return null;

  const labelTarget = make.scan({ id: fresh('t'), table: 'labels', alias: fresh('wt'), channels: [], type: typeOf(...LABELS_COLS) });
  const named = make.values({ id: fresh('lv'), channels: [], type: typeOf(meta('name', 'text')), rows: [[text(label)]] });
  const labelRow = bind(insert({
    target: labelTarget, cols: ['name'], source: named, channels: [], type: typeOf(meta('id', 'int')),
    onConflict: { target: ['name'], set: [['name', col(EXCLUDED, 'name')]] },
    returning: [['id', col(labelTarget.id, 'id')]],
  }));

  const paired = make.join({
    id: fresh('j'), left: driver, right: labelRow, join: 'cross', channels: [],
    type: typeOf(...driver.type.cols, meta('lbl', 'int')),
  });
  const rows = make.project({
    id: fresh('p'), input: paired, channels: [],
    type: typeOf(meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    exprs: [['src', reScope(src, driver.id, paired.id)], ['label', col(paired.id, 'lbl')], ['tgt', reScope(tgt, driver.id, paired.id)]],
  });
  const edgesTarget = make.scan({ id: fresh('t'), table: 'edges', alias: fresh('wt'), channels: [], type: typeOf(...EDGE_ROW_COLS) });
  const created = bind(insert({
    target: edgesTarget, cols: ['src', 'label', 'tgt'], source: rows, channels: [], type: ID_TYPE,
    returning: [['id', col(edgesTarget.id, 'id')]],
  }));

  for (const write of writes) propertyStatements('edge', created, write, bind, fresh);

  const channels: Channels = ordered ? [{ col: 'bulk', role: 'bulk' }, { col: 'encounter', role: 'encounter' }] : [{ col: 'bulk', role: 'bulk' }];
  const cols: readonly ColMeta[] = [meta('id', 'int'), ...carriedCols(channels)];
  const result = make.project({
    id: fresh('c'), input: created, channels, type: typeOf(...cols),
    exprs: [['id', col(created.id, 'id')], ['bulk', lit(1, 'int')],
      ...(ordered ? [['encounter', col(created.id, 'id')] as const] : [])],
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
}

/** Rewrite a `Col` written against `from` so it names `to` instead — what a CROSS JOIN's projection
 *  needs, because a join's outputs are spelled in ITS scope and not its sides'. */
const reScope = (e: Expr, from: RelId, to: RelId): Expr =>
  rewriteExpr(e, (node) => (node.kind === 'col' && node.rel === from ? { ...node, rel: to } : node));

/** The driver rows a creation walks, projected to the columns it needs and IN EMISSION ORDER.
 *  An ALIAS column crosses as `json(…)` TEXT: the retained-row transport carries what JSON carries
 *  losslessly, and a JSONB blob is not that (`src/program.ts` fails closed on one). `->>`/
 *  `json_extract` read the two identically, so nothing downstream learns which it got. */
function driverRows(drivers: Rel, cols: readonly ColMeta[], fresh: Minter): { readonly bindings: readonly Binding[]; readonly result: Rel } {
  const jsonOf = (column: ColMeta): Expr =>
    column.type === 'json' ? { kind: 'call', fn: 'json', args: [col(drivers.id, column.name)] } : col(drivers.id, column.name);
  const declared = cols.map((column) => (column.type === 'json' ? meta(column.name, 'text', true) : column));
  const kept = make.project({
    id: fresh('w'), input: drivers, channels: [], type: typeOf(...declared),
    exprs: cols.map((column) => [column.name, jsonOf(column)] as const),
  });
  const encounter = drivers.channels.find((channel) => channel.role === 'encounter');
  const ordered = encounter && cols.some((column) => column.name === encounter.col)
    ? make.sort({ id: fresh('so'), input: kept, channels: [], type: kept.type, terms: [{ expr: col(kept.id, encounter.col), dir: 'asc' }] })
    : kept;
  return nameBindings(ordered);
}
