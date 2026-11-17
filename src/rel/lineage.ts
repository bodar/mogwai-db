import { atMostOneRow } from './bounds.ts';
import { columnIsRowKey } from './copies.ts';
import type { Rel } from './rel.ts';
import type { RelId } from './types.ts';
import { freeRelIds, relChildren } from './walk.ts';

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
 * DEFINES it — through filters, sorts, renaming projections and the join side that carries the name — with its
 * name there. It stops at anything else (that relation computes the column), so the last relation is a
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
    case 'filter': case 'sort': return through(definingPath(rel.input, name));
    case 'project': {
      const e = rel.exprs.find(([output]) => output === name)?.[1];
      const hops = e?.kind === 'col' ? spinePath(rel.input, e.rel) : null;
      return e?.kind === 'col' && hops ? through(definingPath(hops.at(-1)!, e.name), ...hops.slice(0, -1)) : here;
    }
    case 'join': {
      const sides = [rel.left, rel.right].filter((child) => child.type.cols.some((c) => c.name === name));
      return sides.length === 1 ? through(definingPath(sides[0]!, name)) : here;
    }
    default: return here;
  }
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
 * (`columnIsRowKey`, down to the scan along `definingPath`). `null` for any other node. ONE predicate, so every
 * question about a whole-relation read under a seed (`leading`'s first-hit read, a per-host bounded-work
 * classification) recognises the same shape.
 */
export interface ReSourceCross {
  readonly seed: Rel;
  readonly side: Rel;
  readonly key: string;
}

export function reSourceCross(r: Rel): ReSourceCross | null {
  if (r.kind !== 'join' || (r.join !== 'cross' && r.join !== 'inner') || r.on || !atMostOneRow(r.left)) return null;
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
