import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelId, type RelType, type SqlType } from '../../rel/types.ts';

/**
 * THE CONSTRUCTION LEAF every RelIR lowering module sits on — the physical schema as the algebra sees
 * it, plus the four helpers that make a node literal readable.
 *
 * All of it grew privately inside `lower.ts`, which was right while that was the only module building
 * RELATIONS: `predicate.ts` builds only expressions, so it never needed a table name or a minter.
 * `modulator.ts` does — a `by('name')` is a correlated scalar subquery over a property side-table — and
 * exporting these from `lower.ts` would make the import graph a cycle. Extracting them keeps it a DAG:
 * `build ◂ {predicate, modulator} ◂ lower ◂ spine`.
 *
 * What belongs here is what more than one module must AGREE on. What stays in `lower.ts` is what only
 * it has an opinion about — the channel lists a chain threads, the element column sets, the hop table.
 */

export const meta = (colName: string, type: SqlType, nullable = false): ColMeta => ({ name: colName, type, nullable });
export const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });

/** Physical columns of the two element tables, as `Scan` must declare them. `Scan` is the one node
 *  that names the physical schema (§3.3), so this list IS the algebra's view of storage. */
export const NODE_COLS = [meta('id', 'int'), meta('uid', 'text', true)];
export const EDGE_COLS = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** Relation ids, minted PER LOWERING. A module-global counter would make the emitted SQL depend on
 *  how many traversals this process had already compiled — two compiles of one query producing two
 *  different strings, which breaks every snapshot and every cache keyed on the text. */
export type Minter = (hint: string) => RelId;
export const minter = (): Minter => { let n = 0; return (hint) => relId(`${hint}${n++}`); };

/** The two element tables' property side-tables, and the column each keys its owner by. The
 *  asymmetry (`node` vs `edge`) is the physical schema's, so it lives beside the `Scan` tables. */
export const PROPERTIES = {
  vertex: { table: 'vertex_properties', owner: 'node' },
  edge: { table: 'edge_properties', owner: 'edge' },
} as const;

export function and(left: Expr | undefined, right: Expr): Expr;
export function and(left: Expr, right: Expr | undefined): Expr;
export function and(left: Expr | undefined, right: Expr | undefined): Expr {
  if (!left || !right) {
    const only = left ?? right;
    if (!only) throw new Error('RelIR lowering: a conjunction of nothing');
    return only;
  }
  return { kind: 'binary', op: 'and', left, right };
}

export const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });

/** `SELECT id FROM labels WHERE name IN (…)` — the name→id indirection every label-aware step
 *  reaches through, and the reason `labels` is a `Scan` table rather than a string in an emitter. */
export function labelIds(names: readonly string[], fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('lbl'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-list', expr: col(scan.id, 'name'), values: names.map((n) => lit(n, 'text')) },
  });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
}

/** The storage-class recovery every stored value goes through on the way out: a JSON-typed value
 *  comes back as JSON, everything else as itself. Shared by `values()` and every other reader of a
 *  property value. */
export const storedValue = (rel: RelId): Expr => ({
  kind: 'case',
  whens: [[{ kind: 'in-list', expr: col(rel, 'vtype'), values: ['list', 'map', 'set'].map((t) => lit(t, 'text')) },
    { kind: 'call', fn: 'json', args: [col(rel, 'value')] }]],
  else: col(rel, 'value'),
});

/**
 * The FIRST row of a one-column relation, as an expression — SQL's scalar subquery.
 *
 * Every `by()` projection that reads storage is one of these, and the `ORDER BY … LIMIT 1` is not
 * defensive: a vertex-property key may hold several values and insertion order is what names the
 * first, which is the semantics TinkerPop's `PropertyValueStep` has. An edge key is `UNIQUE(edge,
 * key)` so the pick is vacuous there, and it is emitted anyway — a subquery yielding more than one
 * row without saying which it means is SQLite leniency, and leniency is what `src/cf-limits.ts` exists
 * to keep out of the emitted SQL.
 */
export function firstOf(rel: Rel, value: Expr, order: Expr, fresh: Minter): Expr {
  // PROJECT before sorting, and carry the order key as a column: both expressions are written in
  // `rel`'s scope, and after a `Limit` that scope is gone. Two projections rather than one is what
  // keeps every node's expressions readable in the relation they name — the assembler fuses all four
  // back into one `SELECT … ORDER BY … LIMIT 1`, which is §5's division of labour exactly.
  const projected = make.project({
    id: fresh('bv'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('k', 'any', true)),
    exprs: [['v', value], ['k', order]],
  });
  const sorted = make.sort({ id: fresh('so'), input: projected, channels: [], type: projected.type, terms: [{ expr: col(projected.id, 'k'), dir: 'asc' }] });
  const one = make.limit({ id: fresh('li'), input: sorted, channels: [], type: sorted.type, count: lit(1, 'int') });
  const only = make.project({
    id: fresh('p'), input: one, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', col(one.id, 'v')]],
  });
  return { kind: 'scalar', plan: only };
}
