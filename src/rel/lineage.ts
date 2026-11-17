import { atMostOneRow } from './bounds.ts';
import { columnIsRowKey } from './copies.ts';
import type { Rel } from './rel.ts';
import type { RelId } from './types.ts';
import { freeRelIds, joinSide, relChildren } from './walk.ts';

/**
 * COLUMN LINEAGE ALONG A RELATION'S SPINE — where a column a relation exposes comes from, as the relations it is
 * carried through unchanged. The one authority the physical passes ask it of: `semijoin` (which element a
 * property `EXISTS` could drive) and `leading` (which scan a first-row pick's leading key is the rowid of).
 * `copies.ts` asks the neighbouring questions — is a column a KEY (`columnIsRowKey`), a stored value
 * (`columnIsStored`), and what it is SPELLED as over its leaves (`columnLineage`).
 */

/** A column's way down: each relation it is carried through, the column's name at each (`null` where a
 *  projection reads a relation further down its spine directly and the hops between do not name it), and its
 *  name at the last — the relation that DEFINES it. */
export interface ColumnPath {
  readonly rels: readonly Rel[];
  readonly names: readonly (string | null)[];
  readonly name: string;
}

/**
 * Where column `rel.name` comes from, seen from `top`: every relation on the way down to the one that
 * DEFINES it — through filters, sorts, limits, `distinct`s, `materialize`s, renaming projections and the join
 * side that holds the column's POSITION (never a LEFT join's null-padded right side) — with its name there. It stops at anything else (that relation computes the column), so the last relation is a
 * scan only when the column is a stored one. `null` when `rel` is not on `top`'s spine — an OUTER row.
 */
export function columnPath(top: Rel, rel: RelId, name: string): ColumnPath | null {
  const above = spinePath(top, rel);
  if (!above) return null;
  const below = definingPath(above.at(-1)!, name);
  return { rels: [...above.slice(0, -1), ...below.rels], names: [...above.slice(0, -1).map(() => null), ...below.names], name: below.name };
}

/** Column `name` of `rel` down to the relation that defines it (`columnPath` from `rel` itself). */
export function definingPath(rel: Rel, name: string): ColumnPath {
  const here: ColumnPath = { rels: [rel], names: [name], name };
  const through = (rest: ColumnPath, ...hops: readonly Rel[]): ColumnPath =>
    ({ rels: [rel, ...hops, ...rest.rels], names: [name, ...hops.map(() => null), ...rest.names], name: rest.name });
  switch (rel.kind) {
    // Each carries its input's rows (or a subset of them) with the columns unchanged: a `materialize` computes
    // its input once and fences it, a `limit`/`distinct` keeps some of its rows.
    case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize': return through(definingPath(rel.input, name));
    case 'project': {
      const e = rel.exprs.find(([output]) => output === name)?.[1];
      const hops = e?.kind === 'col' ? spinePath(rel.input, e.rel) : null;
      return e?.kind === 'col' && hops ? through(definingPath(hops.at(-1)!, e.name), ...hops.slice(0, -1)) : here;
    }
    case 'join': {
      // POSITIONALLY (`joinSide`): two sides may carry one name. A LEFT join's right side is NULL where the left
      // row is unmatched, so no row below defines it — the join does.
      const from = joinSide(rel, name);
      return from && !from.nullable ? through(definingPath(from.side, from.name)) : here;
    }
    default: return here;
  }
}

/** The SCAN column `rel.name` (seen from `top`) is the stored rowid of — its defining path ends at a scan's `id` —
 *  or `null`: the one "which element row is this" question a seek asks (`semijoin`). */
export function rowidScan(top: Rel, rel: RelId, name: string): Extract<Rel, { readonly kind: 'scan' }> | null {
  const path = columnPath(top, rel, name);
  const leaf = path?.rels.at(-1);
  return path?.name === 'id' && leaf?.kind === 'scan' ? leaf : null;
}

/** Column `name` of `top` as the column of `target` — a relation on its defining path — it carries, or `null`. */
export function columnAt(top: Rel, name: string, target: Rel): string | null {
  const path = definingPath(top, name);
  const at = path.rels.indexOf(target);
  return at < 0 ? null : path.names[at] ?? null;
}

/** The relations from `top` down to the one named `id`, along relational children (not subplans). */
export function spinePath(top: Rel, id: RelId): readonly Rel[] | null {
  const seen = new Set<Rel>();
  const go = (r: Rel): readonly Rel[] | null => {
    if (r.id === id) return [r];
    if (seen.has(r)) return null;
    seen.add(r);
    for (const child of relChildren(r)) {
      const below = go(child);
      if (below) return [r, ...below];
    }
    return null;
  };
  return go(top);
}

/**
 * THE RE-SOURCE CROSS — a WHOLE element relation read with no correlation of its own, crossed with a ONE-ROW
 * seed: the shape `V()`/`E()` mid-traversal lowers to (GraphStep's cross of every traverser with the graph,
 * `movement.ts` `reSource`), and the one place a per-seed read reads the WHOLE graph rather than a seek off
 * the seed. Its parts: the `seed` (the left, at most one row), the element relation (`side`, the right, which
 * reads nothing outside itself), and `key` — a column of the side that is its scanned `nodes`/`edges` rowid
 * (`columnIsRowKey`, down to the scan along `definingPath` — which passes a `materialize`, the read a re-source
 * computes once and fences, `reSourcedBody`). `null` for any other node. ONE
 * predicate, so every question about a whole-relation read under a seed (`leading`'s first-hit read, the per-host
 * work fact `perHostWork`, `src/rel/work.ts`) recognises the same shape.
 *
 * `seed: 'any'` drops the one-row bound on the left: the same whole-relation read crossed with whatever rows a
 * body has reached before it (`out().V()`, GraphStep's cross of EVERY traverser with the graph) — still a whole
 * read per evaluation, which is what a cost question asks; `leading`, which rewrites the read around its ONE seed
 * row, keeps the default.
 */
export interface ReSourceCross {
  readonly seed: Rel;
  readonly side: Rel;
  readonly key: string;
}

export function reSourceCross(r: Rel, seed: 'one-row' | 'any' = 'one-row'): ReSourceCross | null {
  if (r.kind !== 'join' || (r.join !== 'cross' && r.join !== 'inner') || r.on) return null;
  if (seed === 'one-row' && !atMostOneRow(r.left)) return null;
  const side = r.right;
  if (freeRelIds(side).size) return null;
  const key = side.type.cols.find((column) => {
    if (!columnIsRowKey(side, column.name)) return false;
    const path = definingPath(side, column.name);
    const leaf = path.rels.at(-1)!;
    return leaf.kind === 'scan' && path.name === 'id' && (leaf.table === 'nodes' || leaf.table === 'edges');
  })?.name;
  return key ? { seed: r.left, side, key } : null;
}
