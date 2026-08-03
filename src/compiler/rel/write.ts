import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Binding } from '../../rel/plan.ts';
import type { Rel, Table } from '../../rel/rel.ts';
import { remove } from '../../rel/stmt-factory.ts';
import type { Stmt } from '../../rel/stmt.ts';
import type { ColMeta, RelType } from '../../rel/types.ts';
import type { Elem } from '../plan/plan.ts';
import { meta, typeOf, type Minter } from './build.ts';

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
